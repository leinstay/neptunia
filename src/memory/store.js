// Persistent memory on plain JSON files under data/ — survives restarts, hot
// reloads and prompt edits; nothing in the codebase ever wipes it implicitly.
//
//   data/state.json                          the pause flag, the spontaneous schedule, token calibration, the
//                                            daily counters (LLM requests, portrait refreshes, voice requests,
//                                            mentor tokens, videos and re-watches, pictures drawn, web lookups,
//                                            GIFs posted and watched), the warmup progress, the open follow-up
//                                            windows, the ring of calls from other channels and the seen marks
//                                            of the channels a turn pulled in
//   data/guilds/<guildId>/guild.json         how this server talks, in-jokes, what the persona said about itself,
//                                            what people taught it (`learned`), and when the server notes last
//                                            changed and were last re-checked
//   data/guilds/<guildId>/buffer.json        messages observed since the last memory update
//   data/guilds/<guildId>/users/<userId>.json  one profile per active member
//   data/guilds/<guildId>/private/<userId>.json  what the persona learned from one member in direct
//                                            messages: never shown anywhere but that member's DM
//   data/guilds/<guildId>/channels/<channelId>.json  one entry per channel the persona has seen (the server map),
//                                            with the tally of who writes there
//   data/guilds/<guildId>/lore.json           the guild's lorebook
//   data/guilds/<guildId>/media.json          the media description cache
//   data/guilds/<guildId>/gifs.json           the GIF library the persona posts from (src/memory/gifs.js)
//   data/guilds/<guildId>/voice.json          the voice queue: briefs the two-stage analyzer's stage A left for
//                                            the voice model to word (src/memory/voice.js); survives restarts
//   data/guilds/<guildId>/recent.json         the recent store: short dated lines about the last
//                                            `memory.recentHours` hours, each with its source channel
//                                            (src/memory/recent.js)
//   data/guilds/<guildId>/participation.json  the persona's participation episodes: slices of channels
//                                            around her own lines over the last `participation.hours`
//                                            (src/memory/participation.js)
//   data/guilds/<guildId>/diary.json          the persona's diary posts, newest last, one-line gists
//                                            (src/behavior/diary.js); never deleted by code
//   data/guilds/<guildId>/recall-trace.jsonl  one JSON line per recall run when `features.recallTrace` is on
//                                            (appendRecallTrace): the newest `recall.traceMaxLines`, written
//                                            at once, not cached; a wipe deletes it
//   data/guilds/<guildId>/versions/<kind>/<id>.json  the previous texts of the prose fields (see
//                                            `recordVersion`): users/<userId>, channels/<channelId>,
//                                            guild/guild, lore/<key> (src/memory/lore.js#loreVersionKey);
//                                            capped per field, deleted only with their owner
//
// Everything is cached in memory, marked dirty on change and flushed on a
// timer and on shutdown. Writes are atomic (temp file + rename) so a crash
// mid-write never corrupts a profile; when the OS refuses the rename the file
// is written in place instead, with a warning (see writeJsonAtomic).
//
// `forgetUser`, `forgetPrivate`, `removeLore` and `wipeGuild` are the only
// functions in the whole project allowed to delete stored memory (see
// src/admin.js, the owner-only `/nep memory forget`, `/nep private forget`,
// `/nep lore remove` and `/nep memory wipe` commands). A forget also takes the
// member's items out of the voice queue, at once on disk; a wipe deletes the
// queue. Nothing else clears it: the voice run takes out only the items it
// applied, found gone or switched off, or sent down the degraded path (an
// expired or overflowing item), and a stage A batch folds a new brief into the
// queued item of the same target, a newer character item replacing the queued
// one (src/memory/voice.js). An item the queue file holds but that cannot be
// read is left out on load, and logged as a count.
//
// The recent store has a documented retention of its own, applied only when
// `applyRecentOps` writes (src/memory/recent.js#mergeRecent), never on read: a
// line expires `memory.recentHours` after its moment, the storage cap
// (`memory.maxRecentStored`) evicts the lightest, then the oldest when lines are
// added, and the analyzer may remove a line by id. The one number is also the
// view's window, so a hot lowering of `memory.recentHours` deletes the older
// lines at the next write, and raising it again restores none. Apart from that
// only a forget (every line naming the member, written at once) and a wipe (the
// file) remove lines. On load, lines a hand edit broke are left out and logged
// as a count, like the voice queue's items.
//
// The participation store follows the same rules: every `setParticipation`
// runs src/memory/participation.js#expireEpisodes (`participation.hours`, then
// `participation.maxStored`), never a read; a forget takes the member's
// messages out (written at once), a wipe deletes the file.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from '../config.js';
import { log } from '../log.js';
import { utcDay } from '../time.js';
import { emptyAffinity, applyDelta, decayAffinity } from './affinity.js';
import { mergeEpisodes } from './episodes.js';
import { loreVersionKey, upsertLore } from './lore.js';
import { sentenceDiff } from './prose.js';
import { applyInterestOps, attachDropped, normalizeInterests, normalizeTopic } from './interests.js';
import { applyDetailOps, normalizeDetails } from './details.js';
import { applyAliasOps } from './aliases.js';
import { clampText } from './clamp.js';
import { feltLine } from './record.js';
import { sortByRank } from './ranking.js';
import { mergeEmojiUsage, normalizeEmojiUsage } from './emoji-usage.js';
import { emptyGifs, findGif, markOwnGif, mergeGifs, normalizeBackfillStamp, normalizeGifs, resetGifCounts } from './gifs.js';
import { FEELING_CHARS, REASON_CHARS, SELF_CHARS, forgetMember, normalizeQueue } from './voice.js';
import { emptyRecent, mergeRecent, normalizeRecent, purgeRecentFor } from './recent.js';
import { emptyParticipation, expireEpisodes, normalizeParticipation, purgeParticipationFor } from './participation.js';

const DIARY_HISTORY_POSTS = 150; // diary.historyPosts

/** Version history when a writer's caller passes none: `features.versions`, `memory.versionsKept`. */
const DEFAULT_VERSIONS = { enabled: true, kept: 20 };
/** The kinds of version files, one folder each under data/guilds/<id>/versions/. */
const VERSION_KINDS = ['users', 'channels', 'guild', 'lore'];
/** The prose fields of a public profile whose previous text is kept (kind `users`). */
const USER_PROSE = ['character', 'style', 'relationship'];
/** The prose fields of a channel entry (kind `channels`). */
const CHANNEL_PROSE = ['purpose', 'topics', 'tone'];
/** The prose fields of the guild memory (kind `guild`, id `guild`). */
const GUILD_PROSE = ['patterns', 'starters'];

/** The diary of a guild with no post yet (data/guilds/<id>/diary.json). */
const emptyDiary = () => ({ posts: [], updatedAt: 0 });

/**
 * The prefix of an item's `itemId` by kind: the stable identity a stored memory item gets on its
 * first write (`ep-` + a UUID, ...) and keeps, so whatever later leaves the hot files can be told
 * apart and found again. The field is optional: an item written before it existed loads without
 * one and gets it on its next write; no reader requires it. Self facts and in-jokes are stored as
 * plain strings, so they carry no id while stored: the id is minted when one leaves the list.
 */
export const ITEM_ID_PREFIX = Object.freeze({
  episode: 'ep-',
  lesson: 'ln-',
  interest: 'in-',
  detail: 'dt-',
  alias: 'al-',
  selfFact: 'sf-',
  move: 'mv-',
  recent: 'rc-',
  participation: 'pt-',
  diary: 'dy-',
  injoke: 'ij-',
  version: 'vs-',
});

/** Whether `item` already carries an `itemId` (a non-empty string). */
function hasItemId(item) {
  return typeof item?.itemId === 'string' && item.itemId !== '';
}

/**
 * `list` with an `itemId` (`prefix` + `newId()`) on every object item that has none; an item that
 * has one keeps it and stays the same object, anything that is not an object passes through. Pure
 * apart from `newId`; anything but an array -> `[]`.
 * @param {unknown} list
 * @param {string} prefix  One of `ITEM_ID_PREFIX`.
 * @param {() => string} newId
 * @returns {object[]}
 */
function withItemIds(list, prefix, newId) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => (isPlainObject(item) && !hasItemId(item) ? { ...item, itemId: `${prefix}${newId()}` } : item));
}

/**
 * `next` as `withItemIds` stamps it -- unless it equals `previous` as stored (JSON), in which case
 * `previous` comes back untouched: a merge that changed nothing does not rewrite the list just to
 * add ids, so the callers' before/after comparisons (src/memory/update.js counts changed
 * interests and aliases) still see no change.
 * @param {unknown} previous
 * @param {object[]} next
 * @param {string} prefix
 * @param {() => string} newId
 * @returns {object[]}
 */
function changedWithItemIds(previous, next, prefix, newId) {
  if (Array.isArray(previous) && JSON.stringify(previous) === JSON.stringify(next)) return previous;
  return withItemIds(next, prefix, newId);
}

/**
 * Strings leaving a list stored as plain strings (self facts, in-jokes), which have no place to
 * keep an id while stored: each as `{ itemId, text }` with a freshly minted id.
 * @param {string[]} texts
 * @param {string} prefix
 * @param {() => string} newId
 * @returns {Array<{ itemId: string, text: string }>}
 */
function stringItems(texts, prefix, newId) {
  return texts.map((text) => ({ itemId: `${prefix}${newId()}`, text }));
}

/**
 * The strings of `stored` that `next` no longer holds (compared by
 * src/memory/interests.js#normalizeTopic), as `stringItems`.
 * @param {unknown} stored
 * @param {unknown} next
 * @param {string} prefix
 * @param {() => string} newId
 * @returns {Array<{ itemId: string, text: string }>}
 */
function droppedStrings(stored, next, prefix, newId) {
  const held = new Set((Array.isArray(next) ? next : []).filter((text) => typeof text === 'string').map(normalizeTopic));
  const gone = (Array.isArray(stored) ? stored : []).filter((text) => typeof text === 'string' && text.trim() && !held.has(normalizeTopic(text)));
  return stringItems(gone, prefix, newId);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('store: unreadable file, using fallback', { file, error: err });
    return fallback;
  }
}

/** Every `.json` file under `dir`, recursively; never throws on a missing directory. */
function walkJsonFiles(dir) {
  let out = [];
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirEntry of dirEntries) {
    const full = path.join(dir, dirEntry.name);
    if (dirEntry.isDirectory()) {
      out = out.concat(walkJsonFiles(full));
    } else if (dirEntry.isFile() && dirEntry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `*.json` file under `dataDir` that fails to parse as JSON -- used by
 * `/nep resume` (see src/admin.js) to refuse coming back from a pause if
 * a hand-edit broke a file, without touching any cache. Paths are relative to
 * `dataDir`, forward-slash separated (stable across platforms), never file
 * contents.
 * @param {string} dataDir
 * @returns {string[]}
 */
function findInvalidJsonFiles(dataDir) {
  const bad = [];
  for (const file of walkJsonFiles(dataDir)) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      bad.push(path.relative(dataDir, file).split(path.sep).join('/'));
    }
  }
  return bad;
}

/**
 * Write `value` as pretty JSON to `file` through a temp file and a rename, so a
 * crash mid-write never leaves a half-written file; creates missing directories.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(value, null, 2));
}

/** `text` written to `file` the way writeJsonAtomic writes (temp file + rename, in place with a warning). */
function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse to rename over a file an antivirus holds open. The in-place write is
    // not atomic, so it is never silent.
    log.warn('store: rename failed, writing in place', { file, error: err });
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}

/** The fallback cap of the recall trace file (config.json `recall.traceMaxLines`). */
const RECALL_TRACE_MAX_LINES = 500;

/**
 * A member profile nobody has written to yet: what every write starts from (`touchUser`,
 * `applyProfileOps`, ...) and what `getUser` heals a hand-edited file towards.
 * @param {string} id
 * @returns {object}
 */
export function emptyProfile(id) {
  return {
    id,
    names: [],
    firstSeen: null,
    lastSeen: null,
    messageCount: 0,
    character: '',
    interests: [],
    style: '',
    details: [],
    detailsSeq: 1, // the next id an atomic detail item gets -- never reused, even after a remove
    aliases: [], // ranked items { name, weight, firstSeen, lastSeen } -- see src/memory/aliases.js
    relationship: '',
    affinity: emptyAffinity(),
    episodes: [],
    updatedAt: null,
    // `relationshipRewrite`: absent (= false) until the owner flags the relationship text for a
    // forced rewrite (`markRelationshipRewrite`); writing a relationship text removes it.
  };
}

function emptyGuild() {
  return {
    patterns: '',
    starters: '',
    injokes: [],
    self: [],
    learned: [], // things people taught the persona: detail-shaped items plus an optional `from` -- see applyLearnedOps
    learnedNextId: 1, // the next id a learned item gets -- never reused, even after a remove
    emojiUsage: {}, // { [emojiId]: { name, count, last } } -- members' custom emoji uses, see recordEmojiUsage
    emojiBackfill: null, // { at, channels, messages } once src/memory/emoji-backfill.js has read the history
    pingsOff: [], // ids of the members who turned the persona's notifications off (`/nep pings`) -- see setPingsOff
    updatedAt: null,
    notesUpdatedAt: null, // when patterns, starters or injokes last changed -- see updateGuild
    notesCheckedAt: null, // when the analyzer was last asked to look at them again -- see markNotesChecked
    notesFlaggedAt: null, // when the analyzer last flagged them stale -- see markNotesFlagged
    notesSampleReviewedAt: null, // when a sample refresh last reviewed them -- see markNotesSampled
    notesAttemptAt: null, // when a sample refresh last tried and failed -- see markNotesSampled
  };
}

/** The server notes among the guild's fields: a change of one of them moves `notesUpdatedAt`. */
const NOTES_FIELDS = ['patterns', 'starters', 'injokes'];

/** Whether merging `patch` over `target` would change anything stored, compared as it lands on
 * disk (JSON): a write that changes nothing must not be stamped, so `updatedAt` stays honest. */
function changesStored(target, patch) {
  return Object.entries(patch).some(([key, value]) => JSON.stringify(target[key]) !== JSON.stringify(value));
}

