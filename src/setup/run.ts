// `neptunia setup`: the install of one user, in eleven steps that each run on their own and again, like the sections of
// the setup of Hermes (hermes_cli/setup.py) with a summary at the end (hermes_cli/setup_summary.py). Every step checks
// first whether its work is done (`already`), so a rerun after a failure resumes where it stopped. A step that fails
// stops the run, the steps after it are `skipped`, and no chat opens. The six steps that ask come before `units`, so
// the units bind the backends just connected and the watcher's timer takes the schedule just given; each is `skipped` with
// no terminal. After the last step the owner's chat opens on `keys core add`, and the chat takes over.
//
//   folders          the private folder with `config.local`, `prompts.local`, `clients`, and the data folder, mode 0700
//   keys-file        an empty `keys.json` at mode 0600; one that exists keeps its content and is made 0600
//   interfaces       each interface package with a `setup.json`: asked whether to use it, then its own questions
//                    (src/setup/interfaces.ts, src/setup/modules.ts)
//   services         the optional YouTube Data API key, with the link that says how to get one (src/setup/services.ts)
//   subharness       the backends her agents run through, installed and connected (src/setup/subharness.ts)
//   selfimprovement  the repository her pull requests go to, checked through her gh login
//                    (src/setup/selfimprovement.ts); skipped while `selfimprovement.checkout` is unset
//   mechanics        heartbeat, selfreflection and selfimprovement on or off, and `selfimprovement.schedule`
//                    (src/setup/mechanics.ts)
//   watcher          the watcher on or off, `watcher.schedule`, its backend and its model (src/setup/watcher.ts)
//   units            the unit files of deploy/, rendered (src/setup/units.ts) and rewritten when they differ; the
//                    development unit too when `selfimprovement.checkout` names a checkout other than this one
//   linger           `loginctl enable-linger` for the user, so the user units run without a login (user units only)
//   core             `enable --now neptunia-core.service`, the one unit setup starts
//
// A `refused` step stops nothing.
//
// With `--system` the units are system units that run as the installing user, put in place with `sudo install`, and
// every systemctl call goes through `sudo`. The units start the node `nodeOf` finds: `--node <path>`, else the one this
// command was started with, unresolved, so a link such as `/opt/node` survives a node upgrade. The commands run through the injected `deps.run`, so nothing in the
// tests reaches systemd; the chat is the injected `deps.openChat`.

import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from '../config.ts';
import { assertPersonaLayout } from '../config/files.ts';
import { selfimprovementSettings } from '../selfimprovement/settings.ts';
import { emptyKeys, writeKeys } from '../keys/file.ts';
import type { GhRunner } from '../selfimprovement/repository.ts';
import { interfacesStep } from './interfaces.ts';
import { servicesStep } from './services.ts';
import { installUnits, systemctlOf, unitDirOf, whyFailed } from './install.ts';
import type { RunResult, UnitTarget } from './install.ts';
import { mechanicsStep } from './mechanics.ts';
import { selfimprovementStep } from './selfimprovement.ts';
import { subharnessStep } from './subharness.ts';
import type { SubharnessStepDeps } from './subharness.ts';
import { watcherStep } from './watcher.ts';
import type { InstallRun } from '../subharness/install.ts';
import { DEVELOPMENT_UNIT_FILES, UNIT_FILES } from './units.ts';

export type { RunResult };

