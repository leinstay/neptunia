#!/usr/bin/env node
// Operations tool: the per-day numbers of tools/journal-report.mjs from the operational log, for
// the days before the journal existed (the baseline). Reads `journalctl -o cat` lines from stdin
// or from `--file`; writes nothing, sends nothing, spends nothing.
//
//   journalctl -u neptunia-bot -o cat --since 2026-10-06 | node tools/request-report.mjs [--since <day>] [--until <day>]
//   node tools/request-report.mjs --file /path/to/log.txt
//
// Each `turn: model answered` line gives its trigger, its usage (prompt, cached, completion
// tokens) and its `budget` (the dropped items per section). What the old log lacks prints
// `N/A`: outcomes other than answered, reasons, actions, limits, own messages, file bytes.
// Lines are parsed one by one; a line that is not the engine's JSON is skipped. Prints counts
// only, never message contents.

import fs from 'node:fs';
import readline from 'node:readline';
import { renderDay, tallyLog } from './lib/report.mjs';
import { parseFlags, CliError, runCli } from './lib/cli.mjs';

const USAGE = 'usage: node tools/request-report.mjs [--file <log>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>]   (else the log on stdin)';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Every line of `stream`. */
async function readLines(stream) {
  const lines = [];
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) lines.push(line);
  return lines;
}

/**
 * The whole tool: the markdown report as a string.
 * @param {string[]} argv
 * @param {{ stdin?: NodeJS.ReadableStream }} [options]
 * @returns {Promise<string>}
 */
export async function main(argv, { stdin = process.stdin } = {}) {
  const flags = parseFlags(argv, { values: ['--file', '--since', '--until'], usage: USAGE });
  for (const key of ['--since', '--until']) if (flags[key] !== undefined && !DAY_RE.test(flags[key])) throw new CliError(USAGE);
  if (!flags['--file'] && stdin.isTTY) throw new CliError(USAGE);
  const stream = flags['--file'] ? fs.createReadStream(flags['--file'], { encoding: 'utf8' }) : stdin;
  const days = tallyLog(await readLines(stream));
  const kept = [...days.keys()].sort().filter((day) => (!flags['--since'] || day >= flags['--since']) && (!flags['--until'] || day <= flags['--until']));
  if (kept.length === 0) return 'no `turn: model answered` lines in the given range\n';
  const out = [`# Request report from the log, ${kept[0]} to ${kept.at(-1)}`, ''];
  for (const day of kept) out.push(renderDay(day, days.get(day)).trimEnd(), '');
  return `${out.join('\n').trimEnd()}\n`;
}

runCli(import.meta.url, main);
