// Audiences (src/memory/db/scope.ts): the one resolver from the scope triple to `audience_id` and back, the
// audience twins of the read rule (`allowedAudience`, `audienceWhere`), the full meet table of `narrowestAudience`,
// and the equivalence test: on fixtures with group, DM, two DMs of one person (one per interface), none, internal and
// malformed rows, every reader returns the same rows whether it reads the triple or `audience_id`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { SCOPED_TABLES } from '../../../../src/memory/db/schema.ts';
import {
  AUD_INTERNAL,
  AUD_NONE,
  CONTEXT_POLICY_VERSION,
  contextRow,
  SCOPE_INTERNAL,
  SCOPE_NONE,
  allowed,
  allowedAudience,
  audienceOf,
  audienceParts,
  audienceWhere,
  canRead,
  dmAudienceId,
  dmContext,
  dmScope,
  dmUserOf,
  groupContext,
  groupScope,
  groupsContext,
  internalContext,
  isIssuedInternalContext,
  isIssuedReadAllContext,
  issueContext,
  narrowestAudience,
  readContextSpec,
  scopeColumns,
  scopeOfAudience,
  scopeWhere,
  whereFor,
} from '../../../../src/memory/db/scope.ts';
import type { Context } from '../../../../src/memory/db/scope.ts';
import { channelPlaceId, dmPlaceId, messageSourceId } from '../../../../src/memory/db/ids.ts';
import { personId } from '../../../fixtures/memory-db/spelled-ids.ts';
import { search, window } from '../../../../src/memory/db/recall.ts';
import { fillStems } from '../../../../src/memory/db/stems.ts';
import { batchOf, buildSessionRequest, scopesOf } from '../../../../src/memory/db/session.ts';
import { gatherReview } from '../../../../src/memory/db/describe.ts';
import { labels } from '../../../fixtures/labels.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { sqlOf, wrongly } from '../../../fixtures/loose-types.ts';
import { after } from 'node:test';
import path from 'node:path';
import { createAppendStore } from '../../../../src/memory/append-store.ts';
import { createArchive } from '../../../../src/memory/archive.ts';
import { createMemoryDb, type MemoryDbService } from '../../../../src/memory/db/service.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import { createRecord, toRecordLine } from '../../../../src/memory/record.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { createVectors } from '../../../../src/memory/vectors.ts';
import { addAccount, addDmPlace, addGroupPlace } from '../../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ALICE = personId('discord', 'u-alice');
const BOB = personId('discord', 'u-bob');
/** The same human's DM on a second interface: a person id of that interface. */
const ALICE_OTHER = 'person:other:u-alice';

const SCOPES: Record<string, Untyped> = {
  none: { ...SCOPE_NONE },
  internal: { ...SCOPE_INTERNAL },
  group: groupScope('discord'),
  groupOther: groupScope('other'),
  dmAlice: dmScope(ALICE, 'discord'),
  dmBob: dmScope(BOB, 'discord'),
  dmAliceOther: dmScope(ALICE_OTHER, 'other'),
  malformedDm: { scope_kind: 'dm', scope_iface: 'discord', scope_dm: 'not-a-person' },
  malformedGroup: { scope_kind: 'group', scope_iface: null, scope_dm: null },
  unknownKind: { scope_kind: 'whatever', scope_iface: 'discord', scope_dm: null },
  nullKind: { scope_kind: null, scope_iface: null, scope_dm: null },
};

const CONTEXTS = {
  group: groupContext('discord'),
  groupOther: groupContext('other'),
  dmAlice: dmContext(ALICE, 'discord', dmPlaceId('discord', 'u-alice')),
  dmBob: dmContext(BOB, 'discord', dmPlaceId('discord', 'u-bob')),
  dmAliceOther: dmContext(ALICE_OTHER, 'other', dmPlaceId('other', 'u-alice')),
  internal: internalContext(),
};
const viaAudience = (ctx: Record<string, Untyped>) => ({ ...ctx, audienceColumn: true });
/** The stored DM place of each DM scope above, as its writer knows it: `audienceOf` works out none from the person id. */
const DM_PLACES: Record<string, string> = {
  dmAlice: dmPlaceId('discord', 'u-alice'),
  dmBob: dmPlaceId('discord', 'u-bob'),
  dmAliceOther: 'other:dm:u-alice',
};
const PARTNERS: Record<string, { iface: string; partner_person: string }> = {
  [DM_PLACES.dmAlice]: { iface: 'discord', partner_person: ALICE },
  [DM_PLACES.dmBob]: { iface: 'discord', partner_person: BOB },
  [DM_PLACES.dmAliceOther]: { iface: 'other', partner_person: ALICE_OTHER },
};
/** The `places` row a reader finds for a DM place id, null for a place no row holds. */
const placeLookup = (place: string) => PARTNERS[place] ?? null;
/** A scope of SCOPES resolved the way its writer resolves it, with the DM place it knows. */
const resolvedOf = (name: string) => audienceOf(SCOPES[name], { dmPlace: DM_PLACES[name] ?? null });

test('audienceOf: each kind of triple, the DM place of the partner, malformed is internal', () => {
  assert.deepEqual(audienceOf(SCOPES.none), { ...SCOPE_NONE, audience_id: AUD_NONE });
  assert.equal(audienceOf(SCOPES.internal).audience_id, AUD_INTERNAL);
  assert.equal(audienceOf(SCOPES.group).audience_id, 'aud:group:discord');
  assert.equal(audienceOf(SCOPES.groupOther).audience_id, 'aud:group:other');
  // A DM triple names its chat only through the place its writer passes. A legacy person id spells a DM place, and
  // nothing reads that spelling.
  assert.deepEqual(resolvedOf('dmAlice'), {
    ...SCOPES.dmAlice,
    audience_id: `aud:dm:${dmPlaceId('discord', 'u-alice')}`,
  });
  assert.equal(resolvedOf('dmAliceOther').audience_id, 'aud:dm:other:dm:u-alice');
  for (const name of ['malformedDm', 'malformedGroup', 'unknownKind', 'nullKind']) {
    const got = audienceOf(SCOPES[name]);
    assert.equal(got.audience_id, AUD_INTERNAL, name);
    assert.deepEqual(
      { scope_kind: got.scope_kind, scope_iface: got.scope_iface, scope_dm: got.scope_dm },
      SCOPES[name],
      `${name}: the triple comes back as given`
    );
  }
  assert.equal(audienceOf(undefined).audience_id, AUD_INTERNAL);
  assert.equal(
    audienceOf(SCOPES.dmAlice, { dmPlace: 'discord:dm:chat-2' }).audience_id,
    'aud:dm:discord:dm:chat-2',
    'a writer that knows the DM place names it'
  );
  assert.equal(
    audienceOf(dmScope('person:0f3c-uuid', 'discord')).audience_id,
    AUD_INTERNAL,
    'a new person id has no DM place of its own spelling'
  );
  assert.equal(
    audienceOf(SCOPES.dmAlice).audience_id,
    AUD_INTERNAL,
    'a legacy person id spells a DM place, and no audience is worked out from that spelling'
  );
  assert.equal(
    audienceOf(dmScope('person:0f3c-uuid', 'discord'), { dmPlace: 'discord:dm:p' }).audience_id,
    'aud:dm:discord:dm:p'
  );
});

