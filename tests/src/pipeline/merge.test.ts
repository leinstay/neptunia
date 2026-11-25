// Tests for src/pipeline/merge.ts. The merge classifier's strict JSON answer: the request hands the client MERGE_FORMAT as `responseFormat`, an object
// `{ "item": number | null }` gives the decision the number or the word `new` gave (a number folds the call into that
// waiting item, null queues it as new, a number outside the items is `out-of-range` and queues it), and every other
// answer, the old number and word included, is an unreadable answer: the call is queued, logged `merge: failed`. The
// last section holds an authenticated query of the command line apart from every ordinary call.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMerge, MERGE_FORMAT } from '../../../src/pipeline/merge.ts';
import { createPendingQueue } from '../../../src/pipeline/pending-queue.ts';
import type { Line, PendingQueue, PipelineTurns } from '../../../src/pipeline/types.ts';
import { issueContext } from '../../../src/memory/db/scope.ts';
import { channelInfo } from '../../fixtures/core-over-fake.ts';
import type { labels as contractLabels } from '../../fixtures/labels.ts';
import { labels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import {
  createMessageHandler,
  createMessageHandler as createMessageHandlerOf,
} from '../../../src/behavior/pipeline.ts';
import { createTurnRunner } from '../../../src/behavior/turn.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { fill } from '../../../src/format.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { deepMerge } from '../../../src/config.ts';
import {
  asDiscordEvents,
  baseConfig,
  fakeChannel,
  fakeMemory,
  fakeMessage,
  fakeSpontaneous,
} from '../../fixtures/events-rig.ts';
import {
  freshWorld,
  runnerOptions,
  seedExisting,
  useIface,
  useSelf,
  world,
  onWorldIface,
  worldChannels,
} from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { table, wrongly } from '../../fixtures/loose-types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowflakeUtil } from 'discord.js';
import { joinLabels } from '../../../src/config/labels.ts';
import { MINUTE_MS } from '../../../src/time.ts';
import {
  normalizeOptions,
  toEvent,
  createDiscordAdapter,
  createDiscordInterface,
} from '../../../interfaces/discord/index.ts';
import { loose } from '../../fixtures/as-options.ts';
import { createTurnRunner as createFixtureTurnRunner } from '../../fixtures/turn-runner.ts';
import {
  NOW as FAKE_NOW,
  fakeClient,
  fakeLookup,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage as turnMemoryContextRawMessage,
} from '../../fixtures/turn-kit.ts';
import {
  SPLIT_TEXT,
  SPLIT_PARTS,
  PARTS_ANSWER,
  taskOf,
  splitLlm,
  splitHot,
  manualSchedule,
} from '../../fixtures/turn-split.ts';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const CHANNEL = channelInfo('c1');

function line(id: string): Line {
  return {
    id,
    placeId: CHANNEL.id,
    authorId: 'u2',
    authorName: 'Léa',
    content: `question ${id}`,
    ts: NOW,
    replyToId: null,
    mentionedAccountIds: [],
  };
}

type Sent = { options: { responseFormat?: unknown; purpose?: unknown } };

/**
 * Two calls of one author already waiting (`w1`, `w2`), then the call `incoming` held while the persona is busy, with
 * the merge model answering `text`. Resolves the trigger ids left in the queue, what each holds folded, the request
 * options and the merge log lines.
 */
async function hold(text: string) {
  const pending: PendingQueue = { list: [] };
  const sent: Array<Sent> = [];
  const turns: PipelineTurns = {
    isBusy: () => true,
    isAnyBusy: () => true,
    runTurn: () => Promise.resolve({ outcome: 'busy' }),
    notePost() {},
    waitingParts: () => [],
    addToPart: () => false,
  };
  const config = {
    bot: { timezone: 'UTC' },
    mention: { neverIgnore: [], repeatWindowMinutes: 0, maxPending: 10, followUpMaxOutputTokens: 20 },
    models: { routes: chainsOf({ analyzer: 'small/analyzer' }) },
    llm: { maxRequestTokens: 50000, maxRequestsPerDay: 100, timeoutMs: 1000 },
  };
  const hot = { config, prompts: { labels, 'classify/merge': 'Choose an item or new for {{name}}.' } };
  const queue = createPendingQueue({ hot, now: () => NOW, turns, missed: null, pending, followUpMuted: () => null });
  const { holdCall } = createMerge({
    hot,
    now: () => NOW,
    turns,
    store: { state: { data: {} } },
    pending,
    llm: {
      complete: (_messages, options) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    getSelfName: () => 'Nova',
    itemText: queue.itemText,
    enqueuePending: queue.enqueuePending,
    turnBlocked: () => true,
    drainPending: () => Promise.resolve(),
  });
  queue.enqueuePending(CHANNEL, line('w1'), 'mention');
  queue.enqueuePending(CHANNEL, line('w2'), 'mention');
  const { logs } = await withCapturedLogs(async () => {
    holdCall(CHANNEL, line('incoming'), 'mention');
    for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  });
  return {
    queued: pending.list.map((ping) => ping.trigger.id),
    added: pending.list.map((ping) => (ping.added ?? []).map((message) => message.id)),
    sent,
    verdicts: logs.filter((entry) => entry.msg === 'merge: verdict').map((entry): unknown => entry.answer),
    failed: logs.filter((entry) => entry.msg === 'merge: failed').map((entry): unknown => entry.reason),
  };
}

/** Answers that are not the object, or whose `item` is neither a whole number nor null: each is unreadable. */
const UNREADABLE = [
  '1',
  '2.',
  'new',
  'New',
  'The message is about item 1.',
  '{}',
  '{"index":1}',
  '{"item":"1"}',
  '{"item":"new"}',
  '{"item":true}',
  '{"item":[1]}',
  '{"item":1.5}',
  '[1]',
  '"new"',
  'null',
  '{"item":1',
  '```json\n{"item":1}\n```',
];

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, { type?: unknown; anyOf?: Array<{ type?: unknown }> }>;
};

/** The JSON types a property admits, from its `type` (one or a list) or its `anyOf` branches. */
function typesOf(property: { type?: unknown; anyOf?: Array<{ type?: unknown }> } | undefined): Array<unknown> {
  const own: Array<unknown> = [property?.type, ...(property?.anyOf ?? []).map((branch) => branch.type)];
  return own
    .flat()
    .filter((type) => type !== undefined)
    .map(String)
    .sort();
}

test('the merge request hands the client MERGE_FORMAT as its responseFormat', async () => {
  const { sent } = await hold('{"item":null}');
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.options.purpose, 'merge');
  assert.deepEqual(request.options.responseFormat, MERGE_FORMAT);
});

