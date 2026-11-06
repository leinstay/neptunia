// How the removal of a selfreflection entry finds the turn that wrote it (the lead's decision of 2026-11-06): an entry
// keeps the id of its turn as `extra.turnId`, written by the selfreflection wake through the one writer, and the removal
// reads it, since the publisher posts the entry and no `answer` line names its messages. For an entry from before, the
// owner names the turn: `removeSelfreflectionEntry({ entryId, by, port, turnId })`, refused with `unknown-turn` when the
// id names no turn. The wake runs the real turn runner over tests/fixtures/selfreflection-scene.ts with a real journal;
// the removal runs over tests/fixtures/selfreflection-removal.ts. Invented ids and synthetic text only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createJournal } from '../src/memory/journal.ts';
import { NOW, sceneHot, sceneLlm, sceneMemory, sceneWorld } from './fixtures/selfreflection-scene.ts';
import type { SceneMemory } from './fixtures/selfreflection-scene.ts';
import { T0, removalScene, rowsWhere, tableCounts } from './fixtures/selfreflection-removal.ts';
import type { DeletePort, EntryRemoval, RemovalScene } from './fixtures/selfreflection-removal.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];
after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

/** The removal as these tests reach it: the owner may name the turn of an entry that does not keep one. */
type NamingTurn = {
  removeSelfreflectionEntry(request: {
    entryId: string;
    by: string;
    port: (iface: string) => DeletePort | null;
    turnId?: string;
  }): Promise<EntryRemoval | { ok: false; code: 'unknown-turn' }>;
};

const SCOPED = { scope_kind: 'group', scope_iface: 'fake', scope_dm: null };

/** The `extra` of a stored entry, parsed. */
function extraOf(db: ReturnType<typeof dbOf>, entryId: string): Record<string, unknown> {
  const raw = db.prepare('SELECT extra FROM selfreflection WHERE id = ?').get(entryId)?.extra;
  assert.ok(typeof raw === 'string', `the entry ${entryId} has its extra`);
  return JSON.parse(raw) as Record<string, unknown>;
}

/** An entry published once with one message and no turn rows that name its message. */
async function publishedAlone(rig: RemovalScene, id: string): Promise<void> {
  rig.scene.entry({ id, at: T0, messages: [`a quiet hour for ${id}`] });
  const outcomes = await rig.scene.publisher().publishEntry({ id, messages: [`a quiet hour for ${id}`] });
  assert.deepEqual(
    outcomes.map((one) => one.status),
    ['sent']
  );
}

/** A selfreflection turn's records as the journal and the request archive leave them: nothing in them names a message. */
function wakeTurn(rig: RemovalScene, turnId: string): { answerId: string } {
  const stamp = new Date(T0).toISOString();
  const answerId = `src:turn:${turnId}:1`;
  insertRows(
    rig.db,
    {
      sources: [
        {
          id: answerId,
          kind: 'answer',
          iface: 'fake',
          place_id: rig.mirror.placeId,
          occurred_at: stamp,
          recorded_at: stamp,
          turn_id: turnId,
          extra: JSON.stringify({ posted: [] }),
          ...SCOPED,
        },
      ],
      day: [
        { id: `day-${turnId}-start`, at: stamp, what: 'turn.start', turn_id: turnId, ...SCOPED },
        {
          id: `day-${turnId}-end`,
          at: stamp,
          what: 'turn',
          outcome: 'spoke',
          turn_id: turnId,
          source_id: answerId,
          ...SCOPED,
        },
      ],
      model_requests: ['plan', 'write'].map((purpose, step) => ({
        id: `req-${turnId}-${purpose}`,
        schema_version: 1,
        turn_id: turnId,
        attempt_id: '1',
        step,
        role: 'core',
        purpose,
        status: 'ok',
        started_at: stamp,
        finished_at: stamp,
        messages: '[]',
      })),
    },
    { at: stamp }
  );
  return { answerId };
}

/** What the database holds of the turn `turnId`: its lines, its day rows and its requests. */
const turnRows = (rig: RemovalScene, turnId: string): Array<string> => [
  ...rowsWhere(rig.db, 'sources', 'turn_id', turnId),
  ...rowsWhere(rig.db, 'day', 'turn_id', turnId),
  ...rowsWhere(rig.db, 'model_requests', 'turn_id', turnId),
];

test('an entry written by a selfreflection wake keeps the id of its turn as extra.turnId', async () => {
  // Bug: the entry is stored with no link to the turn that wrote it, so its removal cannot find the turn's records.
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
  // The lead: intermediate values named, for the chain rule.
  const reflection = result.selfreflection;
  const entryId = reflection?.entry?.id;
  assert.ok(typeof entryId === 'string' && typeof result.turnId === 'string', 'the wake names its entry and its turn');
  scene.store.flush();
  await scene.store.flushSettled({});
  assert.equal(extraOf(dbOf(memoryDb.readHandle() as { db: unknown }), entryId).turnId, result.turnId);
});

test("removing an entry whose extra.turnId is set removes that turn's answer line, day rows and requests", async () => {
  // Bug: the turn is looked for only through `posted`, which a published entry's turn never fills.
  const rig = await removalScene();
  await publishedAlone(rig, 'entry-with-turn');
  wakeTurn(rig, 'turn-wake-kept');
  rig.db
    .prepare("UPDATE selfreflection SET extra = json_set(extra, '$.turnId', ?) WHERE id = ?")
    .run('turn-wake-kept', 'entry-with-turn');
  assert.equal(turnRows(rig, 'turn-wake-kept').length, 5, 'the scene seeds the turn');
  const removal = await rig.remove('entry-with-turn');
  assert.equal(removal.ok, true, JSON.stringify(removal));
  assert.deepEqual(turnRows(rig, 'turn-wake-kept'), []);
});

test('an entry without extra.turnId, removed with the turn named, removes that turn', async () => {
  // Bug: the owner's turn id is ignored, and an older entry's turn stays behind every time.
  const rig = await removalScene();
  await publishedAlone(rig, 'entry-before-turn-ids');
  wakeTurn(rig, 'turn-wake-named');
  const { memory } = rig.scene;
  const service: NamingTurn = memory.memoryDb;
  const removal = await service.removeSelfreflectionEntry({
    entryId: 'entry-before-turn-ids',
    by: 'owner',
    port: rig.port,
    turnId: 'turn-wake-named',
  });
  assert.equal(removal.ok, true, JSON.stringify(removal));
  assert.deepEqual(turnRows(rig, 'turn-wake-named'), []);
});

test('a named turn that does not exist is refused as unknown-turn and changes nothing', async () => {
  // Bug: a mistyped turn id removes the entry and leaves its real turn, or removes nothing and answers ok.
  const rig = await removalScene();
  await publishedAlone(rig, 'entry-before-turn-ids');
  wakeTurn(rig, 'turn-wake-named');
  const before = tableCounts(rig.db);
  const { memory } = rig.scene;
  const service: NamingTurn = memory.memoryDb;
  const removal = await service.removeSelfreflectionEntry({
    entryId: 'entry-before-turn-ids',
    by: 'owner',
    port: rig.port,
    turnId: 'turn-nowhere',
  });
  assert.deepEqual(removal, { ok: false, code: 'unknown-turn' });
  assert.deepEqual(tableCounts(rig.db), before);
  assert.deepEqual(rig.deletes, []);
});
