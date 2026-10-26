// Tests for interfaces/discord/commands.js: the pure command tree, command-name
// validation, guild registration (including the swallowed-failure path) and
// the interaction handler (owner gate, option -> args mapping, defer/edit,
// chunked follow-ups, autocomplete).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import {
  buildCommandTree,
  registerCommands,
  createInteractionHandler,
  commandEvent,
} from '../src/interface/discord.js';
import { isValidCommandName, leafPaths, commandSize, STATUS_FIELDS, readFlag } from '../src/ops/catalog.js';
import { validateEvent } from '../src/protocol/index.js';
import { isAllowed as accessIsAllowed } from '../src/ops/grants.js';
import { resolveCommand, asResult, listOps } from '../src/ops/index.js';
import { getOp } from '../src/ops/registry.js';
import { grantKeys } from '../src/ops/access.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

// ---------------------------------------------------------------------------
// buildCommandTree
// ---------------------------------------------------------------------------

test('interaction handler: status passes the chosen field into its args, null without one', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  await handler(fakeInteraction({ subcommand: 'status', optionValues: { field: 'limits' } }));
  await handler(fakeInteraction({ subcommand: 'status' }));
  assert.deepEqual(
    admin.runCalls.map((call) => call[1]),
    [{ field: 'limits' }, { field: null }]
  );
});

test('readFlag: true/false as text (any case) or as a boolean; anything else is null', () => {
  const reader = (value) => ({ getString: () => value });
  assert.deepEqual(
    ['true', 'false', ' TRUE ', 'False', true, false].map((value) => readFlag(reader(value), 'x')),
    [true, false, true, false, true, false]
  );
  for (const value of [null, undefined, '', 'yes', '1', 1])
    assert.equal(readFlag(reader(value), 'x'), null, String(value));
});

test('interaction handler: a yes/no option reaches the args as a boolean, its default when left out', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a lighthouse', self: 'true' } }));
  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a lighthouse' } }));
  assert.deepEqual(
    admin.runCalls.map((call) => call[1].self),
    [true, false]
  );
});

test('buildCommandTree: route set has an optional STRING byok option with the true/false choices, reaching the args as a boolean', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  for (const value of ['true', 'false', undefined]) {
    const optionValues = {
      model: 'google/',
      providers: 'google-vertex',
      ...(value === undefined ? {} : { byok: value }),
    };
    await handler(fakeInteraction({ group: 'route', subcommand: 'set', optionValues }));
  }
  assert.deepEqual(
    admin.runCalls.map((call) => call[1].byok),
    [true, false, undefined]
  );
});

// ---------------------------------------------------------------------------
// commandKeys
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// isValidCommandName
// ---------------------------------------------------------------------------

test('isValidCommandName: accepts lowercase letters, digits, - and _, 1..32 chars', () => {
  assert.equal(isValidCommandName('nep'), true);
  assert.equal(isValidCommandName('my-bot_2'), true);
  assert.equal(isValidCommandName('a'.repeat(32)), true);
});

test('isValidCommandName: rejects uppercase, spaces, empty, too long, non-strings', () => {
  assert.equal(isValidCommandName('NEP'), false);
  assert.equal(isValidCommandName('my bot'), false);
  assert.equal(isValidCommandName(''), false);
  assert.equal(isValidCommandName('a'.repeat(33)), false);
  assert.equal(isValidCommandName(undefined), false);
  assert.equal(isValidCommandName(null), false);
});

// ---------------------------------------------------------------------------
// leafPaths
// ---------------------------------------------------------------------------

test('leafPaths: dotted paths of every leaf key, empty objects counted as leaves', () => {
  const paths = leafPaths({ a: { b: 1, c: { d: 2 } }, e: [], f: {} });
  assert.deepEqual(paths.sort(), ['a.b', 'a.c.d', 'e', 'f'].sort());
});

// ---------------------------------------------------------------------------
// registerCommands
// ---------------------------------------------------------------------------

function fakeGuild({ setImpl, applicationId = 'app123' } = {}) {
  const calls = [];
  return {
    client: { application: { id: applicationId } },
    commands: {
      set: async (tree) => {
        calls.push(tree);
        if (setImpl) return setImpl(tree);
        return tree;
      },
    },
    setCalls: calls,
  };
}

test('registerCommands: pushes the built tree for the configured command name', async () => {
  const guild = fakeGuild();
  const config = { bot: { commandName: 'nep' }, features: { adminCommands: true } };

  const ok = await registerCommands(guild, config);

  assert.equal(ok, true);
  assert.equal(guild.setCalls.length, 1);
  assert.deepEqual(guild.setCalls[0], buildCommandTree('nep'));
});

test('registerCommands: pushes a visible tree (no default_member_permissions) regardless of bot.access', async () => {
  for (const [label, access] of [
    ['a grant', { status: { everyone: true, roles: [], users: [] } }],
    ['no grants (empty bot.access)', {}],
  ]) {
    const guild = fakeGuild();
    const config = { bot: { commandName: 'nep', access }, features: { adminCommands: true } };

    const ok = await registerCommands(guild, config);

    assert.equal(ok, true, label);
    assert.deepEqual(guild.setCalls[0], buildCommandTree('nep'), label);
    assert.equal('default_member_permissions' in guild.setCalls[0][0], false, label);
  }
});

test('registerCommands: features.adminCommands false clears the guild command list instead of setting the tree', async () => {
  const guild = fakeGuild();
  const config = { bot: { commandName: 'nep' }, features: { adminCommands: false } };

  const ok = await registerCommands(guild, config);

  assert.equal(ok, false);
  assert.deepEqual(guild.setCalls, [[]]);
});

