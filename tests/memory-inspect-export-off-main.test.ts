// `/memory inspect export` off the main thread: the export (src/interface/commands/memory.ts, over
// src/memory/db/inspection-snapshots.ts) runs on its own thread like `/memory backup` (tests/memory-db-backup-off-main.test.ts),
// so the core's event loop stays free while a large database is written. Measured in production: one export wrote 1.05 GB
// in 25.7 s and the loop stalled 25144 ms. The file keeps its contract: mode 0600, refused when it exists, the same header
// and manifest, and a failure in the thread reaches the owner. Synthetic data only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer } from '../src/interface/commands/console.ts';
import { exportInspectionInWorker } from '../src/memory/db/inspection-export.ts';
import { writeInspectionExport } from '../src/memory/db/inspection-snapshots.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { TestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const ROW_BYTES = 2 * 1024 * 1024;
const ROWS = 60;
/** The longest the main thread may go without running a timer while an export writes. */
const MAX_GAP_MS = 100;

const opened: Array<TestMemory> = [];
after(async () => {
  for (const memory of opened) await memory.close();
});

/** The real memory service with `ROWS` rows of `ROW_BYTES` each in one table (about 120 MB of export), and a console over it. */
async function rig() {
  const dir = tempDir('nep-inspect-export-off-main-');
  const memory = await openTestMemory({ config: { memoryDb: { inspection: BOUNDS } }, now: () => NOW });
  opened.push(memory);
  const handle = memory.memoryDb.readHandle();
  assert.ok(handle);
  const db = dbOf(handle);
  db.exec('CREATE TABLE zz_large (id INTEGER PRIMARY KEY, body TEXT)');
  const insert = db.prepare('INSERT INTO zz_large VALUES (?, ?)');
  for (let i = 1; i <= ROWS; i += 1) insert.run(i, String.fromCharCode(97 + (i % 26)).repeat(ROW_BYTES));
  const tracked: Array<string> = [];
  const desk = createConsole({
    runOp: () => Promise.reject(new Error('no operation runs in these tests')),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => [],
    selfId: () => null,
    hot: memory.hot,
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    conversationLines: () => [],
    now: () => NOW,
    track: (name, fn) => {
      tracked.push(name);
      return fn();
    },
  });
  return {
    memory,
    dir,
    tracked,
    exportTo: (file: string): Promise<Answer> => desk.run('memory.inspect.export', { file }, { id: 'owner' }),
  };
}

const lines = (file: string): Array<Record<string, unknown>> =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test('the event loop keeps running while /memory inspect export writes a large database', async () => {
  // Bug: the export writes synchronously on the core's thread and the loop stalls for the whole write (25 s measured).
  const { exportTo, dir, tracked } = await rig();
  const file = path.join(dir, 'export.jsonl');
  let last = performance.now();
  let widest = 0;
  let ticks = 0;
  const ticker = setInterval(() => {
    const at = performance.now();
    widest = Math.max(widest, at - last);
    last = at;
    ticks += 1;
  }, 5);
  const answer = await exportTo(file).finally(() => clearInterval(ticker));
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  assert.ok(widest < MAX_GAP_MS, `the longest gap between timer ticks was ${Math.round(widest)} ms`);
  assert.ok(ticks >= 5, `ticks during the export: ${ticks}`);
  assert.ok(fs.statSync(file).size > ROWS * ROW_BYTES, 'the file holds the large rows whole');
  assert.ok(tracked.includes('memory.inspect.export'), 'the export names itself with track, so a stall attributes');
});

test('the export from the thread has mode 0600 whatever the umask, and no partial file is left beside it', async () => {
  // Bug: the file of her whole memory readable by every user on the machine, or a half-written file left in the folder.
  const { exportTo, dir } = await rig();
  const file = path.join(dir, 'export.jsonl');
  const umask = process.umask(0);
  let answer: Answer;
  try {
    answer = await exportTo(file);
  } finally {
    process.umask(umask);
  }
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.partial')),
    []
  );
});

test('the export from the thread refuses a file that exists, leaves it, and answers with the same code', async () => {
  // Bug: the thread loses the refusal's code and the owner reads a bare failure, or it overwrites the file.
  const { exportTo, dir } = await rig();
  const file = path.join(dir, 'taken.jsonl');
  fs.writeFileSync(file, 'keep me');
  const answer = await exportTo(file);
  assert.equal(answer.code, 'INSPECTION_EXPORT_EXISTS');
  assert.notEqual(answer.status, 'ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');
});

test('the export from the thread holds the header, the catalog and the manifest the in-thread export wrote', async () => {
  // Bug: the thread exports another moment, another revision or a different row count than the core's own writer.
  const { exportTo, dir, memory } = await rig();
  const port = memory.memoryDb.inspection();
  assert.ok(port);
  const inThread = path.join(dir, 'in-thread.jsonl');
  const handle = port.openInspection({ ownerId: 'owner', bounds: BOUNDS });
  try {
    writeInspectionExport(port, handle, { file: inThread });
  } finally {
    port.closeInspection(handle);
  }
  const fromThread = path.join(dir, 'from-thread.jsonl');
  assert.equal((await exportTo(fromThread)).status, 'ok');
  const [headA, catalogA, ...restA] = lines(inThread);
  const [headB, catalogB, ...restB] = lines(fromThread);
  assert.equal(headB.kind, 'header');
  assert.equal(headB.engineRevision, headA.engineRevision);
  assert.equal(headB.memoryVersion, headA.memoryVersion);
  assert.equal(headB.boardVersion, headA.boardVersion);
  assert.deepEqual(catalogB, catalogA);
  const manifestA = restA.at(-1);
  const manifestB = restB.at(-1);
  assert.equal(manifestB?.kind, 'manifest');
  assert.deepEqual(manifestB, manifestA);
  assert.equal(restB.length, restA.length);
  assert.equal((manifestB?.rows as Record<string, number>).zz_large, ROWS);
});

test('an export into a folder that does not exist fails with a reason and leaves no file', async () => {
  // Bug: the thread's failure is swallowed and the owner is told the export is done.
  const { exportTo, dir } = await rig();
  const file = path.join(dir, 'nowhere', 'export.jsonl');
  const answer = await exportTo(file);
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.length > 0);
  assert.equal(fs.existsSync(file), false);
});

/** The arguments of one export from a thread, over the rig's database. */
function exportArgs(memory: TestMemory, dir: string) {
  return {
    db: path.join(memory.dataDir, 'memory.db'),
    file: path.join(dir, 'never.jsonl'),
    ownerId: 'owner',
    bounds: BOUNDS,
    engineRevision: 'abc1234',
    at: NOW,
  };
}

test('exportInspectionInWorker rejects when its thread dies with an error', async () => {
  // Bug: a thread that crashes leaves the owner's command waiting for ever, or answering ok.
  const { memory, dir } = await rig();
  await assert.rejects(
    exportInspectionInWorker(
      exportArgs(memory, dir),
      new URL('./fixtures/memory-db/export-worker-throws.ts', import.meta.url)
    ),
    /export thread blew up/
  );
});

test('exportInspectionInWorker rejects when its thread ends without an answer', async () => {
  // Bug: the promise never settles when the thread exits quietly, so the command hangs.
  const { memory, dir } = await rig();
  await assert.rejects(
    exportInspectionInWorker(
      exportArgs(memory, dir),
      new URL('./fixtures/memory-db/export-worker-silent.ts', import.meta.url)
    ),
    /without an answer/
  );
});
