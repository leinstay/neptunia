// The diary turn's own steps, beside the turn runner (src/behavior/turn.js, mode `diary`). A diary turn writes her
// entry and sends nothing: the entry is recorded in memory first (`recordEntry`, the store's diary unit), and the
// diary's mirrors publish it (src/behavior/mirror.ts). Run as the `selfreflection` wake it has no conversation, and
// `wakeInputs` gives it the place her diary is posted to (mirror.ts#diaryPlaces) as its conversation and her diary as
// its history: her entries' posts as memory holds them, message by message, read through the same line builder
// (src/behavior/line-of.js). `pictureGate` says whether the post may carry a picture, and
// `diaryVoiceTool` keeps her voice message for the entry instead of posting it. Logs: none.

import { randomUUID } from 'node:crypto';
import { DIARY_DAILY, DIARY_PICTURES_DAILY, gistOf, isPictureKind, setSettings } from './diary.js';
import { lineOf } from './line-of.js';
import { diaryPlaces, readMirrors } from './mirror.ts';
import type { DiaryEntry, DiaryPlace, EntryPicture, EntryVoice } from './mirror.ts';
import { bumpDaily, countToday } from '../time.js';
import { CODE } from '../tools/codes.ts';
import type { ConversationInfo, ConversationRef, MessageEvent } from '../protocol/adapter.ts';

type Config = Record<string, unknown>;
type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...params: Array<unknown>): Array<Row> } };
/** The day counters of the store's state (`store.state.data`). */
type Counters = Record<string, unknown>;
type Daily = { dayKey: string; countKey: string };

// diary.js and time.js are JS; these are their functions as this module calls them, with its own value types.
const gist = gistOf as (text: string, chars: number) => string;
const pictureKind = isPictureKind as (kind: string, pictureKinds: unknown) => boolean;
const today = countToday as (state: Counters, keys: Daily, nowMs: number) => number;
const bump = bumpDaily as (state: Counters, keys: Daily, nowMs: number) => void;
const setOf = setSettings as (diaryCfg: unknown) => { maxMessageBytes: number };
const POSTS_DAILY: Daily = DIARY_DAILY;
const PICTURES_DAILY: Daily = DIARY_PICTURES_DAILY;

const sectionOf = (config: Config, name: string): Config => {
  const found = config[name];
  return typeof found === 'object' && found !== null ? (found as Config) : {};
};
const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Whether a diary post may carry a picture now, and the cap that closed when not (`limit: null` for the switches). */
export type PictureGate = { allowed: boolean; limit: { key: string; used: number; cap: number } | null };

/**
 * Whether a diary post may carry a picture, in this order: an image client (`imageQuota`), `features.imageGeneration`
 * (a missing key counts as on), Attach Files in the conversation (`attach`), the day's diary pictures under
 * `diary.maxPicturesPerDay` (8), the image client's own daily cap (`image.maxPerDay`). Pure.
 */
export function pictureGate({
  config,
  attach,
  imageQuota,
  data,
  now,
}: {
  config: Config;
  attach: boolean;
  imageQuota: { used: number; cap: number } | null;
  data: Counters;
  now: number;
}): PictureGate {
  const closed = (limit: PictureGate['limit'] = null): PictureGate => ({ allowed: false, limit });
  if (!imageQuota || sectionOf(config, 'features').imageGeneration === false || !attach) return closed();
  const picturesToday = today(data, PICTURES_DAILY, now);
  const diaryCap = numberOr(sectionOf(config, 'diary').maxPicturesPerDay, 8);
  if (picturesToday >= diaryCap) return closed({ key: 'diary.maxPicturesPerDay', used: picturesToday, cap: diaryCap });
  if (imageQuota.used >= imageQuota.cap)
    return closed({ key: 'image.maxPerDay', used: imageQuota.used, cap: imageQuota.cap });
  return { allowed: true, limit: null };
}

/**
 * The refusal of a forced picture kind (`/nep diary post <kind>`) while the post may carry no picture, naming the
 * gate that closed, or null. Asked before any request.
 */
export function forcedPictureRefusal({
  config,
  kind,
  gate,
}: {
  config: Config;
  kind: unknown;
  gate: () => PictureGate;
}): { outcome: 'refused'; reason: 'pictures'; limit: PictureGate['limit'] } | null {
  if (typeof kind !== 'string' || !pictureKind(kind, sectionOf(config, 'diary').pictureKinds)) return null;
  const closed = gate();
  return closed.allowed ? null : { outcome: 'refused', reason: 'pictures', limit: closed.limit };
}

