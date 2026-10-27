// The persona keeps a diary: one owner-chosen channel where it posts on its
// own, rarely and irregularly, the way a person runs a personal feed. This
// module owns the diary's decisions: which local times of a day get a post
// (configured windows in `bot.timezone`, quiet days, a minimum gap, a daily
// cap, and the hunger that empty windows and quiet days carry into later
// ones), which planned slot is due now (a slot missed by more than the grace
// while the bot was down is dropped, never fired late in a burst), which kind
// of post a plan names (validated against the weighted `diary.kinds`, with a
// weighted random fallback; while a post may not carry a picture the picture
// kinds are dropped before the planner sees them), which kinds post a set of
// pictures rather than one (`diary.setKinds`, sized by `diary.set`), and how
// the post history, the kinds and the random seeds are rendered for the plan
// and compose requests. All wording comes from `labels.diary.*`; kind keys
// are config keys.
//
// The decisions are pure: randomness and the clock are injected (`rng`,
// `nowMs`), and none of them touches a platform SDK, the disk or the model. The
// factory at the end (createDiary) is the module's edge: it ticks, keeps the
// day plan in state.json and runs the post through the turn runner.

import { fill } from '../format.js';
import { log } from '../log.js';
import { oneLine, clampText, stripUrls } from '../memory/clamp.js';
import { MINUTE_MS, countToday, zonedDay, zonedEpoch, utcDay } from '../time.js';
import { isFiniteNumber, listOf, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import type { Reads } from '../interface/reads.ts';
import type { createStore } from '../memory/store.js';
import type { ConversationRef } from '../protocol/adapter.ts';
import { historyLines } from './lines.ts';
import { diaryPlaces, readMirrors } from './mirror.ts';

/** A day counter of the store's state (src/time.js#countToday): the key of its day and the key of its count. */
export type Daily = { dayKey: string; countKey: string };

/** The daily counter of diary posts in state.json (src/time.js dailyCounter / bumpDaily). */
export const DIARY_DAILY: Daily = { dayKey: 'diaryDay', countKey: 'diaryPosts' };
/** The daily counter of diary pictures in state.json (src/time.js dailyCounter / bumpDaily). */
export const DIARY_PICTURES_DAILY: Daily = { dayKey: 'diaryPicturesDay', countKey: 'diaryPictures' };

/** The diary's plan of one local day, as state.json keeps it (`diary[guildId]`). */
export type DayPlan = {
  day: string;
  slots: Array<number>;
  quiet: boolean;
  done: Array<number>;
  posted: Array<number>;
  hunger: Array<number>;
  quietStreak: number;
};

/** The hunger a day plan starts with (nextHunger): one count per window, and the quiet days in a row. */
export type Carry = { hunger: Array<number>; quietStreak: number };

/** A slot due now (dueSlot) and the slots missed past the grace. */
export type Due = { slot: number | null; dropped: Array<number> };

/** The settings of a set post (setSettings). */
export type SetSettings = {
  pictures: [number, number];
  minPosted: number;
  seedSets: number;
  maxMessageBytes: number;
};

/** The plan request's answer, normalised (validatePlan). */
export type DiaryPlan = { kind: string | null; brief: string; search: string; picture: boolean; fallback: boolean };

/** What createDiary's turns run: one diary turn, the selfreflection wake. */
export type DiaryTurnParams = {
  mode: 'diary';
  diary: { kind: string | null; topic?: string; forced: boolean };
  guildId: string;
};

/** The store as the diary reads it: the state file (its pause and the day plans), her diary and its writes. */
export type DiaryStore = Pick<ReturnType<typeof createStore>, 'state' | 'getDiary' | 'setDiaryPosts' | 'flushSettled'>;

/** The state file's data as the diary reads it (`store.state.data`, untyped in the store). */
function stateData(store: DiaryStore): Obj {
  const data: unknown = store.state.data;
  return objOf(data);
}

/** The day plans of the state file (`diary`), created empty when `create` and missing. */
function plansOf(store: DiaryStore, create: boolean): Record<string, DayPlan | undefined> {
  const data = stateData(store);
  if (create) data.diary ??= {};
  // state.json's `diary` is what currentPlan wrote: one day plan per guild.
  return objOf(data.diary) as Record<string, DayPlan | undefined>;
}

/** One post the backfill writes to diary.json. */
export type BackfillPost = {
  at: number;
  kind: null;
  gist: string;
  picture: unknown;
  messageIds: Array<string>;
  search: null;
};

/** What the backfill is given (backfillDiary). */
export type BackfillArgs = {
  store: DiaryStore;
  reads: Reads;
  conversation: ConversationRef;
  guildId: string;
  config: unknown;
  labels: unknown;
};

/** The diary's day as the owner's status shows it (createDiary's `status`). */
export type DiaryStatus = {
  channelId: string;
  day: string | null;
  slots: Array<number>;
  done: Array<number>;
  quiet: boolean;
  hunger: Array<number>;
  quietStreak: number;
  posts: number;
  pictures: number;
  history: number;
};

/** The diary's scheduler (createDiary). */
export type Diary = {
  tick: () => Promise<void>;
  force: (opts?: { kind?: string | null; topic?: string | null }) => Promise<unknown>;
  status: () => DiaryStatus;
  stop: () => void;
};

/** A section of a record, `{}` when it is not a record. */
const sectionOf = (value: unknown, key: string): Obj => objOf(objOf(value)[key]);
/** A label read from the labels, '' when it is not a string (fill answers '' for it). */
const labelOf = (value: unknown): string => (typeof value === 'string' ? value : '');
/** The diary's words: `labels.diary`. */
const diaryWords = (labels: unknown): Obj => sectionOf(labels, 'diary');

const BRIEF_CHARS = 300;
const TOPIC_CHARS = 1000;
const DEFAULT_GRACE_MINUTES = 30; // diary.slotGraceMinutes
const DEFAULT_MAX_PER_DAY = 12; // diary.maxPerDay
const DEFAULT_QUIET_DAY_CHANCE = 0.3; // diary.quietDayChance
const DEFAULT_QUIET_CARRY = 0.25; // diary.quietCarry
const DEFAULT_HUNGER_BOOST = 0.5; // diary.hungerBoost
const DEFAULT_FORCE_WAIT_MS = 120000; // diary.forceWaitMs
const DEFAULT_HISTORY_POSTS = 150; // diary.historyPosts
const DEFAULT_GIST_CHARS = 200; // diary.gistChars
const DEFAULT_SEARCH_KINDS: Array<string> = ['news', 'facts']; // diary.searchKinds
/** The kinds that mean a picture when `diary.pictureKinds` is not a list. */
export const DEFAULT_PICTURE_KINDS: Array<string> = ['selfPicture', 'picture', 'meme', 'photoset', 'randomSet']; // diary.pictureKinds
/** The kinds whose post is a set of pictures when `diary.setKinds` is not a list. */
export const DEFAULT_SET_KINDS: Array<string> = ['photoset', 'randomSet']; // diary.setKinds
const DEFAULT_SET_PICTURES: [number, number] = [4, 6]; // diary.set.pictures
const DEFAULT_SET_MIN_POSTED = 2; // diary.set.minPosted
const DEFAULT_SET_SEED_SETS = 6; // diary.set.seedSets
const DEFAULT_SET_MAX_MESSAGE_BYTES = 8000000; // diary.set.maxMessageBytes
const DEFAULT_FAMILY = 'seed';

/**
 * The local date key (`YYYY-MM-DD`) of `nowMs` in `timezone` (UTC when missing).
 */
export function localDayKey(nowMs: number, timezone?: string): string {
  return zonedDay(nowMs, timezone || 'UTC');
}

/** The date key one day after `dayKey`. */
function nextDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return utcDay(Date.UTC(year, month - 1, day + 1));
}

