// Tests for src/behavior/previous-think.ts: the choice of the persona's previous thinks of a place, their store and
// its seed from the journal, and the inert text of a think.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThinkStore, inertThink, placeKey } from '../../../src/behavior/previous-think.ts';
import '../../../src/tools/operations/index.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import { NOW as TURN_CORE_TOOLS_NOW, coreTurn, requestText } from '../../fixtures/turn-harness.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { asRecord } from '../../fixtures/records.ts';

// A selection without a think answers why; the picks that carry one have no `why`.
const whyOf = (picked: object) => (picked as { why?: string }).why;
// The think of the newest carried entry, the last of `thinks`.
const newestOf = (picked: { thinks: ReadonlyArray<{ think: string }> }) => {
  const { thinks } = picked;
  return thinks.at(-1)?.think;
};

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
// Keyed by the chat alone.
const GROUP = placeKey({ chatId: 'c1' });
const OTHER = placeKey({ chatId: 'c2' });
const DM = placeKey({ chatId: 'd1' });

// `select` returns a list of thinks, oldest first, and these expectations read the newest, the last element.
test('select: the latest finished turn of the place within the window, with its age; older or none carries nothing', () => {
  const store = createThinkStore();
  store.record({ turnId: 't1', at: T0, think: 'first', ran: GROUP });
  store.record({ turnId: 't2', at: T0 + 5 * MIN, think: 'second', ran: GROUP });
  assert.deepEqual(store.select(GROUP, { now: T0 + 10 * MIN, minutes: 30 }).thinks, [
    { think: 'second', turnId: 't2', ageMs: 5 * MIN },
  ]);
  assert.equal(whyOf(store.select(GROUP, { now: T0 + 36 * MIN, minutes: 30 })), 'none-in-window');
  assert.equal(whyOf(store.select(OTHER, { now: T0 + 6 * MIN, minutes: 30 })), 'none-in-window');
});

test('select: a failed turn carries nothing and lets no older think through; a finished turn without a think does the same', () => {
  const store = createThinkStore();
  store.record({ turnId: 't1', at: T0, think: 'kept', ran: GROUP });
  store.record({ turnId: 't2', at: T0 + MIN, think: 'lost', failed: true, ran: GROUP });
  assert.equal(whyOf(store.select(GROUP, { now: T0 + 2 * MIN, minutes: 30 })), 'failed');
  store.record({ turnId: 't3', at: T0 + 3 * MIN, think: null, ran: GROUP });
  assert.equal(whyOf(store.select(GROUP, { now: T0 + 4 * MIN, minutes: 30 })), 'no-think');
});

test('select: a turn counts for each place it delivered into; an inner turn only for those and a private think never reaches a group place', () => {
  const store = createThinkStore();
  store.record({ turnId: 't1', at: T0, think: 'asked in a, wrote in b', ran: GROUP, delivered: [OTHER] });
  assert.equal(newestOf(store.select(OTHER, { now: T0 + MIN, minutes: 30 })), 'asked in a, wrote in b');
  assert.equal(newestOf(store.select(GROUP, { now: T0 + MIN, minutes: 30 })), 'asked in a, wrote in b');
  const inner = createThinkStore();
  inner.record({ turnId: 'h1', at: T0, think: 'beat', inner: true, ran: GROUP, delivered: [OTHER] });
  assert.equal(
    whyOf(inner.select(GROUP, { now: T0 + MIN, minutes: 30 })),
    'none-in-window',
    'the place it only ran in gets nothing'
  );
  assert.equal(newestOf(inner.select(OTHER, { now: T0 + MIN, minutes: 30 })), 'beat');
  const priv = createThinkStore();
  priv.record({ turnId: 'p1', at: T0, think: 'secret of a dm', isDm: true, ran: DM, delivered: [GROUP] });
  assert.equal(whyOf(priv.select(GROUP, { now: T0 + MIN, minutes: 30, isDm: false })), 'private');
  assert.equal(newestOf(priv.select(DM, { now: T0 + MIN, minutes: 30, isDm: true })), 'secret of a dm');
});

test('store: keeps the latest entry per place and drops the oldest places past its bound', () => {
  const store = createThinkStore({ maxPlaces: 2 });
  for (const [i, placeId] of ['a', 'b', 'c'].entries())
    store.record({
      turnId: `t${i}`,
      at: T0 + i,
      think: placeId,
      ran: placeKey({ chatId: placeId }),
    });
  assert.equal(store.size(), 2);
  assert.equal(whyOf(store.select(placeKey({ chatId: 'a' }), { now: T0 + 5, minutes: 30 })), 'none-in-window');
});

