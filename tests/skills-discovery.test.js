// Tests for skills discovery (src/skills/discovery.js) and the `skills:` line it adds to the
// search classifier's and the planner's answers: the parsers read it and leave every other line
// as it was, the classifiers' list of skills is static and grouped by family, the switches, and
// the catalogue view listing owner-only skills too (they run for an owner who asks).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CORE_TOOL_SKILLS, MAX_ARG_VALUES, MAX_PROPOSED, alwaysListedOn, byFamily, coreToolRows, describeRows, discoveryOn, grantedSkillNames, parseSkillsLines, proposalVerdicts, skillArgs, skillsIndex, takeSkillsLines } from '../src/skills/discovery.js';
import '../src/ops/index.js';
import { loadSkills, skillNames, skillRegistry } from '../src/skills/registry.js';
import { listSkills } from '../src/skills/gateway.js';
import { parseLookupAnswer } from '../src/behavior/recall.js';
import { buildPlannerRequest, parsePlannerAnswer, PLANNER_BLOCKS } from '../src/behavior/planner.js';

const NAMES = ['message.create', 'message.edit', 'draw.create', 'memory.profile.read', 'status.show'];
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** Stand-in skills (no operation behind them, so no rights to check): a registry that needs no ops. */
function standInRegistry() {
  const names = ['message.create', 'message.edit', 'message.delete', 'message.react.add', 'message.react.remove', 'lore.list', 'access.list'];
  return loadSkills(names.map((name) => ({ name, op: null, argsSchema: { type: 'object' }, effects: name.endsWith('.list') ? 'read' : 'write', costClass: 'free', targets: null })));
}