test('registerCommands: an invalid commandName is refused without touching the guild', async () => {
  const guild = fakeGuild();
  const config = { bot: { commandName: 'Not Valid' }, features: { adminCommands: true } };

  const { result: ok, logs } = await withCapturedLogs(() => registerCommands(guild, config));

  assert.equal(ok, false);
  assert.equal(guild.setCalls.length, 0);
  assert.ok(logs.some((l) => l.level === 'error'));
});

test('registerCommands: a registration failure (missing applications.commands scope) is swallowed and logged with the re-invite hint', async () => {
  const err = Object.assign(new Error('Missing Access'), { code: 50001 });
  const guild = fakeGuild({
    setImpl: () => {
      throw err;
    },
    applicationId: 'app999',
  });
  const config = { bot: { commandName: 'nep' }, features: { adminCommands: true } };

  const { result: ok, logs } = await withCapturedLogs(() => registerCommands(guild, config));

  assert.equal(ok, false);
  const errorLog = logs.find((l) => l.level === 'error');
  assert.ok(errorLog, 'expected one error log line');
  assert.equal(errorLog.msg, 'commands: registration failed');
  assert.equal(errorLog.reason, 'scope');
  assert.match(errorLog.inviteUrl, /scope=bot%20applications\.commands/);
  assert.match(errorLog.inviteUrl, /client_id=app999/);
  assert.equal(errorLog.error.code, 50001);
});

test('registerCommands: a command-too-large refusal logs the tree size and the limit, not the re-invite hint', async () => {
  const err = Object.assign(
    new Error('Invalid Form Body\n0[APPLICATION_COMMAND_TOO_LARGE]: Command exceeds maximum size (8000)'),
    { name: 'DiscordAPIError[50035]', code: 50035 }
  );
  const guild = fakeGuild({
    setImpl: () => {
      throw err;
    },
  });
  const config = { bot: { commandName: 'nep' }, features: { adminCommands: true } };

  const { result: ok, logs } = await withCapturedLogs(() => registerCommands(guild, config));

  assert.equal(ok, false);
  const errorLog = logs.find((l) => l.level === 'error');
  assert.ok(errorLog, 'expected one error log line');
  assert.equal(errorLog.msg, 'commands: registration failed');
  assert.equal(errorLog.reason, 'too-large');
  assert.equal(errorLog.size, commandSize(buildCommandTree('nep')[0]));
  assert.equal(errorLog.limit, 8000);
  assert.equal(errorLog.inviteUrl, undefined, 'a tree over the size limit is no scope problem: no re-invite URL');
});

// ---------------------------------------------------------------------------
// createInteractionHandler
// ---------------------------------------------------------------------------

/** A fake admin whose rights check runs the real, pure src/ops/grants.js#isAllowed on the
 * real operation a command key maps to (src/ops/index.js#resolveCommand; a command with no
 * operation is owner-only) against `owners`/`access`, the way src/admin.js#createAdmin wires it --
 * so these tests exercise the real gating logic, not a stand-in for it. `runCommand` answers in
 * runOp's shape; `runCalls` holds the command keys that got past the rights. */
function fakeAdmin({ owners = ['owner1'], access = {}, runImpl } = {}) {
  const runCalls = [];
  const opFor = (commandKey, args = {}) => {
    const target = resolveCommand(commandKey, args);
    return (target?.op && getOp(target.op)) ?? { name: commandKey, rights: { kind: 'write', ownerOnly: true } };
  };
  const isAllowed = (commandKey, { userId, roleIds } = {}, args = {}) =>
    accessIsAllowed({ op: opFor(commandKey, args), member: { userId, roleIds }, owners, access });
  return {
    isAllowed,
    operationFor: (commandKey, args = {}) => resolveCommand(commandKey, args)?.op ?? null,
    accessKeys: () => grantKeys(listOps()),
    runCommand: async (commandKey, args, context) => {
      if (!isAllowed(commandKey, context, args))
        return { status: 'denied', code: 'not-granted', summary: 'Not allowed', data: null };
      runCalls.push([commandKey, args, context]);
      try {
        return asResult(runImpl ? await runImpl(commandKey, args, context) : `ok: ${commandKey}`);
      } catch (err) {
        return { status: 'failed', code: 'error', summary: err.message, data: null };
      }
    },
    runCalls,
  };
}

let nextInteractionId = 1;

function fakeInteraction(overrides = {}) {
  const replies = [];
  const followUps = [];
  const edits = [];
  const deletes = [];
  const respondCalls = [];
  const optionValues = overrides.optionValues ?? {};
  const interaction = {
    id: overrides.id ?? `i${nextInteractionId++}`,
    guildId: overrides.guildId ?? 'g1',
    channelId: overrides.channelId ?? 'c1',
    user: overrides.user ?? { id: 'owner1' },
    member: overrides.member,
    commandName: overrides.commandName ?? 'nep',
    deferred: false,
    replied: false,
    isChatInputCommand: () => overrides.kind !== 'autocomplete',
    isAutocomplete: () => overrides.kind === 'autocomplete',
    options: {
      getSubcommandGroup: () => overrides.group ?? null,
      getSubcommand: () => overrides.subcommand ?? null,
      getString: (name) => optionValues[name] ?? null,
      getInteger: (name) => (optionValues[name] === undefined ? null : optionValues[name]),
      getBoolean: (name) => (optionValues[name] === undefined ? null : optionValues[name]),
      getUser: (name) => optionValues[name] ?? null,
      getRole: (name) => optionValues[name] ?? null,
      getChannel: (name) => optionValues[name] ?? null,
      getFocused: () => overrides.focused ?? { name: 'path', value: '' },
    },
    deferReply: async (opts) => {
      interaction.deferred = true;
      replies.push({ deferred: true, opts });
    },
    reply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
    },
    editReply: async (payload) => {
      edits.push(payload);
    },
    deleteReply: async () => {
      deletes.push(true);
    },
    followUp: async (payload) => {
      followUps.push(payload);
    },
    respond: async (choices) => {
      respondCalls.push(choices);
    },
    replies,
    edits,
    deletes,
    followUps,
    respondCalls,
  };
  return interaction;
}

