// The lines of the journal: her turns and their starts, actions, inner and system events, the missed-message records
// and the analyzer's memory decisions, as rows owned by the unit of their place's day
// (`placeOrPersona('journal', placeId, { partition: <YYYY-MM-DD> })`, the UTC day of the line's `occurredAt`).
// src/memory/journal.ts writes them through the write kind `journal-lines` (session-write.ts) and reads them back
// through the readers below. An errand's closing line comes with its board move (errand-write.ts).
//
//   turn                      -> a `sources` row (kind answer: her think and the ids she posted) + a `day` row
//   memory                    -> a `decisions` row (by the analyzer) + one `affinity_events` row per attitude entry
//   any other kind            -> a `day` row (action, inner, system, turn.start, and answer: a missed-message record)
//
// Every field a column names is in the column; the rest of the line is in the carrying row's `extra` (the `day` row, the
// `decisions` row), so the line is rebuilt exactly from its rows. `day.what` is the line's kind. An action line of an
// errand (`name` `errand`) references its board task in `day.work_id`. The member an attitude entry is toward is the
// stored person of the member's account, null when none is stored, and the platform id stays in the row's `extra`.
// A line of a DM place takes the place's audience (scope-parts.ts).

import { answerSourceId } from './ids.ts';
import { extraText, ifaceOf, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './row-columns.ts';
import type { MapContext, Spec } from './row-columns.ts';
import { storageContext } from './storage-context.ts';
import { privateUserOf, scopeFrom, scopeInto } from './scope-parts.ts';
import type { OldScope } from './scope-parts.ts';
import { errandIdOfLine } from '../../board/archive.ts';
import { addSourceMedia } from './record-lines.ts';
import { markStemsPending } from './stems.ts';
import { placeOrPersona } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import { ensureUnit, noteUnit } from './storage-units.ts';
import { writeMapping } from './upsert.ts';
import { lineColumns, lineOwnerOf, lineRows, nextLinePosition } from './line-owner.ts';
import type { LineOwner } from './line-owner.ts';
import { requiredIface } from './live-iface.ts';
import { asText, dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: lines of one place (null: the persona's). */
export type JournalLinesWrite = { placeId: string | null; lines: ReadonlyArray<Row> };

/** What a write answers: the lines it wrote (the journal holds no duplicate and adopts nothing). */
export type JournalLinesResult = { written: number; duplicates: number; adopted: number };

const DAY_SPEC: Array<Spec> = [
  { col: 'id', key: 'id', type: 'text' },
  { col: 'at', key: 'occurredAt', type: 'text' },
  { col: 'what', key: 'kind', type: 'text' },
  { col: 'outcome', key: 'outcome', type: 'text' },
  { col: 'reason', key: 'reason', type: 'text' },
  { col: 'turn_id', key: 'turnId', type: 'text' },
];

const DECISION_SPEC: Array<Spec> = [
  { col: 'id', key: 'id', type: 'text' },
  { col: 'at', key: 'occurredAt', type: 'text' },
  { col: 'target_id', key: 'batchId', type: 'text' },
  { col: 'action', key: 'stage', type: 'text' },
  { col: 'reason', key: 'note', type: 'text' },
];

const ANSWER_SPEC: Array<Spec> = [{ col: 'think', key: 'think', type: 'text' }];

/** The tables a journal day's lines are in; a memory line's attitude rows hang off its `decisions` row. */
const TABLES = ['day', 'decisions', 'sources'] as const;

/** An attitude entry's columns (see the head of this file). */
const attitudeSpec = (ctx: MapContext): Array<Spec> => [
  {
    col: 'person_id',
    key: 'accountId',
    type: 'text',
    enc: (v: unknown, iface: string | null) =>
      iface === null ? null : (ctx.personOfMember?.(iface, String(v)) ?? null),
    dec: () => null,
    exact: true,
  },
  { col: 'delta', key: 'delta', type: 'num' },
  { col: 'applied', key: 'applied', type: 'num' },
  { col: 'reason', key: 'reason', type: 'text' },
];

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const has = (rest: Row, key: string) => Array.isArray(rest.$has) && rest.$has.includes(key);
const markHas = (rest: Row, key: string): void => {
  ((rest.$has ??= []) as Array<string>).push(key);
};

/** What a row keeps of a line's scope when its place is not one of its columns: the triple and, for a DM, the audience. */
function scopeRows(scope: Row): Row {
  const out = { ...scope };
  delete out.place_id;
  return out;
}

/**
 * Where a day's rows belong: the unit's id, the day's owner columns (line-owner.ts), the line's position in it and,
 * from an older release, its owner path.
 */
type Owner = { id: string; line: LineOwner; position: number | null };

const owned = (owner: Owner): Row => ({
  owner_key: owner.id,
  ...lineColumns(owner.line),
});

function memoryRows(line: Row, ctx: MapContext, privateUser: string | null, owner: Owner): Rows {
  const iface = ifaceOf(ctx);
  const rows: Rows = {};
  const body = { ...line };
  delete body.attitude;
  const { cols, rest } = split(body, DECISION_SPEC);
  const attitude = line.attitude;
  const mappable = Array.isArray(attitude) && attitude.every(isPlainObject);
  if (mappable) markHas(rest, 'attitude');
  else if (Object.hasOwn(line, 'attitude')) rest.attitude = attitude;
  put(rows, 'decisions', {
    ...cols,
    by: 'analyzer',
    target_kind: 'batch',
    extra: extraText(rest),
    ...owned(owner),
    position: owner.position,
  });
  if (mappable) {
    const scopeRest: Row = {};
    const scope = scopeRows(
      scopeInto(scopeRest, line.scope as OldScope | undefined, privateUser, iface, ctx.dmPlace, ctx)
    );
    attitude.forEach((entry, index) => {
      const part = split(entry, attitudeSpec(ctx), iface);
      put(rows, 'affinity_events', {
        id: `aff:${asText(line.id)}:${index}`,
        ...part.cols,
        at: typeof line.occurredAt === 'string' ? line.occurredAt : null,
        score: null,
        ...scope,
        extra: extraText(part.rest),
        ...owned(owner),
        position: index,
      });
    });
  }
  return rows;
}

/**
 * The rows of a journal line: `ctx.iface` its interface, `ctx.privateAccountId` the partner of a private layer,
 * `ctx.dmPlace` the DM place of its unit, `owner` its unit and position.
 */
export function journalRows(line: Row, ctx: MapContext, owner: Owner): Rows {
  const iface = ifaceOf(ctx);
  const privateUser = ctx.privateAccountId ?? null;
  if (line.kind === 'memory') return memoryRows(line, ctx, privateUser, owner);
  const rows: Rows = {};
  const body = { ...line };
  delete body.scope;
  const isTurn = line.kind === 'turn';
  let sourceId = null;
  if (isTurn) {
    delete body.think;
    delete body.posted;
    sourceId = answerSourceId(
      typeof line.turnId === 'string' ? line.turnId : line.id,
      isFiniteNumber(line.attemptId) ? line.attemptId : 0
    );
  }
  const { cols, rest } = split(body, DAY_SPEC);
  const scope = scopeInto(rest, line.scope as OldScope | undefined, privateUser, iface, ctx.dmPlace, ctx);
  const placeId = scope.place_id;
  const scoped = scopeRows(scope);
  put(rows, 'day', {
    ...cols,
    place_id: placeId,
    source_id: sourceId,
    work_id: errandIdOfLine(line),
    ...scoped,
    extra: extraText(rest),
    ...owned(owner),
    position: owner.position,
  });
  if (isTurn) {
    const answer: Row = {};
    for (const key of ['think', 'posted']) if (Object.hasOwn(line, key)) answer[key] = line[key];
    const part = split(answer, ANSWER_SPEC);
    put(rows, 'sources', {
      id: sourceId,
      kind: 'answer',
      iface,
      place_id: placeId,
      occurred_at: typeof line.occurredAt === 'string' ? line.occurredAt : null,
      recorded_at: typeof line.recordedAt === 'string' ? line.recordedAt : null,
      turn_id: typeof line.turnId === 'string' ? line.turnId : null,
      origin: typeof line.origin === 'string' ? line.origin : null,
      ...part.cols,
      ...scoped,
      extra: extraText(part.rest),
      ...owned(owner),
      position: owner.position,
    });
  }
  return rows;
}

/**
 * The line of one journal entry's rows: a `day` row with its answer, or a `decisions` row with its attitude rows.
 * `ctx` is its unit's subject context; with none, the partner of a private layer is the one its `owner_file` spells.
 */
export function journalLineOf(rows: Rows, ctx: MapContext = {}): Row {
  const decision = rowsOf(rows, 'decisions')[0];
  if (decision) {
    const rest = parseExtra(decision.extra);
    const attitudeRows = has(rest, 'attitude') ? ordered(rows, 'affinity_events') : null;
    delete rest.$has;
    const line = join(decision, rest, DECISION_SPEC);
    if (attitudeRows) line.attitude = attitudeRows.map((row) => join(row, row.extra, attitudeSpec(ctx)));
    return line;
  }
  const day = rows.day[0];
  const rest = parseExtra(day.extra);
  const scope = scopeFrom(day, rest, ctx.privateAccountId ?? privateUserOf(String(day.owner_file)), ctx);
  const line = join(day, rest, DAY_SPEC);
  if (scope !== undefined) line.scope = scope;
  const answer = rowsOf(rows, 'sources')[0];
  if (answer) Object.assign(line, join(answer, answer.extra, ANSWER_SPEC));
  return line;
}

/**
 * Stores the lines of one day's unit `key` inside the caller's transaction, in order from the unit's next position.
 * `iface` is the interface of the write, for a persona's unit.
 */
export function writeJournalDay(
  db: Db,
  key: StorageKey,
  lines: ReadonlyArray<unknown>,
  { iface, at }: { iface: string; at: string }
): JournalLinesResult {
  const id = ensureUnit(db, key);
  const base = storageContext(db, key);
  const ctx: MapContext = { ...base, iface: base.iface ?? iface };
  const owner = lineOwnerOf(key);
  if (!owner) throw coded('JOURNAL_LINES_DAY');
  let position = nextLinePosition(db, owner);
  let written = 0;
  for (const line of lines) {
    if (!isPlainObject(line)) continue;
    writeMapping(db, journalRows(line, ctx, { id, line: owner, position }), id, { at });
    written += 1;
    position += 1;
  }
  noteUnit(db, id, 'journal', { lines: position, at });
  if (written > 0) markStemsPending(db);
  return { written, duplicates: 0, adopted: 0 };
}

/** A write as the writer receives it, checked. */
export function journalLinesWriteOf(update: Row): JournalLinesWrite {
  if (update.placeId !== null && !filled(update.placeId)) throw coded('JOURNAL_LINES_PLACE');
  if (!Array.isArray(update.lines)) throw coded('JOURNAL_LINES_LINES');
  return { placeId: update.placeId, lines: (update.lines as Array<unknown>).filter(isPlainObject) };
}

/** Stores one checked write inside the caller's transaction: each run of lines of one day in that day's unit. */
export function writeJournalLines(db: Db, write: JournalLinesWrite, iface: string, at: string): JournalLinesResult {
  const result: JournalLinesResult = { written: 0, duplicates: 0, adopted: 0 };
  const runs: Array<{ day: string; lines: Array<Row> }> = [];
  for (const line of write.lines) {
    const day = String(line.occurredAt).slice(0, 10);
    const last = runs.at(-1);
    if (last?.day === day) last.lines.push(line);
    else runs.push({ day, lines: [line] });
  }
  for (const run of runs) {
    const key = placeOrPersona('journal', write.placeId, { partition: run.day });
    result.written += writeJournalDay(db, key, run.lines, { iface, at }).written;
  }
  return result;
}

/** The write kind `journal-lines` on the writer connection (session-write.ts). */
export function applyJournalLinesWrite(handle: MemoryHandle, update: Row): JournalLinesResult {
  const write = journalLinesWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  return handle.transaction(() => writeJournalLines(dbOf(handle), write, requiredIface(update), at));
}

/** The live rows of one journal day, table by table, in the order they were written. */
function dayRows(db: Db, owner: LineOwner): Rows {
  const rows: Rows = {};
  for (const table of TABLES) rows[table] = lineRows(db, owner, table);
  // A memory line's attitude rows are named after its decision (`aff:<line id>:<index>`): a range of the primary key.
  const attitude = db.prepare(
    `SELECT * FROM affinity_events WHERE id >= ? AND id < ? AND writer = 'journal' AND retired_at IS NULL
     ORDER BY position, rowid`
  );
  rows.affinity_events = rows.decisions.flatMap((decision) =>
    attitude.all(`aff:${asText(decision.id)}:`, `aff:${asText(decision.id)};`).map((row) => ({ ...row }))
  );
  addSourceMedia(db, rows.sources);
  return rows;
}

/** The lines (JSON text) of one journal day's unit, in the order they were written. */
export function journalLines(db: Db, key: StorageKey): Array<string> {
  const owner = lineOwnerOf(key);
  if (!owner) return [];
  const rows = dayRows(db, owner);
  const ctx = storageContext(db, key);
  const answers = new Map(rows.sources.map((row): [unknown, Row] => [row.id, row]));
  const items: Array<{ position: unknown; build: () => Row }> = [
    ...rows.day.map((row) => ({
      position: row.position,
      build: () =>
        journalLineOf(
          { day: [row], sources: answers.has(row.source_id) ? [answers.get(row.source_id) as Row] : [] },
          ctx
        ),
    })),
    ...rows.decisions.map((row) => ({
      position: row.position,
      build: () =>
        journalLineOf(
          {
            decisions: [row],
            affinity_events: rows.affinity_events.filter((event) =>
              String(event.id).startsWith(`aff:${asText(row.id)}:`)
            ),
          },
          ctx
        ),
    })),
  ];
  return items
    .map((item, index): [(typeof items)[number], number] => [item, index])
    .sort((a, b) => Number(a[0].position ?? 0) - Number(b[0].position ?? 0) || a[1] - b[1])
    .map(([item]) => JSON.stringify(item.build()));
}

/**
 * When the journal was last written: the latest `recordedAt` among the lines of the given day units (epoch ms), or null
 * when none has one.
 */
export function journalLastWrite(db: Db, keys: ReadonlyArray<StorageKey>): number | null {
  let last: number | null = null;
  for (const key of keys) {
    for (const line of journalLines(db, key)) {
      let at = NaN;
      try {
        at = Date.parse((JSON.parse(line) as { recordedAt?: string } | null)?.recordedAt as string);
      } catch {
        at = NaN;
      }
      if (Number.isFinite(at) && (last === null || at > last)) last = at;
    }
  }
  return last;
}
