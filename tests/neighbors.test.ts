import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationInfo } from '../src/protocol/adapter.ts';
import { fetchNeighbors } from '../src/behavior/neighbors.ts';
import { takeSnapshot } from '../src/behavior/snapshot.ts';
import { world } from './fixtures/turn-world.ts';

type Raw = Record<string, unknown>;

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MIRROR_ID = '500000000000000009';

function config(bot: Record<string, unknown> = {}, maxChannels = 8) {
  return { context: { neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: maxChannels }, bot };
}

/** One message `minutesAgo` before NOW in channel `channelId`. */
function recentMessage(id: string, channelId: string, minutesAgo: number): Raw {
  return {
    id,
    channelId,
    guild: { id: 'g1' },
    channel: { name: channelId },
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
  assert.deepEqual(await fetchNeighbors(world().reads, snapshot, here, config(), NOW), []);
});

test('fetchNeighbors marks a neighbour she cannot write in as readOnly', async () => {
  const here = neighbour('here', true, 1);
  neighbour('talk', true, 5);
  neighbour('diary', false, 3);
  const neighbours = await fetchNeighbors(world().reads, await snapshotOfWorld(), here, config(), NOW);
  assert.deepEqual(
    neighbours.map(({ channelId, readOnly }) => ({ channelId, readOnly })),
    [
      { channelId: 'diary', readOnly: true },
      { channelId: 'talk', readOnly: false },
    ]
  );
  assert.deepEqual(
    neighbours[0]?.messages.map((m) => m.id),
    ['diary-m']
  );
});

test('fetchNeighbors never takes the dry-run mirror as a neighbour', async () => {
  const here = neighbour('here', true, 1);
  neighbour(MIRROR_ID, true, 2);
  neighbour('talk', true, 4);
  const snapshot = await snapshotOfWorld();
  const withMirror = await fetchNeighbors(world().reads, snapshot, here, config({ dryRunChannelId: MIRROR_ID }), NOW);
  assert.deepEqual(
    withMirror.map((n) => n.channelId),
    ['talk']
  );
  const noMirror = await fetchNeighbors(world().reads, snapshot, here, config({ dryRunChannelId: '' }), NOW);
  assert.deepEqual(
    noMirror.map((n) => n.channelId),
    [MIRROR_ID, 'talk']
  );
});

test('fetchNeighbors judges accept before the channel cap, so a refused channel takes no slot and costs no read', async () => {
  const here = neighbour('here', true, 1);
  neighbour('staff', true, 2);
  neighbour('talk', true, 4);
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
  const neighbours = await fetchNeighbors(world().reads, snapshot, here, config({}, 1), NOW, { accept });
  assert.deepEqual(
    neighbours.map((n) => n.channelId),
    ['talk'],
    'the slot goes to the next accepted channel'
  );
  assert.deepEqual(asked, ['talk']);
  assert.deepEqual(judged.sort(), ['staff', 'talk'], 'only active channels are judged');
  const all = await fetchNeighbors(world().reads, snapshot, here, config({}, 1), NOW);
  assert.deepEqual(
    all.map((n) => n.channelId),
    ['staff'],
    'no accept: the newest readable channel'
  );
});
