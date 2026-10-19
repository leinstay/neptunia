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
  commandKeys,
  commandEvent,
} from '../src/interface/discord.js';
import {
  isValidCommandName,
  leafPaths,
  commandSize,
  COMMAND_TABLE,
  MODEL_ROLES,
  MODEL_SET_ROLES,
  STATUS_FIELDS,
  readFlag,
} from '../src/ops/catalog.js';
import { validateEvent } from '../src/protocol.js';
import { isAllowed as accessIsAllowed } from '../src/ops/grants.js';
import { resolveCommand, asResult, listOps } from '../src/ops/index.js';
import { getOp } from '../src/ops/registry.js';
import { grantKeys } from '../src/ops/access.js';
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

test('status: an optional field option whose choices are the field names of the card, names as values', () => {
  const [command] = buildCommandTree('nep');
  const field = findOption(findOption(command.options, 'status').options, 'field');
  assert.equal(field.type, 3);
  assert.equal(field.required, false);
  assert.deepEqual(field.choices.map((c) => c.value), [...STATUS_FIELDS]);
  assert.deepEqual(field.choices.map((c) => c.name), [...STATUS_FIELDS]);
  for (const choice of field.choices) assert.ok(choice.value.length >= 1 && choice.value.length <= 100, choice.value);
  assert.deepEqual([...STATUS_FIELDS], ['state', 'tasks', 'models.base', 'keys.base', 'costs.base', 'models.agents', 'costs.agents', 'limits', 'memory', 'speed'], 'the core\'s sections, then the agents\'');
  for (const name of STATUS_FIELDS) assert.match(name, /^[a-z]+(\.[a-z]+)?$/, name);
});

test('interaction handler: status passes the chosen field into its args, null without one', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  await handler(fakeInteraction({ subcommand: 'status', optionValues: { field: 'limits' } }));
  await handler(fakeInteraction({ subcommand: 'status' }));
  assert.deepEqual(admin.runCalls.map((call) => call[1]), [{ field: 'limits' }, { field: null }]);
});

test('status: no detail option', () => {
  const [command] = buildCommandTree('nep');
  assert.deepEqual(findOption(command.options, 'status').options.map((o) => o.name), ['field']);
});

test('buildCommandTree: no BOOLEAN option is left; every yes/no option is a STRING with lowercase true/false choices', () => {
  const [command] = buildCommandTree('nep');
  const all = [];
  const walk = (options) => {
    for (const option of options ?? []) {
      all.push(option);
      walk(option.options);
    }
  };
  walk(command.options);
  assert.deepEqual(all.filter((option) => option.type === 5).map((option) => option.name), []);
  const flags = all.filter((option) => option.type === 3 && option.choices?.some((choice) => choice.value === 'true'));
  assert.deepEqual(flags.map((option) => option.name).sort(), ['always', 'byok', 'fallbacks', 'self']);
  for (const option of flags) assert.deepEqual(option.choices, [{ name: 'true', value: 'true' }, { name: 'false', value: 'false' }], option.name);
});

test('readFlag: true/false as text (any case) or as a boolean; anything else is null', () => {
  const reader = (value) => ({ getString: () => value });
  assert.deepEqual(['true', 'false', ' TRUE ', 'False', true, false].map((value) => readFlag(reader(value), 'x')), [true, false, true, false, true, false]);
  for (const value of [null, undefined, '', 'yes', '1', 1]) assert.equal(readFlag(reader(value), 'x'), null, String(value));
});

test('interaction handler: a yes/no option reaches the args as a boolean, its default when left out', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a lighthouse', self: 'true' } }));
  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a lighthouse' } }));
  assert.deepEqual(admin.runCalls.map((call) => call[1].self), [true, false]);
});

test('buildCommandTree: route set has an optional STRING byok option with the true/false choices, reaching the args as a boolean', async () => {
  const [command] = buildCommandTree('nep');
  const set = findOption(findOption(command.options, 'route').options, 'set');
  const byok = findOption(set.options, 'byok');
  assert.equal(byok.type, 3);
  assert.equal(byok.required, false);
  assert.deepEqual(byok.choices, [{ name: 'true', value: 'true' }, { name: 'false', value: 'false' }]);
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  for (const value of ['true', 'false', undefined]) {
    const optionValues = { model: 'google/', providers: 'google-vertex', ...(value === undefined ? {} : { byok: value }) };
    await handler(fakeInteraction({ group: 'route', subcommand: 'set', optionValues }));
  }
  assert.deepEqual(admin.runCalls.map((call) => call[1].byok), [true, false, undefined]);
});

