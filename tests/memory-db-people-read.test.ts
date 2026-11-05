// src/memory/db/people-read.ts: the owner's reader of people, accounts and anonymous participants. Who someone is stays what
// was stored: a shared name is a search term and links nothing, an unlinked account and an anonymous participant stay
// discoverable on their own, and a merge keeps its history. The context decides before anything is counted. Plan
// 2026-11-04-cli-and-memory task 8. Contract:
//   listPeople(db: Db, request: { context: Context; filters: { name: string | null; interfaceId: string | null;
//     authorityId: string | null }; limit: number; cursor: string | null }): Page<PersonListing>
//   personDetail(db: Db, personId: string, context: Context): PersonDetail
//   PersonListing = { kind: 'person'; id; names; accountIds; mergedInto: string | null }
//     | { kind: 'account'; id; interfaceId; authorityId; nativeId; generation; names }
//     | { kind: 'participant'; id; authorityId; display; scopePlaceId }
//   PersonDetail = { found: true; person: { id; requestedId; mergedFrom }; names; accounts: Array<PrivateAccount>;
//     links: Array<{ id; accountId; personId; state; by; validFromAt; validToAt }>; merges: Array<{ id; fromPerson; intoPerson;
//     at; by; reason }>; participants; memberships; affinity: { score; eventIds }; privatePlaces: Array<PrivatePlace>;
//     records: Array<{ table; id; audienceId; retiredAt }> } | { found: false; code: 'PERSON_NOT_FOUND' }
// A cursor from another context or filter throws an Error with `code` INSPECTION_BAD_CURSOR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from '../src/memory/db/inspection.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { listPeople, personDetail } from '../src/memory/db/people-read.ts';
import type { PersonDetail, PersonListing } from '../src/memory/db/people-read.ts';
import { dmContext, groupContext, internalContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';
import {
  ANNA,
  ANNA_ACCOUNTS,
  ANNA_PLACES,
  BORIS,
  BORIS_ACCOUNT,
  addAccount,
  addClaim,
  addPerson,
  seedOpaqueWorld,
} from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const UNLINKED = 'account:u1';
const ANONYMOUS = 'participant:p1';
const MERGED = 'person:merged-away';
const AT = '2026-11-01T00:00:00.000Z';
const OLD_AT = '2026-10-01T00:00:00.000Z';

function seed(db: Db): void {
  seedOpaqueWorld(db);
  addAccount(db, {
    id: UNLINKED,
    iface: 'discord',
    authority: 'discord/global',
    native: 'n9',
    person: null,
    link: 'proposed',
  });
  db.prepare("UPDATE accounts SET names = ? WHERE id = 'account:a11'").run(JSON.stringify(['Ελένη']));
  db.prepare('UPDATE accounts SET names = ? WHERE id = ?').run(JSON.stringify(['Ελένη']), BORIS_ACCOUNT);
  db.prepare('UPDATE accounts SET names = ? WHERE id = ?').run(JSON.stringify(['Ελένη', 'Noël']), UNLINKED);
  db.prepare(
    `INSERT INTO participants (id, authority_id, scope_place_id, token_kind, native_token, continuity, display, recorded_at)
     VALUES (?, 'discord/global', 'place:room-1', 'thread_token', 'token-1', 'unknown', 'Ανώνυμος', ?)`
  ).run(ANONYMOUS, AT);
  addPerson(db, MERGED);
  db.prepare(
    `INSERT INTO people_merges (id, from_person, into_person, at, by, reason)
     VALUES ('merge:1', ?, ?, ?, 'owner', 'same person')`
  ).run(MERGED, ANNA, AT);
  db.prepare(
    `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, valid_from_at, valid_to_at, recorded_at)
     VALUES ('link:revoked', 'account:a11', ?, 'revoked', 'owner', 'wrong person', ?, ?, ?)`
  ).run(BORIS, OLD_AT, AT, OLD_AT);
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, retired_at, created_at)
     VALUES ('claim:retired-anna', 'person', ?, 'detail', 'retired words', 'current', 1, 'aud:group:discord', 'group', ?, ?)`
  ).run(ANNA, AT, OLD_AT);
}

function withWorld(body: (db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    seed(db);
    body(db);
  } finally {
    handle.close();
  }
}

const NO_FILTERS = { name: null, interfaceId: null, authorityId: null };

function everyEntry(db: Db, context: Context, filters = NO_FILTERS, limit = 2): Array<PersonListing> {
  const items: Array<PersonListing> = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 1000; turn += 1) {
    const page: Page<PersonListing> = listPeople(db, { context, filters, limit, cursor });
    items.push(...page.items);
    if (page.next === null) return items;
    cursor = page.next;
  }
  throw new Error('the pages never end');
}

const ids = (items: ReadonlyArray<{ id: string }>): Array<string> => items.map((item) => item.id).sort();

function found(view: PersonDetail): Extract<PersonDetail, { found: true }> {
  assert.equal(view.found, true);
  return view;
}
const recordsOf = (view: PersonDetail): Array<string> =>
  found(view)
    .records.map((one) => `${one.table} ${one.id}`)
    .sort();

// ---------- discovery ----------

test('the list holds each person once, and an unlinked account and an anonymous participant on their own', () => {
  // Bug: the list joins people to verified accounts, so whoever has no verified link is invisible to the owner.
  withWorld((db) => {
    const entries = everyEntry(db, internalContext());
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    assert.equal(entries.length, byId.size, 'an entry repeats across pages');
    assert.equal(byId.get(ANNA)?.kind, 'person');
    assert.equal(byId.get(UNLINKED)?.kind, 'account');
    assert.equal(byId.get(ANONYMOUS)?.kind, 'participant');
  });
});

test('a linked account lives under its person and has no entry of its own', () => {
  withWorld((db) => {
    const entries = everyEntry(db, internalContext());
    const anna = entries.find((entry) => entry.id === ANNA);
    assert.ok(anna?.kind === 'person');
    assert.deepEqual([...anna.accountIds].sort(), ANNA_ACCOUNTS);
    for (const account of ANNA_ACCOUNTS)
      assert.equal(
        entries.some((entry) => entry.id === account),
        false
      );
  });
});

test('a person merged away stays discoverable and names the survivor', () => {
  // Bug: `WHERE id NOT IN (SELECT from_person ...)` erases the old id, and the owner cannot find what was merged.
  withWorld((db) => {
    const merged = everyEntry(db, internalContext()).find((entry) => entry.id === MERGED);
    assert.ok(merged?.kind === 'person');
    assert.equal(merged.mergedInto, ANNA);
  });
});

test('an unlinked account keeps its interface, authority, native id and generation', () => {
  withWorld((db) => {
    const account = everyEntry(db, internalContext()).find((entry) => entry.id === UNLINKED);
    assert.ok(account?.kind === 'account');
    assert.deepEqual(
      [account.interfaceId, account.authorityId, account.nativeId, account.generation],
      ['discord', 'discord/global', 'n9', 1]
    );
  });
});

// ---------- a name is a search term ----------

test('a name finds every holder of it and joins none of them', () => {
  // Bug: a name search resolves to one person, or groups the accounts that share the spelling.
  withWorld((db) => {
    const before = databaseDigest(db);
    const hits = everyEntry(db, internalContext(), { ...NO_FILTERS, name: 'Ελένη' });
    assert.deepEqual(ids(hits), [ANNA, BORIS, UNLINKED].sort());
    assert.deepEqual(databaseDigest(db), before);
    const anna = hits.find((entry) => entry.id === ANNA);
    assert.ok(anna?.kind === 'person');
    assert.equal(anna.accountIds.includes(UNLINKED), false);
    const unlinked = found(personDetail(db, ANNA, internalContext())).accounts.map((one) => one.id);
    assert.equal(unlinked.includes(UNLINKED), false);
  });
});

test('a name also finds an anonymous participant by its display, and an unknown name finds nobody', () => {
  withWorld((db) => {
    assert.deepEqual(ids(everyEntry(db, internalContext(), { ...NO_FILTERS, name: 'Ανώνυμος' })), [ANONYMOUS]);
    assert.deepEqual(ids(everyEntry(db, internalContext(), { ...NO_FILTERS, name: 'nobody-of-that-name' })), []);
  });
});

test('interface and authority filters apply before the count and the page', () => {
  // Bug: the filter runs over a page already cut, so a matching person on page two reads as absent.
  withWorld((db) => {
    const filters = { ...NO_FILTERS, interfaceId: 'telegram' };
    const entries = everyEntry(db, internalContext(), filters, 1);
    assert.deepEqual(ids(entries), [ANNA, BORIS].sort());
    assert.equal(listPeople(db, { context: internalContext(), filters, limit: 1, cursor: null }).total, 2);
    const authority = { ...NO_FILTERS, authorityId: 'discord/global' };
    assert.equal(
      everyEntry(db, internalContext(), authority).some((entry) => entry.id === BORIS),
      false
    );
  });
});

// ---------- detail ----------

test('detail shows the accounts of a person across interfaces, two equal native ids apart', () => {
  // Bug: accounts are keyed by native id, and account:a11 and account:a21 (both `n1`) collapse into one.
  withWorld((db) => {
    const view = found(personDetail(db, ANNA, internalContext()));
    assert.deepEqual(ids(view.accounts), ANNA_ACCOUNTS);
    const natives = view.accounts.filter((one) => one.nativeId === 'n1').map((one) => one.interfaceId);
    assert.deepEqual(natives.sort(), ['discord', 'telegram']);
  });
});

test('detail shows every link of the person, the revoked one with its window', () => {
  // Bug: the reader takes `accounts.person_id`, the present only, and the owner cannot see a link undone.
  withWorld((db) => {
    const revoked = found(personDetail(db, BORIS, internalContext())).links.find((one) => one.id === 'link:revoked');
    assert.deepEqual(revoked, {
      id: 'link:revoked',
      accountId: 'account:a11',
      personId: BORIS,
      state: 'revoked',
      by: 'owner',
      validFromAt: OLD_AT,
      validToAt: AT,
    });
  });
});

test('detail shows the merge history, from the survivor and from the old id', () => {
  withWorld((db) => {
    const survivor = found(personDetail(db, ANNA, internalContext()));
    assert.deepEqual(survivor.merges, [
      { id: 'merge:1', fromPerson: MERGED, intoPerson: ANNA, at: AT, by: 'owner', reason: 'same person' },
    ]);
    assert.deepEqual(survivor.person.mergedFrom, [MERGED]);
    const old = found(personDetail(db, MERGED, internalContext()));
    assert.equal(old.person.id, ANNA);
    assert.equal(old.person.requestedId, MERGED);
  });
});

test('detail opens exact records by id, the private-only ones and the retired ones included', () => {
  // Bug: the detail reads the public profile, so a person known only in DMs has no records, and retired ones are gone.
  withWorld((db) => {
    assert.deepEqual(recordsOf(personDetail(db, ANNA, internalContext())), [
      'affinity_events affinity:a21',
      'claims claim:a11',
      'claims claim:about-anna-in-his-dm',
      'claims claim:public',
      'claims claim:retired-anna',
      'descriptions description:a12',
      'episodes episode:a21',
    ]);
    const retired = found(personDetail(db, ANNA, internalContext())).records.find(
      (one) => one.id === 'claim:retired-anna'
    );
    assert.equal(retired?.retiredAt, AT);
    assert.equal(retired?.audienceId, 'aud:group:discord');
  });
});

test('detail lists the actual DM places through the private reader', () => {
  withWorld((db) => {
    assert.deepEqual(ids(found(personDetail(db, ANNA, internalContext())).privatePlaces), ANNA_PLACES);
  });
});

test('detail reports the affinity history by event id', () => {
  withWorld((db) => {
    assert.deepEqual(found(personDetail(db, ANNA, internalContext())).affinity.eventIds, ['affinity:a21']);
  });
});

test('a person with no records at all is found, and empty', () => {
  withWorld((db) => {
    addPerson(db, 'person:blank');
    const view = found(personDetail(db, 'person:blank', internalContext()));
    assert.deepEqual([view.accounts, view.links, view.merges, view.records], [[], [], [], []]);
  });
});

test('a person nobody stored is a named refusal and not an empty profile', () => {
  withWorld((db) => {
    assert.deepEqual(personDetail(db, 'person:unknown', internalContext()), { found: false, code: 'PERSON_NOT_FOUND' });
  });
});

// ---------- the context decides first ----------

test('a group context sees no private place, private record or private count', () => {
  // Bug: the owner's view is filtered after the counting, so a preview leaks how much a DM holds.
  withWorld((db) => {
    const view = found(personDetail(db, ANNA, groupContext('discord')));
    assert.deepEqual(view.privatePlaces, []);
    assert.deepEqual(view.records.map((one) => one.id).sort(), ['claim:public', 'claim:retired-anna']);
    assert.deepEqual(view.affinity.eventIds, []);
  });
});

test('a DM context of one person never sees another DM', () => {
  withWorld((db) => {
    const context = dmContext(BORIS, 'telegram', 'place:dm-b21');
    assert.deepEqual(
      found(personDetail(db, ANNA, context)).privatePlaces.map((one) => one.id),
      []
    );
    assert.equal(
      found(personDetail(db, ANNA, context)).records.some((one) => one.id === 'claim:a11'),
      false
    );
  });
});

test('a call without a valid context is refused, never read as the owner', () => {
  // Bug: `context?.internal !== false`, and a protocol argument obtains everything.
  withWorld((db) => {
    const bad = wrongly<Context>({});
    assert.throws(() => personDetail(db, ANNA, bad));
    assert.throws(() => listPeople(db, { context: bad, filters: NO_FILTERS, limit: 5, cursor: null }));
  });
});

test('a group list counts only what the group may know of', () => {
  // Bug: a person known only from a DM is listed, or counted in the total, for a group preview.
  withWorld((db) => {
    addPerson(db, 'person:dm-only');
    addClaim(db, 'claim:dm-only', 'person:dm-only', 'aud:dm:place:dm-b21');
    const page = listPeople(db, { context: groupContext('discord'), filters: NO_FILTERS, limit: 500, cursor: null });
    assert.equal(
      page.items.some((entry) => entry.id === 'person:dm-only'),
      false
    );
    assert.equal(page.total, page.items.length);
  });
});

// ---------- paging ----------

test('a cursor is bound to its context and filters', () => {
  withWorld((db) => {
    const filters = { ...NO_FILTERS, name: 'Ελένη' };
    const first = listPeople(db, { context: internalContext(), filters, limit: 1, cursor: null });
    const code = { code: 'INSPECTION_BAD_CURSOR' };
    assert.throws(
      () => listPeople(db, { context: groupContext('discord'), filters, limit: 1, cursor: first.next }),
      code
    );
    assert.throws(
      () => listPeople(db, { context: internalContext(), filters: NO_FILTERS, limit: 1, cursor: first.next }),
      code
    );
    assert.throws(() => listPeople(db, { context: internalContext(), filters, limit: 1, cursor: 'garbage' }), code);
  });
});

test('a page says what it left out', () => {
  withWorld((db) => {
    const page = listPeople(db, { context: internalContext(), filters: NO_FILTERS, limit: 1, cursor: null });
    assert.equal(page.items.length, 1);
    assert.equal(page.truncated, true);
    assert.equal(page.reason, 'page');
    assert.equal(page.total, everyEntry(db, internalContext()).length);
  });
});

test('an empty database lists nothing and completes', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const page = listPeople(dbOf(handle), { context: internalContext(), filters: NO_FILTERS, limit: 5, cursor: null });
    const missing = page.items.filter((entry) => entry.id !== 'person:self');
    assert.deepEqual([missing, page.next, page.truncated], [[], null, false]);
  } finally {
    handle.close();
  }
});

// ---------- no write ----------

test('the reader runs over a read-only connection and changes no row', () => {
  // Bug: a lookup repairs a link, or creates the person it was asked about, on the way through.
  const file = join(tempDir('nep-people-read-'), 'memory.db');
  const writer = openMemoryDb(file);
  seed(dbOf(writer));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(reader);
    const before = databaseDigest(db);
    for (const entry of everyEntry(db, internalContext())) personDetail(db, entry.id, internalContext());
    personDetail(db, 'person:unknown', internalContext());
    assert.deepEqual(databaseDigest(db), before);
  } finally {
    reader.close();
  }
});
