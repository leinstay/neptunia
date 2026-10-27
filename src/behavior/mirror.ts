// The diary's mirrors (stage 3 design, section 5). A mirror is one place her diary entries are posted to, a `mirrors`
// row of schema v15 the owner set up; there may be none or many. `createMirrors` (wired in src/core.js) publishes a
// recorded entry once to every enabled mirror: each mirror gets one `publications` row (src/memory/db/publish.js), keyed
// `diary:<entry id>:<place id>`, prepared `queued` under the mirror's standing grant, then sent through the interface
// port and marked `sent` with the message ids as receipts, `failed` with the port's code, or `unknown` when the port
// could not tell. A second publication of the same entry to the same place reuses the row and sends nothing. With no
// interface connected (or the port of another interface) the row stays `queued`, and `drainQueued` sends it when the
// interface connects and on the scheduler's tick. Every write goes through the memory service's writer
// (`memoryWrite`, kind `publication`).
//
// An entry goes out in the order a diary post goes out from the turn: the voice message, her messages one by one, then
// the pictures in messages of files (`sendEntry`). The turn's act path (src/behavior/turn.js#act) splits a set with
// the same `chunkPictures` and names its files with `pictureAttachments`; `voice.say` (src/tools/impl/voice.ts) builds
// its file with `voiceAttachment`. Before any send the entry's pictures and voice file are kept in memory as files
// under the data directory and `media` rows (memoryWrite kind `entry-media`, src/memory/db/diary-media.js), so a row
// still queued after a restart goes out whole: `drainQueued` rebuilds the entry from its `diary` row (`send`: her
// messages as sent, their mentions, the set's byte limit) and its media.
//
// `mirrorPlaces(db)` reads the places of the enabled diary mirrors; `diaryPlaces(db)` is the read every diary-channel
// check uses: those places, oldest first, or, with none, the place the last entry was published to. A mirror place is
// not hers to write in (the owner, 2026-10-27): `guardMirrorPort` is the core's outbound port, which refuses every send
// there with the code `diary-mirror`, and the message handler opens no turn for an event there (src/behavior/
// pipeline.js). Logs carry counts and codes, never a text.

import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { portLimit } from '../interface/capabilities.ts';
import { issueContext } from '../memory/db/scope.ts';
import { mirrorReceipts } from '../memory/db/publish.js';
import { setSettings } from './diary.js';
import { CODE } from '../tools/codes.ts';
import type { Attachment, Content } from '../protocol/actions.js';
import type { ConversationRef, Delivery } from '../protocol/adapter.ts';
import type { Context } from '../memory/db/scope.ts';

/** One picture of an entry: its bytes and its media type. */
export type EntryPicture = { buffer: Uint8Array; mediaType: string };

/** The voice message of an entry: the ogg file, its length and its waveform. */
export type EntryVoice = { ogg: Uint8Array; durationSecs: number; waveform: string };

/**
 * A diary entry as it is published: its `diary` row's id, her messages as they are sent, the members each message may
 * notify (`mentions[i]` for `messages[i]`, none when absent), the pictures and the voice message.
 */
export type DiaryEntry = {
  id: string;
  messages: ReadonlyArray<string>;
  mentions?: ReadonlyArray<ReadonlyArray<string>>;
  pictures?: ReadonlyArray<EntryPicture>;
  voice?: EntryVoice | null;
  /** The bytes of one message of pictures (`diary.set.maxMessageBytes` when the entry was recorded). */
  maxMessageBytes?: number;
};

/** What a send of an entry came to: every message posted, and the code of the send that stopped it. */
export type EntrySent = { status: 'sent' | 'failed' | 'unknown'; code: string | null; messageIds: Array<string> };

/** The part of an interface port the publisher uses. */
export type MirrorPort = {
  iface: string;
  send(conversation: ConversationRef, content: Content): Promise<Delivery>;
};

/** One mirror as `listMirrors` answers it. */
export type Mirror = { id: string; placeId: string; enabled: boolean };

/** What `publishEntry` answers for each enabled mirror: its place, the publication's state and the port's code. */
export type PublishOutcome = { placeId: string; status: 'queued' | 'sent' | 'failed' | 'unknown'; code: string | null };

/** A place an entry is posted to: the place id, its interface, the conversation it is and its name. */
export type DiaryPlace = { placeId: string; iface: string; conversationId: string; name: string | null };

/** The part of the memory service the publisher uses: the read connection and the one writer. */
export type MirrorMemory = {
  readHandle(): { db: unknown } | null;
  memoryWrite(update: Record<string, unknown>): Promise<unknown>;
};

