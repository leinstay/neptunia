// The selfreflection's own copy of what she posted (spec 2026-10-24-memory-store, section 9). The selfreflection unit holds only a gist
// and the message ids a post was sent as; the post's text and its pictures live on the platform. This job asks
// the interface (port.fetchMessages) for those messages, stores the text in `selfreflection.text`, downloads each image to
// `data/media/selfreflection/<selfreflection id>-<n>.<ext>` and records it as a `media` row (kind selfreflection, owner the selfreflection id, the
// scope of the selfreflection row). The selfreflection here is the one truth: a post whose messages the platform no longer has keeps what the
// database holds (its gist), and its text is set empty so it is not asked for again. The posts on the platform are mirrors;
// the files here are the core's copy. Other people's media are never fetched here (they stay references).
//
// One-shot and idempotent. `run()` handles every pending row (a live selfreflection row with message ids and no text) once
// per start: a row that failed is left alone until the next start, a row the sync brings later is picked up by
// the next `run()`. At most one fetch per `GAP_MS`. Nothing is written for a row until all its pictures arrived, so
// a failure leaves it whole for the next start; files are written atomically (temp file, then rename) under
// deterministic names, so a repeat overwrites with the same bytes. The row writes (`applySelfreflectionUpdate`) run on the
// writer connection: in the sync worker thread, or on the calling thread when there is none. The export ignores
// `text` (the old JSON has no such field). Logs carry counts and codes only.
//
// Audio: an `audio/*` attachment (a voice message, or mp3 / m4a / wav) is saved next to the pictures, in the same
// numbering, under the cap `DEFAULT_AUDIO_MAX_BYTES` (8 MB) and the same timeout, with a plain fetch
// (the image fetcher takes pictures only). Its `media` row carries `extra` `{ voice: true, text?, durationSec? }`: the
// text and duration come from the post's `voice` field when its `messageId` is this message, else the attachment's own
// duration. A post that already has its text is fetched again only when it has a `voice` field and no audio row.
//
// Schema v9: each `media` row written is projected into the graph in the same transaction (graph.ts#projectRow).

import { ENTRY_MEDIA, writeEntryFiles } from './media-store.ts';
import type { EntryFile } from './media-store.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { audienceOf } from './scope.ts';
import { ensureAudience } from './rows.ts';
import { selfreflectionPlaces } from './mirrors.ts';
import { REFERENCE_MAX_BYTES } from '../../media/fetch-image.ts';
import { dbOf, asText, isFiniteNumber } from './types.ts';
import type { Config, Db, Log, MemoryHandle, Row } from './types.ts';

export const GAP_MS = 1000;

/** A link that is down: nothing was asked of the platform. */
const LINK_CLOSED = 'link-closed';

/** The platform refused to show that chat. */
const FORBIDDEN = 'http-403';

/** What a read the interface did not answer makes of a row; a closed link asked nothing of the platform and logs nothing. */
function refusedRow(code: unknown, log: Log): 'closed' | 'forbidden' | 'failed' {
  if (code === LINK_CLOSED) return 'closed';
  log.warn('selfreflection media: fetch failed', { code });
  return code === FORBIDDEN ? 'forbidden' : 'failed';
}
const MEDIA_DIR = path.join('media', 'selfreflection');
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const AUDIO_EXTENSIONS: Record<string, string> = {
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  mp3: 'mp3',
  m4a: 'm4a',
  wav: 'wav',
};
/** The largest voice file a selfreflection post keeps, in bytes. Production value, config cut of 2026-10-31. */
export const DEFAULT_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
const noop = () => {};
const silent: Log = { info: noop, warn: noop, error: noop, debug: noop };

