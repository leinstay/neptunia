// Tests for src/behavior/recall-run.ts: the gates of the persona's own search and what it says when it finds nothing,
// over a fake store and a fake LLM; its boundaries over synthetic SQLite sources and legacy memory fakes; and the
// prefetch and search over the one retrieval service, with a fake model and real temporary databases. No network,
// no real data.
import { noMediaNames } from '../../fixtures/media-namer.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRecall } from '../../../src/behavior/recall-run.ts';
import { estimateTokens } from '../../../src/llm/tokens.ts';
import { channelPlaceId, dmPlaceId } from '../../../src/memory/db/ids.ts';
import { issueContext, dmScope, groupContext, groupScope } from '../../../src/memory/db/scope.ts';
import { createStore } from '../../../src/memory/store.ts';
import {
  fixture,
  dmOfMember,
  dmSpecOf,
  personId as dbPersonId,
  storedDmOf,
  storedPersonOf,
} from '../../fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from '../../fixtures/memory-db/audiences.ts';
import {
  ALEX,
  MIRA,
  ROOM,
  START,
  addEntity,
  addSource,
  commit,
  semanticWorld,
  worksOn,
} from '../../fixtures/memory-db/semantic-world.ts';
import type { World } from '../../fixtures/memory-db/semantic-world.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { channel as channelInfo, privateChannel, rig } from '../../fixtures/reads-rig.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { asRecord } from '../../fixtures/records.ts';
import { ROOT, MINUTE, NOW, RABBIT_SERVER, config } from '../../fixtures/recall-run-kit.ts';
import { memoryAt } from '../../fixtures/store-kit.ts';
import { unitLines } from '../../../src/memory/db/readers/common.ts';
import { placeCollection, accountCollection } from '../../../src/memory/db/unit-keys.ts';
import path from 'node:path';
import { snapshotOf } from '../../../src/behavior/snapshot.ts';
import { createAppendStore } from '../../../src/memory/append-store.ts';
import { archiveEntry, createArchive } from '../../../src/memory/archive.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { createMemoryDb } from '../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../src/memory/db/service.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db } from '../../../src/memory/db/types.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { createRecord } from '../../../src/memory/record.ts';
import { createVectors } from '../../../src/memory/vectors.ts';
import { addAccount, addDmPlace, addGroupPlace } from '../../fixtures/memory-db/opaque-people.ts';
import { writeUnitUpdate } from '../../fixtures/memory-db/unit-writes.ts';
import { fillStems } from '../../../src/memory/db/stems.ts';
import {
  AT,
  GENERAL,
  KINDS,
  PRESENCES,
  assertForms as checkForms,
  fixture as mediaFixture,
  observeLine,
  recallRig,
} from '../../fixtures/media-memory.ts';
import type { Env, Kind, Presence } from '../../fixtures/media-memory.ts';
import { observe } from '../../../src/memory/db/observe.ts';
import { observationOf } from '../../../src/memory/db/observe-event.ts';
import { insertRows } from '../../../src/memory/db/rows.ts';
import { personId } from '../../fixtures/memory-db/spelled-ids.ts';
import { runMemorySearch } from '../../../src/tools/tools.ts';
import { lineEvent } from '../../fixtures/core-over-fake.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { search } from '../../../src/memory/db/recall.ts';

/**
 * A scene: the runner over a store holding `memory` (its other read methods, appendRecallTrace among them), with
 * the daily request cap at `capLeft` and no memory database; `args` a search from #general (c1) of root g1, `dm` a
 * private chat with the member u5.
 */
function scene({ features = {}, capLeft = 100, memory = {} }: Record<string, Untyped> = {}) {
  const store = {
    state: { data: {}, markDirty() {} },
    listUserProfiles: () => [],
    ...memory,
  };
  const llmCalls: Array<unknown> = [];
  const llm = {
    capLeft: () => capLeft,
    complete: (...call: Array<unknown>) => {
      llmCalls.push(call);
      return Promise.resolve({ text: '' });
    },
  };
  const recaller = createRecall({
    iface: 'discord',
    mediaNameOf: noMediaNames,
    hot: { config: config({ features }), prompts: { labels } },
    store,
    llm,
    now: () => NOW,
  });
  const history = [
    { id: 'h1', placeId: 'c1', ts: NOW - 30 * MINUTE, authorName: 'Nikos', content: 'τι έγινε με το κουνέλι;' },
    { id: 'h2', placeId: 'c1', ts: NOW - MINUTE, authorName: 'Nikos', content: 'ποιος σκότωσε το κουνέλι;' },
  ];
  const dm = channelInfo('dm1', { kind: 'dm', rootId: null, chatType: 'dm', partnerId: 'u5', audience: null });
  const args = {
    placeId: ROOT,
    channel: channelInfo('c1', { name: 'general' }),
    partnerId: null,
    selfName: 'Zoë',
    history,
    candidate: history[1],
  };
  return { recaller, args, dm, llmCalls };
}

/** A real store over its memory database in a fresh temporary directory (never data/), and the trace lines of root g1. */
function tempStore() {
  const dataDir = tempDir('recall-trace-');
  const { memoryDb } = memoryAt(dataDir);
  const store = createStore({ dataDir, memoryDb });
  const lines = () =>
    unitLines(memoryDb.readHandle()?.db, placeCollection('recall_trace', ROOT)).map((l) => JSON.parse(l));
  return { store, lines, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('recall: a spent daily request cap stops it before any request', async () => {
  const spent = scene({ capLeft: 0 });
  const second = await withCapturedLogs(() => spent.recaller.run({ ...spent.args, server: RABBIT_SERVER }));
  assert.deepEqual(
    second.logs.map((l) => [l.msg, l.reason]),
    [['recall: skipped', 'daily-cap']]
  );
  assert.equal(spent.llmCalls.length, 0);
});

test('recall: a private chat or nothing asked make no request', async () => {
  const quiet = scene();
  const privateChat = quiet.dm;
  const priv = await withCapturedLogs(() =>
    quiet.recaller.run({ ...quiet.args, channel: privateChat, server: RABBIT_SERVER })
  );
  assert.deepEqual(
    priv.logs.map((l) => l.reason),
    ['private-chat']
  );
  const none = await withCapturedLogs(() =>
    quiet.recaller.run({ ...quiet.args, server: { forms: [], who: [], from: null, to: null } })
  );
  assert.deepEqual(
    none.logs.map((l) => l.reason),
    ['no-query']
  );
  assert.equal(quiet.llmCalls.length, 0);
});

test('recall: a run skipped early still writes its trace line with the reason', async () => {
  const t = tempStore();
  try {
    const memory = {
      appendRecallTrace: (...args: Parameters<typeof t.store.appendRecallTrace>) => t.store.appendRecallTrace(...args),
    };
    const capped = scene({ features: { recallTrace: true }, capLeft: 0, memory });
    await withCapturedLogs(() => capped.recaller.run({ ...capped.args, server: RABBIT_SERVER }));
    const planless = scene({ features: { recallTrace: true }, memory });
    await withCapturedLogs(() =>
      planless.recaller.run({ ...planless.args, server: { forms: [], who: [], from: null, to: null } })
    );
    await t.store.flushSettled({});
    const [first, second, ...rest] = t.lines();
    assert.equal(rest.length, 0);
    assert.equal(first.skipped, 'daily-cap');
    assert.deepEqual([first.placeId, first.triggerId, first.forms], ['c1', 'h2', RABBIT_SERVER.forms]);
    assert.deepEqual([first.clusters, first.people, first.plan, first.memory, first.record], [[], [], [], [], []]);
    assert.deepEqual(first.summary, { answer: null, stretch: null, text: null, note: null });
    assert.equal(second.skipped, 'no-query');
  } finally {
    t.cleanup();
  }
});

// The persona's own memory.search (src/tools/tools.ts): what the persona is told when it finds nothing.

test('recall-run outcome: a spent daily request cap is named', async () => {
  const spent = scene({ capLeft: 0 });
  const second = await withCapturedLogs(() => spent.recaller.run({ ...spent.args, server: RABBIT_SERVER }));
  assert.deepEqual(asRecord(second.result).outcome, { kind: 'daily-cap' });
  const other = await withCapturedLogs(() =>
    scene().recaller.run({ ...scene().args, server: { forms: [], who: [], from: null, to: null } })
  );
  assert.equal(asRecord(other.result).outcome, undefined, 'a gate that is no news to the persona says nothing');
});

test("recall-run outcome: a throw is an error; with no open memory database the persona's own search is not-configured", async () => {
  const thrown = scene();
  const server = {
    get forms() {
      throw new Error('boom');
    },
    who: [],
    from: null,
    to: null,
  };
  const failed = await withCapturedLogs(() => thrown.recaller.run({ ...thrown.args, server }));
  assert.deepEqual(asRecord(failed.result).outcome, { kind: 'error' });
  const closed = scene();
  const none = await withCapturedLogs(() => closed.recaller.run({ ...closed.args, server: RABBIT_SERVER }));
  assert.deepEqual(asRecord(none.result).outcome, { kind: 'not-configured' });
});

test("recall-run: the persona's own search is available without a summary prompt, and not once the daily cap is spent", () => {
  assert.equal(scene().recaller.available(), true);
  assert.equal(scene({ capLeft: 0 }).recaller.available(), false);
});

// ---- boundaries over synthetic SQLite sources and legacy memory fakes ----

const BOUNDARY_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const BOUNDARY_PLACE = channelPlaceId('discord', 'main');
const boundaryArgs = {
  placeId: 'g1',
  channel: channelInfo('main'),
  partnerId: null,
  selfId: 'self',
  selfName: 'Persona',
  history: [],
  candidate: { content: 'rabbit' },
};
const boundaryHot = {
  config: config({ features: { recall: true, meaningSearch: false } }),
  prompts: { labels },
};
const BOUNDARY_LANES = [{ kind: 'message', text: 'rabbit', words: 'rabbit' }];
type Quotes = { outcome: { kind: string }; quotes: Array<{ channelName: string | null; lines: string }> };

function boundaryScene(env: ReturnType<typeof fixture>, store: object = {}) {
  // The recall fixture stores the default place's row itself.
  env.db
    .prepare(
      "INSERT OR IGNORE INTO places (id, iface, kind, native_id, scope_kind) VALUES (?, 'discord', 'channel', 'main', 'group')"
    )
    .run(BOUNDARY_PLACE);
  env.say({ native: 'boundary-before', at: BOUNDARY_NOW - 120000, text: 'rabbit boundary evidence' });
  env.say({ native: 'boundary-anchor', at: BOUNDARY_NOW - 60000, text: 'rabbit anchor evidence' });
  env.stem();
  fillEnvAudiences(env);
  return createRecall({
    mediaNameOf: noMediaNames,
    iface: 'discord',
    hot: boundaryHot,
    store,
    now: () => BOUNDARY_NOW,
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('unexpected model call')) },
    memoryDb: { database: () => env.db },
  });
}

