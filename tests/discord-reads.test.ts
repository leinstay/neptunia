// The conversation reads of the Discord adapter (`createDiscordAdapter({ client, config })`) over a stub discord.js
// client: each read answers what the old function of interfaces/discord did with the same stub. The history read gives
// events whose `lineOf` (src/behavior/line-of.js) equals the lines `fetchHistory` and its siblings return. Discord
// objects are plain stubs shaped just enough for the code to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
  createDiscordAdapter,
  fetchAfter,
  fetchAround,
  fetchBefore,
  fetchHistory,
  fetchHistoryWindow,
  lastActivity,
  normalizeOptions,
} from '../interfaces/discord/index.js';
import { lineOf } from '../src/behavior/line-of.js';
import type { MessageEvent } from '../src/protocol/adapter.ts';

type Raw = Record<string, unknown>;
type Channel = Parameters<typeof fetchHistory>[0];

const CHANNEL = { iface: 'discord', conversationId: 'c1' };
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

test('reports a server channel with its name, topic, category and community, and no owner', async () => {
  const { adapter } = world();
  const result = await adapter.conversationInfo(CHANNEL);
  if (result.status !== 'ok') throw new Error(result.status);
  const { conversation } = result;
  assert.equal(conversation.kind, 'channel');
  assert.equal(conversation.communityId, 'g1');
  assert.equal(conversation.name, 'general');
  assert.equal(conversation.topic, 'daily talk');
  assert.equal(conversation.category, 'main');
  assert.equal(conversation.iface, 'discord');
  assert.equal(conversation.owner, null);
  assert.equal(conversation.voice, false);
});

test('reports the time of the newest message from its snowflake, like lastActivity', async () => {
  const { adapter, channel } = world();
  const stamped = { ...channel, lastMessageId: snowflakeOf(1_700_000_000_000) };
  const client = clientOf(guildOf([stamped]), [stamped]);
  const result = await createDiscordAdapter({ client, config: () => ({}) }).conversationInfo(CHANNEL);
  if (result.status !== 'ok') throw new Error(result.status);
  assert.equal(result.conversation.lastMessageAt, lastActivity(asChannel(stamped)));
  const none = await adapter.conversationInfo({ iface: 'discord', conversationId: 'c1' });
  assert.equal(none.status, 'ok');
});

test('reports a private chat as a direct conversation with its partner and no community', async () => {
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
  const result = await createDiscordAdapter({ client, config: () => ({}) }).conversationInfo(CHANNEL);
  if (result.status !== 'ok') throw new Error(result.status);
  assert.equal(result.conversation.kind, 'dm');
  assert.equal(result.conversation.communityId, null);
  assert.equal(result.conversation.partnerId, 'u1');
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
  const result = await createDiscordAdapter({ client, config: () => ({}) }).conversationInfo(CHANNEL);
  if (result.status !== 'ok') throw new Error(result.status);
  assert.equal(result.conversation.kind, 'thread');
  assert.equal(result.conversation.parentId, 'c0');
});

test('lists text channels, threads and voice rooms of a community with its groups, and no category', async () => {
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
  const result = await adapter.conversations({ communityId: 'g1' });
  if (result.status !== 'ok') throw new Error(result.status);
  assert.deepEqual(result.conversations.map((entry) => entry.id).sort(), ['t1', 't2', 'v1']);
  assert.equal(result.conversations.find((entry) => entry.id === 'v1')?.voice, true);
  assert.deepEqual(
    result.groups.find((group) => group.id === 'r1'),
    { id: 'r1', name: 'mods' }
  );
});

test('reads the newest lines as events whose lines equal fetchHistory', async () => {
  const { adapter, channel } = world();
  const events = eventsOf(await adapter.history(CHANNEL, { limit: 3 }));
  const lines = await fetchHistory(asChannel(channel), { limit: 3, ...options });
  assert.deepEqual(events.map(lineOf), lines);
  assert.deepEqual(
    events.map((event) => event.message.id),
    ['1003', '1004', '1005']
  );
});

test('reads the lines at or after a floor like fetchHistoryWindow', async () => {
  const { adapter, channel } = world();
  const events = eventsOf(await adapter.history(CHANNEL, { limit: 10, since: 3000 }));
  const lines = await fetchHistoryWindow(asChannel(channel), { limit: 10, minTs: 3000, ...options });
  assert.deepEqual(events.map(lineOf), lines);
  assert.deepEqual(
    events.map((event) => event.message.id),
    ['1003', '1004', '1005']
  );
});

