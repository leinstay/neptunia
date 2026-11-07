#!/usr/bin/env node
// Operations tool: the memory audit (src/memory/db/audit.ts) over a database, read-only, counts only. Safe on a running core:
// it opens a read connection and takes no lock. Exit 0 clean, 1 with a finding, 2 usage or a database that cannot be read.
//
//   node scripts/memory-audit.ts --db <memory.db> [--describe-after-lines <n>]
//
// The threshold of `placeUndescribed` is `memory.describeAfterLines` of config/config.json unless the flag gives one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditMemory, auditSettingsOf } from '../src/memory/db/audit.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';

export { auditMemory };

/** The audit's settings: the flag's threshold, else the tracked config's. */
function settingsOf(argv: ReadonlyArray<string>): ReturnType<typeof auditSettingsOf> {
  const at = argv.indexOf('--describe-after-lines');
  if (at !== -1) return auditSettingsOf({ memory: { describeAfterLines: Number(argv[at + 1]) } });
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'config.json');
  try {
    return auditSettingsOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return auditSettingsOf(null);
  }
}

function main(): number {
  const at = process.argv.indexOf('--db');
  const file = at === -1 ? '' : (process.argv[at + 1] ?? '');
  if (file === '' || !fs.existsSync(file)) {
    process.stderr.write('usage: memory-audit --db <memory.db>\n');
    return 2;
  }
  let handle: ReturnType<typeof openMemoryDb>;
  try {
    handle = openMemoryDb(file, { readOnly: true });
  } catch {
    process.stderr.write('memory-audit: the database cannot be read\n');
    return 2;
  }
  try {
    const report = auditMemory(dbOf(handle), settingsOf(process.argv));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.findings > 0 ? 1 : 0;
  } finally {
    handle.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
