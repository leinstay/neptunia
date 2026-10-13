// Tests for tools/lib/sim.mjs: the pure part of tools/memory-sim.mjs (mobility, stagnation,
// prose checks, the manifest, batches from chat dumps) and the spend gate of tools/lib/cli.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobility, stagnation, wordsPerSentence, batchesFromDump, manifestFrom, proseFields, authorLines, SHORT_SENTENCE_WORDS } from '../tools/lib/sim.mjs';
import { spendGate, daysBetween, parseFlags, CliError } from '../tools/lib/cli.mjs';

const profile = (fields) => ({
  id: 'u1',
  names: ['Ζωή'],
  firstSeen: '2026-10-01T00:00:00.000Z',
  lastSeen: '2026-10-10T00:00:00.000Z',
  messageCount: 10,
  updatedAt: '2026-10-10T00:00:00.000Z',
  character: 'Calm.',
  style: 'Short lines.',
  relationship: '',
  interests: [{ topic: 'chess', weight: 2 }],
  details: [],
  detailsSeq: 1,
  ...fields,
});

test('sim: mobility lists changed and unchanged fields, bookkeeping left out', () => {
  const before = profile();
  const after = profile({ character: 'Calm, then loud.', lastSeen: '2026-10-12T00:00:00.000Z', messageCount: 40, updatedAt: 'x', interests: [{ topic: 'chess', weight: 3 }] });
  assert.deepEqual(mobility(before, after), {
    changed: ['character', 'interests'],
    unchanged: ['details', 'names', 'relationship', 'style'],
  });
  // A member new in the window: every field with content counts as changed.
  assert.deepEqual(mobility(null, profile({ relationship: '', details: [] })), {
    changed: ['character', 'interests', 'names', 'style'],
    unchanged: [],
  });
  // A field that appeared or went away is a change.
  assert.deepEqual(mobility(profile(), { ...profile(), episodes: [{ what: 'x' }] }).changed, ['episodes']);
});

test('sim: stagnation is N/A without a record, empty under the line floor, else the unchanged fields', () => {
  const moved = { changed: ['character'], unchanged: ['style', 'relationship'] };
  assert.equal(stagnation(moved, null, 30), 'N/A');
  assert.equal(stagnation(moved, undefined, 30), 'N/A');
  assert.deepEqual(stagnation(moved, 29, 30), []);
  assert.deepEqual(stagnation(moved, 30, 30), ['style', 'relationship']);
});

test('sim: wordsPerSentence averages words over sentences and ignores empty text', () => {
  assert.equal(wordsPerSentence('One two three. Four five!'), 2.5);
  assert.equal(wordsPerSentence('Μια πρόταση με πέντε λέξεις'), 5);
  assert.equal(wordsPerSentence('Plays chess.\nLikes tea… Hates noise?'), 2);
  assert.equal(wordsPerSentence('   '), null);
  assert.equal(wordsPerSentence(null), null);
  assert.equal(SHORT_SENTENCE_WORDS, 8);
});

test('sim: proseFields lists the non-empty text fields of a profile', () => {
  assert.deepEqual(proseFields(profile({ relationship: 'Trusts her.' })), [
    { field: 'character', text: 'Calm.' },
    { field: 'relationship', text: 'Trusts her.' },
    { field: 'style', text: 'Short lines.' },
  ]);
  assert.deepEqual(proseFields(null), []);
});

test('sim: manifestFrom keeps the guild memory records after the snapshot, oldest first', () => {
  const rec = (at, fields) => ({ v: 1, kind: 'memory', occurredAt: at, scope: { guild: true }, batchId: `b-${at}`, stage: 'single', appliedRevision: `r-${at}`, batch: { messageIds: ['m1', 'm2'], consumed: 2 }, promptsHash: 'p1', configHash: 'c1', ...fields });
  const records = [
    rec('2026-10-13T12:00:00.000Z'),
    rec('2026-10-13T08:00:00.000Z'),
    rec('2026-10-13T09:00:00.000Z', { scope: { user: 'u1', private: true } }),
    rec('2026-10-13T06:00:00.000Z'),
    { kind: 'turn', occurredAt: '2026-10-13T13:00:00.000Z' },
    rec('2026-10-13T14:00:00.000Z', { stage: 'voice' }),
  ];
  const manifest = manifestFrom(records, { after: Date.parse('2026-10-13T07:00:00.000Z') });
  assert.deepEqual(
    manifest.map((m) => [m.occurredAt, m.batchId, m.appliedRevision, m.promptsHash, m.configHash, m.messageIds.length]),
    [
      ['2026-10-13T08:00:00.000Z', 'b-2026-10-13T08:00:00.000Z', 'r-2026-10-13T08:00:00.000Z', 'p1', 'c1', 2],
      ['2026-10-13T12:00:00.000Z', 'b-2026-10-13T12:00:00.000Z', 'r-2026-10-13T12:00:00.000Z', 'p1', 'c1', 2],
    ],
  );
});

