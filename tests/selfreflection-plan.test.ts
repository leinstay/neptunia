// The diary keeps what its planner planned and plans from seeds the recent entries did not take. A selfreflection wake of
// the real turn runner over the scene of tests/fixtures/selfreflection-scene.ts, with a scripted planner that names the
// combination it built on; the entry it records keeps `plan` (`brief`, the `seeds` offered and the `seed` taken) through
// the one writer, and the store reads a past entry's first linked picture as `pictureDescription`. Synthetic text only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { userText } from '../src/behavior/prompt.ts';
import { createStore } from '../src/memory/store.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { NOW, PLANNER_PURPOSE, sceneHot, sceneMemory, sceneWorld } from './fixtures/selfreflection-scene.ts';
import type { SceneMemory } from './fixtures/selfreflection-scene.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';
import { offeredKind } from './fixtures/plan-answer.ts';

const DAY = 24 * 60 * 60 * 1000;
const SEEDS = '# place\na pier\na roof\na field\n# light\nfog\nrain';
const BRIEF = 'a walk along the shore';

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];
after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

type Post = Parameters<SceneMemory['store']['appendSelfreflectionPost']>[0];

/** A past entry the planner planned, taking combination `seed` of `seeds`. */
function plannedEntry(seeds: Array<Array<string>>, seed: number): Post {
  // The store's post type names the fields of an entry before plans were kept; the entry carries its plan as a new one does.
  const entry: Record<string, unknown> = {
    at: NOW - DAY / 2,
    kind: 'status',
    gist: 'an earlier evening',
    picture: null,
    search: null,
    itemId: 'selfreflection:earlier-plan',
    plan: { brief: 'an earlier evening', seeds, seed },
  };
  return entry as Post;
}

/** The combinations of the `<seeds>` block of a request's user text, each as its lines. */
function offered(user: string): Array<Array<string>> {
  const start = user.indexOf('<seeds>');
  const end = user.indexOf('</seeds>');
  assert.ok(start >= 0 && end > start, 'the plan request carries <seeds>');
  return user
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).split('; '));
}

/** One selfreflection wake whose planner answers `answer`, after the entries `earlier`: the plan request's user text. */
async function wake(
  answer: Record<string, unknown>,
  earlier: Array<Post> = []
): Promise<{ scene: SceneMemory; user: string }> {
  const scene = await sceneMemory();
  OPEN.push(scene);
  for (const entry of earlier) scene.store.appendSelfreflectionPost(entry, { max: 40 });
  sceneWorld();
  const hot = sceneHot();
  hot.prompts['selfreflection-seeds'] = SEEDS;
  const plans: Array<Array<{ content: unknown }>> = [];
  const llm = {
    calls: [] as Array<unknown>,
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    complete: (messages: Array<{ content: unknown }>, options?: { purpose?: string }) => {
      const planning = options?.purpose === PLANNER_PURPOSE;
      if (planning) plans.push(structuredClone(messages));
      const kind = offeredKind(options);
      const text = planning
        ? JSON.stringify({ ...answer, ...(kind ? { kind } : {}) })
        : '<msg>a quiet evening by the water</msg>';
      return Promise.resolve({ text, usage: {}, estimated: 5 });
    },
  };
  const runner = worldTurnRunner({
    hot,
    store: scene.store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: null,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
  const result = await runner.runTurn({
    mode: 'selfreflection',
    selfreflection: { kind: null, forced: false },
    placeId: 'g1',
  });
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke', 'the wake records an entry');
  assert.equal(plans.length, 1, 'one plan request');
  // The lead: the request named first, for the chain rule.
  const [request] = plans;
  // Slice 6: the planner's request is built on the frame, its user message cache parts; read their text.
  return { scene, user: userText(request?.[1]?.content) };
}

/** The newest entry of the store's selfreflection. */
function newest(store: SceneMemory['store']) {
  const { posts } = store.getSelfreflection();
  const last = posts.at(-1);
  assert.ok(last, 'the store holds an entry');
  return last;
}

const planAnswer = (seed: unknown) => ({ kind: 'status', brief: BRIEF, search: '', picture: false, seed });

test('an entry written after a plan keeps the brief, the combinations offered and the one taken', async () => {
  // Bug: the plan is dropped on the way to the writer, so nothing can tell which seed an entry used.
  const { scene, user } = await wake(planAnswer(2));
  assert.deepEqual(newest(scene.store).plan, { brief: BRIEF, seeds: offered(user), seed: 2 });
});

test('the plan of an entry is still there after the database is reopened', async () => {
  // Bug: the plan lives in the store's cache only and is lost when the extra column is written or read.
  const { scene } = await wake(planAnswer(1));
  scene.store.flush();
  await scene.store.flushSettled({});
  const { dataDir } = scene.memory;
  OPEN.splice(OPEN.indexOf(scene), 1);
  await scene.memory.close();
  const memory = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'fake' });
  const store = createStore({ dataDir, memoryDb: memory.memoryDb });
  OPEN.push({ memory, store });
  const plan = newest(store).plan;
  assert.equal(plan?.brief, BRIEF);
  assert.equal(plan?.seed, 1);
});

