// What happens to a stored line when its message changes after it arrived (src/pipeline/edits.ts#createEdits): the
// platform may send an embed in a later update of the message (a GIF posted as an address is unfurled after the message
// is created), and the line's current revision holds that embed as an item. The real observation path
// (src/pipeline/observe.ts) over a test memory database, a fake record and a fake interface; synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEdits } from '../src/pipeline/edits.ts';
import type { MessageEvent } from '../src/pipeline/edits.ts';
import { createObserve } from '../src/pipeline/observe.ts';
import type { Message } from '../src/protocol/events.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { TestMemory } from './fixtures/memory-db/service.ts';
import { rig } from './fixtures/reads-rig.ts';
import { chatLines } from '../src/memory/db/chat-lines.ts';
import { linesAroundOf, linesSinceOf } from '../src/memory/db/frame-reads.ts';
import { internalContext } from '../src/memory/db/scope.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const ROOT = 'root';
const POSTED = 'https://tenor.example.invalid/view/spinning-cat';

/** The message as it was created: the address of a GIF as text, no embed yet. */
function created(id: string): Message {
  return {
    id,
    at: NOW - 60_000,
    content: POSTED,
    author: { id: 'member', name: 'Member', self: false, bot: false },
    replyToId: null,
    replyPingAccountId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  };
}

/** The same message as the later update carries it: the same text, and the GIF embed the platform unfurled. */
function unfurled(id: string): Message {
  const gif = {
    id: `${id}#e0`,
    kind: 'gif',
    site: 'Tenor',
    title: '',
    text: '',
    url: POSTED,
    thumbnailUrl: `https://media.example.invalid/${id}.png`,
    animationUrl: `https://media.example.invalid/${id}.mp4`,
  };
  return { ...created(id), links: [gif] };
}

function eventOf(eventId: string, message: Message, previous?: Message): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'synthetic',
    id: eventId,
    at: NOW,
    ...(previous ? { edit: true, previous } : {}),
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
    chat: { id: 'room', kind: 'channel', chatType: 'channel', rootId: ROOT },
    message,
  };
}

/** The edit handlers over the real observation path, and what the record was asked to append. */
function editsOver(memory: TestMemory) {
  const appended: Array<Array<object>> = [];
  const observed = createObserve({
    hot: memory.hot,
    selfIdOf: () => 'self',
    timers: { set: () => null, clear() {} },
    memoryDb: memory.memoryDb,
  });
  const edits = createEdits({
    hot: memory.hot,
    store: null,
    reads: rig().reads,
    isServedRoot: (id) => id === ROOT,
    selfIdOf: () => 'self',
    record: {
      append: (_placeId, lines) => {
        appended.push(lines);
        return Promise.resolve({ written: lines.length, duplicates: 0 });
      },
    },
    now: () => NOW,
    warmMediaCache: () => null,
    observeLine: observed.observeLine,
    deleteLine: observed.deleteLine,
  });
  return { observed, edits, appended };
}

/** The stored revisions of a message and the native references of the items each links, in position order. */
function stored(memory: TestMemory, native: string): Array<{ revision: unknown; refs: Array<unknown> }> {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  const lines = db
    .prepare(
      `SELECT id, revision FROM sources WHERE json_extract(extra, '$.$messageLocator.messageId') = ? AND kind = 'seen'
       ORDER BY revision`
    )
    .all(native);
  const refsOf = db.prepare(
    `SELECT m.native_ref AS ref FROM media_links l JOIN media m ON m.id = l.media_id
     WHERE l.owner_kind = 'source' AND l.owner_id = ? ORDER BY l.position`
  );
  return lines.map((line) => ({ revision: line.revision, refs: refsOf.all(line.id).map((row) => row.ref) }));
}

// Bug: an update that only brings an embed is dropped as no edit, so the describer sees a picture the line never holds.
test("an update that brings a GIF embed later links it to the line's current revision", async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    await observed.observeLine(eventOf('create-1', created('9001')), false, { placeId: ROOT });
    assert.deepEqual(stored(memory, '9001'), [{ revision: 1, refs: [] }], 'the line arrived without the embed');
    await edits.onMessageUpdate(eventOf('update-1', unfurled('9001'), created('9001')));
    assert.deepEqual(stored(memory, '9001'), [{ revision: 1, refs: ['9001#e0'] }]);
  } finally {
    await memory.close();
  }
});

// Bug: the late embed is written as a text edit, so the record shows the same words twice as two revisions.
test('an update that brings only an embed appends no revision to the record', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits, appended } = editsOver(memory);
    await observed.observeLine(eventOf('create-2', created('9002')), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-2', unfurled('9002'), created('9002')));
    const revisions = appended.flat().map((line) => (line as { revision?: unknown }).revision);
    assert.equal(
      revisions.some((revision) => revision !== 1),
      false,
      'no line of a later revision'
    );
  } finally {
    await memory.close();
  }
});

