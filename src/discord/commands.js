// The owner's Discord surface: one top-level guild slash command (name from
// `config.bot.commandName`) whose tree is built here as plain JSON from one
// declarative table (COMMAND_TABLE: the nineteen top-level entries, each leaf
// with its options and its option -> args mapping) — no discord.js builder
// classes — so `buildCommandTree` is trivially unit-tested.
// `registerCommands` pushes that tree to the single guild this instance
// serves; `createInteractionHandler` turns a discord.js interaction into an
// `admin.runCommand(commandKey, args, context)` call -- the command's
// operation run through src/ops/index.js#runOp, rights included -- and
// replies, never letting an error escape into discord.js. Every reply is
// ephemeral (what a command posts in the channel -- a message, a drawing, a
// diary entry -- is the persona's own post, not the reply); an operation that
// may outlast Discord's reply window is deferred first (DEFERRED_OPS); an
// interaction delivered twice runs once.
// One subcommand, `pings`, is a member's own notification switch, open to
// every member (its operations' `rights.member`).
//
// Adding a command here means one COMMAND_TABLE entry (its options and its
// `args` mapper) and one src/ops/index.js#COMMAND_TO_OP entry, plus a
// DEFERRED_OPS entry when its operation may outlast the reply window.

import { EmbedBuilder, MessageFlags } from 'discord.js';
import { isPlainObject } from '../config.js';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import { skillNames } from '../skills/registry.js';
import { MINUTE_MS } from '../time.js';

// Raw Discord API option-type numbers (application-command-option-type):
// https://discord.com/developers/docs/interactions/application-commands
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;
const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;
const USER = 6;
const CHANNEL = 7;
const ROLE = 8;

// application-command-types#channel-type: GUILD_TEXT
const GUILD_TEXT = 0;

const REPLY_CHUNK_CHARS = 1900;
const MAX_AUTOCOMPLETE_CHOICES = 25;

/** How long an interaction id is remembered, so a retried delivery runs nothing. */
const RETRY_WINDOW_MS = 15 * MINUTE_MS;

/** Operations that may take long enough to need `deferReply` before `editReply`. */
export const DEFERRED_OPS = Object.freeze(new Set([
  'talk.interject',
  'talk.initiate',
  'bot.pause',
  'bot.resume',
  'memory.refresh.user',
  'memory.refresh.channel',
  'memory.refresh.server',
  'memory.forget',
  'memory.wipe',
  'memory.archive.read',
  'memory.restore',
  'memory.snapshot',
  'memory.private.forget',
  'memory.private.purge',
  'media.rescan',
  'diary.set',
  'diary.post',
  'draw.create',
]));

/**
 * The model roles (src/llm/roles.js), each with the config path of its model (src/ops/model.js):
 * the roles the status card probes, plus `drawing` (`MODEL_SET_PATHS`); every role choice list
 * is derived from this one. `voice` is the one model that speaks as the persona: its replies and
 * every memory text worded in its voice (src/memory/update.js#runVoice). `embedding` serves the
 * embeddings (src/llm/embed.js), which take no chat completion.
 */
export const MODEL_ROLE_PATHS = Object.freeze({
  voice: 'roles.voice',
  analyzer: 'roles.analyzer',
  reasoner: 'roles.reasoner',
  extractor: 'roles.extractor',
  vision: 'roles.vision',
  video: 'roles.video',
  embedding: 'roles.embedding',
});

/** The roles of `MODEL_ROLE_PATHS`, in order. */
export const MODEL_ROLES = Object.freeze(Object.keys(MODEL_ROLE_PATHS));

/**
 * The roles whose model `/nep model show|set` lists and changes, each with the config path
 * `set` writes: the chat and embedding roles, then the drawing model (`drawing`,
 * src/llm/images.js#IMAGE_ROLE), which takes no chat completion.
 */
export const MODEL_SET_PATHS = Object.freeze({ ...MODEL_ROLE_PATHS, drawing: 'roles.drawing' });

/** The roles of `MODEL_SET_PATHS`, in order: the choices of `/nep model set` and `/nep route`. */
export const MODEL_SET_ROLES = Object.freeze(Object.keys(MODEL_SET_PATHS));

