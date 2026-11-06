// A keys.json as a running deployment holds it when the enable step goes away: a list of connected backends and every
// role assigned to one of them. Nothing of it may move on the first read, the first write or the first run. The values
// are made up in that shape; no test reads a real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readKeys, writeKeys } from '../src/keys/file.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { unitText } from '../src/setup/install.ts';
import { routeOfAgent } from '../src/subharness/control.ts';
import { memoryPath } from '../src/subharness/memory-path.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const AGENTS = ['scout', 'server', 'dev', 'watcher', 'thinker'] as const;
const MODELS = {
  scout: 'claude-sonnet-4-6',
  server: 'claude-opus-5-5',
  dev: 'claude-sonnet-5-5',
  watcher: 'claude-fable-5-1',
  thinker: 'claude-opus-5-5',
};
const EFFORTS = { scout: 'medium', server: 'low', dev: 'medium', watcher: 'medium', thinker: 'medium' };
const MEMORY = { backend: 'claude', model: 'claude-opus-4-6', effort: null } as const;

function liveStore(): string {
  const privateDir = tempDir('nep-live-');
  writeKeysFile(privateDir, {
    subharness: {
      backends: ['claude'],
      key: null,
      modes: { dev: 'full' },
      models: MODELS,
      efforts: EFFORTS,
      uses: { scout: 'claude', server: 'claude', dev: 'claude', watcher: 'claude', thinker: 'claude' },
      memory: MEMORY,
    },
  });
  return privateDir;
}

test('every role of a live store keeps its source, model and effort, before and after the first write', () => {
  // Catches: a migration that rewrites an assignment, so a deployment wakes up with an agent on another model.
  const privateDir = liveStore();
  const expected = (agent: (typeof AGENTS)[number]) => ({
    backend: 'claude',
    model: MODELS[agent],
    effort: EFFORTS[agent],
    mode: agent === 'dev' ? 'full' : agent === 'server' || agent === 'watcher' ? 'read' : 'write',
  });
  for (const agent of AGENTS) assert.deepEqual(routeOfAgent(privateDir, agent), expected(agent));
  assert.deepEqual(memoryPath(privateDir), { kind: 'subharness', ...MEMORY });
  writeKeys(privateDir, readKeys(privateDir));
  assert.equal(Object.hasOwn(readKeysFile(privateDir).subharness, 'backends'), false);
  for (const agent of AGENTS) assert.deepEqual(routeOfAgent(privateDir, agent), expected(agent));
  assert.deepEqual(memoryPath(privateDir), { kind: 'subharness', ...MEMORY });
});

test('the status of a live store shows every role on its source and marks none unavailable', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: the roles read as off the moment the list stops deciding, with the login in place.
  const privateDir = liveStore();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const deps = {
    privateDir,
    fetch: fakeFetch().fetch,
    runBackend: () => Promise.reject(new Error('a status runs no model')),
  };
  const { text } = await subharnessCommand(deps, 'subharness.status', {});
  const row = (role: string): string => text.split('\n').find((line) => line.trim().startsWith(`${role} `)) ?? '';
  for (const agent of AGENTS) {
    assert.ok(row(agent).includes('claude'), agent);
    assert.ok(row(agent).includes(MODELS[agent]), agent);
    assert.equal(row(agent).includes('unavailable'), false, agent);
  }
  assert.ok(row('memory').includes('via claude-harness claude-opus-4-6'));
  assert.equal(row('memory').includes('unavailable'), false);
});

test('an agent unit of a live store binds the claude folder and no other backend', () => {
  // Catches: the render after a deployment drops the folder the running agents log in from.
  const dataDir = liveStore();
  const file = 'neptunia-agent-scout.service';
  const text = unitText(
    {
      system: false,
      user: 'alice',
      group: 'alice',
      home: tempDir('nep-home-'),
      rootDir: ROOT,
      privateDir: dataDir,
      dataDir,
      node: '/usr/bin/node',
    },
    fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8'),
    file
  );
  assert.ok(text.includes(`BindPaths=-${subharnessPlace(dataDir, 'claude').dir}`));
  assert.equal(text.includes(subharnessPlace(dataDir, 'codex').dir), false);
});
