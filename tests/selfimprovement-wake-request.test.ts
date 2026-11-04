// The selfimprovement wake's own prompt and context (plan sections 7 and 8). `prompts/selfimprovement.md` is the wake
// addressed to her; the executor's brief is `prompts/executor-brief.md`, loaded as `prompts['executor-brief']`, and a
// local `selfdev.md` is that brief. The assembled request carries her character and memory, the view of her tasks,
// repeated needs and failures. The tests read marker texts and data, never a prompt's wording. `guard:` names a test of
// what already works and must keep working.
//
// The signatures these tests hold the code to, in `SelfimprovementFacts` (src/behavior/selfimprovement-view.ts):
// - `repeated: Array<{ key: string; count: number; turnIds: Array<string> }>`: every chain shape made at least twice in
//   the window, most frequent first, whatever `shown` cuts from `shapes`.
// - `failures: Array<{ tool: string; code: string | null; count: number; turnIds: Array<string> }>`: the failed calls
//   per tool and code, most frequent first, `skill.run` among them.
// - `proposals[n].blocked: { reason: string; unblocks: string } | null`, read by `proposalsOf` from the task's
//   `blocked_reason` and `unblocks`.
// `wakeBlockText` words `repeated` and `failures` through new keys of `labels.wake.selfimprovement`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSelfimprovementFacts, proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { wakeBlockText } from '../src/behavior/wake.ts';
import { joinLabels } from '../src/config/labels.ts';
import { createHot } from '../src/hot.ts';
import { createCalibrator } from '../src/llm/tokens.ts';
import { briefFrom } from '../src/selfimprovement/service.ts';
import { buildRequest } from './fixtures/built-request.ts';
import { selfimprovementWorld } from './fixtures/selfimprovement-rig.ts';
import { tempDir } from './fixtures/tmp.ts';
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

test('the transport anchor is not her current conversation on this wake', async () => {
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

test('a local selfdev.md is the executor brief and never replaces her wake prompt', () => {
  // Bug: the older local name still loads as `selfimprovement`, so a deployment's brief reaches her as her wake.
  const dir = tempDir('nep-wake-request-hot-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'data', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ bot: { timezone: 'UTC' } }));
  fs.mkdirSync(path.join(dir, 'prompts'));
  fs.writeFileSync(path.join(dir, 'prompts', 'selfimprovement.md'), 'tracked wake');
  fs.writeFileSync(path.join(dir, 'prompts', 'executor-brief.md'), 'tracked brief');
  fs.writeFileSync(path.join(dir, 'data', 'prompts', 'selfdev.md'), 'local brief');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts['executor-brief'], 'local brief');
    assert.equal(hot.prompts.selfimprovement, 'tracked wake');
  } finally {
    hot.close();
  }
});

/** The tracked layer's settings and labels with marker prompts, and the input of a selfimprovement wake's request. */
function shippedInput(overrides: Record<string, unknown>): object {
  const config: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  const labels: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'));
  return {
    config,
    prompts: {
      'system-prompt': 'system',
      'character-card': PROMPT_MARK.card,
      format: 'format',
      inner: PROMPT_MARK.inner,
      selfimprovement: PROMPT_MARK.selfimprovement,
      labels: joinLabels(labels as never),
    },
    calibrator: createCalibrator(),
    mode: 'inner',
    forced: false,
    now: WAKE_NOW,
    selfName: 'Her',
    history: [],
    neighbors: [],
    trigger: null,
    triggerKind: 'inner',
    interlocutor: null,
    otherProfiles: [],
    candidateProfiles: [],
    nameOf: (id: string) => id,
    channels: [
      { id: 'c1', name: 'general' },
      { id: 'c2', name: 'hidden' },
    ],
    loreEntries: [],
    descriptions: new Map(),
    neighborDescriptions: new Map(),
    videos: new Map(),
    reads: new Map(),
    wakeKind: 'selfimprovement',
    wake: '',
    ...overrides,
  };
}

test('guard: the wake request carries recent memory the audience rule allows and leaves out what it refuses', () => {
  const line = (id: number, channelId: string, text: string) => ({
    id,
    at: WAKE_NOW - 2 * HOUR,
    addedAt: iso(WAKE_NOW - HOUR),
    channelId,
    text,
    who: [],
    weight: 2,
  });
  const request = buildRequest(
    shippedInput({
      recentLines: [line(1, 'c1', 'an eligible moment'), line(2, 'c2', 'a private moment')],
      recentAudience: (channelId: string | null) => channelId === 'c1',
    })
  );
  const text = requestText(request.messages as never);
  assert.ok(text.includes(PROMPT_MARK.card));
  assert.ok(text.includes('an eligible moment'));
  assert.ok(!text.includes('a private moment'));
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
  read: (_guild: string, query: { kind: string }) =>
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
    guildId: 'g1',
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

test('the wake text carries the repeated needs and the failures', async () => {
  // Bug: the facts exist and no label words them, so the model never reads them.
  const labels: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'));
  const text = wakeBlockText(
    { ...wakeOfKind('selfimprovement', 'selfimprovement:1'), selfimprovement: await facts() },
    joinLabels(labels as never)
  );
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
    guildId: 'g1',
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
