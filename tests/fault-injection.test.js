// Fault-injection tests for "no silent failure" (specs/2026-10-20-fault-injection-tests.md): the
// persona's engine is built from its own factories over fakes -- the inner life's scheduler, the
// turn runner, the errand service and its result turns, the fact ledger in the inner state file,
// the journal -- on one temp data directory, and a fault is injected: the process "dies" (a fresh
// scheduler, errand service and turn runner are built over the same directory, the way a restart
// does; what ran in the old ones is left hanging), a model call fails or never returns, a send
// times out, a call fails on the last step, a state file is corrupt. One test per row of the
// spec's table, each titled with its row number; every scenario ends in assertNoSilentFailure,
// which checks the invariant from the fakes' records. No network, no Discord, no bot start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTurnRunner } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { createInnerLife, wakeOfDue, reviewWake } from '../src/behavior/inner.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { createEventDoor } from '../src/interface/door.js';
import { createJournal } from '../src/memory/journal.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createStore } from '../src/memory/store.js';
import { createMemoryUpdater } from '../src/memory/update.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { createTaskStores } from '../src/errands/store.js';
import { createErrandService } from '../src/errands/service.js';
import { RESULT_ATTEMPTS, createTaskTurns } from '../src/errands/turns.js';
import { runOp } from '../src/ops/index.js';
import { createOpsEnv } from '../src/ops/env.js';
import { skillRegistry } from '../src/skills/registry.js';
import { createAdmin } from '../src/admin.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay, zonedEpoch } from '../src/time.js';
import { labels } from './fixtures/labels.js';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const DISCORD = createDiscordInterface().capabilities;
const NOW0 = Date.parse('2026-10-19T12:00:00Z');
const GUILD = 'g1';
const SELF = 'self-id';
const SILENT = { info() {}, warn() {}, error() {} };
const INNER_TASK = 'Nobody wrote to you; read the wake block.';
const clock = { t: NOW0 };

test.beforeEach(() => {
  clock.t = NOW0;
});

/** A model call that never returns: the process dies there. */
const HANG = Symbol('hang');
/** A provider failure the way the client raises it (a 429). */
const providerLimit = () => Object.assign(new Error('OpenRouter HTTP 429'), { statusCode: 429, body: '{}' });
const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const wakeBlockOf = (text) => /<wake>\n([\s\S]*?)\n<\/wake>/.exec(text)?.[1] ?? '';

// ---- the chat: what survives a "death" (the conversations, the model, the log of what was asked) ----

/**
 * The chat world: a fake port holding every message (seeded and sent), the channels reading their
 * history from it, a scripted model, and the records the invariant checks. It is built once per
 * scenario and outlives every boot.
 */
function makeChat() {
  let stamp = 0;
  const names = { u1: 'Alice', u2: 'Zoë', [SELF]: 'Bot' };
  const port = createFakeAdapter({ iface: 'fake', selfId: SELF, now: () => clock.t - 5000 + (stamp += 1) });
  const guildChannels = new Map();
  const channels = new Map();
  const injected = []; // the sends a fault turned into a failure: { n, conversation, text }
  const failures = new Map(); // send attempt number -> the result it gets
  const dyingAfter = new Set(); // send attempt numbers after which the process dies: the message is in the chat, the answer never comes
  let attempts = 0;
  const send = port.send.bind(port);
  port.send = async (conversation, content) => {
    attempts += 1;
    if (dyingAfter.has(attempts)) {
      await send(conversation, content);
      chat.hung = true;
      return new Promise(() => {});
    }
    const result = failures.get(attempts);
    if (!result) return send(conversation, content);
    port.calls.push({ op: 'send', args: [conversation, content] });
    injected.push({ n: attempts, conversation: conversation.conversationId, text: content?.text ?? '' });
    return result;
  };

  const rawOf = (message) => ({
    id: message.ref.messageId,
    channelId: message.ref.conversationId,
    author: { id: message.authorId, bot: false, globalName: names[message.authorId] ?? message.authorId, username: names[message.authorId] ?? message.authorId },
    member: { displayName: names[message.authorId] ?? message.authorId },
    cleanContent: message.text,
    createdTimestamp: message.at,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  });
  const rawIn = (conversationId) => port.messagesIn(conversationId).map(rawOf);

  const chat = {
    port,
    injected,
    results: [], // every turn that ended: { channelId, mode, result, failedSends }
    requests: [], // every request a model call got: { audience, text }
    completed: [], // every model call that answered: { at, audience }
    script: [], // the next answers: a text, an Error, a function of the messages, or HANG
    fallback: '<skip/>',
    hung: false,
    audience: null,
    gifs: null,
    /** The nth send attempt (1-based, counted over the whole scenario) fails with `result`. */
    failSend(n, result = { status: 'failed', error: { code: 'rate-limited', retryable: false } }) {
      failures.set(n, result);
    },
    /** The process dies right after the nth send attempt reached the chat. */
    dieAfterSend(n) {
      dyingAfter.add(n);
    },
    get sendAttempts() {
      return attempts;
    },
    channel(id, { dm = false } = {}) {
      if (!channels.has(id)) {
        const guild = dm ? null : { id: GUILD, members: { me: { displayName: 'Bot' } }, channels: { cache: guildChannels } };
        const channel = {
          id,
          name: dm ? null : `chan-${id}`,
          guild,
          viewable: true,
          isTextBased: () => true,
          isThread: () => false,
          parent: null,
          permissionsFor: dm
            ? () => {
                throw new Error('a DM channel has no member permissions');
              }
            : () => ({ has: () => true }),
          sendTyping: async () => {},
          send: async () => ({ id: 'sent' }),
          messages: {
            cache: new Map(),
            fetch: async (arg) => {
              const all = rawIn(id);
              if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(all.slice(-arg.limit).map((message) => [message.id, message]));
              return all.find((message) => message.id === arg) ?? null;
            },
          },
        };
        channels.set(id, channel);
        if (!dm) guildChannels.set(id, channel);
      }
      return channels.get(id);
    },
    /** A line by `authorId` in `conversationId` (the persona's own when it is `SELF`); its raw form. */
    say(conversationId, authorId, text) {
      const ref = port.seed(conversationId, { authorId, text });
      return rawOf(port.messages.get(`${conversationId}/${ref.messageId}`));
    },
    ownMessages(conversationId, n = 20) {
      return port
        .messagesIn(conversationId)
        .filter((message) => message.authorId === SELF)
        .slice(-n)
        .map((message) => ({ id: message.ref.messageId, content: message.text, replyToId: message.replyTo?.messageId ?? null, createdAt: message.at }));
    },
    textsFromSelf(conversationId) {
      return port.messagesIn(conversationId).filter((message) => message.authorId === SELF).map((message) => message.text);
    },
    llm: null,
  };
  chat.llm = {
    calls: [],
    complete: async (messages) => {
      chat.llm.calls.push(messages);
      chat.requests.push({ audience: chat.audience, text: userText(messages[1].content) });
      let step = chat.script.length > 0 ? chat.script.shift() : chat.fallback;
      if (typeof step === 'function') step = await step(messages);
      if (step === HANG) {
        chat.hung = true;
        return new Promise(() => {});
      }
      if (step instanceof Error) throw step;
      chat.completed.push({ at: clock.t, audience: chat.audience });
      return completionOf(step);
    },
  };
  return chat;
}

/** The text of the request the model got as its `i`th call. */
const requestText = (chat, i) => chat.requests[i].text;

