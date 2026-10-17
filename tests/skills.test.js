// Tests for src/skills/: the persona's skills ARE the owner's /nep commands (one skill per
// operation, derived from the command that runs it), the rights gateway, the catalogue view, the
// effect table, and how the owner opens a skill for her (`/nep access grant|revoke` with her as
// the user, src/ops/access.js), with the rule she never changes her own authority. Nothing here
// executes a skill: the gateway only answers whether one may run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOp, resolveCommand, COMMAND_TO_OP } from '../src/ops/index.js';
import { listOps } from '../src/ops/registry.js';
import { createOpsEnv } from '../src/ops/env.js';
import { EFFECT_CLASSES, OP_EFFECTS, SELF_OWNED_OPS } from '../src/ops/effects.js';
import { PERSONA_GOVERNED_CONFIG, governsPersona } from '../src/ops/rights.js';
import { RENAMED_OPS, renameGrants } from '../src/ops/access.js';
import { createAdmin } from '../src/admin.js';
import { COMMAND_TABLE, buildCommandTree, createInteractionHandler } from '../src/discord/commands.js';
import { buildSkills, loadSkills, skillRegistry, skillNames, describeSkill } from '../src/skills/registry.js';
import { commandSources, deriveSkillDefinitions, optionsSchema } from '../src/skills/derive.js';
import { CARRIED_OVER, NOT_GRANTABLE_TO_PERSONA, grantedToPersona, skillAccess } from '../src/skills/access.js';
import { schemaError } from '../src/skills/schema.js';
import { checkReplyEffect, checkSkill, listSkills } from '../src/skills/gateway.js';

const OWNER = '42';
const MEMBER = '7';
const SELF = 'self-1';
const HERE = 'c-here';
const persona = Object.freeze({ kind: 'persona' });
const audience = Object.freeze({ conversationId: HERE, memberIds: [MEMBER] });

/** A config with the settings these tests read, each set here (never the shipped defaults). */
function config({ features = {}, skills = {}, access = {} } = {}) {
  return {
    features: { skills: true, journal: true, ...features },
    skills: { safeMode: false, ...skills },
    bot: { owners: [OWNER], access },
  };
}

/** `cfg` with each of `names` granted to the persona -- her user id in `bot.access[name].users` -- as `/nep access grant` stores it. */
function granting(names, cfg = config()) {
  const access = { ...(cfg.bot?.access ?? {}) };
  for (const name of names) access[name] = { everyone: access[name]?.everyone === true, roles: [...(access[name]?.roles ?? [])], users: [...(access[name]?.users ?? []), SELF] };
  return { ...cfg, bot: { ...(cfg.bot ?? {}), access } };
}

/** An images client whose quota answers `quota`. */
function imagesWith(quota) {
  return { quota: ({ userId } = {}) => ({ used: 0, cap: 5, userUsed: 0, userCap: 2, spent: false, userSpent: false, ...quota, askedFor: userId }) };
}

/** One gateway check of a skill of the real registry (default: lore.list for the owner). */
function check({ skill = 'lore.list', args = {}, requester = { id: OWNER }, cfg = config(), granted = [], registry = skillRegistry(), images, mixedRequesters, lastRunAt, now } = {}) {
  return checkSkill({
    skill,
    args,
    principal: persona,
    requester,
    audience,
    context: { config: granting(granted, cfg), selfId: SELF, images, registry, mixedRequesters, lastRunAt, now },
  });
}

/** One structural definition, the fields a test does not care about filled in. */
function def(over) {
  return { name: 'x.read', family: 'x', op: null, argsSchema: { type: 'object', properties: {}, additionalProperties: false }, effects: 'read', sharedState: false, costClass: 'free', targets: null, interfaceCapability: null, ...over };
}

// ---- the catalogue: one skill per operation -------------------------------------------

test('skills registry: one skill per operation, of the same name, kind and ownerOnly inherited; no other skill exists', () => {
  const registry = skillRegistry();
  assert.deepEqual([...registry.keys()], listOps().map((op) => op.name));
  assert.deepEqual(skillNames(), listOps().map((op) => op.name));
  for (const op of listOps()) {
    const skill = registry.get(op.name);
    assert.equal(skill.derived, true, op.name);
    assert.equal(skill.op, op.name, op.name);
    assert.equal(skill.kind, op.rights.kind, op.name);
    assert.equal(skill.ownerOnly, op.rights.ownerOnly === true, op.name);
    assert.equal(skill.family, op.name.split('.')[0], op.name);
  }
  // the old interface-only skills are gone; their abilities are operations behind commands
  for (const gone of ['draw', 'memory.read', 'message.send', 'skills.list', 'access.request', 'talk.interject', 'skill.allow']) assert.equal(registry.has(gone), false, gone);
  for (const name of ['message.create', 'message.edit', 'message.delete', 'message.react.add', 'message.react.remove', 'draw.create', 'memory.profile.read', 'status.show']) assert.ok(registry.has(name), name);
  assert.equal(registry.get('memory.wipe').ownerOnly, true);
  assert.equal(registry.get('draw.create').costClass, 'paid');
});

