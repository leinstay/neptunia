// The message pipeline on events alone: no platform message object, no raw handle. The core over the fake interface
// (tests/fixtures/core-over-fake.ts) gets whole `message.received` events. A system message is ignored, a late embed is
// folded into the gif library from the edit event's `previous`, a partial edit is completed by asking the adapter for
// the message, and a deletion is dated by `message.at` and carries `message.author.id`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageEvent } from '../src/protocol/adapter.ts';
import { channelInfo, deliver, lineEvent, settle, until, withFakeCore } from './fixtures/core-over-fake.ts';
import type { Fake } from './fixtures/core-over-fake.ts';

const NOW = Date.now();
const TENOR = 'https://tenor.com/view/dancing-cat-123';
const GIF = { id: 'm5#e0', kind: 'gif', url: TENOR, site: 'tenor', title: 'dancing cat' };

function seed(fake: Fake): void {
  fake.seedConversation(channelInfo('c1', { name: 'general' }));
}

/** The edit event of message `m5`: a bare link as written, then the same message with the gif Discord attached. */
function editWith(links: Array<object>, previous: MessageEvent['message'] | null): MessageEvent {
  const base = lineEvent({ id: 'm5', text: TENOR, at: NOW - 5000 });
  return {
    ...base,
    id: `fake:edit:m5:${NOW}`,
    at: NOW,
    edit: true,
    message: { ...base.message, links },
    previous,
  };
}

const logsOf = (logs: Array<Record<string, unknown>>, msg: string) => logs.filter((entry) => entry.msg === msg);

test('answers a member message that reaches the core as plain data', async () => {
  const { result } = await withFakeCore({ seed }, async (rig) => {
    assert.equal(await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true })), 'ok');
    await until(() => rig.posted('c1').length === 1);
    return rig.requests.length;
  });
  assert.equal(result, 1);
});

test('ignores a system message that names the persona', async () => {
  await withFakeCore({ seed }, async (rig) => {
    const joined = deliver(rig.fake, { id: 'm1', text: 'welcome', at: NOW - 500, mention: true, system: true });
    assert.equal(await rig.emit(joined), 'ok');
    await settle();
    assert.equal(rig.requests.length, 0);
    assert.deepEqual(rig.posted('c1'), []);
  });
});

test('folds a late embed into the gif library when the edit event carries the message as it was', async () => {
  const before = lineEvent({ id: 'm5', text: TENOR, at: NOW - 5000 }).message;
  const { logs } = await withFakeCore({ seed }, async (rig) => {
    await rig.emit(editWith([GIF], before));
    await settle();
  });
  const folded = logsOf(logs, 'events: embeds folded');
  assert.equal(folded.length, 1);
  assert.equal(folded[0]?.gifs, 1);
  assert.equal(folded[0]?.messageId, 'm5');
});

test('counts a late embed as an accepted miss when the edit event has no previous message', async () => {
  const { logs } = await withFakeCore({ seed }, async (rig) => {
    await rig.emit(editWith([GIF], null));
    await settle();
  });
  assert.equal(logsOf(logs, 'events: embeds late').length, 1);
  assert.equal(logsOf(logs, 'events: embeds folded').length, 0);
});

test('asks the adapter for the whole message of a partial edit', async () => {
  const { result } = await withFakeCore(
    {
      seed: (fake) => {
        seed(fake);
        fake.seedEvent(editWith([GIF], null));
      },
    },
    async (rig) => {
      const partial: MessageEvent = {
        ...lineEvent({ id: 'm5', text: '', at: NOW - 5000 }),
        id: `fake:edit:m5:partial:${NOW}`,
        at: NOW,
        edit: true,
        partial: true,
        message: { id: 'm5' },
      };
      assert.equal(await rig.emit(partial), 'ok');
      await settle();
      return rig.fake.calls.filter((call) => call.op === 'fetchMessages').map((call) => call.args);
    }
  );
  assert.deepEqual(result, [[{ iface: 'fake', conversationId: 'c1' }, ['m5']]]);
});

test('dates a deletion by the time of the message and not by the time of the deletion', async () => {
  const written = Date.parse('2026-10-10T10:00:00Z');
  const { result } = await withFakeCore({ config: { features: { record: true } }, seed }, async (rig) => {
    const gone: MessageEvent = {
      ...lineEvent({ id: 'm7', text: 'oops', at: written }),
      id: `fake:delete:m7`,
      at: NOW,
      deleted: true,
      message: { id: 'm7', at: written, author: { id: 'u1', name: null, self: false, bot: false } },
    };
    assert.equal(await rig.emit(gone), 'ok');
    await until(() => rig.sources('deleted').length === 1);
    return rig.sources('deleted');
  });
  assert.equal(String(result[0]?.owner_file).includes('2026-10-10'), true);
});
