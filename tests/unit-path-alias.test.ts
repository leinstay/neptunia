// `currentUnitPath` (src/memory/db/paths.js) is the one alias table for unit paths: the names an errand unit had
// (`guilds/<g>/tasks.json`, `tasks.jsonl`) map to the current ones (`errands.json`, `errands.jsonl`), directly under a
// guild and nowhere else. The unit writer reads an owner through it, so a write that a shutdown kept in
// `memory-pending/` under the old name lands in the current unit when the next start replays it, and never recreates
// the old one. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentUnitPath } from '../src/memory/db/paths.js';
import { dbOf } from './fixtures/memory-db/v13-errands.ts';
import { openTestMemory, tempDataDir, unitFile } from './fixtures/memory-db/service.js';

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

test('replays a kept value write to tasks.json into errands.json and creates no unit under the old name', async () => {
  const dataDir = tempDataDir('nep-alias-');
  const first = await openTestMemory({ dataDir });
  await first.close();
  keepPending(dataDir, { owner: 'guilds/g1/tasks.json', op: 'value', value: { tasks: [ERRAND] } });
  const memory = await openTestMemory({ dataDir });
  try {
    const text = unitFile(memory.memoryDb, 'guilds/g1/errands.json');
    const value = JSON.parse(String(text)) as { errands: Array<{ id: string }> };
    assert.deepEqual(
      value.errands.map((errand) => errand.id),
      ['t0000000a']
    );
    const old = dbOf(memory.memoryDb.readHandle() as { db: object })
      .prepare(
        "SELECT (SELECT COUNT(*) FROM files WHERE path LIKE 'guilds/g1/tasks.json%') + (SELECT COUNT(*) FROM work WHERE owner_file LIKE 'guilds/g1/tasks.json%') AS n"
      )
      .get();
    assert.equal(old?.n, 0);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'memory-pending')), [], 'the kept file is gone once replayed');
  } finally {
    await memory.close();
  }
});

test('replays kept transition lines of tasks.jsonl into errands.jsonl', async () => {
  const dataDir = tempDataDir('nep-alias-');
  const first = await openTestMemory({ dataDir });
  await first.close();
  const line = { ...ERRAND, at: 1_792_000_100_000 };
  keepPending(dataDir, { owner: 'guilds/g1/tasks.jsonl', op: 'lines', lines: [line] });
  const memory = await openTestMemory({ dataDir });
  try {
    const text = unitFile(memory.memoryDb, 'guilds/g1/errands.jsonl');
    assert.deepEqual(JSON.parse(String(text).trim()), line);
  } finally {
    await memory.close();
  }
});
