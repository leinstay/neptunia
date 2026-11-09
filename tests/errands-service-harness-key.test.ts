// src/errands/service.ts: an OpenRouter key goes into a dispatch only on the OpenCode route (the extra key keys.json
// names). A dispatch on claude or codex carries no `secrets.openrouterKey`, for any agent, whether or not the
// subharness names a key. The store is real over a temp memory database, the errand client is a fake that records each run.
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

function rig(privateDir: string) {
  const agents = Object.fromEntries(['scout', 'server'].map((n) => [n, { enabled: true, daily: { tasks: 10 } }]));
  const hot = { config: { errands: { maxOpen: 3 }, agents } };
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-errands-hkey-'), 'data') });
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
  const errands = createErrandService({ client, stores, hot, privateDir, log: quiet, defer: (fn) => fn() });
  return { errands, runs };
}

const ask = (agent: string) => ({
  agent,
  goal: 'find the changelog',
  requester: { accountId: '7', kind: 'member' },
  origin: { channelId: 'c1', messageId: 'm1' },
  scope: 'group' as const,
});

function keys(privateDir: string, backend: 'claude' | 'codex' | 'opencode', agent: string, named: boolean) {
  writeKeysFile(privateDir, {
    extra: { ex: 'sk-extra-SECRET' },
    subharness: { backends: [backend], key: named ? 'ex' : null, modes: {}, uses: { [agent]: backend } },
  });
}

for (const backend of ['claude', 'codex'] as const) {
  for (const agent of ['scout', 'server']) {
    for (const named of [true, false]) {
      test(`the ${agent} errand on a ${backend} route carries no OpenRouter key when the subharness ${named ? 'names' : 'names no'} extra key`, async () => {
        // Catches: the extra key riding along on a harness route (the scout's shell search command needed it).
        const privateDir = tempDir('nep-errands-hkey-');
        keys(privateDir, backend, agent, named);
        const { errands, runs } = rig(privateDir);
        errands.submit(ask(agent));
        await errands.idle();
        assert.equal(runs.length, 1);
        assert.equal(runs[0]?.route?.backend, backend);
        assert.ok(!runs[0]?.secrets?.openrouterKey);
      });
    }
  }
}

test('the scout errand on an opencode route carries the extra key the subharness names', async () => {
  // Catches: removing the key from harness routes also removing it from the one route that needs it.
  const privateDir = tempDir('nep-errands-hkey-');
  keys(privateDir, 'opencode', 'scout', true);
  const { errands, runs } = rig(privateDir);
  errands.submit(ask('scout'));
  await errands.idle();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.secrets?.openrouterKey, 'sk-extra-SECRET');
});
