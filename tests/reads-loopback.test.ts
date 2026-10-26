// The conversation reads of the adapter contract (src/protocol/adapter.ts), each one round-tripped over the link: the
// fake adapter served by serveAdapter on one end of the loopback, the core's link (src/interface/link.ts) on the other.
// A read answers `{ status: 'ok', ...body }` or a status and an error, never a throw. The fake keeps what a test seeds
// (`seedConversation`, `seedGroups`, `seedMember`, `seedEmoji`, `seedEvent`, `seedReactors`) and records each read in
// `calls` under its method name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback } from '../src/protocol/index.js';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { Hello } from '../src/protocol/serve.ts';
import type {
  Adapter,
  ConversationInfo,
  MemberInfo,
  MessageEvent,
  Permissions,
  ReadResult,
} from '../src/protocol/adapter.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import { createEventDoor } from '../src/interface/door.js';
import { createFakeAdapter } from '../src/interface/fake.js';

type Log = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

const quiet: Log = { info() {}, warn() {}, error() {} };
const SELF = { id: 'self-id', name: 'Νέπτυν' };
const COMMUNITY = { id: 'g1', name: 'Alpha' };
const GENERAL = { iface: 'fake', conversationId: 'c1' };
const ALL: Permissions = { read: true, send: true, attach: true, react: true };

function info(id: string, extra: Partial<ConversationInfo> = {}): ConversationInfo {
  return {
    id,
    kind: 'channel',
    communityId: 'g1',
    name: `room-${id}`,
    topic: null,
    category: null,
    iface: 'fake',
    permissions: ALL,
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    ...extra,
  };
}

