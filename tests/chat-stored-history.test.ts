// src/chat/stored-history.ts: the history of the owner's command line chat answered from the lines memory stores, with
// the lines the chat client still holds merged in, so a turn after a restart of the core or of the client reads the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withStoredHistory } from '../src/chat/stored-history.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { closedAdapter } from '../src/interface/link.ts';
import { createReads } from '../src/interface/reads.ts';
import { historyLines } from '../src/behavior/lines.ts';
import { chatLines } from '../src/memory/db/chat-lines.ts';
import { mediaItemsOf, sourceLine, tellFromCacheKey, writeLineMedia } from '../src/memory/db/media-store.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { keptReference } from '../src/media/kept-files.ts';
import type { SourceLine } from '../src/chat/sessions.ts';
import type { Db } from '../src/memory/db/types.ts';
import type { Adapter, MessageEvent } from '../src/protocol/adapter.ts';

const PLACE = 'cli:dm:owner';
const CHAT = { iface: 'cli', chatId: PLACE };
const quiet = { info() {}, warn() {}, error() {} };
/** The partner's native id of the one stored direct chat, as its place row's partner account holds it. */
const partnerOf = (placeId: string): string | null => (placeId === PLACE ? 'owner' : null);

const stored = (n: number, who: 'owner' | 'her', at: number): SourceLine => ({
  id: `src-${n}`,
  placeId: PLACE,
  at,
  who,
  text: `stored ${n}`,
  nativeId: `n${n}`,
});

