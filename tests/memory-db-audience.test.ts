// Audiences (schema v7, src/memory/db/scope.ts): the one resolver from the scope triple to `audience_id` and back, the
// audience twins of the read rule (`allowedAudience`, `audienceWhere`), the full meet table of `narrowestAudience`,
// and the equivalence test: on fixtures with group, DM, two DMs of one person (one per interface), none, internal and
// malformed rows, every reader returns the same rows whether it reads the triple or `audience_id`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbOf } from '../src/memory/db/types.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { deriveRow, ensureAudience, insertRows } from '../src/memory/db/rows.ts';
import { SCOPED_TABLES } from '../src/memory/db/schema.ts';
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
  dmContext,
  dmScope,
  groupContext,
  groupScope,
  groupsContext,
  internalContext,
  issueContext,
  narrowest,
  narrowestAudience,
  scopeOfAudience,
  scopeWhere,
  whereFor,
} from '../src/memory/db/scope.ts';
import type { Scope } from '../src/memory/db/scope.ts';
import { channelPlaceId, dmPlaceId, messageSourceId } from '../src/memory/db/ids.ts';
import { personId } from './fixtures/memory-db/spelled-ids.ts';
import { search, window } from '../src/memory/db/recall.ts';
import { fillStems } from '../src/memory/db/stems.ts';
import { batchOf, buildSessionRequest, scopesOf } from '../src/memory/db/session.ts';
import { gatherReview } from '../src/memory/db/describe.ts';
import { labels } from './fixtures/labels.ts';
import type { Untyped } from '../src/tools/types.ts';
import { sqlOf, wrongly } from './fixtures/loose-types.ts';

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
  // Changed with ids-by-links slice 3: a DM triple names its chat only through the place its writer passes. The legacy
  // person id spells a DM place, and that spelling is no longer read: the owner's rule of 2026-11-08.
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
  // Changed with ids-by-links slice 3: a DM audience goes back through its place row, never the spelling of its id.
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
  // Each DM row resolved with the place its writer knows (ids-by-links slice 3: no place is spelled from a person).
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
  // Changed with ids-by-links slice 3: a DM audience's interface comes from its place row, so the meet reads places.
  for (const [input, want] of table) assert.equal(narrowestAudience(input, placeLookup), want, JSON.stringify(input));
  // The same meet as the triple's narrowest, over every pair of well-formed scopes.
  const names = ['none', 'internal', 'group', 'groupOther', 'dmAlice', 'dmBob', 'dmAliceOther'];
  const placeOfScope = (scope: Scope) =>
    scope.scope_kind === 'dm'
      ? (Object.entries(PARTNERS).find(
          ([, partner]) => partner.iface === scope.scope_iface && partner.partner_person === scope.scope_dm
        )?.[0] ?? null)
      : null;
  for (const a of names) {
    for (const b of names) {
      const meet = narrowest([SCOPES[a], SCOPES[b]]);
      const viaTriple = audienceOf(meet, { dmPlace: placeOfScope(meet) }).audience_id;
      assert.equal(
        narrowestAudience([resolvedOf(a).audience_id, resolvedOf(b).audience_id], placeLookup),
        viaTriple,
        `${a} with ${b}`
      );
    }
  }
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
  // Changed with ids-by-links slice 3: the place row is what refutes the forged interface, so the meet gets the place
  // reader every caller passes. The place id's spelling refuted it before, and nothing reads that spelling any more.
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
  // The caller names the DM place it found in `places`: the partner's person id no longer spells it.
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
    rows.claim_sources.push({
      claim_id: `k-${name}`,
      source_id: rows.sources[rows.sources.length - 1].id,
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
  } finally {
    env.done();
  }
});

