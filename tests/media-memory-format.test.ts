// One storage format for any media, whatever the interface (src/memory/db/media-store.ts): `media` is the only store and
// `media_links` ties it to its owners. The closed list of kinds, what an observed line stores, edit and delete, the describer's
// write, a voice line she sends, the diary's links and the mirror's `path`, the cache cap, and a second
// fake interface whose native references have another shape and give the same rows and the same rendering. Synthetic
// content; no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyEntryMedia } from '../src/memory/db/diary-media.ts';
import { SELF_PERSON, topPlaceSpelled } from '../src/memory/db/ids.ts';
import { MEDIA_KINDS, lineMedia, mediaMessageParts } from '../src/memory/db/media-store.ts';
import { collectEmojiItems } from '../src/media/classify.ts';
import { storedMediaTags } from '../src/format.ts';
import { personNamesOf } from '../src/memory/db/frame-reads.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { rootPlaceInDb } from '../src/memory/db/place-tree.ts';
import { dbSettings, quotesOf, search } from '../src/memory/db/recall.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import {
  AT,
  HER,
  KINDS,
  LABELS,
  NOW,
  PRESENCES,
  eventOf,
  fixture,
  neutralRows,
  observeLine,
  tell,
} from './fixtures/media-memory.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Env, Kind, Presence, Shape } from './fixtures/media-memory.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { noMediaNames } from './fixtures/media-namer.ts';

const internal = internalContext();
const rowsOf = (env: Env, source: string, ownerKind: 'source' | 'diary' = 'source') =>
  lineMedia(env.db, [source], internal, ownerKind).get(source) ?? [];
const named = (name: string) => KINDS.find((kind) => kind.name === name) as Kind;

function withEnv(body: (env: Env) => void) {
  const env = fixture();
  try {
    body(env);
  } finally {
    env.done();
  }
}

const stored = (name: string, presence: Presence = 'absent') => {
  const env = fixture();
  try {
    return rowsOf(env, observeLine(env, named(name), presence));
  } finally {
    env.done();
  }
};

// ---------- the shape ----------

test('the kinds are one closed list, and the table refuses any other', () =>
  withEnv((env) => {
    assert.deepEqual(
      [...MEDIA_KINDS],
      ['image', 'gif', 'video', 'sticker', 'emoji', 'voice', 'audio', 'link', 'text', 'file']
    );
    assert.throws(() =>
      env.db.prepare("INSERT INTO media (id, kind, availability) VALUES ('x', 'attachment', 'unknown')").run()
    );
  }));

test('a link names one of the two owner kinds, and the table refuses another', () =>
  withEnv((env) => {
    assert.throws(() =>
      env.db
        .prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('turn', 't', 0, 'x')")
        .run()
    );
  }));

test('a path is null or under media/', () =>
  withEnv((env) => {
    assert.throws(() =>
      env.db
        .prepare("INSERT INTO media (id, kind, path, availability) VALUES ('x', 'image', '/etc/passwd', 'unknown')")
        .run()
    );
  }));

test('nothing is written twice: the line holds no kinds and no ids, and its media are links', () =>
  withEnv((env) => {
    const source = observeLine(env, KINDS[0], 'full');
    const row = env.db.prepare('SELECT * FROM sources WHERE id = ?').get(source) as Row;
    assert.equal('media' in row, false, 'no kinds on the line');
    const extra = String(row.extra);
    assert.ok(!extra.includes('attachmentIds') && !extra.includes('pic-a') && !extra.includes('"links"'));
    assert.deepEqual(
      env.db
        .prepare("SELECT position FROM media_links WHERE owner_kind = 'source' AND owner_id = ? ORDER BY position")
        .all(source)
        .map((one) => one.position),
      [0, 1]
    );
  }));

test('an observed attachment is one item per position, with its reference, and name and length in extra, never a file address', () => {
  const items = stored('video');
  assert.deepEqual(
    items.map(({ position, kind, nativeRef, path: file, availability, extra }) => ({
      position,
      kind,
      nativeRef,
      file,
      availability,
      fileName: extra.fileName,
      durationSec: extra.durationSec,
    })),
    [0, 1].map((position) => ({
      position,
      kind: 'video',
      nativeRef: position === 0 ? 'pic-a' : 'pic-b',
      file: null,
      availability: 'unknown',
      fileName: 'v.mp4',
      durationSec: 12,
    }))
  );
  assert.ok(!JSON.stringify(items).includes('cdn.example.invalid'));
});

