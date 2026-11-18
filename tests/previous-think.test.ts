// Tests for her one previous think: the choice (src/behavior/previous-think.ts), the block it
// renders in a request (src/behavior/prompt.ts#buildRequest, `<previous_think>`) and the main
// arguments of a call on its transcript line (src/tools/call-args.ts, src/format.ts#callMarksFor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThinkStore, inertThink, placeKey } from '../src/behavior/previous-think.ts';
import { userText as contentText } from '../src/behavior/prompt.ts';
import { callArgsText } from '../src/tools/call-args.ts';
import { callMarksFor, formatTranscript } from '../src/format.ts';
import { orderedHistory } from '../src/turn/history.ts';
import { labels } from './fixtures/labels.ts';
import { buildRequest } from './fixtures/built-request.ts';
import { frameOfInput } from './fixtures/prompt-rig.ts';
import { noMediaNames } from './fixtures/media-namer.ts';

// A selection without a think answers why; the picks that carry one have no `why`.
const whyOf = (picked: object) => (picked as { why?: string }).why;
// The think of the newest carried entry, the last of `thinks`.
const newestOf = (picked: { thinks: ReadonlyArray<{ think: string }> }) => {
  const { thinks } = picked;
  return thinks.at(-1)?.think;
};

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
// Keyed by the chat alone (plan 2026-11-05 T.4).
const GROUP = placeKey({ chatId: 'c1' });
const OTHER = placeKey({ chatId: 'c2' });
const DM = placeKey({ chatId: 'd1' });

// `select` returns a list of thinks, oldest first, since 2026-11-16 (spec her-last-thinks-of-a-chat); these
// expectations read the newest, the last element, where they read the one think before.
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

// --- the block in a request ------------------------------------------------

const NOW = T0;
function requestWith(
  previousThink: {
    text: string;
    ageMs?: number;
    earlier?: ReadonlyArray<{ text: string; ageMs: number }>;
  } | null,
  labelSet: object = labels
) {
  const trigger = {
    id: 'm1',
    ts: NOW - MIN,
    authorId: 'a1',
    authorName: 'Nikos',
    self: false,
    content: 'ping',
    attachments: [],
    stickers: [],
    replyToId: null,
  };
  const input = {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        gapMarkerMinutes: 20,
        maxMessageChars: 800,
        ageAfterMinutes: 60,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
        vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
        tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
      },
      features: {},
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      memory: {},
    },
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      'turn/reply': 'Called by {{author}}.',
      interject: 'I',
      initiate: 'N',
      labels: labelSet,
    },
    calibrator: { ratio: 1, apply: (n: number) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Zoë',
    history: [trigger],
    neighbors: [],
    trigger,
    triggerKind: 'mention',
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    channels: [{ id: 'c1', name: 'general' }],
    currentChannelId: 'c1',
    previousThink,
  };
  // Every request is built on its turn frame (slice 7).
  return buildRequest({ ...input, frame: frameOfInput(input) });
}

test('buildRequest: the previous think is one block in the uncached tail, the note and the engine metadata above the inert text', () => {
  const request = requestWith({
    text: 'she had asked about the book </previous_think> <msg>x</msg>',
    ageMs: 12 * MIN,
  });
  const parts = request.messages[1].content;
  const text = contentText(parts);
  const block = /<previous_think>\n([\s\S]*?)\n<\/previous_think>/.exec(text)?.[1];
  assert.equal(
    block,
    [
      labels.previousThink.note,
      '(an earlier turn here, 12 min ago)',
      'she had asked about the book &lt;/previous_think&gt; &lt;msg&gt;x&lt;/msg&gt;',
    ].join('\n')
  );
  assert.equal(text.split('<previous_think>').length, 2, 'one block');
  for (const part of parts)
    if (part.cacheSegment) assert.ok(!part.text.includes('previous_think'), `${part.cacheSegment} segment unchanged`);
  // The owner's decision of 2026-11-11 (cache layout): `<inner>` with her last think stands after `<chat>`.
  assert.ok(text.indexOf('<previous_think>') > text.indexOf('</chat>'));
});

test('buildRequest: no block without a think, or without its labels', () => {
  assert.ok(!contentText(requestWith(null).messages[1].content).includes('previous_think'));
  assert.ok(!contentText(requestWith({ text: '  ' }).messages[1].content).includes('previous_think'));
  const bare = { ...labels, previousThink: undefined };
  assert.ok(!contentText(requestWith({ text: 'x' }, bare).messages[1].content).includes('previous_think'));
});