/** The steps, in the order they run. */
export const SETUP_STEPS = [
  'folders',
  'keys-file',
  'interfaces',
  'services',
  'subharness',
  'selfimprovement',
  'mechanics',
  'watcher',
  'units',
  'linger',
  'core',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** Who and where `setup` installs; `only` runs one step. */
export type SetupOptions = UnitTarget & { only?: SetupStep };

/** What `setup` reaches outside the files: commands, and the owner's chat. */
export type SetupDeps = {
  run(command: string, args: ReadonlyArray<string>): Promise<RunResult>;
  /** Opens the owner's chat with `firstLine` typed. Called once, last, after a full run. */
  openChat(firstLine: string): Promise<void>;
  /** Called once with the report, before the chat opens or when the run ends without it. */
  report?(report: SetupReport): void;
  /** Asks the owner at the terminal; absent when no terminal is there, and the steps that ask are skipped. */
  ask?: (question: string, offered: string | null, options?: { secret: boolean }) => Promise<string>;
  /** gh under her own gh home, for the push-right check of the self-development and mechanics steps. */
  gh?: GhRunner;
  /** npm for the subharness step's install (src/subharness/install.ts); without it that step is skipped. */
  install?: InstallRun;
  /** One reply of codex or claude, the subharness step's check; without it that step is skipped. */
  runBackend?: SubharnessStepDeps['runBackend'];
  /** The `/auth/key` check of opencode's key; without it the subharness step is skipped. */
  fetch?: typeof fetch;
  /** The environment npm is started with; `process.env` by default. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /** The endpoint of opencode's key check. */
  baseUrl?: string;
};

/** What one step came to. */
export type StepState = 'done' | 'already' | 'failed' | 'skipped' | 'refused';
export type SetupReport = {
  ok: boolean;
  steps: Array<{ step: SetupStep; state: StepState; detail: string }>;
  /** the commands the owner types next in the chat, in order */
  next: Array<string>;
};

/** The chat commands that finish the install, in order. */
const NEXT = [
  'keys core add',
  'interface token set discord',
  'interface enable discord',
  'model set',
  'subharness enable',
  'simulation enable',
];

/** The line the chat opens on. */
const FIRST_LINE = '/keys core add';

/** The usage error of the command line: nothing has been touched when it is raised. */
export class SetupUsageError extends Error {}

/** `setup [--system] [--node <path>] [step]` as options, or a SetupUsageError. */
export function parseSetupArgs(argv: ReadonlyArray<string>): { system: boolean; only?: SetupStep; node?: string } {
  let system = false;
  let only: SetupStep | undefined;
  let node: string | undefined;
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at] ?? '';
    if (word === '--system') system = true;
    else if (word === '--node') {
      const given = argv[at + 1];
      if (given === undefined || !path.isAbsolute(given))
        throw new SetupUsageError('--node takes the absolute path of the node binary');
      node = given;
      at += 1;
    } else if (word.startsWith('-')) throw new SetupUsageError(`setup has no option ${word}`);
    else {
      const step = SETUP_STEPS.find((known) => known === word);
      if (step === undefined) throw new SetupUsageError(`${word} is no step; use ${SETUP_STEPS.join(', ')}`);
      if (only !== undefined) throw new SetupUsageError('setup runs one step at a time');
      only = step;
    }
  }
  return { system, ...(only === undefined ? {} : { only }), ...(node === undefined ? {} : { node }) };
}

/**
 * The node path the units name: `given` (`--node`) first; else `argv0` when it is absolute; else the first
 * `<dir>/<argv0>` on `pathEnv` that exists, never resolved through a link; else `execPath`.
 */
export function nodeOf(input: {
  given?: string;
  argv0: string;
  execPath: string;
  pathEnv: string | undefined;
}): string {
  if (input.given !== undefined) return input.given;
  if (path.isAbsolute(input.argv0)) return input.argv0;
  if (!input.argv0.includes('/'))
    for (const dir of (input.pathEnv ?? '').split(':')) {
      if (!path.isAbsolute(dir)) continue;
      const candidate = path.join(dir, input.argv0);
      if (fs.existsSync(candidate)) return candidate;
    }
  return input.execPath;
}

type Outcome = { state: StepState; detail: string };

const done = (detail: string): Outcome => ({ state: 'done', detail });
const already = (detail: string): Outcome => ({ state: 'already', detail });
const failed = (detail: string): Outcome => ({ state: 'failed', detail });

/** Makes `dir` at 0700 whatever the umask; true when it was created or its mode changed. */
function secureDir(dir: string): boolean {
  const existed = fs.existsSync(dir);
  if (!existed) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const before = fs.statSync(dir).mode & 0o777;
  if (before !== 0o700) fs.chmodSync(dir, 0o700);
  return !existed || before !== 0o700;
}

function foldersStep(options: SetupOptions): Outcome {
  const dirs = [
    options.privateDir,
    path.join(options.dataDir, 'config'),
    path.join(options.dataDir, 'prompts'),
    path.join(options.privateDir, 'clients'),
    options.dataDir,
  ];
  const touched = dirs.filter((dir) => secureDir(dir));
  return touched.length === 0 ? already('the folders exist at 0700') : done(`${touched.length} folders at 0700`);
}

function keysFileStep(options: SetupOptions): Outcome {
  const file = path.join(options.privateDir, 'keys.json');
  if (!fs.existsSync(file)) {
    writeKeys(options.privateDir, emptyKeys());
    return done('keys.json written empty at 0600');
  }
  const before = fs.statSync(file).mode & 0o777;
  if (before === 0o600) return already('keys.json exists at 0600');
  fs.chmodSync(file, 0o600);
  return done('keys.json kept, its mode set to 0600');
}

/**
 * The dev checkout the development unit runs in, or why there is none: `selfimprovement.checkout` unset, or naming this checkout,
 * where the worker would edit and push the code that is running.
 */
function developmentCheckoutOf(options: SetupOptions): { checkout: string } | { why: string } {
  const { checkout } = selfimprovementSettings(readConfig(options.rootDir, { privateDir: options.privateDir }));
  if (checkout === null) return { why: 'no development unit: selfimprovement.checkout is unset' };
  if (path.resolve(checkout) === path.resolve(options.rootDir))
    return {
      why: 'no development unit: selfimprovement.checkout is the deployed checkout, and the worker works on a dev checkout',
    };
  return { checkout };
}

