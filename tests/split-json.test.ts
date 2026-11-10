// Tests for the splitter's strict JSON answer (src/turn/lookup.ts#maybeSplit, read by
// src/behavior/split.ts#parseSplitAnswer): the request hands the client SPLIT_FORMAT as `responseFormat`, an object
// `{ "parts": [text, ...] }` gives the decision the dash lines or the word `one` gave (one part or none is one request,
// more than maxTasks are cut), and every other answer, the old word and dash lines included, is an unreadable answer:
// one request, logged `split: failed` with `unparsed`, or `empty` for a blank answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLookup, SPLIT_FORMAT } from '../src/turn/lookup.ts';
import { SPLIT_DEFAULTS } from '../src/behavior/split.ts';
import { rig } from './fixtures/reads-rig.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { chainsOf } from './fixtures/chains.ts';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

const CONFIG = {
  bot: { timezone: 'UTC' },
  models: { routes: chainsOf({ analyzer: 'small/analyzer' }) },
  llm: { analyzerTimeoutMs: 1000 },
  split: { maxOutputTokens: 50 },
};

// Four parts, each past split.minPartChars (20 code points), so none folds into another.
const PARTS = [
  'ποιος είναι ο Νίκος ακριβώς',
  'κοίτα το κανάλι της Ελένης',
  'πες μου αν το μιμίδιο είναι αστείο',
  'και ζωγράφισε έναν γάτο με καπέλο',
];
const FIFTH = 'και ένα τελευταίο ακόμα θέμα εδώ';

type Sent = { options: { responseFormat?: unknown; purpose?: unknown } };

/** One maybeSplit whose model answers `text` (or throws it), with the request options and the split log lines. */
async function split(text: string) {
  const sent: Array<Sent> = [];
  const lookup = createLookup({
    hot: { prompts: { labels } },
    store: { listUserProfiles: () => [] },
    llm: {
      complete: (_messages, options) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    clock: () => NOW,
    recall: null,
    membersOf: null,
    selfIdOf: () => 'self',
    ifaceReads: rig().reads,
    classifierContext: ({ trigger }) => ({ triggerText: String(trigger.content ?? ''), transcriptBlock: '' }),
    linkCalls: () => {
      throw new Error('the splitter does not decorate');
    },
  });
  const { result, logs } = await withCapturedLogs(() =>
    lookup.maybeSplit({
      config: CONFIG,
      placeId: 'c1',
      selfName: 'Nova',
      history: [],
      trigger: { id: 'm1', authorName: 'Léa', content: PARTS.join('; ') },
      prompt: 'Split for {{name}} into at most {{maxTasks}} parts.',
      isLate: () => false,
    })
  );
  const failed = logs.filter((entry) => entry.msg === 'split: failed');
  const verdicts = logs.filter((entry) => entry.msg === 'split: verdict');
  return { parts: result, sent, failed, verdicts };
}

/** Answers that are not the object, or whose `parts` is not a list of texts: each is an unreadable answer. */
const UNREADABLE = [
  'one',
  'One.',
  `- ${PARTS[0]}\n- ${PARTS[1]}`,
  'The message holds two requests.',
  '{}',
  JSON.stringify({ part: [PARTS[0], PARTS[1]] }),
  JSON.stringify({ parts: PARTS[0] }),
  JSON.stringify({ parts: null }),
  JSON.stringify({ parts: [1, 2] }),
  JSON.stringify({ parts: [PARTS[0], 2] }),
  JSON.stringify({ parts: [PARTS[0], null] }),
  JSON.stringify({ parts: [PARTS[0], '   '] }),
  JSON.stringify([PARTS[0], PARTS[1]]),
  '"one"',
  'null',
  '2',
  `{"parts":["${PARTS[0]}","${PARTS[1]}"]`,
  `\`\`\`json\n${JSON.stringify({ parts: [PARTS[0], PARTS[1]] })}\n\`\`\``,
];

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, { type?: unknown; items?: { type?: unknown } }>;
};

test('the split request hands the client SPLIT_FORMAT as its responseFormat', async () => {
  const { sent } = await split(JSON.stringify({ parts: [] }));
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.options.purpose, 'split');
  assert.deepEqual(request.options.responseFormat, SPLIT_FORMAT);
});

test('SPLIT_FORMAT is a closed object whose one required field parts is a list of texts', () => {
  assert.match(SPLIT_FORMAT.name, /^[A-Za-z0-9_-]{1,64}$/);
  const schema = SPLIT_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['parts']);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['parts']);
  const parts = schema.properties?.parts;
  assert.equal(parts?.type, 'array');
  assert.equal(parts?.items?.type, 'string');
});

test('two to four parts are the split, in their order, logged as a verdict', async () => {
  for (const count of [2, 3, 4]) {
    const { parts, failed, verdicts } = await split(JSON.stringify({ parts: PARTS.slice(0, count) }));
    assert.deepEqual(parts, PARTS.slice(0, count), `${count} parts`);
    assert.deepEqual(failed, [], `${count} parts: no failed call`);
    assert.deepEqual(
      verdicts.map((entry): unknown => entry.parts),
      [count],
      `${count} parts`
    );
  }
});

test('an empty list or one part is one request, logged as a verdict of one part like the word one', async () => {
  for (const list of [[], [PARTS[0]]]) {
    const { parts, failed, verdicts } = await split(JSON.stringify({ parts: list }));
    const label = JSON.stringify(list);
    assert.equal(parts, null, label);
    assert.deepEqual(failed, [], label);
    assert.deepEqual(
      verdicts.map((entry): unknown => entry.parts),
      [1],
      label
    );
  }
});

test('more parts than split.maxTasks are cut to the first maxTasks', async () => {
  assert.equal(SPLIT_DEFAULTS.maxTasks, PARTS.length, 'the fixture holds exactly maxTasks parts');
  const { parts, verdicts } = await split(JSON.stringify({ parts: [...PARTS, FIFTH] }));
  assert.deepEqual(parts, PARTS);
  assert.deepEqual(
    verdicts.map((entry): unknown => entry.parts),
    [PARTS.length]
  );
});

test('an unreadable answer, the old word and dash lines included, is one request logged as unparsed', async () => {
  for (const text of UNREADABLE) {
    const { parts, failed, verdicts } = await split(text);
    const label = JSON.stringify(text);
    assert.equal(parts, null, label);
    assert.deepEqual(verdicts, [], `${label}: no verdict`);
    assert.deepEqual(
      failed.map((entry): unknown => entry.reason),
      ['unparsed'],
      label
    );
  }
});

test('a blank answer is one request logged as empty', async () => {
  const { parts, failed } = await split('  \n');
  assert.equal(parts, null);
  assert.deepEqual(
    failed.map((entry): unknown => entry.reason),
    ['empty']
  );
});
