// Tests for the tag that names a member without the handle: the helper that finds it
// (src/behavior/handles.js#untaggedNames), a mention in a line's text reading as the member's
// handle (withUserHandles, formatTranscript), the mark on her own line (transcript.untagged) and the
// note in the result of her message.create / message.edit (skills.result.untaggedNote). Pure,
// except the one turn over the fake adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberNameMap, untaggedNames, withUserHandles } from '../src/behavior/handles.js';
import { formatTranscript } from '../src/format.js';
import { toolResultText } from '../src/skills/tool-calls.js';
import { untaggedNote } from '../src/behavior/turn.js';
import { labels as fixtureLabels } from './fixtures/labels.js';
import { call, toolAnswer } from './fixtures/tool-answers.js';
import { appended, contentText, coreTurn } from './fixtures/turn-harness.js';

const labels = { ...fixtureLabels, transcript: { ...fixtureLabels.transcript, author: '{name} ({handle})' } };
const YOB = '100000000000000001';
const NORTY = '100000000000000002';
const NORA = '100000000000000003';
const names = new Map([
  [YOB, ['Yob', 'Βοβ']],
  [NORTY, ['🌸Norty🌸', 'Norti']],
  [NORA, ['Nor']],
]);
const handles = new Map([
  [YOB, 'uq03j'],
  [NORTY, 'ueyi7'],
  [NORA, 'u0nor'],
]);
const found = (text, mentionedIds = []) =>
  untaggedNames(text, { names, handles, mentionedIds }).map((hit) => `${hit.name}>${hit.handle}`);

test('untaggedNames: a name or an alias after @ is found, in any case, whole names only', () => {
  assert.deepEqual(found('hi @yob and @NORTI!'), ['yob>uq03j', 'NORTI>ueyi7']);
  assert.deepEqual(found('hi @Βοβ, ok'), ['Βοβ>uq03j']);
  assert.deepEqual(found('@Yobanov and mail@Yob'), [], 'a longer word or a word right before the @ is not a tag');
});

test('untaggedNames: emoji names, the longest name first, each member once', () => {
  assert.deepEqual(found('@🌸Norty🌸 hello'), ['🌸Norty🌸>ueyi7']);
  assert.deepEqual(found('@Nor @Norti @Nor'), ['Nor>u0nor', 'Norti>ueyi7'], '@Norti is Norti, not Nor + ti');
});

test('untaggedNames: a handle, a real mention, a URL or a member without a handle is not flagged', () => {
  assert.deepEqual(found('@uq03j @ueyi7'), []);
  assert.deepEqual(found('@Yob hi @Norti', [YOB]), ['Norti>ueyi7'], 'the mentioned one is not flagged');
  assert.deepEqual(found('see https://x.test/@Yob/page'), []);
  assert.deepEqual(untaggedNames('@Yob', { names, handles: new Map(), mentionedIds: [] }), []);
  assert.deepEqual(untaggedNames('no at sign', { names, handles }), []);
});

test('untaggedNames: a name shared with a mentioned member counts as theirs', () => {
  const shared = new Map([...names, ['200', ['Yob']]]);
  const both = new Map([...handles, ['200', 'u0200']]);
  assert.deepEqual(untaggedNames('@Yob', { names: shared, handles: both, mentionedIds: ['200'] }), []);
});

test('withUserHandles: a mentioned member reads as their handle, the rest stays as written', () => {
  const members = { names, handles };
  assert.equal(withUserHandles('hey @Yob and @Norti, @Yobanov', [YOB], members), 'hey @uq03j and @Norti, @Yobanov');
  assert.equal(
    withUserHandles('@🌸Norty🌸 look https://x.test/@Yob', [NORTY], members),
    '@ueyi7 look https://x.test/@Yob'
  );
  assert.equal(
    withUserHandles('hey @Yob', [YOB], { names, handles: new Map() }),
    'hey @Yob',
    'no handle: the name stays'
  );
  assert.equal(withUserHandles('hey @Yob', [], members), 'hey @Yob');
});

test('memberNameMap: directory names and aliases, authors and mentioned members, never self or bots', () => {
  const map = memberNameMap(
    [{ id: '1', names: ['Ana'], aliases: ['Anita'] }],
    [
      { authorId: '1', authorName: 'Ana' },
      { authorId: '2', authorName: 'Bo', mentionedUsers: [{ id: '3', name: 'Cy' }] },
      { authorId: '9', authorName: 'Me', self: true },
      { authorId: '8', authorName: 'Bot', bot: true },
    ]
  );
  assert.deepEqual(
    [...map],
    [
      ['1', ['Ana', 'Anita']],
      ['2', ['Bo']],
      ['3', ['Cy']],
    ]
  );
});

