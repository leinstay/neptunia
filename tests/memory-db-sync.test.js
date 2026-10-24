// Sync (src/memory/db/sync.js) on a synthetic data directory: the first pass is the import, later passes read only
// what changed, rows that left a file are retired, forgotten members are never imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { exportAll } from '../src/memory/db/export.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { compareTrees, main } from '../tools/memory-db.mjs';
import {
  CHANNEL, HOT_ITEM, MEMBER, buildDataDir, dump, envelope, guildDir, seen, turnLine, writeJson, writeLines,
} from './fixtures/memory-db/datadir.js';

const OTHER = '100000000000000002';
const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-sync-'));

/** A data directory, an open database and a cleanup. */
function setup() {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  return {
    root, data, handle, g: guildDir(data), db: handle.db,
    done() { handle.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** Exports from the database and compares with the data directory; returns the comparison. */
function verify(env) {
  const out = path.join(env.root, `out-${fs.readdirSync(env.root).length}`);
  const exported = exportAll(env.handle, out);
  assert.deepEqual(exported.failed, []);
  return compareTrees(env.data, out);
}

const touch = (file, secondsAhead = 5) => {
  const when = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(file, when, when);
};
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

test('the first pass imports every memory file and the export is equal file by file', () => {
  const env = setup();
  try {
    const result = syncOnce(env.handle, env.data);
    assert.equal(result.errors, 0);
    assert.deepEqual(result.unknown, []);
    assert.ok(result.seen >= 25);
    assert.ok(result.upserted > 50);
    assert.equal(result.skipped, 1, 'state.json is not memory');
    const check = verify(env);
    assert.deepEqual(Object.fromEntries(Object.entries(check.byKind).map(([kind, slot]) => [kind, [slot.differs, slot.missing, slot.extra]]).filter(([, bad]) => bad.some((list) => list.length))), {});
    assert.equal(check.different, 0);
    assert.ok(check.byKind.record.equal >= 2 && check.byKind.vectors.equal === 3 && check.byKind.journal.equal >= 1);
  } finally {
    env.done();
  }
});

test('a second pass over unchanged files reads nothing', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const again = syncOnce(env.handle, env.data);
    assert.equal(again.changed, 0);
    assert.equal(again.upserted, 0);
    assert.equal(again.errors, 0);
  } finally {
    env.done();
  }
});

test('a changed profile is one changed file and the export stays equal', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const file = path.join(env.g, 'users', `${MEMBER}.json`);
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    profile.messageCount += 7;
    profile.character = 'Changed prose, café.';
    writeJson(file, profile);
    touch(file);
    const result = syncOnce(env.handle, env.data);
    assert.equal(result.changed, 1);
    assert.equal(result.byKind.user.changed, 1);
    assert.equal(result.errors, 0);
    assert.equal(count(env.db, 'SELECT message_count AS n FROM people WHERE id = ?', `person:discord:${MEMBER}`), profile.messageCount);
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

test('a detail that left the profile is retired, never deleted, and the export drops it', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const file = path.join(env.g, 'users', `${MEMBER}.json`);
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    const gone = profile.details.shift();
    writeJson(file, profile);
    touch(file);
    const result = syncOnce(env.handle, env.data);
    assert.equal(result.retired, 1);
    const claim = env.db.prepare('SELECT retired_at FROM claims WHERE id = ?').get(gone.itemId);
    assert.ok(claim, 'the row stays');
    assert.ok(claim.retired_at);
    assert.equal(verify(env).different, 0);
    // The detail comes back: the row is un-retired.
    profile.details.unshift(gone);
    writeJson(file, profile);
    touch(file, 10);
    syncOnce(env.handle, env.data);
    assert.equal(env.db.prepare('SELECT retired_at FROM claims WHERE id = ?').get(gone.itemId).retired_at, null);
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

test('appended journal lines are read from the offset and a partial last line waits', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const file = path.join(env.g, 'journal', '2026-10-20.jsonl');
    const before = count(env.db, "SELECT COUNT(*) AS n FROM day WHERE owner_file = 'journal/2026-10-20.jsonl'");
    const whole = `${JSON.stringify(envelope('system', { id: 'j-system-2', event: 'stop', by: 'owner' }))}\n`;
    const partial = JSON.stringify(envelope('system', { id: 'j-system-3', event: 'start', by: 'owner' }));
    fs.appendFileSync(file, whole + partial.slice(0, 40));
    touch(file);
    const first = syncOnce(env.handle, env.data);
    assert.equal(first.byKind.journal.changed, 1);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM day WHERE owner_file = 'journal/2026-10-20.jsonl'"), before + 1);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM day WHERE id = 'j-system-3'"), 0, 'the partial line is not read');
    const row = env.db.prepare("SELECT offset, lines FROM files WHERE path LIKE '%journal/2026-10-20.jsonl'").get();
    assert.equal(row.offset, Buffer.byteLength(fs.readFileSync(file, 'utf8')) - 40);
    assert.equal(row.lines, 5);
    fs.appendFileSync(file, `${partial.slice(40)}\n`);
    touch(file, 10);
    syncOnce(env.handle, env.data);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM day WHERE id = 'j-system-3'"), 1);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM day WHERE owner_file = 'journal/2026-10-20.jsonl'"), before + 2);
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