test('MODEL_ROLES: the model-set, route and ping role choices are all derived from the one list', () => {
  const [command] = buildCommandTree('nep');
  const values = (option) => option.choices.map((c) => c.value);
  const names = (option) => option.choices.map((c) => c.name);
  const setRole = findOption(findOption(findOption(command.options, 'model').options, 'set').options, 'role');
  const agents = ['web', 'server', 'thinker', 'dev', 'writer'];
  assert.deepEqual(values(setRole), [...MODEL_ROLES, ...agents, 'drawing'], 'the chat and embedding roles (models.base), then the agents\' roles (models.agents), drawing last');
  assert.deepEqual([...MODEL_SET_ROLES], [...MODEL_ROLES, ...agents, 'drawing']);
  assert.ok(MODEL_ROLES.includes('voice') && !MODEL_ROLES.includes('talk') && !MODEL_ROLES.includes('drawing'));
  assert.ok(MODEL_ROLES.includes('analyzer') && MODEL_ROLES.includes('embedding') && !MODEL_ROLES.includes('reasoner'), 'the helper and the embedding roles are set and routed like the others; the reasoner is merged into the analyzer');
  assert.ok(!agents.some((role) => MODEL_ROLES.includes(role)), 'the agent roles are never probed');
  const route = findOption(command.options, 'route');
  for (const sub of ['set', 'remove']) {
    const role = findOption(findOption(route.options, sub).options, 'role');
    assert.deepEqual(values(role), [...MODEL_ROLES, 'drawing'], `${sub}: no agent role (the bot routes none)`);
    assert.deepEqual(names(role), values(role), sub);
  }
});

test('buildCommandTree: the exact top-level list (19 entries, no warmup, no skill group, no talk)', () => {
  const [command] = buildCommandTree('nep');
  const top = command.options.map((option) => option.name);
  assert.deepEqual(top, [
    'status', 'set', 'unset', 'pause', 'resume', 'draw', 'pings', 'media',
    'model', 'route', 'rule', 'access', 'message', 'diary', 'task', 'alias', 'learning', 'lore', 'memory',
  ]);
  assert.deepEqual(COMMAND_TABLE.map((node) => node.name), top, 'the tree is the table');
  const groups = Object.fromEntries(command.options.filter((o) => o.type === 2).map((o) => [o.name, o.options.map((sub) => sub.name)]));
  assert.deepEqual(groups, {
    model: ['show', 'set'],
    route: ['list', 'set', 'remove'],
    rule: ['add', 'list', 'remove'],
    access: ['grant', 'revoke', 'list'],
    message: ['create', 'edit', 'delete', 'react'],
    diary: ['set', 'show', 'off', 'post'],
    task: ['run', 'status', 'cancel', 'list', 'intent', 'search', 'read'],
    alias: ['add', 'remove'],
    learning: ['add', 'remove'],
    lore: ['add', 'list', 'show', 'remove'],
    memory: ['show', 'channel', 'server', 'recent', 'refresh', 'forget', 'affinity', 'wipe', 'journal', 'archive', 'restore', 'snapshot', 'private', 'search'],
  });
  const choices = (option) => option.choices.map((c) => c.value);
  const message = findOption(command.options, 'message');
  const create = findOption(message.options, 'create');
  // A person gives a channel and a message to answer; her own text is never a Discord option.
  assert.deepEqual(create.options.map((option) => option.name), ['channel', 'reply']);
  assert.equal(JSON.stringify(command).includes('personaOptions'), false);
  assert.deepEqual(choices(findOption(findOption(message.options, 'react').options, 'action')), ['add', 'remove']);
  const media = findOption(command.options, 'media');
  assert.deepEqual(choices(findOption(media.options, 'kind')), ['emoji', 'gifs', 'pictures']);
  assert.deepEqual([findOption(media.options, 'days').required, findOption(media.options, 'days').min_value, findOption(media.options, 'days').max_value], [false, 1, 60]);
  assert.deepEqual(choices(findOption(media.options, 'action')), ['status', 'rescan', 'recache']);
  const privateMemory = findOption(findOption(command.options, 'memory').options, 'private');
  assert.deepEqual(choices(findOption(privateMemory.options, 'action')), ['show', 'forget', 'purge']);
  assert.equal(findOption(privateMemory.options, 'user').required, true);
  const refresh = findOption(findOption(command.options, 'memory').options, 'refresh');
  assert.deepEqual(refresh.options.map((o) => [o.name, o.required]), [['kind', true], ['user', false], ['channel', false]]);
  assert.deepEqual(choices(findOption(refresh.options, 'kind')), ['user', 'channel', 'server']);
});

