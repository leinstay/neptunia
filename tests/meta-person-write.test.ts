// The writers of the meta-person (plan 2026-11-08-meta-person, slice 5): a member seen for the first time gets a
// meta-person and an account row under it, every new line names its author's meta-person, the profile of a member is
// written to the meta-person and the account's own fields to `person_accounts`, and a link or a merge keeps the account
// row and the lines' author person current. A database whose people still carry interface-shaped ids keeps working:
// such a person is reached through the adapter's fallback. Synthetic ids and text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observe, OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { personOfAccount } from '../src/memory/db/meta-person.ts';
import { applyPersonLinkWrite } from '../src/memory/db/person-links.ts';
import { mergePersonInto } from '../src/memory/db/person-merge.ts';
import { peopleOf } from '../src/memory/db/session-people.ts';
import { accountCollection } from '../src/memory/db/storage-keys.ts';
import { applyUnitUpdate } from './fixtures/memory-db/unit-writes.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';

const AT = '2026-11-08T10:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
/** A minted meta-person id: `person:` and a uuid, never an interface and a native id. */
const UUID_PERSON = /^person:[0-9a-f]{8}-[0-9a-f]{4}-/;
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const OPTS = { now: () => NOW, log: quiet };
const GROUP = { authority: 'telegram/global', key: 'chat:-100', kind: 'room', chat: 'group', title: 'a group' };

type Author = { kind: string; key: string; display?: string; token_kind?: string };

/** One line of a group, by an account or a participant. */
const line = (key: string, author: Author): Row => ({
  v: OBSERVATION_VERSION,
  iface: 'telegram',
  authority: 'telegram/global',
  native: { kind: 'message', key, revision: 1 },
  place: GROUP,
  author,
  occurredAt: AT,
  observedAt: AT,
  text: `synthetic line ${key}`,
});

