// One storage format for any media, whatever the interface (src/memory/db/media-store.ts): `media` is the only store and
// `media_links` ties it to its owners. The closed list of kinds, what an observed line stores, edit and delete, the describer's
// write, a voice line she sends, the diary's links and the mirror's `path`, the cache cap, the one forward migration, and a
// second fake interface whose native references have another shape and give the same rows and the same rendering. Synthetic
// content; no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyEntryMedia } from '../src/memory/db/selfreflection-media.ts';
import { topPlaceSpelled } from '../src/memory/db/ids.ts';
import { MEDIA_KINDS, lineMedia, migrateMediaStore, tellMedia } from '../src/memory/db/media-store.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { rootPlaceInDb } from '../src/memory/db/place-tree.ts';
import { dbSettings, quotesOf, search } from '../src/memory/db/recall.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import { fillStems } from '../src/memory/db/stems.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import {
  AT,
  GENERAL,
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
        conversation: { id: 'c1', kind: 'channel', rootId: 'g1' },
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
    applyUnitWrite(env.handle, {
      op: 'lines',
      now: AT,
      key: placeCollection('versions', rootOf(env, one), { selector: { versionKind: 'media', itemId: 'pic-a' } }),
      lines: [{ op: 'described', id: 'v1', entry: { text: 'a lighthouse', ts: AT } }],
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

test("a linked item is never trimmed by the cache's cap", () =>
  withEnv((env) => {
    const source = observeLine(env, KINDS[0], 'full');
    applyUnitWrite(env.handle, {
      op: 'value',
      now: AT,
      key: placeCollection('media', rootOf(env, source)),
      value: { other: { text: 'something else', ts: AT } },
    });
    assert.equal(rowsOf(env, source)[0].description, 'a retelling with a lighthouse in it');
  }));

// ---------- her own voice message ----------

const MEMORY_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = MEMORY_NOW - 60_000;
const IFACE = 'synthetic';
const TOP = topPlaceSpelled(IFACE, 'community');
const VOICED = '[sighs] "собор на закате"';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

async function echoVoice(memory: Memory) {
  const event = eventOf(named('voice said'), 'sent-1', [true, false], {
    at: SENT,
    iface: IFACE,
    conversation: { id: 'room-a', kind: 'channel', chatType: 'channel', rootId: 'community' },
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

// ---------- the migration ----------

/** The database of an old engine: the old `media` table and the kinds on `sources`. */
function legacySchema(env: Env) {
  env.db.exec(`DROP TABLE IF EXISTS media_links; DROP TABLE media;
    CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT, owner TEXT, path TEXT, native_ref TEXT, description TEXT, described_at TEXT,
      sha1 TEXT, bytes INTEGER, mime TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, audience_id TEXT, extra JSON, owner_file TEXT, retired_at TEXT, owner_key TEXT, tier TEXT);`);
  const has = env.db
    .prepare('PRAGMA table_info(sources)')
    .all()
    .some((column) => column.name === 'media');
  if (!has) env.db.exec('ALTER TABLE sources ADD COLUMN media TEXT');
}

function legacyLine(env: Env, native: string, kinds: Array<string>, extra: Row = {}): string {
  const id = env.say({ native, at: AT, text: '', place: GENERAL, extra: JSON.stringify(extra) });
  env.db.prepare('UPDATE sources SET media = ? WHERE id = ?').run(JSON.stringify(kinds), id);
  return id;
}

function legacyMedia(env: Env, id: string, kind: string, nativeRef: string | null, row: Row = {}) {
  env.db
    .prepare(
      `INSERT INTO media (id, kind, native_ref, description, path, sha1, mime, extra, scope_kind, scope_iface)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'group', 'discord')`
    )
    .run(
      id,
      kind,
      nativeRef,
      row.description ?? null,
      row.path ?? null,
      row.sha1 ?? null,
      row.mime ?? null,
      row.extra ? JSON.stringify(row.extra) : null
    );
}

function migrated(body: (env: Env) => void | Promise<void>) {
  return () => {
    const env = fixture();
    legacySchema(env);
    return Promise.resolve(body(env)).finally(() => env.done());
  };
}

test(
  'the migration makes one item and one link per kind, in position, bare with no reference',
  migrated((env) => {
    const source = legacyLine(env, 'm1', ['image', 'video', 'sticker']);
    migrateMediaStore(env.db);
    assert.deepEqual(
      rowsOf(env, source).map(({ position, kind, nativeRef, availability }) => [
        position,
        kind,
        nativeRef,
        availability,
      ]),
      [
        [0, 'image', null, 'unknown'],
        [1, 'video', null, 'unknown'],
        [2, 'sticker', null, 'unknown'],
      ]
    );
  })
);

test(
  'the migration removes sources.media, and every other path of the old format',
  migrated((env) => {
    const source = legacyLine(env, 'm1', ['image', 'link'], {
      subtype: 'x',
      links: [{ id: 'l1', url: 'https://x.invalid/a', title: 'page', description: 'an observatory', site: 'x' }],
      extra: { attachmentIds: ['a1', null] },
    });
    migrateMediaStore(env.db);
    const columns = env.db.prepare('PRAGMA table_info(sources)').all();
    assert.equal(
      columns.some((column) => column.name === 'media'),
      false
    );
    const extra = JSON.parse(
      String(env.db.prepare('SELECT extra FROM sources WHERE id = ?').get(source)?.extra)
    ) as Row;
    assert.deepEqual(extra, { subtype: 'x' }, 'what else the line holds stays');
  })
);

test(
  'the migration moves attachmentIds into references and links the held description',
  migrated((env) => {
    const source = legacyLine(env, 'm1', ['image', 'image'], { extra: { attachmentIds: ['a1', null] } });
    legacyMedia(env, 'media:attachment:a1', 'attachment', 'a1', { description: 'a lighthouse' });
    migrateMediaStore(env.db);
    assert.deepEqual(
      rowsOf(env, source).map(({ kind, nativeRef, description, availability, extra }) => [
        kind,
        nativeRef,
        description,
        availability,
        extra.textOrigin ?? null,
      ]),
      [
        ['image', 'a1', 'a lighthouse', 'present', 'retelling'],
        ['image', null, null, 'unknown', null],
      ]
    );
  })
);

test(
  'the migration runs forward once: a second run changes nothing',
  migrated((env) => {
    const source = legacyLine(env, 'm1', ['image'], { extra: { attachmentIds: ['a1'] } });
    migrateMediaStore(env.db);
    const first = rowsOf(env, source);
    migrateMediaStore(env.db);
    assert.deepEqual(rowsOf(env, source), first);
  })
);

test(
  'the migration gives a report: rows, links, and what stayed bare',
  migrated((env) => {
    legacyLine(env, 'm1', ['image'], { extra: { attachmentIds: ['a1'] } });
    legacyLine(env, 'm2', ['image']);
    legacyMedia(env, 'media:attachment:a1', 'attachment', 'a1', { description: 'present' });
    const report = migrateMediaStore(env.db);
    assert.deepEqual([report.links, report.told, report.bare], [2, 1, 1]);
  })
);

test(
  "a video's watched summary is its text form; a still frame alone is one, origin frame; both are one item",
  migrated((env) => {
    const both = legacyLine(env, 'm1', ['video'], { extra: { attachmentIds: ['v1'] } });
    const still = legacyLine(env, 'm2', ['video'], { extra: { attachmentIds: ['v2'] } });
    legacyMedia(env, 'media:attachment:v1', 'attachment', 'v1', { description: 'a frame' });
    legacyMedia(env, 'media:attachment:video:v1', 'attachment', 'video:v1', { description: 'an avalanche, watched' });
    legacyMedia(env, 'media:attachment:v2', 'attachment', 'v2', { description: 'a frame only' });
    migrateMediaStore(env.db);
    const [watched] = rowsOf(env, both);
    assert.deepEqual([watched.description, watched.extra.textOrigin], ['an avalanche, watched', 'retelling']);
    const [frame] = rowsOf(env, still);
    assert.deepEqual([frame.description, frame.extra.textOrigin], ['a frame only', 'frame']);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM media WHERE native_ref LIKE '%v1'").get()?.n, 1);
  })
);

for (const [prefix, kind] of [
  ['sticker:', 'sticker'],
  ['emoji:', 'emoji'],
  ['link:', 'link'],
] as const) {
  test(
    `the prefix ${prefix} of a cache key becomes kind ${kind} and leaves the reference`,
    migrated((env) => {
      legacyMedia(env, `media:attachment:${prefix}k1`, 'attachment', `${prefix}k1`, { description: 'present' });
      migrateMediaStore(env.db);
      const row = env.db.prepare("SELECT kind, native_ref FROM media WHERE description = 'present'").get();
      assert.deepEqual([row?.kind, row?.native_ref], [kind, 'k1']);
    })
  );
}

test(
  'a line stored without ids is linked through the GIF library row that names its message, its file kept',
  migrated((env) => {
    const source = legacyLine(env, 'm3', ['gif']);
    legacyMedia(env, 'media:gif:k', 'gif', 'm3', {
      description: 'its name',
      path: 'media/gifs/k.gif',
      extra: { itemId: 'item-1', name: 'its name' },
    });
    legacyMedia(env, 'media:attachment:item-1', 'attachment', 'item-1', { description: 'a pirouette' });
    migrateMediaStore(env.db);
    const [row] = rowsOf(env, source);
    assert.deepEqual(
      [row.kind, row.nativeRef, row.description, row.path],
      ['gif', 'item-1', 'a pirouette', 'media/gifs/k.gif']
    );
    assert.equal(row.extra.name, 'its name', 'the library keeps its name');
  })
);

test(
  "a diary post's rows become items of their kinds, linked to the entry and to the line that posted them",
  migrated((env) => {
    const source = legacyLine(env, 'm4', ['image', 'voice']);
    env.db.prepare("INSERT INTO selfreflection (id, scope_kind, scope_iface) VALUES ('d9', 'group', 'discord')").run();
    legacyMedia(env, 'media:diary:d9-1', 'selfreflection', JSON.stringify({ messageId: 'm4', attachmentId: 'd1' }), {
      description: 'a walrus',
      path: 'media/selfreflection/d9-1.png',
      sha1: 'aa',
      mime: 'image/png',
    });
    legacyMedia(env, 'media:diary:d9-2', 'selfreflection', JSON.stringify({ messageId: 'm4', attachmentId: 'd2' }), {
      path: 'media/selfreflection/d9-2.ogg',
      sha1: 'bb',
      mime: 'audio/ogg',
      extra: { voice: true, text: 'a cathedral at dusk' },
    });
    migrateMediaStore(env.db);
    const [picture, voice] = rowsOf(env, source);
    assert.deepEqual(
      [picture.kind, picture.nativeRef, picture.description, picture.path],
      ['image', 'd1', 'a walrus', 'media/selfreflection/d9-1.png']
    );
    assert.deepEqual(
      [voice.kind, voice.nativeRef, voice.description, voice.extra.textOrigin],
      ['voice', 'd2', 'a cathedral at dusk', 'voiced']
    );
    assert.deepEqual(
      rowsOf(env, 'd9', 'selfreflection').map((one) => one.mediaId),
      [picture.mediaId, voice.mediaId]
    );
  })
);

test(
  'an old link holding its embed text becomes a link item, origin embed; the rest stay bare',
  migrated((env) => {
    const source = legacyLine(env, 'm5', ['link', 'link'], {
      links: [{ id: 'l1', url: 'https://x.invalid/a', title: 'page', description: 'an observatory', site: 'x' }],
    });
    migrateMediaStore(env.db);
    const [first, second] = rowsOf(env, source);
    assert.deepEqual(
      [first.nativeRef, first.description, first.availability, first.extra.title, first.extra.url],
      ['l1', 'an observatory', 'present', 'page', 'https://x.invalid/a']
    );
    assert.equal(second.availability, 'unknown');
  })
);

test(
  'an old column kind: `text` stays text, `file` and an unknown one become a file no model reads',
  migrated((env) => {
    const source = legacyLine(env, 'm8', ['text', 'file', 'hologram']);
    migrateMediaStore(env.db);
    assert.deepEqual(
      rowsOf(env, source).map(({ kind, availability }) => [kind, availability]),
      [
        ['text', 'unknown'],
        ['file', 'unreadable'],
        ['file', 'unreadable'],
      ]
    );
  })
);

test(
  'an old cache row nothing links stays as an item, so the backfill finds it with no model call',
  migrated((env) => {
    legacyMedia(env, 'media:attachment:orphan', 'attachment', 'orphan', { description: 'held' });
    migrateMediaStore(env.db);
    assert.equal(
      env.db.prepare("SELECT description FROM media WHERE native_ref = 'orphan'").get()?.description,
      'held'
    );
  })
);

test(
  'after the migration a word of a mapped description finds its item through its line',
  migrated((env) => {
    legacyLine(env, 'm9', ['image'], { extra: { attachmentIds: ['a9'] } });
    legacyMedia(env, 'media:attachment:a9', 'attachment', 'a9', { description: 'a lighthouse' });
    migrateMediaStore(env.db);
    fillStems(env.db);
    const found = search(env.db, {
      ctx: groupContext('discord'),
      plan: { forms: ['lighthouse'], who: [], from: null, to: null },
      now: NOW,
      settings: dbSettings({})!,
    });
    assert.deepEqual(
      found.mediaHits.map((hit) => hit.latest.messageId),
      ['m9']
    );
  })
);

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
            conversation: { id: 'room', kind: 'channel', rootId: 'space', name: 'general' },
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
