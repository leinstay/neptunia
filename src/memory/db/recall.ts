// Recall over the memory database (spec 2026-10-24-memory-store, section 8): what `memory.search` and the memory
// prefetch use. It reads the `sources` table of the record (every chat line, its
// scope and place) and the `vectors` table, always inside a scope context (src/memory/db/scope.ts): a row the context
// may not open is never searched, never counted and never read into a stretch. The caller's place rule (`allowPlace`)
// is resolved once into a set of places and runs inside every stream's query, before any LIMIT, ranking or fusion.
//
// search(db, { ctx, plan, ... }) takes the plan `memorySearchPlan` builds (`forms`, `who`, `from`, `to`, `placeId`)
// and runs four streams, each a ranked list of messages:
//   words    the plan's forms as stems (the learned stemmer of src/memory/db/stems.ts, the same one that stamped
//            `sources.stems`) through `sources_fts`: a one-word form is a word, a longer form a phrase; bm25;
//   trigram  a form the word stream finds nothing for, as a part of a word (`sources_tri`), for typos and stems the
//            learned endings did not cover;
//   meaning  the stored vectors within the context's scope, a plain scan, cosine on the int8 rows (the question's
//            embedding is the caller's: it is given as `vector`);
//   people   the lines of the members the plan's `who` forms name.
// A fifth stream, `time`, runs only for a caller that passes `sampleTime` (the persona's own search, never the prefetch)
// and only when those four found nothing and the plan names a place or a side of a range: it cuts the span into `limit`
// equal slices and takes the line nearest each slice's middle, so the answer is spread over what she named. An open side
// closes at the first or last line the context may see. Its result says `sampled: true` and its hits `streams: ['time']`;
// `stats` counts the four streams only.
// The streams are fused by reciprocal rank (k 60, src/behavior/recall.js#fuseRanks); every hit keeps the streams that
// found it. A relevance gate drops hits far below the best, the rest is ranked by closeness to the plan's date range
// (its middle; the nearest end of an open range); with no date, by what a hit holds first (terms, phrases) and
// the nearness to now only among equals. Stretches are built around the best hits as recall
// builds them from the record: the reply chain, `recordContext` lines each side, then the chat followed on
// (`followMessages` while no silence longer than `followGapMinutes`), merged where they share a line.
//
// A hit is close when the words, the letters or the people found it, when it holds a term, or when its cosine reaches
// `mediaBar.strongMeaningScore`. A result with hits and none of them close is `far`: its windows hold the three best
// hits alone. `hitLines` asks for the best close hits as single messages (conversation.read's `find`), and a plan's
// `mine` keeps every stream to her own lines.
//
// A group context that has a better match only in a DM it may not open gets `hidden: true` and nothing else about it:
// no text, no count (the owner, 2026-10-20).
//
// A context with `audienceColumn: true` (every context the core issues) is read through `audience_id` (scope.ts#scopeWhere,
// #canRead) instead of the three scope columns; both give the same rows on a database the resolver filled.
//
// window(db, { ctx, anchor, move, messages, minutes }) reads the lines of a place up (earlier) or down (later) from a
// message, in time order, inside the context; the read stops at the first line the context may not open and never
// counts one.
//
// The reader worker (reader-worker.ts) runs `search` off the bot's main thread. The caller's callbacks cannot cross a
// thread, so the three exports at the end of the search section carry them as data: `visiblePlaces` lists the places
// the caller's `allowPlace` judges before the search (`allowedPlaces`), `searchMarked` marks the lines and places whose
// names the caller may give, and `namedResult` fills those names in after the answer. The result equals `search`'s.
//
// Pure of the bot: it works on an opened database (any connection, read-only is enough) and takes everything else
// as arguments. Rows are read here; wording and rendering are the caller's (`quotesOf` turns windows into the
// stretches `recall.run` returns when it renders them with src/behavior/recall.js#renderRecallWindows).

import { lineMedia, mediaHits, mediaMessageParts } from './media-store.ts';
import type { MediaHit, MediaRow } from './media-store.ts';
import { CURRENT_SOURCE } from './source-current.ts';
import { nativeLocatorOf } from './source-locator.ts';
import { channelOfPlace } from './native-rows.ts';
import { locatorText } from './message-locator.ts';
import { MINUTE_MS } from '../../time.ts';
import {
  RECALL_DEFAULTS,
  RRF_K,
  cutStretch,
  followChat,
  fuseRanks,
  mergeWindows,
  recallSettings,
  renderRecallWindows,
} from '../../behavior/recall.ts';
import { log } from '../../log.ts';
import { foldText } from '../recent.ts';
import { indexWords } from '../record-index.ts';
import { namedIface as ifaceOf } from './live-iface.ts';
import { canRead, scopeWhere, whereFor } from './scope.ts';
import { loadStemmer } from './stems.ts';
import { asText, isFiniteNumber, isWholeNumber } from './types.ts';
import type { Config, Db, Row } from './types.ts';
import type { Context } from './scope.ts';

/** How many reply parents a hit's chain follows at most (as the record recall does). */
const REPLY_CHAIN_MAX = 10;
/** The most lines one follow reads from the database before the chat's silence cuts it. */
const FOLLOW_READ_MAX = 100;
/** Hits turned into windows per window kept (as the record recall does). */
const HITS_PER_WINDOW = 4;
/** The weight of the people stream when the plan also has word forms (it only locates the person then). */
const PEOPLE_WEIGHT_WITH_FORMS = 0.5;
/** Fallback of the window length of a window read when neither `messages` nor `minutes` is given: `recall.windowMessages`. */
const WINDOW_FALLBACK = 16;
/** The nearest lines a search carries when nothing it found is close (see `nearOnly`). */
const NEAREST_LINES = 3;

const STREAMS = ['words', 'trigram', 'meaning', 'people', 'time'];

export { CURRENT_SOURCE };

/** A term of the plan as stems: the form, its stem keys, their joined id, the folded form and whether it is a phrase. */
type Term = { form: string; keys: Array<string>; id: string; folded: string; phrase: boolean };
/** The filters every stream shares: the range, the place and the places the caller allows. */
type ScopeArgs = {
  from: number | null;
  to: number | null;
  placeId: string | null;
  places: string | null;
  /** Only her own lines (`kind = 'said'`). */
  mine?: boolean;
};

/** A verified interface route kept separately from a stored source's native observation key. */
export type NativeMessageLocator = Readonly<{
  iface: string;
  chatId: string;
  messageId: string;
}>;

export type ResolvedRecallAnchor =
  Readonly<{ kind: 'source'; sourceId: string }> | Readonly<{ kind: 'native'; locator: NativeMessageLocator }>;

export type StoredSourceRef = Readonly<{
  sourceId: string;
  placeId: string;
  iface: string | null;
  /** The revision of the source row; absent or null when it names none. */
  revision?: number | null;
  native?: NativeMessageLocator;
}>;

/** One source row as a chat message (the shape renderRecallWindows reads). */
export type RecallMessage = {
  id: unknown;
  /** Only in a `searchMarked` answer: the account `nameOf` is asked about. `namedResult` removes it. */
  nameKey?: string;
  stored?: StoredSourceRef;
  placeId: string;
  authorId: string | null;
  authorName: string;
  self: boolean;
  bot: boolean;
  content: string;
  ts: number;
  replyToId: string | null;
  mentionedAccountIds: Array<unknown>;
  mentionedChannelIds: Array<unknown>;
  attachments: Array<Row>;
  links: Array<Row>;
  stickers: Array<unknown>;
  emojis: Array<unknown>;
  forwarded: Array<unknown>;
  reactions: Array<unknown>;
  editedAt: number | null;
};
/** A window of messages around hits, in the shape the recall runner reads. */
type RecallWindow = {
  source: string;
  place: unknown;
  placeId: string | null;
  channelName: string | null;
  messages: Array<RecallMessage>;
  hitIds: Array<unknown>;
  sourceHitIds?: Iterable<unknown>;
  overlapsChat: boolean;
};
/** The place of a `searchMarked` answer by id, with the native id `channelNameOf` is asked about. */
type NameMarks = { places: Record<string, string> };
/** What the streams, the windows and the quotes need to name a message's author and its channel. */
type Reader = {
  selfName: string;
  exclude: Set<unknown>;
  authorOf: (accountId: unknown) => { id: string | null; name: string | null; nameKey: string | null };
  channelNameOf: (placeId: unknown) => string | null;
  /** The interface of a stored place; null for a place no row holds. */
  ifaceOf: (placeId: unknown) => string | null;
  /** The chat a stored place's interface knows it by; null for a place no row holds or whose row names none. */
  chatOf: (placeId: unknown) => string | null;
  /** The interface's own id of a stored channel; null for a place that is no stored channel. */
  channelOfPlace: (placeId: string) => string | null;
  mediaOf: (sourceId: string) => ReadonlyArray<MediaRow>;
};
/** The settings of a db recall: the recall settings with the keys of `recall.db` lifted out. */
type DbKeys = { gateShare: number; candidates: number; minMeaning: number; wordPool?: number };
export type DbSettings = NonNullable<ReturnType<typeof recallSettings>> & DbKeys;
/**
 * What a search is asked for: the forms to find, the members named, the date range and the channel. `placeId` names a
 * chat through `chatNamed`; `place` is a stored place id taken as it is, a DM's included. `mine` keeps to her own lines.
 */
