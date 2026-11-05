// The `services` family: `services list`, `services <name> setup|enable|disable|status` for the four scheduled mechanics,
// and `trigger` and `cancel` of the watcher (src/service/watcher.ts). `/logs watcher` reads the watcher's reports through
// the internal operation `service.watcher.report` of this handler. bin/neptunia.ts calls `serviceFamily` for the shell and `-p`, and the owner's
// console (src/interface/commands/console.ts) for a chat that reaches the core, so one handler answers every form. It
// writes `<name>.schedule` and `<name>.enabled` of the local settings, which every mechanic's own scheduler reads, and
// moves the watcher's timer through the manager (src/service/manager.ts). The persona's wakes run in the core and call no
// manager. A status asks no model and writes nothing. An answer is `key: value` lines; `invalid` is missing syntax.

import type { BackendName } from '../agent-runner/profiles.ts';
import { readKeys } from '../keys/file.ts';
import { backendOfAgent } from '../subharness/control.ts';
import { sourceProblem, sourceState } from '../subharness/sources.ts';
import { selfimprovementSettings } from '../selfimprovement/settings.ts';
import { innerSettings } from '../behavior/inner/settings.ts';
import { setPath } from '../tools/impl/shared.ts';
import { objOf } from '../tools/types.ts';
import { reportDays, reportsDirOf, watcherDir } from '../watcher/read.ts';
import { watcherSettings } from '../watcher/settings.ts';
import { updateLocalSettings } from './local-settings.ts';
import {
  cancelWatcher,
  readyWatcherFolder,
  triggerWatcher,
  watcherEvidence,
  watcherReport,
  watcherStatusFields,
} from './watcher.ts';
import { moveTimer, renderTimer, timerState, workerRunning } from './manager.ts';
import type { Environment, RunManager } from './manager.ts';
import {
  evaluateSchedule,
  formatSchedule,
  nextMoments,
  parseJitter,
  parseSchedule,
  scheduleOfFlag,
  setupRefusal,
  SERVICE_NAMES,
} from './schedule.ts';
import type { ServiceName, ServiceSchedule } from './schedule.ts';

export type ServiceAnswer = { text: string; status: string };

/** What the core knows of one of its wakes at this moment, with no model asked. */
export type WakeClock = { running: boolean | null; lastAt: number | null; nextAt: number | null };

export type ServiceDeps = {
  rootDir: string;
  privateDir: string;
  dataDir: string;
  config(): unknown;
  now(): number;
  env: Environment;
  run: RunManager;
  /** Whether this handler runs inside a core that answers. */
  coreUp: boolean;
  /** The core's clock of a wake; absent with no core, whose wakes then read `unknown`. */
  wakeClock?: (name: ServiceName) => WakeClock | null;
  /** One report by day or run as the terminal shows it; absent, the report's markdown as it is. */
  report?: (day: string | undefined, runId?: string) => ServiceAnswer;
};

/** How many next times `setup` answers. */
const NEXT_SHOWN = 3;

const iso = (moment: number): string => new Date(moment).toISOString();
const invalid = (text: string): ServiceAnswer => ({ text, status: 'invalid' });
const failed = (text: string): ServiceAnswer => ({ text, status: 'failed' });
const lines = (fields: ReadonlyArray<readonly [string, string]>): string =>
  fields.map(([key, value]) => `${key}: ${value}`).join('\n');

/** The schedule in force: null for a diary with none set, which keeps its windows. */
function scheduleOf(name: ServiceName, config: unknown): ServiceSchedule | null {
  switch (name) {
    case 'heartbeat':
      return innerSettings(config).heartbeat.schedule;
    case 'selfimprovement':
      return innerSettings(config).wakes.selfimprovement.schedule;
    case 'watcher':
      return watcherSettings(config).schedule;
    case 'selfreflection':
      return parseSchedule(objOf(objOf(config).selfreflection).schedule);
  }
}

const isEnabled = (name: ServiceName, config: unknown): boolean => {
  const flag = objOf(objOf(config)[name]).enabled;
  return name === 'watcher' ? flag === true : flag !== false;
};

/** The schedule as status shows it, with the jitter an interval of the heartbeat carries. */
function scheduleText(name: ServiceName, config: unknown): string {
  const schedule = scheduleOf(name, config);
  if (schedule === null) return 'windows';
  const jitter = name === 'heartbeat' && schedule.kind === 'every' ? innerSettings(config).heartbeat.jitterMinutes : 0;
  return jitter > 0 ? `${formatSchedule(schedule)} jitter ${jitter}m` : formatSchedule(schedule);
}

function nextOf(name: ServiceName, schedule: ServiceSchedule, now: number, count: number): Array<number> {
  return nextMoments(schedule, now, count, { onDayGrid: name === 'selfreflection' });
}