test('scopeOfAudience: the triple back from an audience id', () => {
  // A DM audience goes back through its place row, never the spelling of its id.
  for (const name of ['none', 'internal', 'group', 'groupOther', 'dmAlice', 'dmBob', 'dmAliceOther']) {
    assert.deepEqual(scopeOfAudience(resolvedOf(name).audience_id, placeLookup), SCOPES[name], name);
  }
  assert.deepEqual(
    scopeOfAudience(`aud:dm:${dmPlaceId('discord', 'u-alice')}`),
    SCOPE_INTERNAL,
    'without a place reader, the partner the place id spells is never read'
  );
  assert.deepEqual(
    scopeOfAudience(`aud:dm:${dmPlaceId('discord', 'u-carol')}`, placeLookup),
    SCOPE_INTERNAL,
    'a DM audience whose place no row holds is internal'
  );
  assert.deepEqual(
    scopeOfAudience('aud:dm:discord:dm:p', () => ({ iface: 'discord', partner_person: 'person:0f3c-uuid' })),
    dmScope('person:0f3c-uuid', 'discord'),
    'the place row names the partner'
  );
  assert.deepEqual(scopeOfAudience('aud:whatever'), SCOPE_INTERNAL);
});

test('allowedAudience and audienceWhere give exactly what allowed and whereFor give, for every context and row', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  db.exec('CREATE TABLE probe (name TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, audience_id TEXT)');
  // Each DM row is resolved with the place its writer knows, and no place is spelled from a person.
  const rows = Object.fromEntries(Object.keys(SCOPES).map((name) => [name, resolvedOf(name)]));
  for (const [name, row] of Object.entries(rows))
    db.prepare('INSERT INTO probe VALUES (?, ?, ?, ?, ?)').run(
      name,
      row.scope_kind,
      row.scope_iface,
      row.scope_dm,
      row.audience_id
    );
  try {
    for (const [ctxName, ctx] of Object.entries(CONTEXTS)) {
      for (const [rowName, row] of Object.entries(rows)) {
        assert.equal(allowedAudience(row, ctx), allowed(row, ctx), `${ctxName} reading ${rowName}`);
        assert.equal(canRead(row, viaAudience(ctx)), canRead(row, ctx), `${ctxName} reading ${rowName} (dispatch)`);
      }
      const triple = whereFor(ctx, 'p');
      const twin = audienceWhere(ctx, 'p');
      const read = (where: { sql: string; params: Array<unknown> }) =>
        db
          .prepare(`SELECT p.name FROM probe p WHERE ${where.sql} ORDER BY p.name`)
          .all(...where.params)
          .map((row) => row.name);
      assert.deepEqual(read(twin), read(triple), ctxName);
      assert.deepEqual(read(scopeWhere(viaAudience(ctx), 'p')), read(triple), `${ctxName} (dispatch)`);
    }
    assert.throws(() => audienceWhere({ kind: 'group' }), /scope context/);
    assert.throws(() => allowedAudience(rows.none, null), /scope context/);
  } finally {
    handle.close();
  }
});

test('an open group context reads a direct chat row through audienceWhere and a closed one does not', () => {
  // Bug: the switch that opens the persona's memory leaves the audience filter closed, so a group turn misses a direct chat.
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  db.exec('CREATE TABLE probe (name TEXT, audience_id TEXT)');
  db.prepare('INSERT INTO probe VALUES (?, ?)').run('dm', 'aud:dm:place:dm-1');
  db.prepare('INSERT INTO probe VALUES (?, ?)').run('group', 'aud:group:discord');
  const read = (ctx: unknown): Array<unknown> => {
    const where = audienceWhere(ctx, 'p');
    const rows: Array<Record<string, unknown>> = db
      .prepare(`SELECT p.name FROM probe p WHERE ${where.sql} ORDER BY p.name`)
      .all(...where.params);
    return rows.map((row) => row.name);
  };
  try {
    const context = (open: boolean) => issueContext({ kind: 'group', iface: 'discord', open, now: () => 0 });
    assert.deepEqual(read(context(true)), ['dm', 'group']);
    assert.deepEqual(read(context(false)), ['group']);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-1' }, context(true)), true);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-1' }, context(false)), false);
  } finally {
    handle.close();
  }
});

test('narrowestAudience: the full meet table', () => {
  const N = AUD_NONE;
  const I = AUD_INTERNAL;
  const G = 'aud:group:discord';
  const GO = 'aud:group:other';
  const DA = `aud:dm:${dmPlaceId('discord', 'u-alice')}`;
  const DB = `aud:dm:${dmPlaceId('discord', 'u-bob')}`;
  const DO = 'aud:dm:other:dm:u-alice';
  const table = [
    [[], N],
    [[N, N], N],
    [[N, G], G],
    [[N, DA], DA],
    [[N, I], I],
    [[I, G], I],
    [[I, DA], I],
    [[G, I], I],
    [[G, G], G],
    [[G, DA], DA],
    [[DA, G], DA],
    [[DA, DA], DA],
    [[DA, DB], I],
    // Policy 2 intersects visibility rather than interface provenance.
    [[G, GO], G],
    [[GO, G], GO],
    [[DA, GO], DA],
    [[GO, DA], DA],
    [[G, DO], DO],
    [[DO, G], DO],
    [['aud:group:', G], I],
    [[DA, DO], I],
    [[N, G, DA, N], DA],
    [[DB, G, DA], I],
    [['aud:unknown', G], I],
  ];
  // A DM audience's interface comes from its place row, so the meet reads places.
  for (const [input, want] of table) assert.equal(narrowestAudience(input, placeLookup), want, JSON.stringify(input));
});

test('an unresolved DM audience fails closed while an opaque place resolved by lookup remains private', () => {
  // Catches treating an unresolved private identifier as valid when relaxing cross-interface group intersections.
  assert.equal(narrowestAudience(['aud:dm:garbage']), AUD_INTERNAL);
  const audience = 'aud:dm:opaque-place';
  const lookup = (place: string) => (place === 'opaque-place' ? { iface: 'discord', partner_person: ALICE } : null);
  assert.equal(narrowestAudience([audience], lookup), audience);
  assert.equal(narrowestAudience(['aud:group:other', audience], lookup), audience);
  assert.equal(narrowestAudience([audience, 'aud:group:other'], lookup), audience);
  const resolved = audienceParts(audience, lookup);
  assert.ok(resolved);
  assert.equal(narrowestAudience([resolved]), audience);
  assert.equal(narrowestAudience([resolved, 'aud:group:other']), audience);
});

test('DM audience objects fail closed when their resolved interface metadata is inconsistent or nontext', () => {
  // Catches malformed resolved metadata bypassing private audience validation.
  const invalid = [
    { id: 'aud:dm:discord:dm:one', kind: 'dm', place_id: 'discord:dm:one', iface: 'other' },
    { id: 'aud:dm:opaque-place', kind: 'dm', place_id: 'opaque-place', iface: 42 },
  ];
  // The place row is what refutes the forged interface, so the meet gets the place reader every caller passes. Nothing
  // reads the spelling of the place id.
  const lookup = (place: string) => (place === 'discord:dm:one' ? { iface: 'discord' } : null);
  assert.deepEqual(
    invalid.map((parts) => narrowestAudience([parts], lookup)),
    [AUD_INTERNAL, AUD_INTERNAL]
  );
});

