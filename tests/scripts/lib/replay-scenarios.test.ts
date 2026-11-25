// Tests for the task-result scenario of scripts/replay.ts's skill scenarios (`--skills`, `taskResult`): its place in
// the scenario file and the errand it hands the turn an errand's end opens, as the store keeps a finished task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScenarios,
  scenarioTask,
  scenarioTaskId,
  scenarioTurns,
  personaGrantsConfig,
  scenarioGrants,
} from '../../../scripts/lib/replay-scenarios.ts';
import { asRecord } from '../../fixtures/records.ts';
import fs from 'node:fs';
import { expandPersonaGrant } from '../../../src/tools/operations/access.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';
import '../../../src/tools/operations/index.ts';

const MEMBER = '100000000000000007';
const HERE = '200000000000000001';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);

/** A task-result scenario as the file holds it, with `overrides` on its errand. */
function errandRaw(overrides = {}, scenario = {}) {
  return {
    id: 'errand-1',
    placeId: HERE,
    grants: [],
    taskResult: {
      agent: 'scout',
      goal: 'Βρες το πρόγραμμα των αγώνων',
      state: 'done',
      text: 'Le programme est prêt.',
      files: [{ name: 'programme.pdf', contentType: 'application/pdf', bytes: 2048 }],
      asker: MEMBER,
      ...overrides,
    },
    ...scenario,
  };
}

/** parseScenarios over a JSON array of `items`. */
function load(items: unknown) {
  return parseScenarios(JSON.stringify(items));
}