/** A whole hour 0..24, or null. */
function hourOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24 ? value : null;
}

/** A non-negative whole count, or 0. */
function countOf(value: unknown): number {
  return isFiniteNumber(value) && value > 0 ? Math.floor(value) : 0;
}

/** `value` clamped to 0..1, or `fallback` when it is not a finite number. */
function fractionOf(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** The `[min, max]` post count of a window (`posts`), both whole and non-negative. */
function postRange(window: unknown): [number, number] {
  const posts = listOf(objOf(window).posts);
  const min = countOf(posts[0]);
  return [min, Math.max(min, countOf(posts[1]))];
}

/** The instant of `hour`:00 local on `dayKey`, 24 meaning the next day's midnight. */
function hourInstant(dayKey: string, hour: number, timezone: string): number {
  return hour === 24 ? zonedEpoch(nextDayKey(dayKey), 0, 0, timezone) : zonedEpoch(dayKey, hour, 0, timezone);
}

/** `[start, end)` of one window on the local day `dayKey`, or null for a malformed window. A window
 * whose `to` is not after `from` ends the next day (18 -> 1 runs 18:00 to 01:00); `from === to` is a
 * whole day. */
function windowSpan(window: unknown, dayKey: string, timezone: string): [number, number] | null {
  const from = hourOf(objOf(window).from);
  const to = hourOf(objOf(window).to);
  if (from === null || to === null || from === 24) return null;
  const start = hourInstant(dayKey, from, timezone);
  const end = to > from ? hourInstant(dayKey, to, timezone) : hourInstant(nextDayKey(dayKey), to, timezone);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return [start, end];
}

/**
 * The diary's plan for the local day of `nowMs`. With chance
 * `quietDayChance * quietCarry ** quietStreak` the day is quiet (no slots), so
 * every quiet day in a row makes the next one less likely. Otherwise every
 * window draws its count `min + floor(rng() * (max - min + 1))` from `posts:
 * [min, max]`. A window that drew 0 (and may post at all, `max > 0`) is
 * hungry by its own `hunger[i]` plus the windows of this day that already
 * came up empty: for each of those points, while the count is still 0, one
 * roll at or above `hungerBoost` redraws it (1 turns hunger off); a window
 * still at 0 after that is one more empty window for the later ones. A window
 * with `max === 0` or a malformed one never redraws and never counts. Each
 * window places its slots uniformly inside itself (local hours; a window with
 * `to <= from` ends the next day); the slots are sorted, a slot closer than
 * `minGapMinutes` to the previous kept one is dropped, and while more than
 * `maxPerDay` remain one of them, chosen at random (one roll each), is
 * dropped, so the cap does not always cost the latest window. Slots already
 * past at planning time are kept: dueSlot decides what still fires.
 * `cfg` is `config.diary` (`windows`, `quietDayChance`, `quietCarry`, `hungerBoost`, `minGapMinutes`, `maxPerDay`),
 * `timezone` is `bot.timezone`, `carry` is nextHunger's result (zeros when missing). The result's `hunger` has one
 * whole count per window, `posted` is empty.
 */
export function planDay(
  cfg: unknown,
  nowMs: number,
  timezone: string | undefined,
  rng: () => number,
  carry: Partial<Carry> | null = {}
): DayPlan {
  const zone = timezone || 'UTC';
  const day = localDayKey(nowMs, zone);
  const c = objOf(cfg);
  const windows = listOf(c.windows);
  const hunger = windows.map((_, i) => countOf(Array.isArray(carry?.hunger) ? carry.hunger[i] : 0));
  const quietStreak = countOf(carry?.quietStreak);
  const kept = { posted: [], hunger, quietStreak };
  const quietCarry = fractionOf(c.quietCarry, DEFAULT_QUIET_CARRY);
  const quiet = rng() < Number(c.quietDayChance ?? DEFAULT_QUIET_DAY_CHANCE) * quietCarry ** quietStreak;
  if (quiet) return { day, slots: [], quiet: true, done: [], ...kept };

  const boost = fractionOf(c.hungerBoost, DEFAULT_HUNGER_BOOST);
  const placed: Array<number> = [];
  let deficit = 0;
  windows.forEach((window, index) => {
    const [min, max] = postRange(window);
    const draw = () => min + Math.floor(rng() * (max - min + 1));
    let n = draw();
    const span = windowSpan(window, day, zone);
    if (!span) return;
    if (max > 0) {
      const points = hunger[index] + deficit;
      for (let k = 0; k < points && n === 0; k += 1) {
        if (rng() >= boost) n = draw();
      }
      if (n === 0) deficit += 1;
    }
    const [start, end] = span;
    for (let i = 0; i < n; i += 1) placed.push(Math.floor(start + rng() * (end - start)));
  });
  placed.sort((a, b) => a - b);

  const gapMs = Math.max(0, Number(c.minGapMinutes ?? 90)) * MINUTE_MS;
  const slots: Array<number> = [];
  for (const slot of placed) {
    if (slots.length > 0 && slot - slots[slots.length - 1] < gapMs) continue;
    slots.push(slot);
  }
  const cap = countOf(c.maxPerDay ?? DEFAULT_MAX_PER_DAY);
  while (slots.length > cap) {
    slots.splice(Math.min(slots.length - 1, Math.floor(rng() * slots.length)), 1);
  }
  return { day, slots, quiet: false, done: [], ...kept };
}

/** The finite numbers of `value` when it is a list, else []. */
const numbersOf = (value: unknown): Array<number> => listOf(value).filter(isFiniteNumber);

/**
 * The hunger a new day plan starts with, from `previous` (the stored plan of
 * an earlier day). No previous plan, or one stored before hunger existed (no
 * `posted` list on a day that was not quiet): zeros and a streak of 0. A quiet
 * previous day: every window one hungrier, `quietStreak` one longer.
 * Otherwise the streak is 0 and each window, laid on the previous plan's day
 * (windowSpan), is fed when one of the previous slots inside it was posted
 * (`posted`: scheduled posts that spoke; manual posts never count) or is still
 * pending (not done and not older than the grace at `nowMs`: a slot of a
 * window running past midnight); a fed window goes back to 0, an unfed one
 * grows by 1. A window that can never post (`max === 0`) or a malformed one
 * stays at 0. The result has one entry per window of `windows`, so a changed
 * windows list pads with 0 or drops the tail. `windows` is `config.diary.windows`, `timezone` is `bot.timezone`,
 * `graceMinutes` is `diary.slotGraceMinutes`. Pure.
 */
export function nextHunger(
  previous: unknown,
  windows: unknown,
  timezone: string | undefined,
  nowMs: number,
  graceMinutes?: unknown
): Carry {
  const zone = timezone || 'UTC';
  const list = listOf(windows);
  const zeros = { hunger: list.map(() => 0), quietStreak: 0 };
  if (!previous || typeof previous !== 'object') return zeros;
  const stored = objOf(previous);
  const before = (i: number) => countOf(Array.isArray(stored.hunger) ? listOf(stored.hunger)[i] : 0);
  const day = typeof stored.day === 'string' ? stored.day : null;
  const spanOf = (window: unknown) => (day && postRange(window)[1] > 0 ? windowSpan(window, day, zone) : null);
  if (stored.quiet === true) {
    return {
      hunger: list.map((window, i) => (spanOf(window) ? before(i) + 1 : 0)),
      quietStreak: countOf(stored.quietStreak) + 1,
    };
  }
  if (!Array.isArray(stored.posted) || !Array.isArray(stored.slots)) return zeros;
  const posted = new Set(listOf(stored.posted));
  const done = new Set(listOf(stored.done));
  const graceMs = Math.max(0, Number(graceMinutes ?? DEFAULT_GRACE_MINUTES)) * MINUTE_MS;
  const fed = (slot: number) => posted.has(slot) || (!done.has(slot) && slot >= nowMs - graceMs);
  const slots = numbersOf(stored.slots);
  const hunger = list.map((window, i) => {
    const span = spanOf(window);
    if (!span) return 0;
    const [start, end] = span;
    const inside = slots.filter((slot) => slot >= start && slot < end);
    return inside.some(fed) ? 0 : before(i) + 1;
  });
  return { hunger, quietStreak: 0 };
}

/**
 * The slot of `plan` to run at `nowMs`. Among the slots at or before `nowMs`
 * that are not in `plan.done`, those older than `graceMinutes` (`diary.slotGraceMinutes`) are `dropped`
 * (the caller marks them done without firing them) and the oldest remaining
 * one is the `slot`. Null when nothing is due and nothing is dropped;
 * `{ slot: null, dropped }` when every due slot was missed.
 */
export function dueSlot(plan: unknown, nowMs: number, graceMinutes?: unknown): Due | null {
  const stored = objOf(plan);
  const done = new Set(listOf(stored.done));
  const graceMs = Math.max(0, Number(graceMinutes ?? DEFAULT_GRACE_MINUTES)) * MINUTE_MS;
  const due = numbersOf(stored.slots)
    .filter((slot) => slot <= nowMs && !done.has(slot))
    .sort((a, b) => a - b);
  const dropped = due.filter((slot) => nowMs - slot > graceMs);
  const live = due.filter((slot) => nowMs - slot <= graceMs);
  if (live.length === 0 && dropped.length === 0) return null;
  return { slot: live[0] ?? null, dropped };
}

/** The `[key, weight]` pairs of `kinds` with a finite positive weight, in key order. */
function weightedKinds(kinds: unknown): Array<[string, number]> {
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) return [];
  return Object.entries(objOf(kinds)).filter(
    (entry): entry is [string, number] => isFiniteNumber(entry[1]) && entry[1] > 0
  );
}

