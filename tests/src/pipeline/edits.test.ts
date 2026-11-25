// What happens to a stored line when its message changes after it arrived (src/pipeline/edits.ts#createEdits): the
// platform may send an embed in a later update of the message (a GIF posted as an address is unfurled after the message
// is created), and the line's current revision holds that embed as an item. The real observation path
// (src/pipeline/observe.ts) over a test memory database, a fake record and a fake interface; synthetic content. The
// frame reads of an edited line are in tests/src/memory/db/frame-reads.test.ts.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEdits } from '../../../src/pipeline/edits.ts';
import type { MessageEvent } from '../../../src/pipeline/edits.ts';
import { createObserve } from '../../../src/pipeline/observe.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { createIngestRecord } from '../../../src/memory/db/ingest.ts';
import type { Message } from '../../../src/protocol/events.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import type { TestMemory } from '../../fixtures/memory-db/service.ts';
import { rig } from '../../fixtures/reads-rig.ts';
import { chatLines } from '../../../src/memory/db/chat-lines.ts';
import { createMediaPrefill } from '../../../src/pipeline/media-prefill.ts';
import { createStore } from '../../../src/memory/store.ts';
import type { GifBytes } from '../../../src/media/gif-files.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start as startCli } from '../../../interfaces/cli/link.ts';
import type { RunningCli } from '../../../interfaces/cli/link.ts';
import { startCore } from '../../../src/core.ts';
import { addClient } from '../../../src/setup/clients.ts';
import { start as startFake, start } from '../../../scripts/lib/fake-interface.ts';
import { createKeyStore } from '../../../src/keys/store.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { connectSocket } from '../../../src/protocol/wire.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import type { LogEntry } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import type { Completion } from '../../fixtures/tool-answers.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { window } from '../../../src/memory/db/recall.ts';
import { internalContext } from '../../../src/memory/db/scope.ts';
import type { MessageEvent as AdapterMessageEvent } from '../../../src/protocol/adapter.ts';
import { SELF, channelInfo, lineEvent, settle, until, withFakeCore } from '../../fixtures/core-over-fake.ts';
import type { Fake } from '../../fixtures/core-over-fake.ts';
import { addClient as addUnitClient, CLI_CLIENT, FAKE_CLIENT, folders, query } from '../../fixtures/core-units.ts';
import {
  baseConfig,
  fakeChannel,
  fakeDescriber,
  fakeGuild,
  fakeMemory,
  fakeMessage,
  fakeSpontaneous,
  fakeTurns,
  makeHandler,
} from '../../fixtures/events-rig.ts';
import { normalizeMessage } from '../../../interfaces/discord/index.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { memoryAt } from '../../fixtures/store-kit.ts';
import { topPlaceSpelled } from '../../../src/memory/db/ids.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

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
function editsOver(
  memory: TestMemory,
  warmMediaCache: (placeId: string, message: object) => Promise<void> | null = () => null
) {
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
    warmMediaCache,
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

// An edit that adds a GIF does what a new message does, through the
// media prefill: the file is downloaded once from the embed's animation address, never from the page link.
test('an update that brings a GIF embed later downloads its file from the animation address', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
    const asked: Array<string> = [];
    const fetchBytes = (url: string): Promise<GifBytes> => {
      asked.push(url);
      return Promise.resolve({ bytes: new Uint8Array([71, 73, 70, 56, 57, 97]), contentType: 'image/gif' });
    };
    const prefill = createMediaPrefill({
      hot: memory.hot,
      describer: null,
      lookup: null,
      now: () => NOW,
      store,
      dataDir: memory.dataDir,
      fetchBytes,
    } as unknown as Parameters<typeof createMediaPrefill>[0]);
    const observed = createObserve({
      hot: memory.hot,
      selfIdOf: () => 'self',
      timers: { set: () => null, clear() {} },
      memoryDb: memory.memoryDb,
    });
    const edits = createEdits({
      hot: memory.hot,
      store: store as unknown as Parameters<typeof createEdits>[0]['store'],
      reads: rig().reads,
      isServedRoot: (id) => id === ROOT,
      selfIdOf: () => 'self',
      record: { append: (_placeId, lines) => Promise.resolve({ written: lines.length, duplicates: 0 }) },
      now: () => NOW,
      warmMediaCache: prefill.warmMediaCache,
      observeLine: observed.observeLine,
      deleteLine: observed.deleteLine,
    });
    await observed.observeLine(eventOf('create-1', created('9001')), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-1', unfurled('9001'), created('9001')));
    for (let i = 0; i < 400 && asked.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(asked, ['https://media.example.invalid/9001.mp4']);
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

// A bot is written about like a person, so a bot's edit is a revision like anyone's.
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

/** A line of the command line's chat, which has no root: the persona's (`self`) or the owner's. */
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

// Bug: `recordable` and `onMessageUpdate` stop for a chat with no root, so the persona's edit of a line on the command line is
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

// Bug: the same gap drops a deletion, so a line the persona took back stays a line in every later request.
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
 * The persona's line of the command line stored, then its edit as the client reports a line it does not hold: the message's own
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

// Bug: the edit's row took the moment of the edit, so every reader that orders by a row's moment moved the persona's
// line. Specified on the writer too, beside the readers that must cope with rows already stored so.
test("an edit of the persona's own line of the command line is stored at the moment of the line it changed", async () => {
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

// Bug: a `said` row for the edit would count the persona's line twice in the counts of `said` rows, and the kind feeds
// source ids, so the edit keeps the kind the writer gives every edit and the readers tell that line by the author.
test("an edit of the persona's own line of the command line reads back as the persona's while a count of said rows holds the line once", async () => {
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

/** A picture attachment of a message. */
function attachment(id: string, name: string) {
  return { id, kind: 'image', name, url: `https://media.example.invalid/${id}.png`, contentType: 'image/png' };
}

/**
 * A media prefill that describes every attachment and link of the message it is given, as the describer does: one
 * cache entry per item written through the one writer. `settled` waits for the writes it started.
 */
function describingPrefill(memory: TestMemory) {
  const started: Array<Promise<unknown>> = [];
  const warm = (placeId: string, message: object): Promise<void> => {
    const parts = message as { attachments?: Array<{ id: string }>; links?: Array<{ id: string }> };
    for (const item of [...(parts.attachments ?? []), ...(parts.links ?? [])]) {
      started.push(
        memory.memoryDb.writeMediaEntry({
          op: 'put',
          placeId,
          key: item.id,
          entry: { text: 'a described picture', ts: NOW },
        })
      );
    }
    return Promise.resolve();
  };
  return { warm, settled: () => Promise.all(started) };
}

/** The live media rows that hold a description and that nothing links. */
function describedWithNoLink(memory: TestMemory): Array<unknown> {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db
    .prepare(
      `SELECT native_ref FROM media m WHERE m.retired_at IS NULL AND m.description IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = m.id)`
    )
    .all()
    .map((row) => row.native_ref);
}

/** The live media rows of the references `refs` that nothing links. */
function liveWithNoLink(memory: TestMemory, refs: Array<string>): Array<unknown> {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  const query = db.prepare(
    `SELECT native_ref FROM media m WHERE m.native_ref = ? AND m.retired_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = m.id)`
  );
  return refs.flatMap((ref) => query.all(ref).map((row) => row.native_ref));
}

// Guard (green before the fix): an attachment a later update adds to a message whose words stay is linked to the line,
// and its description lands on that linked row. The fix of a replaced attachment must keep it so.
test('an update that adds an attachment and keeps the text links the described attachment to the line', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    const prefill = describingPrefill(memory);
    const { observed, edits } = editsOver(memory, prefill.warm);
    const first: Message = { ...created('9302'), content: 'ένας σύνδεσμος' };
    const second: Message = { ...first, attachments: [attachment('a-9302', 'preview.png')] };
    await observed.observeLine(eventOf('create-9302', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9302', second, first));
    await prefill.settled();
    assert.deepEqual(stored(memory, '9302'), [{ revision: 1, refs: ['a-9302'] }]);
    assert.deepEqual(describedWithNoLink(memory), []);
  } finally {
    await memory.close();
  }
});

// Bug: an update that keeps the text and replaces the attachment makes no new revision, so the line's one
// revision shows the new attachment alone. The row of the removed one keeps no row of its own once nothing links it,
// by the engine's rule that a revision keeps what it held and a row no line shows goes.
test('an update that replaces an attachment and keeps the text links the new one and leaves no unlinked row of the old', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    const prefill = describingPrefill(memory);
    const { observed, edits } = editsOver(memory, prefill.warm);
    const first: Message = {
      ...created('9303'),
      content: 'η φωτογραφία',
      attachments: [attachment('a-old', 'one.png')],
    };
    const second: Message = { ...first, attachments: [attachment('a-new', 'two.png')] };
    await observed.observeLine(eventOf('create-9303', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9303', second, first));
    await prefill.settled();
    assert.deepEqual(stored(memory, '9303'), [{ revision: 1, refs: ['a-new'] }]);
    assert.deepEqual(liveWithNoLink(memory, ['a-old', 'a-new']), []);
  } finally {
    await memory.close();
  }
});

// Guard (green before the fix): an edit that changes the words and replaces the attachment gives the newest revision
// the new attachment, and the older revision keeps the one it held, as every older revision keeps its own media.
test('an edit that changes the text and replaces an attachment links the new one to the newest revision only', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    const prefill = describingPrefill(memory);
    const { observed, edits } = editsOver(memory, prefill.warm);
    const first: Message = { ...created('9304'), content: 'πρώτη', attachments: [attachment('b-old', 'one.png')] };
    const second: Message = {
      ...first,
      content: 'δεύτερη',
      editedAt: NOW,
      attachments: [attachment('b-new', 'two.png')],
    };
    await observed.observeLine(eventOf('create-9304', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9304', second, first));
    await prefill.settled();
    assert.deepEqual(stored(memory, '9304'), [
      { revision: 1, refs: ['b-old'] },
      { revision: 2, refs: ['b-new'] },
    ]);
    assert.deepEqual(describedWithNoLink(memory), []);
  } finally {
    await memory.close();
  }
});

/** The live rows of `ref` that hold a description a reader could show. */
function liveDescribed(memory: TestMemory, ref: string): Array<unknown> {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db
    .prepare('SELECT id FROM media WHERE native_ref = ? AND retired_at IS NULL AND description IS NOT NULL')
    .all(ref)
    .map((row) => row.id);
}

/** The describer's late answer for `ref`, written through the one writer as writeMediaEntry does. */
function lateDescription(memory: TestMemory, ref: string): Promise<unknown> {
  return memory.memoryDb.writeMediaEntry({
    op: 'put',
    placeId: ROOT,
    key: ref,
    entry: { text: 'a late described picture', ts: NOW },
  });
}

// Bug: an edit that keeps the text replaces attachment A by B while A's
// description is still out; the description then lands on A's retired row and the write revives it, live with no link.
test('a description that lands after an update replaced its attachment leaves no live row of it and nothing to show', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    const { observed, edits } = editsOver(memory);
    const first: Message = { ...created('9305'), content: 'η φωτογραφία', attachments: [attachment('c-old', 'a.png')] };
    const second: Message = { ...first, attachments: [attachment('c-new', 'b.png')] };
    await observed.observeLine(eventOf('create-9305', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9305', second, first));
    await lateDescription(memory, 'c-old');
    assert.deepEqual(liveWithNoLink(memory, ['c-old']), []);
    assert.deepEqual(liveDescribed(memory, 'c-old'), []);
  } finally {
    await memory.close();
  }
});

/** The link preview the platform fills in a later update of the message: a page's title and text and its picture. */
function preview(id: string) {
  return {
    id: `${id}#e0`,
    kind: 'link',
    site: 'Synthetic News',
    title: 'Ο φάρος ανάβει ξανά',
    text: 'Ένα μικρό άρθρο για έναν φάρο.',
    url: `https://news.example.invalid/${id}`,
    thumbnailUrl: `https://media.example.invalid/${id}-thumb.png`,
  };
}

// Guard: an update that only adds a link preview reaches the core through
// the event door with its receipt, as the live interface sends it, and then the edit handler. The preview ends linked to
// the line, and the description the prefill writes lands on that linked row, with no unlinked described row beside it.
test('a late link preview that arrives through the door is linked to the line and its description is on the linked row', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    const prefill = describingPrefill(memory);
    const { observed, edits } = editsOver(memory, prefill.warm);
    const ingest = createIngestRecord({ memoryDb: memory.memoryDb, hot: memory.hot, now: () => NOW });
    const door = createEventDoor({
      log: { info() {}, warn() {} },
      ingest,
      handlers: {
        'message.received': async (event: MessageEvent, context) => {
          const acceptedEvent = context.receipt
            ? {
                eventId: context.receipt.eventId,
                locator: { iface: event.iface, chatId: event.chat.id, messageId: event.message.id },
                receipt: context.receipt,
              }
            : undefined;
          if (event.edit) await edits.onMessageUpdate(event, { acceptedEvent });
          else await observed.observeLine(event, false, { placeId: ROOT }, acceptedEvent);
        },
      },
    });
    const first: Message = { ...created('9401'), content: 'https://news.example.invalid/9401' };
    const second: Message = { ...first, links: [preview('9401')] };
    assert.equal((await door.submit(eventOf('create-9401', first), { principal: 'adapter', seq: 1 })).status, 'ok');
    const update = await door.submit(eventOf('update-9401', second, first), { principal: 'adapter', seq: 2 });
    assert.equal(update.status, 'ok');
    await prefill.settled();
    assert.deepEqual(stored(memory, '9401'), [{ revision: 1, refs: ['9401#e0'] }]);
    assert.deepEqual(describedWithNoLink(memory), []);
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    const linked = db
      .prepare(
        `SELECT m.description AS description FROM media_links l JOIN media m ON m.id = l.media_id
         WHERE m.native_ref = ? AND m.retired_at IS NULL`
      )
      .all('9401#e0');
    assert.equal(linked.length, 1);
    assert.equal(typeof linked[0]?.description === 'string' && linked[0].description !== '', true);
  } finally {
    await memory.close();
  }
});

// The persona's `message.edit` and `message.delete` of the persona's own line on the command line, end to end: `startCore` over temporary
// folders, the real `cli` interface package on the core's socket as a principal of kind `cli`, a scripted model, and
// the memory database read through a second, read-only connection once the writer has flushed. The model's tool calls
// are the only thing scripted. Synthetic text.

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const LABELS = JSON.parse(readFileSync(join(REPO, 'config', 'labels.json'), 'utf8')) as {
  model: { transcript: { edited: string } };
};
const { transcript: WORDS } = LABELS.model;
const EDITED = WORDS.edited;
const FIRST = 'the kettle is on 🙂';
const SECOND = 'the kettle is on';

type Row = Record<string, unknown>;
type Rig = {
  cli: RunningCli;
  printed: Array<string>;
  requests: Array<string>;
  rows: () => Array<Row>;
  /** Stops the client and connects a fresh one, which holds none of the lines said before. */
  restart: () => Promise<void>;
};

/** One answer of the scripted model, or a function that makes it when asked (it may read what was stored by then). */
type Script = Completion | (() => Completion);

/** The scripted model: `script` answers the persona's requests in order; the address check says yes. */
function scripted(script: ReadonlyArray<Script>, requests: Array<string>) {
  return {
    complete: (messages: unknown, given?: unknown): Promise<Completion> => {
      const purpose = (given as { purpose?: unknown } | undefined)?.purpose;
      if (purpose === 'address') return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      if (purpose === 'lookup' || purpose === 'elsewhere-pick')
        return Promise.resolve({ text: 'none', usage: {}, estimated: 1 });
      requests.push(JSON.stringify(messages));
      const answer = script[requests.length - 1];
      assert.ok(answer, 'the model must not make an unscripted request');
      return Promise.resolve(typeof answer === 'function' ? answer() : answer);
    },
  };
}

async function withCli(script: ReadonlyArray<Script>, body: (rig: Rig) => Promise<void>): Promise<Array<LogEntry>> {
  const root = mkdtempSync(join(tmpdir(), 'ce-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: {
        timezone: 'UTC',
        owners: [],
        access: {
          'message.edit': { everyone: false, roles: [], users: ['self-id'] },
          'message.delete': { everyone: false, roles: [], users: ['self-id'] },
        },
      },
      models: { routes: chainsOf({ video: false }) },
      interfaces: { mode: 'units', drainMs: 500 },
      pace: { settleMs: 0, settleMaxMs: 0 },
      typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
      tools: { loop: { maxSteps: 5, timeBudgetMs: 20000, maxCallsPerStep: 2 } },
      gifs: { backfillMessages: 0 },
    })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  addClient(dataDir, 'cli', { kind: 'cli', iface: null, permissions: [] });
  const requests: Array<string> = [];
  try {
    const { logs } = await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [{ name: 'fake', start: (host) => startFake(host, { selfId: 'self-id' }) }],
        llm: scripted(script, requests),
        embedder: { embed: () => Promise.resolve([]) },
      });
      const printed: Array<string> = [];
      const open = (): Promise<RunningCli> =>
        startCli({
          connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
          token: readFileSync(join(dataDir, 'clients', 'cli.token'), 'utf8').trim(),
          print: (text) => void printed.push(text),
        });
      const rig: Rig = {
        cli: await open(),
        printed,
        requests,
        restart: async () => {
          await rig.cli.stop();
          rig.cli = await open();
        },
        rows: () => {
          const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
          try {
            // A line's message id is the one its message family holds; `native_id` is the writer's own key.
            const sql = `SELECT s.kind, s.revision, s.text, f.message_id FROM sources s
                JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
                AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
                WHERE s.kind IN ('seen', 'said', 'deleted') ORDER BY s.rowid`;
            return (handle.db as { prepare(sql: string): { all(): Array<Row> } })
              .prepare(sql)
              .all()
              .map((row) => ({ ...row }));
          } finally {
            handle.close();
          }
        },
      };
      try {
        await body(rig);
      } finally {
        await rig.cli.stop();
        await core.stop();
      }
    });
    return logs;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Polls `read` until `ready` accepts it or three seconds pass (the writer flushes asynchronously). */
async function settled<T>(read: () => T, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = read();
    if (ready(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The stored rows of the line the persona said first, oldest first: `[kind, revision, text]`. */
function historyOf(rows: Array<Row>): Array<[unknown, unknown, unknown]> {
  const said = rows.find((row) => row.kind === 'said');
  return rows.filter((row) => row.message_id === said?.message_id).map((row) => [row.kind, row.revision, row.text]);
}

/** The numbered lines of the `<chat>` block of a request: number to the text after the time. */
function chatOf(request: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const [, number, text] of request.matchAll(/#(\d+) \[\d\d:\d\d\] (.*?)(?=\\n)/g))
    lines.set(Number(number), text ?? '');
  return lines;
}

/**
 * The persona's line (`#2`) said in one session, a fresh client, two more lines (`one`, the persona's `second` reply, which holds `reply`),
 * `change that` with the persona's edit of `#2`, then `and now?`: the request of the last turn.
 */
async function editedLaterRequest(reply: string): Promise<string> {
  let after = '';
  await withCli(
    [
      toolAnswer(`<msg>${FIRST}</msg>`),
      toolAnswer(`<msg>${reply}</msg>`),
      toolAnswer('', [call('message.edit', { message: '#2', text: SECOND })]),
      toolAnswer('<skip/>'),
      toolAnswer('<msg>fine</msg>'),
    ],
    async (rig) => {
      await rig.cli.turn('hello there');
      await settled(rig.rows, (found) => found.some((row) => row.kind === 'said'));
      await rig.restart();
      await rig.cli.turn('one');
      await rig.cli.turn('change that');
      await settled(rig.rows, (found) => historyOf(found).length >= 2);
      await rig.cli.turn('and now?');
      after = rig.requests[4] ?? '';
    }
  );
  return after;
}

// The persona's edit of a line from an earlier session of the client arrived with the moment of the edit,
// so the line came back at the end of `<chat>` as the owner's, under a new number, and every line after its old place
// moved up by one.
test('an edit by the persona of a line said before the client restarted leaves it at its number, still the line of the persona, with the new text and its mark', async () => {
  const chat = chatOf(await editedLaterRequest('second line'));
  assert.deepEqual([...chat.keys()], [1, 2, 3, 4, 5, 6], 'no line is added and none skips a number');
  assert.match(chat.get(2) ?? '', new RegExp(`^Fake \\(you\\).*: ${SECOND} ${EDITED.replace(/[()]/g, '\\$&')}$`));
  assert.ok(chat.get(3)?.endsWith(': one'), String(chat.get(3)));
  assert.ok(chat.get(4)?.includes('second line'), String(chat.get(4)));
  assert.ok(chat.get(5)?.endsWith(': change that'), String(chat.get(5)));
  assert.ok(chat.get(6)?.endsWith(': and now?'), String(chat.get(6)));
});

// The number the persona wrote in a reply named the line by its identity, and the line had moved.
test('a number the persona wrote before the edit names the same line after it', async () => {
  const chat = chatOf(await editedLaterRequest('second line about #2'));
  const reply = [...chat.values()].find((text) => text.includes('second line about'));
  assert.equal(/about #(\d+)/.exec(reply ?? '')?.[1], '2', 'the reply of the persona still reads #2');
  assert.ok(chat.get(2)?.includes(SECOND), `#2 is the edited line, not ${chat.get(2)}`);
});

// Real core producers preserve accepted receipts and native message identity through storage, recall and adapter calls.

const CORE_MESSAGE_PRODUCERS_NOW = Date.parse('2026-10-24T12:00:00Z');
const NATIVE = 'same-native-message';
type Running = Awaited<ReturnType<typeof start>>;

function event(eventId: string, room: string, text: string, edit = false): AdapterMessageEvent {
  const input = lineEvent({ id: NATIVE, chatId: room, text, at: CORE_MESSAGE_PRODUCERS_NOW - 60_000 });
  return { ...input, id: eventId, at: CORE_MESSAGE_PRODUCERS_NOW, edit };
}

async function boot(complete?: (messages: unknown, options?: unknown) => Promise<Completion>) {
  const dirs = folders({
    bot: { timezone: 'UTC', placeId: 'g1', owners: ['u1'] },
    models: { routes: chainsOf({ video: false }) },
    gifs: { backfillMessages: 0 },
    features: {
      spontaneous: false,
      eavesdrop: false,
      followUp: false,
      participation: false,
      offlineCatchUp: false,
      diary: false,
      mediaDescriptions: false,
      channelRoute: false,
      memoryPrefetch: false,
      channelPull: false,
      elsewhere: false,
      speech: false,
      pauseNotice: false,
    },
    tools: { loop: { maxSteps: 4, timeBudgetMs: 15_000, maxCallsPerStep: 2 } },
  });
  addUnitClient(dirs.privateDir, CLI_CLIENT);
  addUnitClient(dirs.privateDir, FAKE_CLIENT);
  let running: Running | null = null;
  const core = await startCore({
    paths: dirs.paths,
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    now: () => CORE_MESSAGE_PRODUCERS_NOW,
    llm: { complete: complete ?? (() => Promise.reject(new Error('this producer scenario asks no model'))) },
    embedder: { embed: () => Promise.resolve([]) },
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(
            { ...host, token: readFileSync(`${dirs.privateDir}/clients/fake.token`, 'utf8').trim() },
            { self: SELF, root: { id: 'g1', name: 'Synthetic root' } }
          );
          return running;
        },
      },
    ],
  });
  if (running === null) throw new Error('the core did not start the fake interface');
  const live: Running = running;
  for (const room of ['room-a', 'room-b']) live.adapter.seedChat(channelInfo(room));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await core.stop();
  };
  return {
    dirs,
    live,
    stop,
    async send(input: AdapterMessageEvent) {
      live.adapter.seedEvent(input);
      return live.emit(input);
    },
    async close() {
      try {
        await stop();
      } finally {
        rmSync(dirs.root, { recursive: true, force: true });
      }
    },
  };
}

test('real received, edit and authorless delete events retain their own accepted source in colliding chats', async () => {
  await withCapturedLogs(async () => {
    const rig = await boot();
    try {
      assert.deepEqual(
        await Promise.all([
          rig.send(event('create-a', 'room-a', 'Alpha original')),
          rig.send(event('create-b', 'room-b', 'Beta original')),
        ]),
        ['ok', 'ok']
      );
      assert.equal(await rig.send(event('edit-a', 'room-a', 'Alpha edited', true)), 'ok');
      const deletion: AdapterMessageEvent = {
        ...event('delete-a', 'room-a', ''),
        deleted: true,
        message: { id: NATIVE },
      };
      assert.equal(await rig.live.emit(deletion), 'ok');
      const sources = query(rig.dirs, 'SELECT * FROM sources');
      const receipts = query(rig.dirs, 'SELECT * FROM ingest ORDER BY seq');
      assert.deepEqual(
        receipts.map((receipt) => {
          const source = sources.find((row) => row.id === receipt.source_id);
          return [receipt.event_id, receipt.conversation, source?.kind, source?.text ?? null];
        }),
        [
          ['create-a', 'room-a', 'seen', 'Alpha original'],
          ['create-b', 'room-b', 'seen', 'Beta original'],
          ['edit-a', 'room-a', 'seen', 'Alpha edited'],
          ['delete-a', 'room-a', 'deleted', null],
        ]
      );
      assert.deepEqual(
        receipts.map((receipt) => receipt.principal),
        ['fake', 'fake', 'fake', 'fake']
      );
      assert.deepEqual(
        query(rig.dirs, 'SELECT conversation_id, message_id FROM message_families ORDER BY conversation_id'),
        [
          { conversation_id: 'room-a', message_id: NATIVE },
          { conversation_id: 'room-b', message_id: NATIVE },
        ]
      );
      const handle = openMemoryDb(`${rig.dirs.dataDir}/memory.db`, { readOnly: true });
      try {
        for (const room of ['room-a', 'room-b']) {
          const recalled = window(dbOf(handle), {
            ctx: internalContext(),
            resolvedAnchor: { kind: 'native', locator: { iface: 'fake', chatId: room, messageId: NATIVE } },
            messages: 1,
          });
          assert.equal(recalled.unknown, room === 'room-a');
        }
      } finally {
        handle.close();
      }
    } finally {
      await rig.close();
    }
  });
});

test('the real edit handler records each observed revision once within its qualified message family', async () => {
  await withCapturedLogs(async () => {
    const rig = await boot();
    try {
      for (const input of [
        event('original-a', 'room-a', 'Alpha original'),
        event('original-b', 'room-b', 'Beta original'),
        event('first-edit', 'room-a', 'Alpha first edit', true),
        event('second-edit', 'room-a', 'Alpha second edit', true),
      ])
        assert.equal(await rig.send(input), 'ok');
      await rig.stop();
      assert.deepEqual(
        query(
          rig.dirs,
          `SELECT f.conversation_id, s.revision, s.text FROM message_families f
        JOIN sources s ON s.iface = f.iface AND s.native_id = f.native_key
        WHERE s.kind = 'seen' ORDER BY f.conversation_id, s.revision`
        ),
        [
          { conversation_id: 'room-a', revision: 1, text: 'Alpha original' },
          { conversation_id: 'room-a', revision: 2, text: 'Alpha first edit' },
          { conversation_id: 'room-a', revision: 3, text: 'Alpha second edit' },
          { conversation_id: 'room-b', revision: 1, text: 'Beta original' },
        ]
      );
      assert.equal(query(rig.dirs, "SELECT COUNT(*) AS n FROM sources WHERE kind = 'seen'")[0]?.n, 4);
    } finally {
      await rig.close();
    }
  });
});

test('an unavailable partial edit preserves archived text and author without inventing an empty revision', async () => {
  await withCapturedLogs(async () => {
    const rig = await boot();
    try {
      assert.equal(await rig.send(event('original-before-partial', 'room-a', 'Preserved original text')), 'ok');
      const select = "SELECT id, revision, text, author_account FROM sources WHERE kind = 'seen' ORDER BY id";
      const before = query(rig.dirs, select);
      assert.ok(before.some((row) => row.text === 'Preserved original text'));
      const author = query(
        rig.dirs,
        `SELECT a.native_id FROM sources s JOIN accounts a ON a.id = s.author_account
        WHERE s.text = ?`,
        'Preserved original text'
      );
      assert.ok(author.some((row) => row.native_id === 'u1'));
      const { adapter } = rig.live;
      adapter.failNext('fetchMessages', {
        status: 'failed',
        error: { code: 'unavailable', retryable: false, retryAfterMs: null },
      });
      const { adapter: adapterValue } = rig.live;
      const calls = adapterValue.calls.length;
      const partial: AdapterMessageEvent = {
        ...event('unavailable-partial-edit', 'room-a', '', true),
        partial: true,
        message: { id: NATIVE },
      };
      assert.equal(await rig.live.emit(partial), 'ok');
      await rig.stop();
      assert.deepEqual(query(rig.dirs, select), before);
      const { adapter: adapterValue3 } = rig.live;
      for (const call of adapterValue3.calls.slice(calls).filter((entry) => entry.op === 'fetchMessages')) {
        assert.deepEqual(call.args, [{ iface: 'fake', chatId: 'room-a' }, [NATIVE]]);
      }
    } finally {
      await rig.close();
    }
  });
});

test('an edit and a deletion reach the record and log no refused append', async () => {
  // Bug: the record's descriptor named the message id, the line carries its own id, and each was refused BAD_NATIVE.
  const { logs } = await withCapturedLogs(async () => {
    const rig = await boot();
    try {
      assert.equal(await rig.send(event('original', 'room-a', 'Alpha original')), 'ok');
      assert.equal(await rig.send(event('edit', 'room-a', 'Alpha edited', true)), 'ok');
      const deletion: AdapterMessageEvent = { ...event('gone', 'room-a', ''), deleted: true, message: { id: NATIVE } };
      assert.equal(await rig.send(deletion), 'ok');
      await rig.stop();
    } finally {
      await rig.close();
    }
  });
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'events: record failed'),
    []
  );
});

// ---------------------------------------------------------------------------
// onMessageUpdate: Discord attaches some embeds (a Tenor link's `gifv` one)
// after messageCreate, in a messageUpdate. What the message as it was did not
// carry is counted into the GIF library and prefilled.

const TENOR_LINK = 'https://tenor.com/view/dancing-cat-123';
const TENOR_GIFV = {
  type: 'gifv',
  url: TENOR_LINK,
  provider: { name: 'Tenor' },
  thumbnail: { url: 'https://media.tenor.com/abc/cat.png' },
  video: { url: 'https://media.tenor.com/abc/cat.mp4' },
};

/** A real store over a temporary data dir (never the deployment's data/). */
function tmpStore() {
  return createStore(memoryAt(tempDir('nep-events-update-')));
}

/** The message as messageCreate saw it (a bare link) and as messageUpdate carries it (with the embed). */
function tenorPost(overrides: Record<string, Untyped> = {}) {
  const guild = overrides.guild ?? fakeGuild();
  const channel = overrides.channel ?? fakeChannel('c1', guild);
  const base = {
    id: 'm1',
    guild,
    channel,
    placeId: channel.id,
    cleanContent: TENOR_LINK,
    content: TENOR_LINK,
    embeds: [],
    ...overrides,
  };
  return { created: fakeMessage(base), updated: fakeMessage({ ...base, embeds: [TENOR_GIFV] }) };
}

function updateScene({ config, describer }: { config?: Untyped; describer?: Untyped } = {}) {
  const store = tmpStore();
  const memory = fakeMemory();
  const turns = fakeTurns();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ config, store, memory, turns, spontaneous, describer });
  return { store, memory, turns, spontaneous, handler };
}

