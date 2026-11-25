// Tests for src/tools/operations/grants.ts: the owner check, and the immutable grant and revoke of one stored
// grant of the persona's, keyed by operation name. Only the owner types commands, so a stored grant names the
// persona's user id alone, and a stored grant to everyone, a role or a member opens nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grant,
  revoke,
  hasGrant,
  isOwnerId,
  isOwnerCaller,
  useOwnerAccounts,
} from '../../../../src/tools/operations/grants.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withIface } from '../../../../src/memory/db/current-iface.ts';
import { mention, query, spawnCli, startUnitsCore, startedUnit, until, withRig } from '../../../fixtures/core-units.ts';
import type { Dirs, Rig } from '../../../fixtures/core-units.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { createOwnerAccounts } from '../../../../src/memory/db/person-links.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

const SELF = 'self-1';

test('isOwnerId: a bound account passes as a string or a number; no user and no owner person never do', () => {
  // The owner is `bot.ownerPerson` and the accounts bound to it, and a `bot.owners` list passes nobody.
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

test('hasGrant: true exactly when the entry lists the user id, compared as a string', () => {
  const access = { 'memory.search': { users: [7, SELF] } };
  assert.equal(hasGrant(access, 'memory.search', { accountId: '7' }), true);
  assert.equal(hasGrant(access, 'memory.search', { accountId: SELF }), true);
  assert.equal(hasGrant(access, 'memory.search', { accountId: '8' }), false);
  assert.equal(hasGrant(access, 'memory.read', { accountId: SELF }), false);
  assert.equal(hasGrant(undefined, 'memory.search', { accountId: SELF }), false);
});

test("hasGrant: a stored everyone or role is no grant of the persona's", () => {
  // A grant to everyone or a role opens something for members, and the persona is no member.
  const access = { 'memory.search': { everyone: true, roles: ['r1'], users: [] } };
  assert.equal(hasGrant(access, 'memory.search', { accountId: SELF }), false);
});

test("grant: the persona's id on a fresh key stores the users list alone", () => {
  assert.deepEqual(grant({}, 'memory.search', { accountId: SELF }), { 'memory.search': { users: [SELF] } });
});

test('grant: a numeric id is stored as a string', () => {
  assert.deepEqual(grant({}, 'memory.search', { accountId: 12345 }), { 'memory.search': { users: ['12345'] } });
});

test('grant: granting the same id twice stores it once', () => {
  const once = grant({}, 'memory.search', { accountId: SELF });
  assert.deepEqual(grant(once, 'memory.search', { accountId: SELF }), { 'memory.search': { users: [SELF] } });
});

test('grant: a grant from a group or * keeps its source, and a direct grant of the same id drops it', () => {
  const expanded = grant({}, 'lore.list', { accountId: SELF }, { from: '*' });
  assert.deepEqual(expanded, { 'lore.list': { users: [SELF], via: { [`user:${SELF}`]: '*' } } });
  assert.deepEqual(grant(expanded, 'lore.list', { accountId: SELF }), { 'lore.list': { users: [SELF] } });
});

test('grant: a stored entry that still holds everyone or roles loses them when it is written', () => {
  // No grant opens anything to everyone or a role, so no write keeps those fields.
  const access = { 'memory.profile.read': { everyone: true, roles: ['r1'], users: [] } };
  assert.deepEqual(grant(access, 'memory.profile.read', { accountId: SELF }), {
    'memory.profile.read': { users: [SELF] },
  });
});

test('grant: does not mutate its input and leaves other keys untouched', () => {
  const access = { 'lore.list': { users: [SELF] } };
  const snapshot = structuredClone(access);
  const result = grant(access, 'memory.search', { accountId: SELF });
  assert.deepEqual(access, snapshot);
  assert.deepEqual(result['lore.list'], { users: [SELF] });
});

test('revoke: removes just that id from the entry', () => {
  const access = { 'memory.search': { users: ['u1', SELF] } };
  assert.deepEqual(revoke(access, 'memory.search', { accountId: SELF }), { 'memory.search': { users: ['u1'] } });
});

test('revoke: the last id deletes the whole entry, even one that still holds everyone or roles', () => {
  // A stored everyone or role opens nothing, so it keeps no entry alive.
  const access = { 'memory.profile.read': { everyone: true, roles: ['r1'], users: [SELF] } };
  assert.deepEqual(revoke(access, 'memory.profile.read', { accountId: SELF }), {});
});

test('revoke: the source of a grant from a group goes with the id', () => {
  const access = grant({}, 'lore.list', { accountId: SELF }, { from: 'lore' });
  const both = grant(access, 'lore.list', { accountId: 'u1' });
  assert.deepEqual(revoke(both, 'lore.list', { accountId: SELF }), { 'lore.list': { users: ['u1'] } });
});

test('revoke: a key with no entry, or an id not listed, changes nothing', () => {
  const access = { 'lore.list': { users: [SELF] } };
  assert.deepEqual(revoke(access, 'memory.search', { accountId: SELF }), access);
  assert.deepEqual(revoke(access, 'lore.list', { accountId: 'nope' }), access);
});

test('revoke: does not mutate its input', () => {
  const access = { 'memory.search': { users: [SELF] } };
  const snapshot = structuredClone(access);
  revoke(access, 'memory.search', { accountId: SELF });
  assert.deepEqual(access, snapshot);
});

// On a raw install the first line of the owner's command line writes `bot.ownerPerson`, and the command line's account
// is the owner's first account. The retired `bot.owners` binds nobody and gives nobody the owner rights: another
// account becomes the owner's only by `/memory bind`. A stranger's direct message is a line like any other, never
// answered with a pairing phrase. The real core and the real `neptunia` command over fresh folders; synthetic ids only.

const configOf = (dirs: Dirs): { bot: { ownerPerson?: string } } =>
  JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
    bot: { ownerPerson?: string };
  };

const personOf = (dirs: Dirs, iface: string, native: string): unknown =>
  query(dirs, 'SELECT person_id FROM accounts WHERE iface = ? AND native_key = ?', iface, native)[0]?.person_id;

const ownerOn = (iface: string, native: string, config: object): boolean =>
  withIface(iface, () => isOwnerId(config, native));

async function firstLine({ dirs, clis }: Pick<Rig, 'dirs' | 'clis'>): Promise<void> {
  const chat = spawnCli(dirs, []);
  clis.push(chat);
  chat.type('the first line of a new install');
  await until(
    () => query(dirs, "SELECT 1 FROM sources WHERE iface = 'cli' AND kind = 'seen'").length > 0,
    () => chat.stderr()
  );
  await until(() => typeof configOf(dirs).bot.ownerPerson === 'string', 'bot.ownerPerson written');
}

test('an account listed in bot.owners stays a stranger once the first line names the owner person', async () => {
  // Bug: the retired list of native ids still binds its accounts to the owner and hands them the owner's rights.
  // The expectation changed with plan 2026-11-08-meta-person slice 8: the owner's other accounts come by `/memory bind`,
  // never from `bot.owners`. Pairing, the other way it named, is gone.
  await withRig({ config: { bot: { owners: ['u1'] } } }, async ({ dirs, llm, units, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await unit.emit(mention('m1', 'hello'));
    await until(() => personOf(dirs, 'fake', 'u1') !== undefined, 'the first sight of u1');
    await firstLine({ dirs, clis });
    const owner = configOf(dirs).bot.ownerPerson;
    assert.equal(personOf(dirs, 'cli', 'owner'), owner);
    assert.notEqual(personOf(dirs, 'fake', 'u1'), owner);
    assert.equal(ownerOn('fake', 'u1', configOf(dirs)), false);
    assert.equal(ownerOn('cli', 'owner', configOf(dirs)), true);
  });
});

// The owner's rights come from the person: src/tools/operations/grants.ts#isOwnerId asks the accounts the owner bound
// (src/memory/db/person-links.ts#createOwnerAccounts); `bot.owners` decides nothing.

type Handle = ReturnType<typeof openMemoryDb>;

const OWNER_PERSON_OWNER_PERSON = 'person:discord:111';

function withAccounts(body: (handle: Handle) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-owner-'), 'memory.db'));
  const insert = dbOf(handle).prepare(
    "INSERT INTO accounts (id, iface, native_id, native_key, person_id, kind) VALUES (?, ?, ?, ?, ?, 'user')"
  );
  for (const [iface, native] of [
    ['discord', '111'],
    ['discord', '222'],
    ['telegram', '111'],
    ['telegram', '555'],
  ] as const) {
    dbOf(handle).prepare('INSERT OR IGNORE INTO people (id) VALUES (?)').run(`person:${iface}:${native}`);
    insert.run(`${iface}:${native}`, iface, native, native, `person:${iface}:${native}`);
  }
  const stop = useOwnerAccounts(createOwnerAccounts({ database: () => dbOf(handle), home: () => 'discord' }));
  try {
    body(handle);
  } finally {
    stop();
    handle.close();
  }
}

function link(handle: Handle, op: 'bind' | 'unbind', iface: string, native: string, target: object = {}): unknown {
  return applyMemoryWrite(handle, { kind: 'person-link', op, accountId: `${iface}:${native}`, target, now: 1000 });
}

const ownerPersonOwnerOn = (iface: string, native: string, config: object): boolean =>
  withIface(iface, () => isOwnerId(config, native));

test('an equal native id on a second interface has no owner rights once the owner person is bound', () => {
  // Bug: the bare string comparison hands the owner's rights to whoever holds the same number on another platform.
  withAccounts((handle) => {
    link(handle, 'bind', 'discord', '111', { owner: true });
    const config = { bot: { ownerPerson: OWNER_PERSON_OWNER_PERSON, owners: ['111'] } };
    assert.equal(ownerPersonOwnerOn('discord', '111', config), true);
    assert.equal(ownerPersonOwnerOn('telegram', '111', config), false);
    // The owner's decision of 2026-11-10 removed the caller check; the owner check of an operation is isOwnerCaller.
    assert.equal(
      withIface('telegram', () => isOwnerCaller(config, { accountId: '111' })),
      false
    );
  });
});

test('every account bound to the owner person has the owner rights, and an unbound one loses them', () => {
  // Bug: the owner's second account stays a stranger, or keeps the rights after the owner undid the binding.
  withAccounts((handle) => {
    link(handle, 'bind', 'discord', '111', { owner: true });
    link(handle, 'bind', 'telegram', '555', { accountId: 'discord:111' });
    const config = { bot: { ownerPerson: OWNER_PERSON_OWNER_PERSON, owners: [] } };
    assert.equal(ownerPersonOwnerOn('telegram', '555', config), true);
    assert.equal(
      withIface('telegram', () => isOwnerCaller(config, { accountId: '555' })),
      true
    );
    link(handle, 'unbind', 'telegram', '555');
    assert.equal(ownerPersonOwnerOn('telegram', '555', config), false);
  });
});

test('an account on the owner person gets no rights from a link the owner did not write', () => {
  // Bug: a link written by an import or a memory session would hand out the owner's rights; only `/memory bind` may.
  withAccounts((handle) => {
    link(handle, 'bind', 'discord', '111', { owner: true });
    dbOf(handle)
      .prepare("UPDATE accounts SET person_id = ?, link = 'verified', linked_by = NULL WHERE id = 'discord:222'")
      .run(OWNER_PERSON_OWNER_PERSON);
    assert.equal(ownerPersonOwnerOn('discord', '222', { bot: { ownerPerson: OWNER_PERSON_OWNER_PERSON } }), false);
  });
});

test('a bound owner person with no account reader passes nobody', () => {
  // Bug: with the memory database out of reach the check would fall open to the bare list.
  assert.equal(isOwnerId({ bot: { ownerPerson: OWNER_PERSON_OWNER_PERSON, owners: ['111'] } }, '111'), false);
});
