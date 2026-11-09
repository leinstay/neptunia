// How her words are rendered for a place whose interface has no markup of its own (src/turn/sends.ts#renderPost): the
// core serves one interface and routes the owner's command line (src/interface/link.ts#createIfaceRouter), and a post in
// the command line once carried the served platform's mention, channel link, custom emoji and jump link forms. On a place
// whose interface declares none of them, a mention reads as the person's name, a channel handle as the place's name, an
// unknown emoji as written and a `#N` as the number the owner sees on that line. Synthetic ids and names, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_HANDLE_PREFIX, handleOf } from '../src/behavior/handles.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createIfaceRouter } from '../src/interface/link.ts';
import type { Capabilities } from '../src/protocol/adapter.ts';
import { createSends } from '../src/turn/sends.ts';
import type { RenderedPost } from '../src/turn/sends.ts';

const MEMBER = '410000000000000001';
const MEMBER_NAME = 'Robin';
const ROOM = '520000000000000002';
const ROOM_NAME = 'general';
const MEMBER_HANDLE = handleOf(MEMBER);
const ROOM_HANDLE = handleOf(ROOM, undefined, CHANNEL_HANDLE_PREFIX);
const WAVE = { id: '7', name: 'wave', animated: false };
/** The stored line her request numbered `#2`, and the number the owner's chat shows on it. */
const QUOTED = 'cli-message-2';
const OWNER_NUMBER = 41;

type Port = { capabilities: () => Capabilities };

/** Replaces what `port` declares with `change` of it. */
function declare(port: Port, change: (own: Capabilities) => Capabilities): void {
  const own = port.capabilities.bind(port);
  port.capabilities = () => change(own());
}

/** A router serving `served` that routes `cli`, which declares no markup of its own. */
function routerOf(): ReturnType<typeof createIfaceRouter> {
  const served = createFakeAdapter({ iface: 'served' });
  const cli = createFakeAdapter({ iface: 'cli' });
  declare(cli, (caps) => ({
    ...caps,
    messageUrl: null,
    customEmoji: false,
    mentions: false,
    channelLinks: false,
  }));
  return createIfaceRouter(
    served,
    (iface) => (iface === 'cli' ? cli : null),
    () => [cli]
  );
}

/** The sends over the router, an emoji index that knows `wave`, and a store that numbers the owner's lines. */
function sendsOf(): ReturnType<typeof createSends> {
  return createSends({
    hot: { config: { features: { customEmoji: true, messageLinks: true, channelLinks: true } }, prompts: null },
    store: {
      lineNumberOf: (placeId: string, messageId: string) =>
        placeId === 'cli:dm:owner' && messageId === QUOTED ? OWNER_NUMBER : null,
    },
    emoji: { byName: (name: string) => (name === WAVE.name ? WAVE : null) },
    chatName: (id: string) => (id === ROOM ? ROOM_NAME : null),
    clock: () => 0,
    schedule: () => null,
    activity: null,
    iface: routerOf(),
  });
}

/** `written` rendered for a direct chat of `iface`, with the member and the room under their handles. */
function render(written: string, iface: 'cli' | 'served'): RenderedPost {
  const chat = iface === 'cli' ? 'cli:dm:owner' : 'd1';
  return sendsOf().renderPost(written, {
    channel: { id: chat, rootId: null, iface },
    placeId: chat,
    dmChat: true,
    idByIndex: new Map([[2, QUOTED]]),
    knownNames: [{ name: MEMBER_NAME, id: MEMBER }],
    handles: new Map([[MEMBER_HANDLE, MEMBER]]),
    channelHandles: new Map([[ROOM_HANDLE, ROOM]]),
  });
}

test('a mention in the command line reads as the person name and notifies nobody', () => {
  // Bug: the terminal showed `<@410000000000000001>` where she named someone.
  const post = render(`ask @${MEMBER_HANDLE} about it`, 'cli');
  assert.equal(post.text, `ask ${MEMBER_NAME} about it`);
  assert.deepEqual(post.accountIds, []);
});

test('a channel handle in the command line reads as the place name', () => {
  // Bug: the terminal showed `<#520000000000000002>` where she named a channel.
  assert.equal(render(`see #${ROOM_HANDLE}`, 'cli').text, `see ${ROOM_NAME}`);
});

test('a custom emoji name in the command line stays as she wrote it', () => {
  // Bug: the terminal showed the served platform's `<:wave:7>` markup.
  assert.equal(render('hi :wave:', 'cli').text, 'hi :wave:');
});

test('a numbered line in the command line reads as the number the owner sees on it', () => {
  // Bug: `#2` counted the lines of her request, so the owner looked up the wrong line, or got a served-platform link.
  assert.equal(render('as in #2', 'cli').text, `as in #${OWNER_NUMBER}`);
});

test('a number the owner chat cannot place stays as she wrote it', () => {
  assert.equal(render('as in #3', 'cli').text, 'as in #3');
});

test('a mention whose person has no known name keeps the handle she wrote', () => {
  // Bug: an unnamed member vanished from her sentence, or showed as a raw id.
  const post = sendsOf().renderPost('ask @uzzzz', {
    channel: { id: 'cli:dm:owner', rootId: null, iface: 'cli' },
    placeId: 'cli:dm:owner',
    dmChat: true,
    idByIndex: null,
    handles: new Map([['uzzzz', '999']]),
  });
  assert.equal(post.text, 'ask @uzzzz');
});

test('the served interface keeps its mention, channel link, emoji and jump link forms', () => {
  const post = render(`@${MEMBER_HANDLE} #${ROOM_HANDLE} :wave: #2`, 'served');
  assert.ok(post.text.includes(`<@${MEMBER}>`), post.text);
  assert.ok(post.text.includes(`<#${ROOM}>`), post.text);
  assert.ok(post.text.includes('<:wave:7>'), post.text);
  assert.ok(post.text.includes(`/${QUOTED}`), post.text);
  assert.deepEqual(post.accountIds, [MEMBER]);
});

test('a posted identity of a line in another place of this interface links through the chat its place row holds', () => {
  // Bug: the link took the interface and the chat parsed out of the place ids, so a line in a place with an opaque id
  // went out as a quote, or as a link to a chat that does not exist.
  const club = { iface: 'served', kind: 'channel', nativeId: 'c-club', partnerNativeId: null };
  const here = { iface: 'served', kind: 'dm', nativeId: null, partnerNativeId: MEMBER };
  const sends = createSends({
    hot: { config: { features: { messageLinks: true } }, prompts: null },
    store: { placeRefOf: (id: string) => (id === 'place:club' ? club : id === 'place:here' ? here : null) },
    emoji: { byName: () => null },
    chatName: () => null,
    clock: () => 0,
    schedule: () => null,
    activity: null,
    iface: routerOf(),
  });
  const line = { placeId: 'place:club', messageId: 'm77', path: ['served', 'club'], at: 0, text: 'x', revision: 1 };
  const post = sends.renderPost('see src:served:m77:1', {
    channel: { id: 'd1', rootId: null, iface: 'served' },
    placeId: 'place:here',
    dmChat: true,
    idByIndex: null,
    refs: {
      placeId: 'place:here',
      lineOf: (key) => (key === 'src:served:m77' ? { ...line, deleted: false, dm: false } : null),
      timezone: 'UTC',
    },
  });
  assert.ok(post.text.includes('/c-club/m77'), post.text);
});
