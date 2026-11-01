// The scene of the recall run tests: the pinned config, a recaller over fake interface reads, record, archive and llm, and the rabbit lines most tests search.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecall } from '../../src/behavior/recall-run.ts';
import { snapshotOf } from '../../src/behavior/snapshot.ts';
import { labels } from './labels.ts';
import { channel as channelInfo, privateChannel } from './reads-rig.ts';
import { eventOfLine, line, neutralMembers, neutralSearch, rawHit, snowflakeAt } from './recall-lines.ts';
import type { Untyped } from '../../src/tools/types.ts';
import type { ConversationInfo } from '../../src/protocol/adapter.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
export const RABBIT = Date.UTC(2026, 9, 1, 18, 44);
export const GUILD = 'g1';
export const PROMPT = 'You are {{name}}; {{answerChars}}.';

// The recall settings the runner tests rely on, pinned here instead of read from the shipped defaults.
export const RECALL_PIN = {
  maxForms: 8,
  maxPeople: 2,
  dateSamples: 4,
  clusterGapMinutes: 30,
  maxClusters: 8,
  rareHits: 0,
  windowMessages: 16,
  answerChars: 1200,
  stretchChars: 1500,
  maxPerDay: 100,
  timeoutMs: 30000,
  minSummaryMs: 2500,
  maxOutputTokens: 500,
  memoryItems: 6,
  selfBonus: 1,
  selfExtra: 0,
  contextMessages: 0,
  traceMaxLines: 500,
  followMessages: 24,
  followGapMinutes: 5,
};

/** The shipped config.json with the recall settings pinned and the given groups merged over a fresh copy (one level deep). */
export function config(overrides: Record<string, Record<string, unknown>> = {}) {
  const base = structuredClone(SHIPPED_CONFIG);
  base.bot = { ...base.bot, timezone: 'UTC' };
  base.recall = { ...RECALL_PIN };
  for (const [key, value] of Object.entries(overrides)) base[key] = { ...base[key], ...value };
  return base;
}

/**
 * A scene: a community with #general (c1, the turn's conversation), #garden (c2) and #private (c4, which the community's
 * everyone cannot view, so the audience rail refuses it here); `lines` per conversation id; `answers(route, query)` gives
 * the REST body the interface would read a search from (the neutral query is shown to it the way Discord's REST takes
 * it: `content`, `author_id`, `min_id`, `max_id`, `offset`).
 */