// Owner's rule of 2026-11-10: a bot is written about like a person, so a bot's edit is a revision like anyone's.
test('an edit of a bot message stores its new text as the next revision', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const bot = { id: 'helper-bot', name: 'Helper', self: false, bot: true };
    const first: Message = { ...created('9003'), author: bot, content: 'πρώτη μορφή' };
    const second: Message = { ...first, content: 'δεύτερη μορφή', editedAt: NOW - 1000 };
    await observed.observeLine(eventOf('create-3', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-3', second, first));
    assert.deepEqual(
      stored(memory, '9003').map((line) => line.revision),
      [1, 2]
    );
  } finally {
    await memory.close();
  }
});

/** Every stored revision of a message with its text and kind, oldest first, read through the writer's database. */
function revisionsOf(memory: TestMemory, native: string): Array<[unknown, unknown]> {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db
    .prepare(
      `SELECT revision, text FROM sources WHERE json_extract(extra, '$.$messageLocator.messageId') = ?
       AND kind IN ('seen', 'said') ORDER BY revision`
    )
    .all(native)
    .map((row) => [row.revision, row.text]);
}

/** A line of the command line's chat, which has no root: hers (`self`) or the owner's. */
function cliLine(id: string, content: string, self: boolean): Message {
  return {
    ...created(id),
    content,
    sourceText: content,
    author: self
      ? { id: 'self', name: null, self: true, bot: false }
      : { id: 'owner', name: 'owner', self, bot: false },
  };
}

function cliEvent(
  eventId: string,
  message: Message,
  extra: { previous?: Message; deleted?: boolean } = {}
): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'cli',
    id: eventId,
    at: NOW,
    ...(extra.previous ? { edit: true, previous: extra.previous } : {}),
    ...(extra.deleted ? { deleted: true } : {}),
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
    chat: { id: 'cli:dm:owner', kind: 'dm', rootId: null, name: 'owner', partnerId: 'owner' },
    message,
  };
}

// Bug: `recordable` and `onMessageUpdate` stop for a chat with no root, so her edit of a line on the command line is
// answered ok by the client and never stored: the line keeps its old text for every later request.
test('an edit of a line of the command line, whose chat has no root, stores the next revision and keeps the old one', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const first = cliLine('c1', 'the kettle is on 🙂', true);
    const second = { ...first, content: 'the kettle is on', sourceText: 'the kettle is on', editedAt: NOW };
    await observed.observeLine(cliEvent('cli-create-1', first), false, { placeId: 'cli:dm:owner' });
    await edits.onMessageUpdate(cliEvent('cli-update-1', second, { previous: first }));
    assert.deepEqual(revisionsOf(memory, 'c1'), [
      [1, 'the kettle is on 🙂'],
      [2, 'the kettle is on'],
    ]);
  } finally {
    await memory.close();
  }
});

// Bug: the same gap drops a deletion, so a line she took back stays a line in every later request.
test('a deletion of a line of the command line, whose chat has no root, is stored as deleted beside the line', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const first = cliLine('c2', 'the kettle is on', true);
    await observed.observeLine(cliEvent('cli-create-2', first), false, { placeId: 'cli:dm:owner' });
    await edits.onMessageDelete(
      cliEvent('cli-delete-2', { id: 'c2', at: first.at, author: first.author } as Message, { deleted: true })
    );
    const db = memory.memoryDb.database();
    const kinds = db
      ?.prepare(`SELECT kind FROM sources WHERE json_extract(extra, '$.$messageLocator.messageId') = ? ORDER BY rowid`)
      .all('c2')
      .map((row) => row.kind);
    assert.deepEqual(kinds, ['said', 'deleted']);
  } finally {
    await memory.close();
  }
});

// Guard: an edit in a chat with a root records as before, the old row kept beside the new text.
test('an edit in a chat with a served root still stores the new text as revision 2 and keeps the old row', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const first: Message = { ...created('9100'), content: 'πρώτη μορφή' };
    const second: Message = { ...first, content: 'δεύτερη μορφή', editedAt: NOW };
    await observed.observeLine(eventOf('create-9100', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9100', second, first));
    assert.deepEqual(revisionsOf(memory, '9100'), [
      [1, 'πρώτη μορφή'],
      [2, 'δεύτερη μορφή'],
    ]);
  } finally {
    await memory.close();
  }
});

/** The stored revisions of a message with their kind and moment, oldest revision first. */
function rowsOf(
  memory: TestMemory,
  native: string
): Array<{ revision: unknown; kind: unknown; authorKind: unknown; at: unknown }> {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db
    .prepare(
      `SELECT revision, kind, author_kind, occurred_at FROM sources WHERE json_extract(extra, '$.$messageLocator.messageId') = ?
       AND kind IN ('seen', 'said') ORDER BY revision`
    )
    .all(native)
    .map((row) => ({ revision: row.revision, kind: row.kind, authorKind: row.author_kind, at: row.occurred_at }));
}

const EDIT_DELAY_MS = 93 * 60_000;

