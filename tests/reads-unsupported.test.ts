// A fake that offers only some reads (`reads` option, wire names): the core makes no call for a read the interface did
// not declare, and a block that needs it is left out of the request. `conversation.info`, `messages.history` and
// `messages.fetch` stay on, since a turn cannot run without them. A control rig with every read shows the block the
// others miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelInfo, deliver, until, withFakeCore } from './fixtures/core-over-fake.ts';
import type { Fake } from './fixtures/core-over-fake.ts';

const NOW = Date.now();
const NEEDED = ['conversation.info', 'messages.history', 'messages.fetch'];
const CONFIG = {
  context: { neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8, pull: { sameAudience: false } },
  features: { channelPull: true },
};

function seed(fake: Fake): void {
  fake.seedConversation(channelInfo('c1', { name: 'general', lastMessageAt: NOW - 1000 }));
  fake.seedConversation(channelInfo('c2', { name: 'garden', lastMessageAt: NOW - 120_000 }));
  deliver(fake, { id: 'g1', conversationId: 'c2', text: 'tomatoes are ripe', at: NOW - 120_000, authorId: 'u2' });
}

async function turnWith(reads: ReadonlyArray<string> | undefined) {
  return withFakeCore({ config: CONFIG, ...(reads === undefined ? {} : { reads }), seed }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    return { request: rig.requestText(0), ops: rig.fake.calls.map((call) => call.op) };
  });
}

test('shows the other channels block when the interface offers the conversations read', async () => {
  const { result } = await turnWith(undefined);
  assert.equal(result.request.includes('other_channels'), true);
  assert.equal(result.request.includes('tomatoes are ripe'), true);
});

test('leaves out the other channels and channel view blocks when the conversations read is not offered', async () => {
  const { result } = await turnWith(NEEDED);
  assert.equal(result.request.includes('other_channels'), false);
  assert.equal(result.request.includes('channel_view'), false);
  assert.equal(result.request.includes('tomatoes are ripe'), false);
});

test('makes no call of a read the interface did not declare', async () => {
  const { result } = await turnWith(NEEDED);
  const asked = ['conversations', 'searchMessages', 'searchMembers', 'emoji', 'parseLinks', 'reactors', 'memberInfo'];
  assert.deepEqual(
    result.ops.filter((op) => asked.includes(op)),
    []
  );
});

test('still answers when the interface offers only the reads a turn cannot run without', async () => {
  const { result } = await turnWith(NEEDED);
  assert.equal(result.ops.includes('send'), true);
});
