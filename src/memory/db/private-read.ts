// The private view of one person across their accounts and actual DM places, and of one DM place. Joins stored accounts
// and places and never derives an id from a person's spelling. A DM place holds the private records of its chat:
// a record belongs to the place its `audience_id` names, whoever the record is about. The context decides before anything
// is read: a place outside its audiences adds no account, record or count. An internal context reads every place, every
// merge and the past links; an outward one follows only the owner's merges (person-links.ts#personMembers). Source text
// stays in the rows as stored. Called through src/memory/db/service.ts (`privateByPerson`, `privateByPlace`).

import { dmPlacesOfAccounts, personMembers } from './person-links.ts';
import { AUD_INTERNAL, allowedAudience, dmAudienceId } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

// The tables whose rows are private memory of a chat. Chats themselves are read through places.
const RECORD_TABLES = ['claims', 'descriptions', 'episodes', 'affinity_events'] as const;

export type PrivatePerson = { id: string; requestedId: string; mergedFrom: Array<string> };
export type PrivateAccount = {
  id: string;
  interfaceId: string | null;
  authorityId: string | null;
  nativeId: string | null;
  generation: number | null;
  linkState: string | null;
  linkValidFromAt: string | null;
};
export type PrivatePlace = {
  id: string;
  interfaceId: string | null;
  authorityId: string | null;
  generation: number | null;
  partnerAccountId: string | null;
  partnerPersonId: string | null;
  seenFromAt: string | null;
  seenToAt: string | null;
};
export type PrivatePastLink = {
  accountId: string;
  personId: string;
  state: string | null;
  by: string | null;
  validFromAt: string | null;
  validToAt: string | null;
};
export type PrivateRecord = {
  table: (typeof RECORD_TABLES)[number];
  id: string;
  audienceId: string;
  placeId: string;
  row: Row;
};
export type PrivatePersonView =
  | {
      found: true;
      person: PrivatePerson;
      accounts: Array<PrivateAccount>;
      places: Array<PrivatePlace>;
      pastLinks: Array<PrivatePastLink>;
      records: Array<PrivateRecord>;
      counts: { places: number; records: number };
    }
  | { found: false; code: 'PERSON_NOT_FOUND' };
