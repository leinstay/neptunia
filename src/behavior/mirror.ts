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
// The reads of the mirrors (`mirrorPlaces`, `diaryPlaces`, `isMirrorPlace`, `diaryConversationIds`) live with the memory
// database (src/memory/db/mirrors.ts) and are passed on from here to the behaviour modules. A mirror place is not hers
// to write in (the owner, 2026-10-27): `guardMirrorPort` is the core's outbound port, which refuses every send
// there with the code `diary-mirror`, and the message handler opens no turn for an event there (src/behavior/
// pipeline.js). Logs carry counts and codes, never a text.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { log } from '../log.js';
import { portLimit } from '../interface/capabilities.ts';
import { issueContext } from '../memory/db/scope.ts';
import { mirrorReceipts } from '../memory/db/publish.js';
import { setSettings } from './diary.js';
import {
  diaryConversationIds,
  diaryPlaces,
  hasMirrors,
  isMirrorPlace,
  mirrorPlaces,
  placeOf,
  readMirrors,
} from '../memory/db/mirrors.ts';
import type { DiaryPlace } from '../memory/db/mirrors.ts';
import { CODE } from '../tools/codes.ts';
import type { Attachment, Content } from '../protocol/actions.js';
import type { ConversationRef, Delivery } from '../protocol/adapter.ts';
import type { Context } from '../memory/db/scope.ts';

/** One picture of an entry: its bytes and its media type. */
export type EntryPicture = { buffer: Uint8Array; mediaType: string };

/** The voice message of an entry: the ogg file, its length and its waveform. */
export type EntryVoice = { ogg: Uint8Array; durationSecs: number; waveform: string };

/** A file one of her messages carries (a file of an errand, a picture she reposts): its name, bytes and type. */
export type EntryFile = { message: number; name: string; data: Uint8Array; contentType: string | null };

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
  /** The files her messages carry, each with the index of its message in `messages`. */
  files?: ReadonlyArray<EntryFile>;
  /** The bytes of one message of pictures (`diary.set.maxMessageBytes` when the entry was recorded). */
  maxMessageBytes?: number;
};

/** One message an entry's send posted: its id and time, its text, and the entry's files it carries with their ids. */
export type PostedMessage = {
  messageId: string;
  at: number | null;
  text: string | null;
  files: Array<{ item: number; attachmentId: string | null }>;
};

/**
 * What a send of an entry came to: every message posted, the attachment ids the port named, each message as posted,
 * and the code of the send that stopped it.
 */
export type EntrySent = {
  status: 'sent' | 'failed' | 'unknown';
  code: string | null;
  messageIds: Array<string>;
  attachmentIds: Array<string>;
  posted: Array<PostedMessage>;
};

/** The part of an interface port the publisher uses. */
export type MirrorPort = {
  iface: string;
  send(conversation: ConversationRef, content: Content): Promise<Delivery>;
};

/** One message she wrote to her diary in a turn (`message.create` with `diary`), held until the turn ends. */
export type HeldDiaryMessage = {
  text: string;
  mentions: ReadonlyArray<string>;
  files: ReadonlyArray<{ name: string; data: Uint8Array; contentType: string | null }>;
};

/** What one turn wrote to her diary: its entry's id, when it began, the community and its messages, in order. */
export type HeldDiary = { id: string; at: number; guildId: string; messages: Array<HeldDiaryMessage> };

/** One mirror as `listMirrors` answers it. */
export type Mirror = { id: string; placeId: string; enabled: boolean };

/** What `publishEntry` answers for each enabled mirror: its place, the publication's state and the port's code. */
export type PublishOutcome = { placeId: string; status: 'queued' | 'sent' | 'failed' | 'unknown'; code: string | null };

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

