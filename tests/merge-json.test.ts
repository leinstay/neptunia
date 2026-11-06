// Tests for the merge classifier's strict JSON answer (src/pipeline/merge.ts, read by
// src/behavior/pending.ts#parseMergeAnswer): the request hands the client MERGE_FORMAT as `responseFormat`, an object
// `{ "item": number | null }` gives the decision the number or the word `new` gave (a number folds the call into that
// waiting item, null queues it as new, a number outside the items is `out-of-range` and queues it), and every other
// answer, the old number and word included, is an unreadable answer: the call is queued, logged `merge: failed`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMerge, MERGE_FORMAT } from '../src/pipeline/merge.ts';
import { parseMergeAnswer } from '../src/behavior/pending.ts';
import { createPendingQueue } from '../src/pipeline/pending-queue.ts';
import type { Line, PendingQueue, PipelineTurns } from '../src/pipeline/types.ts';
import { channelInfo } from './fixtures/core-over-fake.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const CHANNEL = channelInfo('c1');

function line(id: string): Line {
  return {
    id,
    placeId: CHANNEL.id,
    authorId: 'u2',
    authorName: 'Léa',
    content: `question ${id}`,
    ts: NOW,
    replyToId: null,
    mentionedAccountIds: [],
  };
}

type Sent = { options: { responseFormat?: unknown; purpose?: unknown } };

/**
 * Two calls of one author already waiting (`w1`, `w2`), then the call `incoming` held while the persona is busy, with
 * the merge model answering `text`. Resolves the trigger ids left in the queue, what each holds folded, the request
 * options and the merge log lines.
 */
async function hold(text: string) {
  const pending: PendingQueue = { list: [] };
  const sent: Array<Sent> = [];
  const turns: PipelineTurns = {
    isBusy: () => true,
    isAnyBusy: () => true,
    runTurn: () => Promise.resolve({ outcome: 'busy' }),
    notePost() {},
    waitingParts: () => [],
    addToPart: () => false,
  };
  const config = {
    bot: { timezone: 'UTC' },
    mention: { neverIgnore: [], repeatWindowMinutes: 0, maxPending: 10, followUpMaxOutputTokens: 20 },
    models: { base: { analyzer: 'small/analyzer' } },
    llm: { maxRequestTokens: 50000, maxRequestsPerDay: 100, timeoutMs: 1000 },
  };
  const hot = { config, prompts: { labels, merge: 'Choose an item or new for {{name}}.' } };
  const queue = createPendingQueue({ hot, now: () => NOW, turns, missed: null, pending, followUpMuted: () => null });
  const { holdCall } = createMerge({
    hot,
    now: () => NOW,
    turns,
    store: { state: { data: {} } },
    pending,
    llm: {
      complete: (_messages, options) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    getSelfName: () => 'Nova',
    itemText: queue.itemText,
    enqueuePending: queue.enqueuePending,
    turnBlocked: () => true,
    drainPending: () => Promise.resolve(),
  });
  queue.enqueuePending(CHANNEL, line('w1'), 'mention');
  queue.enqueuePending(CHANNEL, line('w2'), 'mention');
  const { logs } = await withCapturedLogs(async () => {
    holdCall(CHANNEL, line('incoming'), 'mention');
    for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  });
  return {
    queued: pending.list.map((ping) => ping.trigger.id),
    added: pending.list.map((ping) => (ping.added ?? []).map((message) => message.id)),
    sent,
    verdicts: logs.filter((entry) => entry.msg === 'merge: verdict').map((entry): unknown => entry.answer),
    failed: logs.filter((entry) => entry.msg === 'merge: failed').map((entry): unknown => entry.reason),
  };
}

/** Answers that are not the object, or whose `item` is neither a whole number nor null: each is unreadable. */
const UNREADABLE = [
  '1',
  '2.',
  'new',
  'New',
  'The message is about item 1.',
  '{}',
  '{"index":1}',
  '{"item":"1"}',
  '{"item":"new"}',
  '{"item":true}',
  '{"item":[1]}',
  '{"item":1.5}',
  '[1]',
  '"new"',
  'null',
  '{"item":1',
  '```json\n{"item":1}\n```',
];

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, { type?: unknown; anyOf?: Array<{ type?: unknown }> }>;
};

