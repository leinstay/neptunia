// The fake interface adapter (scripts/lib/fake.ts) as the core and its tests use it: deliveries, reads over a loopback
// transport and the shape of the interface contract.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createTurnRunner, fakeStore, hotWith, sequenceLlm } from '../../fixtures/turn-harness.ts';
import { START, replyTo } from '../../fixtures/boundary.ts';
import type { createStore } from '../../../src/memory/store.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { table, wrongly, present } from '../../fixtures/loose-types.ts';
import { createLoopback } from '../../fixtures/loopback.ts';
import { serveAdapter } from '../../../src/protocol/serve.ts';
import type { Hello } from '../../../src/protocol/serve.ts';
import type { ChatInfo, MemberInfo, MessageEvent, Permissions, ReadResult } from '../../../src/protocol/adapter.ts';
import { openAdapterLink } from '../../../src/interface/link.ts';
import { createEventDoor } from '../../../src/interface/door.ts';

// The fakes hold only the part of the real object that the code under test reads, so each is cast once, here.
const fakeOf = <T>(value: object): T => value as T;

/**
 * The real turn runner over `port`, with a scripted `llm` and no Discord client.
 */
function runnerOver({
  port,
  hot,
  llm,
  store = fakeStore(),
}: {
  port: ReturnType<typeof createFakeAdapter>;
  hot: ReturnType<typeof hotWith>;
  llm: { complete: (messages: never, options: never) => Promise<unknown> };
  store?: ReturnType<typeof fakeStore> | ReturnType<typeof createStore>;
}) {
  const calibrator = { ratio: 1, apply: (value: number) => value, observe: () => {} };
  // The runner's declared parameters ask for more than a test passes (a describer, a fetch), and the fakes are narrower
  // than the real client and port, so the whole argument is cast.
  return createTurnRunner(
    fakeOf<Parameters<typeof createTurnRunner>[0]>({
      hot,
      store,
      llm,
      calibrator,
      now: () => START,
      port,
      skills: skillRegistry(),
      journal: null,
    })
  );
}

describe('a delivery that changes no character', () => {
  // The persona's text as generated: Greek, emoji, an em dash, spaces before a line break and a line break.
  const BLOCK = 'Καλημέρα κόσμε \u2014 ώρα για καφέ \u2615\u{1F31E}  \nδεύτερη γραμμή με κενά  \nτρίτη';
  const GENERATED = `${BLOCK}\n${BLOCK}\n${BLOCK}`;

  /** One reply turn whose model answer is `<msg>` + `text`, on a fake interface with `capabilities`; the port after it. */
  async function runDelivery(text: string, capabilities: object = {}) {
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => START, capabilities });
    // format.stripDashes is the one character swap the core makes; this test is about the delivery, so it is off.
    const hot = hotWith({ config: { format: { stripDashes: false } } });
    const turns = runnerOver({ port, hot, llm: sequenceLlm([`<msg>${text}</msg>`]) });
    port.seed('c1', { authorId: 'u1', messageId: 'm1', text: 'hey' });
    await replyTo(turns, [], { id: 'm1', content: 'hey', at: START });
    return port;
  }

  test('the fake interface stores what it is sent byte for byte', async () => {
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => START });
    const text = `${GENERATED}   \n `;
    const sent = await port.send({ iface: 'fake', chatId: 'c1' }, { text });
    const fetched = await port.fetchMessages({ iface: 'fake', chatId: 'c1' }, [sent.ref?.messageId ?? '']);
    const [stored] = fetched.status === 'ok' ? fetched.messages : [];
    assert.equal(stored?.text, text);
  });

  // One `send` call posts several parts when the text outgrows the interface, so counting calls says nothing.
  // The test reads the parts the interface stored: the persona's messages of the chat, in the order they landed.
  test('a text longer than the interface limit arrives as parts that join to the original', async () => {
    const limit = 60;
    const port = await runDelivery(GENERATED, { maxChars: limit });
    const parts = port
      .messagesIn('c1')
      .filter((message) => (message as { authorId: string }).authorId === 'self-id')
      .map((message) => (message as { text: string }).text);
    assert.ok(parts.length > 1, 'the text needed splitting');
    assert.ok(parts.every((part) => Array.from(part).length <= limit));
    assert.equal(parts.join(''), GENERATED);
  });
});

