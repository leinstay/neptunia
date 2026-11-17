// Tests for the dispatch of an errand that names no agent (src/errands/service.ts with src/errands/store.ts): the
// service builds the roster at the moment of the dispatch, asks the dispatcher (a FAKE here), assigns the agent and
// only then runs the errand. An errand no agent takes ends `failed` with `no-agent` or `dispatch-failed` and reaches
// her as any failed errand does. Over a real errand store on a test memory database, the tracked agents of agents/,
// a FAKE errand client and a FAKE dispatcher.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createErrandStores } from '../src/errands/store.ts';
import { createErrandService } from '../src/errands/service.ts';
import type { DispatchAnswer, RosterEntry } from '../src/errands/dispatcher.ts';
import type { ErrandRecord } from '../src/errands/types.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { tempDir } from './fixtures/tmp.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';

const OPENED: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const { close } of OPENED) await close();
});

const VIA = { scout: 'claude', fetch: 'claude', code: 'claude', server: 'claude' };

function baseConfig() {
  return {
    errands: { maxOpen: 5 },
    models: { agents: { via: { ...VIA } as Record<string, string> } },
    agents: {
      scout: { enabled: true, daily: { tasks: 10 } },
      fetch: { enabled: true, daily: { tasks: 10 } },
      code: { enabled: false },
      server: { enabled: true, daily: { tasks: 10 } },
    } as Record<string, Record<string, unknown>>,
  };
}

/** A fake errand client: records each run, ends it at once, and lets the test report a unit down. */
function fakeClient(config: () => ReturnType<typeof baseConfig>) {
  const runs: Array<Record<string, unknown>> = [];
  let link: ((event: { unit: string; up: boolean }) => void) | null = null;
  return {
    runs,
    configured: (agent: string) => config().agents[agent]?.enabled === true,
    onLink(listener: (event: { unit: string; up: boolean }) => void) {
      link = listener;
    },
    down(unit: string) {
      link?.({ unit, up: false });
    },
    run(task: Record<string, unknown>) {
      runs.push(task);
      return Promise.resolve({ status: 'done' as const, result: { text: 'done' }, usage: { usd: 0 } });
    },
    cancel: () => true,
  };
}

/** A fake dispatcher: records each roster and answers `answer` (a function of the roster). */
function fakeDispatch(answer: (roster: ReadonlyArray<RosterEntry>) => DispatchAnswer) {
  const asked: Array<{ goal: string; roster: Array<string> }> = [];
  const dispatch = ({ goal, roster }: { goal: string; roster: ReadonlyArray<RosterEntry> }) => {
    asked.push({ goal, roster: roster.map((entry) => entry.name) });
    return Promise.resolve(answer(roster));
  };
  return { asked, dispatch };
}

function rig({
  answer = (roster: ReadonlyArray<RosterEntry>): DispatchAnswer => ({ ok: true, agent: roster[0]?.name ?? null }),
  dataDir = path.join(tempDir('nep-dispatch-'), 'data'),
  defer = (fn: () => void) => fn(),
}: {
  answer?: (roster: ReadonlyArray<RosterEntry>) => DispatchAnswer;
  dataDir?: string;
  defer?: (fn: () => void) => void;
} = {}) {
  const hot = { config: baseConfig() };
  const memory = openTestMemorySync({ dataDir });
  OPENED.push(memory);
  const agentPaths = { dataDir: tempDir('nep-dispatch-agents-') };
  const stores = createErrandStores({ memoryDb: memory.memoryDb, config: () => hot.config, agentPaths });
  const client = fakeClient(() => hot.config);
  const { asked, dispatch } = fakeDispatch(answer);
  const finished: Array<ErrandRecord> = [];
  const errands = createErrandService({
    client,
    stores,
    hot,
    agentPaths,
    dispatch,
    defer,
    onFinished: (errand: ErrandRecord) => {
      finished.push(errand);
    },
  } as never);
  return { hot, client, asked, errands, finished, stores, dataDir, memory };
}

const hers = (kind = 'member', agent: string | null = null) => ({
  agent,
  goal: 'find the changelog',
  requester: { accountId: kind === 'persona' ? null : '7', kind },
  origin: { placeId: 'c1', messageId: 'm1' },
  scope: 'group' as const,
});

test('an errand with no agent is queued, the dispatcher picks from the roster, and the chosen agent runs it', async () => {
  const { asked, client, errands, stores } = rig({ answer: () => ({ ok: true, agent: 'fetch' }) });
  await withCapturedLogs(async () => {
    const submitted = errands.submit(hers());
    assert.equal(submitted.ok, true);
    await errands.idle();
    const id = submitted.ok ? submitted.errand.id : '';
    // Changed: a member asked, and the roster holds every enabled agent with a route whoever asks, the server agent
    // too. Only the disabled one is off it. Bug: a member's errand never reaches an agent the owner keeps for himself.
    assert.deepEqual(asked, [{ goal: 'find the changelog', roster: ['fetch', 'scout', 'server'] }]);
    assert.deepEqual(
      client.runs.map((run) => run.agent),
      ['fetch']
    );
    const record = stores.get()?.get(id);
    assert.deepEqual([record?.agent, record?.state], ['fetch', 'done']);
  });
});

