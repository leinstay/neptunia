// Tests for skills discovery (src/tools/discovery.ts) and the `skills:` line it adds to the
// search classifier's answer: the parser reads it and leaves every other line
// as it was, the classifiers' list of skills is static and grouped by family, safe mode, and
// the catalogue view listing owner-only skills too (they run for an owner who asks).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ARG_VALUES,
  MAX_PROPOSED,
  byFamily,
  describeRows,
  exposedSkillNames,
  grantedSkillNames,
  parseSkillsLines,
  proposalVerdicts,
  skillArgs,
  skillsIndex,
  takeSkillsLines,
} from '../src/tools/discovery.ts';
import '../src/tools/operations/index.ts';
import { loadSkills, skillNames, skillRegistry } from '../src/tools/registry.ts';
import { listSkills } from '../src/tools/gateway.ts';
import type { Rights } from '../src/tools/types.ts';
import { parseQueryPlan } from '../src/behavior/query-builder.ts';
import { queryAnswer } from './fixtures/query-answer.ts';
import { OWNER_PERSON, ownedBy } from './fixtures/owner-accounts.ts';
import { chainsOf, chainsOnDefaults } from './fixtures/chains.ts';

const NAMES = ['message.create', 'message.edit', 'draw.create', 'memory.profile.read', 'status.show'];
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

// A stand-in skill names no operation with `op: null`, which the loader reads as none; its input type says `undefined`.
type SkillInputs = Parameters<typeof loadSkills>[0];
type SkillMap = ReturnType<typeof loadSkills>;
const standIns = (specs: ReadonlyArray<object>): SkillMap => loadSkills(specs as SkillInputs);

/** Stand-in skills (no operation behind them, so no rights to check): a registry that needs no ops. */
function standInRegistry() {
  const names = [
    'message.create',
    'message.edit',
    'message.delete',
    'message.react.add',
    'message.react.remove',
    'lore.list',
    'access.list',
  ];
  return standIns(
    names.map((name) => ({
      name,
      op: null,
      argsSchema: { type: 'object' },
      effects: name.endsWith('.list') ? 'read' : 'write',
      costClass: 'free',
      targets: null,
    }))
  );
}

/** `cfg` with `names` granted to the persona (her user id, `self-1`). */
function granting(names: Array<string>, cfg: Record<string, unknown> & { bot?: object }) {
  return {
    ...cfg,
    bot: {
      ...cfg.bot,
      access: Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-1'] }])),
    },
  };
}

test('parseSkillsLines: missing, none, inventory, named, invalid', () => {
  assert.deepEqual(parseSkillsLines([], NAMES), { state: 'missing', inventory: false, names: [] });
  assert.deepEqual(parseSkillsLines(['none'], NAMES), { state: 'none', inventory: false, names: [] });
  assert.deepEqual(parseSkillsLines(['`None.`'], NAMES), { state: 'none', inventory: false, names: [] });
  assert.deepEqual(parseSkillsLines(['Inventory'], NAMES), { state: 'inventory', inventory: true, names: [] });
  assert.deepEqual(
    parseSkillsLines(['draw, inventory'], NAMES),
    { state: 'inventory', inventory: true, names: [] },
    'inventory wins'
  );
  assert.deepEqual(parseSkillsLines(['"Draw.create", message.edit, draw.create, café, memory.profile.read.'], NAMES), {
    state: 'named',
    inventory: false,
    names: ['draw.create', 'message.edit', 'memory.profile.read'],
  });
  assert.deepEqual(
    parseSkillsLines(['ζωγραφική, café'], NAMES),
    { state: 'invalid', inventory: false, names: [] },
    'no known name'
  );
  assert.deepEqual(
    parseSkillsLines(['draw', 'draw'], NAMES),
    { state: 'invalid', inventory: false, names: [] },
    'two lines'
  );
});

test('parseSkillsLines: at most four names, in the order given', () => {
  const picked = parseSkillsLines([NAMES.slice().reverse().join(', ')], NAMES);
  assert.equal(MAX_PROPOSED, 4);
  assert.deepEqual(picked.names, NAMES.slice().reverse().slice(0, 4));
  // Without a list of names given: the registry's own names.
  assert.deepEqual(parseSkillsLines(['status.show, x.unknown']).names, ['status.show']);
  assert.ok(skillNames().includes('status.show'));
});