function setupSchedule(args: Readonly<Record<string, unknown>>): ServiceSchedule | null {
  return args.at !== undefined ? scheduleOfFlag('at', args.at) : scheduleOfFlag('every', args.every);
}

/** `setup`: the schedule saved and the flag left alone; the watcher's timer rendered, and nothing started. */
async function setup(
  deps: ServiceDeps,
  name: ServiceName,
  args: Readonly<Record<string, unknown>>
): Promise<ServiceAnswer> {
  const refused = setupRefusal(name, args);
  if (refused !== null) return invalid(`services ${name} setup: ${refused}`);
  const given = setupSchedule(args);
  const jitter = args.jitter === undefined ? null : parseJitter(args.jitter);
  if (given === null && jitter === null)
    return invalid(`services ${name} setup needs --at <HH:MM,HH:MM> or --every <N>h, with no terminal to ask at`);
  if (given === null && scheduleOf(name, deps.config())?.kind === 'at')
    return invalid(`services ${name} setup: --jitter moves an interval, and this schedule is daily times`);
  updateLocalSettings(deps.privateDir, (local) => {
    let next = local;
    if (given !== null) next = setPath(next, [name, 'schedule'], formatSchedule(given));
    return jitter === null ? next : setPath(next, [name, 'jitterMinutes'], jitter);
  });
  const schedule = given ?? scheduleOf(name, deps.config());
  const saved = schedule === null ? 'windows' : formatSchedule(schedule);
  if (name === 'watcher') {
    const held = await renderTimer(deps, deps.run, deps.env);
    if (held !== null)
      return failed(
        `services watcher setup: the manager did not take it: ${held.reason}\n${lines([
          ['desired', saved],
          ['applied', held.applied],
        ])}`
      );
  }
  const next = schedule === null ? [] : nextOf(name, schedule, deps.now(), NEXT_SHOWN);
  return {
    text: lines([
      ['service', name],
      ['schedule', saved],
      ['timezone', 'UTC'],
      ['next', next.map(iso).join(',')],
    ]),
    status: 'ok',
  };
}

/** `enable` and `disable`: the flag moved, then the watcher's timer. A second call with the flag set applies it again. */
async function moveFlag(deps: ServiceDeps, name: ServiceName, enabled: boolean): Promise<ServiceAnswer> {
  updateLocalSettings(deps.privateDir, (local) =>
    objOf(local[name]).enabled === enabled ? local : setPath(local, [name, 'enabled'], enabled)
  );
  const fields = [
    ['service', name],
    ['enabled', String(enabled)],
  ] as const;
  if (name !== 'watcher') return { text: lines(fields), status: 'ok' };
  if (enabled) readyWatcherFolder(deps);
  const verb = enabled ? 'enable' : 'disable';
  const refused = await moveTimer(deps.run, deps.env, verb);
  if (refused === null) return { text: lines(fields), status: 'ok' };
  return failed(
    `services watcher ${verb}: the manager refused: ${refused}\n${lines([
      ['desired', enabled ? 'enabled' : 'disabled'],
      ['applied', 'unchanged'],
    ])}`
  );
}

/** The agent roles a mechanic needs a source for: the watcher its own, the wake's tasks the thinker's and the dev's. */
const SOURCE_ROLES: Readonly<Record<ServiceName, ReadonlyArray<string>>> = {
  heartbeat: [],
  selfreflection: [],
  selfimprovement: ['thinker', 'dev'],
  watcher: ['watcher'],
};

/** Why `role` cannot run now, null when its source can. An unreadable keys file names no source. */
async function sourceMissing(privateDir: string, role: string): Promise<string | null> {
  let backend: BackendName | null = null;
  try {
    backend = backendOfAgent(readKeys(privateDir).subharness, role);
  } catch {
    // no source
  }
  if (backend === null) return `${role} has no subharness source`;
  const state = await sourceState(privateDir, backend);
  return state.available ? null : `${role}: ${sourceProblem(state)}`;
}

/** What stops the mechanic from running, apart from its saved flag. */
async function missingOf(deps: ServiceDeps, name: ServiceName, config: unknown): Promise<Array<string>> {
  const missing: Array<string> = [];
  if (name !== 'watcher' && !deps.coreUp) missing.push('the core is not running');
  for (const role of SOURCE_ROLES[name]) {
    const problem = await sourceMissing(deps.privateDir, role);
    if (problem !== null) missing.push(problem);
  }
  if (name === 'selfimprovement' && selfimprovementSettings(config).repository === null)
    missing.push('selfimprovement.repository is unset');
  return missing;
}

const runningText = (running: boolean | null | undefined): string => (running == null ? 'unknown' : String(running));

