// The errand service's start (src/errands/service.ts) over a data folder that holds a folder for an agent the engine
// does not ship: the shared agents are still pinged, and one `error` line names the folder and the code.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createErrandStores } from '../src/errands/store.ts';
import { createErrandService } from '../src/errands/service.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { fixture } from './fixtures/agent-overrides.ts';
import type { Untyped } from '../src/tools/types.ts';

const MEMORIES: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const { close } of MEMORIES) await close();
});

function rig() {
  const f = fixture();
  const calls: Array<{ level: string; msg: string; fields: Record<string, Untyped> }> = [];
  const record =
    (level: string) =>
    (msg: string, fields: Record<string, Untyped> = {}) =>
      calls.push({ level, msg, fields });
  const log = { info: record('info'), warn: record('warn'), error: record('error') };
  const pinged: Array<string> = [];
  const client: Untyped = {
    configured: () => true,
    onLink: () => {},
    ping: async (agent: string) => (pinged.push(agent), { ok: true }),
    run: async () => ({ status: 'done', result: { text: '' }, usage: {} }),
  };
  const hot = { config: { errands: { maxOpen: 3 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  const memory = openTestMemorySync({ dataDir: path.join(f.base, 'memory') });
  MEMORIES.push(memory);
  const stores = createErrandStores({ memoryDb: memory.memoryDb, config: () => hot.config, log });
  const errands = createErrandService({
    client,
    stores,
    hot,
    log,
    defer: (fn) => fn(),
    agentPaths: f.options,
  });
  return { f, calls, pinged, errands };
}

test('errand start pings the shared agent when a stray agent folder sits in the data folder', async (t) => {
  // Bug: the stray folder made the profile load throw, so `errands.start` failed and no errand agent started.
  const { f, pinged, errands } = rig();
  t.after(f.close);
  fs.mkdirSync(path.join(f.dataDir, 'agents', 'ghost'), { recursive: true });
  assert.doesNotThrow(() => errands.start());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pinged, ['scout']);
});

test('errand start logs one error naming the stray folder and the code, and nothing else of it', (t) => {
  // Bug: a refusal that is skipped silently leaves a mistyped personal folder unnoticed.
  const { f, calls, errands } = rig();
  t.after(f.close);
  fs.mkdirSync(path.join(f.dataDir, 'agents', 'ghost'), { recursive: true });
  errands.start();
  const errors = calls.filter((call) => call.level === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.fields.agent, 'ghost');
  assert.equal(errors[0]?.fields.code, 'no-shared-definition');
});

test('errand start logs no error when no folder is refused', (t) => {
  // Bug: the refusal line fires on every start, burying the one that matters.
  const { f, calls, errands } = rig();
  t.after(f.close);
  errands.start();
  assert.equal(calls.filter((call) => call.level === 'error').length, 0);
});
