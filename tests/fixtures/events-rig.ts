// The rig of the message-handler tests (tests/events.test.ts): the shipped config with the settings those tests rely
// on pinned, the fake discord.js guilds, channels and messages, the fakes of the handler's dependencies (turn runner,
// spontaneous speech, memory, store, describer, classifier model) that record their calls, and the handler driven as
// src/index.ts drives it. Synthetic data only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOptions, toEvent } from '../../interfaces/discord/index.ts';
import { createMessageHandler } from '../../src/behavior/pipeline.ts';
import { createTagHistory } from '../../src/behavior/mention.ts';
import { deepMerge } from '../../src/config.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { labels } from './labels.ts';
import { wrongly } from './loose-types.ts';
import { onWorldIface, seedExisting, syncStub, world } from './turn-world.ts';

/** A parsed or faked object whose fields the tests read by name. */
type Rec = Record<string, Untyped>;

// The tracked defaults only -- never the deployment's config.local.json, so
// the suite passes the same on every machine.
export const DEFAULT_CONFIG: Rec = wrongly<Rec>(
  JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'config.json'), 'utf8')
  )
);

// The settings the behaviour tests below rely on, pinned here so a tuned default never breaks them.
// DEFAULT_CONFIG stays the raw shipped file for the "code fallback equals config.json" checks.
const PINNED = {
  mention: {
    ignoreChance: 0,
    nameTriggerChance: 1,
    oneAtATime: true,
    pendingMinutes: 10,
    maxPending: 3,
    pendingSameChannel: true,
    switchDelayMs: [2000, 9000],
    followUpMinutes: 15,
    followUpClassifyReplies: true,
    followUpOverheard: true,
    followUpMaxOutputTokens: 8,
    followUpNoStreak: 3,
    followUpAliases: 5,
  },
  memory: { aliasHalfLifeDays: 365 },
  elsewhere: { settleSeconds: 90, settleMaxSeconds: 300 },
  media: { prefillPerMessage: 2, video: { prefillPerMessage: 1 } },
  llm: { analyzerTimeoutMs: 30000 },
};

export function baseConfig(overrides: Rec = {}): Rec {
  return wrongly<Rec>(deepMerge(deepMerge(structuredClone(DEFAULT_CONFIG), structuredClone(PINNED)), overrides));
}

export type FakeGuild = { id: string; members: { me: { displayName: string } } };
export function fakeGuild(id = 'g1', displayName = 'Ζωή'): FakeGuild {
  return { id, members: { me: { displayName } } };
}

/** A discord.js-shaped channel: what `toEvent` reads, and the fields a test adds. */
export type FakeChannel = {
  id: string;
  guild: unknown;
  isThread(): boolean;
  viewable: boolean;
  permissionsFor(): { has(): boolean };
  messages: { cache: Map<unknown, unknown>; fetch(): Promise<null> };
  [field: string]: Untyped;
};

/** A discord.js-shaped channel for `toEvent`, and the same conversation in the fake interface. */
export function fakeChannel(id: string, guild: unknown, overrides: Rec = {}): FakeChannel {
  const channel: FakeChannel = {
    id,
    guild,
    isThread: () => false,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    messages: { cache: new Map(), fetch: () => Promise.resolve(null) },
    ...overrides,
  };
  syncStub(channel);
  return channel;
}

export function fakeMessage(overrides: Rec = {}): Rec {
  const guild: unknown = 'guild' in overrides ? overrides.guild : fakeGuild();
  const channel = wrongly<{ id: unknown }>(overrides.channel ?? fakeChannel('c1', guild));
  return {
    system: false,
    webhookId: null,
    author: { id: 'u1', bot: false, globalName: 'User', username: 'user' },
    member: { displayName: 'User' },
    guild,
    channel,
    channelId: channel.id,
    cleanContent: 'hello there',
    createdTimestamp: Date.now(),
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
    ...overrides,
  };
}

export function fakeClient(): { user: { id: string; username: string } } {
  return { user: { id: 'self1', username: 'Neptunia' } };
}

