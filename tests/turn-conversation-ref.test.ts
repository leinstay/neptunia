// A turn runs on a conversation reference and reads everything about it through the adapter: the core over the fake
// interface (tests/fixtures/core-over-fake.ts), one member message that names the persona. The turn asks the fake for
// the conversation (`conversationInfo`) and its lines (`history`); a conversation the fake no longer knows ends the turn
// before any model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelInfo, deliver, settle, until, withFakeCore } from './fixtures/core-over-fake.ts';
import type { Fake } from './fixtures/core-over-fake.ts';

const NOW = Date.now();

function seedGeneral(fake: Fake): void {
  fake.seedConversation(channelInfo('c1', { name: 'general' }));
  deliver(fake, {
    id: 'm0',
    text: 'earlier talk about gardening',
    at: NOW - 60_000,
    authorId: 'u2',
    authorName: 'Zoe',
  });
}

test('answers a mention in a conversation it knows only through the adapter and posts into that conversation', async () => {
  await withFakeCore({ seed: seedGeneral }, async (rig) => {
    const call = deliver(rig.fake, { id: 'm1', text: 'hello there', at: NOW - 1000, mention: true });
    assert.equal(await rig.emit(call), 'ok');
    await until(() => rig.posted('c1').length === 1);
    assert.equal(rig.posted('c1')[0]?.includes('καλημέρα'), true);
  });
});

test('shows the lines the history read returned in the request', async () => {
  await withFakeCore({ seed: seedGeneral }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello there', at: NOW - 1000, mention: true }));
    await until(() => rig.requests.length > 0);
    assert.equal(rig.requestText(0).includes('earlier talk about gardening'), true);
    assert.equal(
      rig.fake.calls.some((call) => call.op === 'history'),
      true
    );
  });
});

test('reads the conversation with its audience and the speaker as the one viewer who must see it', async () => {
  await withFakeCore({ seed: seedGeneral }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello there', at: NOW - 1000, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    const infoCalls = rig.fake.calls.filter((call) => call.op === 'conversationInfo');
    assert.equal(infoCalls.length > 0, true);
    assert.deepEqual(infoCalls[0]?.args[0], { iface: 'fake', conversationId: 'c1' });
    assert.deepEqual(infoCalls[0]?.args[1], { audience: true, viewers: [] });
  });
});

test('ends the turn with no model call and no post when the adapter no longer knows the conversation', async () => {
  await withFakeCore(
    {
      seed: (fake) => {
        seedGeneral(fake);
      },
    },
    async (rig) => {
      // c9 was never seeded: conversationInfo fails with unknown-conversation.
      const lost = deliver(rig.fake, { id: 'x1', conversationId: 'c9', text: 'anyone?', at: NOW - 500, mention: true });
      assert.equal(await rig.emit(lost), 'ok');
      await settle();
      assert.equal(rig.requests.length, 0);
      assert.deepEqual(rig.posted('c9'), []);
    }
  );
});

test('answers the next mention after a turn ended unavailable', async () => {
  await withFakeCore({ seed: seedGeneral }, async (rig) => {
    await rig.emit(
      deliver(rig.fake, { id: 'x1', conversationId: 'c9', text: 'anyone?', at: NOW - 500, mention: true })
    );
    await settle();
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello there', at: NOW - 100, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    assert.equal(rig.requests.length, 1);
  });
});
