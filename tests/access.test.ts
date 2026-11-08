// Tests for src/tools/operations/grants.ts: the pure owner-managed access decision (isAllowed, keyed by
// operation name), the expansion of a group or `*` grant at grant time, the one-time migration of
// the old command-key grants, the access list with each right's source, and the immutable
// grant/revoke helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAllowed,
  grant,
  revoke,
  hasGrant,
  isOwnerId,
  expandGrant,
  migrateGrants,
  describeGrants,
} from '../src/tools/operations/grants.ts';
import type { Access, GrantEntry, OpInfo, Rights } from '../src/tools/types.ts';
import { OWNER_PERSON, ownedBy } from './fixtures/owner-accounts.ts';

/** One operation descriptor as src/tools/operations/registry.ts#listOps gives it. */
function op(name: string, rights: Partial<Rights> = {}): OpInfo {
  return { name, rights: { kind: 'read', ...rights } };
}

// A small registry: grantable reads and writes, owner-only, non-grantable and member operations.
const OPS: Array<OpInfo> = [
  op('status.show'),
  op('config.set', { kind: 'write' }),
  op('rule.list'),
  op('rule.add', { kind: 'write' }),
  op('memory.profile.read'),
  op('memory.recent.read'),
  op('memory.affinity.read'),
  op('memory.affinity.set', { kind: 'write' }),
  op('memory.refresh', { kind: 'write' }),
  op('memory.journal.read', { ownerOnly: true }),
  op('memory.wipe', { kind: 'write', ownerOnly: true }),
  op('memory.private.read', { ownerOnly: true }),
  op('access.list', { ownerOnly: true }),
  op('bot.secret', { grantable: false }),
  op('pings.get', { member: true }),
  op('pings.set', { kind: 'write', member: true }),
];
const byName = (name: string) => OPS.find((o) => o.name === name);

/** The old command keys of the fixture registry: an exact key -> its op, a group -> its keys' ops. */
const OLD_KEYS: Record<string, string> = {
  status: 'status.show',
  set: 'config.set',
  'rule.list': 'rule.list',
  'rule.add': 'rule.add',
  'memory.show': 'memory.profile.read',
  'memory.recent': 'memory.recent.read',
  'memory.affinity': 'memory.affinity.read',
  'memory.refresh': 'memory.refresh',
  'memory.journal': 'memory.journal.read',
  'memory.wipe': 'memory.wipe',
  'private.show': 'memory.private.read',
  'access.list': 'access.list',
  pings: 'pings.get',
};
function legacy(key: string): { from: string | null; names: Array<string> } | null {
  if (key === '*') return { from: '*', names: OPS.map((o) => o.name) };
  if (Object.hasOwn(OLD_KEYS, key)) return { from: null, names: [OLD_KEYS[key]] };
  const under = Object.keys(OLD_KEYS).filter((k) => k.startsWith(`${key}.`));
  return under.length ? { from: key, names: [...new Set(under.map((k) => OLD_KEYS[k]))] } : null;
}

// The stored grant of `key`; every test that reads one has just written it through `grant`.
// The stored shape is Record<string, unknown> because config files are untrusted; the cast names the entry shape.
const entryAt = (access: Access, key: string): Pick<GrantEntry, 'roles' | 'via'> => access[key] as GrantEntry;

const everyone = () => ({ everyone: true, roles: [], users: [] });

/** isAllowed for user `accountId` (roles `roleIds`) on the fixture op `name`, owner `1`. */
function allowed(
  name: string,
  access: unknown,
  { accountId = '2', roleIds = [] }: { accountId?: string; roleIds?: Array<string> } = {}
): boolean {
  return isAllowed({ op: byName(name) ?? op(name), member: { accountId, roleIds }, access, owners: ['1'] });
}

// ---------------------------------------------------------------------------
// isOwnerId / hasGrant
// ---------------------------------------------------------------------------

