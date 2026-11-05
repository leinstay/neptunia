// src/memory/db/person-links.ts and private-read.ts over a merge nobody but the owner may turn into access: only the
// owner's merge widens an outward DM context, and the owner's internal view reads every merge. Plan 2026-11-04-cli-and-memory
// task 4, decision of the lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { linkedDmScopes } from '../src/memory/db/person-links.ts';
import { privateByPerson } from '../src/memory/db/private-read.ts';
import { dmContext, internalContext } from '../src/memory/db/scope.ts';
import { mergePeople } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';
import { ANNA, BORIS, BORIS_PLACE, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';

function withWorld(body: (handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    seedOpaqueWorld(dbOf(handle));
    body(handle);
  } finally {
    handle.close();
  }
}

test('a merge written by a session gives neither side the DMs of the other', () => {
  // Bug: a model's wrong merge opens one person's private memory in the DM of another.
  withWorld((handle) => {
    mergePeople(handle, BORIS, ANNA, { by: 'session', now: 1000 });
    const db = dbOf(handle);
    assert.equal(
      linkedDmScopes(db, 'discord', ANNA).some((one) => one.place === BORIS_PLACE),
      false
    );
    assert.deepEqual(
      linkedDmScopes(db, 'telegram', BORIS).map((one) => one.place),
      [BORIS_PLACE]
    );
  });
});

test('a merge written by the owner gives the survivor the DMs of the merged person', () => {
  // Bug: the owner's own decision never reaches a DM context.
  withWorld((handle) => {
    mergePeople(handle, BORIS, ANNA, { by: 'owner', now: 1000 });
    assert.ok(linkedDmScopes(dbOf(handle), 'discord', ANNA).some((one) => one.place === BORIS_PLACE));
  });
});

test('the owner view reads through a session merge while an outward view of the survivor does not', () => {
  // Bug: the reader uses one merge rule for both, so the owner cannot inspect a merge, or an outward read follows it.
  withWorld((handle) => {
    mergePeople(handle, BORIS, ANNA, { by: 'session', now: 1000 });
    const db = dbOf(handle);
    const owner = privateByPerson(db, ANNA, internalContext());
    assert.equal(owner.found, true);
    assert.deepEqual(owner.person.mergedFrom, [BORIS]);
    assert.ok(owner.places.some((one) => one.id === BORIS_PLACE));
    const outward = privateByPerson(db, BORIS, dmContext(BORIS, 'telegram', BORIS_PLACE));
    assert.equal(outward.found, true);
    assert.equal(outward.person.id, BORIS);
    assert.deepEqual(outward.person.mergedFrom, []);
  });
});