/** A line of the chat as the chat client sends it to the core. */
function clientLine(id: string, text: string, at: number, attachments: Array<object> = []): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'cli',
    at,
    id: `cli:message:${id}`,
    chat: { id: PLACE, kind: 'dm', rootId: null, name: 'owner', partnerId: 'owner' },
    message: {
      id,
      author: { id: 'owner', name: 'owner', self: false, bot: false },
      content: text,
      at,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments,
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

/** The chat client after a restart: it holds only the lines said since, here `events`. */
function freshClient(events: ReadonlyArray<MessageEvent>): Adapter {
  const client = createFakeAdapter({ iface: 'cli' });
  client.seedChat({
    ...clientLine('x', '', 0).chat,
    iface: 'cli',
    permissions: { read: true, send: true, attach: true, react: false },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: false,
  });
  for (const event of events) client.seedEvent(event);
  return client;
}

async function chatOf(adapter: Adapter, limit: number, before?: string) {
  const lines = await historyLines(
    createReads(adapter, quiet),
    CHAT,
    before === undefined ? { limit } : { limit, before }
  );
  return lines.map((line) => ({ id: line.id, content: line.content, self: line.self === true }));
}

test('a turn after a restart reads the stored earlier lines of the command line chat', async () => {
  // Bug: the chat block held only the line that started the turn, and she called it the first message of the chat.
  const lines = [stored(1, 'owner', 10), stored(2, 'her', 20)];
  const adapter = withStoredHistory(freshClient([clientLine('n3', 'the newest line', 30)]), () => lines, partnerOf);
  assert.deepEqual(await chatOf(adapter, 100), [
    { id: 'n1', content: 'stored 1', self: false },
    { id: 'n2', content: 'stored 2', self: true },
    { id: 'n3', content: 'the newest line', self: false },
  ]);
});

test('a line both stored and held by the chat client appears once, with the attachments the client holds', async () => {
  // Bug: the line that started the turn shows twice, or loses the image the owner sent with it.
  const image = { id: 'a1', kind: 'image', url: 'staged:a1', name: 'a.png', contentType: 'image/png' };
  const lines = [stored(1, 'owner', 10), stored(2, 'owner', 20)];
  const adapter = withStoredHistory(freshClient([clientLine('n2', 'stored 2', 20, [image])]), () => lines, partnerOf);
  const read = await createReads(adapter, quiet).history(CHAT, { limit: 100 });
  assert.deepEqual(
    read?.events.map(({ message }) => [message.id, message.attachments?.length ?? 0]),
    [
      ['n1', 0],
      ['n2', 1],
    ]
  );
});

test("a stored line's number in the owner's chat never reaches the history her turn reads", async () => {
  // Bug: the `#N` the owner's chat draws goes into her request, where she reads it as part of the line or repeats it.
  const lines = [{ ...stored(1, 'owner', 10), number: 1333 }];
  const adapter = withStoredHistory(freshClient([]), () => lines, partnerOf);
  const read = await adapter.history(CHAT, { limit: 100 });
  assert.equal(read.status, 'ok');
  assert.equal(JSON.stringify(read).includes('1333'), false);
  assert.deepEqual(await chatOf(adapter, 100), [{ id: 'n1', content: 'stored 1', self: false }]);
});

test('the history keeps the newest lines up to the limit the turn asks for', async () => {
  // Bug: the whole stored chat goes into the request past `context.channelMessages`.
  const lines = [1, 2, 3, 4, 5].map((n) => stored(n, n % 2 === 0 ? 'her' : 'owner', n * 10));
  const adapter = withStoredHistory(freshClient([]), () => lines, partnerOf);
  assert.deepEqual(
    (await chatOf(adapter, 3)).map((line) => line.id),
    ['n3', 'n4', 'n5']
  );
});

test('a page before a line holds the lines just before it', async () => {
  // Bug: a page further back repeats the newest lines.
  const lines = [1, 2, 3, 4].map((n) => stored(n, 'owner', n * 10));
  const adapter = withStoredHistory(freshClient([]), () => lines, partnerOf);
  assert.deepEqual(
    (await chatOf(adapter, 2, 'n4')).map((line) => line.id),
    ['n2', 'n3']
  );
});

test('the stored lines answer while no chat client is connected', async () => {
  // Bug: a wake in the owner's chat with the client away reads no history at all.
  const adapter = withStoredHistory(closedAdapter(), () => [stored(1, 'owner', 10)], partnerOf);
  assert.deepEqual(
    (await chatOf(adapter, 100)).map((line) => line.id),
    ['n1']
  );
});

test('a chat with no stored line and no line in the client has an empty history', async () => {
  const adapter = withStoredHistory(freshClient([]), () => [], partnerOf);
  assert.deepEqual(await chatOf(adapter, 100), []);
});

test('the history of another chat holds none of the stored lines of the owner chat', async () => {
  // Bug: the stored lines of the owner's chat leak into a chat they do not belong to.
  const lines = [stored(1, 'owner', 10)];
  const adapter = withStoredHistory(
    freshClient([]),
    (placeId) => lines.filter((line) => line.placeId === placeId),
    partnerOf
  );
  const read = await createReads(adapter, quiet).history({ iface: 'cli', chatId: 'cli:dm:someone' }, { limit: 10 });
  assert.deepEqual(read?.events ?? [], []);
});

/** A memory database holding one command line line of the owner with a picture kept under `media/cli/`. */
function storedPicture(t: { after: (fn: () => void) => void }, description: string | null) {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, text, scope_iface)
     VALUES ('s1', 'seen', 'cli', 'n1', 1, ?, '2026-11-08T10:00:00.000Z', 'look at this', 'cli')`
  ).run(PLACE);
  const kept = keptReference('media/cli/st1.png');
  const message = {
    attachments: [{ id: 'st1', kind: 'image', url: kept, name: 'kite.png', contentType: 'image/png' }],
  };
  const line = sourceLine(db, 's1');
  if (line === undefined) throw new Error('the line was not stored');
  writeLineMedia(db, line, mediaItemsOf(message), { at: '2026-11-08T10:00:00.000Z' });
  if (description !== null)
    tellFromCacheKey(db, { iface: 'cli', key: 'st1', text: description, at: '2026-11-08T10:00:01.000Z' });
  return { db, kept };
}

test('a picture of a stored line comes back with its kept file and its description after a fresh client', async (t) => {
  // Bug: after a restart a line the owner sent with a picture reads as text only, and she no longer sees the picture.
  const { db, kept } = storedPicture(t, 'A red kite over a wheat field.');
  const adapter = withStoredHistory(freshClient([]), (placeId) => chatLines(db, placeId), partnerOf);
  const [line] = await historyLines(createReads(adapter, quiet), CHAT, { limit: 100 });
  const attachments = (line?.attachments ?? []) as Array<{ id?: string; url?: string; told?: { text?: string } }>;
  assert.deepEqual(
    attachments.map((one) => [one.id, one.url, one.told?.text]),
    [['st1', kept, 'A red kite over a wheat field.']]
  );
});

test('the kept file of a stored line is linked to the line in memory', (t) => {
  // Bug: the copy exists on disk but no media row points at it, so a backup or a recall cannot find it.
  const { db } = storedPicture(t, null);
  assert.deepEqual(
    chatLines(db, PLACE).flatMap((line) => (line.media ?? []).map((row) => [row.nativeRef, row.path])),
    [['st1', 'media/cli/st1.png']]
  );
});

test('her line the chat client still holds takes the stored files it lacks', async () => {
  // Bug: while the client runs, her reply with a picture shows as text only, since the client keeps only her words.
  const picture = { id: 'f1', kind: 'image', url: keptReference('media/cli/f1.png'), name: 'drawn.png' };
  const withFile: SourceLine = {
    ...stored(4, 'her', 40),
    media: [
      {
        mediaId: 'media:cli:f1',
        position: 0,
        kind: 'image',
        nativeRef: 'f1',
        path: 'media/cli/f1.png',
        description: null,
        describedAt: null,
        availability: 'unknown',
        sha1: null,
        extra: { fileName: picture.name },
      },
    ],
  };
  const held: MessageEvent = {
    ...clientLine('n4', 'stored 4', 40),
    message: {
      ...clientLine('n4', 'stored 4', 40).message,
      author: { id: 'self', name: null, self: true, bot: false },
    },
  };
  const adapter = withStoredHistory(freshClient([held]), () => [withFile], partnerOf);
  const read = await createReads(adapter, quiet).history(CHAT, { limit: 100 });
  const first = read?.events[0];
  const attachments = (first?.message.attachments ?? []) as Array<{ id?: string; url?: string }>;
  assert.deepEqual(
    attachments.map((one) => [one.id, one.url]),
    [['f1', picture.url]]
  );
});

test('a stored reply reaches her chat as a reply to the line it answers', async () => {
  // Bug: after a restart her chat read every stored line as a reply to nothing.
  const lines = [stored(1, 'owner', 10), { ...stored(2, 'her', 20), replyToId: 'n1' }];
  const adapter = withStoredHistory(freshClient([]), () => lines, partnerOf);
  const read = await adapter.history(CHAT, { limit: 100 });
  const events = read.status === 'ok' ? read.events : [];
  assert.deepEqual(
    events.map(({ message }) => [message.id, message.replyToId]),
    [
      ['n1', null],
      ['n2', 'n1'],
    ]
  );
});

/** The name on the author of a line. */
const authorOf = ({ message }: MessageEvent): unknown => message.author?.name;

test("the owner's lines and his chat carry his person's name when one is known", async () => {
  // Bug: her chat named the owner `owner`, the command line account's own name.
  const lines = [stored(1, 'owner', 10), stored(2, 'her', 20)];
  const adapter = withStoredHistory(
    freshClient([clientLine('n3', 'the newest line', 30)]),
    () => lines,
    partnerOf,
    () => 'Robin'
  );
  const read = await adapter.history(CHAT, { limit: 100 });
  assert.equal(read.status, 'ok');
  const events = read.status === 'ok' ? read.events : [];
  assert.deepEqual(
    events.map((event) => [event.message.id, authorOf(event)]),
    [
      ['n1', 'Robin'],
      ['n2', null],
      ['n3', 'Robin'],
    ]
  );
  const info = await adapter.chatInfo(CHAT);
  assert.equal(info.status === 'ok' ? info.chat.name : null, 'Robin');
});

test("with no name known the owner's lines keep the name they came with", async () => {
  const adapter = withStoredHistory(
    freshClient([clientLine('n3', 'the newest line', 30)]),
    () => [],
    partnerOf,
    () => null
  );
  const read = await adapter.history(CHAT, { limit: 100 });
  const [first] = read.status === 'ok' ? read.events : [];
  assert.equal(first === undefined ? null : authorOf(first), 'owner');
});

test('a direct chat stored under an opaque place id is answered from its stored lines, its partner read from the row', async () => {
  // Bug: the partner was cut out of the text of the chat id, so a DM place that spells none read no stored line.
  const opaque = 'place:opaque-owner-chat';
  const line = { ...stored(1, 'owner', 10), placeId: opaque };
  const adapter = withStoredHistory(
    freshClient([]),
    (placeId) => (placeId === opaque ? [line] : []),
    (placeId) => (placeId === opaque ? 'owner' : null)
  );
  const read = await adapter.history({ iface: 'cli', chatId: opaque }, { limit: 10 });
  const events = read.status === 'ok' ? read.events : [];
  assert.deepEqual(
    events.map(({ message }) => [message.id, message.author?.id]),
    [['n1', 'owner']]
  );
});

/**
 * A memory database holding one line of the command line chat as production rows do: its own `native_id` a uuid, the
 * client's message id in `extra.$messageLocator.messageId`, and one kept picture when `withFile` is set.
 */
function twoIdLine(t: { after: (fn: () => void) => void }, kind: 'seen' | 'said', withFile: boolean) {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  const extra = JSON.stringify({
    $messageLocator: { v: 1, origin: 'protocol-message', iface: 'cli', chatId: PLACE, messageId: 'cli-msg-7' },
  });
  db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, text, scope_iface, extra)
     VALUES ('s7', ?, 'cli', '5b0e7a42-93c1-4d68-8f2a-1e6c4b9d3a07', 1, ?, '2026-11-08T10:00:00.000Z', 'the kite is red', 'cli', ?)`
  ).run(kind, PLACE, extra);
  if (withFile) {
    const message = {
      attachments: [
        {
          id: 'st7',
          kind: 'image',
          url: keptReference('media/cli/st7.png'),
          name: 'kite.png',
          contentType: 'image/png',
        },
      ],
    };
    const line = sourceLine(db, 's7');
    if (line === undefined) throw new Error('the line was not stored');
    writeLineMedia(db, line, mediaItemsOf(message), { at: '2026-11-08T10:00:00.000Z' });
  }
  return db;
}

