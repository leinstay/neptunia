// The core's read routes (src/core.ts) are qualified by the interface: two interfaces may hold the same native community
// id, and each asks its own. Over the real link with fake interfaces, a scripted model and temporary folders. The home
// community `home` is apart from the shared one, so what the core reads on its own never counts as a turn's read.
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
import type { Running } from './fixtures/two-fakes.ts';

const SHARED = [{ id: 'shared', name: 'Same id' }];
const NAMES = ['one', 'two'];
const ORDERS = [
  ['one', 'two'],
  ['two', 'one'],
] as const;

/** Sends a mention on `from` and answers the reads of the shared community its turn made, on both interfaces. */
async function turnReads(from: Running, other: Running, id: string): Promise<{ own: number; foreign: number }> {
  const room = `room-${from.iface}`;
  seedRoom(from, room, 'shared');
  const foreignBefore = readsOf(other, 'shared').length;
  const ownBefore = readsOf(from, 'shared').length;
  await mentionIn(from, room, 'shared', id);
  await waitFor(() => postedIn(from, room).length > 0, `the answer on ${from.iface}`);
  return {
    own: readsOf(from, 'shared').length - ownBefore,
    foreign: readsOf(other, 'shared').length - foreignBefore,
  };
}

for (const [first, second] of ORDERS) {
  test(`a turn on the first interface to connect reads its own shared community, ${first} before ${second}`, async () => {
    // Bug: the last hello overwrites the route of a native id, so the first interface's turn asks the second.
    await withFakes({ names: NAMES }, async ({ connect }) => {
      const earlier = await connect(first, SHARED);
      const later = await connect(second, SHARED);
      const reads = await turnReads(earlier, later, 'm1');
      assert.equal(reads.foreign, 0);
      assert.notEqual(reads.own, 0);
    });
  });
}

test('a DM gate on the first interface asks membership of its own shared community', async () => {
  // Bug: the community leaves the first interface's list when the second says hello, so its member is refused as a stranger.
  await withFakes({ owners: ['u1'], names: NAMES }, async ({ connect }) => {
    const earlier = await connect('one', SHARED);
    const later = await connect('two', SHARED);
    seedRoom(earlier, 'r1', 'shared');
    seedPerson(earlier, 'shared', 'u1', 'Eleni');
    await mentionIn(earlier, 'r1', 'shared', 'm1');
    await waitFor(() => postedIn(earlier, 'r1').length > 0, 'the answer in the room');
    seedDm(earlier, 'd1', 'u1');
    const before = readsOf(later, 'shared').length;
    await directIn(earlier, 'd1', 'u1', 'm2');
    await waitFor(() => postedIn(earlier, 'd1').length > 0, 'the answer to the DM');
    assert.equal(readsOf(later, 'shared').length, before);
  });
});

test('disconnecting one interface keeps the route of the other that shares its community id', async () => {
  // Bug: the route still names the closed link, so the remaining interface's reads answer nothing.
  await withFakes({ names: NAMES }, async ({ connect }) => {
    const staying = await connect('one', SHARED);
    const leaving = await connect('two', SHARED);
    await leaving.stop();
    const reads = await turnReads(staying, leaving, 'm1');
    assert.notEqual(reads.own, 0);
  });
});

test('a reconnect of one interface does not take the shared community from the other', async () => {
  // Bug: a reconnect says hello again, and the route of the shared id goes to whoever greeted last.
  await withFakes({ names: NAMES }, async ({ connect }) => {
    const steady = await connect('two', SHARED);
    const returning = await connect('one', SHARED);
    await steady.reconnect();
    await returning.reconnect();
    const reads = await turnReads(steady, returning, 'm1');
    assert.equal(reads.foreign, 0);
    assert.notEqual(reads.own, 0);
  });
});

test('after a reconnect the returning interface reads its own community again', async () => {
  // Bug: the qualified origin is taken from the first hello only, so the new link serves no route.
  await withFakes({ names: NAMES }, async ({ connect }) => {
    const returning = await connect('one', SHARED);
    const steady = await connect('two', SHARED);
    await returning.reconnect();
    await steady.reconnect();
    const reads = await turnReads(returning, steady, 'm1');
    assert.equal(reads.foreign, 0);
    assert.notEqual(reads.own, 0);
  });
});