test('skills effects: one effect class per operation, by its actual effect, in one table', () => {
  for (const op of listOps()) assert.ok(EFFECT_CLASSES.includes(OP_EFFECTS[op.name]), `${op.name} has no effect class`);
  assert.deepEqual(Object.keys(OP_EFFECTS).sort(), listOps().map((op) => op.name).sort(), 'no row for an operation that does not exist');
  const of = (effect) => Object.keys(OP_EFFECTS).filter((name) => OP_EFFECTS[name] === effect).sort();
  assert.deepEqual(of('destructive'), ['alias.remove', 'learning.remove', 'lore.remove', 'memory.forget', 'memory.private.forget', 'memory.private.purge', 'memory.restore', 'memory.wipe', 'message.delete', 'rule.remove']);
  for (const name of ['config.set', 'config.unset', 'model.set', 'route.set', 'route.remove', 'access.grant', 'access.revoke', 'bot.pause', 'bot.resume']) assert.equal(OP_EFFECTS[name], 'administrative', name);
  assert.deepEqual(of('paid'), ['draw.create', 'task.run']);
  for (const op of listOps()) if (op.rights.kind === 'read') assert.equal(OP_EFFECTS[op.name], 'read', op.name);
  // a skill carries its operation's class
  assert.equal(skillRegistry().get('memory.wipe').effects, 'destructive');
});

test('skills registry: a definition is checked at load; an owner-only operation loads with ownerOnly', () => {
  assert.throws(() => loadSkills([def({ op: 'no.such.op' })]), /unknown operation/);
  assert.throws(() => loadSkills([def(), def()]), /twice/);
  assert.throws(() => loadSkills([def({ effects: 'launch' })]), /effects/);
  assert.throws(() => loadSkills([def({ costClass: 'cheap' })]), /costClass/);
  assert.throws(() => loadSkills([def({ targets: 'everyone' })]), /targets/);
  assert.throws(() => loadSkills([def({ argsSchema: null })]), /argsSchema/);
  assert.throws(() => loadSkills([def({ command: { key: 'x' } })]), /toCall/);
  const ops = { 'fake.op': { name: 'fake.op', rights: { kind: 'write', ownerOnly: true } } };
  assert.deepEqual([...loadSkills([def({ op: 'fake.op' })], { getOp: (name) => ops[name] ?? null }).values()].map((skill) => [skill.kind, skill.ownerOnly]), [['write', true]]);
});

test('skills registry: the texts come from prompts/skills.json by operation name; a skill without them has empty texts', () => {
  const skill = skillRegistry().get('message.edit');
  const texts = { 'message.edit': { title: 'Διόρθωση', whenToUse: 'όταν', whenNotToUse: 'ποτέ' } };
  assert.deepEqual(['title', 'whenToUse', 'whenNotToUse'].map((key) => describeSkill(skill, texts)[key]), ['Διόρθωση', 'όταν', 'ποτέ']);
  assert.deepEqual(['title', 'whenToUse', 'whenNotToUse'].map((key) => describeSkill(skillRegistry().get('memory.wipe'), {})[key]), ['', '', '']);
  assert.equal(describeSkill(skill, undefined).title, '');
});

test('skills registry: prompts/skills.json has the three texts of every operation, and no key that is not one', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'skills.json');
  const texts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ops = listOps().map((op) => op.name);
  for (const name of ops) {
    for (const key of ['title', 'whenToUse', 'whenNotToUse']) {
      assert.equal(typeof texts[name]?.[key], 'string', `${name}.${key}`);
      assert.ok(texts[name][key].trim(), `${name}.${key} is empty`);
    }
  }
  assert.deepEqual(Object.keys(texts).filter((name) => !ops.includes(name)), [], 'a key that is no operation');
  assert.equal(Object.hasOwn(texts, 'memory.affinity.set'), false);
});

// ---- derived from the command tree ----------------------------------------------------

/** A fake command tree: a plain leaf, a group whose `action` picks the operation, a leaf whose optional `score` does, a persona-only option. */
const FAKE_TABLE = [
  {
    name: 'note',
    description: 'd',
    options: [
      { type: 3, name: 'text', description: 'd', required: true, max_length: 50 },
      { type: 4, name: 'number', description: 'd', required: false, min_value: 1, max_value: 9 },
      { type: 5, name: 'loud', description: 'd', required: false },
    ],
    args: (o) => ({ text: o.getString('text', true), n: o.getInteger('number') ?? undefined, loud: o.getBoolean('loud') ?? false }),
  },
  {
    name: 'box',
    description: 'd',
    subcommands: [
      {
        name: 'act',
        description: 'd',
        options: [
          { type: 3, name: 'action', description: 'd', required: true, choices: [{ name: 'open', value: 'open' }, { name: 'shut', value: 'shut' }] },
          { type: 6, name: 'user', description: 'd', required: true },
        ],
        args: (o) => ({ action: o.getString('action', true), userId: o.getUser('user', true).id }),
      },
      {
        name: 'mood',
        description: 'd',
        options: [{ type: 7, name: 'channel', description: 'd', required: true }, { type: 4, name: 'score', description: 'd', required: false, min_value: -5, max_value: 5 }],
        personaOptions: [{ type: 3, name: 'why', description: 'd', required: false, max_length: 20 }],
        args: (o) => ({ channelId: o.getChannel('channel', true).id, score: o.getInteger('score') ?? undefined, why: o.getString('why') ?? undefined }),
      },
    ],
  },
];
const FAKE_MAP = {
  note: 'note.add',
  'box.act': (args) => (args.action === 'open' ? { op: 'box.open', args } : args.action === 'shut' ? { op: 'box.shut', args } : { invalid: 'action' }),
  'box.mood': (args) => ({ op: args.score === undefined ? 'box.mood.read' : 'box.mood.set', args }),
};
const fakeResolve = (key, args) => {
  const target = FAKE_MAP[key];
  if (!target) return null;
  return typeof target === 'function' ? target(args) : { op: target, args };
};
const FAKE_OPS = [
  { name: 'note.add', rights: { kind: 'write' } },
  { name: 'box.open', rights: { kind: 'write', ownerOnly: true } },
  { name: 'box.shut', rights: { kind: 'write', ownerOnly: true } },
  { name: 'box.mood.read', rights: { kind: 'read' } },
  { name: 'box.mood.set', rights: { kind: 'write' } },
];
const fakeGetOp = (name) => FAKE_OPS.find((op) => op.name === name) ?? null;

