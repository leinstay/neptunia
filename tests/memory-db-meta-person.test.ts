// The schema of the meta-person (plan 2026-11-08-meta-person, slice 3): a meta-person is a `people` row marked `meta`,
// every row of `person_accounts` hangs under one, a line may carry no `author_person`, and the read adapter of
// src/memory/db/meta-person.ts answers from the new rows first and from the old verified links of `accounts` after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.ts';
import { accountsOfPerson, personOfAccount } from '../src/memory/db/meta-person.ts';
import type { PersonAccount } from '../src/memory/db/meta-person.ts';
import { newPersonId } from '../src/memory/db/ids.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

type Handle = ReturnType<typeof openMemoryDb>;

function withDb(body: (db: Db) => void): void {
  const handle: Handle = openMemoryDb(path.join(tempDir('nep-meta-person-'), 'memory.db'));
  try {
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

const columnsOf = (db: Db, table: string): Array<string> =>
  db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => String(row.name));

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

test('a fresh database holds the meta flag, the account table and the author person of a line', () => {
  withDb((db) => {
    assert.ok(columnsOf(db, 'people').includes('meta'));
    const accountColumns = columnsOf(db, 'person_accounts');
    for (const column of [
      'id',
      'person_id',
      'iface',
      'platform_id',
      'generation',
      'handle',
      'display_name',
      'avatar',
      'profile_text',
    ])
      assert.ok(accountColumns.includes(column), column);
    assert.ok(columnsOf(db, 'sources').includes('author_person'));
    const indexed = db
      .prepare("SELECT name FROM pragma_index_list('sources')")
      .all()
      .map((row) => String(row.name))
      .some((name) =>
        db
          .prepare(`SELECT name FROM pragma_index_info('${name}')`)
          .all()
          .some((column) => column.name === 'author_person')
      );
    assert.equal(indexed, true);
  });
});

test('refuses an account with no person', () => {
  withDb((db) => {
    assert.throws(() => addAccount(db, { id: 'chat:1', person: null, iface: 'chat', platformId: '1' }), /NOT NULL/);
  });
});

test('refuses an account whose person nobody stored', () => {
  withDb((db) => {
    assert.throws(
      () => addAccount(db, { id: 'chat:1', person: newPersonId(), iface: 'chat', platformId: '1' }),
      /FOREIGN KEY/
    );
  });
});

test('refuses an account whose person is not a meta-person', () => {
  withDb((db) => {
    addLegacyPerson(db, 'person:chat:1');
    assert.throws(
      () => addAccount(db, { id: 'chat:1', person: 'person:chat:1', iface: 'chat', platformId: '1' }),
      /ACCOUNT_PARENT_NOT_META/
    );
  });
});

test('refuses moving an account under a person that is not a meta-person', () => {
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    addLegacyPerson(db, 'person:chat:2');
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    assert.throws(
      () => db.prepare("UPDATE person_accounts SET person_id = 'person:chat:2' WHERE id = 'chat:1'").run(),
      /ACCOUNT_PARENT_NOT_META/
    );
  });
});

test('refuses a second account with the same interface and platform id', () => {
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    assert.throws(() => addAccount(db, { id: 'chat:1b', person: meta, iface: 'chat', platformId: '1' }), /UNIQUE/);
  });
});

test('stores a line with no author person', () => {
  withDb((db) => {
    db.prepare(
      "INSERT INTO sources (id, kind, iface, place_id, text) VALUES ('src:anon', 'seen', 'chat', 'p', 'hi')"
    ).run();
    const row = db.prepare("SELECT author_person FROM sources WHERE id = 'src:anon'").get();
    assert.equal(row?.author_person, null);
  });
});

test('refuses a line whose author person nobody stored', () => {
  withDb((db) => {
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO sources (id, kind, iface, place_id, text, author_person) VALUES ('src:x', 'seen', 'chat', 'p', 'hi', ?)"
          )
          .run(newPersonId()),
      /FOREIGN KEY/
    );
  });
});

test('the upgrade from the version before keeps every row and fills no account and no author person', () => {
  const file = path.join(tempDir('nep-meta-person-up-'), 'memory.db');
  const before = MIGRATIONS.length - 1;
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, before) });
  const oldDb = dbOf(old);
  addLegacyPerson(oldDb, 'person:chat:1');
  addOldAccount(oldDb, 'chat:1', '1', 'person:chat:1', 'verified');
  oldDb
    .prepare(
      "INSERT INTO sources (id, kind, iface, place_id, author_account, text) VALUES ('src:1', 'seen', 'chat', 'p', 'chat:1', 'hi')"
    )
    .run();
  old.close();
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    assert.equal(schemaVersion(db), MIGRATIONS.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM person_accounts').get()?.n, 0);
    assert.deepEqual(
      { ...db.prepare("SELECT author_account, author_person FROM sources WHERE id = 'src:1'").get() },
      { author_account: 'chat:1', author_person: null }
    );
    assert.equal(db.prepare("SELECT meta FROM people WHERE id = 'person:chat:1'").get()?.meta, 0);
    assert.equal(personOfAccount(db, 'chat:1'), 'person:chat:1');
  } finally {
    handle.close();
  }
});

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
