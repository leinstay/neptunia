// A mirror place is not hers to write in (stage 3 design, section 9): only the diary's publisher writes there. An event
// in a mirror place is recorded in memory and opens no turn of hers. The core's outbound port
// (src/behavior/mirror.ts#guardMirrorPort) refuses every send to a mirror place with the code `diary-mirror`, whether
// the send comes from an ordinary turn elsewhere, an intention's turn or a heartbeat that runs there, and her tool result
// names the code. The publisher, which holds the unguarded port, still publishes there. A disabled mirror row makes the
// place ordinary again. Real turn runner, admin, message handler and memory database over the fake interface, with a
// scripted model. Synthetic text only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guardMirrorPort, createMirrors } from '../src/behavior/mirror.ts';
import { createMessageHandler } from '../src/behavior/pipeline.js';
import { createTagHistory } from '../src/behavior/mention.js';
import { heartbeatWake } from '../src/behavior/inner.js';
import { createTurnRunner } from '../src/behavior/turn.js';
import { createAdmin } from '../src/admin.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { skillRegistry } from '../src/tools/registry.ts';
import { dbOf, entryOf, seedMirror } from './fixtures/diary-mirror.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { openTestMemory } from './fixtures/memory-db/service.js';
import { call, toolAnswer } from './fixtures/tool-answers.js';
import { DISCORD, fakeStore, hotWith, personaGrants, rawMessage, sequenceLlm } from './fixtures/turn-harness.js';
import { freshWorld, world } from './fixtures/turn-world.ts';
import '../src/tools/impl/index.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const GUILD = 'g1';
const MIRROR = 'd1';
/** The tracked settings of the message handler's rails (config.json), so the handler runs as it ships. */
const TRACKED = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>;

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

type Fake = ReturnType<typeof createFakeAdapter>;

/**
 * A community with `general` (c1), where Alice wrote last, and `journal` (d1), the diary's mirror (enabled unless
 * `enabled` is false), on a fake interface whose outbound port is the guarded one. Memory is a real database.
 */
async function community({ enabled = true }: { enabled?: boolean } = {}) {
  const memory = await openTestMemory({ now: () => NOW });
  OPEN.push(memory);
  seedMirror(memory.memoryDb, { iface: 'fake', conversationId: MIRROR, name: 'journal', enabled, at: NOW });
  freshWorld();
  const line = (channelId: string) => ({
    ...rawMessage({ id: `m-${channelId}`, ts: NOW - 30_000, content: 'γεια' }),
    channelId,
  });
  world().channel({ id: 'c1', name: 'general', guildId: GUILD, historyMessages: [line('c1')] });
  world().channel({ id: MIRROR, name: 'journal', guildId: GUILD, historyMessages: [line(MIRROR)] });
  const adapter: Fake = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const reads = world().adopt(adapter);
  const port = guardMirrorPort(adapter, { memoryDb: memory.memoryDb });
  /** Every send that reached the interface to `conversationId`. */
  const sendsTo = (conversationId: string) =>
    adapter.calls.filter(
      (entry) => entry.op === 'send' && (entry.args[0] as { conversationId?: string }).conversationId === conversationId
    );
  return { memory, adapter, reads, port, sendsTo };
}

type Community = Awaited<ReturnType<typeof community>>;

/**
 * One turn of hers in `here` over `core`, answered with `answers`: an ordinary reply to Alice, or an inner turn for
 * `wake`. Her tools run through a real admin over the same guarded port. Returns the logs of the turn.
 */