const KITE_AT = Date.parse('2026-11-08T10:00:00.000Z');

test('holds a line once when the client and the memory both hold it and the stored row own id differs from the client message id', async (t) => {
  // Bug (2026-11-08): every line the client still held stood twice in `<chat>`, the stored copy under the row's uuid and
  // the client's under the platform's id.
  const db = twoIdLine(t, 'seen', false);
  const adapter = withStoredHistory(
    freshClient([clientLine('cli-msg-7', 'the kite is red', KITE_AT)]),
    (placeId) => chatLines(db, placeId),
    partnerOf
  );
  const read = await adapter.history(CHAT, { limit: 100 });
  const events = read.status === 'ok' ? read.events : [];
  assert.equal(events.filter(({ message }) => message.content === 'the kite is red').length, 1);
});

test('keeps the stored files on the client copy of a line whose stored row id differs from the client message id', async (t) => {
  // Bug (2026-11-08): the client's copy of her picture line found no stored files, since the stored line was keyed by
  // its uuid and the client's by the platform id, so the picture dropped out of her chat.
  const db = twoIdLine(t, 'said', true);
  const held: MessageEvent = {
    ...clientLine('cli-msg-7', 'the kite is red', KITE_AT),
    message: {
      ...clientLine('cli-msg-7', 'the kite is red', KITE_AT).message,
      author: { id: 'self', name: null, self: true, bot: false },
    },
  };
  const adapter = withStoredHistory(freshClient([held]), (placeId) => chatLines(db, placeId), partnerOf);
  const read = await adapter.history(CHAT, { limit: 100 });
  const events = read.status === 'ok' ? read.events : [];
  const copy = events.find(({ message }) => message.id === 'cli-msg-7');
  assert.deepEqual(
    (copy?.message.attachments ?? []).map((one: { id?: string }) => one.id),
    ['st7']
  );
});
