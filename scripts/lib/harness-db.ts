// The memory database edge of scripts/harness.ts `db`. `runDbEdge` cuts a work copy of a data folder at a corpus turn
// (scripts/lib/turn-cut.ts), opens the real memory service writable on this thread with a clock it sets, counter ids,
// no worker and no tick, and then, in time order, writes the journal lines and record appends a `turns` run kept for
// each corpus turn (`<turns run>/lines/<turnId>.jsonl`, waited for while that run writes it) through the journal and
// the record at that turn's start, and replays every stored memory-session run of `session_runs` after the cut
// through `sweep` over its scope at its start.
// A run is answered by the archived memory-session answers that started between it and the next run, read from the
// uncut copy, and a request past them gets `<skip/>`. The graph projection and the stems run to their end after each
// step, as the service's tick runs them while they are due. Every request a run sends is kept as the model client
// got it and written as that run's `requests` record (scripts/lib/harness-record.ts#requestsRecord), so two runs
// that leave equal tables are still compared on what the memory session asked. At the end `tableHashes` hashes every
// table and `graphPhases` runs five graph phases on the same copy. The work copy is removed when it
// returns.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryDb } from '../../src/memory/db/service.ts';
import { sweep } from '../../src/memory/db/session.ts';
import { graphPending, projectRow, rebuildGraph, reproject } from '../../src/memory/db/graph.ts';
import { stemsPending } from '../../src/memory/db/stems.ts';
import { recordLines } from '../../src/memory/db/record-lines.ts';
import { PERSONA_ID } from '../../src/memory/db/ids.ts';
import { placeOrPersona } from '../../src/memory/db/unit-keys.ts';
import { withIface, currentIface } from '../../src/memory/db/current-iface.ts';
import { dbOf } from '../../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../../src/memory/db/types.ts';
import type { KeyRing } from '../../src/keys/ring.ts';
import { createJournal } from '../../src/memory/journal.ts';
import { createRecord } from '../../src/memory/record.ts';
import type { RecordMessageRef } from '../../src/memory/record.ts';
import { cutCopy, turnStartOf } from './turn-cut.ts';
import { counterIds, PAST_ARCHIVE } from './turn-archive.ts';
import { homeIdentity, quietLog } from './turn-wiring.ts';
import { hotOf } from './turn-run.ts';
import { recordingLlm } from './turn-report.ts';
import { requestsRecord } from './harness-record.ts';

type Rec = Record<string, unknown>;

/** The tables the hash leaves out: `leases` measures the run that holds them. */
const SKIPPED_TABLES = new Set(['leases']);

/** The columns the hash leaves out, by table: the times and tokens a request measured. */
const SKIPPED_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  model_requests: new Set(['started_at', 'finished_at', 'usage']),
};

/** The rows the retire phase retires per projected table. */
const RETIRE_ROWS = 40;

/** The tables a written row is projected from. */
const PROJECTED = [
  'interfaces',
  'authorities',
  'people',
  'accounts',
  'participants',
  'places',
  'memberships',
  'sources',
  'claims',
  'descriptions',
  'episodes',
  'diary',
  'publications',
  'media',
  'intentions',
  'work',
  'decisions',
  'semantic_entities',
  'account_person_links',
  'participant_links',
  'source_relations',
  'claim_versions',
  'claim_sources',
  'claim_version_sources',
  'description_versions',
  'episode_sources',
] as const;

/** One table's row count and the first 16 hex digits of the sha256 of its rows. */
export type TableHash = { rows: number; hash: string };

const cell = (value: unknown): unknown =>
  value instanceof Uint8Array
    ? `x:${Buffer.from(value).toString('hex')}`
    : typeof value === 'bigint'
      ? `n:${value}`
      : value;

/** The tables of `db` the hash covers, by name: no virtual table, no FTS shadow table, no `sqlite_` table. */
function tablesOf(db: Db): Array<string> {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !name.startsWith('sqlite_') && !/_(fts|tri)(_|$)/.test(name))
    .sort();
}

