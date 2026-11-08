// The offline migration to the meta-person (plan 2026-11-08-meta-person, slice 4): every person becomes a meta-person
// with its accounts under it in `person_accounts`, everything keyed by an old person id moves to the meta-person, a
// line names its author's meta-person, and a second run changes nothing. A real temporary database over a synthetic
// world with interface-shaped person ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { reproject } from '../src/memory/db/graph.ts';
import { SELF_PERSON } from '../src/memory/db/ids.ts';
import { storageMapper } from '../src/memory/db/map/index.ts';
import { accountsOfPerson, personOfAccount } from '../src/memory/db/meta-person.ts';
import { migrateMetaPersons } from '../src/memory/db/meta-person-migrate.ts';
import type { MetaPersonReport } from '../src/memory/db/meta-person-migrate.ts';
import { inTransaction, openMemoryDb } from '../src/memory/db/open.ts';
import { mergePersonInto } from '../src/memory/db/person-merge.ts';
import { accountCollection, storageId } from '../src/memory/db/storage-keys.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { ensureUnit } from '../src/memory/db/storage-units.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';
import {
  addAccount,
  addAffinity,
  addClaim,
  addDmPlace,
  addEpisode,
  addGroupPlace,
} from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const AT = '2026-11-01T00:00:00.000Z';
const RUN_AT = '2026-11-08T20:00:00.000Z';
const DORA = 'person:chat:d1';
const EVE = 'person:chat:e1';
const EVE_ALT = 'person:chat:e2';
const OWNER = 'person:chat:o1';
const GUS = 'person:9f3c2a10';
const DORA_PLACE = 'chat:dm:d1';
const GROUP = 'chat:channel:g1';
const DORA_USER: StorageKey = accountCollection('user', 'chat:d1');
const DORA_VERSIONS: StorageKey = accountCollection('versions', 'chat:d1', {
  selector: { versionKind: 'users', itemId: 'd1' },
});
const OLD_IDS = [DORA, EVE, EVE_ALT, OWNER];

const uuids = (): (() => string) => {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
  };
};

/** Dora with a profile, claims, a description and its version, an episode, affinity, a line and graph nodes. */
function seedDora(db: Db): void {
  addAccount(db, { id: 'chat:d1', iface: 'chat', authority: 'chat/global', native: 'd1', person: DORA });
  db.prepare(
    `UPDATE accounts SET names = '["Dora Now","Dora Before"]', avatar = '{"hash":"h1"}' WHERE id = 'chat:d1'`
  ).run();
  const unit = ensureUnit(db, DORA_USER);
  ensureUnit(db, DORA_VERSIONS);
  db.prepare(
    `UPDATE people SET kind = 'member', affinity = 30, real_name = '{"name":"Dora"}', owner_key = ? WHERE id = ?`
  ).run(unit, DORA);
  addDmPlace(db, { id: DORA_PLACE, iface: 'chat', authority: 'chat/global', account: 'chat:d1', person: DORA });
  addClaim(db, `alias:${DORA}:aa`, DORA, 'aud:group:chat');
  addClaim(db, `detail:${DORA}:dm1`, DORA, `aud:dm:${DORA_PLACE}`);
  db.prepare("UPDATE claims SET scope_iface = 'chat', scope_dm = ? WHERE id = ?").run(DORA, `detail:${DORA}:dm1`);
  db.prepare('INSERT INTO claim_versions (id, claim_id, text, recorded_at) VALUES (?, ?, ?, ?)').run(
    `cv:detail:${DORA}:dm1`,
    `detail:${DORA}:dm1`,
    'a synthetic detail',
    AT
  );
  db.prepare(
    `INSERT INTO descriptions (id, subject_kind, subject_id, field, current_version, audience_id, scope_kind, scope_iface, owner_key)
     VALUES (?, 'person', ?, 'character', ?, 'aud:group:chat', 'group', 'chat', ?)`
  ).run(`desc:${DORA}:character`, DORA, `desc:${DORA}:character:v0`, unit);
  db.prepare(
    "INSERT INTO description_versions (id, description_id, text, origin, position) VALUES (?, ?, 'a synthetic character', 'legacy', 0)"
  ).run(`desc:${DORA}:character:v0`, `desc:${DORA}:character`);
  addEpisode(db, `episode:${DORA}:cc`, DORA, DORA_PLACE);
  addAffinity(db, `aff:${DORA}:0:bb`, DORA, DORA_PLACE);
  db.prepare(
    `INSERT INTO relationship_daily (person_id, day, audience_id, addressed_by_them, addressed_by_her, meaningful)
     VALUES (?, '2026-11-01', 'aud:group:chat', 2, 1, 0)`
  ).run(DORA);
  db.prepare(
    `INSERT INTO sources (id, kind, iface, place_id, author_account, author_kind, occurred_at, recorded_at, text,
       audience_id, scope_kind, scope_iface, scope_dm)
     VALUES ('src:chat:m1', 'seen', 'chat', ?, 'chat:d1', 'account', ?, ?, 'a synthetic line', ?, 'dm', 'chat', ?)`
  ).run(DORA_PLACE, AT, AT, `aud:dm:${DORA_PLACE}`, DORA);
  db.prepare(
    `INSERT INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at)
     VALUES ('legacy/local', 'person', ?, 1, ?, ?)`
  ).run(DORA, DORA, AT);
  db.prepare("INSERT INTO meta (key, value) VALUES ('memory_session.cursor.apply.dm:chat:person:chat:d1', '5')").run();
}