/** The `section` choices of `/nep memory show`, in display order (src/admin.js falls back to `summary`). */
export const MEMORY_SHOW_SECTIONS = Object.freeze([
  'summary',
  'character',
  'style',
  'relationship',
  'affinity',
  'aliases',
  'interests',
  'details',
  'episodes',
  'raw',
]);

/** `{ name, value }` choices, one per entry of `values`, the name being the value itself. */
function choicesOf(values) {
  return values.map((value) => ({ name: value, value }));
}

const ROUTE_ROLES = MODEL_SET_ROLES;

/** `/nep memory journal`'s `kind` choices (src/admin.js reads the same list; `all` reads every kind). */
export const JOURNAL_KINDS = Object.freeze(['turn', 'action', 'memory', 'system', 'answer', 'all']);

/** `/nep memory refresh`'s `kind` choices (src/ops/index.js#COMMAND_TO_OP picks the operation by it). */
export const MEMORY_REFRESH_KINDS = Object.freeze(['user', 'channel', 'server']);

/** `/nep pings`'s `mode` choices (src/admin.js#cmdPings reads the same list). */
export const PINGS_MODES = Object.freeze(['on', 'off']);

const DISABLED_MESSAGE = 'Owner commands are disabled (features.adminCommands is off).';
const NOT_ALLOWED_MESSAGE = 'Not allowed';

/** Discord's cap on one application command's combined text (see `commandSize`). */
const COMMAND_SIZE_LIMIT = 8000;

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const channelOption = (description, required = false) => ({ type: CHANNEL, name: 'channel', description, required, channel_types: [GUILD_TEXT] });
const userOption = (description = 'Member.', required = true) => ({ type: USER, name: 'user', description, required });
const userId = (options) => options.getUser('user', true).id;
const none = () => ({});

/**
 * The whole `/nep` tree, top level in display order: a leaf is `{ name, description, options?,
 * args }`, a group is `{ name, description, subcommands: [leaf, ...] }`. `args(options)` maps a
 * discord.js interaction's options onto the plain `args` of src/admin.js#runCommand; the rest is
 * the Discord JSON of the node (`buildCommandTree` drops `args`). Option names are lowercase;
 * no name carries a hyphen; `action` only where every action takes the same options.
 */
