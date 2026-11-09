// One storage format for any media, whatever the interface (src/memory/db/media-store.ts): `media` is the only store and
// `media_links` ties it to its owners. The closed list of kinds, what an observed line stores, edit and delete, the describer's
// write, a voice line she sends, the diary's links and the mirror's `path`, the cache cap, and a second
// fake interface whose native references have another shape and give the same rows and the same rendering. Synthetic
// content; no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyEntryMedia } from '../src/memory/db/selfreflection-media.ts';
import { topPlaceSpelled } from '../src/memory/db/ids.ts';
import { MEDIA_KINDS, lineMedia, tellMedia } from '../src/memory/db/media-store.ts';
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

const internal = internalContext();
const rowsOf = (env: Env, source: string, ownerKind: 'source' | 'selfreflection' = 'source') =>
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

test("a page she read becomes its link's text form", () =>
  withEnv((env) => {
    const kind = KINDS.find((one) => one.stored === 'link') as Kind;
    const source = observeLine(env, kind, 'absent');
    tellMedia(env.handle, { iface: 'discord', nativeRef: 'pic-a', description: 'the page says this', origin: 'page' });
    const [row] = rowsOf(env, source);
    assert.deepEqual([row.description, row.extra.textOrigin], ['the page says this', 'page']);
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

// ---------- the diary and the mirror ----------

test("a diary entry's files are items linked to it, each with its path under media/ and its bytes' sha1", () =>
  withEnv((env) => {
    const dataDir = tempDir('nep-media-diary-');
    env.db.prepare("INSERT INTO selfreflection (id, scope_kind, scope_iface) VALUES ('d1', 'group', 'discord')").run();
    applyEntryMedia(env.handle, {
      dataDir,
      id: 'd1',
      items: [
        { data: Buffer.from('png'), mime: 'image/png' },
        { data: Buffer.from('ogg'), mime: 'audio/ogg', extra: { voice: true, text: 'a cathedral', durationSec: 2 } },
      ],
    });
    const rows = rowsOf(env, 'd1', 'selfreflection');
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
    env.db.prepare("INSERT INTO selfreflection (id, scope_kind, scope_iface) VALUES ('d2', 'group', 'discord')").run();
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
    assert.equal(rowsOf(env, 'd2', 'selfreflection')[0].mediaId, linked.mediaId);
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
          assert.deepEqual(
            neutralRows(theirs.map((row) => ({ ...row, describedAt: Boolean(row.describedAt) }))),
            neutralRows(ours.map((row) => ({ ...row, describedAt: Boolean(row.describedAt) })))
          );
          assert.equal(theirs[0].nativeRef, shape('pic-2-a'), 'its reference, stored as it came');
          assert.equal(rendered(env, OTHER), rendered(env, 'discord'));
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
