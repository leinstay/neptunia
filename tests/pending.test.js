// Tests for src/behavior/pending.js: the pure queue of pending calls
// (see mention.oneAtATime in src/behavior/pipeline.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPending,
  authorCalls,
  foldInto,
  followUpSlot,
  isExpired,
  parseMergeAnswer,
  popOldest,
  requeuePending,
} from '../src/behavior/pending.js';

function ping(channelId, arrivedAt, overrides = {}) {
  return {
    channelId,
    channel: { id: channelId },
    trigger: { id: `m-${channelId}-${arrivedAt}`, authorId: 'u1' },
    kind: 'mention',
    arrivedAt,
    ...overrides,
  };
}

// --- addPending --------------------------------------------------------------

test('addPending: a newer call of the same channel waits beside the older one, in arrival order', () => {
  let list = addPending([], ping('c1', 100, { trigger: { id: 'call-1', authorId: 'u1' } }), 6).list;
  const { list: next, evicted } = addPending(list, ping('c1', 200, { trigger: { id: 'call-2', authorId: 'u1' } }), 6);
  assert.equal(evicted, null);
  assert.deepEqual(
    next.map((p) => p.trigger.id),
    ['call-1', 'call-2']
  );
  list = addPending(next, ping('c1', 200, { trigger: { id: 'call-3', authorId: 'u1' } }), 6).list;
  assert.deepEqual(
    list.map((p) => p.trigger.id),
    ['call-1', 'call-2', 'call-3'],
    'equal arrival times keep the order they came in'
  );
});

test('addPending: exceeding maxPending evicts the single OLDEST entry across all channels', () => {
  let list = [];
  ({ list } = addPending(list, ping('c1', 100), 2));
  ({ list } = addPending(list, ping('c2', 200), 2));
  const { list: after, evicted } = addPending(list, ping('c3', 300), 2);
  assert.equal(evicted.channelId, 'c1');
  assert.deepEqual(after.map((p) => p.channelId).sort(), ['c2', 'c3']);
});

test('addPending: calls of one channel count toward the cap like any others', () => {
  let list = [];
  ({ list } = addPending(list, ping('c1', 100), 2));
  ({ list } = addPending(list, ping('c1', 200), 2));
  const { list: after, evicted } = addPending(list, ping('c1', 300), 2);
  assert.equal(evicted.arrivedAt, 100, 'the oldest call goes');
  assert.deepEqual(
    after.map((p) => p.arrivedAt),
    [200, 300]
  );
});

test('pending: a routed ping keeps its source channel, its destination and what its settle grouped', () => {
  const main = { id: 'd1' };
  let list = addPending([], ping('d1', 100), 6).list;
  const routed = ping('s1', 200, { trigger: { id: 'call-1' }, destination: main, superseded: ['call-0'] });
  ({ list } = addPending(list, routed, 6));
  ({ list } = addPending(list, ping('s1', 300, { trigger: { id: 'call-2' }, destination: main }), 6));
  assert.deepEqual(
    list.map((p) => [p.channelId, p.trigger.id]),
    [
      ['d1', 'm-d1-100'],
      ['s1', 'call-1'],
      ['s1', 'call-2'],
    ],
    "no call takes another one's place"
  );
  assert.equal(list[1].destination, main);
  assert.equal(list[1].channel.id, 's1', 'the channel stays the source');
  assert.deepEqual(list[1].superseded, ['call-0']);
  assert.equal('superseded' in list[2], false, 'a newer arrival carries nothing it did not bring');

  const { list: back } = requeuePending([], { ...routed, decided: true }, 6);
  assert.equal(back[0].destination, main);
});

test("addPending: a routed ping past maxPending evicts the oldest entry of any channel, its destination's included", () => {
  let list = [];
  ({ list } = addPending(list, ping('d1', 100), 2));
  ({ list } = addPending(list, ping('c2', 200), 2));
  const { list: after, evicted } = addPending(list, ping('s1', 300, { destination: { id: 'd1' } }), 2);
  assert.equal(evicted.channelId, 'd1');
  assert.deepEqual(
    after.map((p) => p.channelId),
    ['c2', 's1']
  );
});

