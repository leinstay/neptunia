// The selfreflection turn's own steps, beside the turn runner (src/behavior/turn.ts, mode `selfreflection`). A selfreflection turn writes her
// entry and sends nothing: the entry is recorded in memory first (`recordEntry`, the store's selfreflection unit), and the
// selfreflection's mirrors publish it (src/behavior/mirror.ts). Run as the `selfreflection` wake it has no conversation, and
// `wakeInputs` gives it the place her selfreflection is posted to (mirror.ts#selfreflectionPlaces) as its conversation and her selfreflection as
// its history: her entries' posts as memory holds them, message by message, read through the same line builder
// (src/behavior/line-of.ts). `pictureGate` says whether the post may carry a picture, and
// `selfreflectionVoiceTool` keeps her voice message for the entry instead of posting it. Logs: none.

import { entryMedia } from '../memory/db/media-store.ts';
import { PERSONA_ID } from '../memory/db/storage-keys.ts';
import {
  UNRESTRICTED,
  selfreflectionMetadataOf,
  selfreflectionRestricted,
  refusedAudience,
} from '../tools/publication.ts';
import type { AudienceChoice, PublicationBoundary } from '../tools/publication.ts';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_GIST_CHARS,
  DEFAULT_HISTORY_POSTS,
  DEFAULT_PICTURE_KINDS,
  gistOf,
  isPictureKind,
  setSettings,
} from './selfreflection.ts';
import { lineOf } from './line-of.ts';
import { selfreflectionPlaces, readMirrors } from './mirror.ts';
import type { SelfreflectionEntry, SelfreflectionPlace, EntryPicture, EntryVoice } from './mirror.ts';
import { CODE } from '../tools/codes.ts';
import type { ConversationInfo, ConversationRef, MessageEvent } from '../protocol/adapter.ts';

type Config = Record<string, unknown>;
type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...params: Array<unknown>): Array<Row> } };

const sectionOf = (config: Config, name: string): Config => {
  const found = config[name];
  return typeof found === 'object' && found !== null ? (found as Config) : {};
};
const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Whether a selfreflection post may carry a picture now, and the cap that closed when not (`limit: null` for the switches). */
export type PictureGate = { allowed: boolean; limit: { key: string; used: number; cap: number } | null };

/**
 * Whether a selfreflection post may carry a picture: an image client (`drawing`) and Attach Files in the conversation
 * (`attach`). Pure.
 */
export function pictureGate({
  attach,
  drawing,
}: {
  config?: Config;
  attach: boolean;
  drawing: boolean;
  data?: Record<string, unknown>;
  now?: number;
}): PictureGate {
  return drawing && attach ? { allowed: true, limit: null } : { allowed: false, limit: null };
}

/**
 * The refusal of a forced picture kind (`/nep selfreflection post <kind>`) while the post may carry no picture, naming the
 * gate that closed, or null. Asked before any request.
 */
export function forcedPictureRefusal({
  kind,
  gate,
}: {
  config?: Config;
  kind: unknown;
  gate: () => PictureGate;
}): { outcome: 'refused'; reason: 'pictures'; limit: PictureGate['limit'] } | null {
  if (typeof kind !== 'string' || !isPictureKind(kind, DEFAULT_PICTURE_KINDS)) return null;
  const closed = gate();
  return closed.allowed ? null : { outcome: 'refused', reason: 'pictures', limit: closed.limit };
}

/**
 * The voice message of a selfreflection post: what was voiced and its length, and the file when the turn made it (a voice
 * posted through her operation instead leaves only the text and the length).
 */
export type HeldVoice = Partial<EntryVoice> & { text: string; durationSecs: number };

/** What a selfreflection turn holds instead of sending: her messages as written and as they would be sent. */
export type HeldSpeech = { texts: Array<string>; rendered: Array<{ text: string; accountIds: Array<string> }> };

/**
 * `voice.say` as a selfreflection turn runs it (in the turn, src/tools/executors.ts#executeCall's `inTurn`): the voice file is
 * made through `speech.say` and kept in `held.selfreflectionVoice` for the entry; nothing is posted. Without a speech client that
 * can say, there is no such tool and the call takes its usual way.
 */
