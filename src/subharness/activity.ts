// What the owner's account commands must see of the other processes on one backend. The core, the agent units and the
// command line are separate processes over one home, so both facts live on disk. A run leaves a mark file under the
// backend's folder for as long as it lasts, which `logout` reads as busy. A change of credentials or of the install holds
// one lock file per backend, so a logout racing a login cannot leave a home that is half of each. Mark and lock name the
// process that holds them, and a holder that died holds nothing.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendName } from '../agent-runner/profiles.ts';
import { log } from '../log.ts';
import { subharnessPlace } from './place.ts';

/** The folder of the run marks inside a backend's folder, which an agent unit binds writable. */
const MARKS_DIR = '.busy';
/** How often a waiter looks at the lock again (ms). */
const LOCK_POLL_MS = 25;
/** How long a change waits for the lock: a login may stay open for a whole browser round (ms). */
const LOCK_WAIT_MS = 10 * 60 * 1000;

/** Whether the process `pid` is there; a process of another user answers EPERM and is. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Runs `work` with a mark of this process on `backend`. A mark that cannot be written is logged and stops nothing. */
export async function markedRun<T>(privateDir: string, backend: BackendName, work: () => Promise<T>): Promise<T> {
  const dir = path.join(subharnessPlace(privateDir, backend).dir, MARKS_DIR);
  const mark = path.join(dir, `${process.pid}-${randomUUID()}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(mark, '');
  } catch (error) {
    log.warn('subharness: the run mark could not be written', { backend, code: (error as Error).name });
  }
  try {
    return await work();
  } finally {
    fs.rmSync(mark, { force: true });
  }
}

/** Whether a living process runs `backend` now. The marks of dead processes are removed on the way. */
export function backendBusy(privateDir: string, backend: BackendName): boolean {
  const dir = path.join(subharnessPlace(privateDir, backend).dir, MARKS_DIR);
  let marks: Array<string>;
  try {
    marks = fs.readdirSync(dir);
  } catch {
    return false;
  }
  let busy = false;
  for (const mark of marks) {
    if (alive(Number.parseInt(mark, 10))) busy = true;
    else fs.rmSync(path.join(dir, mark), { force: true });
  }
  return busy;
}

const lockFile = (privateDir: string, backend: BackendName): string =>
  path.join(privateDir, 'subharness', '.locks', `${backend}.lock`);

/** Takes the lock in one atomic step, its holder's pid in the file from the first moment; false while another holds it. */
function tryLock(file: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const candidate = `${file}.${process.pid}.${randomUUID()}`;
  fs.writeFileSync(candidate, String(process.pid));
  try {
    fs.linkSync(candidate, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    fs.rmSync(candidate, { force: true });
  }
  let holder = Number.NaN;
  try {
    holder = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
  } catch {
    // released between the two steps: the next try takes it
    return false;
  }
  if (!alive(holder)) fs.rmSync(file, { force: true });
  return false;
}

/** The lock of one backend was not free in time. */
export class BackendLocked extends Error {}

/** `work` alone among the changes of `backend`, across processes; another backend's lock holds nothing here. */
export async function withBackendLock<T>(
  privateDir: string,
  backend: BackendName,
  work: () => Promise<T>,
  waitMs: number = LOCK_WAIT_MS
): Promise<T> {
  const file = lockFile(privateDir, backend);
  const started = Date.now();
  while (!tryLock(file)) {
    if (Date.now() - started >= waitMs) throw new BackendLocked(`another change of ${backend} is running`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    return await work();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Whether a change of `backend` holds the lock now; a synchronous change refuses instead of waiting. */
export function backendLocked(privateDir: string, backend: BackendName): boolean {
  const file = lockFile(privateDir, backend);
  try {
    return alive(Number.parseInt(fs.readFileSync(file, 'utf8'), 10));
  } catch {
    return false;
  }
}
