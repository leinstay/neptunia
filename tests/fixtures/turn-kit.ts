// The kit of the turn tests over the fake interface: a raw message and the trigger it gives, the channel, the fake
// llm, store, hot and client a turn is built from, and the lookup scene. `turn.test.ts` imports them.
import { createDiscordAdapter } from '../../interfaces/discord/index.ts';
import { completionOf } from './tool-answers.ts';
import { labels } from './labels.ts';
import { world } from './turn-world.ts';
import type { ChannelSpec } from './turn-world.ts';
import { createTurnRunner } from './turn-runner.ts';
import type { TriggerKind } from '../../src/turn/triggers.ts';
import type { TurnParams } from '../../src/turn/outcome.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { createDiscordInterface } from '../../interfaces/discord/index.ts';

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

export const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

// The turn runner over the fake interface of the test's world: `runTurn` takes the channel handle `fakeTurnChannel` gives.

/** A discord.js-shaped raw message, just enough for normalizeMessage. */
export function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = NOW - 1000,
  content = 'hey bot',
  attachments = new Map(),
  stickers = new Map(),
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  ts?: number;
  content?: string;
  attachments?: Map<string, unknown>;
  stickers?: Map<string, unknown>;
}) {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments,
    stickers,
  };
}

// The history helpers below return lists that are never empty, so `.at(-1)` of one is a message.
export type RawMessage = ReturnType<typeof rawMessage>;