export function selfreflectionVoiceTool({
  speech,
  held,
}: {
  speech: unknown;
  held: { selfreflectionVoice?: HeldVoice | null };
}): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const say = (speech as { say?: unknown } | null)?.say;
  if (typeof say !== 'function') return {};
  return {
    'voice.say': async (args) => {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return { status: 'invalid', code: CODE.INVALID_ARGS, data: { text: '' } };
      // src/speech/index.ts#createSpeech answers the file and what was voiced.
      const made = (await (say as (input: { text: string }) => Promise<unknown>)({ text })) as {
        ogg: Uint8Array;
        durationSecs: number;
        waveform: string;
        voiced: string;
      };
      held.selfreflectionVoice = {
        ogg: made.ogg,
        durationSecs: made.durationSecs,
        waveform: made.waveform,
        text: made.voiced,
      };
      return { status: 'ok', code: CODE.STAGED, data: { text: '' } };
    },
  };
}

/** A staged picture of the post: the generated picture and its scene. */
export type StagedPicture = EntryPicture & { text: string };

/** The part of the store `recordEntry` uses. */
export type SelfreflectionStore = {
  appendSelfreflectionPost?: (post: Record<string, unknown>, opts: { max: number }) => unknown;
  getSelfreflection?: () => { posts: Array<Record<string, unknown>> };
  setSelfreflectionPosts?: (posts: Array<Record<string, unknown>>, opts: { max: number }) => unknown;
  state: { data: Record<string, unknown>; markDirty(): void };
};

/**
 * The post of the place's selfreflection an entry is (recordEntry): its gist and its first picture's scene cut to
 * `selfreflection.gistChars` (200), her full text, the entry's id as its `itemId`, its search query, how it is sent (`send`) and,
 * with a voice message, the text as voiced and its length.
 */
function selfreflectionPostOf({
  config,
  at,
  plan,
  held,
  staged,
  set,
  voice,
  id,
}: {
  config: Config;
  at: number;
  plan: { kind: string | null; search?: string | null };
  held: HeldSpeech;
  staged: ReadonlyArray<StagedPicture>;
  set: boolean;
  voice: HeldVoice | null;
  id: string;
}): {
  post: Record<string, unknown>;
  rendered: { messages: Array<string>; mentions: Array<Array<string>> };
  maxMessageBytes: number;
} {
  const selfreflectionCfg = sectionOf(config, 'selfreflection');
  const gistChars = DEFAULT_GIST_CHARS;
  const first = staged[0];
  const maxMessageBytes = setSettings(selfreflectionCfg).maxMessageBytes;
  const rendered = {
    messages: held.rendered.map((part) => part.text),
    mentions: held.rendered.map((part) => part.accountIds),
  };
  const post = {
    at,
    kind: plan.kind,
    gist: gistOf(held.texts.join(' '), gistChars),
    picture: first ? gistOf(first.text, gistChars) : null,
    ...(set ? { pictures: staged.length } : {}),
    search: plan.search || null,
    text: held.texts.join('\n'),
    itemId: id,
    ...(voice ? { voice: { text: voice.text, durationSec: voice.durationSecs } } : {}),
    // How the entry goes out, kept so a publication sent after a restart sends it whole (src/behavior/mirror.ts).
    send: { ...rendered, maxMessageBytes },
  };
  return { post, rendered, maxMessageBytes };
}

/** What a post keeps of her audience choice: the audience, or for a failed choice a value that publishes nowhere. */
const publicationAudienceOf = (choice: AudienceChoice) =>
  choice.ok ? choice.audience : { kind: 'invalid' as const, code: choice.code };

/**
 * A selfreflection post recorded before anything is sent: one post in the place's selfreflection (`store.appendSelfreflectionPost`, the newest
 * `selfreflection.historyPosts` (150) kept) with its gist and its first picture's scene cut to `selfreflection.gistChars` (200), her
 * full text, the entry's id as its `itemId`, its search query, how it is sent (`send`: her messages as sent, their
 * mentions, the set's byte limit) and, with a voice message, the text as voiced and its length; the day's selfreflection post
 * counted. Every picture was counted when it was generated. `audience` is what her `<audience>` tags came to: the post
 * keeps it as `publicationAudience`, and a failed choice is kept as a value that publishes nowhere
 * (src/memory/db/selfreflection-audience.ts). Returns the outcome's `selfreflection` field: the counts, the audience and the entry the
 * mirrors publish.
 */
