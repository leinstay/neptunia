// The model of each agent (src/subharness/models.ts, enable-dialog.ts, control.ts#setAgentModel, run.ts): `subharness
// enable` asks for a model per agent when the core says so, checks each with one reply, stores nothing before the last
// answer, and the runner passes the stored model on. The backend runner and fetch are fakes; keys.json is in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import {
  SUBHARNESS_AGENTS,
  setAgentModel,
  statusText,
  subharnessView,
  agentModels,
} from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { Backend, BackendRunOptions } from '../src/agent-runner/backend.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SECRET = 'sk-or-v1-oc-secret-0123456789';

/** Deps whose backend answers only for the models in `good`; every model asked is recorded. */
function rig(good: ReadonlyArray<string>) {
  const dir = tempDir('nep-models-');
  writeKeysFile(dir, { extra: { opencode: SECRET } });
  const asked: Array<string | undefined> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    asksModels: true,
    runBackend: (_name, _brief, model) => {
      asked.push(model);
      const ok = model === undefined || good.includes(model);
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps, asked };
}

test('enable with the dialog on asks for the first agent and stores nothing yet', async () => {
  // Bug: the backend is stored before the models are given, so an abandoned dialog leaves a half-enabled subharness.
  const { dir, deps } = rig(['opus']);
  const answer = await subharnessCommand(deps, 'subharness.enable', { backend: 'claude' });
  assert.equal(answer.status, 'ask');
  assert.ok(answer.dialogId);
  assert.ok(answer.prompt?.includes(SUBHARNESS_AGENTS[0] ?? ''));
  assert.ok(answer.choices?.includes('opus'), 'the claude list is offered');
  assert.equal(readKeysFile(dir).subharness.backend, null);
});

test('four checked answers store the backend and the four models together', async () => {
  // Bug: the answers are stored one by one, or the last answer is dropped.
  const { dir, deps } = rig(['opus', 'sonnet']);
  let answer = await subharnessCommand(deps, 'subharness.enable', { backend: 'claude' });
  const models = ['opus', 'sonnet', 'opus', 'sonnet'];
  for (const model of models) {
    assert.equal(answer.status, 'ask');
    answer = await subharnessCommand(deps, 'subharness.enable', {
      backend: 'claude',
      dialogId: answer.dialogId,
      answer: model,
    });
  }
  assert.equal(answer.status, 'ok');
  const stored = readKeysFile(dir).subharness;
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(stored.backends, ['claude']);
  assert.deepEqual(stored.models, { scout: 'opus', server: 'sonnet', dev: 'opus', watcher: 'sonnet' });
});

test('a model that gives no reply is asked again for the same agent and is not stored', async () => {
  // Bug: a typo such as "opsu" is saved and every task of that agent fails at its first run.
  const { dir, deps, asked } = rig(['opus']);
  const first = await subharnessCommand(deps, 'subharness.enable', { backend: 'claude' });
  const again = await subharnessCommand(deps, 'subharness.enable', { dialogId: first.dialogId, answer: 'opsu' });
  assert.equal(again.status, 'ask');
  assert.ok(again.prompt?.includes(SUBHARNESS_AGENTS[0] ?? ''), 'the same agent');
  assert.ok(asked.includes('opsu'));
  assert.deepEqual(readKeysFile(dir).subharness.models ?? {}, {});
});

test('an answer to a dialog that is not open is refused', async () => {
  // Bug: a stale dialog id from before a restart stores models for a backend nobody checked.
  const { deps } = rig([]);
  const answer = await subharnessCommand(deps, 'subharness.enable', { dialogId: 'gone', answer: 'opus' });
  assert.equal(answer.status, 'failed');
});

test('opencode offers the models of /models on the named key', async () => {
  // Bug: the list comes from a fixed table, so a model OpenRouter added is not offered.
  const { deps } = rig([]);
  const fetched: Array<string> = [];
  const withList: EnableDeps = {
    ...deps,
    fetch: (url: string | URL | Request) => {
      const href = String(url instanceof Request ? url.url : url);
      fetched.push(href);
      const body = href.endsWith('/models') ? { data: [{ id: 'vendor/model-a' }, { id: 'vendor/model-b' }] } : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    },
  };
  const answer = await subharnessCommand(withList, 'subharness.enable', { backend: 'opencode', key: 'opencode' });
  assert.deepEqual(answer.choices, ['vendor/model-a', 'vendor/model-b']);
});

test('subharness model checks the model and stores it for one agent, and status shows it', async () => {
  // Bug: "model" writes without a reply, or the status leaves the model out.
  const { dir, deps } = rig(['opus']);
  writeKeysFile(dir, { extra: {}, subharness: { backend: 'claude', key: null, modes: {}, models: {} } });
  assert.equal((await setAgentModel(deps, 'dev', 'nope')).ok, false);
  assert.equal((await setAgentModel(deps, 'dev', 'opus')).ok, true);
  assert.equal(readKeysFile(dir).subharness.models?.dev, 'opus');
  assert.ok(statusText(await subharnessView(dir), agentModels(dir)).includes('opus'));
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
