// The fields of a person's entry that the graph reader (mind-read.ts) and the service collector (service-lists.ts) read
// beside the walk: the interest claims the context may read, ranked, the aliases, the attitude with its latest changes,
// the name the person is addressed by most, and the count of messages seen. The ranks are the
// ones of the profile block (src/turn/request/profiles.ts): `rank` for interests, `rankAddressed` for names.

import { normalizeAvatar } from '../avatars.ts';
import { decayedScore, rankAddressed } from '../addressed.ts';
import { sortRanked } from '../ranking.ts';
import { MEMORY_LIMITS } from '../text-limits.ts';
import type { Db, Row } from './types.ts';

type Where = { sql: string; params: Array<string | number> };

/** One live, shown interest claim of a person: its id, its text and the weight and day its rank reads. */
export type InterestClaim = { id: string; text: string; weight: number; lastSeen: string | null };

const stamp = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** One change of the persona's attitude toward a person: the applied change, when it was stored and why. */
export type AttitudeMove = { delta: number; at: string; reason: string | null };

/** The score and reason of the newest attitude change and the newest changes, newest first. */
export type Attitude = { score: number; reason: string | null; moves: ReadonlyArray<AttitudeMove> };

/**
 * The attitude toward `personId` as the audience `where` (over alias `e`) reads it: the newest change of
 * `affinity_events`, never `people.affinity`, and at most `moves` changes. Null when the audience reads no change.
 */
export function attitudeOf(db: Db, where: Where, personId: string, moves: number): Attitude | null {
  const rows = db
    .prepare(
      `SELECT e.at, e.applied, e.score, e.reason FROM affinity_events e
       WHERE e.person_id = ? AND e.retired_at IS NULL AND ${where.sql}
       ORDER BY e.at DESC, e.id DESC LIMIT ?`
    )
    .all(personId, ...where.params, Math.max(1, Math.floor(moves)));
  const [newest] = rows;
  if (!newest || typeof newest.score !== 'number') return null;
  const shown = rows
    .slice(0, Math.floor(moves))
    .flatMap((row) =>
      typeof row.applied === 'number' && typeof row.at === 'string'
        ? [{ delta: row.applied, at: row.at, reason: filled(row.reason) }]
        : []
    );
  return { score: newest.score, reason: filled(newest.reason), moves: shown };
}

/** The open aliases of `personId` the audience `where` (over alias `c`) reads, by claim id. */
export function aliasClaimsOf(
  db: Db,
  where: Where,
  personId: string
): Array<{ id: string; kind: string; text: string }> {
  return db
    .prepare(
      `SELECT c.id, c.text FROM claims c
       WHERE c.subject_kind = 'person' AND c.subject_id = ? AND c.kind = 'alias'
         AND c.retired_at IS NULL AND c.superseded_by IS NULL AND ${where.sql}
       ORDER BY c.id`
    )
    .all(personId, ...where.params)
    .flatMap((row) => {
      const text = filled(row.text);
      return text === null ? [] : [{ id: String(row.id), kind: 'alias', text }];
    });
}

const filled = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** The interest claims about `personId` the audience `where` (over alias `c`) reads, best rank first, at most `limit`. */
export function interestClaimsOf(db: Db, where: Where, personId: string, limit: number): Array<InterestClaim> {
  if (!(limit >= 1)) return [];
  const rows = db
    .prepare(
      `SELECT c.id, c.text, c.weight, c.last_seen_at, c.first_seen_at FROM claims c
       WHERE c.subject_kind = 'person' AND c.subject_id = ? AND c.kind = 'interest'
         AND c.retired_at IS NULL AND c.superseded_by IS NULL AND c.shown = 1
         AND (c.truth IS NULL OR c.truth IN ('current', 'disputed')) AND ${where.sql}
       ORDER BY c.id`
    )
    .all(personId, ...where.params);
  const claims = rows.flatMap((row: Row) =>
    typeof row.text === 'string' && row.text.trim() !== ''
      ? [
          {
            id: String(row.id),
            text: row.text,
            weight: typeof row.weight === 'number' ? row.weight : 0,
            lastSeen: stamp(row.last_seen_at) ?? stamp(row.first_seen_at),
          },
        ]
      : []
  );
  return sortRanked(claims, MEMORY_LIMITS.interestHalfLifeDays).slice(0, Math.floor(limit));
}

type Addressed = Record<string, { score: number; last: string }>;

/** Each name of the stored maps with its best entry, the best by the score decayed to `now`. */
function bestEntries(stored: Array<unknown>, now: number): Addressed {
  const best: Addressed = {};
  const half = MEMORY_LIMITS.addressHalfLifeDays;
  for (const raw of stored) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    for (const [name, entry] of Object.entries(raw as Addressed)) {
      const held = best[name];
      if (held === undefined || decayedScore(entry, now, half) > decayedScore(held, now, half)) best[name] = entry;
    }
  }
  return best;
}

function parsed(value: unknown): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/**
 * The name the person is addressed by most over the memberships of `accounts` in the places `placeOk` allows, by the
 * score decayed to `now`. Null when nobody addressed them.
 */
export function usualNameOf(
  db: Db,
  accounts: ReadonlyArray<string>,
  placeOk: (placeId: string) => boolean,
  now: number
): string | null {
  if (accounts.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT place_id, addressed_as FROM memberships
       WHERE account_id IN (${accounts.map(() => '?').join(', ')}) AND retired_at IS NULL AND addressed_as IS NOT NULL
       ORDER BY id`
    )
    .all(...accounts);
  const stored = rows.filter((row) => placeOk(String(row.place_id))).map((row) => parsed(row.addressed_as));
  return rankAddressed(bestEntries(stored, now), now, MEMORY_LIMITS.addressHalfLifeDays)[0] ?? null;
}

/** A stored `avatar` field (JSON text) read as `normalizeAvatar` reads it: null for nothing stored or text that is no avatar. */
export function storedAvatarOf(stored: string | null): ReturnType<typeof normalizeAvatar> {
  return normalizeAvatar(parsed(stored));
}
