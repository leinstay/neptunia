// The owner's command table: every slash command of the `neptunia` chat and of `neptunia -p`, with its subcommands,
// its arguments and the line `/help` prints for it, and the parse of a typed line by that table. bin/neptunia.ts
// parses each line here before it sends anything, and src/interface/commands/console.ts runs the parsed command in
// the core. A command is added here and nowhere else.
//
// A line is the command, then its subcommand when it has them, then its arguments in order, split on spaces. The
// last argument takes the rest of the line, so a rule or a lore text keeps its spaces. A subcommand may be two words
// (`/memory lore add`), and its parsed name joins the words with dots (`memory.lore.add`). A command without a
// subcommand runs its `defaultSubcommand`, or itself when it has none, and a command marked `needsSubcommand`
// refuses the bare line. An argument with `choices` takes only those values. A command's `check` refuses what the
// table's shape cannot say. The parse is pure and never throws.

/** One argument of a command, in the order the line gives them. */
export type CommandArg = { name: string; required: boolean; choices?: ReadonlyArray<string> };

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

const arg = (name: string, required = true, choices?: ReadonlyArray<string>): CommandArg =>
  choices === undefined ? { name, required } : { name, required, choices };

const sub = (name: string, help: string, args: ReadonlyArray<CommandArg> = []): Subcommand => ({ name, help, args });

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
    help: 'the short summary; full: every section of the status card',
    args: [],
    subcommands: [sub('full', 'every section of the status card, with the models and the costs of the day')],
  },
  {
    name: 'doctor',
    help: 'the checks of the installation; live: the providers probed by the core too',
    args: [],
    subcommands: [sub('live', 'the checks, and one probe of every model role by the core')],
  },
  {
    name: 'health',
    help: 'the health of the server, the core or the memory, or all three',
    args: [arg('part', false, ['server', 'core', 'memory'])],
    subcommands: [],
  },
  {
    name: 'logs',
    help: 'the core unit journal: /logs [errors] [since <value>] [follow]',
    args: [arg('options', false)],
    subcommands: [],
    check: checkLogs,
  },
  {
    name: 'usage',
    help: 'costs and tokens by model group, role and interface, and the key limits: /usage [7d|30d]',
    args: [arg('window', false, ['7d', '30d'])],
    subcommands: [],
  },
  {
    name: 'errands',
    help: "the persona's errands: list, show <id>, cancel <id>",
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'the latest errands'),
      sub('show', 'one errand', [arg('id')]),
      sub('cancel', 'cancel an open errand', [arg('id')]),
    ],
  },
  {
    name: 'intentions',
    help: "the persona's open intentions: list, show <id>, cancel <id>",
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'the open intentions'),
      sub('show', 'one open intention', [arg('id')]),
      sub('cancel', 'cancel an intention', [arg('id')]),
    ],
  },
  { name: 'wakes', help: 'the next wakes and the last ones', args: [], subcommands: [] },
  {
    name: 'pause',
    help: 'stop admission; active turns finish, messages are kept for the resume',
    args: [],
    subcommands: [],
  },
  {
    name: 'resume',
    help: 'end the pause; each message kept meanwhile reaches the persona once',
    args: [],
    subcommands: [],
  },
  {
    name: 'config',
    help: 'the live settings: get <path>, set <path> <value>, unset <path>, show',
    args: [],
    defaultSubcommand: 'show',
    subcommands: [
      sub('get', 'the live value of one setting', [arg('path')]),
      sub('set', 'override one setting in config.local.json', [arg('path'), arg('value')]),
      sub('unset', 'remove one override from config.local.json', [arg('path')]),
      sub('show', 'config.local.json as it is'),
    ],
  },
  { name: 'model', help: 'the model of every model role', args: [], subcommands: [] },
  { name: 'route', help: 'the provider routes', args: [], subcommands: [] },
  {
    name: 'memory',
    help: 'the reads over her memory, the backups and the items the owner edits by hand',
    args: [],
    needsSubcommand: true,
    subcommands: [
      sub('profile', "a member's profile: profile <user> [section]", [arg('user'), arg('section', false)]),
      sub('conversation', "a conversation's newest stored lines", [arg('conversation')]),
      sub('recent', 'the live recent lines'),
      sub('affinity', "a member's affinity", [arg('user')]),
      sub('search', 'search her memory', [arg('query')]),
      sub('backup', 'make a backup of the memory database and list the kept ones'),
      sub('restore', 'bring an archived item back', [arg('id')]),
      sub('journal', 'the journal of a day: journal [<YYYY-MM-DD>]', [arg('day', false)]),
      sub('private', "a member's private memory", [arg('user')]),
      sub('archive', 'what left hot memory', [arg('kind', false)]),
      sub('server', 'the server notes'),
      sub('lore.add', 'add a lore entry: lore add <title> <keys> <text>', [arg('title'), arg('keys'), arg('text')]),
      sub('lore.list', 'the lore entries', [arg('query', false)]),
      sub('lore.show', 'one lore entry', [arg('id')]),
      sub('lore.remove', 'remove a lore entry', [arg('id')]),
      sub('aliases.add', "confirm a member's alias", [arg('user'), arg('name')]),
      sub('aliases.list', "a member's aliases", [arg('user')]),
      sub('aliases.remove', "remove a member's alias", [arg('user'), arg('name')]),
      sub('lessons.add', 'add a lesson', [arg('text')]),
      sub('lessons.list', 'the lessons'),
      sub('lessons.remove', 'remove a lesson by its number', [arg('id')]),
    ],
  },
  {
    name: 'rules',
    help: "the owner's live rules: add <text>, list, remove <number>",
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('add', 'add a rule', [arg('text')]),
      sub('list', 'the rules'),
      sub('remove', 'remove a rule by its number', [arg('number')]),
    ],
  },
  {
    name: 'tools',
    help: 'her tools and their rights: list, describe <tool>, grant <tool> [target], revoke <tool> [target]',
    args: [],
    defaultSubcommand: 'list',
    check: checkTarget,
    subcommands: [
      sub('list', 'every tool and whether she has it'),
      sub('describe', 'one tool or one family in full', [arg('tool')]),
      sub('grant', 'open a tool to her, or to everyone, role <id> or user <id>', [arg('tool'), arg('target', false)]),
      sub('revoke', 'close a tool to her, or to everyone, role <id> or user <id>', [arg('tool'), arg('target', false)]),
    ],
  },
  {
    name: 'interface',
    help: 'the interfaces: list, enable <name>, disable <name>, <name> <sub>',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'every interface, whether it is enabled and whether it is connected'),
      sub('enable', 'enable an interface', [arg('name')]),
      sub('disable', 'disable an interface', [arg('name')]),
    ],
    otherwise: sub('command', "an interface's own subcommand", [arg('name'), arg('sub'), arg('rest', false)]),
  },
  { name: 'help', help: 'this list', args: [], subcommands: [] },
  { name: 'clear', help: 'clear the screen', args: [], subcommands: [] },
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
  const words = args.map((one) => (one.required ? `<${one.name}>` : `[${one.name}]`));
  return ['/' + name.replaceAll('.', ' '), ...words].join(' ');
}

/** `words` read as `args`, the last argument taking the rest; the reason when a value is missing or not a choice. */
function argsOf(
  name: string,
  args: ReadonlyArray<CommandArg>,
  words: ReadonlyArray<string>
): Record<string, string> | string {
  const values: Record<string, string> = {};
  for (const [index, one] of args.entries()) {
    const value = index === args.length - 1 ? words.slice(index).join(' ') : (words[index] ?? '');
    if (value === '') {
      if (one.required) return `${usageOf(name, args)}: ${one.name} is missing`;
      continue;
    }
    if (one.choices !== undefined && !one.choices.includes(value))
      return `${usageOf(name, args)}: ${one.name} is one of ${one.choices.join(', ')}, not "${value}"`;
    values[one.name] = value;
  }
  if (args.length === 0 && words.length > 0) return `${usageOf(name, args)} takes no argument`;
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
