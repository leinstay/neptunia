// Tests for the step engine of tools/replay.mjs (`--skills`, `--pair-transport`, `--loop-triggers`): a
// scenario run is answered as a live turn answers it -- every call of each answer through the real
// gateway, her in-turn tools run (here by fakes), an errand.run only recorded, the turn continued step after
// step within the loop's bounds, her speech held when a call left something to read -- and what runs.jsonl,
// the report and the pair sheet make of it. Fakes only: no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import '../src/tools/impl/index.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import {
  IN_TURN_TOOLS,
  lookPerTurn,
  runMediaFind,
  runMediaLook,
  runMemorySearch,
  runWebRead,
  runWebSearch,
} from '../src/tools/tools.ts';
import { runConversationRead, fetchSpan, recordMessages } from '../src/tools/conversation-read.ts';
import { pullPictures } from '../src/behavior/pull.js';
import {
  callViewOf,
  searchHandles,
  coreToolsOn,
  fallbackLookupPlan,
  loopSettings,
  lookupClassifierInput,
  requesterOf,
} from '../src/behavior/turn.js';
import { transportOf } from '../src/tools/tool-calls.ts';
import { createTaskStore } from '../src/errands/store.js';
import { createImageGen } from '../src/llm/images.js';
import { tempDir } from './fixtures/tmp.js';
import { fill } from '../src/format.js';
import { fillPromptTemplate } from '../src/behavior/prompt.js';
import { parseLookupAnswer, recallSettings } from '../src/behavior/recall.js';
import { zonedDay } from '../src/time.js';
import { roleModel } from '../src/llm/roles.js';
import { cacheTtlFor, helperRequestOptions, withCacheMarker } from '../src/llm/openrouter.js';
import * as sandbox from '../src/behavior/sandbox.js';
import {
  afterScenarioTurn,
  answerSkillScenario,
  hiddenLater,
  liveView,
  momentCutoff,
  momentView,
  personaGrantsConfig,
  simulateCall,
} from '../src/behavior/sandbox.js';
import {
  createReplayTools,
  loopCall,
  loopRecord,
  loopRequestEstimate,
  pairAnswerOf,
  parseArgs,
  parseScenarios,
  preTurnLookup,
  renderLoopTriggersReport,
  renderSkillsReport,
  guildListing,
  requestBlocks,
  requesterOfChannel,
  runRecord,
  scenarioSummary,
  replayWithoutCache,
  runTriggerLoops,
  scenarioTrigger,
  skillRequestEstimate,
  withCoreTools,
  withTransport,
} from '../tools/replay.mjs';
import { labels } from './fixtures/labels.js';
import { call, completionOf, textAnswer, toolAnswer } from './fixtures/tool-answers.js';
import { useIface, world } from './fixtures/turn-world.ts';

// The conversation of the tools' history read is held by a fake interface named `fake`.
useIface('fake');

const OWNER = '100000000000000042';
const SELF = '100000000000000001';
const HERE = '200000000000000001';
const GUILD = '300000000000000001';
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const TOOLS = ['web.search', 'memory.search', 'errand.run'];
const THINK = '<think>t</think>';

/** The config of a scenario with her tools granted and the switch on; `loop` its bounds. */
function toolConfig({ loop = { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 }, features = {} } = {}) {
  const base = withCoreTools({
    bot: { owners: [OWNER], timezone: 'UTC', access: {} },
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
    tools: { safeMode: false, loop },
    features: { tools: true, webLookup: true },
  });
  // A test's own switches last: `coreTools: false` turns the switch off again.
  return personaGrantsConfig({ ...base, features: { ...base.features, ...features } }, SELF, TOOLS);
}

/** A discord.js-like channel γενικά in a guild, nobody's roles cached. */
function fakeChannel() {
  return {
    id: HERE,
    name: 'γενικά',
    guild: {
      id: GUILD,
      channels: { cache: new Map([[HERE, { id: HERE, name: 'γενικά', type: 0 }]]) },
      roles: { cache: new Map() },
      members: { cache: new Map() },
    },
  };
}

/** A model that answers `answers` in order (a string is speech, an object a tool answer; each with a reported cost) and keeps every request. */
function scriptedLlm(answers) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      return {
        ...completionOf(answers[calls.length - 1] ?? '<skip/>'),
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
      };
    },
  };
}

/** The user text of one recorded request (the first user message: it is never rebuilt). */
function userOf(recorded) {
  const content = recorded.messages[1].content;
  return typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('');
}

/** The note that ends a continued request (its last message when that is a user message). */
function noteOf(recorded) {
  const last = recorded.messages.at(-1);
  return last.role === 'user' ? last.content.map((part) => part.text ?? '').join('\n') : '';
}

/** A clock that moves `step` ms on every read. */
function tickingClock(step = 10) {
  let t = 0;
  return () => (t += step);
}

/**
 * One scenario run of the owner's message with her tool loop, against fakes: `answers` her
 * answers in order; `tool(skill, args)` what an in-turn tool answers (`{ result, usage }`).
 */
async function loopRun(answers, { tool, config = toolConfig(), clock = tickingClock(), prefetch = null } = {}) {
  const cfg = config;
  const hot = {
    config: cfg,
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      format: 'FORMAT',
      reply: 'REPLY {{author}}',
      labels,
    },
  };
  const store = {
    getGuild: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    state: { data: {} },
  };
  const view = liveView({ hot, store, guildId: 'g1' });
  const channel = fakeChannel();
  const here = { id: HERE, name: 'γενικά' };
  const trigger = scenarioTrigger({
    text: 'Ποιος κέρδισε τον τελικό;',
    authorId: OWNER,
    authorName: 'Élodie',
    channel: here,
    selfId: SELF,
    at: NOW,
  });
  const situation = { history: [trigger], triggerId: trigger.id, kind: 'mention', mode: 'reply' };
  const registry = skillRegistry();
  const requester = requesterOfChannel(requesterOf)(trigger, channel);
  const tasks = { budget: () => ({ spent: false, key: null, code: null }) };
  const toolCalls = [];
  const simulate = (call, { idByIndex, history: lines, channelHandles = null }) =>
    simulateCall({
      call,
      view: callViewOf({
        channel,
        snapshot: guildListing(channel),
        guildId: GUILD,
        idByIndex,
        lines,
        pulledIds: new Map(),
        memoryOn: false,
        store: null,
        selfId: SELF,
        skills: registry,
        channelHandles,
      }),
      config: cfg,
      selfId: SELF,
      requester,
      conversationId: HERE,
      now: NOW,
      tasks,
      images: { quota: () => ({ spent: false, userSpent: false }) },
      resultText: 'queued',
    });
  const onCall = loopCall({
    simulate,
    runTool: async (skill, args, refs) => {
      toolCalls.push({ skill, args, timeoutMs: refs.timeoutMs });
      return tool(skill, args);
    },
    inTurn: IN_TURN_TOOLS,
    now: clock,
  });
  const llm = scriptedLlm(answers);
  const coreTools = { recallAvailable: true, ...(prefetch ? { prefetch } : {}) };
  const answered = await answerSkillScenario({
    view,
    situation,
    selfId: SELF,
    selfName: 'Persona',
    channel: here,
    llm,
    runs: 1,
    at: NOW,
    searchAvailable: true,
    onCall,
    coreTools,
    loop: { settings: loopSettings(cfg), now: clock },
  });
  return { answered, run: answered.runs[0], llm, toolCalls, trigger, here };
}

/** A tool answering ok with `text`, its own request costing `cost`. */
const okTool = (text, cost = 0.002) => ({
  result: { status: 'ok', data: { text } },
  usage: { requests: 1, tokens: { prompt: 50, completion: 5 }, cost },
});

