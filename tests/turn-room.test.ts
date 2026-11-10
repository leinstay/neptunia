// Tests for the room of a long lookup (src/turn/tool-round.ts#runSteps): when the next request would pass the request
// cap, the results of earlier steps give way, oldest first, and the loop stays open; only when nothing older is left
// does the request become the final one. A result cut at `tools.resultMaxChars` says so, and `tools.loop.maxCallsPerStep`
// bounds the calls of one answer. Over a real admin and the fake interface adapter (tests/fixtures/turn-harness.ts);
// the model is scripted with native tool calls; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { coreTurn, contentText } from './fixtures/turn-harness.ts';
import type { ChatMessage, HotStandIn } from './fixtures/turn-harness.ts';

/** The admin's runSkillOp as the tests wrap it. */
type RunOp = (key: string, args: unknown, context: unknown) => Promise<Record<string, unknown>>;

/** A runOp wrapper that hands back `texts[n]` as the result of the n-th operation that runs, and counts them. */
function resultsInTurn(texts: ReadonlyArray<string>): { runs: Array<string>; wrap: (runOp: RunOp) => RunOp } {
  const runs: Array<string> = [];
  return {
    runs,
    wrap: (runOp: RunOp) => async (key: string, args: unknown, context: unknown) => {
      const result = await runOp(key, args, context);
      const text = texts[Math.min(runs.length, texts.length - 1)];
      runs.push(key);
      return { ...result, summary: text, data: { text } };
    },
  };
}

/** The native transport, `resultMaxChars` for every result. */
const nativeWith =
  (resultMaxChars: number) =>
  (hot: HotStandIn): void => {
    hot.config.tools.transport = 'native';
    hot.config.tools.resultMaxChars = resultMaxChars;
  };

/** The tool message of request `messages` that answers the call `id`, '' when there is none. */
const toolMessage = (messages: Array<ChatMessage>, id: string): string =>
  contentText(messages.find((message) => message.role === 'tool' && message.tool_call_id === id)?.content);

/** Every message of a request as one text. */
const allText = (messages: Array<ChatMessage>): string =>
  messages.map((message) => contentText(message.content)).join('\n');

// Three read results of 2000 Greek letters each, about 1000 tokens apiece, in letters the turn's own lines do not use.
// The first request with its tools costs about 1400 tokens. Under a cap of 4400 (a limit of 3960) the requests after
// the first and the second read fit, the one after the third does not (about 4500), and it fits again (about 3500)
// once the first result is replaced by one line.
const ROOM = { llm: { maxRequestTokens: 4400 } };
const READS = ['ζ', 'ξ', 'ψ'].map((letter) => letter.repeat(2000));
const threeReads = () => [
  toolAnswer('<think>1</think>', [call('memory.server.read', {}, { id: 'a' })]),
  toolAnswer('<think>2</think>', [call('lore.list', {}, { id: 'b' })]),
  toolAnswer('<think>3</think>', [call('lore.list', {}, { id: 'c' })]),
  '<think>4</think><msg>βρήκα</msg>',
];
const LOOP = { maxSteps: 10, timeBudgetMs: 20000, maxCallsPerStep: 4, stepReserveTokens: 0 };

/** The turn of the three reads: every request, and the options each went with. */
async function threeReadTurn(): Promise<{ calls: Array<Array<ChatMessage>>; options: Array<Record<string, unknown>> }> {
  const results = resultsInTurn(READS);
  const run = await coreTurn({
    answers: threeReads(),
    loop: LOOP,
    config: ROOM,
    withHot: nativeWith(20000),
    wrapCommand: results.wrap,
  });
  const { calls, options } = run.llm;
  assert.equal(calls.length, 4, 'three reads and the request after the third');
  assert.notEqual(options[2].toolChoice, 'none', 'the request after the second read fits as it is');
  return { calls, options };
}

test('keeps the loop open when dropping the oldest result makes the next request fit', async () => {
  const { calls, options } = await threeReadTurn();
  assert.notEqual(options[3].toolChoice, 'none', 'the request after the third read may still call');
  assert.ok(!allText(calls[3]).includes('ζ'.repeat(10)), "the first result's text is gone from the request");
});