test('isOwnerId: a bound account passes as a string or a number; no user and no owner person never do', () => {
  // The expectation changed with plan 2026-11-08-meta-person slice 8: the owner is `bot.ownerPerson` and the accounts
  // bound to it, and the retired `bot.owners` list passes nobody.
  const stop = ownedBy(['1', 2]);
  try {
    const config = { bot: { ownerPerson: OWNER_PERSON } };
    assert.equal(isOwnerId(config, '1'), true);
    assert.equal(isOwnerId(config, 2), true);
    assert.equal(isOwnerId(config, '3'), false);
    assert.equal(isOwnerId(config, undefined), false);
    assert.equal(isOwnerId({}, '1'), false);
    assert.equal(isOwnerId(undefined, '1'), false);
    assert.equal(isOwnerId({ bot: { owners: ['1'] } }, '1'), false);
  } finally {
    stop();
  }
});

test('hasGrant: true exactly when revoke with the same arguments would change something', () => {
  const access = { status: { everyone: true, roles: ['5'], users: [7] } };
  assert.equal(hasGrant(access, 'status', { everyone: true }), true);
  assert.equal(hasGrant(access, 'status', { roleId: 5 }), true);
  assert.equal(hasGrant(access, 'status', { accountId: '7' }), true);
  assert.equal(hasGrant(access, 'status', { roleId: '6' }), false);
  assert.equal(hasGrant(access, 'memory', { everyone: true }), false);
  assert.equal(hasGrant({ status: { roles: ['5'] } }, 'status', { everyone: true }), false);
  assert.equal(hasGrant(undefined, 'status', { everyone: true }), false);
});

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

// One row per case: `label` names it in a failure, `expected` is isAllowed's answer.
const IS_ALLOWED_CASES = [
  {
    label: 'an owner always passes, even with no access at all',
    name: 'memory.wipe',
    accountId: '1',
    access: undefined,
    expected: true,
  },
  { label: 'a non-owner with no matching grant is refused', name: 'memory.profile.read', access: {}, expected: false },
  {
    label: 'everyone: true on the exact op name lets a non-owner through',
    name: 'memory.profile.read',
    access: { 'memory.profile.read': everyone() },
    expected: true,
  },
  {
    label: 'a matching role id lets a non-owner through',
    name: 'status.show',
    roleIds: ['role-a'],
    access: { 'status.show': { everyone: false, roles: ['role-a'], users: [] } },
    expected: true,
  },
  {
    label: 'role id compared as a string (number vs numeric string)',
    name: 'status.show',
    roleIds: ['12345'],
    access: { 'status.show': { everyone: false, roles: [12345], users: [] } },
    expected: true,
  },
  {
    label: 'a non-matching role does not let a non-owner through',
    name: 'status.show',
    roleIds: ['role-b'],
    access: { 'status.show': { everyone: false, roles: ['role-a'], users: [] } },
    expected: false,
  },
  {
    label: 'a matching user id lets a non-owner through',
    name: 'status.show',
    access: { 'status.show': { everyone: false, roles: [], users: ['2'] } },
    expected: true,
  },
  {
    label: 'a grant stored under a group name opens nothing at check time (groups expand at grant time)',
    name: 'memory.profile.read',
    access: { memory: everyone() },
    expected: false,
  },
  {
    label: 'a grant stored under * opens nothing at check time (* expands at grant time)',
    name: 'memory.profile.read',
    access: { '*': everyone() },
    expected: false,
  },
  {
    label: 'only the exact op entry counts: a user listed under the group or * is not let through',
    name: 'memory.profile.read',
    access: {
      'memory.profile.read': { everyone: false, roles: [], users: [] },
      memory: { everyone: false, roles: [], users: ['2'] },
      '*': { everyone: false, roles: [], users: ['2'] },
    },
    expected: false,
  },
];

test('isAllowed: an owner always passes; a non-owner needs a user, role or everyone grant on the exact op name', () => {
  for (const { label, expected, name, access, accountId, roleIds } of IS_ALLOWED_CASES) {
    assert.equal(allowed(name, access, { accountId, roleIds }), expected, label);
  }
});

test('isAllowed: an invalid access shape (not an object) denies every non-owner', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    assert.equal(allowed('status.show', bad), false, `expected access=${JSON.stringify(bad)} to deny`);
  }
});

test('isAllowed: a malformed entry (not an object) on the op is skipped, not thrown on', () => {
  assert.equal(allowed('status.show', { 'status.show': 'not an object', '*': everyone() }), false);
  assert.equal(allowed('status.show', { 'status.show': null }), false);
});

