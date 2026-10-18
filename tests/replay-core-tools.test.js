// Tests for the tool loop of tools/replay.mjs (`--skills` with features.coreTools or
// `--core-tools`, and `--pair-core-tools`): a scenario run answered as a live turn with the
// switch on answers it -- every call of each answer through the real gateway, her in-turn tools
// run (here by fakes), a task.run only recorded, the turn continued step after step within the
// loop's bounds -- and what runs.jsonl, the report and the pair sheet make of it. Fakes only: no
// network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';
import { coreToolRows } from '../src/skills/discovery.js';
import { IN_TURN_TOOLS, runMemorySearch, runWebSearch } from '../src/skills/tools.js';
import { needsFollowUp } from '../src/skills/executors.js';
import { callViewOf, loopSettings, requesterOf } from '../src/behavior/turn.js';
import { fill } from '../src/format.js';
import { afterScenarioTurn, answerSkillScenario, liveView, personaGrantsConfig, simulateCall } from '../src/behavior/sandbox.js';
import {
  createReplayTools, loopCall, loopRecord, loopRequestEstimate, pairAnswerOf, parseArgs, parseScenarios, renderSkillsReport, runRecord, scenarioSummary,
  scenarioTrigger, skillRequestEstimate, withCoreTools,
} from '../tools/replay.mjs';
import { labels } from './fixtures/labels.js';

const OWNER = '100000000000000042';
const SELF = '100000000000000001';
const HERE = '200000000000000001';
const GUILD = '300000000000000001';
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const TOOLS = ['web.search', 'memory.search', 'task.run'];

/** The config of a scenario with her tools granted and the switch on; `loop` its bounds. */
function toolConfig({ loop = { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 }, features = {} } = {}) {
  return personaGrantsConfig(withCoreTools({
    bot: { owners: [OWNER], timezone: 'UTC', access: {} },
    context: {
      channelMessages: 100, maxMessageChars: 800, gapMarkerMinutes: 20, otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    models: { base: { voice: 'x/chat' } },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
    skills: { safeMode: false, loop },
    features: { skills: true, followUpContinuation: true, webLookup: true, ...features },
  }), SELF, TOOLS);
}

/** A discord.js-like channel γενικά in a guild, nobody's roles cached. */
function fakeChannel() {
  return {
    id: HERE,
    name: 'γενικά',
    guild: { id: GUILD, channels: { cache: new Map([[HERE, { id: HERE, name: 'γενικά', type: 0 }]]) }, roles: { cache: new Map() }, members: { cache: new Map() } },
  };
}

/** A model that answers `texts` in order (each with a reported cost) and keeps every request. */
function scriptedLlm(texts) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      return { text: texts[calls.length - 1] ?? '<skip/>', usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } };
    },
  };
}

