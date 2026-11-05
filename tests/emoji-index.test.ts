// The core's index of the community's custom emoji (src/behavior/emoji-index.ts), kept from the interface's `emoji.list`
// read for 60 seconds. The turn refreshes it before it builds a request; `byName` and `list` then answer without
// waiting, from what the last refresh held. The interface sends no event when an emoji changes, so the age of the
// list is the only thing that brings a change in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMUNITY, rig } from './fixtures/reads-rig.ts';
import { createEmojiIndex } from '../src/behavior/emoji-index.ts';

const MINUTE = 60_000;
const START = 1_700_000_000_000;
const FOX = { id: '101', name: 'fox', animated: false, url: 'https://cdn.example/emoji/101.png' };
const PARTY = { id: '102', name: 'party', animated: true, url: 'https://cdn.example/emoji/102.gif' };

function setup() {
  const world = rig();
  world.fake.seedEmoji(COMMUNITY, [FOX, PARTY]);
  const clock = { ms: START };
  const index = createEmojiIndex({ reads: world.reads, now: () => clock.ms });
  return { ...world, clock, index };
}

test('knows nothing before the first refresh', () => {
  const { index } = setup();
  assert.equal(index.byName('fox'), null);
  assert.deepEqual(index.list(), []);
});

test('lists the emoji of the community without their addresses and finds one by name', async () => {
  const { index } = setup();
  await index.refresh(COMMUNITY);
  assert.deepEqual(index.list(), [
    { id: '101', name: 'fox', animated: false },
    { id: '102', name: 'party', animated: true },
  ]);
  assert.deepEqual(index.byName('party'), { id: '102', name: 'party', animated: true });
});

test('matches a name case-insensitively when only one emoji answers to it, and exactly when two do', async () => {
  const { index, fake } = setup();
  fake.seedEmoji(COMMUNITY, [
    { id: '1', name: 'Wave', animated: false, url: 'u1' },
    { id: '2', name: 'wave', animated: false, url: 'u2' },
    { id: '3', name: 'Fox', animated: false, url: 'u3' },
  ]);
  await index.refresh(COMMUNITY);
  assert.equal(index.byName('wave')?.id, '2');
  assert.equal(index.byName('WAVE'), null);
  assert.equal(index.byName('fox')?.id, '3');
});

test('gives the address of an emoji by id, and null for an id it does not hold', async () => {
  const { index } = setup();
  await index.refresh(COMMUNITY);
  assert.equal(index.urlOf('102'), PARTY.url);
  assert.equal(index.urlOf('999'), null);
});

test('reads the interface once for refreshes inside 60 seconds and again at 60 seconds', async () => {
  const { index, clock, asked } = setup();
  await index.refresh(COMMUNITY);
  clock.ms += MINUTE - 1;
  await index.refresh(COMMUNITY);
  assert.equal(asked('emoji').length, 1);
  clock.ms += 1;
  await index.refresh(COMMUNITY);
  assert.equal(asked('emoji').length, 2);
});

test('shows a change of the list once the 60 seconds are over', async () => {
  const { index, clock, fake } = setup();
  await index.refresh(COMMUNITY);
  fake.seedEmoji(COMMUNITY, [FOX]);
  clock.ms += MINUTE - 1;
  await index.refresh(COMMUNITY);
  assert.equal(index.byName('party')?.id, '102');
  clock.ms += 1;
  await index.refresh(COMMUNITY);
  assert.equal(index.byName('party'), null);
});

test('reads once for refreshes that overlap', async () => {
  const { index, asked } = setup();
  await Promise.all([index.refresh(COMMUNITY), index.refresh(COMMUNITY), index.refresh(COMMUNITY)]);
  assert.equal(asked('emoji').length, 1);
});

// The index took a getter of the current community; plan 2026-11-04-cli-and-memory B0 removes it, so each refresh names its place.
test('asks for the emoji of the place the refresh names', async () => {
  const world = rig();
  world.fake.seedEmoji(COMMUNITY, [FOX]);
  world.fake.seedEmoji('g2', [PARTY]);
  const index = createEmojiIndex({ reads: world.reads, now: () => START });
  await index.refresh(COMMUNITY);
  assert.deepEqual(world.asked('emoji'), [{ placeId: COMMUNITY }]);
  assert.equal(index.byName('fox')?.id, '101');
  await index.refresh('g2');
  assert.equal(index.byName('party')?.id, '102');
  assert.equal(index.byName('fox'), null);
});

test('reads both places when two refreshes for different places overlap', async () => {
  const world = rig();
  world.fake.seedEmoji(COMMUNITY, [FOX]);
  world.fake.seedEmoji('g2', [PARTY]);
  const index = createEmojiIndex({ reads: world.reads, now: () => START });
  await Promise.all([index.refresh(COMMUNITY), index.refresh('g2')]);
  assert.deepEqual(world.asked('emoji'), [{ placeId: COMMUNITY }, { placeId: 'g2' }]);
  assert.equal(index.byName('party')?.id, '102');
});

// A private chat held no emoji only when no community was served; it read the first one. B0 makes that the interface's answer.
test('asks the interface with no place for a turn outside any tree, and lists what it answers', async () => {
  const { index, asked } = setup();
  await index.refresh(null);
  assert.deepEqual(asked('emoji'), [{ placeId: null }]);
  assert.equal(index.byName('fox')?.id, '101');
});

test('keeps the last list when a refresh fails and reads again at the next refresh', async () => {
  const { index, clock, asked, fake } = setup();
  await index.refresh(COMMUNITY);
  fake.failNext('emoji', { status: 'failed', error: { code: 'down', retryable: true } });
  clock.ms += MINUTE;
  await index.refresh(COMMUNITY);
  assert.equal(index.byName('fox')?.id, '101');
  await index.refresh(COMMUNITY);
  assert.equal(asked('emoji').length, 3);
});

test('holds no emoji when the interface does not offer the read', async () => {
  const world = rig({ reads: ['messages.fetch'] });
  const index = createEmojiIndex({ reads: world.reads, now: () => START });
  await index.refresh(COMMUNITY);
  assert.deepEqual(index.list(), []);
  assert.deepEqual(world.asked('emoji'), []);
});
