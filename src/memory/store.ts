// Persistent memory: the memory database (src/memory/db/service.ts) holds it, this module caches it -- it survives
// restarts, hot reloads and prompt edits; nothing in the codebase ever wipes it. Each cached value is one unit of the
// database, named by the path it had under data/ (`guilds/<g>/users/<u>.json`; the mappers of src/memory/db/map/
// turn a unit into rows and back); the operational files beside it stay JSON files under data/:
//
//   data/state.json                          (a file) the pause flag, the spontaneous schedule, token calibration,
//                                            the daily counters (LLM requests, videos and re-watches, pictures
//                                            drawn, web lookups, GIFs posted and watched), the open follow-up
//                                            windows, the ring of calls from other channels and the seen marks
//                                            of the channels a turn pulled in
//   guilds/<guildId>/guild.json              how this server talks, in-jokes, what the persona said about itself,
//                                            what people taught it (`learned`), and when the server notes last
//                                            changed and were last re-checked
//   guilds/<guildId>/users/<userId>.json     one profile per active member
//   guilds/<guildId>/private/<userId>.json   what the persona learned from one member in direct
//                                            messages: never shown anywhere but that member's DM
//   guilds/<guildId>/channels/<channelId>.json  one entry per channel the persona has seen (the server map),
//                                            with the tally of who writes there
//   guilds/<guildId>/lore.json               the guild's lorebook
//   data/guilds/<guildId>/media.json         (a file, its memory rows sent too) the media description cache
//   data/guilds/<guildId>/gifs.json          (a file) the GIF library the persona posts from (src/memory/gifs.ts)
//   guilds/<guildId>/recent.json             the recent store: short dated lines about the last
//                                            `memory.recentHours` hours, each with its source channel
//                                            (src/memory/recent.ts)
//   data/guilds/<guildId>/participation.json  (a file, its memory rows sent too) the persona's participation
//                                            episodes: slices of channels around her own lines over the last
//                                            `participation.hours` (src/memory/participation.ts)
//   guilds/<guildId>/diary.json              the persona's diary posts, newest last, one-line gists
//                                            (src/behavior/diary.ts); never deleted by code
//   data/guilds/<guildId>/recall-trace.jsonl  (a file) one JSON line per recall run when `features.recallTrace` is on
//                                            (appendRecallTrace): the newest `recall.traceMaxLines`, written
//                                            at once, not cached
//   guilds/<guildId>/versions/<kind>/<id>.json  the previous texts of the prose fields (see
//                                            `recordVersion`): users/<userId>, channels/<channelId>,
//                                            guild/guild, lore/<key> (src/memory/lore.ts#loreVersionKey);
//                                            capped per field
//
// The errand tasks (src/errands/store.ts) and the intentions (src/intentions/store.ts) are units of their own
// stores, not cached here. Everything is cached in memory, marked dirty on change and flushed on a timer and on
// shutdown: a memory unit's whole value goes to the database's writer through an outbox (src/memory/db/unit-outbox.ts),
// an operational file is written atomically (temp file + rename; when the OS refuses the rename the file is written
// in place instead, with a warning, see writeJsonAtomic).
//
// Nothing here forgets a member: there is no forget, purge or wipe. `removeLore` takes one lorebook entry out on
// the owner's word (`/nep lore remove`).
//
// The recent store has a documented retention of its own, applied only when
// `applyRecentOps` writes (src/memory/recent.ts#mergeRecent), never on read: a
// line expires `memory.recentHours` after its moment, the storage cap
// (`memory.maxRecentStored`) evicts the lightest, then the oldest when lines are
// added, and a write may remove a line by id. The one number is also the
// view's window, so a hot lowering of `memory.recentHours` deletes the older
// lines at the next write, and raising it again restores none. On load, lines a
// hand edit broke are left out and logged as a count.
//
// The participation store follows the same rules: every `setParticipation`
// runs src/memory/participation.ts#expireEpisodes (`participation.hours`, then
// `participation.maxStored`), never a read.
//
// With the archive on (src/memory/archive.ts, `features.archive`), whatever one of
// these retentions, a cap or a write takes out of a list stays in it, over
// the cap, until the archive confirms its copy; only then does `trimArchived`
// finish the removal. So no unit here loses an item before the archive holds it
// (see "The archive" inside createStore).

// health: allow file-length until 2027-04-01 -- one store over the cache, grown only by the typed signatures of its methods
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isRecord, propOf, isFiniteNumber, isIntegerNumber, canWriteUnits, readSeamOf } from './types.ts';
import { log } from '../log.js';
import { HOUR_MS, utcDay } from '../time.js';
import { emptyAffinity, applyDelta, decayAffinity } from './affinity.ts';
import { mergeEpisodes } from './episodes.ts';
import { loreVersionKey, upsertLore } from './lore.ts';
import { sentenceDiff } from './prose.ts';
import {
  applyInterestOps,
  applyValidity,
  attachDropped,
  normalizeInterests,
  normalizeTopic,
  stripTrailingParenthetical,
  validDay,
} from './interests.ts';
import { applyDetailOps, normalizeDetails } from './details.ts';
import { applyAliasOps } from './aliases.ts';
import { applyAddressUses, normalizeAddressedAs } from './addressed.ts';
import { clampText, stripUrls } from './clamp.ts';
import { feltLine } from './record.ts';
import { sortRanked } from './ranking.ts';
import { mergeEmojiUsage, normalizeEmojiUsage } from './emoji-usage.ts';
import {
  emptyGifs,
  findGif,
  markOwnGif,
  mergeGifs,
  normalizeBackfillStamp,
  normalizeGifs,
  resetGifCounts,
} from './gifs.ts';
import { emptyRecent, mergeRecent, normalizeRecent } from './recent.ts';
import { PARTICIPATION_DEFAULTS, emptyParticipation, expireEpisodes, normalizeParticipation } from './participation.ts';
import { ITEM_ID_PREFIX, archiveEntry, archiveRevision } from './archive.ts';
import { normalizeAvatar } from './avatars.ts';
import { DEFAULT_VAULT_DIR, SNAPSHOTS_DIR, memoryRootOf } from './root.ts';
import { unitValue } from './db/readers/common.ts';
import { idsUnderDir } from './db/export.ts';
import { classify } from './db/map/index.ts';
import { createUnitOutbox } from './db/unit-outbox.ts';
import type { StoredRecord, MemoryDb, Untyped } from './types.ts';

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
/** The kinds a profile's `closed` list holds (src/memory/interests.ts#applyValidity). */
const CLOSED_KINDS = ['interest', 'detail', 'alias', 'realName'];
/** How long a stored real name may be. */
const REAL_NAME_CHARS = 60;

/** The diary of a guild with no post yet (data/guilds/<id>/diary.json). */
const emptyDiary = () => ({ posts: [], updatedAt: 0 });

/** The prefix of an item's `itemId` by kind (src/memory/archive.ts#ITEM_ID_PREFIX, the one copy). */
export { ITEM_ID_PREFIX };

/** Whether `item` already carries an `itemId` (a non-empty string). */
function hasItemId(item: Untyped) {
  return typeof item?.itemId === 'string' && item.itemId !== '';
}

/**
 * `list` with an `itemId` (`prefix` + `newId()`) on every object item that has none; an item that
 * has one keeps it and stays the same object, anything that is not an object passes through. Pure
 * apart from `newId`; anything but an array -> `[]`.
 * @param prefix  One of `ITEM_ID_PREFIX`.
 */
function withItemIds(list: unknown, prefix: string, newId: () => string): Array<Untyped> {
  if (!Array.isArray(list)) return [];
  return list.map((item) => (isRecord(item) && !hasItemId(item) ? { ...item, itemId: `${prefix}${newId()}` } : item));
}

/**
 * `next` as `withItemIds` stamps it -- unless it equals `previous` as stored (JSON), in which case
 * `previous` comes back untouched: a merge that changed nothing does not rewrite the list just to
 * add ids, so a caller's before/after comparison still sees no change.
 */
function changedWithItemIds(
  previous: unknown,
  next: Array<StoredRecord>,
  prefix: string,
  newId: () => string
): Array<Untyped> {
  if (Array.isArray(previous) && JSON.stringify(previous) === JSON.stringify(next)) return previous;
  return withItemIds(next, prefix, newId);
}

/**
 * Strings leaving a list stored as plain strings (self facts, in-jokes), which have no place to
 * keep an id while stored: each as `{ itemId, text }` with a freshly minted id.
 */
function stringItems(
  texts: Array<string>,
  prefix: string,
  newId: () => string
): Array<{ itemId: string; text: string }> {
  return texts.map((text) => ({ itemId: `${prefix}${newId()}`, text }));
}

/**
 * The strings of `stored` that `next` no longer holds (compared by
 * src/memory/interests.ts#normalizeTopic), as `stringItems`.
 */
function droppedStrings(
  stored: unknown,
  next: unknown,
  prefix: string,
  newId: () => string
): Array<{ itemId: string; text: string }> {
  const held = new Set(
    (Array.isArray(next) ? next : []).filter((text) => typeof text === 'string').map(normalizeTopic)
  );
  const gone = (Array.isArray(stored) ? stored : []).filter(
    (text) => typeof text === 'string' && text.trim() && !held.has(normalizeTopic(text))
  );
  return stringItems(gone, prefix, newId);
}

/**
 * The list a held archive victim lives in: `{ holder, key }` with `holder[key]` the list, found by
 * walking `keys` from `value` (`['episodes']`, `['affinity', 'history']`, ...); null when a step on
 * the way is not an object.
 */
function listAt(value: unknown, keys: Array<string>): { holder: Record<string, Untyped>; key: string } | null {
  let holder = value;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(holder) || !isRecord(holder[key])) return null;
    holder = holder[key];
  }
  const last = keys.at(-1);
  return isRecord(holder) && last !== undefined ? { holder, key: last } : null;
}

/** How a held victim is found in its list: an object by its `itemId`, a plain string by its normalized text. */
function identOf(strings: Untyped, item: Untyped) {
  if (strings) return normalizeTopic(typeof item === 'string' ? item : item?.text);
  return typeof item?.itemId === 'string' && item.itemId ? item.itemId : null;
}

/** An item without its `itemId`, as JSON (a string by its normalized text): tells a stored item from its stamped copy. */
function anchorKey(strings: Untyped, item: Untyped) {
  if (strings) return normalizeTopic(typeof item === 'string' ? item : item?.text);
  if (!isRecord(item)) return JSON.stringify(item);
  const { itemId, ...rest } = item;
  return JSON.stringify(rest);
}

/**
 * `current` (a list after a write) with every one of `victims` it no longer holds put back where
 * it stood in `previous` (before the next item of `previous` that `current` still holds, else after the
 * nearest earlier one it still holds, else first; a victim `previous` never held goes last). A string
 * list gets the victims' `text` back. Pure.
 * @param victims  Objects with an `itemId`, or `{ itemId, text }` for a string list.
 */
function reinsert(
  previous: Array<unknown>,
  current: Array<unknown>,
  victims: Array<StoredRecord>,
  strings: boolean
): Array<unknown> {
  const result = [...current];
  const before = Array.isArray(previous) ? previous : [];
  const beforeKeys = before.map((item) => anchorKey(strings, item));
  const sameAs = (a: Untyped, b: Untyped) =>
    anchorKey(strings, a) === anchorKey(strings, b) ||
    (!strings && identOf(false, a) !== null && identOf(false, a) === identOf(false, b));
  for (const victim of victims) {
    if (result.some((item) => sameAs(item, victim))) continue;
    const from = beforeKeys.indexOf(anchorKey(strings, victim));
    let at = result.length;
    if (from !== -1) {
      at = -1;
      for (let i = from + 1; i < before.length && at === -1; i += 1)
        at = result.findIndex((item) => sameAs(item, before[i]));
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
function removeKeysOf(list: Untyped) {
  const keys = new Set<string>();
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw === 'string' && raw.trim()) keys.add(normalizeTopic(stripTrailingParenthetical(raw).topic));
    if (typeof raw === 'string' && raw.trim()) keys.add(normalizeTopic(raw));
    if (typeof raw === 'number' && isFiniteNumber(raw)) keys.add(String(raw));
  }
  return keys;
}

/**
 * The archive event of a ranked item (interest, detail, alias, lesson) a write dropped: `replaced`
 * when an op's `remove` named it, `merged` when it was an interest folded into another under its
 * topic without the trailing qualifier, else `evicted` (the cap).
 * @param identity  The item's identity field (`topic`, `text`, `name`).
 * @param removing  removeKeysOf(ops.remove)
 * @param kept  The list after the write.
 */
function rankedEvent(
  victim: StoredRecord,
  identity: string,
  removing: Set<string>,
  kept: Array<StoredRecord>,
  interest: boolean
): 'replaced' | 'merged' | 'evicted' {
  const key = normalizeTopic(victim?.[identity]);
  if (removing.has(key) || (isFiniteNumber(victim?.id) && removing.has(String(victim.id)))) return 'replaced';
  if (interest) {
    const base = normalizeTopic(stripTrailingParenthetical(victim?.topic).topic);
    if (base !== key && kept.some((item) => normalizeTopic(item?.topic) === base)) return 'merged';
  }
  return 'evicted';
}

function readJson(file: string, fallback: Untyped) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (propOf(err, 'code') !== 'ENOENT') log.warn('store: unreadable file, using fallback', { file, error: err });
    return fallback;
  }
}

/** Every `.json` file under `dir`, recursively; never throws on a missing directory. */
function walkJsonFiles(dir: string): Array<string> {
  let out: Array<string> = [];
  let dirEntries: Array<fs.Dirent>;
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
 */
function findInvalidJsonFiles(
  dataDir: string,
  { only = null }: { only?: ((rel: string) => boolean) | null } = {}
): Array<string> {
  const bad: Array<string> = [];
  for (const file of walkJsonFiles(dataDir)) {
    if (only && !only(memoryRootOf(dataDir).relative(file))) continue;
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      bad.push(memoryRootOf(dataDir).relative(file));
    }
  }
  return bad;
}

/**
 * The JSON files written as files (src/memory/db/paths.ts#OPERATIONAL_PATTERNS lists every operational path): the
 * process's operational state, the request dumps and tool lists, the backfill folder, the vault and the snapshots, the
 * GIF library and the vision cache, the participation file, and the unit writes a shutdown could not make
 * (`memory-pending/`). Paths relative to the data directory. `/nep resume` checks only these (`validate`).
 */
