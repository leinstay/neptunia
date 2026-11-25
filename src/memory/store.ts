// Persistent memory: the memory database (src/memory/db/service.ts) holds it, this module reads and changes it. It
// survives restarts, hot reloads and prompt edits. Each value is one unit of the database, named by its storage key,
// and the writer of its kind turns it into rows and back; the operational files beside it stay JSON files under
// data/. The turn, the pipeline, the tools, the services and the command line reach memory through `createStore`.
//
// The contract, which tests/src/memory/store.test.ts holds:
//
//   reads      `getUser`, `getPrivate`, `getPlace`, `getChannel`, `listChannels`, `listUserProfiles`, `countUsers`,
//              `getLore`, `getRecent`, `getParticipation`, `getDiary` and the media, GIF, name and rule reads.
//              A read normalises the stored value (a hand edit or an older engine may have broken it), creates no
//              unit and marks nothing dirty; a broken recent or participation unit is logged once, as a count. A
//              copy (`getRecent`, `getParticipation`, `getDiary`) changes nothing stored.
//   writes     `touchUser`, `recordAddressUses`, `setAvatar`, `decayAffinities`, `touchChannel`, the emoji usage of
//              a place, `setLore`, `removeLore`, `appendDiaryPost`, `setDiaryPosts`, `setParticipation`, the emoji
//              rails, the GIF library, the describer's cache and the state. A write changes the value in use and
//              marks it dirty only when something changed; at the end of its tick `flush` sends the unit's whole
//              value to the writer (src/memory/store-writes.ts), and `flushSettled` waits until the database took
//              it. A diary post is sent at once. A recall trace line and the roots and place addresses an interface
//              names go straight to the writer.
//   linking    an account linked to a person reads and writes the person's profile, with its own names, address
//              and avatar; a person with two accounts cools once in `decayAffinities`.
//   pause      `dropCaches` takes every value out of use but the state, `reloadState` reads the state again, and
//              `validate` names the operational JSON files a hand edit broke.
//
// Nothing here forgets a member: there is no forget, purge or wipe. `removeLore` takes one lorebook entry out on
// the owner's word (`/nep lore remove`). The recent store is read here and written by no caller of the store.
//
// The participation store expires on every `setParticipation` (src/memory/participation.ts#expireEpisodes:
// `participation.hours`, then `participation.maxStored`), never on a read. The diary keeps its newest
// `diary.historyPosts` posts, and a lorebook entry its newest 20 previous texts.
//
// With the archive on (src/memory/archive.ts, `features.archive`), whatever one of these caps or expiries takes out
// of a list stays in it, over the cap, until the archive confirms its copy; only then is the removal finished. So no
// unit here loses an item before the archive holds it (see "The archive" inside createStore). `restoreArchived` puts
// an archived item back on the owner's word (`/nep memory restore`).

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { accountCollection, personaKey, placeCollection } from './db/unit-keys.ts';
import type { UnitKind, UnitSelector } from './db/unit-keys.ts';
import type { MediaDescriptionEntry } from './db/media-store.ts';
import { createStoreMedia } from './store-media.ts';
import { createStoreGifs } from './store-gifs.ts';
import { createStoreMediaNames } from './store-media-names.ts';
import { createStoreRules } from './store-rules.ts';
import type { InterfaceNames } from './db/roots.ts';

import { linkedProfileUnit } from './db/person-links.ts';
import { profileOfAccount } from './db/meta-person.ts';

import { isRecord, propOf, isFiniteNumber, readSeamOf } from './types.ts';
import { log } from '../log.ts';
import { HOUR_MS, utcDay } from '../time.ts';
import { emptyAffinity, decayAffinity } from './affinity.ts';
import { loreVersionKey, upsertLore } from './lore.ts';
import { sentenceDiff } from './prose.ts';
import { normalizeInterests, normalizeTopic, validDay } from './interests.ts';
import { normalizeDetails } from './details.ts';
import { applyAddressUses, normalizeAddressedAs } from './addressed.ts';
import { stripUrls } from './clamp.ts';
import { sortRanked } from './ranking.ts';
import { mergeEmojiUsage, normalizeEmojiUsage } from './emoji-usage.ts';
import {
  findGif,
  markOwnGif,
  mergeGifs,
  stampGifBackfill,
  withGifDescription,
  captionOfCached,
  withGifFile,
  normalizeBackfillStamp,
  resetGifCounts,
} from './gifs.ts';
import type { GifLibrary } from './gifs.ts';
import { gifMediaVectors } from './db/gif-library.ts';
import { emptyRecent, normalizeRecent } from './recent.ts';
import { PARTICIPATION_DEFAULTS, emptyParticipation, expireEpisodes, normalizeParticipation } from './participation.ts';
import type { ParticipationSettings } from './participation.ts';
import { ITEM_ID_PREFIX, archiveEntry, archiveRevision } from './archive.ts';
import { normalizeAvatar } from './avatars.ts';
import { memoryRootOf } from './root.ts';
import { createAddressing } from './store-addresses.ts';

import { createStoreWrites } from './store-writes.ts';
import type { StoreItem } from './store-writes.ts';
import type { StoredRecord, MemoryDb, Untyped } from './types.ts';
import type { Track } from '../loop-watch.ts';
import { untracked } from '../loop-watch.ts';

const DIARY_HISTORY_POSTS = 150; // diary.historyPosts

/** How many previous texts of one lorebook entry its version history keeps, oldest dropped first. */
const LORE_VERSIONS_KEPT = 20;

/** The kinds a profile's `closed` list holds. */
const CLOSED_KINDS = ['interest', 'detail', 'alias', 'realName'];

/** The value of a unit nobody stored that holds an object: the state, a version history, a private layer. */
const emptyRecord = (): StoredRecord => ({});
/** The value of a unit nobody stored that holds a list: a lorebook. */
const emptyList = (): Array<StoredRecord> => [];
/** The value of a unit nobody stored that holds anything: the emoji rails. */
const noValue = (): unknown => null;

/** The diary of a place with no post yet (the persona's diary unit). */
const emptyDiary = () => ({ posts: [], updatedAt: 0 });

/** Whether `item` already carries an `itemId` (a non-empty string). */
function hasItemId(item: Untyped) {
  return typeof item?.itemId === 'string' && item.itemId !== '';
}

/**
 * `list` with an `itemId` (`prefix` + `newId()`) on every object item that has none; an item that
 * has one keeps it and stays the same object, anything that is not an object passes through. Pure
 * apart from `newId`.
 * @param prefix  One of `ITEM_ID_PREFIX`.
 */
function withItemIds(list: Array<unknown>, prefix: string, newId: () => string): Array<Untyped> {
  return list.map((item) => (isRecord(item) && !hasItemId(item) ? { ...item, itemId: `${prefix}${newId()}` } : item));
}

