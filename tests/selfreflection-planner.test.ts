// B6 of the master plan: the diary planner is the selfreflection planner. Its purpose, its prompt file, its pin in
// `models.byPurpose` and a local prompt file under the old name all follow the new name, and the block that listed the
// server lists the places she follows. What the request holds is in tests/selfreflection-requests.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHot } from '../src/hot.ts';
import { moveConfigKeys } from '../src/config-moves.ts';
import { PURPOSE_ROLES, roleModel } from '../src/llm/roles.ts';
import { tempDir } from './fixtures/tmp.ts';
import { ROOT } from './fixtures/source-tree.ts';
import { blocksOf } from '../src/turn/request/frame.ts';
import { MARK, blockOf, frameTurn, gistOf, inOrderOf, partOf, rootTags } from './fixtures/selfreflection-frame.ts';

const PLANNER = 'selfreflection-planner';

/** A deployment root with the given tracked prompt files, and `data/prompts` for the local layer. */
function deployment(tracked: Record<string, string>): string {
  const dir = tempDir('nep-planner-');
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ bot: { timezone: 'UTC' } }));
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  for (const [name, text] of Object.entries(tracked)) fs.writeFileSync(path.join(dir, 'prompts', `${name}.md`), text);
  fs.mkdirSync(path.join(dir, 'data', 'prompts'), { recursive: true });
  return dir;
}

test('the planner goes out on the analyzer role under its new purpose, and the old purpose is gone', () => {
  // Bug: the planner's purpose is renamed in the request and not in the role table, so it runs on the core model.
  assert.equal((PURPOSE_ROLES as Record<string, string>)[PLANNER], 'analyzer');
  assert.equal(Object.hasOwn(PURPOSE_ROLES, 'diary-plan'), false);
  assert.equal(roleModel({ models: { byPurpose: { [PLANNER]: 'x/planner' } } }, 'analyzer', PLANNER), 'x/planner');
});

test('a pin on the old purpose moves to the new one with the rest of the local config', () => {
  // Bug: the owner's pin of the planner's model silently stops applying after the rename.
  const { config, moved } = moveConfigKeys({
    models: { byPurpose: { 'diary-plan': 'x/planner', reply: 'x/reply' } },
  });
  assert.deepEqual(config, { models: { byPurpose: { [PLANNER]: 'x/planner', reply: 'x/reply' } } });
  assert.deepEqual(moved, [{ from: 'models.byPurpose.diary-plan', to: `models.byPurpose.${PLANNER}` }]);
});

test('a pin set under both purposes keeps the new one', () => {
  const { config, shadowed } = moveConfigKeys({
    models: { byPurpose: { 'diary-plan': 'x/old', [PLANNER]: 'x/new' } },
  });
  assert.deepEqual(config, { models: { byPurpose: { [PLANNER]: 'x/new' } } });
  assert.deepEqual(shadowed, [{ from: 'models.byPurpose.diary-plan', to: `models.byPurpose.${PLANNER}` }]);
});

test('a local diary-plan.md replaces the planner prompt under its new name', () => {
  // Bug: a deployment's own planner prompt is ignored after the rename and the tracked one is sent instead.
  const dir = deployment({ [PLANNER]: 'tracked planner' });
  fs.writeFileSync(path.join(dir, 'data', 'prompts', 'diary-plan.md'), 'local planner');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts[PLANNER], 'local planner');
    assert.equal(hot.promptSources[PLANNER], 'local');
    assert.equal(Object.hasOwn(hot.prompts, 'diary-plan'), false);
  } finally {
    hot.close();
  }
});

test('a local selfreflection-planner.md wins over a local diary-plan.md', () => {
  const dir = deployment({ [PLANNER]: 'tracked planner' });
  fs.writeFileSync(path.join(dir, 'data', 'prompts', 'diary-plan.md'), 'older planner');
  fs.writeFileSync(path.join(dir, 'data', 'prompts', `${PLANNER}.md`), 'newer planner');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts[PLANNER], 'newer planner');
  } finally {
    hot.close();
  }
});

test('the tracked planner prompt has the new file name, fills the name and names the block the request carries', () => {
  // Bug: the prompt describes `<server>` while the request carries `<places>`, so the model reads a block that is not there.
  const file = path.join(ROOT, 'prompts', `${PLANNER}.md`);
  assert.equal(fs.existsSync(path.join(ROOT, 'prompts', 'diary-plan.md')), false);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('{{name}}'));
  assert.ok(text.includes('<places>'));
  assert.equal(text.includes('<server>'), false);
});

// The planner on the turn frame (plan 2026-11-06-turn-frame, slice 6): a frame request with the selfreflection list,
// `<kinds>`, `<seeds>` and `<selfreflection>` in `<inner>`, and no plan of its own to read. Its answer stays JSON.
// tests/fixtures/selfreflection-frame.ts holds the scene.

/** The planner's list without `persona`, which is the system message and no root tag of the user text. */
const PLANNER_TAGS = blocksOf('selfreflection_plan', null).filter((name) => name !== 'persona');

test('the planner request holds the frame list and none of the old blocks', async () => {
  // Bug: the planner keeps its own request with `<now>`, `<places>`, `<about_chat>`, `<recent>`, `<lore>` and `<world>`.
  const run = await frameTurn();
  const text = run.planner[0] ?? '';
  const tags = rootTags(text);
  assert.ok(inOrderOf(tags, PLANNER_TAGS), tags.join(' '));
  for (const tag of ['self', 'inner', 'meanwhile', 'virtual_world', 'spatial_awareness', 'task'])
    assert.ok(tags.includes(tag), `holds <${tag}>`);
  assert.ok(blockOf(text, 'task').includes(MARK.planner), 'its own task');
});

test('the planner <inner> holds <kinds>, <seeds> and <selfreflection>, and the request no <plan>', async () => {
  // Bug: the planner loses what it chooses from or its past entries, or reads a plan that it is there to make.
  const run = await frameTurn({ entries: 3 });
  const text = run.planner[0] ?? '';
  const inner = blockOf(text, 'inner');
  assert.notEqual(partOf(inner, 'kinds'), '', inner);
  assert.notEqual(partOf(inner, 'seeds'), '', inner);
  assert.ok(partOf(inner, 'selfreflection').includes(gistOf(2)), inner);
  assert.ok(!text.includes('<plan>'), 'no plan');
});
