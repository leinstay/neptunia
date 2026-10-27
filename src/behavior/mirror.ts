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
// its file with `voiceAttachment`. The entry's pictures and voice live in this process until the row is sent; a row
// still queued after a restart goes out as its rendered text alone.
//
// `diaryPlaces(db)` is the read every diary-channel check uses: the places of the enabled diary mirrors, oldest first,
// or, with none, the place the last entry was published to. Logs carry counts and codes, never a text.

import { log } from '../log.js';
import { portLimit } from '../interface/capabilities.ts';
import { issueContext } from '../memory/db/scope.ts';
import { mirrorReceipts } from '../memory/db/publish.js';
import { setSettings } from './diary.js';
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
  if (hasMirrors(db)) {
    const mirrored = db
      .prepare(
        `SELECT p.id, p.iface, p.native_id, p.name FROM mirrors m JOIN places p ON p.id = m.place_id
          WHERE m.row_kind = 'diary' AND m.enabled = 1 ORDER BY m.created_at, m.id`
      )
      .all()
      .map(placeOf)
      .filter((place): place is DiaryPlace => place !== null);
    if (mirrored.length > 0) return mirrored;
  }
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

/**
 * The publisher of the diary's mirrors over the memory service `memoryDb` and the connected interface's port
 * (`port()`: null when none is connected). `config()` is the live config (`diary.set.maxMessageBytes`, read at each
 * send).
 */
export function createMirrors({
  memoryDb,
  port,
  now,
  config = () => ({}),
}: {
  memoryDb: MirrorMemory;
  port: () => MirrorPort | null;
  now: () => number;
  config?: () => unknown;
}): {
  listMirrors(): Array<Mirror>;
  publishEntry(entry: DiaryEntry): Promise<Array<PublishOutcome>>;
  drainQueued(): Promise<number>;
} {
  // The entries whose publication is still queued, by publication id: their pictures and voice live only here.
  const held = new Map<string, DiaryEntry>();

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

  /** A queued publication sent to its place, when the port of its interface is connected; its outcome. */
  async function send(publication: Publication, place: DiaryPlace, entry: DiaryEntry): Promise<PublishOutcome> {
    const connected = port();
    if (!connected || connected.iface !== place.iface) return { placeId: place.placeId, status: 'queued', code: null };
    const diary = (config() as { diary?: unknown } | null)?.diary ?? null;
    const sent = await sendEntry(connected, { iface: place.iface, conversationId: place.conversationId }, entry, {
      maxMessageBytes: setSettings(diary).maxMessageBytes,
      now,
    });
    held.delete(publication.id);
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
      held.set(publication.id, entry);
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
      const entry = held.get(publication.id) ?? { id: publication.row_id, messages: [publication.rendered ?? ''] };
      if ((await send(publication, place, entry)).status === 'sent') sent += 1;
    }
    return sent;
  }

  return { listMirrors, publishEntry, drainQueued };
}
