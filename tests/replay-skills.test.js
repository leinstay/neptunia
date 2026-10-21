// Tests for the skill scenarios of tools/replay.mjs (`--skills`): the scenario loader, the
// persona's grants laid over a copy of the config, and her `<call>` taken through the real
// resolution and the real gateway with the operation never run
// (src/behavior/sandbox.js#simulateCall), and multi-step scenarios played step by step with her
// turns carried into the next step (playSteps, afterScenarioTurn), a burst played as the live
// queue plays it (burstTurns), and the prompt layers of `--prompts` / `--pair-prompts` with
// their side-by-side report, all against fakes: no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import '../src/ops/index.js';
import { expandPersonaGrant } from '../src/ops/access.js';
import { skillRegistry } from '../src/skills/registry.js';
import { FEATURE_SKILLS, NOT_GRANTABLE_TO_PERSONA } from '../src/skills/access.js';
import { callViewOf, requesterOf } from '../src/behavior/turn.js';
import { fill } from '../src/format.js';
import { createHot } from '../src/hot.js';
import { deepMerge } from '../src/config.js';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.js';
import { afterScenarioTurn, answerSkillScenario, burstTurns, liveView, personaGrantsConfig, scenarioInventory, seededSelfLine, simulateCall } from '../src/behavior/sandbox.js';
import {
  firstDecision, overlayPromptsHot, parseArgs, parseScenarios, playSteps, renderPairReport, renderSkillsReport, runRecord, scenarioDiscovery, scenarioGrants, scenarioSummary, scenarioTrigger,
  sequenceSummary, skillRequestEstimate,
} from '../tools/replay.mjs';
import { labels } from './fixtures/labels.js';
import { tempDir } from './fixtures/tmp.js';

const OWNER = '100000000000000042';
const MEMBER = '100000000000000007';
const SELF = '100000000000000001';
const HERE = '200000000000000001';
const NEWS = '200000000000000002';
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** A scenario as the file holds it, with `overrides`. */
function raw(overrides = {}) {
  return { id: 's-1', channelId: HERE, author: MEMBER, text: 'Μπορείς να προσθέσεις έναν κανόνα;', grants: [], ...overrides };
}

/** parseScenarios over a JSON array of `items`. */
function load(items) {
  return parseScenarios(JSON.stringify(items));
}

test('parseScenarios: the example file loads; omitted fields take their defaults', () => {
  const example = parseScenarios(fs.readFileSync(new URL('../tools/prompts/skill-scenarios.example.json', import.meta.url), 'utf8'));
  assert.ok(example.length >= 3);
  for (const scenario of example) assert.ok(/^[A-Za-z0-9._-]+$/.test(scenario.id));
  const [scenario] = load([raw()]);
  assert.deepEqual(scenario, { id: 's-1', channelId: HERE, before: null, author: MEMBER, text: 'Μπορείς να προσθέσεις έναν κανόνα;', grants: [], runs: 1, result: '', discovery: 'inventory' });
  const [full] = load([raw({ before: '300000000000000001', grants: [' rule.add ', '*'], runs: 3, result: 'Règle ajoutée', discovery: ['rule.add'] })]);
  assert.deepEqual([full.before, full.grants, full.runs, full.result, full.discovery], ['300000000000000001', ['rule.add', '*'], 3, 'Règle ajoutée', ['rule.add']]);
});

test('parseScenarios: a malformed file or scenario is refused, naming the scenario', () => {
  assert.throws(() => parseScenarios('{'), /not JSON/);
  assert.throws(() => parseScenarios('[]'), /non-empty JSON array/);
  assert.throws(() => parseScenarios('{"id":"a"}'), /non-empty JSON array/);
  const refused = [
    [{ ...raw(), extra: 1 }, /unknown field extra/],
    [raw({ id: 'ένα' }), /id must be/],
    [raw({ channelId: '12' }), /channelId/],
    [raw({ before: 'x' }), /before/],
    [raw({ author: '' }), /author/],
    [raw({ text: '   ' }), /text/],
    [raw({ grants: 'rule.add' }), /grants/],
    [raw({ grants: [''] }), /grants/],
    [raw({ runs: 0 }), /runs/],
    [raw({ runs: 11 }), /runs/],
    [raw({ runs: 1.5 }), /runs/],
    [raw({ result: 3 }), /result/],
    [raw({ discovery: 'all' }), /discovery/],
    [raw({ discovery: ['a', 'b', 'c', 'd', 'e'] }), /discovery/],
    [raw({ discovery: [] }), /discovery/],
  ];
  for (const [scenario, message] of refused) assert.throws(() => load([scenario]), message);
  assert.throws(() => load([raw(), raw()]), /scenario 2 \(s-1\): the id is used twice/);
});

test('scenarioGrants: expanded as /nep access grant expands them for her; a not-grantable name kept; an unknown one refused', () => {
  const names = scenarioGrants({ id: 's', grants: ['rule.add', '*', 'memory.wipe', 'rule.add'] }, expandPersonaGrant);
  assert.equal(names[0], 'rule.add');
  assert.equal(names.filter((name) => name === 'rule.add').length, 1, 'de-duplicated');
  assert.ok(names.includes('rule.list'), '`*` is her read skills');
  assert.ok(!names.includes('rule.remove'), '`*` opens no write');
  assert.ok(names.includes('memory.wipe'), 'kept, so the gateway refuses it as live');
  assert.throws(() => scenarioGrants({ id: 's', grants: ['files.wipe'] }, expandPersonaGrant), /scenario s: grants names no skill: files.wipe/);
  const registryNames = [...skillRegistry().keys()];
  assert.deepEqual(scenarioDiscovery({ id: 's', discovery: ['rule.add'] }, registryNames), ['rule.add']);
  assert.equal(scenarioDiscovery({ id: 's', discovery: 'none' }, registryNames), 'none');
  assert.throws(() => scenarioDiscovery({ id: 's', discovery: ['files.wipe'] }, registryNames), /discovery names no skill/);
});

test('personaGrantsConfig: her grants are exactly the given ones; people\'s grants and the live config untouched', () => {
  const live = {
    features: { skills: true },
    bot: { owners: [OWNER], access: { 'rule.list': { everyone: false, roles: [], users: [SELF, MEMBER] }, 'lore.add': { everyone: false, roles: [], users: [SELF] } } },
  };
  const before = structuredClone(live);
  const copy = personaGrantsConfig(live, SELF, ['rule.add', 'memory.wipe']);
  assert.deepEqual(live, before, 'the live config is never written');
  assert.deepEqual(copy.bot.access['rule.list'].users, [MEMBER]);
  assert.equal(copy.bot.access['lore.add'], undefined, 'an entry left empty is gone');
  assert.deepEqual(copy.bot.access['rule.add'].users, [SELF]);
  assert.deepEqual(copy.bot.access['memory.wipe'].users, [SELF]);
  assert.deepEqual(copy.bot.owners, [OWNER]);
  assert.deepEqual(personaGrantsConfig({}, SELF, []).bot.access, {});
});

/** A discord.js-like channel: the current conversation in a guild with a news channel, one role, the member's roles cached. */
function fakeChannel({ memberRoles = [] } = {}) {
  return {
    id: HERE,
    name: 'γενικά',
    guild: {
      channels: { cache: new Map([[HERE, { id: HERE, name: 'γενικά', type: 0 }], [NEWS, { id: NEWS, name: 'νέα', type: 0 }]]) },
      roles: { cache: new Map([['r1', { id: 'r1', name: 'Φίλοι' }]]) },
      members: { cache: new Map([[MEMBER, { roles: { cache: new Map(memberRoles.map((id) => [id, {}])) } }]]) },
    },
  };
}

