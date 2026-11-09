// The think of each step's answer goes to the turn's progress (`noteProgress` of the runner, name `think`), folded to one
// line and cut to 400 characters. Over a real admin and the fake adapter (tests/fixtures/turn-harness.ts); no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { coreTurn } from './fixtures/turn-harness.ts';
import type { HotStandIn } from './fixtures/turn-harness.ts';

const native = (hot: HotStandIn): void => {
  hot.config.tools.transport = 'native';
};

async function noted(
  answers: Array<string | ReturnType<typeof toolAnswer>>
): Promise<Array<{ name: string; detail: string }>> {
  const steps: Array<{ name: string; detail: string }> = [];
  await coreTurn({
    answers,
    runner: { noteProgress: (_id: unknown, step: { name: string; detail: string }) => void steps.push(step) },
    withHot: native,
  });
  return steps.filter((step) => step.name === 'think');
}

test('notes the think of each step answer, in order, on one line and cut to 400 characters', async () => {
  // Bug: a multi-line or long think breaks the one-row status line, or the first step's think is lost.
  const long = `second step\nwith a break ${'x'.repeat(600)}`;
  const thinks = await noted([
    toolAnswer('<think>first step\nlooks at the list</think>', [call('lore.list')]),
    toolAnswer(`<think>${long}</think>`, [call('memory.server.read')]),
    '<msg>τέλος</msg>',
  ]);
  assert.equal(thinks.length, 2);
  assert.equal(thinks[0]?.detail, 'first step looks at the list');
  const second = thinks[1]?.detail ?? '';
  assert.ok(!/[\r\n]/.test(second), 'no line break');
  assert.ok(second.length <= 400, `cut: ${second.length}`);
  assert.ok(second.startsWith('second step with a break xxx'));
});

test('notes nothing for an answer with no think, and keeps the think of the step before', async () => {
  // Bug: an empty think note replaces the row's earlier reason with a blank.
  const thinks = await noted([
    toolAnswer('<think>only reason</think>', [call('lore.list')]),
    toolAnswer('', [call('memory.server.read')]),
    '<msg>τέλος</msg>',
  ]);
  assert.deepEqual(
    thinks.map((step) => step.detail),
    ['only reason']
  );
});
