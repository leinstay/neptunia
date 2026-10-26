// What the replay tool still reads off the platform's own guild and channel objects: it runs over a discord.js client
// (REST only) and hands the engine's skills what a live turn gets from the interface instead. Every function takes
// `unknown` and narrows, so the objects of any platform fixture pass.

import type { MessageEvent } from '../../src/protocol/adapter.ts';
import type { Reads } from '../../src/interface/reads.ts';
import { createReads } from '../../src/interface/reads.ts';
import { takeSnapshot } from '../../src/behavior/snapshot.ts';
import { createFakeAdapter } from '../../src/interface/fake.js';
import { createDiscordAdapter } from '../../interfaces/discord/index.js';

type Obj = Record<string, unknown>;

const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' ? (value as Obj) : {});

/** The values of a `cache` Map-like, or none. */
function valuesOf(cache: unknown): Array<unknown> {
  const values = obj(cache).values;
  return typeof values === 'function' ? [...(values.call(cache) as Iterable<unknown>)] : [];
}

/**
 * The group ids `authorId` holds in the guild of `channel` (none when the member is not cached): what a replay over the
 * platform's own objects reads where a live turn asks the interface for the member.
 */
export function roleIdsOf(channel: unknown, authorId: unknown): Array<string> {
  const members = obj(obj(obj(channel).guild).members).cache;
  const get = obj(members).get;
  const member: unknown = typeof get === 'function' ? get.call(members, String(authorId)) : undefined;
  const roles = obj(obj(member).roles).cache;
  const keys = obj(roles).keys;
  return typeof keys === 'function' ? [...(keys.call(roles) as Iterable<unknown>)].map(String) : [];
}

type Requester = { id: string; roleIds: Array<string> } | null;

/**
 * src/behavior/turn.js#requesterOf over a discord.js channel: the roles of the requester are read off its guild.
 * `requesterOf` is the engine's function, taken as given.
 */
export function requesterOfChannel(requesterOf: unknown): (trigger: unknown, channel: unknown) => Requester {
  const requesterOfRoles = requesterOf as (trigger: object | null, roleIds: Array<string>) => Requester;
  return (trigger, channel) =>
    requesterOfRoles(
      trigger !== null && typeof trigger === 'object' ? trigger : null,
      roleIdsOf(channel, obj(trigger).authorId)
    );
}

/** The channels and the roles of the guild of a discord.js `channel` as the conversations and groups of a listing (names only). */
export function guildListing(channel: unknown): {
  conversations: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
} {
  const named = (cache: unknown): Array<{ id: string; name: string }> =>
    valuesOf(cache).flatMap((entry) => {
      const found = obj(entry);
      return typeof found.id === 'string' && typeof found.name === 'string' ? [{ id: found.id, name: found.name }] : [];
    });
  const held = obj(obj(channel).guild);
  return { conversations: named(obj(held.channels).cache), groups: named(obj(held.roles).cache) };
}

/** The replay's channel as the conversation info a skill is handed (the community when it has a guild). */
export function conversationOfChannel(
  channel: unknown,
  communityId: string
): { id: string; name: string | null; communityId: string | null } {
  const found = obj(channel);
  return {
    id: String(found.id),
    name: typeof found.name === 'string' ? found.name : null,
    communityId: found.guild ? communityId : null,
  };
}

/**
 * The conversation this replay runs in as the interface describes it, and the community's listing taken once: what a
 * live turn hands the recall runner (`channel` and `snapshot`).
 */
export async function recallScope(
  reads: Reads,
  channel: unknown,
  communityId: string
): Promise<{ channel: unknown; snapshot: unknown }> {
  const ref = conversationRef(channel);
  const [found, snapshot] = await Promise.all([
    reads.conversationInfo(ref, { audience: true }),
    takeSnapshot(reads, communityId, []),
  ]);
  return { channel: found?.conversation ?? conversationOfChannel(channel, communityId), snapshot };
}

const quiet = { info() {}, warn() {}, error() {} };

/**
 * The interface's reads over a discord.js client (the replay's, REST only): the history `conversation.read` asks for,
 * with the interface they belong to.
 */
export function discordReads(client: unknown, config: () => unknown): { reads: Reads; iface: string } {
  const port = createDiscordAdapter({ client: obj(client), config: config as () => object });
  return { reads: createReads(port, quiet), iface: port.iface };
}

/** The conversation reference of a discord.js channel: where a turn of the replay runs. */
export function conversationRef(channel: unknown): { iface: string; conversationId: string } {
  return { iface: 'discord', conversationId: String(obj(channel).id) };
}

type Hide = { any?: boolean; channels: Set<string>; messages: Set<string> };

/**
 * The interface's reads with the hidden channels and messages filtered out of what the request reads: the turn's
 * history (a hidden channel gives none, hidden messages are dropped), the listing the neighbours and the pulls take
 * (a hidden channel is not in it, so it is no candidate and a pull of it is skipped as not found), the info of a hidden
 * channel (none).
 */
