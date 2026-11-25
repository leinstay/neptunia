#!/usr/bin/env node
// The replay stand: every mode of scripts/replay.ts run over an invented data folder, offline, with the clock, the
// random UUIDs and `Math.random` fixed (scripts/lib/stand.ts), to compare what two commits send and do.
//
//   node scripts/replay-stand.ts run --engine <checkout> --into <new dir> [--case <name>]...
//   node scripts/replay-stand.ts compare <first dir> <second dir>
//
// `run` builds the data folder with this checkout's code and runs each case on the checkout `--engine` names, its
// results in `<dir>/results.json`. `compare` prints one row per case and the parts of every paired request summed,
// and exits 1 when a case differs in more than the stdout of another command (a case `scripts/turn-replay.ts`
// ran on one side). Nothing it reads or writes is real: the server, the people and the lines are made up.

import fs from 'node:fs';
import path from 'node:path';
import { compareStands, compareTable, runStand } from './lib/stand.ts';
import { buildStandWorld } from './lib/stand-world.ts';
import type { CaseResult } from './lib/stand.ts';

const USAGE =
  'usage: node scripts/replay-stand.ts run --engine <checkout> --into <new dir> [--case <name>]...\n' +
  '       node scripts/replay-stand.ts compare <first dir> <second dir>';

const read = (dir: string): Array<CaseResult> =>
  JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')) as Array<CaseResult>;

async function main(argv: Array<string>): Promise<number> {
  const [command, ...rest] = argv;
  // The build of the world, run by `run` in a child process under the stand's preload.
  if (command === 'world' && rest.length === 2) {
    await buildStandWorld(rest[0], rest[1]);
    return 0;
  }
  if (command === 'compare' && rest.length === 2) {
    const rows = compareStands(read(rest[0]), read(rest[1]));
    process.stdout.write(`${compareTable(rows)}\n`);
    return rows.every((row) => row.result !== 'differs') ? 0 : 1;
  }
  if (command !== 'run') throw new Error(USAGE);
  let engine: string | null = null;
  let into: string | null = null;
  const cases: Array<string> = [];
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (value === undefined) throw new Error(USAGE);
    if (rest[i] === '--engine') engine = value;
    else if (rest[i] === '--into') into = value;
    else if (rest[i] === '--case') cases.push(value);
    else throw new Error(USAGE);
  }
  if (engine === null || into === null) throw new Error(USAGE);
  const results = await runStand(engine, path.resolve(into), cases.length > 0 ? cases : null);
  for (const result of results)
    process.stdout.write(`${result.name}: exit ${result.exit}, ${Object.keys(result.files).length} files\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
);
