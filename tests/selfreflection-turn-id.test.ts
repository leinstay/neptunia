// The selfreflection wake keeps the id of its turn on the entry as `extra.turnId`, written through the one writer. The
// wake runs the real turn runner over tests/fixtures/selfreflection-scene.ts with a real journal. Invented ids and
// synthetic text only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { dbOf } from '../src/memory/db/types.ts';
import { createJournal } from '../src/memory/journal.ts';
import { NOW, sceneHot, sceneLlm, sceneMemory, sceneWorld } from './fixtures/selfreflection-scene.ts';
import type { SceneMemory } from './fixtures/selfreflection-scene.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];
after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

/** The `extra` of a stored entry, parsed. */
function extraOf(db: ReturnType<typeof dbOf>, entryId: string): Record<string, unknown> {
  const raw = db.prepare('SELECT extra FROM selfreflection WHERE id = ?').get(entryId)?.extra;
  assert.ok(typeof raw === 'string', `the entry ${entryId} has its extra`);
  return JSON.parse(raw) as Record<string, unknown>;
}

// The lead: kept when the removal command went (owner, 2026-11-06).
test('an entry written by a selfreflection wake keeps the id of its turn as extra.turnId', async () => {
  // Bug: the entry is stored with no link to the turn that wrote it.
  const scene = await sceneMemory();
  OPEN.push(scene);
  sceneWorld();
  const { memoryDb, dataDir } = scene.memory;
  const runner = worldTurnRunner({
    hot: sceneHot(),
    store: scene.store,
    llm: sceneLlm(),
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: null,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
    journal: createJournal({ memoryDb, dataDir, now: () => NOW }),
  });
  // The world runner answers its result untyped; the wake names its outcome, its turn and its entry.
  const result = (await runner.runTurn({
    mode: 'selfreflection',
    selfreflection: { kind: null, forced: false },
    placeId: 'g1',
  })) as { outcome?: unknown; turnId?: unknown; selfreflection?: { entry?: { id?: unknown } } };
  assert.equal(result.outcome, 'spoke', 'the wake records an entry');
  const reflection = result.selfreflection;
  const entryId = reflection?.entry?.id;
  assert.ok(typeof entryId === 'string' && typeof result.turnId === 'string', 'the wake names its entry and its turn');
  scene.store.flush();
  await scene.store.flushSettled({});
  assert.equal(extraOf(dbOf(memoryDb.readHandle() as { db: unknown }), entryId).turnId, result.turnId);
});
