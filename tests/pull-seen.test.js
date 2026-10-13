// Tests for the pulled channel's "seen before" line: a `<channel_view>` says, as a fact,
// how its messages relate to the last view of the same source channel shown in the same
// destination channel (src/behavior/prompt.js renders it from the entry's `seenBefore`;
// src/discord/pull-fetch.js#createPullViews keeps the last views in process). Fake
// config, prompts and labels only; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, userText as contentText } from '../src/behavior/prompt.js';
import { createPullViews } from '../src/discord/pull-fetch.js';
import { fill, formatDuration } from '../src/discord/format.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
const MIN = 60_000;
const SRC = 'src';
const DEST = 'dest';

function fakeConfig(features = {}) {
  return {
    bot: { timezone: 'Europe/Moscow' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500, pulled: 4000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
      pull: { seenTtlMinutes: 120 },
    },
    features: { pullSeenMarker: true, ...features },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    lore: { scanMessages: 30, maxMatches: 8 },
    memory: { recentHours: 72 },
  };
}

function fakePrompts(labelSet = labels) {
  return {
    'system-prompt': 'SYSTEM_TEXT for {{name}}',
    'character-card': 'CARD_TEXT',
    rules: 'RULES_TEXT',
    format: 'FORMAT_TEXT',
    reply: 'Answer as {{name}}.',
    interject: 'INTERJECT_TASK',
    initiate: 'INITIATE_TASK',
    memory: 'MEMORY_TEXT',
    labels: labelSet,
  };
}

/** A line of the pulled channel. */
function line(id, minutesAgo, content = `ligne ${id} à Zoé`) {
  return {
    id,
    ts: NOW - minutesAgo * MIN,
    channelId: SRC,
    channelName: 'journal-de-zoé',
    authorId: 'w1',
    authorName: 'Zoé',
    self: false,
    content,
    attachments: [],
    stickers: [],
    replyToId: null,
  };
}

/** The pulled record buildRequest reads (src/discord/pull-fetch.js#fetchPull's shape). */
function pulledEntry(messages, extra = {}) {
  return {
    channelId: SRC,
    channelName: 'journal-de-zoé',
    readOnly: false,
    reason: 'mention',
    earlierPingIds: new Set(),
    olderNotShown: false,
    descriptions: new Map(),
    picturesNotSeen: 0,
    pingState: new Map(),
    messages,
    ...extra,
  };
}