test('takeSkillsLines: splits the skills lines out, the rest unchanged', () => {
  assert.deepEqual(takeSkillsLines('web: Αθήνα\n- **skills:** inventory\nhistory: κουνέλι'), {
    rest: 'web: Αθήνα\nhistory: κουνέλι',
    values: ['inventory'],
  });
  assert.deepEqual(takeSkillsLines('none'), { rest: 'none', values: [] });
});

// The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
test('parseQueryPlan: answers without a skills line read as before, with no skills key', () => {
  for (const raw of [
    queryAnswer({}),
    queryAnswer({ web: 'champions final' }),
    queryAnswer({ web: 'Αθήνα', history: 'κουνέλι' }),
    '',
    queryAnswer({ history: 'none' }),
  ]) {
    const parsed = parseQueryPlan(raw, { now: NOW });
    assert.equal('skills' in parsed, false, raw);
  }
});

// The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
test('parseQueryPlan: a skills line is read apart; the other lines read exactly as without it', () => {
  const lines = { web: 'Αθήνα σήμερα', history: 'κουνέλι, κουνελιού', when: '2026-10-01 .. 2026-10-03' };
  const without = parseQueryPlan(queryAnswer(lines), { now: NOW });
  const withSkills = parseQueryPlan(queryAnswer({ ...lines, skills: 'draw.create, message.edit' }), {
    now: NOW,
    skillNames: NAMES,
  });
  assert.deepEqual({ web: withSkills.web, history: withSkills.history, reason: withSkills.reason }, without);
  assert.deepEqual(withSkills.skills, { state: 'named', inventory: false, names: ['draw.create', 'message.edit'] });

  // The old single-line shape is unparsed, its skills line with it.
  const old = parseQueryPlan('champions final winner\nskills: none', { skillNames: NAMES });
  assert.deepEqual([old.web, old.reason, old.skills?.state], [null, 'unparsed', undefined]);
  // A skills field alone, the rest null: the search part is none.
  const alone = parseQueryPlan(queryAnswer({ skills: 'inventory' }), { skillNames: NAMES });
  assert.deepEqual([alone.web, alone.history, alone.reason, alone.skills?.state], [null, null, 'none', 'inventory']);
});

test('skillsIndex: one static line per skill, grouped by family, the name alone without a text, the same whatever is allowed', () => {
  const owner = Object.freeze({ name: 'message.purge', ownerOnly: true });
  // The two skills below are bare stand-ins of a name and a flag.
  const registry = new Map<string, object>([
    ...standInRegistry(),
    ['x.read', Object.freeze({ name: 'x.read' })],
    ['message.purge', owner],
  ]) as unknown as SkillMap;
  const texts = { 'message.create': { title: 'Στείλε', whenToUse: 'σε άλλη συζήτηση' } };
  const index = skillsIndex(registry, texts);
  const lines = index.split('\n');
  assert.equal(lines[0], 'message.create | σε άλλη συζήτηση');
  assert.equal(lines[1], 'message.edit', 'no text: the name alone');
  assert.ok(lines.includes('message.purge'), 'an owner-only skill is listed: it runs for an owner who asks');
  // the message family stands together, its late member included, before the next family
  assert.deepEqual(lines.slice(1, 6), [
    'message.edit',
    'message.delete',
    'message.react.add',
    'message.react.remove',
    'message.purge',
  ]);
  assert.deepEqual(lines.slice(6), ['lore.list', 'access.list', 'x.read']);
  assert.equal(lines.length, registry.size);
  assert.ok(!/allowed|not-allowed|carried/.test(index), 'no access in the list');
});

test('byFamily: groups by the part before the first dot, families in order of first appearance', () => {
  const rows = ['message.create', 'draw.create', 'memory.profile.read', 'message.edit', 'draw', 'memory.wipe'].map(
    (name) => ({ name })
  );
  assert.deepEqual(
    byFamily(rows).map((group) => group.map((row) => row.name)),
    [
      ['message.create', 'message.edit'],
      ['draw.create', 'draw'],
      ['memory.profile.read', 'memory.wipe'],
    ]
  );
  // @ts-expect-error: the test passes the absent list the type forbids
  assert.deepEqual(byFamily(null), []);
});

