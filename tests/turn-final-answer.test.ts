// Tests for the last answer of a turn (src/turn/tool-round.ts#runSteps): the request the steps, the time or the room
// made the last one cannot call (tool choice none on the native transport, an inner turn's stays auto), the speech
// of a final answer that carries calls anyway goes out while its calls do not run, and a turn that answers someone
// whose loop ended with no final answer gets one rescue request. Over a real admin and the fake interface adapter
// (tests/fixtures/turn-harness.ts); the model is scripted with native tool calls; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { NOW, coreTurn } from './fixtures/turn-harness.ts';
import type { HotStandIn } from './fixtures/turn-harness.ts';
import { asRecord } from './fixtures/records.ts';

/** The text of every post of the turn, in order. */
const texts = (run: { sends: Array<Record<string, unknown>> }): Array<unknown> => run.sends.map((send) => send.text);

/** The native transport with every bound of the loop a test depends on. */
const native = (hot: HotStandIn): void => {
  hot.config.tools.transport = 'native';
};

/** The admin's runSkillOp as the tests wrap it. */
type RunOp = (key: string, args: unknown, context: unknown) => Promise<Record<string, unknown>>;

/** A runOp wrapper that counts the operations that really ran, by skill key. */
function countingRuns(): { runs: Array<string>; wrap: (runOp: RunOp) => RunOp } {
  const runs: Array<string> = [];
  return {
    runs,
    wrap: (runOp: RunOp) => (key: string, args: unknown, context: unknown) => {
      runs.push(key);
      return runOp(key, args, context);
    },
  };
}

/** A runOp wrapper that hands back `text` as the result of the operations `when` picks. */
const bigWhen =
  (when: () => boolean, text: string) =>
  (runOp: RunOp): RunOp =>
  async (key, args, context) => {
    const result = await runOp(key, args, context);
    return when() ? { ...result, summary: text, data: { text } } : result;
  };

const boom = (): never => {
  throw new Error('provider down');
};

// A 2500-token cap leaves room for the first request and a step with a short result; a result of 3600 Greek
// characters does not fit until it is cut, so the request after it is the last one for the room (`tokens`).
const TIGHT = { llm: { maxRequestTokens: 2500 } };
const BIG = 'δεδομένα '.repeat(400);

test('posts the speech of the final answer when it carries a call, and the call does not run', async () => {
  const counter = countingRuns();
  const run = await coreTurn({
    answers: [
      toolAnswer('<think>1</think>', [call('lore.list', {}, { id: 'a' })]),
      toolAnswer('<think>2</think>', [call('memory.server.read', {}, { id: 'b' })]),
      toolAnswer('<think>3</think><msg>τελικά</msg>', [call('lore.list', {}, { id: 'c' })]),
    ],
    loop: { maxSteps: 2, timeBudgetMs: 20000, maxCallsPerStep: 4 },
    config: { llm: { maxRequestTokens: 50000 } },
    withHot: native,
    wrapCommand: counter.wrap,
  });
  const { calls } = run.llm;
  assert.equal(calls.length, 3);
  assert.deepEqual(texts(run), ['τελικά'], 'the final answer is her reply');
  assert.equal(counter.runs.length, 2, `only the two steps' reads ran: ${counter.runs.join(', ')}`);
});

test('sends the final request with tool choice none when the steps run out', async () => {
  const run = await coreTurn({
    answers: [
      toolAnswer('<think>1</think>', [call('lore.list')]),
      toolAnswer('<think>2</think>', [call('memory.server.read')]),
      '<think>3</think><msg>τέλος</msg>',
    ],
    loop: { maxSteps: 2, timeBudgetMs: 20000, maxCallsPerStep: 4 },
    config: { llm: { maxRequestTokens: 50000 } },
    withHot: native,
  });
  const { options } = run.llm;
  assert.equal(options.length, 3);
  assert.equal(options[2].toolChoice, 'none', 'the final request cannot call');
  assert.ok(Array.isArray(options[2].tools), 'the tools stay in the request for the cached prefix');
  assert.notEqual(options[0].toolChoice, 'none');
  assert.notEqual(options[1].toolChoice, 'none');
});

test('keeps tool choice auto on the final request of an inner turn', async () => {
  const wake = {
    kind: 'intention_due',
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
    intentions: [{ id: 'i1', purpose: 'κοίτα τα νέα', dueAt: NOW - 60_000 }],
    now: NOW,
    timezone: 'UTC',
    channels: [],
  };
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list')]), '<skip/>'],
    allowed: ['lore.list', 'message.create'],
    inner: wake,
    config: {
      wakes: { mode: 'live', chatMessages: 2, loop: { maxSteps: 1, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
      llm: { maxRequestTokens: 50000 },
    },
    prompts: { inner: 'Do what the wake says.' },
    withHot: native,
  });
  const { options } = run.llm;
  assert.equal(options.length, 2, 'the read was followed by the final request');
  assert.equal(options[1].toolChoice, 'auto', 'its one terminal call still runs');
});

