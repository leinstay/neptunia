// Tests for src/tools/: the persona's skills ARE the owner's /nep commands (one skill per
// operation, derived from the command that runs it), the rights gateway, the catalogue view, the
// effect table, and how the owner opens a skill for her (`/nep access grant|revoke` with her as
// the user, src/tools/impl/access.ts), with the rule she never changes her own authority. Nothing here
// executes a skill: the gateway only answers whether one may run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOp } from '../src/tools/impl/index.ts';
import { listOps } from '../src/tools/impl/registry.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { EFFECT_CLASSES, OP_EFFECTS, SELF_OWNED_OPS } from '../src/tools/impl/effects.ts';
import { PERSONA_GOVERNED_CONFIG, governsPersona } from '../src/tools/impl/rights.ts';
import { RENAMED_OPS, renameGrants } from '../src/tools/impl/access.ts';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import {
  loadSkills,
  skillRegistry,
  skillNames,
  describeSkill,
  skillArgTexts,
  missingDefinitions,
} from '../src/tools/registry.ts';
import {
  CARRIED_OVER,
  FEATURE_SKILLS,
  NESTED_CAPABILITIES,
  NOT_GRANTABLE_TO_PERSONA,
  grantedToPersona,
  skillAccess,
  wakeEnvelope,
} from '../src/tools/access.ts';
import { executeCall } from '../src/tools/executors.ts';
import { postingConversation } from '../src/tools/impl/shared.ts';
import { schemaError } from '../src/tools/schema.ts';
import { checkReplyEffect, checkSkill, listSkills } from '../src/tools/gateway.ts';
import { tempDir } from './fixtures/tmp.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const OWNER = '42';
const MEMBER = '7';
const SELF = 'self-1';
const HERE = 'c-here';
const persona = Object.freeze({ kind: 'persona' });
const audience = Object.freeze({ conversationId: HERE, memberIds: [MEMBER] });

/** A config with the settings these tests read, each set here (never the shipped defaults). */
function config({ features = {}, tools = {}, access = {} } = {}) {
  return {
    features: { tools: true, journal: true, ...features },
    tools: { safeMode: false, ...tools },
    bot: { owners: [OWNER], access },
  };
}

/** `cfg` with each of `names` granted to the persona -- her user id in `bot.access[name].users` -- as `/nep access grant` stores it. */
function granting(names, cfg = config()) {
  const access = { ...(cfg.bot?.access ?? {}) };
  for (const name of names)
    access[name] = {
      everyone: access[name]?.everyone === true,
      roles: [...(access[name]?.roles ?? [])],
      users: [...(access[name]?.users ?? []), SELF],
    };
  return { ...cfg, bot: { ...(cfg.bot ?? {}), access } };
}

/** An images client whose quota answers `quota`. */
function imagesWith(quota) {
  return {
    quota: ({ userId } = {}) => ({
      used: 0,
      cap: 5,
      userUsed: 0,
      userCap: 2,
      spent: false,
      userSpent: false,
      ...quota,
      askedFor: userId,
    }),
  };
}

/** One gateway check of a skill of the real registry (default: lore.list for the owner). */
function check({
  skill = 'lore.list',
  args = {},
  requester = { id: OWNER },
  cfg = config(),
  granted = [],
  registry = skillRegistry(),
  images,
  mixedRequesters,
  lastRunAt,
  now,
} = {}) {
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
  return {
    name: 'x.read',
    family: 'x',
    op: null,
    argsSchema: { type: 'object', properties: {}, additionalProperties: false },
    effects: 'read',
    sharedState: false,
    costClass: 'free',
    targets: null,
    interfaceCapability: null,
    ...over,
  };
}

// ---- the catalogue: one skill per operation -------------------------------------------

test('skills registry: one skill per operation, of the same name, kind and ownerOnly inherited; no other skill exists', () => {
  const registry = skillRegistry();
  assert.deepEqual(
    [...registry.keys()],
    listOps().map((op) => op.name)
  );
  assert.deepEqual(
    skillNames(),
    listOps().map((op) => op.name)
  );
  for (const op of listOps()) {
    const skill = registry.get(op.name);
    assert.equal(skill.opBacked, true, op.name);
    assert.equal(skill.op, op.name, op.name);
    assert.equal(skill.kind, op.rights.kind, op.name);
    assert.equal(skill.ownerOnly, op.rights.ownerOnly === true, op.name);
    assert.equal(skill.family, op.name.split('.')[0], op.name);
  }
  // the old interface-only skills are gone; their abilities are operations behind commands
  for (const gone of [
    'draw',
    'memory.read',
    'message.send',
    'skills.list',
    'access.request',
    'talk.interject',
    'skill.allow',
  ])
    assert.equal(registry.has(gone), false, gone);
  for (const name of [
    'message.create',
    'message.edit',
    'message.delete',
    'message.react.add',
    'message.react.remove',
    'draw.create',
    'memory.profile.read',
    'status.show',
  ])
    assert.ok(registry.has(name), name);
  assert.equal(registry.get('memory.restore').ownerOnly, true);
  assert.equal(registry.get('draw.create').costClass, 'paid');
});

