// Tests for src/discord/commands.js: the pure command tree, command-name
// validation, guild registration (including the swallowed-failure path) and
// the interaction handler (owner gate, option -> args mapping, defer/edit,
// chunked follow-ups, autocomplete).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import {
  buildCommandTree,
  isValidCommandName,
  registerCommands,
  createInteractionHandler,
  leafPaths,
  commandKeys,
  commandSize,
  MODEL_ROLES,
  MODEL_SET_ROLES,
} from '../src/discord/commands.js';
import { isAllowed as accessIsAllowed } from '../src/discord/access.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

function findOption(options, name) {
  return options?.find((o) => o.name === name);
}

// ---------------------------------------------------------------------------
// buildCommandTree
// ---------------------------------------------------------------------------

test('buildCommandTree: one top-level command, named from the argument', () => {
  // Not the default name: a name hard-coded in the tree builder must fail here.
  const tree = buildCommandTree('bot2');
  assert.equal(tree.length, 1);
  const [command] = tree;
  assert.equal(command.name, 'bot2');
});

test('buildCommandTree: no subcommand or group name anywhere in the tree contains a hyphen', () => {
  const [command] = buildCommandTree('nep');
  const names = [];
  const walk = (options) => {
    for (const option of options ?? []) {
      if (option.type === 1 || option.type === 2) {
        names.push(option.name);
        walk(option.options);
      }
    }
  };
  walk(command.options);
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(!name.includes('-'), `${name} must not contain a hyphen`);
});

test('MODEL_ROLES: the model-set, route and ping role choices are all derived from the one list', () => {
  const [command] = buildCommandTree('nep');
  const values = (option) => option.choices.map((c) => c.value);
  const names = (option) => option.choices.map((c) => c.name);
  const setRole = findOption(findOption(findOption(command.options, 'model').options, 'set').options, 'role');
  assert.deepEqual(values(setRole), [...MODEL_ROLES, 'image'], 'the chat roles, then the drawing model');
  assert.deepEqual([...MODEL_SET_ROLES], [...MODEL_ROLES, 'image']);
  assert.ok(MODEL_ROLES.includes('voice') && !MODEL_ROLES.includes('talk') && !MODEL_ROLES.includes('image'));
  const route = findOption(command.options, 'route');
  for (const sub of ['set', 'remove']) {
    const role = findOption(findOption(route.options, sub).options, 'role');
    assert.deepEqual(values(role), [...MODEL_ROLES, 'image'], sub);
    assert.deepEqual(names(role), values(role), sub);
  }
  const pingRole = findOption(findOption(command.options, 'ping').options, 'role');
  assert.deepEqual(values(pingRole), [...MODEL_ROLES, 'image', 'classifier']);
  assert.deepEqual(names(pingRole), values(pingRole));
});

// ---------------------------------------------------------------------------
// commandKeys
// ---------------------------------------------------------------------------

test('buildCommandTree: pings is a top-level subcommand with an optional mode of on or off', () => {
  const pings = findOption(buildCommandTree('nep')[0].options, 'pings');
  assert.equal(pings.type, 1);
  assert.equal(pings.options.length, 1);
  const [mode] = pings.options;
  assert.equal(mode.name, 'mode');
  assert.equal(mode.required, false);
  assert.deepEqual(mode.choices, [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }]);
  assert.ok(commandKeys().keys.has('pings'));
});

test('commandKeys: every group and every leaf command key, derived from the tree', () => {
  const { keys, groups } = commandKeys();
  assert.ok(groups.has('memory'));
  assert.ok(groups.has('rule'));
  assert.ok(groups.has('lore'));
  assert.ok(groups.has('model'));
  assert.ok(groups.has('warmup'));
  assert.ok(groups.has('access'));
  assert.ok(groups.has('alias'));
  assert.ok(groups.has('learned'));
  assert.ok(groups.has('private'));
  assert.ok(!groups.has('status'), 'a bare top-level command is not a group');
  assert.ok(keys.has('private.show'));
  assert.ok(keys.has('private.forget'));
  assert.ok(keys.has('private.purge'));

  assert.ok(keys.has('status'));
  assert.ok(keys.has('memory.show'));
  assert.ok(keys.has('access.grant'));
  assert.ok(keys.has('access.revoke'));
  assert.ok(keys.has('access.list'));
  assert.ok(keys.has('alias.add'));
  assert.ok(keys.has('alias.remove'));
  assert.ok(keys.has('learned.list'));
  assert.ok(keys.has('learned.add'));
  assert.ok(keys.has('learned.remove'));
  assert.ok(!keys.has('memory.alias-add'));
  assert.ok(!keys.has('memory.alias-remove'));
  assert.ok(!keys.has('memory'), 'a group name alone is not a leaf key');
});

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
    { name: 'DiscordAPIError[50035]', code: 50035 },
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

