// The focus set (spec 2026-10-24-memory-schema-v7, section 5; section 11's smaller resolutions on focus override it):
// the people her own attention is on, `close` (up to `focus.size`, 24) and `exploring` (up to `focus.exploring`, 4
// candidates outside the close set). Schema v10. Focus governs her attention (the heartbeat's people view first), never
// recognition: a person who speaks loads as before whatever their bucket.
//
//   recountDaily(handle, { from, to })   `relationship_daily` for the UTC days from `from` through `to`, counted from
//       `sources` again (the rows of those days are replaced): a line by their account that is addressed to her
//       (`direct`) or replies to a line of hers counts `addressed_by_them`; a line of hers that replies to theirs or names
//       them (`mentions`) counts `addressed_by_her`; `meaningful` is 1 when both happened that day in that audience. An
//       account is a person through a verified link valid at the line's time (an account two people share is nobody),
//       and a merged person counts for its survivor. Each line counts once per person and side, by its message (all its
//       revisions are one line): a recount is idempotent and a merge never counts a line twice.
//   recompute(handle, { now, config })   the close and exploring sets from the score (policy `focus.policyVersion`, 1):
//       0.55 affinity + 0.15 reciprocity + 0.10 shared interest + 0.10 recency (half-life `recencyHalfLifeDays` 60 of the
//       last meaningful contact) + 0.10 consistency (distinct meaningful days in `consistencyDays` 28, capped at
//       `consistencyCap`) + novelty (at most `noveltyMax` 0.12, half-life `noveltyHalfLifeDays` 14 from the first
//       meaningful exchange, none with a negative affinity). Affinity is today's `people.affinity` (-100..100 mapped to
//       0..1; none: 0.5 and no entry). Reciprocity and shared interest are 0.5 until her memory sessions write
//       relationship claims; the weights and thresholds live in the config (`focus`).
//   runFocusDay(handle, { now, config })   both, for yesterday and today, then the recomputation (the daily job).
//   focusView(db, { iface })   the close and exploring sets as member ids of an interface, for the heartbeat (internal).
//   closePeople(db)   the close set as person ids, the best first, for her memory session's description reviews (internal).
//
// The rules of a recomputation (pure: decideFocus):
//   - precedence: exclude > bot > pin > settling. An excluded person is never in a bucket; a person all of whose
//     verified accounts are bots is never close; a pinned person is close (its slot is the cap's: pins over capacity
//     are reported as `over_capacity` events and the cap is not widened); a member that has been close less than
//     `settleDays` (21) days cannot be replaced by a challenger;
//   - a negative affinity does not hold a close slot (unless pinned) and never brings novelty;
//   - entry: affinity at least `entryAffinity` (0.60, mapped); a challenger must beat the lowest replaceable member by
//     `margin` (0.08) at recomputations at least `confirmHours` (24) apart with no recomputation between where it did
//     not (a `challenge` event opens the run, a `challenge_lapsed` one ends it); a free slot is taken the same way with
//     the entry gate as the bar. At most `maxMovesPerWeek` (2) moves in any 7 days: a free slot taken is one move, a
//     replacement (one leaves, one enters) is one move; forced exits (exclusion, bot, negative affinity) and pins are
//     not moves. The very first recomputation (no member and no event ever) seeds the close set directly;
//   - exploring: the best scored people outside the close set with at least one meaningful exchange, a non-negative
//     affinity, not excluded and not bots; recomputed freely.
// `focus_members` holds the sets only; `focus_events` (append-only) holds every change of bucket with its reason and the
// challenges. Both are internal-only (docs/memory.md): no outward reader selects from them.

import { DAY_MS, HOUR_MS, utcDay } from '../../time.js';
import { nativeAuthorityOf, survivorOf } from './ids.js';

/** The defaults of `focus` (config.json carries the same). */
export const FOCUS_DEFAULTS = Object.freeze({
  policyVersion: 1,
  size: 24,
  exploring: 4,
  exploringShare: 0.15,
  entryAffinity: 0.6,
  margin: 0.08,
  confirmHours: 24,
  maxMovesPerWeek: 2,
  settleDays: 21,
  weights: Object.freeze({ affinity: 0.55, reciprocity: 0.15, sharedInterest: 0.1, recency: 0.1, consistency: 0.1 }),
  noveltyMax: 0.12,
  noveltyHalfLifeDays: 14,
  recencyHalfLifeDays: 60,
  consistencyDays: 28,
  consistencyCap: 8,
});