const SELF = '900000000000000001';
const base = {
  timezone: 'UTC',
  gapMinutes: 20,
  maxChars: 800,
  selfName: 'Nept',
  labels,
  handles: new Map([...handles, [SELF, 'uself']]),
  memberNames: names,
};
const line = (over) => ({
  id: '1',
  ts: Date.UTC(2026, 9, 24, 10, 0, 0),
  authorId: '5',
  authorName: 'Zoë',
  self: false,
  attachments: [],
  stickers: [],
  replyToId: null,
  mentionedUserIds: [],
  ...over,
});

test("formatTranscript: a mention in a line reads as the member's handle, with the handles off nothing changes", () => {
  const message = line({ content: 'ping @Yob', mentionedUserIds: [YOB], mentionedUsers: [{ id: YOB, name: 'Yob' }] });
  assert.ok(formatTranscript([message], base)[0].text.endsWith('ping @uq03j'));
  assert.ok(formatTranscript([message], { ...base, handles: undefined })[0].text.endsWith('ping @Yob'));
  assert.ok(formatTranscript([message], { ...base, mode: 'memory' })[0].text.endsWith('ping @Yob'));
  const own = line({ self: true, authorId: SELF, content: '@Yob there', mentionedUserIds: [YOB] });
  assert.ok(
    formatTranscript([own], base)[0].text.endsWith('@uq03j there'),
    'her own line too, the name from the request when the line has none'
  );
});

test("formatTranscript: her line with an untagged @name ends with the mark; nobody else's line, nor a real mention", () => {
  const own = line({ self: true, authorId: SELF, content: 'hello @Norti and @Yob', mentionedUserIds: [YOB] });
  assert.ok(
    formatTranscript([own], base)[0].text.endsWith('hello @Norti and @uq03j (@Norti tagged nobody)'),
    formatTranscript([own], base)[0].text
  );
  const theirs = line({ content: 'hello @Norti' });
  assert.ok(formatTranscript([theirs], base)[0].text.endsWith('hello @Norti'));
  assert.ok(
    formatTranscript([{ ...own, mentionedUserIds: [YOB, NORTY] }], base)[0].text.endsWith('hello @ueyi7 and @uq03j')
  );
  assert.ok(
    formatTranscript([own], { ...base, handles: undefined })[0].text.endsWith('hello @Norti and @Yob'),
    'handles off: no mark'
  );
  const noLabel = { ...labels, transcript: { ...labels.transcript, untagged: undefined } };
  assert.ok(formatTranscript([own], { ...base, labels: noLabel })[0].text.endsWith('hello @Norti and @uq03j'));
});

test('untaggedNote: one note per untagged name with the handle, nothing without handles or labels', () => {
  const handleToId = new Map([...handles].map(([id, handle]) => [handle, id]));
  const request = { handles: handleToId, memberNames: names, mentionedIds: [] };
  assert.equal(
    untaggedNote('@Yob and @Norti', request, labels),
    '@Yob tagged nobody; handle @uq03j @Norti tagged nobody; handle @ueyi7'
  );
  assert.equal(untaggedNote('@Yob', { ...request, mentionedIds: [YOB] }, labels), '');
  assert.equal(untaggedNote('@Yob', { ...request, handles: null }, labels), '');
  assert.equal(untaggedNote('@Yob', request, { skills: { result: {} } }), '');
  const result = { status: 'ok', note: 'NOTE' };
  assert.ok(toolResultText(result, labels).endsWith('\nNOTE'));
});

test('a turn: message.create with @name tells her in the next request; the post goes out as written and stays ok', async () => {
  const run = await coreTurn({
    answers: [toolAnswer('<think>x</think>', [call('message.create', { text: 'hello @Zoë' })]), '<skip/>'],
    allowed: ['message.create'],
  });
  assert.equal(run.llm.calls.length, 2, 'a note is something to read');
  assert.equal(run.sends[0].text, 'hello @Zoë', 'her text goes out as she wrote it');
  const result = contentText(appended(run.llm, 1).find((message) => message.role === 'tool').content);
  assert.match(result, /@Zoë tagged nobody; handle @u[0-9a-z]{4,}/);
  assert.match(result, new RegExp(labels.skills.result.ok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
