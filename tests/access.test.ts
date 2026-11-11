// Tests for src/tools/operations/grants.ts: the owner check, and the immutable grant and revoke of one stored
// grant of the persona's, keyed by operation name. The owner decided on 2026-11-10 that only he types commands, so a
// stored grant names her user id alone, and a grant to everyone, a role or a member is gone with the member rights layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { grant, revoke, hasGrant, isOwnerId } from '../src/tools/operations/grants.ts';
import { OWNER_PERSON, ownedBy } from './fixtures/owner-accounts.ts';

const SELF = 'self-1';

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

test('hasGrant: true exactly when the entry lists the user id, compared as a string', () => {
  const access = { 'status.show': { users: [7, SELF] } };
  assert.equal(hasGrant(access, 'status.show', { accountId: '7' }), true);
  assert.equal(hasGrant(access, 'status.show', { accountId: SELF }), true);
  assert.equal(hasGrant(access, 'status.show', { accountId: '8' }), false);
  assert.equal(hasGrant(access, 'memory.read', { accountId: SELF }), false);
  assert.equal(hasGrant(undefined, 'status.show', { accountId: SELF }), false);
});

test('hasGrant: a stored everyone or role is no grant of hers', () => {
  // The owner's decision of 2026-11-10: a grant to everyone or a role opened something for members only.
  const access = { 'status.show': { everyone: true, roles: ['r1'], users: [] } };
  assert.equal(hasGrant(access, 'status.show', { accountId: SELF }), false);
});

test('grant: her id on a fresh key stores the users list alone', () => {
  assert.deepEqual(grant({}, 'status.show', { accountId: SELF }), { 'status.show': { users: [SELF] } });
});

test('grant: a numeric id is stored as a string', () => {
  assert.deepEqual(grant({}, 'status.show', { accountId: 12345 }), { 'status.show': { users: ['12345'] } });
});

test('grant: granting the same id twice stores it once', () => {
  const once = grant({}, 'status.show', { accountId: SELF });
  assert.deepEqual(grant(once, 'status.show', { accountId: SELF }), { 'status.show': { users: [SELF] } });
});

test('grant: a grant from a group or * keeps its source, and a direct grant of the same id drops it', () => {
  const expanded = grant({}, 'lore.list', { accountId: SELF }, { from: '*' });
  assert.deepEqual(expanded, { 'lore.list': { users: [SELF], via: { [`user:${SELF}`]: '*' } } });
  assert.deepEqual(grant(expanded, 'lore.list', { accountId: SELF }), { 'lore.list': { users: [SELF] } });
});

test('grant: a stored entry that still holds everyone or roles loses them when it is written', () => {
  // The owner's decision of 2026-11-10: the member rights layer is gone, so no write keeps its fields.
  const access = { 'memory.profile.read': { everyone: true, roles: ['r1'], users: [] } };
  assert.deepEqual(grant(access, 'memory.profile.read', { accountId: SELF }), {
    'memory.profile.read': { users: [SELF] },
  });
});

test('grant: does not mutate its input and leaves other keys untouched', () => {
  const access = { 'lore.list': { users: [SELF] } };
  const snapshot = structuredClone(access);
  const result = grant(access, 'status.show', { accountId: SELF });
  assert.deepEqual(access, snapshot);
  assert.deepEqual(result['lore.list'], { users: [SELF] });
});

test('revoke: removes just that id from the entry', () => {
  const access = { 'status.show': { users: ['u1', SELF] } };
  assert.deepEqual(revoke(access, 'status.show', { accountId: SELF }), { 'status.show': { users: ['u1'] } });
});

test('revoke: the last id deletes the whole entry, even one that still holds everyone or roles', () => {
  // The owner's decision of 2026-11-10: a stored everyone or role opens nothing, so it keeps no entry alive.
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
  assert.deepEqual(revoke(access, 'status.show', { accountId: SELF }), access);
  assert.deepEqual(revoke(access, 'lore.list', { accountId: 'nope' }), access);
});

test('revoke: does not mutate its input', () => {
  const access = { 'status.show': { users: [SELF] } };
  const snapshot = structuredClone(access);
  revoke(access, 'status.show', { accountId: SELF });
  assert.deepEqual(access, snapshot);
});
