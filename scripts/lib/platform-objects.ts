// What the replay tool still reads off the platform's own guild and channel objects: it runs over a discord.js client
// (REST only) and hands the engine's skills what a live turn gets from the interface instead. Every function takes
// `unknown` and narrows, so the objects of any platform fixture pass.

import type { MessageEvent } from '../../src/protocol/adapter.ts';
import type { Reads } from '../../src/interface/reads.ts';
import { createReads } from '../../src/interface/reads.ts';
import { createFakeAdapter } from './fake.ts';
import { createDiscordAdapter } from '../../interfaces/discord/index.ts';
import type { Untyped } from '../../src/tools/types.ts';

type Obj = Record<string, unknown>;

/** The channel the cache of a guild or a client holds under `id`, undefined when it holds none. */
export function cachedChannel(holder: unknown, id: unknown): Untyped {
  const cache = obj(obj(holder).channels).cache;
  const get = obj(cache).get;
  return typeof get === 'function' ? get.call(cache, id) : undefined;
}

const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' ? (value as Obj) : {});

const quiet = { info() {}, warn() {}, error() {} };

/**
 * The interface's reads over a discord.js client (the replay's, REST only): the history `conversation.read` asks for,
 * with the interface they belong to.
 */
export function discordReads(client: unknown, config: () => unknown): { reads: Reads; iface: string } {
  const port = createDiscordAdapter({ client: obj(client), config: config as () => object });
  return { reads: createReads(port, quiet), iface: port.iface };
}

/** The chat reference of a discord.js channel: where a turn of the replay runs. */
export function chatRef(channel: unknown): { iface: string; chatId: string } {
  return { iface: 'discord', chatId: String(obj(channel).id) };
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
  const hiddenChannel = (ref: { chatId: string }): boolean => hide.channels.has(String(ref.chatId));
  const keep = <E extends { message?: { id?: string } }>(events: ReadonlyArray<E>): Array<E> =>
    events.filter((event) => !hide.messages.has(String(event.message?.id)));
  const hidden: Reads = {
    ...reads,
    chatInfo: async (ref, ...rest) => (hiddenChannel(ref) ? null : reads.chatInfo(ref, ...rest)),
    chats: async (...args) => {
      const found = await reads.chats(...args);
      return found === null ? null : { ...found, chats: found.chats.filter((entry) => !hide.channels.has(entry.id)) };
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
 * The `message.received` event of a scripted line (the shape of src/behavior/line-of.ts's output), as the interface's
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
    chat: {
      id: found.placeId,
      kind: 'channel',
      placeId: null,
      name: found.channelName,
      topic: found.channelTopic,
    },
    message: {
      id: found.id,
      author: { id: found.authorId, name: found.authorName, self: found.self, bot: found.bot },
      content: found.content,
      sourceText: found.content,
      system: false,
      at,
      replyToId: found.replyToId,
      replyPingAccountId: found.replyPingAccountId,
      forwardedFrom: found.forwardedFrom,
      attachments: found.attachments,
      links: found.links,
      forwarded: found.forwarded,
      stickers: found.stickers,
      emojis: found.emojis,
      reactions: found.reactions,
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
  return event as unknown as MessageEvent;
}

/** The inner week's interface: the fixture's channels as chats, writable or not, and the reads over them. */
export function weekReads(
  channels: ReadonlyArray<{ id: string; name: string; writable?: boolean }>,
  placeId: string,
  log: Parameters<typeof createReads>[1]
): { reads: Reads; iface: string } {
  const adapter = createFakeAdapter({ iface: 'inner-week', selfId: 'self' });
  const base = { kind: 'channel', rootId: placeId, chatType: 'channel', iface: adapter.iface } as const;
  const rest = { topic: null, owner: null, lastMessageAt: null, voice: false, public: true } as const;
  for (const { id, name, writable } of channels) {
    const permissions = { read: true, send: writable !== false, attach: true, react: true };
    adapter.seedChat({ ...base, ...rest, audience: null, id, name, permissions });
  }
  return { reads: createReads(adapter, log), iface: adapter.iface };
}