/**
 * One kind key drawn from `kinds` (`{ key: weight }`, `diary.kinds`) in
 * proportion to its weight; a kind with a weight of 0 or less is never drawn.
 * Null when no kind has a positive weight.
 */
export function pickKind(kinds: unknown, rng: () => number): string | null {
  const entries = weightedKinds(kinds);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    if (roll < weight) return key;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

/** `value` when it is a list, else `fallback`. */
const listOr = (value: unknown, fallback: ReadonlyArray<string>): ReadonlyArray<unknown> =>
  Array.isArray(value) ? listOf(value) : fallback;

/**
 * Whether `kind` is a picture kind: listed in `pictureKinds` (`diary.pictureKinds`),
 * DEFAULT_PICTURE_KINDS when that is not a list.
 */
export function isPictureKind(kind: unknown, pictureKinds: unknown): boolean {
  const drawable = listOr(pictureKinds, DEFAULT_PICTURE_KINDS);
  return typeof kind === 'string' && drawable.includes(kind);
}

/**
 * Whether `kind` posts a set of pictures: listed in `setKinds`
 * (`diary.setKinds`), DEFAULT_SET_KINDS when that is not a list.
 */
export function isSetKind(kind: unknown, setKinds: unknown): boolean {
  const sets = listOr(setKinds, DEFAULT_SET_KINDS);
  return typeof kind === 'string' && sets.includes(kind);
}

/**
 * The settings of a set post (`diary.set` of `diaryCfg`, config.diary), each one replaced by its default
 * when missing or invalid: `pictures` `[min, max]` whole counts (max never
 * below min; the engine stages at most `max` draw.create pictures, `min` is for the
 * prompt), `minPosted` (fewer pictures generated and nothing is posted; at
 * least 1), `seedSets` (the compose request's seed combinations, 0 allowed)
 * and `maxMessageBytes` (the attachment bytes of one message, positive).
 */
export function setSettings(diaryCfg: unknown): SetSettings {
  const set = sectionOf(diaryCfg, 'set');
  const whole = (value: unknown, min: number) => (isFiniteNumber(value) && value >= min ? Math.floor(value) : null);
  const range = listOf(set.pictures);
  const low = whole(range[0], 1);
  const high = whole(range[1], 1);
  const pictures: [number, number] =
    low !== null && high !== null ? [low, Math.max(low, high)] : [...DEFAULT_SET_PICTURES];
  return {
    pictures,
    minPosted: whole(set.minPosted, 1) ?? DEFAULT_SET_MIN_POSTED,
    seedSets: whole(set.seedSets, 0) ?? DEFAULT_SET_SEED_SETS,
    maxMessageBytes: whole(set.maxMessageBytes, 1) ?? DEFAULT_SET_MAX_MESSAGE_BYTES,
  };
}

/**
 * `kinds` (`diary.kinds`) without its picture kinds (isPictureKind over `pictureKinds`, diary.pictureKinds), the other
 * weights kept; a new object, the input untouched. What the planner and the
 * random fallback get while a post may not carry a picture.
 */
export function withoutPictureKinds(kinds: unknown, pictureKinds: unknown): Record<string, unknown> {
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) return {};
  return Object.fromEntries(Object.entries(objOf(kinds)).filter(([key]) => !isPictureKind(key, pictureKinds)));
}

