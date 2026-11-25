// The schema of the meta-person: a meta-person is a `people` row marked `meta`,
// every row of `person_accounts` hangs under one, a line may carry no `author_person`, and the read adapter of
// src/memory/db/meta-person.ts answers from the new rows first and from the old verified links of `accounts` after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { accountsOfPerson, personOfAccount, profileOfAccount } from '../../../../src/memory/db/meta-person.ts';
import type { PersonAccount } from '../../../../src/memory/db/meta-person.ts';
import { newPersonId } from '../../../../src/memory/db/ids.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

type Handle = ReturnType<typeof openMemoryDb>;

function withDb(body: (db: Db) => void): void {
  const handle: Handle = openMemoryDb(path.join(tempDir('nep-meta-person-'), 'memory.db'));
  try {
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

const addMetaPerson = (db: Db, id: string): void => {
  db.prepare("INSERT INTO people (id, kind, meta) VALUES (?, 'person', 1)").run(id);
};

const addAccount = (db: Db, row: { id: string; person: string | null; iface: string; platformId: string }): void => {
  db.prepare(
    `INSERT INTO person_accounts (id, person_id, iface, platform_id, handle, display_name, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-11-08T00:00:00.000Z')`
  ).run(row.id, row.person, row.iface, row.platformId, `handle-${row.platformId}`, `Name ${row.platformId}`);
};

/** An old-shape account with its person in `accounts.person_id`, verified or proposed. */
const addOldAccount = (db: Db, id: string, native: string, person: string | null, link: string | null): void => {
  db.prepare(
    "INSERT INTO accounts (id, iface, native_id, native_key, kind, person_id, link) VALUES (?, 'chat', ?, ?, 'user', ?, ?)"
  ).run(id, native, native, person, link);
};

const addLegacyPerson = (db: Db, id: string): void => {
  db.prepare("INSERT INTO people (id, kind) VALUES (?, 'member')").run(id);
};

test('personOfAccount answers the meta-person of an account in the account table', () => {
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    assert.equal(personOfAccount(db, 'chat:1'), meta);
  });
});

test('personOfAccount prefers the account table over the old link of the same account', () => {
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    addLegacyPerson(db, 'person:chat:1');
    addOldAccount(db, 'chat:1', '1', 'person:chat:1', 'verified');
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    assert.equal(personOfAccount(db, 'chat:1'), meta);
  });
});

test('personOfAccount falls back to the verified old link', () => {
  withDb((db) => {
    addLegacyPerson(db, 'person:chat:1');
    addOldAccount(db, 'chat:1', '1', 'person:chat:1', 'verified');
    assert.equal(personOfAccount(db, 'chat:1'), 'person:chat:1');
  });
});

test('personOfAccount answers null for an account with an unverified old link or none at all', () => {
  withDb((db) => {
    addLegacyPerson(db, 'person:chat:1');
    addOldAccount(db, 'chat:1', '1', 'person:chat:1', 'proposed');
    addOldAccount(db, 'chat:2', '2', null, null);
    assert.equal(personOfAccount(db, 'chat:1'), null);
    assert.equal(personOfAccount(db, 'chat:2'), null);
    assert.equal(personOfAccount(db, 'chat:404'), null);
  });
});

test('accountsOfPerson lists the accounts of the table and the old verified links, each once', () => {
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    addAccount(db, { id: 'other:9', person: meta, iface: 'other', platformId: '9' });
    addOldAccount(db, 'chat:3', '3', meta, 'verified');
    addOldAccount(db, 'chat:1', '1', meta, 'verified');
    addOldAccount(db, 'chat:4', '4', meta, 'proposed');
    const expected: Array<PersonAccount> = [
      { id: 'chat:1', iface: 'chat', platformId: '1' },
      { id: 'chat:3', iface: 'chat', platformId: '3' },
      { id: 'other:9', iface: 'other', platformId: '9' },
    ];
    assert.deepEqual(accountsOfPerson(db, meta), expected);
  });
});

test('accountsOfPerson leaves out an account the table puts under another person', () => {
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    addLegacyPerson(db, 'person:chat:1');
    addOldAccount(db, 'chat:1', '1', 'person:chat:1', 'verified');
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    assert.deepEqual(accountsOfPerson(db, 'person:chat:1'), []);
  });
});

test('accountsOfPerson answers an empty list for a person with no account', () => {
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    assert.deepEqual(accountsOfPerson(db, meta), []);
  });
});

// Profile assembly: what the persona reads of a person seen on one account is the
// meta-person and that account's own fields, with every account of the person listed.

test('either account of a person reads as one profile that lists both accounts', () => {
  // Bug: each account reads as its own person, so one person writing from two accounts looks like two people.
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    addAccount(db, { id: 'other:9', person: meta, iface: 'other', platformId: '9' });
    const first = profileOfAccount(db, 'chat:1');
    const second = profileOfAccount(db, 'other:9');
    assert.equal(first?.personId, meta);
    assert.equal(second?.personId, meta);
    const listed = (profile: typeof first): Array<string> =>
      (profile?.accounts ?? []).map((account) => `${account.iface} ${account.platformId}`);
    assert.deepEqual(listed(first), ['chat 1', 'other 9']);
    assert.deepEqual(listed(second), ['chat 1', 'other 9']);
  });
});

test("the seen account's fields come from that account and the real name from the meta-person", () => {
  // Bug: the profile shows another account's handle or display name, or loses what the person holds.
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    db.prepare('UPDATE people SET real_name = ? WHERE id = ?').run(JSON.stringify({ name: 'Ilse Varga' }), meta);
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    addAccount(db, { id: 'other:9', person: meta, iface: 'other', platformId: '9' });
    const profile = profileOfAccount(db, 'other:9');
    assert.equal(profile?.seen?.handle, 'handle-9');
    assert.equal(profile?.seen?.displayName, 'Name 9');
    assert.equal(profile?.realName, 'Ilse Varga');
  });
});

test('an account linked the old way reads its person with the name its row holds', () => {
  // Bug: a database the migration has not moved yet gives a linked account no profile.
  withDb((db) => {
    addLegacyPerson(db, 'person:chat:3');
    addOldAccount(db, 'chat:3', '3', 'person:chat:3', 'verified');
    db.prepare('UPDATE accounts SET names = ? WHERE id = ?').run(JSON.stringify(['Jan', 'Janek']), 'chat:3');
    const profile = profileOfAccount(db, 'chat:3');
    assert.equal(profile?.personId, 'person:chat:3');
    assert.deepEqual(
      profile?.accounts.map((account) => [account.platformId, account.displayName]),
      [['3', 'Jan']]
    );
  });
});

test('an account with no person reads no profile', () => {
  withDb((db) => {
    addOldAccount(db, 'chat:5', '5', null, null);
    assert.equal(profileOfAccount(db, 'chat:5'), null);
  });
});