/** The registry over the fake tree and ops. */
function fakeRegistry() {
  return buildSkills({ ops: FAKE_OPS, sources: commandSources({ table: FAKE_TABLE, resolve: fakeResolve }), resolve: fakeResolve, getOp: fakeGetOp });
}

test('skills derived: one per operation of a fake ops list, from the command that runs it', () => {
  const registry = fakeRegistry();
  assert.deepEqual([...registry.keys()], FAKE_OPS.map((op) => op.name));
  assert.deepEqual([...registry.values()].map((skill) => [skill.kind, skill.ownerOnly, skill.family, skill.effects]), [
    ['write', false, 'note', 'write'],
    ['write', true, 'box', 'write'],
    ['write', true, 'box', 'write'],
    ['read', false, 'box', 'read'],
    ['write', false, 'box', 'write'],
  ]);
  // an operation no command runs cannot be a skill: a programming error
  assert.throws(() => deriveSkillDefinitions({ ops: [{ name: 'lost.op', rights: { kind: 'read' } }], sources: new Map(), resolve: fakeResolve }), /no command/);
});

test('skills derived: the argument schema is the command\'s options -- names, types, bounds, required, choices', () => {
  const registry = fakeRegistry();
  assert.deepEqual(registry.get('note.add').argsSchema, {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 50 },
      number: { type: 'integer', minimum: 1, maximum: 9 },
      loud: { type: 'boolean' },
    },
    required: ['text'],
    additionalProperties: false,
  });
  assert.equal(registry.get('note.add').command.body, 'text', 'a `text` option takes the call\'s body');
  // the choice that picks the operation is fixed, not asked
  assert.deepEqual(registry.get('box.open').argsSchema, { type: 'object', properties: { user: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['user'], additionalProperties: false });
  assert.deepEqual(registry.get('box.open').command.fixed, { action: 'open' });
  // an optional option whose presence picks the operation: left out for one, required for the other
  assert.deepEqual(Object.keys(registry.get('box.mood.read').argsSchema.properties), ['channel', 'why']);
  assert.deepEqual(registry.get('box.mood.set').argsSchema.required, ['channel', 'score']);
  assert.deepEqual(registry.get('box.mood.set').argsSchema.properties.score, { type: 'integer', minimum: -5, maximum: 5 });
  // a persona-only option is an argument of hers, mapped by the same mapper
  assert.deepEqual(registry.get('box.mood.read').argsSchema.properties.why, { type: 'string', minLength: 1, maxLength: 20 });
  assert.deepEqual(registry.get('box.mood.set').command.toCall({ channel: 'c1', score: 2, why: 'α' }), { key: 'box.mood', args: { channelId: 'c1', score: 2, why: 'α' }, op: 'box.mood.set' });
  assert.deepEqual(registry.get('box.shut').command.toCall({ user: '7' }), { key: 'box.act', args: { action: 'shut', userId: '7' }, op: 'box.shut' });
});

test('skills derived: the real tree -- every schema is generated from the slash command options, never copied', () => {
  const sources = commandSources({ table: COMMAND_TABLE, resolve: resolveCommand });
  for (const op of listOps()) {
    const source = sources.get(op.name);
    assert.ok(source, `${op.name}: a command runs it`);
    assert.ok(Object.hasOwn(COMMAND_TO_OP, source.key), op.name);
    assert.deepEqual(skillRegistry().get(op.name).argsSchema, optionsSchema(source), op.name);
  }
  // `/nep memory show`: the same option names, kinds, required flags and choices as the owner types
  const leaf = COMMAND_TABLE.find((node) => node.name === 'memory').subcommands.find((sub) => sub.name === 'show');
  const schema = skillRegistry().get('memory.profile.read').argsSchema;
  assert.deepEqual(Object.keys(schema.properties), leaf.options.map((option) => option.name));
  assert.deepEqual(schema.required, leaf.options.filter((option) => option.required).map((option) => option.name));
  assert.deepEqual(schema.properties.section.enum, leaf.options.find((option) => option.name === 'section').choices.map((choice) => choice.value));
  // `/nep media action:status`: the action is the skill, the kind and the days (read by the pictures recache only) its arguments
  assert.deepEqual(skillRegistry().get('media.status').command.fixed, { action: 'status' });
  assert.deepEqual(Object.keys(skillRegistry().get('media.status').argsSchema.properties), ['kind', 'days']);
  // `/nep diary post`: kind and topic, as the command offers them
  assert.deepEqual(skillRegistry().get('diary.post').argsSchema.properties, { kind: { type: 'string', minLength: 1, maxLength: 6000 }, topic: { type: 'string', minLength: 1, maxLength: 1000 } });
  // `/nep message create`: a channel and a message to answer, and her own text, required, the body of her call;
  // a file one of her errands brought back, optional
  const create = skillRegistry().get('message.create');
  assert.deepEqual(Object.keys(create.argsSchema.properties), ['channel', 'reply', 'text', 'file']);
  assert.deepEqual(create.argsSchema.required, ['text']);
  assert.equal(create.command.body, 'text');
  // `/nep draw`: a channel to post the picture in, the owner's too
  assert.ok(Object.hasOwn(skillRegistry().get('draw.create').argsSchema.properties, 'channel'));
  // A yes/no option, a STRING with lowercase true/false choices for Discord, is a boolean argument for her.
  assert.deepEqual(skillRegistry().get('draw.create').argsSchema.properties.self, { type: 'boolean' });
  assert.deepEqual(skillRegistry().get('lore.add').argsSchema.properties.always, { type: 'boolean' });
  assert.deepEqual(skillRegistry().get('route.set').argsSchema.properties.fallbacks, { type: 'boolean' });
  assert.equal(skillRegistry().get('lore.add').command.toCall({ title: 't', keys: 'k', text: 'x', always: true }).args.always, true);
  assert.equal(skillRegistry().get('lore.add').command.toCall({ title: 't', keys: 'k', text: 'x', always: false }).args.always, false);
  assert.deepEqual(Object.keys(skillRegistry().get('status.show').argsSchema.properties), ['field']);
});

