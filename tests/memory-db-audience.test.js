// Audiences (schema v7, src/memory/db/scope.ts): the one resolver from the scope triple to `audience_id` and back, the
// audience twins of the read rule (`allowedAudience`, `audienceWhere`), the full meet table of `narrowestAudience`,
// and the equivalence test: on fixtures with group, DM, two DMs of one person (one per interface), none, internal and
// malformed rows, every reader returns the same rows whether it reads the triple or `audience_id`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.js';
import { insertRows } from '../src/memory/db/rows.js';
import { SCOPED_TABLES } from '../src/memory/db/schema.js';
import {
  AUD_INTERNAL,
  AUD_NONE,
  SCOPE_INTERNAL,
  SCOPE_NONE,
  allowed,
  allowedAudience,
  audienceOf,
  audienceWhere,
  canRead,
  dmContext,
  dmScope,
  groupContext,
  groupScope,
  internalContext,
  issueContext,
  narrowest,
  narrowestAudience,
  scopeOfAudience,
  scopeWhere,
  whereFor,
} from '../src/memory/db/scope.ts';
import { channelPlaceId, dmPlaceId, messageSourceId, personId } from '../src/memory/db/ids.ts';
import { search, window } from '../src/memory/db/recall.js';
import { fillStems } from '../src/memory/db/stems.js';
import { batchOf, buildSessionRequest, scopesOf } from '../src/memory/db/session.js';
import { gatherReview } from '../src/memory/db/describe.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ALICE = personId('discord', 'u-alice');
const BOB = personId('discord', 'u-bob');
/** The same human's DM on a second interface: a person id of that interface. */
const ALICE_OTHER = 'person:other:u-alice';

const SCOPES = {
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
  dmAlice: dmContext(ALICE, 'discord'),
  dmBob: dmContext(BOB, 'discord'),
  dmAliceOther: dmContext(ALICE_OTHER, 'other'),
  internal: internalContext(),
};
const viaAudience = (ctx) => ({ ...ctx, audienceColumn: true });

test('audienceOf: each kind of triple, the DM place of the partner, malformed is internal', () => {
  assert.deepEqual(audienceOf(SCOPES.none), { ...SCOPE_NONE, audience_id: AUD_NONE });
  assert.equal(audienceOf(SCOPES.internal).audience_id, AUD_INTERNAL);
  assert.equal(audienceOf(SCOPES.group).audience_id, 'aud:group:discord');
  assert.equal(audienceOf(SCOPES.groupOther).audience_id, 'aud:group:other');
  assert.deepEqual(audienceOf(SCOPES.dmAlice), {
    ...SCOPES.dmAlice,
    audience_id: `aud:dm:${dmPlaceId('discord', 'u-alice')}`,
  });
  assert.equal(audienceOf(SCOPES.dmAliceOther).audience_id, 'aud:dm:other:dm:u-alice');
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
    audienceOf(SCOPES.dmAlice, { dmPlace: 'discord:dm:conversation-2' }).audience_id,
    'aud:dm:discord:dm:conversation-2',
    'a writer that knows the DM place names it'
  );
  assert.equal(
    audienceOf(dmScope('person:0f3c-uuid', 'discord')).audience_id,
    AUD_INTERNAL,
    'a new person id has no DM place of its own spelling'
  );
  assert.equal(
    audienceOf(dmScope('person:0f3c-uuid', 'discord'), { dmPlace: 'discord:dm:p' }).audience_id,
    'aud:dm:discord:dm:p'
  );
});

test('scopeOfAudience: the triple back from an audience id', () => {
  for (const name of ['none', 'internal', 'group', 'groupOther', 'dmAlice', 'dmBob', 'dmAliceOther']) {
    assert.deepEqual(scopeOfAudience(audienceOf(SCOPES[name]).audience_id), SCOPES[name], name);
  }
  assert.deepEqual(
    scopeOfAudience('aud:dm:discord:dm:p', () => ({ iface: 'discord', partner_person: 'person:0f3c-uuid' })),
    dmScope('person:0f3c-uuid', 'discord'),
    'the place row names the partner'
  );
  assert.deepEqual(scopeOfAudience('aud:whatever'), SCOPE_INTERNAL);
});

test('allowedAudience and audienceWhere give exactly what allowed and whereFor give, for every context and row', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  db.exec('CREATE TABLE probe (name TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, audience_id TEXT)');
  const rows = Object.fromEntries(Object.entries(SCOPES).map(([name, scope]) => [name, audienceOf(scope)]));
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
      const read = (where) =>
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
    [[G, GO], I],
    [[DA, GO], I],
    [[G, DO], I],
    [[DA, DO], I],
    [[N, G, DA, N], DA],
    [[DB, G, DA], I],
    [['aud:unknown', G], I],
  ];
  for (const [input, want] of table) assert.equal(narrowestAudience(input), want, JSON.stringify(input));
  // The same meet as the triple's narrowest, over every pair of well-formed scopes.
  const names = ['none', 'internal', 'group', 'groupOther', 'dmAlice', 'dmBob', 'dmAliceOther'];
  for (const a of names) {
    for (const b of names) {
      const viaTriple = audienceOf(narrowest([SCOPES[a], SCOPES[b]])).audience_id;
      assert.equal(
        narrowestAudience([audienceOf(SCOPES[a]).audience_id, audienceOf(SCOPES[b]).audience_id]),
        viaTriple,
        `${a} with ${b}`
      );
    }
  }
});

test('issueContext: an id, the mode, the DM place of the partner; contexts stay valid read contexts', () => {
  let n = 0;
  const newId = () => `ctx:test-${(n += 1)}`;
  const dm = issueContext({ kind: 'dm', person: ALICE, now: () => NOW, newId });
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
  const group = issueContext({
    kind: 'group',
    destination: channelPlaceId('discord', 'c1'),
    now: () => NOW,
    newId,
    audienceColumn: true,
  });
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
  const { db } = handle;
  const rows = {
    people: [],
    accounts: [],
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
  let at = NOW - 3 * 3600_000;
  const placeOf = (name) =>
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
  fillStems(db);
  return { handle, db, done: () => handle.close() };
}

test('equivalence: every scoped table returns the same ids under the triple and under audience_id', () => {
  const env = equivalenceFixture();
  try {
    for (const table of SCOPED_TABLES) {
      const key = table === 'vectors' ? 'chunk_key' : 'rowid';
      for (const [ctxName, ctx] of Object.entries(CONTEXTS)) {
        const read = (where) =>
          env.db
            .prepare(`SELECT t.${key} AS k FROM "${table}" t WHERE ${where.sql} ORDER BY 1`)
            .all(...where.params)
            .map((row) => row.k);
        assert.deepEqual(read(audienceWhere(ctx, 't')), read(whereFor(ctx, 't')), `${table} in ${ctxName}`);
      }
      assert.equal(
        env.db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE audience_id IS NULL`).get().n,
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
        db: env.db,
        scope: triple[i],
        batch: a,
        config,
        prompts,
        selfName: 'Ada',
        now: NOW,
      });
      const rb = buildSessionRequest({
        db: env.db,
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
      const a = gatherReview(env.db, { kind: 'person', id: ALICE }, 'character', { config, readCtx });
      const b = gatherReview(env.db, { kind: 'person', id: ALICE }, 'character', {
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