/** The live-like config: skills on, the owner, people's `access`; her grants laid over it. */
function scenarioConfig(grants, { access = {}, features = {} } = {}) {
  return personaGrantsConfig({ features: { skills: true, ...features }, skills: { safeMode: false }, bot: { owners: [OWNER], access } }, SELF, grants);
}

/** simulateCall as the replay makes it: the call view of the turn, the requester of `author`. */
function simulate(call, { grants = [], author = OWNER, access, features, channel = fakeChannel(), resultText = 'RESULT', images } = {}) {
  const config = scenarioConfig(grants, { access, features });
  const trigger = author ? { id: '1', authorId: author } : null;
  return simulateCall({
    call,
    view: callViewOf({ channel, guildId: 'g1', idByIndex: new Map(), lines: [], pulledIds: new Map(), memoryOn: false, store: null, config, selfId: SELF, skills: skillRegistry() }),
    config,
    selfId: SELF,
    requester: requesterOf(trigger, channel),
    conversationId: HERE,
    now: NOW,
    images,
    resultText,
  });
}

test('simulateCall: a granted skill an owner asks for passes the real gateway and is only recorded, answered ok', () => {
  const out = simulate({ skill: 'rule.add', args: {}, body: 'όχι spoilers' }, { grants: ['rule.add'] });
  assert.deepEqual(out.verdict, { stage: 'gateway', ok: true });
  assert.deepEqual(out.executed, { skill: 'rule.add', args: { text: 'όχι spoilers' } });
  assert.deepEqual(out.result, { skill: 'rule.add', status: 'ok', data: { text: 'RESULT' } });
});

test('simulateCall: not granted, not grantable, or a requester without the right: refused as live, and she hears it', () => {
  const notGranted = simulate({ skill: 'rule.add', args: {}, body: 'κανόνας' });
  assert.deepEqual([notGranted.verdict.stage, notGranted.verdict.code, notGranted.result.status, notGranted.executed], ['gateway', 'not-allowed', 'denied', null]);

  assert.ok(NOT_GRANTABLE_TO_PERSONA.includes('memory.wipe'));
  const wipe = simulate({ skill: 'memory.wipe', args: {} }, { grants: ['memory.wipe'] });
  assert.deepEqual([wipe.verdict.code, wipe.result.status, wipe.executed], ['not-grantable', 'denied', null]);

  // Her grant does not lend a member a right they lack; a member granted it may have it run.
  const member = simulate({ skill: 'rule.add', args: {}, body: 'κανόνας' }, { grants: ['rule.add'], author: MEMBER });
  assert.deepEqual([member.verdict.code, member.verdict.reason, member.result.status], ['requester-denied', 'not-granted', 'denied']);
  const byRole = simulate({ skill: 'rule.add', args: {}, body: 'κανόνας' }, {
    grants: ['rule.add'], author: MEMBER, channel: fakeChannel({ memberRoles: ['r1'] }), access: { 'rule.add': { everyone: false, roles: ['r1'], users: [] } },
  });
  assert.equal(byRole.verdict.ok, true, 'the requester\'s role ids come from the member cache, as live');

  // Nobody asked: only a read.
  const unasked = simulate({ skill: 'rule.add', args: {}, body: 'κανόνας' }, { grants: ['rule.add'], author: null });
  assert.deepEqual([unasked.verdict.code, unasked.verdict.reason], ['no-requester', 'no-requester']);
});

test('simulateCall: her own operations skip the requester\'s right but not her grant', () => {
  const elsewhere = { skill: 'message.create', args: { channel: '#νέα' }, body: 'καλημέρα' };
  const own = simulate(elsewhere, { grants: ['message.create'], author: MEMBER });
  assert.equal(own.verdict.ok, true, 'self-owned: the member\'s missing right does not matter');
  assert.deepEqual(own.executed, { skill: 'message.create', args: { channel: NEWS, text: 'καλημέρα' } });
  assert.equal(simulate(elsewhere, { author: MEMBER }).verdict.code, 'not-allowed', 'another channel still needs her grant');
  assert.equal(simulate({ skill: 'message.create', args: {}, body: 'γεια' }, { author: MEMBER }).verdict.ok, true, 'carried over in the current conversation');
});

test('simulateCall: a call the server cannot resolve, a spent drawing budget, the full stop', () => {
  const unknown = simulate({ skill: 'files.wipe', args: {} });
  assert.deepEqual([unknown.verdict.stage, unknown.verdict.code, unknown.result.status], ['resolve', 'unknown-skill', 'invalid']);
  const channel = simulate({ skill: 'message.create', args: { channel: '#πουθενά' }, body: 'γεια' }, { grants: ['message.create'] });
  assert.deepEqual([channel.verdict.stage, channel.verdict.code], ['resolve', 'invalid-args']);
  const drawing = { skill: 'draw.create', args: {}, body: 'un chat sur la lune' };
  const spent = simulate(drawing, { images: { quota: () => ({ spent: true, userSpent: false }) } });
  assert.deepEqual([spent.verdict.stage, spent.verdict.code, spent.verdict.reason], ['gateway', 'daily-cap', 'image.maxPerDay']);
  const left = simulate(drawing, { images: { quota: () => ({ spent: false, userSpent: false }) } });
  assert.equal(left.verdict.ok, true, 'a paid effect is recorded and answered canned, never run');
  assert.equal(left.result.status, 'ok');
  const off = simulate({ skill: 'rule.add', args: {}, body: 'κανόνας' }, { grants: ['rule.add'], features: { skills: false } });
  assert.equal(off.verdict.code, 'skills-off');
});

test('scenarioInventory: the requester\'s catalogue as live discovery lists it: whole, the named ones, or none', () => {
  const config = scenarioConfig(['rule.add']);
  const texts = { 'rule.add': { title: 'Add a rule', whenToUse: 'when asked' } };
  const input = { config, selfId: SELF, texts, conversationId: HERE, registry: skillRegistry() };
  const whole = scenarioInventory({ ...input, requester: { id: OWNER, roleIds: [] } });
  // A skill behind a feature switch that is off has no row (src/skills/access.js#FEATURE_SKILLS).
  assert.equal(whole.length, [...skillRegistry().keys()].filter((name) => !Object.hasOwn(FEATURE_SKILLS, name)).length);
  assert.deepEqual(whole.find((row) => row.name === 'rule.add'), { name: 'rule.add', title: 'Add a rule', whenToUse: 'when asked', allowed: true, reason: 'allowed', args: [{ name: 'text', required: true, body: true }] });
  assert.equal(scenarioInventory({ ...input, requester: { id: MEMBER, roleIds: [] } }).find((row) => row.name === 'rule.add').reason, 'requester-denied');
  const named = scenarioInventory({ ...input, requester: { id: OWNER, roleIds: [] }, discovery: ['rule.add', 'rule.remove'] });
  assert.deepEqual(named.map((row) => [row.name, row.allowed, row.proposed]), [['rule.add', true, true], ['rule.remove', false, true]]);
  assert.equal(scenarioInventory({ ...input, requester: null, discovery: 'none' }), null);
  assert.equal(scenarioInventory({ ...input, config: { ...config, features: { skills: true, skillsDiscovery: false } }, requester: null }), null);
});