test('parseScenarios: a taskResult scenario takes the place of author and text; defaults and refusals', () => {
  const [scenario] = load([errandRaw({ text: undefined, files: undefined })]);
  assert.deepEqual(scenario, {
    id: 'errand-1',
    placeId: HERE,
    before: null,
    taskResult: {
      agent: 'scout',
      goal: 'Βρες το πρόγραμμα των αγώνων',
      state: 'done',
      text: '',
      files: [],
      asker: MEMBER,
    },
    grants: [],
    runs: 1,
  });
  const [full] = load([
    errandRaw({ state: 'failed', files: [{ name: 'a.png' }, { name: 'b.csv', contentType: 'text/csv', bytes: 0 }] }),
  ]);
  assert.deepEqual(full.taskResult?.files, [
    { name: 'a.png', contentType: '', bytes: 0 },
    { name: 'b.csv', contentType: 'text/csv', bytes: 0 },
  ]);
  assert.equal(full.taskResult?.state, 'failed');
  assert.equal(scenarioTurns([scenario]), 1, 'one turn');

  const refused = [
    [errandRaw({}, { author: MEMBER }), /taskResult replaces author, text and steps/],
    [errandRaw({}, { steps: [{ author: MEMBER, text: 'α' }] }), /taskResult replaces author, text and steps/],
    [{ ...errandRaw(), taskResult: 'done' }, /taskResult: not an object/],
    [errandRaw({ extra: 1 }), /taskResult: unknown field extra/],
    [errandRaw({ agent: '' }), /agent must be/],
    [errandRaw({ agent: 'w b' }), /agent must be/],
    [errandRaw({ goal: '  ' }), /goal must be/],
    [errandRaw({ state: 'cancelled' }), /state must be "done" or "failed"/],
    [errandRaw({ text: 3 }), /text must be text/],
    [errandRaw({ files: {} }), /files must be a list/],
    [
      errandRaw({ files: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}` })) }),
      /files must be a list of at most 10/,
    ],
    [errandRaw({ files: [{ name: 'a/b' }] }), /file 1: name must be/],
    [errandRaw({ files: [{ name: '..' }] }), /file 1: name must be/],
    [errandRaw({ files: [{ name: 'a', size: 1 }] }), /file 1: unknown field size/],
    [errandRaw({ files: [{ name: 'a' }, { name: 'a' }] }), /file 2: the name is used twice/],
    [errandRaw({ files: [{ name: 'a', bytes: -1 }] }), /file 1: bytes/],
    [errandRaw({ asker: 'x' }), /asker must be a member id/],
  ];
  for (const [raw, message] of refused) assert.throws(() => load([raw]), message);
});

test('scenarioTask: the errand as the store keeps a finished task, the same id every run', () => {
  const [scenario] = load([errandRaw()]);
  const task = scenarioTask(scenario as unknown as Parameters<typeof scenarioTask>[0], { at: NOW });
  assert.match(asRecord(task).id, /^t[0-9a-f]{8}$/);
  assert.equal(asRecord(task).id, scenarioTaskId('errand-1'), 'the same id every run');
  assert.notEqual(scenarioTaskId('errand-2'), asRecord(task).id);
  assert.deepEqual(
    [asRecord(task).agent, asRecord(task).state, asRecord(task).error, asRecord(task).scope, asRecord(task).seen],
    ['scout', 'done', null, 'group', false]
  );
  assert.deepEqual(asRecord(task).requester, { accountId: MEMBER, kind: 'member' });
  assert.deepEqual(asRecord(task).origin, { placeId: HERE, messageId: null });
  assert.equal(
    asRecord(
      scenarioTask(load([errandRaw({ state: 'failed' })])[0] as unknown as Parameters<typeof scenarioTask>[0], {
        at: NOW,
      })
    ).error,
    'failed'
  );
});

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// The example tools are `intention.set`, `intention.list` and `person.link`, since `learning.add`, `rule.list` and
// `lore.add` are no tools of the persona.
const OWNER = '100000000000000042';

const SELF = '100000000000000001';

/** A scenario as the file holds it, with `overrides`. */
function raw(overrides = {}) {
  return {
    id: 's-1',
    placeId: HERE,
    author: MEMBER,
    text: 'Μπορείς να προσθέσεις έναν κανόνα;',
    grants: [],
    ...overrides,
  };
}

test('parseScenarios: the example file loads; omitted fields take their defaults', () => {
  const example = parseScenarios(
    fs.readFileSync(new URL('../../../scripts/fixtures/skill-scenarios.example.json', import.meta.url), 'utf8')
  );
  assert.ok(example.length >= 3);
  for (const scenario of example) assert.ok(/^[A-Za-z0-9._-]+$/.test(scenario.id));
  const [scenario] = load([raw()]);
  assert.deepEqual(scenario, {
    id: 's-1',
    placeId: HERE,
    before: null,
    author: MEMBER,
    text: 'Μπορείς να προσθέσεις έναν κανόνα;',
    grants: [],
    runs: 1,
  });
  // A scenario names no canned `result` and no `discovery`, since every scenario turn runs on the turn runner,
  // whose kept calls answer as done and whose classifiers pick the persona's skills. The fields are refused as unknown.
  const [full] = load([
    raw({
      before: '300000000000000001',
      grants: [' intention.set ', '*'],
      runs: 3,
    }),
  ]);
  assert.deepEqual([full.before, full.grants, full.runs], ['300000000000000001', ['intention.set', '*'], 3]);
});

test('parseScenarios: a malformed file or scenario is refused, naming the scenario', () => {
  assert.throws(() => parseScenarios('{'), /not JSON/);
  assert.throws(() => parseScenarios('[]'), /non-empty JSON array/);
  assert.throws(() => parseScenarios('{"id":"a"}'), /non-empty JSON array/);
  const refused = [
    [{ ...raw(), extra: 1 }, /unknown field extra/],
    [raw({ id: 'ένα' }), /id must be/],
    [raw({ placeId: '12' }), /placeId/],
    [raw({ before: 'x' }), /before/],
    [raw({ author: '' }), /author/],
    [raw({ text: '   ' }), /text/],
    [raw({ grants: 'intention.set' }), /grants/],
    [raw({ grants: [''] }), /grants/],
    [raw({ runs: 0 }), /runs/],
    [raw({ runs: 11 }), /runs/],
    [raw({ runs: 1.5 }), /runs/],
    [raw({ result: 'x' }), /unknown field result/],
    [raw({ discovery: 'inventory' }), /unknown field discovery/],
  ];
  for (const [scenario, message] of refused) assert.throws(() => load([scenario]), message);
  assert.throws(() => load([raw(), raw()]), /scenario 2 \(s-1\): the id is used twice/);
});

test('scenarioGrants: expanded as /nep access grant expands them for the persona; a not-grantable name kept; an unknown one refused', () => {
  const names = scenarioGrants(
    { id: 's', grants: ['intention.set', '*', 'memory.restore', 'intention.set'] },
    expandPersonaGrant
  );
  assert.equal(names[0], 'intention.set');
  assert.equal(names.filter((name) => name === 'intention.set').length, 1, 'de-duplicated');
  assert.ok(names.includes('intention.list'), "`*` is the persona's read skills");
  assert.ok(!names.includes('rule.remove'), '`*` opens no write');
  assert.ok(names.includes('memory.restore'), 'kept, so the gateway refuses it as live');
  assert.throws(
    () => scenarioGrants({ id: 's', grants: ['files.wipe'] }, expandPersonaGrant),
    /scenario s: grants names no skill: files.wipe/
  );
});

test("personaGrantsConfig: the persona's grants are exactly the given ones; people's grants and the live config untouched", () => {
  const live = {
    tools: { safeMode: false },
    bot: {
      ownerPerson: OWNER_PERSON,
      access: {
        'intention.list': { everyone: false, roles: [], users: [SELF, MEMBER] },
        'person.link': { everyone: false, roles: [], users: [SELF] },
      },
    },
  };
  const before = structuredClone(live);
  const copy = personaGrantsConfig(live, SELF, ['intention.set', 'memory.restore']);
  assert.deepEqual(live, before, 'the live config is never written');
  const access = copy.bot.access;
  assert.deepEqual(access['intention.list'].users, [MEMBER]);
  assert.equal(access['person.link'], undefined, 'an entry left empty is gone');
  assert.deepEqual(access['intention.set'].users, [SELF]);
  assert.deepEqual(access['memory.restore'].users, [SELF]);
  assert.equal(copy.bot.ownerPerson, OWNER_PERSON);
  assert.deepEqual(personaGrantsConfig({}, SELF, []).bot.access, {});
});

// ---- multi-step scenarios ---------------------------------------------------------

const OTHER = '100000000000000009';

test('parseScenarios: steps take the place of author and text; a burst adds messages by their own authors; defaults and refusals', () => {
  const [scenario] = load([
    {
      id: 'seq',
      placeId: HERE,
      grants: [],
      steps: [
        { author: OWNER, text: 'α' },
        { author: MEMBER, text: 'β', gapMinutes: 2.5, burst: [{ author: OTHER, text: 'γ' }] },
        {
          burst: [
            { author: MEMBER, text: 'δ' },
            { author: OWNER, text: 'ε' },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(scenario, {
    id: 'seq',
    placeId: HERE,
    before: null,
    grants: [],
    runs: 1,
    steps: [
      { messages: [{ author: OWNER, text: 'α' }], own: true, gapMinutes: 1 },
      {
        messages: [
          { author: MEMBER, text: 'β' },
          { author: OTHER, text: 'γ' },
        ],
        own: true,
        gapMinutes: 2.5,
      },
      {
        messages: [
          { author: MEMBER, text: 'δ' },
          { author: OWNER, text: 'ε' },
        ],
        own: false,
        gapMinutes: 1,
      },
    ],
  });
  const step = (overrides: Record<string, unknown>) => ({
    id: 's',
    placeId: HERE,
    grants: [],
    steps: [{ author: OWNER, text: 'α', ...overrides }],
  });
  const refused = [
    [{ ...step({}), author: OWNER }, /steps replace author and text/],
    [{ id: 's', placeId: HERE, grants: [], steps: [] }, /steps must be a list of 1\.\.20/],
    [
      { id: 's', placeId: HERE, grants: [], steps: Array.from({ length: 21 }, () => ({ author: OWNER, text: 'α' })) },
      /steps must be/,
    ],
    [step({ extra: 1 }), /step 1: unknown field extra/],
    [step({ author: 'x' }), /step 1: the message: author must be a member id/],
    [{ id: 's', placeId: HERE, grants: [], steps: [{ gapMinutes: 2 }] }, /step 1: needs author and text, or a burst/],
    [step({ burst: [] }), /burst must be a list of 1\.\.10/],
    [step({ burst: [{ author: OTHER, text: 'γ', gapMinutes: 1 }] }), /burst 1: unknown field gapMinutes/],
    [step({ burst: [{ author: 'x', text: 'γ' }] }), /burst 1: author/],
    [step({ gapMinutes: 0 }), /gapMinutes/],
    [step({ gapMinutes: '1' }), /gapMinutes/],
    [step({ result: 'x' }), /step 1: unknown field result/],
  ];
  for (const [scenarioRaw, message] of refused) assert.throws(() => load([scenarioRaw]), message);
});

test('parseScenarios: a seeded line of the persona, a step { self } or a burst item { self: true }, and its refusals', () => {
  const [scenario] = load([
    {
      id: 'seq',
      placeId: HERE,
      grants: [],
      steps: [
        { author: OWNER, text: 'α' },
        { self: 'γιατί;', gapMinutes: 0.5 },
        {
          author: OWNER,
          text: 'β',
          burst: [
            { self: true, text: 'καλά' },
            { author: MEMBER, text: 'γ' },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(scenario.steps, [
    { messages: [{ author: OWNER, text: 'α' }], own: true, gapMinutes: 1 },
    { messages: [{ self: true, text: 'γιατί;' }], own: false, gapMinutes: 0.5 },
    {
      messages: [
        { author: OWNER, text: 'β' },
        { self: true, text: 'καλά' },
        { author: MEMBER, text: 'γ' },
      ],
      own: true,
      gapMinutes: 1,
    },
  ]);
  const steps = (list: unknown) => ({ id: 's', placeId: HERE, grants: [], steps: list });
  const refused = [
    [steps([{ author: OWNER, text: 'α' }, { self: '   ' }]), /step 2: self must be 1\.\.4000 characters/],
    [
      steps([
        { author: OWNER, text: 'α' },
        { self: 'γ', author: OWNER },
      ]),
      /step 2: self takes only gapMinutes/,
    ],
    [
      steps([
        { author: OWNER, text: 'α' },
        { self: 'γ', burst: [{ author: OWNER, text: 'δ' }] },
      ]),
      /step 2: self takes only gapMinutes/,
    ],
    [
      steps([
        { author: OWNER, text: 'α' },
        { self: 'γ', result: 'x' },
      ]),
      // Changed: a step takes no `result` any more, so the field is refused as unknown before the seeded line is read.
      /step 2: unknown field result/,
    ],
    [steps([{ author: OWNER, text: 'α', burst: [{ self: 'yes', text: 'γ' }] }]), /step 1: burst 1: self must be true/],
    [
      steps([{ author: OWNER, text: 'α', burst: [{ self: true, author: OWNER, text: 'γ' }] }]),
      /step 1: burst 1: a line of the persona's has no author/,
    ],
    [steps([{ author: OWNER, text: 'α', burst: [{ self: true }] }]), /step 1: burst 1: text must be/],
    [
      steps([{ self: 'α' }, { burst: [{ self: true, text: 'β' }] }]),
      /needs at least one step that runs the persona's turn/,
    ],
  ];
  for (const [scenarioRaw, message] of refused) assert.throws(() => load([scenarioRaw]), message);
  // The persona's seeded lines run no turn: only the messages that may get a turn count.
  assert.equal(scenarioTurns([scenario]), 3, "three messages not the persona's");
});

test('scenarioTurns: a run is one turn, or every message of every step of every run', () => {
  // Changed: the estimate counts turns, and the spend gate multiplies them by the requests a turn may send, since every
  // scenario turn runs on the turn runner with its own tool loop.
  const [single, multi] = load([
    raw({ id: 'one', runs: 3 }),
    {
      id: 'seq',
      placeId: HERE,
      grants: [],
      runs: 2,
      steps: [
        { author: OWNER, text: 'α' },
        { author: OWNER, text: 'β' },
        {
          burst: [
            { author: MEMBER, text: 'γ' },
            { author: OTHER, text: 'δ' },
          ],
        },
      ],
    },
  ]);
  assert.equal(scenarioTurns([single]), 3);
  assert.equal(scenarioTurns([multi]), 8, 'four messages x two runs: every message of a burst may get its own turn');
  assert.equal(scenarioTurns([single, multi]), 11);
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);
