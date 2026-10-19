// Tests for tools/replay.mjs `--inner`: its flags, the hot it runs with (shadow forced, no dry
// run, no journal) and the wake it builds from the inner state read. Pure parts only: the mode
// itself needs Discord and a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innerReplayHot, innerReplayWake, parseArgs } from '../tools/replay.mjs';
import * as inner from '../src/behavior/inner.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');

test('replay --inner: an intention\'s wake needs --intention, the review takes none; other modes\' flags are refused', () => {
  const due = parseArgs(['--inner', 'intention_due', '--intention', 'i-abc', '--spend', '1']);
  assert.equal(due.inner, 'intention_due');
  assert.equal(due.intention, 'i-abc');
  assert.equal(due.review, false);
  assert.equal(parseArgs(['--inner', 'review']).review, true);
  assert.equal(parseArgs(['--inner', 'review', '--review', '--show-request']).showRequest, true);
  for (const argv of [
    ['--inner', 'intention_due'],
    ['--inner', 'review', '--intention', 'i1'],
    ['--inner', 'errand_deadline', '--intention', 'i1', '--review'],
    ['--inner', 'nap'],
    ['--inner', 'review', '--diary', 'picture'],
    ['--inner', 'review', 'c1', 'm1'],
    ['--review'],
    ['--intention', 'i1'],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

test('innerReplayHot: shadow forced, the switch on, no dry run, no journal, no mirror; the live config untouched', () => {
  const live = { config: { features: { innerLife: false, dryRun: true, journal: true, coreTools: true }, bot: { dryRunChannelId: '5', timezone: 'UTC' }, innerLife: { mode: 'live', chatMessages: 7 } }, prompts: {} };
  const config = innerReplayHot(live).config;
  assert.deepEqual(config.features, { innerLife: true, dryRun: false, journal: false, coreTools: true });
  assert.equal(config.innerLife.mode, 'shadow');
  assert.equal(config.innerLife.chatMessages, 7);
  assert.equal(config.bot.dryRunChannelId, '');
  assert.equal(live.config.innerLife.mode, 'live');
});

test('innerReplayWake: the scheduler\'s wake for the intention, its budgets from the state read', () => {
  const settings = inner.innerSettings({});
  const state = { ...inner.emptyState(), turns: [{ at: NOW - 60_000, chainId: 'intention:i1', usd: 0.2 }] };
  const intention = { id: 'i1', status: 'pending', purpose: 'p', dueAt: NOW - 5_000, provenance: { channelId: 'c1', scope: 'group' } };
  const { wake, info } = innerReplayWake({ inner, kind: 'intention_due', intention, state, settings, now: NOW, timezone: 'UTC', day: '2026-10-19' });
  assert.equal(wake.id, `inner.wake:intention_due:i1:${NOW - 5_000}`);
  assert.deepEqual(info.items, [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], taskId: null }]);
  assert.equal(info.budgets.day, undefined);
  assert.equal(info.budgets.chain.left, 2);
  const review = innerReplayWake({ inner, kind: 'review', state, settings, now: NOW, timezone: 'UTC', day: '2026-10-19', channelNames: ['général'] });
  assert.equal(review.wake.kind, 'review');
  assert.deepEqual(review.info.channels, ['général']);
  assert.deepEqual(review.info.intentions, []);
});
