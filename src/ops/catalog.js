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
import { AGENT_ROLES, CORE_ROLES, OPENCODE_ROLES, roleConfigKeys } from '../llm/roles.js';

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
  'draw.create',
]));

/**
 * The core's model roles (src/llm/roles.js#CORE_ROLES: the core, then the helpers), each with the
 * config path of its model (src/ops/model.js): the roles the status card probes; with the agents'
 * roles they make `MODEL_SET_PATHS`; every role choice list is derived from this one. `core` is
 * the one model that speaks as the persona: its replies and every memory text worded in its voice
 * (src/memory/update.js#runVoice). `embedding` serves the embeddings (src/llm/embed.js), which
 * take no chat completion.
 */
export const MODEL_ROLE_PATHS = Object.freeze(Object.fromEntries(CORE_ROLES.map((role) => [role, roleConfigKeys(role).join('.')])));

/** The roles of `MODEL_ROLE_PATHS`, in order. */
export const MODEL_ROLES = Object.freeze(Object.keys(MODEL_ROLE_PATHS));

/**
 * The roles whose model `/nep model show|set` lists and changes, each with the config path
 * `set` writes: the core and the helper roles (`models.core`, `models.helpers`), then the agents' roles
 * (`models.agents`, src/llm/roles.js#AGENT_ROLES): `web`, `server`, `thinker`, `dev` and `writer`, which take no
 * request of the bot (OpenCode workers run them), then the drawing model (`drawing`,
 * src/llm/images.js#IMAGE_ROLE), which takes no chat completion.
 */