test("an observed sticker's id is its reference", () => {
  assert.deepEqual(
    stored('sticker').map(({ kind, nativeRef }) => [kind, nativeRef]),
    [
      ['sticker', 'pic-a'],
      ['sticker', 'pic-b'],
    ]
  );
});

test("an observed link's title, site and posted address are in extra, its embed text its text form, origin embed", () => {
  const [first] = stored('link', 'full');
  assert.deepEqual(
    {
      kind: first.kind,
      ref: first.nativeRef,
      description: first.description,
      availability: first.availability,
      ...first.extra,
    },
    {
      kind: 'link',
      ref: 'pic-a',
      description: 'a retelling with a observatory in it',
      availability: 'present',
      title: 'page 0',
      site: 'site.example.invalid',
      url: 'https://site.example.invalid/pic-a',
      textOrigin: 'embed',
    }
  );
});

test('an observed text attachment is kind text, waiting for its preview; its preview is its text form', () =>
  withEnv((env) => {
    const kind = named('text file');
    const source = observeLine(env, kind, 'part');
    const [first, second] = rowsOf(env, source);
    assert.deepEqual(
      [first.kind, first.description, first.extra.textOrigin],
      ['text', 'a retelling with a marzipan in it', 'preview']
    );
    assert.deepEqual([second.kind, second.availability], ['text', 'unknown']);
  }));

test('a kind the closed list does not hold is stored as a file no model can read', () =>
  withEnv((env) => {
    const odd = {
      ...KINDS[0],
      message: () => ({ attachments: [{ id: 'x1', kind: 'hologram', name: 'x.holo', url: 'https://x.invalid/x' }] }),
    };
    const [item] = rowsOf(env, observeLine(env, odd, 'absent'));
    assert.deepEqual([item.kind, item.availability], ['file', 'unreadable']);
  }));

test('an observed custom emoji is an item of its own, after what the message carries', () => {
  assert.deepEqual(
    stored('emoji').map(({ kind, nativeRef }) => [kind, nativeRef]),
    [
      ['emoji', 'pic-a'],
      ['emoji', 'pic-b'],
    ]
  );
});

test('a text message with no media has no links', () =>
  withEnv((env) => {
    const envelope = observationOf(
      {
        iface: 'discord',
        at: AT,
        chat: { id: 'c1', kind: 'channel', rootId: 'g1' },
        message: { id: 'm1', at: AT, content: 'hello', author: { id: 'u1' }, attachments: [], links: [], stickers: [] },
      },
      { selfId: HER }
    );
    assert.ok(envelope);
    observe(env.handle, envelope, { now: () => AT });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM media_links').get()?.n, 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM media').get()?.n, 0);
  }));

// ---------- edit and delete ----------

test('an edit that drops an attachment leaves the current line with what it still holds', () =>
  withEnv((env) => {
    observeLine(env, KINDS[0], 'full');
    const edit = eventOf(KINDS[0], 'pic', [true, true], { at: AT + 60_000 });
    edit.edit = true;
    (edit.message as { attachments: Array<Row> }).attachments.length = 1;
    const envelope = observationOf(edit, { selfId: HER });
    assert.ok(envelope);
    observe(env.handle, envelope, { now: () => AT + 60_000 });
    const current = env.db
      .prepare("SELECT id FROM sources WHERE native_id = 'pic' AND kind = 'seen' ORDER BY revision DESC LIMIT 1")
      .get()?.id as string;
    assert.deepEqual(
      rowsOf(env, current).map((one) => one.nativeRef),
      ['pic-a']
    );
  }));

test('a deleted message keeps its item but no live use of it', () =>
  withEnv((env) => {
    observeLine(env, KINDS[0], 'full');
    env.stem();
    env.deleted('pic', AT + 60_000);
    const found = search(env.db, {
      ctx: groupContext('discord'),
      plan: { forms: [KINDS[0].first.word], who: [], from: null, to: null },
      now: NOW,
      settings: dbSettings({})!,
    });
    assert.deepEqual(found.mediaHits, []);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM media WHERE native_ref = 'pic-a'").get()?.n, 1);
  }));

// ---------- the describer's write and the cache cap ----------