/** `cfg` with `names` granted to the persona (her user id, `self-1`). */
function granting(names, cfg) {
  return { ...cfg, bot: { ...cfg.bot, access: Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-1'] }])) } };
}

test('discoveryOn: on unless features.skills or features.skillsDiscovery is false', () => {
  assert.equal(discoveryOn({}), true);
  assert.equal(discoveryOn({ features: { skills: true, skillsDiscovery: true } }), true);
  assert.equal(discoveryOn({ features: { skills: false } }), false);
  assert.equal(discoveryOn({ features: { skillsDiscovery: false } }), false);
});

test('parseSkillsLines: missing, none, inventory, named, invalid', () => {
  assert.deepEqual(parseSkillsLines([], NAMES), { state: 'missing', inventory: false, names: [] });
  assert.deepEqual(parseSkillsLines(['none'], NAMES), { state: 'none', inventory: false, names: [] });
  assert.deepEqual(parseSkillsLines(['`None.`'], NAMES), { state: 'none', inventory: false, names: [] });
  assert.deepEqual(parseSkillsLines(['Inventory'], NAMES), { state: 'inventory', inventory: true, names: [] });
  assert.deepEqual(parseSkillsLines(['draw, inventory'], NAMES), { state: 'inventory', inventory: true, names: [] }, 'inventory wins');
  assert.deepEqual(parseSkillsLines(['"Draw.create", message.edit, draw.create, café, memory.profile.read.'], NAMES), { state: 'named', inventory: false, names: ['draw.create', 'message.edit', 'memory.profile.read'] });
  assert.deepEqual(parseSkillsLines(['ζωγραφική, café'], NAMES), { state: 'invalid', inventory: false, names: [] }, 'no known name');
  assert.deepEqual(parseSkillsLines(['draw', 'draw'], NAMES), { state: 'invalid', inventory: false, names: [] }, 'two lines');
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
  assert.deepEqual(takeSkillsLines('web: Αθήνα\n- **skills:** inventory\nserver: κουνέλι'), { rest: 'web: Αθήνα\nserver: κουνέλι', values: ['inventory'] });
  assert.deepEqual(takeSkillsLines('none'), { rest: 'none', values: [] });
});

test('parseLookupAnswer: answers without a skills line read as before, with no skills key', () => {
  for (const raw of ['none', 'champions final', 'web: Αθήνα\nserver: κουνέλι', '', 'server: none']) {
    const parsed = parseLookupAnswer(raw, { now: NOW });
    assert.equal('skills' in parsed, false, raw);
  }
});

test('parseLookupAnswer: a skills line is read apart; the other lines read exactly as without it', () => {
  const lines = 'web: Αθήνα σήμερα\nserver: κουνέλι, κουνελιού\nwhen: 2026-10-01 .. 2026-10-03';
  const without = parseLookupAnswer(lines, { now: NOW });
  const withSkills = parseLookupAnswer(`${lines}\nskills: draw.create, message.edit`, { now: NOW, skillNames: NAMES });
  assert.deepEqual({ web: withSkills.web, server: withSkills.server, reason: withSkills.reason }, without);
  assert.deepEqual(withSkills.skills, { state: 'named', inventory: false, names: ['draw.create', 'message.edit'] });

  // The old single-line shape keeps working beside it.
  const old = parseLookupAnswer('champions final winner\nskills: none', { skillNames: NAMES });
  assert.deepEqual([old.web, old.reason, old.skills.state], ['champions final winner', 'ok', 'none']);
  // A skills line alone, or beside none: the search part is none.
  for (const raw of ['skills: inventory', 'none\nskills: inventory']) {
    const alone = parseLookupAnswer(raw, { skillNames: NAMES });
    assert.deepEqual([alone.web, alone.server, alone.reason, alone.skills.state], [null, null, 'none', 'inventory'], raw);
  }
});

test('parsePlannerAnswer: a skills line is read, never counted unknown, the four blocks unchanged; absent is missing', () => {
  const answer = 'channel: none\nepisodes: none\nrewatch: none\nlookup: none';
  const without = parsePlannerAnswer(answer, { counts: { channels: 2 } });
  const withSkills = parsePlannerAnswer(`${answer}\n**skills:** Inventory`, { counts: { channels: 2 }, skillNames: NAMES });
  for (const name of PLANNER_BLOCKS) assert.deepEqual(withSkills[name], without[name], name);
  assert.equal(withSkills.unknown, 0);
  assert.deepEqual(withSkills.skills, { state: 'inventory', inventory: true, names: [] });
  assert.equal(without.skills.state, 'missing');
  const named = parsePlannerAnswer('lookup: none\nskills: memory.profile.read, draw.create', { skillNames: NAMES });
  assert.deepEqual(named.skills.names, ['memory.profile.read', 'draw.create']);
  assert.equal(named.lookup.state, 'none');
});

test('buildPlannerRequest: {{skills}} is filled with the list given, or blanked', () => {
  const prompt = 'Plan for {{name}}.\nSkills:\n{{skills}}';
  const candidateBlock = '<candidate>\nAna: τι ξέρεις να κάνεις;\n</candidate>';
  const filled = buildPlannerRequest({ prompt, selfName: 'Zoë', today: '2026-10-14', skills: 'draw | a picture', candidateBlock });
  assert.equal(filled[0].content, 'Plan for Zoë.\nSkills:\ndraw | a picture');
  const blank = buildPlannerRequest({ prompt, selfName: 'Zoë', today: '2026-10-14', candidateBlock });
  assert.equal(blank[0].content, 'Plan for Zoë.\nSkills:\n');
});

test('skillsIndex: one static line per skill, grouped by family, the name alone without a text, the same whatever is allowed', () => {
  const owner = Object.freeze({ name: 'message.purge', ownerOnly: true });
  const registry = new Map([...standInRegistry(), ['x.read', Object.freeze({ name: 'x.read' })], ['message.purge', owner]]);
  const texts = { 'message.create': { title: 'Στείλε', whenToUse: 'σε άλλη συζήτηση' } };
  const index = skillsIndex(registry, texts);
  const lines = index.split('\n');
  assert.equal(lines[0], 'message.create | σε άλλη συζήτηση');
  assert.equal(lines[1], 'message.edit', 'no text: the name alone');
  assert.ok(lines.includes('message.purge'), 'an owner-only skill is listed: it runs for an owner who asks');
  // the message family stands together, its late member included, before the next family
  assert.deepEqual(lines.slice(1, 6), ['message.edit', 'message.delete', 'message.react.add', 'message.react.remove', 'message.purge']);
  assert.deepEqual(lines.slice(6), ['lore.list', 'access.list', 'x.read']);
  assert.equal(lines.length, registry.size);
  assert.ok(!/allowed|not-allowed|carried/.test(index), 'no access in the list');
});

test('byFamily: groups by the part before the first dot, families in order of first appearance', () => {
  const rows = ['message.create', 'draw.create', 'memory.profile.read', 'message.edit', 'draw', 'memory.wipe'].map((name) => ({ name }));
  assert.deepEqual(byFamily(rows).map((group) => group.map((row) => row.name)), [
    ['message.create', 'message.edit'],
    ['draw.create', 'draw'],
    ['memory.profile.read', 'memory.wipe'],
  ]);
  assert.deepEqual(byFamily(null), []);
});

test('listSkills: an owner-only skill has its row, open only for an owner who asks; proposalVerdicts reads each name off the rows', () => {
  const ops = { 'x.owner.op': { name: 'x.owner.op', rights: { kind: 'read', ownerOnly: true } } };
  const getOp = (name) => ops[name] ?? null;
  const owner = loadSkills([{ name: 'x.owner', family: 'x', op: 'x.owner.op', argsSchema: { type: 'object' }, effects: 'read', sharedState: false, costClass: 'free', targets: null }], { getOp }).get('x.owner');
  assert.equal(owner.ownerOnly, true);
  const registry = new Map([...standInRegistry(), ['x.owner', owner]]);
  const config = granting(['message.edit', 'x.owner'], { features: { skills: true }, skills: { safeMode: false }, bot: { owners: ['42'] } });
  const rows = listSkills({ config, selfId: 'self-1', texts: {}, requester: { id: '7' }, audience: { conversationId: 'c1' }, registry, getOp });
  assert.equal(rows.length, registry.size);
  assert.deepEqual(proposalVerdicts(['message.edit', 'message.delete', 'x.owner', 'x.none'], rows), [
    { name: 'message.edit', allowed: true, reason: 'allowed' },
    { name: 'message.delete', allowed: false, reason: 'not-allowed' },
    { name: 'x.owner', allowed: false, reason: 'requester-denied' },
    { name: 'x.none', allowed: false, reason: 'unknown-skill' },
  ]);
  const asOwner = listSkills({ config, selfId: 'self-1', texts: {}, requester: { id: '42' }, audience: { conversationId: 'c1' }, registry, getOp });
  assert.deepEqual(proposalVerdicts(['x.owner'], asOwner), [{ name: 'x.owner', allowed: true, reason: 'allowed' }]);
});

test('skillArgs: each argument in schema order, required marked, enum values capped, booleans as values, integer bounds, the body option flagged', () => {
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
    command: { body: 'text' },
  };
  assert.deepEqual(skillArgs(skill), [
    { name: 'text', required: true, body: true },
    { name: 'section', required: false, values: many.slice(0, MAX_ARG_VALUES), more: true },
    { name: 'order', required: false, values: ['rank', 'recent'] },
    { name: 'detail', required: false, values: ['true', 'false'] },
    { name: 'n', required: false, minimum: 1, maximum: 50 },
    { name: 'number', required: false, minimum: 1 },
    { name: 'user', required: true },
  ]);
  // Exactly the cap: every value, no "more".
  assert.deepEqual(skillArgs({ argsSchema: { properties: { role: { enum: many.slice(0, MAX_ARG_VALUES) } } } }), [{ name: 'role', required: false, values: many.slice(0, MAX_ARG_VALUES) }]);
  // No schema, no properties, no command: nothing to list; a `text` without a command body is no body.
  assert.deepEqual(skillArgs({ argsSchema: { type: 'object' } }), []);
  assert.deepEqual(skillArgs(null), []);
  assert.deepEqual(skillArgs({ argsSchema: { properties: { text: { type: 'string' } } } }), [{ name: 'text', required: false }]);
});

test('skillArgs: a derived skill lists its command\'s options, the same each time', () => {
  const registry = skillRegistry();
  assert.deepEqual(skillArgs(registry.get('memory.journal.read')), [
    { name: 'day', required: false },
    { name: 'kind', required: false, values: ['turn', 'action', 'memory', 'system', 'answer', 'inner', 'all'] },
    { name: 'n', required: false, minimum: 1, maximum: 50 },
    { name: 'message', required: false },
  ]);
  assert.deepEqual(skillArgs(registry.get('message.create')), [
    { name: 'channel', required: false },
    { name: 'reply', required: false },
    { name: 'text', required: true, body: true },
    { name: 'file', required: false },
    { name: 'gif', required: false },
    { name: 'media', required: false },
    { name: 'item', required: false, minimum: 1, maximum: 20 },
  ]);
  assert.deepEqual(skillArgs(registry.get('memory.journal.read')), skillArgs(registry.get('memory.journal.read')));
});

test('listSkills: each row carries the skill\'s arguments (skillArgs)', () => {
  const registry = skillRegistry();
  const rows = listSkills({ config: { features: {} }, selfId: 'self-1', texts: {}, requester: null, audience: { conversationId: 'c1' }, registry });
  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const name of ['memory.journal.read', 'message.edit', 'status.show']) assert.deepEqual(byName.get(name).args, skillArgs(registry.get(name)), name);
  assert.deepEqual(byName.get('memory.server.read').args, []);
});

