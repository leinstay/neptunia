// src/memory/db/direct-chats.ts: the direct chats of a person she names in a call (plan 2026-11-08-meta-person, fault
// 2). She names the person by their handle or a name the index holds, and gets every direct chat of every account of
// that person, newest first, whatever interface it is on. Words that name nobody give the people the memory graph ranks
// for them (graph-find.ts#peopleFound), each with the handle to call again with. Whether a chat may be read is the
// reader's rule, not this one's. Contract:
//   directChatsOf(db: Db, ctx: Context, reference: string, settings?: Partial<FindSettings>, meaning?: FindMeaning)
//     : DirectChats, the request's embedding ranking the people by their object vectors when words name nobody
//   DirectChats = { kind: 'chats'; personId: string; places: Array<string> }
//               | { kind: 'found'; people: Array<FoundPerson & { handle: string | null }> } | { kind: 'none' }
// Synthetic names, in Greek.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOf } from '../src/behavior/handles.ts';
import { directChatsOf } from '../src/memory/db/direct-chats.ts';
import { pendingObjectEmbeds } from '../src/memory/db/object-vectors.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import { AT, addDm, addLine, addPerson, noteInterface, openWorld } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';

const worlds: Array<World> = [];
after(() => {
  for (const world of worlds) world.close();
});

const OWNER = 'person:owner';

/** The owner with an account on the fake interface and one on the command line, a direct chat on each. */
function world(): { w: World; fakeDm: string; cliDm: string } {
  const w = openWorld();
  worlds.push(w);
  noteInterface(w, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  addPerson(w.db, {
    id: OWNER,
    accounts: [
      { id: 'fake:777', iface: 'fake', native: '777', names: ['Ορέστης'] },
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Ορέστης'] },
    ],
  });
  const fakeDm = addDm(w.db, { iface: 'fake', native: '777', person: OWNER, account: 'fake:777' });
  const cliDm = addDm(w.db, { iface: 'cli', native: 'owner', person: OWNER, account: 'cli:owner' });
  addLine(w.db, {
    id: 'f1',
    iface: 'fake',
    place: fakeDm,
    author: 'fake:777',
    text: 'γεια',
    at: '2026-11-01T09:00:00.000Z',
    audience: { dm: fakeDm, iface: 'fake', person: OWNER },
  });
  addLine(w.db, {
    id: 'c1',
    iface: 'cli',
    place: cliDm,
    author: 'cli:owner',
    text: 'καλημέρα',
    at: '2026-11-01T11:00:00.000Z',
    audience: { dm: cliDm, iface: 'cli', person: OWNER },
  });
  return { w, fakeDm, cliDm };
}

test('a person named by name has the direct chats of all their accounts, newest first', () => {
  // Bug: a direct chat has no handle, so she has no way to name the owner's chat on another interface in a call.
  const { w, fakeDm, cliDm } = world();
  assert.deepEqual(directChatsOf(w.db, internalContext(), 'Ορέστης'), {
    kind: 'chats',
    personId: OWNER,
    places: [cliDm, fakeDm],
  });
});

test('a person named by the handle a request showed has the same direct chats', () => {
  // Bug: only a name resolves, so the @handle she sees in her memory names nobody.
  const { w, fakeDm, cliDm } = world();
  const found = directChatsOf(w.db, internalContext(), `@${handleOf('777')}`);
  assert.deepEqual(found, { kind: 'chats', personId: OWNER, places: [cliDm, fakeDm] });
});

test('words that name nobody give the people the graph ranks for them, with their handles', () => {
  // Bug: a description of a person is refused bare, and she asks the owner for an id instead of which person was meant.
  const { w } = world();
  const text = 'Ζωγραφίζει κάστρα με κάρβουνο.';
  insertRows(w.db, {
    descriptions: [
      {
        id: 'd:owner:c',
        subject_kind: 'person',
        subject_id: OWNER,
        field: 'character',
        current_version: 'd:owner:c:v1',
        scope_kind: 'group',
        scope_iface: 'fake',
      },
    ],
    description_versions: [
      {
        id: 'd:owner:c:v1',
        description_id: 'd:owner:c',
        text,
        author: 'her',
        written_at: AT,
        chars: text.length,
        origin: 'review',
      },
    ],
  });
  const found = directChatsOf(w.db, groupContext('fake'), 'κάστρα κάρβουνο');
  const people = found.kind === 'found' ? found.people : [];
  assert.deepEqual(
    people.map((person) => person.id),
    [OWNER]
  );
  const back = directChatsOf(w.db, groupContext('fake'), `@${people[0]?.handle ?? ''}`);
  assert.equal(back.kind === 'chats' ? back.personId : null, OWNER, 'the handle she is given names the person again');
});

test('a reference nothing fits finds no person', () => {
  // Bug: an empty or unknown reference picks some person's chat.
  const { w } = world();
  assert.deepEqual(directChatsOf(w.db, internalContext(), 'Θεόφιλος'), { kind: 'none' });
  assert.deepEqual(directChatsOf(w.db, internalContext(), '  '), { kind: 'none' });
});

test('words that fit nobody find a person by the vector of their names, and say no word fit in full', () => {
  // Bug: a person named in another language than their names is never offered, so the read ends unknown.
  const { w } = world();
  const pending = pendingObjectEmbeds(w.db, { model: 'test/embedder', limit: 1000 }).find(
    (one) => one.kind === 'names' && one.itemId === `person:${OWNER}`
  );
  assert.ok(pending, 'the owner has a name set to embed');
  const { kind, itemId, audienceId, hash } = pending;
  applyMemoryWrite(w.handle, {
    kind: 'object-embedding',
    model: 'test/embedder',
    now: Date.parse(AT),
    items: [{ kind, itemId, audienceId, hash, vector: [1, 0, 0] }],
  });
  assert.deepEqual(directChatsOf(w.db, internalContext(), 'Orestes'), { kind: 'none' });
  const found = directChatsOf(w.db, internalContext(), 'Orestes', {}, { vector: [1, 0, 0], model: 'test/embedder' });
  assert.equal(found.kind, 'found');
  assert.deepEqual(found.kind === 'found' ? found.people.map((one) => [one.id, one.hasEveryWord]) : [], [
    [OWNER, false],
  ]);
});