/**
 * The plan request's answer `parsed` (the JSON the model answered, untrusted), normalised. `kind` must be a key of
 * `kinds` (diary.kinds) with
 * a positive weight, else the whole answer is replaced by a weighted random
 * kind (pickKind; null when no kind is weighted) with an empty brief and
 * search (`fallback: true`). Otherwise `brief` is one line, at most 300
 * characters; `search` is kept only for a kind in `searchKinds` (diary.searchKinds). With
 * `pictureAllowed`, a kind in `pictureKinds` (diary.pictureKinds) always draws (a picture kind
 * means a picture, whatever the answer said) and any other kind draws only
 * when the answer says `picture: true`; without it nothing draws.
 */
export function validatePlan(
  parsed: unknown,
  kinds: unknown,
  {
    pictureAllowed = false,
    searchKinds,
    pictureKinds,
  }: { pictureAllowed?: boolean; searchKinds?: unknown; pictureKinds?: unknown } = {},
  rng: () => number
): DiaryPlan {
  const answer = objOf(parsed);
  const named = typeof answer.kind === 'string' ? answer.kind : null;
  const valid = weightedKinds(kinds).some(([key]) => key === named);
  const drawable = listOr(pictureKinds, DEFAULT_PICTURE_KINDS);
  if (!valid || named === null) {
    const kind = pickKind(kinds, rng);
    const picture = pictureAllowed === true && kind !== null && drawable.includes(kind);
    return { kind, brief: '', search: '', picture, fallback: true };
  }
  const picture = pictureAllowed === true && (drawable.includes(named) || answer.picture === true);
  const searchable = listOr(searchKinds, DEFAULT_SEARCH_KINDS);
  const brief = typeof answer.brief === 'string' ? clampText(oneLine(answer.brief), BRIEF_CHARS, { tolerance: 1 }) : '';
  const search = typeof answer.search === 'string' && searchable.includes(named) ? oneLine(answer.search) : '';
  return { kind: named, brief, search, picture, fallback: false };
}

