// Tests for src/memory/db/scope.ts and ids.js: scope columns of old scope objects, read contexts, the allowed matrix,
// the SQL filter (checked against the same matrix over a real table), narrowest, and the deterministic ids.
import { legacyServerPlaceId } from '../src/memory/migration/paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import {
  SCOPE_INTERNAL,
  SCOPE_NONE,
  allowed,
  allowedAudience,
  canRead,
  dmAudienceId,
  dmContext,
  dmScope,
  groupContext,
  groupScope,
  groupsContext,
  internalContext,
  isIssuedInternalContext,
  issueContext,
  narrowest,
  scopeColumns,
  whereFor,
  type Context,
} from '../src/memory/db/scope.ts';
import {
  accountId,
  answerSourceId,
  channelPlaceId,
  dmPlaceId,
  itemOrDerivedId,
  messageSourceId,
  otherSourceId,
  shortHash,
  uniqueIds,
} from '../src/memory/db/ids.ts';
import { personId } from './fixtures/memory-db/spelled-ids.ts';

const ALICE = personId('discord', '100000000000000001');
const BOB = personId('discord', '100000000000000002');

test('scope columns from an old scope object', () => {
  assert.deepEqual(scopeColumns({ channel: '200000000000000001' }), groupScope('discord'));
  assert.deepEqual(scopeColumns({ place: 'discord:guild:1' }), groupScope('discord'));
  assert.deepEqual(scopeColumns({}), SCOPE_INTERNAL, 'an unknown legacy scope is never shown outward');
  assert.deepEqual(scopeColumns(undefined), SCOPE_INTERNAL);
  // A member's DM is the stored one its reader gives; with no reader nothing is stored and the scope is internal.
  assert.deepEqual(scopeColumns({ user: '100000000000000001' }), SCOPE_INTERNAL);
  const dmOf = (id: string) => (id === '100000000000000001' ? dmScope(ALICE, 'discord') : null);
  assert.deepEqual(scopeColumns({ user: '100000000000000001' }, { dmOf }), dmScope(ALICE, 'discord'));
});

test('a private layer of user U is a DM scope with U whatever the line names', () => {
  // The member's DM comes from the stored-DM reader, never from a person id spelled out of the member's id.
  const dmOf = (id: string) => (id === '100000000000000001' ? dmScope(ALICE, 'discord') : null);
  const opts = { privateUser: '100000000000000001', dmOf };
  assert.deepEqual(scopeColumns({ channel: '200000000000000009' }, opts), dmScope(ALICE, 'discord'));
  assert.deepEqual(scopeColumns({}, opts), dmScope(ALICE, 'discord'));
  assert.deepEqual(scopeColumns(undefined, opts), dmScope(ALICE, 'discord'));
});

