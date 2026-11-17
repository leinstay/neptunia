// The core's index of the root's custom emoji (src/behavior/emoji-index.ts), kept from the interface's `emoji.list`
// read for 60 seconds. The turn refreshes it before it builds a request; `byName` and `list` then answer without
// waiting, from what the last refresh held. The interface sends no event when an emoji changes, so the age of the
// list is the only thing that brings a change in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IFACE, ROOT, rig } from './fixtures/reads-rig.ts';
import { createEmojiIndex } from '../src/behavior/emoji-index.ts';

type MediaName = {
  name: string;
  kind: 'emoji' | 'sticker';
  iface: string;
  nativeId: string;
  platformName: string;
  animated: boolean;
};
type Item = { nativeId: string; platformName: string; animated: boolean };

/** The store's stable names as a fake: a counter per kind, a rename keeps the name. */
function fakeNames(seed: Array<MediaName> = []) {
  const rows: Array<MediaName> = [...seed];
  return {
    rows,
    nameMedia(iface: string, kind: 'emoji' | 'sticker', items: ReadonlyArray<Item>): Array<MediaName> {
      return items.map((item) => {
        const held = rows.find((row) => row.iface === iface && row.kind === kind && row.nativeId === item.nativeId);
        if (held) return Object.assign(held, { platformName: item.platformName, animated: item.animated });
        const row = { name: `${kind[0]}${rows.filter((one) => one.kind === kind).length + 1}`, kind, iface, ...item };
        rows.push(row);
        return row;
      });
    },
    mediaNameOf: (name: string): MediaName | null => rows.find((row) => row.name === name) ?? null,
  };
}

const MINUTE = 60_000;
const START = 1_700_000_000_000;
const FOX = { id: '101', name: 'fox', animated: false, url: 'https://cdn.example/emoji/101.png' };
const PARTY = { id: '102', name: 'party', animated: true, url: 'https://cdn.example/emoji/102.gif' };