test('the roster drops an agent with no route', async () => {
  const { hot, asked, errands } = rig();
  delete hot.config.models.agents.via.fetch;
  await withCapturedLogs(async () => {
    errands.submit(hers('owner'));
    await errands.idle();
  });
  assert.deepEqual(asked[0]?.roster, ['scout', 'server']);
});

test('the roster drops an agent whose daily tasks are spent and every agent of a unit whose runner is down', async () => {
  const { hot, client, asked, errands } = rig();
  hot.config.agents.scout = { enabled: true, daily: { tasks: 1 } };
  await withCapturedLogs(async () => {
    errands.submit(hers('owner', 'scout'));
    await errands.idle();
    client.down('host');
    errands.submit(hers('owner'));
    await errands.idle();
  });
  assert.deepEqual(asked, [{ goal: 'find the changelog', roster: ['fetch'] }]);
});

test('an errand the owner named for an agent skips the dispatcher', async () => {
  const { asked, client, errands } = rig();
  await withCapturedLogs(async () => {
    errands.submit(hers('owner', 'server'));
    await errands.idle();
  });
  assert.deepEqual(asked, []);
  assert.deepEqual(
    client.runs.map((run) => run.agent),
    ['server']
  );
});

test('no fitting agent, a failed dispatcher request and an empty roster each end the errand failed and reach her', async () => {
  // Bug caught: an errand nobody took stays queued forever, or ends without the turn that tells her.
  const none = rig({ answer: () => ({ ok: true, agent: null }) });
  const broken = rig({ answer: () => ({ ok: false }) });
  const empty = rig();
  const { agents } = empty.hot.config;
  for (const name of ['scout', 'fetch', 'server']) agents[name] = { enabled: false };
  await withCapturedLogs(async () => {
    for (const one of [none, broken, empty]) {
      one.errands.submit(hers());
      await one.errands.idle();
    }
  });
  assert.deepEqual(
    [none, broken, empty].map(({ finished: [first] }) => [first?.state, first?.error, first?.agent]),
    [
      ['failed', 'no-agent', null],
      ['failed', 'dispatch-failed', null],
      ['failed', 'no-agent', null],
    ]
  );
  assert.equal(empty.asked.length, 0, 'an empty roster asks no model');
  assert.deepEqual(
    [none, broken, empty].map(({ client }) => client.runs.length),
    [0, 0, 0]
  );
});

test('a wait for an errand with no agent covers the dispatch and answers its failure', async () => {
  const { errands } = rig({ answer: () => ({ ok: true, agent: null }), defer: (fn) => setImmediate(fn) });
  await withCapturedLogs(async () => {
    const submitted = errands.submit(hers('persona'));
    const id = submitted.ok ? submitted.errand.id : '';
    const waited = await errands.wait({ id, ms: 60_000 });
    assert.deepEqual([waited.ended, waited.errand?.state, waited.errand?.error], [true, 'failed', 'no-agent']);
  });
});

test('an errand still queued with no agent when the core stopped is failed at start like any open errand', async () => {
  const first = rig({ defer: () => {} });
  let id = '';
  await withCapturedLogs(async () => {
    const submitted = first.errands.submit(hers());
    id = submitted.ok ? submitted.errand.id : '';
    await first.stores.get()?.flush({ final: true });
  });
  await first.memory.close();
  OPENED.splice(OPENED.indexOf(first.memory), 1);
  const second = rig({ dataDir: first.dataDir });
  await withCapturedLogs(() => {
    assert.equal(second.errands.start(), 1);
    return Promise.resolve();
  });
  const record = second.stores.get()?.get(id);
  assert.deepEqual([record?.state, record?.error], ['failed', 'restarted']);
});

test('the board keeps the agent the dispatcher assigned, so the errand reads back with it', async () => {
  // Bug caught: the task row keeps the empty agent it was filed with, and every finished errand reloads with none.
  const first = rig({ answer: () => ({ ok: true, agent: 'fetch' }) });
  let id = '';
  await withCapturedLogs(async () => {
    const submitted = first.errands.submit(hers());
    id = submitted.ok ? submitted.errand.id : '';
    await first.errands.idle();
    await first.stores.get()?.flush({ final: true });
  });
  await first.memory.close();
  OPENED.splice(OPENED.indexOf(first.memory), 1);
  const second = rig({ dataDir: first.dataDir });
  const record = second.stores.get()?.get(id);
  assert.deepEqual([record?.agent, record?.state], ['fetch', 'done']);
});
