#!/usr/bin/env node
// Operations tool: the persona's journal per day as markdown, so a change can be measured on
// what the bot actually did. Reads the guild's journal day files and nothing else
// (data/guilds/<guildId>/journal/<YYYY-MM-DD>.jsonl); writes nothing, sends nothing, spends
// nothing. The numbers and their layout come from tools/lib/report.mjs.
//
//   cd /opt/neptunia-bot && node tools/journal-report.mjs --since 2026-10-13 [--until 2026-10-14] [--guild <id>] [--data <dir>]
//
// `--until` defaults to today (UTC); `--guild` may be left out when data/guilds holds one guild;
// `--data` defaults to <cwd>/data (a snapshot directory works too). A line that does not parse
// (a torn tail) is counted and skipped. Prints counts only, never a record's text.

import fs from 'node:fs';
import path from 'node:path';
import { renderDay, tally } from './lib/report.mjs';
import { parseFlags, daysBetween, defaultDataDir, resolveGuildId, CliError, runCli } from './lib/cli.mjs';

const USAGE = 'usage: node tools/journal-report.mjs --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--guild <id>] [--data <dir>]';

/**
 * The whole tool: the markdown report as a string.
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => number }} [options]
 * @returns {Promise<string>}
 */
export async function main(argv, { cwd = process.cwd(), now = Date.now } = {}) {
  const flags = parseFlags(argv, { values: ['--since', '--until', '--guild', '--data'], usage: USAGE });
  if (!flags['--since']) throw new CliError(USAGE);
  const dataDir = flags['--data'] !== undefined ? path.resolve(cwd, flags['--data']) : defaultDataDir(cwd);
  const guildId = resolveGuildId(dataDir, flags['--guild']);
  const days = daysBetween(flags['--since'], flags['--until'] ?? new Date(now()).toISOString().slice(0, 10), USAGE);
  const dir = path.join(dataDir, 'guilds', guildId, 'journal');
  const out = [`# Journal report, guild ${guildId}, ${days[0]} to ${days.at(-1)}`, ''];
  for (const day of days) {
    const file = path.join(dir, `${day}.jsonl`);
    if (!fs.existsSync(file)) {
      out.push(`## ${day}`, '', 'no journal file', '');
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const records = [];
    let unreadable = 0;
    const lines = text.split('\n');
    // The last piece after the final newline is empty, or a torn tail the bot moves aside on its next open.
    if (lines.at(-1) !== '') unreadable += 1;
    for (const line of lines.slice(0, -1)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        unreadable += 1;
      }
    }
    const t = tally(records);
    t.fileBytes = fs.statSync(file).size;
    out.push(renderDay(day, t).trimEnd());
    if (unreadable > 0) out.push('', `Unreadable lines: ${unreadable}`);
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

runCli(import.meta.url, main);