test('replay flags: --core-tools goes with --skills only; --pair-transport and --loop-triggers take triggers and no prompt directories; --transport goes with --loop-triggers and --skills', () => {
  assert.equal(parseArgs(['--skills', 'a.json', '--core-tools']).coreTools, true);
  assert.equal(parseArgs(['--skills', 'a.json']).coreTools, false);
  assert.equal(parseArgs(['--skills', 'a.json', '--transport', 'text']).transport, 'text');
  assert.throws(() => parseArgs(['123456789012345678', '223456789012345678', '--core-tools']), /usage/);
  assert.throws(() => parseArgs(['--diary-day', '--core-tools']), /usage/);
  const pair = parseArgs([
    '--pair-transport',
    '--triggers',
    't.txt',
    '--as-of-moment',
    '--snapshot',
    'snap',
    '--out',
    'o',
    '--spend',
    '3',
  ]);
  assert.deepEqual(
    [pair.pairTransport, pair.pair, pair.triggers, pair.asOfMoment, pair.snapshot, pair.outDir],
    [true, null, 't.txt', true, 'snap', 'o']
  );
  const one = parseArgs(['--pair-transport', '123456789012345678', '223456789012345678']);
  assert.deepEqual([one.channelId, one.triggerId], ['123456789012345678', '223456789012345678']);
  assert.throws(() => parseArgs(['--pair-transport', '--pair', 'a', 'b', '--triggers', 't.txt']), /usage/);
  assert.throws(() => parseArgs(['--pair-transport']), /usage/);
  assert.throws(() => parseArgs(['--skills', 'a.json', '--pair-transport']), /usage/);
  assert.throws(() => parseArgs(['--pair-transport', '--triggers', 't.txt', '--split']), /usage/);
  assert.throws(() => parseArgs(['--pair-core-tools', '--triggers', 't.txt']), /usage/, 'the old flag is gone');
  assert.throws(() => parseArgs(['--pair-transport', '--loop-triggers', '--triggers', 't.txt']), /usage/);
  assert.throws(
    () => parseArgs(['--pair-transport', '--triggers', 't.txt', '--transport', 'text']),
    /usage/,
    'the pair fixes the transports'
  );
  // The single-side loop run.
  const loop = parseArgs([
    '--loop-triggers',
    '--triggers',
    't.txt',
    '--transport',
    'text',
    '--out',
    'o',
    '--answers-dir',
    'a',
  ]);
  assert.deepEqual(
    [loop.loopTriggers, loop.transport, loop.triggers, loop.outDir, loop.answersDir],
    [true, 'text', 't.txt', 'o', 'a']
  );
  const bare = parseArgs(['--loop-triggers', '123456789012345678', '223456789012345678']);
  assert.deepEqual(
    [bare.transport, bare.channelId, bare.triggerId],
    [null, '123456789012345678', '223456789012345678']
  );
  assert.throws(() => parseArgs(['--loop-triggers']), /usage/);
  assert.throws(() => parseArgs(['--loop-triggers', '--triggers', 't.txt', '--transport', 'carrier-pigeon']), /usage/);
  assert.throws(() => parseArgs(['--loop-triggers', '--triggers', 't.txt', '--samples', '2']), /usage/);
  assert.throws(() => parseArgs(['123456789012345678', '223456789012345678', '--transport', 'text']), /usage/);
  assert.deepEqual(withTransport({ tools: { loop: { maxSteps: 3 } } }, 'text'), {
    tools: { loop: { maxSteps: 3 }, transport: 'text' },
  });
  const same = { tools: {} };
  assert.equal(withTransport(same, null), same);
});

test('loopRequestEstimate: the expected requests -- her reply, one follow-up, one search before it --, not the bound; the per-decision count of skillRequestEstimate', () => {
  assert.equal(loopRequestEstimate({ maxSteps: 3, maxCallsPerStep: 4 }), 3);
  assert.equal(loopRequestEstimate({ maxSteps: 1, maxCallsPerStep: 1 }), 3);
  const scenarios = parseScenarios(
    JSON.stringify([{ id: 'a', channelId: HERE, author: OWNER, text: 'Γεια', grants: [], runs: 2 }])
  );
  assert.equal(skillRequestEstimate(scenarios), 4);
  assert.equal(skillRequestEstimate(scenarios, { perDecision: 16 }), 32);
});

test('--no-cache: the trigger runs are marked like a live turn unless it is given; no other mode takes the flag', () => {
  assert.equal(parseArgs(['--loop-triggers', '--triggers', 't.txt']).noCache, false);
  assert.equal(parseArgs(['--loop-triggers', '--triggers', 't.txt', '--no-cache']).noCache, true);
  assert.equal(parseArgs(['--pair-transport', '--triggers', 't.txt', '--no-cache']).noCache, true);
  assert.throws(() => parseArgs(['123456789012345678', '223456789012345678', '--no-cache']), /usage/);
  assert.throws(() => parseArgs(['--skills', 'a.json', '--no-cache']), /usage/);
  const trigger = (extra = []) =>
    replayWithoutCache(parseArgs(['--loop-triggers', '--triggers', 't.txt', ...extra]), false);
  assert.equal(trigger(), false, 'one sample, no scenario file: still marked');
  assert.equal(trigger(['--no-cache']), true);
  assert.equal(replayWithoutCache(parseArgs(['--pair-transport', '--triggers', 't.txt']), false), false);
  // The other single-sample runs stay unmarked, as before.
  assert.equal(replayWithoutCache(parseArgs(['123456789012345678', '223456789012345678']), false), true);
  assert.equal(
    replayWithoutCache(parseArgs(['123456789012345678', '223456789012345678', '--samples', '3']), false),
    false
  );
  assert.equal(replayWithoutCache(parseArgs(['123456789012345678', '223456789012345678', '--split']), false), true);
});

test('the step engine: every request of a trigger run takes the live cache markers, the steps appended to the first messages included', async () => {
  const config = toolConfig();
  config.features.promptCache = true;
  const { llm } = await loopRun(
    [
      toolAnswer(`${THINK}<msg>μισό λεπτό</msg>`, [
        call('web.search', { query: 'τελικός 2026', goal: 'ποιος κέρδισε' }, { id: 'w1' }),
      ]),
      `${THINK}<msg>η Ana</msg>`,
    ],
    { tool: () => okTool('Η Ana κέρδισε.'), config }
  );
  assert.equal(llm.calls.length, 2);
  const ttl = cacheTtlFor(config, llm.calls[0].options.role, 'anthropic/claude-x', llm.calls[0].options.cache);
  assert.equal(ttl, '1h', 'the options carry no cache: false');
  const marked = (messages) =>
    withCacheMarker(messages, ttl, null).map((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.cache_control).length : 0
    );
  const [first, second] = llm.calls.map((recorded) => marked(recorded.messages));
  assert.ok(first[0] === 1 && first[1] >= 1, 'the system message and the stable part of the first request');
  assert.deepEqual(second.slice(0, 2), first.slice(0, 2), 'the same prefix, the same breakpoints');
  assert.ok(second.at(-1) >= 1, 'the latest appended message carries the tail marker');
});

test('the step engine: the first request leaves the step reserve under the prompt rail (cap x margin), whatever the output reserve is, so a call that needs a follow-up gets one', async () => {
  const config = toolConfig();
  // The output budget does not come off the prompt rail.
  config.llm = { maxRequestTokens: 14000, maxOutputTokens: 4000, safetyMargin: 0.9, timeoutMs: 1000 };
  config.tools.loop.stepReserveTokens = 2500;
  const hot = {
    config,
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      format: 'FORMAT',
      reply: 'REPLY {{author}}',
      labels,
    },
  };
  const store = {
    getGuild: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    state: { data: {} },
  };
  const view = liveView({ hot, store, guildId: 'g1' });
  const here = { id: HERE, name: 'γενικά' };
  const lines = [];
  for (let i = 0; i < 300; i += 1)
    lines.push(
      scenarioTrigger({
        text: `γραμμή ${i} ${'καλημέρα κόσμε '.repeat(10)}`,
        authorId: OWNER,
        authorName: 'Élodie',
        channel: here,
        selfId: SELF,
        at: NOW - (400 - i) * 60_000,
      })
    );
  const trigger = lines.at(-1);
  const llm = scriptedLlm([
    toolAnswer(`${THINK}<msg>α</msg>`, [call('web.search', { query: 'q', goal: 'g' }, { id: 'w1' })]),
    `${THINK}<msg>β</msg>`,
  ]);
  const answered = await answerSkillScenario({
    view,
    situation: { history: lines, triggerId: trigger.id, kind: 'mention', mode: 'reply' },
    selfId: SELF,
    selfName: 'Persona',
    channel: here,
    llm,
    runs: 1,
    at: NOW,
    searchAvailable: true,
    onCall: async () => ({
      verdict: { stage: 'gateway', ok: true },
      executed: { skill: 'web.search', args: {} },
      result: { skill: 'web.search', status: 'ok', data: { text: 'R'.repeat(2600) } },
    }),
    loop: { settings: loopSettings(config) },
  });
  const [run] = answered.runs;
  const room = Math.floor(14000 * 0.9);
  const used = answered.request.tokens + answered.request.toolsTokens;
  assert.ok(used <= room - 2500 + 200, 'the first request leaves the reserve under the prompt rail');
  assert.ok(used > room - 2500 - 1500, 'and uses the room: the output reserve is not taken off it');
  assert.equal(llm.calls.length, 2, 'the follow-up request was sent');
  assert.deepEqual(
    run.loop.steps.map((step) => step.capped),
    [null, null]
  );
});

