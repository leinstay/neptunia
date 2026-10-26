import test from 'node:test';
import assert from 'node:assert/strict';
import type { Adapter } from '../src/protocol/adapter.ts';
import { createReads } from '../src/interface/reads.ts';
import { createFakeAdapter } from '../src/interface/fake.js';

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

const REF = { iface: 'fake', conversationId: 'c1' };

function fakeWith(reads?: ReadonlyArray<string>) {
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self', ...(reads === undefined ? {} : { reads }) });
  fake.seedConversation({
    id: 'c1',
    kind: 'channel',
    communityId: 'g1',
    name: 'general',
    topic: null,
    category: null,
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
  const found = await reads.conversationInfo(REF);
  assert.equal(found?.conversation.id, 'c1');
  assert.equal('status' in (found ?? {}), false);
});

test('createReads gives null for a failed answer and logs it once for each read and code, with the code only', async () => {
  const { log, warnings } = logger();
  const reads = createReads(fakeWith(), log);
  assert.equal(await reads.conversationInfo({ iface: 'fake', conversationId: 'gone' }), null);
  assert.equal(await reads.conversationInfo({ iface: 'fake', conversationId: 'gone' }), null);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0]?.fields, { read: 'conversation.info', code: 'unknown-conversation' });
});

test('createReads makes no call for a read the adapter does not declare', async () => {
  const { log } = logger();
  const fake = fakeWith(['conversation.info']);
  const reads = createReads(fake, log);
  assert.equal(reads.offers('messages.history'), false);
  assert.equal(await reads.history(REF, { limit: 5 }), null);
  assert.equal(fake.calls.filter((call) => call.op === 'history').length, 0);
});

test('createReads gives null instead of throwing when the adapter throws', async () => {
  const { log, warnings } = logger();
  const broken = {
    capabilities: () => ({ operations: [], reads: ['conversation.info'] }),
    conversationInfo: () => Promise.reject(new TypeError('socket closed')),
  } as unknown as Adapter;
  const reads = createReads(broken, log);
  assert.equal(await reads.conversationInfo(REF), null);
  assert.deepEqual(warnings[0]?.fields, { read: 'conversation.info', code: 'TypeError' });
});
