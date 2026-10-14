// Tests for the skill scenarios of tools/replay.mjs (`--skills`): the scenario loader, the
// persona's grants laid over a copy of the config, and her `<call>` taken through the real
// resolution and the real gateway with the operation never run
// (src/behavior/sandbox.js#simulateCall), and multi-step scenarios played step by step with her
// turns carried into the next step (playSteps, afterScenarioTurn), all against fakes: no
// network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import '../src/ops/index.js';
import { expandPersonaGrant } from '../src/ops/access.js';
import { skillRegistry } from '../src/skills/registry.js';
import { NOT_GRANTABLE_TO_PERSONA } from '../src/skills/access.js';
import { callViewOf, requesterOf } from '../src/behavior/turn.js';
import { fill } from '../src/discord/format.js';
import { afterScenarioTurn, answerSkillScenario, liveView, personaGrantsConfig, scenarioInventory, simulateCall } from '../src/behavior/sandbox.js';
import {
  parseArgs, parseScenarios, playSteps, renderSkillsReport, runRecord, scenarioDiscovery, scenarioGrants, scenarioSummary, scenarioTrigger, sequenceSummary, skillRequestEstimate,
} from '../tools/replay.mjs';
import { labels } from './fixtures/labels.js';

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
  assert.equal(out.followUp, true, 'an operation that answers comes back to her');
});

test('simulateCall: not granted, not grantable, or a requester without the right: refused as live, and she hears it', () => {
  const notGranted = simulate({ skill: 'rule.add', args: {}, body: 'κανόνας' });
  assert.deepEqual([notGranted.verdict.stage, notGranted.verdict.code, notGranted.result.status, notGranted.executed, notGranted.followUp], ['gateway', 'not-allowed', 'denied', null, true]);

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
  assert.deepEqual([unasked.verdict.code, unasked.verdict.reason], ['requester-denied', 'no-requester']);
});

test('simulateCall: her own operations skip the requester\'s right but not her grant; a quiet success needs no follow-up', () => {
  const elsewhere = { skill: 'message.create', args: { channel: '#νέα' }, body: 'καλημέρα' };
  const own = simulate(elsewhere, { grants: ['message.create'], author: MEMBER });
  assert.equal(own.verdict.ok, true, 'self-owned: the member\'s missing right does not matter');
  assert.deepEqual(own.executed, { skill: 'message.create', args: { channel: NEWS, text: 'καλημέρα' } });
  assert.equal(own.followUp, false, 'a message that went out is its own answer');
  assert.equal(simulate(elsewhere, { author: MEMBER }).verdict.code, 'not-allowed', 'another channel still needs her grant');
  assert.equal(simulate({ skill: 'message.create', args: {}, body: 'γεια' }, { author: MEMBER }).verdict.ok, true, 'carried over in the current conversation');
});

test('simulateCall: a call the server cannot resolve, a spent drawing budget, the full stop', () => {
  const unknown = simulate({ skill: 'files.wipe', args: {} });
  assert.deepEqual([unknown.verdict.stage, unknown.verdict.code, unknown.result.status, unknown.followUp], ['resolve', 'unknown-skill', 'invalid', true]);
  const channel = simulate({ skill: 'message.create', args: { channel: '#πουθενά' }, body: 'γεια' }, { grants: ['message.create'] });
  assert.deepEqual([channel.verdict.stage, channel.verdict.code], ['resolve', 'invalid-args']);
  const drawing = { skill: 'draw.create', args: {}, body: 'un chat sur la lune' };
  const spent = simulate(drawing, { images: { quota: () => ({ spent: true, userSpent: false }) } });
  assert.deepEqual([spent.verdict.stage, spent.verdict.code, spent.verdict.reason], ['gateway', 'daily-cap', 'image.maxPerDay']);
  const left = simulate(drawing, { images: { quota: () => ({ spent: false, userSpent: false }) } });
  assert.deepEqual([left.verdict.ok, left.followUp], [true, false], 'a picture that went out is its own answer');
  const off = simulate({ skill: 'rule.add', args: {}, body: 'κανόνας' }, { grants: ['rule.add'], features: { skills: false } });
  assert.deepEqual([off.verdict.code, off.followUp], ['skills-off', false]);
});