/** One attachment of a fetched message, as a read lists it. */
type FetchedAttachment = {
  id?: unknown;
  url?: string;
  name?: string;
  contentType?: string;
  size?: unknown;
  durationSec?: unknown;
};
/** A message a read found, with the event it came in (its attachments carry their own ids). */
type FetchedMessage = {
  messageId: string;
  missing?: boolean;
  text?: unknown;
  attachments?: Array<FetchedAttachment>;
  event?: { message?: { attachments?: Array<{ id?: unknown; url?: unknown }> } };
};
/** The interface port as the job uses it: its name and the read of messages. */
export type SelfreflectionPort = {
  iface: string;
  fetchMessages?: (
    chat: { iface: string; chatId: string },
    ids: ReadonlyArray<string>
  ) => Promise<{ status?: string; error?: { code?: unknown }; messages?: Array<FetchedMessage> } | undefined>;
};
/** The image fetcher as the job uses it. */
export type ImageFetcher = {
  fetchAsDataUrl(
    url: string,
    options: { maxBytes: number; timeoutMs: number | undefined }
  ): Promise<{ dataUrl: string; contentType: string } | null | undefined>;
};
/** The job that fills the selfreflection's rows with the text and pictures of their messages. */
export type SelfreflectionMediaJob = {
  run(): Promise<{ done: number; failed: number }>;
  hasWork(): boolean;
  stop(): Promise<unknown>;
};
/** A row of her selfreflection still to fill (see `pendingSelfreflectionRows`). */
export type PendingSelfreflectionRow = {
  id: string;
  scope_kind: unknown;
  scope_iface: unknown;
  scope_dm: unknown;
  native_ids: unknown;
  chatId: string | null;
  messageIds: Array<string>;
  voice: { messageId?: unknown; text?: unknown; durationSec?: unknown } | null;
};

/** A file-name-safe form of a selfreflection id. */
const safeName = (id: unknown): string => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

const isImage = (attachment: FetchedAttachment): boolean =>
  /^image\//i.test(attachment?.contentType ?? '') || /\.(png|jpe?g|gif|webp)$/i.test(attachment?.name ?? '');

const isAudio = (attachment: FetchedAttachment): boolean =>
  /^audio\//i.test(attachment?.contentType ?? '') ||
  (!attachment?.contentType && /\.(ogg|oga|opus|mp3|m4a|wav)$/i.test(attachment?.name ?? ''));

/** The file extension of an audio attachment: from its mime type, else from its name. */
function audioExtension(mime: unknown, name: string | undefined): string {
  const type = asText(mime ?? '').toLowerCase();
  if (/ogg|opus/.test(type)) return 'ogg';
  if (/mpeg|mp3/.test(type)) return 'mp3';
  if (/mp4|m4a|aac/.test(type)) return 'm4a';
  if (/wav|wave/.test(type)) return 'wav';
  const ext = /\.([A-Za-z0-9]+)$/.exec(name ?? '')?.[1]?.toLowerCase();
  return (ext === undefined ? undefined : AUDIO_EXTENSIONS[ext]) ?? 'bin';
}

/**
 * The selfreflection rows still to fill: live, mirrored or made by the v15 step from her past messages (`mediaPending` in its
 * extra, selfreflection-past.ts), and either no text yet, files not read yet (`mediaPending`), a media row that names no
 * attachment id, or (a post saved before audio was kept) a `voice` field in its extra with no audio media row. Each
 * carries the messages it was sent as (messageIdsOf), the post's `voice` object, if any, and the
 * chat it was posted to: the place its publication names, else the place her selfreflection is posted to

 * (mirrors.ts#selfreflectionPlaces, the first), else null.
 */
