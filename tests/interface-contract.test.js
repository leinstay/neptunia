// Contract tests of the interface port (src/interface/port.js): the SAME suite runs against the
// in-memory adapter (src/interface/fake.js) and the Discord adapter (interfaces/discord/port.js)
// over a fake discord.js client, proving the engine can swap one for the other. Each harness
// gives the suite a port and a neutral view of what reached its conversations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, STATUSES } from '../src/interface/port.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import * as discordInterface from '../interfaces/discord/index.js';
import { createDiscordAdapter, createDiscordInterface, discordFailure } from '../interfaces/discord/index.js';

const SELF = 'self-id';
const OTHER = 'other-id';
const ROOM = 'c1';

// ---------------------------------------------------------------------------
// Harnesses: `make(options)` -> { port, foreign(), view(ref), lastSent(), timeoutNextSend(), effects() }.

function fakeHarness({ operations = null } = {}) {
  const port = createFakeAdapter({ iface: 'fake', selfId: SELF, operations, now: () => 1000 });
  const view = (ref) => {
    const message = port.messages.get(`${ref.conversationId}/${ref.messageId}`);
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
        text: message.text,
        replyToId: message.replyTo?.messageId ?? null,
        mentions: message.mentions,
        attachments: message.attachments.map((attachment) => attachment.name),
      };
    },
    timeoutNextSend: () => port.failNext('send', { status: 'unknown', error: { code: 'timeout', retryable: false } }),
    effects: () => port.messagesIn(ROOM).length,
  };
}

/** A fake discord.js client with one text channel; messages keep their author and reactions. */
function discordHarness({ operations = null } = {}) {
  const store = new Map();
  const payloads = [];
  let failSend = null;
  let next = 0;
  const notFound = () => Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
  const makeMessage = (authorId, content) => {
    next += 1;
    const id = `d${next}`;
    const message = {
      id,
      author: { id: authorId },
      content,
      createdTimestamp: 5000 + next,
      reacted: new Set(),
      deleted: false,
      async edit(payload) {
        this.content = payload.content;
        return this;
      },
      async delete() {
        this.deleted = true;
      },
      async react(emoji) {
        this.reacted.add(emoji);
      },
    };
    message.reactions = {
      resolve: (key) =>
        message.reacted.has(key) ? { users: { remove: async () => message.reacted.delete(key) } } : null,
    };
    store.set(id, message);
    return message;
  };
  const channel = {
    id: ROOM,
    async send(payload) {
      payloads.push(payload);
      if (failSend) {
        const err = failSend;
        failSend = null;
        throw err;
      }
      return makeMessage(SELF, payload.content ?? '');
    },
    async sendTyping() {},
    messages: {
      fetch: async (id) => {
        const message = store.get(id);
        if (!message || message.deleted) throw notFound();
        return message;
      },
    },
  };
  const client = {
    user: { id: SELF },
    channels: {
      cache: new Map([[ROOM, channel]]),
      fetch: async () => {
        throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 });
      },
    },
  };
  const port = createDiscordAdapter({ client, operations });
  return {
    port,
    payloads,
    client,
    foreign: () => ({ iface: 'discord', conversationId: ROOM, messageId: makeMessage(OTHER, 'καλημέρα').id }),
    view(ref) {
      const message = store.get(ref.messageId);
      if (!message || message.deleted) return null;
      return { text: message.content, authorId: message.author.id, reactions: [...message.reacted] };
    },
    lastSent() {
      const payload = payloads.at(-1);
      const allowed = payload.allowedMentions;
      return {
        text: payload.content ?? '',
        replyToId: payload.reply?.messageReference ?? null,
        mentions: { users: allowed.users ?? [], repliedUser: allowed.repliedUser === true },
        attachments: (payload.files ?? []).map((file) => file.name),
      };
    },
    timeoutNextSend() {
      failSend = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    },
    effects: () => [...store.values()].filter((message) => !message.deleted).length,
  };
}

// ---------------------------------------------------------------------------
// The shared suite.

/** @typedef {import('../src/protocol/adapter.ts').Adapter} Adapter */
/** @typedef {import('../src/protocol/adapter.ts').MessageRef} MessageRef */
/** @typedef {{ port: Adapter, view(ref: MessageRef): { text: string } | null, effects(): number }} Harness */

