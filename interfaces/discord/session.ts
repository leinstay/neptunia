// The Discord session: everything that happens between the core's `start(host)` call and `stop()`. It builds the
// discord.js client, logs in, resolves the one guild this instance serves, connects the link and serves the
// Discord adapter over it, then carries every gateway event the core uses as a protocol event. Events that arrive
// before `open()` are held (at most 1,000, the oldest dropped) until the core's door has its handlers.
//
// The chat reads, the reactions and the direct chats of the turn, the message pipeline and the tools are
// answered over the link by the adapter (reads.ts) and the events. The interface registers no slash command. On its
// first connect it deletes every application command its bot still has on the guild and logs how many, and an
// interaction that still arrives gets a short ephemeral refusal and never reaches the core.
//
// With a data folder (`host.dataDir`) the session numbers its events in an outbox there (src/protocol/outbox.ts), so
// what the core did not acknowledge goes again after a restart of either side. `reconnect()` opens a new link with
// `host.connect()`, says hello again and resends the outbox, keeping the Discord client.

import path from 'node:path';
import { Events, MessageFlags } from 'discord.js';
import type { InterfaceHost, RunningInterface } from '../../src/protocol/host.ts';
import { createOutbox } from '../../src/protocol/outbox.ts';
import { serveAdapter } from '../../src/protocol/serve.ts';
import { createAudienceWarmer } from './audience-warm.ts';
import { connectionEvent, presenceEvent, presenceSnapshotEvent, voiceEvent } from './around.ts';
import {
  canRead,
  chatOfChannel,
  isReadableChannel,
  normalizeOptions,
  reactionClearAllEvent,
  reactionClearEmojiEvent,
  reactionEvent,
  toEvent,
} from './collect.ts';
import { createDiscordClient } from './gateway.ts';
import { resolveGuilds } from './guild.ts';
import { createDiscordInterface } from './index.ts';
import { memberView, membershipUpdatedEvent } from './members.ts';
import { DISCORD_IFACE } from './port.ts';

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

/** How many gateway events are held before `open()`. */
const HELD_MAX = 1000;

/** How many unacknowledged events the outbox holds. */
const OUTBOX_CAPACITY = 1000;

/** What Discord is called and what it calls its kinds of place and a direct chat, for `hello.names`. */
const DISCORD_NAMES = {
  interface: 'Discord',
  nouns: { server: 'server', channel: 'channel', thread: 'thread' },
  dm: 'DM',
};

/** What an interaction for a slash command of this bot is answered: the interface registers none. */
const NO_COMMAND_REPLY = 'This command no longer exists.';

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' ? (value as Obj) : {});

// Whether a discord.js channel is a thread. Called on the channel itself: discord.js reads `this`.
const isThreadChannel = (channel: Obj): boolean =>
  typeof channel.isThread === 'function' && (channel as { isThread(): boolean }).isThread();

