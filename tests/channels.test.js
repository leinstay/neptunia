// Tests for src/memory/channels.js: pure activity classification and channel
// rendering for the <server> prompt block (see docs/prompt-contract.md,
// "Server memory (the channel map)"). tests/fixtures/labels.js is an English
// fixture covering every key of the prompt contract, including labels.server.*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelActivity, messagesSince, renderChannel } from '../src/memory/channels.js';
import { DAY_MS } from '../src/time.js';
import { labels } from './fixtures/labels.js';

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

test('channelActivity: live when today + yesterday reach the threshold, slow below it', () => {
  const cfg = { liveMessagesPerDay: 20, deadAfterDays: 7 };
  const rows = [
    {
      label: 'today + yesterday together reach the threshold',
      c: channel({ days: { [TODAY_KEY]: 15, [YESTERDAY_KEY]: 5 }, lastMessageAt: NOW }),
      cfg,
      expected: 'live',
    },
    {
      label: 'exactly at the live threshold is inclusive',
      c: channel({ days: { [TODAY_KEY]: 20 }, lastMessageAt: NOW }),
      cfg,
      expected: 'live',
    },
    {
      label: 'one message short of the live threshold is not live',
      c: channel({ days: { [TODAY_KEY]: 19 }, lastMessageAt: NOW }),
      cfg,
      notExpected: 'live',
    },
    {
      label: 'an empty days object never counts as live',
      c: channel({ days: {}, lastMessageAt: NOW }),
      cfg: { liveMessagesPerDay: 1, deadAfterDays: 7 },
      expected: 'slow',
    },
    {
      label: 'recent activity below the live threshold and within deadAfterDays is "slow"',
      c: channel({ days: { [TODAY_KEY]: 2 }, lastMessageAt: NOW - DAY }),
      cfg,
      expected: 'slow',
    },
  ];
  for (const row of rows) {
    const activity = channelActivity(row.c, NOW, row.cfg);
    if ('expected' in row) assert.equal(activity, row.expected, row.label);
    else assert.notEqual(activity, row.notExpected, row.label);
  }
});

test('channelActivity: only counts today + yesterday, older days do not count toward "live"', () => {
  const c = channel({ days: { '2026-09-10': 500 }, lastMessageAt: NOW - DAY });
  assert.notEqual(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'live');
});

test('channelActivity: dead when lastMessageAt is null, regardless of days', () => {
  const c = channel({ lastMessageAt: null });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'dead');
});

test('channelActivity: exactly at deadAfterDays is NOT dead yet (slow)', () => {
  const c = channel({ lastMessageAt: NOW - 7 * DAY });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'slow');
});

test('channelActivity: one millisecond past deadAfterDays is dead', () => {
  const c = channel({ lastMessageAt: NOW - 7 * DAY - 1 });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'dead');
});

test('channelActivity: a missing cfg, or a missing key, falls back to the values of config.json', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tracked = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).context.channelActivity;
  const channels = [
    channel({ lastMessageAt: NOW - (tracked.deadAfterDays + 1) * DAY }),
    channel({ lastMessageAt: NOW - DAY }),
    channel({ days: { [TODAY_KEY]: tracked.liveMessagesPerDay }, lastMessageAt: NOW }),
  ];
  for (const c of channels) {
    assert.equal(channelActivity(c, NOW), channelActivity(c, NOW, tracked));
    assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: tracked.liveMessagesPerDay }), channelActivity(c, NOW, tracked));
    assert.equal(channelActivity(c, NOW, { deadAfterDays: tracked.deadAfterDays }), channelActivity(c, NOW, tracked));
  }
});

// --- renderChannel -----------------------------------------------------------

test('renderChannel: heading only, no facts, still shows the activity line', () => {
  const c = channel({ name: 'general' });
  const text = renderChannel(c, labels, { current: false, activity: 'slow' });
  assert.equal(text, '# general\nactivity: slow');
});

test('renderChannel: fact lines appear in the documented order: category, topic, purpose, topics, tone, activity', () => {
  const c = channel({
    name: 'general',
    category: 'Text channels',
    topic: 'no politics',
    purpose: 'general chatter',
    topics: 'games, memes',
    tone: 'casual, lots of emoji',
  });
  const text = renderChannel(c, labels, { current: false, activity: 'live' });
  assert.equal(
    text,
    [
      '# general',
      'category: Text channels',
      'topic: no politics',
      'purpose: general chatter',
      'what people write here: games, memes',
      'tone: casual, lots of emoji',
      'activity: live',
    ].join('\n'),
  );
});

