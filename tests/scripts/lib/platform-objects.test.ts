// Tests for scripts/lib/platform-objects.ts: the reads of a replay with its hidden channels and messages left out. The
// chats are held by a fake interface named `fake`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenReads } from '../../../scripts/lib/platform-objects.ts';
import { hideSetsOf } from '../../../scripts/lib/replay-inner.ts';
import { useIface, world } from '../../fixtures/turn-world.ts';

useIface('fake');

const NOW = Date.parse('2026-10-19T12:00:00Z');

test('hiddenReads: history and the listing lose the hidden channels and messages, the info of a hidden channel is none', async () => {
  const message = (placeId: string, id: string) => ({
    id,
    placeId,
    channel: { name: placeId },
    guild: { id: 'g1' },
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
    member: { displayName: 'Alice' },
    cleanContent: `text ${id}`,
    createdTimestamp: NOW,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
  });
  for (const id of ['c1', 'c2', 'c3', 'c9']) world().channel({ id, placeId: 'g1' });
  world().seed('c1', [message('c1', 'm1'), message('c1', 'm2')]);
  world().seed('c9', [message('c9', 'm3')]);
  const hide = hideSetsOf({ hideChannels: ['c2', 'c9'], hideMessages: ['m1'] });
  const wrapped = hiddenReads(world().reads, hide);
  const ref = (chatId: string) => ({ iface: 'fake', chatId });
  assert.deepEqual(
    (await wrapped.history(ref('c1'), { limit: 10 }))?.events.map((event) => event.message.id),
    ['m2'],
    'a hidden message is dropped'
  );
  assert.deepEqual((await wrapped.history(ref('c9'), { limit: 10 }))?.events, [], 'a hidden channel gives no history');
  assert.deepEqual(
    (await wrapped.chats({ placeId: 'g1' }))?.chats.map((entry) => entry.id),
    ['c1', 'c3'],
    'the neighbours and the pulls never see a hidden channel'
  );
  assert.equal(await wrapped.chatInfo(ref('c2')), null);
  assert.equal((await wrapped.chatInfo(ref('c1')))?.chat.id, 'c1');
  assert.equal(hiddenReads(world().reads, hideSetsOf({})), world().reads);
});