function withDb(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    body(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

/** Observes a line and answers its source id. */
function see(handle: MemoryHandle, key: string, author: Author): string {
  const result = observe(handle, line(key, author), OPTS);
  assert.equal(result.ok, true, JSON.stringify(result));
  return String(result.sourceId);
}

const accountOfLine = (db: Db, source: string): string =>
  String(db.prepare('SELECT author_account FROM sources WHERE id = ?').get(source)?.author_account);

const authorPersonOf = (db: Db, source: string): unknown =>
  db.prepare('SELECT author_person FROM sources WHERE id = ?').get(source)?.author_person ?? null;

const accountRow = (db: Db, account: string): Row | undefined =>
  db.prepare('SELECT * FROM person_accounts WHERE id = ?').get(account);

const isMeta = (db: Db, person: unknown): boolean =>
  db.prepare('SELECT meta FROM people WHERE id = ?').get(person)?.meta === 1;

test('a member seen for the first time gets a meta-person and an account row under it', () => {
  // Bug: a new account is stored with no person, or with a person spelled from its interface and native id.
  withDb((db, handle) => {
    const source = see(handle, '1', { kind: 'account', key: '700', display: 'Ilse' });
    const account = accountOfLine(db, source);
    const person = personOfAccount(db, account);
    assert.match(String(person), UUID_PERSON);
    assert.equal(isMeta(db, person), true);
    const row = accountRow(db, account);
    assert.equal(row?.person_id, person);
    assert.equal(row?.iface, 'telegram');
    assert.equal(row?.platform_id, '700');
    assert.equal(row?.display_name, 'Ilse');
  });
});

test("a new line names its author's meta-person", () => {
  // Bug: `sources.author_person` stays empty, so a reader needs the account link to reach the person.
  withDb((db, handle) => {
    const first = see(handle, '1', { kind: 'account', key: '700', display: 'Ilse' });
    const second = see(handle, '2', { kind: 'account', key: '700', display: 'Ilse' });
    const person = personOfAccount(db, accountOfLine(db, first));
    assert.match(String(person), UUID_PERSON);
    assert.equal(authorPersonOf(db, first), person);
    assert.equal(authorPersonOf(db, second), person);
  });
});

test('a line with no account names no person and makes none', () => {
  // Bug: an anonymous participant's line is given a person, so a one-thread token becomes somebody.
  withDb((db, handle) => {
    const people = db.prepare('SELECT COUNT(*) AS n FROM people').get()?.n;
    const source = see(handle, '1', { kind: 'participant', token_kind: 'thread_token', key: 'Ab12' });
    assert.equal(authorPersonOf(db, source), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get()?.n, people);
  });
});

test("her memory session reads a new member's lines as the member's meta-person", () => {
  // Bug: the batch names no person for an account nobody linked, so a claim about the member has no subject.
  withDb((db, handle) => {
    const source = see(handle, '1', { kind: 'account', key: '700', display: 'Ilse' });
    const batch = db.prepare('SELECT * FROM sources WHERE id = ?').all(source);
    const { people } = peopleOf(db, batch, 'Her');
    assert.deepEqual(
      people.map((person) => person.id),
      [personOfAccount(db, accountOfLine(db, source))]
    );
  });
});

test("a member's profile is written to the meta-person and the avatar to the account row", () => {
  // Bug: the profile unit writes a `person:<iface>:<native>` person, and the avatar stays on the old account columns only.
  withDb((db, handle) => {
    const account = accountOfLine(db, see(handle, '1', { kind: 'account', key: '700', display: 'Ilse' }));
    const person = personOfAccount(db, account);
    applyUnitUpdate(handle, {
      op: 'value',
      key: accountCollection('user', account),
      iface: 'telegram',
      value: { names: ['Ilse Now'], avatar: { hash: 'h1' }, messageCount: 3 },
    });
    const people = db
      .prepare('SELECT id FROM people WHERE owner_key IS NOT NULL AND id != ?')
      .all('person:self')
      .map((row) => row.id);
    assert.deepEqual(people, [person]);
    assert.equal(db.prepare('SELECT message_count FROM people WHERE id = ?').get(person)?.message_count, 3);
    const row = accountRow(db, account);
    assert.deepEqual(JSON.parse(String(row?.avatar)), { hash: 'h1' });
    assert.equal(row?.display_name, 'Ilse Now');
  });
});

test('a profile written for an account nobody linked lands on a new meta-person, never a spelled one', () => {
  // Bug: `personId(iface, native)` names the profile's person, the id the plan retires.
  withDb((db, handle) => {
    db.prepare("INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES ('telegram', 'telegram', 1)").run();
    db.prepare(
      "INSERT INTO accounts (id, iface, native_id, kind) VALUES ('telegram:800', 'telegram', '800', 'user')"
    ).run();
    applyUnitUpdate(handle, {
      op: 'value',
      key: accountCollection('user', 'telegram:800'),
      iface: 'telegram',
      value: { names: ['Nobody Linked'], messageCount: 1 },
    });
    const person = personOfAccount(db, 'telegram:800');
    assert.match(String(person), UUID_PERSON);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM people WHERE id LIKE 'person:telegram:%'").get()?.n, 0);
    assert.equal(isMeta(db, person), true);
    assert.equal(db.prepare('SELECT message_count FROM people WHERE id = ?').get(person)?.message_count, 1);
  });
});

test('binding an account to another person moves its account row and the author person of its lines', () => {
  // Bug: the link moves `accounts.person_id` and leaves the lines and the account row on the old meta-person.
  withDb((db, handle) => {
    const ilse = see(handle, '1', { kind: 'account', key: '700', display: 'Ilse' });
    const jan = see(handle, '2', { kind: 'account', key: '701', display: 'Jan' });
    const target = personOfAccount(db, accountOfLine(db, jan));
    applyPersonLinkWrite(handle, {
      op: 'bind',
      accountId: accountOfLine(db, ilse),
      target: { accountId: accountOfLine(db, jan) },
      now: NOW,
    });
    assert.equal(authorPersonOf(db, ilse), target);
    assert.equal(accountRow(db, accountOfLine(db, ilse))?.person_id, target);
    assert.equal(personOfAccount(db, accountOfLine(db, ilse)), target);
  });
});

test('a merge moves the account rows and the author person of the lines to the survivor', () => {
  // Bug: after the merge the lines still name the person who went, whose row now says `merged_into`.
  withDb((db, handle) => {
    const ilse = see(handle, '1', { kind: 'account', key: '700', display: 'Ilse' });
    const jan = see(handle, '2', { kind: 'account', key: '701', display: 'Jan' });
    const from = String(personOfAccount(db, accountOfLine(db, ilse)));
    const into = String(personOfAccount(db, accountOfLine(db, jan)));
    mergePersonInto(db, { from, into, by: 'owner', reason: 'synthetic', at: AT });
    assert.equal(authorPersonOf(db, ilse), into);
    assert.equal(accountRow(db, accountOfLine(db, ilse))?.person_id, into);
  });
});

test('binding an account to a person whose id spells an interface makes that person a meta-person with the account row', () => {
  // The id of a person is never read: a person nobody merged away holds its accounts like any other.
  withDb((db, handle) => {
    const ilse = see(handle, '1', { kind: 'account', key: '700', display: 'Ilse' });
    const account = accountOfLine(db, ilse);
    db.prepare("INSERT INTO people (id, kind, status) VALUES ('person:telegram:9', 'member', 'active')").run();
    applyPersonLinkWrite(handle, {
      op: 'bind',
      accountId: account,
      target: { personId: 'person:telegram:9' },
      now: NOW,
    });
    assert.equal(accountRow(db, account)?.person_id, 'person:telegram:9');
    assert.equal(isMeta(db, 'person:telegram:9'), true);
    assert.equal(authorPersonOf(db, ilse), 'person:telegram:9');
  });
});

test('a new line of an account linked to a person of the old shape names that person', () => {
  // Bug: before the migration a member's line names no person, or a new meta-person beside the one memory holds.
  withDb((db, handle) => {
    db.prepare("INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES ('telegram', 'telegram', 1)").run();
    db.prepare(
      "INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('telegram/global', 'telegram', 'telegram/global')"
    ).run();
    db.prepare("INSERT INTO people (id, kind, status) VALUES ('person:telegram:700', 'member', 'active')").run();
    db.prepare(
      `INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link)
       VALUES ('telegram:700', 'telegram', '700', '700', 'telegram/global', 1, 'user', 'person:telegram:700', 'verified')`
    ).run();
    const people = db.prepare('SELECT COUNT(*) AS n FROM people').get()?.n;
    const source = see(handle, '1', { kind: 'account', key: '700', display: 'Ilse' });
    assert.equal(accountOfLine(db, source), 'telegram:700');
    assert.equal(authorPersonOf(db, source), 'person:telegram:700');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get()?.n, people);
  });
});