export function recordEntry({
  store,
  config,
  now,
  plan,
  held,
  staged,
  set,
  voice,
  publicationBoundary,
  audience = { ok: true, audience: UNRESTRICTED },
  newId = () => `selfreflection:${randomUUID()}`,
}: {
  store: SelfreflectionStore;
  config: Config;

  now: number;
  plan: { kind: string | null; search?: string | null };
  held: HeldSpeech;
  staged: ReadonlyArray<StagedPicture>;
  set: boolean;
  voice: HeldVoice | null;
  publicationBoundary?: PublicationBoundary;
  audience?: AudienceChoice;
  newId?: () => string;
}): {
  kind: string | null;
  picture: boolean;
  search: boolean;
  messages: number;
  pictures: number;
  audience: AudienceChoice;
  entry: SelfreflectionEntry;
} {
  const id = newId();
  const { post, rendered, maxMessageBytes } = selfreflectionPostOf({
    config,
    at: now,
    plan,
    held,
    staged,
    set,
    voice,
    id,
  });
  if (publicationBoundary !== undefined) post.publicationBoundary = publicationBoundary;
  post.publicationAudience = publicationAudienceOf(audience);
  if (typeof store.appendSelfreflectionPost === 'function')
    store.appendSelfreflectionPost(post, { max: DEFAULT_HISTORY_POSTS });
  const entry: SelfreflectionEntry = {
    id,
    ...(publicationBoundary !== undefined ? { publicationBoundary } : {}),
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
    audience,
    entry,
  };
}

/**
 * The refusals `posts` showed in a selfreflection request (`<audience_refused>`), marked on their posts once she answered it, so
 * she hears of each one once. A request that never got an answer marks nothing.
 */
export function markRefusalsTold(store: SelfreflectionStore, posts: ReadonlyArray<object>): void {
  const shown = new Set(
    posts.flatMap((post) => {
      const { itemId, publicationAudience } = post as { itemId?: unknown; publicationAudience?: unknown };
      return refusedAudience(publicationAudience)?.told === false ? [itemId] : [];
    })
  );
  if (shown.size === 0 || !store.getSelfreflection || !store.setSelfreflectionPosts) return;
  const marked = store
    .getSelfreflection()
    .posts.map((post) =>
      shown.has(post.itemId)
        ? { ...post, publicationAudience: { ...(post.publicationAudience as object), told: true } }
        : post
    );
  store.setSelfreflectionPosts(marked, { max: DEFAULT_HISTORY_POSTS });
}

/** One message of her selfreflection as memory holds it: a message of the platform's shape, and its addressing. */
type SelfreflectionMessage = { message: Row; addressing: Row | null };

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
    .prepare(
      'SELECT native_ids FROM selfreflection_mirrors WHERE selfreflection_id = ? AND retired_at IS NULL ORDER BY rowid'
    )
    .all(entryId)) {
    const parsed = jsonOf(row.native_ids);
    if (Array.isArray(parsed))
      for (const id of parsed as Array<unknown>) if (typeof id === 'string' && id) ids.push(id);
  }
  // Its sent publication's receipts too: a message the v15 step joined to it is named there only.
  for (const row of db
    .prepare(
      "SELECT receipts FROM publications WHERE row_kind = 'selfreflection' AND row_id = ? AND status = 'sent' AND retired_at IS NULL ORDER BY created_at, id LIMIT 1"
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
  // This module's `Db` names the part of a connection it calls; every caller hands a whole one.
  for (const row of entryMedia(db as unknown as Parameters<typeof entryMedia>[0], entryId)) {
    const held = (jsonOf(row.extra) ?? {}) as Row;
    const messageId = textOf(held.messageId);
    if (!messageId) continue;
    const mime = textOf(row.mime);
    const voice = mime.startsWith('audio/') && (jsonOf(row.extra) as Row | null)?.voice === true;
    const extra = (jsonOf(row.extra) ?? {}) as Row;
    const file: Row = {
      id: textOf(row.native_ref) || String(row.id),
      kind: voice ? 'voice' : mime.startsWith('image/') ? 'image' : 'file',
      url: textOf(held.url) || null,
      contentType: mime || null,
      size: numberOr(row.bytes, 0),
      ...(voice && typeof extra.durationSec === 'number' ? { durationSec: extra.durationSec } : {}),
    };
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), file]);
  }
  return byMessage;
}

/**
 * Her selfreflection as memory holds it, the newest `limit` messages, oldest first: each entry's post message by message, each
 * message's text, time and what it answers from the newest revision of her line in the record of `placeId` (`said`
 * or `seen`, `editedAt` set from the second revision on), its files from the entry's media
 * rows; an entry with no such line is its text as one message under its first message id (or its own id), at the
 * entry's time. Nothing of anyone else: the mirror place's other lines are no part of her selfreflection.
 */
/** What a stored line of a message holds as its native id: the protocol id, or the key of the message's family once it has one. */
const FAMILY_OF_MESSAGE = '?, (SELECT native_key FROM message_families WHERE message_id = ? AND generation = 1)';

