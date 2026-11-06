// The persona keeps a selfreflection: one owner-chosen channel where it posts on its
// own, rarely and irregularly, the way a person runs a personal feed. This
// module owns the selfreflection's decisions: which local times of a day get a post
// (configured windows in `bot.timezone`, quiet days, a minimum gap,
// and the hunger that empty windows and quiet days carry into later
// ones, or the exact UTC slots of `selfreflection.schedule` when it is set), which planned slot is due now (a slot missed by more than the grace
// while the bot was down is dropped, never fired late in a burst), which kind
// of post a plan names (validated against the weighted `selfreflection.kinds`, with a
// weighted random fallback; while a post may not carry a picture the picture
// kinds are dropped before the planner sees them), which kinds post a set of
// pictures rather than one (`selfreflection.setKinds`, sized by `selfreflection.set`), and how
// the post history, the kinds and the random seeds are rendered for the plan
// and compose requests. All wording comes from `labels.selfreflection.*`; kind keys
// are config keys.
//
// The decisions are pure: randomness and the clock are injected (`rng`,
// `nowMs`), and none of them touches a platform SDK, the disk or the model. The
// factory at the end (createSelfreflection) is the module's edge: it ticks, keeps the
// day plan in state.json and runs the post through the turn runner.

import { fill } from '../format.ts';
import { strictJsonObject } from '../llm/parse.ts';
import { log } from '../log.ts';
import { oneLine, clampText, stripUrls } from '../memory/clamp.ts';
import { parseSchedule, slotsOfDay } from '../service/schedule.ts';
import type { ServiceSchedule } from '../service/schedule.ts';
import { DAY_MS, MINUTE_MS, zonedDay, zonedEpoch, utcDay } from '../time.ts';
import { isFiniteNumber, listOf, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import type { Reads } from '../interface/reads.ts';
import type { createStore } from '../memory/store.ts';
import type { ConversationRef } from '../protocol/adapter.ts';
import { historyLines } from './lines.ts';
import { selfreflectionPlaces, readMirrors } from './mirror.ts';

/** A day counter of the store's state (src/time.ts#countToday): the key of its day and the key of its count. */
export type Daily = { dayKey: string; countKey: string };

/** The selfreflection's plan of one local day, as state.json keeps it (`selfreflection[placeId]`). */
export type DayPlan = {
  day: string;
  slots: Array<number>;
  quiet: boolean;
  done: Array<number>;
  posted: Array<number>;
  hunger: Array<number>;
  quietStreak: number;
  /** The newest slot that spoke, on any day; a new day's plan carries it. */
  lastPosted?: number;
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
export type SelfreflectionPlan = {
  kind: string | null;
  brief: string;
  search: string;
  picture: boolean;
  fallback: boolean;
};

/** What createSelfreflection's turns run: one selfreflection turn, the selfreflection wake. */
export type SelfreflectionTurnParams = {
  mode: 'selfreflection';
  selfreflection: { kind: string | null; topic?: string; forced: boolean };
};

/** The store as the selfreflection reads it: the state file (its pause and the day plans), her selfreflection and its writes. */
export type SelfreflectionStore = Pick<
  ReturnType<typeof createStore>,
  'state' | 'getSelfreflection' | 'setSelfreflectionPosts' | 'flushSettled'
>;

/** The state file's data as the selfreflection reads it (`store.state.data`, untyped in the store). */
function stateData(store: SelfreflectionStore): Obj {
  const data: unknown = store.state.data;
  return objOf(data);
}

/** The day plans of the state file (`selfreflection`), created empty when `create` and missing. */
function plansOf(store: SelfreflectionStore, create: boolean): Record<string, DayPlan | undefined> {
  const data = stateData(store);
  if (create) data.selfreflection ??= {};
  // state.json's `selfreflection` is what currentPlan wrote: one day plan per place.
  return objOf(data.selfreflection) as Record<string, DayPlan | undefined>;
}

/** One post the backfill writes to the selfreflection unit. */
export type BackfillPost = {
  at: number;
  kind: null;
  gist: string;
  picture: unknown;
  messageIds: Array<string>;
  search: null;
};

/** What the backfill is given (backfillSelfreflection). */
export type BackfillArgs = {
  store: SelfreflectionStore;
  reads: Reads;
  conversation: ConversationRef;

  config: unknown;
  labels: unknown;
};

/** The selfreflection's day as the owner's status shows it (createSelfreflection's `status`). */
export type SelfreflectionStatus = {
  placeId: string;
  day: string | null;
  slots: Array<number>;
  done: Array<number>;
  quiet: boolean;
  hunger: Array<number>;
  quietStreak: number;
  history: number;
  lastPosted: number | null;
};

/** The selfreflection's scheduler (createSelfreflection). */
export type Selfreflection = {
  tick: () => Promise<void>;
  force: (opts?: { kind?: string | null; topic?: string | null }) => Promise<unknown>;
  status: () => SelfreflectionStatus;
  stop: () => void;
};

/** A section of a record, `{}` when it is not a record. */
const sectionOf = (value: unknown, key: string): Obj => objOf(objOf(value)[key]);
/** A label read from the labels, '' when it is not a string (fill answers '' for it). */
const labelOf = (value: unknown): string => (typeof value === 'string' ? value : '');
/** The selfreflection's words: `labels.selfreflection`. */
const selfreflectionWords = (labels: unknown): Obj => sectionOf(labels, 'selfreflection');

const BRIEF_CHARS = 300;
const TOPIC_CHARS = 1000;
const DEFAULT_QUIET_DAY_CHANCE = 0.3; // selfreflection.quietDayChance
const DEFAULT_FORCE_WAIT_MS = 120000; // selfreflection.forceWaitMs
// The selfreflection's measures. Production values, config cut of 2026-10-31.
const DEFAULT_GRACE_MINUTES = 30;
const DEFAULT_QUIET_CARRY = 0.25;
const DEFAULT_HUNGER_BOOST = 0.5;
const MIN_GAP_MINUTES = 90;
export const DEFAULT_HISTORY_POSTS = 150;
export const DEFAULT_GIST_CHARS = 200;
/** The characters of a picture description shown as a past post's scene (`selfreflection.sceneChars`' default). */
export const DEFAULT_SCENE_CHARS = 400;
/** The weight of each kind of post the planner picks among. */
export const SELFREFLECTION_KINDS: Readonly<Record<string, number>> = Object.freeze({
  selfPicture: 3,
  picture: 2,
  meme: 1,
  thought: 2,
  people: 2,
  news: 2,
  facts: 1,
  status: 3,
  photoset: 1,
  randomSet: 1,
});
/** The seed sets a post's request carries. */
export const SEED_SETS = 2;
export const DEFAULT_SEARCH_KINDS: Array<string> = ['news', 'facts'];
/** The messages one selfreflection post sends at most. */
export const SELFREFLECTION_MAX_MESSAGES = 3;
/** The kinds that mean a picture when `selfreflection.pictureKinds` is not a list. */
export const DEFAULT_PICTURE_KINDS: Array<string> = ['selfPicture', 'picture', 'meme', 'photoset', 'randomSet'];
/** The kinds whose post is a set of pictures when `selfreflection.setKinds` is not a list. */
export const DEFAULT_SET_KINDS: Array<string> = ['photoset', 'randomSet'];
const DEFAULT_SET_PICTURES: [number, number] = [4, 6];
const DEFAULT_SET_MIN_POSTED = 2;
const DEFAULT_SET_SEED_SETS = 6;
const DEFAULT_SET_MAX_MESSAGE_BYTES = 8000000;
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
 * The start of the first window after `nowMs` that can post (`posts` maximum above 0), read from `windows` in
 * `timezone` (UTC when missing). Null when no window can post or none is well formed.
 */
export function nextWindowStart(windows: unknown, nowMs: number, timezone?: string): number | null {
  const zone = timezone || 'UTC';
  const usable = listOf(windows).filter((window) => postRange(window)[1] > 0);
  let day = localDayKey(nowMs, zone);
  for (let ahead = 0; ahead < 2; ahead += 1) {
    const starts = usable
      .map((window) => windowSpan(window, day, zone)?.[0])
      .filter((start): start is number => start !== undefined && start > nowMs);
    if (starts.length > 0) return Math.min(...starts);
    day = nextDayKey(day);
  }
  return null;
}

/** The named schedule of `selfreflection`, or null while the windows draw the day. */
const namedSchedule = (cfg: unknown): ServiceSchedule | null => parseSchedule(objOf(cfg).schedule);

/** The start of the UTC day of `moment`. */
const utcDayStart = (moment: number): number => Math.floor(moment / DAY_MS) * DAY_MS;

/**
 * The selfreflection's plan for the local day of `nowMs`. A named `schedule` replaces all of what follows: its plan is the UTC day
 * of `nowMs`, its slots are exactly the schedule's (an interval laid from the start of that day), and it has no quiet
 * day and no gap, so status never promises a time the dice then drop. Otherwise, with chance
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
 * MIN_GAP_MINUTES to the previous kept one is dropped. Slots already
 * past at planning time are kept: dueSlot decides what still fires.
 * `cfg` is `config.selfreflection` (`windows`, `quietDayChance`),
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
  const c = objOf(cfg);
  const windows = listOf(c.windows);
  const named = namedSchedule(cfg);
  if (named !== null) {
    const slots = slotsOfDay(named, utcDayStart(nowMs));
    return {
      day: utcDay(nowMs),
      slots,
      quiet: false,
      done: [],
      posted: [],
      hunger: windows.map(() => 0),
      quietStreak: 0,
    };
  }
  const day = localDayKey(nowMs, zone);
  const hunger = windows.map((_, i) => countOf(Array.isArray(carry?.hunger) ? carry.hunger[i] : 0));
  const quietStreak = countOf(carry?.quietStreak);
  const kept = { posted: [], hunger, quietStreak };
  const quietCarry = DEFAULT_QUIET_CARRY;
  const quiet = rng() < Number(c.quietDayChance ?? DEFAULT_QUIET_DAY_CHANCE) * quietCarry ** quietStreak;
  if (quiet) return { day, slots: [], quiet: true, done: [], ...kept };

  const boost = DEFAULT_HUNGER_BOOST;
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

  const gapMs = MIN_GAP_MINUTES * MINUTE_MS;
  const slots: Array<number> = [];
  for (const slot of placed) {
    if (slots.length > 0 && slot - slots[slots.length - 1] < gapMs) continue;
    slots.push(slot);
  }
  return { day, slots, quiet: false, done: [], ...kept };
}

/**
 * A stored plan of the current day after the schedule moved: what already ran or fell due stays, and what lies ahead is
 * the new schedule's. A slot of the new schedule that already passed owes nothing. Null when the plan already holds it.
 */
function rescheduled(stored: DayPlan, schedule: ServiceSchedule, nowMs: number): DayPlan | null {
  const passed = stored.slots.filter((slot) => slot <= nowMs);
  const ahead = slotsOfDay(schedule, utcDayStart(nowMs)).filter((slot) => slot > nowMs);
  const slots = [...passed, ...ahead];
  if (stored.quiet !== true && slots.length === stored.slots.length && slots.every((s, i) => s === stored.slots[i]))
    return null;
  return { ...stored, slots, quiet: false };
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
 * windows list pads with 0 or drops the tail. `windows` is `config.selfreflection.windows`, `timezone` is `bot.timezone`,
 * `graceMinutes` is `selfreflection.slotGraceMinutes`. Pure.
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
 * that are not in `plan.done`, those older than `graceMinutes` (`selfreflection.slotGraceMinutes`) are `dropped`
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
 * One kind key drawn from `kinds` (`{ key: weight }`, `selfreflection.kinds`) in
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

/** The correction of a kind's weight for its recent use is held between these factors. */
const DRAW_CLAMP: [number, number] = [0.25, 4];
/** The factor on the weight of the newest post's kind. */
const NEWEST_FACTOR = 0.25;
/** The smallest use a share is divided by, so an unused kind gets the upper clamp. */
const USE_EPSILON = 1e-9;

/**
 * The weights a selfreflection post's kind is drawn by (pickKind): each kind of `kinds` (selfreflection.kinds) with a
 * positive weight, in the order of `kinds`, at `weight * clamp(share / max(used, ε), 0.25, 4)`, where `share` is its
 * weight over the sum of the weights and `used` its count over the newest `window` (selfreflection.historyPosts) of
 * `posts` (oldest first, each `{ kind }`) as a fraction of the posts in that window. The newest post's kind then
 * counts a quarter. With no post every kind gets the upper clamp, so the weights keep their proportions.
 */
export function drawWeights(
  kinds: unknown,
  posts: unknown,
  { window }: { window?: unknown } = {}
): Record<string, number> {
  const entries = weightedKinds(kinds);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const limit = countOf(window ?? DEFAULT_HISTORY_POSTS);
  const recent = limit > 0 && Array.isArray(posts) ? listOf(posts).slice(-limit) : [];
  const newest = recent.length > 0 ? objOf(recent[recent.length - 1]).kind : null;
  const [low, high] = DRAW_CLAMP;
  return Object.fromEntries(
    entries.map(([key, weight]) => {
      const count = recent.filter((post) => objOf(post).kind === key).length;
      const used = recent.length > 0 ? count / recent.length : 0;
      const factor = Math.min(high, Math.max(low, weight / total / Math.max(used, USE_EPSILON)));
      return [key, weight * factor * (key === newest ? NEWEST_FACTOR : 1)];
    })
  );
}

/** `value` when it is a list, else `fallback`. */
const listOr = (value: unknown, fallback: ReadonlyArray<string>): ReadonlyArray<unknown> =>
  Array.isArray(value) ? listOf(value) : fallback;

/**
 * Whether `kind` is a picture kind: listed in `pictureKinds` (`selfreflection.pictureKinds`),
 * DEFAULT_PICTURE_KINDS when that is not a list.
 */
export function isPictureKind(kind: unknown, pictureKinds: unknown): boolean {
  const drawable = listOr(pictureKinds, DEFAULT_PICTURE_KINDS);
  return typeof kind === 'string' && drawable.includes(kind);
}

/**
 * Whether `kind` posts a set of pictures: listed in `setKinds`
 * (`selfreflection.setKinds`), DEFAULT_SET_KINDS when that is not a list.
 */
export function isSetKind(kind: unknown, setKinds: unknown): boolean {
  const sets = listOr(setKinds, DEFAULT_SET_KINDS);
  return typeof kind === 'string' && sets.includes(kind);
}

/**
 * The settings of a set post (`set` of `selfreflectionCfg`, config.selfreflection), each one replaced by its default
 * when missing or invalid: `pictures` `[min, max]` whole counts (max never
 * below min; the engine stages at most `max` draw.create pictures, `min` is for the
 * prompt), `minPosted` (fewer pictures generated and nothing is posted; at
 * least 1), `seedSets` (the compose request's seed combinations, 0 allowed)
 * and `maxMessageBytes` (the attachment bytes of one message, positive).
 */
export function setSettings(selfreflectionCfg: unknown): SetSettings {
  const set = sectionOf(selfreflectionCfg, 'set');
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
 * `kinds` (`selfreflection.kinds`) without its picture kinds (isPictureKind over `pictureKinds`, selfreflection.pictureKinds), the other
 * weights kept; a new object, the input untouched. What the planner and the
 * random fallback get while a post may not carry a picture.
 */
export function withoutPictureKinds(kinds: unknown, pictureKinds: unknown): Record<string, unknown> {
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) return {};
  return Object.fromEntries(Object.entries(objOf(kinds)).filter(([key]) => !isPictureKind(key, pictureKinds)));
}

/**
 * The plan request's answer `parsed` (the JSON the model answered, untrusted), normalised. `kind` must be a key of
 * `kinds` (selfreflection.kinds) with
 * a positive weight, else the whole answer is replaced by a weighted random
 * kind (pickKind; null when no kind is weighted) with an empty brief and
 * search (`fallback: true`). Otherwise `brief` is one line, at most 300
 * characters; `search` is kept only for a kind in `searchKinds` (selfreflection.searchKinds). With
 * `pictureAllowed`, a kind in `pictureKinds` (selfreflection.pictureKinds) always draws (a picture kind
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
): SelfreflectionPlan {
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

/**
 * The schema of the plan request's answer, handed to the client as `responseFormat`:
 * `{ "kind", "brief", "search", "picture", "seed" }`, with `kind` one of `kinds`, the kinds that request offered.
 */
export function selfreflectionPlanFormat(kinds: ReadonlyArray<string>): { name: string; schema: object } {
  return {
    name: 'selfreflection-plan',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...kinds] },
        brief: { type: 'string' },
        search: { type: 'string' },
        picture: { type: 'boolean' },
        seed: { type: 'integer' },
      },
      required: ['kind', 'brief', 'search', 'picture', 'seed'],
      additionalProperties: false,
    },
  };
}