function baseHot(featuresOverrides = {}) {
  return {
    config: {
      bot: { commandName: 'nep', owners: ['owner1'] },
      features: { ...featuresOverrides },
      llm: {},
      memory: {},
      relationships: {},
      spontaneous: {},
      mention: {},
    },
  };
}

test('interaction handler: a foreign guild is ignored entirely', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'served-guild' });

  const interaction = fakeInteraction({ guildId: 'other-guild', subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.equal(interaction.replies.length, 0);
});

test('interaction handler: features.adminCommands false replies "disabled" without calling admin.run', async () => {
  const admin = fakeAdmin();
  const hot = baseHot({ adminCommands: false });
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(interaction.replies[0].content, /disabled/i);
});

test('interaction handler: an interaction without a subcommand gets an ephemeral error and no admin.run', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: null });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.deepEqual(interaction.replies, [{ content: 'Error: no subcommand given.', flags: MessageFlags.Ephemeral }]);
});

test('interaction handler: a non-owner is refused ephemerally and admin.run is never called', async () => {
  const admin = fakeAdmin({ owners: ['owner1'] });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'intruder' }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(interaction.replies[0].content, /not allowed/i);
});

test('interaction handler: a non-owner granted the exact operation by role is let through', async () => {
  const admin = fakeAdmin({
    owners: ['owner1'],
    access: { 'status.show': { everyone: false, roles: ['staff'], users: [] } },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'helper1' }, member: { roles: ['staff'] }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 1);
  assert.equal(admin.runCalls[0][0], 'status');
  assert.equal(interaction.replies[0].content, 'ok: status');
});

test('interaction handler: a non-owner with a grant on a DIFFERENT operation, or on the old command key, is still refused', async () => {
  const admin = fakeAdmin({
    owners: ['owner1'],
    access: { 'rule.list': { everyone: true, roles: [], users: [] }, status: { everyone: true, roles: [], users: [] } },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'helper1' }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.match(interaction.replies[0].content, /not allowed/i);
});

test('interaction handler: /nep memory private stays owner-only even with a grant on it, its group or *', async () => {
  const open = { everyone: true, roles: [], users: [] };
  const user = { id: 'target1' };
  // [granted keys, the calls of a granted member, the owner's own call]
  for (const [keys, calls, ownerCall] of [
    [
      ['memory', 'memory.private', 'memory.private.read'],
      [{ group: 'memory', subcommand: 'private', optionValues: { user } }],
      { group: 'memory', subcommand: 'private', optionValues: { user } },
    ],
  ]) {
    const access = { '*': open, ...Object.fromEntries(keys.map((key) => [key, open])) };
    const admin = fakeAdmin({ owners: ['owner1'], access });
    const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

    for (const call of calls) {
      const interaction = fakeInteraction({ user: { id: 'helper1' }, ...call });
      await handler(interaction);
      // a slow command defers first, so its refusal is the edited reply
      const answer = interaction.edits[0]?.content ?? interaction.replies[0].content;
      assert.match(answer, /not allowed/i, JSON.stringify(call));
    }
    assert.equal(admin.runCalls.length, 0, keys[0]);

    await handler(fakeInteraction(ownerCall));
    assert.equal(admin.runCalls.length, 1, `${keys[0]}: the owner still runs it`);
  }
});

test('interaction handler: access.grant/revoke map command/role/user straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(
    fakeInteraction({
      group: 'access',
      subcommand: 'grant',
      optionValues: { command: 'memory', role: { id: 'role1' } },
    })
  );
  assert.equal(admin.runCalls[0][0], 'access.grant');
  assert.deepEqual(admin.runCalls[0][1], { command: 'memory', roleId: 'role1', userId: undefined });

  await handler(
    fakeInteraction({
      group: 'access',
      subcommand: 'revoke',
      optionValues: { command: 'memory', user: { id: 'user1' } },
    })
  );
  assert.equal(admin.runCalls[1][0], 'access.revoke');
  assert.deepEqual(admin.runCalls[1][1], { command: 'memory', roleId: undefined, userId: 'user1' });
});

test('interaction handler: a top-level subcommand maps to its bare command key', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 1);
  assert.equal(admin.runCalls[0][0], 'status');
  assert.deepEqual(admin.runCalls[0][2], { guildId: 'g1', channelId: 'c1', userId: 'owner1', roleIds: [] });
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(interaction.replies[0].content, 'ok: status');
});

