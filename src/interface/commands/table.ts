// The owner's command table: every slash command of the `neptunia` chat and of `neptunia -p`, with its subcommands,
// its arguments and the line `/help` prints for it, and the parse of a typed line by that table. bin/neptunia.ts
// parses each line here before it sends anything, and src/interface/commands/console.ts runs the parsed command in
// the core. A command is added here and nowhere else.
//
// A line is the command, then its subcommand when it has them, then its arguments in order, split on spaces. The
// last argument takes the rest of the line, so a rule or a lore text keeps its spaces. A subcommand may be two words
// (`/memory lore add`), and its parsed name joins the words with dots (`memory.lore.add`). A command without a
// subcommand runs its `defaultSubcommand`, or itself when it has none, and a command marked `needsSubcommand`
// refuses the bare line. An argument with `choices` takes only those values. An argument with a `flag` is written
// `--key <word>` after the positional words, takes exactly one word, and is refused when its word is missing, when
// the flag comes twice, when another flag is typed and when a bare word is left over. A command's `check` refuses
// what the table's shape cannot say. The parse is pure and never throws.

import { BASE_ROLES, MEMORY_ROLE, SEARCH_ROLE } from '../../llm/roles.ts';
import { BACKEND_NAMES } from '../../agent-runner/profiles.ts';
import { AGENT_MODES, SUBHARNESS_AGENTS } from '../../subharness/control.ts';
import { MODEL_SET_ROLES, ROUTE_ROLES } from '../../tools/impl/catalog.ts';
import { isDay } from '../../watcher/read.ts';

/** One argument of a command, in the order the line gives them. */
export type CommandArg = { name: string; required: boolean; choices?: ReadonlyArray<string>; flag?: string };

/** One subcommand: its name (two words joined by a dot for a nested one), its help line and its arguments. */
export type Subcommand = { name: string; help: string; args: ReadonlyArray<CommandArg> };

/** One command of the table. */
export type Command = {
  name: string;
  help: string;
  args: ReadonlyArray<CommandArg>;
  subcommands: ReadonlyArray<Subcommand>;
  /** The subcommand a bare line runs. */
  defaultSubcommand?: string;
  /** The bare line is refused. */
  needsSubcommand?: boolean;
  /** The subcommand a line runs whose next word names none of `subcommands` (`/interface <name> <sub>`). */
  otherwise?: Subcommand;
  /** Why the parsed arguments are refused, or null when they stand. */
  check?: (name: string, args: Readonly<Record<string, string>>) => string | null;
};

/** What a line parses into: the command's dotted name and its arguments by name, or why the line is refused. */
export type Parsed = { ok: true; name: string; args: Record<string, unknown> } | { ok: false; reason: string };

/** The roles a route names, and `any` for a route of every role. */
const ROUTE_CHOICES: ReadonlyArray<string> = ['any', ...ROUTE_ROLES];

/** The roles a key can be bound to or checked for: the base model roles, her memory session included. */
const KEY_ROLES: ReadonlyArray<string> = [...BASE_ROLES, MEMORY_ROLE, SEARCH_ROLE];

/** The roles `/model set` names: the model roles, her memory session and the watcher, whose model is its subharness's. */
const MODEL_SET_CHOICES: ReadonlyArray<string> = [...MODEL_SET_ROLES, MEMORY_ROLE, 'watcher'];

/** A yes or no argument. */
const FLAGS: ReadonlyArray<string> = ['true', 'false'];

const arg = (name: string, required = true, choices?: ReadonlyArray<string>): CommandArg =>
  choices === undefined ? { name, required } : { name, required, choices };

/** An argument typed as `--name <word>`, after the positional words. */
const flagArg = (name: string, required: boolean): CommandArg => ({ name, required, flag: `--${name}` });

const sub = (name: string, help: string, args: ReadonlyArray<CommandArg> = []): Subcommand => ({ name, help, args });