test('skills schema: types, bounds, enums, arrays and anyOf', () => {
  const schema = {
    type: 'object',
    properties: { n: { type: 'integer', minimum: 1, maximum: 3 }, kind: { type: 'string', enum: ['a', 'b'] }, ids: { type: 'array', maxItems: 2, items: { type: 'string' } }, on: { type: 'boolean' } },
    required: [],
    additionalProperties: false,
  };
  assert.equal(schemaError({ n: 2, kind: 'a', ids: ['x'], on: true }, schema), null);
  assert.equal(schemaError({ n: 1.5 }, schema), 'args.n:type');
  assert.equal(schemaError({ n: 4 }, schema), 'args.n:maximum');
  assert.equal(schemaError({ n: 0 }, schema), 'args.n:minimum');
  assert.equal(schemaError({ kind: 'c' }, schema), 'args.kind:enum');
  assert.equal(schemaError({ ids: ['x', 'y', 'z'] }, schema), 'args.ids:max-items');
  assert.equal(schemaError({ ids: [1] }, schema), 'args.ids.0:type');
  assert.equal(schemaError(JSON.parse('{"__proto__": {"n": 1}}'), schema), 'args.__proto__:unknown');
  assert.equal(schemaError([], schema), 'args:type');
});

// ---- her access: grants to her user id -------------------------------------------------

test('skills access: default deny; only a grant naming her user id opens a skill', () => {
  const edit = skillRegistry().get('message.edit');
  assert.equal(skillAccess({ skill: edit, config: config(), selfId: SELF }).allowed, false);
  assert.deepEqual(skillAccess({ skill: edit, config: granting(['message.edit']), selfId: SELF }), { allowed: true, reason: 'allowed' });
  assert.equal(skillAccess({ skill: edit, config: granting(['message.edit']), selfId: null }).allowed, false, 'no id of hers, no grant');
  // a grant to everyone or to a role is people's: it opens nothing for her
  const everyone = config({ access: { 'message.edit': { everyone: true, roles: ['r1'], users: [MEMBER] } } });
  assert.equal(skillAccess({ skill: edit, config: everyone, selfId: SELF }).allowed, false);
  assert.equal(grantedToPersona(config({ access: { 'message.edit': { users: 'self-1' } } }), SELF, 'message.edit'), false, 'a malformed grant reads as none');
});

test('skills access: the irreversible and administrative operations are never open to her, whatever is stored', () => {
  assert.deepEqual([...NOT_GRANTABLE_TO_PERSONA].sort(), ['access.grant', 'access.revoke', 'bot.pause', 'bot.resume', 'config.set', 'config.unset', 'memory.forget', 'memory.private.forget', 'memory.private.purge', 'memory.restore', 'memory.wipe', 'model.set', 'route.remove', 'route.set', 'rule.remove']);
  assert.equal(NOT_GRANTABLE_TO_PERSONA.includes('rule.add'), false, 'adding a rule stays grantable');
  for (const name of NOT_GRANTABLE_TO_PERSONA) {
    assert.deepEqual(skillAccess({ skill: skillRegistry().get(name), config: granting([name]), selfId: SELF }), { allowed: false, reason: 'not-grantable' }, name);
  }
  assert.deepEqual(check({ skill: 'memory.wipe', args: { confirm: 'Σπίτι' }, granted: ['memory.wipe'] }), { ok: false, code: 'not-grantable', reason: 'memory.wipe' });
});

test('skills access: her reply tags are carried over in the current conversation, without a grant, even in safe mode', () => {
  assert.deepEqual([...CARRIED_OVER].sort(), ['draw.create', 'message.create', 'message.react.add']);
  for (const skill of CARRIED_OVER) {
    assert.deepEqual(checkReplyEffect({ skill, principal: persona, config: config() }), { ok: true }, skill);
    assert.deepEqual(checkReplyEffect({ skill, principal: persona, config: config({ skills: { safeMode: true } }) }), { ok: true }, skill);
    assert.deepEqual(checkReplyEffect({ skill, principal: persona, config: config({ features: { skills: false } }) }), { ok: false, code: 'skills-off', reason: 'features.skills' }, skill);
  }
  assert.equal(checkReplyEffect({ skill: 'message.delete', principal: persona, config: config() }).code, 'unknown-skill');
  assert.equal(checkReplyEffect({ skill: 'message.create', principal: { kind: 'member' }, config: config() }).code, 'unknown-principal');
  // a call of hers in the current conversation is carried over too
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' } }), { ok: true });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια', channel: 'c-other' } }), { ok: false, code: 'not-allowed', reason: 'message.create' });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' }, requester: { id: MEMBER } }), { ok: true }, 'her own message, whoever asked');
});