test('listSkills: an owner-only skill has its row, open only for an owner who asks; proposalVerdicts reads each name off the rows', () => {
  const ops: Record<string, { name: string; rights: Rights }> = {
    'x.owner.op': { name: 'x.owner.op', rights: { kind: 'read', ownerOnly: true } },
  };
  const getOp = (name: string) => ops[name] ?? null;
  const owner = loadSkills(
    [
      {
        name: 'x.owner',
        family: 'x',
        op: 'x.owner.op',
        argsSchema: { type: 'object' },
        effects: 'read',
        sharedState: false,
        costClass: 'free',
        targets: null,
      },
    ],
    { getOp }
  ).get('x.owner');
  assert.equal(owner?.ownerOnly, true);
  const registry = new Map([...standInRegistry(), ['x.owner', owner]]);
  const config = granting(['message.edit', 'x.owner'], {
    tools: { safeMode: false },
    bot: { ownerPerson: OWNER_PERSON },
  });
  const rows = listSkills({
    config,
    selfId: 'self-1',
    texts: {},
    requester: { id: '7' },
    audience: { chatId: 'c1' },
    registry,
    getOp,
  });
  assert.equal(rows.length, registry.size);
  assert.deepEqual(proposalVerdicts(['message.edit', 'message.delete', 'x.owner', 'x.none'], rows), [
    { name: 'message.edit', allowed: true, reason: 'allowed' },
    { name: 'message.delete', allowed: false, reason: 'not-allowed' },
    { name: 'x.owner', allowed: false, reason: 'requester-denied' },
    { name: 'x.none', allowed: false, reason: 'unknown-skill' },
  ]);
  const asOwner = listSkills({
    config,
    selfId: 'self-1',
    texts: {},
    requester: { id: '42' },
    audience: { chatId: 'c1' },
    registry,
    getOp,
  });
  assert.deepEqual(proposalVerdicts(['x.owner'], asOwner), [{ name: 'x.owner', allowed: true, reason: 'allowed' }]);
});

test('skillArgs: each argument in schema order, required marked, enum values capped, booleans as values, integer bounds, no body flag', () => {
  const many = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ξ'];
  const skill = {
    name: 'x.read',
    argsSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        section: { type: 'string', enum: many },
        order: { type: 'string', enum: ['rank', 'recent'] },
        detail: { type: 'boolean' },
        n: { type: 'integer', minimum: 1, maximum: 50 },
        number: { type: 'integer', minimum: 1 },
        user: { type: 'string', minLength: 1, maxLength: 100 },
      },
      required: ['user', 'text'],
      additionalProperties: false,
    },
    dispatch: { body: 'text' },
  };
  assert.deepEqual(skillArgs(skill), [
    { name: 'text', required: true },
    { name: 'section', required: false, values: many.slice(0, MAX_ARG_VALUES), more: true },
    { name: 'order', required: false, values: ['rank', 'recent'] },
    { name: 'detail', required: false, values: ['true', 'false'] },
    { name: 'n', required: false, minimum: 1, maximum: 50 },
    { name: 'number', required: false, minimum: 1 },
    { name: 'user', required: true },
  ]);
  // Exactly the cap: every value, no "more".
  assert.deepEqual(skillArgs({ argsSchema: { properties: { role: { enum: many.slice(0, MAX_ARG_VALUES) } } } }), [
    { name: 'role', required: false, values: many.slice(0, MAX_ARG_VALUES) },
  ]);
  // No schema, no properties, no command: nothing to list.
  assert.deepEqual(skillArgs({ argsSchema: { type: 'object' } }), []);
  assert.deepEqual(skillArgs(null), []);
  assert.deepEqual(skillArgs({ argsSchema: { properties: { text: { type: 'string' } } } }), [
    { name: 'text', required: false },
  ]);
});

test("listSkills: each row carries the skill's arguments (skillArgs)", () => {
  const registry = skillRegistry();
  const rows = listSkills({
    config: {},
    selfId: 'self-1',
    texts: {},
    requester: null,
    audience: { chatId: 'c1' },
    registry,
  });
  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const name of ['memory.journal.read', 'message.edit', 'status.show'])
    assert.deepEqual(byName.get(name)?.args, skillArgs(registry.get(name)), name);
  assert.deepEqual(byName.get('memory.server.read')?.args, []);
});

test('grantedSkillNames: only the skills granted to her user id, sorted by name whatever the grant or registry order', () => {
  const registry = standInRegistry();
  const config = granting(['message.react.remove', 'lore.list', 'message.edit', 'not.in.registry'], {});
  // Changed: lore.list is one of the narrow reads left out of her offered list (lookup loop slice 12), and this stand-in
  // registry holds no memory.read to stand in for it.
  assert.deepEqual(grantedSkillNames({ config, selfId: 'self-1', registry }), ['message.edit', 'message.react.remove']);
  // The same grants stored in another order: the same list.
  const reordered = granting(['message.edit', 'not.in.registry', 'lore.list', 'message.react.remove'], {});
  assert.deepEqual(grantedSkillNames({ config: reordered, selfId: 'self-1', registry }), [
    'message.edit',
    'message.react.remove',
  ]);
  // A carried-over skill is listed only when granted.
  assert.ok(!grantedSkillNames({ config, selfId: 'self-1', registry }).includes('message.create'));
});