/** No typing lease: the tests of the port contract ask for a typing indicator without naming how long. */
const noLease = wrongly<{ untilMs: number }>(undefined);

const SELF = 'self-id';

const OTHER = 'other-id';

const ROOM = 'c1';

// ---------------------------------------------------------------------------
// Harnesses: `make(options)` -> { port, foreign(), view(ref), lastSent(), timeoutNextSend(), effects() }.

function fakeHarness({ operations = null }: { operations?: Untyped } = {}) {
  const port = createFakeAdapter({ iface: 'fake', selfId: SELF, operations, now: () => 1000 });
  const view = (ref: Record<string, Untyped>) => {
    const message = port.messages.get(`${ref.chatId}/${ref.messageId}`);
    if (!message || message.deleted) return null;
    return { text: message.text, authorId: message.authorId, reactions: [...message.reactions] };
  };
  return {
    port,
    foreign: () => port.seed(ROOM, { authorId: OTHER, text: 'καλημέρα' }),
    view,
    lastSent() {
      const all = port.messagesIn(ROOM).filter((message) => message.authorId === SELF);
      const message = all.at(-1);
      return {
        text: present(message).text,
        replyToId: present(message).replyTo?.messageId ?? null,
        attachments: present(message).attachments.map((attachment) => attachment.name),
      };
    },
    timeoutNextSend: () => port.failNext('send', { status: 'unknown', error: { code: 'timeout', retryable: false } }),
    effects: () => port.messagesIn(ROOM).length,
  };
}

// ---------------------------------------------------------------------------
// The shared suite.

// ---------------------------------------------------------------------------
// The Discord adapter's own translation.

// ---------------------------------------------------------------------------
// The fake adapter's own checks.

test('fake adapter: a malformed action is refused as failed invalid-action, recorded, without an effect', async () => {
  const h = fakeHarness();
  const before = h.effects();
  const target = h.foreign();
  for (const [op, call] of table([
    ['send', () => h.port.send(wrongly({ iface: 'fake' }), { text: 'όχι' })],
    ['send', () => h.port.send({ iface: 'fake', chatId: ROOM }, wrongly('όχι'))],
    ['edit', () => h.port.edit(wrongly({ iface: 'fake', chatId: ROOM }), { text: 'όχι' })],
    ['delete', () => h.port.delete({ ...target, messageId: wrongly(7) })],
    ['react', () => h.port.react(target, wrongly(null))],
    ['typing', () => h.port.typing(wrongly(null), noLease)],
  ])) {
    const result = await call();
    assert.deepEqual(
      [result.status, present(result.error).code, present(result.error).retryable],
      ['failed', 'invalid-action', false],
      wrongly(op)
    );
    const calls = h.port.calls;
    assert.equal(present(calls.at(-1)).op, op);
  }
  assert.equal(h.effects(), before + 1, 'only the seeded message');
  assert.deepEqual(present(h.view(target)).reactions, []);
  assert.deepEqual(h.port.typings, []);
});

test("fake adapter: a well-formed action keeps the port's own refusal codes", async () => {
  const h = fakeHarness();
  const foreign = await h.port.send({ iface: 'elsewhere', chatId: ROOM }, { text: 'όχι' });
  assert.equal(foreign.error?.code, 'foreign-reference');
  const emptyEmoji = await h.port.react(h.foreign(), '');
  assert.equal(present(emptyEmoji.error).code, 'invalid-emoji');
});