/**
 * The voice message of a diary post: what was voiced and its length, and the file when the turn made it (a voice
 * posted through her operation instead leaves only the text and the length).
 */
export type HeldVoice = Partial<EntryVoice> & { text: string; durationSecs: number };

/** What a diary turn holds instead of sending: her messages as written and as they would be sent. */
export type HeldSpeech = { texts: Array<string>; rendered: Array<{ text: string; userIds: Array<string> }> };

/**
 * `voice.say` as a diary turn runs it (in the turn, src/tools/executors.ts#executeCall's `inTurn`): the voice file is
 * made through `speech.say` and kept in `held.diaryVoice` for the entry; nothing is posted. Without a speech client that
 * can say, there is no such tool and the call takes its usual way.
 */
export function diaryVoiceTool({
  speech,
  held,
}: {
  speech: unknown;
  held: { diaryVoice?: HeldVoice | null };
}): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const say = (speech as { say?: unknown } | null)?.say;
  if (typeof say !== 'function') return {};
  return {
    'voice.say': async (args) => {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return { status: 'invalid', code: CODE.INVALID_ARGS, data: { text: '' } };
      // src/speech/index.js#createSpeech answers the file and what was voiced.
      const made = (await (say as (input: { text: string }) => Promise<unknown>)({ text })) as {
        ogg: Uint8Array;
        durationSecs: number;
        waveform: string;
        voiced: string;
      };
      held.diaryVoice = { ogg: made.ogg, durationSecs: made.durationSecs, waveform: made.waveform, text: made.voiced };
      return { status: 'ok', code: CODE.STAGED, data: { text: '' } };
    },
  };
}

/** A staged picture of the post: the generated picture and its scene. */
export type StagedPicture = EntryPicture & { text: string };

/** The part of the store `recordEntry` uses. */
export type DiaryStore = {
  appendDiaryPost?: (guildId: string, post: Record<string, unknown>, opts: { max: number }) => unknown;
  state: { data: Counters; markDirty(): void };
};

/**
 * A diary post recorded before anything is sent: one post in the guild's diary (`store.appendDiaryPost`, the newest
 * `diary.historyPosts` (150) kept) with its gist and its first picture's scene cut to `diary.gistChars` (200), her
 * full text, the entry's id as its `itemId`, its search query, how it is sent (`send`: her messages as sent, their
 * mentions, the set's byte limit) and, with a voice message, the text as voiced and its length; the day's diary post
 * counted. Every picture was counted when it was generated. Returns the outcome's `diary`
 * field: the counts and the entry the mirrors publish.
 */
export function recordEntry({
  store,
  config,
  guildId,
  now,
  plan,
  held,
  staged,
  set,
  voice,
  newId = () => `diary:${randomUUID()}`,
}: {
  store: DiaryStore;
  config: Config;
  guildId: string;
  now: number;
  plan: { kind: string | null; search?: string | null };
  held: HeldSpeech;
  staged: ReadonlyArray<StagedPicture>;
  set: boolean;
  voice: HeldVoice | null;
  newId?: () => string;
}): {
  kind: string | null;
  picture: boolean;
  search: boolean;
  messages: number;
  pictures: number;
  entry: DiaryEntry;
} {
  const diaryCfg = sectionOf(config, 'diary');
  const gistChars = numberOr(diaryCfg.gistChars, 200);
  const id = newId();
  const first = staged[0];
  const maxMessageBytes = setOf(diaryCfg).maxMessageBytes;
  const rendered = {
    messages: held.rendered.map((part) => part.text),
    mentions: held.rendered.map((part) => part.userIds),
  };
  if (typeof store.appendDiaryPost === 'function') {
    store.appendDiaryPost(
      guildId,
      {
        at: now,
        kind: plan.kind,
        gist: gist(held.texts.join(' '), gistChars),
        picture: first ? gist(first.text, gistChars) : null,
        ...(set ? { pictures: staged.length } : {}),
        search: plan.search || null,
        text: held.texts.join('\n'),
        itemId: id,
        ...(voice ? { voice: { text: voice.text, durationSec: voice.durationSecs } } : {}),
        // How the entry goes out, kept so a publication sent after a restart sends it whole (src/behavior/mirror.ts).
        send: { ...rendered, maxMessageBytes },
      },
      { max: numberOr(diaryCfg.historyPosts, 150) }
    );
  }
  bump(store.state.data, POSTS_DAILY, now);
  store.state.markDirty();
  const entry: DiaryEntry = {
    id,
    ...rendered,
    pictures: staged.map((item) => ({ buffer: item.buffer, mediaType: item.mediaType })),
    voice: voice?.ogg ? { ogg: voice.ogg, durationSecs: voice.durationSecs, waveform: voice.waveform ?? '' } : null,
    maxMessageBytes,
  };
  return {
    kind: plan.kind,
    picture: staged.length > 0,
    search: Boolean(plan.search),
    messages: held.texts.length,
    pictures: staged.length,
    entry,
  };
}