test('buildCommandTree: option names are lowercase and no name carries a hyphen', () => {
  const [command] = buildCommandTree('nep');
  const names = [];
  const walk = (options) => {
    for (const option of options ?? []) {
      names.push(option.name);
      walk(option.options);
    }
  };
  walk(command.options);
  assert.ok(names.length > 50);
  for (const name of names) {
    assert.equal(name, name.toLowerCase(), `${name} must be lowercase`);
    assert.ok(!name.includes('-'), `${name} must not contain a hyphen`);
  }
  const restore = findOption(findOption(command.options, 'memory').options, 'restore');
  assert.deepEqual(restore.options.map((o) => o.name), ['id'], 'restore takes `id`, not `item`');
});

test('buildCommandTree: the whole command with every description stays under the limit', () => {
  const [command] = buildCommandTree('nep');
  const size = commandSize(command);
  const json = JSON.stringify(command).length;
  assert.ok(size <= 7600, `the command counts ${size} characters toward Discord's 8000 (serialized JSON: ${json})`);
  // Every node carries a description, so the count above covers them all.
  const walk = (node, path) => {
    assert.ok(typeof node.description === 'string' && node.description.length > 0, `${path} has no description`);
    for (const option of node.options ?? []) walk(option, `${path}/${option.name}`);
  };
  walk(command, command.name);
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
  assert.ok(!groups.has('warmup'), 'the warmup is tools/warmup.mjs, not a command');
  assert.ok(groups.has('access'));
  assert.ok(groups.has('alias'));
  assert.ok(groups.has('learning'));
  assert.ok(!groups.has('learned'), 'renamed to learning');
  assert.ok(!groups.has('private'), 'private memory lives under memory');
  assert.ok(!groups.has('emoji') && !groups.has('gifs'), 'not registered any more');
  assert.ok(!groups.has('status'), 'a bare top-level command is not a group');
  assert.ok(keys.has('memory.private'));
  assert.ok(keys.has('message.create'));
  assert.ok(keys.has('media'));
  for (const gone of ['private.show', 'private.forget', 'private.purge', 'emoji.status', 'gifs.recache', 'interject', 'initiate', 'talk', 'skill.allow', 'ping', 'reload', 'learned.list']) {
    assert.ok(!keys.has(gone), `${gone} is not in the tree`);
  }

  assert.ok(keys.has('status'));
  assert.ok(keys.has('memory.show'));
  assert.ok(keys.has('access.grant'));
  assert.ok(keys.has('access.revoke'));
  assert.ok(keys.has('access.list'));
  assert.ok(keys.has('alias.add'));
  assert.ok(keys.has('alias.remove'));
  assert.ok(!keys.has('learned.list') && !keys.has('learning.list'), 'no list command');
  assert.ok(keys.has('learning.add'));
  assert.ok(keys.has('learning.remove'));
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
      if (!isAllowed(commandKey, context, args)) return { status: 'denied', code: 'not-granted', summary: 'Not allowed', data: null };
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

test('interaction handler: a non-owner granted the exact operation by role is let through', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { 'status.show': { everyone: false, roles: ['staff'], users: [] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'helper1' }, member: { roles: ['staff'] }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 1);
  assert.equal(admin.runCalls[0][0], 'status');
  assert.equal(interaction.replies[0].content, 'ok: status');
});

test('interaction handler: a non-owner with a grant on a DIFFERENT operation, or on the old command key, is still refused', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { 'rule.list': { everyone: true, roles: [], users: [] }, status: { everyone: true, roles: [], users: [] } } });
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
      ['memory', 'memory.private', 'memory.private.read', 'memory.private.forget', 'memory.private.purge'],
      ['show', 'forget', 'purge'].map((action) => ({ group: 'memory', subcommand: 'private', optionValues: { action, user } })),
      { group: 'memory', subcommand: 'private', optionValues: { action: 'show', user } },
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

  assert.deepEqual(admin.runCalls.map(([key, args]) => [key, args]), [['pings', { mode: 'off' }], ['pings', { mode: undefined }]]);
  assert.deepEqual(admin.runCalls[0][2], { guildId: 'g1', channelId: 'c1', userId: 'member1', roleIds: [] });
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

