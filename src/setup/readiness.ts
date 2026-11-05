// Whether a chat can open: `gatherHealth` reads the public health results with no provider in reach (the files of the
// data folder, the unit folder, and one read-only command of the core when the link is up), `evaluateReadiness` turns
// them into the first incomplete requirement and a repair for each failure, and `decideLaunch` says what a launch does.
// bin/neptunia.ts calls them for a chat and for `neptunia doctor`. Search, media, mirrors and subharnesses are `optional`
// and never block. A repair names the command that mends the one thing, so a stopped core is never a reinstall.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, readConfig } from '../config.ts';
import { localConfigPath } from '../config/files.ts';
import { loadPrincipals } from '../interface/principals.ts';
import { CORE_UNIT } from '../service/manager.ts';
import { coreSelection, readCoreCheck } from './model-check.ts';
import type { CoreCheck } from './model-check.ts';

/** What a chat needs, in the order the setup flow repairs it: each one can depend on those before it. */
export const REQUIREMENTS = [
  'cli-identity',
  'local-config',
  'services',
  'core-running',
  'cli-link',
  'core-model',
  'memory',
] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

type MemoryState = 'ok' | 'down' | 'unknown';

export type ReadinessHealth = {
  identity: 'ok' | 'missing';
  /** `missing` blocks nothing: the shipped settings apply. */
  config: 'ok' | 'missing' | 'invalid';
  services: 'ok' | 'not-installed';
  core: 'listening' | 'down';
  link: 'authenticated' | 'refused' | 'untested';
  model: { selection: string | null; check: CoreCheck | null };
  /** `unknown` with no core to ask, which `core-running` reports already. */
  memory: { service: MemoryState; writer: MemoryState };
  optional: Readonly<Record<string, string>>;
};

export type Failure = { requirement: Requirement; code: string; repair: string };
export type Readiness = { ready: boolean; first: Requirement | null; failed: Array<Failure> };

const RUN_SETUP = 'run neptunia setup';

/** The command that mends each failure. */
export const REPAIRS = {
  'no-token': RUN_SETUP,
  'config-invalid': 'fix config/config.json in the data folder; neptunia doctor names the problem',
  'no-units': RUN_SETUP,
  'core-down': 'start the core with neptunia services start',
  'token-rejected': 'the core refuses the saved token: node scripts/client-token.ts rotate cli',
  'link-untested': RUN_SETUP,
  'no-model': 'choose a model with /model set core <model>',
  'check-missing': 'check the model with /keys check core',
  'check-stale': 'the model changed since its check: /keys check core',
  'check-failed': 'the provider refused the model or the key: /keys check core says why',
  'memory-service-down': 'the memory database is closed: read neptunia doctor memory',
  'memory-writer-down': 'the memory writer does not answer: read neptunia doctor memory and /subharness status',
} as const;
type FailureCode = keyof typeof REPAIRS;

function codeOfModel({ selection, check }: ReadinessHealth['model']): FailureCode | null {
  if (selection === null) return 'no-model';
  if (check === null) return 'check-missing';
  if (check.selection !== selection) return 'check-stale';
  return check.ok ? null : 'check-failed';
}

/** The failure code of each requirement in the health, null when it holds. */
function codeOf(requirement: Requirement, health: ReadinessHealth): FailureCode | null {
  switch (requirement) {
    case 'cli-identity':
      return health.identity === 'ok' ? null : 'no-token';
    case 'local-config':
      return health.config === 'invalid' ? 'config-invalid' : null;
    case 'services':
      return health.services === 'ok' ? null : 'no-units';
    case 'core-running':
      return health.core === 'listening' ? null : 'core-down';
    case 'cli-link':
      if (health.core === 'down') return null;
      if (health.link === 'refused') return 'token-rejected';
      return health.link === 'untested' ? 'link-untested' : null;
    case 'core-model':
      return codeOfModel(health.model);
    case 'memory':
      if (health.memory.service === 'down') return 'memory-service-down';
      return health.memory.writer === 'down' ? 'memory-writer-down' : null;
  }
}

export function evaluateReadiness(health: ReadinessHealth): Readiness {
  const failed: Array<Failure> = [];
  for (const requirement of REQUIREMENTS) {
    const code = codeOf(requirement, health);
    if (code !== null) failed.push({ requirement, code, repair: REPAIRS[code] });
  }
  return { ready: failed.length === 0, first: failed[0]?.requirement ?? null, failed };
}