/**
 * The list a held archive victim lives in: the `field` of `value`, `[]` when a hand edit in a pause left no list
 * there. Every unit a victim is held in reads back as an object (the writers of src/memory/db/ store nothing else).
 */
function listAt(value: StoredRecord, field: string): Array<Untyped> {
  return Array.isArray(value[field]) ? value[field] : [];
}

/** How a held victim is found in its list: an object by its `itemId`, a plain string by its normalized text. */
function identOf(strings: Untyped, item: Untyped) {
  if (strings) return normalizeTopic(typeof item === 'string' ? item : item?.text);
  return typeof item?.itemId === 'string' && item.itemId ? item.itemId : null;
}

/** An item without its `itemId`, as JSON: tells a stored item from its stamped copy. */
function anchorKey(item: Untyped) {
  if (!isRecord(item)) return JSON.stringify(item);
  const { itemId, ...rest } = item;
  return JSON.stringify(rest);
}

/**
 * `current` (a list after a write) with every one of `victims` it no longer holds put back where
 * it stood in `previous` (before the next item of `previous` that `current` still holds, else after the
 * nearest earlier one it still holds, else first; a victim `previous` never held goes last). Pure.
 * @param victims  Objects with an `itemId`.
 */
function reinsert(previous: Array<unknown>, current: Array<unknown>, victims: Array<StoredRecord>): Array<unknown> {
  const result = [...current];
  const beforeKeys = previous.map((item) => anchorKey(item));
  const sameAs = (a: Untyped, b: Untyped) =>
    anchorKey(a) === anchorKey(b) || (identOf(false, a) !== null && identOf(false, a) === identOf(false, b));
  for (const victim of victims) {
    if (result.some((item) => sameAs(item, victim))) continue;
    const from = beforeKeys.indexOf(anchorKey(victim));
    let at = result.length;
    if (from !== -1) {
      at = -1;
      for (let i = from + 1; i < previous.length && at === -1; i += 1)
        at = result.findIndex((item) => sameAs(item, previous[i]));
      // Nothing after it is left: right after the nearest earlier one still there, else first.
      for (let i = from - 1; i >= 0 && at === -1; i -= 1) {
        const index = result.findIndex((item) => sameAs(item, previous[i]));
        if (index !== -1) at = index + 1;
      }
      if (at === -1) at = 0;
    }
    result.splice(at, 0, victim);
  }
  return result;
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
 * process's operational state, the request dumps and tool lists, the backfill folder and the vault.
 * Paths relative to the data directory. `/nep resume` checks only these (`validate`).
 */
export function operationalJsonPath(rel: string): boolean {
  const name = String(rel).replace(/\\/g, '/');
  // The persona's state, the usage and the metrics, and a place's inner state, missed registry, participation and media
  // caches live in database rows.
  if (/^(?:guilds|places)\/[^/]+\/(?:inner|missed|participation|gifs|media)\.json$/.test(name)) return false;
  if (/^vault\//.test(name)) return true;
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

/** The fallback cap of the recall trace (config.json `recall.traceMaxLines`). */
const RECALL_TRACE_MAX_LINES = 500;

/**
 * A member profile nobody has written to yet: what `touchUser` starts from and what `getUser` heals a hand-edited
 * file towards. `id` is the account's native id, null when no row or name of the store holds one.
 */
function emptyProfile(id: string | null): object {
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
  };
}

function emptyPlace() {
  return {
    patterns: '',
    starters: '',
    injokes: [],
    self: [],
    learned: [], // things people taught the persona: detail-shaped items plus an optional `from` (src/memory/details.ts)
    learnedNextId: 1, // the next id a learned item gets -- never reused, even after a remove
    emojiUsage: {}, // { [emojiId]: { count, last } } -- members' custom emoji uses, see recordEmojiUsage
    emojiBackfill: null, // { at, channels, messages } once src/memory/emoji-backfill.ts has read the history
    updatedAt: null,
    // The notes stamps: ISO times kept as stored, read as never stamped when a hand edit broke them.
    notesUpdatedAt: null,
    notesCheckedAt: null,
    notesFlaggedAt: null,
    notesSampleReviewedAt: null,
    notesAttemptAt: null,
  };
}

/** A stored ISO stamp as it is when it reads as a time, else null (missing, cleared, hand-broken). */
function isoStampOrNull(value: Untyped) {
  return typeof value === 'string' && isFiniteNumber(Date.parse(value)) ? value : null;
}

/** A channel of the server map as the store keeps it: its text notes, its day tally and who writes in it. */
export type ChannelEntry = {
  id: string | null;
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

function emptyChannel(id: string | null): ChannelEntry {
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
    // The notes stamps, kept as stored: `touchChannel` counts and never stamps them.
    updatedAt: null,
    notesCheckedAt: null,
    notesFlaggedAt: null,
    notesSampleReviewedAt: null,
    notesAttemptAt: null,
  };
}

/** Normalize a profile's `interests`/`details`/`aliases` fields in place:
 * stored JSON is untrusted (possibly hand-edited while paused) -- `interests`
 * is validated via src/memory/interests.ts#normalizeInterests, `details` via
 * src/memory/details.ts#normalizeDetails (assigning fresh ids off the
 * profile's own `detailsSeq` counter when needed), `aliases` becomes `[]`
 * when it is not already an array. Never marks anything dirty -- the caller
 * (`getUser`) decides whether this is persisted. */
function normalizeProfile(profile: Untyped) {
  profile.interests = normalizeInterests(profile.interests);

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

/** A profile's or private layer's `closed` list (the claims a later claim closed), in place: absent stays absent (an old file loads unchanged); anything but a
 * list becomes `[]`; an entry that is no object or of no known kind is left out. */
function normalizeClosed(holder: Untyped) {
  if (!('closed' in holder)) return;
  holder.closed = Array.isArray(holder.closed)
    ? holder.closed.filter((item: Untyped) => isRecord(item) && CLOSED_KINDS.includes(item.kind))
    : [];
}

/** Normalize a private file in place: `interests`/`details`/`detailsSeq`
 * exactly as `normalizeProfile`, plus the defaults of a layer nothing was said in yet (an empty relationship, no
 * episodes, an affinity at 0, no sighting and an empty observation buffer) for
 * every field that is missing or of the wrong type (the file is untrusted,
 * possibly hand-edited while paused). Never marks anything dirty -- same
 * contract as `normalizeProfile`. */
function normalizePrivate(priv: Untyped) {
  priv.interests = normalizeInterests(priv.interests);

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
  const { items, nextId } = normalizeDetails(place.learned, place.learnedNextId);
  place.learned = items;
  place.learnedNextId = nextId;
  // Missing or hand-broken -> {} (src/memory/emoji-usage.ts#normalizeEmojiUsage).
  place.emojiUsage = normalizeEmojiUsage(place.emojiUsage);
  // Missing or hand-broken -> null: the history backfill has not run.
  place.emojiBackfill = normalizeBackfillStamp(place.emojiBackfill);
  for (const key of STALE_PLACE_FIELDS) delete place[key];
  // Missing or hand-broken -> null: never stamped.
  place.notesUpdatedAt = isoStampOrNull(place.notesUpdatedAt);
  place.notesCheckedAt = isoStampOrNull(place.notesCheckedAt);
  place.notesFlaggedAt = isoStampOrNull(place.notesFlaggedAt);
  place.notesSampleReviewedAt = isoStampOrNull(place.notesSampleReviewedAt);
  place.notesAttemptAt = isoStampOrNull(place.notesAttemptAt);
}

/**
 * `fields` with the links taken out (`stripUrls`) of every string field. A string that held only links is left out
 * of the copy, so it never blanks a stored text. Every other field is kept as given.
 * @returns A shallow copy.
 */
function withoutLinks(fields: StoredRecord): StoredRecord {
  const out = { ...fields };
  const texts = Object.entries(fields).filter((field): field is [string, string] => typeof field[1] === 'string');
  for (const [key, text] of texts) {
    const cleaned = stripUrls(text);
    if (text.trim() !== '' && cleaned === '') delete out[key];
    else out[key] = cleaned;
  }
  return out;
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
 * count keep their listed order at the next ranking (see `sortRanked`'s tie rule).
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
 * `writers` as `[{ id, count, last }]`, best first (src/memory/ranking.ts#sortRanked: `count` is
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
  // Re-inserted so the writer just counted sits last: an exact rank tie keeps them (see sortRanked).
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
  channel.writers = isRecord(channel.writers)
    ? normalizeWriters(channel.writers)
    : writersFromTop(channel.topWriters, channel.lastMessageAt);
  channel.notesCheckedAt = isoStampOrNull(channel.notesCheckedAt);
  channel.notesFlaggedAt = isoStampOrNull(channel.notesFlaggedAt);
  channel.notesSampleReviewedAt = isoStampOrNull(channel.notesSampleReviewedAt);
  channel.notesAttemptAt = isoStampOrNull(channel.notesAttemptAt);
}

/** A cached profile's value field by field: every stored value here is a profile object. */
const entryRecord = (item: StoreItem): StoredRecord => item.value as StoredRecord;

/** `names` with `name`: first when it is the newest touch, else last when unseen. A list keeps five names. */
function withName(names: unknown, name: string, isNewest: boolean): Array<string> {
  const known: Array<string> = Array.isArray(names) ? names.map(String) : [];
  if (isNewest) return [name, ...known.filter((one) => one !== name)].slice(0, 5);
  return known.includes(name) ? known : [...known, name].slice(0, 5);
}

/** What a linked account reads: the person's profile with the account's own id, names, address and avatar. */
function linkedProfile(person: StoreItem, account: StoreItem | null, id: string): StoredRecord {
  const own = account ? entryRecord(account) : {};
  const profile: StoredRecord = { ...entryRecord(person), id, names: own.names ?? [] };
  for (const field of ['addressedAs', 'avatar']) {
    if (own[field]) profile[field] = own[field];
    else delete profile[field];
  }
  return profile;
}

type StoreDeps = {
  dataDir: string;
  newId?: () => string;
  archive?: Untyped;
  archiveOn?: () => boolean;
  memoryDb: MemoryDb;
  /** The event loop watch's `track` (src/loop-watch.ts); a flush of the cache is a named operation. */
  track?: Track;
};

type SetLoreOptions = {
  source: string;
  /** Who wrote the entry, kept with the previous text a change replaces. */
  by: string;
  now: number;
  maxEntries?: number;
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
  /** What the planner planned: its brief, the seed combinations offered and the 1-based one taken (0 for none). */
  plan?: { brief: string; seeds: Array<Array<string>>; seed: number };
};

/** A copy of the persona's diary unit as `getDiary` returns it. */
type DiaryCopy = {
  posts: Array<DiaryPostOptions & { messageIds: Array<string> }>;
  updatedAt: number;
};

type HoldVictimsInput = {
  item: StoreItem;
  file: string;
  field: string;
  previous: Array<unknown>;
  victims: Array<Untyped>;
  itemKind: string;
  eventOf: (victim: Untyped) => string;
  scope: Record<string, Untyped> | ((victim: Untyped) => Record<string, Untyped>);
};

/** A victim held in its list until the archive confirms its copy (see "The archive" in createStore). */
type HeldVictim = {
  siteKey: string;
  file: string;
  field: string;
  ident: string | null;
  itemId: string;
  revisionId: string;
  itemKind: string;
  confirmed: boolean;
};

// health: allow function-length until 2027-04-01 -- one closure over the memory units, grown only by the typed signatures of its methods
function buildStore({
  dataDir,
  newId = randomUUID,
  archive = null,
  archiveOn = () => Boolean(archive),
  memoryDb,
  track = untracked,
}: StoreDeps) {
  const seam = readSeamOf(memoryDb, log, 'store');
  // The memory units this store reads and writes, and their one way to the writer (src/memory/store-writes.ts).
  const writes = createStoreWrites({ memoryDb, seam });
  const { address, collection, entry } = writes;
  // The describer's cache, one row of `media` per entry (src/memory/store-media.ts).
  const media = createStoreMedia({ memoryDb, seam });
  // The GIF library, one row of `media` per entry (src/memory/store-gifs.ts).
  const gifs = createStoreGifs({ memoryDb, seam });
  // The stable names of custom emoji and stickers, one row of `media_names` each (src/memory/store-media-names.ts).
  const mediaNames = createStoreMediaNames({ memoryDb, seam });
  // The owner's rules, one row of `rules` each (src/memory/store-rules.ts).
  const rules = createStoreRules({ memoryDb, seam, newId });

  // ---- The archive (src/memory/archive.ts): nothing leaves a hot list without a copy ----
  //
  // With an archive injected and `archiveOn()` true, every item a write drops (the cap of the diary, of a lore entry's
  // versions or of the participation store, the expiry of an episode) stays in its list in the value in use, over the
  // cap, and its archive entry is queued. The writers stay synchronous: the queue is appended in the background
  // (`archive.append`), and once the archive confirms an entry `trimArchived` takes the item out of its list. So a
  // flush can only write a value without the item after its copy is in the archive. A refused append sends the
  // entries to the archive's pending queue and the items stay hot; when even that queue refuses them they wait in
  // memory, and the drain (`drainArchive`, on the core's timer) archives and trims them later. A later write that
  // keeps a held item releases it: the newest write's verdict stands.

  const archiveState: {
    queue: Array<StoredRecord>;
    held: Array<HeldVictim>;
    retry: Array<StoredRecord>;
    chain: Promise<void>;
  } = { queue: [], held: [], retry: [], chain: Promise.resolve() };

  /** Whether writes archive their victims now: an archive injected and `archiveOn()` true (read now). */
  function archiving() {
    return Boolean(archive) && archiveOn() === true;
  }

  /** Queue one entry for the background append to the persona's archive. */
  function queueArchiveEntry(entry: StoredRecord) {
    const state = archiveState;
    state.queue.push(entry);
    state.chain = state.chain.then(sendArchiveQueue);
  }

  /** Mark the held victim of `entry` confirmed: the archive holds its copy. */
  function confirmHeld(entry: StoredRecord) {
    for (const held of archiveState.held) {
      if (held.itemId === entry.itemId && held.revisionId === entry.revisionId) held.confirmed = true;
    }
  }

  /**
   * Append `entries` to the archive; refused, they go to the archive's pending queue, and refused there too, they
   * wait in memory for the drain. Whether the archive took them.
   */
  async function appendEntries(entries: Array<StoredRecord>): Promise<boolean> {
    try {
      await archive.append(null, entries);
      return true;
    } catch (error) {
      log.warn('store: archive failed', { entries: entries.length, code: propOf(error, 'code') ?? null });
      try {
        await archive.queuePending(null, entries);
      } catch (queueError) {
        log.warn('store: archive queue failed', { entries: entries.length, code: propOf(queueError, 'code') ?? null });
        archiveState.retry.push(...entries);
      }
      return false;
    }
  }

  async function sendArchiveQueue() {
    const entries = archiveState.queue.splice(0);
    // An earlier link of the chain already sent the entries of this one.
    if (entries.length === 0) return;
    if (await appendEntries(entries)) entries.forEach(confirmHeld);
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
    const siteKey = `${site.file}#${site.field}`;
    // The write just stored the list as an array.
    const current: Array<Untyped> = (site.item.value as StoredRecord)[site.field];
    // A post a hand edit left as no object has no identity to hold it by: it simply goes.
    const victims = site.victims.filter((victim) => identOf(false, victim) !== null);
    const victimIds = new Set(victims.map((victim) => identOf(false, victim)));
    // A victim that this write kept ranks again: released.
    state.held = state.held.filter(
      (held) =>
        held.siteKey !== siteKey ||
        victimIds.has(held.ident) ||
        !current.some((item: Untyped) => identOf(false, item) === held.ident)
    );
    if (victims.length === 0) return;
    for (const victim of victims) {
      const ident = identOf(false, victim);
      const revisionId = archiveRevision(site.itemKind, victim);
      if (state.held.some((held) => held.siteKey === siteKey && held.ident === ident && held.revisionId === revisionId))
        continue;
      const scope = typeof site.scope === 'function' ? site.scope(victim) : site.scope;
      const entry: StoredRecord = archiveEntry(victim, {
        itemKind: site.itemKind,
        event: site.eventOf(victim),
        scope,
        uuid: newId,
      });
      state.held.push({
        siteKey,
        file: site.file,
        field: site.field,
        ident,
        itemId: entry.itemId,
        revisionId,
        itemKind: site.itemKind,
        confirmed: false,
      });
      queueArchiveEntry(entry);
    }
    (site.item.value as StoredRecord)[site.field] = reinsert(site.previous, current, victims);
    site.item.dirty = true;
  }

  /** Take the confirmed victims out of their lists (see "The archive" above). */
  function trimArchived() {
    const state = archiveState;
    // /nep pause: nothing may make the store dirty while paused; the holds wait for the resume.
    if (stateEntry.value.paused) return;
    let trimmed = 0;
    const keep = [];
    for (const held of state.held) {
      if (!held.confirmed) {
        keep.push(held);
        continue;
      }
      // The value as the database or the store's change in use holds it.
      const item = writes.entry(held.file, emptyRecord);
      const list = listAt(item.value, held.field);
      const index = list.findIndex((value: Untyped) => identOf(false, value) === held.ident);
      // Gone already, or changed since it was held: a later write owns it now.
      if (index === -1 || archiveRevision(held.itemKind, list[index]) !== held.revisionId) continue;
      item.value[held.field] = list.filter((_: Untyped, i: number) => i !== index);
      item.dirty = true;
      trimmed += 1;
    }
    state.held = keep;
    if (trimmed > 0) log.info('store: archive trimmed', { trimmed });
  }

  /** The value in use of the profile unit `file` of an account, created empty and normalised. */
  function profileEntry(file: string, accountId: string): StoreItem & { value: StoredRecord } {
    const item = entry(file, () => emptyProfile(addressing.nativeOfRow('accounts', accountId)));
    normalizeProfile(item.value);
    return item;
  }

  /** The value in use of what belongs to the account itself (names, avatar, address), created empty and normalised. */
  function accountEntry(accountId: string): StoreItem & { value: StoredRecord } {
    return profileEntry(accountFile(accountId), accountId);
  }

  /** Where an archived item goes back to (`restoreArchived`): its cache entry (null without the file) and list; null for a kind that cannot. */
  function restoreTarget(placeId: string, archived: Untyped) {
    const isPrivate = archived?.scope?.private === true;
    const accountId =
      typeof archived?.scope?.user === 'string' ? archived.scope.user : partnerOfPlace(archived?.scope?.place);
    const member = (field: string) => {
      if (!accountId) return null;
      if (isPrivate) return { item: hasPrivate(accountId) ? privateEntry(accountId) : null, field, strings: false };
      return { item: store.getUser(accountId) ? writes.inUse(userFile(accountId)) : null, field, strings: false };
    };
    const place = (field: string, strings = false) => {
      const item = entry(placeFile(placeId), emptyPlace);
      normalizePlace(item.value);
      return { item, field, strings };
    };
    switch (archived?.itemKind) {
      case 'episode':
        return member('episodes');
      case 'interest':
        return member('interests');
      case 'detail':
        return member('details');
      case 'alias':
        return isPrivate ? null : member('aliases');
      case 'lesson':
        return place('learned');
      case 'selfFact':
        return place('self', true);
      case 'injoke':
        return place('injokes', true);
      case 'diary':
        return { item: diaryEntry(), field: 'posts', strings: false };
      default:
        return null;
    }
  }

  /** Whether a unit has a value, in use or stored (store-writes.ts#known). */
  const known = (file: string) => writes.known(file);
  const idsUnder = writes.idsUnder;

  /** Every changed value sent to the writer (store-writes.ts#flushAll); how many were written and failed. */
  function flushAll() {
    media.flush();
    gifs.flush();
    mediaNames.flush();
    rules.flush();
    return track('store.flushAll', () => writes.flushAll());
  }

  const addressing = createAddressing({ memoryDb, seam });
  const { partnerOfPlace } = addressing;
  const usersDir = () => collection('user');
  /** The unit of the account itself: its names, its avatar, how it is addressed. */
  const accountFile = (accountId: string) => address(accountCollection('user', accountId));
  /**
   * The unit that holds what describes the member: the account's own, or the profile unit of the person it is linked to.
   * Read at every use, so an unlink takes effect at once. A closed database answers with the account's own unit.
   */
  function userFile(accountId: string): string {
    const own = accountFile(accountId);
    if (!memoryDb.readHandle?.()) return own;
    const unit = seam.run(() => linkedProfileUnit(seam.db(), accountId));
    return unit ? address(unit.key) : own;
  }
  /**
   * `profile` with the person behind the account and every account of that person (meta-person.ts#profileOfAccount),
   * as a copy, so nothing of it reaches the stored unit. As it is for an account with no person or a closed database.
   */
  function withPerson(profile: StoredRecord, accountId: string): StoredRecord {
    if (!memoryDb.readHandle?.()) return profile;
    const person = seam.run(() => profileOfAccount(seam.db(), accountId));
    return person ? { ...profile, personId: person.personId, accounts: person.accounts } : profile;
  }
  const placeFile = (placeId: string) => address(placeCollection('place', placeId));
  const channelsDir = () => collection('channel');
  const channelFile = (placeId: string) => address(placeCollection('channel', placeId));
  const placeUnitFile = (kind: UnitKind, placeId: string) => address(placeCollection(kind, placeId));
  const loreFile = (placeId: string) => placeUnitFile('lore', placeId);
  const emojiRailsFile = (placeId: string) => placeUnitFile('emoji_rails', placeId);
  const privateDir = () => collection('private');
  const privateFile = (accountId: string) => address(accountCollection('private', accountId));
  const recentFile = (placeId: string) => placeUnitFile('recent', placeId);
  const participationFile = (placeId: string) => placeUnitFile('participation', placeId);
  const diaryFile = () => address(personaKey('diary'));
  /** The unit of the previous texts of the lorebook entry titled `title` (matched as the lorebook matches titles). */
  const loreVersionsFile = (placeId: string, title: string) => {
    const selector: UnitSelector = { versionKind: 'lore', itemId: loreVersionKey(title) };
    return address({ ...placeCollection('place', placeId), kind: 'versions', selector });
  };
  const stateFile = address(personaKey('state'));

  const stateEntry = writes.pin(stateFile, emptyRecord);

  /** The value in use of a member's private layer, normalised; the writer stores a layer only as an object
   * (src/memory/db/private-layer.ts). */
  function privateEntry(accountId: string) {
    const item = entry(privateFile(accountId), emptyRecord);
    normalizePrivate(item.value);
    return item;
  }

  /** The value in use of one channel of the server map, created empty when missing, normalised in
   * place (`normalizeChannel`); never marked dirty by reading, so a tally seeded for an old file
   * is written only by the next change. */
  function channelEntry(placeId: string) {
    const item = entry(channelFile(placeId), () => emptyChannel(addressing.nativeOfRow('places', placeId)));
    normalizeChannel(item.value);
    return item;
  }

  /**
   * Keep the previous text of a lorebook entry before `setLore` replaces it: appended to the entry's version unit
   * under `text` as `{ at, by, chars, before, after, kept, removed, added, text, itemId }`, `text` the replaced
   * text, `chars` its length in code points, the counts from src/memory/prose.ts#sentenceDiff(previous, next).
   * Newest last; past `LORE_VERSIONS_KEPT` the oldest leave through the archive. A blank previous text records
   * nothing.
   */
  function recordLoreVersion(placeId: string, title: string, previous: string, next: string, opts: SetLoreOptions) {
    if (!previous.trim()) return;
    const file = loreVersionsFile(placeId, title);
    const item = entry(file, emptyRecord);
    const diff = sentenceDiff(previous, next);
    const chars = [...previous].length;
    const at = new Date(opts.now).toISOString();
    const list = Array.isArray(item.value.text) ? item.value.text : [];
    const all = withItemIds(
      [...list, { at, by: opts.by, chars, ...diff, text: previous }],
      ITEM_ID_PREFIX.version,
      newId
    );
    const kept = all.slice(-LORE_VERSIONS_KEPT);
    item.value.text = kept;
    item.dirty = true;
    holdVictims({
      item,
      file,
      field: 'text',
      previous: list,
      victims: all.slice(0, all.length - kept.length),
      itemKind: 'version',
      eventOf: () => 'evicted',
      scope: { place: placeId },
    });
    log.info('store: version recorded', {
      placeId,
      kind: 'lore',
      field: 'text',
      by: opts.by,
      chars,
      kept: diff.kept,
      removed: diff.removed,
      added: diff.added,
    });
  }

  /** Whether a channel has an entry, in use or stored (no side effects on the cache). */
  function hasChannel(placeId: string) {
    const file = channelFile(placeId);
    return known(file);
  }

  /** Whether a member has a private file, in use or stored (no side effects on the cache). */
  function hasPrivate(accountId: string) {
    const file = privateFile(accountId);
    return known(file);
  }

  /** The value in use of a place's recent store, the empty store when there is no file, normalised
   * in place of the cached value (src/memory/recent.ts#normalizeRecent); never marked dirty by
   * reading, so a healed hand edit is written only by the next change. On the read that loads the
   * file, lines normalising leaves out (a hand edit, a file from another version) are logged as a
   * count, `store: recent lines dropped`, and a value that is not a store (not an object, or
   * `lines` not a list) as `store: recent store replaced`: the next write makes the loss
   * permanent. */
  function recentEntry(placeId: string) {
    const file = recentFile(placeId);
    const loading = !writes.inUse(file);
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

  /** The value in use of a place's participation store, the empty store when there is no file,
   * normalised in place of the value in use (src/memory/participation.ts#normalizeParticipation);
   * never marked dirty by reading. On the read that loads the file, episodes normalising leaves out
   * are logged as a count, `store: participation episodes dropped`, and a value that is not a store
   * (not an object, or `episodes` not a list) as `store: participation store replaced`. */
  function participationEntry(placeId: string) {
    const file = participationFile(placeId);
    const loading = !writes.inUse(file);
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

  /** The value in use of a place's diary, the empty diary when there is no file; a value that is not
   * a diary (not an object, or `posts` not a list) is replaced by the empty one in the cache, and
   * the disk copy is only rewritten by the next change. */
  function diaryEntry() {
    const item = entry(diaryFile(), emptyDiary);
    if (!isRecord(item.value) || !Array.isArray(item.value.posts)) item.value = emptyDiary();
    return item;
  }

  /** Store `posts` (the newest `max`, `diary.historyPosts`) as the place's diary, stamped `now` (else the wall clock), and mark it dirty. Every
   * post gets an `itemId` when it has none (`dy-`); returns `{ dropped }`, the posts that fell past
   * `max`, oldest first, with theirs. */
  function writeDiary(posts: Array<unknown>, { max, now }: { max?: number; now?: number }) {
    const item = diaryEntry();
    const previous = item.value.posts;
    const limit = isFiniteNumber(max) && max > 0 ? Math.floor(max) : DIARY_HISTORY_POSTS;
    const all = withItemIds(posts, ITEM_ID_PREFIX.diary, newId);
    const kept = all.slice(-limit);
    item.value = { posts: kept, updatedAt: isFiniteNumber(now) ? now : Date.now() };
    item.dirty = true;
    const dropped = all.slice(0, all.length - kept.length);
    holdVictims({
      item,
      file: diaryFile(),
      field: 'posts',
      previous,
      victims: dropped,
      itemKind: 'diary',
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
      const item = profileEntry(file, accountId);
      const own = accountFile(accountId);
      if (file === own) return withPerson(item.value, accountId);
      return withPerson(linkedProfile(item, known(own) ? accountEntry(accountId) : null, String(accountId)), accountId);
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
      const item = profileEntry(userFile(accountId), accountId);
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
      const sweep = (item: StoreItem) => {
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
      // Every listed account has a profile: its own unit, or the unit of the person it is linked to.
      for (const accountId of idsUnder(usersDir())) {
        const file = userFile(accountId);
        if (swept.has(file)) continue;
        swept.add(file);
        sweep(profileEntry(file, accountId));
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

    /** How many member profiles a place has, in use or stored (a profile not flushed yet included). */
    countUsers() {
      return idsUnder(usersDir()).length;
    },

    /**
     * Every member profile stored for a place, in use or stored -- the pool
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
     * (src/memory/emoji-backfill.ts, its one first run), which recounts it from history right after.
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
     * One channel's stored entry (the server map), or null when never seen.
     * Normalised on read (see `normalizeChannel` above: the writers tally and
     * the notes check stamp) -- persisted the next time anything writes the
     * entry, never wiped implicitly.
     */
    getChannel(placeId: string): ChannelEntry | null {
      if (!hasChannel(placeId)) return null;
      return channelEntry(placeId).value;
    },

    /** Every channel entry stored for a place, in use or stored; normalised on read like `getChannel`. */
    listChannels(placeId: string): Array<StoredRecord> {
      return idsUnder(channelsDir())
        .filter((id) => addressing.inViewOf(id, placeId))
        .map((id) => channelEntry(id).value);
    },

    /**
     * Record one observed message in a channel: the platform's facts (name, topic),
     * counters and the per-day activity histogram. Creates the entry.
     * `authorId` (the message's author, omitted for the persona's own
     * messages -- see src/memory/update.ts#touchMemory) is
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
      const { name, topic = null } = facts;
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
     * The describer's cache (src/memory/describe.ts, src/web/lookup.ts): the entry under `key` (an attachment, an embed, a
     * `video:`, `emoji:` or `link:` key, a lookup's `page:`, `search:` or `results:` key), read from its row of
     * `media` (src/memory/store-media.ts); undefined when none holds it.
     */
    mediaEntry(placeId: string, key: string): StoredRecord | undefined {
      return media.entry(placeId, key);
    },

    /** The cache's entries under `keys`, each key that holds one; every entry of the place's cache without `keys`. */
    mediaEntries(placeId: string, keys?: Iterable<string>): Record<string, StoredRecord> {
      return media.entries(placeId, keys);
    },

    /** The cache's entry under `key` written to its row: a new one, a touched one (`usedAt`) or a changed one. */
    putMediaEntry(placeId: string, key: string, value: unknown): void {
      media.put(placeId, key, value);
      // The library's entry of the same GIF reads the description its row now holds, as the next load would.
      const described = withGifDescription(gifs.library(), key, captionOfCached(value));
      if (described) gifs.set(described);
    },

    /** The cache's entry under `key` dropped. */
    dropMediaEntry(placeId: string, key: string): void {
      media.drop(placeId, key);
    },

    /** The successful description under `key`, also one the cache's cap took out: what the describer takes up again. */
    getMediaDescription(placeId: string, key: string): MediaDescriptionEntry | null {
      return media.saved(placeId, key);
    },

    /**
     * The GIF library, one for every place and interface (src/memory/gifs.ts): `{ nextId, entries, backfill, backfills }`,
     * the empty library when nothing is stored. Normalised on read, persisted the next time anything writes it, never
     * reset implicitly.
     */
    /** The stable names of custom emoji and stickers (src/memory/store-media-names.ts). */
    nameMedia: mediaNames.nameMedia,
    mediaNameOf: mediaNames.mediaNameOf,
    mediaNameFor: mediaNames.mediaNameFor,
    /** The owner's rules (src/memory/store-rules.ts). */
    liveRules: rules.liveRules,
    addRule: rules.addRule,
    removeRule: rules.removeRule,

    getGifs(): GifLibrary {
      return gifs.library();
    },

    /**
     * The library entry whose handle is `handle` (`g12`), as `{ key, ...entry }`,
     * or null (src/memory/gifs.ts#findGif). Creates nothing on disk.
     */
    findGif(handle: string): ReturnType<typeof findGif> {
      return findGif(gifs.library(), handle);
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
      const placed = messages.map((message) => (message?.placeId ? message : { ...message, placeId }));
      const merged = mergeGifs(gifs.library(), placed, opts);
      if (merged.counted > 0) gifs.set(merged.gifs);
      return merged.counted;
    },

    /**
     * Record the persona's own post of the library entry under `key` on the place it went to
     * (src/memory/gifs.ts#markOwnGif), after a turn sent it. Marks the unit dirty only when the entry exists.
     * @param key  The entry's library key (findGif's `key`).
     * @param ts   When it was posted (epoch ms).
     * @returns Whether an entry was stamped.
     */
    recordOwnGif(placeId: string, key: string, ts: number): boolean {
      const own = markOwnGif(gifs.library(), key, ts, placeId);
      if (own.marked) gifs.set(own.gifs);
      return own.marked;
    },

    /**
     * Set this place's counter of every GIF to 0 (src/memory/gifs.ts#resetGifCounts) -- only for the GIF history backfill
     * (src/memory/gif-backfill.ts, its one first run), which recounts from history right after. Entries, handles, `nextId`, the stamps and the other places' counters are kept.
     */
    resetGifCounts(placeId: string) {
      gifs.set(resetGifCounts(gifs.library(), placeId));
    },

    /**
     * Stamp the history backfill of this place on the library (`{ at, channels, messages }`, normalised like on read).
     * @returns The stored stamp.
     */
    setGifBackfill(
      placeId: string,
      stamp: { at: string; channels: number; messages: number }
    ): { at: string; channels: number; messages: number } | null {
      const library = stampGifBackfill(gifs.library(), placeId, stamp);
      gifs.set(library);
      return library.backfills[placeId] ?? null;
    },

    /** The cached file of the entry under `key` (a library key or a native id), which moves it under the content hash. */
    setGifFile(key: string, file: { hash: string; file: string }) {
      gifs.set(withGifFile(gifs.library(), key, file));
    },

    /**
     * The roots an interface's hello named, written as their server places through the one writer, with the
     * names the hello says of the interface itself (src/memory/db/roots.ts). A failed write is logged; the next
     * hello writes them again.
     */
    noteRoots(
      iface: string,
      roots: ReadonlyArray<{ id: string; name: string; joinedAt?: number }>,
      names?: InterfaceNames
    ): void {
      // The read-only store of a replay has no writer (scripts/lib/turn-wiring.ts).
      if (typeof memoryDb.memoryWrite !== 'function') return;
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

    /**
     * The chat an interface opened for a place that held no address, stored as the place's address through the one
     * writer (src/memory/db/observe.ts#applyPlaceAddress). A failed write is logged; the next read opens the chat again.
     */
    notePlaceAddress(placeId: string, address: string): Promise<unknown> {
      if (typeof memoryDb.memoryWrite !== 'function') return Promise.resolve(null);
      return Promise.resolve(
        memoryDb.memoryWrite({ kind: 'place-address', placeId, address, at: new Date().toISOString() })
      ).catch((error: unknown) => log.warn('store: place address write failed', { error }));
    },

    /**
     * The media vectors of the library's rows by item id (src/memory/db/gif-library.ts), read now: those of `model` or
     * of no recorded model when `model` is named, as recall reads media vectors.
     */
    gifMediaVectors(model: string | null): Map<string, Float32Array> {
      return seam.run(() => gifMediaVectors(seam.db(), model));
    },

    /** The emoji rails of a place (src/behavior/media-pick.ts), null before its first counted reply. */
    getEmojiRails(placeId: string): unknown {
      return entry(emojiRailsFile(placeId), noValue).value;
    },

    /** The emoji rails of a place, kept as given. */
    setEmojiRails(placeId: string, rails: unknown) {
      const item = entry(emojiRailsFile(placeId), noValue);
      item.value = rails;
      item.dirty = true;
    },

    /** Every stored lorebook entry of a place (the place's lore.json). Never auto-created empty on disk. */
    getLore(placeId: string): Array<StoredRecord> {
      return entry(loreFile(placeId), emptyList).value;
    },

    /**
     * Merge `incoming` entries into the place's lorebook via
     * src/memory/lore.ts#upsertLore: an analyzer update never touches an
     * owner entry, an owner write always wins. Returns how many were
     * inserted or actually changed (an identical analyzer re-send is neither).
     * An entry whose text changed keeps its previous text (`recordLoreVersion`, `opts.by`).
     */
    setLore(placeId: string, incoming: Untyped, opts: SetLoreOptions) {
      const item = entry(loreFile(placeId), emptyList);
      const { entries: nextEntries, upserted, changes } = upsertLore(item.value, incoming, opts);
      if (upserted > 0) {
        for (const change of changes)
          recordLoreVersion(placeId, change.title, change.previousText, change.nextText, opts);
        item.value = nextEntries;
        item.dirty = true;
      }
      return upserted;
    },

    /** Delete one lorebook entry by id. Returns whether anything was removed. */
    removeLore(placeId: string, id: string) {
      const item = entry(loreFile(placeId), emptyList);
      const before = item.value.length;
      item.value = item.value.filter((lore: Untyped) => lore.id !== id);
      const removed = item.value.length !== before;
      if (removed) item.dirty = true;
      return removed;
    },

    // ---- the diary: the persona's own posts in its diary channel (src/behavior/diary.ts) ----

    /**
     * A copy of the place's diary (the persona's diary unit): `{ posts, updatedAt }`, posts newest last; the empty
     * diary (`{ posts: [], updatedAt: 0 }`) when there is no file, never null. Reading never creates the file.
     */
    getDiary(): DiaryCopy {
      // diaryEntry() replaces a value that is not `{ posts: [...] }` with the empty diary.
      return structuredClone(diaryEntry().value) as DiaryCopy;
    },

    /**
     * Append one post to the place's diary, keep the newest `max` (diary.historyPosts), stamp `updatedAt` with `now`.
     * @param post  `pictures`: a set's count
     *   (`picture` its first scene); `text`: the entry in full; `itemId`: the entry's id.
     * @returns The posts that fell past `max` (see `writeDiary`).
     */
    appendDiaryPost(post: DiaryPostOptions, opts: { max?: number; now?: number } = {}): { dropped: Array<object> } {
      const done = writeDiary([...diaryEntry().value.posts, structuredClone(post)], opts);
      // The post goes to the database at once; a failed write goes again at the next flush.
      writes.writeNow(diaryFile(), diaryEntry());
      return done;
    },

    /**
     * Replace the place's post list (the backfill, run only on an empty diary, posts oldest first), keeping the newest
     * `max` (diary.historyPosts), stamping `updatedAt` with `now`; returns the posts that fell past `max` (`writeDiary`).
     */
    setDiaryPosts(posts: Array<StoredRecord>, opts: { max?: number; now?: number } = {}) {
      return writeDiary(structuredClone(posts), opts);
    },

    /** `read(db)` on the memory database's read connection (src/behavior/mirror.ts reads its mirrors).
     * @template T @param read */
    readMemory<TResult>(read: (db: Untyped) => TResult): TResult {
      return seam.run(() => read(seam.db()));
    },

    // ---- the recent store: short dated lines about the last days (src/memory/recent.ts) ----

    /**
     * A copy of the place's recent store (the place's recent.json): `{ nextId, lines }`, the
     * empty store when there is no file. Normalised on read (src/memory/recent.ts#normalizeRecent),
     * persisted only by the next change; reading never creates the file and never expires a line
     * (src/memory/recent.ts#liveRecent is the view by time). Changing the copy changes nothing
     * stored.
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
      { settings, now }: { settings?: Partial<ParticipationSettings>; now?: number } = {}
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
        field: 'episodes',
        previous,
        victims,
        itemKind: 'participation',
        // A stored episode always names its channel (src/memory/participation.ts#normalizeParticipation).
        scope: (episode: Untyped) => ({ channel: episode.placeId }),
        eventOf: (episode) => (episode.lastOwnAt < at - hours * HOUR_MS ? 'expired' : 'evicted'),
      });
      return { dropped: victims };
    },

    /**
     * Queue one recall run's record (src/behavior/recall-run.js, `features.recallTrace`) as a line of the place's
     * `recall_trace` unit through the writer, sent at once (not through the cache), with the cap the unit keeps: the
     * newest `maxLines` lines (a missing or unusable value: 500). Throws `DB_CLOSED` when the database has no writer
     * (the caller logs it).
     */
    appendRecallTrace(placeId: string, record: StoredRecord, { maxLines }: { maxLines?: number } = {}) {
      const cap = isFiniteNumber(maxLines) && maxLines >= 1 ? Math.floor(maxLines) : RECALL_TRACE_MAX_LINES;
      const line = { record: JSON.parse(JSON.stringify(record)) as StoredRecord, maxLines: cap };
      if (!writes.lines(placeCollection('recall_trace', placeId), [line]))
        throw Object.assign(new Error('Memory writer unavailable'), { code: 'DB_CLOSED' });
      writes.push();
    },

    /** Send every changed value (store-writes.ts#flushAll). */
    flush(): { written: number; failed: number } {
      return flushAll();
    },

    /**
     * The flush before a shutdown or a pause: writes everything, then waits for the database to take what the flush
     * sent (store-writes.ts#settle) and, with `final` (the shutdown), logs what still fails as lost (`waiting` counts
     * it). With `final` and `timeoutMs` the wait for the writes under way ends after `timeoutMs`, logged as
     * `store: writes still under way at shutdown`.
     */
    async flushSettled({ final = false, timeoutMs }: { final?: boolean; timeoutMs?: number } = {}): Promise<{
      written: number;
      failed: number;
      waiting?: number;
    }> {
      const counts: { written: number; failed: number; waiting?: number } = flushAll();
      const settleOptions = { final, ...(isFiniteNumber(timeoutMs) ? { timeoutMs } : {}) };
      // The units and the describer's cache wait only with a writer; a read-only store sends them nowhere.
      if (writes.writable())
        counts.waiting = (await writes.settle(settleOptions)) + (await media.settle(settleOptions));
      for (const part of [gifs, mediaNames, rules]) {
        const lost = await part.settle(settleOptions);
        if (lost > 0) counts.waiting = (counts.waiting ?? 0) + lost;
      }
      return counts;
    },

    // ---- the archive (see "The archive" at the top of createStore) ----

    /**
     * Archive what waits: the entries neither archived nor queued as pending first, then the
     * archive's pending queue (src/memory/archive.ts#drainPending); every victim now confirmed
     * is trimmed from its list. Runs whether or not features.archive is on (what waits was
     * queued while it was). No archive -> nothing.
     */
    async drainArchive(): Promise<{ archived: number; left: number }> {
      if (!archive) return { archived: 0, left: 0 };
      const retry = archiveState.retry.splice(0);
      if (retry.length > 0 && (await appendEntries(retry))) retry.forEach(confirmHeld);
      const { archived, left, confirmed } = await archive.drainPending();
      confirmed.forEach(confirmHeld);
      trimArchived();
      return { archived, left };
    },

    /**
     * Put an archived item back into its hot list (`/nep memory restore`): the entry's text and
     * stored fields rebuild it under its own `itemId`, appended to the member's or the place's
     * list without any cap (it is not pinned: the next write evicts it again by the usual rules).
     * Its text fields come back without links (`withoutLinks`; a plain-string item that was only
     * links is not restored, `kind`).
     * Kinds: episode, interest, detail, alias (a member's profile, or their private layer for a
     * private entry; no private aliases), lesson, selfFact, injoke, diary (the place). Nothing
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
      const holder: StoredRecord = target.item.value;
      // A list a hand edit or an older engine left out reads as empty.
      const list = Array.isArray(holder[target.field]) ? holder[target.field] : [];
      const strings = target.strings === true;
      // An entry archived before links were kept out of memory loses them on the way back.
      const textFields = isRecord(entry.text) ? withoutLinks(structuredClone(entry.text)) : {};
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
      holder[target.field] = [...list, value];
      target.item.dirty = true;
      return { restored: true, item: value };
    },

    ...addressing.methods(),

    /**
     * Take every value out of use except the persona's state and those whose write is under way (`/nep pause`): called
     * right after a flush, so nothing stale is written from memory while the owner edits the memory, and the next read
     * of a unit takes the stored value like a fresh process. The state stays in use because it carries the `paused`
     * flag; `reloadState` reads it again at `/nep resume`.
     * @returns how many values went out of use
     */
    dropCaches(): number {
      return writes.drop(stateFile);
    },

    /**
     * Read the persisted state into the existing public state handle (`/nep resume`).
     * Any unflushed in-memory change is discarded. The supplied database is authoritative.
     */
    reloadState() {
      writes.reload(stateFile, stateEntry);
    },

    /**
     * Every `*.json` file under this store's `dataDir` that fails to parse
     * (`/nep resume`) -- see `findInvalidJsonFiles` above.
     */
    validate(): Array<string> {
      return findInvalidJsonFiles(dataDir, {
        only: operationalJsonPath,
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
  'getUser' | 'touchUser' | 'getPlace' | 'listUserProfiles' | 'listChannels' | 'getLore'
> & {
  getUser: (...args: Parameters<StoreView['getUser']>) => object | null;
  touchUser: (...args: Parameters<StoreView['touchUser']>) => object;
  getPlace: (placeId: Untyped) => object;
  listUserProfiles: () => Array<object>;
  listChannels: (placeId: Untyped) => Array<object>;
  getLore: (placeId: Untyped) => Array<object>;
};

/**
 * The store over one data directory.
 * @param options  `newId`: the source of the UUID in every new `itemId`
 *   (`ITEM_ID_PREFIX`); node:crypto's `randomUUID` unless a test injects one.
 *   `archive` (src/memory/archive.ts#createArchive, optional): while `archiveOn()` (read at each
 *   write; the core passes features.archive exactly true) nothing leaves a hot list on disk
 *   before its copy is in the archive -- see "The archive" inside and `drainArchive`.
 *   `memoryDb` (the memory database service, required): every memory unit (users, private layers, channels, the
 *   place, lore, recent, versions, the diary, the persona's state, participation, GIFs and media) is read from it and
 *   written to its writer at the end of the tick that changed it (src/memory/store-writes.ts). Other operational
 *   files retain their file backend.
 *   A diary post is sent at once (`appendDiaryPost` flushes the diary: its
 *   row and its mirror's `sent` publication). `flushSettled({ final: true, timeoutMs })` (the shutdown) waits for the
 *   writes under way, at most `timeoutMs`, and logs what still fails as lost;
 *   `dropCaches` keeps the values whose write is under way; `validate` (`/nep resume`) checks the operational JSON files.
 */
export function createStore(deps: Parameters<typeof buildStore>[0]): Store {
  return buildStore(deps);
}
