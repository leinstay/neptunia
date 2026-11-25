// Tests for src/memory/channels.ts: pure activity classification and channel
// rendering for the <server> prompt block (see docs/prompt-contract.md,
// "Server memory (the channel map)"). tests/fixtures/labels.ts is an English
// fixture covering every key of the prompt contract, including labels.server.*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelActivity } from '../../../src/memory/channels.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0); // Sun 20 Sep 2026, 12:00 UTC
const TODAY_KEY = '2026-09-20';
const YESTERDAY_KEY = '2026-09-19';

function channel(overrides = {}) {
  return {
    id: 'c1',
    name: 'general',
    category: null,
    topic: null,
    purpose: '',
    topics: '',
    tone: '',
    days: {},
    messageCount: 0,
    lastMessageAt: null,
    updatedAt: null,
    ...overrides,
  };
}

// --- channelActivity --------------------------------------------------------

// The thresholds are constants of src/memory/channels.ts, 20 messages and 7 days.
test('channelActivity: live when today + yesterday reach the threshold, slow below it', () => {
  const rows = [
    {
      label: 'today + yesterday together reach the threshold',
      c: channel({ days: { [TODAY_KEY]: 15, [YESTERDAY_KEY]: 5 }, lastMessageAt: NOW }),
      expected: 'live',
    },
    {
      label: 'exactly at the live threshold is inclusive',
      c: channel({ days: { [TODAY_KEY]: 20 }, lastMessageAt: NOW }),
      expected: 'live',
    },
    {
      label: 'one message short of the live threshold is not live',
      c: channel({ days: { [TODAY_KEY]: 19 }, lastMessageAt: NOW }),
      notExpected: 'live',
    },
    {
      label: 'an empty days object never counts as live',
      c: channel({ days: {}, lastMessageAt: NOW }),
      expected: 'slow',
    },
    {
      label: 'recent activity below the live threshold and within deadAfterDays is "slow"',
      c: channel({ days: { [TODAY_KEY]: 2 }, lastMessageAt: NOW - DAY }),
      expected: 'slow',
    },
  ];
  for (const row of rows) {
    const activity = channelActivity(row.c, NOW);
    if ('expected' in row) assert.equal(activity, row.expected, row.label);
    else assert.notEqual(activity, row.notExpected, row.label);
  }
});

test('channelActivity: only counts today + yesterday, older days do not count toward "live"', () => {
  const c = channel({ days: { '2026-09-10': 500 }, lastMessageAt: NOW - DAY });
  assert.notEqual(channelActivity(c, NOW), 'live');
});

test('channelActivity: dead when lastMessageAt is null, regardless of days', () => {
  const c = channel({ lastMessageAt: null });
  assert.equal(channelActivity(c, NOW), 'dead');
});

test('channelActivity: exactly at deadAfterDays is NOT dead yet (slow)', () => {
  const c = channel({ lastMessageAt: NOW - 7 * DAY });
  assert.equal(channelActivity(c, NOW), 'slow');
});

test('channelActivity: one millisecond past deadAfterDays is dead', () => {
  const c = channel({ lastMessageAt: NOW - 7 * DAY - 1 });
  assert.equal(channelActivity(c, NOW), 'dead');
});
