// Tests for src/tools/: the persona's skills ARE the owner's /nep commands (one skill per
// operation, derived from the command that runs it), the rights gateway, the catalogue view, the
// effect table, and how the owner opens a skill for her (`/nep access grant|revoke` with her as
// the user, src/tools/operations/access.ts), with the rule she never changes her own authority. Nothing here
// executes a skill: the gateway only answers whether one may run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOp } from '../src/tools/operations/index.ts';
import { listOps } from '../src/tools/operations/registry.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { EFFECT_CLASSES, SKILL_DEFINITIONS, toolsWith } from '../src/tools/definitions.ts';
import { PERSONA_GOVERNED_CONFIG, governsPersona } from '../src/tools/operations/rights.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
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
  NESTED_CAPABILITIES,
  NOT_GRANTABLE_TO_PERSONA,
  grantedToPersona,
  skillAccess,
  wakeEnvelope,
} from '../src/tools/access.ts';
import { executeCall } from '../src/tools/executors.ts';
import { postingChat } from '../src/tools/operations/shared.ts';
import { schemaError } from '../src/tools/schema.ts';
import { checkReplyEffect, checkSkill, listSkills } from '../src/tools/gateway.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Untyped } from '../src/tools/types.ts';
import { asRecord } from './fixtures/records.ts';
import { OWNER_PERSON, ownedBy } from './fixtures/owner-accounts.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

const OWNER = '42';
const MEMBER = '7';
const SELF = 'self-1';
const HERE = 'c-here';
const persona = Object.freeze({ kind: 'persona' });
const audience = Object.freeze({ chatId: HERE, accountIds: [MEMBER] });

/** A config with the settings these tests read, each set here (never the shipped defaults). */
type Grant = { everyone?: boolean; roles?: Array<string>; users?: Array<string> };

function config({ tools = {}, access = {} }: { tools?: Record<string, unknown>; access?: Record<string, Grant> } = {}) {
  return {
    tools: { safeMode: false, ...tools },
    bot: { ownerPerson: OWNER_PERSON, access },
  };
}

/** `cfg` with each of `names` granted to the persona -- her user id in `bot.access[name].users` -- as `/nep access grant` stores it. */
function granting(names: Array<string>, cfg: ReturnType<typeof config> & Record<string, unknown> = config()) {
  const access: Record<string, Grant> = { ...cfg.bot.access };
  for (const name of names)
    access[name] = {
      everyone: access[name]?.everyone === true,
      roles: [...(access[name]?.roles ?? [])],
      users: [...(access[name]?.users ?? []), SELF],
    };
  return { ...cfg, bot: { ...cfg.bot, access } };
}

/** An images client whose quota answers `quota`. */
function imagesWith(quota: Record<string, unknown>) {
  return {
    quota: ({ accountId }: { accountId?: string } = {}) => ({
      used: 0,
      cap: 5,
      userUsed: 0,
      userCap: 2,
      spent: false,
      userSpent: false,
      ...quota,
      askedFor: accountId,
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
  lastRunAt,
  now,
}: Record<string, Untyped> = {}) {
  return checkSkill({
    skill,
    args,
    principal: persona,
    requester,
    audience,
    context: { config: granting(granted, cfg), selfId: SELF, images, registry, lastRunAt, now },
  });
}

/** One structural definition, the fields a test does not care about filled in. */
// A skill as the loader is asked to take it: the tests below also hand it invalid ones.
function def(over?: Record<string, unknown>) {
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
  } as unknown as NonNullable<Parameters<typeof loadSkills>[0]>[number];
}

// ---- the catalogue: one skill per operation -------------------------------------------

// The owner's decision of 2026-11-10 cut the member rights layer, and the ownerOnly a skill copied from it.
test('skills registry: one skill per operation, of the same name and kind inherited; no other skill exists', () => {
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
    assert.equal(skill?.opBacked, true, op.name);
    assert.equal(skill?.op, op.name, op.name);
    assert.equal(skill?.kind, op.rights.kind, op.name);
    assert.equal(Object.hasOwn(skill ?? {}, 'ownerOnly'), false, op.name);
    assert.equal(skill?.family, op.name.split('.')[0], op.name);
  }
  // the old interface-only skills are gone; their abilities are operations behind commands
  // Changed: `memory.read` is a skill again, her read of one subject in a turn (lookup loop slice 12), so it left this list.
  for (const gone of ['draw', 'message.send', 'skills.list', 'access.request', 'talk.interject', 'skill.allow'])
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
  assert.equal(registry.get('draw.create')?.costClass, 'paid');
});

