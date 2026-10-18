#!/usr/bin/env node
// One-off operations tool: moves a config file from the flat `roles` map to `models.base` /
// `models.agents` (2026-10), the moves src/config.js#migrateModelsKeys makes and the loader
// asks for when it refuses a file still holding `roles` (src/config.js#assertModelsShape):
// `roles.voice` .. `roles.embedding` and `roles.byPurpose` -> `models.base.*`, `roles.drawing` ->
// `models.agents.drawing`, `roles["agent.web"|"agent.server"|"agent.dev"]` -> `models.agents.web|
// server|dev`, `roles["agent.advice"]` dropped; the old agent role keys of `llm.keyByRole` renamed
// the same way (`agent.advice` dropped).
//
//   node tools/migrate-models-config.mjs <config.local.json> [--write]
//
// A dry run by default: prints the moves (key names only, never a value) and writes nothing.
// `--write` rewrites the file in place (two-space JSON, through a temporary file renamed over it,
// the file's mode kept). Refuses, writing nothing, when `roles` holds a key with no new home or
// a move would overwrite a key the file already sets. Sends nothing, spends nothing, never reads
// or writes data/.

import fs from 'node:fs';
import path from 'node:path';
import { migrateModelsKeys } from '../src/config.js';
import { parseFlags, CliError, runCli } from './lib/cli.mjs';

const USAGE = 'usage: node tools/migrate-models-config.mjs <config.local.json> [--write]';

/**
 * The whole tool: the report as a string.
 * @param {string[]} argv
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<string>}
 */
export async function main(argv, { cwd = process.cwd() } = {}) {
  const flags = parseFlags(argv, { switches: ['--write'], usage: USAGE });
  if (flags._.length !== 1) throw new CliError(USAGE);
  const file = path.resolve(cwd, flags._[0]);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`migrate-models-config: cannot read ${file} (${err?.code ?? 'read'})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`migrate-models-config: ${file} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError(`migrate-models-config: ${file} is not a JSON object`);

  const { config, moves, unknown, conflicts } = migrateModelsKeys(parsed);
  const lines = moves.map(({ from, to }) => (to === null ? `drop ${from}` : `${from} -> ${to}`));
  if (unknown.length > 0 || conflicts.length > 0) {
    const problems = [
      ...unknown.map((key) => `${key}: no new key`),
      ...conflicts.map((move) => `${move}: the new key is already set`),
    ];
    throw new CliError(`migrate-models-config: ${file} not migrated, nothing written:\n${problems.join('\n')}`);
  }
  if (moves.length === 0) return `${file}: nothing to migrate\n`;
  if (!flags['--write']) return `${file}: dry run, nothing written (--write to apply)\n${lines.join('\n')}\n`;

  const mode = fs.statSync(file).mode & 0o777;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw new CliError(`migrate-models-config: cannot write ${file} (${err?.code ?? 'write'})`);
  }
  return `${file}: migrated\n${lines.join('\n')}\n`;
}

runCli(import.meta.url, main);
