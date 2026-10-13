#!/usr/bin/env node
// Operations tool: tally the owner's blind scores of a paired replay (tools/replay.mjs --pair).
// Reads the sheet (for its pair ids), the key (which side each pair showed first) and the
// scores the owner saved from the sheet (`{ "<pairId>": "first"|"second"|"even" }`); prints the
// verdict per pair in A/B terms and the totals. Reads three files, writes nothing, sends nothing.
//
//   node tools/replay-score.mjs sheet.html key.json scores.json

import fs from 'node:fs';
import { sheetPairIds, tallyScores } from './lib/pair.mjs';
import { CliError, runCli } from './lib/cli.mjs';

const USAGE = 'usage: node tools/replay-score.mjs <sheet.html> <key.json> <scores.json>';

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

runCli(import.meta.url, main);
