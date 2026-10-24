// The diary's own copy of what she posted (spec 2026-10-24-memory-store, section 9). `diary.json` holds only a gist
// and the Discord message ids a post was sent as; the post's text and its pictures live in Discord. This job asks
// the interface (port.fetchMessages) for those messages, stores the text in `diary.text`, downloads each image to
// `data/media/diary/<diary id>-<n>.<ext>` and records it as a `media` row (kind diary, owner the diary id, the
// scope of the diary row). A post whose messages are all gone is marked `lost = 1`. The Discord posts are mirrors;
// the files here are the core's copy. Other people's media are never fetched here (they stay references).
//
// One-shot and idempotent. `run()` handles every pending row (a live diary row with message ids and no text) once
// per start: a row that failed is left alone until the next start, a row the sync brings later is picked up by
// the next `run()`. At most one fetch per `GAP_MS`. Nothing is written for a row until all its pictures arrived, so
// a failure leaves it whole for the next start; files are written atomically (temp file, then rename) under
// deterministic names, so a repeat overwrites with the same bytes. The row writes (`applyDiaryUpdate`) run on the
// writer connection: in the sync worker thread, or on the calling thread when there is none. The export ignores
// `text` and `lost` (the old JSON has no such fields). Logs carry counts and codes only.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const GAP_MS = 1000;
const MEDIA_DIR = path.join('media', 'diary');
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const noop = () => {};
const silent = { info: noop, warn: noop, error: noop, debug: noop };

/** A file-name-safe form of a diary id. */
const safeName = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

const isImage = (attachment) => /^image\//i.test(attachment?.contentType ?? '')
  || /\.(png|jpe?g|gif|webp)$/i.test(attachment?.name ?? '');

/** The diary rows still to fill: live, mirrored, no text yet, not lost. */
export function pendingDiaryRows(db) {
  const rows = db.prepare(
    `SELECT d.id AS id, d.scope_kind AS scope_kind, d.scope_iface AS scope_iface, d.scope_dm AS scope_dm, m.native_ids AS native_ids
       FROM diary d JOIN diary_mirrors m ON m.diary_id = d.id
      WHERE d.retired_at IS NULL AND d.text IS NULL AND (d.lost IS NULL OR d.lost = 0)
      ORDER BY d.position, d.rowid`,
  ).all();
  const out = [];
  for (const row of rows) {
    let ids;
    try { ids = JSON.parse(row.native_ids); } catch { continue; }
    if (Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string')) out.push({ ...row, messageIds: ids });
  }
  return out;
}

/**
 * Writes one row's result on the writer connection: `{ id, text, lost, media: [{ id, path, nativeRef, sha1, bytes, mime }] }`.
 * The media rows take the diary row's scope. One transaction.
 */
export function applyDiaryUpdate(handle, update) {
  handle.transaction(() => {
    const db = handle.db;
    const diary = db.prepare('SELECT scope_kind, scope_iface, scope_dm FROM diary WHERE id = ?').get(update.id);
    if (!diary) return;
    if (update.lost) db.prepare('UPDATE diary SET lost = 1 WHERE id = ?').run(update.id);
    else db.prepare('UPDATE diary SET text = ?, lost = NULL WHERE id = ?').run(update.text ?? '', update.id);
    const insert = db.prepare(
      `INSERT INTO media (id, kind, owner, path, native_ref, sha1, bytes, mime, scope_kind, scope_iface, scope_dm, retired_at)
       VALUES (?, 'diary', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, native_ref = excluded.native_ref, sha1 = excluded.sha1,
         bytes = excluded.bytes, mime = excluded.mime, scope_kind = excluded.scope_kind, scope_iface = excluded.scope_iface,
         scope_dm = excluded.scope_dm, retired_at = NULL`,
    );
    for (const item of update.media ?? []) {
      insert.run(item.id, update.id, item.path, item.nativeRef, item.sha1, item.bytes, item.mime, diary.scope_kind, diary.scope_iface, diary.scope_dm);
    }
  });
}

/** Writes `buffer` to `abs` atomically. */
function writeAtomic(abs, buffer) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, abs);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * @param {{ db: () => object|null, apply: (update: object) => Promise<void>|void, port: () => object|null,
 *   imageFetcher: () => { fetchAsDataUrl: Function }|null, config: () => object, dataDir: string, log?: object,
 *   sleep?: (ms: number) => Promise<void> }} options
 *   Everything that changes is a getter (read at the moment of use). `db` is a connection that can read the diary;
 *   `apply` writes one update (applyDiaryUpdate on the writer); `sleep` is injected by the tests.
 */
