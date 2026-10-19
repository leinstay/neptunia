// Tests for src/behavior/elsewhere.js: the pure core of speaking in the main
// channel about a channel the persona cannot write in -- the settle wait, the
// ring of calls, the per-channel seen mark, the liveness rule of a noticed
// comment, the audience comparison, the destination pick and the jump link.
// No I/O besides reading the shipped config.json; the clock is passed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ELSEWHERE_DEFAULTS,
  LIVENESS_DEFAULTS,
  audienceCovers,
  chooseElsewhereMode,
  elsewhereSettings,
  hasUnseen,
  isSourceLive,
  liveMemberCount,
  markPingAnswered,
  markPingSkipped,
  markSeen,
  mayBeLive,
  messageLink,
  pickDestinationId,
  pingStatus,
  pingsIn,
  recordPing,
  resolveDestination,
  settleDueAt,
  stampPings,
} from '../src/behavior/elsewhere.js';
import { chooseMode } from '../src/behavior/spontaneous.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const SEC = 1000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

/** A normalized message in a read-only source channel. */
function msg(id, minutesAgo, { self = false, bot = false } = {}) {
  return { id, ts: NOW - minutesAgo * MIN, channelId: 'src', authorId: self ? 'self-id' : `u-${id}`, authorName: `Zoë${id}`, self, bot, content: `Καλημέρα ${id}` };
}

/** An audience record: who can view one channel. */
function audience({ everyone = false, roles = [], roleAllow = [], roleDeny = [], memberAllow = [], memberDeny = [], memberRoles = null } = {}) {
  return {
    everyone,
    roles: new Set(roles),
    roleAllow: new Set(roleAllow),
    roleDeny: new Set(roleDeny),
    memberAllow: new Set(memberAllow),
    memberDeny: new Set(memberDeny),
    ...(memberRoles ? { memberRoles: new Map(Object.entries(memberRoles).map(([id, held]) => [id, new Set(held)])) } : {}),
  };
}

const RING_OPTS = { cap: 20, maxAgeMs: 7 * DAY, now: NOW };

// ---- settings -------------------------------------------------------------------

test('config.json: the code fallbacks equal the elsewhere block and the liveness settings', () => {
  assert.deepEqual(shipped.elsewhere, { ...ELSEWHERE_DEFAULTS });
  assert.equal(shipped.spontaneous.liveMinMessages, LIVENESS_DEFAULTS.liveMinMessages);
  assert.equal(shipped.spontaneous.liveWindowMinutes, LIVENESS_DEFAULTS.liveWindowMinutes);
});

test('elsewhereSettings: live values in milliseconds, zero kept, garbage falls back to the defaults', () => {
  const fallback = elsewhereSettings({});
  assert.deepEqual(
    elsewhereSettings({ elsewhere: { settleSeconds: 10, settleMaxSeconds: 60, rememberPings: 3, pingMaxAgeDays: 2 } }),
    { settleMs: 10 * SEC, settleMaxMs: 60 * SEC, rememberPings: 3, pingMaxAgeMs: 2 * DAY },
  );
  assert.deepEqual(
    elsewhereSettings({ elsewhere: { settleSeconds: 0, settleMaxSeconds: 0, rememberPings: 0, pingMaxAgeDays: 0 } }),
    { settleMs: 0, settleMaxMs: 0, rememberPings: 0, pingMaxAgeMs: 0 },
  );
  for (const bad of [-1, 'soon']) {
    assert.deepEqual(
      elsewhereSettings({ elsewhere: { settleSeconds: bad, settleMaxSeconds: bad, rememberPings: bad, pingMaxAgeDays: bad } }),
      fallback,
      String(bad),
    );
  }
  assert.equal(elsewhereSettings({ elsewhere: { rememberPings: 4.7 } }).rememberPings, 4);
});

// ---- settle -----------------------------------------------------------------------

test('settleDueAt: a new message pushes the due time by settleMs', () => {
  const firstAt = NOW;
  assert.equal(settleDueAt({ firstAt, lastAt: firstAt, settleMs: 90 * SEC, maxMs: 300 * SEC }), NOW + 90 * SEC);
  assert.equal(settleDueAt({ firstAt, lastAt: firstAt + 60 * SEC, settleMs: 90 * SEC, maxMs: 300 * SEC }), NOW + 150 * SEC);
});

test('settleDueAt: never later than firstAt plus maxMs', () => {
  const firstAt = NOW;
  assert.equal(settleDueAt({ firstAt, lastAt: firstAt + 280 * SEC, settleMs: 90 * SEC, maxMs: 300 * SEC }), NOW + 300 * SEC);
  assert.equal(settleDueAt({ firstAt, lastAt: firstAt, settleMs: 90 * SEC, maxMs: 30 * SEC }), NOW + 30 * SEC, 'a max below the settle caps it');
  assert.equal(settleDueAt({ firstAt, lastAt: firstAt + 5 * SEC, settleMs: 0, maxMs: 300 * SEC }), NOW + 5 * SEC, 'no settle acts at the last message');
});

test('settleDueAt: a missing lastAt counts from firstAt', () => {
  assert.equal(settleDueAt({ firstAt: NOW, settleMs: 90 * SEC, maxMs: 300 * SEC }), NOW + 90 * SEC);
  assert.equal(settleDueAt({ firstAt: NOW, lastAt: Number.NaN, settleMs: 90 * SEC, maxMs: 300 * SEC }), NOW + 90 * SEC);
});

// ---- the ring of calls ----------------------------------------------------------------

test('recordPing: a new entry is unanswered and unskipped, the stored ring is not mutated', () => {
  const ring = [];
  const next = recordPing(ring, { messageId: 'm1', channelId: 'src', ts: NOW - MIN }, RING_OPTS);
  assert.deepEqual(ring, []);
  assert.deepEqual(next, [{ messageId: 'm1', channelId: 'src', ts: NOW - MIN, answeredAt: null, skippedAt: null }]);
  assert.equal(pingStatus(next[0]), 'unanswered');
});