test('isAllowed: no operation descriptor denies every non-owner; an owner still passes', () => {
  assert.equal(isAllowed({ op: null, member: { accountId: '2' }, access: { '*': everyone() }, owners: ['1'] }), false);
  assert.equal(isAllowed({ op: null, member: { accountId: '1' }, access: {}, owners: ['1'] }), true);
});

test('isAllowed: owner-only and non-grantable ops refuse a * grant', () => {
  const open = { everyone: true, roles: ['staff'], users: ['2'] };
  for (const name of ['memory.journal.read', 'memory.wipe', 'memory.private.read', 'access.list', 'bot.secret']) {
    const group = name.split('.')[0];
    const access = { '*': open, [group]: open, [name]: open };
    assert.equal(allowed(name, access, { roleIds: ['staff'] }), false, name);
    assert.equal(allowed(name, {}, { accountId: '1' }), true, `${name}: owner`);
  }
  // an exact grant on a grantable op still opens it
  assert.equal(allowed('rule.list', { 'rule.list': open }), true);
});

test('isAllowed: a member granted memory.affinity.read is denied memory.affinity.set', () => {
  const access = { 'memory.affinity.read': { everyone: false, roles: [], users: ['2'] } };
  assert.equal(allowed('memory.affinity.read', access), true);
  assert.equal(allowed('memory.affinity.set', access), false);
});

test('isAllowed: a member op passes for anyone, with no owners and no access at all', () => {
  assert.equal(isAllowed({ op: byName('pings.set'), member: { accountId: '2' } }), true);
  assert.equal(
    isAllowed({ op: byName('pings.get'), member: { accountId: '2', roleIds: [] }, owners: [], access: undefined }),
    true
  );
  // it opens nothing else
  assert.equal(allowed('status.show', {}), false);
});

// ---------------------------------------------------------------------------
// expandGrant / migrateGrants / describeGrants
// ---------------------------------------------------------------------------

test('expandGrant: an op name is itself; a group or * is the grantable read ops that exist now', () => {
  assert.deepEqual(expandGrant('memory.affinity.set', OPS), {
    from: null,
    names: ['memory.affinity.set'],
    refused: [],
  });
  assert.deepEqual(expandGrant('memory', OPS), {
    from: 'memory',
    names: ['memory.profile.read', 'memory.recent.read', 'memory.affinity.read'],
    refused: [],
  });
  assert.deepEqual(expandGrant('*', OPS)?.names, [
    'status.show',
    'rule.list',
    'memory.profile.read',
    'memory.recent.read',
    'memory.affinity.read',
  ]);
  assert.deepEqual(expandGrant('memory.wipe', OPS), { from: null, names: [], refused: ['memory.wipe'] });
  assert.deepEqual(expandGrant('pings.get', OPS), { from: null, names: [], refused: ['pings.get'] });
  assert.equal(expandGrant('nonsense', OPS), null);
  assert.equal(expandGrant('memor', OPS), null, 'a group is a whole dotted segment');
});

test('isAllowed: an old memory.* grant after migration covers only the read ops that existed, never a later one', () => {
  for (const key of ['memory', '*']) {
    const { access } = migrateGrants({
      access: { [key]: { everyone: false, roles: ['staff'], users: [] } },
      ops: OPS,
      legacy,
    });
    const asStaff = (name: string) => allowed(name, access, { roleIds: ['staff'] });
    for (const name of ['memory.profile.read', 'memory.recent.read', 'memory.affinity.read'])
      assert.equal(asStaff(name), true, `${key}: ${name}`);
    for (const name of [
      'memory.affinity.set',
      'memory.refresh',
      'memory.journal.read',
      'memory.wipe',
      'memory.private.read',
    ]) {
      assert.equal(asStaff(name), false, `${key}: ${name}`);
    }
    // an operation added after the migration is never covered by it
    assert.equal(
      isAllowed({ op: op('memory.mood.read'), member: { accountId: '2', roleIds: ['staff'] }, access, owners: ['1'] }),
      false,
      key
    );
    assert.equal(Object.hasOwn(access, key), false, `${key}: the pattern itself is not stored`);
  }
});

