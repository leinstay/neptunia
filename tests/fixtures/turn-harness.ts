// The harness of the turn tests that drive her tools: one mention by Alice (an owner) in #general answered by a
// scripted fake model over a real admin and the fake interface adapter (src/interface/fake.ts); no network,
// no data/. An answer of the script is a string (speech only), a toolAnswer (tests/fixtures/tool-answers.ts) or a
// function of the request that builds one; the last one repeats.
import { after } from 'node:test';
import { createTurnRunner as createRealTurnRunner } from '../../src/behavior/turn.ts';
import { userText } from '../../src/behavior/prompt.ts';
import { createFakeAdapter } from '../../src/interface/fake.ts';
import { createDiscordInterface } from '../../interfaces/discord/index.ts';
import { createJournal } from '../../src/memory/journal.ts';
import { createErrandStores } from '../../src/errands/store.ts';
import { createErrandService } from '../../src/errands/service.ts';
import { openTestMemorySync, journalLabel } from './memory-db/service.ts';
import type { StorageKey } from '../../src/memory/db/storage-keys.ts';
import '../../src/tools/impl/index.ts';
import { skillRegistry } from '../../src/tools/registry.ts';
import { createAdmin } from '../../src/admin.ts';
import { labels } from './labels.ts';
import { withCapturedLogs } from './capture-logs.ts';
import type { LogEntry } from './capture-logs.ts';
import { completionOf } from './tool-answers.ts';
import { freshWorld, onWorld, useIface, world } from './turn-world.ts';
import type { Completion } from './tool-answers.ts';
import type { Channel, Fake, World } from './turn-world.ts';
import type { CreateTurnRunnerInput } from '../../src/behavior/turn-types.ts';
import type { RunOutcome, RunRequest } from '../../src/errands/types.ts';
import type { Untyped } from '../../src/tools/types.ts';

// The turn's conversations are held by a fake interface of the world of the test, named `fake`.
useIface('fake');
/** `createTurnRunner` over the world: `runTurn` takes a channel of the world; an adapter the test brings holds what the world holds. */
export const createTurnRunner = onWorld((options) => createRealTurnRunner(options as CreateTurnRunnerInput));

export const DISCORD = createDiscordInterface().capabilities;
export const NOW = Date.parse('2026-10-17T12:00:00Z');

type RawMessageSpec = {
  id: string;
  authorId?: string;
  authorName?: string;
  ts?: number;
  content?: string;
  attachments?: Map<string, unknown>;
};

/** A discord.js-shaped message stub of #general. */
export type RawMessage = {
  id: string;
  placeId: string;
  author: { id: string; bot: boolean; globalName: string; username: string };
  member: { displayName: string };
  cleanContent: string;
  createdTimestamp: number;
  reference: null;
  attachments: Map<string, unknown>;
  stickers: Map<string, unknown>;
};

export function rawMessage({ id, authorId = 'u1', authorName = 'Alice', ts = NOW - 1000, content = 'hey bot', attachments = new Map() }: RawMessageSpec): RawMessage {
  return {
    id,
    placeId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments,
    stickers: new Map(),
  };
}

/** The trigger of a turn as the runner reads it. */
type Trigger = {
  id: string;
  placeId: string;
  authorId: string;
  authorName: string;
  self: boolean;
  bot: boolean;
  content: string;
  ts: number;
  replyToId: null;
  attachments: Array<unknown>;
  stickers: Array<unknown>;
};

export function normalizedTrigger(raw: RawMessage): Trigger {
  return { id: raw.id, placeId: raw.placeId, authorId: raw.author.id, authorName: raw.author.globalName, self: false, bot: false, content: raw.cleanContent, ts: raw.createdTimestamp, replyToId: null, attachments: [], stickers: [] };
}

/**
 * #general (c1) of the world, holding `historyMessages` (the array may grow: later lines reach the history too), with
 * `neighbours` as its other channels.
 */
export function fakeChannel(historyMessages: Array<Record<string, unknown>>, neighbours: Array<{ id: string; name: string }> = []): Channel {
  // One history array is one channel for as long as the world lives: asking again gives the channel back, with what
  // she posted in it.
  const held = KNOWN.get(historyMessages);
  if (held && held.world === world()) return held.channel;
  for (const neighbour of neighbours) world().channel({ id: neighbour.id, name: neighbour.name });
  const channel = world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages });
  KNOWN.set(historyMessages, { world: world(), channel });
  return channel;
}