export function pendingSelfreflectionRows(db: Db): Array<PendingSelfreflectionRow> {
  const fallbackId = selfreflectionPlaces(db)[0]?.chatId ?? null;
  const rows: Array<Row> = db
    .prepare(
      `SELECT d.id AS id, d.scope_kind AS scope_kind, d.scope_iface AS scope_iface, d.scope_dm AS scope_dm, d.extra AS extra,
         (SELECT m.native_ids FROM selfreflection_mirrors m WHERE m.selfreflection_id = d.id AND m.retired_at IS NULL ORDER BY m.rowid LIMIT 1) AS native_ids,
         (SELECT x.receipts FROM publications x WHERE x.row_kind = 'selfreflection' AND x.row_id = d.id AND x.status = 'sent'
           AND x.retired_at IS NULL ORDER BY x.created_at, x.id LIMIT 1) AS receipts,
         (SELECT p.native_id FROM publications x JOIN places p ON p.id = x.destination_place_id
           WHERE x.row_kind = 'selfreflection' AND x.row_id = d.id ORDER BY x.created_at, x.id LIMIT 1) AS conversation_id
       FROM selfreflection d
      WHERE d.retired_at IS NULL
        AND (EXISTS (SELECT 1 FROM selfreflection_mirrors m WHERE m.selfreflection_id = d.id AND m.retired_at IS NULL)
          OR json_extract(d.extra, '$.mediaPending') = 1)
        AND (d.text IS NULL
          OR json_extract(d.extra, '$.mediaPending') = 1
          OR EXISTS (SELECT 1 FROM media_links l JOIN media y ON y.id = l.media_id
            WHERE l.owner_kind = 'selfreflection' AND l.owner_id = d.id AND y.native_ref IS NULL
              AND json_type(y.extra, '$.platformRead') IS NULL)
          OR (json_type(d.extra, '$.voice') = 'object'
            AND NOT EXISTS (SELECT 1 FROM media_links l JOIN media x ON x.id = l.media_id
              WHERE l.owner_kind = 'selfreflection' AND l.owner_id = d.id AND x.mime LIKE 'audio/%')))
      ORDER BY d.position, d.rowid`
    )
    .all();
  const out: Array<PendingSelfreflectionRow> = [];
  for (const row of rows) {
    const ids = messageIdsOf(row.native_ids, row.receipts);
    if (ids.length === 0) continue;
    let voice: PendingSelfreflectionRow['voice'] = null;
    try {
      const parsed = (JSON.parse((row.extra as string | null) ?? 'null') as { voice?: unknown } | null)?.voice;
      if (parsed && typeof parsed === 'object') voice = parsed;
    } catch {
      /* an unreadable extra means no voice field */
    }
    const { conversation_id: chatId } = row;
    out.push({
      id: String(row.id),
      scope_kind: row.scope_kind,
      scope_iface: row.scope_iface,
      scope_dm: row.scope_dm,
      native_ids: row.native_ids,
      chatId: typeof chatId === 'string' ? chatId : fallbackId,
      messageIds: ids,
      voice,
    });
  }
  return out;
}

/**
 * The messages a post was sent as: its mirror's ids, then the message receipts of its sent publication that the
 * mirror does not name (a message the v15 step joined to it, selfreflection-past.ts), each once.

 * `nativeIds` is the mirror's `native_ids` JSON, or null; `receipts` the publication's `receipts` JSON, or null.
 */
function messageIdsOf(nativeIds: unknown, receipts: unknown): Array<string> {
  const parse = (json: unknown): Array<unknown> => {
    try {
      const parsed: unknown = typeof json === 'string' ? JSON.parse(json) : null;
      return Array.isArray(parsed) ? (parsed as Array<unknown>) : [];
    } catch {
      return [];
    }
  };
  const ids = parse(nativeIds)
    .filter((id) => typeof id === 'string' && id !== '')
    .map(String);
  for (const item of parse(receipts)) {
    const receipt = item as { key?: unknown; kind?: unknown } | null;
    if (typeof receipt?.key === 'string' && receipt.key && receipt.kind !== 'attachment') ids.push(receipt.key);
  }
  return [...new Set(ids)];
}

const parsedRef = (text: unknown): Row => {
  if (typeof text !== 'string') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as Row) : {};
  } catch {
    return {};
  }
};

/** A file's place in its entry: the number its id ends in, from one. */
const positionOf = (id: unknown): number => Math.max(0, Number(/-(\d+)$/.exec(String(id))?.[1] ?? 1) - 1);

