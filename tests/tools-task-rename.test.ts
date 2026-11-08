// The six board tools of her turns are called `task.*` (stage T.1 of the master plan): `task.propose`, `task.status`,
// `task.cancel`, `task.comment`, `task.answer` and `task.unblock`. The tables stay `board_*`. A live `bot.access`
// grant written under `board.<verb>` is carried to `task.<verb>` by the config moves, so a deployment that granted the
// old name keeps the tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_DEFINITIONS, apiNameOf } from '../src/tools/definitions.ts';
import { moveConfigKeys } from '../src/config-moves.ts';
import { grantedToPersona } from '../src/tools/access.ts';

const VERBS = ['propose', 'status', 'cancel', 'comment', 'answer', 'unblock'];
const SELF = '900';
const GRANT = { everyone: false, roles: [], users: [SELF] };

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
  assert.equal(apiNameOf('errand.status'), 'errand_status');
});

test('a live grant on board.propose moves to task.propose and still grants it to her', () => {
  // Catches: a deployment that granted board.propose loses the tool at the rename without a word.
  const { config, moved } = moveConfigKeys({ bot: { access: { 'board.propose': GRANT } } });
  assert.deepEqual(config, { bot: { access: { 'task.propose': GRANT } } });
  assert.deepEqual(moved, [{ from: 'bot.access.board.propose', to: 'bot.access.task.propose' }]);
  assert.equal(grantedToPersona(config, SELF, 'task.propose'), true);
});

for (const verb of ['status', 'cancel', 'comment', 'answer', 'unblock']) {
  test(`a live grant on board.${verb} moves to task.${verb}`, () => {
    // Catches: one of the six grants is missed by the forward step.
    const { config } = moveConfigKeys({ bot: { access: { [`board.${verb}`]: GRANT } } });
    assert.deepEqual(config, { bot: { access: { [`task.${verb}`]: GRANT } } });
  });
}

test('a file that holds both board.status and task.status keeps the task.status grant and reports the old one as shadowed', () => {
  // Catches: the move overwrites a grant the owner already set under the new name.
  const wider = { everyone: true, roles: [], users: [] };
  const { config, shadowed } = moveConfigKeys({ bot: { access: { 'board.status': GRANT, 'task.status': wider } } });
  assert.deepEqual(config, { bot: { access: { 'task.status': wider } } });
  assert.equal(shadowed.length, 1);
});

test('moving a migrated file again changes nothing: task.status stays the board tool', () => {
  // Catches: the pre-errand move task.status -> errand.status runs on the next load and steals the board grant.
  const once = moveConfigKeys({ bot: { access: { 'board.status': GRANT, 'board.cancel': GRANT } } });
  const twice = moveConfigKeys(once.config);
  assert.deepEqual(twice.config, { bot: { access: { 'task.status': GRANT, 'task.cancel': GRANT } } });
  assert.deepEqual(twice.moved, []);
});
