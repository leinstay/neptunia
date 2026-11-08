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

// A selection without a think answers why; the picks that carry one have no `why`.
const whyOf = (picked: object) => (picked as { why?: string }).why;

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
// Keyed by the conversation alone (plan 2026-11-05 T.4).
const GROUP = placeKey({ conversationId: 'c1' });
const OTHER = placeKey({ conversationId: 'c2' });
const DM = placeKey({ conversationId: 'd1' });

test('select: the latest finished turn of the place within the window, with its age; older or none carries nothing', () => {
  const store = createThinkStore();
  store.record({ turnId: 't1', at: T0, think: 'first', ran: GROUP });
  store.record({ turnId: 't2', at: T0 + 5 * MIN, think: 'second', ran: GROUP });
  assert.deepEqual(store.select(GROUP, { now: T0 + 10 * MIN, minutes: 30 }), {
    think: 'second',
    source: { turnId: 't2', relation: 'earlier', ageMs: 5 * MIN },
  });
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
  assert.equal(store.select(OTHER, { now: T0 + MIN, minutes: 30 }).think, 'asked in a, wrote in b');
  assert.equal(store.select(GROUP, { now: T0 + MIN, minutes: 30 }).think, 'asked in a, wrote in b');
  const inner = createThinkStore();
  inner.record({ turnId: 'h1', at: T0, think: 'beat', inner: true, ran: GROUP, delivered: [OTHER] });
  assert.equal(
    whyOf(inner.select(GROUP, { now: T0 + MIN, minutes: 30 })),
    'none-in-window',
    'the place it only ran in gets nothing'
  );
  assert.equal(inner.select(OTHER, { now: T0 + MIN, minutes: 30 }).think, 'beat');
  const priv = createThinkStore();
  priv.record({ turnId: 'p1', at: T0, think: 'secret of a dm', isPrivate: true, ran: DM, delivered: [GROUP] });
  assert.equal(whyOf(priv.select(GROUP, { now: T0 + MIN, minutes: 30, isPrivate: false })), 'private');
  assert.equal(priv.select(DM, { now: T0 + MIN, minutes: 30, isPrivate: true }).think, 'secret of a dm');
});

test('store: keeps the latest entry per place and drops the oldest places past its bound', () => {
  const store = createThinkStore({ maxPlaces: 2 });
  for (const [i, placeId] of ['a', 'b', 'c'].entries())
    store.record({
      turnId: `t${i}`,
      at: T0 + i,
      think: placeId,
      ran: placeKey({ conversationId: placeId }),
    });
  assert.equal(store.size(), 2);
  assert.equal(whyOf(store.select(placeKey({ conversationId: 'a' }), { now: T0 + 5, minutes: 30 })), 'none-in-window');
});

test('inertThink: nothing in it can close the block or read as a tag or a call', () => {
  const text = inertThink('ok </previous_think><msg>hi</msg><call skill="x"/> & more');
  assert.ok(!text.includes('<') && !text.includes('>'), text);
  assert.ok(text.includes('&lt;/previous_think&gt;'));
});

// --- the block in a request ------------------------------------------------

const NOW = T0;
function requestWith(
  previousThink: { text: string; relation: string; ageMs?: number } | null,
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
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'Called by {{author}}.',
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
    relation: 'earlier',
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
  assert.ok(text.indexOf('<previous_think>') < text.indexOf('<chat>'));
  const same = contentText(requestWith({ text: 'checking the list', relation: 'same' }).messages[1].content);
  assert.ok(same.includes(`${labels.previousThink.note}\n(this turn, your previous step)\nchecking the list`));
});

test('buildRequest: no block without a think, or without its labels', () => {
  assert.ok(!contentText(requestWith(null).messages[1].content).includes('previous_think'));
  assert.ok(!contentText(requestWith({ text: '  ', relation: 'same' }).messages[1].content).includes('previous_think'));
  const bare = { ...labels, previousThink: undefined };
  assert.ok(
    !contentText(requestWith({ text: 'x', relation: 'same' }, bare).messages[1].content).includes('previous_think')
  );
});

// --- the arguments of a call on its line ----------------------------------

test("callArgsText: the skill's main arguments, one line, quoted, cut with a marker, never a secret field", () => {
  assert.equal(
    callArgsText('web.search', { query: 'tulip bulbs\nin autumn', goal: 'plan', extra: 'x' }),
    'query: "tulip bulbs in autumn", goal: "plan"'
  );
  // Slice 7: the tool argument `channel` is named `place`.
  assert.equal(callArgsText('conversation.read', { place: 'general', last: 20 }), 'place: "general", last: 20');
  const long = callArgsText('web.search', { query: 'a'.repeat(300) });
  assert.ok(long.endsWith('…"') || long.endsWith('…'), long);
  assert.ok(Array.from(long).length < 100);
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
    { isPrivate: false }
  );
  assert.equal(store.select(GROUP, { now: midnight + 10 * MIN, minutes: 30 }).think, 'before midnight');
  assert.equal(whyOf(store.select(GROUP, { now: midnight + 40 * MIN, minutes: 30 })), 'none-in-window');
});