const rootOf = (env: Env, source: string) => {
  const place = env.db.prepare('SELECT place_id FROM sources WHERE id = ?').get(source)?.place_id;
  const root = rootPlaceInDb(env.db, String(place));
  assert.ok(root);
  return root;
};

test("the describer's write tells the item, and every line that links it reads it", () =>
  withEnv((env) => {
    const one = observeLine(env, KINDS[0], 'absent', { native: 'pic' });
    applyMemoryWrite(env.handle, {
      kind: 'media-entry',
      op: 'put',
      placeId: rootOf(env, one),
      key: 'pic-a',
      entry: { text: 'a lighthouse', ts: AT },
      iface: 'discord',
      now: AT,
    });
    const [first, second] = rowsOf(env, one);
    assert.deepEqual(
      [first.description, first.availability, first.extra.textOrigin],
      ['a lighthouse', 'present', 'retelling']
    );
    assert.ok(first.describedAt, 'with the time it was told');
    assert.equal(second.availability, 'unknown', 'the other item of the line');
  }));

// ---------- her own voice message ----------

const MEMORY_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = MEMORY_NOW - 60_000;
const IFACE = 'synthetic';
const TOP = topPlaceSpelled(IFACE, 'root');
const VOICED = '[sighs] "собор на закате"';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

async function echoVoice(memory: Memory) {
  const event = eventOf(named('voice said'), 'sent-1', [true, false], {
    at: SENT,
    iface: IFACE,
    chat: { id: 'room-a', kind: 'channel', chatType: 'channel', rootId: 'root' },
    author: { id: HER, self: true },
  });
  (event.message as Row).attachments = [{ id: 'v1', kind: 'voice', name: 'v.ogg', durationSec: 9 }];
  const envelope = observationOf(event, { selfId: HER });
  assert.ok(envelope);
  await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
}

async function recordVoice(memory: Memory) {
  const line = toRecordLine(
    {
      id: 'sent-1',
      placeId: 'room-a',
      content: '',
      ts: SENT,
      replyToId: null,
      mentionedAccountIds: [],
      attachments: [{ id: 'v1', kind: 'voice' }],
      voiced: VOICED,
    },
    { kind: 'said', now: () => MEMORY_NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => MEMORY_NOW }).append(TOP, [line], {});
}

for (const [order, steps] of [
  ['the echo before the record line', [echoVoice, recordVoice]],
  ['the record line before the echo', [recordVoice, echoVoice]],
] as const) {
  test(`her voice message, ${order}: one line, its text empty as sent, its voice item keeps what she voiced`, async () => {
    const memory = await openTestMemory({ now: () => MEMORY_NOW, iface: () => IFACE });
    try {
      for (const step of steps) await step(memory);
      const db = memory.memoryDb.database() as Db;
      const rows = db.prepare("SELECT * FROM sources WHERE kind = 'said'").all();
      assert.equal(rows.length, 1, 'one line');
      assert.equal(rows[0].text, '', 'sources.text stays what the message holds');
      assert.equal(rows[0].turn_id, 't-1');
      const media = lineMedia(db, [String(rows[0].id)], internal, 'source').get(String(rows[0].id)) ?? [];
      assert.deepEqual(
        media.map(({ kind, nativeRef, description, availability, extra }) => [
          kind,
          nativeRef,
          description,
          availability,
          extra.textOrigin,
        ]),
        [['voice', 'v1', VOICED, 'present', 'voiced']]
      );
    } finally {
      await memory.close();
    }
  });
}

// ---------- the marks on what she made ----------

const ROOM = { id: 'room-a', kind: 'channel', chatType: 'channel', rootId: 'root' };

/** A line of Alice's in the room, so her account and person exist; answers her person id. */
async function aliceSpeaks(memory: Memory): Promise<string> {
  const event = eventOf(named('image'), 'alice-1', [false, false], {
    at: SENT - 1000,
    iface: IFACE,
    chat: ROOM,
    author: { id: 'u-alice', name: 'Alice' },
  });
  const envelope = observationOf(event, { selfId: HER });
  assert.ok(envelope);
  await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  const db = memory.memoryDb.database() as Db;
  const person = db.prepare("SELECT person_id FROM accounts WHERE iface = ? AND native_id = 'u-alice'").get(IFACE);
  return person?.person_id as string;
}