test('grantedSkillNames: a grant to everyone or a role, another user, no id, safe mode or a not-grantable skill lists nothing', () => {
  const registry = standInRegistry();
  const people = { bot: { access: { 'lore.list': { everyone: true, roles: ['r1'], users: ['u-9'] } } } };
  assert.deepEqual(grantedSkillNames({ config: people, selfId: 'self-1', registry }), []);
  const config = granting(['lore.list', 'message.edit'], {});
  assert.deepEqual(grantedSkillNames({ config, selfId: null, registry }), []);
  assert.deepEqual(
    grantedSkillNames({ config: { ...config, tools: { safeMode: true } }, selfId: 'self-1', registry }),
    []
  );
  const restore = standIns([
    {
      name: 'memory.restore',
      op: null,
      argsSchema: { type: 'object' },
      effects: 'destructive',
      costClass: 'free',
      targets: null,
    },
  ]);
  assert.deepEqual(
    grantedSkillNames({ config: granting(['memory.restore'], {}), selfId: 'self-1', registry: restore }),
    []
  );
  assert.deepEqual(grantedSkillNames({ config, selfId: 'self-1', registry: null }), []);
});

test('describeRows: an exact name gives the skill in full, a family one line each without arguments, a stranger the closest names', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  const config = {
    bot: { access: { 'memory.search': { everyone: false, roles: [], users: [self] } } },
  };
  const texts = {
    'memory.search': { title: 'T', whenToUse: 'W', whenNotToUse: 'N' },
    'memory.journal.read': { title: 'J', whenToUse: 'jw', whenNotToUse: '' },
  };
  const exact = describeRows({ config, selfId: self, registry, texts, name: ' Memory.Search ' });
  assert.deepEqual(
    exact.rows.map((row) => [row.name, row.title, row.reason, row.allowed]),
    [['memory.search', 'T', 'allowed', true]]
  );
  assert.deepEqual(
    exact.rows[0].args.map((arg) => arg.name),
    // The contract gained the stored facts' filters: entity, predicate, as_of and historical (docs/prompt-contract.md).
    // Slice 7: the tool argument `channel` is named `place`.
    // The search gained `mine`, which keeps it to her own lines, so the list of arguments ends with it.
    [
      'question',
      'people',
      'place',
      'when',
      'terms',
      'anchor',
      'move',
      'messages',
      'minutes',
      'entity',
      'predicate',
      'as_of',
      'historical',
      'mine',
    ]
  );
  const off = describeRows({ config, selfId: self, registry, texts, name: 'memory.journal.read' });
  assert.equal(off.rows[0].reason, 'not-allowed', 'not switched on for her');
  const family = describeRows({ config, selfId: self, registry, texts, name: 'memory' });
  assert.ok(
    family.rows.length > 3 && family.rows.every((row) => row.name.startsWith('memory.') && row.args.length === 0)
  );
  const stranger = describeRows({ config, selfId: self, registry, texts, name: 'memory.serch' });
  assert.deepEqual([stranger.rows, stranger.closest[0]], [[], 'memory.search']);
  assert.deepEqual(describeRows({ config, selfId: self, registry, texts, name: '' }), { rows: [], closest: [] });
  assert.deepEqual(describeRows({ config, selfId: self, registry, texts, name: 'zzzzzzzzzzzzzzzz' }).closest, []);
});

// PR 7d: voice messages are code, so voice.say is carried over beside the other reply tags.
test('exposedSkillNames: her grants and the carried-over skills, sorted, once each, whatever the turn; a grant to everyone is not hers', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  const grant = { everyone: false, roles: [], users: [self] };
  // Changed: drawing and speech are on by their chains (spec 2026-11-09-model-routes, slice 4).
  const config = {
    bot: {
      access: {
        'errand.run': grant,
        'memory.search': grant,
        'draw.create': grant,
        'web.search': { everyone: true, roles: [], users: [] },
      },
    },
    models: { routes: chainsOnDefaults({}) },
  };
  // Sorted by code unit: the errand tool sits between draw.create and memory.search.
  assert.deepEqual(exposedSkillNames({ config, selfId: self, registry }), [
    'draw.create',
    'errand.run',
    'memory.search',
    'message.create',
    'message.react.add',
    'voice.say',
  ]);
  assert.deepEqual(
    exposedSkillNames({ config, selfId: null, registry }),
    ['draw.create', 'message.create', 'message.react.add', 'voice.say'],
    'without her id nothing is granted, the carried-over ones stay'
  );
});

