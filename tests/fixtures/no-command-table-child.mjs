// The child process of tests/skills-no-command-table.test.js, run with
// tests/fixtures/no-command-table-hooks.mjs: the owner's command tree is gone (COMMAND_TABLE empty,
// resolveCommand throws) and her skills must still load, pass the gateway, resolve and run by
// operation name. Fakes only. Exits 0 and prints "ok" when every check holds; any failure throws.
import assert from 'node:assert/strict';

import { COMMAND_TABLE } from '../../src/ops/catalog.js';
import { resolveCommand } from '../../src/ops/index.js';
import { createAdmin } from '../../src/admin.js';
import { createDiscordInterface } from '../../src/interface/discord.js';
import { createFakeAdapter } from '../../src/interface/fake.js';
import { skillRegistry } from '../../src/skills/registry.js';
import { SKILL_DEFINITIONS } from '../../src/skills/definitions.js';
import { checkSkill } from '../../src/skills/gateway.js';
import { executeCall, resolveCall } from '../../src/skills/executors.js';
import { singleScene } from './core-tools-scenes.js';

// 1. both hooks took effect
assert.equal(COMMAND_TABLE.length, 0, 'COMMAND_TABLE is empty');
assert.throws(() => resolveCommand('lore.list', {}), /resolveCommand called/);

// 2. the registry is whole
const registry = skillRegistry();
assert.equal(registry.size, 73);
assert.equal(registry.size, SKILL_DEFINITIONS.length);

// 3. the gateway lets her 53 live grants through with valid samples
const GRANTED = [
  'status.show', 'draw.create', 'pings.get', 'pings.set', 'media.status', 'media.rescan', 'media.recache', 'model.show', 'route.list',
  'rule.list', 'access.list', 'alias.add', 'alias.remove', 'learning.add', 'learning.remove', 'lore.add', 'lore.list', 'lore.show',
  'lore.remove', 'memory.profile.read', 'memory.channel.read', 'memory.server.read', 'memory.recent.read', 'memory.refresh.user',
  'memory.refresh.channel', 'memory.refresh.server', 'memory.affinity.read', 'memory.journal.read', 'memory.archive.read',
  'memory.snapshot', 'memory.private.read', 'message.create', 'message.edit', 'message.delete', 'message.react.add',
  'message.react.remove', 'task.run', 'task.status', 'task.read', 'task.resolve', 'task.cancel', 'task.list', 'web.search',
  'memory.search', 'skills.describe', 'conversation.read', 'media.find', 'web.read', 'intent.set', 'intent.update', 'intent.cancel',
  'intent.list', 'media.look',
];
assert.equal(GRANTED.length, 53);
const SELF = 'self-1';
const OWNER = '42';
const grants = Object.fromEntries(GRANTED.map((name) => [name, { everyone: false, roles: [], users: [SELF] }]));
const config = { features: { skills: true, journal: true, coreTools: true, intentions: true, innerLife: true }, skills: { safeMode: false }, bot: { owners: [OWNER], access: grants } };
const ID = '123456789012345678';

/** A value that satisfies one property schema. */
function valueFor(name, schema, ref) {
  if (ref) return ID;
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'integer') return schema.minimum ?? 1;
  if (schema.type === 'number') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return true;
  return `${name} text`;
}
function sampleOf(skill) {
  const definition = SKILL_DEFINITIONS.find((entry) => entry.name === skill.name);
  const sample = {};
  for (const name of skill.argsSchema.required ?? []) sample[name] = valueFor(name, skill.argsSchema.properties[name], definition.refs?.[name]);
  return sample;
}
const context = { config, selfId: SELF, registry, images: { quota: () => ({ used: 0, cap: 5, userUsed: 0, userCap: 2, spent: false, userSpent: false }) }, tasks: { budget: () => ({ spent: false }) } };
for (const name of GRANTED) {
  const skill = registry.get(name);
  assert.ok(skill, name);
  const verdict = checkSkill({ skill: name, args: sampleOf(skill), principal: { kind: 'persona' }, requester: { id: OWNER, roleIds: [] }, audience: { conversationId: 'c1', memberIds: [OWNER] }, context });
  assert.deepEqual(verdict, { ok: true }, `${name}: ${JSON.stringify(verdict)}`);
}

// 4. resolveCall + executeCall through the admin, by operation name
const DISCORD = createDiscordInterface().capabilities;
const port = createFakeAdapter({ iface: 'fake', selfId: SELF, now: () => 1000 });
port.seed('c1', { authorId: '7', messageId: '1003', text: 'q' });
const channel = { id: 'c1', guild: { id: 'g1', members: { me: { id: SELF } } }, viewable: true, isTextBased: () => true, isDMBased: () => false, permissionsFor: () => ({ has: () => true }) };
const hot = { config, prompts: { labels: {} } };
const store = { state: { data: {}, markDirty() {} }, getUser: () => null, getGuild: () => ({}), getLore: () => [], listChannels: () => [], listUserProfiles: () => [], isPingsOff: () => false };
const admin = createAdmin({ discord: DISCORD, hot, store, client: { user: { id: SELF }, channels: { cache: new Map([['c1', channel]]) } }, getGuildId: () => 'g1', port });
const view = { skills: registry, conversations: [{ id: 'c1', name: 'general' }], messageAt: () => null, members: [{ id: OWNER, names: ['Zoë'], aliases: [] }], roles: [], selfId: SELF };
const deps = {
  port,
  refOf: (conversationId) => ({ iface: 'fake', conversationId: String(conversationId) }),
  renderText: (text) => text,
  envelope: Object.freeze({ actor: 'persona', requester: { id: OWNER, roleIds: [] }, mixed: false, invocationId: 'inv-1', originChannelId: 'c1' }),
  runOp: admin.runSkillOp,
  runOwnOp: admin.runOwnSkillOp,
  opContext: { guildId: 'g1', channelId: 'c1' },
};
const CALLS = [
  ['message.create', {}, 'hello'],
  ['message.react.add', { message: ID, emoji: '🎉' }, ''],
  ['draw.create', {}, 'a lighthouse'],
  ['lore.list', {}, ''],
  ['memory.profile.read', { user: OWNER }, ''],
  ['task.run', { agent: 'web', goal: 'look at the weather' }, ''],
  ['intent.set', {}, 'remember to say hi'],
  ['web.search', {}, 'weather'],
  ['skills.describe', { name: 'lore.list' }, ''],
];
for (const [skill, args, body] of CALLS) {
  const resolved = resolveCall({ skill, args, body }, view);
  assert.equal(resolved.ok, true, `${skill}: ${JSON.stringify(resolved)}`);
  const result = await executeCall(resolved, deps);
  assert.notEqual(result.code, 'unknown-command', skill);
  assert.equal(result.error, undefined, `${skill}: ${result.error?.message}`);
  assert.ok(typeof result.status === 'string', skill);
}

// 5. one core turn: an in-turn <call> and a <draw> of the reply
let drawn = 0;
const scene = await singleScene((path) => import(new URL(`../../${path}`, import.meta.url).href), {
  content: 'draw it and list the lore',
  answers: ['<msg>looking</msg><call skill="lore.list"/>', '<msg>here</msg><draw>a lighthouse at dusk</draw>'],
  access: { 'lore.list': { everyone: false, roles: [], users: ['self-id'] } },
  images: {
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async () => (drawn += 1, { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0, usage: {}, model: 'x/image' }),
  },
});
assert.ok(scene.requests.length >= 2, 'the call was followed up');
assert.equal(scene.result.outcome, 'spoke');
assert.equal(drawn, 1, 'the <draw> made its picture');

console.log('ok');
