// What is left of the choice of a backend (src/agent-runner/backend.ts, src/agent-runner/profiles.ts): the names, and
// the refusal of a name that is none. The choice itself is the owner's subharness switch (tests/subharness-control.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_NAMES, createBackend } from '../src/agent-runner/backend.ts';
import type { BackendName } from '../src/agent-runner/backend.ts';
import { AgentProfileError, listAgents } from '../src/agent-runner/profiles.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { scratch } from './fixtures/backend-rig.ts';

test('errands.backend is no setting any more: the subharness holds the backend', () => {
  // Bug: the schema row survives and a deployment sets a backend that nothing reads.
  assert.equal(
    CONFIG_SCHEMA.some((entry) => entry.key === 'errands.backend'),
    false
  );
  assert.deepEqual([...BACKEND_NAMES], ['codex', 'claude', 'opencode']);
});

test('createBackend refuses a backend name that is none, so a typo never reaches a spawn', () => {
  // Bug: a typo such as "codx" becomes a command name that is looked up on the PATH.
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

test('a profile naming a backend is refused as an unknown key', () => {
  // Bug: the profile key `backend` stays valid and is read by nothing.
  const { rootDir, cleanup } = treeWith({ backend: 'claude' });
  try {
    assert.throws(
      () => listAgents({ rootDir }),
      (err) => err instanceof AgentProfileError && err.agent === 'build' && err.key === 'backend'
    );
  } finally {
    cleanup();
  }
});
