// Tests for src/ops/: the typed operations behind the owner commands -- the registry, the rights
// check of runOp, the result shape, and the old command keys' table (COMMAND_TO_OP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { COMMAND_TO_OP, legacyGrantOps, listOps, resolveCommand, runOp } from '../src/ops/index.js';
import { createOpsEnv } from '../src/ops/env.js';
import { commandKeys } from '../src/discord/commands.js';

/** The operation names the commands-cleanup plan agreed on (its wildcards spelled out), `/nep talk` since merged into `message.create`. */
const AGREED = new Set([
  'status.show',
  'config.set', 'config.unset',
  'bot.pause', 'bot.resume',
  'draw.create',
  'pings.get', 'pings.set',
  'media.status', 'media.rescan', 'media.recache',
  'model.show', 'model.set',
  'route.list', 'route.set', 'route.remove',
  'rule.add', 'rule.list', 'rule.remove',
  'access.grant', 'access.revoke', 'access.list',
  'diary.set', 'diary.show', 'diary.off', 'diary.post',
  'alias.add', 'alias.remove',
  'learning.add', 'learning.remove',
  'lore.add', 'lore.list', 'lore.show', 'lore.remove',
  'memory.profile.read', 'memory.channel.read', 'memory.server.read', 'memory.recent.read', 'memory.refresh.user', 'memory.refresh.channel', 'memory.refresh.server', 'memory.forget',
  'memory.affinity.read', 'memory.affinity.set', 'memory.wipe', 'memory.journal.read', 'memory.archive.read', 'memory.restore',
  'memory.snapshot', 'memory.private.read', 'memory.private.forget', 'memory.private.purge',
  'message.create', 'message.edit', 'message.delete', 'message.react.add', 'message.react.remove',
]);

/** Owner-only per the plan: no grant ever opens them. */
const OWNER_ONLY = [
  'access.grant', 'access.revoke', 'access.list',
  'memory.private.read', 'memory.private.forget', 'memory.private.purge',
  'memory.journal.read', 'memory.snapshot', 'memory.forget', 'memory.wipe', 'memory.archive.read', 'memory.restore',
];

