// Tests for the skill scenarios of tools/replay.mjs (`--skills`): the scenario loader, the
// persona's grants laid over a copy of the config, and her `<call>` taken through the real
// resolution and the real gateway with the operation never run
// (src/behavior/sandbox.js#simulateCall), all against fakes: no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import '../src/ops/index.js';
import { expandPersonaGrant } from '../src/ops/access.js';
import { skillRegistry } from '../src/skills/registry.js';
import { NOT_GRANTABLE_TO_PERSONA } from '../src/skills/access.js';
import { callViewOf, requesterOf } from '../src/behavior/turn.js';
import { personaGrantsConfig, scenarioInventory, simulateCall } from '../src/behavior/sandbox.js';
import { parseArgs, parseScenarios, renderSkillsReport, runRecord, scenarioDiscovery, scenarioGrants, scenarioSummary, scenarioTrigger } from '../tools/replay.mjs';

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
  return personaGrantsConfig({ features: { skills: true, ...features }, skills: { conversations: [], safeMode: false }, bot: { owners: [OWNER], access } }, SELF, grants);
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