export function operationalJsonPath(rel: string): boolean {
  const name = String(rel).replace(/\\/g, '/');
  if (/^(?:state|usage|metrics)\.json$/.test(name)) return true;
  if (/^(?:vault|snapshots)\//.test(name)) return true;
  // The unit writes a shutdown could not make (src/memory/db/service.ts#keepPending).
  if (/^memory-pending\//.test(name)) return true;
  const inGuild = /^guilds\/[^/]+\/(?:private\/[^/]+\/)?(.+)$/.exec(name)?.[1];
  if (!inGuild) return false;
  return (
    /^(?:state|usage|metrics|inner|missed|participation|gifs|media)\.json$/.test(inGuild) ||
    /^journal\/requests\//.test(inGuild) ||
    /^backfill\//.test(inGuild) ||
    inGuild === 'record/backfill.json'
  );
}

/**
 * Write `value` as pretty JSON to `file` through a temp file and a rename, so a
 * crash mid-write never leaves a half-written file; creates missing directories.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, JSON.stringify(value, null, 2));
}

/** `text` written to `file` the way writeJsonAtomic writes (temp file + rename, in place with a warning). */
function writeTextAtomic(file: string, text: string) {
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

/** `memory.vaultDir` when it is missing and the snapshots directory: src/memory/root.ts, re-exported here. */
export { DEFAULT_VAULT_DIR, SNAPSHOTS_DIR };

/**
 * A member profile nobody has written to yet: what every write starts from (`touchUser`,
 * `applyProfileOps`, ...) and what `getUser` heals a hand-edited file towards.
 */
export function emptyProfile(id: string): object {
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
    aliases: [], // ranked items { name, weight, firstSeen, lastSeen } -- see src/memory/aliases.ts
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
    emojiBackfill: null, // { at, channels, messages } once src/memory/emoji-backfill.ts has read the history
    pingsOff: [], // ids of the members who turned the persona's notifications off (`/nep pings`) -- see setPingsOff
    updatedAt: null,
    notesUpdatedAt: null, // when patterns, starters or injokes last changed -- see updateGuild
    notesCheckedAt: null, // an ISO time kept as stored; nothing in the engine writes it
    notesFlaggedAt: null, // when the analyzer last flagged them stale -- see markNotesFlagged
    notesSampleReviewedAt: null, // when a sample refresh last reviewed them -- see markNotesSampled
    notesAttemptAt: null, // when a sample refresh last tried and failed -- see markNotesSampled
  };
}

/** The server notes among the guild's fields: a change of one of them moves `notesUpdatedAt`. */
const NOTES_FIELDS = ['patterns', 'starters', 'injokes'];

/** Whether merging `patch` over `target` would change anything stored, compared as it lands on
 * disk (JSON): a write that changes nothing must not be stamped, so `updatedAt` stays honest. */
function changesStored(target: Untyped, patch: Untyped) {
  return Object.entries(patch).some(([key, value]) => JSON.stringify(target[key]) !== JSON.stringify(value));
}

/** A stored ISO stamp as it is when it reads as a time, else null (missing, cleared, hand-broken). */
function isoStampOrNull(value: Untyped) {
  return typeof value === 'string' && isFiniteNumber(Date.parse(value)) ? value : null;
}

/** A channel of the server map as the store keeps it: its text notes, its day tally and who writes in it. */
export type ChannelEntry = {
  id: string;
  name: string;
  category: string | null;
  topic: string | null;
  purpose: string;
  topics: string;
  tone: string;
  days: Record<string, number>;
  messageCount: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  topWriters: Array<{ id: string; count: number }>;
  writers: Record<string, { count: number; last: number }>;
  updatedAt: string | null;
  notesCheckedAt: string | null;
  notesFlaggedAt: string | null;
  notesSampleReviewedAt: string | null;
  notesAttemptAt: string | null;
};

export function emptyChannel(id: string): ChannelEntry {
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
    notesCheckedAt: null, // an ISO time kept as stored; nothing in the engine writes it
    notesFlaggedAt: null, // when the analyzer last flagged them stale -- see markNotesFlagged
    notesSampleReviewedAt: null, // when a sample refresh last reviewed them -- see markNotesSampled
    notesAttemptAt: null, // when a sample refresh last tried and failed -- see markNotesSampled
  };
}

/** Normalize a profile's `interests`/`details`/`aliases` fields in place:
 * stored JSON is untrusted (possibly hand-edited while paused) -- `interests`
 * is validated via src/memory/interests.ts#normalizeInterests, `details` via
 * src/memory/details.ts#normalizeDetails (assigning fresh ids off the
 * profile's own `detailsSeq` counter when needed), `aliases` becomes `[]`
 * when it is not already an array. Never marks anything dirty -- the caller
 * (`getUser`/`applyProfileOps`) decides whether this is persisted. */
function normalizeProfile(profile: Untyped) {
  profile.interests = normalizeInterests(profile.interests);

  if (!isIntegerNumber(profile.detailsSeq) || profile.detailsSeq < 1) profile.detailsSeq = 1;
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
  // The current avatar (src/memory/avatars.ts): absent stays absent, a hand-broken one goes.
  if ('avatar' in profile) {
    const avatar = normalizeAvatar(profile.avatar);
    if (avatar) profile.avatar = avatar;
    else delete profile.avatar;
  }
}

/** A stored `realName` (`{ name, from, to: null, itemId, recordedAt? }`) as it may be kept: a
 * non-empty string `name`; `from` a real day or null; `itemId`/`recordedAt` only when non-empty
 * strings. Anything else is null (the field goes). */
function normalizeRealName(value: Untyped) {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) return null;
  const out: Record<string, Untyped> = { name: value.name, from: validDay(value.from), to: null };
  if (typeof value.itemId === 'string' && value.itemId) out.itemId = value.itemId;
  if (typeof value.recordedAt === 'string' && value.recordedAt) out.recordedAt = value.recordedAt;
  return out;
}

/**
 * Apply one batch's `realName` answer to a profile's stored real name. `raw` is a string or
 * `{ name, supersedes?, validFrom? }`; the name is trimmed and clamped to 60 characters. Nothing
 * changes for a missing or empty name, nor for one equal to the stored one (case-insensitive: a
 * sighting). With nothing stored, the name is set. A different name replaces the stored one only
 * when `supersedes` names it (its `itemId` or its name, src/memory/interests.ts#applyValidity):
 * the stored one is closed (`validTo` = `validFrom` when given, else the batch day; `supersededBy`
 * = the new `itemId`) and returned for the profile's `closed` list; without that the stored name
 * stays. The new value is `{ name, from, to: null, itemId, recordedAt }`, `from` = `validFrom`
 * when it is a real day, else the batch day.
 * @param stored  The profile's `realName`.
 * @returns null when nothing changes.
 */
