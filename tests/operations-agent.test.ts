// The owner's agent operations (src/tools/operations/agent.ts): `agent.list` prints one row per agent on disk, and
// `agent.enable` and `agent.disable` write `agents.<name>.enabled` through the config writer of the operations
// environment. The environment is a fake that records its writes; the agents are a temporary tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOp } from '../src/tools/operations/index.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { OpContext } from '../src/tools/types.ts';

/** A profile.json that passes every check. */
const profile = (id: string) => ({
  id,
  description: `The ${id} agent.`,
  prompt: 'prompt.md',
  limits: { steps: 5, seconds: 60 },
  daily: { tasks: 3 },
  cost: { input: 2, output: 6 },
});

/**
 * A root with the tracked agents `scout` and `server`, a data folder that overlays `server`, and a fake environment.
 * Changed: the agents are named for their units, and a local folder only overlays a tracked agent.
 */
function rig(config: Record<string, unknown> = {}) {
  const rootDir = tempDir('agent-ops-');
  const dataDir = path.join(rootDir, 'data');
  const write = (dir: string, value: unknown) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(value));
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'prompt');
  };
  write(path.join(rootDir, 'agents', 'scout'), profile('scout'));
  write(path.join(rootDir, 'agents', 'server'), profile('server'));
  write(path.join(dataDir, 'agents', 'server'), { description: 'The local server agent.' });
  const writes: Array<[unknown, unknown]> = [];
  const env = {
    hot: { config, rootDir, privateDir: dataDir },
    writeLocalPath: (key: unknown, value: unknown) => {
      writes.push([key, value]);
      return true;
    },
  };
  return { env, writes, close: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test('agent.list prints each agent with its unit, route, state and origin', async (t) => {
  const r = rig({
    agents: { scout: { enabled: true } },
    models: { agents: { via: { scout: 'codex' }, model: { scout: 'some-model' } } },
  });
  t.after(r.close);
  const result = await runOp('agent.list', {}, { env: r.env as unknown as OpContext['env'] });
  assert.equal(result.status, 'ok');
  const [scout, server] = result.summary.split('\n');
  assert.equal(scout, 'scout  scout  codex-harness some-model  on  tracked  The scout agent.');
  assert.equal(server, 'server  server  no route  off  local  The local server agent.');
});

test('agent.enable writes agents.<name>.enabled true for an overlaid agent', async (t) => {
  const r = rig();
  t.after(r.close);
  const result = await runOp('agent.enable', { name: 'server' }, { env: r.env as unknown as OpContext['env'] });
  assert.equal(result.status, 'ok');
  assert.deepEqual(r.writes, [[['agents', 'server', 'enabled'], true]]);
});

test('agent.disable writes agents.<name>.enabled false', async (t) => {
  const r = rig({ agents: { scout: { enabled: true } } });
  t.after(r.close);
  await runOp('agent.disable', { name: 'scout' }, { env: r.env as unknown as OpContext['env'] });
  assert.deepEqual(r.writes, [[['agents', 'scout', 'enabled'], false]]);
});

test('agent.enable refuses a name that is no agent and writes nothing', async (t) => {
  const r = rig();
  t.after(r.close);
  const result = await runOp('agent.enable', { name: 'ghost' }, { env: r.env as unknown as OpContext['env'] });
  assert.equal(result.status, 'invalid');
  assert.deepEqual(r.writes, []);
});