/** One command through the link, with the core's answer. */
export type LinkAsk = (command: { name: string; args: Record<string, unknown> }) => Promise<{
  status: string;
  text: string;
}>;

/**
 * What the link came to: no core, a core with no token to offer it, a core that refused the token, or a working link.
 * An answer of status `late` from `ask` means the core took too long, which reads as down.
 */
export type HealthLink = { kind: 'down' } | { kind: 'listening' } | { kind: 'rejected' } | { kind: 'up'; ask: LinkAsk };

/** The answer of `status.readiness`. */
export type CoreReadiness = Pick<ReadinessHealth, 'model' | 'memory'>;

const hasCliIdentity = (privateDir: string): boolean => {
  const cli = (loadPrincipals(privateDir) ?? []).find((one) => one.name === 'cli' && one.kind === 'cli');
  if (cli === undefined) return false;
  try {
    return fs.readFileSync(path.resolve(privateDir, cli.tokenFile), 'utf8').trim() !== '';
  } catch {
    return false;
  }
};

function configState(dataDir: string): ReadinessHealth['config'] {
  let text: string;
  try {
    text = fs.readFileSync(localConfigPath(dataDir), 'utf8');
  } catch {
    return 'missing';
  }
  try {
    JSON.parse(text);
    return 'ok';
  } catch {
    return 'invalid';
  }
}

/** The selection and the record a launch can read with no core, so a stopped core does not read as no model too. */
function modelOnDisk(privateDir: string, dataDir: string): ReadinessHealth['model'] {
  let selection: string | null = null;
  try {
    selection = coreSelection(readConfig(ROOT_DIR, { privateDir }));
  } catch {
    // A local config that does not parse is reported on its own; the selection stays unknown.
  }
  return { selection, check: readCoreCheck(dataDir) };
}

const parsedReadiness = (text: string): CoreReadiness | null => {
  try {
    const parsed = JSON.parse(text) as Partial<CoreReadiness>;
    return parsed.model === undefined || parsed.memory === undefined
      ? null
      : { model: parsed.model, memory: parsed.memory };
  } catch {
    return null;
  }
};

/** The health as this process can read it now; the core is asked once, with a command that sends no model request. */
export async function gatherHealth(where: {
  privateDir: string;
  dataDir: string;
  unitDir: string;
  link: () => Promise<HealthLink>;
}): Promise<ReadinessHealth> {
  const { privateDir, dataDir, unitDir } = where;
  const base = {
    identity: hasCliIdentity(privateDir) ? ('ok' as const) : ('missing' as const),
    config: configState(dataDir),
    services: fs.existsSync(path.join(unitDir, CORE_UNIT)) ? ('ok' as const) : ('not-installed' as const),
    optional: {},
  };
  const unread = {
    model: modelOnDisk(privateDir, dataDir),
    memory: { service: 'unknown', writer: 'unknown' } as const,
  };
  const down = { ...base, ...unread, core: 'down', link: 'untested' } as const;
  const link = await where.link();
  if (link.kind === 'down') return down;
  if (link.kind === 'listening') return { ...base, ...unread, core: 'listening', link: 'untested' };
  if (link.kind === 'rejected') return { ...base, ...unread, core: 'listening', link: 'refused' };
  const answer = await link.ask({ name: 'status.readiness', args: {} });
  if (answer.status === 'late') return down;
  const read = answer.status === 'ok' ? parsedReadiness(answer.text) : null;
  return read === null
    ? { ...base, ...unread, core: 'listening', link: 'refused' }
    : { ...base, ...read, core: 'listening', link: 'authenticated' };
}

/** The failures as one line each way a person or a script reads them. */
export const readinessText = (readiness: Readiness): string =>
  readiness.failed.map((one) => `${one.code}: ${one.repair}`).join('; ');

export type LaunchDecision =
  { kind: 'chat' } | { kind: 'setup'; at: Requirement } | { kind: 'setup-required'; text: string };

/** What a chat launch does: opens; enters setup at the gap, at a terminal; or says what is needed, with none. */
export function decideLaunch({ terminal, readiness }: { terminal: boolean; readiness: Readiness }): LaunchDecision {
  if (readiness.first === null) return { kind: 'chat' };
  return terminal
    ? { kind: 'setup', at: readiness.first }
    : { kind: 'setup-required', text: `setup-required: ${readinessText(readiness)}` };
}
