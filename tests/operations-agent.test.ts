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
const profile = (id: string, unit: string, abilities: Array<string>) => ({
  id,
  description: `The ${id} agent.`,
  unit,
  abilities,
  returns: 'text',
  audience: 'any',
  prompt: 'prompt.md',
  limits: { steps: 5, seconds: 60 },
  daily: { tasks: 3 },
  cost: { input: 2, output: 6 },
});

/** A root with the tracked agent `alpha`, a data folder with the local agent `beta`, and a fake environment. */
function rig(config: Record<string, unknown> = {}) {
  const rootDir = tempDir('agent-ops-');
  const dataDir = path.join(rootDir, 'data');
  const write = (dir: string, value: unknown) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(value));
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'prompt');
  };
  write(path.join(rootDir, 'agents', 'alpha'), profile('alpha', 'web', ['search', 'fetch']));
  write(path.join(dataDir, 'agents', 'beta'), profile('beta', 'host', ['shell']));
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

test('agent.list prints each agent with its unit, abilities, route, state and origin', async (t) => {
  const r = rig({
    agents: { alpha: { enabled: true } },
    models: { agents: { via: { alpha: 'codex' }, model: { alpha: 'some-model' } } },
  });
  t.after(r.close);
  const result = await runOp('agent.list', {}, { env: r.env as unknown as OpContext['env'] });
  assert.equal(result.status, 'ok');
  const [alpha, beta] = result.summary.split('\n');
  assert.equal(alpha, 'alpha  web  search, fetch  codex-harness some-model  on  tracked  The alpha agent.');
  assert.equal(beta, 'beta  host  shell  no route  off  local  The beta agent.');
});

test('agent.enable writes agents.<name>.enabled true for a local agent', async (t) => {
  const r = rig();
  t.after(r.close);
  const result = await runOp('agent.enable', { name: 'beta' }, { env: r.env as unknown as OpContext['env'] });
  assert.equal(result.status, 'ok');
  assert.deepEqual(r.writes, [[['agents', 'beta', 'enabled'], true]]);
});

test('agent.disable writes agents.<name>.enabled false', async (t) => {
  const r = rig({ agents: { alpha: { enabled: true } } });
  t.after(r.close);
  await runOp('agent.disable', { name: 'alpha' }, { env: r.env as unknown as OpContext['env'] });
  assert.deepEqual(r.writes, [[['agents', 'alpha', 'enabled'], false]]);
});

test('agent.enable refuses a name that is no agent and writes nothing', async (t) => {
  const r = rig();
  t.after(r.close);
  const result = await runOp('agent.enable', { name: 'ghost' }, { env: r.env as unknown as OpContext['env'] });
  assert.equal(result.status, 'invalid');
  assert.deepEqual(r.writes, []);
});