// --- isExpired -----------------------------------------------------------------

test('isExpired: false just under the window', () => {
  assert.equal(isExpired(ping('c1', 1000), 1000 + 10 * 60_000 - 1, 10), false);
});

test('isExpired: true once the window has fully elapsed', () => {
  assert.equal(isExpired(ping('c1', 1000), 1000 + 10 * 60_000, 10), true);
});

// --- popOldest -------------------------------------------------------------

test('popOldest: draining one at a time yields arrival order', () => {
  let list = [ping('c1', 300), ping('c2', 100), ping('c3', 200)];
  const order = [];
  while (list.length > 0) {
    const { ping: popped, list: rest } = popOldest(list);
    order.push(popped.channelId);
    list = rest;
  }
  assert.deepEqual(order, ['c2', 'c3', 'c1']);
});

// --- requeuePending ----------------------------------------------------------

test('requeuePending: a call put back waits in its arrival place, before newer calls of its channel', () => {
  const newer = ping('c1', 500, { trigger: { id: 'newer', authorId: 'u1' } });
  const back = ping('c1', 100, { trigger: { id: 'back', authorId: 'u1' } });
  const { list, evicted } = requeuePending([newer], back, 6);
  assert.equal(evicted, null);
  assert.deepEqual(
    list.map((p) => p.trigger.id),
    ['back', 'newer']
  );
  assert.equal(popOldest(list).ping.trigger.id, 'back');
});

test('requeuePending: put back with the same arrival time as later calls, it still goes first', () => {
  const later = ping('c1', 100, { trigger: { id: 'later', authorId: 'u1' } });
  const back = ping('c1', 100, { trigger: { id: 'back', authorId: 'u1' } });
  assert.deepEqual(
    requeuePending([later], back, 6).list.map((p) => p.trigger.id),
    ['back', 'later']
  );
});

test('requeuePending: mention.maxPending still applies -- the oldest entry overall is evicted', () => {
  const list0 = [ping('c2', 200), ping('c3', 300)];
  const { list, evicted } = requeuePending(list0, ping('c1', 100), 2);
  assert.equal(evicted.channelId, 'c1', 'the re-queued ping is the oldest, so it is the one evicted');
  assert.deepEqual(list.map((p) => p.channelId).sort(), ['c2', 'c3']);
});

test('requeuePending: keeps the extra fields carried on the ping', () => {
  const added = [{ id: 'f1', text: 'και;', ts: 150 }];
  const { list } = requeuePending([], ping('c1', 100, { decided: true, superseded: ['call-0'], added }), 6);
  assert.equal(list[0].decided, true);
  assert.deepEqual(list[0].superseded, ['call-0']);
  assert.deepEqual(list[0].added, added);
});

// --- the author's waiting calls and folding ------------------------------------

test("authorCalls: the author's own calls in that channel, in arrival order, never a routed one", () => {
  const list = [
    ping('c1', 300, { trigger: { id: 'b', authorId: 'u1' } }),
    ping('c1', 100, { trigger: { id: 'a', authorId: 'u1' } }),
    ping('c1', 200, { trigger: { id: 'other', authorId: 'u2' } }),
    ping('c2', 150, { trigger: { id: 'elsewhere', authorId: 'u1' } }),
    ping('c1', 250, { trigger: { id: 'routed', authorId: 'u1' }, destination: { id: 'd1' } }),
  ];
  assert.deepEqual(
    authorCalls(list, 'c1', 'u1').map((p) => p.trigger.id),
    ['a', 'b']
  );
});

