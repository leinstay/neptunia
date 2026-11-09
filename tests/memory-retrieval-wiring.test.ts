// The consumers of memory reach the one retrieval service in production code, not only through the seams
// tests/memory-retrieval-consumers.test.ts exercises: a session's request, an attention's input, an
// errand, a diary post and the watcher's brief. Each test goes through the module the consumer calls. Fake model, real
// temporary databases, synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createErrandService } from '../src/errands/service.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { attentionRetrieval } from '../src/intentions/model.ts';
import { retrieveMemory } from '../src/memory/db/retrieve.ts';
import { sweep } from '../src/memory/db/session.ts';
import type { Context } from '../src/memory/db/scope.ts';
import type { MemoryPage } from '../src/memory/db/semantic-types.ts';
import { reviewDescription } from '../src/memory/db/describe.ts';
import { memoryQueryFor } from '../src/memory/retrieval-input.ts';
import type { RetrievalInput } from '../src/memory/retrieval-input.ts';
import { createSelfreflection } from '../src/turn/selfreflection.ts';
import { buildBrief } from '../src/watcher/brief.ts';
import { watcherMemory } from '../src/watcher/install.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import {
  NOW,
  baseConfig,
  chat,
  ctxOf,
  fakeLlm,
  fixture,
  memoryBlock,
  memoryRing,
} from './fixtures/memory-db/session-rig.ts';
import {
  ALEX,
  KAI,
  ROOM,
  START,
  addEntity,
  addSource,
  commit,
  semanticWorld,
  worksOn,
} from './fixtures/memory-db/semantic-world.ts';

const SECRET = 'xylophonewhisper';
const BOUNDS = { seeds: 3, hops: 2, nodes: 10, edges: 30, assertions: 6, evidence: 9, tokens: 900, deadlineMs: 700 };
const deps = { now: () => START, embedQuery: null, model: null };
const FACT_TEXT = 'Alex keeps Lumen running';

function known() {
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen');
  const hidden = addSource(world, 'alex', `Lumen and ${SECRET}`);
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  commit(world, worksOn(ALEX, lumen.entityId, [open], { text: FACT_TEXT }));
  commit(world, worksOn(KAI, lumen.entityId, [hidden], { text: `private ${SECRET}` }), world.contexts.alex);
  return { world, lumen, open };
}

test('the memory service reads a consumer input under the settings of this moment, and null while they are absent', async () => {
  // Bug: the service caches a budget, or a config with no retrieval settings turns into a thrown turn.
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-service-'), 'data') });
  const service = wrongly<{
    issueContext(spec: object): Context;
    retrievalBoundsFor(purpose: string): { hops: number } | null;
    retrieve(ctx: Context, input: RetrievalInput): Promise<MemoryPage | null>;
  }>(memory.memoryDb);
  const ctx = service.issueContext({ kind: 'internal' });
  const input: RetrievalInput = { purpose: 'task', goal: 'nothing stored', refs: [] };
  assert.equal(service.retrievalBoundsFor('task'), null);
  assert.equal(await service.retrieve(ctx, input), null);
  wrongly<{ config: unknown }>(memory.hot).config = { memoryDb: { retrieval: { ...BOUNDS, hops: 1 } } };
  assert.equal(service.retrievalBoundsFor('task')?.hops, 1);
  assert.deepEqual((await service.retrieve(ctx, input))?.assertions, []);
});

test('an attention wake asks for its own purpose, people and place', () => {
  // Bug: the wake reads the prefetch's default query instead of what the intention was about.
  const input = attentionRetrieval(
    [{ purpose: 'ask about lumen', attend: { place: ROOM, people: ['n3'] } }],
    () => KAI
  );
  assert.deepEqual(input, {
    purpose: 'attention',
    intention: { purpose: 'ask about lumen', people: [KAI], entities: [], place: ROOM },
  });
  assert.equal(
    attentionRetrieval([], () => null),
    null
  );
});