function hashOf(db: Db, table: string, skip: ReadonlySet<string>): TableHash {
  const columns = db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => String(row.name))
    .filter((name) => !skip.has(name));
  const list = columns.map((name) => `"${name}"`).join(', ');
  const order = columns.map((_, index) => index + 1).join(', ');
  const hash = createHash('sha256');
  let rows = 0;
  for (const row of db.prepare(`SELECT ${list} FROM "${table}" ORDER BY ${order}`).iterate()) {
    hash.update(`${JSON.stringify(columns.map((name) => cell(row[name])))}\n`);
    rows += 1;
  }
  return { rows, hash: hash.digest('hex').slice(0, 16) };
}

/**
 * Every table of `db` hashed: tables by name, each table's rows ordered by all their
 * columns. With `measured`, `leases` and the measured columns of `model_requests` are left out.
 */
export function tableHashes(db: Db, { measured }: { measured: boolean }): Record<string, TableHash> {
  const out: Record<string, TableHash> = {};
  for (const table of tablesOf(db)) {
    if (measured && SKIPPED_TABLES.has(table)) continue;
    out[table] = hashOf(db, table, measured ? (SKIPPED_COLUMNS[table] ?? new Set()) : new Set());
  }
  return out;
}

const countsOf = (result: unknown): unknown => {
  const given = result as { units?: unknown; edges?: unknown; retired?: unknown } | null;
  return given !== null && typeof given === 'object'
    ? { units: given.units, edges: given.edges, retired: given.retired }
    : result;
};

/**
 * The five graph phases on `handle`, each followed by every table's hash: rebuild, seeded rows of every
 * projected table retired and projected one by one, reproject in slices, reproject again, rebuild again. The times
 * are fixed, so two runs over equal databases record the same.
 */