test('reads the lines before, after and around a message like the search helpers', async () => {
  const { adapter, channel } = world();
  const stub = asChannel(channel);
  const before = eventsOf(await adapter.history(CHANNEL, { limit: 2, before: '1004' }));
  assert.deepEqual(before.map(lineOf), await fetchBefore(stub, '1004', 2, options));
  const after = eventsOf(await adapter.history(CHANNEL, { limit: 2, after: '1002' }));
  assert.deepEqual(after.map(lineOf), await fetchAfter(stub, '1002', 2, options));
  const around = eventsOf(await adapter.history(CHANNEL, { limit: 3, around: '1003' }));
  assert.deepEqual(around.map(lineOf), await fetchAround(stub, '1003', 3, options));
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
  assert.equal(found?.event?.message.content, 'two');
  assert.equal(found?.event?.conversation.id, 'c1');
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
  const found = await adapter.memberInfo({ communityId: 'g1', memberId: 'u1' });
  if (found.status !== 'ok') throw new Error(found.status);
  assert.deepEqual(found.member?.groupIds, ['r1', 'r2']);
  assert.equal(found.member?.name, 'Eleni');
  const stranger = await adapter.memberInfo({ communityId: 'g1', memberId: 'u9' });
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
  const result = await adapter.memberInfo({ communityId: 'g1', memberId: SELF });
  if (result.status !== 'ok') throw new Error(result.status);
  assert.equal(result.member?.avatar.largeUrl, 'https://cdn/self.png?size=1024');
});

function restWith(body: unknown) {
  const sent: Array<{ route: string; query: URLSearchParams }> = [];
  const rest = {
    get: (route: string, init: { query: URLSearchParams }) => {
      sent.push({ route, query: init.query });
      return Promise.resolve(body);
    },
  };
  return { sent, client: { rest } };
}

test('searches messages by text and author with the time bounds turned into snowflakes', async () => {
  const body = {
    total_results: 41,
    messages: [
      [
        {
          id: '55',
          channel_id: 'c1',
          timestamp: '2026-10-10T10:00:00.000Z',
          content: 'pasta',
          hit: true,
          author: { id: 'u1', username: 'eleni', global_name: 'Eleni', bot: false },
        },
      ],
    ],
  };
  const { sent, client } = restWith(body);
  const { adapter } = world({ client: { rest: client.rest } });
  const result = await adapter.searchMessages(
    { communityId: 'g1' },
    { text: 'pasta', authorId: 'u1', after: 1_700_000_000_000, before: 1_700_100_000_000, offset: 25 }
  );
  if (result.status !== 'ok') throw new Error(result.status);
  assert.equal(result.total, 41);
  assert.deepEqual(result.hits[0]?.ref, { iface: 'discord', conversationId: 'c1', messageId: '55' });
  assert.equal(result.hits[0]?.at, Date.parse('2026-10-10T10:00:00.000Z'));
  assert.equal(result.hits[0]?.text, 'pasta');
  assert.deepEqual(result.hits[0]?.author, { id: 'u1', handle: 'eleni', displayName: 'Eleni', bot: false });
  const query = sent[0]?.query;
  assert.equal(sent[0]?.route, '/guilds/g1/messages/search');
  assert.equal(query?.get('content'), 'pasta');
  assert.equal(query?.get('author_id'), 'u1');
  assert.equal(query?.get('min_id'), snowflakeOf(1_700_000_000_000));
  assert.equal(query?.get('max_id'), snowflakeOf(1_700_100_000_000));
  assert.equal(query?.get('offset'), '25');
});

test('fails a message search when Discord has not indexed the community yet', async () => {
  const { client } = restWith({ message: 'Index not yet available' });
  const { adapter } = world({ client: { rest: client.rest } });
  assert.equal((await adapter.searchMessages({ communityId: 'g1' }, { text: 'x' })).status, 'failed');
});

test('searches members by the start of a name and names the fields neutrally', async () => {
  const body = [{ user: { id: 'u1', username: 'eleni', global_name: 'Eleni', bot: false }, nick: 'Ele' }];
  const { sent, client } = restWith(body);
  const { adapter } = world({ client: { rest: client.rest } });
  const result = await adapter.searchMembers({ communityId: 'g1' }, { prefix: 'el', limit: 5 });
  if (result.status !== 'ok') throw new Error(result.status);
  assert.deepEqual(result.members, [{ id: 'u1', handle: 'eleni', displayName: 'Eleni', nickname: 'Ele', bot: false }]);
  assert.equal(sent[0]?.query.get('query'), 'el');
  assert.equal(sent[0]?.query.get('limit'), '5');
});

test('lists the custom emoji of a server with their pictures and leaves out an unavailable one', async () => {
  const emojis = new Map<string, Raw>([
    ['e1', { id: 'e1', name: 'kek', animated: false, available: true }],
    ['e2', { id: 'e2', name: 'gone', animated: true, available: false }],
  ]);
  const { adapter } = world({ guild: { emojis: { cache: emojis } } });
  const result = await adapter.emoji({ communityId: 'g1' });
  if (result.status !== 'ok') throw new Error(result.status);
  assert.deepEqual(
    result.emoji.map((entry) => [entry.id, entry.name, entry.animated]),
    [['e1', 'kek', false]]
  );
  assert.equal(result.emoji[0]?.url.startsWith('https://cdn.discordapp.com/emojis/e1'), true);
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
    { iface: 'discord', conversationId: '222', messageId: '333' },
    { iface: 'discord', conversationId: '444', messageId: '555' },
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
  assert.deepEqual(result.memberIds, ['u1', 'u2']);
  assert.deepEqual(fetched, [{ limit: 7 }]);
});

test('fails the reactors of an emoji nobody put on the message', async () => {
  const { adapter } = world();
  assert.equal((await adapter.reactors({ ...CHANNEL, messageId: '1005' }, '🔥', 7)).status, 'failed');
});