test('alwaysListedOn: on unless features.skillsAlwaysListed, features.skillsDiscovery or features.skills is false', () => {
  assert.equal(alwaysListedOn({}), true);
  assert.equal(alwaysListedOn({ features: { skillsAlwaysListed: true } }), true);
  assert.equal(alwaysListedOn({ features: { skillsAlwaysListed: false } }), false);
  assert.equal(alwaysListedOn({ features: { skillsDiscovery: false } }), false);
  assert.equal(alwaysListedOn({ features: { skills: false } }), false);
});

test('grantedSkillNames: only the skills granted to her user id, sorted by name whatever the grant or registry order', () => {
  const registry = standInRegistry();
  const config = granting(['message.react.remove', 'lore.list', 'message.edit', 'not.in.registry'], { features: {} });
  assert.deepEqual(grantedSkillNames({ config, selfId: 'self-1', registry }), ['lore.list', 'message.edit', 'message.react.remove']);
  // The same grants stored in another order: the same list.
  const reordered = granting(['message.edit', 'not.in.registry', 'lore.list', 'message.react.remove'], { features: {} });
  assert.deepEqual(grantedSkillNames({ config: reordered, selfId: 'self-1', registry }), ['lore.list', 'message.edit', 'message.react.remove']);
  // A carried-over skill is listed only when granted.
  assert.ok(!grantedSkillNames({ config, selfId: 'self-1', registry }).includes('message.create'));
});

