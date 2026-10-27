// The owner's Discord surface: one top-level guild slash command (name from
// `config.bot.commandName`) whose tree is built here as plain JSON from one
// declarative table (COMMAND_TABLE, src/tools/impl/catalog.ts: the nineteen top-level
// entries, each leaf with its options and its option -> args mapping) — no
// discord.js builder classes — so `buildCommandTree` is trivially unit-tested.
// `registerCommands` pushes that tree to the single guild this instance
// serves; `createInteractionHandler` turns a discord.js interaction into an
// `admin.runCommand(commandKey, args, context)` call -- the command's
// operation run through src/tools/impl/index.ts#runOp, rights included -- and
// replies, never letting an error escape into discord.js. Every reply is
// ephemeral (what a command posts in the channel -- a message, a drawing, a
// diary entry -- is the persona's own post, not the reply); an operation that
// may outlast Discord's reply window is deferred first (DEFERRED_OPS); an
// interaction delivered twice runs once.
// One subcommand, `pings`, is a member's own notification switch, open to
// every member (its operations' `rights.member`); so is the `task` group, the
// persona's errands (src/tools/impl/task.ts rules who may ask what).
//
// Adding a command: see src/tools/impl/catalog.ts's header.

import { EmbedBuilder, MessageFlags } from 'discord.js';
import { COMMAND_REQUESTED, validateEvent } from '../../src/protocol/index.js';
import { DISCORD_IFACE } from './port.js';
import { displayNameOf } from './collect.js';
import { isOwnerId } from '../../src/tools/impl/grants.ts';
import {
  COMMAND_TABLE,
  DEFER_AFTER_MS,
  DEFERRED_OPS,
  ROUTE_ROLES,
  STATUS_FIELDS,
  commandSize,
  isValidCommandName,
  leafPaths,
} from '../../src/tools/impl/catalog.ts';
import { roleModel } from '../../src/llm/roles.js';
import { log } from '../../src/log.js';
import { MINUTE_MS } from '../../src/time.js';

// Raw Discord API option-type numbers (application-command-option-type):
// https://discord.com/developers/docs/interactions/application-commands
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

const REPLY_CHUNK_CHARS = 1900;
const MAX_AUTOCOMPLETE_CHOICES = 25;

/** How long an interaction id is remembered, so a retried delivery runs nothing. */
const RETRY_WINDOW_MS = 15 * MINUTE_MS;

const DISABLED_MESSAGE = 'Owner commands are disabled (features.adminCommands is off).';
const NOT_ALLOWED_MESSAGE = 'Not allowed';

/** Discord's cap on one application command's combined text (see `commandSize`). */
const COMMAND_SIZE_LIMIT = 8000;

/**
 * One table node as Discord JSON: `args` and `personaOptions` dropped, a group's leaves under `options`,
 * a leaf flagged `personaOnly` (a skill of hers with no slash command, which Discord's size limit has no
 * room for) left out.
 */
function nodeJson(node, type) {
  const { args: _args, personaOptions: _persona, personaOnly: _only, subcommands, options, ...rest } = node;
  if (subcommands)
    return {
      type: SUBCOMMAND_GROUP,
      ...rest,
      options: subcommands.filter((sub) => sub.personaOnly !== true).map((sub) => nodeJson(sub, SUBCOMMAND)),
    };
  return options ? { type, ...rest, options } : { type, ...rest };
}

/**
 * Every leaf's command key (`<group>.<name>` or a bare `<name>`) -> its `args` mapper.
 * @type {Map<string, (options: *) => object>}
 */
const OPTION_MAPPERS = new Map(
  COMMAND_TABLE.flatMap((node) =>
    node.subcommands ? node.subcommands.map((sub) => [`${node.name}.${sub.name}`, sub.args]) : [[node.name, node.args]]
  )
);

