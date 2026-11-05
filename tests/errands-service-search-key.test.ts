// src/errands/service.ts: which agents carry the extra key of keys.json to their runner. An agent with commands of its own
// (profile `pathDirs`: the scout's `web-search`) needs it on every backend route, since the command calls OpenRouter itself.
// The store is real over a temp memory database, the errand client is a fake that records each run, keys.json is a temp file.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createErrandService } from '../src/errands/service.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const closers: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const close of closers) await close();
});

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

type Run = { route?: { backend?: string }; secrets?: { openrouterKey?: string } | null };

/** A service with no role key for any agent (empty env), so only keys.json can supply a key. */
function rig(privateDir: string, env: Record<string, string> = {}) {
  const agents = Object.fromEntries(['scout', 'server'].map((n) => [n, { enabled: true, daily: { tasks: 10 } }]));
  const hot = { config: { errands: { maxOpen: 3 }, agents } };
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-errands-key-'), 'data') });
  closers.push(memory.close);
  const runs: Array<Run> = [];
  const client = {
    configured: () => true,
    run: (task: Run) => {
      runs.push(task);
      return Promise.resolve({
        status: 'done' as const,
        result: { text: 'ok', sources: [], files: [] },
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
    env,
    privateDir,
    log: quiet,
    defer: (fn) => fn(),
  });
  return { errands, runs };
}

const ask = (agent: string) => ({
  agent,
  goal: 'find the changelog',
  requester: { userId: '7', kind: 'member' },
  origin: { channelId: 'c1', messageId: 'm1' },
  scope: 'group' as const,
});

/** keys.json with one backend connected, the agent routed to it, and an extra key `ex` named (or not) by the subharness. */
function keys(privateDir: string, backend: 'claude' | 'codex' | 'opencode', agent: string, named: boolean) {
  writeKeysFile(privateDir, {
    extra: { ex: 'sk-extra-SECRET' },
    subharness: { backends: [backend], key: named ? 'ex' : null, modes: {}, uses: { [agent]: backend } },
  });
}

for (const backend of ['claude', 'codex'] as const) {
  test(`the scout's errand on a ${backend} route carries the extra key the subharness names`, async () => {
    // Catches: the key is read only for opencode, so the scout's web-search command answers no-key on this route.
    const privateDir = tempDir('nep-errands-key-');
    keys(privateDir, backend, 'scout', true);
    const { errands, runs } = rig(privateDir);
    errands.submit(ask('scout'));
    await errands.idle();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.route?.backend, backend);
    assert.equal(runs[0]?.secrets?.openrouterKey, 'sk-extra-SECRET');
  });

  test(`the scout still runs on a ${backend} route with no secrets when the subharness names no extra key`, async () => {
    // Catches: a missing key refuses the errand (route-no-key) on a route whose other tools work.
    const privateDir = tempDir('nep-errands-key-');
    keys(privateDir, backend, 'scout', false);
    const { errands, runs } = rig(privateDir);
    errands.submit(ask('scout'));
    await errands.idle();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.route?.backend, backend);
    assert.ok(!runs[0]?.secrets);
  });

  test(`the server agent on a ${backend} route carries no key even when the subharness names one`, async () => {
    // Catches: the key reaches every agent on a backend route, not only those with commands of their own.
    const privateDir = tempDir('nep-errands-key-');
    for (const agent of ['server']) {
      keys(privateDir, backend, agent, true);
      const { errands, runs } = rig(privateDir);
      errands.submit(ask(agent));
      await errands.idle();
      assert.equal(runs.length, 1, agent);
      assert.ok(!runs[0]?.secrets, agent);
    }
  });
}

test('the scout on an opencode route with no named extra key is still refused with route-no-key', async () => {
  // Catches: relaxing the claude and codex case also lets an opencode errand go out with no key to spend.
  const privateDir = tempDir('nep-errands-key-');
  keys(privateDir, 'opencode', 'scout', false);
  const { errands, runs } = rig(privateDir);
  const accepted = errands.submit(ask('scout'));
  assert.ok(accepted.ok);
  await errands.idle();
  assert.equal(runs.length, 0);
  const record = errands.store()?.get(accepted.errand?.id);
  assert.equal(record?.state, 'failed');
  assert.equal(record?.error, 'route-no-key');
});
