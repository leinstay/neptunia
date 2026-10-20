#!/usr/bin/env node
// Operations tool: the code catalogue (src/skills/codes.js) against the shipped labels
// (prompts/labels.json, the tracked layer only) and the contract's table of reason codes
// (docs/prompt-contract.md). Reads three files, sends nothing, spends nothing.
//
//   node tools/labels-catalogue.mjs --check    exits 1 and lists the mismatches (the CI step: npm run check:codes)
//   node tools/labels-catalogue.mjs --write    rewrites the generated table in docs/prompt-contract.md
//
// A code without its label, a label without its code, a label naming a value the code does not take,
// or a stale table is a mismatch.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE } from '../src/skills/codes.js';
import { TABLE_BEGIN, TABLE_END, catalogueProblems, renderCodesTable } from './lib/labels-catalogue.mjs';
import { CliError, parseFlags, runCli } from './lib/cli.mjs';

const USAGE = 'usage: node tools/labels-catalogue.mjs --check | --write';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The whole tool: the report as a string (empty problems: `ok`), or a CliError listing them.
 * @param {string[]} argv
 * @param {{ root?: string }} [options]
 * @returns {Promise<string>}
 */
export async function main(argv, { root = ROOT } = {}) {
  const flags = parseFlags(argv, { switches: ['--check', '--write'], usage: USAGE });
  if (flags['--check'] === flags['--write']) throw new CliError(USAGE);
  const docsPath = path.join(root, 'docs', 'prompt-contract.md');
  const labels = JSON.parse(fs.readFileSync(path.join(root, 'prompts', 'labels.json'), 'utf8'));
  let docs = fs.readFileSync(docsPath, 'utf8');
  if (flags['--write']) {
    const begin = docs.indexOf(TABLE_BEGIN);
    const end = docs.indexOf(TABLE_END);
    if (begin === -1 || end === -1) throw new CliError('docs/prompt-contract.md has no generated codes table (the two markers)');
    docs = `${docs.slice(0, begin)}${renderCodesTable(CATALOGUE)}${docs.slice(end + TABLE_END.length)}`;
    fs.writeFileSync(docsPath, docs);
  }
  const problems = catalogueProblems({ catalogue: CATALOGUE, labels, docs });
  if (problems.length > 0) throw new CliError(`${problems.length} mismatch(es) between the code catalogue, the labels and the contract:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  return `ok: ${Object.keys(CATALOGUE).length} codes, labels and contract agree`;
}

runCli(import.meta.url, main);
