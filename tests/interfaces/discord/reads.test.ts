// The chat reads of the Discord adapter (`createDiscordAdapter({ client, config })`) over a stub discord.js
// client: each read answers what the old function of interfaces/discord did with the same stub. The history read gives
// events whose `lineOf` (src/behavior/line-of.ts) equals the lines `fetchHistory` and `fetchHistoryWindow` return. Discord
// objects are plain stubs shaped just enough for the code to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  createDiscordAdapter,
  fetchHistory,
  fetchHistoryWindow,
  lastActivity,
  normalizeOptions,
  canAttach,
  canReact,
  canRead,
  canSend,
} from '../../../interfaces/discord/index.ts';
import { lineOf } from '../../../src/behavior/line-of.ts';
import type { MessageEvent } from '../../../src/protocol/adapter.ts';

type Raw = Record<string, unknown>;
type Channel = Parameters<typeof fetchHistory>[0];

const CHANNEL = { iface: 'discord', chatId: 'c1' };
const SELF = 'self-id';
const EPOCH = 1420070400000n;
// The stub is shaped for the code that reads it, not for discord.js's own types.
const asChannel = (stub: Raw): Channel => stub as unknown as Channel;
const snowflakeOf = (ms: number): string => ((BigInt(ms) - EPOCH) << 22n).toString();

function rawMessage(id: string, createdTimestamp: number, content: string, authorId = 'u1'): Raw {
  const author = { id: authorId, bot: false, globalName: authorId, username: authorId };
  return {
    id,
    channelId: 'c1',
    channel: { name: 'general' },
    author,
    member: { displayName: authorId },
    content,
    cleanContent: content,
    createdTimestamp,
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
  };
}

const MESSAGES = [
  rawMessage('1001', 1000, 'one'),
  rawMessage('1002', 2000, 'two'),
  rawMessage('1003', 3000, 'three'),
  rawMessage('1004', 4000, 'four'),
  rawMessage('1005', 5000, 'five'),
];

function notFound(): Error {
  return Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
}

// A channel whose message manager answers the way discord.js does: a Map newest first for a query, one message by id.
function textChannel(messages: ReadonlyArray<Raw>, extra: Raw = {}): Raw {
  const byId = new Map(messages.map((message) => [String(message.id), message]));
  const sorted = [...messages].sort((a, b) => Number(a.createdTimestamp) - Number(b.createdTimestamp));
  const page = (query: Raw): Array<Raw> => {
    const limit = Number(query.limit ?? 50);
    const id = (value: unknown): bigint => BigInt(String(value));
    if (query.before !== undefined) return sorted.filter((m) => id(m.id) < id(query.before)).slice(-limit);
    if (query.after !== undefined) return sorted.filter((m) => id(m.id) > id(query.after)).slice(0, limit);
    if (query.around !== undefined) {
      const at = sorted.findIndex((m) => m.id === query.around);
      const from = Math.max(0, at - Math.floor(limit / 2));
      return sorted.slice(from, from + limit);
    }
    return sorted.slice(-limit);
  };
  return {
    id: 'c1',
    name: 'general',
    topic: 'daily talk',
    parent: { name: 'main' },
    parentId: 'cat1',
    type: ChannelType.GuildText,
    guildId: 'g1',
    viewable: true,
    lastMessageId: '1005',
    isThread: () => false,
    isTextBased: () => true,
    isVoiceBased: () => false,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      cache: new Map(),
      fetch: (arg: unknown): Promise<unknown> => {
        if (typeof arg === 'string') {
          const found = byId.get(arg);
          return found === undefined ? Promise.reject(notFound()) : Promise.resolve(found);
        }
        return Promise.resolve(
          new Map(
            page(arg as Raw)
              .reverse()
              .map((m) => [String(m.id), m])
          )
        );
      },
    },
    ...extra,
  };
}

function guildOf(channels: ReadonlyArray<Raw>, extra: Raw = {}): Raw {
  const me = { id: SELF, displayName: 'Nova' };
  const roles = new Map<string, Raw>([
    ['g1', { id: 'g1', name: '@everyone' }],
    ['r1', { id: 'r1', name: 'mods' }],
  ]);
  const guild: Raw = {
    id: 'g1',
    members: {
      me,
      cache: new Map<string, Raw>(),
      fetch: () => Promise.reject(Object.assign(new Error('Unknown Member'), { status: 404, code: 10007 })),
    },
    roles: { everyone: { id: 'g1' }, cache: roles },
    channels: { cache: new Map(channels.map((c) => [String(c.id), c])) },
    emojis: { cache: new Map<string, Raw>() },
    ...extra,
  };
  for (const channel of channels) channel.guild = guild;
  return guild;
}

