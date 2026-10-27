// The diary turn's own steps, beside the turn runner (src/behavior/turn.js, mode `diary`). A diary turn writes her
// entry and sends nothing: the entry is recorded in memory first (`recordEntry`, the store's diary unit), and the
// diary's mirrors publish it (src/behavior/mirror.ts). Run as the `selfreflection` wake it has no conversation, and
// `wakeInputs` rebuilds from memory what the diary channel gave: the place her diary is posted to
// (mirror.ts#diaryPlaces), that place as the turn's conversation, and her recent entries as its history, read through
// the same line builder (src/behavior/line-of.js). `pictureGate` says whether the post may carry a picture, and
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

/** One line of her diary as memory holds it: the message id, when and what she wrote. */
type MemoryLine = { id: string; at: number; text: string };

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The native message ids of an entry: its legacy mirror's, then the receipts of its publications to `placeId`. */
function nativeIdsOf(db: Db, entryId: string, placeId: string): Array<string> {
  const ids: Array<string> = [];
  for (const row of db
    .prepare('SELECT native_ids FROM diary_mirrors WHERE diary_id = ? AND retired_at IS NULL ORDER BY rowid')
    .all(entryId)) {
    const parsed: unknown = JSON.parse(textOf(row.native_ids) || '[]');
    if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string' && id) ids.push(id);
  }
  for (const row of db
    .prepare(
      "SELECT receipts FROM publications WHERE row_kind = 'diary' AND row_id = ? AND destination_place_id = ? AND status = 'sent' AND retired_at IS NULL ORDER BY created_at, id"
    )
    .all(entryId, placeId)) {
    const parsed: unknown = JSON.parse(textOf(row.receipts) || '[]');
    if (Array.isArray(parsed))
      for (const receipt of parsed as Array<{ key?: unknown }>)
        if (typeof receipt?.key === 'string' && receipt.key) ids.push(receipt.key);
  }
  return [...new Set(ids)];
}

/**
 * Her diary's lines as memory holds them, oldest first, the newest `limit`: for each live entry, the lines of hers the
 * record of `placeId` keeps for its messages, else its text as one line under its first message id (or its own id).
 * An entry with neither is left out.
 */
function diaryLines(db: Db, placeId: string | null, limit: number): Array<MemoryLine> {
  const lines: Array<MemoryLine> = [];
  const entries = db
    .prepare('SELECT id, at_ms, text FROM diary WHERE retired_at IS NULL ORDER BY at_ms DESC, position DESC LIMIT ?')
    .all(limit)
    .reverse();
  for (const entry of entries) {
    const entryId = String(entry.id);
    const at = numberOr(entry.at_ms, 0);
    const ids = placeId ? nativeIdsOf(db, entryId, placeId) : [];
    const recorded =
      placeId && ids.length > 0
        ? db
            .prepare(
              `SELECT native_id, occurred_at, text FROM sources WHERE kind = 'said' AND place_id = ? AND retired_at IS NULL
                AND native_id IN (${ids.map(() => '?').join(', ')}) ORDER BY occurred_at, position`
            )
            .all(placeId, ...ids)
        : [];
    if (recorded.length > 0) {
      for (const row of recorded)
        lines.push({
          id: textOf(row.native_id),
          at: Date.parse(textOf(row.occurred_at)) || at,
          text: textOf(row.text),
        });
    } else if (textOf(entry.text) !== '') {
      lines.push({ id: ids[0] ?? entryId, at, text: textOf(entry.text) });
    }
  }
  return lines.slice(-limit);
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
 * place as the interface describes it (`conversationInfo`), else as memory names it, and her recent entries there as
 * its history (`context.channelMessages` lines), each a message of hers through the line builder. With no place at all
 * the conversation is her diary itself (`selfreflection`), with nothing to read and every permission.
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
  const lines = readMirrors(store, (db) => diaryLines(db as Db, place?.placeId ?? null, limit), []);
  const history = lines.map((line) => {
    const event = {
      conversation: { id: channel.id, name: channel.name, category: channel.category, topic: channel.topic },
      message: {
        id: line.id,
        author: { id: selfId, name: selfName, self: true, bot: true },
        content: line.text,
        at: line.at,
        editedAt: null,
        replyToId: null,
        replyPingUserId: null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions: [],
        messageRefs: [],
      },
      addressing: { mentionedUserIds: [], mentionedUsers: [], mentionedConversationIds: [] },
    } as unknown as MessageEvent; // the fields line-of.js reads of a message event, as the interface fills them
    return lineOf(event);
  });
  return { conversation, channel, history };
}
