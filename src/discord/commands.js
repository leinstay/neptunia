// The owner's Discord surface: one top-level guild slash command (name from
// `config.bot.commandName`) whose tree is built here as plain JSON — no
// discord.js builder classes — so `buildCommandTree` is trivially unit
// -tested. `registerCommands` pushes that tree to the single guild this
// instance serves; `createInteractionHandler` turns a discord.js interaction
// into an `admin.run(commandKey, args, context)` call and replies, always
// ephemerally, never letting an error escape into discord.js. One
// subcommand, `pings`, is a member's own notification switch, open to every
// member (src/discord/access.js#isMemberCommand).
//
// Every option → args mapping lives in one place (OPTION_MAPPERS): adding a
// command here means one tree entry and one mapper, plus a SLOW_COMMANDS
// entry when it may outlast Discord's reply window; its handler lives in
// src/admin.js.

import { MessageFlags } from 'discord.js';
import { isMemberCommand, isOwnerOnly } from './access.js';
import { isPlainObject } from '../config.js';
import { log } from '../log.js';

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

/** Commands that may take long enough to need `deferReply` before `editReply`. */
const SLOW_COMMANDS = new Set([
  'interject',
  'initiate',
  'reload',
  'pause',
  'resume',
  'ping',
  'warmup.people',
  'warmup.run',
  'warmup.stop',
  'warmup.users',
  'warmup.channels',
  'warmup.server',
  'warmup.status',
  'warmup.reset',
  'memory.refresh',
  'memory.forget',
  'memory.wipe',
  'emoji.rescan',
  'gifs.rescan',
  'private.forget',
  'private.purge',
  'diary.set',
  'diary.post',
  'draw',
  'mentor.add',
  'mentor.anchor',
  'mentor.run',
  'mentor.check',
  'mentor.show',
]);

/**
 * The chat-model roles, each with the config path of its model (src/admin.js):
 * the roles `/nep ping` sends a chat completion for. `/nep model` and `/nep
 * route` add `image` (`MODEL_SET_PATHS`), `/nep ping` adds `image` (checked
 * against the provider's listing, never with a chat request) and `classifier`:
 * every role choice list is derived from this one. `voice` is the one model that
 * speaks as the persona: its replies and every memory text worded in its voice
 * (src/memory/update.js#runVoice).
 */
export const MODEL_ROLE_PATHS = Object.freeze({
  voice: 'llm.model',
  analyzer: 'memory.model',
  'classifier.text': 'classifier.text',
  'classifier.media': 'classifier.media',
  'classifier.video': 'classifier.video',
  mentor: 'mentor.model',
});

/** The roles of `MODEL_ROLE_PATHS`, in order. */
export const MODEL_ROLES = Object.freeze(Object.keys(MODEL_ROLE_PATHS));

/**
 * The roles whose model `/nep model show|set` lists and changes, each with the config path
 * `set` writes: the chat roles, then the drawing model (`image`, src/llm/images.js#IMAGE_ROLE),
 * which takes no chat completion.
 */
export const MODEL_SET_PATHS = Object.freeze({ ...MODEL_ROLE_PATHS, image: 'image.model' });

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
const PING_ROLES = Object.freeze([...ROUTE_ROLES, 'classifier']);

/** `/nep pings`'s `mode` choices (src/admin.js#cmdPings reads the same list). */
export const PINGS_MODES = Object.freeze(['on', 'off']);

const DISABLED_MESSAGE = 'Owner commands are disabled (features.adminCommands is off).';
const NOT_ALLOWED_MESSAGE = 'Not allowed';

/** Discord's cap on one application command's combined text (see `commandSize`). */
const COMMAND_SIZE_LIMIT = 8000;

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
 * `commandName`. Pure — no discord.js object, no I/O. Always visible to
 * every member (no `default_member_permissions`); an ungranted member who
 * runs it gets the not-allowed reply — all gating happens at interaction
 * time (`createInteractionHandler`, `admin.isAllowed`), never through
 * Discord's own command visibility, so re-registering never invalidates a
 * client's cached command.
 */
