// The core's side of the owner's command line chat (src/interface/cli-chat.ts): every call goes to the chat client that
// is open now, and while none is open the chat still exists. Its info is answered, so a wake, an errand result or a
// post can find it, and a text post is kept as her line, delivered later, with a result that says so. A post with a
// file cannot be kept and is refused with `chat-closed`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCliChat } from '../src/interface/cli-chat.ts';
import { closedAdapter } from '../src/interface/link.ts';
import type { Adapter, ChatRef, Delivery } from '../src/protocol/adapter.ts';
import type { Content } from '../src/protocol/actions.ts';

const NOW = Date.parse('2026-11-08T15:00:00Z');
const CHAT: ChatRef = { iface: 'cli', chatId: 'cli:dm:owner' };

/** A chat client's adapter that keeps what it was sent and answers `ok`. */
function openClient(): { adapter: Adapter; sent: Array<Content> } {
  const sent: Array<Content> = [];
  const adapter: Adapter = {
    ...closedAdapter(),
    iface: 'cli',
    send(chat: ChatRef, content: Content): Promise<Delivery> {
      sent.push(content);
      const ref = { iface: 'cli', chatId: chat.chatId, messageId: 'printed-1' };
      return Promise.resolve({ status: 'ok', ref, parts: [ref], at: NOW, idempotencyKey: 'k', error: null });
    },
  };
  return { adapter, sent };
}

test('a text post while no chat is open is kept as her line and the result says it is delivered later', async () => {
  // Bug: with no chat client connected the post ends link-closed and what she said is lost.
  const chat = createCliChat({ live: () => null, now: () => NOW, newId: () => 'kept-1' });
  const sent = await chat.send(CHAT, { text: 'are you still up?' });
  assert.equal(sent.status, 'ok');
  assert.equal(sent.deferred, true);
  assert.deepEqual(sent.ref, { iface: 'cli', chatId: 'cli:dm:owner', messageId: 'kept-1' });
  assert.equal(sent.at, NOW);
});

test('a post with a file while no chat is open is refused with chat-closed', async () => {
  // Bug: a voice note or an errand file answers ok although no chat can show it and no stored line keeps it.
  const chat = createCliChat({ live: () => null, now: () => NOW, newId: () => 'kept-2' });
  const file = { name: 'note.ogg', data: Buffer.from('ogg'), contentType: 'audio/ogg' };
  const sent = await chat.send(CHAT, { text: '', attachments: [file] });
  assert.equal(sent.status, 'failed');
  assert.equal(sent.error?.code, 'chat-closed');
});

test('the chat is described while no chat is open, as a direct chat with the owner where she may write', async () => {
  // Bug: the chat reads as unknown while closed, so a wake or an errand result there runs nowhere or is dropped.
  const chat = createCliChat({ live: () => null, now: () => NOW, newId: () => 'unused' });
  const found = await chat.chatInfo(CHAT);
  assert.equal(found.status, 'ok');
  const info = found.status === 'ok' ? found.chat : null;
  assert.equal(info?.id, 'cli:dm:owner');
  assert.equal(info?.kind, 'dm');
  assert.equal(info?.partnerId, 'owner');
  assert.equal(info?.permissions.send, true);
});

test('a post while a chat is open goes to that chat and is not marked delivered later', async () => {
  // Bug: the store answers although a chat is open, and the owner never sees the line on his screen.
  const client = openClient();
  const chat = createCliChat({ live: () => client.adapter, now: () => NOW, newId: () => 'unused' });
  const sent = await chat.send(CHAT, { text: 'hi' });
  assert.equal(sent.status, 'ok');
  assert.equal(sent.deferred, undefined);
  assert.deepEqual(
    client.sent.map((content) => content.text),
    ['hi']
  );
});

test('the open chat is asked at each call, so a chat that opens after the first post takes the next one', async () => {
  // Bug: the chat client is read once when the core starts, and a chat opened later never gets a post.
  const client = openClient();
  let open: Adapter | null = null;
  const chat = createCliChat({ live: () => open, now: () => NOW, newId: () => 'kept-3' });
  const first = await chat.send(CHAT, { text: 'one' });
  open = client.adapter;
  const second = await chat.send(CHAT, { text: 'two' });
  assert.equal(first.deferred, true);
  assert.equal(second.deferred, undefined);
  assert.deepEqual(
    client.sent.map((content) => content.text),
    ['two']
  );
});
