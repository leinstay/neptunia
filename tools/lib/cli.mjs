// What every script under tools/ shares: flag parsing, the UTC day range, the guild of a data
// directory, the OpenRouter key slot of the tools, the spend gate, and the entry point (print the result, or the error and exit 1).
// The spend gate is the one rule for a tool that sends model requests: it prints its estimate
// first and refuses unless `--spend <usd>` covers it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** An operator-facing failure: printed as is, exit code `exitCode` (1 by default). */
export class CliError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * The OpenRouter key a tool spends: `OPENROUTER_SIM_KEY` when set, else the bot's
 * `OPENROUTER_API_KEY` with one stderr warning line, else a CliError naming both. The value is
 * never printed.
 */
export function simKey(tool, env = process.env) {
  const filled = (value) => typeof value === 'string' && value.trim() !== '';
  if (filled(env.OPENROUTER_SIM_KEY)) return env.OPENROUTER_SIM_KEY;
  if (filled(env.OPENROUTER_API_KEY)) {
    console.error(`${tool}: OPENROUTER_SIM_KEY is not set, spending the bot's OPENROUTER_API_KEY`);
    return env.OPENROUTER_API_KEY;
  }
  throw new CliError(`${tool}: neither OPENROUTER_SIM_KEY nor OPENROUTER_API_KEY is set (.env)`);
}

/** Exit code of a run refused by the spend gate. */
export const REFUSED_EXIT = 2;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_DAYS = 366;

/**
 * `argv` as `{ [flag]: value | true | string[], _: positional[] }`. `values` take one value each
 * (the last one given wins), `lists` take one value each and collect them (`--x a --x b`),
 * `multi` take every following argument up to the next `--flag` (at least one), `switches` take
 * none. Anything else starting with `--` is a CliError with `usage`.
 * @param {string[]} argv
 * @param {{ values?: string[], lists?: string[], multi?: string[], switches?: string[], usage: string }} spec
 * @returns {object}
 */
export function parseFlags(argv, { values = [], lists = [], multi = [], switches = [], usage }) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (switches.includes(arg)) out[arg] = true;
    else if (values.includes(arg) || lists.includes(arg)) {
      const value = argv[(i += 1)];
      if (typeof value !== 'string' || value.startsWith('--')) throw new CliError(usage);
      if (lists.includes(arg)) (out[arg] ??= []).push(value);
      else out[arg] = value;
    } else if (multi.includes(arg)) {
      const taken = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) taken.push(argv[(i += 1)]);
      if (taken.length === 0) throw new CliError(usage);
      out[arg] = [...(out[arg] ?? []), ...taken];
    } else if (typeof arg === 'string' && arg.startsWith('--')) throw new CliError(usage);
    else out._.push(arg);
  }
  return out;
}

/**
 * Every UTC day from `since` to `until`, both included, as `YYYY-MM-DD`; a CliError with `usage`
 * for a malformed day, an empty range or more than a year.
 * @param {string} since
 * @param {string} until
 * @param {string} usage
 * @returns {string[]}
 */
export function daysBetween(since, until, usage) {
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

/** The guild of `dataDir`: `given`, else the only directory under `guilds/`; else a CliError. */
export function resolveGuildId(dataDir, given) {
  if (typeof given === 'string' && given) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(given)) throw new CliError('the guild id is not valid');
    return given;
  }
  let names = [];
  try {
    names = fs.readdirSync(path.join(dataDir, 'guilds'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  if (names.length === 1) return names[0];
  throw new CliError(names.length === 0 ? `no guild under ${path.join(dataDir, 'guilds')}` : `several guilds under ${path.join(dataDir, 'guilds')}: give --guild`);
}

/**
 * The spend gate. `estimateUsd` is what the run would cost; `spend` the value of `--spend`
 * (undefined when absent). Returns `{ ok, text }`: `text` always states the estimate; `ok` only
 * when `--spend` is a non-negative number at least as large as the estimate (nothing to send
 * passes without it).
 * @param {{ estimateUsd: number, requests: number, spend?: string, detail?: string }} input
 * @returns {{ ok: boolean, text: string, budget: number|null }}
 */
export function spendGate({ estimateUsd, requests, spend, detail = '' }) {
  const usd = Number.isFinite(estimateUsd) && estimateUsd > 0 ? estimateUsd : 0;
  const head = `estimate: ${requests} model request(s), ~${usd.toFixed(2)} USD${detail ? ` (${detail})` : ''}`;
  if (requests <= 0) return { ok: true, text: head, budget: null };
  const budget = spend === undefined ? NaN : Number(spend);
  if (!Number.isFinite(budget) || budget < 0) return { ok: false, text: `${head}\nrefused: give --spend <usd> of at least ${usd.toFixed(2)} to run it`, budget: null };
  if (budget < usd) return { ok: false, text: `${head}\nrefused: --spend ${budget} is below the estimate`, budget };
  return { ok: true, text: head, budget };
}

/** Whether `url` (an `import.meta.url`) is the script node was started with. */
function isEntryPoint(url) {
  if (!process.argv[1]) return false;
  try {
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    return norm(fs.realpathSync(process.argv[1])) === norm(fs.realpathSync(fileURLToPath(url)));
  } catch {
    return false;
  }
}

/**
 * Run `main(argv)` when the module at `url` is the started script: a string result goes to
 * stdout; a CliError's message to stderr with its exit code; anything else to stderr, exit 1.
 * Every log line the engine writes to stdout meanwhile goes to stderr, so stdout carries the
 * result only.
 * @param {string} url
 * @param {(argv: string[]) => Promise<string>} main
 */
export function runCli(url, main) {
  if (!isEntryPoint(url)) return;
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
  main(process.argv.slice(2)).then(
    (text) => stdoutWrite(String(text ?? ''), () => process.exit(0)),
    (err) => {
      const message = err instanceof CliError ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
      process.stderr.write(`${message}\n`, () => process.exit(err instanceof CliError ? err.exitCode : 1));
    },
  );
}
