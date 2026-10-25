// The daily backup of the memory database (spec 2026-10-24-memory-authority, section 6 items 4 and 8; stage W4):
// with `memoryDb.backup.enabled`, the service takes one backup a UTC day from
// `memoryDb.backup.hour` through the writer (`VACUUM INTO`), with a manifest naming the schema, the engine commit and
// the config's hash, keeps the newest `keep`, and surfaces a failure (a warning, the status, her fact once a day).
// Switched off, nothing runs. Synthetic data only; the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.js';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { backupName, backupSettings, configHash, restoreDatabase } from '../src/memory/db/backup.js';
import { buildDataDir } from './fixtures/memory-db/datadir.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAY1 = Date.parse('2026-11-03T00:00:00.000Z');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const quiet = { info() {}, debug() {}, warn() {}, error() {} };

function logs() {
  const out = [];
  const add = (level) => (message, fields) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** A data directory beside its backups folder, the fixture imported into its database, two diary media files. */
function prepared() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-w4-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  fs.mkdirSync(path.join(data, 'media', 'diary'), { recursive: true });
  fs.writeFileSync(path.join(data, 'media', 'diary', 'd-1-1.png'), Buffer.from([137, 80, 78, 71, 4, 5, 6]));
  fs.writeFileSync(path.join(data, 'media', 'diary', 'd-1-2.ogg'), Buffer.from('Ωδή'));
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    assert.equal(seedUnits(handle, data, { log: quiet, now: () => DAY1 - DAY }).errors, 0);
  } finally {
    handle.close();
  }
  return { root, data, backups: path.join(root, 'backups', 'memory'), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A config with the backup settings given. */
const configOf = (backup) => ({
  memoryDb: { ...(backup ? { backup } : {}) },
});

/** The service over `data` on a clock the test moves; `tickAt(ms)` ticks at that time and waits for the backup. */
function serviceOf(data, config, { worker = false, onBackupFailure = null } = {}) {
  const clock = { at: DAY1 };
  const log = logs();
  const hot = { config };
  const service = createMemoryDb({ hot, dataDir: data, log, now: () => clock.at, commit: COMMIT, onBackupFailure, ...(worker ? {} : { worker: false }) });
  const tickAt = async (ms) => {
    clock.at = ms;
    await service.tick();
    await service.waitBackup();
  };
  return { service, log, hot, clock, tickAt };
}

const names = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('backup settings: the defaults put the backups beside data/, never inside it', () => {
  const settings = backupSettings({}, '/srv/example/data');
  assert.deepEqual(settings, { hour: 3, keep: 7, dir: path.resolve('/srv/example/backups/memory') });
  assert.deepEqual(backupSettings({ memoryDb: { backup: { hour: 23, keep: 2, dir: '/var/backups/m' } } }, '/x/data'), { hour: 23, keep: 2, dir: '/var/backups/m' });
  assert.deepEqual(backupSettings({ memoryDb: { backup: { hour: 24, keep: 0, dir: ' ' } } }, '/x/data'), { hour: 3, keep: 7, dir: path.resolve('/x/backups/memory') });
  assert.equal(backupName(Date.parse('2026-11-03T03:04:05.678Z')), '2026-11-03-030405-memory');
});

test('the schedule under db: once a UTC day from the hour, through the writer, with the manifest; the newest `keep` stay', async () => {
  const env = prepared();
  const config = configOf({ enabled: true, hour: 3, keep: 2 });
  const { service, log, tickAt } = serviceOf(env.data, config);
  try {
    await tickAt(DAY1 + 2 * HOUR);
    assert.equal(service.status().open, true);
    assert.deepEqual(names(env.backups), [], 'nothing before the hour');

    await tickAt(DAY1 + 3 * HOUR + 1000);
    const first = backupName(DAY1 + 3 * HOUR + 1000);
    assert.deepEqual(names(env.backups), [first]);
    const dir = path.join(env.backups, first);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.v, 1);
    assert.equal(manifest.schemaVersion, MIGRATIONS.length);
    assert.equal(manifest.engineCommit, COMMIT);
    assert.equal(manifest.configHash, configHash(config));
    assert.deepEqual(manifest.files.map((file) => file.path), ['memory.db', 'media/diary/d-1-1.png', 'media/diary/d-1-2.ogg']);
    for (const file of manifest.files) assert.equal(file.sha256, sha256(path.join(dir, file.path)), file.path);
    assert.ok(manifest.rows.sources > 0);
    assert.ok(!fs.existsSync(path.join(dir, 'memory.db-wal')), 'no WAL file copied');
    const status = service.status().backup;
    assert.deepEqual([status.lastAt, status.lastName, status.lastFailure, status.running], [DAY1 + 3 * HOUR + 1000, first, null, false]);

    // The same day again: nothing new.
    await tickAt(DAY1 + 20 * HOUR);
    assert.deepEqual(names(env.backups), [first]);

    // A folder the schedule did not make is never touched; an unfinished one of its own is cleared by a prune.
    fs.mkdirSync(path.join(env.backups, 'notes'));
    fs.mkdirSync(path.join(env.backups, `${backupName(DAY1 + HOUR)}.partial`));
    await tickAt(DAY1 + DAY + 4 * HOUR);
    await tickAt(DAY1 + 2 * DAY + 5 * HOUR);
    const kept = [backupName(DAY1 + DAY + 4 * HOUR), backupName(DAY1 + 2 * DAY + 5 * HOUR)];
    assert.deepEqual(names(env.backups), [...kept, 'notes'].sort(), 'the newest two kept, the oldest and the unfinished one removed');
    assert.equal(log.out.filter((entry) => entry.message === 'memory db: backup').length, 3);
    assert.ok(!log.out.some((entry) => entry.message === 'memory db: backup failed'));

    // The backup restores whole.
    const target = path.join(env.root, 'restored', 'memory.db');
    assert.equal(restoreDatabase({ from: path.join(env.backups, kept[1]), db: target }).schemaVersion, MIGRATIONS.length);
  } finally {
    await service.close();
    env.done();
  }
});

