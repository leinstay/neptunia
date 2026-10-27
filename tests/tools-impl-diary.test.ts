// `diary.write` (stage 3 design, section 10, "From now on"): she writes in her diary herself from any turn but the diary
// turn. The call takes the entry's messages, one to `diary.maxMessages`, records one entry in memory, and the diary's
// mirrors publish it once each. It counts toward `diary.maxPerDay`, and over the cap it is refused `cap-diary`. Real
// turn runner, admin, store and memory database over the fake interface, with two enabled mirrors and a scripted model.
// Synthetic text only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
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
const MAX_MESSAGES = 2;

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
  world().channel({ id: 'c1', name: 'general', guildId: GUILD, historyMessages: [line('c1')] });
  world().channel({ id: 'd1', name: 'journal', guildId: GUILD });
  world().channel({ id: 'd2', name: 'notes', guildId: GUILD });
  for (const [id, name] of [
    ['d1', 'journal'],
    ['d2', 'notes'],
  ] as const)
    seedMirror(memory.memoryDb, { iface: 'fake', conversationId: id, name, at: NOW });
  const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
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
  return { memory, store, adapter, reads, mirrors, port, texts };
}

type Community = Awaited<ReturnType<typeof community>>;

/** The settings: her grant on `diary.write`, the diary's caps, the prompts an inner and a diary turn read. */
function settings() {
  const hot = hotWith({
    features: { coreTools: true, innerLife: true, diary: true },
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['diary.write']),
    config: {
      diary: {
        maxPerDay: MAX_PER_DAY,
        maxMessages: MAX_MESSAGES,
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
  { answers, mode = 'reply' }: { answers: Array<unknown>; mode?: 'reply' | 'inner' | 'diary' }
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
  });
  const llm = sequenceLlm(answers);
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

const WRITE = (messages: Array<string>) => toolAnswer('', [call('diary.write', { messages })]);

test('diary.write from an ordinary turn records one entry and publishes it to every enabled mirror once', async () => {
  const core = await community();
  const { logs } = await turnOf(core, { answers: [WRITE(['μια σκέψη', 'και μια ακόμη']), '<skip/>'] });
  assert.deepEqual(calledOf(logs), ['diary.write:ok']);
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
  assert.equal(countToday(state, DIARY_DAILY, NOW), 1, 'the entry counts toward the day');
});

test('diary.write from an inner turn records one entry and publishes it to every enabled mirror once', async () => {
  const core = await community();
  const { logs } = await turnOf(core, { mode: 'inner', answers: [WRITE(['βράδυ']), '<skip/>'] });
  assert.deepEqual(calledOf(logs), ['diary.write:ok']);
  assert.deepEqual(
    diaryRows(core.memory.memoryDb).map((row) => row.text),
    ['βράδυ']
  );
  assert.deepEqual([core.texts('d1'), core.texts('d2')], [['βράδυ'], ['βράδυ']]);
});

test('diary.write over diary.maxPerDay is refused cap-diary and records nothing', async () => {
  const core = await community({ postsToday: MAX_PER_DAY });
  const { logs } = await turnOf(core, { answers: [WRITE(['ακόμη μία']), '<skip/>'] });
  assert.deepEqual(calledOf(logs), ['diary.write:denied/cap-diary']);
  assert.deepEqual(diaryRows(core.memory.memoryDb), []);
  assert.deepEqual([core.texts('d1'), core.texts('d2')], [[], []]);
});

test('diary.write with no message or more than diary.maxMessages is refused invalid-args and records nothing', async () => {
  for (const messages of [[], ['ένα', 'δύο', 'τρία']]) {
    const core = await community();
    const { logs } = await turnOf(core, { answers: [WRITE(messages), '<skip/>'] });
    assert.deepEqual(calledOf(logs), ['diary.write:invalid/invalid-args'], `${messages.length} messages`);
    assert.deepEqual(diaryRows(core.memory.memoryDb), []);
  }
});

test('diary.write is offered in an ordinary turn', async () => {
  const core = await community();
  const { llm } = await turnOf(core, { answers: ['<skip/>'] });
  assert.ok(offeredIn(llm.options[0]).includes('diary_write'));
});

test('diary.write is not offered in the diary turn, which writes its entry itself', async () => {
  const core = await community();
  const plan = JSON.stringify({ kind: 'status', brief: 'a quiet day', search: '', picture: false });
  const { llm } = await turnOf(core, { mode: 'diary', answers: [plan, '<msg>μια ήσυχη μέρα</msg>'] });
  const writer: unknown = llm.options.at(-1);
  assert.ok(writer, 'the diary turn made its writer request');
  assert.ok(!offeredIn(writer).includes('diary_write'));
});