/** The commands over the setup contract of a module (src/setup/modules.ts), the same for each kind. */
const moduleSubcommands = (kind: string): ReadonlyArray<Subcommand> => [
  sub('setup', `Set up a ${kind} step by step`, [arg('name')]),
  sub('settings', `Show ${kind} settings with secrets hidden`, [arg('name')]),
  sub('set', `Change a ${kind} setting, asking for secrets privately`, [arg('name'), arg('key'), arg('value', false)]),
  sub('clear', `Clear a ${kind} setting`, [arg('name'), arg('key')]),
  sub('add', `Add an item to a ${kind} list setting`, [arg('name'), arg('key'), arg('value')]),
  sub('remove', `Remove an item from a ${kind} list setting`, [arg('name'), arg('key'), arg('value')]),
];

/** The words `/logs` takes after the command: `errors`, `follow` and `since <value>`. */
function checkLogs(_name: string, args: Readonly<Record<string, string>>): string | null {
  const words = (args.options ?? '').split(' ').filter((word) => word !== '');
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === 'errors' || word === 'follow') continue;
    if (word === 'since' && words[i + 1] !== undefined) {
      i += 1;
      continue;
    }
    return word === 'since' ? '/logs since needs a value, such as "1 hour ago"' : `/logs does not take "${word}"`;
  }
  return null;
}

/** The date of `/report`: none (the latest report) or a real date written YYYY-MM-DD. */
function checkReportDay(_name: string, args: Readonly<Record<string, string>>): string | null {
  const day = args.day;
  return day === undefined || isDay(day) ? null : `/report takes a date written YYYY-MM-DD, not "${day}"`;
}

/** The target of `/tools grant` and `/tools revoke`: none (her), `everyone`, `role <id>` or `user <id>`. */
function checkTarget(name: string, args: Readonly<Record<string, string>>): string | null {
  if (name !== 'tools.grant' && name !== 'tools.revoke') return null;
  const target = args.target ?? '';
  if (target === '' || target === 'everyone' || /^(role|user) \S+$/.test(target)) return null;
  return `the target is everyone, role <id> or user <id>, not "${target}"`;
}