/** A fake admin whose `isAllowed` runs the real, pure src/discord/access.js#isAllowed against
 * `owners`/`access`, exactly the way src/admin.js#createAdmin wires it -- so these tests exercise
 * the real gating logic, not a stand-in for it. */
function fakeAdmin({ owners = ['owner1'], access = {}, runImpl } = {}) {
  const runCalls = [];
  return {
    isOwner: (userId) => owners.includes(String(userId)),
    isAllowed: (commandKey, { userId, roleIds } = {}) =>
      accessIsAllowed({ commandKey, userId, roleIds, owners, access }),
    run: async (commandKey, args, context) => {
      runCalls.push([commandKey, args, context]);
      if (runImpl) return runImpl(commandKey, args, context);
      return `ok: ${commandKey}`;
    },
    runCalls,
  };
}

function fakeInteraction(overrides = {}) {
  const replies = [];
  const followUps = [];
  const edits = [];
  const respondCalls = [];
  const optionValues = overrides.optionValues ?? {};
  const interaction = {
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
    followUp: async (payload) => {
      followUps.push(payload);
    },
    respond: async (choices) => {
      respondCalls.push(choices);
    },
    replies,
    edits,
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
      llm: {}, memory: {}, relationships: {}, spontaneous: {}, mention: {},
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

test('interaction handler: a non-owner granted the exact command key by role is let through', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { status: { everyone: false, roles: ['staff'], users: [] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'helper1' }, member: { roles: ['staff'] }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 1);
  assert.equal(admin.runCalls[0][0], 'status');
  assert.equal(interaction.replies[0].content, 'ok: status');
});

test('interaction handler: a non-owner with a grant on a DIFFERENT key is still refused', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { ping: { everyone: true, roles: [], users: [] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'helper1' }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.match(interaction.replies[0].content, /not allowed/i);
});

test('interaction handler: /nep private and /nep mentor stay owner-only even with a grant on them, their group or *', async () => {
  const open = { everyone: true, roles: [], users: [] };
  // [group, every subcommand, their options, the owner's own call]
  for (const [group, subcommands, optionValues, ownerCall] of [
    ['private', ['show', 'forget', 'purge'], { user: { id: 'target1' } }, { subcommand: 'show', optionValues: { user: { id: 'target1' } } }],
    ['mentor', MENTOR_SUBCOMMANDS, { id: 1 }, { subcommand: 'status' }],
  ]) {
    const access = { '*': open, [group]: open, ...Object.fromEntries(subcommands.map((name) => [`${group}.${name}`, open])) };
    const admin = fakeAdmin({ owners: ['owner1'], access });
    const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

    for (const subcommand of subcommands) {
      const interaction = fakeInteraction({ user: { id: 'helper1' }, group, subcommand, optionValues });
      await handler(interaction);
      assert.match(interaction.replies[0].content, /not allowed/i, `${group} ${subcommand}`);
    }
    assert.equal(admin.runCalls.length, 0, group);

    await handler(fakeInteraction({ group, ...ownerCall }));
    assert.equal(admin.runCalls.length, 1, `${group}: the owner still runs it`);
  }
});

test('interaction handler: access.grant/revoke map command/role/user straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({
    group: 'access',
    subcommand: 'grant',
    optionValues: { command: 'memory', role: { id: 'role1' } },
  }));
  assert.equal(admin.runCalls[0][0], 'access.grant');
  assert.deepEqual(admin.runCalls[0][1], { command: 'memory', roleId: 'role1', userId: undefined });

  await handler(fakeInteraction({
    group: 'access',
    subcommand: 'revoke',
    optionValues: { command: 'memory', user: { id: 'user1' } },
  }));
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
  assert.deepEqual(admin.runCalls[0][2], { guildId: 'g1', channelId: 'c1', userId: 'owner1' });
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(interaction.replies[0].content, 'ok: status');
});

