// The unit templates of deploy/ rendered for the installing user. `neptunia setup` writes them as user units
// (`~/.config/systemd/user/`, no `User=`, the default target) or, with `--system`, as system units that run as the
// installing user. The templates keep the paths of the first deployment; the renderer maps them onto the folders of this
// one, so a template edit stays the single source of a unit. The render is pure.
//
// The sandbox of an agent unit follows the agent's mode (src/subharness/control.ts). `read` and `write` keep every
// directive of the template. `full` drops the mount sandbox (`ProtectSystem`, `ProtectHome` and the bind and write
// paths), and `sudo` drops in addition what would stop `sudo` (`NoNewPrivileges` and the capability bounding set).
//
// A subharness backend lives in `<private>/subharness/<backend>/` (src/subharness/place.ts), binary and home. The core
// writes it through the private folder of its `ReadWritePaths=`, and the watcher's unit names the whole `subharness/`
// folder in its own. An agent unit in
// `read` or `write` hides the home (`ProtectHome=tmpfs`) and sees the private folder read-only, so the folder of every
// backend a role names in keys.json or installed there is bound writable into it, and nothing above it: keys.json stays out of the agent's
// reach.
//
// The watcher's, the development worker's and the server agent's units run as the user of the core, so the mount namespace
// is all that keeps a child of theirs from the other clients' tokens and the interfaces' `credentials.json`. Given the
// names of the clients and the interfaces the install has, each of those units hides them with `InaccessiblePaths=-<path>`
// (the leading `-` lets the unit start before a file exists) and leaves its own client's token readable. `keys.json`
// stays readable: the watcher and the development worker read their agents' routes from it (docs/watcher.md). The modes
// `full` and `sudo` drop the entries with the rest of the mount sandbox.
//
// The watcher's timer takes `watcher.schedule` when the render is given it: one `OnCalendar=` per daily time, or an
// interval counted from the timer's own activation and then from the last run. The other timers keep their lines.

import path from 'node:path';
import { UNIT_SCOPE_ENV } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import type { AgentMode, SubharnessAgent } from '../subharness/control.ts';
import { subharnessPlace } from '../subharness/place.ts';
import type { ServiceSchedule } from '../service/schedule.ts';
import { DEFAULT_WATCHER_DIR } from '../watcher/read.ts';

/** The templates `setup` renders, by file name. The bot unit is not among them. */
export const UNIT_FILES: ReadonlyArray<string> = [
  'neptunia-core.service',
  'neptunia-interface@.service',
  'neptunia-agent-scout.service',
  'neptunia-agent-server.service',
  'neptunia-watcher.service',
  'neptunia-watcher.timer',
];

/**
 * The development worker's unit: its code is this install and its working repository the dev checkout
 * `selfimprovement.checkout` names, so it is a list of its own (src/setup/run.ts). Setup writes it and never enables it;
 * that is the owner's step.
 */
export const DEVELOPMENT_UNIT_FILES: ReadonlyArray<string> = ['neptunia-development.service'];

/** The `Unit=` line of the watcher's timer. */
const WATCHER_TIMER = /^Unit=neptunia-watcher\.service$/m;

/**
 * The units that hide the secrets of the core's user from their agent, found by their `ExecStart=`, and the client each
 * connects as (null when it connects as none). The scout needs no entry: its persona folder is an empty tmpfs.
 */
const SECRET_HIDERS: ReadonlyArray<{ start: RegExp; own: string | null }> = [
  { start: /^ExecStart=\S+ bin\/neptunia\.ts worker watcher\b/m, own: 'watcher' },
  { start: /^ExecStart=\S+ bin\/neptunia\.ts worker development\b/m, own: 'development' },
  { start: /^ExecStart=\S+ bin\/neptunia\.ts errand-runner --profile server\b/m, own: null },
];

/** A client or interface name that is one plain path segment: nothing that climbs out of its folder. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The folder under the watcher's own that `GH_CONFIG_DIR` names: nothing ever writes a login there. */
const NO_GH_LOGIN = 'no-gh-login';
const WATCHER_UNIT = /^ExecStart=\S+ bin\/neptunia\.ts worker watcher\b/m;

/** The `InaccessiblePaths=` line of a unit that hides secrets from its agent, null for any other unit. */
function hiddenLine(text: string, vars: UnitVars): string | null {
  const hider = SECRET_HIDERS.find(({ start }) => start.test(text));
  if (hider === undefined) return null;
  const named = (names: ReadonlyArray<string> | undefined): Array<string> =>
    [...new Set(names ?? [])].filter((name) => SAFE_NAME.test(name)).sort();
  const hidden = [
    ...named(vars.clients)
      .filter((name) => name !== hider.own)
      .map((name) => path.join(vars.dataDir, 'clients', `${name}.token`)),
    ...named(vars.interfaces).map((name) => path.join(vars.dataDir, 'interfaces', name, 'credentials.json')),
  ];
  return hidden.length === 0 ? null : `InaccessiblePaths=${hidden.map((one) => `-${one}`).join(' ')}`;
}