test('interaction handler: pings maps mode (undefined when omitted) and runs for a member with no grant', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: {} });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const off = fakeInteraction({ subcommand: 'pings', user: { id: 'member1' }, optionValues: { mode: 'off' } });
  await handler(off);
  await handler(fakeInteraction({ subcommand: 'pings', user: { id: 'member1' } }));

  assert.deepEqual(
    admin.runCalls.map(([key, args]) => [key, args]),
    [
      ['pings', { mode: 'off' }],
      ['pings', { mode: undefined }],
    ]
  );
  assert.deepEqual(admin.runCalls[0][2], { guildId: 'g1', channelId: 'c1', userId: 'member1', roleIds: [] });
  assert.deepEqual(
    off.replies,
    [{ content: 'ok: pings', flags: MessageFlags.Ephemeral }],
    'answered at once, not deferred'
  );
});

test('interaction handler: features.adminCommands false disables pings too', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot({ adminCommands: false }), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'pings', user: { id: 'member1' } });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.match(interaction.replies[0].content, /disabled/i);
});

test('interaction handler: memory.show maps the user option to userId, section/limit/order undefined when omitted', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    group: 'memory',
    subcommand: 'show',
    optionValues: { user: { id: 'target1' } },
  });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'memory.show');
  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1', section: undefined, limit: undefined, order: undefined });
});

test('interaction handler: media kind:emoji action:status replies at once, action:rescan is deferred', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const status = fakeInteraction({ subcommand: 'media', optionValues: { kind: 'emoji', action: 'status' } });
  await handler(status);
  assert.equal(admin.runCalls[0][0], 'media');
  assert.deepEqual(admin.runCalls[0][1], { kind: 'emoji', action: 'status' });
  assert.ok(!status.replies.some((r) => r.deferred));

  const rescan = fakeInteraction({ subcommand: 'media', optionValues: { kind: 'emoji', action: 'rescan' } });
  await handler(rescan);
  assert.equal(admin.runCalls[1][0], 'media');
  assert.deepEqual(admin.runCalls[1][1], { kind: 'emoji', action: 'rescan' });
  assert.ok(rescan.replies.some((r) => r.deferred));
  assert.equal(rescan.edits.length, 1);
});

test('interaction handler: media kind:gifs action:recache replies at once, its work goes on in the background', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const recache = fakeInteraction({ subcommand: 'media', optionValues: { kind: 'gifs', action: 'recache' } });
  await handler(recache);
  assert.equal(admin.runCalls[0][0], 'media');
  assert.deepEqual(admin.runCalls[0][1], { kind: 'gifs', action: 'recache' });
  assert.ok(!recache.replies.some((r) => r.deferred));

  await handler(
    fakeInteraction({ subcommand: 'media', optionValues: { kind: 'pictures', action: 'recache', days: 30 } })
  );
  assert.deepEqual(admin.runCalls[1][1], { kind: 'pictures', action: 'recache', days: 30 });
});

test('interaction handler: memory.channel maps the optional channel option to channelId (undefined when omitted)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(
    fakeInteraction({ group: 'memory', subcommand: 'channel', optionValues: { channel: { id: 'chan1' } } })
  );
  assert.equal(admin.runCalls[0][0], 'memory.channel');
  assert.deepEqual(admin.runCalls[0][1], { channelId: 'chan1' });

  await handler(fakeInteraction({ group: 'memory', subcommand: 'channel' }));
  assert.deepEqual(admin.runCalls[1][1], { channelId: undefined });
});

test('interaction handler: memory.recent runs the memory.recent handler with no arguments', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'memory', subcommand: 'recent' }));

  assert.equal(admin.runCalls[0][0], 'memory.recent');
  assert.deepEqual(admin.runCalls[0][1], {});
});

test('interaction handler: lore.add defaults always to false when omitted', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    group: 'lore',
    subcommand: 'add',
    optionValues: { title: 'X', keys: 'x', text: 'text' },
  });
  await handler(interaction);

  assert.equal(admin.runCalls[0][1].always, false);
});

test('interaction handler: defers then edits for a slow command (memory snapshot)', async () => {
  const admin = fakeAdmin({ runImpl: () => 'snapshot data/snapshots/x: 12 files' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ group: 'memory', subcommand: 'snapshot' });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.deepEqual(interaction.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } });
  assert.equal(interaction.edits.length, 1);
  assert.equal(interaction.edits[0].content, 'snapshot data/snapshots/x: 12 files');
});

test('commands: an interaction retry with the same id does not run the op twice', async () => {
  let clock = 1_000_000;
  for (const [group, subcommand, optionValues] of [
    ['memory', 'restore', { id: 'ep-1' }],
    ['memory', 'snapshot', {}],
  ]) {
    const admin = fakeAdmin({ runImpl: () => 'started' });
    const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1', now: () => clock });
    const key = `${group}.${subcommand}`;

    const first = fakeInteraction({ id: `retry-${key}`, group, subcommand, optionValues });
    await handler(first);
    assert.equal(first.deferred, true, `${key}: deferred under the 3-second rule`);
    const retry = fakeInteraction({ id: `retry-${key}`, group, subcommand, optionValues });
    clock += 60_000;
    await handler(retry);

    assert.equal(admin.runCalls.length, 1, `${key}: ran once`);
    assert.equal(
      retry.replies.length + retry.edits.length + retry.followUps.length,
      0,
      `${key}: the retry answers nothing`
    );

    // Past the 15-minute window the id is forgotten: a new delivery with it runs.
    clock += 15 * 60_000;
    await handler(fakeInteraction({ id: `retry-${key}`, group, subcommand, optionValues }));
    assert.equal(admin.runCalls.length, 2, `${key}: a delivery after the window runs`);
  }
});