test('interaction handler: pings maps mode (undefined when omitted) and runs for a member with no grant', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: {} });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const off = fakeInteraction({ subcommand: 'pings', user: { id: 'member1' }, optionValues: { mode: 'off' } });
  await handler(off);
  await handler(fakeInteraction({ subcommand: 'pings', user: { id: 'member1' } }));

  assert.deepEqual(admin.runCalls.map(([key, args]) => [key, args]), [['pings', { mode: 'off' }], ['pings', { mode: undefined }]]);
  assert.deepEqual(admin.runCalls[0][2], { guildId: 'g1', channelId: 'c1', userId: 'member1' });
  assert.deepEqual(off.replies, [{ content: 'ok: pings', flags: MessageFlags.Ephemeral }], 'answered at once, not deferred');
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

test('interaction handler: emoji.status replies at once, emoji.rescan is deferred', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const status = fakeInteraction({ group: 'emoji', subcommand: 'status' });
  await handler(status);
  assert.equal(admin.runCalls[0][0], 'emoji.status');
  assert.deepEqual(admin.runCalls[0][1], {});
  assert.ok(!status.replies.some((r) => r.deferred));

  const rescan = fakeInteraction({ group: 'emoji', subcommand: 'rescan' });
  await handler(rescan);
  assert.equal(admin.runCalls[1][0], 'emoji.rescan');
  assert.deepEqual(admin.runCalls[1][1], {});
  assert.ok(rescan.replies.some((r) => r.deferred));
  assert.equal(rescan.edits.length, 1);
});

test('interaction handler: memory.forget, memory.wipe and private.forget are deferred (they wait for the analyzer)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  for (const [group, subcommand, optionValues] of [
    ['memory', 'forget', { user: { id: 'target1' } }],
    ['memory', 'wipe', { confirm: 'The Server' }],
    ['private', 'forget', { user: { id: 'target1' } }],
  ]) {
    const interaction = fakeInteraction({ group, subcommand, optionValues });
    await handler(interaction);
    assert.ok(interaction.replies.some((r) => r.deferred), `${group}.${subcommand}`);
    assert.equal(interaction.edits.length, 1, `${group}.${subcommand}`);
  }
});

test('interaction handler: gifs.recache replies at once, its work goes on in the background', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const recache = fakeInteraction({ group: 'gifs', subcommand: 'recache' });
  await handler(recache);
  assert.equal(admin.runCalls[0][0], 'gifs.recache');
  assert.deepEqual(admin.runCalls[0][1], {});
  assert.ok(!recache.replies.some((r) => r.deferred));
});

test('interaction handler: memory.channel maps the optional channel option to channelId (undefined when omitted)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'memory', subcommand: 'channel', optionValues: { channel: { id: 'chan1' } } }));
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

test('interaction handler: private.purge defers, maps the user option to userId and edits the reply', async () => {
  const admin = fakeAdmin({ runImpl: () => 'purged' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ group: 'private', subcommand: 'purge', optionValues: { user: { id: 'target1' } } });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'private.purge');
  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1' });
  assert.equal(interaction.deferred, true);
  assert.deepEqual(interaction.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } });
  assert.equal(interaction.edits[0].content, 'purged');
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

test('interaction handler: defers then edits for every warmup subcommand (slow commands)', async () => {
  const admin = fakeAdmin({ runImpl: () => 'warmup result' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const peopleInteraction = fakeInteraction({ group: 'warmup', subcommand: 'people' });
  await handler(peopleInteraction);
  assert.equal(peopleInteraction.deferred, true);
  assert.equal(peopleInteraction.edits[0].content, 'warmup result');

  const usersInteraction = fakeInteraction({ group: 'warmup', subcommand: 'users', optionValues: { user: { id: 'target1' } } });
  await handler(usersInteraction);
  assert.equal(usersInteraction.deferred, true);
  assert.equal(usersInteraction.edits[0].content, 'warmup result');

  const usersBulkInteraction = fakeInteraction({ group: 'warmup', subcommand: 'users' });
  await handler(usersBulkInteraction);
  assert.equal(usersBulkInteraction.deferred, true);

  const channelsInteraction = fakeInteraction({ group: 'warmup', subcommand: 'channels', optionValues: { channel: { id: 'chan1' } } });
  await handler(channelsInteraction);
  assert.equal(channelsInteraction.deferred, true);

  const channelsBulkInteraction = fakeInteraction({ group: 'warmup', subcommand: 'channels' });
  await handler(channelsBulkInteraction);
  assert.equal(channelsBulkInteraction.deferred, true);

  const serverInteraction = fakeInteraction({ group: 'warmup', subcommand: 'server' });
  await handler(serverInteraction);
  assert.equal(serverInteraction.deferred, true);

  const resetInteraction = fakeInteraction({ group: 'warmup', subcommand: 'reset' });
  await handler(resetInteraction);
  assert.equal(resetInteraction.deferred, true);

  const stopInteraction = fakeInteraction({ group: 'warmup', subcommand: 'stop' });
  await handler(stopInteraction);
  assert.equal(stopInteraction.deferred, true);
  assert.equal(stopInteraction.edits[0].content, 'warmup result');
});

test('interaction handler: defers then edits for a slow command (ping)', async () => {
  const admin = fakeAdmin({ runImpl: () => 'voice: x — ok, 100ms' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'ping', optionValues: {} });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.equal(interaction.edits.length, 1);
  assert.equal(interaction.edits[0].content, 'voice: x — ok, 100ms');
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
  const config = { bot: { commandName: 'nep', owners: ['owner1'] }, features: {}, llm: { model: 'x', maxOutputTokens: 1 } };
  const hot = { config };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ kind: 'autocomplete', subcommand: 'set', focused: { name: 'path', value: 'llm.' } });
  await handler(interaction);

  assert.equal(interaction.respondCalls.length, 1);
  const choices = interaction.respondCalls[0];
  assert.ok(choices.length <= 25);
  assert.ok(choices.every((c) => c.name.toLowerCase().includes('llm.')));
  assert.ok(choices.some((c) => c.name === 'llm.model'));
});