for (const [label, seed] of [
  ['missing', undefined],
  ['negative', -1],
  ['fractional', 1.5],
  ['too large', 3],
  ['non-numeric', 'one'],
] as const) {
  test(`a ${label} seed in the plan answer is stored as 0`, async () => {
    // Bug: a seed the planner did not give or could not have meant marks a combination as taken.
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    const { scene } = await wake(planAnswer(seed));
    // A seed that is not a whole number is a broken answer, and a broken answer stores no plan.
    assert.equal(newest(scene.store).plan?.seed, Number.isInteger(seed) ? 0 : undefined);
  });
}

test('the plan request leaves out the lines of the combination a recent entry took', async () => {
  // Bug: the planner is offered the place and the light of the last entry again, and the diary repeats its scene.
  const earlier = plannedEntry(
    [
      ['a roof', 'rain'],
      ['a pier', 'fog'],
    ],
    1
  );
  const { user } = await wake(planAnswer(0), [earlier]);
  const lines = offered(user).flat();
  assert.ok(lines.length > 0, user);
  assert.equal(lines.includes('a roof'), false, user);
  assert.equal(lines.includes('rain'), false, user);
});

test('the store reads an entry with the description of its first linked picture', async () => {
  // Bug: the store never joins the entry's pictures, so an old row's <diary> line falls back to its drawing prompt.
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'fake' });
  const writer = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  OPEN.push({ memory, store: writer });
  const entry: Record<string, unknown> = {
    at: NOW - DAY,
    kind: 'picture',
    gist: 'a long way down',
    picture: 'a cafe interior, warm light',
    search: null,
    itemId: 'selfreflection:described',
  };
  writer.appendSelfreflectionPost(entry as Post, { max: 40 });
  writer.flush();
  await writer.flushSettled({});
  const db = dbOf(memory.memoryDb.readHandle() as { db: unknown });
  const group = { scope_kind: 'group', scope_iface: 'fake', scope_dm: null };
  const picture = (id: string, description: string) => ({
    id,
    kind: 'image',
    owner: 'selfreflection:described',
    path: `media/selfreflection/${id}.png`,
    native_ref: null,
    description,
    mime: 'image/png',
    ...group,
  });
  insertRows(
    db,
    {
      media: [
        picture('media:first', 'a girl rides a red bicycle down a hill'),
        picture('media:second', 'a dog in the rain'),
      ],
      media_links: ['media:first', 'media:second'].map((id, position) => ({
        owner_kind: 'selfreflection',
        owner_id: 'selfreflection:described',
        position,
        media_id: id,
      })),
    },
    { at: new Date(NOW).toISOString() }
  );
  const reader = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  assert.equal(newest(reader).pictureDescription, 'a girl rides a red bicycle down a hill');
});
