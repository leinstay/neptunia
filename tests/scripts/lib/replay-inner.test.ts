// Tests for scripts/lib/replay-inner.ts, the `--inner` mode of scripts/replay.ts: the hot it runs with (shadow forced,
// no dry run, no journal), the wake it builds from the inner state read, its report, its hidden places, the heartbeat
// it runs over a fixture data folder, and the record and the journal it hands the inner life. The mode itself needs
// Discord and a key, so no case runs it whole.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  heartbeatReplayWake,
  hiddenPlaces,
  hiddenRecord,
  hideSetsOf,
  innerAnswerOf,
  innerReplayHot,
  innerReplayWake,
  innerReportMarkdown,
  innerSampleRng,
  innerSourcesOf,
  innerTurnRunner,
} from '../../../scripts/lib/replay-inner.ts';
import '../../../src/tools/operations/index.ts';
import { parseOutput } from '../../../src/llm/parse.ts';
import { answerOf } from '../../../src/behavior/turn.ts';
import { call as toolCall } from '../../fixtures/tool-answers.ts';
import * as inner from '../../../src/behavior/inner.ts';
import { useIface, world } from '../../fixtures/turn-world.ts';
import { asRecord } from '../../fixtures/records.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createIntention } from '../../../src/intentions/model.ts';
import { createIntentionStores } from '../../../src/intentions/store.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { MARK, SERVICE_CONTEXT, TURN_NOW, blockOf, serviceWake, serviceWorld } from '../../fixtures/service-turn.ts';
import { openTestMemory, openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { legacyServerPlaceId } from '../../fixtures/memory-db/legacy-paths.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { createRecord, toRecordLine } from '../../../src/memory/record.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { chainsOnDefaults } from '../../fixtures/chains.ts';
import { completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { sampleFacts, turnEndOf } from '../../../scripts/lib/inner-summary.ts';
import { parseErrandAnswers } from '../../../scripts/lib/errand-answers.ts';

type Rec = Record<string, unknown>;

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// The chats the scheduler runs in are held by a fake interface named `fake`.
useIface('fake');

const NOW = Date.parse('2026-10-19T12:00:00Z');

// The replay has no switches and no dry run, so it forces the shadow mode alone.
test('innerReplayHot: shadow forced; the live config untouched', () => {
  const live = { config: { bot: { timezone: 'UTC' }, wakes: { mode: 'live', tickSeconds: 7 } }, prompts: {} };
  const config = innerReplayHot(live).config;
  assert.equal(config.wakes.mode, 'shadow');
  assert.equal(config.wakes.tickSeconds, 7);
  const liveConfig = live.config;
  assert.equal(liveConfig.wakes.mode, 'live');
});
test("innerReplayWake: the scheduler's wake for the intention", () => {
  const settings = inner.innerSettings({});
  const state = { ...inner.emptyState(), turns: [{ at: NOW - 60_000, chainId: 'intention:i1', usd: 0.2 }] };
  const intention = {
    id: 'i1',
    status: 'pending',
    purpose: 'p',
    dueAt: NOW - 5_000,
    provenance: { placeId: 'c1', scope: 'group' },
  };
  const { wake, info } = innerReplayWake({
    inner,
    kind: 'intention_due',
    intention,
    state,
    settings,
    now: NOW,
    timezone: 'UTC',
    day: '2026-10-19',
  });
  assert.equal(asRecord(wake).id, `inner.wake:intention_due:i1:${NOW - 5_000}`);
  assert.deepEqual(asRecord(info).items, [
    { kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null },
  ]);
  // The replayed wake carries no budgets.
  assert.equal(asRecord(info).budgets, undefined);
});

// The fixtures' directories, removed when the file ends, so a test file leaves no temp directory behind.
const fixtureDirs: Array<string> = [];
after(() => {
  for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function heartbeatFixture({ stopped = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-data-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-tmp-'));
  fixtureDirs.push(dataDir, tmpRoot);
  // The persona's state, where src/behavior/inner/queue.ts keeps it (the replay read a per-server path no one writes).
  const stateFile = path.join(dataDir, 'persona', 'inner.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const kept = JSON.stringify({
    ...inner.emptyState(),
    stopped,
    heartbeat: { nextAt: NOW - 1000, lastAt: NOW - 3 * 3_600_000 },
    facts: [{ id: 'f1', kind: 'errand_done', placeId: null, dmChat: false, at: NOW - 60_000, told: false }],
  });
  fs.writeFileSync(stateFile, kept);
  world().channel({ id: 'c1', name: 'general', placeId: 'g1' });
  const record = {
    iterate: async function* iterate() {
      yield { kind: 'said', occurredAt: new Date(NOW - 3_600_000).toISOString(), scope: { channel: 'c1' } };
    },
  };
  const deps = {
    record,
    reads: world().reads,
    iface: () => 'fake',
    store: { state: { data: {} }, listUserProfiles: () => [], getDiary: () => ({ posts: [] }) },
    nameOf: () => null,
  };
  const hot = {
    config: { bot: { timezone: 'UTC' }, features: { wakes: true }, wakes: { mode: 'shadow' } },
    prompts: {},
  };
  return { dataDir, tmpRoot, stateFile, kept, deps, hot };
}

test("heartbeatReplayWake: the scheduler's heartbeat wake and chat, read only, the throwaway state removed", async () => {
  const fx = heartbeatFixture({ stopped: true });
  const { info, chat, currentChannel } = await heartbeatReplayWake({
    inner,
    hot: fx.hot,
    dataDir: fx.dataDir,
    now: NOW,
    deps: fx.deps,
    tmpRoot: fx.tmpRoot,
  });
  assert.equal(asRecord(info).kind, 'heartbeat');
  assert.deepEqual(
    asRecord(info).items.map((item: Untyped) => item.kind),
    ['heartbeat']
  );
  assert.equal(asRecord(info).chainId, `heartbeat:${NOW}`);
  assert.equal(asRecord(info).now, NOW);
  // A service runs nowhere, so the wake has no chat.
  assert.equal(chat, null);
  assert.equal(currentChannel, null, 'a heartbeat has no current channel');
  assert.deepEqual(
    (asRecord(info).facts as Array<Rec>).map((fact) => fact.kind),
    ['errand_done'],
    "the persona's stored state is the one the wake is built from"
  );
  assert.equal(fs.readFileSync(fx.stateFile, 'utf8'), fx.kept, 'the data directory is untouched');
  assert.deepEqual(fs.readdirSync(fx.tmpRoot), [], 'the throwaway directory is gone');
});

test('innerAnswerOf and innerReportMarkdown: the think whole, the messages, the calls with their arguments, the cost', () => {
  const text = '<think>STEP 1: a\nSTEP 2: b</think><msg>hello</msg>';
  const answer = innerAnswerOf(text, parseOutput, null, {
    answerOf,
    toolCalls: [toolCall('message.create', { place: 'c1', text: 'body' })],
  });
  assert.equal(answer.think, 'STEP 1: a\nSTEP 2: b');
  assert.deepEqual(answer.messages, ['hello']);
  const firstCall = answer.calls[0];
  assert.equal(firstCall.skill, 'message.create');
  assert.equal(firstCall.args.place, 'c1');
  const markdown = innerReportMarkdown({
    kind: 'heartbeat',
    intention: null,
    placeId: 'c1',
    wake: '<wake>\nfacts\n</wake>',
    request: { blocks: ['wake'] },
    samples: [
      {
        outcome: 'ok',
        reason: null,
        answers: [answer],
        actions: [{ skill: 'message.create', status: 'proposed' }],
        posted: 0,
        usage: { requests: 1, promptTokens: 10, completionTokens: 5, cost: 0.0123 },
      },
    ],
    usage: { requests: 1, promptTokens: 10, completionTokens: 5, cost: 0.0123 },
  });
  for (const part of [
    '# Inner turn: heartbeat',
    '## wake',
    'STEP 2: b',
    '- hello',
    '"place": "c1"',
    'proposed',
    '0.0123 USD',
  ])
    assert.ok(markdown.includes(part), part);
});

test('hiddenRecord: lines of a hidden channel or message are not iterated, the rest passes through', async () => {
  const lines = [
    { kind: 'seen', messageId: '1', scope: { channel: 'c1' }, by: 'u1' },
    { kind: 'seen', messageId: '2', scope: { channel: 'c2' }, by: 'u1' },
    { kind: 'seen', messageId: '3', scope: { channel: 'c1' }, by: 'u2' },
    { kind: 'said', messageId: '4', scope: { channel: 'c1' }, sourceMessageIds: ['3'] },
  ];
  const record = {
    async *iterate() {
      yield* lines;
    },
    other: () => 'kept',
  };
  const hide = hideSetsOf({ hideChannels: ['c2'], hideMessages: ['1'] });
  const seen = [];
  for await (const line of hiddenRecord(record, hide).iterate('g')) seen.push(line.messageId);
  assert.deepEqual(seen, ['3', '4']);
  assert.equal(hiddenRecord(record, hide).other(), 'kept');
  assert.equal(hiddenRecord(record, hideSetsOf({})), record);
});

test('hiddenPlaces drops hidden channels from the list', () => {
  const places = () => [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(hiddenPlaces(places, hideSetsOf({ hideChannels: ['a'] }))('g'), [{ id: 'b' }]);
});

test('innerReportMarkdown prints the hidden ids in the header', () => {
  const md = innerReportMarkdown({
    kind: 'heartbeat',
    placeId: 'c1',
    hidden: { channels: ['11'], messages: ['99', '98'] },
    samples: [],
    usage: {},
  });
  assert.match(md, /Hidden channels: 11/);
  assert.match(md, /Hidden messages: 99, 98/);
});

test('innerAnswerOf and innerReportMarkdown: a failed step is an error step, not an empty answer or a skip', () => {
  const ok = innerAnswerOf('<think>one</think><msg>hi</msg>', parseOutput);
  const errorStep = innerAnswerOf(null, parseOutput, 'provider-limit');
  assert.deepEqual(errorStep.failed, { code: 'provider-limit' });
  assert.equal(errorStep.skip, false);
  assert.equal(ok.failed, undefined);
  const usage = { requests: 2, promptTokens: 1, completionTokens: 1, cost: 0 };
  const markdown = innerReportMarkdown({
    kind: 'heartbeat',
    intention: null,
    placeId: 'c1',
    usage,
    samples: [{ outcome: 'ok', reason: null, answers: [ok, errorStep], actions: [], posted: 0, usage }],
  });
  assert.ok(markdown.includes('### Step 2: error (provider-limit)'));
  assert.ok(markdown.includes('Failed steps: 1 of 2'));
  assert.ok(markdown.includes('ended in error (provider-limit)'));
  const afterFailed = markdown.split('### Step 2')[1].split('actions:')[0];
  assert.ok(!afterFailed.includes('think:') && !afterFailed.includes('skip'));
});

test('innerSampleRng: the same seed and sample give the same draws, another seed or sample others, no seed none', () => {
  const draws = (rng: (() => number) | null) => Array.from({ length: 5 }, () => rng!());
  assert.deepEqual(draws(innerSampleRng('s', 0)), draws(innerSampleRng('s', 0)));
  assert.notDeepEqual(draws(innerSampleRng('s', 0)), draws(innerSampleRng('t', 0)));
  assert.notDeepEqual(draws(innerSampleRng('s', 0)), draws(innerSampleRng('s', 1)));
  assert.equal(innerSampleRng(null, 0), null);
});

// The heartbeat the replay runs is the core's own: the same fixture world as the core's heartbeat tests
// (tests/fixtures/service-turn.ts), written to a data folder the replay reads.
const PROMPTS = {
  main: 'You are a regular member of this chat.',
  persona: 'You are friendly and terse.',
  format: 'Use <msg> and <react> tags.',
  'turn/inner': MARK.inner,
  'heartbeat/task': MARK.heartbeat,
  labels: shippedLabels,
};
const HEARTBEAT_GRANTED = ['conversation.read', 'memory.search', 'intention.set'];
const PURPOSE = 'ΠΡΟΘΕΣΗ-ΓΙΑ-ΤΟΝ-ΚΗΠΟ';

async function heartbeatDataDir(seed: (db: ReturnType<typeof dbOf>) => void = () => {}): Promise<string> {
  const dataDir = tempDir('nep-replay-heartbeat-');
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  serviceWorld({ handle, db: dbOf(handle), close: () => handle.close() });
  seed(dbOf(handle));
  dbOf(handle)
    .prepare('INSERT INTO accounts (id, iface, native_id, person_id, names, kind) VALUES (?, ?, ?, ?, ?, ?)')
    .run('fake:self-id', 'fake', 'self-id', 'person:self', '["Αθηνά"]', 'self');
  handle.close();
  const mem = openTestMemorySync({ dataDir, now: () => TURN_NOW });
  const stores = createIntentionStores({ memoryDb: mem.memoryDb, now: () => TURN_NOW }).get()!;
  const made = createIntention({
    purpose: PURPOSE,
    provenance: { kind: 'self', turnId: 't' },
    now: TURN_NOW - 60_000,
    id: 'i1',
  });
  if (!made.ok) throw new Error(`the fixture intention is refused: ${made.code}`);
  assert.equal(stores.add(made.intention).ok, true);
  await stores.flush();
  mem.close();
  return dataDir;
}

test("a replayed heartbeat reads the persona's lines, memory and intentions as the core turn does, and reads a place it showed", async () => {
  // Bug: the replay composes its own turn runner with no memory database and no memory context, so <memory> is empty,
  // <inner> lacks the persona's day and intentions, and no place the persona names resolves. A heartbeat's request
  // has no <meanwhile> since it lists people and places in <memory>, so the guard reads both places in <places> and a
  // known person in <people>.
  const dataDir = await heartbeatDataDir();
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_NOW });
  port.seedChat({
    iface: 'fake',
    id: 'c2',
    kind: 'channel',
    name: 'κήπος',
    rootId: 'g1',
    topic: null,
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
  });
  const requests: Array<string> = [];
  const llm = {
    complete: (messages: Array<{ content: unknown }>) => {
      const text = messages.map((message) => userText(message.content)).join('\n');
      requests.push(text);
      if (requests.length > 1) return Promise.resolve(completionOf('<skip/>'));
      // The handle the request's `<places>` gives the garden.
      const garden = blockOf(text, 'memory')
        .split('\n')
        .find((line) => line.includes('κήπος'));
      const handle = /^(#[A-Za-z0-9_-]+):/.exec(garden ?? '')?.[1] ?? '#none';
      return Promise.resolve(
        toolAnswer('', [
          toolCall('conversation.read', { place: handle }),
          toolCall('conversation.read', { place: 'κήπος' }),
        ])
      );
    },
  };
  const hot = {
    config: {
      bot: {
        timezone: 'UTC',
        access: Object.fromEntries(
          HEARTBEAT_GRANTED.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])
        ),
      },
      context: SERVICE_CONTEXT,
      llm: { maxRequestTokens: 60000 },
      tools: { resultMaxChars: 2000, callTimeoutMs: 120000 },
      wakes: { mode: 'shadow', loop: { maxSteps: 3 } },
      intentions: { expiresDays: 14, maxOpen: 20 },
    },
    prompts: PROMPTS,
  };
  const { wired } = innerTurnRunner({
    root: process.cwd(),
    dataDir,
    hot,
    port,
    llm,
    embed: (texts: Array<string>) => Promise.resolve(texts.map(() => null)),
    rng: () => 0.5,
    now: () => TURN_NOW,
    turnId: 't-inner-1',
  });
  let result: Untyped;
  try {
    result = await wired.under(() =>
      wired.runner.runTurn({
        chat: null,
        mode: 'inner',
        triggerKind: 'inner',
        inner: { wake: serviceWake('heartbeat'), currentChannel: null, shadow: true, mayAct: () => false },
      })
    );
  } finally {
    wired.close();
  }
  const first = requests[0] ?? '';
  const memory = blockOf(first, 'memory');
  const places = /<places>\n([\s\S]*?)\n<\/places>/.exec(memory)?.[1] ?? '';
  const people = /<people>\n([\s\S]*?)\n<\/people>/.exec(memory)?.[1] ?? '';
  assert.ok(places.includes('κήπος') && places.includes('λιμάνι'), 'both places listed');
  assert.ok(people.includes('Ελένη'), 'a known person listed');
  assert.ok(blockOf(first, 'inner').includes(PURPOSE), '<inner> lists the open intention');
  const reads = ((result as Rec).inner as { actions: Array<Rec> }).actions.filter(
    (action) => action.skill === 'conversation.read'
  );
  assert.deepEqual(
    reads.map((action) => `${String(action.status)}:${String(action.result)}`),
    ['executed:ok', 'executed:ok'],
    JSON.stringify(reads)
  );
});

test('a replayed heartbeat searches memory when a line it quotes holds a custom emoji', async () => {
  // Bug: the replay's recall has no reader of emoji names, so the legend of a quoted line throws and the search fails.
  const dataDir = await heartbeatDataDir((db) => {
    db.prepare("UPDATE sources SET text = text || ' :e7:' WHERE text = ?").run('ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ');
  });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_NOW });
  let asked = 0;
  const llm = {
    complete: () => {
      asked += 1;
      if (asked > 1) return Promise.resolve(completionOf('<skip/>'));
      return Promise.resolve(
        toolAnswer('', [toolCall('memory.search', { question: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', terms: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ' })])
      );
    },
  };
  const hot = {
    config: {
      bot: {
        timezone: 'UTC',
        access: Object.fromEntries(
          HEARTBEAT_GRANTED.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])
        ),
      },
      context: SERVICE_CONTEXT,
      llm: { maxRequestTokens: 60000 },
      tools: { resultMaxChars: 2000, callTimeoutMs: 120000 },
      wakes: { mode: 'shadow', loop: { maxSteps: 3 } },
      intentions: { expiresDays: 14, maxOpen: 20 },
    },
    // The search runs only with its summary prompt present.
    prompts: { ...PROMPTS },
  };
  const { wired } = innerTurnRunner({
    root: process.cwd(),
    dataDir,
    hot,
    port,
    llm,
    embed: (texts: Array<string>) => Promise.resolve(texts.map(() => null)),
    rng: () => 0.5,
    now: () => TURN_NOW,
    turnId: 't-inner-search',
  });
  let result: Untyped;
  try {
    result = await wired.under(() =>
      wired.runner.runTurn({
        chat: null,
        mode: 'inner',
        triggerKind: 'inner',
        inner: { wake: serviceWake('heartbeat'), currentChannel: null, shadow: true, mayAct: () => false },
      })
    );
  } finally {
    wired.close();
  }
  const searches = ((result as Rec).inner as { actions: Array<Rec> }).actions.filter(
    (action) => action.skill === 'memory.search'
  );
  assert.deepEqual(
    searches.map((action) => `${String(action.status)}:${String(action.result)}`),
    ['executed:ok'],
    JSON.stringify(searches)
  );
});