/** Event reasons that are a move (counted against `maxMovesPerWeek`). */
export const MOVE_REASONS = Object.freeze(['free_slot', 'challenge_won']);
/** The neutral value of an input no writer fills yet (reciprocity, shared interest). */
const NEUTRAL = 0.5;
const WEEK_MS = 7 * DAY_MS;

const dbOf = (handle) => handle?.db ?? handle;
const txOf = (handle) => (typeof handle?.transaction === 'function' ? (fn) => handle.transaction(fn) : (fn) => fn());
const isoOf = (ms) => new Date(ms).toISOString();
const msOf = (value) => (Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN);
const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** The focus settings of this moment (`focus` in the live config), every value checked. */
export function focusSettings(config) {
  const given = config?.focus ?? {};
  const d = FOCUS_DEFAULTS;
  const num = (value, fallback, min = 0) => (Number.isFinite(value) && value >= min ? value : fallback);
  const whole = (value, fallback, min = 0) => (Number.isInteger(value) && value >= min ? value : fallback);
  const w = given.weights ?? {};
  return {
    policyVersion: whole(given.policyVersion, d.policyVersion, 1),
    size: whole(given.size, d.size),
    exploring: whole(given.exploring, d.exploring),
    exploringShare: clamp01(num(given.exploringShare, d.exploringShare)),
    entryAffinity: clamp01(num(given.entryAffinity, d.entryAffinity)),
    margin: num(given.margin, d.margin),
    confirmHours: num(given.confirmHours, d.confirmHours),
    maxMovesPerWeek: whole(given.maxMovesPerWeek, d.maxMovesPerWeek),
    settleDays: num(given.settleDays, d.settleDays),
    weights: {
      affinity: num(w.affinity, d.weights.affinity),
      reciprocity: num(w.reciprocity, d.weights.reciprocity),
      sharedInterest: num(w.sharedInterest, d.weights.sharedInterest),
      recency: num(w.recency, d.weights.recency),
      consistency: num(w.consistency, d.weights.consistency),
    },
    noveltyMax: num(given.noveltyMax, d.noveltyMax),
    noveltyHalfLifeDays: num(given.noveltyHalfLifeDays, d.noveltyHalfLifeDays, Number.MIN_VALUE),
    recencyHalfLifeDays: num(given.recencyHalfLifeDays, d.recencyHalfLifeDays, Number.MIN_VALUE),
    consistencyDays: whole(given.consistencyDays, d.consistencyDays, 1),
    consistencyCap: num(given.consistencyCap, d.consistencyCap, Number.MIN_VALUE),
  };
}

/** Affinity (-100..100) on 0..1, or null when the person has none. */
export const affinity01 = (affinity) => (Number.isFinite(affinity) ? clamp01((affinity + 100) / 200) : null);

/**
 * The score of one person (pure). `person`: `{ affinity, lastMeaningfulAt, firstMeaningfulAt, meaningfulDays }` (times
 * in ms or ISO, `meaningfulDays` the distinct meaningful days in the consistency window).
 * @returns {{ score: number, parts: { affinity: number, reciprocity: number, sharedInterest: number, recency: number, consistency: number, novelty: number } }}
 */
export function scoreOf(person, now, settings) {
  const s = settings;
  const mapped = affinity01(person.affinity);
  const last = msOf(person.lastMeaningfulAt);
  const first = msOf(person.firstMeaningfulAt);
  const halfLife = (from, days) => 0.5 ** (Math.max(0, now - from) / (days * DAY_MS));
  const parts = {
    affinity: mapped ?? NEUTRAL,
    // Until her memory sessions write relationship claims (reciprocity, shared interest), both are neutral.
    reciprocity: NEUTRAL,
    sharedInterest: NEUTRAL,
    recency: Number.isFinite(last) ? halfLife(last, s.recencyHalfLifeDays) : 0,
    consistency: Math.min(1, Math.max(0, Number(person.meaningfulDays) || 0) / s.consistencyCap),
    novelty:
      Number.isFinite(first) && !(person.affinity < 0) ? s.noveltyMax * halfLife(first, s.noveltyHalfLifeDays) : 0,
  };
  const w = s.weights;
  const score =
    w.affinity * parts.affinity +
    w.reciprocity * parts.reciprocity +
    w.sharedInterest * parts.sharedInterest +
    w.recency * parts.recency +
    w.consistency * parts.consistency +
    parts.novelty;
  return { score: Math.round(score * 1e6) / 1e6, parts };
}

