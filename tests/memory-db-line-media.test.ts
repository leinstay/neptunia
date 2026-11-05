// The descriptions src/memory/db/line-media.ts reads for the pictures of stored lines: by the attachment id the
// observation kept, from the media row and then the durable description, and for a line stored without ids through the
// message id the GIF library and the diary's own posts hold. Synthetic rows on a real temp database; no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelPlaceId, messageSourceId, personId } from '../src/memory/db/ids.ts';
import { lineDescriptions, sourceAttachmentIds } from '../src/memory/db/line-media.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { mediaDescriptionId } from '../src/memory/db/export.ts';
import { dmContext, dmScope, groupContext, groupScope } from '../src/memory/db/scope.ts';
import { dbSettings, search } from '../src/memory/db/recall.ts';
import { fillStems } from '../src/memory/db/stems.ts';
import { keyText, placeCollection, storageId } from '../src/memory/db/storage-keys.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { fixture } from './fixtures/memory-db-recall.ts';

type Env = ReturnType<typeof fixture>;
const AT = Date.parse('2026-11-01T10:00:00.000Z');
const SERVER = channelPlaceId('discord', 'server');
const GENERAL = channelPlaceId('discord', 'c1');
const group = groupContext('discord');
const PLACES =
  "INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind) VALUES (?, 'discord', ?, ?, ?, 'group')";

/** A server with one channel under it: where a line stands and where its media cache is kept. */
function withPlaces(env: Env) {
  env.db.prepare(PLACES).run(SERVER, 'server', 'server', null);
  env.db.prepare(PLACES).run(GENERAL, 'channel', 'c1', SERVER);
}

const lineOf = (id: string, attachments: Array<Record<string, unknown>>) => ({
  id,
  stored: { sourceId: `src:${id}`, placeId: GENERAL, iface: 'discord' },
  attachments,
});
const bare = (id: string, kind: string, at = 0) => ({ id: `${id}#m${at}`, kind, name: kind });
const known = (id: string, attachmentId: string) => ({ ...bare(id, 'image'), attachmentId });

