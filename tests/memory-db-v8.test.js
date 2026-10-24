// Schema v8 (spec 2026-10-24-memory-schema-v7, stage 2): the migration of a database the importer built at v7 (the
// Discord replies backfilled into `source_relations`, the native kind of every line), a relation to an unfetched
// message resolved when it arrives without changing its key, the sync deriving relations for new lines, the lossless
// export and parity after the migration and after a resync, the author combination check of the one writer path, the
// append-only and fixed-key guards, the participant tuple constraints and the people merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.js';
import { V8_TABLES } from '../src/memory/db/schema.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { insertRows } from '../src/memory/db/rows.js';
import { mergePeople } from '../src/memory/db/session-write.js';
import { externalTargetKey, messageSourceId, survivorOf } from '../src/memory/db/ids.js';
import { groupScope } from '../src/memory/db/scope.js';
import { main } from '../tools/memory-db.mjs';
import { buildDataDir, guildDir, seen, writeLines } from './fixtures/memory-db/datadir.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;
const REPLY = '400000000000000011';
const TO_LOST = '400000000000000012';
const LOST = '400000000000000077';
const replyKey = (messageId) => externalTargetKey({ authority: 'discord/global', kind: 'message', key: messageId, generation: 1, revision: null });

/** A data directory with two replies (one to a stored message, one to a message never fetched), imported at v7. */
function importedAtV7() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-v8-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  writeLines(path.join(guildDir(data), 'record', '2026-10', '2026-10-21.jsonl'), [
    seen(REPLY, 1, 'a reply to the first line', { replyTo: '400000000000000001' }),
    seen(TO_LOST, 1, 'a reply to a line nobody fetched', { replyTo: LOST }),
  ]);
  const file = path.join(root, 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 7) });
  assert.equal(syncOnce(old, data, { log: quiet }).errors, 0);
  assert.equal(schemaVersion(old.db), 7);
  old.close();
  return { root, data, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const run = (...argv) => {
  const lines = [];
  const code = main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  return { code, text: lines.join('\n') };
};

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, out);
    else out.push(abs);
  }
  return out;
}
const touch = (file, secondsAhead = 5) => {
  const when = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(file, when, when);
};

const relationsOf = (db) => db.prepare('SELECT id, source_id, predicate, target_key, target_source_id, resolved_at IS NOT NULL AS resolved FROM source_relations ORDER BY source_id').all().map((row) => ({ ...row }));