function clientOf(guild: Raw, channels: ReadonlyArray<Raw>, extra: Raw = {}): Raw {
  return {
    user: {
      id: SELF,
      username: 'nova',
      displayAvatarURL: (options: Raw) => `https://cdn/self.${String(options.extension)}?size=${String(options.size)}`,
    },
    guilds: { cache: new Map([['g1', guild]]) },
    channels: {
      cache: new Map(channels.map((c) => [String(c.id), c])),
      fetch: (id: string) => Promise.resolve(channels.find((c) => c.id === id) ?? null),
    },
    ...extra,
  };
}

function world(extra: { guild?: Raw; client?: Raw } = {}) {
  const channel = textChannel(MESSAGES);
  const guild = guildOf([channel], extra.guild);
  const client = clientOf(guild, [channel], extra.client);
  const adapter = createDiscordAdapter({ client, config: () => ({}) });
  return { channel, guild, client, adapter };
}

function eventsOf(result: { status: string; events?: ReadonlyArray<MessageEvent> }): ReadonlyArray<MessageEvent> {
  if (result.status !== 'ok' || result.events === undefined) throw new Error(`history answered ${result.status}`);
  return result.events;
}

const options = { selfId: SELF, ...normalizeOptions({}) };

test('reports a server channel with its name, topic and root, and no owner', async () => {
  // A category is no place.
  const { adapter } = world();
  const result = await adapter.chatInfo(CHANNEL);
  if (result.status !== 'ok') throw new Error(result.status);
  const { chat } = result;
  assert.equal(chat.kind, 'channel');
  assert.equal(chat.rootId, 'g1');
  assert.equal(chat.name, 'general');
  assert.equal(chat.topic, 'daily talk');
  assert.equal('category' in chat, false);
  assert.equal(chat.iface, 'discord');
  assert.equal(chat.owner, null);
  assert.equal(chat.voice, false);
});

test('reports the time of the newest message from its snowflake, like lastActivity', async () => {
  const { adapter, channel } = world();
  const stamped = { ...channel, lastMessageId: snowflakeOf(1_700_000_000_000) };
  const client = clientOf(guildOf([stamped]), [stamped]);
  const result = await createDiscordAdapter({ client, config: () => ({}) }).chatInfo(CHANNEL);
  if (result.status !== 'ok') throw new Error(result.status);
  assert.equal(result.chat.lastMessageAt, lastActivity(asChannel(stamped)));
  const none = await adapter.chatInfo({ iface: 'discord', chatId: 'c1' });
  assert.equal(none.status, 'ok');
});

test('reports a private chat as a direct chat with its partner and no root', async () => {
  const direct = {
    ...textChannel([]),
    guildId: null,
    guild: null,
    type: ChannelType.DM,
    recipientId: 'u1',
    parent: null,
    name: null,
    topic: null,
    isDMBased: () => true,
  };
  const client = clientOf(guildOf([]), [direct]);
  const result = await createDiscordAdapter({ client, config: () => ({}) }).chatInfo(CHANNEL);
  if (result.status !== 'ok') throw new Error(result.status);
  assert.equal(result.chat.kind, 'dm');
  assert.equal(result.chat.rootId, null);
  assert.equal(result.chat.partnerId, 'u1');
});

test('reports a thread with its parent channel', async () => {
  const thread = {
    ...textChannel([]),
    type: ChannelType.PublicThread,
    isThread: () => true,
    parentId: 'c0',
    name: 'side talk',
  };
  const client = clientOf(guildOf([thread]), [thread]);
  const result = await createDiscordAdapter({ client, config: () => ({}) }).chatInfo(CHANNEL);
  if (result.status !== 'ok') throw new Error(result.status);
  assert.equal(result.chat.kind, 'thread');
  assert.equal(result.chat.parentId, 'c0');
});

