// Persistent memory on plain JSON files under data/ — survives restarts, hot
// reloads and prompt edits; nothing in the codebase ever wipes it implicitly.
//
//   data/state.json                          the pause flag, the spontaneous schedule, token calibration, the
//                                            daily counters (LLM requests, portrait refreshes, voice requests,
//                                            videos and re-watches, pictures drawn, web lookups,
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
//   data/guilds/<guildId>/tasks.json          the persona's errand tasks: the open ones and the latest
//                                            finished, with the day's counters (src/errands/store.js,
//                                            which owns it and tasks.jsonl, one line per transition;
//                                            not cached here; a forget and a wipe reach them through
//                                            the errand stores they are handed, `errands`)
//   data/guilds/<guildId>/intentions.json     the persona's intentions: the open ones and the latest
//                                            closed (src/intentions/store.js, which owns it; not cached
//                                            here; a forget and a wipe reach it through the intention
//                                            stores they are handed, `intentions`)
//   data/guilds/<guildId>/recall-trace.jsonl  one JSON line per recall run when `features.recallTrace` is on
//                                            (appendRecallTrace): the newest `recall.traceMaxLines`, written
//                                            at once, not cached; a wipe deletes it
//   data/guilds/<guildId>/versions/<kind>/<id>.json  the previous texts of the prose fields (see
//                                            `recordVersion`): users/<userId>, channels/<channelId>,
//                                            guild/guild, lore/<key> (src/memory/lore.js#loreVersionKey);
//                                            capped per field, deleted only with their owner
//   data/guilds/<guildId>/forgotten.json     the deletion ledger: `{ userId, at }` per finished forget,
//                                            re-applied at every start (`applyLedger`)
//   data/guilds/<guildId>/forgetting/<userId>.json  the marker of a forget under way (`forgetUser`)
//   data/<memory.vaultDir>/                  the owner's plain copies taken before a forget
//                                            (`forget-<userId>-<ts>/`) or a wipe (`wipe-<ts>/`); never read
//
// Everything is cached in memory, marked dirty on change and flushed on a
// timer and on shutdown. Writes are atomic (temp file + rename) so a crash
// mid-write never corrupts a profile; when the OS refuses the rename the file
// is written in place instead, with a warning (see writeJsonAtomic).
//
// `forgetUser`, `forgetPrivate`, `removeLore` and `wipeGuild` are the only
// functions in the whole project allowed to delete stored memory (see
// src/admin.js, the owner-only `/nep memory forget`, `/nep private forget`,
// `/nep lore remove` and `/nep memory wipe` commands); `applyLedger` only repeats
// finished forgets. A forget and a wipe copy what they remove into the vault first,
// and a forget reaches every copy of the member: the archive, the record, the
// journal, the diary, the request dumps, the snapshots and the meaning index's rows
// (see `forgetUser`). A
// forget also takes the member's items out of the voice queue, at once on disk; a wipe deletes the
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
//
// With the archive on (src/memory/archive.js, `features.archive`), whatever one of
// these retentions, a cap or an analyzer op takes out of a list stays in it, over
// the cap, until the archive confirms its copy; only then does `trimArchived`
// finish the removal. So no file here loses an item before the archive holds it
// (see "The archive" inside createStore). A forget and a wipe are not archived.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from '../config.js';
import { log } from '../log.js';
import { HOUR_MS, utcDay } from '../time.js';
import { emptyAffinity, applyDelta, decayAffinity } from './affinity.js';
import { mergeEpisodes } from './episodes.js';
import { loreVersionKey, upsertLore } from './lore.js';
import { sentenceDiff } from './prose.js';
import { applyInterestOps, applyValidity, attachDropped, normalizeInterests, normalizeTopic, stripTrailingParenthetical, validDay } from './interests.js';
import { applyDetailOps, normalizeDetails } from './details.js';
import { applyAliasOps } from './aliases.js';
import { applyAddressUses, normalizeAddressedAs } from './addressed.js';
import { clampText, stripUrls } from './clamp.js';
import { feltLine, recordDrops } from './record.js';
import { sortByRank } from './ranking.js';
import { mergeEmojiUsage, normalizeEmojiUsage } from './emoji-usage.js';
import { emptyGifs, findGif, markOwnGif, mergeGifs, normalizeBackfillStamp, normalizeGifs, resetGifCounts } from './gifs.js';
import { FEELING_CHARS, REASON_CHARS, SELF_CHARS, forgetMember, normalizeQueue } from './voice.js';
import { emptyRecent, mergeRecent, normalizeRecent, purgeRecentFor } from './recent.js';
import { PARTICIPATION_DEFAULTS, emptyParticipation, expireEpisodes, normalizeParticipation, purgeParticipationFor } from './participation.js';
import { ITEM_ID_PREFIX, archiveDrops, archiveEntry, archiveRevision } from './archive.js';
import { journalDrops, requestMentions } from './journal.js';
import { redactUser } from './mentions.js';
import { normalizeAvatar } from './avatars.js';
import { DEFAULT_VAULT_DIR, SNAPSHOTS_DIR, memoryRootOf } from './root.js';

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
/** Every text field of the guild memory `updateGuild` writes, the lists included: none keeps a link. */
const GUILD_TEXT = [...GUILD_PROSE, 'injokes', 'self'];

/** `memory.maxClosedStored` when it is missing (config.json carries the same). */
const DEFAULT_MAX_CLOSED_STORED = 40;
/** `archive.holdMaxMs` when it is missing (config.json carries the same). */
const DEFAULT_HOLD_MAX_MS = 5000;
/** The kinds a profile's `closed` list holds (src/memory/interests.js#applyValidity). */
const CLOSED_KINDS = ['interest', 'detail', 'alias', 'realName'];
/** How long a stored real name may be. */
const REAL_NAME_CHARS = 60;

/** The diary of a guild with no post yet (data/guilds/<id>/diary.json). */
const emptyDiary = () => ({ posts: [], updatedAt: 0 });

/** The prefix of an item's `itemId` by kind (src/memory/archive.js#ITEM_ID_PREFIX, the one copy). */
export { ITEM_ID_PREFIX };

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

/**
 * The list a held archive victim lives in: `{ holder, key }` with `holder[key]` the list, found by
 * walking `keys` from `value` (`['episodes']`, `['affinity', 'history']`, ...); null when a step on
 * the way is not an object.
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {{ holder: object, key: string }|null}
 */
function listAt(value, keys) {
  let holder = value;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(holder?.[key])) return null;
    holder = holder[key];
  }
  return isPlainObject(holder) ? { holder, key: keys.at(-1) } : null;
}

/** How a held victim is found in its list: an object by its `itemId`, a plain string by its normalized text. */
function identOf(strings, item) {
  if (strings) return normalizeTopic(typeof item === 'string' ? item : item?.text);
  return typeof item?.itemId === 'string' && item.itemId ? item.itemId : null;
}

/** An item without its `itemId`, as JSON (a string by its normalized text): tells a stored item from its stamped copy. */
function anchorKey(strings, item) {
  if (strings) return normalizeTopic(typeof item === 'string' ? item : item?.text);
  if (!isPlainObject(item)) return JSON.stringify(item);
  const { itemId, ...rest } = item;
  return JSON.stringify(rest);
}

/**
 * `current` (a list after a write) with every one of `victims` it no longer holds put back where
 * it stood in `previous` (before the next item of `previous` that `current` still holds, else after the
 * nearest earlier one it still holds, else first; a victim `previous` never held goes last). A string
 * list gets the victims' `text` back. Pure.
 * @param {unknown[]} previous
 * @param {unknown[]} current
 * @param {object[]} victims  Objects with an `itemId`, or `{ itemId, text }` for a string list.
 * @param {boolean} strings
 * @returns {unknown[]}
 */
function reinsert(previous, current, victims, strings) {
  const result = [...current];
  const before = Array.isArray(previous) ? previous : [];
  const beforeKeys = before.map((item) => anchorKey(strings, item));
  const sameAs = (a, b) => anchorKey(strings, a) === anchorKey(strings, b) || (!strings && identOf(false, a) !== null && identOf(false, a) === identOf(false, b));
  for (const victim of victims) {
    if (result.some((item) => sameAs(item, victim))) continue;
    const from = beforeKeys.indexOf(anchorKey(strings, victim));
    let at = result.length;
    if (from !== -1) {
      at = -1;
      for (let i = from + 1; i < before.length && at === -1; i += 1) at = result.findIndex((item) => sameAs(item, before[i]));
      // Nothing after it is left: right after the nearest earlier one still there, else first.
      for (let i = from - 1; i >= 0 && at === -1; i -= 1) {
        const index = result.findIndex((item) => sameAs(item, before[i]));
        if (index !== -1) at = index + 1;
      }
      if (at === -1) at = 0;
    }
    result.splice(at, 0, strings ? victim.text : victim);
  }
  return result;
}

/** The identities an op's `remove` list names: normalized texts, and ids as strings. */
function removeKeysOf(list) {
  const keys = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw === 'string' && raw.trim()) keys.add(normalizeTopic(stripTrailingParenthetical(raw).topic));
    if (typeof raw === 'string' && raw.trim()) keys.add(normalizeTopic(raw));
    if (typeof raw === 'number' && Number.isFinite(raw)) keys.add(String(raw));
  }
  return keys;
}

/**
 * The archive event of a ranked item (interest, detail, alias, lesson) a write dropped: `replaced`
 * when an op's `remove` named it, `merged` when it was an interest folded into another under its
 * topic without the trailing qualifier, else `evicted` (the cap).
 * @param {object} victim
 * @param {string} identity  The item's identity field (`topic`, `text`, `name`).
 * @param {Set<string>} removing  removeKeysOf(ops.remove)
 * @param {object[]} kept  The list after the write.
 * @param {boolean} interest
 * @returns {'replaced'|'merged'|'evicted'}
 */
function rankedEvent(victim, identity, removing, kept, interest) {
  const key = normalizeTopic(victim?.[identity]);
  if (removing.has(key) || (Number.isFinite(victim?.id) && removing.has(String(victim.id)))) return 'replaced';
  if (interest) {
    const base = normalizeTopic(stripTrailingParenthetical(victim?.topic).topic);
    if (base !== key && kept.some((item) => normalizeTopic(item?.topic) === base)) return 'merged';
  }
  return 'evicted';
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
      bad.push(memoryRootOf(dataDir).relative(file));
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

/** `memory.vaultDir` when it is missing and the snapshots directory: src/memory/root.js, re-exported here. */
export { DEFAULT_VAULT_DIR, SNAPSHOTS_DIR };
/** `labels.memory.redaction` when it is missing (prompts/labels.json carries the same). */
export const DEFAULT_REDACTION = 'someone';
/** A member id usable as a file name (the forget marker's rule, src/memory/journal.js). */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The `owner` of a forget marker this module writes (src/memory/journal.js leaves it in place). */
const MARKER_OWNER = 'store';
const MONTH_DIR_RE = /^\d{4}-\d{2}$/;
const DAY_JSONL_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const REQUEST_DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const TORN_JSONL_RE = /\.jsonl\.torn-/;

/** `ms` as a UTC time usable in a file name: `2026-10-13T12-00-00-000Z`. */
function fileStamp(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/** The names under `dir`, sorted; [] when it is missing. */
function namesIn(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** How many files there are under `dir`, recursively; 0 when it is missing. */
function filesIn(dir) {
  let count = 0;
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of list) count += entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : 1;
  return count;
}

/** A parsed JSONL line, or null. */
function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** The whole lines of a JSONL file and its torn tail (the bytes after the last newline); none when missing. */
function jsonlOf(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { lines: [], tail: '' };
  }
  const parts = text.split('\n');
  const tail = parts.pop();
  return { lines: parts.filter((line) => line !== ''), tail };
}

/**
 * Rewrite a JSONL file keeping the lines `keep` accepts (a torn tail stays as it is), atomically;
 * for a file no append store holds open (a tool's copy, a test). Returns how many lines went.
 */
function filterJsonlSync(file, keep) {
  const { lines, tail } = jsonlOf(file);
  const kept = lines.filter((line) => keep(line));
  const dropped = lines.length - kept.length;
  if (dropped > 0) writeTextAtomic(file, `${kept.map((line) => `${line}\n`).join('')}${tail}`);
  return dropped;
}

/**
 * Whether a forget of `userId` drops a line of the backfill tool's candidates
 * (`backfill/candidates.jsonl`, tools/backfill.mjs): the member is its member, its teacher, one of
 * its `participants` or the author of one of its `sourceRefs`. Every such line, whatever its date.
 * @param {object} candidate
 * @param {string} userId
 * @returns {boolean}
 */
export function backfillDrops(candidate, userId) {
  if (!isPlainObject(candidate)) return false;
  const id = String(userId);
  if (candidate.userId === id || candidate.from === id) return true;
  if (Array.isArray(candidate.participants) && candidate.participants.includes(id)) return true;
  const refs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : [];
  return refs.some((ref) => isPlainObject(ref) && (ref.by === id || ref.authorId === id));
}

/** A ledger file's entries (`[{ userId, at }]`), [] when it is missing or not a list. */
function readLedgerFile(file) {
  const value = readJson(file, []);
  return Array.isArray(value) ? value.filter((entry) => isPlainObject(entry) && typeof entry.userId === 'string') : [];
}

/**
 * The deletion ledger of a guild, `data/guilds/<guildId>/forgotten.json`: `[{ userId, at }]`, one
 * entry per completed `/nep memory forget`, oldest first; [] when there is none. A tool reads the
 * live one and hands it to `store.applyLedger` over its copy of a snapshot.
 * @param {string} dataDir  a `data/` directory, or a snapshot of one
 * @param {string} guildId
 * @returns {Array<{ userId: string, at: string }>}
 */
export function readLedger(dataDir, guildId) {
  return readLedgerFile(memoryRootOf(dataDir).forgottenFile(guildId));
}

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
  // Absent stays absent (an old file loads unchanged); a hand-broken one is cleaned or dropped.
  if ('addressedAs' in profile) profile.addressedAs = normalizeAddressedAs(profile.addressedAs);
  if ('realName' in profile) {
    const realName = normalizeRealName(profile.realName);
    if (realName) profile.realName = realName;
    else delete profile.realName;
  }
  normalizeClosed(profile);
  // Only `true` is the flag; anything else a hand edit left is no flag.
  if ('relationshipRewrite' in profile && profile.relationshipRewrite !== true) delete profile.relationshipRewrite;
  // The current avatar (src/memory/avatars.js): absent stays absent, a hand-broken one goes.
  if ('avatar' in profile) {
    const avatar = normalizeAvatar(profile.avatar);
    if (avatar) profile.avatar = avatar;
    else delete profile.avatar;
  }
}

