// Her entries reach the diary's writer from memory alone (plan 2026-11-06-turn-frame, slice 6): the diary turn
// runs nowhere, and `<diary>` in `<inner>` holds the entries memory keeps, the picture entry with what she saw
// in it, whether or not an interface is connected. The scene is tests/fixtures/diary-history.ts: five entries,
// the fourth a picture post. The requests recorded from the diary channel and its `<chat>` have no successor, since the
// writer has no chat any more. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT, NOW, sceneLlm } from './fixtures/diary-requests-recorded.ts';
import { GISTS, PICTURE, entriesPart, historyMemory, historyRunner, historyWorld } from './fixtures/diary-history.ts';
import type { HistoryMemory } from './fixtures/diary-history.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';

/** The scenes of the tests, closed when the file is done. */
const HISTORIES: Array<HistoryMemory> = [];
after(async () => {
  for (const scene of HISTORIES.splice(0)) await scene.memory.close();
});

/** The writer's `<diary>` of the history scene's turn; `port` replaces the world's interface. */
async function writerEntries(port: ReturnType<typeof createFakeAdapter> | null = null): Promise<string> {
  const scene = await historyMemory();
  HISTORIES.push(scene);
  // The interface knows the diary channel with Alice's line in it: it is there, and it is not hers.
  historyWorld({ history: true, alice: true });
  const llm = sceneLlm();
  const result = await historyRunner(llm, scene, port).runTurn({
    mode: 'diary',
    diary: { kind: null, forced: false },
    placeId: ROOT,
  });
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke', 'the scene records an entry');
  return entriesPart(llm);
}

test("the writer's <diary> holds her five entries from memory newest first, the picture described", async () => {
  // Bug: her entries do not reach the writer, come back oldest first, or the picture post loses what she saw in it.
  // newest first since 2026-11-14 (specs/2026-11-14-diary-in-her-own-words.md)
  // Slice 6: the entries are `<diary>` in `<inner>`, read from the diary table, where the writer's
  // `<chat>` of the diary channel stood.
  const part = await writerEntries();
  const at = GISTS.map((gist) => part.indexOf(gist));
  assert.ok(
    at.every((one) => one >= 0),
    part
  );
  assert.deepEqual(
    at,
    [...at].sort((a, b) => b - a),
    'newest first'
  );
  assert.ok(part.includes(PICTURE.description), part);
});

test("with no interface connected the writer's <diary> is the same, because it comes from memory", async () => {
  // Bug: the entries are read through the interface, so a turn with nothing connected writes without her diary.
  // Slice 6: the same scene read through `<diary>` instead of the diary channel's `<chat>`.
  // An interface that answers no read and takes no action: what a turn has when nothing is connected.
  const silent = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW, reads: [], operations: [] });
  const connected = await writerEntries();
  assert.ok(connected !== '', 'the connected turn shows her entries');
  assert.equal(await writerEntries(silent), connected);
});