test('lists text channels, threads and voice rooms of a root with its groups, and no category', async () => {
  const text = textChannel([], { id: 't1', name: 'text' });
  const thread = textChannel([], { id: 't2', name: 'thread', isThread: () => true, type: ChannelType.PublicThread });
  const voice = textChannel([], { id: 'v1', name: 'lounge', isVoiceBased: () => true, type: ChannelType.GuildVoice });
  const category = textChannel([], {
    id: 'k1',
    name: 'main',
    isTextBased: () => false,
    type: ChannelType.GuildCategory,
  });
  const guild = guildOf([text, thread, voice, category]);
  const adapter = createDiscordAdapter({
    client: clientOf(guild, [text, thread, voice, category]),
    config: () => ({}),
  });
  const result = await adapter.chats({ placeId: 'g1' });
  if (result.status !== 'ok') throw new Error(result.status);
  assert.deepEqual(result.chats.map((entry) => entry.id).sort(), ['t1', 't2', 'v1']);
  assert.equal(result.chats.find((entry) => entry.id === 'v1')?.voice, true);
  assert.deepEqual(
    result.groups.find((group) => group.id === 'r1'),
    { id: 'r1', name: 'mods' }
  );
});

/** A line of the adapter in the core's words: the SDK's channel is the core's place (src/behavior/line-of.ts). */
const inCoreWords = (line: Awaited<ReturnType<typeof fetchHistory>>[number]) => {
  const { channelId, ...rest } = line as typeof line & { channelId?: string };
  return { ...rest, placeId: channelId };
};

test('reads the newest lines as events whose lines equal fetchHistory', async () => {
  const { adapter, channel } = world();
  const events = eventsOf(await adapter.history(CHANNEL, { limit: 3 }));
  const lines = await fetchHistory(asChannel(channel), { limit: 3, ...options });
  assert.deepEqual(events.map(lineOf), lines.map(inCoreWords));
  assert.deepEqual(
    events.map((event) => event.message.id),
    ['1003', '1004', '1005']
  );
});

test('reads the lines at or after a floor like fetchHistoryWindow', async () => {
  const { adapter, channel } = world();
  const events = eventsOf(await adapter.history(CHANNEL, { limit: 10, since: 3000 }));
  const lines = await fetchHistoryWindow(asChannel(channel), { limit: 10, minTs: 3000, ...options });
  assert.deepEqual(events.map(lineOf), lines.map(inCoreWords));
  assert.deepEqual(
    events.map((event) => event.message.id),
    ['1003', '1004', '1005']
  );
});

test('reads the lines before, after and around a message, oldest first', async () => {
  const { adapter } = world();
  const ids = async (query: { limit: number; before?: string; after?: string; around?: string }) =>
    eventsOf(await adapter.history(CHANNEL, query)).map((event) => event.message.id);
  assert.deepEqual(await ids({ limit: 2, before: '1004' }), ['1002', '1003']);
  assert.deepEqual(await ids({ limit: 2, after: '1002' }), ['1003', '1004']);
  assert.deepEqual(await ids({ limit: 3, around: '1003' }), ['1002', '1003', '1004']);
});

test('fails the history of a channel whose messages cannot be fetched', async () => {
  const broken = textChannel(MESSAGES);
  broken.messages = { cache: new Map(), fetch: () => Promise.reject(new Error('boom')) };
  const adapter = createDiscordAdapter({ client: clientOf(guildOf([broken]), [broken]), config: () => ({}) });
  assert.equal((await adapter.history(CHANNEL, { limit: 3 })).status, 'failed');
});

test('returns a fetched message with its whole event and keeps a deleted one missing', async () => {
  const { adapter } = world();
  const result = await adapter.fetchMessages(CHANNEL, ['1002', '9999']);
  if (result.status !== 'ok') throw new Error(result.status);
  const [found, gone] = result.messages;
  const message = found?.event?.message;
  assert.equal(message?.content, 'two');
  const chat = found?.event?.chat;
  assert.equal(chat?.id, 'c1');
  assert.equal(gone?.missing, true);
});

test('fails a message fetch that breaks for a reason other than the message being gone', async () => {
  const broken = textChannel(MESSAGES);
  broken.messages = {
    cache: new Map(),
    fetch: () => Promise.reject(Object.assign(new Error('down'), { status: 500 })),
  };
  const adapter = createDiscordAdapter({ client: clientOf(guildOf([broken]), [broken]), config: () => ({}) });
  assert.equal((await adapter.fetchMessages(CHANNEL, ['1002'])).status, 'failed');
});

