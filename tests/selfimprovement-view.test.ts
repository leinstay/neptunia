// The facts of her `selfimprovement` wake (src/behavior/selfimprovement-view.ts): code over the journal and the board,
// no model. Her chains of the window are grouped by the ordered tool names with their argument names, the most
// frequent shapes are counted with their failures, retries, costs and turn ids, the tools she holds and never called
// are named, her skills come with their use counts, and her proposals come with the answers the board holds for them,
// each shown once. The view holds tool names, argument names, codes, counts and ids, never a line of chat. Fake
// journals with synthetic records, and a real board over a memory database in memory for the answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { openBoard } from '../src/board/board.ts';
import type { Board } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import {
  ackOutbox,
  buildSelfimprovementFacts,
  chainsOfJournal,
  proposalsOf,
  shapesOf,
} from '../src/behavior/selfimprovement-view.ts';
import type { Chain, SkillUseRow } from '../src/behavior/selfimprovement-view.ts';
import { utcDay } from '../src/time.ts';
import { tempDir } from './fixtures/tmp.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-01T12:00:00Z');
const iso = (at: number): string => new Date(at).toISOString();

type Rec = Record<string, unknown>;

/** The two lines a tool call leaves in the journal: `started` with its input, then the closing line. */
function call(
  turnId: string,
  opId: string,
  tool: string,
  args: Array<string>,
  at: number,
  phase = 'succeeded',
  code?: string
): Array<Rec> {
  const base = { kind: 'action', name: 'skill', turnId, opId, scope: { channel: 'c1' } };
  return [
    { ...base, phase: 'started', occurredAt: iso(at), input: { skill: tool, args } },
    { ...base, phase, occurredAt: iso(at + 1000), ...(code === undefined ? {} : { result: { code } }) },
  ];
}

/** One turn that called `tools` in order, each with its own argument names. */
function turn(turnId: string, at: number, tools: Array<[string, Array<string>, string?, string?]>): Array<Rec> {
  return tools.flatMap(([tool, args, phase, code], index) =>
    call(turnId, `${turnId}-op${index}`, tool, args, at + index * 2000, phase, code)
  );
}

const innerTurn = (turnId: string, at: number, usd: number): Rec => ({
  kind: 'inner',
  event: 'turn',
  turnId,
  occurredAt: iso(at),
  cost: { usd, requests: 1, voice: 0 },
});

const LOOKUP: Array<[string, Array<string>]> = [
  ['web.search', ['query']],
  ['web.read', ['url']],
  ['message.create', ['text']],
];

/** A journal over `records`, read by UTC day and kind as the memory journal answers. */
function fakeJournal(records: ReadonlyArray<Rec>) {
  return {
    read: (_guildId: string, query: { day: string; kind: string; n: number }): Array<Rec> =>
      records.filter((r) => r.kind === query.kind && utcDay(Date.parse(String(r.occurredAt))) === query.day),
  };
}

const NO_SKILLS: Array<SkillUseRow> = [];
const base = (records: ReadonlyArray<Rec>, extra: Partial<Parameters<typeof buildSelfimprovementFacts>[0]> = {}) => ({
  guildId: 'g1',
  now: NOW,
  since: null,
  journal: fakeJournal(records),
  granted: [] as Array<string>,
  skills: NO_SKILLS,
  proposals: [],
  outbox: [],
  ...extra,
});

test('a turn becomes a chain: its calls in order with argument names, outcome and code, and the cost of its inner turn', () => {
  const records = [
    ...turn('t1', NOW - HOUR, [
      ['web.search', ['query'], 'succeeded'],
      ['web.read', ['url'], 'failed', 'timeout'],
      ['message.create', ['text'], 'unknown'],
    ]),
    innerTurn('t1', NOW - HOUR + 9000, 0.0125),
  ];
  assert.deepEqual(chainsOfJournal(records), [
    {
      turnId: 't1',
      at: NOW - HOUR,
      costUsd: 0.0125,
      calls: [
        { tool: 'web.search', args: ['query'], status: 'ok', code: null },
        { tool: 'web.read', args: ['url'], status: 'failed', code: 'timeout' },
        { tool: 'message.create', args: ['text'], status: 'unknown', code: null },
      ],
    },
  ]);
});