test('a window without a chat context returns no configured reader or evidence', async () => {
  const env = fixture();
  try {
    const recall = boundaryScene(env);
    // The public window result includes outcome and quotes beyond its broad declared record type.
    const found = (await recall.window({
      ...boundaryArgs,
      placeId: null,
      channel: null,
      anchor: 'boundary-anchor',
      messages: 1,
    })) as unknown as Quotes;
    assert.equal(found.outcome.kind, 'not-configured');
    assert.equal(found.quotes?.length ?? 0, 0);
  } finally {
    env.done();
  }
});

test('prefetch without a chat context is unavailable and performs no retrieval', async () => {
  const env = fixture();
  try {
    let reads = 0;
    const recall = boundaryScene(env, {
      listUserProfiles: () => {
        reads += 1;
        return [];
      },
    });
    const found = await recall.prefetch({ ...boundaryArgs, placeId: null, channel: null, lanes: BOUNDARY_LANES });
    assert.equal(found?.status, 'unavailable');
    assert.deepEqual(found?.excerpts, []);
    assert.equal(found?.stats?.searches ?? 0, 0);
    assert.equal(reads, 0);
  } finally {
    env.done();
  }
});

for (const scope of ['dm', 'internal']) {
  test(`an outward window hides the ${scope} place name while retaining readable source text`, async () => {
    const env = fixture();
    try {
      const recall = boundaryScene(env);
      env.db
        .prepare('UPDATE places SET scope_kind = ?, name = ? WHERE id = ?')
        .run(scope, 'Private location', BOUNDARY_PLACE);
      // The source audience remains group-readable independently of the place name.
      const found = (await recall.window({
        ...boundaryArgs,
        anchor: 'boundary-anchor',
        messages: 1,
      })) as unknown as Quotes;
      assert.equal(found.quotes.length, 1);
      const quote = found.quotes[0];
      assert.ok(quote.lines.includes('rabbit boundary evidence'));
      assert.equal(quote.channelName, null);
    } finally {
      env.done();
    }
  });
}

/** A prefetch over stored memory alone, with `store` and `archive` as its only sources. */
function storedOnly(store: object, archive: { iterate: () => Iterable<object> } | null = null) {
  return createRecall({
    mediaNameOf: noMediaNames,
    iface: 'discord',
    hot: boundaryHot,
    now: () => BOUNDARY_NOW,
    store: { listUserProfiles: () => [], ...store },
    archive,
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('unexpected model call')) },
    memoryDb: { database: () => null },
  });
}

test('prefetch returns stored lore when the database is unavailable for a valid root', async () => {
  const recall = storedOnly({ getLore: () => [{ itemId: 'lore-rabbit', text: 'rabbit stored lore evidence' }] });
  const found = await recall.prefetch({ ...boundaryArgs, lanes: BOUNDARY_LANES });
  // Prefetch's public excerpts carry source fields beyond its broad declaration.
  const excerpts = found?.excerpts as Array<{ lines: string; id: string }> | undefined;
  assert.equal(excerpts?.length, 1);
  const excerpt = excerpts?.[0];
  assert.equal(excerpt?.id, 'lore-rabbit');
  assert.ok(excerpt?.lines.includes('rabbit stored lore evidence'));
});

/** Live recent lines of the turn's own channel, one per item id, newer than anything else the store holds. */
const liveLines = (...itemIds: Array<string>) => ({
  nextId: itemIds.length + 1,
  lines: itemIds.map((itemId, i) => ({
    id: i + 1,
    at: BOUNDARY_NOW - 60000 * (i + 1),
    placeId: 'main',
    text: `rabbit recent line ${i + 1}`,
    who: [],
    weight: 2,
    itemId,
  })),
});

test('prefetch fills its excerpts with stored lore when live recent lines match the same words', async () => {
  // Six stored items fill the stored-memory limit, and the prefetch shows its five excerpts from them.
  const lore = [1, 2, 3, 4, 5, 6].map((n) => ({
    itemId: `lore-${n}`,
    text: `rabbit stored lore ${n}`,
    updatedAt: `2026-10-0${n}T00:00:00.000Z`,
  }));
  const recall = storedOnly({ getLore: () => lore, getRecent: () => liveLines('recent-1', 'recent-2') });
  const found = await recall.prefetch({ ...boundaryArgs, lanes: BOUNDARY_LANES });
  // Prefetch's public excerpts carry source fields beyond its broad declaration.
  const excerpts = (found?.excerpts ?? []) as Array<{ id: string }>;
  const ids = excerpts.map((excerpt) => excerpt.id);
  assert.deepEqual(ids.sort(), ['lore-2', 'lore-3', 'lore-4', 'lore-5', 'lore-6']);
});

test('prefetch shows an archived item whose id a live recent line shares', async () => {
  const entry = {
    itemKind: 'lore',
    itemId: 'shared-item',
    text: { title: 'rabbit', text: 'rabbit archived evidence' },
    scope: {},
    observedAt: { date: '2026-10-20' },
    recordedAt: '2026-10-20T00:00:00.000Z',
  };
  const archive = {
    *iterate() {
      yield entry;
    },
  };
  const recall = storedOnly({ getRecent: () => liveLines('shared-item') }, archive);
  const found = await recall.prefetch({ ...boundaryArgs, lanes: BOUNDARY_LANES });
  const excerpts = (found?.excerpts ?? []) as Array<{ id: string; lines: string }>;
  assert.deepEqual(
    excerpts.map((excerpt) => [excerpt.id, excerpt.lines.includes('rabbit archived evidence')]),
    [['shared-item', true]]
  );
});

test('an internal summary request without a root performs no legacy reads when the database is unavailable', async () => {
  let loreReads = 0;
  let requests = 0;
  const recall = createRecall({
    mediaNameOf: noMediaNames,
    iface: 'discord',
    hot: boundaryHot,
    now: () => BOUNDARY_NOW,
    store: {
      listUserProfiles: () => [],
      getLore: () => {
        loreReads += 1;
        return [];
      },
    },
    llm: {
      capLeft: () => 100,
      complete: () => {
        requests += 1;
        return Promise.resolve({ text: '' });
      },
    },
    memoryDb: { database: () => null },
  });
  const found = await recall.run({
    ...boundaryArgs,
    placeId: null,
    memoryContext: issueContext({ kind: 'internal', newId: () => 'ctx:summary-boundary', now: () => BOUNDARY_NOW }),
    server: { forms: ['rabbit'], who: [], from: null, to: null },
  });
  assert.equal(found.text, null);
  assert.equal(found.stretch, null);
  assert.equal(loreReads, 0);
  assert.equal(requests, 0);
});

// ---- prefetch and explicit search over the one retrieval service ----

const RETRIEVAL_SECRET = 'xylophonewhisper';
const RETRIEVAL_SETTINGS = {
  recall: { prefetch: { deadlineMs: 700, maxTokens: 900 } },
  memoryDb: { retrieval: { seeds: 3, hops: 2, nodes: 10, edges: 30, assertions: 6, evidence: 9 } },
};
const written = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };

/** A world where Alex works on Lumen in public, and a private fact and line about Lumen exist in Alex's DM. */
function known() {
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen, the build keeps failing with web.search TIMEOUT');
  const hidden = addSource(world, 'alex', `Lumen and ${RETRIEVAL_SECRET}`);
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  const fact = written(commit(world, worksOn(ALEX, lumen.entityId, [open])));
  const secret = written(
    commit(world, worksOn(MIRA, lumen.entityId, [hidden], { text: `private ${RETRIEVAL_SECRET}` }), world.contexts.alex)
  );
  return { world, open, hidden, lumen, fact, secret };
}

// ---- the query of each consumer --------------------------------------------------------------------------------------

function recaller(world: World, change: Record<string, Record<string, unknown>> = {}) {
  const none = () => Promise.resolve([]);
  const asked: Array<unknown> = [];
  const recall = createRecall(
    wrongly({
      mediaNameOf: noMediaNames,
      reads: { history: none },
      hot: {
        config: config({
          features: { recall: true },
          memoryDb: { retrieval: RETRIEVAL_SETTINGS.memoryDb.retrieval },
          ...change,
        }),
        prompts: { labels },
      },
      store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [] },
      llm: {
        capLeft: () => 100,
        complete: (messages: unknown) => {
          asked.push(messages);
          return Promise.reject(new Error('no helper model may run'));
        },
      },
      describer: null,
      now: () => START,
      archive: null,
      record: null,
      vectors: null,
      embed: null,
      memoryDb: { database: () => world.db, issueContext: () => world.contexts.group },
      iface: 'discord',
    })
  );
  const room = channelInfo('room', { rootId: 'root-1' });
  const common = { selfId: 'self', selfName: 'Persona', history: [] };
  const lanes = [{ kind: 'message', text: 'how is lumen', words: 'how is lumen' }];
  return {
    prefetch: (ctx: unknown, target = room, placeId = ROOM) =>
      recall.prefetch(wrongly({ ...common, placeId, channel: target, lanes, memoryContext: ctx })),
    search: (ctx: unknown) =>
      recall.run(
        wrongly({
          ...common,
          placeId: ROOM,
          channel: room,
          candidate: { content: 'how is lumen', authorId: 'n1' },
          server: { forms: ['lumen'], who: [], from: null, to: null },
          memoryContext: ctx,
        })
      ),
    asked,
  };
}
type Excerpt = { source?: unknown; versionId?: unknown; lines?: unknown };
const excerptsOf = async (outcome: Promise<unknown>) => wrongly<{ excerpts: Array<Excerpt> }>(await outcome).excerpts;

test('a prefetch brings a semantic fact into its excerpts under the turn context', async () => {
  // Bug: the prefetch stays on source search alone, and structured memory never reaches an ordinary turn.
  const { world, fact } = known();
  const excerpts = await excerptsOf(recaller(world).prefetch(world.contexts.group));
  assert.ok(excerpts.some((one) => one.source === 'semantic' && one.versionId === fact.versionId));
  world.handle.close();
});

test('a prefetch brings nothing private into a group turn', async () => {
  // Bug: the semantic stream reads under another context than the source stream.
  const { world } = known();
  assert.ok(
    !JSON.stringify(await excerptsOf(recaller(world).prefetch(world.contexts.group))).includes(RETRIEVAL_SECRET)
  );
  world.handle.close();
});

