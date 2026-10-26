// Tests for the registry that keeps the discord.js objects of an event on the Discord side, under the event id,
// so the event itself crosses the link without them (interfaces/discord/raw-registry.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRawRegistry } from '../interfaces/discord/raw-registry.ts';

test('returns the handles put under an event id, the same objects', () => {
  const registry = createRawRegistry({ capacity: 5 });
  const message = { id: 'discord-message' };
  const previous = { id: 'discord-previous' };
  registry.put('e1', { message, previous });
  const got = registry.rawOf({ id: 'e1' });
  assert.equal(got?.message, message);
  assert.equal(got?.previous, previous);
});

test('keeps a null previous as null', () => {
  const registry = createRawRegistry({ capacity: 5 });
  registry.put('e1', { message: {}, previous: null });
  assert.equal(registry.rawOf({ id: 'e1' })?.previous, null);
});

test('returns null for an event id that was never put', () => {
  const registry = createRawRegistry({ capacity: 5 });
  registry.put('e1', { message: {}, previous: null });
  assert.equal(registry.rawOf({ id: 'e2' }), null);
});

test('keeps every handle up to the capacity', () => {
  const registry = createRawRegistry({ capacity: 3 });
  for (const id of ['e1', 'e2', 'e3']) registry.put(id, { message: { id }, previous: null });
  assert.deepEqual(
    ['e1', 'e2', 'e3'].map((id) => registry.rawOf({ id }) !== null),
    [true, true, true]
  );
});

test('drops the oldest handles past the capacity and keeps the newest', () => {
  const registry = createRawRegistry({ capacity: 3 });
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) registry.put(id, { message: { id }, previous: null });
  assert.deepEqual(
    ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => registry.rawOf({ id }) !== null),
    [false, false, true, true, true]
  );
});