// ---- one boot of the engine over a data directory ----

const intentionRecord = (id, { dueAt = NOW0 - MINUTE_MS, channelId = 'c1', chainId = null, purpose = `purpose ${id}`, scope = 'group' } = {}) => ({
  id,
  status: 'pending',
  purpose,
  dueAt,
  chainId,
  destination: null,
  provenance: { kind: 'self', channelId, scope },
  createdAt: NOW0 - DAY_MS,
  updatedAt: NOW0 - DAY_MS,
  expiresAt: NOW0 + 7 * DAY_MS,
});

/** A fake intention service over `records` (mutable, outlives a boot): the due ones are pending with a passed dueAt. */
function fakeIntentions(records) {
  return {
    records,
    due: () => records.filter((r) => r.status === 'pending' && Number.isFinite(r.dueAt) && r.dueAt <= clock.t).map((r) => ({ intention: r, reason: 'due', at: r.dueAt })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records.filter((r) => ['pending', 'waiting', 'proposed'].includes(r.status)),
    store: () => ({ get: (id) => records.find((r) => r.id === id) ?? null, list: () => records }),
  };
}

const personaGrants = (names) => Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: [SELF] }]));

function hotWith({ features = {}, innerLife = {}, timezone = 'UTC', grants = [], config = {} } = {}) {
  return {
    config: {
      bot: { timezone, dryRunChannelId: '', owners: ['u1'], access: personaGrants(grants) },
      context: {
        channelMessages: 100, neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8, maxMessageChars: 800,
        gapMarkerMinutes: 20, otherProfiles: 6, failedTurnsKept: 3, caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { memory: true, reactions: true, multiMessage: true, typingSimulation: false, vision: false, followUpContinuation: true, callMarkers: true, coreTools: true, innerLife: true, intentions: true, ...features },
      models: { helpers: { analyzer: 'x/text' } },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      mention: { oneAtATime: true },
      skills: { safeMode: false, resultMaxChars: 2000, callTimeoutMs: 120000, loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
      innerLife: { mode: 'live', tickSeconds: 60, queueMax: 20, chatMessages: 30, review: { enabled: false, historyDays: 14 }, heartbeat: { enabled: false }, caps: { perChain: 3 }, ...innerLife },
      agents: { maxOpen: 3, web: { enabled: true, daily: { tasks: 10 } }, resultMaxChars: 1000, resultCooldownSeconds: 60, resultRetrySeconds: 30 },
      ...config,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      inner: INNER_TASK,
      labels,
    },
    reloadConfig: () => true,
  };
}

function fakeStore(gifs = null) {
  const store = {
    getGuild: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
  if (gifs) Object.assign(store, { findGif: (guildId, handle) => gifs[handle] ?? null, recordOwnGif: () => {} });
  return store;
}

/**
 * One boot: a turn runner, an inner life, an errand service with its result turns, all over the
 * chat and `dataDir` -- what src/index.js builds at start, less Discord. A second boot over the same
 * `dataDir` is a restart. `records` are the intentions (they outlive a boot, like their file would).
 * `die`: the errand service's end hook does nothing (the process died before the result turn).
 */
function boot(chat, {
  dataDir,
  records = [],
  hot = hotWith(),
  unwritable = [],
  recall = null,
  failOps = [],
  journal = null,
  record = null,
  gifs = null,
  runErrand = null,
  die = false,
  store = fakeStore(gifs),
  ready = undefined,
} = {}) {
  const intentions = fakeIntentions(records);
  const timers = [];
  const accepted = new Set();
  const client = {
    user: { id: SELF, username: 'Bot' },
    channels: {
      cache: new Map(),
      fetch: async (id) => {
        if (!['c1', 'c2', 'c3', 'c9', 'd1'].includes(String(id)) || String(id) === 'c9') return null;
        return chat.channel(String(id), { dm: String(id) === 'd1' });
      },
    },
  };
  const port = chat.port;
  const admin = createAdmin({ discord: DISCORD, hot, store, client, getGuildId: () => GUILD, port });
  const runOp = failOps.length === 0 ? admin.runSkillOp : async (op, args, context) => (failOps.includes(op) ? { status: 'failed', code: 'error', summary: 'it did not work', data: null } : admin.runSkillOp(op, args, context));

  // The errand service over the real task store; its runner is a fake that ends at once.
  const stores = createTaskStores({ dataDir, config: () => hot.config, log: SILENT });
  let taskTurns = null;
  const errands = createErrandService({
    client: { configured: () => true, run: async (task) => (runErrand ? runErrand(task) : { status: 'done', result: { text: 'found it' }, usage: { usd: 0.01 } }), cancel: () => true },
    stores,
    hot,
    getGuildId: () => GUILD,
    log: SILENT,
    onFinished: (task, guildId) => (die ? null : taskTurns.onFinished(task, guildId)),
  });

  const turns = createTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm: chat.llm,
    calibrator: { ratio: 1, apply: (value) => value, observe: () => {} },
    client,
    now: () => clock.t,
    port,
    skills: skillRegistry(),
    journal,
    runOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    errands,
    ...(recall ? { recall } : {}),
  });
  // Every turn that ends is recorded with the sends a fault failed during it.
  const recorded = {
    isAnyBusy: () => turns.isAnyBusy?.() ?? false,
    isBusy: (id) => turns.isBusy?.(id) ?? false,
    runTurn: async (params) => {
      chat.audience = params.channel?.id ?? null;
      const before = chat.sendAttempts;
      const result = await turns.runTurn(params);
      chat.results.push({ channelId: params.channel?.id ?? null, mode: params.mode, result, failedSends: chat.injected.filter((f) => f.n > before && f.n <= chat.sendAttempts) });
      return result;
    },
  };
  taskTurns = createTaskTurns({ hot, client, discord: DISCORD, turns: recorded, errands, getGuildId: () => GUILD, now: () => clock.t, setTimer: (fn, ms) => timers.push({ fn, ms }), log: SILENT });

  const unwritableIds = new Set(unwritable);
  let inner;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  inner = createInnerLife({
    hot,
    dataDir,
    turns: recorded,
    intentions,
    record,
    journal,
    client,
    discord: { canSend: (channel) => !unwritableIds.has(String(channel.id)) },
    ...(ready ? { ready } : {}),
    submit: (event) => {
      accepted.add(event.id);
      return door.submit(event);
    },
    store: { state: { data: {} } },
    getGuildId: () => GUILD,
    meter: { run: async (fn) => ({ result: await fn(), usd: 0, requests: 1, voice: 1 }) },
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  turns.setFactsSource(inner.facts);

  const quiet = async (fn) => (await withCapturedLogs(fn)).result;
  const world = {
    chat,
    hot,
    dataDir,
    store,
    client,
    port,
    turns,
    inner,
    errands,
    taskTurns,
    intentions,
    records,
    accepted,
    timers,
    journal,
    /** A wake handed to the door, as the scheduler would; remembered as accepted work. */
    accept: (wake) => {
      accepted.add(wake.id);
      return door.submit({ kind: 'inner.wake', at: clock.t, id: wake.id, guildId: GUILD, wake });
    },
    tick: () => quiet(() => inner.tick()),
    /** Alice's line in `conversationId`, answered by an addressed turn (the model's next answers are `chat.script`). */
    ask: (conversationId, text, { dm = false } = {}) =>
      quiet(async () => {
        const raw = chat.say(conversationId, 'u1', text);
        const trigger = { id: raw.id, channelId: raw.channelId, authorId: 'u1', authorName: 'Alice', self: false, bot: false, content: raw.cleanContent, ts: raw.createdTimestamp, replyToId: null, attachments: [], stickers: [] };
        return recorded.runTurn({ channel: chat.channel(conversationId, { dm }), ...(dm ? { guildId: GUILD } : {}), mode: 'reply', trigger, triggerKind: 'mention' });
      }),
    quiet,
    state: () => inner.state(GUILD),
    factKinds: () => inner.state(GUILD).facts.map((fact) => `${fact.kind}${fact.told ? ':told' : ''}`),
  };
  return world;
}

/** Starts `start()` (its promise is left hanging, as a dead process leaves it) and returns once the model call it hangs on was made. */
async function dieDuring(chat, start) {
  chat.hung = false;
  await withCapturedLogs(async () => {
    start().catch(() => {});
    for (let i = 0; i < 400 && !chat.hung; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.ok(chat.hung, 'the scenario reached the model call the process dies in');
  chat.hung = false;
}

/** The task of a request's text as a list of lines, for the tasks block. */
const tasksBlockOf = (text) => /<tasks>\n([\s\S]*?)\n<\/tasks>/.exec(text)?.[1] ?? '';

// ---- the invariant ----

/**
 * What no scenario may end with (spec section 1), checked from the fakes' records:
 * 1. no accepted work lost: every wake the door accepted is queued or has a handled outcome, and no
 *    errand is left open by a process that is gone;
 * 2. no false success: a turn that had a send fail never reads `spoke` with something delivered
 *    unless it says `partial` (or one of its calls is recorded as not ok);
 * 3. no blind duplicate: the persona never said the same text twice in one conversation;
 * 4. no premature told: a fact marked told is backed by a model answer that completed after it was born;
 * 5. audience-correct: nothing marked private (`privateMarks`) is in a request made in another conversation,
 *    and a private fact belongs to one of `privateChats`.
 */
function assertNoSilentFailure(run, { accepted = [], privateChats = ['d1'], privateMarks = [] } = {}) {
  const { chat } = run;
  const state = run.inner.state(GUILD);
  for (const id of new Set([...accepted, ...run.accepted])) {
    assert.ok(state.queue.some((wake) => wake.id === id) || state.handled[id], `1: the accepted wake ${id} is neither queued nor handled`);
  }
  const open = run.errands.store(GUILD)?.open() ?? [];
  assert.deepEqual(open.map((task) => task.id), [], '1: an errand is left open with no process to run it');
  for (const { channelId, mode, result, failedSends } of chat.results) {
    if (failedSends.length === 0) continue;
    const callNotOk = (result?.inner?.actions ?? []).some((action) => action.result !== 'ok');
    const readsAsSuccess = result?.outcome === 'spoke' && result.delivered === true && result.partial !== true && !callNotOk;
    assert.equal(readsAsSuccess, false, `2: the ${mode} turn in ${channelId} lost a send but reads as a success`);
  }
  const said = new Map();
  for (const message of chat.port.messages.values()) {
    if (message.authorId !== SELF || message.deleted) continue;
    const key = `${message.ref.conversationId}\n${message.text}`;
    said.set(key, (said.get(key) ?? 0) + 1);
  }
  for (const [key, count] of said) {
    if (count > 1) assert.fail(`3: the persona said twice in ${key.split('\n')[0]}: ${key.split('\n')[1]}`);
  }
  for (const fact of state.facts) {
    if (fact.told) assert.ok(chat.completed.some((done) => done.at >= fact.at), `4: the fact ${fact.kind} is told but no model answer completed after it was born`);
    if (fact.privateChat) assert.ok(privateChats.includes(fact.channelId), `5: a private fact belongs to ${fact.channelId}`);
  }
  for (const request of chat.requests) {
    if (request.audience !== null && privateChats.includes(request.audience)) continue;
    for (const mark of privateMarks) assert.ok(!request.text.includes(mark), `5: a request in ${request.audience} carries a private mark`);
  }
}

// ---- the rows ----

test('row 1: the process dies right after a wake is queued -- the wake runs after the reload, once, and is not queued twice by the due list', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1', { purpose: 'say good morning' })];
  const before = boot(chat, { dataDir, records });
  const wake = wakeOfDue({ intention: records[0], reason: 'due', at: records[0].dueAt });
  assert.deepEqual((await before.accept(wake)).status, 'ok');
  assert.equal(before.state().queue.length, 1);
  assert.equal(chat.llm.calls.length, 0, 'it died before any turn ran');

  const after = boot(chat, { dataDir, records });
  assert.deepEqual(after.state().queue.map((queued) => queued.id), [wake.id], 'the queue is read back from the disk');
  await after.tick();
  assert.equal(chat.llm.calls.length, 1, 'the wake ran after the reload, and the due list did not queue it a second time');
  assert.equal(after.state().handled[wake.id].outcome, 'skip');
  assert.deepEqual(after.state().queue, []);
  assertNoSilentFailure(after, { accepted: [wake.id] });
});

test('row 2: the process dies right after a message was sent -- the journal closes the post as said, and nothing is sent again', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const makeJournal = () => createJournal({ appendStore: createAppendStore({ fsyncMs: 0, log: SILENT }), dataDir, config: () => ({ thinkChars: 4000 }), now: () => clock.t });
  const hot = hotWith({ features: { journal: true } });
  const before = boot(chat, { dataDir, hot, journal: makeJournal() });
  chat.script = ['<msg>καλημέρα</msg>'];
  chat.dieAfterSend(1);
  await dieDuring(chat, () => before.ask('c1', 'say good morning'));
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'the message reached the chat; the process never learned it');

  // The restart: a fresh journal over the same files finds the post open and closes it from the chat.
  const after = makeJournal();
  const open = await after.pending(GUILD, { days: [utcDay(clock.t)] });
  assert.deepEqual(open.map((op) => op.name), ['post']);
  const reconciled = await after.reconcile(GUILD, { days: [utcDay(clock.t)], before: clock.t + HOUR_MS, fetchOwnMessages: async (conversationId, n) => chat.ownMessages(conversationId, n) });
  assert.deepEqual(reconciled, { succeeded: 1, unknown: 0 }, 'the post is on record as said, not failed and not unknown');
  assert.deepEqual(await after.pending(GUILD, { days: [utcDay(clock.t)] }), []);
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'the reconciliation sends nothing');
});

/** A journal over the scenario's data directory, and the start-up reconciliation of its open operations from the chat (src/index.js). */
function journalFor(chat, dataDir) {
  const journal = createJournal({ appendStore: createAppendStore({ fsyncMs: 0, log: SILENT }), dataDir, config: () => ({ thinkChars: 4000 }), now: () => clock.t });
  const ready = () => journal.reconcile(GUILD, { days: [utcDay(clock.t)], before: clock.t + HOUR_MS, fetchOwnMessages: async (conversationId, n) => chat.ownMessages(conversationId, n) });
  return { journal, ready };
}

test('row 2: the process dies after an inner turn sent a message and before the turn ended -- the reload does not run the turn again and post it twice, and she is told the turn was cut off', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1')];
  const hot = hotWith({ grants: ['message.create'], features: { journal: true } });
  const wake = wakeOfDue({ intention: records[0], reason: 'due', at: records[0].dueAt });
  const before = boot(chat, { dataDir, records, hot, journal: journalFor(chat, dataDir).journal });
  chat.script = ['<msg>καλημέρα</msg>'];
  chat.dieAfterSend(1);
  await dieDuring(chat, () => before.inner.tick());
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα']);
  const mark = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', GUILD, 'inner.json'), 'utf8')).inflight;
  assert.deepEqual([mark.wakeIds, mark.kind, mark.channelId, typeof mark.turnId], [[wake.id], 'intention_due', 'c1', 'string'], 'the turn in flight is on disk');

  const reborn = journalFor(chat, dataDir);
  const after = boot(chat, { dataDir, records, hot, journal: reborn.journal, ready: reborn.ready });
  chat.script = ['<msg>καλημέρα</msg>'];
  await after.tick();
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'no resend');
  assert.equal(chat.llm.calls.length, 1, 'the cut-off turn was not run again');
  assert.deepEqual([after.state().handled[wake.id]?.outcome, after.state().inflight, after.state().queue], ['interrupted', null, []]);
  const [fact] = after.state().facts;
  assert.deepEqual([fact.kind, fact.wake, fact.channelId, fact.privateChat, fact.told], ['interrupted', 'intention_due', 'c1', false, false]);
  assert.ok(fact.done.includes('message.create'), fact.done);

  // Her next request in that channel carries it, once.
  chat.script = ['<skip/>'];
  await after.ask('c1', 'hello');
  assert.ok(requestText(chat, 1).includes('cut off after') && requestText(chat, 1).includes('message.create'), requestText(chat, 1));
  assert.equal(after.state().facts[0].told !== false, true);
  assertNoSilentFailure(after, { accepted: [wake.id] });
});

