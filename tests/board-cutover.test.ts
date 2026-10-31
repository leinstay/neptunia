// The cutover's done-criteria (PR 6e of the stage 6 cut): one board in the core serves the development work and her
// errands with no ledger service anywhere. The core runs in the test process as the units run it
// (tests/fixtures/core-units.ts), over temporary folders and a scripted model; the development agents are
// `neptunia task` children over the core's socket with their tokens; her errand goes to a fake scout runner on its own
// socket, which answers the runner protocol (src/agent-runner/protocol.js). A listening socket stands where the ledger
// mirror's was, so any connection to it shows. No dollar cap is read: a spent `daily.usd` of an agent changes nothing.
// The tests read ids, statuses, generations, codes, exit codes and row counts, never a label's wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { endEvent, encodeLine, pongEvent } from '../src/agent-runner/protocol.js';
import { coreSocketPath } from '../src/interface/socket.ts';
import type { Handoff, TaskRecord, TaskView } from '../src/board/board.ts';
import {
  ANSWER,
  mention,
  query,
  settle,
  spawnCli,
  startUnitsCore,
  startedUnit,
  until,
  withRig,
} from './fixtures/core-units.ts';
import type { Client, Dirs, Exit, Llm, Settings } from './fixtures/core-units.ts';
import { connectAgent } from './fixtures/agent-client.ts';
import type { AgentAnswer } from './fixtures/agent-client.ts';
import { call, toolAnswer } from './fixtures/tool-answers.js';
import { tempDir } from './fixtures/tmp.js';

const T0 = Date.parse('2026-10-31T12:00:00Z');
const MINUTE = 60000;
const SELF_ID = 'self-id';
const HANDOFF: Handoff = {
  result: 'The parser reads the zeta tag.',
  evidence: ['the parser tests pass 12 of 12'],
  artifacts: ['src/parser.ts'],
  tests: [{ command: 'node --test tests/parser.test.ts', passed: 12, failed: 0 }],
  open_issues: [],
};
/** The development principals of a deployment, with the roles the owner's answers of 2026-10-31 give them. */
const DEV_CLIENTS: ReadonlyArray<Client> = [
  { name: 'lead', kind: 'agent', roles: ['owner'] },
  { name: 'thinker', kind: 'agent', roles: ['reviewer'] },
  { name: 'dispatcher', kind: 'agent', roles: ['worker'] },
  { name: 'dispatcher2', kind: 'agent', roles: ['worker'] },
];
const BOARD = { leaseTtlMinutes: 30, reapSeconds: 1, briefWaitMs: 1800000 };