test('answers a member with the ids of their roles, and null for a user who is not in the server', async () => {
  const roles = new Map([
    ['r1', {}],
    ['r2', {}],
  ]);
  const user = { id: 'u1', bot: false, avatar: null };
  const member = { id: 'u1', displayName: 'Eleni', user, avatar: null, roles: { cache: roles } };
  const { adapter, guild } = world();
  (guild.members as { cache: Map<string, Raw> }).cache.set('u1', member);
  const found = await adapter.memberInfo({ placeId: 'g1', accountId: 'u1' });
  if (found.status !== 'ok') throw new Error(found.status);
  assert.deepEqual(found.member?.groupIds, ['r1', 'r2']);
  assert.equal(found.member?.name, 'Eleni');
  const stranger = await adapter.memberInfo({ placeId: 'g1', accountId: 'u9' });
  if (stranger.status !== 'ok') throw new Error(stranger.status);
  assert.equal(stranger.member, null);
});

test('gives the persona a large static avatar address of 1024 pixels', async () => {
  const me = {
    id: SELF,
    displayName: 'Nova',
    user: { id: SELF, bot: true, avatar: 'abc' },
    avatar: null,
    roles: { cache: new Map() },
  };
  const { adapter, guild } = world();
  (guild.members as { cache: Map<string, Raw> }).cache.set(SELF, me);
  const result = await adapter.memberInfo({ placeId: 'g1', accountId: SELF });
  if (result.status !== 'ok') throw new Error(result.status);
  const avatar = result.member?.avatar;
  assert.equal(avatar?.largeUrl, 'https://cdn/self.png?size=1024');
});

test('lists the custom emoji of a server with their pictures and leaves out an unavailable one', async () => {
  const emojis = new Map<string, Raw>([
    ['e1', { id: 'e1', name: 'kek', animated: false, available: true }],
    ['e2', { id: 'e2', name: 'gone', animated: true, available: false }],
  ]);
  const { adapter } = world({ guild: { emojis: { cache: emojis } } });
  const result = await adapter.emoji({ placeId: 'g1' });
  if (result.status !== 'ok') throw new Error(result.status);
  assert.deepEqual(
    result.emoji.map((entry) => [entry.id, entry.name, entry.animated]),
    [['e1', 'kek', false]]
  );
  const emoji = result.emoji[0];
  assert.equal(emoji?.url.startsWith('https://cdn.discordapp.com/emojis/e1'), true);
});

test('turns message links into references and every other text into null', async () => {
  const { adapter } = world();
  const result = await adapter.parseLinks([
    'https://discord.com/channels/111/222/333',
    'https://discord.com/channels/@me/444/555',
    'https://example.com/channels/111/222/333',
    'see https://discord.com/channels/111/222/333',
  ]);
  if (result.status !== 'ok') throw new Error(result.status);
  assert.deepEqual(result.refs, [
    { iface: 'discord', chatId: '222', messageId: '333' },
    { iface: 'discord', chatId: '444', messageId: '555' },
    null,
    null,
  ]);
});

test('lists the members who put an emoji on a message, asking Discord for at most the limit', async () => {
  const fetched: Array<unknown> = [];
  const reaction = {
    emoji: { id: null, name: '🔥' },
    users: {
      fetch: (query: unknown) => {
        fetched.push(query);
        return Promise.resolve(
          new Map([
            ['u1', {}],
            ['u2', {}],
          ])
        );
      },
    },
  };
  const message = { ...rawMessage('1005', 5000, 'five'), reactions: { cache: new Map([['🔥', reaction]]) } };
  const channel = textChannel([message]);
  const adapter = createDiscordAdapter({ client: clientOf(guildOf([channel]), [channel]), config: () => ({}) });
  const result = await adapter.reactors({ ...CHANNEL, messageId: '1005' }, '🔥', 7);
  if (result.status !== 'ok') throw new Error(result.status);
  assert.deepEqual(result.accountIds, ['u1', 'u2']);
  assert.deepEqual(fetched, [{ limit: 7 }]);
});

test('fails the reactors of an emoji nobody put on the message', async () => {
  const { adapter } = world();
  assert.equal((await adapter.reactors({ ...CHANNEL, messageId: '1005' }, '🔥', 7)).status, 'failed');
});