/** The commands of the chat, in the order `/help` lists them. */
export const COMMANDS: ReadonlyArray<Command> = [
  {
    name: 'status',
    help: 'Show core, memory and connection status',
    args: [],
    subcommands: [
      sub('brief', 'Show core, memory and connection status as JSON'),
      sub('full', 'Show detailed status, model assignments and today’s costs'),
    ],
  },
  {
    name: 'doctor',
    help: 'Check installation health and configuration',
    args: [],
    subcommands: [sub('live', 'Check installation health and send a test request for every model role')],
  },
  {
    name: 'health',
    help: 'Check the server, core or memory service',
    args: [arg('part', false, ['server', 'core', 'memory'])],
    subcommands: [],
  },
  {
    name: 'logs',
    help: 'Read service logs, filter errors or follow new entries',
    args: [arg('options', false)],
    subcommands: [],
    check: checkLogs,
  },
  {
    name: 'report',
    help: 'Read the latest project watcher report or choose a date',
    args: [arg('day', false)],
    subcommands: [],
    check: checkReportDay,
  },
  {
    name: 'usage',
    help: 'Show token usage, costs and remaining key allowances',
    args: [arg('window', false, ['7d', '30d'])],
    subcommands: [],
  },
  {
    name: 'errands',
    help: 'Inspect or cancel tasks delegated to agents',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'Show latest errands'),
      sub('show', 'Show one errand', [arg('id')]),
      sub('cancel', 'Cancel an open errand', [arg('id')]),
    ],
  },
  {
    name: 'intentions',
    help: 'Inspect or cancel the persona’s plans',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'Show open intentions'),
      sub('show', 'Show one open intention', [arg('id')]),
      sub('cancel', 'Cancel an intention', [arg('id')]),
    ],
  },
  {
    name: 'wakes',
    help: 'Inspect scheduled autonomous turns or stop and restart them',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'Show next wakes and the last ones'),
      sub('stop', 'Stop the inner life: no wake runs, the queued ones are dropped'),
      sub('start', 'Let the inner life run again'),
    ],
  },
  {
    name: 'pause',
    help: 'Pause new turns while active turns finish and incoming messages wait',
    args: [],
    subcommands: [],
  },
  {
    name: 'resume',
    help: 'Resume turns and process messages held during the pause',
    args: [],
    subcommands: [],
  },
  {
    name: 'config',
    help: 'Browse and edit personal settings',
    args: [],
    defaultSubcommand: 'show',
    subcommands: [
      sub('get', 'Show live value of one setting', [arg('path')]),
      sub('set', 'Save a personal setting', [arg('path'), arg('value')]),
      sub('unset', 'Restore a setting to its default', [arg('path')]),
      sub('show', 'Show saved personal settings as JSON'),
      sub('check', 'Find unknown settings and values with the wrong type'),
    ],
  },
  {
    name: 'model',
    help: 'Choose the model and reasoning effort for each role',
    args: [],
    defaultSubcommand: 'show',
    subcommands: [
      sub('show', 'Show model of every model role'),
      sub('set', 'Choose a role’s model, test it with one reply and optionally set provider, effort or runtime', [
        arg('role', true, MODEL_SET_CHOICES),
        arg('model', false),
        flagArg('provider', false),
        flagArg('effort', false),
        flagArg('via', false),
      ]),
    ],
  },
  {
    name: 'route',
    help: 'Choose which providers serve each model',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'Every route, then the model and route of each role'),
      sub('set', 'Route a model prefix to these comma-separated providers only, for one role or any', [
        arg('model'),
        arg('providers'),
        arg('role', false, ROUTE_CHOICES),
        arg('fallbacks', false, FLAGS),
        arg('byok', false, FLAGS),
      ]),
      sub('remove', "Remove a model prefix's route, for one role or any", [
        arg('model'),
        arg('role', false, ROUTE_CHOICES),
      ]),
    ],
  },
  {
    name: 'memory',
    help: 'Search memories, inspect people and link their accounts',
    args: [],
    needsSubcommand: true,
    subcommands: [
      sub('profile', "A member's profile: profile <user> [section]", [arg('user'), arg('section', false)]),
      sub('conversation', "A conversation's newest stored lines", [arg('conversation')]),
      sub('recent', 'Show live recent lines'),
      sub('affinity', "A member's affinity", [arg('user')]),
      sub('search', 'Search her memory', [arg('query')]),
      sub('backup', 'Make a backup of the memory database and list the kept ones'),
      sub('restore', 'Bring an archived item back', [arg('id')]),
      sub('journal', 'Show journal of a day: journal [<YYYY-MM-DD>]', [arg('day', false)]),
      sub('private', "A member's private memory", [arg('user')]),
      sub('archive', 'List archived memory items', [arg('kind', false)]),
      sub('server', 'Show server notes'),
      sub('lore.add', 'Add a lore entry: lore add <title> <keys> <text>', [arg('title'), arg('keys'), arg('text')]),
      sub('lore.list', 'Show lore entries', [arg('query', false)]),
      sub('lore.show', 'Show one lore entry', [arg('id')]),
      sub('lore.remove', 'Remove a lore entry', [arg('id')]),
      sub('bind', 'Link accounts to one person, to the persona with self, or to the owner with owner', [
        arg('iface'),
        arg('account'),
        arg('target'),
        arg('targetAccount', false),
      ]),
      sub('unbind', 'Unlink an account from its shared person', [arg('iface'), arg('account')]),
      sub('accounts', 'Show accounts of the person an account belongs to', [arg('iface'), arg('account')]),
      sub('aliases.add', "Confirm a member's alias", [arg('user'), arg('name')]),
      sub('aliases.list', "A member's aliases", [arg('user')]),
      sub('aliases.remove', "Remove a member's alias", [arg('user'), arg('name')]),
      sub('lessons.add', 'Add a lesson', [arg('text')]),
      sub('lessons.list', 'Show lessons'),
      sub('lessons.remove', 'Remove a lesson by its number', [arg('id')]),
    ],
  },
  {
    name: 'rules',
    help: 'Manage the owner’s instructions for the persona',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('add', 'Add a rule', [arg('text')]),
      sub('list', 'Show rules'),
      sub('remove', 'Remove a rule by its number', [arg('number')]),
    ],
  },
  {
    name: 'tools',
    help: 'Inspect available tools and manage who may use them',
    args: [],
    defaultSubcommand: 'list',
    check: checkTarget,
    subcommands: [
      sub('list', 'Every tool and whether she has it'),
      sub('describe', 'Show one tool or one family in full', [arg('tool')]),
      sub('grant', 'Grant tool access to the persona, everyone, a role or a person', [
        arg('tool'),
        arg('target', false),
      ]),
      sub('revoke', 'Revoke tool access from the persona, everyone, a role or a person', [
        arg('tool'),
        arg('target', false),
      ]),
    ],
  },
  {
    name: 'skills',
    help: 'Review skill versions, activate them and manage their settings',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'Every skill with its state, who activated it and the version a rollback restores'),
      sub('show', 'Show active text and tools of one skill', [arg('name')]),
      sub('review', 'Show active version beside the pending ones, with their texts and use counts', [arg('name')]),
      sub('pending', 'Show versions waiting for an activation'),
      sub('activate', 'Make the newest pending version of a skill the active one', [arg('name')]),
      sub('rollback', 'Make the previous active version active again', [arg('name')]),
      sub('reject', 'Retire every pending version of a skill', [arg('name')]),
      sub('enable', 'Enable a disabled skill', [arg('name')]),
      sub('disable', 'Take a skill out of her list', [arg('name')]),
      ...moduleSubcommands('skill'),
    ],
  },
  {
    name: 'interface',
    help: 'Set up connections, manage credentials and enable or disable them',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'Every interface, whether it is enabled and whether it is connected'),
      sub('enable', 'Enable an interface', [arg('name')]),
      sub('disable', 'Disable an interface', [arg('name')]),
      sub('token.set', 'Save the platform token of an interface; the chat asks for it without showing it', [
        arg('name'),
      ]),
      ...moduleSubcommands('interface'),
    ],
    otherwise: sub('command', "An interface's own subcommand", [arg('name'), arg('sub'), arg('rest', false)]),
  },
  {
    name: 'search',
    help: 'Configure quick web search, its engine and model',
    args: [],
    defaultSubcommand: 'status',
    subcommands: [
      sub('status', 'Quick search: on or off, its engine, its model and the key it goes out on'),
      sub('enable', 'Turn quick search on'),
      sub('disable', 'Turn quick search off; reading a known page stays'),
      sub('engine', 'Choose the engine of quick search', [arg('name', true, ['openrouter', 'brave', 'exa'])]),
      sub('model', 'Choose the model of the openrouter engine', [arg('id')]),
    ],
  },
  {
    name: 'keys',
    help: 'Manage API keys, allowances and model role bindings',
    args: [],
    needsSubcommand: true,
    subcommands: [
      sub('core.add', 'Add a core key; the chat asks for the value without showing it', [arg('name')]),
      sub('core.remove', 'Remove a core key; the last one pauses her until the next add', [arg('name')]),
      sub('core.list', 'Show core keys with their last four characters, grants and the one in use'),
      sub('core.grant', 'Set the grant of a core key in USD and its reset day, or none to clear it', [
        arg('name'),
        arg('usd'),
        arg('day', false),
      ]),
      sub('extra.add', 'Add an extra key; the chat asks for the value without showing it', [arg('name')]),
      sub('extra.remove', 'Remove an extra key no role is bound to', [arg('name')]),
      sub('extra.list', 'Show extra keys with the roles bound to them'),
      sub('service.list', 'Show optional service keys: YouTube, Brave, Exa and the video proxy, each masked'),
      sub('service.set', 'Set one service key; the chat asks for it without showing it', [arg('name')]),
      sub('service.clear', 'Clear one service key', [arg('name')]),
      sub('bind', 'Use a named extra key for one model role', [arg('role', true, KEY_ROLES), arg('name')]),
      sub('unbind', 'Remove a role’s extra-key binding and use its default credentials', [
        arg('role', true, KEY_ROLES),
      ]),
      sub('check', 'Test a model role’s credentials with one request and show how it was billed', [
        arg('role', true, KEY_ROLES),
      ]),
    ],
  },
  {
    name: 'subharness',
    help: 'Configure agent runtimes, models and access levels',
    args: [],
    defaultSubcommand: 'status',
    subcommands: [
      sub(
        'status',
        'Show connected backends, the key of opencode by name, and the mode, backend, model and effort of every agent'
      ),
      sub('enable', 'Connect one backend after a check; opencode needs --key, the name of an extra key', [
        arg('backend', true, BACKEND_NAMES),
        flagArg('key', false),
      ]),
      sub('disable', 'Disconnect one backend; with none left every agent task is refused', [
        arg('backend', true, BACKEND_NAMES),
      ]),
      sub('use', 'Name the connected backend an agent runs through: use <agent> <backend>', [
        arg('agent'),
        arg('backend', true, BACKEND_NAMES),
      ]),
      sub('model', 'Set the model and effort of an agent after one reply from it: model <agent> <model>', [
        arg('agent', true, SUBHARNESS_AGENTS),
        arg('model'),
        flagArg('effort', false),
      ]),
      sub('mode', "Show or set an agent's mode: read, write, full or sudo", [
        arg('agent', true, SUBHARNESS_AGENTS),
        arg('mode', false, AGENT_MODES),
      ]),
    ],
  },
  {
    name: 'simulation',
    help: 'Control paid test runs and the key they use',
    args: [],
    defaultSubcommand: 'status',
    subcommands: [
      sub('status', 'Whether the simulation is on and the name of its key'),
      sub('enable', 'Allow paid test scripts to use the named extra key', [flagArg('key', true)]),
      sub('disable', 'Switch the simulation off: the scripts refuse to run'),
    ],
  },
  { name: 'help', help: 'Browse commands and their descriptions', args: [], subcommands: [] },
  { name: 'clear', help: 'Clear the conversation display without deleting stored memory', args: [], subcommands: [] },
];