/** A function that records the arguments of each call. */
export type Recorder = { (...args: Array<Untyped>): void; calls: Array<Array<Untyped>> };
export function recorder(): Recorder {
  const calls: Array<Array<Untyped>> = [];
  const fn = Object.assign(
    (...args: Array<Untyped>) => {
      calls.push(args);
    },
    { calls }
  );
  return fn;
}

type Hook = (...args: Array<never>) => unknown;
export type FakeTurns = {
  notePost: Recorder;
  runTurn: Hook;
  isBusy: Hook;
  isAnyBusy: Hook;
  lastPostAt(): number;
  notePostCalls: Array<Array<Untyped>>;
  [field: string]: Untyped;
};
export function fakeTurns({
  runTurn,
  isBusy,
  isAnyBusy,
}: { runTurn?: Hook; isBusy?: Hook; isAnyBusy?: Hook } = {}): FakeTurns {
  const notePost = recorder();
  return {
    notePost,
    runTurn: runTurn ?? (() => Promise.resolve({ outcome: 'spoke' })),
    isBusy: isBusy ?? (() => false),
    isAnyBusy: isAnyBusy ?? (() => false),
    lastPostAt: () => 0,
    notePostCalls: notePost.calls,
  };
}

export function fakeSpontaneous(): { onMessage: Recorder; onMessageCalls: Array<Array<Untyped>> } {
  const onMessage = recorder();
  return { onMessage, onMessageCalls: onMessage.calls };
}

export function fakeMemory({ observe }: { observe?: Hook } = {}): {
  observe: Hook;
  observeCalls: Array<Array<Untyped>>;
} {
  const calls: Array<Array<Untyped>> = [];
  return {
    observe:
      observe ??
      ((...args: Array<Untyped>) => {
        calls.push(args);
      }),
    observeCalls: calls,
  };
}

export function scripted(values: Array<number | boolean>): () => number {
  const queue = [...values];
  return () => {
    if (queue.length === 0) throw new Error('scripted rng ran out of values');
    return wrongly<number>(queue.shift());
  };
}

/** An injectable `now()` whose value can be moved forward with `.set(ms)`. */
export type MutableNow = { (): number; set(v: number): void };
export function mutableNow(start: number): MutableNow {
  let t = start;
  return Object.assign(() => t, {
    set: (v: number) => {
      t = v;
    },
  });
}

/** A fakeChannel that holds the message `messageId` -- messageStillExists finds it. */
export function fakeChannelWithMessage(id: string, guild: unknown, messageId: string, overrides: Rec = {}): FakeChannel {
  const channel = fakeChannel(id, guild, overrides);
  seedExisting(id, messageId);
  return channel;
}

export function fakeStore(profiles: Record<string, unknown> = {}): {
  getUser(guildId: string, userId: string): unknown;
  getUserCalls: Array<Array<string>>;
} {
  const calls: Array<Array<string>> = [];
  return {
    getUser: (guildId, userId) => {
      calls.push([guildId, userId]);
      return profiles[userId] ?? null;
    },
    getUserCalls: calls,
  };
}

export function fakeDescriber(): {
  calls: Array<{ guildId: string; items: Array<Rec> }>;
  describeMany(guildId: string, items: Array<Rec>): Promise<{ descriptions: Map<string, string>; newCount: number }>;
} {
  const calls: Array<{ guildId: string; items: Array<Rec> }> = [];
  return {
    calls,
    describeMany: (guildId, items) => {
      calls.push({ guildId, items });
      return Promise.resolve({ descriptions: new Map(), newCount: 0 });
    },
  };
}

/** The notices a handler's fake adapter holds (`handler.port`). */
export type Notice = { text: string; replyTo: { messageId: string } | null; mentions: object };
type WithPort = { port: { messagesIn(conversationId: string): Array<Notice> } };
export function noticesOf(handler: object, id: string): Array<Notice> {
  return wrongly<WithPort>(handler)
    .port.messagesIn(id).map(({ text, replyTo, mentions }) => ({ text, replyTo, mentions }));
}
export function textsOf(handler: object, id: string): Array<string> {
  return noticesOf(handler, id).map((notice) => notice.text);
}
export function lineOf(
  text: string,
  conversationId = '',
  messageId = ''
): { text: string; replyTo: { iface: string; conversationId: string; messageId: string } | null; mentions: Rec } {
  return {
    text,
    replyTo: messageId ? { iface: 'fake', conversationId, messageId } : null,
    mentions: { users: [], repliedUser: false },
  };
}