/** A stored ISO stamp as it is when it reads as a time, else null (missing, cleared, hand-broken). */
function isoStampOrNull(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

export function emptyChannel(id) {
  return {
    id,
    name: '',
    category: null,
    topic: null,
    purpose: '',
    topics: '',
    tone: '',
    days: {},
    messageCount: 0,
    firstMessageAt: null,
    lastMessageAt: null,
    topWriters: [], // the five best of `writers`, `{ id, count }`, best first -- what readers show
    writers: {}, // { [id]: { count, last } } -- who writes here, see countWriter
    updatedAt: null, // when purpose, topics or tone last changed -- only updateChannel stamps it
    notesCheckedAt: null, // when the analyzer was last asked to look at them again -- see markNotesChecked
    notesFlaggedAt: null, // when the analyzer last flagged them stale -- see markNotesFlagged
    notesSampleReviewedAt: null, // when a sample refresh last reviewed them -- see markNotesSampled
    notesAttemptAt: null, // when a sample refresh last tried and failed -- see markNotesSampled
  };
}

/** Normalize a profile's `interests`/`details`/`aliases` fields in place:
 * stored JSON is untrusted (possibly hand-edited while paused) -- `interests`
 * is validated via src/memory/interests.js#normalizeInterests, `details` via
 * src/memory/details.js#normalizeDetails (assigning fresh ids off the
 * profile's own `detailsSeq` counter when needed), `aliases` becomes `[]`
 * when it is not already an array. Never marks anything dirty -- the caller
 * (`getUser`/`applyProfileOps`) decides whether this is persisted. */
function normalizeProfile(profile) {
  profile.interests = normalizeInterests(profile.interests);

  if (!Number.isInteger(profile.detailsSeq) || profile.detailsSeq < 1) profile.detailsSeq = 1;
  const { items, nextId } = normalizeDetails(profile.details, profile.detailsSeq);
  profile.details = items;
  profile.detailsSeq = nextId;

  if (!Array.isArray(profile.aliases)) profile.aliases = [];
  // Only `true` is the flag; anything else a hand edit left is no flag.
  if ('relationshipRewrite' in profile && profile.relationshipRewrite !== true) delete profile.relationshipRewrite;
}

/**
 * A member's private layer before anything was said in a direct message:
 * no id or names (those live in the public profile), its own affinity
 * starting at 0, the daily DM reply counter and its own observation buffer.
 * @returns {object}
 */
function emptyPrivate() {
  return {
    relationship: '',
    interests: [],
    details: [],
    detailsSeq: 1,
    episodes: [],
    affinity: emptyAffinity(),
    firstSeen: '',
    lastSeen: '',
    replies: { day: '', count: 0, noticedDay: '' },
    buffer: [],
  };
}

/** Normalize a private file in place: `interests`/`details`/`detailsSeq`
 * exactly as `normalizeProfile`, plus the defaults of `emptyPrivate` for
 * every field that is missing or of the wrong type (the file is untrusted,
 * possibly hand-edited while paused). Never marks anything dirty -- same
 * contract as `normalizeProfile`. */
function normalizePrivate(priv) {
  priv.interests = normalizeInterests(priv.interests);

  if (!Number.isInteger(priv.detailsSeq) || priv.detailsSeq < 1) priv.detailsSeq = 1;
  const { items, nextId } = normalizeDetails(priv.details, priv.detailsSeq);
  priv.details = items;
  priv.detailsSeq = nextId;

  if (typeof priv.relationship !== 'string') priv.relationship = '';
  if (!Array.isArray(priv.episodes)) priv.episodes = [];

  const affinity = priv.affinity && typeof priv.affinity === 'object' && !Array.isArray(priv.affinity) ? priv.affinity : {};
  priv.affinity = {
    ...affinity,
    score: Number.isFinite(affinity.score) ? affinity.score : 0,
    reason: typeof affinity.reason === 'string' ? affinity.reason : '',
    history: Array.isArray(affinity.history) ? affinity.history : [],
  };

  for (const key of ['firstSeen', 'lastSeen']) {
    if (typeof priv[key] !== 'string') priv[key] = '';
  }

  const replies = priv.replies && typeof priv.replies === 'object' && !Array.isArray(priv.replies) ? priv.replies : {};
  priv.replies = {
    day: typeof replies.day === 'string' ? replies.day : '',
    count: Number.isInteger(replies.count) && replies.count >= 0 ? replies.count : 0,
    noticedDay: typeof replies.noticedDay === 'string' ? replies.noticedDay : '',
  };

  if (!Array.isArray(priv.buffer)) priv.buffer = [];
}

/** Fields a guild.json may still hold from features the engine no longer has; dropped on read. */
const STALE_GUILD_FIELDS = ['ownLines', 'worn', 'wornLong', 'wornHistory', 'fillers', 'ownMessageCount'];

/** Normalize a guild's `learned`/`learnedNextId`/`emojiUsage`/`emojiBackfill` fields in place: a
 * guild.json written before this list existed loads it as empty, a
 * hand-edited one is validated via src/memory/details.js#normalizeDetails
 * (fresh ids off `learnedNextId` when needed). The two notes stamps
 * (`notesUpdatedAt`, `notesCheckedAt`) are kept when they read as a time and
 * are null otherwise: a guild.json written before them has never been
 * stamped, which readers take as stale notes. The keys in
 * STALE_GUILD_FIELDS are deleted (they reach disk at the next write). Every
 * other field is left exactly as stored; a non-object value is left alone entirely. Never marks
 * anything dirty -- same contract as `normalizeProfile`. */
function normalizeGuild(guild) {
  if (!guild || typeof guild !== 'object' || Array.isArray(guild)) return;
  if (!Number.isInteger(guild.learnedNextId) || guild.learnedNextId < 1) guild.learnedNextId = 1;
  const { items, nextId } = normalizeDetails(guild.learned, guild.learnedNextId);
  guild.learned = items;
  guild.learnedNextId = nextId;
  // Missing or hand-broken -> {} (src/memory/emoji-usage.js#normalizeEmojiUsage).
  guild.emojiUsage = normalizeEmojiUsage(guild.emojiUsage);
  // Missing or hand-broken -> null: the history backfill has not run.
  guild.emojiBackfill = normalizeBackfillStamp(guild.emojiBackfill);
  for (const key of STALE_GUILD_FIELDS) delete guild[key];
  // Missing or hand-broken -> []: nobody turned pings off. Non-empty string ids only, each once.
  guild.pingsOff = Array.isArray(guild.pingsOff) ? [...new Set(guild.pingsOff.filter((id) => typeof id === 'string' && id))] : [];
  // Missing or hand-broken -> null: never stamped.
  guild.notesUpdatedAt = isoStampOrNull(guild.notesUpdatedAt);
  guild.notesCheckedAt = isoStampOrNull(guild.notesCheckedAt);
  guild.notesFlaggedAt = isoStampOrNull(guild.notesFlaggedAt);
  guild.notesSampleReviewedAt = isoStampOrNull(guild.notesSampleReviewedAt);
  guild.notesAttemptAt = isoStampOrNull(guild.notesAttemptAt);
}

/** The `relationshipScore` stamped next to a freshly written `relationship` text: the affinity
 * score at that moment. `opts.relationshipScore` when finite (the analyzer passes the score its
 * batch lands on, after its own delta -- the effective score for the private layer), else the
 * stored score of this file's own affinity, else 0. Missing on an old profile = 0 for readers. */
function relationshipScoreOf(opts, affinity) {
  if (Number.isFinite(opts?.relationshipScore)) return opts.relationshipScore;
  return Number.isFinite(affinity?.score) ? affinity.score : 0;
}

/**
 * Write a `relationship` text onto a public profile or a private layer, in place, with its two
 * stamps -- the one writer of that field for `applyProfileOps` and `applyPrivateOps`. Only a
 * non-empty string is written (an absent or blank one never blanks the stored text). A first write
 * (the stored text is empty) is clamped to `opts.relationshipChars` (`relationships.textChars`),
 * else `opts.fieldChars`; a rewrite is stored as given, never cut (`firstWriteText`). Stamped next to
 * it: `relationshipScore` (see `relationshipScoreOf`) and `relationshipWrittenAt`, the ISO time of
 * `opts.now` (else the wall clock) -- the clock the batch's attitude moves are stamped with
 * (src/memory/affinity.js#applyDelta), so src/memory/affinity.js#relationshipStaleOf counts the
 * moves since the text like with like. A profile written before the stamp existed keeps none
 * until its next text. A written text removes the forced-rewrite flag (`relationshipRewrite`,
 * see `markRelationshipRewrite`): the rewrite it asked for has happened.
 * @param {object} target  A normalised profile or private layer.
 * @param {unknown} text
 * @param {object} opts    As for `applyProfileOps`.
 * @param {(previous: unknown, next: string) => void} [onWrite]  Called with the stored text and the
 *   one replacing it, before the write (the public profile records a version through it).
 */
function writeRelationship(target, text, opts, onWrite) {
  if (typeof text !== 'string' || !text.trim()) return;
  const next = firstWriteText(target.relationship, text, opts.relationshipChars ?? opts.fieldChars, opts.clampTolerance);
  onWrite?.(target.relationship, next);
  target.relationship = next;
  target.relationshipScore = relationshipScoreOf(opts, target.affinity);
  target.relationshipWrittenAt = new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString();
  delete target.relationshipRewrite;
}

/**
 * The text a prose writer stores: a first write (`previous` empty, nothing to lose yet) is
 * clamped to `limit` as before; a rewrite is only trimmed, never cut. A rewrite over its limit is
 * the caller's to refuse (src/memory/prose.js#acceptProse) -- the store never shortens one.
 * @param {unknown} previous  The stored text.
 * @param {string} text       A non-blank string.
 * @param {number} limit
 * @param {number} [tolerance]
 * @returns {string}
 */
function firstWriteText(previous, text, limit, tolerance) {
  const first = typeof previous !== 'string' || previous.trim() === '';
  return first ? clampText(text, limit, { tolerance }) : text.trim();
}

/** The sighting time of one profile/private batch: `opts.seenAt`, else `opts.now`, else the wall clock. */
function seenAtOf(opts) {
  if (Number.isFinite(opts?.seenAt)) return opts.seenAt;
  return Number.isFinite(opts?.now) ? opts.now : Date.now();
}

/**
 * Apply `ops.interests` (src/memory/interests.js#applyInterestOps) and `ops.details`
 * (src/memory/details.js#applyDetailOps, advancing `target.detailsSeq`) to a public profile
 * or a private layer, in place -- the item blocks `applyProfileOps` and `applyPrivateOps`
 * share. Only the ops-object shape is taken; anything else changes nothing. Every item of a list
 * the ops changed gets an `itemId` when it has none (`changedWithItemIds`), and so does every
 * item that left.
 * @param {object} target  A normalised profile or private layer.
 * @param {object} ops
 * @param {object} opts    As for `applyProfileOps`.
 * @param {number} seenAt
 * @param {() => string} newId
 * @returns {{ interests: object[], details: object[] }}  The stored items that left (removed,
 *   folded into another, evicted).
 */
function applyItemOps(target, ops, opts, seenAt, newId) {
  const dropped = { interests: [], details: [] };
  if (isPlainObject(ops?.interests)) {
    const interests = applyInterestOps(target.interests, ops.interests, {
      maxInterests: opts.maxInterests,
      maxInterestsStored: opts.maxInterestsStored,
      topicChars: opts.topicChars,
      noteChars: opts.noteChars,
      confirmGapHours: opts.confirmGapHours,
      halfLifeDays: opts.interestHalfLifeDays,
      clampTolerance: opts.clampTolerance,
      seenAt,
    });
    target.interests = changedWithItemIds(target.interests, interests, ITEM_ID_PREFIX.interest, newId);
    dropped.interests = withItemIds(interests.dropped, ITEM_ID_PREFIX.interest, newId);
  }
  if (isPlainObject(ops?.details)) {
    const { items, nextId, dropped: gone } = applyDetailOps(target.details, ops.details, {
      maxDetails: opts.maxDetails,
      maxDetailsStored: opts.maxDetailsStored,
      fieldChars: opts.fieldChars,
      confirmGapHours: opts.confirmGapHours,
      halfLifeDays: opts.detailHalfLifeDays,
      clampTolerance: opts.clampTolerance,
      seenAt,
      nextId: target.detailsSeq,
    });
    target.details = changedWithItemIds(target.details, items, ITEM_ID_PREFIX.detail, newId);
    target.detailsSeq = nextId;
    dropped.details = withItemIds(gone, ITEM_ID_PREFIX.detail, newId);
  }
  return dropped;
}

/** Keep only the newest `max` UTC-date keys of a `days` counter map. */
function trimDays(days, max) {
  const keys = Object.keys(days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete days[key];
}

/**
 * `buffer` without the entries one finished analyzer batch consumed, in place. A batch is taken
 * off the front, but the buffer keeps moving while the call is in flight: new messages are
 * appended and the capped buffer trims its oldest entries, so a count would drop the wrong
 * ones. An entry goes when its `id` is one of the consumed ids; an entry without an id goes
 * when it sits at or before the last consumed entry still buffered (found by id, or by
 * reference for one without an id). Everything else stays.
 * @param {object[]} buffer    Mutated.
 * @param {object[]} consumed  The batch's messages.
 */
function dropConsumed(buffer, consumed) {
  const batch = Array.isArray(consumed) ? consumed : [];
  const hasId = (message) => message?.id !== undefined && message?.id !== null;
  const ids = new Set(batch.filter(hasId).map((message) => String(message.id)));
  const isConsumed = (message) => (hasId(message) ? ids.has(String(message.id)) : batch.includes(message));
  let last = -1;
  buffer.forEach((message, i) => {
    if (isConsumed(message)) last = i;
  });
  const kept = buffer.filter((message, i) => (hasId(message) ? !ids.has(String(message.id)) : i > last));
  buffer.splice(0, buffer.length, ...kept);
}

// ---- who writes in a channel: the `writers` tally behind `topWriters` ----
//
// A channel entry keeps `writers: { [id]: { count, last } }` for more writers than it shows, and
// `topWriters` is the best five of it. Rank is the shared one of src/memory/ranking.js: `count` is
// the weight, `last` (the ts of the writer's latest message) drives the decay, so a newcomer
// gathers a count below the five shown and passes a writer who went silent. A list of five that
// drops whoever is sixth can never change again.

const TOP_WRITERS = 5; // how many writers `topWriters` shows
const WRITERS_STORED = 20; // config.json's memory.channelWritersStored
const WRITERS_HALF_LIFE_DAYS = 30; // config.json's memory.channelWritersHalfLifeDays
const MAX_DATE_MS = 8.64e15; // the last instant a Date can hold

/** `value` as the time of a message: a positive epoch ms a Date can hold, else 0 (unknown). */
function writerTs(value) {
  return Number.isFinite(value) && value > 0 && value <= MAX_DATE_MS ? value : 0;
}

/** `value` as a count of messages: a whole number of at least 1, else 0. */
function writerCount(value) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0;
}

/**
 * The tally settings of one `touchChannel` call, from the `config.memory` keys of the same name
 * (the caller reads them at the moment of use): `stored` = `channelWritersStored`, never fewer
 * than the five shown, and `halfLifeDays` = `channelWritersHalfLifeDays` (0 or less = no decay,
 * the count alone ranks). A missing key, or one that is not a number, is config.json's value.
 * @param {{ channelWritersStored?: number, channelWritersHalfLifeDays?: number }} [opts]
 * @returns {{ stored: number, halfLifeDays: number }}
 */
function writersSettings(opts) {
  const stored = opts?.channelWritersStored ?? WRITERS_STORED;
  const halfLifeDays = opts?.channelWritersHalfLifeDays ?? WRITERS_HALF_LIFE_DAYS;
  return {
    stored: Math.max(TOP_WRITERS, Number.isFinite(stored) ? Math.floor(stored) : WRITERS_STORED),
    halfLifeDays: Number.isFinite(halfLifeDays) ? halfLifeDays : WRITERS_HALF_LIFE_DAYS,
  };
}

/**
 * A stored `writers` tally made safe to read: an entry without a count of at least 1 is dropped,
 * a `last` that is no time becomes 0. Never mutates `value`.
 * @param {object} value  A plain object.
 * @returns {Record<string, { count: number, last: number }>}
 */
function normalizeWriters(value) {
  const out = {};
  for (const [id, entry] of Object.entries(value)) {
    const count = isPlainObject(entry) ? writerCount(entry.count) : 0;
    if (!id || count < 1) continue;
    out[id] = { count, last: writerTs(entry.last) };
  }
  return out;
}

/**
 * The tally a `topWriters` list (`{ id, count }[]`, best first) stands for, every writer dated
 * `last` -- the newest message of the window the list was counted from (`setChannelFacts`), or
 * the channel's `lastMessageAt` for an entry stored before the tally existed. Items without an id
 * or a count of at least 1 are skipped. The first listed is inserted last, so writers of an equal
 * count keep their listed order at the next ranking (see `sortByRank`'s tie rule).
 * @param {unknown} topWriters
 * @param {unknown} last
 * @returns {Record<string, { count: number, last: number }>}
 */
function writersFromTop(topWriters, last) {
  const out = {};
  for (const writer of [...(Array.isArray(topWriters) ? topWriters : [])].reverse()) {
    const id = writer?.id === undefined || writer?.id === null ? '' : String(writer.id);
    const count = writerCount(writer?.count);
    if (!id || count < 1) continue;
    out[id] = { count, last: writerTs(last) };
  }
  return out;
}

/**
 * `writers` as `[{ id, count, last }]`, best first (src/memory/ranking.js#sortByRank: `count` is
 * the weight, `last` the date; ties go to the later message, then to the writer counted last).
 * @param {Record<string, { count: number, last: number }>} writers  A normalised tally.
 * @param {number} halfLifeDays
 * @returns {{ id: string, count: number, last: number }[]}
 */
function rankWriters(writers, halfLifeDays) {
  const items = Object.entries(writers).map(([id, entry]) => ({
    id,
    ...entry,
    weight: entry.count,
    lastSeen: entry.last > 0 ? new Date(entry.last).toISOString() : null,
  }));
  return sortByRank(items, halfLifeDays).map(({ id, count, last }) => ({ id, count, last }));
}

/**
 * Count one message of `authorId` at `ts` into a channel's tally -- used by `touchChannel` (live
 * traffic, one message at a time); ids compared as strings. `last` only moves forward (a message
 * that arrives late is counted and dates nothing). Past `stored` writers the lowest-ranked leave
 * and lose their count. Never mutates `writers`.
 * @param {Record<string, { count: number, last: number }>} writers  A normalised tally.
 * @param {string} authorId
 * @param {number} ts
 * @param {{ stored: number, halfLifeDays: number }} settings  See `writersSettings`.
 * @returns {{ writers: Record<string, { count: number, last: number }>,
 *   topWriters: { id: string, count: number }[] }}  The new tally and its best five, best first.
 */
function countWriter(writers, authorId, ts, { stored, halfLifeDays }) {
  const id = String(authorId);
  const next = { ...writers };
  const before = next[id];
  // Re-inserted so the writer just counted sits last: an exact rank tie keeps them (see sortByRank).
  delete next[id];
  next[id] = { count: (before?.count ?? 0) + 1, last: Math.max(before?.last ?? 0, writerTs(ts)) };
  const ranked = rankWriters(next, halfLifeDays);
  for (const evicted of ranked.slice(stored)) delete next[evicted.id];
  return { writers: next, topWriters: ranked.slice(0, TOP_WRITERS).map((writer) => ({ id: writer.id, count: writer.count })) };
}

/**
 * Normalize a channel entry in place: stored JSON is untrusted (possibly hand-edited while
 * paused, or written before a field existed). `writers` is validated (`normalizeWriters`); an
 * entry without a tally gets one seeded from its stored `topWriters`, dated its `lastMessageAt`
 * (`writersFromTop`), so the five it already shows keep their counts. `notesCheckedAt` is kept
 * when it reads as a time and is null otherwise (never re-checked, which readers take as stale
 * notes). Every other field, `topWriters` included, is left exactly as stored; a non-object
 * value is left alone entirely. Never marks anything dirty -- same contract as
 * `normalizeProfile`.
 */
function normalizeChannel(channel) {
  if (!isPlainObject(channel)) return;
  channel.writers = isPlainObject(channel.writers) ? normalizeWriters(channel.writers) : writersFromTop(channel.topWriters, channel.lastMessageAt);
  channel.notesCheckedAt = isoStampOrNull(channel.notesCheckedAt);
  channel.notesFlaggedAt = isoStampOrNull(channel.notesFlaggedAt);
  channel.notesSampleReviewedAt = isoStampOrNull(channel.notesSampleReviewedAt);
  channel.notesAttemptAt = isoStampOrNull(channel.notesAttemptAt);
}

/**
 * The store over one data directory.
 * @param {{ dataDir: string, newId?: () => string, record?: { append: Function }|null,
 *   recordOn?: () => boolean }} options  `newId`: the source of the UUID in every new `itemId`
 *   (`ITEM_ID_PREFIX`); node:crypto's `randomUUID` unless a test injects one. `record`
 *   (src/memory/record.js#createRecord, optional): while `recordOn()` (read at each write;
 *   src/index.js passes features.record exactly true) every feeling stored on an episode -- with
 *   the episode (`addEpisodes` / `addPrivateEpisodes`) or later (`fillEpisodeFeeling`) -- is
 *   appended to it as a `felt` line, in the background (a refused append is logged, counts only).
 */
export function createStore({ dataDir, newId = randomUUID, record = null, recordOn = () => Boolean(record) }) {
  const entries = new Map(); // file path -> { value, dirty }

  /**
   * A `felt` line (src/memory/record.js#feltLine) for each of `episodes` that holds a feeling,
   * appended to the record of `guildId` (the member's private record for the private layer).
   * Not awaited: the store's writers stay synchronous; a refused append is logged.
   */
  function recordFelt(guildId, userId, layer, episodes) {
    if (!record || !recordOn()) return;
    const lines = episodes
      .filter((ep) => isPlainObject(ep) && typeof ep.feeling === 'string' && ep.feeling)
      .map((ep) =>
        feltLine(
          {
            userId: String(userId),
            itemId: ep.itemId ?? null,
            text: ep.feeling,
            date: ep.date ?? null,
            sourceMessageIds: Array.isArray(ep.sourceMessageIds) ? ep.sourceMessageIds : [],
          },
          { uuid: newId },
        ),
      );
    if (lines.length === 0) return;
    const failed = (error) => log.warn('store: record failed', { kind: 'felt', guildId: String(guildId), lines: lines.length, code: error?.code ?? null });
    try {
      Promise.resolve(record.append(guildId, lines, layer === 'private' ? { privateUserId: String(userId) } : {})).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  function entry(file, fallback) {
    let item = entries.get(file);
    if (!item) {
      item = { value: readJson(file, fallback()), dirty: false };
      entries.set(file, item);
    }
    return item;
  }

  /** Every id found under `dir`'s `.json` files, on disk or only cached (no side effects on the cache). */
  function idsUnder(dir) {
    const ids = new Set();
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.json')) ids.add(name.slice(0, -5));
      }
    } catch {
      // the directory does not exist yet
    }
    const prefix = dir + path.sep;
    for (const file of entries.keys()) {
      if (file.startsWith(prefix)) ids.add(path.basename(file, '.json'));
    }
    return [...ids];
  }

  /** Write one dirty cache entry to disk; a failed write is logged and stays dirty for the next flush. */
  function flushEntry(file, item) {
    if (!item.dirty) return;
    try {
      writeJsonAtomic(file, item.value);
      item.dirty = false;
    } catch (err) {
      log.error('store: flush failed', { file, error: err });
    }
  }

  function flushAll() {
    for (const [file, item] of entries) flushEntry(file, item);
  }

  const guildDir = (guildId) => path.join(dataDir, 'guilds', String(guildId));
  const usersDir = (guildId) => path.join(guildDir(guildId), 'users');
  const userFile = (guildId, userId) => path.join(usersDir(guildId), `${userId}.json`);
  const guildFile = (guildId) => path.join(guildDir(guildId), 'guild.json');
  const bufferFile = (guildId) => path.join(guildDir(guildId), 'buffer.json');
  const channelsDir = (guildId) => path.join(guildDir(guildId), 'channels');
  const channelFile = (guildId, channelId) => path.join(channelsDir(guildId), `${channelId}.json`);
  const mediaCacheFile = (guildId) => path.join(guildDir(guildId), 'media.json');
  const loreFile = (guildId) => path.join(guildDir(guildId), 'lore.json');
  const gifsFile = (guildId) => path.join(guildDir(guildId), 'gifs.json');
  const privateDir = (guildId) => path.join(guildDir(guildId), 'private');
  const privateFile = (guildId, userId) => path.join(privateDir(guildId), `${userId}.json`);
  const voiceFile = (guildId) => path.join(guildDir(guildId), 'voice.json');
  const recentFile = (guildId) => path.join(guildDir(guildId), 'recent.json');
  const participationFile = (guildId) => path.join(guildDir(guildId), 'participation.json');
  const diaryFile = (guildId) => path.join(guildDir(guildId), 'diary.json');
  const recallTraceFile = (guildId) => path.join(guildDir(guildId), 'recall-trace.jsonl');
  const versionsDir = (guildId) => path.join(guildDir(guildId), 'versions');
  /** A lore id is the entry's title, turned into a safe file name (src/memory/lore.js#loreVersionKey). */
  const versionsFile = (guildId, kind, id) =>
    path.join(versionsDir(guildId), kind, `${kind === 'lore' ? loreVersionKey(id) : String(id)}.json`);
  const stateFile = path.join(dataDir, 'state.json');

  const stateEntry = entry(stateFile, () => ({}));

  /** The cache entry of a member's private file, created empty when missing, normalised. A file
   * that parses to something other than an object (null, an array, a string -- a hand edit gone
   * wrong) is replaced by the empty shape in the cache, so the private pass never stalls on it;
   * the disk copy is only rewritten by the next change, like any other entry. */
  function privateEntry(guildId, userId) {
    const item = entry(privateFile(guildId, userId), emptyPrivate);
    if (!item.value || typeof item.value !== 'object' || Array.isArray(item.value)) {
      log.warn('store: private file replaced', { guildId, reason: 'malformed' });
      item.value = emptyPrivate();
    }
    normalizePrivate(item.value);
    return item;
  }

  /** The cache entry of one channel of the server map, created empty when missing, normalised in
   * place (`normalizeChannel`); never marked dirty by reading, so a tally seeded for an old file
   * is written only by the next change. */
  function channelEntry(guildId, channelId) {
    const item = entry(channelFile(guildId, channelId), () => emptyChannel(String(channelId)));
    normalizeChannel(item.value);
    return item;
  }

  /** The cache entry of one version file, `{}` when missing; a file that is not an object (a
   * hand edit gone wrong) reads as `{}` in the cache. Never marked dirty by reading. */
  function versionsEntry(guildId, kind, id) {
    const item = entry(versionsFile(guildId, kind, id), () => ({}));
    if (!isPlainObject(item.value)) item.value = {};
    return item;
  }

  /**
   * Keep the previous text of one prose field before a writer replaces it:
   * appended to data/guilds/<guildId>/versions/<kind>/<id>.json under `field` as
   * `{ at, by, chars, before, after, kept, removed, added, text }` -- `text` the
   * replaced text, `chars` its length in code points, the counts from
   * src/memory/prose.js#sentenceDiff(previous, next), `at` the ISO time of
   * `opts.now` (else the wall clock), `by` = `opts.by` (else `'unknown'`). Newest last;
   * past `opts.versions.kept` per field the oldest go. Nothing is recorded when the
   * previous text is blank, when it equals the next, or when `opts.versions.enabled`
   * is false. `opts.versions` omitted -> `DEFAULT_VERSIONS` (config.json's values).
   * @param {string} guildId
   * @param {'users'|'channels'|'guild'|'lore'} kind
   * @param {string} id
   * @param {string} field
   * @param {unknown} previous
   * @param {unknown} next
   * @param {{ by?: string, now?: number, versions?: { enabled?: boolean, kept?: number } }} [opts]
   * @returns {{ dropped: object[] }}  Every entry of the field's list gets an `itemId` when it has
   *   none (`vs-`); `dropped`: the entries that fell past `kept`, oldest first, with theirs.
   */
  function recordVersion(guildId, kind, id, field, previous, next, opts = {}) {
    const settings = opts.versions ?? DEFAULT_VERSIONS;
    if (settings.enabled === false) return { dropped: [] };
    if (typeof previous !== 'string' || !previous.trim() || typeof next !== 'string' || previous === next) return { dropped: [] };
    const kept = Number.isFinite(settings.kept) ? Math.max(0, Math.floor(settings.kept)) : DEFAULT_VERSIONS.kept;
    if (kept === 0) return { dropped: [] };
    const item = versionsEntry(guildId, kind, id);
    const diff = sentenceDiff(previous, next);
    const by = typeof opts.by === 'string' && opts.by.trim() ? opts.by.trim() : 'unknown';
    const at = new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString();
    const chars = [...previous].length;
    const list = Array.isArray(item.value[field]) ? item.value[field] : [];
    const all = withItemIds([...list, { at, by, chars, ...diff, text: previous }], ITEM_ID_PREFIX.version, newId);
    item.value[field] = all.slice(-kept);
    const dropped = all.slice(0, all.length - item.value[field].length);
    item.dirty = true;
    log.info('store: version recorded', {
      guildId,
      kind,
      ...(kind === 'channels' ? { channelId: String(id) } : {}),
      field,
      by,
      chars,
      kept: diff.kept,
      removed: diff.removed,
      added: diff.added,
    });
    return { dropped };
  }

  /**
   * Merge `incoming` episodes into a member file's list (src/memory/episodes.js#mergeEpisodes) and
   * write it when one was added, every stored episode with an `itemId` (`withItemIds`).
   * @param {{ value: object, dirty: boolean }} item  A profile or private layer's cache entry.
   * @param {unknown} incoming
   * @param {object} opts
   * @param {{ guildId: string, userId: string, layer?: 'private' }} [owner]  Whose episodes: the
   *   feelings of the newly stored ones go to the record (recordFelt).
   * @returns {{ added: number, dropped: object[] }}  `dropped`: the evicted episodes, each with an itemId.
   */
  function mergeEpisodesInto(item, incoming, opts, owner = null) {
    const before = new Set(Array.isArray(item.value.episodes) ? item.value.episodes : []);
    const { episodes, added, dropped } = mergeEpisodes(item.value.episodes, incoming, opts);
    if (added > 0) {
      const stamped = withItemIds(episodes, ITEM_ID_PREFIX.episode, newId);
      item.value.episodes = stamped;
      item.dirty = true;
      if (owner) recordFelt(owner.guildId, owner.userId, owner.layer, stamped.filter((_, i) => !before.has(episodes[i])));
    }
    return { added, dropped: withItemIds(dropped, ITEM_ID_PREFIX.episode, newId) };
  }

  /**
   * src/memory/affinity.js#applyDelta, with an `itemId` on every history move of a new affinity
   * and on its non-enumerable `droppedMoves`; an unchanged affinity comes back as it is.
   */
  function applyDeltaWithIds(affinity, delta, reason, opts) {
    const next = applyDelta(affinity, delta, reason, opts);
    if (!Array.isArray(next.droppedMoves)) return next;
    const stamped = { ...next, history: withItemIds(next.history, ITEM_ID_PREFIX.move, newId) };
    return attachDropped(stamped, 'droppedMoves', withItemIds(next.droppedMoves, ITEM_ID_PREFIX.move, newId));
  }

  /** Whether a channel has an entry, cached or on disk (no side effects on the cache). */
  function hasChannel(guildId, channelId) {
    const file = channelFile(guildId, channelId);
    return entries.has(file) || fs.existsSync(file);
  }

  /** The cache entry of a guild's GIF library, created empty when missing, normalised in place of
   * the cached value (src/memory/gifs.js#normalizeGifs); never marked dirty by reading. */
  function gifsEntry(guildId) {
    const item = entry(gifsFile(guildId), emptyGifs);
    item.value = normalizeGifs(item.value);
    return item;
  }

  /** Whether a member has a private file, cached or on disk (no side effects on the cache). */
  function hasPrivate(guildId, userId) {
    const file = privateFile(guildId, userId);
    return entries.has(file) || fs.existsSync(file);
  }

  /** The cache entry a voice text about one member lands in: their public profile (`layer`
   * omitted, undefined or null) or their private layer (exactly `'private'`), normalised; null
   * when that file does not exist (nothing is created) or the layer is any other value (`'public'`,
   * `'Private'`, `'dm'`...): a text meant for one layer never falls back to the public profile. */
  function memberEntry(guildId, userId, layer) {
    if (layer === 'private') return hasPrivate(guildId, userId) ? privateEntry(guildId, userId) : null;
    if (layer !== undefined && layer !== null) return null;
    return store.getUser(guildId, userId) ? entries.get(userFile(guildId, userId)) : null;
  }

  /** The cache entry of a guild's voice queue, `[]` when nothing is queued, normalised in place of
   * the cached value (src/memory/voice.js#normalizeQueue); never marked dirty by reading. A file
   * that cannot be parsed reads as `[]` with a warning (`readJson`), like every other file. On the
   * read that loads the file, items normalising leaves out (a hand edit, a file from another
   * version) are logged as a count, `store: voice items dropped`, and a value that is not a list
   * as `store: voice queue replaced`: the next queue write makes the loss permanent. */
  function voiceEntry(guildId) {
    const file = voiceFile(guildId);
    const loading = !entries.has(file);
    const item = entry(file, () => []);
    const raw = item.value;
    item.value = normalizeQueue(raw);
    if (loading && !Array.isArray(raw)) {
      log.warn('store: voice queue replaced', { guildId, reason: 'malformed' });
    } else if (loading && raw.length > item.value.length) {
      log.warn('store: voice items dropped', { guildId, dropped: raw.length - item.value.length });
    }
    return item;
  }

  /** Store `next`, normalised, as the guild's queue: the value cached is parsed from the JSON the
   * flush will write, so it shares nothing with what the caller holds and equals what a restart
   * reads back. Dirty only when something changed.
   * @throws {TypeError} `next` cannot be written as JSON (a cycle, a BigInt): nothing changes. */
  function writeQueue(item, next) {
    const queue = normalizeQueue(JSON.parse(JSON.stringify(next)));
    if (JSON.stringify(queue) === JSON.stringify(item.value)) return;
    item.value = queue;
    item.dirty = true;
  }

  /** Take what a guild's voice queue holds about one member out of it
   * (src/memory/voice.js#forgetMember; `{ layer: 'private' }` = their private items only) and
   * write the file at once, like the files a forget deletes. No queue -> nothing, no file
   * created. Returns how many items were removed. */
  function forgetQueued(guildId, userId, opts) {
    const file = voiceFile(guildId);
    if (!entries.has(file) && !fs.existsSync(file)) return 0;
    const item = voiceEntry(guildId);
    const { queue, removed } = forgetMember(item.value, userId, opts);
    if (removed === 0) return 0;
    item.value = queue;
    item.dirty = true;
    flushEntry(file, item);
    return removed;
  }

  /** The cache entry of a guild's recent store, the empty store when there is no file, normalised
   * in place of the cached value (src/memory/recent.js#normalizeRecent); never marked dirty by
   * reading, so a healed hand edit is written only by the next change. On the read that loads the
   * file, lines normalising leaves out (a hand edit, a file from another version) are logged as a
   * count, `store: recent lines dropped`, and a value that is not a store (not an object, or
   * `lines` not a list) as `store: recent store replaced`: the next write makes the loss
   * permanent. An unparsable file reads as empty with `readJson`'s warning. */
  function recentEntry(guildId) {
    const file = recentFile(guildId);
    const loading = !entries.has(file);
    const item = entry(file, emptyRecent);
    const raw = item.value;
    item.value = normalizeRecent(raw);
    if (loading && (!isPlainObject(raw) || !Array.isArray(raw.lines))) {
      log.warn('store: recent store replaced', { guildId, reason: 'malformed' });
    } else if (loading && raw.lines.length > item.value.lines.length) {
      log.warn('store: recent lines dropped', { guildId, dropped: raw.lines.length - item.value.lines.length });
    }
    return item;
  }

  /** The cache entry of a guild's participation store, the empty store when there is no file,
   * normalised in place of the cached value (src/memory/participation.js#normalizeParticipation);
   * never marked dirty by reading. On the read that loads the file, episodes normalising leaves out
   * are logged as a count, `store: participation episodes dropped`, and a value that is not a store
   * (not an object, or `episodes` not a list) as `store: participation store replaced`. An
   * unparsable file reads as empty with `readJson`'s warning. */
  function participationEntry(guildId) {
    const file = participationFile(guildId);
    const loading = !entries.has(file);
    const item = entry(file, emptyParticipation);
    const raw = item.value;
    item.value = normalizeParticipation(raw);
    if (loading && (!isPlainObject(raw) || !Array.isArray(raw.episodes))) {
      log.warn('store: participation store replaced', { guildId, reason: 'malformed' });
    } else if (loading && raw.episodes.length > item.value.episodes.length) {
      log.warn('store: participation episodes dropped', { guildId, dropped: raw.episodes.length - item.value.episodes.length });
    }
    return item;
  }

  /** Take one member's messages out of the guild's participation store
   * (src/memory/participation.js#purgeParticipationFor; an episode left without a line of the
   * persona goes too) and write the file at once, like the files a forget deletes. No store ->
   * nothing, no file created. Returns how many messages were removed. */
  function forgetParticipation(guildId, userId) {
    const file = participationFile(guildId);
    if (!entries.has(file) && !fs.existsSync(file)) return 0;
    const item = participationEntry(guildId);
    const before = item.value.episodes.length;
    const { value, removed } = purgeParticipationFor(item.value, userId);
    if (removed === 0 && value.episodes.length === before) return 0;
    item.value = value;
    item.dirty = true;
    flushEntry(file, item);
    return removed;
  }

  /** The cache entry of a guild's diary, the empty diary when there is no file; a value that is not
   * a diary (not an object, or `posts` not a list) is replaced by the empty one in the cache, and
   * the disk copy is only rewritten by the next change. */
  function diaryEntry(guildId) {
    const item = entry(diaryFile(guildId), emptyDiary);
    if (!isPlainObject(item.value) || !Array.isArray(item.value.posts)) item.value = emptyDiary();
    return item;
  }

  /** Store `posts` (the newest `max`) as the guild's diary, stamped `now`, and mark it dirty. Every
   * post gets an `itemId` when it has none (`dy-`); returns `{ dropped }`, the posts that fell past
   * `max`, oldest first, with theirs. */
  function writeDiary(guildId, posts, { max, now } = {}) {
    const item = diaryEntry(guildId);
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DIARY_HISTORY_POSTS;
    const all = withItemIds(posts, ITEM_ID_PREFIX.diary, newId);
    const kept = all.slice(-limit);
    item.value = { posts: kept, updatedAt: Number.isFinite(now) ? now : Date.now() };
    item.dirty = true;
    return { dropped: all.slice(0, all.length - kept.length) };
  }

  /** Take every recent line that names one member out of the guild's recent store
   * (src/memory/recent.js#purgeRecentFor: their token, or one of `names` as a whole word) and
   * write the file at once, like the files a forget deletes. No store -> nothing, no file
   * created. Returns how many lines were removed. */
  function forgetRecent(guildId, userId, names) {
    const file = recentFile(guildId);
    if (!entries.has(file) && !fs.existsSync(file)) return 0;
    const item = recentEntry(guildId);
    const { value, removed } = purgeRecentFor(item.value, userId, names);
    if (removed === 0) return 0;
    item.value = value;
    item.dirty = true;
    flushEntry(file, item);
    return removed;
  }

  const store = {
    state: {
      get data() {
        return stateEntry.value;
      },
      markDirty() {
        stateEntry.dirty = true;
      },
    },

    /**
     * Profile of a member, or null when the persona has never seen them.
     * Stored JSON is normalised on read here (see `normalizeProfile` above,
     * which tolerates a hand-edited file) -- persisted the next time
     * anything writes this profile, never wiped implicitly.
     */
    getUser(guildId, userId) {
      const file = userFile(guildId, userId);
      if (!entries.has(file) && !fs.existsSync(file)) return null;
      const item = entry(file, () => emptyProfile(String(userId)));
      normalizeProfile(item.value);
      return item.value;
    },

    /**
     * Record that a member spoke: names, counters, timestamps. Creates the
     * profile. Messages do not always arrive in chronological order (the
     * memory warmup, src/memory/warmup.js, can feed months of history
     * after the live pipeline already touched a profile today) -- `firstSeen`/`lastSeen` are therefore
     * min/max'd against `at`, never just overwritten, so a late/backdated
     * touch can only widen the known range, never regress `lastSeen` to an
     * older message. `names`' order is meant to read "most recent display
     * name first": a name is moved to the front only when `at` is at least as
     * new as the CURRENT `lastSeen` (before this touch updates it) -- an
     * older/backdated touch never displaces the current name from index 0; an
     * unseen name from such a touch is appended at the end instead.
     */
    touchUser(guildId, userId, name, at = Date.now()) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const profile = item.value;

      const priorFirstSeenMs = profile.firstSeen ? Date.parse(profile.firstSeen) : NaN;
      const priorLastSeenMs = profile.lastSeen ? Date.parse(profile.lastSeen) : NaN;
      const isNewest = !Number.isFinite(priorLastSeenMs) || at >= priorLastSeenMs;

      if (name) {
        if (isNewest) {
          profile.names = [name, ...profile.names.filter((n) => n !== name)].slice(0, 5);
        } else if (!profile.names.includes(name)) {
          profile.names = [...profile.names, name].slice(0, 5);
        }
      }

      if (!Number.isFinite(priorFirstSeenMs) || at < priorFirstSeenMs) {
        profile.firstSeen = new Date(at).toISOString();
      }
      if (!Number.isFinite(priorLastSeenMs) || at > priorLastSeenMs) {
        profile.lastSeen = new Date(at).toISOString();
      }
      profile.messageCount += 1;
      item.dirty = true;
      return profile;
    },

    /**
     * Merge LLM-extracted fields into a profile. `affinity` is never taken
     * from here — it only ever changes through `adjustAffinity`, which keeps
     * its clamping and history bookkeeping in one place. `episodes` likewise
     * only ever changes through `addEpisodes` (src/memory/episodes.js), which
     * appends and evicts instead of overwriting. `interests`/`details`
     * likewise only ever change through `applyProfileOps` below, which merges
     * incrementally instead of overwriting wholesale. A changed `character`/`style`/
     * `relationship` keeps its previous text (`recordVersion`; `opts.by`, `opts.versions`).
     * @param {{ by?: string, versions?: { enabled?: boolean, kept?: number } }} [opts]
     */
    updateUser(guildId, userId, fields, opts = {}) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const { affinity, episodes, interests, details, detailsSeq, ...safeFields } = fields ?? {};
      for (const key of USER_PROSE) {
        if (key in safeFields) recordVersion(guildId, 'users', userId, key, item.value[key], safeFields[key], opts);
      }
      Object.assign(item.value, safeFields, { updatedAt: new Date().toISOString() });
      item.dirty = true;
      return item.value;
    },

    /**
     * Apply one analyzer batch's INCREMENTAL profile update (see
     * docs/prompt-contract.md, "The analyzer"): `character`/`style`/
     * `relationship` replace the stored text only when given as a non-empty
     * string, clamped to `opts.fieldChars` (`relationship` to
     * `opts.relationshipChars` when given) -- an absent or empty field never
     * blanks what is already stored. `ops.interests` (`{ add, update, seen,
     * remove }`) merges via src/memory/interests.js#applyInterestOps;
     * `ops.details` (`{ add, seen, remove }`) merges via
     * src/memory/details.js#applyDetailOps, which also advances the
     * profile's own `detailsSeq` id counter. `opts.seenAt` is the time of the
     * PERSON'S message that produced this sighting (falls back to `opts.now`,
     * then the wall clock) -- see the two modules' header comments for the
     * confirmation/date rules `opts.confirmGapHours` feeds. Stored JSON is
     * normalised first (see `normalizeProfile`). Tolerates garbage `ops`, never throws.
     * @param {string} guildId
     * @param {string} userId
     * @param {{ character?: string, style?: string, relationship?: string,
     *   interests?: { add?: object[], update?: object[], seen?: string[], remove?: string[] },
     *   details?: { add?: unknown[], seen?: unknown[], remove?: unknown[] },
     *   aliases?: { add?: string[], remove?: string[] } }} ops
     * @param {{ fieldChars?: number, maxInterests?: number, maxInterestsStored?: number, topicChars?: number,
     *   noteChars?: number, interestHalfLifeDays?: number, maxDetails?: number, maxDetailsStored?: number,
     *   detailHalfLifeDays?: number, maxAliases?: number, maxAliasesStored?: number, aliasHalfLifeDays?: number,
     *   confirmGapHours?: number, seenAt?: number, now?: number, clampTolerance?: number,
     *   relationshipScore?: number, relationshipChars?: number, by?: string,
     *   versions?: { enabled?: boolean, kept?: number } }} [opts]
     *   `by`/`versions`: a replaced `character`/`style`/`relationship` keeps its previous text
     *   (`recordVersion`).
     *   `relationshipScore`: stamped as `profile.relationshipScore` whenever a `relationship` text
     *   is written (falls back to the stored score), and `profile.relationshipWrittenAt` = the ISO
     *   time of `opts.now` (else the wall clock) next to it -- the score and the moment the text
     *   was written, see src/memory/affinity.js#relationshipStaleOf (`relationshipStale`).
     *   `relationshipChars`: the relationship text's limit (`relationships.textChars`); omitted ->
     *   `fieldChars`.
     *   `maxInterestsStored`/`maxDetailsStored`/`interestHalfLifeDays`/`detailHalfLifeDays` drive the
     *   storage-cap-vs-shown-cap split and the rank decay -- see
     *   docs/prompt-contract.md, "More is stored than shown, and rank decays with age".
     *   `clampTolerance` (see src/memory/clamp.js) governs how far prose text may run over
     *   `fieldChars`/`noteChars`/etc. before it is cut, at a clean boundary, never mid-token.
     * @returns {object} The updated profile.
     */
    applyProfileOps(guildId, userId, ops, opts = {}) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const profile = item.value;
      normalizeProfile(profile);

      const seenAt = seenAtOf(opts);

      for (const key of ['character', 'style']) {
        const value = ops?.[key];
        if (typeof value === 'string' && value.trim()) {
          const next = firstWriteText(profile[key], value, opts.fieldChars, opts.clampTolerance);
          recordVersion(guildId, 'users', userId, key, profile[key], next, opts);
          profile[key] = next;
        }
      }
      writeRelationship(profile, ops?.relationship, opts, (previous, next) =>
        recordVersion(guildId, 'users', userId, 'relationship', previous, next, opts));

      // What left the profile (removed, folded, evicted), each with its itemId: the archive's input.
      const dropped = { ...applyItemOps(profile, ops, opts, seenAt, newId), aliases: [] };

      if (ops?.aliases && typeof ops.aliases === 'object' && !Array.isArray(ops.aliases)) {
        const aliases = applyAliasOps(profile.aliases, ops.aliases, profile.names, {
          maxAliases: opts.maxAliases,
          maxAliasesStored: opts.maxAliasesStored,
          confirmGapHours: opts.confirmGapHours,
          halfLifeDays: opts.aliasHalfLifeDays,
          seenAt,
        });
        profile.aliases = changedWithItemIds(profile.aliases, aliases, ITEM_ID_PREFIX.alias, newId);
        dropped.aliases = withItemIds(aliases.dropped, ITEM_ID_PREFIX.alias, newId);
      }

      profile.updatedAt = new Date(opts.now ?? Date.now()).toISOString();
      item.dirty = true;
      return profile;
    },

    /**
     * Flag (or unflag) a member's relationship text for a forced rewrite: the next analyzer batch
     * that sends their whole profile marks it `relationshipStale` with cause `rewrite`
     * (src/memory/affinity.js#relationshipStaleOf), and the flag stays until a relationship text is
     * written (`writeRelationship`). Only an existing profile with a non-empty text can carry it;
     * nothing else on the profile changes. Set by the owner from a one-off script.
     * @param {string} guildId
     * @param {string} userId
     * @param {boolean} [on=true]  false removes the flag.
     * @returns {boolean}  false when there is no profile or it has no relationship text.
     */
    markRelationshipRewrite(guildId, userId, on = true) {
      const profile = store.getUser(guildId, userId);
      if (!profile || typeof profile.relationship !== 'string' || !profile.relationship.trim()) return false;
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      if (on) profile.relationshipRewrite = true;
      else delete profile.relationshipRewrite;
      item.dirty = true;
      return true;
    },

    /**
     * Append freshly-extracted episodes to a member's profile via
     * src/memory/episodes.js#mergeEpisodes: validated, deduplicated against
     * what is already stored, then evicted back down to `opts.maxEpisodes`
     * (lowest weight, oldest first) if needed. Returns how many were added.
     */
    addEpisodes(guildId, userId, incoming, opts) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      return mergeEpisodesInto(item, incoming, opts, { guildId, userId }).added;
    },

    /** Fold one delta into a member's stored affinity (see src/memory/affinity.js); `decayedAt` is
     * kept. Returns the stored affinity, with `applyDelta`'s non-enumerable `droppedMoves`. */
    adjustAffinity(guildId, userId, delta, reason, opts) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const current = item.value.affinity ?? emptyAffinity();
      const next = applyDeltaWithIds(current, delta, reason, opts);
      item.value.affinity = next;
      item.dirty = true;
      return next;
    },

    /**
     * `relationships.decayPerDay`: run src/memory/affinity.js#decayAffinity over every member
     * profile of a guild AND every private layer under its `private/` directory. Only a file
     * whose affinity actually changed (score moved, or the `decayedAt` stamp was set or
     * advanced) is marked dirty; a profile without any stored affinity is left alone. Never
     * creates a file.
     * @param {string} guildId
     * @param {number} nowMs  Epoch milliseconds.
     * @param {{ decayPerDay?: number, decayPower?: number }} cfg  `config.relationships`, read by the caller at the moment of the sweep.
     * @returns {{ profiles: number, decayed: number }}  `profiles`: files looked at (public +
     *   private); `decayed`: files whose score moved.
     */
    decayAffinities(guildId, nowMs, cfg) {
      const counts = { profiles: 0, decayed: 0 };
      const sweep = (item) => {
        counts.profiles += 1;
        const current = item.value.affinity;
        if (!current || typeof current !== 'object' || Array.isArray(current)) return;
        const { affinity } = decayAffinity(current, nowMs, cfg);
        if (affinity === current) return;
        if (affinity.score !== current.score) counts.decayed += 1;
        item.value.affinity = affinity;
        item.dirty = true;
      };
      for (const userId of idsUnder(usersDir(guildId))) {
        if (!store.getUser(guildId, userId)) continue;
        sweep(entries.get(userFile(guildId, userId)));
      }
      for (const userId of idsUnder(privateDir(guildId))) sweep(privateEntry(guildId, userId));
      return counts;
    },

    /**
     * Delete one member's profile AND their private layer (`forgetPrivate`),
     * cache and disk alike: removing a person removes all of them -- the
     * guild's voice queue included: every item about them, public and private,
     * and every lesson they taught (src/memory/voice.js#forgetMember), the
     * queue file rewritten at once -- and every recent line that names them (their
     * token, or one of their stored names or aliases as a whole word, read from
     * the profile before it goes; src/memory/recent.js#purgeRecentFor), the recent
     * file rewritten at once -- and their messages in the participation store (an episode left
     * without a line of the persona goes; src/memory/participation.js#purgeParticipationFor), that
     * file rewritten at once -- and the version history of their profile's prose
     * (versions/users/<userId>.json). See also `wipeGuild` below.
     * @param {string} guildId
     * @param {string} userId
     * @returns {{ recentRemoved: number }}  How many recent lines went.
     */
    forgetUser(guildId, userId) {
      const profile = store.getUser(guildId, userId);
      const names = [...(Array.isArray(profile?.names) ? profile.names : []), ...(profile?.aliases ?? []).map((alias) => alias?.name)];
      const recentRemoved = forgetRecent(guildId, userId, names);
      forgetParticipation(guildId, userId);
      const file = userFile(guildId, userId);
      entries.delete(file);
      fs.rmSync(file, { force: true });
      const versions = versionsFile(guildId, 'users', userId);
      entries.delete(versions);
      fs.rmSync(versions, { force: true });
      forgetQueued(guildId, userId);
      store.forgetPrivate(guildId, userId);
      return { recentRemoved };
    },

    /**
     * Fill in the reason of one attitude move after the fact (the two-stage analyzer: stage A
     * moved the score with an empty reason, the voice run words it later): the
     * history entry stamped `at` (its `ts`) gets `reason`, and `affinity.reason` too while that
     * entry is the newest. The score is never touched. `reason` is clamped as
     * src/memory/affinity.js#applyDelta clamps it (src/memory/voice.js#REASON_CHARS, the limit the
     * voice run words it to). Writing the same text again changes nothing, so a write applied
     * twice (a restart before the queue was saved) does no harm.
     * @param {string} guildId
     * @param {string} userId
     * @param {string} at  The ISO stamp of the history entry.
     * @param {string} reason
     * @param {{ layer?: 'private', clampTolerance?: number }} [opts]  `layer: 'private'` = the
     *   member's private layer; omitted (or null) = the public profile; any other value refuses.
     * @returns {boolean} Whether such an entry exists and now holds the text. No profile (or
     *   private layer), an unknown layer, no entry stamped `at`, or an empty text -> false,
     *   nothing written or created.
     */
    fillAffinityReason(guildId, userId, at, reason, opts = {}) {
      const item = memberEntry(guildId, userId, opts.layer);
      const text = typeof reason === 'string' ? clampText(reason, REASON_CHARS, { tolerance: opts.clampTolerance }) : '';
      const affinity = item?.value.affinity;
      if (!text || typeof at !== 'string' || !at || !isPlainObject(affinity) || !Array.isArray(affinity.history)) return false;
      const index = affinity.history.findLastIndex((move) => move?.ts === at);
      if (index === -1) return false;
      const newest = index === affinity.history.length - 1;
      if (affinity.history[index].reason === text && (!newest || affinity.reason === text)) return true;
      const history = affinity.history.map((move, i) => (i === index ? { ...move, reason: text } : move));
      item.value.affinity = { ...affinity, history, ...(newest ? { reason: text } : {}) };
      item.dirty = true;
      return true;
    },

    /**
     * Fill in the feeling of one stored episode after the fact (the two-stage analyzer: stage A
     * stored it with an empty feeling; the voice run words it later, or the degraded path keeps
     * stage A's tone as the feeling): the
     * episode added at `episode.at` (its `addedAt`) whose `date` and `what` EQUAL the given ones.
     * `feeling` is clamped as src/memory/episodes.js#sanitizeEpisode clamps it
     * (src/memory/voice.js#FEELING_CHARS, the limit the voice run words it to). Writing the
     * same text again changes nothing; a new text is also appended to the record as a `felt`
     * line (recordFelt).
     * @param {string} guildId
     * @param {string} userId
     * @param {{ at: string, date: string, what: string }} episode  The episode's address.
     * @param {string} feeling
     * @param {{ layer?: 'private', clampTolerance?: number }} [opts]  As for `fillAffinityReason`
     *   (an unknown layer refuses).
     * @returns {boolean} Whether such an episode exists and now holds the text; otherwise
     *   nothing is written or created.
     */
    fillEpisodeFeeling(guildId, userId, episode, feeling, opts = {}) {
      const item = memberEntry(guildId, userId, opts.layer);
      const text = typeof feeling === 'string' ? clampText(feeling, FEELING_CHARS, { tolerance: opts.clampTolerance }) : '';
      const episodes = item?.value.episodes;
      if (!text || !isPlainObject(episode) || !Array.isArray(episodes)) return false;
      const { at, date, what } = episode;
      if (typeof at !== 'string' || !at || typeof date !== 'string' || typeof what !== 'string') return false;
      const index = episodes.findLastIndex((ep) => isPlainObject(ep) && ep.addedAt === at && ep.date === date && ep.what === what);
      if (index === -1) return false;
      if (episodes[index].feeling === text) return true;
      const stamped = withItemIds(episodes.map((ep, i) => (i === index ? { ...ep, feeling: text } : ep)), ITEM_ID_PREFIX.episode, newId);
      item.value.episodes = stamped;
      item.dirty = true;
      recordFelt(guildId, userId, opts.layer, [stamped[index]]);
      return true;
    },

    // ---- the private layer: what one member said to the persona in direct messages ----

    /**
     * A member's private layer (data/guilds/<id>/private/<userId>.json), or
     * null when there is none. Normalised on read (see `normalizePrivate`),
     * persisted the next time anything writes the file.
     * @param {string} guildId
     * @param {string} userId
     * @returns {object|null}
     */
    getPrivate(guildId, userId) {
      if (!hasPrivate(guildId, userId)) return null;
      return privateEntry(guildId, userId).value;
    },

    /**
     * Apply one private analyzer batch to a member's private layer: the same
     * `relationship`/`interests`/`details` op shapes and `opts` as
     * `applyProfileOps` (an absent or empty `relationship` never blanks the
     * stored one). `character`, `style`, `aliases` and `portrait` are public
     * only and ignored here. Creates the file. Tolerates garbage `ops`, never throws.
     * @param {string} guildId
     * @param {string} userId
     * @param {{ relationship?: string,
     *   interests?: { add?: object[], update?: object[], seen?: string[], remove?: string[] },
     *   details?: { add?: unknown[], seen?: unknown[], remove?: unknown[] } }} ops
     * @param {object} [opts]  As for `applyProfileOps` (a first text clamped to `relationshipChars`,
     *   else `fieldChars`, and stamped `relationshipScore` and `relationshipWrittenAt` in this
     *   layer); `relationshipScore` falls back to this layer's own score (the analyzer passes the
     *   effective one it showed the model).
     * @returns {object} The updated private layer.
     */
    applyPrivateOps(guildId, userId, ops, opts = {}) {
      const item = privateEntry(guildId, userId);
      const priv = item.value;

      const seenAt = seenAtOf(opts);

      writeRelationship(priv, ops?.relationship, opts);

      // What left the private layer, each with its itemId: the archive's input.
      const dropped = applyItemOps(priv, ops, opts, seenAt, newId);

      item.dirty = true;
      return priv;
    },

    /**
     * Fold one delta into a member's PRIVATE affinity (see
     * src/memory/affinity.js#applyDelta; same `opts` as `adjustAffinity`).
     * The public affinity is never touched. Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {number} delta
     * @param {string} reason
     * @param {object} [opts]
     * @returns {{ score: number, reason: string, history: object[] }}
     */
    adjustPrivateAffinity(guildId, userId, delta, reason, opts) {
      const item = privateEntry(guildId, userId);
      const next = applyDeltaWithIds(item.value.affinity, delta, reason, opts);
      item.value.affinity = next;
      item.dirty = true;
      return next;
    },

    /**
     * Append episodes to a member's private layer via
     * src/memory/episodes.js#mergeEpisodes (same `opts` as `addEpisodes`).
     * Creates the file. Returns how many were added.
     * @param {string} guildId
     * @param {string} userId
     * @param {unknown} incoming
     * @param {object} [opts]
     * @returns {number}
     */
    addPrivateEpisodes(guildId, userId, incoming, opts) {
      const item = privateEntry(guildId, userId);
      return mergeEpisodesInto(item, incoming, opts, { guildId, userId, layer: 'private' }).added;
    },

    /**
     * Count one direct-message reply of the persona to a member for `today`
     * (a UTC date key): the counter restarts at 0 when the stored day is
     * another one. Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {string} today
     * @returns {{ day: string, count: number }}
     */
    bumpPrivateReplies(guildId, userId, today) {
      const item = privateEntry(guildId, userId);
      const replies = item.value.replies;
      if (replies.day !== today) {
        replies.day = today;
        replies.count = 0;
      }
      replies.count += 1;
      item.dirty = true;
      return { day: replies.day, count: replies.count };
    },

    /**
     * Remember that the daily-cap notice was posted to a member on `today`,
     * so it is posted at most once a day. Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {string} today
     */
    markPrivateNoticed(guildId, userId, today) {
      const item = privateEntry(guildId, userId);
      item.value.replies.noticedDay = today;
      item.dirty = true;
    },

    /**
     * Buffer one observed direct message for the next private analyzer
     * batch; an optional `maxLength` drops the oldest entries past it (as
     * `pushBuffer`). Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {object} message
     * @param {number} [maxLength]
     * @returns {number} How many entries the cap dropped (0 under it or without one).
     */
    pushPrivateBuffer(guildId, userId, message, maxLength = Infinity) {
      const item = privateEntry(guildId, userId);
      const buffer = item.value.buffer;
      buffer.push(message);
      const over = buffer.length - maxLength;
      const dropped = over > 0 ? over : 0; // as pushBuffer: never NaN
      if (dropped > 0) buffer.splice(0, dropped);
      item.dirty = true;
      return dropped;
    },

    /**
     * How many direct messages are buffered for a member (0 when there is no
     * private layer). Creates nothing.
     * @param {string} guildId
     * @param {string} userId
     * @returns {{ size: number }}
     */
    privateBufferInfo(guildId, userId) {
      if (!hasPrivate(guildId, userId)) return { size: 0 };
      return { size: privateEntry(guildId, userId).value.buffer.length };
    },

    /**
     * A copy of a member's buffered direct messages, oldest first, leaving
     * the buffer as it is (the analyzer shifts it only after a successful
     * update, see `shiftPrivateBuffer`). `[]` (and no file created) when
     * there is no private layer.
     * @param {string} guildId
     * @param {string} userId
     * @returns {object[]}
     */
    getPrivateBuffer(guildId, userId) {
      if (!hasPrivate(guildId, userId)) return [];
      return [...privateEntry(guildId, userId).value.buffer];
    },

    /**
     * Drop the buffered direct messages of a member that a private update
     * consumed, by identity, as `shiftBuffer`. Nothing happens, and no file is
     * created, when there is no private layer.
     * @param {string} guildId
     * @param {string} userId
     * @param {object[]} consumed  The batch the update analyzed.
     */
    shiftPrivateBuffer(guildId, userId, consumed) {
      if (!hasPrivate(guildId, userId)) return;
      const item = privateEntry(guildId, userId);
      dropConsumed(item.value.buffer, consumed);
      item.dirty = true;
    },

    /**
     * Stamp a successful private update on a member's private layer:
     * `lastSeen` always, `firstSeen` only while it is empty (ISO strings,
     * like a public profile's). The public profile is never touched.
     * Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {number} nowMs  Epoch milliseconds.
     */
    touchPrivateSeen(guildId, userId, nowMs) {
      const item = privateEntry(guildId, userId);
      const iso = new Date(nowMs).toISOString();
      if (!item.value.firstSeen) item.value.firstSeen = iso;
      item.value.lastSeen = iso;
      item.dirty = true;
    },

    /**
     * Ids of every member with a private layer in a guild, cached or on disk.
     * @param {string} guildId
     * @returns {string[]}
     */
    listPrivate(guildId) {
      return idsUnder(privateDir(guildId));
    },

    /**
     * Delete one member's private layer, cache and disk alike, and their
     * private items in the guild's voice queue (the queue file rewritten at
     * once); the public profile and their public items stay. Safe when there
     * is none.
     * @param {string} guildId
     * @param {string} userId
     */
    forgetPrivate(guildId, userId) {
      const file = privateFile(guildId, userId);
      entries.delete(file);
      fs.rmSync(file, { force: true });
      forgetQueued(guildId, userId, { layer: 'private' });
    },

    /** How many member profiles a guild has, cached or on disk (a profile not flushed yet included). */
    countUsers(guildId) {
      return idsUnder(usersDir(guildId)).length;
    },

    /**
     * Every member profile stored for a guild, cached or on disk -- the pool
     * a turn scans to pull a silent member into `<people>` by name/alias (see
     * src/behavior/prompt.js and docs/prompt-contract.md, "Aliases").
     * Same normalize-on-read guarantee as `getUser`.
     */
    listUserProfiles(guildId) {
      return idsUnder(usersDir(guildId)).map((id) => store.getUser(guildId, id)).filter(Boolean);
    },

    /** Ids of every guild that has anything stored on disk or in the cache. */
    listGuilds() {
      const ids = new Set();
      try {
        for (const name of fs.readdirSync(path.join(dataDir, 'guilds'))) ids.add(name);
      } catch {
        // no guilds directory yet
      }
      const prefix = path.join(dataDir, 'guilds') + path.sep;
      for (const file of entries.keys()) {
        if (file.startsWith(prefix)) ids.add(file.slice(prefix.length).split(path.sep)[0]);
      }
      return [...ids];
    },

    /**
     * The guild's memory (data/guilds/<id>/guild.json), the empty default
     * when nothing is stored. `learned` is normalised on read (see
     * `normalizeGuild` above) -- persisted the next time anything writes the
     * guild, never wiped implicitly.
     */
    getGuild(guildId) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      return item.value;
    },

    /**
     * Merge fields into the guild's memory and stamp `updatedAt` -- only when
     * something stored actually changes: an identical re-send is left alone. `learned`/
     * `learnedNextId` are never taken from here -- they only ever change
     * through `applyLearnedOps`, which merges incrementally instead of
     * overwriting wholesale (mirrors `updateUser`); `emojiUsage` likewise
     * only through `recordEmojiUsage`/`clearEmojiUsage`, `emojiBackfill` only
     * through `setEmojiBackfill`, `pingsOff` only through `setPingsOff`, and the notes stamps only
     * through this write and `markNotesChecked`. `notesUpdatedAt` gets the
     * same stamp when one of the server notes (`patterns`, `starters`,
     * `injokes`) really changes; `self` alone never moves it, and neither do
     * `applySelfOps` or `applyLearnedOps`, so it tells how old the notes are
     * (src/memory/update.js#notesStale). A changed `patterns`/`starters` keeps its previous
     * text (`recordVersion`; `opts.by`, `opts.versions`). The return stays the stored guild, so what
     * a write of `injokes` or `self` takes out of the stored list (by
     * src/memory/interests.js#normalizeTopic) is handed to `opts.onDropped` instead, as
     * `{ injokes, self }` lists of `{ itemId, text }` (`ij-`/`sf-`, minted here, see
     * `ITEM_ID_PREFIX`), called once per write.
     * @param {{ by?: string, versions?: { enabled?: boolean, kept?: number },
     *   onDropped?: (dropped: { injokes: object[], self: object[] }) => void }} [opts]
     */
    updateGuild(guildId, fields, opts = {}) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      const {
        learned,
        learnedNextId,
        emojiUsage,
        emojiBackfill,
        pingsOff,
        notesUpdatedAt,
        notesCheckedAt,
        ...safeFields
      } = fields ?? {};
      if (!changesStored(item.value, safeFields)) return item.value;
      const notes = Object.fromEntries(Object.entries(safeFields).filter(([key]) => NOTES_FIELDS.includes(key)));
      const stamp = new Date().toISOString();
      const stamps = changesStored(item.value, notes) ? { updatedAt: stamp, notesUpdatedAt: stamp } : { updatedAt: stamp };
      for (const key of GUILD_PROSE) {
        if (key in safeFields) recordVersion(guildId, 'guild', 'guild', key, item.value[key], safeFields[key], opts);
      }
      // The in-jokes (and a single-stage self list) are replaced whole: what the new list no longer
      // holds leaves the guild here (src/memory/update.js clamps the list before).
      const dropped = {
        injokes: 'injokes' in safeFields ? droppedStrings(item.value.injokes, safeFields.injokes, ITEM_ID_PREFIX.injoke, newId) : [],
        self: 'self' in safeFields ? droppedStrings(item.value.self, safeFields.self, ITEM_ID_PREFIX.selfFact, newId) : [],
      };
      Object.assign(item.value, safeFields, stamps);
      opts.onDropped?.(dropped);
      item.dirty = true;
      return item.value;
    },

    /**
     * Whether `userId` turned the persona's notifications off in this guild (`/nep pings off`).
     * @param {string} guildId
     * @param {string} userId
     * @returns {boolean}
     */
    isPingsOff(guildId, userId) {
      const list = store.getGuild(guildId)?.pingsOff;
      return Array.isArray(list) && list.includes(String(userId));
    },

    /**
     * Turn the persona's notifications to `userId` off (`off` true) or back on, in the guild's
     * `pingsOff` list. A change is written at once (a member's own switch, allowed while paused,
     * when the next flush could otherwise land on a hand-edited file or be dropped with the
     * caches); no change writes nothing. Nothing else is touched, never `updatedAt`. Persists like
     * every guild field and is never reset implicitly.
     * @param {string} guildId
     * @param {string} userId
     * @param {boolean} off
     * @returns {boolean}  The state now: true when the member's pings are off.
     */
    setPingsOff(guildId, userId, off) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      if (!isPlainObject(item.value)) return false;
      const id = String(userId);
      const has = item.value.pingsOff.includes(id);
      if (off === true && !has) {
        item.value.pingsOff = [...item.value.pingsOff, id];
        item.dirty = true;
      } else if (off !== true && has) {
        item.value.pingsOff = item.value.pingsOff.filter((other) => other !== id);
        item.dirty = true;
      }
      flushEntry(guildFile(guildId), item);
      return item.value.pingsOff.includes(id);
    },

    /**
     * Record that the analyzer was asked to look at notes again (a batch that carried their
     * stale marker was applied): `notesCheckedAt` = the ISO time of `nowMs` on each listed
     * channel entry, and on the guild when `guild` is true. Nothing else is touched -- never
     * `updatedAt` or `notesUpdatedAt`, which only a real change of the text moves -- so notes
     * answered with the same text are not asked about again until they are stale once more
     * (src/memory/update.js#notesStale reads the later of the two stamps). A listed channel
     * without an entry is skipped, never created; the guild file is created when it has to hold
     * the stamp. Marked dirty only where the stamp changes. Targets that name nothing change
     * nothing and never throw.
     * @param {string} guildId
     * @param {{ channels?: string[], guild?: boolean }} targets  The targets a request flagged
     *   (src/memory/update.js#buildMemoryRequest's `staleNotes`).
     * @param {number} nowMs  Epoch milliseconds; not a finite number -> the wall clock.
     * @returns {{ channels: number, guild: boolean }}  How many channel entries hold the stamp
     *   now, and whether the guild does.
     */
    markNotesChecked(guildId, targets, nowMs) {
      const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
      const marked = { channels: 0, guild: false };
      const stamp = (item) => {
        if (item.value.notesCheckedAt === at) return;
        item.value.notesCheckedAt = at;
        item.dirty = true;
      };

      const listed = Array.isArray(targets?.channels) ? targets.channels : [];
      const channelIds = new Set(listed.filter((id) => typeof id === 'string' || typeof id === 'number').map(String));
      for (const channelId of channelIds) {
        if (!channelId || !hasChannel(guildId, channelId)) continue;
        const item = channelEntry(guildId, channelId);
        if (!isPlainObject(item.value)) continue;
        stamp(item);
        marked.channels += 1;
      }

      if (targets?.guild === true) {
        const item = entry(guildFile(guildId), emptyGuild);
        normalizeGuild(item.value);
        if (isPlainObject(item.value)) {
          stamp(item);
          marked.guild = true;
        }
      }
      return marked;
    },

    /**
     * Stamp `notesFlaggedAt` (when the analyzer flagged the notes stale) on the listed channels
     * that exist and on the guild; dirty only when the value changes, nothing is created.
     * @param {string} guildId
     * @param {{ channels?: string[], guild?: boolean }} targets
     * @param {number} nowMs  Epoch milliseconds; not a finite number -> the wall clock.
     * @returns {{ channels: number, guild: boolean }}
     */
    markNotesFlagged(guildId, targets, nowMs) {
      const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
      const marked = { channels: 0, guild: false };
      const stamp = (item) => {
        if (item.value.notesFlaggedAt === at) return;
        item.value.notesFlaggedAt = at;
        item.dirty = true;
      };

      const listed = Array.isArray(targets?.channels) ? targets.channels : [];
      const channelIds = new Set(listed.filter((id) => typeof id === 'string' || typeof id === 'number').map(String));
      for (const channelId of channelIds) {
        if (!channelId || !hasChannel(guildId, channelId)) continue;
        const item = channelEntry(guildId, channelId);
        if (!isPlainObject(item.value)) continue;
        stamp(item);
        marked.channels += 1;
      }

      if (targets?.guild === true) {
        const item = entry(guildFile(guildId), emptyGuild);
        normalizeGuild(item.value);
        if (isPlainObject(item.value)) {
          stamp(item);
          marked.guild = true;
        }
      }
      return marked;
    },

    /**
     * Record the outcome of one sample refresh of the notes. `reviewed` sets
     * `notesSampleReviewedAt` and clears `notesAttemptAt`; `attempt` sets `notesAttemptAt` only.
     * A channel that does not exist writes nothing.
     * @param {string} guildId
     * @param {string} target  `'guild'` or a channel id.
     * @param {number} nowMs  Epoch milliseconds; not a finite number -> the wall clock.
     * @param {{ outcome: 'reviewed'|'attempt' }} opts
     * @returns {boolean}  Whether something was written.
     */
    markNotesSampled(guildId, target, nowMs, { outcome } = {}) {
      if (outcome !== 'reviewed' && outcome !== 'attempt') return false;
      const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
      let item;
      if (target === 'guild') {
        item = entry(guildFile(guildId), emptyGuild);
        normalizeGuild(item.value);
      } else {
        const channelId = typeof target === 'string' || typeof target === 'number' ? String(target) : '';
        if (!channelId || !hasChannel(guildId, channelId)) return false;
        item = channelEntry(guildId, channelId);
      }
      if (!isPlainObject(item.value)) return false;
      const patch = outcome === 'reviewed' ? { notesSampleReviewedAt: at, notesAttemptAt: null } : { notesAttemptAt: at };
      if (!changesStored(item.value, patch)) return false;
      Object.assign(item.value, patch);
      item.dirty = true;
      return true;
    },

    /**
     * Add the members' custom emoji uses of one consumed analyzer batch to
     * the guild's `emojiUsage` (src/memory/emoji-usage.js#mergeEmojiUsage:
     * counts accumulate, the lowest-ranked entries past `opts.storeMax` are
     * evicted). Marks the guild dirty only when something was counted; never
     * stamps `updatedAt` (a counter, like `touchUser`).
     * @param {string} guildId
     * @param {object[]} messages  Slim buffered messages; `self`/`bot`/`ts`/`emojis` read.
     * @param {{ storeMax?: number, halfLifeDays?: number }} [opts]
     * @returns {number} How many uses were counted.
     */
    recordEmojiUsage(guildId, messages, opts = {}) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      const { usage, counted } = mergeEmojiUsage(item.value.emojiUsage, messages, opts);
      if (counted > 0) {
        item.value.emojiUsage = usage;
        item.dirty = true;
      }
      return counted;
    },

    /**
     * Empty the guild's `emojiUsage` -- only for the emoji history backfill
     * (src/memory/emoji-backfill.js: its one first run, or the owner's
     * `/nep emoji rescan`), which recounts it from history right after.
     * Nothing else is touched; never stamps `updatedAt`.
     * @param {string} guildId
     */
    clearEmojiUsage(guildId) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      item.value.emojiUsage = {};
      item.dirty = true;
    },

    /**
     * Stamp the guild's `emojiBackfill` (`{ at, channels, messages }`,
     * normalised like on read) after a history backfill. Never stamps `updatedAt`.
     * @param {string} guildId
     * @param {{ at: string, channels: number, messages: number }} stamp
     * @returns {{ at: string, channels: number, messages: number } | null} The stored stamp.
     */
    setEmojiBackfill(guildId, stamp) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      item.value.emojiBackfill = normalizeBackfillStamp(stamp);
      item.dirty = true;
      return item.value.emojiBackfill;
    },

    /**
     * Apply one batch of `learned` ops (`{ add, seen, remove }`, add items a
     * bare string or `{ text, from?, sure? }`) to the guild's list of things
     * people taught the persona, via src/memory/details.js#applyDetailOps --
     * the same confirmation/ranking/eviction mechanics as a member's
     * details, with the guild's own `learnedNextId` id counter. Used by the
     * analyzer (src/memory/update.js#applyMemoryUpdate) and the owner
     * commands. The limits are the `config.memory` keys of the same name, so
     * a caller can pass `{ ...config.memory, seenAt }` as-is; `seenAt` falls
     * back to the wall clock. Garbage `ops` change nothing and never throw.
     * The guild is marked dirty (and `updatedAt` stamped) only when the list
     * or the counter actually changed.
     * @param {string} guildId
     * @param {{ add?: unknown[], seen?: unknown[], remove?: unknown[] }} ops
     * @param {{ seenAt?: number, maxLearned?: number, maxLearnedStored?: number, learnedChars?: number,
     *   learnedHalfLifeDays?: number, confirmGapHours?: number, clampTolerance?: number }} [opts]
     * @returns {object[]} The guild's `learned` list after the ops (a written list gives every item
     *   an `itemId` when it has none, `ln-`), with the non-enumerable `dropped`: the lessons that
     *   left (removed, evicted), each with one; `[]` when the list did not change.
     */
    applyLearnedOps(guildId, ops, opts = {}) {
      const item = entry(guildFile(guildId), emptyGuild);
      const guild = item.value;
      normalizeGuild(guild);
      if (!ops || typeof ops !== 'object' || Array.isArray(ops)) return guild.learned;

      const before = JSON.stringify([guild.learned, guild.learnedNextId]);
      const { items, nextId, dropped } = applyDetailOps(guild.learned, ops, {
        maxDetails: opts.maxLearned,
        maxDetailsStored: opts.maxLearnedStored,
        fieldChars: opts.learnedChars,
        halfLifeDays: opts.learnedHalfLifeDays,
        confirmGapHours: opts.confirmGapHours,
        clampTolerance: opts.clampTolerance,
        seenAt: Number.isFinite(opts.seenAt) ? opts.seenAt : Date.now(),
        nextId: guild.learnedNextId,
      });
      // Compared before the ids are stamped: a call that changes nothing still writes nothing.
      if (JSON.stringify([items, nextId]) !== before) {
        guild.learned = withItemIds(items, ITEM_ID_PREFIX.lesson, newId);
        guild.learnedNextId = nextId;
        guild.updatedAt = new Date().toISOString();
        item.dirty = true;
      }
      return attachDropped(guild.learned, 'dropped', withItemIds(dropped, ITEM_ID_PREFIX.lesson, newId));
    },

    /**
     * Apply one batch of self-fact ops to the guild's `self` list (what the persona said about
     * itself), the two-stage analyzer's incremental shape (src/memory/voice.js): `remove` first,
     * every stored fact equal to one listed (compared by src/memory/interests.js#normalizeTopic:
     * trimmed, whitespace collapsed, lower-cased -- the rule src/memory/voice.js tells a queued
     * self fact by); then `add`, each new claim clamped like the single-stage self list
     * (src/memory/voice.js#SELF_CHARS, `opts.clampTolerance`) and appended unless it is already
     * stored; past `opts.maxSelfFacts` the oldest leave to make room (a cap of 0 adds nothing; a
     * call that adds nothing never cuts the list, even one stored above a lowered cap). The
     * single-stage analyzer still replaces the whole list through `updateGuild`. Like
     * `updateGuild`, the guild is marked dirty and `updatedAt` stamped (`opts.now`, else the wall
     * clock) only when the list changed. Garbage `ops` and entries that are not strings change
     * nothing and never throw. Tokenizing `<@id>` is the caller's.
     * @param {string} guildId
     * @param {{ add?: string[], remove?: string[] }} ops
     * @param {{ maxSelfFacts: number, clampTolerance?: number, now?: number }} opts
     *   `maxSelfFacts` is required: the caller's resolved `memory.maxSelfFacts` (its fallback is
     *   src/memory/update.js#MEMORY_LIMIT_DEFAULTS'; the store keeps no copy). A fraction is
     *   floored.
     * @returns {{ added: number, removed: number, evicted: number }}  `evicted`: facts that left
     *   to stay under the cap (a claim added in this call included). The non-enumerable `dropped`
     *   lists every fact that left (removed, then evicted) as `{ itemId, text }` (`sf-`, minted
     *   here: a stored self fact is a plain string, see `ITEM_ID_PREFIX`).
     * @throws {TypeError} `opts.maxSelfFacts` is not a finite number of at least 0; nothing changes.
     */
    applySelfOps(guildId, ops, opts = {}) {
      const limit = opts?.maxSelfFacts;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
        throw new TypeError('applySelfOps: opts.maxSelfFacts must be a number of at least 0');
      }
      const cap = Math.floor(limit);
      const counts = { added: 0, removed: 0, evicted: 0 };
      if (!isPlainObject(ops)) return counts;
      const item = entry(guildFile(guildId), emptyGuild);
      const guild = item.value;
      normalizeGuild(guild);

      const stored = Array.isArray(guild.self) ? guild.self.filter((fact) => typeof fact === 'string' && fact.trim()) : [];
      const removing = new Set((Array.isArray(ops.remove) ? ops.remove : []).filter((fact) => typeof fact === 'string').map(normalizeTopic));
      removing.delete('');
      let next = stored.filter((fact) => !removing.has(normalizeTopic(fact)));
      counts.removed = stored.length - next.length;
      const leaving = stored.filter((fact) => removing.has(normalizeTopic(fact)));

      if (cap > 0) {
        const held = new Set(next.map(normalizeTopic));
        for (const claim of Array.isArray(ops.add) ? ops.add : []) {
          if (typeof claim !== 'string') continue;
          const fact = clampText(claim, SELF_CHARS, { tolerance: opts.clampTolerance });
          const key = normalizeTopic(fact);
          if (!key || held.has(key)) continue;
          held.add(key);
          next.push(fact);
          counts.added += 1;
        }
        if (counts.added > 0 && next.length > cap) {
          counts.evicted = next.length - cap;
          leaving.push(...next.slice(0, counts.evicted));
          next = next.slice(-cap);
        }
      }

      if (counts.added + counts.removed > 0) {
        guild.self = next;
        guild.updatedAt = new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString();
        item.dirty = true;
      }
      return attachDropped(counts, 'dropped', stringItems(leaving, ITEM_ID_PREFIX.selfFact, newId));
    },

    /**
     * One channel's stored entry (the server map), or null when never seen.
     * Normalised on read (see `normalizeChannel` above: the writers tally and
     * the notes check stamp) -- persisted the next time anything writes the
     * entry, never wiped implicitly.
     */
    getChannel(guildId, channelId) {
      if (!hasChannel(guildId, channelId)) return null;
      return channelEntry(guildId, channelId).value;
    },

    /** Every channel entry stored for a guild, cached or on disk; normalised on read like `getChannel`. */
    listChannels(guildId) {
      return idsUnder(channelsDir(guildId)).map((id) => channelEntry(guildId, id).value);
    },

    /**
     * Record one observed message in a channel: Discord facts (name, category,
     * topic), counters and the per-day activity histogram. Creates the entry.
     * `authorId` (the message's author, omitted for the persona's own
     * messages and other bots -- see src/memory/update.js#touchMemory) is
     * counted into the channel's `writers` tally (see `countWriter` above),
     * and `topWriters` is written again as the best five of it, best first;
     * `null` (the default) leaves both untouched. Never stamps `updatedAt`
     * (counters are not notes).
     * @param {string} guildId
     * @param {string} channelId
     * @param {{ name?: string, category?: string|null, topic?: string|null }} facts
     * @param {number} [ts]  The message's time, epoch milliseconds.
     * @param {string|null} [authorId]
     * @param {{ channelWritersStored?: number, channelWritersHalfLifeDays?: number }} [opts]  The
     *   `config.memory` keys of the same name, so a caller can pass `config.memory` as-is, read
     *   at the moment of use: how many writers the tally keeps (20; never fewer than the five
     *   shown) and the half-life of a writer's rank in days (30; 0 or less = the count alone).
     * @returns {object} The channel entry.
     */
    touchChannel(guildId, channelId, facts, ts = Date.now(), authorId = null, opts = {}) {
      const item = channelEntry(guildId, channelId);
      const channel = item.value;
      const { name, category = null, topic = null } = facts ?? {};
      if (name) channel.name = name;
      channel.category = category;
      channel.topic = topic;
      channel.messageCount += 1;
      channel.firstMessageAt = channel.firstMessageAt === null ? ts : Math.min(channel.firstMessageAt, ts);
      channel.lastMessageAt = channel.lastMessageAt === null ? ts : Math.max(channel.lastMessageAt, ts);
      const dateKey = utcDay(ts);
      channel.days[dateKey] = (channel.days[dateKey] ?? 0) + 1;
      trimDays(channel.days, 30);
      if (authorId !== null && authorId !== undefined) {
        const counted = countWriter(channel.writers, authorId, ts, writersSettings(opts));
        channel.writers = counted.writers;
        channel.topWriters = counted.topWriters;
      }
      item.dirty = true;
      return channel;
    },

    /**
     * SET (never add) a channel entry's Discord facts and counters from a
     * fetched history window (the warmup, src/memory/warmup.js#processChannel):
     * unlike `touchChannel` (the live pipeline's one-message-at-a-time
     * increments), a redo of the same window lands on the same numbers
     * instead of doubling them -- mirrors `touchUserFromWindows`' SET-not-ADD
     * pattern for user profiles. `topWriters` (`{ id, count }[]`, already
     * computed by the caller from the same window) is stored as-is, ids
     * coerced to strings and capped to 5, and the `writers` tally starts over
     * from it like every other counter here (`writersFromTop`, each writer
     * dated the window's `lastMessageAt`), so the live messages that follow
     * add to the window's counts. Never stamps `updatedAt`. Creates the entry.
     * @param {string} guildId
     * @param {string} channelId
     * @param {{ name?: string, category?: string|null, topic?: string|null, messageCount?: number,
     *   firstMessageAt?: number|null, lastMessageAt?: number|null, days?: Record<string, number>,
     *   topWriters?: {id: string, count: number}[] }} facts
     */
    setChannelFacts(guildId, channelId, facts) {
      const item = channelEntry(guildId, channelId);
      const channel = item.value;
      const {
        name,
        category = null,
        topic = null,
        messageCount = 0,
        firstMessageAt = null,
        lastMessageAt = null,
        days = {},
        topWriters = [],
      } = facts ?? {};
      if (name) channel.name = name;
      channel.category = category;
      channel.topic = topic;
      channel.messageCount = messageCount;
      channel.firstMessageAt = firstMessageAt;
      channel.lastMessageAt = lastMessageAt;
      channel.days = { ...days };
      channel.topWriters = Array.isArray(topWriters)
        ? topWriters.slice(0, TOP_WRITERS).map(({ id, count }) => ({ id: String(id), count }))
        : [];
      channel.writers = writersFromTop(channel.topWriters, lastMessageAt);
      item.dirty = true;
      return channel;
    },

    /**
     * Merge analyzer-extracted fields into a channel entry. Only `purpose`,
     * `topics`, `tone` travel through here — everything else (counters,
     * Discord facts) is stripped, mirroring `updateUser`. Stamps `updatedAt`
     * only when one of them actually changes: an identical re-send is left
     * alone. Nothing else stamps a channel's `updatedAt`, so it is the notes'
     * own stamp (src/memory/update.js#notesStale reads it beside
     * `notesCheckedAt`, see `markNotesChecked`). A changed field keeps its previous text
     * (`recordVersion`; `opts.by`, `opts.versions`).
     * @param {{ by?: string, versions?: { enabled?: boolean, kept?: number } }} [opts]
     */
    updateChannel(guildId, channelId, fields, opts = {}) {
      const item = channelEntry(guildId, channelId);
      const patch = {};
      for (const key of CHANNEL_PROSE) {
        if (typeof fields?.[key] === 'string') patch[key] = fields[key];
      }
      if (!changesStored(item.value, patch)) return item.value;
      for (const [key, value] of Object.entries(patch)) recordVersion(guildId, 'channels', channelId, key, item.value[key], value, opts);
      Object.assign(item.value, patch, { updatedAt: new Date().toISOString() });
      item.dirty = true;
      return item.value;
    },

    /**
     * The describer's cache for one guild (src/memory/describe.js): a plain
     * object map keyed by attachment/embed id, insertion order doubling as
     * LRU recency order. Callers mutate the returned object directly (same
     * pattern as `state.data`) and call `markMediaCacheDirty` afterwards.
     */
    getMediaCache(guildId) {
      return entry(mediaCacheFile(guildId), () => ({})).value;
    },

    markMediaCacheDirty(guildId) {
      const item = entries.get(mediaCacheFile(guildId));
      if (item) item.dirty = true;
    },

    /**
     * The guild's GIF library (data/guilds/<id>/gifs.json, see
     * src/memory/gifs.js): `{ nextId, entries, backfill }`, the empty library
     * when nothing is stored. Normalised on read, persisted the next time
     * anything writes it, never reset implicitly.
     * @param {string} guildId
     * @returns {{ nextId: number, entries: Record<string, object>, backfill: object|null }}
     */
    getGifs(guildId) {
      return gifsEntry(guildId).value;
    },

    /**
     * The library entry whose handle is `handle` (`g12`), as `{ key, ...entry }`,
     * or null (src/memory/gifs.js#findGif). Creates nothing on disk.
     * @param {string} guildId
     * @param {string} handle
     * @returns {object|null}
     */
    findGif(guildId, handle) {
      return findGif(gifsEntry(guildId).value, handle);
    },

    /**
     * Add the members' GIFs of `messages` to the guild's library
     * (src/memory/gifs.js#mergeGifs: counts accumulate, new GIFs get the next
     * handle, the lowest-ranked entries past `opts.storeMax` are evicted).
     * Marks the file dirty only when something was counted.
     * @param {string} guildId
     * @param {object[]} messages  Normalized messages (URLs present); `self`/`bot`/`ts` read.
     * @param {{ storeMax?: number, halfLifeDays?: number }} [opts]
     * @returns {number} How many uses were counted.
     */
    recordGifs(guildId, messages, opts = {}) {
      const item = gifsEntry(guildId);
      const { gifs, counted } = mergeGifs(item.value, messages, opts);
      if (counted > 0) {
        item.value = gifs;
        item.dirty = true;
      }
      return counted;
    },

    /**
     * Record the persona's own post of the library entry under `key`
     * (src/memory/gifs.js#markOwnGif: `ownLast` = `ts`, `ownUses` + 1), after a
     * turn sent it. Marks the file dirty only when the entry exists.
     * @param {string} guildId
     * @param {string} key  The entry's library key (findGif's `key`).
     * @param {number} ts   When it was posted (epoch ms).
     * @returns {boolean} Whether an entry was stamped.
     */
    recordOwnGif(guildId, key, ts) {
      const item = gifsEntry(guildId);
      const { gifs, marked } = markOwnGif(item.value, key, ts);
      if (marked) {
        item.value = gifs;
        item.dirty = true;
      }
      return marked;
    },

    /**
     * Set every GIF library entry's count to 0 (src/memory/gifs.js#resetGifCounts)
     * -- only for the GIF history backfill (src/memory/gif-backfill.js: its one
     * first run, or the owner's `/nep gifs rescan`), which recounts from
     * history right after. Entries, handles, `nextId` and the backfill stamp
     * are kept, so a recounted GIF keeps its handle.
     * @param {string} guildId
     */
    resetGifCounts(guildId) {
      const item = gifsEntry(guildId);
      item.value = resetGifCounts(item.value);
      item.dirty = true;
    },

    /**
     * Stamp the guild's GIF library `backfill` (`{ at, channels, messages }`,
     * normalised like on read) after a history backfill.
     * @param {string} guildId
     * @param {{ at: string, channels: number, messages: number }} stamp
     * @returns {{ at: string, channels: number, messages: number } | null} The stored stamp.
     */
    setGifBackfill(guildId, stamp) {
      const item = gifsEntry(guildId);
      item.value = { ...item.value, backfill: normalizeGifs({ ...item.value, backfill: stamp }).backfill };
      item.dirty = true;
      return item.value.backfill;
    },

    /**
     * The version history of one prose owner (data/guilds/<guildId>/versions/<kind>/<id>.json, see
     * `recordVersion`): `{ [field]: [{ at, by, chars, before, after, kept, removed, added, text }] }`,
     * newest last; `{}` when none or for an unknown kind. A lore `id` is the entry's title (matched
     * trimmed and case-insensitively, as the lorebook matches titles). A copy: changing it changes
     * nothing stored.
     * @param {string} guildId
     * @param {'users'|'channels'|'guild'|'lore'} kind
     * @param {string} id  A member id, a channel id, `'guild'`, or a lore title.
     * @returns {object}
     */
    listVersions(guildId, kind, id) {
      if (!VERSION_KINDS.includes(kind)) return {};
      return structuredClone(versionsEntry(guildId, kind, id).value);
    },

    /** Every stored lorebook entry of a guild (data/guilds/<id>/lore.json). Never auto-created empty on disk. */
    getLore(guildId) {
      return entry(loreFile(guildId), () => []).value;
    },

    /**
     * Merge `incoming` entries into the guild's lorebook via
     * src/memory/lore.js#upsertLore: an analyzer update never touches an
     * owner entry, an owner write always wins. Returns how many were
     * inserted or actually changed (an identical analyzer re-send is neither).
     * An entry whose text changed keeps its previous text (`recordVersion`, kind `lore`, id
     * the title; `opts.by`, `opts.versions`).
     */
    setLore(guildId, incoming, opts = {}) {
      const item = entry(loreFile(guildId), () => []);
      const { entries: nextEntries, upserted, changes } = upsertLore(item.value, incoming, opts);
      if (upserted > 0) {
        for (const change of changes) recordVersion(guildId, 'lore', change.title, 'text', change.previousText, change.nextText, opts);
        item.value = nextEntries;
        item.dirty = true;
      }
      return upserted;
    },

    /** Delete one lorebook entry by id. Returns whether anything was removed. */
    removeLore(guildId, id) {
      const item = entry(loreFile(guildId), () => []);
      const before = item.value.length;
      item.value = item.value.filter((lore) => lore.id !== id);
      const removed = item.value.length !== before;
      if (removed) item.dirty = true;
      return removed;
    },

    getBuffer(guildId) {
      return entry(bufferFile(guildId), () => []).value;
    },

    /**
     * Buffer one observed message for the next analyzer batch, dropping the
     * oldest entries past `maxLength`.
     * @param {string} guildId
     * @param {object} message
     * @param {number} maxLength
     * @returns {number} How many entries the cap dropped (0 while under it), so
     *   the caller can log a loss the analyzer will never see.
     */
    pushBuffer(guildId, message, maxLength) {
      const item = entry(bufferFile(guildId), () => []);
      item.value.push(message);
      // `> 0` rather than Math.max: a non-numeric cap keeps everything and reports 0, never NaN.
      const over = item.value.length - maxLength;
      const dropped = over > 0 ? over : 0;
      if (dropped > 0) item.value.splice(0, dropped);
      item.dirty = true;
      return dropped;
    },

    /**
     * Replace the buffered entry with the same `id` by `message` (an embed Discord attached
     * after the message arrived, see src/discord/events.js#onMessageUpdate), in place: the
     * buffer keeps its order and length. Marks the file dirty only when an entry was replaced.
     * @param {string} guildId
     * @param {object} message  A slim buffered message (src/memory/update.js#slimMessage).
     * @returns {boolean} Whether the message was still buffered (false: already analyzed or
     *   never buffered, nothing changes).
     */
    updateBuffered(guildId, message) {
      if (message?.id == null) return false;
      const item = entry(bufferFile(guildId), () => []);
      const index = item.value.findIndex((buffered) => buffered?.id != null && String(buffered.id) === String(message.id));
      if (index < 0) return false;
      item.value[index] = message;
      item.dirty = true;
      return true;
    },

    /**
     * Drop the buffered messages a memory update consumed, by identity (see `dropConsumed`):
     * messages that arrived while the update was in flight stay, even when the capped buffer
     * already trimmed some of the consumed ones off its front.
     * @param {string} guildId
     * @param {object[]} consumed  The batch the update analyzed.
     */
    shiftBuffer(guildId, consumed) {
      const item = entry(bufferFile(guildId), () => []);
      dropConsumed(item.value, consumed);
      item.dirty = true;
    },

    // ---- the voice queue: briefs waiting for the voice model (src/memory/voice.js) ----
    //
    // Every write is a synchronous read-modify-write of the cached queue (DECISIONS-R4): a voice
    // run that awaits its request reads the queue again afterwards and removes only the ids it
    // applied, so an item a stage A batch or a portrait refresh queued meanwhile stays.
    // `updateVoiceQueue` is the only write (besides a forget or a wipe); there is no setter that
    // takes a whole queue, so a copy kept across an await has no door to be written back through.

    /**
     * A copy of the guild's voice queue (data/guilds/<id>/voice.json), `[]` when nothing is
     * queued; normalised on read (src/memory/voice.js#normalizeQueue), persisted the next time
     * anything writes it, never emptied implicitly. Changing the copy changes nothing stored.
     * For reading only: a change goes through `updateVoiceQueue`.
     * @param {string} guildId
     * @returns {import('./voice.js').VoiceItem[]}
     */
    getVoiceQueue(guildId) {
      return structuredClone(voiceEntry(guildId).value);
    },

    /**
     * Change the guild's voice queue in one synchronous step, the only way to write it: `change`
     * gets a copy of the current queue and returns the new one, either as an array
     * (src/memory/voice.js#removeItems, #retryLater) or as an object holding it under `queue`
     * (#mergeIntoQueue, #expireItems, #forgetMember); the result is normalised and stored as a
     * copy of its own (changing what `change` returned afterwards changes nothing stored), dirty
     * only when something changed. An explicit `[]` empties the queue; nothing else does.
     * @template T
     * @param {string} guildId
     * @param {(queue: import('./voice.js').VoiceItem[]) => T} change  Synchronous.
     * @returns {T} What `change` returned.
     * @throws {TypeError} `change` returned a promise (a rejecting one is never left unhandled),
     *   no queue, or a queue that cannot be written as JSON; the queue is left as it was (also
     *   when `change` throws).
     */
    updateVoiceQueue(guildId, change) {
      const item = voiceEntry(guildId);
      const outcome = change(structuredClone(item.value));
      if (typeof outcome?.then === 'function') {
        Promise.resolve(outcome).catch(() => {}); // refused below; its own failure must not go unhandled
        throw new TypeError('updateVoiceQueue: the change must be synchronous');
      }
      const next = Array.isArray(outcome) ? outcome : outcome?.queue;
      if (!Array.isArray(next)) throw new TypeError('updateVoiceQueue: the change must return a queue');
      writeQueue(item, next);
      return outcome;
    },

    // ---- the diary: the persona's own posts in its diary channel (src/behavior/diary.js) ----

    /**
     * A copy of the guild's diary (data/guilds/<id>/diary.json): `{ posts, updatedAt }`, posts
     * newest last; the empty diary (`{ posts: [], updatedAt: 0 }`) when there is no file, never
     * null. Reading never creates the file.
     * @param {string} guildId
     * @returns {{ posts: Array<{ at: number, kind: string|null, gist: string, picture: string|boolean|null,
     *   pictures?: number, messageIds: string[], search: string }>, updatedAt: number }}
     */
    getDiary(guildId) {
      return structuredClone(diaryEntry(guildId).value);
    },

    /**
     * Append one post to the guild's diary, keep the newest `max` (diary.historyPosts) and stamp
     * `updatedAt` with `now` (epoch ms, the clock when omitted).
     * @param {string} guildId
     * @param {{ at: number, kind: string|null, gist: string, picture: string|boolean|null,
     *   pictures?: number, messageIds: string[], search: string }} post  `pictures`: a set post's count
     *   (`picture` is then its first scene).
     * @param {{ max?: number, now?: number }} [opts]
     * @returns {{ dropped: object[] }}  The posts that fell past `max` (see `writeDiary`).
     */
    appendDiaryPost(guildId, post, opts = {}) {
      return writeDiary(guildId, [...diaryEntry(guildId).value.posts, structuredClone(post)], opts);
    },

    /**
     * Replace the guild's post list (the backfill, run only on an empty diary), keeping the newest
     * `max` (diary.historyPosts) and stamping `updatedAt` with `now`.
     * @param {string} guildId
     * @param {Array<object>} posts  Oldest first.
     * @param {{ max?: number, now?: number }} [opts]
     * @returns {{ dropped: object[] }}  The posts that fell past `max` (see `writeDiary`).
     */
    setDiaryPosts(guildId, posts, opts = {}) {
      return writeDiary(guildId, Array.isArray(posts) ? structuredClone(posts) : [], opts);
    },

    // ---- the recent store: short dated lines about the last days (src/memory/recent.js) ----

    /**
     * A copy of the guild's recent store (data/guilds/<id>/recent.json): `{ nextId, lines }`, the
     * empty store when there is no file. Normalised on read (src/memory/recent.js#normalizeRecent),
     * persisted only by the next change; reading never creates the file and never expires a line
     * (src/memory/recent.js#liveRecent is the view by time). Changing the copy changes nothing
     * stored: a change goes through `applyRecentOps`.
     * @param {string} guildId
     * @returns {{ nextId: number, lines: Array<{ id: number, at: number, addedAt: string|null,
     *   channelId: string, text: string, who: string[], weight: number }> }}
     */
    getRecent(guildId) {
      return structuredClone(recentEntry(guildId).value);
    },

    /**
     * One write of the guild's recent store, synchronous: expiry, the removes by id, then the new
     * lines with dedupe and both caps (src/memory/recent.js#mergeRecent, which documents every
     * option and count). Marked dirty only when a stored line was added, removed, expired or
     * evicted, so a call that changes nothing creates or rewrites no file. The settings are the
     * caller's, read at the moment of use (src/memory/recent.js#recentSettings); a lowered `hours`
     * expires the older lines here, at the first write after the change.
     * @param {string} guildId
     * @param {unknown} incoming  `{ text, at, channelId, weight }` items, untrusted.
     * @param {{ now?: number, hours?: number, maxStored?: number, maxNew?: number, chars?: number,
     *   clampTolerance?: number, removeIds?: unknown[] }} [opts]
     * @returns {{ added: number, removed: number, expired: number, evicted: number, dropped: number,
     *   invalid: number, noChannel: number, stale: number, duplicate: number, overCap: number }}
     *   `dropped` is the sum of the five reasons after it. A written store gives every line an
     *   `itemId` when it has none (`rc-`); the non-enumerable `droppedLines` holds the stored lines
     *   that left (expired, removed, evicted), each with one.
     */
    applyRecentOps(guildId, incoming, opts = {}) {
      const item = recentEntry(guildId);
      const { value, droppedLines, ...counts } = mergeRecent(item.value, incoming, opts);
      if (counts.added + counts.removed + counts.expired + counts.evicted > 0) {
        item.value = { ...value, lines: withItemIds(value.lines, ITEM_ID_PREFIX.recent, newId) };
        item.dirty = true;
      }
      return attachDropped(counts, 'droppedLines', withItemIds(droppedLines, ITEM_ID_PREFIX.recent, newId));
    },

    // ---- the participation store: the persona's exchanges on the channels (src/memory/participation.js) ----

    /**
     * A copy of the guild's participation store (data/guilds/<id>/participation.json):
     * `{ episodes, nextId }`, the empty store when there is no file. Normalised on read
     * (src/memory/participation.js#normalizeParticipation), persisted only by the next change;
     * reading never creates the file and never expires an episode. Changing the copy changes
     * nothing stored: a change goes through `setParticipation`.
     * @param {string} guildId
     * @returns {{ episodes: object[], nextId: number }}
     */
    getParticipation(guildId) {
      return structuredClone(participationEntry(guildId).value);
    },

    /**
     * Store `state` (the result of src/memory/participation.js#recordOwnLine / #recordFollowing
     * on a `getParticipation` copy) as the guild's participation store, after expiry
     * (src/memory/participation.js#expireEpisodes: past `hours`, then over `maxStored`), and mark
     * it dirty. The settings are the caller's, read at the moment of use
     * (src/memory/participation.js#participationSettings); missing ones read as the defaults, a
     * missing `now` as the wall clock.
     * @param {string} guildId
     * @param {unknown} state
     * @param {{ settings?: object, now?: number }} [opts]
     * @returns {{ dropped: object[] }}  Every stored episode gets an `itemId` when it has none
     *   (`pt-`); `dropped`: the episodes the expiry removed, each with one.
     */
    setParticipation(guildId, state, { settings, now } = {}) {
      const item = participationEntry(guildId);
      const { state: next, dropped } = expireEpisodes(state, settings, Number.isFinite(now) ? now : Date.now());
      item.value = structuredClone({ ...next, episodes: withItemIds(next.episodes, ITEM_ID_PREFIX.participation, newId) });
      item.dirty = true;
      return { dropped: withItemIds(dropped, ITEM_ID_PREFIX.participation, newId) };
    },

    /**
     * A deliberate, owner-only clean start for one guild's memory (see
     * src/admin.js `/nep memory wipe`). Together with `forgetUser`,
     * `forgetPrivate` and `removeLore`, one of the only places in the project allowed to delete
     * stored memory. Removes, from both the cache and disk: every user profile
     * (affinity and episodes included), the whole `private/` directory (every
     * member's private layer), the whole `versions/` directory (every prose version
     * history, owner lore's included), `guild.json` -- and with it everything it holds:
     * patterns, starters, in-jokes, self facts, `learned`, `emojiUsage`, the
     * `emojiBackfill` stamp, `pingsOff` and the notes stamps -- every channel entry (its writers
     * tally included), the live observation buffer, the
     * voice queue (`voice.json`), the recent store (`recent.json`), the participation store
     * (`participation.json`), and
     * lorebook entries whose `source` is `'analyzer'` (every entry, owner
     * included, when `keepOwnerLore` is false). Keeps, by default, owner lore
     * (`source: 'owner'`) and the media description cache, and always the GIF
     * library (`gifs.json`, its counts and backfill stamp included). Drops
     * `state.warmup` (the warmup's own progress, see src/memory/warmup.js) so
     * the next run starts clean; everything else in `state.json` -- token
     * calibration, the daily counters (the portrait refresh's included) and the
     * spontaneous schedule -- survives untouched. Safe when
     * some files never existed; the store stays fully usable afterwards (a following
     * `touchUser`/`getGuild` works and persists), no restart required.
     * @param {string} guildId
     * @param {{ keepOwnerLore?: boolean, keepMediaCache?: boolean }} [opts]
     * @returns {{ users: number, channels: number, loreRemoved: number, loreKept: number, bufferMessages: number,
     *   recentLines: number }}  `recentLines`: the recent lines the wipe removed.
     */
    wipeGuild(guildId, { keepOwnerLore = true, keepMediaCache = true } = {}) {
      const userIds = idsUnder(usersDir(guildId));
      for (const id of userIds) {
        const file = userFile(guildId, id);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      const channelIds = idsUnder(channelsDir(guildId));
      for (const id of channelIds) {
        const file = channelFile(guildId, id);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      {
        const file = guildFile(guildId);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      {
        const dir = privateDir(guildId);
        const prefix = dir + path.sep;
        for (const file of [...entries.keys()]) {
          if (file.startsWith(prefix)) entries.delete(file);
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }

      {
        const dir = versionsDir(guildId);
        const prefix = dir + path.sep;
        for (const file of [...entries.keys()]) {
          if (file.startsWith(prefix)) entries.delete(file);
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }

      const bufferFileName = bufferFile(guildId);
      const bufferMessages = entry(bufferFileName, () => []).value.length;
      entries.delete(bufferFileName);
      fs.rmSync(bufferFileName, { force: true });

      {
        const file = voiceFile(guildId);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      const recentFileName = recentFile(guildId);
      const recentLines = recentEntry(guildId).value.lines.length;
      entries.delete(recentFileName);
      fs.rmSync(recentFileName, { force: true });

      {
        const file = participationFile(guildId);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      const loreItem = entry(loreFile(guildId), () => []);
      const storedLore = loreItem.value;
      const keptLore = keepOwnerLore ? storedLore.filter((e) => e.source === 'owner') : [];
      const loreRemoved = storedLore.length - keptLore.length;
      const loreKept = keptLore.length;
      if (loreRemoved > 0) {
        loreItem.value = keptLore;
        loreItem.dirty = true;
      }

      if (!keepMediaCache) {
        const file = mediaCacheFile(guildId);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      // The recall trace quotes members' messages: it goes with the rest.
      fs.rmSync(recallTraceFile(guildId), { force: true });

      for (const key of ['warmup']) {
        if (stateEntry.value[key] !== undefined) {
          delete stateEntry.value[key];
          stateEntry.dirty = true;
        }
      }

      flushAll();

      return { users: userIds.length, channels: channelIds.length, loreRemoved, loreKept, bufferMessages, recentLines };
    },

    /**
     * Append one recall run's record (src/behavior/recall-run.js, `features.recallTrace`)
     * as one JSON line to data/guilds/<guildId>/recall-trace.jsonl, written at once (not
     * through the cache). The file keeps the newest `maxLines` lines (a missing or unusable
     * value: 500): while there is room the line is appended, past the cap the file is
     * rewritten atomically without the oldest. Lines a hand edit left blank are dropped on
     * that rewrite. Throws on an I/O failure (the caller logs it).
     * @param {string} guildId
     * @param {object} record
     * @param {{ maxLines?: number }} [opts]
     */
    appendRecallTrace(guildId, record, { maxLines } = {}) {
      const cap = Number.isFinite(maxLines) && maxLines >= 1 ? Math.floor(maxLines) : RECALL_TRACE_MAX_LINES;
      const file = recallTraceFile(guildId);
      const line = JSON.stringify(record);
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        // no trace yet
      }
      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length + 1 <= cap) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // A hand edit may have left the last line without its line break.
        fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
        return;
      }
      writeTextAtomic(file, `${[...lines, line].slice(-cap).join('\n')}\n`);
    },

    flush() {
      flushAll();
    },

    /**
     * Drop every cached file EXCEPT `state.json` (`/nep pause`): called
     * right after a flush, so nothing stale can be written from memory while
     * the owner hand-edits files under `data/` -- the next read of any
     * profile/guild/channel/lore/media/buffer lazily re-populates from disk,
     * exactly like a fresh process. `state.json` itself is left cached (it
     * carries the `paused` flag this feature relies on); see `reloadState`
     * below for forcing a fresh read of it too, used by `/nep resume`.
     * @returns {number} how many cache entries were dropped
     */
    dropCaches() {
      let dropped = 0;
      for (const [file, item] of entries) {
        if (file === stateFile) continue;
        if (item.dirty) log.warn('store: dropping a cache entry with unflushed changes', { file });
      }
      for (const file of [...entries.keys()]) {
        if (file === stateFile) continue;
        entries.delete(file);
        dropped += 1;
      }
      return dropped;
    },

    /**
     * Force `state.json` to be re-read from disk right now, discarding
     * whatever was cached (`/nep resume`): the owner may have
     * hand-edited it (e.g. warmup progress) while paused. Any unflushed
     * in-memory change is lost, the same guarantee every other cached file
     * already has once dropped.
     */
    reloadState() {
      stateEntry.value = readJson(stateFile, {});
      stateEntry.dirty = false;
    },

    /**
     * Every `*.json` file under this store's `dataDir` that fails to parse
     * (`/nep resume`) -- see `findInvalidJsonFiles` above.
     * @returns {string[]}
     */
    validate() {
      return findInvalidJsonFiles(dataDir);
    },
  };

  return store;
}
