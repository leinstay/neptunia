// The unit templates of deploy/ rendered for the installing user. `neptunia setup` writes them as user units
// (`~/.config/systemd/user/`, no `User=`, the default target) or, with `--system`, as system units that run as the
// installing user. The templates keep the paths of the first deployment; the renderer maps them onto the folders of this
// one, so a template edit stays the single source of a unit. The render is pure.
//
// The sandbox of an agent unit follows the agent's mode (src/subharness/control.ts). `read` and `write` keep every
// directive of the template. `full` drops the mount sandbox (`ProtectSystem`, `ProtectHome` and the bind and write
// paths), and `sudo` drops in addition what would stop `sudo` (`NoNewPrivileges` and the capability bounding set).

import path from 'node:path';
import type { AgentMode, SubharnessAgent } from '../subharness/control.ts';

/** The templates `setup` renders, by file name. The bot unit and the plugin template are not among them. */
export const UNIT_FILES: ReadonlyArray<string> = [
  'neptunia-core.service',
  'neptunia-interface@.service',
  'neptunia-agent-scout.service',
  'neptunia-agent-server.service',
  'neptunia-watcher.service',
  'neptunia-watcher.timer',
];

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
  const isInterface = /^ExecStart=.*\binterface run\b/m.test(text);
  const keepsHome = !dropped.has('ProtectHome') && /^ProtectHome=tmpfs$/m.test(text);
  const out: Array<string> = [];
  for (const line of text.split('\n')) {
    const key = keyOf(line);
    if (key === 'Conflicts' && line.includes('neptunia-bot.service')) continue;
    if (key !== null && dropped.has(key)) continue;
    if (key === 'Group') continue;
    if (key === 'User') {
      if (scope === 'system') out.push(`User=${vars.user}`, `Group=${vars.group}`);
      continue;
    }
    if (scope === 'user' && key === 'WantedBy' && line === 'WantedBy=multi-user.target') {
      out.push('WantedBy=default.target');
      continue;
    }
    if (scope === 'user' && isInterface && key === 'InaccessiblePaths') continue;
    if (keepsHome && key === 'BindReadOnlyPaths') {
      const bound = line.slice('BindReadOnlyPaths='.length).split(/\s+/).filter(Boolean);
      out.push(`BindReadOnlyPaths=${[...bound, ...visibleHomePaths(vars, bound)].join(' ')}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