type Row = Record<string, unknown>;
type Db = {
  prepare(sql: string): { all(...params: Array<unknown>): Array<Row>; get(...params: Array<unknown>): Row | undefined };
};
type Publication = {
  id: string;
  status: string;
  row_id: string;
  rendered: string | null;
  destination_place_id: string;
};
type Prepared = { ok: true; publication: Publication; reused: boolean } | { ok: false; code: string };

// diary.js is JS; `setSettings` as the publisher calls it, on a `diary` section of unknown shape.
const setOf = setSettings as (diaryCfg: unknown) => { maxMessageBytes: number };

// The files of one message when the adapter names no limit (`capabilities().maxFiles`).
const DEFAULT_FILES_PER_MESSAGE = 10;

/** How many files one message of `port` holds. */
export function filesPerMessage(port: unknown): number {
  return portLimit(port, 'maxFiles', DEFAULT_FILES_PER_MESSAGE);
}

/** Upload file name for a generated picture: `image/jpeg` -> `image.jpg`, else `image.<subtype>`; `/nep draw` names its picture the same way. */
export function imageFileName(mediaType: unknown): string {
  const subtype =
    (typeof mediaType === 'string' ? mediaType : '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() || 'png';
  return `image.${subtype === 'jpeg' ? 'jpg' : subtype}`;
}

/**
 * A diary set's pictures split into messages, in order: a message holds at most `maxFiles` files, and a picture whose
 * bytes would take its message past `maxBytes` (`diary.set.maxMessageBytes`) starts the next one; a picture larger
 * than `maxBytes` on its own goes alone. Pure.
 */
export function chunkPictures<TPicture extends { buffer?: { length: number } | null }>(
  pictures: ReadonlyArray<TPicture> | null | undefined,
  maxBytes: number,
  maxFiles: number = DEFAULT_FILES_PER_MESSAGE
): Array<Array<TPicture>> {
  const chunks: Array<Array<TPicture>> = [];
  let current: Array<TPicture> = [];
  let bytes = 0;
  for (const picture of pictures ?? []) {
    const size = picture?.buffer?.length ?? 0;
    if (current.length > 0 && (current.length >= maxFiles || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(picture);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** The files of one message of pictures, named by their media type. */
export function pictureAttachments(chunk: ReadonlyArray<EntryPicture>): Array<Attachment> {
  return chunk.map((picture) => ({
    name: imageFileName(picture.mediaType),
    data: picture.buffer,
    contentType: picture.mediaType,
  }));
}

/** The one file of a voice message: an ogg named by `at` (ms since the epoch), with its length and waveform. */
export function voiceAttachment(voice: EntryVoice, at: number): Attachment {
  return {
    name: `voice-${at.toString(36)}.ogg`,
    data: voice.ogg,
    contentType: 'audio/ogg',
    voice: { durationSecs: voice.durationSecs, waveform: voice.waveform },
  };
}

/** The entry's text as one string: her messages, one per line. It is the publication's rendered text. */
export function entryText(entry: Pick<DiaryEntry, 'messages'>): string {
  return entry.messages.join('\n');
}

/**
 * Sends `entry` to `conversation` through `port`: the voice message, her messages one by one, then the pictures in
 * messages of files split by `chunkPictures` over `maxMessageBytes` and the port's `maxFiles`. Stops at the first send
 * that is not `ok`: `failed` with the port's code, or `unknown` when the port could not tell whether it went out.
 * `messageIds` holds every message posted, the parts of a split send included.
 */
export async function sendEntry(
  port: MirrorPort,
  conversation: ConversationRef,
  entry: DiaryEntry,
  { maxMessageBytes, now }: { maxMessageBytes: number; now: () => number }
): Promise<EntrySent> {
  const contents: Array<Content> = [];
  if (entry.voice) contents.push({ attachments: [voiceAttachment(entry.voice, now())] });
  entry.messages.forEach((text, index) => {
    contents.push({ text, mentions: { users: [...(entry.mentions?.[index] ?? [])], repliedUser: false } });
  });
  for (const chunk of chunkPictures(entry.pictures ?? [], maxMessageBytes, filesPerMessage(port)))
    contents.push({ attachments: pictureAttachments(chunk) });
  const messageIds: Array<string> = [];
  for (const content of contents) {
    const sent = await port.send(conversation, content);
    for (const part of sent.parts.length > 0 ? sent.parts : sent.ref ? [sent.ref] : []) messageIds.push(part.messageId);
    if (sent.status !== 'ok')
      return {
        status: sent.status === 'unknown' ? 'unknown' : 'failed',
        code: sent.error?.code ?? sent.status,
        messageIds,
      };
  }
  return { status: 'sent', code: null, messageIds };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Whether the database has the `mirrors` table (schema v15). */
function hasMirrors(db: Db): boolean {
  return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'mirrors'").get() !== undefined;
}

/** A place row as a diary place, or null when it names no interface or conversation. */
function placeOf(row: Row | undefined): DiaryPlace | null {
  const placeId = text(row?.id);
  const iface = text(row?.iface);
  const conversationId = text(row?.native_id);
  return placeId && iface && conversationId ? { placeId, iface, conversationId, name: text(row?.name) } : null;
}

/**
 * The places her diary is posted to, read on `connection` (a node:sqlite connection of the memory database): the
 * places of the enabled `diary` mirrors, oldest mirror first; with none, the place the last entry was published to;
 * with neither, none.
 */
export function diaryPlaces(connection: unknown): Array<DiaryPlace> {
  const db = connection as Db; // a node:sqlite connection; the queries below read it
  const mirrored = mirrorPlaces(db);
  if (mirrored.length > 0) return mirrored;
  const last = placeOf(
    db
      .prepare(
        `SELECT p.id, p.iface, p.native_id, p.name FROM publications x JOIN places p ON p.id = x.destination_place_id
          WHERE x.row_kind = 'diary' AND x.retired_at IS NULL ORDER BY x.created_at DESC, x.id DESC LIMIT 1`
      )
      .get()
  );
  return last ? [last] : [];
}

/** The places of the enabled `diary` mirrors, read on `connection`, oldest mirror first; none before schema v15. */
export function mirrorPlaces(connection: unknown): Array<DiaryPlace> {
  const db = connection as Db; // a node:sqlite connection; the query below reads it
  if (!hasMirrors(db)) return [];
  return db
    .prepare(
      `SELECT p.id, p.iface, p.native_id, p.name FROM mirrors m JOIN places p ON p.id = m.place_id
        WHERE m.row_kind = 'diary' AND m.enabled = 1 ORDER BY m.created_at, m.id`
    )
    .all()
    .map(placeOf)
    .filter((place): place is DiaryPlace => place !== null);
}

/** What the mirrors are read from: the memory service (its read connection), or the store (`readMemory`). */
type MemorySource = Partial<MirrorMemory> & { readMemory?: <TValue>(read: (db: unknown) => TValue) => TValue | null };

/**
 * `read(db)` on the memory database of `source` (the memory service's read connection, else the store's
 * `readMemory`), or `none` when there is none or the read fails.
 */
export function readMirrors<TValue>(source: unknown, read: (db: unknown) => TValue, none: TValue): TValue {
  try {
    const given = source as MemorySource | null | undefined;
    const handle = given?.readHandle?.() ?? null;
    if (handle) return read(handle.db);
    return given?.readMemory?.(read) ?? none;
  } catch (error) {
    log.warn('mirror: read failed', { code: (error as { code?: unknown } | null)?.code ?? 'ERROR' });
    return none;
  }
}

/** The conversation ids of her diary's places in `memoryDb` (diaryPlaces): where she keeps her diary. */
export function diaryConversationIds(memoryDb: unknown): Set<string> {
  return readMirrors(
    memoryDb,
    (db) => new Set(diaryPlaces(db).map((place) => place.conversationId)),
    new Set<string>()
  );
}

/** The places of her diary a sandbox's view names (`memory.diaryChannelIds`, src/behavior/sandbox.js), else none. */
export function viewDiaryIds(view: unknown): Array<string> {
  const read = (view as { memory?: { diaryChannelIds?: unknown } } | null | undefined)?.memory?.diaryChannelIds;
  return typeof read === 'function' ? (read as () => Array<string>)() : [];
}

/** Whether `conversationId` of `iface` is the place of an enabled diary mirror in `memoryDb`. */
export function isMirrorPlace(memoryDb: unknown, iface: unknown, conversationId: unknown): boolean {
  const here = (place: DiaryPlace): boolean => place.iface === iface && place.conversationId === String(conversationId);
  return readMirrors(memoryDb, (db) => mirrorPlaces(db).some(here), false);
}

/**
 * The core's outbound port: `port` with every `send` to the place of an enabled diary mirror refused with the code
 * `diary-mirror` (nothing reaches the interface), read in `memoryDb` at each send. Only the mirrors' publisher, which
 * holds the interface's own port, writes there. Everything else passes through.
 */
export function guardMirrorPort<TPort extends MirrorPort>(port: TPort, { memoryDb }: { memoryDb: unknown }): TPort {
  async function send(conversation: ConversationRef, content: Content): Promise<Delivery> {
    if (!isMirrorPlace(memoryDb, conversation.iface, conversation.conversationId))
      return port.send(conversation, content);
    log.info('mirror: send refused', { code: CODE.DIARY_MIRROR });
    return {
      status: 'failed',
      ref: null,
      parts: [],
      at: null,
      idempotencyKey: '',
      error: { code: CODE.DIARY_MIRROR, retryable: false, retryAfterMs: null },
    };
  }
  return new Proxy(port, {
    get(target, key) {
      if (key === 'send') return send;
      const value: unknown = Reflect.get(target, key, target);
      // A port's methods are its own: bound to it, as a call on the port itself would be.
      return typeof value === 'function' ? (value as (...args: Array<unknown>) => unknown).bind(target) : value;
    },
  });
}

/** What an audio `media` row of an entry keeps of its voice message: its length and its waveform. */
function voiceExtra(voice: EntryVoice): { durationSec: number; waveform: string } {
  return { durationSec: voice.durationSecs, waveform: voice.waveform };
}

/** The JSON object of `text`, or an empty object. */
function objectOf(text: unknown): Row {
  try {
    const parsed: unknown = typeof text === 'string' ? JSON.parse(text) : null;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Row) : {};
  } catch {
    // An unreadable extra holds nothing of the entry.
    return {};
  }
}

/** The number at the end of a media id (`media:diary:<entry>-<n>`): its place in the entry. */
const mediaNumber = (id: unknown): number => Number(/-(\d+)$/.exec(String(id))?.[1] ?? 0);

/**
 * The entry of a queued publication as memory holds it: its `diary` row's `send` (her messages as sent, their mentions,
 * the set's byte limit; the rendered text as one message when it has none) and its `media` rows with their files under
 * `dataDir`, pictures first and the voice file last, in their numbering. A file that cannot be read is left out.
 */
function storedEntry(db: Db, publication: Publication, dataDir: string | null): DiaryEntry {
  const row = db.prepare('SELECT extra FROM diary WHERE id = ?').get(publication.row_id);
  const send = objectOf(row?.extra).send as
    { messages?: unknown; mentions?: unknown; maxMessageBytes?: unknown } | undefined;
  const messages = Array.isArray(send?.messages) ? (send.messages as Array<string>) : [publication.rendered ?? ''];
  const entry: DiaryEntry = {
    id: publication.row_id,
    messages,
    ...(Array.isArray(send?.mentions) ? { mentions: send.mentions as Array<Array<string>> } : {}),
    ...(typeof send?.maxMessageBytes === 'number' ? { maxMessageBytes: send.maxMessageBytes } : {}),
  };
  const media = db
    .prepare("SELECT id, path, mime, extra FROM media WHERE kind = 'diary' AND owner = ? AND retired_at IS NULL")
    .all(publication.row_id)
    .sort((a, b) => mediaNumber(a.id) - mediaNumber(b.id));
  const pictures: Array<EntryPicture> = [];
  for (const item of media) {
    const file = dataDir && typeof item.path === 'string' ? path.join(dataDir, item.path) : null;
    if (!file || !fs.existsSync(file)) continue;
    const buffer = fs.readFileSync(file);
    const mime = String(item.mime);
    if (!mime.startsWith('audio/')) {
      pictures.push({ buffer, mediaType: mime });
      continue;
    }
    const extra = objectOf(item.extra);
    const durationSecs = typeof extra.durationSec === 'number' ? extra.durationSec : 0;
    entry.voice = { ogg: buffer, durationSecs, waveform: typeof extra.waveform === 'string' ? extra.waveform : '' };
  }
  return pictures.length > 0 ? { ...entry, pictures } : entry;
}

/**
 * The publisher of the diary's mirrors over the memory service `memoryDb` and the connected interface's port
 * (`port()`: null when none is connected). `dataDir` is the memory service's data directory, where the entries' media
 * files are kept (null: a queued entry goes out without them). `config()` is the live config, read at each send for an
 * entry that names no `maxMessageBytes` (`diary.set.maxMessageBytes`).
 */
export function createMirrors({
  memoryDb,
  port,
  now,
  dataDir = null,
  config = () => ({}),
}: {
  memoryDb: MirrorMemory;
  port: () => MirrorPort | null;
  now: () => number;
  dataDir?: string | null;
  config?: () => unknown;
}): {
  listMirrors(): Array<Mirror>;
  publishEntry(entry: DiaryEntry): Promise<Array<PublishOutcome>>;
  drainQueued(): Promise<number>;
} {
  function database(): Db | null {
    const handle = memoryDb.readHandle();
    return handle ? (handle.db as Db) : null; // the service's read connection is node:sqlite's
  }

  function listMirrors(): Array<Mirror> {
    const db = database();
    if (!db || !hasMirrors(db)) return [];
    return db
      .prepare("SELECT id, place_id, enabled FROM mirrors WHERE row_kind = 'diary' ORDER BY created_at, id")
      .all()
      .map((row) => ({ id: String(row.id), placeId: String(row.place_id), enabled: row.enabled === 1 }));
  }

  /** The enabled mirror's place `placeId` as a diary place, or null when it is no longer an enabled mirror. */
  function mirroredPlace(db: Db, placeId: string): DiaryPlace | null {
    return placeOf(
      db
        .prepare(
          `SELECT p.id, p.iface, p.native_id, p.name FROM mirrors m JOIN places p ON p.id = m.place_id
            WHERE m.row_kind = 'diary' AND m.enabled = 1 AND m.place_id = ?`
        )
        .get(placeId)
    );
  }

  const write = (update: Record<string, unknown>): Promise<unknown> =>
    memoryDb.memoryWrite({ kind: 'publication', ...update });

  /** The entry's pictures, then its voice file, kept in memory before anything is sent (in that order: numbered so). */
  async function keepMedia(entry: DiaryEntry): Promise<void> {
    const items = [
      ...(entry.pictures ?? []).map((picture) => ({ data: picture.buffer, mime: picture.mediaType, extra: null })),
      ...(entry.voice
        ? [{ data: entry.voice.ogg, mime: 'audio/ogg', extra: { voice: true, ...voiceExtra(entry.voice) } }]
        : []),
    ];
    if (items.length > 0) await memoryDb.memoryWrite({ kind: 'entry-media', id: entry.id, items });
  }

  /** A queued publication sent to its place, when the port of its interface is connected; its outcome. */
  async function send(publication: Publication, place: DiaryPlace, entry: DiaryEntry): Promise<PublishOutcome> {
    const connected = port();
    if (!connected || connected.iface !== place.iface) return { placeId: place.placeId, status: 'queued', code: null };
    const diary = (config() as { diary?: unknown } | null)?.diary ?? null;
    const sent = await sendEntry(connected, { iface: place.iface, conversationId: place.conversationId }, entry, {
      maxMessageBytes: entry.maxMessageBytes ?? setOf(diary).maxMessageBytes,
      now,
    });
    if (sent.status === 'sent')
      await write({
        op: 'sent',
        id: publication.id,
        receipts: mirrorReceipts(place.iface, sent.messageIds),
        now: now(),
      });
    else await write({ op: sent.status, id: publication.id });
    log.info('mirror: published', { status: sent.status, messages: sent.messageIds.length, code: sent.code });
    return { placeId: place.placeId, status: sent.status, code: sent.code };
  }

  async function publishEntry(entry: DiaryEntry): Promise<Array<PublishOutcome>> {
    const db = database();
    if (!db) return [];
    await keepMedia(entry);
    const outcomes: Array<PublishOutcome> = [];
    for (const mirror of listMirrors().filter((one) => one.enabled)) {
      const place = mirroredPlace(db, mirror.placeId);
      if (!place) continue;
      const context: Context = issueContext({ kind: 'group', iface: place.iface, destination: place.placeId, now });
      const prepared = (await write({
        op: 'prepare',
        input: { context, rowKind: 'diary', rowId: entry.id, rendered: entryText(entry), destination: place.placeId },
        now: now(),
      })) as Prepared;
      if (!prepared.ok) {
        log.warn('mirror: not published', { code: prepared.code });
        outcomes.push({ placeId: place.placeId, status: 'failed', code: prepared.code });
        continue;
      }
      const { publication } = prepared;
      if (publication.status !== 'queued') {
        outcomes.push({ placeId: place.placeId, status: publication.status as PublishOutcome['status'], code: null });
        continue;
      }
      outcomes.push(await send(publication, place, entry));
    }
    return outcomes;
  }

  async function drainQueued(): Promise<number> {
    const db = database();
    if (!db) return 0;
    const queued = db
      .prepare(
        "SELECT id, status, row_id, rendered, destination_place_id FROM publications WHERE row_kind = 'diary' AND status = 'queued' AND retired_at IS NULL ORDER BY created_at, id"
      )
      .all() as Array<Publication>; // the columns selected above
    let sent = 0;
    for (const publication of queued) {
      const place = mirroredPlace(db, publication.destination_place_id);
      if (!place) continue;
      const entry = storedEntry(db, publication, dataDir);
      if ((await send(publication, place, entry)).status === 'sent') sent += 1;
    }
    return sent;
  }

  return { listMirrors, publishEntry, drainQueued };
}