/** The upload of a file one of her messages carries, under its own name. */
function fileAttachment(file: EntryFile): Attachment {
  return { name: file.name, data: file.data, ...(file.contentType ? { contentType: file.contentType } : {}) };
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
  // Each send with the entry's files it carries, numbered as the entry keeps them: the pictures, then the voice.
  const pictures = entry.pictures ?? [];
  const sends: Array<{ content: Content; items: Array<number> }> = [];
  if (entry.voice)
    sends.push({ content: { attachments: [voiceAttachment(entry.voice, now())] }, items: [pictures.length] });
  // A message's own files go with it, numbered after the pictures and the voice file.
  const filesFrom = pictures.length + (entry.voice ? 1 : 0);
  const files = (entry.files ?? []).map((file, index) => ({ file, item: filesFrom + index }));
  entry.messages.forEach((text, index) => {
    const own = files.filter(({ file }) => file.message === index);
    const content: Content = {
      text,
      mentions: { users: [...(entry.mentions?.[index] ?? [])], repliedUser: false },
      ...(own.length > 0 ? { attachments: own.map(({ file }) => fileAttachment(file)) } : {}),
    };
    sends.push({ content, items: own.map(({ item }) => item) });
  });
  let next = 0;
  for (const chunk of chunkPictures(pictures, maxMessageBytes, filesPerMessage(port))) {
    sends.push({ content: { attachments: pictureAttachments(chunk) }, items: chunk.map(() => next++) });
  }
  const out: EntrySent = { status: 'sent', code: null, messageIds: [], attachmentIds: [], posted: [] };
  for (const { content, items } of sends) {
    const sent = await port.send(conversation, content);
    for (const part of sent.parts.length > 0 ? sent.parts : sent.ref ? [sent.ref] : [])
      out.messageIds.push(part.messageId);
    if (sent.status !== 'ok')
      return {
        ...out,
        status: sent.status === 'unknown' ? 'unknown' : 'failed',
        code: sent.error?.code ?? sent.status,
      };
    out.posted.push(postedOf(sent, content, items));
    for (const file of sent.attachments ?? []) out.attachmentIds.push(file.attachmentId);
  }
  return out;
}

/** One send of an entry as posted: its message, its time, its text and the entry's files with the ids the port named. */
function postedOf(sent: Delivery, content: Content, items: Array<number>): PostedMessage {
  const named = sent.attachments ?? [];
  return {
    messageId: sent.ref?.messageId ?? '',
    at: sent.at,
    text: content.text ?? null,
    files: items.map((item, index) => ({ item, attachmentId: named[index]?.attachmentId ?? null })),
  };
}

/** The places of her diary a sandbox's view names (`memory.diaryChannelIds`, src/behavior/sandbox.js), else none. */
export function viewDiaryIds(view: unknown): Array<string> {
  const read = (view as { memory?: { diaryChannelIds?: unknown } } | null | undefined)?.memory?.diaryChannelIds;
  return typeof read === 'function' ? (read as () => Array<string>)() : [];
}

export { diaryConversationIds, diaryPlaces, isMirrorPlace, mirrorPlaces, readMirrors };
export type { DiaryPlace };

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

/** One file of an entry as memory keeps it: its bytes, its type, what an audio file is, and once sent its platform ids. */
type MediaItem = {
  data: Uint8Array;
  mime: string;
  extra: Row | null;
  ref?: { messageId: string; attachmentId: string | null };
};

/** The entry's files in the order memory numbers them: the pictures, the voice file, then her messages' files. */
function mediaItems(entry: DiaryEntry): Array<MediaItem> {
  return [
    ...(entry.pictures ?? []).map((picture) => ({ data: picture.buffer, mime: picture.mediaType, extra: null })),
    ...(entry.voice
      ? [{ data: entry.voice.ogg, mime: 'audio/ogg', extra: { voice: true, ...voiceExtra(entry.voice) } }]
      : []),
    ...(entry.files ?? []).map((file) => ({
      data: file.data,
      mime: file.contentType ?? 'application/octet-stream',
      extra: { file: { message: file.message, name: file.name } },
    })),
  ];
}

