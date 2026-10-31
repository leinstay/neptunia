// The child process of tests/skills-no-command-table.test.js, run with
// tests/fixtures/no-command-table-hooks.mjs: the owner's command tree is gone (COMMAND_TABLE empty,
// resolveCommand throws) and her skills must still load, pass the gateway, resolve and run by
// operation name. Fakes only. Exits 0 and prints "ok" when every check holds; any failure throws.
import assert from 'node:assert/strict';

import { COMMAND_TABLE } from '../../src/tools/impl/catalog.ts';
import { resolveCommand } from '../../src/tools/impl/index.ts';
import { createAdmin } from '../../src/admin.js';
import { createDiscordInterface } from '../../interfaces/discord/index.js';
import { createFakeAdapter } from '../../src/interface/fake.js';
import { createReads } from '../../src/interface/reads.ts';
import { skillRegistry } from '../../src/tools/registry.ts';
import { SKILL_DEFINITIONS } from '../../src/tools/definitions.ts';
import { checkSkill } from '../../src/tools/gateway.ts';
import { executeCall, resolveCall } from '../../src/tools/executors.ts';
import { singleScene } from './core-tools-scenes.js';
import { call, toolAnswer } from './tool-answers.js';

// 1. both hooks took effect
assert.equal(COMMAND_TABLE.length, 0, 'COMMAND_TABLE is empty');
assert.throws(() => resolveCommand('lore.list', {}), /resolveCommand called/);

// 2. the registry is whole
const registry = skillRegistry();
// Two more since the board tools board.propose and board.status (PR 6c).
assert.equal(registry.size, 69);
assert.equal(registry.size, SKILL_DEFINITIONS.length);

// 3. the gateway lets her 50 live grants through with valid samples
const GRANTED = [
  'status.show', 'draw.create', 'pings.get', 'pings.set', 'media.status', 'media.rescan', 'media.recache', 'model.show', 'route.list',
  'rule.list', 'access.list', 'alias.add', 'alias.remove', 'learning.add', 'learning.remove', 'lore.add', 'lore.list', 'lore.show',
  'lore.remove', 'memory.profile.read', 'memory.channel.read', 'memory.server.read', 'memory.recent.read',
  'memory.affinity.read', 'memory.journal.read', 'memory.archive.read',
  'memory.snapshot', 'memory.private.read', 'message.create', 'message.edit', 'message.delete', 'message.react.add',
  'message.react.remove', 'errand.run', 'errand.status', 'errand.read', 'errand.resolve', 'errand.cancel', 'errand.list', 'web.search',
  'memory.search', 'tools.describe', 'conversation.read', 'media.find', 'web.read', 'intention.set', 'intention.update', 'intention.cancel',
  'intention.list', 'media.look',
];
assert.equal(GRANTED.length, 50);
const SELF = 'self-1';
const OWNER = '42';
const grants = Object.fromEntries(GRANTED.map((name) => [name, { everyone: false, roles: [], users: [SELF] }]));
const config = { features: { tools: true, journal: true, coreTools: true, intentions: true, innerLife: true }, tools: { safeMode: false }, bot: { owners: [OWNER], access: grants } };
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
port.seedConversation({
  id: 'c1',
  kind: 'channel',
  communityId: 'g1',
  name: 'general',
  topic: null,
  category: null,
  chatType: 'channel',
  iface: 'fake',
  permissions: { read: true, send: true, attach: true, react: true },
  owner: null,
  lastMessageAt: null,
  voice: false,
  public: true,
  audience: { everyone: true, groups: [], groupAllow: [], groupDeny: [], memberAllow: [], memberDeny: [], memberGroups: {} },
});
const hot = { config, prompts: { labels: {} } };
const store = { state: { data: {}, markDirty() {} }, getUser: () => null, getGuild: () => ({}), getLore: () => [], listChannels: () => [], listUserProfiles: () => [], isPingsOff: () => false };
const admin = createAdmin({ discord: DISCORD, hot, store, client: { user: { id: SELF } }, getGuildId: () => 'g1', port, reads: createReads(port, { info() {}, warn() {}, error() {} }) });
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
  ['errand.run', { agent: 'scout', goal: 'look at the weather' }, ''],
  ['intention.set', {}, 'remember to say hi'],
  ['web.search', {}, 'weather'],
  ['tools.describe', { name: 'lore.list' }, ''],
];
for (const [skill, args, body] of CALLS) {
  const resolved = resolveCall({ skill, args, body }, view);
  assert.equal(resolved.ok, true, `${skill}: ${JSON.stringify(resolved)}`);
  const result = await executeCall(resolved, deps);
  assert.notEqual(result.code, 'unknown-command', skill);
  assert.equal(result.error, undefined, `${skill}: ${result.error?.message}`);
  assert.ok(typeof result.status === 'string', skill);
}

// 5. one core turn: an in-turn tool call and a picture of the reply
let drawn = 0;
const scene = await singleScene((path) => import(new URL(`../../${path}`, import.meta.url).href), {
  content: 'draw it and list the lore',
  answers: [toolAnswer('<msg>looking</msg>', [call('lore.list')]), toolAnswer('<msg>here</msg>', [call('draw.create', { text: 'a lighthouse at dusk' })])],
  access: { 'lore.list': { everyone: false, roles: [], users: ['self-id'] } },
  images: {
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async () => (drawn += 1, { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0, usage: {}, model: 'x/image' }),
  },
});
assert.ok(scene.requests.length >= 2, 'the call was followed up');
assert.equal(scene.result.outcome, 'spoke');
assert.equal(drawn, 1, 'the draw.create call made its picture');

console.log('ok');
