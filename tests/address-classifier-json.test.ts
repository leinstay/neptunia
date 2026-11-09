// Tests for the address classifier's strict JSON answer (src/pipeline/address-classifier.ts, read by
// src/behavior/mention.ts#parseAddressAnswer): the request hands the client ADDRESS_FORMAT as `responseFormat`, an
// object `{ "answer": "yes" | "overheard" | "no" }` gives the decision the bare word gave, and every other answer, the
// bare word included, is a failed call: the line passes only when flagged or within an active one-to-one exchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_FORMAT, createAddressClassifier } from '../src/pipeline/address-classifier.ts';
import type { AddressAnswer } from '../src/pipeline/address-classifier.ts';
import { parseAddressAnswer } from '../src/behavior/mention.ts';
import type { ClassifierRequest } from '../src/pipeline/classifier-request.ts';
import type { Conv, Line } from '../src/pipeline/types.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { chainsOf } from './fixtures/chains.ts';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

const SETTINGS = {
  models: { routes: chainsOf({ analyzer: 'small/analyzer' }) },
  llm: { analyzerTimeoutMs: 1000 },
  // The lead: the two settings `MentionConfig` requires, at values the classifier does not read, for the type check.
  mention: { followUpMaxOutputTokens: 20, neverIgnore: [], repeatWindowMinutes: 0 },
  bot: { timezone: 'UTC' },
};

const CHANNEL: Conv = {
  id: 'c1',
  kind: 'channel',
  rootId: 'g1',
  iface: 'test',
  permissions: { read: true, send: true, attach: true, react: true },
  owner: null,
  lastMessageAt: null,
  voice: false,
  public: true,
};

function line(fields: Partial<Line> & { id: string; authorId: string; ts: number }): Line {
  return { placeId: 'c1', replyToId: null, mentionedAccountIds: [], content: 'a line', ...fields };
}

const CANDIDATE = line({ id: 'm-candidate', authorId: 'u2', ts: NOW });

/** A one-to-one exchange: her line half a minute ago answered the candidate's author. */
const EXCHANGE = [
  line({ id: 'h1', authorId: 'u2', ts: NOW - 60_000 }),
  line({ id: 'h2', authorId: 'self', ts: NOW - 30_000, self: true, replyToId: 'h1' }),
];

type Fact = { reason?: string; failure?: string };
type Sent = { options: { responseFormat?: unknown } };

/** A classifier whose model answers `text`, with the facts it noted and the options of each request. */
function classifierAnswering(text: string, history: Array<Line> = []) {
  const facts: Array<Fact> = [];
  const sent: Array<Sent> = [];
  const request: ClassifierRequest = { system: 'system', user: 'user', history };
  const { classifyAddress } = createAddressClassifier({
    hot: { config: SETTINGS, prompts: null },
    llm: {
      complete: (_messages, options) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    now: () => NOW,
    getSelfName: () => 'Self',
    missed: {
      noteFact: (fact: Fact) => facts.push(fact),
      noteActivity: () => undefined,
      noteNotAddressed: () => undefined,
    },
    buildClassifierRequest: () => Promise.resolve(request),
  });
  return { classifyAddress, facts, sent };
}

/** One classification of CANDIDATE, its answer, the facts it noted, the request options and its fail-open line. */
async function classify(text: string, { flagged = false, history = [] as Array<Line> } = {}) {
  const { classifyAddress, facts, sent } = classifierAnswering(text, history);
  const { result, logs } = await withCapturedLogs(() =>
    classifyAddress(CHANNEL, CANDIDATE, { config: SETTINGS, flagged })
  );
  const failOpen = logs.find((entry) => entry.msg === 'follow-up: fail-open');
  return { answer: result, facts, sent, failOpen };
}

/** Answers that are not the object, or whose `answer` is outside the three words: each is a failed call. */
const UNREADABLE = [
  'yes',
  'overheard',
  'no',
  'Yes, the line is for her.',
  '{}',
  '{"verdict":"yes"}',
  '{"answer":"maybe"}',
  '{"answer":"YES"}',
  '{"answer":true}',
  '{"answer":null}',
  '{"answer":["yes"]}',
  '"yes"',
  '["yes"]',
  'null',
  '{"answer":"yes"',
  '```json\n{"answer":"yes"}\n```',
];

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, { enum?: Array<string> }>;
};

