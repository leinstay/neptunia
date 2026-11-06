// The writer of a reconstructed diary plan (src/memory/db/selfreflection-plan-write.ts): the plan lands in an old entry's
// `extra.plan` with every other key kept, an entry that has a plan, a retired one and a missing one are left alone, and
// `extraOf` reads the stored metadata. A real memory database over a temporary data directory, invented entries only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { applySelfreflectionPlanFill, extraOf } from '../src/memory/db/selfreflection-plan-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle, Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { TestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const ID = 'selfreflection:harbour';
const PLAN = {
  brief: 'tea at the harbour',
  seeds: [['a harbour town', 'an attic room']],
  seed: 7,
  reconstructed: true,
};

const OPEN: Array<TestMemory> = [];
after(async () => {
  for (const memory of OPEN.splice(0)) await memory.close();
});

type Store = ReturnType<typeof createStore>;
type Post = Parameters<Store['appendSelfreflectionPost']>[0];

/** A memory with one recorded entry whose `extra` is set to `extra` (a stored string), its handle and a reader of the row. */
async function withEntry(extra: string | null): Promise<{ handle: MemoryHandle; read: () => Row }> {
  const memory = await openTestMemory({ now: () => NOW });
  OPEN.push(memory);
  const writer = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  const post = {
    at: NOW - 1000,
    kind: 'status',
    gist: 'A quiet day.',
    text: 'A quiet day.',
    picture: null,
    search: null,
    itemId: ID,
  };
  writer.appendSelfreflectionPost(post as unknown as Post, { max: 40 });
  writer.flush();
  await writer.flushSettled({});
  const handle = memory.memoryDb.readHandle() as MemoryHandle;
  const db = dbOf(handle);
  db.prepare('UPDATE selfreflection SET extra = ? WHERE id = ?').run(extra, ID);
  const read = (): Row => db.prepare('SELECT * FROM selfreflection WHERE id = ?').get(ID) as Row;
  return { handle, read };
}

test('writes the plan into extra.plan and keeps every other key of extra and the rest of the row', async () => {
  const { handle, read } = await withEntry(JSON.stringify({ mood: 'calm', tags: ['a', 'b'] }));
  const before = read();
  const result = applySelfreflectionPlanFill(handle, { id: ID, plan: PLAN, now: NOW });
  const written = read();
  assert.equal(result.written, 1);
  assert.deepEqual(JSON.parse(String(written.extra)), { mood: 'calm', tags: ['a', 'b'], plan: PLAN });
  assert.deepEqual({ ...written, extra: null }, { ...before, extra: null });
});

test('writes the plan into an entry with no extra', async () => {
  const { handle, read } = await withEntry(null);
  assert.equal(applySelfreflectionPlanFill(handle, { id: ID, plan: PLAN, now: NOW }).written, 1);
  assert.deepEqual(JSON.parse(String(read().extra)), { plan: PLAN });
});

test('leaves an entry that already has a plan as it is', async () => {
  const stored = JSON.stringify({ plan: { brief: 'the first plan', seeds: [], seed: 1 }, mood: 'calm' });
  const { handle, read } = await withEntry(stored);
  assert.equal(applySelfreflectionPlanFill(handle, { id: ID, plan: PLAN, now: NOW }).written, 0);
  assert.equal(read().extra, stored);
});

test('reports 0 and writes nothing for an id with no entry', async () => {
  const { handle, read } = await withEntry('{}');
  assert.equal(applySelfreflectionPlanFill(handle, { id: 'selfreflection:missing', plan: PLAN, now: NOW }).written, 0);
  assert.equal(read().extra, '{}');
});

test('leaves a retired entry as it is', async () => {
  const { handle, read } = await withEntry('{}');
  dbOf(handle).prepare('UPDATE selfreflection SET retired_at = ? WHERE id = ?').run(new Date(NOW).toISOString(), ID);
  assert.equal(applySelfreflectionPlanFill(handle, { id: ID, plan: PLAN, now: NOW }).written, 0);
  assert.equal(read().extra, '{}');
});

test('leaves an entry whose extra is not an object as it is', async () => {
  const { handle, read } = await withEntry('[1,2]');
  assert.equal(applySelfreflectionPlanFill(handle, { id: ID, plan: PLAN, now: NOW }).written, 0);
  assert.equal(read().extra, '[1,2]');
});

test('refuses a plan that is not a reconstructed one', async () => {
  const { handle, read } = await withEntry('{}');
  const bad = { ...PLAN, reconstructed: false };
  assert.throws(() => applySelfreflectionPlanFill(handle, { id: ID, plan: bad, now: NOW }), { code: 'BAD_PLAN' });
  assert.equal(read().extra, '{}');
});

test('extraOf reads a JSON object and gives an empty one for no metadata', () => {
  assert.deepEqual(extraOf('{"a":1}'), { a: 1 });
  assert.deepEqual(extraOf(null), {});
  assert.deepEqual(extraOf(''), {});
});

test('extraOf gives null for an array, a scalar, broken JSON and a non-string', () => {
  assert.equal(extraOf('[1]'), null);
  assert.equal(extraOf('5'), null);
  assert.equal(extraOf('null'), null);
  assert.equal(extraOf('{broken'), null);
  assert.equal(extraOf(12), null);
});