test('row 2: the process dies after a tool call\'s send reached the chat and before its result was recorded -- the journal closes the call as unknown from the restart, and nothing is sent again', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const makeJournal = () => createJournal({ appendStore: createAppendStore({ fsyncMs: 0, log: SILENT }), dataDir, config: () => ({ thinkChars: 4000 }), now: () => clock.t });
  const hot = hotWith({ grants: ['message.create'], features: { journal: true } });
  const before = boot(chat, { dataDir, hot, journal: makeJournal() });
  chat.script = [toolAnswer('<think>x</think>', [call('message.create', { text: 'καλημέρα' })])];
  chat.dieAfterSend(1);
  await dieDuring(chat, () => before.ask('c1', 'say good morning'));
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'the message reached the chat; the process never learned it');

  const after = makeJournal();
  const open = await after.pending(GUILD, { days: [utcDay(clock.t)] });
  assert.deepEqual(open.map((op) => op.name), ['skill'], 'the call was opened and never closed');
  const reconciled = await after.reconcile(GUILD, { days: [utcDay(clock.t)], before: clock.t + HOUR_MS, fetchOwnMessages: async (conversationId, n) => chat.ownMessages(conversationId, n) });
  assert.deepEqual(reconciled, { succeeded: 0, unknown: 1 }, 'a call that may have taken effect is closed unknown, never failed and never sent again');
  assert.deepEqual(await after.pending(GUILD, { days: [utcDay(clock.t)] }), []);
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'the reconciliation sends nothing');
});

