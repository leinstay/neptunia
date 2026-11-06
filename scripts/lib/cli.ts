// What every script under scripts/ shares: flag parsing, the UTC day range, the deployment's data
// and private directories (src/paths.ts), the guild of a data directory, the OpenRouter key slot of the tools, the llm of a paid script (scripts/lib/simulation-llm.ts), the spend gate, and the entry point (print the result, or the error and exit 1).
// The spend gate is the one rule for a tool that sends model requests: it prints its estimate
// first and refuses unless `--spend <usd>` covers it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../../src/paths.ts';
import { simulationKey } from '../../src/simulation/key.ts';
import { serviceCredential } from '../../src/keys/file.ts';
import { interfaceCredential } from '../../src/config/files.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { CliError } from './cli-args.ts';
import type { Flags } from './cli-args.ts';
export { CliError, parseFlags, runCli } from './cli-args.ts';
export type { Flags } from './cli-args.ts';
export { simulationLlm } from './simulation-llm.ts';
export type { SimulationLlm } from './simulation-llm.ts';

/** An object read by key whose values are not typed yet. */

/** The text of a value flag, or undefined when it was not given (a value flag is never `true`). */
export function flagText(flags: Flags, name: string): string | undefined {
  const value: unknown = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** The checkout this file belongs to. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A tool receives one named service credential from the original selected persona. */
export function serviceKey(
  name: 'youtube' | 'brave' | 'exa' | 'proxy',
  { env = process.env, dataDir }: { env?: Record<string, string | undefined>; dataDir?: string } = {}
): string | null {
  return serviceCredential(dataDir ?? privateDirOf(ROOT, env), name);
}

/** Web lookup receives only its own optional credentials, independently of scratch prompt layers. */
export function serviceKeys(options: { env?: Record<string, string | undefined>; dataDir?: string } = {}): {
  brave: string | null;
  exa: string | null;
} {
  return { brave: serviceKey('brave', options), exa: serviceKey('exa', options) };
}

/** A tool that requires platform access reads only the selected interface's own credential. */
export function platformToken(
  name: string,
  {
    rootDir = ROOT,
    env = process.env,
  }: {
    rootDir?: string;
    env?: Record<string, string | undefined>;
  } = {}
): string {
  const token = interfaceCredential(privateDirOf(rootDir, env), name);
  if (!token) throw new CliError(`missing data/interfaces/${name}/credentials.json token`);
  return token;
}

/**
 * The OpenRouter key a tool spends: the simulation's key of `<private dir>/keys.json` (src/simulation/key.ts), the
 * private dir being `NEPTUNIA_PRIVATE_DIR` of `env`. While the simulation is off, or its key has left the store, the
 * tool stops with a CliError of one line that names it. A tool never spends a core key. The value is never printed.
 */
export function simKey(tool: Untyped, env: Record<string, string | undefined> = process.env): string {
  try {
    return simulationKey(privateDirOf(ROOT, env));
  } catch (err) {
    throw new CliError(
      `${tool}: ${err instanceof Error ? err.message.split('\n')[0] : 'the simulation key cannot be read'}`
    );
  }
}

/** Exit code of a run refused by the spend gate. */
export const REFUSED_EXIT = 2;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_DAYS = 366;

/**
 * Every UTC day from `since` to `until`, both included, as `YYYY-MM-DD`; a CliError with `usage`
 * for a malformed day, an empty range or more than a year.
 */
export function daysBetween(since: string, until: string, usage: string): Array<string> {
  if (!DAY_RE.test(String(since)) || !DAY_RE.test(String(until))) throw new CliError(usage);
  const from = Date.parse(`${since}T00:00:00Z`);
  const to = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new CliError(usage);
  const out = [];
  for (let ms = from; ms <= to; ms += DAY_MS) {
    out.push(new Date(ms).toISOString().slice(0, 10));
    if (out.length > MAX_DAYS) throw new CliError(`${usage}\n(at most ${MAX_DAYS} days)`);
  }
  return out;
}

/**
 * The data directory a tool reads when `--data` is not given: `NEPTUNIA_DATA_DIR` resolved against
 * `cwd` when set, else `<cwd>/data` (src/paths.ts#resolvePaths). A given `--data` still wins.
 */
export function defaultDataDir(cwd: string, env: Record<string, string | undefined> = process.env): string {
  return resolvePaths({ rootDir: cwd, env }).dataDir;
}

/**
 * The private directory of the checkout at `root` (where a tool reads .env and the local layer):
 * `NEPTUNIA_PRIVATE_DIR` resolved against `root` when set, else `root` (src/paths.ts#resolvePaths).
 */
export function privateDirOf(root: string, env: Record<string, string | undefined> = process.env): string {
  return resolvePaths({ rootDir: root, env }).privateDir;
}

/** The guild of `dataDir`: `given`, else the only directory under `guilds/`; else a CliError. */
export function resolveGuildId(dataDir: string, given: unknown): string {
  if (typeof given === 'string' && given) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(given)) throw new CliError('the guild id is not valid');
    return given;
  }
  let names: Array<string> = [];
  try {
    names = fs
      .readdirSync(path.join(dataDir, 'guilds'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    names = [];
  }
  if (names.length === 1) return names[0];
  throw new CliError(
    names.length === 0
      ? `no guild under ${path.join(dataDir, 'guilds')}`
      : `several guilds under ${path.join(dataDir, 'guilds')}: give --guild`
  );
}

/**
 * The spend gate. `estimateUsd` is what the run would cost; `spend` the value of `--spend`
 * (undefined when absent). Returns `{ ok, text }`: `text` always states the estimate; `ok` only
 * when `--spend` is a non-negative number at least as large as the estimate (nothing to send
 * passes without it).
 */
export function spendGate({
  estimateUsd,
  requests,
  spend,
  detail = '',
}: {
  estimateUsd: number;
  requests: number;
  spend?: string;
  detail?: string;
}): { ok: boolean; text: string; budget: number | null } {
  const usd = Number.isFinite(estimateUsd) && estimateUsd > 0 ? estimateUsd : 0;
  const head = `estimate: ${requests} model request(s), ~${usd.toFixed(2)} USD${detail ? ` (${detail})` : ''}`;
  if (requests <= 0) return { ok: true, text: head, budget: null };
  const budget = spend === undefined ? NaN : Number(spend);
  if (!Number.isFinite(budget) || budget < 0)
    return {
      ok: false,
      text: `${head}\nrefused: give --spend <usd> of at least ${usd.toFixed(2)} to run it`,
      budget: null,
    };
  if (budget < usd) return { ok: false, text: `${head}\nrefused: --spend ${budget} is below the estimate`, budget };
  return { ok: true, text: head, budget };
}