const KNOWN = new WeakMap<object, { world: World; channel: Channel }>();

type Profile = { id: string } & Record<string, unknown>;

/** A store that holds only the `profiles` it is given. */
type FakeStore = {
  topPlaces: () => Array<string>;
  getPlace: () => object;
  getUser: (id: string) => Profile | null;
  getPrivate: () => null;
  listChannels: () => Array<unknown>;
  listUserProfiles: () => Array<Profile>;
  countUsers: () => number;
  getLore: () => Array<unknown>;
  getMediaCache: () => object;
  state: { data: object; markDirty(): void };
};

export function fakeStore({ profiles = [] }: { profiles?: Array<Profile> } = {}): FakeStore {
  return {
    topPlaces: () => ['g1'],
    getPlace: () => ({}),
    getUser: (id: string) => profiles.find((profile) => profile.id === id) ?? null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => profiles,
    countUsers: () => profiles.length,
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
}

/** The live config and prompts a test hands the runner. */
export type HotStandIn = {
  config: {
    bot: Record<string, unknown>;
    context: Record<string, unknown>;
    llm: Record<string, unknown>;
    typing: Record<string, unknown>;
    models: Record<string, unknown>;
    tools: Record<string, unknown>;
    [key: string]: unknown;
  };
  prompts: Record<string, unknown>;
};

// PR 7d: the `features` switches are code or gone, and the context, media and GIF knobs of the cut are constants of
// their modules, so the hot config carries only the keys that are still settings.
export function hotWith({
  tools = {},
  access = {},
  config = {},
}: { tools?: Record<string, unknown>; access?: Record<string, unknown>; config?: Record<string, unknown> } = {}): HotStandIn {
  return {
    config: {
      bot: { timezone: 'UTC', owners: ['u1'], access },
      context: {
        channelMessages: 100, caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { base: { analyzer: 'x/text' } },
      tools: { safeMode: false, resultMaxChars: 2000, callTimeoutMs: 120000, ...tools },
      ...config,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      'query-builder': 'Decide whether {{name}} needs to look something up.',
      labels,
    },
  };
}

export function personaGrants(names: ReadonlyArray<string>): Record<string, { everyone: boolean; roles: Array<string>; users: Array<string> }> {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

/** One request message as the fake model records it: a system, user, assistant or tool message. */
export type ChatMessage = { role?: string; content?: string | Array<{ type?: string; text?: string }> | null; tool_call_id?: string };

/** The fake model of `sequenceLlm`: every request it got, by kind, and the `complete` that answers. */
export type FakeLlm = {
  calls: Array<Array<ChatMessage>>;
  classifierCalls: Array<Array<ChatMessage>>;
  rewatchCalls: Array<Array<ChatMessage>>;
  options: Array<Record<string, unknown>>;
  complete: (messages: Array<ChatMessage>, requestOptions?: Record<string, unknown>) => Promise<Completion>;
};

/**
 * An LLM answering `answers` in turn (the last one repeats); the search classifier answers `classifier` and the re-watch classifier `none`, each counted apart.
 * `onAnswer` is called with the index of each answer as it is given.
 */
export function sequenceLlm(answers: ReadonlyArray<unknown>, classifier = 'none', onAnswer: ((index: number) => void) | null = null): FakeLlm {
  const calls: Array<Array<ChatMessage>> = [];
  const classifierCalls: Array<Array<ChatMessage>> = [];
  const rewatchCalls: Array<Array<ChatMessage>> = [];
  const options: Array<Record<string, unknown>> = [];
  return {
    calls,
    classifierCalls,
    rewatchCalls,
    options,
    complete: async (messages: Array<ChatMessage>, requestOptions?: Record<string, unknown>): Promise<Completion> => {
      if (contentText(messages[0].content).startsWith('Decide whether')) {
        classifierCalls.push(messages);
        return { text: classifier, usage: {}, estimated: 5 };
      }
      if (contentText(messages[0].content).startsWith('Pick a second look')) {
        rewatchCalls.push(messages);
        return { text: 'none', usage: {}, estimated: 5 };
      }
      calls.push(messages);
      options.push(requestOptions ?? {});
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (onAnswer) onAnswer(calls.length - 1);
      // An answer of the script is a string (speech only), a completion or a function of the request that builds either.
      return completionOf(typeof answer === 'function' ? (answer as (request: Array<ChatMessage>) => unknown)(messages) : answer);
    },
  };
}

/** The test memory databases the harness opened; closed when the test file is done. */
const OPENED_MEMORY: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const mem of OPENED_MEMORY.splice(0)) await mem.close();
});