/** The `ExecStart=` of an agent unit: the errand runner. */
const AGENT_RUNNER = /^ExecStart=\S+ bin\/neptunia\.ts errand-runner\b/m;

/** The agent whose mode shapes a unit, by the unit's file name. */
export const UNIT_AGENTS: Readonly<Record<string, SubharnessAgent>> = {
  'neptunia-agent-scout.service': 'scout',
  'neptunia-agent-server.service': 'server',
  'neptunia-development.service': 'dev',
  'neptunia-watcher.service': 'watcher',
};

/** What a unit is rendered with. */
export type UnitVars = {
  user: string;
  group: string;
  home: string;
  rootDir: string;
  privateDir: string;
  dataDir: string;
  /** the absolute path of the node binary */
  node: string;
  /** `selfimprovement.checkout`, which the development unit may write; `/opt/neptunia/checkout` of its template */
  developmentCheckout?: string | null;
  /** the mode of the agent the unit runs; absent keeps the template's own sandbox */
  mode?: AgentMode;
  /** the backends a role names in keys.json or installed in the private layer; an agent unit binds the folder of each in the private layer writable */
  backends?: ReadonlyArray<BackendName>;
  /** the names of the clients of `clients.json`; the units of the watcher, the development worker and the server agent hide every token but their own */
  clients?: ReadonlyArray<string>;
  /** the names of the interfaces, each with a `interfaces/<name>/credentials.json` those units hide */
  interfaces?: ReadonlyArray<string>;
  /** `watcher.schedule`: what the watcher's timer fires on; absent keeps the template's `OnCalendar=` */
  watcherSchedule?: ServiceSchedule;
};

/** The directives of the mount sandbox: gone in the modes `full` and `sudo`. */
const MOUNT_SANDBOX = [
  'ProtectSystem',
  'ProtectHome',
  'ReadWritePaths',
  'BindPaths',
  'BindReadOnlyPaths',
  'TemporaryFileSystem',
];

/** The directives that stop `sudo`: gone in the mode `sudo`. */
const STOPS_SUDO = ['NoNewPrivileges', 'CapabilityBoundingSet'];

/** The paths of the template's deployment, longest first, and what each becomes. */
function pathMap(vars: UnitVars): Array<readonly [string, string]> {
  const nodeDir = path.dirname(vars.node);
  return [
    ...(vars.developmentCheckout ? ([['/opt/neptunia/checkout', vars.developmentCheckout]] as const) : []),
    ['/opt/neptunia/app', vars.rootDir],
    ['/opt/neptunia/etc', vars.dataDir],
    ['/opt/neptunia/data', vars.dataDir],
    ['/etc/neptunia', vars.dataDir],
    ['/opt/node/bin/node', vars.node],
    ['/opt/node/bin', nodeDir],
    ['/home/neptunia', vars.home],
  ];
}

/** Whether `child` is `parent` or lies inside it. */
const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * The folders a unit with `ProtectHome=tmpfs` must still see because the checkout or the node binary lies under the
 * home: they are bound read-only, minus the ones inside a path that is bound already.
 */
function visibleHomePaths(vars: UnitVars, bound: ReadonlyArray<string>): Array<string> {
  const wanted = [vars.rootDir, path.dirname(path.dirname(vars.node))].filter(
    (dir) => inside(dir, vars.home) && dir !== vars.home
  );
  const kept: Array<string> = [];
  for (const dir of wanted)
    if (![...bound, ...kept].some((have) => inside(dir, have)) && !kept.includes(dir)) kept.push(dir);
  return kept;
}

/** The timer lines of a schedule. `OnUnitActiveSec=` alone never fires before the worker's first run. */
function timerLines(schedule: ServiceSchedule): Array<string> {
  if (schedule.kind === 'at') return schedule.at.map((slot) => `OnCalendar=*-*-* ${slot}:00 UTC`);
  return [`OnActiveSec=${schedule.everyMinutes}min`, `OnUnitActiveSec=${schedule.everyMinutes}min`];
}

/** The key of a `Key=value` line, or null. */
const keyOf = (line: string): string | null => /^([A-Za-z]+)=/.exec(line)?.[1] ?? null;

/** What decides the fate of each line of one unit. */
type LineRules = {
  scope: 'user' | 'system';
  vars: UnitVars;
  dropped: ReadonlySet<string>;
  keepsHome: boolean;
  isInterface: boolean;
  /** the backends' folders bound after the unit's `ProtectHome=` line, none when the unit binds none */
  backendDirs: ReadonlyArray<string>;
  /** the lines of the watcher's timer that replace `OnCalendar=`, null for any other unit or with no schedule given */
  timer: ReadonlyArray<string> | null;
  /** the `InaccessiblePaths=` line added under `[Service]`, null for a unit that hides nothing or in the modes `full` and `sudo` */
  hidden: string | null;
  /** the `GH_CONFIG_DIR=` line added under `[Service]` of the watcher's unit, null for any other unit */
  gh: string | null;
};

