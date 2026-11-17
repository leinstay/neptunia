import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatInfo, MessageEvent } from '../src/protocol/adapter.ts';
import type { PortResult } from '../src/protocol/actions.ts';
import type { Message } from '../src/protocol/events.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { nameEventMedia, nameMessageMedia, withStableNames } from '../src/behavior/stable-names.ts';
import type { MediaNamer } from '../src/behavior/stable-names.ts';
import type { MediaName } from '../src/memory/store-media-names.ts';

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