test('semantic excerpts share the prefetch token budget instead of adding a block', async () => {
  // Bug: a hub's facts sit on top of the 1500 tokens, and the request cap refuses the turn.
  const { world } = known();
  const source = addSource(world, 'public', 'lumen');
  const lumen = addEntity(world, 'project', 'Lumen again', [source]);
  for (let index = 0; index < 20; index += 1) {
    commit(
      world,
      worksOn(ALEX, lumen.entityId, [source], { text: `lumen fact ${index} ${'many words here '.repeat(6)}` })
    );
  }
  const prefetch = {
    deadlineMs: 1000,
    maxTokens: 60,
    contextTokens: 10,
    excerptChars: 400,
    maxExcerpts: 8,
    trivial: [],
    deictic: [],
  };
  const excerpts = await excerptsOf(
    recaller(world, { recall: { ...config().recall, prefetch } }).prefetch(world.contexts.group)
  );
  const spent = excerpts.reduce((sum, one) => sum + estimateTokens(typeof one.lines === 'string' ? one.lines : ''), 0);
  assert.ok(spent <= prefetch.maxTokens, `${spent} tokens`);
  world.handle.close();
});

test('an explicit search returns structured facts beside the quotes', async () => {
  // Bug: the tool and the prefetch take two paths and answer differently for one question.
  const { world, fact } = known();
  const result = wrongly<{ assertions: Array<{ versionId: string }> }>(
    await recaller(world).search(world.contexts.group)
  );
  assert.ok(result.assertions.some((one) => one.versionId === fact.versionId));
  assert.ok(!JSON.stringify(result).includes(RETRIEVAL_SECRET));
  world.handle.close();
});

test('a search and a prefetch never ask a model', async () => {
  // Bug: graph retrieval brings a query-planning call, which is both a cost and a helper deciding for the persona.
  const { world } = known();
  const rig = recaller(world);
  await rig.prefetch(world.contexts.group);
  await rig.search(world.contexts.group);
  assert.deepEqual(rig.asked, []);
  world.handle.close();
});

// ---- the memory session's prior evidence -----------------------------------------------------------------------------

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const PRIVACY_NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const SECRET = 'xylophonewhisper';

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const PARTNER = 'n1';
const PARTNER_ACCOUNT = 'discord:n1';
const PARTNER_PERSON = 'person:discord:n1';
const DM = 'discord:dm:n1';
const DM_CHAT = 'dm-chat-n1';
// Another partner on the same interface.
const OTHER = 'n2';
const OTHER_PERSON = 'person:discord:n2';
const OTHER_DM = 'discord:dm:n2';
const GROUP = 'discord:channel:room-1';
const SERVER = 'discord:server:g1';
// A partner with the same native id under another authority of the interface: the place's id spells nothing.
const STRANGER_ACCOUNT = 'account:other-authority';
const STRANGER_PERSON = 'person:elsewhere';
const STRANGER_DM = 'place:dm-other-authority';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function seedWorld(db: Db): void {
  addAccount(db, {
    id: PARTNER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/global',
    native: PARTNER,
    person: PARTNER_PERSON,
  });
  addAccount(db, {
    id: 'discord:n2',
    iface: 'discord',
    authority: 'discord/global',
    native: OTHER,
    person: OTHER_PERSON,
  });
  addAccount(db, {
    id: STRANGER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/other',
    native: PARTNER,
    person: STRANGER_PERSON,
  });
  addDmPlace(db, {
    id: DM,
    iface: 'discord',
    authority: 'discord/global',
    account: PARTNER_ACCOUNT,
    person: PARTNER_PERSON,
  });
  addDmPlace(db, {
    id: OTHER_DM,
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n2',
    person: OTHER_PERSON,
  });
  addDmPlace(db, {
    id: STRANGER_DM,
    iface: 'discord',
    authority: 'discord/other',
    account: STRANGER_ACCOUNT,
    person: STRANGER_PERSON,
  });
  addGroupPlace(db, GROUP, 'discord', 'discord/global');
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
  ).run(SERVER);
}

function world() {
  const dataDir = tempDir('nep-dm-privacy-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedWorld(dbOf(seed));
  seed.close();
  const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
  const memoryDb = createMemoryDb({
    hot,
    dataDir,
    log: quiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  const journal = createJournal({ dataDir, memoryDb, now: () => PRIVACY_NOW, log: quiet });
  const record = createRecord({ dataDir, memoryDb, now: () => PRIVACY_NOW, log: quiet });
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
  const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => PRIVACY_NOW, log: quiet });
  const vectors = createVectors({ dataDir, memoryDb, now: () => PRIVACY_NOW, log: quiet });
  const store = createStore({ dataDir, archive, memoryDb });
  const contexts = {
    group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
    other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
    partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
    stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
  };
  return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
}
type PrivacyWorld = ReturnType<typeof world>;

// ---- the archive ----------------------------------------------------------------------------------------------------

/**
 * One private episode in the archive, filed the way the store files an evicted private item: under the partner's DM
 * place as `{ place, private }`, or under the persona as `{ user, private }` for a member with no DM place. The engine
 * has no episode writer, so the entry is appended to the archive directly, beside a private layer written into the
 * database for the restore to write into. Answers its item id.
 */
async function evictedPrivate(w: PrivacyWorld, account = PARTNER_ACCOUNT) {
  const at = new Date(PRIVACY_NOW).toISOString();
  await writeUnitUpdate(w.memoryDb, {
    op: 'value',
    key: accountCollection('private', account),
    value: {
      relationship: '',
      interests: [],
      details: [{ id: 1, text: 'a later detail', weight: 1, firstSeen: at, lastSeen: at }],
      detailsSeq: 2,
      episodes: [],
      affinity: { score: 0, reason: '', history: [] },
      firstSeen: '',
      lastSeen: '',
      buffer: [],
    },
  });
  const home = account === PARTNER_ACCOUNT ? DM : null;
  const entry = wrongly<{ itemId: string }>(
    archiveEntry(
      { itemId: `ep-${account}`, date: '2026-10-01', what: `the ${SECRET} episode`, weight: 1 },
      {
        itemKind: 'episode',
        event: 'evicted',
        scope: home === null ? { user: account, private: true } : { place: home, private: true },
        now: () => PRIVACY_NOW,
      }
    )
  );
  await w.archive.append(home, [entry]);
  return entry.itemId;
}

function privacyRecaller(w: PrivacyWorld, { openPrivate = false }: { openPrivate?: boolean } = {}) {
  const group = channelInfo('c1', { name: 'general', viewers: { [PARTNER]: true } });
  const snapshot = snapshotOf('g1', { chats: [group], groups: [] });
  const hot = {
    config: config({
      llm: { analyzerTimeoutMs: 30000 },
      recall: { archiveMonths: 6 },
      ...(openPrivate ? { context: { memory: { openPrivate: true } } } : {}),
    }),
    prompts: { labels },
  };
  const recall = createRecall(
    wrongly({
      mediaNameOf: noMediaNames,
      hot,
      store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [] },
      llm: { capLeft: () => 100 },
      describer: null,
      now: () => PRIVACY_NOW,
      archive: w.archive,
      embed: null,
      memoryDb: w.memoryDb,
    })
  );
  const dm = channelInfo(DM_CHAT, {
    kind: 'dm',
    rootId: null,
    chatType: 'dm',
    partnerId: PARTNER,
    audience: null,
  });
  // The memory prefetch of a turn whose message names the secret: its stored-memory lane reads the archive.
  const found = async (over: Record<string, unknown>) =>
    JSON.stringify(
      await recall.prefetch(
        wrongly({
          snapshot,
          selfId: 'self',
          selfName: 'Persona',
          history: [],
          lanes: [{ kind: 'message', text: SECRET, words: SECRET }],
          ...over,
        })
      )
    );
  return { found, group, dm };
}

test("a group turn's recall reads no archived item of a DM", async () => {
  // Bug: an entry with neither `private` nor a channel passes `allowScope` unchecked.
  const w = world();
  await evictedPrivate(w);
  const r = privacyRecaller(w);
  assert.equal((await r.found({ placeId: GROUP, channel: r.group, partnerId: null })).includes(SECRET), false);
});

test("with context.memory.openPrivate on, a group turn's recall reads an archived item of a DM", async () => {
  // Bug: the switch opens the persona's memory but the archive of a direct chat stays out of a group's recall.
  const w = world();
  await evictedPrivate(w);
  const r = privacyRecaller(w, { openPrivate: true });
  assert.equal((await r.found({ placeId: GROUP, channel: r.group, partnerId: null })).includes(SECRET), true);
});

test("the partner's own recall reads an item archived under their own id", async () => {
  // Bug: a fix that drops the member rule of `allowScope` loses the item a member with no DM place left behind.
  const w = world();
  const entry = archiveEntry(
    {
      itemId: 'ep-own',
      date: '2026-11-01',
      what: `the ${SECRET} episode`,
      weight: 3,
      addedAt: '2026-11-01T00:00:00.000Z',
    },
    { itemKind: 'episode', event: 'evicted', scope: { user: PARTNER, private: true }, now: () => PRIVACY_NOW }
  );
  await w.archive.append(DM, [entry]);
  const r = privacyRecaller(w);
  assert.equal((await r.found({ placeId: DM, channel: r.dm, partnerId: PARTNER })).includes(SECRET), true);
});

test("the partner's own recall reads an item archived from their DM", async () => {
  // Bug: `allowScope` asks `scope.user === privateAccountId`, and a DM's archived item names `{ place, private }` with no user.
  const w = world();
  await evictedPrivate(w);
  const r = privacyRecaller(w);
  assert.equal((await r.found({ placeId: DM, channel: r.dm, partnerId: PARTNER })).includes(SECRET), true);
});

async function withLine(kind: Kind, presence: Presence, body: (env: Env, source: string) => void | Promise<void>) {
  const env = mediaFixture();
  try {
    const source = observeLine(env, kind, presence);
    fillStems(env.db);
    await body(env, source);
  } finally {
    env.done();
  }
}

function assertForms(text: string, kind: Kind, presence: Presence) {
  checkForms(text, kind, presence);
}

/** A window read that holds the line: a window starts after its anchor. */
async function windowLines(env: Env): Promise<string> {
  env.say({ native: 'before', at: AT - 60_000, text: 'first', place: GENERAL });
  const rig = recallRig(env);
  const found = await rig.recall.window({ ...rig.args, anchor: 'before', move: 'down', messages: 1 });
  return (found.quotes ?? []).map((quote) => quote.lines).join('\n');
}

for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    test(`window read: a ${kind.name} shows its marker and its text form, ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        const lines = await windowLines(env);
        assertForms(lines, kind, presence);
      }));
  }

  // A prefetch hit needs two terms of the lane (src/behavior/prefetch.ts#lexicalKeep): the word and the retelling's own.
  for (const presence of ['full', 'part'] as const) {
    test(`prefetch: a ${kind.name} found by words of its text form shows its marker and its text form, ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        const rig = recallRig(env);
        const words = `retelling ${kind.first.word}`;
        const found = await rig.recall.prefetch({ ...rig.args, lanes: [{ kind: 'message', text: words, words }] });
        const shown = JSON.stringify(found?.excerpts ?? []);
        assertForms(shown, kind, presence);
      }));
  }
}