test('v8 migration: replies backfilled into source_relations, native kinds filled, keys and integrity', () => {
  const env = importedAtV7();
  const handle = openMemoryDb(env.file);
  const { db } = handle;
  try {
    assert.equal(schemaVersion(db), 8);
    assert.equal(MIGRATIONS.length, 8);
    for (const table of V8_TABLES) assert.ok(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sources WHERE iface = 'discord' AND native_id IS NOT NULL AND native_kind IS NOT 'message'"), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM sources WHERE generation <> 1'), 0);

    const relations = relationsOf(db);
    assert.deepEqual(relations.map(({ source_id, predicate, target_key, target_source_id, resolved }) => ({ source_id, predicate, target_key, target_source_id, resolved })), [
      { source_id: messageSourceId(REPLY, 1, 'seen'), predicate: 'replies_to', target_key: replyKey('400000000000000001'), target_source_id: messageSourceId('400000000000000001', 1, 'seen'), resolved: 1 },
      { source_id: messageSourceId(TO_LOST, 1, 'seen'), predicate: 'replies_to', target_key: replyKey(LOST), target_source_id: null, resolved: 0 },
    ], 'one relation per replying line; the stored target is its first revision, the lost one waits');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sources WHERE reply_to IS NOT NULL AND reply_to <> ''"), 2);
  } finally {
    handle.close();
    env.done();
  }
});

test('v8: a relation to an unfetched message resolves when it arrives; the key never changes; a remap and new replies go through the same path', () => {
  const env = importedAtV7();
  const handle = openMemoryDb(env.file);
  const { db } = handle;
  try {
    const before = relationsOf(db);
    // The lost message arrives, and a new reply that the sync (not the migration) derives.
    writeLines(path.join(guildDir(env.data), 'record', '2026-10', '2026-10-22.jsonl'), [
      seen(LOST, 1, 'the line that was missing'),
      seen('400000000000000013', 1, 'another reply', { replyTo: '400000000000000002' }),
    ]);
    assert.equal(syncOnce(handle, env.data, { log: quiet }).errors, 0);
    const after = relationsOf(db);
    const lost = after.find((row) => row.source_id === messageSourceId(TO_LOST, 1, 'seen'));
    const was = before.find((row) => row.source_id === messageSourceId(TO_LOST, 1, 'seen'));
    assert.deepEqual({ ...lost }, { ...was, target_source_id: messageSourceId(LOST, 1, 'seen'), resolved: 1 }, 'same row, same key, now resolved');
    const fresh = after.find((row) => row.source_id === messageSourceId('400000000000000013', 1, 'seen'));
    assert.deepEqual([fresh.target_key, fresh.target_source_id, fresh.resolved], [replyKey('400000000000000002'), messageSourceId('400000000000000002', 1, 'seen'), 1]);
    assert.equal(after.length, 3);

    // Every file read again: the relations stay as they are, none is added twice.
    for (const file of walkFiles(env.data)) touch(file);
    assert.equal(syncOnce(handle, env.data, { log: quiet }).errors, 0);
    assert.deepEqual(relationsOf(db), after);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
    env.done();
  }
});

test('v8: verify stays byte-equal and parity unchanged, after the migration and after a resync', () => {
  const env = importedAtV7();
  try {
    openMemoryDb(env.file).close();
    const first = run('verify', '--data', env.data, '--db', env.file);
    assert.equal(first.code, 0, first.text);
    assert.match(first.text, /verify ok/);
    const parity = run('parity', '--data', env.data, '--db', env.file);
    assert.equal(parity.code, 0, parity.text);
    assert.match(parity.text, /differ 0/);
    for (const file of walkFiles(env.data)) touch(file);
    const handle = openMemoryDb(env.file);
    assert.equal(syncOnce(handle, env.data, { log: quiet }).errors, 0);
    assert.deepEqual(handle.db.prepare('PRAGMA foreign_key_check').all(), []);
    handle.close();
    const again = run('verify', '--data', env.data, '--db', env.file);
    assert.equal(again.code, 0, again.text);
    assert.match(again.text, /verify ok/);
    const parityAgain = run('parity', '--data', env.data, '--db', env.file);
    assert.equal(parityAgain.code, 0, parityAgain.text);
    assert.match(parityAgain.text, /differ 0/);
  } finally {
    env.done();
  }
});

const source = (id, extra = {}) => ({
  id, kind: 'seen', iface: 'discord', native_id: id.slice(4), revision: 1, place_id: null, occurred_at: '2026-10-24T10:00:00.000Z',
  recorded_at: '2026-10-24T10:00:01.000Z', text: 'x', ...groupScope(), ...extra,
});

test('v8 writer: the author combination is checked on every source write; a replaced source keeps its relations', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    db.prepare("INSERT INTO authorities (id, iface, namespace) VALUES ('discord/global', 'discord', 'global') ON CONFLICT DO NOTHING").run();
    db.prepare("INSERT INTO participants (id, authority_id, token_kind, native_token, continuity, recorded_at) VALUES ('participant:p', 'discord/global', 'site_token', 't', 'provider_asserted', 'now')").run();
    assert.throws(() => insertRows(db, { sources: [source('src:1', { author_account: 'discord:1', author_participant: 'participant:p' })] }), { code: 'AUTHOR_COMBINATION' }, 'an account line names no participant');
    assert.throws(() => insertRows(db, { sources: [source('src:2', { author_kind: 'participant', author_account: 'discord:1', author_participant: 'participant:p' })] }), { code: 'AUTHOR_COMBINATION' });
    assert.throws(() => insertRows(db, { sources: [source('src:3', { author_kind: 'account', author_account: null })] }), { code: 'AUTHOR_COMBINATION' });
    assert.throws(() => insertRows(db, { sources: [source('src:4', { kind: 'said', author_participant: 'participant:p' })] }), { code: 'AUTHOR_COMBINATION' }, 'her own line names no participant');
    insertRows(db, { sources: [source('src:5', { author_participant: 'participant:p' })] });
    assert.deepEqual({ ...db.prepare("SELECT author_kind, author_participant, native_kind FROM sources WHERE id = 'src:5'").get() }, { author_kind: 'participant', author_participant: 'participant:p', native_kind: 'message' });
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sources WHERE id IN ('src:1', 'src:2', 'src:3', 'src:4')"), 0, 'a refused row is not written');

    // A line replying to src:5's message, written twice by INSERT OR REPLACE: one relation, still resolved.
    const reply = source('src:6', { native_id: '6', reply_to: '5', author_account: 'discord:1' });
    insertRows(db, { sources: [reply] });
    insertRows(db, { sources: [reply] });
    assert.deepEqual(db.prepare('SELECT source_id, target_source_id FROM source_relations').all().map((row) => ({ ...row })), [{ source_id: 'src:6', target_source_id: 'src:5' }]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

test('v8 guards: relation keys are fixed and never deleted; capture history is append-only; participant tuples are whole', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    db.prepare("INSERT INTO authorities (id, iface, namespace) VALUES ('discord/global', 'discord', 'global') ON CONFLICT DO NOTHING").run();
    insertRows(db, { sources: [source('src:1'), source('src:2', { native_id: '2', reply_to: '9' })] });
    assert.throws(() => db.prepare("UPDATE source_relations SET target_key = 'source:src:1'").run(), /keeps its source/);
    assert.throws(() => db.prepare('DELETE FROM source_relations').run(), /never deleted/);
    db.prepare("INSERT INTO places (id, iface, kind) VALUES ('place:t', 'discord', 'thread')").run();
    db.prepare(`INSERT INTO capture_bundles (id, anchor_source_id, place_id, reason, policy_version, coverage, created_at)
      VALUES ('bundle:1', 'src:1', 'place:t', 'own_line', 1, '{"state":"incomplete"}', 'now')`).run();
    assert.throws(() => db.prepare(`INSERT INTO capture_bundles (id, anchor_source_id, place_id, reason, policy_version, coverage, created_at)
      VALUES ('bundle:2', 'src:1', 'place:t', 'own_line', 1, '{"state":"enough"}', 'now')`).run(), /CHECK/, 'a coverage state outside the four is refused');
    db.prepare("INSERT INTO capture_members (bundle_id, source_id, role, added_at) VALUES ('bundle:1', 'src:1', 'anchor', 'now'), ('bundle:1', 'src:1', 'reply', 'now')").run();
    db.prepare("INSERT INTO capture_events (bundle_id, at, kind, coverage) VALUES ('bundle:1', 'now', 'initial', '{\"state\":\"incomplete\"}')").run();
    assert.throws(() => db.prepare("UPDATE capture_events SET kind = 'watch'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM capture_events').run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM capture_members WHERE role = 'reply'").run(), /never removed/);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM capture_members WHERE source_id = 'src:1'"), 2, 'one source, two roles');

    const participant = (id, kind, scope, token, observation) => db.prepare(`INSERT INTO participants (id, authority_id, scope_place_id, token_kind, native_token, observation_key, continuity, recorded_at)
      VALUES (?, 'discord/global', ?, ?, ?, ?, 'unknown', 'now')`).run(id, scope, kind, token, observation);
    assert.throws(() => participant('participant:a', 'thread_token', null, 'tok', null), /CHECK/, 'a thread token needs its thread');
    assert.throws(() => participant('participant:b', 'display_name', 'place:t', 'Anon', null), /CHECK/, 'a display name is keyed by the observation');
    assert.throws(() => participant('participant:c', 'site_token', 'place:t', 'tok', null), /CHECK/, 'a site token has no thread');
    participant('participant:d', 'thread_token', 'place:t', 'tok', null);
    assert.throws(() => participant('participant:e', 'thread_token', 'place:t', 'tok', null), /UNIQUE/, 'one participant per whole tuple');
    assert.throws(() => db.prepare(`INSERT INTO participant_links (id, participant_id, account_id, person_id, state, recorded_at)
      VALUES ('pl:1', 'participant:d', NULL, NULL, 'proposed', 'now')`).run(), /CHECK/, 'a link names exactly one target');
  } finally {
    handle.close();
  }
});

test('mergePeople: a chain resolves to its final survivor; a cycle, a repeat, her own row and an unknown person are refused', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    for (const id of ['person:a', 'person:b', 'person:c']) db.prepare("INSERT INTO people (id, kind, status) VALUES (?, 'person', 'active')").run(id);
    const now = Date.parse('2026-10-24T12:00:00.000Z');
    assert.deepEqual(mergePeople(handle, 'person:a', 'person:b', { by: 'owner', reason: 'same poster', evidence: ['src:1'], now }), { id: 'merge:person:a', survivor: 'person:b' });
    assert.deepEqual(mergePeople(handle, 'person:b', 'person:c', { by: 'owner', now }), { id: 'merge:person:b', survivor: 'person:c' });
    assert.equal(survivorOf(db, 'person:a'), 'person:c');
    assert.equal(survivorOf(db, 'person:c'), 'person:c');
    assert.equal(db.prepare("SELECT status FROM people WHERE id = 'person:a'").get().status, 'merged_into:person:b');
    const merges = count(db, 'SELECT COUNT(*) AS n FROM people_merges');
    assert.throws(() => mergePeople(handle, 'person:c', 'person:a', { by: 'owner', now }), { code: 'MERGE_CYCLE' });
    assert.throws(() => mergePeople(handle, 'person:a', 'person:c', { by: 'owner', now }), { code: 'ALREADY_MERGED' });
    assert.throws(() => mergePeople(handle, 'person:self', 'person:c', { by: 'owner', now }), { code: 'SELF_PERSON' });
    assert.throws(() => mergePeople(handle, 'person:c', 'person:zzz', { by: 'owner', now }), { code: 'UNKNOWN_PERSON' });
    assert.throws(() => mergePeople(handle, 'person:c', 'person:c', { by: 'owner', now }), { code: 'SAME_PERSON' });
    assert.throws(() => mergePeople(handle, 'person:c', 'person:b', { now }), { code: 'BAD_MERGE' });
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM people_merges'), merges, 'a refusal writes nothing');
    assert.equal(db.prepare("SELECT status FROM people WHERE id = 'person:c'").get().status, 'active');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});
