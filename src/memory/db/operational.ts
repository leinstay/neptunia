// The engine's own state in the memory database, one `operational` row per kind and subject: the store's state, the
// request usage, the latency metrics, the inner life's state, a place's missed-answer registry, a place's emoji rails,
// and the lines of a place's recall trace. The subject is a place id, or `persona:local` for what belongs to no place.
// A value row is owned by `<subject>`; a recall trace line by `<subject>#<position>`, its position counted from 0 in the
// order the lines were written. The writer (session-write.ts, write kind `operational`) stores through
// `writeOperational`; the readers of those modules read through `operationalValue`.

import { dbOf, isWholeNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

/** The kinds this module stores. Any other kind is memory and goes through its own writer. */
export const OPERATIONAL_KINDS = [
  'state',
  'usage',
  'metrics',
  'inner',
  'missed',
  'emoji_rails',
  'recall_trace',
] as const;
export type OperationalKind = (typeof OPERATIONAL_KINDS)[number];

/** Lines a recall trace keeps when its write names no cap; the store's own default is the same. */
const RECALL_TRACE_MAX_LINES = 500;

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });

export const isOperationalKind = (kind: unknown): kind is OperationalKind =>
  (OPERATIONAL_KINDS as ReadonlyArray<unknown>).includes(kind);

/** The stored value of a kind's subject, or not found when the database holds no live row of it. */
export function operationalValue(
  db: Db,
  kind: OperationalKind | (string & {}),
  subject: string
): { found: true; value: unknown } | { found: false } {
  const row = db
    .prepare('SELECT value FROM operational WHERE kind = ? AND owner = ? AND retired_at IS NULL')
    .get(kind, subject);
  return row ? { found: true, value: JSON.parse(String(row.value)) } : { found: false };
}

/** The bounds of the owners of a subject's lines: `<subject>#` up to the next character after `#`. */
const linesRange = (subject: string): [string, string] => [`${subject}#`, `${subject}$`];

/** The lines of a subject as JSON text, in the order they were written. */
export function operationalLines(db: Db, kind: OperationalKind | (string & {}), subject: string): Array<string> {
  return db
    .prepare(
      'SELECT value FROM operational WHERE kind = ? AND owner >= ? AND owner < ? AND retired_at IS NULL ORDER BY rowid'
    )
    .all(kind, ...linesRange(subject))
    .map((row) => String(row.value));
}

/** The subjects that hold a value of a kind, in id order. */
export function operationalSubjects(db: Db, kind: OperationalKind): Array<string> {
  return db
    .prepare(
      "SELECT owner FROM operational WHERE kind = ? AND retired_at IS NULL AND instr(owner, '#') = 0 ORDER BY owner"
    )
    .all(kind)
    .map((row) => String(row.owner));
}

/** The position the next line of a subject takes: one past the newest line's. */
function nextLinePosition(db: Db, kind: string, subject: string): number {
  const newest = db
    .prepare('SELECT owner FROM operational WHERE kind = ? AND owner >= ? AND owner < ? ORDER BY rowid DESC LIMIT 1')
    .get(kind, ...linesRange(subject))?.owner;
  const position = typeof newest === 'string' ? Number(newest.slice(subject.length + 1)) : -1;
  return Number.isInteger(position) ? position + 1 : 0;
}

/** One write of the operational kind: a value replaced whole, or recall trace lines appended under their cap. */
export type OperationalWrite =
  | { op: 'value'; of: OperationalKind; subject: string; value: unknown }
  | { op: 'lines'; of: 'recall_trace'; subject: string; lines: ReadonlyArray<{ record: unknown; maxLines?: unknown }> };

/** A write as the writer receives it, checked: a known kind, a subject and the op's own fields. */
function checked(update: Row): OperationalWrite {
  if (!isOperationalKind(update.of)) throw coded('OPERATIONAL_KIND');
  const subject = update.subject;
  if (typeof subject !== 'string' || subject === '' || subject.includes('#')) throw coded('OPERATIONAL_SUBJECT');
  if (update.op === 'value') return { op: 'value', of: update.of, subject, value: update.value ?? {} };
  if (update.op === 'lines' && update.of === 'recall_trace') {
    const lines = Array.isArray(update.lines) ? (update.lines as Array<unknown>) : [];
    for (const line of lines)
      if (line === null || typeof line !== 'object' || !('record' in line) || typeof line.record !== 'object')
        throw coded('OPERATIONAL_LINE');
    return { op: 'lines', of: 'recall_trace', subject, lines: lines as Array<{ record: unknown; maxLines?: unknown }> };
  }
  throw coded('OPERATIONAL_OP');
}

/** Stores one checked write inside the caller's transaction; returns how many rows it wrote and trimmed. */
export function writeOperational(db: Db, write: OperationalWrite): { written: number; trimmed: number } {
  const upsert = db.prepare(
    `INSERT INTO operational (kind, owner, value, retired_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(kind, owner) DO UPDATE SET value = excluded.value, retired_at = NULL`
  );
  if (write.op === 'value') {
    upsert.run(write.of, write.subject, JSON.stringify(write.value));
    return { written: 1, trimmed: 0 };
  }
  let position = nextLinePosition(db, write.of, write.subject);
  let trimmed = 0;
  for (const line of write.lines) {
    upsert.run(write.of, `${write.subject}#${position}`, JSON.stringify(line.record));
    position += 1;
    const cap = isWholeNumber(line.maxLines) && line.maxLines > 0 ? line.maxLines : RECALL_TRACE_MAX_LINES;
    const [from, to] = linesRange(write.subject);
    trimmed += Number(
      db
        .prepare(
          `DELETE FROM operational WHERE kind = ? AND owner >= ? AND owner < ? AND rowid NOT IN
           (SELECT rowid FROM operational WHERE kind = ? AND owner >= ? AND owner < ? ORDER BY rowid DESC LIMIT ?)`
        )
        .run(write.of, from, to, write.of, from, to, cap).changes
    );
  }
  return { written: write.lines.length, trimmed };
}

/** The write kind `operational` on the writer connection (session-write.ts). */
export function applyOperationalWrite(handle: MemoryHandle, update: Row): { written: number; trimmed: number } {
  const write = checked(update);
  return handle.transaction(() => writeOperational(dbOf(handle), write));
}

/** The operational write a unit write of an operational kind carries, or null for a unit of any other kind. */
export function operationalOfUnit(update: Row): OperationalWrite | null {
  const key = update.key as { kind?: unknown; subject?: { id?: unknown } } | undefined;
  if (!key || !isOperationalKind(key.kind)) return null;
  const subject = key.subject?.id;
  return update.op === 'lines'
    ? checked({ op: 'lines', of: key.kind, subject, lines: update.lines })
    : checked({ op: 'value', of: key.kind, subject, value: update.value });
}