function gifEntries(store: Record<string, Untyped>) {
  return Object.values(store.getGifs().entries);
}
describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test('onMessageUpdate: a late gifv embed is counted into the library and prefilled', async () => {
    const describer = fakeDescriber();
    const scene = updateScene({ config: baseConfig({ features: { mediaDescriptions: true } }), describer });
    const { created, updated } = tenorPost();
    assert.deepEqual(normalizeMessage(created, 'self1').links, [], 'the create event carried a bare link');

    const { logs } = await withCapturedLogs(() => scene.handler.onMessageUpdate(created, updated));

    const entries: Record<string, Untyped> = gifEntries(scene.store);
    assert.equal(entries.length, 1, 'the library gained the Tenor GIF');
    assert.equal(entries[0].url, TENOR_LINK);
    assert.equal(entries[0].count, 1);
    assert.equal(entries[0].itemId, 'm1#e0');
    const folded = logs.filter((entry) => entry.msg === 'events: embeds folded');
    assert.equal(folded.length, 1);
    // Changed with the contract: the log counts the late media items of the message (an event carries no embed count).
    assert.equal(folded[0].items, 1);
    assert.equal(folded[0].messageId, 'm1');
    assert.equal(folded[0].placeId, 'c1');
    assert.equal(describer.calls.length, 1, 'the late GIF is prefilled like one on arrival');
    const firstCall = describer.calls[0];
    assert.deepEqual(
      firstCall.items.map((item: Record<string, Untyped>) => item.itemId),
      ['m1#e0']
    );
    // Never treated as a new message.
    const { observeCalls } = scene.memory;
    assert.equal(observeCalls.length, 0);
    const { onMessageCalls } = scene.spontaneous;
    assert.equal(onMessageCalls.length, 0);
    const { notePostCalls } = scene.turns;
    assert.equal(notePostCalls.length, 0);

    // A second update with the same embed (an edit) counts nothing again.
    await withCapturedLogs(() => scene.handler.onMessageUpdate(updated, updated));
    assert.equal(wrongly<{ count: number }>(gifEntries(scene.store)[0]).count, 1);
    assert.equal(describer.calls.length, 1);
  });

  test("onMessageUpdate: ignores the persona's own messages, other guilds and updates without embeds", async () => {
    const self = { id: 'self1', bot: true, globalName: 'Bot', username: 'bot' };
    const other = fakeGuild('g2');
    const cases = [
      tenorPost({ author: self }),
      // Another bot's late embed counts like a member's, so it is no case here.
      tenorPost({ guild: other, channel: fakeChannel('c1', other) }),
    ];
    for (const { created, updated } of cases) {
      const scene = updateScene();
      const { logs } = await withCapturedLogs(() => scene.handler.onMessageUpdate(created, updated));
      assert.equal(gifEntries(scene.store).length, 0);
      assert.equal(
        logs.some((entry) => entry.msg.startsWith('events: embeds')),
        false
      );
    }

    const scene = updateScene();
    const { created } = tenorPost();
    const edited = fakeMessage({ ...created, cleanContent: 'edited text', content: 'edited text', embeds: [] });
    await scene.handler.onMessageUpdate(created, edited);
    assert.equal(gifEntries(scene.store).length, 0, 'an edit without embeds counts nothing');
  });

  test('onMessageUpdate: without the message as it was, a late embed is an accepted miss', async () => {
    const scene = updateScene();
    const { updated } = tenorPost();
    const { logs } = await withCapturedLogs(() => scene.handler.onMessageUpdate(null, updated));
    assert.equal(gifEntries(scene.store).length, 0, 'an accepted miss: nothing recorded');
    const late = logs.filter((entry) => entry.msg === 'events: embeds late');
    assert.equal(late.length, 1);
    assert.equal(late[0].items, 1);
  });

  // ---------------------------------------------------------------------------
  // The record (src/memory/record.ts): a deleted message and an edit.

  test('events: a deleted message writes a deleted line and an edit writes revision 2', async () => {
    const appended: Array<Untyped> = [];
    const record = {
      append: async (placeId: string, lines: Array<Record<string, Untyped>>, opts: Record<string, Untyped>) => {
        appended.push({ placeId, lines, opts });
        return { written: lines.length, duplicates: 0 };
      },
    };
    const config = baseConfig();
    const store = tmpStore();
    const at = Date.UTC(2026, 9, 13, 10, 0, 0);
    const handler = makeHandler({ config, store, record, now: () => at });
    const created = fakeMessage({
      id: 'm1',
      content: 'πρώτα',
      cleanContent: 'πρώτα',
      createdTimestamp: at - 60_000,
      mentions: { users: new Map([['u2', {}]]) },
    });

    await handler.onMessageDelete(created);
    assert.equal(appended.length, 1);
    const [deleted] = appended[0].lines;
    // The store over its memory database spells the server's place for the interface that saw it.
    assert.equal(appended[0].placeId, topPlaceSpelled('fake', 'g1'));
    assert.equal(deleted.kind, 'deleted');
    assert.equal(deleted.messageId, 'm1');
    assert.equal(deleted.occurredAt, new Date(at - 60_000).toISOString(), 'dated by the message itself');
    assert.equal(deleted.recordedAt, new Date(at).toISOString(), 'the deletion time is kept as the write time');
    assert.deepEqual(deleted.scope, { channel: 'c1' });
    assert.deepEqual(deleted.participants, ['u1']);
    assert.equal('text' in deleted, false);

    // An update that only attaches embeds is no edit.
    const embedded = fakeMessage({ ...created, embeds: [TENOR_GIFV] });
    await withCapturedLogs(() => handler.onMessageUpdate(created, embedded));
    assert.equal(appended.length, 1);

    const edited = fakeMessage({ ...created, content: 'μετά', cleanContent: 'μετά' });
    await withCapturedLogs(() => handler.onMessageUpdate(created, edited));
    assert.equal(appended.length, 2);
    const [edit] = appended[1].lines;
    assert.equal(edit.kind, 'seen');
    assert.equal(edit.messageId, 'm1');
    assert.equal(edit.revision, 2);
    assert.equal(edit.text, 'μετά');
    assert.equal(edit.by, 'u1');
    assert.deepEqual(edit.mentions, ['u2']);
    assert.equal(edit.occurredAt, new Date(at - 60_000).toISOString(), 'dated by the message, like its first line');

    const again = fakeMessage({ ...created, content: 'τρίτο', cleanContent: 'τρίτο' });
    await withCapturedLogs(() => handler.onMessageUpdate(edited, again));
    const { lines: linesValue } = appended[2];
    assert.equal(linesValue[0].revision, 3);

    // Another bot's deletion is recorded like anyone's; another guild's is not.
    const otherBot = fakeMessage({ ...created, author: { id: 'b2', bot: true, globalName: 'B', username: 'b' } });
    await handler.onMessageDelete(otherBot);
    assert.equal(appended.length, 4);
    const elsewhere = fakeMessage({ ...created, guild: fakeGuild('g2'), channel: fakeChannel('c9', fakeGuild('g2')) });
    await handler.onMessageDelete(elsewhere);
    assert.equal(appended.length, 4);
  });
});