test('skills effects: one effect class per operation, by its actual effect, in one table', () => {
  for (const op of listOps()) assert.ok(EFFECT_CLASSES.includes(OP_EFFECTS[op.name]), `${op.name} has no effect class`);
  assert.deepEqual(
    Object.keys(OP_EFFECTS).sort(),
    listOps()
      .map((op) => op.name)
      .sort(),
    'no row for an operation that does not exist'
  );
  const of = (effect) =>
    Object.keys(OP_EFFECTS)
      .filter((name) => OP_EFFECTS[name] === effect)
      .sort();
  assert.deepEqual(of('destructive'), [
    'alias.remove',
    'learning.remove',
    'lore.remove',
    'memory.restore',
    'message.delete',
    'rule.remove',
  ]);
  for (const name of [
    'config.set',
    'config.unset',
    'model.set',
    'route.set',
    'route.remove',
    'access.grant',
    'access.revoke',
    'bot.pause',
    'bot.resume',
  ])
    assert.equal(OP_EFFECTS[name], 'administrative', name);
  assert.deepEqual(of('paid'), ['draw.create', 'errand.run', 'voice.say']);
  for (const op of listOps()) if (op.rights.kind === 'read') assert.equal(OP_EFFECTS[op.name], 'read', op.name);
  // a skill carries its operation's class
  assert.equal(skillRegistry().get('memory.restore').effects, 'destructive');
});

test('skills registry: a definition is checked at load; an owner-only operation loads with ownerOnly', () => {
  assert.throws(() => loadSkills([def({ op: 'no.such.op' })]), /unknown operation/);
  assert.throws(() => loadSkills([def(), def()]), /twice/);
  assert.throws(() => loadSkills([def({ effects: 'launch' })]), /effects/);
  assert.throws(() => loadSkills([def({ costClass: 'cheap' })]), /costClass/);
  assert.throws(() => loadSkills([def({ targets: 'everyone' })]), /targets/);
  assert.throws(() => loadSkills([def({ argsSchema: null })]), /argsSchema/);
  assert.throws(() => loadSkills([def({ dispatch: { op: 'x' } })]), /toOp/);
  const ops = { 'fake.op': { name: 'fake.op', rights: { kind: 'write', ownerOnly: true } } };
  assert.deepEqual(
    [...loadSkills([def({ op: 'fake.op' })], { getOp: (name) => ops[name] ?? null }).values()].map((skill) => [
      skill.kind,
      skill.ownerOnly,
    ]),
    [['write', true]]
  );
});

test('skills registry: the texts come from config/tools.json by operation name; a skill without them has empty texts', () => {
  const skill = skillRegistry().get('message.edit');
  const texts = { 'message.edit': { title: 'Διόρθωση', whenToUse: 'όταν', whenNotToUse: 'ποτέ' } };
  assert.deepEqual(
    ['title', 'whenToUse', 'whenNotToUse'].map((key) => describeSkill(skill, texts)[key]),
    ['Διόρθωση', 'όταν', 'ποτέ']
  );
  assert.deepEqual(
    ['title', 'whenToUse', 'whenNotToUse'].map((key) => describeSkill(skillRegistry().get('memory.restore'), {})[key]),
    ['', '', '']
  );
  assert.equal(describeSkill(skill, undefined).title, '');
});

test('skills registry: every `args` key of config/tools.json names a property of its skill (skillArgTexts keeps them all)', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'tools.json');
  const texts = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [name, entry] of Object.entries(texts)) {
    if (entry?.args === undefined) continue;
    const skill = skillRegistry().get(name);
    assert.ok(skill, `${name}: no such skill`);
    assert.deepEqual(
      Object.keys(skillArgTexts(skill, texts)).sort(),
      Object.keys(entry.args).sort(),
      `${name}: an args key that is no property, or an empty text`
    );
  }
});

test('skills registry: missingDefinitions names the table entries with no registered skill, none when whole', () => {
  assert.deepEqual(missingDefinitions(skillRegistry()), []);
  const partial = new Map([...skillRegistry()].filter(([name]) => name !== 'lore.list' && name !== 'errand.run'));
  assert.deepEqual(missingDefinitions(partial).sort(), ['errand.run', 'lore.list']);
});

test('skills registry: config/tools.json has the title and when-to-use of every operation (when-not-to-use optional), and no key that is not one', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'tools.json');
  const texts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ops = listOps().map((op) => op.name);
  for (const name of ops) {
    for (const key of ['title', 'whenToUse']) {
      assert.equal(typeof texts[name]?.[key], 'string', `${name}.${key}`);
      assert.ok(texts[name][key].trim(), `${name}.${key} is empty`);
    }
    // `whenNotToUse` is optional: left out where it would say nothing the title does not.
    if (texts[name] && Object.hasOwn(texts[name], 'whenNotToUse'))
      assert.ok(String(texts[name].whenNotToUse).trim(), `${name}.whenNotToUse is empty`);
  }
  assert.deepEqual(
    Object.keys(texts).filter((name) => !ops.includes(name)),
    [],
    'a key that is no operation'
  );
  assert.equal(Object.hasOwn(texts, 'memory.affinity.set'), false);
});

