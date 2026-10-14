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
// `nowMs`), and none of them touches discord.js, the disk or the model. The
// factory at the end (createDiary) is the module's edge: it ticks, keeps the
// day plan in state.json and runs the post through the turn runner.

import { canAttach, canSend, fetchHistory } from '../discord/collect.js';
import { fill } from '../discord/format.js';
import { log } from '../log.js';
import { oneLine, clampText, stripUrls } from '../memory/clamp.js';
import { MINUTE_MS, countToday, zonedDay, zonedEpoch, utcDay } from '../time.js';
/** The daily counter of diary posts in state.json (src/time.js dailyCounter / bumpDaily). */
export const DIARY_DAILY = { dayKey: 'diaryDay', countKey: 'diaryPosts' };
/** The daily counter of diary pictures in state.json (src/time.js dailyCounter / bumpDaily). */
export const DIARY_PICTURES_DAILY = { dayKey: 'diaryPicturesDay', countKey: 'diaryPictures' };

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
const DEFAULT_SEARCH_KINDS = ['news', 'facts']; // diary.searchKinds
/** The kinds that mean a picture when `diary.pictureKinds` is not a list. */
export const DEFAULT_PICTURE_KINDS = ['selfPicture', 'picture', 'meme', 'photoset', 'randomSet']; // diary.pictureKinds
/** The kinds whose post is a set of pictures when `diary.setKinds` is not a list. */
export const DEFAULT_SET_KINDS = ['photoset', 'randomSet']; // diary.setKinds
const DEFAULT_SET_PICTURES = [4, 6]; // diary.set.pictures
const DEFAULT_SET_MIN_POSTED = 2; // diary.set.minPosted
const DEFAULT_SET_SEED_SETS = 6; // diary.set.seedSets
const DEFAULT_SET_MAX_MESSAGE_BYTES = 8000000; // diary.set.maxMessageBytes
const DEFAULT_FAMILY = 'seed';

/**
 * The local date key (`YYYY-MM-DD`) of `nowMs` in `timezone` (UTC when missing).
 * @param {number} nowMs
 * @param {string} [timezone]  IANA zone name.
 * @returns {string}
 */
export function localDayKey(nowMs, timezone) {
  return zonedDay(nowMs, timezone || 'UTC');
}

/** The date key one day after `dayKey`. */
function nextDayKey(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return utcDay(Date.UTC(year, month - 1, day + 1));
}

/** A whole hour 0..24, or null. */
function hourOf(value) {
  return Number.isInteger(value) && value >= 0 && value <= 24 ? value : null;
}