test('MERGE_FORMAT is a closed object whose one required field item is a whole number or null', () => {
  assert.match(MERGE_FORMAT.name, /^[A-Za-z0-9_-]{1,64}$/);
  const schema = MERGE_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['item']);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['item']);
  assert.deepEqual(typesOf(schema.properties?.item), ['integer', 'null']);
});

test('a number of a waiting item folds the call into that item, logged as an item verdict', async () => {
  const first = await hold('{"item":1}');
  assert.deepEqual(first.queued, ['w1', 'w2']);
  assert.deepEqual(first.added, [['incoming'], []]);
  assert.deepEqual(first.verdicts, ['item']);
  assert.deepEqual(first.failed, []);
  const second = await hold('{"item":2}');
  assert.deepEqual(second.added, [[], ['incoming']]);
});

test('a null item queues the call as new, logged as a new verdict', async () => {
  const { queued, added, verdicts, failed } = await hold('{"item":null}');
  assert.deepEqual(queued, ['w1', 'w2', 'incoming']);
  assert.deepEqual(added, [[], [], []]);
  assert.deepEqual(verdicts, ['new']);
  assert.deepEqual(failed, []);
});

test('a number outside the waiting items queues the call as new, logged as out-of-range', async () => {
  for (const item of [0, 3, -1]) {
    const { queued, verdicts, failed } = await hold(JSON.stringify({ item }));
    assert.deepEqual(queued, ['w1', 'w2', 'incoming'], String(item));
    assert.deepEqual(verdicts, [], String(item));
    assert.deepEqual(failed, ['out-of-range'], String(item));
  }
});

test('an unreadable answer, the old number and word included, queues the call as new, logged as unparsed', async () => {
  for (const text of UNREADABLE) {
    const { queued, added, verdicts, failed } = await hold(text);
    const label = JSON.stringify(text);
    assert.deepEqual(queued, ['w1', 'w2', 'incoming'], label);
    assert.deepEqual(added, [[], [], []], label);
    assert.deepEqual(verdicts, [], label);
    assert.deepEqual(failed, ['unparsed'], label);
  }
});

test('a blank answer queues the call as new, logged as empty', async () => {
  const { queued, failed } = await hold('   ');
  assert.deepEqual(queued, ['w1', 'w2', 'incoming']);
  assert.deepEqual(failed, ['empty']);
});

// --- an authenticated query never merges with an ordinary call ---------------------------------

const AUTH_NOW = Date.parse('2026-10-24T12:00:00Z');
const channel = channelInfo('cli:dm:owner', { iface: 'cli', kind: 'dm', rootId: null, partnerId: 'owner' });
const authLine = (id: string): Line => ({
  id,
  placeId: channel.id,
  authorId: 'owner',
  authorName: 'Owner',
  content: `question ${id}`,
  ts: AUTH_NOW,
  replyToId: null,
  mentionedAccountIds: [],
});

function setup(parts: Array<{ index: number; text: string }> = []) {
  const pending: PendingQueue = { list: [] };
  const folds: Array<unknown> = [];
  const classifications: Array<unknown> = [];
  const turns: PipelineTurns = {
    isBusy: () => true,
    isAnyBusy: () => true,
    runTurn: () => Promise.resolve({ outcome: 'busy' }),
    notePost() {},
    waitingParts: () => parts,
    addToPart: (...args) => {
      folds.push(args);
      return true;
    },
  };
  const config = {
    bot: { timezone: 'UTC' },
    mention: { neverIgnore: [], repeatWindowMinutes: 0, maxPending: 10 },
    models: { routes: chainsOf({ analyzer: 'test/analyzer' }) },
    llm: { maxRequestTokens: 50000, maxRequestsPerDay: 100, timeoutMs: 1000 },
  };
  const hot = { config, prompts: { labels, 'classify/merge': 'Choose an item or new. {{items}} {{message}}' } };
  const queue = createPendingQueue({
    hot,
    now: () => AUTH_NOW,
    turns,
    missed: null,
    pending,
    followUpMuted: () => null,
  });
  const merge = createMerge({
    hot,
    now: () => AUTH_NOW,
    turns,
    store: { state: { data: {} } },
    pending,
    llm: {
      complete: (messages) => {
        classifications.push(messages);
        return Promise.resolve({ text: '{"item":1}' });
      },
    },
    getSelfName: () => 'Nova',
    itemText: queue.itemText,
    enqueuePending: queue.enqueuePending,
    turnBlocked: () => true,
    drainPending: async () => {},
  });
  return { ...merge, queue, pending, folds, classifications };
}