/** The picture suffix of one post: the scene, `pictureUnknown` for a picture with no recorded
 * scene (`true` or ''), nothing for no picture. A set (`pictures` above 1) shows its first
 * scene with the count (`labels.diary.pictureSet`; `picture` when that label is missing). */
function pictureSuffix(picture: unknown, labels: unknown, pictures: unknown): string {
  const words = diaryWords(labels);
  const count = countOf(pictures);
  if (typeof picture === 'string' && picture.trim()) {
    if (count > 1 && words.pictureSet) return fill(labelOf(words.pictureSet), { count, scene: oneLine(picture) });
    return fill(labelOf(words.picture), { scene: oneLine(picture) });
  }
  if (picture === true || picture === '') return fill(labelOf(words.picture), { scene: words.pictureUnknown ?? '' });
  return '';
}

/**
 * The body of the `<diary>` block over `posts` (oldest first; each `{ at, kind, gist, picture, pictures }`):
 * `labels.diary.intro`, then one
 * `labels.diary.line` per post (`{date}` the post's local date in
 * `timezone`, `{kind}` its kind key or `labels.diary.kindUnknown`, `{gist}`)
 * with `labels.diary.picture` appended when the post had a picture
 * (`labels.diary.pictureSet` with the count for a set: `pictures` above 1). The
 * newest `max` (diary.historyPosts) posts, oldest first. '' when there is no post.
 */
export function renderDiaryBlock(
  posts: unknown,
  labels: unknown,
  { timezone, max }: { timezone?: string; max?: unknown } = {}
): string {
  const words = diaryWords(labels);
  const list = listOf(posts);
  const limit = countOf(max ?? DEFAULT_HISTORY_POSTS);
  const shown = limit > 0 ? list.slice(-limit) : [];
  if (shown.length === 0) return '';
  const lines = shown.map((entry) => {
    const post = objOf(entry);
    const date = isFiniteNumber(post.at) ? localDayKey(post.at, timezone) : '';
    const kind = typeof post.kind === 'string' && post.kind ? post.kind : (words.kindUnknown ?? '');
    const line = fill(labelOf(words.line), { date, kind, gist: oneLine(post.gist) });
    return line + pictureSuffix(post.picture, labels, post.pictures);
  });
  return [words.intro, ...lines].filter(Boolean).join('\n');
}

/**
 * The body of the `<kinds>` block: `labels.diary.kinds`, then one
 * `labels.diary.kindLine` per kind of `kinds` (diary.kinds) with a positive weight (`{key}`,
 * `{weight}`, `{count}` its uses among the newest `window` (diary.historyPosts) of `posts` (oldest first), `{window}`
 * how many posts that is). '' when no kind is weighted.
 */
export function renderKindsBlock(
  kinds: unknown,
  posts: unknown,
  labels: unknown,
  { window }: { window?: unknown } = {}
): string {
  const words = diaryWords(labels);
  const entries = weightedKinds(kinds);
  if (entries.length === 0) return '';
  const limit = countOf(window ?? DEFAULT_HISTORY_POSTS);
  const recent = limit > 0 && Array.isArray(posts) ? listOf(posts).slice(-limit) : [];
  const lines = entries.map(([key, weight]) =>
    fill(labelOf(words.kindLine), {
      key,
      weight,
      count: recent.filter((post) => objOf(post).kind === key).length,
      window: recent.length,
    })
  );
  return [words.kinds, ...lines].filter(Boolean).join('\n');
}

/**
 * The seed families of `prompts['diary-seeds']`: a `# name` line starts a
 * family, every other non-blank line (trimmed) is one seed of the current
 * family; lines before the first header belong to the family `seed`. Families
 * keep their header order; a header with no lines is an empty family.
 */
export function parseSeedFamilies(text: unknown): Record<string, Array<string>> {
  const families: Record<string, Array<string>> = {};
  if (typeof text !== 'string') return families;
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^#+\s*(.+)$/.exec(line);
    if (header) {
      current = header[1].trim();
      families[current] ??= [];
      continue;
    }
    if (current === null) {
      current = DEFAULT_FAMILY;
      families[current] ??= [];
    }
    families[current].push(line);
  }
  return families;
}

/**
 * `sets` (diary.seedSets) seed combinations from `families` (parseSeedFamilies): each one random line of every
 * non-empty family,
 * in the families' order. [] when no family has a line or `sets` is not a
 * positive count.
 */
export function pickSeeds(families: unknown, sets: unknown, rng: () => number): Array<Array<unknown>> {
  const source: object = families && typeof families === 'object' ? families : {};
  const values: Array<unknown> = Object.values(source);
  const lists = values.filter((lines): lines is Array<unknown> => Array.isArray(lines) && lines.length > 0);
  const count = countOf(sets);
  if (lists.length === 0 || count === 0) return [];
  const result: Array<Array<unknown>> = [];
  for (let i = 0; i < count; i += 1) {
    result.push(lists.map((lines) => lines[Math.min(lines.length - 1, Math.floor(rng() * lines.length))]));
  }
  return result;
}

/**
 * The body of the `<seeds>` block: `labels.diary.seeds`, then one `- a; b; c`
 * line per combination of `sets` (pickSeeds). '' when there is none.
 */
export function renderSeedsBlock(sets: unknown, labels: unknown): string {
  const lines = listOf(sets)
    .filter((set): set is Array<unknown> => Array.isArray(set) && set.length > 0)
    .map((set) => `- ${set.join('; ')}`);
  if (lines.length === 0) return '';
  return [diaryWords(labels).seeds, ...lines].filter(Boolean).join('\n');
}