test('replay --skills: the flags it takes; the invented message; a run as its JSONL line, the counts and the report', () => {
  const args = parseArgs(['--skills', 'scenarios.json', '--out', 'out', '--before', '20', '--as-of-moment', '--dry']);
  assert.deepEqual([args.skills, args.outDir, args.before, args.asOfMoment, args.dry], ['scenarios.json', 'out', 20, true, true]);
  assert.throws(() => parseArgs(['--skills', 'a.json', '--samples', '2']), /usage/);
  assert.throws(() => parseArgs(['--skills', 'a.json', '123456789012345678', '223456789012345678']), /usage/);
  assert.throws(() => parseArgs(['123456789012345678', '223456789012345678', '--dry']), /usage/);

  const trigger = scenarioTrigger({ text: 'Γεια σου', authorId: MEMBER, authorName: 'Zoë', channel: { id: HERE, name: 'γενικά' }, selfId: SELF, at: NOW });
  assert.equal(trigger.ts, NOW);
  assert.ok(BigInt(trigger.id) > 0n && /^\d{17,20}$/.test(trigger.id), 'a snowflake of its moment');
  assert.deepEqual([trigger.mentionedUserIds, trigger.replyToId, trigger.self, trigger.content], [[SELF], null, false, 'Γεια σου']);

  const answer = (text) => ({ messages: [{ text, replyTo: null }], reactions: [], gif: null, draw: null, skip: false, think: '' });
  const called = runRecord('s', 0, {
    answer: answer('μια στιγμή'), call: { skill: 'rule.add', args: {}, body: 'κανόνας' }, callError: null, extraCalls: 0,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
    outcome: { verdict: { stage: 'gateway', ok: false, code: 'not-allowed', reason: 'rule.add' }, executed: null, result: { skill: 'rule.add', status: 'denied', code: 'not-allowed' } },
    followUp: { answer: answer('δεν μπορώ'), extraCall: false, usage: { prompt_tokens: 120, completion_tokens: 5, cost: 0.02 } },
  });
  assert.deepEqual([called.decision, called.skill, called.args, called.result], ['call', 'rule.add', { body: 'κανόνας' }, { status: 'denied', code: 'not-allowed' }]);
  assert.deepEqual([called.first.messages, called.followUp.messages, called.tokens], [['μια στιγμή'], ['δεν μπορώ'], { prompt: 220, completion: 15 }]);
  assert.ok(Math.abs(called.cost - 0.03) < 1e-9);
  const declined = runRecord('s', 1, { answer: answer('όχι'), call: null, callError: null, extraCalls: 0, usage: { prompt_tokens: 90, completion_tokens: 3 }, outcome: null, followUp: null });
  assert.deepEqual([declined.decision, declined.verdict, declined.cost], ['no-call', null, null]);
  const summary = scenarioSummary([called, declined]);
  assert.deepEqual([summary.runs, summary.calls, summary.passed, summary.denied, summary.noCall, summary.followUps], [2, 1, 0, 1, 1, 1]);
  const report = renderSkillsReport([{ scenario: { id: 's', text: 'Γεια | σου', discovery: 'inventory' }, grantNames: [], summary, records: [called, declined] }]);
  assert.ok(report.includes('| s | 2 | 1 | 0 | 1 | 1 | 0 | 1 |'));
  assert.ok(report.includes('refused at gateway: not-allowed') && report.includes('> δεν μπορώ'));
});

// ---- multi-step scenarios ---------------------------------------------------------

const OTHER = '100000000000000009';
const NAMES = { [OWNER]: 'Élodie', [MEMBER]: 'Zoë', [OTHER]: 'Νίκος' };

/** The config of a sequence's view: what buildRequest reads, skills on, the owner, her grants laid over it. */
function sequenceConfig(grants, features = {}, nameTriggers = []) {
  return personaGrantsConfig({
    bot: { owners: [OWNER], timezone: 'UTC', access: {}, nameTriggers },
    context: {
      channelMessages: 100, maxMessageChars: 800, gapMarkerMinutes: 20, otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    models: { core: 'x/chat' },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
    skills: { safeMode: false },
    features: { skills: true, ...features },
  }, SELF, grants);
}

/** A model that answers `texts` in order and keeps every request it got. */
function scriptedLlm(texts) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      return { usage: { prompt_tokens: 100, completion_tokens: 10 }, ...completionOf(texts[calls.length - 1] ?? '<skip/>') };
    },
  };
}

/** The user text of one recorded request. */
function userOf(call) {
  const content = call.messages[1].content;
  return typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('');
}

/**
 * One run of a multi-step scenario as the replay plays it (playSteps over answerSkillScenario,
 * simulateCall and afterScenarioTurn), against fakes: the channel γενικά with νέα beside it.
 */
async function playSequence(rawSteps, texts, { grants = ['message.create', 'rule.add', 'rule.list'], history = [], nameTriggers = [] } = {}) {
  const [scenario] = load([{ id: 'seq', channelId: HERE, steps: rawSteps, grants: [], result: 'SCENARIO_RESULT' }]);
  const config = sequenceConfig(grants, {}, nameTriggers);
  const hot = { config, prompts: { 'system-prompt': 'SYSTEM', 'character-card': 'CARD', format: 'FORMAT', reply: 'REPLY {{author}}', labels } };
  const store = { getGuild: () => ({}), getUser: () => null, listChannels: () => [{ id: NEWS, name: 'νέα' }], listUserProfiles: () => [], getLore: () => [], state: { data: {} } };
  const view = liveView({ hot, store, guildId: 'g1' });
  const channel = fakeChannel();
  const here = { id: HERE, name: 'γενικά' };
  const llm = scriptedLlm(texts);
  const steps = [];
  const records = [];
  const lineOf = (message, at, { tagged }) => scenarioTrigger({ text: message.text, authorId: message.author, authorName: NAMES[message.author], channel: here, selfId: SELF, at, tagged });
  const seedLine = (message, at) => seededSelfLine({ text: message.text, at, selfId: SELF, selfName: 'Persona', channel: here });
  const played = await playSteps({
    scenario, history, firstAt: NOW, runIndex: 0, lineOf, seedLine,
    planBurst: (incoming, { history: before }) => burstTurns(incoming, { selfId: SELF, config, history: before }),
    answerStep: async ({ situation, trigger, at, callMarks, result, queued }) => {
      const requester = requesterOf(trigger, channel);
      const answered = await answerSkillScenario({
        view, situation, selfId: SELF, selfName: 'Persona', channel: here, llm, runs: 1, at, callMarks, queued,
        onCall: (call, { idByIndex, history: lines }) =>
          simulateCall({
            call,
            view: callViewOf({ channel, guildId: 'g1', idByIndex, lines, pulledIds: new Map(), memoryOn: false, store: null, selfId: SELF, skills: skillRegistry() }),
            config, selfId: SELF, requester, conversationId: HERE, now: at, resultText: result,
          }),
      });
      steps.push({ situation, trigger, at, callMarks, queued, requests: llm.calls.length });
      return { run: answered.runs[0] ?? null, stopped: answered.stopped };
    },
    afterTurn: ({ transcript, callMarks, run, at, triggerId }) => afterScenarioTurn({ transcript, callMarks, run, at, selfId: SELF, selfName: 'Persona', channel: here, triggerId, config }),
    onRecord: (record) => records.push(record),
  });
  return { played, steps, records, llm };
}

/** Her call mark as the transcript words it with the test labels: done, in `channel`. */
const marked = (skill, channel) => fill(labels.transcript.called, { skill, target: fill(labels.transcript.calledTargetChannel, { channel }), status: labels.transcript.callStatus.ok, posted: '' });