// The message pipeline on events alone: no platform message object, no raw handle. The core over the fake interface
// (tests/fixtures/core-over-fake.ts) gets whole `message.received` events. A system message is ignored, a late embed is
// folded into the gif library from the edit event's `previous`, a partial edit is completed by asking the adapter for
// the message, and a deletion is dated by `message.at` and carries `message.author.id`.

const PIPELINE_NO_RAW_NOW = Date.now();
const TENOR = 'https://tenor.com/view/dancing-cat-123';
const GIF = { id: 'm5#e0', kind: 'gif', url: TENOR, site: 'tenor', title: 'dancing cat' };

function seed(fake: Fake): void {
  fake.seedChat(channelInfo('c1', { name: 'general' }));
}

/** The edit event of message `m5`: a bare link as written, then the same message with the gif Discord attached. */
function editWith(links: Array<object>, previous: AdapterMessageEvent['message'] | null): AdapterMessageEvent {
  const base = lineEvent({ id: 'm5', text: TENOR, at: PIPELINE_NO_RAW_NOW - 5000 });
  return {
    ...base,
    id: `fake:edit:m5:${PIPELINE_NO_RAW_NOW}`,
    at: PIPELINE_NO_RAW_NOW,
    edit: true,
    message: { ...base.message, links },
    previous,
  };
}