test('commands: every reply is ephemeral', async () => {
  const admin = fakeAdmin({ runImpl: () => 'done' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  // Deferred ones (what they post in the channel is the persona's own message, not the reply).
  for (const call of [
    { group: 'message', subcommand: 'create', optionValues: {} },
    { group: 'message', subcommand: 'create', optionValues: { channel: { id: 'chan1' } } },
    { subcommand: 'draw', optionValues: { text: 'a lighthouse' } },
    { group: 'memory', subcommand: 'restore', optionValues: { id: 'x' } },
  ]) {
    const interaction = fakeInteraction(call);
    await handler(interaction);
    assert.deepEqual(
      interaction.replies[0],
      { deferred: true, opts: { flags: MessageFlags.Ephemeral } },
      JSON.stringify(call)
    );
    assert.equal(interaction.edits[0].content, 'done', JSON.stringify(call));
  }

  // Fast ones.
  for (const call of [
    { group: 'memory', subcommand: 'show', optionValues: { user: { id: 'target1' } } },
    { group: 'access', subcommand: 'list' },
    { subcommand: 'set', optionValues: { path: 'llm.model', value: 'x' } },
    { subcommand: 'status' },
  ]) {
    const interaction = fakeInteraction(call);
    await handler(interaction);
    assert.deepEqual(interaction.replies[0], { content: 'done', flags: MessageFlags.Ephemeral }, JSON.stringify(call));
  }

  // An error of a deferred command edits the ephemeral deferred reply.
  const failing = fakeAdmin({
    runImpl: () => {
      throw new Error('busy');
    },
  });
  const failingHandler = createInteractionHandler({ hot: baseHot(), admin: failing, getGuildId: () => 'g1' });
  const draw = fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a lighthouse' } });
  await failingHandler(draw);
  assert.deepEqual(draw.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } });
  assert.equal(draw.deletes.length, 0);
  assert.equal(draw.edits[0].content, 'Error: busy');

  // A refusal too.
  const member = fakeInteraction({ user: { id: 'helper1' }, group: 'message', subcommand: 'create', optionValues: {} });
  await handler(member);
  assert.deepEqual(member.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } });
  assert.equal(member.edits[0].content, 'Not allowed');
});

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

