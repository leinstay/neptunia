// src/interface/reads.ts: the reads of an interface through its adapter, the null of a failed or undeclared read, and
// `createReads.answer`, which keeps the code a plain read turns into null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Adapter } from '../../../src/protocol/adapter.ts';
import { createReads } from '../../../src/interface/reads.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { notOk } from '../../../src/interface/port.ts';
import { channelInfo, deliver, until, withFakeCore } from '../../fixtures/core-over-fake.ts';
import type { Fake } from '../../fixtures/core-over-fake.ts';

type Warning = { message: string; fields: unknown };

function logger() {
  const warnings: Array<Warning> = [];
  return {
    warnings,
    log: {
      info() {},
      warn: (message: string, fields?: unknown) => void warnings.push({ message, fields }),
      error() {},
    },
  };
}

const REF = { iface: 'fake', chatId: 'c1' };

function fakeWith(reads?: ReadonlyArray<string>) {
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self', ...(reads === undefined ? {} : { reads }) });
  fake.seedChat({
    id: 'c1',
    kind: 'channel',
    rootId: 'g1',
    name: 'general',
    topic: null,
    chatType: 'channel',
    iface: 'fake',
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: null,
  });
  return fake;
}

test('createReads gives the body of an ok answer without its status', async () => {
  const { log } = logger();
  const reads = createReads(fakeWith(), log);
  const found = await reads.chatInfo(REF);
  assert.equal(found?.chat.id, 'c1');
  assert.equal('status' in (found ?? {}), false);
});

test('createReads gives null for a failed answer and logs it once for each read and code, with the code only', async () => {
  const { log, warnings } = logger();
  const reads = createReads(fakeWith(), log);
  assert.equal(await reads.chatInfo({ iface: 'fake', chatId: 'gone' }), null);
  assert.equal(await reads.chatInfo({ iface: 'fake', chatId: 'gone' }), null);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0]?.fields, { read: 'chat.info', code: 'unknown-conversation' });
});

test('createReads makes no call for a read the adapter does not declare', async () => {
  const { log } = logger();
  const fake = fakeWith(['chat.info']);
  const reads = createReads(fake, log);
  assert.equal(reads.offers('messages.history'), false);
  assert.equal(await reads.history(REF, { limit: 5 }), null);
  assert.equal(fake.calls.filter((call) => call.op === 'history').length, 0);
});

test('createReads gives null instead of throwing when the adapter throws', async () => {
  const { log, warnings } = logger();
  const broken = {
    capabilities: () => ({ operations: [], reads: ['chat.info'] }),
    chatInfo: () => Promise.reject(new TypeError('socket closed')),
  } as unknown as Adapter;
  const reads = createReads(broken, log);
  assert.equal(await reads.chatInfo(REF), null);
  assert.deepEqual(warnings[0]?.fields, { read: 'chat.info', code: 'TypeError' });
});

test('the invite read answers the link the interface declares, and not-offered when it declares none', async () => {
  // Catches: `/interfaces invite` getting null for a working link, or asking an interface that has no invite read.
  const { log } = logger();
  const offering = createReads(
    createFakeAdapter({ iface: 'fake', selfId: 'self', invite: 'https://chat.invalid/i' }),
    log
  );
  assert.deepEqual(await offering.answer('inviteLink', { iface: 'fake' }), {
    status: 'ok',
    url: 'https://chat.invalid/i',
  });
  const silent = createReads(fakeWith(['chat.info']), log);
  const refused = await silent.answer('inviteLink', { iface: 'fake' });
  assert.deepEqual(refused, { status: 'unsupported', code: 'not-offered' });
});

const PARTNER = { iface: 'discord', accountId: 'u1' };

const quiet = { info() {}, warn() {}, error() {} };

test('answer keeps the code and the plain read stays null', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  const reads = createReads(fake, quiet);
  fake.failNext('dmChatOf', notOk('forbidden', 'http-403'));
  const refused = await reads.answer('dmChatOf', PARTNER);
  assert.deepEqual([refused.status, refused.status !== 'ok' && refused.code], ['forbidden', 'http-403']);
  fake.failNext('dmChatOf', notOk('forbidden', 'http-403'));
  assert.equal(await reads.dmChatOf(PARTNER), null);
});

