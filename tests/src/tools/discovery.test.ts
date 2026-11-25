// Tests for skills discovery (src/tools/discovery.ts): the grouping by family, safe mode, and
// the catalogue view listing every skill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ARG_VALUES,
  byFamily,
  describeRows,
  exposedSkillNames,
  grantedSkillNames,
  skillArgs,
} from '../../../src/tools/discovery.ts';
import '../../../src/tools/operations/index.ts';
import { loadSkills, skillRegistry } from '../../../src/tools/registry.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import { chainsOf, chainsOnDefaults } from '../../fixtures/chains.ts';
import { labels } from '../../fixtures/labels.ts';
import { coreTurn } from '../../fixtures/turn-harness.ts';

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
    'errand.list',
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

/** `cfg` with `names` granted to the persona (the persona's user id, `self-1`). */
function granting(names: Array<string>, cfg: Record<string, unknown> & { bot?: object }) {
  return {
    ...cfg,
    bot: {
      ...cfg.bot,
      access: Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-1'] }])),
    },
  };
}

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

test("grantedSkillNames: only the skills granted to the persona's user id, sorted by name whatever the grant or registry order", () => {
  const registry = standInRegistry();
  const config = granting(['message.react.remove', 'lore.list', 'message.edit', 'not.in.registry'], {});
  // lore.list is one of the narrow reads left out of the persona's offered list, and this stand-in registry holds no
  // memory.read to stand in for it.
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
  const [exactRow] = exact.rows;
  assert.deepEqual(
    exactRow.args.map((arg) => arg.name),
    // The arguments hold the stored facts' filters, entity, predicate, as_of and historical (docs/prompt-contract.md),
    // and end with `mine`, which keeps the search to the persona's own lines.
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
  const [offRow] = off.rows;
  assert.equal(offRow.reason, 'not-allowed', 'not switched on for the persona');
  const family = describeRows({ config, selfId: self, registry, texts, name: 'memory' });
  assert.ok(
    family.rows.length > 3 && family.rows.every((row) => row.name.startsWith('memory.') && row.args.length === 0)
  );
  const stranger = describeRows({ config, selfId: self, registry, texts, name: 'memory.serch' });
  assert.deepEqual([stranger.rows, stranger.closest[0]], [[], 'memory.search']);
  assert.deepEqual(describeRows({ config, selfId: self, registry, texts, name: '' }), { rows: [], closest: [] });
  assert.deepEqual(describeRows({ config, selfId: self, registry, texts, name: 'zzzzzzzzzzzzzzzz' }).closest, []);
});

// voice.say is carried over beside the other reply tags.
test("exposedSkillNames: the persona's grants and the carried-over skills, sorted, once each, whatever the turn; a grant to everyone is not theirs", () => {
  const registry = skillRegistry();
  const self = 'self-id';
  const grant = { everyone: false, roles: [], users: [self] };
  // Drawing and speech are on by their chains.
  const config = {
    bot: {
      access: {
        'errand.scout': grant,
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
    'errand.scout',
    'memory.search',
    'message.create',
    'message.react.add',
    'voice.say',
  ]);
  assert.deepEqual(
    exposedSkillNames({ config, selfId: null, registry }),
    ['draw.create', 'message.create', 'message.react.add', 'voice.say'],
    "without the persona's id nothing is granted, the carried-over ones stay"
  );
});

// Only safe mode and the registry narrow the list.
test('exposedSkillNames: safe mode keeps the carried-over ones, the registry decides the rest', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  // Drawing and speech are on by their chains.
  const config = {
    bot: { access: { 'errand.scout': { everyone: false, roles: [], users: [self] } } },
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
// leave the persona's list, so the request's `tools` field does not offer what cannot run.

const OFF_SELF = 'self-id';

const OFF_GRANT = { everyone: false, roles: [], users: [OFF_SELF] };

/** A config granting the persona `media.look`, with a chain for each role of `base` that names a model. */
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

// Bug caught: media.look dropped when only one of its two roles is off, so the persona cannot look at what they still can see.
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

// ---- memory.read in place of the narrow reads of one subject ----------------------------------------------------
// A grant under an old name of a narrow read opens memory.read (src/tools/operations/grants.ts), and the old names leave
// the persona's list while they stay the owner's commands.
const SELF = 'self-id';

const GRANT = { everyone: false, roles: [], users: [SELF] };

const OLD_MEMORY_READS = [
  'memory.profile.read',
  'memory.channel.read',
  'memory.server.read',
  'lore.list',
  'lore.show',
  'memory.recent.read',
];

// Bug caught: a deployment whose `bot.access` names the old reads loses every memory read, or keeps offering the old ones.
test('offers memory.read and none of the old reads when the old reads are granted to the persona', () => {
  const config = {
    bot: { access: Object.fromEntries(OLD_MEMORY_READS.map((name) => [name, GRANT])) },
    models: { routes: chainsOnDefaults({}) },
  };
  const names = exposedSkillNames({ config, selfId: SELF, registry: skillRegistry() });
  assert.ok(names.includes('memory.read'), names.join(', '));
  assert.deepEqual(
    OLD_MEMORY_READS.filter((name) => names.includes(name)),
    []
  );
});

// Bug caught: memory.read missing from the registry or from the grantable tools, so a grant under its own name is dropped.
test('offers memory.read when it is granted by its own name', () => {
  const config = { bot: { access: { 'memory.read': GRANT } }, models: { routes: chainsOnDefaults({}) } };
  const names = exposedSkillNames({ config, selfId: SELF, registry: skillRegistry() });
  assert.ok(names.includes('memory.read'), names.join(', '));
});

// Bug caught: a deployment with every role on losing a tool, which changes its request.

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['42']);

// Tests for the route of the persona's tool abilities in a turn (src/behavior/turn.js over src/tools/gateway.ts#abilityRoute and
// src/llm/role-health.ts): `draw.create` (drawing, imagesOut), `media.look` (vision, imagesIn) and `voice.say` (speech,
// audioOut). When the role is unset or globally failing, the call goes to the core model if the core declares the
// ability (`models.abilities.<model id>`), else the call does not happen and answers `ability-unavailable`. A global
// failure met during the call routes that same call. The first routed call of a turn carries one route line in its
// tool result, naming every tool ability whose role is down; later calls of the turn carry none. One shared
// `roleHealth` reaches the turn runner and the admin. Over the turn harness with fake model, image and speech
// clients; the labels are this file's own, so nothing here depends on their wording.

const ABILITY_WORDS = {
  imagesIn: 'A:imagesIn',
  videoIn: 'A:videoIn',
  imagesOut: 'A:imagesOut',
  audioOut: 'A:audioOut',
} as const;
const WHY_WORDS = {
  'no-model': 'W:no-model',
  'no-key': 'W:no-key',
  unauthorized: 'W:unauthorized',
  payment: 'W:payment',
  'not-found': 'W:not-found',
  'daily-limit': 'W:daily-limit',
  malformed: 'W:malformed',
} as const;

const ROUTE = { fallback: 'core does {ability}: {why}', unavailable: 'gone {ability}: {why}', separator: ' | ' };
const UNAVAILABLE = 'cannot {ability}: {why}; the core cannot either';

/** The fixture labels with the route keys and the `ability-unavailable` reason in this file's own words. */
const { result } = labels.tools;
const ROUTE_LABELS = {
  ...labels,
  tools: {
    ...labels.tools,
    route: ROUTE,
    result: {
      ...labels.tools.result,
      reasons: { ...result.reasons, 'ability-unavailable': UNAVAILABLE },
      params: { ability: ABILITY_WORDS, why: WHY_WORDS },
    },
  },
};

type Run = Awaited<ReturnType<typeof coreTurn>>;

// ---- roles that are off ----------------------------------------------------------------------------------------------
// An optional role with an empty chain (`models.routes.<role>`) is off. The tools it serves are not in the persona's request's
// `tools`, a picture, GIF or video that needs it is not described, and the request carries the words of the
// `ability-unavailable` answer once for each ability that is down, so the persona can tell that the ability is down.

const ON_ROLES = { vision: 'x/vision', video: 'x/video', drawing: 'x/draw', speech: 'x/speech' };
const CORE_AND_TEXT = { core: 'x/core', analyzer: 'x/text' };

/** The names of the tools of the persona's first request. */
function toolNamesOf(run: Run): Array<string> {
  const { options } = run.llm;
  const tools: unknown = options[0]?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool: unknown) => {
    const fn: unknown = tool !== null && typeof tool === 'object' ? Reflect.get(tool, 'function') : null;
    const name: unknown = fn !== null && typeof fn === 'object' ? Reflect.get(fn, 'name') : null;
    return String(name);
  });
}

// Bug caught: the model is offered tools whose model is off, and spends steps on calls that cannot run.
test('with drawing and speech off, the tools field of the persona has no draw_create and no voice_say, and media_look stays', async () => {
  const run = await coreTurn({
    answers: ['<skip/>'],
    allowed: ['media.look'],
    config: { models: { routes: chainsOf({ ...CORE_AND_TEXT, ...ON_ROLES, drawing: null, speech: null }) } },
    prompts: { labels: ROUTE_LABELS },
  });
  const names = toolNamesOf(run);
  assert.ok(names.includes('message_create') && names.includes('media_look'), names.join());
  assert.equal(names.includes('draw_create'), false);
  assert.equal(names.includes('voice_say'), false);
});