test('the step engine: with the production limits (50000 cap, 0.9 margin, 10000 output) the chat keeps its lines and the request fits the prompt rail less tools and reserve', async () => {
  const config = toolConfig();
  config.llm = { maxRequestTokens: 50000, maxOutputTokens: 10000, safetyMargin: 0.9, timeoutMs: 1000 };
  config.tools.loop.stepReserveTokens = 6000;
  const hot = {
    config,
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      format: 'FORMAT',
      reply: 'REPLY {{author}}',
      labels,
    },
  };
  const store = {
    getGuild: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    state: { data: {} },
  };
  const view = liveView({ hot, store, guildId: 'g1' });
  const here = { id: HERE, name: 'γενικά' };
  const lines = [];
  for (let i = 0; i < 1500; i += 1)
    lines.push(
      scenarioTrigger({
        text: `γραμμή ${i} ${'καλημέρα κόσμε '.repeat(10)}`,
        authorId: OWNER,
        authorName: 'Élodie',
        channel: here,
        selfId: SELF,
        at: NOW - (1600 - i) * 60_000,
      })
    );
  const trigger = lines.at(-1);
  const llm = scriptedLlm([
    toolAnswer(`${THINK}<msg>α</msg>`, [call('web.search', { query: 'q', goal: 'g' }, { id: 'w1' })]),
    `${THINK}<msg>β</msg>`,
  ]);
  const answered = await answerSkillScenario({
    view,
    situation: { history: lines, triggerId: trigger.id, kind: 'mention', mode: 'reply' },
    selfId: SELF,
    selfName: 'Persona',
    channel: here,
    llm,
    runs: 1,
    at: NOW,
    searchAvailable: true,
    onCall: async () => ({
      verdict: { stage: 'gateway', ok: true },
      executed: { skill: 'web.search', args: {} },
      result: { skill: 'web.search', status: 'ok', data: { text: 'R'.repeat(2600) } },
    }),
    loop: { settings: loopSettings(config) },
  });
  const [run] = answered.runs;
  const room = Math.floor(50000 * 0.9);
  const used = answered.request.tokens + answered.request.toolsTokens;
  assert.ok(used <= room - 6000 + 200, 'the first request leaves the reserve under the prompt rail');
  assert.ok(used > room - 6000 - 2000, 'and uses the room: the output reserve is not taken off it');
  const chatLines =
    llm.calls[0].messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n')
      .match(/γραμμή \d+/g) ?? [];
  assert.ok(chatLines.length >= 400, `the chat keeps its lines, got ${chatLines.length}`);
  assert.equal(llm.calls.length, 2, 'the follow-up request was sent');
  assert.deepEqual(
    run.loop.steps.map((step) => step.capped),
    [null, null]
  );
});

test('loopRecord: a loop that ended on the token cap counts as capped though no call was dropped', () => {
  const answer = { messages: [], reactions: [], gif: null, skip: true, think: '' };
  const ended = loopRecord({
    ms: 5,
    steps: [{ step: 0, answer, held: true, calls: [], dropped: 0, capped: 'tokens' }],
  });
  assert.equal(ended.capped, 1);
  const dropped = loopRecord({ ms: 5, steps: [{ step: 0, answer, calls: [], dropped: 2, capped: 'steps' }] });
  assert.equal(dropped.capped, 2, 'a step that dropped calls counts them, not the cap too');
  assert.equal(loopRecord({ ms: 5, steps: [{ step: 0, answer, calls: [], dropped: 0, capped: null }] }).capped, 0);
});

test('the step engine: reads run together, a data result holds her speech, the next request appends to the first messages; a job covers the speech; an errand.run is only recorded', async () => {
  const { run, llm, toolCalls } = await loopRun(
    [
      toolAnswer(`${THINK}<msg>μισό λεπτό</msg>`, [
        call('web.search', { query: 'τελικός 2026', goal: 'ποιος κέρδισε' }, { id: 'w1' }),
        call('memory.search', { question: 'τι είπαμε για τον τελικό' }, { id: 'm1' }),
      ]),
      toolAnswer(`${THINK}<msg>το στέλνω</msg>`, [
        call(
          'errand.run',
          { agent: 'scout', goal: 'Βρες τον πλήρη πίνακα του τελικού 2026 και επέστρεψε τα ονόματα' },
          { id: 't1' }
        ),
      ]),
    ],
    { tool: (skill) => (skill === 'web.search' ? okTool('Η Ana κέρδισε.') : okTool('Élodie: το είδα', 0)) }
  );
  // Both reads ran with her resolved arguments, within the loop's time.
  assert.deepEqual(toolCalls.map((c) => c.skill).sort(), ['memory.search', 'web.search']);
  assert.equal(toolCalls.find((c) => c.skill === 'web.search').args.query, 'τελικός 2026');
  assert.ok(toolCalls.every((c) => c.timeoutMs >= 2000 && c.timeoutMs <= 20000));
  assert.equal(llm.calls.length, 2, 'an accepted errand covers her speech: no request after it');
  // Every request carries her tools; the second only appends to the first messages.
  for (const recorded of llm.calls)
    assert.ok(
      recorded.options.tools.some((tool) => tool.function.name === 'web_search') &&
        recorded.options.toolChoice === 'auto'
    );
  const [first, second] = llm.calls.map((recorded) => recorded.messages);
  assert.equal(second[1], first[1]);
  assert.deepEqual(
    second.slice(2).map((message) => message.role),
    ['assistant', 'tool', 'tool', 'user']
  );
  assert.deepEqual(
    second[2].tool_calls.map((c) => c.id),
    ['w1', 'm1']
  );
  assert.deepEqual(
    second.slice(3, 5).map((message) => message.tool_call_id),
    ['w1', 'm1']
  );
  assert.ok(
    second[3].content.includes('Η Ana κέρδισε.') && second[4].content.includes('Élodie: το είδα'),
    'each result in its own message, in the order she called'
  );
  assert.ok(noteOf(llm.calls[1]).includes(labels.task.step.held), 'she is told her speech was held');
  // runs.jsonl's line.
  const record = runRecord('s', 0, run);
  assert.deepEqual(
    [record.decision, record.skill],
    ['call', 'web.search'],
    'the single-call fields keep the first call'
  );
  assert.equal(record.loop.steps.length, 2);
  assert.deepEqual(
    record.loop.calls.map((c) => [c.step, c.skill, c.status]),
    [
      [0, 'web.search', 'ok'],
      [0, 'memory.search', 'ok'],
      [1, 'errand.run', 'ok'],
    ]
  );
  assert.deepEqual(record.loop.errands, [
    { step: 1, agent: 'scout', goal: 'Βρες τον πλήρη πίνακα του τελικού 2026 και επέστρεψε τα ονόματα' },
  ]);
  const [reply, after] = record.loop.steps;
  assert.equal(reply.resultChars, 'Η Ana κέρδισε.'.length + 'Élodie: το είδα'.length);
  assert.deepEqual([reply.held, after.held], [true, false]);
  assert.deepEqual(reply.answer.messages, ['μισό λεπτό']);
  assert.ok(
    reply.requestChars > 0 && after.requestChars > reply.requestChars,
    'the continued request holds the results'
  );
  assert.ok(Number.isFinite(reply.ms) && Number.isFinite(after.ms) && Number.isFinite(record.loop.ms));
  assert.equal(reply.calls.find((c) => c.skill === 'web.search').tool.requests, 1);
  assert.deepEqual(record.loop.messages, ['το στέλνω'], 'a held speech is not a posted message');
  assert.deepEqual(record.loop.final, ['το στέλνω']);
  assert.deepEqual(
    [record.loop.held, record.loop.thinkMissing, record.loop.requests, record.loop.turnRequests],
    [1, 0, 4, 2],
    "the tools' two requests are counted apart from her turn's"
  );
  // Her two requests and the tools' own: tokens and cost together.
  assert.deepEqual([record.tokens.prompt, record.tokens.completion], [300, 30]);
  assert.ok(Math.abs(record.cost - 0.022) < 1e-9);
  assert.equal(scenarioSummary([record]).followUps, 1);
  // The report: the calls in order, the held speech, the final messages, the turn's time and cost, the errand recorded.
  const report = renderSkillsReport([
    {
      scenario: { id: 's', text: 'x', discovery: 'inventory' },
      grantNames: TOOLS,
      summary: scenarioSummary([record]),
      records: [record],
    },
  ]);
  assert.ok(report.includes('calls in order: 0:web.search ok; 0:memory.search ok; 1:errand.run ok'));
  assert.ok(report.includes('errand recorded (step 1, not dispatched): scout: Βρες τον πλήρη'));
  assert.ok(report.includes('speech held (not posted):'));
  assert.ok(report.includes('cost: 0.0220'));
});

