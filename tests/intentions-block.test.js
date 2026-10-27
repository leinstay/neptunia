// Tests for the persona's view of her intentions: the `<intentions>` block's body
// (src/intentions/blocks.js) -- her active ones with their wait, due time and outcome, then the
// candidates with the line they came from, cut to the token budget -- and the switch that hides
// the `intention.*` skills from her entirely while features.intentions is off (src/tools/access.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentionsBlockText } from '../src/intentions/blocks.js';
import { createIntention, transition, waitOn } from '../src/intentions/model.js';
import { formatClock, formatDate } from '../src/format.js';
import '../src/tools/impl/index.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { checkSkill, listSkills } from '../src/tools/gateway.ts';
import { grantedSkillNames, skillsIndex } from '../src/tools/discovery.ts';

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
    every: 'each {period}',
    waiting: 'wait {errand} until {deadline}',
    outcome: 'got {errand} {state}',
    notes: { 'wait-deadline': 'ran out {errand}' },
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
  const back = transition(waitOn(own('i3'), { taskId: 't8', deadline: T0 + HOUR, now: T0 }).intention, 'pending', {
    now: T0 + HOUR,
    patch: { note: 'wait-deadline' },
  }).intention;
  const candidate = createIntention({
    purpose: 'φέρε το',
    provenance: { kind: 'candidate', span: 'θα το φέρω' },
    now: T0,
    id: 'i4',
  }).intention;
  const daily = own('i5', { dueAt: T0 + 2 * HOUR, every: { period: 'day', at: '12:00' } });
  const text = intentionsBlockText([pending, daily, back, waiting, candidate], LABELS, {
    channelNameOf: (id) => (id === 'c9' ? 'γενικά' : null),
  });
  assert.equal(
    text,
    [
      'H',
      `i1|P|σκοπός i1 · due ${at(T0 + HOUR)} · to #γενικά`,
      `i5|P|σκοπός i5 · due ${at(T0 + 2 * HOUR)} · each day`,
      'i3|P|σκοπός i3 · ran out t8',
      `i2|W|σκοπός i2 · wait t7 until ${at(T0 + 2 * HOUR)}`,
      'C',
      'i4|φέρε το|"θα το φέρω"',
    ].join('\n')
  );
  // Without the every label a recurring line shows its due time alone.
  assert.equal(
    intentionsBlockText([daily], { intentions: { ...LABELS.intentions, every: undefined } }),
    `H\ni5|P|σκοπός i5 · due ${at(T0 + 2 * HOUR)}`
  );
});

test("intentionsBlockText: an attention shows its place, the day's wakes against her bound, the settle and the people by name", () => {
  const attention = own('i6', { attend: { place: 'c9', people: ['u1', 'u2'], settle: 30, perDay: 4 } });
  const counted = { ...attention, attend: { ...attention.attend, today: { day: '2026-10-18', wakes: 2 } } };
  const labels = {
    intentions: { ...LABELS.intentions, attend: 'in #{place} {wakes}/{perDay} q{settle}', attendPeople: 'of {people}' },
  };
  const text = intentionsBlockText([counted, own('i7', { attend: { place: 'c8' } })], labels, {
    channelNameOf: (id) => (id === 'c9' ? 'κήπος' : null),
    nameOf: (id) => (id === 'u1' ? 'Ana' : null),
  });
  assert.equal(
    text,
    ['H', 'i6|P|σκοπός i6 · in #κήπος 2/4 q30 · of Ana, u2', 'i7|P|σκοπός i7 · in #c8 0/12 q90'].join('\n')
  );
  assert.equal(
    intentionsBlockText([counted], LABELS),
    'H\ni6|P|σκοπός i6',
    'without the attend labels the line stands alone'
  );
});

