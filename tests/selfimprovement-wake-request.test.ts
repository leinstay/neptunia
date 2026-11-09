// The selfimprovement wake's own prompt and context (plan sections 7 and 8). `prompts/selfimprovement.md` is the wake
// addressed to her; the executor's brief is `prompts/executor-brief.md`, loaded as `prompts['executor-brief']`. The
// assembled request carries her character and memory, the view of her tasks, repeated needs and failures. The tests read marker texts and data, never a prompt's wording. `guard:` names a test of
// what already works and must keep working.
//
// The signatures these tests hold the code to, in `SelfimprovementFacts` (src/behavior/selfimprovement-view.ts):
// - `repeated: Array<{ key: string; count: number; turnIds: Array<string> }>`: every chain shape made at least twice in
//   the window, most frequent first, whatever `shown` cuts from `shapes`.
// - `failures: Array<{ tool: string; code: string | null; count: number; turnIds: Array<string> }>`: the failed calls
//   per tool and code, most frequent first, `skill.run` among them.
// - `proposals[n].blocked: { reason: string; unblocks: string } | null`, read by `proposalsOf` from the task's
//   `blocked_reason` and `unblocks`.
// `workLines` words `repeated` and `failures` in `<work>` through keys of `labels.wake.selfimprovement`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSelfimprovementFacts, proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { personaJournal } from '../src/behavior/inner/persona-sources.ts';
import { createJournal } from '../src/memory/journal.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { workLines } from '../src/behavior/selfimprovement-text.ts';
import { joinLabels } from '../src/config/labels.ts';
import { briefFrom } from '../src/development/brief.ts';
import { selfimprovementWorld } from './fixtures/selfimprovement-rig.ts';
import { ANCHOR_LINE, PROMPT_MARK, WAKE_NOW, requestText, wakeOfKind, wakeTurn } from './fixtures/wake-turn.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iso = (at: number): string => new Date(at).toISOString();
const HOUR = 3_600_000;
const FIX = {
  id: 'T-1',
  title: 'title',
  evidence: 'evidence',
  acceptance: 'acceptance',
  examples: ['t1'],
  counterexamples: [],
  benefit: 'benefit',
  evaluation: 'evaluation',
};

test('the wake request is framed by the selfimprovement prompt with her character, and neither inner.md nor the brief', async () => {
  // Bug: the wake runs on inner.md, or the executor's instructions reach her as if she were the coder.
  const run = await wakeTurn({
    wake: wakeOfKind('selfimprovement', 'selfimprovement:1'),
    answers: ['<skip/>'],
    board: null,
  });
  const text = requestText(run.requests[0] ?? []);
  assert.ok(text.includes(PROMPT_MARK.selfimprovement), 'its own prompt');
  assert.ok(text.includes(PROMPT_MARK.card), 'her character');
  assert.ok(!text.includes(PROMPT_MARK.inner), 'no inner.md');
  assert.ok(!text.includes(PROMPT_MARK.brief), 'no executor brief');
});

test('the transport anchor is not her current chat on this wake', async () => {
  // Bug: the anchor channel's chat reads as a room she should answer, as it did on a heartbeat before it was cut.
  const run = await wakeTurn({
    wake: wakeOfKind('selfimprovement', 'selfimprovement:1'),
    answers: ['<skip/>'],
    board: null,
  });
  assert.ok(!requestText(run.requests[0] ?? []).includes(ANCHOR_LINE));
});

test('guard: a heartbeat keeps its own prompt and no brief', async () => {
  const run = await wakeTurn({ wake: wakeOfKind('heartbeat', 'heartbeat:1'), answers: ['<skip/>'], board: null });
  const text = requestText(run.requests[0] ?? []);
  assert.ok(text.includes(PROMPT_MARK.heartbeat));
  assert.ok(!text.includes(PROMPT_MARK.selfimprovement));
  assert.ok(!text.includes(PROMPT_MARK.brief));
});

test('the tracked brief moves to executor-brief.md and is the only prompt the executor fills', () => {
  // Bug: the rename leaves the executor reading the persona's wake, and a coding agent gets her prompt with no request in it.
  const brief = fs.readFileSync(path.join(ROOT, 'prompts', 'executor-brief.md'), 'utf8');
  assert.equal(briefFrom(brief, FIX).includes('{{'), false);
  assert.ok(briefFrom(brief, FIX).includes('T-1'));
  const wake = fs.readFileSync(path.join(ROOT, 'prompts', 'selfimprovement.md'), 'utf8');
  assert.equal(wake.includes('{{id}}'), false, 'the wake addressed to her carries none of the brief placeholders');
});