test('row 2: the process dies after an inner turn\'s tool call posted and before the turn ended -- the reload does not run the turn again and post it twice, and she is told the turn was cut off', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1')];
  const hot = hotWith({ grants: ['message.create'], features: { journal: true } });
  const wake = wakeOfDue({ intention: records[0], reason: 'due', at: records[0].dueAt });
  const before = boot(chat, { dataDir, records, hot, journal: journalFor(chat, dataDir).journal });
  chat.script = [toolAnswer('<think>x</think>', [call('message.create', { text: 'καλημέρα' })])];
  chat.dieAfterSend(1);
  await dieDuring(chat, () => before.inner.tick());
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα']);

  const reborn = journalFor(chat, dataDir);
  const after = boot(chat, { dataDir, records, hot, journal: reborn.journal, ready: reborn.ready });
  chat.script = [toolAnswer('<think>x</think>', [call('message.create', { text: 'καλημέρα' })])];
  await after.tick();
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'no resend');
  assert.equal(chat.llm.calls.length, 1, 'the cut-off turn was not run again');
  assert.deepEqual([after.state().handled[wake.id]?.outcome, after.state().inflight, after.state().queue], ['interrupted', null, []]);
  const [fact] = after.state().facts;
  assert.deepEqual([fact.kind, fact.wake, fact.channelId, fact.told], ['interrupted', 'intention_due', 'c1', false]);
  assertNoSilentFailure(after, { accepted: [wake.id] });
});

test('row 2: the process dies in an inner turn before anything went out -- the reload runs the wake again, once, and nothing is told as cut off', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1')];
  const hot = hotWith({ grants: ['message.create'], features: { journal: true } });
  const wake = wakeOfDue({ intention: records[0], reason: 'due', at: records[0].dueAt });
  const before = boot(chat, { dataDir, records, hot, journal: journalFor(chat, dataDir).journal });
  chat.script = [HANG];
  await dieDuring(chat, () => before.inner.tick());
  assert.deepEqual(chat.textsFromSelf('c1'), [], 'nothing went out');

  const reborn = journalFor(chat, dataDir);
  const after = boot(chat, { dataDir, records, hot, journal: reborn.journal, ready: reborn.ready });
  chat.script = ['<msg>καλημέρα</msg>'];
  await after.tick();
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'the wake ran again and said it once');
  assert.ok(chat.llm.calls.length >= 2, 'the interrupted call and the new turn');
  assert.deepEqual([after.state().handled[wake.id]?.outcome, after.state().inflight], ['spoke', null]);
  assert.deepEqual(after.state().facts.filter((fact) => fact.kind === 'interrupted'), []);
  assertNoSilentFailure(after, { accepted: [wake.id] });
});

test('row 3: the process dies after an errand\'s result was stored and before its result turn ran -- the turn is reopened after the reload and task.read gives the whole text', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const text = Array.from({ length: 250 }, (_, i) => `line${i}`).join(' ');
  const origin = chat.say('c1', 'u1', 'find the changelog');
  const runErrand = async () => ({ status: 'done', result: { text, sources: ['https://example.org/a'] }, usage: { usd: 0.02 } });
  const before = boot(chat, { dataDir, die: true, runErrand });
  const submitted = before.errands.submit({ guildId: GUILD, agent: 'web', goal: 'find the changelog', requester: { userId: 'u1', kind: 'member' }, origin: { channelId: 'c1', messageId: origin.id }, scope: 'group' });
  assert.equal(submitted.ok, true);
  await before.errands.idle();
  const id = submitted.task.id;
  assert.equal(before.errands.store(GUILD).get(id).state, 'done');
  assert.equal(chat.llm.calls.length, 0, 'the result turn never ran');

  const after = boot(chat, { dataDir, runErrand });
  await withCapturedLogs(async () => {
    after.errands.start(GUILD);
    for (let i = 0; i < 100 && chat.llm.calls.length === 0; i += 1) await flush(1);
    await flush();
  });
  assert.equal(chat.llm.calls.length, 1, 'the result turn is reopened after the reload');
  assert.ok(requestText(chat, 0).includes('<task_result>'), 'with the result in front of her');
  const task = after.errands.store(GUILD).get(id);
  assert.ok(task.seen && task.readAt, 'a turn that completed marks the task seen and read');

  // task.read pages through the whole text.
  const env = createOpsEnv({ discord: DISCORD, hot: after.hot, store: after.store, client: after.client, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => GUILD, errands: after.errands });
  let from = 0;
  let got = '';
  for (let page = 0; page < 10; page += 1) {
    const read = await runOp('task.read', from > 0 ? { id, from } : { id }, { env, guildId: GUILD, channelId: 'c1', userId: 'u1', roleIds: [] });
    assert.equal(read.status, 'ok');
    const lines = read.summary.split('\n');
    const at = lines.findIndex((line) => line.startsWith('result: characters'));
    got += lines[at + 1];
    const next = lines.find((line) => line.startsWith('next: from='));
    if (!next) break;
    from = Number(next.slice('next: from='.length));
  }
  assert.equal(got, text, 'task.read returned the full text');

  // A second restart does not open the same turn again.
  const third = boot(chat, { dataDir, runErrand });
  await withCapturedLogs(async () => {
    third.errands.start(GUILD);
    await flush();
  });
  assert.equal(chat.llm.calls.length, 1);
  assertNoSilentFailure(third);
});

