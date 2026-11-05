// One storage format for any media, whatever the interface (src/memory/db/source-media.ts): the closed list of kinds, the
// schema migration that fills `source_media`, absorbs `extra.extra.attachmentIds`, maps the `media` rows and drops
// `sources.media`, the describer's write reaching it, and a second fake interface whose native references have another shape
// and give the same rows and the same rendering. Synthetic content; no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootPlaceInDb } from '../src/memory/db/place-tree.ts';
import { dbSettings, quotesOf, search } from '../src/memory/db/recall.ts';
import { dmScope, groupContext, internalContext } from '../src/memory/db/scope.ts';
import { MEDIA_KINDS, mediaText, migrateSourceMedia, sourceMedia } from '../src/memory/db/source-media.ts';
import { fillStems } from '../src/memory/db/stems.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import {
  AT,
  BOB_PERSON,
  GENERAL,
  GROUP_SCOPE,
  KINDS,
  LABELS,
  NOW,
  PRESENCES,
  fixture,
  neutralRows,
  observeLine,
  storeDescription,
} from './fixtures/media-memory.ts';
import type { Env, Presence, Shape } from './fixtures/media-memory.ts';
import type { Row } from '../src/memory/db/types.ts';

const internal = internalContext();
const rowsOf = (env: Env, source: string) => sourceMedia(env.db, [source], internal).get(source) ?? [];

function withEnv(body: (env: Env) => void) {
  const env = fixture();
  try {
    body(env);
  } finally {
    env.done();
  }
}

// ---------- the closed list ----------

test('the kinds are one closed list, and the table refuses any other', () =>
  withEnv((env) => {
    assert.deepEqual([...MEDIA_KINDS], ['image', 'gif', 'video', 'sticker', 'emoji', 'voice', 'audio', 'file', 'link']);
    const source = observeLine(env, KINDS[0], 'absent');
    assert.throws(() =>
      env.db
        .prepare(
          "INSERT INTO source_media (source_id, position, kind, availability) VALUES (?, 7, 'attachment', 'unread')"
        )
        .run(source)
    );
  }));

test('the text of a line is the told text forms in position order, nothing of a bare one', () =>
  withEnv((env) => {
    const source = observeLine(env, KINDS[0], 'part');
    assert.equal(mediaText(rowsOf(env, source)), 'a retelling with a lighthouse in it');
    const bare = observeLine(env, KINDS[0], 'absent', { native: 'other' });
    assert.equal(mediaText(rowsOf(env, bare)), '');
  }));

test('the read names no row of a line the context may not open', () =>
  withEnv((env) => {
    const source = observeLine(env, KINDS[0], 'full', {
      native: 'secret',
      scope: dmScope(BOB_PERSON, 'discord'),
      conversation: { id: 'dm-bob', kind: 'dm', chatType: 'dm', partnerId: 'u-bob' },
      author: { id: 'u-bob', name: 'Bob' },
    });
    assert.equal(sourceMedia(env.db, [source], groupContext('discord')).get(source), undefined);
    assert.equal(sourceMedia(env.db, [source], internal).get(source)?.length, 2);
  }));

// ---------- the describer's write ----------

test("the describer's write tells every line holding the item, with no read of the cache afterwards", () =>
  withEnv((env) => {
    const one = observeLine(env, KINDS[0], 'absent', { native: 'pic' });
    const root = rootPlaceInDb(
      env.db,
      String(env.db.prepare('SELECT place_id FROM sources WHERE id = ?').get(one)?.place_id)
    );
    assert.ok(root);
    applyUnitWrite(env.handle, {
      op: 'lines',
      now: AT,
      key: placeCollection('versions', root, { selector: { versionKind: 'media', itemId: 'pic-a' } }),
      lines: [{ op: 'described', id: 'v1', entry: { text: 'a lighthouse', ts: AT } }],
    });
    const [first, second] = rowsOf(env, one);
    assert.deepEqual(
      [first.text, first.textOrigin, first.availability],
      ['a lighthouse', 'retelling', 'told'],
      'the told item'
    );
    assert.equal(second.availability, 'unread', 'the other item of the line');
  }));

// ---------- the migration ----------

/** A database as it stands before the migration: `sources.media` holds the kinds. */
function legacyLine(
  env: Env,
  {
    native,
    kinds,
    extra = {},
    scope = GROUP_SCOPE,
    place = GENERAL,
  }: { native: string; kinds: Array<string>; extra?: Row; scope?: typeof GROUP_SCOPE; place?: string }
): string {
  const has = env.db
    .prepare('PRAGMA table_info(sources)')
    .all()
    .some((column) => column.name === 'media');
  if (!has) env.db.exec('ALTER TABLE sources ADD COLUMN media TEXT');
  const id = env.say({ native, at: AT, text: '', place, scope, extra: JSON.stringify(extra) });
  env.db.prepare('UPDATE sources SET media = ? WHERE id = ?').run(JSON.stringify(kinds), id);
  return id;
}

const migrated = (env: Env, source: string) => {
  migrateSourceMedia(env.db);
  return rowsOf(env, source);
};

