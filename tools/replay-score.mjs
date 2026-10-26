#!/usr/bin/env node
// Operations tool: tally the owner's blind scores of a paired replay (tools/replay.mjs --pair).
// Reads the sheet (for its pair ids), the key (which side each pair showed first) and the
// scores the owner saved from the sheet (`{ "<pairId>": "first"|"second"|"even" }`); prints the
// verdict per pair in A/B terms and the totals. Reads three files, writes nothing, sends nothing.
//
//   node tools/replay-score.mjs sheet.html key.json scores.json
//
// `--search`: tallies a filled blind sheet of tools/search-compare.mjs instead (its `blind.md`,
// the grades on each query's `score:` or `best:` line, and its `blind-key.json`): per engine the
// wins, ties and losses against Brave (tools/lib/search-compare.mjs#tallySearchScores).
//
//   node tools/replay-score.mjs --search blind.md blind-key.json

import fs from 'node:fs';
import { sheetPairIds, tallyScores } from './lib/pair.mjs';
import { CliError, runCli } from './lib/cli.mjs';
import { parseBlindScores, renderSearchTally, tallySearchScores } from './lib/search-compare.mjs';

const USAGE =
  'usage: node tools/replay-score.mjs <sheet.html> <key.json> <scores.json>\n       node tools/replay-score.mjs --search <blind.md> <blind-key.json>';

/** A JSON file's value, or a CliError naming the file. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`${file}: ${err?.code === 'ENOENT' ? 'not found' : 'not valid JSON'}`);
  }
}

/**
 * The whole tool: the tally as markdown.
 * @param {string[]} argv
 * @returns {Promise<string>}
 */
export async function main(argv) {
  if (argv[0] === '--search') return searchMain(argv.slice(1));
  if (argv.length !== 3 || argv.some((arg) => arg.startsWith('--'))) throw new CliError(USAGE);
  const [sheetFile, keyFile, scoresFile] = argv;
  let html;
  try {
    html = fs.readFileSync(sheetFile, 'utf8');
  } catch {
    throw new CliError(`${sheetFile}: not found`);
  }
  const ids = sheetPairIds(html);
  if (ids.length === 0) throw new CliError(`${sheetFile}: no pairs in this sheet`);
  const key = readJson(keyFile);
  let result;
  try {
    result = tallyScores({ ids, key, scores: readJson(scoresFile) });
  } catch (err) {
    throw new CliError(`${err.message}: the sheet and the key are not of the same run`);
  }
  const { A, B, even, unscored } = result.totals;
  const out = [
    '# Replay pair scores',
    '',
    `A: ${key.a ?? 'A'}`,
    `B: ${key.b ?? 'B'}`,
    '',
    '| pair | better |',
    '| --- | --- |',
    ...result.pairs.map((p) => `| ${p.id} | ${p.verdict} |`),
    '',
    `Totals: A better ${A}, B better ${B}, even ${even}, unscored ${unscored} (of ${ids.length})`,
  ];
  return `${out.join('\n')}\n`;
}

/** `--search`: the blind sheet of tools/search-compare.mjs tallied against its key, as markdown. */
function searchMain(argv) {
  if (argv.length !== 2 || argv.some((arg) => arg.startsWith('--'))) throw new CliError(USAGE);
  const [sheetFile, keyFile] = argv;
  let markdown;
  try {
    markdown = fs.readFileSync(sheetFile, 'utf8');
  } catch {
    throw new CliError(`${sheetFile}: not found`);
  }
  const key = readJson(keyFile);
  if (!key || typeof key !== 'object' || Array.isArray(key)) throw new CliError(`${keyFile}: not a blind key`);
  try {
    return renderSearchTally(tallySearchScores({ key, scores: parseBlindScores(markdown) }));
  } catch (err) {
    throw new CliError(`${err.message}: the sheet and the key are not of the same run`);
  }
}

runCli(import.meta.url, main);
