// The people and the places a heartbeat lists in `<memory>` (src/turn/phases/request/build.ts): every person memory
// holds something about who has an account, and every live chat she can write in that is no mirror of her diary, each
// with what its line says. A place's activity counts people's lines of the last `ACTIVITY_DAYS` days, one statement per
// place over the range of `sources_place_time`, so no read walks a place. A heartbeat runs nowhere and reads as herself
// (`internal`, src/turn/inputs.ts#turnContextOf), so these reads apply no scope: every row is hers to read. A person's
// approach is her last line addressed to them and a place's answers count the lines that answer her last line there,
// what followed each read as the notice reads it (src/memory/db/past-acts.ts#followOf). Read only; it makes no model
// request.

import { strongestAttitudesOf } from './frame-reads.ts';
import { dmOfAccount, personNamesOf, profileAccountsOf } from './meta-person.ts';
import { mirrorPlaces } from './mirrors.ts';
import { PERSONA_ID } from './ids.ts';
import { followOf } from './past-acts.ts';
import { internalContext } from './scope.ts';
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
  /**
   * Her last line addressed to them in a listed chat, and the moment of their first line after it, null when none is
   * recorded; null when she never addressed them. A line is addressed to them when it answers a line of theirs by
   * `reply_to`, mentions one of their accounts, or stands in their direct chat. Their line after it answers hers by
   * `reply_to`, or in their direct chat is any line of theirs after hers.
   */
  approach: { placeId: string; at: number; answeredAt: number | null } | null;
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
  /** In a group chat she wrote in within the activity window, how many lines answer her newest line there; else null. */
  ownAnswers: number | null;
};

export type HeartbeatLists = { people: Array<ListedPerson>; places: Array<ListedPlace> };

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

