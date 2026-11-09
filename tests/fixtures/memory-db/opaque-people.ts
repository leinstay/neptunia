// A synthetic world of opaque people: `person:` ids that spell no interface, account and place node ids that spell no
// native id, so a reader that parses a person or manufactures a DM place finds nothing. One person (`ANNA`) holds two
// accounts on one interface and one on another. `BORIS` holds an account whose native id equals one of hers on another
// interface. Seeded directly over a connection the test owns, before the code under test reads.
import type { Db } from '../../../src/memory/db/types.ts';

export const ANNA = 'person:0b7a4c1e';
export const BORIS = 'person:6d2f9e03';
export const ANNA_ACCOUNTS = ['account:a11', 'account:a12', 'account:a21'];
export const ANNA_PLACES = ['place:dm-a11', 'place:dm-a12', 'place:dm-a21'];
export const BORIS_ACCOUNT = 'account:b21';
export const BORIS_PLACE = 'place:dm-b21';
export const GROUP_PLACE = 'place:room-1';
const AT = '2026-11-01T00:00:00.000Z';

export type AccountSeed = {
  id: string;
  iface: string;
  authority: string;
  native: string;
  generation?: number;
  person: string | null;
  link?: 'verified' | 'proposed';
};

export function addPerson(db: Db, id: string): void {
  db.prepare('INSERT OR IGNORE INTO people (id, first_seen_at) VALUES (?, ?)').run(id, AT);
}

export function addAuthority(db: Db, iface: string, authority: string): void {
  db.prepare('INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES (?, ?, 1)').run(iface, iface);
  db.prepare('INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES (?, ?, ?)').run(
    authority,
    iface,
    authority
  );
}

export function addAccount(db: Db, seed: AccountSeed): void {
  const link = seed.link ?? 'verified';
  addAuthority(db, seed.iface, seed.authority);
  if (seed.person !== null) addPerson(db, seed.person);
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link, linked_by, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, 'owner', ?)`
  ).run(
    seed.id,
    seed.iface,
    seed.native,
    seed.native,
    seed.authority,
    seed.generation ?? 1,
    link === 'verified' ? seed.person : null,
    link === 'verified' ? 'verified' : 'proposed',
    AT
  );
  if (seed.person === null) return;
  db.prepare(
    `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, valid_from_at, recorded_at)
     VALUES (?, ?, ?, ?, 'owner', 'seed', ?, ?)`
  ).run(`link:${seed.id}:${seed.person}`, seed.id, seed.person, link, AT, AT);
}

export function addDmPlace(
  db: Db,
  { id, iface, authority, account, person }: { id: string; iface: string; authority: string; account: string; person: string | null }
): void {
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind, partner_account, partner_person)
     VALUES (?, ?, 'dm', ?, ?, ?, 1, 'dm', 'dm', ?, ?)`
  ).run(id, iface, id, id, authority, account, person);
}

export function addGroupPlace(db: Db, id: string, iface: string, authority: string): void {
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, ?, 'channel', ?, ?, ?, 1, 'group', 'group')`
  ).run(id, iface, id, id, authority);
}

/** The audience row a scoped record points at. */
function addAudience(db: Db, audience: string): void {
  const place = audience.startsWith('aud:dm:') ? audience.slice('aud:dm:'.length) : null;
  if (place !== null) {
    const row = db.prepare('SELECT iface FROM places WHERE id = ?').get(place);
    db.prepare("INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', ?, ?)").run(
      audience,
      row?.iface ?? null,
      place
    );
    return;
  }
  const iface = audience.slice('aud:group:'.length);
  addAuthority(db, iface, `${iface}/global`);
  db.prepare("INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES (?, 'group', ?)").run(audience, iface);
}

/** One claim under `audience` about `subject`. */
// The claims, episodes and attitude moves below are her memory session's: writer `session` (profile-owner.ts).
export function addClaim(db: Db, id: string, subject: string, audience: string, text = `the words of ${id}`): void {
  addAudience(db, audience);
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, created_at, writer)
     VALUES (?, 'person', ?, 'detail', ?, 'current', 1, ?, ?, ?, 'session')`
  ).run(id, subject, text, audience, audience.startsWith('aud:dm:') ? 'dm' : 'group', AT);
}

