// Tests for src/skills/: the persona's skill registry, the rights gateway, the catalogue view,
// and the owner's toggle (`/nep skill allow|deny|list`, src/ops/skill.js). Nothing here executes
// a skill: the gateway only answers whether one may run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOp, resolveCommand } from '../src/ops/index.js';
import { createOpsEnv } from '../src/ops/env.js';
import { createAdmin } from '../src/admin.js';
import { buildCommandTree, createInteractionHandler } from '../src/discord/commands.js';
import { SKILL_DEFINITIONS, loadSkills, skillRegistry, skillNames, describeSkill } from '../src/skills/registry.js';
import { CARRIED_OVER, skillAccess, allowSkill, denySkill, allowedSkills } from '../src/skills/access.js';
import { schemaError } from '../src/skills/schema.js';
import { checkSkill, listSkills } from '../src/skills/gateway.js';

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
    skills: { conversations: [], safeMode: false, ...skills },
    bot: { owners: [OWNER], access },
  };
}

/** An images client whose quota answers `quota`. */
function imagesWith(quota) {
  return { quota: ({ userId } = {}) => ({ used: 0, cap: 5, userUsed: 0, userCap: 2, spent: false, userSpent: false, ...quota, askedFor: userId }) };
}

/** One gateway check with defaults: message.send of a text to the current conversation. */
function check({ skill = 'message.send', args = { text: 'γειά' }, requester = null, cfg = config(), state = {}, registry, targetMessage, images } = {}) {
  return checkSkill({
    skill,
    args,
    principal: persona,
    requester,
    audience,
    context: { config: cfg, state, selfId: SELF, targetMessage, images, registry },
  });
}

/** One structural definition, the fields a test does not care about filled in. */
function def(over) {
  return { name: 'x.read', family: 'x', op: null, argsSchema: { type: 'object', properties: {}, additionalProperties: false }, effects: 'read', sharedState: false, costClass: 'free', targets: null, interfaceCapability: null, ...over };
}

// ---- the registry --------------------------------------------------------------

test('skills registry: seeds the skills of phases 0-1, ops-backed ones inherit kind and ownerOnly', () => {
  const registry = skillRegistry();
  assert.deepEqual(
    [...registry.keys()].sort(),
    ['access.request', 'draw', 'memory.read', 'message.delete', 'message.edit', 'message.react.add', 'message.react.remove', 'message.send', 'skills.list', 'status.show'],
  );
  assert.deepEqual(skillNames().sort(), [...registry.keys()].sort());
  assert.equal(registry.get('memory.read').op, 'memory.profile.read');
  assert.equal(registry.get('memory.read').kind, 'read');
  assert.equal(registry.get('draw').op, 'draw.create');
  assert.equal(registry.get('draw').kind, 'write');
  assert.equal(registry.get('draw').costClass, 'paid');
  for (const skill of registry.values()) assert.equal(skill.ownerOnly, false, skill.name);
  // an interface skill has no operation: its kind follows its effects
  assert.equal(registry.get('message.send').op, null);
  assert.equal(registry.get('message.send').kind, 'write');
  assert.equal(registry.get('message.send').interfaceCapability, 'message.send');
  assert.equal(registry.get('skills.list').kind, 'read');
});

test('skills registry: a skill on an owner-only operation is refused at load', () => {
  assert.throws(() => loadSkills([def({ name: 'memory.wipe', op: 'memory.wipe', effects: 'delete' })]), /owner-only/);
  assert.throws(() => loadSkills([def({ name: 'x.journal', op: 'memory.journal.read' })]), /owner-only/);
});

test('skills registry: an unknown operation, a duplicate name or a bad field is refused at load', () => {
  assert.throws(() => loadSkills([def({ op: 'no.such.op' })]), /unknown operation/);
  assert.throws(() => loadSkills([def(), def()]), /twice/);
  assert.throws(() => loadSkills([def({ effects: 'launch' })]), /effects/);
  assert.throws(() => loadSkills([def({ costClass: 'cheap' })]), /costClass/);
  assert.throws(() => loadSkills([def({ targets: 'everyone' })]), /targets/);
  assert.throws(() => loadSkills([def({ argsSchema: null })]), /argsSchema/);
  // the injected op lookup is the one consulted
  const ops = { 'fake.op': { name: 'fake.op', rights: { kind: 'read', ownerOnly: true } } };
  assert.throws(() => loadSkills([def({ op: 'fake.op' })], { getOp: (name) => ops[name] ?? null }), /owner-only/);
});