test('parseScenarios: steps take the place of author and text; a burst adds messages by their own authors; defaults and refusals', () => {
  const [scenario] = load([{ id: 'seq', channelId: HERE, grants: [], steps: [
    { author: OWNER, text: 'α' },
    { author: MEMBER, text: 'β', gapMinutes: 2.5, result: 'Résultat', burst: [{ author: OTHER, text: 'γ' }] },
    { burst: [{ author: MEMBER, text: 'δ' }, { author: OWNER, text: 'ε' }] },
  ] }]);
  assert.deepEqual(scenario, {
    id: 'seq', channelId: HERE, before: null, grants: [], runs: 1, result: '', discovery: 'inventory',
    steps: [
      { messages: [{ author: OWNER, text: 'α' }], own: true, gapMinutes: 1, result: null },
      { messages: [{ author: MEMBER, text: 'β' }, { author: OTHER, text: 'γ' }], own: true, gapMinutes: 2.5, result: 'Résultat' },
      { messages: [{ author: MEMBER, text: 'δ' }, { author: OWNER, text: 'ε' }], own: false, gapMinutes: 1, result: null },
    ],
  });
  const step = (overrides) => ({ id: 's', channelId: HERE, grants: [], steps: [{ author: OWNER, text: 'α', ...overrides }] });
  const refused = [
    [{ ...step({}), author: OWNER }, /steps replace author and text/],
    [{ id: 's', channelId: HERE, grants: [], steps: [] }, /steps must be a list of 1\.\.20/],
    [{ id: 's', channelId: HERE, grants: [], steps: Array.from({ length: 21 }, () => ({ author: OWNER, text: 'α' })) }, /steps must be/],
    [step({ extra: 1 }), /step 1: unknown field extra/],
    [step({ author: 'x' }), /step 1: the message: author must be a member id/],
    [{ id: 's', channelId: HERE, grants: [], steps: [{ gapMinutes: 2 }] }, /step 1: needs author and text, or a burst/],
    [step({ burst: [] }), /burst must be a list of 1\.\.10/],
    [step({ burst: [{ author: OTHER, text: 'γ', gapMinutes: 1 }] }), /burst 1: unknown field gapMinutes/],
    [step({ burst: [{ author: 'x', text: 'γ' }] }), /burst 1: author/],
    [step({ gapMinutes: 0 }), /gapMinutes/],
    [step({ gapMinutes: '1' }), /gapMinutes/],
    [step({ result: 3 }), /step 1: result/],
  ];
  for (const [scenarioRaw, message] of refused) assert.throws(() => load([scenarioRaw]), message);
});

test('replay --skills steps: three steps keep her lines and her call marks between steps; a post into another channel leaves only its mark', async () => {
  const { played, steps, records, llm } = await playSequence(
    [{ author: OWNER, text: 'πρώτο' }, { author: OWNER, text: 'δεύτερο', gapMinutes: 2, result: 'RULE_RESULT' }, { author: OWNER, text: 'τρίτο' }],
    [
      toolAnswer('<think>θα το στείλω</think><msg>μια στιγμή</msg>', [call('message.create', { channel: '#νέα', text: 'καλημέρα' })]),
      toolAnswer('<think>t</think><msg>εντάξει</msg>', [call('rule.list', {})]),
      '<think>t</think><msg>έγινε</msg>',
      '<think>t</think><msg>όχι</msg>',
    ],
  );
  assert.equal(played.stopped, false);
  assert.equal(llm.calls.length, 4, 'step 1 (a post covers her speech, no follow-up), step 2 and its follow-up (a list is read first), step 3');
  assert.deepEqual(steps.map((s) => s.requests), [1, 3, 4]);

  // Step 2 reads her step-1 line with the call's mark; the post went to νέα, so its text is not here.
  const second = userOf(llm.calls[1]);
  const createLine = second.split('\n').find((line) => line.includes('μια στιγμή'));
  assert.ok(createLine && createLine.includes(marked('message.create', 'νέα')), second);
  assert.ok(!second.includes('καλημέρα'), 'a post into another channel is not a line here');
  assert.ok(second.indexOf('πρώτο') < second.indexOf('μια στιγμή') && second.indexOf('μια στιγμή') < second.indexOf('δεύτερο'));
  assert.equal(steps[1].callMarks.length, 1);
  assert.equal(steps[1].at, NOW + 1000 + 2 * 60_000, 'two minutes after the newest line: hers, a second after the trigger');

  // The follow-up of step 2 appends to the same first messages (step 1's mark in them) with her answer and the call's result.
  const followUp = llm.calls[2].messages;
  assert.equal(userOf(llm.calls[2]), second, 'the first user message is never rebuilt');
  assert.deepEqual(followUp.slice(2).map((message) => message.role), ['assistant', 'tool', 'user']);
  assert.ok(followUp[3].content.includes('RULE_RESULT'));
  assert.ok(followUp[4].content[0].text.includes(labels.task.step.held), 'her step-2 speech was held, and she is told');

  // Step 3 reads both turns: every line of hers that was posted, the rule.list mark on the follow-up's line (the turn's last).
  const third = userOf(llm.calls[3]);
  for (const text of ['μια στιγμή', 'έγινε', 'δεύτερο']) assert.ok(third.includes(text), text);
  assert.ok(!third.includes('εντάξει'), 'a held speech is not in the channel');
  assert.ok(third.split('\n').find((line) => line.includes('έγινε'))?.includes(marked('rule.list', 'γενικά')), third);
  assert.equal(steps[2].callMarks.length, 2);

  const hers = played.transcript.filter((line) => line.self);
  assert.deepEqual(hers.map((line) => line.content), ['μια στιγμή', 'έγινε', 'όχι']);
  assert.ok(hers.every((line) => line.authorId === SELF && /^\d+$/.test(line.id)));
  assert.equal(hers[0].triggerId, steps[0].trigger.id, 'linked to the message that started her turn');
  const times = played.transcript.map((line) => line.ts);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'the channel stays in time order');

  // One record per step, the step number after the run, her whole think kept.
  assert.deepEqual(records.map((r) => [r.run, r.step, r.decision, r.skill]), [[1, 1, 'call', 'message.create'], [1, 2, 'call', 'rule.list'], [1, 3, 'no-call', null]]);
  assert.deepEqual(Object.keys(records[0]).slice(0, 3), ['scenario', 'run', 'step']);
  assert.equal(records[0].first.think, 'θα το στείλω');
  assert.deepEqual([records[0].verdict.ok, records[0].executed.args.channel, records[0].followUp], [true, NEWS, null]);
  assert.deepEqual(records[1].followUp.messages, ['έγινε']);
  assert.equal(records[1].loop.held, 1);
  assert.deepEqual(played.records, records);
});

