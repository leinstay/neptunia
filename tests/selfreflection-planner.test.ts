// B6 of the master plan: the diary planner is the selfreflection planner. Its purpose, its prompt file, its pin in
// `models.byPurpose` follow the new name, and the block that listed the server lists the places she follows. What the request holds is in tests/selfreflection-requests.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './fixtures/source-tree.ts';
import { blocksOf } from '../src/turn/request/frame.ts';
import { MARK, blockOf, frameTurn, gistOf, inOrderOf, partOf, rootTags } from './fixtures/selfreflection-frame.ts';

const PLANNER = 'selfreflection-planner';

test('the tracked planner prompt has the new file name, fills the name and names the block the request carries', () => {
  // Bug: the prompt describes a block the request does not carry, so the model reads a block that is not there.
  const file = path.join(ROOT, 'prompts', `${PLANNER}.md`);
  assert.equal(fs.existsSync(path.join(ROOT, 'prompts', 'diary-plan.md')), false);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('{{name}}'));
  // Slice 6: the planner's request carries her entries in `<selfreflection>` and the kinds in `<kinds>`, and no
  // root-level `<places>` or `<diary>` any more; the prompt names the blocks that are there and none that left.
  for (const tag of ['<selfreflection>', '<kinds>']) assert.ok(text.includes(tag), tag);
  for (const tag of ['<server>', '<places>', '<diary>']) assert.equal(text.includes(tag), false, tag);
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
