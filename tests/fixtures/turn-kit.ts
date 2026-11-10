// The kit of the turn tests over the fake interface: a raw message and the trigger it gives, the channel, the fake
// llm, store, hot and client a turn is built from, and the lookup scene. `turn.test.ts` imports them.
import { createDiscordAdapter } from '../../interfaces/discord/index.ts';
import { completionOf } from './tool-answers.ts';
import { labels } from './labels.ts';
import { world } from './turn-world.ts';
import type { Channel, ChannelSpec } from './turn-world.ts';
import type { Completion } from './tool-answers.ts';
import type { ReportedTurn } from '../../src/behavior/turn.ts';
import { createTurnRunner } from './turn-runner.ts';
import type { TriggerKind } from '../../src/turn/triggers.ts';
import type { TurnParams } from '../../src/turn/outcome.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { createDiscordInterface } from '../../interfaces/discord/index.ts';
import { chainsOnDefaults } from './chains.ts';
import { objectMediaCache } from '../../src/memory/store-media.ts';

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
}): { id: string; placeId: string; author: { id: string; bot: boolean; globalName: string; username: string; }; member: { displayName: string; }; cleanContent: string; createdTimestamp: number; reference: null; attachments: Map<string, unknown>; stickers: Map<string, unknown>; } {
  return {
    id,
    placeId: 'c1',
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
export function normalizedTrigger(raw: Omit<ReturnType<typeof rawMessage>, 'reference'>): { id: string; placeId: string; authorId: string; authorName: string; self: boolean; bot: boolean; content: string; ts: number; replyToId: null; attachments: Array<never>; stickers: Array<never>; } {
  return {
    id: raw.id,
    placeId: raw.placeId,
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

/** `dm: true` is a private (DM) channel: no root, no name. `attachFiles: false` takes the permission to attach away. */
export function fakeTurnChannel({
  id = 'c1',
  name = 'general',
  placeId = 'g1',
  historyMessages = [],
  attachFiles = true,
  dm = false,
  ...more
}: ChannelSpec & { attachFiles?: boolean } = {}): Channel {
  return world().channel({ id, name, placeId, dm, historyMessages, permissions: { attach: attachFiles }, ...more });
}

/** A request's options without her tools (`tools`, `toolChoice`): what the rest of the request carries. */
export const withoutTools = (options: Record<string, unknown>): Record<string, unknown> => {
  const rest = { ...options };
  delete rest.tools;
  delete rest.toolChoice;
  // The reply call's options carry the request's `blocks` for the archive, whose content these tests do not read.
  delete rest.blocks;
  return rest;
};

export function fakeLlm(responseText: unknown): { calls: Array<Untyped>; optionCalls: Array<Untyped>; complete: (messages: Untyped, options: Untyped) => Promise<Completion>; } {
  const calls: Array<Untyped> = [];
  const optionCalls: Array<Untyped> = [];
  return {
    calls,
    optionCalls,
    complete: (messages: Untyped, options: Untyped) => {
      calls.push(messages);
      optionCalls.push(options);
      return Promise.resolve(completionOf(responseText));
    },
  };
}

/** The store a turn reads: the calls it made are kept, and a test hangs more members on it. */
export type FakeStore = {
  guildCalls: Array<unknown>;
  privateCalls: Array<{ accountId: string }>;
  state: { data: Record<string, unknown>; markDirty: () => void };
  [member: string]: Untyped;
};

export function fakeStore({
  placeMemory = {},
  userProfiles = {},
  channels = [],
  loreEntries = [],
  privateProfiles = {},
  mediaCache = {},
}: {
  placeMemory?: Record<string, unknown>;
  userProfiles?: Record<string, unknown>;
  channels?: Array<unknown>;
  loreEntries?: Array<unknown>;
  privateProfiles?: Record<string, unknown>;
  mediaCache?: Record<string, unknown>;
} = {}): FakeStore {
  const guildCalls: Array<unknown> = [];
  const privateCalls: Array<{ accountId: string }> = [];
  return {
    guildCalls,
    topPlaces: () => ['g1'],
    privateCalls,
    getPlace: (placeId: string) => {
      guildCalls.push(placeId);
      return placeMemory;
    },
    getUser: (accountId: string) => userProfiles[accountId] ?? null,
    getPrivate: (accountId: string) => {
      privateCalls.push({ accountId });
      return privateProfiles[accountId] ?? null;
    },
    listChannels: () => channels,
    listUserProfiles: () => Object.values(userProfiles),
    getLore: () => loreEntries,
    ...objectMediaCache(mediaCache),
    state: { data: {}, markDirty() {} },
  };
}

export function identityCalibrator(): { ratio: number; apply: (n: number) => number; observe: () => void; } {
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
      // Changed: an optional role is on by its chain (spec 2026-11-09-model-routes, slice 4); a config that named no
      // model had them on, each on its built-in default.
      models: { routes: chainsOnDefaults({}) },
      ...configOverrides,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      memory: 'Summarize what happened.',
      labels,
    },
  };
}

export function fakeClient(overrides: Record<string, unknown> = {}): { user: { id: string; username: string; }; } {
  return { user: { id: 'self-id', username: 'Bot' }, ...overrides };
}

/** A fake createImageFetcher()-shaped dependency (see src/media/fetch-image.ts). `result` may be
 * `null` (every download fails), a fixed success object, or `(url, options) => result|null`. */
export function fakeImageFetcher(
  result: unknown = { dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' }
): {
  calls: Array<{ url: string; options: Record<string, Untyped> }>;
  fetchAsDataUrl: (url: string, options: Record<string, Untyped>) => Promise<unknown>;
} {
  const calls: Array<{ url: string; options: Record<string, Untyped> }> = [];
  return {
    calls,
    fetchAsDataUrl: (url, options) => {
      calls.push({ url, options });
      return Promise.resolve(
        typeof result === 'function'
          ? (result as (url: string, options: Record<string, Untyped>) => unknown)(url, options)
          : result
      );
    },
  };
}

/** A raw message carrying link embeds. */
export function linkRaw(id: string, ts: number, embeds: unknown, content = 'κοίτα αυτό'): { embeds: unknown; id: string; placeId: string; author: { id: string; bot: boolean; globalName: string; username: string; }; member: { displayName: string; }; cleanContent: string; createdTimestamp: number; reference: null; attachments: Map<string, unknown>; stickers: Map<string, unknown>; } {
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
}: { reads?: Record<string, string>; searchResult?: Record<string, unknown> | null; hasKey?: boolean } = {}): {
  readCalls: Array<{ placeId: string; links: Array<{ id: string; [key: string]: Untyped }>; options: Record<string, Untyped> }>;
  searchCalls: Array<{ placeId: string; query: unknown }>;
  readLinks: (
    placeId: string,
    links: Array<{ id: string; [key: string]: Untyped }>,
    options: Record<string, Untyped>
  ) => Promise<{ reads: Map<string, string>; newCount: number }>;
  search: (placeId: string, query: unknown) => Promise<Record<string, unknown> | null>;
  hasSearch: () => boolean;
} {
  const readCalls: Array<{ placeId: string; links: Array<{ id: string; [key: string]: Untyped }>; options: Record<string, Untyped> }> = [];
  const searchCalls: Array<{ placeId: string; query: unknown }> = [];
  return {
    readCalls,
    searchCalls,
    readLinks: (placeId, links, options) => {
      readCalls.push({ placeId, links, options });
      const map = new Map<string, string>();
      for (const link of links) {
        const read = reads[link.id];
        if (read) map.set(link.id, read);
      }
      return Promise.resolve({ reads: map, newCount: map.size });
    },
    search: (placeId, query) => {
      searchCalls.push({ placeId, query });
      return Promise.resolve(searchResult ? { ...searchResult, query } : null);
    },
    hasSearch: () => hasKey,
  };
}

export const LOOKUP_SYSTEM = 'Decide whether {{name}} needs to look something up.';
/** An llm fake routing the search classifier (system starts with "Decide whether") apart from the turn. */
export function lookupLlm(
  classifierText: string | Error = 'none',
  turnText = '<msg>ok</msg>'
): {
  classifierCalls: Array<{ messages: Array<{ content: string }>; options: Record<string, Untyped> }>;
  turnCalls: Array<{ messages: Array<{ content: Untyped }>; options: Record<string, Untyped> }>;
  complete: (messages: Array<{ content: string }>, options: Record<string, Untyped>) => Promise<Completion>;
} {
  const classifierCalls: Array<{ messages: Array<{ content: string }>; options: Record<string, Untyped> }> = [];
  const turnCalls: Array<{ messages: Array<{ content: Untyped }>; options: Record<string, Untyped> }> = [];
  return {
    classifierCalls,
    turnCalls,
    complete: (messages, options) => {
      if (messages[0]?.content.startsWith('Decide whether')) {
        classifierCalls.push({ messages, options });
        if (classifierText instanceof Error) return Promise.reject(classifierText);
        return Promise.resolve({ text: classifierText, usage: {}, estimated: 5 });
      }
      turnCalls.push({ messages, options });
      return Promise.resolve(completionOf(turnText));
    },
  };
}

export function lookupHot(
  features: Record<string, unknown> = {},
  web: { links?: object; search?: object } = {},
  config: Record<string, unknown> = {}
): { config: Record<string, Untyped>; prompts: Record<string, Untyped>; } {
  const hot = fakeHot(
    { webLookup: true, ...features },
    {},
    {
      models: { routes: chainsOnDefaults({ analyzer: 'x/text' }) },
      media: { maxPerTurn: 6, filePreviewChars: 500, video: { sites: ['youtube.com'] } },
      web: {
        maxPerDay: 60,
        links: { enabled: true, maxPerTurn: 2, ...web.links },
        quickSearch: { enabled: true, maxPerTurn: 1, contextMessages: 50, ...web.search },
      },
      ...config,
    }
  );
  const llm = hot.config.llm as Record<string, unknown>;
  llm.timeoutMs = 300_000;
  llm.analyzerTimeoutMs = 25_000;
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
} = {}): Promise<{ result: ReportedTurn; llm: ReturnType<typeof lookupLlm>; lookup: ReturnType<typeof fakeLookup> }> {
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