test('grantedSkillNames: a grant to everyone or a role, another user, no id, safe mode, skills off or a not-grantable skill lists nothing', () => {
  const registry = standInRegistry();
  const people = { features: {}, bot: { access: { 'lore.list': { everyone: true, roles: ['r1'], users: ['u-9'] } } } };
  assert.deepEqual(grantedSkillNames({ config: people, selfId: 'self-1', registry }), []);
  const config = granting(['lore.list', 'message.edit'], { features: {} });
  assert.deepEqual(grantedSkillNames({ config, selfId: null, registry }), []);
  assert.deepEqual(grantedSkillNames({ config: { ...config, skills: { safeMode: true } }, selfId: 'self-1', registry }), []);
  assert.deepEqual(grantedSkillNames({ config: { ...config, features: { skills: false } }, selfId: 'self-1', registry }), []);
  const wipe = loadSkills([{ name: 'memory.wipe', op: null, argsSchema: { type: 'object' }, effects: 'destructive', costClass: 'free', targets: null }]);
  assert.deepEqual(grantedSkillNames({ config: granting(['memory.wipe'], { features: {} }), selfId: 'self-1', registry: wipe }), []);
  assert.deepEqual(grantedSkillNames({ config, selfId: 'self-1', registry: null }), []);
});

test('coreToolRows: her granted tools among web.search, web.read, media.look, memory.search and task.run, in that order, with their texts and arguments; her grants only', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  const grant = { everyone: false, roles: [], users: [self] };
  const config = { features: { skills: true }, bot: { access: { 'task.run': grant, 'memory.search': grant, 'lore.list': grant, 'web.search': { everyone: true, roles: [], users: [] } } } };
  const texts = { 'memory.search': { title: 'Ψάξε', whenToUse: 'όταν', whenNotToUse: '' } };
  const rows = coreToolRows({ config, selfId: self, registry, texts });
  assert.deepEqual(rows.map((row) => row.name), ['memory.search', 'task.run'], 'a grant to everyone is people\'s, not hers; lore.list is no tool');
  assert.deepEqual([rows[0].title, rows[0].whenToUse], ['Ψάξε', 'όταν']);
  assert.deepEqual(rows[0].args.map((arg) => arg.name), ['question', 'people', 'channel', 'when', 'terms']);
  assert.equal(rows[0].args[0].body, true, 'the question is the body');
  assert.deepEqual(coreToolRows({ config: { ...config, skills: { safeMode: true } }, selfId: self, registry, texts }), [], 'safe mode lists none');
  assert.deepEqual([...CORE_TOOL_SKILLS], ['web.search', 'web.read', 'media.look', 'memory.search', 'conversation.read', 'media.find', 'message.create', 'message.react.add', 'draw.create', 'task.run', 'task.read', 'task.resolve', 'intent.set', 'intent.update', 'intent.cancel', 'places.list', 'skills.describe', 'status.show', 'task.list', 'memory.journal.read', 'memory.profile.read']);
});