/**
 * The plan answer `text` read strictly: the object of selfreflectionPlanFormat with `kind` one of `kinds`, a text
 * `brief` and `search`, a boolean `picture` and a whole-number `seed`. Null for anything else, which validatePlan
 * reads as a broken answer. Pure.
 */
export function parsePlanAnswer(text: unknown, kinds: ReadonlyArray<string>): Record<string, unknown> | null {
  const answer = strictJsonObject(text);
  if (!answer) return null;
  const { kind, brief, search, picture, seed } = answer;
  const readable =
    typeof kind === 'string' &&
    kinds.includes(kind) &&
    typeof brief === 'string' &&
    typeof search === 'string' &&
    typeof picture === 'boolean' &&
    Number.isInteger(seed);
  return readable ? answer : null;
}

/**
 * The number of the seed combination a plan answer `parsed` names as its `seed`: a whole number from 1 to `offered`
 * (the combinations its request carried), else 0, which stands for none.
 */
export function planSeed(parsed: unknown, offered: number): number {
  const seed = objOf(parsed).seed;
  return typeof seed === 'number' && Number.isInteger(seed) && seed >= 1 && seed <= offered ? seed : 0;
}

/**
 * What a past picture post showed, one line: the brief its planner wrote (`plan.brief`), else the description of its
 * first linked picture (`pictureDescription`) cut at a word boundary to `chars` (selfreflection.sceneChars, 400), else
 * its stored drawing prompt (`picture`). '' when it has none of them.
 */