const ERRAND_MARK = 'ΑΠΟΤΕΛΕΣΜΑ-ΤΗΣ-ΑΝΙΧΝΕΥΣΗΣ';

/** One heartbeat over the fixture data: the first answer hands off a scout errand, the second sets an intention. */
async function errandHeartbeat(errandAnswers: ReturnType<typeof parseErrandAnswers> | null) {
  const dataDir = await heartbeatDataDir();
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_NOW });
  const requests: Array<string> = [];
  const llm = {
    complete: (messages: Array<{ content: unknown }>) => {
      requests.push(messages.map((message) => userText(message.content)).join('\n'));
      if (requests.length === 1)
        return Promise.resolve(toolAnswer('', [toolCall('errand.scout', { goal: 'find the garden show dates' })]));
      // A heartbeat goes on after an intention change, so the third answer ends the turn with a skip.
      if (requests.length === 2)
        return Promise.resolve(toolAnswer('', [toolCall('intention.set', { text: 'tell about the show', due: '2h' })]));
      return Promise.resolve(toolAnswer('<skip/>', []));
    },
  };
  const granted = [...HEARTBEAT_GRANTED, 'errand.scout'];
  const hot = {
    config: {
      bot: {
        timezone: 'UTC',
        access: Object.fromEntries(granted.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: SERVICE_CONTEXT,
      llm: { maxRequestTokens: 60000 },
      tools: { resultMaxChars: 2000, callTimeoutMs: 120000 },
      wakes: { mode: 'shadow', loop: { maxSteps: 3 } },
      intentions: { expiresDays: 14, maxOpen: 20 },
    },
    prompts: PROMPTS,
  };
  const { wired } = innerTurnRunner({
    root: process.cwd(),
    dataDir,
    hot,
    port,
    llm,
    embed: (texts: Array<string>) => Promise.resolve(texts.map(() => null)),
    rng: () => 0.5,
    now: () => TURN_NOW,
    turnId: 't-inner-errand',
    errandAnswers,
  });
  type Ended = { outcome?: string; reason?: string; inner?: { actions: Array<Rec>; loop?: { cut: string | null } } };
  let result: Ended;
  try {
    result = await wired.under(() =>
      wired.runner.runTurn({
        chat: null,
        mode: 'inner',
        triggerKind: 'inner',
        inner: { wake: serviceWake('heartbeat'), currentChannel: null, shadow: true, mayAct: () => false },
      })
    );
  } finally {
    wired.close();
  }
  const actions = result.inner?.actions ?? [];
  const facts = sampleFacts(
    {
      requests: requests.map(() => ({})),
      answers: [],
      actions,
      turn: turnEndOf(result),
    },
    { now: TURN_NOW, timezone: 'UTC', directOf: () => null }
  );
  return { requests, actions, facts };
}

test('a replayed heartbeat whose errand nobody answers ends unresolved, not a skip, and starts no errand', async () => {
  const { requests, facts } = await errandHeartbeat(null);
  assert.equal(requests.length, 1, 'the proposed errand ends the turn');
  assert.deepEqual(facts.end, { kind: 'unresolved', code: 'errand-proposed' });
  assert.deepEqual(facts.errands, [{ agent: 'scout', answered: false }]);
});

test('with errand answers a replayed heartbeat reads the result and goes on to set an intention', async () => {
  const { requests, facts } = await errandHeartbeat(
    parseErrandAnswers([{ agent: 'scout', status: 'done', text: ERRAND_MARK }])
  );
  // A heartbeat takes several intention changes, so the request after the change is the one the persona's skip ends.
  assert.equal(requests.length, 3);
  assert.ok(requests[1].includes(ERRAND_MARK), 'the second request carries the result');
  assert.equal(facts.end.kind, 'intention');
  assert.deepEqual(facts.errands, [{ agent: 'scout', answered: true }]);
});

test('an errand call that finds no answer for its agent ends unresolved with errand-unanswered', async () => {
  const { requests, facts } = await errandHeartbeat(
    parseErrandAnswers([{ agent: 'code', status: 'done', text: ERRAND_MARK }])
  );
  assert.ok(!requests.join('\n').includes(ERRAND_MARK), 'no answer of another agent is read');
  assert.deepEqual(facts.end, { kind: 'unresolved', code: 'errand-unanswered' });
  assert.deepEqual(facts.errands, [{ agent: 'scout', answered: false }]);
});

/** A one-pixel PNG, the picture every download in the look test below gets. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
);

// The address of an attachment lapses: the platform signs it for a while and hands a new one when the message is read
// again. The core reads the message again before each download (src/core.ts `freshAddress`).
const LAPSING = 'https://cdn.example/flowers.png?signed=old';
const FRESH = 'https://cdn.example/flowers.png?signed=new';

test('a replayed heartbeat looks again at a picture whose address lapsed after it read the message', async () => {
  const dataDir = await heartbeatDataDir();
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_NOW });
  const chat = { id: 'c2', kind: 'channel' as const, rootId: 'g1', name: 'κήπος' };
  port.seedChat({
    iface: 'fake',
    ...chat,
    topic: null,
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
  });
  const picture = (url: string) =>
    port.seedEvent({
      kind: 'message.received',
      iface: 'fake',
      at: TURN_NOW - 10 * 60_000,
      id: 'fake:message:p1',
      chat,
      message: {
        id: 'p1',
        author: { id: '111', name: 'Ελένη', self: false, bot: false },
        content: 'κοίτα τα λουλούδια',
        sourceText: 'κοίτα τα λουλούδια',
        system: false,
        at: TURN_NOW - 10 * 60_000,
        replyToId: null,
        replyPingAccountId: null,
        forwardedFrom: null,
        attachments: [{ id: 'a1', kind: 'image', name: 'flowers.png', url, contentType: 'image/png' }],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions: [],
      },
      addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
    } as unknown as Parameters<typeof port.seedEvent>[0]);
  picture(LAPSING);
  const looks: Array<string> = [];
  const results: Array<string> = [];
  let step = 0;
  const llm = {
    complete: (messages: Array<{ role?: string; content: unknown }>) => {
      const parts = messages.flatMap((message): Array<unknown> =>
        Array.isArray(message.content) ? message.content : []
      );
      if (parts.some((part) => asRecord(part).type === 'image_url')) {
        looks.push('vision');
        return Promise.resolve(completionOf('ΚΟΚΚΙΝΑ-ΤΡΙΑΝΤΑΦΥΛΛΑ'));
      }
      step += 1;
      const text = messages.map((message) => userText(message.content)).join('\n');
      results.push(text);
      if (step === 1) {
        const garden = blockOf(text, 'memory')
          .split('\n')
          .find((line) => line.includes('κήπος'));
        const handle = /^(#[A-Za-z0-9_-]+):/.exec(garden ?? '')?.[1] ?? '#none';
        return Promise.resolve(toolAnswer('', [toolCall('conversation.read', { place: handle })]));
      }
      if (step === 2) {
        const line = text.split('\n').find((one) => one.includes('κοίτα τα λουλούδια')) ?? '';
        const number = /(#\d+)/.exec(line)?.[1] ?? '#none';
        picture(FRESH);
        return Promise.resolve(
          toolAnswer('', [toolCall('media.look', { message: number, question: 'τι λουλούδια;' })])
        );
      }
      return Promise.resolve(completionOf('<skip/>'));
    },
  };
  const granted = [...HEARTBEAT_GRANTED, 'media.look'];
  const hot = {
    config: {
      bot: {
        timezone: 'UTC',
        access: Object.fromEntries(granted.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: SERVICE_CONTEXT,
      features: { mediaDescriptions: true },
      models: { routes: chainsOnDefaults({ core: 'x/core', analyzer: 'x/text', vision: 'x/vision' }) },
      llm: { maxRequestTokens: 60000 },
      tools: { resultMaxChars: 2000, callTimeoutMs: 120000 },
      wakes: { mode: 'shadow', loop: { maxSteps: 4 } },
      intentions: { expiresDays: 14, maxOpen: 20 },
    },
    prompts: { ...PROMPTS, 'describe/rewatch': 'Answer the question about the picture.' },
  };
  const realFetch = globalThis.fetch;
  const fetched: Array<string> = [];
  globalThis.fetch = (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    return Promise.resolve(
      url === FRESH
        ? new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })
        : new Response(null, { status: 404 })
    );
  };
  let result: Untyped;
  try {
    const { wired } = innerTurnRunner({
      root: process.cwd(),
      dataDir,
      hot,
      port,
      llm,
      embed: (texts: Array<string>) => Promise.resolve(texts.map(() => null)),
      rng: () => 0.5,
      now: () => TURN_NOW,
      turnId: 't-inner-look',
    });
    try {
      result = await wired.under(() =>
        wired.runner.runTurn({
          chat: null,
          mode: 'inner',
          triggerKind: 'inner',
          inner: { wake: serviceWake('heartbeat'), currentChannel: null, shadow: true, mayAct: () => false },
        })
      );
    } finally {
      wired.close();
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  const look = ((result as Rec).inner as { actions: Array<Rec> }).actions.find(
    (action) => action.skill === 'media.look'
  );
  assert.equal(`${String(look?.status)}:${String(look?.result)}`, 'executed:ok', JSON.stringify(look));
  assert.deepEqual(looks, ['vision']);
  assert.deepEqual(fetched, [FRESH]);
});

// ---- the record and the journal handed to the inner life ----------------------------------------------
// The inner life reads them as the persona's (`record.iterate(query)`, `journal.read(query)`), so the replay wraps the
// place stores as src/core.ts does (personaRecord, personaJournal over the served places).

const SOURCES_LOG = { info() {}, warn() {}, error() {} };
const SOURCES_NOW = Date.UTC(2026, 10, 6, 6, 0, 0);
const SOURCES_SAID_AT = Date.UTC(2026, 10, 5, 23, 1, 0);
const SOURCES_PLACE = legacyServerPlaceId('discord', 'g1');

async function sourcesScene() {
  const mem = await openTestMemory();
  const record = createRecord({
    dataDir: mem.dataDir,
    log: SOURCES_LOG,
    now: () => SOURCES_NOW,
    memoryDb: mem.memoryDb,
  });
  const journal = createJournal({
    dataDir: mem.dataDir,
    memoryDb: mem.memoryDb,
    now: () => SOURCES_NOW,
    log: SOURCES_LOG,
  });
  const done = async () => {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  };
  return { record, journal, done };
}

const sourcesSaid = toRecordLine(
  {
    id: 'm1',
    placeId: 'c1',
    channelName: 'general',
    authorId: 'self1',
    authorName: 'Her',
    self: true,
    bot: false,
    content: 'hello',
    ts: SOURCES_SAID_AT,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    direct: false,
  },
  { kind: 'said', turnId: 't-1', opId: 'op-1', now: () => SOURCES_NOW, uuid: () => 'u-1' }
) as never;

test('the record handed to the inner life reads a served place by a query alone, as the core does', async () => {
  // Bug: the raw place record takes the query as the place id, so every inner read dies with BAD_COLLECTION_ID.
  const { record, journal, done } = await sourcesScene();
  try {
    await record.append(SOURCES_PLACE, [sourcesSaid]);
    const sources = innerSourcesOf({
      record,
      journal,
      store: { rootPlaceOf: (id: string) => id },
      places: () => [SOURCES_PLACE],
      hide: { any: false, channels: new Set(), messages: new Set() },
    });
    const ids: Array<unknown> = [];
    for await (const line of sources.record.iterate({ from: new Date(SOURCES_NOW - 86_400_000).toISOString() }))
      ids.push((line as { messageId?: unknown; id?: unknown }).messageId ?? (line as { id?: unknown }).id);
    assert.deepEqual(ids, ['m1']);
  } finally {
    await done();
  }
});

test('the journal handed to the inner life reads by a query alone, as the core does', async () => {
  // Bug: the raw journal takes the query as the place id, so the heartbeat view reads nothing.
  const { record, journal, done } = await sourcesScene();
  try {
    const sources = innerSourcesOf({
      record,
      journal,
      store: { rootPlaceOf: (id: string) => id },
      places: () => [SOURCES_PLACE],
      hide: { any: false, channels: new Set(), messages: new Set() },
    });
    // The lead: the persona journal's read takes a day, as its type says.
    assert.deepEqual(await sources.journal.read({ day: '2026-11-06', n: 5 }), []);
  } finally {
    await done();
  }
});