/**
 * Writes one row's result on the writer connection: `{ id, text, media: [{ id, path, nativeRef, sha1, bytes, mime, extra? }] }`.
 * The media rows take the selfreflection row's scope and its audience (scope.ts#audienceOf, the one resolver). One transaction.
 */
export function applySelfreflectionUpdate(handle: MemoryHandle, given: unknown): void {
  const update = given as Row;
  handle.transaction(() => {
    const db = dbOf(handle);
    const selfreflection = db
      .prepare('SELECT scope_kind, scope_iface, scope_dm FROM selfreflection WHERE id = ?')
      .get(update.id);
    if (!selfreflection) return;
    // A refetch (for audio) never replaces a text the row already holds: only an empty or missing text is filled.
    // An entry the v15 step made from her past messages has its files read once: its `mediaPending` mark goes.
    db.prepare(
      `UPDATE selfreflection SET text = CASE WHEN text IS NOT NULL AND text <> '' THEN text ELSE ? END,
         extra = CASE WHEN json_type(extra, '$.mediaPending') IS NULL THEN extra ELSE json_remove(extra, '$.mediaPending') END
       WHERE id = ?`
    ).run(update.text ?? '', update.id);
    const audience = audienceOf(selfreflection);
    const media = (update.media ?? []) as Array<Row>;
    if (media.length > 0) ensureAudience(db, audience);
    writeEntryFiles(
      db,
      { ...selfreflection, id: update.id, audience_id: audience.audience_id },
      media.map((item): EntryFile => {
        const ref = parsedRef(item.nativeRef);
        return {
          id: String(item.id),
          position: positionOf(item.id),
          path: (item.path as string | null | undefined) ?? null,
          attachmentId: typeof ref.attachmentId === 'string' && ref.attachmentId ? ref.attachmentId : null,
          messageId: typeof ref.messageId === 'string' && ref.messageId ? ref.messageId : null,
          url: typeof ref.url === 'string' && ref.url ? ref.url : null,
          description: (item.description as string | null | undefined) ?? null,
          sha1: (item.sha1 as string | null | undefined) ?? null,
          bytes: (item.bytes as number | null | undefined) ?? null,
          mime: (item.mime as string | null | undefined) ?? null,
          extra: {
            ...(typeof item.extra === 'string' ? parsedRef(item.extra) : {}),
            // A post read once and named no attachment is not asked again.
            ...('attachmentId' in ref ? { platformRead: true } : {}),
          },
        };
      }),
      null
    );
  });
}

/**
 * The pictures and the voice file of an entry the selfreflection turn recorded (src/behavior/selfreflection-turn.ts), kept as the job
 * keeps an older post's: each file written atomically to `data/media/selfreflection/<entry id>-<n>.<ext>` (`update.dataDir`, the
 * service's data directory) in the entry's order, then its `media` row (applySelfreflectionUpdate: the selfreflection row's scope, an
 * audio row's `extra` `{ voice: true, text, durationSec, waveform }`). Runs on the writer connection; a repeat writes the

 * same files and rows. Returns how many files were kept. `handle` is an `openMemoryDb` handle (the writer) and `given`
 * is `{ dataDir, id, items: [{ data, mime, extra?, ref? }] }`.
 */