test('replay --skills steps: a burst of two named calls gets two turns in arrival order; the first names the waiting call under the queued labels', async () => {
  const { steps, records, llm, played } = await playSequence(
    [{ burst: [{ author: OWNER, text: 'Persona, πρόσθεσε κανόνα' }, { author: MEMBER, text: 'Persona, κι εμένα έναν' }] }],
    [toolAnswer('<think>t</think><msg>έγινε</msg>', [call('rule.add', { text: 'όχι spoilers' })]), toolAnswer('<think>t</think>', [call('rule.add', { text: 'κι άλλος' })]), '<think>t</think><msg>όχι από σένα</msg>'],
    { nameTriggers: ['persona'] },
  );
  assert.equal(played.stopped, false);
  assert.equal(steps.length, 2, 'one turn per call');
  assert.deepEqual(steps.map((s) => [s.trigger.authorId, s.situation.kind]), [[OWNER, 'name'], [MEMBER, 'name']]);
  const lines = steps[0].situation.history;
  assert.deepEqual(lines.slice(-2).map((line) => [line.authorId, line.content, line.mentionedUserIds]), [[OWNER, 'Persona, πρόσθεσε κανόνα', []], [MEMBER, 'Persona, κι εμένα έναν', []]]);
  assert.equal(lines.at(-1).ts - lines.at(-2).ts, 5000);

  // The first turn sees the second call waiting, by another member: labels.task.queuedOthers.
  assert.deepEqual(steps[0].queued, [{ id: lines.at(-1).id, text: 'Persona, κι εμένα έναν', author: 'Zoë' }]);
  const first = userOf(llm.calls[0]);
  assert.ok(first.includes(fill(labels.task.queuedOthers, { others: '1. Zoë: Persona, κι εμένα έναν' })), first);
  assert.ok(first.includes('Élodie') && first.indexOf('πρόσθεσε κανόνα') < first.indexOf('κι εμένα έναν'), first);
  // The second turn: nothing waits any more, and her first turn is in the channel it reads.
  assert.deepEqual(steps[1].queued, []);
  const second = userOf(llm.calls[1]);
  assert.ok(!second.includes(fill(labels.task.queuedOthers, { others: '' }).slice(0, 20)), second);
  assert.ok(second.includes('έγινε') && second.indexOf('κι εμένα έναν') < second.indexOf('έγινε'), second);
  assert.ok(steps[1].at > steps[0].at && steps[0].at === lines.at(-1).ts);

  // Each turn's requester is its own call's author: the owner may, the member may not.
  assert.deepEqual(records.map((r) => [r.step, r.turn, r.decision, r.verdict?.ok]), [[1, 1, 'call', true], [1, 2, 'call', false]]);
  assert.deepEqual([records[1].verdict.code, records[1].verdict.reason], ['requester-denied', 'not-granted']);
  assert.deepEqual(records[1].followUp.messages, ['όχι από σένα']);
  assert.deepEqual(records[0].queue, {
    turns: 2, kind: 'name', trigger: { id: lines.at(-2).id, author: OWNER, text: 'Persona, πρόσθεσε κανόνα' }, queued: 1, replaced: [], dropped: [],
  });
  assert.deepEqual(played.bursts, [{ step: 1, turns: [lines.at(-2).id, lines.at(-1).id], replaced: [], dropped: [] }]);
});

test('replay --skills steps: plain follow-ups after a call share one slot; the newer replaces the older, which is reported', async () => {
  const { steps, records, llm, played } = await playSequence(
    [{ author: OWNER, text: 'πρώτο μήνυμα', burst: [{ author: OWNER, text: 'και κάτι ακόμα' }, { author: MEMBER, text: 'κι άλλο ένα' }] }],
    ['<msg>ένα</msg>', '<msg>δύο</msg>'],
  );
  assert.equal(played.stopped, false);
  const lines = steps[0].situation.history;
  const [call, older, newer] = lines.slice(-3);
  assert.deepEqual([call, older, newer].map((line) => line.mentionedUserIds), [[SELF], [], []], 'the step\'s own message tags her; the burst does not');
  assert.deepEqual(steps.map((s) => [s.trigger.id, s.situation.kind]), [[call.id, 'mention'], [newer.id, 'followUp']]);
  // The first turn sees only the follow-up left in the slot: another member's.
  assert.deepEqual(steps[0].queued, [{ id: newer.id, text: 'κι άλλο ένα', author: 'Zoë' }]);
  assert.ok(!userOf(llm.calls[0]).includes(fill(labels.task.queued, { others: '1. και κάτι ακόμα' })));
  // The replaced line stays in the channel: the second turn reads it, after her first answer.
  const second = userOf(llm.calls[1]);
  assert.ok(second.includes('και κάτι ακόμα') && second.includes('ένα'), second);
  const replaced = [{ id: older.id, author: OWNER, text: 'και κάτι ακόμα', by: newer.id }];
  assert.deepEqual(records.map((r) => [r.turn, r.queue.kind, r.queue.replaced]), [[1, 'mention', replaced], [2, 'followUp', replaced]]);
  assert.deepEqual(played.bursts, [{ step: 1, turns: [call.id, newer.id], replaced, dropped: [] }]);
  // Two decisions in one step: the pattern has both, and the run is complete.
  const summary = sequenceSummary(records, 1);
  assert.deepEqual([summary.pattern, summary.sequences[0].complete], ['NN', true]);
  assert.deepEqual([sequenceSummary(records.slice(0, 1), 1).sequences[0].complete], [false], 'a burst cut after its first turn is cut short');
  const report = renderSkillsReport([{ scenario: { id: 'seq', steps: [{ messages: [], gapMinutes: 1, result: null }], discovery: 'inventory' }, grantNames: [], summary, records }]);
  assert.ok(report.includes('#### step 1, turn 2 of 2 (followUp'), report);
  assert.ok(report.includes('replaced: ') && report.includes('και κάτι ακόμα'), report);
});

test('parseScenarios: a seeded line of hers -- a step { self } or a burst item { self: true } -- and its refusals', () => {
  const [scenario] = load([{ id: 'seq', channelId: HERE, grants: [], steps: [
    { author: OWNER, text: 'α' },
    { self: 'γιατί;', gapMinutes: 0.5 },
    { author: OWNER, text: 'β', burst: [{ self: true, text: 'καλά' }, { author: MEMBER, text: 'γ' }] },
  ] }]);
  assert.deepEqual(scenario.steps, [
    { messages: [{ author: OWNER, text: 'α' }], own: true, gapMinutes: 1, result: null },
    { messages: [{ self: true, text: 'γιατί;' }], own: false, gapMinutes: 0.5, result: null },
    { messages: [{ author: OWNER, text: 'β' }, { self: true, text: 'καλά' }, { author: MEMBER, text: 'γ' }], own: true, gapMinutes: 1, result: null },
  ]);
  const steps = (list) => ({ id: 's', channelId: HERE, grants: [], steps: list });
  const refused = [
    [steps([{ author: OWNER, text: 'α' }, { self: '   ' }]), /step 2: self must be 1\.\.4000 characters/],
    [steps([{ author: OWNER, text: 'α' }, { self: 'γ', author: OWNER }]), /step 2: self takes only gapMinutes/],
    [steps([{ author: OWNER, text: 'α' }, { self: 'γ', burst: [{ author: OWNER, text: 'δ' }] }]), /step 2: self takes only gapMinutes/],
    [steps([{ author: OWNER, text: 'α' }, { self: 'γ', result: 'x' }]), /step 2: self takes only gapMinutes/],
    [steps([{ author: OWNER, text: 'α', burst: [{ self: 'yes', text: 'γ' }] }]), /step 1: burst 1: self must be true/],
    [steps([{ author: OWNER, text: 'α', burst: [{ self: true, author: OWNER, text: 'γ' }] }]), /step 1: burst 1: a line of hers has no author/],
    [steps([{ author: OWNER, text: 'α', burst: [{ self: true }] }]), /step 1: burst 1: text must be/],
    [steps([{ self: 'α' }, { burst: [{ self: true, text: 'β' }] }]), /needs at least one step that runs her turn/],
  ];
  for (const [scenarioRaw, message] of refused) assert.throws(() => load([scenarioRaw]), message);
  // Her seeded lines cost no request: only the messages that may get a turn count.
  assert.equal(skillRequestEstimate([scenario]), 2 * 3, 'three messages not hers x two requests');
});

