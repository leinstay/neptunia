// The harness of the turn tests that drive her tools: one mention by Alice (an owner) in #general answered by a
// scripted fake model over a real admin and the fake interface adapter (src/interface/fake.js); no network,
// no data/. An answer of the script is a string (speech only), a toolAnswer (tests/fixtures/tool-answers.js) or a
// function of the request that builds one; the last one repeats.
import { after } from 'node:test';
import path from 'node:path';
import { createTurnRunner as createRealTurnRunner } from '../../src/behavior/turn.js';
import { userText } from '../../src/behavior/prompt.js';
import { createFakeAdapter } from '../../src/interface/fake.js';
import { createDiscordInterface } from '../../interfaces/discord/index.js';
import { createJournal } from '../../src/memory/journal.js';
import { createTaskStores } from '../../src/errands/store.js';
import { createErrandService } from '../../src/errands/service.js';
import { tempDir } from './tmp.js';
import { openTestMemorySync } from './memory-db/service.js';
import '../../src/tools/impl/index.ts';
import { skillRegistry } from '../../src/tools/registry.ts';
import { createAdmin } from '../../src/admin.js';
import { labels } from './labels.js';
import { withCapturedLogs } from './capture-logs.js';
import { completionOf } from './tool-answers.js';
import { freshWorld, onWorld, useIface, world } from './turn-world.ts';

// The turn's conversations are held by a fake interface of the world of the test, named `fake`.
useIface('fake');
/** `createTurnRunner` over the world: `runTurn` takes a channel of the world; an adapter the test brings holds what the world holds. */
export const createTurnRunner = onWorld(createRealTurnRunner);

export const DISCORD = createDiscordInterface().capabilities;
export const NOW = Date.parse('2026-10-17T12:00:00Z');

export function rawMessage({ id, authorId = 'u1', authorName = 'Alice', ts = NOW - 1000, content = 'hey bot', attachments = new Map() }) {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments,
    stickers: new Map(),
  };
}

export function normalizedTrigger(raw) {
  return { id: raw.id, channelId: raw.channelId, authorId: raw.author.id, authorName: raw.author.globalName, self: false, bot: false, content: raw.cleanContent, ts: raw.createdTimestamp, replyToId: null, attachments: [], stickers: [] };
}

/**
 * #general (c1) of the world, holding `historyMessages` (the array may grow: later lines reach the history too), with
 * `neighbours` as its other channels.
 * @param {Array<Record<string, unknown>>} historyMessages
 * @param {Array<{ id: string, name: string }>} [neighbours]
 * @returns {import('./turn-world.ts').Channel}
 */
export function fakeChannel(historyMessages, neighbours = []) {
  // One history array is one channel for as long as the world lives: asking again gives the channel back, with what
  // she posted in it.
  const held = KNOWN.get(historyMessages);
  if (held && held.world === world()) return held.channel;
  for (const neighbour of neighbours) world().channel({ id: neighbour.id, name: neighbour.name });
  const channel = world().channel({ id: 'c1', name: 'general', guildId: 'g1', historyMessages });
  KNOWN.set(historyMessages, { world: world(), channel });
  return channel;
}

/** @type {WeakMap<object, { world: object, channel: import('./turn-world.ts').Channel }>} */
const KNOWN = new WeakMap();

export function fakeStore({ profiles = [] } = {}) {
  return {
    getGuild: () => ({}),
    getUser: (guildId, id) => profiles.find((profile) => profile.id === id) ?? null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => profiles,
    countUsers: () => profiles.length,
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
}

export function hotWith({ features = {}, skills = {}, access = {}, config = {} } = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '', owners: ['u1'], access },
      context: {
        channelMessages: 100, neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8, maxMessageChars: 800,
        gapMarkerMinutes: 20, otherProfiles: 6, caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { memory: true, reactions: true, multiMessage: true, typingSimulation: false, vision: false, callMarkers: true, ...features },
      models: { base: { analyzer: 'x/text' } },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      skills: { safeMode: false, resultMaxChars: 2000, callTimeoutMs: 120000, ...skills },
      ...config,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      lookup: 'Decide whether {{name}} needs to look something up.',
      labels,
    },
  };
}

export function personaGrants(names) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

/** An LLM answering `answers` in turn (the last one repeats); the search classifier answers `classifier` and the re-watch classifier `none`, each counted apart. */
export function sequenceLlm(answers, classifier = 'none', onAnswer = null) {
  const calls = [];
  const classifierCalls = [];
  const rewatchCalls = [];
  const options = [];
  return {
    calls,
    classifierCalls,
    rewatchCalls,
    options,
    complete: async (messages, requestOptions) => {
      if (messages[0].content.startsWith('Decide whether')) {
        classifierCalls.push(messages);
        return { text: classifier, usage: {}, estimated: 5 };
      }
      if (messages[0].content.startsWith('Pick a second look')) {
        rewatchCalls.push(messages);
        return { text: 'none', usage: {}, estimated: 5 };
      }
      calls.push(messages);
      options.push(requestOptions ?? {});
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (onAnswer) onAnswer(calls.length - 1);
      return completionOf(typeof answer === 'function' ? answer(messages) : answer);
    },
  };
}

