// The people and the places a heartbeat lists in `<memory>` (src/turn/phases/request/build.ts): every person memory
// holds something about who has an account, and every live chat she can write in that is no mirror of her diary, each
// with what its line says. A place's activity counts people's lines of the last `ACTIVITY_DAYS` days, one statement per
// place over the range of `sources_place_time`, so no read walks a place. Read only, under the turn's context; it makes
// no model request.

import { strongestAttitudesOf, personNamesOf } from './frame-reads.ts';
import { dmOfAccount, profileAccountsOf } from './meta-person.ts';
import { mirrorPlaces } from './mirrors.ts';
import { PERSONA_ID } from './ids.ts';
import { audienceWhere, whereFor } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db } from './types.ts';

/** How many days back a place's activity counts. */
export const ACTIVITY_DAYS = 7;

const DAY_MS = 86_400_000;

/** A person as a heartbeat lists them. Every moment is epoch ms; a field memory holds nothing of is null. */
export type ListedPerson = {
  personId: string;
  name: string | null;
  /** Her stored description of what the person is to her (`relationship`). */
  relation: string | null;
  /** The score of her newest attitude change, null when it is neutral or there is none. */
  score: number | null;
  lastSeenAt: number | null;
  /** The place of their newest line when it lies inside the activity window, null otherwise. */
  lastPlaceId: string | null;
  /** Their direct chat with her and the moment of its newest line, null when none is stored. */
  dm: { placeId: string; lastAt: number | null } | null;
  /** Every account of the person by interface and platform id, where a handle may mention them. */
  accounts: Array<{ iface: string; native: string }>;
};

/** A place as a heartbeat lists it. */
export type ListedPlace = {
  placeId: string;
  /** Her stored description of what the place is for (`purpose`). */
  purpose: string | null;
  /** People's lines of the activity window, each message once, and how many people wrote them. */
  lines: number;
  people: number;
  /** The moment of her newest line there, null when no line of a turn of hers is stored there. */
  ownLastAt: number | null;
};

export type HeartbeatLists = { people: Array<ListedPerson>; places: Array<ListedPlace> };

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

const momentOf = (value: unknown): number | null => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** The current text of one field of every subject of a kind, a direct chat's version before a group's. */
function fieldTexts(db: Db, ctx: Context, kind: string, field: string): Map<string, string> {
  const where = whereFor(ctx, 'd');
  const rows = db
    .prepare(
      `SELECT d.subject_id, v.text FROM descriptions d JOIN description_versions v ON v.id = d.current_version
       WHERE d.subject_kind = ? AND d.field = ? AND d.retired_at IS NULL AND ${where.sql}
       ORDER BY d.subject_id, d.scope_kind = 'dm' DESC, d.id`
    )
    .all(kind, field, ...where.params);
  const out = new Map<string, string>();
  for (const row of rows) {
    const value = text(row.text);
    const id = text(row.subject_id);
    if (value !== null && id !== null && !out.has(id)) out.set(id, value);
  }
  return out;
}

/** Who wrote in a place in the window: each author's key, their count of messages and their newest moment. */
type Writer = { key: string; lines: number; lastAt: number | null };

/** The writers of people's lines in a place since `since` (ISO), bots and her own lines aside. */
function writersOf(db: Db, ctx: Context, placeId: string, since: string): Array<Writer> {
  const where = whereFor(ctx, 's');
  return db
    .prepare(
      `SELECT COALESCE(s.author_person, s.author_account) AS who, COUNT(DISTINCT s.native_id) AS n,
         MAX(s.occurred_at) AS last
       FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
       WHERE s.place_id = ? AND s.occurred_at >= ? AND s.kind = 'seen' AND s.retired_at IS NULL
         AND COALESCE(a.kind, 'user') <> 'bot' AND ${where.sql}
       GROUP BY who`
    )
    .all(placeId, since, ...where.params)
    .flatMap((row) => {
      const key = text(row.who);
      return key === null ? [] : [{ key, lines: Number(row.n ?? 0), lastAt: momentOf(row.last) }];
    });
}