export const MODEL_SET_PATHS = Object.freeze({
  ...MODEL_ROLE_PATHS,
  ...Object.fromEntries(AGENT_ROLES.map((role) => [role, `models.agents.${role}`])),
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
export const STATUS_FIELDS = Object.freeze(['state', 'tasks', 'models.base', 'keys.base', 'costs.base', 'models.agents', 'costs.agents', 'inner', 'limits', 'memory', 'speed']);

/**
 * The parts of the status card her own `status.show` call may ask for (`part`), each a few of the
 * card's fields (src/ops/status.js#PART_FIELDS): `overview` (the default of her call), `limits`,
 * `models`, `memory`, `inner`, `errands`, `features` and `all` (the whole card).
 */
export const STATUS_PARTS = Object.freeze(['overview', 'limits', 'models', 'memory', 'inner', 'errands', 'features', 'all']);

/** `{ name, value }` choices, one per entry of `values`, the name being the value itself. */
function choicesOf(values) {
  return values.map((value) => ({ name: value, value }));
}

/** The choices of `/nep route`: the `/nep model set` roles but the OpenCode ones (`web`,
 * `server`, `thinker`, `dev`, `writer`), whose workers never read `llm.providerByModel`, and `speech`,
 * whose one model is routed by its own prefix (the command tree is at Discord's size limit). */
export const ROUTE_ROLES = MODEL_SET_ROLES.filter((role) => !OPENCODE_ROLES.includes(role) && role !== 'speech');

/** `/nep memory journal`'s `kind` choices (src/admin.js reads the same list; `all` reads every kind). */
export const JOURNAL_KINDS = Object.freeze(['turn', 'action', 'memory', 'system', 'answer', 'inner', 'all']);

/** `/nep memory refresh`'s `kind` choices (src/ops/index.js#COMMAND_TO_OP picks the operation by it). */
export const MEMORY_REFRESH_KINDS = Object.freeze(['user', 'channel', 'server']);

/** `/nep pings`'s `mode` choices (src/admin.js#cmdPings reads the same list). */
export const PINGS_MODES = Object.freeze(['on', 'off']);

/** `/nep task run`'s `agent` choices: the errand agents (src/agent-runner/profiles.js; src/ops/task.js reads the same list). */
export const TASK_AGENTS = Object.freeze(['web', 'server']);

/** `task status`'s persona-only `action` choices (src/ops/index.js#COMMAND_TO_OP picks the operation by it). */
const RESULT_ACTIONS = Object.freeze(['read', 'resolve']);

/** `/nep task intent`'s `action` choices (src/ops/index.js#COMMAND_TO_OP picks the operation by it). */
export const INTENT_ACTIONS = Object.freeze(['add', 'update', 'cancel', 'list']);

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
 * only the persona's own call of the operation gives, never sent to Discord (kept for `/nep` until the split;
 * her skills do not read them: src/skills/definitions.js is her own table); a leaf
 * with `personaOnly` is her skill alone and is left out of the Discord tree. Option names are lowercase;
 * no name carries a hyphen; `action` only where every action takes the same options.
 */
export const COMMAND_TABLE = Object.freeze([
  {
    name: 'status',
    description: 'What the bot is doing now: one card.',
    options: [
      { type: STRING, name: 'field', description: 'Show only this field of the card.', required: false, choices: choicesOf(STATUS_FIELDS) },
    ],
    // Her own call may ask for a part instead (an argument only she has, never shown to Discord).
    personaOptions: [{ type: STRING, name: 'part', description: 'A part of the card.', required: false, choices: choicesOf(STATUS_PARTS) }],
    args: (options) => ({ field: options.getString('field') ?? null, ...(options.getString('part') ? { part: options.getString('part') } : {}) }),
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
      { type: STRING, name: 'action', description: 'status, rescan (recount) or recache.', required: true, choices: choicesOf(['status', 'rescan', 'recache']) },
      { type: INTEGER, name: 'days', description: 'Recache: pictures used in the last N days (default 7).', required: false, min_value: 1, max_value: 60 },
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
        options: [channelOption('Channel; leave out to post here.'), { type: STRING, name: 'reply', description: 'Message id or link to answer.', required: false }],
        // When the persona herself calls it, she gives her text: an argument only she has
        // (her skills' own table, src/skills/definitions.js, carries them now), never shown to Discord; the operation picks its mode by who acts.
        // With it, a file one of her errands brought back (`file:<task id>/<name>`, src/errands/store.js),
        // and a GIF of her library (`gif`, a handle: src/media/gif-post.js).
        personaOptions: [
          { type: STRING, name: 'text', description: 'Her text.', required: true, max_length: 2000 },
          { type: STRING, name: 'file', description: 'A file handle of one of her errands.', required: false, max_length: 300 },
          { type: STRING, name: 'gif', description: 'A handle of a GIF in her library.', required: false, max_length: 40 },
          { type: STRING, name: 'media', description: 'Her message (#N or link) whose attachment to post again.', required: false, max_length: 300 },
          { type: INTEGER, name: 'item', description: 'Which attachment of that message (default 1).', required: false, min_value: 1, max_value: 20 },
        ],
        args: (options) => ({ channelId: options.getChannel('channel')?.id, replyTo: options.getString('reply') ?? undefined, text: options.getString('text') ?? undefined, file: options.getString('file') ?? undefined, gif: options.getString('gif') ?? undefined, media: options.getString('media') ?? undefined, item: options.getInteger('item') ?? undefined }),
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
        // Her own call also reads a finished task's result in pages (`action: read`, from the
        // character `from`) or closes it (`action: resolve`): arguments only she has (her skills' table, src/skills/definitions.js, carries them now),
        // never shown to Discord, whose command tree is near its size limit.
        personaOptions: [
          { type: STRING, name: 'action', description: 'read or resolve a finished task.', required: false, choices: choicesOf(RESULT_ACTIONS) },
          { type: INTEGER, name: 'from', description: 'Start character of a page.', required: false, min_value: 0, max_value: 10000000 },
        ],
        args: (options) => ({ id: options.getString('id') ?? undefined, action: options.getString('action') ?? undefined, from: options.getInteger('from') ?? undefined }),
      },
      {
        name: 'cancel',
        description: 'Cancel an open task (its requester or an owner).',
        options: [{ type: STRING, name: 'id', description: 'Task id.', required: true }],
        args: (options) => ({ id: options.getString('id', true) }),
      },
      { name: 'list', description: 'The latest ten tasks.', args: none },
      {
        // The persona's intentions (src/ops/intent.js): one leaf, `action` picks the operation;
        // each option is optional here, its operation says which it needs.
        name: 'intent',
        description: "The persona's intentions.",
        options: [
          { type: STRING, name: 'action', description: 'What to do.', required: true, choices: choicesOf(INTENT_ACTIONS) },
          { type: STRING, name: 'text', description: 'Purpose.', required: false, max_length: 300 },
          { type: STRING, name: 'id', description: 'Intention id.', required: false, max_length: 20 },
          { type: STRING, name: 'due', description: 'When: 30m, 6h, 2d, 21:00, mon 20:00 or ISO.', required: false, max_length: 40 },
          { type: STRING, name: 'every', description: 'Repeat: day, week, 12h, 3d; none clears.', required: false, max_length: 10 },
          { type: STRING, name: 'expires', description: 'Expiry, same form.', required: false, max_length: 40 },
          { type: STRING, name: 'task', description: 'Errand id to wait for.', required: false, max_length: 20 },
          { type: STRING, name: 'deadline', description: 'Wait until.', required: false, max_length: 40 },
          { type: STRING, name: 'state', description: 'pending, done or dropped.', required: false, choices: choicesOf(['pending', 'done', 'dropped']) },
          { type: STRING, name: 'chain', description: 'Chain id.', required: false, max_length: 64 },
          { type: STRING, name: 'condition', description: 'Done when.', required: false, max_length: 300 },
          channelOption('Destination.'),
          // An attention (src/ops/intent.js): the place to listen to, the people whose lines count,
          // the quiet seconds before a wake, her own daily bound.
          { type: CHANNEL, name: 'attend', description: 'Listen there.', required: false, channel_types: [GUILD_TEXT] },
          { type: STRING, name: 'people', description: 'Whose lines count.', required: false, max_length: 500 },
          { type: INTEGER, name: 'settle', description: 'Quiet seconds.', required: false, min_value: 0, max_value: 86400 },
          { type: INTEGER, name: 'perday', description: 'Wakes a day.', required: false, min_value: 1, max_value: 1000 },
        ],
        // Her own call also gives the reason of a dropped intention: an argument only she has
        // (her skills' own table, src/skills/definitions.js, carries them now), never shown to Discord, whose command tree is near its size limit.
        personaOptions: [{ type: STRING, name: 'reason', description: 'Why it is dropped.', required: false, max_length: 300 }],
        args: (options) => {
          const out = { action: options.getString('action', true) };
          for (const name of ['text', 'id', 'due', 'every', 'expires', 'task', 'deadline', 'state', 'chain', 'condition', 'people', 'reason']) {
            const value = options.getString(name);
            if (value !== null && value !== undefined) out[name] = value;
          }
          for (const name of ['settle', 'perday']) {
            const value = options.getInteger(name);
            if (value !== null && value !== undefined) out[name] = value;
          }
          const channelId = options.getChannel('channel')?.id;
          const attend = options.getChannel('attend')?.id;
          return { ...out, ...(channelId ? { channelId } : {}), ...(attend ? { attend } : {}) };
        },
      },
      {
        // One skill or a family in full (src/ops/skills.js): her read skill `skills.describe`.
        name: 'skills',
        personaOnly: true,
        description: 'Skill info.',
        options: [{ type: STRING, name: 'name', description: 'Name.', required: true, max_length: 60 }],
        args: (options) => ({ name: options.getString('name', true) }),
      },
      {
        // The places the interfaces publish (src/ops/places.js, docs/inner-life.md "Her attention"):
        // her read skill `places.list`, with a filter, a sort and a page.
        name: 'places',
        description: 'Places, new lines.',
        options: [
          { type: STRING, name: 'filter', description: 'Name has.', required: false, max_length: 100 },
          // `sort` names recent, name or lines (src/ops/places.js#PLACE_SORTS); no choices, to keep the tree under Discord's size.
          { type: STRING, name: 'sort', description: 'Order.', required: false, max_length: 10 },
          { type: INTEGER, name: 'page', description: 'Page.', required: false, min_value: 1, max_value: 1000 },
        ],
        args: (options) => {
          const page = options.getInteger('page');
          return { filter: options.getString('filter') ?? undefined, sort: options.getString('sort') ?? undefined, ...(page == null ? {} : { page }) };
        },
      },
      {
        // A channel read in order (src/ops/search.js, src/skills/conversation-read.js): her read skill
        // `conversation.read`, with no slash command (`personaOnly`: the tree has no room left under
        // Discord's size limit). `around`, `before` and `after` take a message id or link, `before` and
        // `after` a count beside `around`; `since` a delay (2h), a clock time or an ISO date.
        name: 'conversation',
        personaOnly: true,
        description: 'Read a channel in order.',
        options: [
          channelOption('Channel; leave out for this one.'),
          { type: STRING, name: 'around', description: 'Message id or link.', required: false, max_length: 200 },
          { type: STRING, name: 'before', description: 'Message id or link, or a count.', required: false, max_length: 200 },
          { type: STRING, name: 'after', description: 'Message id or link, or a count.', required: false, max_length: 200 },
          { type: STRING, name: 'since', description: 'A delay, a time or a date.', required: false, max_length: 40 },
          { type: INTEGER, name: 'last', description: 'Lines (default 20).', required: false, min_value: 1, max_value: 60 },
        ],
        args: (options) => {
          const last = options.getInteger('last');
          const out = {};
          for (const name of ['around', 'before', 'after', 'since']) {
            const value = options.getString(name);
            if (value !== null && value !== undefined) out[name] = value;
          }
          const channelId = options.getChannel('channel')?.id;
          return { ...out, ...(channelId ? { channelId } : {}), ...(last == null ? {} : { last }) };
        },
      },
      {
        // The kill switch of the persona's inner life (src/ops/inner.js): owner-only.
        name: 'inner',
        description: "The persona's inner life: stop, start or show it.",
        options: [{ type: STRING, name: 'action', description: 'What to do.', required: true, choices: choicesOf(['stop', 'start', 'status']) }],
        args: (options) => ({ action: options.getString('action', true) }),
      },
      {
        name: 'search',
        description: 'One quick web search (search snippets, pages not opened).',
        options: [
          { type: STRING, name: 'query', description: 'What to search for.', required: true, max_length: 200 },
          { type: STRING, name: 'goal', description: 'What the search should establish.', required: false, max_length: 300 },
        ],
        args: (options) => ({ query: options.getString('query', true), goal: options.getString('goal') ?? undefined }),
      },
      {
        name: 'read',
        description: "Read one web page: its own text, cut (no summary).",
        options: [{ type: STRING, name: 'url', description: 'The page link (http or https).', required: false, max_length: 2000 }],
        // When the persona herself calls it she may name a message she sees (`#N`) instead of a
        // link: an argument only she has (her skills' own table, src/skills/definitions.js, carries them now), never shown to Discord.
        personaOptions: [{ type: STRING, name: 'message', description: 'A message whose link to read.', required: false, max_length: 100 }],
        args: (options) => ({ url: options.getString('url') ?? undefined, message: options.getString('message') ?? undefined }),
      },
      {
        // The persona's own second look at a picture or a video (src/ops/search.js, features.coreTools):
        // her call names a message she sees as `#N`; the owner gives its id or link.
        name: 'look',
        description: 'Look again at a picture or video of a message.',
        options: [
          { type: STRING, name: 'message', description: 'The message id or link (in this channel).', required: true, max_length: 200 },
          { type: STRING, name: 'question', description: 'What to look for.', required: true, max_length: 500 },
          { type: INTEGER, name: 'item', description: 'Which one (default 1).', required: false, min_value: 1, max_value: 20 },
        ],
        args: (options) => {
          const item = options.getInteger('item');
          return { message: options.getString('message', true), question: options.getString('question', true), ...(item == null ? {} : { item }) };
        },
      },
      {
        // The persona's own search of her GIF library by the stored descriptions (src/ops/search.js).
        name: 'find',
        personaOnly: true,
        description: 'Search the GIF library.',
        options: [{ type: STRING, name: 'query', description: 'What it shows.', required: true, max_length: 200 }],
        // How many come back: an argument only her own call has (never shown to Discord, the tree's size).
        personaOptions: [{ type: INTEGER, name: 'n', description: 'How many (default 5).', required: false, min_value: 1, max_value: 10 }],
        args: (options) => {
          const n = options.getInteger('n');
          return { query: options.getString('query', true), ...(n == null ? {} : { n }) };
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
      {
        name: 'search',
        description: "Search this server's message history; the messages come back quoted.",
        options: [
          { type: STRING, name: 'question', description: 'What to find.', required: false, max_length: 500 },
          { type: STRING, name: 'people', description: 'Names, comma-separated.', required: false, max_length: 200 },
          channelOption('Only this channel.'),
          { type: STRING, name: 'when', description: 'YYYY-MM-DD, or a range A..B (either side may be open).', required: false, max_length: 40 },
          { type: STRING, name: 'terms', description: 'Exact words or phrases, comma-separated.', required: false, max_length: 300 },
          { type: STRING, name: 'anchor', description: 'A message id: read the lines around it.', required: false, max_length: 200 },
          { type: STRING, name: 'move', description: 'With anchor: up reads earlier lines, down later ones.', required: false, choices: choicesOf(['up', 'down']) },
          { type: INTEGER, name: 'messages', description: 'With anchor: how many lines.', required: false, min_value: 1, max_value: 60 },
          { type: INTEGER, name: 'minutes', description: 'With anchor: how many minutes.', required: false, min_value: 1, max_value: 1440 },
        ],
        args: (options) => ({
          question: options.getString('question') ?? undefined,
          people: options.getString('people') ?? undefined,
          channelId: options.getChannel('channel')?.id,
          when: options.getString('when') ?? undefined,
          terms: options.getString('terms') ?? undefined,
        }),
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
