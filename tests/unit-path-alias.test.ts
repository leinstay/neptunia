// `currentUnitPath` (src/memory/migration/paths.ts) is the one alias table for unit paths: the names an errand unit had
// (`guilds/<g>/tasks.json`, `tasks.jsonl`) map to the current ones (`errands.json`, `errands.jsonl`), directly under a
// guild and nowhere else. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentUnitPath } from '../src/memory/migration/paths.ts';

test('maps the two old errand unit names to the current ones directly under a guild', () => {
  assert.equal(currentUnitPath('guilds/g1/tasks.json'), 'guilds/g1/errands.json');
  assert.equal(currentUnitPath('guilds/g1/tasks.jsonl'), 'guilds/g1/errands.jsonl');
});

test('leaves a private layer path, a current path and an unrelated path as they are', () => {
  for (const same of [
    'guilds/g1/private/p1/tasks.json',
    'guilds/g1/errands.json',
    'guilds/g1/errands.jsonl',
    'guilds/g1/intentions.json',
    'guilds/g1/tasks.json.bak',
    'tasks.json',
    'guilds/g1/users/tasks.json',
  ]) {
    assert.equal(currentUnitPath(same), same);
  }
});
