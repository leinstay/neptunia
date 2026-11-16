// `refusedAgents` (src/agent-runner/profiles.ts) lists the folders under `<data>/agents/` that name no shared agent,
// each with the code and the reason it was refused. The loaders skip such a folder (tests/agent-stray-folder.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { refusedAgents } from '../src/agent-runner/profiles.ts';
import { fixture, profileError } from './fixtures/agent-overrides.ts';

test('refusedAgents names a stray folder with its code and a reason', (t) => {
  // Bug: the refusal was only a throw, so once the load skips the folder nothing tells the owner it exists.
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(path.join(f.dataDir, 'agents', 'ghost'), { recursive: true });
  const refused = refusedAgents(f.options);
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.name, 'ghost');
  assert.equal(refused[0]?.code, 'no-shared-definition');
  assert.ok((refused[0]?.reason ?? '').length > 0);
});

test('refusedAgents lists every stray folder, sorted by name', (t) => {
  // Bug: reporting only the first stray folder hides the rest until the owner fixes one and restarts.
  const f = fixture();
  t.after(f.close);
  for (const name of ['zeta', 'alpha']) fs.mkdirSync(path.join(f.dataDir, 'agents', name), { recursive: true });
  assert.deepEqual(
    refusedAgents(f.options).map((entry) => entry.name),
    ['alpha', 'zeta']
  );
});

test('refusedAgents is empty when the personal folders all belong to shared agents, and for a missing data folder', (t) => {
  // Bug: a shared agent's own personal folder, a loose file or a missing `<data>/agents/` reported as refused.
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(refusedAgents(f.options), []);
  f.override({});
  fs.writeFileSync(path.join(f.dataDir, 'agents', 'README.md'), 'notes');
  assert.deepEqual(refusedAgents(f.options), []);
});

test('refusedAgents still throws on a symbolic link under the personal agents folder', (t) => {
  // Bug: the link refusal weakened along with the stray-folder one.
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(path.join(f.dataDir, 'agents'), { recursive: true });
  fs.symlinkSync(f.shared, path.join(f.dataDir, 'agents', 'link'), 'dir');
  assert.throws(() => refusedAgents(f.options), profileError('link', 'id'));
});
