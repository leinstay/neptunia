// The code-held danger list of src/development/risk.ts: which paths of a diff hold a task at risk `high`, whatever the
// thinker said. One test per category, the harmless paths next to them, and the read-only corner of src/memory/db/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DANGER_PATHS, dangerOf } from '../src/development/risk.ts';

/** Every category with the paths that must count for it. */
const SAMPLES: Readonly<Record<string, ReadonlyArray<string>>> = {
  deploy: ['deploy/neptunia.service', 'deploy/deploy.sh'],
  keys: ['src/keys/ring.ts', 'src/keys/store.ts'],
  subharness: ['src/subharness/run.ts', 'src/subharness/memory-writer.ts'],
  board: ['src/board/machine.ts', 'src/board/writer.ts'],
  'memory-db': [
    'src/memory/db/schema.ts',
    'src/memory/db/writer-worker.ts',
    'src/memory/db/writer-switch.ts',
    'src/memory/db/unit-write.ts',
    'src/memory/db/session-write.ts',
    'src/memory/db/upsert.ts',
    'src/memory/db/service.ts',
    'src/memory/db/open.ts',
  ],
  permissions: [
    'src/tools/access.ts',
    'src/tools/gateway.ts',
    'src/tools/impl/access.ts',
    'src/tools/impl/grants.ts',
    'src/tools/impl/rights.ts',
    'src/tools/impl/effects.ts',
    'src/interface/principals.ts',
    'src/agent-runner/policy.ts',
    'agents/thinker/profile.json',
    'agents/dev/profile.json',
    'src/development/worker.ts',
    'src/development/risk.ts',
    'bin/development.ts',
    'src/selfimprovement/settings.ts',
    'src/config/schema/selfimprovement.ts',
  ],
  ci: ['.github/workflows/ci.yml', '.github/CODEOWNERS'],
  dependencies: [
    'package.json',
    'package-lock.json',
    'cli/package.json',
    'interfaces/discord/package.json',
    'interfaces/discord/package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'npm-shrinkwrap.json',
  ],
};

for (const [category, paths] of Object.entries(SAMPLES)) {
  test(`the paths of ${category} count as ${category}`, () => {
    // Catches: a dangerous path merging on the thinker's word because the list misses it.
    for (const one of paths) assert.deepEqual(dangerOf([one]), [category], one);
  });
}

test('every category of the one exported list has its samples above', () => {
  // Catches: a category dropped from the list, or a new one that no test holds.
  assert.deepEqual(DANGER_PATHS.map((entry) => entry.category).sort(), Object.keys(SAMPLES).sort());
});

test('harmless paths and their near misses count as nothing', () => {
  // Catches: a prefix without its folder boundary, which sends every change to the owner and teaches him to wave it on.
  const harmless = [
    'src/web/read.ts',
    'prompts/format.md',
    'docs/deploy.md',
    'docs/board.md',
    'deployment/notes.md',
    'src/deploy/notes.ts',
    'src/keys.ts',
    'src/keysmith/ring.ts',
    'src/boards/list.ts',
    'src/subharnesses/run.ts',
    'src/memory/store.ts',
    'src/tools/access-notes.ts',
    'tests/board.test.ts',
    'tests/keys-store.test.ts',
    'tests/package-json.test.ts',
    'github/notes.md',
  ];
  assert.deepEqual(dangerOf(harmless), []);
});

test('the reads of src/memory/db/ count as nothing, and a new file there counts as a write', () => {
  // Catches: the whole folder held high for a recall change, or a new writer that slips past a list of names.
  assert.deepEqual(dangerOf(['src/memory/db/recall.ts', 'src/memory/db/readers/journal.ts']), []);
  assert.deepEqual(dangerOf(['src/memory/db/a-new-table.ts']), ['memory-db']);
});

test('a diff answers each category it touches once, among harmless paths', () => {
  // Catches: only the first path of a diff is read, so a harmless path in front hides the dangerous one.
  const found = dangerOf(['src/web/read.ts', 'src/keys/ring.ts', 'deploy/a.sh', 'deploy/b.sh']);
  assert.deepEqual([...found].sort(), ['deploy', 'keys']);
});

test('an empty diff touches no category', () => {
  // Catches: a throw on the boundary, which a look would read as a failed look for ever.
  assert.deepEqual(dangerOf([]), []);
});
