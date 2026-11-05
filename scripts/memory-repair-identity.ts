#!/usr/bin/env node
// Operations tool: repairs the identities of an install that ran before the observation knew her own accounts and the
// owner's command line. Stop the core first: the run takes the writer's lock and writes through the same functions the
// observation uses (src/memory/db/identity-links.ts). Exit 0 done, 1 refused, 2 usage.
//
//   node scripts/memory-repair-identity.ts --db <memory.db> --owner-person <person id> [--apply]
//
// Without `--apply` it runs the whole repair inside a transaction it rolls back, so the counts are what an apply would
// do and nothing is written. Run again it finds nothing, so a second run is harmless. The output is counts only.
//
// In one transaction:
//   - the rows the command line stored under `cli/global` move to its native authority `cli/local`;
//   - each account of the command line is linked to the owner person by the owner's word, her proposals for it are
//     closed, and a tentative person she made for it merges into the owner unless that person holds a verified account
//     of someone else;
//   - each account of hers (`kind` `self`) is linked to `person:self`;
//   - the `link`, `linked_by` and `linked_at` columns of every account are copied again from its live verified link,
//     the one source of truth (an older profile write reset them).
// No row changes its audience: a line, a fact or a feeling stays in the conversation it came from.

import {
  adoptNativeAuthority,
  OWNER_CONSOLE_IFACE,
  linkOwnerAccount,
  linkSelfAccount,
} from '../src/memory/db/identity-links.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';

type Counts = {
  authorityRows: number;
  consoleAccounts: number;
  consoleLinked: number;
  peopleMerged: number;
  selfLinked: number;
  linkColumns: number;
};

/** Rolls the dry run's transaction back. */
class DryRun extends Error {}

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? '' : (process.argv[at + 1] ?? '');
}

const idsOf = (db: Db, sql: string): Array<string> =>
  db
    .prepare(sql)
    .all()
    .map((row) => String(row.id));

/** The account columns copied from the live verified links, where they differ; returns how many accounts changed. */
function copyLinkColumns(db: Db): number {
  return Number(
    db
      .prepare(
        `UPDATE accounts SET person_id = l.person_id, link = 'verified', linked_by = l.by, linked_at = l.valid_from_at
         FROM (SELECT account_id, person_id, by, valid_from_at FROM account_person_links
               WHERE state = 'verified' AND valid_to_at IS NULL) AS l
         WHERE l.account_id = accounts.id AND (accounts.person_id IS NOT l.person_id OR accounts.link IS NOT 'verified'
           OR accounts.linked_by IS NOT l.by OR accounts.linked_at IS NOT l.valid_from_at)`
      )
      .run().changes
  );
}

function repair(db: Db, owner: string, at: string): Counts {
  const moved = adoptNativeAuthority(db, OWNER_CONSOLE_IFACE);
  const counts: Counts = {
    authorityRows: Object.values(moved).reduce((sum, one) => sum + one, 0),
    consoleAccounts: 0,
    consoleLinked: 0,
    peopleMerged: 0,
    selfLinked: 0,
    linkColumns: 0,
  };
  for (const id of idsOf(db, `SELECT id FROM accounts WHERE iface = 'cli' AND retired_at IS NULL ORDER BY id`)) {
    const done = linkOwnerAccount(db, id, owner, at);
    counts.consoleAccounts += 1;
    if (done.linked) counts.consoleLinked += 1;
    counts.peopleMerged += done.merged.length;
  }
  for (const id of idsOf(db, "SELECT id FROM accounts WHERE kind = 'self' AND retired_at IS NULL ORDER BY id"))
    if (linkSelfAccount(db, id, at)) counts.selfLinked += 1;
  counts.linkColumns = copyLinkColumns(db);
  return counts;
}

function main(): number {
  const file = argument('db');
  const owner = argument('owner-person');
  if (!file || !owner) {
    process.stderr.write('usage: memory-repair-identity --db <memory.db> --owner-person <person id> [--apply]\n');
    return 2;
  }
  const write = process.argv.includes('--apply');
  let handle: MemoryHandle;
  try {
    handle = openMemoryDb(file);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    process.stderr.write(`memory-repair-identity: refused, ${typeof code === 'string' ? code : 'not opened'}\n`);
    return 1;
  }
  try {
    const db = dbOf(handle);
    if (!db.prepare('SELECT 1 AS ok FROM people WHERE id = ?').get(owner)) {
      process.stderr.write('memory-repair-identity: refused, UNKNOWN_PERSON\n');
      return 1;
    }
    const at = new Date().toISOString();
    let counts: Counts | null = null;
    try {
      handle.transaction(() => {
        counts = repair(db, owner, at);
        if (!write) throw new DryRun();
      });
    } catch (error) {
      if (!(error instanceof DryRun)) throw error;
    }
    process.stdout.write(`${JSON.stringify({ mode: write ? 'apply' : 'dry-run', ...(counts ?? {}) })}\n`);
    return 0;
  } finally {
    handle.close();
  }
}

process.exit(main());