test('a turn with no call is no chain, a shadow call never ran, and a journal with nothing gives nothing', () => {
  const shadow = turn('t2', NOW - HOUR, [['web.search', ['query']]]).map((line) => ({ ...line, shadow: true }));
  const noCalls: Array<Rec> = [
    { kind: 'turn', turnId: 't3', occurredAt: iso(NOW - HOUR), posted: [] },
    innerTurn('t3', NOW - HOUR, 0.01),
  ];
  assert.deepEqual(chainsOfJournal([...shadow, ...noCalls]), []);
  assert.deepEqual(chainsOfJournal([]), []);
  assert.deepEqual(chainsOfJournal([null, 'x', 7]), []);
});

test('chains come oldest first and a turn without an inner record costs nothing', () => {
  const records = [
    ...turn('late', NOW - HOUR, [['web.search', ['query']]]),
    ...turn('early', NOW - 5 * HOUR, [['web.read', ['url']]]),
  ];
  const chains = chainsOfJournal(records);
  assert.deepEqual(
    chains.map((chain) => [chain.turnId, chain.costUsd]),
    [
      ['early', 0],
      ['late', 0],
    ]
  );
});

function chain(
  turnId: string,
  at: number,
  calls: Array<[string, Array<string>, ('ok' | 'failed' | 'unknown')?]>,
  costUsd = 0
): Chain {
  return {
    turnId,
    at,
    costUsd,
    calls: calls.map(([tool, args, status]) => ({
      tool,
      args,
      status: status ?? 'ok',
      code: status === 'failed' ? 'e' : null,
    })),
  };
}

test('shapes group by the ordered tool names with argument names and are counted', () => {
  const chains = [
    chain('a', 1, [
      ['web.search', ['query']],
      ['web.read', ['url']],
    ]),
    chain('b', 2, [
      ['web.search', ['query']],
      ['web.read', ['url']],
    ]),
    chain('c', 3, [
      ['web.read', ['url']],
      ['web.search', ['query']],
    ]),
    chain('d', 4, [
      ['web.search', ['query', 'limit']],
      ['web.read', ['url']],
    ]),
  ];
  const { shapes, more } = shapesOf(chains, { shown: 5 });
  assert.deepEqual(
    shapes.map((shape) => [shape.steps.map((step) => step.tool).join('>'), shape.count]),
    [
      ['web.search>web.read', 2],
      ['web.read>web.search', 1],
      ['web.search>web.read', 1],
    ]
  );
  assert.equal(more, 0);
});

test('only the most frequent shapes are shown and the rest is counted', () => {
  const chains = [
    chain('a1', 1, [['a.one', []]]),
    chain('a2', 2, [['a.one', []]]),
    chain('a3', 3, [['a.one', []]]),
    chain('b1', 4, [['b.two', []]]),
    chain('b2', 5, [['b.two', []]]),
    chain('c1', 6, [['c.three', []]]),
  ];
  const { shapes, more } = shapesOf(chains, { shown: 2 });
  assert.deepEqual(
    shapes.map((shape) => shape.count),
    [3, 2]
  );
  assert.equal(more, 1);
  assert.deepEqual(shapesOf([], { shown: 5 }), { shapes: [], more: 0 });
});