export type RecallPlan = {
  forms?: ReadonlyArray<string>;
  who?: ReadonlyArray<string>;
  from?: number | null;
  to?: number | null;
  placeId?: string;
  place?: string;
  mine?: boolean;
};
/** A hit of a search: where the line is, how it scored and which streams found it. */
export type RecallHit = {
  id: unknown;
  rowid: unknown;
  messageId: unknown;
  placeId: unknown;
  ts: number;
  score: number;
  streams: Array<string>;
  terms: number;
  phrases: number;
  cosine: number | null;
};

const quoteFts = (text: string): string => `"${String(text).replace(/"/g, '""')}"`;
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The settings of a db recall from the live config: the recall settings (windows, follow: src/behavior/recall.js#recallSettings)
 * with `gateShare` (0..1: the share of the best fused score a hit needs), `candidates` (rows per stream) and
 * `minMeaning` (the cosine under which a meaning hit is dropped) lifted out of `recall.db`. Null while recall is off.
 */
export function dbSettings(config: Config): DbSettings | null {
  const base = recallSettings(config);
  return base ? { ...base, ...(base.db as DbKeys) } : null; // `recall.db` holds the keys named in DbKeys
}

// ---------- rows to messages ----------

const parseJson = (text: unknown): unknown => {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

type AccountName = { nativeId: string | null; iface: string; name: string | null };
/** A stored place as a read names it; `chat` is the chat its interface knows it by: its own native id, a DM's partner's. */
type PlaceName = {
  nativeId: string | null;
  chat: string | null;
  isChannel: boolean;
  iface: string;
  name: string | null;
  private: boolean;
  retired: boolean;
};

/** Account names retain their exact identity when native IDs collide across interfaces. */
function accountNames(db: Db): Map<unknown, AccountName> {
  const names = new Map<unknown, AccountName>();
  for (const row of db.prepare('SELECT id, iface, native_id, names, retired_at FROM accounts').all()) {
    const list = parseJson(row.names);
    const first: unknown = Array.isArray(list) ? list.find((name: unknown) => typeof name === 'string' && name) : null;
    names.set(row.id, {
      nativeId: str(row.native_id) || null,
      iface: str(row.iface),
      name: row.retired_at === null ? str(first) || null : null,
    });
  }
  return names;
}

/** Exact place metadata gates private names before consulting an interface's snapshot. */
function placeNames(db: Db): Map<unknown, PlaceName> {
  const names = new Map<unknown, PlaceName>();
  const rows = db
    .prepare(
      `SELECT p.id, p.native_id, p.name, p.iface, p.scope_kind, p.chat, p.kind, p.retired_at, a.native_id AS partner
       FROM places p LEFT JOIN accounts a ON a.id = p.partner_account`
    )
    .all();
  for (const row of rows) {
    names.set(row.id, {
      nativeId: str(row.native_id) || null,
      chat: (row.kind === 'dm' ? str(row.partner) : str(row.native_id)) || null,
      isChannel: row.kind === 'channel',
      iface: str(row.iface),
      name: str(row.name) || null,
      private: row.scope_kind === 'dm' || row.scope_kind === 'internal' || row.chat === 'dm',
      retired: row.retired_at !== null,
    });
  }
  return names;
}

/**
 * The channel id a source row belongs to: the private channel the record line carried, else the chat its place row
 * names, else the place id as stored for a place no row holds.
 */
function channelOf(row: Row, extra: Row, chatOf: Reader['chatOf']): string {
  const dm = typeof extra?.dmChannel === 'string' && extra.dmChannel ? extra.dmChannel : null;
  return dm ?? chatOf(row.place_id) ?? asText(row.place_id ?? '');
}

function storedRefOf(row: Row, extra: Row, channelOfPlace: Reader['channelOfPlace']): StoredSourceRef {
  const native = nativeLocatorOf(row, extra, channelOfPlace);
  return {
    sourceId: str(row.id),
    placeId: str(row.place_id),
    iface: str(row.iface) || null,
    revision: isWholeNumber(row.revision) && row.revision > 0 ? Number(row.revision) : null,
    ...(native ? { native } : {}),
  };
}

/** A name as a line shows it: one line, `-` when nothing is left. */
const shownName = (name: string | null): string => (name ?? '').replace(/\s+/g, ' ').trim() || '-';

/** One source row as a normalized chat message (the shape renderRecallWindows reads). */
function messageOf(
  row: Row,
  {
    authorOf,
    selfName,
    mediaOf,
    chatOf,
    channelOfPlace,
  }: Pick<Reader, 'authorOf' | 'selfName' | 'mediaOf' | 'chatOf' | 'channelOfPlace'>
): RecallMessage {
  const extra = (parseJson(row.extra) ?? {}) as Row;
  const self = row.kind === 'said';
  const author = authorOf(row.author_account);
  const name = self ? selfName : author.name;
  const media = mediaMessageParts(mediaOf(String(row.id)), row.native_id);
  const ts = Date.parse(row.occurred_at as string);
  const recordedAt = Date.parse(row.recorded_at as string);
  const mentions = parseJson(row.mentions);
  return {
    id: row.native_id,
    ...(!self && author.nameKey !== null ? { nameKey: author.nameKey } : {}),
    stored: storedRefOf(row, extra, channelOfPlace),
    placeId: channelOf(row, extra, chatOf),
    authorId: author.id,
    authorName: shownName(name),
    self,
    bot: false,
    content: str(row.text),
    ts,
    replyToId: str(row.reply_to) || null,
    mentionedAccountIds: Array.isArray(mentions) ? (mentions as Array<unknown>) : [],
    mentionedChannelIds: [],
    attachments: media.attachments,
    links: media.links,
    stickers: media.stickers,
    emojis: media.emojis,
    forwarded: [],
    reactions: [],
    editedAt: isWholeNumber(row.revision) && row.revision > 1 ? (Number.isFinite(recordedAt) ? recordedAt : ts) : null,
  };
}

// ---------- the plan ----------

/** The plan's forms as stem sequences; a form with no word in it is dropped. */
function termsOf(stem: (word: string) => string, forms: unknown): Array<Term> {
  const out: Array<Term> = [];
  const seen = new Set<string>();
  for (const form of Array.isArray(forms) ? forms : []) {
    if (typeof form !== 'string') continue;
    const words = indexWords(form);
    const keys = words.map((word) => stem(word));
    const id = keys.join(' ');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ form, keys, id, folded: foldText(form), phrase: keys.length > 1 });
  }
  return out;
}

/**
 * How near a hit's place is to the chat the read is for: its own place, then its own interface (`places.iface` of
 * both), then the rest. It only breaks a tie of relevance, so a stronger hit elsewhere keeps its rank and no hit is
 * left out.
 */
function nearness(placeId: unknown, context: unknown, ifaceOf: Reader['ifaceOf']): number {
  const here = (context as { destination?: unknown } | null)?.destination;
  if (typeof placeId !== 'string' || typeof here !== 'string') return 0;
  if (placeId === here) return 2;
  const iface = ifaceOf(placeId);
  return iface !== null && iface === ifaceOf(here) ? 1 : 0;
}

/**
 * The chat a call names, from `places`: a stored place id of any interface as it is, else the chat the turn's interface
 * names by that native id (a group chat first, then a place of unknown chat), never a DM. The empty id when no row
 * holds one, so a read narrowed to a chat nobody stored finds nothing (no place id is empty). The place only narrows:
 * the context's scope and the caller's allowed places still filter every stream (filters).
 */
function chatNamed(db: Db, iface: string | null, given: string): string {
  const stored = db.prepare(`SELECT id FROM places WHERE id = ? AND chat IS NOT 'dm'`).get(given)?.id;
  if (typeof stored === 'string') return stored;
  const found = db
    .prepare(
      `SELECT id FROM places WHERE iface = ? AND native_id = ? AND chat IS NOT 'dm'
       ORDER BY chat IS 'group' DESC, id LIMIT 1`
    )
    .get(iface, given)?.id;
  return typeof found === 'string' ? found : '';
}

/**
 * The relevance gate: a hit stays when its fused score is at least `gateShare` of the best one, or when it holds as
 * many distinct terms as the best-covering hit (two at least). Without the second rule a line holding every term but
 * found by the words alone falls under a recent line the meaning stream also found (its fused score doubles).
 * `visible` are the fused entries, best first; `termsOf` counts the distinct terms an entry's line holds.
 */
export function passGate<TEntry extends { score: number }>(
  visible: ReadonlyArray<TEntry>,
  termsOf: (entry: TEntry) => number,
  gateShare: number
): Array<TEntry> {
  const best = visible[0]?.score ?? 0;
  const counts = visible.map((entry) => termsOf(entry));
  const most = counts.reduce((max, n) => Math.max(max, n), 0);
  return visible.filter((entry, i) => entry.score >= best * gateShare || (most >= 2 && counts[i] === most));
}