test('the step engine: her tools are in every request and the server search line says she calls it; no <skills> list', async () => {
  const { llm } = await loopRun(
    [toolAnswer(THINK, [call('web.search', { query: 'τελικός' })]), `${THINK}<msg>ok</msg>`],
    { tool: () => okTool('κάτι') }
  );
  for (const recorded of llm.calls) {
    const user = userOf(recorded);
    assert.ok(user.includes(labels.senses.recallTool), 'the server search line says she calls it');
    assert.ok(!user.includes('<skills>\n'), 'no classifier names her skills');
    assert.ok(!user.includes('<tools>'), 'the native transport sends the tools as a field');
  }
});

test('the step engine on the text transport: the <tools> block in the request, her <tool_call> blocks read, the results as <tool_result> parts of a user message', async () => {
  const config = withTransport(toolConfig(), 'text');
  const { run, llm } = await loopRun(
    [textAnswer(`${THINK}<msg>ψάχνω</msg>`, [call('web.search', { query: 'τελικός' })]), `${THINK}<msg>βρήκα</msg>`],
    { tool: () => okTool('Η Ana κέρδισε.'), config }
  );
  assert.equal('tools' in llm.calls[0].options, false);
  assert.ok(userOf(llm.calls[0]).includes('<tools>'));
  const appended = llm.calls[1].messages.slice(2);
  assert.deepEqual(
    appended.map((message) => message.role),
    ['assistant', 'user']
  );
  assert.ok(appended[1].content[0].text.startsWith('<tool_result id="s1c1" name="web.search" status="ok">'));
  assert.ok(appended[1].content.at(-1).text.includes(labels.task.step.held));
  const record = runRecord('s', 0, run);
  assert.deepEqual(
    record.loop.calls.map((c) => [c.skill, c.status]),
    [['web.search', 'ok']]
  );
  assert.deepEqual(record.loop.messages, ['βρήκα']);
});

test('the step engine: at maxSteps the last request says it is the last, and a call there gets a loop-cap result; its speech is held', async () => {
  const { run, llm } = await loopRun(
    [
      toolAnswer(THINK, [call('web.search', { query: 'α' })]),
      toolAnswer(THINK, [call('web.search', { query: 'β' })]),
      toolAnswer(`${THINK}<msg>τέλος</msg>`, [call('web.search', { query: 'γ' })]),
    ],
    {
      tool: (skill, args) => okTool(`αποτέλεσμα ${args.query}`),
      config: toolConfig({ loop: { maxSteps: 2, timeBudgetMs: 20000, maxCallsPerStep: 4 } }),
    }
  );
  assert.equal(llm.calls.length, 3);
  assert.ok(!noteOf(llm.calls[1]).includes(labels.task.step.last));
  assert.ok(noteOf(llm.calls[2]).includes(labels.task.step.last));
  const last = llm.calls[2].messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
  assert.ok(last.indexOf('αποτέλεσμα α') < last.indexOf('αποτέλεσμα β'), 'a later step only appends');
  const record = runRecord('s', 0, run);
  assert.deepEqual(
    [record.loop.steps[2].dropped, record.loop.steps[2].capped, record.loop.steps[2].held],
    [1, 'steps', true]
  );
  assert.deepEqual(record.loop.calls.at(-1), { step: 2, skill: 'web.search', status: 'invalid', code: 'loop-cap' });
  assert.deepEqual(record.loop.final, [], 'the final answer held its speech');
});

test('the step engine: once the time budget is spent the next request is her last; calls past maxCallsPerStep get a loop-cap result and never run', async () => {
  const ran = [];
  const { run, llm } = await loopRun(
    [
      toolAnswer(THINK, [
        call('web.search', { query: 'α' }),
        call('web.search', { query: 'β' }),
        call('web.search', { query: 'γ' }),
      ]),
      toolAnswer(THINK, [call('web.search', { query: 'δ' })]),
    ],
    {
      tool: (skill, args) => (ran.push(args.query), okTool('x')),
      clock: tickingClock(1000),
      config: toolConfig({ loop: { maxSteps: 3, timeBudgetMs: 1500, maxCallsPerStep: 2 } }),
    }
  );
  const record = runRecord('s', 0, run);
  assert.equal(record.loop.steps[0].calls.length, 3, 'a result for every call');
  assert.deepEqual(
    record.loop.steps[0].calls.map((c) => c.result.code),
    [null, null, 'loop-cap']
  );
  assert.deepEqual([record.loop.steps[0].dropped, record.extraCalls], [1, 1]);
  assert.deepEqual(ran.sort(), ['α', 'β']);
  assert.ok(noteOf(llm.calls[1]).includes(labels.task.step.last));
  assert.equal(record.loop.steps[1].capped, 'time');
});

test('the step engine: unreadable and unknown calls get a refusal she reads; arguments read in another type are counted; a missing <think> is counted', async () => {
  const { badCall } = await import('./fixtures/tool-answers.js');
  const { run, llm } = await loopRun(
    [
      toolAnswer('no think here', [
        badCall('web.search'),
        call('nope.skill', {}),
        call('web.search', { query: 'α', goal: 7 }),
      ]),
      `${THINK}<msg>εντάξει</msg>`,
    ],
    { tool: () => okTool('x') }
  );
  const record = runRecord('s', 0, run);
  assert.deepEqual(record.loop.calls.map((c) => [c.skill, c.code]).slice(0, 2), [
    ['web.search', 'malformed-call'],
    ['nope.skill', 'unknown-skill'],
  ]);
  assert.equal(record.loop.malformed, 1);
  assert.deepEqual(
    [record.loop.thinkMissing, record.loop.steps[0].thinkMissing, record.loop.steps[1].thinkMissing],
    [1, true, false]
  );
  const results = llm.calls[1].messages.filter((message) => message.role === 'tool');
  assert.equal(results.length, 3, 'one result for every call, refused ones included');
  assert.ok(results[0].content.includes(labels.tools.result.reasons['malformed-call']));
});

test('loopCall: a tool past its time answers the live timeout; one that throws fails; a refused call never runs; an errand.run is recorded only', async () => {
  const outcome = (skill, args = {}) => ({
    verdict: { stage: 'gateway', ok: true },
    executed: { skill, args },
    result: { skill, status: 'ok', data: { text: 'canned' } },
  });
  let ran = 0;
  const slow = loopCall({
    simulate: () => outcome('web.search', { query: 'α' }),
    runTool: () => new Promise(() => {}),
    inTurn: IN_TURN_TOOLS,
  });
  const late = await slow({ skill: 'web.search' }, { timeoutMs: 5 });
  assert.deepEqual([late.result.status, late.result.code], ['unknown', 'timeout']);
  const broken = loopCall({
    simulate: () => outcome('memory.search'),
    runTool: () => {
      throw new Error('boom');
    },
    inTurn: IN_TURN_TOOLS,
  });
  assert.deepEqual((await broken({ skill: 'memory.search' }, {})).result, {
    status: 'failed',
    code: 'error',
    skill: 'memory.search',
  });
  const refusal = {
    verdict: { stage: 'gateway', ok: false, code: 'not-allowed' },
    executed: null,
    result: { skill: 'web.search', status: 'denied' },
  };
  const refused = loopCall({
    simulate: () => refusal,
    runTool: () => {
      ran += 1;
    },
    inTurn: IN_TURN_TOOLS,
  });
  assert.equal(await refused({ skill: 'web.search' }, {}), refusal);
  const errand = loopCall({
    simulate: () => outcome('errand.run', { agent: 'scout', goal: 'Βρες το πρόγραμμα' }),
    runTool: () => {
      ran += 1;
    },
    inTurn: IN_TURN_TOOLS,
  });
  const recorded = await errand(
    { skill: 'errand.run', args: { agent: 'scout', goal: 'Βρες το πρόγραμμα' }, body: '' },
    {}
  );
  assert.deepEqual(recorded.errand, { agent: 'scout', goal: 'Βρες το πρόγραμμα' });
  assert.equal(recorded.result.data.text, 'canned');
  assert.equal(ran, 0);
});

test('a write and a paid effect are answered canned: draw.create is recorded as a drawing, nothing real runs', async () => {
  const { run, llm } = await loopRun(
    [
      toolAnswer(`${THINK}<msg>ορίστε</msg>`, [call('draw.create', { text: 'a cat on a roof', self: true })]),
      `${THINK}<msg>δεύτερο</msg>`,
    ],
    {
      tool: () => {
        throw new Error('no tool runs for a drawing');
      },
      config: toolConfig({ features: { imageGeneration: true } }),
    }
  );
  const record = runRecord('s', 0, run);
  assert.equal(llm.calls.length, 1, 'a finished picture is an effect: it covers her speech');
  assert.deepEqual(record.loop.drawings, [{ step: 0, text: 'a cat on a roof', self: true, channel: null }]);
  assert.deepEqual(record.loop.messages, ['ορίστε']);
});

