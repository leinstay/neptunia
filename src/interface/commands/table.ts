// The owner's command table: every slash command of the `neptunia` chat and of `neptunia -p`, with its subcommands,
// its arguments and the line `/help` prints for it, and the parse of a typed line by that table. bin/neptunia.ts
// parses each line here before it sends anything, and src/interface/commands/console.ts runs the parsed command in
// the core. A command is added here and nowhere else.
//
// A line is the command, then its subcommand when it has them, then its arguments in order, split on spaces. The
// `neptunia <words...>` form hands the same parse the words of argv, which it never joins or splits, so a word keeps
// its spaces, its quotes and its dollar signs. The last argument takes the rest of the words joined by one space, so a
// rule or a lore text keeps its spaces. A subcommand may be up to three words
// (`/memory places lore add`), and its parsed name joins the words with dots (`memory.places.lore.add`). A command without a
// subcommand runs its `defaultSubcommand`, or itself when it has none, and a command marked `needsSubcommand`
// refuses the bare line. An argument with `choices` takes only those values. An argument with a `flag` is written
// `--key <word>` after the positional words, takes exactly one word, and is refused when its word is missing, when
// the flag comes twice, when another flag is typed and when a bare word is left over. A `bare` flag may stand alone, with
// the word `true` as its value. A command's `check` refuses
// what the table's shape cannot say. A leaf whose `secret` is `only` takes a secret through its question alone, so a
// word past its arguments is refused and not echoed. A leaf with any `secret` takes `--secret-stdin` in the command
// line. A word the table no longer has is refused with the command that replaced it, and nothing runs. A command with
// both `args` and subcommands reads a line that names none of them as its own arguments. The parse is pure and never throws.

import { BASE_ROLES, MEMORY_ROLE, SEARCH_ROLE } from '../../llm/roles.ts';
import { BACKEND_NAMES } from '../../agent-runner/profiles.ts';
import { AGENT_MODES, SUBHARNESS_AGENTS } from '../../subharness/control.ts';
import { SERVICE_NAMES, setupRefusal } from '../../service/schedule.ts';
import { MODEL_SET_ROLES, ROUTE_ROLES } from '../../tools/impl/catalog.ts';

/** One argument of a command, in the order the line gives them. */
export type CommandArg = {
  name: string;
  required: boolean;
  choices?: ReadonlyArray<string>;
  flag?: string;
  /** The flag may stand alone, with the word `true` as its value. */
  bare?: boolean;
};

/** One subcommand: its name (two words joined by a dot for a nested one), its help line and its arguments. */
export type Subcommand = {
  name: string;
  help: string;
  args: ReadonlyArray<CommandArg>;
  /** The leaf asks for a secret: `only` when the secret is its whole point, `offered` when a setting may turn out to be one. */
  secret?: 'only' | 'offered';
};

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
  /** The subcommand a line runs whose next word names none of `subcommands` (`/interfaces <name> <sub>`). */
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

/** The roles `/model set` names: the model roles, her memory session and the agents, whose models are their subharnesses'. */
const MODEL_SET_CHOICES: ReadonlyArray<string> = [...new Set([...MODEL_SET_ROLES, MEMORY_ROLE, ...SUBHARNESS_AGENTS])];

/** A yes or no argument. */
const FLAGS: ReadonlyArray<string> = ['true', 'false'];

const arg = (name: string, required = true, choices?: ReadonlyArray<string>): CommandArg =>
  choices === undefined ? { name, required } : { name, required, choices };

/** An argument typed as `--name <word>`, after the positional words. */
const flagArg = (name: string, required: boolean): CommandArg => ({ name, required, flag: `--${name}` });

/** An argument typed as `--name`, which needs no word: alone, its value is the word `true`. */
const bareFlagArg = (name: string): CommandArg => ({ name, required: false, flag: `--${name}`, bare: true });

const sub = (name: string, help: string, args: ReadonlyArray<CommandArg> = []): Subcommand => ({ name, help, args });

/** A leaf whose one purpose is a secret, or one that may ask for a secret. */
const secretSub = (one: Subcommand, secret: 'only' | 'offered'): Subcommand => ({ ...one, secret });

