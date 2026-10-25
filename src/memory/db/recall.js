// Recall over the memory database (spec 2026-10-24-memory-store, section 8): what `memory.search` and the memory
// prefetch use. It reads the `sources` table of the record (every chat line, its
// scope and place) and the `vectors` table, always inside a scope context (src/memory/db/scope.js): a row the context
// may not open is never searched, never counted and never read into a stretch. The caller's place rule (`allowPlace`)
// is resolved once into a set of places and runs inside every stream's query, before any LIMIT, ranking or fusion.
//
// search(db, { ctx, plan, ... }) takes the plan `memorySearchPlan` builds (`forms`, `who`, `from`, `to`, `channelId`)
// and runs four streams, each a ranked list of messages:
//   words    the plan's forms as stems (the learned stemmer of src/memory/db/stems.js, the same one that stamped
//            `sources.stems`) through `sources_fts`: a one-word form is a word, a longer form a phrase; bm25;
//   trigram  a form the word stream finds nothing for, as a part of a word (`sources_tri`), for typos and stems the
//            learned endings did not cover;
//   meaning  the stored vectors within the context's scope, a plain scan, cosine on the int8 rows (the question's
//            embedding is the caller's: it is given as `vector`);
//   people   the lines of the members the plan's `who` forms name.
// The streams are fused by reciprocal rank (k 60, src/behavior/recall.js#fuseRanks); every hit keeps the streams that
// found it. A relevance gate drops hits far below the best, the rest is ranked by closeness to the plan's date range
// (its middle; the nearest end of an open range); with no date, by what a hit holds first (terms, phrases) and
// the nearness to now only among equals. Stretches are built around the best hits as recall
// builds them from the record: the reply chain, `recordContext` lines each side, then the conversation followed on
// (`followMessages` while no silence longer than `followGapMinutes`), merged where they share a line.
//
// A group context that has a better match only in a DM it may not open gets `hidden: true` and nothing else about it:
// no text, no count (the owner, 2026-10-20).
//
// A context with `audienceColumn: true` (`memoryDb.audienceColumn`) is read through `audience_id` (scope.js#scopeWhere,
// #canRead) instead of the three scope columns; both give the same rows on a database the resolver filled.
//
// window(db, { ctx, anchor, move, messages, minutes }) reads the lines of a place up (earlier) or down (later) from a
// message, in time order, inside the context; the read stops at the first line the context may not open and never
// counts one.
//
// Pure of the bot: it works on an opened database (any connection, read-only is enough) and takes everything else
// as arguments. Rows are read here; wording and rendering are the caller's (`quotesOf` turns windows into the
// stretches `recall.run` returns when it renders them with src/behavior/recall.js#renderRecallWindows).

import { MINUTE_MS } from '../../time.js';
import { RECALL_DEFAULTS, RRF_K, cutStretch, followConversation, fuseRanks, mergeWindows, recallSettings, renderRecallWindows } from '../../behavior/recall.js';
import { log } from '../../log.js';
import { foldText } from '../recent.js';
import { indexWords } from '../record-index.js';
import { channelPlaceId, nativeOf } from './ids.js';
import { audienceOf, canRead, dmScope, scopeWhere, whereFor } from './scope.js';
import { loadStemmer } from './stems.js';

/** How many reply parents a hit's chain follows at most (as the record recall does). */
const REPLY_CHAIN_MAX = 10;
/** The most lines one follow reads from the database before the conversation's silence cuts it. */
const FOLLOW_READ_MAX = 100;
/** Hits turned into windows per window kept (as the record recall does). */
const HITS_PER_WINDOW = 4;
/** The weight of the people stream when the plan also has word forms (it only locates the person then). */
const PEOPLE_WEIGHT_WITH_FORMS = 0.5;
/** Fallback of the window length of a window read when neither `messages` nor `minutes` is given: `recall.windowMessages`. */
const WINDOW_FALLBACK = 16;

const STREAMS = ['words', 'trigram', 'meaning', 'people'];

/** `current`: the newest revision of a chat line, once, and not a deleted message. Needs the alias `s`. */
const CURRENT = `s.kind IN ('seen', 'said') AND s.retired_at IS NULL
  AND s.revision IS (SELECT MAX(t.revision) FROM sources t WHERE t.native_id = s.native_id AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL)
  AND s.rowid = (SELECT MIN(t.rowid) FROM sources t WHERE t.native_id = s.native_id AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL AND t.revision IS s.revision)
  AND NOT EXISTS (SELECT 1 FROM sources d WHERE d.native_id = s.native_id AND d.kind = 'deleted' AND d.retired_at IS NULL)`;

const quoteFts = (text) => `"${String(text).replace(/"/g, '""')}"`;
const iso = (ms) => new Date(ms).toISOString();

