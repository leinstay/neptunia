// The scenes of the sandbox tests: a moment as normalized messages, and the fake config, hot, store and llm they run over.
import { labels } from './labels.ts';
import type { Untyped } from '../../src/tools/types.ts';

export const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
export const SELF_ID = '900000000000000001';
export const ALICE = '111111111111111111';
export const BRUNO = '222222222222222222';
export const CHANNEL = { id: '500000000000000001', name: 'general', category: 'Talk', topic: null };

/** A moment as normalized channel messages (interfaces/discord/collect.ts#normalizeMessage), oldest first:
 * one `[authorId, authorName, text, minutesBefore]` per line, the last one the trigger. */
export function moment(lines: Array<[string, string, string, number]>): { history: Array<{ id: string; authorId: string; authorName: string; content: string; ts: number; channelId: string; channelName: string; channelCategory: string; channelTopic: null; self: boolean; bot: boolean; mentionedUserIds: Array<never>; replyToId: null; forwardedFrom: null; attachments: Array<never>; links: Array<never>; forwarded: Array<never>; stickers: Array<never>; emojis: Array<never>; reactions: Array<never>; }>; } {
  const base = {
    channelId: CHANNEL.id,
    channelName: CHANNEL.name,
    channelCategory: CHANNEL.category,
    channelTopic: null,
    self: false,
    bot: false,
    mentionedUserIds: [],
    replyToId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  };
  return {
    history: lines.map(([authorId, authorName, content, minutes], i) => ({
      ...base,
      id: `80000000000000010${i}`,
      authorId,
      authorName,
      content,
      ts: NOW - minutes * 60_000,
    })),
  };
}

export function twoLines(): { history: Array<{ id: string; authorId: string; authorName: string; content: string; ts: number; channelId: string; channelName: string; channelCategory: string; channelTopic: null; self: boolean; bot: boolean; mentionedUserIds: Array<never>; replyToId: null; forwardedFrom: null; attachments: Array<never>; links: Array<never>; forwarded: Array<never>; stickers: Array<never>; emojis: Array<never>; reactions: Array<never>; }>; } {
  return moment([
    [BRUNO, 'Bruno', 'καλημέρα', 5],
    [ALICE, 'Alice', 'what do you think about chess?', 1],
  ]);
}

export function fakeConfig(featureOverrides: Record<string, unknown> = {}): Record<string, Untyped> {
  return {
    bot: { timezone: 'UTC' },
    context: {
      channelMessages: 100,
      maxMessageChars: 800,
      gapMarkerMinutes: 20,
      otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    models: { base: { core: 'x/chat' } },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
    memory: {
      maxOutputTokens: 4000,
      timeoutMs: 9000,
      fieldChars: 400,
      maxDetails: 15,
      maxInjokes: 15,
      maxSelfFacts: 20,
      maxEpisodes: 20,
      maxNewEpisodes: 3,
    },
    relationships: { maxDeltaPerUpdate: 15, historySize: 10 },
    lore: { maxEntries: 500 },
    features: featureOverrides,
  };
}

export function fakeHot(featureOverrides: Record<string, unknown> = {}): {
  config: Record<string, Untyped>;
  prompts: Record<string, Untyped>;
} {
  return {
    config: fakeConfig(featureOverrides),
    prompts: {
      'system-prompt': 'SYSTEM_MARKER: you are a regular member of this chat.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      memory: 'Summarize what happened.',
      labels,
    },
  };
}

export function fakeStore({
  guildMemory = {},
  userProfiles = {},
  channels = [],
  loreEntries = [],
}: {
  guildMemory?: Record<string, unknown>;
  userProfiles?: Record<string, unknown>;
  channels?: Array<unknown>;
  loreEntries?: Array<unknown>;
} = {}): {
  writes: Array<string>;
  getGuild: () => Record<string, unknown>;
  getUser: (guildId: string, userId: string) => unknown;
  getPrivate: () => never;
  listChannels: () => Array<unknown>;
  listUserProfiles: () => Array<unknown>;
  getLore: () => Array<unknown>;
  applyProfileOps: () => number;
  updateGuild: () => number;
  state: { data: Record<string, unknown>; markDirty: () => number };
} {
  const writes: Array<string> = [];
  const writer = (name: string) => () => writes.push(name);
  return {
    writes,
    getGuild: () => guildMemory,
    getUser: (guildId: string, userId: string) => userProfiles[userId] ?? null,
    getPrivate: () => {
      throw new Error('the private layer is out of bounds for the sandbox');
    },
    listChannels: () => channels,
    listUserProfiles: () => Object.values(userProfiles),
    getLore: () => loreEntries,
    applyProfileOps: writer('applyProfileOps'),
    updateGuild: writer('updateGuild'),
    state: { data: {}, markDirty: writer('markDirty') },
  };
}

type LlmCall = { messages: Array<{ role: string; content: Untyped }>; options: Record<string, unknown> };

export function fakeLlm(
  texts: unknown,
  {
    usage = { total_tokens: 120 },
    estimated = 100,
    onCall,
  }: { usage?: Record<string, number> | null; estimated?: number; onCall?: (count: number) => void } = {}
): {
  calls: Array<LlmCall>;
  complete: (
    messages: LlmCall['messages'],
    options: LlmCall['options']
  ) => Promise<{ text: unknown; usage: Record<string, number> | null; estimated: number }>;
} {
  const calls: Array<LlmCall> = [];
  return {
    calls,
    complete: (messages, options) => {
      calls.push({ messages, options });
      if (onCall) onCall(calls.length);
      const text = Array.isArray(texts) ? (texts[(calls.length - 1) % texts.length] as unknown) : texts;
      return Promise.resolve({ text, usage, estimated });
    },
  };
}