test('answer tells whether a failure is worth another try', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  const reads = createReads(fake, quiet);
  fake.failNext('dmChatOf', notOk('failed', 'http-500', { retryable: true }));
  const failed = await reads.answer('dmChatOf', PARTNER);
  assert.equal(failed.status !== 'ok' && failed.retryable, true);
});

test('answer gives the status and the body of an ok read', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  fake.seedDmChat('u1', 'dm-1');
  assert.deepEqual(await createReads(fake, quiet).answer('dmChatOf', PARTNER), {
    status: 'ok',
    chatId: 'dm-1',
  });
});

test('answer says unsupported of a read the interface does not declare, with no round trip', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self', reads: [] });
  const answer = await createReads(fake, quiet).answer('dmChatOf', PARTNER);
  assert.equal(answer.status, 'unsupported');
  assert.equal(
    fake.calls.some((call) => call.op === 'dmChatOf'),
    false
  );
});

const NOW = Date.now();
const NEEDED = ['chat.info', 'messages.history', 'messages.fetch'];
const CONFIG = {
  context: { neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8, pull: { sameAudience: false } },
  features: { channelPull: true },
};

function seed(fake: Fake): void {
  fake.seedChat(channelInfo('c1', { name: 'general', lastMessageAt: NOW - 1000 }));
  fake.seedChat(channelInfo('c2', { name: 'garden', lastMessageAt: NOW - 120_000 }));
  deliver(fake, { id: 'g1', chatId: 'c2', text: 'tomatoes are ripe', at: NOW - 120_000, authorId: 'u2' });
}

async function turnWith(reads: ReadonlyArray<string> | undefined) {
  return withFakeCore({ config: CONFIG, ...(reads === undefined ? {} : { reads }), seed }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    const fakeCalls = rig.fake.calls;
    return { request: rig.requestText(0), ops: fakeCalls.map((call) => call.op) };
  });
}

// Slice 4: "shows the other channels block when the interface offers the chats read" left this file. A reply
// on the frame shows no `<other_channels>` and no `<channel_view>` whatever the interface offers, and only a routed or
// noticed turn keeps them, which no caller in src/ starts through the core.

test('makes no call of a read the interface did not declare', async () => {
  const { result } = await turnWith(NEEDED);
  const asked = ['chats', 'emoji', 'parseLinks', 'reactors', 'memberInfo'];
  assert.deepEqual(
    result.ops.filter((op) => asked.includes(op)),
    []
  );
});

test('still answers when the interface offers only the reads a turn cannot run without', async () => {
  const { result } = await turnWith(NEEDED);
  assert.equal(result.ops.includes('send'), true);
});

function seedGeneral(fake: Fake): void {
  fake.seedChat(channelInfo('c1', { name: 'general' }));
  deliver(fake, {
    id: 'm0',
    text: 'earlier talk about gardening',
    at: NOW - 60_000,
    authorId: 'u2',
    authorName: 'Zoe',
  });
}

test('shows the lines the history read returned in the request', async () => {
  await withFakeCore({ seed: seedGeneral }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello there', at: NOW - 1000, mention: true }));
    await until(() => rig.requests.length > 0);
    assert.equal(rig.requestText(0).includes('earlier talk about gardening'), true);
    const fakeCalls = rig.fake.calls;
    assert.equal(
      fakeCalls.some((call) => call.op === 'history'),
      true
    );
  });
});

test('reads the chat with its audience and the speaker as the one viewer who must see it', async () => {
  await withFakeCore({ seed: seedGeneral }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello there', at: NOW - 1000, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    const fakeCalls = rig.fake.calls;
    const infoCalls = fakeCalls.filter((call) => call.op === 'chatInfo');
    assert.equal(infoCalls.length > 0, true);
    const firstInfo = infoCalls[0];
    assert.deepEqual(firstInfo?.args[0], { iface: 'fake', chatId: 'c1' });
    assert.deepEqual(firstInfo?.args[1], { audience: true, viewers: [] });
  });
});