/** The JSON types a property admits, from its `type` (one or a list) or its `anyOf` branches. */
function typesOf(property: { type?: unknown; anyOf?: Array<{ type?: unknown }> } | undefined): Array<unknown> {
  const own: Array<unknown> = [property?.type, ...(property?.anyOf ?? []).map((branch) => branch.type)];
  return own
    .flat()
    .filter((type) => type !== undefined)
    .map(String)
    .sort();
}

test('the merge request hands the client MERGE_FORMAT as its responseFormat', async () => {
  const { sent } = await hold('{"item":null}');
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.options.purpose, 'merge');
  assert.deepEqual(request.options.responseFormat, MERGE_FORMAT);
});

test('MERGE_FORMAT is a closed object whose one required field item is a whole number or null', () => {
  assert.match(MERGE_FORMAT.name, /^[A-Za-z0-9_-]{1,64}$/);
  const schema = MERGE_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['item']);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['item']);
  assert.deepEqual(typesOf(schema.properties?.item), ['integer', 'null']);
});

test('a number of a waiting item folds the call into that item, logged as an item verdict', async () => {
  const first = await hold('{"item":1}');
  assert.deepEqual(first.queued, ['w1', 'w2']);
  assert.deepEqual(first.added, [['incoming'], []]);
  assert.deepEqual(first.verdicts, ['item']);
  assert.deepEqual(first.failed, []);
  const second = await hold('{"item":2}');
  assert.deepEqual(second.added, [[], ['incoming']]);
});

test('a null item queues the call as new, logged as a new verdict', async () => {
  const { queued, added, verdicts, failed } = await hold('{"item":null}');
  assert.deepEqual(queued, ['w1', 'w2', 'incoming']);
  assert.deepEqual(added, [[], [], []]);
  assert.deepEqual(verdicts, ['new']);
  assert.deepEqual(failed, []);
});

test('a number outside the waiting items queues the call as new, logged as out-of-range', async () => {
  for (const item of [0, 3, -1]) {
    const { queued, verdicts, failed } = await hold(JSON.stringify({ item }));
    assert.deepEqual(queued, ['w1', 'w2', 'incoming'], String(item));
    assert.deepEqual(verdicts, [], String(item));
    assert.deepEqual(failed, ['out-of-range'], String(item));
  }
});

test('an unreadable answer, the old number and word included, queues the call as new, logged as unparsed', async () => {
  for (const text of UNREADABLE) {
    const { queued, added, verdicts, failed } = await hold(text);
    const label = JSON.stringify(text);
    assert.deepEqual(queued, ['w1', 'w2', 'incoming'], label);
    assert.deepEqual(added, [[], [], []], label);
    assert.deepEqual(verdicts, [], label);
    assert.deepEqual(failed, ['unparsed'], label);
  }
});

test('a blank answer queues the call as new, logged as empty', async () => {
  const { queued, failed } = await hold('   ');
  assert.deepEqual(queued, ['w1', 'w2', 'incoming']);
  assert.deepEqual(failed, ['empty']);
});

test('parseMergeAnswer reads the item of the object text', () => {
  assert.deepEqual(parseMergeAnswer('{"item":2}', 3), { index: 2, reason: 'item' });
  assert.deepEqual(parseMergeAnswer(' {"item": 3}\n', 3), { index: 3, reason: 'item' });
  assert.deepEqual(parseMergeAnswer('{"item":null}', 3), { index: null, reason: 'new' });
});

test('parseMergeAnswer gives out-of-range for a whole number outside 1..count', () => {
  for (const item of [0, 4, -2]) {
    assert.deepEqual(
      parseMergeAnswer(JSON.stringify({ item }), 3),
      { index: null, reason: 'out-of-range' },
      String(item)
    );
  }
});

test('parseMergeAnswer gives unparsed for every unreadable answer and empty for no answer', () => {
  for (const text of UNREADABLE) {
    assert.deepEqual(parseMergeAnswer(text, 3), { index: null, reason: 'unparsed' }, JSON.stringify(text));
  }
  for (const text of ['', '   ', null, undefined]) {
    assert.deepEqual(parseMergeAnswer(text, 3), { index: null, reason: 'empty' }, JSON.stringify(text));
  }
});
