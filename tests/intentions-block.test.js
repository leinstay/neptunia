// Tests for the persona's view of her intentions: the `<intentions>` block's body
// (src/intentions/blocks.js) -- her active ones with their wait, due time and outcome, then the
// candidates with the line they came from, cut to the token budget -- and the switch that hides
// the `intent.*` skills from her entirely while features.intentions is off (src/skills/access.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentionsBlockText } from '../src/intentions/blocks.js';
import { createIntention, transition, waitOn } from '../src/intentions/model.js';
import { formatClock, formatDate } from '../src/format.js';
import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';
import { checkSkill, listSkills } from '../src/skills/gateway.js';
import { grantedSkillNames, skillsIndex } from '../src/skills/discovery.js';

const T0 = Date.parse('2026-10-18T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const SELF = 'self-1';
const OWNER = 'o1';

const LABELS = {
  intentions: {
    header: 'H',
    line: '{id}|{state}|{purpose}',
    states: { pending: 'P', waiting: 'W' },
    due: 'due {when}',
    waiting: 'wait {task} until {deadline}',
    outcome: 'got {task} {state}',
    notes: { 'wait-deadline': 'ran out {task}' },
    destination: 'to #{channel}',
    candidates: 'C',
    candidate: '{id}|{purpose}|"{span}"',
  },
};

function own(id, extra = {}) {
  return createIntention({ purpose: `σκοπός ${id}`, provenance: { kind: 'self' }, now: T0, id, ...extra }).intention;
}

const at = (ts) => `${formatDate(ts, 'UTC')} ${formatClock(ts, 'UTC')}`;

test('intentionsBlockText: active lines with due, wait, outcome and note, then the candidates with their line', () => {
  const pending = own('i1', { dueAt: T0 + HOUR, destination: 'c9' });
  const waiting = waitOn(own('i2'), { taskId: 't7', deadline: T0 + 2 * HOUR, now: T0 }).intention;
  const back = transition(waitOn(own('i3'), { taskId: 't8', deadline: T0 + HOUR, now: T0 }).intention, 'pending', { now: T0 + HOUR, patch: { note: 'wait-deadline' } }).intention;
  const candidate = createIntention({ purpose: 'φέρε το', provenance: { kind: 'candidate', span: 'θα το φέρω' }, now: T0, id: 'i4' }).intention;
  const text = intentionsBlockText([pending, back, waiting, candidate], LABELS, { channelNameOf: (id) => (id === 'c9' ? 'γενικά' : null) });
  assert.equal(text, [
    'H',
    `i1|P|σκοπός i1 · due ${at(T0 + HOUR)} · to #γενικά`,
    'i3|P|σκοπός i3 · ran out t8',
    `i2|W|σκοπός i2 · wait t7 until ${at(T0 + 2 * HOUR)}`,
    'C',
    'i4|φέρε το|"θα το φέρω"',
  ].join('\n'));
});

test('intentionsBlockText: cut to the budget by whole lines, the candidates header only with a candidate under it; nothing without labels', () => {
  const records = [own('i1'), own('i2'), createIntention({ purpose: 'x', provenance: { kind: 'candidate', span: 'y' }, now: T0, id: 'i3' }).intention];
  const lineCost = () => 10;
  assert.equal(intentionsBlockText(records, LABELS, { maxTokens: 21, cost: lineCost }), 'H\ni1|P|σκοπός i1');
  assert.equal(intentionsBlockText(records, LABELS, { maxTokens: 33, cost: lineCost }), 'H\ni1|P|σκοπός i1\ni2|P|σκοπός i2', 'no room for the header and a candidate: neither');
  assert.equal(intentionsBlockText(records, LABELS, { maxTokens: 5, cost: lineCost }), '');
  assert.equal(intentionsBlockText(records, {}), '');
  assert.equal(intentionsBlockText([], LABELS), '');
});

function config(features = {}) {
  const access = Object.fromEntries(['intent.set', 'intent.list', 'lore.list'].map((name) => [name, { everyone: false, roles: [], users: [SELF] }]));
  return { bot: { owners: [OWNER], access }, features: { skills: true, ...features } };
}

test('skills: with features.intentions off the intent skills are refused, never listed, never offered; on, they are hers once granted', () => {
  const registry = skillRegistry();
  const audience = { conversationId: 'c1' };
  const call = (cfg) => checkSkill({ skill: 'intent.set', args: { text: 'κάτι' }, principal: { kind: 'persona' }, requester: { id: OWNER }, audience, context: { config: cfg, selfId: SELF, registry } });
  assert.deepEqual(call(config()), { ok: false, code: 'feature-off', reason: 'intent.set' });
  assert.deepEqual(call(config({ intentions: true })), { ok: true });
  const listed = (cfg) => listSkills({ config: cfg, selfId: SELF, texts: {}, requester: { id: OWNER }, audience, registry }).map((row) => row.name);
  assert.equal(listed(config()).some((name) => name.startsWith('intent.')), false);
  assert.equal(listed(config({ intentions: true })).filter((name) => name.startsWith('intent.')).length, 4);
  assert.deepEqual(grantedSkillNames({ config: config(), selfId: SELF, registry }), ['lore.list']);
  assert.deepEqual(grantedSkillNames({ config: config({ intentions: true }), selfId: SELF, registry }), ['intent.list', 'intent.set', 'lore.list']);
  // Nobody asked: her own intention is a write, refused like every write of an unasked turn.
  assert.equal(checkSkill({ skill: 'intent.set', args: { text: 'κάτι' }, principal: { kind: 'persona' }, requester: null, audience, context: { config: config({ intentions: true }), selfId: SELF, registry } }).code, 'requester-denied');
  // The index a classifier reads has every registered skill; the turn filters it by the switch (src/behavior/turn.js).
  assert.ok(skillsIndex(registry, {}).includes('intent.set'));
});