test('skills gateway: her own expressive operations need only her grant, whoever asked; the rules on who asked still hold', () => {
  assert.deepEqual([...SELF_OWNED_OPS].sort(), ['diary.post', 'diary.show', 'draw.create', 'message.create', 'message.delete', 'message.edit', 'message.react.add', 'message.react.remove']);
  for (const name of SELF_OWNED_OPS) assert.ok(skillRegistry().has(name), name);
  const member = { id: MEMBER };
  // a member with no right of their own on them: hers alone decides, owner-only diary included
  assert.deepEqual(check({ skill: 'diary.post', args: { kind: 'photos' }, granted: ['diary.post'], requester: member }), { ok: true });
  assert.deepEqual(check({ skill: 'diary.show', granted: ['diary.show'], requester: member }), { ok: true });
  assert.deepEqual(check({ skill: 'message.edit', args: { message: 'm1', text: 'σωστό' }, granted: ['message.edit'], requester: member }), { ok: true });
  assert.deepEqual(check({ skill: 'draw.create', args: { text: 'ένα δέντρο' }, granted: ['draw.create'], requester: member, images: imagesWith({}) }), { ok: true });
  // still closed until granted to her
  assert.equal(check({ skill: 'message.edit', args: { message: 'm1', text: 'σωστό' }, requester: member }).code, 'not-allowed');
  // nobody asked: only a read; several people asked: no write
  assert.deepEqual(check({ skill: 'diary.post', args: {}, granted: ['diary.post'], requester: null }), { ok: false, code: 'requester-denied', reason: 'no-requester' });
  assert.deepEqual(check({ skill: 'diary.show', granted: ['diary.show'], requester: null }), { ok: true });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' }, mixedRequesters: true }), { ok: false, code: 'requester-denied', reason: 'mixed-requesters' });
  // anything else still needs the requester's own right
  assert.deepEqual(check({ skill: 'lore.add', args: { title: 'Ά', keys: 'α', text: 'κ' }, granted: ['lore.add'], requester: member }), { ok: false, code: 'requester-denied', reason: 'not-granted' });
});

// ---- the gateway, check by check --------------------------------------------------------

test('skills gateway: an unknown skill or a non-persona principal is refused; arguments are checked against the schema', () => {
  assert.equal(check({ skill: 'message.pin' }).code, 'unknown-skill');
  const wrong = checkSkill({ skill: 'lore.list', args: {}, principal: { kind: 'member' }, requester: null, audience, context: { config: config() } });
  assert.equal(wrong.code, 'unknown-principal');
  const edit = (args) => check({ skill: 'message.edit', args, granted: ['message.edit'] });
  assert.deepEqual(edit({ message: 'm1', text: 'διορθωμένο' }), { ok: true });
  assert.deepEqual(edit({ message: 'm1' }), { ok: false, code: 'invalid-args', reason: 'args.text:required' });
  assert.deepEqual(edit({ message: 'm1', text: 'é'.repeat(2001) }), { ok: false, code: 'invalid-args', reason: 'args.text:max-length' });
  assert.deepEqual(edit({ message: 5, text: 'a' }), { ok: false, code: 'invalid-args', reason: 'args.message:type' });
  assert.deepEqual(edit({ message: 'm1', text: 'a', authorId: SELF }), { ok: false, code: 'invalid-args', reason: 'args.authorId:unknown' });
  assert.deepEqual(edit(null), { ok: false, code: 'invalid-args', reason: 'args:type' });
});

test('skills gateway: closed until the owner grants it to her; an owner-only operation runs only for an owner who asks', () => {
  assert.equal(check({ skill: 'memory.journal.read', args: {} }).code, 'not-allowed', 'default deny');
  assert.deepEqual(check({ skill: 'memory.journal.read', args: {}, granted: ['memory.journal.read'] }), { ok: true });
  assert.deepEqual(check({ skill: 'memory.journal.read', args: {}, granted: ['memory.journal.read'], requester: { id: MEMBER } }), { ok: false, code: 'requester-denied', reason: 'owner-only' });
  // even a grant of everything to the member opens no owner-only operation
  const everyone = { everyone: true, roles: [], users: [] };
  assert.deepEqual(check({ skill: 'memory.private.read', args: { user: MEMBER }, granted: ['memory.private.read'], requester: { id: MEMBER }, cfg: config({ access: { '*': everyone } }) }), { ok: false, code: 'requester-denied', reason: 'owner-only' });
  // a forged flag opens nothing: the right comes from bot.owners, read now
  assert.equal(check({ skill: 'memory.journal.read', args: {}, granted: ['memory.journal.read'], requester: { id: MEMBER, isOwner: true } }).reason, 'owner-only');
});

test('skills gateway: a member\'s own grants decide, as for their own slash command, roles included', () => {
  const lore = (requester, cfg = config()) => check({ skill: 'lore.add', args: { title: 'Ά', keys: 'α', text: 'κείμενο' }, granted: ['lore.add'], requester, cfg });
  assert.deepEqual(lore({ id: MEMBER }), { ok: false, code: 'requester-denied', reason: 'not-granted' });
  assert.deepEqual(lore({ id: MEMBER }, config({ access: { 'lore.add': { everyone: false, roles: [], users: [MEMBER] } } })), { ok: true });
  assert.deepEqual(lore({ id: MEMBER, roleIds: ['r-9'] }, config({ access: { 'lore.add': { everyone: false, roles: ['r-9'], users: [] } } })), { ok: true });
  assert.deepEqual(check({ skill: 'pings.set', args: { mode: 'off' }, granted: ['pings.set'], requester: { id: MEMBER } }), { ok: true }, 'a member operation is the member\'s own');
  assert.deepEqual(check({ skill: 'pings.set', args: { mode: 'loud' }, granted: ['pings.set'], requester: { id: MEMBER } }), { ok: false, code: 'invalid-args', reason: 'args.mode:enum' });
});

