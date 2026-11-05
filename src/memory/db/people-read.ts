// The owner's reader of people, accounts and anonymous participants. Who someone is stays what was stored: a shared name is a
// search term and links nothing, an unlinked account and an anonymous participant stay discoverable on their own, and a merge
// keeps its history. The context decides before anything is counted. Reading writes nothing. Private views are
// private-read.ts's. src/interface/commands/memory.ts answers `/memory users`.

import { versionsNaming } from './entities-read.ts';
import { personMembers } from './person-links.ts';
import { placeVisibleWhere } from './places-read.ts';
import { privateByPerson } from './private-read.ts';
import type { PrivateAccount, PrivatePlace } from './private-read.ts';
import { checkLimit, contextBinding, keysetPage, positionOf } from './read-page.ts';
import type { Page } from './read-page.ts';
import { audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

export type PersonListing =
  | { kind: 'person'; id: string; names: Array<string>; accountIds: Array<string>; mergedInto: string | null }
  | {
      kind: 'account';
      id: string;
      interfaceId: string | null;
      authorityId: string | null;
      nativeId: string | null;
      generation: number | null;
      names: Array<string>;
    }
  | {
      kind: 'participant';
      id: string;
      authorityId: string | null;
      display: string | null;
      scopePlaceId: string | null;
    };
export type PersonFilters = { name: string | null; interfaceId: string | null; authorityId: string | null };
export type PersonLink = {
  id: string;
  accountId: string;
  personId: string;
  state: string | null;
  by: string | null;
  validFromAt: string | null;
  validToAt: string | null;
};
export type PersonMerge = {
  id: string;
  fromPerson: string;
  intoPerson: string;
  at: string | null;
  by: string | null;
  reason: string | null;
};
export type PersonRecord = { table: string; id: string; audienceId: string | null; retiredAt: string | null };
export type PersonDetail =
  | {
      found: true;
      person: { id: string; requestedId: string; mergedFrom: Array<string> };
      names: Array<string>;
      accounts: Array<PrivateAccount>;
      links: Array<PersonLink>;
      merges: Array<PersonMerge>;
      participants: Array<Row>;
      memberships: Array<Row>;
      affinity: { score: number | null; eventIds: Array<string> };
      privatePlaces: Array<PrivatePlace>;
      records: Array<PersonRecord>;
    }
  | { found: false; code: 'PERSON_NOT_FOUND' };

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const SAFE_NAMES = "json_each(CASE WHEN json_valid(a.names) THEN a.names ELSE '[]' END)";

// The tables whose rows are about a person, and the column that says which one.
const SUBJECT_TABLES = [
  { table: 'claims', where: "t.subject_kind IN ('person', 'self') AND t.subject_id" },
  { table: 'descriptions', where: "t.subject_kind IN ('person', 'self') AND t.subject_id" },
  { table: 'episodes', where: 't.subject_id' },
  { table: 'affinity_events', where: 't.person_id' },
] as const;

/** A semantic version it may read that names the person `p` in a role. */
const SEMANTIC_RECORD = `EXISTS (SELECT 1 FROM semantic_arguments g
  JOIN semantic_assertion_versions t ON t.version_id = g.version_id WHERE g.ref_kind = 'person' AND g.ref_id = p.id AND `;

/** The SQL that says a context may know of the person `p`: a record of theirs it may read exists. */
function personVisible(context: Context): { sql: string; params: Array<string> } {
  if (context.internal === true) return { sql: '1 = 1', params: [] };
  const audience = audienceWhere(context, 't');
  const subjects = SUBJECT_TABLES.map(
    ({ table, where }) => `EXISTS (SELECT 1 FROM ${table} t WHERE ${where} = p.id AND ${audience.sql})`
  );
  return {
    sql: `(${[...subjects, `${SEMANTIC_RECORD}${audience.sql})`].join(' OR ')})`,
    params: [...SUBJECT_TABLES.flatMap(() => audience.params), ...audience.params],
  };
}

