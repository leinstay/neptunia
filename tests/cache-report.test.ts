// Tests for scripts/cache-report.ts: the prompt cache over a day range of `model_requests`, read-only, on a memory
// database this file writes. Five turns of her in two places on one day, and rows the report must leave out: a turn
// two days later, a helper's request and a failed one. No model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cacheReport, main } from '../scripts/cache-report.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { fillAudiences } from './fixtures/memory-db/audiences.ts';
import { sqlOf } from './fixtures/loose-types.ts';
import type { UntypedDb } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';

type Request = {
  turn: string;
  step: number;
  at: string;
  prompt: number;
  cached?: number;
  role?: string;
  status?: string;
};

const REQUESTS: ReadonlyArray<Request> = [
  { turn: 't1', step: 0, at: '2026-11-05T10:00:00.000Z', prompt: 1000, cached: 0 },
  { turn: 't1', step: 1, at: '2026-11-05T10:00:20.000Z', prompt: 1200, cached: 1000 },
  { turn: 't2', step: 0, at: '2026-11-05T10:02:00.000Z', prompt: 1100, cached: 900 },
  { turn: 't3', step: 0, at: '2026-11-05T10:12:00.000Z', prompt: 1000 },
  { turn: 't4', step: 0, at: '2026-11-05T11:00:00.000Z', prompt: 800, cached: 0 },
  { turn: 't5', step: 0, at: '2026-11-05T11:01:00.000Z', prompt: 900, cached: 700 },
  // Left out: a later day, a helper's request, a failed request.
  { turn: 't6', step: 0, at: '2026-11-07T09:00:00.000Z', prompt: 5000, cached: 0 },
  { turn: 't2', step: 1, at: '2026-11-05T10:02:30.000Z', prompt: 7777, cached: 0, role: 'helpers' },
  { turn: 't5', step: 1, at: '2026-11-05T11:01:30.000Z', prompt: 3333, cached: 0, status: 'failed' },
];

const PLACES: Readonly<Record<string, string>> = {
  t1: 'fake:channel:c1',
  t2: 'fake:channel:c1',
  t3: 'fake:channel:c1',
  t4: 'cli:dm:owner',
  t5: 'cli:dm:owner',
  t6: 'fake:channel:c1',
};

function insertRequest(db: UntypedDb, one: Request, n: number): void {
  const usage = {
    prompt_tokens: one.prompt,
    completion_tokens: 50,
    ...(one.cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: one.cached } }),
  };
  db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, role, status, started_at, finished_at,
       messages, usage)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`
  ).run(
    `req-${n}`,
    one.turn,
    `${one.turn}-a1`,
    one.step,
    one.role ?? 'core',
    one.status ?? 'ok',
    one.at,
    one.at,
    JSON.stringify(usage)
  );
}

/** A data folder whose `memory.db` holds the requests above and a journal row per turn with its place. */
function dataDir(): string {
  const dir = tempDir('nep-cache-report-');
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  const db = sqlOf(handle);
  REQUESTS.forEach((one, n) => insertRequest(db, one, n));
  for (const [turn, place] of Object.entries(PLACES)) {
    const at = REQUESTS.find((one) => one.turn === turn)?.at ?? '';
    db.prepare(
      `INSERT INTO day (id, at, what, place_id, turn_id, scope_kind, scope_iface)
       VALUES (?, ?, 'turn', ?, ?, 'group', 'fake')`
    ).run(`day-${turn}`, at, place, turn);
  }
  fillAudiences(handle.db as DatabaseSync);
  handle.close();
  return dir;
}

const RANGE = { from: '2026-11-05', to: '2026-11-05' };

test('cacheReport: sums the prompt and cached tokens of her ok requests in the range, and nothing else', () => {
  const dir = dataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'), { readOnly: true });
  try {
    const report = cacheReport(handle, RANGE);
    assert.equal(report.turns, 5);
    assert.equal(report.promptTokens, 6000);
    assert.equal(report.cachedTokens, 2600);
  } finally {
    handle.close();
  }
});

test('cacheReport: the share of turns whose first request read no cached token', () => {
  // Bug: counting a turn by its later steps hides that every first request missed the cache.
  const dir = dataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'), { readOnly: true });
  try {
    assert.equal(cacheReport(handle, RANGE).zeroCacheShare, 0.6);
  } finally {
    handle.close();
  }
});

test('cacheReport: the median gap between consecutive turns of one place, in seconds', () => {
  // Bug: a gap measured across places says nothing of whether a place's prefix is still in the cache.
  const dir = dataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'), { readOnly: true });
  try {
    assert.equal(cacheReport(handle, RANGE).medianGapSeconds, 120);
  } finally {
    handle.close();
  }
});

test('cacheReport: a range with no turn reports zero turns and no gap', () => {
  const dir = dataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'), { readOnly: true });
  try {
    const report = cacheReport(handle, { from: '2026-11-01', to: '2026-11-02' });
    assert.equal(report.turns, 0);
    assert.equal(report.zeroCacheShare, 0);
    assert.equal(report.medianGapSeconds, null);
  } finally {
    handle.close();
  }
});

test('cache-report prints the four numbers of the range and leaves the database as it was', async () => {
  // Bug: a measurement script that opens the database for writing migrates or locks production's memory.
  const dir = dataDir();
  const file = path.join(dir, 'memory.db');
  const before = createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  const out = await main(['--data', dir, '--from', RANGE.from, '--to', RANGE.to]);
  for (const number of ['6000', '2600', '60%', '120']) assert.ok(out.includes(number), `${number} in:\n${out}`);
  assert.equal(createHash('sha1').update(fs.readFileSync(file)).digest('hex'), before);
});

test('cache-report refuses a range whose start is after its end', async () => {
  const dir = dataDir();
  await assert.rejects(main(['--data', dir, '--from', '2026-11-06', '--to', '2026-11-05']));
});
