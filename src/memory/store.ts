// Persistent memory: the memory database (src/memory/db/service.ts) holds it, this module caches it -- it survives
// restarts, hot reloads and prompt edits; nothing in the codebase ever wipes it. Each cached value is one unit of the
// database, named by the path it had under data/ (`places/<g>/users/<u>.json`; the mappers of src/memory/db/map/
// turn a unit into rows and back); the operational files beside it stay JSON files under data/:
//
//   state.json        the pause flag, the daily counters and the marks of the running process
//   an account's      its profile (`user`) and what it said in private (`private`)
//   a place's         its notes (`place`), its map entry (`channel`), lore, media, GIFs, recent lines, participation
//                     and the previous texts of its prose (`versions`)
//   the persona's     the selfreflection
//
// The errand tasks (src/errands/store.ts) and the intentions (src/intentions/store.ts) are units of their own
// stores, not cached here. Everything is cached in memory (src/memory/unit-cache.ts), marked dirty on change and flushed
// on a timer and on shutdown: a memory unit's whole value goes to the database's writer through the cache's outbox,
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
import { accountCollection, keyText, personaKey, placeCollection } from './db/storage-keys.ts';
import type { StorageKey, StorageKind, StorageSelector } from './db/storage-keys.ts';
import { isMediaDescriptionEntry, mediaDescriptionOf } from './db/export.ts';
import { entryPictureDescriptions, linkedAttachmentIds } from './db/media-store.ts';
import type { MediaDescriptionEntry } from './db/export.ts';
import type { InterfaceNames } from './db/roots.ts';

import { linkedProfileUnit } from './db/person-links.ts';

import { isRecord, propOf, isFiniteNumber, isIntegerNumber, canWriteUnits, readSeamOf } from './types.ts';
import { log } from '../log.ts';
import { HOUR_MS, utcDay } from '../time.ts';
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
import { normalizePings, pingStateOf, withPingState } from './pings.ts';
import type { PingState } from './pings.ts';
import {
  emptyGifs,
  findGif,
  markOwnGif,
  mergeGifs,
  stampGifBackfill,
  withGifCaption,
  withGifFile,
  normalizeBackfillStamp,
  normalizeGifs,
  resetGifCounts,
} from './gifs.ts';
import type { GifLibrary } from './gifs.ts';
import { readGifVectors } from './db/gif-vectors.ts';
import { emptyRecent, mergeRecent, normalizeRecent } from './recent.ts';
import { PARTICIPATION_DEFAULTS, emptyParticipation, expireEpisodes, normalizeParticipation } from './participation.ts';
import { ITEM_ID_PREFIX, archiveEntry, archiveRevision } from './archive.ts';
import { normalizeAvatar } from './avatars.ts';
import { DEFAULT_VAULT_DIR, SNAPSHOTS_DIR, memoryRootOf } from './root.ts';
import { isCoreStatePath } from './migration/paths.ts';
import { createAddressing } from './store-addresses.ts';

import { createUnitCache } from './unit-cache.ts';
import type { CacheItem } from './unit-cache.ts';
import type { StoredRecord, MemoryDb, Untyped } from './types.ts';
import type { Track } from '../loop-watch.ts';
import { untracked } from '../loop-watch.ts';

const SELFREFLECTION_HISTORY_POSTS = 150; // selfreflection.historyPosts

/** Version history when a writer's caller passes none: `features.versions`, `memory.versionsKept`. */
const DEFAULT_VERSIONS = { enabled: true, kept: 20 };
/** The kinds of version files, one folder each under the place's versions/. */
const VERSION_KINDS = ['users', 'channels', 'place', 'lore'];
/** The prose fields of a public profile whose previous text is kept (kind `users`). */
const USER_PROSE = ['character', 'style', 'relationship'];
/** The prose fields of a channel entry (kind `channels`). */
const CHANNEL_PROSE = ['purpose', 'topics', 'tone'];
/** The prose fields of the place memory (kind `place`, id `place`). */
const PLACE_PROSE = ['patterns', 'starters'];
/** Every text field of the place memory `updatePlace` writes, the lists included: none keeps a link. */
const PLACE_TEXT = [...PLACE_PROSE, 'injokes', 'self'];

/** `memory.maxClosedStored` when it is missing (config.json carries the same). */
const DEFAULT_MAX_CLOSED_STORED = 40;
/** `archive.holdMaxMs` when it is missing (config.json carries the same). */
const DEFAULT_HOLD_MAX_MS = 5000;
/** The kinds a profile's `closed` list holds (src/memory/interests.ts#applyValidity). */
const CLOSED_KINDS = ['interest', 'detail', 'alias', 'realName'];
/** How long a stored real name may be. */
const REAL_NAME_CHARS = 60;

/** The selfreflection of a place with no post yet (the persona's selfreflection unit). */
const emptySelfreflection = () => ({ posts: [], updatedAt: 0 });

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
 * unit writes a shutdown could not make
 * (`memory-pending/`). Paths relative to the data directory. `/nep resume` checks only these (`validate`).
 */