test('sim: batchesFromDump turns chat dump lines into slim messages in batches, oldest first', () => {
  const lines = [
    JSON.stringify({ id: '3', ts: '2026-10-13T10:02:00.000Z', author: 'a', name: 'Ζωή', content: 'third', replyTo: '1', mentions: ['b'] }),
    JSON.stringify({ id: '1', ts: '2026-10-13T10:00:00.000Z', author: 'a', name: 'Ζωή', content: 'first', replyTo: null, mentions: [] }),
    '',
    'not json',
    JSON.stringify({ id: '2', ts: 1791885660000, author: 'self', name: 'Bot', content: 'second', replyTo: null }),
    JSON.stringify({ ts: '2026-10-13T10:03:00.000Z', author: 'a', content: 'no id' }),
  ];
  const { batches, skipped } = batchesFromDump(lines, 2, { channelId: 'c9', selfId: 'self' });
  assert.equal(skipped, 2);
  assert.deepEqual(batches.map((batch) => batch.map((m) => m.id)), [['1', '2'], ['3']]);
  const [first, second] = batches[0];
  assert.equal(first.channelId, 'c9');
  assert.equal(first.authorId, 'a');
  assert.equal(first.authorName, 'Ζωή');
  assert.equal(first.content, 'first');
  assert.equal(first.ts, Date.parse('2026-10-13T10:00:00.000Z'));
  assert.equal(first.self, false);
  assert.deepEqual(first.attachments, []);
  assert.equal(second.self, true);
  assert.equal(batches[1][0].replyToId, '1');
  assert.deepEqual(batches[1][0].mentionedUserIds, ['b']);
  assert.throws(() => batchesFromDump(lines, 0), /size/);
});

test('sim: authorLines counts the lines of each member over the resolved batch messages', () => {
  const counts = authorLines([[{ authorId: 'a', self: false }, { authorId: 'b', self: false }], [{ authorId: 'a', self: false }, { authorId: 'x', self: true }]]);
  assert.deepEqual(Object.fromEntries(counts), { a: 2, b: 1 });
});

test('cli: spendGate refuses without --spend or below the estimate and always states the estimate', () => {
  const none = spendGate({ estimateUsd: 0.3, requests: 2 });
  assert.equal(none.ok, false);
  assert.match(none.text, /estimate: 2 model request\(s\), ~0\.30 USD/);
  assert.match(none.text, /--spend/);
  assert.equal(spendGate({ estimateUsd: 0.3, requests: 2, spend: '0.1' }).ok, false);
  assert.equal(spendGate({ estimateUsd: 0.3, requests: 2, spend: 'abc' }).ok, false);
  assert.equal(spendGate({ estimateUsd: 0.3, requests: 2, spend: '0.5' }).ok, true);
  assert.equal(spendGate({ estimateUsd: 0, requests: 0 }).ok, true);
});

test('cli: daysBetween lists UTC days inclusive and refuses a bad range', () => {
  assert.deepEqual(daysBetween('2026-10-30', '2026-11-01', 'u'), ['2026-10-30', '2026-10-31', '2026-11-01']);
  assert.throws(() => daysBetween('2026-10-02', '2026-10-01', 'u'), CliError);
  assert.throws(() => daysBetween('2026-1-01', '2026-10-01', 'u'), CliError);
});

test('cli: parseFlags takes values, lists, multi-value flags and switches', () => {
  const flags = parseFlags(['a', '--x', '1', '--l', 'p', '--l', 'q', '--m', 'd1', 'd2', '--s'], { values: ['--x'], lists: ['--l'], multi: ['--m'], switches: ['--s'], usage: 'u' });
  assert.deepEqual(flags, { _: ['a'], '--x': '1', '--l': ['p', 'q'], '--m': ['d1', 'd2'], '--s': true });
  assert.throws(() => parseFlags(['--nope'], { usage: 'u' }), CliError);
  assert.throws(() => parseFlags(['--x'], { values: ['--x'], usage: 'u' }), CliError);
});
