// The memory database's writer thread (service.js starts it with `node:worker_threads`). It owns the writer
// connection (and so the writer lock, which it takes for the process) and runs every write, so no mapper and no write
// ever runs on the bot's main thread. One message at a time, in order.
//
// Messages in  { id, type: 'open', path, context }             open the database with the writer lock (`context`: what
//                                                               a migration needs from the opener, open.js#migrate)
//              { id, type: 'turnReads', turnId, step, rows }    the turn_reads rows, resolved by the caller at assembly time
//              { id, type: 'diaryApply', update }               one diary row's text and picture rows (diary-media.js)
//              { id, type: 'memoryWrite', update }              one write of her memory session or a description review, or
//                                                               of a memory unit (session-write.js, unit-write.js)
//              { id, type: 'focus', now, config }               the focus job: recount and recompute (focus.js#runFocusDay)
//              { id, type: 'observe', envelope, now, owner }    one observation of the live message path (observe.js#observe;
//                                                               `owner`: its record unit)
//              { id, type: 'close' }                            close the database, release the lock, then the thread ends
// Messages out { id, ok: true, result } | { id, ok: false, code }   one reply per message
//              { type: 'log', level, message, fields }              a line for the service's log (warnings only)
// Counts and codes only, never a path or a text.

import { parentPort } from 'node:worker_threads';
import process from 'node:process';
import { openMemoryDb } from './open.js';
import { insertTurnReads, turnReadRows } from './service.js';
import { applyDiaryUpdate } from './diary-media.js';
import { applyMemoryWrite } from './session-write.js';
import { runFocusDay } from './focus.js';
import { observe } from './observe.js';

let handle = null;

/** The service owns the lock for this process, so a lock left by a worker that died is ours to take over. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const post = (message) => parentPort.postMessage(message);
const log = {
  info() {},
  debug() {},
  error() {},
  warn: (message, fields) => post({ type: 'log', level: 'warn', message, fields }),
};

const handlers = {
  open({ path, context }) {
    handle = openMemoryDb(path, { alive, context: context ?? {} });
    return {};
  },
  turnReads({ turnId, step, guildId, reads, rows: given }) {
    // The rows are resolved by the caller at assembly time; a caller that sends the raw reads gets them resolved here.
    const rows = Array.isArray(given) ? given : turnReadRows(handle.db, reads, { guildId });
    if (rows.length === 0) return { rows: 0 };
    insertTurnReads(handle, turnId, step, rows);
    return { rows: rows.length };
  },
  diaryApply({ update }) {
    applyDiaryUpdate(handle, update);
    return {};
  },
  memoryWrite({ update }) {
    return applyMemoryWrite(handle, update);
  },
  focus({ now, config }) {
    return runFocusDay(handle, { now, config });
  },
  observe({ envelope, now, owner }) {
    return observe(handle, envelope, { now: () => now, log, owner: owner ?? null });
  },
  close() {
    handle?.close();
    handle = null;
    return {};
  },
};

parentPort.on('message', (message) => {
  const { id, type } = message;
  try {
    post({ id, ok: true, result: handlers[type](message) });
  } catch (error) {
    post({ id, ok: false, code: error?.code ?? error?.name ?? 'ERROR' });
  }
  if (type === 'close') parentPort.close();
});