/** The test memory databases the harness opened; closed when the test file is done. */
const OPENED_MEMORY = [];
after(async () => {
  for (const mem of OPENED_MEMORY.splice(0)) await mem.close();
});

/** A real journal over a test memory database whose writes also keep every line in memory (`lines`: `{ file, record }`). */
export function journalOverMemory() {
  const lines = [];
  const mem = openTestMemorySync();
  OPENED_MEMORY.push(mem);
  const memoryDb = {
    ...mem.memoryDb,
    writeUnit: (update) => {
      for (const line of update.lines ?? []) lines.push({ file: path.join('fake-data', update.owner), record: line });
      return mem.memoryDb.writeUnit(update);
    },
  };
  let n = 0;
  const journal = createJournal({ memoryDb, dataDir: 'fake-data', config: () => ({ thinkChars: 4000 }), now: () => NOW, uuid: () => `u${(n += 1)}` });
  return { journal, lines };
}

/**
 * One mention by Alice (u1, an owner) in #general (c1) answered with `answers` in turn, with the
 * tool loop on (`coreTools`) and `loop` as skills.loop; `allowed` skills granted to the persona;
 * `wrapCommand` wraps the admin's runSkillOp; `runner` and `adminExtra` go to the runner and the
 * admin as they are.
 */
export async function coreTurn({ answers, allowed = ['lore.list', 'memory.server.read'], coreTools = true, loop = {}, features = {}, journal = null, wrapCommand = null, runner = {}, adminExtra = {}, store = fakeStore(), content = 'βρες κάτι', classifier = 'none', config = {}, firstAttachments = new Map(), prompts = {}, seeds = [], triggerKind = 'mention', neighbours = [], clientExtra = {}, setup = null, inner = null, spontaneous = null, onAnswer = null, withHot = null, earlier = [] }) {
  const history = [...earlier, rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'u2', authorName: 'Zoë', content: 'καλημέρα', attachments: firstAttachments }), rawMessage({ id: 'm1', content })];
  const hot = hotWith({
    features: { coreTools, journal: Boolean(journal), ...features },
    skills: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4, ...loop } },
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
  const admin = createAdmin({ discord: DISCORD, hot, store, client, getGuildId: () => 'g1', reads: world().adopt(port), port, ...adminExtra });
  const runOp = wrapCommand ? wrapCommand(admin.runSkillOp) : admin.runSkillOp;
  const llm = sequenceLlm(answers, classifier, onAnswer ? (n) => onAnswer(n, history, port) : null);
  const calibrator = { ratio: 1, apply: (value) => value, observe: () => {} };
  const turns = createTurnRunner({ discord: DISCORD, hot, store, llm, calibrator, client, now: () => NOW, port, skills: skillRegistry(), journal, runOp, runOwnOp: admin.runOwnSkillOp, runInitiativeOp: admin.runInitiativeSkillOp, ...runner });
  // An inner turn (`inner`: the wake): nobody asked, no trigger.
  const again = spontaneous
    ? () => turns.runTurn({ channel, mode: spontaneous })
    : inner
    ? () => turns.runTurn({ channel, guildId: 'g1', mode: 'inner', triggerKind: 'inner', inner: { wake: inner, shadow: false, mayAct: () => true } })
    : () => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(history.at(-1)), triggerKind });
  const { result, logs } = await withCapturedLogs(again);
  const sends = port.calls.filter((call) => call.op === 'send').map((call) => ({ to: call.args[0].conversationId, ...call.args[1] }));
  return { result, logs, llm, sends, hot, admin, again, port, turns };
}

/** The user text of the turn's request `i`. */
export function requestText(llm, i) {
  return userText(llm.calls[i][1].content);
}

/** The messages request `i` carries after the first two (her answers, the tool messages, the notes), in order. */
export function appended(llm, i) {
  return llm.calls[i].slice(2);
}

/** The text of a message's content, parts joined. */
export function contentText(content) {
  return typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
}

/** The tool messages of request `i`, as `tool_call_id: first line of the content`. */
export function toolResults(llm, i) {
  return appended(llm, i).filter((message) => message.role === 'tool').map((message) => `${message.tool_call_id}: ${contentText(message.content).split('\n')[0]}`);
}

/** The trailing note of request `i` (the last message when it is a user one), '' when it has none. */
export function noteText(llm, i) {
  const last = appended(llm, i).at(-1);
  return last?.role === 'user' ? contentText(last.content) : '';
}

/** A real errand service over a temp task store and a runner client that records each run (never ending here). */
export function errandService(hot) {
  const runs = [];
  const client = { configured: () => true, run: (task) => (runs.push(task), new Promise(() => {})), cancel: () => true };
  const stores = createTaskStores({ dataDir: tempDir('nep-core-tools-'), config: () => hot.config });
  const service = createErrandService({ client, stores, hot, getGuildId: () => 'g1', defer: (fn) => fn() });
  return { service, runs };
}

export const AGENTS = { agents: { maxOpen: 3, resultMaxChars: 400, scout: { enabled: true, daily: { tasks: 10 } } } };

export const WEB_CONFIG = { web: { maxPerDay: 60, links: { enabled: false }, search: { enabled: true, maxPerTurn: 1, contextMessages: 50 } }, recall: { maxForms: 4 } };