/** A stored `realName` (`{ name, from, to: null, itemId, recordedAt? }`) as it may be kept: a
 * non-empty string `name`; `from` a real day or null; `itemId`/`recordedAt` only when non-empty
 * strings. Anything else is null (the field goes). */
function normalizeRealName(value) {
  if (!isPlainObject(value) || typeof value.name !== 'string' || !value.name.trim()) return null;
  const out = { name: value.name, from: validDay(value.from), to: null };
  if (typeof value.itemId === 'string' && value.itemId) out.itemId = value.itemId;
  if (typeof value.recordedAt === 'string' && value.recordedAt) out.recordedAt = value.recordedAt;
  return out;
}

/**
 * Apply one batch's `realName` answer to a profile's stored real name. `raw` is a string or
 * `{ name, supersedes?, validFrom? }`; the name is trimmed and clamped to 60 characters. Nothing
 * changes for a missing or empty name, nor for one equal to the stored one (case-insensitive: a
 * sighting). With nothing stored, the name is set. A different name replaces the stored one only
 * when `supersedes` names it (its `itemId` or its name, src/memory/interests.js#applyValidity):
 * the stored one is closed (`validTo` = `validFrom` when given, else the batch day; `supersededBy`
 * = the new `itemId`) and returned for the profile's `closed` list; without that the stored name
 * stays. The new value is `{ name, from, to: null, itemId, recordedAt }`, `from` = `validFrom`
 * when it is a real day, else the batch day.
 * @param {object|undefined} stored  The profile's `realName`.
 * @param {unknown} raw
 * @param {{ seenAt: number, now?: number, mintId: () => string }} opts
 * @returns {{ realName: object, closed: object[] }|null}  null when nothing changes.
 */
function applyRealName(stored, raw, { seenAt, now, mintId }) {
  const op = isPlainObject(raw) ? raw : { name: raw };
  if (typeof op.name !== 'string') return null;
  const name = clampText(stripUrls(op.name), REAL_NAME_CHARS, { tolerance: 1 });
  if (!name) return null;
  const batchDay = new Date(seenAt).toISOString().slice(0, 10);
  const recordedAt = new Date(Number.isFinite(now) ? now : seenAt).toISOString();
  const fresh = () => ({ name, from: validDay(op.validFrom) ?? batchDay, to: null, itemId: mintId(), recordedAt });
  if (!stored) return { realName: fresh(), closed: [] };
  if (normalizeTopic(stored.name) === normalizeTopic(name)) return null;
  // The stored name as a ranked-item claim, so the shared validity rules close it.
  const current = { name: stored.name, validFrom: stored.from ?? undefined, itemId: stored.itemId, recordedAt: stored.recordedAt };
  if (current.validFrom === undefined) delete current.validFrom;
  const next = { name };
  const items = [current, next];
  const closed = applyValidity(items, [{ item: next, supersedes: op.supersedes, validFrom: op.validFrom }], {
    batchDay,
    recordedAt,
    mintId,
    findOther: (ref) => (typeof ref === 'string' && normalizeTopic(ref) === normalizeTopic(current.name) ? current : undefined),
  });
  if (closed.length === 0) return null;
  return {
    realName: { name, from: next.validFrom ?? batchDay, to: null, itemId: next.itemId ?? mintId(), recordedAt },
    closed: closed.map((item) => {
      const out = { ...item };
      // The archive knows a closed claim by its itemId: a hand-edited name without one gets one.
      if (!out.itemId) out.itemId = mintId();
      if (!out.recordedAt) delete out.recordedAt;
      return out;
    }),
  };
}

/** A profile's or private layer's `closed` list (the claims a `supersedes` closed, see
 * `storeClosed`), in place: absent stays absent (an old file loads unchanged); anything but a
 * list becomes `[]`; an entry that is no object or of no known kind is left out. */