test('interaction handler: memory forget, memory wipe and memory private action:forget are deferred (they wait for the analyzer)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  for (const [group, subcommand, optionValues] of [
    ['memory', 'forget', { user: { id: 'target1' } }],
    ['memory', 'wipe', { confirm: 'The Server' }],
    ['memory', 'private', { action: 'forget', user: { id: 'target1' } }],
  ]) {
    const interaction = fakeInteraction({ group, subcommand, optionValues });
    await handler(interaction);
    assert.ok(interaction.replies.some((r) => r.deferred), `${group}.${subcommand}`);
    assert.equal(interaction.edits.length, 1, `${group}.${subcommand}`);
  }
});

test('interaction handler: media kind:gifs action:recache replies at once, its work goes on in the background', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const recache = fakeInteraction({ subcommand: 'media', optionValues: { kind: 'gifs', action: 'recache' } });
  await handler(recache);
  assert.equal(admin.runCalls[0][0], 'media');
  assert.deepEqual(admin.runCalls[0][1], { kind: 'gifs', action: 'recache' });
  assert.ok(!recache.replies.some((r) => r.deferred));

  await handler(fakeInteraction({ subcommand: 'media', optionValues: { kind: 'pictures', action: 'recache', days: 30 } }));
  assert.deepEqual(admin.runCalls[1][1], { kind: 'pictures', action: 'recache', days: 30 });
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

test('interaction handler: memory private action:purge defers, maps the user option to userId and edits the reply', async () => {
  const admin = fakeAdmin({ runImpl: () => 'purged' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ group: 'memory', subcommand: 'private', optionValues: { action: 'purge', user: { id: 'target1' } } });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'memory.private');
  assert.deepEqual(admin.runCalls[0][1], { action: 'purge', userId: 'target1' });
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

test('interaction handler: memory refresh picks its operation by kind and defers every one', async () => {
  const admin = fakeAdmin({ runImpl: () => 'refresh result' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  for (const [kind, optionValues, op] of [
    ['user', { kind: 'user', user: { id: 'target1' } }, 'memory.refresh.user'],
    ['channel', { kind: 'channel', channel: { id: 'chan1' } }, 'memory.refresh.channel'],
    ['server', { kind: 'server' }, 'memory.refresh.server'],
  ]) {
    const interaction = fakeInteraction({ group: 'memory', subcommand: 'refresh', optionValues });
    await handler(interaction);
    assert.equal(interaction.deferred, true, kind);
    assert.equal(interaction.edits[0].content, 'refresh result', kind);
    assert.equal(admin.operationFor('memory.refresh', admin.runCalls.at(-1)[1]), op, kind);
  }
  assert.deepEqual(admin.runCalls.map(([, args]) => args), [
    { kind: 'user', userId: 'target1', channelId: undefined },
    { kind: 'channel', userId: undefined, channelId: 'chan1' },
    { kind: 'server', userId: undefined, channelId: undefined },
  ]);
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
    ['memory', 'refresh', { kind: 'server' }],
    ['memory', 'snapshot', {}],
    ['diary', 'post', {}],
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
    assert.equal(retry.replies.length + retry.edits.length + retry.followUps.length, 0, `${key}: the retry answers nothing`);

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
    { group: 'diary', subcommand: 'post', optionValues: {} },
    { subcommand: 'draw', optionValues: { text: 'a lighthouse' } },
    { group: 'memory', subcommand: 'wipe', optionValues: { confirm: 'x' } },
  ]) {
    const interaction = fakeInteraction(call);
    await handler(interaction);
    assert.deepEqual(interaction.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } }, JSON.stringify(call));
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
  assert.ok(choices.some((c) => c.name === 'memory.refresh.user'), 'a write is offered by its name');
  assert.ok(!choices.some((c) => c.name === 'memory.affinity.set'), 'no operation sets the attitude');
  assert.ok(!choices.some((c) => c.name === 'memory.show'), 'never an old command key');
});

test('autocomplete: command-option choices never offer the owner-only private memory commands', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  // [owner-only group, a typed prefix of it]
  for (const [group, typed] of [['memory.private', 'priv'], ['memory.journal', 'jour'], ['memory.restore', 'rest']]) {
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

test('autocomplete: a non-owner granted config.set by role gets path choices, never command-key choices (access is owner-only)', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { 'config.set': { everyone: false, roles: ['staff'], users: [] }, 'access.grant': { everyone: false, roles: ['staff'], users: [] } } });
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

  // A channel: the picture is posted there as the persona.
  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat', channel: { id: 'chan1' } } }));
  assert.deepEqual(admin.runCalls[2][1], { text: 'a cat', self: false, channelId: 'chan1' });
});