export function sceneOf(post: unknown, chars?: unknown): string {
  const entry = objOf(post);
  const brief = objOf(entry.plan).brief;
  if (typeof brief === 'string' && brief.trim()) return oneLine(brief);
  const described = entry.pictureDescription;
  if (typeof described === 'string' && described.trim())
    return clampText(oneLine(described), countOf(chars) || DEFAULT_SCENE_CHARS, { tolerance: 1 });
  return typeof entry.picture === 'string' ? oneLine(entry.picture) : '';
}

/** The picture suffix of one post: its scene (sceneOf), `pictureUnknown` for a picture with no recorded
 * scene (`picture` `true` or '' and no plan or description), nothing for no picture. A set (`pictures` above 1) shows its
 * first scene with the count (`labels.selfreflection.pictureSet`; `picture` when that label is missing). */
function pictureSuffix(post: Obj, labels: unknown, sceneChars: unknown): string {
  const words = selfreflectionWords(labels);
  const { picture } = post;
  const drawn = (typeof picture === 'string' && picture.trim() !== '') || picture === true || picture === '';
  if (!drawn) return '';
  const scene = sceneOf(post, sceneChars);
  if (!scene) return fill(labelOf(words.picture), { scene: words.pictureUnknown ?? '' });
  const count = countOf(post.pictures);
  if (count > 1 && words.pictureSet) return fill(labelOf(words.pictureSet), { count, scene });
  return fill(labelOf(words.picture), { scene });
}