/**
 * The settings of a db recall from the live config: the recall settings (windows, follow: src/behavior/recall.js#recallSettings)
 * with `gateShare` (0..1: the share of the best fused score a hit needs), `candidates` (rows per stream) and
 * `minMeaning` (the cosine under which a meaning hit is dropped) lifted out of `recall.db`. Null while recall is off.
 */
export function dbSettings(config) {
  const base = recallSettings(config);
  return base ? { ...base, ...base.db } : null;
}

// ---------- rows to messages ----------

const parseJson = (text) => {
  if (typeof text !== 'string' || !text) return null;
  try { return JSON.parse(text); } catch { return null; }
};
const str = (value) => (typeof value === 'string' ? value : '');

/** The first name of each account, by native id: an account's own names only, never through its person's other accounts. */
function accountNames(db) {
  const names = new Map();
  for (const row of db.prepare('SELECT id, native_id, names FROM accounts WHERE retired_at IS NULL').all()) {
    const list = parseJson(row.names);
    const first = Array.isArray(list) ? list.find((name) => typeof name === 'string' && name) : null;
    if (first) names.set(row.native_id ?? nativeOf(row.id), first);
  }
  return names;
}

/** The names of the places a context may know: a private place's name is the internal context's alone. */
function placeNames(db, ctx) {
  const names = new Map();
  const rows = db.prepare("SELECT id, name, iface, scope_kind FROM places WHERE name IS NOT NULL AND retired_at IS NULL").all();
  for (const row of rows) {
    if (ctx.internal !== true && (row.scope_kind === 'dm' || row.scope_kind === 'internal' || (row.iface && row.iface !== ctx.iface))) continue;
    names.set(row.id, row.name);
  }
  return names;
}

/** The channel id a source row belongs to: its place's, or the private channel the record line carried. */
function channelOf(row, extra) {
  const dm = typeof extra?.dmChannel === 'string' && extra.dmChannel ? extra.dmChannel : null;
  return dm ?? nativeOf(row.place_id) ?? String(row.place_id ?? '');
}

/** One source row as a normalized chat message (the shape renderRecallWindows reads). */
function messageOf(row, { nameOf, selfName }) {
  const extra = parseJson(row.extra) ?? {};
  const self = row.kind === 'said';
  const by = row.author_account ? nativeOf(row.author_account) : null;
  const name = self ? selfName : by ? (nameOf(by) ?? '') : '';
  const media = parseJson(row.media);
  const links = Array.isArray(extra.links) ? extra.links : [];
  const ts = Date.parse(row.occurred_at);
  const recordedAt = Date.parse(row.recorded_at);
  const mentions = parseJson(row.mentions);
  return {
    id: row.native_id,
    channelId: channelOf(row, extra),
    authorId: by,
    authorName: String(name ?? '').replace(/\s+/g, ' ').trim() || '-',
    self,
    bot: false,
    content: str(row.text),
    ts,
    replyToId: str(row.reply_to) || null,
    mentionedUserIds: Array.isArray(mentions) ? mentions : [],
    mentionedChannelIds: [],
    attachments: (Array.isArray(media) ? media : []).filter((kind) => typeof kind === 'string' && kind).map((kind, i) => ({ id: `${row.native_id}#m${i}`, kind, name: kind })),
    links: links
      .filter((link) => link && typeof link === 'object' && (str(link.title) || str(link.description)))
      .map((link, i) => ({ id: str(link.id) || `${row.native_id}#l${i}`, kind: 'link', site: str(link.site), title: str(link.title), text: str(link.description), url: str(link.url) || null, thumbnailUrl: null })),
    stickers: [],
    emojis: [],
    forwarded: [],
    reactions: [],
    editedAt: Number.isInteger(row.revision) && row.revision > 1 ? (Number.isFinite(recordedAt) ? recordedAt : ts) : null,
  };
}

// ---------- the plan ----------

/** The plan's forms as stem sequences; a form with no word in it is dropped. */
function termsOf(stem, forms) {
  const out = [];
  const seen = new Set();
  for (const form of Array.isArray(forms) ? forms : []) {
    if (typeof form !== 'string') continue;
    const words = indexWords(form);
    const keys = words.map(stem);
    const id = keys.join(' ');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ form, keys, id, folded: foldText(form), phrase: keys.length > 1 });
  }
  return out;
}

/**
 * The relevance gate: a hit stays when its fused score is at least `gateShare` of the best one, or when it holds as
 * many distinct terms as the best-covering hit (two at least). Without the second rule a line holding every term but
 * found by the words alone falls under a recent line the meaning stream also found (its fused score doubles).
 * @param {Array<{ score: number }>} visible  fused entries, best first
 * @param {(entry: object) => number} termsOf  distinct terms an entry's line holds
 * @param {number} gateShare
 */
