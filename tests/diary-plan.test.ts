// The diary keeps what its planner planned and plans from seeds the recent entries did not take. A diary wake of
// the real turn runner over the scene of tests/fixtures/diary-scene.ts, with a scripted planner that names the
// combination it built on; the entry it records keeps `plan` (`brief`, the `seeds` offered and the `seed` taken) through
// the one writer. Synthetic text only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { userText } from '../src/behavior/prompt.ts';
import { createStore } from '../src/memory/store.ts';
import { NOW, PLANNER_PURPOSE, sceneHot, sceneMemory, sceneWorld } from './fixtures/diary-scene.ts';
import type { SceneMemory } from './fixtures/diary-scene.ts';
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

type Post = Parameters<SceneMemory['store']['appendDiaryPost']>[0];

/** A past entry the planner planned, taking combination `seed` of `seeds`. */
function plannedEntry(seeds: Array<Array<string>>, seed: number): Post {
  // The store's post type names the fields of an entry before plans were kept; the entry carries its plan as a new one does.
  const entry: Record<string, unknown> = {
    at: NOW - DAY / 2,
    kind: 'status',
    gist: 'an earlier evening',
    picture: null,
    search: null,
    itemId: 'diary:earlier-plan',
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

/** One diary wake whose planner answers `answer`, after the entries `earlier`: the plan request's user text. */
async function wake(
  answer: Record<string, unknown>,
  earlier: Array<Post> = [],
  kind: string | null = null
): Promise<{ scene: SceneMemory; user: string }> {
  const scene = await sceneMemory();
  OPEN.push(scene);
  for (const entry of earlier) scene.store.appendDiaryPost(entry, { max: 40 });
  sceneWorld();
  const hot = sceneHot();
  hot.prompts['diary-seeds'] = SEEDS;
  hot.prompts['diary-judge'] = 'JUDGE for {{name}}';
  const plans: Array<Array<{ content: unknown }>> = [];
  const llm = {
    calls: [] as Array<unknown>,
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    complete: (messages: Array<{ content: unknown }>, options?: { purpose?: string }) => {
      if (options?.purpose === 'diary-judge')
        return Promise.resolve({ text: JSON.stringify({ repeats: false, what: '' }), usage: {}, estimated: 5 });
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
    mode: 'diary',
    diary: { kind, forced: kind !== null },
    placeId: 'g1',
  });
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke', 'the wake records an entry');
  assert.equal(plans.length, 1, 'one plan request');
  // The lead: the request named first, for the chain rule.
  const [request] = plans;
  // Slice 6: the planner's request is built on the frame, its user message cache parts; read their text.
  return { scene, user: userText(request?.[1]?.content) };
}

/** The newest entry of the store's diary. */
function newest(store: SceneMemory['store']) {
  const { posts } = store.getDiary();
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

test('an entry whose brief the judge read keeps how many briefs were written and whether the last passed', async () => {
  // Bug: the entry does not say whether its brief was judged, so a repeat that went out cannot be found again.
  const earlier = plannedEntry([['a pier', 'fog']], 1);
  const { scene } = await wake(planAnswer(0), [earlier], 'status');
  assert.deepEqual(newest(scene.store).plan?.judge, { briefs: 1, passed: true });
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