function mediaRow(
  env: Env,
  id: string,
  row: { kind: string; nativeRef: string; description?: string | null; extra?: object | null; mime?: string | null },
  scope: ReturnType<typeof groupScope> = groupScope('discord')
) {
  env.db
    .prepare(
      `INSERT INTO media (id, kind, native_ref, description, extra, mime, scope_kind, scope_iface, scope_dm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      row.kind,
      row.nativeRef,
      row.description ?? null,
      row.extra ? JSON.stringify(row.extra) : null,
      row.mime ?? null,
      scope.scope_kind,
      scope.scope_iface,
      scope.scope_dm
    );
}

/** A durable description of an attachment, as the media versions store it under the server's key. */
function durable(
  env: Env,
  attachmentId: string,
  entry: Record<string, unknown>,
  scope: ReturnType<typeof groupScope> = groupScope('discord')
) {
  const key = placeCollection('versions', SERVER, { selector: { versionKind: 'media', itemId: attachmentId } });
  const owner = storageId(key);
  const version = `${attachmentId}:v1`;
  env.db
    .prepare(
      `INSERT OR IGNORE INTO storage_units (id, kind, subject_type, subject_id, key_json)
       VALUES (?, 'versions', 'place', ?, ?)`
    )
    .run(owner, SERVER, keyText(key));
  env.db
    .prepare(
      `INSERT INTO descriptions (id, subject_kind, subject_id, field, owner_key, scope_kind, scope_iface, scope_dm)
       VALUES (?, 'media', ?, 'description', ?, ?, ?, ?)`
    )
    .run(mediaDescriptionId(key), attachmentId, owner, scope.scope_kind, scope.scope_iface, scope.scope_dm);
  env.db
    .prepare(
      `INSERT INTO description_versions (id, description_id, text, origin, extra, owner_key, position)
       VALUES (?, ?, 'x', 'media', ?, ?, 1)`
    )
    .run(version, mediaDescriptionId(key), JSON.stringify({ entry }), owner);
  env.db.prepare('UPDATE descriptions SET current_version = ? WHERE id = ?').run(version, mediaDescriptionId(key));
}

function withBare(body: (env: Env) => void) {
  const env = fixture();
  try {
    body(env);
  } finally {
    env.done();
  }
}

function withEnv(body: (env: Env) => void) {
  const env = fixture();
  try {
    withPlaces(env);
    body(env);
  } finally {
    env.done();
  }
}

test('a known attachment id reads the description of its media row', () => {
  withEnv((env) => {
    mediaRow(env, 'media:attachment:a1', { kind: 'attachment', nativeRef: 'a1', description: 'from the media row' });
    durable(env, 'a1', { text: 'from the durable row', ts: AT });
    const found = lineDescriptions({ db: env.db, ctx: group, lines: [lineOf('m1', [known('m1', 'a1')])] });
    assert.equal(found.get('m1#m0'), 'from the media row');
  });
});

test('an evicted media row falls back to the durable description of the server the line stands in', () => {
  withEnv((env) => {
    mediaRow(env, 'media:attachment:a1', { kind: 'attachment', nativeRef: 'a1', description: 'evicted' });
    env.db
      .prepare('UPDATE media SET retired_at = ? WHERE id = ?')
      .run(new Date(AT).toISOString(), 'media:attachment:a1');
    durable(env, 'a1', { text: 'from the durable row', ts: AT });
    const found = lineDescriptions({ db: env.db, ctx: group, lines: [lineOf('m1', [known('m1', 'a1')])] });
    assert.equal(found.get('m1#m0'), 'from the durable row');
  });
});

test('a durable answer to a question is no description of the picture', () => {
  withEnv((env) => {
    durable(env, 'a1', { answer: 'a second look', question: 'what', ts: AT });
    assert.equal(lineDescriptions({ db: env.db, ctx: group, lines: [lineOf('m1', [known('m1', 'a1')])] }).size, 0);
  });
});

test('a durable description under an audience the context may not open stays out', () => {
  withEnv((env) => {
    durable(env, 'a1', { text: 'private', ts: AT }, dmScope(personId('discord', 'u-bob'), 'discord'));
    assert.equal(lineDescriptions({ db: env.db, ctx: group, lines: [lineOf('m1', [known('m1', 'a1')])] }).size, 0);
  });
});

test('an old GIF line reads its description through the library row that names its message', () => {
  withEnv((env) => {
    mediaRow(env, 'media:gif:g1', { kind: 'gif', nativeRef: 'm1', description: 'a name', extra: { itemId: 'a7' } });
    mediaRow(env, 'media:attachment:a7', { kind: 'attachment', nativeRef: 'a7', description: 'a cat falling' });
    const found = lineDescriptions({ db: env.db, ctx: group, lines: [lineOf('m1', [bare('m1', 'gif')])] });
    assert.equal(found.get('m1#m0'), 'a cat falling');
  });
});

test('a library row whose attachment has no description gives no description, its name is not one', () => {
  withEnv((env) => {
    mediaRow(env, 'media:gif:g1', { kind: 'gif', nativeRef: 'm1', description: 'a name', extra: { itemId: 'a7' } });
    assert.equal(lineDescriptions({ db: env.db, ctx: group, lines: [lineOf('m1', [bare('m1', 'gif')])] }).size, 0);
  });
});

test('an old picture of a diary post reads the description its row keeps', () => {
  withEnv((env) => {
    mediaRow(env, 'media:diary:d1', {
      kind: 'diary',
      nativeRef: JSON.stringify({ url: 'https://example.invalid/p.png', messageId: 'm1', attachmentId: 'a9' }),
      description: 'her drawing of a kettle',
      mime: 'image/png',
    });
    const found = lineDescriptions({ db: env.db, ctx: group, lines: [lineOf('m1', [bare('m1', 'image')])] });
    assert.equal(found.get('m1#m0'), 'her drawing of a kettle');
  });
});

test("a joined row the line's kind does not match, or another line's, gives nothing", () => {
  withEnv((env) => {
    mediaRow(env, 'media:gif:g1', { kind: 'gif', nativeRef: 'm1', extra: { itemId: 'a7' } });
    mediaRow(env, 'media:attachment:a7', { kind: 'attachment', nativeRef: 'a7', description: 'a cat falling' });
    assert.equal(lineDescriptions({ db: env.db, ctx: group, lines: [lineOf('m1', [bare('m1', 'image')])] }).size, 0);
    assert.equal(lineDescriptions({ db: env.db, ctx: group, lines: [lineOf('m2', [bare('m2', 'gif')])] }).size, 0);
  });
});

test('a joined row under an audience the context may not open stays out', () => {
  withEnv((env) => {
    const bob = personId('discord', 'u-bob');
    mediaRow(
      env,
      'media:diary:d1',
      {
        kind: 'diary',
        nativeRef: JSON.stringify({ messageId: 'm1' }),
        description: 'private drawing',
        mime: 'image/png',
      },
      dmScope(bob, 'discord')
    );
    const line = [lineOf('m1', [bare('m1', 'image')])];
    assert.equal(lineDescriptions({ db: env.db, ctx: group, lines: line }).size, 0);
    assert.equal(
      lineDescriptions({ db: env.db, ctx: dmContext(bob, 'discord'), lines: line }).get('m1#m0'),
      'private drawing'
    );
  });
});

const message = (attachments: Array<Record<string, unknown>>, native = 'pic') => ({
  iface: 'discord',
  at: AT,
  message: {
    id: native,
    at: AT,
    content: '',
    author: { id: 'u-alice' },
    attachments,
    links: [{ id: 'l1', kind: 'link' }],
    stickers: [],
  },
  conversation: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'c1' },
});

const storedExtra = (env: Env, sourceId: string | undefined) =>
  JSON.parse(String(env.db.prepare('SELECT extra FROM sources WHERE id = ?').get(sourceId ?? '')?.extra)) as Record<
    string,
    unknown
  >;

test('an observed message keeps its attachment ids in the order of its media kinds', () => {
  withBare((env) => {
    const envelope = observationOf(
      message([{ id: 'a1', kind: 'image' }, { kind: 'image' }, { id: 'a3', kind: 'video' }])
    );
    assert.ok(envelope);
    assert.deepEqual(envelope.media, ['image', 'image', 'video', 'link']);
    const written = observe(env.handle, envelope, { now: () => AT });
    assert.equal(written.ok, true);
    assert.deepEqual(sourceAttachmentIds(storedExtra(env, written.sourceId)), ['a1', null, 'a3']);
  });
});

test('a message with no attachment id stores none, and a row with no ids reads as an empty list', () => {
  const envelope = observationOf(message([{ kind: 'image' }]));
  assert.ok(envelope);
  assert.equal(envelope.extra, undefined);
  assert.deepEqual(sourceAttachmentIds({}), []);
});

test('the echo of a line stored before it brings the attachment ids and leaves the rest of the row', () => {
  withBare((env) => {
    const id = messageSourceId('discord', 'pic', 1, 'seen');
    env.say({ native: 'pic', at: AT, text: '', place: GENERAL, extra: JSON.stringify({ v: 1 }) });
    env.db
      .prepare('UPDATE sources SET authority_id = ?, native_kind = ? WHERE id = ?')
      .run('discord/global', 'message', id);
    const envelope = observationOf(message([{ id: 'a1', kind: 'image' }]));
    assert.ok(envelope);
    const written = observe(env.handle, envelope, { now: () => AT });
    assert.equal(written.ok, true);
    if (written.sourceId === id) {
      const extra = storedExtra(env, id);
      assert.equal(extra.v, 1);
      assert.deepEqual(sourceAttachmentIds(extra), ['a1']);
    } else assert.fail('the echo did not find the stored line');
  });
});

// ---------- the stems of a description ----------

const WORD = 'ποδηλατο';
const SETTINGS = { ...dbSettings({})!, followMessages: 0 };
const pictureExtra = (...ids: Array<string>) => JSON.stringify({ extra: { attachmentIds: ids } });
const findWord = (env: Env, ctx: unknown = group) =>
  search(env.db, { ctx, plan: { forms: [WORD] }, now: AT, settings: SETTINGS }).hits.map((hit) => hit.messageId);
const stemsAndText = (env: Env, id: string) => env.db.prepare('SELECT stems, text FROM sources WHERE id = ?').get(id);

test('a word of a known description finds a picture-only line, and its text stays empty', () => {
  withEnv((env) => {
    const id = env.say({ native: 'pic', at: AT, text: '', place: GENERAL, extra: pictureExtra('a1') });
    mediaRow(env, 'media:attachment:a1', { kind: 'attachment', nativeRef: 'a1', description: `ενα κοκκινο ${WORD}` });
    env.stem();
    assert.deepEqual(findWord(env), ['pic']);
    assert.equal(stemsAndText(env, id)?.text, '');
  });
});

test('a description written after its line was stamped makes the line findable, and keeps the words of its text', () => {
  withEnv((env) => {
    env.say({ native: 'pic', at: AT, text: 'κοιτα αυτο', place: GENERAL, extra: pictureExtra('a1') });
    env.stem();
    assert.deepEqual(findWord(env), []);
    applyUnitWrite(env.handle, {
      op: 'lines',
      now: AT,
      key: placeCollection('versions', SERVER, { selector: { versionKind: 'media', itemId: 'a1' } }),
      lines: [{ op: 'described', id: 'v1', entry: { text: `ενα κοκκινο ${WORD}`, ts: AT } }],
    });
    assert.deepEqual(findWord(env), ['pic']);
    const again = search(env.db, { ctx: group, plan: { forms: ['κοιτα'] }, now: AT, settings: SETTINGS });
    assert.deepEqual(
      again.hits.map((hit) => hit.messageId),
      ['pic']
    );
  });
});

test('a new stemmer stamping every row again keeps the words of the description', () => {
  withEnv((env) => {
    env.say({ native: 'pic', at: AT, text: '', place: GENERAL, extra: pictureExtra('a1') });
    mediaRow(env, 'media:attachment:a1', { kind: 'attachment', nativeRef: 'a1', description: WORD });
    env.stem();
    env.db.exec('UPDATE sources SET stems = NULL');
    fillStems(env.db);
    assert.deepEqual(findWord(env), ['pic']);
  });
});

test('a description under a private audience adds no word to a shared line', () => {
  withEnv((env) => {
    const bob = personId('discord', 'u-bob');
    env.say({ native: 'pic', at: AT, text: '', place: GENERAL, extra: pictureExtra('a1') });
    mediaRow(
      env,
      'media:attachment:a1',
      { kind: 'attachment', nativeRef: 'a1', description: WORD },
      dmScope(bob, 'discord')
    );
    env.stem();
    assert.deepEqual(findWord(env), []);
  });
});

test('a word of a described DM picture is found in that DM and never in a group', () => {
  withEnv((env) => {
    const bob = personId('discord', 'u-bob');
    env.say({
      native: 'pic',
      at: AT,
      text: '',
      place: channelPlaceId('discord', 'dm-bob'),
      scope: dmScope(bob, 'discord'),
      extra: pictureExtra('a1'),
    });
    mediaRow(env, 'media:attachment:a1', { kind: 'attachment', nativeRef: 'a1', description: WORD });
    env.stem();
    assert.deepEqual(findWord(env), []);
    assert.deepEqual(findWord(env, dmContext(bob, 'discord')), ['pic']);
  });
});

test('a line with no attachment id keeps the stems of its text alone', () => {
  withEnv((env) => {
    const id = env.say({ native: 'plain', at: AT, text: 'κοιτα', place: GENERAL });
    mediaRow(env, 'media:attachment:plain', { kind: 'attachment', nativeRef: 'plain', description: WORD });
    env.stem();
    assert.deepEqual(findWord(env), []);
    assert.ok(stemsAndText(env, id)?.stems);
  });
});