async function turnIn(
  core: Community,
  { here, answers, wake = null }: { here: string; answers: Array<unknown>; wake?: object | null }
) {
  const hot = hotWith({
    features: { coreTools: true, gifs: true, imageGeneration: true, speech: true, innerLife: true },
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['message.create', 'draw.create', 'voice.say']),
    // A heartbeat that may post, not only change her intentions.
    config: { innerLife: { heartbeat: { intentionsOnly: false } } },
  });
  Object.assign(hot.prompts, { inner: 'Nobody wrote to you; read the wake block.', draw: 'DRAW {{request}}' });
  const store = Object.assign(fakeStore(), {
    findGif: () => ({ id: 'g1', url: 'https://media.example/g1.gif', file: null }),
    recordOwnGif: () => {},
  });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const images = {
    quota: () => ({ used: 0, cap: 10, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: () => Promise.resolve({ buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 }),
  };
  const speech = {
    quota: () => ({ used: 0, cap: 10, spent: false }),
    say: ({ text }: { text: string }) =>
      Promise.resolve({ ogg: Buffer.from('ogg'), durationSecs: 1, waveform: 'AA', voiced: text, chars: 4, cost: 0 }),
  };
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    getGuildId: () => GUILD,
    port: core.port,
    reads: core.reads,
    images,
    speech,
  });
  const turns = createTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm: sequenceLlm(answers),
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    client,
    now: () => NOW,
    port: core.port,
    reads: core.reads,
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    images,
    speech,
    skills: skillRegistry(),
    journal: null,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
  });
  const conversation = { iface: 'fake', conversationId: here };
  const params = wake
    ? {
        conversation,
        guildId: GUILD,
        mode: 'inner',
        triggerKind: 'inner',
        inner: { wake, shadow: false, mayAct: () => true },
      }
    : {
        conversation,
        mode: 'reply',
        triggerKind: 'mention',
        trigger: {
          id: `m-${here}`,
          channelId: here,
          authorId: 'u1',
          authorName: 'Alice',
          self: false,
          bot: false,
          content: 'γεια',
          ts: NOW - 30_000,
          replyToId: null,
          attachments: [],
          stickers: [],
        },
      };
  const { logs } = await withCapturedLogs(() => turns.runTurn(params));
  return logs as Array<Record<string, unknown>>;
}

/** The `skills: called` lines of a turn, as `skill:status/code`. */
const calledOf = (logs: Array<Record<string, unknown>>) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map(
      (entry) =>
        `${String(entry.skill)}:${String(entry.status)}${typeof entry.code === 'string' ? `/${entry.code}` : ''}`
    );

/** Whether any log line of the turn names the code `diary-mirror` (a send refused through the guarded port). */
const namesTheCode = (logs: Array<Record<string, unknown>>) => JSON.stringify(logs).includes('"diary-mirror"');

/** The intention's wake whose turn runs in the mirror place: what was promised there is due. */
const intentionWake = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'πες καλημέρα', dueAt: NOW - 60_000, channelId: MIRROR }],
  channelId: MIRROR,
  now: NOW,
  timezone: 'UTC',
  channels: [],
  budgets: { chain: { used: 0, cap: 3, left: 3 } },
};

// ---- an event in a mirror place ---------------------------------------------------------------------------------

/** A mention of her by Alice in `conversationId`, as the interface delivers it. */
function mention(conversationId: string) {
  return {
    kind: 'message.received',
    iface: 'fake',
    at: NOW,
    id: `fake:message:e-${conversationId}`,
    conversation: {
      id: conversationId,
      kind: 'channel',
      guildId: GUILD,
      communityId: GUILD,
      name: conversationId,
      topic: null,
      category: null,
    },
    message: {
      id: `e-${conversationId}`,
      author: { id: 'u1', name: 'Alice', self: false, bot: false },
      content: 'καλημέρα, τι γράφεις;',
      at: NOW,
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: true, replyToSelf: false, mentionedUserIds: ['self-id'], mentionedConversationIds: [] },
    origin: {
      chatType: 'channel',
      place: conversationId,
      parent: null,
      thread: null,
      replyToAuthorId: null,
      replyExpected: true,
    },
  };
}

/** The message handler over `core` with a turn runner that only counts the turns it is asked for. */
function handlerOver(core: Community) {
  const asked: Array<unknown> = [];
  const handler = createMessageHandler({
    hot: hotWith({ features: { memory: true }, config: { mention: TRACKED.mention, pace: TRACKED.pace } }),
    store: fakeStore(),
    reads: core.reads,
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    turns: {
      runTurn: (params: unknown) => {
        asked.push(params);
        return Promise.resolve({ outcome: 'spoke' });
      },
      isBusy: () => false,
      isAnyBusy: () => false,
      lastPostAt: () => 0,
      notePost: () => {},
    },
    spontaneous: { onMessage: () => {} },
    memory: { observe: () => {} },
    tagHistory: createTagHistory(),
    getGuildId: () => GUILD,
    memoryDb: core.memory.memoryDb,
    port: core.port,
    rng: () => 0.5,
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });
  return { handler, asked };
}