test('renderChannel: the current channel gets labels.server.currentMark appended to the heading', () => {
  const c = channel({ name: 'general' });
  const text = renderChannel(c, labels, { current: true, activity: 'live' });
  assert.ok(text.startsWith(`# general${labels.server.currentMark}`));
});

test('renderChannel: activityLive/Slow/Dead select the right label for {activity}', () => {
  const c = channel({ name: 'general' });
  assert.ok(renderChannel(c, labels, { activity: 'live' }).includes(`activity: ${labels.server.activityLive}`));
  assert.ok(renderChannel(c, labels, { activity: 'slow' }).includes(`activity: ${labels.server.activitySlow}`));
  assert.ok(renderChannel(c, labels, { activity: 'dead' }).includes(`activity: ${labels.server.activityDead}`));
});

test('renderChannel: lastMessage is omitted when now is not given, even with lastMessageAt set', () => {
  const c = channel({ name: 'general', lastMessageAt: NOW - 3 * DAY });
  const text = renderChannel(c, labels, { current: false, activity: 'slow' });
  assert.ok(!text.includes('last message'));
});

test('renderChannel: lastMessage is omitted when the channel has never seen a message', () => {
  const c = channel({ name: 'general', lastMessageAt: null });
  const text = renderChannel(c, labels, { current: false, activity: 'dead', now: NOW });
  assert.ok(!text.includes('last message'));
});

test('renderChannel: lastMessage renders a humanised age via labels.units, right before the activity line', () => {
  const c = channel({ name: 'general', lastMessageAt: NOW - 3 * DAY });
  const text = renderChannel(c, labels, { current: false, activity: 'slow', now: NOW });
  assert.equal(text, '# general\nlast message: 3 d ago\nactivity: slow');
});

test('renderChannel: lastMessage under a minute old renders labels.units.lessThanMinute', () => {
  const c = channel({ name: 'general', lastMessageAt: NOW });
  const text = renderChannel(c, labels, { current: false, activity: 'live', now: NOW });
  assert.ok(text.includes(`last message: ${labels.units.lessThanMinute} ago`));
});

test('renderChannel: lastMessage line is omitted entirely when labels.server.lastMessage is missing', () => {
  const noLastMessageLabels = { server: { ...labels.server, lastMessage: undefined }, units: labels.units };
  const c = channel({ name: 'general', lastMessageAt: NOW - 3 * DAY });
  const text = renderChannel(c, noLastMessageLabels, { current: false, activity: 'slow', now: NOW });
  assert.ok(!text.includes('last message'));
});

test('renderChannel: topWriters resolves ids to current names via nameOf, in the stored order', () => {
  const c = channel({ name: 'general', topWriters: [{ id: 'a', count: 8 }, { id: 'b', count: 3 }] });
  const nameOf = (id) => ({ a: 'Alice', b: 'Bob' })[id] ?? null;
  const text = renderChannel(c, labels, { current: false, activity: 'live', nameOf });
  assert.equal(text, '# general\nwrites here most: Alice, Bob\nactivity: live');
});

test('renderChannel: topWriters skips an id nameOf cannot resolve (e.g. someone who left)', () => {
  const c = channel({ name: 'general', topWriters: [{ id: 'a', count: 8 }, { id: 'gone', count: 3 }, { id: 'b', count: 1 }] });
  const nameOf = (id) => ({ a: 'Alice', b: 'Bob' })[id] ?? null;
  const text = renderChannel(c, labels, { current: false, activity: 'live', nameOf });
  assert.ok(text.includes('writes here most: Alice, Bob'));
  assert.ok(!text.includes('gone'));
});

test('renderChannel: topWriters is omitted when there is no nameOf, or an empty list, or no label', () => {
  const c = channel({ name: 'general', topWriters: [{ id: 'a', count: 8 }] });
  assert.ok(!renderChannel(c, labels, { current: false, activity: 'live' }).includes('writes here most'));
  const nameOf = (id) => ({ a: 'Alice' })[id] ?? null;
  assert.ok(!renderChannel(channel({ name: 'general', topWriters: [] }), labels, { activity: 'live', nameOf }).includes('writes here most'));
  const noTopWritersLabels = { server: { ...labels.server, topWriters: undefined }, units: labels.units };
  assert.ok(!renderChannel(c, noTopWritersLabels, { activity: 'live', nameOf }).includes('writes here most'));
});