/** What `makeHandler` takes: each is the dependency of the handler it replaces, a fake by default. */
export type HandlerOptions = {
  config?: Rec;
  turns?: Rec;
  spontaneous?: Rec;
  memory?: Rec;
  tagHistory?: Rec;
  rng?: () => number;
  now?: () => number;
  sleep?: (ms: never) => Promise<unknown>;
  client?: Rec;
  store?: Rec;
  getGuildId?: () => string | null;
  describer?: Rec;
  prompts?: Rec;
  llm?: Rec;
  lookup?: Rec;
  timers?: Rec;
  activity?: Rec;
  record?: Rec;
  missed?: Rec;
};

/** The handler as `makeHandler` returns it: driven with discord.js messages, and the fake interface's port. */
export type DrivenHandler = ReturnType<typeof asDiscordEvents> & { port: ReturnType<typeof world>['port'] };

export function makeHandler({
  config,
  turns,
  spontaneous,
  memory,
  tagHistory,
  rng,
  now,
  sleep,
  client,
  store,
  getGuildId,
  describer,
  prompts,
  llm,
  lookup,
  timers,
  activity,
  record,
  missed,
}: HandlerOptions = {}): DrivenHandler {
  const hot = prompts !== undefined ? { config: config ?? baseConfig(), prompts } : { config: config ?? baseConfig() };
  const discord = wrongly<{ user: { id: string }; knows?: Array<string>; fetchCalls: Array<unknown> }>(
    client ?? fakeClient()
  );
  const names = { self: 'Ζωή' };
  const port = world().port;
  if (discord.knows) {
    world().knowMembers('g1', discord.knows);
    world().tap('memberInfo', ([member]) => {
      discord.fetchCalls.push(wrongly<{ memberId: unknown }>(member).memberId);
    });
  }
  const handler = createMessageHandler(
    wrongly({
      hot,
      store: store ?? fakeStore(),
      reads: world().reads,
      selfId: () => discord.user.id,
      getSelfName: () => names.self,
      turns: turns ?? fakeTurns(),
      spontaneous: spontaneous ?? fakeSpontaneous(),
      memory: memory ?? fakeMemory(),
      tagHistory: tagHistory ?? createTagHistory(),
      getGuildId: getGuildId ?? (() => 'g1'),
      describer,
      llm,
      lookup,
      rng: rng ?? Math.random,
      now,
      sleep,
      timers,
      activity,
      record,
      missed,
      port,
    })
  );
  return Object.assign(asDiscordEvents(handler, hot, discord, names), { port });
}

/** The event the handler takes. */
type Handled = Parameters<ReturnType<typeof createMessageHandler>>[0];

/**
 * The handler driven as src/index.ts drives it: each fake discord.js message (or update, or
 * deletion) becomes its protocol event (interfaces/discord/collect.ts#toEvent) at the moment of the
 * call, with the options read from the live config then.
 */
export function asDiscordEvents(
  handler: ReturnType<typeof createMessageHandler>,
  hot: { config: Rec },
  client: { user: { id: string } },
  names = { self: 'Ζωή' }
): ((message: Rec) => ReturnType<typeof handler>) & {
  onMessageUpdate(oldMessage: object | null, newMessage: Rec): ReturnType<typeof handler.onMessageUpdate>;
  onMessageDelete(message: Rec): ReturnType<typeof handler.onMessageDelete>;
  drainPending: ReturnType<typeof createMessageHandler>['drainPending'];
  clearPending: ReturnType<typeof createMessageHandler>['clearPending'];
  stop: ReturnType<typeof createMessageHandler>['stop'];
} {
  const options = () => normalizeOptions(hot.config);
  const driven = (message: Rec) => {
    names.self = wrongly<{ guild?: { members?: { me?: { displayName?: string } } } }>(message).guild?.members?.me?.displayName ?? names.self;
    return handler(wrongly<Handled>(onWorldIface(toEvent(message, client.user.id, options()))));
  };
  return Object.assign(driven, {
    onMessageUpdate: (oldMessage: object | null, newMessage: Rec) =>
      handler.onMessageUpdate(
        wrongly<Handled>(
          onWorldIface(toEvent(newMessage, client.user.id, { ...options(), edit: true, previous: oldMessage }))
        )
      ),
    onMessageDelete: (message: Rec) =>
      handler.onMessageDelete(wrongly<Handled>(onWorldIface(toEvent(message, client.user.id, { deleted: true })))),
    drainPending: (...args: Parameters<typeof handler.drainPending>) => handler.drainPending(...args),
    clearPending: (...args: Parameters<typeof handler.clearPending>) => handler.clearPending(...args),
    stop: (...args: Parameters<typeof handler.stop>) => handler.stop(...args),
  });
}