const matchOf = (terms: ReadonlyArray<Term>): string =>
  `{stems} : (${terms.map((term) => quoteFts(term.id)).join(' OR ')})`;

/** How many terms, and how many of them phrases, a row holds (by its stems; by its text for a trigram hit). */
function holds(terms: ReadonlyArray<Term>, row: Row): { terms: number; phrases: number } {
  const tokens = asText(row.stems ?? '')
    .split(' ')
    .filter(Boolean);
  const text = foldText(row.text);
  let count = 0;
  let phrases = 0;
  for (const term of terms) {
    let found = false;
    if (term.keys.length === 1) found = tokens.includes(term.keys[0]);
    else {
      for (let at = 0; !found && at + term.keys.length <= tokens.length; at += 1)
        found = term.keys.every((key, i) => tokens[at + i] === key);
    }
    if (!found && term.folded && text.includes(term.folded)) found = true;
    if (found) {
      count += 1;
      if (term.phrase) phrases += 1;
    }
  }
  return { terms: count, phrases };
}

// ---------- the streams ----------

/**
 * The places the caller allows, resolved once per search: every place holding a row the context may see, kept when
 * `allowPlace` says yes. Null without a caller rule (every place); a JSON list otherwise, handed to the streams as a
 * SQL predicate, so a refused place is out of the queries before any LIMIT, ranking or fusion.
 */
function placesAllowed(
  db: Db,
  ctx: Context,
  allowPlace: unknown,
  allowedPlaces?: ReadonlyArray<string | null>
): string | null {
  if (allowedPlaces) return JSON.stringify(allowedPlaces);
  if (typeof allowPlace !== 'function') return null;
  const scope = scopeWhere(ctx, 's');
  const found = db
    .prepare(`SELECT DISTINCT s.place_id AS place_id FROM sources s WHERE s.place_id IS NOT NULL AND ${scope.sql}`)
    .all(...scope.params);
  return JSON.stringify(found.map((row) => row.place_id).filter((placeId) => allowPlace(placeId)));
}

/** Whether a place's line may show: by the list a reader was given, else by the caller's rule. */
function placeRule(allowPlace: unknown, allowedPlaces?: ReadonlyArray<string | null>): (placeId: unknown) => boolean {
  if (allowedPlaces) {
    const allowed = new Set<unknown>(allowedPlaces);
    return (placeId) => allowed.has(placeId);
  }
  return (placeId) => typeof allowPlace !== 'function' || Boolean(allowPlace(placeId));
}

/** The shared filters of a stream: scope, range, place, the caller's allowed places. Returns { sql, params } (without a leading AND). */
function filters(
  ctx: Context,
  { from, to, placeId, places = null, mine = false }: ScopeArgs,
  alias = 's'
): { sql: string; params: Array<string> } {
  const scope = scopeWhere(ctx, alias);
  const parts = [scope.sql];
  const params = [...scope.params];
  if (mine) parts.push(`${alias}.kind = 'said'`);
  if (isFiniteNumber(from)) {
    parts.push(`${alias}.occurred_at >= ?`);
    params.push(iso(from));
  }
  if (isFiniteNumber(to)) {
    parts.push(`${alias}.occurred_at <= ?`);
    params.push(iso(to));
  }
  if (placeId !== null) {
    parts.push(`${alias}.place_id = ?`);
    params.push(placeId);
  }
  if (places !== null) {
    parts.push(`${alias}.place_id IN (SELECT value FROM json_each(?))`);
    params.push(places);
  }
  return { sql: parts.join(' AND '), params };
}

const WORD_COLUMNS = 's.*, s.rowid AS rowid';

function wordRows(db: Db, ctx: Context, terms: ReadonlyArray<Term>, scopeArgs: ScopeArgs, limit: number): Array<Row> {
  if (terms.length === 0) return [];
  const filter = filters(ctx, scopeArgs);
  return db
    .prepare(
      `SELECT ${WORD_COLUMNS}, bm25(sources_fts, 0.0, 1.0) AS rank FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
    WHERE sources_fts MATCH ? AND ${CURRENT_SOURCE} AND ${filter.sql} ORDER BY rank LIMIT ?`
    )
    .all(matchOf(terms), ...filter.params, limit);
}

/** Whether the word stream finds `term` at all inside the context. */
function wordFinds(db: Db, ctx: Context, term: Term, scopeArgs: ScopeArgs): boolean {
  const filter = filters(ctx, scopeArgs);
  return (
    db
      .prepare(
        `SELECT 1 AS ok FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
    WHERE sources_fts MATCH ? AND ${CURRENT_SOURCE} AND ${filter.sql} LIMIT 1`
      )
      .get(matchOf([term]), ...filter.params) !== undefined
  );
}

function trigramRows(
  db: Db,
  ctx: Context,
  terms: ReadonlyArray<Term>,
  scopeArgs: ScopeArgs,
  limit: number
): Array<Row> {
  const filter = filters(ctx, scopeArgs);
  const rows: Array<Row> = [];
  for (const term of terms) {
    if ([...term.form.trim()].length < 3) continue;
    rows.push(
      ...db
        .prepare(
          `SELECT ${WORD_COLUMNS}, bm25(sources_tri) AS rank FROM sources_tri JOIN sources s ON s.rowid = sources_tri.rowid
      WHERE sources_tri MATCH ? AND ${CURRENT_SOURCE} AND ${filter.sql} ORDER BY rank LIMIT ?`
        )
        .all(quoteFts(term.form.trim()), ...filter.params, limit)
    );
  }
  return rows.sort((a, b) => (a.rank as number) - (b.rank as number));
}

/** The int8 row `bytes` (a Uint8Array from SQLite) as signed bytes. */
const signed = (bytes: Uint8Array): Int8Array => new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

let warnedModel = false;

const evictionColumn = new WeakMap<Db, boolean>();
/** ` AND v.evicted_at IS NULL` on a database with the column (schema v11), '' before it. */
function notEvicted(db: Db): string {
  let has = evictionColumn.get(db);
  if (has === undefined) {
    has = db
      .prepare('PRAGMA table_info(vectors)')
      .all()
      .some((column) => column.name === 'evicted_at');
    evictionColumn.set(db, has);
  }
  return has ? ' AND v.evicted_at IS NULL' : '';
}

/**
 * The best `limit` vector rows by cosine to `vector`: { source_rowid, score }. The vectors are joined to the
 * eligible current sources before the top-K: a row the context may not open, a place the caller refuses, a deleted or
 * superseded message never competes. A vector stored on an older revision counts only while that revision's text is
 * the current text (`source_rowid` then names the current row). `model` is the query's embedding model: a row of
 * another model is skipped; a row with no model is taken by its dims, and says so once in the log. An evicted vector
 * (schema v11, index-policy.ts: no bytes, `evicted_at` set) never competes.
 */
function meaningRows(
  db: Db,
  ctx: Context,
  vector: ArrayLike<number> | null | undefined,
  scopeArgs: ScopeArgs,
  limit: number,
  model: unknown = null
): Array<{ source_rowid: unknown; score: number }> {
  const q = vector instanceof Float32Array ? vector : Float32Array.from(vector ?? []);
  let qq = 0;
  for (let i = 0; i < q.length; i += 1) qq += q[i] * q[i];
  const qNorm = Math.sqrt(qq);
  if (!(qNorm > 0) || limit <= 0) return [];
  const filter = filters(ctx, scopeArgs);
  const modelSql = typeof model === 'string' && model ? ' AND (v.model IS NULL OR v.model = ?)' : '';
  const modelParams = modelSql ? [model] : [];
  const rows = db
    .prepare(
      `SELECT s.rowid AS source_rowid, v.scale AS scale, v.norm AS norm, v.bytes AS bytes, v.model AS model
    FROM vectors v JOIN sources o ON o.rowid = v.source_rowid
    JOIN sources s ON s.native_id = o.native_id AND (s.rowid = o.rowid OR s.text IS o.text)
    WHERE v.retired_at IS NULL AND v.bytes IS NOT NULL${notEvicted(db)} AND v.dims = ?${modelSql} AND ${CURRENT_SOURCE} AND ${filter.sql}`
    )
    .iterate(q.length, ...modelParams, ...filter.params);
  const heap: Array<{ source_rowid: unknown; score: number }> = [];
  let floor = -Infinity;
  for (const row of rows) {
    if (row.model === null && !warnedModel) {
      warnedModel = true;
      log.warn('memory db recall: vectors without a model are matched by dims alone');
    }
    const norm = row.norm as number;
    const scale = row.scale as number;
    if (!(norm > 0) || !(scale > 0)) continue;
    const data = signed(row.bytes as Uint8Array);
    let dot = 0;
    for (let j = 0; j < q.length; j += 1) dot += data[j] * q[j];
    const score = (dot * scale) / (qNorm * norm);
    if (heap.length >= limit && score <= floor) continue;
    heap.push({ source_rowid: row.source_rowid, score });
    if (heap.length > limit * 2) {
      heap.sort((a, b) => b.score - a.score);
      heap.length = limit;
      floor = heap[limit - 1].score;
    }
  }
  return heap.sort((a, b) => b.score - a.score).slice(0, limit * 2);
}

