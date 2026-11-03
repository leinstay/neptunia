// Scoped exclusions preserve independent SQLite evidence across native message collisions and conversation contexts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRecall } from '../src/behavior/recall-run.ts';
import { snapshotOf } from '../src/behavior/snapshot.ts';
import { search } from '../src/memory/db/recall.ts';
import type { ResolvedRecallAnchor } from '../src/memory/db/recall.ts';
import { observe, type Envelope } from '../src/memory/db/observe.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { channelPlaceId, dmPlaceId, personId } from '../src/memory/db/ids.ts';
import { groupContext, internalContext, issueContext as issuedContext } from '../src/memory/db/scope.ts';
import { runMemorySearch } from '../src/tools/tools.ts';
import { fixture } from './fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { channel as channelInfo, privateChannel, rig } from './fixtures/reads-rig.ts';
import { lineEvent } from './fixtures/core-over-fake.ts';
import { labels } from './fixtures/labels.ts';

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const BOB = 'u-bob';
const group = groupContext('discord');
const plan = (forms: Array<string>, extra: Record<string, unknown> = {}) => ({
  forms,
  who: [],
  from: null,
  to: null,
  ...extra,
});
const run = (
  env: ReturnType<typeof fixture>,
  forms: Array<string>,
  { plan: given = {}, ...rest }: { plan?: Record<string, unknown>; [key: string]: unknown } = {},
  ctx = group
) => search(env.db, { ctx, plan: plan(forms, given), now: NOW, ...rest });

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('tracked settings require an object');
  return value;
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
  const parsed: unknown = JSON.parse(fs.readFileSync(new URL('../config/config.json', import.meta.url), 'utf8'));
  const config = objectOf(parsed);
  config.bot = { ...objectOf(config.bot ?? {}), timezone: 'UTC' };
  config.features = { ...objectOf(config.features ?? {}), meaningSearch: false, recall: true };
  const models = objectOf(config.models ?? {});
  config.models = { ...models, base: { ...objectOf(models.base ?? {}), embedding: 'test/embedder' } };
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { conversations: [channel, secret], groups: [] });
  const hot = {
    config,
    prompts: {
      'recall-summary': 'x',
      labels: {
        ...labels,
        tools: {
          ...labels.tools,
          tools: { ...labels.tools.tools, memory: { ...labels.tools.tools.memory, hidden: 'ΚΡΥΦΟ-ΣΗΜΑ' } },
        },
      },
    },
  };
  const recaller = createRecall({
    reads: rig().reads,
    hot,
    store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [] },
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('quoted SQLite reads need no model')) },
    now: () => NOW,
    embed: null,
    memoryDb: { database: () => env.db },
  });
  return {
    recaller,
    hot,
    args: {
      guildId: 'g1',
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

function storedObservation(
  env: ReturnType<typeof fixture>,
  {
    key,
    room,
    iface = 'other',
    authority = `${iface}/${room}`,
    text = 'το κουνέλι',
    at = NOW - DAY,
    privatePlace = false,
    revision = 1,
  }: {
    key: string;
    room: string;
    iface?: string;
    authority?: string;
    text?: string;
    at?: number;
    privatePlace?: boolean;
    revision?: number;
  }
) {
  const envelope: Envelope = {
    v: 1,
    iface,
    authority,
    native: { kind: 'message', key, revision },
    place: {
      authority,
      key: room,
      kind: privatePlace ? 'dm' : 'room',
      conversation: privatePlace ? 'dm' : 'group',
      ...(privatePlace ? { partner: { key: 'private-partner' } } : {}),
    },
    author: { kind: 'account', key: 'author-42' },
    occurredAt: new Date(at).toISOString(),
    observedAt: new Date(NOW).toISOString(),
    text,
  };
  const result = observe(env.handle, envelope, { now: () => NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string') throw new Error('source identity missing');
  const placeId = env.db.prepare('SELECT place_id FROM sources WHERE id = ?').get(result.sourceId)?.place_id;
  if (typeof placeId !== 'string') throw new Error('stored place missing');
  return { sourceId: result.sourceId, placeId, iface };
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
    conversationId: room,
    authorId: 'owner-42',
    text: `το κουνέλι ${marker}`,
    at: NOW - DAY - offset,
  });
  event.iface = iface;
  event.conversation = dm
    ? { id: room, kind: 'dm', communityId: null, partnerId: 'owner-42' }
    : { id: room, kind: 'channel', communityId: 'g1', name: room };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid exclusion fixture was refused');
  envelope.authority = authority;
  envelope.place.authority = authority;
  const result = observe(env.handle, envelope, { now: () => NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string' || typeof result.placeId !== 'string')
    throw new Error('exclusion source identity missing');
  return {
    sourceId: result.sourceId,
    placeId: result.placeId,
    iface,
    native: { iface, conversationId: room, messageId: id },
  };
}

for (const reader of ['run', 'window', 'prefetch'] as const) {
  test(`scoped history exclusions in ${reader} retain foreign and other-conversation native-ID collisions`, async () => {
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
        historyRef: { iface: 'fake', conversationId: 'current-room' },
        history: [{ id: 'shared-visible', channelId: 'current-room', content: 'το κουνέλι own-visible-731' }],
        memoryContext: issuedContext({
          kind: 'group',
          iface: 'fake',
          newId: () => `ctx:exclude-${reader}`,
          now: () => NOW,
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
            room: source.native.conversationId,
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
                quotes: true,
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

test('a scoped native exclusion removes only its verified conversation from low-level search', () => {
  const env = fixture();
  try {
    const own = exclusionSource(env, { room: 'current-room', marker: 'own' });
    const foreign = exclusionSource(env, { iface: 'other', room: 'foreign-room', marker: 'foreign' });
    const nearby = exclusionSource(env, { room: 'different-room', marker: 'different' });
    env.stem();
    const found = run(
      env,
      ['κουνέλι'],
      { exclusions: [{ kind: 'native', locator: own.native }] },
      groupContext('fake')
    );
    assert.deepEqual(found.hits.map((hit) => hit.id).sort(), [foreign.sourceId, nearby.sourceId].sort());
  } finally {
    env.done();
  }
});

test('an exact opaque source exclusion does not need a verified native locator', () => {
  const env = fixture();
  try {
    const own = storedObservation(env, { key: 'opaque-excluded', room: 'opaque-one' });
    const other = storedObservation(env, { key: 'opaque-excluded', room: 'opaque-two' });
    env.stem();
    const found = run(env, ['κουνέλι'], { exclusions: [{ kind: 'source', sourceId: own.sourceId }] });
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [other.sourceId]
    );
  } finally {
    env.done();
  }
});

test('a legacy native exclusion is limited to the unique source in the reader interface', () => {
  const env = fixture();
  try {
    exclusionSource(env, { room: 'current-room', marker: 'own' });
    const foreign = exclusionSource(env, { iface: 'other', room: 'foreign-room', marker: 'foreign' });
    env.stem();
    const found = run(env, ['κουνέλι'], { exclude: new Set(['shared-visible']) }, groupContext('fake'));
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [foreign.sourceId]
    );
  } finally {
    env.done();
  }
});

test('an ambiguous legacy native exclusion retains both same-interface conversations', () => {
  const env = fixture();
  try {
    const first = exclusionSource(env, { room: 'first-room', marker: 'first' });
    const second = exclusionSource(env, { room: 'second-room', marker: 'second' });
    env.stem();
    const found = run(env, ['κουνέλι'], { exclude: new Set(['shared-visible']) }, groupContext('fake'));
    assert.deepEqual(found.hits.map((hit) => hit.id).sort(), [first.sourceId, second.sourceId].sort());
  } finally {
    env.done();
  }
});

test('an internal reader ignores unqualified legacy native exclusions', () => {
  const env = fixture();
  try {
    const source = exclusionSource(env, { room: 'private-room', marker: 'private', dm: true });
    env.stem();
    const found = run(env, ['κουνέλι'], { exclude: new Set(['shared-visible']) }, internalContext());
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [source.sourceId]
    );
  } finally {
    env.done();
  }
});

for (const malformed of [false, true]) {
  test(`explicit ${malformed ? 'malformed' : 'empty'} exclusions never fall back to legacy native exclusions`, () => {
    const env = fixture();
    try {
      const source = exclusionSource(env, { room: 'current-room', marker: 'visible' });
      env.stem();
      const exclusions: ReadonlyArray<ResolvedRecallAnchor> = malformed ? [{ kind: 'source', sourceId: '' }] : [];
      const found = run(env, ['κουνέλι'], { exclusions, exclude: new Set(['shared-visible']) }, groupContext('fake'));
      assert.deepEqual(
        found.hits.map((hit) => hit.id),
        [source.sourceId]
      );
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
      channel: channelInfo('own-dm', { kind: 'dm', communityId: null, partnerId: 'owner-42', audience: null }),
      partnerId: 'owner-42',
      historyRef: { iface: 'discord', conversationId: 'own-dm' },
      history: [{ id: 'shared-visible', channelId: 'own-dm', content: 'το κουνέλι own-dm-visible-731' }],
      memoryContext: issuedContext({
        kind: 'dm',
        iface: 'discord',
        person: personId('discord', 'owner-42'),
        place: own.placeId,
        newId: () => 'ctx:exclude-dm',
        now: () => NOW,
      }),
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      quotes: true,
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

for (const reader of ['prefetch', 'tool'] as const) {
  test(`an internal CLI ${reader} excludes trusted current history while retaining a foreign private collision`, async () => {
    const env = fixture();
    try {
      exclusionSource(env, { iface: 'cli', room: 'cli:dm:owner', marker: 'own-cli-visible-731', dm: true });
      exclusionSource(env, { iface: 'other', room: 'foreign-dm', marker: 'foreign-private-842', dm: true });
      env.stem();
      const s = runner(env);
      const args = {
        ...s.args,
        guildId: null,
        snapshot: null,
        channel: channelInfo('cli:dm:owner', { kind: 'dm', communityId: null, partnerId: 'owner-42', audience: null }),
        historyRef: { iface: 'cli', conversationId: 'cli:dm:owner' },
        history: [{ id: 'shared-visible', channelId: 'cli:dm:owner', content: 'το κουνέλι own-cli-visible-731' }],
        memoryContext: issuedContext({ kind: 'internal', newId: () => `ctx:exclude-cli-${reader}`, now: () => NOW }),
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
              now: NOW,
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
      historyRef: { iface: 'fake', conversationId: 'current-room' },
      history: [
        {
          id: 'shared-visible',
          channelId: 'current-room',
          content: 'το κουνέλι retained-own-731',
          stored: { sourceId: '', placeId: own.placeId, iface: 'fake' },
        },
      ],
      memoryContext: issuedContext({
        kind: 'group',
        iface: 'fake',
        newId: () => 'ctx:malformed-history',
        now: () => NOW,
      }),
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.ok(JSON.stringify(found).includes('retained-own-731'));
  } finally {
    env.done();
  }
});

test('ordinary history without an explicit reference uses its validated interface and actual conversation', async () => {
  const env = fixture();
  try {
    exclusionSource(env, { room: 'current-room', marker: 'ordinary-own-731' });
    exclusionSource(env, { iface: 'other', room: 'current-room', marker: 'ordinary-foreign-842' });
    env.stem();
    const s = runner(env);
    const found = await s.recaller.run({
      ...s.args,
      channel: channelInfo('current-room'),
      history: [{ id: 'shared-visible', channelId: 'current-room', content: 'το κουνέλι ordinary-own-731' }],
      memoryContext: issuedContext({
        kind: 'group',
        iface: 'fake',
        newId: () => 'ctx:ordinary-history',
        now: () => NOW,
      }),
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.equal(JSON.stringify(found).includes('ordinary-own-731'), false);
    assert.ok(JSON.stringify(found).includes('ordinary-foreign-842'));
  } finally {
    env.done();
  }
});

test('an ambiguous qualified native exclusion retains distinct current stored sources', () => {
  const env = fixture();
  try {
    const first = exclusionSource(env, { room: 'shared-room', authority: 'fake/first', marker: 'first' });
    const second = exclusionSource(env, { room: 'shared-room', authority: 'fake/second', marker: 'second' });
    env.stem();
    const found = search(env.db, {
      ctx: groupContext('fake'),
      plan: plan(['κουνέλι']),
      now: NOW,
      exclusions: [{ kind: 'native', locator: first.native }],
    });
    assert.deepEqual(found.hits.map((hit) => hit.id).sort(), [first.sourceId, second.sourceId].sort());
  } finally {
    env.done();
  }
});

test('the in-turn memory tool derives CLI history scope from its trusted conversation reference', async () => {
  const env = fixture();
  try {
    const { createInTurnTools } = await import('../src/turn/in-turn-tools.ts');
    const { turnRoutes } = await import('../src/behavior/turn-ability-route.ts');
    const { rig } = await import('./fixtures/reads-rig.ts');
    exclusionSource(env, { iface: 'cli', room: 'cli:dm:owner', marker: 'handler-own-731', dm: true });
    exclusionSource(env, { iface: 'other', room: 'foreign-dm', marker: 'handler-foreign-842', dm: true });
    env.stem();
    const s = runner(env);
    const memoryContext = issuedContext({ kind: 'internal', newId: () => 'ctx:handler-exclusion', now: () => NOW });
    const tools = createInTurnTools({
      hot: s.hot,
      store: {},
      recall: s.recaller,
      lookup: undefined,
      describer: undefined,
      speech: null,
      record: null,
      routes: turnRoutes(s.hot, null),
      clock: () => NOW,
      ifaceReads: rig().reads,
      memberOf: () => null,
      conversationOf: (channel) => ({ iface: 'cli', conversationId: channel.id }),
      turnContextOf: () => memoryContext,
      linkCalls: (lines) => lines,
      drawTool: () => Promise.reject(new Error('memory reads do not draw')),
      plugins: null,
    });
    const handlers = tools.inTurnTools({
      channel: channelInfo('cli:dm:owner', { kind: 'dm', communityId: null, partnerId: 'owner-42', audience: null }),
      guildId: 'g1',
      selfId: 'self',
      selfName: 'Synthetic persona',
      history: [{ id: 'shared-visible', channelId: 'cli:dm:owner', content: 'το κουνέλι handler-own-731' }],
    });
    const found = await handlers['memory.search']({ terms: 'κουνέλι' });
    assert.equal(JSON.stringify(found).includes('handler-own-731'), false);
    assert.ok(JSON.stringify(found).includes('handler-foreign-842'));
  } finally {
    env.done();
  }
});

test('lookup prefetch forwards trusted CLI history identity into the real SQLite reader', async () => {
  const env = fixture();
  try {
    const { createLookup } = await import('../src/turn/lookup.ts');
    const { rig } = await import('./fixtures/reads-rig.ts');
    exclusionSource(env, { iface: 'cli', room: 'cli:dm:owner', marker: 'lookup-own-731', dm: true });
    exclusionSource(env, { iface: 'other', room: 'foreign-dm', marker: 'lookup-foreign-842', dm: true });
    env.stem();
    const s = runner(env);
    const memoryContext = issuedContext({ kind: 'internal', newId: () => 'ctx:lookup-exclusion', now: () => NOW });
    const lookup = createLookup({
      hot: s.hot,
      store: {},
      llm: { complete: () => Promise.reject(new Error('prefetch does not classify')) },
      clock: () => NOW,
      recall: { prefetch: (args) => s.recaller.prefetch(args) },
      membersOf: null,
      selfIdOf: () => 'self',
      ifaceReads: rig().reads,
      classifierContext: () => {
        throw new Error('prefetch does not classify');
      },
      linkCalls: (lines) => lines,
    });
    const { config: prefetchConfig } = await import('./fixtures/recall-run-kit.ts');
    const pending = lookup.startPrefetch({
      config: prefetchConfig(),
      channel: channelInfo('cli:dm:owner', { kind: 'dm', communityId: null, partnerId: 'owner-42', audience: null }),
      guildId: 'g1',
      guild: null,
      trigger: { id: 'current-cli-trigger', authorId: 'owner-42' },
      candidate: { content: 'θυμάσαι το "το κουνέλι" από την παλιά συζήτηση;', authorId: 'owner-42' },
      triggerKind: 'private',
      mode: 'reply',
      history: [{ id: 'shared-visible', channelId: 'cli:dm:owner', content: 'το κουνέλι lookup-own-731' }],
      selfId: 'self',
      selfName: 'Synthetic persona',
      memoryContext,
      historyRef: { iface: 'cli', conversationId: 'cli:dm:owner' },
    });
    if (!pending) throw new Error('valid internal CLI prefetch did not start');
    const found = await pending.pending;
    assert.equal(JSON.stringify(found).includes('lookup-own-731'), false);
    assert.ok(JSON.stringify(found).includes('lookup-foreign-842'));
  } finally {
    env.done();
  }
});
