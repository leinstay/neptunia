// A DM from ingestion to the model's request on an interface that serves no root, through the real link. Fake
// interfaces, a scripted model and temporary folders. The gate stays closed for a stranger: having no root to check
// membership in is no reason to answer anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  directIn,
  mentionIn,
  postedIn,
  readsOf,
  seedDm,
  seedPerson,
  seedRoom,
  waitFor,
  withFakes,
} from './fixtures/two-fakes.ts';

const ROOT_PLACES = "SELECT id FROM places WHERE kind = 'guild' ORDER BY id";

test('a core with no root at all answers the owner in a DM and makes up no root', async () => {
  // Bug: every step asks for the home root first, so the DM is dropped or kept under an invented root.
  await withFakes({ owners: ['u1'], names: ['solo'] }, async ({ connect, requests, rows }) => {
    const solo = await connect('solo', []);
    seedDm(solo, 'd1', 'u1');
    await directIn(solo, 'd1', 'u1', 'm1');
    await waitFor(() => postedIn(solo, 'd1').length > 0, 'the answer to the DM');
    assert.equal(requests.length, 1);
    assert.deepEqual(rows(ROOT_PLACES), []);
    const audiences = rows("SELECT DISTINCT audience_id FROM sources WHERE scope_kind = 'dm'");
    assert.deepEqual(audiences, [{ audience_id: 'aud:dm:solo:dm:u1' }]);
  });
});

test('a stranger on an interface with no root is not answered, while the owner is', async () => {
  // Bug: the fix for a missing root opens the gate to everyone who finds the account.
  await withFakes({ owners: ['u1'], names: ['solo'] }, async ({ connect, requests }) => {
    const solo = await connect('solo', []);
    seedDm(solo, 'd1', 'u1');
    await directIn(solo, 'd1', 'u1', 'm1');
    await waitFor(() => postedIn(solo, 'd1').length > 0, 'the answer to the owner');
    seedDm(solo, 'd2', 'stranger');
    await directIn(solo, 'd2', 'stranger', 'm2');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(postedIn(solo, 'd2'), []);
    assert.equal(requests.length, 1);
  });
});

test('a DM on an interface with no root asks nothing of the interface that has one', async () => {
  // Bug: the DM borrows the first interface's home root for its gate and its reads.
  await withFakes({ owners: ['u1'], names: ['first', 'second'] }, async ({ connect, rows }) => {
    // The DM's interface says hello first: it is the home interface, where the owner's account is bound.
    const second = await connect('second', []);
    const first = await connect('first', [{ id: 'g1', name: 'Alpha' }]);
    seedPerson(first, 'g1', 'u1', 'Eleni');
    seedDm(second, 'd1', 'u1');
    const before = readsOf(first, 'g1').length;
    await directIn(second, 'd1', 'u1', 'm1');
    await waitFor(() => postedIn(second, 'd1').length > 0, 'the answer on the second interface');
    assert.equal(readsOf(first, 'g1').length, before);
    assert.deepEqual(rows("SELECT DISTINCT audience_id FROM sources WHERE scope_kind = 'dm'"), [
      { audience_id: 'aud:dm:second:dm:u1' },
    ]);
    assert.deepEqual(postedIn(first, 'd1'), []);
  });
});

test('a group of the root an interface declares is answered and kept with no configured home root', async () => {
  // Bug: the core refuses to start without `bot.placeId`, or a group line loses its root beside a DM-only interface.
  await withFakes({ owners: [], names: ['first', 'second'] }, async ({ connect, rows }) => {
    const first = await connect('first', [{ id: 'g1', name: 'Alpha' }]);
    const second = await connect('second', []);
    seedRoom(first, 'c1', 'g1');
    await mentionIn(first, 'c1', 'g1', 'm1');
    await waitFor(() => postedIn(first, 'c1').length > 0, 'the answer in the room');
    seedDm(second, 'd1', 'stranger');
    await directIn(second, 'd1', 'stranger', 'm2');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(postedIn(second, 'd1'), []);
    assert.deepEqual(rows("SELECT iface FROM sources WHERE kind = 'seen' AND scope_kind != 'dm' ORDER BY iface"), [
      { iface: 'first' },
    ]);
  });
});