test('skills gateway: with no requester only a read runs, and only one open to everyone', () => {
  const everyone = (name) => config({ access: { [name]: { everyone: true, roles: [], users: [] } } });
  assert.deepEqual(check({ skill: 'lore.add', args: { title: 'Ά', keys: 'α', text: 'κείμενο' }, granted: ['lore.add'], requester: null, cfg: everyone('lore.add') }), { ok: false, code: 'requester-denied', reason: 'no-requester' });
  assert.deepEqual(check({ skill: 'lore.list', granted: ['lore.list'], requester: null }), { ok: false, code: 'requester-denied', reason: 'not-granted' });
  assert.deepEqual(check({ skill: 'lore.list', granted: ['lore.list'], requester: null, cfg: everyone('lore.list') }), { ok: true });
  assert.deepEqual(check({ skill: 'memory.private.read', args: { user: MEMBER }, granted: ['memory.private.read'], requester: null }), { ok: false, code: 'requester-denied', reason: 'owner-only' });
});

test('skills gateway: a turn answering several people runs no write; a read still runs', () => {
  assert.deepEqual(check({ skill: 'lore.add', args: { title: 'Ά', keys: 'α', text: 'κείμενο' }, granted: ['lore.add'], mixedRequesters: true }), { ok: false, code: 'requester-denied', reason: 'mixed-requesters' });
  assert.deepEqual(check({ skill: 'lore.list', granted: ['lore.list'], mixedRequesters: true }), { ok: true });
});

test('skills gateway: a destructive skill waits out its cooldown in a channel (skills.destructiveCooldownMinutes)', () => {
  const remove = (lastRunAt, cfg = config({ skills: { destructiveCooldownMinutes: 10 } })) => check({ skill: 'lore.remove', args: { id: 'l1' }, granted: ['lore.remove'], lastRunAt, now: 1_000_000, cfg });
  assert.deepEqual(remove(null), { ok: true });
  assert.deepEqual(remove(1_000_000 - 5 * 60_000), { ok: false, code: 'cooldown', reason: 'skills.destructiveCooldownMinutes' });
  assert.deepEqual(remove(1_000_000 - 5 * 60_000, config({ skills: { destructiveCooldownMinutes: 4 } })), { ok: true });
  // a write is no destructive call
  assert.deepEqual(check({ skill: 'lore.add', args: { title: 'Ά', keys: 'α', text: 'κ' }, granted: ['lore.add'], lastRunAt: 999_999, now: 1_000_000 }), { ok: true });
});

test('skills gateway: draw.create is paid -- the drawing budget applies, the requester\'s cap included', () => {
  const draw = (images, requester = { id: OWNER }) => check({ skill: 'draw.create', args: { text: 'ένα δέντρο' }, granted: ['draw.create'], images, requester });
  assert.deepEqual(draw(imagesWith({})), { ok: true });
  assert.deepEqual(draw(imagesWith({ spent: true })), { ok: false, code: 'daily-cap', reason: 'image.maxPerDay' });
  assert.deepEqual(draw(imagesWith({ userSpent: true })), { ok: false, code: 'daily-cap', reason: 'image.maxPerUserPerDay' });
  assert.deepEqual(draw(undefined), { ok: false, code: 'no-budget', reason: 'unavailable' });
  let asked = 'none';
  draw({ quota: ({ userId }) => { asked = userId; return { spent: false, userSpent: false }; } });
  assert.equal(asked, OWNER, 'the per-member cap is the requester\'s');
});

test('skills gateway: features.skills off refuses everything; safe mode lets only the carried-over calls pass', () => {
  const off = config({ features: { skills: false } });
  assert.deepEqual(check({ cfg: off, granted: ['lore.list'] }), { ok: false, code: 'skills-off', reason: 'features.skills' });
  assert.equal(check({ skill: 'message.pin', cfg: off }).code, 'skills-off');
  const safe = config({ skills: { safeMode: true } });
  assert.deepEqual(check({ granted: ['lore.list'], cfg: safe }), { ok: false, code: 'safe-mode', reason: 'skills.safeMode' });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' }, cfg: safe }), { ok: true });
  // a missing switch counts as on
  assert.deepEqual(check({ granted: ['lore.list'], cfg: { bot: { owners: [OWNER] } } }), { ok: true });
});

// ---- the catalogue view -----------------------------------------------------------------

