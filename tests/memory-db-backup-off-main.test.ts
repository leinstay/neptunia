// The whole-memory backups off the main thread: `/memory backup` (src/interface/commands/console.ts) and the daily
// backup's pruning (src/memory/db/service.ts) leave the event loop free and name themselves with `track`, so a stall
// during one attributes. A sparse file of 300 MB stands in for a large data folder. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConsole } from '../src/interface/commands/console.ts';
import { backupsIn } from '../src/memory/db/backup.ts';
import type { BackupManifest } from '../src/memory/db/backup.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const LARGE_BYTES = 300 * 1024 * 1024;
const quiet = { info() {}, debug() {}, warn() {}, error() {} };

function folders(): { root: string; data: string } {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-backup-off-main-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  openMemoryDb(path.join(data, 'memory.db')).close();
  return { root, data };
}

/** The console over `data`, with a `track` that lists the operations it was given. */
function consoleOver(data: string, dir: string) {
  const tracked: Array<string> = [];
  const desk = createConsole({
    runOp: () => Promise.reject(new Error('no operation runs in these tests')),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => [],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] }, memoryDb: { backup: { dir } } } },
    privateDir: data,
    dataDir: data,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => NOW,
    track: (name, fn) => {
      tracked.push(name);
      return fn();
    },
  });
  return { tracked, backup: () => desk.run('memory.backup', {}, { id: 'owner-1' }) };
}

test('a timer keeps firing while /memory backup copies a large file', async () => {
  const { root, data } = folders();
  try {
    fs.writeFileSync(path.join(data, 'large.bin'), '');
    fs.truncateSync(path.join(data, 'large.bin'), LARGE_BYTES);
    const { backup } = consoleOver(data, '../b');
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    const answer = await backup().finally(() => clearInterval(ticker));
    assert.equal(answer.status, 'ok', answer.text);
    assert.ok(ticks >= 5, `ticks during the backup: ${ticks}`);
    const [made] = backupsIn(path.join(root, 'b'));
    assert.ok(made, 'one backup was made');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'b', made, 'manifest.json'), 'utf8')) as BackupManifest;
    assert.equal(manifest.files.find((file) => file.path === 'large.bin')?.size, LARGE_BYTES);
    assert.equal(manifest.createdAt, new Date(NOW).toISOString());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/memory backup names itself with track, so a stall during it attributes', async () => {
  const { root, data } = folders();
  try {
    const { tracked, backup } = consoleOver(data, '../b');
    assert.equal((await backup()).status, 'ok');
    assert.deepEqual(tracked, ['memory.backup']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/memory backup into the data folder fails with its reason and leaves no unfinished folder', async () => {
  const { root, data } = folders();
  try {
    const { backup } = consoleOver(data, 'inside');
    const answer = await backup();
    assert.equal(answer.status, 'failed');
    assert.ok(answer.text.includes('outside the data directory'), answer.text);
    assert.deepEqual(fs.existsSync(path.join(data, 'inside')) ? fs.readdirSync(path.join(data, 'inside')) : [], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A finished backup of `files` small files. */
function oldBackup(dir: string, name: string, files: number): void {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), '{}');
  for (let i = 0; i < files; i += 1) fs.writeFileSync(path.join(folder, `f-${i}`), 'x');
}

test('the daily backup prunes old backups while a timer keeps firing, named with track', async () => {
  const { root, data } = folders();
  const dir = path.join(root, 'b');
  oldBackup(dir, '2026-11-01-030000-memory', 5000);
  oldBackup(dir, '2026-11-02-030000-memory', 5000);
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 2);
  const during = new Map<string, number>();
  const service = createMemoryDb({
    hot: {
      config: { memoryDb: { session: { mode: 'off' }, backup: { enabled: true, hour: 0, dir: '../b', keep: 1 } } },
    },
    dataDir: data,
    log: quiet,
    now: () => NOW,
    commit: 'abc1234',
    track: (name, fn) => {
      const before = ticks;
      const result = fn();
      if (!(result instanceof Promise)) {
        during.set(name, 0);
        return result;
      }
      return result.finally(() => during.set(name, ticks - before)) as typeof result;
    },
  });
  try {
    await service.open();
    await service.tick();
    await service.waitBackup();
    assert.deepEqual(backupsIn(dir).length, 1);
    assert.ok(!backupsIn(dir).includes('2026-11-01-030000-memory'));
    assert.ok((during.get('backup.prune') ?? 0) >= 3, `ticks during the pruning: ${during.get('backup.prune')}`);
  } finally {
    clearInterval(ticker);
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
