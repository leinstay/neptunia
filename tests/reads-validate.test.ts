// The boundary check of the read actions (src/protocol/validate.js#validateAction, READ_ACTIONS in
// src/protocol/actions.js). A table of good and bad actions per read: references go through the same reference check as
// every action, id lists must hold ids, `limit` is an integer from 1 to 10,000, one anchor at most, finite times, at
// most 25 viewers, at most 50 texts of at most 2,000 characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ_ACTIONS, validateAction } from '../src/protocol/index.js';

const CONVERSATION = { iface: 'fake', conversationId: 'c1' };
const MESSAGE = { iface: 'fake', conversationId: 'c1', messageId: 'm1' };

type Row = { name: string; action: Record<string, unknown>; reason?: string };

const GOOD: ReadonlyArray<Row> = [
  { name: 'conversation info', action: { action: 'conversation.info', conversation: CONVERSATION } },
  {
    name: 'conversation info with audience and viewers',
    action: { action: 'conversation.info', conversation: CONVERSATION, audience: true, viewers: ['u1', 'u2'] },
  },
  { name: 'conversations list', action: { action: 'conversations.list', communityId: 'g1' } },
  {
    name: 'history of the newest lines',
    action: { action: 'messages.history', conversation: CONVERSATION, limit: 50 },
  },
  {
    name: 'history before a message with a floor',
    action: { action: 'messages.history', conversation: CONVERSATION, limit: 10, before: 'm1', since: 1000 },
  },
  {
    name: 'history at the largest limit',
    action: { action: 'messages.history', conversation: CONVERSATION, limit: 10000 },
  },
  { name: 'member info', action: { action: 'member.info', communityId: 'g1', memberId: 'u1' } },
  { name: 'member info of a private chat', action: { action: 'member.info', communityId: null, memberId: 'u1' } },
  {
    name: 'message search with every field',
    action: {
      action: 'messages.search',
      communityId: 'g1',
      text: 'pasta',
      authorId: 'u1',
      after: 1000,
      before: 2000,
      offset: 25,
    },
  },
  { name: 'member search', action: { action: 'members.search', communityId: 'g1', prefix: 'el', limit: 5 } },
  { name: 'emoji list', action: { action: 'emoji.list', communityId: 'g1' } },
  { name: 'link parse', action: { action: 'links.parse', texts: ['https://x/y', 'plain'] } },
  { name: 'reactors', action: { action: 'message.reactors', message: MESSAGE, emoji: '🔥', limit: 10 } },
];

const BAD: ReadonlyArray<Row> = [
  { name: 'conversation info without a reference', action: { action: 'conversation.info' } },
  {
    name: 'conversation info with a reference without an interface',
    action: { action: 'conversation.info', conversation: { conversationId: 'c1' } },
  },
  {
    name: 'conversation info with viewers that are not ids',
    action: { action: 'conversation.info', conversation: CONVERSATION, viewers: ['u1', ''] },
  },
  {
    name: 'conversation info with 26 viewers',
    action: {
      action: 'conversation.info',
      conversation: CONVERSATION,
      viewers: Array.from({ length: 26 }, (_, n) => `u${n}`),
    },
  },
  { name: 'conversations list with an empty community', action: { action: 'conversations.list', communityId: '' } },
  { name: 'history without a limit', action: { action: 'messages.history', conversation: CONVERSATION } },
  {
    name: 'history with a limit of zero',
    action: { action: 'messages.history', conversation: CONVERSATION, limit: 0 },
  },
  {
    name: 'history past the largest limit',
    action: { action: 'messages.history', conversation: CONVERSATION, limit: 10001 },
  },
  {
    name: 'history with a fractional limit',
    action: { action: 'messages.history', conversation: CONVERSATION, limit: 2.5 },
  },
  {
    name: 'history with two anchors',
    action: { action: 'messages.history', conversation: CONVERSATION, limit: 5, before: 'm1', after: 'm2' },
    reason: 'history:anchors',
  },
  {
    name: 'history with before and around',
    action: { action: 'messages.history', conversation: CONVERSATION, limit: 5, before: 'm1', around: 'm2' },
    reason: 'history:anchors',
  },
  {
    name: 'history with a floor that is not finite',
    action: { action: 'messages.history', conversation: CONVERSATION, limit: 5, since: Infinity },
  },
  { name: 'member info without a member', action: { action: 'member.info', communityId: 'g1' } },
  {
    name: 'message search with a time that is not finite',
    action: { action: 'messages.search', communityId: 'g1', after: Number.NaN },
  },
  { name: 'message search without a community', action: { action: 'messages.search', text: 'x' } },
  { name: 'member search without a prefix', action: { action: 'members.search', communityId: 'g1', limit: 5 } },
  {
    name: 'reactors for a reference without a message id',
    action: { action: 'message.reactors', message: CONVERSATION, emoji: '🔥', limit: 10 },
  },
  { name: 'link parse with 51 texts', action: { action: 'links.parse', texts: Array.from({ length: 51 }, () => 'x') } },
  { name: 'link parse with a text of 2001 characters', action: { action: 'links.parse', texts: ['x'.repeat(2001)] } },
  { name: 'link parse with a text that is not a string', action: { action: 'links.parse', texts: [7] } },
];

for (const row of GOOD) {
  test(`accepts a well-formed read: ${row.name}`, () => {
    assert.deepEqual(validateAction(row.action), { ok: true });
  });
}

for (const row of BAD) {
  test(`refuses a malformed read: ${row.name}`, () => {
    const verdict = validateAction(row.action);
    assert.equal(verdict.ok, false);
    if (row.reason !== undefined) assert.equal('reason' in verdict ? verdict.reason : null, row.reason);
  });
}

test('accepts a limit of one and exactly 25 viewers and 50 texts of 2000 characters', () => {
  const viewers = Array.from({ length: 25 }, (_, n) => `u${n}`);
  const texts = Array.from({ length: 50 }, () => 'x'.repeat(2000));
  assert.equal(validateAction({ action: 'messages.history', conversation: CONVERSATION, limit: 1 }).ok, true);
  assert.equal(validateAction({ action: 'conversation.info', conversation: CONVERSATION, viewers }).ok, true);
  assert.equal(validateAction({ action: 'links.parse', texts }).ok, true);
});

test('lists every read action, the message fetch included', () => {
  const names = ['conversation.info', 'conversations.list', 'messages.fetch', 'messages.history', 'member.info'];
  const more = ['messages.search', 'members.search', 'emoji.list', 'links.parse', 'message.reactors'];
  assert.deepEqual([...READ_ACTIONS].sort(), [...names, ...more].sort());
});
