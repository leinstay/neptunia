// Schema v11, stage 7 (spec 2026-10-24-memory-schema-v7, section 7; section 11 on vectors and media): the tiers of
// the stored lines, vector eviction in exactly the owner's classes (raw lines 90 days, then cited, pinned, touched and
// consolidated memory), eviction never touching a text or a vector row's metadata, recall ignoring an evicted vector, a
// touch re-embedding through the embed path (a fake embedder) and expiring, her diary media marked present or missing,
// the dry-run tool, and the migration to v11 keeping every row. Synthetic text only
// (Greek or accented Latin for non-ASCII); the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import {
  checkMedia,
  classify,
  pendingReembed,
  reembedTouched,
  touch,
  applyReembed,
} from '../src/memory/db/index-policy.js';
import { applyMemoryWrite } from '../src/memory/db/session-write.js';
import { search, dbSettings } from '../src/memory/db/recall.js';
import { channelPlaceId, messageSourceId } from '../src/memory/db/ids.ts';
import { dmScope, groupContext, groupScope } from '../src/memory/db/scope.ts';
import { quantize } from '../src/memory/vectors.js';
import { recordChunk } from '../src/memory/chunks.js';
import { main, tableHashes } from '../tools/memory-db.mjs';
import { buildDataDir, guildDir, writeJson } from './fixtures/memory-db/datadir.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const OLD = NOW - 200 * DAY;
const MAIN = channelPlaceId('discord', 'main');
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const config = (db = {}) => ({ recall: { db: { vectorDays: 90, touchDays: 30, vectorEviction: true, ...db } } });
const run = (...argv) => {
  const lines = [];
  const code = main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  return { code, text: lines.join('\n') };
};

/** A database with lines of every tier, each with a vector, and one archive vector. */
function fixture() {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  db.prepare(
    "INSERT INTO places (id, iface, kind, native_id, scope_kind, name) VALUES (?, 'discord', 'channel', 'main', 'group', 'main')"
  ).run(MAIN);
  db.prepare("INSERT INTO accounts (id, iface, native_id) VALUES ('discord:u-alice', 'discord', 'u-alice')").run();
  const say = ({ native, at, text, kind = 'seen', scope = groupScope('discord'), direct = 0, author = 'u-alice' }) => {
    const id = messageSourceId('discord', native, 1, kind);
    db.prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, recorded_at, text, direct, scope_kind, scope_iface, scope_dm)
      VALUES (?, ?, 'discord', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      kind,
      native,
      MAIN,
      kind === 'said' ? null : `discord:${author}`,
      new Date(at).toISOString(),
      new Date(at).toISOString(),
      text,
      direct,
      scope.scope_kind,
      scope.scope_iface,
      scope.scope_dm
    );
    return id;
  };
  const vector = (native, values, { chunk = `record:${native}:1`, sourceIds = [native] } = {}) => {
    const source = db.prepare('SELECT rowid FROM sources WHERE native_id = ?').get(native);
    const { bytes, scale, norm } = quantize(values);
    db.prepare(
      `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at, scope_kind, scope_iface, scope_dm)
      VALUES (?, ?, ?, 'test/embedder', ?, ?, ?, ?, ?, ?, 'group', 'discord', NULL)`
    ).run(
      source?.rowid ?? null,
      native,
      chunk,
      values.length,
      scale,
      norm,
      bytes,
      JSON.stringify({ kind: 'record', sourceIds }),
      new Date(NOW).toISOString()
    );
  };
  const ids = {
    plain: say({ native: 'm-plain', at: OLD, text: 'ένα παλιό μήνυμα για καφέ' }),
    before: say({ native: 'm-before', at: OLD - 1000, text: 'πριν από αυτό' }),
    cited: say({ native: 'm-cited', at: OLD, text: 'she remembers this café' }),
    self: say({ native: 'm-self', at: OLD, text: 'my own old line', kind: 'said' }),
    dm: say({ native: 'm-dm', at: OLD, text: 'a private old line', scope: dmScope('u-alice', 'discord') }),
    addressed: say({ native: 'm-addressed', at: OLD, text: 'hey, you', direct: 1 }),
    captured: say({ native: 'm-captured', at: OLD, text: 'a foreign post' }),
    pinned: say({ native: 'm-pinned', at: OLD, text: 'a pinned line' }),
    recent: say({ native: 'm-recent', at: NOW - 10 * DAY, text: 'a recent line' }),
  };
  db.prepare(
    "INSERT INTO claims (id, subject_kind, subject_id, kind, text) VALUES ('c1', 'person', 'person:discord:u-alice', 'fact', 'likes café')"
  ).run();
  db.prepare("INSERT INTO claim_sources (claim_id, source_id, position) VALUES ('c1', ?, 0)").run(ids.cited);
  db.prepare(
    `INSERT INTO capture_bundles (id, anchor_source_id, place_id, reason, policy_version, coverage, created_at) VALUES ('b1', ?, ?, 'mention', 1, '{"state":"complete"}', ?)`
  ).run(ids.captured, MAIN, new Date(NOW).toISOString());
  db.prepare("INSERT INTO capture_members (bundle_id, source_id, role, added_at) VALUES ('b1', ?, 'anchor', ?)").run(
    ids.captured,
    new Date(NOW).toISOString()
  );
  db.prepare(
    "INSERT INTO index_policy (node_id, tier, reason, pinned, evaluated_at) VALUES (?, 'a', 'pinned', 1, ?)"
  ).run(`source:${ids.pinned}`, new Date(NOW).toISOString());
  vector('m-plain', [1, 0, 0, 0], { sourceIds: ['m-before', 'm-plain'] });
  for (const [native, values] of [
    ['m-cited', [0, 1, 0, 0]],
    ['m-self', [0, 0, 1, 0]],
    ['m-dm', [0, 0, 0, 1]],
    ['m-addressed', [1, 1, 0, 0]],
    ['m-captured', [0, 1, 1, 0]],
    ['m-pinned', [0, 0, 1, 1]],
    ['m-recent', [1, 0, 1, 0]],
  ])
    vector(native, values);
  vector('none', [1, 0, 0, 1], { chunk: 'archive:ep-1:1' });
  return { handle, db, ids };
}