/**
 * The owner's topic for a forced post (`/nep diary post topic`): one line,
 * cut at a word boundary to at most 1000 characters. Null for a missing,
 * non-string or blank topic.
 */
export function diaryTopic(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  return clampText(oneLine(text), TOPIC_CHARS, { tolerance: 1 }) || null;
}

/**
 * The body of the plan request's `<topic>` block: `labels.diary.topic`, then
 * the topic (diaryTopic). '' without a topic.
 */
export function renderTopicBlock(topic: unknown, labels: unknown): string {
  const text = diaryTopic(topic);
  if (!text) return '';
  return [diaryWords(labels).topic, text].filter(Boolean).join('\n');
}

// A diary post's text loses its URLs through the one shared sanitizer (src/memory/clamp.js#stripUrls).
export { stripUrls };

/**
 * A post's one-line gist for diary.json: whitespace collapsed, then cut at a
 * word boundary to at most `chars` characters (diary.gistChars).
 */
export function gistOf(text: unknown, chars?: number): string {
  return clampText(oneLine(text), chars ?? DEFAULT_GIST_CHARS, { tolerance: 1 });
}

/**
 * The day plan of the new local day `fresh`, with the slots of `previous` (the
 * plan of an earlier day) that are not done and still in the future or
 * within the grace merged into it: a window such as 18 -> 1 spills past local
 * midnight, and its slots after midnight belong to the plan that placed them.
 * Pure.
 */
function withCarriedSlots(
  fresh: DayPlan,
  previous: unknown,
  nowMs: number,
  graceMinutes: unknown
): { plan: DayPlan; carried: number } {
  const stored = objOf(previous);
  if (!previous || !Array.isArray(stored.slots)) return { plan: fresh, carried: 0 };
  const done = new Set(listOf(stored.done));
  const graceMs = Math.max(0, Number(graceMinutes ?? DEFAULT_GRACE_MINUTES)) * MINUTE_MS;
  const carried = numbersOf(stored.slots).filter((slot) => !done.has(slot) && slot >= nowMs - graceMs);
  if (carried.length === 0) return { plan: fresh, carried: 0 };
  const slots = [...new Set([...carried, ...fresh.slots])].sort((a, b) => a - b);
  return { plan: { ...fresh, slots }, carried: carried.length };
}

/** What createDiary is given. */
export type DiaryDeps = {
  hot: { readonly config: unknown; readonly prompts?: unknown };
  store: DiaryStore;
  reads: Reads | null;
  turns: {
    runTurn(params: DiaryTurnParams): Promise<unknown>;
    isAnyBusy?(): boolean;
    waitIdle?(): Promise<unknown>;
  };
  getGuildId: () => string | null;
  backfill?: ((args: BackfillArgs) => Promise<number>) | null;
  mirrors?: { publishEntry(entry: unknown): Promise<unknown> } | null;
  rng?: () => number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
};

/**
 * The diary's scheduler and its owner-facing edge. `tick()` (every 30 s,
 * src/index.js) does nothing while `features.diary` is false (a missing key
 * counts as on) or the bot is paused (`diary: skip` with `reason` `off` or
 * `paused`, once per local day and reason). Otherwise it keeps the day plan of the
 * served guild in state.json (`diary[guildId] = { day, slots, done, quiet,
 * posted, hunger, quietStreak }`, `day` the local date in `bot.timezone`):
 * nextHunger from the stored plan, then planDay once per local day (`diary:
 * plan` with `hunger` and `quietStreak`), the not-done slots of the previous plan still ahead or
 * within the grace merged in. A due slot (dueSlot, `diary.slotGraceMinutes`)
 * is marked done before its post runs; slots missed by more than the grace
 * are marked done unfired (`diary: skip`, `grace`). The post needs the day's
 * posts under `diary.maxPerDay` (`cap`); then, with an empty history,
 * `backfill` once per place and process from the place her diary is posted to
 * (`diary: backfill` with `count`), and the selfreflection wake
 * `turns.runTurn({ mode: 'diary', diary: { kind, forced }, guildId })`, which
 * needs no conversation (`diary: due`, then `diary: post` with the outcome,
 * its `reason` when it has one, and the pictures); the entry the turn recorded
 * goes to `mirrors.publishEntry` (src/behavior/mirror.ts; a failure is logged
 * `diary: publication failed`). A `busy` outcome
 * un-marks the slot, so the next tick retries it within the grace; a `spoke`
 * one appends it to the plan's `posted` (what feeds a window). One post
 * at a time. `force({ kind, topic })` runs one post now, outside the plan and
 * the quiet day, under the same rails; a topic (diaryTopic: one line, 1000
 * characters at most; blank is none) reaches the turn as `diary.topic`, and
 * no topic leaves the field out; while another turn holds the lease
 * (`turns.isAnyBusy()`, or a `busy` outcome) it waits for `turns.waitIdle()`
 * at most `diary.forceWaitMs` and posts then, `{ outcome: 'busy' }` when the
 * turn still runs. Hot values are read at every call.
 * `delay` resolves after `ms` (a timer that never holds the process open); injected by tests.
 * `reads` are the core's reads of the interface (the backfill's history), null when none is connected.
 * `backfill` has backfillDiary's shape (the count written); null skips the backfill. `mirrors` is the diary's
 * publisher (`{ publishEntry }`), null publishes nothing.
 */
