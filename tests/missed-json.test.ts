// Tests for the missed-answer check's strict JSON answer (src/behavior/missed.ts, the sweep's analyzer call read by
// parseMissedAnswer): the request hands the client MISSED_FORMAT as `responseFormat`, an object
// `{ "verdicts": [{ "n": number, "verdict": one of MISSED_VERDICTS }] }` gives the verdicts the `n: word` lines gave (a
// candidate with no verdict, or with two different ones, is `uncertain`), every other answer, the old lines included,
// is an unreadable answer that leaves every candidate `uncertain`, and a blank answer leaves every one `unchecked`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMissed, MISSED_FORMAT, MISSED_VERDICTS, parseMissedAnswer, UNCHECKED } from '../src/behavior/missed.ts';
import { labels } from './fixtures/labels.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface, world } from './fixtures/turn-world.ts';

// The conversations are held by a fake interface named `fake`.
useIface('fake');

const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);

/** A normalized member line of #c1, as a fact carries it. */
function memberLine(id: string, ts: number) {
  return {
    id,
    placeId: 'c1',
    authorId: `u-${id}`,
    authorName: `Member ${id}`,
    self: false,
    bot: false,
    content: 'και λοιπόν;',
    ts,
    replyToId: null,
    mentionedAccountIds: [],
  };
}

type MemberLine = ReturnType<typeof memberLine>;
type SeedEvent = ReturnType<typeof world>['port']['seedEvent'];

/** The `message.received` event of a line, as the interface delivers it. */
function eventOf(line: MemberLine): Parameters<SeedEvent>[0] {
  return {
    kind: 'message.received',
    iface: 'fake',
    at: line.ts,
    id: `fake:message:${line.id}`,
    conversation: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'c1' },
    message: {
      id: line.id,
      author: { id: line.authorId, name: line.authorName, self: false, bot: false },
      content: line.content,
      sourceText: line.content,
      system: false,
      at: line.ts,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedConversationIds: [] },
  };
}

type Sent = { options: { responseFormat?: unknown; purpose?: unknown } };

/**
 * Three candidates of #c1 (`m1`, `m2`, `m3`, numbered 1 to 3 in the request), one sweep whose analyzer answers
 * `text`. Resolves each candidate's verdict, in order, and the request options.
 */
async function sweep(text: string) {
  const lines = [memberLine('m1', T0), memberLine('m2', T0 + 1000), memberLine('m3', T0 + 2000)];
  world().channel({ id: 'c1', placeId: 'g1' });
  for (const line of lines) world().port.seedEvent(eventOf(line));
  const sent: Array<Sent> = [];
  const quiet = { info() {}, warn() {}, error() {} };
  const missed = createMissed({
    hot: {
      config: { bot: { timezone: 'UTC' }, missed: {}, models: {}, llm: {} },
      prompts: { missed: 'Check for {{name}}.', labels },
    },
    store: { state: { data: {} } },
    llm: {
      complete: (_messages: unknown, options: Sent['options']) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    turns: {
      triggerOf: () => null,
      lastPostAt: () => 0,
      isBusy: () => true,
      isAnyBusy: () => true,
      runTurn: () => Promise.resolve({ outcome: 'spoke' }),
    },
    reads: world().reads,
    getSelfName: () => 'Nova',
    dataDir: tempDir('nep-missed-json-'),
    now: () => T0 + 60_000,
    timers: { set: () => null, clear() {} },
    log: quiet,
  });
  for (const line of lines) missed.noteFact({ reason: 'gate-failed', message: line, iface: 'fake' });
  await missed.sweep('fake', 'c1');
  const byId = new Map(missed.candidates().map((candidate) => [candidate.messageId, candidate.verdict]));
  return { verdicts: lines.map((line) => byId.get(line.id) ?? null), sent };
}

/** Answers that are not the object, or whose `verdicts` is not a list: each leaves every candidate uncertain. */
const UNREADABLE = [
  '1: owed\n2: stale\n3: resolved',
  '1. owed',
  'owed',
  'All three are owed.',
  '{}',
  '{"verdict":[{"n":1,"verdict":"owed"}]}',
  '{"verdicts":"owed"}',
  '{"verdicts":null}',
  '{"verdicts":{"n":1,"verdict":"owed"}}',
  '[{"n":1,"verdict":"owed"}]',
  '"owed"',
  'null',
  '{"verdicts":[{"n":1,"verdict":"owed"}]',
  '```json\n{"verdicts":[{"n":1,"verdict":"owed"}]}\n```',
];

const ALL_UNCERTAIN = ['uncertain', 'uncertain', 'uncertain'];

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, Schema & { items?: Schema; enum?: Array<string> }>;
};