const refuse = (reason: string): Parsed => ({ ok: false, reason });

/** The subcommand the words starting at `words[0]` name, with how many words it took; null when none. */
function subcommandOf(command: Command, words: ReadonlyArray<string>): { found: Subcommand; used: number } | null {
  const [first, second] = words;
  if (first === undefined) return null;
  const nested =
    second === undefined ? undefined : command.subcommands.find((one) => one.name === `${first}.${second}`);
  if (nested !== undefined) return { found: nested, used: 2 };
  const flat = command.subcommands.find((one) => one.name === first);
  return flat === undefined ? null : { found: flat, used: 1 };
}

/** The usage of `name` with `args`, as the owner types it. */
function usageOf(name: string, args: ReadonlyArray<CommandArg>): string {
  const words = args.map((one) => {
    const word = one.flag === undefined ? `<${one.name}>` : `${one.flag} <${one.name}>`;
    return one.required ? word : `[${word}]`;
  });
  return ['/' + name.replaceAll('.', ' '), ...words].join(' ');
}

/** The words of a line split into the positional ones and the values of its flags; the reason when a flag is wrong. */
function splitFlags(
  name: string,
  args: ReadonlyArray<CommandArg>,
  words: ReadonlyArray<string>
): { positional: Array<string>; flagged: Record<string, string> } | string {
  const positional: Array<string> = [];
  const flagged: Record<string, string> = {};
  // A command without flags takes its words as they are: a rule or a lore text may hold "--".
  if (!args.some((one) => one.flag !== undefined)) return { positional: [...words], flagged };
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? '';
    if (!word.startsWith('--')) {
      positional.push(word);
      continue;
    }
    const known = args.find((one) => one.flag === word);
    if (known === undefined) return `${usageOf(name, args)}: ${word} is not an option`;
    const value = words[i + 1];
    if (value === undefined || value.startsWith('--')) return `${usageOf(name, args)}: ${word} needs a value`;
    if (Object.hasOwn(flagged, known.name)) return `${usageOf(name, args)}: ${word} is given twice`;
    flagged[known.name] = value;
    i += 1;
  }
  return { positional, flagged };
}