// PR 7d: the tools and drawing switches are code, so only safe mode and the registry narrow the list.
test('exposedSkillNames: safe mode keeps the carried-over ones, the registry decides the rest', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  // Changed: drawing and speech are on by their chains (slice 4).
  const config = {
    bot: { access: { 'errand.run': { everyone: false, roles: [], users: [self] } } },
    models: { routes: chainsOnDefaults({}) },
  };
  assert.deepEqual(exposedSkillNames({ config: { ...config, tools: { safeMode: true } }, selfId: self, registry }), [
    'draw.create',
    'message.create',
    'message.react.add',
    'voice.say',
  ]);
  assert.deepEqual(exposedSkillNames({ config, selfId: self, registry: null }), []);
  const small = standIns([
    {
      name: 'message.create',
      op: null,
      argsSchema: { type: 'object' },
      effects: 'write',
      costClass: 'free',
      targets: null,
    },
  ]);
  assert.deepEqual(
    exposedSkillNames({ config, selfId: self, registry: small }),
    ['message.create'],
    'only what the registry holds'
  );
});

// ---- roles that are off ----------------------------------------------------------------------------------------------
// An optional model role (`vision`, `video`, `drawing`, `speech`) with an empty chain is off, and the tools it serves
// leave her list, so the request's `tools` field does not offer what cannot run.

const OFF_SELF = 'self-id';
const OFF_GRANT = { everyone: false, roles: [], users: [OFF_SELF] };

/** A config granting her `media.look`, with a chain for each role of `base` that names a model. */
function lookConfig(base: Record<string, unknown>) {
  return { bot: { access: { 'media.look': OFF_GRANT } }, models: { routes: chainsOf(base) } };
}

const ALL_ON = { vision: 'x/v', video: 'x/w', drawing: 'x/d', speech: 'x/s' };

// Bug caught: the model is offered a picture it cannot draw, calls it, and the turn spends a step on a refusal.
test('exposedSkillNames: draw.create leaves the list while drawing is off, the others stay', () => {
  const registry = skillRegistry();
  const on = exposedSkillNames({ config: lookConfig(ALL_ON), selfId: OFF_SELF, registry });
  assert.ok(on.includes('draw.create'));
  const off = exposedSkillNames({ config: lookConfig({ ...ALL_ON, drawing: null }), selfId: OFF_SELF, registry });
  assert.deepEqual(
    off,
    on.filter((name) => name !== 'draw.create')
  );
});

// Bug caught: a voice message promised with no speech model behind it.
test('exposedSkillNames: voice.say leaves the list while speech is off', () => {
  const registry = skillRegistry();
  const on = exposedSkillNames({ config: lookConfig(ALL_ON), selfId: OFF_SELF, registry });
  assert.ok(on.includes('voice.say'));
  const off = exposedSkillNames({ config: lookConfig({ ...ALL_ON, speech: null }), selfId: OFF_SELF, registry });
  assert.deepEqual(
    off,
    on.filter((name) => name !== 'voice.say')
  );
});

// Bug caught: media.look dropped when only one of its two roles is off, so she cannot look at what she still can see.
test('exposedSkillNames: media.look stays while vision or video is on and leaves when both are off', () => {
  const registry = skillRegistry();
  const names = (base: Record<string, unknown>) =>
    exposedSkillNames({ config: lookConfig(base), selfId: OFF_SELF, registry });
  assert.ok(names(ALL_ON).includes('media.look'));
  assert.ok(names({ ...ALL_ON, vision: null }).includes('media.look'), 'video on');
  assert.ok(names({ ...ALL_ON, video: null }).includes('media.look'), 'vision on');
  assert.equal(names({ ...ALL_ON, vision: null, video: null }).includes('media.look'), false);
});

// Bug caught: the off state read only for the carried-over tools, so safe mode brings the dead ones back.
test("exposedSkillNames: safe mode does not bring an off role's carried-over tools back", () => {
  const registry = skillRegistry();
  const config = { ...lookConfig({ ...ALL_ON, drawing: null, speech: null }), tools: { safeMode: true } };
  assert.deepEqual(exposedSkillNames({ config, selfId: OFF_SELF, registry }), ['message.create', 'message.react.add']);
});

// Bug caught: a deployment with every role on losing a tool, which changes its request.

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['42']);