/** The commands over the setup contract of a module (src/setup/modules.ts), the same for each kind. */
const moduleSubcommands = (kind: string): ReadonlyArray<Subcommand> => [
  secretSub(sub('setup', `Set up a ${kind} step by step`, [arg('name')]), 'offered'),
  sub('settings', `Show ${kind} settings with secrets hidden`, [arg('name')]),
  secretSub(
    sub('set', `Change a ${kind} setting, asking for secrets privately`, [
      arg('name'),
      arg('key'),
      arg('value', false),
    ]),
    'offered'
  ),
  sub('clear', `Clear a ${kind} setting`, [arg('name'), arg('key')]),
  sub('add', `Add an item to a ${kind} list setting`, [arg('name'), arg('key'), arg('value')]),
  sub('remove', `Remove an item from a ${kind} list setting`, [arg('name'), arg('key'), arg('value')]),
];

/** The account commands of one subharness: opencode's login names the extra key it runs on, the others have a vendor's. */
const accountSubcommands = (backend: string): ReadonlyArray<Subcommand> => [
  sub(
    `${backend}.login`,
    `Log ${backend} in, offering to install it first`,
    backend === 'opencode' ? [flagArg('key', false)] : []
  ),
  sub(`${backend}.status`, `Show whether ${backend} is installed and logged in, with no model request`),
  sub(`${backend}.logout`, `Log ${backend} out; a role that chose it stays on it, unavailable`),
];

/** The words of the journal, which a report selector never shares with it. */
const JOURNAL_WORDS: ReadonlyArray<string> = ['errors', 'follow', 'since'];

/** The words `/logs` takes after the command: `errors`, `follow` and `since <value>`, or the selector of `/logs watcher`. */
function checkLogs(name: string, args: Readonly<Record<string, string>>): string | null {
  if (name === 'logs.watcher') {
    const [first] = (args.target ?? '').split(' ');
    if (first === undefined || !JOURNAL_WORDS.includes(first)) return null;
    return `/logs watcher takes a date or a run; "${first}" belongs to /logs, which reads the journal`;
  }
  const words = (args.options ?? '').split(' ').filter((word) => word !== '');
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === 'errors' || word === 'follow') continue;
    if (word !== 'since') return `/logs does not take "${word}"`;
    // The value is every word up to the next keyword, as bin/neptunia.ts hands it to journalctl.
    const start = i + 1;
    while (i + 1 < words.length && words[i + 1] !== 'errors' && words[i + 1] !== 'follow') i += 1;
    if (i < start) return '/logs since needs a value, such as "1 hour ago"';
  }
  return null;
}

/** The flags of `services <name> setup`: one mode, a real schedule, and the jitter only where it means something. */
function checkService(name: string, args: Readonly<Record<string, string>>): string | null {
  const [, mechanic, action] = name.split('.');
  if (action !== 'setup') return null;
  const refused = setupRefusal(mechanic ?? '', args);
  return refused === null ? null : `/services ${mechanic ?? ''} setup: ${refused}`;
}

/** The leaves of `services`: the list, the four actions of each mechanic, and the operations of one watcher run. */
const SERVICE_SUBCOMMANDS: ReadonlyArray<Subcommand> = [
  sub('list', 'Show the four mechanics, each as its status shows it'),
  ...SERVICE_NAMES.flatMap((name) => [
    sub(`${name}.setup`, `Set when ${name} runs, leaving it on or off as it is`, [
      flagArg('at', false),
      flagArg('every', false),
      ...(name === 'heartbeat' ? [flagArg('jitter', false)] : []),
    ]),
    sub(`${name}.enable`, `Permit scheduled runs of ${name}`),
    sub(`${name}.disable`, `Prevent new runs of ${name}; one already running finishes`),
    sub(`${name}.status`, `Show ${name}: enabled, running, ready, schedule, next time and last result`),
  ]),
  sub('watcher.trigger', 'Run one watcher inspection now'),
  sub('watcher.cancel', 'Cancel the active watcher inspection, leaving the schedule as it is'),
  sub('watcher.evidence', 'Read the recorded requests and transcripts of the observation window as JSON', [
    flagArg('from', false),
    flagArg('cursor', false),
  ]),
  sub('watcher.select', 'Read the memory database with one read-only statement, as JSON', [flagArg('sql', true)]),
];

