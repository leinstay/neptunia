// The append store: durable JSONL files written one line at a time. The journal
// (and later the record and the archive) must survive a crash, a full or
// refusing disk and a concurrent forget without losing order or leaving a
// half-written line in the middle of a file, so every write to one file goes
// through a single serialized queue here:
//
//   - one open descriptor per file, appends chained on the file's queue, so
//     concurrent callers land whole lines in call order;
//   - fsync on demand (`sync`), every `fsyncMs`, on `flush` and on `close`;
//   - tail recovery on open: a last line without its newline (a crash between
//     write and fsync) is moved aside to `<file>.torn-<ts>` and cut off;
//   - a bounded retry queue: a failed write keeps the line in memory and is
//     retried every second; beyond `retryMax` queued lines `append` rejects
//     with code `append-stalled` so callers can pause what depends on it;
//   - `rewrite` (forget) streams to `<file>.tmp`, fsyncs and renames inside the
//     file's queue, so it never interleaves with an append.
//
// Logs carry the file's base name and counts, never line contents.

import * as nodeFs from 'node:fs/promises';
import { createReadStream as nodeCreateReadStream } from 'node:fs';
import path from 'node:path';
import { log as defaultLog } from '../log.js';

const RETRY_MS = 1000;
const TAIL_CHUNK = 64 * 1024;
const REWRITE_CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * Create an append store.
 *
 * @param {object} [options]
 * @param {number} [options.fsyncMs=500] fsync a file when this long has passed since its last fsync
 * @param {number} [options.retryMax=1000] queued (unwritten) lines across all files before `append` rejects
 * @param {{ info: Function, warn: Function }} [options.log] logger (`src/log.js` shape)
 * @param {() => number} [options.now=Date.now] clock, used for fsync spacing and torn-file names
 * @param {object} [options.fs] a `node:fs/promises`-shaped API (optionally with `createReadStream`)
 * @returns {{
 *   append(file: string, line: string, opts?: { sync?: boolean }): Promise<void>,
 *   flush(file?: string): Promise<void>,
 *   iterate(file: string, opts?: { from?: number }): AsyncIterable<{ offset: number, line: string }>,
 *   rewrite(file: string, keep: (line: string) => boolean): Promise<{ kept: number, dropped: number }>,
 *   recover(file: string): Promise<{ truncated: number, tornFile: string|null }>,
 *   stats(): { pending: number, failed: number, stalled: boolean },
 *   close(): Promise<void>,
 * }}
 *   `append` takes a line without its trailing newline; it resolves once written (and fsynced with
 *   `sync`), or once queued for retry when the write failed; it rejects with `code: 'append-stalled'`
 *   only when `retryMax` lines are already queued. `recover` reports `truncated` in bytes moved aside.
 *   `stats().failed` counts failed write attempts since creation.
 */