test('intentionsBlockText: an external candidate carries labels.intentions.externalMarker as {marker}; her own carries none', () => {
  const labels = {
    intentions: { ...LABELS.intentions, candidate: '{id}|{purpose}|"{span}"{marker}', externalMarker: ' [ξένο]' },
  };
  const ownCandidate = createIntention({
    purpose: 'φέρε το',
    provenance: { kind: 'candidate', span: 'θα το φέρω', origin: 'own' },
    now: T0,
    id: 'i1',
  }).intention;
  const external = createIntention({
    purpose: 'άνοιξε',
    provenance: { kind: 'candidate', span: 'άνοιξε τη σελίδα', origin: 'external', originReason: 'read' },
    now: T0,
    id: 'i2',
  }).intention;
  assert.equal(
    intentionsBlockText([ownCandidate, external], labels),
    ['H', 'C', 'i1|φέρε το|"θα το φέρω"', 'i2|άνοιξε|"άνοιξε τη σελίδα" [ξένο]'].join('\n')
  );
  // Without the marker label an external candidate's line stays whole, with nothing in the slot.
  const bare = { intentions: { ...labels.intentions, externalMarker: undefined } };
  assert.equal(intentionsBlockText([external], bare), 'H\nC\ni2|άνοιξε|"άνοιξε τη σελίδα"');
});

test('intentionsBlockText: an intention with no due time and no wait says so with its expiry; every line past the notice window shows its expiry; neither without its label', () => {
  const DAY = 24 * HOUR;
  const labels = {
    intentions: { ...LABELS.intentions, noDue: 'no date, expires {expires}', expiresSoon: 'expires {when}' },
  };
  const dateless = own('i1');
  const dated = own('i2', { dueAt: T0 + HOUR });
  // Dateless: the no-date part in the due slot, with its expiry (14 days by default: far from the notice window).
  assert.equal(
    intentionsBlockText([dateless, dated], labels, { now: T0 }),
    ['H', `i1|P|σκοπός i1 · no date, expires ${at(T0 + 14 * DAY)}`, `i2|P|σκοπός i2 · due ${at(T0 + HOUR)}`].join('\n')
  );
  // Inside the notice window (2 days by default) a dated line, a waiting one and a recurring one show their expiry at the end.
  const soon = own('i3', { dueAt: T0 + HOUR, expiresAt: T0 + DAY, destination: 'c9' });
  const waiting = waitOn(own('i4', { expiresAt: T0 + 36 * HOUR }), {
    taskId: 't7',
    deadline: T0 + 2 * HOUR,
    now: T0,
  }).intention;
  const daily = own('i5', { dueAt: T0 + 2 * HOUR, every: { period: 'day', at: '12:00' }, expiresAt: T0 + 2 * DAY });
  assert.equal(
    intentionsBlockText([soon, daily, waiting], labels, { now: T0, channelNameOf: () => 'γενικά' }),
    [
      'H',
      `i3|P|σκοπός i3 · due ${at(T0 + HOUR)} · to #γενικά · expires ${at(T0 + DAY)}`,
      `i5|P|σκοπός i5 · due ${at(T0 + 2 * HOUR)} · each day · expires ${at(T0 + 2 * DAY)}`,
      `i4|W|σκοπός i4 · wait t7 until ${at(T0 + 2 * HOUR)} · expires ${at(T0 + 36 * HOUR)}`,
    ].join('\n')
  );
  // The window is the setting: with one day only the 36-hour one is outside it; a dateless line inside it carries its expiry once.
  const near = own('i6', { expiresAt: T0 + 12 * HOUR });
  assert.equal(
    intentionsBlockText([waiting, near], labels, { now: T0, expiryNoticeDays: 1 }),
    [
      'H',
      `i4|W|σκοπός i4 · wait t7 until ${at(T0 + 2 * HOUR)}`,
      `i6|P|σκοπός i6 · no date, expires ${at(T0 + 12 * HOUR)}`,
    ].join('\n')
  );
  // An attention has no due time by design and is not dateless; a candidate's line is never touched.
  const attention = own('i7', { attend: { place: 'c9' } });
  const candidate = createIntention({
    purpose: 'x',
    provenance: { kind: 'candidate', span: 'y' },
    now: T0,
    id: 'i8',
  }).intention;
  assert.equal(
    intentionsBlockText([attention, candidate], labels, { now: T0 }),
    ['H', 'i7|P|σκοπός i7', 'C', 'i8|x|"y"'].join('\n')
  );
  // Without the labels the lines stand as before.
  assert.equal(
    intentionsBlockText([dateless, soon], LABELS, { now: T0 }),
    ['H', 'i1|P|σκοπός i1', `i3|P|σκοπός i3 · due ${at(T0 + HOUR)} · to #c9`].join('\n')
  );
});