function chatChangedEvent(change: 'created' | 'updated' | 'deleted', channel: Obj, guildId: string, at: number) {
  return {
    kind: 'chat.changed',
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:chat:${String(channel.id)}:${change}:${at}`,
    chat: chatOfChannel(channel, guildId),
    change,
  };
}

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

// The application commands the bot still has on the guild, deleted one by one: the interface registers none. A guild
// that refuses the listing (Discord error 50001, a bot invited without the `applications.commands` scope) is logged.
async function deleteCommandsOf(guild: Obj | null, log: InterfaceHost['log']): Promise<void> {
  const manager = obj(guild?.commands) as {
    fetch?: () => Promise<Map<string, unknown>>;
    delete?: (command: unknown) => Promise<unknown>;
  };
  if (typeof manager.fetch !== 'function' || typeof manager.delete !== 'function') return;
  try {
    const registered = await manager.fetch();
    for (const id of registered.keys()) await manager.delete(id);
    log.info('interface: slash commands deleted', { deleted: registered.size });
  } catch (err) {
    log.warn('interface: slash commands not deleted', { code: obj(err).code ?? null });
  }
}

// The parts of a discord.js interaction the refusal touches.
type Interaction = {
  isAutocomplete?: () => boolean;
  respond?: (choices: Array<unknown>) => Promise<unknown>;
  reply?: (payload: unknown) => Promise<unknown>;
};

// An interaction for a slash command, answered with a short ephemeral refusal. An autocomplete gets no choices.
async function refuseInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isAutocomplete?.() === true) await interaction.respond?.([]);
    else await interaction.reply?.({ content: NO_COMMAND_REPLY, flags: MessageFlags.Ephemeral });
  } catch {
    // An interaction Discord already expired cannot be answered, and nothing reaches the core either way.
  }
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

  const guildCache = client.guilds.cache;
  const guilds = [...guildCache.values()].map((guild) => ({ id: String(guild.id), name: String(guild.name) }));
  const listed = Array.isArray(config().servers) ? (config().servers as Array<unknown>).map(String) : [];
  const resolved = resolveGuilds(listed, text(obj(config().bot).guildId) ?? '', guilds);
  if ('error' in resolved) {
    await client.destroy();
    throw new Error(resolved.error);
  }
  if (resolved.missing.length > 0)
    log.warn('interface: listed servers the bot is not in', { missing: resolved.missing });
  const { guildIds } = resolved;
  const guildById = (id: string): Obj | null => guildCache.get(id) ?? null;
  // The first server names the persona in `hello`; her name in the others comes with each of their events.
  const guildNow = (): Obj | null => guildById(guildIds[0] ?? '');
  const rootOf = (id: string) => ({ id, name: guilds.find((guild) => guild.id === id)?.name ?? '' });
  const selfId = (): string | null => client.user?.id ?? null;

  const discord = createDiscordInterface({ client, config });
  const outbox =
    host.dataDir === undefined
      ? undefined
      : createOutbox({ dir: path.join(host.dataDir, 'outbox'), capacity: OUTBOX_CAPACITY });
  const serve = async (): Promise<ReturnType<typeof serveAdapter>> =>
    serveAdapter({
      transport: await host.connect(),
      hello: {
        iface: discord.port.iface,
        self: { id: selfId() ?? '', name: displayNameIn(guildNow(), client.user) },
        root: rootOf(guildIds[0] ?? ''),
        roots: guildIds.map(rootOf),
        names: DISCORD_NAMES,
        // What the gateway reports depends on the intents it was asked for: presences only with that intent.
        capabilities: { ...discord.port.capabilities(), presence: intents.presences === true },
        resume: null,
      },
      token: host.token,
      adapter: discord.port,
      log,
      ...(outbox === undefined ? {} : { outbox }),
    });
  let served = await serve();

  const audienceWarmers = guildIds.map((id) => createAudienceWarmer({ getGuild: () => guildById(id), logger: log }));
  const warmAudiences = (options?: { quiet: boolean }): void => {
    for (const warmer of audienceWarmers) void warmer.warm(options);
  };

  // Events are held until open(): the core's door has no handlers before it.
  let held: Array<{ kind: string; event: Obj }> | null = [];
  let dropped = 0;
  // Set by stop(): the link is closed, so the shard disconnect that client.destroy() fires has nowhere to go.
  let stopped = false;

  function deliver(kind: string, event: Obj): void {
    void served.emit(event).then((status) => {
      if (status !== 'ok' && status !== 'duplicate') log.warn('interface: event not taken', { kind, status });
    });
  }

  function inbound(kind: string, build: () => unknown): void {
    if (stopped) return;
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
  // it is announced again together with the names of the chats the client holds.
  function announceGuild(id: string): void {
    const guild = guildById(id);
    if (guild === null) return;
    const at = Date.now();
    inbound('presence.snapshot', () => presenceSnapshotEvent(guild, at));
    const channelCache = client.channels.cache;
    for (const channel of channelCache.values()) {
      if (obj(channel.guild).id !== id) continue;
      const readable = isThreadChannel(channel) ? canRead(channel) : isReadableChannel(channel);
      if (readable) inbound('chat.changed', () => chatChangedEvent('updated', channel, id, at));
    }
  }
  function announceGuilds(): void {
    inbound('connection.changed', () => connectionEvent('resumed', Date.now()));
    for (const id of guildIds) announceGuild(id);
  }

  const inGuild = (value: unknown): boolean => guildIds.includes(String(obj(obj(value).guild).id));
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
    if (change !== 'deleted') warmAudiences({ quiet: true });
    inbound('chat.changed', () => chatChangedEvent(change, channel, String(obj(channel.guild).id), Date.now()));
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
    for (const id of guildIds) {
      const members = obj(guildById(id)?.members) as { cache?: Map<string, Obj> };
      const member = members.cache?.get(String(user.id));
      if (member) inbound('membership.changed', () => membershipUpdatedEvent(member, Date.now()));
    }
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
  on(Events.ShardReady, announceGuilds);

  // An interaction for a command the bot no longer registers: refused here, never sent to the core.
  on(Events.InteractionCreate, (interaction: Interaction) => void refuseInteraction(interaction));

  announceGuilds();
  for (const id of guildIds) void deleteCommandsOf(guildById(id), log);

  return {
    iface: discord.port.iface,
    open(): void {
      if (held === null) return;
      const waiting = held;
      held = null;
      for (const id of guildIds) for (const event of memberEvents(guildById(id))) deliver('membership.changed', event);
      if (dropped > 0) log.warn('interface: events dropped before open', { dropped });
      for (const { kind, event } of waiting) deliver(kind, event);
      // The members named by channel overwrites, fetched so the audience rail knows which are bots.
      warmAudiences();
    },
    async reconnect(): Promise<void> {
      served.close();
      served = await serve();
    },
    async stop(): Promise<void> {
      stopped = true;
      served.close();
      await client.destroy();
    },
  };
}