/** The lines memory holds of the message `messageId`. */
const linesOf = (core: Community, messageId: string) =>
  dbOf(core.memory.memoryDb)
    .prepare('SELECT kind, text FROM sources WHERE native_id = ?')
    .all(messageId)
    .map((row) => ({ kind: row.kind, text: row.text }));

test('a mention in a mirror place opens no turn, and its line is in memory', async () => {
  const core = await community();
  const { handler, asked } = handlerOver(core);
  await handler(mention(MIRROR));
  assert.deepEqual(asked, [], 'no turn of hers');
  assert.deepEqual(linesOf(core, `e-${MIRROR}`), [{ kind: 'seen', text: 'καλημέρα, τι γράφεις;' }]);
});

// ---- a send aimed at a mirror place -----------------------------------------------------------------------------

test('a message, a picture and a voice from an ordinary turn elsewhere are refused diary-mirror', async () => {
  const core = await community();
  const logs = await turnIn(core, {
    here: 'c1',
    answers: [
      toolAnswer('', [
        call('message.create', { channel: '#journal', text: 'από εδώ' }),
        call('draw.create', { channel: '#journal', text: 'a pier' }),
        call('voice.say', { channel: '#journal', text: 'από εδώ' }),
      ]),
      '<skip/>',
    ],
  });
  assert.deepEqual(core.sendsTo(MIRROR), [], 'nothing reaches the interface there');
  assert.deepEqual(calledOf(logs), [
    'message.create:failed/diary-mirror',
    'draw.create:failed/diary-mirror',
    'voice.say:failed/diary-mirror',
  ]);
});

test('her message and GIF in an intention turn that runs in a mirror place are refused diary-mirror', async () => {
  const core = await community();
  const logs = await turnIn(core, {
    here: MIRROR,
    wake: intentionWake,
    answers: ['<msg>καλημέρα</msg><gif>g1</gif>', '<skip/>'],
  });
  assert.deepEqual(core.sendsTo(MIRROR), [], 'nothing reaches the interface there');
  assert.ok(namesTheCode(logs), 'the refusal names diary-mirror');
});

test('a message from a heartbeat whose current channel is a mirror place is refused diary-mirror', async () => {
  const core = await community();
  const logs = await turnIn(core, {
    here: MIRROR,
    wake: heartbeatWake(NOW - 1000),
    answers: [toolAnswer('', [call('message.create', { channel: '#journal', text: 'καλησπέρα' })]), '<skip/>'],
  });
  assert.deepEqual(core.sendsTo(MIRROR), [], 'nothing reaches the interface there');
  assert.deepEqual(calledOf(logs), ['message.create:failed/diary-mirror']);
});

// ---- the publisher, and a disabled mirror -----------------------------------------------------------------------

test('the publisher still publishes an entry to the mirror place', async () => {
  const core = await community();
  // A diary turn's entry, as the publisher takes it: the publisher holds the interface's own port.
  const mirrors = createMirrors({ memoryDb: core.memory.memoryDb, port: () => core.adapter, now: () => NOW });
  const result = { diary: { entry: { id: 'entry-1', messages: ['ημερολόγιο'] } } };
  await mirrors.publishEntry(entryOf(result));
  assert.deepEqual(
    core.adapter.messagesIn(MIRROR).map((message) => message.text),
    ['ημερολόγιο']
  );
});

test('a disabled mirror row lets a mention there open a turn again', async () => {
  const core = await community({ enabled: false });
  const { handler, asked } = handlerOver(core);
  await handler(mention(MIRROR));
  assert.equal(asked.length, 1);
});

test('a disabled mirror row lets her message there through', async () => {
  const core = await community({ enabled: false });
  const logs = await turnIn(core, {
    here: 'c1',
    answers: [toolAnswer('', [call('message.create', { channel: '#journal', text: 'από εδώ' })]), '<skip/>'],
  });
  assert.deepEqual(calledOf(logs), ['message.create:ok']);
  assert.equal(core.sendsTo(MIRROR).length, 1);
});