test('replay --skills steps: a seeded line is hers in the channel before the next step, rendered as her live lines, and costs no request', async () => {
  const { played, steps, records, llm } = await playSequence(
    [{ author: OWNER, text: 'στείλε κάτι στα νέα' }, { self: 'γιατί;' }, { author: OWNER, text: 'απλώς κάν\' το', gapMinutes: 2 }],
    ['<msg>ας δούμε</msg>', '<msg>εντάξει τότε</msg>'],
  );
  assert.equal(played.stopped, false);
  assert.equal(llm.calls.length, 2, 'one request per step that runs her turn; the seeded line none');
  assert.equal(steps.length, 2);
  const hers = played.transcript.filter((line) => line.self);
  assert.deepEqual(hers.map((line) => line.content), ['ας δούμε', 'γιατί;', 'εντάξει τότε']);
  const [live, seeded] = hers;
  // Shaped as her live lines: her id and name, no link to a trigger, no call mark.
  assert.deepEqual([seeded.authorId, seeded.authorName, seeded.self, seeded.bot], [SELF, 'Persona', true, false]);
  assert.equal('triggerId' in seeded, false);
  assert.deepEqual(Object.keys(seeded).sort(), Object.keys(live).filter((key) => key !== 'triggerId').sort());
  assert.ok(/^\d+$/.test(seeded.id) && seeded.id !== live.id);
  // Timed like a step: a minute after the newest line (her answer, a second after the trigger).
  assert.equal(seeded.ts, NOW + 1000 + 60_000);
  assert.equal(steps[1].at, seeded.ts + 2 * 60_000 + 0, 'the next step two minutes after her seeded line');
  // The next request reads it as hers, between her answer and the next message, with no marker.
  const second = userOf(llm.calls[1]);
  const line = second.split('\n').find((l) => l.includes('γιατί;'));
  assert.ok(line && line.includes('Persona'), second);
  assert.ok(!line.includes('(turn triggered by') && !line.includes('[called '), line);
  assert.ok(second.indexOf('ας δούμε') < second.indexOf('γιατί;') && second.indexOf('γιατί;') < second.indexOf('απλώς κάν'), second);
  // No record for it: the pattern holds the two decisions, steps 1 and 3, and the run is complete.
  assert.deepEqual(records.map((r) => [r.step, r.decision]), [[1, 'no-call'], [3, 'no-call']]);
  const summary = sequenceSummary(records, 3, { seededSteps: 1 });
  assert.deepEqual([summary.steps, summary.pattern, summary.sequences[0].complete, summary.sequences[0].firstDecline], [3, 'NN', true, 1]);
  assert.equal(sequenceSummary(records.slice(0, 1), 3, { seededSteps: 1 }).sequences[0].complete, false);
});

test('replay --skills steps: a seeded line inside a burst gets no turn; the first decision skips a seeded first step', async () => {
  const { steps, records, llm, played } = await playSequence(
    [{ author: OWNER, text: 'πρώτο', burst: [{ self: true, text: 'μισό λεπτό' }] }],
    ['<msg>λοιπόν</msg>'],
  );
  assert.equal(llm.calls.length, 1);
  assert.equal(steps.length, 1, 'the burst has one message that may call her: one turn');
  const lines = steps[0].situation.history;
  assert.deepEqual(lines.slice(-2).map((line) => [line.self === true, line.content]), [[false, 'πρώτο'], [true, 'μισό λεπτό']]);
  assert.equal(steps[0].at, lines.at(-1).ts, 'answered after her seeded line');
  assert.ok(!('queue' in records[0]), 'one turn: no queue');
  assert.deepEqual(played.bursts, []);

  // A first step that is only her line: the first decision is the next step's, her line before it.
  const [scenario] = load([{ id: 'seq', channelId: HERE, grants: [], steps: [{ self: 'καλημέρα' }, { author: OWNER, text: 'γεια', gapMinutes: 3 }] }]);
  const here = { id: HERE, name: 'γενικά' };
  const first = firstDecision({
    scenario, history: [], firstAt: NOW,
    lineOf: (message, at, { tagged }) => scenarioTrigger({ text: message.text, authorId: message.author, authorName: NAMES[message.author], channel: here, selfId: SELF, at, tagged }),
    seedLine: (message, at) => seededSelfLine({ text: message.text, at, selfId: SELF, selfName: 'Persona', channel: here }),
    planBurst: (incoming, { history: before }) => burstTurns(incoming, { selfId: SELF, config: sequenceConfig([]), history: before }),
  });
  assert.deepEqual(first.lines.map((line) => [line.self === true, line.content, line.ts]), [[true, 'καλημέρα', NOW], [false, 'γεια', NOW + 3 * 60_000]]);
  assert.deepEqual([first.turn.line.content, first.turn.kind], ['γεια', 'mention']);
});

test('burstTurns: the live queue over a burst -- the first message starts the turn, calls wait in arrival order, one follow-up slot, the cap', () => {
  const here = { id: HERE, name: 'γενικά' };
  const line = (author, text, i) => scenarioTrigger({ text, authorId: author, authorName: NAMES[author], channel: here, selfId: SELF, at: NOW + i * 5000, tagged: false });
  const a = line(OWNER, 'Persona, α', 0);
  const b = line(OWNER, 'persona β', 1);
  const c = line(MEMBER, 'γ', 2);
  const d = line(OTHER, `<@${SELF}> δ`, 3);
  const e = line(MEMBER, 'ε', 4);
  assert.deepEqual(d.mentionedUserIds, [SELF], 'a tag written in the text tags her');
  const config = { bot: { nameTriggers: ['Persona'] } };
  const plan = burstTurns([a, b, c, d, e], { selfId: SELF, config });
  assert.deepEqual(plan.turns.map((t) => [t.line.id, t.kind]), [[a.id, 'name'], [b.id, 'name'], [d.id, 'mention'], [e.id, 'followUp']]);
  assert.deepEqual(plan.replaced, [{ id: c.id, by: e.id }]);
  assert.deepEqual(plan.dropped, []);
  // The trigger author's own waiting calls carry no author (labels.task.queued); another member's do.
  assert.deepEqual(plan.turns[0].queued, [{ id: b.id, text: 'persona β' }, { id: d.id, text: `<@${SELF}> δ`, author: 'Νίκος' }, { id: e.id, text: 'ε', author: 'Zoë' }]);
  assert.deepEqual(plan.turns[1].queued, [{ id: d.id, text: `<@${SELF}> δ`, author: 'Νίκος' }, { id: e.id, text: 'ε', author: 'Zoë' }]);
  assert.deepEqual(plan.turns[3].queued, []);
  // features.nameTriggers off: a named line is a plain follow-up.
  const off = burstTurns([a, b], { selfId: SELF, config: { ...config, features: { nameTriggers: false } } });
  assert.deepEqual(off.turns.map((t) => t.kind), ['followUp', 'followUp']);
  // mention.maxPending: the oldest waiting entry is dropped when the queue is full.
  const capped = burstTurns([a, b, d, e], { selfId: SELF, config: { ...config, mention: { maxPending: 2 } } });
  assert.deepEqual(capped.dropped, [{ id: b.id, reason: 'full' }]);
  assert.deepEqual(capped.turns.map((t) => t.line.id), [a.id, d.id, e.id]);
  // A reply to her own line is a reply call.
  const mine = { id: '300000000000000001', self: true, authorId: SELF, ts: NOW - 1000 };
  const reply = { ...line(MEMBER, 'ναι', 0), replyToId: mine.id };
  assert.equal(burstTurns([reply], { selfId: SELF, config, history: [mine] }).turns[0].kind, 'reply');
  assert.deepEqual(burstTurns([], { selfId: SELF, config }), { turns: [], replaced: [], dropped: [] });
});