test('lists the emoji of every server the bot is in for a read with no place', async () => {
  // Bug: a private chat reads one server's emoji, whichever was named first, or none at all.
  // No `servers` list is stored, so an old list in the settings narrows
  // nothing and the read covers every server the bot is in.
  const emoji = (id: string): Raw => ({ id, name: id, animated: false, available: true });
  const guild = (id: string, ids: Array<string>): Raw => ({
    id,
    emojis: { cache: new Map(ids.map((one) => [one, emoji(one)])) },
  });
  const guilds = new Map([
    ['g1', guild('g1', ['e1'])],
    ['g2', guild('g2', ['e2'])],
    ['g3', guild('g3', ['e3'])],
  ]);
  const client = { guilds: { cache: guilds }, user: { id: SELF }, channels: { cache: new Map() } };
  const adapter = createDiscordAdapter({ client, config: () => ({ servers: ['g1', 'g2'] }) });
  const result = await adapter.emoji({ placeId: null });
  if (result.status !== 'ok') throw new Error(result.status);
  assert.deepEqual(
    result.emoji.map((entry) => entry.id),
    ['e1', 'e2', 'e3']
  );
});

test('the invite link names the application and carries the permissions the package needs', async () => {
  // Catches: a link for the wrong bot, or one that adds the persona to a server where they can neither read nor answer.
  const client = clientOf(guildOf([]), [], { application: { id: 'app-1' } });
  const adapter = createDiscordAdapter({ client, config: () => ({}) });
  assert.ok(adapter.capabilities().reads?.includes('invite.link'));
  const result = await adapter.inviteLink({ iface: 'discord' });
  if (result.status !== 'ok') throw new Error(`invite answered ${result.status}`);
  const url = new URL(result.url);
  assert.equal(url.origin, 'https://discord.com');
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'app-1');
  assert.ok((url.searchParams.get('scope') ?? '').split(' ').includes('bot'));
  const granted = BigInt(url.searchParams.get('permissions') ?? '0');
  const needed = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.AttachFiles,
  ];
  for (const bit of needed) assert.equal(granted & bit, bit, `permission ${bit}`);
});

// The four permission booleans of a chat as the Discord adapter reports them (`chatInfo`), against
// the old `canRead`, `canSend`, `canAttach` and `canReact` of interfaces/discord/collect.ts over every branch: a
// channel without a guild, an unviewable one, no member `me`, no resolved permissions, and each flag alone and together.
// A false boolean makes the persona go quiet, so each row also names the literal answer.

type Granted = ReadonlyArray<bigint>;

const PERM_SELF = { id: 'self-id' };
const EVERYONE = { id: 'g1' };

function guildChannel(options: { granted?: Granted; viewable?: boolean; me?: Raw | null; resolves?: boolean }): Raw {
  const me = options.me === undefined ? PERM_SELF : options.me;
  const granted = options.granted ?? [];
  const guild: Raw = {
    id: 'g1',
    members: { me, cache: new Map() },
    roles: { everyone: EVERYONE, cache: new Map() },
  };
  return {
    id: 'c1',
    name: 'general',
    topic: null,
    parent: null,
    parentId: null,
    type: ChannelType.GuildText,
    guild,
    placeId: 'g1',
    viewable: options.viewable ?? true,
    lastMessageId: null,
    isThread: () => false,
    isTextBased: () => true,
    isVoiceBased: () => false,
    isDMBased: () => false,
    permissionsFor: (who: unknown) => {
      if (who === EVERYONE) return { has: () => true };
      if (options.resolves === false) return null;
      return who === me ? { has: (flag: bigint) => granted.includes(flag) } : null;
    },
    messages: { cache: new Map(), fetch: () => Promise.resolve(new Map()) },
  };
}

function directChannel(): Raw {
  return {
    id: 'c1',
    name: null,
    topic: null,
    parent: null,
    parentId: null,
    type: ChannelType.DM,
    guild: null,
    placeId: null,
    recipientId: 'u1',
    viewable: true,
    lastMessageId: null,
    isThread: () => false,
    isTextBased: () => true,
    isVoiceBased: () => false,
    isDMBased: () => true,
    permissionsFor: () => {
      throw new Error('a private chat has no member permissions');
    },
    messages: { cache: new Map(), fetch: () => Promise.resolve(new Map()) },
  };
}

type Expected = { read: boolean; send: boolean; attach: boolean; react: boolean };
const {
  ReadMessageHistory: HISTORY,
  SendMessages: SEND,
  AttachFiles: FILES,
  AddReactions: REACT,
} = PermissionFlagsBits;