test('equivalence: her memory session reads the same scopes, batches and request under both predicates', () => {
  const env = equivalenceFixture();
  try {
    const triple = scopesOf(env.db);
    const twin = scopesOf(env.db, { audienceColumn: true });
    assert.deepEqual(
      twin.map((scope) => scope.key),
      triple.map((scope) => scope.key)
    );
    const config = { bot: { timezone: 'UTC' }, memoryDb: { session: { maxPeople: 12 } } };
    const prompts = { 'system-prompt': 'S', 'memory-session': 'M', labels };
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

// PR 7d: `memoryDb.audienceColumn` is code. A context the core issues reads through `audience_id` with no setting. The
// probe is a row the two predicates tell apart: its triple is Alice's DM, its audience the group's, so only a read
// through `audience_id` shows it in the group and in Bob's DM. That both predicates give the same rows on rows written
// through the one resolver is the equivalence test of the scoped tables above.
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

// ---------- audiences by their row (ids-by-links slice 3) ----------

/** A database holding the stored DM places `places` names, with their partners' accounts. */
function placesDb(places: ReadonlyArray<Record<string, unknown>>) {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  insertRows(db, {
    accounts: [
      { id: 'discord:acc-1', iface: 'discord', native_id: 'n-777', person_id: null, link: 'verified', names: '[]' },
    ],
    places: places.map((place) => ({ iface: 'discord', kind: 'dm', native_id: null, scope_kind: 'dm', ...place })),
  });
  return { handle, db };
}
const claimOf = (scope: Scope) => ({
  id: 'k-probe',
  subject_kind: 'person',
  subject_id: ALICE,
  kind: 'detail',
  text: 'x',
  ...scope,
});

test('audienceParts reads the interface of a DM audience from its place row, never from the place id', () => {
  // Catches the interface of a DM worked out from the spelling of its place id.
  const audience = `aud:dm:${dmPlaceId('discord', 'u-alice')}`;
  assert.equal(audienceParts(audience)?.iface, null);
  assert.equal(audienceParts(audience, () => ({ iface: 'other' }))?.iface, 'other');
});

test('a DM row of an opaque person takes the audience of the stored DM place that names the person', () => {
  // Catches a writer that resolves a DM triple only through the person id's spelling, losing every meta-person's DM.
  const { handle, db } = placesDb([{ id: 'discord:dm:opaque', partner_person: 'person:0f3c-uuid' }]);
  try {
    const row = deriveRow(db, 'claims', claimOf(dmScope('person:0f3c-uuid', 'discord')));
    assert.equal(row.audience_id, 'aud:dm:discord:dm:opaque');
  } finally {
    handle.close();
  }
});

test('a DM row whose partner no stored DM place names is internal and creates no place', () => {
  // Catches a DM place and audience worked out from the person id's spelling.
  const { handle, db } = placesDb([]);
  try {
    const row = deriveRow(db, 'claims', claimOf(dmScope(ALICE, 'discord')));
    assert.equal(row.audience_id, AUD_INTERNAL);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM places').get()?.n, 0);
  } finally {
    handle.close();
  }
});

test('a DM row whose partner holds two stored DM places on the interface is internal', () => {
  // Catches picking one of several DMs of a person, which would show one chat's rows in another.
  const { handle, db } = placesDb([
    { id: dmPlaceId('discord', 'u-alice'), partner_person: ALICE },
    { id: 'discord:dm:second', partner_person: ALICE },
  ]);
  try {
    const row = deriveRow(db, 'claims', claimOf(dmScope(ALICE, 'discord')));
    assert.equal(row.audience_id, AUD_INTERNAL);
  } finally {
    handle.close();
  }
});

test('ensureAudience refuses a DM audience whose place no row holds', () => {
  // Catches a DM place created from the spelling of an audience id.
  const { handle, db } = placesDb([]);
  try {
    const audience = `aud:dm:${dmPlaceId('discord', 'u-alice')}`;
    assert.throws(() => ensureAudience(db, { ...dmScope(ALICE, 'discord'), audience_id: audience }), /no stored place/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM places').get()?.n, 0);
  } finally {
    handle.close();
  }
});

test('a stored DM place takes its native key from its partner account, not from its id', () => {
  // Catches the native key of a DM place worked out from the spelling of the place id.
  const { handle, db } = placesDb([
    { id: 'discord:dm:spelled', partner_person: null, partner_account: 'discord:acc-1' },
  ]);
  try {
    assert.equal(
      db.prepare('SELECT native_key FROM places WHERE id = ?').get('discord:dm:spelled')?.native_key,
      'dm:n-777'
    );
  } finally {
    handle.close();
  }
});