for (const privileged of ['waiting', 'incoming'] as const) {
  test(`a ${privileged} authenticated query cannot merge with a plain pending CLI-shaped call`, async () => {
    const rig = setup();
    const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:queued-owner', now: () => AUTH_NOW });
    const readOptions = { memoryContext };
    rig.queue.enqueuePending(
      channel,
      authLine('waiting'),
      'private',
      AUTH_NOW,
      privileged === 'waiting' ? readOptions : undefined
    );
    rig.holdCall(channel, authLine('incoming'), 'private', privileged === 'incoming' ? readOptions : undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const waiting = rig.pending.list;
    assert.deepEqual(
      waiting.map((ping) => ping.trigger.id),
      ['waiting', 'incoming']
    );
    assert.deepEqual(
      waiting.map((ping) => ping.added ?? []),
      [[], []]
    );
    assert.deepEqual(
      waiting.map((ping) => {
        const context = ping.readOptions?.memoryContext;
        return context?.id ?? null;
      }),
      privileged === 'waiting' ? ['ctx:queued-owner', null] : [null, 'ctx:queued-owner']
    );
    assert.deepEqual(rig.classifications, []);
  });
}

test('an authenticated query cannot merge into an ordinary active chain', async () => {
  const rig = setup([{ index: 2, text: 'an ordinary part still waiting' }]);
  const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:incoming-owner', now: () => AUTH_NOW });
  rig.holdCall(channel, authLine('incoming'), 'private', { memoryContext });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(rig.folds, []);
  const waiting = rig.pending.list;
  assert.deepEqual(
    waiting.map((ping) => ping.trigger.id),
    ['incoming']
  );
  const first = waiting[0];
  assert.equal(first?.readOptions?.memoryContext, memoryContext);
  assert.deepEqual(rig.classifications, []);
});

test('two ordinary calls still merge when the classifier chooses the waiting call', async () => {
  const rig = setup();
  rig.queue.enqueuePending(channel, authLine('waiting'), 'private');
  rig.holdCall(channel, authLine('incoming'), 'private');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const waiting = rig.pending.list;
  assert.deepEqual(
    waiting.map((ping) => ping.trigger.id),
    ['waiting']
  );
  const first = waiting[0];
  assert.deepEqual(first?.added, [{ id: 'incoming', text: 'question incoming', ts: AUTH_NOW }]);
  assert.equal(rig.classifications.length, 1);
});

/** tagHistory that counts its hits, to prove a deferred ping is not counted on arrival. */
function countingTagHistory() {
  const inner = createTagHistory();
  const tags = {
    hits: 0,
    count: (...args: Parameters<typeof inner.count>) => inner.count(...args),
    hit: (...args: Parameters<typeof inner.hit>) => ((tags.hits += 1), inner.hit(...args)),
  };
  return tags;
}

function fakeDmChannel(id = 'dm1', recipientId = 'u1', overrides: Record<string, Untyped> = {}) {
  const sent: Array<Untyped> = [];
  world().channel({ id, dm: true, partnerId: recipientId ?? null }, { keep: true });
  seedExisting(id, 'dm-m1');
  return {
    id,
    type: 'DM',
    guild: null,
    recipientId,
    sent,
    send: async (payload: Record<string, Untyped>) => {
      sent.push(payload);
      return { id: `sent${sent.length}` };
    },
    messages: { cache: new Map([['dm-m1', {}]]), fetch: async () => ({}) },
    ...overrides,
  };
}

/** A client of a served root the interface knows `members` and `fetchable` ones of; `fetchCalls` lists each member read. */
function fakeDmClient({
  members = ['u1', 'owner1'],
  fetchable = [],
}: { members?: Untyped; fetchable?: Array<Untyped> } = {}) {
  const fetchCalls: Array<Untyped> = [];
  return { user: { id: 'self1', username: 'Neptunia' }, fetchCalls, knows: [...members, ...fetchable] };
}

/** A store with public profiles and private files; records the private bookkeeping calls. */
function fakePrivateStore({
  profiles = { u1: { affinity: { score: 10 } }, owner1: { affinity: { score: -50 } } },
  privates = {},
}: { profiles?: Untyped; privates?: Record<string, Untyped> } = {}) {
  return {
    state: { data: {} },
    getUser: (accountId: string) => profiles[accountId] ?? null,
    getPrivate: (accountId: string) => privates[accountId] ?? null,
    // PR 7d: memory is code, so the real turn reads these of the store.
    getPlace: () => ({}),
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => Object.keys(profiles).length,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
  };
}

// ---------------------------------------------------------------------------
// Several calls, one attention: the real turn runner (src/behavior/turn.ts) behind the handler.
// A message that holds several requests is answered part by part; every waiting call gets its
// own turn, in arrival order; a call about something still waiting is folded into it.

const LIVE_T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const LIVE_SPLIT = 'ποιος είναι ο Νίκος ακριβώς; κοίτα το κανάλι της Ελένης, και πες μου αν το μιμίδιο είναι αστείο.';
const LIVE_PARTS = ['ποιος είναι ο Νίκος ακριβώς', 'κοίτα το κανάλι της Ελένης', 'το μιμίδιο είναι αστείο;'];
const LIVE_NAMES: Record<string, Untyped> = { u1: 'Alice', u2: 'Léa' };

/**
 * Like withCapturedLogs, but the entries are visible to `fn` while it runs (`fn(logs)`), so a
 * scene can wait for a log line. Only the logger's own lines are captured.
 */
async function withLiveLogs(fn: Untyped) {
  const original = process.stdout.write;
  const logs: Array<Untyped> = [];
  process.stdout.write = function write(chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.startsWith('{"level"')) {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        try {
          logs.push(JSON.parse(line));
        } catch {
          // a truncated line -- ignore
        }
      }
      const callback = rest.find((arg) => typeof arg === 'function');
      if (callback) callback();
      return true;
    }
    return original.call(process.stdout, chunk, ...wrongly<[]>(rest));
  };
  try {
    await fn(logs);
  } finally {
    process.stdout.write = original;
  }
  return { logs };
}