/** `words` read as `args`, the last positional argument taking the rest; the reason when a value is missing or not a choice. */
function argsOf(
  name: string,
  args: ReadonlyArray<CommandArg>,
  words: ReadonlyArray<string>
): Record<string, string> | string {
  const split = splitFlags(name, args, words);
  if (typeof split === 'string') return split;
  const positionalArgs = args.filter((one) => one.flag === undefined);
  const values: Record<string, string> = {};
  for (const [index, one] of positionalArgs.entries()) {
    const value =
      index === positionalArgs.length - 1 ? split.positional.slice(index).join(' ') : (split.positional[index] ?? '');
    if (value === '') {
      if (one.required) return `${usageOf(name, args)}: ${one.name} is missing`;
      continue;
    }
    if (one.choices !== undefined && !one.choices.includes(value))
      return `${usageOf(name, args)}: ${one.name} is one of ${one.choices.join(', ')}, not "${value}"`;
    values[one.name] = value;
  }
  for (const one of args.filter((arg) => arg.flag !== undefined)) {
    const value = split.flagged[one.name];
    if (value === undefined) {
      if (one.required) return `${usageOf(name, args)}: ${one.flag ?? one.name} is missing`;
      continue;
    }
    values[one.name] = value;
  }
  if (positionalArgs.length === 0 && split.positional.length > 0) return `${usageOf(name, args)} takes no bare word`;
  return values;
}