/**
 * The body of the `<diary>` block over `posts` (oldest first; each `{ at, kind, gist, picture, pictures }`, with `plan` and
 * `pictureDescription` when the store has them): `labels.selfreflection.intro`, then one
 * `labels.selfreflection.line` per post (`{date}` the post's local date in
 * `timezone`, `{kind}` its kind key or `labels.selfreflection.kindUnknown`, `{gist}`)
 * with `labels.selfreflection.picture` appended when the post had a picture, its scene from sceneOf cut to `sceneChars`
 * (`labels.selfreflection.pictureSet` with the count for a set: `pictures` above 1). The
 * newest `max` (selfreflection.historyPosts) posts, oldest first. '' when there is no post.
 */
export function renderSelfreflectionBlock(
  posts: unknown,
  labels: unknown,
  { timezone, max, sceneChars }: { timezone?: string; max?: unknown; sceneChars?: unknown } = {}
): string {
  const words = selfreflectionWords(labels);
  const list = listOf(posts);
  const limit = countOf(max ?? DEFAULT_HISTORY_POSTS);
  const shown = limit > 0 ? list.slice(-limit) : [];
  if (shown.length === 0) return '';
  const lines = shown.map((entry) => {
    const post = objOf(entry);
    const date = isFiniteNumber(post.at) ? localDayKey(post.at, timezone) : '';
    const kind = typeof post.kind === 'string' && post.kind ? post.kind : (words.kindUnknown ?? '');
    const line = fill(labelOf(words.line), { date, kind, gist: oneLine(post.gist) });
    return line + pictureSuffix(post, labels, sceneChars);
  });
  return [words.intro, ...lines].filter(Boolean).join('\n');
}