/** The flags of a page of an owner read. */
const PAGE_FLAGS: ReadonlyArray<CommandArg> = [flagArg('limit', false), flagArg('cursor', false)];

/** The flags that choose which graph edges a read follows. */
const EDGE_FLAGS: ReadonlyArray<CommandArg> = [
  flagArg('predicates', false),
  flagArg('mode', false),
  flagArg('valid-at', false),
  flagArg('recorded-before', false),
];

/** The families with one record per id: each opens a record whole and lists every id. */
const DOMAIN_FAMILIES: ReadonlyArray<string> = [
  'sources',
  'claims',
  'descriptions',
  'episodes',
  'diary',
  'media',
  'publications',
  'grants',
  'sessions',
  'requests',
  'turns',
];

/** The owner's browser of memory (src/interface/commands/memory.ts), each read answering JSON. */
const MEMORY_BROWSER: ReadonlyArray<Subcommand> = [
  sub('users.list', 'List people, unlinked accounts and anonymous participants', [
    flagArg('name', false),
    flagArg('interface', false),
    flagArg('authority', false),
    ...PAGE_FLAGS,
  ]),
  sub('users.show', 'Show a person: names, accounts, links, merges, relationship and exact records', [arg('person')]),
  sub('users.accounts', 'Show the accounts of a person and every link with its window', [arg('person')]),
  sub('users.names', 'Show the names on record for a person', [arg('person')]),
  sub('users.names.add', "Confirm a member's alias", [arg('user'), arg('name')]),
  sub('users.names.remove', "Remove a member's alias", [arg('user'), arg('name')]),
  sub('users.relationship', 'Show the affinity of a person with its history', [arg('person')]),
  sub('users.private', 'Show the private memory of a person across their DMs', [arg('person')]),
  sub('users.link', 'Link an account to a person', [arg('person'), arg('account')]),
  sub('users.unlink', 'Unlink an account from a person', [arg('person'), arg('account')]),
  sub('users.merge', 'Merge a person into another, moving everything stored about them', [
    arg('from'),
    arg('into'),
    flagArg('reason', false),
  ]),
  sub('places.list', 'List places of any kind and depth', [
    flagArg('interface', false),
    flagArg('authority', false),
    bareFlagArg('roots'),
    ...PAGE_FLAGS,
  ]),
  sub('places.tree', 'Show everything under a place with its depth, and any cycle', [
    arg('place'),
    flagArg('limit', false),
  ]),
  sub('places.show', 'Show a place, with --include-children its descendants and their descriptions too', [
    arg('place'),
    bareFlagArg('include-children'),
  ]),
  sub('places.lore', 'Show the lore records of a place by id', [arg('place')]),
  sub('places.lore.add', 'Add a lore entry to a place', [arg('place'), arg('title'), arg('keys'), arg('text')]),
  sub('places.lore.list', 'Show the lore entries of a place', [arg('place'), arg('query', false)]),
  sub('places.lore.show', 'Show one lore entry of a place', [arg('place'), arg('id')]),
  sub('places.lore.remove', 'Remove a lore entry from a place', [arg('place'), arg('id')]),
  sub('graph.kinds', 'List node kinds and predicates with their counts, deferred ones as deferred'),
  sub('graph.nodes', 'List every graph node', [flagArg('kinds', false), ...PAGE_FLAGS]),
  sub('graph.edges', 'List every graph edge', [...EDGE_FLAGS, ...PAGE_FLAGS]),
  sub('graph.node', 'Show a node: its typed record, witnesses and edge counts', [arg('node')]),
  sub('graph.neighbors', 'List the edges at a node', [
    arg('node'),
    flagArg('direction', false),
    ...EDGE_FLAGS,
    ...PAGE_FLAGS,
  ]),
  sub('graph.walk', 'Walk from nodes, each visited once, leaving a frontier at the bounds', [
    arg('nodes-from'),
    flagArg('direction', false),
    ...EDGE_FLAGS,
    flagArg('depth', false),
    flagArg('nodes', false),
    flagArg('cursor', false),
  ]),
  sub('graph.path', 'Find the shortest association between two nodes; it is read and never remembered', [
    arg('from'),
    arg('to'),
    flagArg('direction', false),
    ...EDGE_FLAGS,
    flagArg('depth', false),
  ]),
  sub('inspect.tables', 'List every table of the database with its class', [flagArg('snapshot', false)]),
  sub('inspect.schema', 'Show the columns, keys, indexes and triggers of a table', [
    arg('table'),
    flagArg('snapshot', false),
  ]),
  sub('inspect.rows', 'Read the rows of any table by page', [
    arg('table'),
    flagArg('snapshot', false),
    ...PAGE_FLAGS,
    flagArg('filters', false),
  ]),
  sub('inspect.row', 'Read one row by the locator its page gave', [
    arg('table'),
    arg('locator'),
    flagArg('snapshot', false),
  ]),
  sub('inspect.value', 'Read a large value of a row from a byte offset', [
    arg('table'),
    arg('locator'),
    arg('column'),
    flagArg('snapshot', false),
    flagArg('offset', false),
  ]),
  sub('inspect.export', 'Write every table of one snapshot to a new JSONL file at mode 0600', [arg('file')]),
  sub('inspect.close', 'Close a snapshot', [arg('snapshot')]),
  ...DOMAIN_FAMILIES.flatMap((family) => [
    sub(`${family}.show`, `Open one record of ${family} with every stored field and its links`, [arg('id')]),
    sub(`${family}.list`, `List the ids of ${family}`, PAGE_FLAGS),
  ]),
  sub('claims.versions', 'Open every version of a claim in order of recording', [arg('id')]),
  sub('claims.version', 'Open one version of a claim', [arg('id')]),
  sub('descriptions.versions', 'Open every version of a description in order of writing', [arg('id')]),
  sub('descriptions.version', 'Open one version of a description', [arg('id')]),
];

