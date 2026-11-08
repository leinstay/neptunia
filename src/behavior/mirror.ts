// The selfreflection's mirrors. A mirror is one place her selfreflection entries are posted to, a `mirrors` row the owner set up
// (src/memory/db/mirror-config.ts); there may be none or many. `createMirrors` (wired in src/core.ts) publishes a recorded
// entry once to every enabled mirror: each mirror gets one `publications` row (src/memory/db/publish.ts), keyed
// `selfreflection:<entry id>:<place id>`, prepared `queued` under the mirror's standing grant, claimed through the writer so only
// one publisher sends it (`sending`, src/memory/db/publication-delivery.ts), then sent through the port of its interface
// and marked `sent` with the message ids as receipts, `failed` with the port's code, or `unknown` when nobody knows what
// reached the platform. A second publication of the same entry to the same place reuses the row and sends nothing. While
// its interface is not connected the row stays `queued`, and `drainQueued` (src/behavior/mirror-drain.ts) sends it when
// the interface connects and on the scheduler's tick. Every write goes through the memory service's writer
// (`memoryWrite`, kinds `publication` and `mirror`).
//
// An entry goes out as segments, in the order a selfreflection post goes out from the turn: the voice message, her messages one by
// one, then the pictures in messages of files (`entryPlan`). Each segment has its idempotency key and its receipt, kept as
// it goes out, so a retry resumes at the segment that stopped under the same key. A send that throws, hangs past
// `mirrors.sendTimeoutMs` or answers `unknown` makes the row `unknown` and nothing more goes out: only a receipt, an
// adapter's lookup or the owner settles it. The turn's act path (src/behavior/turn.ts#act) splits a set with the same
// `chunkPictures` and names its files with `pictureAttachments`; `voice.say` (src/tools/impl/voice.ts) builds its file
// with `voiceAttachment`. Before any send the entry's pictures and voice file are kept in memory as files under the data
// directory and `media` rows (memoryWrite kind `entry-media`, src/memory/db/selfreflection-media.ts), so a row still queued after
// a restart goes out whole, and a row whose file is gone holds as `incomplete` with nothing posted
// (src/behavior/mirror-stored.ts).
//
// What may reach a place is read from the stored row at queue time and again right before a send, never from the entry a
// turn held: `storedSelfreflectionPublicationRefusal` (src/memory/db/publish.ts) intersects the trusted restrictions with the
// audience she chose (src/memory/db/selfreflection-audience.ts). A mirror an entry's audience leaves out gets no row, and a row
// queued before a narrowing ends `failed` with `audience-excluded`.
//
// The reads of the mirrors (`mirrorPlaces`, `selfreflectionPlaces`, `isMirrorPlace`, `selfreflectionChatIds`) live with the memory
// database (src/memory/db/mirrors.ts) and are passed on from here to the behaviour modules. A mirror place is not hers
// to write in (the owner, 2026-10-27): `guardMirrorPort` is the core's outbound port, which refuses every send
// there with the code `selfreflection-mirror`, and the message handler opens no turn for an event there (src/behavior/
// pipeline.js). The owner's commands read and change the mirrors through src/behavior/mirror-desk.ts. Logs carry counts
// and codes, never a text.

import { selfreflectionPublicationRefusal } from '../tools/publication.ts';
import type { PublicationBoundary } from '../tools/publication.ts';
import { log } from '../log.ts';
import { portLimit } from '../interface/capabilities.ts';
import { issueContext } from '../memory/db/scope.ts';
import { storedSelfreflectionPublicationRefusal, recheck } from '../memory/db/publish.ts';
import { NO_PLACES, publicationPlaces } from '../memory/db/selfreflection-audience.ts';
import { setSettings } from './selfreflection.ts';
import {
  selfreflectionChatIds,
  selfreflectionPlaces,
  isMirrorPlace,
  mirrorPlaces,
  placeOf,
  readMirrors,
} from '../memory/db/mirrors.ts';
import type { SelfreflectionPlace } from '../memory/db/mirrors.ts';
import { CODE } from '../tools/codes.ts';
import { createMirrorDesk } from './mirror-desk.ts';
import type { MirrorDesk } from './mirror-desk.ts';
import { createMirrorDrain } from './mirror-drain.ts';
import { errorCode } from './mirror-stored.ts';
import type { Attachment, Content } from '../protocol/actions.ts';
import type { Adapter, ChatRef, Delivery, SendOptions } from '../protocol/adapter.ts';
import type { Context } from '../memory/db/scope.ts';
import type { Db, Row } from '../memory/db/types.ts';
import type { StoredDelivery } from '../memory/db/publication-delivery.ts';