/** The receipts of the attachments a publication posted: one `{ authority, kind: 'attachment', key }` per id. */
function attachmentReceipts(
  iface: string,
  ids: ReadonlyArray<string>
): Array<{ authority: string; kind: string; key: string }> {
  const authority = mirrorReceipts(iface, ['x'])[0]?.authority ?? iface;
  return ids.map((key) => ({ authority, kind: 'attachment', key }));
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
 * `dataDir` in their numbering: the pictures, the voice file, and the files of her messages (`extra.file` names the
 * message and the file's name). A file that cannot be read is left out.
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
  const files: Array<EntryFile> = [];
  for (const item of media) {
    const file = dataDir && typeof item.path === 'string' ? path.join(dataDir, item.path) : null;
    if (!file || !fs.existsSync(file)) continue;
    const buffer = fs.readFileSync(file);
    const mime = String(item.mime);
    const own = objectOf(item.extra).file as { message?: unknown; name?: unknown } | undefined;
    if (own && typeof own.message === 'number') {
      files.push({
        message: own.message,
        name: typeof own.name === 'string' ? own.name : 'file',
        data: buffer,
        contentType: mime,
      });
      continue;
    }
    if (!mime.startsWith('audio/')) {
      pictures.push({ buffer, mediaType: mime });
      continue;
    }
    const extra = objectOf(item.extra);
    const durationSecs = typeof extra.durationSec === 'number' ? extra.durationSec : 0;
    entry.voice = { ogg: buffer, durationSecs, waveform: typeof extra.waveform === 'string' ? extra.waveform : '' };
  }
  return { ...entry, ...(pictures.length > 0 ? { pictures } : {}), ...(files.length > 0 ? { files } : {}) };
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
  queueEntry(entry: DiaryEntry): Promise<void>;
  drainQueued(): Promise<number>;
  holdDiary(turnId: string, guildId: string, message: HeldDiaryMessage): HeldDiary;
  heldDiary(turnId: string): number;
  takeDiary(turnId: string): HeldDiary | null;
  keepEntryMedia(entry: DiaryEntry): Promise<void>;
} {
  // What each running turn wrote to her diary, by its turn id: one entry per turn, published when the turn ends.
  const held = new Map<string, HeldDiary>();

  /** Holds one diary message of the turn `turnId` (its entry gets its id with the first); answers what the turn holds. */
  function holdDiary(turnId: string, guildId: string, message: HeldDiaryMessage): HeldDiary {
    const entry = held.get(turnId) ?? { id: `diary:${randomUUID()}`, at: now(), guildId, messages: [] };
    held.set(turnId, entry);
    entry.messages.push(message);
    return entry;
  }

  /** How many diary messages the turn `turnId` holds. */
  const heldDiary = (turnId: string): number => held.get(turnId)?.messages.length ?? 0;

  /** What the turn `turnId` wrote to her diary, taken once (null when it wrote nothing). */
  function takeDiary(turnId: string): HeldDiary | null {
    const entry = held.get(turnId) ?? null;
    held.delete(turnId);
    return entry;
  }

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
  async function keepMedia(entry: DiaryEntry, sent: EntrySent | null = null): Promise<void> {
    const items = mediaItems(entry);
    // Once sent, each file names the message and the platform's attachment it became.
    for (const message of sent?.posted ?? [])
      for (const file of message.files) {
        const item = items[file.item];
        if (item) item.ref = { messageId: message.messageId, attachmentId: file.attachmentId };
      }
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
    if (sent.status === 'sent') {
      const receipts = [
        ...mirrorReceipts(place.iface, sent.messageIds),
        ...attachmentReceipts(place.iface, sent.attachmentIds),
      ];
      await write({ op: 'sent', id: publication.id, receipts, rendered: entryText(entry), now: now() });
      await keepMedia(entry, sent);
    } else await write({ op: sent.status, id: publication.id });
    log.info('mirror: published', { status: sent.status, messages: sent.messageIds.length, code: sent.code });
    return { placeId: place.placeId, status: sent.status, code: sent.code };
  }

  /**
   * The entry's `queued` publication to every enabled mirror's place, keyed `diary:<entry>:<place>` and prepared once
   * (a later call reuses it); `pending` for an entry a turn is still writing, whose content its send fills. Each with
   * its place.
   */
  async function prepareAll(
    db: Db,
    entry: DiaryEntry,
    pending: boolean
  ): Promise<Array<{ place: DiaryPlace; prepared: Prepared }>> {
    const out: Array<{ place: DiaryPlace; prepared: Prepared }> = [];
    for (const mirror of listMirrors().filter((one) => one.enabled)) {
      const place = mirroredPlace(db, mirror.placeId);
      if (!place) continue;
      const context: Context = issueContext({ kind: 'group', iface: place.iface, destination: place.placeId, now });
      const rendered = entryText(entry);
      const input = { context, rowKind: 'diary', rowId: entry.id, rendered, destination: place.placeId, pending };
      out.push({ place, prepared: (await write({ op: 'prepare', input, now: now() })) as Prepared });
    }
    return out;
  }

  /**
   * An entry a turn is still writing, kept and queued: its media written, one `pending` publication to every enabled
   * mirror. Nothing is sent: `publishEntry` sends it when the turn ends, and after a stop `drainQueued` of a new
   * publisher does.
   */
  async function queueEntry(entry: DiaryEntry): Promise<void> {
    const db = database();
    if (!db) return;
    await keepMedia(entry);
    await prepareAll(db, entry, true);
  }

  async function publishEntry(entry: DiaryEntry): Promise<Array<PublishOutcome>> {
    const db = database();
    if (!db) return [];
    await keepMedia(entry);
    const outcomes: Array<PublishOutcome> = [];
    for (const { place, prepared } of await prepareAll(db, entry, false)) {
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
    // An entry a turn here is still writing goes out when that turn ends.
    const writing = new Set([...held.values()].map((entry) => entry.id));
    for (const publication of queued) {
      if (writing.has(publication.row_id)) continue;
      const place = mirroredPlace(db, publication.destination_place_id);
      if (!place) continue;
      const entry = storedEntry(db, publication, dataDir);
      if ((await send(publication, place, entry)).status === 'sent') sent += 1;
    }
    return sent;
  }

  return {
    listMirrors,
    publishEntry,
    queueEntry,
    drainQueued,
    holdDiary,
    heldDiary,
    takeDiary,
    keepEntryMedia: keepMedia,
  };
}
