// An errand agent searches with its harness's own tools. An OpenRouter key exists inside an agent only on the OpenCode
// route, with that route's model and key. The child is a real disposable shell started by a fake backend with the
// environment the backend would give it (childEnvOf of the run's options.env), so what it finds on PATH and in its
// environment is what a real claude, codex or opencode child would see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnvOf, createAgentEngine } from '../src/agent-runner/backend.ts';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import { profileOf } from '../src/agent-runner/profiles.ts';
import type { BackendName } from '../src/agent-runner/profiles.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const TASK_KEY = 'sk-or-v1-task-secret-0123456789';
const HOST_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

const ROUTES: Record<BackendName, TaskRoute> = {
  claude: { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'write' },
  codex: { backend: 'codex', model: 'gpt-6-sol', effort: 'medium', mode: 'write' },
  opencode: { backend: 'opencode', model: null, effort: null, mode: 'write' },
};

type Seen = { env: Record<string, string>; webSearch: string; path: string };

function rig() {
  const base = tempDir('nep-scout-search-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backends: [], key: null, modes: {} } });
  const denyDir = path.join(base, 'nosudo');
  const seen: Array<Seen> = [];
  const subharness: RunDeps = {
    privateDir,
    denyDir,
    hostEnv: { PATH: HOST_PATH },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        const env = childEnvOf(options.env);
        const sh = (script: string) =>
          execFileSync('/bin/sh', ['-c', script], { env, cwd: base, encoding: 'utf8' }).trim();
        seen.push({ env, webSearch: sh('command -v web-search || true'), path: sh('printf %s "$PATH"') });
        return Promise.resolve({ ok: true, text: 'answer', exitCode: 0 });
      },
    }),
  };
  return { base, subharness, denyDir, seen };
}

async function runScout(backend: BackendName) {
  const { base, subharness, denyDir, seen } = rig();
  const real = profileOf('scout');
  assert.ok(real, 'profile scout');
  const prompt = path.join(base, 'scout.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const engine = createAgentEngine({
    profile: { ...real, promptFiles: [prompt] },
    outDir: path.join(base, 'out'),
    subharness,
  });
  const outcome = await engine.run({
    id: 't1',
    goal: 'look it up',
    context: {},
    route: ROUTES[backend],
    secrets: { openrouterKey: TASK_KEY },
  } as unknown as Parameters<typeof engine.run>[0]);
  return { outcome, seen: seen[0], denyDir };
}

for (const backend of ['claude', 'codex'] as const) {
  test(`a scout run on ${backend} has no OpenRouter key of any name in its child environment`, async () => {
    // Catches: the task key reaching a harness that searches with its own tools (it leaked to feed a shell command).
    const { outcome, seen } = await runScout(backend);
    assert.equal(outcome.status, 'done');
    assert.ok(seen);
    const named = Object.keys(seen.env).filter((k) => /openrouter/i.test(k));
    assert.deepEqual(named, []);
    assert.ok(!Object.values(seen.env).some((v) => v.includes(TASK_KEY)));
  });

  test(`a scout run on ${backend} has no scout command folder on PATH and no web-search`, async () => {
    // Catches: a pathDirs folder or a host-visible web-search left for the claude or codex child.
    const { seen, denyDir } = await runScout(backend);
    assert.ok(seen);
    assert.equal(seen.webSearch, '');
    assert.equal(seen.path, `${denyDir}:${HOST_PATH}`);
  });
}

test('a scout run on opencode gets the route key as OPENROUTER_API_KEY and no web-search command', async () => {
  // Catches: removing the shell command also removing the key the opencode route needs for its own websearch tool.
  const { seen, denyDir } = await runScout('opencode');
  assert.ok(seen);
  assert.equal(seen.env.OPENROUTER_API_KEY, TASK_KEY);
  assert.equal(seen.webSearch, '');
  assert.equal(seen.path, `${denyDir}:${HOST_PATH}`);
});

test('the scout profile keeps its own websearch tool and has no command folder', () => {
  // Catches: the opencode route losing its native search together with the shell command.
  const scout = profileOf('scout');
  assert.ok(scout);
  assert.ok(scout.tools.includes('websearch'));
  // Stage W: the owner changed this from an empty `pathDirs` list to no `pathDirs` field at all.
  assert.equal('pathDirs' in scout, false);
});
