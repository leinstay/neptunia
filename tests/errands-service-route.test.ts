// src/errands/service.ts: the core decides an errand's route from keys.json at the moment it dispatches it. The store is
// real over a temp memory database, the errand client is a fake that records each run, and keys.json lives in a temp dir.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createErrandService } from '../src/errands/service.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

// Stage AB: the rig maps scout to a variable of its own; the shipped map names none.
const ENV = { OPENROUTER_AGENT_KEY: 'sk-agent-SECRET' };

const closers: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const close of closers) await close();
});

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function rig(privateDir: string) {
  const hot = {
    config: {
      llm: { keyByRole: { scout: 'OPENROUTER_AGENT_KEY' } },
      errands: { maxOpen: 3 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } } },
    },
  };
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-errands-route-'), 'data') });
  closers.push(memory.close);
  const runs: Array<{ route?: unknown; secrets?: { openrouterKey?: string } | null }> = [];
  const client = {
    configured: () => true,
    run: (task: (typeof runs)[number]) => {
      runs.push(task);
      return Promise.resolve({
        status: 'done' as const,
        result: { text: 'found it', sources: [], files: [] },
        usage: { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 },
      });
    },
    cancel: () => true,
  };
  const stores = createErrandStores({ memoryDb: memory.memoryDb, config: () => hot.config, log: quiet });
  const errands = createErrandService({
    client,
    stores,
    hot,
    env: ENV,
    privateDir,
    log: quiet,
    defer: (fn) => fn(),
  });
  return { errands, runs };
}

const ask = {
  agent: 'scout',
  goal: 'find the changelog',
  requester: { accountId: '7', kind: 'member' },
  origin: { placeId: 'c1', messageId: 'm1' },
  scope: 'group' as const,
};

test('the route of an errand is read from keys.json at each dispatch, and no route goes out while the agent has no backend', async () => {
  // Catches: the route is computed once at start, so "subharness use" waits for a restart, or a null route on the line refuses every errand.
  const privateDir = tempDir('nep-errands-route-');
  writeKeysFile(privateDir, {
    subharness: {
      backends: ['codex', 'claude'],
      key: null,
      modes: {},
      models: { scout: 'claude-opus-5-5' },
      efforts: { scout: 'medium' },
      uses: { scout: 'claude' },
    },
  });
  const { errands, runs } = rig(privateDir);
  errands.submit(ask);
  await errands.idle();
  assert.deepEqual(runs[0]?.route, { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'write' });
  writeKeysFile(privateDir, { subharness: { backends: ['codex'], key: null, modes: { scout: 'read' } } });
  errands.submit(ask);
  await errands.idle();
  assert.deepEqual(runs[1]?.route, { backend: 'codex', model: null, effort: null, mode: 'read' });
  writeKeysFile(privateDir, { subharness: { backends: [], key: null, modes: {} } });
  errands.submit(ask);
  await errands.idle();
  assert.equal(runs.length, 3);
  assert.equal(Object.hasOwn(runs[2] ?? {}, 'route'), false);
});

test("an opencode route carries no credential: the task's secrets hold the extra key it spends, and the role's key stays in the core", async () => {
  // Catches: an opencode errand silently spends the role's key instead of the key it was enabled with.
  const privateDir = tempDir('nep-errands-route-');
  writeKeysFile(privateDir, {
    extra: { oc: 'sk-store-SECRET' },
    subharness: { backends: ['opencode'], key: 'oc', modes: {} },
  });
  const { errands, runs } = rig(privateDir);
  errands.submit(ask);
  await errands.idle();
  assert.deepEqual(runs[0]?.route, { backend: 'opencode', model: null, effort: null, mode: 'write' });
  // An opencode route spends the extra key `subharness.key` names, the key it spent before routes existed, and the
  // route itself holds no credential.
  assert.equal(runs[0]?.secrets?.openrouterKey, 'sk-store-SECRET');
  assert.ok(!JSON.stringify(runs[0]?.route).includes('sk-store-SECRET'));
  assert.ok(!JSON.stringify(runs[0]).includes('sk-agent-SECRET'));
});

test('an errand fails without being sent when the core cannot read config.json for its route', async () => {
  // Catches: the broken file is read as "no route", so the runner falls back to its own view of the switch and runs on another backend.
  // Changed: the route lives in config.json, so the broken file is that one.
  const privateDir = tempDir('nep-errands-route-');
  fs.mkdirSync(path.join(privateDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'config', 'config.json'), '{not json');
  const { errands, runs } = rig(privateDir);
  const accepted = errands.submit(ask);
  assert.ok(accepted.ok);
  await errands.idle();
  assert.equal(runs.length, 0);
  assert.equal(errands.store()?.get(accepted.errand?.id)?.state, 'failed');
});
