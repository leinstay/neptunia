// Backups of the memory database (spec 2026-10-24-memory-schema-v7, section 11 item 6 (b) and the smaller resolution
// on backups): `VACUUM INTO` beside her diary media with a manifest of checksums, and a restore rehearsal into an empty
// path whose table hashes equal the source's. A backup that does not match its manifest, or a restore over an existing
// file, is refused. Synthetic data only; the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb, schemaVersion, MIGRATIONS } from '../src/memory/db/open.ts';
import { observeMessage } from '../src/memory/db/message-families.ts';
import { observe, type ObserveResult } from '../src/memory/db/observe.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { window } from '../src/memory/db/recall.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { seedUnits } from './fixtures/memory-db/seed.ts';
import { startRun } from '../src/memory/db/wakes.ts';
import { backupDatabase, main, restoreDatabase, tableHashes } from '../scripts/memory-db.ts';
import type { BackupManifest } from '../src/memory/db/backup.ts';
import { buildDataDir } from './fixtures/memory-db/datadir.ts';
import type { Untyped } from '../src/tools/types.ts';
import { sqlOf } from './fixtures/loose-types.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const run = (...argv: Array<Untyped>) => {
  const lines: Array<Untyped> = [];
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
  const seedOptions = { log: quiet, now: () => NOW };
  assert.equal(seedUnits(handle, data, seedOptions).errors, 0);
  startRun(handle, { id: 'run-1', kind: 'heartbeat', startedAt: NOW });
  handle.close();
  const files = fs.readdirSync(data, { recursive: true }).filter((rel) => fs.statSync(path.join(data, rel)).isFile());
  return { root, data, file, files, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const hashesOf = (file: Untyped) => {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return tableHashes(handle.db);
  } finally {
    handle.close();
  }
};