test('a memory session writes a structured fact from its answer and shows what it retrieved in the next request', async () => {
  // Bug: the session writer is never reached in an apply, or the batch never sees what she stored before.
  const env = fixture();
  chat(env);
  const base = baseConfig({ mode: 'apply' });
  const config = { ...base, memoryDb: { ...wrongly<object>(base.memoryDb), retrieval: { ...BOUNDS } } };
  const answer = {
    entities: [{ handle: 'n1', kind: 'project', name: 'Hello', language: 'en', sources: [1] }],
    assertions: [
      {
        predicate: { id: 'project.status', version: 1 },
        assertionKind: 'property',
        text: 'hello is ongoing',
        arguments: [
          { role: 'project', position: 0, ref: 'n1' },
          { role: 'status', position: 0, literal: 'ongoing' },
        ],
        polarity: 'positive',
        how: 'said',
        sources: [1],
      },
    ],
  };
  const first = fakeLlm(memoryBlock(answer));
  await sweep(ctxOf(env, { llm: first, config: wrongly(config) }));
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM semantic_entities').get()?.n, 1);
  env.say({ native: 'later', minutesAgo: -30, text: 'hello again, how is hello doing' });
  const second = fakeLlm(memoryBlock({}));
  await sweep(
    { ...ctxOf(env, { llm: second, config: wrongly(config) }), now: () => NOW + 3_600_000 },
    { ignoreSweepCap: true }
  );
  const asked = JSON.stringify(second.calls.at(-1));
  assert.match(asked, /<retrieved>/);
  assert.match(asked, /hello is ongoing/);
  env.done();
});

test('an entity description review reads the assertions that name the entity, under its own context', async () => {
  // Bug: the review refuses an entity, or reads a private fact into a public description.
  const { world, lumen } = known();
  const seen: Array<string> = [];
  const llm = {
    complete: (messages: unknown) => {
      seen.push(JSON.stringify(messages));
      return Promise.reject(new Error('stop here'));
    },
    capLeft: () => 10,
  };
  const prompts = { labels, 'description-draft': 'x {{name}}', 'description-check': 'y' };
  await reviewDescription(world.db, { kind: 'entity', id: lumen.entityId }, 'purpose', {
    ctx: wrongly({
      db: world.db,
      llm,
      hot: { config: baseConfig({ mode: 'apply' }), prompts },
      env: {},
      ring: memoryRing(),
      now: () => START,
      write: () => Promise.resolve(null),
      log: {},
      selfName: 'Nep',
      readCtx: world.contexts.group,
    }),
  }).catch(() => null);
  const asked = seen.join('\n');
  assert.ok(asked.includes(FACT_TEXT), 'the review did not read the assertion that names the entity');
  assert.ok(!asked.includes(SECRET));
  world.handle.close();
});

test('an errand carries the facts of its goal, and a private errand none', async () => {
  // Bug: the runner gets a private fact, or a task with no home root gets nothing.
  const { world } = known();
  const dir = tempDir('nep-errand-');
  const quiet = { warn() {}, info() {}, error() {}, debug() {} };
  const hot = { config: { errands: {} } };
  const runs: Array<{ context?: { memory?: Array<{ text: string }> } }> = [];
  const memory = openTestMemorySync({ dataDir: path.join(dir, 'data') });
  const errands = createErrandService(
    wrongly({
      client: {
        configured: () => true,
        run: (task: (typeof runs)[number]) => {
          runs.push(task);
          return Promise.resolve({
            status: 'done',
            result: { text: 'ok', sources: [], files: [] },
            usage: { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 },
          });
        },
        cancel: () => true,
      },
      stores: createErrandStores(wrongly({ memoryDb: memory.memoryDb, config: () => hot.config, log: quiet })),
      hot,
      log: quiet,
      defer: (fn: () => void) => fn(),
      retrieve: (input: RetrievalInput) =>
        retrieveMemory(world.db, world.contexts.group, memoryQueryFor(input, BOUNDS), deps),
    })
  );
  const ask = {
    agent: 'scout',
    goal: 'finish lumen',
    requester: { accountId: '7', kind: 'member' },
    origin: { channelId: 'c1', messageId: 'm1' },
  };
  errands.submit(wrongly({ ...ask, scope: 'group' }));
  errands.submit(wrongly({ ...ask, scope: 'dm' }));
  await errands.idle();
  const scoped = (scope: string) => runs.find((one) => wrongly<{ scope?: string }>(one.context).scope === scope);
  const group = scoped('group');
  const dm = scoped('dm');
  assert.ok(group?.context?.memory?.some((one) => one.text === FACT_TEXT));
  assert.ok(!JSON.stringify(group).includes(SECRET));
  assert.ok(dm);
  assert.equal(dm.context?.memory, undefined);
  world.handle.close();
});