test('keeps the newest result whole when an older one gives way', async () => {
  const { calls } = await threeReadTurn();
  assert.ok(toolMessage(calls[3], 'c').includes(READS[2]), "the third read's result is carried entire");
});

test('names the tool in the line that replaces a dropped result', async () => {
  const { calls } = await threeReadTurn();
  const replaced = toolMessage(calls[3], 'a');
  assert.ok(!replaced.includes('ζ'.repeat(10)), 'the first result was replaced');
  assert.ok(
    replaced.includes('memory.server.read') || replaced.includes('memory_server_read'),
    `the line names the tool: ${replaced}`
  );
});

// Guards the old path: with no earlier result to replace, a request over the cap is still cut and made the final one,
// never sent as a normal request that may call again.
test('goes final when nothing older is left to drop', async () => {
  const results = resultsInTurn(['ζ'.repeat(8000)]);
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list', {}, { id: 'a' })]), '<think>2</think><msg>τέλος</msg>'],
    loop: LOOP,
    config: ROOM,
    withHot: nativeWith(20000),
    wrapCommand: results.wrap,
  });
  const { calls, options } = run.llm;
  assert.equal(calls.length, 2);
  assert.equal(options[1].toolChoice, 'none', 'the request the room made the last cannot call');
});

test('marks a cut result with a line the uncut result does not have', async () => {
  const original = 'ζ'.repeat(2000);
  const results = resultsInTurn([original]);
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list', {}, { id: 'a' })]), '<think>2</think><msg>τέλος</msg>'],
    loop: LOOP,
    config: { llm: { maxRequestTokens: 50000 } },
    withHot: nativeWith(500),
    wrapCommand: results.wrap,
  });
  const { calls } = run.llm;
  const text = toolMessage(calls[1], 'a');
  const kept = Array.from(text).filter((letter) => letter === 'ζ').length;
  assert.ok(kept > 0 && kept < 2000, `the data is cut: ${kept} of 2000 letters`);
  const after = text.slice(text.lastIndexOf('ζ') + 1);
  assert.match(after, /\n\s*\S/, `a line follows the cut data: ${JSON.stringify(after)}`);
});

// Guards the marker against riding every result: one under the limit reaches the request as it was, nothing added.
test('leaves a result under the limit as it is', async () => {
  const original = 'ζ'.repeat(300);
  const results = resultsInTurn([original]);
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list', {}, { id: 'a' })]), '<think>2</think><msg>τέλος</msg>'],
    loop: LOOP,
    config: { llm: { maxRequestTokens: 50000 } },
    withHot: nativeWith(500),
    wrapCommand: results.wrap,
  });
  const { calls } = run.llm;
  const text = toolMessage(calls[1], 'a');
  assert.ok(text.endsWith(original), `the result ends the message entire: ${JSON.stringify(text.slice(-40))}`);
});

/** One answer with six reads, then speech, under `maxCallsPerStep`. */
async function sixCalls(maxCallsPerStep: number): Promise<{ runs: Array<string>; tools: number }> {
  const results = resultsInTurn(['ζ']);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const run = await coreTurn({
    answers: [
      toolAnswer(
        '<think>1</think>',
        ids.map((id) => call('lore.list', {}, { id }))
      ),
      '<think>2</think><msg>τέλος</msg>',
    ],
    loop: { ...LOOP, maxCallsPerStep },
    config: { llm: { maxRequestTokens: 50000 } },
    withHot: nativeWith(2000),
    wrapCommand: results.wrap,
  });
  const { calls } = run.llm;
  assert.equal(calls.length, 2);
  return { runs: results.runs, tools: calls[1].filter((message) => message.role === 'tool').length };
}

// Guards against a fixed bound of four calls: the setting alone decides how many of one answer run.
test('runs six calls of one answer when maxCallsPerStep is 8', async () => {
  const { runs, tools } = await sixCalls(8);
  assert.equal(runs.length, 6);
  assert.equal(tools, 6);
});

test('runs four calls of one answer and refuses two when maxCallsPerStep is 4', async () => {
  const { runs, tools } = await sixCalls(4);
  assert.equal(runs.length, 4, 'four ran');
  assert.equal(tools, 6, 'every call has a result, the two refused ones included');
});