for (const [name, make] of [
  ['fake', fakeHarness],
  ['discord', discordHarness],
]) {
  const room = (port) => ({ iface: port.iface, conversationId: ROOM });
  // The same harness `make` builds, typed for the split tests (the pair of harnesses is a union the checker cannot call).
  const build = /** @type {() => Harness} */ (/** @type {unknown} */ (make));

  test(`port contract (${name}): send answers ok with the new message's reference`, async () => {
    const { port, view } = make();
    const result = await port.send(room(port), { text: 'γεια σας' });
    assert.equal(result.status, 'ok');
    assert.equal(result.ref.iface, port.iface);
    assert.equal(result.ref.conversationId, ROOM);
    assert.equal(typeof result.ref.messageId, 'string');
    assert.deepEqual(view(result.ref), { text: 'γεια σας', authorId: SELF, reactions: [] });
  });

  test(`port contract (${name}): a reply carries its target and the mentions it names`, async () => {
    const h = make();
    const target = h.foreign();
    const result = await h.port.send(room(h.port), {
      text: 'ναι',
      replyTo: target,
      mentions: { users: [OTHER], repliedUser: true },
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(h.lastSent(), {
      text: 'ναι',
      replyToId: target.messageId,
      mentions: { users: [OTHER], repliedUser: true },
      attachments: [],
    });
  });

  test(`port contract (${name}): mentions default to none`, async () => {
    const h = make();
    const target = h.foreign();
    await h.port.send(room(h.port), { text: 'ναι', replyTo: target });
    assert.deepEqual(h.lastSent().mentions, { users: [], repliedUser: false });
  });

  test(`port contract (${name}): an attachment is sent by name`, async () => {
    const h = make();
    const result = await h.port.send(room(h.port), {
      attachments: [{ name: 'image.png', data: Buffer.from('png'), contentType: 'image/png' }],
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(h.lastSent().attachments, ['image.png']);
  });

  test(`port contract (${name}): edit changes the persona's own message, never someone else's`, async () => {
    const h = make();
    const own = (await h.port.send(room(h.port), { text: 'πρώτο' })).ref;
    assert.equal((await h.port.edit(own, { text: 'δεύτερο' })).status, 'ok');
    assert.equal(h.view(own).text, 'δεύτερο');

    const theirs = h.foreign();
    const refused = await h.port.edit(theirs, { text: 'άλλο' });
    assert.equal(refused.status, 'forbidden');
    assert.equal(refused.error.code, 'not-own-message');
    assert.equal(h.view(theirs).text, 'καλημέρα');
  });

  test(`port contract (${name}): delete removes the persona's own message, never someone else's`, async () => {
    const h = make();
    const own = (await h.port.send(room(h.port), { text: 'λάθος' })).ref;
    assert.equal((await h.port.delete(own)).status, 'ok');
    assert.equal(h.view(own), null);

    const theirs = h.foreign();
    assert.equal((await h.port.delete(theirs)).status, 'forbidden');
    assert.notEqual(h.view(theirs), null);
  });

  test(`port contract (${name}): react puts a reaction and unreact takes it back`, async () => {
    const h = make();
    const target = h.foreign();
    assert.equal((await h.port.react(target, '\u{1F389}')).status, 'ok');
    assert.deepEqual(h.view(target).reactions, ['\u{1F389}']);
    assert.equal((await h.port.unreact(target, '\u{1F389}')).status, 'ok');
    assert.deepEqual(h.view(target).reactions, []);
  });

  test(`port contract (${name}): typing answers ok`, async () => {
    const { port } = make();
    assert.equal((await port.typing(room(port))).status, 'ok');
  });

  // The capabilities take the shape of src/protocol/adapter.ts (`maxChars`, `maxFiles`, `maxFileBytes`) in place of
  // the old `limits` object, since the adapter now splits by `maxChars` and the core reads the same names.
  test(`port contract (${name}): capabilities name every operation and the limits`, () => {
    const { port } = make();
    const caps = port.capabilities();
    assert.deepEqual([...caps.operations].sort(), Object.values(CAPABILITIES).sort());
    for (const key of ['maxChars', 'maxFiles', 'maxFileBytes']) assert.ok(caps[key] > 0, key);
  });

  test(`port contract (${name}): a send that timed out is unknown, never retried by the port`, async () => {
    const h = make();
    h.timeoutNextSend();
    const before = h.effects();
    const result = await h.port.send(room(h.port), { text: 'χάθηκε;' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.error.retryable, false);
    assert.equal(h.effects(), before, 'the port did not send it again');
  });

  test(`port contract (${name}): an operation whose capability is off is unsupported and does nothing`, async () => {
    const h = make({
      operations: Object.values(CAPABILITIES).filter((capability) => capability !== CAPABILITIES.edit),
    });
    const own = (await h.port.send(room(h.port), { text: 'μένει' })).ref;
    const result = await h.port.edit(own, { text: 'αλλαγμένο' });
    assert.equal(result.status, 'unsupported');
    assert.equal(h.view(own).text, 'μένει');
    // `operations` is a list in the adapter contract; spreading it holds for a list or a set.
    assert.equal([...h.port.capabilities().operations].includes(CAPABILITIES.edit), false);
  });

  test(`port contract (${name}): a reference of another interface or empty content fails without an effect`, async () => {
    const h = make();
    const before = h.effects();
    const foreign = await h.port.send({ iface: 'elsewhere', conversationId: ROOM }, { text: 'όχι' });
    assert.deepEqual([foreign.status, foreign.error.code], ['failed', 'foreign-reference']);
    const empty = await h.port.send(room(h.port), { text: '' });
    assert.deepEqual([empty.status, empty.error.code], ['failed', 'empty-content']);
    assert.equal(h.effects(), before);
  });

  // Before PR 2 a send over the limit was refused as `text-too-long`. The adapter now splits it into parts that
  // join to the text, so the refusal is gone for `send`; only an edit, which cannot grow into several messages, keeps it.
  test(`port contract (${String(name)}): a send over the limit is posted as parts that join to the text`, async () => {
    const h = build();
    const limit = h.port.capabilities().maxChars;
    const text = 'α'.repeat(limit + 1);
    const before = h.effects();
    const delivery = await h.port.send({ iface: h.port.iface, conversationId: ROOM }, { text });
    assert.equal(delivery.status, 'ok');
    assert.equal(delivery.parts.length, 2);
    assert.equal(h.effects(), before + 2);
    const posted = delivery.parts.map((ref) => h.view(ref)?.text ?? '');
    assert.ok(posted.every((part) => Array.from(part).length <= limit));
    assert.equal(posted.join(''), text);
    assert.deepEqual(delivery.ref, delivery.parts[0], 'ref is the first part');
  });

  test(`port contract (${String(name)}): an edit over the limit is still refused as text-too-long`, async () => {
    const h = build();
    const own = (await h.port.send({ iface: h.port.iface, conversationId: ROOM }, { text: 'μένει' })).ref;
    assert.ok(own);
    const result = await h.port.edit(own, { text: 'α'.repeat(h.port.capabilities().maxChars + 1) });
    assert.deepEqual([result.status, result.error?.code], ['failed', 'text-too-long']);
    assert.equal(h.view(own)?.text, 'μένει');
  });

  test(`port contract (${name}): no operation throws on malformed arguments`, async () => {
    const { port } = make();
    for (const call of [
      () => port.send(null, null),
      () => port.edit({}, {}),
      () => port.delete(undefined),
      () => port.react({ iface: port.iface, conversationId: ROOM }, ''),
      () => port.unreact(null, null),
      () => port.typing({}),
    ]) {
      const result = await call();
      assert.ok(STATUSES.includes(result.status));
      assert.notEqual(result.status, 'ok');
    }
  });
}

// ---------------------------------------------------------------------------
// The Discord adapter's own translation.

test('discord adapter: absent mentions are allowedMentions { parse: [] }, given ones name exactly their members', async () => {
  const h = discordHarness();
  await h.port.send({ iface: 'discord', conversationId: ROOM }, { text: 'α' });
  assert.deepEqual(h.payloads[0], { content: 'α', reply: undefined, allowedMentions: { parse: [] } });
  await h.port.send(
    { iface: 'discord', conversationId: ROOM },
    { text: 'β', mentions: { users: ['u1'], repliedUser: false } }
  );
  assert.deepEqual(h.payloads[1].allowedMentions, { parse: [], users: ['u1'], repliedUser: false });
});

test('discord adapter: a channel the caller holds is used before the client', async () => {
  const sent = [];
  const held = { id: 'c9', send: async (payload) => (sent.push(payload), { id: 'x1', createdTimestamp: 42 }) };
  const port = createDiscordAdapter({
    client: { user: { id: SELF } },
    lookupChannel: (id) => (id === 'c9' ? held : null),
  });
  const result = await port.send({ iface: 'discord', conversationId: 'c9' }, { text: 'ναι' });
  // A send answers a Delivery (it also carries `parts` and an idempotency key), so the fields that matter are read.
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.ref, { iface: 'discord', conversationId: 'c9', messageId: 'x1', memberId: SELF });
  assert.equal(result.at, 42);
  assert.deepEqual(result.parts, [result.ref]);
  assert.equal(sent.length, 1);
});

test('discord adapter: a text over the limit posts one message per part, replying only on the first', async () => {
  const h = discordHarness();
  const limit = h.port.capabilities().maxChars;
  const text = 'α'.repeat(limit + 1);
  const replyTo = { iface: 'discord', conversationId: ROOM, messageId: 'target-1' };
  const delivery = await h.port.send({ iface: 'discord', conversationId: ROOM }, { text, replyTo });
  assert.equal(delivery.status, 'ok');
  const payloads = /** @type {Array<{ content?: string, reply?: { messageReference: string } }>} */ (h.payloads);
  assert.equal(payloads.length, 2, 'one channel.send per part');
  assert.deepEqual(
    delivery.parts.map((ref) => ref.messageId),
    ['d1', 'd2']
  );
  assert.deepEqual(delivery.ref, delivery.parts[0]);
  assert.equal(payloads[0]?.reply?.messageReference, 'target-1');
  assert.equal(payloads[1]?.reply, undefined, 'the second part does not reply');
  assert.equal(payloads.map((payload) => payload.content).join(''), text);
});

test('discord adapter: a failure on the second part is unknown and keeps the first part', async () => {
  let calls = 0;
  const held = {
    id: 'c9',
    send: () => {
      calls += 1;
      if (calls === 2) return Promise.reject(Object.assign(new Error('Internal Server Error'), { status: 500 }));
      return Promise.resolve({ id: `x${calls}`, createdTimestamp: 42 });
    },
  };
  const port = createDiscordAdapter({
    client: { user: { id: SELF } },
    lookupChannel: (id) => (id === 'c9' ? held : null),
  });
  const delivery = await port.send(
    { iface: 'discord', conversationId: 'c9' },
    { text: 'α'.repeat(port.capabilities().maxChars + 1) }
  );
  assert.equal(delivery.status, 'unknown');
  assert.deepEqual(
    delivery.parts.map((ref) => ref.messageId),
    ['x1']
  );
  assert.equal(calls, 2, 'no third attempt and no retry of the failed part');
});

test('discord adapter: an unknown channel fails without a send', async () => {
  const h = discordHarness();
  const result = await h.port.send({ iface: 'discord', conversationId: 'gone' }, { text: 'α' });
  assert.deepEqual([result.status, result.error?.code], ['failed', 'http-404']);
  assert.equal(h.payloads.length, 0);
});

test('createDiscordInterface: the port is the Discord adapter over the given client', async () => {
  const sent = [];
  const channel = { id: 'c9', send: async (payload) => (sent.push(payload), { id: 'x1', createdTimestamp: 42 }) };
  const client = { user: { id: SELF }, channels: { cache: new Map([['c9', channel]]) } };
  const built = createDiscordInterface({ client });
  assert.deepEqual(Object.keys(built), ['port', 'capabilities', 'client']);
  assert.equal(built.client, client);
  assert.equal(built.port.iface, 'discord');
  const result = await built.port.send({ iface: 'discord', conversationId: 'c9' }, { text: 'ναι' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.ref, { iface: 'discord', conversationId: 'c9', messageId: 'x1', memberId: SELF });
  assert.deepEqual(sent, [{ content: 'ναι', reply: undefined, allowedMentions: { parse: [] } }]);
});

test("createDiscordInterface: the capabilities are the package's own functions, by name, frozen", () => {
  const { capabilities } = createDiscordInterface({ client: { user: { id: SELF } } });
  assert.deepEqual(Object.keys(capabilities), [
    'canRead',
    'canSend',
    'canAttach',
    'canReact',
    'isReadableChannel',
    'isWritableChannel',
    'readableChannels',
    'channelDirectoryOf',
    'lastActivity',
    'snowflakeTime',
    'audienceOf',
    'fetchHistory',
    'fetchHistoryWindow',
    'fetchMessage',
    'fetchReplyParents',
    'fetchNeighbors',
    'withTextPreviews',
    'normalizeMessage',
    'normalizeOptions',
    'PAGE',
    'audienceAllows',
    'captionPulled',
    'checkPull',
    'createPullViews',
    'fetchPull',
    'searchMessages',
    'searchMembers',
    'fetchAround',
    'fetchAfter',
    'fetchBefore',
    'reactorIdsOf',
    'normalizedOf',
    'toEvent',
  ]);
  for (const [name, value] of Object.entries(capabilities)) assert.equal(value, discordInterface[name], name);
  assert.ok(Object.isFrozen(capabilities));
});

test('snowflakeTime and createDiscordClient: the creation time of an id, and the client the root logs in', () => {
  // The Discord epoch plus the timestamp bits: 175928847299117063 is 2016-04-30T11:18:25.796Z.
  assert.equal(discordInterface.snowflakeTime('175928847299117063'), Date.UTC(2016, 3, 30, 11, 18, 25, 796));
  const plain = discordInterface.createDiscordClient();
  const wide = discordInterface.createDiscordClient({ presences: true, members: true });
  try {
    assert.equal(
      wide.options.intents.bitfield - plain.options.intents.bitfield,
      (1 << 8) + (1 << 1),
      'presences and members add their intents'
    );
    assert.equal(plain.options.partials.length, 4);
  } finally {
    plain.destroy();
    wide.destroy();
  }
});

test('discordFailure: Discord answers are normalised', () => {
  const http = (status) => Object.assign(new Error('x'), { status });
  const view = (result) => [result.status, result.error.code, result.error.retryable];
  assert.deepEqual(view(discordFailure(http(429), { sent: true })), ['failed', 'http-429', true]);
  assert.deepEqual(view(discordFailure(http(403), { sent: true })), ['forbidden', 'http-403', false]);
  assert.deepEqual(view(discordFailure(http(404), { sent: true })), ['failed', 'http-404', false]);
  assert.deepEqual(view(discordFailure(http(502), { sent: true })), ['unknown', 'http-502', false]);
  assert.deepEqual(view(discordFailure(http(502), { sent: false })), ['failed', 'http-502', true]);
  assert.deepEqual(view(discordFailure(new Error('socket hang up'), { sent: true })), ['unknown', 'error', false]);
  assert.deepEqual(view(discordFailure(Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), { sent: false })), [
    'failed',
    'timeout',
    true,
  ]);
  assert.ok(discordFailure(http(403), { sent: true }).error.cause instanceof Error, 'the cause is kept for the logs');
});

// ---------------------------------------------------------------------------
// The fake adapter's own checks.

test('fake adapter: a malformed action is refused as failed invalid-action, recorded, without an effect', async () => {
  const h = fakeHarness();
  const before = h.effects();
  const target = h.foreign();
  for (const [op, call] of [
    ['send', () => h.port.send({ iface: 'fake' }, { text: 'όχι' })],
    ['send', () => h.port.send({ iface: 'fake', conversationId: ROOM }, 'όχι')],
    ['edit', () => h.port.edit({ iface: 'fake', conversationId: ROOM }, { text: 'όχι' })],
    ['delete', () => h.port.delete({ ...target, messageId: 7 })],
    ['react', () => h.port.react(target, null)],
    ['typing', () => h.port.typing(null)],
  ]) {
    const result = await call();
    assert.deepEqual(
      [result.status, result.error.code, result.error.retryable],
      ['failed', 'invalid-action', false],
      op
    );
    assert.equal(h.port.calls.at(-1).op, op);
  }
  assert.equal(h.effects(), before + 1, 'only the seeded message');
  assert.deepEqual(h.view(target).reactions, []);
  assert.deepEqual(h.port.typings, []);
});

test("fake adapter: a well-formed action keeps the port's own refusal codes", async () => {
  const h = fakeHarness();
  const foreign = await h.port.send({ iface: 'elsewhere', conversationId: ROOM }, { text: 'όχι' });
  assert.equal(foreign.error?.code, 'foreign-reference');
  const emptyEmoji = await h.port.react(h.foreign(), '');
  assert.equal(emptyEmoji.error.code, 'invalid-emoji');
});
