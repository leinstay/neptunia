import test from 'node:test';
import assert from 'node:assert/strict';
import type { Adapter } from '../src/protocol/adapter.ts';
import { createReads } from '../src/interface/reads.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';

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
  assert.equal(refused.status, 'unsupported');
  assert.equal(refused.status !== 'ok' && refused.code, 'not-offered');
});