export const COMMAND_TABLE = Object.freeze([
  {
    name: 'status',
    description: 'What the bot is doing now: one card.',
    options: [{ type: BOOLEAN, name: 'detail', description: 'Add the long form below the card.', required: false }],
    args: (options) => ({ detail: options.getBoolean('detail') ?? false }),
  },
  {
    name: 'set',
    description: 'Override a config value in config.local.json.',
    options: [
      { type: STRING, name: 'path', description: 'Dotted config path.', required: true, autocomplete: true },
      { type: STRING, name: 'value', description: 'New value: JSON or a plain string.', required: true },
    ],
    args: (options) => ({ path: options.getString('path', true), value: options.getString('value', true) }),
  },
  {
    name: 'unset',
    description: 'Remove a config override.',
    options: [{ type: STRING, name: 'path', description: 'Dotted config path.', required: true, autocomplete: true }],
    args: (options) => ({ path: options.getString('path', true) }),
  },
  { name: 'pause', description: 'Pause the persona and flush memory so data/ can be hand-edited.', args: none },
  { name: 'resume', description: 'Resume after a pause; refused if a data/ file is invalid.', args: none },
  {
    name: 'draw',
    description: 'Draw one picture in this channel. Spends balance.',
    options: [
      { type: STRING, name: 'text', description: 'What to draw.', required: true },
      { type: BOOLEAN, name: 'self', description: 'The persona is in it (adds the appearance prompt).', required: false },
    ],
    args: (options) => ({ text: options.getString('text', true), self: options.getBoolean('self') ?? false }),
  },
  {
    name: 'pings',
    description: "Choose whether the bot's messages notify you.",
    options: [{ type: STRING, name: 'mode', description: 'on or off; leave empty to see your current setting.', required: false, choices: choicesOf(PINGS_MODES) }],
    args: (options) => ({ mode: options.getString('mode') ?? undefined }),
  },
  {
    name: 'talk',
    description: 'Make the persona speak now.',
    options: [
      { type: STRING, name: 'action', description: 'interject joins the conversation, initiate starts a topic.', required: true, choices: choicesOf(['interject', 'initiate']) },
      channelOption('Channel (default: this one).'),
    ],
    args: (options) => ({ action: options.getString('action', true), channelId: options.getChannel('channel')?.id }),
  },
  {
    name: 'media',
    description: 'The custom emoji ranking and the GIF library.',
    options: [
      { type: STRING, name: 'kind', description: 'emoji or gifs.', required: true, choices: choicesOf(['emoji', 'gifs']) },
      { type: STRING, name: 'action', description: 'status; rescan recounts from history; recache re-describes GIFs.', required: true, choices: choicesOf(['status', 'rescan', 'recache']) },
    ],
    args: (options) => ({ kind: options.getString('kind', true), action: options.getString('action', true) }),
  },
  {
    name: 'model',
    description: 'Which model serves each role.',
    subcommands: [
      { name: 'show', description: 'Show the model of each role.', args: none },
      {
        name: 'set',
        description: 'Set the model for one role.',
        options: [
          { type: STRING, name: 'role', description: 'Role to change.', required: true, choices: choicesOf(MODEL_SET_ROLES) },
          { type: STRING, name: 'id', description: 'OpenRouter model id.', required: true, autocomplete: true },
        ],
        args: (options) => ({ role: options.getString('role', true), id: options.getString('id', true) }),
      },
    ],
  },
  {
    name: 'route',
    description: 'Providers per model and role (llm.providerByModel).',
    subcommands: [
      { name: 'list', description: "Every route, then each role's current model and route.", args: none },
      {
        name: 'set',
        description: 'Route a model prefix, for one role or any, to these providers only.',
        options: [
          { type: STRING, name: 'model', description: 'Model id or prefix, e.g. google/ (no @ or spaces).', required: true, autocomplete: true },
          { type: STRING, name: 'providers', description: 'Comma-separated provider slugs, e.g. google-vertex.', required: true },
          { type: STRING, name: 'role', description: 'Only for this role (default: any).', required: false, choices: choicesOf(ROUTE_ROLES) },
          { type: BOOLEAN, name: 'fallbacks', description: 'Allow other providers if these fail (default: false).', required: false },
        ],
        args: (options) => ({
          model: options.getString('model', true),
          providers: options.getString('providers', true),
          role: options.getString('role') ?? undefined,
          fallbacks: options.getBoolean('fallbacks') ?? undefined,
        }),
      },
      {
        name: 'remove',
        description: "Remove a model prefix's route, for one role or any.",
        options: [
          { type: STRING, name: 'model', description: 'Model id or prefix of the route.', required: true, autocomplete: true },
          { type: STRING, name: 'role', description: "The route's role (default: any).", required: false, choices: choicesOf(ROUTE_ROLES) },
        ],
        args: (options) => ({ model: options.getString('model', true), role: options.getString('role') ?? undefined }),
      },
    ],
  },
  {
    name: 'rule',
    description: 'Live corrections in prompts.local/rules.md.',
    subcommands: [
      {
        name: 'add',
        description: 'Append a rule.',
        options: [{ type: STRING, name: 'text', description: 'Rule text.', required: true }],
        args: (options) => ({ text: options.getString('text', true) }),
      },
      { name: 'list', description: 'List the rules, numbered.', args: none },
      {
        name: 'remove',
        description: 'Remove a rule by number.',
        options: [{ type: INTEGER, name: 'number', description: 'Rule number.', required: true, min_value: 1 }],
        args: (options) => ({ number: options.getInteger('number', true) }),
      },
    ],
  },
  {
    name: 'access',
    description: 'Who besides owners may run which operations.',
    subcommands: [
      {
        name: 'grant',
        description: 'Open an operation, group or * to everyone, a role or a user.',
        options: [
          { type: STRING, name: 'command', description: 'Operation name, group, or *.', required: true, autocomplete: true },
          { type: ROLE, name: 'role', description: 'Role (omit both for everyone).', required: false },
          { type: USER, name: 'user', description: 'User (omit both for everyone).', required: false },
        ],
        args: (options) => ({ command: options.getString('command', true), roleId: options.getRole('role')?.id, userId: options.getUser('user')?.id }),
      },
      {
        name: 'revoke',
        description: 'Revoke an operation, group or * from everyone, a role or a user.',
        options: [
          { type: STRING, name: 'command', description: 'Operation name, group, or *.', required: true, autocomplete: true },
          { type: ROLE, name: 'role', description: 'Role (omit both to clear everyone).', required: false },
          { type: USER, name: 'user', description: 'User (omit both to clear everyone).', required: false },
        ],
        args: (options) => ({ command: options.getString('command', true), roleId: options.getRole('role')?.id, userId: options.getUser('user')?.id }),
      },
      { name: 'list', description: 'List every access grant.', args: none },
    ],
  },
  {
    name: 'skill',
    description: "Open or close the persona's own skills.",
    subcommands: [
      {
        name: 'allow',
        description: 'Allow the persona one skill.',
        options: [{ type: STRING, name: 'name', description: 'Skill name.', required: true, autocomplete: true }],
        args: (options) => ({ name: options.getString('name', true) }),
      },
      {
        name: 'deny',
        description: 'Take one skill back from the persona.',
        options: [{ type: STRING, name: 'name', description: 'Skill name.', required: true, autocomplete: true }],
        args: (options) => ({ name: options.getString('name', true) }),
      },
      { name: 'list', description: 'Every skill, allowed or not, and why.', args: none },
    ],
  },
  {
    name: 'diary',
    description: 'The diary.',
    subcommands: [
      {
        name: 'set',
        description: 'Set the diary channel.',
        options: [channelOption('Channel.', true)],
        args: (options) => ({ channelId: options.getChannel('channel', true).id }),
      },
      { name: 'show', description: 'Diary state today.', args: none },
      { name: 'off', description: 'Stop the diary.', args: none },
      {
        name: 'post',
        description: 'Post one entry now.',
        options: [
          { type: STRING, name: 'kind', description: 'Kind.', required: false },
          { type: STRING, name: 'topic', description: 'Topic.', required: false, max_length: 1000 },
        ],
        args: (options) => {
          const topic = options.getString('topic');
          return { kind: options.getString('kind') ?? undefined, ...(topic != null ? { topic } : {}) };
        },
      },
    ],
  },
  {
    name: 'alias',
    description: 'Nicknames others in chat call a member.',
    subcommands: [
      {
        name: 'add',
        description: "Add or strengthen a member's alias.",
        options: [userOption(), { type: STRING, name: 'name', description: 'The alias.', required: true }],
        args: (options) => ({ userId: userId(options), name: options.getString('name', true) }),
      },
      {
        name: 'remove',
        description: "Remove a member's alias.",
        options: [userOption(), { type: STRING, name: 'name', description: 'The alias.', required: true }],
        args: (options) => ({ userId: userId(options), name: options.getString('name', true) }),
      },
    ],
  },
  {
    name: 'learning',
    description: 'What people taught the persona here.',
    subcommands: [
      {
        name: 'add',
        description: 'Add or strengthen a learned item.',
        options: [{ type: STRING, name: 'text', description: 'What the persona should know.', required: true }],
        args: (options) => ({ text: options.getString('text', true) }),
      },
      {
        name: 'remove',
        description: 'Delete a learned item.',
        options: [{ type: INTEGER, name: 'number', description: 'Item number.', required: true, min_value: 1 }],
        args: (options) => ({ id: options.getInteger('number', true) }),
      },
    ],
  },
  {
    name: 'lore',
    description: 'Lorebook: events, recurring characters, running jokes.',
    subcommands: [
      {
        name: 'add',
        description: 'Add or overwrite an entry (it becomes an owner entry).',
        options: [
          { type: STRING, name: 'title', description: 'Entry title (its identity).', required: true },
          { type: STRING, name: 'keys', description: 'Comma-separated keys/phrases people type.', required: true },
          { type: STRING, name: 'text', description: 'Entry text, up to lore.textChars.', required: true },
          { type: BOOLEAN, name: 'always', description: 'Show it even without a match.', required: false },
        ],
        args: (options) => ({
          title: options.getString('title', true),
          keys: options.getString('keys', true),
          text: options.getString('text', true),
          always: options.getBoolean('always') ?? false,
        }),
      },
      {
        name: 'list',
        description: 'List entries, optionally filtered.',
        options: [{ type: STRING, name: 'query', description: 'Substring of the title or keys.', required: false }],
        args: (options) => ({ query: options.getString('query') ?? undefined }),
      },
      {
        name: 'show',
        description: 'Show one entry in full.',
        options: [{ type: STRING, name: 'id', description: 'Entry id.', required: true }],
        args: (options) => ({ id: options.getString('id', true) }),
      },
      {
        name: 'remove',
        description: 'Delete one entry.',
        options: [{ type: STRING, name: 'id', description: 'Entry id.', required: true }],
        args: (options) => ({ id: options.getString('id', true) }),
      },
    ],
  },
  {
    name: 'memory',
    description: 'Inspect or edit stored memory.',
    subcommands: [
      {
        name: 'show',
        description: "Show a member's stored profile.",
        options: [
          userOption(),
          { type: STRING, name: 'section', description: 'Profile part (default: summary).', required: false, choices: choicesOf(MEMORY_SHOW_SECTIONS) },
          { type: INTEGER, name: 'limit', description: 'Max items for a list section (default 25).', required: false, min_value: 1, max_value: 100 },
          { type: STRING, name: 'order', description: 'Order for a list section (default: rank).', required: false, choices: choicesOf(['rank', 'recent']) },
        ],
        args: (options) => ({
          userId: userId(options),
          section: options.getString('section') ?? undefined,
          limit: options.getInteger('limit') ?? undefined,
          order: options.getString('order') ?? undefined,
        }),
      },
      {
        name: 'channel',
        description: "Show a channel's note, or a table of all stored channels.",
        options: [channelOption('Channel to show (omit for the table).')],
        args: (options) => ({ channelId: options.getChannel('channel')?.id }),
      },
      { name: 'server', description: 'Show server notes: patterns, starters, in-jokes, self facts.', args: none },
      { name: 'recent', description: 'Show the live recent lines, newest first.', args: none },
      {
        name: 'refresh',
        description: "Rewrite a member's portrait, or a channel's or the server notes from a fresh sample.",
        options: [
          { type: STRING, name: 'kind', description: 'user, channel or server.', required: true, choices: choicesOf(MEMORY_REFRESH_KINDS) },
          userOption('Member (kind user).', false),
          channelOption('Channel (kind channel).'),
        ],
        args: (options) => ({ kind: options.getString('kind', true), userId: options.getUser('user')?.id, channelId: options.getChannel('channel')?.id }),
      },
      {
        name: 'forget',
        description: "Delete a member's profile and private memory.",
        options: [userOption()],
        args: (options) => ({ userId: userId(options) }),
      },
      {
        name: 'affinity',
        description: "Show or set a member's attitude score.",
        options: [
          userOption(),
          { type: INTEGER, name: 'score', description: 'New score; omit to only show it.', required: false, min_value: -100, max_value: 100 },
          { type: STRING, name: 'reason', description: 'Why (only with score).', required: false },
        ],
        args: (options) => ({ userId: userId(options), score: options.getInteger('score') ?? undefined, reason: options.getString('reason') ?? undefined }),
      },
      {
        name: 'wipe',
        description: 'Delete ALL server memory (profiles, private memory, habits, channels, lore).',
        options: [{ type: STRING, name: 'confirm', description: "Type this server's exact name to confirm.", required: true }],
        args: (options) => ({ confirm: options.getString('confirm', true) }),
      },
      {
        name: 'journal',
        description: 'Journal records.',
        options: [
          { type: STRING, name: 'day', description: 'UTC day (default: today).', required: false },
          { type: STRING, name: 'kind', description: 'Kind (default: all).', required: false, choices: choicesOf(JOURNAL_KINDS) },
          { type: INTEGER, name: 'n', description: 'How many (default 20).', required: false, min_value: 1, max_value: 50 },
        ],
        args: (options) => ({ day: options.getString('day') ?? undefined, kind: options.getString('kind') ?? undefined, n: options.getInteger('n') ?? undefined }),
      },
      {
        name: 'archive',
        description: 'Archived items.',
        options: [
          userOption('Member; omit for the server.', false),
          { type: STRING, name: 'kind', description: 'Kind.', required: false },
          { type: INTEGER, name: 'n', description: 'How many (default 20).', required: false, min_value: 1, max_value: 100 },
        ],
        args: (options) => ({ userId: options.getUser('user')?.id, kind: options.getString('kind') ?? undefined, n: options.getInteger('n') ?? undefined }),
      },
      {
        name: 'restore',
        description: 'Restore an archived item.',
        options: [{ type: STRING, name: 'id', description: 'Archived item id.', required: true, autocomplete: true }],
        args: (options) => ({ itemId: options.getString('id', true) }),
      },
      { name: 'snapshot', description: 'Snapshot data/ for the tools.', args: none },
      {
        name: 'private',
        description: "A member's private memory: what they said in DMs.",
        options: [
          { type: STRING, name: 'action', description: 'show; forget deletes it; purge deletes the DMs too.', required: true, choices: choicesOf(['show', 'forget', 'purge']) },
          userOption(),
        ],
        args: (options) => ({ action: options.getString('action', true), userId: userId(options) }),
      },
    ],
  },
]);