export type PrivatePlaceView =
  | {
      found: true;
      place: PrivatePlace;
      person: PrivatePerson | null;
      records: Array<PrivateRecord>;
      counts: { records: number };
    }
  | { found: false; code: 'PLACE_NOT_FOUND' };

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** A DM audience the context may read; throws without a valid context (scope.ts#allowedAudience). */
const mayRead = (place: Row, context: Context): boolean =>
  allowedAudience({ audience_id: dmAudienceId(place.id) }, context);

function accountOf(db: Db, row: Row): PrivateAccount {
  const link = db
    .prepare(
      `SELECT valid_from_at FROM account_person_links WHERE account_id = ? AND person_id = ? AND valid_to_at IS NULL
       ORDER BY recorded_at DESC, id LIMIT 1`
    )
    .get(row.id, row.person_id);
  return {
    id: String(row.id),
    interfaceId: textOrNull(row.iface),
    authorityId: textOrNull(row.authority_id),
    nativeId: textOrNull(row.native_id) ?? textOrNull(row.native_key),
    generation: numberOrNull(row.generation),
    linkState: textOrNull(row.link),
    linkValidFromAt: textOrNull(link?.valid_from_at) ?? textOrNull(row.linked_at),
  };
}

function placeOf(row: Row): PrivatePlace {
  return {
    id: String(row.id),
    interfaceId: textOrNull(row.iface),
    authorityId: textOrNull(row.authority_id),
    generation: numberOrNull(row.generation),
    partnerAccountId: textOrNull(row.partner_account),
    partnerPersonId: textOrNull(row.partner_person),
    seenFromAt: textOrNull(row.seen_from_at),
    seenToAt: textOrNull(row.seen_to_at),
  };
}

function recordsOf(db: Db, place: Row): Array<PrivateRecord> {
  const audienceId = dmAudienceId(place.id);
  return RECORD_TABLES.flatMap((table) =>
    db
      .prepare(`SELECT * FROM ${table} WHERE audience_id = ? AND retired_at IS NULL ORDER BY rowid`)
      .all(audienceId)
      .map((row) => ({ table, id: String(row.id), audienceId, placeId: String(place.id), row: { ...row } }))
  );
}

function pastLinksOf(db: Db, people: ReadonlyArray<string>): Array<PrivatePastLink> {
  return db
    .prepare(
      `SELECT * FROM account_person_links WHERE person_id IN (${people.map(() => '?').join(', ')})
       AND valid_to_at IS NOT NULL ORDER BY valid_to_at, id`
    )
    .all(...people)
    .map((row) => ({
      accountId: String(row.account_id),
      personId: String(row.person_id),
      state: textOrNull(row.state),
      by: textOrNull(row.by),
      validFromAt: textOrNull(row.valid_from_at),
      validToAt: textOrNull(row.valid_to_at),
    }));
}

/** The private view of a person: what `context` may read of every DM of their verified accounts. */
export function privateByPerson(db: Db, personId: string, context: Context): PrivatePersonView {
  allowedAudience({ audience_id: AUD_INTERNAL }, context);
  const internal = context.internal === true;
  const members = personMembers(db, personId, { ownerMergesOnly: !internal });
  const known = db.prepare('SELECT 1 AS ok FROM people WHERE id = ?').get(personId) !== undefined;
  if (!known && members.accounts.length === 0) return { found: false, code: 'PERSON_NOT_FOUND' };
  const places = dmPlacesOfAccounts(
    db,
    members.accounts.map((account) => account.id)
  ).filter((place) => mayRead(place, context));
  const shown = new Set(places.map((place) => place.partner_account));
  const records = places.flatMap((place) => recordsOf(db, place));
  return {
    found: true,
    person: {
      id: internal || places.length > 0 ? members.survivor : personId,
      requestedId: personId,
      mergedFrom: internal ? members.mergedFrom : [],
    },
    accounts: members.accounts.filter((account) => internal || shown.has(account.id)).map((row) => accountOf(db, row)),
    places: places.map(placeOf),
    pastLinks: internal ? pastLinksOf(db, [members.survivor, ...members.mergedFrom]) : [],
    records,
    counts: { places: places.length, records: records.length },
  };
}

/** The partner of a DM place, when the place's account has a verified person. */
function partnerOf(db: Db, place: Row, internal: boolean): PrivatePerson | null {
  const account = db.prepare('SELECT person_id, link FROM accounts WHERE id = ?').get(place.partner_account);
  if (account?.link !== 'verified' || typeof account.person_id !== 'string') return null;
  const members = personMembers(db, account.person_id, { ownerMergesOnly: !internal });
  return {
    id: members.survivor,
    requestedId: account.person_id,
    mergedFrom: internal ? members.mergedFrom : [],
  };
}

/** The private view of one DM place: its own records and its partner, for a context that may read it. */
export function privateByPlace(db: Db, placeId: string, context: Context): PrivatePlaceView {
  allowedAudience({ audience_id: AUD_INTERNAL }, context);
  const place = db
    .prepare("SELECT * FROM places WHERE id = ? AND (kind = 'dm' OR chat = 'dm') AND retired_at IS NULL")
    .get(placeId);
  if (place === undefined) return { found: false, code: 'PLACE_NOT_FOUND' };
  if (!mayRead(place, context))
    return {
      found: true,
      place: { ...placeOf(place), partnerAccountId: null, partnerPersonId: null },
      person: null,
      records: [],
      counts: { records: 0 },
    };
  const records = recordsOf(db, place);
  const person = partnerOf(db, place, context.internal === true);
  return { found: true, place: placeOf(place), person, records, counts: { records: records.length } };
}

/**
 * What the person of `accountId` said in the DMs of their other linked accounts: the live claims about them under each
 * DM's own audience. Only places whose partner account is this person's: a claim under a stranger's DM stays there.
 */
export function linkedPrivateClaims(db: Db, accountId: string): Array<{ text: string }> {
  const person = db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(accountId)?.person_id;
  if (typeof person !== 'string') return [];
  const places = db
    .prepare(
      `SELECT p.id FROM places p JOIN accounts a ON a.id = p.partner_account
       WHERE a.person_id = ? AND a.id <> ? AND (p.kind = 'dm' OR p.chat = 'dm') AND p.retired_at IS NULL`
    )
    .all(person, accountId);
  const claims = db.prepare(
    `SELECT text FROM claims WHERE subject_kind = 'person' AND subject_id = ? AND audience_id = ? AND shown = 1
     AND truth = 'current' AND retired_at IS NULL ORDER BY rowid`
  );
  return places.flatMap((place) =>
    claims.all(person, dmAudienceId(place.id)).map((row) => ({ text: String(row.text) }))
  );
}