test('afterScenarioTurn: a post the call left here is her line hosting the mark; her reactions and drawing land; the transcript handed in is untouched', () => {
  const here = { id: HERE, name: 'γενικά' };
  const trigger = scenarioTrigger({ text: 'Γεια σου', authorId: MEMBER, authorName: 'Zoë', channel: here, selfId: SELF, at: NOW });
  const answer = { messages: [{ text: 'γεια', replyTo: 1 }], reactions: [{ to: 1, emoji: '👍' }], gif: null, skip: false, think: '' };
  const okOutcome = (skill, args) => ({ verdict: { stage: 'gateway', ok: true }, executed: { skill, args }, result: { skill, status: 'ok', data: { text: '' } } });
  const idByIndex = new Map([[1, trigger.id]]);
  const run = {
    answer, call: { skill: 'message.create', args: { text: 'δεύτερο' }, body: '' }, followUp: null,
    outcome: okOutcome('message.create', { text: 'δεύτερο' }),
    refs: { idByIndex, handles: null, followUpIdByIndex: null },
    loop: { steps: [{ step: 0, answer, held: false, idByIndex, calls: [{ outcome: okOutcome('message.create', { text: 'δεύτερο' }) }, { outcome: okOutcome('draw.create', { text: 'un chat' }) }] }] },
  };
  const before = structuredClone(trigger);
  const out = afterScenarioTurn({ transcript: [trigger], callMarks: [], run, at: NOW, selfId: SELF, selfName: 'Persona', channel: here, triggerId: trigger.id, config: {} });
  assert.deepEqual(trigger, before);
  const [first, mine, posted, drawn] = out.transcript;
  assert.deepEqual(first.reactions, [{ emoji: '👍', count: 1, mine: true }]);
  assert.deepEqual([mine.content, mine.replyToId, mine.ts], ['γεια', trigger.id, NOW + 1000]);
  assert.equal(drawn.attachments[0].kind, 'image');
  assert.deepEqual([posted.content, posted.self], ['δεύτερο', true]);
  assert.equal(out.callMarks.length, 2);
  assert.deepEqual([out.callMarks[0].postedId, out.callMarks[0].posted], [posted.id, [mine.id, posted.id, drawn.id]]);
  // A held step's speech is not in the chat; its calls still left their effects and marks.
  const held = afterScenarioTurn({ transcript: [trigger], callMarks: [], run: { ...run, loop: { steps: [{ ...run.loop.steps[0], held: true }] } }, at: NOW, selfId: SELF, selfName: 'Persona', channel: here, triggerId: trigger.id, config: {} });
  assert.deepEqual(held.transcript.filter((line) => line.self).map((line) => line.content), ['δεύτερο', '']);
  assert.deepEqual(held.transcript[0].reactions ?? [], [], 'a held step\'s reactions are not on the chat either');
  // A run without its loop record is read as a reply and its call; no call: her lines only, the earlier marks kept, no new one.
  const plain = afterScenarioTurn({ transcript: [trigger], callMarks: out.callMarks, run: { answer, call: null, outcome: null, followUp: null, refs: run.refs }, at: NOW, selfId: SELF, selfName: 'Persona', channel: here, triggerId: trigger.id, config: {} });
  assert.equal(plain.transcript.length, 2);
  assert.equal(plain.callMarks.length, 2);
});

test('sequenceSummary: each run\'s calls per step as letters, its first decline, whether she called again after it; the report\'s sequence table', () => {
  const step = (run, n, decision) => ({
    scenario: 'seq', run, step: n, decision, skill: decision === 'call' ? 'rule.add' : null, args: null, extraCalls: 0,
    verdict: decision === 'call' ? { stage: 'gateway', ok: true } : null, followUp: null,
    first: { messages: [], reactions: [], gif: null, draw: null, skip: true, think: 'σκέψη '.repeat(80) }, tokens: { prompt: 10, completion: 1 }, cost: null,
  });
  const records = [
    ...['call', 'call', 'call', 'no-call'].map((d, i) => step(1, i + 1, d)),
    ...['no-call', 'call', 'malformed-call', 'no-call'].map((d, i) => step(2, i + 1, d)),
    step(3, 1, 'call'),
  ];
  const summary = sequenceSummary(records, 4);
  assert.deepEqual([summary.runs, summary.steps, summary.decisions, summary.calls, summary.noCall, summary.malformed], [3, 4, 9, 5, 3, 1]);
  assert.equal(summary.pattern, 'CCCN NCMN C');
  assert.deepEqual(summary.sequences, [
    { run: 1, pattern: 'CCCN', firstDecline: 4, resumed: false, complete: true },
    { run: 2, pattern: 'NCMN', firstDecline: 1, resumed: true, complete: true },
    { run: 3, pattern: 'C', firstDecline: null, resumed: null, complete: false },
  ]);
  const scenario = { id: 'seq', steps: [{ messages: [{ author: OWNER, text: 'α' }], gapMinutes: 1, result: null }], discovery: 'inventory' };
  const report = renderSkillsReport([{ scenario, grantNames: ['rule.add'], summary, records }]);
  assert.ok(report.includes('| seq | 4 | 3 | `CCCN NCMN C` (cut short) | 4 1 - | 1/2 |'), report);
  assert.ok(report.includes('### run 2: NCMN') && report.includes('#### step 3: malformed-call'));
  assert.ok(report.includes(`> ${OWNER}: α`));
  const think = report.split('\n').find((line) => line.startsWith('think: '));
  assert.ok(think.endsWith('...') && think.length <= 'think: '.length + 303, 'the start of her think only');
});

test('skillRequestEstimate: up to two requests per decision -- a run, or every turn of every step of every run', () => {
  const [single, multi] = load([
    raw({ id: 'one', runs: 3 }),
    { id: 'seq', channelId: HERE, grants: [], runs: 2, steps: [{ author: OWNER, text: 'α' }, { author: OWNER, text: 'β' }, { burst: [{ author: MEMBER, text: 'γ' }, { author: OTHER, text: 'δ' }] }] },
  ]);
  assert.equal(skillRequestEstimate([single]), 6);
  assert.equal(skillRequestEstimate([multi]), 16, 'four messages x two runs x two requests: every message of a burst may get its own turn');
  assert.equal(skillRequestEstimate([single, multi]), 22);
});

// ---- prompt layers: --prompts and --pair-prompts ------------------------------------