const vectorOf = (db, native) =>
  db
    .prepare(
      'SELECT v.rowid AS rowid, v.* FROM vectors v JOIN sources s ON s.rowid = v.source_rowid WHERE s.native_id = ?'
    )
    .get(native);
const metaOf = (row) => ({
  chunk_key: row.chunk_key,
  model: row.model,
  dims: row.dims,
  norm: row.norm,
  scale: row.scale,
  context: row.context,
  source_rowid: row.source_rowid,
  occurred_at: row.occurred_at,
});

test('index policy: the tier of every line; a dry run writes nothing', () => {
  const { handle, db, ids } = fixture();
  try {
    const hashes = tableHashes(db);
    const dry = classify(handle, { now: NOW, config: config() });
    assert.deepEqual(tableHashes(db), hashes, 'a dry run changes nothing');
    assert.deepEqual(dry.tiers, { a: 5, b: 3, c: 1 });
    assert.deepEqual(dry.reasons, { addressed: 1, capture: 1, cited: 1, dm: 1, pinned: 1, seen: 3, self: 1 });
    assert.equal(
      dry.vectors.evict,
      5,
      'plain, self, dm, addressed and captured lines are past 90 days and in no keep class'
    );
    classify(handle, { now: NOW, config: config(), apply: true });
    const tier = (id) => db.prepare('SELECT tier FROM sources WHERE id = ?').get(id).tier;
    assert.equal(tier(ids.self), 'a');
    assert.equal(tier(ids.dm), 'a');
    assert.equal(tier(ids.addressed), 'a');
    assert.equal(tier(ids.cited), 'a');
    assert.equal(tier(ids.pinned), 'a');
    assert.equal(tier(ids.captured), 'c');
    assert.equal(tier(ids.plain), 'b');
    const policy = db
      .prepare('SELECT tier, reason, pinned FROM index_policy WHERE node_id = ?')
      .get(`source:${ids.pinned}`);
    assert.deepEqual({ ...policy }, { tier: 'a', reason: 'pinned', pinned: 1 }, 'a pin is kept');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE bytes IS NULL').get().n,
      0,
      'without evict no vector is touched'
    );
  } finally {
    handle.close();
  }
});

