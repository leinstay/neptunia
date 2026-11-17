// The cutover's done-criteria (PR 6e of the stage 6 cut): one board in the core serves her errands with no ledger
// service anywhere. The core runs in the test process as the units run it (tests/fixtures/core-units.ts), over temporary
// folders and a scripted model; her errand goes to a fake scout runner on its own socket, which answers the runner
// protocol (src/agent-runner/protocol.ts). The tests read ids, statuses, codes and row counts, never a label's wording.
// Changed: the development tasks driven through `neptunia tasks` are gone with the development worker (maintainer,
// 2026-11-16), so only the errand's path stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { endEvent, encodeLine, pongEvent } from '../src/agent-runner/protocol.ts';

import { ANSWER, mention, query, settle, startUnitsCore, startedUnit, until, withRig } from './fixtures/core-units.ts';
import type { Dirs, Llm, Settings } from './fixtures/core-units.ts';

import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { tempDir } from './fixtures/tmp.ts';

const SELF_ID = 'self-id';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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
        if (line.op === 'ping') socket.write(encodeLine(pongEvent({ unit: 'web', busy: false, queued: 0 })));
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

/**
 * The model of her turns: the first request that holds the line of an errand calls `errand.add` for the scout with its
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
    // Plan 2026-11-04-cli-and-memory B1: the door asks the address classifier first; it says yes and is not scripted.
    complete: (messages: unknown, given?: unknown) => {
      if ((given as { purpose?: unknown } | undefined)?.purpose === 'address')
        return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      requests.push(messages);
      const text = JSON.stringify(messages);
      const due = asked.find((item) => !used.has(item.line) && text.includes(item.line));
      if (due === undefined) return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
      used.add(due.line);
      const answer = toolAnswer('<think>a scout errand</think>', [call('errand.add', { goal: due.goal })]);
      // toolAnswer gives the completion the native transport resolves, its text and usage included.
      return Promise.resolve(answer as { text: string; usage: object; estimated: number });
    },
  };
}

/** How many times the core logged `msg` for errand `id`. */
const logged = (logs: ReadonlyArray<Record<string, unknown>>, msg: string, id: unknown): number =>
  logs.filter((entry) => entry.msg === msg && entry.id === id).length;

/** The private layer of an errand rig: the scout on, her `errand.add` granted. */
function errandConfig(): Settings {
  return {
    bot: { access: { 'errand.add': { everyone: false, roles: [], users: [SELF_ID] } } },
    // The scout's end can reach the core while her opening turn still holds the attention, and the result turn is
    // held and tried again every `resultRetrySeconds`, twenty times. At 0 the twenty tries run out within milliseconds
    // when the opening turn's reply waits on a slow interface process, and no result turn runs at all. One second
    // gives the opening turn twenty seconds.
    errands: { maxOpen: 3, resultCooldownSeconds: 0, resultRetrySeconds: 1 },
    agents: { scout: { enabled: true, daily: { tasks: 5 } } },
  };
}

/** Her errands' tasks on the board, oldest first. */
// Changed: the board holds errands only and its tasks have no lane, so every task is one of her errands.
const errandTasks = (dirs: Dirs): Array<Record<string, unknown>> =>
  query(dirs, 'SELECT id, role, status FROM board_tasks ORDER BY created_at, rowid');

test('her errand goes from her errand.add to its scout and back to her once, through the core alone', async () => {
  const sockets = tempDir('nb-');
  // The web unit's socket, where a user unit puts it under the runtime folder (unitPaths).
  fs.mkdirSync(join(sockets, 'neptunia-agent-web'));
  const scout = await fakeScout(join(sockets, 'neptunia-agent-web', 'sock'));
  const env = { NEPTUNIA_UNIT_SCOPE: 'user', XDG_RUNTIME_DIR: sockets, XDG_STATE_HOME: join(sockets, 'state') };
  try {
    const config = errandConfig();
    await withRig({ config }, async ({ dirs, cores, units, logs }) => {
      cores.push(await startUnitsCore(dirs, errandModel([OPENING]), undefined, env));
      const unit = await startedUnit(dirs);
      units.push(unit);
      await (
        await unit.emit(mention('m1', OPENING.line))
      ).acked;
      await until(() => errandTasks(dirs)[0]?.status === 'done', 'the errand to end');
      const id = errandTasks(dirs)[0]?.id;
      await until(() => logged(logs, 'errands: end delivered', id) > 0, 'the end to be delivered');
      await until(() => logged(logs, 'errands: result turn', id) > 0, 'the result turn');
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