/** One picture of an entry: its bytes and its media type. */
export type EntryPicture = { buffer: Uint8Array; mediaType: string };

/** The voice message of an entry: the ogg file, its length and its waveform. */
export type EntryVoice = { ogg: Uint8Array; durationSecs: number; waveform: string };

/** A file one of her messages carries (a file of an errand, a picture she reposts): its name, bytes and type. */
export type EntryFile = { message: number; name: string; data: Uint8Array; contentType: string | null };

/**
 * A selfreflection entry as it is published: its `selfreflection` row's id, her messages as they are sent, the members each message may
 * notify (`mentions[i]` for `messages[i]`, none when absent), whether everyone a message names chose to be pinged (`notify[i]`,
 * src/turn/mentions.ts#mentionsUnderPings), the pictures and the voice message.
 */
export type SelfreflectionEntry = {
  publicationBoundary?: PublicationBoundary;
  id: string;
  messages: ReadonlyArray<string>;
  mentions?: ReadonlyArray<ReadonlyArray<string>>;
  notify?: ReadonlyArray<boolean>;
  pictures?: ReadonlyArray<EntryPicture>;
  voice?: EntryVoice | null;
  /** The files her messages carry, each with the index of its message in `messages`. */
  files?: ReadonlyArray<EntryFile>;
  /** The bytes of one message of pictures (`selfreflection.set.maxMessageBytes` when the entry was recorded). */
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
 * and the code of the send that stopped it, with the segment it stopped at, whether a retry can help and the messages
 * that segment had posted so far.
 */
export type EntrySent = {
  status: 'sent' | 'failed' | 'unknown';
  code: string | null;
  messageIds: Array<string>;
  attachmentIds: Array<string>;
  posted: Array<PostedMessage>;
  stoppedAt?: number;
  retryable?: boolean;
  stoppedMessageIds?: Array<string>;
};

/** The part of an interface port the publisher uses. */
export type MirrorPort = {
  iface: string;
  send(chat: ChatRef, content: Content, options?: SendOptions): Promise<Delivery>;
  /** What the adapter offers; `reconcile` says `fetchMessages` finds a send by its idempotency key. */
  capabilities?: Adapter['capabilities'];
  fetchMessages?: Adapter['fetchMessages'];
};

/** One mirror as `listMirrors` answers it. */
export type Mirror = { id: string; placeId: string; enabled: boolean };

/** What `publishEntry` answers for each enabled mirror: its place, the publication's state and the port's code. */
export type PublishOutcome = {
  placeId: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'incomplete' | 'unknown';
  code: string | null;
};

/** The part of the memory service the publisher uses: the read connection and the one writer. */
export type MirrorMemory = {
  readHandle(): { db: unknown } | null;
  memoryWrite(update: Record<string, unknown>): Promise<unknown>;
};

/** A publication row as the publisher reads it (`SELECT *`). */
export type Publication = {
  id: string;
  status: string;
  row_id: string;
  rendered: string | null;
  destination_place_id: string;
  delivery?: string | null;
  code?: string | null;
};
type Prepared = { ok: true; publication: Publication; reused: boolean } | { ok: false; code: string };

// The files of one message when the adapter names no limit (`capabilities().maxFiles`).
const DEFAULT_FILES_PER_MESSAGE = 10;

// The shipped values of `mirrors.claimLeaseMs` and `mirrors.sendTimeoutMs`, for a publisher given no config.
const DEFAULT_CLAIM_LEASE_MS = 600_000;
const DEFAULT_SEND_TIMEOUT_MS = 120_000;

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
 * A selfreflection set's pictures split into messages, in order: a message holds at most `maxFiles` files, and a picture whose
 * bytes would take its message past `maxBytes` (`selfreflection.set.maxMessageBytes`) starts the next one; a picture larger
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
export function entryText(entry: Pick<SelfreflectionEntry, 'messages'>): string {
  return entry.messages.join('\n');
}

/** One segment of an entry: what one send carries and the entry's files in it, numbered as the entry keeps them. */
export type EntrySegment = { content: Content; items: Array<number> };

/**
 * The segments of `entry` in their order: the voice message, her messages one by one, then the pictures in messages of
 * files split by `chunkPictures` over `maxMessageBytes` and the port's `maxFiles`.
 */
export function entryPlan(
  port: MirrorPort,
  entry: SelfreflectionEntry,
  { maxMessageBytes, now }: { maxMessageBytes: number; now: () => number }
): Array<EntrySegment> {
  // Each send with the entry's files it carries, numbered as the entry keeps them: the pictures, then the voice.
  const pictures = entry.pictures ?? [];
  const sends: Array<EntrySegment> = [];
  if (entry.voice)
    sends.push({ content: { attachments: [voiceAttachment(entry.voice, now())] }, items: [pictures.length] });
  // A message's own files go with it, numbered after the pictures and the voice file.
  const filesFrom = pictures.length + (entry.voice ? 1 : 0);
  const files = (entry.files ?? []).map((file, index) => ({ file, item: filesFrom + index }));
  entry.messages.forEach((text, index) => {
    const own = files.filter(({ file }) => file.message === index);
    const content: Content = {
      text,
      mentions: {
        users: [...(entry.mentions?.[index] ?? [])],
        repliedUser: false,
        ...(entry.notify?.[index] === true ? { notify: true } : {}),
      },
      ...(own.length > 0 ? { attachments: own.map(({ file }) => fileAttachment(file)) } : {}),
    };
    sends.push({ content, items: own.map(({ item }) => item) });
  });
  let next = 0;
  for (const chunk of chunkPictures(pictures, maxMessageBytes, filesPerMessage(port))) {
    sends.push({ content: { attachments: pictureAttachments(chunk) }, items: chunk.map(() => next++) });
  }
  return sends;
}

/** What a run over a plan does around each send. */
export type PlanHooks = {
  /** A segment that already went out, in an earlier attempt. */
  done?: (segment: number) => boolean;
  /** The idempotency key of a segment. */
  keyOf?: (segment: number) => string;
  /** Called once a segment went out, with its messages and attachments. Its failure stops the run. */
  onSent?: (segment: number, messageIds: Array<string>, attachmentIds: Array<string>) => Promise<boolean>;
  /** How long one send may take (ms); past it the result is `unknown`. */
  timeoutMs?: number;
};

/** A send's answer when no port gave one: nobody knows what reached the platform. */
const unknownDelivery = (code: string): Delivery => ({
  status: 'unknown',
  ref: null,
  parts: [],
  at: null,
  idempotencyKey: '',
  error: { code, retryable: false, retryAfterMs: null },
});

/** One send under its key. A send that throws or hangs past `timeoutMs` answers `unknown`. */
async function attempt(
  port: MirrorPort,
  chat: ChatRef,
  content: Content,
  key: string | undefined,
  timeoutMs: number | undefined
): Promise<Delivery> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const sending = port.send(chat, content, key === undefined ? undefined : { idempotencyKey: key });
    if (timeoutMs === undefined) return await sending;
    const hung = new Promise<Delivery>((resolve) => {
      timer = setTimeout(() => resolve(unknownDelivery('send-timeout')), timeoutMs);
      timer.unref?.();
    });
    // A send that rejects after its time is over is nobody's to hear.
    sending.catch(() => {});
    return await Promise.race([sending, hung]);
  } catch (err) {
    return unknownDelivery(errorCode(err, 'send-threw'));
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Sends the segments of a plan one after another. Stops at the first send that is not `ok`: `failed` with the port's code,
 * or `unknown` when the port could not tell whether it went out. `messageIds` holds every message posted in this run, the
 * parts of a split send included.
 */
export async function sendPlan(
  port: MirrorPort,
  chat: ChatRef,
  plan: ReadonlyArray<EntrySegment>,
  hooks: PlanHooks = {}
): Promise<EntrySent> {
  const out: EntrySent = { status: 'sent', code: null, messageIds: [], attachmentIds: [], posted: [] };
  for (const [segment, { content, items }] of plan.entries()) {
    if (hooks.done?.(segment) === true) continue;
    const sent = await attempt(port, chat, content, hooks.keyOf?.(segment), hooks.timeoutMs);
    const ids = (sent.parts.length > 0 ? sent.parts : sent.ref ? [sent.ref] : []).map((part) => part.messageId);
    out.messageIds.push(...ids);
    if (sent.status !== 'ok')
      return {
        ...out,
        status: sent.status === 'unknown' ? 'unknown' : 'failed',
        code: sent.error?.code ?? sent.status,
        stoppedAt: segment,
        retryable: sent.error?.retryable === true,
        stoppedMessageIds: ids,
      };
    out.posted.push(postedOf(sent, content, items));
    const attachments = (sent.attachments ?? []).map((file) => file.attachmentId);
    out.attachmentIds.push(...attachments);
    if (hooks.onSent && !(await hooks.onSent(segment, ids, attachments)))
      return { ...out, status: 'unknown', code: 'claim-lost', stoppedAt: segment, stoppedMessageIds: [] };
  }
  return out;
}

/** Sends `entry` to `chat` through `port`, unless its restriction refuses the place (`entryPlan`, `sendPlan`). */
export async function sendEntry(
  port: MirrorPort,
  chat: ChatRef,
  entry: SelfreflectionEntry,
  { maxMessageBytes, now }: { maxMessageBytes: number; now: () => number }
): Promise<EntrySent> {
  if (selfreflectionPublicationRefusal(entry.publicationBoundary, chat))
    return { status: 'failed', code: 'not-allowed', messageIds: [], attachmentIds: [], posted: [] };
  return sendPlan(port, chat, entryPlan(port, entry, { maxMessageBytes, now }));
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

/** The places of her selfreflection a sandbox's view names (`memory.selfreflectionChannelIds`, src/behavior/sandbox.ts), else none. */
export function viewSelfreflectionIds(view: unknown): Array<string> {
  const read = (view as { memory?: { selfreflectionChannelIds?: unknown } } | null | undefined)?.memory
    ?.selfreflectionChannelIds;
  return typeof read === 'function' ? (read as () => Array<string>)() : [];
}

export {
  NO_PLACES,
  selfreflectionChatIds,
  selfreflectionPlaces,
  isMirrorPlace,
  mirrorPlaces,
  publicationPlaces,
  readMirrors,
};
export type { SelfreflectionPlace };

/**
 * The core's outbound port: `port` with every `send` to the place of an enabled selfreflection mirror refused with the code
 * `selfreflection-mirror` (nothing reaches the interface), read in `memoryDb` at each send. Only the mirrors' publisher, which
 * holds the interface's own port, writes there. Everything else passes through.
 */
export function guardMirrorPort<TPort extends MirrorPort>(port: TPort, { memoryDb }: { memoryDb: unknown }): TPort {
  async function send(chat: ChatRef, content: Content, options?: SendOptions): Promise<Delivery> {
    // The options pass through: the idempotency key of a send is what a reconcile finds it by.
    if (!isMirrorPlace(memoryDb, chat.iface, chat.chatId)) return port.send(chat, content, options);
    log.info('mirror: send refused', { code: CODE.SELFREFLECTION_MIRROR });
    return {
      status: 'failed',
      ref: null,
      parts: [],
      at: null,
      idempotencyKey: '',
      error: { code: CODE.SELFREFLECTION_MIRROR, retryable: false, retryAfterMs: null },
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
function mediaItems(entry: SelfreflectionEntry): Array<MediaItem> {
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

/** What an audio `media` row of an entry keeps of its voice message: its length and its waveform. */
function voiceExtra(voice: EntryVoice): { durationSec: number; waveform: string } {
  return { durationSec: voice.durationSecs, waveform: voice.waveform };
}

/** The settings of the publisher, read at each use. */
export function mirrorSettings(config: unknown): { claimLeaseMs: number; sendTimeoutMs: number } {
  const section = (config as { mirrors?: { claimLeaseMs?: unknown; sendTimeoutMs?: unknown } } | null)?.mirrors;
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  const claimLeaseMs = positive(section?.claimLeaseMs, DEFAULT_CLAIM_LEASE_MS);
  // A send outliving the lease would have its claim expire under it.
  return {
    claimLeaseMs,
    sendTimeoutMs: Math.min(positive(section?.sendTimeoutMs, DEFAULT_SEND_TIMEOUT_MS), claimLeaseMs),
  };
}

/** Every claimant this process makes differs, so a publisher whose claim expired can be told from its successor. */
let claimants = 0;
const nextClaimant = (): string => `publisher:${process.pid}:${(claimants += 1)}`;

/** The stored state of one segment of a delivery, read at the call. */
const segmentOf = ({ segments }: StoredDelivery, segment: number) => segments[segment];

/** The publisher's whole surface: publishing, draining, and the owner's desk. */
export type Mirrors = MirrorDesk & {
  publishEntry(entry: SelfreflectionEntry): Promise<Array<PublishOutcome>>;
  queueEntry(entry: SelfreflectionEntry): Promise<void>;
  drainQueued(): Promise<number>;
  keepEntryMedia(entry: SelfreflectionEntry): Promise<void>;
  /** A selfreflection turn begins: until the answered function is called, a drain leaves entries with no publication alone. */
  beginEntry(): () => void;
};

/**
 * The publisher of the selfreflection's mirrors over the memory service `memoryDb` and the port of each interface (`port(iface)`:
 * null while that interface is not connected). `dataDir` is the memory service's data directory, where the entries' media
 * files are kept. `config()` is the live config: `mirrors.claimLeaseMs`, `mirrors.sendTimeoutMs`, and
 * `selfreflection.set.maxMessageBytes` for an entry that names no `maxMessageBytes`.
 */
export function createMirrors({
  memoryDb,
  port,
  now,
  dataDir = null,
  config = () => ({}),
}: {
  memoryDb: MirrorMemory;
  port: (iface: string) => MirrorPort | null;
  now: () => number;
  dataDir?: string | null;
  config?: () => unknown;
}): Mirrors {
  function database(): Db | null {
    const handle = memoryDb.readHandle();
    return handle ? (handle.db as Db) : null; // the service's read connection is node:sqlite's
  }

  const desk = createMirrorDesk({ memoryDb, database, port, now });

  /** The enabled mirror's place `placeId` as a selfreflection place, or null when it is no longer an enabled mirror. */
  function mirroredPlace(db: Db, placeId: string): SelfreflectionPlace | null {
    return placeOf(
      db
        .prepare(
          `SELECT p.id, p.iface, p.native_id, p.name FROM mirrors m JOIN places p ON p.id = m.place_id
            WHERE m.row_kind = 'selfreflection' AND m.enabled = 1 AND m.place_id = ?`
        )
        .get(placeId)
    );
  }

  const write = (update: Record<string, unknown>): Promise<unknown> =>
    memoryDb.memoryWrite({ kind: 'publication', ...update });

  /** The entry's pictures, then its voice file, kept in memory before anything is sent (in that order: numbered so). */
  async function keepMedia(entry: SelfreflectionEntry, sent: EntrySent | null = null): Promise<void> {
    const items = mediaItems(entry);
    // Once sent, each file names the message and the platform's attachment it became.
    for (const message of sent?.posted ?? [])
      for (const file of message.files) {
        const item = items[file.item];
        if (item) item.ref = { messageId: message.messageId, attachmentId: file.attachmentId };
      }
    if (items.length > 0) await memoryDb.memoryWrite({ kind: 'entry-media', id: entry.id, items });
  }

  /** A refusal or a hold with nothing sent: the row keeps its code, and a drain's next look at it writes nothing new. */
  async function hold(
    publication: Publication,
    place: SelfreflectionPlace,
    status: 'failed' | 'incomplete',
    code: string,
    paced: boolean
  ): Promise<PublishOutcome> {
    if (publication.status !== status || publication.code !== code)
      await write({ op: 'hold', id: publication.id, status, code, retryable: false, paced });
    return { placeId: place.placeId, status, code };
  }

  /** The claimed row's segments sent one after another, each receipt written as it goes out; the row's end. */
  async function sendClaimed(
    publication: Publication,
    place: SelfreflectionPlace,
    entry: SelfreflectionEntry,
    connected: MirrorPort,
    plan: Array<EntrySegment>,
    claimant: string,
    delivery: StoredDelivery
  ): Promise<PublishOutcome> {
    const sent = await sendPlan(connected, { iface: place.iface, chatId: place.chatId }, plan, {
      done: (segment) => segmentOf(delivery, segment)?.status === 'sent',
      keyOf: (segment) => segmentOf(delivery, segment)?.key ?? `${publication.id}:${segment}`,
      timeoutMs: mirrorSettings(config()).sendTimeoutMs,
      onSent: async (segment, messageIds, attachmentIds) => {
        const answer = (await write({
          op: 'segment',
          id: publication.id,
          claimant,
          segment,
          messageIds,
          attachmentIds,
          now: now(),
        })) as { held?: unknown };
        return answer.held === true;
      },
    });
    const { status } = sent;
    if (status === 'sent') {
      await write({ op: 'settle', id: publication.id, claimant, status, rendered: entryText(entry), now: now() });
      // The entry is out: a lost write of its media ids costs a reference, never the publication.
      await keepMedia(entry, sent).catch((err: unknown) =>
        log.warn('mirror: media ids not kept', { code: errorCode(err, 'ERROR') })
      );
    } else if (sent.code !== 'claim-lost')
      await write({
        op: 'settle',
        id: publication.id,
        claimant,
        status,
        code: sent.code,
        retryable: sent.retryable === true,
        segment: sent.stoppedAt,
        messageIds: sent.stoppedMessageIds ?? [],
        now: now(),
      });
    log.info('mirror: published', { status, messages: sent.messageIds.length, code: sent.code });
    return { placeId: place.placeId, status, code: sent.code };
  }

  /**
   * One publication to its place, when the port of its interface is connected and nothing else holds it: rechecked,
   * claimed through the writer, sent. `paced` is a historical slot's send; `missing` names an entry whose file is gone.
   */
  async function send(
    publication: Publication,
    place: SelfreflectionPlace,
    entry: SelfreflectionEntry,
    { paced = false, missing = false }: { paced?: boolean; missing?: boolean } = {}
  ): Promise<PublishOutcome> {
    const db = database();
    const destination = { iface: place.iface, chatId: place.chatId };
    const context = issueContext({ kind: 'group', iface: place.iface, destination: place.placeId, now });
    const refusal = selfreflectionPublicationRefusal(entry.publicationBoundary, destination);
    const checked = db ? recheck(db, publication.id, context) : { ok: false };
    // Another publisher took the row since it was read.
    if ('code' in checked && checked.code === 'not-pending')
      return { placeId: place.placeId, status: 'sending', code: null };
    if (refusal || !checked.ok) {
      const code = refusal?.code ?? ('code' in checked ? String(checked.code) : 'not-allowed');
      return hold(publication, place, 'failed', code, paced);
    }
    const connected = port(place.iface);
    if (!connected || connected.iface !== place.iface)
      return { placeId: place.placeId, status: publication.status as PublishOutcome['status'], code: null };
    if (missing) return hold(publication, place, 'incomplete', 'media-missing', paced);
    const selfreflection = (config() as { selfreflection?: unknown } | null)?.selfreflection ?? null;
    const maxMessageBytes = entry.maxMessageBytes ?? setSettings(selfreflection).maxMessageBytes;
    const plan = entryPlan(connected, entry, { maxMessageBytes, now });
    const claimant = nextClaimant();
    const claim = (await write({
      op: 'claim',
      id: publication.id,
      claimant,
      count: plan.length,
      messages: entry.messages,
      ...(entry.mentions ? { mentions: entry.mentions } : {}),
      paced,
      now: now(),
    })) as { ok: true; delivery: StoredDelivery } | { ok: false };
    if (!claim.ok) return { placeId: place.placeId, status: 'sending', code: null };
    return sendClaimed(publication, place, entry, connected, plan, claimant, claim.delivery);
  }

  /** The entry's `queued` publication to one place, or the code that refuses it; `pending` when it has no content yet. */
  async function prepareFor(
    db: Db,
    entry: SelfreflectionEntry,
    place: SelfreflectionPlace,
    pending: boolean
  ): Promise<Prepared> {
    const carried = selfreflectionPublicationRefusal(entry.publicationBoundary, {
      iface: place.iface,
      chatId: place.chatId,
    });
    const refusal = carried?.code ?? storedSelfreflectionPublicationRefusal(db, entry.id, place.placeId);
    if (refusal) return { ok: false, code: refusal };
    const context: Context = issueContext({ kind: 'group', iface: place.iface, destination: place.placeId, now });
    const rendered = entryText(entry);
    const input = {
      context,
      rowKind: 'selfreflection',
      rowId: entry.id,
      rendered,
      destination: place.placeId,
      pending,
    };
    return (await write({ op: 'prepare', input, now: now() })) as Prepared;
  }

  /**
   * The entry's `queued` publication to every enabled mirror's place, keyed `selfreflection:<entry>:<place>` and prepared once
   * (a later call reuses it); `pending` for an entry a turn is still writing, whose content its send fills. Each with
   * its place.
   */
  async function prepareAll(
    db: Db,
    entry: SelfreflectionEntry,
    pending: boolean
  ): Promise<Array<{ place: SelfreflectionPlace; prepared: Prepared }>> {
    const out: Array<{ place: SelfreflectionPlace; prepared: Prepared }> = [];
    for (const mirror of desk.listMirrors().filter((one) => one.enabled)) {
      const place = mirroredPlace(db, mirror.placeId);
      if (place) out.push({ place, prepared: await prepareFor(db, entry, place, pending) });
    }
    return out;
  }

  /**
   * An entry a turn is still writing, kept and queued: its media written, one `pending` publication to every enabled
   * mirror. Nothing is sent: `publishEntry` sends it when the turn ends, and after a stop `drainQueued` of a new
   * publisher does.
   */
  async function queueEntry(entry: SelfreflectionEntry): Promise<void> {
    const db = database();
    if (!db) return;
    await keepMedia(entry);
    await prepareAll(db, entry, true);
  }

  async function publishEntry(entry: SelfreflectionEntry): Promise<Array<PublishOutcome>> {
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
        const status = publication.status as PublishOutcome['status'];
        outcomes.push({ placeId: place.placeId, status, code: publication.code ?? null });
        continue;
      }
      // One mirror's trouble stops none of the others: a failed write leaves its claim to the lease.
      outcomes.push(
        await send(publication, place, entry).catch((err: unknown): PublishOutcome => {
          const code = errorCode(err, 'publish-failed');
          log.warn('mirror: publish stopped', { code });
          return { placeId: place.placeId, status: 'unknown', code };
        })
      );
    }
    return outcomes;
  }

  let writing = 0;
  const drainQueued = createMirrorDrain({
    database,
    memoryDb,
    port,
    now,
    dataDir,
    leaseMs: () => mirrorSettings(config()).claimLeaseMs,
    mirroredPlace,
    prepareFor,
    send,
    entriesBeingWritten: () => writing,
  });

  return {
    ...desk,
    publishEntry,
    queueEntry,
    drainQueued,
    keepEntryMedia: keepMedia,
    beginEntry() {
      writing += 1;
      let released = false;
      return () => {
        if (!released) writing -= 1;
        released = true;
      };
    },
  };
}
