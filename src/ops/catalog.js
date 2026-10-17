// The `/nep` command catalogue: what describes the commands, not how Discord
// shows them. COMMAND_TABLE (the nineteen top-level entries, each leaf with
// its options and its option -> args mapping), the choice lists the
// operations share (model roles, status fields, journal kinds, ...), the
// deferral rules (DEFERRED_OPS, DEFER_AFTER_MS) and the pure helpers over the
// tree. interfaces/discord/commands.js builds the Discord tree from it, registers it
// and handles the interactions; src/ops/ and src/skills/ read it directly.
// No discord.js import here.
//
// Adding a command here means one COMMAND_TABLE entry (its options and its
// `args` mapper) and one src/ops/index.js#COMMAND_TO_OP entry, plus a
// DEFERRED_OPS entry when its operation may outlast the reply window.

import { isPlainObject } from '../config.js';
import { AGENT_ROLES } from '../llm/roles.js';

// Raw Discord API option-type numbers (application-command-option-type):
// https://discord.com/developers/docs/interactions/application-commands
const STRING = 3;
const INTEGER = 4;
const USER = 6;
const CHANNEL = 7;
const ROLE = 8;

// application-command-types#channel-type: GUILD_TEXT
const GUILD_TEXT = 0;

/**
 * Any other command that has not answered after this long is deferred while it finishes: Discord
 * drops an interaction not acknowledged within 3 s (a status card's model probes can take longer).
 */
export const DEFER_AFTER_MS = 2000;