/** Two accounts of Eve, one person merged into the other; the owner with a chat account and a command-line account. */
function seedOthers(db: Db): void {
  addAccount(db, { id: 'chat:e1', iface: 'chat', authority: 'chat/global', native: 'e1', person: EVE });
  addAccount(db, { id: 'chat:e2', iface: 'chat', authority: 'chat/global', native: 'e2', person: EVE_ALT });
  addClaim(db, `alias:${EVE_ALT}:zz`, EVE_ALT, 'aud:group:chat');
  mergePersonInto(db, { from: EVE_ALT, into: EVE, by: 'owner', reason: 'seed', at: AT });
  addAccount(db, { id: 'chat:o1', iface: 'chat', authority: 'chat/global', native: 'o1', person: OWNER });
  db.prepare("INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES ('cli', 'cli', 1)").run();
  db.prepare("INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('cli/local', 'cli', 'cli/local')").run();
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, names)
     VALUES ('cli:owner', 'cli', 'owner', 'owner', 'cli/local', 1, 'user', '["Owner"]')`
  ).run();
  addAccount(db, { id: 'chat:g1', iface: 'chat', authority: 'chat/global', native: 'g1', person: GUS });
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, names)
     VALUES ('chat:u1', 'chat', 'u1', 'u1', 'chat/global', 1, 'user', '["Nobody Linked"]')`
  ).run();
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link)
     VALUES ('chat:self', 'chat', 'self1', 'self1', 'chat/global', 1, 'self', ?, 'verified')`
  ).run(SELF_PERSON);
  addGroupPlace(db, GROUP, 'chat', 'chat/global');
  db.prepare(
    `INSERT INTO participants (id, authority_id, scope_place_id, token_kind, native_token, generation, continuity, recorded_at)
     VALUES ('participant:t1', 'chat/global', ?, 'thread_token', 'tok1', 1, 'unknown', ?)`
  ).run(GROUP, AT);
  const line = db.prepare(
    `INSERT INTO sources (id, kind, iface, place_id, author_account, author_participant, author_kind, occurred_at,
       recorded_at, text, audience_id, scope_kind, scope_iface)
     VALUES (?, 'seen', 'chat', ?, ?, ?, ?, ?, ?, 'a synthetic line', 'aud:group:chat', 'group', 'chat')`
  );
  line.run('src:chat:anon1', GROUP, null, 'participant:t1', 'participant', AT, AT);
  line.run('src:chat:her1', GROUP, 'chat:self', null, 'self', AT, AT);
  line.run('src:chat:e2', GROUP, 'chat:e2', null, 'account', AT, AT);
}

function withWorld(body: (db: Db) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-meta-migrate-'), 'memory.db'));
  try {
    const db = dbOf(handle);
    seedDora(db);
    seedOthers(db);
    reproject(db, { at: AT });
    body(db);
  } finally {
    handle.close();
  }
}

const migrate = (db: Db, newId: () => string = uuids()): MetaPersonReport =>
  inTransaction(db, () => migrateMetaPersons(db, { ownerPerson: OWNER, at: RUN_AT, newId }));

const one = (db: Db, sql: string, ...args: Array<string>): Row | undefined => db.prepare(sql).get(...args);

const metaOf = (report: MetaPersonReport, old: string): string => {
  const meta = report.persons[old];
  if (meta === undefined) throw new Error(`no meta-person for ${old}`);
  return meta;
};

/** Every table and id column where an old person id still stands, outside the history and the words that keep it. */
function leftovers(db: Db, ids: ReadonlyArray<string>): Array<string> {
  const kept = new Set([
    'people.id',
    'people_merges.id',
    'people_merges.from_person',
    'account_person_links.id',
    'account_person_links.person_id',
    'external_keys.native_key',
    'meta.key',
  ]);
  const found: Array<string> = [];
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE 'sqlite_%'"
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => !/_(data|idx|docsize|config)$/.test(name));
  for (const table of tables)
    for (const column of db.prepare(`PRAGMA table_info("${table}")`).all()) {
      const name = `${table}.${String(column.name)}`;
      if (kept.has(name) || ['text', 'what'].includes(String(column.name))) continue;
      for (const id of ids) {
        const hit = db
          .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE CAST("${String(column.name)}" AS TEXT) GLOB ?`)
          .get(`*${id}`)?.n;
        const inside = db
          .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE CAST("${String(column.name)}" AS TEXT) GLOB ?`)
          .get(`*${id}[^0-9a-z]*`)?.n;
        if (Number(hit) + Number(inside) > 0) found.push(`${name} ${id}`);
      }
    }
  return found;
}

test('every interface-shaped person becomes a new meta-person and keeps its old id as a merged alias', () => {
  // Bug: the migration renames nothing, so people keep ids that spell an interface and the owner's model never holds.
  withWorld((db) => {
    const report = migrate(db);
    const dora = metaOf(report, DORA);
    assert.match(dora, /^person:[0-9a-f-]{36}$/);
    assert.equal(one(db, 'SELECT meta FROM people WHERE id = ?', dora)?.meta, 1);
    assert.equal(one(db, 'SELECT status FROM people WHERE id = ?', DORA)?.status, `merged_into:${dora}`);
    assert.equal(one(db, 'SELECT into_person FROM people_merges WHERE from_person = ?', DORA)?.into_person, dora);
  });
});

test('an opaque person is marked meta in place and her own person stays hers', () => {
  // Bug: a person whose id spells no interface gets a second id, and her own person loses the id every reader names.
  withWorld((db) => {
    const report = migrate(db);
    assert.equal(report.persons[GUS], undefined);
    assert.equal(one(db, 'SELECT meta FROM people WHERE id = ?', GUS)?.meta, 1);
    assert.equal(personOfAccount(db, 'chat:g1'), GUS);
    assert.equal(one(db, 'SELECT meta FROM people WHERE id = ?', SELF_PERSON)?.meta, 1);
    assert.equal(personOfAccount(db, 'chat:self'), SELF_PERSON);
  });
});

test('two people already merged end under one meta-person with both accounts', () => {
  // Bug: the merged person gets a meta-person of its own, so the merge the owner made splits again.
  withWorld((db) => {
    const report = migrate(db);
    const eve = metaOf(report, EVE);
    assert.equal(metaOf(report, EVE_ALT), eve);
    assert.deepEqual(
      accountsOfPerson(db, eve).map((account) => account.id),
      ['chat:e1', 'chat:e2']
    );
    assert.equal(one(db, 'SELECT subject_id FROM claims WHERE id = ?', `alias:${eve}:zz`)?.subject_id, eve);
  });
});

test('the owner is one meta-person holding his chat account and his command-line account', () => {
  // Bug: the command line's account stays outside the owner's meta-person, so his own chat is a stranger's.
  withWorld((db) => {
    const report = migrate(db);
    const owner = metaOf(report, OWNER);
    assert.deepEqual(report.ownerPerson, { from: OWNER, to: owner });
    assert.deepEqual(
      accountsOfPerson(db, owner).map((account) => account.id),
      ['chat:o1', 'cli:owner']
    );
  });
});

test('an account linked to nobody gets a meta-person of its own', () => {
  // Bug: an unlinked account stays without a person, and its lines never name one.
  withWorld((db) => {
    migrate(db);
    const person = personOfAccount(db, 'chat:u1');
    assert.match(String(person), /^person:[0-9a-f-]{36}$/);
    assert.equal(one(db, 'SELECT meta FROM people WHERE id = ?', String(person))?.meta, 1);
  });
});

test('claims, descriptions, versions, episodes, affinity and the daily counts move to the meta-person', () => {
  // Bug: rows keep the old subject or an id built from it, so a reader of the meta-person finds nothing of Dora.
  withWorld((db) => {
    const dora = metaOf(migrate(db), DORA);
    assert.deepEqual(
      db
        .prepare("SELECT id FROM claims WHERE subject_kind = 'person' AND subject_id = ? ORDER BY id")
        .all(dora)
        .map((row) => String(row.id)),
      [`alias:${dora}:aa`, `detail:${dora}:dm1`]
    );
    assert.equal(one(db, 'SELECT scope_dm FROM claims WHERE id = ?', `detail:${dora}:dm1`)?.scope_dm, dora);
    assert.equal(
      one(db, 'SELECT claim_id FROM claim_versions WHERE id = ?', `cv:detail:${dora}:dm1`)?.claim_id,
      `detail:${dora}:dm1`
    );
    const description = one(db, 'SELECT id, subject_id, current_version FROM descriptions WHERE subject_id = ?', dora);
    assert.equal(description?.id, `desc:${dora}:character`);
    assert.equal(description?.current_version, `desc:${dora}:character:v0`);
    assert.equal(
      one(db, 'SELECT description_id FROM description_versions WHERE id = ?', `desc:${dora}:character:v0`)
        ?.description_id,
      `desc:${dora}:character`
    );
    assert.equal(one(db, 'SELECT subject_id FROM episodes WHERE id = ?', `episode:${dora}:cc`)?.subject_id, dora);
    assert.equal(one(db, 'SELECT person_id FROM affinity_events WHERE id = ?', `aff:${dora}:0:bb`)?.person_id, dora);
    assert.equal(
      one(db, 'SELECT addressed_by_them FROM relationship_daily WHERE person_id = ?', dora)?.addressed_by_them,
      2
    );
    assert.equal(one(db, 'SELECT partner_person FROM places WHERE id = ?', DORA_PLACE)?.partner_person, dora);
    assert.equal(one(db, 'SELECT scope_dm FROM sources WHERE id = ?', 'src:chat:m1')?.scope_dm, dora);
  });
});

test('the graph, the name index and the alias keys name the meta-person and no old id is left', () => {
  // Bug: graph nodes, edges and access rows keep the old ids, so recall by the graph reaches a person nobody stores.
  withWorld((db) => {
    const dora = metaOf(migrate(db), DORA);
    assert.equal(one(db, 'SELECT row_id FROM graph_nodes WHERE id = ?', `person:${dora}`)?.row_id, dora);
    assert.equal(
      one(db, "SELECT node_id FROM external_keys WHERE authority_id = 'legacy/local' AND native_key = ?", DORA)
        ?.node_id,
      dora
    );
    assert.deepEqual(leftovers(db, OLD_IDS), []);
  });
});

test('the profile belongs to the meta-person and an account holds only its own fields', () => {
  // Bug: the account row takes the profile, or the meta-person loses the affinity and the name the old person held.
  withWorld((db) => {
    const dora = metaOf(migrate(db), DORA);
    const person = one(db, 'SELECT affinity, real_name, owner_key FROM people WHERE id = ?', dora);
    assert.equal(person?.affinity, 30);
    assert.equal(person?.real_name, '{"name":"Dora"}');
    assert.equal(person?.owner_key, storageId(DORA_USER));
    assert.equal(one(db, 'SELECT owner_key FROM people WHERE id = ?', DORA)?.owner_key, null);
    const account = one(
      db,
      'SELECT person_id, iface, platform_id, handle, display_name, avatar, profile_text FROM person_accounts WHERE id = ?',
      'chat:d1'
    );
    assert.deepEqual(
      { ...account },
      {
        person_id: dora,
        iface: 'chat',
        platform_id: 'd1',
        handle: null,
        display_name: 'Dora Now',
        avatar: '{"hash":"h1"}',
        profile_text: null,
      }
    );
  });
});

test('a line names the meta-person of its author and an anonymous line names none', () => {
  // Bug: `author_person` stays empty for every line, or an anonymous post is given a person.
  withWorld((db) => {
    const report = migrate(db);
    const authorOf = (id: string): unknown =>
      one(db, 'SELECT author_person FROM sources WHERE id = ?', id)?.author_person;
    assert.equal(authorOf('src:chat:m1'), metaOf(report, DORA));
    assert.equal(authorOf('src:chat:e2'), metaOf(report, EVE));
    assert.equal(authorOf('src:chat:her1'), SELF_PERSON);
    assert.equal(authorOf('src:chat:anon1'), null);
  });
});

/** A claim of Dora's whose version the semantic layer sealed: the version and its claim's id are immutable. */
function sealDoraClaim(db: Db): void {
  const claim = `detail:${DORA}:sealed`;
  addClaim(db, claim, DORA, 'aud:group:chat');
  db.prepare('INSERT INTO claim_versions (id, claim_id, text, recorded_at) VALUES (?, ?, ?, ?)').run(
    `cv:${claim}`,
    claim,
    'a sealed synthetic detail',
    AT
  );
  const roles = JSON.stringify({ roles: [{ role: 'left', min: 1, max: 1, refs: ['entity'], literals: [] }] });
  db.prepare(
    "INSERT INTO semantic_entity_kinds (id, version, definition_json, created_at) VALUES ('fixture.kind', 1, '{\"fields\":[]}', ?)"
  ).run(AT);
  db.prepare(
    "INSERT INTO semantic_predicate_versions (id, version, definition_json, created_at) VALUES ('fixture.relation', 1, ?, ?)"
  ).run(roles, AT);
  db.prepare(
    "INSERT INTO semantic_entities (id, kind, kind_version, created_at) VALUES ('ent:1', 'fixture.kind', 1, ?)"
  ).run(AT);
  db.prepare(
    "INSERT INTO semantic_arguments (version_id, role, position, ref_kind, ref_id, literal_json) VALUES (?, 'left', 0, 'entity', 'ent:1', NULL)"
  ).run(`cv:${claim}`);
  db.prepare(
    `INSERT INTO semantic_assertion_versions (version_id, format_version, assertion_kind, predicate_id, predicate_version,
       truth_state, how, polarity, valid_from_at, valid_to_at, recorded_at, audience_id, historical_metadata_complete)
     VALUES (?, 1, 'relation', 'fixture.relation', 1, 'current', 'said', 'positive', NULL, NULL, ?, 'aud:group:chat', 1)`
  ).run(`cv:${claim}`, AT);
}

test('a sealed claim version keeps its id and its claim moves to the meta-person under its own id', () => {
  // Bug: the rewrite of a sealed version aborts the whole migration, or renames a claim its immutable version names.
  withWorld((db) => {
    inTransaction(db, () => sealDoraClaim(db));
    const dora = metaOf(migrate(db), DORA);
    const claim = `detail:${DORA}:sealed`;
    assert.equal(one(db, 'SELECT claim_id FROM claim_versions WHERE id = ?', `cv:${claim}`)?.claim_id, claim);
    assert.equal(one(db, 'SELECT subject_id FROM claims WHERE id = ?', claim)?.subject_id, dora);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('an append-only row keeps the old id it was written with and the run goes on', () => {
  // Bug: the rewrite of an append-only log aborts the whole migration.
  withWorld((db) => {
    db.prepare(
      `INSERT INTO focus_events (id, person_id, at, new_bucket, reason, policy_version)
       VALUES (?, ?, ?, 'close', 'synthetic', 1)`
    ).run(`focus:${AT}:${DORA}`, DORA, AT);
    const report = migrate(db);
    assert.equal(one(db, 'SELECT person_id FROM focus_events WHERE id = ?', `focus:${AT}:${DORA}`)?.person_id, DORA);
    assert.equal(report.kept['focus_events.person_id'], 1);
  });
});

test('the session cursors keep the key their place spells', () => {
  // Bug: the cursor key is renamed while the sweep still spells it from the place, so a direct chat is read from the start.
  withWorld((db) => {
    migrate(db);
    assert.equal(
      one(db, "SELECT value FROM meta WHERE key = 'memory_session.cursor.apply.dm:chat:person:chat:d1'")?.value,
      '5'
    );
  });
});

test('the result passes the foreign key check', () => {
  // Bug: a renamed id leaves a version, a source link or an account pointing at a row that no longer exists.
  withWorld((db) => {
    migrate(db);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('a second run changes nothing', () => {
  // Bug: a second run mints another meta-person for each person or rewrites rows again.
  withWorld((db) => {
    const first = migrate(db);
    const digest = databaseDigest(db);
    const second = migrate(db, uuids());
    assert.deepEqual(databaseDigest(db), digest);
    assert.equal(second.minted, 0);
    assert.equal(second.accounts, 0);
    assert.equal(second.authorPerson, 0);
    assert.deepEqual(second.changed, {});
    assert.deepEqual(second.persons, first.persons);
  });
});

test('the counts before and after cover every table', () => {
  // Bug: the report leaves a table out, so a lost row goes unseen in the rehearsal.
  withWorld((db) => {
    const report = migrate(db);
    const { before, after } = report.counts;
    assert.equal(before.claims, after.claims);
    assert.equal(Number(after.person_accounts) - Number(before.person_accounts), report.accounts);
  });
});

test('the unit mappers write a migrated profile under the meta-person', () => {
  // Bug: the next write of Dora's profile or of her description versions spells the old person again and forks her rows.
  withWorld((db) => {
    const dora = metaOf(migrate(db), DORA);
    const user = storageMapper(db, DORA_USER, storageId(DORA_USER)).mapper.toRows(
      storageId(DORA_USER),
      { character: 'a synthetic character' },
      {}
    );
    const [person] = user.people ?? [];
    const [description] = user.descriptions ?? [];
    assert.equal(person?.id, dora);
    assert.equal(description?.id, `desc:${dora}:character`);
    const versions = storageMapper(db, DORA_VERSIONS, storageId(DORA_VERSIONS)).mapper.toRows(
      storageId(DORA_VERSIONS),
      { character: [{ at: AT, text: 'a synthetic character' }] },
      {}
    );
    const [version] = versions.description_versions ?? [];
    assert.equal(version?.description_id, `desc:${dora}:character`);
  });
});