/** A discord.js attachments Map with one classifiable image entry. */
export function pictureAttachments(count = 1): Map<string, Rec> {
  const entries = new Map<string, Rec>();
  for (let i = 1; i <= count; i += 1) {
    entries.set(`a${i}`, {
      id: `a${i}`,
      contentType: 'image/png',
      name: `${i}.png`,
      url: `https://cdn.discordapp.com/x/${i}.png`,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The address classifier (features.followUp) -- fixtures.

/** A raw discord.js-shaped message, minimal enough for normalizeMessage / fetchHistory. */
export function rawHistoryMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts,
  content = 'hi',
  channelId = 'c1',
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  ts: number;
  content?: string;
  channelId?: string;
}): Rec {
  return {
    id,
    channelId,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** A fakeChannel whose messages.fetch({limit}) serves `historyMessages` (see fetchHistory). */
export function fakeChannelWithHistory(
  id: string,
  guild: unknown,
  historyMessages: Array<Rec> = [],
  overrides: Rec = {}
): FakeChannel {
  const channel = fakeChannel(id, guild, overrides);
  world().follow(id, historyMessages);
  return channel;
}

export function fakeAddressPrompts(): Rec {
  return {
    'system-prompt': 'system',
    'character-card': 'card',
    format: 'format',
    reply: 'Someone called you: {{author}}.',
    interject: 'interject',
    initiate: 'initiate',
    memory: 'memory',
    address: 'You are {{name}}. Is the candidate message addressed to you? Answer yes or no.',
    labels,
  };
}

/** A controllable fake LLM client (src/llm/openrouter.ts#createLlm shape): `respond(text)` resolves
 * every currently-queued call, `fail(err)` rejects it instead -- lets a test hold a call open to
 * probe single-flight behaviour before letting it settle. */
export type FakeFollowUpLlm = {
  calls: Array<{ messages: Array<Rec>; options: Rec }>;
  complete(messages: Array<Rec>, options: Rec): Promise<unknown>;
  respond(text: string): void;
  fail(err: unknown): void;
};
export function fakeFollowUpLlm(): FakeFollowUpLlm {
  const calls: FakeFollowUpLlm['calls'] = [];
  let resolvers: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
  return {
    calls,
    complete: (messages, options) =>
      new Promise((resolve, reject) => {
        calls.push({ messages, options });
        resolvers.push({ resolve, reject });
      }),
    respond(text) {
      const pending = resolvers;
      resolvers = [];
      for (const { resolve } of pending) resolve({ text, usage: {}, estimated: 1 });
    },
    fail(err) {
      const pending = resolvers;
      resolvers = [];
      for (const { reject } of pending) reject(err);
    },
  };
}

/** Sends the persona's own message through the handler, opening/extending the follow-up window. */
export async function openFollowUpWindow(
  handler: (message: Rec) => Promise<unknown>,
  { guild, channel, ts }: { guild: unknown; channel: { id: string }; ts: number }
): Promise<void> {
  await handler({
    system: false,
    webhookId: null,
    author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
    member: { displayName: 'Neptunia' },
    guild,
    channel,
    channelId: channel.id,
    cleanContent: 'here you go',
    createdTimestamp: ts,
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
  });
}
