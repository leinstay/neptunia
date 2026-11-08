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
