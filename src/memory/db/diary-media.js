// The diary's own copy of what she posted (spec 2026-10-24-memory-store, section 9). `diary.json` holds only a gist
// and the message ids a post was sent as; the post's text and its pictures live on the platform. This job asks
// the interface (port.fetchMessages) for those messages, stores the text in `diary.text`, downloads each image to
// `data/media/diary/<diary id>-<n>.<ext>` and records it as a `media` row (kind diary, owner the diary id, the
// scope of the diary row). The diary here is the one truth: a post whose messages the platform no longer has keeps what the
// database holds (its gist), and its text is set empty so it is not asked for again. The posts on the platform are mirrors;
// the files here are the core's copy. Other people's media are never fetched here (they stay references).
//
// One-shot and idempotent. `run()` handles every pending row (a live diary row with message ids and no text) once
// per start: a row that failed is left alone until the next start, a row the sync brings later is picked up by
// the next `run()`. At most one fetch per `GAP_MS`. Nothing is written for a row until all its pictures arrived, so
// a failure leaves it whole for the next start; files are written atomically (temp file, then rename) under
// deterministic names, so a repeat overwrites with the same bytes. The row writes (`applyDiaryUpdate`) run on the
// writer connection: in the sync worker thread, or on the calling thread when there is none. The export ignores
// `text` (the old JSON has no such field). Logs carry counts and codes only.
//
// Audio: an `audio/*` attachment (a voice message, or mp3 / m4a / wav) is saved next to the pictures, in the same
// numbering, under the cap `memoryDb.diaryAudioMaxBytes` (default 8 MB) and the same timeout, with a plain fetch
// (the image fetcher takes pictures only). Its `media` row carries `extra` `{ voice: true, text?, durationSec? }`: the
// text and duration come from the post's `voice` field when its `messageId` is this message, else the attachment's own
// duration. A post that already has its text is fetched again only when it has a `voice` field and no audio row.
//
// Schema v9: each `media` row written is projected into the graph in the same transaction (graph.js#projectRow).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { audienceOf } from './scope.ts';
import { ensureAudience } from './rows.js';
import { projectRow } from './graph.js';
import { diaryPlaces } from '../../behavior/mirror.ts';

export const GAP_MS = 1000;
const MEDIA_DIR = path.join('media', 'diary');
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const AUDIO_EXTENSIONS = { ogg: 'ogg', oga: 'ogg', opus: 'ogg', mp3: 'mp3', m4a: 'm4a', wav: 'wav' };
export const DEFAULT_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
const noop = () => {};
const silent = { info: noop, warn: noop, error: noop, debug: noop };

/** A file-name-safe form of a diary id. */
const safeName = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

const isImage = (attachment) =>
  /^image\//i.test(attachment?.contentType ?? '') || /\.(png|jpe?g|gif|webp)$/i.test(attachment?.name ?? '');

const isAudio = (attachment) =>
  /^audio\//i.test(attachment?.contentType ?? '') ||
  (!attachment?.contentType && /\.(ogg|oga|opus|mp3|m4a|wav)$/i.test(attachment?.name ?? ''));

/** The file extension of an audio attachment: from its mime type, else from its name. */
function audioExtension(mime, name) {
  const type = String(mime ?? '').toLowerCase();
  if (/ogg|opus/.test(type)) return 'ogg';
  if (/mpeg|mp3/.test(type)) return 'mp3';
  if (/mp4|m4a|aac/.test(type)) return 'm4a';
  if (/wav|wave/.test(type)) return 'wav';
  const ext = /\.([A-Za-z0-9]+)$/.exec(name ?? '')?.[1]?.toLowerCase();
  return AUDIO_EXTENSIONS[ext] ?? 'bin';
}

/**
 * The diary rows still to fill: live, mirrored, and either no text yet or (a post saved before audio was
 * kept) a `voice` field in its extra with no audio media row. Each carries the post's `voice` object, if any, and the
 * conversation it was posted to: the place its publication names, else the place her diary is posted to
 * (src/behavior/mirror.ts#diaryPlaces, the first), else null.
 */
