import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationInfo, MessageEvent } from '../src/protocol/adapter.ts';
import { createFakeAdapter } from '../src/interface/fake.js';

function info(id: string, over: Partial<ConversationInfo> = {}): ConversationInfo {
  return {
    id,
    kind: 'channel',
    communityId: 'g1',
    name: id,
    topic: null,
    category: null,
    chatType: 'channel',
    iface: 'fake',
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: {
      everyone: true,
      groups: [],
      groupAllow: [],
      groupDeny: [],
      memberAllow: [],
      memberDeny: [],
      memberGroups: {},
    },
    ...over,
  };
}

function eventAt(id: string, at: number, conversationId = 'c1'): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'fake',
    at,
    id: `fake:message:${id}`,
    conversation: { id: conversationId, kind: 'channel', communityId: 'g1', name: conversationId },
    message: {
      id,
      author: { id: 'u1', name: 'Alice', self: false, bot: false },
      content: `text ${id}`,
      at,
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] },
  };
}

const REF = { iface: 'fake', conversationId: 'c1' };

function chat() {
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self' });
  fake.seedConversation(info('c1'));
  for (const [id, at] of [
    ['m1', 1000],
    ['m2', 2000],
    ['m3', 3000],
    ['m4', 4000],
    ['m5', 5000],
  ] as const)
    fake.seedEvent(eventAt(id, at));
  return fake;
}

async function ids(
  read: ReturnType<typeof chat>['history'] extends (...args: infer A) => infer R ? Promise<Awaited<R>> : never
) {
  const answer = await read;
  return answer.status === 'ok' ? answer.events.map((event) => event.message.id) : answer.status;
}

test('history gives the newest messages oldest first and says whether it reached the start', async () => {
  const fake = chat();
  assert.deepEqual(await ids(fake.history(REF, { limit: 2 })), ['m4', 'm5']);
  const all = await fake.history(REF, { limit: 10 });
  assert.equal(all.status === 'ok' && all.complete, true);
  const some = await fake.history(REF, { limit: 2 });
  assert.equal(some.status === 'ok' && some.complete, false);
});

test('history reads before, after and around a message and since a time', async () => {
  const fake = chat();
  assert.deepEqual(await ids(fake.history(REF, { limit: 2, before: 'm4' })), ['m2', 'm3']);
  assert.deepEqual(await ids(fake.history(REF, { limit: 2, after: 'm2' })), ['m3', 'm4']);
  assert.deepEqual(await ids(fake.history(REF, { limit: 3, around: 'm3' })), ['m2', 'm3', 'm4']);
  assert.deepEqual(await ids(fake.history(REF, { limit: 10, since: 3500 })), ['m4', 'm5']);
});

test('history fails for a message it does not hold as an anchor and for a conversation it does not know', async () => {
  const fake = chat();
  const lost = await fake.history(REF, { limit: 2, before: 'nope' });
  assert.equal(lost.status, 'failed');
  const unknown = await fake.history({ iface: 'fake', conversationId: 'c9' }, { limit: 2 });
  assert.equal(unknown.status === 'failed' && unknown.error.code, 'unknown-conversation');
});

test('a read answers a queued failure in place of the answer and the next one as usual', async () => {
  const fake = chat();
  fake.failNext('history', { status: 'failed', error: { code: 'http-500', retryable: true, retryAfterMs: null } });
  const first = await fake.history(REF, { limit: 1 });
  assert.equal(first.status === 'failed' && first.error.code, 'http-500');
  assert.deepEqual(await ids(fake.history(REF, { limit: 1 })), ['m5']);
});

test('a read the fake does not declare answers unsupported and a malformed one fails as an invalid action', async () => {
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self', reads: ['conversation.info'] });
  fake.seedConversation(info('c1'));
  assert.equal((await fake.history(REF, { limit: 1 })).status, 'unsupported');
  assert.equal((await fake.conversationInfo(REF)).status, 'ok');
  const malformed = await fake.conversationInfo({ iface: 'fake', conversationId: '' });
  assert.equal(malformed.status, 'failed');
});

test('conversationInfo gives the audience and the viewers only when asked for them', async () => {
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self' });
  fake.seedConversation(info('c1', { viewers: { u1: false } }));
  const bare = await fake.conversationInfo(REF);
  assert.equal(bare.status === 'ok' && bare.conversation.audience, undefined);
  const asked = await fake.conversationInfo(REF, { audience: true, viewers: ['u1', 'u2'] });
  assert.equal(asked.status === 'ok' && asked.conversation.audience?.everyone, true);
  assert.deepEqual(asked.status === 'ok' && asked.conversation.viewers, { u1: false, u2: true });
});

test('the persona own sends stay out of the history unless the fake is told to show them', async () => {
  const fake = chat();
  fake.showSendsInHistory(false);
  await fake.send(REF, { text: 'hello' });
  assert.deepEqual(await ids(fake.history(REF, { limit: 10 })), ['m1', 'm2', 'm3', 'm4', 'm5']);
  fake.showSendsInHistory(true);
  const shown = await fake.history(REF, { limit: 10 });
  assert.equal(shown.status === 'ok' && shown.events.length, 6);
});

test('fetchMessages gives a seeded message with its event and marks an unknown one missing', async () => {
  const fake = chat();
  const found = await fake.fetchMessages(REF, ['m2', 'zz']);
  assert.equal(found.status, 'ok');
  if (found.status !== 'ok') return;
  assert.equal(found.messages[0]?.text, 'text m2');
  assert.equal(found.messages[0]?.event?.message.id, 'm2');
  assert.equal(found.messages[1]?.missing, true);
});

test('reactors gives at most the limit of the members seeded for an emoji and fails for an emoji nobody used', async () => {
  const fake = chat();
  fake.seedReactors({ ...REF, messageId: 'm1' }, '🔥', ['u1', 'u2', 'u3']);
  const some = await fake.reactors({ ...REF, messageId: 'm1' }, '🔥', 2);
  assert.deepEqual(some.status === 'ok' && some.memberIds, ['u1', 'u2']);
  const none = await fake.reactors({ ...REF, messageId: 'm1' }, '👍', 2);
  assert.equal(none.status, 'failed');
});