test('skills registry: the texts come from the prompts layer, never from src', () => {
  const skill = skillRegistry().get('message.edit');
  const texts = { 'message.edit': { title: 'Διόρθωση', whenToUse: 'όταν', whenNotToUse: 'ποτέ' } };
  const described = describeSkill(skill, texts);
  assert.equal(described.title, 'Διόρθωση');
  assert.equal(described.whenToUse, 'όταν');
  assert.equal(described.whenNotToUse, 'ποτέ');
  assert.equal(described.name, 'message.edit');
  // a layer without the skill's texts leaves them empty
  assert.deepEqual([describeSkill(skill, {}).title, describeSkill(skill, undefined).whenToUse], ['', '']);
  for (const definition of SKILL_DEFINITIONS) {
    assert.equal(Object.hasOwn(definition, 'title'), false, `${definition.name}: wording in src`);
    assert.equal(Object.hasOwn(definition, 'whenToUse'), false, `${definition.name}: wording in src`);
  }
});

test('skills registry: prompts/skills.json carries the three texts of every registry skill', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'skills.json');
  const texts = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const name of skillNames()) {
    for (const key of ['title', 'whenToUse', 'whenNotToUse']) {
      assert.equal(typeof texts[name]?.[key], 'string', `${name}.${key}`);
      assert.ok(texts[name][key].trim(), `${name}.${key} is empty`);
    }
  }
});

// ---- persona access -------------------------------------------------------------

test('skills access: default deny, an allow record by whom and when, deny removes it', () => {
  const state = {};
  assert.deepEqual(allowedSkills(state), {});
  assert.equal(skillAccess({ skill: skillRegistry().get('message.edit'), state, config: config() }).allowed, false);
  allowSkill(state, 'message.edit', { by: OWNER, at: '2026-10-14T10:00:00.000Z' });
  assert.deepEqual(state.skills, { allowed: { 'message.edit': { by: OWNER, at: '2026-10-14T10:00:00.000Z' } } });
  assert.deepEqual(skillAccess({ skill: skillRegistry().get('message.edit'), state, config: config() }), { allowed: true, reason: 'allowed', by: OWNER, at: '2026-10-14T10:00:00.000Z' });
  assert.equal(denySkill(state, 'message.edit'), true);
  assert.equal(denySkill(state, 'message.edit'), false);
  assert.deepEqual(allowedSkills(state), {});
  // a hand-edited, malformed state reads as no record
  assert.deepEqual(allowedSkills({ skills: 'yes' }), {});
  assert.deepEqual(allowedSkills({ skills: { allowed: { 'message.edit': true, draw: { by: OWNER, at: 'x' } } } }), { draw: { by: OWNER, at: 'x' } });
});

test('skills access: the persona\'s current reply tags are carried over in the current conversation only', () => {
  assert.deepEqual([...CARRIED_OVER].sort(), ['draw', 'message.react.add', 'message.send']);
  assert.deepEqual(check(), { ok: true });
  assert.deepEqual(check({ args: { media: 'gif-1' } }), { ok: true }, 'a gif is message.send with media');
  assert.deepEqual(check({ skill: 'message.react.add', args: { messageId: 'm1', emoji: 'x' } }), { ok: true });
  assert.deepEqual(check({ skill: 'draw', args: { prompt: 'ένα σπίτι' }, images: imagesWith({}) }), { ok: true });
  const elsewhere = check({ args: { conversationId: 'c-other', text: 'γειά' } });
  assert.equal(elsewhere.ok, false);
  assert.equal(elsewhere.code, 'not-allowed');
});

// ---- the gateway, check by check --------------------------------------------------