/** A non-negative whole count, or 0. */
function countOf(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** `value` clamped to 0..1, or `fallback` when it is not a finite number. */
function fractionOf(value, fallback) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** The `[min, max]` post count of a window (`posts`), both whole and non-negative. */
function postRange(window) {
  const min = countOf(window?.posts?.[0]);
  return [min, Math.max(min, countOf(window?.posts?.[1]))];
}

/** The instant of `hour`:00 local on `dayKey`, 24 meaning the next day's midnight. */
function hourInstant(dayKey, hour, timezone) {
  return hour === 24 ? zonedEpoch(nextDayKey(dayKey), 0, 0, timezone) : zonedEpoch(dayKey, hour, 0, timezone);
}

/** `[start, end)` of one window on the local day `dayKey`, or null for a malformed window. A window
 * whose `to` is not after `from` ends the next day (18 -> 1 runs 18:00 to 01:00); `from === to` is a
 * whole day. */
function windowSpan(window, dayKey, timezone) {
  const from = hourOf(window?.from);
  const to = hourOf(window?.to);
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
 * @param {{ windows?: Array<{ from: number, to: number, posts: [number, number] }>, quietDayChance?: number,
 *   quietCarry?: number, hungerBoost?: number, minGapMinutes?: number, maxPerDay?: number }} cfg  config.diary
 * @param {number} nowMs
 * @param {string} [timezone]  bot.timezone
 * @param {() => number} rng
 * @param {{ hunger?: number[], quietStreak?: number }} [carry]  nextHunger's result; zeros when missing.
 * @returns {{ day: string, slots: number[], quiet: boolean, done: number[], posted: number[], hunger: number[],
 *   quietStreak: number }}  `hunger` one whole count per window, `posted` empty.
 */
export function planDay(cfg, nowMs, timezone, rng, carry = {}) {
  const zone = timezone || 'UTC';
  const day = localDayKey(nowMs, zone);
  const windows = Array.isArray(cfg?.windows) ? cfg.windows : [];
  const hunger = windows.map((_, i) => countOf(Array.isArray(carry?.hunger) ? carry.hunger[i] : 0));
  const quietStreak = countOf(carry?.quietStreak);
  const kept = { posted: [], hunger, quietStreak };
  const quietCarry = fractionOf(cfg?.quietCarry, DEFAULT_QUIET_CARRY);
  const quiet = rng() < (cfg?.quietDayChance ?? DEFAULT_QUIET_DAY_CHANCE) * quietCarry ** quietStreak;
  if (quiet) return { day, slots: [], quiet: true, done: [], ...kept };

  const boost = fractionOf(cfg?.hungerBoost, DEFAULT_HUNGER_BOOST);
  const placed = [];
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

  const gapMs = Math.max(0, cfg?.minGapMinutes ?? 90) * MINUTE_MS;
  const slots = [];
  for (const slot of placed) {
    if (slots.length > 0 && slot - slots[slots.length - 1] < gapMs) continue;
    slots.push(slot);
  }
  const cap = countOf(cfg?.maxPerDay ?? DEFAULT_MAX_PER_DAY);
  while (slots.length > cap) {
    slots.splice(Math.min(slots.length - 1, Math.floor(rng() * slots.length)), 1);
  }
  return { day, slots, quiet: false, done: [], ...kept };
}

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
 * windows list pads with 0 or drops the tail. Pure.
 * @param {{ day?: string, slots?: number[], done?: number[], posted?: number[], quiet?: boolean,
 *   hunger?: number[], quietStreak?: number }|null|undefined} previous
 * @param {Array<{ from: number, to: number, posts: [number, number] }>} windows  config.diary.windows
 * @param {string} [timezone]  bot.timezone
 * @param {number} nowMs
 * @param {number} [graceMinutes]  diary.slotGraceMinutes
 * @returns {{ hunger: number[], quietStreak: number }}
 */
export function nextHunger(previous, windows, timezone, nowMs, graceMinutes) {
  const zone = timezone || 'UTC';
  const list = Array.isArray(windows) ? windows : [];
  const zeros = { hunger: list.map(() => 0), quietStreak: 0 };
  if (!previous || typeof previous !== 'object') return zeros;
  const before = (i) => countOf(Array.isArray(previous.hunger) ? previous.hunger[i] : 0);
  const day = typeof previous.day === 'string' ? previous.day : null;
  const spanOf = (window) => (day && postRange(window)[1] > 0 ? windowSpan(window, day, zone) : null);
  if (previous.quiet === true) {
    return {
      hunger: list.map((window, i) => (spanOf(window) ? before(i) + 1 : 0)),
      quietStreak: countOf(previous.quietStreak) + 1,
    };
  }
  if (!Array.isArray(previous.posted) || !Array.isArray(previous.slots)) return zeros;
  const posted = new Set(previous.posted);
  const done = new Set(Array.isArray(previous.done) ? previous.done : []);
  const graceMs = Math.max(0, graceMinutes ?? DEFAULT_GRACE_MINUTES) * MINUTE_MS;
  const fed = (slot) => posted.has(slot) || (!done.has(slot) && slot >= nowMs - graceMs);
  const hunger = list.map((window, i) => {
    const span = spanOf(window);
    if (!span) return 0;
    const [start, end] = span;
    const inside = previous.slots.filter((slot) => Number.isFinite(slot) && slot >= start && slot < end);
    return inside.some(fed) ? 0 : before(i) + 1;
  });
  return { hunger, quietStreak: 0 };
}

/**
 * The slot of `plan` to run at `nowMs`. Among the slots at or before `nowMs`
 * that are not in `plan.done`, those older than `graceMinutes` are `dropped`
 * (the caller marks them done without firing them) and the oldest remaining
 * one is the `slot`. Null when nothing is due and nothing is dropped;
 * `{ slot: null, dropped }` when every due slot was missed.
 * @param {{ slots?: number[], done?: number[] }} plan
 * @param {number} nowMs
 * @param {number} [graceMinutes]  diary.slotGraceMinutes
 * @returns {{ slot: number|null, dropped: number[] }|null}
 */
export function dueSlot(plan, nowMs, graceMinutes) {
  const done = new Set(Array.isArray(plan?.done) ? plan.done : []);
  const graceMs = Math.max(0, graceMinutes ?? DEFAULT_GRACE_MINUTES) * MINUTE_MS;
  const due = (Array.isArray(plan?.slots) ? plan.slots : [])
    .filter((slot) => Number.isFinite(slot) && slot <= nowMs && !done.has(slot))
    .sort((a, b) => a - b);
  const dropped = due.filter((slot) => nowMs - slot > graceMs);
  const live = due.filter((slot) => nowMs - slot <= graceMs);
  if (live.length === 0 && dropped.length === 0) return null;
  return { slot: live[0] ?? null, dropped };
}

/** The `[key, weight]` pairs of `kinds` with a finite positive weight, in key order. */
function weightedKinds(kinds) {
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) return [];
  return Object.entries(kinds).filter(([, weight]) => Number.isFinite(weight) && weight > 0);
}

/**
 * One kind key drawn from `kinds` (`{ key: weight }`, `diary.kinds`) in
 * proportion to its weight; a kind with a weight of 0 or less is never drawn.
 * Null when no kind has a positive weight.
 * @param {Record<string, number>} kinds
 * @param {() => number} rng
 * @returns {string|null}
 */
export function pickKind(kinds, rng) {
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

/**
 * Whether `kind` is a picture kind: listed in `pictureKinds` (`diary.pictureKinds`),
 * DEFAULT_PICTURE_KINDS when that is not a list.
 * @param {string|null} kind
 * @param {string[]|undefined} pictureKinds
 * @returns {boolean}
 */
export function isPictureKind(kind, pictureKinds) {
  const drawable = Array.isArray(pictureKinds) ? pictureKinds : DEFAULT_PICTURE_KINDS;
  return typeof kind === 'string' && drawable.includes(kind);
}

/**
 * Whether `kind` posts a set of pictures: listed in `setKinds`
 * (`diary.setKinds`), DEFAULT_SET_KINDS when that is not a list.
 * @param {string|null} kind
 * @param {string[]|null|undefined} setKinds
 * @returns {boolean}
 */
export function isSetKind(kind, setKinds) {
  const sets = Array.isArray(setKinds) ? setKinds : DEFAULT_SET_KINDS;
  return typeof kind === 'string' && sets.includes(kind);
}

/**
 * The settings of a set post (`diary.set`), each one replaced by its default
 * when missing or invalid: `pictures` `[min, max]` whole counts (max never
 * below min; the engine renders at most `max` <draw> tags, `min` is for the
 * prompt), `minPosted` (fewer pictures generated and nothing is posted; at
 * least 1), `seedSets` (the compose request's seed combinations, 0 allowed)
 * and `maxMessageBytes` (the attachment bytes of one message, positive).
 * @param {object|null|undefined} diaryCfg  config.diary
 * @returns {{ pictures: [number, number], minPosted: number, seedSets: number, maxMessageBytes: number }}
 */
export function setSettings(diaryCfg) {
  const set = diaryCfg?.set && typeof diaryCfg.set === 'object' ? diaryCfg.set : {};
  const whole = (value, min) => (Number.isFinite(value) && value >= min ? Math.floor(value) : null);
  const range = Array.isArray(set.pictures) ? set.pictures : [];
  const low = whole(range[0], 1);
  const high = whole(range[1], 1);
  const pictures = low !== null && high !== null ? [low, Math.max(low, high)] : [...DEFAULT_SET_PICTURES];
  return {
    pictures,
    minPosted: whole(set.minPosted, 1) ?? DEFAULT_SET_MIN_POSTED,
    seedSets: whole(set.seedSets, 0) ?? DEFAULT_SET_SEED_SETS,
    maxMessageBytes: whole(set.maxMessageBytes, 1) ?? DEFAULT_SET_MAX_MESSAGE_BYTES,
  };
}

/**
 * `kinds` (`diary.kinds`) without its picture kinds (isPictureKind), the other
 * weights kept; a new object, the input untouched. What the planner and the
 * random fallback get while a post may not carry a picture.
 * @param {Record<string, number>|null|undefined} kinds
 * @param {string[]|undefined} pictureKinds  diary.pictureKinds
 * @returns {Record<string, number>}
 */
export function withoutPictureKinds(kinds, pictureKinds) {
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) return {};
  return Object.fromEntries(Object.entries(kinds).filter(([key]) => !isPictureKind(key, pictureKinds)));
}

/**
 * The plan request's answer, normalised. `kind` must be a key of `kinds` with
 * a positive weight, else the whole answer is replaced by a weighted random
 * kind (pickKind; null when no kind is weighted) with an empty brief and
 * search (`fallback: true`). Otherwise `brief` is one line, at most 300
 * characters; `search` is kept only for a kind in `searchKinds`. With
 * `pictureAllowed`, a kind in `pictureKinds` always draws (a picture kind
 * means a picture, whatever the answer said) and any other kind draws only
 * when the answer says `picture: true`; without it nothing draws.
 * @param {unknown} parsed  The JSON the model answered (untrusted).
 * @param {Record<string, number>} kinds  diary.kinds
 * @param {{ pictureAllowed?: boolean, searchKinds?: string[], pictureKinds?: string[] }} opts
 *   searchKinds: diary.searchKinds; pictureKinds: diary.pictureKinds
 * @param {() => number} rng
 * @returns {{ kind: string|null, brief: string, search: string, picture: boolean, fallback: boolean }}
 */
export function validatePlan(parsed, kinds, { pictureAllowed = false, searchKinds, pictureKinds } = {}, rng) {
  const answer = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const valid = weightedKinds(kinds).some(([key]) => key === answer.kind);
  const drawable = Array.isArray(pictureKinds) ? pictureKinds : DEFAULT_PICTURE_KINDS;
  if (!valid) {
    const kind = pickKind(kinds, rng);
    const picture = pictureAllowed === true && kind !== null && drawable.includes(kind);
    return { kind, brief: '', search: '', picture, fallback: true };
  }
  const picture = pictureAllowed === true && (drawable.includes(answer.kind) || answer.picture === true);
  const searchable = Array.isArray(searchKinds) ? searchKinds : DEFAULT_SEARCH_KINDS;
  const brief = typeof answer.brief === 'string' ? clampText(oneLine(answer.brief), BRIEF_CHARS, { tolerance: 1 }) : '';
  const search = typeof answer.search === 'string' && searchable.includes(answer.kind) ? oneLine(answer.search) : '';
  return { kind: answer.kind, brief, search, picture, fallback: false };
}

/** The picture suffix of one post: the scene, `pictureUnknown` for a picture with no recorded
 * scene (`true` or ''), nothing for no picture. A set (`pictures` above 1) shows its first
 * scene with the count (`labels.diary.pictureSet`; `picture` when that label is missing). */
function pictureSuffix(picture, labels, pictures) {
  const count = countOf(pictures);
  if (typeof picture === 'string' && picture.trim()) {
    if (count > 1 && labels.diary?.pictureSet) return fill(labels.diary.pictureSet, { count, scene: oneLine(picture) });
    return fill(labels.diary?.picture, { scene: oneLine(picture) });
  }
  if (picture === true || picture === '') return fill(labels.diary?.picture, { scene: labels.diary?.pictureUnknown ?? '' });
  return '';
}

/**
 * The body of the `<diary>` block: `labels.diary.intro`, then one
 * `labels.diary.line` per post (`{date}` the post's local date in
 * `timezone`, `{kind}` its kind key or `labels.diary.kindUnknown`, `{gist}`)
 * with `labels.diary.picture` appended when the post had a picture
 * (`labels.diary.pictureSet` with the count for a set: `pictures` above 1). The
 * newest `max` posts, oldest first. '' when there is no post.
 * @param {Array<{ at: number, kind: string|null, gist: string, picture?: string|boolean|null, pictures?: number }>} posts  Oldest first.
 * @param {object} labels
 * @param {{ timezone?: string, max?: number }} [opts]  max: diary.historyPosts
 * @returns {string}
 */
export function renderDiaryBlock(posts, labels, { timezone, max } = {}) {
  const list = Array.isArray(posts) ? posts : [];
  const limit = countOf(max ?? DEFAULT_HISTORY_POSTS);
  const shown = limit > 0 ? list.slice(-limit) : [];
  if (shown.length === 0) return '';
  const lines = shown.map((post) => {
    const date = Number.isFinite(post?.at) ? localDayKey(post.at, timezone) : '';
    const kind = typeof post?.kind === 'string' && post.kind ? post.kind : labels.diary?.kindUnknown ?? '';
    const line = fill(labels.diary?.line, { date, kind, gist: oneLine(post?.gist) });
    return line + pictureSuffix(post?.picture, labels, post?.pictures);
  });
  return [labels.diary?.intro, ...lines].filter(Boolean).join('\n');
}

/**
 * The body of the `<kinds>` block: `labels.diary.kinds`, then one
 * `labels.diary.kindLine` per kind with a positive weight (`{key}`,
 * `{weight}`, `{count}` its uses among the newest `window` posts, `{window}`
 * how many posts that is). '' when no kind is weighted.
 * @param {Record<string, number>} kinds  diary.kinds
 * @param {Array<{ kind: string|null }>} posts  Oldest first.
 * @param {object} labels
 * @param {{ window?: number }} [opts]  window: diary.historyPosts
 * @returns {string}
 */
export function renderKindsBlock(kinds, posts, labels, { window } = {}) {
  const entries = weightedKinds(kinds);
  if (entries.length === 0) return '';
  const limit = countOf(window ?? DEFAULT_HISTORY_POSTS);
  const recent = limit > 0 && Array.isArray(posts) ? posts.slice(-limit) : [];
  const lines = entries.map(([key, weight]) =>
    fill(labels.diary?.kindLine, {
      key,
      weight,
      count: recent.filter((post) => post?.kind === key).length,
      window: recent.length,
    }),
  );
  return [labels.diary?.kinds, ...lines].filter(Boolean).join('\n');
}

/**
 * The seed families of `prompts['diary-seeds']`: a `# name` line starts a
 * family, every other non-blank line (trimmed) is one seed of the current
 * family; lines before the first header belong to the family `seed`. Families
 * keep their header order; a header with no lines is an empty family.
 * @param {unknown} text
 * @returns {Record<string, string[]>}
 */
export function parseSeedFamilies(text) {
  const families = {};
  if (typeof text !== 'string') return families;
  let current = null;
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
 * `sets` seed combinations: each one random line of every non-empty family,
 * in the families' order. [] when no family has a line or `sets` is not a
 * positive count.
 * @param {Record<string, string[]>} families  parseSeedFamilies
 * @param {number} sets  diary.seedSets
 * @param {() => number} rng
 * @returns {string[][]}
 */
export function pickSeeds(families, sets, rng) {
  const lists = Object.values(families && typeof families === 'object' ? families : {}).filter(
    (lines) => Array.isArray(lines) && lines.length > 0,
  );
  const count = countOf(sets);
  if (lists.length === 0 || count === 0) return [];
  const result = [];
  for (let i = 0; i < count; i += 1) {
    result.push(lists.map((lines) => lines[Math.min(lines.length - 1, Math.floor(rng() * lines.length))]));
  }
  return result;
}

/**
 * The body of the `<seeds>` block: `labels.diary.seeds`, then one `- a; b; c`
 * line per combination. '' when there is none.
 * @param {string[][]} sets  pickSeeds
 * @param {object} labels
 * @returns {string}
 */
export function renderSeedsBlock(sets, labels) {
  const lines = (Array.isArray(sets) ? sets : [])
    .filter((set) => Array.isArray(set) && set.length > 0)
    .map((set) => `- ${set.join('; ')}`);
  if (lines.length === 0) return '';
  return [labels.diary?.seeds, ...lines].filter(Boolean).join('\n');
}

/**
 * The owner's topic for a forced post (`/nep diary post topic`): one line,
 * cut at a word boundary to at most 1000 characters. Null for a missing,
 * non-string or blank topic.
 * @param {unknown} text
 * @returns {string|null}
 */
export function diaryTopic(text) {
  if (typeof text !== 'string') return null;
  return clampText(oneLine(text), TOPIC_CHARS, { tolerance: 1 }) || null;
}

/**
 * The body of the plan request's `<topic>` block: `labels.diary.topic`, then
 * the topic (diaryTopic). '' without a topic.
 * @param {unknown} topic
 * @param {object} labels
 * @returns {string}
 */
export function renderTopicBlock(topic, labels) {
  const text = diaryTopic(topic);
  if (!text) return '';
  return [labels?.diary?.topic, text].filter(Boolean).join('\n');
}

// A diary post's text loses its URLs through the one shared sanitizer (src/memory/clamp.js#stripUrls).
export { stripUrls };

/**
 * A post's one-line gist for diary.json: whitespace collapsed, then cut at a
 * word boundary to at most `chars` characters (diary.gistChars).
 * @param {unknown} text
 * @param {number} [chars]
 * @returns {string}
 */
export function gistOf(text, chars) {
  return clampText(oneLine(text), chars ?? DEFAULT_GIST_CHARS, { tolerance: 1 });
}

/**
 * The day plan of the new local day `fresh`, with the slots of `previous` (the
 * plan of an earlier day) that are not done and still in the future or
 * within the grace merged into it: a window such as 18 -> 1 spills past local
 * midnight, and its slots after midnight belong to the plan that placed them.
 * Pure.
 */
function withCarriedSlots(fresh, previous, nowMs, graceMinutes) {
  if (!previous || !Array.isArray(previous.slots)) return { plan: fresh, carried: 0 };
  const done = new Set(Array.isArray(previous.done) ? previous.done : []);
  const graceMs = Math.max(0, graceMinutes ?? DEFAULT_GRACE_MINUTES) * MINUTE_MS;
  const carried = previous.slots.filter((slot) => Number.isFinite(slot) && !done.has(slot) && slot >= nowMs - graceMs);
  if (carried.length === 0) return { plan: fresh, carried: 0 };
  const slots = [...new Set([...carried, ...fresh.slots])].sort((a, b) => a - b);
  return { plan: { ...fresh, slots }, carried: carried.length };
}

/** Whether the bot may post a diary entry in `channel`: send messages and attach files. */
function writable(channel) {
  try {
    return canSend(channel) && canAttach(channel);
  } catch {
    return false;
  }
}

/**
 * The diary's scheduler and its owner-facing edge. `tick()` (every 30 s,
 * src/index.js) does nothing while `features.diary` is false (a missing key
 * counts as on), no `diary.channelId` is set, the bot is paused or a warmup
 * runs (`diary: skip` with `reason` `off`, `no-channel`, `paused`, `warmup`,
 * once per local day and reason). Otherwise it keeps the day plan of the
 * served guild in state.json (`diary[guildId] = { day, slots, done, quiet,
 * posted, hunger, quietStreak }`, `day` the local date in `bot.timezone`):
 * nextHunger from the stored plan, then planDay once per local day (`diary:
 * plan` with `hunger` and `quietStreak`), the not-done slots of the previous plan still ahead or
 * within the grace merged in. A due slot (dueSlot, `diary.slotGraceMinutes`)
 * is marked done before its post runs; slots missed by more than the grace
 * are marked done unfired (`diary: skip`, `grace`). The post needs the
 * channel (`client.channels`, the served guild's; else `no-channel`), Send
 * Messages and Attach Files there (`not-writable`) and the day's posts under
 * `diary.maxPerDay` (`cap`); then, with an empty history, `backfill` once per
 * channel and process (`diary: backfill` with `count`), and
 * `turns.runTurn({ channel, mode: 'diary', diary: { kind, forced } })`
 * (`diary: due`, then `diary: post` with the outcome, its `reason` when it has one, and the
 * pictures posted). A `busy` outcome
 * un-marks the slot, so the next tick retries it within the grace; a `spoke`
 * one appends it to the plan's `posted` (what feeds a window). One post
 * at a time. `force({ kind, topic })` runs one post now, outside the plan and
 * the quiet day, under the same rails; a topic (diaryTopic: one line, 1000
 * characters at most; blank is none) reaches the turn as `diary.topic`, and
 * no topic leaves the field out; while another turn holds the one attention
 * (`turns.isAnyBusy()`, or a `busy` outcome) it waits for `turns.waitIdle()`
 * at most `diary.forceWaitMs` and posts then, `{ outcome: 'busy' }` when the
 * turn still runs. Hot values are read at every call.
 * @param {{ hot: object, store: object, client: object, turns: object, getGuildId: () => (string|null),
 *   isWarmingUp?: () => boolean, backfill?: ((args: object) => Promise<number>)|null,
 *   rng?: () => number, now?: () => number, delay?: (ms: number) => Promise<void> }} deps
 *   `delay`: resolves after `ms` (a timer that never holds the process open); injected by tests.
 *   `backfill`: src/behavior/diary.js#backfillDiary's shape (`{ store, channel, guildId, selfId,
 *   config, labels }` -> the count written); null skips the backfill.
 * @returns {{ tick: () => Promise<void>, force: (opts?: { kind?: string|null, topic?: string|null }) => Promise<object>,
 *   status: () => { channelId: string, day: string|null, slots: number[], done: number[], quiet: boolean,
 *   hunger: number[], quietStreak: number, posts: number, pictures: number, history: number }, stop: () => void }}
 */
export function createDiary({ hot, store, client, turns, getGuildId, isWarmingUp = () => false, backfill = null, rng = Math.random, now = Date.now, delay = unrefDelay }) {
  let stopped = false;
  let inFlight = false;
  // reason -> the local day it was last logged on: one `diary: skip` per reason and day.
  const skipped = new Map();
  // `${guildId}:${channelId}` the backfill was tried for in this process.
  const backfillTried = new Set();

  function skip(reason, day, extra = {}) {
    if (skipped.get(reason) === day) return;
    skipped.set(reason, day);
    log.info('diary: skip', { reason, ...extra });
  }

  function warming() {
    try {
      return isWarmingUp() === true;
    } catch {
      return false;
    }
  }

  /** Why no post may run now, before any channel is looked at, or null. */
  function gate(config) {
    if (config.features?.diary === false) return 'off';
    if (!config.diary?.channelId) return 'no-channel';
    if (store.state.data.paused) return 'paused';
    if (warming()) return 'warmup';
    return null;
  }

  /** The plan of the local day of `t` for `guildId`, planned (and stored) when the stored one is older. */
  function currentPlan(guildId, config, t) {
    const timezone = config.bot?.timezone || 'UTC';
    const day = localDayKey(t, timezone);
    const plans = (store.state.data.diary ??= {});
    const stored = plans[guildId];
    if (stored && stored.day === day && Array.isArray(stored.slots)) return stored;
    const hunger = nextHunger(stored, config.diary?.windows, timezone, t, config.diary?.slotGraceMinutes);
    const fresh = planDay(config.diary ?? {}, t, timezone, rng, hunger);
    const { plan, carried } = withCarriedSlots(fresh, stored, t, config.diary?.slotGraceMinutes);
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

  /** The diary channel of `guildId`, or null: the client's cache, else a fetch; never another guild's. */
  async function diaryChannel(channelId, guildId) {
    let channel = client.channels?.cache?.get?.(channelId) ?? null;
    if (!channel) {
      try {
        channel = (await client.channels?.fetch?.(channelId)) ?? null;
      } catch {
        channel = null;
      }
    }
    return channel && channel.guild?.id === guildId ? channel : null;
  }

  /** Why the post may not run in `channel` now (`no-channel`, `not-writable`, `cap`), or null. */
  function postBlock(channel, config, t) {
    if (!channel) return 'no-channel';
    if (!writable(channel)) return 'not-writable';
    if (countToday(store.state.data, DIARY_DAILY, t) >= (config.diary?.maxPerDay ?? DEFAULT_MAX_PER_DAY)) return 'cap';
    return null;
  }

  /** The history backfilled from the channel, once per channel and process, while diary.json is empty. */
  async function backfillOnce(channel, guildId, config) {
    if (typeof backfill !== 'function') return;
    const key = `${guildId}:${channel.id}`;
    if (backfillTried.has(key)) return;
    backfillTried.add(key);
    try {
      if ((store.getDiary(guildId)?.posts ?? []).length > 0) return;
      const count = await backfill({ store, channel, guildId, selfId: client.user?.id ?? null, config, labels: hot.prompts?.labels });
      log.info('diary: backfill', { guildId, channelId: channel.id, count: Number.isFinite(count) ? count : 0 });
    } catch (err) {
      log.warn('diary: backfill failed', { guildId, channelId: channel.id, error: err });
    }
  }

  /** One post through the turn runner, logged with its outcome. */
  async function post(channel, guildId, { kind, topic = null, forced }) {
    const diary = { kind: kind ?? null, ...(topic ? { topic } : {}), forced };
    const result = await turns.runTurn({ channel, mode: 'diary', diary });
    log.info('diary: post', {
      guildId,
      channelId: channel.id,
      kind: result?.diary?.kind ?? kind ?? null,
      messages: result?.diary?.messages ?? 0,
      picture: result?.diary?.picture ?? false,
      pictures: result?.diary?.pictures ?? 0,
      search: result?.diary?.search ?? false,
      outcome: result?.outcome ?? null,
      ...(result?.reason ? { reason: result.reason } : {}),
      forced,
      ...(result?.dryRun ? { dryRun: true } : {}),
    });
    return result;
  }

  async function tick() {
    if (stopped || inFlight) return;
    const config = hot.config;
    const t = now();
    const day = localDayKey(t, config.bot?.timezone || 'UTC');
    const blocked = gate(config);
    if (blocked) {
      skip(blocked, day);
      return;
    }
    const guildId = getGuildId();
    if (!guildId) return;
    const plan = currentPlan(guildId, config, t);
    const due = dueSlot(plan, t, config.diary?.slotGraceMinutes);
    if (!due) return;
    if (due.dropped.length > 0) {
      plan.done = [...(plan.done ?? []), ...due.dropped];
      store.state.markDirty();
      log.info('diary: skip', { reason: 'grace', count: due.dropped.length });
    }
    if (due.slot === null) return;

    inFlight = true;
    try {
      const channel = await diaryChannel(config.diary.channelId, guildId);
      const block = postBlock(channel, config, t);
      if (block) {
        // Not this slot: it is spent, the next one tries again.
        plan.done = [...(plan.done ?? []), due.slot];
        store.state.markDirty();
        skip(block, day);
        return;
      }
      await backfillOnce(channel, guildId, config);
      if (stopped) return;
      // Marked before the turn runs, like the spontaneous scheduler reschedules first.
      plan.done = [...(plan.done ?? []), due.slot];
      store.state.markDirty();
      log.info('diary: due', { guildId, slot: due.slot });
      const result = await post(channel, guildId, { kind: null, forced: false });
      if (result?.outcome === 'busy') {
        plan.done = plan.done.filter((slot) => slot !== due.slot);
        store.state.markDirty();
        log.info('diary: skip', { reason: 'busy', slot: due.slot });
      } else if (result?.outcome === 'spoke') {
        // Feeds the slot's window (nextHunger); force() never records here.
        plan.posted = [...(Array.isArray(plan.posted) ? plan.posted : []), due.slot];
        store.state.markDirty();
      }
    } finally {
      inFlight = false;
    }
  }

  async function force({ kind = null, topic = null } = {}) {
    const config = hot.config;
    const t = now();
    const blocked = gate(config);
    if (blocked === 'paused') return { outcome: 'paused' };
    if (blocked) return { outcome: 'not-now', reason: blocked };
    const guildId = getGuildId();
    if (!guildId) return { outcome: 'not-now', reason: 'no-guild' };
    const channel = await diaryChannel(config.diary.channelId, guildId);
    const block = postBlock(channel, config, t);
    if (block === 'cap') {
      const cap = config.diary?.maxPerDay ?? DEFAULT_MAX_PER_DAY;
      return { outcome: 'refused', reason: 'cap', limit: { key: 'diary.maxPerDay', used: countToday(store.state.data, DIARY_DAILY, t), cap } };
    }
    if (block) return { outcome: 'not-now', reason: block };
    await backfillOnce(channel, guildId, config);
    const params = { kind: typeof kind === 'string' && kind ? kind : null, topic: diaryTopic(topic), forced: true };
    // One attention: a running turn is waited for (diary.forceWaitMs at most), once.
    let waited = false;
    if (turns.isAnyBusy?.() === true) {
      waited = true;
      if (!(await waitIdle(config))) return { outcome: 'busy' };
    }
    const result = await post(channel, guildId, params);
    if (result?.outcome !== 'busy' || waited) return result;
    if (!(await waitIdle(config))) return { outcome: 'busy' };
    return post(channel, guildId, params);
  }

  /** Whether the turn runner went idle within `diary.forceWaitMs` (read from `config`, the live one). */
  async function waitIdle(config) {
    if (typeof turns.waitIdle !== 'function') return false;
    const cap = config.diary?.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS;
    const idle = await Promise.race([turns.waitIdle().then(() => true), delay(cap).then(() => false)]);
    return idle && turns.isAnyBusy?.() !== true;
  }

  function status() {
    const config = hot.config;
    const t = now();
    const guildId = getGuildId();
    const plan = guildId ? (store.state.data.diary?.[guildId] ?? null) : null;
    const history = guildId && typeof store.getDiary === 'function' ? (store.getDiary(guildId)?.posts ?? []).length : 0;
    return {
      channelId: config.diary?.channelId || '',
      day: plan?.day ?? null,
      slots: Array.isArray(plan?.slots) ? [...plan.slots] : [],
      done: Array.isArray(plan?.done) ? [...plan.done] : [],
      quiet: plan?.quiet === true,
      hunger: Array.isArray(plan?.hunger) ? plan.hunger.map(countOf) : [],
      quietStreak: countOf(plan?.quietStreak),
      posts: countToday(store.state.data, DIARY_DAILY, t),
      pictures: countToday(store.state.data, DIARY_PICTURES_DAILY, t),
      history,
    };
  }

  function stop() {
    stopped = true;
  }

  return { tick, force, status, stop };
}

/**
 * The diary's memory start: when the guild's `diary.json` has no posts, read up to `diary.historyPosts`
 * of the persona's own messages from the diary channel (REST, oldest first) and store them with
 * `kind: null`, a one-line gist, and `labels.diary.pictureUnknown` as the scene of a message that
 * carried a picture. A history that already has posts is left alone (the posts are never rewritten by
 * code). This and the factory are the module's Discord-aware edge; everything above stays pure.
 * @param {{ store: object, channel: object, guildId: string, selfId: string, config: object,
 *   labels: object, fetchHistoryImpl?: typeof fetchHistory }} deps  `config` is the live merged
 *   config (`diary`, `media` read now); `labels` the live labels.
 * @returns {Promise<number>}  The number of posts written (0 when the history was not empty).
 */
export async function backfillDiary({ store, channel, guildId, selfId, config, labels, fetchHistoryImpl = fetchHistory }) {
  if (store.getDiary(guildId).posts.length > 0) return 0;
  const max = config?.diary?.historyPosts ?? DEFAULT_HISTORY_POSTS;
  const gistChars = config?.diary?.gistChars ?? DEFAULT_GIST_CHARS;
  const history = await fetchHistoryImpl(channel, {
    limit: max,
    selfId,
    embedTextChars: config?.media?.embedTextChars,
    videoSites: config?.media?.video?.sites,
    maxUrlChars: config?.context?.maxUrlChars,
  });
  const posts = history
    .filter((message) => message.self === true)
    .map((message) => ({
      at: message.ts,
      kind: null,
      gist: gistOf(message.content, gistChars),
      picture: (message.attachments ?? []).some((a) => a.kind === 'image') ? (labels?.diary?.pictureUnknown ?? '') : null,
      messageIds: [message.id],
      search: null,
    }));
  if (posts.length === 0) return 0;
  store.setDiaryPosts(guildId, posts, { max });
  log.info('diary: backfill', { count: posts.length });
  return posts.length;
}

/** A delay whose timer never keeps the process alive (createDiary's default `delay`). */
function unrefDelay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