export function createDiary({
  hot,
  store,
  reads,
  turns,
  getGuildId,
  backfill = null,
  mirrors = null,
  rng = Math.random,
  now = Date.now,
  delay = unrefDelay,
}: DiaryDeps): Diary {
  let stopped = false;
  let inFlight = false;
  // reason -> the local day it was last logged on: one `diary: skip` per reason and day.
  const skipped = new Map<string, string>();
  // `${guildId}:${channelId}` the backfill was tried for in this process.
  const backfillTried = new Set<string>();

  function skip(reason: string, day: string, extra: Obj = {}) {
    if (skipped.get(reason) === day) return;
    skipped.set(reason, day);
    log.info('diary: skip', { reason, ...extra });
  }

  /** Why no post may run now, or null. */
  function gate(config: unknown) {
    if (sectionOf(config, 'features').diary === false) return 'off';
    if (stateData(store).paused) return 'paused';
    return null;
  }

  /** `bot.timezone` of `config`, UTC when it is missing or empty. */
  const zoneOf = (config: unknown): string => labelOf(sectionOf(config, 'bot').timezone) || 'UTC';

  /** The plan of the local day of `t` for `guildId`, planned (and stored) when the stored one is older. */
  function currentPlan(guildId: string, config: unknown, t: number): DayPlan {
    const timezone = zoneOf(config);
    const diaryCfg = sectionOf(config, 'diary');
    const day = localDayKey(t, timezone);
    const plans = plansOf(store, true);
    const stored: DayPlan | undefined = plans[guildId];
    if (stored && stored.day === day && Array.isArray(stored.slots)) return stored;
    const hunger = nextHunger(stored, diaryCfg.windows, timezone, t, diaryCfg.slotGraceMinutes);
    const fresh = planDay(diaryCfg, t, timezone, rng, hunger);
    const { plan, carried } = withCarriedSlots(fresh, stored, t, diaryCfg.slotGraceMinutes);
    plans[guildId] = plan;
    store.state.markDirty();
    log.info('diary: plan', {
      guildId,
      day,
      slots: plan.slots.length,
      quiet: plan.quiet,
      carried,
      hunger: [...plan.hunger],
      quietStreak: plan.quietStreak,
    });
    return plan;
  }

  /** `diary.maxPerDay` of `config`, its default when missing. */
  const capOf = (config: unknown): unknown => sectionOf(config, 'diary').maxPerDay ?? DEFAULT_MAX_PER_DAY;

  /** Why the post may not run now (`cap`: the day's posts reached `diary.maxPerDay`), or null. */
  function postBlock(config: unknown, t: number) {
    if (countToday(stateData(store), DIARY_DAILY, t) >= Number(capOf(config))) return 'cap';
    return null;
  }

  /**
   * The history backfilled from the place her diary is posted to (mirror.ts#diaryPlaces, the first), once per place
   * and process, while diary.json is empty; nothing without the interface's reads or such a place.
   */
  async function backfillOnce(guildId: string, config: unknown) {
    const place = readMirrors(store, diaryPlaces, [])[0];
    if (typeof backfill !== 'function' || !reads || !place) return;
    const channel = { iface: place.iface, id: place.conversationId };
    const key = `${guildId}:${channel.id}`;
    if (backfillTried.has(key)) return;
    backfillTried.add(key);
    try {
      if (listOf(store.getDiary(guildId)?.posts).length > 0) return;
      const count = await backfill({
        store,
        reads,
        conversation: { iface: channel.iface, conversationId: channel.id },
        guildId,
        config,
        labels: objOf(hot.prompts).labels,
      });
      log.info('diary: backfill', { guildId, channelId: channel.id, count: Number.isFinite(count) ? count : 0 });
    } catch (err) {
      log.warn('diary: backfill failed', { guildId, channelId: channel.id, error: err });
    }
  }

  /** One post through the turn runner (the selfreflection wake), logged with its outcome; its entry published. */
  async function post(
    guildId: string,
    { kind, topic = null, forced }: { kind: string | null; topic?: string | null; forced: boolean }
  ): Promise<unknown> {
    const diary = { kind: kind ?? null, ...(topic ? { topic } : {}), forced };
    const result = await turns.runTurn({ mode: 'diary', diary, guildId });
    const answer = objOf(result);
    const made = objOf(answer.diary);
    log.info('diary: post', {
      guildId,
      kind: made.kind ?? kind ?? null,
      messages: made.messages ?? 0,
      picture: made.picture ?? false,
      pictures: made.pictures ?? 0,
      search: made.search ?? false,
      outcome: answer.outcome ?? null,
      ...(answer.reason ? { reason: answer.reason } : {}),
      forced,
      ...(answer.dryRun ? { dryRun: true } : {}),
    });
    const entry = made.entry;
    if (entry && mirrors) {
      try {
        // The entry's row is in memory before its media and its publications name it.
        await settled(store);
        await mirrors.publishEntry(entry);
      } catch (err) {
        log.warn('diary: publication failed', { guildId, error: err });
      }
    }
    return result;
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    const config = hot.config;
    const t = now();
    const day = localDayKey(t, zoneOf(config));
    const blocked = gate(config);
    if (blocked) {
      skip(blocked, day);
      return;
    }
    const guildId = getGuildId();
    if (!guildId) return;
    const plan = currentPlan(guildId, config, t);
    const due = dueSlot(plan, t, sectionOf(config, 'diary').slotGraceMinutes);
    if (!due) return;
    if (due.dropped.length > 0) {
      plan.done = [...(plan.done ?? []), ...due.dropped];
      store.state.markDirty();
      log.info('diary: skip', { reason: 'grace', count: due.dropped.length });
    }
    if (due.slot === null) return;
    const slot = due.slot;

    inFlight = true;
    try {
      const block = postBlock(config, t);
      if (block) {
        // Not this slot: it is spent, the next one tries again.
        plan.done = [...(plan.done ?? []), slot];
        store.state.markDirty();
        skip(block, day);
        return;
      }
      await backfillOnce(guildId, config);
      if (stopped) return;
      // Marked before the turn runs, like the spontaneous scheduler reschedules first.
      plan.done = [...(plan.done ?? []), slot];
      store.state.markDirty();
      log.info('diary: due', { guildId, slot });
      const outcome = objOf(await post(guildId, { kind: null, forced: false })).outcome;
      if (outcome === 'busy') {
        plan.done = plan.done.filter((done) => done !== slot);
        store.state.markDirty();
        log.info('diary: skip', { reason: 'busy', slot });
      } else if (outcome === 'spoke') {
        // Feeds the slot's window (nextHunger); force() never records here.
        plan.posted = [...(Array.isArray(plan.posted) ? plan.posted : []), slot];
        store.state.markDirty();
      }
    } finally {
      inFlight = false;
    }
  }

  async function force({
    kind = null,
    topic = null,
  }: { kind?: string | null; topic?: string | null } = {}): Promise<unknown> {
    const config = hot.config;
    const t = now();
    const blocked = gate(config);
    if (blocked === 'paused') return { outcome: 'paused' };
    if (blocked) return { outcome: 'not-now', reason: blocked };
    const guildId = getGuildId();
    if (!guildId) return { outcome: 'not-now', reason: 'no-guild' };
    const block = postBlock(config, t);
    if (block === 'cap') {
      const cap = capOf(config);
      return {
        outcome: 'refused',
        reason: 'cap',
        limit: { key: 'diary.maxPerDay', used: countToday(stateData(store), DIARY_DAILY, t), cap },
      };
    }
    await backfillOnce(guildId, config);
    const params = { kind: typeof kind === 'string' && kind ? kind : null, topic: diaryTopic(topic), forced: true };
    // One turn at a time: a running turn is waited for (diary.forceWaitMs at most), once.
    let waited = false;
    if (turns.isAnyBusy?.() === true) {
      waited = true;
      if (!(await waitIdle(config))) return { outcome: 'busy' };
    }
    const result = await post(guildId, params);
    if (objOf(result).outcome !== 'busy' || waited) return result;
    if (!(await waitIdle(config))) return { outcome: 'busy' };
    return post(guildId, params);
  }

  /** Whether the turn runner went idle within `diary.forceWaitMs` (read from `config`, the live one). */
  async function waitIdle(config: unknown) {
    if (typeof turns.waitIdle !== 'function') return false;
    const cap = Number(sectionOf(config, 'diary').forceWaitMs ?? DEFAULT_FORCE_WAIT_MS);
    const idle = await Promise.race([turns.waitIdle().then(() => true), delay(cap).then(() => false)]);
    return idle && turns.isAnyBusy?.() !== true;
  }

  function status(): DiaryStatus {
    const t = now();
    const guildId = getGuildId();
    const plan = guildId ? (plansOf(store, false)[guildId] ?? null) : null;
    const history = guildId && typeof store.getDiary === 'function' ? listOf(store.getDiary(guildId)?.posts).length : 0;
    return {
      channelId: readMirrors(store, diaryPlaces, [])[0]?.conversationId ?? '',
      day: plan?.day ?? null,
      slots: Array.isArray(plan?.slots) ? [...plan.slots] : [],
      done: Array.isArray(plan?.done) ? [...plan.done] : [],
      quiet: plan?.quiet === true,
      hunger: Array.isArray(plan?.hunger) ? plan.hunger.map(countOf) : [],
      quietStreak: countOf(plan?.quietStreak),
      posts: countToday(stateData(store), DIARY_DAILY, t),
      pictures: countToday(stateData(store), DIARY_PICTURES_DAILY, t),
      history,
    };
  }

  function stop(): void {
    stopped = true;
  }

  return { tick, force, status, stop };
}