test('the migration makes one row per kind, in position, unread and without a reference', () =>
  withEnv((env) => {
    const source = legacyLine(env, { native: 'm1', kinds: ['image', 'video', 'sticker'] });
    assert.deepEqual(
      migrated(env, source).map(({ position, kind, nativeRef, availability }) => ({
        position,
        kind,
        nativeRef,
        availability,
      })),
      [
        { position: 0, kind: 'image', nativeRef: null, availability: 'unread' },
        { position: 1, kind: 'video', nativeRef: null, availability: 'unread' },
        { position: 2, kind: 'sticker', nativeRef: null, availability: 'unread' },
      ]
    );
  }));

test('the migration drops sources.media: the kinds live in one place', () =>
  withEnv((env) => {
    legacyLine(env, { native: 'm1', kinds: ['image'] });
    migrateSourceMedia(env.db);
    const columns = env.db.prepare('PRAGMA table_info(sources)').all();
    assert.equal(
      columns.some((column) => column.name === 'media'),
      false
    );
  }));

test('the migration absorbs extra.extra.attachmentIds into the references and removes them', () =>
  withEnv((env) => {
    const source = legacyLine(env, {
      native: 'm1',
      kinds: ['image', 'image'],
      extra: { subtype: 'x', extra: { attachmentIds: ['a1', null] } },
    });
    storeDescription(env, 'a1', 'a lighthouse');
    const rows = migrated(env, source);
    assert.deepEqual(
      rows.map(({ nativeRef, text, textOrigin, availability }) => ({ nativeRef, text, textOrigin, availability })),
      [
        { nativeRef: 'a1', text: 'a lighthouse', textOrigin: 'retelling', availability: 'told' },
        { nativeRef: null, text: null, textOrigin: null, availability: 'unread' },
      ]
    );
    const extra = String(env.db.prepare('SELECT extra FROM sources WHERE id = ?').get(source)?.extra);
    assert.ok(!extra.includes('attachmentIds'));
    assert.ok(extra.includes('subtype'), 'what else the line holds stays');
  }));

test('the migration runs once: a second run writes and changes nothing', () =>
  withEnv((env) => {
    const source = legacyLine(env, { native: 'm1', kinds: ['image'], extra: { extra: { attachmentIds: ['a1'] } } });
    migrateSourceMedia(env.db);
    const first = rowsOf(env, source);
    migrateSourceMedia(env.db);
    assert.deepEqual(rowsOf(env, source), first);
  }));

test("a video's watched summary is its text form; a still frame alone is one, origin frame", () =>
  withEnv((env) => {
    const both = legacyLine(env, { native: 'm1', kinds: ['video'], extra: { extra: { attachmentIds: ['v1'] } } });
    const still = legacyLine(env, { native: 'm2', kinds: ['video'], extra: { extra: { attachmentIds: ['v2'] } } });
    storeDescription(env, 'v1', 'a frame');
    storeDescription(env, 'video:v1', 'an avalanche, watched');
    storeDescription(env, 'v2', 'a frame only');
    migrateSourceMedia(env.db);
    assert.deepEqual(
      [rowsOf(env, both)[0].text, rowsOf(env, both)[0].textOrigin],
      ['an avalanche, watched', 'retelling']
    );
    assert.deepEqual([rowsOf(env, still)[0].text, rowsOf(env, still)[0].textOrigin], ['a frame only', 'frame']);
  }));

test('a line stored without ids takes its text form from the GIF library row that names its message', () =>
  withEnv((env) => {
    const source = legacyLine(env, { native: 'm3', kinds: ['gif'] });
    env.db
      .prepare(
        `INSERT INTO media (id, kind, native_ref, description, extra, scope_kind, scope_iface)
         VALUES ('media:gif:k', 'gif', 'm3', 'its name', ?, 'group', 'discord')`
      )
      .run(JSON.stringify({ itemId: 'item-1' }));
    storeDescription(env, 'item-1', 'a pirouette');
    const [row] = migrated(env, source);
    assert.deepEqual([row.nativeRef, row.text, row.textOrigin], ['item-1', 'a pirouette', 'retelling']);
  }));

test("a diary post's picture and its voice message take their text form from the post's media rows", () =>
  withEnv((env) => {
    const source = legacyLine(env, { native: 'm4', kinds: ['image', 'voice'] });
    const row = env.db.prepare(
      `INSERT INTO media (id, kind, native_ref, description, mime, extra, scope_kind, scope_iface)
       VALUES (?, 'diary', ?, ?, ?, ?, 'group', 'discord')`
    );
    row.run('media:diary:p', JSON.stringify({ messageId: 'm4', attachmentId: 'd1' }), 'a walrus', 'image/png', null);
    row.run(
      'media:diary:v',
      JSON.stringify({ messageId: 'm4', attachmentId: 'd2' }),
      null,
      'audio/ogg',
      JSON.stringify({ voice: true, text: 'a cathedral at dusk' })
    );
    const [picture, voice] = migrated(env, source);
    assert.deepEqual(
      [picture.nativeRef, picture.text, picture.textOrigin, voice.nativeRef, voice.text, voice.textOrigin],
      ['d1', 'a walrus', 'retelling', 'd2', 'a cathedral at dusk', 'voiced']
    );
  }));