function selfreflectionMessages(db: Db, placeId: string | null, limit: number): Array<SelfreflectionMessage> {
  const out: Array<SelfreflectionMessage> = [];
  const said = db.prepare(
    `SELECT native_id, revision, occurred_at, recorded_at, text, reply_to FROM sources
      WHERE place_id = ? AND native_id IN (${FAMILY_OF_MESSAGE}) AND kind IN ('said', 'seen') AND retired_at IS NULL
      ORDER BY revision DESC, kind = 'said' DESC LIMIT 1`
  );
  const deleted = db.prepare(
    `SELECT 1 AS gone FROM sources WHERE place_id = ? AND native_id IN (${FAMILY_OF_MESSAGE}) AND kind = 'deleted' AND retired_at IS NULL LIMIT 1`
  );
  const entries = db
    .prepare(
      'SELECT id, at_ms, text, extra FROM selfreflection WHERE retired_at IS NULL ORDER BY at_ms DESC, position DESC'
    )
    .all();
  for (const entry of entries) {
    if (selfreflectionRestricted(selfreflectionMetadataOf(entry.extra))) continue;
    if (out.length >= limit) break;
    const entryId = String(entry.id);
    const ids = messageIdsOf(db, entryId);
    const files = filesOf(db, entryId);
    const lines = placeId ? ids.map((id) => ({ id, line: said.all(placeId, id, id)[0] })) : [];
    const posted: Array<SelfreflectionMessage> = [];
    for (const { id, line } of lines) {
      // A message she deleted, or one with neither text nor a file, is no line of her selfreflection.
      if ((!textOf(line?.text) && !files.has(id)) || deleted.all(placeId, id, id).length > 0) continue;
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

/** What the selfreflection wake turns in place of the selfreflection channel: its conversation, the channel and its history. */
export type WakeInputs = {
  conversation: ConversationRef;
  channel: ConversationInfo;
  history: Array<Record<string, unknown>>;
};

/**
 * The inputs of a selfreflection turn run as the `selfreflection` wake, which has no conversation: the place her selfreflection is
 * posted to (mirror.ts#selfreflectionPlaces: the first enabled mirror, else the place the last entry was published to), that
 * place as the interface describes it (`conversationInfo`), else as memory names it, and her selfreflection as its history: the
 * newest `context.channelMessages` messages of her entries (selfreflectionMessages), each through the line builder with her as
 * the author. With no place at all the conversation is her selfreflection itself (`selfreflection`), with every permission.
 */
/** The native id of the server a place sits under, for a turn whose interface says nothing now; else null. */
function communityOfPlace(store: unknown, placeId: string): string | null {
  const known = store as { rootPlaceOf?(id: string): string | null; nativeCommunityOf?(id: string): string | null };
  const top = known.rootPlaceOf?.(placeId) ?? null;
  return top === null ? null : (known.nativeCommunityOf?.(top) ?? null);
}

export async function wakeInputs({
  store,
  conversationInfo,
  iface,
  selfId,
  selfName,
  config,
}: {
  store: unknown;
  conversationInfo: (ref: ConversationRef) => Promise<{ conversation: ConversationInfo } | null>;
  iface: string;

  selfId: string;
  selfName: string;
  config: Config;
}): Promise<WakeInputs> {
  const place: SelfreflectionPlace | null = readMirrors(store, selfreflectionPlaces, [])[0] ?? null;
  const conversation = place
    ? { iface: place.iface, conversationId: place.conversationId }
    : { iface, conversationId: 'selfreflection' };
  const known = place ? ((await conversationInfo(conversation))?.conversation ?? null) : null;
  const channel: ConversationInfo = known ?? {
    iface: conversation.iface,
    id: conversation.conversationId,
    kind: 'channel',
    name: place?.name ?? conversation.conversationId,
    rootId: place ? (communityOfPlace(store, place.placeId) ?? PERSONA_ID) : PERSONA_ID,
    category: null,
    topic: null,
    permissions: { read: true, send: true, attach: true, react: false },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
  };
  const limit = Math.max(0, numberOr(sectionOf(config, 'context').channelMessages, 50));
  const posted = readMirrors(store, (db) => selfreflectionMessages(db as Db, place?.placeId ?? null, limit), []);
  const history = posted.map(({ message, addressing }) => {
    const event = {
      conversation: { id: channel.id, name: channel.name, category: channel.category, topic: channel.topic },
      message: {
        editedAt: null,
        replyToId: null,
        replyPingAccountId: null,
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
      addressing: addressing ?? { mentionedAccountIds: [], mentionedUsers: [], mentionedConversationIds: [] },
    } as unknown as MessageEvent; // the fields line-of.js reads of a message event, as the interface fills them
    return lineOf(event);
  });
  return { conversation, channel, history };
}