function makeEnv({ access = {}, emojiBackfill } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-ops-'));
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  fs.writeFileSync(path.join(rootDir, 'prompts', 'rules.md'), '## Rules\n\n- be kind\n');
  const hot = {
    config: { bot: { owners: ['42'], access }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
    prompts: { labels: {} },
    promptSources: {},
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const store = {
    state: { data: {}, markDirty() {} },
    flush() {},
    getUser: () => null,
    getGuild: () => ({ emojiUsage: {} }),
  };
  return createOpsEnv({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1', emojiBackfill });
}

test('ops: every registered op has a rights kind and a name in the agreed list', () => {
  const ops = listOps();
  assert.ok(ops.length > 0);
  for (const op of ops) {
    assert.ok(AGREED.has(op.name), `${op.name} is not an agreed operation name`);
    assert.ok(op.rights.kind === 'read' || op.rights.kind === 'write', `${op.name} has no rights kind`);
  }
  const byName = new Map(ops.map((op) => [op.name, op]));
  for (const name of AGREED) assert.ok(byName.has(name), `${name} is not registered`);
  for (const name of OWNER_ONLY) assert.equal(byName.get(name).rights.ownerOnly, true, `${name} must be owner-only`);
  assert.equal(byName.get('memory.affinity.read').rights.kind, 'read');
  assert.equal(byName.get('memory.affinity.set').rights.kind, 'write');
});

test('ops: runOp denies a non-owner on an owner-only op with a code, even under a * grant', async () => {
  const everyone = { everyone: true, roles: [], users: [] };
  const env = makeEnv({ access: { '*': everyone, memory: everyone, access: everyone, 'rule.list': everyone } });
  for (const name of OWNER_ONLY) {
    const result = await runOp(name, { userId: '7', confirm: 'g1' }, { env, guildId: 'g1', userId: '999', roleIds: [] });
    assert.equal(result.status, 'denied', name);
    assert.equal(result.code, 'owner-only', name);
    assert.equal(typeof result.summary, 'string');
  }
  // a grant on the operation's own name does open a grantable read
  const open = await runOp('rule.list', {}, { env, guildId: 'g1', userId: '999', roleIds: [] });
  assert.equal(open.status, 'ok');
  // no grant at all: denied, with its own code
  const bare = makeEnv();
  const refused = await runOp('rule.list', {}, { env: bare, guildId: 'g1', userId: '999', roleIds: [] });
  assert.equal(refused.status, 'denied');
  assert.equal(refused.code, 'not-granted');
});

test('ops: runOp returns invalid with a human summary for missing args', async () => {
  const env = makeEnv();
  const owner = { env, guildId: 'g1', userId: '42' };
  const result = await runOp('rule.add', {}, owner);
  assert.equal(result.status, 'invalid');
  assert.equal(typeof result.code, 'string');
  assert.equal(result.summary, 'rule text is required');

  const affinity = await runOp('memory.affinity.set', { userId: '7' }, owner);
  assert.equal(affinity.status, 'invalid', 'a set without a score never falls back to a read');

  const unknown = await runOp('no.such.op', {}, owner);
  assert.equal(unknown.status, 'invalid');
  assert.equal(unknown.code, 'unknown-op');
});

test('ops: an exception becomes failed with its code', async () => {
  const emojiBackfill = {
    run: async () => {
      throw Object.assign(new Error('disk unreadable'), { code: 'EIO' });
    },
  };
  const env = makeEnv({ emojiBackfill });
  const result = await runOp('media.rescan', { kind: 'emoji' }, { env, guildId: 'g1', userId: '42' });
  assert.deepEqual(result, { status: 'failed', code: 'EIO', summary: 'disk unreadable', data: null });

  const plain = makeEnv({
    emojiBackfill: {
      run: async () => {
        throw new Error('boom');
      },
    },
  });
  const other = await runOp('media.rescan', { kind: 'emoji' }, { env: plain, guildId: 'g1', userId: '42' });
  assert.equal(other.status, 'failed');
  assert.equal(other.code, 'error');
});

test('ops: COMMAND_TO_OP covers every command key the command tree dispatches', () => {
  const registered = new Set(listOps().map((op) => op.name));
  // The keys whose required `action` (or `kind`) option picks the operation: every value is tried.
  const ACTIONS = { media: ['status', 'rescan', 'recache'], 'memory.private': ['show', 'forget', 'purge'], 'message.react': ['add', 'remove'] };
  const KINDS = { 'memory.refresh': ['user', 'channel', 'server'] };
  for (const key of commandKeys().keys) {
    assert.ok(Object.hasOwn(COMMAND_TO_OP, key), `${key} has no operation`);
    const variants = Object.hasOwn(ACTIONS, key)
      ? ACTIONS[key].map((action) => ({ action }))
      : Object.hasOwn(KINDS, key)
        ? KINDS[key].map((kind) => ({ kind }))
        : [{}, { score: 10, mode: 'on' }];
    for (const args of variants) {
      const target = resolveCommand(key, args);
      assert.ok(target && registered.has(target.op), `${key} ${JSON.stringify(args)} maps to an unregistered op`);
    }
  }
  assert.equal(resolveCommand('memory.affinity', { userId: '1' }).op, 'memory.affinity.read');
  assert.equal(resolveCommand('memory.affinity', { userId: '1', score: 0 }).op, 'memory.affinity.set');
  assert.deepEqual(resolveCommand('media', { kind: 'gifs', action: 'recache' }), { op: 'media.recache', args: { kind: 'gifs', action: 'recache' } });
  assert.equal(resolveCommand('memory.private', { action: 'show', userId: '1' }).op, 'memory.private.read');
  assert.match(resolveCommand('message.react', {}).invalid, /action must be one of: add, remove/);
  assert.equal(resolveCommand('talk', {}), null, '/nep talk is message create now');
  assert.deepEqual(legacyGrantOps('interject'), { from: null, names: ['message.create'] });
  assert.equal(resolveCommand('gifs.recache', {}), null, 'an old key dispatches nothing');
  for (const gone of ['ping', 'reload', 'learned.list']) assert.equal(resolveCommand(gone, {}), null, gone);
});

test('ops: no warmup operation is left; memory refresh is one operation per kind, write rights', () => {
  const ops = listOps();
  assert.deepEqual(ops.filter((op) => op.name.startsWith('warmup')), [], 'the warmup is tools/warmup.mjs');
  for (const key of Object.keys(COMMAND_TO_OP)) assert.ok(!key.startsWith('warmup'), key);
  const byName = new Map(ops.map((op) => [op.name, op]));
  for (const kind of ['user', 'channel', 'server']) {
    const name = `memory.refresh.${kind}`;
    assert.equal(resolveCommand('memory.refresh', { kind }).op, name);
    assert.equal(byName.get(name).rights.kind, 'write', name);
    assert.notEqual(byName.get(name).rights.ownerOnly, true, `${name} keeps today's rights: owner unless granted`);
  }
  assert.equal(byName.has('memory.refresh'), false);
  assert.match(resolveCommand('memory.refresh', {}).invalid, /kind must be one of: user, channel, server/);
  assert.deepEqual(legacyGrantOps('memory.refresh'), { from: null, names: ['memory.refresh.user'] });
  assert.equal(legacyGrantOps('warmup.run'), null);
  assert.equal(legacyGrantOps('warmup'), null);
});

test('ops: a stored grant on a command or group that runs no operation any more is dropped', () => {
  for (const key of ['ping', 'reload', 'learned.list', 'removed', 'removed.run']) assert.equal(legacyGrantOps(key), null, key);
  assert.deepEqual(legacyGrantOps('status'), { from: null, names: ['status.show'] });
});
