// Tests for the member directory of the core (src/interface/members.ts): the names of the members of a community as
// the interface reported them through `membership.changed`, by community and member. The persona's display name and
// every member name a request or a job reads come from here, and a nickname change reaches them at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberDirectory } from '../src/interface/members.ts';
import type { MembershipChanged } from '../src/protocol/events.js';

let counter = 0;
function changed(
  change: MembershipChanged['change'],
  communityId: string,
  userId: string,
  name: string | null
): MembershipChanged {
  counter += 1;
  const base = {
    kind: 'membership.changed' as const,
    iface: 'discord',
    at: counter,
    id: `discord:membership:${communityId}:${userId}:${change}:${counter}`,
    communityId,
    userId,
    change,
  };
  return change === 'left' ? base : { ...base, member: { id: userId, name, bot: false } };
}

test('names a member after the join is applied', () => {
  const directory = createMemberDirectory();
  directory.apply(changed('joined', 'g1', 'u1', 'Ελένη'));
  assert.equal(directory.nameOf('g1', 'u1'), 'Ελένη');
});

test('reports the new name once a nickname change is applied', () => {
  const directory = createMemberDirectory();
  directory.apply(changed('joined', 'g1', 'u1', 'Ελένη'));
  directory.apply(changed('updated', 'g1', 'u1', 'Λένα'));
  assert.equal(directory.nameOf('g1', 'u1'), 'Λένα');
});

test('names a member not seen before when the first event is an update', () => {
  const directory = createMemberDirectory();
  directory.apply(changed('updated', 'g1', 'u2', 'Zoé'));
  assert.equal(directory.nameOf('g1', 'u2'), 'Zoé');
});

test('keeps the name of the same member apart in two communities', () => {
  const directory = createMemberDirectory();
  directory.apply(changed('joined', 'g1', 'u1', 'Ελένη'));
  directory.apply(changed('joined', 'g2', 'u1', 'Helen'));
  directory.apply(changed('updated', 'g2', 'u1', 'Hélène'));
  assert.equal(directory.nameOf('g1', 'u1'), 'Ελένη');
  assert.equal(directory.nameOf('g2', 'u1'), 'Hélène');
});

test('forgets a member once the leave is applied', () => {
  const directory = createMemberDirectory();
  directory.apply(changed('joined', 'g1', 'u1', 'Ελένη'));
  directory.apply(changed('left', 'g1', 'u1', null));
  assert.equal(directory.nameOf('g1', 'u1'), null);
});

test('answers null for a member or a community it was never told about', () => {
  const directory = createMemberDirectory();
  directory.apply(changed('joined', 'g1', 'u1', 'Ελένη'));
  assert.equal(directory.nameOf('g1', 'u9'), null);
  assert.equal(directory.nameOf('g9', 'u1'), null);
});