function request(messages, { seenBefore, features, labelSet } = {}) {
  return buildRequest({
    config: fakeConfig(features),
    prompts: fakePrompts(labelSet),
    calibrator: { ratio: 1, apply: (n) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    history: [{ ...line('d1', 1), channelId: DEST, channelName: 'général' }],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    currentChannelId: DEST,
    pulled: [pulledEntry(messages, seenBefore ? { seenBefore } : {})],
  });
}

/** The `<channel_view>` lines of a request. */
function viewOf(built) {
  const match = /<channel_view>\n([\s\S]*?)\n<\/channel_view>/.exec(contentText(built.messages[1].content));
  return match ? match[1].split('\n') : null;
}

/** The view a request left behind, as the memory hands it back `minutesAgo` later. */
function shownBefore(built, minutesAgo) {
  const [view] = built.pulledViews;
  return { hashes: view.hashes, oldestTs: view.oldestTs, shownAt: NOW - minutesAgo * MIN };
}

const PAGE = [line('p4', 40), line('p5', 30), line('p6', 20)];
const ago = (minutes) => formatDuration(minutes * MIN, labels.units);

test('pull seen: a first view carries no seen line and reports its ids, hashes and oldest line', () => {
  const built = request(PAGE);
  assert.equal(viewOf(built).length, 4, 'the header and three lines, nothing else');
  const [shown] = built.pulledViews;
  assert.equal(shown.channelId, SRC);
  assert.deepEqual([...shown.hashes.keys()], ['p4', 'p5', 'p6']);
  assert.equal(shown.oldestTs, NOW - 40 * MIN);
  assert.equal(shown.oldestId, 'p4', 'the oldest window line shown, for an earlier page to start before');
  assert.equal(built.stats.pulled.seenFresh, undefined);
});

test('pull seen: the same ids and content within the TTL -> seenSame right after the header', () => {
  const built = request(PAGE, { seenBefore: shownBefore(request(PAGE), 10) });
  const view = viewOf(built);
  assert.equal(view[1], fill(labels.pull.seenSame, { ago: ago(10) }));
  assert.equal(view.length, 5);
  assert.equal(built.stats.pulled.seenFresh, 0);
  assert.equal(built.stats.pulled.seenOlder, 0);
});

test('pull seen: an earlier page counts every line as new and older than the last view', () => {
  const earlier = [line('p1', 70), line('p2', 60), line('p3', 50)];
  const built = request(earlier, { seenBefore: shownBefore(request(PAGE), 2) });
  assert.equal(viewOf(built)[1], fill(labels.pull.seenBefore, { fresh: 3, older: 3, ago: ago(2) }));
  assert.equal(built.stats.pulled.seenOlder, 3);
  assert.equal(built.pulledViews[0].oldestId, 'p1', 'the next earlier page starts before this one');
});

test('pull seen: two new messages at the bottom -> seenBefore with fresh 2, older 0', () => {
  const built = request([...PAGE, line('p7', 10), line('p8', 5)], { seenBefore: shownBefore(request(PAGE), 5) });
  assert.equal(viewOf(built)[1], fill(labels.pull.seenBefore, { fresh: 2, older: 0, ago: ago(5) }));
  assert.equal(built.stats.pulled.seenFresh, 2);
  assert.equal(built.stats.pulled.seenOlder, 0);
});

test('pull seen: a page of three older messages -> older 3', () => {
  const built = request([line('p1', 70), line('p2', 60), line('p3', 50), ...PAGE], { seenBefore: shownBefore(request(PAGE), 3) });
  assert.equal(viewOf(built)[1], fill(labels.pull.seenBefore, { fresh: 3, older: 3, ago: ago(3) }));
  assert.equal(built.stats.pulled.seenOlder, 3);
});

test('pull seen: an edited message counts as fresh, never older', () => {
  const edited = [PAGE[0], line('p5', 30, 'ligne réécrite après coup'), PAGE[2]];
  const built = request(edited, { seenBefore: shownBefore(request(PAGE), 3) });
  assert.equal(viewOf(built)[1], fill(labels.pull.seenBefore, { fresh: 1, older: 0, ago: ago(3) }));
});

test('pull seen: features.pullSeenMarker false -> no line', () => {
  const built = request(PAGE, { seenBefore: shownBefore(request(PAGE), 3), features: { pullSeenMarker: false } });
  assert.equal(viewOf(built).length, 4);
  assert.equal(built.stats.pulled.seenFresh, undefined);
});

test('pull seen: a labels file without the keys renders no line', () => {
  const { seenBefore: _fresh, seenSame: _same, ...olderPull } = labels.pull;
  const built = request(PAGE, { seenBefore: shownBefore(request(PAGE), 3), labelSet: { ...labels, pull: olderPull } });
  assert.equal(viewOf(built).length, 4);
});

// ---- the in-process memory -------------------------------------------------------

test('createPullViews: a view is found for the same destination and source within the TTL', () => {
  const views = createPullViews();
  views.remember(DEST, request(PAGE).pulledViews, NOW - 30 * MIN);
  const previous = views.previous(DEST, SRC, { now: NOW, ttlMinutes: 120 });
  assert.equal(previous.shownAt, NOW - 30 * MIN);
  assert.equal(previous.oldestTs, NOW - 40 * MIN);
  assert.equal(previous.oldestId, 'p4');
  assert.deepEqual([...previous.hashes.keys()], ['p4', 'p5', 'p6']);
});

test('createPullViews: another destination channel has no previous view', () => {
  const views = createPullViews();
  views.remember(DEST, request(PAGE).pulledViews, NOW - 5 * MIN);
  assert.equal(views.previous('elsewhere', SRC, { now: NOW, ttlMinutes: 120 }), null);
  assert.equal(views.previous(DEST, 'other-source', { now: NOW, ttlMinutes: 120 }), null);
});

test('createPullViews: past the TTL the view is ignored and pruned', () => {
  const views = createPullViews();
  views.remember(DEST, request(PAGE).pulledViews, NOW - 121 * MIN);
  assert.equal(views.previous(DEST, SRC, { now: NOW, ttlMinutes: 120 }), null);
  assert.equal(views.size(), 0);
});

test('createPullViews: a later view of the same pair replaces the earlier one', () => {
  const views = createPullViews();
  views.remember(DEST, request(PAGE).pulledViews, NOW - 20 * MIN);
  views.remember(DEST, request([line('p1', 70), ...PAGE]).pulledViews, NOW - 2 * MIN);
  const previous = views.previous(DEST, SRC, { now: NOW, ttlMinutes: 120 });
  assert.equal(previous.shownAt, NOW - 2 * MIN);
  assert.equal(previous.oldestTs, NOW - 70 * MIN);
  assert.equal(views.size(), 1);
});
