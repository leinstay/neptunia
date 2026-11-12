// Claims about a place as the writer of a place's notes stores them (src/memory/db/place-notes.ts): the in-jokes of a root
// (kind `injoke`) and what people taught her (kind `lesson`, with the teacher's person in `from_person`, how many times it
// was confirmed in `weight` and when it was last seen). Rows go in through `insertRows`, like the rest of the world of
// tests/fixtures/memory-db/mind-world.ts. Names and texts are made up by the test that calls it.
import { insertRows } from '../../../src/memory/db/rows.ts';
import type { Db } from '../../../src/memory/db/types.ts';
import type { Audience } from './mind-world.ts';

/** One claim of a place: `id` a row id, `place` the place it is about, `text` what it says. */
export type PlaceClaim = {
  id: string;
  place: string;
  kind: 'injoke' | 'lesson';
  text: string;
  audience: Audience;
  /** How often it was confirmed; a lesson ranks by it. */
  weight?: number;
  /** An ISO moment: when it was last seen, and first. */
  seenAt?: string;
  /** The person who taught a lesson, by person id. */
  teacher?: string | null;
  retiredAt?: string | null;
};

const SEEN = '2026-11-01T10:00:00.000Z';

/** The scope columns of a row a group or one direct chat may read. */
const scopeOf = (audience: Audience): Record<string, string | null> =>
  'group' in audience
    ? { scope_kind: 'group', scope_iface: audience.group, scope_dm: null }
    : { scope_kind: 'dm', scope_iface: audience.iface, scope_dm: audience.person, audience_id: `aud:dm:${audience.dm}` };

/** Stores one claim of a place. */
export function addPlaceClaim(db: Db, claim: PlaceClaim): void {
  const seen = claim.seenAt ?? SEEN;
  insertRows(db, {
    claims: [
      {
        id: claim.id,
        subject_kind: 'place',
        subject_id: claim.place,
        kind: claim.kind,
        text: claim.text,
        weight: claim.weight ?? 1,
        first_seen_at: seen,
        last_seen_at: seen,
        from_person: claim.kind === 'lesson' ? (claim.teacher ?? null) : null,
        how: claim.kind === 'lesson' ? 'taught' : 'legacy',
        author: 'import',
        truth: 'current',
        shown: 1,
        created_at: seen,
        retired_at: claim.retiredAt ?? null,
        ...scopeOf(claim.audience),
      },
    ],
  });
}