test('skills schemas: her own table gives each skill its arguments', () => {
  const props = (name) => Object.keys(skillRegistry().get(name).argsSchema.properties);
  assert.deepEqual(props('memory.profile.read').slice(0, 1), ['user']);
  assert.deepEqual(props('media.status'), ['kind']);
  assert.deepEqual(props('media.recache'), ['kind', 'days']);
  const create = skillRegistry().get('message.create');
  assert.deepEqual(Object.keys(create.argsSchema.properties), [
    'channel',
    'reply',
    'text',
    'file',
    'gif',
    'media',
    'item',
    // Stage 3 design, section 10: her diary in place of a channel.
    'diary',
  ]);
  assert.deepEqual(create.argsSchema.required, []);
  assert.equal(create.dispatch.body, 'text');
  assert.ok(Object.hasOwn(skillRegistry().get('draw.create').argsSchema.properties, 'channel'));
  assert.deepEqual(skillRegistry().get('draw.create').argsSchema.properties.self, { type: 'boolean' });
  assert.deepEqual(skillRegistry().get('lore.add').argsSchema.properties.always, { type: 'boolean' });
  assert.deepEqual(skillRegistry().get('route.set').argsSchema.properties.fallbacks, { type: 'boolean' });
  assert.equal(
    skillRegistry().get('lore.add').dispatch.toOp({ title: 't', keys: 'k', text: 'x', always: true }).args.always,
    true
  );
  assert.equal(
    skillRegistry().get('lore.add').dispatch.toOp({ title: 't', keys: 'k', text: 'x', always: false }).args.always,
    false
  );
  assert.deepEqual(props('status.show'), ['field', 'part']);
});

test('skills memory.search: the window arguments of her call reach the operation', () => {
  const search = skillRegistry().get('memory.search');
  for (const name of ['anchor', 'move', 'messages', 'minutes'])
    assert.ok(Object.hasOwn(search.argsSchema.properties, name), name);
  const call = search.dispatch.toOp({ anchor: '#3', move: 'up', messages: 5, minutes: 30 });
  assert.equal(call.op, 'memory.search');
  assert.deepEqual(
    { anchor: call.args.anchor, move: call.args.move, messages: call.args.messages, minutes: call.args.minutes },
    { anchor: '#3', move: 'up', messages: 5, minutes: 30 }
  );
});

test('skills schema: types, bounds, enums, arrays and anyOf', () => {
  const schema = {
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 1, maximum: 3 },
      kind: { type: 'string', enum: ['a', 'b'] },
      ids: { type: 'array', maxItems: 2, items: { type: 'string' } },
      on: { type: 'boolean' },
    },
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
  assert.deepEqual(skillAccess({ skill: edit, config: granting(['message.edit']), selfId: SELF }), {
    allowed: true,
    reason: 'allowed',
  });
  assert.equal(
    skillAccess({ skill: edit, config: granting(['message.edit']), selfId: null }).allowed,
    false,
    'no id of hers, no grant'
  );
  // a grant to everyone or to a role is people's: it opens nothing for her
  const everyone = config({ access: { 'message.edit': { everyone: true, roles: ['r1'], users: [MEMBER] } } });
  assert.equal(skillAccess({ skill: edit, config: everyone, selfId: SELF }).allowed, false);
  assert.equal(
    grantedToPersona(config({ access: { 'message.edit': { users: 'self-1' } } }), SELF, 'message.edit'),
    false,
    'a malformed grant reads as none'
  );
});

test('skills access: the irreversible and administrative operations are never open to her, whatever is stored', () => {
  assert.deepEqual([...NOT_GRANTABLE_TO_PERSONA].sort(), [
    'access.grant',
    'access.revoke',
    'bot.pause',
    'bot.resume',
    'config.set',
    'config.unset',
    'inner.start',
    'inner.stop',
    'memory.restore',
    'model.set',
    'route.remove',
    'route.set',
    'rule.remove',
  ]);
  assert.equal(NOT_GRANTABLE_TO_PERSONA.includes('rule.add'), false, 'adding a rule stays grantable');
  for (const name of NOT_GRANTABLE_TO_PERSONA) {
    // The inner life's switch on, so its kill switch exists to be refused (src/tools/access.ts#FEATURE_SKILLS).
    assert.deepEqual(
      skillAccess({
        skill: skillRegistry().get(name),
        config: granting([name], config({ features: { innerLife: true } })),
        selfId: SELF,
      }),
      { allowed: false, reason: 'not-grantable' },
      name
    );
  }
  assert.deepEqual(check({ skill: 'memory.restore', args: { id: 'ep-1' }, granted: ['memory.restore'] }), {
    ok: false,
    code: 'not-grantable',
    reason: 'memory.restore',
  });
});

test('skills access: her reply tags are carried over in the current conversation, without a grant, even in safe mode', () => {
  assert.deepEqual([...CARRIED_OVER].sort(), ['draw.create', 'message.create', 'message.react.add', 'voice.say']);
  for (const skill of CARRIED_OVER) {
    assert.deepEqual(checkReplyEffect({ skill, principal: persona, config: config() }), { ok: true }, skill);
    assert.deepEqual(
      checkReplyEffect({ skill, principal: persona, config: config({ tools: { safeMode: true } }) }),
      { ok: true },
      skill
    );
    assert.deepEqual(
      checkReplyEffect({ skill, principal: persona, config: config({ features: { tools: false } }) }),
      { ok: false, code: 'skills-off', reason: 'features.tools' },
      skill
    );
  }
  assert.equal(
    checkReplyEffect({ skill: 'message.delete', principal: persona, config: config() }).code,
    'unknown-skill'
  );
  assert.equal(
    checkReplyEffect({ skill: 'message.create', principal: { kind: 'member' }, config: config() }).code,
    'unknown-principal'
  );
  // a call of hers in the current conversation is carried over too
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' } }), { ok: true });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια', channel: 'c-other' } }), {
    ok: false,
    code: 'not-allowed',
    reason: 'message.create',
  });
  assert.deepEqual(
    check({ skill: 'message.create', args: { text: 'γεια' }, requester: { id: MEMBER } }),
    { ok: true },
    'her own message, whoever asked'
  );
});

