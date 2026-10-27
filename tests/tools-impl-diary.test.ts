// Her diary as a target of `message.create` (stage 3 design, section 10, "From now on"): with `diary: "true"` the call
// writes in her diary in place of a channel, from any turn but the diary turn, with everything `message.create` carries
// (text, a GIF, a file, a media repost). Every such call of one turn goes into that turn's one entry, recorded in memory
// before anything is sent; when the turn ends, the diary's mirrors publish the entry once each. The turn's first diary
// call counts toward `diary.maxPerDay` and is refused `cap-diary` over it; `channel` or `reply` beside `diary` is
// `invalid-args`. Real turn runner, admin, store and memory database over the fake interface, with two enabled mirrors
// and a scripted model. Synthetic text only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMirrors, guardMirrorPort } from '../src/behavior/mirror.ts';
import { DIARY_DAILY } from '../src/behavior/diary.js';
import { createTurnRunner } from '../src/behavior/turn.js';
import { createAdmin } from '../src/admin.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { createStore } from '../src/memory/store.js';
import { skillRegistry } from '../src/tools/registry.ts';
import { countToday } from '../src/time.js';
import { diaryPublications, diaryRows, seedMirror } from './fixtures/diary-mirror.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { openTestMemory } from './fixtures/memory-db/service.js';
import { call, toolAnswer } from './fixtures/tool-answers.js';
import { DISCORD, hotWith, personaGrants, rawMessage, sequenceLlm } from './fixtures/turn-harness.js';
import { freshWorld, world } from './fixtures/turn-world.ts';
import '../src/tools/impl/index.ts';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const GUILD = 'g1';
const MAX_PER_DAY = 3;

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

/**
 * A community with `general` (c1), where Alice wrote last, and the diary's two enabled mirrors `journal` (d1) and
 * `notes` (d2), on a fake interface; a real store over memory, the publisher over the interface's own port, and her
 * tools through a real admin over the guarded port. `postsToday` diary entries are already counted today.
 */
async function community({ postsToday = 0 }: { postsToday?: number } = {}) {
  const memory = await openTestMemory({ now: () => NOW });
  OPEN.push(memory);
  freshWorld();
  const line = (channelId: string) => ({
    ...rawMessage({ id: `m-${channelId}`, ts: NOW - 30_000, content: 'γεια' }),
    channelId,
  });
  // Her own earlier post in c1 with a picture: what a media repost takes.
  const ownPicture = {
    ...rawMessage({ id: 'p-own', ts: NOW - 60_000, content: '' }),
    channelId: 'c1',
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
    attachments: new Map([
      [
        'att-own',
        { id: 'att-own', name: 'pier.png', url: 'https://cdn.example/pier.png', contentType: 'image/png', size: 3 },
      ],
    ]),
  };
  world().channel({ id: 'c1', name: 'general', guildId: GUILD, historyMessages: [ownPicture, line('c1')] });
  world().channel({ id: 'd1', name: 'journal', guildId: GUILD });
  world().channel({ id: 'd2', name: 'notes', guildId: GUILD });
  for (const [id, name] of [
    ['d1', 'journal'],
    ['d2', 'notes'],
  ] as const)
    seedMirror(memory.memoryDb, { iface: 'fake', conversationId: id, name, at: NOW });
  // Her GIF library holds one GIF, `g1`, posted as its address.
  const store = Object.assign(createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb }), {
    findGif: (_guildId: string, handle: string) =>
      handle === 'g1' ? { id: 'g1', url: 'https://media.example/g1.gif', file: null } : null,
    recordOwnGif: () => {},
  });
  if (postsToday > 0) Object.assign(store.state.data, { diaryDay: '2026-10-27', diaryPosts: postsToday });
  const adapter = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const reads = world().adopt(adapter);
  const mirrors = createMirrors({
    memoryDb: memory.memoryDb,
    port: () => adapter,
    now: () => NOW,
    dataDir: memory.dataDir,
  });
  const port = guardMirrorPort(adapter, { memoryDb: memory.memoryDb });
  const texts = (conversationId: string) => adapter.messagesIn(conversationId).map((message) => message.text);
  // A file one of her errands brought back.
  const filePath = path.join(memory.dataDir, 'notes.txt');
  fs.writeFileSync(filePath, 'σημειώσεις');
  const errands = { fileOf: () => ({ name: 'notes.txt', path: filePath, contentType: 'text/plain' }) };
  return { memory, store, adapter, reads, mirrors, port, texts, errands };
}

type Community = Awaited<ReturnType<typeof community>>;

