import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import '../../../../src/tools/operations/index.ts';
import { useIface, useSelf } from '../../../fixtures/turn-world.ts';
import { entryOf } from '../../../fixtures/diary-mirror.ts';
import { mirrorScene } from '../../../fixtures/mirror-scene.ts';
import { FRAME_NOW, JOURNAL, PAGES, TEXT as FRAME_TEXT, frameTurn } from '../../../fixtures/diary-frame.ts';
import type { SceneMemory } from '../../../fixtures/diary-scene.ts';

// The diary wake keeps the id of its turn on the entry as `extra.turnId`, written through the one writer. The
// wake runs the real turn runner over tests/fixtures/diary-scene.ts with a real journal. Invented ids and
// synthetic text only.

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];

// The diary channel is held by a fake interface named `fake`; the persona is `self-id`.
useIface('fake');
useSelf('self-id');
after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

test('an <audience> naming a group room that is no mirror is refused, and the entry goes nowhere', async () => {
  // Bug: the persona's choice is checked against every group place memory knows, so a room that is no mirror passes.
  const scene = await mirrorScene({ ifaces: ['fake', 'tele'], start: FRAME_NOW });
  const run = await frameTurn({
    memory: scene.memory,
    mirrors: [JOURNAL, PAGES],
    entries: 0,
    answer: `<audience>place:fake:channel:c2</audience><msg>${FRAME_TEXT.entry}</msg>`,
  });
  const mirrors = scene.publisher();
  await mirrors.publishEntry(entryOf(run.result));
  await mirrors.drainQueued();
  const reasons = mirrors.mirrorStatus().flatMap((mirror) => mirror.audienceBlocked.map((one) => one.reason));
  assert.deepEqual(reasons, ['audience-unknown-place', 'audience-unknown-place']);
  assert.deepEqual(scene.transport('fake').attempts, []);
  assert.deepEqual(scene.transport('tele').attempts, []);
});