/** One table node as Discord JSON: `args` dropped, a group's leaves under `options`. */
function nodeJson(node, type) {
  const { args: _args, subcommands, options, ...rest } = node;
  if (subcommands) return { type: SUBCOMMAND_GROUP, ...rest, options: subcommands.map((sub) => nodeJson(sub, SUBCOMMAND)) };
  return options ? { type, ...rest, options } : { type, ...rest };
}

/** Every leaf's command key (`<group>.<name>` or a bare `<name>`) -> its `args` mapper. */
const OPTION_MAPPERS = new Map(
  COMMAND_TABLE.flatMap((node) =>
    node.subcommands ? node.subcommands.map((sub) => [`${node.name}.${sub.name}`, sub.args]) : [[node.name, node.args]],
  ),
);

/**
 * The size Discord checks against its 8000-character limit for one
 * application command: the length of every `name` and `description`, of the
 * command and every group, subcommand and option below it, plus every choice's
 * `name` and `value` (a number counted by its decimal form). Pure.
 * @param {object} command  one entry of `buildCommandTree`
 * @returns {number}
 */
export function commandSize(command) {
  const text = (value) => (value === undefined || value === null ? 0 : String(value).length);
  let size = text(command?.name) + text(command?.description);
  for (const choice of command?.choices ?? []) size += text(choice.name) + text(choice.value);
  for (const option of command?.options ?? []) size += commandSize(option);
  return size;
}