test('a shape carries its failures, its retries, its cost, its newest chain and up to five turn ids newest first', () => {
  const steps: Array<[string, Array<string>, ('ok' | 'failed' | 'unknown')?]> = [['web.read', ['url']]];
  const chains = [
    chain('t1', 10, steps, 0.5),
    chain('t2', 20, [['web.read', ['url'], 'failed']], 0.25),
    chain('t3', 30, [['web.read', ['url'], 'ok']], 0.25),
  ];
  const shape = shapesOf(chains, { shown: 5 }).shapes.find(
    (one) => one.steps.length === 1 && one.steps[0]?.tool === 'web.read'
  );
  assert.ok(shape);
  assert.equal(shape.count, 3, 'a failed call of the same names is the same shape');
  assert.equal(shape.failures, 1);
  assert.equal(shape.retries, 0);
  assert.equal(shape.costUsd, 1);
  assert.deepEqual(shape.example, { turnId: 't3', at: 30 });
  assert.deepEqual(shape.turnIds, ['t3', 't2', 't1']);
  const many = Array.from({ length: 7 }, (_, i) => chain(`m${i}`, i, steps));
  assert.deepEqual(shapesOf(many, { shown: 5 }).shapes[0]?.turnIds, ['m6', 'm5', 'm4', 'm3', 'm2']);
});

test('a failed call followed by the same tool counts as a retry of its chain', () => {
  const retried = chain('r1', 1, [
    ['web.read', ['url'], 'failed'],
    ['web.read', ['url']],
  ]);
  const other = chain('r2', 2, [
    ['web.read', ['url'], 'failed'],
    ['message.create', ['text']],
  ]);
  const [first] = shapesOf([retried], { shown: 5 }).shapes;
  const [second] = shapesOf([other], { shown: 5 }).shapes;
  assert.equal(first?.retries, 1);
  assert.equal(second?.retries, 0);
  assert.equal(second?.failures, 1);
});

test('the view lists the repeated shape with its count and example turns', async () => {
  const records = [
    ...turn('t1', NOW - 3 * DAY, LOOKUP),
    ...turn('t2', NOW - 2 * DAY, LOOKUP),
    ...turn('t3', NOW - DAY, LOOKUP),
    ...turn('t4', NOW - HOUR, [['message.create', ['text']]]),
  ];
  const facts = await buildSelfimprovementFacts(base(records));
  assert.equal(facts.days, 14);
  const top = facts.shapes[0];
  assert.deepEqual(
    top?.steps.map((step) => step.tool),
    ['web.search', 'web.read', 'message.create']
  );
  assert.equal(top?.count, 3);
  assert.deepEqual(top?.turnIds, ['t3', 't2', 't1']);
  assert.equal(facts.from, NOW - 14 * DAY);
});

test('chains older than the window are not counted', async () => {
  const records = [...turn('old', NOW - 15 * DAY, LOOKUP), ...turn('new', NOW - DAY, LOOKUP)];
  const facts = await buildSelfimprovementFacts(base(records));
  assert.equal(facts.shapes[0]?.count, 1);
  assert.deepEqual(facts.shapes[0]?.turnIds, ['new']);
});

test('the tools she holds and never called in the window are named, sorted', async () => {
  const records = turn('t1', NOW - HOUR, LOOKUP);
  const facts = await buildSelfimprovementFacts(
    base(records, { granted: ['web.search', 'web.read', 'message.create', 'pings.set', 'diary.post'] })
  );
  assert.deepEqual(facts.unusedTools, ['diary.post', 'pings.set']);
});

test('her skills come with their use counts and an empty journal gives empty shapes', async () => {
  const counts = { discovered: 4, read: 2, tried: 1, succeeded: 1, corrected: 0, declined: 1 };
  const facts = await buildSelfimprovementFacts(base([], { skills: [{ name: 'look-it-up', active: true, counts }] }));
  assert.deepEqual(facts.skills, [{ name: 'look-it-up', active: true, counts }]);
  assert.deepEqual(facts.shapes, []);
  assert.equal(facts.moreShapes, 0);
});