function applyRealName(
  stored: StoredRecord,
  raw: unknown,
  { seenAt, now, mintId }: { seenAt: number; now?: number; mintId: () => string }
): { realName: Untyped; closed: Array<Untyped> } | null {
  const op = isRecord(raw) ? raw : { name: raw };
  if (typeof op.name !== 'string') return null;
  const name = clampText(stripUrls(op.name), REAL_NAME_CHARS, { tolerance: 1 });
  if (!name) return null;
  const batchDay = new Date(seenAt).toISOString().slice(0, 10);
  const recordedAt = new Date(isFiniteNumber(now) ? now : seenAt).toISOString();
  const fresh = () => ({ name, from: validDay(op.validFrom) ?? batchDay, to: null, itemId: mintId(), recordedAt });
  if (!stored) return { realName: fresh(), closed: [] };
  if (normalizeTopic(stored.name) === normalizeTopic(name)) return null;
  // The stored name as a ranked-item claim, so the shared validity rules close it.
  const current = {
    name: stored.name,
    validFrom: stored.from ?? undefined,
    itemId: stored.itemId,
    recordedAt: stored.recordedAt,
  };
  if (current.validFrom === undefined) delete current.validFrom;
  const next: Record<string, Untyped> = { name };
  const items = [current, next];
  const closed = applyValidity(items, [{ item: next, supersedes: op.supersedes, validFrom: op.validFrom }], {
    batchDay,
    recordedAt,
    mintId,
    findOther: (ref) =>
      typeof ref === 'string' && normalizeTopic(ref) === normalizeTopic(current.name) ? current : undefined,
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
function normalizeClosed(holder: Untyped) {
  if (!('closed' in holder)) return;
  holder.closed = Array.isArray(holder.closed)
    ? holder.closed.filter((item: Untyped) => isRecord(item) && CLOSED_KINDS.includes(item.kind))
    : [];
}

/**
 * A member's private layer before anything was said in a direct message:
 * no id or names (those live in the public profile), its own affinity
 * starting at 0, the daily DM reply counter and its own observation buffer.
 */
function emptyPrivate(): Untyped {
  return {
    relationship: '',
    interests: [],
    details: [],
    detailsSeq: 1,
    episodes: [],
    affinity: emptyAffinity(),
    firstSeen: '',
    lastSeen: '',
    buffer: [],
  };
}

/** Normalize a private file in place: `interests`/`details`/`detailsSeq`
 * exactly as `normalizeProfile`, plus the defaults of `emptyPrivate` for
 * every field that is missing or of the wrong type (the file is untrusted,
 * possibly hand-edited while paused). Never marks anything dirty -- same
 * contract as `normalizeProfile`. */
function normalizePrivate(priv: Untyped) {
  priv.interests = normalizeInterests(priv.interests);

  if (!isIntegerNumber(priv.detailsSeq) || priv.detailsSeq < 1) priv.detailsSeq = 1;
  const { items, nextId } = normalizeDetails(priv.details, priv.detailsSeq);
  priv.details = items;
  priv.detailsSeq = nextId;
  normalizeClosed(priv);

  if (typeof priv.relationship !== 'string') priv.relationship = '';
  if (!Array.isArray(priv.episodes)) priv.episodes = [];

  const affinity =
    priv.affinity && typeof priv.affinity === 'object' && !Array.isArray(priv.affinity) ? priv.affinity : {};
  priv.affinity = {
    ...affinity,
    score: isFiniteNumber(affinity.score) ? affinity.score : 0,
    reason: typeof affinity.reason === 'string' ? affinity.reason : '',
    history: Array.isArray(affinity.history) ? affinity.history : [],
  };

  for (const key of ['firstSeen', 'lastSeen']) {
    if (typeof priv[key] !== 'string') priv[key] = '';
  }

  // `replies`, a field nothing reads, is dropped; the next write of the file leaves it out.
  delete priv.replies;

  if (!Array.isArray(priv.buffer)) priv.buffer = [];
}

/** Fields a guild.json may still hold from features the engine no longer has; dropped on read. */
const STALE_GUILD_FIELDS = ['ownLines', 'worn', 'wornLong', 'wornHistory', 'fillers', 'ownMessageCount'];

/** Normalize a guild's `learned`/`learnedNextId`/`emojiUsage`/`emojiBackfill` fields in place: a
 * guild.json written before this list existed loads it as empty, a
 * hand-edited one is validated via src/memory/details.ts#normalizeDetails
 * (fresh ids off `learnedNextId` when needed). The two notes stamps
 * (`notesUpdatedAt`, `notesCheckedAt`) are kept when they read as a time and
 * are null otherwise: a guild.json written before them has never been
 * stamped, which readers take as stale notes. The keys in
 * STALE_GUILD_FIELDS are deleted (they reach disk at the next write). Every
 * other field is left exactly as stored; a non-object value is left alone entirely. Never marks
 * anything dirty -- same contract as `normalizeProfile`. */
function normalizeGuild(guild: Untyped) {
  if (!guild || typeof guild !== 'object' || Array.isArray(guild)) return;
  if (!isIntegerNumber(guild.learnedNextId) || guild.learnedNextId < 1) guild.learnedNextId = 1;
  const { items, nextId } = normalizeDetails(guild.learned, guild.learnedNextId);
  guild.learned = items;
  guild.learnedNextId = nextId;
  // Missing or hand-broken -> {} (src/memory/emoji-usage.ts#normalizeEmojiUsage).
  guild.emojiUsage = normalizeEmojiUsage(guild.emojiUsage);
  // Missing or hand-broken -> null: the history backfill has not run.
  guild.emojiBackfill = normalizeBackfillStamp(guild.emojiBackfill);
  for (const key of STALE_GUILD_FIELDS) delete guild[key];
  // Missing or hand-broken -> []: nobody turned pings off. Non-empty string ids only, each once.
  guild.pingsOff = Array.isArray(guild.pingsOff)
    ? [...new Set(guild.pingsOff.filter((id: string) => typeof id === 'string' && id))]
    : [];
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
function relationshipScoreOf(opts: Untyped, affinity: Untyped) {
  if (isFiniteNumber(opts?.relationshipScore)) return opts.relationshipScore;
  return isFiniteNumber(affinity?.score) ? affinity.score : 0;
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
 * (src/memory/affinity.ts#applyDelta), so src/memory/affinity.ts#relationshipStaleOf counts the
 * moves since the text like with like. A profile written before the stamp existed keeps none
 * until its next text. A written text removes the forced-rewrite flag (`relationshipRewrite`,
 * see `markRelationshipRewrite`): the rewrite it asked for has happened.
 * @param target  A normalised profile or private layer.
 * @param opts    As for `applyProfileOps`.
 * @param [onWrite]  Called with the stored text and the
 *   one replacing it, before the write (the public profile records a version through it).
 */
function writeRelationship(
  target: StoredRecord,
  raw: unknown,
  opts: StoredRecord,
  onWrite?: (previous: unknown, next: string) => void
) {
  const text = typeof raw === 'string' ? stripUrls(raw) : raw;
  if (typeof text !== 'string' || !text.trim()) return;
  const next = firstWriteText(
    target.relationship,
    text,
    opts.relationshipChars ?? opts.fieldChars,
    opts.clampTolerance
  );
  onWrite?.(target.relationship, next);
  target.relationship = next;
  target.relationshipScore = relationshipScoreOf(opts, target.affinity);
  target.relationshipWrittenAt = new Date(isFiniteNumber(opts.now) ? opts.now : Date.now()).toISOString();
  delete target.relationshipRewrite;
}

/**
 * The text a prose writer stores: a first write (`previous` empty, nothing to lose yet) is
 * clamped to `limit` as before; a rewrite is only trimmed, never cut. A rewrite over its limit is
 * the caller's to refuse (src/memory/prose.ts#acceptProse) -- the store never shortens one.
 * @param previous  The stored text.
 * @param text       A non-blank string.
 */
function firstWriteText(previous: unknown, text: string, limit: number | undefined, tolerance?: number): string {
  const first = typeof previous !== 'string' || previous.trim() === '';
  return first ? clampText(text, limit, { tolerance }) : text.trim();
}

/**
 * `fields` with the links taken out (`stripUrls`) of every string or list of strings that `keys`
 * names. A string that held only links is left out of the copy, and so is such an entry of a list,
 * so it never blanks a stored text. Every other field is kept as given.
 * @returns A shallow copy.
 */
function withoutLinks(fields: StoredRecord, keys: Array<string>): Untyped {
  const out = { ...fields };
  const clean = (value: Untyped) => (typeof value === 'string' ? stripUrls(value) : value);
  const emptied = (value: Untyped, cleaned: Untyped) =>
    typeof value === 'string' && value.trim() !== '' && cleaned === '';
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
function seenAtOf(opts: Untyped) {
  if (isFiniteNumber(opts?.seenAt)) return opts.seenAt;
  return isFiniteNumber(opts?.now) ? opts.now : Date.now();
}

/** What a write took out of a profile or a private layer: the items that left, and the claims it closed. */
type ItemDrops = {
  interests: Array<Untyped>;
  details: Array<Untyped>;
  closed: { interest: Array<Untyped>; detail: Array<Untyped>; alias?: Array<Untyped>; realName?: Array<Untyped> };
};

/**
 * Apply `ops.interests` (src/memory/interests.ts#applyInterestOps) and `ops.details`
 * (src/memory/details.ts#applyDetailOps, advancing `target.detailsSeq`) to a public profile
 * or a private layer, in place -- the item blocks `applyProfileOps` and `applyPrivateOps`
 * share. Only the ops-object shape is taken; anything else changes nothing. Every item of a list
 * the ops changed gets an `itemId` when it has none (`changedWithItemIds`), and so does every
 * item that left.
 * @param target  A normalised profile or private layer.
 * @param opts    As for `applyProfileOps`.
 *   The stored items that left (removed, folded into another, evicted); `closed`: the claims a
 *   `supersedes` closed, for `storeClosed`.
 */
function applyItemOps(
  target: StoredRecord,
  ops: StoredRecord,
  opts: StoredRecord,
  seenAt: number,
  newId: () => string
): ItemDrops {
  const dropped: ItemDrops = { interests: [], details: [], closed: { interest: [], detail: [] } };
  if (isRecord(ops?.interests)) {
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
  if (isRecord(ops?.details)) {
    const {
      items,
      nextId,
      dropped: gone,
      closed,
    } = applyDetailOps(target.details, ops.details, {
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
function trimDays(days: Untyped, max: number) {
  const keys = Object.keys(days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete days[key];
}

// ---- who writes in a channel: the `writers` tally behind `topWriters` ----
//
// A channel entry keeps `writers: { [id]: { count, last } }` for more writers than it shows, and
// `topWriters` is the best five of it. Rank is the shared one of src/memory/ranking.ts: `count` is
// the weight, `last` (the ts of the writer's latest message) drives the decay, so a newcomer
// gathers a count below the five shown and passes a writer who went silent. A list of five that
// drops whoever is sixth can never change again.

const TOP_WRITERS = 5; // how many writers `topWriters` shows
const WRITERS_STORED = 20; // config.json's memory.channelWritersStored
const WRITERS_HALF_LIFE_DAYS = 30; // config.json's memory.channelWritersHalfLifeDays
const MAX_DATE_MS = 8.64e15; // the last instant a Date can hold

/** `value` as the time of a message: a positive epoch ms a Date can hold, else 0 (unknown). */
function writerTs(value: Untyped) {
  return isFiniteNumber(value) && value > 0 && value <= MAX_DATE_MS ? value : 0;
}

/** `value` as a count of messages: a whole number of at least 1, else 0. */
function writerCount(value: Untyped) {
  return isFiniteNumber(value) && value >= 1 ? Math.floor(value) : 0;
}

/**
 * The tally settings of one `touchChannel` call, from the `config.memory` keys of the same name
 * (the caller reads them at the moment of use): `stored` = `channelWritersStored`, never fewer
 * than the five shown, and `halfLifeDays` = `channelWritersHalfLifeDays` (0 or less = no decay,
 * the count alone ranks). A missing key, or one that is not a number, is config.json's value.
 */
function writersSettings(opts?: { channelWritersStored?: number; channelWritersHalfLifeDays?: number }): {
  stored: number;
  halfLifeDays: number;
} {
  const stored = opts?.channelWritersStored ?? WRITERS_STORED;
  const halfLifeDays = opts?.channelWritersHalfLifeDays ?? WRITERS_HALF_LIFE_DAYS;
  return {
    stored: Math.max(TOP_WRITERS, isFiniteNumber(stored) ? Math.floor(stored) : WRITERS_STORED),
    halfLifeDays: isFiniteNumber(halfLifeDays) ? halfLifeDays : WRITERS_HALF_LIFE_DAYS,
  };
}

/**
 * A stored `writers` tally made safe to read: an entry without a count of at least 1 is dropped,
 * a `last` that is no time becomes 0. Never mutates `value`.
 * @param value  A plain object.
 */
function normalizeWriters(value: StoredRecord): Record<string, { count: number; last: number }> {
  const out: Record<string, { count: number; last: number }> = {};
  for (const [id, entry] of Object.entries<Untyped>(value)) {
    const count = isRecord(entry) ? writerCount(entry.count) : 0;
    if (!id || count < 1) continue;
    out[id] = { count, last: writerTs(entry.last) };
  }
  return out;
}

/**
 * The tally a `topWriters` list (`{ id, count }[]`, best first) stands for, every writer dated
 * `last` -- the channel's `lastMessageAt` for an entry stored before the tally existed. Items without an id
 * or a count of at least 1 are skipped. The first listed is inserted last, so writers of an equal
 * count keep their listed order at the next ranking (see `sortByRank`'s tie rule).
 */
function writersFromTop(topWriters: unknown, last: unknown): Record<string, { count: number; last: number }> {
  const out: Record<string, { count: number; last: number }> = {};
  for (const writer of [...(Array.isArray(topWriters) ? topWriters : [])].reverse()) {
    const id = writer?.id === undefined || writer?.id === null ? '' : String(writer.id);
    const count = writerCount(writer?.count);
    if (!id || count < 1) continue;
    out[id] = { count, last: writerTs(last) };
  }
  return out;
}

/**
 * `writers` as `[{ id, count, last }]`, best first (src/memory/ranking.ts#sortByRank: `count` is
 * the weight, `last` the date; ties go to the later message, then to the writer counted last).
 * @param writers  A normalised tally.
 */
function rankWriters(
  writers: Record<string, { count: number; last: number }>,
  halfLifeDays: number
): Array<{ id: string; count: number; last: number }> {
  const items = Object.entries(writers).map(([id, entry]) => ({
    id,
    ...entry,
    weight: entry.count,
    lastSeen: entry.last > 0 ? new Date(entry.last).toISOString() : null,
  }));
  return sortRanked(items, halfLifeDays).map(({ id, count, last }) => ({ id, count, last }));
}

/**
 * Count one message of `authorId` at `ts` into a channel's tally -- used by `touchChannel` (live
 * traffic, one message at a time); ids compared as strings. `last` only moves forward (a message
 * that arrives late is counted and dates nothing). Past `stored` writers the lowest-ranked leave
 * and lose their count. Never mutates `writers`.
 * @param writers  A normalised tally.
 * @param settings  See `writersSettings`.
 * @returns The new tally and its best five, best first.
 */
function countWriter(
  writers: Record<string, { count: number; last: number }>,
  authorId: string,
  ts: number,
  { stored, halfLifeDays }: { stored: number; halfLifeDays: number }
): { writers: Record<string, { count: number; last: number }>; topWriters: Array<{ id: string; count: number }> } {
  const id = String(authorId);
  const next = { ...writers };
  const before = next[id];
  // Re-inserted so the writer just counted sits last: an exact rank tie keeps them (see sortByRank).
  delete next[id];
  next[id] = { count: (before?.count ?? 0) + 1, last: Math.max(before?.last ?? 0, writerTs(ts)) };
  const ranked = rankWriters(next, halfLifeDays);
  for (const evicted of ranked.slice(stored)) delete next[evicted.id];
  return {
    writers: next,
    topWriters: ranked.slice(0, TOP_WRITERS).map((writer) => ({ id: writer.id, count: writer.count })),
  };
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
function normalizeChannel(channel: Untyped) {
  if (!isRecord(channel)) return;
  channel.writers = isRecord(channel.writers)
    ? normalizeWriters(channel.writers)
    : writersFromTop(channel.topWriters, channel.lastMessageAt);
  channel.notesCheckedAt = isoStampOrNull(channel.notesCheckedAt);
  channel.notesFlaggedAt = isoStampOrNull(channel.notesFlaggedAt);
  channel.notesSampleReviewedAt = isoStampOrNull(channel.notesSampleReviewedAt);
  channel.notesAttemptAt = isoStampOrNull(channel.notesAttemptAt);
}

/** A cached file of the store: its parsed value, whether it waits for a flush, and the holds on that flush. */
type CacheItem = { value: Untyped; dirty: boolean; holdFlush?: number; stale?: boolean };

type StoreClosedInput = {
  item: Untyped;
  file: string;
  target: Untyped;
  closed: Untyped;
  opts: Untyped;
  privateUserId?: string | null;
};

type ArchiveProfileItemsInput = {
  item: Untyped;
  file: string;
  previous: Untyped;
  dropped: Untyped;
  ops: Untyped;
  privateUserId?: string | null;
};

type ArchiveReplacedInput = {
  previous: Untyped;
  current: Untyped;
  itemKind: string;
  scope: Untyped;
  privateUserId?: string | null;
  item?: Untyped;
};

type StoreDeps = {
  dataDir: string;
  newId?: () => string;
  record?: { append: Untyped } | null;
  recordOn?: () => boolean;
  archive?: Untyped;
  archiveOn?: () => boolean;
  memoryDb?: MemoryDb | null;
};

type ProfileOpsOptions = {
  character?: string;
  style?: string;
  relationship?: string;
  interests?: { add?: Array<Untyped>; update?: Array<Untyped>; seen?: Array<string>; remove?: Array<string> };
  details?: { add?: Array<unknown>; seen?: Array<unknown>; remove?: Array<unknown> };
  aliases?: { add?: Array<string>; remove?: Array<string> };
  realName?: string | { name: string; supersedes?: string; validFrom?: string };
};

type PrivateOpsOptions = {
  relationship?: string;
  interests?: { add?: Array<Untyped>; update?: Array<Untyped>; seen?: Array<string>; remove?: Array<string> };
  details?: { add?: Array<unknown>; seen?: Array<unknown>; remove?: Array<unknown> };
};

type UpdateGuildOptions = {
  by?: string;
  versions?: { enabled?: boolean; kept?: number };
  onDropped?: (dropped: { injokes: Array<Untyped>; self: Array<Untyped> }) => void;
};

type LearnedOpsOptions = {
  seenAt?: number;
  maxLearned?: number;
  maxLearnedStored?: number;
  learnedChars?: number;
  learnedHalfLifeDays?: number;
  confirmGapHours?: number;
  clampTolerance?: number;
};

type SetLoreOptions = {
  source: 'analyzer' | 'owner';
  now?: number;
  maxEntries?: number;
  textChars?: number;
  clampTolerance?: number;
};

type RecentOpsOptions = {
  now?: number;
  hours?: number;
  maxStored?: number;
  maxNew?: number;
  chars?: number;
  clampTolerance?: number;
  removeIds?: Array<unknown>;
};

type DiaryPostOptions = {
  at: number;
  kind: string | null;
  gist: string;
  picture: string | boolean | null;
  pictures?: number;
  messageIds?: Array<string>;
  search: string;
  text?: string;
  itemId?: string;
};

type HoldVictimsInput = {
  item: CacheItem;
  file: string;
  path: Array<string>;
  strings?: boolean;
  previous: Array<unknown>;
  victims: Array<Untyped>;
  itemKind: string;
  eventOf: (victim: Untyped, index: number) => string;
  scope: Record<string, Untyped> | ((victim: Untyped) => Record<string, Untyped>);
  privateUserId?: string | null;
  userId?: string | null;
};

// health: allow function-length until 2027-04-01 -- one closure over the cache, grown only by the typed signatures of its methods
function buildStore({
  dataDir,
  newId = randomUUID,
  record = null,
  recordOn = () => Boolean(record),
  archive = null,
  archiveOn = () => Boolean(archive),
  memoryDb = null,
}: StoreDeps) {
  const root = memoryRootOf(dataDir);
  const seam = readSeamOf(memoryDb, log, 'store');
  const entries = new Map<string, CacheItem>();
  // The units a flush hands over, until their write resolved.
  const outbox = canWriteUnits(memoryDb) ? createUnitOutbox({ memoryDb, log, name: 'store' }) : null;

  // ---- The archive (src/memory/archive.ts): nothing leaves a hot list without a copy ----
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

  function archiveGuild(guildId: string) {
    const key = String(guildId);
    let state = archiveGuilds.get(key);
    if (!state) {
      state = {
        seq: 0,
        queue: [],
        held: [],
        outcomes: new Map(),
        retry: [],
        chain: Promise.resolve(),
        scheduled: false,
      };
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
  function queueArchiveEntry(
    guildId: string,
    entry: Untyped,
    privateUserId: string | null = null,
    holdItem: Untyped = null
  ) {
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
      .catch((error: Untyped) =>
        log.warn('store: archive failed', { guildId: String(guildId), code: error?.code ?? null })
      );
  }

  /** Let the file a queued entry held back be flushed again (once per entry). */
  function releaseHold(queued: Untyped) {
    const item = queued?.holdItem;
    if (!item) return;
    queued.holdItem = null;
    item.holdFlush = Math.max(0, (item.holdFlush ?? 0) - 1);
  }

  /** Mark the held victim of `entry` confirmed: the archive holds its copy. */
  function confirmHeld(state: Untyped, entry: Untyped) {
    for (const held of state.held) {
      if (held.itemId === entry?.itemId && held.revisionId === entry?.revisionId) held.confirmed = true;
    }
  }

  function noteOutcome(state: Untyped, queued: Untyped, status: Untyped) {
    if (status === 'archived') confirmHeld(state, queued.entry);
    const { itemId, revisionId, itemKind, event } = queued.entry;
    state.outcomes.set(queued.seq, { status, itemId, revisionId, itemKind, event });
    while (state.outcomes.size > ARCHIVE_OUTCOMES_KEPT) state.outcomes.delete(state.outcomes.keys().next().value);
  }

  /** `queued` grouped by the archive they go to: the guild's (`''`) or a member's private one. */
  function byArchive(queued: Untyped) {
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
  async function appendQueued(guildId: string, queued: Untyped) {
    const state = archiveGuild(guildId);
    const results = [];
    for (const [key, group] of byArchive(queued)) {
      const opts = key ? { privateUserId: key } : {};
      const entries = group.map((item: Untyped) => item.entry);
      try {
        await archive.append(guildId, entries, opts);
        group.forEach(releaseHold);
        results.push({ group, status: 'archived' });
      } catch (error) {
        log.warn('store: archive failed', {
          guildId: String(guildId),
          entries: entries.length,
          ...(key ? { private: true } : {}),
          code: propOf(error, 'code') ?? null,
        });
        try {
          await archive.queuePending(guildId, entries, opts);
          group.forEach(releaseHold);
        } catch (queueError) {
          log.warn('store: archive queue failed', {
            guildId: String(guildId),
            entries: entries.length,
            code: propOf(queueError, 'code') ?? null,
          });
          state.retry.push(...group);
        }
        results.push({ group, status: 'deferred' });
      }
    }
    return results;
  }

  async function sendArchiveQueue(guildId: string) {
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
   */
  function holdVictims(guildId: string, site: HoldVictimsInput) {
    if (!archiving()) return;
    const state = archiveGuild(guildId);
    const strings = site.strings === true;
    const siteKey = `${site.file}#${site.path.join('.')}`;
    const where = listAt(site.item.value, site.path);
    if (!where) return;
    const current = Array.isArray(where.holder[where.key]) ? where.holder[where.key] : [];
    const victims = (Array.isArray(site.victims) ? site.victims : []).filter((victim) =>
      strings ? typeof victim?.text === 'string' : isRecord(victim) && identOf(false, victim) !== null
    );
    const victimIds = new Set(victims.map((victim) => identOf(strings, victim)));
    // A victim of the cap that this write's merge kept ranks again: released. A removed or replaced one stays held.
    state.held = state.held.filter(
      (held: Untyped) =>
        held.siteKey !== siteKey ||
        held.event !== 'evicted' ||
        victimIds.has(held.ident) ||
        !current.some((item: Untyped) => identOf(strings, item) === held.ident)
    );
    if (victims.length === 0) return;
    victims.forEach((victim, index) => {
      const ident = identOf(strings, victim);
      const revisionId = archiveRevision(site.itemKind, victim);
      if (
        state.held.some(
          (held: Untyped) => held.siteKey === siteKey && held.ident === ident && held.revisionId === revisionId
        )
      )
        return;
      const scope = typeof site.scope === 'function' ? site.scope(victim) : site.scope;
      const entry: StoredRecord = archiveEntry(victim, {
        itemKind: site.itemKind,
        event: site.eventOf(victim, index),
        scope,
        uuid: newId,
      });
      state.held.push({
        siteKey,
        file: site.file,
        path: site.path,
        strings,
        ident,
        itemId: entry.itemId,
        revisionId,
        itemKind: site.itemKind,
        event: entry.event,
        userId: site.userId ?? null,
        confirmed: false,
      });
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
  function archiveReplaced(
    guildId: string,
    { previous, current, itemKind, scope, privateUserId = null, item = null }: ArchiveReplacedInput
  ) {
    if (!archiving() || !Array.isArray(previous) || !Array.isArray(current)) return;
    const now = new Map(current.filter((item) => identOf(false, item) !== null).map((item) => [item.itemId, item]));
    for (const before of previous) {
      const after = identOf(false, before) !== null ? now.get(before.itemId) : undefined;
      if (!after || archiveRevision(itemKind, after) === archiveRevision(itemKind, before)) continue;
      queueArchiveEntry(
        guildId,
        archiveEntry(before, { itemKind, event: 'replaced', scope, uuid: newId }),
        privateUserId,
        item
      );
    }
  }

  /**
   * The ranked lists of a member file one write merged (interests, details, aliases): the
   * victims held, the texts changed in place archived.
   */
  function archiveProfileItems(
    guildId: string,
    userId: string,
    { item, file, previous, dropped, ops, privateUserId = null }: ArchiveProfileItemsInput
  ) {
    if (!archiving()) return;
    const id = String(userId);
    const scope = { user: id };
    for (const [field, itemKind, identity] of [
      ['interests', 'interest', 'topic'],
      ['details', 'detail', 'text'],
      ['aliases', 'alias', 'name'],
    ]) {
      if (!isRecord(ops?.[field])) continue;
      const kept = Array.isArray(item.value[field]) ? item.value[field] : [];
      const removing = removeKeysOf(ops[field].remove);
      archiveReplaced(guildId, { previous: previous[field], current: kept, itemKind, scope, privateUserId, item });
      holdVictims(guildId, {
        item,
        file,
        path: [field],
        previous: previous[field],
        victims: dropped[field],
        itemKind,
        scope,
        privateUserId,
        userId: id,
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
  function storeClosed(
    guildId: string,
    userId: string,
    { item, file, target, closed, opts, privateUserId = null }: StoreClosedInput
  ) {
    const incoming = CLOSED_KINDS.flatMap((kind) =>
      (Array.isArray(closed?.[kind]) ? closed[kind] : []).map((value) => ({ kind, ...value }))
    );
    if (incoming.length === 0) return;
    const cap =
      isIntegerNumber(opts?.maxClosedStored) && opts.maxClosedStored >= 0
        ? opts.maxClosedStored
        : DEFAULT_MAX_CLOSED_STORED;
    const all = [...(Array.isArray(target.closed) ? target.closed : []), ...incoming];
    target.closed = all.slice(Math.max(0, all.length - cap));
    const evicted = all.slice(0, all.length - target.closed.length);
    item.dirty = true;
    const id = String(userId);
    for (const kind of CLOSED_KINDS) {
      const victims = evicted.filter((value) => value.kind === kind);
      if (victims.length === 0) continue;
      holdVictims(guildId, {
        item,
        file,
        path: ['closed'],
        previous: all,
        victims,
        itemKind: kind,
        scope: { user: id },
        privateUserId,
        userId: id,
        eventOf: () => 'replaced',
      });
    }
  }

  /** Take the confirmed victims out of their lists (see "The archive" above); returns how many went. */
  function trimArchived(guildId: string) {
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
      const index = list ? list.findIndex((value: Untyped) => identOf(held.strings, value) === held.ident) : -1;
      // Gone already, or changed since it was held: a later write owns it now.
      if (index === -1 || archiveRevision(held.itemKind, list[index]) !== held.revisionId) continue;
      if (where) where.holder[where.key] = list.filter((_: Untyped, i: number) => i !== index);
      item.dirty = true;
      trimmed += 1;
    }
    state.held = keep;
    if (trimmed > 0) log.info('store: archive trimmed', { guildId: String(guildId), trimmed });
    return trimmed;
  }

  /** Where an archived item goes back to (`restoreArchived`): its cache entry (null without the file) and list; null for a kind that cannot. */
  function restoreTarget(guildId: string, archived: Untyped) {
    const userId = typeof archived?.scope?.user === 'string' ? archived.scope.user : null;
    const isPrivate = archived?.scope?.private === true;
    const member = (keys: Untyped) => {
      if (!userId) return null;
      if (isPrivate) return { item: hasPrivate(guildId, userId) ? privateEntry(guildId, userId) : null, path: keys };
      return { item: store.getUser(guildId, userId) ? entries.get(userFile(guildId, userId)) : null, path: keys };
    };
    const guild = (keys: Untyped, strings = false) => {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      return { item, path: keys, strings };
    };
    switch (archived?.itemKind) {
      case 'episode':
        return member(['episodes']);
      case 'interest':
        return member(['interests']);
      case 'detail':
        return member(['details']);
      case 'alias':
        return isPrivate ? null : member(['aliases']);
      case 'lesson':
        return guild(['learned']);
      case 'selfFact':
        return guild(['self'], true);
      case 'injoke':
        return guild(['injokes'], true);
      case 'diary':
        return { item: diaryEntry(guildId), path: ['posts'] };
      default:
        return null;
    }
  }

  /**
   * A `felt` line (src/memory/record.ts#feltLine) for each of `episodes` that holds a feeling,
   * appended to the record of `guildId` (the member's private record for the private layer).
   * Not awaited: the store's writers stay synchronous; a refused append is logged.
   */
  function recordFelt(guildId: string, userId: string, layer: Untyped, episodes: Untyped) {
    if (!record || !recordOn()) return;
    const lines = episodes
      .filter((ep: Untyped) => isRecord(ep) && typeof ep.feeling === 'string' && ep.feeling)
      .map((ep: Untyped) =>
        feltLine(
          {
            userId: String(userId),
            itemId: ep.itemId ?? null,
            text: ep.feeling,
            date: ep.date ?? null,
            sourceMessageIds: Array.isArray(ep.sourceMessageIds) ? ep.sourceMessageIds : [],
          },
          { uuid: newId }
        )
      );
    if (lines.length === 0) return;
    const failed = (error: Untyped) =>
      log.warn('store: record failed', {
        kind: 'felt',
        guildId: String(guildId),
        lines: lines.length,
        code: error?.code ?? null,
      });
    try {
      Promise.resolve(
        record.append(guildId, lines, layer === 'private' ? { privateUserId: String(userId) } : {})
      ).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  function entry(file: string, fallback: () => Untyped): CacheItem {
    let item = entries.get(file);
    // A profile an attitude move made stale (`noteAffinityMoves`) is read again once its own write has landed.
    if (item?.stale && !item.dirty && !outbox?.holds(root.relative(file))) {
      entries.delete(file);
      item = undefined;
    }
    if (!item) {
      const place = dbPlace(file);
      let value: Untyped;
      if (!place.file) {
        // A memory unit: the database's value; a unit it does not hold is new (and so is every unit without a database).
        const found: Untyped = memoryDb ? seam.run(() => unitValue(seam.db(), place.rel)) : { found: false };
        value = found.found ? found.value : fallback();
      } else {
        value = readJson(file, fallback());
      }
      item = { value, dirty: false };
      entries.set(file, item);
    }
    return item;
  }

  /**
   * Where a cache entry lands: `{ rel, file, send }`. An operational file (`operationalJsonPath`) or a path the mappers
   * do not map as a JSON memory unit is written as a file (`file`), media.json and participation.json also sent
   * (`send`, their memory rows); every other unit is a unit of the memory database, sent only.
   */
  function dbPlace(file: string) {
    const rel = root.relative(file);
    if (operationalJsonPath(rel))
      return { rel, file: true, send: /^guilds\/[^/]+\/(?:participation|media)\.json$/.test(rel) };
    const info: Untyped = classify(rel);
    if (!info || info.skipped || info.format !== 'json' || info.guildId === undefined)
      return { rel, file: true, send: false };
    return { rel, file: false, send: true };
  }

  /** Whether a file has a value, cached or stored (a memory unit's `files` row in the database, an operational file on disk). */
  function known(file: string) {
    if (entries.has(file)) return true;
    const place = dbPlace(file);
    if (!place.file) {
      if (!memoryDb) return false;
      const db: Untyped = seam.db();
      return seam.run(
        () => db.prepare('SELECT 1 AS ok FROM files WHERE path = ? AND gone_at IS NULL').get(place.rel) !== undefined
      );
    }
    return fs.existsSync(file);
  }

  /** Every id of the memory units under `dir`, stored in the database or only cached (no side effects on the cache). */
  function idsUnder(dir: string) {
    const ids = new Set<string>();
    if (memoryDb) {
      const db = seam.db();
      for (const id of seam.run(() => idsUnderDir(db, root.relative(dir))) ?? []) ids.add(id);
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
   */
  function flushEntry(file: string, item: CacheItem, { force = false } = {}): 'clean' | 'held' | 'written' | 'failed' {
    if (!item.dirty) return 'clean';
    if (!force && (item.holdFlush ?? 0) > 0) return 'held';
    const place = dbPlace(file);
    // A memory unit goes to the database (the outbox), never to a file.
    if (!place.file) {
      sendUnit(place.rel, item);
      return 'written';
    }
    try {
      writeJsonAtomic(file, item.value);
      item.dirty = false;
      if (place.send) sendUnit(place.rel, item);
      return 'written';
    } catch (err) {
      log.error('store: flush failed', { file, error: err });
      return 'failed';
    }
  }

  /**
   * The entry's whole value handed to the outbox (a JSON copy), which keeps it until the write resolved and sends it
   * again after a failure. Without a database (tests) the entry is clean at once: nothing is persisted. With one that
   * has no writer the entry stays dirty.
   */
  function sendUnit(rel: string, item: CacheItem) {
    if (!memoryDb) {
      item.dirty = false;
      return;
    }
    if (!outbox) {
      log.warn('store: unit write failed', { code: 'DB_CLOSED' });
      return;
    }
    outbox.value(rel, JSON.parse(JSON.stringify(item.value)));
    item.dirty = false;
  }

  /** Flush every dirty cache entry (`flushEntry`); returns how many were written, failed and held. */
  function flushAll({ force = false } = {}) {
    const counts = { written: 0, failed: 0, held: 0 };
    for (const [file, item] of entries) {
      const outcome = flushEntry(file, item, { force });
      if (outcome !== 'clean') counts[outcome] += 1;
    }
    // What the flush handed over, and what failed before, goes to the database now (not awaited).
    if (outbox && outbox.size() > 0) outbox.push();
    return counts;
  }

  const guildDir = root.guildDir;
  const usersDir = (guildId: string) => path.join(guildDir(guildId), 'users');
  const userFile = (guildId: string, userId: string) => path.join(usersDir(guildId), `${userId}.json`);
  const guildFile = (guildId: string) => path.join(guildDir(guildId), 'guild.json');
  const channelsDir = (guildId: string) => path.join(guildDir(guildId), 'channels');
  const channelFile = (guildId: string, channelId: string) => path.join(channelsDir(guildId), `${channelId}.json`);
  const mediaCacheFile = (guildId: string) => path.join(guildDir(guildId), 'media.json');
  const loreFile = (guildId: string) => path.join(guildDir(guildId), 'lore.json');
  const gifsFile = (guildId: string) => path.join(guildDir(guildId), 'gifs.json');
  const privateDir = (guildId: string) => root.privateDir(guildId);
  const privateFile = (guildId: string, userId: string) => path.join(privateDir(guildId), `${userId}.json`);
  const recentFile = (guildId: string) => path.join(guildDir(guildId), 'recent.json');
  const participationFile = (guildId: string) => path.join(guildDir(guildId), 'participation.json');
  const diaryFile = (guildId: string) => path.join(guildDir(guildId), 'diary.json');
  const recallTraceFile = (guildId: string) => path.join(guildDir(guildId), 'recall-trace.jsonl');
  const versionsDir = (guildId: string) => path.join(guildDir(guildId), 'versions');
  /** A lore id is the entry's title, turned into a safe file name (src/memory/lore.ts#loreVersionKey). */
  const versionsFile = (guildId: string, kind: string, id: string) =>
    path.join(versionsDir(guildId), kind, `${kind === 'lore' ? loreVersionKey(id) : String(id)}.json`);
  const stateFile = root.stateFile;

  const stateEntry = entry(stateFile, () => ({}));

  /** The cache entry of a member's private file, created empty when missing, normalised. A file
   * that parses to something other than an object (null, an array, a string -- a hand edit gone
   * wrong) is replaced by the empty shape in the cache, so the private pass never stalls on it;
   * the disk copy is only rewritten by the next change, like any other entry. */
  function privateEntry(guildId: string, userId: string) {
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
  function channelEntry(guildId: string, channelId: string) {
    const item = entry(channelFile(guildId, channelId), () => emptyChannel(String(channelId)));
    normalizeChannel(item.value);
    return item;
  }

  /** The cache entry of one version file, `{}` when missing; a file that is not an object (a
   * hand edit gone wrong) reads as `{}` in the cache. Never marked dirty by reading. */
  function versionsEntry(guildId: string, kind: string, id: string) {
    const item = entry(versionsFile(guildId, kind, id), () => ({}));
    if (!isRecord(item.value)) item.value = {};
    return item;
  }

  /**
   * Keep the previous text of one prose field before a writer replaces it:
   * appended to data/guilds/<guildId>/versions/<kind>/<id>.json under `field` as
   * `{ at, by, chars, before, after, kept, removed, added, text }` -- `text` the
   * replaced text, `chars` its length in code points, the counts from
   * src/memory/prose.ts#sentenceDiff(previous, next), `at` the ISO time of
   * `opts.now` (else the wall clock), `by` = `opts.by` (else `'unknown'`). Newest last;
   * past `opts.versions.kept` per field the oldest go. Nothing is recorded when the
   * previous text is blank, when it equals the next, or when `opts.versions.enabled`
   * is false. `opts.versions` omitted -> `DEFAULT_VERSIONS` (config.json's values).
   * @returns Every entry of the field's list gets an `itemId` when it has
   *   none (`vs-`); `dropped`: the entries that fell past `kept`, oldest first, with theirs.
   */
  function recordVersion(
    guildId: string,
    kind: 'users' | 'channels' | 'guild' | 'lore',
    id: string,
    field: string,
    previous: unknown,
    next: unknown,
    opts: { by?: string; now?: number; versions?: { enabled?: boolean; kept?: number } } = {}
  ): { dropped: Array<Untyped> } {
    const settings = opts.versions ?? DEFAULT_VERSIONS;
    if (settings.enabled === false) return { dropped: [] };
    if (typeof previous !== 'string' || !previous.trim() || typeof next !== 'string' || previous === next)
      return { dropped: [] };
    const kept = isFiniteNumber(settings.kept) ? Math.max(0, Math.floor(settings.kept)) : DEFAULT_VERSIONS.kept;
    if (kept === 0) return { dropped: [] };
    const item = versionsEntry(guildId, kind, id);
    const diff = sentenceDiff(previous, next);
    const by = typeof opts.by === 'string' && opts.by.trim() ? opts.by.trim() : 'unknown';
    const at = new Date(isFiniteNumber(opts.now) ? opts.now : Date.now()).toISOString();
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
   * Merge `incoming` episodes into a member file's list (src/memory/episodes.ts#mergeEpisodes) and
   * write it when one was added, every stored episode with an `itemId` (`withItemIds`).
   * @param item  A profile or private layer's cache entry.
   * @param [owner]  Whose episodes: the
   *   feelings of the newly stored ones go to the record (recordFelt).
   * @returns `dropped`: the evicted episodes, each with an itemId.
   */
  function mergeEpisodesInto(
    item: CacheItem,
    incoming: unknown,
    opts: Untyped,
    owner: { guildId: string; userId: string; layer?: 'private' } | null = null
  ): { added: number; dropped: Array<Untyped> } {
    const previous = Array.isArray(item.value.episodes) ? item.value.episodes : [];
    const before = new Set(previous);
    const { episodes, added, dropped } = mergeEpisodes(item.value.episodes, incoming, opts);
    const victims = withItemIds(dropped, ITEM_ID_PREFIX.episode, newId);
    if (added > 0) {
      const stamped = withItemIds(episodes, ITEM_ID_PREFIX.episode, newId);
      item.value.episodes = stamped;
      item.dirty = true;
      if (owner)
        recordFelt(
          owner.guildId,
          owner.userId,
          owner.layer,
          stamped.filter((_, i) => !before.has(episodes[i]))
        );
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
   * src/memory/affinity.ts#applyDelta, with an `itemId` on every history move of a new affinity
   * and on its non-enumerable `droppedMoves`; an unchanged affinity comes back as it is.
   */
  function applyDeltaWithIds(affinity: Untyped, delta: Untyped, reason: string, opts: Untyped) {
    const next: Untyped = applyDelta(affinity, delta, reason, opts);
    if (!Array.isArray(next.droppedMoves)) return next;
    const stamped = { ...next, history: withItemIds(next.history, ITEM_ID_PREFIX.move, newId) };
    return attachDropped(stamped, 'droppedMoves', withItemIds(next.droppedMoves, ITEM_ID_PREFIX.move, newId));
  }

  /** The attitude moves an affinity write let go past the history size, held for the archive (`holdVictims`). */
  function holdMoves(
    guildId: string,
    userId: string,
    item: Untyped,
    file: string,
    current: Untyped,
    next: Untyped,
    isPrivate = false
  ) {
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
  function hasChannel(guildId: string, channelId: string) {
    const file = channelFile(guildId, channelId);
    return known(file);
  }

  /** The cache entry of a guild's GIF library, created empty when missing, normalised in place of
   * the cached value (src/memory/gifs.ts#normalizeGifs); never marked dirty by reading. */
  function gifsEntry(guildId: string) {
    const item = entry(gifsFile(guildId), emptyGifs);
    item.value = normalizeGifs(item.value);
    return item;
  }

  /** Whether a member has a private file, cached or on disk (no side effects on the cache). */
  function hasPrivate(guildId: string, userId: string) {
    const file = privateFile(guildId, userId);
    return known(file);
  }

  /** The cache entry of a guild's recent store, the empty store when there is no file, normalised
   * in place of the cached value (src/memory/recent.ts#normalizeRecent); never marked dirty by
   * reading, so a healed hand edit is written only by the next change. On the read that loads the
   * file, lines normalising leaves out (a hand edit, a file from another version) are logged as a
   * count, `store: recent lines dropped`, and a value that is not a store (not an object, or
   * `lines` not a list) as `store: recent store replaced`: the next write makes the loss
   * permanent. An unparsable file reads as empty with `readJson`'s warning. */
  function recentEntry(guildId: string) {
    const file = recentFile(guildId);
    const loading = !entries.has(file);
    const item = entry(file, emptyRecent);
    const raw = item.value;
    item.value = normalizeRecent(raw);
    if (loading && (!isRecord(raw) || !Array.isArray(raw.lines))) {
      log.warn('store: recent store replaced', { guildId, reason: 'malformed' });
    } else if (loading && raw.lines.length > item.value.lines.length) {
      log.warn('store: recent lines dropped', { guildId, dropped: raw.lines.length - item.value.lines.length });
    }
    return item;
  }

  /** The cache entry of a guild's participation store, the empty store when there is no file,
   * normalised in place of the cached value (src/memory/participation.ts#normalizeParticipation);
   * never marked dirty by reading. On the read that loads the file, episodes normalising leaves out
   * are logged as a count, `store: participation episodes dropped`, and a value that is not a store
   * (not an object, or `episodes` not a list) as `store: participation store replaced`. An
   * unparsable file reads as empty with `readJson`'s warning. */
  function participationEntry(guildId: string) {
    const file = participationFile(guildId);
    const loading = !entries.has(file);
    const item = entry(file, emptyParticipation);
    const raw = item.value;
    item.value = normalizeParticipation(raw);
    if (loading && (!isRecord(raw) || !Array.isArray(raw.episodes))) {
      log.warn('store: participation store replaced', { guildId, reason: 'malformed' });
    } else if (loading && raw.episodes.length > item.value.episodes.length) {
      log.warn('store: participation episodes dropped', {
        guildId,
        dropped: raw.episodes.length - item.value.episodes.length,
      });
    }
    return item;
  }

  /** The cache entry of a guild's diary, the empty diary when there is no file; a value that is not
   * a diary (not an object, or `posts` not a list) is replaced by the empty one in the cache, and
   * the disk copy is only rewritten by the next change. */
  function diaryEntry(guildId: string) {
    const item = entry(diaryFile(guildId), emptyDiary);
    if (!isRecord(item.value) || !Array.isArray(item.value.posts)) item.value = emptyDiary();
    return item;
  }

  /** Store `posts` (the newest `max`) as the guild's diary, stamped `now`, and mark it dirty. Every
   * post gets an `itemId` when it has none (`dy-`); returns `{ dropped }`, the posts that fell past
   * `max`, oldest first, with theirs. */
  function writeDiary(guildId: string, posts: Untyped, { max, now }: { max?: number; now?: number } = {}) {
    const item = diaryEntry(guildId);
    const previous = item.value.posts;
    const limit = isFiniteNumber(max) && max > 0 ? Math.floor(max) : DIARY_HISTORY_POSTS;
    const all = withItemIds(posts, ITEM_ID_PREFIX.diary, newId);
    const kept = all.slice(-limit);
    item.value = { posts: kept, updatedAt: isFiniteNumber(now) ? now : Date.now() };
    item.dirty = true;
    const dropped = all.slice(0, all.length - kept.length);
    holdVictims(guildId, {
      item,
      file: diaryFile(guildId),
      path: ['posts'],
      previous,
      victims: dropped,
      itemKind: 'diary',
      eventOf: () => 'evicted',
      scope: { guild: true },
    });
    return { dropped };
  }

  const store = {
    state: {
      get data(): StoredRecord {
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
    getUser(guildId: string, userId: string): StoredRecord | null {
      const file = userFile(guildId, userId);
      if (!known(file)) return null;
      const item = entry(file, () => emptyProfile(String(userId)));
      normalizeProfile(item.value);
      return item.value;
    },

    /**
     * Record that a member spoke: names, counters, timestamps. Creates the
     * profile. Messages do not always arrive in chronological order (older
     * history can be fed after the live pipeline already touched a profile
     * today) -- `firstSeen`/`lastSeen` are therefore
     * min/max'd against `at`, never just overwritten, so a late/backdated
     * touch can only widen the known range, never regress `lastSeen` to an
     * older message. `names`' order is meant to read "most recent display
     * name first": a name is moved to the front only when `at` is at least as
     * new as the CURRENT `lastSeen` (before this touch updates it) -- an
     * older/backdated touch never displaces the current name from index 0; an
     * unseen name from such a touch is appended at the end instead.
     */
    touchUser(guildId: string, userId: string, name: string, at = Date.now()): StoredRecord {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const profile = item.value;

      const priorFirstSeenMs = profile.firstSeen ? Date.parse(profile.firstSeen) : NaN;
      const priorLastSeenMs = profile.lastSeen ? Date.parse(profile.lastSeen) : NaN;
      const isNewest = !isFiniteNumber(priorLastSeenMs) || at >= priorLastSeenMs;

      if (name) {
        if (isNewest) {
          profile.names = [name, ...profile.names.filter((n: string) => n !== name)].slice(0, 5);
        } else if (!profile.names.includes(name)) {
          profile.names = [...profile.names, name].slice(0, 5);
        }
      }

      if (!isFiniteNumber(priorFirstSeenMs) || at < priorFirstSeenMs) {
        profile.firstSeen = new Date(at).toISOString();
      }
      if (!isFiniteNumber(priorLastSeenMs) || at > priorLastSeenMs) {
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
     * only ever changes through `addEpisodes` (src/memory/episodes.ts), which
     * appends and evicts instead of overwriting. `interests`/`details`
     * likewise only ever change through `applyProfileOps` below, which merges
     * incrementally instead of overwriting wholesale. A changed `character`/`style`/
     * `relationship` keeps its previous text (`recordVersion`; `opts.by`, `opts.versions`), and
     * loses its links first (`withoutLinks`: one that was only links is not written).
     */
    updateUser(
      guildId: string,
      userId: string,
      fields: Untyped,
      opts: { by?: string; versions?: { enabled?: boolean; kept?: number } } = {}
    ): StoredRecord {
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
     * remove }`) merges via src/memory/interests.ts#applyInterestOps;
     * `ops.details` (`{ add, seen, remove }`) merges via
     * src/memory/details.ts#applyDetailOps, which also advances the
     * profile's own `detailsSeq` id counter. `opts.seenAt` is the time of the
     * PERSON'S message that produced this sighting (falls back to `opts.now`,
     * then the wall clock) -- see the two modules' header comments for the
     * confirmation/date rules `opts.confirmGapHours` feeds. Stored JSON is
     * normalised first (see `normalizeProfile`). Tolerates garbage `ops`, never throws.
     *   `realName`: see `applyRealName` -- set when none is stored, a sighting when equal, a
     *   replacement only through `supersedes`, the replaced one going to the `closed` list (kind
     *   `realName`).
     *   `by`/`versions`: a replaced `character`/`style`/`relationship` keeps its previous text
     *   (`recordVersion`).
     *   `relationshipScore`: stamped as `profile.relationshipScore` whenever a `relationship` text
     *   is written (falls back to the stored score), and `profile.relationshipWrittenAt` = the ISO
     *   time of `opts.now` (else the wall clock) next to it -- the score and the moment the text
     *   was written, see src/memory/affinity.ts#relationshipStaleOf (`relationshipStale`).
     *   `relationshipChars`: the relationship text's limit (`relationships.textChars`); omitted ->
     *   `fieldChars`.
     *   `maxInterestsStored`/`maxDetailsStored`/`interestHalfLifeDays`/`detailHalfLifeDays` drive the
     *   storage-cap-vs-shown-cap split and the rank decay -- see
     *   docs/prompt-contract.md, "More is stored than shown, and rank decays with age".
     *   `clampTolerance` (see src/memory/clamp.ts) governs how far prose text may run over
     *   `fieldChars`/`noteChars`/etc. before it is cut, at a clean boundary, never mid-token.
     * @returns The updated profile.
     */
    applyProfileOps(
      guildId: string,
      userId: string,
      ops: ProfileOpsOptions,
      opts: {
        fieldChars?: number;
        maxInterests?: number;
        maxInterestsStored?: number;
        topicChars?: number;
        noteChars?: number;
        interestHalfLifeDays?: number;
        maxDetails?: number;
        maxDetailsStored?: number;
        detailHalfLifeDays?: number;
        maxAliases?: number;
        maxAliasesStored?: number;
        aliasHalfLifeDays?: number;
        confirmGapHours?: number;
        seenAt?: number;
        now?: number;
        clampTolerance?: number;
        relationshipScore?: number;
        relationshipChars?: number;
        by?: string;
        versions?: { enabled?: boolean; kept?: number };
      } = {}
    ): object {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const profile = item.value;
      normalizeProfile(profile);

      const seenAt = seenAtOf(opts);

      for (const key of ['character', 'style'] as const) {
        const value = typeof ops?.[key] === 'string' ? stripUrls(ops[key]) : undefined;
        if (typeof value === 'string' && value.trim()) {
          const next = firstWriteText(profile[key], value, opts.fieldChars, opts.clampTolerance);
          recordVersion(guildId, 'users', userId, key, profile[key], next, opts);
          profile[key] = next;
        }
      }
      writeRelationship(profile, ops?.relationship, opts, (previous, next) =>
        recordVersion(guildId, 'users', userId, 'relationship', previous, next, opts)
      );

      // What left the profile (removed, folded, evicted), each with its itemId: the archive's input.
      const previous: Record<string, Untyped> = {
        interests: profile.interests,
        details: profile.details,
        aliases: profile.aliases,
      };
      const dropped: ItemDrops & { aliases: Array<Untyped> } = {
        ...applyItemOps(profile, ops, opts, seenAt, newId),
        aliases: [],
      };

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
        const real = applyRealName(profile.realName, ops.realName, {
          seenAt,
          now: opts.now,
          mintId: () => `${ITEM_ID_PREFIX.realName}${newId()}`,
        });
        if (real) {
          profile.realName = real.realName;
          dropped.closed.realName = real.closed;
        }
      }
      archiveProfileItems(guildId, userId, { item, file: userFile(guildId, userId), previous, dropped, ops });
      storeClosed(guildId, userId, {
        item,
        file: userFile(guildId, userId),
        target: profile,
        closed: dropped.closed,
        opts,
      });

      profile.updatedAt = new Date(opts.now ?? Date.now()).toISOString();
      item.dirty = true;
      return profile;
    },

    /**
     * Fold one batch's uses of a member's names into the profile's `addressedAs`
     * (src/memory/addressed.ts#applyAddressUses): a counter like `messageCount`, so `updatedAt`
     * is left alone. Only an existing profile is written, never a new one; no uses -> nothing.
     * @param [opts]  `halfLifeDays`:
     *   `memory.addressHalfLifeDays`.
     * @returns The profile, or null when there is none.
     */
    recordAddressUses(
      guildId: string,
      userId: string,
      uses: Array<{ name: string; at: number }>,
      opts: { halfLifeDays?: number; max?: number; now?: number } = {}
    ): object | null {
      const profile = store.getUser(guildId, userId);
      if (!profile) return null;
      if (!Array.isArray(uses) || uses.length === 0) return profile;
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      profile.addressedAs = applyAddressUses(profile.addressedAs, uses, opts);
      item.dirty = true;
      return profile;
    },

    /**
     * Store a member's current avatar (src/memory/avatars.ts#normalizeAvatar: `{ hash, text,
     * describedAt }` or `{ hash: null, default: true }`), replacing the one stored: no history of
     * old avatars. Only into an existing profile, and never a profile's `updatedAt` (the portrait's
     * version stamp). Lives and goes with the profile.
     * @returns The profile, or null when nothing was written.
     */
    setAvatar(guildId: string, userId: string, avatar: Untyped): object | null {
      const file = userFile(guildId, userId);
      if (!known(file)) return null;
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
     * (src/memory/affinity.ts#relationshipStaleOf), and the flag stays until a relationship text is
     * written (`writeRelationship`). Only an existing profile with a non-empty text can carry it;
     * nothing else on the profile changes. Set by the owner from a one-off script.
     * @param [on=true]  false removes the flag.
     * @returns false when there is no profile or it has no relationship text.
     */
    markRelationshipRewrite(guildId: string, userId: string, on: boolean = true): boolean {
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
     * src/memory/episodes.ts#mergeEpisodes: validated, deduplicated against
     * what is already stored, then evicted back down to `opts.maxEpisodes`
     * (lowest weight, oldest first) if needed. Returns how many were added.
     */
    addEpisodes(guildId: string, userId: string, incoming: Untyped, opts: Untyped) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      return mergeEpisodesInto(item, incoming, opts, { guildId, userId }).added;
    },

    /** Fold one delta into a member's stored affinity (see src/memory/affinity.ts); `decayedAt` is
     * kept. Returns the stored affinity, with `applyDelta`'s non-enumerable `droppedMoves`. */
    adjustAffinity(
      guildId: string,
      userId: string,
      delta: Untyped,
      reason: string,
      opts: Untyped
    ): { score: number; reason: string; history: Array<object> } | null {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const current = item.value.affinity ?? emptyAffinity();
      const next = applyDeltaWithIds(current, delta, reason, opts);
      item.value.affinity = next;
      item.dirty = true;
      holdMoves(guildId, userId, item, userFile(guildId, userId), current, next);
      return next;
    },

    /**
     * `relationships.decayPerDay`: run src/memory/affinity.ts#decayAffinity over every member
     * profile of a guild AND every private layer under its `private/` directory. Only a file
     * whose affinity actually changed (score moved, or the `decayedAt` stamp was set or
     * advanced) is marked dirty; a profile without any stored affinity is left alone. Never
     * creates a file.
     * @param nowMs  Epoch milliseconds.
     * @param cfg  `config.relationships`, read by the caller at the moment of the sweep.
     * @returns `profiles`: files looked at (public +
     *   private); `decayed`: files whose score moved.
     */
    decayAffinities(
      guildId: string,
      nowMs: number,
      cfg: { decayPerDay?: number; decayPower?: number }
    ): { profiles: number; decayed: number } {
      const counts = { profiles: 0, decayed: 0 };
      const sweep = (item: CacheItem) => {
        counts.profiles += 1;
        const current = item.value.affinity;
        if (!current || typeof current !== 'object' || Array.isArray(current)) return;
        const decayed: { affinity: StoredRecord } = decayAffinity(current, nowMs, cfg);
        const affinity = decayed.affinity;
        if (affinity === current) return;
        if (affinity.score !== current.score) counts.decayed += 1;
        item.value.affinity = affinity;
        item.dirty = true;
      };
      for (const userId of idsUnder(usersDir(guildId))) {
        if (!store.getUser(guildId, userId)) continue;
        // `getUser` just loaded the profile into the cache.
        sweep(entries.get(userFile(guildId, userId)) as CacheItem);
      }
      for (const userId of idsUnder(privateDir(guildId))) sweep(privateEntry(guildId, userId));
      return counts;
    },

    // ---- the private layer: what one member said to the persona in direct messages ----

    /**
     * A member's private layer (data/guilds/<id>/private/<userId>.json), or
     * null when there is none. Normalised on read (see `normalizePrivate`),
     * persisted the next time anything writes the file.
     */
    getPrivate(guildId: string, userId: string): object | null {
      if (!hasPrivate(guildId, userId)) return null;
      return privateEntry(guildId, userId).value;
    },

    /**
     * Apply one private analyzer batch to a member's private layer: the same
     * `relationship`/`interests`/`details` op shapes and `opts` as
     * `applyProfileOps` (an absent or empty `relationship` never blanks the
     * stored one). `character`, `style`, `aliases` and `portrait` are public
     * only and ignored here. Creates the file. Tolerates garbage `ops`, never throws.
     * @param [opts]  As for `applyProfileOps` (a first text clamped to `relationshipChars`,
     *   else `fieldChars`, and stamped `relationshipScore` and `relationshipWrittenAt` in this
     *   layer); `relationshipScore` falls back to this layer's own score (the analyzer passes the
     *   effective one it showed the model).
     * @returns The updated private layer.
     */
    applyPrivateOps(guildId: string, userId: string, ops: PrivateOpsOptions, opts: StoredRecord = {}): object {
      const item = privateEntry(guildId, userId);
      const priv = item.value;

      const seenAt = seenAtOf(opts);

      writeRelationship(priv, ops?.relationship, opts);

      // What left the private layer, each with its itemId: the archive's input.
      const previous = { interests: priv.interests, details: priv.details };
      const dropped = applyItemOps(priv, ops, opts, seenAt, newId);
      archiveProfileItems(guildId, userId, {
        item,
        file: privateFile(guildId, userId),
        previous,
        dropped,
        ops: { interests: ops?.interests, details: ops?.details },
        privateUserId: String(userId),
      });
      storeClosed(guildId, userId, {
        item,
        file: privateFile(guildId, userId),
        target: priv,
        closed: dropped.closed,
        opts,
        privateUserId: String(userId),
      });

      item.dirty = true;
      return priv;
    },

    /**
     * Fold one delta into a member's PRIVATE affinity (see
     * src/memory/affinity.ts#applyDelta; same `opts` as `adjustAffinity`).
     * The public affinity is never touched. Creates the file.
     */
    adjustPrivateAffinity(
      guildId: string,
      userId: string,
      delta: number,
      reason: string,
      opts?: StoredRecord
    ): { score: number; reason: string; history: Array<object> } {
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
     * src/memory/episodes.ts#mergeEpisodes (same `opts` as `addEpisodes`).
     * Creates the file. Returns how many were added.
     */
    addPrivateEpisodes(guildId: string, userId: string, incoming: unknown, opts?: Untyped): number {
      const item = privateEntry(guildId, userId);
      return mergeEpisodesInto(item, incoming, opts, { guildId, userId, layer: 'private' }).added;
    },

    /**
     * Stamp a successful private update on a member's private layer:
     * `lastSeen` always, `firstSeen` only while it is empty (ISO strings,
     * like a public profile's). The public profile is never touched.
     * Creates the file.
     * @param nowMs  Epoch milliseconds.
     */
    touchPrivateSeen(guildId: string, userId: string, nowMs: number) {
      const item = privateEntry(guildId, userId);
      const iso = new Date(nowMs).toISOString();
      if (!item.value.firstSeen) item.value.firstSeen = iso;
      item.value.lastSeen = iso;
      item.dirty = true;
    },

    /**
     * Ids of every member with a private layer in a guild, cached or on disk.
     */
    listPrivate(guildId: string): Array<string> {
      return idsUnder(privateDir(guildId));
    },

    /** How many member profiles a guild has, cached or on disk (a profile not flushed yet included). */
    countUsers(guildId: string) {
      return idsUnder(usersDir(guildId)).length;
    },

    /**
     * Every member profile stored for a guild, cached or on disk -- the pool
     * a turn scans to pull a silent member into `<people>` by name/alias (see
     * src/behavior/prompt.js and docs/prompt-contract.md, "Aliases").
     * Same normalize-on-read guarantee as `getUser`.
     */
    listUserProfiles(guildId: string): Array<StoredRecord> {
      return idsUnder(usersDir(guildId))
        .map((id) => store.getUser(guildId, id))
        .filter((profile): profile is StoredRecord => profile !== null);
    },

    /**
     * The guild's memory (data/guilds/<id>/guild.json), the empty default
     * when nothing is stored. `learned` is normalised on read (see
     * `normalizeGuild` above) -- persisted the next time anything writes the
     * guild, never wiped implicitly.
     */
    getGuild(guildId: string): StoredRecord {
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
     * through `setEmojiBackfill`, `pingsOff` only through `setPingsOff`. `notesUpdatedAt` gets the
     * same stamp when one of the server notes (`patterns`, `starters`,
     * `injokes`) really changes; `self` alone never moves it, and neither does
     * `applyLearnedOps`, so it tells how old the notes are. A changed `patterns`/`starters` keeps its previous
     * text (`recordVersion`; `opts.by`, `opts.versions`). The return stays the stored guild, so what
     * a write of `injokes` or `self` takes out of the stored list (by
     * src/memory/interests.ts#normalizeTopic) is handed to `opts.onDropped` instead, as
     * `{ injokes, self }` lists of `{ itemId, text }` (`ij-`/`sf-`, minted here, see
     * `ITEM_ID_PREFIX`), called once per write. `patterns`, `starters` and every in-joke and self
     * fact lose their links first (`withoutLinks`): a text that was only links is not written.
     */
    updateGuild(guildId: string, fields: Untyped, opts: UpdateGuildOptions = {}): StoredRecord {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      const { learned, learnedNextId, emojiUsage, emojiBackfill, pingsOff, notesUpdatedAt, notesCheckedAt, ...given } =
        fields ?? {};
      const safeFields = withoutLinks(given, GUILD_TEXT);
      if (!changesStored(item.value, safeFields)) return item.value;
      const notes = Object.fromEntries(Object.entries(safeFields).filter(([key]) => NOTES_FIELDS.includes(key)));
      const stamp = new Date().toISOString();
      const stamps = changesStored(item.value, notes)
        ? { updatedAt: stamp, notesUpdatedAt: stamp }
        : { updatedAt: stamp };
      for (const key of GUILD_PROSE) {
        if (key in safeFields) recordVersion(guildId, 'guild', 'guild', key, item.value[key], safeFields[key], opts);
      }
      // The in-jokes (and a single-stage self list) are replaced whole: what the new list no longer
      // holds leaves the guild here.
      const dropped: { injokes: Array<Untyped>; self: Array<Untyped> } = {
        injokes:
          'injokes' in safeFields
            ? droppedStrings(item.value.injokes, safeFields.injokes, ITEM_ID_PREFIX.injoke, newId)
            : [],
        self:
          'self' in safeFields ? droppedStrings(item.value.self, safeFields.self, ITEM_ID_PREFIX.selfFact, newId) : [],
      };
      const previous: Record<string, Untyped> = { injokes: item.value.injokes, self: item.value.self };
      Object.assign(item.value, safeFields, stamps);
      opts.onDropped?.(dropped);
      item.dirty = true;
      // A list written whole replaces the stored one: what it no longer holds is held for the archive.
      for (const [field, itemKind] of [
        ['injokes', 'injoke'],
        ['self', 'selfFact'],
      ] as const) {
        if (!(field in safeFields)) continue;
        holdVictims(guildId, {
          item,
          file: guildFile(guildId),
          path: [field],
          strings: true,
          previous: previous[field],
          victims: dropped[field],
          itemKind,
          scope: { guild: true },
          eventOf: () => 'replaced',
        });
      }
      return item.value;
    },

    /**
     * Whether `userId` turned the persona's notifications off in this guild (`/nep pings off`).
     */
    isPingsOff(guildId: string, userId: string): boolean {
      const list = store.getGuild(guildId)?.pingsOff;
      return Array.isArray(list) && list.includes(String(userId));
    },

    /**
     * Turn the persona's notifications to `userId` off (`off` true) or back on, in the guild's
     * `pingsOff` list. A change is written at once (a member's own switch, allowed while paused,
     * when the next flush could otherwise land on a hand-edited file or be dropped with the
     * caches); no change writes nothing. Nothing else is touched, never `updatedAt`. Persists like
     * every guild field and is never reset implicitly.
     * @returns The state now: true when the member's pings are off.
     */
    setPingsOff(guildId: string, userId: string, off: boolean): boolean {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      if (!isRecord(item.value)) return false;
      const id = String(userId);
      const has = item.value.pingsOff.includes(id);
      if (off === true && !has) {
        item.value.pingsOff = [...item.value.pingsOff, id];
        item.dirty = true;
      } else if (off !== true && has) {
        item.value.pingsOff = item.value.pingsOff.filter((other: Untyped) => other !== id);
        item.dirty = true;
      }
      // Written at once: the guild unit goes to the database now, not at the next flush.
      flushEntry(guildFile(guildId), item);
      if (outbox) outbox.push();
      return item.value.pingsOff.includes(id);
    },

    /**
     * Stamp `notesFlaggedAt` (when the analyzer flagged the notes stale) on the listed channels
     * that exist and on the guild; dirty only when the value changes, nothing is created.
     * @param nowMs  Epoch milliseconds; not a finite number -> the wall clock.
     */
    markNotesFlagged(
      guildId: string,
      targets: { channels?: Array<string>; guild?: boolean },
      nowMs: number
    ): { channels: number; guild: boolean } {
      const at = new Date(isFiniteNumber(nowMs) ? nowMs : Date.now()).toISOString();
      const marked = { channels: 0, guild: false };
      const stamp = (item: Untyped) => {
        if (item.value.notesFlaggedAt === at) return;
        item.value.notesFlaggedAt = at;
        item.dirty = true;
      };

      const listed = Array.isArray(targets?.channels) ? targets.channels : [];
      const channelIds = new Set(listed.filter((id) => typeof id === 'string' || typeof id === 'number').map(String));
      for (const channelId of channelIds) {
        if (!channelId || !hasChannel(guildId, channelId)) continue;
        const item = channelEntry(guildId, channelId);
        if (!isRecord(item.value)) continue;
        stamp(item);
        marked.channels += 1;
      }

      if (targets?.guild === true) {
        const item = entry(guildFile(guildId), emptyGuild);
        normalizeGuild(item.value);
        if (isRecord(item.value)) {
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
     * @param target  `'guild'` or a channel id.
     * @param nowMs  Epoch milliseconds; not a finite number -> the wall clock.
     * @returns Whether something was written.
     */
    markNotesSampled(
      guildId: string,
      target: string,
      nowMs: number,
      { outcome }: { outcome: 'reviewed' | 'attempt' }
    ): boolean {
      if (outcome !== 'reviewed' && outcome !== 'attempt') return false;
      const at = new Date(isFiniteNumber(nowMs) ? nowMs : Date.now()).toISOString();
      let item;
      if (target === 'guild') {
        item = entry(guildFile(guildId), emptyGuild);
        normalizeGuild(item.value);
      } else {
        const channelId = typeof target === 'string' || typeof target === 'number' ? String(target) : '';
        if (!channelId || !hasChannel(guildId, channelId)) return false;
        item = channelEntry(guildId, channelId);
      }
      if (!isRecord(item.value)) return false;
      const patch =
        outcome === 'reviewed' ? { notesSampleReviewedAt: at, notesAttemptAt: null } : { notesAttemptAt: at };
      if (!changesStored(item.value, patch)) return false;
      Object.assign(item.value, patch);
      item.dirty = true;
      return true;
    },

    /**
     * Add the members' custom emoji uses of one consumed analyzer batch to
     * the guild's `emojiUsage` (src/memory/emoji-usage.ts#mergeEmojiUsage:
     * counts accumulate, the lowest-ranked entries past `opts.storeMax` are
     * evicted). Marks the guild dirty only when something was counted; never
     * stamps `updatedAt` (a counter, like `touchUser`).
     * @param messages  Slim buffered messages; `self`/`bot`/`ts`/`emojis` read.
     * @returns How many uses were counted.
     */
    recordEmojiUsage(
      guildId: string,
      messages: Array<StoredRecord>,
      opts: { storeMax?: number; halfLifeDays?: number } = {}
    ): number {
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
     * (src/memory/emoji-backfill.ts: its one first run, or the owner's
     * `/nep emoji rescan`), which recounts it from history right after.
     * Nothing else is touched; never stamps `updatedAt`.
     */
    clearEmojiUsage(guildId: string) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      item.value.emojiUsage = {};
      item.dirty = true;
    },

    /**
     * Stamp the guild's `emojiBackfill` (`{ at, channels, messages }`,
     * normalised like on read) after a history backfill. Never stamps `updatedAt`.
     * @returns The stored stamp.
     */
    setEmojiBackfill(
      guildId: string,
      stamp: { at: string; channels: number; messages: number }
    ): { at: string; channels: number; messages: number } | null {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      item.value.emojiBackfill = normalizeBackfillStamp(stamp);
      item.dirty = true;
      return item.value.emojiBackfill;
    },

    /**
     * Apply one batch of `learned` ops (`{ add, seen, remove }`, add items a
     * bare string or `{ text, from?, sure? }`) to the guild's list of things
     * people taught the persona, via src/memory/details.ts#applyDetailOps --
     * the same confirmation/ranking/eviction mechanics as a member's
     * details, with the guild's own `learnedNextId` id counter. Used by the
     * owner commands (src/tools/impl/learning.ts). The limits are the `config.memory` keys of the same name, so
     * a caller can pass `{ ...config.memory, seenAt }` as-is; `seenAt` falls
     * back to the wall clock. Garbage `ops` change nothing and never throw.
     * The guild is marked dirty (and `updatedAt` stamped) only when the list
     * or the counter actually changed.
     * @returns The guild's `learned` list after the ops (a written list gives every item
     *   an `itemId` when it has none, `ln-`), with the non-enumerable `dropped`: the lessons that
     *   left (removed, evicted), each with one; `[]` when the list did not change.
     */
    applyLearnedOps(
      guildId: string,
      ops: { add?: Array<unknown>; seen?: Array<unknown>; remove?: Array<unknown> },
      opts: LearnedOpsOptions = {}
    ): Array<object> {
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
        seenAt: isFiniteNumber(opts.seenAt) ? opts.seenAt : Date.now(),
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
        item,
        file: guildFile(guildId),
        path: ['learned'],
        previous,
        victims,
        itemKind: 'lesson',
        scope: { guild: true },
        eventOf: (victim) => rankedEvent(victim, 'text', removing, kept, false),
      });
      return attachDropped(guild.learned, 'dropped', victims);
    },

    /**
     * One channel's stored entry (the server map), or null when never seen.
     * Normalised on read (see `normalizeChannel` above: the writers tally and
     * the notes check stamp) -- persisted the next time anything writes the
     * entry, never wiped implicitly.
     */
    getChannel(guildId: string, channelId: string): ChannelEntry | null {
      if (!hasChannel(guildId, channelId)) return null;
      return channelEntry(guildId, channelId).value;
    },

    /** Every channel entry stored for a guild, cached or on disk; normalised on read like `getChannel`. */
    listChannels(guildId: string): Array<StoredRecord> {
      return idsUnder(channelsDir(guildId)).map((id) => channelEntry(guildId, id).value);
    },

    /**
     * Record one observed message in a channel: the platform's facts (name, category,
     * topic), counters and the per-day activity histogram. Creates the entry.
     * `authorId` (the message's author, omitted for the persona's own
     * messages and other bots -- see src/memory/update.ts#touchMemory) is
     * counted into the channel's `writers` tally (see `countWriter` above),
     * and `topWriters` is written again as the best five of it, best first;
     * `null` (the default) leaves both untouched. Never stamps `updatedAt`
     * (counters are not notes).
     * @param [ts]  The message's time, epoch milliseconds.
     * @param [opts]  The
     *   `config.memory` keys of the same name, so a caller can pass `config.memory` as-is, read
     *   at the moment of use: how many writers the tally keeps (20; never fewer than the five
     *   shown) and the half-life of a writer's rank in days (30; 0 or less = the count alone).
     * @returns The channel entry.
     */
    touchChannel(
      guildId: string,
      channelId: string,
      facts: { name?: string; category?: string | null; topic?: string | null },
      ts: number = Date.now(),
      authorId: string | null = null,
      opts: { channelWritersStored?: number; channelWritersHalfLifeDays?: number } = {}
    ): object {
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
     * Merge analyzer-extracted fields into a channel entry. Only `purpose`,
     * `topics`, `tone` travel through here — everything else (counters,
     * the platform's facts) is stripped, mirroring `updateUser`. Stamps `updatedAt`
     * only when one of them actually changes: an identical re-send is left
     * alone. Nothing else stamps a channel's `updatedAt`, so it is the notes'
     * own stamp. Each field loses its links first (`withoutLinks`:
     * one that was only links is not written). A changed field keeps its previous text
     * (`recordVersion`; `opts.by`, `opts.versions`).
     */
    updateChannel(
      guildId: string,
      channelId: string,
      fields: Untyped,
      opts: { by?: string; versions?: { enabled?: boolean; kept?: number } } = {}
    ): StoredRecord {
      const item = channelEntry(guildId, channelId);
      const given: Record<string, Untyped> = {};
      for (const key of CHANNEL_PROSE) {
        if (typeof fields?.[key] === 'string') given[key] = fields[key];
      }
      const patch = withoutLinks(given, CHANNEL_PROSE);
      if (!changesStored(item.value, patch)) return item.value;
      for (const [key, value] of Object.entries(patch))
        recordVersion(guildId, 'channels', channelId, key, item.value[key], value, opts);
      Object.assign(item.value, patch, { updatedAt: new Date().toISOString() });
      item.dirty = true;
      return item.value;
    },

    /**
     * The describer's cache for one guild (src/memory/describe.ts): a plain
     * object map keyed by attachment/embed id, insertion order doubling as
     * LRU recency order. Callers mutate the returned object directly (same
     * pattern as `state.data`) and call `markMediaCacheDirty` afterwards.
     */
    getMediaCache(guildId: string): StoredRecord {
      return entry(mediaCacheFile(guildId), () => ({})).value;
    },

    markMediaCacheDirty(guildId: string) {
      const item = entries.get(mediaCacheFile(guildId));
      if (item) item.dirty = true;
    },

    /**
     * The guild's GIF library (data/guilds/<id>/gifs.json, see
     * src/memory/gifs.ts): `{ nextId, entries, backfill }`, the empty library
     * when nothing is stored. Normalised on read, persisted the next time
     * anything writes it, never reset implicitly.
     */
    getGifs(guildId: string): { nextId: number; entries: Record<string, object>; backfill: object | null } {
      return gifsEntry(guildId).value;
    },

    /**
     * The library entry whose handle is `handle` (`g12`), as `{ key, ...entry }`,
     * or null (src/memory/gifs.ts#findGif). Creates nothing on disk.
     */
    findGif(guildId: string, handle: string): object | null {
      return findGif(gifsEntry(guildId).value, handle);
    },

    /**
     * Add the members' GIFs of `messages` to the guild's library
     * (src/memory/gifs.ts#mergeGifs: counts accumulate, new GIFs get the next
     * handle, the lowest-ranked entries past `opts.storeMax` are evicted).
     * Marks the file dirty only when something was counted.
     * @param messages  Normalized messages (URLs present); `self`/`bot`/`ts` read.
     * @returns How many uses were counted.
     */
    recordGifs(
      guildId: string,
      messages: Array<StoredRecord>,
      opts: { storeMax?: number; halfLifeDays?: number } = {}
    ): number {
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
     * (src/memory/gifs.ts#markOwnGif: `ownLast` = `ts`, `ownUses` + 1), after a
     * turn sent it. Marks the file dirty only when the entry exists.
     * @param key  The entry's library key (findGif's `key`).
     * @param ts   When it was posted (epoch ms).
     * @returns Whether an entry was stamped.
     */
    recordOwnGif(guildId: string, key: string, ts: number): boolean {
      const item = gifsEntry(guildId);
      const { gifs, marked } = markOwnGif(item.value, key, ts);
      if (marked) {
        item.value = gifs;
        item.dirty = true;
      }
      return marked;
    },

    /**
     * Set every GIF library entry's count to 0 (src/memory/gifs.ts#resetGifCounts)
     * -- only for the GIF history backfill (src/memory/gif-backfill.ts: its one
     * first run, or the owner's `/nep gifs rescan`), which recounts from
     * history right after. Entries, handles, `nextId` and the backfill stamp
     * are kept, so a recounted GIF keeps its handle.
     */
    resetGifCounts(guildId: string) {
      const item = gifsEntry(guildId);
      item.value = resetGifCounts(item.value);
      item.dirty = true;
    },

    /**
     * Stamp the guild's GIF library `backfill` (`{ at, channels, messages }`,
     * normalised like on read) after a history backfill.
     * @returns The stored stamp.
     */
    setGifBackfill(
      guildId: string,
      stamp: { at: string; channels: number; messages: number }
    ): { at: string; channels: number; messages: number } | null {
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
     * @param id  A member id, a channel id, `'guild'`, or a lore title.
     */
    listVersions(guildId: string, kind: 'users' | 'channels' | 'guild' | 'lore', id: string): object {
      if (!VERSION_KINDS.includes(kind)) return {};
      return structuredClone(versionsEntry(guildId, kind, id).value);
    },

    /** Every stored lorebook entry of a guild (data/guilds/<id>/lore.json). Never auto-created empty on disk. */
    getLore(guildId: string): Array<StoredRecord> {
      return entry(loreFile(guildId), () => []).value;
    },

    /**
     * Merge `incoming` entries into the guild's lorebook via
     * src/memory/lore.ts#upsertLore: an analyzer update never touches an
     * owner entry, an owner write always wins. Returns how many were
     * inserted or actually changed (an identical analyzer re-send is neither).
     * An entry whose text changed keeps its previous text (`recordVersion`, kind `lore`, id
     * the title; `opts.by`, `opts.versions`).
     */
    setLore(guildId: string, incoming: Untyped, opts: SetLoreOptions) {
      const item = entry(loreFile(guildId), () => []);
      const { entries: nextEntries, upserted, changes } = upsertLore(item.value, incoming, opts);
      if (upserted > 0) {
        for (const change of changes)
          recordVersion(guildId, 'lore', change.title, 'text', change.previousText, change.nextText, opts);
        item.value = nextEntries;
        item.dirty = true;
      }
      return upserted;
    },

    /** Delete one lorebook entry by id. Returns whether anything was removed. */
    removeLore(guildId: string, id: string) {
      const item = entry(loreFile(guildId), () => []);
      const before = item.value.length;
      item.value = item.value.filter((lore: Untyped) => lore.id !== id);
      const removed = item.value.length !== before;
      if (removed) item.dirty = true;
      return removed;
    },

    // ---- the diary: the persona's own posts in its diary channel (src/behavior/diary.ts) ----

    /**
     * A copy of the guild's diary (data/guilds/<id>/diary.json): `{ posts, updatedAt }`, posts newest last; the empty
     * diary (`{ posts: [], updatedAt: 0 }`) when there is no file, never null. Reading never creates the file.
     */
    getDiary(guildId: string): {
      posts: Array<{
        at: number;
        kind: string | null;
        gist: string;
        picture: string | boolean | null;
        pictures?: number;
        messageIds: Array<string>;
        search: string;
      }>;
      updatedAt: number;
    } {
      return structuredClone(diaryEntry(guildId).value);
    },

    /**
     * Append one post to the guild's diary, keep the newest `max` (diary.historyPosts), stamp `updatedAt` with `now`.
     * @param post  `pictures`: a set's count
     *   (`picture` its first scene); `text`: the entry in full; `itemId`: the entry's id.
     * @returns The posts that fell past `max` (see `writeDiary`).
     */
    appendDiaryPost(
      guildId: string,
      post: DiaryPostOptions,
      opts: { max?: number; now?: number } = {}
    ): { dropped: Array<object> } {
      const done = writeDiary(guildId, [...diaryEntry(guildId).value.posts, structuredClone(post)], opts);
      // The post goes to the database at once; a failed write waits in the outbox, past a shutdown in `memory-pending/`.
      flushEntry(diaryFile(guildId), diaryEntry(guildId));
      if (outbox) outbox.push();
      return done;
    },

    /**
     * Replace the guild's post list (the backfill, run only on an empty diary, posts oldest first), keeping the newest
     * `max` (diary.historyPosts), stamping `updatedAt` with `now`; returns the posts that fell past `max` (`writeDiary`).
     * @param guildId @param posts @param [opts]
     */
    setDiaryPosts(guildId: string, posts: Array<StoredRecord>, opts: { max?: number; now?: number } = {}) {
      return writeDiary(guildId, Array.isArray(posts) ? structuredClone(posts) : [], opts);
    },

    /** `read(db)` on the memory database's read connection, null without one (src/behavior/mirror.ts reads its mirrors).
     * @template T @param read */
    readMemory<TResult>(read: (db: Untyped) => TResult): TResult | null {
      return memoryDb ? seam.run(() => read(seam.db())) : null;
    },

    // ---- the recent store: short dated lines about the last days (src/memory/recent.ts) ----

    /**
     * A copy of the guild's recent store (data/guilds/<id>/recent.json): `{ nextId, lines }`, the
     * empty store when there is no file. Normalised on read (src/memory/recent.ts#normalizeRecent),
     * persisted only by the next change; reading never creates the file and never expires a line
     * (src/memory/recent.ts#liveRecent is the view by time). Changing the copy changes nothing
     * stored: a change goes through `applyRecentOps`.
     */
    getRecent(guildId: string): {
      nextId: number;
      lines: Array<{
        id: number;
        at: number;
        addedAt: string | null;
        channelId: string;
        text: string;
        who: Array<string>;
        weight: number;
      }>;
    } {
      return structuredClone(recentEntry(guildId).value);
    },

    /**
     * One write of the guild's recent store, synchronous: expiry, the removes by id, then the new
     * lines with dedupe and both caps (src/memory/recent.ts#mergeRecent, which documents every
     * option and count). Marked dirty only when a stored line was added, removed, expired or
     * evicted, so a call that changes nothing creates or rewrites no file. The settings are the
     * caller's, read at the moment of use (src/memory/recent.ts#recentSettings); a lowered `hours`
     * expires the older lines here, at the first write after the change.
     * @param incoming  `{ text, at, channelId, weight }` items, untrusted.
     *   `dropped` is the sum of the five reasons after it. A written store gives every line an
     *   `itemId` when it has none (`rc-`); the non-enumerable `droppedLines` holds the stored lines
     *   that left (expired, removed, evicted), each with one.
     */
    applyRecentOps(
      guildId: string,
      incoming: unknown,
      opts: RecentOpsOptions = {}
    ): {
      added: number;
      removed: number;
      expired: number;
      evicted: number;
      dropped: number;
      invalid: number;
      noChannel: number;
      stale: number;
      duplicate: number;
      overCap: number;
    } {
      const item = recentEntry(guildId);
      const previous = item.value.lines;
      const { value, droppedLines, ...counts } = mergeRecent(item.value, incoming, opts);
      const victims = withItemIds(droppedLines, ITEM_ID_PREFIX.recent, newId);
      if (counts.added + counts.removed + counts.expired + counts.evicted > 0) {
        item.value = { ...value, lines: withItemIds(value.lines, ITEM_ID_PREFIX.recent, newId) };
        item.dirty = true;
        // droppedLines: the expired, then the removed, then the evicted.
        holdVictims(guildId, {
          item,
          file: recentFile(guildId),
          path: ['lines'],
          previous,
          victims,
          itemKind: 'recent',
          scope: (line: Untyped) =>
            typeof line.channelId === 'string' && line.channelId ? { channel: line.channelId } : { guild: true },
          eventOf: (_, index) =>
            index < counts.expired ? 'expired' : index < counts.expired + counts.removed ? 'replaced' : 'evicted',
        });
      }
      return attachDropped(counts, 'droppedLines', victims);
    },

    // ---- the participation store: the persona's exchanges on the channels (src/memory/participation.ts) ----

    /**
     * A copy of the guild's participation store (data/guilds/<id>/participation.json):
     * `{ episodes, nextId }`, the empty store when there is no file. Normalised on read
     * (src/memory/participation.ts#normalizeParticipation), persisted only by the next change;
     * reading never creates the file and never expires an episode. Changing the copy changes
     * nothing stored: a change goes through `setParticipation`.
     */
    getParticipation(guildId: string): { episodes: Array<object>; nextId: number } {
      return structuredClone(participationEntry(guildId).value);
    },

    /**
     * Store `state` (the result of src/memory/participation.ts#recordOwnLine / #recordFollowing
     * on a `getParticipation` copy) as the guild's participation store, after expiry
     * (src/memory/participation.ts#expireEpisodes: past `hours`, then over `maxStored`), and mark
     * it dirty. The settings are the caller's, read at the moment of use
     * (src/memory/participation.ts#participationSettings); missing ones read as the defaults, a
     * missing `now` as the wall clock.
     * @returns Every stored episode gets an `itemId` when it has none
     *   (`pt-`); `dropped`: the episodes the expiry removed, each with one.
     */
    setParticipation(
      guildId: string,
      state: unknown,
      { settings, now }: { settings?: Untyped; now?: number } = {}
    ): { dropped: Array<object> } {
      const item = participationEntry(guildId);
      const previous = item.value.episodes;
      const at = isFiniteNumber(now) ? now : Date.now();
      const { state: next, dropped } = expireEpisodes(state, settings, at);
      item.value = structuredClone({
        ...next,
        episodes: withItemIds(next.episodes, ITEM_ID_PREFIX.participation, newId),
      });
      item.dirty = true;
      const victims = withItemIds(dropped, ITEM_ID_PREFIX.participation, newId);
      // As src/memory/participation.ts#expireEpisodes reads `hours`: past it an episode expired, else the cap took it.
      const hours =
        isFiniteNumber(settings?.hours) && settings.hours >= 0 ? settings.hours : PARTICIPATION_DEFAULTS.hours;
      holdVictims(guildId, {
        item,
        file: participationFile(guildId),
        path: ['episodes'],
        previous,
        victims,
        itemKind: 'participation',
        scope: (episode: Untyped) =>
          typeof episode.channelId === 'string' && episode.channelId ? { channel: episode.channelId } : { guild: true },
        eventOf: (episode) => (episode.lastOwnAt < at - hours * HOUR_MS ? 'expired' : 'evicted'),
      });
      return { dropped: victims };
    },

    /**
     * Append one recall run's record (src/behavior/recall-run.js, `features.recallTrace`)
     * as one JSON line to data/guilds/<guildId>/recall-trace.jsonl, written at once (not
     * through the cache). The file keeps the newest `maxLines` lines (a missing or unusable
     * value: 500): while there is room the line is appended, past the cap the file is
     * rewritten atomically without the oldest. Lines a hand edit left blank are dropped on
     * that rewrite. Throws on an I/O failure (the caller logs it).
     */
    appendRecallTrace(guildId: string, record: StoredRecord, { maxLines }: { maxLines?: number } = {}) {
      const cap = isFiniteNumber(maxLines) && maxLines >= 1 ? Math.floor(maxLines) : RECALL_TRACE_MAX_LINES;
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
     */
    flush(): { written: number; failed: number; held: number } {
      return flushAll();
    },

    /**
     * The flush before a shutdown or a pause: waits up to `holdMaxMs` (`archive.holdMaxMs`,
     * config.json's 5000 when missing) for the archive to take what holds files back, then writes
     * everything, held or not; files written while still held are logged as `store: flushed held`. It then
     * waits for the database to take what the flush handed over (unit-outbox.js#flush) and, with `final`
     * (the shutdown), keeps what still fails in `memory-pending/` (`pending` counts them; an error is logged).
     */
    async flushSettled({ holdMaxMs, final = false }: { holdMaxMs?: number; final?: boolean } = {}): Promise<{
      written: number;
      failed: number;
      held: number;
      waiting?: number;
      pending?: number;
    }> {
      const heldFiles = () => [...entries.values()].filter((item) => item.dirty && (item.holdFlush ?? 0) > 0).length;
      if (heldFiles() > 0) {
        const waitMs = isFiniteNumber(holdMaxMs) && holdMaxMs >= 0 ? holdMaxMs : DEFAULT_HOLD_MAX_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
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
      const counts: { written: number; failed: number; held: number; waiting?: Untyped; pending?: Untyped } = flushAll({
        force: true,
      });
      if (held > 0) log.warn('store: flushed held', { files: held });
      if (outbox) {
        counts.waiting = await outbox.flush();
        if (final) counts.pending = outbox.keep();
      }
      return counts;
    },

    // ---- the archive (see "The archive" at the top of createStore) ----

    /**
     * The guild's archive sequence now: take one before and one after a group of synchronous
     * writes and `settleArchive` reports on the entries those writes queued.
     */
    archiveMark(guildId: string): number {
      return archiveGuilds.get(String(guildId))?.seq ?? 0;
    },

    /**
     * Wait for the background appends of the entries queued after mark `from` up to mark `to`
     * (every one queued so far when omitted) and report them once: `archived` the confirmed ones,
     * `deferred` how many went to the archive's pending queue instead (their items stay hot until
     * the drain archives them). An entry reported here is not reported again.
     */
    async settleArchive(
      guildId: string,
      { from = 0, to = Infinity }: { from?: number; to?: number } = {}
    ): Promise<{
      archived: Array<{ itemId: string; revisionId: string; itemKind: string; event: string }>;
      deferred: number;
    }> {
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
        if (outcome.status === 'archived')
          archived.push({
            itemId: outcome.itemId,
            revisionId: outcome.revisionId,
            itemKind: outcome.itemKind,
            event: outcome.event,
          });
        else deferred += 1;
      }
      return { archived, deferred };
    },

    /**
     * Archive what waits: the entries neither archived nor queued as pending first, then the
     * archive's pending queue (src/memory/archive.ts#drainPending); every victim now confirmed
     * is trimmed from its list. Runs whether or not features.archive is on (what waits was
     * queued while it was). No archive -> nothing.
     */
    async drainArchive(guildId: string): Promise<{ archived: number; left: number }> {
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
     * @returns How many items went.
     */
    trimArchived(guildId: string): number {
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
     * @param entry  An archive entry (src/memory/archive.ts#archiveEntry).
     */
    restoreArchived(
      guildId: string,
      entry: StoredRecord
    ): { restored: boolean; reason?: 'hot' | 'no-profile' | 'kind'; item?: Untyped } {
      const target: Untyped = restoreTarget(guildId, entry);
      if (!target) return { restored: false, reason: 'kind' };
      if (!target.item) return { restored: false, reason: 'no-profile' };
      const where = listAt(target.item.value, target.path);
      if (!where) return { restored: false, reason: 'no-profile' };
      const list = Array.isArray(where.holder[where.key]) ? where.holder[where.key] : [];
      const strings = target.strings === true;
      // An entry archived before links were kept out of memory loses them on the way back.
      const text = isRecord(entry.text) ? withoutLinks(structuredClone(entry.text), Object.keys(entry.text)) : {};
      let value;
      if (strings) {
        value = typeof text.text === 'string' && text.text.trim() ? text.text : null;
        if (value === null) return { restored: false, reason: 'kind' };
      } else {
        value = {
          ...(isRecord(entry.stored) ? structuredClone(entry.stored) : {}),
          ...text,
          ...(isFiniteNumber(entry.weight) ? { weight: entry.weight } : {}),
          itemId: entry.itemId,
        };
      }
      const ident = strings ? identOf(true, value) : entry.itemId;
      if (list.some((item: Untyped) => identOf(strings, item) === ident)) return { restored: false, reason: 'hot' };
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
     * @returns how many cache entries were dropped
     */
    dropCaches(): number {
      let dropped = 0;
      for (const [file, item] of entries) {
        if (file === stateFile) continue;
        if (item.dirty) log.warn('store: dropping a cache entry with unflushed changes', { file });
      }
      for (const file of [...entries.keys()]) {
        if (file === stateFile) continue;
        // An entry whose write has not resolved stays, so no later read takes the older value.
        const place = dbPlace(file);
        if (outbox?.holds(place.rel)) continue;
        entries.delete(file);
        dropped += 1;
      }
      return dropped;
    },

    /**
     * Force `state.json` to be re-read from disk right now, discarding
     * whatever was cached (`/nep resume`): the owner may have
     * hand-edited it while paused. Any unflushed
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
     */
    validate(): Array<string> {
      return findInvalidJsonFiles(dataDir, { only: operationalJsonPath });
    },

    /**
     * Her memory session moved these people's attitude in the database (`[{ personId, applied }]`,
     * src/memory/db/service.ts#onAffinityMoves, any person id `person:<interface>:<id>`). A member's cached profile
     * holds the attitude as it was before the move, so it is dropped: a clean entry no write holds at once, any other
     * (changed since, or its write still under way) once its write has landed (`stale`, see `entry`). Its write keeps
     * the session's score and reason (src/memory/db/session-rows.ts#sessionHold), and the next read takes the
     * database's profile, the moves in its history.
     * @returns how many cached profiles were dropped or marked
     */
    noteAffinityMoves(moves: Array<{ personId: string; applied: number }>): number {
      if (!Array.isArray(moves)) return 0;
      let taken = 0;
      for (const move of moves) {
        const userId = /^person:[^:]+:(.+)$/.exec(String(move?.personId ?? ''))?.[1];
        if (!userId) continue;
        for (const [file, item] of [...entries]) {
          const parts = root.relative(file).split('/');
          if (parts.length !== 4 || parts[0] !== 'guilds' || parts[2] !== 'users' || parts[3] !== `${userId}.json`)
            continue;
          if (!item.dirty && !outbox?.holds(parts.join('/'))) entries.delete(file);
          else item.stale = true;
          taken += 1;
        }
      }
      return taken;
    },
  };

  // Her session's attitude moves reach the cached profiles (see noteAffinityMoves).
  if (typeof memoryDb?.onAffinityMoves === 'function')
    memoryDb.onAffinityMoves((moves: Untyped) => store.noteAffinityMoves(moves));

  return store;
}

/** The store as the memory modules use it: its stored objects readable field by field. */
export type StoreView = ReturnType<typeof buildStore>;

/** The store as `createStore` hands it out: the methods that answer with a stored object answer with a plain `object`. */
export type Store = Omit<
  StoreView,
  | 'getUser'
  | 'touchUser'
  | 'updateUser'
  | 'getGuild'
  | 'updateGuild'
  | 'listUserProfiles'
  | 'listChannels'
  | 'updateChannel'
  | 'getMediaCache'
  | 'getLore'
> & {
  getUser: (...args: Parameters<StoreView['getUser']>) => object | null;
  touchUser: (...args: Parameters<StoreView['touchUser']>) => object;
  updateUser: (...args: Parameters<StoreView['updateUser']>) => object;
  getGuild: (guildId: Untyped) => object;
  updateGuild: (...args: Parameters<StoreView['updateGuild']>) => object;
  listUserProfiles: (guildId: Untyped) => Array<object>;
  listChannels: (guildId: Untyped) => Array<object>;
  updateChannel: (...args: Parameters<StoreView['updateChannel']>) => object;
  getMediaCache: (guildId: Untyped) => object;
  getLore: (guildId: Untyped) => Array<object>;
};

/**
 * The store over one data directory.
 * @param options  `newId`: the source of the UUID in every new `itemId`
 *   (`ITEM_ID_PREFIX`); node:crypto's `randomUUID` unless a test injects one. `record`
 *   (src/memory/record.ts#createRecord, optional): while `recordOn()` (read at each write;
 *   src/index.js passes features.record exactly true) every feeling stored on an episode -- with
 *   the episode (`addEpisodes` / `addPrivateEpisodes`) -- is
 *   appended to it as a `felt` line, in the background (a refused append is logged, counts only).
 *   `archive` (src/memory/archive.ts#createArchive, optional): while `archiveOn()` (read at each
 *   write; src/index.js passes features.archive exactly true) nothing leaves a hot list on disk
 *   before its copy is in the archive -- see "The archive" inside, `settleArchive`,
 *   `drainArchive` and `trimArchived`.
 *   `memoryDb` (the memory database service): every memory unit of the cache (users, private layers, channels, the
 *   guild, lore, recent, versions, the diary) is loaded from it (`unitValue`; a unit it does not hold is new; a closed
 *   database throws, with a code), whether it exists is the database's `files` row (`known`), a directory's ids
 *   are the database's (`idsUnder`), and a flush hands its whole value to the outbox (src/memory/db/unit-outbox.ts,
 *   op `value`): the entry stays the truth and counts as written only when the outbox no longer holds it (the write
 *   resolved); a failed write waits there and goes again at the next flush. The operational files
 *   (`operationalJsonPath`: state, gifs, media, participation, ...) are read and written as files; `media.json` and
 *   `participation.json` also send their value. A diary post is sent at once (`appendDiaryPost` flushes the diary: its
 *   row and its mirror's `sent` publication). `flushSettled({ final: true })` (the shutdown) waits for the outbox and
 *   keeps what still fails in `memory-pending/` (`memoryDb.keepPending`, replayed by the service at its next open);
 *   `dropCaches` keeps the entries the outbox holds; `validate` (`/nep resume`) checks the operational JSON files.
 *   Without a `memoryDb` (tests, a tool) the memory units live in the cache only: nothing is read or
 *   written for them.
 */
export function createStore(deps: Parameters<typeof buildStore>[0]): Store {
  return buildStore(deps);
}
