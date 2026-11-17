// Tests for a post or an intention aimed at a person (src/tools/operations/person-chat.ts): `message.create` and
// `intention.set` take `person` in place of a place, and the person resolves to their direct chat. A person with no
// direct chat stored has it opened through the interface's `dm.chat` read and stored as a place; a person memory holds
// nothing about, one she does not answer in private, one with no account she can write to, and closed direct chats are
// refused before anything is stored or sent. The operations run through `runOp` over a real memory database, a real
// intention service and the fake interface of the test's world. Synthetic data only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { runOp } from '../src/tools/operations/index.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { placeRefOf } from '../src/memory/db/frame-reads.ts';
import { handleOfPerson } from '../src/memory/db/direct-chats.ts';
import { notOk } from '../src/protocol/actions.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { useIface, world } from './fixtures/turn-world.ts';
import { tempDir } from './fixtures/tmp.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { addClaim, addDm, addPerson } from './fixtures/memory-db/mind-world.ts';
import { OWNER_PERSON } from './fixtures/owner-accounts.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { noMediaNames } from './fixtures/media-namer.ts';

useIface('fake');
const T0 = Date.parse('2026-11-11T10:00:00Z');
const HERE = 'c1';
/** A person memory knows, their account on the fake interface, and the chat the interface opens with them. */
const KNOWN = 'person:known';
const NATIVE = 'u7';
const OPENED = 'dm-u7';

const opened: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const { close } of opened) await close();
});

type Setup = { known?: boolean; score?: number; dmEnabled?: boolean; existingDm?: string; iface?: string };

function makeEnv({ known = true, score = 20, dmEnabled = true, existingDm, iface = 'fake' }: Setup = {}) {
  const rootDir = tempDir('nep-person-chat-');
  const memory = openTestMemorySync({ dataDir: path.join(rootDir, 'data') });
  opened.push(memory);
  const { memoryDb } = memory;
  const db = memoryDb.database();
  if (db === null) throw new Error('memory is closed');
  addPerson(db, { id: KNOWN, accounts: [{ id: `account:${NATIVE}`, iface, native: NATIVE, names: ['Νίκη'] }] });
  if (known)
    addClaim(db, { id: 'claim:1', person: KNOWN, kind: 'fact', text: 'draws maps', audience: { group: 'fake' } });
  if (existingDm !== undefined)
    addDm(db, { iface: 'fake', native: existingDm, person: KNOWN, account: `account:${NATIVE}` });
  const w = world();
  const chats = [w.channel({ id: HERE }), w.channel({ id: OPENED, dm: true, partnerId: NATIVE })];
  if (existingDm !== undefined) chats.push(w.channel({ id: existingDm, dm: true, partnerId: NATIVE }));
  w.port.seedDmChat(NATIVE, OPENED);
  const hot = {
    config: {
      bot: { ownerPerson: OWNER_PERSON, access: {}, timezone: 'UTC' },
      features: { intentions: true },
      intentions: { expiresDays: 14, maxOpen: 20 },
      dm: { enabled: dmEnabled },
      private: { minAffinity: 5 },
    },
    prompts: { labels: {} },
    rootDir,
    reloadConfig: () => true,
  };
  const store = {
    state: { data: {}, markDirty() {} },
    getUser: (accountId: string) => (accountId === NATIVE ? { names: ['Νίκη'], affinity: { score } } : null),
    placeRefOf: (placeId: string) => placeRefOf(db, placeId),
    notePlaceAddress: (placeId: string, address: string) =>
      memoryDb.memoryWrite({ kind: 'place-address', placeId, address, at: new Date(T0).toISOString() }),
  };
  const now = () => T0;
  const intentions = createIntentionService({
    stores: createIntentionStores({ memoryDb, now }),
    hot,
    errands: wrongly(null),
    now,
  });
  const env = createOpsEnv({
    mediaNameOf: noMediaNames,
    discord: createDiscordInterface().capabilities,
    hot,
    store,
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    reads: w.reads,
    port: w.port,
    memoryDb,
    intentions,
    now,
  });
  const dmPlaces = () =>
    db
      .prepare("SELECT id, native_id FROM places WHERE kind = 'dm' ORDER BY id")
      .all()
      .map((row) => ({ id: String(row.id), chat: String(row.native_id) }));
  const sentTo = () => chats.flatMap((chat) => chat.sent.map(() => chat.info.id));
  return { env, intentions, dmPlaces, sentTo, port: w.port };
}

