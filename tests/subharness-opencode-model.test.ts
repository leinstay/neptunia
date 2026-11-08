// The model id of an agent on opencode: opencode names a model by its provider, and the one provider it has is
// OpenRouter (it gets OPENROUTER_API_KEY and nothing else), so `opencode run -m google/x` exits 1 where
// `-m openrouter/google/x` answers. A typed `/model set <agent> <id> --via opencode` stores the id with `openrouter/`, and
// a bare id already in keys.json or in a task's route runs with it. The binaries are fakes, no request goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setAgentModel } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { readRouting } from '../src/subharness/routing.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { AgentRun, RunDeps } from '../src/subharness/run.ts';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const KEY = 'sk-or-v1-helpers-fake-0123456789';

/** A private dir whose opencode is installed and logged in on the extra key `helpers`, with the scout's stored path. */
function installed(models: Record<string, string> = {}): string {
  const dir = tempDir('nep-oc-model-');
  writeKeysFile(dir, {
    extra: { helpers: KEY },
    subharness: { key: 'helpers', modes: {}, models, uses: { scout: 'opencode' } },
  });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  return dir;
}

const selectionDeps = (dir: string): EnableDeps => ({
  privateDir: dir,
  baseUrl: 'https://openrouter.test/api/v1',
  runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
  fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
});

/** Run deps whose backend records the options it was started with. */
function recording(dir: string): { deps: RunDeps; seen: Array<BackendRunOptions> } {
  const seen: Array<BackendRunOptions> = [];
  return {
    seen,
    deps: {
      privateDir: dir,
      denyDir: tempDir('nep-oc-model-deny-'),
      backendFactory: (name) => ({
        name,
        run: (_brief, options) => {
          seen.push(options);
          return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
        },
      }),
    },
  };
}

const scoutRun = (dir: string): AgentRun => ({ agent: 'scout', brief: 'B', cwd: dir, timeoutMs: 5_000 });

test('a typed opencode model with no provider prefix is stored with openrouter/', async () => {
  // Bug: `/model set scout google/gemini-4-argon --via opencode` stores the bare id, and every scout run exits 1.
  const dir = installed();
  const result = await setAgentModel(selectionDeps(dir), 'scout', 'google/gemini-4-argon', undefined, 'opencode');
  assert.equal(result.ok, true, result.message);
  assert.equal(readRouting(dir).subharness.models.scout, 'openrouter/google/gemini-4-argon');
});

test('a typed opencode model that already names openrouter is stored as typed', async () => {
  // Bug: the prefix is added twice, `openrouter/openrouter/...`, which opencode cannot resolve either.
  const dir = installed();
  const result = await setAgentModel(
    selectionDeps(dir),
    'scout',
    'openrouter/google/gemini-4-argon',
    undefined,
    'opencode'
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(readRouting(dir).subharness.models.scout, 'openrouter/google/gemini-4-argon');
});

test('a bare opencode model stored in keys.json runs with openrouter/', async () => {
  // Bug: a deployment that stored the bare id before the fix keeps failing until the owner sets the model again.
  const dir = installed({ scout: 'google/gemini-4-argon' });
  const { deps, seen } = recording(dir);
  const done = await runAgent(scoutRun(dir), deps);
  assert.equal(done.ok, true);
  assert.equal(seen[0]?.model, 'openrouter/google/gemini-4-argon');
});

test('a bare opencode model in a task route runs with openrouter/', async () => {
  // Bug: the runner unit, which never opens keys.json, starts opencode with the route's bare id and exits 1.
  const dir = installed();
  const { deps, seen } = recording(dir);
  const done = await runAgent(
    {
      ...scoutRun(dir),
      route: { backend: 'opencode', model: 'google/gemini-4-argon', effort: null, mode: 'write' },
      routeKey: KEY,
    },
    deps
  );
  assert.equal(done.ok, true);
  assert.equal(seen[0]?.model, 'openrouter/google/gemini-4-argon');
});

test('a codex model in a task route runs as stored, with no openrouter/', async () => {
  // Bug: the prefix is put on every backend's model, and codex refuses `openrouter/gpt-6-sol`.
  const dir = installed();
  const { deps, seen } = recording(dir);
  await runAgent(
    { ...scoutRun(dir), route: { backend: 'codex', model: 'gpt-6-sol', effort: null, mode: 'write' } },
    deps
  );
  assert.equal(seen[0]?.model, 'gpt-6-sol');
});