test('interaction handler: a fast command replies directly, no defer', async () => {
  const admin = fakeAdmin({ runImpl: () => 'fast result' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.equal(interaction.deferred, false);
  assert.equal(interaction.edits.length, 0);
  assert.equal(interaction.replies[0].content, 'fast result');
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
});

test('interaction handler: a thrown admin.run error is reported ephemerally, not thrown', async () => {
  const admin = fakeAdmin({
    runImpl: () => {
      throw new Error('bad input');
    },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await assert.doesNotReject(() => handler(interaction));

  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(interaction.replies[0].content, /Error: bad input/);
});

test('interaction handler: a thrown admin.run error is logged with the command key, even when the reply fails too', async () => {
  const admin = fakeAdmin({
    runImpl: () => {
      throw new Error('bad input');
    },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ group: 'memory', subcommand: 'server' });
  interaction.reply = async () => {
    throw new Error('Unknown interaction');
  };
  const { logs } = await withCapturedLogs(() => handler(interaction));

  const line = logs.find((l) => l.msg === 'commands: command failed');
  assert.ok(line, 'expected a command-failed log line');
  assert.equal(line.level, 'warn');
  assert.equal(line.command, 'memory.server');
  assert.equal(line.error.message, 'bad input');
});

test('interaction handler: long output is chunked into ephemeral follow-ups', async () => {
  const longLine = 'x'.repeat(1000);
  const longBody = Array.from({ length: 5 }, () => longLine).join('\n');
  const admin = fakeAdmin({ runImpl: () => longBody });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.ok(interaction.followUps.length >= 1, 'expected at least one follow-up for the overflow');
  for (const followUp of interaction.followUps) {
    assert.equal(followUp.flags, MessageFlags.Ephemeral);
  }
});

test('interaction handler: multi-line output is wrapped in a code block', async () => {
  const admin = fakeAdmin({ runImpl: () => 'line one\nline two' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.match(interaction.replies[0].content, /^```\n/);
});

// ---------------------------------------------------------------------------
// autocomplete
// ---------------------------------------------------------------------------

test('autocomplete: returns up to 25 leaf config paths filtered by the typed text', async () => {
  const admin = fakeAdmin();
  const config = {
    bot: { commandName: 'nep', owners: ['owner1'] },
    features: {},
    llm: { model: 'x', maxOutputTokens: 1 },
  };
  const hot = { config };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    kind: 'autocomplete',
    subcommand: 'set',
    focused: { name: 'path', value: 'llm.' },
  });
  await handler(interaction);

  assert.equal(interaction.respondCalls.length, 1);
  const choices = interaction.respondCalls[0];
  assert.ok(choices.length <= 25);
  assert.ok(choices.every((c) => c.name.toLowerCase().includes('llm.')));
  assert.ok(choices.some((c) => c.name === 'llm.model'));
});

test('autocomplete: command-option choices for /nep access grant|revoke -- every grantable operation, group and *, filtered', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    kind: 'autocomplete',
    group: 'access',
    subcommand: 'grant',
    focused: { name: 'command', value: 'mem' },
  });
  await handler(interaction);

  assert.equal(interaction.respondCalls.length, 1);
  const choices = interaction.respondCalls[0];
  assert.ok(choices.length <= 25);
  assert.ok(choices.every((c) => c.name.toLowerCase().includes('mem')));
  assert.ok(choices.some((c) => c.name === 'memory'));
  assert.ok(choices.some((c) => c.name === 'memory.profile.read'));
  assert.ok(!choices.some((c) => c.name === 'memory.affinity.set'), 'no operation sets the attitude');
  assert.ok(!choices.some((c) => c.name === 'memory.show'), 'never an old command key');

  const lore = fakeInteraction({
    kind: 'autocomplete',
    group: 'access',
    subcommand: 'grant',
    focused: { name: 'command', value: 'lore' },
  });
  await handler(lore);
  assert.ok(
    lore.respondCalls[0].some((c) => c.name === 'lore.add'),
    'a write is offered by its name'
  );
});

test('autocomplete: command-option choices never offer the owner-only private memory commands', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  // [owner-only group, a typed prefix of it]
  for (const [group, typed] of [
    ['memory.private', 'priv'],
    ['memory.journal', 'jour'],
    ['memory.restore', 'rest'],
  ]) {
    for (const [subcommand, value] of [
      ['grant', typed],
      ['revoke', typed],
      ['grant', ''],
    ]) {
      const interaction = fakeInteraction({
        kind: 'autocomplete',
        group: 'access',
        subcommand,
        focused: { name: 'command', value },
      });
      await handler(interaction);
      const names = interaction.respondCalls[0].map((c) => c.name);
      assert.ok(
        !names.some((name) => name === group || name.startsWith(`${group}.`)),
        `${group}: ${subcommand} "${value}"`
      );
    }
  }
});

test('autocomplete: command-option choices never offer the member command pings', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    kind: 'autocomplete',
    group: 'access',
    subcommand: 'grant',
    focused: { name: 'command', value: 'pings' },
  });
  await handler(interaction);
  assert.deepEqual(interaction.respondCalls[0], []);
});

test('autocomplete: a non-owner granted config.set by role gets path choices, never command-key choices (access is owner-only)', async () => {
  const admin = fakeAdmin({
    owners: ['owner1'],
    access: {
      'config.set': { everyone: false, roles: ['staff'], users: [] },
      'access.grant': { everyone: false, roles: ['staff'], users: [] },
    },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const paths = fakeInteraction({
    kind: 'autocomplete',
    user: { id: 'helper1' },
    member: { roles: ['staff'] },
    subcommand: 'set',
    focused: { name: 'path', value: '' },
  });
  await handler(paths);
  assert.ok(paths.respondCalls[0].length > 0);

  for (const subcommand of ['grant', 'revoke']) {
    const interaction = fakeInteraction({
      kind: 'autocomplete',
      user: { id: 'helper1' },
      member: { roles: ['staff'] },
      group: 'access',
      subcommand,
      focused: { name: 'command', value: '' },
    });
    await handler(interaction);
    assert.deepEqual(interaction.respondCalls[0], [], subcommand);
  }

  // The owner still gets them, without any access key offered.
  const owner = fakeInteraction({
    kind: 'autocomplete',
    group: 'access',
    subcommand: 'grant',
    focused: { name: 'command', value: '' },
  });
  await handler(owner);
  const names = owner.respondCalls[0].map((c) => c.name);
  assert.ok(names.length > 0);
  assert.ok(!names.some((name) => name === 'access' || name.startsWith('access.')));
});

test('autocomplete: a non-owner gets no choices', async () => {
  const admin = fakeAdmin({ owners: ['owner1'] });
  const hot = baseHot();
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ kind: 'autocomplete', user: { id: 'intruder' } });
  await handler(interaction);

  assert.deepEqual(interaction.respondCalls[0], []);
});

test('autocomplete: features.adminCommands false returns no choices', async () => {
  const admin = fakeAdmin();
  const hot = baseHot({ adminCommands: false });
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ kind: 'autocomplete' });
  await handler(interaction);

  assert.deepEqual(interaction.respondCalls[0], []);
});

test('autocomplete: a foreign guild is ignored', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'served-guild' });

  const interaction = fakeInteraction({ kind: 'autocomplete', guildId: 'other-guild' });
  await handler(interaction);

  assert.equal(interaction.respondCalls.length, 0);
});

// ---------------------------------------------------------------------------
// commandSize: Discord's 8000-character limit for one application command
// ---------------------------------------------------------------------------

test('commandSize: sums names, descriptions, choice names and values through every level', () => {
  const command = {
    name: 'abc', // 3
    description: 'Top.', // 4
    options: [
      {
        type: 2,
        name: 'grp', // 3
        description: 'Group.', // 6
        options: [
          {
            type: 1,
            name: 'sub', // 3
            description: 'Sub.', // 4
            options: [
              {
                type: 3,
                name: 'pick', // 4
                description: 'Pick.', // 5
                choices: [{ name: 'Héllo', value: 'hé' }], // 5 + 2
                min_length: 12345, // not counted
              },
              {
                type: 4,
                name: 'num', // 3
                description: 'N.', // 2
                choices: [
                  { name: 'ten', value: 10 },
                  { name: 'neg', value: -2.5 },
                ], // 3 + 2, 3 + 4
              },
            ],
          },
        ],
      },
      { type: 1, name: 'x', description: 'Y.' }, // 1 + 2
    ],
  };
  assert.equal(commandSize(command), 3 + 4 + 3 + 6 + 3 + 4 + 4 + 5 + 5 + 2 + 3 + 2 + 3 + 2 + 3 + 4 + 1 + 2);
});

// ---------------------------------------------------------------------------
// draw: an ephemeral answer with a file
// ---------------------------------------------------------------------------

test('interaction handler: draw maps text and self (self false when omitted)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a lighthouse', self: true } }));
  assert.equal(admin.runCalls[0][0], 'draw');
  assert.deepEqual(admin.runCalls[0][1], { text: 'a lighthouse', self: true });

  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat' } }));
  assert.deepEqual(admin.runCalls[1][1], { text: 'a cat', self: false });

  // A channel: the picture is posted there as the persona.
  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat', channel: { id: 'chan1' } } }));
  assert.deepEqual(admin.runCalls[2][1], { text: 'a cat', self: false, channelId: 'chan1' });
});

test('interaction handler: draw defers ephemerally, then edits the reply with the text and the file', async () => {
  const attachment = Buffer.from('fake-png');
  const admin = fakeAdmin({
    runImpl: () => ({ text: 'openai/x · 12.3s · cost 0.04', files: [{ attachment, name: 'image.png' }] }),
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat' } });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.deepEqual(
    interaction.replies[0],
    { deferred: true, opts: { flags: MessageFlags.Ephemeral } },
    'ephemeral like every reply'
  );
  assert.equal(interaction.edits.length, 1);
  assert.equal(interaction.edits[0].content, 'openai/x · 12.3s · cost 0.04');
  assert.deepEqual(interaction.edits[0].files, [{ attachment, name: 'image.png' }]);
  assert.equal(interaction.followUps.length, 0);
});

test('interaction handler: an object result on a fast command replies ephemerally with its files', async () => {
  const attachment = Buffer.from('fake-png');
  const admin = fakeAdmin({ runImpl: () => ({ text: 'done', files: [{ attachment, name: 'image.png' }] }) });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.deepEqual(interaction.replies[0], {
    content: 'done',
    files: [{ attachment, name: 'image.png' }],
    flags: MessageFlags.Ephemeral,
  });
});

test('interaction handler: a failed draw is reported ephemerally as an error text with no file', async () => {
  const admin = fakeAdmin({
    runImpl: () => {
      throw new Error('draw failed (moderation, HTTP 400)');
    },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat' } });
  await handler(interaction);

  assert.deepEqual(interaction.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } });
  assert.equal(interaction.deletes.length, 0);
  assert.equal(interaction.edits.length, 1);
  assert.match(interaction.edits[0].content, /Error: draw failed \(moderation, HTTP 400\)/);
  assert.equal(interaction.edits[0].files, undefined);
});

// ---------------------------------------------------------------------------
// route: provider routing per model prefix and role (llm.providerByModel)
// ---------------------------------------------------------------------------

test('interaction handler: route.set is refused to a non-owner without a grant; a route.list grant opens only the list', async () => {
  const admin = fakeAdmin({ access: { 'route.list': { roles: ['r1'] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  const member = { roles: ['r1'] };

  const set = fakeInteraction({
    user: { id: 'u1' },
    member,
    group: 'route',
    subcommand: 'set',
    optionValues: { model: 'google/', providers: 'x' },
  });
  await handler(set);
  const list = fakeInteraction({ user: { id: 'u1' }, member, group: 'route', subcommand: 'list' });
  await handler(list);

  assert.equal(set.replies[0].content, 'Not allowed');
  assert.deepEqual(
    admin.runCalls.map(([key]) => key),
    ['route.list']
  );
});

test('autocomplete: the route model option offers the route prefixes and the models in use, filtered', async () => {
  const admin = fakeAdmin();
  const hot = {
    config: {
      bot: { commandName: 'nep', owners: ['owner1'] },
      features: {},
      llm: {
        providerByModel: { 'google/': { only: ['google-vertex'] }, 'google/@video': { only: ['google-ai-studio'] } },
      },
      models: {
        base: {
          core: 'anthropic/claude-opus-4.6',
          analyzer: 'google/gemini-3.8-flash',
          vision: 'google/gemini-3.8-flash',
          video: 'google/gemini-3.8-flash',
          embedding: 'openai/text-embedding-x',
          drawing: 'openai/gpt-image-x',
        },
      },
    },
  };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const all = fakeInteraction({
    kind: 'autocomplete',
    group: 'route',
    subcommand: 'set',
    focused: { name: 'model', value: '' },
  });
  await handler(all);
  assert.deepEqual(
    all.respondCalls[0].map((c) => c.value),
    ['google/', 'anthropic/claude-opus-4.6', 'google/gemini-3.8-flash', 'openai/text-embedding-x', 'openai/gpt-image-x']
  );

  const typed = fakeInteraction({
    kind: 'autocomplete',
    group: 'route',
    subcommand: 'remove',
    focused: { name: 'model', value: 'GOO' },
  });
  await handler(typed);
  assert.deepEqual(
    typed.respondCalls[0].map((c) => c.value),
    ['google/', 'google/gemini-3.8-flash']
  );
});

test("autocomplete: status field offers the card's field names, filtered by the typed text", async () => {
  const hot = { config: { bot: { commandName: 'nep', owners: ['owner1'] }, features: {} } };
  const handler = createInteractionHandler({ hot, admin: fakeAdmin(), getGuildId: () => 'g1' });
  const all = fakeInteraction({ kind: 'autocomplete', subcommand: 'status', focused: { name: 'field', value: '' } });
  await handler(all);
  assert.deepEqual(
    all.respondCalls[0].map((c) => c.value),
    [...STATUS_FIELDS]
  );
  const typed = fakeInteraction({
    kind: 'autocomplete',
    subcommand: 'status',
    focused: { name: 'field', value: 'ERRANDS' },
  });
  await handler(typed);
  assert.deepEqual(
    typed.respondCalls[0].map((c) => c.value),
    ['models.errands', 'costs.errands']
  );
});

test('autocomplete: model set offers the model ids in use; memory restore offers the newest archive ids', async () => {
  const archiveCalls = [];
  const admin = {
    ...fakeAdmin(),
    archiveChoices: async (context, typed) => {
      archiveCalls.push([context.guildId, typed]);
      return [{ name: 'ep-2 (episode)', value: 'ep-2' }];
    },
  };
  const hot = {
    config: {
      bot: { commandName: 'nep', owners: ['owner1'] },
      features: {},
      llm: { providerByModel: {} },
      models: { base: { core: 'anthropic/claude-opus-4.6', vision: 'google/gemini-3.8-flash' } },
    },
  };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const model = fakeInteraction({
    kind: 'autocomplete',
    group: 'model',
    subcommand: 'set',
    focused: { name: 'id', value: 'GEM' },
  });
  await handler(model);
  assert.deepEqual(
    model.respondCalls[0].map((c) => c.value),
    ['google/gemini-3.8-flash']
  );

  const restore = fakeInteraction({
    kind: 'autocomplete',
    group: 'memory',
    subcommand: 'restore',
    focused: { name: 'id', value: 'EP' },
  });
  await handler(restore);
  assert.deepEqual(archiveCalls, [['g1', 'ep']]);
  assert.deepEqual(restore.respondCalls[0], [{ name: 'ep-2 (episode)', value: 'ep-2' }]);

  // lore show's `id` is no autocomplete: nothing offered.
  const lore = fakeInteraction({
    kind: 'autocomplete',
    group: 'lore',
    subcommand: 'show',
    focused: { name: 'id', value: '' },
  });
  await handler(lore);
  assert.deepEqual(lore.respondCalls[0], []);

  // A member without the right gets nothing, the archive unread.
  const member = fakeInteraction({
    kind: 'autocomplete',
    user: { id: 'helper1' },
    group: 'memory',
    subcommand: 'restore',
    focused: { name: 'id', value: '' },
  });
  await handler(member);
  assert.deepEqual(member.respondCalls[0], []);
  assert.equal(archiveCalls.length, 1);
});

test('interaction handler: a command still running after deferAfterMs is deferred, then edited with its result', async () => {
  const admin = fakeAdmin({ runImpl: () => new Promise((resolve) => setTimeout(() => resolve('slow result'), 40)) });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1', deferAfterMs: 5 });
  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);
  assert.equal(interaction.deferred, true);
  assert.equal(interaction.edits.at(-1).content, 'slow result');
});

// ---------------------------------------------------------------------------
// The command.requested event (src/protocol/)
// ---------------------------------------------------------------------------

test('commandEvent: an interaction becomes a valid command.requested event', () => {
  const interaction = fakeInteraction({
    id: 'i-event',
    user: { id: 'helper1', globalName: 'Ελένη' },
    member: {
      displayName: 'Λένα',
      roles: {
        cache: new Map([
          ['staff', {}],
          ['mods', {}],
        ]),
      },
    },
    group: 'memory',
    subcommand: 'show',
  });
  const event = commandEvent(interaction, 'memory.show', { userId: 'u2' }, baseHot().config, 'command-7', 1234);
  assert.deepEqual(validateEvent(event), { ok: true });
  assert.deepEqual(event, {
    kind: 'command.requested',
    iface: 'discord',
    at: 1234,
    id: 'discord:command:i-event',
    conversation: { id: 'c1', kind: 'channel', guildId: 'g1', name: null },
    name: 'memory.show',
    args: { userId: 'u2' },
    requester: { id: 'helper1', name: 'Λένα', roles: ['staff', 'mods'], owner: false },
    replyRef: 'command-7',
  });
  const owner = commandEvent(fakeInteraction({ id: undefined }), 'status', {}, baseHot().config, 'command-8', 1);
  assert.equal(owner.requester.owner, true, 'bot.owners names the requester');
  assert.equal(owner.requester.name, null, 'no display name known');
});

test("interaction handler: the operation runs on the event's name, args and requester; the reply reaches the interaction", async () => {
  const admin = fakeAdmin({
    owners: ['owner1'],
    access: { 'status.show': { everyone: false, roles: ['staff'], users: [] } },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1', now: () => 5000 });
  const interaction = fakeInteraction({
    user: { id: 'helper1' },
    member: { roles: ['staff'] },
    channelId: 'c7',
    subcommand: 'status',
    optionValues: { field: 'limits' },
  });
  await handler(interaction);
  assert.deepEqual(admin.runCalls, [
    ['status', { field: 'limits' }, { guildId: 'g1', channelId: 'c7', userId: 'helper1', roleIds: ['staff'] }],
  ]);
  assert.equal(interaction.replies[0].content, 'ok: status');
});

test('interaction handler: a malformed command event is dropped with one warn line, no operation, no content', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  const interaction = fakeInteraction({ user: { id: 42 }, subcommand: 'status' });
  const { logs } = await withCapturedLogs(() => handler(interaction));
  assert.equal(admin.runCalls.length, 0);
  assert.equal(interaction.replies.length, 0);
  const warned = logs.filter((line) => line.msg === 'interface: invalid event');
  assert.deepEqual(
    warned.map((line) => [line.kind, line.reason]),
    [['command.requested', 'requester.id:type']]
  );
});