const PARTNER = { iface: 'discord', accountId: 'u1' };

test('the fake answers a seeded partner and fails an unknown one', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  fake.seedDmChat('u1', 'dm-1');
  assert.deepEqual(await fake.dmChatOf(PARTNER), { status: 'ok', chatId: 'dm-1' });
  const unknown = await fake.dmChatOf({ iface: 'discord', accountId: 'u9' });
  assert.equal(unknown.status, 'failed');
});

type Log = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

const quiet: Log = { info() {}, warn() {}, error() {} };

const READS_LOOPBACK_SELF = { id: 'self-id', name: 'Νέπτυν' };

const ROOT = { id: 'g1', name: 'Alpha' };

const GENERAL = { iface: 'fake', chatId: 'c1' };

const ALL: Permissions = { read: true, send: true, attach: true, react: true };

function info(id: string, extra: Partial<ChatInfo> = {}): ChatInfo {
  return {
    id,
    kind: 'channel',
    rootId: 'g1',
    name: `room-${id}`,
    topic: null,
    iface: 'fake',
    permissions: ALL,
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    ...extra,
  };
}

function eventOf(chat: ChatInfo, id: string, at: number, text: string, authorId = 'u1'): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'fake',
    at,
    id: `fake:message:${id}`,
    chat: { id: chat.id, kind: chat.kind, rootId: chat.rootId },
    message: {
      id,
      author: { id: authorId, name: 'Eleni', self: authorId === READS_LOOPBACK_SELF.id, bot: false },
      content: text,
      sourceText: text,
      system: false,
      at,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
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
    self: READS_LOOPBACK_SELF,
    root: ROOT,
    capabilities: adapter.capabilities(),
    resume: null,
  };
  serveAdapter({ transport: client, hello, token: 'tok', adapter, log: quiet });
  await link.hello;
  return { link, fake: adapter, reads: link.adapter };
}

test('answers a chat with its permissions, owner and flags as seeded', async () => {
  const { reads, fake } = await rig();
  fake.seedChat(
    info('c1', {
      permissions: { read: true, send: false, attach: false, react: true },
      lastMessageAt: 1700,
      voice: true,
      public: false,
    })
  );
  const { chat } = okBody(await reads.chatInfo(GENERAL));
  assert.equal(chat.id, 'c1');
  assert.deepEqual(chat.permissions, { read: true, send: false, attach: false, react: true });
  assert.equal(chat.lastMessageAt, 1700);
  assert.equal(chat.voice, true);
  assert.equal(chat.public, false);
});

test('carries the owner of a chat across the link, and null when it has none', async () => {
  const { reads, fake } = await rig();
  fake.seedChat(info('c1', { owner: 'owner-1' }));
  fake.seedChat(info('c2'));
  assert.equal(okBody(await reads.chatInfo(GENERAL)).chat.owner, 'owner-1');
  assert.equal(okBody(await reads.chatInfo({ iface: 'fake', chatId: 'c2' })).chat.owner, null);
});