export function graphPhases(handle: MemoryHandle, seed: string): Record<string, unknown> {
  const db = dbOf(handle);
  const record: Record<string, unknown> = {};
  const phase = (name: string, result: unknown): void => {
    record[name] = { result, tables: tableHashes(db, { measured: false }) };
  };
  phase('1-rebuild', countsOf(rebuildGraph(handle, { at: '2026-01-01T00:00:00.000Z' })));
  const at = '2026-01-02T00:00:00.000Z';
  const retired: Record<string, number> = {};
  let projected = 0;
  for (const table of PROJECTED) {
    const columns = db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => String(row.name));
    if (!columns.includes('retired_at')) continue;
    const picked = db
      .prepare(`SELECT rowid AS r FROM "${table}" WHERE retired_at IS NULL`)
      .all()
      .map((row) => ({
        r: Number(row.r),
        key: createHash('sha1')
          .update(`${seed}:${table}:${String(row.r)}`)
          .digest('hex'),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .slice(0, RETIRE_ROWS);
    retired[table] = 0;
    for (const { r } of picked) {
      try {
        handle.transaction(() => {
          db.prepare(`UPDATE "${table}" SET retired_at = ? WHERE rowid = ?`).run(at, r);
          const row = db.prepare(`SELECT * FROM "${table}" WHERE rowid = ?`).get(r) ?? {};
          projected += Number(projectRow(handle, table, row, { at, log: quietLog })) || 0;
        });
        retired[table] += 1;
      } catch (error) {
        // A table whose rows a trigger keeps immutable is left as it is.
        if ((error as { code?: string }).code !== 'ERR_SQLITE_ERROR') throw error;
      }
    }
  }
  phase('2-retire', { retired, projected });
  phase('3-reproject', countsOf(reproject(handle, { at: '2026-01-03T00:00:00.000Z', sliceUnits: 777 })));
  phase('4-reproject-again', countsOf(reproject(handle, { at: '2026-01-04T00:00:00.000Z' })));
  phase('5-rebuild-again', countsOf(rebuildGraph(handle, { at: '2026-01-05T00:00:00.000Z' })));
  return record;
}

/** A stored memory-session run: its scope and when it started. */
type StoredRun = { scopeKey: string; scopeIface: string | null; at: number };

/** One archived memory-session answer. */
type Answer = { at: number; text: string };

/** The stored session runs that started at or after `from`, and every archived memory-session answer, in order. */
function storedSessions(dataDir: string, from: number): { runs: Array<StoredRun>; answers: Array<Answer> } {
  const db = new DatabaseSync(path.join(dataDir, 'memory.db'), { readOnly: true });
  try {
    const runs = db
      .prepare(
        'SELECT scope_key, scope_iface, started_at FROM session_runs WHERE started_at >= ? ORDER BY started_at, id'
      )
      .all(new Date(from).toISOString())
      .map((row) => ({
        scopeKey: String(row.scope_key),
        scopeIface: typeof row.scope_iface === 'string' ? row.scope_iface : null,
        at: Date.parse(String(row.started_at)),
      }));
    const answers = db
      .prepare(
        `SELECT started_at, response_text FROM model_requests WHERE purpose = 'memory-session' AND status = 'ok'
         ORDER BY started_at, id`
      )
      .all()
      .map((row) => ({
        at: Date.parse(String(row.started_at)),
        text: typeof row.response_text === 'string' ? row.response_text : '',
      }));
    return { runs, answers };
  } finally {
    db.close();
  }
}

/** The turns of the corpus with their start in the uncut copy. */
function turnStarts(dataDir: string, turnIds: ReadonlyArray<string>): Array<{ turnId: string; at: number }> {
  const db = new DatabaseSync(path.join(dataDir, 'memory.db'), { readOnly: true });
  try {
    return turnIds.map((turnId) => ({ turnId, at: turnStartOf(db, turnId) }));
  } finally {
    db.close();
  }
}

/** A line the copy stored after the cut, read back as its record line, with the native reference it was stored under. */
type HeardLine = {
  at: number;
  placeId: string | null;
  iface: string | null;
  line: Rec;
  messages: Array<RecordMessageRef> | null;
};

/**
 * Every line the uncut copy's record holds that was recorded at or after `from`, in every place and the persona's own,
 * read back by the record's own reader (record-lines.ts#recordLines) in time order. A line of a corpus turn is left
 * out, because the turn's kept lines write it again; `skippedOwn` counts them.
 */
function heardLines(dataDir: string, from: number, corpus: ReadonlySet<string>) {
  const db = new DatabaseSync(path.join(dataDir, 'memory.db'), { readOnly: true }) as unknown as Db;
  const fromIso = new Date(from).toISOString();
  const lines: Array<HeardLine> = [];
  let skippedOwn = 0;
  try {
    // A line sits in the unit of its holder (a root, a direct chat or the persona) and of its day, which an edit
    // recorded later keeps; each unit that holds a line recorded at or after the cut is read back whole.
    const units = db
      .prepare(
        `SELECT DISTINCT s.holder_id, s.period, p.iface FROM sources s LEFT JOIN places p ON p.id = s.holder_id
         WHERE s.writer = 'record' AND s.recorded_at >= ? ORDER BY s.holder_id, s.period`
      )
      .all(fromIso);
    for (const unit of units) {
      const holder = String(unit.holder_id);
      const placeId = holder === PERSONA_ID ? null : holder;
      const iface = typeof unit.iface === 'string' ? unit.iface : null;
      for (const text of recordLines(db, placeOrPersona('record', placeId, { partition: String(unit.period) }))) {
        const line = JSON.parse(text) as Rec;
        const stamp = typeof line.recordedAt === 'string' ? line.recordedAt : String(line.occurredAt);
        if (stamp < fromIso) continue;
        if (typeof line.turnId === 'string' && corpus.has(line.turnId)) {
          skippedOwn += 1;
          continue;
        }
        lines.push({ at: Date.parse(stamp), placeId, iface, line, messages: referenceOf(line, iface) });
      }
    }
  } finally {
    (db as unknown as DatabaseSync).close();
  }
  return { lines: lines.sort((a, b) => a.at - b.at), skippedOwn };
}

/** The native reference of a read-back line, as the live path hands it to the record writer; null when it names none. */
function referenceOf(line: Rec, iface: string | null): Array<RecordMessageRef> | null {
  const chatId = (line.scope as { channel?: unknown } | undefined)?.channel;
  if (iface === null || typeof line.id !== 'string' || typeof chatId !== 'string' || typeof line.messageId !== 'string')
    return null;
  return [{ lineId: String(line.id), locator: { iface, chatId, messageId: line.messageId } }];
}

/** A kept line of a `turns` run's `lines` record. */
type KeptLine = { kind: string; placeId: string | null; record: unknown };

/** How often a wait for a `lines` record looks again. */
const LINES_POLL_MS = 200;

/** How many `lines` records the `turns` run has written so far. */
function linesWritten(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length;
  } catch (error) {
    // The turns run has not written its first record yet.
    if ((error as { code?: string }).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * The kept lines of `turnId`, once the `turns` run running beside this one has written its `lines` record
 * (scripts/lib/harness-record.ts#writeTurnRecords renames a whole record into place). The wait fails, naming the
 * turn, when no new `lines` record has appeared for `waitMs`: the turns run that should write it has stopped.
 */
async function keptLines(turnsRun: string, turnId: string, waitMs: number): Promise<Array<KeptLine>> {
  const dir = path.join(turnsRun, 'lines');
  const file = path.join(dir, `${turnId}.jsonl`);
  let written = linesWritten(dir);
  let since = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - since >= waitMs)
      throw new Error(
        `harness db: the lines record of turn ${turnId} did not appear within ${waitMs} ms of the last record in ${dir}`
      );
    await new Promise((resolve) => setTimeout(resolve, LINES_POLL_MS));
    const now = linesWritten(dir);
    if (now > written) {
      written = now;
      since = Date.now();
    }
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as KeptLine);
}

/** What `runDbEdge` did, in counts. */
export type DbEdgeCounts = {
  turns: number;
  lines: number;
  failedLines: number;
  sessions: number;
  requests: number;
  pastArchive: number;
  sessionRows: number;
  heard: number;
  unrebuilt: number;
  inexact: number;
  /** The refused lines by the record writer's code. */
  refusals: Record<string, number>;
  skippedOwn: number;
  tables: number;
};

/** The key ring of a replayed run: the archive answers every request, so its one key has no value. */
const ARCHIVE_RING: KeyRing = {
  route: () => ({ name: 'archive', value: '' }),
  names: () => ['archive'],
  states: () => [],
  bound: () => [],
};

/** The client that answers the requests of one replayed run from `answers`, `<skip/>` past them. */
function runAnswers(answers: ReadonlyArray<Answer>, counts: DbEdgeCounts) {
  let next = 0;
  return {
    complete(): Promise<Rec> {
      counts.requests += 1;
      const found = answers[next];
      next += 1;
      if (found === undefined) counts.pastArchive += 1;
      return Promise.resolve({
        text: found?.text ?? PAST_ARCHIVE,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        source: 'archive',
      });
    },
  };
}

/**
 * The database edge of a data copy (see the head of this file): writes `<out>/db/tables.json`, one
 * `<out>/db/<table>.sha` per table, `<out>/db/graph.json` and one `<out>/db-requests/<nnnnn>.jsonl` per stored
 * session run, numbered from 1 in the order the runs replay, and answers the counts.
 */
export async function runDbEdge(options: {
  root: string;
  dataDir: string;
  fromTurn: string;
  turnIds: ReadonlyArray<string>;
  turnsRun: string;
  out: string;
  seed: string;
  linesWaitMs: number;
}): Promise<DbEdgeCounts> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-harness-db-'));
  const work = path.join(scratch, 'copy');
  try {
    const { at: cutAt } = cutCopy({ from: options.dataDir, into: work, turnId: options.fromTurn });
    return await replayOnCopy({ ...options, work, cutAt });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function replayOnCopy(options: {
  root: string;
  dataDir: string;
  turnIds: ReadonlyArray<string>;
  turnsRun: string;
  out: string;
  seed: string;
  linesWaitMs: number;
  work: string;
  cutAt: number;
}): Promise<DbEdgeCounts> {
  const { work } = options;
  const counts: DbEdgeCounts = {
    turns: 0,
    lines: 0,
    failedLines: 0,
    sessions: 0,
    requests: 0,
    pastArchive: 0,
    sessionRows: 0,
    heard: 0,
    unrebuilt: 0,
    inexact: 0,
    refusals: {},
    skippedOwn: 0,
    tables: 0,
  };
  let clock = options.cutAt;
  const now = (): number => clock;
  const newId = counterIds();
  const deferred: Array<() => unknown> = [];
  const home = (() => {
    const db = new DatabaseSync(path.join(work, 'memory.db'), { readOnly: true });
    try {
      return homeIdentity(db, work).iface;
    } finally {
      db.close();
    }
  })();
  const { hot, close: closeHot } = hotOf(options.root, work, null);
  const service = createMemoryDb({
    hot,
    dataDir: work,
    log: quietLog,
    now,
    worker: false,
    defer: (fn) => deferred.push(fn),
    iface: () => currentIface() ?? home,
    newId,
  });
  const failures = {
    info: () => {},
    warn: () => {
      counts.failedLines += 1;
    },
  };
  const journal = createJournal({ dataDir: work, memoryDb: service, now, uuid: newId, log: failures });
  const record = createRecord({ dataDir: work, log: failures, memoryDb: service, now });
  try {
    await service.open();
    const handle = service.readHandle();
    if (handle === null) throw new Error('harness db: the memory database of the work copy did not open');
    const db = dbOf(handle);
    const settle = async (): Promise<void> => {
      while (deferred.length > 0) await deferred.shift()?.();
      while (graphPending(handle) || stemsPending(db))
        await service.memoryWrite({ kind: 'project', maxSlices: 1, now: clock });
    };
    await settle();
    const requestsDir = path.join(options.out, 'db-requests');
    fs.mkdirSync(requestsDir, { recursive: true, mode: 0o700 });
    const { runs, answers } = storedSessions(options.dataDir, options.cutAt);
    const heard = heardLines(options.dataDir, options.cutAt, new Set(options.turnIds));
    counts.skippedOwn = heard.skippedOwn;
    // At one moment a heard line goes first, then a turn, then a session run, as the live order puts them.
    const steps = [
      ...heard.lines.map((line) => ({ at: line.at, rank: 0, line, turn: null, run: null })),
      ...turnStarts(options.dataDir, options.turnIds).map((turn) => ({
        at: turn.at,
        rank: 1,
        line: null,
        turn,
        run: null,
      })),
      ...runs.map((run, index) => ({ at: run.at, rank: 2, line: null, turn: null, run: { ...run, index } })),
    ].sort((a, b) => a.at - b.at || a.rank - b.rank);
    for (const step of steps) {
      clock = step.at;
      if (step.line !== null) {
        const { placeId, iface, line, messages } = step.line;
        counts.heard += 1;
        // A line the live observation stored reads back with no record envelope (no `v`, no `id`): it is written
        // without its native reference, so its row takes the record writer's identity, not the observation's.
        if (messages === null) counts.inexact += 1;
        try {
          await withIface(iface ?? home, () => record.append(placeId, [line], messages ? { messages } : {}));
        } catch (error) {
          // A stored line the record writer refuses as it was read back: counted by the writer's code, not written.
          const code = (error as { code?: unknown } | null)?.code;
          const key = typeof code === 'string' ? code : 'ERROR';
          counts.unrebuilt += 1;
          counts.refusals[key] = (counts.refusals[key] ?? 0) + 1;
        }
        continue;
      }
      if (step.turn !== null) {
        counts.turns += 1;
        const iface = turnIface(db, step.turn.turnId) ?? home;
        const kept = await keptLines(options.turnsRun, step.turn.turnId, options.linesWaitMs);
        await withIface(iface, async () => {
          for (const line of kept) {
            counts.lines += 1;
            await writeLine(journal, record, line);
          }
          // A journal start writes without a promise to wait on: its write is under way after one turn of the loop.
          await new Promise((resolve) => setImmediate(resolve));
        });
      } else if (step.run !== null) {
        const until = runs[step.run.index + 1]?.at ?? Infinity;
        const own = answers.filter((answer) => answer.at >= step.run.at && answer.at < until);
        counts.sessions += 1;
        // The clock is the request's wall: a kept request measures no time of the machine.
        const kept = recordingLlm(runAnswers(own, counts), { wall: now });
        const result = await sweep(
          {
            db,
            write: (update) => service.memoryWrite(update),
            // The recorder hands back the archive client's answer as it came, typed as unknown.
            llm: kept.llm as Parameters<typeof sweep>[0]['llm'],
            hot,
            env: null,
            ring: ARCHIVE_RING,
            now,
            log: quietLog,
            selfName: '',
            iface: step.run.scopeIface ?? home,
          },
          { scopes: new Set([step.run.scopeKey]) }
        );
        counts.sessionRows += result.runs.filter((run) => run.outcome !== 'quiet' && run.outcome !== 'waiting').length;
        const name = `${String(counts.sessions).padStart(5, '0')}.jsonl`;
        fs.writeFileSync(path.join(requestsDir, name), requestsRecord(kept.requests, []), { mode: 0o600 });
      }
      await settle();
    }
    const tables = tableHashes(db, { measured: true });
    counts.tables = Object.keys(tables).length;
    const dir = path.join(options.out, 'db');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'tables.json'), `${JSON.stringify(tables, null, 1)}\n`, { mode: 0o600 });
    for (const [table, { rows, hash }] of Object.entries(tables))
      fs.writeFileSync(path.join(dir, `${table}.sha`), `${rows} ${hash}\n`, { mode: 0o600 });
    const graph = graphPhases(handle, options.seed);
    fs.writeFileSync(path.join(dir, 'graph.json'), `${JSON.stringify(graph, null, 1)}\n`, { mode: 0o600 });
    return counts;
  } finally {
    await service.close();
    closeHot();
  }
}

/** The interface of the place a stored turn ran in, from its `turn.start` row; null for a turn in no place. */
function turnIface(db: Db, turnId: string): string | null {
  const row = db
    .prepare(
      `SELECT p.iface FROM day d JOIN places p ON p.id = d.place_id
       WHERE d.what = 'turn.start' AND d.turn_id = ? LIMIT 1`
    )
    .get(turnId);
  return typeof row?.iface === 'string' ? row.iface : null;
}

/** One kept line written through the writer the live turn wrote it through. */
async function writeLine(
  journal: ReturnType<typeof createJournal>,
  record: ReturnType<typeof createRecord>,
  line: KeptLine
): Promise<void> {
  const placeId = line.placeId ?? '';
  const given = (line.record ?? {}) as Rec;
  switch (line.kind) {
    case 'turn.start':
      journal.start(placeId, given);
      return;
    case 'record.append': {
      const lines = Array.isArray(given.lines)
        ? given.lines.filter((one: unknown): one is object => typeof one === 'object' && one !== null)
        : [];
      const messages = Array.isArray(given.messages) ? given.messages : undefined;
      await record.append(line.placeId, lines, messages ? { messages } : {});
      return;
    }
    case 'system':
      await journal.system(given);
      return;
    case 'turn':
      await journal.turn(placeId, given);
      return;
    case 'action':
      await journal.action(placeId, given);
      return;
    case 'memory':
      await journal.memory(placeId, given);
      return;
    case 'answer':
      await journal.answer(placeId, given);
      return;
    case 'inner':
      await journal.inner(placeId, given);
      return;
    default:
      throw new Error(`harness db: a kept line of kind "${line.kind}" has no writer here; add it to writeLine`);
  }
}
