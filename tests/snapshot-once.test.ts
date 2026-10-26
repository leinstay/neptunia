// The conversation snapshot of a turn attempt: every rail that looks at other conversations (neighbours, pulls,
// participation, routing, the directory) reads one `conversations` listing taken once per attempt, not one read each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelInfo, deliver, until, withFakeCore } from './fixtures/core-over-fake.ts';
import type { Fake } from './fixtures/core-over-fake.ts';

const NOW = Date.now();
const CONFIG = {
  context: { neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8, pull: { sameAudience: false } },
  features: { channelPull: true, participation: true, channelRoute: true },
};

function seed(fake: Fake): void {
  fake.seedConversation(channelInfo('c1', { name: 'general', lastMessageAt: NOW - 1000 }));
  for (const [id, name] of [
    ['c2', 'garden'],
    ['c3', 'music'],
    ['c4', 'cooking'],
  ] as const) {
    fake.seedConversation(channelInfo(id, { name, lastMessageAt: NOW - 90_000 }));
    deliver(fake, { id: `${id}-1`, conversationId: id, text: `news from ${name}`, at: NOW - 90_000, authorId: 'u2' });
  }
}

const listings = (calls: ReadonlyArray<{ op: string }>): number => calls.filter((c) => c.op === 'conversations').length;

test('takes one conversations listing for one attempt however many rails read it', async () => {
  await withFakeCore({ config: CONFIG, seed }, async (rig) => {
    const before = listings(rig.fake.calls);
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    assert.equal(listings(rig.fake.calls) - before, 1);
  });
});

test('takes a new listing for the next attempt', async () => {
  await withFakeCore({ config: CONFIG, seed }, async (rig) => {
    const before = listings(rig.fake.calls);
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    await rig.emit(deliver(rig.fake, { id: 'm2', text: 'and again', at: NOW - 100, mention: true }));
    await until(() => rig.posted('c1').length === 2);
    assert.equal(listings(rig.fake.calls) - before, 2);
  });
});

test('asks the listing for the audience of every conversation and the speaker as viewer', async () => {
  await withFakeCore({ config: CONFIG, seed }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    const call = rig.fake.calls.filter((c) => c.op === 'conversations').at(-1);
    assert.deepEqual(call?.args[0], { communityId: 'g1', audience: true, viewers: [] });
  });
});
