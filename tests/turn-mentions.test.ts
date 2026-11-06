// Tests for mentionsUnderPings (src/turn/mentions.ts): whom one message notifies under each member's own ping state.
// `users` and `repliedUser` are what a loud server sends (everyone but `off`), `notify` says every concerned member has
// `on`, and `asked` is what a silent server sends: only the members who chose `on`. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsUnderPings } from '../src/turn/mentions.ts';
import type { PingState } from '../src/memory/pings.ts';

const states =
  (table: Record<string, PingState>) =>
  (id: string): PingState =>
    table[id] ?? null;

test('mentionsUnderPings: a named member with on is in users and asked, and the message notifies', () => {
  const result = mentionsUnderPings({ users: ['a'], replying: false, stateOf: states({ a: 'on' }) });
  assert.deepEqual(result.users, ['a']);
  assert.deepEqual(result.asked, { users: ['a'], repliedUser: false });
  assert.equal(result.notify, true);
});

test('mentionsUnderPings: a named member with off is in neither users nor asked', () => {
  const result = mentionsUnderPings({ users: ['a'], replying: false, stateOf: states({ a: 'off' }) });
  assert.deepEqual(result.users, []);
  assert.deepEqual(result.asked, { users: [], repliedUser: false });
});

test('mentionsUnderPings: a named member who chose nothing stays in users but is not asked', () => {
  // Bug: silent mode pings a member who never said yes, because `users` is read instead of `asked`.
  const result = mentionsUnderPings({ users: ['a'], replying: false, stateOf: states({}) });
  assert.deepEqual(result.users, ['a']);
  assert.deepEqual(result.asked, { users: [], repliedUser: false });
  assert.equal(result.notify, undefined);
});

test('mentionsUnderPings: of mixed members asked holds the ones with on, in the order named', () => {
  const result = mentionsUnderPings({
    users: ['b', 'a', 'c', 'd'],
    replying: false,
    stateOf: states({ a: 'off', b: 'on', d: 'on' }),
  });
  assert.deepEqual(result.asked?.users, ['b', 'd']);
  assert.deepEqual(result.users, ['b', 'c', 'd']);
  assert.equal(result.notify, undefined);
});

test('mentionsUnderPings: a reply to a member with on asks for the reply ping', () => {
  const result = mentionsUnderPings({ users: [], repliedAuthorId: 'r', stateOf: states({ r: 'on' }) });
  assert.deepEqual(result.asked, { users: [], repliedUser: true });
  assert.equal(result.repliedUser, true);
});

test('mentionsUnderPings: a reply to a member who chose nothing does not ask for the reply ping', () => {
  // Bug: the reply ping of a silent server follows `repliedUser`, which is true for a member with no state.
  const result = mentionsUnderPings({ users: [], repliedAuthorId: 'r', stateOf: states({}) });
  assert.deepEqual(result.asked, { users: [], repliedUser: false });
  assert.equal(result.repliedUser, true);
});

test('mentionsUnderPings: a reply to a member with off asks for no reply ping', () => {
  const result = mentionsUnderPings({ users: [], repliedAuthorId: 'r', stateOf: states({ r: 'off' }) });
  assert.deepEqual(result.asked, { users: [], repliedUser: false });
  assert.equal(result.repliedUser, false);
});

test('mentionsUnderPings: a reply to a member with on that names a member with no state asks for the reply only', () => {
  const result = mentionsUnderPings({ users: ['n'], repliedAuthorId: 'r', stateOf: states({ r: 'on' }) });
  assert.deepEqual(result.asked, { users: [], repliedUser: true });
  assert.equal(result.notify, undefined);
});

test('mentionsUnderPings: a message that is not a reply never asks for a reply ping, even with an author given', () => {
  const result = mentionsUnderPings({
    users: ['a'],
    repliedAuthorId: 'r',
    replying: false,
    stateOf: states({ a: 'on', r: 'on' }),
  });
  assert.deepEqual(result.asked, { users: ['a'], repliedUser: false });
});

test('mentionsUnderPings: a message that concerns nobody has no asked field', () => {
  // Bug: an empty asked on a plain message makes the port believe someone answered, and mirror sends lose their notify.
  const plain = mentionsUnderPings({ users: [], stateOf: states({}) });
  const unnamed = mentionsUnderPings({ users: [null, undefined, ''], replying: false, stateOf: states({}) });
  assert.equal('asked' in plain, false);
  assert.equal('asked' in unnamed, false);
});
