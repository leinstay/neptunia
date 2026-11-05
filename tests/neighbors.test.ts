import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationInfo } from '../src/protocol/adapter.ts';
import { fetchNeighbors } from '../src/behavior/neighbors.ts';
import { takeSnapshot } from '../src/behavior/snapshot.ts';
import { world } from './fixtures/turn-world.ts';

type Raw = Record<string, unknown>;

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
// PR 7d: the neighbours' measures are constants of src/behavior/neighbors.ts (5 messages, 60 minutes, 8 channels), so
// fetchNeighbors takes no config.

/** One message `minutesAgo` before NOW in channel `placeId`. */
function recentMessage(id: string, placeId: string, minutesAgo: number): Raw {
  return {
    id,
    placeId,
    guild: { id: 'g1' },
    channel: { name: placeId },
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
    member: { displayName: 'Alice' },
    cleanContent: 'καλημέρα',
    createdTimestamp: NOW - minutesAgo * 60_000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
  };
}

/** A conversation of community g1 whose one message is `minutesAgo` old; `send` says whether she may write there. */
function neighbour(id: string, send: boolean, minutesAgo: number) {
  const w = world();
  const held = w.channel({
    id,
    name: id,
    permissions: { send },
    lastMessageAt: NOW - minutesAgo * 60_000,
  });
  w.seed(id, [recentMessage(`${id}-m`, id, minutesAgo)]);
  return held.info;
}

async function snapshotOfWorld() {
  const snapshot = await takeSnapshot(world().reads, 'g1');
  if (snapshot === null) throw new Error('the world gave no listing');
  return snapshot;
}

test('fetchNeighbors gives a private chat no neighbours', async () => {
  const here = world().channel({ id: 'dm1', dm: true }).info;
  neighbour('talk', true, 5);
  const snapshot = await snapshotOfWorld();
  assert.deepEqual(await fetchNeighbors(world().reads, snapshot, here, NOW), []);
});

test('fetchNeighbors marks a neighbour she cannot write in as readOnly', async () => {
  const here = neighbour('here', true, 1);
  neighbour('talk', true, 5);
  neighbour('diary', false, 3);
  const neighbours = await fetchNeighbors(world().reads, await snapshotOfWorld(), here, NOW);
  assert.deepEqual(
    neighbours.map(({ placeId, readOnly }) => ({ placeId, readOnly })),
    [
      { placeId: 'diary', readOnly: true },
      { placeId: 'talk', readOnly: false },
    ]
  );
  assert.deepEqual(
    neighbours[0]?.messages.map((m) => m.id),
    ['diary-m']
  );
});

test('fetchNeighbors judges accept before the channel cap, so a refused channel takes no slot and costs no read', async () => {
  const here = neighbour('here', true, 1);
  neighbour('staff', true, 2);
  const others = Array.from({ length: 8 }, (_, n) => `talk${n}`);
  others.forEach((id, n) => neighbour(id, true, 4 + n));
  neighbour('quiet', true, 90);
  const asked: Array<string> = [];
  world().tap('history', ([ref]) => {
    asked.push((ref as { conversationId: string }).conversationId);
  });
  const snapshot = await snapshotOfWorld();
  const judged: Array<string> = [];
  const accept = (other: ConversationInfo): boolean => {
    judged.push(other.id);
    return other.id !== 'staff';
  };
  const neighbours = await fetchNeighbors(world().reads, snapshot, here, NOW, { accept });
  assert.deepEqual(
    neighbours.map((n) => n.placeId),
    others,
    'the slot staff would have taken goes to the next accepted channel'
  );
  assert.deepEqual(asked.sort(), [...others].sort());
  assert.deepEqual(judged.sort(), ['staff', ...others].sort(), 'only active channels are judged');
  const all = await fetchNeighbors(world().reads, snapshot, here, NOW);
  assert.deepEqual(
    all.map((n) => n.placeId),
    ['staff', ...others.slice(0, 7)],
    'no accept: the eight newest readable channels'
  );
});