/** Resolves after `check()` holds, or after a bounded number of event-loop turns (no wall clock). */
async function tickUntil(check: Untyped, rounds = 3000) {
  // PR 7d: the real turn is longer now (memory and the typing imitation are code), so a round waits a millisecond.
  for (let i = 0; i < rounds && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * A server channel (or, `dm`, a private chat with u1) whose history is every message sent so far,
 * a real turn runner, and the handler, wired as src/index.ts wires them. `talk(index)` answers the
 * talk requests (it may return a promise: a gate holding the turn); `split` and `merge` the
 * splitter and the merge classifier (a string, an Error, or a function of the call's index).
 * `prompts['classify/split']` / `prompts['classify/merge']` exist only when their answer is given.
 */
function liveScene({
  dm = false,
  talk = () => '<msg>ok</msg>',
  split,
  merge,
  labels: ownLabels = labels,
  config: overrides = {},
}: {
  dm?: boolean;
  talk?: Untyped;
  split?: Untyped;
  merge?: Untyped;
  labels?: Untyped;
  config?: Record<string, Untyped>;
} = {}) {
  freshWorld();
  const config = baseConfig(
    deepMerge(
      {
        // PR 7d: the switches are code, features.privateMessages is dm.enabled, and the split measures are constants.
        dm: { enabled: true },
        // The typing imitation is code too: no pause, so the turns of a chain follow each other at once.
        typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
        split: { maxOutputTokens: 50 },
        mention: { maxPending: 6, pendingMinutes: 10 },
      },
      overrides
    )
  );
  const prompts = {
    main: 'SYSTEM',
    persona: 'CARD',
    rules: 'RULES',
    format: 'FORMAT',
    'turn/reply': 'Reply to {{author}}.',
    labels: ownLabels,
    ...(split !== undefined ? { 'classify/split': 'Split for {{name}}, at most {{maxTasks}}.' } : {}),
    ...(merge !== undefined ? { 'classify/merge': 'Merge for {{name}}.' } : {}),
  };
  const hot = { config, prompts };
  const calls: Record<string, Array<Untyped>> = { talk: [], split: [], merge: [] };
  const answer = async (spec: Record<string, Untyped>, index: number) => {
    const value = typeof spec === 'function' ? await spec(index) : spec;
    if (value instanceof Error) throw value;
    return { text: value, usage: {}, estimated: 10 };
  };
  const llm = {
    complete: async (messages: Array<Record<string, Untyped>>, options: Record<string, Untyped>) => {
      const kind = options?.purpose === 'split' ? 'split' : options?.purpose === 'merge' ? 'merge' : 'talk';
      calls[kind].push(wrongly({ messages, options }));
      const spec = kind === 'split' ? split : kind === 'merge' ? merge : talk;
      return answer(spec, calls[kind].length - 1);
    },
  };
  let t = LIVE_T0;
  const now = () => t;
  const history: Array<Untyped> = [];
  const client = fakeDmClient();
  const store: Record<string, Untyped> = fakePrivateStore();
  store.state.markDirty = () => {};
  const guild = dm ? null : { id: 'g1', members: { me: { displayName: 'Ζωή' } }, channels: { cache: new Map() } };
  world().knowMembers('g1', client.knows);
  const channel = dm
    ? fakeDmChannel('dm1', 'u1')
    : fakeChannel('c1', guild, { name: 'general', sendTyping: async () => {} });
  world().follow(channel.id, history);
  const tagHistory = countingTagHistory();
  const turns = createTurnRunner(
    wrongly(
      runnerOptions({
        hot,
        store,
        llm,
        calibrator: { ratio: 1, apply: (n: string) => n, observe: () => {} },
        now,
        schedule: () => () => {},
      })
    )
  );
  const handler = asDiscordEvents(
    createMessageHandler(
      wrongly({
        hot,
        store,
        reads: world().reads,
        selfId: () => client.user.id,
        getSelfName: () => 'Ζωή',
        port: world().port,
        turns,
        spontaneous: fakeSpontaneous(),
        memory: fakeMemory(),
        tagHistory,
        isServedRoot: (id: unknown) => id === 'g1',
        llm,
        rng: () => 0.5,
        now,
        sleep: async () => {},
      })
    ),
    hot,
    client
  );
  turns.setOnIdle(() => handler.drainPending());
  /** A call of `authorId` (a mention on the server, any DM in private), one second after the last. */
  const call = async (id: string, authorId: Untyped, content: string) => {
    t += 1000;
    const author = { id: authorId, bot: false, globalName: LIVE_NAMES[authorId], username: LIVE_NAMES[authorId] };
    const message = fakeMessage({
      id,
      guild,
      channel,
      placeId: channel.id,
      author,
      member: dm ? null : { displayName: LIVE_NAMES[authorId] },
      cleanContent: content,
      createdTimestamp: t,
      mentions: { users: new Map(dm ? [] : [['self1', { id: 'self1' }]]) },
    });
    history.push(message);
    await handler(message);
  };
  return { calls, call, store, turns, handler, tagHistory };
}

/** A talk answer that holds the first talk request until `open()`. */
function heldFirst() {
  let open: Untyped;
  const held = new Promise((resolve) => {
    open = resolve;
  });
  const talk = (index: number) => (index === 0 ? held.then(() => '<msg>ok</msg>') : '<msg>ok</msg>');
  return { talk, open: () => open() };
}

/** The `<task>` block of a talk request. */
function liveTask(call: Record<string, Untyped>) {
  const secondMessage = call.messages[1];
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(userText(secondMessage.content))?.[1] ?? '';
}

/** Who each talk request answered: the author its task names. */
function answeredAuthors(calls: Record<string, Untyped>) {
  return calls.talk.map(
    (call: Array<Record<string, Untyped>>) => /^Reply to ([^.]+)\./.exec(liveTask(call))?.[1] ?? null
  );
}
describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  // The lead: split, merge and missed answer in strict JSON.
  test('events: a message with several requests is answered part by part; a call arriving mid-chain waits and is answered after the last part', async () => {
    // The call that arrives meanwhile: the same author's (it has the parts to be folded into; no
    // merge prompt here, so it is new) or another member's.
    for (const [authorId, name] of table([
      ['u1', 'Alice'],
      ['u2', 'Léa'],
    ])) {
      const { talk, open } = heldFirst();
      const scene = liveScene({ talk, split: JSON.stringify({ parts: LIVE_PARTS }) });
      const { talk: talkCalls } = scene.calls;
      const { logs } = await withLiveLogs(async (logs: Array<Record<string, Untyped>>) => {
        await scene.call('m1', 'u1', LIVE_SPLIT);
        await tickUntil(() => talkCalls.length === 1);
        await scene.call('m2', authorId, 'και κάτι άλλο');
        await tickUntil(() => logs.some((line) => line.msg === 'mention: deferred'));
        open();
        await tickUntil(() => talkCalls.length === 4);
      });

      const { split } = scene.calls;
      assert.equal(split.length, 1, `${name}: the splitter is asked for the long call only`);
      assert.deepEqual(answeredAuthors(scene.calls), ['Alice', 'Alice', 'Alice', name], `${name}: after the last part`);
      const { talk: talkValue } = scene.calls;
      assert.deepEqual(
        talkValue
          .slice(0, 3)
          .map((call, i) =>
            liveTask(call).includes(
              fill(labels.task.part, { index: i + 1, total: 3, part: LIVE_PARTS[i], others: '' }).split('\n')[0]
            )
          ),
        [true, true, true]
      );
      assert.deepEqual(
        logs.filter((line) => line.msg === 'turn: part').map((line) => line.outcome),
        ['spoke', 'spoke', 'spoke']
      );
      // The ignore roll: once for the split message, once for the queued call.
      assert.deepEqual(
        logs.filter((line) => line.msg === 'mention: decided').map((line) => line.author),
        ['u1', authorId]
      );
      assert.equal(scene.tagHistory.hits, 2);
      assert.equal(
        logs.filter((line) => line.msg === 'mention: already answered').length,
        0,
        `${name}: not dropped as seen by a later part`
      );
    }
  });

  // The lead: split, merge and missed answer in strict JSON.
  test("events: a call the merge classifier folds into a waiting call gets no turn; that call's turn names it", async () => {
    const { talk, open } = heldFirst();
    const scene = liveScene({ talk, merge: '{"item":1}' });
    const { talk: talkCalls, merge: mergeCalls } = scene.calls;
    const { logs } = await withLiveLogs(async (logs: Array<Record<string, Untyped>>) => {
      await scene.call('m1', 'u1', 'ένα');
      await tickUntil(() => talkCalls.length === 1);
      await scene.call('m2', 'u1', 'ποιος είναι ο Νίκος;');
      await scene.call('m3', 'u1', 'λοιπόν, ο Νίκος;');
      await tickUntil(() => mergeCalls.length === 1);
      await tickUntil(() => logs.some((line) => line.msg === 'merge: verdict'));
      open();
      await tickUntil(() => talkCalls.length === 2);
      await tickUntil(() => false, 50);
    });

    const { talk: talkValue } = scene.calls;
    assert.equal(talkValue.length, 2, 'm3 has no turn of its own');
    assert.ok(liveTask(talkValue[1]).endsWith(fill(labels.task.added, { added: 'λοιπόν, ο Νίκος;' })));
    const [merge] = scene.calls.merge;
    const firstMessage = merge.messages[0];
    assert.equal(firstMessage.content, 'Merge for Ζωή.');
    const secondMessage = merge.messages[1];
    assert.equal(
      secondMessage.content,
      '<waiting>\n1. ποιος είναι ο Νίκος;\n</waiting>\n<candidate>\nAlice: λοιπόν, ο Νίκος;\n</candidate>'
    );
    assert.partialDeepStrictEqual(merge.options, { role: 'analyzer', purpose: 'merge', isRoleRequest: true });
    const verdict = logs.find((line) => line.msg === 'merge: verdict');
    assert.deepEqual(
      [verdict.channel, verdict.waiting, verdict.answer, typeof verdict.ms],
      ['c1', 1, 'item', 'number']
    );
    // Plan 2026-11-04-cli-and-memory B1: the rail counts started turns, and a folded call starts none.
    assert.equal(scene.tagHistory.hits, 2, 'the folded call starts no turn, so it is not counted');
    assert.deepEqual(
      logs.filter((line) => line.msg === 'mention: decided').map((line) => line.author),
      ['u1', 'u1'],
      'one roll per answered call'
    );
  });

  // The lead: split, merge and missed answer in strict JSON.
  test('events: a merge classifier that says new, fails or is missing leaves the call its own turn', async () => {
    for (const merge of ['{"item":null}', Object.assign(new Error('down'), { statusCode: 503 }), 'maybe', undefined]) {
      const { talk, open } = heldFirst();
      const scene = liveScene({ talk, merge });
      const { talk: talkCalls } = scene.calls;
      const { logs } = await withLiveLogs(async (logs: Array<Record<string, Untyped>>) => {
        await scene.call('m1', 'u1', 'ένα');
        await tickUntil(() => talkCalls.length === 1);
        await scene.call('m2', 'u1', 'δύο');
        await scene.call('m3', 'u1', 'τρία');
        await tickUntil(() => logs.filter((line) => line.msg === 'mention: deferred').length === 2);
        open();
        await tickUntil(() => talkCalls.length === 3);
      });
      const { talk: talkValue } = scene.calls;
      assert.equal(talkValue.length, 3, String(merge));
      if (merge === '{"item":null}') assert.equal(logs.find((line) => line.msg === 'merge: verdict').answer, 'new');
      else
        assert.ok(
          logs.some((line) => line.msg === 'merge: failed'),
          String(merge)
        );
    }
  });

  // The lead: split, merge and missed answer in strict JSON.
  test("events: a call folded into a part of a running chain reaches that part's request", async () => {
    const { talk, open } = heldFirst();
    const scene = liveScene({ talk, split: JSON.stringify({ parts: LIVE_PARTS }), merge: '{"item":1}' });
    const { talk: talkCalls } = scene.calls;
    const { logs } = await withLiveLogs(async (logs: Array<Record<string, Untyped>>) => {
      await scene.call('m1', 'u1', LIVE_SPLIT);
      await tickUntil(() => talkCalls.length === 1);
      await scene.call('m2', 'u1', 'και το κανάλι;');
      await tickUntil(() => logs.some((line) => line.msg === 'merge: verdict'));
      open();
      await tickUntil(() => talkCalls.length === 3);
      await tickUntil(() => false, 50);
    });
    const { talk: talkValue } = scene.calls;
    assert.equal(talkValue.length, 3, 'no turn of its own');
    const { merge } = scene.calls;
    const { messages } = merge[0];
    const { content } = messages[1];
    assert.equal(content.split('\n</waiting>')[0], `<waiting>\n1. ${LIVE_PARTS[1]}\n2. ${LIVE_PARTS[2]}`);
    const { talk: talkValue3 } = scene.calls;
    assert.ok(liveTask(talkValue3[1]).endsWith(fill(labels.task.added, { added: 'και το κανάλι;' })));
    const { talk: talkValue4 } = scene.calls;
    assert.equal(liveTask(talkValue4[2]).includes('και το κανάλι;'), false);
  });

  // The lead: split, merge and missed answer in strict JSON.
  test('private: DMs queue and fold the same way', async () => {
    const { talk, open } = heldFirst();
    // The first merge call: `new`; the second folds into item 3 (parts 2 and 3, then the queued DM).
    const merge = (index: number) => (index === 0 ? '{"item":null}' : '{"item":3}');
    const scene = liveScene({ dm: true, talk, split: JSON.stringify({ parts: LIVE_PARTS }), merge });
    const { talk: talkCalls, merge: mergeCalls } = scene.calls;
    await withLiveLogs(async (logs: Array<Record<string, Untyped>>) => {
      await scene.call('dm-1', 'u1', LIVE_SPLIT);
      await tickUntil(() => talkCalls.length === 1);
      await scene.call('dm-2', 'u1', 'και κάτι άλλο');
      await tickUntil(() => logs.some((line) => line.msg === 'mention: deferred'));
      await scene.call('dm-3', 'u1', 'λοιπόν;');
      await tickUntil(
        () => mergeCalls.length === 2 && logs.filter((line) => line.msg === 'merge: verdict').length === 2
      );
      open();
      await tickUntil(() => talkCalls.length === 4);
    });
    const { talk: talkValue } = scene.calls;
    assert.equal(talkValue.length, 4, 'three parts, then the queued DM; the folded one has no turn');
    assert.ok(liveTask(talkValue[3]).endsWith(fill(labels.task.added, { added: 'λοιπόν;' })));
  });
});

// Every shipped prompt is filled by its builder. Each request the bot can send is built here
// from the TRACKED layer -- prompts/*.md and prompts/labels.json read the way src/hot.ts reads
// them for a deployment without prompts.local/, and config.json without config.local.json --
// through the builder or the factory that sends it, with fakes only at the edges (no network,
// no data/, no real Discord, no model). Every request must leave no `{{placeholder}}` and no
// label `{key}` unfilled, must carry each prompt file it loads whole, and must render the blocks
// its labels head; together the requests load every tracked prompt file. A placeholder added to
// a prompt without a filler, a filler dropped from a builder, a prompt file no builder sends or
// a label key missing from labels.json fails here instead of reaching the model as literal text.
// The switches a request needs (the web lookup, video vision) are
// turned on per test; every number comes from the shipped config.json.

const worldChannelsOf = (channels: Parameters<typeof worldChannels>[1]) => worldChannels(GUILD, channels);

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];
const promptsShippedCreateMessageHandler = loose(createMessageHandlerOf);