function normalizeClosed(holder) {
  if (!('closed' in holder)) return;
  holder.closed = Array.isArray(holder.closed) ? holder.closed.filter((item) => isPlainObject(item) && CLOSED_KINDS.includes(item.kind)) : [];
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
  normalizeClosed(priv);

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
 * stamps -- the one writer of that field for `applyProfileOps` and `applyPrivateOps`. The text
 * loses its links first (`stripUrls`); only a non-empty string is written (an absent or blank one,
 * or one that was only links, never blanks the stored text). A first write
 * (the stored text is empty) is clamped to `opts.relationshipChars` (`relationships.textChars`),
 * else `opts.fieldChars`; a rewrite is stored as given, never cut (`firstWriteText`). Stamped next to
 * it: `relationshipScore` (see `relationshipScoreOf`) and `relationshipWrittenAt`, the ISO time of
 * `opts.now` (else the wall clock) -- the clock the batch's attitude moves are stamped with
 * (src/memory/affinity.js#applyDelta), so src/memory/affinity.js#relationshipStaleOf counts the
 * moves since the text like with like. A profile written before the stamp existed keeps none
 * until its next text. A written text removes the forced-rewrite flag (`relationshipRewrite`,
 * see `markRelationshipRewrite`): the rewrite it asked for has happened.
 * @param {object} target  A normalised profile or private layer.
 * @param {unknown} raw
 * @param {object} opts    As for `applyProfileOps`.
 * @param {(previous: unknown, next: string) => void} [onWrite]  Called with the stored text and the
 *   one replacing it, before the write (the public profile records a version through it).
 */
function writeRelationship(target, raw, opts, onWrite) {
  const text = typeof raw === 'string' ? stripUrls(raw) : raw;
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

/**
 * `fields` with the links taken out (`stripUrls`) of every string or list of strings that `keys`
 * names. A string that held only links is left out of the copy, and so is such an entry of a list,
 * so it never blanks a stored text. Every other field is kept as given.
 * @param {object} fields
 * @param {string[]} keys
 * @returns {object}  A shallow copy.
 */
function withoutLinks(fields, keys) {
  const out = { ...fields };
  const clean = (value) => (typeof value === 'string' ? stripUrls(value) : value);
  const emptied = (value, cleaned) => typeof value === 'string' && value.trim() !== '' && cleaned === '';
  for (const key of keys) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map(clean).filter((cleaned, i) => !emptied(value[i], cleaned));
    } else if (typeof value === 'string') {
      const cleaned = clean(value);
      if (emptied(value, cleaned)) delete out[key];
      else out[key] = cleaned;
    }
  }
  return out;
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
 * @returns {{ interests: object[], details: object[], closed: { interest: object[], detail: object[] } }}
 *   The stored items that left (removed, folded into another, evicted); `closed`: the claims a
 *   `supersedes` closed, for `storeClosed`.
 */
function applyItemOps(target, ops, opts, seenAt, newId) {
  const dropped = { interests: [], details: [], closed: { interest: [], detail: [] } };
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
      mintId: () => `${ITEM_ID_PREFIX.interest}${newId()}`,
      now: opts.now,
    });
    target.interests = changedWithItemIds(target.interests, interests, ITEM_ID_PREFIX.interest, newId);
    dropped.interests = withItemIds(interests.dropped, ITEM_ID_PREFIX.interest, newId);
    dropped.closed.interest = withItemIds(interests.closed, ITEM_ID_PREFIX.interest, newId);
  }
  if (isPlainObject(ops?.details)) {
    const { items, nextId, dropped: gone, closed } = applyDetailOps(target.details, ops.details, {
      maxDetails: opts.maxDetails,
      maxDetailsStored: opts.maxDetailsStored,
      fieldChars: opts.fieldChars,
      confirmGapHours: opts.confirmGapHours,
      halfLifeDays: opts.detailHalfLifeDays,
      clampTolerance: opts.clampTolerance,
      seenAt,
      nextId: target.detailsSeq,
      mintId: () => `${ITEM_ID_PREFIX.detail}${newId()}`,
      now: opts.now,
    });
    target.details = changedWithItemIds(target.details, items, ITEM_ID_PREFIX.detail, newId);
    target.detailsSeq = nextId;
    dropped.details = withItemIds(gone, ITEM_ID_PREFIX.detail, newId);
    dropped.closed.detail = withItemIds(closed, ITEM_ID_PREFIX.detail, newId);
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
 *   `archive` (src/memory/archive.js#createArchive, optional): while `archiveOn()` (read at each
 *   write; src/index.js passes features.archive exactly true) nothing leaves a hot list on disk
 *   before its copy is in the archive -- see "The archive" inside, `settleArchive`,
 *   `drainArchive` and `trimArchived`.
 *   `vectors` (src/memory/vectors.js#createVectors, optional): the meaning index a forget and the
 *   ledger take the member's rows out of (`forgetUser`, `applyLedger`); without it they leave the
 *   index alone (its search hides the ledger's members anyway).
 *   `memoryRead` (src/memory/db/service.js#createMemoryDb's `reader`, optional): the read switch of the memory
 *   database (spec 2026-10-24-memory-store, section 7). `value(file)` returns `{ found: true, value }` when the
 *   database holds the file's value (the first load of a cache entry takes it instead of `readJson`) and
 *   `ids(dir)` the ids under a directory; either returns null while the switch is off or the database has
 *   nothing, and the store reads the disk as before. Writes are unchanged. `afterFlush` (optional) is called after
 *   a flush that wrote files (the database sync follows it); a throw there is swallowed.
 */
export function createStore({ dataDir, newId = randomUUID, record = null, recordOn = () => Boolean(record), archive = null, archiveOn = () => Boolean(archive), vectors = null, memoryRead = null, afterFlush = null }) {
  const root = memoryRootOf(dataDir);
  const entries = new Map(); // file path -> { value, dirty }

  // ---- The archive (src/memory/archive.js): nothing leaves a hot list without a copy ----
  //
  // With an archive injected and `archiveOn()` true, every item a write drops (a cap, an expiry,
  // an analyzer's remove, a list replaced whole, an interest folded into another) stays in its
  // list in the cache -- over the cap -- and its archive entry is queued for the guild. The writers
  // stay synchronous: the queue is appended in the background (`archive.append`), and once the
  // archive confirms an entry `trimArchived` takes the item out of its list. So a flush can only
  // write a file without the item after its copy is in the archive. A refused append sends the
  // entries to the archive's pending queue, the items stay hot, and the drain (`drainArchive`, on
  // src/index.js's timer) archives and trims them later. A write that changes an item's text in
  // place (an interest's note) queues the previous version (`replaced`); the new one is already
  // hot. A later merge that keeps an item held for the cap (it ranks again) releases it: the newest
  // merge's verdict stands; an item removed or replaced stays held until it is archived. `archiveMark` / `settleArchive` tell a caller what became of the entries its
  // writes queued.

  /** Outcomes kept for `settleArchive` per guild, oldest dropped first. */
  const ARCHIVE_OUTCOMES_KEPT = 5000;
  // guildId -> { seq, queue: [{ seq, entry, privateUserId }], held: [...], outcomes: Map(seq -> outcome),
  //   retry: [...] (entries neither archived nor queued as pending), chain: Promise, scheduled: boolean }
  const archiveGuilds = new Map();

  /** Whether writes archive their victims now: an archive injected and `archiveOn()` true (read now). */
  function archiving() {
    return Boolean(archive) && archiveOn() === true;
  }

  function archiveGuild(guildId) {
    const key = String(guildId);
    let state = archiveGuilds.get(key);
    if (!state) {
      state = { seq: 0, queue: [], held: [], outcomes: new Map(), retry: [], chain: Promise.resolve(), scheduled: false };
      archiveGuilds.set(key, state);
    }
    return state;
  }

  /**
   * Queue one entry for the background append of `guildId`'s archive (the member's private one
   * with `privateUserId`). With `holdItem` (the cache entry whose file already holds the item's
   * NEW version) that file is held back from every flush (`holdFlush`) until the archive or its
   * pending queue took the entry (`releaseHold`).
   */
  function queueArchiveEntry(guildId, entry, privateUserId = null, holdItem = null) {
    const state = archiveGuild(guildId);
    state.seq += 1;
    if (holdItem) holdItem.holdFlush = (holdItem.holdFlush ?? 0) + 1;
    state.queue.push({ seq: state.seq, entry, privateUserId, holdItem });
    if (state.scheduled) return;
    state.scheduled = true;
    state.chain = state.chain
      .then(() => {
        state.scheduled = false;
        return sendArchiveQueue(guildId);
      })
      .catch((error) => log.warn('store: archive failed', { guildId: String(guildId), code: error?.code ?? null }));
  }

  /** Let the file a queued entry held back be flushed again (once per entry). */
  function releaseHold(queued) {
    const item = queued?.holdItem;
    if (!item) return;
    queued.holdItem = null;
    item.holdFlush = Math.max(0, (item.holdFlush ?? 0) - 1);
  }

  /** Mark the held victim of `entry` confirmed: the archive holds its copy. */
  function confirmHeld(state, entry) {
    for (const held of state.held) {
      if (held.itemId === entry?.itemId && held.revisionId === entry?.revisionId) held.confirmed = true;
    }
  }

  function noteOutcome(state, queued, status) {
    if (status === 'archived') confirmHeld(state, queued.entry);
    const { itemId, revisionId, itemKind, event } = queued.entry;
    state.outcomes.set(queued.seq, { status, itemId, revisionId, itemKind, event });
    while (state.outcomes.size > ARCHIVE_OUTCOMES_KEPT) state.outcomes.delete(state.outcomes.keys().next().value);
  }

  /** `queued` grouped by the archive they go to: the guild's (`''`) or a member's private one. */
  function byArchive(queued) {
    const groups = new Map();
    for (const item of queued) {
      const key = item.privateUserId ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return groups;
  }

  /**
   * Append `queued` to the archive; a refused group goes to the archive's pending queue (kept in
   * memory for the drain when even that fails). Returns the outcome of each group.
   */
  async function appendQueued(guildId, queued) {
    const state = archiveGuild(guildId);
    const results = [];
    for (const [key, group] of byArchive(queued)) {
      const opts = key ? { privateUserId: key } : {};
      const entries = group.map((item) => item.entry);
      try {
        await archive.append(guildId, entries, opts);
        group.forEach(releaseHold);
        results.push({ group, status: 'archived' });
      } catch (error) {
        log.warn('store: archive failed', { guildId: String(guildId), entries: entries.length, ...(key ? { private: true } : {}), code: error?.code ?? null });
        try {
          await archive.queuePending(guildId, entries, opts);
          group.forEach(releaseHold);
        } catch (queueError) {
          log.warn('store: archive queue failed', { guildId: String(guildId), entries: entries.length, code: queueError?.code ?? null });
          state.retry.push(...group);
        }
        results.push({ group, status: 'deferred' });
      }
    }
    return results;
  }

  async function sendArchiveQueue(guildId) {
    const state = archiveGuild(guildId);
    const queued = state.queue.splice(0);
    if (queued.length === 0) return;
    for (const { group, status } of await appendQueued(guildId, queued)) {
      for (const item of group) noteOutcome(state, item, status);
    }
    trimArchived(guildId);
  }

  /**
   * Hold what one write dropped from one list: each victim goes back into its list (where it
   * stood) and its archive entry is queued, unless the same version is held already. Held items
   * of this list the write kept are released. Call it only for a list the write really merged.
   * @param {string} guildId
   * @param {{ item: { value: object, dirty: boolean }, file: string, path: string[], strings?: boolean,
   *   previous: unknown[], victims: object[], itemKind: string, eventOf: (victim: object, index: number) => string,
   *   scope: object|((victim: object) => object), privateUserId?: string|null, userId?: string|null }} site
   */
  function holdVictims(guildId, site) {
    if (!archiving()) return;
    const state = archiveGuild(guildId);
    const strings = site.strings === true;
    const siteKey = `${site.file}#${site.path.join('.')}`;
    const where = listAt(site.item.value, site.path);
    if (!where) return;
    const current = Array.isArray(where.holder[where.key]) ? where.holder[where.key] : [];
    const victims = (Array.isArray(site.victims) ? site.victims : []).filter((victim) => (strings ? typeof victim?.text === 'string' : isPlainObject(victim) && identOf(false, victim) !== null));
    const victimIds = new Set(victims.map((victim) => identOf(strings, victim)));
    // A victim of the cap that this write's merge kept ranks again: released. A removed or replaced one stays held.
    state.held = state.held.filter((held) => held.siteKey !== siteKey || held.event !== 'evicted' || victimIds.has(held.ident) || !current.some((item) => identOf(strings, item) === held.ident));
    if (victims.length === 0) return;
    victims.forEach((victim, index) => {
      const ident = identOf(strings, victim);
      const revisionId = archiveRevision(site.itemKind, victim);
      if (state.held.some((held) => held.siteKey === siteKey && held.ident === ident && held.revisionId === revisionId)) return;
      const scope = typeof site.scope === 'function' ? site.scope(victim) : site.scope;
      const entry = archiveEntry(victim, { itemKind: site.itemKind, event: site.eventOf(victim, index), scope, uuid: newId });
      state.held.push({ siteKey, file: site.file, path: site.path, strings, ident, itemId: entry.itemId, revisionId, itemKind: site.itemKind, event: entry.event, userId: site.userId ?? null, confirmed: false });
      queueArchiveEntry(guildId, entry, site.privateUserId ?? null);
    });
    where.holder[where.key] = reinsert(site.previous, current, victims, strings);
    site.item.dirty = true;
  }

  /**
   * Queue the previous version of every item of `previous` whose text `current` changed in place
   * (same `itemId`, another revision) with event `replaced`. The item stays; `item` (the cache
   * entry of the file) is held back from the flush until the old version is archived.
   */
  function archiveReplaced(guildId, { previous, current, itemKind, scope, privateUserId = null, item = null }) {
    if (!archiving() || !Array.isArray(previous) || !Array.isArray(current)) return;
    const now = new Map(current.filter((item) => identOf(false, item) !== null).map((item) => [item.itemId, item]));
    for (const before of previous) {
      const after = identOf(false, before) !== null ? now.get(before.itemId) : undefined;
      if (!after || archiveRevision(itemKind, after) === archiveRevision(itemKind, before)) continue;
      queueArchiveEntry(guildId, archiveEntry(before, { itemKind, event: 'replaced', scope, uuid: newId }), privateUserId, item);
    }
  }

  /**
   * The ranked lists of a member file one write merged (interests, details, aliases): the
   * victims held, the texts changed in place archived.
   */
  function archiveProfileItems(guildId, userId, { item, file, previous, dropped, ops, privateUserId = null }) {
    if (!archiving()) return;
    const id = String(userId);
    const scope = { user: id };
    for (const [field, itemKind, identity] of [['interests', 'interest', 'topic'], ['details', 'detail', 'text'], ['aliases', 'alias', 'name']]) {
      if (!isPlainObject(ops?.[field])) continue;
      const kept = Array.isArray(item.value[field]) ? item.value[field] : [];
      const removing = removeKeysOf(ops[field].remove);
      archiveReplaced(guildId, { previous: previous[field], current: kept, itemKind, scope, privateUserId, item });
      holdVictims(guildId, {
        item, file, path: [field], previous: previous[field], victims: dropped[field], itemKind, scope, privateUserId, userId: id,
        eventOf: (victim) => rankedEvent(victim, identity, removing, kept, itemKind === 'interest'),
      });
    }
  }

  /**
   * Append the claims one write closed (`closed`, by kind) to the `closed` list of a profile or
   * private layer (`target`, the value of `item`), every one tagged with its `kind`, then keep
   * the newest `opts.maxClosedStored` (config.json's 40 when missing). What falls off the front
   * leaves through the archive with event `replaced` (held like any victim, see `holdVictims`);
   * with the archive off it simply goes.
   */
  function storeClosed(guildId, userId, { item, file, target, closed, opts, privateUserId = null }) {
    const incoming = CLOSED_KINDS.flatMap((kind) => (Array.isArray(closed?.[kind]) ? closed[kind] : []).map((value) => ({ kind, ...value })));
    if (incoming.length === 0) return;
    const cap = Number.isInteger(opts?.maxClosedStored) && opts.maxClosedStored >= 0 ? opts.maxClosedStored : DEFAULT_MAX_CLOSED_STORED;
    const all = [...(Array.isArray(target.closed) ? target.closed : []), ...incoming];
    target.closed = all.slice(Math.max(0, all.length - cap));
    const evicted = all.slice(0, all.length - target.closed.length);
    item.dirty = true;
    const id = String(userId);
    for (const kind of CLOSED_KINDS) {
      const victims = evicted.filter((value) => value.kind === kind);
      if (victims.length === 0) continue;
      holdVictims(guildId, {
        item, file, path: ['closed'], previous: all, victims, itemKind: kind, scope: { user: id }, privateUserId, userId: id,
        eventOf: () => 'replaced',
      });
    }
  }

  /** Take the confirmed victims out of their lists (see "The archive" above); returns how many went. */
  function trimArchived(guildId) {
    const state = archiveGuilds.get(String(guildId));
    // /nep pause: nothing may make the store dirty while paused; the holds wait for the resume.
    if (!state || stateEntry.value.paused) return 0;
    let trimmed = 0;
    const keep = [];
    for (const held of state.held) {
      if (!held.confirmed) {
        keep.push(held);
        continue;
      }
      const item = entries.get(held.file);
      // A file not in the cache (unloaded by a pause) is trimmed once it is read again.
      if (!item) {
        keep.push(held);
        continue;
      }
      const where = listAt(item.value, held.path);
      const list = where && Array.isArray(where.holder[where.key]) ? where.holder[where.key] : null;
      const index = list ? list.findIndex((value) => identOf(held.strings, value) === held.ident) : -1;
      // Gone already, or changed since it was held: a later write owns it now.
      if (index === -1 || archiveRevision(held.itemKind, list[index]) !== held.revisionId) continue;
      where.holder[where.key] = list.filter((_, i) => i !== index);
      item.dirty = true;
      trimmed += 1;
    }
    state.held = keep;
    if (trimmed > 0) log.info('store: archive trimmed', { guildId: String(guildId), trimmed });
    return trimmed;
  }

  /** Where an archived item goes back to (`restoreArchived`): its cache entry (null without the file) and list; null for a kind that cannot. */
  function restoreTarget(guildId, archived) {
    const userId = typeof archived?.scope?.user === 'string' ? archived.scope.user : null;
    const isPrivate = archived?.scope?.private === true;
    const member = (keys) => {
      if (!userId) return null;
      if (isPrivate) return { item: hasPrivate(guildId, userId) ? privateEntry(guildId, userId) : null, path: keys };
      return { item: store.getUser(guildId, userId) ? entries.get(userFile(guildId, userId)) : null, path: keys };
    };
    const guild = (keys, strings = false) => {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      return { item, path: keys, strings };
    };
    switch (archived?.itemKind) {
      case 'episode': return member(['episodes']);
      case 'interest': return member(['interests']);
      case 'detail': return member(['details']);
      case 'alias': return isPrivate ? null : member(['aliases']);
      case 'lesson': return guild(['learned']);
      case 'selfFact': return guild(['self'], true);
      case 'injoke': return guild(['injokes'], true);
      case 'diary': return { item: diaryEntry(guildId), path: ['posts'] };
      default: return null;
    }
  }

  /** Let go of what one member left in the archive queue and holds (a forget): nothing of theirs is archived later. */
  function forgetArchived(guildId, userId, { privateOnly = false } = {}) {
    const state = archiveGuilds.get(String(guildId));
    if (!state) return;
    const id = String(userId);
    const privateFileOf = privateFile(guildId, id);
    const concerns = (queued) =>
      queued.privateUserId === id || (!privateOnly && (queued.entry?.scope?.user === id || (Array.isArray(queued.entry?.participants) && queued.entry.participants.includes(id))));
    for (const queued of [...state.queue, ...state.retry]) if (concerns(queued)) releaseHold(queued);
    state.queue = state.queue.filter((queued) => !concerns(queued));
    state.retry = state.retry.filter((queued) => !concerns(queued));
    state.held = state.held.filter((held) => (privateOnly ? held.file !== privateFileOf : held.userId !== id));
  }

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
      const fromDb = memoryRead?.value(file) ?? null;
      item = { value: fromDb?.found === true ? fromDb.value : readJson(file, fallback()), dirty: false };
      entries.set(file, item);
    }
    return item;
  }

  /** Every id found under `dir`'s `.json` files, on disk or only cached (no side effects on the cache). */
  function idsUnder(dir) {
    const ids = new Set();
    const fromDb = memoryRead?.ids(dir) ?? null;
    if (Array.isArray(fromDb)) {
      for (const id of fromDb) ids.add(id);
    } else {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith('.json')) ids.add(name.slice(0, -5));
        }
      } catch {
        // the directory does not exist yet
      }
    }
    const prefix = dir + path.sep;
    for (const file of entries.keys()) {
      if (file.startsWith(prefix)) ids.add(path.basename(file, '.json'));
    }
    return [...ids];
  }

  /**
   * Write one dirty cache entry to disk; a failed write is logged and stays dirty for the next
   * flush. An entry held for the archive (`holdFlush` > 0: the old version of an item its file
   * replaced in place is not archived yet, see `archiveReplaced`) is skipped unless `force`.
   * @returns {'clean'|'held'|'written'|'failed'}
   */
  function flushEntry(file, item, { force = false } = {}) {
    if (!item.dirty) return 'clean';
    if (!force && item.holdFlush > 0) return 'held';
    try {
      writeJsonAtomic(file, item.value);
      item.dirty = false;
      return 'written';
    } catch (err) {
      log.error('store: flush failed', { file, error: err });
      return 'failed';
    }
  }

  /** Flush every dirty cache entry (`flushEntry`); returns how many were written, failed and held. */
  function flushAll({ force = false } = {}) {
    const counts = { written: 0, failed: 0, held: 0 };
    for (const [file, item] of entries) {
      const outcome = flushEntry(file, item, { force });
      if (outcome !== 'clean') counts[outcome] += 1;
    }
    if (counts.written > 0 && afterFlush) {
      try { afterFlush(counts); } catch { /* the hook never fails a flush */ }
    }
    return counts;
  }

  const guildDir = root.guildDir;
  const usersDir = (guildId) => path.join(guildDir(guildId), 'users');
  const userFile = (guildId, userId) => path.join(usersDir(guildId), `${userId}.json`);
  const guildFile = (guildId) => path.join(guildDir(guildId), 'guild.json');
  const bufferFile = (guildId) => path.join(guildDir(guildId), 'buffer.json');
  const channelsDir = (guildId) => path.join(guildDir(guildId), 'channels');
  const channelFile = (guildId, channelId) => path.join(channelsDir(guildId), `${channelId}.json`);
  const mediaCacheFile = (guildId) => path.join(guildDir(guildId), 'media.json');
  const loreFile = (guildId) => path.join(guildDir(guildId), 'lore.json');
  const gifsFile = (guildId) => path.join(guildDir(guildId), 'gifs.json');
  const privateDir = (guildId) => root.privateDir(guildId);
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
  const stateFile = root.stateFile;

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
    holdVictims(guildId, {
      item,
      file: versionsFile(guildId, kind, id),
      path: [field],
      previous: list,
      victims: dropped,
      itemKind: 'version',
      eventOf: () => 'evicted',
      scope: kind === 'users' ? { user: String(id) } : kind === 'channels' ? { channel: String(id) } : { guild: true },
      userId: kind === 'users' ? String(id) : null,
    });
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
    const previous = Array.isArray(item.value.episodes) ? item.value.episodes : [];
    const before = new Set(previous);
    const { episodes, added, dropped } = mergeEpisodes(item.value.episodes, incoming, opts);
    const victims = withItemIds(dropped, ITEM_ID_PREFIX.episode, newId);
    if (added > 0) {
      const stamped = withItemIds(episodes, ITEM_ID_PREFIX.episode, newId);
      item.value.episodes = stamped;
      item.dirty = true;
      if (owner) recordFelt(owner.guildId, owner.userId, owner.layer, stamped.filter((_, i) => !before.has(episodes[i])));
      if (owner) {
        const id = String(owner.userId);
        const isPrivate = owner.layer === 'private';
        holdVictims(owner.guildId, {
          item,
          file: isPrivate ? privateFile(owner.guildId, id) : userFile(owner.guildId, id),
          path: ['episodes'],
          previous,
          victims,
          itemKind: 'episode',
          eventOf: () => 'evicted',
          scope: { user: id },
          privateUserId: isPrivate ? id : null,
          userId: id,
        });
      }
    }
    return { added, dropped: victims };
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

  /** The attitude moves an affinity write let go past the history size, held for the archive (`holdVictims`). */
  function holdMoves(guildId, userId, item, file, current, next, isPrivate = false) {
    if (next === current || !Array.isArray(next.droppedMoves)) return;
    const id = String(userId);
    holdVictims(guildId, {
      item,
      file,
      path: ['affinity', 'history'],
      previous: Array.isArray(current?.history) ? current.history : [],
      victims: next.droppedMoves,
      itemKind: 'move',
      eventOf: () => 'evicted',
      scope: { user: id },
      privateUserId: isPrivate ? id : null,
      userId: id,
    });
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
    const previous = item.value.posts;
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DIARY_HISTORY_POSTS;
    const all = withItemIds(posts, ITEM_ID_PREFIX.diary, newId);
    const kept = all.slice(-limit);
    item.value = { posts: kept, updatedAt: Number.isFinite(now) ? now : Date.now() };
    item.dirty = true;
    const dropped = all.slice(0, all.length - kept.length);
    holdVictims(guildId, { item, file: diaryFile(guildId), path: ['posts'], previous, victims: dropped, itemKind: 'diary', eventOf: () => 'evicted', scope: { guild: true } });
    return { dropped };
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

  // ---- Deletion: one rule across every copy, a vault before, a ledger after ----
  //
  // `forgetUser` is a marked, restartable job. Its marker, `forgetting/<userId>.json` (`owner:
  // 'store'`, the member's names and the vault path it fills), is written first and records each
  // finished step; readers hide the member while it exists (`getUser`, `getPrivate`, and the
  // journal's, record's and archive's readers by the same file). The first step copies everything
  // the job is about to remove or rewrite into `<memory.vaultDir>/forget-<userId>-<ts>/` under the
  // paths it has below `data/` (the lines dropped from an append-only file as
  // `<path>.dropped.jsonl`, chosen by the same rule the file's module applies); the vault is the
  // owner's, never read by the engine. The ledger entry is written last, then the marker goes.
  // `resumeForgets` finishes a marker a crash left; `applyLedger` takes out again whatever a
  // restored copy brought back from before a member's forget.

  const forgettingDir = root.forgettingDir;
  const markerFile = (guildId, userId) => path.join(forgettingDir(guildId), `${userId}.json`);
  const ledgerFile = root.forgottenFile;
  const memberDir = (guildId, userId) => root.privateDir(guildId, String(userId));
  const snapshotsRoot = root.snapshotsRoot;
  /** guildId -> the member ids under a forget marker, read from disk once per guild. */
  const forgettingIds = new Map();

  function forgettingSet(guildId) {
    const key = String(guildId);
    let set = forgettingIds.get(key);
    if (!set) {
      set = new Set(namesIn(forgettingDir(guildId)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)));
      forgettingIds.set(key, set);
    }
    return set;
  }

  /** Whether a forget of the member is under way (its marker exists): readers hide them. */
  function isForgetting(guildId, userId) {
    return forgettingSet(guildId).has(String(userId));
  }

  function checkUserId(userId) {
    const id = String(userId ?? '');
    if (!USER_ID_RE.test(id)) throw Object.assign(new Error('store: bad member id'), { code: 'bad-user-id' });
    return id;
  }

  /** The vault directory: `vaultDir` (`memory.vaultDir`) under `data/`, or as given when absolute. */
  function vaultRoot(vaultDir) {
    return root.vaultDir(vaultDir);
  }

  /** A stored JSON value as it is (the cache first, then the disk), with no normalising and no hiding; null when none. */
  function rawJson(file) {
    const cached = entries.get(file);
    if (cached) return cached.value;
    return fs.existsSync(file) ? readJson(file, null) : null;
  }

  /** The names a member is known by: the display names and aliases of their profile and private layer. */
  function memberNames(guildId, userId) {
    const names = [];
    for (const value of [rawJson(userFile(guildId, userId)), rawJson(privateFile(guildId, userId))]) {
      if (!isPlainObject(value)) continue;
      for (const name of Array.isArray(value.names) ? value.names : []) names.push(name);
      for (const alias of Array.isArray(value.aliases) ? value.aliases : []) names.push(alias?.name);
    }
    return [...new Set(names.filter((name) => typeof name === 'string' && name.trim()))];
  }

  /** The snapshot directories under `data/snapshots/`. */
  function snapshotDirs() {
    return namesIn(snapshotsRoot)
      .map((name) => path.join(snapshotsRoot, name))
      .filter((dir) => {
        try {
          return fs.statSync(dir).isDirectory();
        } catch {
          return false;
        }
      });
  }

  /** What one member leaves in a guild directory `guildPath` (live or inside a snapshot): profile, private layer, private directory, profile versions. */
  function memberPaths(guildPath, userId) {
    return [
      path.join(guildPath, 'users', `${userId}.json`),
      path.join(guildPath, 'private', `${userId}.json`),
      path.join(guildPath, 'private', String(userId)),
      path.join(guildPath, 'versions', 'users', `${userId}.json`),
    ];
  }

  /**
   * The guild's append-only files a forget rewrites, each with the rule of its module: the
   * archive's month segments and pending queue (src/memory/archive.js#archiveDrops), the record's
   * day files (src/memory/record.js#recordDrops), the journal's day files
   * (src/memory/journal.js#journalDrops), the backfill tool's candidates (`backfillDrops`).
   * `index`: the id index a direct rewrite makes stale.
   */
  function memberLineFiles(guildId) {
    const base = guildDir(guildId);
    const out = [];
    const archiveDir = path.join(base, 'archive');
    for (const name of namesIn(archiveDir)) {
      if (!name.endsWith('.jsonl') || name === 'pending-done.jsonl') continue;
      const pending = name === 'pending.jsonl';
      out.push({
        kind: 'archive',
        file: path.join(archiveDir, name),
        drops: pending ? (value, userId, before) => archiveDrops(value?.entry, userId, before) : archiveDrops,
        index: pending ? null : path.join(archiveDir, name.replace(/\.jsonl$/, '.ids.json')),
      });
    }
    const recordDir = path.join(base, 'record');
    for (const month of namesIn(recordDir).filter((name) => MONTH_DIR_RE.test(name))) {
      for (const name of namesIn(path.join(recordDir, month)).filter((entry) => DAY_JSONL_RE.test(entry))) {
        out.push({ kind: 'record', file: path.join(recordDir, month, name), drops: recordDrops, index: path.join(recordDir, month, 'ids.json') });
      }
    }
    const journalDir = path.join(base, 'journal');
    for (const name of namesIn(journalDir).filter((entry) => DAY_JSONL_RE.test(entry))) {
      out.push({ kind: 'journal', file: path.join(journalDir, name), drops: journalDrops, index: null });
    }
    const candidates = path.join(base, 'backfill', 'candidates.jsonl');
    if (fs.existsSync(candidates)) out.push({ kind: 'backfill', file: candidates, drops: (value, userId) => backfillDrops(value, userId), index: null });
    return out;
  }

  /** The guild's request dumps (src/memory/journal.js#dumpRequest; its own and every private journal's) whose text names the member. */
  function requestDumpsOf(guildId, userId) {
    const roots = [path.join(guildDir(guildId), 'journal', 'requests')];
    for (const name of namesIn(privateDir(guildId))) {
      if (USER_ID_RE.test(name)) roots.push(path.join(privateDir(guildId), name, 'journal', 'requests'));
    }
    const out = [];
    for (const root of roots) {
      for (const day of namesIn(root).filter((name) => REQUEST_DAY_DIR_RE.test(name))) {
        for (const name of namesIn(path.join(root, day)).filter((entry) => entry.endsWith('.json'))) {
          const file = path.join(root, day, name);
          let text = '';
          try {
            text = fs.readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          if (requestMentions(text, userId)) out.push({ file, text });
        }
      }
    }
    return out;
  }

  /**
   * Drop the member's lines of one kind (`archive`, `record`, `journal`) by a direct rewrite: the
   * path for a store without that module (a tool's copy, a test). With `before` only the earlier
   * ones (the ledger). A stale id index is deleted, so its module rebuilds it on its next read.
   */
  function dropLinesSync(guildId, userId, kind, before = null) {
    let dropped = 0;
    for (const target of memberLineFiles(guildId).filter((entry) => entry.kind === kind)) {
      const gone = filterJsonlSync(target.file, (line) => {
        const value = parseLine(line);
        return !(value && target.drops(value, userId, before));
      });
      if (gone > 0 && target.index) fs.rmSync(target.index, { force: true });
      dropped += gone;
    }
    if (kind === 'journal' && !Number.isFinite(before)) {
      const dir = path.join(guildDir(guildId), 'journal');
      for (const name of namesIn(dir).filter((entry) => TORN_JSONL_RE.test(entry))) {
        const file = path.join(dir, name);
        if (fs.readFileSync(file, 'utf8').includes(userId)) fs.rmSync(file, { force: true });
      }
    }
    return dropped;
  }

  /** The message ids of the guild record's lines a forget of `userId` drops (src/memory/record.js#recordDrops). */
  function memberMessageIds(guildId, userId) {
    const ids = new Set();
    for (const { file } of memberLineFiles(guildId).filter((entry) => entry.kind === 'record')) {
      for (const line of jsonlOf(file).lines) {
        const value = parseLine(line);
        if (value && typeof value.messageId === 'string' && value.messageId && recordDrops(value, userId)) ids.add(value.messageId);
      }
    }
    return ids;
  }

  /** The ledger's direct path for a member's private directory: every line of `kind` that happened before `before` goes. */
  function dropPrivateEarlierSync(guildId, userId, kind, before) {
    const timeOf = (value) => {
      const item = isPlainObject(value?.entry) ? value.entry : value;
      return Date.parse(kind === 'archive' ? item?.recordedAt : item?.occurredAt);
    };
    let dropped = 0;
    const walk = (dir) => {
      for (const name of namesIn(dir)) {
        const full = path.join(dir, name);
        if (name.endsWith('.jsonl')) {
          dropped += filterJsonlSync(full, (line) => {
            const value = parseLine(line);
            return !value || timeOf(value) >= before;
          });
        } else if (!name.includes('.')) {
          walk(full);
        }
      }
    };
    walk(path.join(memberDir(guildId, userId), kind));
    return dropped;
  }

  /** Request dumps naming the member deleted by the store itself (no journal given); with `before` only those recorded earlier. */
  function dropRequestsSync(guildId, userId, before = null) {
    let removed = 0;
    for (const { file, text } of requestDumpsOf(guildId, userId)) {
      if (Number.isFinite(before) && Date.parse(parseLine(text)?.recordedAt) >= before) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
    }
    return removed;
  }

  /**
   * The guild's diary with one member redacted (src/memory/mentions.js#redactUser over each post's
   * `gist` and `search`), not written: `{ item, posts, redacted }`; with `before` only the posts
   * dated earlier. No diary -> null.
   */
  function diaryRedaction(guildId, userId, names, token, before = null) {
    const file = diaryFile(guildId);
    if (!entries.has(file) && !fs.existsSync(file)) return null;
    const item = diaryEntry(guildId);
    let redacted = 0;
    const posts = item.value.posts.map((post) => {
      if (!isPlainObject(post)) return post;
      if (Number.isFinite(before) && !(post.at < before)) return post;
      const next = { ...post };
      for (const field of ['gist', 'search']) {
        if (typeof post[field] === 'string') next[field] = redactUser(post[field], { userId, names, token });
      }
      if (next.gist === post.gist && next.search === post.search) return post;
      redacted += 1;
      return next;
    });
    return { item, posts, redacted };
  }

  /** Redact one member out of the diary and write it at once, like the files a forget deletes; returns how many posts changed. */
  function redactDiaryNow(guildId, userId, names, token, before = null) {
    const plan = diaryRedaction(guildId, userId, names, token, before);
    if (!plan || plan.redacted === 0) return 0;
    plan.item.value = { ...plan.item.value, posts: plan.posts };
    plan.item.dirty = true;
    flushEntry(diaryFile(guildId), plan.item);
    return plan.redacted;
  }

  /**
   * The vault step: copy into `vaultAbs` everything a forget of `userId` removes or rewrites, under
   * its path below `data/`. Cached values are written as the cache holds them (newer than disk).
   */
  function vaultForget(guildId, userId, vaultAbs, names, token) {
    fs.rmSync(vaultAbs, { recursive: true, force: true });
    fs.mkdirSync(vaultAbs, { recursive: true });
    const rel = (abs) => path.relative(dataDir, abs);
    const put = (relPath, text) => {
      const out = path.join(vaultAbs, relPath);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text);
    };
    const copy = (abs) => {
      if (fs.existsSync(abs)) fs.cpSync(abs, path.join(vaultAbs, rel(abs)), { recursive: true });
    };
    const keep = (abs) => {
      const cached = entries.get(abs);
      if (cached) put(rel(abs), JSON.stringify(cached.value, null, 2));
      else copy(abs);
    };
    // The profile, the private layer and its directory, the profile's versions.
    keep(userFile(guildId, userId));
    keep(privateFile(guildId, userId));
    copy(memberDir(guildId, userId));
    keep(versionsFile(guildId, 'users', userId));
    // The voice items about the member.
    const voice = voiceFile(guildId);
    if (entries.has(voice) || fs.existsSync(voice)) {
      const queue = voiceEntry(guildId).value;
      const kept = forgetMember(queue, userId).queue;
      const extract = queue.filter((item) => !kept.includes(item));
      if (extract.length > 0) put(rel(voice).replace(/\.json$/, '.extract.json'), JSON.stringify(extract, null, 2));
    }
    // The recent and participation stores, whole, when the forget rewrites them.
    const recent = recentFile(guildId);
    if ((entries.has(recent) || fs.existsSync(recent)) && purgeRecentFor(recentEntry(guildId).value, userId, names).removed > 0) keep(recent);
    const participation = participationFile(guildId);
    if ((entries.has(participation) || fs.existsSync(participation)) && purgeParticipationFor(participationEntry(guildId).value, userId).removed > 0) keep(participation);
    // The archive's, record's and journal's lines the forget drops, by their modules' rule.
    for (const { file, drops } of memberLineFiles(guildId)) {
      const dropped = jsonlOf(file).lines.filter((line) => {
        const value = parseLine(line);
        return value !== null && drops(value, userId, null);
      });
      if (dropped.length > 0) put(`${rel(file)}.dropped.jsonl`, dropped.map((line) => `${line}\n`).join(''));
    }
    const journalDir = path.join(guildDir(guildId), 'journal');
    for (const name of namesIn(journalDir).filter((entry) => TORN_JSONL_RE.test(entry))) {
      const file = path.join(journalDir, name);
      if (fs.readFileSync(file, 'utf8').includes(userId)) copy(file);
    }
    // The diary before its redaction.
    const diary = diaryRedaction(guildId, userId, names, token);
    if (diary && diary.redacted > 0) put(rel(diaryFile(guildId)).replace(/\.json$/, '.before.json'), JSON.stringify(diary.item.value, null, 2));
    // The request dumps naming the member, whole.
    for (const { file } of requestDumpsOf(guildId, userId)) copy(file);
    // The member's files in every snapshot.
    for (const snapshot of snapshotDirs()) {
      for (const target of memberPaths(path.join(snapshot, 'guilds', String(guildId)), userId)) copy(target);
    }
  }

  /**
   * The hot part of a forget: the profile, the private layer, the voice items about the member and
   * the lessons they taught, their recent lines (their token, or one of `names` as a whole word)
   * and participation messages, their profile's version history; written at once. Idempotent.
   */
  function forgetHot(guildId, userId, names) {
    // Nothing of theirs still waiting for the archive is archived after this.
    forgetArchived(guildId, userId);
    const recent = forgetRecent(guildId, userId, names);
    const participation = forgetParticipation(guildId, userId);
    const file = userFile(guildId, userId);
    const profile = entries.has(file) || fs.existsSync(file) ? 1 : 0;
    entries.delete(file);
    fs.rmSync(file, { force: true });
    const versionsPath = versionsFile(guildId, 'users', userId);
    const versions = entries.has(versionsPath) || fs.existsSync(versionsPath) ? 1 : 0;
    entries.delete(versionsPath);
    fs.rmSync(versionsPath, { force: true });
    const voice = forgetQueued(guildId, userId);
    const hadPrivate = hasPrivate(guildId, userId) ? 1 : 0;
    store.forgetPrivate(guildId, userId);
    return { profile, private: hadPrivate, voice, recent, participation, versions };
  }

  /** Take the member out of every snapshot (their profile, private layer and directory, versions) and add them to each snapshot's ledger; returns how many snapshots lost something. */
  function forgetInSnapshots(guildId, userId, atIso) {
    let touched = 0;
    for (const snapshot of snapshotDirs()) {
      const guildPath = path.join(snapshot, 'guilds', String(guildId));
      if (!fs.existsSync(guildPath)) continue;
      let removed = false;
      for (const target of memberPaths(guildPath, userId)) {
        if (!fs.existsSync(target)) continue;
        fs.rmSync(target, { recursive: true, force: true });
        removed = true;
      }
      // A tool applies the snapshot's own ledger (applyLedger) before it reads the rest of it.
      const ledger = path.join(guildPath, 'forgotten.json');
      writeJsonAtomic(ledger, [...readLedgerFile(ledger), { userId, at: atIso }]);
      if (removed) touched += 1;
    }
    return touched;
  }

  function readMarker(guildId, userId) {
    const value = readJson(markerFile(guildId, userId), null);
    return isPlainObject(value) ? value : null;
  }

  function writeMarker(guildId, marker) {
    writeJsonAtomic(markerFile(guildId, marker.userId), marker);
    forgettingSet(guildId).add(marker.userId);
  }

  /** A new marker for a forget of `userId`: the names it redacts and the vault it fills are fixed here, so a resumed job uses the same. */
  function newMarker(guildId, userId, now, vaultDir) {
    const at = now();
    return {
      userId,
      owner: MARKER_OWNER,
      startedAt: new Date(at).toISOString(),
      steps: {},
      names: memberNames(guildId, userId),
      vault: path.relative(dataDir, path.join(vaultRoot(vaultDir), `forget-${userId}-${fileStamp(at)}`)),
    };
  }

  /** `fn` under the journal's writer lock when a journal is given (src/memory/journal.js#withWriterLock), else at once. */
  function underLock(journal, fn) {
    return typeof journal?.withWriterLock === 'function' ? journal.withWriterLock(fn) : fn();
  }

  /**
   * Run (or finish) the forget a marker describes, step by step; a step done before a crash is
   * skipped. The steps that touch only the store's own files run synchronously before the first
   * await, so a caller without a journal sees the profile gone at once.
   */
  async function runForget(guildId, marker, deps) {
    const { journal = null, record: rec = record, archive: arc = archive, vectors: vec = vectors, errands = null, intentions = null, redaction = null, now = Date.now } = deps ?? {};
    const id = marker.userId;
    const token = typeof redaction === 'string' && redaction.trim() ? redaction : DEFAULT_REDACTION;
    const names = Array.isArray(marker.names) ? marker.names.filter((name) => typeof name === 'string') : [];
    const vaultAbs = root.resolve(String(marker.vault));
    if (!isPlainObject(marker.steps)) marker.steps = {};
    const done = (name, result) => {
      marker.steps[name] = result ?? {};
      writeMarker(guildId, marker);
    };
    try {
      if (!marker.steps.vault) done('vault', vaultForget(guildId, id, vaultAbs, names, token));
      if (!marker.steps.hot) done('hot', forgetHot(guildId, id, names));
      if (!marker.steps.diary) done('diary', { diary: redactDiaryNow(guildId, id, names, token) });
      if (!marker.steps.snapshots) done('snapshots', { snapshots: forgetInSnapshots(guildId, id, new Date(now()).toISOString()) });
      // The errands the member asked for, and their transition lines (src/errands/store.js#forgetUser,
      // which copies what it drops into the vault itself).
      if (errands && typeof errands.forgetUser === 'function' && !marker.steps.errands) {
        const result = await errands.forgetUser(guildId, id, { vault: vaultAbs });
        done('errands', { removed: result?.removed ?? 0, lines: result?.lines ?? 0 });
      }
      // The persona's intentions that concern the member: meant for them, from a conversation with
      // them, or naming them (src/intentions/store.js#forgetUser, which copies the file into the
      // vault itself).
      if (intentions && typeof intentions.forgetUser === 'function' && !marker.steps.intentions) {
        const result = await intentions.forgetUser(guildId, id, { names, vault: vaultAbs });
        done('intentions', { intentions: result?.removed ?? 0 });
      }
      // The meaning index before the record: a row is found by its chunk's members and by the
      // record lines the forget is about to drop (their message ids, read while they are there).
      if (vec && !marker.steps.vectors) {
        const result = await vec.forgetUser(guildId, id, { messageIds: memberMessageIds(guildId, id) });
        done('vectors', { vectors: (result?.dropped ?? 0) + (result?.privateDropped ?? 0) });
      }
      if (!marker.steps.archive) done('archive', { archive: arc ? (await arc.forgetUser(guildId, id))?.dropped ?? 0 : dropLinesSync(guildId, id, 'archive') });
      if (!marker.steps.record) done('record', { record: rec ? (await rec.forgetUser(guildId, id))?.dropped ?? 0 : dropLinesSync(guildId, id, 'record') });
      if (!marker.steps.journal) done('journal', { journal: journal ? (await journal.forgetUser(guildId, id))?.dropped ?? 0 : dropLinesSync(guildId, id, 'journal') });
      if (!marker.steps.requests) {
        done('requests', { requests: typeof journal?.forgetRequests === 'function' ? (await journal.forgetRequests(guildId, id))?.removed ?? 0 : dropRequestsSync(guildId, id) });
      }
      // The backfill tool refuses to run while the marker exists, so its candidates are rewritten directly.
      if (!marker.steps.backfill) done('backfill', { backfill: dropLinesSync(guildId, id, 'backfill') });
      if (!marker.steps.private) {
        // What the modules left of the private directory (and anything else in it) goes whole.
        const dir = memberDir(guildId, id);
        for (const file of [...entries.keys()]) if (file.startsWith(dir + path.sep)) entries.delete(file);
        fs.rmSync(dir, { recursive: true, force: true });
        done('private', {});
      }
    } catch (error) {
      log.warn('store: forget unfinished', { guildId: String(guildId), userId: id, code: error?.code ?? null });
      throw Object.assign(error, { vault: vaultAbs });
    }
    // The caches: whatever a writer put back while the job ran goes too.
    forgetHot(guildId, id, names);
    const ledger = ledgerFile(guildId);
    writeJsonAtomic(ledger, [...readLedgerFile(ledger), { userId: id, at: new Date(now()).toISOString() }]);
    fs.rmSync(markerFile(guildId, id), { force: true });
    forgettingSet(guildId).delete(id);
    const counts = {};
    for (const [step, result] of Object.entries(marker.steps)) {
      if (!isPlainObject(result)) continue;
      // The errands step's own names, `removed` and `lines`, are too general for the counts.
      if (step === 'errands') Object.assign(counts, { errands: result.removed ?? 0, errandLines: result.lines ?? 0 });
      else Object.assign(counts, result);
    }
    log.info('store: forgotten', { guildId: String(guildId), userId: id, ...counts });
    return { vault: vaultAbs, counts };
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
     * Profile of a member, or null when the persona has never seen them, or while a forget of
     * them is under way (its marker exists, see `forgetUser`).
     * Stored JSON is normalised on read here (see `normalizeProfile` above,
     * which tolerates a hand-edited file) -- persisted the next time
     * anything writes this profile, never wiped implicitly.
     */
    getUser(guildId, userId) {
      if (isForgetting(guildId, userId)) return null;
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
     * `relationship` keeps its previous text (`recordVersion`; `opts.by`, `opts.versions`), and
     * loses its links first (`withoutLinks`: one that was only links is not written).
     * @param {{ by?: string, versions?: { enabled?: boolean, kept?: number } }} [opts]
     */
    updateUser(guildId, userId, fields, opts = {}) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const { affinity, episodes, interests, details, detailsSeq, ...given } = fields ?? {};
      const safeFields = withoutLinks(given, USER_PROSE);
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
     * blanks what is already stored. Every text of the batch (prose, items, aliases, the real
     * name) loses its links before it is clamped (`stripUrls`); one that was only links counts as
     * empty. `ops.interests` (`{ add, update, seen,
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
     *   aliases?: { add?: string[], remove?: string[] },
     *   realName?: string|{ name: string, supersedes?: string, validFrom?: string } }} ops
     *   `realName`: see `applyRealName` -- set when none is stored, a sighting when equal, a
     *   replacement only through `supersedes`, the replaced one going to the `closed` list (kind
     *   `realName`).
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
        const value = typeof ops?.[key] === 'string' ? stripUrls(ops[key]) : undefined;
        if (typeof value === 'string' && value.trim()) {
          const next = firstWriteText(profile[key], value, opts.fieldChars, opts.clampTolerance);
          recordVersion(guildId, 'users', userId, key, profile[key], next, opts);
          profile[key] = next;
        }
      }
      writeRelationship(profile, ops?.relationship, opts, (previous, next) =>
        recordVersion(guildId, 'users', userId, 'relationship', previous, next, opts));

      // What left the profile (removed, folded, evicted), each with its itemId: the archive's input.
      const previous = { interests: profile.interests, details: profile.details, aliases: profile.aliases };
      const dropped = { ...applyItemOps(profile, ops, opts, seenAt, newId), aliases: [] };

      if (ops?.aliases && typeof ops.aliases === 'object' && !Array.isArray(ops.aliases)) {
        const aliases = applyAliasOps(profile.aliases, ops.aliases, profile.names, {
          maxAliases: opts.maxAliases,
          maxAliasesStored: opts.maxAliasesStored,
          confirmGapHours: opts.confirmGapHours,
          halfLifeDays: opts.aliasHalfLifeDays,
          seenAt,
          mintId: () => `${ITEM_ID_PREFIX.alias}${newId()}`,
          now: opts.now,
        });
        profile.aliases = changedWithItemIds(profile.aliases, aliases, ITEM_ID_PREFIX.alias, newId);
        dropped.aliases = withItemIds(aliases.dropped, ITEM_ID_PREFIX.alias, newId);
        dropped.closed.alias = withItemIds(aliases.closed, ITEM_ID_PREFIX.alias, newId);
      }
      if (ops?.realName !== undefined && ops?.realName !== null) {
        const real = applyRealName(profile.realName, ops.realName, { seenAt, now: opts.now, mintId: () => `${ITEM_ID_PREFIX.realName}${newId()}` });
        if (real) {
          profile.realName = real.realName;
          dropped.closed.realName = real.closed;
        }
      }
      archiveProfileItems(guildId, userId, { item, file: userFile(guildId, userId), previous, dropped, ops });
      storeClosed(guildId, userId, { item, file: userFile(guildId, userId), target: profile, closed: dropped.closed, opts });

      profile.updatedAt = new Date(opts.now ?? Date.now()).toISOString();
      item.dirty = true;
      return profile;
    },

    /**
     * Fold one batch's uses of a member's names into the profile's `addressedAs`
     * (src/memory/addressed.js#applyAddressUses): a counter like `messageCount`, so `updatedAt`
     * is left alone. Only an existing profile is written, never a new one; no uses -> nothing.
     * @param {string} guildId
     * @param {string} userId
     * @param {Array<{ name: string, at: number }>} uses
     * @param {{ halfLifeDays?: number, max?: number, now?: number }} [opts]  `halfLifeDays`:
     *   `memory.addressHalfLifeDays`.
     * @returns {object|null}  The profile, or null when there is none.
     */
    recordAddressUses(guildId, userId, uses, opts = {}) {
      const profile = store.getUser(guildId, userId);
      if (!profile) return null;
      if (!Array.isArray(uses) || uses.length === 0) return profile;
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      profile.addressedAs = applyAddressUses(profile.addressedAs, uses, opts);
      item.dirty = true;
      return profile;
    },

    /**
     * Store a member's current avatar (src/memory/avatars.js#normalizeAvatar: `{ hash, text,
     * describedAt }` or `{ hash: null, default: true }`), replacing the one stored: no history of
     * old avatars. Only into an existing profile, never while a forget of the member is under way,
     * and never a profile's `updatedAt` (the portrait refresh's version stamp). Lives and goes
     * with the profile file, so `/nep memory forget` and the wipe remove it.
     * @returns {object|null}  The profile, or null when nothing was written.
     */
    setAvatar(guildId, userId, avatar) {
      if (isForgetting(guildId, userId)) return null;
      const file = userFile(guildId, userId);
      if (!entries.has(file) && !fs.existsSync(file)) return null;
      const value = normalizeAvatar(avatar);
      if (!value) return null;
      const item = entry(file, () => emptyProfile(String(userId)));
      normalizeProfile(item.value);
      item.value.avatar = value;
      item.dirty = true;
      return item.value;
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
      holdMoves(guildId, userId, item, userFile(guildId, userId), current, next);
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
     * Forget one member everywhere the engine keeps them, as one restartable job (`/nep memory
     * forget`). Under the journal's writer lock when `deps.journal` is given (no journal, record or
     * archive line is added meanwhile), in this order:
     *
     *   1. the marker `forgetting/<userId>.json` (`{ userId, owner: 'store', startedAt, steps,
     *      names, vault }`), rewritten after each step; readers hide the member while it exists;
     *   2. the vault, `<memory.vaultDir>/forget-<userId>-<ts>/` (`deps.vaultDir`, default `vault`
     *      under `data/`): plain copies, under their paths below `data/`, of the profile, the
     *      private layer and directory, the profile versions, the voice items about them
     *      (`voice.extract.json`), the recent and participation files when they change, the
     *      archive, record, journal and backfill candidate lines about to be dropped (`<path>.dropped.jsonl`), the
     *      diary before its redaction (`diary.before.json`), the request dumps naming them and
     *      their files in every snapshot;
     *   3. the hot part: profile, private layer, voice items about them and the lessons they taught
     *      (src/memory/voice.js#forgetMember), recent lines naming them (their token, or a stored
     *      name or alias as a whole word; src/memory/recent.js#purgeRecentFor), their participation
     *      messages (src/memory/participation.js#purgeParticipationFor), the version history of
     *      their profile's prose -- each file written at once;
     *   4. the diary: every post's gist naming them (token, names) redacted with `deps.redaction`
     *      (`labels.memory.redaction`, default `someone`), the post kept;
     *   5. every snapshot under `data/snapshots/`: their profile, private layer and directory and
     *      versions deleted, `{ userId, at }` added to that snapshot's `forgotten.json`;
     *   5a. with the errand stores (`deps.errands`: src/errands/service.js#forgetUser, or
     *      src/errands/store.js#createTaskStores), the errands they asked for out of `tasks.json`
     *      and their lines out of `tasks.jsonl` (the step `errands`: `{ removed, lines }`, in the
     *      counts as `errands` and `errandLines`; the dropped part copied into the vault by the
     *      errand store);
     *   5a'. with the intention stores (`deps.intentions`: src/intentions/service.js#forgetUser, or
     *      src/intentions/store.js#createIntentionStores), every intention of the persona's that
     *      concerns them -- meant for them, from a conversation with them, or naming them
     *      (src/intentions/model.js#concernsMember) -- out of `intentions.json` (the step
     *      `intentions`, counted as `intentions`; the file copied into the vault by the store);
     *   5b. with a meaning index (`deps.vectors`, else the store's own), its rows naming them by
     *      their chunk's members or holding a record line this forget drops, the member's private
     *      index whole (src/memory/vectors.js#forgetUser; counted as `vectors`);
     *   6. the archive, the record and the journal (`archive.forgetUser`, `record.forgetUser`,
     *      `journal.forgetUser`: the store's own archive and record unless `deps` names others; a
     *      missing module's files are rewritten directly by the same rule), the guild request
     *      dumps naming them (`journal.forgetRequests`), the backfill tool's candidates naming them
     *      (`backfill/candidates.jsonl`, `backfillDrops`), what is left of their private directory;
     *   7. the caches (anything a writer put back meanwhile goes again), then the ledger
     *      `forgotten.json` gets `{ userId, at }`, then the marker goes.
     *
     * A step that throws leaves the marker (the rejection carries `vault`); `resumeForgets`
     * finishes it at the next start. Steps 1 to 5 and the cache step touch only the store's own
     * files and run before the first await. Not archived: a forget is not an eviction.
     * @param {string} guildId
     * @param {string} userId
     * @param {{ journal?: object|null, record?: object|null, archive?: object|null, vectors?: object|null,
     *   errands?: { forgetUser: Function }|null, intentions?: { forgetUser: Function }|null, vaultDir?: string, redaction?: string, now?: () => number }} [deps]
     * @returns {Promise<{ vault: string, counts: { profile: number, private: number, voice: number,
     *   recent: number, participation: number, versions: number, diary: number, snapshots: number,
     *   archive: number, record: number, journal: number, requests: number, backfill: number,
     *   errands?: number, errandLines?: number, intentions?: number } }>}  `vault`: the
     *   absolute path of the vault directory.
     */
    forgetUser(guildId, userId, deps = {}) {
      let id;
      try {
        id = checkUserId(userId);
      } catch (error) {
        return Promise.reject(error);
      }
      const now = typeof deps?.now === 'function' ? deps.now : Date.now;
      return underLock(deps?.journal, () => {
        const existing = readMarker(guildId, id);
        const marker = existing?.owner === MARKER_OWNER && isPlainObject(existing.steps) && typeof existing.vault === 'string' ? existing : newMarker(guildId, id, now, deps?.vaultDir);
        writeMarker(guildId, marker);
        return runForget(guildId, marker, { ...deps, now });
      });
    },

    /**
     * Finish every forget a crash or a restart left (src/index.js, at start, before the updater
     * runs): each marker of the guild runs the remaining steps of `forgetUser` with `deps`. A marker
     * another module wrote (src/memory/journal.js, record.js, archive.js) becomes the store's and
     * the whole job runs. Rejects on the first job that fails again (its marker stays).
     * @param {string} guildId
     * @param {object} [deps]  As `forgetUser`.
     * @returns {Promise<{ finished: number }>}
     */
    async resumeForgets(guildId, deps = {}) {
      const now = typeof deps?.now === 'function' ? deps.now : Date.now;
      let finished = 0;
      for (const name of namesIn(forgettingDir(guildId))) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length);
        if (!USER_ID_RE.test(id)) continue;
        await underLock(deps?.journal, () => {
          const existing = readMarker(guildId, id);
          const marker = existing?.owner === MARKER_OWNER && isPlainObject(existing.steps) && typeof existing.vault === 'string' ? existing : newMarker(guildId, id, now, deps?.vaultDir);
          writeMarker(guildId, marker);
          return runForget(guildId, marker, { ...deps, now });
        });
        finished += 1;
      }
      if (finished > 0) log.info('store: forgets finished', { guildId: String(guildId), finished });
      return { finished };
    },

    /**
     * Re-apply the guild's deletion ledger (`forgotten.json`, plus `deps.entries`: a tool passes
     * the live ledger over its copy of a snapshot), idempotent: for each forgotten member (their
     * latest entry's `at`), whatever dates from before it is taken out again -- a profile or a
     * private layer whose `firstSeen` is earlier (with the rest of `forgetUser`'s hot part), their
     * archive entries archived earlier, record and journal lines that happened earlier (private
     * ones included; `forgetUser` with `before`), diary posts dated earlier (redacted again), the
     * request dumps naming them recorded earlier, and with a meaning index (`deps.vectors`, else
     * the store's own) its earlier rows naming them (`vectors` in the counts, only then). What they did after their forget stays: a forget
     * is not a ban. No vault: what comes back came from a copy. Run at start after
     * `resumeForgets`, before the updater (src/index.js), and by the tools before they touch a
     * snapshot. Logs `memory: ledger applied` with the counts.
     * @param {string} guildId
     * @param {{ journal?: object|null, record?: object|null, archive?: object|null, redaction?: string,
     *   entries?: Array<{ userId: string, at: string }> }} [deps]
     * @returns {Promise<{ users: number, profiles: number, private: number, archive: number,
     *   record: number, journal: number, diary: number, requests: number }>}
     */
    async applyLedger(guildId, deps = {}) {
      const { journal = null, record: rec = record, archive: arc = archive, vectors: vec = vectors, redaction = null, entries: extra = [] } = deps ?? {};
      const token = typeof redaction === 'string' && redaction.trim() ? redaction : DEFAULT_REDACTION;
      const latest = new Map();
      for (const entry of [...readLedger(dataDir, guildId), ...(Array.isArray(extra) ? extra : [])]) {
        const id = String(entry?.userId ?? '');
        const at = Date.parse(entry?.at);
        if (!USER_ID_RE.test(id) || !Number.isFinite(at)) continue;
        if (!(latest.get(id) >= at)) latest.set(id, at);
      }
      const counts = { users: latest.size, profiles: 0, private: 0, archive: 0, record: 0, journal: 0, diary: 0, requests: 0 };
      if (latest.size === 0) return counts;
      const earlier = (value, at) => isPlainObject(value) && !(Date.parse(value.firstSeen) >= at);
      await underLock(journal, async () => {
        for (const [id, at] of latest) {
          const names = memberNames(guildId, id);
          if (earlier(rawJson(userFile(guildId, id)), at)) {
            const hot = forgetHot(guildId, id, names);
            counts.profiles += hot.profile;
            counts.private += hot.private;
          } else if (earlier(rawJson(privateFile(guildId, id)), at)) {
            store.forgetPrivate(guildId, id);
            counts.private += 1;
          }
          counts.diary += redactDiaryNow(guildId, id, names, token, at);
          for (const [kind, module] of [['archive', arc], ['record', rec], ['journal', journal]]) {
            if (module) {
              counts[kind] += (await module.forgetUser(guildId, id, { before: at }))?.dropped ?? 0;
            } else {
              counts[kind] += dropLinesSync(guildId, id, kind, at) + dropPrivateEarlierSync(guildId, id, kind, at);
            }
          }
          if (vec) {
            const result = await vec.forgetUser(guildId, id, { before: at });
            counts.vectors = (counts.vectors ?? 0) + (result?.dropped ?? 0) + (result?.privateDropped ?? 0);
          }
          counts.requests +=
            typeof journal?.forgetRequests === 'function' ? (await journal.forgetRequests(guildId, id, { before: at }))?.removed ?? 0 : dropRequestsSync(guildId, id, at);
        }
      });
      log.info('memory: ledger applied', { guildId: String(guildId), ...counts });
      return counts;
    },

    /**
     * Redact one member out of the guild's diary now (`forgetUser`'s diary step): their `<@id>`
     * token and each of `names` as a whole word become `token` in every post's gist
     * (src/memory/mentions.js#redactUser); the posts stay, the file is written at once.
     * @param {string} guildId
     * @param {string} userId
     * @param {{ names?: string[], token?: string }} [opts]
     * @returns {number}  How many posts changed.
     */
    redactDiary(guildId, userId, { names = [], token = DEFAULT_REDACTION } = {}) {
      return redactDiaryNow(guildId, String(userId), names, token);
    },

    /**
     * Fill in the reason of one attitude move after the fact (the two-stage analyzer: stage A
     * moved the score with an empty reason, the voice run words it later): the
     * history entry stamped `at` (its `ts`) gets `reason`, and `affinity.reason` too while that
     * entry is the newest. The score is never touched. `reason` loses its links and is clamped as
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
      const text = typeof reason === 'string' ? clampText(stripUrls(reason), REASON_CHARS, { tolerance: opts.clampTolerance }) : '';
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
     * `feeling` loses its links and is clamped as src/memory/episodes.js#sanitizeEpisode clamps it
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
      const text = typeof feeling === 'string' ? clampText(stripUrls(feeling), FEELING_CHARS, { tolerance: opts.clampTolerance }) : '';
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
     * null when there is none or while a forget of them is under way. Normalised on read (see `normalizePrivate`),
     * persisted the next time anything writes the file.
     * @param {string} guildId
     * @param {string} userId
     * @returns {object|null}
     */
    getPrivate(guildId, userId) {
      if (isForgetting(guildId, userId) || !hasPrivate(guildId, userId)) return null;
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
      const previous = { interests: priv.interests, details: priv.details };
      const dropped = applyItemOps(priv, ops, opts, seenAt, newId);
      archiveProfileItems(guildId, userId, { item, file: privateFile(guildId, userId), previous, dropped, ops: { interests: ops?.interests, details: ops?.details }, privateUserId: String(userId) });
      storeClosed(guildId, userId, { item, file: privateFile(guildId, userId), target: priv, closed: dropped.closed, opts, privateUserId: String(userId) });

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
      const current = item.value.affinity;
      const next = applyDeltaWithIds(current, delta, reason, opts);
      item.value.affinity = next;
      item.dirty = true;
      holdMoves(guildId, userId, item, privateFile(guildId, userId), current, next, true);
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
      forgetArchived(guildId, userId, { privateOnly: true });
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
        for (const name of fs.readdirSync(root.guildsDir)) ids.add(name);
      } catch {
        // no guilds directory yet
      }
      const prefix = root.guildsDir + path.sep;
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
     * `ITEM_ID_PREFIX`), called once per write. `patterns`, `starters` and every in-joke and self
     * fact lose their links first (`withoutLinks`): a text that was only links is not written.
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
        ...given
      } = fields ?? {};
      const safeFields = withoutLinks(given, GUILD_TEXT);
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
      const previous = { injokes: item.value.injokes, self: item.value.self };
      Object.assign(item.value, safeFields, stamps);
      opts.onDropped?.(dropped);
      item.dirty = true;
      // A list written whole replaces the stored one: what it no longer holds is held for the archive.
      for (const [field, itemKind] of [['injokes', 'injoke'], ['self', 'selfFact']]) {
        if (!(field in safeFields)) continue;
        holdVictims(guildId, {
          item, file: guildFile(guildId), path: [field], strings: true, previous: previous[field], victims: dropped[field], itemKind, scope: { guild: true },
          eventOf: () => 'replaced',
        });
      }
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
      const previous = guild.learned;
      const { items, nextId, dropped } = applyDetailOps(guild.learned, ops, {
        maxDetails: opts.maxLearned,
        maxDetailsStored: opts.maxLearnedStored,
        fieldChars: opts.learnedChars,
        halfLifeDays: opts.learnedHalfLifeDays,
        confirmGapHours: opts.confirmGapHours,
        clampTolerance: opts.clampTolerance,
        seenAt: Number.isFinite(opts.seenAt) ? opts.seenAt : Date.now(),
        nextId: guild.learnedNextId,
        // A lesson carries no validity fields.
        validity: false,
      });
      // Compared before the ids are stamped: a call that changes nothing still writes nothing.
      if (JSON.stringify([items, nextId]) !== before) {
        guild.learned = withItemIds(items, ITEM_ID_PREFIX.lesson, newId);
        guild.learnedNextId = nextId;
        guild.updatedAt = new Date().toISOString();
        item.dirty = true;
      }
      const victims = withItemIds(dropped, ITEM_ID_PREFIX.lesson, newId);
      const removing = removeKeysOf(ops.remove);
      const kept = guild.learned;
      archiveReplaced(guildId, { previous, current: kept, itemKind: 'lesson', scope: { guild: true }, item });
      holdVictims(guildId, {
        item, file: guildFile(guildId), path: ['learned'], previous, victims, itemKind: 'lesson', scope: { guild: true },
        eventOf: (victim) => rankedEvent(victim, 'text', removing, kept, false),
      });
      return attachDropped(guild.learned, 'dropped', victims);
    },

    /**
     * Apply one batch of self-fact ops to the guild's `self` list (what the persona said about
     * itself), the two-stage analyzer's incremental shape (src/memory/voice.js): `remove` first,
     * every stored fact equal to one listed (compared by src/memory/interests.js#normalizeTopic:
     * trimmed, whitespace collapsed, lower-cased -- the rule src/memory/voice.js tells a queued
     * self fact by); then `add`, each new claim clamped like the single-stage self list
     * (src/memory/voice.js#SELF_CHARS, `opts.clampTolerance`) and appended unless it is already
     * stored (a claim that was only links adds nothing: links go first, `stripUrls`); past `opts.maxSelfFacts` the oldest leave to make room (a cap of 0 adds nothing; a
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
          const fact = clampText(stripUrls(claim), SELF_CHARS, { tolerance: opts.clampTolerance });
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

      const dropped = stringItems(leaving, ITEM_ID_PREFIX.selfFact, newId);
      if (counts.added + counts.removed > 0) {
        guild.self = next;
        guild.updatedAt = new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString();
        item.dirty = true;
        holdVictims(guildId, {
          item, file: guildFile(guildId), path: ['self'], strings: true, previous: stored, victims: dropped, itemKind: 'selfFact', scope: { guild: true },
          eventOf: (_, index) => (index < counts.removed ? 'replaced' : 'evicted'),
        });
      }
      return attachDropped(counts, 'dropped', dropped);
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
     * `notesCheckedAt`, see `markNotesChecked`). Each field loses its links first (`withoutLinks`:
     * one that was only links is not written). A changed field keeps its previous text
     * (`recordVersion`; `opts.by`, `opts.versions`).
     * @param {{ by?: string, versions?: { enabled?: boolean, kept?: number } }} [opts]
     */
    updateChannel(guildId, channelId, fields, opts = {}) {
      const item = channelEntry(guildId, channelId);
      const given = {};
      for (const key of CHANNEL_PROSE) {
        if (typeof fields?.[key] === 'string') given[key] = fields[key];
      }
      const patch = withoutLinks(given, CHANNEL_PROSE);
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
     * after the message arrived, see src/behavior/pipeline.js#onMessageUpdate), in place: the
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
      const previous = item.value.lines;
      const { value, droppedLines, ...counts } = mergeRecent(item.value, incoming, opts);
      const victims = withItemIds(droppedLines, ITEM_ID_PREFIX.recent, newId);
      if (counts.added + counts.removed + counts.expired + counts.evicted > 0) {
        item.value = { ...value, lines: withItemIds(value.lines, ITEM_ID_PREFIX.recent, newId) };
        item.dirty = true;
        // droppedLines: the expired, then the removed, then the evicted.
        holdVictims(guildId, {
          item, file: recentFile(guildId), path: ['lines'], previous, victims, itemKind: 'recent',
          scope: (line) => (typeof line.channelId === 'string' && line.channelId ? { channel: line.channelId } : { guild: true }),
          eventOf: (_, index) => (index < counts.expired ? 'expired' : index < counts.expired + counts.removed ? 'replaced' : 'evicted'),
        });
      }
      return attachDropped(counts, 'droppedLines', victims);
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
      const previous = item.value.episodes;
      const at = Number.isFinite(now) ? now : Date.now();
      const { state: next, dropped } = expireEpisodes(state, settings, at);
      item.value = structuredClone({ ...next, episodes: withItemIds(next.episodes, ITEM_ID_PREFIX.participation, newId) });
      item.dirty = true;
      const victims = withItemIds(dropped, ITEM_ID_PREFIX.participation, newId);
      // As src/memory/participation.js#expireEpisodes reads `hours`: past it an episode expired, else the cap took it.
      const hours = Number.isFinite(settings?.hours) && settings.hours >= 0 ? settings.hours : PARTICIPATION_DEFAULTS.hours;
      holdVictims(guildId, {
        item, file: participationFile(guildId), path: ['episodes'], previous, victims, itemKind: 'participation',
        scope: (episode) => (typeof episode.channelId === 'string' && episode.channelId ? { channel: episode.channelId } : { guild: true }),
        eventOf: (episode) => (episode.lastOwnAt < at - hours * HOUR_MS ? 'expired' : 'evicted'),
      });
      return { dropped: victims };
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
     * `touchUser`/`getGuild` works and persists), no restart required. Before anything goes, the
     * whole guild directory is copied into the vault (`vaultGuild`; `opts.vault`, a path an
     * earlier `vaultGuild` returned, skips the copy); the record (`record/`), the archive
     * (`archive/`), the backfill tool's files (`backfill/`), the meaning index (`vectors/`) and the deletion ledger
     * (`forgotten.json`) go with the rest, and the guild's directory inside every snapshot under
     * `data/snapshots/`. The errands' files (`tasks.json`, `tasks.jsonl`) go too, through
     * `opts.errands` (src/errands/store.js#createTaskStores, whose copy in memory is emptied with
     * them) when given, else deleted directly; the persona's intentions (`intentions.json` and its
     * unreadable copies) the same way through `opts.intentions` (src/intentions/store.js#createIntentionStores).
     * @param {string} guildId
     * @param {{ keepOwnerLore?: boolean, keepMediaCache?: boolean, vault?: string|null,
     *   vaultDir?: string, errands?: { wipe: Function }|null, intentions?: { wipe: Function }|null, now?: () => number }} [opts]
     * @returns {{ users: number, channels: number, loreRemoved: number, loreKept: number, bufferMessages: number,
     *   recentLines: number, snapshots: number, privateLayers: number, recordFiles: number,
     *   archiveFiles: number, backfillFiles: number, taskFiles: number, intentionFiles: number, vault: string }}  `recentLines`: the recent lines the
     *   wipe removed; `snapshots`: the snapshots that lost the guild; `privateLayers`: the members'
     *   private layers removed; `recordFiles` / `archiveFiles` / `backfillFiles`: the files removed
     *   under `record/`, `archive/`, `backfill/`; `taskFiles`: the errands' files removed;
     *   `intentionFiles`: the intentions' files removed; `vault`:
     *   the vault copy's path.
     */
    wipeGuild(guildId, { keepOwnerLore = true, keepMediaCache = true, vault = null, vaultDir, errands = null, intentions = null, now = Date.now } = {}) {
      const vaultPath = typeof vault === 'string' && vault ? vault : store.vaultGuild(guildId, { vaultDir, now });
      // What waits for the archive goes with the memory it came from.
      const waiting = archiveGuilds.get(String(guildId));
      for (const queued of waiting ? [...waiting.queue, ...waiting.retry] : []) releaseHold(queued);
      archiveGuilds.delete(String(guildId));
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

      // The members' private layers (`private/<id>.json`, on disk or only cached), not their directories' files.
      const privateLayers = new Set([
        ...namesIn(privateDir(guildId)).filter((name) => name.endsWith('.json')),
        ...[...entries.keys()].filter((file) => path.dirname(file) === privateDir(guildId)).map((file) => path.basename(file)),
      ]).size;
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
      // The errands (`tasks.json`, `tasks.jsonl`) name who asked and what: they go, through the
      // errand stores when given (their own copy goes too), else as files.
      let taskFiles = 0;
      if (errands && typeof errands.wipe === 'function') {
        taskFiles = errands.wipe(guildId)?.files ?? 0;
      } else {
        for (const name of ['tasks.json', 'tasks.jsonl']) {
          const file = path.join(guildDir(guildId), name);
          if (fs.existsSync(file)) taskFiles += 1;
          fs.rmSync(file, { force: true });
        }
      }
      // The persona's intentions quote her lines and name the members they are for: they go,
      // through the intention stores when given (their own copy goes too), else as files.
      let intentionFiles = 0;
      if (intentions && typeof intentions.wipe === 'function') {
        intentionFiles = intentions.wipe(guildId)?.files ?? 0;
      } else {
        for (const name of namesIn(guildDir(guildId)).filter((entry) => entry === 'intentions.json' || entry.startsWith('intentions.json.unreadable-'))) {
          fs.rmSync(path.join(guildDir(guildId), name), { force: true });
          intentionFiles += 1;
        }
      }
      // The record and the archive are this guild's memory too, the backfill tool's scratch
      // files (tools/backfill.mjs) quote it and the meaning index (`vectors/`) is built from it:
      // the vault holds their copy.
      const files = {};
      for (const name of ['record', 'archive', 'backfill', 'vectors']) {
        files[name] = filesIn(path.join(guildDir(guildId), name));
        fs.rmSync(path.join(guildDir(guildId), name), { recursive: true, force: true });
      }
      // The deletion ledger goes with the memory it guarded.
      fs.rmSync(ledgerFile(guildId), { force: true });

      // Every snapshot's copy of the guild goes too (the vault holds them).
      let snapshots = 0;
      for (const snapshot of snapshotDirs()) {
        const copy = path.join(snapshot, 'guilds', String(guildId));
        if (!fs.existsSync(copy)) continue;
        fs.rmSync(copy, { recursive: true, force: true });
        snapshots += 1;
      }

      for (const key of ['warmup']) {
        if (stateEntry.value[key] !== undefined) {
          delete stateEntry.value[key];
          stateEntry.dirty = true;
        }
      }

      flushAll();

      return {
        users: userIds.length,
        channels: channelIds.length,
        loreRemoved,
        loreKept,
        bufferMessages,
        recentLines,
        snapshots,
        privateLayers,
        recordFiles: files.record,
        archiveFiles: files.archive,
        backfillFiles: files.backfill,
        taskFiles,
        intentionFiles,
        vault: vaultPath,
      };
    },

    /**
     * The wipe's vault (`/nep memory wipe`, before anything is deleted): the store flushed, then the
     * whole guild directory and the guild's directory inside every snapshot copied, as plain files
     * under their paths below `data/`, into `<memory.vaultDir>/wipe-<ts>/` (`vaultDir`, default
     * `vault` under `data/`). The engine never reads it back.
     * @param {string} guildId
     * @param {{ vaultDir?: string, now?: () => number }} [opts]
     * @returns {string}  The absolute path of the vault copy.
     */
    vaultGuild(guildId, { vaultDir, now = Date.now } = {}) {
      flushAll();
      const dest = path.join(vaultRoot(vaultDir), `wipe-${fileStamp(now())}`);
      fs.mkdirSync(dest, { recursive: true });
      const copy = (abs) => {
        if (fs.existsSync(abs)) fs.cpSync(abs, path.join(dest, path.relative(dataDir, abs)), { recursive: true });
      };
      copy(guildDir(guildId));
      for (const snapshot of snapshotDirs()) copy(path.join(snapshot, 'guilds', String(guildId)));
      log.info('store: guild vaulted', { guildId: String(guildId) });
      return dest;
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

    /**
     * Write every dirty cache entry that is not held for the archive (see `flushEntry`).
     * @returns {{ written: number, failed: number, held: number }}
     */
    flush() {
      return flushAll();
    },

    /**
     * The flush before a shutdown or a pause: waits up to `holdMaxMs` (`archive.holdMaxMs`,
     * config.json's 5000 when missing) for the archive to take what holds files back, then writes
     * everything, held or not; files written while still held are logged as `store: flushed held`.
     * @param {{ holdMaxMs?: number }} [opts]
     * @returns {Promise<{ written: number, failed: number, held: number }>}
     */
    async flushSettled({ holdMaxMs } = {}) {
      const heldFiles = () => [...entries.values()].filter((item) => item.dirty && item.holdFlush > 0).length;
      if (heldFiles() > 0) {
        const waitMs = Number.isFinite(holdMaxMs) && holdMaxMs >= 0 ? holdMaxMs : DEFAULT_HOLD_MAX_MS;
        let timer = null;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(resolve, waitMs);
        });
        const settled = (async () => {
          for (const state of [...archiveGuilds.values()]) {
            for (;;) {
              const chain = state.chain;
              await chain;
              if (chain === state.chain) break;
            }
          }
        })();
        await Promise.race([timeout, settled]);
        clearTimeout(timer);
      }
      const held = heldFiles();
      const counts = flushAll({ force: true });
      if (held > 0) log.warn('store: flushed held', { files: held });
      return counts;
    },

    // ---- the archive (see "The archive" at the top of createStore) ----

    /**
     * The guild's archive sequence now: take one before and one after a group of synchronous
     * writes and `settleArchive` reports on the entries those writes queued.
     * @param {string} guildId
     * @returns {number}
     */
    archiveMark(guildId) {
      return archiveGuilds.get(String(guildId))?.seq ?? 0;
    },

    /**
     * Wait for the background appends of the entries queued after mark `from` up to mark `to`
     * (every one queued so far when omitted) and report them once: `archived` the confirmed ones,
     * `deferred` how many went to the archive's pending queue instead (their items stay hot until
     * the drain archives them). An entry reported here is not reported again.
     * @param {string} guildId
     * @param {{ from?: number, to?: number }} [marks]
     * @returns {Promise<{ archived: Array<{ itemId: string, revisionId: string, itemKind: string, event: string }>, deferred: number }>}
     */
    async settleArchive(guildId, { from = 0, to = Infinity } = {}) {
      const state = archiveGuilds.get(String(guildId));
      if (!state) return { archived: [], deferred: 0 };
      for (;;) {
        const chain = state.chain;
        await chain;
        if (chain === state.chain) break;
      }
      const archived = [];
      let deferred = 0;
      for (const [seq, outcome] of state.outcomes) {
        if (seq <= from || seq > to) continue;
        state.outcomes.delete(seq);
        if (outcome.status === 'archived') archived.push({ itemId: outcome.itemId, revisionId: outcome.revisionId, itemKind: outcome.itemKind, event: outcome.event });
        else deferred += 1;
      }
      return { archived, deferred };
    },

    /**
     * Archive what waits: the entries neither archived nor queued as pending first, then the
     * archive's pending queue (src/memory/archive.js#drainPending); every victim now confirmed
     * is trimmed from its list. Runs whether or not features.archive is on (what waits was
     * queued while it was). No archive -> nothing.
     * @param {string} guildId
     * @returns {Promise<{ archived: number, left: number }>}
     */
    async drainArchive(guildId) {
      if (!archive) return { archived: 0, left: 0 };
      const state = archiveGuild(guildId);
      if (state.retry.length > 0) {
        const retry = state.retry.splice(0);
        for (const { group, status } of await appendQueued(guildId, retry)) {
          if (status === 'archived') for (const item of group) confirmHeld(state, item.entry);
        }
      }
      const result = (await archive.drainPending(guildId)) ?? {};
      for (const entry of Array.isArray(result.confirmed) ? result.confirmed : []) confirmHeld(state, entry);
      trimArchived(guildId);
      return { archived: Number(result.archived) || 0, left: Number(result.left) || 0 };
    },

    /**
     * Take every victim the archive confirmed out of its list now (it runs by itself after each
     * append and drain). Not while paused, and not for a file the cache does not hold.
     * @param {string} guildId
     * @returns {number} How many items went.
     */
    trimArchived(guildId) {
      return trimArchived(guildId);
    },

    /**
     * Put an archived item back into its hot list (`/nep memory restore`): the entry's text and
     * stored fields rebuild it under its own `itemId`, appended to the member's or the guild's
     * list without any cap (it is not pinned: the next write evicts it again by the usual rules).
     * Its text fields come back without links (`withoutLinks`; a plain-string item that was only
     * links is not restored, `kind`).
     * Kinds: episode, interest, detail, alias (a member's profile, or their private layer for a
     * private entry; no private aliases), lesson, selfFact, injoke, diary (the guild). Nothing
     * changes when the item is hot already (`hot`), the member has no profile or private layer
     * (`no-profile`), or the kind cannot go back (`kind`: moves, recent lines, participation
     * episodes and versions belong to their moment).
     * @param {string} guildId
     * @param {object} entry  An archive entry (src/memory/archive.js#archiveEntry).
     * @returns {{ restored: boolean, reason?: 'hot'|'no-profile'|'kind', item?: object|string }}
     */
    restoreArchived(guildId, entry) {
      const target = restoreTarget(guildId, entry);
      if (!target) return { restored: false, reason: 'kind' };
      if (!target.item) return { restored: false, reason: 'no-profile' };
      const where = listAt(target.item.value, target.path);
      if (!where) return { restored: false, reason: 'no-profile' };
      const list = Array.isArray(where.holder[where.key]) ? where.holder[where.key] : [];
      const strings = target.strings === true;
      // An entry archived before links were kept out of memory loses them on the way back.
      const text = isPlainObject(entry.text) ? withoutLinks(structuredClone(entry.text), Object.keys(entry.text)) : {};
      let value;
      if (strings) {
        value = typeof text.text === 'string' && text.text.trim() ? text.text : null;
        if (value === null) return { restored: false, reason: 'kind' };
      } else {
        value = {
          ...(isPlainObject(entry.stored) ? structuredClone(entry.stored) : {}),
          ...text,
          ...(Number.isFinite(entry.weight) ? { weight: entry.weight } : {}),
          itemId: entry.itemId,
        };
      }
      const ident = strings ? identOf(true, value) : entry.itemId;
      if (list.some((item) => identOf(strings, item) === ident)) return { restored: false, reason: 'hot' };
      where.holder[where.key] = [...list, value];
      target.item.dirty = true;
      return { restored: true, item: value };
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
