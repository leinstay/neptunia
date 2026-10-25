// Schema v10, stage 4 (spec 2026-10-24-memory-schema-v7, section 11 item 4): publications and grants. An internal draft
// never becomes publishable without a grant bound to its content hash and destination; an edit voids the grant; a grant
// for another destination does not count; a crash between queueing and sending sends once; the diary's mirrors become
// sent publications in the migration (a fixture of 51 mirrors) and on every later write of the diary, idempotently, and
// a rewrite keeps the row. Synthetic text only (Greek or accented Latin for non-ASCII); the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.js';
import { V10_TABLES } from '../src/memory/db/schema.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { insertRows } from '../src/memory/db/rows.js';
import {
  contentHash, deriveAllMirrorPublications, grantPublication, markSent, markUnknown, mirrorPublicationRow, preparePublication, publicationKey,
  publicationOf, recheck, reconcile, revokeGrant, unsettled,
} from '../src/memory/db/publish.js';
import { issueContext } from '../src/memory/db/scope.js';
import { tableHashes } from '../tools/memory-db.mjs';
import { CHANNEL, buildDataDir, guildDir, writeJson, writeLines } from './fixtures/memory-db/datadir.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;
const GENERAL = 'discord:channel:c-general';
const OTHER = 'discord:channel:c-other';

/** A database with two group places and one diary entry. */
function fixture() {
  const handle = openMemoryDb(':memory:');
  insertRows(handle.db, {
    places: [
      { id: GENERAL, iface: 'discord', kind: 'channel', native_id: 'c-general', parent_id: null, scope_kind: 'group', name: 'general' },
      { id: OTHER, iface: 'discord', kind: 'channel', native_id: 'c-other', parent_id: null, scope_kind: 'group', name: 'other' },
    ],
    diary: [{ id: 'entry-1', at_ms: NOW, kind: 'day', gist: 'a quiet day', text: null, scope_kind: 'group', scope_iface: 'discord', scope_dm: null }],
  }, { log: quiet, at: new Date(NOW).toISOString() });
  let n = 0;
  const outward = (destination) => issueContext({ kind: 'group', destination, now: () => NOW, newId: () => `ctx:out:${(n += 1)}` });
  const internal = () => issueContext({ kind: 'internal', now: () => NOW, newId: () => `ctx:in:${(n += 1)}` });
  return { handle, db: handle.db, outward, internal };
}

const DRAFT = 'Σήμερα ήταν ήσυχα. A private detail she never cited.';

