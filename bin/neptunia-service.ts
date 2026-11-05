// What `neptunia service` does in the command line, for bin/neptunia.ts. A mechanic's name as the second word is the
// family (src/service/commands.ts), run here with no core so a mechanic can be switched and read while the core is down.
// `start`, `stop`, `restart` and `status` first are the verbs of the system units, shell only, through the scope's manager
// (a read never goes through `sudo`). The two orders never mix: `service status watcher` is refused and names the family.
// This file also holds the forms of `neptunia setup` the family replaced and the terminal's dialog of a bare `setup`.

import { spawnSync } from 'node:child_process';
import { readConfig } from '../src/config.ts';
import { serviceFamily } from '../src/service/commands.ts';
import type { ServiceAnswer, ServiceDeps } from '../src/service/commands.ts';
import { managerCall, managerRead } from '../src/service/manager.ts';
import { SERVICE_NAMES, formatSchedule, nextMoments, parseSchedule } from '../src/service/schedule.ts';
import { spawnRun } from '../src/setup/install.ts';
import { reportsDirOf, watcherDir } from '../src/watcher/read.ts';
import { reportAnswer } from './report.ts';

type Where = { rootDir: string; privateDir: string; dataDir: string };
type ServiceRequest = { name: string; args: Record<string, unknown> };

/** The units the verbs act on when none is named: the core and the two errand runners (deploy/). */
const DEFAULT_UNITS = ['neptunia-core.service', 'neptunia-agent-scout.service', 'neptunia-agent-server.service'];
const UNIT_VERBS = ['start', 'stop', 'restart', 'status'];

/** How many next times the dialog shows before it saves. */
const NEXT_SHOWN = 3;

/** The steps of `neptunia setup` the family replaced, and what each is refused with. */
const RETIRED_STEPS: Readonly<Record<string, string>> = {
  watcher: 'service watcher setup',
  selfimprovement: 'service selfimprovement setup',
  mechanics: 'service <name> setup',
};

export const isServiceRequest = (name: string): boolean => name.startsWith('service.');

/** Whether the core's own view answers this request better: the status of a wake, which only the core can say. */
export const prefersCore = (name: string): boolean => name.endsWith('.status') && !name.includes('.watcher.');

/** Why `neptunia setup <words>` names a retired step, or null. */
export function retiredSetupStep(words: ReadonlyArray<string>): string | null {
  const step = words.find((word) => Object.hasOwn(RETIRED_STEPS, word));
  return step === undefined ? null : `setup ${step} is retired: use neptunia ${RETIRED_STEPS[step] ?? 'service'}`;
}

/** One request of the family in this process, with no core. */
export function runServiceHere(request: ServiceRequest, where: Where, color: boolean): Promise<ServiceAnswer> {
  const config = (): unknown => readConfig(where.rootDir, { privateDir: where.privateDir });
  const deps: ServiceDeps = {
    ...where,
    config,
    now: Date.now,
    env: process.env,
    run: spawnRun,
    coreUp: false,
    report: (day, runId) =>
      reportAnswer({
        reportsDir: reportsDirOf(where.privateDir, watcherDir(config())),
        day,
        ...(runId === undefined ? {} : { runId }),
        color,
      }),
  };
  return serviceFamily(deps, request.name, request.args);
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
 * Which form `neptunia service <words>` is: the family, or the unit verbs, which this ends with the manager's exit code.
 * `refuse` ends the process with exit 2. The family returns to its caller, which runs it like any other command.
 */
export function runUnitVerbs(words: ReadonlyArray<string>, refuse: (reason: string) => never): void {
  const [first, second, ...others] = words;
  if (SERVICE_NAMES.some((name) => name === first)) return;
  if (first === undefined || !UNIT_VERBS.includes(first))
    refuse(
      `usage: neptunia service <name> setup|enable|disable|status, or neptunia service ${UNIT_VERBS.join('|')} [<unit> ...]`
    );
  if (SERVICE_NAMES.some((name) => name === second)) {
    const action = first === 'status' ? 'status' : 'enable or disable';
    refuse(`service ${first} ${second ?? ''} is not a form: use neptunia service ${second ?? ''} ${action}`);
  }
  const units = second === undefined ? DEFAULT_UNITS : [second, ...others];
  const [command, args] =
    first === 'status' ? managerRead(process.env, first, ...units) : managerCall(process.env, first, ...units);
  const run = spawnSync(command, args, { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