test('a JSONL file that shrank or was rewritten is read whole again and the missing rows are retired', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const file = path.join(env.g, 'record', '2026-10', '2026-10-20.jsonl');
    writeLines(file, [seen('400000000000000001', 1, 'Καλημέρα'), seen('400000000000000003', 1, 'new line')]);
    touch(file);
    const result = syncOnce(env.handle, env.data);
    assert.equal(result.errors, 0);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE owner_file = 'record/2026-10/2026-10-20.jsonl' AND retired_at IS NOT NULL"), 2);
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

test('a file that left the disk retires its rows', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    fs.rmSync(path.join(env.g, 'recent.json'));
    const result = syncOnce(env.handle, env.data);
    assert.equal(result.byKind.recent.changed, 1);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM claims WHERE kind = 'recent_line' AND retired_at IS NULL"), 0);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM files WHERE path LIKE '%recent.json'"), 0);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM claims WHERE kind = 'recent_line'"), 1, 'nothing is deleted');
  } finally {
    env.done();
  }
});

test('one bad file is counted and logged by kind and code while the pass goes on', () => {
  const env = setup();
  try {
    fs.writeFileSync(path.join(env.g, 'lore.json'), '{ not json');
    const logged = [];
    const log = { info() {}, debug() {}, error() {}, warn: (message, fields) => logged.push([message, fields]) };
    const result = syncOnce(env.handle, env.data, { log });
    assert.equal(result.errors, 1);
    assert.equal(result.byKind.lore.errors, 1);
    assert.ok(result.byKind.user.upserted > 0);
    assert.deepEqual(logged.map(([, fields]) => Object.keys(fields).sort()), [['code', 'kind']]);
    assert.equal(logged[0][1].kind, 'lore');
    assert.ok(!JSON.stringify(logged).includes(env.root), 'no path in the log');
  } finally {
    env.done();
  }
});

test('an archived item missing from hot memory is a retired historical claim; a hot item keeps its claim', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const hot = env.db.prepare('SELECT truth, retired_at, owner_file FROM claims WHERE id = ?').get(HOT_ITEM);
    assert.equal(hot.truth, 'current');
    assert.equal(hot.retired_at, null);
    assert.equal(hot.owner_file, `users/${MEMBER}.json`);
    const stub = env.db.prepare('SELECT truth, retired_at, kind FROM claims WHERE id = ?').get('gone-item');
    assert.equal(stub.truth, 'historical');
    assert.ok(stub.retired_at);
    assert.equal(stub.kind, 'detail');
    assert.deepEqual(env.db.prepare('SELECT claim_id FROM claim_versions ORDER BY id').all().map((row) => row.claim_id), [HOT_ITEM, 'gone-item']);
  } finally {
    env.done();
  }
});

test('a participation message points at the newest revision of the record source', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const rows = env.db.prepare('SELECT source_id FROM episode_sources').all();
    assert.deepEqual(rows.map((row) => row.source_id), ['src:discord:400000000000000001:2:seen']);
  } finally {
    env.done();
  }
});