test('recordPing: keeps the newest cap entries and drops expired ones', () => {
  let ring = [{ messageId: 'old', channelId: 'src', ts: NOW - 8 * DAY, answeredAt: null, skippedAt: null }];
  for (let i = 1; i <= 4; i += 1) {
    ring = recordPing(ring, { messageId: `m${i}`, channelId: 'src', ts: NOW - (10 - i) * MIN }, { cap: 3, maxAgeMs: 7 * DAY, now: NOW });
  }
  assert.deepEqual(ring.map((p) => p.messageId), ['m2', 'm3', 'm4'], 'oldest first, the expired one and the oldest beyond the cap gone');
  const tooOld = recordPing([], { messageId: 'x', channelId: 'src', ts: NOW - 8 * DAY }, RING_OPTS);
  assert.deepEqual(tooOld, [], 'a call already past its lifetime is never recorded');
  const older = recordPing(ring, { messageId: 'early', channelId: 'src', ts: NOW - 60 * MIN }, { cap: 3, maxAgeMs: 7 * DAY, now: NOW });
  assert.deepEqual(older.map((p) => p.messageId), ['m2', 'm3', 'm4'], 'an older call than the whole full ring does not push out a newer one');
  assert.deepEqual(recordPing(ring, { messageId: 'm5', channelId: 'src', ts: NOW }, { cap: 0, maxAgeMs: 7 * DAY, now: NOW }), [], 'a cap of 0 keeps nothing');
});

test('recordPing: an expired stored entry is dropped in a ring below its cap', () => {
  const stale = { messageId: 'old', channelId: 'src', ts: NOW - 8 * DAY, answeredAt: null, skippedAt: null };
  const ring = recordPing([stale], { messageId: 'm1', channelId: 'src', ts: NOW }, RING_OPTS);
  assert.deepEqual(ring.map((p) => p.messageId), ['m1'], 'only the lifetime removes it: the cap of 20 is far away');
  const edge = { messageId: 'edge', channelId: 'src', ts: NOW - 7 * DAY, answeredAt: null, skippedAt: null };
  assert.deepEqual(
    recordPing([edge], { messageId: 'm1', channelId: 'src', ts: NOW }, RING_OPTS).map((p) => p.messageId),
    ['edge', 'm1'],
    'a call exactly pingMaxAgeDays old is kept',
  );
});

test('recordPing: a pingMaxAgeDays of 0 keeps calls of any age', () => {
  const ring = recordPing([{ messageId: 'old', channelId: 'src', ts: NOW - 400 * DAY, answeredAt: null, skippedAt: null }], { messageId: 'm1', channelId: 'src', ts: NOW }, { cap: 20, maxAgeMs: 0, now: NOW });
  assert.deepEqual(ring.map((p) => p.messageId), ['old', 'm1']);
});

