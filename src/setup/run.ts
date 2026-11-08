// `neptunia setup`: the install of one user, one flow of eleven internal steps, like the sections of the setup of Hermes
// (hermes_cli/setup.py) with a summary at the end (hermes_cli/setup_summary.py). The steps are no public commands, and
// `parseSetupArgs` refuses their names. Every step checks
// first whether its work is done (`already`), so a rerun after a failure resumes where it stopped. A step that fails
// stops the run, the steps after it are `skipped`, and no chat opens. The six steps that ask come before `units`, so
// the units bind the backends just installed and the watcher's timer takes the schedule just given; each is `skipped` with
// no terminal. After the last step the owner's chat opens on `keys core add`, and the chat takes over.
//
//   folders          the private folder with `config.local`, `prompts.local`, `clients`, and the data folder, mode 0700
//   keys-file        an empty `keys.json` at mode 0600; one that exists keeps its content and is made 0600
//   interfaces       each interface package with a `setup.json`: asked whether to use it, then its own questions,
//                    its client and token, and its instance started (src/setup/interfaces.ts, src/setup/modules.ts)
//   services         the optional YouTube Data API key, with the link that says how to get one, and optional quick
//                    search, declined by default (src/setup/services.ts)
//   subharness       the backends her agents may run through, installed and logged in (src/setup/subharness.ts)
//   selfimprovement  development, optional: gh, the repository her pull requests go to with the push right checked, and
//                    the development checkout, cloned when its folder is empty (src/setup/development.ts)
//   mechanics        heartbeat, selfreflection and selfimprovement on or off, and `selfimprovement.schedule`
//                    (src/setup/mechanics.ts)
//   watcher          the watcher on or off, `watcher.schedule`, its backend and its model (src/setup/watcher.ts)
//   units            the unit files of deploy/, rendered (src/setup/units.ts) and rewritten when they differ; the
//                    development unit too when `selfimprovement.checkout` names a checkout other than this one; and the
//                    clients of the owner's command line, of the owner on the task board and of the units that need
//                    one, with their tokens
//                    (src/setup/clients.ts), which need no core socket
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
import { CLI_CLIENT, OWNER_CLIENT, SERVICE_CLIENT, provisionClients } from './clients.ts';
import { offerDevelopment } from './development.ts';
import type { GhInstall } from './development.ts';
import { interfacesStep } from './interfaces.ts';
import { servicesStep } from './services.ts';
import { installUnits, systemctlOf, unitDirOf, whyFailed } from './install.ts';
import type { RunResult, UnitTarget } from './install.ts';
import { mechanicsStep } from './mechanics.ts';
import { subharnessStep } from './subharness.ts';
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

/** Who and where `setup` installs; `only` runs one step, for the tests. */
export type SetupOptions = UnitTarget & { only?: SetupStep };