const JOURNAL_AT = WAKE_NOW - HOUR;
const operation = (turnId: string, tool: string, phase: 'succeeded' | 'failed', code: string | null) => {
  const base = { kind: 'action', name: 'skill', turnId, opId: `${turnId}-${tool}` };
  return [
    { ...base, phase: 'started', occurredAt: iso(JOURNAL_AT), input: { skill: tool, args: ['q'] } },
    { ...base, phase, occurredAt: iso(JOURNAL_AT + 1000), result: code === null ? {} : { code } },
  ];
};
const JOURNAL = {
  read: (query: { kind: string }) =>
    query.kind !== 'action'
      ? []
      : [
          ...operation('t1', 'web.search', 'succeeded', null),
          ...operation('t2', 'web.search', 'succeeded', null),
          ...operation('t3', 'web.search', 'succeeded', null),
          ...operation('t4', 'skill.run', 'failed', 'timeout'),
          ...operation('t5', 'skill.run', 'failed', 'timeout'),
          ...operation('t6', 'web.read', 'failed', 'blocked'),
          ...operation('t7', 'memory.search', 'succeeded', null),
        ],
};
const facts = () =>
  buildSelfimprovementFacts({
    now: WAKE_NOW,
    since: null,
    shown: 1,
    journal: JOURNAL,
    granted: [],
    skills: [],
    proposals: [],
    outbox: [],
  });

test('the facts name repeated needs past the shown cut and leave out what happened once', async () => {
  // Bug: the top shapes hide a smaller repeated need, or a one-off reads as a need.
  const { repeated } = await facts();
  assert.deepEqual(
    repeated.map((one) => [one.key.split('(')[0], one.count]),
    [
      ['web.search', 3],
      ['skill.run', 2],
    ]
  );
  assert.deepEqual([...(repeated[1]?.turnIds ?? [])].sort(), ['t4', 't5']);
});

test('the facts name tool and skill failures by tool and code, most frequent first', async () => {
  // Bug: she sees that a shape failed and not why, so she cannot state the need in a task.
  const { failures } = await facts();
  assert.deepEqual(
    failures.map(({ tool, code, count }) => ({ tool, code, count })),
    [
      { tool: 'skill.run', code: 'timeout', count: 2 },
      { tool: 'web.read', code: 'blocked', count: 1 },
    ]
  );
});

// Slice 5: `<wake>` is gone; the repeated needs and the failures are lines of `<work>` (workLines).
test('the work text carries the repeated needs and the failures', async () => {
  // Bug: the facts exist and no label words them, so the model never reads them.
  const labels: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'));
  const words = joinLabels(labels as never) as unknown as { wake: { selfimprovement: unknown } };
  const text = workLines(await facts(), words.wake.selfimprovement, () => '', null).join('\n');
  assert.ok(text.includes('timeout'), 'the failure code');
  assert.ok(text.includes('web.read'), 'the failed tool past the shown cut');
  assert.ok(text.includes('skill.run'), 'the repeated need past the shown cut');
});

test('a blocked task of hers shows why it waits and what would unblock it', async (t) => {
  // Bug: she reads only the word blocked, and cannot decide whether to comment or cancel.
  const world = selfimprovementWorld(t);
  const { caller } = world;
  const task = await caller.call('persona', 'task.add', {
    lane: 'dev',
    title: 'A task',
    description: 'evidence',
    requester: 'persona:self',
    subscriber: 'persona:self',
  });
  await caller.call('selfimprovement', 'task.transition', {
    id: task.id,
    status: 'triaged',
    revision: task.revision,
    set: { role: 'dev', estimate: 30, budget: 4, risk: 'low' },
  });
  await caller.call('selfimprovement', 'task.approve', { id: task.id, scope: 'plan' });
  await caller.call('selfimprovement', 'task.claim', { id: task.id });
  await caller.call('selfimprovement', 'task.block', {
    id: task.id,
    reason: 'no fork',
    unblocks: 'a fork of the repo',
  });
  const view = await proposalsOf(caller);
  const built = await buildSelfimprovementFacts({
    now: WAKE_NOW,
    since: null,
    journal: null,
    granted: [],
    skills: [],
    proposals: view.entries,
    outbox: view.outbox,
  });
  assert.deepEqual(built.proposals[0]?.blocked, { reason: 'no fork', unblocks: 'a fork of the repo' });
});

test('a skill action journaled in a place reaches the selfimprovement wake chains', async (t) => {
  // Bug: personaJournal.read reads only her own journal while
  // every skill action of a turn is journaled in the journal of the turn's place, so the wake saw no chain at all.
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const place = 'fake:channel:c1';
  const memory = openTestMemorySync({ now: () => now });
  t.after(() => memory.close());
  let n = 0;
  const journal = createJournal({
    memoryDb: memory.memoryDb,
    dataDir: 'fake-data',
    config: () => ({ thinkChars: 4000 }),
    now: () => now - HOUR,
    uuid: () => `u${(n += 1)}`,
  });
  const op = journal.op(place, { turnId: 'turn:place-1', name: 'skill', by: 'persona', placeId: 'c1' });
  await op.started({ input: { skill: 'memory.search', args: ['query'] } });
  await op.succeeded({});
  await new Promise((resolve) => setImmediate(resolve));
  const facts = await buildSelfimprovementFacts({
    now,
    since: null,
    journal: personaJournal(journal, () => [place]),
    granted: ['memory.search'],
    skills: [],
    proposals: [],
    outbox: [],
  });
  assert.deepEqual(
    facts.shapes.map((shape) => [shape.key, shape.turnIds]),
    [['memory.search(query)', ['turn:place-1']]]
  );
  assert.deepEqual(facts.unusedTools, []);
});