test('row 4: the process dies before a fact was presented -- the fact is still untold after the reload and shows in the next turn, once', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  // i9 lands in a channel she cannot reach: a wakeDropped fact; i1 is queued behind it.
  const records = [intentionRecord('i9', { channelId: 'c9', dueAt: NOW0 - 2 * MINUTE_MS, purpose: 'announce the game night' }), intentionRecord('i1')];
  const before = boot(chat, { dataDir, records });
  await before.tick();
  assert.deepEqual(before.factKinds(), ['wakeDropped'], 'the drop is a fact at the moment it happens');
  // The next tick shows the fact to a turn that never answers: the process dies inside the model call.
  await dieDuring(chat, () => {
    chat.script = [HANG];
    return before.inner.tick();
  });
  assert.equal(chat.llm.calls.length, 1);
  assert.ok(requestText(chat, 0).includes('no-channel'), 'the dying turn had the fact in front of it');

  const after = boot(chat, { dataDir, records });
  assert.deepEqual(after.factKinds(), ['wakeDropped'], 'still untold after the reload');
  await after.tick();
  assert.equal(chat.llm.calls.length, 2);
  assert.ok(requestText(chat, 1).includes('no-channel'), 'shown in the next turn');
  assert.deepEqual(after.factKinds(), ['wakeDropped:told']);
  // An addressed turn afterwards has nothing left to tell.
  await after.ask('c1', 'hello');
  assert.ok(!requestText(chat, 2).includes('<wake>'), 'told once');
  assertNoSilentFailure(after);
});

test('row 5: a terminal call fails on the last loop step -- a callFailed fact shown in the next turn of that channel (inner), and in the next addressed turn of it (addressed)', async () => {
  // Inner: the last step's post fails with nothing after it.
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1')];
  const hot = hotWith({ grants: ['lore.list', 'message.create'], innerLife: { loop: { maxSteps: 1, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 } } });
  const inner = boot(chat, { dataDir, records, hot });
  chat.script = [toolAnswer('', [call('lore.list')]), '<msg>καλημέρα</msg>'];
  chat.failSend(1);
  await inner.tick();
  assert.equal(chat.llm.calls.length, 2, 'nothing follows the terminal call');
  const failed = inner.state().facts.filter((fact) => fact.kind === 'callFailed');
  assert.deepEqual(failed.map((fact) => [fact.skill, fact.status, fact.channelId, fact.told]), [['message.create', 'failed', 'c1', false]]);
  assert.equal(inner.state().queue[0]?.kind, 'feedback', 'a feedback wake carries it');
  await inner.tick();
  assert.equal(chat.llm.calls.length, 3, 'the next turn of that channel');
  assert.ok(requestText(chat, 2).includes('call message.create failed'), requestText(chat, 2));
  assert.ok(inner.state().facts.every((fact) => fact.told));
  assertNoSilentFailure(inner);

  // Addressed: the call failed and the step after it did not come.
  const dir2 = tempDir('nep-fault-');
  const chat2 = makeChat();
  const addressed = boot(chat2, { dataDir: dir2, hot: hotWith({ grants: ['lore.list'] }), failOps: ['lore.list'] });
  chat2.script = [toolAnswer('', [call('lore.list')]), providerLimit()];
  await addressed.ask('c1', 'look at the lore');
  assert.deepEqual(addressed.factKinds(), ['callFailed']);
  chat2.script = ['<skip/>'];
  await addressed.ask('c2', 'and here?');
  assert.ok(!requestText(chat2, 2).includes('lore.list failed'), 'not in another channel');
  await addressed.ask('c1', 'again');
  assert.ok(wakeBlockOf(requestText(chat2, 3)).includes('call lore.list failed'), wakeBlockOf(requestText(chat2, 3)));
  assert.deepEqual(addressed.factKinds(), ['callFailed:told']);
  assertNoSilentFailure(addressed);
});

test('row 6: the feedback turn itself fails -- its facts stay untold, the wake is retried, and they are shown once a turn completes', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1')];
  const hot = hotWith({ grants: ['lore.list', 'message.create'], innerLife: { loop: { maxSteps: 1, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 } } });
  const run = boot(chat, { dataDir, records, hot });
  chat.script = [toolAnswer('', [call('lore.list')]), '<msg>καλημέρα</msg>', providerLimit()];
  chat.failSend(1);
  await run.tick(); // the turn that loses the post
  await run.tick(); // the feedback turn, which fails
  assert.equal(chat.llm.calls.length, 3);
  assert.ok(requestText(chat, 2).includes('call message.create failed'));
  const untold = run.state().facts.filter((fact) => !fact.told).map((fact) => fact.kind);
  assert.ok(untold.includes('callFailed'), 'the fact was not marked told by a turn that failed');
  const retried = run.state().queue.find((wake) => wake.kind === 'feedback');
  assert.ok(retried, 'the feedback wake is still queued');
  assert.equal(retried.retry, 1);
  await run.tick();
  assert.equal(chat.llm.calls.length, 3, 'it waits for its retry time');

  clock.t = retried.notBefore + MINUTE_MS;
  chat.script = ['<skip/>'];
  await run.tick();
  assert.equal(chat.llm.calls.length, 4);
  assert.ok(requestText(chat, 3).includes('call message.create failed'), 'shown again once a turn can carry it');
  assert.ok(run.state().facts.every((fact) => fact.told));
  await run.tick();
  assert.equal(chat.llm.calls.length, 4, 'and not shown a third time');
  assertNoSilentFailure(run);
});