test('select: three finished turns of a place give three thinks oldest first with their ages, and count 1 the newest alone', () => {
  // Bug: the store keeps one entry per place, or select lists the newest first, drops the ages or ignores count.
  const store = createThinkStore();
  store.record({ turnId: 't1', at: T0, think: 'counted the jars', ran: GROUP });
  store.record({ turnId: 't2', at: T0 + 4 * MIN, think: 'asked about the lids', ran: GROUP });
  store.record({ turnId: 't3', at: T0 + 9 * MIN, think: 'promised a list', ran: GROUP });
  const now = T0 + 12 * MIN;
  assert.deepEqual(store.select(GROUP, { now, minutes: 30, count: 3 }).thinks, [
    { think: 'counted the jars', turnId: 't1', ageMs: 12 * MIN },
    { think: 'asked about the lids', turnId: 't2', ageMs: 8 * MIN },
    { think: 'promised a list', turnId: 't3', ageMs: 3 * MIN },
  ]);
  assert.deepEqual(store.select(GROUP, { now, minutes: 30, count: 1 }).thinks, [
    { think: 'promised a list', turnId: 't3', ageMs: 3 * MIN },
  ]);
});

test('select: a failed turn between two finished ones stops the walk, so count 3 gives the newest alone', () => {
  // Bug: the walk passes over a failed entry and carries a think from before the failure.
  const store = createThinkStore();
  store.record({ turnId: 't1', at: T0, think: 'before the failure', ran: GROUP });
  store.record({ turnId: 't2', at: T0 + 2 * MIN, think: 'the failed one', failed: true, ran: GROUP });
  store.record({ turnId: 't3', at: T0 + 4 * MIN, think: 'after the failure', ran: GROUP });
  assert.deepEqual(store.select(GROUP, { now: T0 + 5 * MIN, minutes: 30, count: 3 }).thinks, [
    { think: 'after the failure', turnId: 't3', ageMs: MIN },
  ]);
});

test('select: a private entry tied to a group place is passed over, and the group thinks on both sides of it are carried', () => {
  // Bug: a private think leaks into a group request among the listed thinks, or it ends the walk like a failure.
  const store = createThinkStore();
  store.record({ turnId: 't1', at: T0, think: 'group before', ran: GROUP });
  store.record({ turnId: 'p1', at: T0 + 2 * MIN, think: 'secret of a dm', isDm: true, ran: DM, delivered: [GROUP] });
  store.record({ turnId: 't3', at: T0 + 4 * MIN, think: 'group after', ran: GROUP });
  assert.deepEqual(store.select(GROUP, { now: T0 + 6 * MIN, minutes: 30, isDm: false, count: 3 }).thinks, [
    { think: 'group before', turnId: 't1', ageMs: 6 * MIN },
    { think: 'group after', turnId: 't3', ageMs: 2 * MIN },
  ]);
});

test('select: an entry older than the window is left out while a newer one of the place is carried', () => {
  // Bug: the window is checked on the newest entry only, so an old think rides along behind a fresh one.
  const store = createThinkStore();
  store.record({ turnId: 't1', at: T0, think: 'long ago', ran: GROUP });
  store.record({ turnId: 't2', at: T0 + 20 * MIN, think: 'just now', ran: GROUP });
  assert.deepEqual(store.select(GROUP, { now: T0 + 35 * MIN, minutes: 30, count: 3 }).thinks, [
    { think: 'just now', turnId: 't2', ageMs: 15 * MIN },
  ]);
});

test('inertThink: nothing in it can close the block or read as a tag or a call', () => {
  const text = inertThink('ok </previous_think><msg>hi</msg><call skill="x"/> & more');
  assert.ok(!text.includes('<') && !text.includes('>'), text);
  assert.ok(text.includes('&lt;/previous_think&gt;'));
});

test('seed: a think the journal holds from 20 minutes before midnight is carried 10 minutes after midnight and not 40', () => {
  // Bug: a restart forgets every think, so the first turn after it starts blind; or the seeded entry takes the
  // record's start, a later recording time or the restart's clock as its time and outlives its 30 minutes.
  const midnight = Date.UTC(2026, 10, 5, 0, 0, 0);
  const iso = (at: number) => new Date(at).toISOString();
  const store = createThinkStore();
  store.seed(
    [
      {
        v: 1,
        id: 'j-turn-eve',
        kind: 'turn',
        occurredAt: iso(midnight - 20 * MIN),
        recordedAt: iso(midnight - 20 * MIN),
        placeId: 'c1',
        scope: { channel: 'c1' },
        turnId: 't-eve',
        attemptId: 1,
        startedAt: iso(midnight - 21 * MIN),
        mode: 'reply',
        outcome: 'spoke',
        reason: null,
        think: 'before midnight',
        posted: [{ messageId: 'p-eve' }],
      },
    ],
    { isDm: false }
  );
  assert.equal(newestOf(store.select(GROUP, { now: midnight + 10 * MIN, minutes: 30 })), 'before midnight');
  assert.equal(whyOf(store.select(GROUP, { now: midnight + 40 * MIN, minutes: 30 })), 'none-in-window');
});

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const SECRET = 'xylophonewhisper';

const DM_JOURNAL_PRIVACY_DM = 'discord:dm:n1';

const DM_JOURNAL_PRIVACY_GROUP = 'discord:channel:room-1';

// ---- the previous think -----------------------------------------------------------------------------------------

