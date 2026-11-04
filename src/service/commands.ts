// The `service` family: `service <name> setup|enable|disable|status` for the four scheduled mechanics, and `trigger`,
// `cancel` and `report` of the watcher. bin/neptunia.ts calls `serviceFamily` for the shell and `-p`, and the owner's
// console (src/interface/commands/console.ts) for a chat that reaches the core, so one handler answers every form. It
// writes `<name>.schedule` and `<name>.enabled` of the local settings, which every mechanic's own scheduler reads, and
// moves the watcher's timer through the manager (src/service/manager.ts). The persona's wakes run in the core and call no
// manager. A status asks no model and writes nothing. An answer is `key: value` lines; `invalid` is missing syntax.

import { readKeys } from '../keys/file.ts';
import { selfimprovementSettings } from '../selfimprovement/settings.ts';
import { innerSettings } from '../behavior/inner/settings.ts';
import { setPath } from '../tools/impl/shared.ts';
import { objOf } from '../tools/types.ts';
import { readReport, reportDays, reportsDirOf, watcherDir, isDay } from '../watcher/read.ts';
import { watcherSettings } from '../watcher/settings.ts';
import { updateLocalSettings } from './local-settings.ts';
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
  /** One report as the terminal shows it; absent, the report's markdown as it is. */
  report?: (day: string | undefined) => ServiceAnswer;
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
  if (refused !== null) return invalid(`service ${name} setup: ${refused}`);
  const given = setupSchedule(args);
  const jitter = args.jitter === undefined ? null : parseJitter(args.jitter);
  if (given === null && jitter === null)
    return invalid(`service ${name} setup needs --at <HH:MM,HH:MM> or --every <N>h, with no terminal to ask at`);
  if (given === null && scheduleOf(name, deps.config())?.kind === 'at')
    return invalid(`service ${name} setup: --jitter moves an interval, and this schedule is daily times`);
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
        `service watcher setup: the manager did not take it: ${held.reason}\n${lines([
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
  const verb = enabled ? 'enable' : 'disable';
  const refused = await moveTimer(deps.run, deps.env, verb);
  if (refused === null) return { text: lines(fields), status: 'ok' };
  return failed(
    `service watcher ${verb}: the manager refused: ${refused}\n${lines([
      ['desired', enabled ? 'enabled' : 'disabled'],
      ['applied', 'unchanged'],
    ])}`
  );
}

/** What stops the mechanic from running, apart from its saved flag. */
function missingOf(deps: ServiceDeps, name: ServiceName, config: unknown): Array<string> {
  const missing: Array<string> = [];
  if (name !== 'watcher' && !deps.coreUp) missing.push('the core is not running');
  if (name === 'watcher' || name === 'selfimprovement') {
    let backends = 0;
    try {
      backends = readKeys(deps.privateDir).subharness.backends.length;
    } catch {
      // An unreadable keys file connects no backend.
    }
    if (backends === 0) missing.push('no subharness backend is connected');
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
  const missing = missingOf(deps, name, config);
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
  if (name === 'watcher') fields.push(['timer', await timerState(deps.run, deps.env)]);
  return { text: lines(fields), status: 'ok' };
}

/** `trigger`: the watcher's lifecycle comes in its own slice, so an enabled watcher hears that plainly. */
function trigger(deps: ServiceDeps): ServiceAnswer {
  if (!watcherSettings(deps.config()).enabled)
    return failed('service watcher trigger: the watcher is disabled; run neptunia service watcher enable first');
  return failed('service watcher trigger: one immediate inspection is not built yet; the timer runs the next one');
}

/** `report [target]`: what the reports folder holds for a day, or the newest. Run identities come with the lifecycle. */
function report(deps: ServiceDeps, target: string | undefined): ServiceAnswer {
  if (target !== undefined && !isDay(target)) return failed(`no report for ${target}: reports are kept by date`);
  if (deps.report !== undefined) return deps.report(target);
  const read = readReport(reportsDirOf(deps.privateDir, watcherDir(deps.config())), target);
  if (read.ok) return { text: read.report.text, status: 'ok' };
  return failed(target === undefined ? 'no report yet' : `no report for ${target}`);
}

/** One command of the family by its parsed name, `service.<name>.<action>`. */
export function serviceFamily(
  deps: ServiceDeps,
  parsedName: string,
  args: Readonly<Record<string, unknown>>
): Promise<ServiceAnswer> {
  const [, word, action] = parsedName.split('.');
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
      return Promise.resolve(trigger(deps));
    case 'cancel':
      return Promise.resolve(failed('service watcher cancel: stopping a run is not built yet; nothing was cancelled'));
    case 'report':
      return Promise.resolve(report(deps, typeof args.target === 'string' ? args.target : undefined));
    default:
      return Promise.resolve(invalid(`no such command: service ${String(word)} ${String(action)}`));
  }
}

/** The clock of a wake out of the running inner life and diary, for the core's console. */
export function wakeClockOf(
  name: ServiceName,
  sources: {
    guildId: string | null;
    now: number;
    inner: {
      state(guildId: string): {
        heartbeat: { nextAt: number | null; lastAt: number | null } | null;
        selfimprovement: { lastAt: number | null } | null;
        queue: ReadonlyArray<{ kind: string }>;
        inflight: { kind: string } | null;
      };
    };
    diary: { status(): { slots: ReadonlyArray<number>; done: ReadonlyArray<number>; lastPosted?: number | null } };
  }
): WakeClock | null {
  const { guildId, now, inner, diary } = sources;
  if (name === 'selfreflection') {
    const { slots, done, lastPosted } = diary.status();
    return {
      running: null,
      lastAt: lastPosted ?? null,
      nextAt: slots.find((slot) => slot > now && !done.includes(slot)) ?? null,
    };
  }
  if (guildId === null || name === 'watcher') return null;
  const state = inner.state(guildId);
  const running = state.inflight?.kind === name || state.queue.some((wake) => wake.kind === name);
  return name === 'heartbeat'
    ? { running, lastAt: state.heartbeat?.lastAt ?? null, nextAt: state.heartbeat?.nextAt ?? null }
    : { running, lastAt: state.selfimprovement?.lastAt ?? null, nextAt: null };
}