test('skills effects: one effect class per operation, by its actual effect, in one table', () => {
  // Changed: the effect class is read from each tool's definition, the one place it is declared; the classes are the same.
  const effectOf = (name: string) => SKILL_DEFINITIONS.find((definition) => definition.name === name)?.effects;
  for (const op of listOps()) {
    const effect = effectOf(op.name);
    assert.ok(effect !== undefined && EFFECT_CLASSES.includes(effect), `${op.name} has no effect class`);
  }
  assert.deepEqual(
    SKILL_DEFINITIONS.map((definition) => definition.name).sort(),
    listOps()
      .map((op) => op.name)
      .sort(),
    'no row for an operation that does not exist'
  );
  const of = (effect: string) =>
    SKILL_DEFINITIONS.filter((definition) => definition.effects === effect)
      .map((definition) => definition.name)
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
    assert.equal(effectOf(name), 'administrative', name);
  assert.deepEqual(of('paid'), ['draw.create', 'errand.run', 'voice.say']);
  for (const op of listOps()) if (op.rights.kind === 'read') assert.equal(effectOf(op.name), 'read', op.name);
  // a skill carries its operation's class
  assert.equal(skillRegistry().get('memory.restore')?.effects, 'destructive');
});

// The owner's decision of 2026-11-10: an operation declares its kind alone, and the skill inherits it.
test('skills registry: a definition is checked at load; a skill takes the kind of its operation', () => {
  assert.throws(() => loadSkills([def({ op: 'no.such.op' })]), /unknown operation/);
  assert.throws(() => loadSkills([def(), def()]), /twice/);
  assert.throws(() => loadSkills([def({ effects: 'launch' })]), /effects/);
  assert.throws(() => loadSkills([def({ costClass: 'cheap' })]), /costClass/);
  assert.throws(() => loadSkills([def({ targets: 'everyone' })]), /targets/);
  assert.throws(() => loadSkills([def({ argsSchema: null })]), /argsSchema/);
  assert.throws(() => loadSkills([def({ dispatch: { op: 'x' } })]), /toOp/);
  const ops: Record<string, Untyped> = { 'fake.op': { name: 'fake.op', rights: { kind: 'write' } } };
  assert.deepEqual(
    [...loadSkills([def({ op: 'fake.op' })], { getOp: (name) => ops[name] ?? null }).values()].map(
      (skill) => skill.kind
    ),
    ['write']
  );
});

test('skills registry: the texts come from config/tools.json by operation name; a skill without them has empty texts', () => {
  const skill = skillRegistry().get('message.edit');
  const texts = { 'message.edit': { title: 'Διόρθωση', whenToUse: 'όταν', whenNotToUse: 'ποτέ' } };
  assert.deepEqual(
    ['title', 'whenToUse', 'whenNotToUse'].map(
      (key) =>
        describeSkill(skill as unknown as Parameters<typeof describeSkill>[0], texts)[
          key as keyof ReturnType<typeof describeSkill>
        ]
    ),
    ['Διόρθωση', 'όταν', 'ποτέ']
  );
  assert.deepEqual(
    ['title', 'whenToUse', 'whenNotToUse'].map(
      (key) =>
        describeSkill(skillRegistry().get('memory.restore') as unknown as Parameters<typeof describeSkill>[0], {})[
          key as keyof ReturnType<typeof describeSkill>
        ]
    ),
    ['', '', '']
  );
  assert.equal(describeSkill(skill as unknown as Parameters<typeof describeSkill>[0], undefined).title, '');
});