/** The normalized shape pipeline.js would hand to runTurn as `trigger`. */
export function normalizedTrigger(raw: Omit<ReturnType<typeof rawMessage>, 'reference'>) {
  return {
    id: raw.id,
    channelId: raw.channelId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

/** `dm: true` is a private (DM) channel: no community, no name. `attachFiles: false` takes the permission to attach away. */
export function fakeTurnChannel({
  id = 'c1',
  name = 'general',
  guildId = 'g1',
  historyMessages = [],
  attachFiles = true,
  dm = false,
  ...more
}: ChannelSpec & { attachFiles?: boolean } = {}) {
  return world().channel({ id, name, guildId, dm, historyMessages, permissions: { attach: attachFiles }, ...more });
}

/** A request's options without her tools (`tools`, `toolChoice`): what the rest of the request carries. */
export const withoutTools = ({ tools, toolChoice, ...rest }: Record<string, unknown>) => rest;

export function fakeLlm(responseText: unknown) {
  const calls: Array<Untyped> = [];
  const optionCalls: Array<Untyped> = [];
  return {
    calls,
    optionCalls,
    complete: async (messages: Untyped, options: Untyped) => {
      calls.push(messages);
      optionCalls.push(options);
      return completionOf(responseText);
    },
  };
}

/** The store a turn reads: the calls it made are kept, and a test hangs more members on it. */
export type FakeStore = {
  guildCalls: Array<unknown>;
  privateCalls: Array<{ guildId: string; userId: string }>;
  state: { data: Record<string, unknown>; markDirty: () => void };
  [member: string]: Untyped;
};

export function fakeStore({
  guildMemory = {},
  userProfiles = {},
  channels = [],
  loreEntries = [],
  privateProfiles = {},
  mediaCache = {},
}: {
  guildMemory?: Record<string, unknown>;
  userProfiles?: Record<string, unknown>;
  channels?: Array<unknown>;
  loreEntries?: Array<unknown>;
  privateProfiles?: Record<string, unknown>;
  mediaCache?: Record<string, unknown>;
} = {}): FakeStore {
  const guildCalls: Array<unknown> = [];
  const privateCalls: Array<{ guildId: string; userId: string }> = [];
  return {
    guildCalls,
    privateCalls,
    getGuild: (guildId: string) => {
      guildCalls.push(guildId);
      return guildMemory;
    },
    getUser: (guildId: string, userId: string) => userProfiles[userId] ?? null,
    getPrivate: (guildId: string, userId: string) => {
      privateCalls.push({ guildId, userId });
      return privateProfiles[userId] ?? null;
    },
    listChannels: () => channels,
    listUserProfiles: () => Object.values(userProfiles),
    getLore: () => loreEntries,
    getMediaCache: () => mediaCache,
    state: { data: {}, markDirty() {} },
  };
}

export function identityCalibrator() {
  return { ratio: 1, apply: (n: number) => n, observe: () => {} };
}

/** `hot` as a turn reads it: the config and the prompts, which a test may change after the build. */
export type FakeHot = { config: Record<string, Untyped>; prompts: Record<string, Untyped> };

export function fakeHot(
  featureOverrides: Record<string, unknown> = {},
  botOverrides: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {}
): FakeHot {
  return {
    config: {
      bot: { timezone: 'UTC', ...botOverrides },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { tokensPerImage: 400, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { ...featureOverrides },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      ...configOverrides,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      memory: 'Summarize what happened.',
      labels,
    },
  };
}

export function fakeClient(overrides: Record<string, unknown> = {}) {
  return { user: { id: 'self-id', username: 'Bot' }, ...overrides };
}

/** A fake createImageFetcher()-shaped dependency (see src/media/fetch-image.ts). `result` may be
 * `null` (every download fails), a fixed success object, or `(url, options) => result|null`. */
export function fakeImageFetcher(
  result: unknown = { dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' }
) {
  const calls: Array<{ url: string; options: Untyped }> = [];
  return {
    calls,
    fetchAsDataUrl: async (url: string, options: Untyped) => {
      calls.push({ url, options });
      return typeof result === 'function'
        ? (result as (url: string, options: Untyped) => unknown)(url, options)
        : result;
    },
  };
}

/** A raw message carrying link embeds. */
export function linkRaw(id: string, ts: number, embeds: unknown, content = 'κοίτα αυτό') {
  return { ...rawMessage({ id, ts, content }), embeds };
}

export const PAGE_EMBED = {
  url: 'https://example.org/a',
  title: 'Crêpes',
  description: null,
  provider: null,
  thumbnail: null,
};

/** A fake createLookup()-shaped dependency. */
export function fakeLookup({
  reads = {},
  searchResult = {
    query: 'q',
    text: 'ευρήματα',
    sources: [{ title: 'Un', url: 'https://www.example.com/1', site: 'example.com' }],
  },
  hasKey = true,
}: { reads?: Record<string, string>; searchResult?: Record<string, unknown> | null; hasKey?: boolean } = {}) {
  const readCalls: Array<{ guildId: string; links: Array<Untyped>; options: Untyped }> = [];
  const searchCalls: Array<{ guildId: Untyped; query: Untyped }> = [];
  return {
    readCalls,
    searchCalls,
    readLinks: async (guildId: string, links: Array<Untyped>, options: Untyped) => {
      readCalls.push({ guildId, links, options });
      const map = new Map();
      for (const link of links) if (reads[link.id]) map.set(link.id, reads[link.id]);
      return { reads: map, newCount: map.size };
    },
    search: async (guildId: string, query: unknown) => {
      searchCalls.push({ guildId, query });
      return searchResult ? { ...searchResult, query } : null;
    },
    hasSearch: () => hasKey,
  };
}

export const LOOKUP_SYSTEM = 'Decide whether {{name}} needs to look something up.';
/** An llm fake routing the search classifier (system starts with "Decide whether") apart from the turn. */
export function lookupLlm(classifierText: string | Error = 'none', turnText = '<msg>ok</msg>') {
  const classifierCalls: Array<{ messages: Untyped; options: Untyped }> = [];
  const turnCalls: Array<{ messages: Untyped; options: Untyped }> = [];
  return {
    classifierCalls,
    turnCalls,
    complete: async (messages: Untyped, options: unknown) => {
      if (messages[0].content.startsWith('Decide whether')) {
        classifierCalls.push({ messages, options });
        if (classifierText instanceof Error) throw classifierText;
        return { text: classifierText, usage: {}, estimated: 5 };
      }
      turnCalls.push({ messages, options });
      return completionOf(turnText);
    },
  };
}

export function lookupHot(
  features: Record<string, unknown> = {},
  web: { links?: object; search?: object } = {},
  config: Record<string, unknown> = {}
) {
  const hot = fakeHot(
    { webLookup: true, ...features },
    {},
    {
      models: { base: { analyzer: 'x/text' } },
      media: { maxPerTurn: 6, filePreviewChars: 500, video: { sites: ['youtube.com'] } },
      web: {
        maxPerDay: 60,
        links: { enabled: true, maxPerTurn: 2, ...web.links },
        search: { enabled: true, maxPerTurn: 1, contextMessages: 50, ...web.search },
      },
      ...config,
    }
  );
  hot.config.llm.timeoutMs = 300_000;
  hot.config.llm.analyzerTimeoutMs = 25_000;
  hot.prompts.lookup = LOOKUP_SYSTEM;
  return hot;
}

export async function runLookupTurn({
  hot = lookupHot(),
  llm = lookupLlm(),
  lookup = fakeLookup(),
  history,
  trigger = true,
  now,
  triggerKind = 'mention',
  taskResult = null,
}: {
  hot?: FakeHot;
  llm?: ReturnType<typeof lookupLlm>;
  lookup?: ReturnType<typeof fakeLookup>;
  history?: Array<ReturnType<typeof rawMessage>>;
  trigger?: boolean;
  now?: () => number;
  triggerKind?: TriggerKind;
  taskResult?: Record<string, unknown> | null;
} = {}) {
  const messages = history ?? [
    linkRaw('m1', NOW - 5000, [
      PAGE_EMBED,
      { url: 'https://www.youtube.com/watch?v=abc', title: 'v', provider: { name: 'YouTube' } },
      { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } },
    ]),
    rawMessage({ id: 'm2', ts: NOW - 1000, authorName: 'Zoë', content: 'ποιος κέρδισε τον τελικό;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: messages });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup,
    ...(now ? { now } : {}),
  });
  const last = messages[messages.length - 1];
  const turn: TurnParams = trigger
    ? { channel, mode: 'reply', trigger: normalizedTrigger(last), triggerKind, ...(taskResult ? { taskResult } : {}) }
    : { channel, mode: 'interject' };
  const result = await turns.runTurn(turn);
  return { result, llm, lookup };
}
