// Tests for the direct chat opened ahead (src/interface/dm-ahead.ts): for an account a memory pass came across, the
// core asks the interface for the direct chat once and stores it as a place of kind `dm`, only while direct chats are
// open, off the command line, with no live direct chat stored and with the reply gate passing. A refusing interface
// stores nothing and is not asked again by the same function. A real memory database, the fake adapter through the
// core's reads, synthetic names.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { createDmAhead } from '../src/interface/dm-ahead.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { notOk } from '../src/interface/port.ts';
import { createReads } from '../src/interface/reads.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { addDm, addPerson } from './fixtures/memory-db/mind-world.ts';

const quiet = { info() {}, warn() {}, error() {} };
const T0 = Date.parse('2026-11-17T10:00:00Z');
const NATIVE = 'u7';
const OPENED = 'dm-u7';

const opened: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const { close } of opened) await close();
});

type Setup = { score?: number; dmEnabled?: boolean; existingDm?: boolean };

function makeRig({ score = 20, dmEnabled = true, existingDm = false }: Setup = {}) {
  const memory = openTestMemorySync();
  opened.push(memory);
  const { memoryDb } = memory;
  const db = memoryDb.database();
  if (db === null) throw new Error('memory is closed');
  addPerson(db, { id: 'person:p7', accounts: [{ id: 'account:u7', iface: 'fake', native: NATIVE, names: ['Νίκη'] }] });
  if (existingDm) addDm(db, { iface: 'fake', native: NATIVE, person: 'person:p7', account: 'account:u7' });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self' });
  port.seedDmChat(NATIVE, OPENED);
  const hot = { config: { dm: { enabled: dmEnabled }, private: { minAffinity: 5 }, bot: { access: {} } } };
  const store = { getUser: (accountId: string) => (accountId === NATIVE ? { affinity: { score } } : null) };
  const dmAhead = createDmAhead({ hot, store, reads: createReads(port, quiet), memoryDb, now: () => T0 });
  const asked = () => port.calls.filter((call) => call.op === 'dmChatOf').length;
  const dmChats = () =>
    db
      .prepare("SELECT native_id FROM places WHERE kind = 'dm'")
      .all()
      .map((row) => row.native_id);
  return { dmAhead, port, asked, dmChats };
}

test('opens the direct chat of a person over the limit with none stored and stores it as a dm place', async () => {
  const rig = makeRig();
  await rig.dmAhead.open('fake', NATIVE);
  assert.equal(rig.asked(), 1);
  assert.deepEqual(rig.dmChats(), [OPENED]);
});

test('asks nothing for a person under the limit', async () => {
  const rig = makeRig({ score: 1 });
  await rig.dmAhead.open('fake', NATIVE);
  assert.equal(rig.asked(), 0);
  assert.deepEqual(rig.dmChats(), []);
});

test('asks nothing for a person whose direct chat is stored', async () => {
  const rig = makeRig({ existingDm: true });
  await rig.dmAhead.open('fake', NATIVE);
  assert.equal(rig.asked(), 0);
});

test('asks nothing while direct chats are closed', async () => {
  const rig = makeRig({ dmEnabled: false });
  await rig.dmAhead.open('fake', NATIVE);
  assert.equal(rig.asked(), 0);
});

test('asks nothing for an account of the command line', async () => {
  const rig = makeRig();
  await rig.dmAhead.open('cli', NATIVE);
  assert.equal(rig.asked(), 0);
});

test('stores nothing when the interface refuses and does not ask again for that account', async () => {
  const rig = makeRig();
  rig.port.failNext('dmChatOf', notOk('forbidden', 'http-403'));
  await rig.dmAhead.open('fake', NATIVE);
  await rig.dmAhead.open('fake', NATIVE);
  assert.equal(rig.asked(), 1);
  assert.deepEqual(rig.dmChats(), []);
});