export function applyEntryMedia(handle: MemoryHandle, given: unknown): number {
  const update = given as {
    dataDir: string;
    id: string;
    items?: Array<{
      data: Uint8Array;
      mime: string;
      extra?: object | null;
      ref?: { messageId: string; attachmentId: string | null };
    }>;
  };
  const base = safeName(update.id);
  const media = (update.items ?? []).map((item, index) => {
    const buffer = Buffer.from(item.data);
    const audio = /^audio\//i.test(item.mime);
    const rel = path.join(
      MEDIA_DIR,
      `${base}-${index + 1}.${audio ? audioExtension(item.mime, '') : (EXTENSIONS[item.mime] ?? 'bin')}`
    );
    writeAtomic(path.join(update.dataDir, rel), buffer);
    return {
      id: `${ENTRY_MEDIA}${base}-${index + 1}`,
      path: rel.split(path.sep).join('/'),
      // Once the file is posted: the message and the attachment it became, and what memory saw in that attachment.
      nativeRef: item.ref ? JSON.stringify(item.ref) : null,
      description: null,
      sha1: createHash('sha1').update(buffer).digest('hex'),
      bytes: buffer.byteLength,
      mime: item.mime,
      extra: item.extra ? JSON.stringify(item.extra) : null,
    };
  });
  if (media.length > 0) applySelfreflectionUpdate(handle, { id: update.id, media });
  return media.length;
}

/**
 * How a media row of her post names its file on the platform: `native_ref` `{ url, messageId, attachmentId }` (the
 * attachment's own id, as the read's message event gives it) and the description the media cache keeps of that
 * attachment's item, when it has one.

 * `connection` is a connection that can read, `message` the message a read found and `attachment` one of its
 * attachments as the read lists them.
 */
function platformOf(
  connection: Db | null,
  message: FetchedMessage,
  attachment: FetchedAttachment
): { nativeRef: string; description: string | null } {
  const database = connection;
  // The read names each attachment's own id; the message event names it too.
  const eventMessage = message.event?.message;
  const found = (eventMessage?.attachments ?? []).find((item) => item?.url === attachment.url);
  const named = typeof attachment.id === 'string' && attachment.id ? attachment.id : found?.id;
  const attachmentId = typeof named === 'string' && named ? named : null;
  return {
    nativeRef: JSON.stringify({ url: attachment.url, messageId: message.messageId, attachmentId }),
    description: heldDescription(database, attachmentId),
  };
}

/** What memory saw in the attachment `attachmentId`: the description of its item, or null. */
function heldDescription(database: Db | null, attachmentId: unknown): string | null {
  if (!attachmentId || !database) return null;
  const held = database
    .prepare('SELECT description FROM media WHERE native_ref = ? AND retired_at IS NULL ORDER BY rowid LIMIT 1')
    .get(asText(attachmentId));
  return typeof held?.description === 'string' && held.description ? held.description : null;
}

/** Writes `buffer` to `abs` atomically. */
function writeAtomic(abs: string, buffer: NodeJS.ArrayBufferView): void {
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
/** The part of a `fetch` response the job reads. */
type PlainResponse = {
  ok?: boolean;
  headers?: { get?: (name: string) => string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};
type PlainFetch = (url: string, init: { method: string; signal: AbortSignal }) => Promise<PlainResponse>;

async function downloadPlain(
  fetchImpl: PlainFetch,
  url: string,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number | undefined }
): Promise<{ buffer: Buffer; contentType: string } | null> {
  let response: PlainResponse;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(isFiniteNumber(timeoutMs) ? timeoutMs : 15000),
    });
  } catch {
    return null;
  }
  if (!response?.ok) return null;
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && Number.isFinite(maxBytes) && declared > maxBytes) return null;
  let buffer: Buffer;
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

 * Everything that changes is a getter (read at the moment of use). `db` is a connection that can read the selfreflection;
 * `apply` writes one update (applySelfreflectionUpdate on the writer); `sleep` is injected by the tests.
 */