test('a forged audience kind cannot make private provenance source-free', () => {
  // Catches declaring private evidence source-free to widen a derived audience.
  const privateAsNone = { id: 'aud:dm:discord:dm:one', kind: 'none', iface: 'discord', place_id: 'discord:dm:one' };
  assert.equal(narrowestAudience([privateAsNone, 'aud:group:discord']), AUD_INTERNAL);
});

test('forged shared place metadata cannot merge distinct DM audiences', () => {
  // Catches joining distinct DMs through forged shared place metadata.
  const forgedPlaces = ['one', 'two'].map((name) => ({
    id: `aud:dm:discord:dm:${name}`,
    kind: 'dm',
    iface: 'discord',
    place_id: 'same-forged',
  }));
  assert.equal(narrowestAudience(forgedPlaces), AUD_INTERNAL);
});

test('incidental person and place fields do not give a group context private audience access', () => {
  // Catches using a group's incidental identity fields as authorization to include a DM audience.
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  const place = dmPlaceId('discord', 'u-alice');
  const ctx = { ...groupContext('discord'), person: ALICE, place };
  const rows = [
    { id: 'group', audience_id: 'aud:group:other' },
    { id: 'private', audience_id: `aud:dm:${place}` },
  ];
  try {
    db.exec('CREATE TABLE probe (id TEXT, audience_id TEXT)');
    for (const row of rows) db.prepare('INSERT INTO probe VALUES (?, ?)').run(row.id, row.audience_id);
    assert.deepEqual(
      rows.filter((row) => allowedAudience(row, ctx)).map((row) => row.id),
      ['group']
    );
    const filter = audienceWhere(ctx, 'p');
    assert.deepEqual(
      db
        .prepare(`SELECT id FROM probe p WHERE ${filter.sql}`)
        .all(...filter.params)
        .map((row) => row.id),
      ['group']
    );
    assert.equal(allowed(dmScope(ALICE, 'discord'), ctx), false);
  } finally {
    handle.close();
  }
});

test('the groups-only selector excludes its own DM even when the context retains DM fields', () => {
  // Catches private identity fields overriding an explicit groups-only read restriction.
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  const ctx = { ...dmContext(ALICE, 'discord', dmPlaceId('discord', 'u-alice')), ...groupsContext() };
  const rows = [
    { id: 'group', ...audienceOf(groupScope('other')) },
    { id: 'private', ...resolvedOf('dmAlice') },
  ];
  try {
    db.exec('CREATE TABLE probe (id TEXT, audience_id TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT)');
    for (const row of rows) {
      db.prepare('INSERT INTO probe VALUES (?, ?, ?, ?, ?)').run(
        row.id,
        row.audience_id,
        row.scope_kind,
        row.scope_iface,
        row.scope_dm
      );
    }
    assert.deepEqual(
      rows.filter((row) => allowedAudience(row, ctx)).map((row) => row.id),
      ['group']
    );
    assert.deepEqual(
      rows.filter((row) => allowed(row, ctx)).map((row) => row.id),
      ['group']
    );
    for (const filter of [audienceWhere(ctx, 'p'), whereFor(ctx, 'p')]) {
      assert.deepEqual(
        db
          .prepare(`SELECT id FROM probe p WHERE ${filter.sql}`)
          .all(...filter.params)
          .map((row) => row.id),
        ['group']
      );
    }
  } finally {
    handle.close();
  }
});

test('issueContext: an id, the mode, the DM place of the partner; contexts stay valid read contexts', () => {
  let n = 0;
  const newId = () => `ctx:test-${(n += 1)}`;
  // The caller names the DM place it found in `places`, and the partner's person id spells none.
  const dm = issueContext({
    kind: 'dm',
    iface: 'discord',
    person: ALICE,
    place: dmPlaceId('discord', 'u-alice'),
    now: () => NOW,
    newId,
  });
  assert.deepEqual(
    [dm.id, dm.mode, dm.kind, dm.place, dm.destination, dm.issuedAt],
    [
      'ctx:test-1',
      'outward',
      'dm',
      dmPlaceId('discord', 'u-alice'),
      dmPlaceId('discord', 'u-alice'),
      new Date(NOW).toISOString(),
    ]
  );
  const group = issueContext(
    wrongly({
      kind: 'group',
      iface: 'discord',
      destination: channelPlaceId('discord', 'c1'),
      now: () => NOW,
      newId,
      audienceColumn: true,
    })
  );
  assert.deepEqual(
    [group.mode, group.iface, group.destination, group.audienceColumn],
    ['outward', 'discord', channelPlaceId('discord', 'c1'), true]
  );
  const inner = issueContext({ kind: 'internal', now: () => NOW, newId });
  assert.equal(inner.mode, 'internal');
  for (const ctx of [dm, group, inner]) assert.doesNotThrow(() => whereFor(ctx));
});

// ---------- the equivalence of the readers ----------

/** A database with lines, claims, episodes, intentions and descriptions in every kind of scope, written through insertRows. */
function equivalenceFixture() {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  const rows: Record<string, Array<Untyped>> = {
    people: [],
    accounts: [],
    places: [],
    sources: [],
    claims: [],
    episodes: [],
    intentions: [],
    descriptions: [],
    description_versions: [],
    claim_sources: [],
  };
  for (const [user, name] of [
    ['u-alice', 'Alíki'],
    ['u-bob', 'Bob'],
  ]) {
    rows.people.push({ id: personId('discord', user), kind: 'member' });
    rows.accounts.push({
      id: `discord:${user}`,
      iface: 'discord',
      native_id: user,
      person_id: personId('discord', user),
      link: 'verified',
      names: JSON.stringify([name]),
    });
  }
  // The stored DM place of each DM scope: a DM row's audience is the place whose row names its partner.
  for (const [place, { iface, partner_person }] of Object.entries(PARTNERS))
    rows.places.push({
      id: place,
      iface,
      kind: 'dm',
      native_id: null,
      scope_kind: 'dm',
      partner_person,
      partner_account: `${iface}:${place.slice(place.lastIndexOf(':') + 1)}`,
    });
  let at = NOW - 3 * 3600_000;
  const placeOf = (name: string) =>
    name.startsWith('dm')
      ? name === 'dmAliceOther'
        ? 'other:dm:u-alice'
        : name === 'dmBob'
          ? dmPlaceId('discord', 'u-bob')
          : dmPlaceId('discord', 'u-alice')
      : channelPlaceId('discord', `c-${name}`);
  let n = 0;
  for (const [name, scope] of Object.entries(SCOPES)) {
    for (let i = 0; i < 3; i += 1) {
      n += 1;
      at += 60_000;
      const native = `m${n}`;
      rows.sources.push({
        id: messageSourceId('discord', native, 1, 'seen'),
        kind: 'seen',
        iface: scope.scope_iface ?? 'discord',
        native_id: native,
        revision: 1,
        place_id: placeOf(name),
        author_account: i % 2 ? 'discord:u-bob' : 'discord:u-alice',
        reply_to: i > 0 ? `m${n - 1}` : null,
        occurred_at: new Date(at).toISOString(),
        recorded_at: new Date(at).toISOString(),
        text: `marmalade talk ${name} ${i}`,
        direct: 0,
        ...scope,
      });
    }
    rows.claims.push({
      id: `k-${name}`,
      subject_kind: 'person',
      subject_id: ALICE,
      kind: 'detail',
      text: `likes marmalade (${name})`,
      how: 'said',
      author: 'her',
      truth: 'current',
      shown: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      first_seen_at: '2026-10-01',
      last_seen_at: '2026-10-02',
      ...scope,
    });
    rows.claims.push({
      id: `self-${name}`,
      subject_kind: 'self',
      subject_id: 'person:self',
      kind: 'self_fact',
      text: `a self fact (${name})`,
      how: 'said',
      author: 'her',
      truth: 'current',
      shown: 1,
      ...scope,
    });
    rows.episodes.push({
      id: `e-${name}`,
      kind: 'profile',
      subject_id: ALICE,
      what: `an afternoon (${name})`,
      status: 'open',
      date: '2026-10-02',
      ...scope,
    });
    rows.intentions.push({
      id: `i-${name}`,
      record: JSON.stringify({ id: `i-${name}`, status: 'open', purpose: `ask u-alice (${name})` }),
      status: 'open',
      archived: 0,
      created_ms: n,
      ...scope,
    });
    rows.descriptions.push({
      id: `desc:${name}`,
      subject_kind: 'person',
      subject_id: ALICE,
      field: 'character',
      current_version: `dv:${name}`,
      ...scope,
    });
    rows.description_versions.push({
      id: `dv:${name}`,
      description_id: `desc:${name}`,
      text: `Alíki (${name})`,
      author: 'import',
      origin: 'legacy',
    });
    const sources = rows.sources;
    rows.claim_sources.push({
      claim_id: `k-${name}`,
      source_id: sources[sources.length - 1].id,
      position: 0,
    });
  }
  insertRows(db, rows);
  fillStems(wrongly(db));
  return { handle, db, done: () => handle.close() };
}