const DAY = 86400000;
const EXCLUSION_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const BOB = 'u-bob';

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('tracked settings require an object');
  // The guard establishes an object whose settings are read by string keys.
  return value as Record<string, unknown>;
}

function runner(env: ReturnType<typeof fixture>) {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        {
          id: channelPlaceId('discord', 'c1'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c1',
          scope_kind: 'group',
          name: 'general',
        },
        {
          id: channelPlaceId('discord', 'c4'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c4',
          scope_kind: 'group',
          name: 'secret',
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: personId('discord', BOB),
        },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const parsed: unknown = JSON.parse(fs.readFileSync(new URL('../../../config/config.json', import.meta.url), 'utf8'));
  const config = objectOf(parsed);
  config.bot = { ...objectOf(config.bot ?? {}), timezone: 'UTC' };
  config.features = { ...objectOf(config.features ?? {}), meaningSearch: false, recall: true };
  const models = objectOf(config.models ?? {});
  // Changed: a role's model is its chain's (spec 2026-11-09-model-routes, slice 4).
  config.models = {
    ...models,
    routes: { ...objectOf(models.routes ?? {}), ...chainsOf({ embedding: 'test/embedder' }) },
  };
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const { tools } = labels.tools;
  const hot = {
    config,
    prompts: {
      labels: {
        ...labels,
        tools: {
          ...labels.tools,
          tools: { ...tools, memory: { ...tools.memory, hidden: 'ΚΡΥΦΟ-ΣΗΜΑ' } },
        },
      },
    },
  };
  const recaller = createRecall({
    mediaNameOf: noMediaNames,
    iface: 'discord',
    hot,
    // The DM partner `owner-42` has a stored person, which the store answers; no person is spelled from a member id.
    store: {
      state: { data: {}, markDirty() {} },
      listUserProfiles: () => [],
      personOfAccount: (account: string) => (account === 'owner-42' ? personId('discord', 'owner-42') : null),
    },
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('quoted SQLite reads need no model')) },
    now: () => EXCLUSION_NOW,
    embed: null,
    memoryDb: { database: () => env.db },
  });
  return {
    recaller,
    hot,
    args: {
      placeId: 'g1',
      snapshot,
      channel,
      partnerId: null,
      selfId: 'self',
      selfName: 'Ζωή',
      history: [],
      candidate: { id: 'q', content: 'το σπιτι' },
    },
  };
}

function exclusionSource(
  env: ReturnType<typeof fixture>,
  {
    iface = 'fake',
    room,
    id = 'shared-visible',
    marker,
    dm = false,
    offset = 60_000,
    authority = `${iface}/${room}`,
  }: { iface?: string; room: string; id?: string; marker: string; dm?: boolean; offset?: number; authority?: string }
) {
  const event = lineEvent({
    id,
    chatId: room,
    authorId: 'owner-42',
    text: `το κουνέλι ${marker}`,
    at: EXCLUSION_NOW - DAY - offset,
  });
  event.iface = iface;
  event.chat = dm
    ? { id: room, kind: 'dm', rootId: null, partnerId: 'owner-42' }
    : { id: room, kind: 'channel', rootId: 'g1', name: room };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid exclusion fixture was refused');
  envelope.authority = authority;
  envelope.place.authority = authority;
  const result = observe(env.handle, envelope, { now: () => EXCLUSION_NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string' || typeof result.placeId !== 'string')
    throw new Error('exclusion source identity missing');
  return {
    sourceId: result.sourceId,
    placeId: result.placeId,
    iface,
    native: { iface, chatId: room, messageId: id },
  };
}

for (const reader of ['run', 'window', 'prefetch'] as const) {
  test(`scoped history exclusions in ${reader} retain foreign and other-chat native-ID collisions`, async () => {
    const env = fixture();
    try {
      const own = exclusionSource(env, { room: 'current-room', marker: 'own-visible-731' });
      const foreign = exclusionSource(env, { iface: 'other', room: 'foreign-room', marker: 'foreign-visible-842' });
      const nearby = exclusionSource(env, { room: 'different-room', marker: 'different-visible-953' });
      env.stem();
      const s = runner(env);
      const args = {
        ...s.args,
        channel: channelInfo('current-room'),
        historyRef: { iface: 'fake', chatId: 'current-room' },
        history: [{ id: 'shared-visible', placeId: 'current-room', content: 'το κουνέλι own-visible-731' }],
        memoryContext: issueContext({
          kind: 'group',
          iface: 'fake',
          newId: () => `ctx:exclude-${reader}`,
          now: () => EXCLUSION_NOW,
        }),
      };
      if (reader === 'window') {
        for (const [source, marker] of [
          [own, null],
          [foreign, 'foreign-visible-842'],
          [nearby, 'different-visible-953'],
        ] as const) {
          const anchor = exclusionSource(env, {
            iface: source.iface,
            room: source.native.chatId,
            id: 'window-anchor',
            marker: 'anchor',
            offset: 0,
          });
          const found = await s.recaller.window({
            ...args,
            resolvedAnchor: { kind: 'source', sourceId: anchor.sourceId },
            move: 'up',
            messages: 1,
          });
          assert.equal(JSON.stringify(found).includes('own-visible-731'), false);
          if (marker) assert.ok(JSON.stringify(found).includes(marker));
        }
      } else {
        const found =
          reader === 'run'
            ? await s.recaller.run({
                ...args,
                server: { forms: ['κουνέλι'], who: [], from: null, to: null },
              })
            : await s.recaller.prefetch({
                ...args,
                lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
              });
        assert.equal(JSON.stringify(found).includes('own-visible-731'), false);
        assert.ok(JSON.stringify(found).includes('foreign-visible-842'));
        assert.ok(JSON.stringify(found).includes('different-visible-953'));
      }
    } finally {
      env.done();
    }
  });
}

test('trusted ordinary DM history excludes its own visible line without widening its audience', async () => {
  const env = fixture();
  try {
    const own = exclusionSource(env, {
      iface: 'discord',
      authority: 'discord/global',
      room: 'own-dm',
      marker: 'own-dm-visible-731',
      dm: true,
    });
    exclusionSource(env, { iface: 'other', room: 'public-room', marker: 'public-collision-842' });
    exclusionSource(env, { iface: 'other', room: 'hidden-dm', marker: 'hidden-dm-953', dm: true });
    env.stem();
    const s = runner(env);
    const args = {
      ...s.args,
      channel: channelInfo('own-dm', { kind: 'dm', rootId: null, partnerId: 'owner-42', audience: null }),
      partnerId: 'owner-42',
      historyRef: { iface: 'discord', chatId: 'own-dm' },
      history: [{ id: 'shared-visible', placeId: 'own-dm', content: 'το κουνέλι own-dm-visible-731' }],
      memoryContext: issueContext({
        kind: 'dm',
        iface: 'discord',
        person: personId('discord', 'owner-42'),
        place: own.placeId,
        newId: () => 'ctx:exclude-dm',
        now: () => EXCLUSION_NOW,
      }),
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
    };
    const before = await s.recaller.run({ ...args, history: [] });
    assert.ok(JSON.stringify(before).includes('own-dm-visible-731'));
    const found = await s.recaller.run(args);
    assert.equal(JSON.stringify(found).includes('own-dm-visible-731'), false);
    assert.ok(JSON.stringify(found).includes('public-collision-842'));
    assert.equal(JSON.stringify(found).includes('hidden-dm-953'), false);
  } finally {
    env.done();
  }
});

for (const reader of ['prefetch'] as const) {
  test(`an internal CLI ${reader} excludes trusted current history while retaining a foreign private collision`, async () => {
    const env = fixture();
    try {
      exclusionSource(env, { iface: 'cli', room: 'cli:dm:owner', marker: 'own-cli-visible-731', dm: true });
      exclusionSource(env, { iface: 'other', room: 'foreign-dm', marker: 'foreign-private-842', dm: true });
      env.stem();
      const s = runner(env);
      const args = {
        ...s.args,
        placeId: null,
        snapshot: null,
        channel: channelInfo('cli:dm:owner', { kind: 'dm', rootId: null, partnerId: 'owner-42', audience: null }),
        historyRef: { iface: 'cli', chatId: 'cli:dm:owner' },
        history: [{ id: 'shared-visible', placeId: 'cli:dm:owner', content: 'το κουνέλι own-cli-visible-731' }],
        memoryContext: issueContext({
          kind: 'internal',
          newId: () => `ctx:exclude-cli-${reader}`,
          now: () => EXCLUSION_NOW,
        }),
      };
      const found =
        reader === 'prefetch'
          ? await s.recaller.prefetch({
              ...args,
              lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
            })
          : await runMemorySearch({
              ...args,
              recall: s.recaller,
              config: s.hot.config,
              labels,
              args: { terms: 'κουνέλι' },
              now: EXCLUSION_NOW,
            });
      assert.equal(JSON.stringify(found).includes('own-cli-visible-731'), false);
      assert.ok(JSON.stringify(found).includes('foreign-private-842'));
    } finally {
      env.done();
    }
  });
}

test('malformed stored history identity does not fall back to excluding its native ID', async () => {
  const env = fixture();
  try {
    const own = exclusionSource(env, { room: 'current-room', marker: 'retained-own-731' });
    env.stem();
    const s = runner(env);
    const found = await s.recaller.run({
      ...s.args,
      channel: channelInfo('current-room'),
      historyRef: { iface: 'fake', chatId: 'current-room' },
      history: [
        {
          id: 'shared-visible',
          placeId: 'current-room',
          content: 'το κουνέλι retained-own-731',
          stored: { sourceId: '', placeId: own.placeId, iface: 'fake' },
        },
      ],
      memoryContext: issueContext({
        kind: 'group',
        iface: 'fake',
        newId: () => 'ctx:malformed-history',
        now: () => EXCLUSION_NOW,
      }),
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
    });
    assert.ok(JSON.stringify(found).includes('retained-own-731'));
  } finally {
    env.done();
  }
});

test('ordinary history without an explicit reference uses its validated interface and actual chat', async () => {
  const env = fixture();
  try {
    exclusionSource(env, { room: 'current-room', marker: 'ordinary-own-731' });
    exclusionSource(env, { iface: 'other', room: 'current-room', marker: 'ordinary-foreign-842' });
    env.stem();
    const s = runner(env);
    const found = await s.recaller.run({
      ...s.args,
      channel: channelInfo('current-room'),
      history: [{ id: 'shared-visible', placeId: 'current-room', content: 'το κουνέλι ordinary-own-731' }],
      memoryContext: issueContext({
        kind: 'group',
        iface: 'fake',
        newId: () => 'ctx:ordinary-history',
        now: () => EXCLUSION_NOW,
      }),
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
    });
    assert.equal(JSON.stringify(found).includes('ordinary-own-731'), false);
    assert.ok(JSON.stringify(found).includes('ordinary-foreign-842'));
  } finally {
    env.done();
  }
});

const OFF_MAIN_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const OFF_MAIN_MINUTE = 60_000;
const MAIN = channelPlaceId('discord', 'main');
const OFF_MAIN_OTHER = channelPlaceId('discord', 'other');
const ALICE = 'u-alice';
const ALICE_PERSON = personId('discord', ALICE);
const BOB_PERSON = personId('discord', BOB);
const VECTOR = [1, 0, 0, 0];
const REAL_READER = pathToFileURL(path.resolve('src/memory/db/reader-worker.ts')).href;
const SLOW_MS = 1000;
const STALE_MS = 60_000;

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-off-main-'));

/** A file database with group lines in two channels, one DM line each for two people, an account and vectors. */
function writeFixtureDb(file: string): void {
  const env = fixture();
  try {
    insertRows(env.db, {
      places: [
        { id: MAIN, iface: 'discord', kind: 'channel', native_id: 'main', scope_kind: 'group', name: 'main' },
        {
          id: OFF_MAIN_OTHER,
          iface: 'discord',
          kind: 'channel',
          native_id: 'other',
          scope_kind: 'group',
          name: 'other',
        },
        {
          id: dmPlaceId('discord', ALICE),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: ALICE_PERSON,
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: BOB_PERSON,
        },
      ],
    });
    env.account(ALICE, ['Alice']);
    env.account(BOB, ['Bob']);
    env.say({ native: 'main-1', at: OFF_MAIN_NOW - 5 * OFF_MAIN_MINUTE, text: 'the rabbit left the garden' });
    env.say({
      native: 'main-2',
      at: OFF_MAIN_NOW - 4 * OFF_MAIN_MINUTE,
      text: 'a rabbit came back at dusk',
      author: BOB,
    });
    env.say({ native: 'main-3', at: OFF_MAIN_NOW - 3 * OFF_MAIN_MINUTE, text: 'nothing about animals in this line' });
    env.say({
      native: 'other-1',
      at: OFF_MAIN_NOW - 2 * OFF_MAIN_MINUTE,
      text: 'the rabbit in the other channel',
      place: OFF_MAIN_OTHER,
    });
    env.say({
      native: 'dm-alice',
      at: OFF_MAIN_NOW - OFF_MAIN_MINUTE,
      text: 'the secret rabbit of alice',
      place: dmPlaceId('discord', ALICE),
      scope: dmScope(ALICE_PERSON, 'discord'),
    });
    env.say({
      native: 'dm-bob',
      at: OFF_MAIN_NOW - OFF_MAIN_MINUTE,
      text: 'the secret rabbit of bob',
      author: BOB,
      place: dmPlaceId('discord', BOB),
      scope: dmScope(BOB_PERSON, 'discord'),
    });
    env.vector('main-3', VECTOR);
    env.vector('main-1', [0.9, 0.1, 0, 0]);
    env.vector('dm-alice', VECTOR, { scope: dmScope(ALICE_PERSON, 'discord') });
    env.stem();
    fillEnvAudiences(env);
    env.db.prepare('VACUUM INTO ?').run(file);
  } finally {
    env.done();
  }
}

/** A stand-in reader that reads `<root>/mode` at each message but `open` and `close`, then lets the real reader answer. */
function standInReader(root: string): URL {
  const file = pathToFileURL(path.join(root, 'stand-in-reader.mjs'));
  fs.writeFileSync(
    file,
    `
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
const root = ${JSON.stringify(root)};
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const once = (name) => {
  if (fs.existsSync(root + '/' + name)) return false;
  fs.writeFileSync(root + '/' + name, '1');
  return true;
};
parentPort.on('message', (message) => {
  if (message.type === 'open' || message.type === 'close') return;
  let mode = '';
  try { mode = fs.readFileSync(root + '/mode', 'utf8'); } catch { /* none */ }
  if (mode === 'slow') block(${SLOW_MS});
  if (mode === 'hang') block(${STALE_MS});
  if (mode === 'hang-once' && once('hung')) block(${STALE_MS});
  if (mode === 'crash-once' && once('crashed')) process.exit(3);
});
await import(${JSON.stringify(REAL_READER)});
`
  );
  return file;
}

// Two words, so the lane searches them as a phrase: without a vector a prefetch keeps a line only for a phrase or two terms.
const LANES = [{ kind: 'message', text: 'the rabbit', words: 'the rabbit' }];
const RUN_ARGS = {
  placeId: 'g1',
  channel: channelInfo('main'),
  partnerId: null,
  selfId: 'self',
  selfName: 'Persona',
  history: [],
  candidate: { content: 'rabbit' },
};

/** The fixture database, a service over it and a config both read. `standIn` puts the blocking worker before the reader. */
async function setup({
  standIn = false,
  memoryDb = {},
  recall = {},
  options = {},
}: {
  standIn?: boolean;
  memoryDb?: Record<string, unknown>;
  recall?: Record<string, unknown>;
  options?: Record<string, unknown>;
} = {}) {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const file = path.join(data, 'memory.db');
  writeFixtureDb(file);
  const hot = {
    config: config({
      features: { recall: true, meaningSearch: false },
      // A short close bound: a stand-in may still hold the reader when the test closes the service.
      memoryDb: { session: { mode: 'off' }, closeTimeoutMs: 500, ...memoryDb },
      recall: {
        prefetch: {
          deadlineMs: 100,
          maxTokens: 1500,
          contextTokens: 500,
          minFormsMatched: 1,
          singleTermScore: 0,
          maxTermShare: 1,
          trivial: [],
        },
        ...recall,
      },
    }),
    prompts: { labels },
  };
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    now: () => OFF_MAIN_NOW,
    ...(standIn ? { readerFile: standInReader(root) } : {}),
    ...options,
  });
  await service.open();
  return {
    root,
    file,
    hot,
    service,
    mode: (value: string) => fs.writeFileSync(path.join(root, 'mode'), value),
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// The runner answers more than its types name (the status and stats the tests read), and these fakes carry only what a
// search calls, so it is read through the shape the tests use.
type RecallInput = Parameters<typeof createRecall>[0];
const recallOver = (hot: object, memoryDb: object) =>
  createRecall({
    iface: 'discord',
    mediaNameOf: noMediaNames,
    reads: rig().reads,
    hot,
    store: {},
    now: () => OFF_MAIN_NOW,
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('unexpected model call')) },
    memoryDb,
  } as RecallInput) as unknown as {
    run(args: Record<string, unknown>): Promise<{ outcome: { kind: string }; quotes: Array<{ lines: string }> }>;
    prefetch(args: Record<string, unknown>): Promise<{
      status: string;
      partial?: boolean;
      excerpts: Array<{ lines: string }>;
      stats?: { failed: number };
    } | null>;
  };