export function passGate(visible, termsOf, gateShare) {
  const best = visible[0]?.score ?? 0;
  const counts = visible.map((entry) => termsOf(entry));
  const most = counts.reduce((max, n) => Math.max(max, n), 0);
  return visible.filter((entry, i) => entry.score >= best * gateShare || (most >= 2 && counts[i] === most));
}

const matchOf = (terms) => `{stems} : (${terms.map((term) => quoteFts(term.id)).join(' OR ')})`;

/** How many terms, and how many of them phrases, a row holds (by its stems; by its text for a trigram hit). */
function holds(terms, row) {
  const tokens = String(row.stems ?? '').split(' ').filter(Boolean);
  const text = foldText(row.text);
  let count = 0;
  let phrases = 0;
  for (const term of terms) {
    let found = false;
    if (term.keys.length === 1) found = tokens.includes(term.keys[0]);
    else {
      for (let at = 0; !found && at + term.keys.length <= tokens.length; at += 1) found = term.keys.every((key, i) => tokens[at + i] === key);
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
function placesAllowed(db, ctx, allowPlace) {
  if (typeof allowPlace !== 'function') return null;
  const scope = scopeWhere(ctx, 's');
  const found = db.prepare(`SELECT DISTINCT s.place_id AS place_id FROM sources s WHERE s.place_id IS NOT NULL AND ${scope.sql}`).all(...scope.params);
  return JSON.stringify(found.map((row) => row.place_id).filter((placeId) => allowPlace(placeId)));
}

/** The shared filters of a stream: scope, range, place, the caller's allowed places. Returns { sql, params } (without a leading AND). */
function filters(ctx, { from, to, placeId, places = null }, alias = 's') {
  const scope = scopeWhere(ctx, alias);
  const parts = [scope.sql];
  const params = [...scope.params];
  if (Number.isFinite(from)) { parts.push(`${alias}.occurred_at >= ?`); params.push(iso(from)); }
  if (Number.isFinite(to)) { parts.push(`${alias}.occurred_at <= ?`); params.push(iso(to)); }
  if (placeId) { parts.push(`${alias}.place_id = ?`); params.push(placeId); }
  if (places !== null) { parts.push(`${alias}.place_id IN (SELECT value FROM json_each(?))`); params.push(places); }
  return { sql: parts.join(' AND '), params };
}

const WORD_COLUMNS = 's.*, s.rowid AS rowid';

function wordRows(db, ctx, terms, scopeArgs, limit) {
  if (terms.length === 0) return [];
  const filter = filters(ctx, scopeArgs);
  return db.prepare(`SELECT ${WORD_COLUMNS}, bm25(sources_fts, 0.0, 1.0) AS rank FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
    WHERE sources_fts MATCH ? AND ${CURRENT} AND ${filter.sql} ORDER BY rank LIMIT ?`).all(matchOf(terms), ...filter.params, limit);
}

/** Whether the word stream finds `term` at all inside the context. */
function wordFinds(db, ctx, term, scopeArgs) {
  const filter = filters(ctx, scopeArgs);
  return db.prepare(`SELECT 1 AS ok FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
    WHERE sources_fts MATCH ? AND ${CURRENT} AND ${filter.sql} LIMIT 1`).get(matchOf([term]), ...filter.params) !== undefined;
}

function trigramRows(db, ctx, terms, scopeArgs, limit) {
  const filter = filters(ctx, scopeArgs);
  const rows = [];
  for (const term of terms) {
    if ([...term.form.trim()].length < 3) continue;
    rows.push(...db.prepare(`SELECT ${WORD_COLUMNS}, bm25(sources_tri) AS rank FROM sources_tri JOIN sources s ON s.rowid = sources_tri.rowid
      WHERE sources_tri MATCH ? AND ${CURRENT} AND ${filter.sql} ORDER BY rank LIMIT ?`).all(quoteFts(term.form.trim()), ...filter.params, limit));
  }
  return rows.sort((a, b) => a.rank - b.rank);
}

/** The int8 row `bytes` (a Uint8Array from SQLite) as signed bytes. */
const signed = (bytes) => new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

let warnedModel = false;

const evictionColumn = new WeakMap();
/** ` AND v.evicted_at IS NULL` on a database with the column (schema v11), '' before it. */
function notEvicted(db) {
  if (!evictionColumn.has(db)) evictionColumn.set(db, db.prepare('PRAGMA table_info(vectors)').all().some((column) => column.name === 'evicted_at'));
  return evictionColumn.get(db) ? ' AND v.evicted_at IS NULL' : '';
}

/**
 * The best `limit` vector rows by cosine to `vector`: { source_rowid, score }. The vectors are joined to the
 * eligible current sources before the top-K: a row the context may not open, a place the caller refuses, a deleted or
 * superseded message never competes. A vector stored on an older revision counts only while that revision's text is
 * the current text (`source_rowid` then names the current row). `model` is the query's embedding model: a row of
 * another model is skipped; a row with no model is taken by its dims, and says so once in the log. An evicted vector
 * (schema v11, index-policy.js: no bytes, `evicted_at` set) never competes.
 */
function meaningRows(db, ctx, vector, scopeArgs, limit, model = null) {
  const q = vector instanceof Float32Array ? vector : Float32Array.from(vector ?? []);
  let qq = 0;
  for (let i = 0; i < q.length; i += 1) qq += q[i] * q[i];
  const qNorm = Math.sqrt(qq);
  if (!(qNorm > 0) || limit <= 0) return [];
  const filter = filters(ctx, scopeArgs);
  const modelSql = typeof model === 'string' && model ? ' AND (v.model IS NULL OR v.model = ?)' : '';
  const modelParams = modelSql ? [model] : [];
  const rows = db.prepare(`SELECT s.rowid AS source_rowid, v.scale AS scale, v.norm AS norm, v.bytes AS bytes, v.model AS model
    FROM vectors v JOIN sources o ON o.rowid = v.source_rowid
    JOIN sources s ON s.native_id = o.native_id AND (s.rowid = o.rowid OR s.text IS o.text)
    WHERE v.retired_at IS NULL AND v.bytes IS NOT NULL${notEvicted(db)} AND v.dims = ?${modelSql} AND ${CURRENT} AND ${filter.sql}`).iterate(q.length, ...modelParams, ...filter.params);
  const heap = [];
  let floor = -Infinity;
  for (const row of rows) {
    if (row.model === null && !warnedModel) {
      warnedModel = true;
      log.warn('memory db recall: vectors without a model are matched by dims alone');
    }
    if (!(row.norm > 0) || !(row.scale > 0)) continue;
    const data = signed(row.bytes);
    let dot = 0;
    for (let j = 0; j < q.length; j += 1) dot += data[j] * q[j];
    const score = (dot * row.scale) / (qNorm * row.norm);
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
function currentRows(db, ctx, rowids, scopeArgs) {
  const out = new Map();
  if (rowids.length === 0) return out;
  const filter = filters(ctx, scopeArgs);
  const select = db.prepare(`SELECT ${WORD_COLUMNS} FROM sources s WHERE s.rowid = ? AND ${CURRENT} AND ${filter.sql}`);
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
function accountsOf(db, ctx, forms) {
  const wanted = new Map((Array.isArray(forms) ? forms : []).map((form) => [foldText(form), form]).filter(([key]) => key));
  const ids = new Set();
  const named = new Set();
  if (wanted.size === 0) return { ids, unresolved: [] };
  for (const row of db.prepare('SELECT id, names FROM accounts WHERE retired_at IS NULL').all()) {
    const list = parseJson(row.names);
    for (const name of Array.isArray(list) ? list : []) {
      const key = foldText(name);
      if (wanted.has(key)) { ids.add(row.id); named.add(key); }
    }
  }
  const scope = scopeWhere(ctx, 'c');
  const aliases = db.prepare(`SELECT c.text AS text, a.id AS account FROM claims c JOIN accounts a ON a.person_id = c.subject_id
    WHERE c.kind = 'alias' AND c.retired_at IS NULL AND a.retired_at IS NULL AND a.link = 'verified' AND ${scope.sql}`).all(...scope.params);
  for (const row of aliases) {
    const key = foldText(row.text);
    if (wanted.has(key)) { ids.add(row.account); named.add(key); }
  }
  return { ids, unresolved: [...wanted].filter(([key]) => !named.has(key)).map(([, form]) => form) };
}

function peopleRows(db, ctx, accounts, scopeArgs, limit) {
  if (accounts.size === 0) return [];
  const filter = filters(ctx, scopeArgs);
  const marks = [...accounts].map(() => '?').join(', ');
  return db.prepare(`SELECT ${WORD_COLUMNS} FROM sources s WHERE s.author_account IN (${marks}) AND ${CURRENT} AND ${filter.sql}
    ORDER BY s.occurred_at DESC LIMIT ?`).all(...accounts, ...filter.params, limit);
}

// ---------- windows ----------

/**
 * The lines of a place next to a line, nearest first, never past a line the context may not open: `direction`
 * -1 earlier, +1 later; at most `count` lines and, when given, within `minutes` of the line.
 * @returns {{ rows: object[], stopped: 'hidden'|'edge'|null }}
 */
function neighbours(db, ctx, row, direction, { count, minutes = null }) {
  if (!(count > 0)) return { rows: [], stopped: null };
  const earlier = direction < 0;
  const limitMs = Number.isFinite(minutes) ? Date.parse(row.occurred_at) + (earlier ? -1 : 1) * minutes * MINUTE_MS : null;
  const bound = limitMs === null ? '' : ` AND s.occurred_at ${earlier ? '>=' : '<='} ?`;
  // The boundary is read as ids and scope columns only; the text is fetched for the lines the context may open.
  const sql = `SELECT s.rowid AS rowid, s.scope_kind AS scope_kind, s.scope_iface AS scope_iface, s.scope_dm AS scope_dm, s.audience_id AS audience_id FROM sources s WHERE s.place_id = ? AND ${CURRENT}
    AND (s.occurred_at, s.rowid) ${earlier ? '<' : '>'} (?, ?)${bound} ORDER BY s.occurred_at ${earlier ? 'DESC' : 'ASC'}, s.rowid ${earlier ? 'DESC' : 'ASC'} LIMIT ?`;
  const found = db.prepare(sql).all(row.place_id, row.occurred_at, row.rowid, ...(limitMs === null ? [] : [iso(limitMs)]), count);
  const open = [];
  let stopped = null;
  for (const next of found) {
    if (!canRead(next, ctx)) { stopped = 'hidden'; break; }
    open.push(next.rowid);
  }
  const rows = rowsByRowid(db, open);
  return { rows, stopped: stopped ?? (rows.length < count ? 'edge' : null) };
}

/** The full source rows of `rowids`, in that order. */
function rowsByRowid(db, rowids) {
  if (rowids.length === 0) return [];
  const byId = new Map(db.prepare('SELECT s.*, s.rowid AS rowid FROM sources s WHERE s.rowid IN (SELECT value FROM json_each(?))').all(JSON.stringify(rowids)).map((row) => [row.rowid, row]));
  return rowids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * The current line of a message id, only when the context may open it: the scope columns are read first, the text
 * of a line the context may not open is never loaded.
 */
function sourceByNative(db, ctx, nativeId) {
  const light = db.prepare(`SELECT s.rowid AS rowid, s.scope_kind AS scope_kind, s.scope_iface AS scope_iface, s.scope_dm AS scope_dm, s.audience_id AS audience_id FROM sources s WHERE s.native_id = ? AND ${CURRENT}`).get(String(nativeId));
  return light && canRead(light, ctx) ? (rowsByRowid(db, [light.rowid])[0] ?? null) : null;
}

/** The stretch around a hit: reply chain, `around` lines each side, the followed conversation. Rows, oldest first. */
function stretchAround(db, ctx, hit, { around, followMessages, followGapMinutes }) {
  const chosen = new Map([[hit.rowid, hit]]);
  let parent = hit.reply_to;
  for (let depth = 0; parent && depth < REPLY_CHAIN_MAX; depth += 1) {
    const found = sourceByNative(db, ctx, parent);
    if (!found || found.place_id !== hit.place_id || chosen.has(found.rowid)) break;
    chosen.set(found.rowid, found);
    parent = found.reply_to;
  }
  for (const row of neighbours(db, ctx, hit, -1, { count: around }).rows) chosen.set(row.rowid, row);
  const after = neighbours(db, ctx, hit, 1, { count: around });
  for (const row of after.rows) chosen.set(row.rowid, row);
  // The conversation goes on past the last line of the stretch while it does not fall silent.
  const rows = [...chosen.values()].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.rowid - b.rowid));
  const last = rows[rows.length - 1];
  if (after.stopped !== 'hidden') {
    const ahead = neighbours(db, ctx, last, 1, { count: FOLLOW_READ_MAX }).rows;
    const lastTs = Date.parse(last.occurred_at);
    const followed = followConversation(lastTs, ahead.map((row) => ({ ts: Date.parse(row.occurred_at), row })), { followMessages, followGapMinutes });
    for (const { row } of followed) chosen.set(row.rowid, row);
  }
  return [...chosen.values()].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.rowid - b.rowid));
}

/** A window (the recall runner's shape) of source rows. */
function windowOf(rows, hitIds, read) {
  const messages = rows.filter((row) => !read.exclude.has(row.native_id)).map((row) => messageOf(row, read));
  const channelId = messages[0]?.channelId ?? null;
  return {
    source: 'db',
    placeId: rows[0]?.place_id ?? null,
    channelId,
    channelName: read.channelNameOf(channelId, rows[0]?.place_id),
    messages,
    hitIds: [...hitIds].filter((id) => !read.exclude.has(id)),
    overlapsChat: messages.length < rows.length,
  };
}

function readerOf(db, ctx, { nameOf = null, selfName = '', channelNameOf = null, exclude = null } = {}) {
  let names = null;
  let places = null;
  return {
    selfName,
    exclude: exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []),
    nameOf: (id) => {
      const given = typeof nameOf === 'function' ? nameOf(id) : null;
      if (given) return given;
      names ??= accountNames(db);
      return names.get(String(id)) ?? null;
    },
    channelNameOf: (channelId, placeId) => {
      const given = typeof channelNameOf === 'function' ? channelNameOf(channelId) : null;
      if (given) return given;
      places ??= placeNames(db, ctx);
      return places.get(placeId) ?? places.get(channelPlaceId(channelId)) ?? null;
    },
  };
}

// ---------- search ----------

/** The point in time a result is ranked toward: the middle of a closed range, the nearest end of an open one, else now. */
function targetOf({ from, to }, now) {
  if (Number.isFinite(from) && Number.isFinite(to)) return (from + to) / 2;
  if (Number.isFinite(from)) return from;
  if (Number.isFinite(to)) return to;
  return now;
}

/**
 * Searches the record in a scope context.
 * @param {object} db  an opened memory database (any connection)
 * @param {{ ctx: object, plan: { forms?: string[], who?: string[], from?: number|null, to?: number|null, channelId?: string },
 *   limit?: number, now?: number, vector?: ArrayLike<number>|null, settings?: object, exclude?: Set<string>|string[],
 *   nameOf?: Function, selfName?: string, channelNameOf?: Function, allowPlace?: (placeId: string) => boolean, model?: string|null }} input
 *   `limit`: the most windows (recall.maxClusters); `vector`: the question's embedding, none for a words-only search;
 *   `settings`: dbSettings(config); `exclude`: message ids the turn already shows; `allowPlace`: the caller's own rule
 *   for the places it may show (the pull rail of a channel), resolved once into the set of places the streams query (before any LIMIT or fusion);
 *   `model`: the embedding model of `vector` (a stored vector of another model is skipped; one with no model is matched by dims).
 *   The context may carry `asker` (a person id, or a list of them): the hidden marker is set only for a DM of one of them.
 * @returns {{ windows: object[], hits: object[], hidden: boolean, stats: object }}
 *   a hit: { id, rowid, messageId, placeId, ts, score, streams, terms, phrases, cosine }, best first.
 */
export function search(db, { ctx, plan, limit = RECALL_DEFAULTS.maxClusters, now = Date.now(), vector = null, settings = null, exclude = null, nameOf = null, selfName = '', channelNameOf = null, allowPlace = null, model = null } = {}) {
  whereFor(ctx); // a read without a valid context throws
  const opts = settings ?? dbSettings({});
  const { gateShare, candidates, minMeaning } = opts;
  const pool = Math.max(candidates, Number.isInteger(opts.wordPool) ? opts.wordPool : candidates);
  const { stem } = loadStemmer(db);
  const scopeArgs = {
    from: Number.isFinite(plan?.from) ? plan.from : null,
    to: Number.isFinite(plan?.to) ? plan.to : null,
    placeId: typeof plan?.channelId === 'string' && plan.channelId ? channelPlaceId(plan.channelId) : null,
    // The caller's place rule runs inside every stream's query (see placesAllowed).
    places: placesAllowed(db, ctx, allowPlace),
  };
  const people = accountsOf(db, ctx, plan?.who);
  const terms = termsOf(stem, [...(plan?.forms ?? []), ...people.unresolved]);
  const stats = { words: 0, trigram: 0, meaning: 0, people: 0 };
  const rowsOf = new Map();
  const remember = (row) => { if (!rowsOf.has(row.rowid)) rowsOf.set(row.rowid, row); };

  // A wider pool is ranked by what a row holds (distinct terms, phrases, then bm25); the best `candidates` go on.
  const covered = (rows) => rows
    .map((row, at) => ({ row, at, held: holds(terms, row) }))
    .sort((a, b) => b.held.terms - a.held.terms || b.held.phrases - a.held.phrases || a.at - b.at)
    .slice(0, candidates)
    .map((entry) => entry.row);
  const words = covered(wordRows(db, ctx, terms, scopeArgs, pool));
  words.forEach(remember);
  stats.words = words.length;
  const missed = terms.filter((term) => !wordFinds(db, ctx, term, scopeArgs));
  const trigram = covered(trigramRows(db, ctx, missed, scopeArgs, pool)).filter((row) => !words.some((w) => w.rowid === row.rowid));
  trigram.forEach(remember);
  stats.trigram = trigram.length;

  let meaning = [];
  const cosine = new Map();
  if (vector && vector.length > 0) {
    const scored = meaningRows(db, ctx, vector, scopeArgs, candidates, model);
    const live = currentRows(db, ctx, scored.map((row) => row.source_rowid), scopeArgs);
    for (const row of scored) {
      if (row.score < minMeaning) continue;
      const source = live.get(row.source_rowid);
      if (!source) continue;
      if (!cosine.has(source.rowid)) { cosine.set(source.rowid, row.score); meaning.push(source); }
    }
    meaning = meaning.slice(0, candidates);
    meaning.forEach(remember);
    stats.meaning = meaning.length;
  }

  const talk = peopleRows(db, ctx, people.ids, scopeArgs, candidates);
  talk.forEach(remember);
  stats.people = talk.length;

  const lists = [words, trigram, meaning, talk].map((list) => list.map((row) => row.rowid));
  const weights = [1, 1, 1, terms.length > 0 ? PEOPLE_WEIGHT_WITH_FORMS : 1];
  const skip = exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []);
  const shown = (row) => !skip.has(row.native_id);
  const visible = fuseRanks(lists, { k: RRF_K, weights }).filter((entry) => shown(rowsOf.get(entry.id)));
  const target = targetOf(scopeArgs, now);
  const dated = scopeArgs.from !== null || scopeArgs.to !== null;
  const hits = passGate(visible, (entry) => holds(terms, rowsOf.get(entry.id)).terms, gateShare)
    .map((entry) => {
      const row = rowsOf.get(entry.id);
      const held = holds(terms, row);
      return {
        id: row.id,
        rowid: row.rowid,
        messageId: row.native_id,
        placeId: row.place_id,
        ts: Date.parse(row.occurred_at),
        score: entry.score,
        streams: STREAMS.filter((_, i) => entry.ranks[i] !== null),
        terms: held.terms,
        phrases: held.phrases,
        cosine: cosine.get(row.rowid) ?? null,
      };
    })
    .sort(dated
      // A named date: nearness to it first. Else relevance first (coverage), the date only breaks a tie of coverage.
      ? (a, b) => Math.abs(a.ts - target) - Math.abs(b.ts - target) || b.score - a.score
      : (a, b) => b.terms - a.terms || b.phrases - a.phrases || Math.abs(a.ts - target) - Math.abs(b.ts - target) || b.score - a.score);

  const read = readerOf(db, ctx, { nameOf, selfName, channelNameOf, exclude: skip });
  const keep = Math.max(1, Number.isInteger(limit) ? limit : RECALL_DEFAULTS.maxClusters);
  const byScore = [...hits].sort((a, b) => b.score - a.score);
  const chosen = new Set(hits.slice(0, keep * HITS_PER_WINDOW).map((hit) => hit.rowid));
  for (const hit of byScore.slice(0, keep)) chosen.add(hit.rowid);
  const hitIds = new Set(hits.map((hit) => hit.messageId));
  const built = hits.filter((hit) => chosen.has(hit.rowid)).map((hit) => {
    const rows = stretchAround(db, ctx, rowsOf.get(hit.rowid), { around: opts.recordContext, followMessages: opts.followMessages, followGapMinutes: opts.followGapMinutes });
    return windowOf(rows, new Set(rows.map((row) => row.native_id).filter((id) => hitIds.has(id))), read);
  });
  // A window's place is its best hit's place.
  // Its place is the better of two ranks: in the ranked hits (coverage) and by the fused score (where the meaning
  // stream lifts a line the words miss), so neither kind of match crowds the other out of the windows kept.
  const byRank = new Map(hits.map((hit, i) => [hit.messageId, i]));
  const byFused = new Map(byScore.map((hit, i) => [hit.messageId, i]));
  const order = new Map(hits.map((hit) => [hit.messageId, Math.min(byRank.get(hit.messageId), byFused.get(hit.messageId))]));
  const merged = mergeWindows(built).map((window) => ({
    ...window,
    best: Math.min(Infinity, ...[...window.hitIds].map((id) => order.get(id) ?? Infinity)),
    endTs: window.messages[window.messages.length - 1].ts,
  }));
  // The windows kept are the best by their best hit; they come back newest first, as the record recall's do.
  const windows = merged
    .sort((a, b) => a.best - b.best || b.endTs - a.endTs)
    .slice(0, keep)
    .sort((a, b) => b.endTs - a.endTs)
    .map(({ best, endTs, ...window }) => window);

  const hidden = ctx.kind === 'group' && terms.length > 0 ? hiddenBetter(db, ctx, terms, scopeArgs, (row) => shown(row) && (typeof allowPlace !== 'function' || allowPlace(row.place_id)), askersOf(ctx)) : false;
  return { windows, hits, hidden, stats };
}

/** The person ids of whoever asked, from the context's optional `asker` (one id or a list). */
const askersOf = (ctx) => (Array.isArray(ctx?.asker) ? ctx.asker : [ctx?.asker]).filter((id) => typeof id === 'string' && id);

/**
 * Whether a DM of the person who asked holds a word match better than anything this context may show: the matches
 * are walked best first; a line the context may show means no (a visible match is at least as good); a DM line of this
 * interface whose partner is one of the `askers` means yes; any other line the context may not open (another person's
 * DM, another interface's line, an internal row) is skipped: it neither gives a hint nor hides the asker's own DM. A boolean: nothing of the line
 * leaves this function (only ids and scope columns are read).
 */
function hiddenBetter(db, ctx, terms, scopeArgs, shown, askers) {
  if (askers.length === 0) return false;
  // The asker's own DM on this interface: by the triple, or by its audience (the DM place of the asker) on `audience_id`.
  const askerAudiences = new Set(askers.map((person) => audienceOf(dmScope(person, ctx.iface)).audience_id));
  const askedIn = ctx.audienceColumn === true
    ? (row) => askerAudiences.has(row.audience_id)
    : (row) => row.scope_kind === 'dm' && row.scope_iface === ctx.iface && askers.includes(row.scope_dm);
  const parts = [];
  const params = [];
  if (Number.isFinite(scopeArgs.from)) { parts.push('s.occurred_at >= ?'); params.push(iso(scopeArgs.from)); }
  if (Number.isFinite(scopeArgs.to)) { parts.push('s.occurred_at <= ?'); params.push(iso(scopeArgs.to)); }
  if (scopeArgs.placeId) { parts.push('s.place_id = ?'); params.push(scopeArgs.placeId); }
  const rows = db.prepare(`SELECT s.native_id AS native_id, s.place_id AS place_id, s.scope_kind AS scope_kind, s.scope_iface AS scope_iface, s.scope_dm AS scope_dm, s.audience_id AS audience_id
    FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
    WHERE sources_fts MATCH ? AND ${CURRENT} ${parts.map((part) => `AND ${part}`).join(' ')} ORDER BY bm25(sources_fts, 0.0, 1.0)`).iterate(matchOf(terms), ...params);
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
 * @returns {{ windows: object[], unknown: boolean, stopped: 'hidden'|'edge'|null }}
 */
export function window(db, { ctx, anchor, move = 'up', messages = null, minutes = null, settings = null, nameOf = null, selfName = '', channelNameOf = null, exclude = null, allowPlace = null } = {}) {
  whereFor(ctx);
  const gone = { windows: [], unknown: true, stopped: null };
  const id = String(anchor ?? '').trim();
  if (!id) return gone;
  let row = null;
  if (id.startsWith('src:')) {
    const light = db.prepare('SELECT s.rowid AS rowid, s.scope_kind AS scope_kind, s.scope_iface AS scope_iface, s.scope_dm AS scope_dm, s.audience_id AS audience_id FROM sources s WHERE s.id = ? AND s.retired_at IS NULL').get(id);
    row = light && canRead(light, ctx) ? (rowsByRowid(db, [light.rowid])[0] ?? null) : null;
  } else {
    row = sourceByNative(db, ctx, id);
  }
  if (!row || !row.place_id || (typeof allowPlace === 'function' && !allowPlace(row.place_id))) return gone;
  const count = Number.isInteger(messages) && messages > 0 ? messages : Number.isFinite(minutes) && minutes > 0 ? FOLLOW_READ_MAX : (settings?.windowMessages ?? WINDOW_FALLBACK);
  const span = Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  const read = neighbours(db, ctx, row, move === 'down' ? 1 : -1, { count: Math.min(count, FOLLOW_READ_MAX), minutes: span });
  const rows = move === 'down' ? read.rows : [...read.rows].reverse();
  const skip = exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []);
  const shown = windowOf(rows, new Set(), readerOf(db, ctx, { nameOf, selfName, channelNameOf, exclude: skip }));
  return { windows: shown.messages.length > 0 ? [shown] : [], unknown: false, stopped: read.stopped };
}

// ---------- quotes ----------

/**
 * The stretches `recall.run` returns for a persona's own search (`quotes`): every window rendered without indices,
 * cut to `stretchChars`, each with its `entries` (a line's message, for the handles of a result).
 * @param {object[]} windows  search's or window's windows
 * @param {{ render: object, stretchChars: number }} options  `render`: the options of renderRecallWindows (labels, timezone, selfName, gapMinutes, maxChars, seeReactions, reactionsPerMessage)
 * @returns {{ channelId: string, channelName: string|null, startTs: number, lines: string, entries: object[] }[]}
 */
export function quotesOf(windows, { render, stretchChars }) {
  const out = [];
  for (const one of Array.isArray(windows) ? windows : []) {
    if (!one || !(stretchChars > 0)) continue;
    const [shown] = renderRecallWindows([one], { ...render, indexed: false });
    const lines = cutStretch(shown?.lines ?? [], stretchChars);
    if (lines.length === 0) continue;
    const byId = new Map(one.messages.map((message) => [message.id, message]));
    const entries = lines.map((line) => {
      const message = byId.get(line.id) ?? null;
      return { id: line.id, text: line.text, authorId: message?.authorId ?? null, self: message?.self === true, message };
    });
    out.push({ channelId: one.channelId, channelName: one.channelName, startTs: lines[0].ts, lines: lines.map((line) => line.text).join('\n'), entries });
  }
  return out;
}