/** The current source rows for `rowids`, in the context and the range, by rowid. */
function currentRows(db: Db, ctx: Context, rowids: ReadonlyArray<unknown>, scopeArgs: ScopeArgs): Map<unknown, Row> {
  const out = new Map<unknown, Row>();
  if (rowids.length === 0) return out;
  const filter = filters(ctx, scopeArgs);
  const select = db.prepare(
    `SELECT ${WORD_COLUMNS} FROM sources s WHERE s.rowid = ? AND ${CURRENT_SOURCE} AND ${filter.sql}`
  );
  for (const rowid of rowids) {
    const row = select.get(rowid, ...filter.params);
    if (row) out.set(rowid, row);
  }
  return out;
}

/**
 * The account ids the plan's `who` forms name: an account whose own name equals a form (folded), or an account of a
 * person an alias claim names. The alias claim must be one the context may see, and a person's other accounts count
 * only while their link is `verified`.
 */
function accountsOf(db: Db, ctx: Context, forms: unknown): { ids: Set<unknown>; unresolved: Array<string> } {
  const wanted = new Map<string, string>(
    (Array.isArray(forms) ? (forms as Array<string>) : [])
      .map((form): [string, string] => [foldText(form), form])
      .filter(([key]) => key)
  );
  const ids = new Set<unknown>();
  const named = new Set<string>();
  if (wanted.size === 0) return { ids, unresolved: [] };
  for (const row of db.prepare('SELECT id, names FROM accounts WHERE retired_at IS NULL').all()) {
    const list = parseJson(row.names);
    for (const name of Array.isArray(list) ? (list as Array<unknown>) : []) {
      const key = foldText(name);
      if (wanted.has(key)) {
        ids.add(row.id);
        named.add(key);
      }
    }
  }
  const scope = scopeWhere(ctx, 'c');
  const aliases = db
    .prepare(
      `SELECT c.text AS text, a.id AS account FROM claims c JOIN accounts a ON a.person_id = c.subject_id
    WHERE c.kind = 'alias' AND c.retired_at IS NULL AND a.retired_at IS NULL AND a.link = 'verified' AND ${scope.sql}`
    )
    .all(...scope.params);
  for (const row of aliases) {
    const key = foldText(row.text);
    if (wanted.has(key)) {
      ids.add(row.account);
      named.add(key);
    }
  }
  return { ids, unresolved: [...wanted].filter(([key]) => !named.has(key)).map(([, form]) => form) };
}

