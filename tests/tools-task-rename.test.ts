// The six board tools of her turns are called `task.*` (stage T.1 of the master plan): `task.propose`, `task.status`,
// `task.cancel`, `task.comment`, `task.answer` and `task.unblock`. The tables stay `board_*`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_DEFINITIONS, apiNameOf } from '../src/tools/definitions.ts';

const VERBS = ['propose', 'status', 'cancel', 'comment', 'answer', 'unblock'];

test('the definitions hold the six board tools under task.* and none under board.*', () => {
  // Catches: the rename stops at the API names and she keeps calling board.* in the registry.
  const names = SKILL_DEFINITIONS.map((entry) => entry.name);
  for (const verb of VERBS) assert.ok(names.includes(`task.${verb}`), `task.${verb} is defined`);
  assert.deepEqual(
    names.filter((name) => name.startsWith('board.')),
    []
  );
});

test('the tool-calling names are task_<verb> for the six tools and no board name remains', () => {
  // Catches: the provider still gets board_propose while the registry says task.propose, so the call maps to nothing.
  // Changed: the API names are read through apiNameOf and the definitions' `api`, the one place they are worked out.
  for (const verb of VERBS) assert.equal(apiNameOf(`task.${verb}`), `task_${verb}`);
  assert.deepEqual(
    SKILL_DEFINITIONS.filter((entry) => entry.api.startsWith('board_')).map((entry) => entry.name),
    []
  );
});

test('the errand tools keep their names', () => {
  // Catches: the rename sweeps errand.run into task.run and clashes with the board verbs.
  assert.equal(apiNameOf('errand.run'), 'errand_run');
  assert.equal(apiNameOf('errand.list'), 'errand_list');
});
