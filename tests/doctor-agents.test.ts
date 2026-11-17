// `neptunia doctor` (bin/neptunia.ts) checks the agents on disk in its `agents` check: `ok` with the count when every
// profile loads, `fail` naming the agent and the key when one does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { folders, runCli } from './fixtures/core-units.ts';

type Check = { name: string; status: string; detail: string };

async function doctorChecks(local: Record<string, unknown>): Promise<Array<Check>> {
  const dirs = folders({});
  for (const [name, profile] of Object.entries(local)) {
    fs.mkdirSync(path.join(dirs.dataDir, 'agents', name), { recursive: true });
    if (profile !== null)
      fs.writeFileSync(path.join(dirs.dataDir, 'agents', name, 'profile.json'), JSON.stringify(profile));
  }
  fs.writeFileSync(
    path.join(dirs.privateDir, 'keys.json'),
    JSON.stringify({ core: [{ name: 'core-1', value: 'sk-or-test-not-a-real-key' }], extra: {}, roles: {} }),
    { mode: 0o600 }
  );
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed: unknown = JSON.parse(run.stdout);
  return typeof parsed === 'object' && parsed !== null && Array.isArray(Reflect.get(parsed, 'checks'))
    ? (Reflect.get(parsed, 'checks') as Array<Check>)
    : [];
}

test('neptunia doctor fails its agents check on a local profile with a bad value, naming the agent and the key', async () => {
  // Bug: a broken local profile stops the core at start, and the doctor says nothing before the owner restarts.
  // Changed: a local folder overlays a tracked agent alone, so the broken profile is the scout's overlay.
  const check = (await doctorChecks({ scout: { limits: { steps: 0 } } })).find((entry) => entry.name === 'agents');
  assert.equal(check?.status, 'fail');
  assert.ok((check?.detail ?? '').includes('"scout"'), check?.detail);
});

test('neptunia doctor passes its agents check when a local folder holds no profile', async () => {
  // Bug: the check fails on a folder an older version left, which is no agent.
  const check = (await doctorChecks({ leftover: null })).find((entry) => entry.name === 'agents');
  assert.equal(check?.status, 'ok');
});
