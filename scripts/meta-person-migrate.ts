#!/usr/bin/env node
// Operations tool: the offline migration to the meta-person (src/memory/db/meta-person-migrate.ts). Stop the core
// first: the run claims the database as a core does (src/memory/db/open.ts#claimCore) and refuses while another core
// holds it. Exit 0 done, 1 refused, 2 usage.
//
//   node scripts/meta-person-migrate.ts --db <memory.db> --config <config.json> [--apply]
//
// Without `--apply` it runs the whole migration inside a transaction it rolls back, so the output is what an apply
// would do and nothing is written. With `--apply` it commits and writes the mapping of every old person id to its
// meta-person into `meta-person-map-<date>.json` beside the database, for the record. A run that finds nothing to do
// writes no file. The config is read only: `bot.ownerPerson` names the owner, and the edit it needs is printed for the
// operator to apply. The output is one JSON object of counts, the owner's edit and the path of the mapping file.

import fs from 'node:fs';
import path from 'node:path';
import { migrateMetaPersons } from '../src/memory/db/meta-person-migrate.ts';
import type { MetaPersonReport } from '../src/memory/db/meta-person-migrate.ts';
import { claimCore, openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';
import { ownerPersonOf } from '../src/tools/operations/grants.ts';
import { readLocalConfig } from '../src/tools/operations/shared.ts';

/** Rolls the dry run's transaction back. */
class DryRun extends Error {}

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? '' : (process.argv[at + 1] ?? '');
}

/** The code of a refusal; a database error carries its message, which names a constraint and never a row's content. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : 'failed';
  if (code === 'ERR_SQLITE_ERROR') return `${code}: ${message}`;
  return typeof code === 'string' ? code : message;
};

/** Whether a process lives; this process holds the claim it took a moment before, so its own pid counts as gone. */
function othersAlive(pid: unknown): boolean {
  if (Number(pid) === process.pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

/** The per-table counts that moved, as `before -> after`, and every table's count. */
function countLines(report: MetaPersonReport): Record<string, string> {
  const lines: Record<string, string> = {};
  const { before, after } = report.counts;
  for (const [table, was] of Object.entries(before)) {
    const now = after[table] ?? 0;
    lines[table] = was === now ? String(was) : `${String(was)} -> ${String(now)}`;
  }
  return lines;
}

function run(
  handle: MemoryHandle,
  { ownerPerson, at, write }: { ownerPerson: string | null; at: string; write: boolean }
): { report: MetaPersonReport; fk: number } {
  const db = dbOf(handle);
  let result: { report: MetaPersonReport; fk: number } | null = null;
  try {
    handle.transaction(() => {
      const report = migrateMetaPersons(db, { ownerPerson, at });
      result = { report, fk: db.prepare('PRAGMA foreign_key_check').all().length };
      if (!write) throw new DryRun();
    });
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  if (result === null) throw new Error('NO_RESULT');
  return result;
}

const nothingDone = (report: MetaPersonReport): boolean =>
  report.minted + report.promoted + report.linked + report.accounts + report.authorPerson === 0 &&
  Object.keys(report.changed).length === 0 &&
  Object.keys(report.dropped).length === 0;

function main(): number {
  const file = argument('db');
  const configFile = argument('config');
  if (!file || !configFile) {
    process.stderr.write('usage: meta-person-migrate --db <memory.db> --config <config.json> [--apply]\n');
    return 2;
  }
  const write = process.argv.includes('--apply');
  let ownerPerson: string | null;
  try {
    ownerPerson = ownerPersonOf(readLocalConfig(configFile));
  } catch {
    process.stderr.write('meta-person-migrate: refused, the config cannot be read\n');
    return 1;
  }
  let release: () => void = () => {};
  let handle: MemoryHandle;
  try {
    release = claimCore(file);
    handle = openMemoryDb(file, { alive: othersAlive });
  } catch (error) {
    release();
    process.stderr.write(`meta-person-migrate: refused, ${codeOf(error)}\n`);
    return 1;
  }
  try {
    const at = new Date().toISOString();
    const { report, fk } = run(handle, { ownerPerson, at, write });
    const map =
      write && !nothingDone(report) ? path.join(path.dirname(file), `meta-person-map-${at.slice(0, 10)}.json`) : null;
    if (map !== null)
      fs.writeFileSync(map, `${JSON.stringify({ at, persons: report.persons }, null, 2)}\n`, { mode: 0o600 });
    const owner = report.ownerPerson;
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: write ? 'apply' : 'dry-run',
          persons: Object.keys(report.persons).length,
          minted: report.minted,
          promoted: report.promoted,
          linked: report.linked,
          accounts: report.accounts,
          authorPerson: report.authorPerson,
          changed: report.changed,
          dropped: report.dropped,
          kept: report.kept,
          foreignKeyErrors: fk,
          ownerPersonEdit: owner !== null && owner.from !== owner.to ? { 'bot.ownerPerson': owner.to } : null,
          map,
          counts: countLines(report),
        },
        null,
        2
      )}\n`
    );
    return 0;
  } catch (error) {
    process.stderr.write(`meta-person-migrate: refused, ${codeOf(error)}\n`);
    return 1;
  } finally {
    handle.close();
    release();
  }
}

process.exit(main());
