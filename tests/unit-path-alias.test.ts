// `currentUnitPath` (src/memory/db/paths.js) is the one alias table for unit paths: the names an errand unit had
// (`guilds/<g>/tasks.json`, `tasks.jsonl`) map to the current ones (`errands.json`, `errands.jsonl`), directly under a
// guild and nowhere else. The unit writer reads an owner through it, so a write that a shutdown kept in
// `memory-pending/` under the old name is known as an errand unit when the next start replays it: past board v3 the
// writer skips it, and neither name gets a unit. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentUnitPath } from '../src/memory/db/paths.js';
import { dbOf } from './fixtures/memory-db/v13-errands.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.js';

const ERRAND = {
  id: 't0000000a',
  agent: 'scout',
  goal: 'look something up',
  state: 'done',
  createdAt: 1_792_000_000_000,
  endedAt: 1_792_000_100_000,
  readAt: null,
  resolvedAt: null,
};

test('maps the two old errand unit names to the current ones directly under a guild', () => {
  assert.equal(currentUnitPath('guilds/g1/tasks.json'), 'guilds/g1/errands.json');
  assert.equal(currentUnitPath('guilds/g1/tasks.jsonl'), 'guilds/g1/errands.jsonl');
});

test('leaves a private layer path, a current path and an unrelated path as they are', () => {
  for (const same of [
    'guilds/g1/private/p1/tasks.json',
    'guilds/g1/errands.json',
    'guilds/g1/errands.jsonl',
    'guilds/g1/intentions.json',
    'guilds/g1/tasks.json.bak',
    'tasks.json',
    'guilds/g1/users/tasks.json',
  ]) {
    assert.equal(currentUnitPath(same), same);
  }
});

/** Keeps `update` in `memory-pending/` the way the service does when a shutdown cannot write it. */
function keepPending(dataDir: string, update: Record<string, unknown>): void {
  const dir = path.join(dataDir, 'memory-pending');
  fs.mkdirSync(dir, { recursive: true });
  const name = createHash('sha1').update(String(update.owner)).digest('hex');
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ ...update, at: '2026-10-20T10:00:00.000Z' }));
}

/** The rows under either errand unit name, in the files and in the `work` archive. */
function errandUnitRows(memoryDb: { readHandle: () => unknown }): unknown {
  return dbOf(memoryDb.readHandle() as { db: object })
    .prepare(
      `SELECT (SELECT COUNT(*) FROM files WHERE path LIKE 'guilds/g1/tasks.json%' OR path LIKE 'guilds/g1/errands.json%')
        + (SELECT COUNT(*) FROM work) + (SELECT COUNT(*) FROM work_events) AS n`
    )
    .get()?.n;
}

/** A logger that keeps the messages it was given. */
function messages(): {
  out: Array<{ message: string; count?: unknown }>;
  log: Record<string, (m: string, f?: object) => void>;
} {
  const out: Array<{ message: string; count?: unknown }> = [];
  const add = (message: string, fields: object = {}): void => {
    out.push({ message, ...fields });
  };
  return { out, log: { info: add, warn: add, error: add, debug: add } };
}

// PR 6d, errands on the board: past board v3 the unit writer skips an errand unit, so a value kept under the old name
// is replayed through the alias and skipped (it asserted the value landing in errands.json before). The open must
// still succeed and the kept file go.
test('replays a kept value write to tasks.json as a skipped errand unit, writing no unit under either name', async () => {
  const dataDir = tempDataDir('nep-alias-');
  const first = await openTestMemory({ dataDir });
  await first.close();
  keepPending(dataDir, { owner: 'guilds/g1/tasks.json', op: 'value', value: { tasks: [ERRAND] } });
  const { out, log } = messages();
  const memory = await openTestMemory({ dataDir, log });
  try {
    assert.equal(errandUnitRows(memory.memoryDb), 0);
    assert.deepEqual(
      out.filter((entry) => entry.message === 'memory db: errand unit skipped').map((entry) => entry.count),
      [1]
    );
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'memory-pending')), [], 'the kept file is gone once replayed');
  } finally {
    await memory.close();
  }
});

// PR 6d, errands on the board: the same for kept transition lines under the old name (they landed in errands.jsonl
// before); the writer's skip of op `lines` counts the lines.
test('replays kept transition lines of tasks.jsonl as a skipped errand unit, writing no line', async () => {
  const dataDir = tempDataDir('nep-alias-');
  const first = await openTestMemory({ dataDir });
  await first.close();
  const lines = [
    { ...ERRAND, state: 'running', at: 1_792_000_050_000 },
    { ...ERRAND, at: 1_792_000_100_000 },
  ];
  keepPending(dataDir, { owner: 'guilds/g1/tasks.jsonl', op: 'lines', lines });
  const { out, log } = messages();
  const memory = await openTestMemory({ dataDir, log });
  try {
    assert.equal(errandUnitRows(memory.memoryDb), 0);
    assert.deepEqual(
      out.filter((entry) => entry.message === 'memory db: errand unit skipped').map((entry) => entry.count),
      [2]
    );
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'memory-pending')), [], 'the kept file is gone once replayed');
  } finally {
    await memory.close();
  }
});
