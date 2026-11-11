// subjectOf (src/memory/db/subject.ts): the one thing memory.read's words name, resolved under the turn's memory
// context over a real memory database. Invented Greek names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subjectOf } from '../src/memory/db/subject.ts';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { CHANNEL_HANDLE_PREFIX, HANDLE_DIGITS, handleOf } from '../src/behavior/handles.ts';
import { AT, addDm, addPerson, addRoom, noteInterface, openWorld, rootId } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';

const ROOT = rootId('fake', 'g1');
const HERE = { iface: 'fake', rootNative: 'g1' };

/** The root Agora of `fake` and Eleni with her direct chat. */
function seed(world: World): { dm: string } {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  addPerson(world.db, {
    id: 'person:eleni',
    accounts: [{ id: 'fake:u1', iface: 'fake', native: 'u1', names: ['Ελένη'] }],
  });
  return { dm: addDm(world.db, { iface: 'fake', native: 'u1', person: 'person:eleni', account: 'fake:u1' }) };
}

/** A lore entry titled `title` about `place`, kept in the groups of `fake` or in the direct chat `dm`. */
function addLore(world: World, { id, place, title, dm }: { id: string; place: string; title: string; dm?: string }) {
  const scope = dm
    ? { scope_kind: 'dm', scope_iface: 'fake', scope_dm: 'person:eleni', audience_id: `aud:dm:${dm}` }
    : { scope_kind: 'group', scope_iface: 'fake' };
  insertRows(world.db, {
    claims: [
      {
        id,
        subject_kind: 'place',
        subject_id: place,
        kind: 'lore',
        text: `κείμενο ${id}`,
        truth: 'current',
        shown: 1,
        created_at: AT,
        extra: JSON.stringify({ title, keys: [], always: false }),
        ...scope,
      },
    ],
  });
}

test('community names the root she stands in, and nothing outside a root', () => {
  // Bug: the word is matched as a name, or a direct chat reads some root as its community.
  const world = openWorld();
  try {
    seed(world);
    assert.deepEqual(subjectOf(world.db, groupContext('fake'), 'Community', HERE), { kind: 'place', placeId: ROOT });
    assert.deepEqual(subjectOf(world.db, groupContext('fake'), 'community', { iface: 'fake', rootNative: null }), {
      kind: 'none',
    });
  } finally {
    world.close();
  }
});

test('lists both rooms with their channel handles when a name fits two rooms', () => {
  // Bug: the first room of a shared name is read as if she meant it.
  const world = openWorld();
  try {
    seed(world);
    addRoom(world.db, { iface: 'fake', native: 'c7', root: ROOT, name: 'κήπος' });
    addRoom(world.db, { iface: 'fake', native: 'c8', root: ROOT, name: 'κήπος' });
    const found = subjectOf(world.db, groupContext('fake'), 'κήπος', HERE);
    assert.equal(found.kind, 'several');
    const refs = found.kind === 'several' ? found.choices.map((choice) => choice.ref).sort() : [];
    const handle = (native: string) => `#${handleOf(native, HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX)}`;
    assert.deepEqual(refs, [handle('c7'), handle('c8')].sort());
  } finally {
    world.close();
  }
});

test('finds no lore entry kept in a direct chat when the read is in a group', () => {
  // Bug: the title is matched without the audience, so a group turn learns a title told in a direct chat.
  const world = openWorld();
  try {
    const { dm } = seed(world);
    addLore(world, { id: 'lore:secret', place: dm, title: 'Το κρυφό πηγάδι', dm });
    assert.deepEqual(subjectOf(world.db, groupContext('fake'), 'Το κρυφό πηγάδι', HERE), { kind: 'none' });
    const inDm = subjectOf(world.db, dmContext('person:eleni', 'fake', dm), 'Το κρυφό πηγάδι', HERE);
    assert.equal(inDm.kind, 'lore');
  } finally {
    world.close();
  }
});

test('names the person of a member handle, and nothing for a handle no account has', () => {
  // Bug: an unknown handle falls through to a fuzzy match and reads someone else.
  const world = openWorld();
  try {
    seed(world);
    // The handle a request shows is the person's, cut from the meta-person id (spec 2026-11-10 one-handle, slice 2); it
    // was the handle of the account's platform id.
    const eleni = subjectOf(world.db, groupContext('fake'), `@${handleOf('person:eleni')}`, HERE);
    assert.deepEqual(eleni.kind === 'person' ? eleni.personId : null, 'person:eleni');
    assert.deepEqual(subjectOf(world.db, groupContext('fake'), '@uzzzz', HERE), { kind: 'none' });
  } finally {
    world.close();
  }
});

test("lists both people with each person's handle when a name fits two people", () => {
  // Bug: the choice carries the handle of the person's first account, which names nobody on another interface and is
  // not the handle a request shows for the person.
  const world = openWorld();
  try {
    seed(world);
    addPerson(world.db, {
      id: 'person:eleni-2',
      accounts: [
        { id: 'tele:u9', iface: 'tele', native: 'u9', names: ['Ελένη'] },
        { id: 'fake:u9', iface: 'fake', native: 'u9', names: ['Ελένη'] },
      ],
    });
    const found = subjectOf(world.db, groupContext('fake'), 'Ελένη', HERE);
    const refs = found.kind === 'several' ? found.choices.map((choice) => choice.ref).sort() : [];
    assert.deepEqual(refs, [`@${handleOf('person:eleni')}`, `@${handleOf('person:eleni-2')}`].sort());
  } finally {
    world.close();
  }
});

test('the #handle of a direct chat names that chat for the context that reads it, and none for a group', () => {
  // Bug: only channels and threads had handles a place argument resolved, so a tool could not take the direct chat she
  // was asked in. The handle is cut from the chat's native id as every place handle is.
  const world = openWorld();
  try {
    const { dm } = seed(world);
    const handle = `#${handleOf('u1', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX)}`;
    assert.deepEqual(subjectOf(world.db, dmContext('person:eleni', 'fake', dm), handle, HERE), {
      kind: 'place',
      placeId: dm,
    });
    assert.deepEqual(subjectOf(world.db, groupContext('fake'), handle, HERE), { kind: 'none' });
  } finally {
    world.close();
  }
});

test("the #handle of the command line's chat names it for the owner's context", () => {
  // Bug: the owner's own chat had no handle, so no tool could take the place she answers him in.
  const world = openWorld();
  try {
    addPerson(world.db, {
      id: 'person:owner',
      accounts: [{ id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Orestis'] }],
    });
    const cli = addDm(world.db, { iface: 'cli', native: 'owner', person: 'person:owner', account: 'cli:owner' });
    const handle = `#${handleOf('owner', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX)}`;
    const found = subjectOf(world.db, dmContext('person:owner', 'cli', cli), handle, {
      iface: 'cli',
      rootNative: null,
    });
    assert.deepEqual(found, { kind: 'place', placeId: cli });
  } finally {
    world.close();
  }
});