export function scene({
  lines = {},
  answers = () => ({ total_results: 0, messages: [] }),
  answer = 'stretch: 1\nAna did it on October 1.',
  features = {},
  recall = {},
  state = {},
  capLeft = 100,
  describer = null,
  profiles = [],
  memory = {},
  timers,
  now = () => NOW,
  archive = null,
  record = null,
  vectors = null,
  embed = null,
}: Record<string, Untyped> = {}) {
  const calls: Array<{ route: string; query: Record<string, Untyped>; signal: AbortSignal }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetches: Array<{ channel: Untyped; around: Untyped; limit: Untyped }> = [];
  const follows: Array<{ channel: Untyped; after: Untyped; limit: Untyped }> = [];
  // The conversations of the community: the partner u5 views #general and #garden, not #private.
  const infos: Record<string, ConversationInfo> = {
    c1: channelInfo('c1', { name: 'general', viewers: { u5: true } }),
    c2: channelInfo('c2', { name: 'garden', viewers: { u5: true } }),
    c4: { ...privateChannel('c4', []), name: 'private', viewers: { u5: false } },
  };
  const snapshot = snapshotOf(GUILD, { conversations: Object.values(infos), groups: [] });
  // The history reads of a conversation, which a test may break (`broken`).
  const broken = new Set();
  const reads = {
    searchMessages: async (scope: Untyped, query: Untyped) => {
      const rest = {
        ...(query.text ? { content: query.text } : {}),
        ...(query.authorId ? { author_id: query.authorId } : {}),
        ...(Number.isFinite(query.after) ? { min_id: snowflakeAt(query.after) } : {}),
        ...(Number.isFinite(query.before) ? { max_id: snowflakeAt(query.before) } : {}),
        ...(query.offset ? { offset: String(query.offset) } : {}),
      };
      const route = `/guilds/${scope.communityId}/messages/search`;
      // A read cannot be cancelled: the signal the answer may wait on never fires.
      const signal = new AbortController().signal;
      calls.push({ route, query: rest, signal });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      let body;
      try {
        body = await Promise.resolve(answers(route, rest, signal));
      } catch {
        return null;
      }
      return neutralSearch(body);
    },
    searchMembers: async (scope: Untyped, query: Untyped) => {
      const route = `/guilds/${scope.communityId}/members/search`;
      const rest = { query: query.prefix, limit: String(query.limit) };
      const signal = new AbortController().signal;
      calls.push({ route, query: rest, signal });
      let body;
      try {
        body = await Promise.resolve(answers(route, rest, signal));
      } catch {
        return null;
      }
      return neutralMembers(body);
    },
    history: async (ref: Untyped, query: Untyped) => {
      await Promise.resolve();
      const stored = lines[ref.conversationId] ?? [];
      const info = infos[ref.conversationId];
      if (!info || broken.has(ref.conversationId)) return null;
      const events = (rows: Untyped) => rows.map((l: Untyped) => eventOfLine(info, l));
      if (query.after !== undefined) {
        follows.push({ channel: ref.conversationId, after: query.after, limit: query.limit });
        const from = stored.findIndex((l: Untyped) => l.id === query.after) + 1;
        return { events: events(stored.slice(from, from + query.limit)), complete: true };
      }
      fetches.push({ channel: ref.conversationId, around: query.around, limit: query.limit });
      const at = stored.findIndex((l: Untyped) => l.id === query.around);
      const from = Math.max(0, at - Math.floor(query.limit / 2));
      return { events: events(stored.slice(from, from + query.limit)), complete: true };
    },
  };
  const guild = {
    reads,
    /** Makes every history read of conversation `id` fail. */
    breakHistory: (id: string) => broken.add(id),
    /** Replaces the history read of the conversation (`replace(query)`). */
    history: (replace: Untyped) => {
      const original = reads.history;
      reads.history = async (ref, query) => replace(ref, query, () => original(ref, query));
    },
  };

  const data = { ...state };
  let dirty = 0;
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {
        dirty += 1;
      },
    },
    listUserProfiles: () => profiles,
    // The other stored memory a test hands over: getLore, getGuild, getRecent, getPrivate.
    ...memory,
  };
  const llmCalls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const llm = {
    capLeft: () => capLeft,
    complete: async (messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) => {
      llmCalls.push({ messages, options });
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(messages, options);
      return { text: answer };
    },
  };
  const hot = {
    config: config({ features, recall: { ...recall }, llm: { analyzerTimeoutMs: 30000 } }),
    prompts: { 'recall-summary': PROMPT, labels },
  };
  const recaller = createRecall({
    reads,
    hot,
    store,
    llm,
    describer,
    now,
    archive,
    record,
    vectors,
    embed,
    ...(timers ? { timers } : {}),
  } as unknown as Parameters<typeof createRecall>[0]);
  const history = [
    {
      id: 'h1',
      channelId: 'c1',
      ts: NOW - 30 * MINUTE,
      self: false,
      bot: false,
      authorName: 'Nikos',
      content: 'τι έγινε με το κουνέλι;',
    },
    {
      id: 'h2',
      channelId: 'c1',
      ts: NOW - MINUTE,
      self: false,
      bot: false,
      authorName: 'Nikos',
      content: 'ποιος σκότωσε το κουνέλι;',
    },
  ];
  // A private chat with the member u5, as the interface describes it (no community, no audience).
  const dm = channelInfo('dm1', { kind: 'dm', communityId: null, chatType: 'dm', partnerId: 'u5', audience: null });
  const args = {
    guildId: GUILD,
    channel: infos.c1,
    snapshot,
    partnerId: null,
    selfId: 'self',
    selfName: 'Zoë',
    history,
    candidate: history[1],
  };
  return {
    recaller,
    args,
    dm,
    guild,
    calls,
    fetches,
    follows,
    llmCalls,
    data,
    hot,
    dirty: () => dirty,
    maxInFlight: () => maxInFlight,
  };
}

/** The message searches among the REST calls. */
export const searches = (calls: Untyped) => calls.filter((c: Untyped) => c.route.endsWith('/messages/search'));

export const RABBIT_LINES = [
  line('r0', RABBIT - 6 * MINUTE, { name: 'Βασίλης', author: 'u2', content: 'πάμε κυνήγι' }),
  line('r1', RABBIT - 4 * MINUTE, { name: 'Ana', content: 'bang', attachment: { id: 'p1' } }),
  line('r2', RABBIT, { name: 'Βασίλης', author: 'u2', content: 'το κουνέλι πέθανε' }),
  line('r3', RABBIT + 2 * MINUTE, { name: 'Ana', content: 'κηδεία για το κουνέλι' }),
  line('r4', RABBIT + 3 * MINUTE, { name: 'Birthdays', author: 'bot1', content: 'κουνέλι birthday!', bot: true }),
];
export const GARDEN_LINES = [
  line('g1', RABBIT - 30 * HOUR, { name: 'Éloïse', author: 'u3', content: 'ένα κουνέλι στον κήπο' }),
  line('g2', RABBIT - 30 * HOUR + MINUTE, { name: 'Ana', content: 'ωραίο' }),
];
export const PRIVATE_LINES = [line('s1', RABBIT - HOUR, { name: 'Ana', content: 'μυστικό κουνέλι' })];

/** Search answers: `κουνέλι` hits the rabbit lines (the bot's too), the garden and the private channel; `κουνελιού` nothing. */
export function rabbitAnswers(route: Untyped, query: Untyped) {
  if (route.endsWith('/members/search')) return [];
  if (query.content === 'κουνέλι') {
    return {
      total_results: 5,
      messages: [
        [rawHit('c1', RABBIT_LINES[4])],
        [rawHit('c1', RABBIT_LINES[3])],
        [rawHit('c1', RABBIT_LINES[2])],
        [rawHit('c4', PRIVATE_LINES[0])],
        [rawHit('c2', GARDEN_LINES[0])],
      ],
    };
  }
  return { total_results: 0, messages: [] };
}

export const RABBIT_SERVER = { forms: ['κουνέλι', 'κουνελιού'], who: [], from: null, to: null };