test('a prefetch over a stuck reader answers timeout on its deadline while the loop runs', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('hang');
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    const started = performance.now();
    try {
      const out = await recallOver(env.hot, env.service).prefetch({ ...RUN_ARGS, lanes: LANES });
      assert.equal(out?.status, 'timeout');
      assert.equal(out?.partial, true);
    } finally {
      clearInterval(ticker);
    }
    // deadlineMs is 100; the stand-in holds the reader for 60 s.
    assert.ok(performance.now() - started < 5000);
    assert.ok(ticks >= 3, `ticks during the prefetch: ${ticks}`);
  } finally {
    await env.done();
  }
});

test('the prefetch after a timed out one finds its excerpts', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('hang-once');
    const recall = recallOver(env.hot, env.service);
    assert.equal((await recall.prefetch({ ...RUN_ARGS, lanes: LANES }))?.status, 'timeout');
    // The second one gets a long deadline: the reader may have to start again.
    const config = env.hot.config;
    (config.recall as { prefetch: { deadlineMs: number } }).prefetch.deadlineMs = 20_000;
    const again = await recall.prefetch({ ...RUN_ARGS, lanes: LANES });
    assert.equal(again?.status, 'ok');
    assert.ok(again?.excerpts.some((excerpt) => excerpt.lines.includes('rabbit')));
  } finally {
    await env.done();
  }
});

test('the prefetch aborts the signal of a search still out at its deadline', async () => {
  const env = await setup();
  try {
    const signals: Array<AbortSignal> = [];
    const recall = recallOver(env.hot, {
      database: () => env.service.database(),
      searchRecord: (_args: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise(() => {});
      },
    });
    const out = await recall.prefetch({ ...RUN_ARGS, lanes: LANES });
    assert.equal(out?.status, 'timeout');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, true);
  } finally {
    await env.done();
  }
});

test('the persona search over a stuck reader answers timeout at recall.timeoutMs', async () => {
  const env = await setup({ recall: { timeoutMs: 100 } });
  // The recall timers are unref'd in production; this keeps the test process alive until they fire.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const signals: Array<AbortSignal> = [];
    const recall = recallOver(env.hot, {
      database: () => env.service.database(),
      searchRecord: (_args: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise(() => {});
      },
    });
    const found = await recall.run({
      ...RUN_ARGS,
      server: { forms: ['rabbit'], who: [], from: null, to: null },
    });
    assert.equal(found.outcome.kind, 'timeout');
    assert.equal(signals[0].aborted, true);
  } finally {
    clearInterval(keepAlive);
    await env.done();
  }
});

test('a prefetch goes on when its search fails, and the log names the code', async () => {
  const env = await setup();
  try {
    const recall = recallOver(env.hot, {
      database: () => env.service.database(),
      searchRecord: () => Promise.reject(Object.assign(new Error('memory db worker stopped'), { code: 'WORKER_EXIT' })),
    });
    const { result, logs } = await withCapturedLogs(() => recall.prefetch({ ...RUN_ARGS, lanes: LANES }));
    assert.deepEqual(result?.excerpts, []);
    assert.ok((result?.stats?.failed ?? 0) >= 1);
    const failed = logs.find((entry) => entry.msg === 'recall: prefetch failed' && entry.stage === 'db');
    assert.equal(failed?.code, 'WORKER_EXIT');
  } finally {
    await env.done();
  }
});

test('the persona search answers an error outcome when its search fails, and the log names the code', async () => {
  const env = await setup();
  try {
    const recall = recallOver(env.hot, {
      database: () => env.service.database(),
      searchRecord: () => Promise.reject(Object.assign(new Error('memory db worker stopped'), { code: 'WORKER_EXIT' })),
    });
    const { result, logs } = await withCapturedLogs(() =>
      recall.run({ ...RUN_ARGS, server: { forms: ['rabbit'], who: [], from: null, to: null } })
    );
    assert.equal(result.outcome.kind, 'error');
    const failed = logs.find((entry) => entry.msg === 'recall: failed');
    assert.equal(failed?.code, 'WORKER_EXIT');
  } finally {
    await env.done();
  }
});