test('backup and restore: the rehearsal gives a database whose every table hashes like the source, and the media back byte for byte', () => {
  const env = imported();
  try {
    const source = hashesOf(env.file);
    const to = path.join(env.root, 'backup');
    const backup = run('backup', '--db', env.file, '--to', to);
    assert.equal(backup.code, 0, backup.text);
    // The public backup command writes this manifest.
    const manifest = JSON.parse(fs.readFileSync(path.join(to, 'manifest.json'), 'utf8')) as BackupManifest;
    assert.equal(manifest.schemaVersion, MIGRATIONS.length);
    // The legacy import files belong to the complete persona alongside the database and diary media.
    assert.deepEqual(manifest.files.map((file: Record<string, Untyped>) => file.path).sort(), [...env.files].sort());
    for (const file of manifest.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.equal(file.size, fs.statSync(path.join(to, file.path)).size);
    }
    assert.ok((manifest.rows?.sources ?? 0) > 0);
    assert.equal(manifest.rows?.wake_runs, 1);
    assert.deepEqual(hashesOf(path.join(to, 'memory.db')), source, 'VACUUM INTO hashes like its source');

    const target = path.join(env.root, 'restored', 'memory.db');
    const restore = run('restore', '--from', to, '--db', target);
    assert.equal(restore.code, 0, restore.text);
    assert.match(restore.text, /restore ok/);
    assert.deepEqual(hashesOf(target), source, 'the restored database hashes like the source, table by table');
    for (const name of ['d-1-1.png', 'd-1-2.ogg']) {
      assert.ok(
        fs
          .readFileSync(path.join(env.root, 'restored', 'media', 'diary', name))
          .equals(fs.readFileSync(path.join(env.data, 'media', 'diary', name))),
        name
      );
    }
    const restored = openMemoryDb(target, { readOnly: true });
    assert.equal(schemaVersion(restored.db), MIGRATIONS.length);
    assert.equal(sqlOf(restored).prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(sqlOf(restored).prepare('PRAGMA foreign_key_check').all(), []);
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

test('backup restores persona files and their permissions while excluding database sidecars and runtime files', () => {
  const env = imported();
  const personaFiles = [
    ['prompts/character.md', 'A synthetic persona.', 0o600],
    ['config/config.json', '{"synthetic":true}', 0o640],
    ['keys/providers.json', '{"synthetic":"test-only"}', 0o600],
    ['skills/example/run.sh', '#!/bin/sh\nexit 0\n', 0o750],
    ['interfaces/example/state.json', '{"cursor":7}', 0o600],
    ['agents/example/profile.json', '{"synthetic":true}', 0o640],
    ['subharness/example/session.json', '{"session":"synthetic"}', 0o600],
    ['media/uploads/example.bin', 'synthetic upload', 0o640],
  ] as const;
  const handle = openMemoryDb(env.file);
  try {
    for (const [rel, content, mode] of personaFiles) {
      const file = path.join(env.data, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      fs.chmodSync(file, mode);
    }
    fs.mkdirSync(path.join(env.data, 'run'), { recursive: true });
    fs.writeFileSync(path.join(env.data, 'run', 'core.pid'), '123');
    fs.writeFileSync(`${env.file}.lock`, 'synthetic lock');
    startRun(handle, { id: 'run-in-wal', kind: 'heartbeat', startedAt: NOW + 1 });
    assert.equal(fs.existsSync(`${env.file}-wal`), true);
    assert.equal(fs.existsSync(`${env.file}-shm`), true);

    const to = path.join(env.root, 'backup');
    const manifest = backupDatabase({ db: env.file, data: env.data, to });
    const targetData = path.join(env.root, 'restored');
    const target = path.join(targetData, 'memory.db');
    restoreDatabase({ from: to, db: target });
    for (const [rel, content, mode] of personaFiles) {
      assert.equal(fs.readFileSync(path.join(targetData, rel), 'utf8'), content, rel);
      assert.equal(fs.statSync(path.join(targetData, rel)).mode & 0o777, mode, rel);
    }
    for (const rel of ['memory.db-wal', 'memory.db-shm', 'memory.db.lock', 'run/core.pid']) {
      assert.equal(
        manifest.files.some((file) => file.path === rel),
        false,
        rel
      );
      assert.equal(fs.existsSync(path.join(to, rel)), false, rel);
      assert.equal(fs.existsSync(path.join(targetData, rel)), false, rel);
    }
    assert.deepEqual(hashesOf(target), tableHashes(handle.db), 'the snapshot includes committed WAL rows');
  } finally {
    handle.close();
    env.done();
  }
});

test('backup refuses a destination inside the persona data directory before creating it', () => {
  const env = imported();
  try {
    const to = path.join(env.data, 'backups', 'nested');
    assert.throws(() => backupDatabase({ db: env.file, data: env.data, to }), /outside|inside|within/i);
    assert.equal(fs.existsSync(to), false);
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
    assert.throws(
      () => restoreDatabase({ from: to, db: target }),
      /does not match the manifest: media\/diary\/d-1-1.png/
    );
    assert.equal(fs.existsSync(target), false);
    fs.rmSync(path.join(to, 'media', 'diary', 'd-1-1.png'));
    assert.throws(() => restoreDatabase({ from: to, db: target }), /missing from the backup/);
    assert.equal(fs.existsSync(path.join(env.root, 'restored')), false);
  } finally {
    env.done();
  }
});

/** The scratch folders `restore-test` leaves under TMPDIR (it must leave none). */
const restoreScratch = () =>
  fs.readdirSync(process.env.TMPDIR || os.tmpdir()).filter((name) => name.startsWith('restore-test-'));

test('restore-test: the backup restored into an isolated db service hashes as the backup itself, then the scratch goes', async () => {
  const env = imported();
  try {
    const to = path.join(env.root, 'backup');
    backupDatabase({ db: env.file, to, data: env.data });
    const scratchBefore = restoreScratch();
    const lines: Array<Untyped> = [];
    const code = await main(['restore-test', '--from', to], {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    });
    const text = lines.join('\n');
    assert.equal(code, 0, text);
    // Restore rehearsals check the legacy import files as part of the complete persona.
    assert.match(text, new RegExp(`restored: schema \\d+, ${env.files.length} files checked`));
    assert.match(text, /restore-test ok: every table of the restored database equals the backup's \(\d+ tables/);
    assert.deepEqual(restoreScratch(), scratchBefore, 'the temporary data directory is removed');
    // The backup itself is unchanged: it still restores and matches its manifest.
    const target = path.join(env.root, 'again', 'memory.db');
    assert.equal(restoreDatabase({ from: to, db: target }).files.length, env.files.length);

    // A backup that does not match its manifest fails before any service opens, and leaves no scratch either.
    fs.appendFileSync(path.join(to, 'memory.db'), Buffer.from([0]));
    const bad: Array<Untyped> = [];
    assert.equal(
      await main(['restore-test', '--from', to], { out: (line) => bad.push(line), err: (line) => bad.push(line) }),
      2
    );
    assert.match(bad.join('\n'), /does not match the manifest: memory\.db/);
    assert.deepEqual(restoreScratch(), scratchBefore);
  } finally {
    env.done();
  }
});

test('backup restores normalized families with stable source IDs and conversation routing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-family-backup-'));
  // A complete persona backup lives outside the data directory it copies.
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const original = openMemoryDb(path.join(data, 'original.db'));
  const options = { now: () => NOW, log: quiet };
  const envelope = (conversationId: string, messageId: string, at: number) => {
    const mapped = observationOf({
      iface: 'synthetic',
      at: NOW,
      conversation: { id: conversationId, kind: 'channel', chatType: 'channel' },
      message: { id: messageId, at, content: `${conversationId} ${messageId}`, author: { id: 'member' } },
    });
    assert.ok(mapped);
    return { ...mapped, messageConversation: { id: conversationId, chatType: 'channel' as const } };
  };
  const sourceId = (result: ObserveResult): string => {
    assert.equal(result.ok, true, JSON.stringify(result));
    if (typeof result.sourceId !== 'string') throw new Error('observation has no source ID');
    return result.sourceId;
  };
  try {
    const anchors = new Map<string, string>();
    for (const room of ['room-a', 'room-b']) {
      sourceId(
        observeMessage(original, envelope(room, 'before', NOW - 120_000), {
          ...options,
          newKey: () => `${room}-before-family`,
        })
      );
      anchors.set(
        room,
        sourceId(
          observeMessage(original, envelope(room, 'same-message', NOW - 60_000), {
            ...options,
            newKey: () => `${room}-anchor-family`,
          })
        )
      );
    }
    const generic = envelope('generic-room', 'same-message', NOW - 60_000);
    const genericId = sourceId(observe(original, generic, options));
    const catalog = dbOf(original).prepare('SELECT * FROM message_families ORDER BY native_key').all();
    const sources = dbOf(original).prepare('SELECT * FROM sources ORDER BY id').all();
    const backup = path.join(root, 'backup');
    const manifest = backupDatabase({ db: path.join(data, 'original.db'), to: backup, data });
    assert.equal(manifest.rows?.message_families, 4);
    const target = path.join(root, 'restored', 'memory.db');
    restoreDatabase({ from: backup, db: target });
    const restored = openMemoryDb(target);
    try {
      const db = dbOf(restored);
      assert.deepEqual(db.prepare('SELECT * FROM message_families ORDER BY native_key').all(), catalog);
      assert.deepEqual(db.prepare('SELECT * FROM sources ORDER BY id').all(), sources);
      for (const [room, anchor] of anchors) {
        const replay = observeMessage(restored, envelope(room, 'same-message', NOW - 60_000), {
          ...options,
          newKey: () => {
            throw new Error('restored family allocated again');
          },
        });
        assert.equal(sourceId(replay), anchor);
        assert.equal(replay.replayed, true);
        const result = window(db, {
          ctx: internalContext(),
          resolvedAnchor: { kind: 'source', sourceId: anchor },
          move: 'up',
          messages: 1,
        });
        assert.equal(result.unknown, false);
        assert.deepEqual(
          result.windows.flatMap((entry) => entry.messages).map((message) => message.stored?.native),
          [{ iface: 'synthetic', conversationId: room, messageId: 'before' }]
        );
      }
      assert.equal(sourceId(observe(restored, generic, options)), genericId);
      assert.deepEqual(db.prepare('SELECT * FROM message_families ORDER BY native_key').all(), catalog);
      assert.deepEqual(db.prepare('SELECT * FROM sources ORDER BY id').all(), sources);
    } finally {
      restored.close();
    }
  } finally {
    original.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