test('answers the audience as arrays and the viewers asked for, only when asked', async () => {
  const { reads, fake } = await rig();
  fake.seedChat(
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
  const asked = okBody(await reads.chatInfo(GENERAL, { audience: true, viewers: ['u1', 'u2'] }));
  const audience = asked.chat.audience;
  assert.deepEqual(audience?.groups, ['g-a', 'g-b']);
  assert.deepEqual(audience?.memberGroups, { u7: ['g-a'] });
  assert.deepEqual(asked.chat.viewers, { u1: true, u2: false });
  const plain = okBody(await reads.chatInfo(GENERAL));
  assert.equal(plain.chat.audience, undefined);
  assert.equal(plain.chat.viewers, undefined);
});

test('fails a chat the adapter does not know with the code unknown-conversation', async () => {
  const { reads } = await rig();
  const result = await reads.chatInfo({ iface: 'fake', chatId: 'nowhere' });
  assert.equal(result.status, 'failed');
  assert.equal('error' in result ? result.error.code : null, 'unknown-conversation');
});

test('lists the chats of one root with its groups, and none of another', async () => {
  const { reads, fake } = await rig();
  fake.seedChat(info('c1'));
  fake.seedChat(info('c2', { kind: 'thread', parentId: 'c1' }));
  fake.seedChat(info('c3', { rootId: 'g2' }));
  fake.seedGroups('g1', [{ id: 'r1', name: 'mods' }]);
  const listing = okBody(await reads.chats({ placeId: 'g1' }));
  assert.deepEqual(listing.chats.map((entry) => entry.id).sort(), ['c1', 'c2']);
  assert.deepEqual(listing.groups, [{ id: 'r1', name: 'mods' }]);
});

test('lists the audience of each chat when asked', async () => {
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
  fake.seedChat(info('c1', { audience }));
  const listing = okBody(await reads.chats({ placeId: 'g1', audience: true }));
  const chat = listing.chats[0];
  assert.deepEqual(chat?.audience?.groups, ['g-a']);
});

function seedLine(fake: ReturnType<typeof createFakeAdapter>, count: number): void {
  const chat = info('c1');
  fake.seedChat(chat);
  for (let n = 1; n <= count; n += 1) fake.seedEvent(eventOf(chat, `m${n}`, 1000 * n, `line ${n}`));
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
  const message = found?.event?.message;
  assert.equal(message?.content, 'line 2');
  const chat = found?.event?.chat;
  assert.equal(chat?.id, 'c1');
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
  const found = okBody(await reads.memberInfo({ placeId: 'g1', accountId: 'u1' }));
  assert.deepEqual(found.member?.groupIds, ['r1']);
  const avatar = found.member?.avatar;
  assert.equal(avatar?.largeUrl, 'https://x/l.png');
  const stranger = okBody(await reads.memberInfo({ placeId: 'g1', accountId: 'u9' }));
  assert.equal(stranger.member, null);
});

test('lists the custom emoji of a root', async () => {
  const { reads, fake } = await rig();
  fake.seedEmoji('g1', [{ id: 'e1', name: 'kek', animated: false, url: 'https://x/e1.png' }]);
  const listing = okBody(await reads.emoji({ placeId: 'g1' }));
  assert.deepEqual(listing.emoji, [{ id: 'e1', name: 'kek', animated: false, url: 'https://x/e1.png' }]);
});

test('turns the message addresses of the fake into references and everything else into null', async () => {
  const { reads } = await rig();
  const inRoot = 'https://discord.com/channels/g1/c1/m1';
  const direct = 'https://discord.com/channels/@me/d1/m2';
  const parsed = okBody(await reads.parseLinks([inRoot, direct, 'https://example.com/x', 'no link here']));
  assert.deepEqual(parsed.refs, [
    { iface: 'fake', chatId: 'c1', messageId: 'm1' },
    { iface: 'fake', chatId: 'd1', messageId: 'm2' },
    null,
    null,
  ]);
});

test('lists the members who put an emoji on a message, at most the limit', async () => {
  const { reads, fake } = await rig();
  const ref = { iface: 'fake', chatId: 'c1', messageId: 'm1' };
  fake.seedReactors(ref, '🔥', ['u1', 'u2', 'u3']);
  const listed = okBody(await reads.reactors(ref, '🔥', 2));
  assert.deepEqual(listed.accountIds, ['u1', 'u2']);
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
  const fake = createFakeAdapter({ reads: ['chat.info'] });
  const { reads } = await rig(fake);
  fake.seedChat(info('c1'));
  assert.deepEqual(fake.capabilities().reads, ['chat.info']);
  assert.equal((await reads.history(GENERAL, { limit: 1 })).status, 'unsupported');
  assert.equal((await reads.chatInfo(GENERAL)).status, 'ok');
});
