// src/errands/service.ts: an errand whose agent searches with exa, on an OpenCode route, carries the stored `exa`
// service key (keys.json `services.exa`) as `secrets.searchKey`. With no stored key, with another search provider, or on
// a claude or codex route it carries none. The store is real over a temp memory database, the errand client is a fake
// that records each run, and keys.json lives in a temp dir.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createErrandService } from '../src/errands/service.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { keysPath, writeKeysFile } from './fixtures/keys-file.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const EXA = 'exa-stored-SECRET-0123';

const closers: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const close of closers) await close();
});

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

type Run = { route?: { backend?: string }; secrets?: { openrouterKey?: string; searchKey?: string } | null };

function rig(privateDir: string) {
  const agents = Object.fromEntries(['scout', 'server'].map((n) => [n, { enabled: true, daily: { tasks: 10 } }]));
  const hot = { config: { errands: { maxOpen: 3 }, agents } };
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-errands-exa-'), 'data') });
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
  const errands = createErrandService({ client, stores, hot, env: {}, privateDir, log: quiet, defer: (fn) => fn() });
  return { errands, runs };
}

const ask = (agent: string) => ({
  agent,
  goal: 'find the changelog',
  requester: { accountId: '7', kind: 'member' },
  origin: { channelId: 'c1', messageId: 'm1' },
  scope: 'group' as const,
});

/** keys.json with `agent` on `backend` and, when `exa` is a string, the stored Exa service key. */
function keys(privateDir: string, backend: 'claude' | 'codex' | 'opencode', agent: string, exa: string | null) {
  writeKeysFile(privateDir, {
    extra: { ex: 'sk-extra-OR' },
    subharness: { backends: [backend], key: 'ex', modes: {}, uses: { [agent]: backend } },
  });
  if (exa === null) return;
  const stored = JSON.parse(fs.readFileSync(keysPath(privateDir), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(keysPath(privateDir), JSON.stringify({ ...stored, services: { exa } }), { mode: 0o600 });
}

async function dispatch(agent: string, backend: 'claude' | 'codex' | 'opencode', exa: string | null): Promise<Run> {
  const privateDir = tempDir('nep-errands-exa-');
  keys(privateDir, backend, agent, exa);
  const { errands, runs } = rig(privateDir);
  errands.submit(ask(agent));
  await errands.idle();
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.ok(run, 'the errand was dispatched');
  return run;
}

test('the scout errand on an opencode route carries the stored exa key as secrets.searchKey beside the route key', async () => {
  // Catches: the stored Exa key never leaving keys.json, so OpenCode's deep search stays keyless and rate limited.
  const run = await dispatch('scout', 'opencode', EXA);
  assert.equal(run.secrets?.searchKey, EXA);
  assert.equal(run.secrets?.openrouterKey, 'sk-extra-OR');
});

test('the scout errand on an opencode route carries no searchKey when no exa key is stored', async () => {
  // Catches: an empty or placeholder key sent, which would replace the keyless free endpoint with a failing one.
  const run = await dispatch('scout', 'opencode', null);
  assert.equal(Object.hasOwn(run.secrets ?? {}, 'searchKey'), false);
  assert.equal(run.secrets?.openrouterKey, 'sk-extra-OR');
});

test('the server errand, whose agent does not search with exa, carries no searchKey although an exa key is stored', async () => {
  // Catches: the key handed to every errand instead of only the agents that search with exa.
  const run = await dispatch('server', 'opencode', EXA);
  assert.equal(Object.hasOwn(run.secrets ?? {}, 'searchKey'), false);
});

for (const backend of ['claude', 'codex'] as const) {
  test(`the scout errand on a ${backend} route carries no searchKey although an exa key is stored`, async () => {
    // Catches: the Exa key reaching a harness that has web tools of its own and no use for it.
    const run = await dispatch('scout', backend, EXA);
    assert.equal(run.route?.backend, backend);
    assert.equal(Object.hasOwn(run.secrets ?? {}, 'searchKey'), false);
  });
}