export function addEpisode(db: Db, id: string, subject: string, place: string): void {
  addAudience(db, `aud:dm:${place}`);
  db.prepare(
    `INSERT INTO episodes (id, kind, subject_id, place_id, date, what, audience_id, scope_kind, created_at, writer)
     VALUES (?, 'private', ?, ?, '2026-11-01', ?, ?, 'dm', ?, 'session')`
  ).run(id, subject, place, `the event of ${id}`, `aud:dm:${place}`, AT);
}

export function addDescription(db: Db, id: string, subject: string, place: string): void {
  addAudience(db, `aud:dm:${place}`);
  db.prepare(
    `INSERT INTO descriptions (id, subject_kind, subject_id, field, audience_id, scope_kind)
     VALUES (?, 'person', ?, 'relationship', ?, 'dm')`
  ).run(id, subject, `aud:dm:${place}`);
}

export function addAffinity(db: Db, id: string, person: string, place: string): void {
  addAudience(db, `aud:dm:${place}`);
  db.prepare(
    `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, audience_id, scope_kind, writer)
     VALUES (?, ?, ?, 2, 2, 12, 'synthetic', ?, 'dm', 'session')`
  ).run(id, person, AT, `aud:dm:${place}`);
}

/** The whole world: her three accounts and DMs with one typed record of each table, his DM, one group room. */
export function seedOpaqueWorld(db: Db): void {
  addAccount(db, { id: 'account:a11', iface: 'discord', authority: 'discord/global', native: 'n1', person: ANNA });
  addAccount(db, { id: 'account:a12', iface: 'discord', authority: 'discord/global', native: 'n2', person: ANNA });
  addAccount(db, { id: 'account:a21', iface: 'telegram', authority: 'telegram/global', native: 'n1', person: ANNA });
  addAccount(db, { id: BORIS_ACCOUNT, iface: 'telegram', authority: 'telegram/global', native: 'n2', person: BORIS });
  addDmPlace(db, { id: 'place:dm-a11', iface: 'discord', authority: 'discord/global', account: 'account:a11', person: ANNA });
  addDmPlace(db, { id: 'place:dm-a12', iface: 'discord', authority: 'discord/global', account: 'account:a12', person: ANNA });
  addDmPlace(db, { id: 'place:dm-a21', iface: 'telegram', authority: 'telegram/global', account: 'account:a21', person: ANNA });
  addDmPlace(db, { id: BORIS_PLACE, iface: 'telegram', authority: 'telegram/global', account: BORIS_ACCOUNT, person: BORIS });
  addGroupPlace(db, GROUP_PLACE, 'discord', 'discord/global');
  addClaim(db, 'claim:a11', ANNA, 'aud:dm:place:dm-a11');
  addDescription(db, 'description:a12', ANNA, 'place:dm-a12');
  addEpisode(db, 'episode:a21', ANNA, 'place:dm-a21');
  addAffinity(db, 'affinity:a21', ANNA, 'place:dm-a21');
  // Said in a group about her: public, so never part of her private view.
  addClaim(db, 'claim:public', ANNA, 'aud:group:discord');
  // His chat, once about himself and once about her: both belong to his DM.
  addClaim(db, 'claim:b21', BORIS, `aud:dm:${BORIS_PLACE}`);
  addClaim(db, 'claim:about-anna-in-his-dm', ANNA, `aud:dm:${BORIS_PLACE}`);
}

/** The record ids of her three DMs as `seedOpaqueWorld` wrote them. */
export const ANNA_RECORDS = ['affinity:a21', 'claim:a11', 'description:a12', 'episode:a21'];

/** A channel an interface knows by `native`, stored under an id that spells nothing of it. */
export function addChannelPlace(
  db: Db,
  { id, iface, authority, native }: { id: string; iface: string; authority: string; native: string }
): void {
  addAuthority(db, iface, authority);
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, ?, 'channel', ?, ?, ?, 1, 'group', 'group')`
  ).run(id, iface, native, `channel:${native}`, authority);
}
