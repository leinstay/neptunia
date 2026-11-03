// The memory database's writer thread (service.ts starts it with `node:worker_threads`). It owns the writer
// connection (and so the writer lock, which it takes for the process) and runs every write, so no mapper and no write
// ever runs on the bot's main thread. One message at a time, in order.
//
// Messages in  { id, type: 'open', path, context }             open the database with the writer lock (`context`: what
//                                                               a migration needs from the opener, open.ts#migrate)
//              { id, type: 'turnReads', turnId, step, rows }    the turn_reads rows, resolved by the caller at assembly time
//              { id, type: 'diaryApply', update }               one diary row's text and picture rows (diary-media.ts)
//              { id, type: 'memoryWrite', update }              one write of her memory session or a description review, or
//                                                               of a memory unit (session-write.ts, unit-write.ts)
//              { id, type: 'focus', now, config }               the focus job: recount and recompute (focus.ts#runFocusDay)
//              { id, type: 'observe', envelope, now, owner }    one observation of the live message path (observe.ts#observe;
//                                                               `owner`: its record unit)
//              { id, type: 'close' }                            close the database, release the lock, then the thread ends
// Messages out { id, ok: true, result } | { id, ok: false, code }   one reply per message
//              { type: 'log', level, message, fields }              a line for the service's log (warnings only)
// Counts and codes only, never a path or a text.

import { parentPort } from 'node:worker_threads';
import process from 'node:process';
import { importCoreJsonState } from './core-state-import.ts';
import { openMemoryDb } from './open.ts';
import { insertTurnReads, turnReadRows } from './service.ts';
import { applyDiaryUpdate } from './diary-media.ts';
import { applyMemoryWrite } from './session-write.ts';
import { runFocusDay } from './focus.ts';
import { deleteMessage, observeMessage } from './message-families.ts';
import { observe } from './observe.ts';
import { dbOf } from './types.ts';
import type { Config, MemoryHandle, Row } from './types.ts';

if (parentPort === null) throw new Error('the memory writer worker runs only as a worker thread of the service');
const port = parentPort;

let handle: MemoryHandle | null = null;

/** The open handle, or a refusal: every message but `open` and `close` needs it. */
function opened(): MemoryHandle {
  if (handle === null) throw Object.assign(new Error('the memory writer has no open database'), { code: 'DB_CLOSED' });
  return handle;
}

/** The service owns the lock for this process, so a lock left by a worker that died is ours to take over. */
function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

const post = (message: Row): void => port.postMessage(message);
const log = {
  info() {},
  debug() {},
  error() {},
  warn: (message: string, fields?: Row): void => post({ type: 'log', level: 'warn', message, fields }),
};

const handlers: Record<string, (message: Row) => unknown> = {
  open({ path, context, now }) {
    handle = openMemoryDb(path, { alive, context: context ?? {} });
    const dataDir = (context as Row | undefined)?.dataDir;
    if (typeof dataDir === 'string')
      importCoreJsonState(handle, { dataDir, ...(typeof now === 'number' ? { now } : {}) });
    return {};
  },
  turnReads({ turnId, step, guildId, reads, rows: given }) {
    // The rows are resolved by the caller at assembly time; a caller that sends the raw reads gets them resolved here.
    const open = opened();
    const rows = Array.isArray(given)
      ? (given as Array<Row>)
      : turnReadRows(dbOf(open), reads, { guildId: guildId as string | undefined });
    if (rows.length === 0) return { rows: 0 };
    insertTurnReads(open, turnId as string, step, rows);
    return { rows: rows.length };
  },
  diaryApply({ update }) {
    applyDiaryUpdate(opened(), update);
    return {};
  },
  memoryWrite({ update }) {
    return applyMemoryWrite(opened(), update);
  },
  focus({ now, config }) {
    return runFocusDay(opened(), { now: now as number, config: config as Config });
  },
  deleteMessage({ envelope, now, owner }) {
    return deleteMessage(opened(), envelope, {
      now: () => now as number,
      log,
      owner: (owner as string | null) ?? null,
    });
  },
  observeMessage({ envelope, now, owner }) {
    return observeMessage(opened(), envelope, {
      now: () => now as number,
      log,
      owner: (owner as string | null) ?? null,
    });
  },
  observe({ envelope, now, owner }) {
    return observe(opened(), envelope, { now: () => now as number, log, owner: (owner as string | null) ?? null });
  },
  close() {
    handle?.close();
    handle = null;
    return {};
  },
};

port.on('message', (message: Row) => {
  const { id, type } = message;
  try {
    const handler = handlers[type as string];
    post({ id, ok: true, result: handler(message) });
  } catch (error) {
    const { code, name } = (error ?? {}) as { code?: string; name?: string };
    post({ id, ok: false, code: code ?? name ?? 'ERROR' });
  }
  if (type === 'close') port.close();
});
