// Tests for src/memory/db/scope.js and ids.js: scope columns of old scope objects, read contexts, the allowed matrix,
// the SQL filter (checked against the same matrix over a real table), narrowest, and the deterministic ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.js';
import {
  SCOPE_INTERNAL,
  SCOPE_NONE,
  allowed,
  dmContext,
  dmScope,
  groupContext,
  groupScope,
  internalContext,
  narrowest,
  scopeColumns,
  whereFor,
} from '../src/memory/db/scope.js';
import {
  accountId,
  answerSourceId,
  channelPlaceId,
  dmPlaceId,
  guildPlaceId,
  itemOrDerivedId,
  messageSourceId,
  nativeOf,
  otherSourceId,
  personId,
  shortHash,
  uniqueIds,
} from '../src/memory/db/ids.js';

const ALICE = personId('100000000000000001');
const BOB = personId('100000000000000002');

test('scope columns from an old scope object', () => {
  assert.deepEqual(scopeColumns({ channel: '200000000000000001' }), groupScope());
  assert.deepEqual(scopeColumns({ guild: true }), groupScope());
  assert.deepEqual(scopeColumns({}), SCOPE_INTERNAL, 'an unknown legacy scope is never shown outward');
  assert.deepEqual(scopeColumns(undefined), SCOPE_INTERNAL);
  assert.deepEqual(scopeColumns({ user: '100000000000000001' }), dmScope(ALICE));
});

test('a private layer of user U is a DM scope with U whatever the line names', () => {
  const opts = { privateUser: '100000000000000001' };
  assert.deepEqual(scopeColumns({ channel: '200000000000000009' }, opts), dmScope(ALICE));
  assert.deepEqual(scopeColumns({}, opts), dmScope(ALICE));
  assert.deepEqual(scopeColumns(undefined, opts), dmScope(ALICE));
});

const ROWS = {
  none: { scope_kind: 'none', scope_iface: null, scope_dm: null },
  group: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
  groupOther: { scope_kind: 'group', scope_iface: 'other', scope_dm: null },
  dmAlice: { scope_kind: 'dm', scope_iface: 'discord', scope_dm: ALICE },
  dmBob: { scope_kind: 'dm', scope_iface: 'discord', scope_dm: BOB },
  dmOtherIface: { scope_kind: 'dm', scope_iface: 'other', scope_dm: ALICE },
  internal: { scope_kind: 'internal', scope_iface: null, scope_dm: null },
};

const MATRIX = {
  group: {
    none: true,
    group: true,
    groupOther: false,
    dmAlice: false,
    dmBob: false,
    dmOtherIface: false,
    internal: false,
  },
  dmAlice: {
    none: true,
    group: true,
    groupOther: false,
    dmAlice: true,
    dmBob: false,
    dmOtherIface: false,
    internal: false,
  },
  dmBob: {
    none: true,
    group: true,
    groupOther: false,
    dmAlice: false,
    dmBob: true,
    dmOtherIface: false,
    internal: false,
  },
  internal: Object.fromEntries(Object.keys(ROWS).map((name) => [name, true])),
};

const CONTEXTS = {
  group: groupContext('discord'),
  dmAlice: dmContext(ALICE, 'discord'),
  dmBob: dmContext(BOB, 'discord'),
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
  const { db } = handle;
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
  assert.deepEqual(got, ['dmAlice', 'group', 'none']);
  handle.close();
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
  assert.deepEqual(narrowest([ROWS.none, ROWS.group]), groupScope());
  assert.deepEqual(narrowest([ROWS.group, ROWS.group]), groupScope());
  assert.deepEqual(narrowest([ROWS.group, ROWS.dmAlice]), dmScope(ALICE));
  assert.deepEqual(narrowest([ROWS.dmAlice, ROWS.group, ROWS.none]), dmScope(ALICE));
  assert.deepEqual(narrowest([ROWS.dmAlice, ROWS.dmAlice]), dmScope(ALICE));
  assert.equal(narrowest([ROWS.dmAlice, ROWS.dmBob]).scope_kind, 'internal');
  assert.equal(narrowest([ROWS.dmBob, ROWS.group, ROWS.dmAlice]).scope_kind, 'internal');
  assert.equal(narrowest([ROWS.group, ROWS.groupOther]).scope_kind, 'internal');
  assert.equal(narrowest([ROWS.dmAlice, ROWS.groupOther]).scope_kind, 'internal');
  assert.equal(narrowest([ROWS.none, ROWS.internal, ROWS.group]).scope_kind, 'internal');
});

test('an internal row derived from two DMs is never shown outward', () => {
  const derived = narrowest([ROWS.dmAlice, ROWS.dmBob]);
  for (const name of ['group', 'dmAlice', 'dmBob']) assert.equal(allowed(derived, CONTEXTS[name]), false);
  assert.equal(allowed(derived, CONTEXTS.internal), true);
});

test('ids are deterministic text', () => {
  assert.equal(personId('1'), 'person:discord:1');
  assert.equal(accountId('1'), 'discord:1');
  assert.equal(guildPlaceId('2'), 'discord:guild:2');
  assert.equal(channelPlaceId('3'), 'discord:channel:3');
  assert.equal(dmPlaceId('4'), 'discord:dm:4');
  assert.equal(messageSourceId('5', 2, 'seen'), 'src:discord:5:2:seen');
  assert.equal(answerSourceId('t-1', 0), 'src:turn:t-1:0');
  assert.equal(otherSourceId('felt', 'f-1'), 'src:felt:f-1');
  assert.equal(shortHash('a', 'b'), shortHash('a', 'b'));
  assert.notEqual(shortHash('a', 'b'), shortHash('ab'));
  assert.match(shortHash('x'), /^[0-9a-f]{16}$/);
});

test('nativeOf reads the native id back out of person, account and place ids', () => {
  assert.equal(nativeOf(personId('9')), '9');
  assert.equal(nativeOf(accountId('9')), '9');
  assert.equal(nativeOf(channelPlaceId('9')), '9');
  assert.equal(nativeOf(dmPlaceId('9')), '9');
  assert.equal(nativeOf(guildPlaceId('9')), '9');
  assert.equal(nativeOf('person:self'), null);
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