const asRecall = (input: object) =>
  createRecall({ iface: 'discord', mediaNameOf: noMediaNames, ...input } as RecallInput) as unknown as {
    run(args: Record<string, unknown>): Promise<Found>;
    window(args: Record<string, unknown>): Promise<Found>;
    prefetch(args: Record<string, unknown>): Promise<{ status?: string } | null>;
  };

type Found = {
  outcome: { kind: string; degraded?: boolean };
  quotes: Array<{
    channelName: string;
    lines: string;
    entries: Array<{
      id: string;
      message: { authorName: string; attachments: Array<{ id: string; kind: string; name: string }> };
    }>;
  }>;
  hidden: boolean;
};
const DB_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const CAROL = 'u-carol';
const group = groupContext('discord');

const plan = (forms: Array<string>, extra: Record<string, unknown> = {}) => ({
  forms,
  who: [],
  from: null,
  to: null,
  ...extra,
});
const ids = (result: { hits: Array<{ messageId: unknown }> }) => result.hits.map((hit) => hit.messageId);
const run = (
  env: ReturnType<typeof fixture>,
  forms: Array<string>,
  { plan: given = {}, ...rest }: { plan?: Record<string, unknown>; [key: string]: unknown } = {},
  ctx = group
) => search(env.db, { ctx, plan: plan(forms, given), now: DB_NOW, ...rest });

// ---------- the runner and the tool over the database ----------

const DB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// PR 7c: the shipped settings live in config/config.json.
const SHIPPED = JSON.parse(fs.readFileSync(path.join(DB_ROOT, 'config', 'config.json'), 'utf8'));
const { tools } = labels.tools;
const withHidden = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: { ...tools, memory: { ...tools.memory, hidden: 'ΚΡΥΦΟ-ΣΗΜΑ' } },
  },
};

/**
 * A runner over a fake guild (#general c1, #secret c4 that @everyone cannot see) and the fixture database, whose
 * places rows hold both channels and Bob's DM (`places: false`: none; the runner's place rule reads them).
 */
function dbRunner(
  env: ReturnType<typeof fixture>,
  {
    open = true,
    meaning = false,
    embed = null,
    places = true,
  }: {
    open?: boolean;
    meaning?: boolean;
    embed?: ((texts: Array<string>, options: { purpose: string }) => Promise<Array<Float32Array>>) | null;
    places?: boolean;
  } = {}
) {
  // PR 7d: every context reads through `audience_id`, so the rows the fixture wrote carry it.
  fillEnvAudiences(env);
  if (places) {
    insertRows(
      env.db,
      {
        places: [
          {
            id: channelPlaceId('discord', 'c1'),
            iface: 'discord',
            kind: 'channel',
            native_id: 'c1',
            scope_kind: 'group',
            name: 'general',
          },
          {
            id: channelPlaceId('discord', 'c4'),
            iface: 'discord',
            kind: 'channel',
            native_id: 'c4',
            scope_kind: 'group',
            name: 'secret',
          },
          {
            id: dmPlaceId('discord', BOB),
            iface: 'discord',
            kind: 'dm',
            native_id: null,
            scope_kind: 'dm',
            partner_person: dbPersonId('discord', BOB),
          },
        ],
      },
      { log: { info() {}, debug() {}, warn() {}, error() {} } }
    );
  }
  // #general (c1) and #secret (c4), which the root's everyone cannot view; Bob's private chat is the partner's.
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const dm = channelInfo('dm-bob', { kind: 'dm', rootId: null, chatType: 'dm', partnerId: BOB, audience: null });
  const config = structuredClone(SHIPPED);
  config.bot = { ...config.bot, timezone: 'UTC' };
  config.features = { ...config.features, meaningSearch: meaning, recall: true };
  config.models = { ...config.models, routes: { embedding: [{ via: 'api', key: 'main', model: 'test/embedder' }] } };
  const data = {};
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {},
    },
    listUserProfiles: () => [],
    personOfAccount: storedPersonOf,
    dmHomeOf: storedDmOf,
  };
  const llmCalls: Array<Array<unknown>> = [];
  const llm = {
    capLeft: () => 100,
    complete: async (...call: Array<unknown>) => {
      llmCalls.push(call);
      return { text: '' };
    },
  };
  const hot = { config, prompts: { labels: withHidden } };
  const recaller = asRecall({
    hot,
    store,
    llm,
    now: () => DB_NOW,
    embed,
    memoryDb: { database: () => (open ? env.db : null) },
  });
  return {
    recaller,
    channel,
    dm,
    hot,
    llmCalls,
    args: {
      placeId: 'g1',
      snapshot,
      channel,
      partnerId: null,
      selfId: 'self',
      selfName: 'Ζωή',
      history: [],
      candidate: { id: 'q', content: 'το σπιτι' },
    },
  };
}

test('recall.run: stored group stretches follow memory scope without a live interface request or summary', async () => {
  const env = fixture();
  try {
    env.account(ALICE, ['Αλίκη']);
    const ownSourceId = env.say({
      native: 'r1',
      at: DB_NOW - 3 * DAY,
      text: 'το σπιτι του δασκαλου',
      place: channelPlaceId('discord', 'c1'),
    });
    env.say({
      native: 'r2',
      at: DB_NOW - 3 * DAY + 60000,
      text: 'ναι ηταν μεγαλο',
      place: channelPlaceId('discord', 'c1'),
    });
    env.say({ native: 'r3', at: DB_NOW - 2 * DAY, text: 'κρυφο σπιτι', place: channelPlaceId('discord', 'c4') });
    env.say({
      native: 'r4',
      at: DB_NOW - DAY,
      text: 'ιδιωτικο σπιτι',
      place: dmPlaceId('discord', BOB),
      scope: dmScope(dbPersonId('discord', BOB), 'discord'),
    });
    env.stem();
    const s = dbRunner(env);
    const found = await s.recaller.run({
      ...s.args,
      candidate: { ...s.args.candidate, authorId: BOB },
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
    });
    assert.equal(found.outcome.kind, 'searched');
    assert.deepEqual(
      found.quotes.map((quote) => quote.channelName),
      ['secret', 'general']
    );
    // Policy 2 shares stored group evidence independently of the live pull permission.
    const secondQuote = found.quotes[1];
    assert.deepEqual(
      secondQuote.entries.map((entry) => entry.id),
      ['r1', 'r2']
    );
    const foundSecondQuote = found.quotes[1];
    assert.ok(foundSecondQuote.lines.includes('Αλίκη'));
    assert.ok(JSON.stringify(found).includes('κρυφο'));
    assert.equal(JSON.stringify(found).includes('ιδιωτικο'), false);
    assert.equal(s.llmCalls.length, 0, 'no summary');
    // Policy 2 exposes the stronger secret-group match, so the asker's weaker DM match needs no hint.
    assert.equal(found.hidden, false);
    const stranger = await s.recaller.run({
      ...s.args,
      candidate: { ...s.args.candidate, authorId: ALICE },
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
    });
    assert.equal(stranger.hidden, false, "the DM is another person's");
    // Policy 2 also permits a named stored group independently of live pull permission.
    const named = await s.recaller.run({
      ...s.args,
      server: { forms: ['σπιτι'], who: [], from: null, to: null, placeId: 'c4' },
    });
    assert.equal(named.outcome.kind, 'searched');
    assert.deepEqual(
      named.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
      ['r3']
    );
    // Generic stored rows require exact source identity for history exclusion, without an invented native route.
    const seen = await s.recaller.run({
      ...s.args,
      history: [
        {
          id: 'r1',
          placeId: 'c1',
          ts: DB_NOW,
          self: false,
          bot: false,
          authorName: 'x',
          content: 'y',
          stored: { sourceId: ownSourceId, placeId: channelPlaceId('discord', 'c1'), iface: 'discord' },
        },
      ],
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
    });
    assert.ok(!seen.quotes.some((quote) => quote.entries.some((entry) => entry.id === 'r1')));
  } finally {
    env.done();
  }
});

test('recall.run: with no open database the stretches are not configured, and nothing asks Discord', async () => {
  const env = fixture();
  try {
    env.say({ native: 'r1', at: DB_NOW - DAY, text: 'το σπιτι', place: channelPlaceId('discord', 'c1') });
    env.stem();
    const s = dbRunner(env, { open: false });
    const found = await s.recaller.run({
      ...s.args,
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
    });
    assert.equal(found.outcome.kind, 'not-configured');
    assert.equal(found.quotes?.length ?? 0, 0);
    const open = dbRunner(env, { places: false });
    const again = await open.recaller.run({
      ...open.args,
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
    });
    assert.equal(again.quotes.length, 1, 'the open database answers');
  } finally {
    env.done();
  }
});

test('recall.run: the question is embedded once for the meaning search, and a failed embedding leaves words only', async () => {
  const env = fixture();
  try {
    env.say({ native: 'r1', at: DB_NOW - DAY, text: 'ασχετο κειμενο', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'r2', at: DB_NOW - 2 * DAY, text: 'ακομα ενα', place: channelPlaceId('discord', 'c1') });
    env.stem();
    env.vector('r1', [1, 0, 0, 0]);
    const calls: Array<unknown> = [];
    const good = dbRunner(env, {
      meaning: true,
      embed: async (texts: Array<string>, options: { purpose: string }) => {
        calls.push([texts, options.purpose]);
        return [Float32Array.from([1, 0, 0, 0])];
      },
    });
    const found = await good.recaller.run({
      ...good.args,
      server: { forms: ['τιποτα'], who: [], from: null, to: null },
    });
    assert.deepEqual(calls, [[['το σπιτι'], 'recall-query']]);
    assert.deepEqual(
      found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)).sort(),
      ['r1', 'r2'],
      'the meaning hit r1 and its neighbour'
    );
    assert.equal(found.outcome.degraded, false);
    const bad = dbRunner(env, {
      meaning: true,
      embed: async () => {
        throw new Error('down');
      },
    });
    const words = await bad.recaller.run({
      ...bad.args,
      server: { forms: ['ασχετο'], who: [], from: null, to: null },
    });
    assert.equal(words.outcome.degraded, true);
    assert.equal(words.quotes.length, 1);
  } finally {
    env.done();
  }
});