/** A real journal over a test memory database whose writes also keep every line in memory (`lines`: `{ file, record }`). */
export function journalOverMemory(): { journal: ReturnType<typeof createJournal>; lines: Array<{ file: string; record: unknown }> } {
  const lines: Array<{ file: string; record: unknown }> = [];
  const mem = openTestMemorySync();
  OPENED_MEMORY.push(mem);
  const memoryDb = {
    ...mem.memoryDb,
    writeUnit: (given: unknown) => {
      const update = given as { key: StorageKey; lines?: Array<unknown> };
      for (const line of update.lines ?? []) lines.push({ file: journalLabel('fake-data', update.key), record: line });
      return mem.memoryDb.writeUnit(update);
    },
  };
  let n = 0;
  const journal = createJournal({ memoryDb, dataDir: 'fake-data', config: () => ({ thinkChars: 4000 }), now: () => NOW, uuid: () => `u${(n += 1)}` });
  return { journal, lines };
}

/**
 * One mention by Alice (u1, an owner) in #general (c1) answered with `answers` in turn, with the
 * tool loop on and `loop` as tools.loop; `allowed` skills granted to the persona;
 * `wrapCommand` wraps the admin's runSkillOp; `runner` and `adminExtra` go to the runner and the
 * admin as they are.
 */
type CoreTurnSpec = {
  answers: ReadonlyArray<unknown>;
  allowed?: Array<string>;
  loop?: Record<string, unknown>;
  journal?: unknown;
  wrapCommand?: ((runOp: Untyped) => Untyped) | null;
  runner?: Record<string, unknown>;
  adminExtra?: Record<string, unknown>;
  store?: Untyped;
  content?: string;
  classifier?: string;
  config?: Record<string, unknown>;
  firstAttachments?: Map<string, unknown>;
  prompts?: Record<string, unknown>;
  seeds?: Array<{ conversationId: string; authorId: string; text?: string; messageId?: string }>;
  triggerKind?: string;
  neighbours?: Array<{ id: string; name: string }>;
  clientExtra?: Record<string, unknown>;
  setup?: ((port: Fake) => void) | null;
  inner?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
  spontaneous?: string | null;
  onAnswer?: ((index: number, history: Array<Record<string, unknown>>, port: Fake) => void) | null;
  withHot?: ((hot: ReturnType<typeof hotWith>) => void) | null;
  earlier?: Array<ReturnType<typeof rawMessage>>;
};

type CoreTurnResult = {
  result: unknown;
  logs: Array<LogEntry>;
  llm: FakeLlm;
  sends: Array<Record<string, unknown>>;
  hot: HotStandIn;
  admin: ReturnType<typeof createAdmin>;
  again: () => Promise<unknown>;
  port: Fake;
  turns: ReturnType<typeof createTurnRunner>;
};

