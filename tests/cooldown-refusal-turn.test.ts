// What the result of a destructive call refused by its cooldown tells her (src/tools/gateway.ts#checkSkill,
// src/turn/skill-calls.ts): the minutes left and the window of `tools.destructiveCooldownMinutes`, through the
// `cooldown` reason of the labels. One turn over the fake adapter: the first `lore.remove` runs, the second follows in
// the next step three and a half minutes later and is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { NOW, appended, contentText, coreTurn } from './fixtures/turn-harness.ts';

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
  // The operation of `lore.remove` (a reply turn runs her calls through `runOp`): every run is kept, each answers ok.
  const ran: Array<unknown> = [];
  const runOp = (op: unknown, args: unknown) => {
    ran.push({ op, args });
    return Promise.resolve({ status: 'ok', code: 'ok', summary: 'lore entry removed' });
  };
  const run = await coreTurn({
    answers: [
      toolAnswer('<think>x</think>', [call('lore.remove', { id: 'l1' }, { id: 'first' })]),
      toolAnswer('<think>x</think>', [call('lore.remove', { id: 'l2' }, { id: 'second' })]),
      '<skip/>',
    ],
    allowed: ['lore.remove'],
    loop: { timeBudgetMs: 60 * MINUTE_MS },
    prompts: { labels: labelsWithCooldown() },
    withHot(hot) {
      hot.config.tools.destructiveCooldownMinutes = 10;
    },
    // The second step's request comes three and a half minutes after the first call ran.
    onAnswer(index) {
      if (index === 1) elapsed = 3.5 * MINUTE_MS;
    },
    runner: { now: () => NOW + elapsed, runOp },
  });
  // The first call ran and answered ok, so the cooldown holds; the second never reached the operation.
  assert.deepEqual(ran, [{ op: 'lore.remove', args: { id: 'l1' } }]);
  const refusals = run.logs
    .filter((entry) => entry.msg === 'skill: refused')
    .map((entry) => `${entry.skill} ${entry.code}`);
  assert.deepEqual(refusals, ['lore.remove cooldown'], 'the second call is refused by the cooldown and nothing else');
  const second = appended(run.llm, 2).find((message) => message.role === 'tool' && message.tool_call_id === 'second');
  const text = contentText(second?.content);
  assert.ok(text.includes('own call of this tool here within 10 min, again in 7 min'), text);
});