/** The user text of one recorded request. */
function userOf(call) {
  const content = call.messages[1].content;
  return typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('');
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
async function loopRun(answers, { tool, config = toolConfig(), clock = tickingClock(), followUpContinuation = true } = {}) {
  const cfg = followUpContinuation ? config : { ...config, features: { ...config.features, followUpContinuation: false } };
  const hot = { config: cfg, prompts: { 'system-prompt': 'SYSTEM', 'character-card': 'CARD', format: 'FORMAT', reply: 'REPLY {{author}}', labels } };
  const store = { getGuild: () => ({}), getUser: () => null, listChannels: () => [], listUserProfiles: () => [], getLore: () => [], state: { data: {} } };
  const view = liveView({ hot, store, guildId: 'g1' });
  const channel = fakeChannel();
  const here = { id: HERE, name: 'γενικά' };
  const trigger = scenarioTrigger({ text: 'Ποιος κέρδισε τον τελικό;', authorId: OWNER, authorName: 'Élodie', channel: here, selfId: SELF, at: NOW });
  const situation = { history: [trigger], triggerId: trigger.id, kind: 'mention', mode: 'reply' };
  const registry = skillRegistry();
  const requester = requesterOf(trigger, channel);
  const tasks = { budget: () => ({ spent: false, key: null, code: null }) };
  const toolCalls = [];
  const simulate = (call, { idByIndex, history: lines, channelHandles = null }) =>
    simulateCall({
      call,
      view: callViewOf({ channel, guildId: GUILD, idByIndex, lines, pulledIds: new Map(), memoryOn: false, store: null, selfId: SELF, skills: registry, channelHandles }),
      config: cfg, selfId: SELF, requester, conversationId: HERE, now: NOW, tasks, resultText: 'queued',
    });
  const onCall = loopCall({
    simulate,
    runTool: async (skill, args, refs) => {
      toolCalls.push({ skill, args, timeoutMs: refs.timeoutMs });
      return tool(skill, args);
    },
    inTurn: IN_TURN_TOOLS,
    needsFollowUp,
    now: clock,
  });
  const llm = scriptedLlm(answers);
  const coreTools = { rows: coreToolRows({ config: cfg, selfId: SELF, registry }), recallAvailable: true };
  const answered = await answerSkillScenario({
    view, situation, selfId: SELF, selfName: 'Persona', channel: here, llm, runs: 1, at: NOW, skillsGranted: TOOLS, searchAvailable: true,
    onCall, coreTools, loop: { settings: loopSettings(cfg), now: clock },
  });
  return { answered, run: answered.runs[0], llm, toolCalls, trigger, here };
}

/** A tool answering ok with `text`, its own request costing `cost`. */
const okTool = (text, cost = 0.002) => ({ result: { status: 'ok', data: { text } }, usage: { requests: 1, tokens: { prompt: 50, completion: 5 }, cost } });

test('replay --core-tools: the flag goes with --skills only; --pair-core-tools takes the pair triggers and no prompt directories', () => {
  assert.equal(parseArgs(['--skills', 'a.json', '--core-tools']).coreTools, true);
  assert.equal(parseArgs(['--skills', 'a.json']).coreTools, false);
  assert.throws(() => parseArgs(['123456789012345678', '223456789012345678', '--core-tools']), /usage/);
  assert.throws(() => parseArgs(['--diary-day', '--core-tools']), /usage/);
  const pair = parseArgs(['--pair-core-tools', '--triggers', 't.txt', '--as-of-moment', '--snapshot', 'snap', '--out', 'o', '--spend', '3']);
  assert.deepEqual([pair.pairCoreTools, pair.pair, pair.triggers, pair.asOfMoment, pair.snapshot, pair.outDir], [true, null, 't.txt', true, 'snap', 'o']);
  const one = parseArgs(['--pair-core-tools', '123456789012345678', '223456789012345678']);
  assert.deepEqual([one.channelId, one.triggerId], ['123456789012345678', '223456789012345678']);
  assert.throws(() => parseArgs(['--pair-core-tools', '--pair', 'a', 'b', '--triggers', 't.txt']), /usage/);
  assert.throws(() => parseArgs(['--pair-core-tools']), /usage/);
  assert.throws(() => parseArgs(['--skills', 'a.json', '--pair-core-tools']), /usage/);
  assert.throws(() => parseArgs(['--pair-core-tools', '--triggers', 't.txt', '--split']), /usage/);
});

test('loopRequestEstimate: her reply, every follow-up and a request per call that may run; the per-decision count of skillRequestEstimate', () => {
  assert.equal(loopRequestEstimate({ maxSteps: 3, maxCallsPerStep: 4 }), 1 + 3 + 12);
  const scenarios = parseScenarios(JSON.stringify([{ id: 'a', channelId: HERE, author: OWNER, text: 'Γεια', grants: [], runs: 2 }]));
  assert.equal(skillRequestEstimate(scenarios), 4);
  assert.equal(skillRequestEstimate(scenarios, { perDecision: 16 }), 32);
});

test('the tool loop: her calls run step after step, the results appended in call order; a task.run is only recorded; the record keeps every step', async () => {
  const { run, llm, toolCalls } = await loopRun(
    [
      '<msg>μισό λεπτό</msg><call skill="web.search" goal="ποιος κέρδισε">τελικός 2026</call><call skill="memory.search">τι είπαμε για τον τελικό</call>',
      '<call skill="task.run" agent="web">Βρες τον πλήρη πίνακα του τελικού 2026 και επέστρεψε τα ονόματα</call>',
      '<msg>η Ana κέρδισε</msg>',
    ],
    { tool: (skill) => (skill === 'web.search' ? okTool('Η Ana κέρδισε.') : okTool('Élodie: το είδα', 0)) },
  );
  // Both reads ran with her resolved arguments, within the loop's time.
  assert.deepEqual(toolCalls.map((c) => c.skill).sort(), ['memory.search', 'web.search']);
  assert.equal(toolCalls.find((c) => c.skill === 'web.search').args.query, 'τελικός 2026');
  assert.ok(toolCalls.every((c) => c.timeoutMs >= 2000 && c.timeoutMs <= 20000));
  assert.equal(llm.calls.length, 2, 'an accepted task.run is its own answer: no request after it');
  const second = userOf(llm.calls[1]);
  const webAt = second.indexOf('Η Ana κέρδισε.');
  const memoryAt = second.indexOf('Élodie: το είδα');
  assert.ok(webAt > 0 && memoryAt > webAt, 'each result in its own block, in the order she called');
  assert.ok(second.includes(fill(labels.task.continueTools, { skill: 'web.search, memory.search' })));
  // runs.jsonl's line.
  const record = runRecord('s', 0, run);
  assert.deepEqual([record.decision, record.skill], ['call', 'web.search'], 'the single-call fields keep the first call');
  assert.equal(record.loop.steps.length, 2);
  assert.deepEqual(record.loop.calls.map((c) => [c.step, c.skill, c.status]), [[0, 'web.search', 'ok'], [0, 'memory.search', 'ok'], [1, 'task.run', 'ok']]);
  assert.deepEqual(record.loop.errands, [{ step: 1, agent: 'web', goal: 'Βρες τον πλήρη πίνακα του τελικού 2026 και επέστρεψε τα ονόματα' }]);
  const [reply, after] = record.loop.steps;
  assert.equal(reply.resultChars, 'Η Ana κέρδισε.'.length + 'Élodie: το είδα'.length);
  assert.deepEqual(reply.answer.messages, ['μισό λεπτό']);
  assert.ok(reply.requestChars > 0 && after.requestChars > reply.requestChars, 'the continued request holds the results');
  assert.ok(Number.isFinite(reply.ms) && Number.isFinite(after.ms) && Number.isFinite(record.loop.ms));
  assert.equal(reply.calls.find((c) => c.skill === 'web.search').tool.requests, 1);
  assert.deepEqual(record.loop.messages, ['μισό λεπτό']);
  assert.deepEqual(record.loop.final, [], 'the errand step said nothing');
  // Her two requests and the tools' own: tokens and cost together.
  assert.deepEqual(record.tokens, { prompt: 300, completion: 30 });
  assert.ok(Math.abs(record.cost - 0.022) < 1e-9);
  assert.equal(scenarioSummary([record]).followUps, 1);
  // The report: the calls in order, the final messages, the turn's time and cost, the errand recorded.
  const report = renderSkillsReport([{ scenario: { id: 's', text: 'x', discovery: 'inventory' }, grantNames: TOOLS, summary: scenarioSummary([record]), records: [record] }]);
  assert.ok(report.includes('calls in order: 0:web.search ok; 0:memory.search ok; 1:task.run ok'));
  assert.ok(report.includes('errand recorded (step 1, not dispatched): web: Βρες τον πλήρη'));
  assert.ok(report.includes('cost: 0.0220'));
});

test('the tool loop: <skills_tools> and the server search line are in every request; no <skills> list', async () => {
  const { llm } = await loopRun(['<call skill="web.search">τελικός</call>', '<msg>ok</msg>'], { tool: () => okTool('κάτι') });
  for (const call of llm.calls) {
    const user = userOf(call);
    assert.ok(user.includes('<skills_tools>'), 'her tools in full');
    assert.ok(user.includes(labels.senses.recallTool), 'the server search line says she calls it');
    assert.ok(!user.includes('<skills>\n'), 'no classifier names her skills');
  }
});

test('the tool loop: at maxSteps the last request says no call runs, and a call there is dropped as the loop cap', async () => {
  const { run, llm } = await loopRun(
    ['<call skill="web.search">α</call>', '<call skill="web.search">β</call>', '<msg>τέλος</msg><call skill="web.search">γ</call>'],
    { tool: (skill, args) => okTool(`αποτέλεσμα ${args.query}`), config: toolConfig({ loop: { maxSteps: 2, timeBudgetMs: 20000, maxCallsPerStep: 4 } }) },
  );
  assert.equal(llm.calls.length, 3);
  assert.ok(userOf(llm.calls[1]).includes(fill(labels.task.continueTools, { skill: 'web.search' })));
  const last = userOf(llm.calls[2]);
  assert.ok(last.includes(fill(labels.task.continueToolsLast, { skill: 'web.search' })));
  assert.ok(last.indexOf('αποτέλεσμα α') < last.indexOf('αποτέλεσμα β'), 'a later step only appends');
  const record = runRecord('s', 0, run);
  assert.deepEqual([record.loop.steps[2].dropped, record.loop.steps[2].capped], [1, 'steps']);
  assert.deepEqual(record.loop.final, ['τέλος']);
});

test('the tool loop: once the time budget is spent the next request is her last; past maxCallsPerStep calls are dropped', async () => {
  const { run, llm } = await loopRun(
    ['<call skill="web.search">α</call><call skill="web.search">β</call><call skill="web.search">γ</call>', '<call skill="web.search">δ</call>'],
    { tool: () => okTool('x'), clock: tickingClock(1000), config: toolConfig({ loop: { maxSteps: 3, timeBudgetMs: 1500, maxCallsPerStep: 2 } }) },
  );
  const record = runRecord('s', 0, run);
  assert.equal(record.loop.steps[0].calls.length, 2);
  assert.equal(record.loop.steps[0].dropped, 1, 'one of three dropped');
  assert.equal(record.extraCalls, 1);
  assert.ok(userOf(llm.calls[1]).includes(fill(labels.task.continueToolsLast, { skill: 'web.search' })));
  assert.equal(record.loop.steps[1].capped, 'time');
});

test('the tool loop without the continuation: the reply request again with the results, always her last', async () => {
  const { run, llm } = await loopRun(['<call skill="web.search">α</call>', '<call skill="web.search">β</call>'], { tool: () => okTool('βρέθηκε'), followUpContinuation: false });
  assert.equal(llm.calls.length, 2);
  assert.ok(userOf(llm.calls[1]).includes('βρέθηκε'));
  assert.equal(runRecord('s', 0, run).loop.steps[1].capped, 'no-continuation');
});

test('loopCall: a tool past its time answers the live timeout; one that throws fails; a refused call never runs; a task.run is recorded only', async () => {
  const outcome = (skill, args = {}) => ({ verdict: { stage: 'gateway', ok: true }, executed: { skill, args }, result: { skill, status: 'ok', data: { text: 'canned' } }, followUp: true });
  let ran = 0;
  const slow = loopCall({ simulate: () => outcome('web.search', { query: 'α' }), runTool: () => new Promise(() => {}), inTurn: IN_TURN_TOOLS, needsFollowUp });
  const late = await slow({ skill: 'web.search' }, { timeoutMs: 5 });
  assert.deepEqual([late.result.status, late.result.code, late.followUp], ['unknown', 'timeout', true]);
  const broken = loopCall({ simulate: () => outcome('memory.search'), runTool: () => { throw new Error('boom'); }, inTurn: IN_TURN_TOOLS, needsFollowUp });
  assert.deepEqual(((await broken({ skill: 'memory.search' }, {})).result), { status: 'failed', code: 'error', skill: 'memory.search' });
  const refusal = { verdict: { stage: 'gateway', ok: false, code: 'not-allowed' }, executed: null, result: { skill: 'web.search', status: 'denied' }, followUp: true };
  const refused = loopCall({ simulate: () => refusal, runTool: () => { ran += 1; }, inTurn: IN_TURN_TOOLS, needsFollowUp });
  assert.equal(await refused({ skill: 'web.search' }, {}), refusal);
  const errand = loopCall({ simulate: () => outcome('task.run', { agent: 'web' }), runTool: () => { ran += 1; }, inTurn: IN_TURN_TOOLS, needsFollowUp });
  const recorded = await errand({ skill: 'task.run', args: { agent: 'web' }, body: 'Βρες το πρόγραμμα' }, {});
  assert.deepEqual(recorded.errand, { agent: 'web', goal: 'Βρες το πρόγραμμα' });
  assert.equal(recorded.result.data.text, 'canned');
  assert.equal(ran, 0);
});

test('createReplayTools: web.search through the lookup and memory.search through the recall runner, metered; the store and its counters untouched', async () => {
  const data = Object.freeze({ webDay: '2026-10-18', webCount: 1, recallDay: '2026-10-18', recallCount: 2 });
  const store = { state: { data }, listUserProfiles: () => [], getLore: () => [], getGuild: () => ({}), getRecent: () => null };
  const seen = {};
  const llm = { complete: async () => ({ text: 'σύνοψη', usage: { prompt_tokens: 40, completion_tokens: 4, cost: 0.003 } }) };
  const createLookup = ({ llm: client, state, store: cache }) => {
    seen.webState = state;
    cache.getMediaCache().touched = true;
    return { hasSearch: () => true, webCapLeft: () => 5, search: async (guildId, query) => { await client.complete([], {}); return { query, text: 'Η Ana κέρδισε.', sources: [] }; } };
  };
  const createRecall = ({ store: recallStore }) => {
    seen.recallState = recallStore.state;
    return { available: () => true, run: async (input) => { seen.run = input; return { quotes: [{ channelName: 'γενικά', startTs: NOW, lines: 'Élodie: ναι' }] }; } };
  };
  const config = toolConfig({ features: { recall: true } });
  const hot = { config, prompts: { labels } };
  const mediaCache = { kept: 1 };
  const tools = createReplayTools({ hot, store, guild: { id: GUILD }, guildId: GUILD, channel: fakeChannel(), selfId: SELF, selfName: 'Persona', llm, createLookup, createRecall, runWebSearch, runMemorySearch, discord: {}, mediaCache });
  assert.equal(tools.recallAvailable(), true);
  const web = await tools.run('web.search', { query: 'τελικός' }, { history: [] });
  assert.equal(web.result.status, 'ok');
  assert.ok(web.result.data.text.includes('Η Ana κέρδισε.'));
  assert.deepEqual(web.usage, { requests: 1, tokens: { prompt: 40, completion: 4 }, cost: 0.003 });
  const memory = await tools.run('memory.search', { question: 'τι είπε η Élodie' }, { history: [{ id: 'h1' }], at: NOW });
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

test('afterScenarioTurn: a loop run carries every step\'s messages and every call\'s mark into the next step', async () => {
  const { run, trigger, here } = await loopRun(['<msg>ψάχνω</msg><call skill="web.search">α</call>', '<msg>βρήκα</msg>'], { tool: () => okTool('x') });
  const carried = afterScenarioTurn({ transcript: [trigger], run, at: NOW, selfId: SELF, selfName: 'Persona', channel: here, triggerId: trigger.id, config: toolConfig() });
  const mine = carried.transcript.filter((line) => line.authorId === SELF).map((line) => line.content);
  assert.deepEqual(mine, ['ψάχνω', 'βρήκα']);
  assert.deepEqual(carried.callMarks.map((mark) => [mark.skill, mark.status]), [['web.search', 'ok']]);
});

test('pairAnswerOf: the sheet shows every message of a side\'s turn; the key keeps its calls', () => {
  const answer = (text) => ({ messages: [{ text, replyTo: null }], reactions: [], gif: null, draw: null, skip: false, think: 'σκέψη' });
  const off = runRecord('p1', 0, {
    answer: answer('πρώτο'), call: { skill: 'lore.list', args: {}, body: '' }, callError: null, extraCalls: 0, usage: null,
    outcome: { verdict: { stage: 'gateway', ok: true }, executed: null, result: { skill: 'lore.list', status: 'ok' }, followUp: true },
    followUp: { answer: answer('δεύτερο'), extraCall: false, usage: null },
  });
  assert.deepEqual(pairAnswerOf(off), { think: 'σκέψη', messages: ['πρώτο', 'δεύτερο'], reactions: [], gif: null, draw: null, skip: false, calls: [{ step: 0, skill: 'lore.list', status: 'ok', code: null }] });
  const on = { ...off, loop: loopRecord({ ms: 30, steps: [{ step: 0, answer: answer('α'), calls: [], dropped: 0 }, { step: 1, answer: answer('β'), calls: [] }] }) };
  assert.deepEqual(pairAnswerOf(on).messages, ['α', 'β']);
  const silent = runRecord('p2', 0, { answer: { messages: [], reactions: [], gif: null, draw: null, skip: true, think: '' }, call: null, callError: null, extraCalls: 0, usage: null, outcome: null, followUp: null });
  assert.equal(pairAnswerOf(silent).skip, true);
  assert.equal(pairAnswerOf(null), null);
});