test('the address request hands the client ADDRESS_FORMAT as its responseFormat', async () => {
  const { sent } = await classify('{"answer":"yes"}');
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.deepEqual(request.options.responseFormat, ADDRESS_FORMAT);
});

test('ADDRESS_FORMAT is a closed object whose one required field answer is yes, overheard or no', () => {
  const schema = ADDRESS_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['answer']);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['answer']);
  const answer = schema.properties?.answer;
  assert.deepEqual([...(answer?.enum ?? [])].sort(), ['no', 'overheard', 'yes']);
});

test('a well-formed answer gives the decision of its word, with no failed call', async () => {
  for (const word of ['yes', 'overheard', 'no'] satisfies Array<AddressAnswer>) {
    const { answer, facts, failOpen } = await classify(JSON.stringify({ answer: word }));
    assert.equal(answer, word, word);
    assert.deepEqual(facts, [], `${word}: no missed-answer fact`);
    assert.equal(failOpen, undefined, `${word}: no fail-open`);
  }
});

test('a well-formed no on a flagged line is a no, as the bare word was', async () => {
  const { answer, facts } = await classify('{"answer":"no"}', { flagged: true });
  assert.equal(answer, 'no');
  assert.deepEqual(facts, []);
});

test('an unreadable answer, the bare word included, drops an unflagged line outside an exchange as a failed call', async () => {
  for (const text of UNREADABLE) {
    const { answer, facts, failOpen } = await classify(text);
    const label = JSON.stringify(text);
    assert.equal(answer, 'no', label);
    assert.equal(failOpen?.open, false, `${label}: fail-open logged, closed`);
    assert.equal(failOpen?.reason, 'unparsed', label);
    assert.deepEqual(
      facts.map((fact) => [fact.reason, fact.failure]),
      [['gate-failed', 'unparsed']],
      label
    );
  }
});

test('an unreadable answer lets a flagged line through as a failed call does', async () => {
  for (const text of UNREADABLE) {
    const { answer, facts, failOpen } = await classify(text, { flagged: true });
    const label = JSON.stringify(text);
    assert.equal(answer, 'yes', label);
    assert.equal(failOpen?.open, true, label);
    assert.deepEqual(
      facts.map((fact) => [fact.reason, fact.failure]),
      [['gate-failopen', 'unparsed']],
      label
    );
  }
});

test('an unreadable answer lets an unflagged line through within an active one-to-one exchange', async () => {
  for (const text of UNREADABLE) {
    const { answer, facts, failOpen } = await classify(text, { history: EXCHANGE });
    const label = JSON.stringify(text);
    assert.equal(answer, 'yes', label);
    assert.equal(failOpen?.open, true, label);
    assert.deepEqual(
      facts.map((fact) => [fact.reason, fact.failure]),
      [['gate-failopen', 'unparsed']],
      label
    );
  }
});

test('parseAddressAnswer reads the answer field of the object text', () => {
  assert.equal(parseAddressAnswer('{"answer":"yes"}'), 'yes');
  assert.equal(parseAddressAnswer(' {"answer": "overheard"}\n'), 'overheard');
  assert.equal(parseAddressAnswer('{"answer":"no"}'), 'no');
});

test('parseAddressAnswer gives null for every unreadable answer and for no answer', () => {
  for (const text of [...UNREADABLE, '', '   ', null, undefined]) {
    assert.equal(parseAddressAnswer(text), null, JSON.stringify(text));
  }
});