test('skills registry: every `args` key of config/tools.json names a property of its skill (skillArgTexts keeps them all)', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'tools.json');
  const texts: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [name, entry] of Object.entries(texts)) {
    if (asRecord(entry)?.args === undefined) continue;
    const skill = skillRegistry().get(name);
    assert.ok(skill, `${name}: no such skill`);
    assert.deepEqual(
      Object.keys(skillArgTexts(skill, texts)).sort(),
      Object.keys(asRecord(entry).args).sort(),
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
  const texts: Record<string, Untyped> = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  const props = (name: string) => Object.keys(skillRegistry().get(name)?.argsSchema.properties ?? {});
  assert.deepEqual(props('memory.profile.read').slice(0, 1), ['user']);
  assert.deepEqual(props('media.status'), ['kind']);
  assert.deepEqual(props('media.recache'), ['kind', 'days']);
  const create = skillRegistry().get('message.create');
  // Slice 7: the tool argument `channel` is named `place`.
  assert.deepEqual(Object.keys(create?.argsSchema.properties ?? {}), [
    'place',
    'reply',
    'text',
    'file',
    'gif',
    'media',
    'item',
  ]);
  assert.deepEqual(create?.argsSchema.required, []);
  assert.equal(create?.dispatch?.body, 'text');
  assert.ok(Object.hasOwn(skillRegistry().get('draw.create')?.argsSchema.properties ?? {}, 'place'));
  assert.deepEqual(skillRegistry().get('draw.create')?.argsSchema.properties?.self, { type: 'boolean' });
  assert.deepEqual(skillRegistry().get('lore.add')?.argsSchema.properties?.always, { type: 'boolean' });
  assert.deepEqual(skillRegistry().get('route.set')?.argsSchema.properties?.fallbacks, { type: 'boolean' });
  assert.equal(
    skillRegistry().get('lore.add')?.dispatch?.toOp({ title: 't', keys: 'k', text: 'x', always: true }).args?.always,
    true
  );
  assert.equal(
    skillRegistry().get('lore.add')?.dispatch?.toOp({ title: 't', keys: 'k', text: 'x', always: false }).args?.always,
    false
  );
  assert.deepEqual(props('status.show'), ['field', 'part']);
});