test('skills list: one row per skill with its texts, allowed or not and why', () => {
  const cfg = granting(['message.edit', 'memory.wipe', 'diary.post', 'memory.private.read']);
  const texts = { 'message.create': { title: 'Στείλε', whenToUse: 'όταν θέλεις', whenNotToUse: 'όχι' } };
  const rows = listSkills({ config: cfg, selfId: SELF, texts, requester: { id: OWNER }, audience });
  assert.equal(rows.length, skillNames().length);
  const byName = new Map(rows.map((row) => [row.name, row]));
  const channel = { name: 'channel', required: false };
  const body = { name: 'text', required: true, body: true };
  const message = { name: 'message', required: true };
  assert.deepEqual(byName.get('message.create'), { name: 'message.create', title: 'Στείλε', whenToUse: 'όταν θέλεις', allowed: true, reason: 'carried-over', args: [channel, { name: 'reply', required: false }, body, { name: 'file', required: false }] });
  assert.deepEqual(byName.get('message.edit'), { name: 'message.edit', title: '', whenToUse: '', allowed: true, reason: 'allowed', args: [message, body, channel] });
  assert.deepEqual(byName.get('message.delete'), { name: 'message.delete', title: '', whenToUse: '', allowed: false, reason: 'not-allowed', args: [message, channel] });
  assert.deepEqual(byName.get('memory.wipe'), { name: 'memory.wipe', title: '', whenToUse: '', allowed: false, reason: 'not-grantable', args: [{ name: 'confirm', required: true }] });
  // an owner-only skill: allowed for an owner who asks, not for a member -- unless it is her own
  const row = (name, requester) => listSkills({ config: cfg, selfId: SELF, texts: {}, requester, audience }).find((entry) => entry.name === name);
  assert.deepEqual([row('memory.private.read', { id: OWNER }).allowed, row('memory.private.read', { id: OWNER }).reason], [true, 'allowed']);
  assert.deepEqual([row('memory.private.read', { id: MEMBER }).allowed, row('memory.private.read', { id: MEMBER }).reason], [false, 'requester-denied']);
  assert.deepEqual([row('diary.post', { id: MEMBER }).allowed, row('diary.post', { id: MEMBER }).reason], [true, 'allowed']);
  const off = listSkills({ config: granting(['message.edit'], config({ features: { skills: false } })), selfId: SELF, texts, requester: null, audience });
  assert.ok(off.every((row) => row.allowed === false && row.reason === 'skills-off'));
});

// ---- the owner grants a skill to her: /nep access grant|revoke with her as the user ------------

