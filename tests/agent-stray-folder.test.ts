// A folder under `<data>/agents/` with no shared definition is refused alone: the shared agents still load. A link
// under that folder and a broken personal profile of a shared agent still fail the load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agents, fixture, profileError } from './fixtures/agent-overrides.ts';

function stray(dataDir: string, name = 'ghost'): void {
  fs.mkdirSync(path.join(dataDir, 'agents', name), { recursive: true });
}

test('listAgents returns the shared agents when a stray folder sits beside them', (t) => {
  // Bug: one folder left by an older version made the whole load throw, so no shared agent loaded at all.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  assert.deepEqual(
    agents.listAgents(f.options).map((entry) => entry.id),
    ['scout']
  );
});

test('loadProfiles builds the profile of a shared agent when a stray folder sits beside it', (t) => {
  // Bug: the profiles the runners and the errand service use were all lost to one stray folder.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  assert.deepEqual(Object.keys(agents.loadProfiles(f.options)), ['scout']);
  assert.equal(agents.profileOf('scout', f.options)?.name, 'scout');
  assert.equal(agents.profileOf('ghost', f.options), null);
});

test('a stray folder does not stop the personal override of a shared agent', (t) => {
  // Bug: skipping the stray folder must not skip the personal folders next to it.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  f.override({ limits: { steps: 7 } });
  assert.equal(agents.loadProfiles(f.options).scout?.defaultLimits.steps, 7);
});

test('a symbolic link under the personal agents folder still throws beside a stray folder', (t) => {
  // Bug: the link refusal was dropped together with the stray-folder one.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  fs.symlinkSync(f.shared, path.join(f.dataDir, 'agents', 'link'), 'dir');
  assert.throws(() => agents.listAgents(f.options), profileError('link', 'id'));
});

test('a broken personal profile of a shared agent still throws beside a stray folder', (t) => {
  // Bug: swallowing the stray-folder error must not swallow a real profile error.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  f.override({ id: 'other' });
  assert.throws(() => agents.listAgents(f.options), profileError('scout', 'id'));
});