test('publish: an internal draft never becomes publishable without a grant; nothing is written on a refusal', () => {
  const { handle, db, outward, internal } = fixture();
  try {
    const before = count(db, 'SELECT COUNT(*) AS n FROM publications');
    const contexts = count(db, 'SELECT COUNT(*) AS n FROM execution_contexts');
    const refusedInternal = preparePublication(handle, { context: outward(GENERAL), rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, producedIn: internal(), now: NOW });
    assert.deepEqual(refusedInternal, { ok: false, code: 'no-grant' });
    // A text with no named origin is treated as internal (fail closed).
    assert.deepEqual(preparePublication(handle, { context: outward(GENERAL), rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, now: NOW }), { ok: false, code: 'no-grant' });
    // A text produced for another destination needs a grant too.
    assert.deepEqual(preparePublication(handle, { context: outward(GENERAL), rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, producedIn: outward(OTHER), now: NOW }), { ok: false, code: 'no-grant' });
    // The context must be outward and for this destination.
    assert.deepEqual(preparePublication(handle, { context: internal(), rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, producedIn: internal(), now: NOW }), { ok: false, code: 'not-outward' });
    assert.deepEqual(preparePublication(handle, { context: outward(OTHER), rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, producedIn: internal(), now: NOW }), { ok: false, code: 'destination-mismatch' });
    assert.deepEqual(preparePublication(handle, { context: { mode: 'outward', destination: GENERAL }, rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, now: NOW }), { ok: false, code: 'not-outward' }, 'a context the core did not issue (no id) is refused');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM publications'), before, 'no row on any refusal');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM execution_contexts'), contexts, 'no context recorded on a refusal');

    // A grant for another destination does not count; a revoked one neither.
    const elsewhere = grantPublication(handle, { rowKind: 'diary', rowId: 'entry-1', hash: contentHash(DRAFT), destinations: [OTHER], approvedBy: 'person:owner', now: NOW });
    assert.equal(preparePublication(handle, { context: outward(GENERAL), rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, producedIn: internal(), now: NOW }).code, 'no-grant');
    const granted = grantPublication(handle, { rowKind: 'diary', rowId: 'entry-1', hash: contentHash(DRAFT), destinations: [GENERAL], approvedBy: 'person:owner', reason: 'shown to the owner', now: NOW });
    assert.equal(revokeGrant(handle, granted, { now: NOW + 1 }), true);
    assert.equal(revokeGrant(handle, granted, { now: NOW + 2 }), false, 'revoked once');
    assert.equal(preparePublication(handle, { context: outward(GENERAL), rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, producedIn: internal(), now: NOW }).code, 'no-grant');

    // An unrevoked grant for this hash and this destination lets it through, and the row names the grant.
    const good = grantPublication(handle, { rowKind: 'diary', rowId: 'entry-1', hash: contentHash(DRAFT), destinations: [GENERAL, OTHER], approvedBy: 'person:owner', now: NOW + 3 });
    const done = preparePublication(handle, { context: outward(GENERAL), rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, producedIn: internal(), now: NOW });
    assert.equal(done.ok, true);
    assert.equal(done.publication.status, 'queued');
    assert.equal(done.publication.grant_id, good);
    assert.notEqual(done.publication.grant_id, elsewhere);
    assert.equal(done.publication.content_hash, contentHash(DRAFT));
    assert.equal(done.publication.rendered, DRAFT);
    assert.equal(done.publication.idempotency_key, publicationKey('diary', 'entry-1', GENERAL));
    // A queued internal draft is seen by no outward context in the graph.
    const access = db.prepare("SELECT audience_id FROM node_access WHERE node_id = ? AND evidence_id = node_id").all(`publication:${done.publication.id}`).map((row) => row.audience_id);
    assert.deepEqual(access, ['aud:internal']);
    // A text produced in a context for this very destination needs no grant.
    const own = preparePublication(handle, { context: outward(OTHER), rowKind: 'diary', rowId: 'entry-1', rendered: 'Ένα κείμενο για εδώ.', destination: OTHER, producedIn: outward(OTHER), now: NOW });
    assert.equal(own.ok, true);
    assert.equal(own.publication.grant_id, null);
    // Grants and publications are never deleted, a grant's binding never changes.
    assert.throws(() => db.prepare('DELETE FROM publications').run(), /never deleted/);
    assert.throws(() => db.prepare('DELETE FROM publication_grants').run(), /never deleted/);
    assert.throws(() => db.prepare('UPDATE publication_grants SET destinations = ? WHERE id = ?').run(JSON.stringify([OTHER]), good), /immutable/);
    assert.throws(() => db.prepare('UPDATE publication_grants SET revoked_at = ? WHERE id = ?').run('2026-10-25T00:00:00.000Z', granted), /stays revoked/);
  } finally {
    handle.close();
  }
});

test('publish: an edit changes the hash and voids the grant; the stored text never changes; a revocation is seen at send time', () => {
  const { handle, db, outward, internal } = fixture();
  try {
    grantPublication(handle, { rowKind: 'diary', rowId: 'entry-1', hash: contentHash(DRAFT), destinations: [GENERAL], approvedBy: 'person:owner', now: NOW });
    const edited = `${DRAFT} One more line, added after the grant.`;
    assert.notEqual(contentHash(edited), contentHash(DRAFT));
    assert.deepEqual(preparePublication(handle, { context: outward(GENERAL), rowKind: 'diary', rowId: 'entry-1', rendered: edited, destination: GENERAL, producedIn: internal(), now: NOW }), { ok: false, code: 'no-grant' });
    const done = preparePublication(handle, { context: outward(GENERAL), rowKind: 'diary', rowId: 'entry-1', rendered: DRAFT, destination: GENERAL, producedIn: internal(), now: NOW });
    assert.equal(done.ok, true);
    assert.throws(() => db.prepare('UPDATE publications SET rendered = ?, content_hash = ? WHERE id = ?').run(edited, contentHash(edited), done.publication.id), /keeps its content/);
    // At send time the context is checked again, and so is the grant.
    const ctx = outward(GENERAL);
    assert.deepEqual(recheck(handle, done.publication.id, ctx), { ok: true });
    assert.deepEqual(recheck(handle, done.publication.id, outward(OTHER)), { ok: false, code: 'destination-mismatch' });
    assert.deepEqual(recheck(handle, done.publication.id, internal()), { ok: false, code: 'not-outward' });
    revokeGrant(handle, done.publication.grant_id, { now: NOW + 5 });
    assert.deepEqual(recheck(handle, done.publication.id, ctx), { ok: false, code: 'grant-revoked' });
  } finally {
    handle.close();
  }
});