function makeEnv({ cfg = config(), roles = [] } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-skills-'));
  const hot = { config: cfg, prompts: { labels: {}, skills: {} }, promptSources: {}, rootDir, reloadConfig: () => true, reloadPrompts: () => true };
  const store = { state: { data: {}, markDirty() {} }, flush() {}, getUser: () => null, getGuild: () => ({}), updateGuild() {} };
  const me = { roles: { cache: new Map(roles.map((id) => [id, { id }])) } };
  const client = { user: { id: SELF }, guilds: { cache: new Map([['g1', { members: { me } }]]) } };
  const env = createOpsEnv({ hot, store, client, getGuildId: () => 'g1', now: () => Date.UTC(2026, 9, 14, 10, 0, 0) });
  /** `bot.access` as written to config.local.json. */
  const stored = () => {
    const file = path.join(rootDir, 'config.local.json');
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).bot?.access ?? {}) : {};
  };
  return { env, hot, store, client, stored, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test('persona grants: a grant to her user opens a skill by name, owner-only ones included; revoke closes it', async () => {
  const t = makeEnv();
  const owner = { env: t.env, guildId: 'g1', userId: OWNER, roleIds: [] };
  try {
    for (const name of ['diary.post', 'memory.private.read', 'message.edit', 'lore.add']) {
      const result = await runOp('access.grant', { command: name, userId: SELF }, owner);
      assert.equal(result.status, 'ok', `${name}: ${result.summary}`);
    }
    const access = t.stored();
    for (const name of ['diary.post', 'memory.private.read', 'message.edit', 'lore.add']) assert.deepEqual(access[name].users, [SELF], name);
    const diary = skillRegistry().get('diary.post');
    assert.deepEqual(skillAccess({ skill: diary, config: config({ access }), selfId: SELF }), { allowed: true, reason: 'allowed' });
    // for a person the owner-only operation stays closed, as before
    const person = await runOp('access.grant', { command: 'diary.post', userId: MEMBER }, owner);
    assert.deepEqual([person.status, person.summary], ['invalid', 'diary.post is owner-only and cannot be granted']);
    // `/nep access list` shows her grants like anyone's, owner-only ones included
    const list = (await runOp('access.list', {}, owner)).summary.split('\n');
    for (const name of ['diary.post', 'memory.private.read', 'message.edit', 'lore.add']) assert.ok(list.includes(`${name}: user id:${SELF}`), name);
    assert.equal((await runOp('access.revoke', { command: 'diary.post', userId: SELF }, owner)).status, 'ok');
    assert.equal(skillAccess({ skill: diary, config: config({ access: t.stored() }), selfId: SELF }).allowed, false);
    const unknown = await runOp('access.grant', { command: 'message.pin', userId: SELF }, owner);
    assert.deepEqual([unknown.status, unknown.code], ['invalid', 'unknown-skill']);
  } finally {
    t.cleanup();
  }
});

test('persona grants: an irreversible or administrative operation is refused for her with a clear message', async () => {
  const t = makeEnv();
  const owner = { env: t.env, guildId: 'g1', userId: OWNER, roleIds: [] };
  try {
    for (const name of NOT_GRANTABLE_TO_PERSONA) {
      const result = await runOp('access.grant', { command: name, userId: SELF }, owner);
      assert.deepEqual([result.status, result.code], ['invalid', 'not-grantable'], name);
      assert.match(result.summary, /cannot be granted to the persona yet/, name);
    }
    assert.deepEqual(t.stored(), {});
  } finally {
    t.cleanup();
  }
});

test('persona grants: a group or * opens her read skills under it, owner-only reads included, never a write', async () => {
  const t = makeEnv();
  const owner = { env: t.env, guildId: 'g1', userId: OWNER, roleIds: [] };
  try {
    assert.equal((await runOp('access.grant', { command: '*', userId: SELF }, owner)).status, 'ok');
    const access = t.stored();
    const reads = [...skillRegistry().values()].filter((skill) => skill.kind === 'read' && !NOT_GRANTABLE_TO_PERSONA.includes(skill.name)).map((skill) => skill.name);
    assert.deepEqual(Object.keys(access).sort(), [...reads].sort());
    for (const name of ['status.show', 'lore.list', 'memory.profile.read', 'memory.private.read', 'diary.show']) assert.ok(access[name], name);
    for (const name of ['message.edit', 'lore.add', 'memory.wipe', 'diary.post']) assert.equal(access[name], undefined, name);
    assert.deepEqual(access['lore.list'], { everyone: false, roles: [], users: [SELF], via: { [`user:${SELF}`]: '*' } });
    const t2 = makeEnv();
    try {
      await runOp('access.grant', { command: 'memory', userId: SELF }, { ...owner, env: t2.env });
      assert.ok(t2.stored()['memory.server.read']);
      assert.equal(t2.stored()['memory.wipe'], undefined);
    } finally {
      t2.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

test('persona grants: she never changes her effective authority -- not herself, not everyone, not a role she holds, not the governed config', async () => {
  const t = makeEnv({ roles: ['r-hers'] });
  const owner = { env: t.env, guildId: 'g1', userId: OWNER, roleIds: [] };
  const asPersona = { ...owner, actor: 'persona' };
  try {
    for (const [name, args] of [
      ['access.grant', { command: 'lore.add', userId: SELF }],
      ['access.grant', { command: 'lore.add' }],
      ['access.grant', { command: 'lore.add', roleId: 'r-hers' }],
      ['access.revoke', { command: 'lore.add', userId: SELF }],
    ]) {
      const result = await runOp(name, args, asPersona);
      assert.deepEqual([result.status, result.code], ['denied', 'self-grant'], `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(t.stored(), {}, 'nothing was written');
    // the governed keys, one list: owners, rights, her kill switch and safe mode, her skills, the journal
    for (const key of ['bot.owners', 'bot.access', 'features.skills', 'skills.safeMode', 'skills.callTimeoutMs', 'features.journal', 'features.memberCommands', 'bot']) assert.ok(governsPersona(key), key);
    for (const key of ['llm.maxRequestsPerDay', 'features.diary', 'bot.timezone']) assert.equal(governsPersona(key), false, key);
    assert.ok(PERSONA_GOVERNED_CONFIG.includes('features.skills'));
    const set = await runOp('config.set', { path: 'skills.safeMode', value: 'false' }, asPersona);
    assert.deepEqual([set.status, set.code], ['denied', 'self-grant']);
    const unset = await runOp('config.unset', { path: 'features.skills' }, asPersona);
    assert.deepEqual([unset.status, unset.code], ['denied', 'self-grant']);
    // someone else's role, for an owner who asked her: the normal path
    const other = await runOp('access.grant', { command: 'lore.add', roleId: 'r-other' }, asPersona);
    assert.equal(other.status, 'ok');
    // a member who asks her may not (access.grant is owner-only)
    const member = await runOp('access.grant', { command: 'lore.add', userId: MEMBER }, { ...asPersona, userId: MEMBER });
    assert.deepEqual([member.status, member.code], ['denied', 'owner-only']);
  } finally {
    t.cleanup();
  }
});

test('persona grants: an old grant on talk.interject or talk.initiate holds on message.create', () => {
  assert.deepEqual(RENAMED_OPS, { 'talk.interject': 'message.create', 'talk.initiate': 'message.create' });
  const before = {
    'talk.interject': { everyone: false, roles: ['r1'], users: [SELF] },
    'talk.initiate': { everyone: true, roles: [], users: [] },
    'lore.list': { everyone: true, roles: [], users: [] },
  };
  const after = renameGrants(before);
  assert.deepEqual(Object.keys(after).sort(), ['lore.list', 'message.create']);
  assert.deepEqual(after['message.create'], { everyone: true, roles: ['r1'], users: [SELF] });
  assert.equal(renameGrants(after), null, 'nothing left to rename');
  assert.equal(before['talk.interject'].users[0], SELF, 'the input is not changed');
});

// ---- the commands -------------------------------------------------------------------------

test('persona grants: no /nep skill command; the access autocomplete offers her skill names', async () => {
  const [command] = buildCommandTree('nep');
  assert.ok(command.options.length <= 25, `${command.options.length} top-level entries`);
  assert.equal(command.options.some((option) => option.name === 'skill' || option.name === 'talk'), false);
  for (const key of ['skill.allow', 'skill.deny', 'skill.list', 'talk']) assert.equal(resolveCommand(key, { name: 'draw' }), null, key);
  const t = makeEnv();
  try {
    const admin = createAdmin({ hot: t.hot, store: t.store, client: t.client, getGuildId: () => 'g1' });
    const handle = createInteractionHandler({ hot: t.hot, admin, getGuildId: () => 'g1' });
    const ask = async (userId, typed) => {
      const responses = [];
      await handle({
        guildId: 'g1',
        channelId: HERE,
        user: { id: userId },
        member: { roles: [] },
        isAutocomplete: () => true,
        options: { getSubcommandGroup: () => 'access', getSubcommand: () => 'grant', getFocused: () => ({ name: 'command', value: typed }) },
        respond: async (choices) => responses.push(choices),
      });
      return responses[0].map((choice) => choice.value);
    };
    assert.deepEqual(await ask(OWNER, 'MESSAGE.RE'), ['message.react.add', 'message.react.remove']);
    assert.deepEqual(await ask(OWNER, 'private'), ['memory.private.read', 'memory.private.forget', 'memory.private.purge']);
    assert.deepEqual(await ask(MEMBER, 'message'), []);
  } finally {
    t.cleanup();
  }
});