export function createAppendStore({ fsyncMs = 500, retryMax = 1000, log = defaultLog, now = Date.now, fs = nodeFs } = {}) {
  const files = new Map();
  let failedWrites = 0;
  const createReadStream = typeof fs.createReadStream === 'function' ? fs.createReadStream : nodeCreateReadStream;

  function entry(file) {
    let st = files.get(file);
    if (!st) {
      st = {
        fd: null, queue: Promise.resolve(), pendingLines: [], dirty: false, lastSync: 0,
        failing: false, retryTimer: null, syncTimer: null,
      };
      files.set(file, st);
    }
    return st;
  }

  function totalPending() {
    let n = 0;
    for (const st of files.values()) n += st.pendingLines.length;
    return n;
  }

  // Run `task` after everything already queued for this file; the chain never breaks on a rejection.
  function enqueue(file, task) {
    const st = entry(file);
    const run = st.queue.then(() => task(st));
    st.queue = run.catch(() => {});
    return run;
  }

  async function openFile(file, st) {
    if (st.fd) return st.fd;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await recover(file);
    st.fd = await fs.open(file, 'a');
    st.lastSync = now();
    return st.fd;
  }

  async function syncFile(file, st) {
    if (st.syncTimer) { clearTimeout(st.syncTimer); st.syncTimer = null; }
    if (!st.fd || !st.dirty) return;
    try {
      await st.fd.sync();
      st.dirty = false;
      st.lastSync = now();
    } catch (error) {
      log.warn('store: fsync failed', { file: path.basename(file), code: error?.code });
    }
  }

  function scheduleSync(file, st) {
    if (st.syncTimer || !st.dirty) return;
    st.syncTimer = setTimeout(() => {
      st.syncTimer = null;
      enqueue(file, (s) => syncFile(file, s)).catch(() => {});
    }, Math.max(0, fsyncMs));
    st.syncTimer.unref?.();
  }

  async function writeLine(file, st, line) {
    const fd = await openFile(file, st);
    await fd.write(`${line}\n`);
    st.dirty = true;
  }

  function scheduleRetry(file, st) {
    if (st.retryTimer) return;
    st.retryTimer = setTimeout(() => {
      st.retryTimer = null;
      enqueue(file, (s) => drain(file, s)).catch(() => {});
    }, RETRY_MS);
    st.retryTimer.unref?.();
  }

  function noteFailure(file, st) {
    failedWrites += 1;
    // A failed open or write may leave the descriptor unusable; reopen (and re-check the tail) next time.
    if (st.fd) {
      const fd = st.fd;
      st.fd = null;
      fd.close().catch(() => {});
    }
    if (!st.failing) {
      st.failing = true;
      log.warn('store: append failed', { file: path.basename(file), pending: st.pendingLines.length });
    }
    scheduleRetry(file, st);
  }

  // Write the queued lines in order; stop at the first failure and keep the rest.
  async function drain(file, st) {
    if (!st.pendingLines.length) return;
    let drained = 0;
    while (st.pendingLines.length) {
      try {
        await writeLine(file, st, st.pendingLines[0]);
      } catch {
        noteFailure(file, st);
        return;
      }
      st.pendingLines.shift();
      drained += 1;
    }
    if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
    st.failing = false;
    log.info('store: append recovered', { file: path.basename(file), drained });
    await syncFile(file, st);
  }

  /**
   * Move a torn tail (bytes after the last newline) to `<file>.torn-<now>` and cut the file to its
   * last whole line. A missing or clean file is left alone.
   */
  async function recover(file) {
    let size;
    try {
      size = (await fs.stat(file)).size;
    } catch (error) {
      if (error?.code === 'ENOENT') return { truncated: 0, tornFile: null };
      throw error;
    }
    if (!size) return { truncated: 0, tornFile: null };
    const fd = await fs.open(file, 'r');
    let cut = 0;
    let tail;
    try {
      const last = Buffer.alloc(1);
      await fd.read(last, 0, 1, size - 1);
      if (last[0] === NEWLINE) return { truncated: 0, tornFile: null };
      // Scan back chunk by chunk for the last newline.
      let end = size;
      const chunks = [];
      for (;;) {
        const start = Math.max(0, end - TAIL_CHUNK);
        const buf = Buffer.alloc(end - start);
        await fd.read(buf, 0, buf.length, start);
        const at = buf.lastIndexOf(NEWLINE);
        if (at >= 0) {
          cut = start + at + 1;
          chunks.unshift(buf.subarray(at + 1));
          break;
        }
        chunks.unshift(buf);
        if (start === 0) { cut = 0; break; }
        end = start;
      }
      tail = Buffer.concat(chunks);
    } finally {
      await fd.close();
    }
    const tornFile = `${file}.torn-${now()}`;
    await fs.writeFile(tornFile, tail);
    await fs.truncate(file, cut);
    log.warn('store: torn tail', { file: path.basename(file), bytes: tail.length });
    return { truncated: tail.length, tornFile };
  }

  /** Append one line (no trailing newline) to `file`, serialized with every other write to it. */
  function append(file, line, { sync = false } = {}) {
    return enqueue(file, async (st) => {
      if (totalPending() >= retryMax) {
        const error = new Error('append store stalled: retry queue is full');
        error.code = 'append-stalled';
        throw error;
      }
      if (st.pendingLines.length) {
        // Earlier lines still wait for the disk; keep the order.
        st.pendingLines.push(line);
        return;
      }
      try {
        await writeLine(file, st, line);
      } catch {
        st.pendingLines.push(line);
        noteFailure(file, st);
        return;
      }
      if (sync || now() - st.lastSync >= fsyncMs) await syncFile(file, st);
      else scheduleSync(file, st);
    });
  }

  /** Retry queued lines and fsync `file` (or every open file). */
  async function flush(file) {
    const targets = file === undefined ? [...files.keys()] : [file];
    await Promise.all(targets.map((f) => enqueue(f, async (st) => {
      await drain(f, st);
      await syncFile(f, st);
    })));
  }

  /** Stream whole lines of `file` from byte offset `from`; a tail without its newline is skipped. */
  async function* iterate(file, { from = 0 } = {}) {
    let stream;
    try {
      await fs.stat(file);
      stream = createReadStream(file, { start: from });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    let offset = from;
    let rest = Buffer.alloc(0);
    try {
      for await (const chunk of stream) {
        let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        let at;
        while ((at = buf.indexOf(NEWLINE)) >= 0) {
          const line = buf.subarray(0, at).toString('utf8');
          yield { offset, line };
          offset += at + 1;
          buf = buf.subarray(at + 1);
        }
        rest = buf;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    } finally {
      stream.destroy?.();
    }
  }

  /**
   * Keep only the lines `keep` accepts: stream into `<file>.tmp`, fsync, rename over `file`, all inside
   * the file's queue. A throwing `keep` leaves the file untouched. Lines still queued for retry are
   * filtered too.
   */
  function rewrite(file, keep) {
    return enqueue(file, async (st) => {
      if (st.fd) {
        await syncFile(file, st);
        const fd = st.fd;
        st.fd = null;
        await fd.close();
      }
      let kept = 0;
      let dropped = 0;
      const tmp = `${file}.tmp`;
      let exists = true;
      try {
        await fs.stat(file);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        exists = false;
      }
      if (exists) {
        await recover(file);
        const out = await fs.open(tmp, 'w');
        try {
          let buffer = '';
          for await (const { line } of iterate(file)) {
            if (keep(line)) {
              kept += 1;
              buffer += `${line}\n`;
              if (buffer.length >= REWRITE_CHUNK) { await out.write(buffer); buffer = ''; }
            } else dropped += 1;
          }
          if (buffer) await out.write(buffer);
          await out.sync();
        } catch (error) {
          await out.close().catch(() => {});
          await (fs.unlink ? fs.unlink(tmp) : fs.rm(tmp, { force: true })).catch(() => {});
          throw error;
        }
        await out.close();
        await fs.rename(tmp, file);
      }
      const before = st.pendingLines.length;
      st.pendingLines = st.pendingLines.filter((line) => keep(line));
      dropped += before - st.pendingLines.length;
      return { kept, dropped };
    });
  }

  /** Counts across all files; `stalled` once the retry queue holds `retryMax` lines. */
  function stats() {
    const pending = totalPending();
    return { pending, failed: failedWrites, stalled: pending >= retryMax };
  }

  /** Try the queued lines once more, fsync and close every file; lines still queued are reported. */
  async function close() {
    await Promise.all([...files.keys()].map((file) => enqueue(file, async (st) => {
      if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
      await drain(file, st);
      if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
      await syncFile(file, st);
      if (st.fd) {
        const fd = st.fd;
        st.fd = null;
        await fd.close().catch(() => {});
      }
      if (st.pendingLines.length) {
        log.warn('store: closed with pending', { file: path.basename(file), pending: st.pendingLines.length });
      }
    })));
  }

  return { append, flush, iterate, rewrite, recover, stats, close };
}