test('createReplayTools: web.search and web.read through the lookup and memory.search through the recall runner, metered; the store and its counters untouched', async () => {
  const data = Object.freeze({ webDay: '2026-10-18', webCount: 1, recallDay: '2026-10-18', recallCount: 2 });
  const store = {
    state: { data },
    listUserProfiles: () => [],
    getLore: () => [],
    getGuild: () => ({}),
    getRecent: () => null,
  };
  const seen = {};
  const llm = {
    complete: async () => ({ text: 'σύνοψη', usage: { prompt_tokens: 40, completion_tokens: 4, cost: 0.003 } }),
  };
  const createLookup = ({ llm: client, state, store: cache }) => {
    seen.webState = state;
    cache.getMediaCache().touched = true;
    return {
      hasSearch: () => true,
      webCapLeft: () => 5,
      searchResults: async (guildId, query) => {
        await client.complete([], {});
        return {
          query,
          results: [{ title: 'Τελικός', url: 'https://example.com/t', site: 'example.com', snippet: 'Η Ana κέρδισε.' }],
        };
      },
      readPage: async (guildId, url) => ({ ok: true, url, title: '', text: 'Το κείμενο.', cut: false }),
    };
  };
  const createRecall = ({ store: recallStore }) => {
    seen.recallState = recallStore.state;
    return {
      available: () => true,
      run: async (input) => {
        seen.run = input;
        return { quotes: [{ channelName: 'γενικά', startTs: NOW, lines: 'Élodie: ναι' }] };
      },
    };
  };
  const config = toolConfig({ features: { recall: true } });
  const hot = { config, prompts: { labels } };
  const mediaCache = { kept: 1 };
  const linkOfMessage = (message) => (message.id === 'h2' ? 'https://example.org/p' : null);
  const tools = createReplayTools({
    hot,
    store,
    guild: { id: GUILD },
    guildId: GUILD,
    channel: fakeChannel(),
    selfId: SELF,
    selfName: 'Persona',
    llm,
    createLookup,
    createRecall,
    runWebSearch,
    runMemorySearch,
    runWebRead,
    pageFetcher: {},
    linkOfMessage,
    discord: {},
    // The interface describes nothing: the recall scope falls back to the replay's own channel and has no listing.
    reads: { conversationInfo: () => Promise.resolve(null), conversations: () => Promise.resolve(null) },
    mediaCache,
  });
  assert.equal(tools.recallAvailable(), true);
  const web = await tools.run('web.search', { query: 'τελικός' }, { history: [] });
  assert.equal(web.result.status, 'ok');
  assert.ok(web.result.data.text.includes('Η Ana κέρδισε.'));
  assert.deepEqual(web.usage, { requests: 1, tokens: { prompt: 40, completion: 4 }, cost: 0.003 });
  const page = await tools.run('web.read', { message: 'h2' }, { history: [{ id: 'h1' }, { id: 'h2' }] });
  assert.equal(page.result.status, 'ok');
  assert.ok(
    page.result.data.text.includes('Το κείμενο.') && page.result.data.text.includes('https://example.org/p'),
    page.result.data.text
  );
  assert.equal(page.usage.requests, 0, 'a page read sends no model request');
  const memory = await tools.run(
    'memory.search',
    { question: 'τι είπε η Élodie' },
    { history: [{ id: 'h1' }], at: NOW }
  );
  assert.equal(memory.result.status, 'ok');
  assert.ok(memory.result.data.text.includes('Élodie: ναι'));
  assert.equal(seen.run.quotes, true);
  assert.deepEqual(seen.run.history, [{ id: 'h1' }]);
  // Private copies of the counters and of the media cache: nothing of the store's is handed in.
  assert.notEqual(seen.webState.data, data);
  assert.deepEqual(seen.webState.data, { webDay: '2026-10-18', webCount: 1 });
  assert.notEqual(seen.recallState.data, data);
  assert.equal(mediaCache.touched, undefined);
});

test("afterScenarioTurn: a loop run carries the speech that was posted and every call's mark into the next step; a held speech is not in the chat", async () => {
  const { run, trigger, here } = await loopRun(
    [toolAnswer(`${THINK}<msg>ψάχνω</msg>`, [call('web.search', { query: 'α' })]), `${THINK}<msg>βρήκα</msg>`],
    { tool: () => okTool('x') }
  );
  const carried = afterScenarioTurn({
    transcript: [trigger],
    run,
    at: NOW,
    selfId: SELF,
    selfName: 'Persona',
    channel: here,
    triggerId: trigger.id,
    config: toolConfig(),
  });
  const mine = carried.transcript.filter((line) => line.authorId === SELF).map((line) => line.content);
  assert.deepEqual(mine, ['βρήκα']);
  assert.deepEqual(
    carried.callMarks.map((mark) => [mark.skill, mark.status]),
    [['web.search', 'ok']]
  );
});

test("pairAnswerOf: the sheet shows every posted message of a side's turn, its drawings and posts; the key keeps its calls", async () => {
  const answer = (text) => ({
    messages: [{ text, replyTo: null }],
    reactions: [],
    gif: null,
    skip: false,
    think: 'σκέψη',
  });
  const off = runRecord('p1', 0, {
    answer: answer('πρώτο'),
    call: { skill: 'lore.list', args: {}, body: '' },
    callError: null,
    extraCalls: 0,
    usage: null,
    outcome: { verdict: { stage: 'gateway', ok: true }, executed: null, result: { skill: 'lore.list', status: 'ok' } },
    followUp: { answer: answer('δεύτερο'), extraCall: false, usage: null },
  });
  assert.deepEqual(pairAnswerOf(off), {
    think: 'σκέψη',
    messages: ['πρώτο', 'δεύτερο'],
    reactions: [],
    gif: null,
    drawings: [],
    posts: [],
    skip: false,
    calls: [{ step: 0, skill: 'lore.list', status: 'ok', code: null }],
  });
  const on = {
    ...off,
    loop: loopRecord({
      ms: 30,
      steps: [
        { step: 0, answer: answer('α'), held: true, calls: [], dropped: 0 },
        { step: 1, answer: answer('β'), calls: [] },
      ],
    }),
  };
  assert.deepEqual(pairAnswerOf(on).messages, ['β'], 'a held step is not on the sheet');
  // A real run: a picture and a post by a message call show beside the messages.
  const { run } = await loopRun(
    [
      toolAnswer(`${THINK}<msg>ορίστε</msg>`, [
        call('draw.create', { text: 'a cat', self: false }),
        call('message.create', { channel: '#γενικά', text: 'και ένα κείμενο' }),
      ]),
    ],
    { tool: () => okTool('x'), config: toolConfig({ features: { imageGeneration: true } }) }
  );
  const answerOfRun = pairAnswerOf(runRecord('p3', 0, run));
  assert.deepEqual(answerOfRun.drawings, [{ text: 'a cat' }]);
  assert.deepEqual(answerOfRun.posts, [{ text: 'και ένα κείμενο' }]);
  assert.deepEqual(
    answerOfRun.calls.map((c) => c.skill),
    ['draw.create', 'message.create']
  );
  const silent = runRecord('p2', 0, {
    answer: { messages: [], reactions: [], gif: null, skip: true, think: '' },
    call: null,
    callError: null,
    extraCalls: 0,
    usage: null,
    outcome: null,
    followUp: null,
  });
  assert.equal(pairAnswerOf(silent).skip, true);
  assert.equal(pairAnswerOf(null), null);
});

test("renderLoopTriggersReport: a table of the turns, then each turn's calls and steps; held speech marked", async () => {
  const { run } = await loopRun(
    [toolAnswer(`${THINK}<msg>ψάχνω</msg>`, [call('web.search', { query: 'α' })]), `${THINK}<msg>βρήκα</msg>`],
    { tool: () => okTool('x') }
  );
  const record = runRecord('p1', 0, run);
  const line = {
    id: 'p1',
    scenario: 'p1',
    channelId: HERE,
    triggerId: '400000000000000009',
    turnId: null,
    at: new Date(NOW).toISOString(),
    mode: 'reply',
    kind: 'mention',
    transport: 'native',
    requestTokens: 100,
    tools: 3,
    toolsTokens: 50,
    blocks: {},
    counts: {
      steps: 2,
      calls: 1,
      requests: 3,
      turnRequests: 2,
      held: 1,
      thinkMissing: 0,
      coerced: 0,
      capped: 0,
      malformed: 0,
    },
    context: [],
    ...record,
  };
  const report = renderLoopTriggersReport([line], { transport: 'native', failed: [{ id: 'p2', error: 'boom' }] });
  assert.ok(report.startsWith('# Loop triggers (native transport)'));
  assert.ok(report.includes('| p1 | 400000000000000009 | 2 | 1 | 1 | 0 | 0 | 0 |'));
  assert.ok(report.includes('failed: p2: boom'));
  assert.ok(report.includes('calls in order: 0:web.search ok') && report.includes('speech held (not posted):'));
});