/** The entries of the list as one ordered set: people, then unlinked accounts, then participants. */
function entriesSql(context: Context, filters: PersonFilters): { sql: string; params: Array<unknown> } {
  const visible = personVisible(context);
  const conditions = {
    person: [visible.sql],
    account: ["(a.person_id IS NULL OR a.link <> 'verified')"],
    participant: ['1 = 1'],
  };
  const params = {
    person: [...visible.params] as Array<unknown>,
    account: [] as Array<unknown>,
    participant: [] as Array<unknown>,
  };
  if (context.internal !== true) {
    const dm = placeVisibleWhere(context, 'pl');
    conditions.account.push(`NOT EXISTS (SELECT 1 FROM places pl WHERE pl.partner_account = a.id AND NOT ${dm.sql})`);
    params.account.push(...dm.params);
    conditions.participant.push(`EXISTS (SELECT 1 FROM places pl WHERE pl.id = pp.scope_place_id AND ${dm.sql})`);
    params.participant.push(...dm.params);
  }
  if (filters.name !== null) {
    conditions.person.push(
      `(instr(p.real_name, ?) > 0 OR EXISTS (SELECT 1 FROM accounts a, ${SAFE_NAMES} n
         WHERE a.person_id = p.id AND a.link = 'verified' AND instr(n.value, ?) > 0))`
    );
    params.person.push(filters.name, filters.name);
    conditions.account.push(`EXISTS (SELECT 1 FROM ${SAFE_NAMES} n WHERE instr(n.value, ?) > 0)`);
    params.account.push(filters.name);
    conditions.participant.push('instr(pp.display, ?) > 0');
    params.participant.push(filters.name);
  }
  if (filters.interfaceId !== null) {
    conditions.person.push(`EXISTS (SELECT 1 FROM accounts a WHERE a.person_id = p.id AND a.iface = ?)`);
    params.person.push(filters.interfaceId);
    conditions.account.push('a.iface = ?');
    params.account.push(filters.interfaceId);
    conditions.participant.push('EXISTS (SELECT 1 FROM authorities au WHERE au.id = pp.authority_id AND au.iface = ?)');
    params.participant.push(filters.interfaceId);
  }
  if (filters.authorityId !== null) {
    conditions.person.push(`EXISTS (SELECT 1 FROM accounts a WHERE a.person_id = p.id AND a.authority_id = ?)`);
    params.person.push(filters.authorityId);
    conditions.account.push('a.authority_id = ?');
    params.account.push(filters.authorityId);
    conditions.participant.push('pp.authority_id = ?');
    params.participant.push(filters.authorityId);
  }
  return {
    sql: `SELECT 0 AS ord, p.id AS id FROM people p WHERE ${conditions.person.join(' AND ')}
      UNION ALL SELECT 1, a.id FROM accounts a WHERE ${conditions.account.join(' AND ')}
      UNION ALL SELECT 2, pp.id FROM participants pp WHERE ${conditions.participant.join(' AND ')}`,
    params: [...params.person, ...params.account, ...params.participant],
  };
}