function setup() {
  const world = rig();
  world.fake.seedEmoji(ROOT, [FOX, PARTY]);
  const clock = { ms: START };
  const names = fakeNames();
  const index = createEmojiIndex({ reads: world.reads, now: () => clock.ms, iface: IFACE, names });
  return { ...world, clock, index, names };
}

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('knows nothing before the first refresh', () => {
  const { index } = setup();
  assert.equal(index.byName('e1'), null);
  assert.deepEqual(index.list(), []);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('lists the emoji of the root by stable name, without their addresses', async () => {
  const { index } = setup();
  await index.refresh(ROOT);
  assert.deepEqual(index.list(), [
    { id: '101', name: 'e1', platformName: 'fox', animated: false },
    { id: '102', name: 'e2', platformName: 'party', animated: true },
  ]);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('finds an emoji by its stable name with its current platform name and id', async () => {
  const { index } = setup();
  await index.refresh(ROOT);
  assert.deepEqual(index.byName('e2'), { id: '102', name: 'e2', platformName: 'party', animated: true });
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('finds nothing by a platform name', async () => {
  const { index } = setup();
  await index.refresh(ROOT);
  assert.equal(index.byName('fox'), null);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('names every emoji of the list through the store when it reads the list', async () => {
  const { index, names } = setup();
  await index.refresh(ROOT);
  assert.deepEqual(
    names.rows.map(({ name, iface, nativeId }) => [name, iface, nativeId]),
    [
      ['e1', IFACE, '101'],
      ['e2', IFACE, '102'],
    ]
  );
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('finds nothing for a stable name whose id the current list no longer holds', async () => {
  const world = rig();
  world.fake.seedEmoji(ROOT, [FOX]);
  const names = fakeNames([
    { name: 'e1', kind: 'emoji', iface: IFACE, nativeId: '555', platformName: 'gone', animated: false },
  ]);
  const index = createEmojiIndex({ reads: world.reads, now: () => START, iface: IFACE, names });
  await index.refresh(ROOT);
  assert.equal(index.byName('e1'), null);
  assert.equal(index.byName('e2')?.id, '101');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test("finds nothing for a stable name of another interface's emoji with the same id", async () => {
  const world = rig();
  world.fake.seedEmoji(ROOT, [FOX]);
  const names = fakeNames([
    { name: 'e1', kind: 'emoji', iface: 'other', nativeId: '101', platformName: 'fox', animated: false },
  ]);
  const index = createEmojiIndex({ reads: world.reads, now: () => START, iface: IFACE, names });
  await index.refresh(ROOT);
  assert.equal(index.byName('e1'), null);
  assert.equal(index.byName('e2')?.platformName, 'fox');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('finds nothing for an emoji the platform marks unavailable', async () => {
  const { index, fake } = setup();
  fake.seedEmoji(ROOT, [{ ...FOX, available: false }, PARTY]);
  await index.refresh(ROOT);
  assert.equal(index.byName('e1'), null);
  assert.equal(index.byName('e2')?.id, '102');
});

test('gives the address of an emoji by id, and null for an id it does not hold', async () => {
  const { index } = setup();
  await index.refresh(ROOT);
  assert.equal(index.urlOf('102'), PARTY.url);
  assert.equal(index.urlOf('999'), null);
});

test('reads the interface once for refreshes inside 60 seconds and again at 60 seconds', async () => {
  const { index, clock, asked } = setup();
  await index.refresh(ROOT);
  clock.ms += MINUTE - 1;
  await index.refresh(ROOT);
  assert.equal(asked('emoji').length, 1);
  clock.ms += 1;
  await index.refresh(ROOT);
  assert.equal(asked('emoji').length, 2);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('shows a change of the list once the 60 seconds are over', async () => {
  const { index, clock, fake } = setup();
  await index.refresh(ROOT);
  fake.seedEmoji(ROOT, [FOX]);
  clock.ms += MINUTE - 1;
  await index.refresh(ROOT);
  assert.equal(index.byName('e2')?.id, '102');
  clock.ms += 1;
  await index.refresh(ROOT);
  assert.equal(index.byName('e2'), null);
});

test('reads once for refreshes that overlap', async () => {
  const { index, asked } = setup();
  await Promise.all([index.refresh(ROOT), index.refresh(ROOT), index.refresh(ROOT)]);
  assert.equal(asked('emoji').length, 1);
});

// The index took a getter of the current root; plan 2026-11-04-cli-and-memory B0 removes it, so each refresh names its place.
// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('asks for the emoji of the place the refresh names', async () => {
  const world = rig();
  world.fake.seedEmoji(ROOT, [FOX]);
  world.fake.seedEmoji('g2', [PARTY]);
  const index = createEmojiIndex({ reads: world.reads, now: () => START, iface: IFACE, names: fakeNames() });
  await index.refresh(ROOT);
  assert.deepEqual(world.asked('emoji'), [{ placeId: ROOT }]);
  assert.equal(index.byName('e1')?.id, '101');
  await index.refresh('g2');
  assert.equal(index.byName('e2')?.id, '102');
  assert.equal(index.byName('e1'), null);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('reads both places when two refreshes for different places overlap', async () => {
  const world = rig();
  world.fake.seedEmoji(ROOT, [FOX]);
  world.fake.seedEmoji('g2', [PARTY]);
  const index = createEmojiIndex({ reads: world.reads, now: () => START, iface: IFACE, names: fakeNames() });
  await Promise.all([index.refresh(ROOT), index.refresh('g2')]);
  assert.deepEqual(world.asked('emoji'), [{ placeId: ROOT }, { placeId: 'g2' }]);
  assert.equal(index.byName('e2')?.id, '102');
});

// A private chat held no emoji only when no root was served; it read the first one. B0 makes that the interface's answer.
// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('asks the interface with no place for a turn outside any tree, and lists what it answers', async () => {
  const { index, asked } = setup();
  await index.refresh(null);
  assert.deepEqual(asked('emoji'), [{ placeId: null }]);
  assert.equal(index.byName('e1')?.id, '101');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('keeps the last list when a refresh fails and reads again at the next refresh', async () => {
  const { index, clock, asked, fake } = setup();
  await index.refresh(ROOT);
  fake.failNext('emoji', { status: 'failed', error: { code: 'down', retryable: true } });
  clock.ms += MINUTE;
  await index.refresh(ROOT);
  assert.equal(index.byName('e1')?.id, '101');
  await index.refresh(ROOT);
  assert.equal(asked('emoji').length, 3);
});

test('holds no emoji when the interface does not offer the read', async () => {
  const world = rig({ reads: ['messages.fetch'] });
  const index = createEmojiIndex({ reads: world.reads, now: () => START, iface: IFACE, names: fakeNames() });
  await index.refresh(ROOT);
  assert.deepEqual(index.list(), []);
  assert.deepEqual(world.asked('emoji'), []);
});
