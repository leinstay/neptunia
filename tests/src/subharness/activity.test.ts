// Tests for src/subharness/activity.ts: the run marks and the change lock of a backend, in a private folder under
// TMPDIR. The mark and lock files are the contract between processes, so a test that plays another process writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BackendLocked, backendBusy, markedRun, withBackendLock } from '../../../src/subharness/activity.ts';
import { subharnessPlace } from '../../../src/subharness/place.ts';

/** A pid above every pid Linux hands out, so no process holds it. */
const DEAD_PID = 2_147_483_000;

function privateDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'activity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The marks folder of `backend`, as another process writes into it. */
const marksOf = (dir: string, backend: 'claude' | 'codex') => path.join(subharnessPlace(dir, backend).dir, '.busy');

test('markedRun: the backend is busy while the work runs and free after it', async (t) => {
  const dir = privateDir(t);
  const during = await markedRun(dir, 'claude', () => Promise.resolve(backendBusy(dir, 'claude')));
  assert.equal(during, true);
  assert.equal(backendBusy(dir, 'claude'), false);
});

test('markedRun: work that throws leaves no mark behind', async (t) => {
  const dir = privateDir(t);
  await assert.rejects(
    markedRun(dir, 'codex', () => Promise.reject(new Error('run failed'))),
    /run failed/
  );
  assert.equal(backendBusy(dir, 'codex'), false);
});

test('backendBusy: a mark of a living process of another backend leaves this one free', async (t) => {
  const dir = privateDir(t);
  const busyHere = await markedRun(dir, 'claude', () => Promise.resolve(backendBusy(dir, 'codex')));
  assert.equal(busyHere, false);
});

test('backendBusy: a mark of a dead process is not busy and is removed', (t) => {
  const dir = privateDir(t);
  const marks = marksOf(dir, 'claude');
  fs.mkdirSync(marks, { recursive: true });
  fs.writeFileSync(path.join(marks, `${DEAD_PID}-left`), '');
  assert.equal(backendBusy(dir, 'claude'), false);
  assert.deepEqual(fs.readdirSync(marks), []);
});

test('backendBusy: a mark of another living process is busy', (t) => {
  const dir = privateDir(t);
  const marks = marksOf(dir, 'claude');
  fs.mkdirSync(marks, { recursive: true });
  fs.writeFileSync(path.join(marks, `${process.ppid}-other`), '');
  assert.equal(backendBusy(dir, 'claude'), true);
});

test('withBackendLock: a second change of the same backend waits for the first to end', async (t) => {
  const dir = privateDir(t);
  const order: Array<string> = [];
  let release = () => {};
  const first = withBackendLock(dir, 'claude', async () => {
    order.push('first start');
    await new Promise<void>((resolve) => (release = resolve));
    order.push('first end');
  });
  const second = withBackendLock(dir, 'claude', () => {
    order.push('second');
    return Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first start', 'first end', 'second']);
});

test('withBackendLock: a lock held past the wait refuses with BackendLocked, and another backend runs', async (t) => {
  const dir = privateDir(t);
  let release = () => {};
  const held = withBackendLock(dir, 'claude', () => new Promise<void>((resolve) => (release = resolve)));
  const started = Date.now();
  await assert.rejects(
    withBackendLock(dir, 'claude', () => Promise.resolve(), 60),
    BackendLocked
  );
  assert.ok(Date.now() - started < 3000, 'the refusal comes after the wait it was given');
  assert.equal(await withBackendLock(dir, 'codex', () => Promise.resolve('ran'), 60), 'ran');
  release();
  await held;
});

test('withBackendLock: a lock left by a dead process is taken', async (t) => {
  const dir = privateDir(t);
  const locks = path.join(dir, 'subharness', '.locks');
  fs.mkdirSync(locks, { recursive: true });
  fs.writeFileSync(path.join(locks, 'claude.lock'), String(DEAD_PID));
  assert.equal(await withBackendLock(dir, 'claude', () => Promise.resolve('ran'), 500), 'ran');
});