export function createSelfreflectionMedia({
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
}: {
  db: () => unknown;
  apply: (update: Row) => unknown;
  port: () => unknown;
  imageFetcher: () => unknown;
  config: () => Config | null | undefined;
  dataDir: string;
  log?: Log;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  fetchImpl?: PlainFetch;
}): SelfreflectionMediaJob {
  let stopped = false;
  let running: Promise<{ done: number; failed: number }> | null = null;
  let wake: (() => void) | null = null;
  const attempted = new Set<string>();
  // The chats the interface refused in this start: asked once, and their posts wait for the next start.
  const forbidden = new Set<string>();
  const pause =
    sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimer(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }));

  const codeOf = (error: unknown): string => {
    const { code, name } = (error ?? {}) as { code?: string; name?: string };
    return code ?? name ?? 'ERROR';
  };

  /** The settings of this moment. */
  function settings(): { maxBytes: number; timeoutMs: number | undefined; audioMaxBytes: number } {
    const cfg = config() ?? {};
    const vision = (cfg.context as { vision?: { fetchTimeoutMs?: unknown } } | undefined)?.vision;
    return {
      maxBytes: REFERENCE_MAX_BYTES,
      timeoutMs: vision?.fetchTimeoutMs as number | undefined,
      audioMaxBytes: DEFAULT_AUDIO_MAX_BYTES,
    };
  }

  /** One row: fetch, download, write. Returns 'done' or 'failed'. */
  async function handleRow(
    row: PendingSelfreflectionRow,
    { maxBytes, timeoutMs, audioMaxBytes }: { maxBytes: number; timeoutMs: number | undefined; audioMaxBytes: number },
    adapter: SelfreflectionPort & Required<Pick<SelfreflectionPort, 'fetchMessages'>>,
    fetcher: ImageFetcher
  ): Promise<'done' | 'failed' | 'closed' | 'forbidden'> {
    const chat = { iface: adapter.iface, chatId: row.chatId as string };
    const result = await adapter.fetchMessages(chat, row.messageIds);
    if (result?.status !== 'ok' || !Array.isArray(result.messages)) {
      return refusedRow(result?.error?.code ?? result?.status ?? 'ERROR', log);
    }
    const byId = new Map(result.messages.map((message): [string, FetchedMessage] => [message.messageId, message]));
    const present = row.messageIds
      .map((id) => byId.get(id))
      .filter((message): message is FetchedMessage => message !== undefined && !message.missing);
    if (present.length === 0) {
      // Nothing of it is left on the platform: the database keeps what it has; an empty text marks it fetched.
      await apply({ id: row.id, text: '', media: [] });
      return 'done';
    }
    const text = present
      .map((message) => (typeof message.text === 'string' ? message.text : ''))
      .filter((part) => part !== '')
      .join('\n');
    const media: Array<Row> = [];
    const base = safeName(row.id);
    let n = 0;
    for (const message of present) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.url && isAudio(attachment)) {
          if (isFiniteNumber(attachment.size) && attachment.size > audioMaxBytes) {
            log.warn('selfreflection media: audio over the cap', { bytes: attachment.size });
            continue;
          }
          const got = await downloadPlain(fetchImpl, attachment.url, { maxBytes: audioMaxBytes, timeoutMs });
          if (!got) {
            log.warn('selfreflection media: download failed', { code: 'DOWNLOAD' });
            return 'failed';
          }
          n += 1;
          const mime = attachment.contentType || got.contentType || 'audio/ogg';
          const rel = path.join(MEDIA_DIR, `${base}-${n}.${audioExtension(mime, attachment.name)}`);
          writeAtomic(path.join(dataDir, rel), got.buffer);
          const voice = row.voice;
          const matched = voice !== null && voice.messageId === message.messageId;
          const extra: Row = { voice: true };
          if (matched && typeof voice.text === 'string') extra.text = voice.text;
          const duration =
            matched && isFiniteNumber(voice.durationSec)
              ? voice.durationSec
              : isFiniteNumber(attachment.durationSec)
                ? attachment.durationSec
                : null;
          if (duration !== null) extra.durationSec = duration;
          media.push({
            id: `${ENTRY_MEDIA}${base}-${n}`,
            path: rel.split(path.sep).join('/'),
            ...platformOf(db() as Db | null, message, attachment),
            sha1: createHash('sha1').update(got.buffer).digest('hex'),
            bytes: got.buffer.byteLength,
            mime,
            extra: JSON.stringify(extra),
          });
          continue;
        }
        if (!isImage(attachment) || !attachment.url) continue;
        if (isFiniteNumber(attachment.size) && Number.isFinite(maxBytes) && attachment.size > maxBytes) {
          log.warn('selfreflection media: picture over the cap', { bytes: attachment.size });
          continue;
        }
        const downloaded = await fetcher.fetchAsDataUrl(attachment.url, { maxBytes, timeoutMs });
        if (!downloaded) {
          log.warn('selfreflection media: download failed', { code: 'DOWNLOAD' });
          return 'failed';
        }
        const comma = downloaded.dataUrl.indexOf(',');
        const buffer = Buffer.from(downloaded.dataUrl.slice(comma + 1), 'base64');
        n += 1;
        const mime = downloaded.contentType;
        const rel = path.join(MEDIA_DIR, `${base}-${n}.${EXTENSIONS[mime] ?? 'bin'}`);
        writeAtomic(path.join(dataDir, rel), buffer);
        media.push({
          id: `${ENTRY_MEDIA}${base}-${n}`,
          path: rel.split(path.sep).join('/'),
          ...platformOf(db() as Db | null, message, attachment),
          sha1: createHash('sha1').update(buffer).digest('hex'),
          bytes: buffer.byteLength,
          mime,
        });
      }
    }
    await apply({ id: row.id, text, media });
    return 'done';
  }

  async function runOnce(): Promise<{ done: number; failed: number }> {
    const counts = { done: 0, failed: 0 };
    const database = db() as Db | null;
    const adapter = port() as SelfreflectionPort | null;
    const fetcher = imageFetcher() as ImageFetcher | null;
    const given = settings();
    if (!database || !adapter?.fetchMessages || !fetcher) return counts;
    const fetching = adapter as SelfreflectionPort & Required<Pick<SelfreflectionPort, 'fetchMessages'>>;
    let rows: Array<PendingSelfreflectionRow>;
    try {
      // A post with no place is never asked of the interface: there is no chat to ask.
      rows = pendingSelfreflectionRows(database).filter((row) => row.chatId !== null && !attempted.has(row.id));
    } catch (error) {
      log.warn('selfreflection media: read failed', { code: codeOf(error) });
      return counts;
    }
    let first = true;
    let refused = 0;
    for (const row of rows) {
      if (stopped) break;
      if (forbidden.has(row.chatId as string)) {
        attempted.add(row.id);
        refused += 1;
        continue;
      }
      if (!first) await pause(GAP_MS);
      first = false;
      if (stopped) break;
      attempted.add(row.id);
      try {
        const outcome = await handleRow(row, given, fetching, fetcher);
        if (outcome === 'closed') {
          // The link is not up yet: this post and the rest wait for a run with a link.
          attempted.delete(row.id);
          break;
        }
        if (outcome === 'forbidden') {
          forbidden.add(row.chatId as string);
          refused += 1;
        } else counts[outcome] += 1;
      } catch (error) {
        counts.failed += 1;
        log.warn('selfreflection media: row failed', { code: codeOf(error) });
      }
    }
    if (counts.done + counts.failed + refused > 0) log.info('selfreflection media: pass', { ...counts, refused });
    return counts;
  }

  return {
    /** Handles the rows pending now that were not tried in this start; one run at a time (a call during a run returns it). */
    run(): Promise<{ done: number; failed: number }> {
      if (running) return running;
      const started = runOnce().finally(() => {
        running = null;
      });
      running = started;
      return started;
    },
    /** Rows still waiting that this start has not tried: a cheap check before `run()`. */
    hasWork(): boolean {
      try {
        const database = db() as Db | null;
        return database != null && pendingSelfreflectionRows(database).some((row) => !attempted.has(row.id));
      } catch {
        return false;
      }
    },
    /** Ends the run under way after its current row. */
    stop(): Promise<unknown> {
      stopped = true;
      wake?.();
      return running ?? Promise.resolve();
    },
  };
}
