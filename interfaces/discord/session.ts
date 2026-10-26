// The Discord session: everything that happens between the core's `start(host)` call and `stop()`. It builds the
// discord.js client, logs in, resolves the one guild this instance serves, connects the link and serves the
// Discord adapter over it, then carries every gateway event the core uses as a protocol event. Events that arrive
// before `open()` are held (at most 1,000, the oldest dropped) until the core's door has its handlers.
//
// `legacy` is what the core's subsystems still read from discord.js, one named field per seam. Each field names the
// stage 3 item of the core extraction plan that removes it, and the object disappears with the last of them.

import { Events } from 'discord.js';
import type { Client } from 'discord.js';
import type { InterfaceHost, RunningInterface } from '../../src/protocol/host.ts';
import { serveAdapter } from '../../src/protocol/serve.ts';
import { createAudienceWarmer } from './audience-warm.js';
import { connectionEvent, presenceEvent, presenceSnapshotEvent, voiceEvent } from './around.js';
import {
  canRead,
  isReadableChannel,
  normalizeOptions,
  reactionClearAllEvent,
  reactionClearEmojiEvent,
  reactionEvent,
  snowflakeTime,
  toEvent,
} from './collect.js';
import { registerCommands } from './commands.js';
import { createEmojiIndex } from './emoji.js';
import { createDiscordClient } from './gateway.js';
import { resolveGuild } from './guild.js';
import { createDiscordInterface } from './index.js';
import { memberView, membershipUpdatedEvent } from './members.ts';
import type { MemberView } from './members.ts';
import { DISCORD_IFACE } from './port.js';
import { applyReactionEvent, createReactorStore, reactionStoreEventOf } from './reactors.js';
import { createRawRegistry } from './raw-registry.ts';
import type { RawHandles } from './raw-registry.ts';

type Obj = Record<string, unknown>;

// The parts of the discord.js client this file touches. The listener type takes any argument list so that each
// handler can name the discord.js objects it reads.
type Gateway = {
  on(event: string, listener: (...args: Array<never>) => void): unknown;
  once(event: string, listener: (...args: Array<never>) => void): unknown;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void> | void;
  user: { id?: string; tag?: string; username?: string } | null;
  guilds: { cache: Map<string, Obj> };
  channels: { cache: Map<string, Obj>; fetch(id: string): Promise<unknown> };
  users?: { cache: Map<string, Obj> };
};

/**
 * What `start` hands the core as `RunningInterface.legacy`: the discord.js objects and reads its subsystems still
 * use, each field a seam that stage 3 of the core extraction removes (src/index.js lists the reader of each).
 */
export type DiscordLegacy = {
  client: Client;
  capabilities: ReturnType<typeof createDiscordInterface>['capabilities'];
  rawOf(event: { id: string }): RawHandles | null;
  guildId: string;
  selfId(): string | null;
  selfName(guildId: string): string;
  memberName(guildId: string, userId: string): string | null;
  resolveMember(guildId: string, userId: string): Promise<MemberView | null>;
  dmConversationOf(userId: string): string | null;
  catchUp: {
    channelInfo(channelId: string): { available: boolean; latestAt: number | null };
    fetchRecent(channelId: string, limit: number): Promise<Array<object>>;
    eventOf(message: object): object;
  };
  fetchOwnMessages(
    channelId: string,
    count: number
  ): Promise<Array<{ id: unknown; content: unknown; replyToId: string | null; createdAt: unknown }>>;
  reactors: ReturnType<typeof createReactorStore>;
  applyReaction(event: unknown): void;
  emoji: ReturnType<typeof createEmojiIndex>;
  serveCommands(onInteraction: (interaction: never) => unknown): { register(): Promise<unknown> };
};

/** How many gateway events are held before `open()`. */
const HELD_MAX = 1000;
/** How many messages of the persona the link keeps handles for. */
const HANDLES_KEPT = 2000;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' ? (value as Obj) : {});

// Whether a discord.js channel is a thread. Called on the channel itself: discord.js reads `this`.
const isThreadChannel = (channel: Obj): boolean =>
  typeof channel.isThread === 'function' && (channel as { isThread(): boolean }).isThread();

// A channel as the protocol's conversation: a thread names the channel it sits in.
function conversationOfChannel(channel: Obj, guildId: string): Obj {
  const isThread = isThreadChannel(channel);
  const parentName = text(obj(channel.parent).name);
  return {
    id: String(channel.id),
    kind: isThread ? 'thread' : 'channel',
    guildId,
    name: text(channel.name),
    topic: text(channel.topic),
    category: parentName,
    chatType: isThread ? 'thread' : 'channel',
    ...(isThread ? { parentId: text(channel.parentId) } : {}),
  };
}