// ---- the shipped layer --------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROMPTS_DIR = path.join(ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};
// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof contractLabels;

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES: Record<string, { literal: string; why: string }> = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text: string) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

// The rules prompt reaches a request only while the memory table `rules` holds a rule (src/rules-list.ts). The requests
// here are built with no memory, the way a deployment starts, so it stays in NOT_BUILT: putting it in SYSTEM would mean
// a rule in every fixture, and tests/src/rules-list.test.ts already checks the block with and without one.
const SYSTEM = ['main', 'persona', 'format'];

/** Every kind of diary entry and the prompt file of its own task, which follows the common `diary/task.md`. */
const DIARY_KIND_FILES: Record<string, string> = Object.fromEntries(
  ['story', 'selfPicture', 'picture', 'photoset', 'randomSet', 'news', 'facts', 'thought', 'people', 'meme'].map(
    (kind) => [kind, `diary/kinds/${kind}`]
  )
);

/** The prompt files each request below must carry whole, by request. */
const LOADS = {
  reply: [...SYSTEM, 'turn/reply'],
  followUp: [...SYSTEM, 'turn/follow'],
  overheard: [...SYSTEM, 'turn/overheard'],
  errandResult: [...SYSTEM, 'turn/errand'],
  private: [...SYSTEM, 'turn/reply', 'turn/private'],
  draw: ['draw', 'appearance'],
  ...Object.fromEntries(
    Object.entries(DIARY_KIND_FILES).map(([kind, file]) => [`diary ${kind}`, [...SYSTEM, 'diary/task', file]])
  ),
  inner: [...SYSTEM, 'turn/inner'],
  heartbeat: [...SYSTEM, 'heartbeat/task'],
  describe: ['describe/picture'],
  avatar: ['describe/avatar'],
  describeGif: ['describe/gif'],
  describeVideo: ['describe/video'],
  rewatchAnswer: ['describe/rewatch'],
  searchSummary: ['summarize/search'],
  split: ['classify/split'],
  merge: ['classify/merge'],
  missed: ['classify/missed'],
  mediaPick: ['classify/pick'],
  humanizer: ['humanizer/linter', 'humanizer/editor'],
  turn: [...SYSTEM, 'turn/reply'],
};

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides: Record<string, unknown> = {}) {
  const on = {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video', drawing: 'x/drawing', speech: 'x/speech' }) },
  }; // off when shipped
  return deepMerge(deepMerge(structuredClone(SHIPPED.config), on), overrides);
}