/** One message of her diary as memory holds it: a message of the platform's shape, and its addressing. */
type DiaryMessage = { message: Row; addressing: Row | null };

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The JSON object or array a column holds, or null. */
function jsonOf(value: unknown): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : null;
  } catch {
    // A column that cannot be read holds nothing.
    return null;
  }
}

/** The message ids an entry was posted as, each once: its legacy mirror's, then its sent publication's receipts. */
function messageIdsOf(db: Db, entryId: string): Array<string> {
  const ids: Array<string> = [];
  for (const row of db
    .prepare('SELECT native_ids FROM diary_mirrors WHERE diary_id = ? AND retired_at IS NULL ORDER BY rowid')
    .all(entryId)) {
    const parsed = jsonOf(row.native_ids);
    if (Array.isArray(parsed))
      for (const id of parsed as Array<unknown>) if (typeof id === 'string' && id) ids.push(id);
  }
  // Its sent publication's receipts too: a message the v15 step joined to it is named there only.
  for (const row of db
    .prepare(
      "SELECT receipts FROM publications WHERE row_kind = 'diary' AND row_id = ? AND status = 'sent' AND retired_at IS NULL ORDER BY created_at, id LIMIT 1"
    )
    .all(entryId)) {
    const parsed = jsonOf(row.receipts);
    if (Array.isArray(parsed))
      for (const receipt of parsed as Array<{ key?: unknown; kind?: unknown }>)
        if (typeof receipt?.key === 'string' && receipt.key && receipt.kind !== 'attachment') ids.push(receipt.key);
  }
  return [...new Set(ids)];
}

/** An entry's files as memory keeps them, by the message that carries each: the attachment as the platform names it. */
function filesOf(db: Db, entryId: string): Map<string, Array<Row>> {
  const byMessage = new Map<string, Array<Row>>();
  const rows = db
    .prepare(
      "SELECT id, native_ref, mime, bytes, extra FROM media WHERE kind = 'diary' AND owner = ? AND retired_at IS NULL"
    )
    .all(entryId)
    .sort((a, b) => Number(/-(\d+)$/.exec(String(a.id))?.[1] ?? 0) - Number(/-(\d+)$/.exec(String(b.id))?.[1] ?? 0));
  for (const row of rows) {
    const ref = (jsonOf(row.native_ref) ?? {}) as Row;
    const messageId = textOf(ref.messageId);
    if (!messageId) continue;
    const mime = textOf(row.mime);
    const voice = mime.startsWith('audio/') && (jsonOf(row.extra) as Row | null)?.voice === true;
    const extra = (jsonOf(row.extra) ?? {}) as Row;
    const file: Row = {
      id: textOf(ref.attachmentId) || String(row.id),
      kind: voice ? 'voice' : mime.startsWith('image/') ? 'image' : 'file',
      url: textOf(ref.url) || null,
      contentType: mime || null,
      size: numberOr(row.bytes, 0),
      ...(voice && typeof extra.durationSec === 'number' ? { durationSec: extra.durationSec } : {}),
    };
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), file]);
  }
  return byMessage;
}

/**
 * Her diary as memory holds it, the newest `limit` messages, oldest first: each entry's post message by message, each
 * message's text, time and what it answers from the newest revision of her line in the record of `placeId` (`said`
 * or `seen`, `editedAt` set from the second revision on), its files from the entry's media
 * rows; an entry with no such line is its text as one message under its first message id (or its own id), at the
 * entry's time. Nothing of anyone else: the mirror place's other lines are no part of her diary.
 */