export function buildCommandTree(commandName) {
  const caseIdHelp = `Case id from /${commandName} mentor cases.`;
  return [
    {
      name: commandName,
      description: 'Owner controls for the persona.',
      options: [
        { type: SUBCOMMAND, name: 'status', description: 'Model, calibration, quotas and memory status.' },
        {
          type: SUBCOMMAND,
          name: 'ping',
          description: "Check each role's model is reachable: latency, provider, errors.",
          options: [
            {
              type: STRING,
              name: 'role',
              description: 'Role to ping (default: all).',
              required: false,
              choices: choicesOf(PING_ROLES),
            },
          ],
        },
        { type: SUBCOMMAND, name: 'reload', description: 'Reload config and prompts now.' },
        {
          type: SUBCOMMAND,
          name: 'pings',
          description: "Choose whether the bot's messages notify you.",
          options: [
            { type: STRING, name: 'mode', description: 'on or off; leave empty to see your current setting.', required: false, choices: choicesOf(PINGS_MODES) },
          ],
        },
        {
          type: SUBCOMMAND,
          name: 'pause',
          description: 'Pause the persona and flush memory so data/ can be hand-edited.',
        },
        {
          type: SUBCOMMAND,
          name: 'resume',
          description: 'Resume after a pause; refused if a data/ file is invalid.',
        },
        {
          type: SUBCOMMAND,
          name: 'interject',
          description: 'Make the persona join the conversation now.',
          options: [
            {
              type: CHANNEL,
              name: 'channel',
              description: 'Channel (default: this one).',
              required: false,
              channel_types: [GUILD_TEXT],
            },
          ],
        },
        {
          type: SUBCOMMAND,
          name: 'initiate',
          description: 'Make the persona start a topic now.',
          options: [
            {
              type: CHANNEL,
              name: 'channel',
              description: 'Channel (default: this one).',
              required: false,
              channel_types: [GUILD_TEXT],
            },
          ],
        },
        {
          type: SUBCOMMAND,
          name: 'draw',
          description: 'Draw one picture, shown only to you. Spends balance.',
          options: [
            { type: STRING, name: 'text', description: 'What to draw.', required: true },
            { type: BOOLEAN, name: 'self', description: 'The persona is in it (adds the appearance prompt).', required: false },
          ],
        },
        {
          type: SUBCOMMAND,
          name: 'set',
          description: 'Override a config value in config.local.json.',
          options: [
            { type: STRING, name: 'path', description: 'Dotted config path.', required: true, autocomplete: true },
            { type: STRING, name: 'value', description: 'New value: JSON or a plain string.', required: true },
          ],
        },
        {
          type: SUBCOMMAND,
          name: 'unset',
          description: 'Remove a config override.',
          options: [
            { type: STRING, name: 'path', description: 'Dotted config path.', required: true, autocomplete: true },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'rule',
          description: 'Live corrections in prompts.local/rules.md.',
          options: [
            {
              type: SUBCOMMAND,
              name: 'add',
              description: 'Append a rule.',
              options: [{ type: STRING, name: 'text', description: 'Rule text.', required: true }],
            },
            { type: SUBCOMMAND, name: 'list', description: 'List the rules, numbered.' },
            {
              type: SUBCOMMAND,
              name: 'remove',
              description: 'Remove a rule by number.',
              options: [{ type: INTEGER, name: 'number', description: 'Rule number.', required: true, min_value: 1 }],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'memory',
          description: 'Inspect or edit stored memory.',
          options: [
            {
              type: SUBCOMMAND,
              name: 'show',
              description: "Show a member's stored profile.",
              options: [
                { type: USER, name: 'user', description: 'Member.', required: true },
                {
                  type: STRING,
                  name: 'section',
                  description: 'Profile part (default: summary).',
                  required: false,
                  choices: choicesOf(MEMORY_SHOW_SECTIONS),
                },
                {
                  type: INTEGER,
                  name: 'limit',
                  description: 'Max items for a list section (default 25).',
                  required: false,
                  min_value: 1,
                  max_value: 100,
                },
                {
                  type: STRING,
                  name: 'order',
                  description: 'Order for a list section (default: rank).',
                  required: false,
                  choices: [
                    { name: 'rank', value: 'rank' },
                    { name: 'recent', value: 'recent' },
                  ],
                },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'channel',
              description: "Show a channel's note, or a table of all stored channels.",
              options: [
                {
                  type: CHANNEL,
                  name: 'channel',
                  description: 'Channel to show (omit for the table).',
                  required: false,
                  channel_types: [GUILD_TEXT],
                },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'server',
              description: 'Show server notes: patterns, starters, in-jokes, self facts.',
            },
            {
              type: SUBCOMMAND,
              name: 'recent',
              description: 'Show the live recent lines, newest first.',
            },
            {
              type: SUBCOMMAND,
              name: 'forget',
              description: "Delete a member's profile and private memory.",
              options: [{ type: USER, name: 'user', description: 'Member.', required: true }],
            },
            {
              type: SUBCOMMAND,
              name: 'affinity',
              description: "Show or set a member's attitude score.",
              options: [
                { type: USER, name: 'user', description: 'Member.', required: true },
                {
                  type: INTEGER,
                  name: 'score',
                  description: 'New score; omit to only show it.',
                  required: false,
                  min_value: -100,
                  max_value: 100,
                },
                { type: STRING, name: 'reason', description: 'Why (only with score).', required: false },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'wipe',
              description: 'Delete ALL server memory (profiles, private memory, habits, channels, lore).',
              options: [
                {
                  type: STRING,
                  name: 'confirm',
                  description: "Type this server's exact name to confirm.",
                  required: true,
                },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'refresh',
              description: "Rewrite a member's portrait now, ignoring the refresh-hours rail.",
              options: [{ type: USER, name: 'user', description: 'Member.', required: true }],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'private',
          description: "A member's private memory: what they said in DMs.",
          options: [
            {
              type: SUBCOMMAND,
              name: 'show',
              description: "Private memory, private and effective attitude, today's DM replies.",
              options: [{ type: USER, name: 'user', description: 'Member.', required: true }],
            },
            {
              type: SUBCOMMAND,
              name: 'forget',
              description: 'Delete only the private memory; the profile stays.',
              options: [{ type: USER, name: 'user', description: 'Member.', required: true }],
            },
            {
              type: SUBCOMMAND,
              name: 'purge',
              description: "Delete the bot's DMs with the member, then their private memory.",
              options: [{ type: USER, name: 'user', description: 'Member.', required: true }],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'diary',
          description: 'The diary.',
          options: [
            {
              type: SUBCOMMAND,
              name: 'set',
              description: 'Set the diary channel.',
              options: [
                {
                  type: CHANNEL,
                  name: 'channel',
                  description: 'Channel.',
                  required: true,
                  channel_types: [GUILD_TEXT],
                },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'show',
              description: 'Diary state today.',
            },
            {
              type: SUBCOMMAND,
              name: 'off',
              description: 'Stop the diary.',
            },
            {
              type: SUBCOMMAND,
              name: 'post',
              description: 'Post one entry now.',
              options: [
                { type: STRING, name: 'kind', description: 'Kind.', required: false },
                { type: STRING, name: 'topic', description: 'Topic.', required: false, max_length: 300 },
              ],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'alias',
          description: 'Nicknames others in chat call a member.',
          options: [
            {
              type: SUBCOMMAND,
              name: 'add',
              description: "Add or strengthen a member's alias.",
              options: [
                { type: USER, name: 'user', description: 'Member.', required: true },
                { type: STRING, name: 'name', description: 'The alias.', required: true },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'remove',
              description: "Remove a member's alias.",
              options: [
                { type: USER, name: 'user', description: 'Member.', required: true },
                { type: STRING, name: 'name', description: 'The alias.', required: true },
              ],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'lore',
          description: 'Lorebook: events, recurring characters, running jokes.',
          options: [
            {
              type: SUBCOMMAND,
              name: 'add',
              description: 'Add or overwrite an entry (it becomes an owner entry).',
              options: [
                { type: STRING, name: 'title', description: 'Entry title (its identity).', required: true },
                { type: STRING, name: 'keys', description: 'Comma-separated keys/phrases people type.', required: true },
                { type: STRING, name: 'text', description: 'Entry text, up to lore.textChars.', required: true },
                { type: BOOLEAN, name: 'always', description: 'Show it even without a match.', required: false },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'list',
              description: 'List entries, optionally filtered.',
              options: [{ type: STRING, name: 'query', description: 'Substring of the title or keys.', required: false }],
            },
            {
              type: SUBCOMMAND,
              name: 'show',
              description: 'Show one entry in full.',
              options: [{ type: STRING, name: 'id', description: 'Entry id.', required: true }],
            },
            {
              type: SUBCOMMAND,
              name: 'remove',
              description: 'Delete one entry.',
              options: [{ type: STRING, name: 'id', description: 'Entry id.', required: true }],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'learned',
          description: 'What people taught the persona here.',
          options: [
            { type: SUBCOMMAND, name: 'list', description: 'List learned items, best ranked first.' },
            {
              type: SUBCOMMAND,
              name: 'add',
              description: 'Add or strengthen a learned item.',
              options: [{ type: STRING, name: 'text', description: 'What the persona should know.', required: true }],
            },
            {
              type: SUBCOMMAND,
              name: 'remove',
              description: 'Delete a learned item.',
              options: [{ type: INTEGER, name: 'id', description: 'Item #number from the list.', required: true, min_value: 1 }],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'emoji',
          description: 'Which custom emoji members use, counted without the model.',
          options: [
            { type: SUBCOMMAND, name: 'status', description: 'Ranking size, top 10 with counts, backfill stamp.' },
            {
              type: SUBCOMMAND,
              name: 'rescan',
              description: 'Clear and recount the ranking from recent history.',
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'gifs',
          description: 'The GIF library the persona posts from, built from shared GIFs.',
          options: [
            { type: SUBCOMMAND, name: 'status', description: 'Library size, top 10 with counts, backfill stamp, GIFs posted today.' },
            {
              type: SUBCOMMAND,
              name: 'rescan',
              description: 'Reset the use counts and recount from recent history, then caption the top ones.',
            },
            { type: SUBCOMMAND, name: 'recache', description: 'Re-describe GIFs by watching them (background, per-run cap).' },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'model',
          description: 'Which model serves each role.',
          options: [
            { type: SUBCOMMAND, name: 'show', description: 'Show the model of each role.' },
            {
              type: SUBCOMMAND,
              name: 'set',
              description: 'Set the model for one role.',
              options: [
                {
                  type: STRING,
                  name: 'role',
                  description: 'Role to change.',
                  required: true,
                  choices: choicesOf(MODEL_SET_ROLES),
                },
                { type: STRING, name: 'id', description: 'OpenRouter model id.', required: true },
              ],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'route',
          description: 'Providers per model and role (llm.providerByModel).',
          options: [
            { type: SUBCOMMAND, name: 'list', description: "Every route, then each role's current model and route." },
            {
              type: SUBCOMMAND,
              name: 'set',
              description: 'Route a model prefix, for one role or any, to these providers only.',
              options: [
                { type: STRING, name: 'model', description: 'Model id or prefix, e.g. google/ (no @ or spaces).', required: true, autocomplete: true },
                { type: STRING, name: 'providers', description: 'Comma-separated provider slugs, e.g. google-vertex.', required: true },
                { type: STRING, name: 'role', description: 'Only for this role (default: any).', required: false, choices: choicesOf(ROUTE_ROLES) },
                { type: BOOLEAN, name: 'fallbacks', description: 'Allow other providers if these fail (default: false).', required: false },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'remove',
              description: "Remove a model prefix's route, for one role or any.",
              options: [
                { type: STRING, name: 'model', description: 'Model id or prefix of the route.', required: true, autocomplete: true },
                { type: STRING, name: 'role', description: "The route's role (default: any).", required: false, choices: choicesOf(ROUTE_ROLES) },
              ],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'warmup',
          description: 'Memory warmup from a recent sample: channels, people, server.',
          options: [
            { type: SUBCOMMAND, name: 'people', description: 'Who qualifies for the sample now.' },
            { type: SUBCOMMAND, name: 'run', description: 'Start or resume the run: channels, people, then server.' },
            { type: SUBCOMMAND, name: 'stop', description: 'Cancel warmup work in flight, the current model call included.' },
            {
              type: SUBCOMMAND,
              name: 'users',
              description: '(Re)profile one member now, or all qualifying ones in the background.',
              options: [
                {
                  type: USER,
                  name: 'user',
                  description: 'Member (omit for everyone, in the background).',
                  required: false,
                },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'channels',
              description: '(Re)describe one channel now, or all readable ones in the background.',
              options: [
                {
                  type: CHANNEL,
                  name: 'channel',
                  description: 'Channel (omit for every channel, in the background).',
                  required: false,
                  channel_types: [GUILD_TEXT],
                },
              ],
            },
            { type: SUBCOMMAND, name: 'server', description: '(Re)build the server-wide notes and lore now.' },
            { type: SUBCOMMAND, name: 'status', description: 'Phase, progress, tokens used and the next target.' },
            { type: SUBCOMMAND, name: 'reset', description: 'Clear warmup progress, never written memory; refused while running.' },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'mentor',
          description: 'Behaviour cases measured in a sandbox, reported to the admin channel.',
          options: [
            {
              type: SUBCOMMAND,
              name: 'add',
              description: 'Add a case: a persona message you disliked, with your comment.',
              options: [
                { type: STRING, name: 'message', description: 'Message link (or id, in this channel).', required: true },
                { type: STRING, name: 'text', description: 'Your comment, one sentence (10-1000 chars).', required: true },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'anchor',
              description: 'Add another persona message to a case, with the chat before it.',
              options: [
                { type: INTEGER, name: 'id', description: caseIdHelp, required: true, min_value: 1 },
                { type: STRING, name: 'message', description: 'Message link (or id, in this channel).', required: true },
              ],
            },
            { type: SUBCOMMAND, name: 'cases', description: 'Active cases with their state and last score.' },
            {
              type: SUBCOMMAND,
              name: 'remove',
              description: 'Retire a case; its runs and feedback are kept.',
              options: [{ type: INTEGER, name: 'id', description: caseIdHelp, required: true, min_value: 1 }],
            },
            {
              type: SUBCOMMAND,
              name: 'run',
              description: 'Measure one case now; report to the admin channel. Spends balance.',
              options: [{ type: INTEGER, name: 'id', description: caseIdHelp, required: true, min_value: 1 }],
            },
            { type: SUBCOMMAND, name: 'check', description: 'Replay stored situations of every case with a run. Spends balance.' },
            { type: SUBCOMMAND, name: 'stop', description: 'Stop the mentor run in flight, the current model call included.' },
            {
              type: SUBCOMMAND,
              name: 'show',
              description: "A case's last run: the card and the full report file.",
              options: [{ type: INTEGER, name: 'id', description: caseIdHelp, required: true, min_value: 1 }],
            },
            {
              type: SUBCOMMAND,
              name: 'wrong',
              description: 'Tell the mentor it misjudged a case; later runs read it as feedback.',
              options: [
                { type: INTEGER, name: 'id', description: caseIdHelp, required: true, min_value: 1 },
                { type: STRING, name: 'reason', description: 'Why the verdict was wrong (3-500 chars).', required: true },
              ],
            },
            { type: SUBCOMMAND, name: 'status', description: 'Switch, model, tokens today, cases by state and the run in flight.' },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'access',
          description: 'Who besides owners may run which commands.',
          options: [
            {
              type: SUBCOMMAND,
              name: 'grant',
              description: 'Open a command, group or * to everyone, a role or a user.',
              options: [
                { type: STRING, name: 'command', description: 'Command key, group name, or *.', required: true, autocomplete: true },
                { type: ROLE, name: 'role', description: 'Role (omit both for everyone).', required: false },
                { type: USER, name: 'user', description: 'User (omit both for everyone).', required: false },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'revoke',
              description: 'Revoke a command, group or * from everyone, a role or a user.',
              options: [
                { type: STRING, name: 'command', description: 'Command key, group name, or *.', required: true, autocomplete: true },
                { type: ROLE, name: 'role', description: 'Role (omit both to clear everyone).', required: false },
                { type: USER, name: 'user', description: 'User (omit both to clear everyone).', required: false },
              ],
            },
            { type: SUBCOMMAND, name: 'list', description: 'List every access grant.' },
          ],
        },
      ],
    },
  ];
}

/**
 * Every command key `/nep access` may name: every leaf `<group>.<name>` (or
 * bare top-level `<name>`) command key, and every subcommand-group name —
 * derived straight from the tree, so a new command is grantable the moment
 * it exists, with nothing to keep in sync by hand. `'*'` is a caller-known
 * constant, not part of either set. Pure — no discord.js object, no I/O.
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

const OPTION_MAPPERS = {
  status: () => ({}),
  ping: (options) => ({ role: options.getString('role') ?? undefined }),
  pings: (options) => ({ mode: options.getString('mode') ?? undefined }),
  reload: () => ({}),
  pause: () => ({}),
  resume: () => ({}),
  interject: (options) => ({ channelId: options.getChannel('channel')?.id }),
  initiate: (options) => ({ channelId: options.getChannel('channel')?.id }),
  draw: (options) => ({ text: options.getString('text', true), self: options.getBoolean('self') ?? false }),
  set: (options) => ({ path: options.getString('path', true), value: options.getString('value', true) }),
  unset: (options) => ({ path: options.getString('path', true) }),
  'rule.add': (options) => ({ text: options.getString('text', true) }),
  'rule.list': () => ({}),
  'rule.remove': (options) => ({ number: options.getInteger('number', true) }),
  'memory.show': (options) => ({
    userId: options.getUser('user', true).id,
    section: options.getString('section') ?? undefined,
    limit: options.getInteger('limit') ?? undefined,
    order: options.getString('order') ?? undefined,
  }),
  'memory.channel': (options) => ({ channelId: options.getChannel('channel')?.id }),
  'memory.server': () => ({}),
  'memory.recent': () => ({}),
  'memory.forget': (options) => ({ userId: options.getUser('user', true).id }),
  'memory.wipe': (options) => ({ confirm: options.getString('confirm', true) }),
  'memory.refresh': (options) => ({ userId: options.getUser('user', true).id }),
  'memory.affinity': (options) => ({
    userId: options.getUser('user', true).id,
    score: options.getInteger('score') ?? undefined,
    reason: options.getString('reason') ?? undefined,
  }),
  'private.show': (options) => ({ userId: options.getUser('user', true).id }),
  'private.forget': (options) => ({ userId: options.getUser('user', true).id }),
  'private.purge': (options) => ({ userId: options.getUser('user', true).id }),
  'diary.set': (options) => ({ channelId: options.getChannel('channel', true).id }),
  'diary.show': () => ({}),
  'diary.off': () => ({}),
  'diary.post': (options) => {
    const topic = options.getString('topic');
    return { kind: options.getString('kind') ?? undefined, ...(topic != null ? { topic } : {}) };
  },
  'alias.add': (options) => ({ userId: options.getUser('user', true).id, name: options.getString('name', true) }),
  'alias.remove': (options) => ({ userId: options.getUser('user', true).id, name: options.getString('name', true) }),
  'lore.add': (options) => ({
    title: options.getString('title', true),
    keys: options.getString('keys', true),
    text: options.getString('text', true),
    always: options.getBoolean('always') ?? false,
  }),
  'lore.list': (options) => ({ query: options.getString('query') ?? undefined }),
  'lore.show': (options) => ({ id: options.getString('id', true) }),
  'lore.remove': (options) => ({ id: options.getString('id', true) }),
  'learned.list': () => ({}),
  'learned.add': (options) => ({ text: options.getString('text', true) }),
  'learned.remove': (options) => ({ id: options.getInteger('id', true) }),
  'emoji.status': () => ({}),
  'emoji.rescan': () => ({}),
  'gifs.status': () => ({}),
  'gifs.rescan': () => ({}),
  'gifs.recache': () => ({}),
  'model.show': () => ({}),
  'model.set': (options) => ({ role: options.getString('role', true), id: options.getString('id', true) }),
  'route.list': () => ({}),
  'route.set': (options) => ({
    model: options.getString('model', true),
    providers: options.getString('providers', true),
    role: options.getString('role') ?? undefined,
    fallbacks: options.getBoolean('fallbacks') ?? undefined,
  }),
  'route.remove': (options) => ({ model: options.getString('model', true), role: options.getString('role') ?? undefined }),
  'warmup.people': () => ({}),
  'warmup.run': () => ({}),
  'warmup.stop': () => ({}),
  'warmup.users': (options) => ({ userId: options.getUser('user')?.id }),
  'warmup.channels': (options) => ({ channelId: options.getChannel('channel')?.id }),
  'warmup.server': () => ({}),
  'warmup.status': () => ({}),
  'warmup.reset': () => ({}),
  'mentor.add': (options) => ({ message: options.getString('message', true), text: options.getString('text', true) }),
  'mentor.anchor': (options) => ({ id: options.getInteger('id', true), message: options.getString('message', true) }),
  'mentor.cases': () => ({}),
  'mentor.remove': (options) => ({ id: options.getInteger('id', true) }),
  'mentor.run': (options) => ({ id: options.getInteger('id', true) }),
  'mentor.check': () => ({}),
  'mentor.stop': () => ({}),
  'mentor.show': (options) => ({ id: options.getInteger('id', true) }),
  'mentor.wrong': (options) => ({ id: options.getInteger('id', true), reason: options.getString('reason', true) }),
  'mentor.status': () => ({}),
  'access.grant': (options) => ({
    command: options.getString('command', true),
    roleId: options.getRole('role')?.id,
    userId: options.getUser('user')?.id,
  }),
  'access.revoke': (options) => ({
    command: options.getString('command', true),
    roleId: options.getRole('role')?.id,
    userId: options.getUser('user')?.id,
  }),
  'access.list': () => ({}),
};

function buildArgs(commandKey, interaction) {
  const mapper = OPTION_MAPPERS[commandKey];
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
 * Reply with an admin handler's result, always ephemerally: a string (chunked
 * into follow-ups when long, code-fenced when multi-line), or
 * `{ text, files: [{ attachment: Buffer, name }] }`, whose files ride on the
 * first message.
 */
async function respond(interaction, result, deferred) {
  const isObject = result !== null && typeof result === 'object';
  const body = String((isObject ? result.text : result) ?? '');
  const files = isObject && Array.isArray(result.files) && result.files.length > 0 ? result.files : null;
  const wrap = body.includes('\n');
  const chunks = chunkText(body, REPLY_CHUNK_CHARS);
  const format = (chunk) => (wrap ? `\`\`\`\n${chunk}\n\`\`\`` : chunk);
  const first = files ? { content: format(chunks[0]), files } : { content: format(chunks[0]) };

  if (deferred) {
    await interaction.editReply(first);
  } else {
    await interaction.reply({ ...first, flags: MessageFlags.Ephemeral });
  }
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: format(chunk), flags: MessageFlags.Ephemeral });
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

/** `command`-option autocomplete choices for `/nep access grant|revoke`: every known command key,
 * every group name, and `*`, filtered by the typed text. The owner-only commands
 * (src/discord/access.js#isOwnerOnly) are never offered: no grant can open them; nor is a
 * member command (src/discord/access.js#isMemberCommand), open without one. */
function accessKeyChoices(typed) {
  const { keys, groups } = commandKeys();
  const all = ['*', ...groups, ...keys].filter((key) => !isOwnerOnly(key) && !isMemberCommand(key));
  return all
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
  const models = Object.values(MODEL_SET_PATHS).map((dotted) =>
    dotted.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), config),
  );
  const all = [...new Set([...prefixes, ...models].filter((value) => typeof value === 'string' && value))];
  return all
    .filter((value) => value.toLowerCase().includes(typed))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((value) => ({ name: value, value }));
}

/**
 * `hot`, `admin` — see src/hot.js, src/admin.js#createAdmin.
 * `getGuildId` — the single guild this instance serves, or null before it resolves.
 * @returns {(interaction: import('discord.js').Interaction) => Promise<void>}
 */
export function createInteractionHandler({ hot, admin, getGuildId }) {
  async function handleAutocomplete(interaction) {
    if (interaction.guildId !== getGuildId()) return;
    const config = hot.config;
    if (config?.features?.adminCommands === false) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const commandKey = commandKeyFor(interaction);
    const allowed = admin.isAllowed(commandKey, { userId: interaction.user.id, roleIds: roleIdsFor(interaction) });
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
      await interaction.respond(accessKeyChoices(typed)).catch(() => {});
      return;
    }

    if (focused.name === 'model') {
      await interaction.respond(routeModelChoices(config, typed)).catch(() => {});
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

    const allowed = admin.isAllowed(commandKey, { userId: interaction.user.id, roleIds: roleIdsFor(interaction) });
    if (!allowed) {
      await interaction.reply({ content: NOT_ALLOWED_MESSAGE, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    const slow = SLOW_COMMANDS.has(commandKey);
    try {
      if (slow) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const args = buildArgs(commandKey, interaction);
      const context = { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id };
      const result = await admin.run(commandKey, args, context);
      await respond(interaction, result, slow);
    } catch (err) {
      log.warn('commands: command failed', { command: commandKey, error: err });
      await respond(interaction, `Error: ${err?.message ?? String(err)}`, slow).catch(() => {});
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