/** The commands the plural families, `/logs watcher` and `/doctor` replaced: what each is refused with, by the words after it. */
const RETIRED_COMMANDS: Readonly<Record<string, (rest: ReadonlyArray<string>) => string>> = {
  service: ([first, second]) =>
    first === 'watcher' && second === 'report'
      ? 'logs watcher'
      : ['services', ...(first === undefined ? [] : [first]), ...(second === undefined ? [] : [second])].join(' '),
  health: ([part]) => (part === 'server' || part === 'core' || part === 'memory' ? `doctor ${part}` : 'doctor'),
  wakes: ([word]) => {
    if (word === 'stop') return 'pause for all of it, or neptunia services <name> disable for one';
    if (word === 'start') return 'resume for all of it, or neptunia services <name> enable for one';
    return 'services list';
  },
  report: () => 'logs watcher',
  route: () => 'routes',
  interface: () => 'interfaces',
  task: () => 'tasks',
  watcher: () => 'services watcher',
  heartbeat: () => 'services heartbeat',
  selfreflection: () => 'services selfreflection',
  selfimprovement: () => 'services selfimprovement',
};

/** What replaced each retired leaf of `/memory`, which is refused and runs nothing. */
const RETIRED_MEMORY: Readonly<Record<string, string>> = {
  profile: '/memory users show <person>',
  accounts: '/memory users accounts <person>',
  unbind: '/memory users unlink <person> <account>',
  aliases: '/memory users names <person>',
  affinity: '/memory users relationship <person>',
  private: '/memory users private <person>',
  server: '/memory places show <place> --include-children',
  lore: '/memory places lore <place>',
  person: '/memory places show <place>',
};

