// Argument parsing and entry points for scripts. Offline movers use these helpers without loading runtime persona readers.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Untyped } from '../../src/tools/types.ts';

/** An operator-facing failure: printed as is, exit code `exitCode` (1 by default). */
export class CliError extends Error {
  exitCode: number;

  constructor(message: string, { exitCode = 1 }: { exitCode?: number } = {}) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** The flags `parseFlags` read: each by its `--name` (a string, `true`, or a list), the positional arguments under `_`. */
export type Flags = { _: Array<string>; [flag: string]: Untyped };

/**
 * `argv` as `{ [flag]: value | true | string[], _: positional[] }`. `values` take one value each
 * (the last one given wins), `lists` take one value each and collect them (`--x a --x b`),
 * `multi` take every following argument up to the next `--flag` (at least one), `switches` take
 * none. Anything else starting with `--` is a CliError with `usage`.
 */
export function parseFlags(
  argv: Array<string>,
  {
    values = [],
    lists = [],
    multi = [],
    switches = [],
    usage,
  }: { values?: Array<string>; lists?: Array<string>; multi?: Array<string>; switches?: Array<string>; usage: string }
): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (switches.includes(arg)) out[arg] = true;
    else if (values.includes(arg) || lists.includes(arg)) {
      const value = argv[(i += 1)];
      if (typeof value !== 'string' || value.startsWith('--')) throw new CliError(usage);
      if (lists.includes(arg)) ((out[arg] as Array<string> | undefined) ?? (out[arg] = [])).push(value);
      else out[arg] = value;
    } else if (multi.includes(arg)) {
      const taken = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) taken.push(argv[(i += 1)]);
      if (taken.length === 0) throw new CliError(usage);
      out[arg] = [...((out[arg] as Array<string> | undefined) ?? []), ...taken];
    } else if (typeof arg === 'string' && arg.startsWith('--')) throw new CliError(usage);
    else out._.push(arg);
  }
  return out;
}

/** Whether `url` (an `import.meta.url`) is the script node was started with. */
function isEntryPoint(url: string) {
  if (!process.argv[1]) return false;
  try {
    const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
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
 */
export function runCli(url: string, main: (argv: Array<string>) => Promise<string>): void {
  if (!isEntryPoint(url)) return;
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  // The redirect takes the three-argument form of `write`, which every caller of stdout here uses; the cast stands for
  // the overload list `process.stdout.write` has and a single arrow cannot spell.
  process.stdout.write = ((
    chunk: Uint8Array | string,
    encoding?: BufferEncoding,
    callback?: (err?: Error | null) => void
  ) => process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write;
  main(process.argv.slice(2)).then(
    (text) => stdoutWrite(String(text ?? ''), () => process.exit(0)),
    (err: unknown) => {
      const e = err as { name?: string; message?: string } | undefined; // anything a run rejected with
      const message = err instanceof CliError ? err.message : `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`;
      process.stderr.write(`${message}\n`, () => process.exit(err instanceof CliError ? err.exitCode : 1));
    }
  );
}