test('a think from a DM is not carried into a group it delivered to', () => {
  // Bug: a private turn's think tied to the place it posted into follows the persona into that group's next turn.
  const thinks = createThinkStore();
  thinks.record({
    turnId: 't1',
    at: NOW,
    think: `the ${SECRET} thought`,
    isDm: true,
    ran: DM_JOURNAL_PRIVACY_DM,
    delivered: [DM_JOURNAL_PRIVACY_GROUP],
  });
  const carried = thinks.select(DM_JOURNAL_PRIVACY_GROUP, { now: NOW + 1000, minutes: 60, isDm: false });
  assert.equal(JSON.stringify(carried).includes(SECRET), false);
});

// --- the one previous think (src/behavior/previous-think.ts) ----------------

const thinkBlock = (text: string) => /<previous_think>\n([\s\S]*?)\n<\/previous_think>/.exec(text)?.[1] ?? null;

test("previous think, steps of one turn: no <previous_think> block in a step; the earlier think is in the persona's own answer, appended as it was written", async () => {
  const run = await coreTurn({
    answers: [
      toolAnswer('<think>why I look at the lore</think>', [call('lore.list')]),
      toolAnswer('', [call('memory.server.read')]),
      '<think>last</think><msg>τέλος</msg>',
    ],
  });
  const calls = run.llm.calls;
  assert.equal(calls.length, 3);
  for (const i of [0, 1, 2]) assert.equal(thinkBlock(requestText(run.llm, i)), null, `request ${i}`);
  const calls2 = run.llm.calls;
  const thirdItem = calls2[1][2];
  assert.equal(thirdItem.content, '<think>why I look at the lore</think>');
  const thirdItem2 = calls2[2][2];
  assert.equal(thirdItem2.content, '<think>why I look at the lore</think>', 'it stays in every later request');
});

const MIN_MS = 60_000;

// The fixture's context with the window this test sets (coreTurn's `config` replaces the whole key).
const withWindow = (minutes: number) => ({
  context: {
    channelMessages: 100,
    neighborMessages: 5,
    neighborMaxAgeMinutes: 60,
    neighborMaxChannels: 8,
    maxMessageChars: 800,
    gapMarkerMinutes: 20,
    otherProfiles: 6,
    caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
    vision: {
      maxImages: 2,
      tokensPerImage: 400,
      imageSize: 512,
      recentImages: 0,
      recentImageMinutes: 0,
      maxBytes: 1_500_000,
      fetchTimeoutMs: 10_000,
    },
    pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
    previousThink: { minutes },
  },
});

test('previous think, new turn: the latest finished turn of the place within the window carries its think with its age; past the window none', async () => {
  const clock = { t: TURN_CORE_TOOLS_NOW };
  const run = await coreTurn({
    answers: ['<think>she asked about the book</think><msg>ναι</msg>', '<msg>ξανά</msg>'],
    config: withWindow(30),
    runner: { now: () => clock.t },
  });
  clock.t = TURN_CORE_TOOLS_NOW + 10 * MIN_MS;
  await run.again();
  const carried = thinkBlock(requestText(run.llm, 1));
  assert.ok(carried?.includes('she asked about the book') && carried.includes('10 min ago'), carried ?? '');
  clock.t = TURN_CORE_TOOLS_NOW + 90 * MIN_MS;
  const { logs } = await withCapturedLogs(() => run.again());
  assert.equal(thinkBlock(requestText(run.llm, 2)), null);
  assert.ok(logs.some((entry) => entry.msg === 'turn: previous think' && entry.none === 'none-in-window'));
});

test('previous think, new turn: a turn that failed carries nothing and the older think does not come through it', async () => {
  const clock = { t: TURN_CORE_TOOLS_NOW };
  const script = ['<think>kept?</think><msg>ναι</msg>', 'FAIL', '<msg>ξανά</msg>'];
  let n = 0;
  const llm = {
    calls: [] as Array<Untyped>,
    complete: async (messages: Untyped) => {
      const content = messages[0].content;
      if (content.startsWith('Decide whether') || content.startsWith('Pick a second look'))
        return { text: 'none', usage: {}, estimated: 5 };
      llm.calls.push(messages);
      const answer = script[Math.min(n, script.length - 1)];
      n += 1;
      if (answer === 'FAIL') throw new Error('provider down');
      return { text: answer, usage: {}, estimated: 10 };
    },
  };
  const run = await coreTurn({ answers: ['<skip/>'], config: withWindow(30), runner: { now: () => clock.t, llm } });
  clock.t = TURN_CORE_TOOLS_NOW + MIN_MS;
  await withCapturedLogs(() => run.again());
  clock.t = TURN_CORE_TOOLS_NOW + 2 * MIN_MS;
  const { logs } = await withCapturedLogs(() => run.again());
  const last = llm.calls.at(-1);
  assert.equal(thinkBlock(userText(asRecord(last?.[1]).content)), null);
  assert.ok(
    logs.some((entry) => entry.msg === 'turn: previous think' && entry.none === 'failed'),
    JSON.stringify(logs.filter((entry) => entry.msg === 'turn: previous think'))
  );
});
