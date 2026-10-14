// Tests for skills discovery (src/skills/discovery.js) and the `skills:` line it adds to the
// search classifier's and the planner's answers: the parsers read it and leave every other line
// as it was, the classifiers' list of skills is static and grouped by family, the switches, and
// the catalogue view listing owner-only skills too (they run for an owner who asks).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_PROPOSED, byFamily, discoveryOn, parseSkillsLines, proposalVerdicts, skillsIndex, takeSkillsLines } from '../src/skills/discovery.js';
import '../src/ops/index.js';
import { loadSkills, skillNames } from '../src/skills/registry.js';
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
  const config = granting(['message.edit', 'x.owner'], { features: { skills: true }, skills: { conversations: [], safeMode: false }, bot: { owners: ['42'] } });
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