type Run = Exit & { stdout: string; stderr: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const tokenOf = (dirs: Dirs, name: string): string =>
  readFileSync(join(dirs.privateDir, 'clients', `${name}.token`), 'utf8').trim();

/** Runs `neptunia task ...args` as the agent `name` to its end, with its input closed. */
async function task(dirs: Dirs, name: string, args: ReadonlyArray<string>, ms = 15000): Promise<Run> {
  const cli = spawnCli(dirs, ['task', ...args], { NEPTUNIA_TASK_TOKEN: tokenOf(dirs, name) });
  cli.end();
  const timer = setTimeout(() => void cli.kill(), ms);
  const exit = await cli.exited;
  clearTimeout(timer);
  assert.equal(exit.signal, null, `neptunia task ${args.join(' ')} did not end:\n${cli.stderr().slice(-2000)}`);
  return { ...exit, stdout: cli.stdout(), stderr: cli.stderr() };
}

/** `neptunia task ...args` that must succeed; its standard output. */
async function ok(dirs: Dirs, name: string, args: ReadonlyArray<string>): Promise<string> {
  const run = await task(dirs, name, args);
  assert.equal(run.code, 0, `${name}: task ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

/** `neptunia task show <id> --json` as the lead. */
async function shown(dirs: Dirs, id: string): Promise<TaskView> {
  const view: unknown = JSON.parse(await ok(dirs, 'lead', ['show', id, '--json']));
  assert.ok(isRecord(view) && isRecord(view.task), 'show --json answers a view');
  // The JSON of `task show --json` is the board's TaskView.
  return view as TaskView;
}

/** `neptunia task next` as `name`: the task it holds, with its generation. */
async function next(dirs: Dirs, name: string): Promise<TaskRecord> {
  const held: unknown = JSON.parse(await ok(dirs, name, ['next', '--lane', 'dev', '--role', 'dev', '--json']));
  assert.ok(isRecord(held) && typeof held.id === 'string', `${name} got a task`);
  // The JSON of `task next --json` is the board's TaskRecord.
  return held as TaskRecord;
}

/** A socket that only counts who connects to it: where the ledger mirror's socket was. */
async function listening(path: string): Promise<{ connections: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = net.createServer((socket) => {
    count += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    connections: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Runner = { runs: Array<Record<string, unknown>>; close: () => Promise<void> };

/** A scout runner on `path`: it answers a ping, and ends every run it gets as done with `usd` spent. */
async function fakeScout(path: string, usd = 0.2): Promise<Runner> {
  const runs: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line: unknown = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!isRecord(line)) continue;
        if (line.op === 'ping') socket.write(encodeLine(pongEvent({ profile: 'scout', busy: false, queued: 0 })));
        if (line.op === 'run' && typeof line.id === 'string') {
          runs.push(line);
          const result = { text: 'nine to five', sources: [], files: [] };
          const usage = { input: 1000, output: 200, usd, steps: 2, seconds: 3 };
          socket.write(encodeLine(endEvent({ id: line.id, status: 'done', result, usage })));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { runs, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** One errand she hands off: the member's line that asks for it, and the goal she gives the scout. */
type Asked = { line: string; goal: string };
const OPENING: Asked = { line: 'Ask the scout when the library opens.', goal: 'find the opening hours of the library' };
const CLOSING: Asked = { line: 'And when does it close?', goal: 'find the closing hours of the library' };

/**
 * The model of her turns: the first request that holds the line of an errand calls `errand.run` for the scout with its
 * goal, and every other request is answered with one message. Her result turn shows the asking line again, so it gets
 * the message.
 */
function errandModel(asked: ReadonlyArray<Asked>): Llm {
  const requests: Array<unknown> = [];
  const used = new Set<string>();
  // The rig's Llm records the options of each call since PR 7a; this model keeps none.
  return {
    requests,
    options: [],
    complete: (messages: unknown) => {
      requests.push(messages);
      const text = JSON.stringify(messages);
      const due = asked.find((item) => !used.has(item.line) && text.includes(item.line));
      if (due === undefined) return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
      used.add(due.line);
      const answer = toolAnswer('<think>a scout errand</think>', [
        call('errand.run', { agent: 'scout', goal: due.goal }),
      ]);
      // toolAnswer gives the completion the native transport resolves, its text and usage included.
      return Promise.resolve(answer as { text: string; usage: object; estimated: number });
    },
  };
}

/** How many times the core logged `msg` for errand `id`. */
const logged = (logs: ReadonlyArray<Record<string, unknown>>, msg: string, id: unknown): number =>
  logs.filter((entry) => entry.msg === msg && entry.id === id).length;

/** The private layer of an errand rig: the scout on `runner`, her `errand.run` granted, and `extra` over it. */
function errandConfig(runner: string, out: string, extra: Settings = {}): Settings {
  return {
    bot: { access: { 'errand.run': { everyone: false, roles: [], users: [SELF_ID] } } },
    errands: { maxOpen: 3, resultCooldownSeconds: 0, resultRetrySeconds: 0 },
    ...extra,
    agents: {
      scout: { enabled: true, socket: runner, out, daily: { tasks: 5 } },
      ...(isRecord(extra.agents) ? extra.agents : {}),
    },
  };
}

/** Her errand-lane tasks on the board, oldest first. */
const errandTasks = (dirs: Dirs): Array<Record<string, unknown>> =>
  query(dirs, "SELECT id, role, status FROM board_tasks WHERE lane = 'errand' ORDER BY created_at, rowid");

test('a development task goes from filing to done through neptunia task alone, with no ledger anywhere', async () => {
  await withRig({ config: { board: BOARD }, clients: DEV_CLIENTS }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const id = (
      await ok(dirs, 'lead', [
        'add',
        '--lane',
        'dev',
        '--project',
        'core',
        '--title',
        'Read the zeta tag',
        '--risk',
        'low',
        '--auto',
      ])
    ).trim();
    assert.equal((await shown(dirs, id)).task.status, 'triaged', 'filed by the lead, it waits for its brief');
    await ok(dirs, 'thinker', ['update', id, '--description', 'Read the zeta tag in src/parser.ts.']);
    await ok(dirs, 'lead', ['approve', id]);
    assert.equal((await shown(dirs, id)).task.status, 'approved');
    const held = await next(dirs, 'dispatcher');
    assert.equal(held.id, id);
    assert.ok(held.lease_generation >= 1, 'the claim carries a generation');
    const generation = String(held.lease_generation);
    await ok(dirs, 'dispatcher', ['heartbeat', id, '--generation', generation]);
    const handoff = join(dirs.root, 'handoff.json');
    writeFileSync(handoff, JSON.stringify(HANDOFF));
    await ok(dirs, 'dispatcher', ['submit', id, '--generation', generation, '--handoff', handoff]);
    assert.equal((await shown(dirs, id)).task.status, 'needs_validation');
    // The reviewer merges once CI is green, which it records on the task (src/board/machine.ts).
    await ok(dirs, 'thinker', ['update', id, '--meta', 'ci=green']);
    await ok(dirs, 'thinker', ['review', id, '--accept']);
    const done = await shown(dirs, id);
    assert.equal(done.task.status, 'done');
    assert.equal(done.task.lease_owner, null);
    assert.equal(done.handoff?.result, HANDOFF.result);
    assert.deepEqual(
      done.approvals.map((row) => [row.principal, row.decision]).filter(([, decision]) => decision === 'accept'),
      [['thinker', 'accept']]
    );
  });
});

test("a late worker's submit after a reclaim is refused stale-lease through neptunia task, and the new holder's task is unchanged", async () => {
  await withRig({ config: { board: BOARD }, clients: DEV_CLIENTS }, async ({ dirs, llm, cores }) => {
    let clock = T0;
    cores.push(await startUnitsCore(dirs, llm, () => clock));
    const id = (
      await ok(dirs, 'lead', ['add', '--lane', 'dev', '--project', 'core', '--title', 'late', '--auto', '--no-brief'])
    ).trim();
    const old = await next(dirs, 'dispatcher');
    clock += 31 * MINUTE;
    await until(
      () => query(dirs, 'SELECT status FROM board_tasks WHERE id = ?', id)[0]?.status === 'approved',
      `the reclaim of ${id}`
    );
    const fresh = await next(dirs, 'dispatcher2');
    assert.ok(fresh.lease_generation > old.lease_generation);
    const before = await shown(dirs, id);
    const handoff = join(dirs.root, 'handoff.json');
    writeFileSync(handoff, JSON.stringify(HANDOFF));
    const late = await task(dirs, 'dispatcher', [
      'submit',
      id,
      '--generation',
      String(old.lease_generation),
      '--handoff',
      handoff,
    ]);
    assert.equal(late.code, 1);
    assert.ok(late.stderr.startsWith('stale-lease:'), late.stderr);
    const after = await shown(dirs, id);
    assert.equal(after.task.status, 'in_progress');
    assert.equal(after.task.lease_owner, 'dispatcher2');
    assert.equal(after.task.revision, before.task.revision);
    assert.equal(after.handoff, null);
  });
});

test('her errand goes from her errand.run to its scout and back to her once, through the core alone', async () => {
  const sockets = tempDir('nb-');
  const scout = await fakeScout(join(sockets, 'r.sock'));
  try {
    const config = errandConfig(join(sockets, 'r.sock'), join(sockets, 'out'));
    await withRig({ config }, async ({ dirs, cores, units, logs }) => {
      cores.push(await startUnitsCore(dirs, errandModel([OPENING])));
      const unit = await startedUnit(dirs);
      units.push(unit);
      await (
        await unit.emit(mention('m1', OPENING.line))
      ).acked;
      await until(() => errandTasks(dirs)[0]?.status === 'done', 'the errand to end');
      const id = errandTasks(dirs)[0]?.id;
      await until(() => logged(logs, 'errands: end delivered', id) > 0, 'the end to be delivered');
      await settle(800);
      assert.deepEqual(
        errandTasks(dirs).map((row) => [row.id, row.role, row.status]),
        [[scout.runs[0]?.id, 'scout', 'done']]
      );
      assert.equal(scout.runs.length, 1, 'the scout got the errand once');
      assert.equal(logged(logs, 'errands: result turn', id), 1, 'one result turn');
      // The core's stop flushes the writer, so the outbox row of the end shows its delivery after it.
      await units.pop()?.kill();
      await cores.pop()?.stop();
      const outbox = query(
        dirs,
        "SELECT COUNT(*) AS n, SUM(delivered_at IS NULL) AS waiting FROM board_outbox WHERE task_id = ? AND to_whom = 'persona'",
        id
      );
      // One end row, marked delivered, so a restart opens no second result turn.
      assert.deepEqual(outbox, [{ n: 1, waiting: 0 }]);
    });
  } finally {
    await scout.close();
  }
});

test('an errand from her call to its end opens no connection to a socket set as agents.ledger.socket', async () => {
  const sockets = tempDir('nb-');
  const scout = await fakeScout(join(sockets, 'r.sock'));
  const ledger = await listening(join(sockets, 'l.sock'));
  try {
    const config = errandConfig(join(sockets, 'r.sock'), join(sockets, 'out'), {
      agents: { ledger: { socket: join(sockets, 'l.sock') } },
    });
    await withRig({ config }, async ({ dirs, cores, units }) => {
      cores.push(await startUnitsCore(dirs, errandModel([OPENING])));
      const unit = await startedUnit(dirs);
      units.push(unit);
      await (
        await unit.emit(mention('m1', OPENING.line))
      ).acked;
      await until(() => errandTasks(dirs)[0]?.status === 'done', 'the errand to end');
      await settle(800);
      assert.equal(scout.runs.length, 1);
      assert.equal(ledger.connections(), 0);
    });
  } finally {
    await ledger.close();
    await scout.close();
  }
});

test('a spent agents.scout.daily.usd stops none of her errands: the second one runs after the first spent past it', async () => {
  const sockets = tempDir('nb-');
  const scout = await fakeScout(join(sockets, 'r.sock'), 5);
  try {
    const config = errandConfig(join(sockets, 'r.sock'), join(sockets, 'out'), {
      agents: {
        scout: {
          enabled: true,
          socket: join(sockets, 'r.sock'),
          out: join(sockets, 'out'),
          daily: { tasks: 5, usd: 0.01 },
        },
      },
    });
    await withRig({ config }, async ({ dirs, cores, units, logs }) => {
      cores.push(await startUnitsCore(dirs, errandModel([OPENING, CLOSING])));
      const unit = await startedUnit(dirs);
      units.push(unit);
      await (
        await unit.emit(mention('m1', OPENING.line))
      ).acked;
      await until(() => errandTasks(dirs)[0]?.status === 'done', 'the first errand to end');
      const first = errandTasks(dirs)[0]?.id;
      await until(() => logged(logs, 'errands: result turn', first) > 0, 'the result turn of the first errand');
      await (
        await unit.emit(mention('m2', CLOSING.line, Date.now() + 1000))
      ).acked;
      await until(
        () => scout.runs.length === 2,
        () => `a second run; the scout has ${scout.runs.length}`
      );
      await until(
        () => errandTasks(dirs).length === 2 && errandTasks(dirs).every((row) => row.status === 'done'),
        'both errands to end'
      );
      assert.deepEqual(
        errandTasks(dirs).map((row) => row.id),
        scout.runs.map((run) => run.id)
      );
    });
  } finally {
    await scout.close();
  }
});

test('a spent agents.dev.daily.usd and an attempt past its budget_usd stop nothing on the board', async () => {
  const config = {
    board: { ...BOARD, autoTriage: { role: 'dev', budget: 2, steps: 80, estimate: 30 } },
    agents: { dev: { daily: { usd: 0.01 } } },
  };
  await withRig({ config, clients: DEV_CLIENTS }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const socket = coreSocketPath(dirs.dataDir);
    const lead = await connectAgent(socket, 'lead', tokenOf(dirs, 'lead'));
    const hand = await connectAgent(socket, 'dispatcher', tokenOf(dirs, 'dispatcher'));
    try {
      const add = (title: string): Promise<AgentAnswer> =>
        lead.ask('task.add', { title, lane: 'dev', project: 'core', auto: true, no_brief: true });
      const first = await add('first');
      const second = await add('second');
      assert.deepEqual([first.status, second.status], ['ok', 'ok']);
      const held = await hand.ask('task.next', { lane: 'dev', role: 'dev' });
      assert.ok(
        isRecord(held.data) && typeof held.data.id === 'string' && typeof held.data.lease_generation === 'number'
      );
      const { id, lease_generation: generation } = held.data;
      const attempt = await hand.ask('task.attempt.start', { task_id: id, role: 'dev' });
      assert.ok(isRecord(attempt.data) && typeof attempt.data.id === 'string', attempt.text);
      const ended = await hand.ask('task.attempt.end', {
        attempt_id: attempt.data.id,
        generation,
        cost_usd: 9,
        outcome: 'done',
      });
      assert.equal(ended.status, 'ok', ended.text);
      const after = await lead.ask('task.show', { id });
      assert.ok(isRecord(after.data) && isRecord(after.data.task));
      assert.equal(after.data.task.status, 'in_progress', 'nine dollars over a two-dollar budget stop nothing');
      const again = await hand.ask('task.next', { lane: 'dev', role: 'dev' });
      assert.ok(isRecord(again.data), 'the spent day hands out the next task');
      assert.notEqual(again.data.id, id);
    } finally {
      hand.close();
      lead.close();
    }
  });
});