test('recordPing: one entry per message id, the first record and its state kept', () => {
  let ring = recordPing([], { messageId: 'm1', channelId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  ring = markPingAnswered(ring, 'm1', NOW - MIN);
  ring = recordPing(ring, { messageId: 'm1', channelId: 'src', ts: NOW - MIN }, RING_OPTS);
  assert.equal(ring.length, 1);
  assert.equal(ring[0].ts, NOW - 2 * MIN);
  assert.equal(ring[0].answeredAt, NOW - MIN);
});

test('recordPing: garbage in the stored ring or the new call is dropped, never thrown on', () => {
  const stored = [
    null,
    'm0',
    { messageId: 'm1' },
    { messageId: 'm2', channelId: 'src', ts: NOW - MIN, answeredAt: 'yes', skippedAt: null },
    { messageId: 'm4', channelId: 'src', ts: NOW - MIN, answeredAt: null, skippedAt: 'yes' },
  ];
  const ring = recordPing(stored, { messageId: '', channelId: 'src', ts: NOW }, RING_OPTS);
  assert.deepEqual(ring, [
    { messageId: 'm2', channelId: 'src', ts: NOW - MIN, answeredAt: null, skippedAt: null },
    { messageId: 'm4', channelId: 'src', ts: NOW - MIN, answeredAt: null, skippedAt: null },
  ]);
  assert.equal(pingStatus(ring[1]), 'unanswered', 'a garbage skip stamp is no skip');
  assert.deepEqual(recordPing(undefined, { messageId: 'm3', channelId: 'src', ts: NOW }, RING_OPTS).map((p) => p.messageId), ['m3']);
});

test('markPingAnswered: stamps that entry only and keeps the first stamp', () => {
  let ring = [];
  ring = recordPing(ring, { messageId: 'm1', channelId: 'src', ts: NOW - 3 * MIN }, RING_OPTS);
  ring = recordPing(ring, { messageId: 'm2', channelId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  const before = ring;
  ring = markPingAnswered(ring, 'm2', NOW - MIN);
  assert.equal(before[1].answeredAt, null, 'the input ring is not mutated');
  assert.equal(ring[0].answeredAt, null);
  assert.equal(ring[1].answeredAt, NOW - MIN);
  ring = markPingAnswered(ring, 'm2', NOW);
  assert.equal(ring[1].answeredAt, NOW - MIN);
  assert.deepEqual(markPingAnswered(ring, 'unknown', NOW), ring);
});

test('markPingSkipped: a call the persona chose to skip is skipped, not unanswered', () => {
  let ring = recordPing([], { messageId: 'm1', channelId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  ring = markPingSkipped(ring, 'm1', NOW - MIN);
  assert.equal(ring[0].skippedAt, NOW - MIN);
  assert.equal(pingStatus(ring[0]), 'skipped');
  ring = markPingSkipped(ring, 'm1', NOW);
  assert.equal(ring[0].skippedAt, NOW - MIN, 'the first skip is kept');
});

test('markPingSkipped: an answered call stays answered; a later answer wins over a skip', () => {
  let answered = recordPing([], { messageId: 'm1', channelId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  answered = markPingSkipped(markPingAnswered(answered, 'm1', NOW - MIN), 'm1', NOW);
  assert.equal(answered[0].skippedAt, null);
  assert.equal(pingStatus(answered[0]), 'answered');
  let skipped = recordPing([], { messageId: 'm2', channelId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  skipped = markPingAnswered(markPingSkipped(skipped, 'm2', NOW - MIN), 'm2', NOW);
  assert.equal(pingStatus(skipped[0]), 'answered');
});

test('stampPings: stamps each call in order and reports only the ones whose state changed', () => {
  let ring = [];
  for (const id of ['a', 's', 'u', 'w']) ring = recordPing(ring, { messageId: id, channelId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  ring = markPingSkipped(markPingAnswered(ring, 'a', NOW - MIN), 's', NOW - MIN);
  const before = ring;

  const { ring: next, marked } = stampPings(
    ring,
    [
      { messageId: 'a', status: 'skipped' },
      { messageId: 's', status: 'answered' },
      { messageId: 'u', status: 'skipped' },
      { messageId: 'u', status: 'answered' },
      { messageId: 'w', status: 'skipped' },
      { messageId: 'w', status: 'skipped' },
      { messageId: 'unknown', status: 'answered' },
    ],
    NOW,
  );

  assert.deepEqual(
    marked,
    [
      { messageId: 's', channelId: 'src', status: 'answered' },
      { messageId: 'u', channelId: 'src', status: 'skipped' },
      { messageId: 'u', channelId: 'src', status: 'answered' },
      { messageId: 'w', channelId: 'src', status: 'skipped' },
    ],
    'an answered call is never skipped, an answer wins over a skip, a repeat changes nothing, an unknown id is passed over',
  );
  assert.deepEqual(next.map((p) => [p.messageId, pingStatus(p)]), [['a', 'answered'], ['s', 'answered'], ['u', 'answered'], ['w', 'skipped']]);
  assert.deepEqual([next[1].skippedAt, next[1].answeredAt, next[3].skippedAt], [NOW - MIN, NOW, NOW], 'earlier stamps are kept');
  assert.equal(pingStatus(before[2]), 'unanswered', 'the stored ring is not mutated');
});

test('stampPings: no stamp, an unknown status or garbage changes nothing and never throws', () => {
  const ring = recordPing([], { messageId: 'm1', channelId: 'src', ts: NOW - MIN }, RING_OPTS);
  assert.deepEqual(stampPings(ring, [], NOW), { ring, marked: [] });
  assert.deepEqual(stampPings(ring, [{ messageId: 'm1', status: 'seen' }, null, { status: 'skipped' }], NOW).marked, []);
  assert.deepEqual(stampPings(undefined, [{ messageId: 'm1', status: 'skipped' }], NOW), { ring: [], marked: [] });
  assert.deepEqual(stampPings(ring, undefined, NOW).marked, []);
});

test('pingsIn: only this channel, only unexpired, oldest first', () => {
  const ring = [
    { messageId: 'b', channelId: 'src', ts: NOW - 2 * MIN, answeredAt: null, skippedAt: null },
    { messageId: 'a', channelId: 'src', ts: NOW - 5 * MIN, answeredAt: NOW - MIN, skippedAt: null },
    { messageId: 'x', channelId: 'other', ts: NOW - 3 * MIN, answeredAt: null, skippedAt: null },
    { messageId: 'gone', channelId: 'src', ts: NOW - 8 * DAY, answeredAt: null, skippedAt: null },
  ];
  assert.deepEqual(pingsIn(ring, 'src', { now: NOW, maxAgeMs: 7 * DAY }).map((p) => p.messageId), ['a', 'b']);
  assert.deepEqual(pingsIn(ring, 'src', { now: NOW, maxAgeMs: 0 }).map((p) => p.messageId), ['gone', 'a', 'b'], 'no age limit');
  assert.deepEqual(pingsIn(undefined, 'src', { now: NOW, maxAgeMs: 7 * DAY }), []);
});

// ---- seen marks ---------------------------------------------------------------------

test('markSeen: never moves backwards and never mutates the stored map', () => {
  const seen = { src: NOW - 5 * MIN };
  const later = markSeen(seen, 'src', NOW - MIN);
  assert.deepEqual(seen, { src: NOW - 5 * MIN });
  assert.deepEqual(later, { src: NOW - MIN });
  assert.deepEqual(markSeen(later, 'src', NOW - 10 * MIN), { src: NOW - MIN });
  assert.deepEqual(markSeen(later, 'other', NOW), { src: NOW - MIN, other: NOW });
});

test('markSeen: a missing map starts empty, a garbage mark is replaced, a non-finite ts changes nothing', () => {
  assert.deepEqual(markSeen(undefined, 'src', NOW), { src: NOW });
  assert.deepEqual(markSeen({ src: 'yesterday' }, 'src', NOW), { src: NOW });
  assert.deepEqual(markSeen({ src: NOW - MIN }, 'src', Number.NaN), { src: NOW - MIN });
});

test('hasUnseen: only a last message newer than the mark is unseen', () => {
  assert.equal(hasUnseen(NOW, NOW - MIN), true);
  assert.equal(hasUnseen(NOW - MIN, NOW - MIN), false);
  assert.equal(hasUnseen(NOW - 2 * MIN, NOW - MIN), false);
  assert.equal(hasUnseen(NOW, undefined), true, 'no mark: nothing seen yet');
  assert.equal(hasUnseen(0, undefined), false, 'an empty channel has nothing to see');
});

// ---- the liveness of a noticed comment -----------------------------------------------------

const SPONTANEOUS = { liveMinMessages: 4, liveWindowMinutes: 15 };

test('chooseElsewhereMode: elsewhere when liveMinMessages members wrote after the mark inside the live window', () => {
  const messages = [msg('1', 9), msg('2', 7), msg('3', 4), msg('4', 1)];
  assert.equal(isSourceLive(messages, NOW, NOW - 10 * MIN, SPONTANEOUS), true);
  assert.equal(chooseElsewhereMode(messages, NOW, NOW - 10 * MIN, SPONTANEOUS), 'elsewhere');
  assert.equal(chooseElsewhereMode(messages, NOW, undefined, SPONTANEOUS), 'elsewhere', 'no mark: everything is new');
});

test('chooseElsewhereMode: one new member message is not enough', () => {
  const messages = [msg('1', 9), msg('2', 7), msg('3', 4), msg('4', 1)];
  assert.equal(chooseElsewhereMode(messages, NOW, NOW - 2 * MIN, SPONTANEOUS), null);
  assert.equal(isSourceLive(messages, NOW, NOW - 2 * MIN, SPONTANEOUS), false);
});

test('chooseElsewhereMode: messages at or before the seen mark do not count', () => {
  const messages = [msg('1', 9), msg('2', 7), msg('3', 4), msg('4', 1)];
  assert.equal(chooseElsewhereMode(messages, NOW, NOW - 9 * MIN, SPONTANEOUS), null, 'the marked message itself is seen');
});

test('chooseElsewhereMode: messages older than the live window do not count', () => {
  const messages = [msg('1', 40), msg('2', 30), msg('3', 20), msg('4', 1)];
  assert.equal(chooseElsewhereMode(messages, NOW, undefined, SPONTANEOUS), null);
  assert.equal(chooseElsewhereMode(messages, NOW, undefined, { liveMinMessages: 4, liveWindowMinutes: 60 }), 'elsewhere');
});

test('chooseElsewhereMode: null for bots only or nothing new', () => {
  const one = { liveMinMessages: 1, liveWindowMinutes: 15 };
  const bots = [msg('1', 5, { bot: true }), msg('2', 4, { bot: true }), msg('3', 3, { self: true }), msg('4', 2, { bot: true })];
  assert.equal(chooseElsewhereMode(bots, NOW, undefined, one), null, 'bots and the persona are not members');
  assert.equal(chooseElsewhereMode([...bots, msg('5', 6)], NOW, NOW - 6 * MIN, one), null, 'the only member line is already seen');
  assert.equal(chooseElsewhereMode([...bots, msg('5', 1)], NOW, NOW - 6 * MIN, SPONTANEOUS), null, 'bots do not make up the count');
  assert.equal(chooseElsewhereMode([], NOW, undefined, one), null);
  assert.equal(chooseElsewhereMode(undefined, NOW, undefined, one), null);
});

test('chooseElsewhereMode: a member message exactly liveWindowMinutes old still counts', () => {
  const edge = [msg('1', 15), msg('2', 3), msg('3', 2), msg('4', 1)];
  assert.equal(chooseElsewhereMode(edge, NOW, undefined, SPONTANEOUS), 'elsewhere');
  const past = [{ ...msg('1', 15), ts: NOW - 15 * MIN - 1 }, msg('2', 3), msg('3', 2), msg('4', 1)];
  assert.equal(chooseElsewhereMode(past, NOW, undefined, SPONTANEOUS), null, 'one millisecond older is outside');
});

test('chooseElsewhereMode: with liveMinMessages 0 the seen mark still needs one new member message', () => {
  const zero = { liveMinMessages: 0, liveWindowMinutes: 15 };
  assert.equal(isSourceLive([], NOW, undefined, zero), true, 'the count alone passes, as chooseMode interjects');
  assert.equal(chooseElsewhereMode([], NOW, undefined, zero), null);
  assert.equal(chooseElsewhereMode([msg('1', 2, { bot: true })], NOW, undefined, zero), null);
  assert.equal(chooseElsewhereMode([msg('1', 2)], NOW, NOW - MIN, zero), null, 'the only member line is seen');
  assert.equal(chooseElsewhereMode([msg('1', 2)], NOW, undefined, zero), 'elsewhere');
  assert.equal(chooseElsewhereMode([msg('1', 40)], NOW, undefined, zero), 'elsewhere', 'no count needed, so no window either');
});

test('chooseElsewhereMode: on the eavesdrop path one new member message after the mark is enough', () => {
  const one = [msg('1', 40), msg('2', 1)];
  assert.equal(chooseElsewhereMode(one, NOW, NOW - 2 * MIN, SPONTANEOUS, { path: 'eavesdrop' }), 'elsewhere');
  assert.equal(chooseElsewhereMode([msg('1', 3)], NOW, undefined, SPONTANEOUS, { path: 'eavesdrop' }), 'elsewhere');
  assert.equal(chooseElsewhereMode(one, NOW, NOW, SPONTANEOUS, { path: 'eavesdrop' }), null, 'nothing after the mark');
  const bots = [msg('1', 2, { bot: true }), msg('2', 1, { self: true })];
  assert.equal(chooseElsewhereMode(bots, NOW, undefined, SPONTANEOUS, { path: 'eavesdrop' }), null, 'bots and the persona are not members');
  assert.equal(chooseElsewhereMode(undefined, NOW, undefined, SPONTANEOUS, { path: 'eavesdrop' }), null);
});

test('chooseElsewhereMode: on the tick path one new member message is not enough', () => {
  const one = [msg('1', 40), msg('2', 1)];
  assert.equal(chooseElsewhereMode(one, NOW, NOW - 2 * MIN, SPONTANEOUS, { path: 'tick' }), null);
  assert.equal(chooseElsewhereMode(one, NOW, NOW - 2 * MIN, SPONTANEOUS), null, 'no path reads as the tick path');
  assert.equal(chooseElsewhereMode(one, NOW, NOW - 2 * MIN, SPONTANEOUS, { path: 'room' }), null, 'an unknown path reads as the tick path');
});

// ---- one liveness count with the writable channels' chooser --------------------------------

test('liveMemberCount: members inside the window and after the mark, the window edge included', () => {
  const messages = [msg('1', 20), msg('2', 15), msg('3', 9), msg('4', 5, { bot: true }), msg('5', 3, { self: true }), msg('6', 1), null];
  assert.equal(liveMemberCount(messages, { now: NOW, windowMinutes: 15 }), 3);
  assert.equal(liveMemberCount(messages, { now: NOW, windowMinutes: 15, sinceTs: NOW - 9 * MIN }), 1, 'the marked message itself is seen');
  assert.equal(liveMemberCount(messages, { now: NOW, windowMinutes: 15, sinceTs: null }), 3);
  assert.equal(liveMemberCount(messages, { now: NOW, windowMinutes: 0 }), 0, 'a window of 0 holds only messages written at now');
  assert.equal(liveMemberCount([msg('7', 0)], { now: NOW, windowMinutes: 0 }), 1);
  assert.equal(liveMemberCount(messages, { now: NOW, windowMinutes: 'soon' }), 0, 'a garbage window counts nothing');
  assert.equal(liveMemberCount(undefined, { now: NOW, windowMinutes: 15 }), 0);
});

test('isSourceLive: reads liveMinMessages and liveWindowMinutes as chooseMode does', () => {
  const messages = [msg('1', 9), msg('2', 7), msg('3', 4), msg('4', 1)];
  assert.equal(isSourceLive(messages, NOW, undefined, { liveMinMessages: 4, liveWindowMinutes: 0 }), false, 'a window of 0 is not replaced by the default');
  assert.equal(isSourceLive(messages.slice(0, 2), NOW, undefined, { liveMinMessages: 2.5, liveWindowMinutes: 15 }), false, '2.5 needs three');
  assert.equal(isSourceLive(messages.slice(0, 3), NOW, undefined, { liveMinMessages: 2.5, liveWindowMinutes: 15 }), true);
  assert.equal(isSourceLive([], NOW, undefined, { liveMinMessages: 0, liveWindowMinutes: 15 }), true);
});

test('isSourceLive: with no seen mark it agrees with chooseMode on every live-or-not case', () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const configs = [
    { liveMinMessages: 4, liveWindowMinutes: 15 },
    { liveMinMessages: 1, liveWindowMinutes: 5 },
    { liveMinMessages: 0, liveWindowMinutes: 15 },
    { liveMinMessages: 2.5, liveWindowMinutes: 10 },
    { liveMinMessages: 3, liveWindowMinutes: 0 },
  ];
  let compared = 0;
  for (let round = 0; round < 400; round += 1) {
    const length = 1 + Math.floor(rand() * 8);
    const history = Array.from({ length }, (_, i) => ({
      ...msg(String(i), Math.floor(rand() * 30)),
      self: rand() < 0.15,
      bot: rand() < 0.15,
    })).sort((a, b) => a.ts - b.ts);
    if (history[history.length - 1].self) continue; // chooseMode never interjects on its own line
    for (const live of configs) {
      const cfg = { ...live, deadAfterMinutes: Infinity, initiateChance: 0 };
      assert.equal(isSourceLive(history, NOW, undefined, live), chooseMode(history, NOW, cfg, () => 1) === 'interject');
      compared += 1;
    }
  }
  assert.ok(compared > 1000);
});

test('mayBeLive: a fresh unseen last message may be live, a quiet or seen one cannot', () => {
  assert.equal(mayBeLive(NOW - MIN, NOW, NOW - 10 * MIN, SPONTANEOUS), true);
  assert.equal(mayBeLive(NOW - 15 * MIN, NOW, undefined, SPONTANEOUS), true, 'the window edge is inside');
  assert.equal(mayBeLive(NOW - 20 * MIN, NOW, undefined, SPONTANEOUS), false, 'a diary entry gone quiet past the window');
  assert.equal(mayBeLive(NOW - MIN, NOW, NOW - MIN, SPONTANEOUS), false, 'nothing unseen');
  assert.equal(mayBeLive(0, NOW, undefined, SPONTANEOUS), false, 'an empty channel');
  assert.equal(mayBeLive(NOW - 20 * MIN, NOW, undefined, { liveMinMessages: 0, liveWindowMinutes: 15 }), true, 'no count needed, no window');
});

test('mayBeLive: holds whenever the tick path chooser says elsewhere', () => {
  const configs = [SPONTANEOUS, { liveMinMessages: 1, liveWindowMinutes: 5 }, { liveMinMessages: 0, liveWindowMinutes: 15 }];
  const marks = [undefined, NOW - 30 * MIN, NOW - 8 * MIN, NOW - 2 * MIN];
  const lists = [
    [msg('1', 9), msg('2', 7), msg('3', 4), msg('4', 1)],
    [msg('1', 40), msg('2', 30), msg('3', 1, { bot: true })],
    [msg('1', 6), msg('2', 5), msg('3', 4), msg('4', 3), msg('5', 2, { bot: true })],
    [msg('1', 25)],
  ];
  let checked = 0;
  for (const cfg of configs) {
    for (const seenTs of marks) {
      for (const messages of lists) {
        const lastTs = Math.max(...messages.map((m) => m.ts));
        if (chooseElsewhereMode(messages, NOW, seenTs, cfg) === 'elsewhere') {
          assert.equal(mayBeLive(lastTs, NOW, seenTs, cfg), true);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked >= 5);
});

// ---- the audience rail (no shortcut for @everyone, role overwrites combined) -----------------

test('audienceCovers: a source every destination viewer can view is covered', () => {
  const dest = audience({ everyone: false, roles: ['r1', 'r2'] });
  const source = audience({ everyone: true, roles: ['guild', 'r1', 'r2', 'r3'] });
  assert.equal(audienceCovers(dest, source), true);
  const wide = audience({ everyone: true, roles: ['guild', 'r1', 'r2'] });
  assert.equal(audienceCovers(wide, audience({ everyone: true, roles: ['guild', 'r1', 'r2'] })), true);
});

test('audienceCovers: a role denied on an everyone-visible source blocks', () => {
  const dest = audience({ everyone: true, roles: ['guild', 'members', 'muted'] });
  const source = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['muted'] });
  assert.equal(audienceCovers(dest, source), false);
});

test('audienceCovers: a member holding a role denied on the source and another role that views a members-only destination blocks', () => {
  // D: @everyone denied, 'verified' allowed. S: no @everyone overwrite, 'jail' denied. A member with verified and
  // jail sees D (role allows come after role denies) and not S; each role on its own passes the per-role check.
  const dest = audience({ everyone: false, roles: ['verified', 'admin'], roleAllow: ['verified'] });
  const source = audience({ everyone: true, roles: ['guild', 'verified', 'admin'], roleDeny: ['jail'] });
  assert.equal(audienceCovers(dest, source), false);
});

test('audienceCovers: a role denied on the source passes when every destination role is allowed there', () => {
  const dest = audience({ everyone: false, roles: ['verified', 'staff'], roleAllow: ['verified', 'staff'] });
  const source = audience({ everyone: true, roles: ['guild', 'verified', 'staff'], roleAllow: ['verified', 'staff'], roleDeny: ['jail'] });
  assert.equal(audienceCovers(dest, source), true);
  const wide = audience({ everyone: true, roles: ['guild', 'verified', 'staff'] });
  assert.equal(audienceCovers(wide, source), false, 'an everyone-visible destination is reached without any role');
  const everyoneListed = audience({ everyone: true, roles: ['guild', 'verified', 'staff'], roleAllow: ['guild', 'verified', 'staff'], roleDeny: ['jail'] });
  assert.equal(audienceCovers(wide, everyoneListed), false, "@everyone's allow comes before role denies, even if a reader lists it as a role allow");
});

test('audienceCovers: a role denied on both channels passes, unless the destination lets it back in', () => {
  const source = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'] });
  assert.equal(audienceCovers(audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'] }), source), true);
  const letsBack = audience({ everyone: true, roles: ['guild', 'members', 'staff'], roleAllow: ['staff'], roleDeny: ['jail'] });
  const sourceWithStaff = audience({ everyone: true, roles: ['guild', 'members', 'staff'], roleDeny: ['jail'] });
  assert.equal(audienceCovers(letsBack, sourceWithStaff), false, 'jail plus staff sees the destination only');
  const repeats = audience({ everyone: true, roles: ['guild', 'members', 'staff'], roleAllow: ['staff'], roleDeny: ['jail'] });
  assert.equal(audienceCovers(letsBack, repeats), true, 'the source repeats the allow');
});

// A model of Discord's ViewChannel computation, as discord.js GuildChannel
// memberPermissions / rolePermissions do it: base permissions of the held
// roles (Administrator sees everything), @everyone's overwrite, every held
// role's deny, every held role's allow, the member's own overwrite.
const ROLE_IDS = ['guild', 'a', 'b'];
const OVERWRITES = [null, 'allow', 'deny'];
const HOLDINGS = [[], ['a'], ['b'], ['a', 'b']];
const PEOPLE = ['m', 'x'];

function applyOverwrite(view, overwrite) {
  if (overwrite === 'deny') return false;
  if (overwrite === 'allow') return true;
  return view;
}

function roleViews(roles, channel, id) {
  if (roles[id].admin) return true;
  const view = applyOverwrite(roles[id].view || roles.guild.view, channel.roles.guild);
  return applyOverwrite(view, channel.roles[id]);
}

function memberViews(roles, channel, person, held) {
  if (held.some((id) => roles[id].admin)) return true;
  let view = applyOverwrite(roles.guild.view || held.some((id) => roles[id].view), channel.roles.guild);
  if (held.some((id) => channel.roles[id] === 'deny')) view = false;
  if (held.some((id) => channel.roles[id] === 'allow')) view = true;
  return applyOverwrite(view, channel.members[person]);
}

function modelAudience(roles, channel) {
  const overwritten = (value) => ROLE_IDS.filter((id) => id !== 'guild' && channel.roles[id] === value);
  const members = (value) => PEOPLE.filter((id) => channel.members[id] === value);
  return audience({
    everyone: roleViews(roles, channel, 'guild'),
    roles: ROLE_IDS.filter((id) => roleViews(roles, channel, id)),
    roleAllow: overwritten('allow'),
    roleDeny: overwritten('deny'),
    memberAllow: members('allow'),
    memberDeny: members('deny'),
  });
}

test('audienceCovers: never covers a pair where some member sees the destination and not the source', () => {
  const channels = [];
  for (const guild of OVERWRITES) for (const a of OVERWRITES) for (const b of OVERWRITES) for (const m of OVERWRITES) {
    channels.push({ roles: { guild, a, b }, members: { m } });
  }
  const roleSets = [];
  for (const guildView of [false, true]) for (const aBits of [0, 1, 2, 3]) for (const bBits of [0, 1, 2, 3]) {
    roleSets.push({
      guild: { view: guildView, admin: false },
      a: { view: (aBits & 1) === 1, admin: (aBits & 2) === 2 },
      b: { view: (bBits & 1) === 1, admin: (bBits & 2) === 2 },
    });
  }
  let covered = 0;
  let coveredWithRoleDeny = 0;
  for (const roles of roleSets) {
    const seen = channels.map((channel) => ({
      audience: modelAudience(roles, channel),
      views: PEOPLE.flatMap((person) => HOLDINGS.map((held) => memberViews(roles, channel, person, held))),
    }));
    for (const dest of seen) {
      for (const source of seen) {
        if (!audienceCovers(dest.audience, source.audience)) continue;
        covered += 1;
        if (source.audience.roleDeny.size > 0) coveredWithRoleDeny += 1;
        dest.views.forEach((view, i) => assert.ok(!view || source.views[i], 'a member sees the destination and not the source'));
      }
    }
    for (const same of seen) assert.equal(audienceCovers(same.audience, same.audience), true, 'the same overwrites always cover');
  }
  assert.ok(covered > 0 && coveredWithRoleDeny > 0, 'the rule still covers pairs, a role deny on the source included');
});

test('audienceCovers: a role that views the destination but not the source blocks', () => {
  const dest = audience({ roles: ['r1', 'r2'] });
  const source = audience({ roles: ['r1'] });
  assert.equal(audienceCovers(dest, source), false);
});

test('audienceCovers: a source hidden from everyone never covers an everyone-visible destination', () => {
  const dest = audience({ everyone: true, roles: ['r1'] });
  const source = audience({ everyone: false, roles: ['r1'] });
  assert.equal(audienceCovers(dest, source), false);
});

test('audienceCovers: a member allowed only on the destination blocks a source that may hide itself from that member', () => {
  const hidden = audience({ everyone: false, roles: ['r1'] });
  assert.equal(audienceCovers(audience({ roles: ['r1'], memberAllow: ['u1'] }), hidden), false);
  const allowedBoth = audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] });
  assert.equal(audienceCovers(audience({ roles: ['r1'], memberAllow: ['u1'] }), allowedBoth), true);
  const open = audience({ everyone: true, roles: ['guild', 'r1'] });
  assert.equal(
    audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'], memberAllow: ['u1'] }), open),
    true,
    'a source nothing hides from anyone needs no allow by name',
  );
});

test('audienceCovers: a member denied on the source blocks unless denied on the destination', () => {
  const source = audience({ everyone: true, roles: ['guild', 'r1'], memberDeny: ['u9'] });
  assert.equal(audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'] }), source), false);
  assert.equal(audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'], memberDeny: ['u9'] }), source), true);
});

// A large guild: 74 roles, @everyone's among them; the main channel denies one
// role and allows three members by name.
const GUILD_ROLE = 'guild';
const PLAIN_ROLES = Array.from({ length: 73 }, (_, i) => `role-${i + 1}`);
const ALL_ROLES = [GUILD_ROLE, ...PLAIN_ROLES];
const DENIED_ROLE = PLAIN_ROLES[40];
const ALL_BUT_DENIED = ALL_ROLES.filter((id) => id !== DENIED_ROLE);
const MAIN_MEMBERS = ['member-1', 'member-2', 'member-3'];
const LARGE_MAIN = audience({ everyone: true, roles: ALL_BUT_DENIED, roleDeny: [DENIED_ROLE], memberAllow: MAIN_MEMBERS });

test('audienceCovers: an open source covers a large main channel whose member allows it does not repeat', () => {
  const open = audience({ everyone: true, roles: ALL_ROLES });
  assert.equal(LARGE_MAIN.roles.size, 73);
  assert.equal(audienceCovers(LARGE_MAIN, open), true);
});

test('audienceCovers: a source with a role deny needs an allow there for every member a large main channel allows', () => {
  const source = audience({ everyone: true, roles: ALL_BUT_DENIED, roleDeny: [DENIED_ROLE], memberAllow: ['member-1'] });
  assert.equal(audienceCovers(LARGE_MAIN, source), false, 'member-2 and member-3 may hold the denied role');
  const repeats = audience({ everyone: true, roles: ALL_BUT_DENIED, roleDeny: [DENIED_ROLE], memberAllow: MAIN_MEMBERS });
  assert.equal(audienceCovers(LARGE_MAIN, repeats), true, 'the member step was the only one in the way');
});

test('audienceCovers: a source @everyone views with no role deny and no member deny covers any destination through the full check', () => {
  const open = audience({ everyone: true, roles: ['guild', 'r1', 'r2'], roleAllow: ['r2'], memberAllow: ['u7'] });
  const destinations = [
    audience({ everyone: true, roles: ['guild', 'r1', 'r2'], memberAllow: ['u1', 'u2'] }),
    audience({ everyone: false, roles: ['r1'], roleAllow: ['r1'], memberAllow: ['u1'], memberDeny: ['u2'] }),
    audience({ everyone: true, roles: ['guild', 'r2'], roleAllow: ['r2'], roleDeny: ['r1'], memberAllow: ['u3'] }),
    audience(),
  ];
  for (const [i, dest] of destinations.entries()) assert.equal(audienceCovers(dest, open), true, `destination ${i}`);
});

test('audienceCovers: the role step runs on a source @everyone views with nothing denied (no @everyone shortcut)', () => {
  // audienceOf never reads this shape (see the test above); the rail still compares the roles.
  const open = audience({ everyone: true, roles: ['guild', 'r1'] });
  assert.equal(audienceCovers(audience({ everyone: false, roles: ['r3'], roleAllow: ['r3'] }), open), false);
});

test('audienceCovers: a source that denies a member the destination allows blocks', () => {
  const source = audience({ everyone: true, roles: ['guild', 'r1'], memberDeny: ['u1'] });
  assert.equal(audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'], memberAllow: ['u1'] }), source), false);
  assert.equal(audienceCovers(audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] }), source), false);
  const allowsAndDenies = audience({ everyone: true, roles: ['guild', 'r1'], memberAllow: ['u2'], memberDeny: ['u1'] });
  assert.equal(audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'], memberAllow: ['u1'] }), allowsAndDenies), false);
});

test('audienceCovers: with a role deny on the source only an allow there proves a member the destination allows', () => {
  const source = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'] });
  const dest = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'], memberAllow: ['u1'] });
  assert.equal(audienceCovers(dest, source), false, 'u1 may hold jail: the allow by name beats it on the destination only');
  const allowed = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'], memberAllow: ['u1'] });
  assert.equal(audienceCovers(dest, allowed), true);
});

test('audienceCovers: a source @everyone cannot view needs an allow there for every member the destination allows', () => {
  const plain = audience({ everyone: false, roles: ['r1'] });
  assert.equal(audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'] }), plain), false, 'even with nothing denied on it');
  assert.equal(audienceCovers(audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] }), plain), false);
  const allowed = audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] });
  assert.equal(audienceCovers(audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] }), allowed), true);
});

test('audienceCovers: never covers a leaking pair when two members carry overwrites on both channels', () => {
  const channels = [];
  for (const guild of OVERWRITES) for (const a of OVERWRITES) for (const b of OVERWRITES) {
    for (const m of OVERWRITES) for (const x of OVERWRITES) channels.push({ roles: { guild, a, b }, members: { m, x } });
  }
  const roleSets = [];
  for (const guildView of [false, true]) for (const aView of [false, true]) for (const bView of [false, true]) {
    roleSets.push({ guild: { view: guildView, admin: false }, a: { view: aView, admin: false }, b: { view: bView, admin: false } });
  }
  let openSource = 0;
  let notDeniedByName = 0;
  for (const roles of roleSets) {
    const seen = channels.map((channel) => ({
      audience: modelAudience(roles, channel),
      views: PEOPLE.flatMap((person) => HOLDINGS.map((held) => memberViews(roles, channel, person, held))),
    }));
    for (const dest of seen) {
      for (const source of seen) {
        if (!audienceCovers(dest.audience, source.audience)) continue;
        dest.views.forEach((view, i) => assert.ok(!view || source.views[i], 'a member sees the destination and not the source'));
        const unrepeated = [...dest.audience.memberAllow].some((id) => !source.audience.memberAllow.has(id));
        if (!unrepeated) continue;
        if (source.audience.memberDeny.size === 0) openSource += 1;
        else notDeniedByName += 1;
      }
    }
  }
  assert.ok(openSource > 0 && notDeniedByName > 0, 'both ways past an allow by name the source does not repeat are reached');
});

test('audienceCovers: a missing or malformed audience never covers', () => {
  const ok = audience({ everyone: true, roles: ['guild'] });
  assert.equal(audienceCovers(null, ok), false);
  assert.equal(audienceCovers(ok, null), false);
  assert.equal(audienceCovers(ok, { ...ok, roles: ['guild'] }), false, 'roles not a set');
  assert.equal(audienceCovers({ everyone: true, roles: new Set(['guild']) }, ok), false);
  const noRoleDeny = { ...ok };
  delete noRoleDeny.roleDeny;
  assert.equal(audienceCovers(ok, noRoleDeny), false, 'a source without its role overwrites');
  assert.equal(audienceCovers({ ...ok, roleAllow: [] }, ok), false, 'roleAllow not a set');
  assert.equal(audienceCovers({ ...ok, everyone: 'yes' }, ok), false, 'everyone not a boolean');
});

// ---- the destination ---------------------------------------------------------------------

test('pickDestinationId: the first usable id, null when none', () => {
  const usable = new Set(['222', '333']);
  assert.equal(pickDestinationId(['111', 222, '333'], (id) => usable.has(id)), '222');
  assert.equal(pickDestinationId(['111'], (id) => usable.has(id)), null);
  assert.equal(pickDestinationId([], () => true), null);
  assert.equal(pickDestinationId(undefined, () => true), null);
  assert.equal(pickDestinationId('222', () => true), null, 'a non-array list is empty');
});

test('resolveDestination: features.elsewhere off is off, a missing switch reads as on', () => {
  const isUsable = (id) => id === '222';
  assert.deepEqual(resolveDestination({ features: { elsewhere: false }, memory: { mainChannelIds: ['222'] } }, isUsable), { destinationId: null, reason: 'off' });
  assert.deepEqual(resolveDestination({ memory: { mainChannelIds: ['111', '222'] } }, isUsable), { destinationId: '222', reason: null });
});

test('resolveDestination: inert without a usable memory.mainChannelIds entry', () => {
  assert.deepEqual(resolveDestination({ memory: { mainChannelIds: ['111'] } }, () => false), { destinationId: null, reason: 'no-destination' });
  assert.deepEqual(resolveDestination({}, () => true), { destinationId: null, reason: 'no-destination' });
});

// ---- the jump link -------------------------------------------------------------------------

test("messageLink: Discord's jump-link form", () => {
  assert.equal(messageLink('100', '200', '300'), 'https://discord.com/channels/100/200/300');
  assert.equal(messageLink(100, 200, 300), 'https://discord.com/channels/100/200/300');
  assert.equal(messageLink('100', '', '300'), null);
  assert.equal(messageLink(undefined, '200', '300'), null);
});

test('audienceCovers: a member-only destination is covered by an open source with a denied role when the members hold other roles', () => {
  const source = audience({ everyone: true, roles: ['guild', 'r1'], roleDeny: ['jail'] });
  const dest = (memberRoles) => audience({ everyone: false, roles: [], memberAllow: ['u1', 'u2'], memberRoles });
  assert.equal(audienceCovers(dest({ u1: ['r1'], u2: [] }), source), true, 'neither holds the denied role');
  assert.equal(audienceCovers(dest({ u1: ['r1'], u2: ['jail'] }), source), false, 'one holds the denied role');
  assert.equal(audienceCovers(dest({ u1: ['r1'] }), source), false, 'a member not cached is not proven');
  assert.equal(audienceCovers(dest(null), source), false, 'no roles at all: the old rule');
});

test('audienceCovers: a member proves his view through a role the source allows when it is closed to everyone', () => {
  const source = audience({ everyone: false, roles: ['staff'], roleAllow: ['staff'] });
  const dest = (held) => audience({ everyone: false, memberAllow: ['u1'], memberRoles: { u1: held } });
  assert.equal(audienceCovers(dest(['staff']), source), true);
  assert.equal(audienceCovers(dest(['other']), source), false);
});

test('audienceCovers: a member denied by name on the source is not proven by his roles', () => {
  const source = audience({ everyone: true, memberDeny: ['u1'] });
  const dest = audience({ everyone: false, memberAllow: ['u1'], memberRoles: { u1: ['r1'] } });
  assert.equal(audienceCovers(dest, source), false);
});
