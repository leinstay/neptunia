// Tests for scripts/lib/replay-args.ts: the flags of `scripts/replay.ts --inner`, which modes take them and which
// combinations are usage errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../../scripts/lib/replay-args.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import '../../../src/tools/operations/index.ts';

// `review` names no wake, so `--inner review` and `--review` are usage errors like any unknown choice.
test("replay --inner: an intention's wake needs --intention; other modes' flags and a review are refused", () => {
  const due = parseArgs(['--inner', 'intention_due', '--intention', 'i-abc', '--spend', '1']);
  assert.equal(due.inner, 'intention_due');
  assert.equal(due.intention, 'i-abc');
  for (const argv of [
    ['--inner', 'intention_due'],
    ['--inner', 'review'],
    ['--inner', 'errand_deadline', '--intention', 'i1', '--review'],
    ['--inner', 'nap'],
    ['--review'],
    ['--intention', 'i1'],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

test('replay --inner heartbeat: no intention or review flag; samples, prompts, out, show-request and spend are taken', () => {
  const args = parseArgs([
    '--inner',
    'heartbeat',
    '--samples',
    '3',
    '--prompts',
    'variant',
    '--out',
    'report.md',
    '--show-request',
    '--spend',
    '2',
  ]);
  assert.equal(args.inner, 'heartbeat');
  assert.equal(args.samples, 3);
  assert.equal(args.prompts, 'variant');
  assert.equal(args.outDir, 'report.md');
  assert.equal(args.showRequest, true);
  assert.equal(parseArgs(['--inner', 'heartbeat']).samples, 1);
  assert.equal(parseArgs(['--inner', 'intention_due', '--intention', 'i1', '--samples', '2']).samples, 2);
  for (const argv of [
    ['--inner', 'heartbeat', '--intention', 'i1'],
    ['--inner', 'heartbeat', '--review'],
    ['--inner', 'heartbeat', '--samples', '0'],
    ['--inner', 'heartbeat', 'c1', 'm1'],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

test('replay --inner: --hide-channel and --hide-message repeat, take ids, and belong to --inner only', () => {
  const args = parseArgs([
    '--inner',
    'heartbeat',
    '--hide-channel',
    '11',
    '--hide-channel',
    '12',
    '--hide-message',
    '99',
  ]);
  assert.deepEqual(args.hideChannels, ['11', '12']);
  assert.deepEqual(args.hideMessages, ['99']);
  assert.deepEqual(parseArgs(['--inner', 'heartbeat']).hideChannels, []);
  for (const argv of [
    ['--inner', 'heartbeat', '--hide-channel', 'abc'],
    ['--inner', 'heartbeat', '--hide-message'],
    ['--hide-channel', '11'],
    ['--hide-message', '5', 'c1', 'm1'],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

test('replay --inner: --answers-dir is accepted with its timeout and samples', () => {
  const ok = parseArgs(['--inner', 'heartbeat', '--answers-dir', 'd', '--answers-timeout-min', '5', '--samples', '3']);
  assert.equal(ok.answersDir, 'd');
  assert.equal(ok.answersTimeoutMin, 5);
});

test('replay --inner takes --seed, and with none the seed is null', () => {
  assert.equal(parseArgs(['--inner', 'heartbeat', '--seed', 'base-1']).seed, 'base-1');
  assert.equal(parseArgs(['--inner', 'heartbeat']).seed, null);
});

test('replay --inner: --errand-answers takes a file and belongs to --inner only', () => {
  assert.equal(parseArgs(['--inner', 'heartbeat', '--errand-answers', 'a.json']).errandAnswers, 'a.json');
  assert.equal(parseArgs(['--inner', 'heartbeat']).errandAnswers, undefined);
  assert.throws(() => parseArgs(['--errand-answers', 'a.json', 'c1', 'm1']), /usage/);
});

useIface('fake');

useSelf('self-id');

test('replay: --diary-kind runs with --diary-day, takes samples, a seed, a prompt layer and --draw none', () => {
  const args = parseArgs([
    '--diary-day',
    '--diary-kind',
    'randomSet',
    '--samples',
    '3',
    '--seed',
    's',
    '--prompts',
    'candidate',
    '--draw',
    'none',
  ]);
  assert.deepEqual(
    [args.diaryKind, args.samples, args.seed, args.prompts, args.draw],
    ['randomSet', 3, 's', 'candidate', 'none']
  );
  for (const argv of [
    ['--diary-kind', 'story'],
    ['--diary-day', '--diary-kind', 'novel'],
    // The kind `status` is refused as any kind outside DIARY_KINDS is.
    ['--diary-day', '--diary-kind', 'status'],
    ['--diary-day', '--diary-kind', 'story', '--date', '2026-10-06'],
    ['--diary-day', '--samples', '2'],
    ['--diary-day', '--draw', 'none'],
    ['--inner', 'heartbeat', '--diary-kind', 'story'],
  ])
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
});

test('replay: --show-request goes with --diary-kind alone', () => {
  assert.equal(parseArgs(['--diary-day', '--diary-kind', 'thought', '--show-request']).showRequest, true);
  assert.throws(() => parseArgs(['--diary-day', '--show-request']), /usage/);
});

// ---- --diary-day -------------------------------------------------------------------

test('replay: --diary-day takes its own flags, fake drawing by default, --max-pictures only live', () => {
  const bare = parseArgs(['--diary-day']);
  assert.equal(bare.diaryDay, true);
  assert.equal(bare.draw, 'fake');
  assert.equal(bare.maxPictures, null);
  assert.equal(bare.seed, null);
  assert.equal(bare.date, null);
  const full = parseArgs([
    '--diary-day',
    '--seed',
    'σπόρος-1',
    '--date',
    '2026-10-06',
    '--draw',
    'live',
    '--max-pictures',
    '3',
    '--out',
    'day',
    '--spend',
    '2',
  ]);
  assert.deepEqual(
    [full.seed, full.date, full.draw, full.maxPictures, full.outDir, full.spend],
    ['σπόρος-1', '2026-10-06', 'live', 3, 'day', '2']
  );
  assert.equal(
    parseArgs(['--diary-day', '--draw', 'live']).maxPictures,
    2,
    'a live day draws two pictures at most unless told'
  );
  for (const argv of [
    ['--diary-day', '--max-pictures', '2'],
    ['--diary-day', '--draw', 'fake', '--max-pictures', '2'],
    ['--diary-day', '--draw', 'paint'],
    ['--diary-day', '--date', '2026-02-30'],
    ['--diary-day', '--date', '06-10-2026'],
    ['--diary-day', '--draw', 'live', '--max-pictures', '0'],
    ['--diary-day', '123456789012345678', '223456789012345678'],
    ['--diary-day', '--diary', 'picture'],
    ['--diary-day', '--count', '2'],
    ['--diary-day', '--prompts', 'candidate'],
    ['--diary-day', '--snapshot', 'snap'],
    ['--diary', 'picture', '--seed', 's'],
    ['123456789012345678', '223456789012345678', '--draw', 'fake'],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

test('replay flags: --core-tools goes with --skills only; --loop-triggers takes triggers and no prompt directories', () => {
  assert.equal(parseArgs(['--skills', 'a.json', '--core-tools']).coreTools, true);
  assert.equal(parseArgs(['--skills', 'a.json']).coreTools, false);
  assert.throws(() => parseArgs(['123456789012345678', '223456789012345678', '--core-tools']), /usage/);
  assert.throws(() => parseArgs(['--diary-day', '--core-tools']), /usage/);
  assert.throws(() => parseArgs(['--pair-core-tools', '--triggers', 't.txt']), /usage/, 'the old flag is gone');
  const loop = parseArgs(['--loop-triggers', '--triggers', 't.txt', '--out', 'o', '--answers-dir', 'a']);
  assert.deepEqual([loop.loopTriggers, loop.triggers, loop.outDir, loop.answersDir], [true, 't.txt', 'o', 'a']);
  const bare = parseArgs(['--loop-triggers', '123456789012345678', '223456789012345678']);
  assert.deepEqual([bare.placeId, bare.triggerId], ['123456789012345678', '223456789012345678']);
  assert.throws(() => parseArgs(['--loop-triggers']), /usage/);
  assert.throws(() => parseArgs(['--skills', 'a.json', '--loop-triggers']), /usage/);
  assert.throws(() => parseArgs(['--loop-triggers', '--triggers', 't.txt', '--samples', '2']), /usage/);
});