test('the missed check hands the client MISSED_FORMAT as its responseFormat', async () => {
  const { sent } = await sweep('{"verdicts":[]}');
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.options.purpose, 'missed');
  assert.deepEqual(request.options.responseFormat, MISSED_FORMAT);
});

test('MISSED_FORMAT is a closed object holding a list of closed entries of a number and one of the five verdicts', () => {
  assert.match(MISSED_FORMAT.name, /^[A-Za-z0-9_-]{1,64}$/);
  const schema = MISSED_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['verdicts']);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['verdicts']);
  const list = schema.properties?.verdicts;
  assert.equal(list?.type, 'array');
  const entry = list?.items;
  assert.equal(entry?.type, 'object');
  assert.equal(entry?.additionalProperties, false);
  assert.deepEqual([...(entry?.required ?? [])].sort(), ['n', 'verdict']);
  const fields = entry?.properties;
  assert.equal(fields?.n?.type, 'integer');
  assert.deepEqual([...(fields?.verdict?.enum ?? [])].sort(), [...MISSED_VERDICTS].sort());
});

test('a well-formed answer gives each candidate the verdict of its number, in any order', async () => {
  const answer = {
    verdicts: [
      { n: 3, verdict: 'stale' },
      { n: 1, verdict: 'owed' },
      { n: 2, verdict: 'intentional-skip' },
    ],
  };
  const { verdicts } = await sweep(JSON.stringify(answer));
  assert.deepEqual(verdicts, ['owed', 'intentional-skip', 'stale']);
});

test('a candidate no entry names is uncertain, the others keep theirs', async () => {
  const { verdicts } = await sweep(JSON.stringify({ verdicts: [{ n: 2, verdict: 'resolved' }] }));
  assert.deepEqual(verdicts, ['uncertain', 'resolved', 'uncertain']);
});

test('an unreadable answer, the old lines included, leaves every candidate uncertain', async () => {
  for (const text of UNREADABLE) {
    const { verdicts } = await sweep(text);
    assert.deepEqual(verdicts, ALL_UNCERTAIN, JSON.stringify(text));
  }
});

test('a blank answer leaves every candidate unchecked', async () => {
  const { verdicts } = await sweep('  ');
  assert.deepEqual(verdicts, [UNCHECKED, UNCHECKED, UNCHECKED]);
});

test('parseMissedAnswer reads one verdict per number of the object text', () => {
  const answer = JSON.stringify({
    verdicts: [
      { n: 2, verdict: 'resolved' },
      { n: 1, verdict: 'owed' },
      { n: 4, verdict: 'stale' },
      { n: 3, verdict: 'uncertain' },
    ],
  });
  assert.deepEqual(parseMissedAnswer(answer, 4), {
    verdicts: ['owed', 'resolved', 'uncertain', 'stale'],
    empty: false,
  });
});

test('parseMissedAnswer makes a candidate named twice with different verdicts uncertain, twice alike keeps it', () => {
  const answer = JSON.stringify({
    verdicts: [
      { n: 1, verdict: 'owed' },
      { n: 1, verdict: 'stale' },
      { n: 2, verdict: 'resolved' },
      { n: 2, verdict: 'resolved' },
    ],
  });
  assert.deepEqual(parseMissedAnswer(answer, 2).verdicts, ['uncertain', 'resolved']);
});

test('parseMissedAnswer skips an entry with a number outside the candidates or a verdict outside the five', () => {
  const answer = JSON.stringify({
    verdicts: [
      { n: 1, verdict: 'owed' },
      { n: 2, verdict: 'maybe' },
      { n: 9, verdict: 'stale' },
      { n: 0, verdict: 'stale' },
      { n: 3, verdict: 'OWED' },
    ],
  });
  assert.deepEqual(parseMissedAnswer(answer, 3).verdicts, ['owed', 'uncertain', 'uncertain']);
});

test('parseMissedAnswer skips an entry of the wrong shape and keeps the others', () => {
  const answer = JSON.stringify({
    verdicts: [
      { n: '1', verdict: 'owed' },
      { n: 2 },
      { n: 1.5, verdict: 'stale' },
      null,
      'owed',
      { n: 3, verdict: 'resolved' },
    ],
  });
  assert.deepEqual(parseMissedAnswer(answer, 3).verdicts, ['uncertain', 'uncertain', 'resolved']);
});

test('parseMissedAnswer leaves every candidate uncertain for an unreadable answer and unchecked for no answer', () => {
  for (const text of UNREADABLE) {
    assert.deepEqual(parseMissedAnswer(text, 3), { verdicts: ALL_UNCERTAIN, empty: false }, JSON.stringify(text));
  }
  for (const text of ['', '   ', null, undefined]) {
    assert.deepEqual(
      parseMissedAnswer(text, 2),
      { verdicts: [UNCHECKED, UNCHECKED], empty: true },
      JSON.stringify(text)
    );
  }
});