/** The next due moment: the core's own when it holds one ahead, else the schedule's. */
function nextDue(
  deps: ServiceDeps,
  name: ServiceName,
  config: unknown,
  enabled: boolean,
  clock: WakeClock | null
): string {
  if (!enabled) return 'none';
  const now = deps.now();
  if (clock?.nextAt != null && clock.nextAt > now) return iso(clock.nextAt);
  const schedule = scheduleOf(name, config);
  if (schedule === null) return 'unknown';
  const [next] =
    name === 'selfreflection'
      ? nextOf(name, schedule, now, 1)
      : [evaluateSchedule({ schedule, enabled, now, last: clock?.lastAt ?? null }).next];
  return next == null ? 'none' : iso(next);
}

async function status(deps: ServiceDeps, name: ServiceName): Promise<ServiceAnswer> {
  const config = deps.config();
  const enabled = isEnabled(name, config);
  const clock = name === 'watcher' ? null : (deps.wakeClock?.(name) ?? null);
  const missing = await missingOf(deps, name, config);
  const newest = reportDays(reportsDirOf(deps.privateDir, watcherDir(config))).at(-1);
  const lastWake = clock === null ? 'unknown' : clock.lastAt === null ? 'none' : iso(clock.lastAt);
  const fields: Array<readonly [string, string]> = [
    ['service', name],
    ['enabled', String(enabled)],
    ['running', name === 'watcher' ? await workerRunning(deps.run, deps.env) : runningText(clock?.running)],
    ['readiness', missing.length === 0 ? 'ready' : `not ready: ${missing.join(', ')}`],
    ['schedule', scheduleText(name, config)],
    ['next due', nextDue(deps, name, config, enabled, clock)],
    ['last result', name === 'watcher' ? (newest === undefined ? 'none' : `report ${newest}`) : lastWake],
  ];
  if (name === 'watcher') fields.push(...watcherStatusFields(deps), ['timer', await timerState(deps.run, deps.env)]);
  return { text: lines(fields), status: 'ok' };
}

/** The four mechanics, each as its own status answers: `services list` keeps no copy of what a status reads. */
async function list(deps: ServiceDeps): Promise<ServiceAnswer> {
  const answers = await Promise.all(SERVICE_NAMES.map((name) => status(deps, name)));
  return { text: answers.map((answer) => answer.text).join('\n\n'), status: 'ok' };
}

/** One command of the family by its parsed name, `services.<name>.<action>` or `services.list`. */
export function serviceFamily(
  deps: ServiceDeps,
  parsedName: string,
  args: Readonly<Record<string, unknown>>
): Promise<ServiceAnswer> {
  const [, word, action] = parsedName.split('.');
  if (word === 'list') return list(deps);
  // The table only hands over its own names, so `word` is one of the four.
  const name = word as ServiceName;
  switch (action) {
    case 'setup':
      return setup(deps, name, args);
    case 'enable':
      return moveFlag(deps, name, true);
    case 'disable':
      return moveFlag(deps, name, false);
    case 'status':
      return status(deps, name);
    case 'trigger':
      return triggerWatcher(deps);
    case 'cancel':
      return Promise.resolve(cancelWatcher(deps));
    case 'report':
      return Promise.resolve(watcherReport(deps, typeof args.target === 'string' ? args.target : undefined));
    case 'evidence':
      return watcherEvidence(deps, args);
    default:
      return Promise.resolve(invalid(`no such command: services ${String(word)} ${String(action)}`));
  }
}

/** The clock of a wake out of the running inner life and diary, for the core's console. */
export function wakeClockOf(
  name: ServiceName,
  sources: {
    now: number;
    inner: {
      state(): {
        heartbeat: { nextAt: number | null; lastAt: number | null } | null;
        selfimprovement: { lastAt: number | null } | null;
        queue: ReadonlyArray<{ kind: string }>;
        inflight: { kind: string } | null;
      } | null;
    };
    diary: { status(): { slots: ReadonlyArray<number>; done: ReadonlyArray<number>; lastPosted?: number | null } };
  }
): WakeClock | null {
  const { now, inner, diary } = sources;
  if (name === 'selfreflection') {
    const { slots, done, lastPosted } = diary.status();
    return {
      running: null,
      lastAt: lastPosted ?? null,
      nextAt: slots.find((slot) => slot > now && !done.includes(slot)) ?? null,
    };
  }
  if (name === 'watcher') return null;
  const state = inner.state();
  if (!state) return null;
  const running = state.inflight?.kind === name || state.queue.some((wake) => wake.kind === name);
  return name === 'heartbeat'
    ? { running, lastAt: state.heartbeat?.lastAt ?? null, nextAt: state.heartbeat?.nextAt ?? null }
    : { running, lastAt: state.selfimprovement?.lastAt ?? null, nextAt: null };
}