test('replay --skills --prompts: the directory is laid over a copy of prompts.local/; a file in it replaces, labels.json merges; nothing live changes', () => {
  const root = tempDir('nep-replay-skills-');
  const tmpDir = tempDir('nep-replay-skills-layers-');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('config.json', JSON.stringify({ features: { skills: true } }));
  write('prompts/reply.md', 'tracked reply');
  write('prompts/format.md', 'tracked format');
  write('prompts/labels.json', JSON.stringify({ transcript: { author: '{name}' }, task: { queued: 'tracked queued' } }));
  const localLabels = JSON.stringify({ task: { queued: 'local queued', queuedOthers: 'local others' } });
  write('prompts.local/reply.md', 'local réply');
  write('prompts.local/format.md', 'local format');
  write('prompts.local/labels.json', localLabels);
  write('side-a/reply.md', 'réply A');
  write('side-a/labels.json', JSON.stringify({ task: { queued: 'queued A' } }));
  write('side-b/format.md', 'format B');
  const opened = [];
  try {
    const a = overlayPromptsHot(createHot, root, 'side-a', { mergeJson: deepMerge, tmpDir });
    opened.push(a);
    assert.equal(a.hot.prompts.reply, 'réply A', 'a file of the directory replaces the private one');
    assert.equal(a.hot.prompts.format, 'local format', 'a file it lacks stays the private one');
    assert.deepEqual(a.hot.prompts.labels.task, { queued: 'queued A', queuedOthers: 'local others' }, 'labels.json merges over the private one');
    assert.equal(a.hot.prompts.labels.transcript.author, '{name}', 'and over the tracked one, as hot.js merges');
    const b = overlayPromptsHot(createHot, root, 'side-b', { mergeJson: deepMerge, tmpDir });
    opened.push(b);
    assert.deepEqual([b.hot.prompts.reply, b.hot.prompts.format, b.hot.prompts.labels.task.queued], ['local réply', 'format B', 'local queued']);
    // The diary's --prompts keeps its layering: a labels.json of the directory replaces the private one whole.
    const diary = overlayPromptsHot(createHot, root, 'side-a', { tmpDir });
    opened.push(diary);
    assert.deepEqual(diary.hot.prompts.labels.task, { queued: 'queued A' });
    // The live layer is untouched.
    assert.equal(fs.readFileSync(path.join(root, 'prompts.local', 'labels.json'), 'utf8'), localLabels);
    assert.equal(fs.readFileSync(path.join(root, 'prompts.local', 'reply.md'), 'utf8'), 'local réply');
    assert.throws(() => overlayPromptsHot(createHot, root, 'missing', { mergeJson: deepMerge, tmpDir }), /missing is not a directory/);
  } finally {
    for (const side of opened) {
      side.hot.close();
      fs.rmSync(side.dir, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // The flags: one layer or a pair, with --skills only, never both.
  assert.equal(parseArgs(['--skills', 's.json', '--prompts', 'cand']).prompts, 'cand');
  assert.deepEqual(parseArgs(['--skills', 's.json', '--pair-prompts', 'a', 'b', '--spend', '2']).pairPrompts, ['a', 'b']);
  assert.equal(parseArgs(['--skills', 's.json']).pairPrompts, null);
  assert.throws(() => parseArgs(['--skills', 's.json', '--prompts', 'c', '--pair-prompts', 'a', 'b']), /usage/);
  assert.throws(() => parseArgs(['--skills', 's.json', '--pair-prompts', 'a']), /usage/);
  assert.throws(() => parseArgs(['--pair-prompts', 'a', 'b', '123456789012345678', '223456789012345678']), /usage/);
  assert.throws(() => parseArgs(['--diary', 'picture', '--pair-prompts', 'a', 'b']), /usage/);
});

/** A link at `link` to the directory `target`: a symlink, else (Windows without the privilege) a junction; null when neither can be made. */
function linkDir(target, link) {
  for (const type of process.platform === 'win32' ? ['dir', 'junction'] : ['dir']) {
    try {
      fs.symlinkSync(target, link, type);
      return type;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(err?.code)) throw err;
    }
  }
  return null;
}

test('replay --skills --prompts: a prompts.local/ that links to the live layer is read through the link and copied; nothing is linked into or written to it', (t) => {
  const root = tempDir('nep-replay-skills-');
  const live = tempDir('nep-replay-skills-live-');
  const tmpDir = tempDir('nep-replay-skills-layers-');
  const opened = [];
  try {
    if (!linkDir(live, path.join(root, 'prompts.local'))) {
      t.skip('this platform makes no directory link without privileges');
      return;
    }
    const write = (dir, rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write(root, 'config.json', JSON.stringify({ features: { skills: true } }));
    write(root, 'prompts/reply.md', 'tracked reply');
    write(root, 'prompts/labels.json', JSON.stringify({ task: { queued: 'tracked queued' } }));
    const liveLabels = JSON.stringify({ task: { queued: 'live queued', queuedOthers: 'live others' } });
    write(live, 'reply.md', 'live réply');
    write(live, 'labels.json', liveLabels);
    write(root, 'side-a/labels.json', JSON.stringify({ task: { queued: 'queued A' } }));
    write(root, 'side-a/format.md', 'format A');
    const listing = () => fs.readdirSync(live).sort();
    const before = listing();
    for (const mergeJson of [deepMerge, null]) {
      const side = overlayPromptsHot(createHot, root, 'side-a', { mergeJson, tmpDir });
      opened.push(side);
      assert.equal(side.hot.prompts.reply, 'live réply', 'the live layer is read through the link');
      assert.equal(side.hot.prompts.format, 'format A');
      assert.deepEqual(side.hot.prompts.labels.task, mergeJson ? { queued: 'queued A', queuedOthers: 'live others' } : { queued: 'queued A' });
      const local = path.join(side.dir, 'prompts.local');
      assert.equal(fs.lstatSync(local).isSymbolicLink(), false, 'the scratch layer is a copy, not a link');
      for (const name of fs.readdirSync(local)) assert.equal(fs.lstatSync(path.join(local, name)).isSymbolicLink(), false, name);
    }
    assert.deepEqual(listing(), before, 'nothing is added to the live layer');
    assert.equal(fs.readFileSync(path.join(live, 'labels.json'), 'utf8'), liveLabels);
    assert.equal(fs.readFileSync(path.join(live, 'reply.md'), 'utf8'), 'live réply');
  } finally {
    for (const side of opened) {
      side.hot.close();
      fs.rmSync(side.dir, { recursive: true, force: true });
    }
    // The link first, so removing the root never reaches into the live directory.
    const link = path.join(root, 'prompts.local');
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    for (const dir of [root, live, tmpDir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderPairReport: per scenario the decisions of A and B side by side, the first declines, then each decision\'s messages and the start of her think', () => {
  const record = (side, run, step, decision, text, extra = {}) => ({
    scenario: 'seq', side, run, step, decision, skill: decision === 'call' ? 'rule.add' : null, args: decision === 'call' ? { body: 'κανόνας' } : null, extraCalls: 0,
    verdict: decision === 'call' ? { stage: 'gateway', ok: true } : null, executed: null, result: null,
    first: { messages: [text], reactions: [], gif: null, draw: null, skip: false, think: `${side} ${'σκέψη '.repeat(80)}` }, followUp: null,
    tokens: { prompt: 10, completion: 1 }, cost: 0.01, ...extra,
  });
  const a = [record('A', 1, 1, 'call', 'α1'), record('A', 1, 2, 'call', 'α2', { followUp: { messages: ['έγινε'], reactions: [], gif: null, draw: null, skip: false, think: '' } }), record('A', 1, 3, 'no-call', 'α3')];
  const b = [record('B', 1, 1, 'call', 'β1'), record('B', 1, 2, 'no-call', 'β2'), record('B', 1, 3, 'no-call', 'β3')];
  const steps = [1, 2, 3].map(() => ({ messages: [{ author: OWNER, text: 'α' }], own: true, gapMinutes: 1, result: null }));
  const single = { id: 'one', channelId: HERE, author: MEMBER, text: 'Γεια | σου', discovery: 'inventory' };
  const oneA = [1, 2].map((run) => ({ ...record('A', run, 1, run === 1 ? 'call' : 'no-call', `x${run}`), step: undefined }));
  const report = renderPairReport([
    { scenario: { id: 'seq', steps, discovery: 'inventory' }, grantNames: ['rule.add'], sides: { A: { records: a, summary: sequenceSummary(a, 3) }, B: { records: b, summary: sequenceSummary(b, 3) } } },
    { scenario: single, grantNames: [], sides: { A: { records: oneA, summary: scenarioSummary(oneA) }, B: { records: [], summary: null, error: 'boom' } } },
  ], { a: '/cand/A', b: '/cand/B' });
  assert.ok(report.startsWith('# Skill scenarios: prompt layers A and B'), report);
  assert.ok(report.includes('A: /cand/A') && report.includes('B: /cand/B'));
  assert.ok(report.includes('| seq | 1 | `CCN` | `CNN` | 3 | 2 | 0.0300 | 0.0300 |'), report);
  assert.ok(report.includes('| one | 2 | `C N` | failed: boom | - 1 | - | 0.0200 | - |'), report);
  assert.ok(report.includes('#### step 2'), report);
  assert.ok(report.includes('| decision | call `rule.add` {"body":"κανόνας"} (passed) | no call |'), report);
  assert.ok(report.includes('| messages | α2 | β2 |'), report);
  assert.ok(report.includes('| after the result | έγινε | - |'), report);
  const think = report.split('\n').find((line) => line.startsWith('| think | A '));
  const [, cellA] = think.split(' | ');
  assert.ok(cellA.endsWith('...') && cellA.length <= 303, 'the first 300 characters of her think');
  assert.ok(report.includes('> Γεια | σου'), 'the single message quoted');
});