// ---- the search classifier before her reply (features.coreTools off) ----

const PRE_DEPS = {
  lookupClassifierInput,
  fallbackLookupPlan,
  fillPromptTemplate,
  zonedDay,
  roleModel,
  helperRequestOptions,
  parseLookupAnswer,
  recallSettings,
};

/** One pre-turn path over fakes: the classifier answers `answer` (or throws), the searches answer as given. */
async function preTurn({
  answer,
  web = { query: 'τελικός', text: 'Η Ana κέρδισε.', sources: [] },
  found = { text: 'Είπε ναι.', stretch: null, people: [] },
  kind = 'mention',
  recallOn = true,
  features = {},
} = {}) {
  const config = toolConfig({ features: { coreTools: false, recall: true, ...features } });
  const here = { id: HERE, name: 'γενικά' };
  const trigger = scenarioTrigger({
    text: 'Ποιος κέρδισε τον τελικό;',
    authorId: OWNER,
    authorName: 'Élodie',
    channel: here,
    selfId: SELF,
    at: NOW,
  });
  const requests = [];
  const ran = { web: [], server: [] };
  const llm = {
    complete: async (messages, options) => {
      requests.push({ messages, options });
      if (answer instanceof Error) throw answer;
      return { text: answer, usage: { prompt_tokens: 30, completion_tokens: 3 } };
    },
  };
  const lookup = {
    hasSearch: () => true,
    webCapLeft: () => 3,
    search: async (guildId, query) => {
      ran.web.push(query);
      return web;
    },
  };
  const recall = {
    available: () => recallOn,
    run: async (input) => {
      ran.server.push(input.server);
      return found;
    },
  };
  const out = await preTurnLookup({
    config,
    prompts: { lookup: 'LOOKUP {{name}} {{today}} {{skills}}', labels },
    llm,
    lookup,
    recall,
    discovery: { index: 'SKILLS-INDEX', names: ['rule.add'] },
    guild: {},
    guildId: GUILD,
    channel: fakeChannel(),
    selfId: SELF,
    selfName: 'Persona',
    history: [trigger],
    trigger,
    triggerKind: kind,
    at: NOW,
    store: { listUserProfiles: () => [] },
    deps: PRE_DEPS,
  });
  return { out, requests, ran };
}

test("preTurnLookup: the live classifier request; its web and server parts run and come back as the request's <lookup>; its skills: line is handed on", async () => {
  const { out, requests, ran } = await preTurn({ answer: 'web: τελικός 2026\nserver: τελικός\nskills: inventory' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.purpose, 'lookup');
  assert.ok(
    requests[0].messages[0].content.includes('SKILLS-INDEX') && requests[0].messages[0].content.includes('Persona')
  );
  assert.ok(requests[0].messages[1].content.includes('<candidate>\nÉlodie: Ποιος κέρδισε τον τελικό;'));
  assert.deepEqual(ran.web, ['τελικός 2026']);
  assert.equal(ran.server.length, 1);
  assert.deepEqual([out.lookup.text, out.lookup.server.text], ['Η Ana κέρδισε.', 'Είπε ναι.']);
  assert.equal(out.skills.inventory, true);
  assert.equal(out.recallAvailable, true);
  assert.deepEqual(
    [out.trace.asked, out.trace.webRan, out.trace.webFound, out.trace.serverRan, out.trace.serverFound],
    [true, true, true, true, true]
  );
});

test('preTurnLookup: none runs nothing; a failed classifier on a direct call falls back to the server search only; with no side able to run it is not asked', async () => {
  const none = await preTurn({ answer: 'none' });
  assert.equal(none.out.lookup, null);
  assert.deepEqual([none.ran.web.length, none.ran.server.length], [0, 0]);
  const failed = await preTurn({ answer: new Error('boom'), features: {} });
  const fallbackOn = recallSettings(toolConfig({ features: { recall: true } }))?.fallbackOnClassifierFailure === true;
  assert.equal(failed.out.trace.fallback, fallbackOn);
  assert.equal(failed.ran.web.length, 0, 'never the web side');
  const closed = await preTurn({ answer: 'web: x', recallOn: false, features: { webLookup: false } });
  assert.deepEqual([closed.requests.length, closed.out.trace.asked, closed.out.lookup], [0, false, null]);
});

test('features.coreTools off: <lookup> and the recall senses line reach her request; on: the tool lines; requestBlocks names what each request held', async () => {
  const config = toolConfig({ features: { coreTools: false, recall: true } });
  const hot = {
    config,
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      format: 'FORMAT',
      reply: 'REPLY {{author}}',
      labels,
    },
  };
  const store = {
    getGuild: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    state: { data: {} },
  };
  const view = liveView({ hot, store, guildId: 'g1' });
  const here = { id: HERE, name: 'γενικά' };
  const trigger = scenarioTrigger({
    text: 'Ποιος κέρδισε;',
    authorId: OWNER,
    authorName: 'Élodie',
    channel: here,
    selfId: SELF,
    at: NOW,
  });
  const situation = { history: [trigger], triggerId: trigger.id, kind: 'mention', mode: 'reply' };
  const llm = scriptedLlm([`${THINK}<msg>η Ana</msg>`]);
  const answered = await answerSkillScenario({
    view,
    situation,
    selfId: SELF,
    selfName: 'Persona',
    channel: here,
    llm,
    runs: 1,
    at: NOW,
    searchAvailable: true,
    preTurn: { lookup: { query: 'τελικός', text: 'Η Ana κέρδισε.', sources: [] }, recallAvailable: true },
  });
  const off = requestBlocks(answered.request.user, labels);
  assert.equal(off.lookup, true);
  assert.ok(answered.request.user.includes('Η Ana κέρδισε.'));
  assert.deepEqual([off.recallLine, off.tools, off.recallToolLine], [true, false, false]);
  const { llm: onLlm } = await loopRun([`${THINK}<msg>ok</msg>`], { tool: () => okTool('x') });
  const on = requestBlocks(userOf(onLlm.calls[0]), labels);
  assert.deepEqual([on.lookup, on.recallToolLine, on.recallLine], [false, true, false]);
});

// The automatic memory prefetch with features.coreTools on: what a live turn gets for the
// trigger, computed as of the moment and standing in every request of the loop.

test('createReplayTools.prefetch: the live lanes of the trigger, run as of the moment; none with features.coreTools off or a trivial trigger', async () => {
  const { prefetchLanes, prefetchOn } = await import('../src/behavior/prefetch.js');
  const runs = [];
  const createRecall = () => ({
    available: () => true,
    run: async () => ({}),
    prefetch: async (input) => (
      runs.push(input),
      { status: 'none', basis: input.lanes.map((lane) => lane.kind), excerpts: [] }
    ),
  });
  const store = { state: { data: {} }, listUserProfiles: () => [], getLore: () => [], getGuild: () => ({}) };
  const make = (config) =>
    createReplayTools({
      hot: { config, prompts: { labels } },
      store,
      guild: { id: GUILD },
      guildId: GUILD,
      channel: fakeChannel(),
      selfId: SELF,
      selfName: 'Persona',
      llm: scriptedLlm([]),
      createLookup: () => ({}),
      createRecall,
      runWebSearch,
      runMemorySearch,
      discord: {},
      reads: { conversationInfo: () => Promise.resolve(null), conversations: () => Promise.resolve(null) },
      prefetchLanes,
      prefetchOn,
      recallSettings,
    });
  const here = { id: HERE, name: 'γενικά' };
  const trigger = scenarioTrigger({
    text: 'θυμάσαι τη ζωγραφιά με το δάσος;',
    authorId: OWNER,
    authorName: 'Élodie',
    channel: here,
    selfId: SELF,
    at: NOW,
  });
  const on = make(toolConfig({ features: { coreTools: true, recall: true } }));
  const found = await on.prefetch({ trigger, triggerKind: 'mention', mode: 'reply', history: [trigger], at: NOW - 5 });
  assert.equal(found.status, 'none');
  assert.equal(runs.length, 1);
  assert.deepEqual(
    runs[0].lanes.map((lane) => [lane.kind, lane.text]),
    [['message', 'θυμάσαι τη ζωγραφιά με το δάσος;']]
  );
  assert.equal(runs[0].at, NOW - 5, 'as of the moment');
  assert.deepEqual(runs[0].history, [trigger]);
  assert.equal(
    await on.prefetch({ trigger: { ...trigger, content: 'ok' }, history: [trigger], at: NOW }),
    null,
    'a trivial trigger'
  );
  const off = make(toolConfig({ features: { coreTools: false, recall: true } }));
  assert.equal(await off.prefetch({ trigger, history: [trigger], at: NOW }), null);
  assert.equal(runs.length, 1);
});