test('skills memory.search: the window arguments of her call reach the operation', () => {
  const search = skillRegistry().get('memory.search');
  for (const name of ['anchor', 'move', 'messages', 'minutes'])
    assert.ok(Object.hasOwn(search?.argsSchema.properties ?? {}, name), name);
  const call = search?.dispatch?.toOp({ anchor: '#3', move: 'up', messages: 5, minutes: 30 });
  assert.equal(call?.op, 'memory.search');
  assert.deepEqual(
    {
      anchor: call?.args?.anchor,
      move: call?.args?.move,
      messages: call?.args?.messages,
      minutes: call?.args?.minutes,
    },
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
  assert.equal(
    skillAccess({ skill: edit, config: config(), selfId: SELF } as unknown as Parameters<typeof skillAccess>[0])
      .allowed,
    false
  );
  assert.deepEqual(
    skillAccess({ skill: edit, config: granting(['message.edit']), selfId: SELF } as unknown as Parameters<
      typeof skillAccess
    >[0]),
    {
      allowed: true,
      reason: 'allowed',
    }
  );
  assert.equal(
    skillAccess({ skill: edit, config: granting(['message.edit']), selfId: null } as unknown as Parameters<
      typeof skillAccess
    >[0]).allowed,
    false,
    'no id of hers, no grant'
  );
  // a grant to everyone or to a role is people's: it opens nothing for her
  const everyone = config({ access: { 'message.edit': { everyone: true, roles: ['r1'], users: [MEMBER] } } });
  assert.equal(
    skillAccess({ skill: edit, config: everyone, selfId: SELF } as unknown as Parameters<typeof skillAccess>[0])
      .allowed,
    false
  );
  assert.equal(
    // @ts-expect-error: the test stores a text where the list of users belongs, as a hand-edited config may
    grantedToPersona(config({ access: { 'message.edit': { users: 'self-1' } } }), SELF, 'message.edit'),
    false,
    'a malformed grant reads as none'
  );
});

// The owner's decision of 2026-11-10: a stored everyone or role is a leftover of the member rights layer and decides nothing.
test('skills access: an entry that still holds everyone or a role beside her id opens the skill on her id alone', () => {
  const stale = { everyone: true, roles: ['r1'], users: [SELF] };
  const verdict = (name: string) =>
    skillAccess({
      skill: skillRegistry().get(name),
      config: config({ access: { [name]: stale } }),
      selfId: SELF,
    } as unknown as Parameters<typeof skillAccess>[0]);
  assert.deepEqual(verdict('message.edit'), { allowed: true, reason: 'allowed' });
  assert.deepEqual(verdict('memory.restore'), { allowed: false, reason: 'not-grantable' });
  assert.deepEqual(
    skillAccess({
      skill: skillRegistry().get('message.edit'),
      config: config({ access: { 'message.edit': { ...stale, users: [MEMBER] } } }),
      selfId: SELF,
    } as unknown as Parameters<typeof skillAccess>[0]),
    { allowed: false, reason: 'not-allowed' }
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
    'memory.restore',
    'model.set',
    'route.remove',
    'route.set',
    // Changed: `rule.add` joined. The rules are the owner's document, and her grant of it went on 2026-10-20 for that
    // reason, so no grant opens it to her any more.
    'rule.add',
    'rule.remove',
  ]);
  for (const name of NOT_GRANTABLE_TO_PERSONA) {
    assert.deepEqual(
      skillAccess({
        skill: skillRegistry().get(name),
        config: granting([name], config()),
        selfId: SELF,
      } as unknown as Parameters<typeof skillAccess>[0]),
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

test('skills access: her reply tags are carried over in the current chat, without a grant, even in safe mode', () => {
  assert.deepEqual([...CARRIED_OVER].sort(), ['draw.create', 'message.create', 'message.react.add', 'voice.say']);
  for (const skill of CARRIED_OVER) {
    assert.deepEqual(
      checkReplyEffect({ skill, principal: persona, config: config() } as unknown as Parameters<
        typeof checkReplyEffect
      >[0]),
      { ok: true },
      skill
    );
    assert.deepEqual(
      checkReplyEffect({
        skill,
        principal: persona,
        config: config({ tools: { safeMode: true } }),
      } as unknown as Parameters<typeof checkReplyEffect>[0]),
      { ok: true },
      skill
    );
  }
  assert.equal(
    asRecord(
      checkReplyEffect({ skill: 'message.delete', principal: persona, config: config() } as unknown as Parameters<
        typeof checkReplyEffect
      >[0])
    ).code,
    'unknown-skill'
  );
  assert.equal(
    asRecord(
      checkReplyEffect({
        skill: 'message.create',
        principal: { kind: 'member' },
        config: config(),
      } as unknown as Parameters<typeof checkReplyEffect>[0])
    ).code,
    'unknown-principal'
  );
  // a call of hers in the current chat is carried over too
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' } }), { ok: true });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια', place: 'c-other' } }), {
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

test('skills gateway: her own expressive operations need only her grant, whoever asked or with nobody asking', () => {
  // Changed: her own operations are the tools with the trait `self`, read where they are declared; the list is the same.
  assert.deepEqual([...toolsWith('self')].sort(), [
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
    'skill.disable',
    'skill.read',
    // Changed: her own script runner is hers like her other skill tools.
    'skill.run',
    'voice.say',
  ]);
  for (const name of toolsWith('self')) assert.ok(skillRegistry().has(name), name);
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
    asRecord(check({ skill: 'message.edit', args: { message: 'm1', text: 'σωστό' }, requester: member })).code,
    'not-allowed'
  );
  // Changed: the owner's decision of 2026-11-10, a call of hers runs on her grant alone, so nobody asking refuses no write.
  assert.deepEqual(
    check({
      skill: 'message.edit',
      args: { message: 'm1', text: 'σωστό' },
      granted: ['message.edit'],
      requester: null,
    }),
    { ok: true }
  );
});

// ---- the gateway, check by check --------------------------------------------------------

test('skills gateway: an unknown skill or a non-persona principal is refused; arguments are checked against the schema', () => {
  assert.equal(asRecord(check({ skill: 'message.pin' })).code, 'unknown-skill');
  const wrong = checkSkill({
    skill: 'lore.list',
    args: {},
    principal: { kind: 'member' },
    requester: null,
    audience,
    context: { config: config() },
  });
  assert.equal(asRecord(wrong).code, 'unknown-principal');
  const edit = (args: unknown) => check({ skill: 'message.edit', args, granted: ['message.edit'] });
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

test('skills gateway: an owner-only operation is closed until the owner grants it to her', () => {
  assert.equal(asRecord(check({ skill: 'memory.journal.read', args: {} })).code, 'not-allowed', 'default deny');
  assert.deepEqual(check({ skill: 'memory.journal.read', args: {}, granted: ['memory.journal.read'] }), { ok: true });
});

// The owner's decision of 2026-11-10: who asked changes nothing about whether a call of hers runs.
test('skills gateway: a member who may not run an owner-only operation has it run when she holds the grant', () => {
  assert.deepEqual(
    check({ skill: 'memory.journal.read', args: {}, granted: ['memory.journal.read'], requester: { id: MEMBER } }),
    { ok: true }
  );
});

test('skills gateway: a write she holds runs when nobody asked and the turn is not her own initiative', () => {
  assert.deepEqual(
    check({
      skill: 'lore.add',
      args: { title: 'Ά', keys: 'α', text: 'κείμενο' },
      granted: ['lore.add'],
      requester: null,
    }),
    { ok: true }
  );
});

test('skills gateway: an ungrantable operation stays refused for her whoever asked, the owner included', () => {
  const restore = (requester: unknown) =>
    check({ skill: 'memory.restore', args: { id: 'ep-1' }, granted: ['memory.restore'], requester });
  for (const requester of [{ id: OWNER }, { id: MEMBER }, null])
    assert.deepEqual(
      restore(requester),
      { ok: false, code: 'not-grantable', reason: 'memory.restore' },
      JSON.stringify(requester)
    );
});

test('skills gateway: a call she holds no grant for stays refused not-allowed whoever asked', () => {
  const add = (requester: unknown) =>
    check({ skill: 'lore.add', args: { title: 'Ά', keys: 'α', text: 'κείμενο' }, requester });
  for (const requester of [{ id: OWNER }, { id: MEMBER }, null])
    assert.deepEqual(add(requester), { ok: false, code: 'not-allowed', reason: 'lore.add' }, JSON.stringify(requester));
});

test('skills gateway: a destructive skill waits out its cooldown in a channel (tools.destructiveCooldownMinutes)', () => {
  const remove = (lastRunAt: null | number, cfg = config({ tools: { destructiveCooldownMinutes: 10 } })) =>
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

// PR 7d: features.tools is code, so the switch-off half of this test went with it.
test('skills gateway: safe mode lets only the carried-over calls pass', () => {
  const safe = config({ tools: { safeMode: true } });
  assert.deepEqual(check({ granted: ['lore.list'], cfg: safe }), {
    ok: false,
    code: 'safe-mode',
    reason: 'tools.safeMode',
  });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' }, cfg: safe }), { ok: true });
  // a config without tools settings is not in safe mode
  assert.deepEqual(check({ granted: ['lore.list'], cfg: { bot: { ownerPerson: OWNER_PERSON } } }), { ok: true });
});

// ---- wake envelopes (wakes.kinds.<kind>, heartbeat.*) ---------------------------------

/**
 * One gateway check of an inner turn's call: her own initiative, nobody asked, `wakeKind` and the calls so far. `wakes`
 * holds an envelope per kind: the heartbeat's goes to the `heartbeat` section, every other under `wakes.kinds`.
 */
function innerCheck({
  skill,
  args = {},
  wakes = {},
  wakeKind = 'heartbeat',
  wakeActions = [],
  granted = [],
}: Record<string, Untyped>) {
  const { heartbeat, ...kinds } = wakes as Record<string, Untyped>;
  const cfg = granting(granted, { ...config(), wakes: { kinds }, ...(heartbeat ? { heartbeat } : {}) });
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
      { wakes: { kinds: { review: { tools: ['a.b'], maxActs: 2, maxTasks: 0, inputTokens: 6000 } } } },
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
    reason: 'heartbeat.tools',
  });
  assert.deepEqual(innerCheck({ skill: 'lore.list', granted: ['lore.list'], wakes }), { ok: true });
  assert.deepEqual(
    innerCheck({
      skill: 'intention.set',
      args: { text: 'ρωτήσω αύριο' },
      granted: ['intention.set'],
      wakes,
    }),
    { ok: true }
  );
  // Another wake kind has its own envelope (here none: everything as before).
  assert.deepEqual(innerCheck({ skill: 'message.create', args: { text: 'γεια' }, wakes, wakeKind: 'review' }), {
    ok: true,
  });
  // Not an inner turn: no envelope applies.
  const cfg = granting([], { ...config(), heartbeat: wakes.heartbeat });
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
    { ok: false, code: 'not-allowed', reason: 'wakes.kinds.improvement.maxActs' }
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
    { ok: false, code: 'not-allowed', reason: 'wakes.kinds.improvement.maxTasks' }
  );
});

test('wake envelope: a skill that posts inside its own operation is refused at the nested capability, before anything runs', async () => {
  assert.deepEqual(NESTED_CAPABILITIES['draw.create'], ['message.create']);
  const registry = skillRegistry();
  const resolved = {
    skill: 'draw.create',
    args: { text: 'ένα δέντρο' },
    dispatch: registry.get('draw.create')?.dispatch,
  };
  let ran = 0;
  const deps = (tools: unknown) => ({
    envelope: { ownInitiative: true, wakeKind: 'heartbeat', requester: null },
    // draw.create is one of her own expressive operations: it runs through runOwnOp.
    runOwnOp: async () => {
      ran += 1;
      return { status: 'ok', code: 'ok', summary: 'drawn', data: {} };
    },
    // The call's place alone (plan T.4).
    opContext: { placeId: HERE },
    config: { heartbeat: { tools } },
  });
  const refused = await executeCall(
    resolved as unknown as Parameters<typeof executeCall>[0],
    deps(['draw.create']) as unknown as Parameters<typeof executeCall>[1]
  );
  assert.equal(refused.status, 'denied');
  assert.equal(refused.code, 'not-allowed');
  assert.equal(refused.reason, 'heartbeat.tools');
  assert.equal(ran, 0, 'nothing paid is made for a post the envelope forbids');
  assert.equal(
    (
      await executeCall(
        resolved as unknown as Parameters<typeof executeCall>[0],
        deps(['draw.create', 'message.create']) as unknown as Parameters<typeof executeCall>[1]
      )
    ).status,
    'ok'
  );
  assert.equal(
    (
      await executeCall(
        resolved as unknown as Parameters<typeof executeCall>[0],
        deps('*') as unknown as Parameters<typeof executeCall>[1]
      )
    ).status,
    'ok'
  );
  assert.equal(ran, 2);
  // The posting point of the operations asks again: a send is refused, a read is not a post.
  const context = {
    placeId: HERE,
    ownInitiative: true,
    wakeKind: 'heartbeat',
    env: { hot: { config: { heartbeat: { tools: ['voice.say'] } } } },
  };
  await assert.rejects(
    postingChat({
      client: null,
      discord: DISCORD,
      chatId: null,
      context,
      need: 'attach',
    } as unknown as Parameters<typeof postingChat>[0]),
    (error) => asRecord(error).status === 'denied' && asRecord(error).code === 'not-allowed'
  );
  assert.equal(
    await postingChat({
      client: null,
      discord: DISCORD,
      chatId: null,
      context,
      need: 'read',
    } as unknown as Parameters<typeof postingChat>[0]),
    HERE
  );
  assert.equal(
    await postingChat({
      client: null,
      discord: DISCORD,
      chatId: null,
      context: { ...context, ownInitiative: false },
      need: 'send',
    } as unknown as Parameters<typeof postingChat>[0]),
    HERE,
    'not her own initiative: no envelope'
  );
});

// ---- the catalogue view -----------------------------------------------------------------

test('skills list: one row per skill with its texts, allowed or not and why', () => {
  const cfg = granting(['message.edit', 'memory.restore', 'draw.create', 'memory.private.read']);
  const texts = { 'message.create': { title: 'Στείλε', whenToUse: 'όταν θέλεις', whenNotToUse: 'όχι' } };
  const rows = listSkills({ config: cfg, selfId: SELF, texts, requester: { id: OWNER }, audience });
  // PR 7d: no skill sits behind a feature switch any more, so every skill has a row.
  assert.equal(rows.length, skillNames().length);
  const byName = new Map(rows.map((row) => [row.name, row]));
  // Slice 7: the tool argument `channel` is named `place`.
  const place = { name: 'place', required: false };
  const body = { name: 'text', required: true };
  const message = { name: 'message', required: true };
  assert.deepEqual(byName.get('message.create'), {
    name: 'message.create',
    title: 'Στείλε',
    whenToUse: 'όταν θέλεις',
    allowed: true,
    reason: 'carried-over',
    args: [
      place,
      { name: 'reply', required: false },
      { name: 'text', required: false },
      { name: 'file', required: false },
      { name: 'gif', required: false },
      { name: 'media', required: false },
      { name: 'item', required: false, minimum: 1, maximum: 20 },
    ],
  });
  assert.deepEqual(byName.get('message.edit'), {
    name: 'message.edit',
    title: '',
    whenToUse: '',
    allowed: true,
    reason: 'allowed',
    args: [message, body, place],
  });
  assert.deepEqual(byName.get('message.delete'), {
    name: 'message.delete',
    title: '',
    whenToUse: '',
    allowed: false,
    reason: 'not-allowed',
    args: [message, place],
  });
  assert.deepEqual(byName.get('memory.restore'), {
    name: 'memory.restore',
    title: '',
    whenToUse: '',
    allowed: false,
    reason: 'not-grantable',
    args: [{ name: 'id', required: true }],
  });
  // an owner-only skill she holds: allowed whoever asks
  const row = (name: string, requester: unknown) =>
    listSkills({ config: cfg, selfId: SELF, texts: {}, requester, audience } as unknown as Parameters<
      typeof listSkills
    >[0]).find((entry) => entry.name === name);
  assert.deepEqual(
    [row('memory.private.read', { id: OWNER })?.allowed, row('memory.private.read', { id: OWNER })?.reason],
    [true, 'allowed']
  );
  assert.deepEqual(
    [row('memory.private.read', { id: MEMBER })?.allowed, row('memory.private.read', { id: MEMBER })?.reason],
    // Changed: the owner's decision of 2026-11-10, her grant alone decides, so a member's row is open too.
    [true, 'allowed']
  );
  assert.deepEqual(
    [row('message.edit', { id: MEMBER })?.allowed, row('message.edit', { id: MEMBER })?.reason],
    [true, 'allowed']
  );
});

// ---- the owner grants a skill to her: /nep access grant|revoke with her as the user ------------

function makeEnv({ cfg = config(), roles = [] }: Record<string, Untyped> = {}) {
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
    getPlace: () => ({}),
    updatePlace() {},
  };
  // The interface says who the persona is and which groups she holds (`memberInfo`).
  const client = {};
  const reads = {
    memberInfo: ({ accountId }: Untyped) =>
      Promise.resolve({
        member: {
          id: accountId,
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
    isServedRoot: (id: unknown) => id === 'g1',
    now: () => Date.UTC(2026, 9, 14, 10, 0, 0),
  } as unknown as Parameters<typeof createOpsEnv>[0]);
  /** `bot.access` as written to the private settings file (canonical persona config/config.json). */
  const stored = (): Record<string, Untyped> => {
    const file = path.join(rootDir, 'data', 'config', 'config.json');
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).bot?.access ?? {}) : {};
  };
  return { env, hot, store, client, stored, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

// The owner's decision of 2026-11-10: only he types commands, so a grant names her alone and takes the tool name only.
test('persona grants: a grant opens a skill to her by name, owner-only ones included; revoke closes it', async () => {
  const t = makeEnv();
  const owner = { env: t.env, placeId: 'g1', asOwner: true };
  try {
    for (const name of ['memory.private.read', 'message.edit', 'lore.add']) {
      const result = await runOp('access.grant', { command: name }, owner);
      assert.equal(result.status, 'ok', `${name}: ${result.summary}`);
    }
    const access = t.stored();
    for (const name of ['memory.private.read', 'message.edit', 'lore.add'])
      assert.deepEqual(access[name], { users: [SELF] }, name);
    const privateRead = skillRegistry().get('memory.private.read');
    assert.deepEqual(
      skillAccess({ skill: privateRead, config: config({ access }), selfId: SELF } as unknown as Parameters<
        typeof skillAccess
      >[0]),
      { allowed: true, reason: 'allowed' }
    );
    const list = (await runOp('access.list', {}, owner)).summary.split('\n');
    for (const name of ['memory.private.read', 'message.edit', 'lore.add'])
      assert.ok(list.includes(`${name}: user id:${SELF}`), name);
    assert.equal((await runOp('access.revoke', { command: 'memory.private.read' }, owner)).status, 'ok');
    assert.equal(
      skillAccess({ skill: privateRead, config: config({ access: t.stored() }), selfId: SELF } as unknown as Parameters<
        typeof skillAccess
      >[0]).allowed,
      false
    );
    const unknown = await runOp('access.grant', { command: 'message.pin' }, owner);
    assert.deepEqual([unknown.status, unknown.code], ['invalid', 'unknown-skill']);
  } finally {
    t.cleanup();
  }
});

test('persona grants: an irreversible or administrative operation is refused for her with a clear message', async () => {
  const t = makeEnv();
  const owner = { env: t.env, placeId: 'g1', asOwner: true };
  try {
    for (const name of NOT_GRANTABLE_TO_PERSONA) {
      // The owner's decision of 2026-11-10: the grant takes the tool name alone, her id is the target.
      const result = await runOp('access.grant', { command: name }, owner);
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
  const owner = { env: t.env, placeId: 'g1', asOwner: true };
  try {
    // The owner's decision of 2026-11-10: the grant takes the tool name alone, and the entry holds her id alone.
    assert.equal((await runOp('access.grant', { command: '*' }, owner)).status, 'ok');
    const access = t.stored();
    const reads = [...skillRegistry().values()]
      .filter((skill) => skill.kind === 'read' && !NOT_GRANTABLE_TO_PERSONA.includes(skill.name))
      .map((skill) => skill.name);
    assert.deepEqual(Object.keys(access).sort(), [...reads].sort());
    for (const name of ['status.show', 'lore.list', 'memory.profile.read', 'memory.private.read', 'intention.list'])
      assert.ok(access[name], name);
    for (const name of ['message.edit', 'lore.add', 'memory.restore', 'draw.create'])
      assert.equal(access[name], undefined, name);
    assert.deepEqual(access['lore.list'], { users: [SELF], via: { [`user:${SELF}`]: '*' } });
    const t2 = makeEnv();
    try {
      await runOp('access.grant', { command: 'memory' }, { ...owner, env: t2.env });
      assert.ok(t2.stored()['memory.server.read']);
      assert.equal(t2.stored()['memory.restore'], undefined);
    } finally {
      t2.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

// The owner's decision of 2026-11-10: every grant is hers, so any grant or revoke she makes would change her own
// authority, and the targets of everyone and a role are gone.
test('persona grants: she never changes her effective authority, neither a grant nor the governed config', async () => {
  const t = makeEnv();
  const asPersona = { env: t.env, placeId: 'g1', accountId: OWNER, roleIds: [], actor: 'persona' };
  try {
    for (const name of ['access.grant', 'access.revoke'] as const) {
      const result = await runOp(name, { command: 'lore.add' }, asPersona);
      assert.deepEqual([result.status, result.code], ['denied', 'self-grant'], name);
    }
    assert.deepEqual(t.stored(), {}, 'nothing was written');
    for (const key of ['bot.ownerPerson', 'bot.access', 'tools.safeMode', 'tools.callTimeoutMs', 'bot'])
      assert.ok(governsPersona(key), key);
    for (const key of ['llm.maxRequestsPerDay', 'bot.timezone']) assert.equal(governsPersona(key), false, key);
    assert.ok(PERSONA_GOVERNED_CONFIG.includes('tools'));
    const set = await runOp('config.set', { path: 'tools.safeMode', value: 'false' }, asPersona);
    assert.deepEqual([set.status, set.code], ['denied', 'self-grant']);
    const unset = await runOp('config.unset', { path: 'tools.safeMode' }, asPersona);
    assert.deepEqual([unset.status, unset.code], ['denied', 'self-grant']);
  } finally {
    t.cleanup();
  }
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);
