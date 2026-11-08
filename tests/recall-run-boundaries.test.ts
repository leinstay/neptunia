// Public recall boundaries over synthetic SQLite sources and legacy memory fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecall } from '../src/behavior/recall-run.ts';
import { runMemorySearch } from '../src/tools/tools.ts';
import { channelPlaceId } from '../src/memory/db/ids.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { fixture } from './fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { config } from './fixtures/recall-run-kit.ts';
import { labels } from './fixtures/labels.ts';
import { channel, rig } from './fixtures/reads-rig.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const PLACE = channelPlaceId('discord', 'main');
const args = {
  placeId: 'g1',
  channel: channel('main'),
  partnerId: null,
  selfId: 'self',
  selfName: 'Persona',
  history: [],
  candidate: { content: 'rabbit' },
};
const hot = {
  config: config({ features: { recall: true, meaningSearch: false } }),
  prompts: { labels, 'recall-summary': 'Synthetic summary prompt' },
};
const lanes = [{ kind: 'message', text: 'rabbit', words: 'rabbit' }];
type Quotes = { outcome: { kind: string }; quotes: Array<{ channelName: string | null; lines: string }> };

function scene(env: ReturnType<typeof fixture>, store: object = {}) {
  env.db
    .prepare(
      "INSERT INTO places (id, iface, kind, native_id, scope_kind) VALUES (?, 'discord', 'channel', 'main', 'group')"
    )
    .run(PLACE);
  env.say({ native: 'boundary-before', at: NOW - 120000, text: 'rabbit boundary evidence' });
  env.say({ native: 'boundary-anchor', at: NOW - 60000, text: 'rabbit anchor evidence' });
  env.stem();
  fillEnvAudiences(env);
  return createRecall({
    reads: rig().reads,
    hot,
    store,
    now: () => NOW,
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('unexpected model call')) },
    memoryDb: { database: () => env.db },
  });
}

test('a window without a chat context returns no configured reader or evidence', async () => {
  const env = fixture();
  try {
    const recall = scene(env);
    // The public window result includes outcome and quotes beyond its broad declared record type.
    const found = (await recall.window({
      ...args,
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
    const recall = scene(env, {
      listUserProfiles: () => {
        reads += 1;
        return [];
      },
    });
    const found = await recall.prefetch({ ...args, placeId: null, channel: null, lanes });
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
      const recall = scene(env);
      env.db.prepare('UPDATE places SET scope_kind = ?, name = ? WHERE id = ?').run(scope, 'Private location', PLACE);
      // The source audience remains group-readable independently of the place name.
      const found = (await recall.window({ ...args, anchor: 'boundary-anchor', messages: 1 })) as unknown as Quotes;
      assert.equal(found.quotes.length, 1);
      assert.ok(found.quotes[0].lines.includes('rabbit boundary evidence'));
      assert.equal(found.quotes[0].channelName, null);
    } finally {
      env.done();
    }
  });
}

test('prefetch returns stored lore when the database is unavailable for a valid root', async () => {
  const recall = createRecall({
    reads: rig().reads,
    hot,
    now: () => NOW,
    store: {
      listUserProfiles: () => [],
      getLore: () => [{ itemId: 'lore-rabbit', text: 'rabbit stored lore evidence' }],
    },
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('unexpected model call')) },
    memoryDb: { database: () => null },
  });
  const found = await recall.prefetch({ ...args, lanes });
  // Prefetch's public excerpts carry source fields beyond its broad declaration.
  const excerpts = found?.excerpts as Array<{ lines: string; id: string }> | undefined;
  assert.equal(excerpts?.length, 1);
  assert.equal(excerpts?.[0].id, 'lore-rabbit');
  assert.ok(excerpts?.[0].lines.includes('rabbit stored lore evidence'));
});

for (const hasRoot of [false, true]) {
  test(`memory search retains database evidence ${hasRoot ? 'without an optional profile callback' : 'without reading legacy profiles for a null root'}`, async () => {
    const env = fixture();
    try {
      const recall = scene(env);
      let profiles = 0;
      const store = hasRoot
        ? undefined
        : {
            listUserProfiles: () => {
              profiles += 1;
              return [];
            },
          };
      const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:tool-boundary', now: () => NOW });
      // The tool uses only these injected dependencies for a database search.
      const result = await runMemorySearch({
        ...args,
        placeId: hasRoot ? 'g1' : null,
        recall,
        store,
        config: hot.config,
        labels,
        now: NOW,
        memoryContext,
        args: { question: 'rabbit' },
      });
      assert.equal(result.status, 'ok');
      assert.ok(result.data?.text.includes('rabbit boundary evidence'));
      assert.equal(profiles, 0);
    } finally {
      env.done();
    }
  });
}

test('an internal summary request without a root performs no legacy reads when the database is unavailable', async () => {
  let loreReads = 0;
  let requests = 0;
  const recall = createRecall({
    reads: rig().reads,
    hot,
    now: () => NOW,
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
    ...args,
    placeId: null,
    memoryContext: issueContext({ kind: 'internal', newId: () => 'ctx:summary-boundary', now: () => NOW }),
    server: { forms: ['rabbit'], who: [], from: null, to: null },
  });
  assert.equal(found.text, null);
  assert.equal(found.stretch, null);
  assert.equal(loreReads, 0);
  assert.equal(requests, 0);
});