export function pendingDiaryRows(db) {
  const fallbackId = diaryPlaces(db)[0]?.conversationId ?? null;
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.scope_kind AS scope_kind, d.scope_iface AS scope_iface, d.scope_dm AS scope_dm, m.native_ids AS native_ids, d.extra AS extra,
         (SELECT p.native_id FROM publications x JOIN places p ON p.id = x.destination_place_id
           WHERE x.row_kind = 'diary' AND x.row_id = d.id ORDER BY x.created_at, x.id LIMIT 1) AS conversation_id
       FROM diary d JOIN diary_mirrors m ON m.diary_id = d.id
      WHERE d.retired_at IS NULL AND m.retired_at IS NULL
        AND (d.text IS NULL
          OR (json_type(d.extra, '$.voice') = 'object'
            AND NOT EXISTS (SELECT 1 FROM media x WHERE x.kind = 'diary' AND x.owner = d.id AND x.mime LIKE 'audio/%')))
      ORDER BY d.position, d.rowid`
    )
    .all();
  const out = [];
  for (const row of rows) {
    let ids;
    try {
      ids = JSON.parse(row.native_ids);
    } catch {
      continue;
    }
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) continue;
    let voice = null;
    try {
      const parsed = JSON.parse(row.extra ?? 'null')?.voice;
      if (parsed && typeof parsed === 'object') voice = parsed;
    } catch {
      /* an unreadable extra means no voice field */
    }
    const { extra: _extra, conversation_id: conversationId, ...rest } = row;
    out.push({
      ...rest,
      conversationId: typeof conversationId === 'string' ? conversationId : fallbackId,
      messageIds: ids,
      voice,
    });
  }
  return out;
}

/**
 * Writes one row's result on the writer connection: `{ id, text, media: [{ id, path, nativeRef, sha1, bytes, mime, extra? }] }`.
 * The media rows take the diary row's scope and its audience (scope.ts#audienceOf, the one resolver). One transaction.
 */
export function applyDiaryUpdate(handle, update) {
  handle.transaction(() => {
    const db = handle.db;
    const diary = db.prepare('SELECT scope_kind, scope_iface, scope_dm FROM diary WHERE id = ?').get(update.id);
    if (!diary) return;
    // A refetch (for audio) never replaces a text the row already holds: only an empty or missing text is filled.
    db.prepare(
      "UPDATE diary SET text = CASE WHEN text IS NOT NULL AND text <> '' THEN text ELSE ? END WHERE id = ?"
    ).run(update.text ?? '', update.id);
    const insert = db.prepare(
      `INSERT INTO media (id, kind, owner, path, native_ref, sha1, bytes, mime, scope_kind, scope_iface, scope_dm, extra, retired_at, audience_id)
       VALUES (?, 'diary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, native_ref = excluded.native_ref, sha1 = excluded.sha1,
         bytes = excluded.bytes, mime = excluded.mime, scope_kind = excluded.scope_kind, scope_iface = excluded.scope_iface,
         scope_dm = excluded.scope_dm, extra = excluded.extra, retired_at = NULL, audience_id = excluded.audience_id`
    );
    const audience = audienceOf(diary);
    if ((update.media ?? []).length > 0) ensureAudience(db, audience);
    for (const item of update.media ?? []) {
      insert.run(
        item.id,
        update.id,
        item.path,
        item.nativeRef,
        item.sha1,
        item.bytes,
        item.mime,
        diary.scope_kind,
        diary.scope_iface,
        diary.scope_dm,
        item.extra ?? null,
        audience.audience_id
      );
      projectRow(db, 'media', { id: item.id });
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

/** Downloads `url` with a plain fetch under a byte cap and a timeout; `{ buffer, contentType }` or null. */
async function downloadPlain(fetchImpl, url, { maxBytes, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : 15000),
    });
  } catch {
    return null;
  }
  if (!response?.ok) return null;
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && Number.isFinite(maxBytes) && declared > maxBytes) return null;
  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
  if (Number.isFinite(maxBytes) && buffer.byteLength > maxBytes) return null;
  return {
    buffer,
    contentType: String(response.headers?.get?.('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase(),
  };
}

/**
 * @param {{ db: () => object|null, apply: (update: object) => Promise<void>|void, port: () => object|null,
 *   imageFetcher: () => { fetchAsDataUrl: Function }|null, config: () => object, dataDir: string, log?: object,
 *   sleep?: (ms: number) => Promise<void> }} options
 *   Everything that changes is a getter (read at the moment of use). `db` is a connection that can read the diary;
 *   `apply` writes one update (applyDiaryUpdate on the writer); `sleep` is injected by the tests.
 */
export function createDiaryMedia({
  db,
  apply,
  port,
  imageFetcher,
  config,
  dataDir,
  log = silent,
  sleep,
  setTimer = setTimeout,
  fetchImpl = fetch,
}) {
  let stopped = false;
  let running = null;
  let wake = null;
  const attempted = new Set();
  const pause =
    sleep ??
    ((ms) =>
      new Promise((resolve) => {
        const timer = setTimer(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }));

  const codeOf = (error) => error?.code ?? error?.name ?? 'ERROR';

  /** The settings of this moment. */
  function settings() {
    const cfg = config() ?? {};
    return {
      maxBytes: cfg.image?.referenceMaxBytes,
      timeoutMs: cfg.context?.vision?.fetchTimeoutMs,
      audioMaxBytes: Number.isFinite(cfg.memoryDb?.diaryAudioMaxBytes)
        ? cfg.memoryDb.diaryAudioMaxBytes
        : DEFAULT_AUDIO_MAX_BYTES,
    };
  }

  /** One row: fetch, download, write. Returns 'done' or 'failed'. */
  async function handleRow(row, { maxBytes, timeoutMs, audioMaxBytes }, adapter, fetcher) {
    const conversation = { iface: adapter.iface, conversationId: row.conversationId };
    const result = await adapter.fetchMessages(conversation, row.messageIds);
    if (result?.status !== 'ok' || !Array.isArray(result.messages)) {
      log.warn('diary media: fetch failed', { code: result?.error?.code ?? result?.status ?? 'ERROR' });
      return 'failed';
    }
    const byId = new Map(result.messages.map((message) => [message.messageId, message]));
    const present = row.messageIds.map((id) => byId.get(id)).filter((message) => message && !message.missing);
    if (present.length === 0) {
      // Nothing of it is left on the platform: the database keeps what it has; an empty text marks it fetched.
      await apply({ id: row.id, text: '', media: [] });
      return 'done';
    }
    const text = present
      .map((message) => (typeof message.text === 'string' ? message.text : ''))
      .filter((part) => part !== '')
      .join('\n');
    const media = [];
    const base = safeName(row.id);
    let n = 0;
    for (const message of present) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.url && isAudio(attachment)) {
          if (Number.isFinite(attachment.size) && attachment.size > audioMaxBytes) {
            log.warn('diary media: audio over the cap', { bytes: attachment.size });
            continue;
          }
          const got = await downloadPlain(fetchImpl, attachment.url, { maxBytes: audioMaxBytes, timeoutMs });
          if (!got) {
            log.warn('diary media: download failed', { code: 'DOWNLOAD' });
            return 'failed';
          }
          n += 1;
          const mime = attachment.contentType || got.contentType || 'audio/ogg';
          const rel = path.join(MEDIA_DIR, `${base}-${n}.${audioExtension(mime, attachment.name)}`);
          writeAtomic(path.join(dataDir, rel), got.buffer);
          const matched = row.voice && row.voice.messageId === message.messageId;
          const extra = { voice: true };
          if (matched && typeof row.voice.text === 'string') extra.text = row.voice.text;
          const duration =
            matched && Number.isFinite(row.voice.durationSec)
              ? row.voice.durationSec
              : Number.isFinite(attachment.durationSec)
                ? attachment.durationSec
                : null;
          if (duration !== null) extra.durationSec = duration;
          media.push({
            id: `media:diary:${base}-${n}`,
            path: rel.split(path.sep).join('/'),
            nativeRef: JSON.stringify({ url: attachment.url, messageId: message.messageId }),
            sha1: createHash('sha1').update(got.buffer).digest('hex'),
            bytes: got.buffer.byteLength,
            mime,
            extra: JSON.stringify(extra),
          });
          continue;
        }
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
    await apply({ id: row.id, text, media });
    return 'done';
  }

  async function runOnce() {
    const counts = { done: 0, failed: 0 };
    const database = db();
    const adapter = port();
    const fetcher = imageFetcher();
    const given = settings();
    if (!database || !adapter?.fetchMessages || !fetcher) return counts;
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
    if (counts.done + counts.failed > 0) log.info('diary media: pass', counts);
    return counts;
  }

  return {
    /** Handles the rows pending now that were not tried in this start; one run at a time (a call during a run returns it). */
    run() {
      if (running) return running;
      running = runOnce().finally(() => {
        running = null;
      });
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