export function createDiaryMedia({ db, apply, port, imageFetcher, config, dataDir, log = silent, sleep, setTimer = setTimeout }) {
  let stopped = false;
  let running = null;
  let wake = null;
  const attempted = new Set();
  const pause = sleep ?? ((ms) => new Promise((resolve) => {
    const timer = setTimer(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  }));

  const codeOf = (error) => error?.code ?? error?.name ?? 'ERROR';

  /** The settings of this moment. */
  function settings() {
    const cfg = config() ?? {};
    return {
      channelId: typeof cfg.diary?.channelId === 'string' ? cfg.diary.channelId : '',
      maxBytes: cfg.image?.referenceMaxBytes,
      timeoutMs: cfg.context?.vision?.fetchTimeoutMs,
    };
  }

  /** One row: fetch, download, write. Returns 'done', 'lost' or 'failed'. */
  async function handleRow(row, { channelId, maxBytes, timeoutMs }, adapter, fetcher) {
    const result = await adapter.fetchMessages({ iface: adapter.iface, conversationId: channelId }, row.messageIds);
    if (result?.status !== 'ok' || !Array.isArray(result.messages)) {
      log.warn('diary media: fetch failed', { code: result?.error?.code ?? result?.status ?? 'ERROR' });
      return 'failed';
    }
    const byId = new Map(result.messages.map((message) => [message.messageId, message]));
    const present = row.messageIds.map((id) => byId.get(id)).filter((message) => message && !message.missing);
    if (present.length === 0) {
      await apply({ id: row.id, lost: true });
      return 'lost';
    }
    const text = present.map((message) => (typeof message.text === 'string' ? message.text : '')).filter((part) => part !== '').join('\n');
    const media = [];
    const base = safeName(row.id);
    let n = 0;
    for (const message of present) {
      for (const attachment of message.attachments ?? []) {
        if (!isImage(attachment) || !attachment.url) continue;
        if (Number.isFinite(attachment.size) && Number.isFinite(maxBytes) && attachment.size > maxBytes) {
          log.warn('diary media: picture over the cap', { bytes: attachment.size });
          continue;
        }
        const downloaded = await fetcher.fetchAsDataUrl(attachment.url, { maxBytes, timeoutMs });
        if (!downloaded) {
          log.warn('diary media: download failed', { code: 'DOWNLOAD' });
          return 'failed';
        }
        const comma = downloaded.dataUrl.indexOf(',');
        const buffer = Buffer.from(downloaded.dataUrl.slice(comma + 1), 'base64');
        n += 1;
        const mime = downloaded.contentType;
        const rel = path.join(MEDIA_DIR, `${base}-${n}.${EXTENSIONS[mime] ?? 'bin'}`);
        writeAtomic(path.join(dataDir, rel), buffer);
        media.push({
          id: `media:diary:${base}-${n}`,
          path: rel.split(path.sep).join('/'),
          nativeRef: JSON.stringify({ url: attachment.url, messageId: message.messageId }),
          sha1: createHash('sha1').update(buffer).digest('hex'),
          bytes: buffer.byteLength,
          mime,
        });
      }
    }
    await apply({ id: row.id, text, lost: false, media });
    return 'done';
  }

  async function runOnce() {
    const counts = { done: 0, lost: 0, failed: 0 };
    const database = db();
    const adapter = port();
    const fetcher = imageFetcher();
    const given = settings();
    if (!database || !adapter?.fetchMessages || !fetcher || !given.channelId) return counts;
    let rows;
    try {
      rows = pendingDiaryRows(database).filter((row) => !attempted.has(row.id));
    } catch (error) {
      log.warn('diary media: read failed', { code: codeOf(error) });
      return counts;
    }
    let first = true;
    for (const row of rows) {
      if (stopped) break;
      if (!first) await pause(GAP_MS);
      first = false;
      if (stopped) break;
      attempted.add(row.id);
      try {
        counts[await handleRow(row, given, adapter, fetcher)] += 1;
      } catch (error) {
        counts.failed += 1;
        log.warn('diary media: row failed', { code: codeOf(error) });
      }
    }
    if (counts.done + counts.lost + counts.failed > 0) log.info('diary media: pass', counts);
    return counts;
  }

  return {
    /** Handles the rows pending now that were not tried in this start; one run at a time (a call during a run returns it). */
    run() {
      if (running) return running;
      running = runOnce().finally(() => { running = null; });
      return running;
    },
    /** Rows still waiting that this start has not tried: a cheap check before `run()`. */
    hasWork() {
      try {
        const database = db();
        return Boolean(database) && pendingDiaryRows(database).some((row) => !attempted.has(row.id));
      } catch {
        return false;
      }
    },
    /** Ends the run under way after its current row. */
    stop() {
      stopped = true;
      wake?.();
      return running ?? Promise.resolve();
    },
  };
}