/** Operations that may take long enough to need `deferReply` before `editReply`. */
export const DEFERRED_OPS = Object.freeze(new Set([
  'message.create',
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
 * src/llm/images.js#IMAGE_ROLE), which takes no chat completion, then the agent roles
 * (src/llm/roles.js#AGENT_ROLES), which take no request of the bot (OpenCode workers and the
 * consultation tools outside the bot run them).
 */
export const MODEL_SET_PATHS = Object.freeze({
  ...MODEL_ROLE_PATHS,
  drawing: 'roles.drawing',
  ...Object.fromEntries(AGENT_ROLES.map((role) => [role, `roles.${role}`])),
});

/** The roles of `MODEL_SET_PATHS`, in order: the choices of `/nep model set`. */
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

/**
 * The fields of the `/nep status` card, in order (src/ops/status.js renders them; the costs,
 * memory and speed ones are the owner's only): the choices of its `field` option. Kept here, not
 * in src/ops/status.js, which imports this module.
 */
export const STATUS_FIELDS = Object.freeze(['state', 'tasks', 'models', 'limits', 'keys', 'costs', 'memory', 'speed']);

/** `{ name, value }` choices, one per entry of `values`, the name being the value itself. */
function choicesOf(values) {
  return values.map((value) => ({ name: value, value }));
}

/** The choices of `/nep route`: the `/nep model set` roles but the agent roles, whose OpenCode
 * workers and outside tools never read `llm.providerByModel`. */
export const ROUTE_ROLES = MODEL_SET_ROLES.filter((role) => !AGENT_ROLES.includes(role));

/** `/nep memory journal`'s `kind` choices (src/admin.js reads the same list; `all` reads every kind). */
export const JOURNAL_KINDS = Object.freeze(['turn', 'action', 'memory', 'system', 'answer', 'all']);

/** `/nep memory refresh`'s `kind` choices (src/ops/index.js#COMMAND_TO_OP picks the operation by it). */
export const MEMORY_REFRESH_KINDS = Object.freeze(['user', 'channel', 'server']);

/** `/nep pings`'s `mode` choices (src/admin.js#cmdPings reads the same list). */
export const PINGS_MODES = Object.freeze(['on', 'off']);

/** `/nep task run`'s `agent` choices: the errand agents (src/agent-runner/profiles.js; src/ops/task.js reads the same list). */
export const TASK_AGENTS = Object.freeze(['web', 'server']);

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const channelOption = (description, required = false) => ({ type: CHANNEL, name: 'channel', description, required, channel_types: [GUILD_TEXT] });
const userOption = (description = 'Member.', required = true) => ({ type: USER, name: 'user', description, required });
const userId = (options) => options.getUser('user', true).id;
const none = () => ({});

/**
 * The choices of a yes/no option: lowercase `true` / `false` (a Discord BOOLEAN shows as
 * True/False), sent as a STRING option and read back by readFlag.
 */
export const FLAG_CHOICES = Object.freeze([Object.freeze({ name: 'true', value: 'true' }), Object.freeze({ name: 'false', value: 'false' })]);

/** A yes/no option: a STRING with FLAG_CHOICES. */
function flagOption(name, description) {
  return { type: STRING, name, description, required: false, choices: FLAG_CHOICES.map((choice) => ({ ...choice })) };
}

/**
 * A yes/no option's value as a boolean: `true` / `'true'` -> true, `false` / `'false'` ->
 * false (any case, trimmed), anything else (absent included) -> null. Reads the option as a
 * string (a Discord interaction) or as the boolean a persona's call carries.
 * @param {{ getString: (name: string) => unknown }} options
 * @param {string} name
 * @returns {boolean|null}
 */
export function readFlag(options, name) {
  const value = options.getString(name);
  if (typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'true' ? true : text === 'false' ? false : null;
}

/**
 * The whole `/nep` tree, top level in display order: a leaf is `{ name, description, options?,
 * args }`, a group is `{ name, description, subcommands: [leaf, ...] }`. `args(options)` maps a
 * discord.js interaction's options onto the plain `args` of src/admin.js#runCommand; the rest is
 * the Discord JSON of the node (`buildCommandTree` drops `args`); `personaOptions` are options
 * only the persona's own call of the operation gives (src/skills/derive.js), never sent to Discord. Option names are lowercase;
 * no name carries a hyphen; `action` only where every action takes the same options.
 */
export const COMMAND_TABLE = Object.freeze([
  {
    name: 'status',
    description: 'What the bot is doing now: one card.',
    options: [
      { type: STRING, name: 'field', description: 'Show only this field of the card.', required: false, choices: choicesOf(STATUS_FIELDS) },
    ],
    args: (options) => ({ field: options.getString('field') ?? null }),
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
    description: 'Draw one picture. Spends balance.',
    options: [
      { type: STRING, name: 'text', description: 'What to draw.', required: true },
      flagOption('self', 'The persona is in it (adds the appearance prompt).'),
      channelOption('Post it there as the persona (default: shown only to you).'),
    ],
    args: (options) => {
      const channelId = options.getChannel('channel')?.id;
      return { text: options.getString('text', true), self: readFlag(options, 'self') ?? false, ...(channelId ? { channelId } : {}) };
    },
  },
  {
    name: 'pings',
    description: "Choose whether the bot's messages notify you.",
    options: [{ type: STRING, name: 'mode', description: 'on or off; leave empty to see your current setting.', required: false, choices: choicesOf(PINGS_MODES) }],
    args: (options) => ({ mode: options.getString('mode') ?? undefined }),
  },
  {
    name: 'media',
    description: 'The custom emoji ranking, the GIF library and the picture descriptions.',
    options: [
      { type: STRING, name: 'kind', description: 'emoji, gifs, or pictures (recache only).', required: true, choices: choicesOf(['emoji', 'gifs', 'pictures']) },
      { type: STRING, name: 'action', description: 'status; rescan recounts from history; recache re-describes.', required: true, choices: choicesOf(['status', 'rescan', 'recache']) },
      { type: INTEGER, name: 'days', description: 'pictures recache: descriptions used in the last N days (default 7).', required: false, min_value: 1, max_value: 60 },
    ],
    args: (options) => {
      const days = options.getInteger('days');
      return { kind: options.getString('kind', true), action: options.getString('action', true), ...(days == null ? {} : { days }) };
    },
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
          flagOption('fallbacks', 'Allow other providers if these fail (default: false).'),
          flagOption('byok', 'Refuse answers not served by your own provider keys (default: false).'),
        ],
        args: (options) => ({
          model: options.getString('model', true),
          providers: options.getString('providers', true),
          role: options.getString('role') ?? undefined,
          fallbacks: readFlag(options, 'fallbacks') ?? undefined,
          byok: readFlag(options, 'byok') ?? undefined,
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
    name: 'message',
    description: "The persona's own messages: speak now, change, delete, react.",
    subcommands: [
      {
        name: 'create',
        description: 'Make the persona speak now: her turn, in her own words.',
        options: [channelOption('Channel (default: this one).'), { type: STRING, name: 'reply', description: 'Message id or link to answer.', required: false }],
        // When the persona herself calls it, she gives her text: an argument only she has
        // (src/skills/derive.js), never shown to Discord; the operation picks its mode by who acts.
        // With it, a file one of her errands brought back (`file:<task id>/<name>`, src/errands/store.js).
        personaOptions: [
          { type: STRING, name: 'text', description: 'Her text.', required: true, max_length: 2000 },
          { type: STRING, name: 'file', description: 'A file handle of one of her errands.', required: false, max_length: 300 },
        ],
        args: (options) => ({ channelId: options.getChannel('channel')?.id, replyTo: options.getString('reply') ?? undefined, text: options.getString('text') ?? undefined, file: options.getString('file') ?? undefined }),
      },
      {
        name: 'edit',
        description: "Change one of the persona's messages.",
        options: [
          { type: STRING, name: 'message', description: 'Message id or link.', required: true },
          { type: STRING, name: 'text', description: 'The new text.', required: true, max_length: 2000 },
          channelOption('Channel (default: this one).'),
        ],
        args: (options) => ({ messageId: options.getString('message', true), text: options.getString('text', true), channelId: options.getChannel('channel')?.id }),
      },
      {
        name: 'delete',
        description: "Delete one of the persona's messages.",
        options: [{ type: STRING, name: 'message', description: 'Message id or link.', required: true }, channelOption('Channel (default: this one).')],
        args: (options) => ({ messageId: options.getString('message', true), channelId: options.getChannel('channel')?.id }),
      },
      {
        name: 'react',
        description: "Put or take back the persona's reaction.",
        options: [
          { type: STRING, name: 'action', description: 'add or remove.', required: true, choices: choicesOf(['add', 'remove']) },
          { type: STRING, name: 'message', description: 'Message id or link.', required: true },
          { type: STRING, name: 'emoji', description: 'The emoji.', required: true, max_length: 100 },
          channelOption('Channel (default: this one).'),
        ],
        args: (options) => ({ action: options.getString('action', true), messageId: options.getString('message', true), emoji: options.getString('emoji', true), channelId: options.getChannel('channel')?.id }),
      },
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
    name: 'task',
    description: "The persona's errands, run by her agents.",
    subcommands: [
      {
        name: 'run',
        description: 'Hand an errand to an agent (server: owners only).',
        options: [
          { type: STRING, name: 'agent', description: 'web or server.', required: true, choices: choicesOf(TASK_AGENTS) },
          { type: STRING, name: 'goal', description: 'What to find out or fetch.', required: true, max_length: 2000 },
        ],
        args: (options) => ({ agent: options.getString('agent', true), goal: options.getString('goal', true) }),
      },
      {
        name: 'status',
        description: 'One task, or the open ones.',
        options: [{ type: STRING, name: 'id', description: 'Task id (omit for the open ones).', required: false }],
        args: (options) => ({ id: options.getString('id') ?? undefined }),
      },
      {
        name: 'cancel',
        description: 'Cancel an open task (its requester or an owner).',
        options: [{ type: STRING, name: 'id', description: 'Task id.', required: true }],
        args: (options) => ({ id: options.getString('id', true) }),
      },
      { name: 'list', description: 'The latest ten tasks.', args: none },
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
          flagOption('always', 'Show it even without a match.'),
        ],
        args: (options) => ({
          title: options.getString('title', true),
          keys: options.getString('keys', true),
          text: options.getString('text', true),
          always: readFlag(options, 'always') ?? false,
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
        description: "Show a member's attitude score and its history.",
        options: [userOption()],
        args: (options) => ({ userId: userId(options) }),
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
          { type: STRING, name: 'message', description: 'Message id or link: the turn that posted it, in full.', required: false },
        ],
        args: (options) => ({
          day: options.getString('day') ?? undefined,
          kind: options.getString('kind') ?? undefined,
          n: options.getInteger('n') ?? undefined,
          messageId: options.getString('message') ?? undefined,
        }),
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

/** `^[a-z0-9_-]{1,32}$` — Discord's rule for a command name. */
export function isValidCommandName(name) {
  return typeof name === 'string' && /^[a-z0-9_-]{1,32}$/.test(name);
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
