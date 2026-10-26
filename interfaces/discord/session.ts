// The Discord session: everything that happens between the core's `start(host)` call and `stop()`. It builds the
// discord.js client, logs in, resolves the one guild this instance serves, connects the link and serves the
// Discord adapter over it, then carries every gateway event the core uses as a protocol event. Events that arrive
// before `open()` are held (at most 1,000, the oldest dropped) until the core's door has its handlers.
//
// `legacy` holds the slash command handler, the one thing the core takes besides the adapter. The conversation reads,
// the reactions and the direct chats of the turn, the message pipeline and the tools are answered over the link by the
// adapter (reads.ts) and the events.

import { Events } from 'discord.js';
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
  toEvent,
} from './collect.js';
import { createInteractionHandler, registerCommands } from './commands.js';
import { createDiscordClient } from './gateway.js';
import { resolveGuild } from './guild.js';
import { createDiscordInterface } from './index.js';
import { memberView, membershipUpdatedEvent } from './members.ts';
import { DISCORD_IFACE } from './port.js';

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

/** What `start` hands the core as `RunningInterface.legacy` (src/interface/legacy.ts is the core's view of it). */
export type DiscordLegacy = {
  serveCommands(admin: unknown): { register(): Promise<unknown> };
};

/** How many gateway events are held before `open()`. */
const HELD_MAX = 1000;

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
    communityId: guildId,
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

// The `hot` the interaction handler reads: its `config` is the live config at each read.
const liveConfig = (read: () => Obj) => ({
  get config(): Obj {
    return read();
  },
});

// The persona's display name in a guild, the name her hello gives the core: her nickname there, else her username.
function displayNameIn(guild: Obj | null, user: { username?: string } | null): string {
  const member = obj(obj(guild).members).me as { displayName?: string } | undefined;
  return member?.displayName ?? user?.username ?? 'bot';
}

// The members the client holds, as `membership.changed` events: the core's member directory (names, nicknames) starts
// from them. Delivered on `open()` before anything held, never counted against the held events.
function memberEvents(guild: Obj | null): Array<Obj> {
  const members = obj(guild?.members) as { cache?: Map<string, Obj> };
  const at = Date.now();
  const events: Array<Obj> = [];
  for (const member of members.cache?.values() ?? []) {
    if (memberView(member) === null) continue;
    try {
      events.push(membershipUpdatedEvent(member, at));
    } catch {
      // A member without a guild is not one of this guild's members.
    }
  }
  return events;
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

  const discord = createDiscordInterface({ client, config });
  const served = serveAdapter({
    transport: await host.connect(),
    hello: {
      iface: discord.port.iface,
      self: { id: selfId() ?? '', name: displayNameIn(guildNow(), client.user) },
      community: { id: guildId, name: guilds.find((guild) => guild.id === guildId)?.name ?? guildId },
      // What the gateway reports depends on the intents it was asked for: presences only with that intent.
      capabilities: { ...discord.port.capabilities(), presence: intents.presences === true },
      resume: null,
    },
    token: host.token,
    adapter: discord.port,
    log,
  });

  const audienceWarmer = createAudienceWarmer({ getGuild: guildNow, logger: log });

  // Events are held until open(): the core's door has no handlers before it.
  let held: Array<{ kind: string; event: Obj }> | null = [];
  let dropped = 0;

  function deliver(kind: string, event: Obj): void {
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

  // The slash commands: the core hands over its admin once it exists, the session builds the interaction handler
  // over it, and the command tree is registered again when the name or the switch changed.
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

  function serveCommands(admin: unknown): { register(): Promise<unknown> } {
    const onInteraction = createInteractionHandler({ hot: liveConfig(config), admin, getGuildId: () => guildId });
    on(Events.InteractionCreate, (interaction: Parameters<typeof onInteraction>[0]) => void onInteraction(interaction));
    commandsServed = true;
    return { register: () => registerCommands(guildNow() as never, config()) };
  }

  announceGuild();

  // What the core takes besides the adapter: the slash command handler.
  const legacy: DiscordLegacy = { serveCommands };

  return {
    iface: discord.port.iface,
    legacy,
    open(): void {
      if (held === null) return;
      const waiting = held;
      held = null;
      for (const event of memberEvents(guildNow())) deliver('membership.changed', event);
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