test('row 7: a chain at its cap holds a wake through a local midnight and a reload -- told at the hold, run after midnight, never dropped as chain-cap', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  // Europe/Athens is UTC+3 on this date: 12:00Z is 15:00 local, the local midnight is 21:00Z.
  const midnight = zonedEpoch('2026-10-20', 0, 0, 'Europe/Athens');
  assert.equal(midnight, Date.parse('2026-10-19T21:00:00Z'));
  const records = [intentionRecord('i1', { chainId: 'k', channelId: 'c1', dueAt: NOW0 - 2 * MINUTE_MS }), intentionRecord('i2', { chainId: 'k', channelId: 'c2', purpose: 'follow up later' })];
  const hot = hotWith({ timezone: 'Europe/Athens', innerLife: { caps: { perChain: 1 } } });
  const first = boot(chat, { dataDir, records, hot });
  await first.tick(); // i1 runs: the chain is at its cap
  assert.equal(chat.llm.calls.length, 1);
  await first.tick(); // i2 is held
  const held = first.state().facts.filter((fact) => fact.kind === 'wakeHeld');
  assert.deepEqual(held.map((fact) => [fact.code, fact.until, fact.channelId]), [['per-chain', midnight, 'c2']], 'a fact at the hold, with the moment it waits for');
  await first.tick(); // the feedback wake carrying the hold
  assert.equal(chat.llm.calls.length, 2);
  assert.ok(requestText(chat, 1).includes('held intention_due i2'), 'she is told at the hold');
  assert.equal(first.state().queue.filter((wake) => wake.kind === 'intention_due').length, 1);

  // The process restarts, still before midnight: the wake is still held, nothing new is said about it.
  const second = boot(chat, { dataDir, records, hot });
  await second.tick();
  assert.equal(chat.llm.calls.length, 2);
  assert.equal(second.state().facts.filter((fact) => fact.kind === 'wakeHeld').length, 1);

  // After the local midnight the wake runs.
  clock.t = midnight + MINUTE_MS;
  await second.tick();
  assert.equal(chat.llm.calls.length, 3);
  const i2 = wakeOfDue({ intention: records[1], reason: 'due', at: records[1].dueAt });
  assert.equal(second.state().handled[i2.id].outcome, 'skip');
  assert.equal(second.state().facts.filter((fact) => fact.kind === 'wakeDropped').length, 0, 'no wake was dropped');
  assertNoSilentFailure(second);
});

test('row 8: wakes of different chains meet one unwritable channel -- the writable one runs and the other is a wakeDropped fact with not-writable', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i2', { channelId: 'c2', dueAt: NOW0 - 3 * MINUTE_MS, purpose: 'post in the locked channel' }), intentionRecord('i1', { channelId: 'c1', dueAt: NOW0 - MINUTE_MS })];
  const run = boot(chat, { dataDir, records, unwritable: ['c2'] });
  await run.tick();
  await run.tick();
  assert.equal(chat.llm.calls.length, 1, 'the writable wake ran');
  const dropped = run.state().facts.find((fact) => fact.kind === 'wakeDropped');
  assert.deepEqual([dropped.code, dropped.why, dropped.channelId, dropped.intentionId], ['no-channel', 'not-writable', 'c2', 'i2']);
  assert.ok(requestText(chat, 0).includes('not writable'), 'and the drop was shown in it');
  assert.ok(run.state().facts.every((fact) => fact.told));
  assertNoSilentFailure(run);
});

test('row 8: the day\'s review rides with a wake whose channel is unwritable -- the review still runs', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  // The review's hours come from her lines of the record: one at 20:00Z yesterday, in c1.
  const line = { kind: 'said', messageId: 'r1', occurredAt: new Date(Date.parse('2026-10-18T20:10:00Z')).toISOString(), scope: { channel: 'c1' } };
  const record = { async *iterate() { yield line; } };
  const records = [intentionRecord('i2', { channelId: 'c2', dueAt: NOW0 + 3 * HOUR_MS, purpose: 'post in the locked channel' })];
  const hot = hotWith({ innerLife: { review: { enabled: true, historyDays: 14, expiredMax: 5 } } });
  const run = boot(chat, { dataDir, records, hot, unwritable: ['c2'], record });
  await run.tick(); // the review is drawn for the evening
  const review = run.state().review;
  assert.ok(Number.isFinite(review.at) && review.at > clock.t, 'the review is drawn inside her hours');
  // Both the review and the locked channel's wake come due before the next tick: they meet in one group.
  clock.t = review.at + MINUTE_MS;
  await run.tick();
  await run.tick();
  await run.tick();
  const reviewId = reviewWake('2026-10-19', review.at).id;
  assert.ok(chat.requests.length >= 1, 'a turn ran');
  assert.equal(run.state().handled[reviewId]?.outcome, 'skip', 'the review ran, whatever became of the unwritable wake');
  const dropped = run.state().facts.find((fact) => fact.kind === 'wakeDropped' && fact.wake === 'intention_due');
  assert.deepEqual([dropped?.code, dropped?.why, dropped?.channelId], ['no-channel', 'not-writable', 'c2'], 'the unwritable wake is a fact');
  assert.equal(run.state().facts.filter((fact) => fact.kind === 'wakeDropped' && fact.wake === 'review').length, 0, 'it was not dropped with the other wake');
  assertNoSilentFailure(run);
});

test('row 9: memory.search that timed out reads as a timeout; one that really found nothing reads as none', async () => {
  // The fixture labels word no timeout; this test words it itself, as the tracked labels do.
  const words = { ...labels, skills: { ...labels.skills, result: { ...labels.skills.result, reasons: { ...labels.skills.result.reasons, timeout: '{what} timed out' } } } };
  const hot = hotWith({ grants: ['memory.search'], features: { recall: true } });
  hot.prompts.labels = words;
  const search = async (outcome) => {
    const chat = makeChat();
    const recall = { available: () => true, run: async () => ({ text: null, stretch: null, people: [], quotes: [], stats: {}, outcome }) };
    const run = boot(chat, { dataDir: tempDir('nep-fault-'), hot, recall });
    chat.script = [toolAnswer('', [call('memory.search', { question: 'what did Éloïse say' })]), '<msg>ok</msg>'];
    await run.ask('c1', 'search for it');
    assert.equal(chat.llm.calls.length, 2);
    assertNoSilentFailure(run);
    return chat.llm.calls[1].filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : message.content.map((part) => part.text).join(''))).join('\n');
  };
  const timedOut = await search({ kind: 'timeout' });
  assert.match(timedOut, /timed out/, 'the cause is the timeout');
  assert.ok(!timedOut.includes(labels.skills.tools.memory.none), 'not "nothing found"');
  assert.ok(!timedOut.startsWith(labels.skills.result.ok), 'not a result that went well');
  const empty = await search({ kind: 'searched', degraded: false, failed: 0, total: 3 });
  assert.ok(empty.startsWith(labels.skills.result.ok), empty);
  assert.ok(empty.includes(labels.skills.tools.memory.none), 'a real empty result reads as none');
});

test('row 10: the text goes out and the GIF fails -- the turn is partial, the text is said, and the cause is in her next request (addressed and inner)', async () => {
  const gifs = { g1: { key: 'k1', id: 'g1', kind: 'link', url: 'https://tenor.example/cat' } };
  // Addressed: <msg> then <gif>; the second send fails.
  const chat = makeChat();
  const run = boot(chat, { dataDir: tempDir('nep-fault-'), gifs });
  chat.script = ['<msg>γεια</msg><gif>g1</gif>', '<skip/>'];
  chat.failSend(2);
  const first = await run.ask('c1', 'send me a cat');
  assert.deepEqual(chat.textsFromSelf('c1'), ['γεια'], 'the text is said');
  assert.equal(first.partial, true, 'the turn says partial');
  await run.ask('c1', 'did it work?');
  assert.ok(wakeBlockOf(requestText(chat, 1)).includes('call message.create'), wakeBlockOf(requestText(chat, 1)));
  assert.ok(requestText(chat, 1).includes('γεια'), 'the text is among her lines');
  assertNoSilentFailure(run);

  // Inner: the same tags are two calls; the GIF's fails and no step follows.
  const chat2 = makeChat();
  const records = [intentionRecord('i1')];
  const inner = boot(chat2, { dataDir: tempDir('nep-fault-'), records, gifs, hot: hotWith({ grants: ['message.create'] }) });
  chat2.script = ['<msg>γεια</msg><gif>g1</gif>', providerLimit()];
  chat2.failSend(2);
  await inner.tick();
  assert.deepEqual(chat2.textsFromSelf('c1'), ['γεια']);
  assert.deepEqual(inner.state().facts.filter((fact) => fact.kind === 'callFailed').map((fact) => fact.skill), ['message.create']);
  await inner.tick();
  assert.ok(requestText(chat2, 2).includes('call message.create'), 'the cause reaches her next turn there');
  assertNoSilentFailure(inner);
});