/** The settings: her grant on `diary.write`, the diary's caps, the prompts an inner and a diary turn read. */
function settings() {
  const hot = hotWith({
    features: { coreTools: true, innerLife: true, diary: true },
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['message.create']),
    config: {
      diary: {
        maxPerDay: MAX_PER_DAY,
        maxMessages: 3,
        world: false,
        kinds: { status: 1 },
        historyPosts: 40,
        gistChars: 60,
        seedSets: 1,
        planMaxOutputTokens: 250,
        planTimeoutMs: 15000,
      },
    },
  });
  Object.assign(hot.prompts, {
    inner: 'Nobody wrote to you; read the wake block.',
    diary: 'Write your diary.',
    'diary-plan': 'Plan the entry.',
    'diary-seeds': '# place\na pier',
    world: 'The world.',
  });
  return hot;
}

/** An intention due in c1: an inner turn of hers. */
const INTENTION_WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'γράψε στο ημερολόγιο', dueAt: NOW - 60_000 }],
  now: NOW,
  timezone: 'UTC',
  channels: [],
  budgets: { chain: { used: 0, cap: 3, left: 3 } },
};

/**
 * One turn of hers over `core`: an ordinary reply to Alice in c1, an inner turn in c1 for `wake`, or the diary turn.
 * Returns the logs and the scripted model.
 */
async function turnOf(
  core: Community,
  {
    answers,
    mode = 'reply',
    onAnswer = null,
  }: { answers: Array<unknown>; mode?: 'reply' | 'inner' | 'diary'; onAnswer?: ((index: number) => void) | null }
) {
  const hot = settings();
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store: core.store,
    client,
    getGuildId: () => GUILD,
    port: core.port,
    reads: core.reads,
    // The diary's publisher: an entry she writes goes to every enabled mirror.
    mirrors: core.mirrors,
    errands: core.errands,
    // The download of her own picture a media repost takes.
    fetchImpl: () =>
      Promise.resolve({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new Uint8Array([7, 8, 9]).buffer),
      }),
  });
  const llm = sequenceLlm(answers, 'none', onAnswer);
  const turns = createTurnRunner({
    discord: DISCORD,
    hot,
    store: core.store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    client,
    now: () => NOW,
    port: core.port,
    reads: core.reads,
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    skills: skillRegistry(),
    journal: null,
    mirrors: core.mirrors,
    // Her errands' files, which a post may carry.
    errands: core.errands,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
  });
  const conversation = { iface: 'fake', conversationId: 'c1' };
  const trigger = {
    id: 'm-c1',
    channelId: 'c1',
    authorId: 'u1',
    authorName: 'Alice',
    self: false,
    bot: false,
    content: 'γεια',
    ts: NOW - 30_000,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
  const params =
    mode === 'inner'
      ? {
          conversation,
          guildId: GUILD,
          mode: 'inner',
          triggerKind: 'inner',
          inner: { wake: INTENTION_WAKE, shadow: false, mayAct: () => true },
        }
      : mode === 'diary'
        ? { mode: 'diary', diary: { kind: 'status', forced: true }, guildId: GUILD }
        : { conversation, mode: 'reply', triggerKind: 'mention', trigger };
  const { logs } = await withCapturedLogs(() => turns.runTurn(params));
  await core.store.flushSettled({});
  return { logs: logs as Array<Record<string, unknown>>, llm };
}

/** The `skills: called` lines of a turn, as `skill:status` and the code when there is one. */
const calledOf = (logs: Array<Record<string, unknown>>) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map(
      (entry) =>
        `${String(entry.skill)}:${String(entry.status)}${typeof entry.code === 'string' ? `/${entry.code}` : ''}`
    );

/** The tools a request offered her, by their API names. */
const offeredIn = (options: unknown): Array<string> =>
  ((options as { tools?: Array<{ function: { name: string } }> } | undefined)?.tools ?? []).map(
    (tool) => tool.function.name
  );

/** One answer of hers with `message.create` calls to her diary, each with `args`. */
const toDiary = (...args: Array<Record<string, unknown>>) =>
  toolAnswer(
    '',
    args.map((given) => call('message.create', { diary: 'true', ...given }))
  );

/** The messages each mirror received, its text and the names of its attachments. */
const receivedIn = (core: Community, conversationId: string) =>
  core.adapter.messagesIn(conversationId).map((message) => ({
    text: message.text,
    files: message.attachments.map((attachment) => attachment.name),
  }));