/** The lines the backends' binds and the watcher's schedule make of `line`, or null when they leave it alone. */
function renderedLines(line: string, key: string | null, rules: LineRules): Array<string> | null {
  if (rules.backendDirs.length > 0 && key === 'ProtectHome')
    return [line, ...rules.backendDirs.map((dir) => `BindPaths=-${dir}`)];
  // The runner reads agents/ at its start, so a persona folder emptied for the unit shows that folder.
  if (key === 'TemporaryFileSystem') return [line, `BindReadOnlyPaths=-${path.join(rules.vars.dataDir, 'agents')}`];
  if (rules.timer !== null && key === 'OnCalendar') return [...rules.timer];
  // The profiles' socket and out defaults follow the unit's own runtime and state folders (agentSettings).
  if (line === '[Service]')
    return [
      line,
      ...(rules.scope === 'user' ? [`Environment=${UNIT_SCOPE_ENV}=user`] : []),
      ...(rules.hidden === null ? [] : [rules.hidden]),
      ...(rules.gh === null ? [] : [rules.gh]),
    ];
  return null;
}

/** The lines `line` becomes: none when it is dropped, two for `User=` of a system unit. */
function linesOf(line: string, rules: LineRules): Array<string> {
  const { scope, vars, dropped } = rules;
  const key = keyOf(line);
  if (key === 'Conflicts' && line.includes('neptunia-bot.service')) return [];
  if (key === 'Group' || (key !== null && dropped.has(key))) return [];
  if (key === 'User') return scope === 'system' ? [`User=${vars.user}`, `Group=${vars.group}`] : [];
  // A user manager refuses `SupplementaryGroups=` with status 216.
  if (key === 'SupplementaryGroups' && scope === 'user') return [];
  if (scope === 'user' && line === 'WantedBy=multi-user.target') return ['WantedBy=default.target'];
  if (scope === 'user' && rules.isInterface && key === 'InaccessiblePaths') return [];
  const rendered = renderedLines(line, key, rules);
  if (rendered !== null) return rendered;
  if (rules.keepsHome && key === 'BindReadOnlyPaths') {
    const bound = line.slice('BindReadOnlyPaths='.length).split(/\s+/).filter(Boolean);
    return [`BindReadOnlyPaths=${[...bound, ...visibleHomePaths(vars, bound)].join(' ')}`];
  }
  return [line];
}

/**
 * One template as the unit file of `scope` for the installing user in `vars`. Comments stay as the template has them
 * with their paths mapped too.
 */
export function renderUnit(template: string, scope: 'user' | 'system', vars: UnitVars): string {
  const paths = pathMap(vars).sort(([left], [right]) => right.length - left.length);
  const pattern = new RegExp(paths.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  // Match only template paths so an inserted path keeps its literal value.
  const text = template.replace(pattern, (from: string) => paths.find(([source]) => source === from)?.[1] ?? from);
  const mode = vars.mode ?? 'write';
  const dropped = new Set<string>();
  if (mode === 'full' || mode === 'sudo') for (const key of MOUNT_SANDBOX) dropped.add(key);
  if (mode === 'sudo') for (const key of STOPS_SUDO) dropped.add(key);
  // The leading `-` lets the unit start before setup made the folder; the agent then fails `not-installed`.
  const backendDirs = AGENT_RUNNER.test(text)
    ? (vars.backends ?? []).map((backend) => subharnessPlace(vars.dataDir, backend).dir)
    : [];
  const timer =
    vars.watcherSchedule !== undefined && WATCHER_TIMER.test(text) ? timerLines(vars.watcherSchedule) : null;
  // `gh` finds its login through GH_CONFIG_DIR: the watcher's names a folder inside its own that holds none, so a `gh`
  // that the worker or its child starts reads no login.
  const gh = WATCHER_UNIT.test(text)
    ? `Environment=GH_CONFIG_DIR=${path.join(vars.dataDir, DEFAULT_WATCHER_DIR, NO_GH_LOGIN)}`
    : null;
  const rules: LineRules = {
    scope,
    vars,
    dropped,
    keepsHome: !dropped.has('ProtectHome') && /^ProtectHome=tmpfs$/m.test(text),
    isInterface: /^ExecStart=.*\binterface run\b/m.test(text),
    backendDirs,
    timer,
    hidden: dropped.has('ProtectSystem') ? null : hiddenLine(text, vars),
    gh,
  };
  return text
    .split('\n')
    .flatMap((line) => linesOf(line, rules))
    .join('\n');
}
