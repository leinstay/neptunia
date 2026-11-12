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
  /** The claim's remainder as the place-notes writer stores it (`extra`), such as `{"from":"<@null>"}`. */
  extra?: string | null;
  /** The source lines the claim rests on, by source id, in the claim's source order (`claim_sources.position`). */
  sources?: ReadonlyArray<string>;
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
        extra: claim.extra ?? null,
        retired_at: claim.retiredAt ?? null,
        ...scopeOf(claim.audience),
      },
    ],
    claim_sources: (claim.sources ?? []).map((source, position) => ({
      claim_id: claim.id,
      source_id: source,
      position,
      retired_at: null,
    })),
  });
}

/** A source line of a place written by an account (`author` an account id, whose person the store derives) or by her (`'self'`), read under `audience`. */
export function addSourceLine(
  db: Db,
  line: { id: string; place: string; author: string; audience: Audience; text?: string }
): void {
  const self = line.author === 'self';
  insertRows(db, {
    sources: [
      {
        id: line.id,
        kind: self ? 'said' : 'seen',
        iface: 'fake',
        native_id: line.id,
        native_kind: 'message',
        place_id: line.place,
        author_account: self ? null : line.author,
        author_kind: self ? 'self' : 'account',
        occurred_at: SEEN,
        recorded_at: SEEN,
        text: line.text ?? 'a line',
        ...scopeOf(line.audience),
      },
    ],
  });
}