/** Discord's "Invalid Form Body … APPLICATION_COMMAND_TOO_LARGE" refusal (error 50035). */
function isCommandTooLarge(err) {
  if (err?.code !== 50035) return false;
  const raw = err.rawError ? JSON.stringify(err.rawError) : '';
  return /APPLICATION_COMMAND_TOO_LARGE/.test(`${err.message ?? ''} ${raw}`);
}

/**
 * The whole command tree as plain, JSON-serializable objects (the shape
 * `guild.commands.set([...])` expects), for one top-level command named
 * `commandName`, built from COMMAND_TABLE. Pure — no discord.js object, no
 * I/O. Always visible to every member (no `default_member_permissions`); an
 * ungranted member who runs it gets the not-allowed reply — all gating
 * happens at interaction time (`createInteractionHandler`,
 * `admin.runCommand`), never through Discord's own command visibility, so
 * re-registering never invalidates a client's cached command.
 */
export function buildCommandTree(commandName) {
  return [
    {
      name: commandName,
      description: 'Owner controls for the persona.',
      options: COMMAND_TABLE.map((node) => nodeJson(node, SUBCOMMAND)),
    },
  ];
}

/**
 * Every command key the interaction handler dispatches: every leaf
 * `<group>.<name>` (or bare top-level `<name>`) command key, and every
 * subcommand-group name — derived straight from the tree (src/tools/impl/index.ts#COMMAND_TO_OP
 * maps each key onto its operation; access is granted by operation, not by key).
 * Pure — no discord.js object, no I/O.
 * @returns {{ keys: Set<string>, groups: Set<string> }}
 */
export function commandKeys() {
  const [command] = buildCommandTree('nep');
  const keys = new Set();
  const groups = new Set();
  for (const option of command.options) {
    if (option.type === SUBCOMMAND_GROUP) {
      groups.add(option.name);
      for (const sub of option.options ?? []) keys.add(`${option.name}.${sub.name}`);
    } else if (option.type === SUBCOMMAND) {
      keys.add(option.name);
    }
  }
  return { keys, groups };
}

/**
 * Register (or clear) the guild command tree for `guild`. Never throws:
 * a registration failure (e.g. the bot was invited without the
 * `applications.commands` scope, Discord error 50001) is logged once, with
 * the re-invite URL — or, for a tree over Discord's size limit, with its size
 * and the limit — and the bot carries on with whatever tree Discord still has.
 * @param {import('discord.js').Guild} guild
 * @param {object} config  the live merged config (hot.config)
 * @returns {Promise<boolean>} true when a command tree was successfully set
 */