test('migrateGrants: expands group and * grants into op entries once and drops owner-only ops with a note', () => {
  const stored = {
    memory: { everyone: true, roles: [], users: [] },
    '*': { everyone: false, roles: ['staff'], users: [] },
    set: { everyone: false, roles: [], users: ['9'] },
    'memory.journal': { everyone: true, roles: [], users: [] },
    'private.show': { everyone: false, roles: ['staff'], users: [] },
    ping: { everyone: true, roles: [], users: [] },
  };
  const { access, report, note } = migrateGrants({ access: stored, ops: OPS, legacy });

  assert.deepEqual(access['memory.profile.read'], {
    everyone: true,
    roles: ['staff'],
    users: [],
    via: { everyone: 'memory', 'role:staff': '*' },
  });
  assert.deepEqual(access['status.show'], { everyone: false, roles: ['staff'], users: [], via: { 'role:staff': '*' } });
  assert.deepEqual(
    access['config.set'],
    { everyone: false, roles: [], users: ['9'] },
    'an exact old key keeps its write'
  );
  for (const key of [
    'memory',
    '*',
    'set',
    'memory.journal',
    'private.show',
    'ping',
    'memory.journal.read',
    'memory.private.read',
    'memory.refresh',
  ]) {
    assert.equal(Object.hasOwn(access, key), false, key);
  }

  const line = (key: string) => report.find((r) => r.key === key);
  assert.deepEqual(line('memory')?.covers, ['memory.profile.read', 'memory.recent.read', 'memory.affinity.read']);
  assert.deepEqual(line('memory.journal')?.dropped, ['memory.journal.read']);
  assert.deepEqual(line('private.show')?.dropped, ['memory.private.read']);
  assert.deepEqual(line('ping')?.dropped, ['ping']);
  assert.match(note, /memory -> memory\.profile\.read, memory\.recent\.read, memory\.affinity\.read/);
  assert.match(note, /memory\.journal -> nothing; dropped \(owner-only\): memory\.journal\.read/);

  // once: migrating the migrated grants again changes nothing
  assert.deepEqual(migrateGrants({ access, ops: OPS, legacy }).access, access);
});