test('a missing journal or one that throws leaves the shapes empty and the rest standing', async () => {
  const none = await buildSelfimprovementFacts(base([], { journal: null, granted: ['web.search'] }));
  assert.deepEqual(none.shapes, []);
  assert.deepEqual(none.unusedTools, ['web.search']);
  const broken = await buildSelfimprovementFacts(
    base([], {
      journal: {
        read: () => {
          throw new Error('disk gone');
        },
      },
    })
  );
  assert.deepEqual(broken.shapes, []);
});

test('the facts hold no line of chat text, only names, codes, counts and ids', async () => {
  const records: Array<Rec> = [
    ...turn('t1', NOW - HOUR, LOOKUP),
    {
      kind: 'turn',
      turnId: 't1',
      occurredAt: iso(NOW - HOUR),
      think: 'PRIVATE THOUGHT',
      posted: [{ id: 'm1', text: 'PRIVATE LINE' }],
      saw: [{ text: 'PRIVATE SEEN' }],
    },
    { kind: 'seen', occurredAt: iso(NOW - HOUR), text: 'PRIVATE SEEN TOO', scope: { channel: 'c1' } },
    {
      kind: 'action',
      name: 'post',
      turnId: 't1',
      opId: 'p1',
      phase: 'started',
      occurredAt: iso(NOW - HOUR),
      intent: 'PRIVATE INTENT',
    },
  ];
  const text = JSON.stringify(await buildSelfimprovementFacts(base(records)));
  assert.equal(text.includes('PRIVATE'), false, text);
  assert.ok(text.includes('web.search') && text.includes('query'));
});

// ---- the board: proposals and the answers she is shown once ----

const SETTINGS = { leaseTtlMinutes: 30, autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 }, projects: {} };

function boardRig(t: { after: (fn: () => void) => void }): { board: Board; clock: { t: number } } {
  const dir = tempDir('nep-selfimp-board-');
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({
      boss: { kind: 'agent', tokenFile: 'clients/boss.token', permissions: [], boardRoles: ['owner'] },
      hand: { kind: 'agent', tokenFile: 'clients/hand.token', permissions: [], boardRoles: ['worker'] },
    })
  );
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const clock = { t: NOW };
  // open.js types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
  const board = openBoard({
    db: handle.db as BoardDb,
    privateDir: dir,
    now: () => clock.t,
    settings: () => SETTINGS,
    builtins: { persona: ['persona'] },
  });
  return { board, clock };
}

/** Files a proposal as `board.propose` does: a dev task for her with her as requester and subscriber. */
function propose(board: Board, title: string, kind: 'skill' | 'fix' | null): string {
  const task = board.call('persona', 'task.add', {
    lane: 'dev',
    title,
    description: 'evidence',
    requester: 'persona:self',
    subscriber: 'persona:self',
    ...(kind === null ? {} : { metadata: { kind } }),
  });
  return task.id;
}