test('skills gateway: her own expressive operations need only her grant, whoever asked; the rules on who asked still hold', () => {
  assert.deepEqual([...SELF_OWNED_OPS].sort(), [
    'draw.create',
    'intention.cancel',
    'intention.list',
    'intention.set',
    'intention.update',
    'message.create',
    'message.delete',
    'message.edit',
    'message.react.add',
    'message.react.remove',
    'voice.say',
  ]);
  for (const name of SELF_OWNED_OPS) assert.ok(skillRegistry().has(name), name);
  const member = { id: MEMBER };
  // a member with no right of their own on them: hers alone decides
  assert.deepEqual(
    check({
      skill: 'message.edit',
      args: { message: 'm1', text: 'σωστό' },
      granted: ['message.edit'],
      requester: member,
    }),
    { ok: true }
  );
  assert.deepEqual(
    check({
      skill: 'draw.create',
      args: { text: 'ένα δέντρο' },
      granted: ['draw.create'],
      requester: member,
      images: imagesWith({}),
    }),
    { ok: true }
  );
  // still closed until granted to her
  assert.equal(
    check({ skill: 'message.edit', args: { message: 'm1', text: 'σωστό' }, requester: member }).code,
    'not-allowed'
  );
  // nobody asked: only a read; several people asked: no write
  assert.deepEqual(
    check({
      skill: 'message.edit',
      args: { message: 'm1', text: 'σωστό' },
      granted: ['message.edit'],
      requester: null,
    }),
    { ok: false, code: 'no-requester', reason: 'no-requester' }
  );
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' }, mixedRequesters: true }), {
    ok: false,
    code: 'mixed-requesters',
    reason: 'mixed-requesters',
  });
  // anything else still needs the requester's own right
  assert.deepEqual(
    check({ skill: 'lore.add', args: { title: 'Ά', keys: 'α', text: 'κ' }, granted: ['lore.add'], requester: member }),
    { ok: false, code: 'requester-denied', reason: 'not-granted' }
  );
});

// ---- the gateway, check by check --------------------------------------------------------

test('skills gateway: an unknown skill or a non-persona principal is refused; arguments are checked against the schema', () => {
  assert.equal(check({ skill: 'message.pin' }).code, 'unknown-skill');
  const wrong = checkSkill({
    skill: 'lore.list',
    args: {},
    principal: { kind: 'member' },
    requester: null,
    audience,
    context: { config: config() },
  });
  assert.equal(wrong.code, 'unknown-principal');
  const edit = (args) => check({ skill: 'message.edit', args, granted: ['message.edit'] });
  assert.deepEqual(edit({ message: 'm1', text: 'διορθωμένο' }), { ok: true });
  assert.deepEqual(edit({ message: 'm1' }), { ok: false, code: 'invalid-args', reason: 'args.text:required' });
  assert.deepEqual(edit({ message: 'm1', text: 'é'.repeat(2001) }), {
    ok: false,
    code: 'invalid-args',
    reason: 'args.text:max-length',
  });
  assert.deepEqual(edit({ message: 5, text: 'a' }), { ok: false, code: 'invalid-args', reason: 'args.message:type' });
  assert.deepEqual(edit({ message: 'm1', text: 'a', authorId: SELF }), {
    ok: false,
    code: 'invalid-args',
    reason: 'args.authorId:unknown',
  });
  assert.deepEqual(edit(null), { ok: false, code: 'invalid-args', reason: 'args:type' });
});

test('skills gateway: closed until the owner grants it to her; an owner-only operation runs only for an owner who asks', () => {
  assert.equal(check({ skill: 'memory.journal.read', args: {} }).code, 'not-allowed', 'default deny');
  assert.deepEqual(check({ skill: 'memory.journal.read', args: {}, granted: ['memory.journal.read'] }), { ok: true });
  assert.deepEqual(
    check({ skill: 'memory.journal.read', args: {}, granted: ['memory.journal.read'], requester: { id: MEMBER } }),
    { ok: false, code: 'requester-denied', reason: 'owner-only' }
  );
  // even a grant of everything to the member opens no owner-only operation
  const everyone = { everyone: true, roles: [], users: [] };
  assert.deepEqual(
    check({
      skill: 'memory.private.read',
      args: { user: MEMBER },
      granted: ['memory.private.read'],
      requester: { id: MEMBER },
      cfg: config({ access: { '*': everyone } }),
    }),
    { ok: false, code: 'requester-denied', reason: 'owner-only' }
  );
  // a forged flag opens nothing: the right comes from bot.owners, read now
  assert.equal(
    check({
      skill: 'memory.journal.read',
      args: {},
      granted: ['memory.journal.read'],
      requester: { id: MEMBER, isOwner: true },
    }).reason,
    'owner-only'
  );
});