test('row 11: an errand completes and its result turn fails every time -- the task stays unread with the failed-turn note and task.read returns it', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const text = 'the changelog says: nothing breaking, two fixes, one new switch';
  const origin = chat.say('c1', 'u1', 'find the changelog');
  const run = boot(chat, { dataDir, runErrand: async () => ({ status: 'done', result: { text }, usage: { usd: 0.01 } }) });
  chat.fallback = providerLimit();
  const submitted = run.errands.submit({ guildId: GUILD, agent: 'web', goal: 'find the changelog', requester: { userId: 'u1', kind: 'member' }, origin: { channelId: 'c1', messageId: origin.id }, scope: 'group' });
  const id = submitted.task.id;
  await withCapturedLogs(async () => {
    await run.errands.idle();
    for (let i = 0; i < RESULT_ATTEMPTS + 5 && run.timers.length > 0; i += 1) {
      run.timers.shift().fn();
      await flush();
    }
  });
  assert.equal(chat.llm.calls.length, RESULT_ATTEMPTS, 'the turn was tried every time it could be');
  const task = run.errands.store(GUILD).get(id);
  assert.equal(task.state, 'done');
  assert.equal(task.resultTurnFailed, true, 'the task says its result turn never ran');
  assert.ok(!task.readAt, 'and it is unread');
  assert.deepEqual(run.errands.view({ guildId: GUILD }).map((t) => t.id), [id]);

  // A later turn of hers in that channel sees the task with its note.
  chat.fallback = '<skip/>';
  await run.ask('c1', 'anything new?');
  const line = tasksBlockOf(requestText(chat, chat.requests.length - 1));
  assert.ok(line.includes(id) && line.includes(labels.tasks.unread) && line.includes(labels.tasks.resultTurnFailed), line);
  const env = createOpsEnv({ discord: DISCORD, hot: run.hot, store: run.store, client: run.client, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => GUILD, errands: run.errands });
  const read = await runOp('task.read', { id }, { env, guildId: GUILD, channelId: 'c1', userId: 'u1', roleIds: [] });
  assert.equal(read.status, 'ok');
  assert.ok(read.summary.includes(text), 'task.read returns the result');
  assertNoSilentFailure(run);
});

test('row 12: a memory write fails -- the failure is logged, nothing is consumed, and her next request does not carry the unsaved fact', async () => {
  const dir = tempDir('nep-fault-');
  const store = createStore({ dataDir: dir });
  const hot = { config: { bot: { timezone: 'UTC' }, context: { gapMarkerMinutes: 20, maxMessageChars: 800 }, models: { core: 'x/y', helpers: { extractor: 'x/y' } }, llm: { temperature: 1, maxOutputTokens: 700, maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000, retries: 0, maxRequestsPerDay: 100 }, memory: { batchMessages: 15, minBatchMessages: 1, maxBatchAgeMinutes: 180, maxOutputTokens: 4000, fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 } }, prompts: { memory: 'sys', labels } };
  const llm = { complete: async () => ({ text: JSON.stringify({ users: { 1: { relationship: 'a secret the persona must not claim to know' } } }), usage: {}, estimated: 10 }) };
  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => clock.t });
  store.applyProfileOps = () => {
    throw new Error('disk refused');
  };
  const line = (id) => ({ id, channelId: 'c1', channelName: 'general', authorId: '1', authorName: 'Alice', self: false, bot: false, content: 'hello there', ts: clock.t, replyToId: null, attachments: [], stickers: [] });
  for (let i = 0; i < 20; i += 1) store.pushBuffer(GUILD, line(`m${i}`), 100);
  const { logs } = await withCapturedLogs(() => updater.run(GUILD));
  assert.ok(logs.some((entry) => entry.reason === 'apply-error'), 'the failure is logged');
  assert.equal(store.getBuffer(GUILD).length, 20, 'nothing was consumed');
  assert.equal(store.getUser(GUILD, '1')?.relationship ?? null, null, 'nothing was written');

  // Her next request, over the same store, carries nothing of it.
  const chat = makeChat();
  const run = boot(chat, { dataDir: tempDir('nep-fault-'), store: Object.assign(store, { getGuild: () => ({}), getMediaCache: () => ({}), listChannels: () => [], getLore: () => [], listUserProfiles: () => [], countUsers: () => 0, getPrivate: () => null }) });
  await run.ask('c1', 'do you remember me?');
  assert.ok(!requestText(chat, 0).includes('a secret the persona must not claim'));
  assertNoSilentFailure(run);
});

/** A memory updater over a store whose profile writes fail, with `lines` buffered lines of `channelId` (a DM when `privateUserId` is given). */
function failingMemory({ lines = 20, privateUserId = null, channelId = 'c1' } = {}) {
  const store = createStore({ dataDir: tempDir('nep-fault-') });
  const hot = { config: { bot: { timezone: 'UTC' }, context: { gapMarkerMinutes: 20, maxMessageChars: 800 }, models: { core: 'x/y', helpers: { extractor: 'x/y' } }, llm: { temperature: 1, maxOutputTokens: 700, maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000, retries: 0, maxRequestsPerDay: 100 }, memory: { batchMessages: 15, minBatchMessages: 1, maxBatchAgeMinutes: 180, maxOutputTokens: 4000, fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 } }, prompts: { memory: 'sys', labels } };
  const llm = { complete: async () => ({ text: JSON.stringify({ users: { [privateUserId ?? '1']: { relationship: 'something to keep' } } }), usage: {}, estimated: 10 }) };
  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => clock.t });
  const broken = () => {
    throw new Error('disk refused');
  };
  store.applyProfileOps = broken;
  store.applyPrivateOps = broken;
  const line = (id) => ({ id, channelId, channelName: 'general', authorId: privateUserId ?? '1', authorName: 'Alice', self: false, bot: false, content: 'hello there', ts: clock.t, replyToId: null, attachments: [], stickers: [] });
  for (let i = 0; i < lines; i += 1) {
    if (privateUserId) store.pushPrivateBuffer(GUILD, privateUserId, line(`m${i}`), 100);
    else store.pushBuffer(GUILD, line(`m${i}`), 100);
  }
  return { store, updater };
}