function diaryMessages(db: Db, placeId: string | null, limit: number): Array<DiaryMessage> {
  const out: Array<DiaryMessage> = [];
  const said = db.prepare(
    `SELECT native_id, revision, occurred_at, recorded_at, text, reply_to FROM sources
      WHERE place_id = ? AND native_id = ? AND kind IN ('said', 'seen') AND retired_at IS NULL
      ORDER BY revision DESC, kind = 'said' DESC LIMIT 1`
  );
  const deleted = db.prepare(
    "SELECT 1 AS gone FROM sources WHERE place_id = ? AND native_id = ? AND kind = 'deleted' AND retired_at IS NULL LIMIT 1"
  );
  const entries = db
    .prepare('SELECT id, at_ms, text FROM diary WHERE retired_at IS NULL ORDER BY at_ms DESC, position DESC')
    .all();
  for (const entry of entries) {
    if (out.length >= limit) break;
    const entryId = String(entry.id);
    const ids = messageIdsOf(db, entryId);
    const files = filesOf(db, entryId);
    const lines = placeId ? ids.map((id) => ({ id, line: said.all(placeId, id)[0] })) : [];
    const posted: Array<DiaryMessage> = [];
    for (const { id, line } of lines) {
      // A message she deleted, or one with neither text nor a file, is no line of her diary.
      if ((!textOf(line?.text) && !files.has(id)) || deleted.all(placeId, id).length > 0) continue;
      const at = Date.parse(textOf(line?.occurred_at));
      const recordedAt = Date.parse(textOf(line?.recorded_at));
      const edited = numberOr(line?.revision, 1) > 1;
      posted.push({
        message: {
          id,
          content: textOf(line?.text),
          at: Number.isFinite(at) ? at : numberOr(entry.at_ms, 0),
          replyToId: textOf(line?.reply_to) || null,
          attachments: files.get(id) ?? [],
          editedAt: edited ? (Number.isFinite(recordedAt) ? recordedAt : at) : null,
        },
        addressing: null,
      });
    }
    if (posted.length === 0 && textOf(entry.text) !== '')
      posted.push({
        message: { id: ids[0] ?? entryId, content: textOf(entry.text), at: numberOr(entry.at_ms, 0) },
        addressing: null,
      });
    out.push(...posted.reverse());
  }
  return out.slice(0, limit).sort((a, b) => numberOr(a.message.at, 0) - numberOr(b.message.at, 0));
}

/** What the selfreflection wake turns in place of the diary channel: its conversation, the channel and its history. */
export type WakeInputs = {
  conversation: ConversationRef;
  channel: ConversationInfo;
  history: Array<Record<string, unknown>>;
};

/**
 * The inputs of a diary turn run as the `selfreflection` wake, which has no conversation: the place her diary is
 * posted to (mirror.ts#diaryPlaces: the first enabled mirror, else the place the last entry was published to), that
 * place as the interface describes it (`conversationInfo`), else as memory names it, and her diary as its history: the
 * newest `context.channelMessages` messages of her entries (diaryMessages), each through the line builder with her as
 * the author. With no place at all the conversation is her diary itself (`selfreflection`), with every permission.
 */
export async function wakeInputs({
  store,
  conversationInfo,
  iface,
  guildId,
  selfId,
  selfName,
  config,
}: {
  store: unknown;
  conversationInfo: (ref: ConversationRef) => Promise<{ conversation: ConversationInfo } | null>;
  iface: string;
  guildId: string;
  selfId: string;
  selfName: string;
  config: Config;
}): Promise<WakeInputs> {
  const place: DiaryPlace | null = readMirrors(store, diaryPlaces, [])[0] ?? null;
  const conversation = place
    ? { iface: place.iface, conversationId: place.conversationId }
    : { iface, conversationId: 'selfreflection' };
  const known = place ? ((await conversationInfo(conversation))?.conversation ?? null) : null;
  const channel: ConversationInfo = known ?? {
    iface: conversation.iface,
    id: conversation.conversationId,
    kind: 'channel',
    name: place?.name ?? conversation.conversationId,
    communityId: guildId,
    category: null,
    topic: null,
    permissions: { read: true, send: true, attach: true, react: false },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
  };
  const limit = Math.max(0, numberOr(sectionOf(config, 'context').channelMessages, 50));
  const posted = readMirrors(store, (db) => diaryMessages(db as Db, place?.placeId ?? null, limit), []);
  const history = posted.map(({ message, addressing }) => {
    const event = {
      conversation: { id: channel.id, name: channel.name, category: channel.category, topic: channel.topic },
      message: {
        editedAt: null,
        replyToId: null,
        replyPingUserId: null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        messageRefs: [],
        ...message,
        author: { id: selfId, name: selfName, self: true, bot: true },
        reactions: [],
      },
      addressing: addressing ?? { mentionedUserIds: [], mentionedUsers: [], mentionedConversationIds: [] },
    } as unknown as MessageEvent; // the fields line-of.js reads of a message event, as the interface fills them
    return lineOf(event);
  });
  return { conversation, channel, history };
}