async function echoDrawing(memory: Memory) {
  const event = eventOf(named('image'), 'drawn-1', [false, false], {
    at: SENT,
    iface: IFACE,
    chat: ROOM,
    author: { id: HER, self: true },
  });
  (event.message as Row).attachments = [{ id: 'pic-1', kind: 'image', name: 'drawing.png' }];
  const envelope = observationOf(event, { selfId: HER });
  assert.ok(envelope);
  await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
}

/** The record line of her posted drawing, with the marks of her draw.create call: herself and Alice. */
async function recordDrawing(memory: Memory) {
  const line = toRecordLine(
    {
      id: 'drawn-1',
      placeId: 'room-a',
      content: '',
      ts: SENT,
      replyToId: null,
      mentionedAccountIds: [],
      attachments: [{ id: 'pic-1', kind: 'image' }],
      marks: { self: true, accounts: ['u-alice'] },
    },
    { kind: 'said', now: () => MEMORY_NOW, turnId: 't-2', opId: 'op-2' }
  );
  await createRecord({ ...memory, now: () => MEMORY_NOW }).append(TOP, [line], {});
}

/** The `extra` of the one media row of her line `drawn-1`. */
function drawnExtra(memory: Memory): Row {
  const db = memory.memoryDb.database() as Db;
  const source = db.prepare("SELECT id FROM sources WHERE kind = 'said'").get();
  assert.ok(source, 'her line is stored');
  const media = lineMedia(db, [String(source.id)], internal, 'source').get(String(source.id)) ?? [];
  assert.equal(media.length, 1);
  return media[0].extra;
}

for (const [order, steps] of [
  ['the echo before the record line', [echoDrawing, recordDrawing]],
  ['the record line before the echo', [recordDrawing, echoDrawing]],
  ['the echo, the record line and a second echo', [echoDrawing, recordDrawing, echoDrawing]],
] as const) {
  test(`her drawing, ${order}: its row is marked made by her and shows herself and Alice`, async () => {
    // Bug: the marks of her call are lost between the tool and the row, or a later write of the row drops them.
    const memory = await openTestMemory({ now: () => MEMORY_NOW, iface: () => IFACE });
    try {
      const alice = await aliceSpeaks(memory);
      for (const step of steps) await step(memory);
      const extra = drawnExtra(memory);
      assert.equal(extra.made, 'self');
      assert.deepEqual(extra.depicts, [SELF_PERSON, alice]);
    } finally {
      await memory.close();
    }
  });
}

test('her voice message is marked made by her and shows her own person', async () => {
  // Bug: a voice clip she spoke reads as anybody's clip in her memory.
  const memory = await openTestMemory({ now: () => MEMORY_NOW, iface: () => IFACE });
  try {
    await echoVoice(memory);
    const line = toRecordLine(
      {
        id: 'sent-1',
        placeId: 'room-a',
        content: '',
        ts: SENT,
        replyToId: null,
        mentionedAccountIds: [],
        attachments: [{ id: 'v1', kind: 'voice' }],
        voiced: VOICED,
        marks: { self: true, accounts: [] },
      },
      { kind: 'said', now: () => MEMORY_NOW, turnId: 't-1', opId: 'op-1' }
    );
    await createRecord({ ...memory, now: () => MEMORY_NOW }).append(TOP, [line], {});
    const db = memory.memoryDb.database() as Db;
    const source = db.prepare("SELECT id FROM sources WHERE kind = 'said'").get();
    const [voice] = lineMedia(db, [String(source?.id)], internal, 'source').get(String(source?.id)) ?? [];
    assert.deepEqual([voice?.extra.made, voice?.extra.depicts], ['self', [SELF_PERSON]]);
  } finally {
    await memory.close();
  }
});

const MARK_LABELS = {
  ...LABELS,
  transcript: {
    ...LABELS.transcript,
    mediaMade: '[MADE]',
    mediaDepicts: '[SHOWS {names}]',
    mediaDepictsSelf: 'HERSELF',
  },
};

/** The tags of her line `drawn-1` as a request renders a stored line, after its picture was told `a fox`. */
function drawnTags(memory: Memory): Array<string> {
  const db = memory.memoryDb.database() as Db;
  const source = String(db.prepare("SELECT id FROM sources WHERE kind = 'said'").get()?.id);
  db.prepare("UPDATE media SET description = 'a fox', availability = 'present' WHERE native_ref = 'pic-1'").run();
  const rows = lineMedia(db, [source], internal, 'source').get(source) ?? [];
  return storedMediaTags(mediaMessageParts(rows, source), MARK_LABELS);
}