test('skills gateway: an unknown skill, a non-persona principal and an owner-only skill are refused', () => {
  assert.equal(check({ skill: 'message.pin' }).code, 'unknown-skill');
  const wrong = checkSkill({ skill: 'message.send', args: { text: 'a' }, principal: { kind: 'member' }, requester: null, audience, context: { config: config(), state: {} } });
  assert.equal(wrong.code, 'unknown-principal');
  // a registry built around the load check (a frozen skill marked owner-only) is still refused
  const registry = new Map([['x.read', Object.freeze({ ...def(), kind: 'read', ownerOnly: true })]]);
  assert.equal(check({ skill: 'x.read', args: {}, registry }).code, 'owner-only');
});

test('skills gateway: arguments are checked against the schema', () => {
  const state = {};
  allowSkill(state, 'message.edit', { by: OWNER, at: 't' });
  const own = { id: 'm1', authorId: SELF, conversationId: HERE };
  const edit = (args) => check({ skill: 'message.edit', args, state, targetMessage: own });
  assert.deepEqual(edit({ messageId: 'm1', text: 'διορθωμένο' }), { ok: true });
  assert.deepEqual(edit({ messageId: 'm1' }), { ok: false, code: 'invalid-args', reason: 'args.text:required' });
  assert.deepEqual(edit({ messageId: 'm1', text: 'é'.repeat(2001) }), { ok: false, code: 'invalid-args', reason: 'args.text:max-length' });
  assert.deepEqual(edit({ messageId: 'm1', text: '' }), { ok: false, code: 'invalid-args', reason: 'args.text:min-length' });
  assert.deepEqual(edit({ messageId: 5, text: 'a' }), { ok: false, code: 'invalid-args', reason: 'args.messageId:type' });
  assert.deepEqual(edit({ messageId: 'm1', text: 'a', authorId: SELF }), { ok: false, code: 'invalid-args', reason: 'args.authorId:unknown' });
  assert.deepEqual(edit(null), { ok: false, code: 'invalid-args', reason: 'args:type' });
  assert.deepEqual(check({ args: {} }), { ok: false, code: 'invalid-args', reason: 'args:any-of' });
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

test('skills gateway: self-messages pass only for the persona\'s own message, resolved by the server', () => {
  const state = {};
  allowSkill(state, 'message.delete', { by: OWNER, at: 't' });
  const del = (targetMessage, args = { messageId: 'm1' }) => check({ skill: 'message.delete', args, state, targetMessage });
  assert.deepEqual(del({ id: 'm1', authorId: SELF, conversationId: HERE }), { ok: true });
  assert.deepEqual(del({ id: 'm1', authorId: MEMBER, conversationId: HERE }), { ok: false, code: 'not-own-message', reason: 'author' });
  assert.deepEqual(del(undefined), { ok: false, code: 'unknown-message', reason: 'unresolved' });
  assert.deepEqual(del({ id: 'm2', authorId: SELF, conversationId: HERE }), { ok: false, code: 'unknown-message', reason: 'id' });
  assert.deepEqual(del({ id: 'm1', authorId: SELF, conversationId: 'c-other' }), { ok: false, code: 'unknown-message', reason: 'conversation' });
  // her own message in a conversation outside the allow-list
  const away = del({ id: 'm1', authorId: SELF, conversationId: 'c-other' }, { messageId: 'm1', conversationId: 'c-other' });
  assert.deepEqual(away, { ok: false, code: 'conversation-not-allowed', reason: 'c-other' });
});

test('skills gateway: another conversation only through skills.conversations, after an allow', () => {
  const state = {};
  allowSkill(state, 'message.send', { by: OWNER, at: 't' });
  const to = (cfg) => check({ args: { conversationId: 'c-test', text: 'γειά' }, state, cfg });
  assert.deepEqual(to(config()), { ok: false, code: 'conversation-not-allowed', reason: 'c-test' });
  assert.deepEqual(to(config({ skills: { conversations: ['c-test'] } })), { ok: true });
  assert.deepEqual(check({ args: { conversationId: HERE, text: 'a' }, state }), { ok: true }, 'the current conversation is always in');
  // no allow: the allow-list alone opens nothing
  assert.equal(check({ args: { conversationId: 'c-test', text: 'a' }, cfg: config({ skills: { conversations: ['c-test'] } }) }).code, 'not-allowed');
});

test('skills gateway: a shared-state skill checks the requester\'s own right on its operation', () => {
  const registry = loadSkills([def({ name: 'lore.write', family: 'lore', op: 'lore.add', effects: 'shared-write', sharedState: true })]);
  const state = {};
  allowSkill(state, 'lore.write', { by: OWNER, at: 't' });
  const run = (requester, cfg = config()) => check({ skill: 'lore.write', args: {}, registry, state, requester, cfg });
  assert.deepEqual(run({ id: MEMBER, isOwner: false }), { ok: false, code: 'requester-denied', reason: 'not-granted' });
  assert.deepEqual(run({ id: OWNER, isOwner: true }), { ok: true });
  assert.deepEqual(run({ id: MEMBER, isOwner: false }, config({ access: { 'lore.add': { everyone: true, roles: [], users: [] } } })), { ok: true });
  // a forged flag opens nothing: the right comes from bot.owners, read now
  assert.deepEqual(run({ id: MEMBER, isOwner: true }), { ok: false, code: 'requester-denied', reason: 'not-granted' });
  assert.deepEqual(run(null), { ok: true }, 'no requester: the persona acts on her own');
});

test('skills gateway: a paid skill needs its budget (the drawing daily caps)', () => {
  const draw = (images, requester = null) => check({ skill: 'draw', args: { prompt: 'ένα δέντρο' }, images, requester });
  assert.deepEqual(draw(imagesWith({})), { ok: true });
  assert.deepEqual(draw(imagesWith({ spent: true })), { ok: false, code: 'daily-cap', reason: 'image.maxPerDay' });
  assert.deepEqual(draw(imagesWith({ userSpent: true }), { id: MEMBER, isOwner: false }), { ok: false, code: 'daily-cap', reason: 'image.maxPerUserPerDay' });
  assert.deepEqual(draw(undefined), { ok: false, code: 'no-budget', reason: 'unavailable' });
  let asked = 'none';
  draw({ quota: ({ userId }) => { asked = userId; return { spent: false, userSpent: false }; } }, { id: MEMBER, isOwner: false });
  assert.equal(asked, MEMBER, 'the per-member cap is the requester\'s');
});

test('skills gateway: features.skills off refuses everything; safe mode lets only the carried-over tags pass', () => {
  const state = {};
  allowSkill(state, 'message.edit', { by: OWNER, at: 't' });
  const off = config({ features: { skills: false } });
  assert.deepEqual(check({ cfg: off }), { ok: false, code: 'skills-off', reason: 'features.skills' });
  assert.equal(check({ skill: 'message.pin', cfg: off }).code, 'skills-off');
  // a missing switch counts as on
  assert.deepEqual(check({ cfg: { bot: { owners: [OWNER] } } }), { ok: true });

  const safe = config({ skills: { safeMode: true } });
  const own = { id: 'm1', authorId: SELF, conversationId: HERE };
  assert.deepEqual(check({ skill: 'message.edit', args: { messageId: 'm1', text: 'a' }, state, targetMessage: own, cfg: safe }), { ok: false, code: 'safe-mode', reason: 'skills.safeMode' });
  assert.deepEqual(check({ cfg: safe }), { ok: true });
  allowSkill(state, 'message.send', { by: OWNER, at: 't' });
  assert.equal(check({ args: { conversationId: 'c-test', text: 'a' }, state, cfg: { ...safe, skills: { safeMode: true, conversations: ['c-test'] } } }).code, 'safe-mode');
});

// ---- the catalogue view ----------------------------------------------------------

test('skills list: one row per skill with its texts, allowed or not and why', () => {
  const state = {};
  allowSkill(state, 'message.edit', { by: OWNER, at: 't' });
  const texts = { 'message.send': { title: 'Στείλε', whenToUse: 'όταν θέλεις', whenNotToUse: 'όχι' } };
  const rows = listSkills({ config: config(), state, texts, requester: { id: MEMBER, isOwner: false }, audience });
  assert.equal(rows.length, skillNames().length);
  const byName = new Map(rows.map((row) => [row.name, row]));
  assert.deepEqual(byName.get('message.send'), { name: 'message.send', title: 'Στείλε', whenToUse: 'όταν θέλεις', allowed: true, reason: 'carried-over' });
  assert.deepEqual(byName.get('message.edit'), { name: 'message.edit', title: '', whenToUse: '', allowed: true, reason: 'allowed' });
  assert.deepEqual(byName.get('message.delete'), { name: 'message.delete', title: '', whenToUse: '', allowed: false, reason: 'not-allowed' });

  const off = listSkills({ config: config({ features: { skills: false } }), state, texts, requester: null, audience });
  assert.ok(off.every((row) => row.allowed === false && row.reason === 'skills-off'));

  const registry = loadSkills([def({ name: 'lore.write', family: 'lore', op: 'lore.add', effects: 'shared-write', sharedState: true })]);
  allowSkill(state, 'lore.write', { by: OWNER, at: 't' });
  const shared = listSkills({ config: config(), state, texts: {}, requester: { id: MEMBER, isOwner: false }, audience, registry });
  assert.deepEqual(shared, [{ name: 'lore.write', title: '', whenToUse: '', allowed: false, reason: 'requester-denied' }]);
});

// ---- the owner's toggle ------------------------------------------------------------

function makeEnv({ cfg = config(), paused = false } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-skills-'));
  const stateData = paused ? { paused: true } : {};
  const records = [];
  let flushed = 0;
  const hot = { config: cfg, prompts: { labels: {}, skills: {} }, promptSources: {}, rootDir, reloadConfig: () => true, reloadPrompts: () => true };
  const store = { state: { data: stateData, markDirty() {} }, flush() { flushed += 1; }, getUser: () => null, getGuild: () => ({}) };
  const journal = { system: async (guildId, record) => records.push({ guildId, ...record }) };
  const env = createOpsEnv({ hot, store, client: {}, getGuildId: () => 'g1', journal, now: () => Date.UTC(2026, 9, 14, 10, 0, 0) });
  return { env, hot, store, stateData, records, flushedCount: () => flushed, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test('skill toggle: owner-only, even under a * grant; a member changes nothing', async () => {
  const everyone = { everyone: true, roles: [], users: [] };
  const t = makeEnv({ cfg: config({ access: { '*': everyone, 'skill.allow': everyone, 'skill.list': everyone } }) });
  try {
    for (const name of ['skill.allow', 'skill.deny', 'skill.list']) {
      const result = await runOp(name, { name: 'message.edit' }, { env: t.env, guildId: 'g1', userId: MEMBER, roleIds: [] });
      assert.equal(result.status, 'denied', name);
      assert.equal(result.code, 'owner-only', name);
    }
    assert.deepEqual(allowedSkills(t.stateData), {});
    assert.deepEqual(t.records, []);
    // the handler checks the owner itself too: the unchecked test entry refuses a member as well
    const admin = createAdmin({ hot: t.hot, store: t.store, client: {}, getGuildId: () => 'g1' });
    await assert.rejects(admin.run('skill.allow', { name: 'message.edit' }, { guildId: 'g1', userId: MEMBER }), /owner/);
    assert.deepEqual(allowedSkills(t.stateData), {});
  } finally {
    t.cleanup();
  }
});

test('skill toggle: allow and deny write state.json and journal a skill-access record', async () => {
  const t = makeEnv();
  const owner = { env: t.env, guildId: 'g1', userId: OWNER, roleIds: [] };
  try {
    const allowed = await runOp('skill.allow', { name: 'message.edit' }, owner);
    assert.equal(allowed.status, 'ok');
    assert.deepEqual(allowedSkills(t.stateData), { 'message.edit': { by: OWNER, at: '2026-10-14T10:00:00.000Z' } });
    assert.ok(t.flushedCount() >= 1, 'the access change is flushed');
    assert.deepEqual(t.records, [{ guildId: 'g1', event: 'skill-access', skill: 'message.edit', allowed: true, by: OWNER }]);

    const denied = await runOp('skill.deny', { name: 'message.edit' }, owner);
    assert.equal(denied.status, 'ok');
    assert.deepEqual(allowedSkills(t.stateData), {});
    assert.deepEqual(t.records[1], { guildId: 'g1', event: 'skill-access', skill: 'message.edit', allowed: false, by: OWNER });

    const unknown = await runOp('skill.allow', { name: 'message.pin' }, owner);
    assert.equal(unknown.status, 'invalid');
    assert.equal(unknown.code, 'unknown-skill');
    const missing = await runOp('skill.deny', {}, owner);
    assert.equal(missing.status, 'invalid');
    assert.equal(t.records.length, 2, 'a refused toggle journals nothing');
  } finally {
    t.cleanup();
  }
});

test('skill toggle: refused while paused (state.json may be hand-edited)', async () => {
  const t = makeEnv({ paused: true });
  try {
    const result = await runOp('skill.allow', { name: 'message.edit' }, { env: t.env, guildId: 'g1', userId: OWNER });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'paused');
    assert.deepEqual(allowedSkills(t.stateData), {});
  } finally {
    t.cleanup();
  }
});

test('skill list: every registry skill with allowed or not and why', async () => {
  const t = makeEnv({ cfg: config({ skills: { safeMode: true } }) });
  const owner = { env: t.env, guildId: 'g1', userId: OWNER };
  try {
    await runOp('skill.allow', { name: 'memory.read' }, owner);
    const result = await runOp('skill.list', {}, owner);
    assert.equal(result.status, 'ok');
    const lines = result.summary.split('\n');
    assert.ok(lines.some((line) => /safeMode/.test(line)), 'the safe mode is named');
    assert.ok(lines.some((line) => line.startsWith('memory.read:') && line.includes(`allowed by user id:${OWNER}`) && line.includes('2026-10-14T10:00:00.000Z')));
    assert.ok(lines.some((line) => line.startsWith('message.send:') && /carried over/.test(line)));
    assert.ok(lines.some((line) => line.startsWith('message.edit:') && /not allowed/.test(line)));
    for (const name of skillNames()) assert.ok(lines.some((line) => line.startsWith(`${name}:`)), name);
  } finally {
    t.cleanup();
  }
});

// ---- the command ----------------------------------------------------------------------

test('skill command: /nep skill allow|deny|list, the name autocompleted, mapped onto its operation', () => {
  const [command] = buildCommandTree('nep');
  assert.ok(command.options.length <= 25, `${command.options.length} top-level entries`);
  const group = command.options.find((option) => option.name === 'skill');
  assert.ok(group, 'a skill group');
  assert.deepEqual(group.options.map((sub) => sub.name), ['allow', 'deny', 'list']);
  for (const sub of group.options.filter((option) => option.name !== 'list')) {
    assert.deepEqual(sub.options.map((option) => [option.name, option.required, option.autocomplete]), [['name', true, true]]);
  }
  for (const action of ['allow', 'deny', 'list']) assert.equal(resolveCommand(`skill.${action}`, { name: 'draw' }).op, `skill.${action}`);
});

test('skill command: the name autocomplete offers the skill names to the owner only', async () => {
  const t = makeEnv();
  try {
    const admin = createAdmin({ hot: t.hot, store: t.store, client: {}, getGuildId: () => 'g1' });
    const handle = createInteractionHandler({ hot: t.hot, admin, getGuildId: () => 'g1' });
    const ask = async (userId) => {
      const responses = [];
      await handle({
        guildId: 'g1',
        channelId: HERE,
        user: { id: userId },
        member: { roles: [] },
        isAutocomplete: () => true,
        options: { getSubcommandGroup: () => 'skill', getSubcommand: () => 'allow', getFocused: () => ({ name: 'name', value: 'MESSAGE.RE' }) },
        respond: async (choices) => responses.push(choices),
      });
      return responses;
    };
    assert.deepEqual(await ask(OWNER), [[
      { name: 'message.react.add', value: 'message.react.add' },
      { name: 'message.react.remove', value: 'message.react.remove' },
    ]]);
    assert.deepEqual(await ask(MEMBER), [[]]);
  } finally {
    t.cleanup();
  }
});
