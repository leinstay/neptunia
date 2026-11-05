// Her own account is hers on every interface: the observation links it to `person:self` the moment it is seen, by the
// author being she and never by a name. What she knows about herself reads through the same reader as what she knows
// about anyone. Real temporary databases, synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { personDetail } from '../src/memory/db/people-read.ts';
import { accountLinks, personMembers } from '../src/memory/db/person-links.ts';
import { dmContext, groupContext, internalContext } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { addAccount, addClaim, addDmPlace } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const SELF = 'person:self';
const AT = Date.parse('2026-11-05T10:00:00Z');

function withDb(body: (handle: MemoryHandle, db: Db) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-self-'), 'memory.db'));
  try {
    body(handle, dbOf(handle));
  } finally {
    handle.close();
  }
}

/** One line in a channel of `iface`, by the account `author` under the name `name`, seen with her id being `selfId`. */
function line(
  handle: MemoryHandle,
  iface: string,
  { id, author, name, selfId }: { id: string; author: string; name: string; selfId: string | null }
): void {
  const envelope = observationOf(
    {
      kind: 'message.received',
      iface,
      at: AT,
      conversation: { id: 'room', kind: 'channel', chatType: 'channel' },
      message: { id, at: AT, content: 'a synthetic line', author: { id: author, name } },
    },
    { selfId, connection: `conn:${iface}` }
  );
  assert.ok(envelope, 'the event is an observable line');
  observe(handle, envelope, { now: () => AT });
}

const accountOf = (db: Db, iface: string, native: string) =>
  db.prepare('SELECT id, person_id, link, kind FROM accounts WHERE iface = ? AND native_key = ?').get(iface, native);

const DM_PLACE = 'place:dm-someone';

/** A claim about her under `audience`, as a memory session and the units store it: `subject_kind` `self`. */
function selfClaim(db: Db, id: string, audience: string): void {
  if (audience === `aud:dm:${DM_PLACE}` && !db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(DM_PLACE)) {
    addAccount(db, {
      id: 'account:someone',
      iface: 'discord',
      authority: 'discord/global',
      native: 'someone',
      person: null,
    });
    addDmPlace(db, {
      id: DM_PLACE,
      iface: 'discord',
      authority: 'discord/global',
      account: 'account:someone',
      person: null,
    });
  }
  addClaim(db, id, SELF, audience);
  db.prepare("UPDATE claims SET subject_kind = 'self', kind = 'self_fact' WHERE id = ?").run(id);
}

for (const iface of ['discord', 'telegram', 'matrix']) {
  test(`her account on ${iface} is linked to her person the moment it is first seen`, () => {
    // Bug: her accounts stay unlinked, so "who is this" has no answer for her own lines and any later code treats her as
    // an unknown person, on an interface nobody wired by hand above all.
    withDb((handle, db) => {
      line(handle, iface, { id: 'm1', author: 'her-id', name: 'Someone', selfId: 'her-id' });
      const account = accountOf(db, iface, 'her-id');
      assert.equal(account?.person_id, SELF);
      assert.equal(account?.link, 'verified');
      assert.deepEqual(
        db
          .prepare('SELECT person_id, state FROM account_person_links WHERE account_id = ? AND valid_to_at IS NULL')
          .all(account?.id)
          .map((row) => ({ ...row })),
        [{ person_id: SELF, state: 'verified' }]
      );
      assert.equal(db.prepare('SELECT kind FROM people WHERE id = ?').get(SELF)?.kind, 'self', 'a raw install has her');
    });
  });
}

test('an account first seen as anyone links to her person once its author turns out to be she', () => {
  // Bug: a line observed before the interface told her id leaves the account a user, and the kind's update skips the link.
  withDb((handle, db) => {
    line(handle, 'discord', { id: 'm1', author: 'her-id', name: 'Someone', selfId: null });
    assert.equal(accountOf(db, 'discord', 'her-id')?.person_id, null);
    line(handle, 'discord', { id: 'm2', author: 'her-id', name: 'Someone', selfId: 'her-id' });
    assert.equal(accountOf(db, 'discord', 'her-id')?.person_id, SELF);
  });
});

test('a stranger under her name stays a stranger, and all her accounts read as one person', () => {
  // Bug: the link goes by a name match, so anyone who renames themselves after her becomes her.
  withDb((handle, db) => {
    line(handle, 'discord', { id: 'm1', author: 'her-id', name: 'Same Name', selfId: 'her-id' });
    line(handle, 'telegram', { id: 'm2', author: 'her-other-id', name: 'Other Name', selfId: 'her-other-id' });
    line(handle, 'discord', { id: 'm3', author: 'stranger', name: 'Same Name', selfId: 'her-id' });
    assert.equal(accountOf(db, 'discord', 'stranger')?.person_id, null);
    assert.deepEqual(
      personMembers(db, SELF, { ownerMergesOnly: true })
        .accounts.map((account) => account.id)
        .sort(),
      [accountOf(db, 'discord', 'her-id')?.id, accountOf(db, 'telegram', 'her-other-id')?.id].sort()
    );
    assert.equal(accountLinks(db, 'discord', 'her-id').person, SELF);
  });
});

test('the owner reads every claim about her through the reader that reads anyone', () => {
  // Bug: `personDetail` asks `subject_kind = 'person'`, so `/memory users show person:self` holds none of her own facts.
  withDb((handle, db) => {
    line(handle, 'discord', { id: 'm1', author: 'her-id', name: 'Someone', selfId: 'her-id' });
    selfClaim(db, 'claim:self-group', 'aud:group:discord');
    selfClaim(db, 'claim:self-dm', `aud:dm:${DM_PLACE}`);
    selfClaim(db, 'claim:self-internal', 'aud:internal');
    const view = personDetail(db, SELF, internalContext());
    assert.ok(view.found);
    assert.deepEqual(view.records.map((record) => record.id).sort(), [
      'claim:self-dm',
      'claim:self-group',
      'claim:self-internal',
    ]);
    assert.deepEqual(
      view.accounts.map((account) => account.id),
      [accountOf(db, 'discord', 'her-id')?.id]
    );
  });
});

test('an outward context reads of her only what its audience holds, as of anyone', () => {
  // Bug: reading her facts through the person's reader opens a private conversation's fact about her to a group.
  withDb((_handle, db) => {
    db.prepare("INSERT OR IGNORE INTO people (id, kind) VALUES (?, 'self')").run(SELF);
    selfClaim(db, 'claim:self-group', 'aud:group:discord');
    selfClaim(db, 'claim:self-dm', `aud:dm:${DM_PLACE}`);
    const inGroup = personDetail(db, SELF, groupContext('discord'));
    assert.ok(inGroup.found);
    assert.deepEqual(
      inGroup.records.map((record) => record.id),
      ['claim:self-group']
    );
    const elsewhere = personDetail(db, SELF, dmContext('person:stranger', 'discord'));
    assert.deepEqual(elsewhere.found, false);
  });
});