test('the step engine with a prefetch: <retrieved> stands in every request, as live', async () => {
  const prefetch = {
    status: 'ok',
    basis: ['message'],
    excerpts: [
      {
        source: 'history',
        channelId: 'c2',
        channelName: 'κήπος',
        startTs: NOW - 86_400_000,
        id: 'r1',
        ids: ['r1'],
        hitIds: ['r1'],
        lines: '>> [09:00] Élodie: plus ultra',
      },
    ],
  };
  const { llm } = await loopRun(
    [toolAnswer(THINK, [call('web.search', { query: 'τελικός' })]), `${THINK}<msg>ok</msg>`],
    { tool: () => okTool('κάτι'), prefetch }
  );
  assert.equal(llm.calls.length, 2);
  for (const recorded of llm.calls) {
    const user = userOf(recorded);
    assert.ok(user.includes(`<retrieved>\n${labels.prefetch.header}`), user);
    assert.ok(user.includes('>> [09:00] Élodie: plus ultra'));
    assert.ok(user.indexOf('<retrieved>') < user.indexOf('<chat>'));
  }
  const { llm: bare } = await loopRun([`${THINK}<msg>ok</msg>`], { tool: () => okTool('κάτι') });
  assert.ok(!userOf(bare.calls[0]).includes('<retrieved>'), 'none handed in: no block');
});

// ---- --loop-triggers and --pair-transport over fakes ----

/** What runTriggerLoops needs, faked: one real-shaped trigger in a one-line chat, the tools answering ok, a model answering `answers`. */
async function triggerRun({ single, transport = null, answers, config = toolConfig() }) {
  const dataDir = tempDir('nep-loop-triggers-');
  const out = path.join(dataDir, 'out');
  const here = { id: HERE, name: 'γενικά' };
  const channel = fakeChannel();
  const trigger = scenarioTrigger({
    text: 'Ποιος κέρδισε τον τελικό;',
    authorId: OWNER,
    authorName: 'Élodie',
    channel: here,
    selfId: SELF,
    at: NOW,
  });
  const hot = {
    config,
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      format: 'FORMAT',
      reply: 'REPLY {{author}}',
      labels,
    },
  };
  const store = {
    getGuild: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    state: { data: {} },
  };
  const llm = scriptedLlm(answers);
  const tools = { run: async () => okTool('Η Ana κέρδισε.'), prefetch: async () => null, recallAvailable: () => true };
  const loopDeps = {
    toolsFor: () => tools,
    coreToolsOn,
    loopSettings,
    IN_TURN_TOOLS,
    transportOf,
    discoveryOf: () => ({ index: '', names: [] }),
    preTurnDeps: {},
  };
  const mods = {
    answerSkillScenario,
    simulateCall,
    callViewOf,
    requesterOf: requesterOfChannel(requesterOf),
    skillRegistry,
    createImageGen,
    createTaskStore,
    replayMedia: sandbox.replayMedia,
    momentMode: sandbox.momentMode,
    momentKind: sandbox.momentKind,
    isSpontaneous: sandbox.isSpontaneous,
    scenarioInventory: sandbox.scenarioInventory,
    situationHistory: sandbox.situationHistory,
  };
  const args = { transport, outDir: out, asOfMoment: false, snapshot: null, hideSelf: [], hideSelfAll: false };
  const result = await runTriggerLoops({
    single,
    args,
    root: dataDir,
    liveData: path.join(dataDir, 'live'),
    pairTriggers: [{ channelId: HERE, triggerId: trigger.id, turnId: null }],
    rng: () => 0.9,
    hot,
    store,
    guild: { id: GUILD },
    guildId: GUILD,
    self: { id: SELF, name: 'Persona' },
    llm,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => 1 },
    mediaCache: null,
    gifs: null,
    customEmoji: [],
    searchAvailable: true,
    channelDirectory: null,
    signal: undefined,
    budget: null,
    mods,
    loopDeps,
    viewMods: { liveView, momentView, momentCutoff, hiddenLater },
    momentOf: async () => ({ channel, history: [trigger], triggerLine: trigger, at: NOW }),
    journalOf: () => [],
    channelOf: (c) => ({ id: c.id, name: c.name ?? null, category: null, topic: null }),
    dataDir,
    log: { info() {}, warn() {} },
  });
  return { result, out, llm, trigger };
}

test("--loop-triggers: one side, runs.jsonl with the turn's steps and the chat, report.md; the transport follows --transport", async () => {
  const { result, out, llm, trigger } = await triggerRun({
    single: true,
    transport: 'text',
    answers: [
      textAnswer(`${THINK}<msg>ψάχνω</msg>`, [call('web.search', { query: 'τελικός' })]),
      `${THINK}<msg>η Ana</msg>`,
    ],
  });
  assert.equal(result.code, 0, JSON.stringify(result.result));
  assert.equal(result.result.triggers, 1);
  assert.equal('tools' in llm.calls[0].options, false, 'the text transport: no tools field');
  const lines = fs
    .readFileSync(path.join(out, 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.deepEqual(
    [
      line.triggerId,
      line.transport,
      line.mode,
      line.counts.steps,
      line.counts.calls,
      line.counts.held,
      line.counts.turnRequests,
    ],
    [trigger.id, 'text', 'reply', 2, 1, 1, 2]
  );
  assert.deepEqual(line.context, [{ author: 'Élodie', text: 'Ποιος κέρδισε τον τελικό;' }]);
  assert.deepEqual(line.loop.calls, [{ step: 0, skill: 'web.search', status: 'ok', code: null }]);
  assert.deepEqual(line.loop.final, ['η Ana']);
  assert.ok(line.tokens.prompt > 0 && line.blocks.tools === true);
  const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.ok(report.includes('# Loop triggers (text transport)') && report.includes('speech held (not posted):'));
});

test('--loop-triggers without --transport follows the config; a refused output folder and a failed moment are reported, not thrown', async () => {
  const { result, out } = await triggerRun({ single: true, answers: [`${THINK}<msg>ναι</msg>`] });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'runs.jsonl'), 'utf8').trim()).transport, 'native');
  await assert.rejects(
    runTriggerLoops({
      single: true,
      args: { outDir: path.dirname(out), transport: null },
      root: '/',
      liveData: '/live',
      pairTriggers: [],
      rng: () => 0,
      hot: { config: toolConfig() },
      store: { state: { data: {} } },
      mods: { skillRegistry },
      loopDeps: {},
    }),
    /not empty/
  );
});

test('--pair-transport: the native side as A, the text side as B, a blind sheet and a key with both runs', async () => {
  const { result, out, llm } = await triggerRun({
    single: false,
    answers: [
      toolAnswer(`${THINK}<msg>ψάχνω</msg>`, [call('web.search', { query: 'τελικός' })]),
      `${THINK}<msg>η Ana</msg>`,
      textAnswer(`${THINK}<msg>ψάχνω</msg>`, [call('web.search', { query: 'τελικός' })]),
      `${THINK}<msg>η Ana</msg>`,
    ],
  });
  assert.equal(result.code, 0, JSON.stringify(result.result));
  assert.equal(llm.calls.length, 4);
  assert.ok(Array.isArray(llm.calls[0].options.tools) && !('tools' in llm.calls[2].options), 'A is native, B is text');
  const key = JSON.parse(fs.readFileSync(path.join(out, 'key.json'), 'utf8'));
  const [pair] = Object.values(key.pairs);
  assert.equal(pair.first, 'B', 'rng 0.9 puts B first');
  assert.deepEqual([pair.runs.A.transport, pair.runs.B.transport], ['native', 'text']);
  assert.deepEqual([pair.answers.A.messages, pair.answers.B.messages], [['η Ana'], ['η Ana']]);
  assert.deepEqual(pair.runs.A.calls, [{ step: 0, skill: 'web.search', status: 'ok', code: null }]);
  assert.ok(pair.runs.B.blocks.tools && !pair.runs.A.blocks.tools);
  const sheet = fs.readFileSync(path.join(out, 'sheet.html'), 'utf8');
  assert.ok(sheet.includes('η Ana') && !sheet.includes('ψάχνω'), 'the held speech is not on the sheet');
});