const ROWS: ReadonlyArray<{ name: string; channel: Raw; expected: Expected }> = [
  {
    name: 'a channel without a guild',
    channel: directChannel(),
    expected: { read: true, send: true, attach: true, react: true },
  },
  {
    name: 'an unviewable channel with every flag',
    channel: guildChannel({ granted: [HISTORY, SEND, FILES, REACT], viewable: false }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'a guild without a member me',
    channel: guildChannel({ granted: [HISTORY, SEND, FILES, REACT], me: null }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'permissions that do not resolve',
    channel: guildChannel({ granted: [HISTORY, SEND, FILES, REACT], resolves: false }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'no flag at all',
    channel: guildChannel({ granted: [] }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'Read Message History alone',
    channel: guildChannel({ granted: [HISTORY] }),
    expected: { read: true, send: false, attach: false, react: false },
  },
  {
    name: 'Send Messages alone',
    channel: guildChannel({ granted: [SEND] }),
    expected: { read: false, send: true, attach: false, react: false },
  },
  {
    name: 'Attach Files alone',
    channel: guildChannel({ granted: [FILES] }),
    expected: { read: false, send: false, attach: true, react: false },
  },
  {
    name: 'Add Reactions alone, which needs history as well',
    channel: guildChannel({ granted: [REACT] }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'Add Reactions with Read Message History',
    channel: guildChannel({ granted: [HISTORY, REACT] }),
    expected: { read: true, send: false, attach: false, react: true },
  },
  {
    name: 'every flag',
    channel: guildChannel({ granted: [HISTORY, SEND, FILES, REACT] }),
    expected: { read: true, send: true, attach: true, react: true },
  },
];

function adapterOver(channel: Raw) {
  const client = {
    user: { id: 'self-id' },
    channels: { cache: new Map([['c1', channel]]), fetch: () => Promise.resolve(null) },
    guilds: { cache: new Map<string, unknown>() },
  };
  return createDiscordAdapter({ client, config: () => ({}) });
}

for (const row of ROWS) {
  test(`reports the permissions of ${row.name} as the old checks do`, async () => {
    const result = await adapterOver(row.channel).chatInfo({ iface: 'discord', chatId: 'c1' });
    if (result.status !== 'ok') throw new Error(`chatInfo answered ${result.status}`);
    const old = {
      read: canRead(row.channel),
      send: canSend(row.channel),
      attach: canAttach(row.channel),
      react: canReact(row.channel),
    };
    assert.deepEqual(result.chat.permissions, old);
    assert.deepEqual(result.chat.permissions, row.expected);
  });
}

test('fails a channel the client does not know instead of reporting permissions', async () => {
  const result = await adapterOver(directChannel()).chatInfo({ iface: 'discord', chatId: 'c404' });
  assert.equal(result.status, 'failed');
});

const PARTNER = { iface: 'discord', accountId: 'u1' };

/** An adapter over a stub client whose `users.createDM` runs `create`, and the ids it was asked for. */
function discordOver(create: (id: string) => Promise<unknown>) {
  const asked: Array<string> = [];
  const client = {
    user: { id: 'self' },
    users: {
      createDM: (id: string) => {
        asked.push(id);
        return create(id);
      },
    },
  };
  return { adapter: createDiscordAdapter({ client: client, config: () => ({}) }), asked };
}

test('Discord opens the DM channel of the partner and answers its id', async () => {
  const send = () => assert.fail('opening a chat sends nothing');
  const { adapter, asked } = discordOver(() => Promise.resolve({ id: 'dm-1', send }));
  assert.deepEqual(await adapter.dmChatOf(PARTNER), { status: 'ok', chatId: 'dm-1' });
  assert.deepEqual(asked, ['u1']);
});

test('Discord answers a partner it refuses as forbidden, and an unknown one as failed for good', async () => {
  const forbids = discordOver(() => Promise.reject(Object.assign(new Error('no'), { status: 403 })));
  const refused = await forbids.adapter.dmChatOf(PARTNER);
  assert.equal(refused.status, 'forbidden');
  const unknown = discordOver(() => Promise.reject(Object.assign(new Error('no'), { status: 404 })));
  const failed = await unknown.adapter.dmChatOf(PARTNER);
  assert.deepEqual([failed.status, failed.status !== 'ok' && failed.error.retryable], ['failed', false]);
});

test('Discord answers a server fault as failed and worth another try', async () => {
  const { adapter } = discordOver(() => Promise.reject(Object.assign(new Error('no'), { status: 503 })));
  const failed = await adapter.dmChatOf(PARTNER);
  assert.equal(failed.status !== 'ok' && failed.error.retryable, true);
});