export function operationalJsonPath(rel: string): boolean {
  const name = String(rel).replace(/\\/g, '/');
  if (isCoreStatePath(name)) return false;
  if (/^(?:vault|snapshots)\//.test(name)) return true;
  // The unit writes a shutdown could not make (src/memory/db/service.ts#keepPending).
  if (/^memory-pending\//.test(name)) return true;
  const inPlace = /^places\/[^/]+\/(?:private\/[^/]+\/)?(.+)$/.exec(name)?.[1];
  if (!inPlace) return false;
  return (
    /^(?:state|usage|metrics|inner|missed|participation|gifs|media)\.json$/.test(inPlace) ||
    /^journal\/requests\//.test(inPlace) ||
    /^backfill\//.test(inPlace) ||
    inPlace === 'record/backfill.json'
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

function emptyPlace() {
  return {
    patterns: '',
    starters: '',
    injokes: [],
    self: [],
    learned: [], // things people taught the persona: detail-shaped items plus an optional `from` -- see applyLearnedOps
    learnedNextId: 1, // the next id a learned item gets -- never reused, even after a remove
    emojiUsage: {}, // { [emojiId]: { name, count, last } } -- members' custom emoji uses, see recordEmojiUsage
    emojiBackfill: null, // { at, channels, messages } once src/memory/emoji-backfill.ts has read the history
    pings: {}, // { [accountId]: 'on' | 'off' } -- each member's own ping state, set by `pings.set`; see setPings
    updatedAt: null,
    notesUpdatedAt: null, // when patterns, starters or injokes last changed -- see updatePlace
    notesCheckedAt: null, // an ISO time kept as stored; nothing in the engine writes it
    notesFlaggedAt: null, // when the analyzer last flagged them stale -- see markNotesFlagged
    notesSampleReviewedAt: null, // when a sample refresh last reviewed them -- see markNotesSampled
    notesAttemptAt: null, // when a sample refresh last tried and failed -- see markNotesSampled
  };
}

/** The server notes among the place's fields: a change of one of them moves `notesUpdatedAt`. */
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

/** Fields a the place's notes may still hold from features the engine no longer has; dropped on read. */
const STALE_PLACE_FIELDS = ['ownLines', 'worn', 'wornLong', 'wornHistory', 'fillers', 'ownMessageCount'];

/** Normalize a place's `learned`/`learnedNextId`/`emojiUsage`/`emojiBackfill` fields in place: a
 * the place's notes written before this list existed loads it as empty, a
 * hand-edited one is validated via src/memory/details.ts#normalizeDetails
 * (fresh ids off `learnedNextId` when needed). The two notes stamps
 * (`notesUpdatedAt`, `notesCheckedAt`) are kept when they read as a time and
 * are null otherwise: a the place's notes written before them has never been
 * stamped, which readers take as stale notes. The keys in
 * STALE_PLACE_FIELDS are deleted (they reach disk at the next write). Every
 * other field is left exactly as stored; a non-object value is left alone entirely. Never marks
 * anything dirty -- same contract as `normalizeProfile`. */
function normalizePlace(place: Untyped) {
  if (!place || typeof place !== 'object' || Array.isArray(place)) return;
  if (!isIntegerNumber(place.learnedNextId) || place.learnedNextId < 1) place.learnedNextId = 1;
  const { items, nextId } = normalizeDetails(place.learned, place.learnedNextId);
  place.learned = items;
  place.learnedNextId = nextId;
  // Missing or hand-broken -> {} (src/memory/emoji-usage.ts#normalizeEmojiUsage).
  place.emojiUsage = normalizeEmojiUsage(place.emojiUsage);
  // Missing or hand-broken -> null: the history backfill has not run.
  place.emojiBackfill = normalizeBackfillStamp(place.emojiBackfill);
  for (const key of STALE_PLACE_FIELDS) delete place[key];
  // Missing or hand-broken -> {}: nobody chose a state. A member in the `pingsOff` list of the earlier switch reads `off`.
  place.pings = normalizePings(place.pings, place.pingsOff);
  delete place.pingsOff;
  // Missing or hand-broken -> null: never stamped.
  place.notesUpdatedAt = isoStampOrNull(place.notesUpdatedAt);
  place.notesCheckedAt = isoStampOrNull(place.notesCheckedAt);
  place.notesFlaggedAt = isoStampOrNull(place.notesFlaggedAt);
  place.notesSampleReviewedAt = isoStampOrNull(place.notesSampleReviewedAt);
  place.notesAttemptAt = isoStampOrNull(place.notesAttemptAt);
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

/** A cached profile's value field by field: every stored value here is a profile object. */
const entryRecord = (item: CacheItem): StoredRecord => item.value as StoredRecord;

/** `names` with `name`: first when it is the newest touch, else last when unseen. A list keeps five names. */
function withName(names: unknown, name: string, isNewest: boolean): Array<string> {
  const known: Array<string> = Array.isArray(names) ? names.map(String) : [];
  if (isNewest) return [name, ...known.filter((one) => one !== name)].slice(0, 5);
  return known.includes(name) ? known : [...known, name].slice(0, 5);
}

/** What a linked account reads: the person's profile with the account's own id, names, address and avatar. */
function linkedProfile(person: CacheItem, account: CacheItem | null, id: string): StoredRecord {
  const own = account ? entryRecord(account) : {};
  const profile: StoredRecord = { ...entryRecord(person), id, names: own.names ?? [] };
  for (const field of ['addressedAs', 'avatar']) {
    if (own[field]) profile[field] = own[field];
    else delete profile[field];
  }
  return profile;
}

type StoreClosedInput = {
  item: Untyped;
  file: string;
  target: Untyped;
  closed: Untyped;
  opts: Untyped;
  home?: string | null;
  isPrivate?: boolean;
};

type ArchiveProfileItemsInput = {
  item: Untyped;
  file: string;
  previous: Untyped;
  dropped: Untyped;
  ops: Untyped;
  home?: string | null;
  isPrivate?: boolean;
};

type ArchiveReplacedInput = {
  previous: Untyped;
  current: Untyped;
  itemKind: string;
  scope: Untyped;
  home?: string | null;
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
  /** The event loop watch's `track` (src/loop-watch.ts); a flush of the cache is a named operation. */
  track?: Track;
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

type UpdatePlaceOptions = {
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
  source: string;
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

type SelfreflectionPostOptions = {
  at: number;
  kind: string | null;
  gist: string;
  picture: string | boolean | null;
  pictures?: number;
  messageIds?: Array<string>;
  search: string;
  text?: string;
  itemId?: string;
  /** What the planner planned: its brief, the seed combinations offered and the 1-based one taken (0 for none). */
  plan?: { brief: string; seeds: Array<Array<string>>; seed: number };
  /** The description of the entry's first linked picture, read from the media on each read and never stored. */
  pictureDescription?: string;
};

/** A copy of the persona's selfreflection unit as `getSelfreflection` returns it. */
type SelfreflectionCopy = {
  posts: Array<SelfreflectionPostOptions & { messageIds: Array<string> }>;
  updatedAt: number;
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
  home?: string | null;
  accountId?: string | null;
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
  track = untracked,
}: StoreDeps) {
  const root = memoryRootOf(dataDir);
  const seam = readSeamOf(memoryDb, log, 'store');
  // The memory units and files this store holds, and their one way to the writer.
  const cache = createUnitCache({ memoryDb, seam, files: { read: readJson, write: writeJsonAtomic } });
  const { address, collection, entry } = cache;
  const seededMedia = new Set<string>();
  const pendingMedia = new Map<string, { key: StorageKey; entry: MediaDescriptionEntry }>();

  function mediaDescriptionKey(placeId: string, cacheKey: string): StorageKey {
    return placeCollection('versions', placeId, { selector: { versionKind: 'media', itemId: cacheKey } });
  }

  function rememberMedia(placeId: string, cacheKey: string, value: MediaDescriptionEntry, seed = false): void {
    if (!cache.writable()) return;
    const key = mediaDescriptionKey(placeId, cacheKey);
    const text = keyText(key);
    if (seed && (pendingMedia.has(text) || mediaDescriptionOf(seam.db(), key))) return;
    const snapshot = structuredClone(value);
    pendingMedia.set(text, { key, entry: snapshot });
    cache.lines(key, [{ op: seed ? 'seed' : 'described', id: newId(), entry: snapshot }]);
  }

  function currentMedia(placeId: string, cacheKey: string): MediaDescriptionEntry | null {
    if (!cache.writable()) return null;
    const key = mediaDescriptionKey(placeId, cacheKey);
    const text = keyText(key);
    const pending = pendingMedia.get(text);
    if (pending && cache.holds(key)) return structuredClone(pending.entry);
    pendingMedia.delete(text);
    return seam.run(() => mediaDescriptionOf(seam.db(), key));
  }

  function seedMedia(placeId: string, file: string, described: StoredRecord): void {
    if (!cache.writable() || seededMedia.has(file)) return;
    seededMedia.add(file);
    for (const [key, value] of Object.entries(described)) {
      if (!isMediaDescriptionEntry(value) || /^(?:preview|search|results|page):/.test(key)) continue;
      const provenance = isFiniteNumber(value.describedAt) && typeof value.model === 'string' && value.model !== '';
      const answer = /^(?:video|image|gif):.+:q:[a-f0-9]+$/.test(key) && typeof value.answer === 'string';
      if (provenance || answer) rememberMedia(placeId, key, value, true);
    }
  }

  // ---- The archive (src/memory/archive.ts): nothing leaves a hot list without a copy ----
  //
  // With an archive injected and `archiveOn()` true, every item a write drops (a cap, an expiry,
  // an analyzer's remove, a list replaced whole, an interest folded into another) stays in its
  // list in the cache -- over the cap -- and its archive entry is queued for the place. The writers
  // stay synchronous: the queue is appended in the background (`archive.append`), and once the
  // archive confirms an entry `trimArchived` takes the item out of its list. So a flush can only
  // write a file without the item after its copy is in the archive. A refused append sends the
  // entries to the archive's pending queue, the items stay hot, and the drain (`drainArchive`, on
  // src/index.js's timer) archives and trims them later. A write that changes an item's text in
  // place (an interest's note) queues the previous version (`replaced`); the new one is already
  // hot. A later merge that keeps an item held for the cap (it ranks again) releases it: the newest
  // merge's verdict stands; an item removed or replaced stays held until it is archived. `archiveMark` / `settleArchive` tell a caller what became of the entries its
  // writes queued.

  /** Outcomes kept for `settleArchive`, oldest dropped first. */
  const ARCHIVE_OUTCOMES_KEPT = 5000;
  // The one queue: { seq, queue: [{ seq, entry, home, holdItem }], held: [...], outcomes: Map(seq -> outcome),
  //   retry: [...] (entries neither archived nor queued as pending), chain: Promise, scheduled: boolean }
  const archiveState: Untyped = {
    seq: 0,
    queue: [],
    held: [],
    outcomes: new Map(),
    retry: [],
    chain: Promise.resolve(),
    scheduled: false,
  };

  /** Whether writes archive their victims now: an archive injected and `archiveOn()` true (read now). */
  function archiving() {
    return Boolean(archive) && archiveOn() === true;
  }

  /**
   * Queue one entry for the background append to the archive of `home` (a place, or the persona's with null). With `holdItem` (the cache entry whose file already holds the item's
   * NEW version) that file is held back from every flush (`holdFlush`) until the archive or its
   * pending queue took the entry (`releaseHold`).
   */
  function queueArchiveEntry(entry: Untyped, home: string | null = null, holdItem: Untyped = null) {
    const state = archiveState;
    state.seq += 1;
    if (holdItem) holdItem.holdFlush = (holdItem.holdFlush ?? 0) + 1;
    state.queue.push({ seq: state.seq, entry, home, holdItem });
    if (state.scheduled) return;
    state.scheduled = true;
    state.chain = state.chain
      .then(() => {
        state.scheduled = false;
        return sendArchiveQueue();
      })
      .catch((error: Untyped) => log.warn('store: archive failed', { code: error?.code ?? null }));
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

  /** `queued` grouped by the archive they go to: a place's, or the persona's under null. */
  function byArchive(queued: Untyped): Map<string | null, Array<Untyped>> {
    const groups = new Map<string | null, Array<Untyped>>();
    for (const item of queued) {
      const key: string | null = item.home ?? null;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return groups;
  }

  /**
   * Append `queued` to the archive; a refused group goes to the archive's pending queue (kept in
   * memory for the drain when even that fails). Returns the outcome of each group.
   */
  async function appendQueued(queued: Untyped) {
    const state = archiveState;
    const results = [];
    for (const [home, group] of byArchive(queued)) {
      const entries = group.map((item: Untyped) => item.entry);
      try {
        await archive.append(home, entries);
        group.forEach(releaseHold);
        results.push({ group, status: 'archived' });
      } catch (error) {
        log.warn('store: archive failed', { entries: entries.length, code: propOf(error, 'code') ?? null });
        try {
          await archive.queuePending(home, entries);
          group.forEach(releaseHold);
        } catch (queueError) {
          log.warn('store: archive queue failed', {
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

  async function sendArchiveQueue() {
    const state = archiveState;
    const queued = state.queue.splice(0);
    if (queued.length === 0) return;
    for (const { group, status } of await appendQueued(queued)) {
      for (const item of group) noteOutcome(state, item, status);
    }
    trimArchived();
  }

  /**
   * Hold what one write dropped from one list: each victim goes back into its list (where it
   * stood) and its archive entry is queued, unless the same version is held already. Held items
   * of this list the write kept are released. Call it only for a list the write really merged.
   */
  function holdVictims(site: HoldVictimsInput) {
    if (!archiving()) return;
    const state = archiveState;
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
        accountId: site.accountId ?? null,
        confirmed: false,
      });
      queueArchiveEntry(entry, site.home ?? null);
    });
    where.holder[where.key] = reinsert(site.previous, current, victims, strings);
    site.item.dirty = true;
  }

  /**
   * Queue the previous version of every item of `previous` whose text `current` changed in place
   * (same `itemId`, another revision) with event `replaced`. The item stays; `item` (the cache
   * entry of the file) is held back from the flush until the old version is archived.
   */
  function archiveReplaced({ previous, current, itemKind, scope, home = null, item = null }: ArchiveReplacedInput) {
    if (!archiving() || !Array.isArray(previous) || !Array.isArray(current)) return;
    const now = new Map(current.filter((item) => identOf(false, item) !== null).map((item) => [item.itemId, item]));
    for (const before of previous) {
      const after = identOf(false, before) !== null ? now.get(before.itemId) : undefined;
      if (!after || archiveRevision(itemKind, after) === archiveRevision(itemKind, before)) continue;
      queueArchiveEntry(archiveEntry(before, { itemKind, event: 'replaced', scope, uuid: newId }), home, item);
    }
  }

  /**
   * The ranked lists of a member file one write merged (interests, details, aliases): the
   * victims held, the texts changed in place archived.
   */
  function archiveProfileItems(
    accountId: string,
    { item, file, previous, dropped, ops, home = null, isPrivate = false }: ArchiveProfileItemsInput
  ) {
    if (!archiving()) return;
    const id = String(accountId);
    const scope = memberScope(id, isPrivate);
    for (const [field, itemKind, identity] of [
      ['interests', 'interest', 'topic'],
      ['details', 'detail', 'text'],
      ['aliases', 'alias', 'name'],
    ]) {
      if (!isRecord(ops?.[field])) continue;
      const kept = Array.isArray(item.value[field]) ? item.value[field] : [];
      const removing = removeKeysOf(ops[field].remove);
      archiveReplaced({ previous: previous[field], current: kept, itemKind, scope, home, item });
      holdVictims({
        item,
        file,
        path: [field],
        previous: previous[field],
        victims: dropped[field],
        itemKind,
        scope,
        home,
        accountId: id,
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
    accountId: string,
    { item, file, target, closed, opts, home = null, isPrivate = false }: StoreClosedInput
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
    const id = String(accountId);
    for (const kind of CLOSED_KINDS) {
      const victims = evicted.filter((value) => value.kind === kind);
      if (victims.length === 0) continue;
      holdVictims({
        item,
        file,
        path: ['closed'],
        previous: all,
        victims,
        itemKind: kind,
        scope: memberScope(id, isPrivate),
        home,
        accountId: id,
        eventOf: () => 'replaced',
      });
    }
  }

  /** Take the confirmed victims out of their lists (see "The archive" above); returns how many went. */
  function trimArchived() {
    const state = archiveState;
    // /nep pause: nothing may make the store dirty while paused; the holds wait for the resume.
    if (stateEntry.value.paused) return 0;
    let trimmed = 0;
    const keep = [];
    for (const held of state.held) {
      if (!held.confirmed) {
        keep.push(held);
        continue;
      }
      const item = cache.cached(held.file);
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
    if (trimmed > 0) log.info('store: archive trimmed', { trimmed });
    return trimmed;
  }

  /** The cache entry of what belongs to the account itself (names, avatar, address), created empty and normalised. */
  function accountEntry(accountId: string): CacheItem & { value: StoredRecord } {
    const item = entry(accountFile(accountId), () => emptyProfile(addressing.nativeOfRow('accounts', accountId)));
    normalizeProfile(item.value);
    return item;
  }

  /** Where an archived item goes back to (`restoreArchived`): its cache entry (null without the file) and list; null for a kind that cannot. */
  function restoreTarget(placeId: string, archived: Untyped) {
    const isPrivate = archived?.scope?.private === true;
    const accountId =
      typeof archived?.scope?.user === 'string' ? archived.scope.user : partnerOfPlace(archived?.scope?.place);
    const member = (keys: Untyped) => {
      if (!accountId) return null;
      if (isPrivate) return { item: hasPrivate(accountId) ? privateEntry(accountId) : null, path: keys };
      return { item: store.getUser(accountId) ? cache.cached(userFile(accountId)) : null, path: keys };
    };
    const place = (keys: Untyped, strings = false) => {
      const item = entry(placeFile(placeId), emptyPlace);
      normalizePlace(item.value);
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
        return place(['learned']);
      case 'selfFact':
        return place(['self'], true);
      case 'injoke':
        return place(['injokes'], true);
      case 'selfreflection':
        return { item: selfreflectionEntry(), path: ['posts'] };
      default:
        return null;
    }
  }

  /**
   * A `felt` line (src/memory/record.ts#feltLine) for each of `episodes` that holds a feeling,
   * appended to the record of `placeId` (the member's private record for the private layer).
   * Not awaited: the store's writers stay synchronous; a refused append is logged.
   */
  function recordFelt(accountId: string, layer: Untyped, episodes: Untyped) {
    if (!record || !recordOn()) return;
    const lines = episodes
      .filter((ep: Untyped) => isRecord(ep) && typeof ep.feeling === 'string' && ep.feeling)
      .map((ep: Untyped) =>
        feltLine(
          {
            accountId: String(accountId),
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
        lines: lines.length,
        code: error?.code ?? null,
      });
    try {
      Promise.resolve(record.append(layer === 'private' ? dmHomeOf(String(accountId)) : null, lines)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  /** Whether a unit has a value, cached or stored (see unit-cache.ts#known), an operational file on disk. */
  const known = (file: string) => cache.known(file, fs.existsSync);
  const idsUnder = cache.idsUnder;

  /** Flush every dirty cache entry (`flushEntry`); returns how many were written, failed and held. */
  function flushAll({ force = false } = {}) {
    return track('store.flushAll', () => cache.flushAll({ force }));
  }

  const addressing = createAddressing({ memoryDb, seam });
  const { partnerOfPlace, dmHomeOf } = addressing;
  /** What an archived item of an account says about where it belongs. */
  function memberScope(accountId: string, isPrivate: boolean): Record<string, Untyped> {
    const place = isPrivate ? dmHomeOf(accountId) : null;
    return place ? { place, private: true } : { user: accountId, ...(isPrivate ? { private: true } : {}) };
  }
  const usersDir = () => collection('user');
  /** The unit of the account itself: its names, its avatar, how it is addressed. */
  const accountFile = (accountId: string) => address(accountCollection('user', accountId));
  /**
   * The unit that holds what describes the member: the account's own, or the profile unit of the person it is linked to.
   * Read at every use, so an unlink takes effect at once. A closed database answers with the account's own unit.
   */
  function userFile(accountId: string): string {
    const own = accountFile(accountId);
    if (!memoryDb?.readHandle?.()) return own;
    const unit = seam.run(() => linkedProfileUnit(seam.db(), accountId));
    return unit ? address(unit.key) : own;
  }
  const placeFile = (placeId: string) => address(placeCollection('place', placeId));
  const channelsDir = () => collection('channel');
  const channelFile = (placeId: string) => address(placeCollection('channel', placeId));
  const placeUnitFile = (kind: StorageKind, placeId: string) => address(placeCollection(kind, placeId));
  const mediaCacheFile = (placeId: string) => placeUnitFile('media', placeId);
  const loreFile = (placeId: string) => placeUnitFile('lore', placeId);
  const gifsFile = () => address(personaKey('gifs'));
  const emojiRailsFile = (placeId: string) => placeUnitFile('emoji_rails', placeId);
  const privateDir = () => collection('private');
  const privateFile = (accountId: string) => address(accountCollection('private', accountId));
  const recentFile = (placeId: string) => placeUnitFile('recent', placeId);
  const participationFile = (placeId: string) => placeUnitFile('participation', placeId);
  const selfreflectionFile = () => address(personaKey('selfreflection'));
  const versionsFile = (placeId: string | null, kind: string, id: string) => {
    const selector: StorageSelector = {
      versionKind: kind as NonNullable<StorageSelector['versionKind']>,
      itemId: kind === 'lore' ? loreVersionKey(id) : id,
    };
    const base =
      kind === 'users'
        ? accountCollection('user', id)
        : kind === 'channels'
          ? placeCollection('channel', id)
          : placeCollection('place', placeId ?? id);
    return address({ ...base, kind: 'versions', selector });
  };
  const stateFile = memoryDb ? address(personaKey('state')) : root.stateFile;

  const stateEntry = entry(stateFile, () => ({}));

  /** The cache entry of a member's private file, created empty when missing, normalised. A file
   * that parses to something other than an object (null, an array, a string -- a hand edit gone
   * wrong) is replaced by the empty shape in the cache, so the private pass never stalls on it;
   * the disk copy is only rewritten by the next change, like any other entry. */
  function privateEntry(accountId: string) {
    const item = entry(privateFile(accountId), emptyPrivate);
    if (!item.value || typeof item.value !== 'object' || Array.isArray(item.value)) {
      log.warn('store: private file replaced', { reason: 'malformed' });
      item.value = emptyPrivate();
    }
    normalizePrivate(item.value);
    return item;
  }

  /** The cache entry of one channel of the server map, created empty when missing, normalised in
   * place (`normalizeChannel`); never marked dirty by reading, so a tally seeded for an old file
   * is written only by the next change. */
  function channelEntry(placeId: string) {
    const item = entry(channelFile(placeId), () => emptyChannel(addressing.nativeOfRow('places', placeId)));
    normalizeChannel(item.value);
    return item;
  }

  /** The cache entry of one version file, `{}` when missing; a file that is not an object (a
   * hand edit gone wrong) reads as `{}` in the cache. Never marked dirty by reading. */
  function versionsEntry(placeId: string | null, kind: string, id: string) {
    const item = entry(versionsFile(placeId, kind, id), () => ({}));
    if (!isRecord(item.value)) item.value = {};
    return item;
  }

  /**
   * Keep the previous text of one prose field before a writer replaces it:
   * appended to data/places/<id>/versions/<kind>/<id>.json under `field` as
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
    placeId: string | null,
    kind: 'users' | 'channels' | 'place' | 'lore',
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
    const item = versionsEntry(placeId, kind, id);
    const diff = sentenceDiff(previous, next);
    const by = typeof opts.by === 'string' && opts.by.trim() ? opts.by.trim() : 'unknown';
    const at = new Date(isFiniteNumber(opts.now) ? opts.now : Date.now()).toISOString();
    const chars = [...previous].length;
    const list = Array.isArray(item.value[field]) ? item.value[field] : [];
    const all = withItemIds([...list, { at, by, chars, ...diff, text: previous }], ITEM_ID_PREFIX.version, newId);
    const keptVersions = all.slice(-kept);
    item.value[field] = keptVersions;
    const dropped = all.slice(0, all.length - keptVersions.length);
    item.dirty = true;
    holdVictims({
      item,
      file: versionsFile(placeId, kind, id),
      path: [field],
      previous: list,
      victims: dropped,
      itemKind: 'version',
      eventOf: () => 'evicted',
      scope:
        kind === 'users'
          ? { user: String(id) }
          : kind === 'channels'
            ? { place: String(id) }
            : { place: String(placeId) },
      accountId: kind === 'users' ? String(id) : null,
    });
    log.info('store: version recorded', {
      placeId,
      kind,
      ...(kind === 'channels' ? { placeId: String(id) } : {}),
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
    owner: { accountId: string; layer?: 'private' } | null = null
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
          owner.accountId,
          owner.layer,
          stamped.filter((_, i) => !before.has(episodes[i]))
        );
      if (owner) {
        const id = String(owner.accountId);
        const isPrivate = owner.layer === 'private';
        const scope = memberScope(id, isPrivate);
        holdVictims({
          item,
          file: isPrivate ? privateFile(id) : userFile(id),
          path: ['episodes'],
          previous,
          victims,
          itemKind: 'episode',
          eventOf: () => 'evicted',
          scope,
          home: isPrivate ? dmHomeOf(id) : null,
          accountId: id,
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
    accountId: string,
    item: Untyped,
    file: string,
    current: Untyped,
    next: Untyped,
    isPrivate = false
  ) {
    if (next === current || !Array.isArray(next.droppedMoves)) return;
    const id = String(accountId);
    holdVictims({
      item,
      file,
      path: ['affinity', 'history'],
      previous: Array.isArray(current?.history) ? current.history : [],
      victims: next.droppedMoves,
      itemKind: 'move',
      eventOf: () => 'evicted',
      scope: memberScope(id, isPrivate),
      home: isPrivate ? dmHomeOf(id) : null,
      accountId: id,
    });
  }

  /** Whether a channel has an entry, cached or on disk (no side effects on the cache). */
  function hasChannel(placeId: string) {
    const file = channelFile(placeId);
    return known(file);
  }

  /** The cache entry of the shared GIF library, created empty when missing, normalised in place of
   * the cached value (src/memory/gifs.ts#normalizeGifs); never marked dirty by reading. */
  function gifsEntry() {
    const item = entry(gifsFile(), emptyGifs);
    item.value = normalizeGifs(item.value);
    return item;
  }

  let gifVectors: Map<string, { model: string | null; vector: Float32Array }> | null = null;
  /** The GIF vectors as this store knows them, read from the database once. */
  function heldGifVectors() {
    gifVectors ??= (memoryDb ? seam.run(() => readGifVectors(seam.db())) : null) ?? new Map();
    return gifVectors;
  }

  /** Whether a member has a private file, cached or on disk (no side effects on the cache). */
  function hasPrivate(accountId: string) {
    const file = privateFile(accountId);
    return known(file);
  }

  /** The cache entry of a place's recent store, the empty store when there is no file, normalised
   * in place of the cached value (src/memory/recent.ts#normalizeRecent); never marked dirty by
   * reading, so a healed hand edit is written only by the next change. On the read that loads the
   * file, lines normalising leaves out (a hand edit, a file from another version) are logged as a
   * count, `store: recent lines dropped`, and a value that is not a store (not an object, or
   * `lines` not a list) as `store: recent store replaced`: the next write makes the loss
   * permanent. An unparsable file reads as empty with `readJson`'s warning. */
  function recentEntry(placeId: string) {
    const file = recentFile(placeId);
    const loading = !cache.cached(file);
    const item = entry(file, emptyRecent);
    const raw = item.value;
    const recent = normalizeRecent(raw);
    item.value = recent;
    if (loading && (!isRecord(raw) || !Array.isArray(raw.lines))) {
      log.warn('store: recent store replaced', { placeId, reason: 'malformed' });
    } else if (loading && raw.lines.length > recent.lines.length) {
      log.warn('store: recent lines dropped', { placeId, dropped: raw.lines.length - recent.lines.length });
    }
    return item;
  }

  /** The cache entry of a place's participation store, the empty store when there is no file,
   * normalised in place of the cached value (src/memory/participation.ts#normalizeParticipation);
   * never marked dirty by reading. On the read that loads the file, episodes normalising leaves out
   * are logged as a count, `store: participation episodes dropped`, and a value that is not a store
   * (not an object, or `episodes` not a list) as `store: participation store replaced`. An
   * unparsable file reads as empty with `readJson`'s warning. */
  function participationEntry(placeId: string) {
    const file = participationFile(placeId);
    const loading = !cache.cached(file);
    const item = entry(file, emptyParticipation);
    const raw = item.value;
    const participation = normalizeParticipation(raw);
    item.value = participation;
    if (loading && (!isRecord(raw) || !Array.isArray(raw.episodes))) {
      log.warn('store: participation store replaced', { placeId, reason: 'malformed' });
    } else if (loading && raw.episodes.length > participation.episodes.length) {
      log.warn('store: participation episodes dropped', {
        placeId,
        dropped: raw.episodes.length - participation.episodes.length,
      });
    }
    return item;
  }

  /** The cache entry of a place's selfreflection, the empty selfreflection when there is no file; a value that is not
   * a selfreflection (not an object, or `posts` not a list) is replaced by the empty one in the cache, and
   * the disk copy is only rewritten by the next change. */
  function selfreflectionEntry() {
    const item = entry(selfreflectionFile(), emptySelfreflection);
    if (!isRecord(item.value) || !Array.isArray(item.value.posts)) item.value = emptySelfreflection();
    return item;
  }

  /** Store `posts` (the newest `max`) as the place's selfreflection, stamped `now`, and mark it dirty. Every
   * post gets an `itemId` when it has none (`dy-`); returns `{ dropped }`, the posts that fell past
   * `max`, oldest first, with theirs. */
  function writeSelfreflection(posts: Untyped, { max, now }: { max?: number; now?: number } = {}) {
    const item = selfreflectionEntry();
    const previous = item.value.posts;
    const limit = isFiniteNumber(max) && max > 0 ? Math.floor(max) : SELFREFLECTION_HISTORY_POSTS;
    const all = withItemIds(posts, ITEM_ID_PREFIX.selfreflection, newId);
    const kept = all.slice(-limit);
    item.value = { posts: kept, updatedAt: isFiniteNumber(now) ? now : Date.now() };
    item.dirty = true;
    const dropped = all.slice(0, all.length - kept.length);
    holdVictims({
      item,
      file: selfreflectionFile(),
      path: ['posts'],
      previous,
      victims: dropped,
      itemKind: 'selfreflection',
      eventOf: () => 'evicted',
      scope: {},
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
    getUser(accountId: string): StoredRecord | null {
      const file = userFile(accountId);
      if (!known(file)) return null;
      const item = entry(file, () => emptyProfile(addressing.nativeOfRow('accounts', accountId)));
      normalizeProfile(item.value);
      const own = accountFile(accountId);
      if (file === own) return item.value;
      return linkedProfile(item, known(own) ? accountEntry(accountId) : null, String(accountId));
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
    touchUser(accountId: string, name: string, at = Date.now()): StoredRecord {
      const item = entry(userFile(accountId), () => emptyProfile(addressing.nativeOfRow('accounts', accountId)));
      const profile = item.value;
      const account = accountEntry(accountId);

      const priorFirstSeenMs = profile.firstSeen ? Date.parse(profile.firstSeen) : NaN;
      const priorLastSeenMs = profile.lastSeen ? Date.parse(profile.lastSeen) : NaN;
      const isNewest = !isFiniteNumber(priorLastSeenMs) || at >= priorLastSeenMs;

      if (name) account.value.names = withName(account.value.names, name, isNewest);

      if (!isFiniteNumber(priorFirstSeenMs) || at < priorFirstSeenMs) {
        profile.firstSeen = new Date(at).toISOString();
      }
      if (!isFiniteNumber(priorLastSeenMs) || at > priorLastSeenMs) {
        profile.lastSeen = new Date(at).toISOString();
      }
      profile.messageCount += 1;
      item.dirty = true;
      account.dirty = true;
      return account === item ? profile : (store.getUser(accountId) as StoredRecord);
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
      accountId: string,
      fields: Untyped,
      opts: { by?: string; versions?: { enabled?: boolean; kept?: number } } = {}
    ): StoredRecord {
      const item = entry(userFile(accountId), () => emptyProfile(addressing.nativeOfRow('accounts', accountId)));
      const { affinity, episodes, interests, details, detailsSeq, ...given } = fields ?? {};
      const safeFields = withoutLinks(given, USER_PROSE);
      for (const key of USER_PROSE) {
        if (key in safeFields) recordVersion(null, 'users', accountId, key, item.value[key], safeFields[key], opts);
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
      accountId: string,
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
      const item = entry(userFile(accountId), () => emptyProfile(addressing.nativeOfRow('accounts', accountId)));
      const profile = item.value;
      normalizeProfile(profile);

      const seenAt = seenAtOf(opts);

      for (const key of ['character', 'style'] as const) {
        const value = typeof ops?.[key] === 'string' ? stripUrls(ops[key]) : undefined;
        if (typeof value === 'string' && value.trim()) {
          const next = firstWriteText(profile[key], value, opts.fieldChars, opts.clampTolerance);
          recordVersion(null, 'users', accountId, key, profile[key], next, opts);
          profile[key] = next;
        }
      }
      writeRelationship(profile, ops?.relationship, opts, (previous, next) =>
        recordVersion(null, 'users', accountId, 'relationship', previous, next, opts)
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
      archiveProfileItems(accountId, { item, file: userFile(accountId), previous, dropped, ops });
      storeClosed(accountId, {
        item,
        file: userFile(accountId),
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
      accountId: string,
      uses: Array<{ name: string; at: number }>,
      opts: { halfLifeDays?: number; max?: number; now?: number } = {}
    ): object | null {
      const profile = store.getUser(accountId);
      if (!profile) return null;
      if (!Array.isArray(uses) || uses.length === 0) return profile;
      const account = accountEntry(accountId);
      account.value.addressedAs = applyAddressUses(account.value.addressedAs, uses, opts);
      account.dirty = true;
      return store.getUser(accountId);
    },

    /**
     * Store a member's current avatar (src/memory/avatars.ts#normalizeAvatar: `{ hash, text,
     * describedAt }` or `{ hash: null, default: true }`), replacing the one stored: no history of
     * old avatars. Only into an existing profile, and never a profile's `updatedAt` (the portrait's
     * version stamp). Lives and goes with the profile.
     * @returns The profile, or null when nothing was written.
     */
    setAvatar(accountId: string, avatar: Untyped): object | null {
      if (!known(userFile(accountId))) return null;
      const value = normalizeAvatar(avatar);
      if (!value) return null;
      const item = accountEntry(accountId);
      item.value.avatar = value;
      item.dirty = true;
      return store.getUser(accountId);
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
    markRelationshipRewrite(accountId: string, on: boolean = true): boolean {
      const profile = store.getUser(accountId);
      if (!profile || typeof profile.relationship !== 'string' || !profile.relationship.trim()) return false;
      const item = entry(userFile(accountId), () => emptyProfile(addressing.nativeOfRow('accounts', accountId)));
      if (on) entryRecord(item).relationshipRewrite = true;
      else delete entryRecord(item).relationshipRewrite;
      item.dirty = true;
      return true;
    },

    /**
     * Append freshly-extracted episodes to a member's profile via
     * src/memory/episodes.ts#mergeEpisodes: validated, deduplicated against
     * what is already stored, then evicted back down to `opts.maxEpisodes`
     * (lowest weight, oldest first) if needed. Returns how many were added.
     */
    addEpisodes(accountId: string, incoming: Untyped, opts: Untyped) {
      const item = entry(userFile(accountId), () => emptyProfile(addressing.nativeOfRow('accounts', accountId)));
      return mergeEpisodesInto(item, incoming, opts, { accountId }).added;
    },

    /** Fold one delta into a member's stored affinity (see src/memory/affinity.ts); `decayedAt` is
     * kept. Returns the stored affinity, with `applyDelta`'s non-enumerable `droppedMoves`. */
    adjustAffinity(
      accountId: string,
      delta: Untyped,
      reason: string,
      opts: Untyped
    ): { score: number; reason: string; history: Array<object> } | null {
      const item = entry(userFile(accountId), () => emptyProfile(addressing.nativeOfRow('accounts', accountId)));
      const current = item.value.affinity ?? emptyAffinity();
      const next = applyDeltaWithIds(current, delta, reason, opts);
      item.value.affinity = next;
      item.dirty = true;
      holdMoves(accountId, item, userFile(accountId), current, next);
      return next;
    },

    /**
     * `relationships.decayPerDay`: run src/memory/affinity.ts#decayAffinity over every member
     * profile of a place AND every private layer under its `private/` directory. Only a file
     * whose affinity actually changed (score moved, or the `decayedAt` stamp was set or
     * advanced) is marked dirty; a profile without any stored affinity is left alone. Never
     * creates a file.
     * @param nowMs  Epoch milliseconds.
     * @param cfg  `config.relationships`, read by the caller at the moment of the sweep.
     * @returns `profiles`: files looked at (public +
     *   private); `decayed`: files whose score moved.
     */
    decayAffinities(
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
      // A person with two accounts holds one score, so it cools once.
      const swept = new Set<string>();
      for (const accountId of idsUnder(usersDir())) {
        if (!store.getUser(accountId)) continue;
        const file = userFile(accountId);
        if (swept.has(file)) continue;
        swept.add(file);
        sweep(entry(file, () => emptyProfile(addressing.nativeOfRow('accounts', accountId))));
      }
      for (const accountId of idsUnder(privateDir())) sweep(privateEntry(accountId));
      return counts;
    },

    // ---- the private layer: what one member said to the persona in direct messages ----

    /**
     * A member's private layer (the place's private/<accountId>.json), or
     * null when there is none. Normalised on read (see `normalizePrivate`),
     * persisted the next time anything writes the file.
     */
    getPrivate(accountId: string): object | null {
      if (!hasPrivate(accountId)) return null;
      return privateEntry(accountId).value;
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
    applyPrivateOps(accountId: string, ops: PrivateOpsOptions, opts: StoredRecord = {}): object {
      const item = privateEntry(accountId);
      const priv = item.value;

      const seenAt = seenAtOf(opts);

      writeRelationship(priv, ops?.relationship, opts);

      // What left the private layer, each with its itemId: the archive's input.
      const previous = { interests: priv.interests, details: priv.details };
      const dropped = applyItemOps(priv, ops, opts, seenAt, newId);
      archiveProfileItems(accountId, {
        item,
        file: privateFile(accountId),
        previous,
        dropped,
        ops: { interests: ops?.interests, details: ops?.details },
        home: dmHomeOf(String(accountId)),
        isPrivate: true,
      });
      storeClosed(accountId, {
        item,
        file: privateFile(accountId),
        target: priv,
        closed: dropped.closed,
        opts,
        home: dmHomeOf(String(accountId)),
        isPrivate: true,
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
      accountId: string,
      delta: number,
      reason: string,
      opts?: StoredRecord
    ): { score: number; reason: string; history: Array<object> } {
      const item = privateEntry(accountId);
      const current = item.value.affinity;
      const next = applyDeltaWithIds(current, delta, reason, opts);
      item.value.affinity = next;
      item.dirty = true;
      holdMoves(accountId, item, privateFile(accountId), current, next, true);
      return next;
    },

    /**
     * Append episodes to a member's private layer via
     * src/memory/episodes.ts#mergeEpisodes (same `opts` as `addEpisodes`).
     * Creates the file. Returns how many were added.
     */
    addPrivateEpisodes(accountId: string, incoming: unknown, opts?: Untyped): number {
      const item = privateEntry(accountId);
      return mergeEpisodesInto(item, incoming, opts, { accountId, layer: 'private' }).added;
    },

    /**
     * Stamp a successful private update on a member's private layer:
     * `lastSeen` always, `firstSeen` only while it is empty (ISO strings,
     * like a public profile's). The public profile is never touched.
     * Creates the file.
     * @param nowMs  Epoch milliseconds.
     */
    touchPrivateSeen(accountId: string, nowMs: number) {
      const item = privateEntry(accountId);
      const iso = new Date(nowMs).toISOString();
      if (!item.value.firstSeen) item.value.firstSeen = iso;
      item.value.lastSeen = iso;
      item.dirty = true;
    },

    /**
     * Ids of every member with a private layer in a place, cached or on disk.
     */
    listPrivate(): Array<string> {
      return idsUnder(privateDir());
    },

    /** How many member profiles a place has, cached or on disk (a profile not flushed yet included). */
    countUsers() {
      return idsUnder(usersDir()).length;
    },

    /**
     * Every member profile stored for a place, cached or on disk -- the pool
     * a turn scans to pull a silent member into `<people>` by name/alias (see
     * src/behavior/prompt.js and docs/prompt-contract.md, "Aliases").
     * Same normalize-on-read guarantee as `getUser`.
     */
    listUserProfiles(): Array<StoredRecord> {
      return idsUnder(usersDir())
        .map((id) => store.getUser(id))
        .filter((profile): profile is StoredRecord => profile !== null);
    },

    /**
     * The place's memory (the place's the place's notes), the empty default
     * when nothing is stored. `learned` is normalised on read (see
     * `normalizePlace` above) -- persisted the next time anything writes the
     * place, never wiped implicitly.
     */
    getPlace(placeId: string): StoredRecord {
      const item = entry(placeFile(placeId), emptyPlace);
      normalizePlace(item.value);
      return item.value;
    },

    /**
     * Merge fields into the place's memory and stamp `updatedAt` -- only when
     * something stored actually changes: an identical re-send is left alone. `learned`/
     * `learnedNextId` are never taken from here -- they only ever change
     * through `applyLearnedOps`, which merges incrementally instead of
     * overwriting wholesale (mirrors `updateUser`); `emojiUsage` likewise
     * only through `recordEmojiUsage`/`clearEmojiUsage`, `emojiBackfill` only
     * through `setEmojiBackfill`, `pings` (and the earlier `pingsOff`) only through `setPings`. `notesUpdatedAt` gets the
     * same stamp when one of the server notes (`patterns`, `starters`,
     * `injokes`) really changes; `self` alone never moves it, and neither does
     * `applyLearnedOps`, so it tells how old the notes are. A changed `patterns`/`starters` keeps its previous
     * text (`recordVersion`; `opts.by`, `opts.versions`). The return stays the stored place, so what
     * a write of `injokes` or `self` takes out of the stored list (by
     * src/memory/interests.ts#normalizeTopic) is handed to `opts.onDropped` instead, as
     * `{ injokes, self }` lists of `{ itemId, text }` (`ij-`/`sf-`, minted here, see
     * `ITEM_ID_PREFIX`), called once per write. `patterns`, `starters` and every in-joke and self
     * fact lose their links first (`withoutLinks`): a text that was only links is not written.
     */
    updatePlace(placeId: string, fields: Untyped, opts: UpdatePlaceOptions = {}): StoredRecord {
      const item = entry(placeFile(placeId), emptyPlace);
      normalizePlace(item.value);
      const { learned, learnedNextId, emojiUsage, emojiBackfill, pings, notesUpdatedAt, notesCheckedAt, ...given } =
        fields ?? {};
      // The earlier switch's list would read as `off` at the next load.
      delete given.pingsOff;
      const safeFields = withoutLinks(given, PLACE_TEXT);
      if (!changesStored(item.value, safeFields)) return item.value;
      const notes = Object.fromEntries(Object.entries(safeFields).filter(([key]) => NOTES_FIELDS.includes(key)));
      const stamp = new Date().toISOString();
      const stamps = changesStored(item.value, notes)
        ? { updatedAt: stamp, notesUpdatedAt: stamp }
        : { updatedAt: stamp };
      for (const key of PLACE_PROSE) {
        if (key in safeFields) recordVersion(placeId, 'place', 'place', key, item.value[key], safeFields[key], opts);
      }
      // The in-jokes (and a single-stage self list) are replaced whole: what the new list no longer
      // holds leaves the place here.
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
        holdVictims({
          item,
          file: placeFile(placeId),
          path: [field],
          strings: true,
          previous: previous[field],
          victims: dropped[field],
          itemKind,
          scope: { place: placeId },
          eventOf: () => 'replaced',
        });
      }
      return item.value;
    },

    /** Whether `accountId` turned the persona's notifications off in this place (state `off`). */
    isPingsOff(placeId: string, accountId: string): boolean {
      return store.getPings(placeId, accountId) === 'off';
    },

    /** The ping state `accountId` chose in this place: `on`, `off`, or null when they never chose (the interface's switch decides). */
    getPings(placeId: string, accountId: string): PingState {
      return pingStateOf(store.getPlace(placeId)?.pings, accountId);
    },

    /**
     * Set the ping state of `accountId` in the place: `on`, `off`, or null to clear it. A change is written at once (a
     * member's own switch, allowed while paused, when the next flush could otherwise land on a hand-edited file or be
     * dropped with the caches); no change writes nothing. Nothing else is touched, never `updatedAt`.
     * @returns The state now.
     */
    setPings(placeId: string, accountId: string, state: PingState): PingState {
      const item = entry(placeFile(placeId), emptyPlace);
      normalizePlace(item.value);
      const place = item.value;
      if (!isRecord(place)) return null;
      const { pings, changed } = withPingState(place.pings, accountId, state);
      if (changed) {
        place.pings = pings;
        item.dirty = true;
      }
      // Written at once: the place unit goes to the database now, not at the next flush.
      cache.writeNow(placeFile(placeId), item);
      return pingStateOf(place.pings, accountId);
    },

    /**
     * Stamp `notesFlaggedAt` (when the analyzer flagged the notes stale) on the listed channels
     * that exist and on the place; dirty only when the value changes, nothing is created.
     * @param nowMs  Epoch milliseconds; not a finite number -> the wall clock.
     */
    markNotesFlagged(
      placeId: string,
      targets: { channels?: Array<string>; place?: boolean },
      nowMs: number
    ): { channels: number; place: boolean } {
      const at = new Date(isFiniteNumber(nowMs) ? nowMs : Date.now()).toISOString();
      const marked = { channels: 0, place: false };
      const stamp = (item: Untyped) => {
        if (item.value.notesFlaggedAt === at) return;
        item.value.notesFlaggedAt = at;
        item.dirty = true;
      };

      const listed = Array.isArray(targets?.channels) ? targets.channels : [];
      const channels = new Set(listed.filter((id) => typeof id === 'string' || typeof id === 'number').map(String));
      for (const channel of channels) {
        if (!channel || !hasChannel(channel)) continue;
        const item = channelEntry(channel);
        if (!isRecord(item.value)) continue;
        stamp(item);
        marked.channels += 1;
      }

      if (targets?.place === true) {
        const item = entry(placeFile(placeId), emptyPlace);
        normalizePlace(item.value);
        if (isRecord(item.value)) {
          stamp(item);
          marked.place = true;
        }
      }
      return marked;
    },

    /**
     * Record the outcome of one sample refresh of the notes. `reviewed` sets
     * `notesSampleReviewedAt` and clears `notesAttemptAt`; `attempt` sets `notesAttemptAt` only.
     * A channel that does not exist writes nothing.
     * @param target  `'place'` or a channel id.
     * @param nowMs  Epoch milliseconds; not a finite number -> the wall clock.
     * @returns Whether something was written.
     */
    markNotesSampled(
      placeId: string,
      target: string,
      nowMs: number,
      { outcome }: { outcome: 'reviewed' | 'attempt' }
    ): boolean {
      if (outcome !== 'reviewed' && outcome !== 'attempt') return false;
      const at = new Date(isFiniteNumber(nowMs) ? nowMs : Date.now()).toISOString();
      let item;
      if (target === 'place') {
        item = entry(placeFile(placeId), emptyPlace);
        normalizePlace(item.value);
      } else {
        const channel = typeof target === 'string' || typeof target === 'number' ? String(target) : '';
        if (!channel || !hasChannel(channel)) return false;
        item = channelEntry(channel);
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
     * the place's `emojiUsage` (src/memory/emoji-usage.ts#mergeEmojiUsage:
     * counts accumulate, the lowest-ranked entries past `opts.storeMax` are
     * evicted). Marks the place dirty only when something was counted; never
     * stamps `updatedAt` (a counter, like `touchUser`).
     * @param messages  Slim buffered messages; `self`/`bot`/`ts`/`emojis` read.
     * @returns How many uses were counted.
     */
    recordEmojiUsage(
      placeId: string,
      messages: Array<StoredRecord>,
      opts: { storeMax?: number; halfLifeDays?: number } = {}
    ): number {
      const item = entry(placeFile(placeId), emptyPlace);
      normalizePlace(item.value);
      const { usage, counted } = mergeEmojiUsage(item.value.emojiUsage, messages, opts);
      if (counted > 0) {
        item.value.emojiUsage = usage;
        item.dirty = true;
      }
      return counted;
    },

    /**
     * Empty the place's `emojiUsage` -- only for the emoji history backfill
     * (src/memory/emoji-backfill.ts: its one first run, or the owner's
     * `/nep emoji rescan`), which recounts it from history right after.
     * Nothing else is touched; never stamps `updatedAt`.
     */
    clearEmojiUsage(placeId: string) {
      const item = entry(placeFile(placeId), emptyPlace);
      normalizePlace(item.value);
      item.value.emojiUsage = {};
      item.dirty = true;
    },

    /**
     * Stamp the place's `emojiBackfill` (`{ at, channels, messages }`,
     * normalised like on read) after a history backfill. Never stamps `updatedAt`.
     * @returns The stored stamp.
     */
    setEmojiBackfill(
      placeId: string,
      stamp: { at: string; channels: number; messages: number }
    ): { at: string; channels: number; messages: number } | null {
      const item = entry(placeFile(placeId), emptyPlace);
      normalizePlace(item.value);
      item.value.emojiBackfill = normalizeBackfillStamp(stamp);
      item.dirty = true;
      return item.value.emojiBackfill;
    },

    /**
     * Apply one batch of `learned` ops (`{ add, seen, remove }`, add items a
     * bare string or `{ text, from?, sure? }`) to the place's list of things
     * people taught the persona, via src/memory/details.ts#applyDetailOps --
     * the same confirmation/ranking/eviction mechanics as a member's
     * details, with the place's own `learnedNextId` id counter. Used by the
     * owner commands (src/tools/operations/learning.ts). The limits are the `config.memory` keys of the same name, so
     * a caller can pass `{ ...config.memory, seenAt }` as-is; `seenAt` falls
     * back to the wall clock. Garbage `ops` change nothing and never throw.
     * The place is marked dirty (and `updatedAt` stamped) only when the list
     * or the counter actually changed.
     * @returns The place's `learned` list after the ops (a written list gives every item
     *   an `itemId` when it has none, `ln-`), with the non-enumerable `dropped`: the lessons that
     *   left (removed, evicted), each with one; `[]` when the list did not change.
     */
    applyLearnedOps(
      placeId: string,
      ops: { add?: Array<unknown>; seen?: Array<unknown>; remove?: Array<unknown> },
      opts: LearnedOpsOptions = {}
    ): Array<object> {
      const item = entry(placeFile(placeId), emptyPlace);
      const place = item.value;
      normalizePlace(place);
      if (!ops || typeof ops !== 'object' || Array.isArray(ops)) return place.learned;

      const before = JSON.stringify([place.learned, place.learnedNextId]);
      const previous = place.learned;
      const { items, nextId, dropped } = applyDetailOps(place.learned, ops, {
        maxDetails: opts.maxLearned,
        maxDetailsStored: opts.maxLearnedStored,
        fieldChars: opts.learnedChars,
        halfLifeDays: opts.learnedHalfLifeDays,
        confirmGapHours: opts.confirmGapHours,
        clampTolerance: opts.clampTolerance,
        seenAt: isFiniteNumber(opts.seenAt) ? opts.seenAt : Date.now(),
        nextId: place.learnedNextId,
        // A lesson carries no validity fields.
        validity: false,
      });
      // Compared before the ids are stamped: a call that changes nothing still writes nothing.
      if (JSON.stringify([items, nextId]) !== before) {
        place.learned = withItemIds(items, ITEM_ID_PREFIX.lesson, newId);
        place.learnedNextId = nextId;
        place.updatedAt = new Date().toISOString();
        item.dirty = true;
      }
      const victims = withItemIds(dropped, ITEM_ID_PREFIX.lesson, newId);
      const removing = removeKeysOf(ops.remove);
      const kept = place.learned;
      archiveReplaced({ previous, current: kept, itemKind: 'lesson', scope: { place: placeId }, item });
      holdVictims({
        item,
        file: placeFile(placeId),
        path: ['learned'],
        previous,
        victims,
        itemKind: 'lesson',
        scope: { place: placeId },
        eventOf: (victim) => rankedEvent(victim, 'text', removing, kept, false),
      });
      return attachDropped(place.learned, 'dropped', victims);
    },

    /**
     * One channel's stored entry (the server map), or null when never seen.
     * Normalised on read (see `normalizeChannel` above: the writers tally and
     * the notes check stamp) -- persisted the next time anything writes the
     * entry, never wiped implicitly.
     */
    getChannel(placeId: string): ChannelEntry | null {
      if (!hasChannel(placeId)) return null;
      return channelEntry(placeId).value;
    },

    /** Every channel entry stored for a place, cached or on disk; normalised on read like `getChannel`. */
    listChannels(placeId: string): Array<StoredRecord> {
      return idsUnder(channelsDir())
        .filter((id) => addressing.inViewOf(id, placeId))
        .map((id) => channelEntry(id).value);
    },

    /**
     * Record one observed message in a channel: the platform's facts (name, topic),
     * counters and the per-day activity histogram. Creates the entry.
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
      placeId: string,
      facts: { name?: string; topic?: string | null },
      ts: number = Date.now(),
      authorId: string | null = null,
      opts: { channelWritersStored?: number; channelWritersHalfLifeDays?: number } = {}
    ): object {
      const item = channelEntry(placeId);
      const channel = item.value;
      const { name, topic = null } = facts ?? {};
      if (name) channel.name = name;
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
      placeId: string,
      fields: Untyped,
      opts: { by?: string; versions?: { enabled?: boolean; kept?: number } } = {}
    ): StoredRecord {
      const item = channelEntry(placeId);
      const given: Record<string, Untyped> = {};
      for (const key of CHANNEL_PROSE) {
        if (typeof fields?.[key] === 'string') given[key] = fields[key];
      }
      const patch = withoutLinks(given, CHANNEL_PROSE);
      if (!changesStored(item.value, patch)) return item.value;
      for (const [key, value] of Object.entries(patch))
        recordVersion(null, 'channels', placeId, key, item.value[key], value, opts);
      Object.assign(item.value, patch, { updatedAt: new Date().toISOString() });
      item.dirty = true;
      return item.value;
    },

    /**
     * The describer's cache for one place (src/memory/describe.ts): a plain
     * object map keyed by attachment/embed id, insertion order doubling as
     * LRU recency order. Callers mutate the returned object directly (same
     * pattern as `state.data`) and call `markMediaCacheDirty` afterwards.
     */
    getMediaCache(placeId: string): StoredRecord {
      const file = mediaCacheFile(placeId);
      const value = entry(file, () => ({})).value as StoredRecord;
      seedMedia(placeId, file, value);
      return value;
    },

    /** The attachment ids stored lines and selfreflection posts link: what the media cache's cap leaves alone (src/web/cache.ts#trimCache). */
    linkedMediaKeys(): ReadonlySet<string> {
      return memoryDb ? seam.run(() => linkedAttachmentIds(seam.db())) : new Set<string>();
    },

    getMediaDescription: currentMedia,
    rememberMediaDescription(placeId: string, cacheKey: string, value: MediaDescriptionEntry): void {
      rememberMedia(placeId, cacheKey, value);
    },
    markMediaDescriptionRefreshFailed(placeId: string, cacheKey: string, at: number): void {
      const previous = currentMedia(placeId, cacheKey);
      if (!previous || !cache.writable()) return;
      const key = mediaDescriptionKey(placeId, cacheKey);
      pendingMedia.set(keyText(key), { key, entry: { ...previous, refreshFailedAt: at } });
      cache.lines(key, [{ op: 'refresh-failed', at }]);
    },

    markMediaCacheDirty(placeId: string) {
      const item = cache.cached(mediaCacheFile(placeId));
      if (item) item.dirty = true;
    },

    /**
     * The GIF library, one for every place and interface (src/memory/gifs.ts): `{ nextId, entries, backfill, backfills }`,
     * the empty library when nothing is stored. Normalised on read, persisted the next time anything writes it, never
     * reset implicitly.
     */
    getGifs(): GifLibrary {
      return gifsEntry().value;
    },

    /**
     * The library entry whose handle is `handle` (`g12`), as `{ key, ...entry }`,
     * or null (src/memory/gifs.ts#findGif). Creates nothing on disk.
     */
    findGif(handle: string): ReturnType<typeof findGif> {
      return findGif(gifsEntry().value, handle);
    },

    /**
     * Add the members' GIFs of `messages` to the library (src/memory/gifs.ts#mergeGifs: counts accumulate on the place
     * the message was in, new GIFs get the next handle, the lowest-ranked entries past `opts.storeMax` are evicted).
     * Marks the unit dirty only when something was counted.
     * @param placeId  The place of a message that names none.
     * @param messages  Normalized messages (URLs present); `self`/`bot`/`ts`/`placeId` read.
     * @returns How many uses were counted.
     */
    recordGifs(
      placeId: string,
      messages: Array<StoredRecord>,
      opts: { storeMax?: number; halfLifeDays?: number } = {}
    ): number {
      const item = gifsEntry();
      const placed = messages.map((message) => (message?.placeId ? message : { ...message, placeId }));
      const { gifs, counted } = mergeGifs(item.value, placed, opts);
      if (counted > 0) {
        item.value = gifs;
        item.dirty = true;
      }
      return counted;
    },

    /**
     * Record the persona's own post of the library entry under `key` on the place it went to
     * (src/memory/gifs.ts#markOwnGif), after a turn sent it. Marks the unit dirty only when the entry exists.
     * @param key  The entry's library key (findGif's `key`).
     * @param ts   When it was posted (epoch ms).
     * @returns Whether an entry was stamped.
     */
    recordOwnGif(placeId: string, key: string, ts: number): boolean {
      const item = gifsEntry();
      const { gifs, marked } = markOwnGif(item.value, key, ts, placeId);
      if (marked) {
        item.value = gifs;
        item.dirty = true;
      }
      return marked;
    },

    /**
     * Set this place's counter of every GIF to 0 (src/memory/gifs.ts#resetGifCounts) -- only for the GIF history backfill
     * (src/memory/gif-backfill.ts: its one first run, or the owner's `/nep gifs rescan`), which recounts from history
     * right after. Entries, handles, `nextId`, the stamps and the other places' counters are kept.
     */
    resetGifCounts(placeId: string) {
      const item = gifsEntry();
      item.value = resetGifCounts(item.value, placeId);
      item.dirty = true;
    },

    /**
     * Stamp the history backfill of this place on the library (`{ at, channels, messages }`, normalised like on read).
     * @returns The stored stamp.
     */
    setGifBackfill(
      placeId: string,
      stamp: { at: string; channels: number; messages: number }
    ): { at: string; channels: number; messages: number } | null {
      const item = gifsEntry();
      const library = stampGifBackfill(item.value, placeId, stamp);
      item.value = library;
      item.dirty = true;
      return library.backfills[placeId] ?? null;
    },

    /** The cached file of the entry under `key` (a library key or a native id), which moves it under the content hash. */
    setGifFile(key: string, file: { hash: string; file: string }) {
      const item = gifsEntry();
      item.value = withGifFile(item.value, key, file);
      item.dirty = true;
    },

    /**
     * The describer's caption of the entry under `key` (a library key or a native id). Its vector, when it has one, goes
     * to the `vectors` table by the entry's item id (src/memory/db/gif-vectors.ts), never into the library's JSON.
     */
    setGifCaption(
      key: string,
      { caption, vector, model = null }: { caption: string; vector: ArrayLike<number> | null; model?: string | null }
    ) {
      const item = gifsEntry();
      item.value = withGifCaption(item.value, key, { caption, vector: null });
      item.dirty = true;
      const entries: GifLibrary['entries'] = item.value.entries;
      const entry = Object.entries(entries).find(([held, one]) => held === key || one.nativeIds.includes(key));
      if (!vector || !entry) return;
      const { itemId } = entry[1];
      const values = Array.from(vector);
      heldGifVectors().set(itemId, { model, vector: Float32Array.from(values) });
      if (!canWriteUnits(memoryDb)) return;
      void Promise.resolve(memoryDb.writeUnit({ op: 'gif-vector', itemId, model, vector: values })).catch(
        (error: unknown) => log.warn('store: gif vector write failed', { error })
      );
    },

    /**
     * The roots an interface's hello named, written as their server places through the one writer, with the
     * names the hello says of the interface itself (src/memory/db/roots.ts). A failed write is logged; the next
     * hello writes them again.
     */
    noteRoots(iface: string, roots: ReadonlyArray<{ id: string; name: string }>, names?: InterfaceNames): void {
      if (typeof memoryDb?.memoryWrite !== 'function') return;
      void Promise.resolve(
        memoryDb.memoryWrite({
          kind: 'roots',
          iface,
          roots,
          at: new Date().toISOString(),
          ...(names === undefined ? {} : { names }),
        })
      ).catch((error: unknown) => log.warn('store: roots write failed', { error }));
    },

    /** The caption vectors of the library's entries by item id, those of `model` alone when it is named. */
    getGifVectors(model?: string | null): Map<string, Float32Array> {
      const found = new Map<string, Float32Array>();
      for (const [itemId, held] of heldGifVectors()) {
        if (model === undefined || model === null || held.model === model) found.set(itemId, held.vector);
      }
      return found;
    },

    /** The emoji rails of a place (src/behavior/media-pick.ts), null before its first counted reply. */
    getEmojiRails(placeId: string): unknown {
      return entry(emojiRailsFile(placeId), () => null).value;
    },

    /** The emoji rails of a place, kept as given. */
    setEmojiRails(placeId: string, rails: unknown) {
      const item = entry(emojiRailsFile(placeId), () => null);
      item.value = rails;
      item.dirty = true;
    },

    /**
     * The version history of one prose owner (data/places/<id>/versions/<kind>/<id>.json, see
     * `recordVersion`): `{ [field]: [{ at, by, chars, before, after, kept, removed, added, text }] }`,
     * newest last; `{}` when none or for an unknown kind. A lore `id` is the entry's title (matched
     * trimmed and case-insensitively, as the lorebook matches titles). A copy: changing it changes
     * nothing stored.
     * @param id  A member id, a channel id, `'place'`, or a lore title.
     */
    listVersions(placeId: string, kind: 'users' | 'channels' | 'place' | 'lore', id: string): object {
      if (!VERSION_KINDS.includes(kind)) return {};
      return structuredClone(versionsEntry(placeId, kind, id).value);
    },

    /** Every stored lorebook entry of a place (the place's lore.json). Never auto-created empty on disk. */
    getLore(placeId: string): Array<StoredRecord> {
      return entry(loreFile(placeId), () => []).value;
    },

    /**
     * Merge `incoming` entries into the place's lorebook via
     * src/memory/lore.ts#upsertLore: an analyzer update never touches an
     * owner entry, an owner write always wins. Returns how many were
     * inserted or actually changed (an identical analyzer re-send is neither).
     * An entry whose text changed keeps its previous text (`recordVersion`, kind `lore`, id
     * the title; `opts.by`, `opts.versions`).
     */
    setLore(placeId: string, incoming: Untyped, opts: SetLoreOptions) {
      const item = entry(loreFile(placeId), () => []);
      const { entries: nextEntries, upserted, changes } = upsertLore(item.value, incoming, opts);
      if (upserted > 0) {
        for (const change of changes)
          recordVersion(placeId, 'lore', change.title, 'text', change.previousText, change.nextText, opts);
        item.value = nextEntries;
        item.dirty = true;
      }
      return upserted;
    },

    /** Delete one lorebook entry by id. Returns whether anything was removed. */
    removeLore(placeId: string, id: string) {
      const item = entry(loreFile(placeId), () => []);
      const before = item.value.length;
      item.value = item.value.filter((lore: Untyped) => lore.id !== id);
      const removed = item.value.length !== before;
      if (removed) item.dirty = true;
      return removed;
    },

    // ---- the selfreflection: the persona's own posts in its selfreflection channel (src/behavior/selfreflection.ts) ----

    /**
     * A copy of the place's selfreflection (the persona's selfreflection unit): `{ posts, updatedAt }`, posts newest last; the empty
     * selfreflection (`{ posts: [], updatedAt: 0 }`) when there is no file, never null. Reading never creates the file. A post
     * whose entry links a described picture carries its description as `pictureDescription`.
     */
    getSelfreflection(): SelfreflectionCopy {
      // selfreflectionEntry() replaces a value that is not `{ posts: [...] }` with the empty selfreflection.
      const copy = structuredClone(selfreflectionEntry().value) as SelfreflectionCopy;
      const ids = copy.posts.flatMap((post) => (post.itemId ? [post.itemId] : []));
      const described = memoryDb && ids.length > 0 ? seam.run(() => entryPictureDescriptions(seam.db(), ids)) : null;
      for (const post of copy.posts) {
        const description = post.itemId ? described?.get(post.itemId) : undefined;
        if (description) post.pictureDescription = description;
        else delete post.pictureDescription;
      }
      return copy;
    },

    /**
     * Append one post to the place's selfreflection, keep the newest `max` (selfreflection.historyPosts), stamp `updatedAt` with `now`.
     * @param post  `pictures`: a set's count
     *   (`picture` its first scene); `text`: the entry in full; `itemId`: the entry's id.
     * @returns The posts that fell past `max` (see `writeSelfreflection`).
     */
    appendSelfreflectionPost(
      post: SelfreflectionPostOptions,
      opts: { max?: number; now?: number } = {}
    ): { dropped: Array<object> } {
      const done = writeSelfreflection([...selfreflectionEntry().value.posts, structuredClone(post)], opts);
      // The post goes to the database at once; a failed write waits in the outbox, past a shutdown in `memory-pending/`.
      cache.writeNow(selfreflectionFile(), selfreflectionEntry());
      return done;
    },

    /**
     * Replace the place's post list (the backfill, run only on an empty selfreflection, posts oldest first), keeping the newest
     * `max` (selfreflection.historyPosts), stamping `updatedAt` with `now`; returns the posts that fell past `max` (`writeSelfreflection`).
     * @param posts @param [opts]
     */
    setSelfreflectionPosts(posts: Array<StoredRecord>, opts: { max?: number; now?: number } = {}) {
      return writeSelfreflection(Array.isArray(posts) ? structuredClone(posts) : [], opts);
    },

    /** `read(db)` on the memory database's read connection, null without one (src/behavior/mirror.ts reads its mirrors).
     * @template T @param read */
    readMemory<TResult>(read: (db: Untyped) => TResult): TResult | null {
      return memoryDb ? seam.run(() => read(seam.db())) : null;
    },

    // ---- the recent store: short dated lines about the last days (src/memory/recent.ts) ----

    /**
     * A copy of the place's recent store (the place's recent.json): `{ nextId, lines }`, the
     * empty store when there is no file. Normalised on read (src/memory/recent.ts#normalizeRecent),
     * persisted only by the next change; reading never creates the file and never expires a line
     * (src/memory/recent.ts#liveRecent is the view by time). Changing the copy changes nothing
     * stored: a change goes through `applyRecentOps`.
     */
    getRecent(placeId: string): {
      nextId: number;
      lines: Array<{
        id: number;
        at: number;
        addedAt: string | null;
        placeId: string;
        text: string;
        who: Array<string>;
        weight: number;
      }>;
    } {
      return structuredClone(recentEntry(placeId).value);
    },

    /**
     * One write of the place's recent store, synchronous: expiry, the removes by id, then the new
     * lines with dedupe and both caps (src/memory/recent.ts#mergeRecent, which documents every
     * option and count). Marked dirty only when a stored line was added, removed, expired or
     * evicted, so a call that changes nothing creates or rewrites no file. The settings are the
     * caller's, read at the moment of use (src/memory/recent.ts#recentSettings); a lowered `hours`
     * expires the older lines here, at the first write after the change.
     * @param incoming  `{ text, at, placeId, weight }` items, untrusted.
     *   `dropped` is the sum of the five reasons after it. A written store gives every line an
     *   `itemId` when it has none (`rc-`); the non-enumerable `droppedLines` holds the stored lines
     *   that left (expired, removed, evicted), each with one.
     */
    applyRecentOps(
      placeId: string,
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
      const item = recentEntry(placeId);
      const previous = item.value.lines;
      const { value, droppedLines, ...counts } = mergeRecent(item.value, incoming, opts);
      const victims = withItemIds(droppedLines, ITEM_ID_PREFIX.recent, newId);
      if (counts.added + counts.removed + counts.expired + counts.evicted > 0) {
        item.value = { ...value, lines: withItemIds(value.lines, ITEM_ID_PREFIX.recent, newId) };
        item.dirty = true;
        // droppedLines: the expired, then the removed, then the evicted.
        holdVictims({
          item,
          file: recentFile(placeId),
          path: ['lines'],
          previous,
          victims,
          itemKind: 'recent',
          scope: (line: Untyped) =>
            typeof line.placeId === 'string' && line.placeId ? { channel: line.placeId } : { place: placeId },
          eventOf: (_, index) =>
            index < counts.expired ? 'expired' : index < counts.expired + counts.removed ? 'replaced' : 'evicted',
        });
      }
      return attachDropped(counts, 'droppedLines', victims);
    },

    // ---- the participation store: the persona's exchanges on the channels (src/memory/participation.ts) ----

    /**
     * A copy of the place's participation store (the place's participation.json):
     * `{ episodes, nextId }`, the empty store when there is no file. Normalised on read
     * (src/memory/participation.ts#normalizeParticipation), persisted only by the next change;
     * reading never creates the file and never expires an episode. Changing the copy changes
     * nothing stored: a change goes through `setParticipation`.
     */
    getParticipation(placeId: string): { episodes: Array<object>; nextId: number } {
      return structuredClone(participationEntry(placeId).value);
    },

    /**
     * Store `state` (the result of src/memory/participation.ts#recordOwnLine / #recordFollowing
     * on a `getParticipation` copy) as the place's participation store, after expiry
     * (src/memory/participation.ts#expireEpisodes: past `hours`, then over `maxStored`), and mark
     * it dirty. The settings are the caller's, read at the moment of use
     * (src/memory/participation.ts#participationSettings); missing ones read as the defaults, a
     * missing `now` as the wall clock.
     * @returns Every stored episode gets an `itemId` when it has none
     *   (`pt-`); `dropped`: the episodes the expiry removed, each with one.
     */
    setParticipation(
      placeId: string,
      state: unknown,
      { settings, now }: { settings?: Untyped; now?: number } = {}
    ): { dropped: Array<object> } {
      const item = participationEntry(placeId);
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
      holdVictims({
        item,
        file: participationFile(placeId),
        path: ['episodes'],
        previous,
        victims,
        itemKind: 'participation',
        scope: (episode: Untyped) =>
          typeof episode.placeId === 'string' && episode.placeId ? { channel: episode.placeId } : { place: placeId },
        eventOf: (episode) => (episode.lastOwnAt < at - hours * HOUR_MS ? 'expired' : 'evicted'),
      });
      return { dropped: victims };
    },

    /**
     * With a database, queue the trace through its writer under a semantic key. The file path below is only
     * the standalone backend.
     * Append one recall run's record (src/behavior/recall-run.js, `features.recallTrace`)
     * as one JSON line to data/places/<id>/recall-trace.jsonl, written at once (not
     * through the cache). The file keeps the newest `maxLines` lines (a missing or unusable
     * value: 500): while there is room the line is appended, past the cap the file is
     * rewritten atomically without the oldest. Lines a hand edit left blank are dropped on
     * that rewrite. Throws on an I/O failure (the caller logs it).
     */
    appendRecallTrace(placeId: string, record: StoredRecord, { maxLines }: { maxLines?: number } = {}) {
      const cap = isFiniteNumber(maxLines) && maxLines >= 1 ? Math.floor(maxLines) : RECALL_TRACE_MAX_LINES;
      if (memoryDb) {
        const line = { record: JSON.parse(JSON.stringify(record)) as StoredRecord, maxLines: cap };
        if (!cache.lines(placeCollection('recall_trace', placeId), [line]))
          throw Object.assign(new Error('Memory writer unavailable'), { code: 'DB_CLOSED' });
        cache.push();
        return;
      }
      const file = path.join(root.placeDir(placeId), 'recall-trace.jsonl');
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
      const heldFiles = () => cache.held();
      if (heldFiles() > 0) {
        const waitMs = isFiniteNumber(holdMaxMs) && holdMaxMs >= 0 ? holdMaxMs : DEFAULT_HOLD_MAX_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(resolve, waitMs);
        });
        const settled = (async () => {
          for (const state of [archiveState]) {
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
      if (cache.writable()) {
        counts.waiting = await cache.settle();
        for (const [text, pending] of pendingMedia) if (!cache.holds(pending.key)) pendingMedia.delete(text);
        if (final) counts.pending = cache.keep();
      }
      return counts;
    },

    // ---- the archive (see "The archive" at the top of createStore) ----

    /**
     * The place's archive sequence now: take one before and one after a group of synchronous
     * writes and `settleArchive` reports on the entries those writes queued.
     */
    archiveMark(): number {
      return archiveState.seq;
    },

    /**
     * Wait for the background appends of the entries queued after mark `from` up to mark `to`
     * (every one queued so far when omitted) and report them once: `archived` the confirmed ones,
     * `deferred` how many went to the archive's pending queue instead (their items stay hot until
     * the drain archives them). An entry reported here is not reported again.
     */
    async settleArchive({ from = 0, to = Infinity }: { from?: number; to?: number } = {}): Promise<{
      archived: Array<{ itemId: string; revisionId: string; itemKind: string; event: string }>;
      deferred: number;
    }> {
      const state = archiveState;
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
    async drainArchive(): Promise<{ archived: number; left: number }> {
      if (!archive) return { archived: 0, left: 0 };
      const state = archiveState;
      if (state.retry.length > 0) {
        const retry = state.retry.splice(0);
        for (const { group, status } of await appendQueued(retry)) {
          if (status === 'archived') for (const item of group) confirmHeld(state, item.entry);
        }
      }
      const result = (await archive.drainPending()) ?? {};
      for (const entry of Array.isArray(result.confirmed) ? result.confirmed : []) confirmHeld(state, entry);
      trimArchived();
      return { archived: Number(result.archived) || 0, left: Number(result.left) || 0 };
    },

    /**
     * Take every victim the archive confirmed out of its list now (it runs by itself after each
     * append and drain). Not while paused, and not for a file the cache does not hold.
     * @returns How many items went.
     */
    trimArchived(): number {
      return trimArchived();
    },

    /**
     * Put an archived item back into its hot list (`/nep memory restore`): the entry's text and
     * stored fields rebuild it under its own `itemId`, appended to the member's or the place's
     * list without any cap (it is not pinned: the next write evicts it again by the usual rules).
     * Its text fields come back without links (`withoutLinks`; a plain-string item that was only
     * links is not restored, `kind`).
     * Kinds: episode, interest, detail, alias (a member's profile, or their private layer for a
     * private entry; no private aliases), lesson, selfFact, injoke, selfreflection (the place). Nothing
     * changes when the item is hot already (`hot`), the member has no profile or private layer
     * (`no-profile`), or the kind cannot go back (`kind`: moves, recent lines, participation
     * episodes and versions belong to their moment).
     * @param entry  An archive entry (src/memory/archive.ts#archiveEntry).
     */
    restoreArchived(
      placeId: string,
      entry: StoredRecord
    ): { restored: boolean; reason?: 'hot' | 'no-profile' | 'kind'; item?: Untyped } {
      const target: Untyped = restoreTarget(placeId, entry);
      if (!target) return { restored: false, reason: 'kind' };
      if (!target.item) return { restored: false, reason: 'no-profile' };
      const where = listAt(target.item.value, target.path);
      if (!where) return { restored: false, reason: 'no-profile' };
      const list = Array.isArray(where.holder[where.key]) ? where.holder[where.key] : [];
      const strings = target.strings === true;
      // An entry archived before links were kept out of memory loses them on the way back.
      const textFields = isRecord(entry.text) ? withoutLinks(structuredClone(entry.text), Object.keys(entry.text)) : {};
      let value;
      if (strings) {
        value = typeof textFields.text === 'string' && textFields.text.trim() ? textFields.text : null;
        if (value === null) return { restored: false, reason: 'kind' };
      } else {
        value = {
          ...(isRecord(entry.stored) ? structuredClone(entry.stored) : {}),
          ...textFields,
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

    ...addressing.methods(),

    /**
     * Drop every cached file EXCEPT `state.json` (`/nep pause`): called
     * right after a flush, so nothing stale can be written from memory while
     * the owner hand-edits files under `data/` -- the next read of any
     * profile/place/channel/lore/media/buffer lazily re-populates from disk,
     * exactly like a fresh process. `state.json` itself is left cached (it
     * carries the `paused` flag this feature relies on); see `reloadState`
     * below for forcing a fresh read of it too, used by `/nep resume`.
     * @returns how many cache entries were dropped
     */
    dropCaches(): number {
      return cache.drop(stateFile);
    },

    /**
     * Read the persisted state into the existing public state handle (`/nep resume`).
     * Any unflushed in-memory change is discarded. The supplied database is authoritative.
     */
    reloadState() {
      cache.reload(stateFile, stateEntry);
    },

    /**
     * Every `*.json` file under this store's `dataDir` that fails to parse
     * (`/nep resume`) -- see `findInvalidJsonFiles` above.
     */
    validate(): Array<string> {
      return findInvalidJsonFiles(dataDir, {
        only: (rel) => operationalJsonPath(rel) || (!memoryDb && isCoreStatePath(rel)),
      });
    },
  };

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
  | 'getPlace'
  | 'updatePlace'
  | 'listUserProfiles'
  | 'listChannels'
  | 'updateChannel'
  | 'getMediaCache'
  | 'getLore'
> & {
  getUser: (...args: Parameters<StoreView['getUser']>) => object | null;
  touchUser: (...args: Parameters<StoreView['touchUser']>) => object;
  updateUser: (...args: Parameters<StoreView['updateUser']>) => object;
  getPlace: (placeId: Untyped) => object;
  updatePlace: (...args: Parameters<StoreView['updatePlace']>) => object;
  listUserProfiles: () => Array<object>;
  listChannels: (placeId: Untyped) => Array<object>;
  updateChannel: (...args: Parameters<StoreView['updateChannel']>) => object;
  getMediaCache: StoreView['getMediaCache'];
  getLore: (placeId: Untyped) => Array<object>;
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
 *   place, lore, recent, versions, the selfreflection) is loaded from it and flushed to its writer through the unit
 *   cache (src/memory/unit-cache.ts), which also reconciles its entries with her session's attitude moves and the
 *   owner's selfreflection fills. Core state, participation, GIFs and media
 *   use the database with their existing unit owners. Other operational files retain their file backend.
 *   A selfreflection post is sent at once (`appendSelfreflectionPost` flushes the selfreflection: its
 *   row and its mirror's `sent` publication). `flushSettled({ final: true })` (the shutdown) waits for the outbox and
 *   keeps what still fails in `memory-pending/` (`memoryDb.keepPending`, replayed by the service at its next open);
 *   `dropCaches` keeps the entries the outbox holds; `validate` (`/nep resume`) checks the operational JSON files.
 *   Without a `memoryDb` (tests, a tool) the memory units live in the cache only: nothing is read or
 *   written for them.
 */
export function createStore(deps: Parameters<typeof buildStore>[0]): Store {
  return buildStore(deps);
}
