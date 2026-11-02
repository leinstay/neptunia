#!/usr/bin/env node
// The one-time move of a deployment's model keys into the key store (src/keys/import.ts), run once at the deploy that
// switches the core to `keys.json`. It reads `<private>/.env` and the effective settings (config/config.json with the
// private layer over it), writes `<private>/keys.json` (mode 600) and prints what it moved by name: the core keys, the
// extra keys with the variable each came from, the roles bound, and what it left out with the reason. It prints no
// value and leaves `.env` and the settings as they are; `scripts/config-migrate.ts` drops the old settings. A store that
// already holds a key is refused with one line and an exit code of 1.
//
//   node scripts/keys-import.ts            (the private folder is NEPTUNIA_PRIVATE_DIR, else the checkout)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, readConfig } from '../src/config.ts';
import { importKeys } from '../src/keys/import.ts';
import type { ImportReport } from '../src/keys/import.ts';
import { KeysError, createKeyStore } from '../src/keys/store.ts';
import { CliError, privateDirOf, runCli } from './lib/cli.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The report as the lines the owner reads: names only. */
function reportText(report: ImportReport): string {
  const lines = [
    `core keys: ${report.core.length === 0 ? 'none' : report.core.join(', ')}`,
    ...report.extra.map((row) => `extra key ${row.name} from ${row.from}`),
    ...report.bound.map((row) => `role ${row.role} bound to ${row.name}`),
    ...report.skipped.map((row) => `left out: ${row.what} (${row.reason})`),
  ];
  return `${lines.join('\n')}\n`;
}

/** The import over the private folder: the report text, or a CliError naming why nothing was written. */
function run(argv: Array<string>): string {
  if (argv.length > 0) throw new CliError('usage: node scripts/keys-import.ts');
  const privateDir = privateDirOf(ROOT);
  const file = path.join(privateDir, '.env');
  const env = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  const config = readConfig(ROOT, { privateDir });
  try {
    return reportText(importKeys({ env, config, store: createKeyStore({ privateDir }) }));
  } catch (err) {
    if (err instanceof KeysError && err.code === 'store-not-empty')
      throw new CliError('keys.json already holds a key: nothing was imported');
    throw err;
  }
}

export const main = (argv: Array<string>): Promise<string> => Promise.resolve().then(() => run(argv));

runCli(import.meta.url, main);