test("foldInto: the message joins the call's added list; a call no longer waiting folds nothing", () => {
  const call = ping('c1', 100, { trigger: { id: 'call-1', authorId: 'u1' } });
  const first = { id: 'f1', text: 'και το δεύτερο;', ts: 200 };
  const second = { id: 'f2', text: 'λοιπόν;', ts: 300 };
  let { list, folded } = foldInto([call], 'call-1', first);
  assert.equal(folded, true);
  ({ list } = foldInto(list, 'call-1', second));
  assert.deepEqual(list[0].added, [first, second]);
  assert.equal('added' in call, false, 'the queued entry is not mutated');
  const gone = foldInto(list, 'call-9', first);
  assert.equal(gone.folded, false);
  assert.equal(gone.list, list);
});

test('parseMergeAnswer: a number of a waiting item, or new; anything else means new', () => {
  assert.deepEqual(parseMergeAnswer('2', 3), { index: 2, reason: 'item' });
  assert.deepEqual(parseMergeAnswer(' 1.\n', 3), { index: 1, reason: 'item' });
  assert.deepEqual(parseMergeAnswer('New', 3), { index: null, reason: 'new' });
  assert.deepEqual(parseMergeAnswer('', 3), { index: null, reason: 'empty' });
  assert.deepEqual(parseMergeAnswer('4', 3), { index: null, reason: 'out-of-range' });
  assert.deepEqual(parseMergeAnswer('0', 3), { index: null, reason: 'out-of-range' });
  for (const text of ['#2', 'item 2', '2\nnew', 'yes'])
    assert.deepEqual(parseMergeAnswer(text, 3), { index: null, reason: 'unparsed' }, text);
});

// --- followUpSlot ------------------------------------------------------------

/** A deferred follow-up (`followUp`) or overheard line waiting in `channelId`. */
function slotEntry(channelId, kind, id) {
  return ping(channelId, 100, { kind, trigger: { id, authorId: 'u1' } });
}

test('followUpSlot: an empty slot admits any newcomer and replaces nothing', () => {
  const list = [ping('c1', 50)];
  for (const kind of ['followUp', 'overheard', 'mention', 'reply', 'name', 'private']) {
    assert.deepEqual(followUpSlot(list, 'c1', kind), { admit: true, replaced: null }, kind);
  }
});

test('followUpSlot: a waiting followUp is replaced by a later followUp, never by a later overheard', () => {
  const waiting = slotEntry('c1', 'followUp', 'f1');
  const list = [waiting];
  assert.deepEqual(followUpSlot(list, 'c1', 'followUp'), { admit: true, replaced: waiting });
  assert.deepEqual(followUpSlot(list, 'c1', 'overheard'), { admit: false, replaced: null }, 'outranked');
});

test('followUpSlot: a waiting followUp stays beside a direct call of its channel, as before', () => {
  const list = [slotEntry('c1', 'followUp', 'f1')];
  for (const kind of ['mention', 'reply', 'name', 'private']) {
    assert.deepEqual(followUpSlot(list, 'c1', kind), { admit: true, replaced: null }, kind);
  }
});

test('followUpSlot: a waiting overheard is replaced by a later followUp, overheard, mention, reply or name', () => {
  const waiting = slotEntry('c1', 'overheard', 'o1');
  const list = [ping('c1', 50), waiting];
  for (const kind of ['followUp', 'overheard', 'mention', 'reply', 'name']) {
    assert.deepEqual(followUpSlot(list, 'c1', kind), { admit: true, replaced: waiting }, kind);
  }
  assert.deepEqual(
    followUpSlot(list, 'c1', 'private'),
    { admit: true, replaced: null },
    'a private message has no channel slot'
  );
});

test("followUpSlot: only the slot of the newcomer's own channel counts", () => {
  const list = [slotEntry('c2', 'followUp', 'f2'), slotEntry('c3', 'overheard', 'o3')];
  assert.deepEqual(followUpSlot(list, 'c1', 'overheard'), { admit: true, replaced: null });
  assert.deepEqual(followUpSlot(list, 'c1', 'mention'), { admit: true, replaced: null });
});
