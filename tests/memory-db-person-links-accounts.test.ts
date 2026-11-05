// src/memory/db/person-links.ts over concrete accounts: a neutral address resolves to one account node, and a binding names
// the node, so equal native ids in two authorities or two generations stay apart.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   accountNodeOf(db: Db, address: AccountAddress): string | null
//   applyPersonLinkWrite(handle, { op, accountId, target: { accountId } | { personId } | { self: true } })
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { accountNodeOf, applyPersonLinkWrite } from '../src/memory/db/person-links.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { ANNA, BORIS, BORIS_ACCOUNT, addAccount, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';

function withWorld(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    seedOpaqueWorld(db);
    addAccount(db, {
      id: 'account:second-authority',
      iface: 'discord',
      authority: 'discord/other',
      native: 'n1',
      person: null,
    });
    addAccount(db, {
      id: 'account:reused',
      iface: 'discord',
      authority: 'discord/global',
      native: 'n1',
      generation: 2,
      person: null,
    });
    body(db, handle);
  } finally {
    handle.close();
  }
}

const personOf = (db: Db, account: string): unknown =>
  db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(account)?.person_id ?? null;

test('a neutral address resolves to the account of exactly its interface, authority, native id and generation', () => {
  // Bug: the native lookup orders by generation and has no authority, so it answers whichever row sorts first.
  withWorld((db) => {
    const of = (authorityId: string, nativeId: string, generation: number): string | null =>
      accountNodeOf(db, { interfaceId: 'discord', authorityId, nativeId, generation });
    assert.equal(of('discord/global', 'n1', 1), 'account:a11');
    assert.equal(of('discord/global', 'n1', 2), 'account:reused');
    assert.equal(of('discord/other', 'n1', 1), 'account:second-authority');
  });
});

test('an address nobody stored resolves to nothing, on any of its four parts', () => {
  // Bug: a near match answers: another interface's equal native id, or the newest generation for an old one.
  withWorld((db) => {
    const base = { interfaceId: 'discord', authorityId: 'discord/global', nativeId: 'n1', generation: 1 };
    assert.equal(accountNodeOf(db, { ...base, interfaceId: 'matrix' }), null);
    assert.equal(accountNodeOf(db, { ...base, authorityId: 'discord/unknown' }), null);
    assert.equal(accountNodeOf(db, { ...base, nativeId: 'n404' }), null);
    assert.equal(accountNodeOf(db, { ...base, generation: 9 }), null);
  });
});

test('a binding that names the account node touches that account and not the one with an equal native id', () => {
  // Bug: `iface` and `native` pick the newest generation, so the owner binds a stranger's recycled account.
  withWorld((db, handle) => {
    applyPersonLinkWrite(handle, {
      op: 'bind',
      accountId: 'account:second-authority',
      target: { accountId: BORIS_ACCOUNT },
      now: 1000,
    });
    assert.equal(personOf(db, 'account:second-authority'), BORIS);
    assert.equal(personOf(db, 'account:a11'), ANNA);
    assert.equal(personOf(db, 'account:reused'), null);
  });
});

test('a binding can name an opaque person directly', () => {
  // Bug: the only target is another account, so a person whose accounts all left cannot be bound again.
  withWorld((db, handle) => {
    const written = applyPersonLinkWrite(handle, {
      op: 'bind',
      accountId: 'account:reused',
      target: { personId: ANNA },
      now: 1000,
    });
    assert.equal(written.person, ANNA);
    assert.equal(personOf(db, 'account:reused'), ANNA);
  });
});

test('an unbind of a concrete account leaves it with a person of its own, not one spelled from its native id', () => {
  // Bug: `personId(iface, native)` gives the same id to both generations of a reused native id.
  withWorld((db, handle) => {
    const first = applyPersonLinkWrite(handle, { op: 'unbind', accountId: 'account:a11', now: 1000 });
    applyPersonLinkWrite(handle, { op: 'bind', accountId: 'account:reused', target: { personId: BORIS }, now: 1000 });
    const second = applyPersonLinkWrite(handle, { op: 'unbind', accountId: 'account:reused', now: 2000 });
    assert.notEqual(first.person, second.person);
    assert.notEqual(first.person, ANNA);
    assert.equal(personOf(db, 'account:a11'), first.person);
  });
});

test('a binding that names an unknown account or person is refused', () => {
  // Bug: a typo makes a link to a person nobody knows.
  withWorld((_db, handle) => {
    assert.throws(
      () => applyPersonLinkWrite(handle, { op: 'bind', accountId: 'account:none', target: { personId: ANNA } }),
      /UNKNOWN_ACCOUNT/
    );
    assert.throws(
      () => applyPersonLinkWrite(handle, { op: 'bind', accountId: 'account:a11', target: { personId: 'person:none' } }),
      /UNKNOWN_PERSON/
    );
  });
});
