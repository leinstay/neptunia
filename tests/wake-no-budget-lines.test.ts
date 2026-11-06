// The owner's word of 2026-11-06: no budget line reaches her turns, because the ways a budget is counted are too many.
// A request holds neither the `labels.wake.budgets` lead nor a line per budget ("turns for this thread: ...",
// "until <Sunday>: N turns of M"), and the prompt of an inner turn no longer tells her to live on them. The limits
// themselves stay: a chain past `wakes.caps.perChain` is still held. Over the turn harness with the shipped inner
// prompt, and the inner scheduler's rig for the cap. Synthetic Greek text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinLabels } from '../src/config/labels.ts';
import { labels } from './fixtures/labels.ts';
import { asRecord } from './fixtures/records.ts';
import { coreTurn, requestText } from './fixtures/turn-harness.ts';
import { intention, hotWith, setup } from './fixtures/inner-rig.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-11-06T12:00:00Z');

/** What a deployment's own labels may still carry: the lead, the chain line and the turns line, as the engine once shipped them. */
const OLD_BUDGET_WORDS = {
  budgets: 'What you have left:',
  budget: {
    chain: 'turns for this thread: {left} remaining of {cap}',
    turns: 'until {until}: {spent} turns of {possible}',
  },
};
const withOldLabels = { ...labels, wake: { ...labels.wake, ...OLD_BUDGET_WORDS } };

/** The strings a budget line is made of, whichever labels word it. */
const BUDGET_TRACES = [/What you have left/, /remaining of/, /turns of/, /chain \d+\/\d+/, /budget/i];

const INNER_PROMPT = fs.readFileSync(path.join(ROOT, 'prompts', 'inner.md'), 'utf8').trim();

/** A wake that still carries the figures of both budgets, as the scheduler handed them before. */
const WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'πες καλημέρα', dueAt: NOW - 60_000 }],
  now: NOW,
  timezone: 'UTC',
  channels: [],
  budgets: {
    chain: { used: 0, cap: 3, left: 3 },
    turns: { until: Date.parse('2026-11-08T00:00:00Z'), spent: 239, possible: 0 },
  },
};

function assertNoBudgetLine(text: string): void {
  for (const trace of BUDGET_TRACES) assert.doesNotMatch(text, trace);
}

// Bug: the wake ended with "What you have left:" and a line per budget, one of them plainly wrong ("239 turns of 0"),
// and inner.md told her those lines are what she lives on.
test('an inner turn names no budget in its request, even when the labels and the wake still carry one', async () => {
  const run = await coreTurn({
    answers: ['<think>τίποτα</think><skip/>'],
    inner: WAKE,
    allowed: ['message.create'],
    config: { wakes: { mode: 'live', chatMessages: 2 } },
    prompts: { inner: INNER_PROMPT, labels: withOldLabels },
  });
  const text = requestText(run.llm, 0);
  assert.ok(text.includes(labels.wake.header), 'the wake itself is still in the request');
  assert.ok(text.includes('πες καλημέρα'), 'and so is what it is about');
  assertNoBudgetLine(text);
});

test('a reply turn names no budget in its request', async () => {
  const run = await coreTurn({
    answers: ['<think>ναι</think><msg>γεια</msg>'],
    prompts: { labels: withOldLabels },
  });
  assertNoBudgetLine(requestText(run.llm, 0));
});

test('the shipped labels hold no budget wording under the wake', () => {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8')) as Parameters<
    typeof joinLabels
  >[0];
  const wake = asRecord(joinLabels(file).wake);
  assert.equal(wake.budgets, undefined);
  assert.equal(wake.budget, undefined);
});

// The limits are not the lines: with the lines gone, a chain at its cap is still held until the next local day.
test('a chain past wakes.caps.perChain is still held after the budget lines left the wake', async () => {
  const run = setup({
    records: [intention('i1', { chainId: 'k' }), intention('i2', { chainId: 'k', placeId: 'c2' })],
    hot: hotWith({ wakes: { caps: { perChain: 1 } } }),
  });
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1, 'the first wake of the chain runs');
  assert.deepEqual((await run.inner.tick()).drained, { refused: 'per-chain' });
  assert.equal(run.inner.state().queue.find((wake) => wake.kind !== 'feedback')?.capped, 'per-chain');
});
