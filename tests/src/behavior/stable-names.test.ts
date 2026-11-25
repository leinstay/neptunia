import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatInfo, MessageEvent } from '../../../src/protocol/adapter.ts';
import type { PortResult } from '../../../src/protocol/actions.ts';
import type { Message } from '../../../src/protocol/events.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { nameEventMedia, nameMessageMedia, withStableNames } from '../../../src/behavior/stable-names.ts';
import type { MediaNamer } from '../../../src/behavior/stable-names.ts';
import type { MediaName } from '../../../src/memory/store-media-names.ts';
import { channelInfo, deliver, lineEvent, until, withFakeCore } from '../../fixtures/core-over-fake.ts';
import type { Fake, LineOptions } from '../../fixtures/core-over-fake.ts';

/** Names as the store issues them: `e1`, `e2`... and `s1`, `s2`... by native id, the same id keeping its name. */
function namer(): MediaNamer {
  const held = new Map<string, MediaName>();
  const count = { emoji: 0, sticker: 0 };
  return {
    nameMedia(iface, kind, items) {
      return items.map((item) => {
        const key = `${iface}|${kind}|${item.nativeId}`;
        const known = held.get(key);
        if (known !== undefined) return known;
        count[kind] += 1;
        const row: MediaName = { name: `${kind === 'emoji' ? 'e' : 's'}${count[kind]}`, kind, iface, ...item };
        held.set(key, row);
        return row;
      });
    },
  };
}

const POG = { id: '111', name: 'pog', animated: false };

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    author: { id: 'u1', name: 'Alice', self: false, bot: false },
    content: 'nice <emoji:111> job',
    at: 1000,
    replyToId: null,
    replyPingAccountId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [POG],
    reactions: [],
    ...over,
  };
}

function eventOf(over: Partial<Message> = {}): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'fake',
    at: 1000,
    id: 'fake:message:m1',
    chat: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'c1' },
    message: message(over),
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

const CHAT_INFO: ChatInfo = {
  id: 'c1',
  kind: 'channel',
  rootId: 'g1',
  name: 'c1',
  topic: null,
  chatType: 'channel',
  iface: 'fake',
  permissions: { read: true, send: true, attach: true, react: true },
  owner: null,
  lastMessageAt: null,
  voice: false,
  public: true,
  audience: {
    everyone: true,
    groups: [],
    groupAllow: [],
    groupDeny: [],
    memberAllow: [],
    memberDeny: [],
    memberGroups: {},
  },
};

function seededPort() {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self' });
  port.seedChat(CHAT_INFO);
  port.seedEvent(eventOf());
  return port;
}

const REF = { iface: 'fake', chatId: 'c1' };

test('nameMessageMedia writes an emoji token in the content as its stable name', () => {
  const named = nameMessageMedia(message(), 'fake', namer());
  assert.equal(named.content, 'nice :e1: job');
});

test('nameMessageMedia puts the stable name in the name of an emoji entry', () => {
  const named = nameMessageMedia(message(), 'fake', namer());
  assert.deepEqual(named.emojis, [{ id: '111', name: 'e1', animated: false }]);
});

test('nameMessageMedia gives a sticker its s name', () => {
  const sticker = { id: '900', name: 'frog', format: 1 };
  const named = nameMessageMedia(message({ stickers: [sticker] }), 'fake', namer());
  assert.deepEqual(named.stickers, [{ id: '900', name: 's1', format: 1 }]);
});

test('nameMessageMedia names a custom reaction and leaves a unicode reaction as it is', () => {
  const custom = { emoji: '<emoji:333>', name: 'party', count: 2 };
  const unicode = { emoji: '👍', count: 1 };
  const named = nameMessageMedia(message({ emojis: [], content: 'hi', reactions: [custom, unicode] }), 'fake', namer());
  assert.deepEqual(named.reactions, [{ emoji: '<emoji:333>', name: 'e1', count: 2 }, unicode]);
});

test('nameMessageMedia names the emoji of a forwarded part', () => {
  const part = { content: 'look <emoji:444>', emojis: [{ id: '444', name: 'eyes' }] };
  const named = nameMessageMedia(message({ emojis: [], content: 'fwd', forwarded: [part] }), 'fake', namer());
  assert.deepEqual(named.forwarded, [{ content: 'look :e1:', emojis: [{ id: '444', name: 'e1' }] }]);
});

test('nameEventMedia names the message before an edit', () => {
  const edited = { ...eventOf({ content: 'plain', emojis: [] }), edit: true, previous: message() };
  const named = nameEventMedia(edited, namer());
  assert.equal(named.previous?.content, 'nice :e1: job');
});

test('withStableNames names the events history answers', async () => {
  const port = withStableNames(seededPort(), namer());
  const answer = await port.history(REF, { limit: 10 });
  const contents = answer.status === 'ok' ? answer.events.map((event) => event.message.content) : [answer.status];
  assert.deepEqual(contents, ['nice :e1: job']);
});

// Bug: a token whose id the message's emojis do not hold stopped a read of history.
test('withStableNames leaves out of a history answer the one event whose token names no entry', async () => {
  const port = seededPort();
  port.seedEvent({ ...eventOf({ id: 'm2', content: 'bad <emoji:999>', emojis: [] }), id: 'fake:message:m2' });
  const answer = await withStableNames(port, namer()).history(REF, { limit: 10 });
  const contents = answer.status === 'ok' ? answer.events.map((event) => event.message.content) : [answer.status];
  assert.deepEqual(contents, ['nice :e1: job']);
});

// Bug: a token whose id the message's emojis do not hold stopped a read of history.
test('withStableNames answers as missing the fetched message whose token names no entry', async () => {
  const port = seededPort();
  port.seedEvent({ ...eventOf({ id: 'm2', content: 'bad <emoji:999>', emojis: [] }), id: 'fake:message:m2' });
  const answer = await withStableNames(port, namer()).fetchMessages(REF, ['m1', 'm2']);
  const found = answer.status === 'ok' ? answer.messages : [];
  assert.deepEqual(
    found.map((one) => [one.messageId, one.missing === true, one.text]),
    [
      ['m1', false, 'nice :e1: job'],
      ['m2', true, undefined],
    ]
  );
});

test('withStableNames names the event and the text fetchMessages answers', async () => {
  const fake = seededPort();
  const port = withStableNames(fake, namer());
  const answer = await port.fetchMessages(REF, ['m1']);
  const found = answer.status === 'ok' ? answer.messages[0] : null;
  const event = found?.event;
  assert.equal(found?.text, 'nice :e1: job');
  assert.equal(event?.message.content, 'nice :e1: job');
});

test('withStableNames passes a refused fetchMessages answer through unchanged', async () => {
  const fake = seededPort();
  const refusal: PortResult = {
    status: 'failed',
    error: { code: 'X_DOWN', retryable: true, retryAfterMs: null },
  };
  fake.failNext('fetchMessages', refusal);
  const answer = await withStableNames(fake, namer()).fetchMessages(REF, ['m1']);
  assert.equal(answer.status, 'failed');
  assert.equal('messages' in answer, false);
});

test('withStableNames passes every other method through to the adapter', async () => {
  const fake = seededPort();
  const port = withStableNames(fake, namer());
  const sent = await port.send(REF, { text: 'hello' });
  assert.equal(sent.status, 'ok');
  assert.equal(fake.messagesIn('c1').length, 1);
});

const NOW = Date.now();
const seed = (fake: Fake): void => fake.seedChat(channelInfo('c1', { name: 'general' }));

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
test("shows a custom emoji reaction and a sticker by their stable names in the persona's request", async () => {
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
