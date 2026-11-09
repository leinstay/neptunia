// Stage Z: every harness child (Claude Code, Codex, OpenCode) reaches the network through the engine proxy while it is
// in force, as HTTPS_PROXY and HTTP_PROXY in the http form. The core decides: the errand service puts the proxy of the
// moment into every errand's secrets, whatever the agent and its route, and nothing once the engine has gone direct.
// The runner's engine hands it to `runAgent`, which writes it into the child's environment. Fake backends and a fake
// errand client record what they were given; nothing is spawned and nothing goes out.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createAgentEngine } from '../src/agent-runner/backend.ts';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import { validateRequest } from '../src/agent-runner/protocol.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { createErrandService } from '../src/errands/service.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const PROXY = 'socks5h://login:pass-word@proxy.example:1080';
const HTTP_FORM = 'http://login:pass-word@proxy.example:1080';
const PROXY_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
const CLAUDE: TaskRoute = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'read' };

const closers: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const close of closers) await close();
});

function recordingDeps(): { deps: RunDeps; seen: Array<BackendRunOptions> } {
  const base = tempDir('nep-proxy-harness-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backends: ['codex'], key: null, modes: {} } });
  const seen: Array<BackendRunOptions> = [];
  const deps: RunDeps = {
    privateDir,
    denyDir: path.join(base, 'nosudo'),
    hostEnv: { PATH: '/usr/bin', HTTPS_PROXY: 'http://host-proxy.invalid:9' },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        seen.push(options);
        return Promise.resolve({ ok: true, text: 'done', exitCode: 0 });
      },
    }),
  };
  return { deps, seen };
}

const RUN = { agent: 'dev', brief: 'look', cwd: '/tmp/x', timeoutMs: 1000 };

test('a run with the engine proxy gives the child every proxy variable in the http form', async () => {
  // Catches: a harness child talks to its vendor straight from the server's address while the proxy is on.
  const { deps, seen } = recordingDeps();
  await runAgent({ ...RUN, route: CLAUDE, proxy: PROXY }, deps);
  for (const name of PROXY_NAMES) assert.equal(seen[0]?.env?.[name], HTTP_FORM, name);
});

test('a run without the engine proxy gives the child no proxy variable, not even the host one', async () => {
  // Catches: after the switch to direct, a child still inherits a proxy variable and fails on the dead proxy.
  const { deps, seen } = recordingDeps();
  await runAgent({ ...RUN, route: CLAUDE }, deps);
  for (const name of PROXY_NAMES) assert.equal(seen[0]?.env?.[name], undefined, name);
});

test('the engine proxy beats a proxy variable the caller put into the run environment', async () => {
  // Catches: a stale HTTPS_PROXY in `run.env` wins over the proxy the core decided for this run.
  const { deps, seen } = recordingDeps();
  await runAgent({ ...RUN, route: CLAUDE, proxy: PROXY, env: { HTTPS_PROXY: 'http://stale.invalid:1' } }, deps);
  assert.equal(seen[0]?.env?.HTTPS_PROXY, HTTP_FORM);
});

test('the run protocol takes secrets that hold the proxy alone', () => {
  // Catches: a claude or codex errand, which carries no OpenRouter key, cannot carry the proxy either.
  const checked = validateRequest({ op: 'run', id: 'p1', goal: 'look', secrets: { proxy: HTTP_FORM } });
  assert.equal(checked.ok, true);
  if (checked.ok) assert.deepEqual((checked.message as { secrets?: unknown }).secrets, { proxy: HTTP_FORM });
  const empty = validateRequest({ op: 'run', id: 'p2', goal: 'look', secrets: {} });
  assert.equal(empty.ok, false);
});

test("the runner's engine passes the task's proxy to the child of every backend", async () => {
  // Catches: the engine keeps passing only the OpenRouter key, so the scout and server units run their children direct.
  const { deps, seen } = recordingDeps();
  const base = tempDir('nep-proxy-engine-');
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const profile = {
    name: 'server',
    agentId: 'errand-server',
    promptFiles: [prompt],
    modelRole: 'server',
    defaultModel: 'x',
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    search: false,
    buildConfig: () => ({ agent: {} }),
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: deps,
  });
  const task = {
    id: 'e1',
    goal: 'look',
    context: {},
    route: CLAUDE,
    secrets: { proxy: HTTP_FORM },
  } as unknown as Parameters<typeof engine.run>[0];
  const outcome = await engine.run(task);
  assert.equal(outcome.status, 'done');
  assert.equal(seen[0]?.env?.HTTPS_PROXY, HTTP_FORM);
});

/** An errand service whose scout and server run on claude, or the scout on opencode with an extra key. */
function errandRig(proxy: () => string | null, scoutOn: 'claude' | 'opencode' = 'claude') {
  const privateDir = tempDir('nep-proxy-errands-');
  writeKeysFile(privateDir, {
    extra: { oc: 'sk-or-v1-oc-0123456789' },
    subharness: {
      backends: ['claude', 'opencode'],
      key: 'oc',
      modes: {},
      uses: { scout: scoutOn, server: 'claude' },
    },
  });
  const hot = {
    config: {
      errands: { maxOpen: 3 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } }, server: { enabled: true, daily: { tasks: 10 } } },
    },
  };
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-proxy-errands-'), 'data') });
  closers.push(memory.close);
  const runs: Array<{ secrets?: { proxy?: string; openrouterKey?: string } | null }> = [];
  const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const client = {
    configured: () => true,
    run: (task: (typeof runs)[number]) => {
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
  const errands = createErrandService({ client, stores, hot, privateDir, log: quiet, defer: (fn) => fn(), proxy });
  return { errands, runs };
}

const ask = (agent: string) => ({
  agent,
  goal: 'find the changelog',
  requester: { accountId: '7', kind: 'member' },
  origin: { placeId: 'c1', messageId: 'm1' },
  scope: 'group' as const,
});

test('every errand carries the proxy of the moment in its secrets, whatever the agent', async () => {
  // Catches: only the scout gets the proxy, as with the old video proxy, and the server agent goes out direct.
  const { errands, runs } = errandRig(() => PROXY);
  errands.submit(ask('scout'));
  errands.submit(ask('server'));
  await errands.idle();
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.equal(run.secrets?.proxy, HTTP_FORM);
    assert.equal(run.secrets?.openrouterKey, undefined, 'a claude route carries no OpenRouter key');
  }
});

test('an errand sent while the engine is direct carries no proxy', async () => {
  // Catches: the errand still takes a stale value after the health check moved the engine direct. The errand service
  // takes no environment, so the old MEDIA_VIDEO_PROXY variable cannot reach it.
  let inForce: string | null = PROXY;
  const { errands, runs } = errandRig(() => inForce, 'opencode');
  inForce = null;
  errands.submit(ask('scout'));
  await errands.idle();
  assert.equal(runs[0]?.secrets?.openrouterKey, 'sk-or-v1-oc-0123456789', 'the opencode route still carries its key');
  assert.equal(runs[0]?.secrets?.proxy, undefined);
});