export async function coreTurn({
  answers,
  allowed = ['lore.list', 'memory.server.read'],
  loop = {},
  journal = null,
  wrapCommand = null,
  runner = {},
  adminExtra = {},
  store = fakeStore(),
  content = 'βρες κάτι',
  classifier = 'none',
  config = {},
  firstAttachments = new Map(),
  prompts = {},
  seeds = [],
  triggerKind = 'mention',
  neighbours = [],
  clientExtra = {},
  setup = null,
  inner = null,
  params = {},
  spontaneous = null,
  onAnswer = null,
  withHot = null,
  earlier = [],
}: CoreTurnSpec): Promise<CoreTurnResult> {
  const history = [...earlier, rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'u2', authorName: 'Zoë', content: 'καλημέρα', attachments: firstAttachments }), rawMessage({ id: 'm1', content })];
  const hot = hotWith({
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4, ...loop } },
    access: personaGrants(allowed),
    config,
  });
  Object.assign(hot.prompts, prompts);
  if (withHot) withHot(hot);
  freshWorld();
  const channel = fakeChannel(history, neighbours);
  // #jardin (c2): a neighbour of the same guild where the bot may do anything (a message quoted from it can be edited).
  world().channel({ id: 'c2', name: 'jardin' });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  for (const seed of seeds) port.seed(seed.conversationId, seed);
  if (setup) setup(port);
  const client = { user: { id: 'self-id', username: 'Bot' }, ...clientExtra };
  const admin = createAdmin({ discord: DISCORD, hot, store, client, isServedCommunity: (id: unknown) => id === 'g1', reads: world().adopt(port), port, ...adminExtra });
  const runOp = wrapCommand ? wrapCommand(admin.runSkillOp) : admin.runSkillOp;
  const llm = sequenceLlm(answers, classifier, onAnswer ? (n) => onAnswer(n, history, port) : null);
  const calibrator = { ratio: 1, apply: (value: number) => value, observe: () => {} };
  const turns = createTurnRunner({ discord: DISCORD, hot, store, llm, calibrator, client, now: () => NOW, port, skills: skillRegistry(), journal, runOp, runOwnOp: admin.runOwnSkillOp, runInitiativeOp: admin.runInitiativeSkillOp, ...runner });
  // An inner turn (`inner`: the wake): nobody asked, no trigger.
  const again = spontaneous
    ? () => turns.runTurn({ channel, mode: spontaneous })
    : inner
    ? () => turns.runTurn({ ...params, channel, placeId: 'g1', mode: 'inner', triggerKind: 'inner', inner: { wake: inner, shadow: false, mayAct: () => true } })
    : () => turns.runTurn({ ...params, channel, mode: 'reply', trigger: normalizedTrigger(history[history.length - 1]), triggerKind });
  const { result, logs } = await withCapturedLogs(again);
  const sends = port.calls.filter((call) => call.op === 'send').map((call) => ({ to: (call.args[0] as { conversationId: string }).conversationId, ...(call.args[1] as object) }));
  return { result, logs, llm, sends, hot, admin, again, port, turns };
}

/** The fake model `sequenceLlm` builds. */
type Llm = FakeLlm;

/** The user text of the turn's request `i`. */
export function requestText(llm: Llm, i: number): string {
  return userText(llm.calls[i][1].content);
}

/** The messages request `i` carries after the first two (her answers, the tool messages, the notes), in order. */
export function appended(llm: Llm, i: number): Array<ChatMessage> {
  return llm.calls[i].slice(2);
}

/** The text of a message's content, parts joined. */
export function contentText(content: unknown): string {
  return typeof content === 'string' ? content : ((content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('');
}

/** The tool messages of request `i`, as `tool_call_id: first line of the content`. */
export function toolResults(llm: Llm, i: number): Array<string> {
  return appended(llm, i).filter((message) => message.role === 'tool').map((message) => `${message.tool_call_id}: ${contentText(message.content).split('\n')[0]}`);
}

/** The trailing note of request `i` (the last message when it is a user one), '' when it has none. */
export function noteText(llm: Llm, i: number): string {
  const last = appended(llm, i).at(-1);
  return last?.role === 'user' ? contentText(last.content) : '';
}

/** A real errand service over its stores and a runner client that records each run (never ending here). */
export function errandService(hot: { config: Record<string, unknown> }): {
  service: ReturnType<typeof createErrandService>;
  runs: Array<RunRequest>;
} {
  const runs: Array<RunRequest> = [];
  const client = { configured: () => true, run: (task: RunRequest) => (runs.push(task), new Promise<RunOutcome>(() => {})), cancel: () => true };
  const stores = createErrandStores({ config: () => hot.config });
  const service = createErrandService({ client, stores, hot, defer: (fn) => fn() });
  return { service, runs };
}

export const AGENTS = { errands: { maxOpen: 3, resultMaxChars: 400 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } };

// PR 7d: the web cap is gone and the links, search counts and recall forms are constants.
export const WEB_CONFIG = { web: { search: { enabled: true } } };
