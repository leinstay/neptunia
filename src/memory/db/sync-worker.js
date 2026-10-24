// The memory database's writer thread (service.js starts it with `node:worker_threads`). It owns the writer
// connection (and so the writer lock, which it takes for the process), runs the sync passes and writes the
// turn_reads rows, so no mapper and no write ever runs on the bot's main thread. One message at a time, in order.
//
// Messages in  { id, type: 'open', path }                      open the database with the writer lock
//              { id, type: 'pass', first, now }                 one sync pass (`first`: the full import, marked done)
//              { id, type: 'turnReads', turnId, step, rows }                   the turn_reads rows, resolved by the caller at assembly time
//              { id, type: 'diaryApply', update }                one diary row's text and picture rows (diary-media.js)
//              { id, type: 'memoryWrite', update }                one write of her memory session or a description review (session-write.js)
//              { id, type: 'close' }                            close the database, release the lock, then the thread ends
// Messages out { id, ok: true, result } | { id, ok: false, code }   one reply per message
//              { type: 'log', level, message, fields }              a line for the service's log (warnings only)
// Counts and codes only, never a path or a text.

import { parentPort, workerData } from 'node:worker_threads';
import process from 'node:process';
import { openMemoryDb } from './open.js';
import { syncOnce } from './sync.js';
import { insertTurnReads, turnReadRows } from './service.js';
import { applyDiaryUpdate } from './diary-media.js';
import { applyMemoryWrite } from './session-write.js';

const IMPORT_DONE = 'service_import_done';
const dataDir = workerData?.dataDir;
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
  info() {}, debug() {}, error() {},
  warn: (message, fields) => post({ type: 'log', level: 'warn', message, fields }),
};
const metaOf = (key) => handle.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;

const handlers = {
  open({ path }) {
    handle = openMemoryDb(path, { alive });
    return { importDone: metaOf(IMPORT_DONE) === '1' };
  },
  pass({ first, now, authority }) {
    // The database is the writer: the sync is off, whatever asks for it.
    if (authority === 'db') throw Object.assign(new Error('sync is off'), { code: 'SYNC_OFF' });
    const result = syncOnce(handle, dataDir, { now: () => now, log });
    let importDone = false;
    if (first && result.errors === 0) {
      handle.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(IMPORT_DONE, '1');
      importDone = true;
    }
    return { seen: result.seen, changed: result.changed, upserted: result.upserted, retired: result.retired, errors: result.errors, importDone };
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