test('access list: names the source of each right', () => {
  let access = grant({}, 'memory.profile.read', { everyone: true }, { from: 'memory' });
  access = grant(access, 'memory.profile.read', { roleId: 'r1' });
  access = grant(access, 'memory.profile.read', { accountId: 'u1' }, { from: '*' });
  access = grant(access, 'memory.journal.read', { everyone: true });
  access = grant(access, 'gone.op', { everyone: true });
  assert.deepEqual(describeGrants(access, OPS), [
    'memory.profile.read: everyone (expanded from memory, reads only), role id:r1, user id:u1 (expanded from *, reads only)',
  ]);
  // a direct grant of the same target replaces the expanded source
  access = grant(access, 'memory.profile.read', { everyone: true });
  assert.match(
    describeGrants(access, OPS)[0],
    /^memory\.profile\.read: everyone, role id:r1, user id:u1 \(expanded from \*/
  );
  // revoke drops the source with the target
  access = revoke(access, 'memory.profile.read', { accountId: 'u1' });
  assert.equal(entryAt(access, 'memory.profile.read').via, undefined);
});

// ---------------------------------------------------------------------------
// grant / revoke
// ---------------------------------------------------------------------------

const GRANT_FRESH_CASES = [
  {
    label: 'everyone on a fresh key creates the entry',
    what: { everyone: true },
    expected: { status: { everyone: true, roles: [], users: [] } },
  },
  {
    label: 'a role on a fresh key creates the entry with that role',
    what: { roleId: 'r1' },
    expected: { status: { everyone: false, roles: ['r1'], users: [] } },
  },
  {
    label: 'a user on a fresh key creates the entry with that user',
    what: { accountId: 'u1' },
    expected: { status: { everyone: false, roles: [], users: ['u1'] } },
  },
];

test('grant: everyone, a role or a user on a fresh key creates the entry with just that', () => {
  for (const { label, what, expected } of GRANT_FRESH_CASES) {
    assert.deepEqual(grant({}, 'status', what), expected, label);
  }
});

test('grant: adding a role already present is a no-op, not a duplicate', () => {
  const access = { status: { everyone: false, roles: ['r1'], users: [] } };
  const result = grant(access, 'status', { roleId: 'r1' });
  assert.deepEqual(entryAt(result, 'status').roles, ['r1']);
});

test('grant: a numeric role/user id is stored as a string', () => {
  const result = grant({}, 'status', { roleId: 12345 });
  assert.deepEqual(entryAt(result, 'status').roles, ['12345']);
});

test('grant: does not mutate its input', () => {
  const access = { status: { everyone: false, roles: [], users: [] } };
  const snapshot = JSON.parse(JSON.stringify(access));
  grant(access, 'status', { everyone: true });
  assert.deepEqual(access, snapshot);
});

test('grant: leaves other keys untouched', () => {
  const access = { ping: { everyone: true, roles: [], users: [] } };
  const result = grant(access, 'status', { everyone: true });
  assert.deepEqual(result.ping, { everyone: true, roles: [], users: [] });
  assert.deepEqual(result.status, { everyone: true, roles: [], users: [] });
});

// `expected` is the whole entry left behind: the one thing named is gone, the rest of the entry stays.
// The first three rows leave only one kind set (roles, roles, users), so an emptiness check that ignores that
// kind deletes the entry and fails. The next three hold the other two kinds as well, so a revoke that wipes a
// neighbouring list fails. The last leaves only the flag, for an emptiness check that ignores `everyone`.
const REVOKE_ONE_CASES = [
  {
    label: 'everyone clears the flag but keeps the rest of the entry',
    entry: { everyone: true, roles: ['r1'], users: [] },
    what: { everyone: true },
    expected: { everyone: false, roles: ['r1'], users: [] },
  },
  {
    label: 'a role removes just that role',
    entry: { everyone: false, roles: ['r1', 'r2'], users: [] },
    what: { roleId: 'r1' },
    expected: { everyone: false, roles: ['r2'], users: [] },
  },
  {
    label: 'a user removes just that user',
    entry: { everyone: false, roles: [], users: ['u1', 'u2'] },
    what: { accountId: 'u1' },
    expected: { everyone: false, roles: [], users: ['u2'] },
  },
  {
    label: 'everyone clears the flag but keeps the roles and users',
    entry: { everyone: true, roles: ['r1'], users: ['u9'] },
    what: { everyone: true },
    expected: { everyone: false, roles: ['r1'], users: ['u9'] },
  },
  {
    label: 'a role removes just that role, keeping the flag and the users',
    entry: { everyone: true, roles: ['r1', 'r2'], users: ['u9'] },
    what: { roleId: 'r1' },
    expected: { everyone: true, roles: ['r2'], users: ['u9'] },
  },
  {
    label: 'a user removes just that user, keeping the flag and the roles',
    entry: { everyone: true, roles: ['r9'], users: ['u1', 'u2'] },
    what: { accountId: 'u1' },
    expected: { everyone: true, roles: ['r9'], users: ['u2'] },
  },
  {
    label: 'the last role goes but the everyone flag still holds the entry',
    entry: { everyone: true, roles: ['r1'], users: [] },
    what: { roleId: 'r1' },
    expected: { everyone: true, roles: [], users: [] },
  },
];

test('revoke: everyone, a role or a user removes just that one thing from the entry', () => {
  for (const { label, entry, what, expected } of REVOKE_ONE_CASES) {
    assert.deepEqual(revoke({ status: entry }, 'status', what).status, expected, label);
  }
});

test('revoke: the last thing in an entry deletes the whole entry', () => {
  const access = { status: { everyone: false, roles: ['r1'], users: [] } };
  const result = revoke(access, 'status', { roleId: 'r1' });
  assert.deepEqual(result, {});
});

test('revoke: revoking from a key with no entry at all is a no-op', () => {
  const access = { ping: { everyone: true, roles: [], users: [] } };
  const result = revoke(access, 'status', { everyone: true });
  assert.deepEqual(result, access);
});

test('revoke: revoking something not present leaves the entry as-is', () => {
  const access = { status: { everyone: false, roles: ['r1'], users: [] } };
  const result = revoke(access, 'status', { roleId: 'nope' });
  assert.deepEqual(entryAt(result, 'status').roles, ['r1']);
});

test('revoke: does not mutate its input', () => {
  const access = { status: { everyone: true, roles: [], users: [] } };
  const snapshot = JSON.parse(JSON.stringify(access));
  revoke(access, 'status', { everyone: true });
  assert.deepEqual(access, snapshot);
});