test('recall.window: reads stored group lines through memory scope and refuses an unknown anchor', async () => {
  const env = fixture();
  try {
    for (let i = 1; i <= 5; i += 1)
      env.say({
        native: `x${i}`,
        at: DB_NOW - (6 - i) * 60000,
        text: `γραμμη ${i}`,
        place: channelPlaceId('discord', 'c1'),
      });
    env.say({ native: 'y0', at: DB_NOW - 120000, text: 'πριν αλλου', place: channelPlaceId('discord', 'c4') });
    env.say({ native: 'y1', at: DB_NOW - 60000, text: 'αλλου', place: channelPlaceId('discord', 'c4') });
    env.stem();
    const s = dbRunner(env);
    const down = await s.recaller.window({ ...s.args, anchor: 'x2', move: 'down', messages: 2 });
    const firstQuote = down.quotes[0];
    assert.deepEqual(
      firstQuote.entries.map((entry) => entry.id),
      ['x3', 'x4']
    );
    const downFirstQuote = down.quotes[0];
    assert.equal(downFirstQuote.channelName, 'general');
    // Policy 2 permits stored group windows even when live pull permission excludes the channel.
    const stored = await s.recaller.window({ ...s.args, anchor: 'y1', move: 'up', messages: 2 });
    assert.equal(stored.outcome.kind, 'searched');
    assert.deepEqual(
      stored.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
      ['y0']
    );
    assert.equal((await s.recaller.window({ ...s.args, anchor: 'zzz', move: 'up' })).outcome.kind, 'unknown-anchor');
    const off = dbRunner(env, { open: false, places: false });
    assert.equal((await off.recaller.window({ ...off.args, anchor: 'x2' })).outcome.kind, 'not-configured');
  } finally {
    env.done();
  }
});

test('recall.window: the place rule reads the place row; a DM place with one opens for its partner, a place with none is refused', async () => {
  const env = fixture(BOB);
  try {
    env.say({
      native: 'p1',
      at: DB_NOW - 120000,
      text: 'γραμμη ενα',
      place: dmPlaceId('discord', BOB),
      scope: dmScope(dbPersonId('discord', BOB), 'discord'),
    });
    env.say({
      native: 'p2',
      at: DB_NOW - 60000,
      text: 'γραμμη δυο',
      place: dmPlaceId('discord', BOB),
      scope: dmScope(dbPersonId('discord', BOB), 'discord'),
    });
    // A line Bob may read, in a DM place the database holds no row for.
    env.say({
      native: 'u1',
      at: DB_NOW - 30000,
      text: 'αγνωστη θεση',
      place: dmPlaceId('discord', CAROL),
      scope: dmScope(dbPersonId('discord', BOB), 'discord'),
    });
    env.say({ native: 'c1', at: DB_NOW - 60000, text: 'γραμμη στο καναλι', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'c2', at: DB_NOW - 30000, text: 'και αλλη', place: channelPlaceId('discord', 'c1') });
    env.stem();
    const s = dbRunner(env);
    const dm = { ...s.args, channel: s.dm, partnerId: BOB };
    const read = await s.recaller.window({ ...dm, anchor: 'p2', move: 'up', messages: 2 });
    const firstQuote = read.quotes[0];
    assert.deepEqual(
      firstQuote.entries.map((entry) => entry.id),
      ['p1']
    );
    assert.equal(
      (await s.recaller.window({ ...dm, anchor: 'u1', move: 'up', messages: 2 })).outcome.kind,
      'unknown-anchor',
      'no row: refused'
    );
    const [pulled] = (await s.recaller.window({ ...s.args, anchor: 'c2', move: 'up', messages: 2 })).quotes;
    assert.deepEqual(
      pulled.entries.map((entry) => entry.id),
      ['c1']
    );
    // Without the rows, the channel the pull rail lets through is refused all the same.
    const bare = fixture();
    try {
      bare.say({ native: 'c1', at: DB_NOW - 60000, text: 'γραμμη στο καναλι', place: channelPlaceId('discord', 'c1') });
      bare.say({ native: 'c2', at: DB_NOW - 30000, text: 'και αλλη', place: channelPlaceId('discord', 'c1') });
      const none = dbRunner(bare, { places: false });
      assert.equal(
        (await none.recaller.window({ ...none.args, anchor: 'c2', move: 'up', messages: 2 })).outcome.kind,
        'unknown-anchor'
      );
    } finally {
      bare.done();
    }
  } finally {
    env.done();
  }
});

test("recall: the turn's execution context is used when it fits the read; a read it does not fit is issued its own", async () => {
  const env = fixture();
  try {
    env.say({ native: 'r1', at: DB_NOW - DAY, text: 'το σπιτι', place: channelPlaceId('discord', 'c1') });
    env.stem();
    const s = dbRunner(env);
    const issued: Array<{ kind: string; person?: string }> = [];
    const recaller = asRecall({
      hot: s.hot,
      store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [], personOfAccount: storedPersonOf },
      llm: { capLeft: () => 100, complete: async () => ({ text: '' }) },
      now: () => DB_NOW,
      memoryDb: {
        database: () => env.db,
        issueContext: (spec: { kind: string; person?: string }) => {
          issued.push(spec);
          return {
            iface: 'discord',
            kind: spec.kind,
            ...(spec.person ? { person: spec.person } : {}),
            id: `ctx:issued:${issued.length}`,
          };
        },
      },
    });
    const turn = { iface: 'discord', kind: 'group', id: 'ctx:turn' };
    const found = await recaller.run({
      ...s.args,
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
      memoryContext: turn,
    });
    assert.equal(found.quotes.length, 1);
    assert.deepEqual(issued, [], "the turn's own context, none issued");
    await recaller.window({ ...s.args, anchor: 'r1', move: 'up', messages: 2, memoryContext: turn, asker: ALICE });
    assert.deepEqual(issued, []);
    // A DM read does not take a group context: it is issued for its partner.
    await recaller.window({
      ...s.args,
      channel: s.dm,
      partnerId: BOB,
      anchor: 'r1',
      move: 'up',
      messages: 2,
      memoryContext: turn,
    });
    assert.deepEqual(
      issued.map((spec: { kind: string; person?: string }) => [spec.kind, spec.person]),
      [['dm', dbPersonId('discord', BOB)]]
    );
  } finally {
    env.done();
  }
});

test('recall.prefetch reads the database without throwing, and the asker it is given is the asker of its read', async () => {
  const env = fixture();
  try {
    env.account(ALICE, ['Αλίκη']);
    env.say({
      native: 'p1',
      at: DB_NOW - 3 * DAY,
      text: 'το σπιτι του δασκαλου',
      place: channelPlaceId('discord', 'c1'),
    });
    env.say({
      native: 'p2',
      at: DB_NOW - 3 * DAY + 60000,
      text: 'ναι ηταν μεγαλο',
      place: channelPlaceId('discord', 'c1'),
    });
    env.stem();
    const s = dbRunner(env);
    const warned: Array<unknown> = [];
    const found = await s.recaller.prefetch({ ...s.args, asker: BOB, lanes: [{ kind: 'trigger', text: 'το σπιτι' }] });
    assert.notEqual(found?.status, 'unavailable', 'the database prefetch ran');
    assert.deepEqual(warned, []);
  } finally {
    env.done();
  }
});

test('an issued internal context reads another DM through search and window without changing its scope', async () => {
  const env = fixture();
  try {
    env.account(BOB, ['Benoît']);
    const place = dmPlaceId('discord', BOB);
    env.say({
      native: 'owner-private-first',
      at: DB_NOW - DAY,
      text: 'το κουνέλι private-first',
      place,
      author: BOB,
      scope: dmScope(dbPersonId('discord', BOB), 'discord'),
    });
    env.say({
      native: 'owner-private-anchor',
      at: DB_NOW - DAY + 60_000,
      text: 'το κουνέλι private-anchor',
      place,
      author: BOB,
      scope: dmScope(dbPersonId('discord', BOB), 'discord'),
    });
    env.stem();
    const s = dbRunner(env);
    const { issueContext } = await import('../../../src/memory/db/scope.ts');
    const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:owner-private', now: () => DB_NOW });
    const before = env.db
      .prepare('SELECT audience_id, scope_kind, scope_iface, scope_dm FROM sources WHERE native_id = ?')
      .get('owner-private-anchor');
    const found = await s.recaller.run({
      ...s.args,
      server: { forms: ['κουνέλι'], who: ['benoît'], from: DB_NOW - DAY, to: DB_NOW },
      memoryContext,
    });
    assert.ok(found.quotes.flatMap((quote) => quote.entries).some((entry) => entry.id === 'owner-private-anchor'));
    const expanded = await s.recaller.window({
      ...s.args,
      anchor: 'owner-private-anchor',
      move: 'up',
      messages: 2,
      memoryContext,
    });
    assert.ok(expanded.quotes.flatMap((quote) => quote.entries).some((entry) => entry.id === 'owner-private-first'));
    const ordinary = await s.recaller.run({
      ...s.args,
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
    });
    assert.deepEqual(ordinary.quotes, []);
    assert.deepEqual(
      env.db
        .prepare('SELECT audience_id, scope_kind, scope_iface, scope_dm FROM sources WHERE native_id = ?')
        .get('owner-private-anchor'),
      before
    );
  } finally {
    env.done();
  }
});

test('an ordinary DM retains its own evidence and public groups while another private chat stays excluded', async () => {
  const env = fixture(BOB, CAROL);
  try {
    env.account(BOB, ['Benoit']);
    env.account(CAROL, ['Carol']);
    env.say({
      native: 'own-private',
      at: DB_NOW - DAY,
      text: 'το κουνέλι own-private-marker',
      place: dmPlaceId('discord', BOB),
      author: BOB,
      scope: dmScope(dbPersonId('discord', BOB), 'discord'),
    });
    env.say({
      native: 'unrelated-private',
      at: DB_NOW - DAY,
      text: 'το κουνέλι unrelated-private-marker',
      place: dmPlaceId('discord', CAROL),
      author: CAROL,
      scope: dmScope(dbPersonId('discord', CAROL), 'discord'),
    });
    env.say({
      native: 'shared-group',
      at: DB_NOW - DAY,
      text: 'το κουνέλι shared-group-marker',
      place: channelPlaceId('discord', 'c1'),
    });
    env.stem();
    const s = dbRunner(env);
    const found = await s.recaller.run({
      ...s.args,
      channel: s.dm,
      partnerId: BOB,
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
    });
    const entries = found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id));
    assert.ok(entries.includes('own-private'));
    assert.ok(entries.includes('shared-group'), JSON.stringify(found));
    assert.equal(entries.includes('unrelated-private'), false);
    const denied = await s.recaller.window({
      ...s.args,
      channel: s.dm,
      partnerId: BOB,
      anchor: 'unrelated-private',
      move: 'up',
      messages: 2,
    });
    assert.equal(denied.outcome.kind, 'unknown-anchor');
  } finally {
    env.done();
  }
});