test('coreToolRows: media.look, granted, stands after web.read with its arguments while the tool loop is on; with it off the skill does not exist for her', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  const grant = { everyone: false, roles: [], users: [self] };
  const access = { 'web.read': grant, 'media.look': grant, 'memory.search': grant };
  const rows = coreToolRows({ config: { features: { skills: true, coreTools: true }, bot: { access } }, selfId: self, registry });
  assert.deepEqual(rows.map((row) => row.name), ['web.read', 'media.look', 'memory.search']);
  assert.deepEqual(rows[1].args.map((arg) => [arg.name, arg.required, arg.body === true]), [['message', true, false], ['question', true, true], ['item', false, false]]);
  const off = coreToolRows({ config: { features: { skills: true }, bot: { access } }, selfId: self, registry });
  assert.deepEqual(off.map((row) => row.name), ['web.read', 'memory.search']);
});

test('coreToolRows: the posting rows follow the reads and task.read and task.resolve follow task.run, whatever the turn kind, when granted', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  const grant = { everyone: false, roles: [], users: [self] };
  const access = Object.fromEntries(['web.read', 'memory.search', 'message.create', 'message.react.add', 'draw.create', 'task.run', 'task.read', 'task.resolve', 'intent.set'].map((name) => [name, grant]));
  const config = { features: { skills: true, intentions: true }, bot: { access } };
  const rows = coreToolRows({ config, selfId: self, registry });
  assert.deepEqual(rows.map((row) => row.name), ['web.read', 'memory.search', 'message.create', 'message.react.add', 'draw.create', 'task.run', 'task.read', 'task.resolve', 'intent.set']);
  assert.deepEqual(coreToolRows({ config, selfId: self, registry }), rows, 'no turn-kind or unread-state input changes the rows');
  assert.deepEqual(rows[2].args.map((arg) => arg.name), ['channel', 'reply', 'text', 'file', 'gif', 'media', 'item']);
  assert.deepEqual(rows[3].args.map((arg) => arg.name), ['message', 'emoji', 'channel']);
  assert.deepEqual(rows[6].args.map((arg) => arg.name), ['id', 'from'], 'the action that picks the operation is fixed, not an argument');
  assert.deepEqual(rows[7].args.map((arg) => arg.name), ['id', 'from']);
  assert.deepEqual(coreToolRows({ config: { ...config, bot: { access: { 'web.read': grant } } }, selfId: self, registry }).map((row) => row.name), ['web.read'], 'not granted: not listed');
});