test('an old line whose links hold their embed text keeps it as its text form, origin embed, and the rest unread', () =>
  withEnv((env) => {
    const source = legacyLine(env, {
      native: 'm5',
      kinds: ['link', 'link'],
      extra: {
        links: [{ id: 'l1', url: 'https://x.invalid/a', title: 'page', description: 'an observatory', site: 'x' }],
      },
    });
    const [first, second] = migrated(env, source);
    assert.deepEqual(
      [first.nativeRef, first.title, first.url, first.text, first.textOrigin, first.availability],
      ['l1', 'page', 'https://x.invalid/a', 'an observatory', 'embed', 'told']
    );
    assert.equal(second.availability, 'unread');
    assert.ok(
      !String(env.db.prepare('SELECT extra FROM sources WHERE id = ?').get(source)?.extra).includes('observatory')
    );
  }));

test('the migration maps a sticker, an emoji and a link cache key to the row of that kind', () =>
  withEnv((env) => {
    const source = legacyLine(env, {
      native: 'm6',
      kinds: ['sticker'],
      extra: { extra: { attachmentIds: ['s1'] } },
    });
    storeDescription(env, 'sticker:s1', 'a hedgehog');
    assert.equal(migrated(env, source)[0].text, 'a hedgehog');
  }));

test('a description narrower than the line stays out of the row, and the row stays unread', () =>
  withEnv((env) => {
    const source = legacyLine(env, { native: 'm7', kinds: ['image'], extra: { extra: { attachmentIds: ['a7'] } } });
    storeDescription(env, 'a7', 'a lighthouse only he saw', dmScope(BOB_PERSON, 'discord'));
    const [row] = migrated(env, source);
    assert.deepEqual([row.nativeRef, row.text, row.availability], ['a7', null, 'unread']);
  }));

test('a kind the old column held that the closed list does not: `text` becomes a file, an unknown one a file no model reads', () =>
  withEnv((env) => {
    const source = legacyLine(env, { native: 'm8', kinds: ['text', 'file', 'hologram'] });
    assert.deepEqual(
      migrated(env, source).map(({ kind, availability }) => [kind, availability]),
      [
        ['file', 'unread'],
        ['file', 'unreadable'],
        ['file', 'unreadable'],
      ]
    );
  }));

test('after the migration a word of a mapped description finds its line', () =>
  withEnv((env) => {
    legacyLine(env, { native: 'm9', kinds: ['image'], extra: { extra: { attachmentIds: ['a9'] } } });
    storeDescription(env, 'a9', 'a lighthouse');
    migrateSourceMedia(env.db);
    fillStems(env.db);
    const found = search(env.db, {
      ctx: groupContext('discord'),
      plan: { forms: ['lighthouse'], who: [], from: null, to: null },
      now: NOW,
      settings: dbSettings({})!,
    });
    assert.deepEqual(
      found.hits.map((hit) => hit.messageId),
      ['m9']
    );
  }));

// ---------- a second interface ----------

/** Another interface's references: a path, a query and a JSON-looking token, all opaque. */
const OTHER_SHAPES: ReadonlyArray<Shape> = [
  (id) => `file/AgACAg:${id}?size=x&v=2`,
  (id) => `{"bucket":"b1","key":"${id}"}`,
  (id) => `urn:media:${id}#0`,
];
const OTHER = 'plainchat';

/** What a read gives of a line, with the two things an interface owns left out: its references and the line's address. */
const neutral = neutralRows;

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
    for (const presence of PRESENCES as ReadonlyArray<Presence>) {
      test(`a second interface, ${shape('x')}: a ${kind.name} ${presence} gives the same rows and the same rendering`, () =>
        withEnv((env) => {
          const here = observeLine(env, kind, presence);
          const there = observeLine(env, kind, presence, {
            iface: OTHER,
            shape,
            native: 'pic-2',
            conversation: { id: 'room', kind: 'channel', rootId: 'space', name: 'general' },
            ...(kind.self ? { author: { id: 'u-self', self: true, name: 'Self' } } : {}),
            scope: { scope_kind: 'group', scope_iface: OTHER, scope_dm: null },
          });
          const ours = rowsOf(env, here);
          const theirs = rowsOf(env, there);
          assert.deepEqual(neutral(theirs), neutral(ours));
          assert.ok(theirs.length > 0);
          assert.equal(theirs[0].nativeRef, shape('pic-2-a'), 'its reference, stored as it came');
          assert.equal(rendered(env, OTHER), rendered(env, 'discord'));
        }));
    }
  }
}

test('the core reads nothing into a reference: one that looks like a cache key stays a reference', () =>
  withEnv((env) => {
    const source = observeLine(env, KINDS[0], 'absent', { shape: (id) => `video:${id}` });
    assert.equal(rowsOf(env, source)[0].kind, 'image');
    assert.equal(rowsOf(env, source)[0].nativeRef, 'video:pic-a');
  }));
