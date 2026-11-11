// What `neptunia services` does in the command line, for bin/neptunia.ts. A mechanic's name as the second word is the
// family (src/service/commands.ts), run here with no core so a mechanic can be switched and read while the core is down.
// `start`, `stop`, `restart` and `status` first are the verbs of the system units, shell only, through the scope's manager
// (a read never goes through `sudo`). The two orders never mix: `services status heartbeat` is refused and names the family.
// This file also holds the forms of `neptunia setup` the family replaced and the terminal's dialog of a bare `setup`.

import { spawnSync } from 'node:child_process';
import { readConfig } from '../src/config.ts';
import { readLabels } from '../src/hot.ts';
import { serviceFamily } from '../src/service/commands.ts';
import type { ServiceAnswer, ServiceDeps } from '../src/service/commands.ts';
import { managerCall, managerRead } from '../src/service/manager.ts';
import { SERVICE_NAMES, formatSchedule, nextMoments, parseSchedule } from '../src/service/schedule.ts';
import { spawnRun } from '../src/setup/install.ts';
import path from 'node:path';
import { watcherDoctor } from '../src/watcher/doctor.ts';
import { runStoreOf } from '../src/watcher/lifecycle.ts';
import { reportsDirOf, watcherDir } from '../src/watcher/read.ts';
import { renderMarkdown } from './markdown.ts';

type Where = { rootDir: string; privateDir: string; dataDir: string };
type ServiceRequest = { name: string; args: Record<string, unknown> };

/** The second words of the family: the three mechanics, and `watcher`, whose agent reads its evidence there. */
const FAMILY_WORDS: ReadonlyArray<string> = [...SERVICE_NAMES, 'watcher'];

/** The units the verbs act on when none is named: the core and the two errand runners (deploy/). */
const DEFAULT_UNITS = ['neptunia-core.service', 'neptunia-agent-scout.service', 'neptunia-agent-server.service'];
const UNIT_VERBS = ['start', 'stop', 'restart', 'status'];

/** How many next times the dialog shows before it saves. */
const NEXT_SHOWN = 3;

export const isServiceRequest = (name: string): boolean => name.startsWith('services.');

/** Whether the core's own view answers this request better: the status of a wake, which only the core can say. */
export const prefersCore = (name: string): boolean =>
  name === 'services.list' || (isServiceRequest(name) && name.endsWith('.status'));

/** One request of the family in this process, with no core. */
export function runServiceHere(request: ServiceRequest, where: Where): Promise<ServiceAnswer> {
  const config = (): unknown => readConfig(where.rootDir, { privateDir: where.privateDir });
  const deps: ServiceDeps = {
    ...where,
    config,
    now: Date.now,
    env: process.env,
    run: spawnRun,
    coreUp: false,
  };
  return serviceFamily(deps, request.name, request.args);
}

/**
 * `/doctor watcher stop|read|list|accepted|accept|unaccept|<number>` from the files, with the core up or down; `run` goes to the core, which
 * starts the worker. A report opened here is rendered for the terminal.
 */
export function watcherDoctorHere(request: ServiceRequest, where: Where, color: boolean): ServiceAnswer {
  const reportsDir = reportsDirOf(
    where.privateDir,
    watcherDir(readConfig(where.rootDir, { privateDir: where.privateDir }))
  );
  const answer = watcherDoctor(request.name, request.args, {
    store: runStoreOf(path.dirname(reportsDir)),
    reportsDir,
    labels: readLabels(where.rootDir, where.privateDir),
  });
  const isReport = request.name === 'doctor.watcher.read' || request.name === 'doctor.watcher';
  return isReport && answer.status === 'ok' ? { ...answer, text: renderMarkdown(answer.text, { color }) } : answer;
}

/**
 * A bare `setup` at a terminal: the schedule asked for, its timezone and next times shown before anything is saved.
 * The request with the answer as its flag, or the request as it came, which the handler refuses for missing its flags.
 */
export async function askSetup(
  request: ServiceRequest,
  ask: (question: string, offered: string | null) => Promise<string>
): Promise<ServiceRequest> {
  const answer = (await ask('Daily UTC times or an interval (at 00:00,12:00 or every 6h):', null)).trim();
  const schedule = parseSchedule(answer);
  if (schedule === null) return request;
  console.log(
    `timezone: UTC\nnext: ${nextMoments(schedule, Date.now(), NEXT_SHOWN)
      .map((at) => new Date(at).toISOString())
      .join(',')}`
  );
  if ((await ask(`Save ${formatSchedule(schedule)}? (yes or no)`, 'yes')).trim().toLowerCase() !== 'yes')
    return request;
  const value = formatSchedule(schedule).replace(/^(at|every) /, '');
  return { ...request, args: { ...request.args, [schedule.kind]: value } };
}

/**
 * Which form `neptunia services <words>` is: the family, or the unit verbs, which this ends with the manager's exit code.
 * `refuse` ends the process with exit 2. The family returns to its caller, which runs it like any other command.
 */
export function runUnitVerbs(words: ReadonlyArray<string>, refuse: (reason: string) => never): void {
  const [first, second, ...others] = words;
  if (first === 'list' || FAMILY_WORDS.some((name) => name === first)) return;
  if (first === undefined || !UNIT_VERBS.includes(first))
    refuse(
      `usage: neptunia services list, neptunia services <name> setup|enable|disable|status, or neptunia services ${UNIT_VERBS.join('|')} [<unit> ...]`
    );
  if (second === 'watcher') refuse(`services ${first} watcher is not a form: use neptunia doctor watcher list`);
  if (SERVICE_NAMES.some((name) => name === second)) {
    const action = first === 'status' ? 'status' : 'enable or disable';
    refuse(`services ${first} ${second ?? ''} is not a form: use neptunia services ${second ?? ''} ${action}`);
  }
  const units = second === undefined ? DEFAULT_UNITS : [second, ...others];
  const [command, args] =
    first === 'status' ? managerRead(process.env, first, ...units) : managerCall(process.env, first, ...units);
  const run = spawnSync(command, args, { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
