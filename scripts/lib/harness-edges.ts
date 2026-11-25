// The edge rows of scripts/harness.ts `edges`: synthetic rows written into a work copy of a data folder before `turns`,
// `db` and `cli` run on it, each one an input the stored corpus never gives, so a later tree that changes how the engine
// treats that input differs from the reference in a record. `applyEdges` picks every target by structure (the corpus
// turns' places and triggers, the stored attitudes, the session's moves after the cut, the reads the archive holds),
// takes every time from the copy's own rows and every id from a counter, and writes the same rows into two identical
// copies. It never reads a line's text and writes only synthetic text. The rows:
//
//   retiredPeople    every person a stored session move after the cut names, retired before the cut, so a replayed
//                    session's attitude move meets a retired person (src/memory/db/session-write.ts, applyAffinity);
//   markupName       the person of the strongest attitude named with markup on every account of theirs, so the
//                    attitudes of a request escape a stored name (src/turn/request/framed.ts);
//   retiredStretches for each place the persona wrote in during the day before a corpus turn, a retired stretch
//                    spanning the turn's day and ending after every stretch of the place, so the day of a request
//                    skips a retired sentence (src/memory/db/stretches.ts);
//   deletedLines     one more deleted line than DELETED_LINES_MAX right before the trigger of the first corpus turn in a
//                    group chat, so its window keeps the newest deletions (src/behavior/deleted-lines.ts);
//   readLines        lines right before a corpus turn in the place its first archived read of the newest lines asks
//                    more of than the place holds, up to exactly the count asked (src/tools/conversation-read.ts).
//
// Rows a writer of the engine owns go through it: the lines through the record (src/memory/record.ts) over the memory
// service of the copy. The rest are plain SQL in one transaction. Rows retired before the cut stay retired in a copy
// cut there (scripts/lib/turn-cut.ts un-retires only what was retired at or after it).

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DELETED_LINES_MAX } from '../../src/behavior/deleted-lines.ts';
import { CHANNEL_HANDLE_PREFIX, HANDLE_DIGITS, handleOf } from '../../src/behavior/handles.ts';
import { linesAroundOf } from '../../src/memory/db/frame-reads.ts';
import { SELF_PERSON } from '../../src/memory/db/ids.ts';
import { internalContext } from '../../src/memory/db/scope.ts';
import { createMemoryDb } from '../../src/memory/db/service.ts';
import { currentIface, withIface } from '../../src/memory/db/current-iface.ts';
import type { Db } from '../../src/memory/db/types.ts';
import { createRecord, toRecordLine } from '../../src/memory/record.ts';
import type { RecordMessageRef } from '../../src/memory/record.ts';
import { READ_LADDER_DAYS, readSelection } from '../../src/tools/conversation-read.ts';
import { skillNameOfApi } from '../../src/tools/definitions.ts';
import type { CorpusTurn } from './harness-corpus.ts';
import { storedTurn } from './turn-stage.ts';
import type { StoredTurn } from './turn-stage.ts';
import { quietLog } from './turn-wiring.ts';
import { hotOf } from './turn-run.ts';

type Row = Record<string, unknown>;

/** How many rows each edge wrote. */
export type EdgeCounts = {
  retiredPeople: number;
  markupName: number;
  retiredStretches: number;
  deletedLines: number;
  readLines: number;
};

/** The synthetic name of the markup edge: a tag a stored name must not carry into a request unescaped. */
const MARKUP_NAME = 'Edge <i>name</i>';
/** The synthetic text of every edge line and sentence. */
const EDGE_TEXT = 'edge line';
/** The lines a read of a place takes around the turn's moment, as src/turn/in-turn-tools.ts reads them. */
const PLACE_READ_LINES = 60;
const DAY_MS = 86_400_000;
/** The spacing of the lines one edge writes before a moment: one second, inside any chat window. */
const STEP_MS = 1000;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const iso = (ms: number): string => new Date(ms).toISOString();

/** Ids of the rows the edges write: a prefix of their own, so no counter of a later run meets them. */
function edgeIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `edge-${count}`;
  };
}

/** The corpus turns as their `turn.start` rows name them, oldest first, and the cut: the start of the oldest. */
function corpusTurns(db: Db, corpus: ReadonlyArray<CorpusTurn>): { turns: Array<StoredTurn>; cut: number } {
  const turns = corpus.map(({ turnId }) => storedTurn(db, turnId));
  if (turns.length === 0) throw new Error('harness edges: the corpus holds no turn');
  return { turns, cut: Math.min(...turns.map((turn) => turn.at)) };
}