test('the schedule: a failed backup is a warning, the status and one fact a day for her, tried again an hour later', async () => {
  const env = prepared();
  // The backups folder cannot be made: its parent is a file.
  fs.writeFileSync(path.join(env.root, 'blocked'), 'x');
  const told = [];
  const { service, log, tickAt } = serviceOf(env.data, configOf({ enabled: true, hour: 3, dir: '../blocked/memory' }), { onBackupFailure: (failure) => told.push(failure) });
  try {
    await tickAt(DAY1 + 4 * HOUR);
    const failures = () => log.out.filter((entry) => entry.message === 'memory db: backup failed');
    assert.equal(failures().length, 1);
    assert.match(failures()[0].code, /^E[A-Z]+$/);
    assert.deepEqual(service.status().backup.lastFailure, { code: failures()[0].code, at: DAY1 + 4 * HOUR });
    assert.deepEqual(told, [{ code: failures()[0].code, at: DAY1 + 4 * HOUR }]);

    await tickAt(DAY1 + 4 * HOUR + 30 * 60_000);
    assert.equal(failures().length, 1, 'no new try within the hour');
    await tickAt(DAY1 + 5 * HOUR + 1000);
    assert.equal(failures().length, 2, 'tried again after the hour');
    assert.equal(told.length, 1, 'told once that day');
    await tickAt(DAY1 + DAY + 3 * HOUR);
    assert.equal(failures().length, 3);
    assert.equal(told.length, 2, 'told again the next day');
    assert.ok(!fs.readdirSync(env.root).includes('backups'));
  } finally {
    await service.close();
    env.done();
  }
});

test('the schedule: switched off, nothing runs', async () => {
  for (const backup of [{ enabled: false, hour: 0 }, null]) {
    const env = prepared();
    const { service, tickAt } = serviceOf(env.data, configOf(backup));
    try {
      await tickAt(DAY1 + 12 * HOUR);
      assert.equal(service.status().open, true);
      assert.equal(fs.existsSync(path.join(env.root, 'backups')), false, JSON.stringify(backup));
    } finally {
      await service.close();
      env.done();
    }
  }
});

test('the schedule with the writer thread: the worker takes the backup on its own connection', async () => {
  const env = prepared();
  const { service, tickAt } = serviceOf(env.data, configOf({ enabled: true, hour: 3 }), { worker: true });
  try {
    await tickAt(DAY1 + 6 * HOUR);
    assert.equal(service.status().open, true);
    const name = backupName(DAY1 + 6 * HOUR);
    assert.deepEqual(names(env.backups), [name]);
    const manifest = JSON.parse(fs.readFileSync(path.join(env.backups, name, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files[0].sha256, sha256(path.join(env.backups, name, 'memory.db')));
    const copy = openMemoryDb(path.join(env.backups, name, 'memory.db'), { readOnly: true });
    try {
      assert.equal(copy.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(copy.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, manifest.rows.sources);
    } finally {
      copy.close();
    }
  } finally {
    await service.close();
    env.done();
  }
});