test('coreToolRows: the intent rows follow task.run when intentions are on and granted, and are absent with features.intentions off', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  const grant = { everyone: false, roles: [], users: [self] };
  const access = Object.fromEntries(['task.run', 'intent.set', 'intent.update', 'intent.cancel', 'intent.list'].map((name) => [name, grant]));
  const on = coreToolRows({ config: { features: { skills: true, intentions: true }, bot: { access } }, selfId: self, registry });
  assert.deepEqual(on.map((row) => row.name), ['task.run', 'intent.set', 'intent.update', 'intent.cancel'], 'intent.list is not a tool row');
  const off = coreToolRows({ config: { features: { skills: true, intentions: false }, bot: { access } }, selfId: self, registry });
  assert.deepEqual(off.map((row) => row.name), ['task.run']);
});

test('coreToolRows: the read tools are listed when granted, in the core order', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  const grant = { everyone: false, roles: [], users: [self] };
  const names = ['skills.describe', 'status.show', 'task.list', 'memory.journal.read', 'memory.profile.read', 'conversation.read', 'media.find'];
  const config = { features: { skills: true, coreTools: true }, bot: { access: Object.fromEntries(names.map((name) => [name, grant])) } };
  const rows = coreToolRows({ config, selfId: self, registry });
  assert.deepEqual(rows.map((row) => row.name), [...CORE_TOOL_SKILLS].filter((name) => names.includes(name) && registry.has(name)));
  assert.ok(rows.some((row) => row.name === 'conversation.read') && rows.some((row) => row.name === 'media.find'));
  assert.ok(rows.some((row) => row.name === 'skills.describe'));
  const status = rows.find((row) => row.name === 'status.show');
  assert.deepEqual(status.args.find((arg) => arg.name === 'part').values, ['overview', 'limits', 'models', 'memory', 'inner', 'errands', 'features', 'all']);
  assert.deepEqual(coreToolRows({ config: { features: { skills: true }, bot: { access: {} } }, selfId: self, registry }), [], 'nothing granted, no rows');
});

test('describeRows: an exact name gives the skill in full, a family one line each without arguments, a stranger the closest names', () => {
  const registry = skillRegistry();
  const self = 'self-id';
  const config = { features: { skills: true }, bot: { access: { 'memory.search': { everyone: false, roles: [], users: [self] } } } };
  const texts = { 'memory.search': { title: 'T', whenToUse: 'W', whenNotToUse: 'N' }, 'memory.journal.read': { title: 'J', whenToUse: 'jw', whenNotToUse: '' } };
  const exact = describeRows({ config, selfId: self, registry, texts, name: ' Memory.Search ' });
  assert.deepEqual(exact.rows.map((row) => [row.name, row.title, row.reason, row.allowed]), [['memory.search', 'T', 'allowed', true]]);
  assert.deepEqual(exact.rows[0].args.map((arg) => arg.name), ['question', 'people', 'channel', 'when', 'terms']);
  const off = describeRows({ config, selfId: self, registry, texts, name: 'memory.journal.read' });
  assert.equal(off.rows[0].reason, 'not-allowed', 'not switched on for her');
  const family = describeRows({ config, selfId: self, registry, texts, name: 'memory' });
  assert.ok(family.rows.length > 3 && family.rows.every((row) => row.name.startsWith('memory.') && row.args.length === 0));
  const stranger = describeRows({ config, selfId: self, registry, texts, name: 'memory.serch' });
  assert.deepEqual([stranger.rows, stranger.closest[0]], [[], 'memory.search']);
  assert.deepEqual(describeRows({ config, selfId: self, registry, texts, name: '' }), { rows: [], closest: [] });
  assert.deepEqual(describeRows({ config, selfId: self, registry, texts, name: 'zzzzzzzzzzzzzzzz' }).closest, []);
});
