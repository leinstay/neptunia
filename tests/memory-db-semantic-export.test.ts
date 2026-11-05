// Stage T.3 of the master plan: `applySemanticWrite` had no production caller, because sessions write through
// `writeSessionEntity` and `writeSessionAssertion`. The export is gone, no file of the repository names it, and the
// fixture tests/fixtures/memory-db/semantic-session-commit.ts commits through the session operations instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitViaSession } from './fixtures/memory-db/semantic-session-commit.ts';
import { addSource, entityCandidate, semanticWorld, worksOn, ALEX } from './fixtures/memory-db/semantic-world.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SELF = path.join(REPO, 'tests', 'memory-db-semantic-export.test.ts');
const NAME = ['apply', 'Semantic', 'Write'].join('');

/** Every `.ts` file of the folders that hold code or tests, outside node_modules. */
function sources(dir: string): Array<string> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(file);
    return entry.name.endsWith('.ts') ? [file] : [];
  });
}

test('the semantic writer module no longer exports applySemanticWrite', () => {
  // Catches: the uncalled production export stays, so the test-only path keeps proving a write no session performs.
  const text = fs.readFileSync(path.join(REPO, 'src/memory/db/semantic-write.ts'), 'utf8');
  assert.equal(text.includes(NAME), false);
});

test('no file under src, scripts, interfaces, cli or tests names applySemanticWrite', () => {
  // Catches: a test or script still imports the removed export and fails only when it is run.
  const named = ['src', 'scripts', 'interfaces', 'cli', 'tests']
    .map((folder) => path.join(REPO, folder))
    .filter((folder) => fs.existsSync(folder))
    .flatMap(sources)
    .filter((file) => file !== SELF && fs.readFileSync(file, 'utf8').includes(NAME));
  assert.deepEqual(
    named.map((file) => path.relative(REPO, file)),
    []
  );
});

test('the fixture commits an entity and a relation through the session operations', () => {
  // Catches: the replacement fixture writes rows by another road, so the tests that moved to it prove nothing.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex works on Lumen');
  const entity = commitViaSession(world, entityCandidate('project', 'Lumen', [source]));
  assert.equal(entity.kind, 'entity');
  if (entity.kind !== 'entity') return;
  const relation = commitViaSession(world, worksOn(ALEX, entity.entityId, [source]));
  assert.equal(relation.kind, 'assertion');
  const stored = world.db
    .prepare('SELECT COUNT(*) AS n FROM semantic_assertion_versions WHERE version_id = ?')
    .get(relation.versionId);
  assert.equal(Number(stored?.n), 1);
  world.handle.close();
});
