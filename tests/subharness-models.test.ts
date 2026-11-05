// The model of each agent (src/subharness/models.ts, control.ts#setAgentModel, run.ts): a selection is checked with one
// reply before it is stored, and the runner passes the stored model on. The backend runner and fetch are fakes; keys.json is in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkModel } from '../src/subharness/models.ts';
import { agentPaths, setAgentModel, statusText, subharnessView } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { Backend, BackendRunOptions } from '../src/agent-runner/backend.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const SECRET = 'sk-or-v1-oc-secret-0123456789';

/** Deps whose backend answers only for the models in `good`; every model asked is recorded. */
function rig(good: ReadonlyArray<string>) {
  const dir = tempDir('nep-models-');
  writeKeysFile(dir, { extra: { opencode: SECRET } });
  const asked: Array<string | undefined> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (_name, _brief, model) => {
      asked.push(model);
      const ok = model === undefined || good.includes(model);
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps, asked };
}

test('subharness model checks the model and stores it for one agent, and status shows it', async () => {
  // Bug: "model" writes without a reply, or the status leaves the model out.
  const { dir, deps } = rig(['opus']);
  // Changed: the selection reads the real source, and the status reads each agent's path.
  writeKeysFile(dir, { extra: {}, subharness: { backend: 'claude', key: null, modes: {}, models: {} } });
  fakeVendor(dir, 'claude', { loggedIn: true });
  assert.equal((await setAgentModel(deps, 'dev', 'nope')).ok, false);
  assert.equal((await setAgentModel(deps, 'dev', 'opus')).ok, true);
  assert.equal(readKeysFile(dir).subharness.models?.dev, 'opus');
  assert.ok(statusText(await subharnessView(dir), agentPaths(dir)).includes('opus'));
});

test('the runner passes the stored model of the agent and none for an agent without one', async () => {
  // Bug: every agent runs on the one model, or an agent with none gets "undefined" as a flag.
  const dir = tempDir('nep-models-run-');
  writeKeysFile(dir, { subharness: { backend: 'codex', key: null, modes: {}, models: { dev: 'gpt-x' } } });
  const seen: Array<BackendRunOptions> = [];
  const deps = {
    privateDir: dir,
    denyDir: path.join(dir, 'nosudo'),
    hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name: 'codex' | 'claude' | 'opencode'): Backend => ({
      name,
      run: (_brief, options) => {
        seen.push(options);
        return Promise.resolve({ ok: true, text: 'x', exitCode: 0 });
      },
    }),
  };
  for (const agent of ['dev', 'scout']) await runAgent({ agent, brief: 'b', cwd: dir, timeoutMs: 1000 }, deps);
  assert.deepEqual(
    seen.map((one) => one.model),
    ['gpt-x', undefined]
  );
});

test('the check of an opencode model asks OpenRouter for the id behind the backend prefix', async () => {
  // Bug: the name opencode runs, openrouter/<id>, went to OpenRouter whole and came back HTTP 400, so no usable model
  // of opencode could pass the check of /subharness enable.
  const sent: Array<string> = [];
  const { deps } = rig([]);
  const seen: EnableDeps = {
    ...deps,
    fetch: (_url, init) => {
      // The check sends its body as a JSON string.
      const body = JSON.parse(init?.body as string) as { model: string };
      sent.push(body.model);
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  };
  assert.equal(await checkModel(seen, 'opencode', SECRET, 'openrouter/vendor/model'), null);
  assert.deepEqual(sent, ['vendor/model']);
});