test('the tag of her drawing is followed by the made mark and the people it shows, herself worded by the label', async () => {
  // Bug: she reads her own drawing as a stranger's picture and cannot tell who is in it.
  const memory = await openTestMemory({ now: () => MEMORY_NOW, iface: () => IFACE });
  try {
    await aliceSpeaks(memory);
    await echoDrawing(memory);
    await recordDrawing(memory);
    assert.deepEqual(drawnTags(memory), ['<image: a fox>', '[MADE]', '[SHOWS HERSELF, Alice]']);
  } finally {
    await memory.close();
  }
});

test('the people of her drawing are shown by the name they go by now', async () => {
  // Bug: the name is written into the row at drawing time and a renamed member keeps the old one forever.
  const memory = await openTestMemory({ now: () => MEMORY_NOW, iface: () => IFACE });
  try {
    const alice = await aliceSpeaks(memory);
    await echoDrawing(memory);
    await recordDrawing(memory);
    const db = memory.memoryDb.database() as Db;
    // A rename, as memory holds it after the interface reported the new name.
    db.prepare("UPDATE person_accounts SET display_name = 'Alicia' WHERE person_id = ?").run(alice);
    db.prepare(`UPDATE accounts SET names = '["Alicia"]' WHERE person_id = ?`).run(alice);
    const names = personNamesOf(db, [alice]);
    assert.deepEqual(Object.values(names), ['Alicia'], 'the rename is what memory knows');
    assert.deepEqual(drawnTags(memory).at(-1), '[SHOWS HERSELF, Alicia]');
  } finally {
    await memory.close();
  }
});

test('a picture with no marks renders as its description tag alone', async () => {
  // Bug: the marks leak onto every picture, or their absence leaves an empty tag behind.
  const memory = await openTestMemory({ now: () => MEMORY_NOW, iface: () => IFACE });
  try {
    await echoDrawing(memory);
    assert.deepEqual(drawnTags(memory), ['<image: a fox>']);
  } finally {
    await memory.close();
  }
});

// ---------- the diary and the mirror ----------

test("a diary entry's files are items linked to it, each with its path under media/ and its bytes' sha1", () =>
  withEnv((env) => {
    const dataDir = tempDir('nep-media-diary-');
    env.db.prepare("INSERT INTO diary (id, scope_kind, scope_iface) VALUES ('d1', 'group', 'discord')").run();
    applyEntryMedia(env.handle, {
      dataDir,
      id: 'd1',
      items: [
        { data: Buffer.from('png'), mime: 'image/png' },
        { data: Buffer.from('ogg'), mime: 'audio/ogg', extra: { voice: true, text: 'a cathedral', durationSec: 2 } },
      ],
    });
    const rows = rowsOf(env, 'd1', 'diary');
    assert.deepEqual(
      rows.map((one) => [one.position, one.kind]),
      [
        [0, 'image'],
        [1, 'voice'],
      ]
    );
    for (const row of rows) {
      assert.ok(String(row.path).startsWith('media/'), String(row.path));
      assert.ok(fs.existsSync(path.join(dataDir, String(row.path))), 'the mirror finds the file');
      assert.ok(row.sha1);
    }
    assert.deepEqual([rows[1].description, rows[1].extra.textOrigin], ['a cathedral', 'voiced']);
  }));

test('a diary entry and a message showing the same file are one item with two links', () =>
  withEnv((env) => {
    env.db.prepare("INSERT INTO diary (id, scope_kind, scope_iface) VALUES ('d2', 'group', 'discord')").run();
    const source = observeLine(env, KINDS[0], 'absent');
    applyEntryMedia(env.handle, {
      dataDir: tempDir('nep-media-diary-'),
      id: 'd2',
      items: [
        {
          data: Buffer.from('png'),
          mime: 'image/png',
          ref: { messageId: 'pic', attachmentId: 'pic-a' },
        },
      ],
    });
    const [linked] = rowsOf(env, source);
    assert.ok(String(linked.path).startsWith('media/'), 'the line now knows the file');
    assert.equal(rowsOf(env, 'd2', 'diary')[0].mediaId, linked.mediaId);
  }));