/** Discord's "Invalid Form Body … APPLICATION_COMMAND_TOO_LARGE" refusal (error 50035). */
function isCommandTooLarge(err) {
  if (err?.code !== 50035) return false;
  const raw = err.rawError ? JSON.stringify(err.rawError) : '';
  return /APPLICATION_COMMAND_TOO_LARGE/.test(`${err.message ?? ''} ${raw}`);
}

/** `^[a-z0-9_-]{1,32}$` — Discord's rule for a command name. */
export function isValidCommandName(name) {
  return typeof name === 'string' && /^[a-z0-9_-]{1,32}$/.test(name);
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
 * subcommand-group name — derived straight from the tree (src/ops/index.js#COMMAND_TO_OP
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

function buildArgs(commandKey, interaction) {
  const mapper = OPTION_MAPPERS.get(commandKey);
  return mapper ? mapper(interaction.options) : {};
}

/** Every dotted leaf path of a plain config object, depth-first in key order; an empty object or an array is a leaf. */
export function leafPaths(config, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      out.push(...leafPaths(value, full));
    } else {
      out.push(full);
    }
  }
  return out;
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
  const embeds = isObject && Array.isArray(result.embeds) && result.embeds.length > 0 ? result.embeds.map((data) => new EmbedBuilder(data)) : null;
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

/** `command`-option autocomplete choices for `/nep access grant|revoke`: `*`, the groups and
 * every grantable operation name (`admin.accessKeys`, src/ops/access.js#grantKeys), filtered by the
 * typed text. Owner-only operations are never offered: no grant can open them; nor are the member
 * operations, open without one. */
function accessKeyChoices(admin, typed) {
  return admin.accessKeys()
    .filter((key) => key.toLowerCase().includes(typed))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((key) => ({ name: key, value: key }));
}

/** `model`-option autocomplete choices for `/nep route set|remove`: the model prefixes of the
 * routes in `llm.providerByModel` (the part before `@`), then the model ids the roles are
 * configured with, each once, filtered by the typed text. */
function routeModelChoices(config, typed) {
  const byModel = config?.llm?.providerByModel;
  const prefixes = byModel && typeof byModel === 'object' && !Array.isArray(byModel)
    ? Object.keys(byModel).map((key) => (key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key))
    : [];
  const models = MODEL_SET_ROLES.map((role) => roleModel(config, role));
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
export function createInteractionHandler({ hot, admin, getGuildId, now = Date.now }) {
  // Interaction ids seen in the last RETRY_WINDOW_MS, oldest first: Discord may deliver one
  // interaction twice, and the second delivery must not run its operation again.
  const seen = new Map();

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
    const context = { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, roleIds: roleIdsFor(interaction) };
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

    if (focused.name === 'command') {
      await interaction.respond(accessKeyChoices(admin, typed)).catch(() => {});
      return;
    }

    // `/nep skill allow|deny name:` offers the persona's skill names (src/skills/registry.js).
    if ((commandKey === 'skill.allow' || commandKey === 'skill.deny') && focused.name === 'name') {
      const choices = skillNames()
        .filter((name) => name.toLowerCase().includes(typed))
        .slice(0, MAX_AUTOCOMPLETE_CHOICES)
        .map((name) => ({ name, value: name }));
      await interaction.respond(choices).catch(() => {});
      return;
    }

    // `/nep route set|remove model:` and `/nep model set id:` offer the same model ids.
    if (focused.name === 'model' || (commandKey === 'model.set' && focused.name === 'id')) {
      await interaction.respond(routeModelChoices(config, typed)).catch(() => {});
      return;
    }

    if (commandKey === 'memory.restore' && focused.name === 'id') {
      const choices = typeof admin.archiveChoices === 'function' ? await admin.archiveChoices(context, typed).catch(() => []) : [];
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
      await interaction.reply({ content: 'Error: no subcommand given.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    if (!firstDelivery(interaction.id)) {
      log.warn('commands: duplicate interaction', { command: commandKey });
      return;
    }

    let mode = { deferred: false };
    try {
      const args = buildArgs(commandKey, interaction);
      const op = typeof admin.operationFor === 'function' ? admin.operationFor(commandKey, args) : null;
      mode = { deferred: op !== null && DEFERRED_OPS.has(op) };
      if (mode.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const context = { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, roleIds: roleIdsFor(interaction) };
      // The rights are checked by the operation's own runOp (src/ops/index.js), every time.
      const result = await admin.runCommand(commandKey, args, context);
      if (result.status === 'ok') {
        await respond(interaction, result.data?.files || result.data?.embeds ? result.data : result.summary, mode);
      } else if (result.status === 'denied') {
        await respond(interaction, NOT_ALLOWED_MESSAGE, mode);
      } else {
        log.warn('commands: command failed', { command: commandKey, status: result.status, code: result.code, error: new Error(result.summary) });
        await respond(interaction, `Error: ${result.summary}`, mode).catch(() => {});
      }
    } catch (err) {
      log.warn('commands: command failed', { command: commandKey, error: err });
      await respond(interaction, `Error: ${err?.message ?? String(err)}`, mode).catch(() => {});
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