test('interaction handler: draw defers ephemerally, then edits the reply with the text and the file', async () => {
  const attachment = Buffer.from('fake-png');
  const admin = fakeAdmin({ runImpl: () => ({ text: 'openai/x · 12.3s · cost 0.04', files: [{ attachment, name: 'image.png' }] }) });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat' } });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.deepEqual(interaction.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } }, 'ephemeral like every reply');
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
      llm: { providerByModel: { 'google/': { only: ['google-vertex'] }, 'google/@video': { only: ['google-ai-studio'] } } },
      models: { base: { voice: 'anthropic/claude-opus-4.6', analyzer: 'google/gemini-3.8-flash', extractor: 'anthropic/claude-opus-4.6', vision: 'google/gemini-3.8-flash', video: 'google/gemini-3.8-flash', embedding: 'openai/text-embedding-x' }, agents: { drawing: 'openai/gpt-image-x' } },
    },
  };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const all = fakeInteraction({ kind: 'autocomplete', group: 'route', subcommand: 'set', focused: { name: 'model', value: '' } });
  await handler(all);
  assert.deepEqual(all.respondCalls[0].map((c) => c.value), ['google/', 'anthropic/claude-opus-4.6', 'google/gemini-3.8-flash', 'openai/text-embedding-x', 'openai/gpt-image-x']);

  const typed = fakeInteraction({ kind: 'autocomplete', group: 'route', subcommand: 'remove', focused: { name: 'model', value: 'GOO' } });
  await handler(typed);
  assert.deepEqual(typed.respondCalls[0].map((c) => c.value), ['google/', 'google/gemini-3.8-flash']);
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
      models: { base: { voice: 'anthropic/claude-opus-4.6', vision: 'google/gemini-3.8-flash' } },
    },
  };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const model = fakeInteraction({ kind: 'autocomplete', group: 'model', subcommand: 'set', focused: { name: 'id', value: 'GEM' } });
  await handler(model);
  assert.deepEqual(model.respondCalls[0].map((c) => c.value), ['google/gemini-3.8-flash']);

  const restore = fakeInteraction({ kind: 'autocomplete', group: 'memory', subcommand: 'restore', focused: { name: 'id', value: 'EP' } });
  await handler(restore);
  assert.deepEqual(archiveCalls, [['g1', 'ep']]);
  assert.deepEqual(restore.respondCalls[0], [{ name: 'ep-2 (episode)', value: 'ep-2' }]);

  // lore show's `id` is no autocomplete: nothing offered.
  const lore = fakeInteraction({ kind: 'autocomplete', group: 'lore', subcommand: 'show', focused: { name: 'id', value: '' } });
  await handler(lore);
  assert.deepEqual(lore.respondCalls[0], []);

  // A member without the right gets nothing, the archive unread.
  const member = fakeInteraction({ kind: 'autocomplete', user: { id: 'helper1' }, group: 'memory', subcommand: 'restore', focused: { name: 'id', value: '' } });
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
// The command.requested event (packages/protocol/)
// ---------------------------------------------------------------------------

test('commandEvent: an interaction becomes a valid command.requested event', () => {
  const interaction = fakeInteraction({
    id: 'i-event',
    user: { id: 'helper1', globalName: 'Ελένη' },
    member: { displayName: 'Λένα', roles: { cache: new Map([['staff', {}], ['mods', {}]]) } },
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

test('interaction handler: the operation runs on the event\'s name, args and requester; the reply reaches the interaction', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { 'status.show': { everyone: false, roles: ['staff'], users: [] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1', now: () => 5000 });
  const interaction = fakeInteraction({ user: { id: 'helper1' }, member: { roles: ['staff'] }, channelId: 'c7', subcommand: 'status', optionValues: { field: 'limits' } });
  await handler(interaction);
  assert.deepEqual(admin.runCalls, [['status', { field: 'limits' }, { guildId: 'g1', channelId: 'c7', userId: 'helper1', roleIds: ['staff'] }]]);
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
  assert.deepEqual(warned.map((line) => [line.kind, line.reason]), [['command.requested', 'requester.id:type']]);
});