test("skills gateway: a member's own grants decide, as for their own slash command, roles included", () => {
  const lore = (requester, cfg = config()) =>
    check({
      skill: 'lore.add',
      args: { title: 'Ά', keys: 'α', text: 'κείμενο' },
      granted: ['lore.add'],
      requester,
      cfg,
    });
  assert.deepEqual(lore({ id: MEMBER }), { ok: false, code: 'requester-denied', reason: 'not-granted' });
  assert.deepEqual(
    lore({ id: MEMBER }, config({ access: { 'lore.add': { everyone: false, roles: [], users: [MEMBER] } } })),
    { ok: true }
  );
  assert.deepEqual(
    lore(
      { id: MEMBER, roleIds: ['r-9'] },
      config({ access: { 'lore.add': { everyone: false, roles: ['r-9'], users: [] } } })
    ),
    { ok: true }
  );
  assert.deepEqual(
    check({ skill: 'pings.set', args: { mode: 'off' }, granted: ['pings.set'], requester: { id: MEMBER } }),
    { ok: true },
    "a member operation is the member's own"
  );
  assert.deepEqual(
    check({ skill: 'pings.set', args: { mode: 'loud' }, granted: ['pings.set'], requester: { id: MEMBER } }),
    { ok: false, code: 'invalid-args', reason: 'args.mode:enum' }
  );
});

test('skills gateway: with no requester only a read runs, and only one open to everyone', () => {
  const everyone = (name) => config({ access: { [name]: { everyone: true, roles: [], users: [] } } });
  assert.deepEqual(
    check({
      skill: 'lore.add',
      args: { title: 'Ά', keys: 'α', text: 'κείμενο' },
      granted: ['lore.add'],
      requester: null,
      cfg: everyone('lore.add'),
    }),
    { ok: false, code: 'no-requester', reason: 'no-requester' }
  );
  assert.deepEqual(check({ skill: 'lore.list', granted: ['lore.list'], requester: null }), {
    ok: false,
    code: 'requester-denied',
    reason: 'not-granted',
  });
  assert.deepEqual(check({ skill: 'lore.list', granted: ['lore.list'], requester: null, cfg: everyone('lore.list') }), {
    ok: true,
  });
  assert.deepEqual(
    check({ skill: 'memory.private.read', args: { user: MEMBER }, granted: ['memory.private.read'], requester: null }),
    { ok: false, code: 'requester-denied', reason: 'owner-only' }
  );
});

test('skills gateway: a turn answering several people runs no write; a read still runs', () => {
  assert.deepEqual(
    check({
      skill: 'lore.add',
      args: { title: 'Ά', keys: 'α', text: 'κείμενο' },
      granted: ['lore.add'],
      mixedRequesters: true,
    }),
    { ok: false, code: 'mixed-requesters', reason: 'mixed-requesters' }
  );
  assert.deepEqual(check({ skill: 'lore.list', granted: ['lore.list'], mixedRequesters: true }), { ok: true });
});

test('skills gateway: a destructive skill waits out its cooldown in a channel (tools.destructiveCooldownMinutes)', () => {
  const remove = (lastRunAt, cfg = config({ tools: { destructiveCooldownMinutes: 10 } })) =>
    check({ skill: 'lore.remove', args: { id: 'l1' }, granted: ['lore.remove'], lastRunAt, now: 1_000_000, cfg });
  assert.deepEqual(remove(null), { ok: true });
  assert.deepEqual(remove(1_000_000 - 5 * 60_000), {
    ok: false,
    code: 'cooldown',
    reason: 'tools.destructiveCooldownMinutes',
  });
  assert.deepEqual(remove(1_000_000 - 5 * 60_000, config({ tools: { destructiveCooldownMinutes: 4 } })), { ok: true });
  // a write is no destructive call
  assert.deepEqual(
    check({
      skill: 'lore.add',
      args: { title: 'Ά', keys: 'α', text: 'κ' },
      granted: ['lore.add'],
      lastRunAt: 999_999,
      now: 1_000_000,
    }),
    { ok: true }
  );
});

test("skills gateway: draw.create is paid -- the drawing budget applies, the requester's cap included", () => {
  const draw = (images, requester = { id: OWNER }) =>
    check({ skill: 'draw.create', args: { text: 'ένα δέντρο' }, granted: ['draw.create'], images, requester });
  assert.deepEqual(draw(imagesWith({})), { ok: true });
  assert.deepEqual(draw(imagesWith({ spent: true })), { ok: false, code: 'daily-cap', reason: 'image.maxPerDay' });
  assert.deepEqual(draw(imagesWith({ userSpent: true })), {
    ok: false,
    code: 'daily-cap',
    reason: 'image.maxPerUserPerDay',
  });
  assert.deepEqual(draw(undefined), { ok: false, code: 'no-budget', reason: 'unavailable' });
  let asked = 'none';
  draw({
    quota: ({ userId }) => {
      asked = userId;
      return { spent: false, userSpent: false };
    },
  });
  assert.equal(asked, OWNER, "the per-member cap is the requester's");
});

test('skills gateway: features.tools off refuses everything; safe mode lets only the carried-over calls pass', () => {
  const off = config({ features: { tools: false } });
  assert.deepEqual(check({ cfg: off, granted: ['lore.list'] }), {
    ok: false,
    code: 'skills-off',
    reason: 'features.tools',
  });
  assert.equal(check({ skill: 'message.pin', cfg: off }).code, 'skills-off');
  const safe = config({ tools: { safeMode: true } });
  assert.deepEqual(check({ granted: ['lore.list'], cfg: safe }), {
    ok: false,
    code: 'safe-mode',
    reason: 'tools.safeMode',
  });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' }, cfg: safe }), { ok: true });
  // a missing switch counts as on
  assert.deepEqual(check({ granted: ['lore.list'], cfg: { bot: { owners: [OWNER] } } }), { ok: true });
});