/** A live view over the shipped layer, the config overridden as given. */
function shippedHot(overrides: Record<string, unknown> = {}) {
  return { config: shippedConfig(overrides), prompts: SHIPPED.prompts };
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function contentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function requestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => contentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name: string) {
  const text = (SHIPPED.prompts as Record<string, unknown>)[name] as string;
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(
  messages: unknown,
  { files = [], blocks = [] }: { files?: Array<string>; blocks?: Array<string> },
  where: string
) {
  assert.ok(Array.isArray(messages) && messages.length > 0, `${where}: no request was built`);
  const text = requestText(messages);
  assert.deepEqual(strayPlaceholders(text), [], `${where}: a placeholder reached the request unfilled`);
  assert.deepEqual(strayLabelKeys(text), [], `${where}: a label placeholder reached the request unfilled`);
  for (const name of files) {
    const missing = literalLines(name).filter((line) => !text.includes(line));
    assert.equal(
      missing.length,
      0,
      `${where}: prompts/${name}.md is not carried whole, e.g. ${JSON.stringify(missing.slice(0, 2))}`
    );
  }
  for (const tag of blocks) {
    if (tag === 'tempo') {
      // Slice 2 (g): `<tempo>` is the foot of `<chat>`, not a block, so its verdict line ends the chat's body.
      const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
      const verdict = labelHead(LABELS.tempo.verdict);
      assert.ok(chat.split('\n').at(-1)?.startsWith(verdict), `${where}: no tempo at the foot of <chat>`);
      continue;
    }
    assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  }
  return text;
}

// ---- the scene: one server, its members and channels --------------------------------

const PROMPTS_SHIPPED_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const GUILD = '600000000000000001';
const SELF_ID = '900000000000000001';
const SELF_NAME = 'Zoë';
const ANA = '411111111111111111';
const NIKOS = '422222222222222222';
const BJORN = '433333333333333333';
const GENERAL = '700000000000000001';
const GARDEN = '700000000000000002';
const DIARY = '700000000000000003';
const CHANNEL_INCREMENT: Record<string, bigint> = { [GENERAL]: 1n, [GARDEN]: 2n, [DIARY]: 3n };

const PEOPLE = {
  [ANA]: { id: ANA, name: 'Ana' },
  [NIKOS]: { id: NIKOS, name: 'Nikos' },
  [BJORN]: { id: BJORN, name: 'Björn' },
  [SELF_ID]: { id: SELF_ID, name: SELF_NAME },
};

/**
 * A discord.js-shaped message, enough for normalizeMessage: `author` a PEOPLE entry, media as
 * plain lists (attachments `{ id, name, contentType, url, size?, duration? }`, embeds as Discord
 * sends them, stickers `{ id, name, format }`, reactions `{ name, id?, count, me? }`).
 */
function rawMessage(
  channel: { id: string; name: string | null; category?: string | null; topic?: string | null },
  {
    ts,
    author,
    content = '',
    attachments = [],
    embeds = [],
    stickers = [],
    reactions = [],
    replyTo = null,
    mentions = [],
    forwarded = null,
  }: {
    ts: number;
    author: { id: string; name: string };
    content?: string;
    attachments?: Array<{ id: string; [key: string]: unknown }>;
    embeds?: Array<unknown>;
    stickers?: Array<{ id: string; [key: string]: unknown }>;
    reactions?: Array<{ name: string; id?: string; count: number; me?: boolean }>;
    replyTo?: string | null;
    mentions?: Array<string>;
    forwarded?: string | null;
  }
) {
  // The same id on every call: the time, and the channel as the increment.
  const id = SnowflakeUtil.generate({ timestamp: ts, increment: CHANNEL_INCREMENT[channel.id] ?? 0n }).toString();
  return {
    id,
    channelId: channel.id,
    channel: {
      name: channel.name,
      parent: channel.category ? { name: channel.category } : null,
      topic: channel.topic ?? null,
    },
    guild: null,
    author: { id: author.id, bot: false, globalName: author.name, username: author.name },
    member: { displayName: author.name },
    content,
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyTo ? { messageId: replyTo } : null,
    attachments: new Map(attachments.map((a) => [a.id, a])),
    embeds,
    stickers: new Map(stickers.map((s) => [s.id, s])),
    messageSnapshots: new Map(
      forwarded
        ? [
            [
              'fwd',
              { content: forwarded, cleanContent: forwarded, attachments: new Map(), embeds: [], stickers: new Map() },
            ],
          ]
        : []
    ),
    mentions: { users: new Map(mentions.map((accountId) => [accountId, { id: accountId }])) },
    reactions: {
      cache: new Map(
        reactions.map((r, i) => [
          String(i),
          { emoji: { name: r.name, id: r.id ?? null }, count: r.count, me: r.me ?? false },
        ])
      ),
    },
    flags: { has: () => false },
  };
}

const GENERAL_INFO = { id: GENERAL, name: 'général', category: 'Café', topic: 'tout et rien' };

const GIF_EMBED = {
  url: 'https://tenor.com/view/cat-wave-123',
  provider: { name: 'Tenor' },
  thumbnail: { url: 'https://media.tenor.com/cat.png' },
  video: { url: 'https://media.tenor.com/cat.mp4' },
};
const PAGE_EMBED = {
  url: 'https://example.org/tomates',
  title: 'Tomates en pot',
  description: 'Comment cultiver des tomates sur un balcon',
};

/** The chat of #général the turn answers, oldest first: every kind of media the transcript renders. */
function generalRaws() {
  const at = (minutes: number) => PROMPTS_SHIPPED_NOW - minutes * MINUTE_MS;
  const raws: Array<ReturnType<typeof rawMessage>> = [];
  const add = (fields: Parameters<typeof rawMessage>[1]) => {
    const raw = rawMessage(GENERAL_INFO, fields);
    raws.push(raw);
    return raw;
  };
  add({
    ts: at(55),
    author: PEOPLE[NIKOS],
    content: 'bonjour à tous, la tomate a gelé',
    reactions: [
      { name: '🍅', count: 3 },
      { name: 'zoe_wave', id: 'E1', count: 1, me: true },
    ],
  });
  const own = add({ ts: at(50), author: PEOPLE[SELF_ID], content: 'oh non, pauvre tomate' });
  add({
    ts: at(45),
    author: PEOPLE[BJORN],
    content: 'la preuve',
    attachments: [
      {
        id: '800000000000000001',
        name: 'photo.png',
        contentType: 'image/png',
        url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
        size: 2000,
      },
    ],
  });
  add({
    ts: at(40),
    author: PEOPLE[NIKOS],
    content: 'regardez https://tenor.com/view/cat-wave-123',
    embeds: [GIF_EMBED],
  });
  const video = add({
    ts: at(35),
    author: PEOPLE[ANA],
    content: 'une vidéo des oranges',
    attachments: [
      {
        id: '800000000000000002',
        name: 'oranges.mp4',
        contentType: 'video/mp4',
        url: 'https://cdn.discordapp.com/attachments/1/2/oranges.mp4',
        size: 90000,
        duration: 20,
      },
    ],
  });
  add({ ts: at(30), author: PEOPLE[BJORN], content: 'un article https://example.org/tomates', embeds: [PAGE_EMBED] });
  add({
    ts: at(26),
    author: PEOPLE[ANA],
    content: '',
    stickers: [{ id: '810000000000000001', name: 'tomato_dance', format: 1 }],
  });
  add({
    ts: at(22),
    author: PEOPLE[NIKOS],
    content: 'mes graines',
    attachments: [
      {
        id: '800000000000000003',
        name: 'graines.txt',
        contentType: 'text/plain',
        url: 'https://cdn.discordapp.com/attachments/1/2/graines.txt',
        size: 40,
      },
    ],
  });
  add({ ts: at(18), author: PEOPLE[BJORN], content: 'vu ailleurs', forwarded: 'le gel arrive mardi' });
  add({ ts: at(14), author: PEOPLE[SELF_ID], content: 'jolie vidéo', replyTo: video.id });
  add({ ts: at(10), author: PEOPLE[NIKOS], content: 'Zoë, tu as aimé ?', replyTo: own.id });
  add({
    ts: at(2),
    author: PEOPLE[ANA],
    content: '@Zoë de quelle couleur sont les oranges dans la vidéo ? et quand gèle la tomate ?',
    mentions: [SELF_ID],
  });
  return raws;
}

/** The guild of a message the pipeline reads: its id and the persona's name there. */
const MESSAGE_GUILD = { id: GUILD, members: { me: { displayName: SELF_NAME } } };

/** A fake `llm.complete` recording every request and answering `answer(messages, options)`. */
function recordingLlm(answer: (messages: Array<{ content: unknown }>, options: { purpose?: string }) => unknown) {
  const calls: Array<{ messages: Array<{ content: unknown }>; options: { purpose?: string }; text: string }> = [];
  return {
    calls,
    complete: async (messages: Array<{ content: unknown }>, options: { purpose?: string } = {}) => {
      calls.push({ messages, options, text: requestText(messages) });
      const text = await answer(messages, options);
      return { text, usage: { prompt_tokens: 100, completion_tokens: 10 }, estimated: 100, finishReason: 'stop' };
    },
  };
}
describe('shipped prompts', () => {
  before(() => {
    useIface('fake');
    useSelf('900000000000000001');
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
  });

  // The lead: split, merge and missed answer in strict JSON.
  test('createMessageHandler: the merge classifier fills classify/merge.md', async () => {
    const hot = shippedHot();
    worldChannelsOf([[GENERAL_INFO, generalRaws()]]);
    const line = rawMessage(GENERAL_INFO, {
      ts: PROMPTS_SHIPPED_NOW - MINUTE_MS,
      author: PEOPLE[ANA],
      content: 'alors, le canal ?',
      mentions: [SELF_ID],
    });
    Object.assign(line, { guild: MESSAGE_GUILD, system: false, webhookId: null });
    const folded = [];
    // The persona is busy with Ana's split message: its second part still waits.
    const turns = {
      notePost() {},
      runTurn: async () => ({ outcome: 'skip' }),
      isBusy: () => false,
      isAnyBusy: () => true,
      lastPostAt: () => 0,
      waitingParts: () => [{ index: 2, text: 'regarde le canal du jardin' }],
      addToPart: (...args: Array<unknown>) => folded.push(args) > 0,
    };
    // Plan 2026-11-04-cli-and-memory B1: a flagged line asks the address classifier first.
    const llm = recordingLlm((_messages, options) => (options.purpose === 'address' ? 'yes' : '{"item":1}'));
    const handler = promptsShippedCreateMessageHandler({
      hot,
      store: { state: { data: {}, markDirty() {} }, getUser: () => null },
      reads: world().reads,
      selfId: () => SELF_ID,
      port: world().port,
      turns,
      spontaneous: { onMessage: () => false },
      memory: { observe() {} },
      tagHistory: createTagHistory(),
      isServedRoot: (id: unknown) => id === GUILD,
      getSelfName: () => SELF_NAME,
      llm,
      rng: () => 0.5,
      now: () => PROMPTS_SHIPPED_NOW,
      sleep: async () => {},
    });

    await withCapturedLogs(async () => {
      await handler(
        onWorldIface(toEvent(line, SELF_ID, normalizeOptions(hot.config))) as Parameters<typeof handler>[0]
      );
      for (let i = 0; i < 20 && folded.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    });

    const merges = llm.calls.filter((call) => call.options.purpose === 'merge');
    assert.equal(merges.length, 1, 'one merge request');
    assertFilled(merges[0].messages, { files: LOADS.merge, blocks: ['waiting', 'candidate'] }, 'merge');
    assert.equal(folded.length, 1, 'folded into the waiting part');
  });
});

// Public turn context, split-chain merging and private journal boundaries.

const DISCORD = createDiscordInterface().capabilities;

for (const replacement of ['author', 'shorter'] as const) {
  // The lead: split, merge and missed answer in strict JSON.
  test(`a delayed merge queues its message when a replacement chain has ${replacement === 'author' ? 'a different author' : 'fewer parts'}`, async () => {
    const decision = Promise.withResolvers<{ text: string }>();
    const pending: PendingQueue = { list: [] };
    const incomingText = 'delayed-followup-evidence';
    const incoming: Line = {
      id: 'late-followup',
      placeId: 'c1',
      authorId: 'u1',
      authorName: 'Member',
      content: incomingText,
      ts: FAKE_NOW,
      replyToId: null,
      mentionedAccountIds: [],
    };
    const mergeChannel = channelInfo('c1');
    const llm = splitLlm({
      split: (index) =>
        index === 1 && replacement === 'shorter' ? JSON.stringify({ parts: SPLIT_PARTS.slice(0, 2) }) : PARTS_ANSWER,
      talk: async (index) => {
        if (index === 0) merge.holdCall(mergeChannel, incoming, 'mention');
        if (index === 3) {
          decision.resolve({ text: replacement === 'shorter' ? '{"item":2}' : '{"item":1}' });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return '<msg>part complete</msg>';
      },
    });
    const turns = createFixtureTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: splitHot(),
      store: fakeStore(),
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      lookup: fakeLookup(),
      now: () => FAKE_NOW,
      schedule: manualSchedule(),
    });
    const pipelineTurns: PipelineTurns = {
      isBusy: () => true,
      isAnyBusy: () => true,
      runTurn: () => Promise.resolve({ outcome: 'busy' }),
      notePost() {},
      waitingParts: turns.waitingParts,
      addToPart: turns.addToPart,
    };
    const hot = {
      config: {
        bot: { timezone: 'UTC' },
        mention: { neverIgnore: [], repeatWindowMinutes: 0, maxPending: 10 },
        models: { routes: chainsOf({ analyzer: 'test/analyzer' }) },
        llm: { maxRequestTokens: 50000, maxRequestsPerDay: 100, timeoutMs: 1000 },
      },
      prompts: { labels, 'classify/merge': 'Choose an item or new. {{items}} {{message}}' },
    };
    const queue = createPendingQueue({
      hot,
      now: () => FAKE_NOW,
      turns: pipelineTurns,
      missed: null,
      pending,
      followUpMuted: () => null,
    });
    const merge = createMerge({
      hot,
      now: () => FAKE_NOW,
      turns: pipelineTurns,
      store: { state: { data: {} } },
      pending,
      llm: { complete: () => decision.promise },
      getSelfName: () => 'Persona',
      itemText: queue.itemText,
      enqueuePending: queue.enqueuePending,
      turnBlocked: () => true,
      drainPending: async () => {},
    });
    const first = turnMemoryContextRawMessage({ id: 'first-chain', content: SPLIT_TEXT, ts: FAKE_NOW - 1000 });
    const second = turnMemoryContextRawMessage({
      id: 'replacement-chain',
      content: SPLIT_TEXT,
      ts: FAKE_NOW,
      authorId: replacement === 'author' ? 'u2' : 'u1',
    });
    const channel = fakeTurnChannel({ historyMessages: [first, second] });
    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(first), triggerKind: 'mention' });
    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(second), triggerKind: 'mention' });
    const { talk } = llm.calls;
    assert.equal(talk.length, replacement === 'shorter' ? 5 : 6);
    assert.deepEqual(
      pending.list.map((ping) => ping.trigger.id),
      ['late-followup']
    );
    const { talk: talkValue } = llm.calls;
    assert.equal(
      talkValue.some((request) => taskOf(request).includes(incomingText)),
      false
    );
  });
}