test('autocomplete: command-option choices for /nep access grant|revoke -- every key, group and *, filtered', async () => {
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
  assert.ok(choices.some((c) => c.name === 'memory.show'));
});

test('autocomplete: command-option choices never offer the owner-only private and mentor commands', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  // [owner-only group, a typed prefix of it]
  for (const [group, typed] of [['private', 'priv'], ['mentor', 'ment']]) {
    for (const [subcommand, value] of [['grant', typed], ['revoke', typed], ['grant', '']]) {
      const interaction = fakeInteraction({ kind: 'autocomplete', group: 'access', subcommand, focused: { name: 'command', value } });
      await handler(interaction);
      const names = interaction.respondCalls[0].map((c) => c.name);
      assert.ok(!names.some((name) => name === group || name.startsWith(`${group}.`)), `${group}: ${subcommand} "${value}"`);
    }
  }
});

test('autocomplete: command-option choices never offer the member command pings', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ kind: 'autocomplete', group: 'access', subcommand: 'grant', focused: { name: 'command', value: 'pings' } });
  await handler(interaction);
  assert.deepEqual(interaction.respondCalls[0], []);
});

test('autocomplete: a non-owner granted * by role gets path choices, never command-key choices (access is owner-only)', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { '*': { everyone: false, roles: ['staff'], users: [] } } });
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
  const owner = fakeInteraction({ kind: 'autocomplete', group: 'access', subcommand: 'grant', focused: { name: 'command', value: '' } });
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