test('scenarioInventory: the requester\'s catalogue as live discovery lists it: whole, the named ones, or none', () => {
  const config = scenarioConfig(['rule.add']);
  const texts = { 'rule.add': { title: 'Add a rule', whenToUse: 'when asked' } };
  const input = { config, selfId: SELF, texts, conversationId: HERE, registry: skillRegistry() };
  const whole = scenarioInventory({ ...input, requester: { id: OWNER, roleIds: [] } });
  assert.equal(whole.length, skillRegistry().size);
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
    outcome: { verdict: { stage: 'gateway', ok: false, code: 'not-allowed', reason: 'rule.add' }, executed: null, result: { skill: 'rule.add', status: 'denied', code: 'not-allowed' }, followUp: true },
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
function sequenceConfig(grants, features = {}) {
  return personaGrantsConfig({
    bot: { owners: [OWNER], timezone: 'UTC', access: {} },
    context: {
      channelMessages: 100, maxMessageChars: 800, gapMarkerMinutes: 20, otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    roles: { voice: 'x/chat' },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
    skills: { safeMode: false },
    features: { skills: true, followUpContinuation: true, ...features },
  }, SELF, grants);
}

/** A model that answers `texts` in order and keeps every request it got. */
function scriptedLlm(texts) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      return { text: texts[calls.length - 1] ?? '<skip/>', usage: { prompt_tokens: 100, completion_tokens: 10 } };
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
async function playSequence(rawSteps, texts, { grants = ['message.create', 'rule.add'], history = [] } = {}) {
  const [scenario] = load([{ id: 'seq', channelId: HERE, steps: rawSteps, grants: [], result: 'SCENARIO_RESULT' }]);
  const config = sequenceConfig(grants);
  const hot = { config, prompts: { 'system-prompt': 'SYSTEM', 'character-card': 'CARD', format: 'FORMAT', reply: 'REPLY {{author}}', labels } };
  const store = { getGuild: () => ({}), getUser: () => null, listChannels: () => [{ id: NEWS, name: 'νέα' }], listUserProfiles: () => [], getLore: () => [], state: { data: {} } };
  const view = liveView({ hot, store, guildId: 'g1' });
  const channel = fakeChannel();
  const here = { id: HERE, name: 'γενικά' };
  const llm = scriptedLlm(texts);
  const steps = [];
  const records = [];
  const lineOf = (message, at) => scenarioTrigger({ text: message.text, authorId: message.author, authorName: NAMES[message.author], channel: here, selfId: SELF, at });
  const played = await playSteps({
    scenario, history, firstAt: NOW, runIndex: 0, lineOf,
    answerStep: async ({ situation, trigger, at, callMarks, result }) => {
      const requester = requesterOf(trigger, channel);
      const answered = await answerSkillScenario({
        view, situation, selfId: SELF, selfName: 'Persona', channel: here, llm, runs: 1, at, callMarks,
        onCall: (call, { idByIndex, history: lines }) =>
          simulateCall({
            call,
            view: callViewOf({ channel, guildId: 'g1', idByIndex, lines, pulledIds: new Map(), memoryOn: false, store: null, selfId: SELF, skills: skillRegistry() }),
            config, selfId: SELF, requester, conversationId: HERE, now: at, resultText: result,
          }),
      });
      steps.push({ situation, trigger, at, callMarks, requests: llm.calls.length });
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
      { messages: [{ author: OWNER, text: 'α' }], gapMinutes: 1, result: null },
      { messages: [{ author: MEMBER, text: 'β' }, { author: OTHER, text: 'γ' }], gapMinutes: 2.5, result: 'Résultat' },
      { messages: [{ author: MEMBER, text: 'δ' }, { author: OWNER, text: 'ε' }], gapMinutes: 1, result: null },
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
      '<think>θα το στείλω</think><msg>μια στιγμή</msg><call skill="message.create" channel="#νέα">καλημέρα</call>',
      '<msg>εντάξει</msg><call skill="rule.add">όχι spoilers</call>',
      '<msg>έγινε</msg>',
      '<msg>όχι</msg>',
    ],
  );
  assert.equal(played.stopped, false);
  assert.equal(llm.calls.length, 4, 'step 1 (a post needs no follow-up), step 2 and its follow-up, step 3');
  assert.deepEqual(steps.map((s) => s.requests), [1, 3, 4]);

  // Step 2 reads her step-1 line with the call's mark; the post went to νέα, so its text is not here.
  const second = userOf(llm.calls[1]);
  const createLine = second.split('\n').find((line) => line.includes('μια στιγμή'));
  assert.ok(createLine && createLine.includes(marked('message.create', 'νέα')), second);
  assert.ok(!second.includes('καλημέρα'), 'a post into another channel is not a line here');
  assert.ok(second.indexOf('πρώτο') < second.indexOf('μια στιγμή') && second.indexOf('μια στιγμή') < second.indexOf('δεύτερο'));
  assert.equal(steps[1].callMarks.length, 1);
  assert.equal(steps[1].at, NOW + 1000 + 2 * 60_000, 'two minutes after the newest line: hers, a second after the trigger');

  // The follow-up of step 2 keeps step 1's mark too.
  const followUp = userOf(llm.calls[2]);
  assert.ok(followUp.split('\n').find((line) => line.includes('μια στιγμή'))?.includes(marked('message.create', 'νέα')), followUp);
  assert.ok(followUp.split('\n').find((line) => line.includes('εντάξει'))?.includes(marked('rule.add', 'γενικά')), followUp);

  // Step 3 reads both turns: every line of hers, the rule.add mark on the follow-up's line (the turn's last).
  const third = userOf(llm.calls[3]);
  for (const text of ['μια στιγμή', 'εντάξει', 'έγινε', 'δεύτερο']) assert.ok(third.includes(text), text);
  assert.ok(third.split('\n').find((line) => line.includes('έγινε'))?.includes(marked('rule.add', 'γενικά')), third);
  assert.ok(!third.split('\n').find((line) => line.includes('εντάξει'))?.includes('rule.add'), 'the mark moved to the last line of the turn');
  assert.equal(steps[2].callMarks.length, 2);

  const hers = played.transcript.filter((line) => line.self);
  assert.deepEqual(hers.map((line) => line.content), ['μια στιγμή', 'εντάξει', 'έγινε', 'όχι']);
  assert.ok(hers.every((line) => line.authorId === SELF && /^\d+$/.test(line.id)));
  assert.equal(hers[0].triggerId, steps[0].trigger.id, 'linked to the message that started her turn');
  const times = played.transcript.map((line) => line.ts);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'the channel stays in time order');

  // One record per step, the step number after the run, her whole think kept.
  assert.deepEqual(records.map((r) => [r.run, r.step, r.decision, r.skill]), [[1, 1, 'call', 'message.create'], [1, 2, 'call', 'rule.add'], [1, 3, 'no-call', null]]);
  assert.deepEqual(Object.keys(records[0]).slice(0, 3), ['scenario', 'run', 'step']);
  assert.equal(records[0].first.think, 'θα το στείλω');
  assert.deepEqual([records[0].verdict.ok, records[0].executed.args.channel, records[0].followUp], [true, NEWS, null]);
  assert.deepEqual(records[1].followUp.messages, ['έγινε']);
  assert.deepEqual(played.records, records);
});

test('replay --skills steps: a burst puts every author\'s message in before one decision; its last author is the requester', async () => {
  const { steps, records, llm } = await playSequence(
    [{ burst: [{ author: OWNER, text: 'πρόσθεσε κανόνα' }, { author: MEMBER, text: 'κι εμένα έναν' }] }],
    ['<call skill="rule.add">όχι spoilers</call>', '<msg>όχι από σένα</msg>'],
  );
  assert.equal(steps.length, 1);
  const lines = steps[0].situation.history;
  assert.deepEqual(lines.slice(-2).map((line) => [line.authorId, line.content]), [[OWNER, 'πρόσθεσε κανόνα'], [MEMBER, 'κι εμένα έναν']]);
  assert.equal(lines.at(-1).ts - lines.at(-2).ts, 5000);
  assert.equal(steps[0].trigger.authorId, MEMBER);
  const user = userOf(llm.calls[0]);
  assert.ok(user.includes('Élodie') && user.includes('Zoë') && user.indexOf('πρόσθεσε κανόνα') < user.indexOf('κι εμένα έναν'), user);
  assert.deepEqual([records[0].verdict.code, records[0].verdict.reason], ['requester-denied', 'not-granted'], 'the member who asked last lacks the right');
  assert.deepEqual(records[0].followUp.messages, ['όχι από σένα']);
});

test('afterScenarioTurn: a post the call left here is her line hosting the mark; her reactions and drawing land; the transcript handed in is untouched', () => {
  const here = { id: HERE, name: 'γενικά' };
  const trigger = scenarioTrigger({ text: 'Γεια σου', authorId: MEMBER, authorName: 'Zoë', channel: here, selfId: SELF, at: NOW });
  const answer = { messages: [{ text: 'γεια', replyTo: 1 }], reactions: [{ to: 1, emoji: '👍' }], gif: null, draw: { text: 'un chat', self: false, replyTo: null }, skip: false, think: '' };
  const run = {
    answer, call: { skill: 'message.create', args: {}, body: 'δεύτερο' }, followUp: null,
    outcome: { verdict: { stage: 'gateway', ok: true }, executed: { skill: 'message.create', args: { text: 'δεύτερο' } }, result: { skill: 'message.create', status: 'ok', data: { text: '' } }, followUp: false },
    refs: { idByIndex: new Map([[1, trigger.id]]), handles: null, followUpIdByIndex: null },
  };
  const before = structuredClone(trigger);
  const out = afterScenarioTurn({ transcript: [trigger], callMarks: [], run, at: NOW, selfId: SELF, selfName: 'Persona', channel: here, triggerId: trigger.id, config: {} });
  assert.deepEqual(trigger, before);
  const [first, mine, drawn, posted] = out.transcript;
  assert.deepEqual(first.reactions, [{ emoji: '👍', count: 1, mine: true }]);
  assert.deepEqual([mine.content, mine.replyToId, mine.ts], ['γεια', trigger.id, NOW + 1000]);
  assert.equal(drawn.attachments[0].kind, 'image');
  assert.deepEqual([posted.content, posted.ts, posted.self], ['δεύτερο', NOW + 2000, true]);
  assert.equal(out.callMarks.length, 1);
  assert.deepEqual([out.callMarks[0].postedId, out.callMarks[0].posted], [posted.id, [mine.id, drawn.id, posted.id]]);
  // No call: her lines only, the earlier marks kept, no new one.
  const quiet = afterScenarioTurn({ transcript: [trigger], callMarks: out.callMarks, run: { ...run, call: null, outcome: null }, at: NOW, selfId: SELF, selfName: 'Persona', channel: here, triggerId: trigger.id, config: {} });
  assert.equal(quiet.transcript.length, 3);
  assert.equal(quiet.callMarks.length, 1);
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

test('skillRequestEstimate: up to two requests per decision -- a run, or every step of every run', () => {
  const [single, multi] = load([
    raw({ id: 'one', runs: 3 }),
    { id: 'seq', channelId: HERE, grants: [], runs: 2, steps: [{ author: OWNER, text: 'α' }, { author: OWNER, text: 'β' }, { burst: [{ author: MEMBER, text: 'γ' }, { author: OTHER, text: 'δ' }] }] },
  ]);
  assert.equal(skillRequestEstimate([single]), 6);
  assert.equal(skillRequestEstimate([multi]), 12, 'three steps x two runs x two requests; a burst is one decision');
  assert.equal(skillRequestEstimate([single, multi]), 18);
});