test('intentionsBlockText: cut to the budget by whole lines, the candidates header only with a candidate under it; nothing without labels', () => {
  const records = [
    own('i1'),
    own('i2'),
    createIntention({ purpose: 'x', provenance: { kind: 'candidate', span: 'y' }, now: T0, id: 'i3' }).intention,
  ];
  const lineCost = () => 10;
  assert.equal(intentionsBlockText(records, LABELS, { maxTokens: 21, cost: lineCost }), 'H\ni1|P|σκοπός i1');
  assert.equal(
    intentionsBlockText(records, LABELS, { maxTokens: 33, cost: lineCost }),
    'H\ni1|P|σκοπός i1\ni2|P|σκοπός i2',
    'no room for the header and a candidate: neither'
  );
  assert.equal(intentionsBlockText(records, LABELS, { maxTokens: 5, cost: lineCost }), '');
  assert.equal(intentionsBlockText(records, {}), '');
  assert.equal(intentionsBlockText([], LABELS), '');
});

function config(features = {}) {
  const access = Object.fromEntries(
    ['intention.set', 'intention.list', 'lore.list'].map((name) => [
      name,
      { everyone: false, roles: [], users: [SELF] },
    ])
  );
  return { bot: { owners: [OWNER], access }, features: { tools: true, ...features } };
}

test('skills: with features.intentions off the intent skills are refused, never listed, never offered; on, they are hers once granted', () => {
  const registry = skillRegistry();
  const audience = { conversationId: 'c1' };
  const call = (cfg) =>
    checkSkill({
      skill: 'intention.set',
      args: { text: 'κάτι' },
      principal: { kind: 'persona' },
      requester: { id: OWNER },
      audience,
      context: { config: cfg, selfId: SELF, registry },
    });
  assert.deepEqual(call(config()), { ok: false, code: 'feature-off', reason: 'intention.set' });
  assert.deepEqual(call(config({ intentions: true })), { ok: true });
  const listed = (cfg) =>
    listSkills({ config: cfg, selfId: SELF, texts: {}, requester: { id: OWNER }, audience, registry }).map(
      (row) => row.name
    );
  assert.equal(
    listed(config()).some((name) => name.startsWith('intention.')),
    false
  );
  assert.equal(listed(config({ intentions: true })).filter((name) => name.startsWith('intention.')).length, 4);
  assert.deepEqual(grantedSkillNames({ config: config(), selfId: SELF, registry }), ['lore.list']);
  assert.deepEqual(grantedSkillNames({ config: config({ intentions: true }), selfId: SELF, registry }), [
    'intention.list',
    'intention.set',
    'lore.list',
  ]);
  // Nobody asked: her own intention is a write, refused like every write of an unasked turn.
  assert.equal(
    checkSkill({
      skill: 'intention.set',
      args: { text: 'κάτι' },
      principal: { kind: 'persona' },
      requester: null,
      audience,
      context: { config: config({ intentions: true }), selfId: SELF, registry },
    }).code,
    'no-requester'
  );
  // The index a classifier reads has every registered skill; the turn filters it by the switch (src/behavior/turn.js).
  assert.ok(skillsIndex(registry, {}).includes('intention.set'));
});