/** What `setup` reaches outside the files: commands, and the owner's chat. */
export type SetupDeps = {
  run(command: string, args: ReadonlyArray<string>, options?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>;
  /** Opens the owner's chat with `firstLine` typed. Called once, last, after a full run. */
  openChat(firstLine: string): Promise<void>;
  /** Called once with the report, before the chat opens or when the run ends without it. */
  report?(report: SetupReport): void;
  /** Asks the owner at the terminal; absent when no terminal is there, and the steps that ask are skipped. */
  ask?: (question: string, offered: string | null, options?: { secret: boolean }) => Promise<string>;
  /** The system's gh, for the push-right check of the self-development and mechanics steps. */
  gh?: GhRunner;
  /** Installs gh when the development step finds none; without it that step says what to install. */
  installGh?: () => Promise<GhInstall>;
  /** npm for the subharness step's install (src/subharness/install.ts); without it that step is skipped. */
  install?: InstallRun;
  /** The environment npm is started with; `process.env` by default. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
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
  'interfaces token set discord',
  'interfaces enable discord',
  'model set',
  'subharness claude login',
  'simulation enable',
];

/** The line the chat opens on. */
const FIRST_LINE = '/keys core add';

/** The usage error of the command line: nothing has been touched when it is raised. */
export class SetupUsageError extends Error {}

/** Why a word of the command line is refused: a step is internal, and `setup subharness` became the account command. */
function refusedWord(word: string, next: string | undefined): string {
  if (word === 'subharness')
    return `neptunia setup subharness is gone: use neptunia subharness ${next ?? '<backend>'} login, and neptunia setup for the whole flow`;
  return `setup takes no ${word}: neptunia setup runs the one flow, and skips what is done`;
}

/** `setup [--system] [--node <path>]` as options, or a SetupUsageError. */
export function parseSetupArgs(argv: ReadonlyArray<string>): { system: boolean; node?: string } {
  let system = false;
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
    else throw new SetupUsageError(refusedWord(word, argv[at + 1]));
  }
  return { system, ...(node === undefined ? {} : { node }) };
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
 * The dev checkout the development worker works on, or why there is none: `selfimprovement.checkout` unset, or naming this
 * checkout, where the worker would edit and push the code that is running.
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

/** The clients of the watcher's and the development worker's units, with their board roles. */
const WATCHER_CLIENT = { name: 'watcher', boardRoles: ['watcher'] };
const DEVELOPMENT_CLIENT = { name: 'development', boardRoles: ['reviewer', 'worker'] };

async function unitsStep(options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  const development = developmentCheckoutOf(options);
  const hasDevelopment = 'checkout' in development;
  let clients: ReturnType<typeof provisionClients>;
  try {
    clients = provisionClients(
      options.privateDir,
      hasDevelopment
        ? [CLI_CLIENT, SERVICE_CLIENT, OWNER_CLIENT, DEVELOPMENT_CLIENT, WATCHER_CLIENT]
        : [CLI_CLIENT, SERVICE_CLIENT, OWNER_CLIENT, WATCHER_CLIENT]
    );
  } catch (err) {
    return failed(`the clients cannot be written: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  const files = hasDevelopment ? [...UNIT_FILES, ...DEVELOPMENT_UNIT_FILES] : UNIT_FILES;
  const target = hasDevelopment ? { ...options, developmentCheckout: development.checkout } : options;
  const result = await installUnits(target, (command, args) => deps.run(command, args), files);
  if (!result.ok) return failed(result.reason);
  const where = unitDirOf(options);
  const note = 'why' in development ? `; ${development.why}` : '';
  const made = clients.made.length === 0 ? '' : `; tokens written for ${clients.made.join(', ')}`;
  const there = clients.there.length === 0 ? '' : `; clients in place: ${clients.there.join(', ')}`;
  const units =
    result.written.length === 0
      ? `${files.length} units are in ${where}`
      : `${result.written.length} units written to ${where}`;
  const detail = `${units}${note}${made}${there}`;
  return result.written.length === 0 && clients.made.length === 0 ? already(detail) : done(detail);
}

async function lingerStep(options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  if (options.system) return { state: 'skipped', detail: 'system units need no linger' };
  const shown = await deps.run('loginctl', ['show-user', options.user, '-p', 'Linger']);
  if (shown.code === 0 && /^Linger=yes$/m.test(shown.stdout)) return already(`linger is on for ${options.user}`);
  const enabled = await deps.run('loginctl', ['enable-linger', options.user]);
  return enabled.code === 0 ? done(`linger is on for ${options.user}`) : failed(`enable-linger: ${whyFailed(enabled)}`);
}

export async function coreStep(options: SetupOptions, deps: Pick<SetupDeps, 'run'>): Promise<Outcome> {
  const [check, checkArgs] = systemctlOf(options, 'is-active', 'neptunia-core.service');
  const active = await deps.run(check, checkArgs);
  if (active.code === 0) return already('the core is running');
  const [start, startArgs] = systemctlOf(options, 'enable', '--now', 'neptunia-core.service');
  const started = await deps.run(start, startArgs);
  return started.code === 0 ? done('the core is enabled and running') : failed(`enable --now: ${whyFailed(started)}`);
}

const GH_BY_HAND: GhInstall = {
  code: 'manual',
  what: 'Install the GitHub CLI from https://cli.github.com and run neptunia setup again.',
};

const NOT_AT_TERMINAL: Outcome = { state: 'skipped', detail: 'not at a terminal' };

async function selfimprovementSetupStep(options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  const { ask, gh } = deps;
  if (ask === undefined || gh === undefined) return NOT_AT_TERMINAL;
  const outcome = await offerDevelopment(options, {
    run: (command, args, given) => deps.run(command, args, given),
    ask,
    gh,
    installGh: deps.installGh ?? (() => Promise.resolve(GH_BY_HAND)),
  });
  return { state: outcome.state, detail: outcome.detail };
}

async function subharnessSetupStep(options: SetupOptions, deps: SetupDeps): Promise<Outcome> {
  const { ask, install } = deps;
  if (ask === undefined || install === undefined) return NOT_AT_TERMINAL;
  const outcome = await subharnessStep(options, { ask, install, hostEnv: deps.hostEnv ?? process.env });
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
      return deps.ask === undefined
        ? NOT_AT_TERMINAL
        : interfacesStep(options, {
            ask: deps.ask,
            run: (command, args) => deps.run(command, args),
            prepareUnits: async () => {
              // An instance cannot start before its template is in place, and the template's step comes later.
              const units = await unitsStep(options, deps);
              return units.state === 'failed' ? units.detail : null;
            },
          });
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