export function hiddenReads<T extends Reads>(reads: T, hide: Hide): T {
  if (!hide.any) return reads;
  const hiddenChannel = (ref: { conversationId: string }): boolean => hide.channels.has(String(ref.conversationId));
  const keep = <E extends { message?: { id?: string } }>(events: ReadonlyArray<E>): Array<E> =>
    events.filter((event) => !hide.messages.has(String(event.message?.id)));
  const hidden: Reads = {
    ...reads,
    conversationInfo: async (ref, ...rest) => (hiddenChannel(ref) ? null : reads.conversationInfo(ref, ...rest)),
    conversations: async (...args) => {
      const found = await reads.conversations(...args);
      return found === null
        ? null
        : { ...found, conversations: found.conversations.filter((entry) => !hide.channels.has(entry.id)) };
    },
    history: async (ref, query) => {
      if (hiddenChannel(ref)) return { events: [], complete: true };
      const page = await reads.history(ref, query);
      return page === null ? null : { ...page, events: keep(page.events) };
    },
  };
  return hidden as T;
}

/**
 * The `message.received` event of a scripted line (the shape of src/behavior/line-of.js's output), as the interface's
 * history read gives it: the line a turn makes of the event is the line.
 */
export function eventOfLine(line: unknown, iface: string): MessageEvent {
  const found = obj(line);
  const at = found.ts;
  const event: Obj = {
    kind: 'message.received',
    iface,
    at,
    id: `${iface}:message:${String(found.id)}`,
    conversation: {
      id: found.channelId,
      kind: 'channel',
      communityId: null,
      name: found.channelName,
      topic: found.channelTopic,
      category: found.channelCategory,
    },
    message: {
      id: found.id,
      author: { id: found.authorId, name: found.authorName, self: found.self, bot: found.bot },
      content: found.content,
      sourceText: found.content,
      system: false,
      at,
      replyToId: found.replyToId,
      replyPingUserId: found.replyPingUserId,
      forwardedFrom: found.forwardedFrom,
      attachments: found.attachments,
      links: found.links,
      forwarded: found.forwarded,
      stickers: found.stickers,
      emojis: found.emojis,
      reactions: found.reactions,
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] },
  };
  return event as unknown as MessageEvent;
}

/**
 * The reads with the history of a conversation replaced by a script: `lines(ref, limit)` gives the lines (the shape of
 * src/behavior/line-of.js's output) the newest `limit` of the conversation holds, and the history read answers them as
 * events.
 */
export function scriptedReads<T extends Reads>(
  found: T,
  lines: (ref: { iface: string; conversationId: string }, limit: number) => ReadonlyArray<unknown>
): T {
  const scripted: Reads = {
    ...found,
    history: (ref, query) =>
      Promise.resolve({
        events: lines(ref, query.limit ?? 30).map((line) => eventOfLine(line, ref.iface)),
        complete: true,
      }),
  };
  return scripted as T;
}

/**
 * The scripted chat of the conversation a week's turn runs in: the lines the week's `world.chat` holds for it and the
 * name the fixture gives the channel.
 */
export function scriptedChatOf(
  world: unknown,
  fixture: unknown,
  conversation: unknown
): { lines: Array<unknown>; name: string | null } {
  const asked = String(obj(conversation).conversationId);
  const chat: unknown = obj(world).chat;
  const lines: unknown = chat instanceof Map ? (chat as Map<string, unknown>).get(asked) : undefined;
  const channels: unknown = obj(fixture).channels;
  const listed: Array<unknown> = Array.isArray(channels) ? (channels as Array<unknown>) : [];
  const channel = listed.find((entry) => obj(entry).id === asked);
  const name = obj(channel).name;
  return { lines: Array.isArray(lines) ? lines : [], name: typeof name === 'string' ? name : null };
}

/** The inner week's interface: the fixture's channels as conversations, writable or not, and the reads over them. */
export function weekReads(
  channels: ReadonlyArray<{ id: string; name: string; writable?: boolean }>,
  communityId: string,
  log: Parameters<typeof createReads>[1]
): { reads: Reads; iface: string } {
  const adapter = createFakeAdapter({ iface: 'inner-week', selfId: 'self' });
  const base = { kind: 'channel', communityId, chatType: 'channel', iface: adapter.iface } as const;
  const rest = { topic: null, category: null, owner: null, lastMessageAt: null, voice: false, public: true } as const;
  for (const { id, name, writable } of channels) {
    const permissions = { read: true, send: writable !== false, attach: true, react: true };
    adapter.seedConversation({ ...base, ...rest, audience: null, id, name, permissions });
  }
  return { reads: createReads(adapter, log), iface: adapter.iface };
}
