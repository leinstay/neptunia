// The fields of a person's entry that the graph reader reads beside the walk (mind-read.ts): the interest claims the
// context may read, ranked, the name the person is addressed by most, and the count of messages seen. The ranks are the
// ones of the profile block (src/turn/request/profiles.ts): `rank` for interests, `rankAddressed` for names.

import { decayedScore, rankAddressed } from '../addressed.ts';
import { sortRanked } from '../ranking.ts';
import { MEMORY_LIMITS } from '../text-limits.ts';
import type { Db, Row } from './types.ts';

type Where = { sql: string; params: Array<string | number> };

/** One live, shown interest claim of a person: its id, its text and the weight and day its rank reads. */
export type InterestClaim = { id: string; text: string; weight: number; lastSeen: string | null };

const stamp = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

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
