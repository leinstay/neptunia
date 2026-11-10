// Tests for src/behavior/mention.ts: whether/how the persona was called, and
// whether it reacts to it at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTrigger,
  createTagHistory,
  decideTurn,
  inAttention,
  followUpPreFilter,
  parseAddressAnswer,
  followUpTriggerKind,
  isTaggedCall,
} from '../src/behavior/mention.ts';

// --- detectTrigger ----------------------------------------------------------
// Plan 2026-11-04-cli-and-memory B1: name triggers leave the door, so the whole-word name tests of this section went
// with them. The flag order survives.

test('detectTrigger: a reply takes priority over a mention', () => {
  assert.equal(detectTrigger({ mentionsSelf: true, repliesToSelf: true }), 'reply');
});

test('detectTrigger: a line with no flag has no kind', () => {
  assert.equal(detectTrigger({ mentionsSelf: false, repliesToSelf: false }), null);
});

// --- strippedLength -----------------------------------------------------------

// --- createTagHistory -----------------------------------------------------------

test('createTagHistory: counts hits within the window, this call included', () => {
  const history = createTagHistory();
  assert.equal(history.hit('u1', 1000, 60_000), 1);
  assert.equal(history.hit('u1', 2000, 60_000), 2);
  assert.equal(history.hit('u1', 3000, 60_000), 3);
});

test('createTagHistory: hits outside the window age out', () => {
  const history = createTagHistory();
  history.hit('u1', 0, 1000);
  assert.equal(history.hit('u1', 5000, 1000), 1); // the first hit is long gone
});

test('createTagHistory: tracks different users independently', () => {
  const history = createTagHistory();
  history.hit('u1', 0, 60_000);
  assert.equal(history.hit('u2', 100, 60_000), 1);
});

// --- decideTurn -------------------------------------------------------------
// Plan 2026-11-04-cli-and-memory B1: the per-author rail replaces the mention chance and the spam silence, and rolls
// nothing. neverIgnore survives from decideMention.

test('decideTurn: neverIgnore always responds, whatever the count', () => {
  const result = decideTurn({ turns: 60, limit: 1, neverIgnore: true });
  assert.equal(result.respond, true);
  assert.equal(result.reason, 'never-ignore');
});

test('decideTurn: the limit refuses the turn past it, and under it every turn starts', () => {
  assert.equal(decideTurn({ turns: 50, limit: 50, neverIgnore: false }).respond, false);
  assert.equal(decideTurn({ turns: 49, limit: 50, neverIgnore: false }).respond, true);
});

test('decideTurn: a limit of zero turns the rail off', () => {
  assert.equal(decideTurn({ turns: 1000, limit: 0, neverIgnore: false }).respond, true);
});

// The owner moved aliases to her person record, so the card's `## Aliases` reader and its tests went.

test('isTaggedCall: a typed tag counts, the reply ping alone does not', () => {
  assert.equal(isTaggedCall({ mentionedAccountIds: ['s1'], replyPingAccountId: null }, 's1'), true);
  assert.equal(isTaggedCall({ mentionedAccountIds: ['s1'], replyPingAccountId: 's1' }, 's1'), false);
  assert.equal(isTaggedCall({ mentionedAccountIds: ['u2'], replyPingAccountId: null }, 's1'), false);
  assert.equal(isTaggedCall({}, 's1'), false);
});

// --- The address classifier: inAttention / followUpPreFilter / parseFollowUpVerdict --

// PR 7d: the window (15 minutes) and the streak that closes it (5) are constants of src/behavior/mention.ts.

// Plan 2026-11-04-cli-and-memory B1: attention replaces the follow-up window, and a run of `no` verdicts no longer
// closes it, so the no-streak cases went.
test('inAttention: false with no post of hers', () => {
  assert.equal(inAttention(undefined, 1000, 15), false);
});

test('inAttention: false at the edge of the window, true a moment before', () => {
  assert.equal(inAttention(1000, 1000 + 15 * 60_000, 15), false);
  assert.equal(inAttention(1000, 1000 + 15 * 60_000 - 1, 15), true);
});

test('followUpPreFilter: a reply to another member reaches the classifier', () => {
  const normalized = { replyToId: 'm100', mentionedAccountIds: [], replyPingAccountId: null };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: a reply whose only mention is the implicit reply ping reaches the classifier', () => {
  const normalized = { replyToId: 'm100', mentionedAccountIds: ['u2'], replyPingAccountId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: a reply that also mentions a third member explicitly is "no" material', () => {
  const normalized = { replyToId: 'm100', mentionedAccountIds: ['u2', 'u3'], replyPingAccountId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), true);
});

test('followUpPreFilter: the reply-ping exemption only applies to a reply', () => {
  const normalized = { replyToId: null, mentionedAccountIds: ['u2'], replyPingAccountId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), true);
});

test('followUpPreFilter: a mention of the persona itself does not pre-filter', () => {
  const normalized = { replyToId: null, mentionedAccountIds: ['self1'] };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: mentionedAccountIds omitted is treated as empty', () => {
  const rows: Array<[string, { replyToId: null; mentionedAccountIds?: Array<string> }]> = [
    ['plain text with no reply and no mention reaches the model', { replyToId: null, mentionedAccountIds: [] }],
    ['mentionedAccountIds omitted is treated as empty', { replyToId: null }],
  ];
  for (const [label, normalized] of rows) {
    // The omitted field is the case under test, so the row is passed as the full shape it stands in for.
    assert.equal(followUpPreFilter(normalized as Parameters<typeof followUpPreFilter>[0], 'self1'), false, label);
  }
});

test('parseAddressAnswer: the three objects read as their answers', () => {
  assert.equal(parseAddressAnswer('{"answer":"yes"}'), 'yes');
  assert.equal(parseAddressAnswer('{"answer":"overheard"}'), 'overheard');
  assert.equal(parseAddressAnswer('{"answer":"no"}'), 'no');
});

test('parseAddressAnswer: bare words, other values and anything else are unreadable', () => {
  for (const text of [
    'yes',
    'Overheard.',
    'no',
    '',
    '   ',
    null,
    undefined,
    '{"answer":"maybe"}',
    '{"verdict":"yes"}',
    '```json\n{"answer":"yes"}\n```',
    '**yes**',
  ]) {
    assert.equal(parseAddressAnswer(text), null, JSON.stringify(text));
  }
});

// The lead: an overheard object counting as yes is the first parseFollowUpVerdict test above; the bare words are unreadable.
test('followUpTriggerKind: no starts nothing, yes a followUp turn, overheard an overheard turn', () => {
  assert.equal(followUpTriggerKind('no'), null);
  assert.equal(followUpTriggerKind('yes'), 'followUp');
  assert.equal(followUpTriggerKind('overheard'), 'overheard');
});