export async function registerCommands(guild, config) {
  if (config?.features?.adminCommands === false) {
    try {
      await guild.commands.set([]);
    } catch (err) {
      log.warn('commands: failed to clear guild commands', { error: err });
    }
    return false;
  }

  const commandName = config?.bot?.commandName ?? 'nep';
  if (!isValidCommandName(commandName)) {
    log.error('commands: invalid bot.commandName, not registering', { commandName });
    return false;
  }

  const tree = buildCommandTree(commandName);
  try {
    await guild.commands.set(tree);
    log.info('commands: registered');
    return true;
  } catch (err) {
    if (isCommandTooLarge(err)) {
      log.error('commands: registration failed', {
        reason: 'too-large',
        size: commandSize(tree[0]),
        limit: COMMAND_SIZE_LIMIT,
        error: err,
      });
      return false;
    }
    // Anything else is read as the missing `applications.commands` scope:
    // `inviteUrl` re-invites the bot with it.
    const appId = guild.client?.application?.id ?? guild.client?.user?.id ?? 'YOUR_APPLICATION_ID';
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands`;
    log.error('commands: registration failed', { reason: 'scope', inviteUrl, error: err });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Interaction handling
// ---------------------------------------------------------------------------

function chunkText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** The `<group>.<name>` (or plain `<name>`) command key for a chat-input interaction. */
function commandKeyFor(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);
  if (!sub) return null;
  return group ? `${group}.${sub}` : sub;
}

/** @param {string} commandKey */
function buildArgs(commandKey, interaction) {
  const mapper = OPTION_MAPPERS.get(commandKey);
  return mapper ? mapper(interaction.options) : {};
}

/**
 * Reply with an admin handler's result: a string (chunked into follow-ups when
 * long, code-fenced when multi-line), `{ text, files: [{ attachment: Buffer,
 * name }] }`, whose files ride on the first message, or `{ text, embeds }`
 * (the status card: plain embed data, wrapped in EmbedBuilder here), the
 * embeds first and the text below them as follow-ups. Always ephemeral; a
 * `deferred` reply edits the deferred (ephemeral) one.
 */
async function respond(interaction, result, { deferred = false } = {}) {
  const isObject = result !== null && typeof result === 'object';
  const body = String((isObject ? result.text : result) ?? '');
  const files = isObject && Array.isArray(result.files) && result.files.length > 0 ? result.files : null;
  const embeds =
    isObject && Array.isArray(result.embeds) && result.embeds.length > 0
      ? result.embeds.map((data) => new EmbedBuilder(data))
      : null;
  const wrap = body.includes('\n');
  const format = (chunk) => (wrap ? `\`\`\`\n${chunk}\n\`\`\`` : chunk);
  const flags = { flags: MessageFlags.Ephemeral };
  const chunks = body ? chunkText(body, REPLY_CHUNK_CHARS) : [];

  let first;
  let rest;
  if (embeds) {
    first = files ? { embeds, files } : { embeds };
    rest = chunks;
  } else {
    first = files ? { content: format(chunks[0] ?? ''), files } : { content: format(chunks[0] ?? '') };
    rest = chunks.slice(1);
  }

  if (deferred) {
    await interaction.editReply(first);
  } else {
    await interaction.reply({ ...first, ...flags });
  }
  for (const chunk of rest) {
    await interaction.followUp({ content: format(chunk), ...flags });
  }
}

/** The interacting member's role ids as strings — discord.js gives a `GuildMemberRoleManager`
 * (`.roles.cache`, a Collection keyed by id) on a live interaction; tests fake it either that way
 * or as a plain array of ids. Neither shape present -> no roles. */
function roleIdsFor(interaction) {
  const roles = interaction.member?.roles;
  if (roles && typeof roles.cache?.keys === 'function') return [...roles.cache.keys()].map(String);
  if (Array.isArray(roles)) return roles.map(String);
  return [];
}

/**
 * The `command.requested` event of a chat-input interaction (src/protocol/events.js): the
 * command key as its `name`, the mapped options as `args`, the requester with their role ids and
 * whether `config.bot.owners` names them (informational: the operation's own runOp still checks
 * the rights), and `replyRef`, the opaque token the handler maps back to the interaction. Ids are
 * kept as Discord gives them, so the context built from the event is the one built before.
 * @param {object} interaction  A discord.js ChatInputCommandInteraction.
 * @param {string} commandKey
 * @param {object} args
 * @param {object} config  The live config.
 * @param {string} replyRef
 * @param {number} at
 * @returns {import('../../src/protocol/index.js').CommandRequested}
 */