test('search, window and prefetch retain one issued internal context rather than issuing narrower readers', async () => {
  const env = fixture();
  try {
    const { issueContext } = await import('../../../src/memory/db/scope.ts');
    env.account(BOB, ['Benoit']);
    env.say({
      native: 'owner-shared-reader-before',
      at: DB_NOW - DAY - 60_000,
      text: 'το κουνέλι shared-reader-marker',
      place: dmPlaceId('discord', BOB),
      author: BOB,
      scope: dmScope(dbPersonId('discord', BOB), 'discord'),
    });
    env.say({
      native: 'owner-shared-reader',
      at: DB_NOW - DAY,
      text: 'το κουνέλι shared-reader-marker',
      place: dmPlaceId('discord', BOB),
      author: BOB,
      scope: dmScope(dbPersonId('discord', BOB), 'discord'),
    });
    env.stem();
    const s = dbRunner(env);
    const issued: Array<Parameters<typeof issueContext>[0]> = [];
    const recaller = createRecall({
      mediaNameOf: noMediaNames,
      iface: 'discord',
      hot: s.hot,
      store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [], personOfAccount: storedPersonOf },
      llm: {
        capLeft: () => 100,
        complete: () => Promise.reject(new Error('quoted database reads do not summarize')),
      },
      now: () => DB_NOW,
      memoryDb: {
        database: () => env.db,
        issueContext: (spec: Parameters<typeof issueContext>[0]) => {
          issued.push(spec);
          return issueContext({ ...spec, newId: () => `ctx:unexpected:${issued.length}`, now: () => DB_NOW });
        },
      },
    });
    const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:shared-reader', now: () => DB_NOW });
    const found = await recaller.run({
      ...s.args,
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      memoryContext,
    });
    assert.ok(JSON.stringify(found).includes('shared-reader-marker'));
    const expanded = await recaller.window({
      ...s.args,
      anchor: 'owner-shared-reader',
      move: 'up',
      messages: 1,
      memoryContext,
    });
    assert.ok(JSON.stringify(expanded).includes('shared-reader-marker'));
    const prefetched = await recaller.prefetch({
      ...s.args,
      lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
      memoryContext,
    });
    assert.ok(JSON.stringify(prefetched).includes('shared-reader-marker'));
    assert.deepEqual(issued, []);
  } finally {
    env.done();
  }
});

for (const memoryContext of [
  { internal: true, mode: 'internal', id: '' },
  { internal: true, mode: 'outward', id: 'ctx:wrong-mode' },
  { mode: 'internal', id: 'ctx:missing-marker' },
]) {
  test(`a malformed internal reader fails closed for ${memoryContext.id || 'empty ID'}`, async () => {
    const env = fixture();
    try {
      env.say({
        native: 'malformed-hidden',
        at: DB_NOW - DAY,
        text: 'το κουνέλι malformed-hidden-marker',
        place: dmPlaceId('discord', BOB),
        author: BOB,
        scope: dmScope(dbPersonId('discord', BOB), 'discord'),
      });
      env.stem();
      const s = dbRunner(env);
      const found = await s.recaller.run({
        ...s.args,
        server: { forms: ['κουνέλι'], who: [], from: null, to: null },
        memoryContext,
      });
      assert.deepEqual(found.quotes, []);
      const expanded = await s.recaller.window({
        ...s.args,
        anchor: 'malformed-hidden',
        move: 'up',
        messages: 1,
        memoryContext,
      });
      assert.equal(expanded.outcome.kind, 'unknown-anchor');
      const prefetched = await s.recaller.prefetch({
        ...s.args,
        lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
        memoryContext,
      });
      assert.equal(JSON.stringify(prefetched).includes('malformed-hidden-marker'), false);
    } finally {
      env.done();
    }
  });
}

for (const kind of ['group', 'dm'] as const) {
  test(`a ${kind} reader searches and expands an offline foreign group outside its live snapshot`, async () => {
    const env = fixture();
    try {
      for (const [native, minute] of [
        ['offline-before', 0],
        ['offline-anchor', 1],
      ] as const) {
        env.say({
          native,
          iface: 'other',
          at: DB_NOW - DAY + minute * 60_000,
          text: `το κουνέλι ${native}`,
          place: channelPlaceId('other', 'offline'),
          scope: groupScope('other'),
        });
      }
      env.stem();
      const s = dbRunner(env);
      insertRows(env.db, {
        places: [
          {
            id: channelPlaceId('other', 'offline'),
            iface: 'other',
            kind: 'channel',
            native_id: 'offline',
            scope_kind: 'group',
            name: 'offline group',
          },
        ],
      });
      const context = kind === 'dm' ? dmOfMember(BOB) : groupContext('discord');
      assert.deepEqual(ids(run(env, ['κουνέλι'], {}, { ...context, audienceColumn: true })).sort(), [
        'offline-anchor',
        'offline-before',
      ]);
      const args = { ...s.args, ...(kind === 'dm' ? { channel: s.dm, partnerId: BOB } : {}) };
      const found = await s.recaller.run({
        ...args,
        server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      });
      assert.ok(found.quotes.flatMap((quote) => quote.entries).some((entry) => entry.id === 'offline-anchor'));
      assert.ok(found.quotes.some((quote) => quote.channelName === 'offline group'));
      const expanded = await s.recaller.window({ ...args, anchor: 'offline-anchor', move: 'up', messages: 2 });
      assert.ok(expanded.quotes.flatMap((quote) => quote.entries).some((entry) => entry.id === 'offline-before'));
      const prefetched = await s.recaller.prefetch({
        ...args,
        lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
      });
      assert.ok(JSON.stringify(prefetched).includes('offline-before'));
    } finally {
      env.done();
    }
  });
}

for (const reader of ['run', 'window', 'prefetch'] as const) {
  test(`an internal ${reader} without a guild reads SQLite without consulting legacy guild data`, async () => {
    const env = fixture();
    try {
      const { issueContext } = await import('../../../src/memory/db/scope.ts');
      env.account(BOB, ['Benoit']);
      for (const [native, offset] of [
        ['null-guild-before', 60_000],
        ['null-guild-anchor', 0],
      ] as const) {
        env.say({
          native,
          at: DB_NOW - DAY - offset,
          text: 'το κουνέλι null-guild-private-evidence',
          place: dmPlaceId('discord', BOB),
          author: BOB,
          scope: dmScope(dbPersonId('discord', BOB), 'discord'),
        });
      }
      env.stem();
      const s = dbRunner(env);
      const calls: Array<string> = [];
      const reject = (name: string) => () => {
        calls.push(name);
        throw new Error(`unexpected legacy guild read: ${name}`);
      };
      const recaller = createRecall({
        mediaNameOf: noMediaNames,
        iface: 'discord',
        hot: s.hot,
        store: {
          state: { data: {}, markDirty() {} },
          listUserProfiles: reject('profiles'),
          getLore: reject('lore'),
          getPlace: reject('guild'),
          getRecent: reject('recent'),
          getPrivate: reject('private'),
        },
        memberName: reject('member name'),
        describer: { cachedDescriptions: reject('captions') },
        llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('SQLite evidence needs no model')) },
        now: () => DB_NOW,
        memoryDb: { database: () => env.db },
      });
      const args = {
        ...s.args,
        placeId: null,
        snapshot: null,
        channel: s.dm,
        memoryContext: issueContext({ kind: 'internal', newId: () => `ctx:null-guild-${reader}`, now: () => DB_NOW }),
      };
      const found =
        reader === 'run'
          ? await recaller.run({ ...args, server: { forms: ['κουνέλι'], who: [], from: null, to: null } })
          : reader === 'window'
            ? await recaller.window({ ...args, anchor: 'null-guild-anchor', move: 'up', messages: 1 })
            : await recaller.prefetch({
                ...args,
                lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
              });
      assert.deepEqual(calls, []);
      assert.ok(JSON.stringify(found).includes('null-guild-private-evidence'));
    } finally {
      env.done();
    }
  });
}

for (const hasProfiles of [true, false]) {
  test(`a database window ${hasProfiles ? 'prefers an approved profile name to the stored account name' : 'returns stored evidence and names without an optional profile reader'}`, async () => {
    const env = fixture();
    try {
      env.account(ALICE, ['Stored account']);
      for (const [native, offset] of [
        ['profile-before', 60000],
        ['profile-anchor', 0],
      ] as const) {
        env.say({
          native,
          at: DB_NOW - DAY - offset,
          text: 'Profile evidence',
          place: channelPlaceId('discord', 'c1'),
        });
      }
      const s = dbRunner(env);
      const recaller = asRecall({
        hot: s.hot,
        now: () => DB_NOW,
        store: hasProfiles ? { listUserProfiles: () => [{ id: ALICE, names: ['Approved profile'] }] } : {},
        memoryDb: { database: () => env.db },
      });
      const found = await recaller.window({ ...s.args, anchor: 'profile-anchor', move: 'up', messages: 1 });
      assert.equal(found.outcome.kind, 'searched');
      assert.deepEqual(
        found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
        ['profile-before']
      );
      const firstQuote = found.quotes[0];
      assert.ok(firstQuote.lines.includes('Profile evidence'));
      const foundFirstQuote = found.quotes[0];
      const firstEntry = foundFirstQuote.entries[0];
      assert.equal(firstEntry.message.authorName, hasProfiles ? 'Approved profile' : 'Stored account');
    } finally {
      env.done();
    }
  });
}

for (const supplied of ['other-dm', 'group', 'current-dm'] as const) {
  test(`a DM search reads only its current partner when supplied an issued ${supplied} context`, async () => {
    const env = fixture(BOB, CAROL);
    try {
      const { issueContext } = await import('../../../src/memory/db/scope.ts');
      for (const author of [BOB, CAROL]) {
        env.account(author, [author]);
        env.say({
          native: `context-${author}`,
          at: DB_NOW - DAY,
          text: `το κουνέλι evidence-${author}`,
          place: dmPlaceId('discord', author),
          author,
          scope: dmScope(dbPersonId('discord', author), 'discord'),
        });
      }
      env.stem();
      const s = dbRunner(env);
      const memoryContext = issueContext({
        ...(supplied === 'group'
          ? { kind: 'group' as const }
          : { kind: 'dm' as const, ...dmSpecOf(supplied === 'other-dm' ? CAROL : BOB) }),
        iface: 'discord',
        newId: () => `ctx:supplied-${supplied}`,
        now: () => DB_NOW,
      });
      const found = await s.recaller.run({
        ...s.args,
        channel: s.dm,
        partnerId: BOB,
        memoryContext,
        server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      });
      assert.deepEqual(
        found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
        [`context-${BOB}`]
      );
      const firstQuote = found.quotes[0];
      assert.ok(firstQuote.lines.includes(`evidence-${BOB}`));
      assert.equal(
        found.quotes.some((quote) => quote.lines.includes(`evidence-${CAROL}`)),
        false
      );
    } finally {
      env.done();
    }
  });
}
