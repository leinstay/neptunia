// A memory database whose errands are in the `work` archive: one `work` row per errand and one `work_events` row per
// transition, as the engine wrote them before the board held errands, in a database at the baseline. Four errands, one per path through the states: done and read, failed and unread, cancelled in a private chat
// and resolved, running on the `server` agent. Synthetic data only.
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import { dbOf } from '../../src/memory/db/types.ts';
import type { ErrandRecord, ErrandState } from '../../src/errands/types.ts';
import { tempDir } from './tmp.ts';

export const GUILD = 'g1';
export const T0 = Date.parse('2026-10-30T10:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const usage = (usd: number, steps: number): ErrandRecord['usage'] => ({
  input: 1200,
  output: 300,
  usd,
  steps,
  seconds: 5,
});

/** The errands as `errands.json` holds them, in the order they were queued. */
export const ARCHIVE: ReadonlyArray<ErrandRecord> = Object.freeze([
  {
    id: 't0000e001',
    agent: 'scout',
    goal: 'find the release notes of the editor',
    requester: { accountId: 'u1', kind: 'member' },
    origin: { placeId: 'c1', messageId: 'm1', turnId: 'turn-1' },
    idempotencyKey: 'turn-1:0',
    scope: 'group',
    state: 'done',
    createdAt: T0,
    startedAt: T0 + SECOND,
    endedAt: T0 + 6 * SECOND,
    usage: usage(0.25, 3),
    result: { text: 'The notes list three changes.', sources: ['https://example.org/notes'], files: [] },
    error: null,
    seen: true,
    readAt: T0 + 7 * SECOND,
    resolvedAt: null,
    opId: 'op-e001',
  },
  {
    id: 't0000e002',
    agent: 'scout',
    goal: 'compare the two price lists',
    requester: { accountId: 'u1', kind: 'member' },
    origin: { placeId: 'c1', messageId: 'm2' },
    scope: 'group',
    state: 'failed',
    createdAt: T0 + MINUTE,
    startedAt: T0 + MINUTE + SECOND,
    endedAt: T0 + MINUTE + 30 * SECOND,
    usage: usage(0.05, 1),
    result: null,
    error: 'withheld-path',
    seen: false,
    readAt: null,
    resolvedAt: null,
    opId: 'op-e002',
  },
  {
    id: 't0000e003',
    agent: 'scout',
    goal: 'look up the opening hours',
    requester: { accountId: 'u2', kind: 'owner' },
    origin: { placeId: 'dm1', messageId: 'm3' },
    scope: 'dm',
    state: 'cancelled',
    createdAt: T0 + 2 * MINUTE,
    startedAt: null,
    endedAt: T0 + 2 * MINUTE + 5 * SECOND,
    usage: usage(0, 0),
    result: null,
    error: 'cancelled',
    seen: false,
    readAt: T0 + 2 * MINUTE + 10 * SECOND,
    resolvedAt: T0 + 2 * MINUTE + 10 * SECOND,
    opId: 'op-e003',
  },
  {
    id: 't0000e004',
    agent: 'server',
    goal: 'list the failed units',
    requester: { accountId: 'u2', kind: 'owner' },
    origin: { placeId: 'c1', messageId: 'm4' },
    scope: 'group',
    state: 'running',
    createdAt: T0 + 3 * MINUTE,
    startedAt: T0 + 3 * MINUTE + SECOND,
    endedAt: null,
    usage: null,
    result: null,
    error: null,
    seen: false,
    readAt: null,
    resolvedAt: null,
    opId: 'op-e004',
  },
]);

/** The states each errand passed through, in its `errands.jsonl` lines, with the time of each. */
const PATHS: Readonly<Record<string, ReadonlyArray<[ErrandState, number]>>> = {
  t0000e001: [
    ['queued', T0],
    ['running', T0 + SECOND],
    ['done', T0 + 6 * SECOND],
  ],
  t0000e002: [
    ['queued', T0 + MINUTE],
    ['running', T0 + MINUTE + SECOND],
    ['failed', T0 + MINUTE + 30 * SECOND],
  ],
  t0000e003: [
    ['queued', T0 + 2 * MINUTE],
    ['cancelled', T0 + 2 * MINUTE + 5 * SECOND],
  ],
  t0000e004: [
    ['queued', T0 + 3 * MINUTE],
    ['running', T0 + 3 * MINUTE + SECOND],
  ],
};

/** The `errands.jsonl` lines: each errand as it stood after each transition, in the order they happened. */
export function archiveLines(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const errand of ARCHIVE) {
    for (const [state, at] of PATHS[errand.id] ?? []) {
      const closed = state !== 'queued' && state !== 'running';
      lines.push({ at, ...errand, state, ...(closed ? {} : { endedAt: null, usage: null, result: null, error: null }) });
    }
  }
  return lines.sort((a, b) => Number(a.at) - Number(b.at));
}

/** A copy of an archived errand, as a store hands it out. */
export function archived(id: string): ErrandRecord {
  const found = ARCHIVE.find((errand) => errand.id === id);
  if (found === undefined) throw new Error(`no archived errand ${id}`);
  return JSON.parse(JSON.stringify(found)) as ErrandRecord;
}

/** Writes the archive into `file`: the `work` and `work_events` rows, and closes the database again. */
export function writeArchive(file: string, errands: ReadonlyArray<ErrandRecord> = ARCHIVE): void {
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    const work = db.prepare(
      `INSERT INTO work (id, kind, state, record, created_ms, updated_ms, outcome, seen, position)
       VALUES (?, 'errand', ?, ?, ?, ?, ?, ?, ?)`
    );
    errands.forEach((errand, position) => {
      const record = JSON.parse(JSON.stringify(errand)) as ErrandRecord;
      work.run(
        record.id,
        record.state,
        JSON.stringify(record),
        record.createdAt ?? null,
        record.endedAt ?? record.startedAt ?? record.createdAt ?? null,
        typeof record.error === 'string' ? record.error : null,
        typeof record.seen === 'boolean' ? Number(record.seen) : null,
        position
      );
    });
    const ids = new Set(errands.map((errand) => errand.id));
    const event = db.prepare('INSERT INTO work_events (id, work_id, at_ms, record, position) VALUES (?, ?, ?, ?, ?)');
    archiveLines()
      .filter((line) => ids.has(String(line.id)))
      .forEach((line, position) => {
        event.run(`${String(line.id)}:${String(line.at)}:${position}`, String(line.id), Number(line.at), JSON.stringify(line), position);
      });
  } finally {
    handle.close();
  }
}

/** A new data directory whose `memory.db` holds the archive: `{ dataDir, file }`. */
export function archiveDataDir(prefix = 'nep-errand-archive-'): { dataDir: string; file: string } {
  const dataDir = path.join(tempDir(prefix), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'memory.db');
  writeArchive(file);
  return { dataDir, file };
}