function conversationChangedEvent(
  change: 'created' | 'updated' | 'deleted',
  channel: Obj,
  guildId: string,
  at: number
) {
  return {
    kind: 'conversation.changed',
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:conversation:${String(channel.id)}:${change}:${at}`,
    conversation: conversationOfChannel(channel, guildId),
    change,
  };
}

export async function start(host: InterfaceHost): Promise<RunningInterface> {
  const token = text(host.env.DISCORD_TOKEN);
  if (token === null) throw new Error('missing DISCORD_TOKEN');
  const { log } = host;
  const config = (): Obj => host.config();
  const intents = obj(obj(config().discord).intents);
  const client = (host.createClient ?? createDiscordClient)({
    presences: intents.presences === true,
    members: intents.members === true,
  }) as Gateway;

  // Registered before the login: ClientReady may arrive while login still resolves.
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  try {
    await client.login(token);
  } catch (err) {
    throw new Error(`Discord login failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await ready;

  const guilds = [...client.guilds.cache.values()].map((guild) => ({ id: String(guild.id), name: String(guild.name) }));
  const resolved = resolveGuild(text(obj(config().bot).guildId) ?? '', guilds);
  if ('error' in resolved) {
    await client.destroy();
    throw new Error(resolved.error);
  }
  const guildId = resolved.guildId;
  const guildNow = (): Obj | null => client.guilds.cache.get(guildId) ?? null;
  const selfId = (): string | null => client.user?.id ?? null;

  const discord = createDiscordInterface({ client });
  const served = serveAdapter({
    transport: await host.connect(),
    hello: { iface: discord.port.iface, capabilities: discord.port.capabilities(), resume: null },
    token: host.token,
    adapter: discord.port,
    log,
  });

  const handles = createRawRegistry({ capacity: HANDLES_KEPT });
  const reactors = createReactorStore({
    maxMessages: () => Number(obj(obj(config().context).reactions).maxMessages ?? 500),
  });
  const audienceWarmer = createAudienceWarmer({ getGuild: guildNow, logger: log });

  // Events are held until open(): the core's door has no handlers before it.
  let held: Array<{ kind: string; event: Obj }> | null = [];
  let dropped = 0;

  function deliver(kind: string, event: Obj): void {
    // The discord.js message behind a message event stays here, under the event id, for the pipeline's `rawOf`.
    if (kind === 'message.received' && event.raw)
      handles.put(String(event.id), { message: event.raw, previous: event.rawPrevious ?? null });
    void served.emit(event).then((status) => {
      if (status !== 'ok' && status !== 'duplicate') log.warn('interface: event not taken', { kind, status });
    });
  }

  function inbound(kind: string, build: () => unknown): void {
    let event: Obj;
    try {
      event = obj(build());
    } catch (err) {
      log.warn('interface: invalid event', {
        kind,
        reason: 'build-failed',
        name: err instanceof Error ? err.name : null,
      });
      return;
    }
    if (held === null) return deliver(kind, event);
    if (held.length >= HELD_MAX) {
      held.shift();
      if (dropped === 0)
        log.warn('interface: events held before open overflowed, the oldest are dropped', { limit: HELD_MAX });
      dropped += 1;
    }
    held.push({ kind, event });
  }

  // The live snapshot (`<people_now>`) follows the gateway: a fresh session delivers the guild's state again, so
  // it is announced again together with the names of the conversations the client holds.
  function announceGuild(): void {
    const guild = guildNow();
    if (guild === null) return;
    const at = Date.now();
    inbound('presence.snapshot', () => presenceSnapshotEvent(guild, at));
    inbound('connection.changed', () => connectionEvent('resumed', at));
    const bot = obj(config().bot);
    for (const channel of client.channels.cache.values()) {
      if (obj(channel.guild).id !== guildId) continue;
      const readable = isThreadChannel(channel) ? canRead(channel) : isReadableChannel(channel, bot);
      if (readable) inbound('conversation.changed', () => conversationChangedEvent('updated', channel, guildId, at));
    }
  }

  const inGuild = (value: unknown): boolean => obj(obj(value).guild).id === guildId;
  const on = (event: string, listener: (...args: Array<never>) => void): void => void client.on(event, listener);

  on(Events.MessageCreate, (message: Obj) => {
    inbound('message.received', () => toEvent(message, selfId() ?? '', normalizeOptions(config())));
  });
  // Discord attaches some embeds (a Tenor GIF's) after the message arrived: fold them into memory.
  on(Events.MessageUpdate, (oldMessage: Obj, newMessage: Obj) => {
    inbound('message.received', () =>
      toEvent(newMessage, selfId() ?? '', { ...normalizeOptions(config()), edit: true, previous: oldMessage })
    );
  });
  on(Events.MessageDelete, (message: Obj) => {
    inbound('message.received', () => toEvent(message, selfId() ?? '', { deleted: true }));
  });

  // A new or edited channel of the served guild may name a member the cache has not seen.
  const channelChanged = (change: 'created' | 'updated' | 'deleted', channel: Obj): void => {
    if (!inGuild(channel)) return;
    if (change !== 'deleted') void audienceWarmer.warm({ quiet: true });
    inbound('conversation.changed', () => conversationChangedEvent(change, channel, guildId, Date.now()));
  };
  on(Events.ChannelCreate, (channel: Obj) => channelChanged('created', channel));
  on(Events.ChannelUpdate, (_old: Obj, channel: Obj) => channelChanged('updated', channel));
  on(Events.ChannelDelete, (channel: Obj) => channelChanged('deleted', channel));
  on(Events.ThreadCreate, (thread: Obj) => channelChanged('created', thread));
  on(Events.ThreadUpdate, (_old: Obj, thread: Obj) => channelChanged('updated', thread));
  on(Events.ThreadDelete, (thread: Obj) => channelChanged('deleted', thread));

  on(Events.VoiceStateUpdate, (old: Obj, state: Obj) => {
    if (inGuild(state)) inbound('voice.changed', () => voiceEvent(state, Date.now(), old));
  });
  on(Events.PresenceUpdate, (_old: Obj, presence: Obj) => {
    if (inGuild(presence)) inbound('presence.changed', () => presenceEvent(presence, Date.now()));
  });

  // A changed avatar of a member reaches the core as `membership.changed` (the member and user updates need
  // discord.intents.members; a member's own message carries the avatar on the message).
  on(Events.GuildMemberUpdate, (_old: Obj, member: Obj) => {
    if (inGuild(member)) inbound('membership.changed', () => membershipUpdatedEvent(member, Date.now()));
  });
  on(Events.UserUpdate, (_old: Obj, user: Obj) => {
    const members = obj(guildNow()?.members) as { cache?: Map<string, Obj> };
    const member = members.cache?.get(String(user.id));
    if (member) inbound('membership.changed', () => membershipUpdatedEvent(member, Date.now()));
  });

  on(Events.MessageReactionAdd, (reaction: Obj, user: Obj) => {
    inbound('reaction.changed', () => reactionEvent(reaction, user, true));
  });
  on(Events.MessageReactionRemove, (reaction: Obj, user: Obj) => {
    inbound('reaction.changed', () => reactionEvent(reaction, user, false));
  });
  on(Events.MessageReactionRemoveAll, (message: Obj) => {
    inbound('reaction.changed', () => reactionClearAllEvent(message));
  });
  on(Events.MessageReactionRemoveEmoji, (reaction: Obj) => {
    inbound('reaction.changed', () => reactionClearEmojiEvent(reaction));
  });

  on(Events.ShardDisconnect, () => inbound('connection.changed', () => connectionEvent('lost', Date.now())));
  on(Events.ShardReconnecting, () => inbound('connection.changed', () => connectionEvent('lost', Date.now())));
  on(Events.ShardResume, () => inbound('connection.changed', () => connectionEvent('resumed', Date.now())));
  on(Events.ShardReady, announceGuild);

  // The slash commands: the core hands over its interaction handler once its admin exists, and the command tree
  // is registered again when the name or the switch changed.
  let commandsServed = false;
  let commandName = text(obj(config().bot).commandName);
  let adminCommandsOn = obj(config().features).adminCommands !== false;
  const stopWatching = host.onConfigChange((what) => {
    if (what !== 'config' || !commandsServed) return;
    const nextName = text(obj(config().bot).commandName);
    const nextOn = obj(config().features).adminCommands !== false;
    if (nextName === commandName && nextOn === adminCommandsOn) return;
    commandName = nextName;
    adminCommandsOn = nextOn;
    const guild = guildNow();
    if (guild !== null) {
      registerCommands(guild as never, config()).catch((err: unknown) =>
        log.error('interface: failed to re-register commands', { error: err })
      );
    }
  });

  function serveCommands(onInteraction: (interaction: never) => unknown): { register(): Promise<unknown> } {
    on(Events.InteractionCreate, onInteraction);
    commandsServed = true;
    return { register: () => registerCommands(guildNow() as never, config()) };
  }

  announceGuild();

  // stage 3, "The rest of the core without discord.js": every field below goes when its reader reads the
  // protocol instead. The field named after a reader says which.
  const legacy: DiscordLegacy = {
    // The discord.js client, for the modules that still take it (the turn runner, the memory jobs, the admin).
    client: client as unknown as Client,
    // The functions the core still asks Discord by name (permissions, history, pulls, searches).
    capabilities: discord.capabilities,
    // The discord.js message behind a message event, by the event id (the message pipeline).
    rawOf: (event: { id: string }) => handles.rawOf(event),
    guildId,
    selfId,
    // The persona's display name in a guild (every request's name for her).
    selfName: (id: string): string => {
      const member = obj(obj(client.guilds.cache.get(id)).members).me as { displayName?: string } | undefined;
      return member?.displayName ?? client.user?.username ?? 'bot';
    },
    // The name of a cached member (the embedding queue).
    memberName: (id: string, userId: string): string | null => {
      const members = obj(client.guilds.cache.get(id)?.members) as { cache?: Map<string, Obj> };
      return text(members.cache?.get(userId)?.displayName);
    },
    // A member by one REST fetch, as the avatar queue reads it (null: not in the guild).
    resolveMember: async (id: string, userId: string): Promise<MemberView | null> => {
      const members = obj(client.guilds.cache.get(id)?.members) as { fetch?: (id: string) => Promise<Obj> };
      if (members.fetch === undefined) return null;
      return memberView(await members.fetch(userId).catch(() => null));
    },
    // The private conversation with a member, when the client knows it (a memory session failure is told there).
    dmConversationOf: (userId: string): string | null => text(obj(obj(client.users?.cache.get(userId)).dmChannel).id),
    // The offline catch-up: what Discord says of a channel, its newest messages, and a message as an event.
    catchUp: {
      channelInfo(channelId: string): { available: boolean; latestAt: number | null } {
        const channel = client.channels.cache.get(channelId);
        const messages = obj(channel?.messages);
        if (!channel || obj(channel.guild).id !== guildId || typeof messages.fetch !== 'function')
          return { available: false, latestAt: null };
        const last = text(channel.lastMessageId);
        return { available: true, latestAt: last === null ? null : snowflakeTime(last) };
      },
      async fetchRecent(channelId: string, limit: number): Promise<Array<object>> {
        const channel = (client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId))) as Obj;
        const messages = await (channel.messages as { fetch(options: Obj): Promise<Map<string, object>> }).fetch({
          limit,
        });
        return [...messages.values()];
      },
      eventOf: (message: object): object => toEvent(message, selfId() ?? '', normalizeOptions(config())),
    },
    // The persona's last messages of a channel, as the journal's reconciliation reads them.
    fetchOwnMessages: async (channelId: string, count: number) => {
      const channel = (await client.channels.fetch(channelId)) as Obj;
      const fetched = await (channel.messages as { fetch(options: Obj): Promise<Map<string, Obj>> }).fetch({
        limit: count,
      });
      return [...fetched.values()]
        .filter((message) => obj(message.author).id === client.user?.id)
        .map((message) => ({
          id: message.id,
          content: message.content,
          replyToId: text(obj(message.reference).messageId),
          createdAt: message.createdTimestamp,
        }));
    },
    // Who reacted to the persona's messages (the turn runner's history fetch).
    reactors,
    // One `reaction.changed` event into the reactor store, whatever features.reactionNames says.
    applyReaction: (event: unknown): void => {
      try {
        applyReactionEvent(reactors, reactionStoreEventOf(event as never), { guildId, selfId: selfId() });
      } catch (err) {
        log.warn('reactors: event failed', { kind: obj(event).kind ?? null, code: obj(err).code ?? null });
      }
    },
    // The served guild's custom emoji (a live view over discord.js's own cache).
    emoji: createEmojiIndex(client, () => guildId),
    serveCommands,
  };

  return {
    iface: discord.port.iface,
    legacy,
    open(): void {
      if (held === null) return;
      const waiting = held;
      held = null;
      if (dropped > 0) log.warn('interface: events dropped before open', { dropped });
      for (const { kind, event } of waiting) deliver(kind, event);
      // The members named by channel overwrites, fetched so the audience rail knows which are bots.
      void audienceWarmer.warm();
    },
    async stop(): Promise<void> {
      stopWatching();
      served.close();
      await client.destroy();
    },
  };
}