const byScore = (a, b) => b.score - a.score || (a.id < b.id ? -1 : 1);

/**
 * One recomputation (pure; see the head of this file).
 * @param {{ now: number, settings: object, people: Array<{ id: string, affinity: number|null, bot?: boolean,
 *   lastMeaningfulAt?: number|string|null, firstMeaningfulAt?: number|string|null, meaningfulDays?: number }>,
 *   members: Array<{ person_id: string, bucket: 'close'|'exploring', since: string }>,
 *   overrides: Array<{ person_id: string, kind: 'pin'|'exclude', expires_at?: string|null }>,
 *   streaks: Map<string, string>, movesInWeek: number, reported: Set<string>, history: boolean }} input
 *   `streaks`: the open challenge run of each person (the ISO time it started); `movesInWeek`: the moves of the last 7
 *   days; `reported`: the pins already reported over capacity (since they last entered by their pin); `history`:
 *   whether any member or event ever existed.
 * @returns {{ members: Array<{ person_id, bucket, since, score, policy_version, reason }>, events: Array<{ person_id, old_bucket, new_bucket, reason, extra }> }}
 */
export function decideFocus({
  now,
  settings,
  people,
  members = [],
  overrides = [],
  streaks = new Map(),
  movesInWeek = 0,
  reported = new Set(),
  history = false,
}) {
  const s = settings;
  const at = isoOf(now);
  const active = overrides.filter((o) => !o.expires_at || msOf(o.expires_at) > now);
  const pinned = new Set(active.filter((o) => o.kind === 'pin').map((o) => o.person_id));
  const excluded = new Set(active.filter((o) => o.kind === 'exclude').map((o) => o.person_id));
  const scored = new Map();
  for (const person of people) {
    if (!person || typeof person.id !== 'string') continue;
    scored.set(person.id, { ...person, ...scoreOf(person, now, s) });
  }
  const before = new Map(members.map((m) => [m.person_id, m]));
  const close = new Map();
  const reasons = new Map();
  const events = [];
  const note = (id, reason, extra = null) => reasons.set(id, { reason, extra });
  const isBot = (id) => scored.get(id)?.bot === true;
  const gate = (p) => {
    const mapped = affinity01(p.affinity);
    return mapped !== null && mapped >= s.entryAffinity && p.affinity >= 0 && !p.bot && !excluded.has(p.id);
  };
  const settling = (id) => {
    const since = msOf(close.get(id)?.since);
    return Number.isFinite(since) && now - since < s.settleDays * DAY_MS;
  };

  // The close members that stay: forced exits first (exclude > bot > pin > negative affinity).
  for (const m of members) {
    if (m.bucket !== 'close') continue;
    const p = scored.get(m.person_id);
    if (!p) {
      note(m.person_id, 'gone');
      continue;
    }
    if (excluded.has(p.id)) {
      note(p.id, 'exclude');
      continue;
    }
    if (p.bot) {
      note(p.id, 'bot');
      continue;
    }
    if (!pinned.has(p.id) && p.affinity < 0) {
      note(p.id, 'negative_affinity');
      continue;
    }
    close.set(p.id, { since: m.since });
  }

  // Pins: every pinned person who is not excluded and not a bot, within the cap: the ones already close first (a pin
  // over capacity never takes a slot from another pin), then the best scored. The rest are reported once.
  const pins = [...pinned]
    .filter((id) => scored.has(id) && !excluded.has(id) && !isBot(id))
    .map((id) => scored.get(id))
    .sort((a, b) => Number(close.has(b.id)) - Number(close.has(a.id)) || byScore(a, b));
  const fitting = pins.slice(0, s.size);
  for (const p of pins.slice(s.size)) {
    const extra = { size: s.size, pins: pins.length };
    if (close.has(p.id)) {
      close.delete(p.id);
      note(p.id, 'over_capacity', extra);
    } else if (!reported.has(p.id))
      events.push({
        person_id: p.id,
        old_bucket: before.get(p.id)?.bucket ?? null,
        new_bucket: before.get(p.id)?.bucket ?? null,
        reason: 'over_capacity',
        extra,
      });
  }
  for (const p of fitting) {
    if (close.has(p.id)) continue;
    if (close.size >= s.size) {
      // A pin displaces the lowest member that is not pinned (a settling one too: pin > settling).
      const lowest = [...close.keys()]
        .filter((id) => !pinned.has(id))
        .map((id) => scored.get(id))
        .sort(byScore)
        .at(-1);
      if (!lowest) break;
      close.delete(lowest.id);
      note(lowest.id, 'displaced_by_pin', { by: p.id });
    }
    close.set(p.id, { since: at });
    note(p.id, 'pin');
  }

  const candidates = () => [...scored.values()].filter((p) => !close.has(p.id) && gate(p)).sort(byScore);
  if (!history && members.length === 0) {
    // The first recomputation ever: the close set is seeded from today's scores, no confirmation and no move cap.
    for (const p of candidates()) {
      if (close.size >= s.size) break;
      close.set(p.id, { since: at });
      note(p.id, 'seed');
    }
  } else {
    let moves = Math.max(0, s.maxMovesPerWeek - movesInWeek);
    const beating = new Set();
    const promoted = new Set();
    for (const p of candidates()) {
      const free = close.size < s.size;
      const lowest = free
        ? null
        : [...close.keys()]
            .filter((id) => !pinned.has(id) && !settling(id))
            .map((id) => scored.get(id))
            .filter(Boolean)
            .sort(byScore)
            .at(-1);
      if (!free && !lowest) continue;
      const bar = free ? null : lowest.score + s.margin;
      if (!free && !(p.score > bar)) continue;
      beating.add(p.id);
      const since = streaks.get(p.id);
      if (!since) {
        events.push({
          person_id: p.id,
          old_bucket: before.get(p.id)?.bucket ?? null,
          new_bucket: before.get(p.id)?.bucket ?? null,
          reason: 'challenge',
          extra: { since: at, score: p.score, against: lowest?.id ?? null, bar, slot: free ? 'free' : 'replace' },
        });
        continue;
      }
      if (now - msOf(since) < s.confirmHours * HOUR_MS || moves <= 0) continue;
      if (lowest) {
        close.delete(lowest.id);
        note(lowest.id, 'replaced', { by: p.id, score: lowest.score });
      }
      close.set(p.id, { since: at });
      note(p.id, free ? 'free_slot' : 'challenge_won', { since, score: p.score, against: lowest?.id ?? null, bar });
      promoted.add(p.id);
      moves -= 1;
    }
    // A run that did not hold at this recomputation ends (a pinned or forced entry ends it too).
    for (const [id, since] of streaks) {
      if (!beating.has(id) && !promoted.has(id))
        events.push({
          person_id: id,
          old_bucket: before.get(id)?.bucket ?? null,
          new_bucket: before.get(id)?.bucket ?? null,
          reason: 'challenge_lapsed',
          extra: { since },
        });
    }
  }

  // Exploring: outside the close set, after a meaningful exchange, never negative, excluded or a bot.
  const exploring = [...scored.values()]
    .filter(
      (p) =>
        !close.has(p.id) &&
        !excluded.has(p.id) &&
        !p.bot &&
        !(p.affinity < 0) &&
        Number.isFinite(msOf(p.firstMeaningfulAt))
    )
    .sort(byScore)
    .slice(0, s.exploring);
  const exploringIds = new Set(exploring.map((p) => p.id));

  // The members after this recomputation and one event per change of bucket.
  const out = [];
  const bucketOf = (id) => (close.has(id) ? 'close' : exploringIds.has(id) ? 'exploring' : null);
  for (const [id, entry] of close) {
    const p = scored.get(id);
    const was = before.get(id);
    out.push({
      person_id: id,
      bucket: 'close',
      since: was?.bucket === 'close' ? was.since : entry.since,
      score: p.score,
      policy_version: s.policyVersion,
      reason: {
        parts: p.parts,
        ...(pinned.has(id) ? { pinned: true } : {}),
        ...(reasons.get(id) ? { last: reasons.get(id).reason } : {}),
      },
    });
  }
  for (const p of exploring) {
    const was = before.get(p.id);
    out.push({
      person_id: p.id,
      bucket: 'exploring',
      since: was?.bucket === 'exploring' ? was.since : at,
      score: p.score,
      policy_version: s.policyVersion,
      reason: { parts: p.parts },
    });
  }
  const touched = new Set([...before.keys(), ...close.keys(), ...exploringIds]);
  for (const id of [...touched].sort()) {
    const old = before.get(id)?.bucket ?? null;
    const now_ = bucketOf(id);
    if (old === now_) continue;
    const why = reasons.get(id);
    const reason = why?.reason ?? (now_ === 'exploring' ? 'explore' : now_ === null ? 'explore_end' : 'enter');
    events.push({ person_id: id, old_bucket: old, new_bucket: now_, reason, extra: why?.extra ?? null });
  }
  return {
    members: out.sort((a, b) =>
      a.bucket === b.bucket ? b.score - a.score || (a.person_id < b.person_id ? -1 : 1) : a.bucket === 'close' ? -1 : 1
    ),
    events,
  };
}

