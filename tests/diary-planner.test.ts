// B6 of the master plan: the diary planner's purpose, its prompt file, its pin in
// `models.byPurpose` follow the new name, and the block that listed the server lists the places she follows. What the request holds is in tests/diary-requests.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './fixtures/source-tree.ts';
import { blocksOf } from '../src/turn/request/frame.ts';
import { FRAME_NOW, MARK, blockOf, frameTurn, gistOf, inOrderOf, partOf, rootTags } from './fixtures/diary-frame.ts';

const PLANNER = 'diary-planner';

test('the tracked planner prompt has the new file name, fills the name and names the block the request carries', () => {
  // Bug: the prompt describes a block the request does not carry, so the model reads a block that is not there.
  const file = path.join(ROOT, 'prompts', `${PLANNER}.md`);
  // Changed: the assertion that `prompts/diary-plan.md` does not exist went with the rename of selfreflection to
  // diary; it guarded a file name of an older rename and names no file the engine reads.
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('{{name}}'));
  // Slice 6: the planner's request carries her entries in `<diary>` and the kinds in `<kinds>`, and no
  // root-level `<places>` any more; the prompt names the blocks that are there and none that left.
  // Changed: `<diary>` left the list of absent tags with the rename of selfreflection to diary, because the
  // entries' block is `<diary>` now and the line above requires it.
  for (const tag of ['<diary>', '<kinds>']) assert.ok(text.includes(tag), tag);
  for (const tag of ['<server>', '<places>']) assert.equal(text.includes(tag), false, tag);
});

// The planner on the turn frame (plan 2026-11-06-turn-frame, slice 6): a frame request with the diary list,
// `<kinds>`, `<seeds>` and `<diary>` in `<inner>`, and no plan of its own to read. Its answer stays JSON.
// tests/fixtures/diary-frame.ts holds the scene.

/** The planner's list without `persona`, which is the system message and no root tag of the user text. */
const PLANNER_TAGS = blocksOf('diary_plan', null).filter((name) => name !== 'persona');

test('the planner request holds the frame list and none of the old blocks', async () => {
  // Bug: the planner keeps its own request with `<now>`, `<places>`, `<about_chat>`, `<recent>`, `<lore>` and `<world>`.
  const run = await frameTurn();
  const text = run.planner[0] ?? '';
  const tags = rootTags(text);
  assert.ok(inOrderOf(tags, PLANNER_TAGS), tags.join(' '));
  for (const tag of ['self', 'inner', 'meanwhile', 'spatial_awareness', 'task'])
    assert.ok(tags.includes(tag), `holds <${tag}>`);
  assert.ok(blockOf(text, 'task').includes(MARK.planner), 'its own task');
});

test('the planner <inner> holds <kinds>, <seeds> and <diary>, and the request no <plan>', async () => {
  // Bug: the planner loses what it chooses from or its past entries, or reads a plan that it is there to make.
  const run = await frameTurn({ entries: 3 });
  const text = run.planner[0] ?? '';
  const inner = blockOf(text, 'inner');
  assert.notEqual(partOf(inner, 'kinds'), '', inner);
  assert.notEqual(partOf(inner, 'seeds'), '', inner);
  assert.ok(partOf(inner, 'diary').includes(gistOf(2)), inner);
  assert.ok(!text.includes('<plan>'), 'no plan');
});

test('the planner <my_day> holds an evening of yesterday that lies after her last entry', async () => {
  // Bug: the planner reads today's events alone, so what she did after her last entry and before midnight never
  // reaches an entry. Her last entry is a day before FRAME_NOW (12:00), the line of hers at 22:00 the evening before.
  const run = await frameTurn({
    entries: 3,
    context: { myDay: { lines: 12 }, calls: { lines: 12 } },
    gardenLines: [FRAME_NOW - 14 * 3_600_000],
  });
  const day = partOf(blockOf(run.planner[0] ?? '', 'inner'), 'my_day');
  assert.ok(day.includes('22:00'), day);
});
