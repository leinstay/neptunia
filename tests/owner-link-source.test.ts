// The owner check reads one source of truth: the live row of `account_person_links` the owner wrote. The account's
// `link` and `linked_by` columns are a copy that a profile write once reset, so they decide nothing. Real temporary
// databases, synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withIface } from '../src/memory/db/current-iface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createOwnerAccounts } from '../src/memory/db/person-links.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { addAccount } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const OWNER = 'person:0a0a0a0a-synthetic';

function withDb(body: (db: Db) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-owner-source-'), 'memory.db'));
  try {
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

const boundOn = (db: Db, native: string): boolean =>
  withIface('discord', () =>
    createOwnerAccounts({ database: () => db, home: () => 'discord' }).isBoundTo(OWNER, native)
  );

test('keeps the owner his rights when a profile write emptied the link columns of his account', () => {
  // Bug: an older unit write set `linked_by` to null on every flush, and the check read that column, so the owner lost
  // his rights on his own account at his next line while his link row still said he bound it.
  withDb((db) => {
    addAccount(db, { id: 'account:o1', iface: 'discord', authority: 'discord/global', native: 'o1', person: OWNER });
    db.prepare("UPDATE accounts SET linked_by = NULL, linked_at = NULL WHERE id = 'account:o1'").run();
    assert.equal(boundOn(db, 'o1'), true);
  });
});

test('refuses an account whose columns name the owner while its live link is only her proposal', () => {
  // Bug: the columns and the link rows disagree, and the copy wins over the record of who linked the account.
  withDb((db) => {
    addAccount(db, {
      id: 'account:o2',
      iface: 'discord',
      authority: 'discord/global',
      native: 'o2',
      person: OWNER,
      link: 'proposed',
    });
    db.prepare("UPDATE accounts SET person_id = ?, link = 'verified', linked_by = 'owner' WHERE id = 'account:o2'").run(
      OWNER
    );
    db.prepare("UPDATE account_person_links SET by = 'her' WHERE account_id = 'account:o2'").run();
    assert.equal(boundOn(db, 'o2'), false);
  });
});

test('refuses an account whose owner link was closed', () => {
  withDb((db) => {
    addAccount(db, { id: 'account:o3', iface: 'discord', authority: 'discord/global', native: 'o3', person: OWNER });
    db.prepare(
      "UPDATE account_person_links SET valid_to_at = '2026-11-02T00:00:00.000Z' WHERE account_id = 'account:o3'"
    ).run();
    assert.equal(boundOn(db, 'o3'), false);
  });
});
