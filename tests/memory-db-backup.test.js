// Backups of the memory database (spec 2026-10-24-memory-schema-v7, section 11 item 6 (b) and the smaller resolution
// on backups): `VACUUM INTO` beside her diary media with a manifest of checksums, and a restore rehearsal into an empty
// path whose table hashes equal the source's. A backup that does not match its manifest, or a restore over an existing
// file, is refused. Synthetic data only; the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb, schemaVersion, MIGRATIONS } from '../src/memory/db/open.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { startRun } from '../src/memory/db/wakes.js';
import { backupDatabase, main, restoreDatabase, tableHashes } from '../tools/memory-db.mjs';
import { buildDataDir } from './fixtures/memory-db/datadir.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const run = (...argv) => {
  const lines = [];
  const code = main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  return { code, text: lines.join('\n') };
};

/** An imported data directory with two diary media files and a wake run. */
function imported() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-backup-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  fs.mkdirSync(path.join(data, 'media', 'diary'), { recursive: true });
  fs.writeFileSync(path.join(data, 'media', 'diary', 'd-1-1.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  fs.writeFileSync(path.join(data, 'media', 'diary', 'd-1-2.ogg'), Buffer.from('Ωδή'));
  const file = path.join(data, 'memory.db');
  const handle = openMemoryDb(file);
  assert.equal(seedUnits(handle, data, { log: quiet, now: () => NOW }).errors, 0);
  startRun(handle, { id: 'run-1', kind: 'heartbeat', startedAt: NOW });
  handle.close();
  return { root, data, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const hashesOf = (file) => {
  const handle = openMemoryDb(file, { readOnly: true });
  try { return tableHashes(handle.db); } finally { handle.close(); }
};

test('backup and restore: the rehearsal gives a database whose every table hashes like the source, and the media back byte for byte', () => {
  const env = imported();
  try {
    const source = hashesOf(env.file);
    const to = path.join(env.root, 'backup');
    const backup = run('backup', '--db', env.file, '--to', to);
    assert.equal(backup.code, 0, backup.text);
    const manifest = JSON.parse(fs.readFileSync(path.join(to, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, MIGRATIONS.length);
    assert.deepEqual(manifest.files.map((file) => file.path), ['memory.db', 'media/diary/d-1-1.png', 'media/diary/d-1-2.ogg']);
    for (const file of manifest.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.equal(file.size, fs.statSync(path.join(to, file.path)).size);
    }
    assert.ok(manifest.rows.sources > 0);
    assert.equal(manifest.rows.wake_runs, 1);
    assert.deepEqual(hashesOf(path.join(to, 'memory.db')), source, 'VACUUM INTO hashes like its source');

    const target = path.join(env.root, 'restored', 'memory.db');
    const restore = run('restore', '--from', to, '--db', target);
    assert.equal(restore.code, 0, restore.text);
    assert.match(restore.text, /restore ok/);
    assert.deepEqual(hashesOf(target), source, 'the restored database hashes like the source, table by table');
    for (const name of ['d-1-1.png', 'd-1-2.ogg']) {
      assert.ok(fs.readFileSync(path.join(env.root, 'restored', 'media', 'diary', name)).equals(fs.readFileSync(path.join(env.data, 'media', 'diary', name))), name);
    }
    const restored = openMemoryDb(target, { readOnly: true });
    assert.equal(schemaVersion(restored.db), MIGRATIONS.length);
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(), []);
    restored.close();

    // A restore never overwrites: the same target again is refused, and nothing changes.
    const twice = run('restore', '--from', to, '--db', target);
    assert.equal(twice.code, 2);
    assert.match(twice.text, /empty path/);
    // A backup into a directory that is not empty is refused.
    assert.throws(() => backupDatabase({ db: env.file, to }), /not empty/);
  } finally {
    env.done();
  }
});

test('restore: a backup whose file does not match its manifest is refused before anything is written', () => {
  const env = imported();
  try {
    const to = path.join(env.root, 'backup');
    backupDatabase({ db: env.file, to, data: env.data });
    fs.appendFileSync(path.join(to, 'media', 'diary', 'd-1-1.png'), Buffer.from([0]));
    const target = path.join(env.root, 'restored', 'memory.db');
    assert.throws(() => restoreDatabase({ from: to, db: target }), /does not match the manifest: media\/diary\/d-1-1.png/);
    assert.equal(fs.existsSync(target), false);
    fs.rmSync(path.join(to, 'media', 'diary', 'd-1-1.png'));
    assert.throws(() => restoreDatabase({ from: to, db: target }), /missing from the backup/);
    assert.equal(fs.existsSync(path.join(env.root, 'restored')), false);
  } finally {
    env.done();
  }
});

/** The scratch folders `restore-test` leaves under TMPDIR (it must leave none). */
const restoreScratch = () => fs.readdirSync(process.env.TMPDIR || os.tmpdir()).filter((name) => name.startsWith('restore-test-'));

test('restore-test: the backup restored into an isolated db service hashes as the backup itself, then the scratch goes', async () => {
  const env = imported();
  try {
    const to = path.join(env.root, 'backup');
    backupDatabase({ db: env.file, to, data: env.data });
    const scratchBefore = restoreScratch();
    const lines = [];
    const code = await main(['restore-test', '--from', to], { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    const text = lines.join('\n');
    assert.equal(code, 0, text);
    assert.match(text, /restored: schema \d+, 3 files checked/);
    assert.match(text, /restore-test ok: every table of the restored database equals the backup's \(\d+ tables/);
    assert.deepEqual(restoreScratch(), scratchBefore, 'the temporary data directory is removed');
    // The backup itself is unchanged: it still restores and matches its manifest.
    const target = path.join(env.root, 'again', 'memory.db');
    assert.equal(restoreDatabase({ from: to, db: target }).files.length, 3);

    // A backup that does not match its manifest fails before any service opens, and leaves no scratch either.
    fs.appendFileSync(path.join(to, 'memory.db'), Buffer.from([0]));
    const bad = [];
    assert.equal(await main(['restore-test', '--from', to], { out: (line) => bad.push(line), err: (line) => bad.push(line) }), 2);
    assert.match(bad.join('\n'), /does not match the manifest: memory\.db/);
    assert.deepEqual(restoreScratch(), scratchBefore);
  } finally {
    env.done();
  }
});