const momentOf = (value: unknown): number | null => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** The current text of one field of every subject of a kind, a direct chat's version before a group's. */
function fieldTexts(db: Db, kind: string, field: string): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT d.subject_id, v.text FROM descriptions d JOIN description_versions v ON v.id = d.current_version
       WHERE d.subject_kind = ? AND d.field = ? AND d.retired_at IS NULL
       ORDER BY d.subject_id, d.scope_kind = 'dm' DESC, d.id`
    )
    .all(kind, field);
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
function writersOf(db: Db, placeId: string, since: string): Array<Writer> {
  return db
    .prepare(
      `SELECT COALESCE(s.author_person, s.author_account) AS who, COUNT(DISTINCT s.native_id) AS n,
         MAX(s.occurred_at) AS last
       FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
       WHERE s.place_id = ? AND s.occurred_at >= ? AND s.kind = 'seen' AND s.retired_at IS NULL
         AND COALESCE(a.kind, 'user') <> 'bot'
       GROUP BY who`
    )
    .all(placeId, since)
    .flatMap((row) => {
      const key = text(row.who);
      return key === null ? [] : [{ key, lines: Number(row.n ?? 0), lastAt: momentOf(row.last) }];
    });
}

/** One line of hers: its moment and its message id. */
type OwnLine = { at: number; nativeId: string };

/**
 * Her newest line in each place, read over `sources_turn`: the lines her turns wrote. SQLite takes the bare `native_id`
 * from the row that holds the `MAX`.
 */
function ownLastByPlace(db: Db): Map<string, OwnLine> {
  const out = new Map<string, OwnLine>();
  for (const row of db
    .prepare(
      `SELECT s.place_id, s.native_id, MAX(s.occurred_at) AS last FROM sources s INDEXED BY sources_turn
       WHERE s.turn_id > '' AND s.kind = 'said' AND s.retired_at IS NULL
       GROUP BY s.place_id`
    )
    .all()) {
    const place = text(row.place_id);
    const at = momentOf(row.last);
    if (place !== null && at !== null) out.set(place, { at, nativeId: String(row.native_id) });
  }
  return out;
}

/** Her last line addressed to a person: where, when, its message id, and whether it stands in their direct chat. */
type Addressed = OwnLine & { placeId: string; direct: boolean };

/**
 * Her newest line addressed to each person, in the chats of `chats`, by person id. One pass over her lines by
 * `sources_turn`, each replied line found by `sources_native`. `personOf` names the person of an account id or of a
 * mentioned `iface:platform id`, `dmPartner` the person whose direct chat a place is.
 */
function addressedByPerson(
  db: Db,
  chats: ReadonlySet<string>,
  personOf: ReadonlyMap<string, string>,
  dmPartner: ReadonlyMap<string, string>
): Map<string, Addressed> {
  const out = new Map<string, Addressed>();
  for (const row of db
    .prepare(
      `SELECT s.place_id, s.native_id, s.occurred_at, s.iface, s.mentions, r.author_person, r.author_account
       FROM sources s INDEXED BY sources_turn
         LEFT JOIN sources r ON r.native_id = s.reply_to AND r.place_id = s.place_id AND r.kind = 'seen'
       WHERE s.turn_id > '' AND s.kind = 'said' AND s.retired_at IS NULL`
    )
    .all()) {
    const placeId = String(row.place_id);
    const at = momentOf(row.occurred_at);
    if (!chats.has(placeId) || at === null) continue;
    const partner = dmPartner.get(placeId) ?? null;
    const replied = text(row.author_person) ?? personOf.get(String(row.author_account)) ?? null;
    const mentioned = mentionsOf(row.mentions).flatMap((native) => {
      const person = personOf.get(`${String(row.iface)}:${native}`);
      return person === undefined ? [] : [person];
    });
    for (const person of new Set([partner, replied, ...mentioned])) {
      if (person === null || (out.get(person)?.at ?? -Infinity) >= at) continue;
      out.set(person, { at, nativeId: String(row.native_id), placeId, direct: person === partner });
    }
  }
  return out;
}

/** The platform ids a stored `mentions` column holds. */
function mentionsOf(value: unknown): Array<string> {
  if (typeof value !== 'string') return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [];
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

/** The live chats, mirrors of her diary aside, by id, each with whether it is a group chat. */
function chatsOf(db: Db): Array<{ id: string; group: boolean }> {
  const mirrors = new Set(mirrorPlaces(db).map((one) => one.placeId));
  return db
    .prepare(
      `SELECT p.id, p.chat FROM places p
       WHERE p.chat IN ('group', 'dm') AND p.retired_at IS NULL AND p.gone_at IS NULL
       ORDER BY p.id`
    )
    .all()
    .flatMap((row) => {
      const id = text(row.id);
      return id === null || mirrors.has(id) ? [] : [{ id, group: row.chat === 'group' }];
    });
}

/** The people memory holds a description, a claim or an attitude change of, she aside. */
function knownPersonIds(db: Db): Array<string> {
  return db
    .prepare(
      `SELECT d.subject_id AS id FROM descriptions d
         WHERE d.subject_kind = 'person' AND d.retired_at IS NULL AND d.current_version IS NOT NULL
       UNION SELECT c.subject_id FROM claims c WHERE c.subject_kind = 'person' AND c.retired_at IS NULL
       UNION SELECT e.person_id FROM affinity_events e WHERE e.person_id IS NOT NULL AND e.retired_at IS NULL
       ORDER BY id`
    )
    .all()
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

/**
 * The moment of each person's first line after her line addressed to them (`addressed`, by person id), null when none
 * is recorded: a line of theirs (`keysOf`, the person id and their account ids) that answers hers by `reply_to`, or in
 * their direct chat any line of theirs after it. One statement per place, over the range of `sources_place_time` from
 * the oldest of her lines there.
 */
function answeredAtOf(
  db: Db,
  addressed: ReadonlyMap<string, Addressed>,
  keysOf: (personId: string) => ReadonlySet<string>
): Map<string, number | null> {
  const read = db.prepare(
    `SELECT s.reply_to, COALESCE(s.author_person, s.author_account) AS who, MIN(s.occurred_at) AS first
     FROM sources s
     WHERE s.place_id = ? AND s.occurred_at > ? AND s.kind = 'seen' AND s.retired_at IS NULL
       AND (? = 1 OR s.reply_to IN (SELECT value FROM json_each(?)))
     GROUP BY s.reply_to, who`
  );
  const byPlace = new Map<string, Array<[string, Addressed]>>();
  for (const entry of addressed) byPlace.set(entry[1].placeId, [...(byPlace.get(entry[1].placeId) ?? []), entry]);
  const out = new Map<string, number | null>();
  for (const [placeId, lines] of byPlace) {
    const from = new Date(Math.min(...lines.map(([, line]) => line.at))).toISOString();
    const direct = lines.some(([, line]) => line.direct);
    const rows = read.all(placeId, from, direct ? 1 : 0, JSON.stringify(lines.map(([, line]) => line.nativeId)));
    for (const [personId, line] of lines) {
      const keys = keysOf(personId);
      const moments = rows.flatMap((row) => {
        const at = momentOf(row.first);
        const theirs = typeof row.who === 'string' && keys.has(row.who);
        const follows = line.direct ? at !== null && at > line.at : row.reply_to === line.nativeId;
        return theirs && follows && at !== null ? [at] : [];
      });
      out.set(personId, moments.length > 0 ? Math.min(...moments) : null);
    }
  }
  return out;
}

/** The people and the places of a heartbeat at `now`, in id order. */
export function heartbeatListsOf(db: Db, now: number): HeartbeatLists {
  const since = new Date(now - ACTIVITY_DAYS * DAY_MS).toISOString();
  const purposes = fieldTexts(db, 'place', 'purpose');
  const own = ownLastByPlace(db);
  // Each person's newest line of the window and its place, from the same reads that count the places.
  const newest = new Map<string, { at: number; placeId: string }>();
  const chats = chatsOf(db);
  const places = chats.map(({ id: placeId, group }): ListedPlace => {
    const writers = writersOf(db, placeId, since);
    const last = own.get(placeId) ?? null;
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
      ownLastAt: last?.at ?? null,
      ownAnswers:
        group && last !== null && last.at >= now - ACTIVITY_DAYS * DAY_MS
          ? followOf(db, { placeId, at: last.at, nativeIds: [last.nativeId], now }).answers
          : null,
    };
  });
  const relations = fieldTexts(db, 'person', 'relationship');
  const ids = knownPersonIds(db);
  const scores = new Map(strongestAttitudesOf(db, internalContext(), ids.length).map((one) => [one.person, one.score]));
  const names = personNamesOf(db, ids);
  const listed = ids.flatMap((personId) => {
    const person = livePerson(db, personId);
    const accounts = profileAccountsOf(db, personId).filter((one) => userAccount(db, one.id));
    if (person === null || accounts.length === 0) return [];
    const dm = accounts.map((one) => dmOfAccount(db, one.id)).find((one) => one !== null) ?? null;
    return [{ personId, person, accounts, dm }];
  });
  // Each listed person by every key a line of hers may name them with: an account id and a mentioned platform id.
  const personOf = new Map(
    listed.flatMap(({ personId, accounts }) =>
      accounts.flatMap((one) => [
        [one.id, personId],
        [`${one.iface}:${one.platformId}`, personId],
      ])
    ) as Array<[string, string]>
  );
  const dmPartner = new Map(listed.flatMap(({ personId, dm }) => (dm === null ? [] : [[dm.id, personId] as const])));
  const addressed = addressedByPerson(db, new Set(chats.map((one) => one.id)), personOf, dmPartner);
  const keys = new Map(
    listed.map(({ personId, accounts }) => [personId, new Set([personId, ...accounts.map((one) => one.id)])])
  );
  const answered = answeredAtOf(db, addressed, (personId) => keys.get(personId) ?? new Set());
  const people = listed.map(({ personId, person, accounts, dm }): ListedPerson => {
    const seen = newest.get(personId) ?? null;
    const line = addressed.get(personId) ?? null;
    return {
      personId,
      name: names[personId] ?? null,
      relation: relations.get(personId) ?? null,
      score: scores.get(personId) ?? null,
      lastSeenAt: seen?.at ?? person.lastSeenAt,
      lastPlaceId: seen?.placeId ?? null,
      dm: dm === null ? null : { placeId: dm.id, lastAt: newestLineAt(db, dm.id) },
      accounts: accounts.map((one) => ({ iface: one.iface, native: one.platformId })),
      approach:
        line === null ? null : { placeId: line.placeId, at: line.at, answeredAt: answered.get(personId) ?? null },
    };
  });
  return { people, places };
}
