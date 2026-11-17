// A bot is a person to her (owner's rule of 2026-11-10, src/pipeline/handle-message.ts): a line a bot or a webhook
// writes is stored like a member's, and a bot that names her starts her turn as a member would. The core over the
// fake interface (tests/fixtures/core-over-fake.ts). Synthetic lines, in Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelInfo, deliver, lineEvent, until, withFakeCore } from './fixtures/core-over-fake.ts';
import type { Fake, LineOptions } from './fixtures/core-over-fake.ts';
import type { MessageEvent } from '../src/protocol/adapter.ts';

const NOW = Date.now();
const seed = (fake: Fake): void => fake.seedChat(channelInfo('c1', { name: 'general' }));

test("stores a bot's line as a seen line", async () => {
  await withFakeCore({ seed }, async (rig) => {
    const line = deliver(rig.fake, {
      id: 'b1',
      text: 'ο καιρός αύριο: βροχή',
      at: NOW - 1000,
      authorId: 'bot1',
      bot: true,
    });
    assert.equal(await rig.emit(line), 'ok');
    await until(() => rig.linesOf('b1').length > 0);
    assert.deepEqual(
      rig.linesOf('b1').map((row) => [row.kind, row.text]),
      [['seen', 'ο καιρός αύριο: βροχή']]
    );
  });
});

test('answers a bot that names her as she answers a member', async () => {
  await withFakeCore({ seed }, async (rig) => {
    const call = deliver(rig.fake, {
      id: 'b2',
      text: 'γεια σου',
      at: NOW - 1000,
      authorId: 'bot1',
      bot: true,
      mention: true,
    });
    assert.equal(await rig.emit(call), 'ok');
    await until(() => rig.posted('c1').length === 1);
    assert.equal(rig.requests.length, 1);
  });
});

test('stores her own line that carries a pairing phrase when its echo arrives', async () => {
  const text =
    'Your one-time pairing phrase is: πέτρα δέντρο νερό φωτιά αέρας χώμα. Type /interfaces pair followed by these six words in her command line within an hour.';
  await withFakeCore({ seed }, async (rig) => {
    assert.equal(await rig.emit(deliver(rig.fake, { id: 'k1', text, at: NOW - 1000, authorId: 'self-id' })), 'ok');
    await until(() => rig.linesOf('k1').length > 0);
    assert.equal(rig.linesOf('k1')[0]?.text, text);
  });
});

const KEKW = { id: '900', name: 'kekw', animated: false, url: 'https://cdn.example.invalid/900.png' };
const NOD = { id: '901', name: 'kekw', animated: false, url: 'https://cdn.example.invalid/901.png' };

/** A member's line with custom emoji, stickers or reactions beside its text, seeded into the fake. */
function mediaLine(
  fake: Fake,
  options: LineOptions,
  media: { emojis?: Array<object>; stickers?: Array<object>; reactions?: Array<object> }
): MessageEvent {
  const base = lineEvent(options);
  const event = { ...base, message: { ...base.message, ...media } };
  fake.seedEvent(event);
  return event;
}

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('stores a line with its custom emoji under stable names, reusing a name for an id seen before', async () => {
  await withFakeCore({ seed }, async (rig) => {
    const first = mediaLine(rig.fake, { id: 'n1', text: 'χα <emoji:900>', at: NOW - 3000 }, { emojis: [KEKW] });
    assert.equal(await rig.emit(first), 'ok');
    await until(() => rig.linesOf('n1').length > 0);
    const second = mediaLine(
      rig.fake,
      { id: 'n2', text: '<emoji:901> και <emoji:900>', at: NOW - 2000 },
      { emojis: [NOD, KEKW] }
    );
    assert.equal(await rig.emit(second), 'ok');
    await until(() => rig.linesOf('n2').length > 0);
    assert.equal(rig.linesOf('n1')[0]?.text, 'χα :e1:');
    assert.equal(rig.linesOf('n2')[0]?.text, ':e2: και :e1:');
  });
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('shows a custom emoji reaction and a sticker by their stable names in her request', async () => {
  await withFakeCore({ seed }, async (rig) => {
    const reacted = mediaLine(
      rig.fake,
      { id: 'r1', text: 'καλημέρα', at: NOW - 3000 },
      {
        reactions: [{ emoji: '<emoji:900>', name: 'kekw', animated: false, count: 2, mine: false }],
        stickers: [{ id: '700', name: 'kymata', animated: false, url: 'https://cdn.example.invalid/700.png' }],
      }
    );
    assert.equal(await rig.emit(reacted), 'ok');
    await until(() => rig.linesOf('r1').length > 0);
    assert.equal(await rig.emit(deliver(rig.fake, { id: 'r2', text: 'γεια', at: NOW - 1000, mention: true })), 'ok');
    await until(() => rig.requests.length === 1);
    const text = rig.requestText(0);
    // The owner on 2026-11-17: an emoji's and a sticker's description stands in the legend, the line holds the stable name.
    const chat = text.slice(text.indexOf('<chat>'));
    assert.ok(chat.includes('[sticker s1] [reactions: :e1: x2]'), 'the line reads both by their stable names');
    assert.ok(
      !chat.includes('kekw') && !chat.includes('kymata') && !text.includes('<emoji:'),
      'no platform name or token'
    );
    // The owner on 2026-11-17: the block of custom emoji and stickers is <media>.
    const legend = text.slice(text.lastIndexOf('<media>', text.indexOf('<chat>')), text.indexOf('<chat>'));
    assert.ok(legend.includes('kekw') && legend.includes('kymata'), 'the legend gives the platform names');
  });
});