test('a request dump gives its step source only once the turn answer exists, then narrows to its scope', () => {
  const env = setup();
  try {
    const journal = path.join(env.g, 'journal', '2026-10-20.jsonl');
    const lines = fs.readFileSync(journal, 'utf8');
    fs.writeFileSync(journal, '');
    syncOnce(env.handle, env.data);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE id = 'src:turn:turn-1:1:s1'"), 0);
    assert.equal(env.db.prepare("SELECT sha1 FROM files WHERE path LIKE '%turn-1-s1.json'").get().sha1, 'pending');
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM operational WHERE kind = 'request_dump'"), 1, 'the dump itself is kept');
    fs.writeFileSync(journal, lines);
    touch(journal);
    syncOnce(env.handle, env.data);
    const step = env.db.prepare("SELECT scope_kind, place_id, think FROM sources WHERE id = 'src:turn:turn-1:1:s1'").get();
    assert.equal(step.scope_kind, 'group');
    assert.equal(step.place_id, `discord:channel:${CHANNEL}`);
    assert.equal(step.think, 'she waits');
    assert.equal(env.db.prepare("SELECT sha1 FROM files WHERE path LIKE '%turn-1-s1.json'").get().sha1, null);
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

test('vector rows are linked to the record source of their message', () => {
  const env = setup();
  try {
    syncOnce(env.handle, env.data);
    const rows = env.db.prepare('SELECT chunk_key, source_rowid, owner_file FROM vectors ORDER BY chunk_key').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.owner_file === 'vectors/2026-10'));
    const linked = rows.find((row) => row.chunk_key === 'record:400000000000000001:1');
    assert.ok(linked.source_rowid);
    assert.equal(env.db.prepare('SELECT native_id FROM sources WHERE rowid = ?').get(linked.source_rowid).native_id, '400000000000000001');
  } finally {
    env.done();
  }
});

test('a forgotten member is never imported, and is not a missing file in the verify', () => {
  const env = setup();
  try {
    writeJson(path.join(env.g, 'forgotten.json'), [{ userId: OTHER, at: '2026-10-19T00:00:00.000Z' }]);
    writeJson(path.join(env.g, 'users', `${OTHER}.json`), { id: OTHER, names: ['Ghost'], firstSeen: 'x', lastSeen: 'y', messageCount: 3 });
    writeJson(path.join(env.g, 'private', `${OTHER}.json`), { relationship: 'secret' });
    writeLines(path.join(env.g, 'record', '2026-10', '2026-10-21.jsonl'), [seen('400000000000000020', 1, 'from the forgotten', { by: OTHER }), seen('400000000000000021', 1, 'kept')]);
    const result = syncOnce(env.handle, env.data);
    assert.equal(result.forgotten, 2);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM people WHERE id = ?", `person:discord:${OTHER}`), 0);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE author_account = ?", `discord:${OTHER}`), 0);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE native_id = '400000000000000021'"), 1);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM operational WHERE owner_file LIKE ?", `%${OTHER}%`), 0);
    const check = verify(env);
    assert.equal(check.different, 0);
    assert.equal(check.byKind.user.forgotten, 1);
    assert.equal(check.byKind.private.forgotten, 1);
  } finally {
    env.done();
  }
});

test('a member forgotten after the import has their imported rows retired', () => {
  const env = setup();
  try {
    writeJson(path.join(env.g, 'users', `${OTHER}.json`), { id: OTHER, names: ['Ghost'], firstSeen: 'x', lastSeen: 'y', messageCount: 3 });
    writeLines(path.join(env.g, 'record', '2026-10', '2026-10-21.jsonl'), [seen('400000000000000020', 1, 'soon forgotten', { by: OTHER })]);
    syncOnce(env.handle, env.data);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM people WHERE id = ? AND retired_at IS NULL", `person:discord:${OTHER}`), 1);
    fs.rmSync(path.join(env.g, 'users', `${OTHER}.json`));
    writeLines(path.join(env.g, 'record', '2026-10', '2026-10-21.jsonl'), []);
    const ledger = path.join(env.g, 'forgotten.json');
    writeJson(ledger, [{ userId: OTHER, at: '2026-10-22T00:00:00.000Z' }]);
    touch(ledger);
    syncOnce(env.handle, env.data);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM people WHERE id = ? AND retired_at IS NOT NULL", `person:discord:${OTHER}`), 1);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE author_account = ? AND retired_at IS NULL", `discord:${OTHER}`), 0);
    assert.equal(verify(env).different, 0);
  } finally {
    env.done();
  }
});

test('the filter limits a pass to some paths', () => {
  const env = setup();
  try {
    const result = syncOnce(env.handle, env.data, { filter: (rel) => rel.endsWith('/lore.json') });
    assert.equal(result.seen, 1);
    assert.equal(count(env.db, 'SELECT COUNT(*) AS n FROM files'), 1);
  } finally {
    env.done();
  }
});

test('the writer lock refuses a second writer, and import refuses a database that already has files', () => {
  const env = setup();
  try {
    const lines = [];
    const io = { out: (line) => lines.push(line), err: (line) => lines.push(line) };
    const dbFile = path.join(env.root, 'memory.db');
    assert.equal(main(['sync', '--data', env.data, '--db', dbFile], io), 2, 'the handle of this test holds the lock');
    assert.match(lines.at(-1), /locked by pid/);
    syncOnce(env.handle, env.data);
    env.handle.close();
    lines.length = 0;
    assert.equal(main(['import', '--data', env.data, '--db', dbFile], io), 2);
    assert.match(lines.at(-1), /already holds imported files/);
    assert.equal(main(['import', '--data', env.data, '--db', dbFile, '--resume'], io), 0);
    assert.ok(lines.some((line) => /import took/.test(line)));
    assert.equal(main(['verify', '--data', env.data, '--db', dbFile], io), 0);
    assert.match(lines.at(-1), /verify ok/);
  } finally {
    env.done();
  }
});

test('a request dump file without the journal turn does not break a pass', () => {
  const env = setup();
  try {
    writeJson(path.join(env.g, 'journal', 'requests', '2026-10-20', 'lonely-s1.json'), { ...dump(), turnId: 'lonely' });
    const result = syncOnce(env.handle, env.data);
    assert.equal(result.errors, 0);
    assert.equal(count(env.db, "SELECT COUNT(*) AS n FROM sources WHERE turn_id = 'lonely'"), 0);
    assert.ok(turnLine().turnId);
  } finally {
    env.done();
  }
});