test('row 12: a memory write fails -- she is told, in the turn where she can read it, that what she was to remember was not kept, once per failing batch', async () => {
  const { store, updater } = failingMemory();
  const chat = makeChat();
  const run = boot(chat, { dataDir: tempDir('nep-fault-') });
  updater.setFactsSource(run.inner.facts);
  const failed = () => run.state().facts.filter((fact) => fact.kind === 'memoryFailed');

  await withCapturedLogs(async () => {
    await updater.run(GUILD);
    await updater.run(GUILD); // the back-off retry of the same batch
  });
  assert.equal(store.getBuffer(GUILD).length, 20, 'nothing was consumed');
  assert.equal(failed().length, 1, 'one fact for the failing batch, not one per retry');
  const [fact] = failed();
  assert.deepEqual([fact.code, fact.waiting, fact.channelId, fact.privateChat, fact.told], ['apply-error', 20, null, false, false]);

  // The next turn of hers, anywhere in the server, carries it; the fact is told once.
  await run.ask('c1', 'did you keep that?');
  assert.ok(requestText(chat, 0).includes('memory not kept apply-error 20 waiting'), requestText(chat, 0));
  assert.equal(failed()[0].told !== false, true);
  await run.ask('c1', 'and again');
  assert.ok(!requestText(chat, 1).includes('memory not kept'), 'told once');

  // The same batch failing again is not told again; once it is applied, a later failure is a new one.
  await withCapturedLogs(() => updater.run(GUILD));
  assert.equal(failed().length, 1);
  store.applyProfileOps = () => ({});
  await withCapturedLogs(() => updater.run(GUILD));
  assert.equal(store.getBuffer(GUILD).length < 20, true, 'the batch was applied');
  store.applyProfileOps = () => {
    throw new Error('disk refused');
  };
  for (let i = 0; i < 20; i += 1) store.pushBuffer(GUILD, { id: `n${i}`, channelId: 'c1', channelName: 'general', authorId: '1', authorName: 'Alice', self: false, bot: false, content: 'hello again', ts: clock.t, replyToId: null, attachments: [], stickers: [] }, 100);
  await withCapturedLogs(() => updater.run(GUILD));
  assert.equal(failed().length, 2, 'a failure after a success is a new fact');
  assertNoSilentFailure(run);
});

test('row 12: with no fact ledger (or the inner life off) a failed memory write stays a log line and the batch is kept', async () => {
  const { store, updater } = failingMemory();
  const { logs } = await withCapturedLogs(() => updater.run(GUILD));
  assert.ok(logs.some((entry) => entry.reason === 'apply-error'));
  updater.setFactsSource({ enabled: () => false, add: () => assert.fail('a disabled ledger takes nothing') });
  await withCapturedLogs(() => updater.run(GUILD));
  assert.equal(store.getBuffer(GUILD).length, 20);
});

test('row 12: a private layer write fails -- she is told in that private chat only', async () => {
  const mark = 'PRIVATE-LAYER-MARK';
  const { updater } = failingMemory({ lines: 20, privateUserId: 'u1', channelId: 'd1' });
  const chat = makeChat();
  const run = boot(chat, { dataDir: tempDir('nep-fault-') });
  updater.setFactsSource(run.inner.facts);
  await withCapturedLogs(() => updater.runPrivate(GUILD, 'u1'));
  const [fact] = run.state().facts;
  assert.deepEqual([fact.kind, fact.code, fact.channelId, fact.privateChat, fact.told], ['memoryFailed', 'apply-error', 'd1', true, false]);

  await run.ask('c1', 'hello');
  assert.ok(!requestText(chat, 0).includes('memory not kept'), 'not in a server channel');
  await run.ask('d1', 'hello in private', { dm: true });
  assert.ok(requestText(chat, 1).includes('memory not kept apply-error 20 waiting'), requestText(chat, 1));
  assertNoSilentFailure(run, { privateMarks: [mark], privateChats: ['d1'] });
});

test('row 13: a fact born in a DM is not shown in a server channel, and is shown in the next DM turn', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const mark = 'PRIVATE-ERRAND-MARK';
  // The DM intention cannot run (private chats are off): its drop is a fact of that chat.
  const dm = { ...intentionRecord('i7', { channelId: 'd1', scope: 'dm', purpose: mark }), provenance: { kind: 'self', channelId: 'd1', scope: 'dm' } };
  const records = [dm, intentionRecord('i1', { dueAt: NOW0 + MINUTE_MS })];
  const run = boot(chat, { dataDir, records });
  await run.tick();
  const [fact] = run.state().facts;
  assert.deepEqual([fact.kind, fact.code, fact.why, fact.channelId, fact.privateChat, fact.told], ['wakeDropped', 'no-channel', 'dm-off', 'd1', true, false]);

  // A server inner turn and an addressed server turn do not show it.
  clock.t = NOW0 + 2 * MINUTE_MS;
  await run.tick();
  assert.equal(chat.llm.calls.length, 1, 'the server wake ran');
  assert.ok(!requestText(chat, 0).includes(mark), 'not in an inner turn of the server');
  await run.ask('c1', 'hello');
  assert.ok(!requestText(chat, 1).includes(mark), 'not in an addressed turn of the server');
  assert.equal(run.state().facts[0].told, false, 'still waiting for its chat');

  // The next turn in that DM shows it, once.
  await run.ask('d1', 'hello in private', { dm: true });
  assert.ok(requestText(chat, 2).includes(mark), requestText(chat, 2));
  assert.equal(run.state().facts[0].told !== false, true);
  await run.ask('d1', 'and again', { dm: true });
  assert.ok(!requestText(chat, 3).includes(mark), 'told once');
  assertNoSilentFailure(run, { privateMarks: [mark], privateChats: ['d1'] });
});

test('row 14: the inner state file is corrupt at start -- a backup is written and a stateLost fact is shown in the next turn', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const file = path.join(dataDir, 'guilds', GUILD, 'inner.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"v":1,"queue":[{"id":"inner.wake:');
  const records = [intentionRecord('i1')];
  const run = boot(chat, { dataDir, records });
  await run.tick();
  const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('inner.json.bad-'));
  assert.equal(backups.length, 1, 'the unreadable file is kept aside');
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'), '{"v":1,"queue":[{"id":"inner.wake:', 'untouched');
  assert.equal(chat.llm.calls.length, 1, 'the due intention came back from its own store and ran');
  assert.ok(requestText(chat, 0).includes('inner state lost'), requestText(chat, 0));
  assert.deepEqual(run.factKinds(), ['stateLost:told']);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), 'the state file is whole again');
  assertNoSilentFailure(run);
});

test('row 15: a send times out and the message is in the chat -- nothing is told; with the message absent it is told as unclear', async () => {
  const timeout = { status: 'unknown', error: { code: 'timeout', retryable: false } };
  const attempt = async (arrives) => {
    const chat = makeChat();
    const run = boot(chat, { dataDir: tempDir('nep-fault-') });
    chat.script = ['<msg>ένα μήνυμα που ίσως έφτασε</msg>', '<skip/>'];
    chat.failSend(1, timeout);
    const first = await run.ask('c1', 'say it');
    assert.equal(first.partial, true, 'a send without an answer is not a plain success');
    assert.deepEqual(run.factKinds(), ['sendFailed']);
    if (arrives) chat.say('c1', SELF, 'ένα μήνυμα που ίσως έφτασε');
    await run.ask('c1', 'did it arrive?');
    return { run, chat };
  };
  const found = await attempt(true);
  assert.ok(!found.chat.requests[1].text.includes('<wake>'), 'it was found among her lines: no sendFailed');
  assert.deepEqual(found.run.state().facts.filter((fact) => !fact.told), []);
  assertNoSilentFailure(found.run);
  const missing = await attempt(false);
  assert.ok(wakeBlockOf(missing.chat.requests[1].text).includes('send unclear timeout'), wakeBlockOf(missing.chat.requests[1].text));
  assertNoSilentFailure(missing.run);
});