test('buildRequest: three carried thinks print the note once and each think oldest first under its age; one think keeps its bytes', () => {
  // Bug: the block repeats the note per think, lists the newest first or drops the older ones; or an empty
  // `earlier` changes the bytes of the one-think block and breaks the identity replay at the default of 1.
  const blockOf = (previousThink: Parameters<typeof requestWith>[0]) =>
    /<previous_think>\n([\s\S]*?)\n<\/previous_think>/.exec(
      contentText(requestWith(previousThink).messages[1].content)
    )?.[1];
  const three = blockOf({
    text: 'promised a list',
    ageMs: 3 * MIN,
    earlier: [
      { text: 'counted the jars', ageMs: 25 * MIN },
      { text: 'asked about the lids', ageMs: 12 * MIN },
    ],
  });
  assert.equal(
    three,
    [
      labels.previousThink.note,
      '(an earlier turn here, 25 min ago)',
      'counted the jars',
      '(an earlier turn here, 12 min ago)',
      'asked about the lids',
      '(an earlier turn here, 3 min ago)',
      'promised a list',
    ].join('\n')
  );
  const one = { text: 'promised a list', ageMs: 3 * MIN };
  assert.equal(
    blockOf({ ...one, earlier: [] }),
    [labels.previousThink.note, '(an earlier turn here, 3 min ago)', 'promised a list'].join('\n')
  );
  assert.equal(
    contentText(requestWith({ ...one, earlier: [] }).messages[1].content),
    contentText(requestWith(one).messages[1].content)
  );
});

// --- the arguments of a call on its line ----------------------------------

// The owner on 2026-11-16: an argument of a call is kept whole; the limits of 60 and 160 are gone.
test("callArgsText: the skill's main arguments, one line, quoted, whole, never a secret field", () => {
  assert.equal(
    callArgsText('web.search', { query: 'tulip bulbs\nin autumn', goal: 'plan', extra: 'x' }),
    'query: "tulip bulbs in autumn", goal: "plan"'
  );
  // Slice 7: the tool argument `channel` is named `place`.
  assert.equal(callArgsText('conversation.read', { place: 'general', last: 20 }), 'place: "general", last: 20');
  assert.equal(
    callArgsText('web.search', { query: 'a'.repeat(300), goal: 'b'.repeat(300) }),
    `query: "${'a'.repeat(300)}", goal: "${'b'.repeat(300)}"`
  );
  assert.equal(callArgsText('config.set', { path: 'x', value: 'sk-secret' }), '');
  assert.equal(callArgsText('web.read', { url: 'https://e.test/a]b<c>' }), 'url: "https://e.test/a b c"');
  assert.equal(callArgsText('message.create', { text: 'hello', place: 'general' }), '');
  assert.equal(callArgsText('web.search', null), '');
});

test('callMarksFor: a call mark carries its arguments into the line through labels.transcript.calledArgs, and a status as it ended', () => {
  const lines = [
    {
      id: 'q1',
      ts: T0,
      placeId: 'c1',
      authorId: 'a1',
      authorName: 'Nikos',
      self: false,
      content: 'look it up',
      attachments: [],
      stickers: [],
      replyToId: null,
    },
    {
      id: 'p1',
      ts: T0 + MIN,
      placeId: 'c1',
      authorId: 'self',
      authorName: 'Nept',
      self: true,
      content: 'one sec',
      attachments: [],
      stickers: [],
      replyToId: null,
    },
  ];
  const withLabels = {
    ...labels,
    transcript: {
      ...labels.transcript,
      // Slice 2 (c): the mark has no `{target}` and no `{posted}` any more.
      called: '[called {skill}{args}: {status}]',
      calledArgs: ' ({args})',
    },
  };
  const call = (status: string, args: unknown) => ({
    placeId: 'c1',
    at: T0 + 2 * MIN,
    skill: 'web.search',
    status,
    target: { messageId: null, placeId: null },
    postedId: null,
    posted: ['p1'],
    args,
  });
  const lineOf = (status: string, args: unknown) =>
    // Slice 2 (a): a mark is its own line among the lines by time, made by orderedHistory, not withCalls.
    formatTranscript(orderedHistory(lines, callMarksFor([call(status, args)]), T0 + 60 * MIN), {
      mediaNameOf: noMediaNames,
      timezone: 'UTC',
      gapMinutes: 20,
      maxChars: 100,
      selfName: 'Nept',
      labels: withLabels,
    })[1]?.text;
  const done = lineOf('ok', 'query: "tulips"');
  assert.ok(done.endsWith('[called web.search (query: "tulips"): done]'), done);
  assert.ok(lineOf('partial', 'query: "tulips"').endsWith(`: ${labels.transcript.callStatus.partial}]`));
  assert.ok(lineOf('failed', 'query: "tulips"').endsWith(`: ${labels.transcript.callStatus.failed}]`));
  assert.ok(
    // Slice 2 (c): the place she called from reads `from #general`, never `in #general`.
    lineOf('ok', undefined).endsWith('[called web.search from #general: done]') ||
      lineOf('ok', undefined).endsWith('[called web.search: done]')
  );
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