const ROWS: Record<string, Record<string, string | null>> = {
  none: { scope_kind: 'none', scope_iface: null, scope_dm: null },
  group: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
  groupOther: { scope_kind: 'group', scope_iface: 'other', scope_dm: null },
  dmAlice: { scope_kind: 'dm', scope_iface: 'discord', scope_dm: ALICE },
  dmBob: { scope_kind: 'dm', scope_iface: 'discord', scope_dm: BOB },
  dmOtherIface: { scope_kind: 'dm', scope_iface: 'other', scope_dm: ALICE },
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

const CONTEXTS: Record<string, Context> = {
  group: groupContext('discord'),
  dmAlice: dmContext(ALICE, 'discord', dmPlaceId('discord', '100000000000000001')),
  dmBob: dmContext(BOB, 'discord', dmPlaceId('discord', '100000000000000002')),
  internal: internalContext(),
};

test('allowed: the matrix of contexts and row scopes', () => {
  for (const [ctxName, expected] of Object.entries(MATRIX)) {
    for (const [rowName, want] of Object.entries(expected)) {
      assert.equal(allowed(ROWS[rowName], CONTEXTS[ctxName]), want, `${ctxName} reading ${rowName}`);
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
  for (const [ctxName, ctx] of Object.entries(CONTEXTS)) {
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
  const aliased = whereFor(CONTEXTS.dmAlice, 'p');
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
    { kind: 'dm', person: ALICE },
    { internal: false },
    'group',
  ]) {
    assert.throws(() => allowed(ROWS.none, bad), /scope context/, JSON.stringify(bad));
    assert.throws(() => whereFor(bad), /scope context/, JSON.stringify(bad));
  }
});

test('a row with an unknown scope kind is shown to nobody but the internal context', () => {
  const odd = { scope_kind: 'whatever', scope_iface: 'discord', scope_dm: null };
  assert.equal(allowed(odd, CONTEXTS.group), false);
  assert.equal(allowed(odd, CONTEXTS.dmAlice), false);
  assert.equal(allowed(odd, CONTEXTS.internal), true);
});

test('narrowest: none yields to anything, a DM beats a group, two DMs are internal', () => {
  assert.deepEqual(narrowest([]), SCOPE_NONE);
  assert.deepEqual(narrowest([ROWS.none, ROWS.none]), SCOPE_NONE);
  assert.deepEqual(narrowest([ROWS.none, ROWS.group]), groupScope('discord'));
  assert.deepEqual(narrowest([ROWS.group, ROWS.group]), groupScope('discord'));
  assert.deepEqual(narrowest([ROWS.group, ROWS.dmAlice]), dmScope(ALICE, 'discord'));
  assert.deepEqual(narrowest([ROWS.dmAlice, ROWS.group, ROWS.none]), dmScope(ALICE, 'discord'));
  assert.deepEqual(narrowest([ROWS.dmAlice, ROWS.dmAlice]), dmScope(ALICE, 'discord'));
  assert.equal(narrowest([ROWS.dmAlice, ROWS.dmBob]).scope_kind, 'internal');
  assert.equal(narrowest([ROWS.dmBob, ROWS.group, ROWS.dmAlice]).scope_kind, 'internal');
  // Policy 2 intersects eligibility, so an interface change does not make group evidence internal.
  assert.deepEqual(narrowest([ROWS.group, ROWS.groupOther]), groupScope('discord'));
  assert.deepEqual(narrowest([ROWS.dmAlice, ROWS.groupOther]), dmScope(ALICE, 'discord'));
  assert.equal(narrowest([ROWS.none, ROWS.internal, ROWS.group]).scope_kind, 'internal');
});

test('an internal row derived from two DMs is never shown outward', () => {
  const derived = narrowest([ROWS.dmAlice, ROWS.dmBob]);
  for (const name of ['group', 'dmAlice', 'dmBob']) assert.equal(allowed(derived, CONTEXTS[name]), false);
  assert.equal(allowed(derived, CONTEXTS.internal), true);
});

test('ids are deterministic text', () => {
  assert.equal(personId('discord', '1'), 'person:discord:1');
  assert.equal(accountId('discord', '1'), 'discord:1');
  assert.equal(legacyServerPlaceId('discord', '2'), 'discord:guild:2');
  assert.equal(channelPlaceId('discord', '3'), 'discord:channel:3');
  assert.equal(dmPlaceId('discord', '4'), 'discord:dm:4');
  assert.equal(messageSourceId('discord', '5', 2, 'seen'), 'src:discord:5:2:seen');
  assert.equal(answerSourceId('t-1', 0), 'src:turn:t-1:0');
  assert.equal(otherSourceId('felt', 'f-1'), 'src:felt:f-1');
  assert.equal(shortHash('a', 'b'), shortHash('a', 'b'));
  assert.notEqual(shortHash('a', 'b'), shortHash('ab'));
  assert.match(shortHash('x'), /^[0-9a-f]{16}$/);
});

test('a claim id is the old itemId when there was one, else kind, owner and a hash of the stable fields', () => {
  assert.equal(itemOrDerivedId('ep-1', 'detail', ALICE, 'x'), 'ep-1');
  const derived = itemOrDerivedId(undefined, 'detail', ALICE, 7);
  assert.equal(derived, `detail:${ALICE}:${shortHash(7)}`);
  assert.equal(itemOrDerivedId('', 'detail', ALICE, 7), derived);
  assert.equal(itemOrDerivedId(undefined, 'detail', ALICE, 7), derived);
});

test('uniqueIds keeps the first and suffixes a repeat', () => {
  const uniq = uniqueIds();
  assert.deepEqual(['a', 'b', 'a', 'a', 'b'].map(uniq), ['a', 'b', 'a-2', 'a-3', 'b-2']);
});

test('cross-interface group provenance has the same visibility in either evidence order', () => {
  // Catches a representative interface accidentally narrowing a derived group's readership.
  const forward = narrowest([groupScope('discord'), groupScope('future-interface')]);
  const reverse = narrowest([groupScope('future-interface'), groupScope('discord')]);
  assert.deepEqual(forward, groupScope('discord'));
  assert.deepEqual(reverse, groupScope('future-interface'));
  for (const ctx of [
    groupContext('third-interface'),
    dmContext(ALICE, 'discord', dmPlaceId('discord', '100000000000000001')),
  ]) {
    assert.equal(allowed(forward, ctx), true);
    assert.equal(allowed(reverse, ctx), true);
  }
  for (const evidence of [
    [groupScope('future-interface'), dmScope(ALICE, 'discord')],
    [dmScope(ALICE, 'discord'), groupScope('future-interface')],
  ])
    assert.deepEqual(narrowest(evidence), dmScope(ALICE, 'discord'));
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
      dmContext(ALICE, 'discord', dmPlaceId('discord', '100000000000000001')),
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
      dmContext(ALICE, 'discord', dmPlaceId('discord', '100000000000000001')),
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
    for (const iface of ['\0', 'future\0interface']) {
      assert.deepEqual(narrowest([groupScope(iface), groupScope('discord')]), SCOPE_INTERNAL);
    }
    assert.deepEqual(narrowest([groupScope('future-%00'), groupScope('discord')]), groupScope('future-%00'));
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

test('a DM context reads no DM its partner id spells when the caller names no place', () => {
  // Bug: the context works the place out of the person id, so a DM nobody stored opens by spelling alone.
  const ctx = { ...dmContext(ALICE, 'discord', null), audienceColumn: true };
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
