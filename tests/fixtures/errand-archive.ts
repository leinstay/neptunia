// A memory database whose errands are still in the `work` archive: board v2, before the data step of board v3 (PR 6d),
// with the units `guilds/g1/errands.json` and `errands.jsonl` written by the unit writer as the engine before 6d wrote
// them. Four errands, one per path through the states: done and read, failed and unread, cancelled in a private chat
// and resolved, running on the `server` agent. Synthetic data only.
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../../src/memory/db/open.js';
import { applyUnitWrite } from '../../src/memory/db/unit-write.js';
import { BOARD_MIGRATIONS } from '../../src/board/schema.ts';
import type { ErrandRecord, ErrandState } from '../../src/errands/types.ts';
import { tempDir } from './tmp.js';

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
    requester: { userId: 'u1', kind: 'member' },
    origin: { channelId: 'c1', messageId: 'm1', turnId: 'turn-1' },
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
    requester: { userId: 'u1', kind: 'member' },
    origin: { channelId: 'c1', messageId: 'm2' },
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
    requester: { userId: 'u2', kind: 'owner' },
    origin: { channelId: 'dm1', messageId: 'm3' },
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
    requester: { userId: 'u2', kind: 'owner' },
    origin: { channelId: 'c1', messageId: 'm4' },
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

/** The board status each archived errand moves to: queued approved, running in_progress, the ends as they are. */
export const BOARD_STATUS: Readonly<Record<string, string>> = Object.freeze({
  t0000e001: 'done',
  t0000e002: 'failed',
  t0000e003: 'cancelled',
  t0000e004: 'in_progress',
});

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

/** The board statuses of each errand's transition lines, in order. */
export const STATUS_EVENTS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  t0000e001: ['approved', 'in_progress', 'done'],
  t0000e002: ['approved', 'in_progress', 'failed'],
  t0000e003: ['approved', 'cancelled'],
  t0000e004: ['approved', 'in_progress'],
});

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

/**
 * Writes the archive into `file` at board v2: the errand units through the unit writer, the way the engine before
 * PR 6d wrote them. The database is closed again; the next open by the current code runs board v3.
 */
export function writeArchive(file: string, errands: ReadonlyArray<ErrandRecord> = ARCHIVE): void {
  const handle = openMemoryDb(file, { boardMigrations: BOARD_MIGRATIONS.slice(0, 2) });
  try {
    const now = T0 + 10 * MINUTE;
    applyUnitWrite(handle, {
      kind: 'unit',
      op: 'value',
      owner: `guilds/${GUILD}/errands.json`,
      value: { errands: errands.map((errand) => JSON.parse(JSON.stringify(errand)) as ErrandRecord) },
      now,
    });
    const ids = new Set(errands.map((errand) => errand.id));
    applyUnitWrite(handle, {
      kind: 'unit',
      op: 'lines',
      owner: `guilds/${GUILD}/errands.jsonl`,
      lines: archiveLines().filter((line) => ids.has(String(line.id))),
      now,
    });
  } finally {
    handle.close();
  }
}

/** A new data directory whose `memory.db` holds the archive at board v2: `{ dataDir, file }`. */
export function archiveDataDir(prefix = 'nep-errand-archive-'): { dataDir: string; file: string } {
  const dataDir = path.join(tempDir(prefix), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'memory.db');
  writeArchive(file);
  return { dataDir, file };
}