test('a diary plan is told the stored facts of group chats and no private one', async () => {
  // Bug: the diary reads under an internal context and a mirror publishes a private fact.
  const { world } = known();
  const asked: Array<unknown> = [];
  const { prepareSelfreflection } = createSelfreflection(
    wrongly({
      hot: { prompts: { labels, 'selfreflection-planner': 'plan the entry', 'selfreflection-seeds': '' } },
      store: {
        state: { data: {} },
        getPlace: () => null,
        getSelfreflection: () => ({ posts: [] }),
        topPlaces: () => [],
        listChannels: () => [],
        getLore: () => [],
        listUserProfiles: () => [{ id: 'n1' }],
        getUser: () => null,
        personOfAccount: () => ALEX,
      },
      llm: {
        complete: (messages: unknown) => {
          asked.push(messages);
          return Promise.resolve({ choices: [{ message: { content: '{}' } }] });
        },
      },
      calibrator: { apply: (tokens: number) => tokens },
      rng: () => 0,
      lookup: undefined,
      images: null,
      journalOp: () => null,
      recentOfPlaces: () => ({ lines: null, audience: null }),
      selfreflectionFacts: (input: RetrievalInput) =>
        retrieveMemory(world.db, world.contexts.groups, memoryQueryFor(input, BOUNDS), deps),
    })
  );
  await wrongly<(input: object) => Promise<unknown>>(prepareSelfreflection)({
    config: { selfreflection: {}, llm: { maxRequestTokens: 100000 }, bot: { timezone: 'UTC' } },
    channel: { id: 'c1', rootId: null, permissions: {} },
    selfName: 'Nep',
    history: [],
    now: START + 3_600_000,
    params: {},
    memoryOn: true,
    // Slice 6: the plan request is built on the frame by the request step; this stand-in carries the stored facts the
    // step read, so the assertions below still see what reached the planner.
    planMessages: (parts: { facts: string }) => [{ role: 'user', content: parts.facts }],
  }).catch(() => null);
  const text = JSON.stringify(asked);
  assert.ok(text.includes(FACT_TEXT), 'the plan request carries no stored fact');
  assert.ok(!text.includes(SECRET));
  world.handle.close();
});

test('the watcher brief holds group facts about failures and never a private one', async () => {
  // Bug: the report can reach a public filing, and a DM fact reaches it through the brief.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'the job failed');
  const hidden = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  commit(world, worksOn(ALEX, entityId, [open], { text: 'the failed job belongs to Alex' }));
  commit(world, worksOn(KAI, entityId, [hidden], { text: `failed ${SECRET}` }), world.contexts.alex);
  const lines = await watcherMemory({
    dataDir: path.dirname(world.file),
    config: { memoryDb: { retrieval: { ...BOUNDS } }, recall: { prefetch: { maxTokens: 900, deadlineMs: 700 } } },
    now: () => START,
  });
  assert.ok(lines.some((line) => line.includes('the failed job belongs to Alex')));
  assert.ok(!lines.join('\n').includes(SECRET));
  const brief = buildBrief({ prompt: 'p', day: '2026-11-05', reportsDir: tempDir('nep-brief-'), memory: lines });
  assert.match(brief, /<memory>\n/);
  assert.doesNotMatch(buildBrief({ prompt: 'p', day: '2026-11-05', reportsDir: tempDir('nep-brief-') }), /<memory>/);
  world.handle.close();
});