test('two diary calls of an ordinary turn make one entry, published to every mirror once when the turn ends', async () => {
  const core = await community();
  let sentDuringTurn = -1;
  const { logs } = await turnOf(core, {
    answers: [toDiary({ text: 'μια σκέψη' }, { text: 'και μια ακόμη' }), '<skip/>'],
    // Her second request comes after the calls ran, before the turn ended.
    onAnswer: (index) => {
      if (index === 1) sentDuringTurn = core.adapter.messagesIn('d1').length + core.adapter.messagesIn('d2').length;
    },
  });
  assert.deepEqual(calledOf(logs), ['message.create:ok', 'message.create:ok']);
  assert.equal(sentDuringTurn, 0, 'nothing is sent while the turn runs');
  assert.deepEqual(
    diaryRows(core.memory.memoryDb).map((row) => row.text),
    ['μια σκέψη\nκαι μια ακόμη']
  );
  assert.deepEqual(
    [core.texts('d1'), core.texts('d2')],
    [
      ['μια σκέψη', 'και μια ακόμη'],
      ['μια σκέψη', 'και μια ακόμη'],
    ]
  );
  assert.deepEqual(
    diaryPublications(core.memory.memoryDb).map((row) => row.status),
    ['sent', 'sent']
  );
  // store.js is untyped JS; its state data is the object the daily counters live in.
  const state = core.store.state.data as Record<string, unknown>;
  assert.equal(countToday(state, DIARY_DAILY, NOW), 1, 'the entry counts once toward the day');
});

test('a diary call of an inner turn records one entry, published to every mirror once', async () => {
  const core = await community();
  const { logs } = await turnOf(core, { mode: 'inner', answers: [toDiary({ text: 'βράδυ' }), '<skip/>'] });
  assert.deepEqual(calledOf(logs), ['message.create:ok']);
  assert.deepEqual(
    diaryRows(core.memory.memoryDb).map((row) => row.text),
    ['βράδυ']
  );
  assert.deepEqual([core.texts('d1'), core.texts('d2')], [['βράδυ'], ['βράδυ']]);
});

test('a GIF written to her diary goes into the entry and is published with it', async () => {
  const core = await community();
  const { logs } = await turnOf(core, { answers: [toDiary({ text: 'χαχα', gif: 'g1' }), '<skip/>'] });
  assert.deepEqual(calledOf(logs), ['message.create:ok']);
  for (const mirror of ['d1', 'd2'])
    assert.ok(
      core.texts(mirror).some((text) => text.includes('https://media.example/g1.gif')),
      `${mirror} has the GIF`
    );
});

test('a file written to her diary goes into the entry and is published with it', async () => {
  const core = await community();
  const { logs } = await turnOf(core, {
    answers: [toDiary({ text: 'οι σημειώσεις', file: 'file:t1/notes.txt' }), '<skip/>'],
  });
  assert.deepEqual(calledOf(logs), ['message.create:ok']);
  for (const mirror of ['d1', 'd2'])
    assert.ok(
      receivedIn(core, mirror).some((message) => message.files.includes('notes.txt')),
      `${mirror} has the file`
    );
});

test('a media repost written to her diary goes into the entry and is published with it', async () => {
  const core = await community();
  const { logs } = await turnOf(core, { answers: [toDiary({ media: 'p-own' }), '<skip/>'] });
  assert.deepEqual(calledOf(logs), ['message.create:ok']);
  for (const mirror of ['d1', 'd2'])
    assert.ok(
      receivedIn(core, mirror).some((message) => message.files.includes('pier.png')),
      `${mirror} has the picture`
    );
});

test('a diary call with a channel or a reply is refused invalid-args and records nothing', async () => {
  for (const given of [{ channel: '#general' }, { reply: 'm-c1' }]) {
    const core = await community();
    const { logs } = await turnOf(core, { answers: [toDiary({ text: 'x', ...given }), '<skip/>'] });
    assert.deepEqual(calledOf(logs), ['message.create:invalid/invalid-args'], Object.keys(given)[0]);
    assert.deepEqual(diaryRows(core.memory.memoryDb), []);
    assert.deepEqual([core.texts('d1'), core.texts('d2')], [[], []]);
  }
});

test("over diary.maxPerDay the turn's first diary call is refused cap-diary and nothing is recorded", async () => {
  const core = await community({ postsToday: MAX_PER_DAY });
  const { logs } = await turnOf(core, { answers: [toDiary({ text: 'ακόμη μία' }), '<skip/>'] });
  assert.deepEqual(calledOf(logs), ['message.create:denied/cap-diary']);
  assert.deepEqual(diaryRows(core.memory.memoryDb), []);
  assert.deepEqual([core.texts('d1'), core.texts('d2')], [[], []]);
});

test('the diary turn does not offer message.create, and writes its entry itself', async () => {
  const core = await community();
  const plan = JSON.stringify({ kind: 'status', brief: 'a quiet day', search: '', picture: false });
  const { llm } = await turnOf(core, { mode: 'diary', answers: [plan, '<msg>μια ήσυχη μέρα</msg>'] });
  const writer: unknown = llm.options.at(-1);
  assert.ok(writer, 'the diary turn made its writer request');
  assert.ok(!offeredIn(writer).includes('message_create'));
});
