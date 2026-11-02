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
// writes it through the private folder of its `ReadWritePaths=`, and the watcher has no mount sandbox. An agent unit in
// `read` or `write` hides the home (`ProtectHome=tmpfs`) and sees the private folder read-only, so the folder of the
// backend in keys.json is bound writable into it, and nothing above it: keys.json stays out of the agent's reach.

import path from 'node:path';
import { UNIT_SCOPE_ENV } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import type { AgentMode, SubharnessAgent } from '../subharness/control.ts';
import { subharnessPlace } from '../subharness/place.ts';

/** The templates `setup` renders, by file name. The bot unit and the plugin template are not among them. */
export const UNIT_FILES: ReadonlyArray<string> = [
  'neptunia-core.service',
  'neptunia-interface@.service',
  'neptunia-agent-scout.service',
  'neptunia-agent-server.service',
  'neptunia-watcher.service',
  'neptunia-watcher.timer',
];

/**
 * The selfdev beat's units: rendered over the dev checkout `selfdev.checkout` names, never over the deployed one, so
 * they are a list of their own (src/setup/run.ts).
 */
export const SELFDEV_UNIT_FILES: ReadonlyArray<string> = ['neptunia-selfdev.service', 'neptunia-selfdev.timer'];

/** The `ExecStart=` of an agent unit: the errand runner. */
const AGENT_RUNNER = /^ExecStart=\S+ bin\/neptunia\.ts errand-runner\b/m;

/** The agent whose mode shapes a unit, by the unit's file name. */
export const UNIT_AGENTS: Readonly<Record<string, SubharnessAgent>> = {
  'neptunia-agent-scout.service': 'scout',
  'neptunia-agent-server.service': 'server',
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
  /** the mode of the agent the unit runs; absent keeps the template's own sandbox */
  mode?: AgentMode;
  /** the subharness backend of keys.json; an agent unit binds its folder in the private layer writable */
  backend?: BackendName | null;
};

/** The directives of the mount sandbox: gone in the modes `full` and `sudo`. */
const MOUNT_SANDBOX = ['ProtectSystem', 'ProtectHome', 'ReadWritePaths', 'BindPaths', 'BindReadOnlyPaths'];

/** The directives that stop `sudo`: gone in the mode `sudo`. */
const STOPS_SUDO = ['NoNewPrivileges', 'CapabilityBoundingSet'];

/** The paths of the template's deployment, longest first, and what each becomes. */
function pathMap(vars: UnitVars): Array<[string, string]> {
  const nodeDir = path.dirname(vars.node);
  return [
    ['/opt/neptunia/app', vars.rootDir],
    ['/opt/neptunia/etc', vars.privateDir],
    ['/opt/neptunia/data', vars.dataDir],
    ['/etc/neptunia', vars.privateDir],
    ['/opt/node/bin/node', vars.node],
    ['/usr/bin/node', vars.node],
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

/** The key of a `Key=value` line, or null. */
const keyOf = (line: string): string | null => /^([A-Za-z]+)=/.exec(line)?.[1] ?? null;

/** What decides the fate of each line of one unit. */
type LineRules = {
  scope: 'user' | 'system';
  vars: UnitVars;
  dropped: ReadonlySet<string>;
  keepsHome: boolean;
  isInterface: boolean;
  /** the backend's folder bound after the unit's `ProtectHome=` line, null when the unit binds none */
  backendDir: string | null;
};

/** The lines `line` becomes: none when it is dropped, two for `User=` of a system unit. */
function linesOf(line: string, rules: LineRules): Array<string> {
  const { scope, vars, dropped } = rules;
  const key = keyOf(line);
  if (key === 'Conflicts' && line.includes('neptunia-bot.service')) return [];
  if (key === 'Group' || (key !== null && dropped.has(key))) return [];
  if (key === 'User') return scope === 'system' ? [`User=${vars.user}`, `Group=${vars.group}`] : [];
  if (scope === 'user' && line === 'WantedBy=multi-user.target') return ['WantedBy=default.target'];
  if (scope === 'user' && rules.isInterface && key === 'InaccessiblePaths') return [];
  if (rules.backendDir !== null && key === 'ProtectHome') return [line, `BindPaths=-${rules.backendDir}`];
  if (rules.keepsHome && key === 'BindReadOnlyPaths') {
    const bound = line.slice('BindReadOnlyPaths='.length).split(/\s+/).filter(Boolean);
    return [`BindReadOnlyPaths=${[...bound, ...visibleHomePaths(vars, bound)].join(' ')}`];
  }
  // The profiles' socket and out defaults follow the unit's own runtime and state folders (agentSettings).
  if (scope === 'user' && line === '[Service]') return [line, `Environment=${UNIT_SCOPE_ENV}=user`];
  return [line];
}

/**
 * One template as the unit file of `scope` for the installing user in `vars`. Comments stay as the template has them
 * with their paths mapped too.
 */
export function renderUnit(template: string, scope: 'user' | 'system', vars: UnitVars): string {
  let text = template;
  for (const [from, to] of pathMap(vars)) text = text.replaceAll(from, () => to);
  const mode = vars.mode ?? 'write';
  const dropped = new Set<string>();
  if (mode === 'full' || mode === 'sudo') for (const key of MOUNT_SANDBOX) dropped.add(key);
  if (mode === 'sudo') for (const key of STOPS_SUDO) dropped.add(key);
  // The leading `-` lets the unit start before setup made the folder; the agent then fails `not-installed`.
  const backendDir =
    vars.backend != null && AGENT_RUNNER.test(text) ? subharnessPlace(vars.privateDir, vars.backend).dir : null;
  const rules: LineRules = {
    scope,
    vars,
    dropped,
    keepsHome: !dropped.has('ProtectHome') && /^ProtectHome=tmpfs$/m.test(text),
    isInterface: /^ExecStart=.*\binterface run\b/m.test(text),
    backendDir,
  };
  return text
    .split('\n')
    .flatMap((line) => linesOf(line, rules))
    .join('\n');
}