/**
 * Her line of the command line stored, then its edit as the client reports a line it does not hold: the message's own
 * moment is the moment of the edit (interfaces/cli/link.ts), 93 minutes later.
 */
async function ownCliEdit(memory: TestMemory, id: string) {
  const { observed, edits } = editsOver(memory);
  const first = cliLine(id, 'the kettle is on 🙂', true);
  const second = {
    ...first,
    content: 'the kettle is on',
    sourceText: 'the kettle is on',
    at: first.at + EDIT_DELAY_MS,
  };
  await observed.observeLine(cliEvent(`cli-create-${id}`, first), false, { placeId: 'cli:dm:owner' });
  await edits.onMessageUpdate({ ...cliEvent(`cli-update-${id}`, second, { previous: first }), at: second.at });
  return first;
}

// Bug (production, 2026-11-12): the edit's row took the moment of the edit, so every reader that orders by a row's
// moment moved her line. Specified on the writer too, beside the readers that must cope with rows already stored so.
test('an edit of her own line of the command line is stored at the moment of the line it changed', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const first = await ownCliEdit(memory, 'c10');
    const at = new Date(first.at).toISOString();
    assert.deepEqual(
      rowsOf(memory, 'c10').map((row) => [row.revision, row.at]),
      [
        [1, at],
        [2, at],
      ]
    );
  } finally {
    await memory.close();
  }
});

// Bug: a `said` row for the edit would count her line twice in the counts of `said` rows, and the kind feeds source ids,
// so the edit keeps the kind the writer gives every edit and the readers tell her line by the author.
test('an edit of her own line of the command line reads back as hers while a count of said rows holds the line once', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    await ownCliEdit(memory, 'c11');
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    const rows = rowsOf(memory, 'c11');
    assert.deepEqual(
      rows.map((row) => [row.revision, row.kind, row.authorKind]),
      [
        [1, 'said', 'self'],
        [2, 'seen', 'self'],
      ]
    );
    const place = String(
      db.prepare("SELECT place_id FROM sources WHERE json_extract(extra, '$.$messageLocator.messageId') = ?").get('c11')
        ?.place_id
    );
    assert.deepEqual(
      chatLines(db, place).map((line) => [line.nativeId, line.who, line.text]),
      [['c11', 'her', 'the kettle is on']]
    );
  } finally {
    await memory.close();
  }
});

/** What a frame read gives of the place of the message `id` from or around `at`: its lines as `[id, self, text, at]`. */
function readFrom(memory: TestMemory, id: string, at: number, read: typeof linesSinceOf | typeof linesAroundOf) {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  const place = db
    .prepare("SELECT place_id FROM sources WHERE json_extract(extra, '$.$messageLocator.messageId') = ?")
    .get(id)?.place_id;
  return read(db, internalContext(), String(place), at, 3).map((line) => [line.id, line.self, line.text, line.at]);
}

// Guard (green before the fix): someone else's line edited in a chat with a root keeps being theirs, at its place.
test("an edit of someone else's line in a chat with a root reads as their line at the moment it was written", async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const first: Message = { ...created('9200'), content: 'πρώτη μορφή' };
    const second: Message = { ...first, content: 'δεύτερη μορφή', editedAt: NOW };
    await observed.observeLine(eventOf('create-9200', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9200', second, first));
    assert.deepEqual(readFrom(memory, '9200', first.at, linesSinceOf), [['9200', false, 'δεύτερη μορφή', first.at]]);
  } finally {
    await memory.close();
  }
});

// Guard for the Discord shape (green before the fix, so the frame reads already tell her edit by the author's kind):
// her own line edited in a chat with a root, the edit carrying the line's own moment.
test('an edit of her own line in a chat with a root reads as hers with the new text', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const mine = { id: 'self', name: 'Nova', self: true, bot: false };
    const first: Message = { ...created('9201'), content: 'πρώτη μορφή', author: mine };
    const second: Message = { ...first, content: 'δεύτερη μορφή', editedAt: NOW };
    await observed.observeLine(eventOf('create-9201', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9201', second, first));
    assert.deepEqual(readFrom(memory, '9201', first.at, linesSinceOf), [['9201', true, 'δεύτερη μορφή', first.at]]);
  } finally {
    await memory.close();
  }
});

// Bug (found by the specifier): a read around a line puts the older revision first when both rows share a moment, and
// keeps the first row it meets, so a platform's edit shows its old text in `<meanwhile>` and conversation.read.
test("a read around a line gives someone else's edited line its new text when the edit keeps the moment", async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const first: Message = { ...created('9202'), content: 'πρώτη μορφή' };
    const second: Message = { ...first, content: 'δεύτερη μορφή', editedAt: NOW };
    await observed.observeLine(eventOf('create-9202', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9202', second, first));
    assert.deepEqual(readFrom(memory, '9202', first.at, linesAroundOf), [['9202', false, 'δεύτερη μορφή', first.at]]);
  } finally {
    await memory.close();
  }
});