/**
 * The diary's memory start: when the guild's `diary.json` has no posts, read up to `diary.historyPosts`
 * of the persona's own messages from the diary channel (REST, oldest first) and store them with
 * `kind: null`, a one-line gist, and `labels.diary.pictureUnknown` as the scene of a message that
 * carried a picture. A history that already has posts is left alone (the posts are never rewritten by
 * code). This and the factory are the module's interface-aware edge; everything above stays pure.
 * `config` is the live merged config (`diary` read now); `labels` the live labels; `reads` the core's reads of the
 * interface. Answers the number of posts written (0 when the history was not empty).
 */
export async function backfillDiary({
  store,
  reads,
  conversation,
  guildId,
  config,
  labels,
}: BackfillArgs): Promise<number> {
  if (listOf(store.getDiary(guildId)?.posts).length > 0) return 0;
  const diaryCfg = sectionOf(config, 'diary');
  const max = diaryCfg.historyPosts ?? DEFAULT_HISTORY_POSTS;
  const gistChars = diaryCfg.gistChars ?? DEFAULT_GIST_CHARS;
  const history = await historyLines(reads, conversation, { limit: Number(max) });
  const posts: Array<BackfillPost> = history
    .filter((message) => message.self === true)
    .map((message) => ({
      at: message.ts,
      kind: null,
      gist: gistOf(message.content, Number(gistChars)),
      picture: listOf(message.attachments).some((a) => objOf(a).kind === 'image')
        ? (diaryWords(labels).pictureUnknown ?? '')
        : null,
      messageIds: [message.id],
      search: null,
    }));
  if (posts.length === 0) return 0;
  store.setDiaryPosts(guildId, posts, { max: Number(max) });
  log.info('diary: backfill', { count: posts.length });
  return posts.length;
}

/** Waits for the store's writes to land (`flushSettled`), when it has them. */
function settled(store: DiaryStore): Promise<unknown> {
  return typeof store.flushSettled === 'function' ? store.flushSettled({}) : Promise.resolve();
}

/** A delay whose timer never keeps the process alive (createDiary's default `delay`). */
function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