const hers = (env: unknown) => ({
  env,
  placeId: HERE,
  accountId: 'someone',
  roleIds: [],
  actor: 'persona',
  turnId: 'T1',
  sourceMessageId: 'm1',
});

const PERSON = handleOfPerson(KNOWN);

test('message.create to a known person with no direct chat opens it, posts there and stores the place', async () => {
  const { env, dmPlaces, sentTo } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp('message.create', { person: PERSON, text: 'γεια' }, wrongly(hers(env)));
    assert.notEqual(result.status, 'failed', result.summary);
    assert.notEqual(result.status, 'denied', result.summary);
    assert.deepEqual(sentTo(), [OPENED]);
    assert.deepEqual(
      dmPlaces().map((one) => one.chat),
      [OPENED]
    );
  });
});

test('message.create to a person with a stored direct chat posts there and stores no new place', async () => {
  const { env, dmPlaces, sentTo } = makeEnv({ existingDm: 'dm-old' });
  await withCapturedLogs(async () => {
    const result = await runOp('message.create', { person: PERSON, text: 'γεια' }, wrongly(hers(env)));
    assert.notEqual(result.status, 'failed', result.summary);
    assert.deepEqual(sentTo(), ['dm-old']);
    assert.equal(dmPlaces().length, 1);
  });
});

test('intention.set aimed at a known person stores the direct chat with them as its destination', async () => {
  const { env, intentions, dmPlaces } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'intention.set',
      { text: 'ask how the map goes', due: '1h', person: PERSON },
      wrongly(hers(env))
    );
    assert.equal(result.status, 'ok', result.summary);
    const places = dmPlaces();
    assert.equal(places.length, 1);
    assert.deepEqual(
      intentions.list({ closed: true, all: true }).map((record) => record.destination),
      [places[0]?.id]
    );
  });
});

/** A refused post: its code, and nothing stored or sent. */
async function assertRefusedPost(setup: Setup, code: string, args: Record<string, unknown> = { person: PERSON }) {
  const { env, dmPlaces, sentTo } = makeEnv(setup);
  await withCapturedLogs(async () => {
    const result = await runOp('message.create', { text: 'γεια', ...args }, wrongly(hers(env)));
    assert.equal(result.code, code, result.summary);
    assert.deepEqual(sentTo(), []);
    assert.deepEqual(dmPlaces(), []);
  });
}

test('message.create refuses a person memory holds nothing about with unknown-member', async () => {
  await assertRefusedPost({ known: false }, 'unknown-member');
});

test('message.create refuses a person she does not answer in private with attitude-low', async () => {
  await assertRefusedPost({ score: 1 }, 'attitude-low');
});

test('message.create to a person refuses with dm-disabled while direct chats are closed', async () => {
  await assertRefusedPost({ dmEnabled: false }, 'dm-disabled');
});

test('message.create refuses a person whose only account is the command line with no-dm-account', async () => {
  await assertRefusedPost({ iface: 'cli' }, 'no-dm-account');
});

test('message.create refuses a place and a person together with invalid-args', async () => {
  await assertRefusedPost({}, 'invalid-args', { person: PERSON, placeId: HERE });
});

test('message.create fails with dm-unopened and stores nothing when the interface cannot open the chat', async () => {
  const { env, dmPlaces, sentTo, port } = makeEnv();
  port.failNext('dmChatOf', notOk('forbidden', 'http-403'));
  await withCapturedLogs(async () => {
    const result = await runOp('message.create', { person: PERSON, text: 'γεια' }, wrongly(hers(env)));
    assert.equal(result.code, 'dm-unopened', result.summary);
    assert.deepEqual(sentTo(), []);
    assert.deepEqual(dmPlaces(), []);
  });
});

test('intention.set refuses a person she does not answer in private and stores no intention', async () => {
  const { env, intentions, dmPlaces } = makeEnv({ score: 1 });
  await withCapturedLogs(async () => {
    const result = await runOp('intention.set', { text: 'ask', due: '1h', person: PERSON }, wrongly(hers(env)));
    assert.equal(result.code, 'attitude-low', result.summary);
    assert.deepEqual(intentions.list({ closed: true, all: true }), []);
    assert.deepEqual(dmPlaces(), []);
  });
});