/** What replaced each retired word of the `subharness` family; `next` is the word after it on the line. */
const RETIRED_SUBHARNESS: Readonly<Record<string, (next: string | undefined) => string>> = {
  use: () => '/model set <agent> <model> --via <backend>',
  model: () => '/model set <agent> <model> [--via <backend>] [--effort <effort>]',
  mode: () => '/agent mode <agent> [<mode>]',
  enable: (next) => `/subharness ${next ?? '<backend>'} login`,
  disable: (next) => `/subharness ${next ?? '<backend>'} logout`,
};

/** Whether `word` is a command a later name replaced. */
export const isRetiredCommand = (word: string): boolean => Object.hasOwn(RETIRED_COMMANDS, word);

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
      sub('readiness', 'Show the core model and memory health a chat launch reads, as JSON, with no model request'),
      sub('full', 'Show detailed status, model assignments and today’s costs'),
    ],
  },
  {
    name: 'doctor',
    help: 'Check installation health and configuration, and the running server, core and memory',
    args: [],
    subcommands: [
      sub('server', 'Check the server the core runs on, with no model request'),
      sub('core', 'Check the core’s recent turns and failures, with no model request'),
      sub('memory', 'Check the memory database and its backups, with no model request'),
      sub('live', 'Check installation health and send a test request for every model role'),
    ],
  },
  {
    name: 'logs',
    help: 'Read service logs, filter errors or follow new entries, or read the watcher’s reports',
    args: [arg('options', false)],
    subcommands: [
      sub('watcher', 'Read the latest watcher report, or the report of a date or a run', [arg('target', false)]),
    ],
    check: checkLogs,
  },
  {
    name: 'services',
    help: 'Schedule, switch and inspect heartbeat, selfreflection, selfimprovement and the watcher',
    args: [],
    needsSubcommand: true,
    check: checkService,
    subcommands: SERVICE_SUBCOMMANDS,
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
      sub(
        'sources',
        'Show what can serve a role, with its evidence and setup commands, as JSON, with no model request',
        [arg('role', true, MODEL_SET_CHOICES)]
      ),
      sub('set', 'Choose a role’s model and source, test it with one reply and optionally set provider or effort', [
        arg('role', true, MODEL_SET_CHOICES),
        arg('model', false),
        flagArg('provider', false),
        flagArg('effort', false),
        flagArg('via', false),
      ]),
    ],
  },
  {
    name: 'routes',
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
    help: 'Search memories, browse people, places and the graph, and inspect every stored row',
    args: [],
    needsSubcommand: true,
    subcommands: [
      sub('conversation', "A conversation's newest stored lines", [arg('conversation')]),
      sub('recent', 'Show live recent lines'),
      sub('search', 'Search her memory', [arg('query')]),
      sub('backup', 'Make a backup of the memory database and list the kept ones'),
      sub('backfill-media', 'Bring old media lines to the one format: backfill-media [--dry-run|status]', [
        arg('mode', false),
      ]),
      sub('restore', 'Bring an archived item back', [arg('id')]),
      sub('journal', 'Show journal of a day: journal [<YYYY-MM-DD>]', [arg('day', false)]),
      sub('archive', 'List archived memory items', [arg('kind', false)]),
      sub('bind', 'Link accounts to one person, to the persona with self, or to the owner with owner', [
        arg('iface'),
        arg('account'),
        arg('target'),
        arg('targetAccount', false),
      ]),
      ...MEMORY_BROWSER,
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
    name: 'interfaces',
    help: 'Set up connections, manage credentials and enable or disable them',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'Every interface, whether it is enabled and whether it is connected'),
      sub('enable', 'Enable an interface', [arg('name')]),
      sub('disable', 'Disable an interface', [arg('name')]),
      secretSub(
        sub('token.set', 'Save the platform token of an interface; the chat asks for it without showing it', [
          arg('name'),
        ]),
        'only'
      ),
      ...moduleSubcommands('interface'),
    ],
    otherwise: sub('command', "An interface's own subcommand", [arg('name'), arg('sub'), arg('rest', false)]),
  },
  {
    name: 'mirror',
    help: 'Choose where diary entries are published and settle what was delivered',
    args: [],
    defaultSubcommand: 'list',
    subcommands: [
      sub('list', 'Every mirror and whether it is enabled'),
      sub('status', 'Each mirror with its queue, failures, uncertain sends and backfill'),
      sub('add', 'Publish diary entries to a known place; --backfill true --every 4h also sends its old entries', [
        arg('destination'),
        flagArg('backfill', false),
        flagArg('every', false),
      ]),
      sub('configure', 'Change a mirror: --enabled, --backfill or --every', [
        arg('mirror'),
        flagArg('enabled', false),
        flagArg('backfill', false),
        flagArg('every', false),
      ]),
      sub('disable', 'Stop publishing to a mirror and keep its configuration', [arg('mirror')]),
      sub('remove', 'Take a mirror off the list and keep what it was sent', [arg('mirror')]),
      sub(
        'reconcile',
        'Record entries as already published, or say with --absent that an uncertain send never arrived',
        [arg('mirror'), flagArg('through', false), flagArg('entries', false), bareFlagArg('absent')]
      ),
    ],
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
      secretSub(
        sub('core.add', 'Add a core key; the chat asks for the value without showing it', [arg('name')]),
        'only'
      ),
      sub('core.remove', 'Remove a core key; the last one pauses her until the next add', [arg('name')]),
      sub('core.list', 'Show core keys with their last four characters, grants and the one in use'),
      sub('core.grant', 'Set the grant of a core key in USD and its reset day, or none to clear it', [
        arg('name'),
        arg('usd'),
        arg('day', false),
      ]),
      secretSub(
        sub('extra.add', 'Add an extra key; the chat asks for the value without showing it', [arg('name')]),
        'only'
      ),
      sub('extra.remove', 'Remove an extra key no role is bound to', [arg('name')]),
      sub('extra.list', 'Show extra keys with the roles bound to them'),
      sub('service.list', 'Show optional service keys: YouTube, Brave, Exa and the video proxy, each masked'),
      secretSub(
        sub('service.set', 'Set one service key; the chat asks for it without showing it', [arg('name')]),
        'only'
      ),
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
        'Show every source, the key of opencode by name, and the mode, source, model and effort of every role'
      ),
      ...BACKEND_NAMES.flatMap((backend) => accountSubcommands(backend)),
    ],
  },
  {
    name: 'agent',
    help: 'Set what each agent may do',
    args: [],
    needsSubcommand: true,
    subcommands: [
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
  const [first, second, third] = words;
  if (first === undefined) return null;
  const deep =
    second === undefined || third === undefined
      ? undefined
      : command.subcommands.find((one) => one.name === `${first}.${second}.${third}`);
  if (deep !== undefined) return { found: deep, used: 3 };
  const nested =
    second === undefined ? undefined : command.subcommands.find((one) => one.name === `${first}.${second}`);
  if (nested !== undefined) return { found: nested, used: 2 };
  const flat = command.subcommands.find((one) => one.name === first);
  return flat === undefined ? null : { found: flat, used: 1 };
}

/** The usage of `name` with `args`, as the owner types it. */
function usageOf(name: string, args: ReadonlyArray<CommandArg>): string {
  const words = args.map((one) => {
    const word = one.flag === undefined ? `<${one.name}>` : one.bare === true ? one.flag : `${one.flag} <${one.name}>`;
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
    if (known.bare === true && (value === undefined || value.startsWith('--'))) {
      flagged[known.name] = 'true';
      continue;
    }
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

/** Ends any line: the place the owner's command addresses, for a core that serves more than one. */
const PLACE_FLAG = '--place';

/** The words of a typed line: the leading slash dropped, split on spaces. */
export function commandLineWords(line: string): Array<string> {
  return line
    .trim()
    .replace(/^\//, '')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** The leaf a parsed name names, null for a command without subcommands. */
function leafOf(name: string): Subcommand | null {
  const [first, ...rest] = name.split('.');
  const command = COMMANDS.find((one) => one.name === first);
  const dotted = rest.join('.');
  return command?.subcommands.find((one) => one.name === dotted) ?? null;
}

/** Whether the leaf of a parsed name takes `--secret-stdin` in the command line. */
export const takesSecretStdin = (name: string): boolean => leafOf(name)?.secret !== undefined;

/** What a word no command has is refused with: the command that replaced it, when one did. */
const unknownWord = (word: string, rest: ReadonlyArray<string>): string =>
  isRetiredCommand(word)
    ? `/${word} is retired: use neptunia ${RETIRED_COMMANDS[word]?.(rest) ?? 'help'}`
    : `unknown command /${word}; type /help`;

/** Why the words after a command that stands are refused when they start with a retired word, naming its replacement; else null. */
function retiredWords(first: string, rest: ReadonlyArray<string>): string | null {
  if (first === 'services' && rest[0] === 'watcher' && rest[1] === 'report')
    return '/services watcher report is retired: use neptunia logs watcher';
  const memoryWord = rest[0];
  if (first === 'memory' && memoryWord !== undefined && Object.hasOwn(RETIRED_MEMORY, memoryWord))
    return `/memory ${memoryWord} is retired: use ${RETIRED_MEMORY[memoryWord] ?? '/help'}`;
  return retiredSubharness(first, rest);
}

/** Whether words that name no subcommand are refused: a command with arguments of its own reads them instead. */
const refusesLooseWords = (command: Command, rest: ReadonlyArray<string>): boolean =>
  rest.length > 0 && command.args.length === 0;

/** Why the words after `subharness` are refused when they start with a retired word, naming its replacement; else null. */
function retiredSubharness(first: string, [word, next]: ReadonlyArray<string>): string | null {
  if (first !== 'subharness' || word === undefined || !Object.hasOwn(RETIRED_SUBHARNESS, word)) return null;
  return `/subharness ${word} is retired: use ${RETIRED_SUBHARNESS[word]?.(next) ?? '/help'}`;
}

/** One command as words, none of them joined or split: its dotted name and arguments, or why it is refused. */
export function parseCommandWords(words: ReadonlyArray<string>): Parsed {
  const place = words.at(-2) === PLACE_FLAG ? words.at(-1) : undefined;
  const parsed = parseWithoutPlace(place === undefined ? words : words.slice(0, -2));
  return parsed.ok && place !== undefined ? { ...parsed, args: { ...parsed.args, place } } : parsed;
}

function parseWithoutPlace(words: ReadonlyArray<string>): Parsed {
  const [first, ...rest] = words;
  if (first === undefined) return refuse('an empty line is no command; type /help');
  const command = COMMANDS.find((one) => one.name === first);
  if (command === undefined) return refuse(unknownWord(first, rest));
  const retired = retiredWords(first, rest);
  if (retired !== null) return refuse(retired);
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
      // The value itself stays out of the reason: this word may be the secret.
      if (picked.found.secret === 'only' && tail.length > args.length)
        return refuse(
          `${usageOf(name, args)}: a secret never goes on the command line; answer the question or use --secret-stdin`
        );
    } else if (rest.length === 0 && command.defaultSubcommand !== undefined) {
      const fallback = command.subcommands.find((one) => one.name === command.defaultSubcommand);
      name = `${command.name}.${command.defaultSubcommand}`;
      args = fallback?.args ?? [];
    } else if (rest.length === 0 && command.needsSubcommand === true) {
      return refuse(`/${command.name} needs a subcommand: ${names}`);
    } else if (rest.length > 0 && command.otherwise !== undefined) {
      name = `${command.name}.${command.otherwise.name}`;
      args = command.otherwise.args;
    } else if (refusesLooseWords(command, rest)) {
      return refuse(`/${command.name} has no subcommand "${rest[0] ?? ''}": ${names}`);
    }
  }
  const values = argsOf(name, args, tail);
  if (typeof values === 'string') return refuse(values);
  const refused = command.check?.(name, values) ?? null;
  return refused === null ? { ok: true, name, args: values } : refuse(refused);
}

/** One typed line (`/memory places lore add g1 Tower tower,spire The tower ...`) as its command's dotted name and arguments. */
export function parseCommandLine(line: string): Parsed {
  return parseCommandWords(commandLineWords(line));
}