/** Plans the task, has `hand` claim it and ask her a question. Returns the question's text. */
function askHer(board: Board, id: string, text: string): void {
  const proposed = board.call('boss', 'task.show', { id }).task;
  const triaged = board.call('boss', 'task.transition', {
    id,
    status: 'triaged',
    revision: proposed.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' });
  const held = board.call('hand', 'task.claim', { id });
  board.call('hand', 'task.ask', { id, generation: held.lease_generation, to_whom: 'persona:self', text });
}

test('a question and a rejection on her proposals appear in the next wake once, and not again after its completion committed', async (t) => {
  const { board, clock } = boardRig(t);
  const asked = propose(board, 'A skill for lookups', 'skill');
  const rejected = propose(board, 'A fix nobody wants', 'fix');
  clock.t = NOW + HOUR;
  askHer(board, asked, 'Which channel showed it?');
  clock.t = NOW + 2 * HOUR;
  board.call('boss', 'task.approve', { id: rejected, scope: 'plan', decision: 'reject', note: 'Not this week.' });

  const wakeAt = NOW + 3 * HOUR;
  const source = await proposalsOf(board);
  const first = await buildSelfimprovementFacts(
    base([], { now: wakeAt, since: NOW - DAY, proposals: source.entries, outbox: source.outbox })
  );
  assert.deepEqual(
    first.news.questions.map((q) => [q.taskId, q.text, q.answered]),
    [[asked, 'Which channel showed it?', false]]
  );
  assert.deepEqual(
    first.news.reviews.map((r) => [r.taskId, r.decision, r.note]),
    [[rejected, 'reject', 'Not this week.']]
  );
  assert.deepEqual(
    first.news.outbox.map((row) => [row.taskId, row.kind]),
    [[asked, 'needs_answer']]
  );
  assert.equal(first.outboxSeqs.length, 1);
  assert.deepEqual(
    first.proposals.map((p) => [p.id, p.kind, p.status]).sort(),
    [
      [asked, 'skill', 'needs_answer'],
      [rejected, 'fix', 'rejected'],
    ].sort()
  );

  // The wake's completion commits: the outbox rows are marked delivered and the next wake looks from this one on.
  await ackOutbox(board, first.outboxSeqs);
  const again = await proposalsOf(board);
  const second = await buildSelfimprovementFacts(
    base([], { now: wakeAt + 7 * DAY, since: wakeAt, proposals: again.entries, outbox: again.outbox })
  );
  assert.deepEqual(second.news, { questions: [], reviews: [], outbox: [], landed: [] });
  assert.deepEqual(second.outboxSeqs, []);
  assert.equal(second.proposals.length, 2, 'the proposals stay listed with their state');
});

test('a wake that never committed shows the same news again', async (t) => {
  const { board, clock } = boardRig(t);
  const asked = propose(board, 'A skill for lookups', 'skill');
  clock.t = NOW + HOUR;
  askHer(board, asked, 'Which channel showed it?');
  const read = async () => {
    const source = await proposalsOf(board);
    return buildSelfimprovementFacts(
      base([], { now: NOW + 2 * HOUR, since: null, proposals: source.entries, outbox: source.outbox })
    );
  };
  assert.equal((await read()).news.questions.length, 1);
  assert.equal((await read()).news.questions.length, 1);
});

test('proposalsOf lists only what was filed for her and an empty board gives nothing', async (t) => {
  const { board } = boardRig(t);
  assert.deepEqual(await proposalsOf(board), { entries: [], outbox: [] });
  propose(board, 'Hers', 'skill');
  board.call('boss', 'task.add', { title: "the owner's own", lane: 'dev', project: 'core' });
  const { entries } = await proposalsOf(board);
  assert.deepEqual(
    entries.map((entry) => entry.task.title),
    ['Hers']
  );
});

test('the outbox rows of other addressees are never shown to her', async () => {
  const outbox = [
    {
      seq: 1,
      task_id: 'T1',
      to_whom: 'owner',
      kind: 'question',
      payload: { task: 'T1' },
      created_at: iso(NOW),
      delivered_at: null,
    },
    {
      seq: 2,
      task_id: 'T2',
      to_whom: 'persona:self',
      kind: 'done',
      payload: { task: 'T2', status: 'done', close_reason: null },
      created_at: iso(NOW),
      delivered_at: iso(NOW),
    },
    {
      seq: 3,
      task_id: 'T3',
      to_whom: 'persona:self',
      kind: 'failed',
      payload: { task: 'T3', status: 'failed', close_reason: 'budget' },
      created_at: iso(NOW),
      delivered_at: null,
    },
  ];
  const facts = await buildSelfimprovementFacts(base([], { outbox }));
  assert.deepEqual(
    facts.news.outbox.map((row) => [row.seq, row.kind, row.status, row.closeReason]),
    [[3, 'failed', 'failed', 'budget']]
  );
  assert.deepEqual(facts.outboxSeqs, [3]);
});
