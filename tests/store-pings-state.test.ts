// A member's ping state in the memory store (src/memory/store.ts): `on`, `off` or unset for each member of a place.
// `getPings` and `setPings` are the state; `isPingsOff` stays true only for `off`. An `off` stored by the earlier
// switch, the `pingsOff` list of the place, reads as `off`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';
import { placeOfRoot } from '../src/memory/addresses.ts';
import { createStore } from '../src/memory/store.ts';
import { memDataDir, readRaw, settle, tmpDataDir, memoryAt } from './fixtures/store-kit.ts';

test('getPings: null for a member who never set a state', () => {
  // Bug: an unset member reads as `on` or `off`, and nobody follows the interface switch any more.
  const store = createStore(memoryAt(tmpDataDir()));
  assert.equal(store.getPings(placeOfRoot(store, 'g1'), 'u1'), null);
  assert.equal(store.isPingsOff(placeOfRoot(store, 'g1'), 'u1'), false);
});

test('setPings: on, off and null are each kept, replace the earlier state and return the new one', () => {
  // Bug: `on` is stored as the absence of `off`, so a member who chose `on` cannot be told from one who never chose.
  const store = createStore(memoryAt(tmpDataDir()));
  const place = placeOfRoot(store, 'g1');
  assert.equal(store.setPings(place, 'u1', 'on'), 'on');
  assert.equal(store.getPings(place, 'u1'), 'on');
  assert.equal(store.isPingsOff(place, 'u1'), false);
  assert.equal(store.setPings(place, 'u1', 'off'), 'off');
  assert.equal(store.getPings(place, 'u1'), 'off');
  assert.equal(store.isPingsOff(place, 'u1'), true);
  assert.equal(store.setPings(place, 'u1', 'on'), 'on');
  assert.equal(store.isPingsOff(place, 'u1'), false, 'on replaces off, it does not sit beside it');
  assert.equal(store.setPings(place, 'u1', null), null);
  assert.equal(store.getPings(place, 'u1'), null);
});

test('setPings: the state is per member and per place', () => {
  // Bug: one member's `on` is read for the whole place, or for the same account in another server.
  const store = createStore(memoryAt(tmpDataDir()));
  store.setPings(placeOfRoot(store, 'g1'), 'u1', 'on');
  assert.equal(store.getPings(placeOfRoot(store, 'g1'), 'u2'), null);
  assert.equal(store.getPings(placeOfRoot(store, 'g2'), 'u1'), null);
});

test('setPings: both states survive a flush and a reload', async () => {
  // Bug: `on` lives only in memory, and a restart sends every member back to the switch.
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.setPings(placeOfRoot(store, 'g1'), 'u1', 'on');
  store.setPings(placeOfRoot(store, 'g1'), 'u2', 'off');
  store.flush();
  await store.flushSettled({});
  const again = createStore({ dataDir: dir, memoryDb });
  assert.equal(again.getPings(placeOfRoot(again, 'g1'), 'u1'), 'on');
  assert.equal(again.getPings(placeOfRoot(again, 'g1'), 'u2'), 'off');
  assert.equal(again.getPings(placeOfRoot(again, 'g1'), 'u3'), null);
});

test('setPings: a change is written at once and survives dropped caches', async () => {
  // Bug: a member's own switch waits for the next flush, and a crash in between loses it.
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.setPings(placeOfRoot(store, 'g1'), 'u1', 'on');
  await settle();
  assert.match(readRaw(path.join(dir, 'guilds', 'g1', 'guild.json')), /"u1"/);
  store.dropCaches();
  assert.equal(store.getPings(placeOfRoot(store, 'g1'), 'u1'), 'on');
});

test('updatePlace from the analyzer never overwrites a ping state', () => {
  // Bug: the analyzer writes the place back whole and clears the members' own switches.
  const store = createStore(memoryAt(tmpDataDir()));
  const place = placeOfRoot(store, 'g1');
  store.setPings(place, 'u1', 'on');
  store.setPings(place, 'u2', 'off');
  store.updatePlace(place, { patterns: 'x', pingsOff: [], pings: {} });
  assert.equal(store.getPings(place, 'u1'), 'on');
  assert.equal(store.getPings(place, 'u2'), 'off');
});