// ---- wake envelopes (innerLife.wakes.<kind>) ------------------------------------------

/** One gateway check of an inner turn's call: her own initiative, nobody asked, `wakeKind` and the calls so far. */
function innerCheck({
  skill,
  args = {},
  wakes = {},
  wakeKind = 'heartbeat',
  wakeActions = [],
  granted = [],
  features = {},
}) {
  const cfg = granting(granted, { ...config({ features }), innerLife: { wakes } });
  return checkSkill({
    skill,
    args,
    principal: persona,
    requester: null,
    audience,
    context: { config: cfg, selfId: SELF, registry: skillRegistry(), ownInitiative: true, wakeKind, wakeActions },
  });
}

test('wake envelope: "*" with no caps, or no envelope at all, is today\'s behaviour', () => {
  assert.deepEqual(wakeEnvelope({}, 'heartbeat'), { tools: '*', maxActs: null, maxTasks: null, inputTokens: null });
  assert.deepEqual(
    wakeEnvelope(
      { innerLife: { wakes: { review: { tools: ['a.b'], maxActs: 2, maxTasks: 0, inputTokens: 6000 } } } },
      'review'
    ),
    { tools: ['a.b'], maxActs: 2, maxTasks: 0, inputTokens: 6000 }
  );
  for (const wakes of [{}, { heartbeat: { tools: '*', maxActs: null, maxTasks: null, inputTokens: null } }]) {
    assert.deepEqual(innerCheck({ skill: 'message.create', args: { text: 'γεια' }, wakes }), { ok: true });
    assert.deepEqual(innerCheck({ skill: 'lore.list', granted: ['lore.list'], wakes }), { ok: true });
  }
});

test('wake envelope: a tool outside the allowlist is refused at the call, carried-over tags included; a family entry opens the family', () => {
  const wakes = { heartbeat: { tools: ['lore.list', 'intention.*'] } };
  assert.deepEqual(innerCheck({ skill: 'message.create', args: { text: 'γεια' }, wakes }), {
    ok: false,
    code: 'not-allowed',
    reason: 'innerLife.wakes.heartbeat.tools',
  });
  assert.deepEqual(innerCheck({ skill: 'lore.list', granted: ['lore.list'], wakes }), { ok: true });
  assert.deepEqual(
    innerCheck({
      skill: 'intention.set',
      args: { text: 'ρωτήσω αύριο' },
      granted: ['intention.set'],
      features: { intentions: true },
      wakes,
    }),
    { ok: true }
  );
  // Another wake kind has its own envelope (here none: everything as before).
  assert.deepEqual(innerCheck({ skill: 'message.create', args: { text: 'γεια' }, wakes, wakeKind: 'review' }), {
    ok: true,
  });
  // Not an inner turn: no envelope applies.
  const cfg = granting([], { ...config(), innerLife: { wakes } });
  assert.deepEqual(
    checkSkill({
      skill: 'message.create',
      args: { text: 'γεια' },
      principal: persona,
      requester: { id: OWNER },
      audience,
      context: { config: cfg, selfId: SELF, wakeKind: 'heartbeat' },
    }),
    { ok: true }
  );
});

test('wake envelope: maxActs counts the calls that changed something, maxTasks the errands; reads stay free', () => {
  const wakes = { improvement: { maxActs: 1, maxTasks: 0 } };
  const done = [
    { skill: 'lore.list', status: 'executed' },
    { skill: 'intention.set', status: 'proposed' },
    { skill: 'message.create', status: 'refused' },
  ];
  assert.deepEqual(
    innerCheck({ skill: 'message.create', args: { text: 'γεια' }, wakes, wakeKind: 'improvement', wakeActions: done }),
    { ok: false, code: 'not-allowed', reason: 'innerLife.wakes.improvement.maxActs' }
  );
  assert.deepEqual(
    innerCheck({ skill: 'lore.list', granted: ['lore.list'], wakes, wakeKind: 'improvement', wakeActions: done }),
    { ok: true }
  );
  assert.deepEqual(
    innerCheck({
      skill: 'message.create',
      args: { text: 'γεια' },
      wakes,
      wakeKind: 'improvement',
      wakeActions: done.slice(0, 1),
    }),
    { ok: true }
  );
  assert.deepEqual(
    innerCheck({
      skill: 'errand.run',
      args: { agent: 'scout', goal: 'βρες' },
      granted: ['errand.run'],
      wakes: { improvement: { maxTasks: 0 } },
      wakeKind: 'improvement',
    }),
    { ok: false, code: 'not-allowed', reason: 'innerLife.wakes.improvement.maxTasks' }
  );
});