// ---------- the database ----------

/** The UTC days from `from` through `to` (ms or ISO), at most 400. */
function daysOf(from, to) {
  const start = msOf(from);
  const end = msOf(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days = [];
  for (let at = Date.parse(`${utcDay(start)}T00:00:00.000Z`); at <= end && days.length < 400; at += DAY_MS)
    days.push(utcDay(at));
  return days;
}

/** The person an account is at a time: one verified link valid then (none, or several people: nobody), its survivor. */
function personAt(db, cache, account, atIso) {
  const key = `${account}\u0000${atIso.slice(0, 10)}`;
  if (cache.has(key)) return cache.get(key);
  const rows = db
    .prepare(
      `SELECT DISTINCT person_id FROM account_person_links WHERE account_id = ? AND state = 'verified'
    AND (valid_from_at IS NULL OR valid_from_at <= ?) AND (valid_to_at IS NULL OR ? < valid_to_at)`
    )
    .all(account, atIso, atIso);
  const people = [...new Set(rows.map((row) => survivorOf(db, row.person_id)))];
  const person =
    people.length === 1 && db.prepare('SELECT 1 AS ok FROM people WHERE id = ?').get(people[0]) ? people[0] : null;
  cache.set(key, person);
  return person;
}

/** The message a line is (all its revisions are one), or its own id when it names no native message. */
const lineKey = (row) =>
  row.native_id === null || row.native_id === undefined
    ? `id:${row.id}`
    : `m:${row.authority_id}\u0000${row.native_kind}\u0000${row.native_id}\u0000${row.generation ?? 1}`;

/**
 * `relationship_daily` for the UTC days from `from` through `to`, recounted from `sources` (see the head of this file).
 * One transaction. Returns `{ days, rows, lines }`.
 * @param {object} handle  an `openMemoryDb` handle (the writer)
 * @param {{ from: number|string, to: number|string }} range
 */
export function recountDaily(handle, { from, to }) {
  const db = dbOf(handle);
  const days = daysOf(from, to);
  if (days.length === 0) return { days: 0, rows: 0, lines: 0 };
  const lo = `${days[0]}T00:00:00.000Z`;
  const hi = isoOf(Date.parse(`${days.at(-1)}T00:00:00.000Z`) + DAY_MS);
  return txOf(handle)(() => {
    const cache = new Map();
    const seen = new Set();
    const counts = new Map();
    let lines = 0;
    const count = (person, row, side) => {
      if (!person || !row.audience_id) return;
      const dedupe = `${lineKey(row)}\u0000${person}\u0000${side}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      const day = utcDay(Date.parse(row.occurred_at));
      const key = `${person}\u0000${day}\u0000${row.audience_id}`;
      const entry = counts.get(key) ?? { person, day, audience: row.audience_id, them: 0, her: 0, last: null };
      entry[side] += 1;
      if (!entry.last || row.occurred_at > entry.last) entry.last = row.occurred_at;
      counts.set(key, entry);
      lines += 1;
    };
    const theirs = db
      .prepare(
        `SELECT s.id, s.authority_id, s.native_kind, s.native_id, s.generation, s.occurred_at, s.audience_id, s.author_account,
        s.direct, EXISTS (SELECT 1 FROM source_relations r JOIN sources t ON t.id = r.target_source_id
          WHERE r.source_id = s.id AND r.predicate = 'replies_to' AND t.author_kind = 'self') AS to_her
      FROM sources s WHERE s.kind = 'seen' AND s.retired_at IS NULL AND s.author_account IS NOT NULL AND s.occurred_at >= ? AND s.occurred_at < ?
      ORDER BY s.occurred_at, s.rowid`
      )
      .all(lo, hi);
    for (const row of theirs) {
      if (row.direct !== 1 && row.to_her !== 1) continue;
      count(personAt(db, cache, row.author_account, row.occurred_at), row, 'them');
    }
    const hers = db
      .prepare(
        `SELECT s.id, s.authority_id, s.native_kind, s.native_id, s.generation, s.occurred_at, s.audience_id, s.mentions,
        (SELECT json_group_array(t.author_account) FROM source_relations r JOIN sources t ON t.id = r.target_source_id
          WHERE r.source_id = s.id AND r.predicate = 'replies_to' AND t.author_account IS NOT NULL) AS replied
      FROM sources s WHERE s.kind = 'said' AND s.retired_at IS NULL AND s.occurred_at >= ? AND s.occurred_at < ?
      ORDER BY s.occurred_at, s.rowid`
      )
      .all(lo, hi);
    const accountOf = db.prepare(
      'SELECT id FROM accounts WHERE authority_id = ? AND native_key = ? ORDER BY gone_at IS NOT NULL, generation DESC LIMIT 1'
    );
    for (const row of hers) {
      const accounts = new Set();
      try {
        for (const account of JSON.parse(row.replied ?? '[]')) if (typeof account === 'string') accounts.add(account);
      } catch {
        /* none */
      }
      let mentioned = [];
      try {
        mentioned = JSON.parse(row.mentions ?? '[]');
      } catch {
        mentioned = [];
      }
      for (const native of Array.isArray(mentioned) ? mentioned : []) {
        if (typeof native !== 'string' || !native || !row.authority_id) continue;
        const account = accountOf.get(row.authority_id, native)?.id;
        if (account) accounts.add(account);
      }
      const people = new Set(
        [...accounts].map((account) => personAt(db, cache, account, row.occurred_at)).filter(Boolean)
      );
      for (const person of people) count(person, row, 'her');
    }
    const drop = db.prepare('DELETE FROM relationship_daily WHERE day = ?');
    for (const day of days) drop.run(day);
    const insert =
      db.prepare(`INSERT INTO relationship_daily (person_id, day, audience_id, addressed_by_them, addressed_by_her, meaningful, last_contact_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const audience = db.prepare('SELECT 1 AS ok FROM audiences WHERE id = ?');
    let rows = 0;
    for (const entry of [...counts.values()].sort((a, b) =>
      a.person + a.day + a.audience < b.person + b.day + b.audience ? -1 : 1
    )) {
      if (!audience.get(entry.audience)) continue;
      insert.run(
        entry.person,
        entry.day,
        entry.audience,
        entry.them,
        entry.her,
        entry.them > 0 && entry.her > 0 ? 1 : 0,
        entry.last
      );
      rows += 1;
    }
    return { days: days.length, rows, lines };
  });
}

/** The people a recomputation scores: every live person but her own row and the merged ones, with their inputs. */
function peopleInputs(db, now, settings) {
  const windowFrom = utcDay(now - (settings.consistencyDays - 1) * DAY_MS);
  const stats = new Map(
    db
      .prepare(
        `SELECT person_id,
      MAX(CASE WHEN meaningful = 1 THEN last_contact_at END) AS last_meaningful,
      MIN(CASE WHEN meaningful = 1 THEN day END) AS first_meaningful,
      COUNT(DISTINCT CASE WHEN meaningful = 1 AND day >= ? AND day <= ? THEN day END) AS days
    FROM relationship_daily GROUP BY person_id`
      )
      .all(windowFrom, utcDay(now))
      .map((row) => [row.person_id, row])
  );
  const accounts = new Map();
  for (const row of db
    .prepare(
      `SELECT l.person_id AS person_id, a.kind AS kind FROM account_person_links l JOIN accounts a ON a.id = l.account_id
    WHERE l.state = 'verified' AND l.valid_to_at IS NULL AND a.retired_at IS NULL`
    )
    .all()) {
    const person = survivorOf(db, row.person_id);
    const list = accounts.get(person) ?? [];
    list.push(row.kind);
    accounts.set(person, list);
  }
  const people = db
    .prepare(
      `SELECT id, affinity FROM people WHERE id <> 'person:self' AND kind IS NOT 'self' AND retired_at IS NULL
    AND (status IS NULL OR status = 'active') AND id NOT IN (SELECT from_person FROM people_merges) ORDER BY id`
    )
    .all();
  return people.map((row) => {
    const stat = stats.get(row.id);
    const kinds = accounts.get(row.id) ?? [];
    return {
      id: row.id,
      affinity: Number.isFinite(row.affinity) ? row.affinity : null,
      // A person is a bot when every verified account is a bot (and there is one).
      bot: kinds.length > 0 && kinds.every((kind) => kind === 'bot'),
      lastMeaningfulAt: stat?.last_meaningful ?? null,
      firstMeaningfulAt: stat?.first_meaningful ? `${stat.first_meaningful}T00:00:00.000Z` : null,
      meaningfulDays: stat?.days ?? 0,
    };
  });
}

/**
 * The close and exploring sets recomputed (see the head of this file), in one transaction: `focus_members` replaced by
 * the new sets, one `focus_events` row per change and per challenge. Returns `{ close, exploring, events }` (counts).
 * @param {object} handle  an `openMemoryDb` handle (the writer)
 * @param {{ now?: number, config?: object }} opts
 */
export function recompute(handle, { now = Date.now(), config = null } = {}) {
  const db = dbOf(handle);
  const settings = focusSettings(config);
  return txOf(handle)(() => {
    const people = peopleInputs(db, now, settings);
    const members = db
      .prepare('SELECT person_id, bucket, since FROM focus_members')
      .all()
      .map((row) => ({ ...row }));
    const overrides = db
      .prepare('SELECT person_id, kind, expires_at FROM focus_overrides')
      .all()
      .map((row) => ({ ...row }));
    const weekFrom = isoOf(now - WEEK_MS);
    const movesInWeek = db
      .prepare(
        `SELECT COUNT(*) AS n FROM focus_events WHERE at > ? AND reason IN (${MOVE_REASONS.map(() => '?').join(', ')})`
      )
      .get(weekFrom, ...MOVE_REASONS).n;
    // A pin over capacity is reported once until it enters by its pin.
    const reported = new Set(
      db
        .prepare(
          `SELECT person_id FROM focus_events e WHERE reason = 'over_capacity'
      AND rowid = (SELECT rowid FROM focus_events x WHERE x.person_id = e.person_id AND x.reason IN ('over_capacity', 'pin') ORDER BY at DESC, rowid DESC LIMIT 1)`
        )
        .all()
        .map((row) => row.person_id)
    );
    const streaks = new Map();
    for (const row of db
      .prepare(
        `SELECT person_id, reason, extra FROM focus_events e WHERE reason IN ('challenge', 'challenge_lapsed', 'challenge_won', 'free_slot')
      AND rowid = (SELECT rowid FROM focus_events x WHERE x.person_id = e.person_id AND x.reason IN ('challenge', 'challenge_lapsed', 'challenge_won', 'free_slot') ORDER BY at DESC, rowid DESC LIMIT 1)`
      )
      .all()) {
      if (row.reason !== 'challenge') continue;
      let extra = {};
      try {
        extra = JSON.parse(row.extra ?? '{}') ?? {};
      } catch {
        extra = {};
      }
      if (typeof extra.since === 'string') streaks.set(row.person_id, extra.since);
    }
    const history = db.prepare('SELECT 1 AS ok FROM focus_events LIMIT 1').get() !== undefined;
    const decided = decideFocus({ now, settings, people, members, overrides, streaks, movesInWeek, reported, history });
    const at = isoOf(now);
    db.prepare('DELETE FROM focus_members').run();
    const put = db.prepare(
      'INSERT INTO focus_members (person_id, bucket, since, score, policy_version, reason) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const m of decided.members)
      put.run(m.person_id, m.bucket, m.since, m.score, m.policy_version, JSON.stringify(m.reason));
    const event =
      db.prepare(`INSERT OR IGNORE INTO focus_events (id, person_id, at, old_bucket, new_bucket, reason, policy_version, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of decided.events) {
      event.run(
        `focus:${at}:${e.person_id}:${e.reason}`,
        e.person_id,
        at,
        e.old_bucket,
        e.new_bucket,
        e.reason,
        settings.policyVersion,
        e.extra === null ? null : JSON.stringify(e.extra)
      );
    }
    return {
      close: decided.members.filter((m) => m.bucket === 'close').length,
      exploring: decided.members.filter((m) => m.bucket === 'exploring').length,
      events: decided.events.length,
    };
  });
}

/** The day's job: yesterday and today recounted, then the sets recomputed. Returns the counts of both and the day. */
export function runFocusDay(handle, { now = Date.now(), config = null } = {}) {
  const counted = recountDaily(handle, { from: now - DAY_MS, to: now });
  const sets = recompute(handle, { now, config });
  const db = dbOf(handle);
  txOf(handle)(() =>
    db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('focus_last_day', utcDay(now))
  );
  return { day: utcDay(now), ...counted, ...sets };
}

/** The UTC day the daily job last ran on, or null. */
export const lastFocusDay = (db) =>
  dbOf(db).prepare("SELECT value FROM meta WHERE key = 'focus_last_day'").get()?.value ?? null;

/** An owner's pin or exclusion (`kind`), replacing the person's previous override. */
export function setOverride(handle, { person, kind, approvedBy, expiresAt = null, reason = null }) {
  const db = dbOf(handle);
  txOf(handle)(() =>
    db
      .prepare(
        `INSERT INTO focus_overrides (person_id, kind, expires_at, approved_by, reason) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(person_id) DO UPDATE SET kind = excluded.kind, expires_at = excluded.expires_at, approved_by = excluded.approved_by, reason = excluded.reason`
      )
      .run(person, kind, expiresAt, approvedBy, reason)
  );
}

/**
 * Her focus close set as person ids, the best scored first (an internal reader: the description reviews of her memory
 * session put these people first, writer-switch.js#openFlags). Empty without the table.
 * @param {object} db
 * @returns {string[]}
 */
export function closePeople(db) {
  try {
    return dbOf(db)
      .prepare("SELECT person_id FROM focus_members WHERE bucket = 'close' ORDER BY score DESC, person_id")
      .all()
      .map((row) => row.person_id);
  } catch {
    return [];
  }
}

/**
 * The close and exploring sets as the native member ids of an interface (`{ close: string[], exploring: string[] }`,
 * each the best scored first): for the heartbeat's people view, an internal reader. A person with no current verified
 * account on that interface is left out.
 */
export function focusView(db, { iface = 'discord' } = {}) {
  const authority = nativeAuthorityOf(iface);
  const rows = dbOf(db)
    .prepare(
      `SELECT m.person_id AS person_id, m.bucket AS bucket, m.score AS score,
      (SELECT a.native_key FROM account_person_links l JOIN accounts a ON a.id = l.account_id
        WHERE l.person_id = m.person_id AND l.state = 'verified' AND l.valid_to_at IS NULL AND a.authority_id = ? AND a.retired_at IS NULL
        ORDER BY a.kind = 'bot', l.recorded_at, a.id LIMIT 1) AS native
    FROM focus_members m ORDER BY m.score DESC, m.person_id`
    )
    .all(authority);
  const out = { close: [], exploring: [] };
  for (const row of rows)
    if (row.native && out[row.bucket] && !out[row.bucket].includes(row.native)) out[row.bucket].push(row.native);
  return out;
}