test('publish: a crash between queued and sent sends once (the same key returns the first row; unknown is reconciled, never resent)', () => {
  const { handle, db, outward } = fixture();
  try {
    const sent = [];
    const adapter = {
      send(text) { sent.push(text); return [{ authority: 'discord/global', kind: 'message', key: `m-${sent.length}` }]; },
      find(key) { return sent.length > 0 && key === publicationKey('diary', 'entry-1', GENERAL) ? [{ authority: 'discord/global', kind: 'message', key: 'm-1' }] : null; },
    };
    const text = 'Une journée calme, écrite pour ici.';
    // The sender: queue, re-check, send; a reused row that is settled is never sent again.
    const sendOnce = (ctx) => {
      const done = preparePublication(handle, { context: ctx, rowKind: 'diary', rowId: 'entry-1', rendered: text, destination: GENERAL, producedIn: ctx, now: NOW });
      assert.equal(done.ok, true);
      if (done.publication.status !== 'queued' || !recheck(handle, done.publication.id, ctx).ok) return done.publication;
      return { receipts: adapter.send(done.publication.rendered), id: done.publication.id };
    };
    const first = sendOnce(outward(GENERAL));
    assert.equal(sent.length, 1);
    // The process dies here, before markSent. After the restart the row is still queued: it is marked unknown and
    // reconciled against the interface before anything is sent.
    const pending = unsettled(handle);
    assert.deepEqual(pending.map((row) => row.id), [first.id]);
    for (const row of pending) {
      markUnknown(handle, row.id);
      reconcile(handle, row.id, adapter.find(row.idempotency_key), { now: NOW + 60_000 });
    }
    const after = publicationOf(handle, first.id);
    assert.equal(after.status, 'sent');
    assert.deepEqual(after.receipts, [{ authority: 'discord/global', kind: 'message', key: 'm-1' }]);
    // The turn asks again: the same key returns the first row, which is sent, so nothing goes out.
    const again = preparePublication(handle, { context: outward(GENERAL), rowKind: 'diary', rowId: 'entry-1', rendered: text, destination: GENERAL, producedIn: outward(GENERAL), now: NOW + 120_000 });
    assert.equal(again.reused, true);
    assert.equal(again.publication.id, first.id);
    sendOnce(outward(GENERAL));
    assert.equal(sent.length, 1, 'sent once');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM publications'), 1);
    // A repeat of markSent changes nothing; a reconcile with nothing found fails the row instead of sending it.
    assert.equal(markSent(handle, first.id, [{ authority: 'discord/global', kind: 'message', key: 'other' }]).receipts[0].key, 'm-1');
    const lost = preparePublication(handle, { context: outward(OTHER), rowKind: 'diary', rowId: 'entry-1', rendered: 'Autre.', destination: OTHER, producedIn: outward(OTHER), now: NOW });
    markUnknown(handle, lost.publication.id);
    assert.equal(reconcile(handle, lost.publication.id, null).status, 'failed');
    assert.deepEqual(unsettled(handle), []);
    // A sent publication is seen in its destination's audience.
    const access = db.prepare('SELECT audience_id FROM node_access WHERE node_id = ? AND evidence_id = node_id').all(`publication:${first.id}`).map((row) => row.audience_id);
    assert.deepEqual(access, ['aud:group:discord']);
  } finally {
    handle.close();
  }
});

// ---------- the diary's mirrors ----------