test('wake envelope: a skill that posts inside its own operation is refused at the nested capability, before anything runs', async () => {
  assert.deepEqual(NESTED_CAPABILITIES['draw.create'], ['message.create']);
  const registry = skillRegistry();
  const resolved = {
    skill: 'draw.create',
    args: { text: 'ένα δέντρο' },
    dispatch: registry.get('draw.create').dispatch,
  };
  let ran = 0;
  const deps = (tools) => ({
    envelope: { ownInitiative: true, wakeKind: 'heartbeat', requester: null },
    // draw.create is one of her own expressive operations: it runs through runOwnOp.
    runOwnOp: async () => {
      ran += 1;
      return { status: 'ok', code: 'ok', summary: 'drawn', data: {} };
    },
    opContext: { guildId: 'g1', channelId: HERE },
    config: { innerLife: { wakes: { heartbeat: { tools } } } },
  });
  const refused = await executeCall(resolved, deps(['draw.create']));
  assert.equal(refused.status, 'denied');
  assert.equal(refused.code, 'not-allowed');
  assert.equal(refused.reason, 'innerLife.wakes.heartbeat.tools');
  assert.equal(ran, 0, 'nothing paid is made for a post the envelope forbids');
  assert.equal((await executeCall(resolved, deps(['draw.create', 'message.create']))).status, 'ok');
  assert.equal((await executeCall(resolved, deps('*'))).status, 'ok');
  assert.equal(ran, 2);
  // The posting point of the operations asks again: a send is refused, a read is not a post.
  const context = {
    channelId: HERE,
    ownInitiative: true,
    wakeKind: 'heartbeat',
    env: { hot: { config: { innerLife: { wakes: { heartbeat: { tools: ['voice.say'] } } } } } },
  };
  await assert.rejects(
    postingConversation({ client: null, discord: DISCORD, guildId: 'g1', channelId: null, context, need: 'attach' }),
    (error) => error.status === 'denied' && error.code === 'not-allowed'
  );
  assert.equal(
    await postingConversation({
      client: null,
      discord: DISCORD,
      guildId: 'g1',
      channelId: null,
      context,
      need: 'read',
    }),
    HERE
  );
  assert.equal(
    await postingConversation({
      client: null,
      discord: DISCORD,
      guildId: 'g1',
      channelId: null,
      context: { ...context, ownInitiative: false },
      need: 'send',
    }),
    HERE,
    'not her own initiative: no envelope'
  );
});

// ---- the catalogue view -----------------------------------------------------------------

test('skills list: one row per skill with its texts, allowed or not and why', () => {
  const cfg = granting(['message.edit', 'memory.restore', 'draw.create', 'memory.private.read']);
  const texts = { 'message.create': { title: 'Στείλε', whenToUse: 'όταν θέλεις', whenNotToUse: 'όχι' } };
  const rows = listSkills({ config: cfg, selfId: SELF, texts, requester: { id: OWNER }, audience });
  // A skill behind a feature switch that is off has no row (src/tools/access.ts#FEATURE_SKILLS).
  assert.equal(rows.length, skillNames().filter((name) => !Object.hasOwn(FEATURE_SKILLS, name)).length);
  const byName = new Map(rows.map((row) => [row.name, row]));
  const channel = { name: 'channel', required: false };
  const body = { name: 'text', required: true };
  const message = { name: 'message', required: true };
  assert.deepEqual(byName.get('message.create'), {
    name: 'message.create',
    title: 'Στείλε',
    whenToUse: 'όταν θέλεις',
    allowed: true,
    reason: 'carried-over',
    args: [
      channel,
      { name: 'reply', required: false },
      { name: 'text', required: false },
      { name: 'file', required: false },
      { name: 'gif', required: false },
      { name: 'media', required: false },
      { name: 'item', required: false, minimum: 1, maximum: 20 },
      // Stage 3 design, section 10: her diary in place of a channel, a string choice.
      { name: 'diary', required: false, values: ['true', 'false'] },
    ],
  });
  assert.deepEqual(byName.get('message.edit'), {
    name: 'message.edit',
    title: '',
    whenToUse: '',
    allowed: true,
    reason: 'allowed',
    args: [message, body, channel],
  });
  assert.deepEqual(byName.get('message.delete'), {
    name: 'message.delete',
    title: '',
    whenToUse: '',
    allowed: false,
    reason: 'not-allowed',
    args: [message, channel],
  });
  assert.deepEqual(byName.get('memory.restore'), {
    name: 'memory.restore',
    title: '',
    whenToUse: '',
    allowed: false,
    reason: 'not-grantable',
    args: [{ name: 'id', required: true }],
  });
  // an owner-only skill: allowed for an owner who asks, not for a member -- unless it is her own
  const row = (name, requester) =>
    listSkills({ config: cfg, selfId: SELF, texts: {}, requester, audience }).find((entry) => entry.name === name);
  assert.deepEqual(
    [row('memory.private.read', { id: OWNER }).allowed, row('memory.private.read', { id: OWNER }).reason],
    [true, 'allowed']
  );
  assert.deepEqual(
    [row('memory.private.read', { id: MEMBER }).allowed, row('memory.private.read', { id: MEMBER }).reason],
    [false, 'requester-denied']
  );
  assert.deepEqual(
    [row('message.edit', { id: MEMBER }).allowed, row('message.edit', { id: MEMBER }).reason],
    [true, 'allowed']
  );
  const off = listSkills({
    config: granting(['message.edit'], config({ features: { tools: false } })),
    selfId: SELF,
    texts,
    requester: null,
    audience,
  });
  assert.ok(off.every((row) => row.allowed === false && row.reason === 'skills-off'));
});