test('equivalence: every scoped table returns the same ids under the triple and under audience_id', () => {
  const env = equivalenceFixture();
  try {
    for (const table of SCOPED_TABLES) {
      const key = table === 'vectors' ? 'chunk_key' : 'rowid';
      for (const [ctxName, ctx] of Object.entries(CONTEXTS)) {
        const read = (where: { sql: string; params: Array<unknown> }) =>
          sqlOf(env)
            .prepare(`SELECT t.${key} AS k FROM "${table}" t WHERE ${where.sql} ORDER BY 1`)
            .all(...where.params)
            .map((row) => row.k);
        assert.deepEqual(read(audienceWhere(ctx, 't')), read(whereFor(ctx, 't')), `${table} in ${ctxName}`);
      }
      assert.equal(
        sqlOf(env).prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE audience_id IS NULL`).get().n,
        0,
        `${table}: every row has an audience`
      );
    }
  } finally {
    env.done();
  }
});

test('equivalence: recall search, the hidden hint and windows read the same under both predicates', () => {
  const env = equivalenceFixture();
  try {
    const plan = { forms: ['marmalade'], who: [], from: null, to: null };
    const contexts = {
      ...CONTEXTS,
      groupAskedByAlice: { ...CONTEXTS.group, asker: [ALICE] },
      groupAskedByBob: { ...CONTEXTS.group, asker: [BOB] },
    };
    for (const [name, ctx] of Object.entries(contexts)) {
      const a = search(env.db, { ctx, plan, now: NOW, limit: 20 });
      const b = search(env.db, { ctx: viaAudience(ctx), plan, now: NOW, limit: 20 });
      assert.deepEqual(
        b.hits.map((hit) => hit.messageId),
        a.hits.map((hit) => hit.messageId),
        `${name}: hits`
      );
      assert.deepEqual(b.windows, a.windows, `${name}: windows`);
      assert.equal(b.hidden, a.hidden, `${name}: hidden`);
      for (const anchor of ['m3', 'm9', 'm15', 'm21', 'm6']) {
        for (const move of ['up', 'down']) {
          const wa = window(env.db, { ctx, anchor, move, messages: 5 });
          const wb = window(env.db, { ctx: viaAudience(ctx), anchor, move, messages: 5 });
          assert.deepEqual(wb, wa, `${name}: window ${anchor} ${move}`);
        }
      }
    }
    assert.equal(
      search(env.db, { ctx: contexts.groupAskedByAlice, plan: { ...plan, forms: ['dmalice'] }, now: NOW }).hidden,
      true,
      'the fixture exercises the hidden hint'
    );
    // Bug: an open group context still reports a better match as hidden, though it reads that match itself.
    const open = search(env.db, {
      ctx: { ...contexts.groupAskedByAlice, open: true },
      plan: { ...plan, forms: ['dmalice'] },
      now: NOW,
    });
    assert.equal(open.hidden, false);
    assert.notEqual(open.hits.length, 0);
  } finally {
    env.done();
  }
});

test("equivalence: the persona's memory session reads the same scopes, batches and request under both predicates", () => {
  const env = equivalenceFixture();
  try {
    const triple = scopesOf(env.db);
    const twin = scopesOf(env.db, { audienceColumn: true });
    assert.deepEqual(
      twin.map((scope) => scope.key),
      triple.map((scope) => scope.key)
    );
    const config = { bot: { timezone: 'UTC' }, memoryDb: { session: { maxPeople: 12 } } };
    const prompts = { main: 'S', 'memory/session': 'M', labels };
    for (let i = 0; i < triple.length; i += 1) {
      const args = { cursor: 0, since: null, maxMessages: 200, settleBefore: NOW };
      const a = batchOf(env.db, triple[i].scope, args);
      const b = batchOf(env.db, twin[i].scope, { ...args, audienceId: twin[i].audienceId });
      assert.deepEqual(b, a, `${triple[i].key}: batch`);
      const ra = buildSessionRequest({
        db: wrongly(env.db),
        scope: triple[i],
        batch: a,
        config,
        prompts,
        selfName: 'Ada',
        now: NOW,
      });
      const rb = buildSessionRequest({
        db: wrongly(env.db),
        scope: twin[i],
        batch: b,
        config,
        prompts,
        selfName: 'Ada',
        now: NOW,
      });
      assert.deepEqual(rb.messages, ra.messages, `${triple[i].key}: request`);
      assert.deepEqual([...rb.maps.claims], [...ra.maps.claims], `${triple[i].key}: claim map`);
      assert.deepEqual([...rb.maps.episodes], [...ra.maps.episodes], `${triple[i].key}: episode map`);
    }
  } finally {
    env.done();
  }
});

test('equivalence: the description review gathers the same claims and finds the same description', () => {
  const env = equivalenceFixture();
  try {
    const config = { bot: { timezone: 'UTC' } };
    for (const [name, readCtx] of Object.entries(CONTEXTS)) {
      if (readCtx.internal) continue;
      const a = gatherReview(wrongly(env.db), { kind: 'person', id: ALICE }, 'character', { config, readCtx });
      const b = gatherReview(wrongly(env.db), { kind: 'person', id: ALICE }, 'character', {
        config,
        readCtx: viaAudience(readCtx),
      });
      assert.deepEqual(
        b.claims.map((claim) => claim.id),
        a.claims.map((claim) => claim.id),
        `${name}: claims`
      );
      assert.equal(b.descriptionId, a.descriptionId, `${name}: description`);
      assert.deepEqual(b.evidence, a.evidence, `${name}: evidence`);
    }
  } finally {
    env.done();
  }
});

// A context the core issues reads through `audience_id` with no setting. The probe is a row the two predicates tell
// apart: its triple is Alice's DM, its audience the group's, so only a read through `audience_id` shows it in the group
// and in Bob's DM. That both predicates give the same rows on rows written through the one resolver is the equivalence
// test of the scoped tables above.
test('a context issued with no setting reads a row by its audience_id, not by its triple', () => {
  const probe = { ...dmScope(ALICE, 'discord'), audience_id: audienceOf(groupScope('discord')).audience_id };
  const group = issueContext({ kind: 'group', iface: 'discord', now: () => NOW, newId: () => 'ctx:probe' });
  const bob = issueContext({ kind: 'dm', iface: 'discord', person: BOB, now: () => NOW, newId: () => 'ctx:bob' });
  assert.deepEqual([canRead(probe, group), canRead(probe, bob)], [true, true]);
  const where = scopeWhere(group, 's');
  assert.deepEqual(where, audienceWhere(group, 's'));
});

test('ordinary audience predicates admit future group interfaces and isolate the exact DM place', () => {
  // Catches a finite audience list excluding new interfaces or broadening one DM to another place of the same person.
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  const rows = [
    ['none', 'aud:none'],
    ['group', 'aud:group:future-interface'],
    ['own', 'aud:dm:discord:dm:room-one'],
    ['other-place', 'aud:dm:discord:dm:room-two'],
    ['other-iface', 'aud:dm:future-interface:dm:room-one'],
    ['internal', 'aud:internal'],
    ['empty-group', 'aud:group:'],
    ['unknown', 'aud:other:future-interface'],
    ['missing', null],
  ] as const;
  try {
    db.exec('CREATE TABLE probe (id TEXT, audience_id TEXT)');
    for (const [id, audience] of rows) db.prepare('INSERT INTO probe VALUES (?, ?)').run(id, audience);
    const contexts = [
      { ctx: groupContext('discord'), ids: ['group', 'none'] },
      { ctx: groupContext('cli'), ids: ['group', 'none'] },
      { ctx: dmContext(ALICE, 'discord', 'discord:dm:room-one'), ids: ['group', 'none', 'own'] },
    ];
    for (const { ctx, ids } of contexts) {
      const where = audienceWhere(ctx, 'p');
      const got = db
        .prepare(`SELECT id FROM probe p WHERE ${where.sql} ORDER BY id`)
        .all(...where.params)
        .map((row) => row.id);
      assert.deepEqual(got, ids);
      assert.deepEqual(
        rows
          .filter(([, audience_id]) => allowedAudience({ audience_id }, ctx))
          .map(([id]) => id)
          .sort(),
        ids
      );
    }
  } finally {
    handle.close();
  }
});

test('recorded contexts use policy 2 without rewriting a historical context version', () => {
  // Catches applying the new read rule while labeling new contexts as policy 1 or rewriting historical evidence.
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  try {
    const historic = issueContext({
      kind: 'group',
      iface: 'discord',
      policyVersion: 1,
      now: () => NOW,
      newId: () => 'ctx:historic',
    });
    const current = issueContext({
      kind: 'dm',
      iface: 'discord',
      person: ALICE,
      place: dmPlaceId('discord', 'u-alice'),
      now: () => NOW,
      newId: () => 'ctx:current',
    });
    applyMemoryWrite(handle, { kind: 'context', context: contextRow(historic) });
    applyMemoryWrite(handle, { kind: 'context', context: contextRow(current) });
    assert.equal(CONTEXT_POLICY_VERSION, 2);
    assert.deepEqual(
      db
        .prepare('SELECT id, policy_version, mode FROM execution_contexts ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 'ctx:current', policy_version: 2, mode: 'outward' },
        { id: 'ctx:historic', policy_version: 1, mode: 'outward' },
      ]
    );
    assert.equal(current.destination, dmPlaceId('discord', 'u-alice'));
  } finally {
    handle.close();
  }
});

test('group audience predicates reject literal NUL bytes and keep encoded percent text', () => {
  // Catches JavaScript and SQLite disagreeing on group validity or malformed provenance remaining outward.
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  const rows = [
    { id: 'encoded', audience_id: 'aud:group:future-%00' },
    { id: 'nul-only', audience_id: 'aud:group:\0' },
    { id: 'nul-middle', audience_id: 'aud:group:future\0interface' },
  ];
  try {
    db.exec('CREATE TABLE probe (id TEXT, audience_id TEXT)');
    for (const row of rows) db.prepare('INSERT INTO probe VALUES (?, ?)').run(row.id, row.audience_id);
    for (const ctx of [
      groupContext('discord'),
      dmContext(ALICE, 'discord', dmPlaceId('discord', 'u-alice')),
      groupsContext(),
    ]) {
      assert.deepEqual(
        rows.filter((row) => allowedAudience(row, ctx)).map((row) => row.id),
        ['encoded']
      );
      const filter = audienceWhere(ctx, 'p');
      assert.deepEqual(
        db
          .prepare(`SELECT id FROM probe p WHERE ${filter.sql}`)
          .all(...filter.params)
          .map((row) => row.id),
        ['encoded']
      );
    }
    for (const audience of ['aud:group:\0', 'aud:group:future\0interface']) {
      assert.equal(narrowestAudience([audience, 'aud:group:discord']), AUD_INTERNAL);
      assert.equal(
        narrowestAudience([{ id: audience, kind: 'group', iface: 'discord', place_id: null }]),
        AUD_INTERNAL
      );
    }
    assert.equal(narrowestAudience(['aud:group:future-%00', 'aud:group:discord']), 'aud:group:future-%00');
  } finally {
    handle.close();
  }
});

// ---------- audiences by their row ----------

test('audienceParts reads the interface of a DM audience from its place row, never from the place id', () => {
  // Catches the interface of a DM worked out from the spelling of its place id.
  const audience = `aud:dm:${dmPlaceId('discord', 'u-alice')}`;
  assert.equal(audienceParts(audience)?.iface, null);
  assert.equal(audienceParts(audience, () => ({ iface: 'other' }))?.iface, 'other');
});

// ---------- the read rule over the scope triple ----------

const MATRIX_ALICE = personId('discord', '100000000000000001');
const MATRIX_BOB = personId('discord', '100000000000000002');

test('scope columns from an old scope object', () => {
  assert.deepEqual(scopeColumns({ channel: '200000000000000001' }, { iface: 'discord' }), groupScope('discord'));
  assert.deepEqual(scopeColumns({ place: 'discord:guild:1' }, { iface: 'discord' }), groupScope('discord'));
  // A scope written with no interface names none, and no group's audience reads it.
  assert.deepEqual(scopeColumns({ channel: '200000000000000001' }), groupScope(null));
  assert.deepEqual(scopeColumns({}), SCOPE_INTERNAL, 'an unknown legacy scope is never shown outward');
  assert.deepEqual(scopeColumns(undefined), SCOPE_INTERNAL);
  // A member's DM is the stored one its reader gives; with no reader nothing is stored and the scope is internal.
  assert.deepEqual(scopeColumns({ user: '100000000000000001' }), SCOPE_INTERNAL);
  const dmOf = (id: string) => (id === '100000000000000001' ? dmScope(MATRIX_ALICE, 'discord') : null);
  assert.deepEqual(scopeColumns({ user: '100000000000000001' }, { dmOf }), dmScope(MATRIX_ALICE, 'discord'));
});

test('a private layer of user U is a DM scope with U whatever the line names', () => {
  // The member's DM comes from the stored-DM reader, never from a person id spelled out of the member's id.
  const dmOf = (id: string) => (id === '100000000000000001' ? dmScope(MATRIX_ALICE, 'discord') : null);
  const opts = { privateUser: '100000000000000001', dmOf };
  assert.deepEqual(scopeColumns({ channel: '200000000000000009' }, opts), dmScope(MATRIX_ALICE, 'discord'));
  assert.deepEqual(scopeColumns({}, opts), dmScope(MATRIX_ALICE, 'discord'));
  assert.deepEqual(scopeColumns(undefined, opts), dmScope(MATRIX_ALICE, 'discord'));
});

const ROWS: Record<string, Record<string, string | null>> = {
  none: { scope_kind: 'none', scope_iface: null, scope_dm: null },
  group: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
  groupOther: { scope_kind: 'group', scope_iface: 'other', scope_dm: null },
  dmAlice: { scope_kind: 'dm', scope_iface: 'discord', scope_dm: MATRIX_ALICE },
  dmBob: { scope_kind: 'dm', scope_iface: 'discord', scope_dm: MATRIX_BOB },
  dmOtherIface: { scope_kind: 'dm', scope_iface: 'other', scope_dm: MATRIX_ALICE },
  internal: { scope_kind: 'internal', scope_iface: null, scope_dm: null },
};

// Policy 2 makes every valid group eligible across interfaces while retaining DM restrictions.
const MATRIX: Record<string, Record<string, boolean>> = {
  group: {
    none: true,
    group: true,
    groupOther: true,
    dmAlice: false,
    dmBob: false,
    dmOtherIface: false,
    internal: false,
  },
  dmAlice: {
    none: true,
    group: true,
    groupOther: true,
    dmAlice: true,
    dmBob: false,
    dmOtherIface: false,
    internal: false,
  },
  dmBob: {
    none: true,
    group: true,
    groupOther: true,
    dmAlice: false,
    dmBob: true,
    dmOtherIface: false,
    internal: false,
  },
  internal: Object.fromEntries(Object.keys(ROWS).map((name) => [name, true])),
};

const MATRIX_CONTEXTS: Record<string, Context> = {
  group: groupContext('discord'),
  dmAlice: dmContext(MATRIX_ALICE, 'discord', dmPlaceId('discord', '100000000000000001')),
  dmBob: dmContext(MATRIX_BOB, 'discord', dmPlaceId('discord', '100000000000000002')),
  internal: internalContext(),
};

test('allowed: the matrix of contexts and row scopes', () => {
  for (const [ctxName, expected] of Object.entries(MATRIX)) {
    for (const [rowName, want] of Object.entries(expected)) {
      assert.equal(allowed(ROWS[rowName], MATRIX_CONTEXTS[ctxName]), want, `${ctxName} reading ${rowName}`);
    }
  }
});

test('the SQL filter returns exactly the rows allowed() lets through', () => {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  db.exec('CREATE TABLE probe (name TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT)');
  for (const [name, row] of Object.entries(ROWS)) {
    db.prepare('INSERT INTO probe VALUES (?, ?, ?, ?)').run(name, row.scope_kind, row.scope_iface, row.scope_dm);
  }
  for (const [ctxName, ctx] of Object.entries(MATRIX_CONTEXTS)) {
    const { sql, params } = whereFor(ctx);
    const got = db
      .prepare(`SELECT name FROM probe WHERE ${sql} ORDER BY name`)
      .all(...params)
      .map((row) => row.name);
    const want = Object.keys(ROWS)
      .filter((name) => allowed(ROWS[name], ctx))
      .sort();
    assert.deepEqual(got, want, ctxName);
  }
  const aliased = whereFor(MATRIX_CONTEXTS.dmAlice, 'p');
  const got = db
    .prepare(`SELECT p.name FROM probe p WHERE ${aliased.sql} ORDER BY p.name`)
    .all(...aliased.params)
    .map((row) => row.name);
  // Policy 2 includes the foreign-interface group in the same aliased SQL read.
  assert.deepEqual(got, ['dmAlice', 'group', 'groupOther', 'none']);
  handle.close();
});

// The diary's entry is written for every group chat and no direct chat (stage 3 design, section 5): the
// context reads `none` and the groups of every interface, never a DM or an internal row.
test('groupsContext reads the groups of every interface and no direct chat', () => {
  const want = {
    none: true,
    group: true,
    groupOther: true,
    dmAlice: false,
    dmBob: false,
    dmOtherIface: false,
    internal: false,
  };
  for (const [rowName, expected] of Object.entries(want)) {
    assert.equal(allowed(ROWS[rowName], groupsContext()), expected, rowName);
  }
});

test('the SQL filter of groupsContext returns the same rows as allowed()', () => {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  db.exec('CREATE TABLE probe (name TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT)');
  for (const [name, row] of Object.entries(ROWS)) {
    db.prepare('INSERT INTO probe VALUES (?, ?, ?, ?)').run(name, row.scope_kind, row.scope_iface, row.scope_dm);
  }
  const { sql, params } = whereFor(groupsContext());
  const got = db
    .prepare(`SELECT name FROM probe WHERE ${sql} ORDER BY name`)
    .all(...params)
    .map((row) => row.name);
  assert.deepEqual(got, ['group', 'groupOther', 'none']);
  handle.close();
});

test('groupsContext on the audience column reads none and every group audience, no DM and nothing internal', () => {
  const ctx = { ...groupsContext(), audienceColumn: true };
  const verdicts = ['aud:none', 'aud:group:discord', 'aud:group:other', 'aud:dm:discord:dm:1', 'aud:internal'].map(
    (audience_id) => allowedAudience({ audience_id }, ctx)
  );
  assert.deepEqual(verdicts, [true, true, true, false, false]);
});

test('a read with no context, or an invalid one, throws', () => {
  for (const bad of [
    undefined,
    null,
    {},
    { kind: 'group' },
    { iface: 'discord' },
    { iface: 'discord', kind: 'dm' },
    { kind: 'dm', person: MATRIX_ALICE },
    { internal: false },
    'group',
  ]) {
    assert.throws(() => allowed(ROWS.none, bad), /scope context/, JSON.stringify(bad));
    assert.throws(() => whereFor(bad), /scope context/, JSON.stringify(bad));
  }
});

test('a row with an unknown scope kind is shown to nobody but the internal context', () => {
  const odd = { scope_kind: 'whatever', scope_iface: 'discord', scope_dm: null };
  assert.equal(allowed(odd, MATRIX_CONTEXTS.group), false);
  assert.equal(allowed(odd, MATRIX_CONTEXTS.dmAlice), false);
  assert.equal(allowed(odd, MATRIX_CONTEXTS.internal), true);
});

test('an internal row derived from two DMs is never shown outward', () => {
  const derived = SCOPE_INTERNAL;
  for (const name of ['group', 'dmAlice', 'dmBob']) assert.equal(allowed(derived, MATRIX_CONTEXTS[name]), false);
  assert.equal(allowed(derived, MATRIX_CONTEXTS.internal), true);
});

test('ordinary SQL and memory reads reject malformed groups while admitting an unknown interface', () => {
  // Catches removing interface equality without retaining the valid nonempty interface requirement.
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  const rows = [
    { name: 'valid', scope_kind: 'group', scope_iface: 'future-interface', scope_dm: null },
    { name: 'empty', scope_kind: 'group', scope_iface: '', scope_dm: null },
    { name: 'null', scope_kind: 'group', scope_iface: null, scope_dm: null },
    { name: 'unknown', scope_kind: 'other', scope_iface: 'future-interface', scope_dm: null },
  ];
  try {
    db.exec('CREATE TABLE probe (name TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT)');
    for (const row of rows)
      db.prepare('INSERT INTO probe VALUES (?, ?, ?, ?)').run(row.name, row.scope_kind, row.scope_iface, row.scope_dm);
    for (const ctx of [
      groupContext('discord'),
      dmContext(MATRIX_ALICE, 'discord', dmPlaceId('discord', '100000000000000001')),
    ]) {
      assert.deepEqual(
        rows.filter((row) => allowed(row, ctx)).map((row) => row.name),
        ['valid']
      );
      const where = whereFor(ctx, 'p');
      assert.deepEqual(
        db
          .prepare(`SELECT name FROM probe p WHERE ${where.sql}`)
          .all(...where.params)
          .map((row) => row.name),
        ['valid']
      );
    }
  } finally {
    handle.close();
  }
});

test('group scope identifiers reject literal NUL bytes but preserve an encoded percent sequence', () => {
  // Catches malformed group provenance becoming readable or surviving a derived scope intersection.
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  const rows = [
    { id: 'encoded', ...groupScope('future-%00') },
    { id: 'nul-only', ...groupScope('\0') },
    { id: 'nul-middle', ...groupScope('future\0interface') },
  ];
  try {
    db.exec('CREATE TABLE probe (id TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT)');
    for (const row of rows)
      db.prepare('INSERT INTO probe VALUES (?, ?, ?, ?)').run(row.id, row.scope_kind, row.scope_iface, row.scope_dm);
    for (const ctx of [
      groupContext('discord'),
      dmContext(MATRIX_ALICE, 'discord', dmPlaceId('discord', '100000000000000001')),
      groupsContext(),
    ]) {
      assert.deepEqual(
        rows.filter((row) => allowed(row, ctx)).map((row) => row.id),
        ['encoded']
      );
      const filter = whereFor(ctx, 'p');
      assert.deepEqual(
        db
          .prepare(`SELECT id FROM probe p WHERE ${filter.sql}`)
          .all(...filter.params)
          .map((row) => row.id),
        ['encoded']
      );
    }
  } finally {
    handle.close();
  }
});

test('the internal context validator refuses a primitive value without throwing', () => {
  assert.equal(isIssuedInternalContext('internal'), false);
});

test('the internal context validator refuses an empty execution ID', () => {
  assert.equal(isIssuedInternalContext({ id: '', mode: 'internal', internal: true }), false);
});

test('a trusted caller reads everywhere with an issued open context and never with a forged one', () => {
  // Bug: the open mark is honoured on any object, so a context the core did not issue opens every chat.
  const issued = (open: boolean) => issueContext({ kind: 'group', iface: 'discord', open, now: () => 0 });
  assert.equal(isIssuedReadAllContext(issued(true)), true);
  assert.equal(isIssuedReadAllContext(issued(false)), false);
  assert.equal(isIssuedReadAllContext({ kind: 'group', iface: 'discord', open: true }), false);
  assert.equal(isIssuedReadAllContext(issueContext({ kind: 'internal', now: () => 0 })), true);
});

test('a DM context reads no DM its partner id spells when the caller names no place', () => {
  // Bug: the context works the place out of the person id, so a DM nobody stored opens by spelling alone.
  const ctx = { ...dmContext(MATRIX_ALICE, 'discord', null), audienceColumn: true };
  assert.equal(canRead({ audience_id: dmAudienceId(dmPlaceId('discord', '100000000000000001')) }, ctx), false);
  assert.equal(canRead({ audience_id: 'aud:group:discord' }, ctx), true);
});

test('a DM context with a place and no person reads its DM and no DM row whose person is left unnamed', () => {
  // Bug: a DM nobody linked cannot be issued without a person, so it is given one spelled from its place.
  const ctx = issueContext({ kind: 'dm', iface: 'discord', person: null, place: 'place:dm-unlinked' });
  assert.equal(ctx.person, undefined);
  assert.equal(canRead({ audience_id: dmAudienceId('place:dm-unlinked') }, ctx), true);
  assert.equal(
    allowed({ scope_kind: 'dm', scope_iface: 'discord' }, dmContext(null, 'discord', 'place:dm-unlinked')),
    false
  );
});

// ---------- scope columns that fail closed ----------

test('a DM place id named as a channel is scoped internal', () => {
  // Bug: `{ channel }` maps to a group scope whatever it names, so a DM line opens to every group.
  assert.deepEqual(scopeColumns({ channel: 'discord:dm:n1' }, { iface: 'discord' }), SCOPE_INTERNAL);
});

test('a DM place named without the private mark is scoped internal', () => {
  // Bug: an archived lesson of a DM carries `{ place }`, and a place maps to a group scope.
  assert.deepEqual(scopeColumns({ place: 'discord:dm:n1' }, { iface: 'discord' }), SCOPE_INTERNAL);
});

test('a line with the private mark and only a channel is scoped internal', () => {
  // Bug: the private mark is read only beside a place, so the channel rule opens the line.
  assert.deepEqual(scopeColumns({ channel: 'c1', private: true }, { iface: 'discord' }), SCOPE_INTERNAL);
});

test('a chat no place holds is scoped internal', () => {
  // Bug: a wake's line into a chat nobody can name as a group is filed as a group's.
  assert.deepEqual(scopeColumns({ channel: 'c1', unresolved: true }, { iface: 'discord' }), SCOPE_INTERNAL);
});

test('a real channel and a real place stay the group', () => {
  // Bug: a fail-closed rule that also closes every group's own history.
  assert.deepEqual(scopeColumns({ channel: 'c1' }, { iface: 'discord' }), groupScope('discord'));
  assert.deepEqual(scopeColumns({ place: 'discord:server:g1' }, { iface: 'discord' }), groupScope('discord'));
});

const CONTEXT_NOW = Date.parse('2026-11-08T12:00:00.000Z');
const CONTEXT_META = 'person:00000000-0000-4000-8000-000000000001';

test("a read's direct chat context names the person its resolver gives, never a spelled one", () => {
  // Bug: the spec names `person:cli:owner`, which no row holds, for the owner's command line chat.
  const asked: Array<string> = [];
  const spec = readContextSpec({
    chatIface: 'cli',
    home: 'discord',
    chatId: 'owner',
    privateAccountId: 'owner',
    personOf: (iface, native) => {
      asked.push(`${iface} ${native}`);
      return 'person:00000000-0000-4000-8000-000000000001';
    },
    dmPlaceOf: () => null,
    chatPlaceOf: () => null,
  });
  assert.deepEqual(asked, ['cli owner']);
  assert.deepEqual(spec, { iface: 'cli', kind: 'dm', person: 'person:00000000-0000-4000-8000-000000000001' });
});

test("a read's direct chat context of a partner no row names reads as the interface's group", () => {
  // Bug: the resolver finds no person, and the spec names none, so issuing the context throws and the turn reads nothing.
  const spec = readContextSpec({
    chatIface: 'discord',
    home: 'discord',
    chatId: 'c1',
    privateAccountId: '700',
    personOf: () => null,
    dmPlaceOf: () => null,
    chatPlaceOf: () => 'place:room',
  });
  assert.deepEqual(spec, { iface: 'discord', kind: 'group', destination: null });
});

test("a read's group context is issued for the place the chat's row holds, never one spelled from the chat id", () => {
  // Bug: a destination spelled `<iface>:channel:<id>` names a place no row holds when the room's id is opaque.
  const asked: Array<string> = [];
  const spec = readContextSpec({
    chatIface: 'discord',
    home: 'discord',
    chatId: 'c1',
    privateAccountId: null,
    personOf: () => null,
    dmPlaceOf: () => null,
    chatPlaceOf: (iface, native) => {
      asked.push(`${iface} ${native}`);
      return 'place:opaque-room';
    },
  });
  assert.deepEqual(
    [asked, spec],
    [['discord c1'], { iface: 'discord', kind: 'group', destination: 'place:opaque-room' }]
  );
});

test('the partner of a direct chat is read from the stored place its audience names', () => {
  // Bug: the partner is parsed out of the audience id, so a place whose id spells nobody gives back no member.
  const row = {
    scope_kind: 'dm',
    scope_iface: 'discord',
    scope_dm: CONTEXT_META,
    audience_id: dmAudienceId('place:opaque'),
  };
  assert.equal(
    dmUserOf(row, (audienceId) => (audienceId === dmAudienceId('place:opaque') ? '700' : null)),
    '700'
  );
});

test("a read's direct chat context of a meta-person reads the lines of the account's direct chat", () => {
  // Bug: the spec names no place, a meta-person spells none, so the issued context reads nothing private.
  const spec = readContextSpec({
    chatIface: 'discord',
    home: 'discord',
    chatId: 'c1',
    privateAccountId: '700',
    personOf: () => CONTEXT_META,
    dmPlaceOf: (iface, native) => `${iface}:dm:${native}`,
    chatPlaceOf: () => null,
  });
  const ctx = issueContext({ ...spec, now: () => CONTEXT_NOW });
  assert.equal(allowedAudience({ audience_id: dmAudienceId('discord:dm:700') }, ctx), true);
});

// What a direct message leaves in the journal, the record, the archive and the meaning index reaches its partner alone. A
// journal line of a DM names only its chat (`scope: { channel }`) and carries no private mark, so every reader
// that branched on the mark falls through to the channel rule or to none. Each test seeds one synthetic secret word through
// the writer a turn uses, over the real service and database, then reads as another reader: a group turn, another
// partner's private turn, the persona's own wake. Where the answer could be empty for want of a row, an internal context
// checks first that the row exists, so an empty answer means refused and never means unwritten. The last group asserts
// the converse: the partner's own private turn still reads their own lines.

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const DM_JOURNAL_PRIVACY_NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const SECRET = 'xylophonewhisper';

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const PARTNER = 'n1';
const PARTNER_ACCOUNT = 'discord:n1';
const PARTNER_PERSON = 'person:discord:n1';
const DM = 'discord:dm:n1';
const DM_CHAT = 'dm-chat-n1';
// Another partner on the same interface.
const OTHER = 'n2';
const OTHER_PERSON = 'person:discord:n2';
const OTHER_DM = 'discord:dm:n2';
const GROUP = 'discord:channel:room-1';
const SERVER = 'discord:server:g1';
// A partner with the same native id under another authority of the interface: the place's id spells nothing.
const STRANGER_ACCOUNT = 'account:other-authority';
const STRANGER_PERSON = 'person:elsewhere';
const STRANGER_DM = 'place:dm-other-authority';

/** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function seedWorld(db: Db): void {
  addAccount(db, {
    id: PARTNER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/global',
    native: PARTNER,
    person: PARTNER_PERSON,
  });
  addAccount(db, {
    id: 'discord:n2',
    iface: 'discord',
    authority: 'discord/global',
    native: OTHER,
    person: OTHER_PERSON,
  });
  addAccount(db, {
    id: STRANGER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/other',
    native: PARTNER,
    person: STRANGER_PERSON,
  });
  addDmPlace(db, {
    id: DM,
    iface: 'discord',
    authority: 'discord/global',
    account: PARTNER_ACCOUNT,
    person: PARTNER_PERSON,
  });
  addDmPlace(db, {
    id: OTHER_DM,
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n2',
    person: OTHER_PERSON,
  });
  addDmPlace(db, {
    id: STRANGER_DM,
    iface: 'discord',
    authority: 'discord/other',
    account: STRANGER_ACCOUNT,
    person: STRANGER_PERSON,
  });
  addGroupPlace(db, GROUP, 'discord', 'discord/global');
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
  ).run(SERVER);
}

function world() {
  const dataDir = tempDir('nep-dm-privacy-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedWorld(dbOf(seed));
  seed.close();
  const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
  const memoryDb = createMemoryDb({
    hot,
    dataDir,
    log: quiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  const journal = createJournal({ dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: quiet });
  const record = createRecord({ dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: quiet });
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
  const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: quiet });
  const vectors = createVectors({ dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: quiet });
  const store = createStore({ dataDir, archive, memoryDb });
  const contexts = {
    group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
    other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
    partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
    stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
  };
  return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
}
type World = ReturnType<typeof world>;

/** A record line of a chat: what a person said there. */
const lineSaid = (id: string, chat = DM_CHAT, by = PARTNER) =>
  toRecordLine(
    {
      id,
      placeId: chat,
      authorId: by,
      authorName: 'Partner',
      content: `the ${SECRET} plan`,
      ts: DM_JOURNAL_PRIVACY_NOW - 60_000,
    },
    { now: () => DM_JOURNAL_PRIVACY_NOW }
  );

/** Everything `search` hands a reader, as text. */
const searched = (w: World, ctx: unknown) =>
  JSON.stringify(
    search(w.read(), { ctx, plan: { forms: [SECRET], who: [], from: null, to: null }, now: DM_JOURNAL_PRIVACY_NOW })
  );

test('with context.memory.openPrivate on, a group, another partner and the diary find a DM line; off, none does', async () => {
  // Bug: the switch is read once, or never reaches the issued context, so the persona's reads stay split by place.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  await settled();
  const diary = () => w.memoryDb.issueContext({ kind: 'group', destination: null });
  const { hot } = w;
  hot.config.context.memory.openPrivate = true;
  const group = w.memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP });
  const other = w.memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM });
  for (const ctx of [group, other, diary()]) assert.equal(searched(w, ctx).includes(SECRET), true);
  hot.config.context.memory.openPrivate = false;
  for (const ctx of [w.contexts.group, w.contexts.other, diary()])
    assert.equal(searched(w, ctx).includes(SECRET), false);
});