test('sends the final request with tool choice none when the room runs out', async () => {
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list')]), '<think>2</think><msg>τέλος</msg>'],
    loop: { maxSteps: 6, timeBudgetMs: 20000, maxCallsPerStep: 4, stepReserveTokens: 0 },
    config: TIGHT,
    withHot: (hot) => {
      native(hot);
      hot.config.tools.resultMaxChars = 4000;
    },
    wrapCommand: bigWhen(() => true, BIG),
  });
  const { options } = run.llm;
  assert.equal(options.length, 2);
  assert.equal(options[1].toolChoice, 'none', 'the request the room made the last cannot call');
  assert.notEqual(options[0].toolChoice, 'none');
});

test('makes one rescue request when the follow-up request throws in a turn that answers someone', async () => {
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list')]), boom, '<think>r</think><msg>εδώ είμαι</msg>'],
    loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
    config: { llm: { maxRequestTokens: 50000 } },
    withHot: native,
  });
  const { calls, options } = run.llm;
  assert.equal(calls.length, 3, 'one rescue request after the failed one');
  assert.deepEqual(texts(run), ['εδώ είμαι']);
  const [first, , rescue] = calls;
  assert.equal(rescue.length, first.length + 1, "the first request's messages and one note");
  first.forEach((message, at) => assert.deepEqual(rescue[at], message, `message ${at} is the first request's`));
  assert.equal(rescue.at(-1)?.role, 'user');
  assert.equal(options[2].toolChoice, 'none');
});

test('makes no rescue request in an overheard turn when the follow-up request throws', async () => {
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list')]), boom, '<think>r</think><msg>εδώ είμαι</msg>'],
    triggerKind: 'overheard',
    loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
    config: { llm: { maxRequestTokens: 50000 } },
    withHot: native,
  });
  const { calls } = run.llm;
  assert.equal(calls.length, 2, 'nobody waits for an overheard line');
  assert.deepEqual(texts(run), []);
});

test('ends without a post when the rescue request throws too', async () => {
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list')]), boom, boom],
    loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
    config: { llm: { maxRequestTokens: 50000 } },
    withHot: native,
  });
  const { calls } = run.llm;
  assert.equal(calls.length, 3, 'one rescue request, no second one');
  assert.deepEqual(texts(run), []);
});

test('honours a skip in the rescue answer', async () => {
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list')]), boom, '<think>r</think><skip/>'],
    loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
    config: { llm: { maxRequestTokens: 50000 } },
    withHot: native,
  });
  const { calls } = run.llm;
  assert.equal(calls.length, 3, 'the rescue request was made');
  assert.deepEqual(texts(run), []);
  assert.equal(asRecord(run.result).outcome, 'skip');
});

// Production 2026-11-09: a reply turn whose fourth request passed the request cap became the final one, her answer
// carried a message and two calls, the speech was held and nothing went out.
test('posts only the final message when the room runs out after a held step and two reads, and its two calls do not run', async () => {
  const counter = countingRuns();
  const run = await coreTurn({
    answers: [
      toolAnswer('<think>0</think><msg>μισό λεπτό</msg>', [call('lore.list', {}, { id: 'a' })]),
      toolAnswer('<think>1</think>', [call('memory.server.read', {}, { id: 'b' })]),
      toolAnswer('<think>2</think>', [call('lore.list', {}, { id: 'c' })]),
      toolAnswer('<think>3</think><msg>βρήκα την απάντηση</msg>', [
        call('lore.list', {}, { id: 'd' }),
        call('memory.server.read', {}, { id: 'e' }),
      ]),
    ],
    loop: { maxSteps: 6, timeBudgetMs: 20000, maxCallsPerStep: 4, stepReserveTokens: 0 },
    config: TIGHT,
    withHot: (hot) => {
      native(hot);
      hot.config.tools.resultMaxChars = 4000;
    },
    // The third read gives the large result, so the request after it is the last one for the room.
    wrapCommand: (runOp: RunOp) => bigWhen(() => counter.runs.length === 3, BIG)(counter.wrap(runOp)),
  });
  const { calls } = run.llm;
  assert.equal(calls.length, 4, 'three steps and the final request');
  assert.deepEqual(texts(run), ['βρήκα την απάντηση'], 'the final message only; the held one of step 0 never goes out');
  assert.equal(counter.runs.length, 3, `the final answer's calls did not run: ${counter.runs.join(', ')}`);
});