const logsOf = (logs: Array<Record<string, unknown>>, msg: string) => logs.filter((entry) => entry.msg === msg);

test('folds a late embed into the gif library when the edit event carries the message as it was', async () => {
  const before = lineEvent({ id: 'm5', text: TENOR, at: PIPELINE_NO_RAW_NOW - 5000 }).message;
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
      const partial: AdapterMessageEvent = {
        ...lineEvent({ id: 'm5', text: '', at: PIPELINE_NO_RAW_NOW - 5000 }),
        id: `fake:edit:m5:partial:${PIPELINE_NO_RAW_NOW}`,
        at: PIPELINE_NO_RAW_NOW,
        edit: true,
        partial: true,
        message: { id: 'm5' },
      };
      assert.equal(await rig.emit(partial), 'ok');
      await settle();
      const { calls } = rig.fake;
      return calls.filter((call) => call.op === 'fetchMessages').map((call) => call.args);
    }
  );
  assert.deepEqual(result, [[{ iface: 'fake', chatId: 'c1' }, ['m5']]]);
});

test('dates a deletion by the time of the message and not by the time of the deletion', async () => {
  const written = Date.parse('2026-10-10T10:00:00Z');
  const { result } = await withFakeCore({ config: { features: { record: true } }, seed }, async (rig) => {
    const gone: AdapterMessageEvent = {
      ...lineEvent({ id: 'm7', text: 'oops', at: written }),
      id: `fake:delete:m7`,
      at: PIPELINE_NO_RAW_NOW,
      deleted: true,
      message: { id: 'm7', at: written, author: { id: 'u1', name: null, self: false, bot: false } },
    };
    assert.equal(await rig.emit(gone), 'ok');
    await until(() => rig.sources('deleted').length === 1);
    return rig.sources('deleted');
  });
  // The record day's UTC period carries the message date without requiring filename provenance.
  assert.equal(result[0]?.period, '2026-10-10');
});