/** Every person a session move recorded at or after the cut names, retired just before the cut. */
function retirePeople(db: Db, cut: number): number {
  const people = db
    .prepare(
      `SELECT DISTINCT person_id FROM affinity_events
       WHERE writer = 'session' AND retired_at IS NULL AND person_id IS NOT NULL AND at >= ? ORDER BY person_id`
    )
    .all(iso(cut))
    .map((row) => String(row.person_id));
  const retire = db.prepare('UPDATE people SET retired_at = ? WHERE id = ? AND retired_at IS NULL');
  return people.reduce((count, person) => count + Number(retire.run(iso(cut - 1), person).changes), 0);
}

/**
 * The person whose newest live attitude change is the furthest from zero (ties by id), among those with an account of
 * theirs: every such account named with markup. 0 when no attitude names a person with an account.
 */
function markupName(db: Db): number {
  const row = db
    .prepare(
      `WITH newest AS (
         SELECT person_id, score, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY at DESC, id DESC) AS n
         FROM affinity_events WHERE person_id IS NOT NULL AND retired_at IS NULL AND score IS NOT NULL)
       SELECT person_id FROM newest
       WHERE n = 1 AND EXISTS (SELECT 1 FROM person_accounts m WHERE m.person_id = newest.person_id)
       ORDER BY abs(score) DESC, person_id LIMIT 1`
    )
    .get();
  if (row === undefined) return 0;
  return Number(
    db.prepare('UPDATE person_accounts SET display_name = ? WHERE person_id = ?').run(MARKUP_NAME, row.person_id)
      .changes
  );
}

/**
 * For each place where the persona wrote in the day before a corpus turn and that holds a stretch: a retired stretch of
 * the place from a day before the earliest such turn, or its first stretch's start when earlier, to past the end of its
 * last stretch and of the latest such turn, under the audience of its newest stretch, retired before the cut. The day
 * of a turn names the persona's conversations by these places.
 */
function retiredStretches(db: Db, turns: ReadonlyArray<StoredTurn>, cut: number, newId: () => string): number {
  const spans = new Map<string, { from: number; to: number }>();
  const spoken = db.prepare(
    "SELECT DISTINCT place_id FROM sources WHERE kind = 'said' AND place_id IS NOT NULL AND occurred_at >= ? AND occurred_at <= ?"
  );
  for (const turn of turns)
    for (const row of spoken.all(iso(turn.at - DAY_MS), iso(turn.at))) {
      const held = spans.get(String(row.place_id));
      spans.set(String(row.place_id), {
        from: Math.min(held?.from ?? Infinity, turn.at - DAY_MS),
        to: Math.max(held?.to ?? -Infinity, turn.at),
      });
    }
  const newest = db.prepare(
    `SELECT scope_kind, scope_iface, scope_dm, audience_id,
       (SELECT MIN(start_ms) FROM episodes f WHERE f.writer = 'stretch' AND f.holder_id = e.holder_id) AS first_ms,
       (SELECT MAX(last_ms) FROM episodes f WHERE f.writer = 'stretch' AND f.holder_id = e.holder_id) AS end_ms
     FROM episodes e WHERE e.writer = 'stretch' AND e.holder_id = ? AND e.retired_at IS NULL
     ORDER BY e.last_ms DESC, e.id LIMIT 1`
  );
  const insert = db.prepare(
    `INSERT INTO episodes (id, kind, subject_id, place_id, date, what, start_ms, last_ms, scope_kind, scope_iface,
       scope_dm, created_at, retired_at, audience_id, writer, holder_id)
     VALUES (?, 'stretch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stretch', ?)`
  );
  let count = 0;
  for (const [placeId, span] of [...spans].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const row = newest.get(placeId);
    if (row === undefined) continue;
    const start = Math.min(Number(row.first_ms), span.from);
    insert.run(
      newId(),
      SELF_PERSON,
      placeId,
      iso(start).slice(0, 10),
      EDGE_TEXT,
      start,
      Math.max(Number(row.end_ms), span.to) + 1,
      row.scope_kind,
      row.scope_iface,
      row.scope_dm,
      iso(cut - 1),
      iso(cut - 1),
      row.audience_id,
      placeId
    );
    count += 1;
  }
  return count;
}

