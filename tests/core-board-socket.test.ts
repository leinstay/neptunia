// The task board on the core's socket (src/core.js, src/board/commands.ts): an agent client connects with its token,
// says hello under `agent` and sends `task.*` commands, which the core answers from the board under the agent's
// name with the board's own rights. The reaper runs on the core's scheduler beat (`board.reapSeconds`) over the
// core's clock, which the test moves by hand. The core runs in the test process as the units run it
// (tests/fixtures/core-units.ts); the agents are clients written by tools/client-token.mjs with `--kind agent`.
// No interface and no model is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreSocketPath } from '../src/interface/socket.ts';
import type { Handoff, TaskRecord, TaskView } from '../src/board/board.ts';
import { startUnitsCore, withRig } from './fixtures/core-units.ts';
import type { Client, Dirs } from './fixtures/core-units.ts';
import { connectAgent } from './fixtures/agent-client.ts';
import type { AgentAnswer, AgentClient } from './fixtures/agent-client.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');
const MINUTE = 60000;
const CONFIG = { board: { leaseTtlMinutes: 30, reapSeconds: 1, briefWaitMs: 1800000 } };
const CLIENTS: ReadonlyArray<Client> = [
  { name: 'boss', kind: 'agent', roles: ['owner'] },
  { name: 'hand', kind: 'agent', roles: ['worker'] },
  { name: 'hand2', kind: 'agent', roles: ['worker'] },
];
const HANDOFF: Handoff = {
  result: 'The parser reads the new tag.',
  evidence: ['the parser tests pass 12 of 12'],
  artifacts: ['src/parser.ts'],
  tests: [{ command: 'node --test tests/parser.test.ts', passed: 12, failed: 0 }],
  open_issues: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The task an answer carries; fails the test when the answer is a refusal or carries none. */
function taskOf(answer: AgentAnswer): TaskRecord {
  assert.equal(answer.status, 'ok', `${answer.status}: ${answer.text}`);
  assert.ok(isRecord(answer.data) && typeof answer.data.id === 'string', 'the answer carries a task');
  // The JSON of a task.add, task.next or task.heartbeat answer is the board's TaskRecord.
  return answer.data as TaskRecord;
}

/** The view of `task.show`. */
async function shown(agent: AgentClient, id: string): Promise<TaskView> {
  const answer = await agent.ask('task.show', { id });
  assert.equal(answer.status, 'ok', `${answer.status}: ${answer.text}`);
  assert.ok(isRecord(answer.data) && isRecord(answer.data.task), 'the answer carries a view');
  // The JSON of a task.show answer is the board's TaskView.
  return answer.data as TaskView;
}

const tokenOf = (dirs: Dirs, name: string): string =>
  readFileSync(join(dirs.privateDir, 'clients', `${name}.token`), 'utf8').trim();

type Board = { agent(name: string): Promise<AgentClient>; advance(minutes: number): void };

/** A core over the rig's folders with the board's settings, its clock moved by `advance`, and agents to connect. */
async function withBoard(body: (board: Board) => Promise<void>): Promise<void> {
  await withRig({ config: CONFIG, clients: CLIENTS }, async ({ dirs, llm, cores }) => {
    let clock = T0;
    cores.push(await startUnitsCore(dirs, llm, () => clock));
    const agents: Array<AgentClient> = [];
    try {
      await body({
        async agent(name) {
          const agent = await connectAgent(coreSocketPath(dirs.dataDir), name, tokenOf(dirs, name));
          agents.push(agent);
          return agent;
        },
        advance: (minutes) => {
          clock += minutes * MINUTE;
        },
      });
    } finally {
      for (const agent of agents) agent.close();
    }
  });
}

/** A dev task the owner files approved at once, triaged by `board.autoTriage` for the role `dev`. */
async function ready(boss: AgentClient, title = 'a task'): Promise<TaskRecord> {
  return taskOf(await boss.ask('task.add', { title, lane: 'dev', project: 'core', auto: true, no_brief: true }));
}

/** Waits until the core's reaper took the lease of `id` back to approved. */
async function reclaimed(boss: AgentClient, id: string): Promise<void> {
  let status = '';
  const deadline = Date.now() + 8000;
  while (status !== 'approved') {
    if (Date.now() > deadline) throw new Error(`the reaper never took ${id} back; it is ${status}`);
    status = (await shown(boss, id)).task.status;
    if (status !== 'approved') await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('an agent with the worker role claims through task.next, heartbeats and submits over the socket', async () => {
  await withBoard(async (board) => {
    const boss = await board.agent('boss');
    const hand = await board.agent('hand');
    const task = await ready(boss);
    const held = taskOf(await hand.ask('task.next', { lane: 'dev', role: 'dev' }));
    assert.equal(held.id, task.id);
    assert.equal(held.lease_owner, 'hand');
    const generation = held.lease_generation;
    board.advance(10);
    const beat = taskOf(await hand.ask('task.heartbeat', { id: held.id, generation }));
    assert.ok(beat.lease_expires_at !== null && held.lease_expires_at !== null);
    assert.ok(beat.lease_expires_at > held.lease_expires_at, 'the heartbeat extends the lease');
    const submitted = await hand.ask('task.submit', { id: held.id, generation, handoff: HANDOFF });
    assert.equal(submitted.status, 'ok', submitted.text);
    const view = await shown(boss, task.id);
    assert.equal(view.task.status, 'needs_validation');
    assert.equal(view.handoff?.result, HANDOFF.result);
  });
});

test('the socket refuses a submit of the holder that carries no generation, and the task is unchanged', async () => {
  await withBoard(async (board) => {
    const boss = await board.agent('boss');
    const hand = await board.agent('hand');
    const task = await ready(boss);
    const held = taskOf(await hand.ask('task.next', { lane: 'dev', role: 'dev' }));
    assert.equal((await hand.ask('task.submit', { id: held.id, handoff: HANDOFF })).status, 'invalid');
    const view = await shown(boss, task.id);
    assert.equal(view.task.status, 'in_progress');
    assert.equal(view.task.revision, held.revision);
    assert.equal(view.handoff, null);
  });
});

test('of two agents asking task.next at once for the one ready task, exactly one gets it', async () => {
  await withBoard(async (board) => {
    const boss = await board.agent('boss');
    const hand = await board.agent('hand');
    const hand2 = await board.agent('hand2');
    const task = await ready(boss);
    const answers = await Promise.all([
      hand.ask('task.next', { lane: 'dev', role: 'dev' }),
      hand2.ask('task.next', { lane: 'dev', role: 'dev' }),
    ]);
    assert.deepEqual(
      answers.map((answer) => answer.status),
      ['ok', 'ok']
    );
    const winners = answers.filter((answer) => answer.data !== null);
    assert.equal(winners.length, 1);
    const holder = (await shown(boss, task.id)).task.lease_owner;
    assert.ok(holder === 'hand' || holder === 'hand2');
    assert.equal(taskOf(winners[0] ?? { status: 'none', text: '', data: null }).lease_owner, holder);
  });
});

test('a lease that expires while its worker is cut off is reclaimed at the next tick, and the late heartbeat is refused', async () => {
  await withBoard(async (board) => {
    const boss = await board.agent('boss');
    const hand = await board.agent('hand');
    const task = await ready(boss);
    const held = taskOf(await hand.ask('task.next', { lane: 'dev', role: 'dev' }));
    hand.close();
    board.advance(31);
    await reclaimed(boss, task.id);
    const back = await board.agent('hand');
    const late = await back.ask('task.heartbeat', { id: held.id, generation: held.lease_generation });
    assert.equal(late.status, 'stale-lease');
    const view = await shown(boss, task.id);
    assert.equal(view.task.status, 'approved');
    assert.equal(view.task.lease_owner, null);
  });
});

test("a late worker's submit after a reclaim is refused over the socket and the new holder's task is unchanged", async () => {
  await withBoard(async (board) => {
    const boss = await board.agent('boss');
    const hand = await board.agent('hand');
    const hand2 = await board.agent('hand2');
    const task = await ready(boss);
    const old = taskOf(await hand.ask('task.next', { lane: 'dev', role: 'dev' }));
    board.advance(31);
    await reclaimed(boss, task.id);
    const fresh = taskOf(await hand2.ask('task.next', { lane: 'dev', role: 'dev' }));
    assert.ok(fresh.lease_generation > old.lease_generation);
    const before = await shown(boss, task.id);
    const late = await hand.ask('task.submit', { id: old.id, generation: old.lease_generation, handoff: HANDOFF });
    assert.equal(late.status, 'stale-lease');
    const after = await shown(boss, task.id);
    assert.equal(after.task.status, 'in_progress');
    assert.equal(after.task.lease_owner, 'hand2');
    assert.equal(after.task.revision, before.task.revision);
    assert.equal(after.handoff, null);
    assert.equal(after.results.length, before.results.length);
  });
});

test('a worker agent may not approve: the core answers the board refusal and the plan stays triaged', async () => {
  await withBoard(async (board) => {
    const boss = await board.agent('boss');
    const hand = await board.agent('hand');
    const added = taskOf(await boss.ask('task.add', { title: 'a plan', lane: 'dev', project: 'core' }));
    const triaged = taskOf(
      await boss.ask('task.transition', {
        id: added.id,
        status: 'triaged',
        revision: added.revision,
        set: { role: 'dev', estimate: 20, budget: 2 },
      })
    );
    assert.equal((await hand.ask('task.approve', { id: triaged.id, scope: 'plan' })).status, 'forbidden');
    assert.equal((await shown(boss, added.id)).task.status, 'triaged');
  });
});