function namesOfJson(value: unknown): Array<string> {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The names the owner gave a person with `/memory users names add`: `alias` claims whose `author` is `owner`. A name her
 * memory session or the analyzer wrote is never one of them.
 */
export function ownerNamesOf(db: Db, personId: string): Array<string> {
  return db
    .prepare(
      "SELECT text FROM claims WHERE subject_id = ? AND kind = 'alias' AND author = 'owner' AND retired_at IS NULL ORDER BY created_at, id"
    )
    .all(personId)
    .map((row) => String(row.text))
    .filter(Boolean);
}

/** The names on record for a person: their verified accounts', the real name stored, and the ones the owner gave. */
function namesOfPerson(db: Db, ids: ReadonlyArray<string>): Array<string> {
  const marks = ids.map(() => '?').join(', ');
  const names = new Set<string>();
  for (const row of db.prepare(`SELECT real_name FROM people WHERE id IN (${marks})`).all(...ids))
    if (typeof row.real_name === 'string' && row.real_name !== '') names.add(row.real_name);
  for (const row of db
    .prepare(`SELECT names FROM accounts WHERE person_id IN (${marks}) AND link = 'verified' ORDER BY id`)
    .all(...ids))
    for (const name of namesOfJson(row.names)) names.add(name);
  for (const id of ids) for (const name of ownerNamesOf(db, id)) names.add(name);
  return [...names];
}

function hydrate(db: Db, ord: unknown, id: string): PersonListing {
  if (ord === 0) {
    const merged = db.prepare('SELECT into_person FROM people_merges WHERE from_person = ? ORDER BY at DESC').get(id);
    const accounts = db
      .prepare("SELECT id FROM accounts WHERE person_id = ? AND link = 'verified' ORDER BY id")
      .all(id)
      .map((row) => String(row.id));
    return {
      kind: 'person',
      id,
      names: namesOfPerson(db, [id]),
      accountIds: accounts,
      mergedInto: textOrNull(merged?.into_person),
    };
  }
  if (ord === 1) {
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return {
      kind: 'account',
      id,
      interfaceId: textOrNull(row?.iface),
      authorityId: textOrNull(row?.authority_id),
      nativeId: textOrNull(row?.native_id) ?? textOrNull(row?.native_key),
      generation: typeof row?.generation === 'number' ? row.generation : null,
      names: namesOfJson(row?.names),
    };
  }
  const row = db.prepare('SELECT * FROM participants WHERE id = ?').get(id);
  return {
    kind: 'participant',
    id,
    authorityId: textOrNull(row?.authority_id),
    display: textOrNull(row?.display),
    scopePlaceId: textOrNull(row?.scope_place_id),
  };
}

/** Each person once, each account no person holds, and each anonymous participant, as far as the context may know of them. */
export function listPeople(
  db: Db,
  request: { context: Context; filters: PersonFilters; limit: number; cursor: string | null }
): Page<PersonListing> {
  const { context, filters } = request;
  const binding = { reader: 'people.list', context: contextBinding(context), filters };
  const position = positionOf(request.cursor, binding);
  const limit = checkLimit(request.limit);
  const entries = entriesSql(context, filters);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM (${entries.sql})`).get(...entries.params)?.n);
  const after = Array.isArray(position) ? 'WHERE (ord, id) > (?, ?)' : '';
  const rows = db
    .prepare(`SELECT ord, id FROM (${entries.sql}) ${after} ORDER BY ord, id LIMIT ?`)
    .all(...entries.params, ...(Array.isArray(position) ? (position as Array<unknown>) : []), limit + 1);
  const keyed = rows.map((row) => ({ ord: row.ord, id: String(row.id) }));
  const page = keysetPage(keyed, limit, total, binding, (item) => [item.ord, item.id]);
  return { ...page, items: page.items.map((item) => hydrate(db, item.ord, item.id)) };
}

function recordsOf(db: Db, context: Context, ids: ReadonlyArray<string>): Array<PersonRecord> {
  const audience = audienceWhere(context, 't');
  const marks = ids.map(() => '?').join(', ');
  const semantic = versionsNaming(db, context, { kind: 'person', ids }).map(({ versionId, audienceId }) => ({
    table: 'semantic_assertion_versions',
    id: versionId,
    audienceId,
    retiredAt: null,
  }));
  const subjects = SUBJECT_TABLES.flatMap(({ table, where }) =>
    db
      .prepare(
        `SELECT t.id, t.audience_id, t.retired_at FROM ${table} t WHERE ${where} IN (${marks}) AND ${audience.sql}`
      )
      .all(...ids, ...audience.params)
      .map((row) => ({
        table,
        id: String(row.id),
        audienceId: textOrNull(row.audience_id),
        retiredAt: textOrNull(row.retired_at),
      }))
  );
  return [...subjects, ...semantic];
}

function affinityOf(
  db: Db,
  context: Context,
  ids: ReadonlyArray<string>
): { score: number | null; eventIds: Array<string> } {
  const audience = audienceWhere(context, 't');
  const events = db
    .prepare(
      `SELECT t.id, t.score FROM affinity_events t WHERE t.person_id IN (${ids.map(() => '?').join(', ')})
       AND ${audience.sql} ORDER BY t.at, t.id`
    )
    .all(...ids, ...audience.params);
  const newest = events.at(-1)?.score;
  return { score: typeof newest === 'number' ? newest : null, eventIds: events.map((row) => String(row.id)) };
}

/** What only the owner reads of a person's identity: every link with its window, and every merge. */
function identityHistory(db: Db, ids: ReadonlyArray<string>): { links: Array<PersonLink>; merges: Array<PersonMerge> } {
  const marks = ids.map(() => '?').join(', ');
  return {
    links: db
      .prepare(`SELECT * FROM account_person_links WHERE person_id IN (${marks}) ORDER BY recorded_at, id`)
      .all(...ids)
      .map((row) => ({
        id: String(row.id),
        accountId: String(row.account_id),
        personId: String(row.person_id),
        state: textOrNull(row.state),
        by: textOrNull(row.by),
        validFromAt: textOrNull(row.valid_from_at),
        validToAt: textOrNull(row.valid_to_at),
      })),
    merges: db
      .prepare(
        `SELECT * FROM people_merges WHERE from_person IN (${marks}) OR into_person IN (${marks}) ORDER BY at, id`
      )
      .all(...ids, ...ids)
      .map((row) => ({
        id: String(row.id),
        fromPerson: String(row.from_person),
        intoPerson: String(row.into_person),
        at: textOrNull(row.at),
        by: textOrNull(row.by),
        reason: textOrNull(row.reason),
      })),
  };
}

function presenceOf(db: Db, accounts: ReadonlyArray<string>): { participants: Array<Row>; memberships: Array<Row> } {
  if (accounts.length === 0) return { participants: [], memberships: [] };
  const marks = accounts.map(() => '?').join(', ');
  const copies = (rows: ReadonlyArray<Row>): Array<Row> => rows.map((row) => ({ ...row }));
  return {
    participants: copies(
      db
        .prepare(
          `SELECT pp.id, pp.authority_id, pp.scope_place_id, pp.display, l.state, l.valid_from_at, l.valid_to_at
           FROM participant_links l JOIN participants pp ON pp.id = l.participant_id
           WHERE l.account_id IN (${marks}) ORDER BY pp.id`
        )
        .all(...accounts)
    ),
    memberships: copies(
      db
        .prepare(
          `SELECT id, account_id, place_id, nick, valid_from_at, valid_to_at, retired_at FROM memberships
           WHERE account_id IN (${marks}) ORDER BY place_id, id`
        )
        .all(...accounts)
    ),
  };
}

/** One person with everything stored about them by exact id, as far as the context may read. */
export function personDetail(db: Db, personId: string, context: Context): PersonDetail {
  contextBinding(context);
  const view = privateByPerson(db, personId, context);
  if (!view.found) return view;
  const internal = context.internal === true;
  const members = personMembers(db, personId, { ownerMergesOnly: !internal });
  const ids = [members.survivor, ...members.mergedFrom];
  const records = recordsOf(db, context, ids);
  if (!internal && records.length === 0) return { found: false, code: 'PERSON_NOT_FOUND' };
  const history = internal ? identityHistory(db, ids) : { links: [], merges: [] };
  const presence = internal
    ? presenceOf(
        db,
        view.accounts.map((one) => one.id)
      )
    : { participants: [], memberships: [] };
  return {
    found: true,
    person: internal ? view.person : { id: members.survivor, requestedId: personId, mergedFrom: [] },
    names: namesOfPerson(db, ids),
    accounts: view.accounts,
    ...history,
    ...presence,
    affinity: affinityOf(db, context, ids),
    privatePlaces: view.places,
    records,
  };
}
