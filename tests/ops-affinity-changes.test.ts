// `memory.profile.read section:changes` (src/tools/operations/memory.ts): every attitude change the memory database
// holds, across people, newest first, narrowed by person, time window and a limit. It reads the group audiences alone:
// a change made in a private chat and a retired change are never listed. Real memory database, seeded directly.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { runOp } from '../src/tools/operations/index.ts';
import { ANNA, BORIS, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

type Seed = {
  id: string;
  person: string;
  at: string;
  applied: number;
  score: number;
  reason: string;
  retired?: boolean;
};
const EVENTS: Array<Seed> = [
  { id: 'ev:1', person: ANNA, at: '2026-11-01T10:00:00.000Z', applied: 2, score: 12, reason: 'helped with the garden' },
  { id: 'ev:2', person: BORIS, at: '2026-11-03T10:00:00.000Z', applied: -1, score: 4, reason: 'snapped at a friend' },
  { id: 'ev:3', person: ANNA, at: '2026-11-05T10:00:00.000Z', applied: 1, score: 13, reason: 'thanked her twice' },
  {
    id: 'ev:4',
    person: ANNA,
    at: '2026-11-04T10:00:00.000Z',
    applied: 5,
    score: 99,
    reason: 'a retired move',
    retired: true,
  },
];

function rig() {
  const dataDir = tempDir('nep-ops-affinity-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  seedOpaqueWorld(db);
  for (const e of EVENTS)
    db.prepare(
      `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, audience_id, scope_kind, writer, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'aud:group:discord', 'group', 'session', ?)`
    ).run(e.id, e.person, e.at, e.applied, e.applied, e.score, e.reason, e.retired ? '2026-11-06T00:00:00.000Z' : null);
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const hot = {
    config: { bot: { owners: [], access: {} }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
    prompts: { labels: {} },
    rootDir: dataDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const env = createOpsEnv({ hot, store: createStore({ dataDir, memoryDb }), memoryDb, dataDir });
  return { env };
}

const read = async (args: Record<string, unknown>) => {
  const { env } = rig();
  const result = await runOp('memory.profile.read', { section: 'changes', ...args }, { env, asOwner: true });
  return { result, text: JSON.stringify(result) };
};

test('a date that is not a date is refused', async () => {
  const { result } = await read({ since: 'last tuesday' });
  assert.equal(result.status, 'invalid');
});

test('the changes of one person alone', async () => {
  // Catches: the person filter is ignored and Boris's moves come with hers.
  const { env } = rig();
  const result = await runOp('memory.profile.read', { section: 'changes', accountId: 'n1' }, { env, asOwner: true });
  const text = JSON.stringify(result);
  assert.ok(text.includes('thanked her twice') && text.includes('helped with the garden'));
  assert.equal(text.includes('snapped at a friend'), false);
});