// ---- the owner grants a skill to her: /nep access grant|revoke with her as the user ------------

function makeEnv({ cfg = config(), roles = [] } = {}) {
  const rootDir = tempDir('nep-skills-');
  const hot = {
    config: cfg,
    prompts: { labels: {}, tools: {} },
    promptSources: {},
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const store = {
    state: { data: {}, markDirty() {} },
    flush() {},
    getUser: () => null,
    getGuild: () => ({}),
    updateGuild() {},
  };
  // The interface says who the persona is and which groups she holds (`memberInfo`).
  const client = {};
  const reads = {
    /** @param {{ memberId: string }} ask */
    memberInfo: ({ memberId }) =>
      Promise.resolve({
        member: {
          id: memberId,
          name: null,
          bot: false,
          groupIds: roles,
          avatar: { hash: null, url: null, largeUrl: null },
        },
      }),
  };
  const env = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    reads,
    selfId: () => SELF,
    getGuildId: () => 'g1',
    now: () => Date.UTC(2026, 9, 14, 10, 0, 0),
  });
  /** `bot.access` as written to the private settings file (PR 7c: config.local/config.json). */
  const stored = () => {
    const file = path.join(rootDir, 'config.local', 'config.json');
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).bot?.access ?? {}) : {};
  };
  return { env, hot, store, client, stored, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test('persona grants: a grant to her user opens a skill by name, owner-only ones included; revoke closes it', async () => {
  const t = makeEnv();
  const owner = { env: t.env, guildId: 'g1', userId: OWNER, roleIds: [] };
  try {
    for (const name of ['memory.private.read', 'message.edit', 'lore.add']) {
      const result = await runOp('access.grant', { command: name, userId: SELF }, owner);
      assert.equal(result.status, 'ok', `${name}: ${result.summary}`);
    }
    const access = t.stored();
    for (const name of ['memory.private.read', 'message.edit', 'lore.add'])
      assert.deepEqual(access[name].users, [SELF], name);
    const privateRead = skillRegistry().get('memory.private.read');
    assert.deepEqual(skillAccess({ skill: privateRead, config: config({ access }), selfId: SELF }), {
      allowed: true,
      reason: 'allowed',
    });
    // for a person the owner-only operation stays closed, as before
    const person = await runOp('access.grant', { command: 'memory.private.read', userId: MEMBER }, owner);
    assert.deepEqual(
      [person.status, person.summary],
      ['invalid', 'memory.private.read is owner-only and cannot be granted']
    );
    // `/nep access list` shows her grants like anyone's, owner-only ones included
    const list = (await runOp('access.list', {}, owner)).summary.split('\n');
    for (const name of ['memory.private.read', 'message.edit', 'lore.add'])
      assert.ok(list.includes(`${name}: user id:${SELF}`), name);
    assert.equal((await runOp('access.revoke', { command: 'memory.private.read', userId: SELF }, owner)).status, 'ok');
    assert.equal(
      skillAccess({ skill: privateRead, config: config({ access: t.stored() }), selfId: SELF }).allowed,
      false
    );
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
    const reads = [...skillRegistry().values()]
      .filter((skill) => skill.kind === 'read' && !NOT_GRANTABLE_TO_PERSONA.includes(skill.name))
      .map((skill) => skill.name);
    assert.deepEqual(Object.keys(access).sort(), [...reads].sort());
    for (const name of ['status.show', 'lore.list', 'memory.profile.read', 'memory.private.read', 'intention.list'])
      assert.ok(access[name], name);
    for (const name of ['message.edit', 'lore.add', 'memory.restore', 'draw.create'])
      assert.equal(access[name], undefined, name);
    assert.deepEqual(access['lore.list'], {
      everyone: false,
      roles: [],
      users: [SELF],
      via: { [`user:${SELF}`]: '*' },
    });
    const t2 = makeEnv();
    try {
      await runOp('access.grant', { command: 'memory', userId: SELF }, { ...owner, env: t2.env });
      assert.ok(t2.stored()['memory.server.read']);
      assert.equal(t2.stored()['memory.restore'], undefined);
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
    for (const key of [
      'bot.owners',
      'bot.access',
      'features.tools',
      'tools.safeMode',
      'tools.callTimeoutMs',
      'features.journal',
      'features.memberCommands',
      'bot',
    ])
      assert.ok(governsPersona(key), key);
    for (const key of ['llm.maxRequestsPerDay', 'features.diary', 'bot.timezone'])
      assert.equal(governsPersona(key), false, key);
    assert.ok(PERSONA_GOVERNED_CONFIG.includes('features.tools'));
    const set = await runOp('config.set', { path: 'tools.safeMode', value: 'false' }, asPersona);
    assert.deepEqual([set.status, set.code], ['denied', 'self-grant']);
    const unset = await runOp('config.unset', { path: 'features.tools' }, asPersona);
    assert.deepEqual([unset.status, unset.code], ['denied', 'self-grant']);
    // someone else's role, for an owner who asked her: the normal path
    const other = await runOp('access.grant', { command: 'lore.add', roleId: 'r-other' }, asPersona);
    assert.equal(other.status, 'ok');
    // a member who asks her may not (access.grant is owner-only)
    const member = await runOp(
      'access.grant',
      { command: 'lore.add', userId: MEMBER },
      { ...asPersona, userId: MEMBER }
    );
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