test('renderChannel: a read-only channel carries labels.server.readOnly', () => {
  const c = channel({
    name: 'ημερολόγιο',
    topic: 'μόνο ανάγνωση',
    purpose: 'café notes',
    tone: 'calm',
    lastMessageAt: NOW - 3 * DAY,
    topWriters: [{ id: 'a', count: 8 }],
  });
  const nameOf = (id) => ({ a: 'Élodie' })[id] ?? null;
  const text = renderChannel(c, labels, { activity: 'slow', now: NOW, nameOf, readOnly: true });
  assert.equal(
    text,
    [
      '# ημερολόγιο',
      'topic: μόνο ανάγνωση',
      'purpose: café notes',
      'tone: calm',
      labels.server.readOnly,
      'last message: 3 d ago',
      'writes here most: Élodie',
      'activity: slow',
    ].join('\n'),
  );
});

test('renderChannel: the current channel never carries the read-only mark', () => {
  const c = channel({ name: 'ημερολόγιο', purpose: 'café notes', lastMessageAt: NOW - 3 * DAY });
  const current = renderChannel(c, labels, { current: true, activity: 'slow', now: NOW });
  assert.equal(renderChannel(c, labels, { current: true, activity: 'slow', now: NOW, readOnly: true }), current);
  assert.equal(current, `# ημερολόγιο${labels.server.currentMark}\npurpose: café notes\nlast message: 3 d ago\nactivity: slow`);
  assert.ok(!current.includes(labels.server.readOnly));
});

test('renderChannel: without the label nothing is added', () => {
  const c = channel({ name: 'ημερολόγιο', purpose: 'café notes', lastMessageAt: NOW - 3 * DAY });
  const today = '# ημερολόγιο\npurpose: café notes\nlast message: 3 d ago\nactivity: slow';
  // No option, or readOnly false: today's entry, byte for byte, with the label present.
  assert.equal(renderChannel(c, labels, { activity: 'slow', now: NOW }), today);
  assert.equal(renderChannel(c, labels, { activity: 'slow', now: NOW, readOnly: false }), today);
  // The option set but the label missing (an older labels.json) or blanked (prompts.local).
  for (const readOnly of [undefined, '']) {
    const older = { server: { ...labels.server, readOnly }, units: labels.units };
    assert.equal(renderChannel(c, older, { activity: 'slow', now: NOW, readOnly: true }), today);
  }
});

test('renderChannel: works with a non-English (Greek) labels object', () => {
  const grLabels = {
    server: {
      currentMark: ' (είσαι εδώ)',
      category: 'κατηγορία: {text}',
      topic: 'θέμα: {text}',
      purpose: 'σκοπός: {text}',
      topics: 'τι γράφουν: {text}',
      tone: 'ύφος: {text}',
      activity: 'δραστηριότητα: {activity}',
      activityLive: 'ζωντανό',
      activitySlow: 'αργό',
      activityDead: 'νεκρό',
    },
  };
  const c = channel({ name: 'γενικά', purpose: 'κουβέντα' });
  const text = renderChannel(c, grLabels, { current: true, activity: 'live' });
  assert.equal(text, '# γενικά (είσαι εδώ)\nσκοπός: κουβέντα\nδραστηριότητα: ζωντανό');
});

const SINCE_T0 = Date.UTC(2026, 9, 7, 12); // 2026-10-07T12:00Z
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

test('messagesSince: sums the days tally from the reference day to now', () => {
  const channel = { days: { [dayKey(SINCE_T0)]: 5, [dayKey(SINCE_T0 - DAY_MS)]: 7, [dayKey(SINCE_T0 - 2 * DAY_MS)]: 11, [dayKey(SINCE_T0 - 9 * DAY_MS)]: 100 } };
  assert.deepEqual(messagesSince(channel, SINCE_T0 - 2 * DAY_MS, SINCE_T0), { count: 23, coveredFromMs: Date.UTC(2026, 8, 28) });
  assert.equal(messagesSince(channel, null, SINCE_T0).count, 123, 'no reference = everything');
});

test('messagesSince: a tally that does not reach the reference date reports what it covers and never throws', () => {
  const channel = { days: { [dayKey(SINCE_T0)]: 3 } };
  assert.deepEqual(messagesSince(channel, SINCE_T0 - 30 * DAY_MS, SINCE_T0), { count: 3, coveredFromMs: Date.UTC(2026, 9, 7) });
  assert.deepEqual(messagesSince({}, SINCE_T0 - DAY_MS, SINCE_T0), { count: 0, coveredFromMs: null });
  assert.deepEqual(messagesSince({ days: { bogus: 'x', [dayKey(SINCE_T0)]: 2 } }, null, SINCE_T0), { count: 2, coveredFromMs: Date.UTC(2026, 9, 7) });
});