/** The moment of her newest line in each place, read over `sources_turn`: the lines her turns wrote. */
function ownLastByPlace(db: Db, ctx: Context): Map<string, number> {
  const where = whereFor(ctx, 's');
  const out = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT s.place_id, MAX(s.occurred_at) AS last FROM sources s INDEXED BY sources_turn
       WHERE s.turn_id > '' AND s.kind = 'said' AND s.retired_at IS NULL AND ${where.sql}
       GROUP BY s.place_id`
    )
    .all(...where.params)) {
    const place = text(row.place_id);
    const at = momentOf(row.last);
    if (place !== null && at !== null) out.set(place, at);
  }
  return out;
}

/** The moment of the newest line of a place, read from the end of its range of `sources_place_time`. */
function newestLineAt(db: Db, placeId: string): number | null {
  const row = db
    .prepare(
      `SELECT s.occurred_at FROM sources s WHERE s.place_id = ? AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL
       ORDER BY s.occurred_at DESC LIMIT 1`
    )
    .get(placeId);
  return momentOf(row?.occurred_at);
}

/** The live chats the context reads, mirrors of her diary aside, by id. */
function chatIdsOf(db: Db, ctx: Context): Array<string> {
  const mirrors = new Set(mirrorPlaces(db).map((one) => one.placeId));
  const where = whereFor(ctx, 'p');
  return db
    .prepare(
      `SELECT p.id FROM places p
       WHERE p.chat IN ('group', 'dm') AND p.retired_at IS NULL AND p.gone_at IS NULL AND ${where.sql}
       ORDER BY p.id`
    )
    .all(...where.params)
    .flatMap((row) => {
      const id = text(row.id);
      return id === null || mirrors.has(id) ? [] : [id];
    });
}

/** The people memory holds a description, a claim or an attitude change of under the context, she aside. */
function knownPersonIds(db: Db, ctx: Context): Array<string> {
  const d = whereFor(ctx, 'd');
  const c = whereFor(ctx, 'c');
  const e = audienceWhere(ctx, 'e');
  return db
    .prepare(
      `SELECT d.subject_id AS id FROM descriptions d
         WHERE d.subject_kind = 'person' AND d.retired_at IS NULL AND d.current_version IS NOT NULL AND ${d.sql}
       UNION SELECT c.subject_id FROM claims c WHERE c.subject_kind = 'person' AND c.retired_at IS NULL AND ${c.sql}
       UNION SELECT e.person_id FROM affinity_events e WHERE e.person_id IS NOT NULL AND e.retired_at IS NULL AND ${e.sql}
       ORDER BY id`
    )
    .all(...d.params, ...c.params, ...e.params)
    .flatMap((row) => {
      const id = text(row.id);
      return id === null || id === PERSONA_ID ? [] : [id];
    });
}

/** The person row of an id: its last seen moment, null for a retired or merged person. */
function livePerson(db: Db, personId: string): { lastSeenAt: number | null } | null {
  const row = db
    .prepare(
      `SELECT p.last_seen_at FROM people p WHERE p.id = ? AND p.retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM people_merges m WHERE m.from_person = p.id)`
    )
    .get(personId);
  return row === undefined ? null : { lastSeenAt: momentOf(row.last_seen_at) };
}

/** Whether an account is a person's own, no bot's and no shared one. */
function userAccount(db: Db, accountId: string): boolean {
  const row = db.prepare('SELECT kind, retired_at FROM accounts WHERE id = ?').get(accountId);
  return row !== undefined && row.retired_at === null && (row.kind === null || row.kind === 'user');
}

/** The people and the places of a heartbeat at `now`, in id order. */
export function heartbeatListsOf(db: Db, ctx: Context, now: number): HeartbeatLists {
  const since = new Date(now - ACTIVITY_DAYS * DAY_MS).toISOString();
  const purposes = fieldTexts(db, ctx, 'place', 'purpose');
  const own = ownLastByPlace(db, ctx);
  // Each person's newest line of the window and its place, from the same reads that count the places.
  const newest = new Map<string, { at: number; placeId: string }>();
  const places = chatIdsOf(db, ctx).map((placeId): ListedPlace => {
    const writers = writersOf(db, ctx, placeId, since);
    for (const one of writers) {
      const known = newest.get(one.key);
      if (one.lastAt !== null && (known === undefined || one.lastAt > known.at))
        newest.set(one.key, { at: one.lastAt, placeId });
    }
    return {
      placeId,
      purpose: purposes.get(placeId) ?? null,
      lines: writers.reduce((sum, one) => sum + one.lines, 0),
      people: writers.length,
      ownLastAt: own.get(placeId) ?? null,
    };
  });
  const relations = fieldTexts(db, ctx, 'person', 'relationship');
  const ids = knownPersonIds(db, ctx);
  const scores = new Map(strongestAttitudesOf(db, ctx, ids.length).map((one) => [one.person, one.score]));
  const names = personNamesOf(db, ids);
  const people = ids.flatMap((personId): Array<ListedPerson> => {
    const person = livePerson(db, personId);
    const accounts = profileAccountsOf(db, personId).filter((one) => userAccount(db, one.id));
    if (person === null || accounts.length === 0) return [];
    const seen = newest.get(personId) ?? null;
    const dm = accounts.map((one) => dmOfAccount(db, one.id)).find((one) => one !== null) ?? null;
    return [
      {
        personId,
        name: names[personId] ?? null,
        relation: relations.get(personId) ?? null,
        score: scores.get(personId) ?? null,
        lastSeenAt: seen?.at ?? person.lastSeenAt,
        lastPlaceId: seen?.placeId ?? null,
        dm: dm === null ? null : { placeId: dm.id, lastAt: newestLineAt(db, dm.id) },
        accounts: accounts.map((one) => ({ iface: one.iface, native: one.platformId })),
      },
    ];
  });
  return { people, places };
}