test('index policy: eviction drops only the bytes, keeps every text, row and metadata, and skips the keep classes; recall ignores an evicted vector', () => {
  const { handle, db } = fixture();
  try {
    const texts = db
      .prepare('SELECT id, text, stems, revision FROM sources ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
    const before = new Map(
      db
        .prepare('SELECT rowid, * FROM vectors')
        .all()
        .map((row) => [row.rowid, metaOf(row)])
    );
    const ctx = groupContext('discord');
    const query = (vector) =>
      search(db, {
        ctx,
        plan: { forms: ['ζζζζ'], who: [], from: null, to: null },
        vector,
        now: NOW,
        settings: { ...dbSettings({}), gateShare: 0, minMeaning: 0.9 },
      }).hits.map((hit) => hit.messageId);
    assert.deepEqual(query([1, 0, 0, 0]), ['m-plain'], 'before: found by meaning');
    const done = classify(handle, { now: NOW, config: config(), apply: true, evict: true });
    assert.equal(done.evictedNow, 5);
    assert.deepEqual(
      db
        .prepare('SELECT id, text, stems, revision FROM sources ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      texts,
      'no text is touched'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n, before.size, 'no vector row is deleted');
    for (const row of db.prepare('SELECT rowid, * FROM vectors').all())
      assert.deepEqual(metaOf(row), before.get(row.rowid), 'model, dims, norm, scale and context stay');
    const evicted = (native) =>
      vectorOf(db, native).bytes === null && typeof vectorOf(db, native).evicted_at === 'string';
    for (const native of ['m-plain', 'm-self', 'm-dm', 'm-addressed', 'm-captured']) assert.ok(evicted(native), native);
    for (const native of ['m-cited', 'm-pinned', 'm-recent'])
      assert.ok(!evicted(native) && vectorOf(db, native).bytes !== null, `${native} kept`);
    assert.ok(
      db.prepare("SELECT bytes FROM vectors WHERE chunk_key = 'archive:ep-1:1'").get().bytes !== null,
      'consolidated memory is always kept'
    );
    assert.deepEqual(query([1, 0, 0, 0]), [], 'after: an evicted vector never competes');
    assert.deepEqual(query([0, 1, 0, 0]), ['m-cited'], 'a kept vector still does');
    // A second run evicts nothing more; a vector the sync filled again (its month rewritten) is evicted again.
    assert.equal(classify(handle, { now: NOW, config: config(), apply: true, evict: true }).evictedNow, 0);
    db.prepare('UPDATE vectors SET bytes = ? WHERE rowid = ?').run(
      Buffer.from([1, 2, 3, 4]),
      vectorOf(db, 'm-plain').rowid
    );
    assert.equal(classify(handle, { now: NOW, config: config(), apply: true, evict: true }).evictedNow, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

test('index policy: a touch brings a vector back through the embed path for touchDays, then it is evicted again', async () => {
  const { handle, db, ids } = fixture();
  try {
    classify(handle, { now: NOW, config: config(), apply: true, evict: true });
    assert.equal(touch(handle, [ids.plain, 'src:missing'], { now: NOW, config: config() }), 1);
    const policy = db.prepare('SELECT * FROM index_policy WHERE node_id = ?').get(`source:${ids.plain}`);
    assert.equal(policy.reason, 'touch');
    assert.equal(policy.expires_at, new Date(NOW + 30 * DAY).toISOString());
    const pending = pendingReembed(db, { now: NOW });
    assert.deepEqual(
      pending.map((row) => row.source_id),
      [ids.plain]
    );
    const texts = [];
    const embed = async (inputs, { purpose }) => {
      texts.push({ inputs, purpose });
      return inputs.map(() => Float32Array.from([1, 0, 0, 0]));
    };
    const write = async (update) => applyMemoryWrite(handle, update);
    const chunkOf = (line, context) => recordChunk(line, context, { nameOf: () => 'Ada', selfName: 'Her' }).text;
    const done = await reembedTouched({
      db,
      write,
      embed,
      config: config({ reembed: true }),
      now: NOW,
      quantize,
      model: 'test/embedder',
      chunkOf,
    });
    assert.deepEqual(done, { pending: 1, embedded: 1, written: 1, skipped: 0 });
    assert.equal(texts[0].purpose, 'memory-reembed');
    assert.equal(
      texts[0].inputs[0],
      'Ada: πριν από αυτό\nAda: ένα παλιό μήνυμα για καφέ',
      'the line with the line before it, as its vector was made'
    );
    const back = vectorOf(db, 'm-plain');
    assert.ok(back.bytes !== null);
    assert.equal(back.evicted_at, null);
    assert.equal(back.model, 'test/embedder');
    // Kept while the touch lasts.
    assert.equal(classify(handle, { now: NOW + 10 * DAY, config: config(), apply: true, evict: true }).evictedNow, 0);
    assert.ok(vectorOf(db, 'm-plain').bytes !== null);
    // Another model's vector is left evicted; nothing is embedded for it.
    touch(handle, [ids.self], { now: NOW + 10 * DAY, config: config() });
    const other = await reembedTouched({
      db,
      write,
      embed,
      config: config({ reembed: true }),
      now: NOW + 10 * DAY,
      quantize,
      model: 'other/model',
      chunkOf,
    });
    assert.deepEqual(other, { pending: 1, embedded: 0, written: 0, skipped: 1 });
    // The touch expires: the next run evicts it again.
    assert.equal(classify(handle, { now: NOW + 31 * DAY, config: config(), apply: true, evict: true }).evictedNow, 1);
    assert.equal(vectorOf(db, 'm-plain').bytes, null);
    assert.notEqual(
      db.prepare('SELECT reason FROM index_policy WHERE node_id = ?').get(`source:${ids.plain}`).reason,
      'touch'
    );
    // A refill of a row that is no longer evicted writes nothing.
    assert.deepEqual(
      applyReembed(handle, {
        rows: [{ rowid: vectorOf(db, 'm-cited').rowid, bytes: new Uint8Array([9, 9, 9, 9]), scale: 1, norm: 1 }],
      }),
      { written: 0 }
    );
  } finally {
    handle.close();
  }
});

test('media availability: her diary media is present or missing by its file; foreign media stays unknown', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-media-'));
  const handle = openMemoryDb(':memory:');
  try {
    fs.mkdirSync(path.join(root, 'media', 'diary'), { recursive: true });
    fs.writeFileSync(path.join(root, 'media', 'diary', 'd-1-1.png'), Buffer.alloc(10));
    fs.writeFileSync(path.join(root, 'media', 'diary', 'd-1-2.png'), Buffer.alloc(3));
    const insert = handle.db.prepare(
      'INSERT INTO media (id, kind, owner, path, native_ref, sha1, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insert.run('m1', 'diary', 'd-1', 'media/diary/d-1-1.png', null, 'abc', 10);
    insert.run('m2', 'diary', 'd-1', 'media/diary/d-1-2.png', null, 'abd', 99);
    insert.run('m3', 'diary', 'd-2', 'media/diary/d-2-1.png', null, 'abe', 5);
    insert.run('m4', 'picture', 'msg-1', null, 'https://cdn.example/x.png', null, null);
    const dry = checkMedia(handle, { dataDir: root });
    assert.deepEqual(dry, { present: 1, missing: 2, unknown: 1, changed: 3 });
    assert.equal(
      handle.db.prepare("SELECT COUNT(*) AS n FROM media WHERE availability = 'unknown'").get().n,
      4,
      'a check without apply writes nothing'
    );
    checkMedia(handle, { dataDir: root, apply: true });
    const state = Object.fromEntries(
      handle.db
        .prepare('SELECT id, availability FROM media')
        .all()
        .map((row) => [row.id, row.availability])
    );
    assert.deepEqual(state, { m1: 'present', m2: 'missing', m3: 'missing', m4: 'unknown' });
    assert.equal(
      handle.db.prepare("SELECT sha1 FROM media WHERE id = 'm4'").get().sha1,
      null,
      'a foreign hash may be null'
    );
    assert.deepEqual(checkMedia(handle, { dataDir: root, apply: true }).changed, 0);
  } finally {
    handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- the migration to v11, and the tools ----------

function importedAtV10() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-v11-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const file = path.join(root, 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 10) });
  assert.equal(seedUnits(old, data, { log: quiet, now: () => NOW }).errors, 0);
  assert.equal(schemaVersion(old.db), 10);
  old.close();
  return { root, data, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('v11: the migration keeps every row; rows the database owns survive a rewrite of the units; foreign keys and integrity hold', () => {
  const env = importedAtV10();
  try {
    const handle = openMemoryDb(env.file);
    assert.equal(schemaVersion(handle.db), MIGRATIONS.length);
    assert.equal(handle.db.prepare("SELECT COUNT(*) AS n FROM media WHERE availability <> 'unknown'").get().n, 0);
    assert.equal(
      handle.db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE evicted_at IS NOT NULL OR bytes IS NULL').get().n,
      0
    );
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS n FROM sources WHERE tier IS NOT NULL').get().n, 0);
    assert.deepEqual(handle.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(handle.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    // Rows the database owns (a wake run, a tier) survive a rewrite of the units.
    applyMemoryWrite(handle, { kind: 'wake', op: 'start', run: { id: 'run-1', kind: 'heartbeat', startedAt: NOW } });
    classify(handle, { now: NOW, config: config({ vectorEviction: false }), apply: true });
    handle.close();
    const file = path.join(guildDir(env.data), 'diary.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.posts.push({
      at: 1799000000000,
      kind: 'day',
      gist: 'new',
      picture: null,
      messageIds: ['5199999999999999'],
      search: null,
      itemId: 'entry-new',
    });
    writeJson(file, value);
    const again = openMemoryDb(env.file);
    assert.equal(seedUnits(again, env.data, { log: quiet, now: () => NOW + 3_600_000 }).errors, 0);
    assert.equal(again.db.prepare("SELECT status FROM wake_runs WHERE id = 'run-1'").get().status, 'running');
    assert.ok(again.db.prepare('SELECT COUNT(*) AS n FROM index_policy').get().n > 0);
    assert.deepEqual(again.db.prepare('PRAGMA foreign_key_check').all(), []);
    again.close();
  } finally {
    env.done();
  }
});

test('tools: index-policy prints what it would evict and changes nothing without --apply; media-check reports the counts', () => {
  const env = importedAtV10();
  try {
    openMemoryDb(env.file).close();
    const reader = openMemoryDb(env.file, { readOnly: true });
    const hashes = tableHashes(reader.db);
    reader.close();
    const dry = run('index-policy', '--db', env.file, '--days', '1');
    assert.equal(dry.code, 0, dry.text);
    const would = Number(/would evict: (\d+) \(dry run/.exec(dry.text)?.[1]);
    assert.ok(would >= 1, dry.text);
    const after = openMemoryDb(env.file, { readOnly: true });
    assert.deepEqual(tableHashes(after.db), hashes, 'the dry run wrote nothing');
    after.close();
    const media = run('media-check', '--db', env.file, '--data', env.data);
    assert.equal(media.code, 0, media.text);
    assert.match(media.text, /media: present 0, missing 0/);
    const applied = run('index-policy', '--db', env.file, '--days', '1', '--apply');
    assert.equal(applied.code, 0, applied.text);
    assert.match(applied.text, new RegExp(`evicted now: ${would}\\b`));
  } finally {
    env.done();
  }
});
