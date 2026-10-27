#!/usr/bin/env node
// Writes the config keys that moved when the skills became tools into a local config file (src/config-moves.ts: the
// settings under `skills.*`, `features.skills`, `features.skillsDiscovery` and the grant on `skills.describe`). The
// engine applies the same moves when it loads the file, so an unmigrated file still works and logs one warning line per
// load; this tool settles the file itself.
//
//   node tools/config-migrate.mjs --dry-run [--file <config.local.json>]
//   node tools/config-migrate.mjs --apply [--file <config.local.json>]
//
// The file is `--file`, else `config.local.json` of `NEPTUNIA_PRIVATE_DIR`, else of the checkout (src/paths.js).
// `--dry-run` prints each move as `from -> to` and writes nothing. A second run finds nothing to move.

import fs from 'node:fs';
import path from 'node:path';
import { moveConfigKeys } from '../src/config-moves.ts';
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.mjs';

const USAGE = 'usage: node tools/config-migrate.mjs --dry-run|--apply [--file <config.local.json>]';

/**
 * @param {string[]} argv
 * @returns {Promise<string>}
 */
export function main(argv) {
  return Promise.resolve(migrate(argv));
}

/**
 * @param {string[]} argv
 * @returns {string}
 */
function migrate(argv) {
  /** @type {Record<string, unknown>} */
  const flags = parseFlags(argv, { values: ['--file'], switches: ['--dry-run', '--apply'], usage: USAGE });
  if (flags['--dry-run'] === flags['--apply'])
    throw new CliError(`give exactly one of --dry-run and --apply\n${USAGE}`);
  const file =
    typeof flags['--file'] === 'string'
      ? path.resolve(flags['--file'])
      : path.join(privateDirOf(process.cwd()), 'config.local.json');
  if (!fs.existsSync(file)) return `${file} does not exist: nothing to move\n`;
  const text = fs.readFileSync(file, 'utf8').trim();
  if (text === '') return `${file} is empty: nothing to move\n`;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CliError(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); nothing was changed`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new CliError(`${file} must hold a JSON object; nothing was changed`);
  const { config, moved, shadowed } = moveConfigKeys(parsed);
  if (moved.length === 0 && shadowed.length === 0) return 'nothing to move\n';
  const lines = [
    ...moved.map((move) => `${move.from} -> ${move.to}`),
    ...shadowed.map((move) => `${move.from} -> ${move.to} (already set; the old key is dropped)`),
  ];
  if (flags['--apply']) fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return `${lines.join('\n')}\n`;
}

runCli(import.meta.url, main);