// ---------- a second interface ----------

/** Another interface's references: a path with a query, a JSON-looking token and a URN, all opaque. */
const OTHER_SHAPES: ReadonlyArray<Shape> = [
  (id) => `file/AgACAg:${id}?size=x&v=2`,
  (id) => `{"bucket":"b1","key":"${id}"}`,
  (id) => `urn:media:${id}#0`,
];
const OTHER = 'plainchat';

/** The rendered quotes of a day on one interface, by the one rendering. */
const rendered = (env: Env, iface: string) => {
  const found = search(env.db, {
    ctx: groupContext(iface),
    plan: { forms: [], who: [], from: AT - 3_600_000, to: AT + 3_600_000 },
    now: NOW,
    settings: dbSettings({})!,
    sampleTime: true,
  });
  return quotesOf(found.windows, {
    mediaNameOf: noMediaNames,
    render: { labels: LABELS, timezone: 'UTC', selfName: 'Self', seeReactions: true },
    stretchChars: 4000,
  })
    .map((quote) => quote.lines)
    .join('\n');
};

for (const shape of OTHER_SHAPES) {
  for (const kind of KINDS) {
    for (const presence of PRESENCES) {
      test(`a second interface, ${shape('x')}: a ${kind.name} ${presence} gives the same rows and the same rendering`, () =>
        withEnv((env) => {
          const here = observeLine(env, kind, presence);
          const there = observeLine(env, kind, presence, {
            iface: OTHER,
            shape,
            native: 'pic-2',
            chat: { id: 'room', kind: 'channel', rootId: 'space', name: 'general' },
          });
          const ours = rowsOf(env, here);
          const theirs = rowsOf(env, there);
          assert.ok(theirs.length > 0);
          // The owner on 2026-11-17: an emoji's and a sticker's description stands in the legend, the line holds the stable name.
          // Each interface's things get their own numbers, so rows and rendering are the same up to the number of a name.
          const unnumbered = (text: string): string => text.replace(/\b([es])\d+\b/g, '$1N');
          const neutral = (rows: ReturnType<typeof rowsOf>): string =>
            unnumbered(
              JSON.stringify(neutralRows(rows.map((row) => ({ ...row, describedAt: Boolean(row.describedAt) }))))
            );
          assert.equal(neutral(theirs), neutral(ours));
          assert.equal(theirs[0].nativeRef, shape('pic-2-a'), 'its reference, stored as it came');
          assert.equal(unnumbered(rendered(env, OTHER)), unnumbered(rendered(env, 'discord')));
        }));
    }
  }
}

test('the core reads nothing into a reference: one that looks like a cache key stays a reference', () =>
  withEnv((env) => {
    const source = observeLine(env, KINDS[0], 'absent', { shape: (id) => `video:${id}` });
    const [row] = rowsOf(env, source);
    assert.deepEqual([row.kind, row.nativeRef], ['image', 'video:pic-a']);
    tell(env, KINDS[0], { id: 'video:pic-a', told: 'present' });
    assert.equal(rowsOf(env, source)[0].description, 'present');
  }));

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('an animated emoji read back from a stored line is still an animated item with its animation address', () =>
  withEnv((env) => {
    const animationUrl = 'https://cdn.example.invalid/900.gif';
    const event = {
      iface: 'discord',
      at: AT,
      chat: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' },
      message: {
        id: 'anim',
        at: AT,
        content: 'χα :e1:',
        author: { id: 'u-alice', name: 'Alice' },
        attachments: [],
        links: [],
        stickers: [],
        emojis: [{ id: '900', name: 'e1', animated: true, url: 'https://cdn.example.invalid/900.png', animationUrl }],
      },
    };
    const envelope = observationOf(event, { selfId: HER });
    assert.ok(envelope);
    assert.equal(observe(env.handle, envelope, { now: () => AT }).ok, true);
    const row = env.db.prepare('SELECT id FROM sources WHERE native_id = ? ORDER BY rowid LIMIT 1').get('anim');
    const source = String(row?.id);
    const parts = mediaMessageParts(rowsOf(env, source), 'anim');
    const [item] = collectEmojiItems({ id: 'anim', ...parts });
    assert.deepEqual([item?.name, item?.animated, item?.animationUrl], ['e1', true, animationUrl]);
  }));