/**
 * The body of the `<kinds>` block: `labels.selfreflection.kinds`, then one
 * `labels.selfreflection.kindLine` per kind of `kinds` (selfreflection.kinds) with a positive weight (`{key}`,
 * `{weight}`, `{count}` its uses among the newest `window` (selfreflection.historyPosts) of `posts` (oldest first), `{window}`
 * how many posts that is). '' when no kind is weighted.
 */
export function renderKindsBlock(
  kinds: unknown,
  posts: unknown,
  labels: unknown,
  { window }: { window?: unknown } = {}
): string {
  const words = selfreflectionWords(labels);
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
 * The seed families of `prompts['selfreflection-seeds']`: a `# name` line starts a
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
 * `sets` (selfreflection.seedSets) seed combinations from `families` (parseSeedFamilies): each one random line of every
 * non-empty family,
 * in the families' order. A line in `used` (usedSeedLines) is left out while its family has another line; a family whose
 * every line is used is drawn from whole. [] when no family has a line or `sets` is not a
 * positive count.
 */
export function pickSeeds(
  families: unknown,
  sets: unknown,
  rng: () => number,
  used: ReadonlySet<string> = new Set()
): Array<Array<unknown>> {
  const source: object = families && typeof families === 'object' ? families : {};
  const values: Array<unknown> = Object.values(source);
  const lists = values
    .filter((lines): lines is Array<unknown> => Array.isArray(lines) && lines.length > 0)
    .map((lines) => {
      const fresh = lines.filter((line) => typeof line !== 'string' || !used.has(line));
      return fresh.length > 0 ? fresh : lines;
    });
  const count = countOf(sets);
  if (lists.length === 0 || count === 0) return [];
  const result: Array<Array<unknown>> = [];
  for (let i = 0; i < count; i += 1) {
    result.push(lists.map((lines) => lines[Math.min(lines.length - 1, Math.floor(rng() * lines.length))]));
  }
  return result;
}

/**
 * The seed lines the newest `max` (selfreflection.historyPosts, 150) of `posts` (oldest first) took: the lines of the
 * combination each post's plan built on (`plan.seeds[plan.seed - 1]`). A post with no plan, `seed` 0 or a `seed` past
 * its combinations takes none.
 */
export function usedSeedLines(posts: unknown, max?: unknown): Set<string> {
  const limit = countOf(max ?? DEFAULT_HISTORY_POSTS);
  const used = new Set<string>();
  if (limit === 0) return used;
  for (const post of listOf(posts).slice(-limit)) {
    const plan = objOf(objOf(post).plan);
    const seeds = listOf(plan.seeds);
    const { seed } = plan;
    const taken = typeof seed === 'number' && Number.isInteger(seed) && seed >= 1 ? seeds[seed - 1] : undefined;
    if (!Array.isArray(taken)) continue;
    for (const line of taken) if (typeof line === 'string') used.add(line);
  }
  return used;
}

/**
 * The body of the `<seeds>` block: `labels.selfreflection.seeds`, then one `- a; b; c`
 * line per combination of `sets` (pickSeeds). '' when there is none.
 */
export function renderSeedsBlock(sets: unknown, labels: unknown): string {
  const lines = listOf(sets)
    .filter((set): set is Array<unknown> => Array.isArray(set) && set.length > 0)
    .map((set) => `- ${set.join('; ')}`);
  if (lines.length === 0) return '';
  return [selfreflectionWords(labels).seeds, ...lines].filter(Boolean).join('\n');
}

/**
 * The owner's topic for a forced post (`/nep selfreflection post topic`): one line,
 * cut at a word boundary to at most 1000 characters. Null for a missing,
 * non-string or blank topic.
 */
export function selfreflectionTopic(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  return clampText(oneLine(text), TOPIC_CHARS, { tolerance: 1 }) || null;
}

/**
 * The body of the plan request's `<topic>` block: `labels.selfreflection.topic`, then
 * the topic (selfreflectionTopic). '' without a topic.
 */
export function renderTopicBlock(topic: unknown, labels: unknown): string {
  const text = selfreflectionTopic(topic);
  if (!text) return '';
  return [selfreflectionWords(labels).topic, text].filter(Boolean).join('\n');
}

// A selfreflection post's text loses its URLs through the one shared sanitizer (src/memory/clamp.js#stripUrls).
export { stripUrls };

/**
 * A post's one-line gist for the selfreflection unit: whitespace collapsed, then cut at a
 * word boundary to at most `chars` characters (selfreflection.gistChars).
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

/** What createSelfreflection is given. */
export type SelfreflectionDeps = {
  hot: { readonly config: unknown; readonly prompts?: unknown };
  store: SelfreflectionStore;
  reads: Reads | null;
  turns: {
    runTurn(params: SelfreflectionTurnParams): Promise<unknown>;
    isAnyBusy?(): boolean;
    waitIdle?(): Promise<unknown>;
  };

  backfill?: ((args: BackfillArgs) => Promise<number>) | null;
  mirrors?: { publishEntry(entry: unknown): Promise<unknown>; beginEntry?(): () => void } | null;
  rng?: () => number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
};

/**
 * The selfreflection's scheduler and its owner-facing edge. `tick()` (every 30 s,
 * src/index.ts) does nothing while `selfreflection.enabled` is false (`selfreflection: skip` with `reason` `disabled`) or the
 * bot is paused (`reason` `paused`), each logged once per local day. Otherwise it keeps the day plan of the
 * served place in state.json (`selfreflection[placeId] = { day, slots, done, quiet,
 * posted, hunger, quietStreak }`, `day` the local date in `bot.timezone`):
 * nextHunger from the stored plan, then planDay once per local day (`selfreflection:
 * plan` with `hunger` and `quietStreak`), the not-done slots of the previous plan still ahead or
 * within the grace merged in. A due slot (dueSlot, `selfreflection.slotGraceMinutes`)
 * is marked done before its post runs; slots missed by more than the grace
 * are marked done unfired (`selfreflection: skip`, `grace`). Then, with an empty history,
 * `backfill` once per place and process from the place her selfreflection is posted to
 * (`selfreflection: backfill` with `count`), and the selfreflection wake
 * `turns.runTurn({ mode: 'selfreflection', selfreflection: { kind, forced }, placeId })`, which
 * needs no conversation (`selfreflection: due`, then `selfreflection: post` with the outcome,
 * its `reason` when it has one, and the pictures); the entry the turn recorded
 * goes to `mirrors.publishEntry` (src/behavior/mirror.ts; a failure is logged
 * `selfreflection: publication failed`). A `busy` outcome
 * un-marks the slot, so the next tick retries it within the grace; a `spoke`
 * one appends it to the plan's `posted` (what feeds a window). One post
 * at a time. `force({ kind, topic })` runs one post now, outside the plan and
 * the quiet day, under the same rails; a topic (selfreflectionTopic: one line, 1000
 * characters at most; blank is none) reaches the turn as `selfreflection.topic`, and
 * no topic leaves the field out; while another turn holds the lease
 * (`turns.isAnyBusy()`, or a `busy` outcome) it waits for `turns.waitIdle()`
 * at most `selfreflection.forceWaitMs` and posts then, `{ outcome: 'busy' }` when the
 * turn still runs. Hot values are read at every call.
 * `delay` resolves after `ms` (a timer that never holds the process open); injected by tests.
 * `reads` are the core's reads of the interface (the backfill's history), null when none is connected.
 * `backfill` has backfillSelfreflection's shape (the count written); null skips the backfill. `mirrors` is the selfreflection's
 * publisher (`{ publishEntry }`), null publishes nothing.
 */
export function createSelfreflection({
  hot,
  store,
  reads,
  turns,
  backfill = null,
  mirrors = null,
  rng = Math.random,
  now = Date.now,
  delay = unrefDelay,
}: SelfreflectionDeps): Selfreflection {
  let stopped = false;
  let inFlight = false;
  // reason -> the local day it was last logged on: one `selfreflection: skip` per reason and day.
  const skipped = new Map<string, string>();
  // `${placeId}:${placeId}` the backfill was tried for in this process.
  const backfillTried = new Set<string>();

  function skip(reason: string, day: string, extra: Obj = {}) {
    if (skipped.get(reason) === day) return;
    skipped.set(reason, day);
    log.info('selfreflection: skip', { reason, ...extra });
  }

  /** Why no post may run now, or null. */
  function gate() {
    if (stateData(store).paused) return 'paused';
    return null;
  }

  /** `bot.timezone` of `config`, UTC when it is missing or empty. */
  const zoneOf = (config: unknown): string => labelOf(sectionOf(config, 'bot').timezone) || 'UTC';

  /** The plan of the local day of `t` for `placeId`, planned (and stored) when the stored one is older. */
  function currentPlan(config: unknown, t: number): DayPlan {
    const timezone = zoneOf(config);
    const selfreflectionCfg = sectionOf(config, 'selfreflection');
    const named = namedSchedule(selfreflectionCfg);
    const day = named === null ? localDayKey(t, timezone) : utcDay(t);
    const plans = plansOf(store, true);
    const stored: DayPlan | undefined = plans.persona;
    if (stored && stored.day === day && Array.isArray(stored.slots)) {
      const moved = named === null ? null : rescheduled(stored, named, t);
      if (moved === null) return stored;
      plans.persona = moved;
      store.state.markDirty();
      log.info('selfreflection: plan', { day, slots: moved.slots.length, quiet: false, rescheduled: true });
      return moved;
    }
    const hunger = nextHunger(stored, selfreflectionCfg.windows, timezone, t, DEFAULT_GRACE_MINUTES);
    const fresh = planDay(selfreflectionCfg, t, timezone, rng, hunger);
    const { plan, carried } = withCarriedSlots(fresh, stored, t, DEFAULT_GRACE_MINUTES);
    if (typeof stored?.lastPosted === 'number') plan.lastPosted = stored.lastPosted;
    plans.persona = plan;
    store.state.markDirty();
    log.info('selfreflection: plan', {
      day,
      slots: plan.slots.length,
      quiet: plan.quiet,
      carried,
      hunger: [...plan.hunger],
      quietStreak: plan.quietStreak,
    });
    return plan;
  }

  /**
   * The history backfilled from the place her selfreflection is posted to (mirror.ts#selfreflectionPlaces, the first), once per place
   * and process, while the selfreflection unit is empty; nothing without the interface's reads or such a place.
   */
  async function backfillOnce(config: unknown) {
    const place = readMirrors(store, selfreflectionPlaces, [])[0];
    if (typeof backfill !== 'function' || !reads || !place) return;
    const channel = { iface: place.iface, id: place.conversationId };
    const key = String(channel.id);
    if (backfillTried.has(key)) return;
    backfillTried.add(key);
    try {
      if (listOf(store.getSelfreflection()?.posts).length > 0) return;
      const count = await backfill({
        store,
        reads,
        conversation: { iface: channel.iface, conversationId: channel.id },
        config,
        labels: objOf(hot.prompts).labels,
      });
      log.info('selfreflection: backfill', { placeId: channel.id, count: Number.isFinite(count) ? count : 0 });
    } catch (err) {
      log.warn('selfreflection: backfill failed', { placeId: channel.id, error: err });
    }
  }

  /** One post through the turn runner (the selfreflection wake), logged with its outcome; its entry published. */
  async function post({
    kind,
    topic = null,
    forced,
  }: {
    kind: string | null;
    topic?: string | null;
    forced: boolean;
  }): Promise<unknown> {
    const selfreflection = { kind: kind ?? null, ...(topic ? { topic } : {}), forced };
    // While the turn writes its entry and until its publish, a drain leaves that entry to this path: its media is not kept yet.
    const release = mirrors?.beginEntry?.();
    try {
      return await postEntry(selfreflection, kind, forced);
    } finally {
      release?.();
    }
  }

  async function postEntry(
    selfreflection: { kind: string | null; topic?: string; forced: boolean },
    kind: string | null,
    forced: boolean
  ): Promise<unknown> {
    const result = await turns.runTurn({ mode: 'selfreflection', selfreflection });
    const answer = objOf(result);
    const made = objOf(answer.selfreflection);
    log.info('selfreflection: post', {
      kind: made.kind ?? kind ?? null,
      messages: made.messages ?? 0,
      picture: made.picture ?? false,
      pictures: made.pictures ?? 0,
      search: made.search ?? false,
      outcome: answer.outcome ?? null,
      ...(answer.reason ? { reason: answer.reason } : {}),
      forced,
    });
    const entry = made.entry;
    if (entry && mirrors) {
      try {
        // The entry's row is in memory before its media and its publications name it.
        await settled(store);
        await mirrors.publishEntry(entry);
      } catch (err) {
        log.warn('selfreflection: publication failed', { error: err });
      }
    }
    return result;
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    const config = hot.config;
    const t = now();
    const day = localDayKey(t, zoneOf(config));
    const blocked = sectionOf(config, 'selfreflection').enabled === false ? 'disabled' : gate();
    if (blocked) {
      skip(blocked, day);
      return;
    }
    const plan = currentPlan(config, t);
    const due = dueSlot(plan, t, DEFAULT_GRACE_MINUTES);
    if (!due) return;
    if (due.dropped.length > 0) {
      plan.done = [...(plan.done ?? []), ...due.dropped];
      store.state.markDirty();
      log.info('selfreflection: skip', { reason: 'grace', count: due.dropped.length });
    }
    if (due.slot === null) return;
    const slot = due.slot;

    inFlight = true;
    try {
      await backfillOnce(config);
      if (stopped) return;
      // Marked before the turn runs, like the spontaneous scheduler reschedules first.
      plan.done = [...(plan.done ?? []), slot];
      store.state.markDirty();
      log.info('selfreflection: due', { slot });
      const outcome = objOf(await post({ kind: null, forced: false })).outcome;
      if (outcome === 'busy') {
        plan.done = plan.done.filter((done) => done !== slot);
        store.state.markDirty();
        log.info('selfreflection: skip', { reason: 'busy', slot });
      } else if (outcome === 'spoke') {
        // Feeds the slot's window (nextHunger); force() never records here.
        plan.posted = [...(Array.isArray(plan.posted) ? plan.posted : []), slot];
        plan.lastPosted = slot;
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
    const blocked = gate();
    if (blocked === 'paused') return { outcome: 'paused' };
    if (blocked) return { outcome: 'not-now', reason: blocked };
    await backfillOnce(config);
    const params = {
      kind: typeof kind === 'string' && kind ? kind : null,
      topic: selfreflectionTopic(topic),
      forced: true,
    };
    // One turn at a time: a running turn is waited for (selfreflection.forceWaitMs at most), once.
    let waited = false;
    if (turns.isAnyBusy?.() === true) {
      waited = true;
      if (!(await waitIdle(config))) return { outcome: 'busy' };
    }
    const result = await post(params);
    if (objOf(result).outcome !== 'busy' || waited) return result;
    if (!(await waitIdle(config))) return { outcome: 'busy' };
    return post(params);
  }

  /** Whether the turn runner went idle within `selfreflection.forceWaitMs` (read from `config`, the live one). */
  async function waitIdle(config: unknown) {
    if (typeof turns.waitIdle !== 'function') return false;
    const cap = Number(sectionOf(config, 'selfreflection').forceWaitMs ?? DEFAULT_FORCE_WAIT_MS);
    const idle = await Promise.race([turns.waitIdle().then(() => true), delay(cap).then(() => false)]);
    return idle && turns.isAnyBusy?.() !== true;
  }

  function status(): SelfreflectionStatus {
    const plan = plansOf(store, false).persona ?? null;
    const history = typeof store.getSelfreflection === 'function' ? listOf(store.getSelfreflection()?.posts).length : 0;
    return {
      placeId: readMirrors(store, selfreflectionPlaces, [])[0]?.conversationId ?? '',
      day: plan?.day ?? null,
      slots: Array.isArray(plan?.slots) ? [...plan.slots] : [],
      done: Array.isArray(plan?.done) ? [...plan.done] : [],
      quiet: plan?.quiet === true,
      hunger: Array.isArray(plan?.hunger) ? plan.hunger.map(countOf) : [],
      quietStreak: countOf(plan?.quietStreak),
      history,
      lastPosted: typeof plan?.lastPosted === 'number' ? plan.lastPosted : null,
    };
  }

  function stop(): void {
    stopped = true;
  }

  return { tick, force, status, stop };
}

/**
 * The selfreflection's memory start: when the persona's selfreflection unit has no posts, read up to `selfreflection.historyPosts`
 * of the persona's own messages from the selfreflection channel (REST, oldest first) and store them with
 * `kind: null`, a one-line gist, and `labels.selfreflection.pictureUnknown` as the scene of a message that
 * carried a picture. A history that already has posts is left alone (the posts are never rewritten by
 * code). This and the factory are the module's interface-aware edge; everything above stays pure.
 * `config` is the live merged config (`selfreflection` read now); `labels` the live labels; `reads` the core's reads of the
 * interface. Answers the number of posts written (0 when the history was not empty).
 */
export async function backfillSelfreflection({ store, reads, conversation, labels }: BackfillArgs): Promise<number> {
  if (listOf(store.getSelfreflection()?.posts).length > 0) return 0;
  const max = DEFAULT_HISTORY_POSTS;
  const gistChars = DEFAULT_GIST_CHARS;
  const history = await historyLines(reads, conversation, { limit: Number(max) });
  const posts: Array<BackfillPost> = history
    .filter((message) => message.self === true)
    .map((message) => ({
      at: message.ts,
      kind: null,
      gist: gistOf(message.content, Number(gistChars)),
      picture: listOf(message.attachments).some((a) => objOf(a).kind === 'image')
        ? (selfreflectionWords(labels).pictureUnknown ?? '')
        : null,
      messageIds: [message.id],
      search: null,
    }));
  if (posts.length === 0) return 0;
  store.setSelfreflectionPosts(posts, { max: Number(max) });
  log.info('selfreflection: backfill', { count: posts.length });
  return posts.length;
}

/** Waits for the store's writes to land (`flushSettled`), when it has them. */
function settled(store: SelfreflectionStore): Promise<unknown> {
  return typeof store.flushSettled === 'function' ? store.flushSettled({}) : Promise.resolve();
}

/** A delay whose timer never keeps the process alive (createSelfreflection's default `delay`). */
function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
