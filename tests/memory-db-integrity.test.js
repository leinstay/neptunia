// Sync and import integrity (src/memory/db/sync.js, schema v5): an unknown legacy scope is internal, a sync never
// deletes (links and files are retired or tombstoned, rows the database wrote are left alone), `owner_file` is the
// guild-namespaced unit path, a vector row carries its model, `seen_at` comes from the line, a diary refetch keeps
// the stored text, and a rewritten or malformed JSONL file is read again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.js';
import { applyDiaryUpdate } from '../src/memory/db/diary-media.js';
import { exportAll, exportOne } from '../src/memory/db/export.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { compareTrees } from '../tools/memory-db.mjs';
import {
  GUILD, GUILD_2, MEMBER, buildDataDir, buildSecondGuild, guildDir, seen, writeJson, writeLines,
} from './fixtures/memory-db/datadir.js';

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-integrity-'));
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;
const touch = (file, secondsAhead = 5) => {
  const when = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(file, when, when);
};

function setup({ twoGuilds = false } = {}) {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  if (twoGuilds) buildSecondGuild(data);
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  return {
    root, data, handle, db: handle.db, g: guildDir(data), g2: path.join(data, 'guilds', GUILD_2),
    done() { handle.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** Exports from the database and compares with the data directory. */
function verify(env) {
  const out = path.join(env.root, `out-${fs.readdirSync(env.root).length}`);
  const exported = exportAll(env.handle, out);
  assert.deepEqual(exported.failed, []);
  return compareTrees(env.data, out);
}

const capture = () => {
  const lines = { info: [], warn: [], error: [], debug: [] };
  const log = Object.fromEntries(Object.keys(lines).map((level) => [level, (message, fields) => lines[level].push({ message, ...fields })]));
  return { log, lines };
};

// ---- 1. the scope of a line with none

test('a record line with no scope is internal, never none, and comes back without one', () => {
  const env = setup();
  try {
    const file = path.join(env.g, 'record', '2026-10', '2026-10-20.jsonl');
    writeLines(file, [seen('400000000000000001', 1, 'a line', { scope: undefined }), seen('400000000000000002', 1, 'another', { scope: {} })]);
    syncOnce(env.handle, env.data);
    const rows = env.db.prepare("SELECT scope_kind FROM sources WHERE kind = 'seen' AND owner_file = ? ORDER BY position").all(`guilds/${GUILD}/record/2026-10/2026-10-20.jsonl`);
    assert.deepEqual(rows.map((row) => row.scope_kind), ['internal', 'internal']);
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

// ---- 2. a sync never deletes

test('a link the file lost is retired, one that returns is un-retired, and a link the database wrote is never touched', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const episode = env.db.prepare("SELECT id FROM episodes WHERE kind = 'participation'").get().id;
    const owner = `guilds/${GUILD}/participation.json`;
    assert.equal(count(env.db, 'SELECT COUNT(*) AS n FROM episode_sources WHERE episode_id = ? AND owner_file = ?', episode, owner), 1);
    env.db.prepare('INSERT INTO episode_sources (episode_id, source_id, position) VALUES (?, ?, 9)').run(episode, 'src:written-by-the-database');
    const file = path.join(env.g, 'participation.json');
    const original = fs.readFileSync(file, 'utf8');
    const edited = JSON.parse(original);
    edited.episodes[0].messages = [];
    writeJson(file, edited);
    touch(file);
    syncOnce(env.handle, env.data);
    const links = () => env.db.prepare('SELECT source_id, retired_at, owner_file FROM episode_sources WHERE episode_id = ? ORDER BY position').all(episode);
    assert.equal(links().length, 2, 'nothing is deleted');
    assert.ok(links()[0].retired_at, 'the link the file lost is retired');
    assert.equal(links()[1].retired_at, null);
    assert.equal(links()[1].owner_file, null);
    fs.writeFileSync(file, original);
    touch(file, 10);
    syncOnce(env.handle, env.data);
    assert.equal(links().length, 2);
    assert.equal(links()[0].retired_at, null, 'the link that came back is active again');
    assert.equal(links()[1].source_id, 'src:written-by-the-database');
    assert.equal(links()[1].retired_at, null);
  } finally {
    env.done();
  }
});

test('a row the database wrote is not updated or retired by a remap of a file that holds the same id', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    env.db.prepare("UPDATE claims SET owner_file = NULL, text = 'written by the database' WHERE id = 'details[].itemId#1'").run();
    const file = path.join(env.g, 'users', `${MEMBER}.json`);
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    profile.messageCount = (profile.messageCount ?? 0) + 1;
    writeJson(file, profile);
    touch(file);
    syncOnce(env.handle, env.data);
    const row = env.db.prepare("SELECT text, retired_at FROM claims WHERE id = 'details[].itemId#1'").get();
    assert.equal(row.text, 'written by the database');
    assert.equal(row.retired_at, null);
  } finally {
    env.done();
  }
});

test('a file that left the disk is a tombstone, and the same file coming back is imported again', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const file = path.join(env.g, 'recent.json');
    const kept = fs.readFileSync(file);
    const stat = fs.statSync(file);
    fs.rmSync(file);
    syncOnce(env.handle, env.data);
    const full = `guilds/${GUILD}/recent.json`;
    assert.ok(env.db.prepare('SELECT gone_at FROM files WHERE path = ?').get(full).gone_at);
    assert.equal(exportOne(env.handle, `guilds/${GUILD}/recent.json`).found, false, 'a tombstone is not exported');
    assert.equal(verify(env).different, 0);
    fs.writeFileSync(file, kept);
    fs.utimesSync(file, stat.atime, stat.mtime);
    const back = syncOnce(env.handle, env.data);
    assert.equal(back.byKind.recent.changed, 1, 'the same bytes and time are read again');
    assert.equal(env.db.prepare('SELECT gone_at FROM files WHERE path = ?').get(full).gone_at, null);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM claims WHERE kind = 'recent_line' AND retired_at IS NULL"), 1);
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

test('a directory that cannot be read is not a vanished directory: nothing under it is retired', { skip: process.getuid?.() === 0 }, () => {
  const env = setup();
  const dir = path.join(env.g, 'versions');
  try {
    syncOnce(env.handle, env.data);
    const before = count(env.db, 'SELECT COUNT(*) AS n FROM operational WHERE owner_file LIKE ? AND retired_at IS NULL', '%/versions/%');
    assert.ok(before > 0);
    fs.chmodSync(dir, 0o000);
    const { log, lines } = capture();
    const result = syncOnce(env.handle, env.data, { log });
    assert.equal(count(env.db, 'SELECT COUNT(*) AS n FROM operational WHERE owner_file LIKE ? AND retired_at IS NULL', '%/versions/%'), before);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM files WHERE path LIKE '%/versions/%' AND gone_at IS NOT NULL"), 0);
    assert.equal(result.retired, 0);
    assert.ok(lines.warn.some((entry) => entry.code === 'EACCES'), 'the code is logged');
  } finally {
    fs.chmodSync(dir, 0o755);
    env.done();
  }
});

// ---- 3. two guilds

test('two guilds with the same member, file names and days do not collide through import, sync, retire and export', () => {
  const env = setup({ twoGuilds: true });
  try {
    const first = syncOnce(env.handle, env.data);
    assert.equal(first.errors, 0);
    assert.deepEqual(first.unknown, []);
    assert.equal(verify(env).different, 0, 'both guilds export equal');
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE owner_file NOT LIKE 'guilds/%'"), 0);
    for (const guild of [GUILD, GUILD_2]) {
      assert.ok(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE kind = 'seen' AND owner_file = ?", `guilds/${guild}/record/2026-10/2026-10-20.jsonl`) >= 2, guild);
      assert.equal(count(env.db, 'SELECT COUNT(*) AS n FROM files WHERE path = ?', `guilds/${guild}/users/${MEMBER}.json`), 1);
    }
    const second = syncOnce(env.handle, env.data);
    assert.equal(second.changed, 0);
    // The first guild's profile changes: its export follows, the second guild's file is not disturbed.
    const profileFile = path.join(env.g, 'users', `${MEMBER}.json`);
    const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    writeJson(profileFile, profile);
    touch(profileFile);
    syncOnce(env.handle, env.data);
    assert.equal(verify(env).different, 0);
    // A day file of the second guild is rewritten: the first guild's lines of the same day stay.
    const day = path.join(env.g2, 'record', '2026-10', '2026-10-20.jsonl');
    writeLines(day, [seen('410000000000000001', 1, 'only line', { guildId: GUILD_2, scope: { channel: '200000000000000002' } })]);
    touch(day);
    syncOnce(env.handle, env.data);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE owner_file = ? AND retired_at IS NULL", `guilds/${GUILD}/record/2026-10/2026-10-20.jsonl`), 3);
    assert.equal(verify(env).different, 0);
    // The first guild's profile leaves: the member stays for the second guild, which still exports equal.
    fs.rmSync(profileFile);
    syncOnce(env.handle, env.data);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM people WHERE id = ? AND retired_at IS NULL", `person:discord:${MEMBER}`), 1);
    assert.equal(verify(env).different, 0);
    // The whole second guild leaves, then returns.
    const saved = path.join(env.root, 'saved');
    fs.renameSync(env.g2, saved);
    syncOnce(env.handle, env.data);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE owner_file LIKE ? AND retired_at IS NULL", `guilds/${GUILD_2}/%`), 0);
    assert.ok(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE owner_file LIKE ? AND retired_at IS NULL", `guilds/${GUILD}/%`) > 0);
    assert.equal(verify(env).different, 0);
    fs.renameSync(saved, env.g2);
    for (const entry of fs.readdirSync(env.g2, { recursive: true })) {
      const file = path.join(env.g2, entry);
      if (fs.statSync(file).isFile()) touch(file, 30);
    }
    syncOnce(env.handle, env.data);
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

test('the schema upgrade rewrites a guild-relative owner_file from the files table and gives child links their owner', () => {
  const root = tmpRoot();
  const dbPath = path.join(root, 'memory.db');
  try {
    const old = openMemoryDb(dbPath, { migrations: MIGRATIONS.slice(0, 4) });
    const full = `guilds/${GUILD}/users/${MEMBER}.json`;
    old.db.prepare('INSERT INTO files (path, kind, size, mtime_ms) VALUES (?, ?, 1, 1)').run(full, 'user');
    old.db.prepare('INSERT INTO files (path, kind, size, mtime_ms) VALUES (?, ?, 1, 1)').run(`guilds/${GUILD}/recent.json`, 'recent');
    old.db.prepare('INSERT INTO people (id, owner_file) VALUES (?, ?)').run('person:discord:1', `users/${MEMBER}.json`);
    old.db.prepare('INSERT INTO claims (id, owner_file) VALUES (?, ?)').run('c1', `users/${MEMBER}.json`);
    old.db.prepare('INSERT INTO claims (id, owner_file) VALUES (?, NULL)').run('c-db');
    old.db.prepare('INSERT INTO claim_sources (claim_id, source_id, position) VALUES (?, ?, 0), (?, ?, 0)').run('c1', 's1', 'c-db', 's2');
    old.db.prepare('INSERT INTO operational (kind, owner, value, owner_file) VALUES (?, ?, ?, ?), (?, ?, ?, ?)').run('recent', 'recent.json', '{}', 'recent.json', 'guild', 'discord:guild:1', '{}', 'recent.json');
    old.db.prepare("INSERT INTO sources (id, kind, recorded_at, seen_at) VALUES ('a', 'seen', '2026-10-20T09:00:01.000Z', NULL), ('b', 'said', '2026-10-20T09:00:02.000Z', NULL)").run();
    old.close();
    const upgraded = openMemoryDb(dbPath);
    const { db } = upgraded;
    assert.equal(db.prepare("SELECT owner_file FROM people WHERE id = 'person:discord:1'").get().owner_file, full);
    assert.equal(db.prepare("SELECT owner_file FROM claims WHERE id = 'c-db'").get().owner_file, null, 'a row the database wrote stays without an owner');
    assert.deepEqual(db.prepare('SELECT claim_id, owner_file FROM claim_sources ORDER BY claim_id').all().map((row) => ({ ...row })), [
      { claim_id: 'c-db', owner_file: null }, { claim_id: 'c1', owner_file: full },
    ]);
    assert.deepEqual(db.prepare('SELECT kind, owner, owner_file FROM operational ORDER BY kind').all().map((row) => ({ ...row })), [
      { kind: 'guild', owner: 'discord:guild:1', owner_file: `guilds/${GUILD}/recent.json` },
      { kind: 'recent', owner: `guilds/${GUILD}/recent.json`, owner_file: `guilds/${GUILD}/recent.json` },
    ]);
    assert.deepEqual(db.prepare('SELECT id, seen_at FROM sources ORDER BY id').all().map((row) => ({ ...row })), [
      { id: 'a', seen_at: '2026-10-20T09:00:01.000Z' }, { id: 'b', seen_at: null },
    ]);
    upgraded.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 4. vectors, 5. seen_at

test('a vector row carries its embedding model and dims, and they are indexed together', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    assert.deepEqual(env.db.prepare('SELECT DISTINCT model, dims FROM vectors').all().map((row) => ({ ...row })), [{ model: 'test/embedder', dims: 4 }]);
    const index = env.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'vectors_model'").get();
    assert.match(index.sql, /vectors\(model, dims\)/);
  } finally {
    env.done();
  }
});

test('seen_at is the recordedAt of a seen line and null for any other kind', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const seenRows = env.db.prepare("SELECT seen_at, recorded_at FROM sources WHERE kind = 'seen'").all();
    assert.ok(seenRows.length >= 2);
    assert.ok(seenRows.every((row) => row.seen_at !== null && row.seen_at === row.recorded_at));
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE kind != 'seen' AND seen_at IS NOT NULL"), 0);
  } finally {
    env.done();
  }
});

// ---- 6. the diary refetch

test('a diary refetch never replaces a stored text, and an empty one is filled', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const id = env.db.prepare('SELECT id FROM diary').get().id;
    const text = () => env.db.prepare('SELECT text FROM diary WHERE id = ?').get(id).text;
    applyDiaryUpdate(env.handle, { id, text: '', media: [] });
    assert.equal(text(), '');
    applyDiaryUpdate(env.handle, { id, text: 'first fetch', media: [] });
    assert.equal(text(), 'first fetch');
    applyDiaryUpdate(env.handle, { id, text: 'a later fetch for the audio', media: [] });
    assert.equal(text(), 'first fetch');
    applyDiaryUpdate(env.handle, { id, text: '', media: [] });
    assert.equal(text(), 'first fetch');
  } finally {
    env.done();
  }
});

// ---- 7. JSONL change detection

const bigLine = (messageId, revision, text) => seen(messageId, revision, text.repeat(5000));

test('a JSONL file rewritten after its first 4 KB, and not shorter, is read whole again', () => {
  const env = setup();
  try {
    const file = path.join(env.g, 'record', '2026-10', '2026-10-21.jsonl');
    writeLines(file, [bigLine('400000000000000011', 1, 'a'), seen('400000000000000012', 1, 'old tail'), seen('400000000000000013', 1, 'second old tail')]);
    syncOnce(env.handle, env.data);
    const owner = `guilds/${GUILD}/record/2026-10/2026-10-21.jsonl`;
    writeLines(file, [bigLine('400000000000000011', 1, 'a'), seen('400000000000000014', 1, 'a new line that makes the file longer than before'), seen('400000000000000015', 1, 'and one more line after it')]);
    touch(file);
    syncOnce(env.handle, env.data);
    const live = env.db.prepare('SELECT native_id FROM sources WHERE owner_file = ? AND retired_at IS NULL ORDER BY position').all(owner).map((row) => row.native_id);
    assert.deepEqual(live, ['400000000000000011', '400000000000000014', '400000000000000015']);
    assert.equal(count(env.db, 'SELECT COUNT(*) AS n FROM sources WHERE owner_file = ? AND retired_at IS NOT NULL', owner), 2, 'the lines the rewrite dropped are retired, not deleted');
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

test('a malformed line is not consumed: it is retried on the next pass, logged with a code, and read once it parses', () => {
  const env = setup();
  try {
    const file = path.join(env.g, 'record', '2026-10', '2026-10-22.jsonl');
    const head = JSON.stringify(bigLine('400000000000000021', 1, 'h'));
    const tail = (id) => JSON.stringify(bigLine(id, 1, 't'));
    const broken = `{"v":1,"kind":"seen","messageId":"400000000000000022","revision":1,"text":"cut"`;
    const fixed = `{"v":1,"kind":"seen","messageId":"400000000000000022","revision":1,"text":"cut"}`;
    assert.equal(fixed.length, broken.length + 1);
    const pad = (text) => text.padEnd(fixed.length, ' ');
    fs.writeFileSync(file, `${head}\n${pad(broken)}\n${tail('400000000000000023')}\n${tail('400000000000000024')}\n`);
    const first = capture();
    const result = syncOnce(env.handle, env.data, { log: first.log });
    assert.equal(result.errors, 1);
    assert.ok(first.lines.warn.some((entry) => entry.code === 'BAD_LINE'));
    const owner = `guilds/${GUILD}/record/2026-10/2026-10-22.jsonl`;
    const natives = () => env.db.prepare('SELECT native_id FROM sources WHERE owner_file = ? AND retired_at IS NULL ORDER BY position').all(owner).map((row) => row.native_id);
    assert.deepEqual(natives(), ['400000000000000021', '400000000000000023', '400000000000000024'], 'the good lines around it are in');
    assert.ok(env.db.prepare('SELECT bad FROM files WHERE path = ?').get(owner).bad, 'the bad line is remembered');
    // Another pass over the unchanged file tries the line again and says so.
    const second = capture();
    const again = syncOnce(env.handle, env.data, { log: second.log });
    assert.equal(again.errors, 0);
    assert.ok(second.lines.debug.some((entry) => entry.code === 'BAD_LINE'));
    // The line is repaired in place: it is read at its own position.
    fs.writeFileSync(file, `${head}\n${fixed}\n${tail('400000000000000023')}\n${tail('400000000000000024')}\n`);
    touch(file);
    syncOnce(env.handle, env.data);
    assert.deepEqual(natives(), ['400000000000000021', '400000000000000022', '400000000000000023', '400000000000000024']);
    assert.equal(env.db.prepare('SELECT bad FROM files WHERE path = ?').get(owner).bad, null);
  } finally {
    env.done();
  }
});