/** One line to write through the record: its holder, its place's address, its author, kind and moment. */
type EdgeLine = {
  holder: string;
  iface: string;
  chatId: string;
  author: string;
  kind: 'seen' | 'deleted';
  messageId: string;
  at: number;
};

/** The holder, address and author of the stored line of `placeId` the native message `messageId` names, or null. */
function lineSeat(
  db: Db,
  placeId: string,
  where: string,
  params: Array<string | number>
): Omit<EdgeLine, 'kind' | 'messageId' | 'at'> | null {
  const row = db
    .prepare(
      `SELECT s.holder_id, p.iface, p.native_id AS chat, a.native_id AS author FROM sources s
       JOIN places p ON p.id = s.place_id JOIN accounts a ON a.id = s.author_account
       WHERE s.place_id = ? AND s.holder_id IS NOT NULL AND p.native_id IS NOT NULL AND a.native_id IS NOT NULL
         AND s.kind = 'seen' AND ${where}
       ORDER BY s.occurred_at DESC, s.rowid DESC LIMIT 1`
    )
    .get(placeId, ...params);
  if (row === undefined) return null;
  return {
    holder: String(row.holder_id),
    iface: String(row.iface),
    chatId: String(row.chat),
    author: String(row.author),
  };
}

/** The moment of the trigger line of `turn`, from the stored line its message id names; null when none is stored. */
function triggerAt(db: Db, turn: StoredTurn): number | null {
  if (turn.placeId === null || turn.triggerId === null) return null;
  const row = db
    .prepare(
      `SELECT MIN(occurred_at) AS at FROM sources WHERE place_id = ?
       AND (native_id = ? OR json_extract(extra, '$.$messageLocator.messageId') = ?)`
    )
    .get(turn.placeId, turn.triggerId, turn.triggerId);
  return text(row?.at) === null ? null : Date.parse(String(row?.at));
}

/**
 * The first corpus turn in a group chat with a stored trigger: DELETED_LINES_MAX + 1 lines of its trigger's author,
 * each seen and deleted, one second apart and ending one second before the trigger.
 */
function deletedLines(db: Db, turns: ReadonlyArray<StoredTurn>, newId: () => string): Array<EdgeLine> {
  for (const turn of turns) {
    if (turn.placeId === null || turn.triggerId === null) continue;
    const place = db.prepare('SELECT chat FROM places WHERE id = ?').get(turn.placeId);
    const at = triggerAt(db, turn);
    if (place?.chat !== 'group' || at === null) continue;
    const seat = lineSeat(db, turn.placeId, `s.occurred_at = ?`, [iso(at)]);
    if (seat === null) continue;
    const count = DELETED_LINES_MAX + 1;
    return Array.from({ length: count }, (_, index) => ({
      messageId: newId(),
      at: at - (count - index) * STEP_MS,
    })).flatMap(({ messageId, at: moment }) => [
      { ...seat, kind: 'seen' as const, messageId, at: moment },
      { ...seat, kind: 'deleted' as const, messageId, at: moment },
    ]);
  }
  return [];
}

/** The place whose channel handle is `handle`, at any length the handles of a request take; null for none or several. */
function placeOfHandle(db: Db, handle: string): string | null {
  const digits = handle.length - 2;
  if (!handle.startsWith(`#${CHANNEL_HANDLE_PREFIX}`) || digits < HANDLE_DIGITS) return null;
  const found = db
    .prepare('SELECT id, native_id FROM places WHERE native_id IS NOT NULL ORDER BY id')
    .all()
    .filter((row) => `#${handleOf(String(row.native_id), digits, CHANNEL_HANDLE_PREFIX)}` === handle);
  return found.length === 1 ? String(found[0]?.id) : null;
}

/** The archived reads of the newest lines of a named place that a corpus turn made, in the order it made them. */
function archivedReads(db: Db, turn: StoredTurn): Array<{ placeId: string; n: number }> {
  const reads: Array<{ placeId: string; n: number }> = [];
  const rows = db
    .prepare('SELECT tool_calls FROM model_requests WHERE turn_id = ? AND tool_calls IS NOT NULL ORDER BY step, id')
    .all(turn.turnId);
  for (const row of rows) {
    const calls: unknown = JSON.parse(String(row.tool_calls));
    for (const call of Array.isArray(calls) ? (calls as Array<Row>) : []) {
      if (skillNameOfApi(call.name) !== 'conversation.read') continue;
      const args = (call.parsed ?? {}) as Row;
      const selection = readSelection(args, { now: turn.at });
      const handle = text(args.place);
      const placeId = handle === null ? null : placeOfHandle(db, handle);
      // A read of the newest lines always carries its count (readSelection).
      if ('error' in selection || selection.mode !== 'last' || selection.n === undefined || placeId === null) continue;
      reads.push({ placeId, n: selection.n });
    }
  }
  return reads;
}