async function unitsStep(options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  const development = developmentCheckoutOf(options);
  const files = 'checkout' in development ? [...UNIT_FILES, ...DEVELOPMENT_UNIT_FILES] : UNIT_FILES;
  const target = 'checkout' in development ? { ...options, developmentCheckout: development.checkout } : options;
  const result = await installUnits(target, (command, args) => deps.run(command, args), files);
  if (!result.ok) return failed(result.reason);
  const where = unitDirOf(options);
  const note = 'why' in development ? `; ${development.why}` : '';
  return result.written.length === 0
    ? already(`${files.length} units are in ${where}${note}`)
    : done(`${result.written.length} units written to ${where}${note}`);
}

async function lingerStep(options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  if (options.system) return { state: 'skipped', detail: 'system units need no linger' };
  const shown = await deps.run('loginctl', ['show-user', options.user, '-p', 'Linger']);
  if (shown.code === 0 && /^Linger=yes$/m.test(shown.stdout)) return already(`linger is on for ${options.user}`);
  const enabled = await deps.run('loginctl', ['enable-linger', options.user]);
  return enabled.code === 0 ? done(`linger is on for ${options.user}`) : failed(`enable-linger: ${whyFailed(enabled)}`);
}

async function coreStep(options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  const [check, checkArgs] = systemctlOf(options, 'is-active', 'neptunia-core.service');
  const active = await deps.run(check, checkArgs);
  if (active.code === 0) return already('the core is running');
  const [start, startArgs] = systemctlOf(options, 'enable', '--now', 'neptunia-core.service');
  const started = await deps.run(start, startArgs);
  return started.code === 0 ? done('the core is enabled and running') : failed(`enable --now: ${whyFailed(started)}`);
}

const NOT_AT_TERMINAL: Outcome = { state: 'skipped', detail: 'not at a terminal' };

async function selfimprovementSetupStep(options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  const { ask, gh } = deps;
  if (ask === undefined || gh === undefined) return NOT_AT_TERMINAL;
  const outcome = await selfimprovementStep(options, { run: (command, args) => deps.run(command, args), ask, gh });
  return { state: outcome.state, detail: outcome.detail };
}

async function subharnessSetupStep(options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  const { ask, install, runBackend, fetch } = deps;
  if (ask === undefined || install === undefined || runBackend === undefined || fetch === undefined)
    return NOT_AT_TERMINAL;
  const outcome = await subharnessStep(options, {
    ask,
    install,
    runBackend,
    fetch,
    hostEnv: deps.hostEnv ?? process.env,
    ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
  });
  return { state: outcome.state, detail: outcome.detail };
}

/** One step's work. */
async function stepOutcome(step: SetupStep, options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  switch (step) {
    case 'folders':
      return foldersStep(options);
    case 'keys-file':
      return keysFileStep(options);
    case 'interfaces':
      return deps.ask === undefined ? NOT_AT_TERMINAL : interfacesStep(options, { ask: deps.ask });
    case 'services':
      return deps.ask === undefined ? NOT_AT_TERMINAL : servicesStep(options, { ask: deps.ask });
    case 'subharness':
      return subharnessSetupStep(options, deps);
    case 'selfimprovement':
      return selfimprovementSetupStep(options, deps);
    case 'mechanics':
      return deps.ask === undefined || deps.gh === undefined
        ? NOT_AT_TERMINAL
        : mechanicsStep(options, { ask: deps.ask, gh: deps.gh });
    case 'watcher':
      return deps.ask === undefined ? NOT_AT_TERMINAL : watcherStep(options, { ask: deps.ask });
    case 'units':
      return unitsStep(options, deps);
    case 'linger':
      return lingerStep(options, deps);
    case 'core':
      return coreStep(options, deps);
  }
}

/** Runs the steps (one with `only`), the chat last after a full run. Resolves with the report; never rejects for a failed step. */
export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<SetupReport> {
  if (path.resolve(options.privateDir) !== path.resolve(options.dataDir))
    throw new SetupUsageError('privateDir must match dataDir: use scripts/persona-files-move.ts');
  assertPersonaLayout(options.dataDir, options.rootDir);
  const steps: SetupReport['steps'] = [];
  let stopped = false;
  for (const step of SETUP_STEPS) {
    if (stopped || (options.only !== undefined && options.only !== step)) {
      steps.push({ step, state: 'skipped', detail: stopped ? 'an earlier step failed' : 'not asked for' });
      continue;
    }
    let outcome: Outcome;
    try {
      outcome = await stepOutcome(step, options, deps);
    } catch (err) {
      outcome = failed((err as NodeJS.ErrnoException).code ?? 'the step could not run');
    }
    steps.push({ step, ...outcome });
    if (outcome.state === 'failed') stopped = true;
  }
  const report: SetupReport = { ok: !stopped, steps, next: NEXT };
  deps.report?.(report);
  if (report.ok && options.only === undefined) await deps.openChat(FIRST_LINE);
  return report;
}