function peopleRows(
  db: Db,
  ctx: Context,
  accounts: ReadonlySet<unknown>,
  scopeArgs: ScopeArgs,
  limit: number
): Array<Row> {
  if (accounts.size === 0) return [];
  const filter = filters(ctx, scopeArgs);
  const marks = [...accounts].map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT ${WORD_COLUMNS} FROM sources s WHERE s.author_account IN (${marks}) AND ${CURRENT_SOURCE} AND ${filter.sql}
    ORDER BY s.occurred_at DESC LIMIT ?`
    )
    .all(...accounts, ...filter.params, limit);
}

/** The places a sample may read, as a stream's `places`: the list a reader was given, or the sample's rule over the caller's. */
function samplingPlaces(
  db: Db,
  ctx: Context,
  {
    samplePlace,
    sampledPlaces,
    placeShown,
    places,
  }: {
    samplePlace: unknown;
    sampledPlaces?: ReadonlyArray<string | null>;
    placeShown: (placeId: unknown) => boolean;
    places: string | null;
  }
): string | null {
  if (sampledPlaces) return JSON.stringify(sampledPlaces);
  if (typeof samplePlace !== 'function') return places;
  const rule = samplePlace as (placeId: unknown) => boolean;
  return placesAllowed(db, ctx, (placeId: unknown) => placeShown(placeId) && rule(placeId));
}

/**
 * The time stream: at most `limit` lines of the scope, spread over its span (see the head of this file). Nothing unless
 * the caller asked for it (`wanted`) and the plan names a place or a side of a range. A scope of no more lines than the
 * limit gives every line; a busier one gives the line nearest the middle of each of `limit` equal slices. Lines the read
 * leaves out (`skip`) are out of the query, so a slice holding only those stays empty.
 */
function timeRows(
  db: Db,
  ctx: Context,
  scopeArgs: ScopeArgs,
  {
    wanted,
    found,
    places,
    skip,
    limit,
  }: { wanted: unknown; found: number; places: () => string | null; skip: ReadonlySet<unknown>; limit: number }
): Array<Row> {
  const { from, to, placeId } = scopeArgs;
  if (wanted !== true || found > 0 || (from === null && to === null && placeId === null)) return [];
  const filter = filters(ctx, { ...scopeArgs, places: places() });
  const left = JSON.stringify([...skip]);
  const rows = (tail: string, ...more: Array<string | number>): Array<Row> =>
    db
      .prepare(
        `SELECT ${WORD_COLUMNS} FROM sources s
         WHERE ${filter.sql} AND s.id NOT IN (SELECT value FROM json_each(?)) AND ${CURRENT_SOURCE} ${tail}`
      )
      .all(...filter.params, left, ...more);
  const few = rows('LIMIT ?', limit + 1);
  if (few.length <= limit) return few;
  const edge = (order: 'ASC' | 'DESC') =>
    Date.parse(rows(`ORDER BY s.occurred_at ${order} LIMIT 1`)[0].occurred_at as string);
  const start = from ?? edge('ASC');
  const span = (to ?? edge('DESC')) - start;
  const at = (share: number) => iso(Math.round(start + span * share));
  const picked: Array<Row> = [];
  for (let slice = 0; slice < limit; slice += 1) {
    const middle = at((slice + 0.5) / limit);
    const end = slice === limit - 1 ? '<=' : '<';
    const near = [
      ...rows(
        `AND s.occurred_at >= ? AND s.occurred_at ${end} ? ORDER BY s.occurred_at ASC, s.rowid ASC LIMIT 1`,
        middle,
        at((slice + 1) / limit)
      ),
      ...rows(
        'AND s.occurred_at >= ? AND s.occurred_at < ? ORDER BY s.occurred_at DESC, s.rowid DESC LIMIT 1',
        at(slice / limit),
        middle
      ),
    ];
    const distance = (row: Row) => Math.abs(Date.parse(row.occurred_at as string) - Date.parse(middle));
    const [nearest] = near.sort((a, b) => distance(a) - distance(b));
    if (nearest) picked.push(nearest);
  }
  return picked;
}

// ---------- windows ----------

/**
 * The lines of a place next to a line, nearest first, never past a line the context may not open: `direction`

 * -1 earlier, +1 later; at most `count` lines and, when given, within `minutes` of the line.
 */
function neighbours(
  db: Db,
  ctx: Context,
  row: Row,
  direction: number,
  { count, minutes = null }: { count: number; minutes?: number | null }
): { rows: Array<Row>; stopped: 'hidden' | 'edge' | null } {
  if (!(count > 0)) return { rows: [], stopped: null };
  const earlier = direction < 0;
  const limitMs = isFiniteNumber(minutes)
    ? Date.parse(row.occurred_at as string) + (earlier ? -1 : 1) * minutes * MINUTE_MS
    : null;
  const bound = limitMs === null ? '' : ` AND s.occurred_at ${earlier ? '>=' : '<='} ?`;
  // The boundary is read as ids and scope columns only; the text is fetched for the lines the context may open.
  const sql = `SELECT s.rowid AS rowid, s.scope_kind AS scope_kind, s.scope_iface AS scope_iface, s.scope_dm AS scope_dm, s.audience_id AS audience_id FROM sources s WHERE s.place_id = ? AND ${CURRENT_SOURCE}
    AND (s.occurred_at, s.rowid) ${earlier ? '<' : '>'} (?, ?)${bound} ORDER BY s.occurred_at ${earlier ? 'DESC' : 'ASC'}, s.rowid ${earlier ? 'DESC' : 'ASC'} LIMIT ?`;
  const found = db
    .prepare(sql)
    .all(row.place_id, row.occurred_at, row.rowid, ...(limitMs === null ? [] : [iso(limitMs)]), count);
  const open: Array<unknown> = [];
  let stopped: 'hidden' | null = null;
  for (const next of found) {
    if (!canRead(next, ctx)) {
      stopped = 'hidden';
      break;
    }
    open.push(next.rowid);
  }
  const rows = rowsByRowid(db, open);
  return { rows, stopped: stopped ?? (rows.length < count ? 'edge' : null) };
}

/** The full source rows of `rowids`, in that order. */
function rowsByRowid(db: Db, rowids: ReadonlyArray<unknown>): Array<Row> {
  if (rowids.length === 0) return [];
  const byId = new Map<unknown, Row>(
    db
      .prepare('SELECT s.*, s.rowid AS rowid FROM sources s WHERE s.rowid IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(rowids))
      .map((row): [unknown, Row] => [row.rowid, row])
  );
  return rowids.map((id) => byId.get(id)).filter((row): row is Row => row !== undefined);
}

/**
 * The current line of a message id, only when the context may open it: the scope columns are read first, the text
 * of a line the context may not open is never loaded.
 */
const SOURCE_METADATA = `s.rowid AS rowid, s.id, s.iface, s.native_id, s.place_id, s.kind,
  s.extra, s.owner_file, s.writer AS storage_kind, s.scope_kind, s.scope_iface, s.scope_dm, s.audience_id`;

function readableSource(db: Db, ctx: Context, candidates: Array<Row>): Row | null {
  const light = candidates.length === 1 ? candidates[0] : null;
  return light && canRead(light, ctx) ? (rowsByRowid(db, [light.rowid])[0] ?? null) : null;
}

function sourceByNative(db: Db, ctx: Context, nativeId: unknown, origin: Row): Row | null {
  const matches = db
    .prepare(
      `SELECT ${SOURCE_METADATA} FROM sources s
    WHERE s.native_id = ? AND s.place_id IS ? AND s.iface IS ? AND ${CURRENT_SOURCE}`
    )
    .all(String(nativeId), origin.place_id, origin.iface);
  return readableSource(db, ctx, matches);
}

function sourceForAnchor(db: Db, ctx: Context, raw: unknown, resolved?: ResolvedRecallAnchor): Row | null {
  if (resolved !== undefined) {
    if (!resolved || typeof resolved !== 'object') return null;
    if (resolved.kind === 'source') {
      if (!locatorText(resolved.sourceId)) return null;
      return readableSource(
        db,
        ctx,
        db
          .prepare(
            `SELECT ${SOURCE_METADATA} FROM sources s
        WHERE s.id = ? AND s.retired_at IS NULL`
          )
          .all(resolved.sourceId)
      );
    }
    if (resolved.kind !== 'native') return null;
    const locator = resolved.locator;
    if (!locator || !locatorText(locator.iface) || !locatorText(locator.chatId) || !locatorText(locator.messageId))
      return null;
    const candidates = db
      .prepare(
        `SELECT ${SOURCE_METADATA} FROM sources s WHERE s.iface = ?
      AND (s.native_id = ? OR CASE WHEN json_valid(s.extra)
        THEN json_extract(s.extra, '$."$messageLocator".messageId') END = ?) AND ${CURRENT_SOURCE}`
      )
      .all(locator.iface, locator.messageId, locator.messageId)
      .filter((row) => {
        const native = nativeLocatorOf(row, (parseJson(row.extra) ?? {}) as Row, (id) => channelOfPlace(db, id));
        return (
          native?.iface === locator.iface && native.chatId === locator.chatId && native.messageId === locator.messageId
        );
      });
    return readableSource(db, ctx, candidates);
  }
  const id = asText(raw ?? '').trim();
  if (!id) return null;
  return readableSource(
    db,
    ctx,
    db
      .prepare(
        `SELECT ${SOURCE_METADATA} FROM sources s
    WHERE (s.id = ? OR s.native_id = ?) AND ${CURRENT_SOURCE}`
      )
      .all(id, id)
  );
}

/** The stretch around a hit: reply chain, `around` lines each side, the followed chat. Rows, oldest first. */
function stretchAround(
  db: Db,
  ctx: Context,
  hit: Row,
  { around, followMessages, followGapMinutes }: { around: number; followMessages: number; followGapMinutes: number }
): Array<Row> {
  const chosen = new Map<unknown, Row>([[hit.rowid, hit]]);
  let parent = hit.reply_to;
  for (let depth = 0; parent && depth < REPLY_CHAIN_MAX; depth += 1) {
    const found = sourceByNative(db, ctx, parent, hit);
    if (!found || found.place_id !== hit.place_id || chosen.has(found.rowid)) break;
    chosen.set(found.rowid, found);
    parent = found.reply_to;
  }
  for (const row of neighbours(db, ctx, hit, -1, { count: around }).rows) chosen.set(row.rowid, row);
  const after = neighbours(db, ctx, hit, 1, { count: around });
  for (const row of after.rows) chosen.set(row.rowid, row);
  // The chat goes on past the last line of the stretch while it does not fall silent.
  const rows = [...chosen.values()].sort((a, b) =>
    (a.occurred_at as string) < (b.occurred_at as string)
      ? -1
      : (a.occurred_at as string) > (b.occurred_at as string)
        ? 1
        : (a.rowid as number) - (b.rowid as number)
  );
  const last = rows[rows.length - 1];
  if (after.stopped !== 'hidden') {
    const ahead = neighbours(db, ctx, last, 1, { count: FOLLOW_READ_MAX }).rows;
    const lastTs = Date.parse(last.occurred_at as string);
    const followed = followChat(
      lastTs,
      ahead.map((row) => ({ ts: Date.parse(row.occurred_at as string), row })),
      { followMessages, followGapMinutes }
    );
    // recall.js types what it follows as bare objects; each entry is the `{ ts, row }` handed in above.
    for (const { row } of followed as Array<{ row: Row }>) chosen.set(row.rowid, row);
  }
  return [...chosen.values()].sort((a, b) =>
    (a.occurred_at as string) < (b.occurred_at as string)
      ? -1
      : (a.occurred_at as string) > (b.occurred_at as string)
        ? 1
        : (a.rowid as number) - (b.rowid as number)
  );
}

/** Render and merge using stored identity while preserving native IDs on public messages. */
function keyedWindow(window: RecallWindow): RecallWindow {
  return {
    ...window,
    hitIds: [...(window.sourceHitIds ?? window.hitIds)],
    messages: window.messages.map((message) => ({ ...message, id: message.stored?.sourceId ?? message.id })),
  };
}

function originalMessage(message: RecallMessage, windows: Array<RecallWindow>): RecallMessage {
  for (const window of windows) {
    const found = window.messages.find((candidate) => candidate.stored?.sourceId === message.id);
    if (found) return found;
  }
  return message;
}

/** Resolve duplicate suppression to exact current source identities once per read. */
function excludedSources(
  db: Db,
  ctx: Context,
  exclusions: ReadonlyArray<ResolvedRecallAnchor> | undefined,
  legacy: unknown
): Set<unknown> {
  const ids = new Set<unknown>();
  if (exclusions !== undefined) {
    if (!Array.isArray(exclusions)) return ids;
    const selections: ReadonlyArray<ResolvedRecallAnchor> = exclusions;
    for (const exclusion of selections) {
      const row = sourceForAnchor(db, ctx, '', exclusion);
      if (row) ids.add(row.id);
    }
    return ids;
  }
  if (!locatorText(ctx.iface)) return ids;
  const values = legacy instanceof Set ? [...legacy] : Array.isArray(legacy) ? legacy : [];
  for (const value of values) {
    if (!locatorText(value)) continue;
    const rows = db
      .prepare(`SELECT s.id FROM sources s WHERE s.iface = ? AND s.native_id = ? AND ${CURRENT_SOURCE}`)
      .all(ctx.iface, value);
    if (rows.length === 1) ids.add(rows[0].id);
  }
  return ids;
}

/** A window (the recall runner's shape) of source rows. */
function windowOf(rows: ReadonlyArray<Row>, hitIds: Iterable<unknown>, read: Reader): RecallWindow {
  const messages = rows.filter((row) => !read.exclude.has(row.id)).map((row) => messageOf(row, read));
  const placeId = messages[0]?.placeId ?? null;
  return {
    source: 'db',
    place: rows[0]?.place_id ?? null,
    placeId,
    channelName: read.channelNameOf(rows[0]?.place_id),
    messages,
    hitIds: [...hitIds].filter((id) => !read.exclude.has(id)),
    overlapsChat: messages.length < rows.length,
  };
}

function readerOf(
  db: Db,
  ctx: Context,
  {
    nameOf = null,
    selfName = '',
    channelNameOf = null,
    exclude = null,
    marks = null,
  }: {
    nameOf?: unknown;
    selfName?: string;
    channelNameOf?: unknown;
    exclude?: unknown;
    marks?: NameMarks | null;
  } = {}
): Reader {
  let names: Map<unknown, AccountName> | null = null;
  let places: Map<unknown, PlaceName> | null = null;
  const placeOf = (placeId: unknown): PlaceName | null => (places ??= placeNames(db)).get(placeId) ?? null;
  return {
    selfName,
    mediaOf: (sourceId) => lineMedia(db, [sourceId], ctx).get(sourceId) ?? [],
    exclude: exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []),
    authorOf: (accountId) => {
      names ??= accountNames(db);
      const account = names.get(accountId);
      if (!account) return { id: null, name: null, nameKey: null };
      const own = account.iface === ctx.iface ? account.nativeId : null;
      const given = own && typeof nameOf === 'function' ? str(nameOf(own)) : '';
      return { id: account.nativeId, name: given || account.name, nameKey: marks ? own : null };
    },
    ifaceOf: (placeId) => placeOf(placeId)?.iface || null,
    chatOf: (placeId) => placeOf(placeId)?.chat ?? null,
    channelOfPlace: (placeId) => {
      const place = placeOf(placeId);
      return place?.isChannel ? place.nativeId : null;
    },
    channelNameOf: (placeId: unknown): string | null => {
      const place = placeOf(placeId);
      if (!place || place.retired || (place.private && ctx.internal !== true)) return null;
      const own = place.iface === ctx.iface ? place.nativeId : null;
      if (own && marks) marks.places[placeId as string] = own;
      const given = own && typeof channelNameOf === 'function' ? str(channelNameOf(own)) : '';
      return given || place.name;
    },
  };
}

// ---------- search ----------

/** The point in time a result is ranked toward: the middle of a closed range, the nearest end of an open one, else now. */
function targetOf({ from, to }: Pick<ScopeArgs, 'from' | 'to'>, now: number): number {
  if (from !== null && to !== null && Number.isFinite(from) && Number.isFinite(to)) return (from + to) / 2;
  if (from !== null && Number.isFinite(from)) return from;
  if (to !== null && Number.isFinite(to)) return to;
  return now;
}

/** What a search is given. `allowedPlaces` (a list a reader was given) stands in for `allowPlace`. */
export type SearchInput = {
  ctx?: unknown;
  plan?: RecallPlan;
  limit?: number;
  now?: number;
  vector?: ArrayLike<number> | null;
  settings?: DbSettings | null;
  exclude?: unknown;
  exclusions?: ReadonlyArray<ResolvedRecallAnchor>;
  nameOf?: unknown;
  selfName?: string;
  channelNameOf?: unknown;
  allowPlace?: unknown;
  allowedPlaces?: ReadonlyArray<string | null>;
  model?: unknown;
  /** Whether a plan the four streams found nothing for is answered by the time stream. */
  sampleTime?: boolean;
  /** Which places a sample may read, on top of `allowPlace`. `sampledPlaces` (a list a reader was given) stands in for it. */
  samplePlace?: unknown;
  sampledPlaces?: ReadonlyArray<string | null>;
  /**
   * The bar an item found by meaning alone must clear to stay, as the prefetch keeps one (prefetch.ts#itemLines): a
   * cosine of at least `minMeaningScore`, and of at least `strongMeaningScore` when the item holds none of the words.
   * Without it every item at or over `minMeaning` stays.
   */
  mediaBar?: { minMeaningScore: number; strongMeaningScore: number } | null;
  /** How many of the best close hits come back as `lines`, one message each (conversation.read's `find`). */
  hitLines?: number;
};

/** What a search answers: the windows, the hits, whether a DM holds better, whether it is a sample, the counts per stream. */
export type SearchResult = {
  windows: Array<RecallWindow>;
  hits: Array<RecallHit>;
  /** The media items found: one hit per item, each with its visible uses. */
  mediaHits: Array<MediaHit>;
  hidden: boolean;
  sampled: boolean;
  /** Whether nothing found is close (see `nearOnly`): the windows then hold the nearest lines alone. */
  far: boolean;
  /** The best close hits as messages, best first, as many as `hitLines` asks. */
  lines: Array<RecallMessage>;
  stats: Record<string, number>;
};

/** A search in the reader: the callbacks stayed behind, the names to fill in are marked (see the head of this file). */
export function searchMarked(dbGiven: unknown, input: SearchInput): SearchResult & NameMarks {
  const marks: NameMarks = { places: {} };
  return { ...search(dbGiven, input, marks), places: marks.places };
}

/** Every place holding a row the context may see, a row without a place as null: what `allowPlace` judges. */
export function visiblePlaces(dbGiven: unknown, ctx: unknown): Array<string | null> {
  const db = dbGiven as Db;
  whereFor(ctx);
  const scope = scopeWhere(ctx, 's');
  return db
    .prepare(`SELECT DISTINCT s.place_id AS place_id FROM sources s WHERE ${scope.sql}`)
    .all(...scope.params)
    .map((row) => row.place_id as string | null);
}

/** What the caller's name callback says about `key`, '' without a callback. */
function askedName(callback: unknown, key: string): string {
  // `SearchInput` types the callbacks `unknown`, as `search` reads them; a function of an id is their one use.
  return typeof callback === 'function' ? str((callback as (id: string) => unknown)(key)) : '';
}

/** A `searchMarked` answer with the caller's names in it, as `search` with those callbacks answers. */
export function namedResult(
  marked: SearchResult & NameMarks,
  { nameOf = null, channelNameOf = null }: { nameOf?: unknown; channelNameOf?: unknown }
): SearchResult {
  const { places, ...result } = marked;
  const windows = result.windows.map((one) => {
    const key = typeof one.place === 'string' ? places[one.place] : undefined;
    const given = key ? askedName(channelNameOf, key) : '';
    return { ...one, channelName: given || one.channelName, messages: one.messages.map(named) };
  });
  return { ...result, windows, lines: result.lines.map(named) };
  function named({ nameKey, ...message }: RecallMessage): RecallMessage {
    const name = nameKey ? askedName(nameOf, nameKey) : '';
    return name ? { ...message, authorName: shownName(name) } : message;
  }
}

/**
 * Searches the record in a scope context. `marks` is for `searchMarked` alone.
 */
// health: allow complexity until 2027-04-01 -- the streams of a search, fused in one place
export function search(
  dbGiven: unknown,
  {
    ctx,
    plan,
    limit = RECALL_DEFAULTS.maxClusters,
    now = Date.now(),
    vector = null,
    settings = null,
    exclude = null,
    exclusions,
    nameOf = null,
    selfName = '',
    channelNameOf = null,
    allowPlace = null,
    allowedPlaces,
    model = null,
    sampleTime,
    samplePlace,
    sampledPlaces,
    mediaBar = null,
    hitLines = 0,
  }: SearchInput = {},
  marks: NameMarks | null = null
): SearchResult {
  const db = dbGiven as Db;
  whereFor(ctx); // a read without a valid context throws
  const context = ctx as Context;
  const opts = (settings ?? dbSettings({})) as DbSettings;
  const { gateShare, candidates, minMeaning } = opts;
  const pool = Math.max(candidates, isWholeNumber(opts.wordPool) ? opts.wordPool : candidates);
  const { stem } = loadStemmer(db);
  // The caller's place rule runs inside every stream's query (see placesAllowed).
  const scopeArgs = scopeOfPlan(db, context, plan, placesAllowed(db, context, allowPlace, allowedPlaces));
  const placeShown = placeRule(allowPlace, allowedPlaces);
  const people = accountsOf(db, context, plan?.who);
  const terms = termsOf(stem, [...(plan?.forms ?? []), ...people.unresolved]);
  const stats = { words: 0, trigram: 0, meaning: 0, people: 0 };
  const rowsOf = new Map<unknown, Row>();
  const remember = (row: Row): void => {
    if (!rowsOf.has(row.rowid)) rowsOf.set(row.rowid, row);
  };

  // A wider pool is ranked by what a row holds (distinct terms, phrases, then bm25); the best `candidates` go on.
  const covered = (rows: ReadonlyArray<Row>): Array<Row> =>
    rows
      .map((row, at) => ({ row, at, held: holds(terms, row) }))
      .sort((a, b) => b.held.terms - a.held.terms || b.held.phrases - a.held.phrases || a.at - b.at)
      .slice(0, candidates)
      .map((entry) => entry.row);
  const words = covered(wordRows(db, context, terms, scopeArgs, pool));
  words.forEach(remember);
  stats.words = words.length;
  const missed = terms.filter((term) => !wordFinds(db, context, term, scopeArgs));
  const trigram = covered(trigramRows(db, context, missed, scopeArgs, pool)).filter(
    (row) => !words.some((w) => w.rowid === row.rowid)
  );
  trigram.forEach(remember);
  stats.trigram = trigram.length;

  let meaning: Array<Row> = [];
  const cosine = new Map<unknown, number>();
  if (vector && vector.length > 0) {
    const scored = meaningRows(db, context, vector, scopeArgs, candidates, model);
    const live = currentRows(
      db,
      context,
      scored.map((row) => row.source_rowid),
      scopeArgs
    );
    for (const row of scored) {
      if (row.score < minMeaning) continue;
      const source = live.get(row.source_rowid);
      if (!source) continue;
      if (!cosine.has(source.rowid)) {
        cosine.set(source.rowid, row.score);
        meaning.push(source);
      }
    }
    meaning = meaning.slice(0, candidates);
    meaning.forEach(remember);
    stats.meaning = meaning.length;
  }

  const talk = peopleRows(db, context, people.ids, scopeArgs, candidates);
  talk.forEach(remember);
  stats.people = talk.length;

  // A text form is searched on its own row; its item answers only through a message this reader may see (M.19, M.20).
  const mediaFound = mediaHits(db, {
    match: terms.length > 0 ? matchOf(terms) : null,
    fragments: (held) => terms.map((term) => term.form.trim()).filter((form) => [...form].length >= 3 && !held(form)),
    wordOf: (row) => holds(terms, { stems: row.stems, text: row.description }).terms,
    vector,
    model,
    minMeaning,
    filter: filters(context, scopeArgs),
    limit: candidates,
  }).filter((hit) => clearsBar(hit, mediaBar));

  const skip = excludedSources(db, context, exclusions, exclude);
  const keep = Math.max(1, Number.isInteger(limit) ? limit : RECALL_DEFAULTS.maxClusters);
  const timed = timeRows(db, context, scopeArgs, {
    wanted: sampleTime,
    found: rowsOf.size + mediaFound.length,
    places: () => samplingPlaces(db, context, { samplePlace, sampledPlaces, placeShown, places: scopeArgs.places }),
    skip,
    limit: keep,
  });
  timed.forEach(remember);
  const sampled = timed.length > 0;
  const lists = [words, trigram, meaning, talk, timed].map((list) => list.map((row) => row.rowid));
  const weights = [1, 1, 1, terms.length > 0 ? PEOPLE_WEIGHT_WITH_FORMS : 1, 1];
  const shown = (row: Row): boolean => !skip.has(row.id);
  const visible = fuseRanks(lists, { k: RRF_K, weights }).filter((entry) => shown(rowsOf.get(entry.id) as Row));
  const read = readerOf(db, context, { nameOf, selfName, channelNameOf, exclude: skip, marks });
  const target = targetOf(scopeArgs, now);
  const dated = scopeArgs.from !== null || scopeArgs.to !== null;
  // No hit of the time stream is weaker than another: a share of 0 keeps every one.
  const hits = passGate(visible, (entry) => holds(terms, rowsOf.get(entry.id) as Row).terms, gateShare * +!sampled)
    .map((entry): RecallHit => {
      const row = rowsOf.get(entry.id) as Row;
      const held = holds(terms, row);
      return {
        id: row.id,
        rowid: row.rowid,
        messageId: row.native_id,
        placeId: row.place_id,
        ts: Date.parse(row.occurred_at as string),
        score: entry.score,
        streams: STREAMS.filter((_, i) => entry.ranks[i] !== null),
        terms: held.terms,
        phrases: held.phrases,
        cosine: cosine.get(row.rowid) ?? null,
      };
    })
    .sort(
      dated
        ? // A named date: nearness to it first. Else relevance first (coverage), the date only breaks a tie of coverage.
          (a, b) => Math.abs(a.ts - target) - Math.abs(b.ts - target) || b.score - a.score
        : (a, b) =>
            b.terms - a.terms ||
            b.phrases - a.phrases ||
            nearness(b.placeId, context, read.ifaceOf) - nearness(a.placeId, context, read.ifaceOf) ||
            Math.abs(a.ts - target) - Math.abs(b.ts - target) ||
            b.score - a.score
    );

  const byScore = [...hits].sort((a, b) => b.score - a.score);
  const far = nearOnly(hits, { bar: mediaBar, sampled, media: mediaFound.length });
  const chosen = new Set(hits.slice(0, keep * HITS_PER_WINDOW).map((hit) => hit.rowid));
  for (const hit of byScore.slice(0, keep)) chosen.add(hit.rowid);
  const hitIds = new Set(hits.map((hit) => hit.id));
  // Nothing close: the nearest lines alone, no stretch around them. With `mine`, a stretch keeps to her own lines.
  const built = (far ? byScore.slice(0, NEAREST_LINES) : hits.filter((hit) => chosen.has(hit.rowid))).map((hit) => {
    const row = rowsOf.get(hit.rowid) as Row;
    const rows = far
      ? [row]
      : stretchAround(db, context, row, {
          around: opts.recordContext,
          followMessages: opts.followMessages,
          followGapMinutes: opts.followGapMinutes,
        }).filter((one) => scopeArgs.mine !== true || one.kind === 'said');
    return windowOf(rows, new Set(rows.map((one) => one.id).filter((id) => hitIds.has(id))), read);
  });
  // An item found shows at its latest visible use, without counting among the message hits.
  const mediaLines = mediaFound.slice(0, keep).flatMap((hit, at) => {
    if (skip.has(hit.latest.sourceId)) return [];
    const row = db.prepare('SELECT s.*, s.rowid AS rowid FROM sources s WHERE s.id = ?').get(hit.latest.sourceId);
    if (!row) return [];
    const rows = stretchAround(db, context, row, {
      around: opts.recordContext,
      followMessages: opts.followMessages,
      followGapMinutes: opts.followGapMinutes,
    });
    built.push(windowOf(rows, new Set<unknown>([hit.latest.sourceId]), read));
    return [{ id: hit.latest.sourceId, at }];
  });
  // A window's place is its best hit's place.
  // Its place is the better of two ranks: in the ranked hits (coverage) and by the fused score (where the meaning
  // stream lifts a line the words miss), so neither kind of match crowds the other out of the windows kept.
  const byRank = new Map(hits.map((hit, i): [unknown, number] => [hit.id, i]));
  const byFused = new Map(byScore.map((hit, i): [unknown, number] => [hit.id, i]));
  const order = new Map<unknown, number>([
    ...mediaLines.map(({ id, at }): [unknown, number] => [id, at]),
    ...hits.map((hit): [unknown, number] => [
      hit.id,
      Math.min(byRank.get(hit.id) as number, byFused.get(hit.id) as number),
    ]),
  ]);
  // recall.js declares the windows with a string channel id and string hit ids; these carry a null channel when a
  // window has no message and ids of any kind, so the call goes through its own parameter type.
  const merged = (
    mergeWindows(
      built.map(keyedWindow) as unknown as Parameters<typeof mergeWindows>[0]
    ) as unknown as Array<RecallWindow>
  ).map((window) => {
    const last = window.messages[window.messages.length - 1];
    return {
      ...window,
      best: Math.min(Infinity, ...[...window.hitIds].map((id) => order.get(id) ?? Infinity)),
      endTs: last.ts,
    };
  });
  // The windows kept are the best by their best hit; they come back newest first, as the record recall's do.
  const windows = merged
    .sort((a, b) => a.best - b.best || b.endTs - a.endTs)
    .slice(0, keep)
    .sort((a, b) => b.endTs - a.endTs)
    .map(({ best, endTs, ...window }) => {
      const first = window.messages[0];
      return {
        ...window,
        source: 'db',
        sourceHitIds: window.hitIds,
        hitIds: [...window.hitIds].map(
          (id) => built.flatMap((part) => part.messages).find((message) => message.stored?.sourceId === id)?.id ?? id
        ),
        place: first?.stored?.placeId ?? null,
        messages: window.messages.map((message) => originalMessage(message, built)),
      };
    });

  const hidden =
    context.kind === 'group' && terms.length > 0
      ? hiddenBetter(db, context, terms, scopeArgs, (row) => shown(row) && placeShown(row.place_id), askersOf(context))
      : false;
  showItemsOnce(windows);
  const lines = far
    ? []
    : byScore
        .filter((hit) => isClose(hit, mediaBar))
        .slice(0, Math.max(0, hitLines))
        .map((hit) => messageOf(rowsOf.get(hit.rowid) as Row, read));
  return { windows, hits, mediaHits: mediaFound, hidden, sampled, far, lines, stats };
}

/**
 * The scope a plan asks: its range, its chat (`place` as it is, else `placeId` through chatNamed), her own lines alone
 * with `mine`, and the places the caller allows (`places`).
 */
function scopeOfPlan(db: Db, context: Context, plan: RecallPlan | undefined, places: string | null): ScopeArgs {
  const { from, to, placeId, place, mine } = plan ?? {};
  const named = typeof placeId === 'string' && placeId ? chatNamed(db, ifaceOf(context), placeId) : null;
  return {
    from: isFiniteNumber(from) ? from : null,
    to: isFiniteNumber(to) ? to : null,
    placeId: typeof place === 'string' && place ? place : named,
    places,
    mine: mine === true,
  };
}

/**
 * Whether a hit is close: found by its words or its people, holding a term of the plan, or found by a meaning over the
 * bar a meaning alone must clear (`bar.strongMeaningScore`, the prefetch's). Every hit is close without a bar.
 */
function isClose(hit: RecallHit, bar: SearchInput['mediaBar']): boolean {
  if (!bar) return true;
  const { streams, terms, cosine } = hit;
  const byWords = streams.includes('words') || streams.includes('trigram') || streams.includes('people');
  return byWords || terms > 0 || (cosine ?? -1) >= bar.strongMeaningScore;
}

/**
 * Whether a search found lines and none of them is close (isClose), no media item cleared its bar and the lines are no
 * sample: the caller then says nothing close was found, and the windows hold the `NEAREST_LINES` best hits alone.
 */
function nearOnly(
  hits: ReadonlyArray<RecallHit>,
  { bar, sampled, media }: { bar: SearchInput['mediaBar']; sampled: boolean; media: number }
): boolean {
  return Boolean(bar) && !sampled && media === 0 && hits.length > 0 && !hits.some((hit) => isClose(hit, bar));
}

/** Whether an item stays under `bar`: found by its words, or by a meaning close enough (SearchInput.mediaBar). */
function clearsBar(hit: MediaHit, bar: SearchInput['mediaBar']): boolean {
  if (!bar || hit.streams.includes('words') || hit.streams.includes('trigram')) return true;
  const cosine = hit.cosine ?? -1;
  return cosine >= bar.minMeaningScore && (cosine >= bar.strongMeaningScore || hit.terms > 0);
}

/** One answer tells an item once: a much-reused item must not fill it. Its later lines keep their markers. */
function showItemsOnce(windows: ReadonlyArray<{ messages: ReadonlyArray<RecallMessage> }>): void {
  const seen = new Set<unknown>();
  for (const window of windows) {
    for (const message of window.messages) {
      for (const item of [
        ...message.attachments,
        ...(message.stickers as Array<Row>),
        ...(message.emojis as Array<Row>),
      ]) {
        if (!('told' in item) && !('previewText' in item)) continue;
        if (seen.has(item.id)) {
          delete item.told;
          delete item.previewText;
        }
        seen.add(item.id);
      }
    }
  }
}

/** The person ids of whoever asked, from the context's optional `asker` (one id or a list). */
const askersOf = (ctx: Context): Array<string> =>
  (Array.isArray(ctx?.asker) ? ctx.asker : [ctx?.asker]).filter(
    (id): id is string => typeof id === 'string' && id !== ''
  );

/** The DM audiences of the `askers` on `iface`: the audiences of the DM places whose partner is one of them. */
function askerDmAudiences(db: Db, askers: ReadonlyArray<string>, iface: unknown): Set<string> {
  const rows = db
    .prepare(
      `SELECT a.id AS id FROM places p JOIN audiences a ON a.place_id = p.id AND a.kind = 'dm'
       WHERE p.chat = 'dm' AND p.iface = ? AND p.partner_person IN (SELECT value FROM json_each(?))`
    )
    .all(String(iface), JSON.stringify(askers));
  return new Set(rows.map((row) => String(row.id)));
}

/**
 * Whether a DM of the person who asked holds a word match better than anything this context may show: the matches
 * are walked best first; a line the context may show means no (a visible match is at least as good); a DM line of this
 * interface whose partner is one of the `askers` means yes; any other line the context may not open (another person's
 * DM, another interface's line, an internal row) is skipped: it neither gives a hint nor hides the asker's own DM. A boolean: nothing of the line
 * leaves this function (only ids and scope columns are read).
 */
function hiddenBetter(
  db: Db,
  ctx: Context,
  terms: ReadonlyArray<Term>,
  scopeArgs: ScopeArgs,
  shown: (row: Row) => boolean,
  askers: ReadonlyArray<string>
): boolean {
  if (askers.length === 0) return false;
  // The asker's own DM on this interface: the audience of a DM place whose partner asked, else the triple.
  const askerAudiences = ctx.audienceColumn === true ? askerDmAudiences(db, askers, ctx.iface) : null;
  const askedIn =
    askerAudiences !== null
      ? (row: Row) => askerAudiences.has(row.audience_id as string)
      : (row: Row) =>
          row.scope_kind === 'dm' && row.scope_iface === ctx.iface && askers.includes(row.scope_dm as string);
  const parts: Array<string> = [];
  const params: Array<string> = [];
  if (scopeArgs.from !== null && Number.isFinite(scopeArgs.from)) {
    parts.push('s.occurred_at >= ?');
    params.push(iso(scopeArgs.from));
  }
  if (scopeArgs.to !== null && Number.isFinite(scopeArgs.to)) {
    parts.push('s.occurred_at <= ?');
    params.push(iso(scopeArgs.to));
  }
  if (scopeArgs.placeId !== null) {
    parts.push('s.place_id = ?');
    params.push(scopeArgs.placeId);
  }
  const rows = db
    .prepare(
      `SELECT s.native_id AS native_id, s.place_id AS place_id, s.scope_kind AS scope_kind, s.scope_iface AS scope_iface, s.scope_dm AS scope_dm, s.audience_id AS audience_id
    FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
    WHERE sources_fts MATCH ? AND ${CURRENT_SOURCE} ${parts.map((part) => `AND ${part}`).join(' ')} ORDER BY bm25(sources_fts, 0.0, 1.0)`
    )
    .iterate(matchOf(terms), ...params);
  for (const row of rows) {
    if (canRead(row, ctx)) {
      if (shown(row)) return false;
    } else if (askedIn(row)) {
      return true;
    }
    // Another person's DM, another interface's line, an internal row: skipped, never a hint, never a stop.
  }
  return false;
}

// ---------- window reads ----------

/**
 * The lines of a place up (earlier) or down (later) from an anchor message, oldest first, inside the read context.
 * `anchor` is a source id (`src:...`) or a message id; `messages` and `minutes` bound the read (both: both apply; none:
 * `recall.windowMessages`). The anchor itself is not part of the result. A line the context may not open ends the
 * read there (`stopped: 'hidden'`) and is not counted; the end of the place is `stopped: 'edge'`. An anchor the
 * context may not open, or that does not exist, is `unknown`.
 */
export function window(
  dbGiven: unknown,
  {
    ctx,
    anchor,
    resolvedAnchor,
    move = 'up',
    messages = null,
    minutes = null,
    settings = null,
    nameOf = null,
    selfName = '',
    channelNameOf = null,
    exclude = null,
    exclusions,
    allowPlace = null,
  }: {
    ctx?: Context;
    anchor?: unknown;
    resolvedAnchor?: ResolvedRecallAnchor;
    move?: string;
    messages?: unknown;
    minutes?: unknown;
    settings?: DbSettings | null;
    nameOf?: unknown;
    selfName?: string;
    channelNameOf?: unknown;
    exclude?: unknown;
    exclusions?: ReadonlyArray<ResolvedRecallAnchor>;
    allowPlace?: unknown;
  } = {}
): { windows: Array<RecallWindow>; unknown: boolean; stopped: 'hidden' | 'edge' | null } {
  const db = dbGiven as Db;
  whereFor(ctx);
  const context = ctx as Context;
  const gone: { windows: Array<RecallWindow>; unknown: boolean; stopped: 'hidden' | 'edge' | null } = {
    windows: [],
    unknown: true,
    stopped: null,
  };
  const row = sourceForAnchor(db, context, anchor, resolvedAnchor);
  if (!row || !row.place_id || (typeof allowPlace === 'function' && !allowPlace(row.place_id))) return gone;
  const count =
    isWholeNumber(messages) && messages > 0
      ? messages
      : isFiniteNumber(minutes) && minutes > 0
        ? FOLLOW_READ_MAX
        : (settings?.windowMessages ?? WINDOW_FALLBACK);
  const span = isFiniteNumber(minutes) && minutes > 0 ? minutes : null;
  const read = neighbours(db, context, row, move === 'down' ? 1 : -1, {
    count: Math.min(count, FOLLOW_READ_MAX),
    minutes: span,
  });
  const rows = move === 'down' ? read.rows : [...read.rows].reverse();
  const skip = excludedSources(db, context, exclusions, exclude);
  const shown = windowOf(rows, new Set(), readerOf(db, context, { nameOf, selfName, channelNameOf, exclude: skip }));
  return { windows: shown.messages.length > 0 ? [shown] : [], unknown: false, stopped: read.stopped };
}

// ---------- quotes ----------

type RecallQuoteEntry = {
  id: unknown;
  stored?: StoredSourceRef;
  text: string;
  authorId: string | null;
  self: boolean;
  message: RecallMessage | null;
};

type RecallQuote = {
  placeId: string | null;
  channelName: string | null;
  startTs: number;
  lines: string;
  entries: Array<RecallQuoteEntry>;
};

/**
 * The stretches `recall.run` returns for a persona's own search (`quotes`): every window rendered without indices,
 * cut to `stretchChars`, each with its `entries` (a line's message, for the handles of a result).

 * `windows` are search's or window's windows; `render` is the options of renderRecallWindows (labels, timezone,
 * selfName, gapMinutes, maxChars, seeReactions, reactionsPerMessage).
 */
export function quotesOf(
  windows: unknown,
  { render, stretchChars }: { render: Row; stretchChars: number }
): Array<RecallQuote> {
  const out: Array<RecallQuote> = [];
  for (const one of (Array.isArray(windows) ? windows : []) as Array<RecallWindow | null>) {
    if (!one || !(stretchChars > 0)) continue;
    // Same as in `search`: recall.ts types the window and its lines narrower than they are.
    const [shown] = renderRecallWindows(
      [keyedWindow(one) as unknown as Parameters<typeof renderRecallWindows>[0][number]],
      {
        ...render,
        indexed: false,
      }
    );
    const lines = cutStretch(shown?.lines ?? [], stretchChars) as unknown as Array<{
      id: unknown;
      text: string;
      ts: number;
    }>;
    if (lines.length === 0) continue;
    const byId = new Map(
      one.messages.map((message): [unknown, RecallMessage] => [message.stored?.sourceId ?? message.id, message])
    );
    const entries = lines.map((line) => {
      const message = byId.get(line.id) ?? null;
      return {
        id: message?.id ?? line.id,
        ...(message?.stored ? { stored: message.stored } : {}),
        text: line.text,
        authorId: message?.authorId ?? null,
        self: message?.self === true,
        message,
      };
    });
    out.push({
      placeId: one.placeId,
      channelName: one.channelName,
      startTs: lines[0].ts,
      lines: lines.map((line) => line.text).join('\n'),
      entries,
    });
  }
  return out;
}