/**
 * The first archived read of the newest lines, in corpus order, whose place shows fewer lines than it asks over the
 * widest span a read reaches back, and at least one: lines of the author of its newest line, one second apart and
 * ending one second before the turn, until the place shows exactly the count asked.
 */
function readLines(db: Db, turns: ReadonlyArray<StoredTurn>, newId: () => string): Array<EdgeLine> {
  const widest = Math.max(...READ_LADDER_DAYS) * DAY_MS;
  for (const turn of turns)
    for (const { placeId, n } of archivedReads(db, turn)) {
      const shown = linesAroundOf(db, internalContext(), placeId, turn.at, PLACE_READ_LINES).filter(
        (line) => line.at >= turn.at - widest
      ).length;
      const seat = lineSeat(db, placeId, 's.occurred_at <= ?', [iso(turn.at)]);
      if (shown === 0 || shown >= n || seat === null) continue;
      return Array.from({ length: n - shown }, (_, index) => ({
        ...seat,
        kind: 'seen' as const,
        messageId: newId(),
        at: turn.at - (n - shown - index) * STEP_MS,
      }));
    }
  return [];
}

/** Writes `lines` through the record of the copy's memory service, each at its own moment. */
async function writeLines(
  root: string,
  dataDir: string,
  lines: ReadonlyArray<EdgeLine>,
  newId: () => string
): Promise<void> {
  if (lines.length === 0) return;
  let clock = lines[0]?.at ?? 0;
  const now = (): number => clock;
  const deferred: Array<() => unknown> = [];
  const { hot, close: closeHot } = hotOf(root, dataDir, null);
  const service = createMemoryDb({
    hot,
    dataDir,
    log: quietLog,
    now,
    worker: false,
    defer: (fn) => deferred.push(fn),
    // A write outside a line's own interface is the first line's.
    iface: () => currentIface() ?? lines[0]?.iface ?? null,
    newId,
  });
  const record = createRecord({ dataDir, log: quietLog, memoryDb: service, now });
  try {
    await service.open();
    for (const line of lines) {
      clock = line.at;
      const slim = { id: line.messageId, placeId: line.chatId, authorId: line.author, content: EDGE_TEXT, ts: line.at };
      const written = toRecordLine(slim, { kind: line.kind, now, uuid: newId }) as Row;
      const messages: Array<RecordMessageRef> = [
        { lineId: String(written.id), locator: { iface: line.iface, chatId: line.chatId, messageId: line.messageId } },
      ];
      await withIface(line.iface, () => record.append(line.holder, [written], { messages }));
    }
    while (deferred.length > 0) await deferred.shift()?.();
  } finally {
    await service.close();
    closeHot();
  }
}

/** Writes every edge row into the work copy `dataDir` for the turns of `corpus`, and answers how many each wrote. */
export async function applyEdges(options: {
  root: string;
  dataDir: string;
  corpus: ReadonlyArray<CorpusTurn>;
}): Promise<EdgeCounts> {
  const newId = edgeIds();
  const db = new DatabaseSync(path.join(options.dataDir, 'memory.db')) as unknown as Db;
  let counts: Omit<EdgeCounts, 'deletedLines' | 'readLines'>;
  let lines: { deleted: Array<EdgeLine>; read: Array<EdgeLine> };
  try {
    const { turns, cut } = corpusTurns(db, options.corpus);
    db.exec('BEGIN');
    counts = {
      retiredPeople: retirePeople(db, cut),
      markupName: markupName(db),
      retiredStretches: retiredStretches(db, turns, cut, newId),
    };
    db.exec('COMMIT');
    lines = { deleted: deletedLines(db, turns, newId), read: readLines(db, turns, newId) };
  } finally {
    (db as unknown as DatabaseSync).close();
  }
  await writeLines(options.root, options.dataDir, [...lines.deleted, ...lines.read], newId);
  return { ...counts, deletedLines: lines.deleted.length, readLines: lines.read.length };
}
