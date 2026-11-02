// How a backend is chosen (src/agent-runner/backend.ts, src/agent-runner/profiles.ts, the schema row
// `errands.backend`): the config override over the profile's `backend` over the schema default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_NAMES, backendOf, createBackend } from '../src/agent-runner/backend.ts';
import type { BackendName } from '../src/agent-runner/backend.ts';
import { AgentProfileError, listAgents } from '../src/agent-runner/profiles.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { scratch } from './fixtures/backend-rig.ts';

test('the schema has one errands.backend row with the default codex', () => {
  // Bug: no declared default, so an agent without a setting starts no backend or the retired one.
  const row = CONFIG_SCHEMA.find((entry) => entry.key === 'errands.backend');
  assert.ok(row, 'errands.backend is in the schema');
  assert.deepEqual(row.types, ['string']);
  assert.equal(row.default, 'codex');
  assert.deepEqual([...BACKEND_NAMES], ['codex', 'claude', 'opencode']);
});

test('an agent without its own setting takes errands.backend', () => {
  // Bug: the global switch is ignored and every agent stays on the default.
  assert.equal(backendOf('dev', { errands: { backend: 'claude' } }), 'claude');
  assert.equal(backendOf('scout', { errands: { backend: 'opencode' } }), 'opencode');
});

test('agents.<name>.backend wins over errands.backend, for that agent only', () => {
  // Bug: one agent moved to claude drags the others along, or its own setting is shadowed by the global one.
  const config = { errands: { backend: 'codex' }, agents: { dev: { backend: 'claude' } } };
  assert.equal(backendOf('dev', config), 'claude');
  assert.equal(backendOf('scout', config), 'codex');
});

test('an unknown backend name in the config is refused, not passed on to a spawn', () => {
  // Bug: a typo such as "codx" becomes a command name that is looked up on the PATH.
  assert.throws(() => backendOf('dev', { agents: { dev: { backend: 'codx' } } }), /backend/);
  assert.throws(() => createBackend('codx' as unknown as BackendName), /codx/);
});

/** A development profile tree under a scratch root, with `changes` laid over a valid profile. */
function treeWith(changes: Record<string, unknown>): { rootDir: string; cleanup: () => void } {
  const { dir, cleanup } = scratch();
  fs.mkdirSync(path.join(dir, 'agents', 'build'), { recursive: true });
  const profile = {
    id: 'build',
    kind: 'development',
    role: 'dev',
    prompt: 'prompt.md',
    override: null,
    tools: ['bash', 'read', 'edit'],
    permission: { edit: 'allow' },
    effort: 'medium',
    limits: { steps: 50, minutes: 30 },
    cost: { input: 2, output: 10 },
    description: 'A test development agent.',
    ...changes,
  };
  fs.writeFileSync(path.join(dir, 'agents', 'build', 'profile.json'), JSON.stringify(profile));
  return { rootDir: dir, cleanup };
}

test('a profile may name its backend and listAgents exposes it', () => {
  // Bug: the profile key is refused as unknown, so the per-agent choice cannot be committed with the agent.
  const { rootDir, cleanup } = treeWith({ backend: 'claude' });
  try {
    const [agent] = listAgents({ rootDir });
    assert.equal((agent as { backend?: string }).backend, 'claude');
  } finally {
    cleanup();
  }
});

test('a profile with an unknown backend is refused with AgentProfileError naming the key', () => {
  // Bug: a bad value loads and fails only when a task is already running.
  const { rootDir, cleanup } = treeWith({ backend: 'gemini' });
  try {
    assert.throws(
      () => listAgents({ rootDir }),
      (err) => err instanceof AgentProfileError && err.agent === 'build' && err.key === 'backend'
    );
  } finally {
    cleanup();
  }
});