function eventOf(conversation: ConversationInfo, id: string, at: number, text: string, authorId = 'u1'): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'fake',
    at,
    id: `fake:message:${id}`,
    conversation: { id: conversation.id, kind: conversation.kind, communityId: conversation.communityId },
    message: {
      id,
      author: { id: authorId, name: 'Eleni', self: authorId === SELF.id, bot: false },
      content: text,
      sourceText: text,
      system: false,
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

function member(id: string, name: string, extra: Partial<MemberInfo> = {}): MemberInfo {
  return { id, name, bot: false, groupIds: [], avatar: { hash: null, url: null, largeUrl: null }, ...extra };
}

// The body of an ok read, or a thrown error that names the answer.
function okBody<T extends object>(result: ReadResult<T>): T {
  if ('error' in result) throw new Error(`read did not answer ok: ${JSON.stringify(result)}`);
  return result;
}

async function rig(adapter: ReturnType<typeof createFakeAdapter> = createFakeAdapter()) {
  const door = createEventDoor({ handlers: {}, log: quiet });
  const { core, client } = createLoopback();
  const link = openAdapterLink({ transport: core, door, token: 'tok', log: quiet });
  const hello: Hello = {
    iface: 'fake',
    self: SELF,
    community: COMMUNITY,
    capabilities: adapter.capabilities(),
    resume: null,
  };
  serveAdapter({ transport: client, hello, token: 'tok', adapter, log: quiet });
  await link.hello;
  return { link, fake: adapter, reads: link.adapter };
}

test('answers a conversation with its permissions, owner and flags as seeded', async () => {
  const { reads, fake } = await rig();
  fake.seedConversation(
    info('c1', {
      permissions: { read: true, send: false, attach: false, react: true },
      lastMessageAt: 1700,
      voice: true,
      public: false,
    })
  );
  const { conversation } = okBody(await reads.conversationInfo(GENERAL));
  assert.equal(conversation.id, 'c1');
  assert.deepEqual(conversation.permissions, { read: true, send: false, attach: false, react: true });
  assert.equal(conversation.lastMessageAt, 1700);
  assert.equal(conversation.voice, true);
  assert.equal(conversation.public, false);
});

test('carries the owner of a conversation across the link, and null when it has none', async () => {
  const { reads, fake } = await rig();
  fake.seedConversation(info('c1', { owner: 'owner-1' }));
  fake.seedConversation(info('c2'));
  assert.equal(okBody(await reads.conversationInfo(GENERAL)).conversation.owner, 'owner-1');
  assert.equal(okBody(await reads.conversationInfo({ iface: 'fake', conversationId: 'c2' })).conversation.owner, null);
});

test('answers the audience as arrays and the viewers asked for, only when asked', async () => {
  const { reads, fake } = await rig();
  fake.seedConversation(
    info('c1', {
      audience: {
        everyone: false,
        groups: ['g-a', 'g-b'],
        groupAllow: ['g-a'],
        groupDeny: [],
        memberAllow: ['u7'],
        memberDeny: ['u8'],
        memberGroups: { u7: ['g-a'] },
      },
      viewers: { u1: true, u2: false },
    })
  );
  const asked = okBody(await reads.conversationInfo(GENERAL, { audience: true, viewers: ['u1', 'u2'] }));
  assert.deepEqual(asked.conversation.audience?.groups, ['g-a', 'g-b']);
  assert.deepEqual(asked.conversation.audience?.memberGroups, { u7: ['g-a'] });
  assert.deepEqual(asked.conversation.viewers, { u1: true, u2: false });
  const plain = okBody(await reads.conversationInfo(GENERAL));
  assert.equal(plain.conversation.audience, undefined);
  assert.equal(plain.conversation.viewers, undefined);
});

test('fails a conversation the adapter does not know with the code unknown-conversation', async () => {
  const { reads } = await rig();
  const result = await reads.conversationInfo({ iface: 'fake', conversationId: 'nowhere' });
  assert.equal(result.status, 'failed');
  assert.equal('error' in result ? result.error.code : null, 'unknown-conversation');
});

test('lists the conversations of one community with its groups, and none of another', async () => {
  const { reads, fake } = await rig();
  fake.seedConversation(info('c1'));
  fake.seedConversation(info('c2', { kind: 'thread', parentId: 'c1' }));
  fake.seedConversation(info('c3', { communityId: 'g2' }));
  fake.seedGroups('g1', [{ id: 'r1', name: 'mods' }]);
  const listing = okBody(await reads.conversations({ communityId: 'g1' }));
  assert.deepEqual(listing.conversations.map((entry) => entry.id).sort(), ['c1', 'c2']);
  assert.deepEqual(listing.groups, [{ id: 'r1', name: 'mods' }]);
});

test('lists the audience of each conversation when asked', async () => {
  const { reads, fake } = await rig();
  const audience = {
    everyone: true,
    groups: ['g-a'],
    groupAllow: [],
    groupDeny: [],
    memberAllow: [],
    memberDeny: [],
    memberGroups: {},
  };
  fake.seedConversation(info('c1', { audience }));
  const listing = okBody(await reads.conversations({ communityId: 'g1', audience: true }));
  assert.deepEqual(listing.conversations[0]?.audience?.groups, ['g-a']);
});

function seedLine(fake: ReturnType<typeof createFakeAdapter>, count: number): void {
  const conversation = info('c1');
  fake.seedConversation(conversation);
  for (let n = 1; n <= count; n += 1) fake.seedEvent(eventOf(conversation, `m${n}`, 1000 * n, `line ${n}`));
}

const idsOf = (events: ReadonlyArray<MessageEvent>): Array<string> => events.map((event) => event.message.id);

test('reads the newest lines oldest first and says the history is not complete when more exist', async () => {
  const { reads, fake } = await rig();
  seedLine(fake, 5);
  const page = okBody(await reads.history(GENERAL, { limit: 3 }));
  assert.deepEqual(idsOf(page.events), ['m3', 'm4', 'm5']);
  assert.equal(page.complete, false);
});

test('says the history is complete when the limit reaches past the first line', async () => {
  const { reads, fake } = await rig();
  seedLine(fake, 5);
  const page = okBody(await reads.history(GENERAL, { limit: 10 }));
  assert.deepEqual(idsOf(page.events), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(page.complete, true);
});

test('reads the lines before a message, after a message and around one', async () => {
  const { reads, fake } = await rig();
  seedLine(fake, 7);
  const before = okBody(await reads.history(GENERAL, { limit: 2, before: 'm5' }));
  assert.deepEqual(idsOf(before.events), ['m3', 'm4']);
  const after = okBody(await reads.history(GENERAL, { limit: 2, after: 'm5' }));
  assert.deepEqual(idsOf(after.events), ['m6', 'm7']);
  const around = okBody(await reads.history(GENERAL, { limit: 3, around: 'm4' }));
  assert.deepEqual(idsOf(around.events), ['m3', 'm4', 'm5']);
});

test('reads only the lines at or after the since floor', async () => {
  const { reads, fake } = await rig();
  seedLine(fake, 5);
  const page = okBody(await reads.history(GENERAL, { limit: 10, since: 3000 }));
  assert.deepEqual(idsOf(page.events), ['m3', 'm4', 'm5']);
});

test('returns a message fetched by id with its whole event, and marks a gone one missing', async () => {
  const { reads, fake } = await rig();
  seedLine(fake, 2);
  const fetched = okBody(await reads.fetchMessages(GENERAL, ['m2', 'gone']));
  const [found, gone] = fetched.messages;
  assert.equal(found?.event?.message.content, 'line 2');
  assert.equal(found?.event?.conversation.id, 'c1');
  assert.equal(gone?.missing, true);
});

test('answers a member with groups and the large avatar, and null for someone who is not a member', async () => {
  const { reads, fake } = await rig();
  fake.seedMember(
    'g1',
    member('u1', 'Eleni', {
      groupIds: ['r1'],
      avatar: { hash: 'h', url: 'https://x/s.png', largeUrl: 'https://x/l.png' },
    })
  );
  const found = okBody(await reads.memberInfo({ communityId: 'g1', memberId: 'u1' }));
  assert.deepEqual(found.member?.groupIds, ['r1']);
  assert.equal(found.member?.avatar.largeUrl, 'https://x/l.png');
  const stranger = okBody(await reads.memberInfo({ communityId: 'g1', memberId: 'u9' }));
  assert.equal(stranger.member, null);
});

test('finds messages by a case-insensitive piece of text and counts all of them', async () => {
  const { reads, fake } = await rig();
  const conversation = info('c1');
  fake.seedConversation(conversation);
  fake.seedEvent(eventOf(conversation, 'm1', 1000, 'Pasta tonight'));
  fake.seedEvent(eventOf(conversation, 'm2', 2000, 'nothing here'));
  fake.seedEvent(eventOf(conversation, 'm3', 3000, 'more PASTA'));
  const found = okBody(await reads.searchMessages({ communityId: 'g1' }, { text: 'pasta' }));
  assert.equal(found.total, 2);
  assert.deepEqual(found.hits.map((hit) => hit.ref.messageId).sort(), ['m1', 'm3']);
});

test('narrows a message search to one author and to a time window', async () => {
  const { reads, fake } = await rig();
  const conversation = info('c1');
  fake.seedConversation(conversation);
  fake.seedEvent(eventOf(conversation, 'm1', 1000, 'hello', 'u1'));
  fake.seedEvent(eventOf(conversation, 'm2', 2000, 'hello', 'u2'));
  fake.seedEvent(eventOf(conversation, 'm3', 3000, 'hello', 'u2'));
  const byAuthor = okBody(await reads.searchMessages({ communityId: 'g1' }, { text: 'hello', authorId: 'u2' }));
  assert.deepEqual(byAuthor.hits.map((hit) => hit.ref.messageId).sort(), ['m2', 'm3']);
  const windowed = okBody(
    await reads.searchMessages({ communityId: 'g1' }, { text: 'hello', after: 1500, before: 2500 })
  );
  assert.deepEqual(
    windowed.hits.map((hit) => hit.ref.messageId),
    ['m2']
  );
});

test('finds members by the start of a name, at most the limit', async () => {
  const { reads, fake } = await rig();
  fake.seedMember('g1', member('u1', 'Eleni'));
  fake.seedMember('g1', member('u2', 'Elpida'));
  fake.seedMember('g1', member('u3', 'Dora'));
  const found = okBody(await reads.searchMembers({ communityId: 'g1' }, { prefix: 'el', limit: 1 }));
  assert.equal(found.members.length, 1);
  assert.equal(found.members[0]?.displayName?.toLowerCase().startsWith('el'), true);
});

test('lists the custom emoji of a community', async () => {
  const { reads, fake } = await rig();
  fake.seedEmoji('g1', [{ id: 'e1', name: 'kek', animated: false, url: 'https://x/e1.png' }]);
  const listing = okBody(await reads.emoji({ communityId: 'g1' }));
  assert.deepEqual(listing.emoji, [{ id: 'e1', name: 'kek', animated: false, url: 'https://x/e1.png' }]);
});

test('turns the message addresses of the fake into references and everything else into null', async () => {
  const { reads } = await rig();
  const inCommunity = 'https://discord.com/channels/g1/c1/m1';
  const direct = 'https://discord.com/channels/@me/d1/m2';
  const parsed = okBody(await reads.parseLinks([inCommunity, direct, 'https://example.com/x', 'no link here']));
  assert.deepEqual(parsed.refs, [
    { iface: 'fake', conversationId: 'c1', messageId: 'm1' },
    { iface: 'fake', conversationId: 'd1', messageId: 'm2' },
    null,
    null,
  ]);
});

test('lists the members who put an emoji on a message, at most the limit', async () => {
  const { reads, fake } = await rig();
  const ref = { iface: 'fake', conversationId: 'c1', messageId: 'm1' };
  fake.seedReactors(ref, '🔥', ['u1', 'u2', 'u3']);
  const listed = okBody(await reads.reactors(ref, '🔥', 2));
  assert.deepEqual(listed.memberIds, ['u1', 'u2']);
});

test('answers failed with the queued error once and the real answer after it', async () => {
  const { reads, fake } = await rig();
  seedLine(fake, 1);
  fake.failNext('history', { status: 'failed', error: { code: 'http-500', retryable: true } });
  const first = await reads.history(GENERAL, { limit: 5 });
  assert.equal(first.status, 'failed');
  assert.equal('error' in first ? first.error.code : null, 'http-500');
  assert.deepEqual(idsOf(okBody(await reads.history(GENERAL, { limit: 5 })).events), ['m1']);
});

test('answers unsupported for a read the fake does not offer and lists the ones it does', async () => {
  const fake = createFakeAdapter({ reads: ['conversation.info'] });
  const { reads } = await rig(fake);
  fake.seedConversation(info('c1'));
  assert.deepEqual(fake.capabilities().reads, ['conversation.info']);
  assert.equal((await reads.history(GENERAL, { limit: 1 })).status, 'unsupported');
  assert.equal((await reads.conversationInfo(GENERAL)).status, 'ok');
});

test('answers failed with adapter-threw when the adapter throws in a read', async () => {
  const base = createFakeAdapter();
  const throwing: Adapter = {
    ...base,
    history: (): Promise<never> => {
      throw new Error('boom');
    },
  };
  const { reads } = await rig(throwing as ReturnType<typeof createFakeAdapter>);
  const result = await reads.history(GENERAL, { limit: 1 });
  assert.equal(result.status, 'failed');
  assert.equal('error' in result ? result.error.code : null, 'adapter-threw');
});

test('answers failed with link-closed for a read made after the link closed', async () => {
  const { link, reads } = await rig();
  link.close();
  const result = await reads.history(GENERAL, { limit: 1 });
  assert.equal(result.status, 'failed');
  assert.equal('error' in result ? result.error.code : null, 'link-closed');
});