test('createReplayTools: conversation.read runs the live reader over the REST history, its handles continuing the request numbering; no tool fails silently', async () => {
  const conversationLabels = {
    ...labels,
    tools: {
      ...labels.tools,
      tools: {
        ...labels.tools.tools,
        conversation: {
          source: 'from #{channel}',
          handles: 'numbered lines',
          none: 'no messages',
          cut: '({dropped} cut)',
          earlier: 'earlier: before=#{n}',
          later: 'later: after=#{n}',
        },
      },
    },
  };
  /**
   * @param {string} id
   * @param {number} minutes
   * @param {string} content
   */
  const line = (id, minutes, content) => ({
    id,
    channelId: HERE,
    authorId: '100000000000000007',
    authorName: 'Élodie',
    self: false,
    bot: false,
    content,
    ts: NOW - minutes * 60000,
    replyToId: null,
    mentionedUserIds: [],
    mentionedChannelIds: [],
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  });
  // The conversation's history is held by the fake interface; the reads it answers are what the tool asked for.
  world().channel({ id: HERE, name: 'γενικά', guildId: GUILD });
  for (const entry of [line('m1', 3, 'πρώτο'), line('m2', 2, 'δεύτερο')])
    world().port.seedEvent({
      kind: 'message.received',
      iface: 'fake',
      at: entry.ts,
      id: `fake:message:${entry.id}`,
      conversation: { id: HERE, kind: 'channel', communityId: GUILD, name: 'γενικά' },
      message: {
        id: entry.id,
        author: { id: entry.authorId, name: entry.authorName, self: false, bot: false },
        content: entry.content,
        sourceText: entry.content,
        system: false,
        at: entry.ts,
        replyToId: null,
        replyPingUserId: null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions: [],
      },
      addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] },
    });
  const discord = { checkPull: () => ({ skip: null }) };
  const store = { state: { data: {} }, listUserProfiles: () => [], getLore: () => [], getGuild: () => ({}) };
  const warnings = [];
  const channel = fakeChannel();
  const config = toolConfig({ features: { recall: true } });
  const tools = createReplayTools({
    hot: { config, prompts: { labels: conversationLabels } },
    store,
    guild: channel.guild,
    guildId: GUILD,
    channel,
    selfId: SELF,
    selfName: 'Persona',
    llm: scriptedLlm([]),
    createLookup: () => ({}),
    createRecall: () => ({}),
    runWebSearch,
    runMemorySearch,
    discord,
    reads: world().reads,
    iface: world().port.iface,
    recallSettings,
    conversation: { runConversationRead, fetchSpan, recordMessages, searchHandles, pullPictures },
    log: { warn: (...a) => warnings.push(a) },
  });
  const idByIndex = new Map([
    [1, 'a'],
    [7, 'b'],
  ]);
  const read = await tools.run('conversation.read', { last: 30 }, { history: [], at: NOW, idByIndex });
  assert.equal(read.result.status, 'ok', JSON.stringify(read.result));
  assert.deepEqual(
    world()
      .port.calls.filter((call) => call.op === 'history')
      .map((call) => call.args),
    [[{ iface: 'fake', conversationId: HERE }, { limit: 30 }]]
  );
  assert.ok(
    read.result.data.text.includes('πρώτο') && read.result.data.text.includes('δεύτερο'),
    read.result.data.text
  );
  assert.ok(
    read.result.data.text.includes('#28'),
    "handles start past the request's highest line (7) and the gap: " + read.result.data.text
  );
  const refused = await tools.run('web.fetch-nothing', {}, {});
  assert.deepEqual(
    refused.result,
    { status: 'not_configured', code: 'not-configured', reason: 'replay-no-tool' },
    'an unimplemented tool is refused explicitly, not a bare error'
  );
  assert.equal(warnings.length, 1, 'a skill no tool runs is logged');
});

test('createReplayTools: media.look looks again through the describer over the metered client, the message found in the request history; the per-turn cap holds; media.find answers from the store', async () => {
  const store = {
    state: { data: {} },
    listUserProfiles: () => [],
    getLore: () => [],
    getGuild: () => ({}),
    getGifs: () => [],
  };
  const vision = {
    complete: async () => ({
      text: 'ένα κόκκινο ποδήλατο',
      usage: { prompt_tokens: 90, completion_tokens: 5, cost: 0.001 },
    }),
  };
  const created = [];
  const createDescriber = ({ llm: client, store: cache }) => {
    created.push(cache.getMediaCache());
    return {
      relookImage: async (guildId, item, question) => (
        await client.complete([], {}),
        { question, text: 'ένα κόκκινο ποδήλατο' }
      ),
    };
  };
  const config = toolConfig({ features: { vision: true, mediaDescriptions: true, imageRelook: true } });
  const hot = { config: { ...config, media: { ...config.media, look: { maxPerTurn: 1 } } }, prompts: { labels } };
  const tools = createReplayTools({
    hot,
    store,
    guild: { id: GUILD },
    guildId: GUILD,
    channel: fakeChannel(),
    selfId: SELF,
    selfName: 'Persona',
    llm: vision,
    createLookup: () => ({}),
    createRecall: () => ({}),
    runWebSearch,
    runMemorySearch,
    discord: {},
    mediaCache: { kept: 1 },
    mediaTools: { createDescriber, runMediaLook, runMediaFind, lookPerTurn },
  });
  const history = [
    {
      id: 'm9',
      content: 'δες',
      attachments: [{ id: 'pa', kind: 'image', url: 'https://cdn.example.com/a.png', name: 'a.png' }],
      links: [],
      stickers: [],
      embeds: [],
    },
  ];
  const first = await tools.run('media.look', { message: 'm9', question: 'τι κρατά;' }, { history });
  assert.equal(first.result.status, 'ok', JSON.stringify(first.result));
  assert.ok(first.result.data.text.includes('ένα κόκκινο ποδήλατο'), first.result.data.text);
  assert.deepEqual(first.usage, { requests: 1, tokens: { prompt: 90, completion: 5 }, cost: 0.001 });
  assert.deepEqual(created[0], { kept: 1 }, 'the describer reads the private cache copy');
  const gone = await tools.run('media.look', { message: 'm404', question: 'τι;' }, { history });
  assert.equal(gone.result.status, 'invalid');
  const second = await tools.run('media.look', { message: 'm9', question: 'και τώρα;' }, { history });
  assert.deepEqual([second.result.status, second.result.code], ['failed', 'turn-cap']);
  const find = await tools.run('media.find', { query: 'χορός' }, { history });
  assert.equal(find.result.status, 'ok', JSON.stringify(find.result));
});

test('createReplayTools: media.look with a url looks at the video link through the same describer, no history needed', async () => {
  const store = {
    state: { data: {} },
    listUserProfiles: () => [],
    getLore: () => [],
    getGuild: () => ({}),
    getGifs: () => [],
  };
  const vision = {
    complete: async () => ({ text: 'x', usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }),
  };
  const seen = [];
  const createDescriber = ({ llm: client }) => ({
    rewatchVideo: async (guildId, item, question) => (
      seen.push(item),
      await client.complete([], {}),
      { question, text: 'ένα τραγούδι' }
    ),
  });
  const config = toolConfig({ features: { vision: true, mediaDescriptions: true, videoDescriptions: true } });
  const hot = {
    config: {
      ...config,
      media: { ...config.media, video: { ...config.media?.video, sites: ['youtube.com'] }, look: { maxPerTurn: 1 } },
    },
    prompts: { labels },
  };
  const tools = createReplayTools({
    hot,
    store,
    guild: { id: GUILD },
    guildId: GUILD,
    channel: fakeChannel(),
    selfId: SELF,
    selfName: 'Persona',
    llm: vision,
    createLookup: () => ({}),
    createRecall: () => ({}),
    runWebSearch,
    runMemorySearch,
    discord: {},
    mediaCache: {},
    mediaTools: { createDescriber, runMediaLook, runMediaFind, lookPerTurn },
  });
  const url = 'https://www.youtube.com/watch?v=abc123';
  const first = await tools.run('media.look', { url, question: 'τι ακούγεται;' }, { history: [] });
  assert.equal(first.result.status, 'ok', JSON.stringify(first.result));
  assert.ok(first.result.data.text.includes('ένα τραγούδι'));
  assert.deepEqual([seen[0].source, seen[0].url, seen[0].messageId], ['link', url, null]);
  assert.equal(first.usage.requests, 1);
  const second = await tools.run('media.look', { url, question: 'και τώρα;' }, { history: [] });
  assert.deepEqual([second.result.status, second.result.code], ['failed', 'turn-cap']);
});

test('loopCall: a tool that throws logs one warning with its message', async () => {
  const warnings = [];
  const broken = loopCall({
    simulate: () => ({
      verdict: { stage: 'gateway', ok: true },
      executed: { skill: 'conversation.read', args: {} },
      result: { skill: 'conversation.read', status: 'ok' },
    }),
    runTool: () => {
      throw new Error('boom');
    },
    inTurn: IN_TURN_TOOLS,
    log: { warn: (...a) => warnings.push(a) },
  });
  assert.equal((await broken({ skill: 'conversation.read' }, {})).result.code, 'error');
  assert.deepEqual(warnings, [['replay: in-turn tool threw', { skill: 'conversation.read', error: 'boom' }]]);
});
