// What the result of a destructive call refused by its cooldown tells her (src/tools/gateway.ts#checkSkill,
// src/turn/skill-calls.ts): the minutes left and the window of `tools.destructiveCooldownMinutes`, through the
// `cooldown` reason of the labels. One turn over the fake adapter: the first `message.delete` runs, the second follows in
// the next step three and a half minutes later and is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { NOW, appended, contentText, coreTurn, rawMessage } from './fixtures/turn-harness.ts';

const MINUTE_MS = 60_000;
const COOLDOWN = 'own call of this tool here within {window} min, again in {minutes} min';

/** The fixture labels with a `cooldown` reason of this test's own wording. */
function labelsWithCooldown() {
  const { tools } = labels;
  const { result } = tools;
  return { ...labels, tools: { ...tools, result: { ...result, reasons: { ...result.reasons, cooldown: COOLDOWN } } } };
}

// Bug: the refusal reaches her with no numbers, so she guesses which call closed the tool and for how long.
test('a destructive call refused by its cooldown tells her the minutes left and the window', async () => {
  let elapsed = 0;
  // Changed: the destructive call is `message.delete` of two lines of hers, since `lore.remove` is no tool of hers.
  const run = await coreTurn({
    answers: [
      toolAnswer('<think>x</think>', [call('message.delete', { message: '#1' }, { id: 'first' })]),
      toolAnswer('<think>x</think>', [call('message.delete', { message: '#2' }, { id: 'second' })]),
      '<skip/>',
    ],
    allowed: ['message.delete'],
    // Two lines of hers, #1 and #2, for her two deletions.
    earlier: [
      rawMessage({ id: 'b1', authorId: 'self-id', authorName: 'self', ts: NOW - 60_000, content: 'πρώτο' }),
      rawMessage({ id: 'b2', authorId: 'self-id', authorName: 'self', ts: NOW - 50_000, content: 'δεύτερο' }),
    ],
    loop: { timeBudgetMs: 60 * MINUTE_MS },
    prompts: { labels: labelsWithCooldown() },
    withHot(hot) {
      hot.config.tools.destructiveCooldownMinutes = 10;
    },
    // The second step's request comes three and a half minutes after the first call ran.
    onAnswer(index) {
      if (index === 1) elapsed = 3.5 * MINUTE_MS;
    },
    runner: { now: () => NOW + elapsed },
  });
  // The first call ran and answered ok, so the cooldown holds; the second never reached the port.
  const called = run.logs
    .filter((entry) => entry.msg === 'skills: called')
    .map((entry) => `${entry.skill} ${entry.status}`);
  assert.deepEqual(called, ['message.delete ok', 'message.delete denied']);
  const refusals = run.logs
    .filter((entry) => entry.msg === 'skill: refused')
    .map((entry) => `${entry.skill} ${entry.code}`);
  assert.deepEqual(
    refusals,
    ['message.delete cooldown'],
    'the second call is refused by the cooldown and nothing else'
  );
  const second = appended(run.llm, 2).find((message) => message.role === 'tool' && message.tool_call_id === 'second');
  const text = contentText(second?.content);
  assert.ok(text.includes('own call of this tool here within 10 min, again in 7 min'), text);
});