test('buildCommandTree: every description fits Discord\'s 1..100 character limit', () => {
  const tree = buildCommandTree('nep');
  const top = Array.isArray(tree) ? tree[0] : tree;
  const walk = (o, path) => {
    if (o.description !== undefined) {
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${path}: ${o.description.length} chars`);
    }
    for (const x of o.options || []) walk(x, `${path}/${x.name}`);
  };
  walk(top, top.name);
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
                choices: [{ name: 'ten', value: 10 }, { name: 'neg', value: -2.5 }], // 3 + 2, 3 + 4
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

test('buildCommandTree: the whole command stays under 7600 characters (Discord refuses over 8000)', () => {
  const [command] = buildCommandTree('nep');
  const size = commandSize(command);
  assert.ok(size <= 7600, `the command tree is ${size} characters`);
  // The longest valid command name leaves the same margin.
  assert.ok(commandSize(buildCommandTree('a'.repeat(32))[0]) <= 7600 + 29);
});

test('buildCommandTree: at most 25 options and 25 choices per level, valid names, choice names 1..100', () => {
  const [command] = buildCommandTree('nep');
  const walk = (o, path) => {
    assert.ok((o.options ?? []).length <= 25, `${path}: ${(o.options ?? []).length} options`);
    assert.ok((o.choices ?? []).length <= 25, `${path}: ${(o.choices ?? []).length} choices`);
    for (const choice of o.choices ?? []) {
      assert.ok(choice.name.length >= 1 && choice.name.length <= 100, `${path}: choice ${choice.name}`);
      assert.ok(String(choice.value).length >= 1 && String(choice.value).length <= 100, `${path}: choice value ${choice.value}`);
    }
    for (const x of o.options ?? []) {
      assert.ok(isValidCommandName(x.name), `${path}/${x.name}: invalid name`);
      walk(x, `${path}/${x.name}`);
    }
  };
  walk(command, command.name);
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
});

test('interaction handler: draw defers, then edits the reply with the text and the file', async () => {
  const attachment = Buffer.from('fake-png');
  const admin = fakeAdmin({ runImpl: () => ({ text: 'openai/x · 12.3s · cost 0.04', files: [{ attachment, name: 'image.png' }] }) });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat' } });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.deepEqual(interaction.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } });
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

  assert.deepEqual(interaction.replies[0], { content: 'done', files: [{ attachment, name: 'image.png' }], flags: MessageFlags.Ephemeral });
});

test('interaction handler: a failed draw is reported as an error text with no file', async () => {
  const admin = fakeAdmin({
    runImpl: () => {
      throw new Error('draw failed (moderation, HTTP 400)');
    },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat' } });
  await handler(interaction);

  assert.equal(interaction.edits.length, 1);
  assert.match(interaction.edits[0].content, /Error: draw failed \(moderation, HTTP 400\)/);
  assert.equal(interaction.edits[0].files, undefined);
});

// ---------------------------------------------------------------------------
// mentor: the owner-only group that measures the persona in a sandbox
// ---------------------------------------------------------------------------

const MENTOR_SUBCOMMANDS = ['add', 'anchor', 'cases', 'remove', 'run', 'check', 'stop', 'show', 'wrong', 'status'];

test('interaction handler: mentor.add/anchor/run/check/show defer; the other mentor commands reply directly', async () => {
  const admin = fakeAdmin({ runImpl: () => 'mentor result' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  const slow = new Set(['add', 'anchor', 'run', 'check', 'show']);
  for (const subcommand of MENTOR_SUBCOMMANDS) {
    const interaction = fakeInteraction({ group: 'mentor', subcommand, optionValues: { id: 1, text: 'a case text', message: '800000000000000004', reason: 'why' } });
    await handler(interaction);
    assert.equal(interaction.deferred, slow.has(subcommand), subcommand);
    if (slow.has(subcommand)) assert.equal(interaction.edits[0].content, 'mentor result', subcommand);
    else assert.deepEqual(interaction.replies[0], { content: 'mentor result', flags: MessageFlags.Ephemeral }, subcommand);
  }
});

// ---------------------------------------------------------------------------
// route: provider routing per model prefix and role (llm.providerByModel)
// ---------------------------------------------------------------------------

test('interaction handler: route.set is refused to a non-owner without a grant; a route.list grant opens only the list', async () => {
  const admin = fakeAdmin({ access: { 'route.list': { roles: ['r1'] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  const member = { roles: ['r1'] };

  const set = fakeInteraction({ user: { id: 'u1' }, member, group: 'route', subcommand: 'set', optionValues: { model: 'google/', providers: 'x' } });
  await handler(set);
  const list = fakeInteraction({ user: { id: 'u1' }, member, group: 'route', subcommand: 'list' });
  await handler(list);

  assert.equal(set.replies[0].content, 'Not allowed');
  assert.deepEqual(admin.runCalls.map(([key]) => key), ['route.list']);
});

test('autocomplete: the route model option offers the route prefixes and the models in use, filtered', async () => {
  const admin = fakeAdmin();
  const hot = {
    config: {
      bot: { commandName: 'nep', owners: ['owner1'] },
      features: {},
      llm: { model: 'anthropic/claude-opus-4.6', providerByModel: { 'google/': { only: ['google-vertex'] }, 'google/@classifier.video': { only: ['google-ai-studio'] } } },
      memory: { model: null },
      classifier: { text: null, media: 'google/gemini-3.8-flash', video: 'google/gemini-3.8-flash' },
      image: { model: 'openai/gpt-image-x' },
    },
  };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const all = fakeInteraction({ kind: 'autocomplete', group: 'route', subcommand: 'set', focused: { name: 'model', value: '' } });
  await handler(all);
  assert.deepEqual(all.respondCalls[0].map((c) => c.value), ['google/', 'anthropic/claude-opus-4.6', 'google/gemini-3.8-flash', 'openai/gpt-image-x']);

  const typed = fakeInteraction({ kind: 'autocomplete', group: 'route', subcommand: 'remove', focused: { name: 'model', value: 'GOO' } });
  await handler(typed);
  assert.deepEqual(typed.respondCalls[0].map((c) => c.value), ['google/', 'google/gemini-3.8-flash']);
});