const POSTS = 51;
const messageOf = (n) => `5100000000000000${String(n).padStart(2, '0')}`;

/** A data directory whose diary has 51 mirrored posts (the said lines of the first ten in the record), imported at v9. */
function importedAtV9() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-v10-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const posts = Array.from({ length: POSTS }, (_, n) => ({ at: 1792000000000 + n * 86_400_000, kind: 'day', gist: `day ${n}`, picture: null, messageIds: [messageOf(n)], search: null, itemId: `entry-${n}` }));
  writeJson(path.join(guildDir(data), 'diary.json'), { updatedAt: 1792000000000, posts });
  writeLines(path.join(guildDir(data), 'record', '2026-10', '2026-10-22.jsonl'), Array.from({ length: 10 }, (_, n) => ({
    v: 1, id: `r-said-${n}`, kind: 'said', messageId: messageOf(n), revision: 1, occurredAt: '2026-10-22T09:00:00.000Z', recordedAt: '2026-10-22T09:00:01.000Z',
    guildId: '300000000000000001', scope: { channel: CHANNEL }, text: `Ημερολόγιο ${n}`, participants: [],
  })));
  const file = path.join(root, 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 9) });
  assert.equal(seedUnits(old, data, { log: quiet, now: () => NOW }).errors, 0);
  assert.equal(schemaVersion(old.db), 9);
  // The diary media job has fetched the text of the first twenty posts.
  for (let n = 0; n < 20; n += 1) old.db.prepare('UPDATE diary SET text = ? WHERE id = ?').run(`Ημερολόγιο ${n}`, `entry-${n}`);
  old.close();
  return { root, data, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const publicationsOf = (db) => db.prepare('SELECT * FROM publications ORDER BY id').all().map((row) => ({ ...row }));

test('v10 migration: 51 mirrors become sent publications with their text hashes and receipts, projected; keys, foreign keys and integrity', () => {
  const env = importedAtV9();
  const handle = openMemoryDb(env.file);
  const { db } = handle;
  try {
    assert.equal(schemaVersion(db), MIGRATIONS.length);
    assert.ok(MIGRATIONS.length >= 10);
    for (const table of V10_TABLES) assert.ok(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const mirrors = count(db, 'SELECT COUNT(*) AS n FROM diary_mirrors WHERE retired_at IS NULL');
    assert.ok(mirrors >= POSTS, 'the fixture has at least the 51 mirrors');
    const rows = publicationsOf(db);
    assert.equal(rows.length, mirrors, 'one publication per mirror');
    for (let n = 0; n < POSTS; n += 1) {
      const row = rows.find((entry) => entry.row_id === `entry-${n}`);
      const mirror = db.prepare("SELECT * FROM diary_mirrors WHERE diary_id = ?").get(`entry-${n}`);
      assert.equal(row.id, mirror.id, 'the publication keeps the mirror id');
      assert.equal(row.status, 'sent');
      assert.equal(row.idempotency_key, `diary:entry-${n}:`);
      assert.deepEqual(JSON.parse(row.receipts), [{ authority: 'discord/global', kind: 'message', key: messageOf(n) }]);
      assert.equal(row.owner_file, mirror.owner_file);
      assert.equal(row.destination_place_id, null, 'the mirrors name no place');
      if (n < 20) {
        assert.equal(row.rendered, `Ημερολόγιο ${n}`);
        assert.equal(row.content_hash, contentHash(`Ημερολόγιο ${n}`));
      } else {
        assert.equal(row.rendered, null, 'no text stored yet: no hash');
        assert.equal(row.content_hash, null);
      }
    }
    // The graph: every publication is published_as from its entry (owned by the publication unit now), and the ten whose
    // line is stored reach it.
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'published_as' AND retired_at IS NULL AND owner_key LIKE 'publications:%'"), mirrors);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'published_as' AND retired_at IS NULL AND owner_key NOT LIKE 'publications:%'"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'publication_source' AND retired_at IS NULL"), 10);
    // Idempotent: deriving every mirror again changes nothing.
    const hashes = tableHashes(db, ['publications', 'graph_edges', 'graph_nodes', 'node_access']);
    handle.transaction(() => deriveAllMirrorPublications(db, { at: '2026-10-25T00:00:00.000Z' }));
    assert.deepEqual(tableHashes(db, ['publications', 'graph_edges', 'graph_nodes', 'node_access']), hashes);
  } finally {
    handle.close();
    env.done();
  }
});

test('v10: a rewrite of the diary keeps the publication; database rows survive', () => {
  const env = importedAtV9();
  try {
    const handle = openMemoryDb(env.file);
    const { db } = handle;
    const before = publicationsOf(db);
    // Rows the database owns: a grant and a prepared publication; the diary's writes never touch them.
    const grant = grantPublication(handle, { rowKind: 'diary', rowId: 'entry-0', hash: contentHash('x'), destinations: [`discord:channel:${CHANNEL}`], approvedBy: 'person:owner', now: NOW });
    const ctx = issueContext({ kind: 'group', destination: `discord:channel:${CHANNEL}`, now: () => NOW, newId: () => 'ctx:out:remap' });
    const own = preparePublication(handle, { context: ctx, rowKind: 'diary', rowId: 'entry-0', rendered: 'Une autre fois.', destination: `discord:channel:${CHANNEL}`, producedIn: ctx, now: NOW });
    assert.equal(own.ok, true);
    // A rewrite: the diary gains a post and a text arrives for an old one (the hash is filled once, then kept).
    db.prepare('UPDATE diary SET text = ? WHERE id = ?').run('Ημερολόγιο 30', 'entry-30');
    const file = path.join(guildDir(env.data), 'diary.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.posts.push({ at: 1799000000000, kind: 'day', gist: 'new', picture: null, messageIds: ['5199999999999999'], search: null, itemId: 'entry-new' });
    writeJson(file, value);
    assert.equal(seedUnits(handle, env.data, { log: quiet, now: () => NOW + 3_600_000 }).errors, 0);
    const after = publicationsOf(db);
    assert.equal(after.length, before.length + 2, 'the new mirror and the prepared one; nothing doubled');
    for (const row of before) {
      const now = after.find((entry) => entry.id === row.id);
      assert.ok(now, `${row.id} kept`);
      assert.equal(now.idempotency_key, row.idempotency_key);
      assert.equal(now.retired_at, null);
      if (row.row_id === 'entry-30') assert.equal(now.content_hash, contentHash('Ημερολόγιο 30'));
      else assert.deepEqual(now, row);
    }
    assert.equal(after.find((entry) => entry.row_id === 'entry-new').status, 'sent');
    assert.equal(publicationOf(handle, own.publication.id).status, 'queued');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM publication_grants WHERE id = ?', grant), 1);
    // A rewrite of the old diary (the new post gone) retires only that mirror's publication.
    value.posts.pop();
    writeJson(file, value);
    assert.equal(seedUnits(handle, env.data, { log: quiet, now: () => NOW + 7_200_000 }).errors, 0);
    assert.ok(publicationsOf(db).find((entry) => entry.row_id === 'entry-new').retired_at, 'the mirror left the file: its publication is retired');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM publications WHERE retired_at IS NOT NULL'), 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    handle.close();
  } finally {
    env.done();
  }
});

test('mirrorPublicationRow: the derived row of a mirror (pure)', () => {
  const row = mirrorPublicationRow({ id: 'mirror:e:discord:', diary_id: 'e', iface: 'discord', place_id: null, native_ids: '["1","2"]', posted_at: null, owner_file: 'guilds/g/diary.json', retired_at: null }, { text: 'Café', placeExists: false, at: '2026-10-24T00:00:00.000Z' });
  assert.deepEqual(row, {
    id: 'mirror:e:discord:', row_kind: 'diary', row_id: 'e', content_hash: contentHash('Café'), rendered: 'Café', destination_place_id: null, context_id: null, grant_id: null,
    status: 'sent', idempotency_key: 'diary:e:', receipts: JSON.stringify([{ authority: 'discord/global', kind: 'message', key: '1' }, { authority: 'discord/global', kind: 'message', key: '2' }]),
    created_at: '2026-10-24T00:00:00.000Z', sent_at: null, owner_file: 'guilds/g/diary.json', retired_at: null,
  });
  assert.equal(contentHash('Café').length, 64);
});
