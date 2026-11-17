// The persona keeps a diary: one owner-chosen channel where it posts on its
// own, rarely and irregularly, the way a person runs a personal feed. This
// module owns the diary's decisions: which local times of a day get a post
// (configured windows in `bot.timezone`, quiet days, a minimum gap,
// and the hunger that empty windows and quiet days carry into later
// ones, or the exact UTC slots of `diary.schedule` when it is set), which planned slot is due now (a slot missed by more than the grace
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

import { fill, mediaMarkTags } from '../format.ts';
import { strictJsonObject } from '../llm/parse.ts';
import { log } from '../log.ts';
import { oneLine, stripUrls } from '../memory/clamp.ts';
import { parseSchedule, slotsOfDay } from '../service/schedule.ts';
import type { ServiceSchedule } from '../service/schedule.ts';
import { DAY_MS, MINUTE_MS, zonedDay, zonedEpoch, utcDay } from '../time.ts';
import { isFiniteNumber, listOf, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import type { Reads } from '../interface/reads.ts';
import type { createStore } from '../memory/store.ts';
import type { ChatRef } from '../protocol/adapter.ts';
import { diaryPlaces, readMirrors } from './mirror.ts';

/** The diary's plan of one local day, as state.json keeps it (`diary[placeId]`). */
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
export type DiaryPlan = {
  kind: string | null;
  brief: string;
  search: string;
  picture: boolean;
  fallback: boolean;
};

/** What createDiary's turns run: one diary turn, the diary wake. */
export type DiaryTurnParams = {
  mode: 'diary';
  diary: { kind: string | null; topic?: string; forced: boolean };
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
  // state.json's `diary` is what currentPlan wrote: one day plan per place.
  return objOf(data.diary) as Record<string, DayPlan | undefined>;
}

/** What the backfill is given. */
export type BackfillArgs = {
  store: DiaryStore;
  reads: Reads;
  chat: ChatRef;

  config: unknown;
  labels: unknown;
};

/** The diary's day as the owner's status shows it (createDiary's `status`). */
export type DiaryStatus = {
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

/** The diary's scheduler (createDiary). */
export type Diary = {
  tick: () => Promise<void>;
  status: () => DiaryStatus;
  stop: () => void;
};

/** A section of a record, `{}` when it is not a record. */
const sectionOf = (value: unknown, key: string): Obj => objOf(objOf(value)[key]);
/** A label read from the labels, '' when it is not a string (fill answers '' for it). */
const labelOf = (value: unknown): string => (typeof value === 'string' ? value : '');
/** The diary's words: `labels.diary`. */
const diaryWords = (labels: unknown): Obj => sectionOf(labels, 'diary');

const DEFAULT_QUIET_DAY_CHANCE = 0.3; // diary.quietDayChance
// The diary's measures. Production values, config cut of 2026-10-31.
const DEFAULT_GRACE_MINUTES = 30;
const DEFAULT_QUIET_CARRY = 0.25;
const DEFAULT_HUNGER_BOOST = 0.5;
const MIN_GAP_MINUTES = 90;
export const DEFAULT_HISTORY_POSTS = 150;
/** The weight of each kind of post the planner picks among. */
export const DIARY_KINDS: Readonly<Record<string, number>> = Object.freeze({
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
/** The messages one diary post sends at most. */
export const DIARY_MAX_MESSAGES = 3;
/** The kinds that mean a picture when `diary.pictureKinds` is not a list. */
export const DEFAULT_PICTURE_KINDS: Array<string> = ['selfPicture', 'picture', 'meme', 'photoset', 'randomSet'];
/** The kinds whose post is a set of pictures when `diary.setKinds` is not a list. */
export const DEFAULT_SET_KINDS: Array<string> = ['photoset', 'randomSet'];
const DEFAULT_SET_PICTURES: [number, number] = [4, 6];
const DEFAULT_SET_MIN_POSTED = 2;
const DEFAULT_SET_SEED_SETS = 6;
const DEFAULT_SET_MAX_MESSAGE_BYTES = 8000000;

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

/** The named schedule of `diary`, or null while the windows draw the day. */
const namedSchedule = (cfg: unknown): ServiceSchedule | null => parseSchedule(objOf(cfg).schedule);

/** The start of the UTC day of `moment`. */
const utcDayStart = (moment: number): number => Math.floor(moment / DAY_MS) * DAY_MS;

/**
 * The diary's plan for the local day of `nowMs`. A named `schedule` replaces all of what follows: its plan is the UTC day
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
 * `cfg` is `config.diary` (`windows`, `quietDayChance`),
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

/** The correction of a kind's weight for its recent use is held between these factors. */
const DRAW_CLAMP: [number, number] = [0.25, 4];
/** The factor on the weight of the newest post's kind. */
const NEWEST_FACTOR = 0.25;
/** The smallest use a share is divided by, so an unused kind gets the upper clamp. */
const USE_EPSILON = 1e-9;

/**
 * The weights a diary post's kind is drawn by (pickKind): each kind of `kinds` (diary.kinds) with a
 * positive weight, in the order of `kinds`, at `weight * clamp(share / max(used, ε), 0.25, 4)`, where `share` is its
 * weight over the sum of the weights and `used` its count over the newest `window` (diary.historyPosts) of
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
 * The settings of a set post (`set` of `diaryCfg`, config.diary), each one replaced by its default
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
  const brief = typeof answer.brief === 'string' ? oneLine(answer.brief) : '';
  const search = typeof answer.search === 'string' && searchable.includes(named) ? oneLine(answer.search) : '';
  return { kind: named, brief, search, picture, fallback: false };
}

/**
 * The schema of the plan request's answer, handed to the client as `responseFormat`:
 * `{ "kind", "brief", "search", "picture", "seed" }`, with `kind` one of `kinds`, the kinds that request offered.
 */
export function diaryPlanFormat(kinds: ReadonlyArray<string>): { name: string; schema: object } {
  return {
    name: 'diary-plan',
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
 * The plan answer `text` read strictly: the object of diaryPlanFormat with `kind` one of `kinds`, a text
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
 * What a past picture post showed, one line and whole: the brief its planner wrote (`plan.brief`), else its stored
 * drawing prompt (`picture`). '' when it has neither.
 */
export function sceneOf(post: unknown): string {
  const entry = objOf(post);
  const brief = objOf(entry.plan).brief;
  if (typeof brief === 'string' && brief.trim()) return oneLine(brief);
  return typeof entry.picture === 'string' ? oneLine(entry.picture) : '';
}

/** The picture suffix of one post: its scene (sceneOf), `pictureUnknown` for a picture with no recorded
 * scene (`picture` `true` or '' and no plan), nothing for no picture. A set (`pictures` above 1) shows its
 * first scene with the count (`labels.diary.pictureSet`; `picture` when that label is missing). */
function pictureSuffix(post: Obj, labels: unknown): string {
  const words = diaryWords(labels);
  const { picture } = post;
  const drawn = (typeof picture === 'string' && picture.trim() !== '') || picture === true || picture === '';
  if (!drawn) return '';
  const scene = sceneOf(post);
  if (!scene) return fill(labelOf(words.picture), { scene: words.pictureUnknown ?? '' });
  const count = countOf(post.pictures);
  const marks = mediaMarkTags(post, labels).map((mark) => ` ${mark}`);
  if (count > 1 && words.pictureSet) return fill(labelOf(words.pictureSet), { count, scene }) + marks.join('');
  return fill(labelOf(words.picture), { scene }) + marks.join('');
}

/**
 * The body of the `<diary>` block over `posts` (given oldest first; each `{ at, kind, gist, picture, pictures }`, with `plan` when the
 * store has it, and `made` and `depicted` for a picture she drew): `labels.diary.intro`, then one
 * `labels.diary.line` per post (`{date}` the post's local date in
 * `timezone`, `{kind}` its kind key or `labels.diary.kindUnknown`, `{gist}`)
 * with `labels.diary.picture` appended when the post had a picture, its scene from sceneOf
 * (`labels.diary.pictureSet` with the count for a set: `pictures` above 1), and after it the marks of a picture she
 * drew (src/format.ts#mediaMarkTags). The
 * newest `max` posts, listed newest first. '' when there is no post.
 */
export function renderDiaryBlock(
  posts: unknown,
  labels: unknown,
  { timezone, max }: { timezone?: string; max?: unknown } = {}
): string {
  const words = diaryWords(labels);
  const list = listOf(posts);
  const limit = countOf(max ?? DEFAULT_HISTORY_POSTS);
  const shown = limit > 0 ? list.slice(-limit).reverse() : [];
  if (shown.length === 0) return '';
  const lines = shown.map((entry) => {
    const post = objOf(entry);
    const date = isFiniteNumber(post.at) ? localDayKey(post.at, timezone) : '';
    const kind = typeof post.kind === 'string' && post.kind ? post.kind : (words.kindUnknown ?? '');
    const line = fill(labelOf(words.line), { date, kind, gist: oneLine(post.gist) });
    return line + pictureSuffix(post, labels);
  });
  return [words.intro, ...lines].filter(Boolean).join('\n');
}

/**
 * How the newest `count` posts of `kind` that have text open: the first `words` words of each gist, newest first.
 * `posts` are oldest first, as the store keeps them. A post of another kind or with a blank gist is skipped and takes no
 * place from `count`. `count` or `words` at 0 gives none, and a gist shorter than `words` gives its whole text.
 */
export function recentOpenings(
  posts: unknown,
  kind: string,
  { count, words }: { count: unknown; words: unknown }
): Array<string> {
  const limit = countOf(count);
  const length = countOf(words);
  const openings: Array<string> = [];
  if (limit === 0 || length === 0) return openings;
  for (const post of [...listOf(posts)].reverse()) {
    if (openings.length >= limit) break;
    const entry = objOf(post);
    if (entry.kind !== kind) continue;
    const opening = oneLine(entry.gist).split(' ').filter(Boolean).slice(0, length).join(' ');
    if (opening) openings.push(opening);
  }
  return openings;
}

/**
 * The lines that list `openings` (recentOpenings) under the brief of `<plan>`: `labels.diary.planOpenings` with
 * `{count}`, then one `labels.diary.planOpening` with `{words}` per opening, in the order given. [] when
 * there is no opening or either label is missing.
 */
export function renderOpenings(openings: ReadonlyArray<string>, labels: unknown): Array<string> {
  const words = diaryWords(labels);
  const lead = labelOf(words.planOpenings);
  const line = labelOf(words.planOpening);
  if (openings.length === 0 || !lead || !line) return [];
  return [fill(lead, { count: openings.length }), ...openings.map((opening) => fill(line, { words: opening }))];
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
 * The seed lines the newest `max` (diary.historyPosts, 150) of `posts` (oldest first) took: the lines of the
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
 * The body of the `<seeds>` block: `labels.diary.seeds`, then one `- a; b; c`
 * line per combination of `sets` (seeds.ts#pickSeeds). '' when there is none.
 */
export function renderSeedsBlock(sets: unknown, labels: unknown): string {
  const lines = listOf(sets)
    .filter((set): set is Array<unknown> => Array.isArray(set) && set.length > 0)
    .map((set) => `- ${set.join('; ')}`);
  if (lines.length === 0) return '';
  return [diaryWords(labels).seeds, ...lines].filter(Boolean).join('\n');
}

/**
 * The owner's topic for a forced post (`/nep diary post topic`): one line, whole. Null for a missing,
 * non-string or blank topic.
 */
export function diaryTopic(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  return oneLine(text) || null;
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
 * A post's one-line gist for the diary unit: whitespace collapsed, the text whole.
 */
export function gistOf(text: unknown): string {
  return oneLine(text);
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
  turns: { runTurn(params: DiaryTurnParams): Promise<unknown> };

  backfill?: ((args: BackfillArgs) => Promise<number>) | null;
  mirrors?: { publishEntry(entry: unknown): Promise<unknown>; beginEntry?(): () => void } | null;
  rng?: () => number;
  now?: () => number;
};

/**
 * The diary's scheduler and its owner-facing edge. `tick()` (every 30 s,
 * src/index.ts) does nothing while `diary.enabled` is false (`diary: skip` with `reason` `disabled`) or the
 * bot is paused (`reason` `paused`), each logged once per local day. Otherwise it keeps the day plan of the
 * served place in state.json (`diary[placeId] = { day, slots, done, quiet,
 * posted, hunger, quietStreak }`, `day` the local date in `bot.timezone`):
 * nextHunger from the stored plan, then planDay once per local day (`diary:
 * plan` with `hunger` and `quietStreak`), the not-done slots of the previous plan still ahead or
 * within the grace merged in. A due slot (dueSlot, `diary.slotGraceMinutes`)
 * is marked done before its post runs; slots missed by more than the grace
 * are marked done unfired (`diary: skip`, `grace`). Then, with an empty history,
 * `backfill` once per place and process from the place her diary is posted to
 * (`diary: backfill` with `count`), and the diary wake
 * `turns.runTurn({ mode: 'diary', diary: { kind: null, forced: false } })`, which
 * needs no chat (`diary: due`, then `diary: post` with the outcome,
 * its `reason` when it has one, and the pictures); the entry the turn recorded
 * goes to `mirrors.publishEntry` (src/behavior/mirror.ts; a failure is logged
 * `diary: publication failed`). A `busy` outcome
 * un-marks the slot, so the next tick retries it within the grace; a `spoke`
 * one appends it to the plan's `posted` (what feeds a window). One post
 * at a time. Hot values are read at every call.
 * `reads` are the core's reads of the interface (the backfill's history), null when none is connected.
 * `backfill` returns the count it wrote; null skips the backfill, and src/core.ts passes none. `mirrors` is the diary's
 * publisher (`{ publishEntry }`), null publishes nothing.
 */
export function createDiary({
  hot,
  store,
  reads,
  turns,
  backfill = null,
  mirrors = null,
  rng = Math.random,
  now = Date.now,
}: DiaryDeps): Diary {
  let stopped = false;
  let inFlight = false;
  // reason -> the local day it was last logged on: one `diary: skip` per reason and day.
  const skipped = new Map<string, string>();
  // `${placeId}:${placeId}` the backfill was tried for in this process.
  const backfillTried = new Set<string>();

  function skip(reason: string, day: string, extra: Obj = {}) {
    if (skipped.get(reason) === day) return;
    skipped.set(reason, day);
    log.info('diary: skip', { reason, ...extra });
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
    const diaryCfg = sectionOf(config, 'diary');
    const named = namedSchedule(diaryCfg);
    const day = named === null ? localDayKey(t, timezone) : utcDay(t);
    const plans = plansOf(store, true);
    const stored: DayPlan | undefined = plans.persona;
    if (stored && stored.day === day && Array.isArray(stored.slots)) {
      const moved = named === null ? null : rescheduled(stored, named, t);
      if (moved === null) return stored;
      plans.persona = moved;
      store.state.markDirty();
      log.info('diary: plan', { day, slots: moved.slots.length, quiet: false, rescheduled: true });
      return moved;
    }
    const hunger = nextHunger(stored, diaryCfg.windows, timezone, t, DEFAULT_GRACE_MINUTES);
    const fresh = planDay(diaryCfg, t, timezone, rng, hunger);
    const { plan, carried } = withCarriedSlots(fresh, stored, t, DEFAULT_GRACE_MINUTES);
    if (typeof stored?.lastPosted === 'number') plan.lastPosted = stored.lastPosted;
    plans.persona = plan;
    store.state.markDirty();
    log.info('diary: plan', {
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
   * The history backfilled from the place her diary is posted to (mirror.ts#diaryPlaces, the first), once per place
   * and process, while the diary unit is empty; nothing without the interface's reads or such a place.
   */
  async function backfillOnce(config: unknown) {
    const place = readMirrors(store, diaryPlaces, [])[0];
    if (typeof backfill !== 'function' || !reads || !place) return;
    const channel = { iface: place.iface, id: place.chatId };
    const key = String(channel.id);
    if (backfillTried.has(key)) return;
    backfillTried.add(key);
    try {
      if (listOf(store.getDiary()?.posts).length > 0) return;
      const count = await backfill({
        store,
        reads,
        chat: { iface: channel.iface, chatId: channel.id },
        config,
        labels: objOf(hot.prompts).labels,
      });
      log.info('diary: backfill', { placeId: channel.id, count: Number.isFinite(count) ? count : 0 });
    } catch (err) {
      log.warn('diary: backfill failed', { placeId: channel.id, error: err });
    }
  }

  /** One post through the turn runner (the diary wake), logged with its outcome; its entry published. */
  async function post(): Promise<unknown> {
    // While the turn writes its entry and until its publish, a drain leaves that entry to this path: its media is not kept yet.
    const release = mirrors?.beginEntry?.();
    try {
      return await postEntry();
    } finally {
      release?.();
    }
  }

  async function postEntry(): Promise<unknown> {
    const result = await turns.runTurn({ mode: 'diary', diary: { kind: null, forced: false } });
    const answer = objOf(result);
    const made = objOf(answer.diary);
    log.info('diary: post', {
      kind: made.kind ?? null,
      messages: made.messages ?? 0,
      picture: made.picture ?? false,
      pictures: made.pictures ?? 0,
      search: made.search ?? false,
      outcome: answer.outcome ?? null,
      ...(answer.reason ? { reason: answer.reason } : {}),
    });
    const entry = made.entry;
    if (entry && mirrors) {
      try {
        // The entry's row is in memory before its media and its publications name it.
        await settled(store);
        await mirrors.publishEntry(entry);
      } catch (err) {
        log.warn('diary: publication failed', { error: err });
      }
    }
    return result;
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    const config = hot.config;
    const t = now();
    const day = localDayKey(t, zoneOf(config));
    const blocked = sectionOf(config, 'diary').enabled === false ? 'disabled' : gate();
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
      log.info('diary: skip', { reason: 'grace', count: due.dropped.length });
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
      log.info('diary: due', { slot });
      const outcome = objOf(await post()).outcome;
      if (outcome === 'busy') {
        plan.done = plan.done.filter((done) => done !== slot);
        store.state.markDirty();
        log.info('diary: skip', { reason: 'busy', slot });
      } else if (outcome === 'spoke') {
        // Feeds the slot's window (nextHunger).
        plan.posted = [...(Array.isArray(plan.posted) ? plan.posted : []), slot];
        plan.lastPosted = slot;
        store.state.markDirty();
      }
    } finally {
      inFlight = false;
    }
  }

  function status(): DiaryStatus {
    const plan = plansOf(store, false).persona ?? null;
    const history = typeof store.getDiary === 'function' ? listOf(store.getDiary()?.posts).length : 0;
    return {
      placeId: readMirrors(store, diaryPlaces, [])[0]?.chatId ?? '',
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

  return { tick, status, stop };
}

/** Waits for the store's writes to land (`flushSettled`), when it has them. */
function settled(store: DiaryStore): Promise<unknown> {
  return typeof store.flushSettled === 'function' ? store.flushSettled({}) : Promise.resolve();
}