/** One typed line (`/memory lore add Tower tower,spire The tower ...`) as its command's dotted name and arguments. */
export function parseCommandLine(line: string): Parsed {
  const words = line
    .trim()
    .replace(/^\//, '')
    .split(/\s+/)
    .filter((word) => word !== '');
  const [first, ...rest] = words;
  if (first === undefined) return refuse('an empty line is no command; type /help');
  const command = COMMANDS.find((one) => one.name === first);
  if (command === undefined) return refuse(`unknown command /${first}; type /help`);
  let name = command.name;
  let args = command.args;
  let tail: ReadonlyArray<string> = rest;
  if (command.subcommands.length > 0) {
    const picked = subcommandOf(command, rest);
    const names = command.subcommands.map((one) => one.name.replaceAll('.', ' ')).join(', ');
    if (picked !== null) {
      name = `${command.name}.${picked.found.name}`;
      args = picked.found.args;
      tail = rest.slice(picked.used);
    } else if (rest.length === 0 && command.defaultSubcommand !== undefined) {
      const fallback = command.subcommands.find((one) => one.name === command.defaultSubcommand);
      name = `${command.name}.${command.defaultSubcommand}`;
      args = fallback?.args ?? [];
    } else if (rest.length === 0 && command.needsSubcommand === true) {
      return refuse(`/${command.name} needs a subcommand: ${names}`);
    } else if (rest.length > 0 && command.otherwise !== undefined) {
      name = `${command.name}.${command.otherwise.name}`;
      args = command.otherwise.args;
    } else if (rest.length > 0) {
      return refuse(`/${command.name} has no subcommand "${rest[0] ?? ''}": ${names}`);
    }
  }
  const values = argsOf(name, args, tail);
  if (typeof values === 'string') return refuse(values);
  const refused = command.check?.(name, values) ?? null;
  return refused === null ? { ok: true, name, args: values } : refuse(refused);
}