export function commandEvent(interaction, commandKey, args, config, replyRef, at) {
  const userId = interaction.user?.id;
  return {
    kind: COMMAND_REQUESTED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:command:${interaction.id ?? replyRef}`,
    conversation: {
      id: interaction.channelId,
      kind: interaction.guildId ? (interaction.channel?.isThread?.() ? 'thread' : 'channel') : 'dm',
      communityId: interaction.guildId ?? null,
      name: interaction.channel?.name ?? null,
    },
    name: commandKey,
    args,
    requester: {
      id: userId,
      name: displayNameOf(interaction.member, interaction.user),
      roles: roleIdsFor(interaction),
      owner: isOwnerId(config, userId),
    },
    replyRef,
  };
}

/** `command`-option autocomplete choices for `/nep access grant|revoke`: `*`, the groups and
 * every grantable operation name (`admin.accessKeys`, src/tools/impl/access.ts#grantKeys), filtered by the
 * typed text. Owner-only operations are never offered: no grant can open them; nor are the member
 * operations, open without one. */
function accessKeyChoices(admin, typed) {
  return admin
    .accessKeys()
    .filter((key) => key.toLowerCase().includes(typed))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((key) => ({ name: key, value: key }));
}

/** `model`-option autocomplete choices for `/nep route set|remove`: the model prefixes of the
 * routes in `llm.providerByModel` (the part before `@`), then the model ids the routed roles
 * (`ROUTE_ROLES`) are configured with, each once, filtered by the typed text. */
function routeModelChoices(config, typed) {
  const byModel = config?.llm?.providerByModel;
  const prefixes =
    byModel && typeof byModel === 'object' && !Array.isArray(byModel)
      ? Object.keys(byModel).map((key) => (key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key))
      : [];
  const models = ROUTE_ROLES.map((role) => roleModel(config, role));
  const all = [...new Set([...prefixes, ...models].filter((value) => typeof value === 'string' && value))];
  return all
    .filter((value) => value.toLowerCase().includes(typed))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((value) => ({ name: value, value }));
}

/**
 * `hot`, `admin` — see src/hot.js, src/admin.js#createAdmin.
 * `getGuildId` — the single guild this instance serves, or null before it resolves.
 * `now` — the clock of the retry window (epoch ms), injected for the tests.
 * @returns {(interaction: import('discord.js').Interaction) => Promise<void>}
 */
export function createInteractionHandler({ hot, admin, getGuildId, now = Date.now, deferAfterMs = DEFER_AFTER_MS }) {
  // Interaction ids seen in the last RETRY_WINDOW_MS, oldest first: Discord may deliver one
  // interaction twice, and the second delivery must not run its operation again.
  const seen = new Map();
  // The interactions of the commands in flight by their `replyRef` (commandEvent): the token
  // the core answers by, mapped back to the interaction here, the Discord side.
  const replies = new Map();
  let nextReply = 0;

  /** True the first time `id` arrives within the window; an interaction with no id always runs. */
  function firstDelivery(id) {
    if (id === undefined || id === null) return true;
    const at = now();
    for (const [key, seenAt] of seen) {
      if (at - seenAt < RETRY_WINDOW_MS) break;
      seen.delete(key);
    }
    const key = String(id);
    if (seen.has(key)) return false;
    seen.set(key, at);
    return true;
  }

  async function handleAutocomplete(interaction) {
    if (interaction.guildId !== getGuildId()) return;
    const config = hot.config;
    if (config?.features?.adminCommands === false) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const commandKey = commandKeyFor(interaction);
    const context = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      roleIds: roleIdsFor(interaction),
    };
    const allowed = admin.isAllowed(commandKey, context);
    if (!allowed) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const focused = interaction.options.getFocused(true);
    const typed = String(focused.value ?? '').toLowerCase();

    if (focused.name === 'path') {
      const choices = leafPaths(config)
        .filter((p) => p.toLowerCase().includes(typed))
        .slice(0, MAX_AUTOCOMPLETE_CHOICES)
        .map((p) => ({ name: p, value: p }));
      await interaction.respond(choices).catch(() => {});
      return;
    }

    // `/nep status field:` offers the card's field names (too many to list as fixed choices within Discord's size limit).
    if (commandKey === 'status' && focused.name === 'field') {
      const choices = STATUS_FIELDS.filter((name) => name.includes(typed)).map((name) => ({ name, value: name }));
      await interaction.respond(choices).catch(() => {});
      return;
    }

    if (focused.name === 'command') {
      await interaction.respond(accessKeyChoices(admin, typed)).catch(() => {});
      return;
    }

    // `/nep route set|remove model:` and `/nep model set id:` offer the same model ids.
    if (focused.name === 'model' || (commandKey === 'model.set' && focused.name === 'id')) {
      await interaction.respond(routeModelChoices(config, typed)).catch(() => {});
      return;
    }

    if (commandKey === 'memory.restore' && focused.name === 'id') {
      const choices =
        typeof admin.archiveChoices === 'function' ? await admin.archiveChoices(context, typed).catch(() => []) : [];
      await interaction.respond(choices.slice(0, MAX_AUTOCOMPLETE_CHOICES)).catch(() => {});
      return;
    }

    await interaction.respond([]).catch(() => {});
  }

  async function handleChatInput(interaction) {
    if (interaction.guildId !== getGuildId()) return;
    const config = hot.config;

    if (config?.features?.adminCommands === false) {
      await interaction.reply({ content: DISABLED_MESSAGE, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    const commandKey = commandKeyFor(interaction);
    if (!commandKey) {
      await interaction
        .reply({ content: 'Error: no subcommand given.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }

    if (!firstDelivery(interaction.id)) {
      log.warn('commands: duplicate interaction', { command: commandKey });
      return;
    }

    let mode = { deferred: false };
    nextReply += 1;
    const replyRef = `command-${nextReply}`;
    replies.set(replyRef, interaction);
    try {
      // The command reaches the operations as a protocol event; a malformed one is dropped at
      // this boundary with one warn line, like any inbound event (src/index.js).
      const event = commandEvent(interaction, commandKey, buildArgs(commandKey, interaction), config, replyRef, now());
      const verdict = validateEvent(event);
      if (!verdict.ok) {
        log.warn('interface: invalid event', { kind: event.kind, reason: verdict.reason });
        return;
      }
      const { name, args, requester, conversation } = event;
      const op = typeof admin.operationFor === 'function' ? admin.operationFor(name, args) : null;
      mode = { deferred: op !== null && DEFERRED_OPS.has(op) };
      if (mode.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const context = {
        guildId: conversation.communityId,
        channelId: conversation.id,
        userId: requester.id,
        roleIds: requester.roles,
      };
      // The rights are checked by the operation's own runOp (src/tools/impl/index.ts), every time.
      const run = admin.runCommand(name, args, context);
      let result;
      if (mode.deferred) result = await run;
      else {
        const late = Symbol('late');
        let timer;
        try {
          const first = await Promise.race([
            run,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(late), deferAfterMs);
            }),
          ]);
          if (first === late) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            mode = { deferred: true };
            result = await run;
          } else result = first;
        } finally {
          clearTimeout(timer);
        }
      }
      // TODO(.agents spec 2026-10-17-protocol-package, "Code"): the answer goes out as a
      // `command.result` action ({ replyRef, text, files, ephemeral }) the adapter translates. It
      // stays a direct reply here: the status card's embeds and the deferral this handler decides
      // mid-run (DEFERRED_OPS, deferAfterMs) have no place in that action yet.
      const target = replies.get(replyRef);
      if (result.status === 'ok') {
        await respond(target, result.data?.files || result.data?.embeds ? result.data : result.summary, mode);
      } else if (result.status === 'denied') {
        await respond(target, NOT_ALLOWED_MESSAGE, mode);
      } else {
        log.warn('commands: command failed', {
          command: commandKey,
          status: result.status,
          code: result.code,
          error: new Error(result.summary),
        });
        await respond(target, `Error: ${result.summary}`, mode).catch(() => {});
      }
    } catch (err) {
      log.warn('commands: command failed', { command: commandKey, error: err });
      await respond(interaction, `Error: ${err?.message ?? String(err)}`, mode).catch(() => {});
    } finally {
      replies.delete(replyRef);
    }
  }

  return async function handleInteraction(interaction) {
    try {
      if (interaction.isAutocomplete?.()) {
        await handleAutocomplete(interaction);
        return;
      }
      if (interaction.isChatInputCommand?.()) {
        await handleChatInput(interaction);
      }
    } catch (err) {
      log.error('commands: interaction handler failed', { error: err });
    }
  };
}
