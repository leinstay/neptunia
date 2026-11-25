// Tests for the drain of the inner life (src/behavior/inner/drain.ts): the budget of a chain and the turns of the
// local day, the cost meter of a run, and the current channel a wake's cause picks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chainBudget, createCostMeter, currentChannelOf, turnsToday } from '../../../../src/behavior/inner/drain.ts';
import { emptyState } from '../../../../src/behavior/inner/queue.ts';
import { heartbeatWake } from '../../../../src/behavior/inner/heartbeat.ts';
import { HOUR_MS, DAY_MS, MINUTE_MS, utcDay, zonedEpoch } from '../../../../src/time.ts';
import {
  NOW,
  intention,
  clock as innerDrainPlaceClock,
  hotWith as innerDrainPlaceHotWith,
  setup,
  SILENT as INNER_SILENT,
  fakeClient,
  fakeTurns,
  seeded,
} from '../../../fixtures/inner-rig.ts';
import type { FakeIntention, SetupOptions } from '../../../fixtures/inner-rig.ts';
import { wrongly, present } from '../../../fixtures/loose-types.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import type { InnerState, Wake, InnerTurnParams } from '../../../../src/behavior/inner/types.ts';
import { createTurnRunner } from '../../../../src/behavior/turn.ts';
import { createReads } from '../../../../src/interface/reads.ts';
import { userText } from '../../../../src/behavior/prompt.ts';
import {
  createInnerLife,
  wakeOfDue,
  heartbeatWake as innerDrainPlaceHeartbeatWake,
  chainBudget as innerChainBudget,
  createCostMeter as innerCreateCostMeter,
} from '../../../../src/behavior/inner.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { createEventDoor } from '../../../../src/interface/door.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import { personaJournal } from '../../../../src/behavior/inner/persona-sources.ts';
import { createErrandStores } from '../../../../src/errands/store.ts';
import { createErrandService } from '../../../../src/errands/service.ts';
import { createErrandTurns } from '../../../../src/errands/turns.ts';
import { runOp } from '../../../../src/tools/operations/index.ts';
import '../../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import { createAdmin } from '../../../../src/admin.ts';
import { labels } from '../../../fixtures/labels.ts';
import { call, completionOf, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { openTestMemorySync, openTestMemory } from '../../../fixtures/memory-db/service.ts';
import { wakeOf, deliveriesIn } from '../../../../src/memory/db/wake-queue.ts';
import type { WakeQueueUpdate } from '../../../../src/memory/db/wake-queue.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';
import { CODE } from '../../../../src/tools/codes.ts';
import { useIface, world } from '../../../fixtures/turn-world.ts';
import type { Fake } from '../../../fixtures/turn-world.ts';
import { createIntentionService } from '../../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../../src/intentions/store.ts';
import {
  DISCORD as INNER_WAKE_SENDS_DISCORD,
  fakeStore as innerWakeSendsFakeStore,
  hotWith as innerWakeSendsHotWith,
  personaGrants as innerWakeSendsPersonaGrants,
  rawMessage,
} from '../../../fixtures/turn-harness.ts';
import { worldTurnRunner } from '../../../fixtures/world-runner.ts';

/** A wake with only the fields a test sets; the code under test reads those and ignores the rest. */
const partialWake = (wake: Partial<Wake>): Wake => wrongly<Wake>(wake);

/** A real cost meter over its own listeners, and `emit` to log a line into it. */
function ownMeter() {
  const listeners = new Set<(entry: Record<string, Untyped>) => void>();
  const meter = createCostMeter({ subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) });
  return { meter, emit: (entry: Record<string, Untyped>) => listeners.forEach((fn) => fn(entry)) };
}

test('chainBudget and turnsToday: counted on the local day, a failed attempt is no turn', () => {
  const day = Date.parse('2026-10-19T00:00:00Z');
  const state: InnerState = {
    ...emptyState(),
    turns: wrongly([
      { at: day - HOUR_MS, chainId: 'a' },
      { at: day + HOUR_MS, chainId: 'a' },
      { at: day + 2 * HOUR_MS, chainId: 'a', failed: true },
      { at: day + 3 * HOUR_MS, chainId: 'b' },
    ]),
  };
  assert.deepEqual(chainBudget(state, 'a', 3, { now: NOW, timezone: 'UTC' }), { used: 1, cap: 3, left: 2 });
  assert.deepEqual(chainBudget(state, 'a', 1, { now: NOW, timezone: 'UTC' }), { used: 1, cap: 1, left: 0 });
  assert.equal(
    chainBudget(state, 'a', 3, { now: NOW + DAY_MS, timezone: 'UTC' }).used,
    0,
    'the next local day starts at nothing'
  );
  assert.equal(turnsToday(state, { now: NOW, timezone: 'UTC' }), 2);
});

test('createCostMeter: running() says what the run has cost so far and its costliest request; zeros outside it', async () => {
  const { meter, emit } = ownMeter();
  const seen: Array<Untyped> = [];
  const out = await meter.run(async () => {
    emit({ msg: 'llm: usage', role: 'core', cost: 0.2 });
    seen.push(meter.running());
    emit({ msg: 'llm: usage', role: 'helper', upstreamCost: 0.05, cost: 9 });
    seen.push(meter.running());
  });
  assert.deepEqual(seen, [
    { usd: 0.2, peak: 0.2 },
    { usd: 0.25, peak: 0.2 },
  ]);
  assert.deepEqual([out.usd, out.requests, out.voice], [0.25, 2, 1]);
  assert.deepEqual(meter.running(), { usd: 0, peak: 0 });
});

test("currentChannelOf: the cause of the wake picks the channel -- destination or the asking channel, the place, the errand's channel, the reported turn's; a heartbeat or no channel has none", () => {
  const due = (extra: Partial<Wake> = {}): Wake =>
    partialWake({
      kind: 'intention_due',
      intentionIds: ['i1'],
      placeId: 'c1',
      dmChat: false,
      ...extra,
    });
  assert.deepEqual(currentChannelOf([due()], [intention('i1')]), { placeId: 'c1', why: 'asked' });
  assert.deepEqual(currentChannelOf([due({ placeId: 'c2' })], [{ ...intention('i1'), destination: 'c2' }]), {
    placeId: 'c2',
    why: 'destination',
  });
  assert.deepEqual(
    currentChannelOf([due({ dmChat: true })], [{ ...intention('i1'), destination: 'c2' }]),
    { placeId: 'c1', why: 'asked' },
    'a private chat is where it was asked'
  );
  assert.deepEqual(currentChannelOf([wrongly({ kind: 'attend', intentionIds: ['i1'], placeId: 'c3' })]), {
    placeId: 'c3',
    why: 'attend',
  });
  assert.deepEqual(currentChannelOf([wrongly({ kind: 'errand_deadline', intentionIds: ['i1'], placeId: 'c4' })]), {
    placeId: 'c4',
    why: 'errand',
  });
  assert.deepEqual(currentChannelOf([partialWake({ kind: 'feedback', placeId: 'c1', here: 'c5' })]), {
    placeId: 'c5',
    why: 'feedback',
  });
  assert.deepEqual(
    currentChannelOf([partialWake({ kind: 'feedback', placeId: 'c1', here: null })]),
    { placeId: null, why: null },
    'the reported turn had none'
  );
  assert.deepEqual(
    currentChannelOf([partialWake({ kind: 'feedback', placeId: 'c1' })]),
    { placeId: 'c1', why: 'feedback' },
    'a wake queued before the field existed'
  );
  // The heartbeat is the wake that belongs to no place and must yield to another cause.
  assert.deepEqual(currentChannelOf([heartbeatWake(NOW)]), { placeId: null, why: null });
  assert.deepEqual(
    currentChannelOf([heartbeatWake(NOW), due()], [intention('i1')]),
    { placeId: 'c1', why: 'asked' },
    'a placeless wake beside another cause: the cause decides'
  );
  assert.deepEqual(currentChannelOf([due({ placeId: null })]), { placeId: null, why: null });
});

/** The memory database of each data directory used here (a restart opens the same one); closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();

after(async () => {
  for (const { close } of MEMORY.values()) await close();
});

function memoryOf(dataDir: string) {
  if (!MEMORY.has(dataDir)) MEMORY.set(dataDir, openTestMemorySync({ dataDir }));
  return present(MEMORY.get(dataDir)).memoryDb;
}

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

// ---- the chat: what survives a "death" (the chats, the model, the log of what was asked) ----

/**
 * The chat world: a fake port holding every message (seeded and sent), the channels reading their
 * history from it, a scripted model, and the records the invariant checks. It is built once per
 * scenario and outlives every boot.
 */
const names: Record<string, string> = { u1: 'Alice', u2: 'Zoë', [SELF]: 'Bot' };

type Chat = ReturnType<typeof makeChat>;

/** The scripted model of a chat: every request it got, and the answer it plays. */
type ChatLlm = {
  calls: Array<Array<Record<string, Untyped>>>;
  complete: (messages: Array<Record<string, Untyped>>) => Promise<unknown>;
};

function makeChat() {
  let stamp = 0;
  const port = createFakeAdapter({ iface: 'fake', selfId: SELF, now: () => clock.t - 5000 + (stamp += 1) });
  const injected: Array<Untyped> = []; // the sends a fault turned into a failure: { n, chat, text }
  const failures = new Map<number, Record<string, Untyped>>(); // send attempt number -> the result it gets
  const dyingAfter = new Set(); // send attempt numbers after which the process dies: the message is in the chat, the answer never comes
  let attempts = 0;
  const send = port.send.bind(port);
  port.send = wrongly<typeof port.send>(
    async (target: Parameters<typeof send>[0], content: Parameters<typeof send>[1]) => {
      attempts += 1;
      if (dyingAfter.has(attempts)) {
        await send(target, content);
        chat.hung = true;
        return new Promise(() => {});
      }
      const result = failures.get(attempts);
      if (!result) return send(target, content);
      port.calls.push({ op: 'send', args: [target, content] });
      injected.push({ n: attempts, chat: target.chatId, text: content?.text ?? '' });
      return result;
    }
  );

  // The chats of the chat: #c1, #c2 and #c3 of the root and the direct chat d1 (c9 is unknown to the interface).
  const infoOf = (id: string, { send = true }: { send?: boolean } = {}) => ({
    id,
    kind: id === 'd1' ? 'dm' : 'channel',
    rootId: id === 'd1' ? null : GUILD,
    name: id === 'd1' ? null : `chan-${id}`,
    topic: null,
    category: null,
    chatType: id === 'd1' ? 'dm' : 'channel',
    ...(id === 'd1' ? { partnerId: 'u1' } : {}),
    iface: 'fake',
    permissions: { read: true, send, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience:
      id === 'd1'
        ? null
        : {
            everyone: true,
            groups: [],
            groupAllow: [],
            groupDeny: [],
            memberAllow: [],
            memberDeny: [],
            memberGroups: {},
          },
  });
  for (const id of ['c1', 'c2', 'c3', 'd1']) port.seedChat(wrongly(infoOf(id)));

  const results: Array<Untyped> = []; // every turn that ended: { placeId, mode, result, failedSends }
  const requests: Array<{ audience: string | null; text: string }> = []; // every request a model call got: { audience, text }
  const completed: Array<Untyped> = []; // every model call that answered: { at, audience }
  const script: Array<Untyped> = []; // the next answers: a text, an Error, a function of the messages, or HANG
  const fallback: unknown = '<skip/>';
  const audience = null;
  const gifs = null;
  const llm = wrongly<ChatLlm>(null);
  const chat = {
    port,
    injected,
    results,
    requests,
    completed,
    script,
    fallback,
    hung: false,
    audience,
    gifs,
    /** The nth send attempt (1-based, counted over the whole scenario) fails with `result`. */
    failSend(n: number, result = { status: 'failed', error: { code: 'rate-limited', retryable: false } }) {
      failures.set(n, result);
    },
    /** The process dies right after the nth send attempt reached the chat. */
    dieAfterSend(n: number) {
      dyingAfter.add(n);
    },
    get sendAttempts() {
      return attempts;
    },
    /** Where the persona may write: the chats in `unwritable` may not be written in, the others may. */
    permit(unwritable: Array<string> = []) {
      for (const id of ['c1', 'c2', 'c3', 'd1'])
        port.seedChat(wrongly(infoOf(id, { send: !unwritable.includes(wrongly(id)) })));
    },
    /** A line by `authorId` in `chatId` (the persona's own when it is `SELF`); its raw form. */
    /**
     */
    say(chatId: string, authorId: Untyped, text: string) {
      stamp += 1;
      const at = clock.t - 5000 + stamp;
      const id = `s${stamp}`;
      if (authorId === SELF) {
        port.seed(chatId, { authorId, text, messageId: id });
      } else {
        // A member's line is a whole event, the way an interface reports it, with the name the member goes by.
        port.seedEvent({
          kind: 'message.received',
          iface: 'fake',
          at,
          id: `fake:message:${id}`,
          chat: {
            id: chatId,
            kind: chatId === 'd1' ? 'dm' : 'channel',
            rootId: chatId === 'd1' ? null : GUILD,
            name: chatId === 'd1' ? null : `chan-${chatId}`,
          },
          message: {
            id,
            author: { id: authorId, name: names[authorId] ?? authorId, self: false, bot: false },
            content: text,
            sourceText: text,
            system: false,
            at,
            replyToId: null,
            replyPingAccountId: null,
            forwardedFrom: null,
            attachments: [],
            links: [],
            forwarded: [],
            stickers: [],
            emojis: [],
            reactions: [],
          },
          addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
        });
      }
      return { id, placeId: chatId, cleanContent: text, createdTimestamp: at };
    },
    ownMessages(chatId: string, n = 20) {
      return port
        .messagesIn(chatId)
        .filter((message) => message.authorId === SELF)
        .slice(-n)
        .map((message) => ({
          id: message.ref.messageId,
          content: message.text,
          replyToId: message.replyTo?.messageId ?? null,
          createdAt: message.at,
        }));
    },
    textsFromSelf(chatId: string) {
      return port
        .messagesIn(chatId)
        .filter((message) => message.authorId === SELF)
        .map((message) => message.text);
    },
    llm,
  };
  chat.llm = {
    calls: [],
    complete: async (messages: Array<Record<string, Untyped>>) => {
      const calls = chat.llm.calls;
      calls.push(messages);
      chat.requests.push(wrongly({ audience: chat.audience, text: userText(messages[1].content) }));
      let step: unknown = chat.script.length > 0 ? chat.script.shift() : chat.fallback;
      if (typeof step === 'function') step = await wrongly<(messages: Untyped) => Promise<unknown>>(step)(messages);
      if (step === HANG) {
        chat.hung = true;
        return new Promise(() => {});
      }
      if (step instanceof Error) throw step;
      chat.completed.push(wrongly({ at: clock.t, audience: chat.audience }));
      return completionOf(step);
    },
  };
  return chat;
}

/** The text of the request the model got as its `i`th call. */
const requestText = (chat: Chat, i: number): string => present(chat.requests[i]).text;

// ---- one boot of the engine over a data directory ----

const intentionRecord = (
  id: string,
  {
    dueAt = NOW0 - MINUTE_MS,
    placeId = 'c1',
    chainId = null,
    purpose = `purpose ${id}`,
    scope = 'group',
  }: { dueAt?: Untyped; placeId?: string; chainId?: Untyped; purpose?: string; scope?: string } = {}
) => ({
  id,
  status: 'pending',
  purpose,
  dueAt,
  chainId,
  destination: null,
  provenance: { kind: 'self', placeId, scope },
  createdAt: NOW0 - DAY_MS,
  updatedAt: NOW0 - DAY_MS,
  expiresAt: NOW0 + 7 * DAY_MS,
});

/** A fake intention service over `records` (mutable, outlives a boot): the due ones are pending with a passed dueAt. */
function fakeIntentions(records: Untyped) {
  return {
    records,
    due: () =>
      records
        .filter(
          (r: Record<string, Untyped>) => r.status === 'pending' && Number.isFinite(r.dueAt) && r.dueAt <= clock.t
        )
        .map((r: Record<string, Untyped>) => ({ intention: r, reason: 'due', at: r.dueAt })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records.filter((r: Record<string, Untyped>) => ['pending', 'waiting', 'proposed'].includes(r.status)),
    store: () => ({
      get: (id: string) => records.find((r: Record<string, Untyped>) => r.id === id) ?? null,
      list: () => records,
    }),
  };
}

const personaGrants = (names: Array<string>) =>
  Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: [SELF] }]));

function hotWith({
  features = {},
  wakes = {},
  timezone = 'UTC',
  grants = [],
  config = {},
}: {
  features?: Record<string, Untyped>;
  wakes?: Record<string, Untyped>;
  timezone?: string;
  grants?: Array<Untyped>;
  config?: Record<string, Untyped>;
} = {}) {
  return {
    config: {
      bot: { timezone, dryRunChannelId: '', ownerPerson: OWNER_PERSON, access: personaGrants(grants) },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        failedTurnsKept: 3,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {
        memory: true,
        reactions: true,
        multiMessage: true,
        typingSimulation: false,
        vision: false,
        callMarkers: true,
        coreTools: true,
        wakes: true,
        intentions: true,
        ...features,
      },
      models: { routes: chainsOf({ analyzer: 'x/text' }) },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      mention: { oneAtATime: true },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: {
        mode: 'live',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        caps: { perChain: 3 },
        ...wakes,
      },
      heartbeat: { enabled: false },
      errands: { maxOpen: 3, resultMaxChars: 1000, resultCooldownSeconds: 60, resultRetrySeconds: 30 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } } },
      ...config,
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      'turn/inner': INNER_TASK,
      labels,
    },
    reloadConfig: () => true,
  };
}

function fakeStore(gifs = null) {
  const store = {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
  };
  if (gifs)
    Object.assign(store, {
      findGif: (handle: string) => gifs[handle] ?? null,
      recordOwnGif: () => {},
    });
  return store;
}

/**
 * One boot: a turn runner, an inner life, an errand service with its result turns, all over the
 * chat and `dataDir` -- what src/index.ts builds at start, less Discord. A second boot over the same
 * `dataDir` is a restart. `records` are the intentions (they outlive a boot, like their file would).
 * `die`: the errand service's end hook does nothing (the process died before the result turn).
 */
function boot(
  chat: Chat,
  {
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
    innerMemory = null,
  }: {
    dataDir: string;
    records?: Array<Untyped>;
    hot?: ReturnType<typeof hotWith>;
    unwritable?: Array<string>;
    recall?: Untyped;
    failOps?: Array<string>;
    journal?: Untyped;
    record?: Untyped;
    gifs?: Untyped;
    runErrand?: Untyped;
    die?: boolean;
    store?: ReturnType<typeof fakeStore>;
    ready?: Untyped;
    innerMemory?: Untyped;
  }
) {
  const intentions = fakeIntentions(records);
  const timers: Array<Untyped> = [];
  const accepted = new Set();
  const client = { user: { id: SELF, username: 'Bot' } };
  const port = chat.port;
  chat.permit(unwritable);
  const reads = createReads(port, SILENT);
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === GUILD,
    port,
    reads,
  });
  const runOp =
    failOps.length === 0
      ? admin.runSkillOp
      : async (op: string, args: Record<string, Untyped>, context: Record<string, Untyped>) =>
          failOps.includes(op)
            ? { status: 'failed', code: 'error', summary: 'it did not work', data: null }
            : admin.runSkillOp(op, args, context);

  // The errand service over the real task store; its runner is a fake that ends at once.
  const stores = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: SILENT });
  let taskTurns = wrongly<ReturnType<typeof createErrandTurns>>(null);
  const errands = createErrandService({
    client: {
      configured: () => true,
      run: async (task) =>
        runErrand ? runErrand(task) : { status: 'done', result: { text: 'found it' }, usage: { usd: 0.01 } },
      cancel: () => true,
    },
    stores,
    hot,
    log: SILENT,
    onFinished: (task) => (die ? null : taskTurns.onFinished(task)),
  });

  const turns = createTurnRunner({
    hot,
    store,
    llm: chat.llm,
    calibrator: { ratio: 1, apply: (value) => value, observe: () => {} },
    now: () => clock.t,
    port,
    reads,
    selfId: () => SELF,
    getSelfName: () => 'Bot',
    memberOf: (placeId: string, accountId: string) =>
      accountId in names ? { name: names[accountId], bot: false } : null,
    membersOf: () => Object.entries(names).map(([id, name]) => ({ id, name, bot: false })),
    chatName: (id: string) => (id === 'd1' ? null : `chan-${id}`),
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
    isBusy: (id: string) => turns.isBusy?.(id) ?? false,
    runTurn: async (params: Record<string, Untyped>) => {
      chat.audience = params.chat?.chatId ?? null;
      const before = chat.sendAttempts;
      const result = await turns.runTurn(params);
      chat.results.push({
        placeId: params.chat?.chatId ?? null,
        mode: params.mode,
        result,
        failedSends: chat.injected.filter((f) => f.n > before && f.n <= chat.sendAttempts),
      });
      return result;
    },
  };
  taskTurns = createErrandTurns({
    hot,
    reads,
    iface: () => 'fake',
    turns: recorded,
    errands,
    now: () => clock.t,
    setTimer: wrongly((fn: string, ms: Array<Record<string, Untyped>>) => timers.push({ fn, ms })),
    log: SILENT,
  });

  let inner: ReturnType<typeof createInnerLife>;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  inner = createInnerLife({
    hot,
    dataDir,
    turns: recorded,
    intentions,
    record,
    journal: journal ? personaJournal(wrongly(journal), () => [GUILD]) : null,
    reads,
    iface: () => 'fake',
    ...(ready ? { ready } : {}),
    submit: (event) => {
      accepted.add(event.id);
      return door.submit(event);
    },
    store: { state: { data: {} } },
    meter: { run: async (fn) => ({ result: await fn(), usd: 0, requests: 1, voice: 1 }) },
    ...(innerMemory ? { memoryDb: innerMemory } : {}),
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  turns.setFactsSource(inner.facts);

  const quiet = async (fn: () => unknown) => (await withCapturedLogs(fn)).result;
  const world = {
    chat,
    hot,
    dataDir,
    store,
    client,
    port,
    reads,
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
    accept: (wake: Record<string, Untyped>) => {
      accepted.add(wake.id);
      return door.submit({ kind: 'inner.wake', at: clock.t, id: wake.id, rootId: GUILD, wake });
    },
    tick: () => quiet(() => inner.tick()),
    /** Alice's line in `chatId`, answered by an addressed turn (the model's next answers are `chat.script`). */
    ask: (chatId: string, text: Untyped, { dm = false }: { dm?: boolean } = {}) =>
      quiet(async () => {
        const raw = chat.say(chatId, 'u1', text);
        const trigger = {
          id: raw.id,
          placeId: raw.placeId,
          authorId: 'u1',
          authorName: 'Alice',
          self: false,
          bot: false,
          content: raw.cleanContent,
          ts: raw.createdTimestamp,
          replyToId: null,
          attachments: [],
          stickers: [],
        };
        return recorded.runTurn({
          chat: { iface: 'fake', chatId },
          ...(dm ? { placeId: GUILD } : {}),
          mode: 'reply',
          trigger,
          triggerKind: 'mention',
        });
      }),
    quiet,
    state: () => inner.state(),
    factKinds: () =>
      inner.state().facts.map((fact: Record<string, Untyped>) => `${fact.kind}${fact.told ? ':told' : ''}`),
  };
  return world;
}

/** Starts `start()` (its promise is left hanging, as a dead process leaves it) and returns once the model call it hangs on was made. */
async function dieDuring(chat: Chat, start: () => Promise<unknown>) {
  chat.hung = false;
  await withCapturedLogs(async () => {
    start().catch(() => {});
    for (let i = 0; i < 400 && !chat.hung; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.ok(chat.hung, 'the scenario reached the model call the process dies in');
  chat.hung = false;
}

// ---- the invariant ----

/**
 * What no scenario may end with (spec section 1), checked from the fakes' records:
 * 1. no accepted work lost: every wake the door accepted is queued or has a handled outcome, and no
 *    errand is left open by a process that is gone;
 * 2. no false success: a turn that had a send fail never reads `spoke` with something delivered
 *    unless it says `partial` (or one of its calls is recorded as not ok);
 * 3. no blind duplicate: the persona never said the same text twice in one chat;
 * 4. no premature told: a fact marked told is backed by a model answer that completed after it was born;
 * 5. audience-correct: nothing marked private (`privateMarks`) is in a request made in another chat,
 *    and a private fact belongs to one of `dmChats`.
 */
/** What a test adds to the invariants: wakes it accepted, the private chats, and the marks that must stay private. */
type Invariants = { accepted?: Array<Untyped>; dmChats?: Untyped; privateMarks?: Array<Untyped> };

function assertNoSilentFailure(run: Record<string, Untyped>, options: Invariants = {}) {
  const { accepted = [], dmChats = ['d1'], privateMarks = [] } = options;
  const { chat } = run;
  const state = run.inner.state(GUILD);
  for (const id of new Set([...accepted, ...run.accepted])) {
    assert.ok(
      state.queue.some((wake: Record<string, Untyped>) => wake.id === id) || state.handled[id],
      `1: the accepted wake ${id} is neither queued nor handled`
    );
  }
  const open = run.errands.store()?.open() ?? [];
  assert.deepEqual(
    open.map((task: Record<string, Untyped>) => task.id),
    [],
    '1: an errand is left open with no process to run it'
  );
  for (const { placeId, mode, result, failedSends } of chat.results) {
    if (failedSends.length === 0) continue;
    const callNotOk = (result?.inner?.actions ?? []).some((action: Record<string, Untyped>) => action.result !== 'ok');
    const readsAsSuccess =
      result?.outcome === 'spoke' && result.delivered === true && result.partial !== true && !callNotOk;
    assert.equal(readsAsSuccess, false, `2: the ${mode} turn in ${placeId} lost a send but reads as a success`);
  }
  assertSaidOnce(chat);
  assertPrivateKept(chat, state, { dmChats, privateMarks });
}

/** Invariant 3: the persona never said the same thing twice in one chat. */
function assertSaidOnce(chat: Chat) {
  const said = new Map();
  const messages = chat.port.messages;
  for (const message of messages.values()) {
    if (message.authorId !== SELF || message.deleted) continue;
    const key = `${message.ref.chatId}\n${message.text}`;
    said.set(key, (said.get(key) ?? 0) + 1);
  }
  for (const [key, count] of said) {
    if (count > 1) assert.fail(`3: the persona said twice in ${key.split('\n')[0]}: ${key.split('\n')[1]}`);
  }
}

/** Invariants 4 and 5: a told fact has a model answer after it, and private facts and marks stay in the private chats. */
function assertPrivateKept(
  chat: Chat,
  state: Record<string, Untyped>,
  { dmChats, privateMarks }: { dmChats: Untyped; privateMarks: Array<Untyped> }
) {
  for (const fact of state.facts) {
    if (fact.told)
      assert.ok(
        chat.completed.some((done: { at: number }) => done.at >= fact.at),
        `4: the fact ${fact.kind} is told but no model answer completed after it was born`
      );
    if (fact.dmChat) assert.ok(dmChats.includes(fact.placeId), `5: a private fact belongs to ${fact.placeId}`);
  }
  for (const request of chat.requests) {
    if (request.audience !== null && dmChats.includes(request.audience)) continue;
    for (const mark of privateMarks)
      assert.ok(!request.text.includes(mark), `5: a request in ${request.audience} carries a private mark`);
  }
}

/** A journal over the scenario's data directory, and the start-up reconciliation of its open operations from the chat (src/index.ts). */
function journalFor(chat: Chat, dataDir: string) {
  const journal = createJournal({
    memoryDb: memoryOf(dataDir),
    dataDir,
    config: () => ({ thinkChars: 4000 }),
    now: () => clock.t,
  });
  const ready = () =>
    journal.reconcile(GUILD, {
      days: [utcDay(clock.t)],
      before: clock.t + HOUR_MS,
      fetchOwnMessages: async (chatId, n) => chat.ownMessages(chatId, n),
    });
  return { journal, ready };
}

test('row 2: the process dies after an inner turn sent a message and before the turn ended -- the reload does not run the turn again and post it twice, and the persona is told the turn was cut off', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1')];
  const hot = hotWith({ grants: ['message.create'], features: { journal: true } });
  const wake = wakeOfDue({ intention: records[0], reason: 'due', at: records[0].dueAt });
  // The in-flight mark is the running wake in the memory database (stage 4 cut, the lead's decision 1).
  // The test's memory service; its JS source leaves the read connection untyped, this is its shape while open.
  const innerMemory = memoryOf(dataDir);
  const before = boot(chat, { dataDir, records, hot, journal: journalFor(chat, dataDir).journal, innerMemory });
  chat.script = ['<msg>καλημέρα</msg>'];
  chat.dieAfterSend(1);
  await dieDuring(chat, () => before.inner.tick());
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα']);
  const mark = wakeOf(present(innerMemory.readHandle()), wake.id);
  assert.deepEqual(
    [present(mark).state, present(mark).kind, present(mark).payload.placeId, typeof present(mark).turnId],
    ['running', 'intention_due', 'c1', 'string'],
    'the turn in flight is on disk'
  );

  const reborn = journalFor(chat, dataDir);
  const after = boot(chat, { dataDir, records, hot, journal: reborn.journal, ready: reborn.ready, innerMemory });
  chat.script = ['<msg>καλημέρα</msg>'];
  await after.tick();
  assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'no resend');
  const calls = chat.llm.calls;
  assert.equal(calls.length, 1, 'the cut-off turn was not run again');
  assert.deepEqual(
    [after.state().handled[wake.id]?.outcome, after.state().inflight, after.state().queue],
    ['interrupted', null, []]
  );
  const [fact] = after.state().facts;
  assert.deepEqual(
    [fact.kind, fact.wake, fact.placeId, fact.dmChat, fact.told],
    ['interrupted', 'intention_due', 'c1', false, false]
  );
  const done = wrongly<Array<string>>(fact.done);
  assert.ok(done.includes('message.create'), wrongly(done));

  // The persona's next request in that channel carries it, once.
  chat.script = ['<skip/>'];
  await after.ask('c1', 'hello');
  assert.ok(
    requestText(chat, 1).includes('cut off after') && requestText(chat, 1).includes('message.create'),
    requestText(chat, 1)
  );
  assert.equal(after.state().facts[0].told !== false, true);
  assertNoSilentFailure(after, { accepted: [wake.id] });
});

test("row 2: the process dies after an inner turn's tool call posted and before the turn ended -- the reload does not run the turn again and post it twice, and the persona is told the turn was cut off", async () => {
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
  const calls = chat.llm.calls;
  assert.equal(calls.length, 1, 'the cut-off turn was not run again');
  assert.deepEqual(
    [after.state().handled[wake.id]?.outcome, after.state().inflight, after.state().queue],
    ['interrupted', null, []]
  );
  const [fact] = after.state().facts;
  assert.deepEqual([fact.kind, fact.wake, fact.placeId, fact.told], ['interrupted', 'intention_due', 'c1', false]);
  assertNoSilentFailure(after, { accepted: [wake.id] });
});

test('row 2: an unfinished inner turn is interrupted after reload even when nothing went out', async () => {
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
  // An empty journal cannot authorize replay of an unfinished action.
  assert.deepEqual(chat.textsFromSelf('c1'), [], 'restart sends nothing');
  const calls = chat.llm.calls;
  assert.equal(calls.length, 1, 'only the original interrupted model call');
  assert.deepEqual([after.state().handled[wake.id]?.outcome, after.state().inflight], ['interrupted', null]);
  assert.deepEqual(
    after.state().facts.filter((fact: Record<string, Untyped>) => fact.kind === 'interrupted'),
    []
  );
  assertNoSilentFailure(after, { accepted: [wake.id] });
});

test('row 6: the feedback turn itself fails -- its facts stay untold, the wake is retried, and they are shown once a turn completes', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1')];
  const hot = hotWith({
    grants: ['lore.list', 'message.create'],
    wakes: { loop: { maxSteps: 1, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 } },
  });
  const run = boot(chat, { dataDir, records, hot });
  chat.script = [toolAnswer('', [call('lore.list')]), '<msg>καλημέρα</msg>', providerLimit()];
  chat.failSend(1);
  await run.tick(); // the turn that loses the post
  await run.tick(); // the feedback turn, which fails
  const calls = chat.llm.calls;
  assert.equal(calls.length, 3);
  assert.ok(requestText(chat, 2).includes('call message.create failed'));
  const untold = run
    .state()
    .facts.filter((fact: Record<string, Untyped>) => !fact.told)
    .map((fact: Record<string, Untyped>) => fact.kind);
  assert.ok(untold.includes('callFailed'), 'the fact was not marked told by a turn that failed');
  const retried = run.state().queue.find((wake: Record<string, Untyped>) => wake.kind === 'feedback');
  assert.ok(retried, 'the feedback wake is still queued');
  assert.equal(retried.retry, 1);
  await run.tick();
  const calls2 = chat.llm.calls;
  assert.equal(calls2.length, 3, 'it waits for its retry time');

  clock.t = present(retried.notBefore) + MINUTE_MS;
  chat.script = ['<skip/>'];
  await run.tick();
  const calls3 = chat.llm.calls;
  assert.equal(calls3.length, 4);
  assert.ok(requestText(chat, 3).includes('call message.create failed'), 'shown again once a turn can carry it');
  assert.ok(run.state().facts.every((fact: Record<string, Untyped>) => fact.told));
  await run.tick();
  const calls4 = chat.llm.calls;
  assert.equal(calls4.length, 4, 'and not shown a third time');
  assertNoSilentFailure(run);
});

test('row 7: a chain-cap hold retains its fact after reload and midnight without replay', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  // Europe/Athens is UTC+3 on this date: 12:00Z is 15:00 local, the local midnight is 21:00Z.
  const midnight = zonedEpoch('2026-10-20', 0, 0, 'Europe/Athens');
  assert.equal(midnight, Date.parse('2026-10-19T21:00:00Z'));
  const records = [
    intentionRecord('i1', { chainId: 'k', placeId: 'c1', dueAt: NOW0 - 2 * MINUTE_MS }),
    intentionRecord('i2', { chainId: 'k', placeId: 'c2', purpose: 'follow up later' }),
  ];
  const hot = hotWith({ timezone: 'Europe/Athens', wakes: { caps: { perChain: 1 } } });
  const first = boot(chat, { dataDir, records, hot });
  await first.tick(); // i1 runs: the chain is at its cap
  const calls = chat.llm.calls;
  assert.equal(calls.length, 1);
  await first.tick(); // i2 is held
  const held = first.state().facts.filter((fact: Record<string, Untyped>) => fact.kind === 'wakeHeld');
  assert.deepEqual(
    held.map((fact: Record<string, Untyped>) => [fact.code, fact.until, fact.placeId]),
    [['per-chain', midnight, 'c2']],
    'a fact at the hold, with the moment it waits for'
  );
  await first.tick(); // the feedback wake carrying the hold
  const calls2 = chat.llm.calls;
  assert.equal(calls2.length, 2);
  assert.ok(requestText(chat, 1).includes('held intention_due i2'), 'the persona is told at the hold');
  assert.equal(first.state().queue.filter((wake: Record<string, Untyped>) => wake.kind === 'intention_due').length, 1);

  // Restart interrupts the held action while preserving the fact already presented.
  const second = boot(chat, { dataDir, records, hot });
  await second.tick();
  const calls3 = chat.llm.calls;
  assert.equal(calls3.length, 2);
  assert.equal(second.state().facts.filter((fact: Record<string, Untyped>) => fact.kind === 'wakeHeld').length, 1);

  // The cap reset does not authorize replay of the abandoned action.
  clock.t = midnight + MINUTE_MS;
  await second.tick();
  const calls4 = chat.llm.calls;
  assert.equal(calls4.length, 2);
  const i2 = wakeOfDue({ intention: records[1], reason: 'due', at: records[1].dueAt });
  assert.equal(second.state().handled[i2.id].outcome, 'interrupted');
  assert.equal(
    second.state().facts.filter((fact: Record<string, Untyped>) => fact.kind === 'wakeDropped').length,
    0,
    'no wake was dropped'
  );
  assertNoSilentFailure(second);
});

// A due intention whose place the persona cannot write in is not dropped no-channel. Its turn runs nowhere and its
// `<feedback>` names the failure, and the intention stays theirs to defer, drop or place.
test('row 8: wakes of different chains meet one unwritable channel -- the writable one runs, and the other runs nowhere with not-writable in its feedback', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [
    intentionRecord('i2', { placeId: 'c2', dueAt: NOW0 - 3 * MINUTE_MS, purpose: 'post in the locked channel' }),
    intentionRecord('i1', { placeId: 'c1', dueAt: NOW0 - MINUTE_MS }),
  ];
  const run = boot(chat, { dataDir, records, unwritable: ['c2'] });
  await run.tick();
  await run.tick();
  const calls = chat.llm.calls;
  assert.equal(calls.length, 2, 'both wakes ran');
  const feedbackOf = (n: number) => {
    const text = requestText(chat, n);
    return text.slice(text.indexOf('<feedback>'), text.indexOf('</feedback>'));
  };
  assert.ok(feedbackOf(0).includes('place gone: not writable'), requestText(chat, 0));
  assert.ok(!requestText(chat, 1).includes('place gone'), 'the writable one has no such line');
  assert.equal(
    run.state().facts.filter((fact: Record<string, Untyped>) => fact.kind === 'wakeDropped').length,
    0,
    'nothing was dropped'
  );
  assert.equal(records[0].status, 'pending', 'the intention is kept');
  assertNoSilentFailure(run);
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

useIface('fake');

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** An intention due a minute ago with `destination` as its place, made where no chat was (a heartbeat). */
function placed(id: string, destination: string | null): FakeIntention {
  return wrongly<FakeIntention>({
    ...intention(id),
    destination,
    provenance: { kind: 'self', placeId: null, scope: 'group' },
    origin: 'heartbeat',
  });
}

/** The chat the first turn was handed: null when the key is there and empty, undefined when it is missing. */
function chatOf(params: object | undefined): unknown {
  return params && Object.hasOwn(params, 'chat') ? Reflect.get(params, 'chat') : undefined;
}

test('a heartbeat runs with no chat and no stand-in', async () => {
  // Bug: the heartbeat still rides on a recent room or on the stand-in, and its turn reads that room as a chat.
  innerDrainPlaceClock.t = NOW;
  const run = setup();
  const wake = innerDrainPlaceHeartbeatWake(NOW - 60_000);
  assert.deepEqual(run.inner.onWake({ kind: 'inner.wake', at: NOW, id: wake.id, wake }), { status: 'queued' });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  const [params] = calls;
  assert.equal(chatOf(params), null);
  assert.equal(params === undefined ? undefined : Reflect.get(params, 'standIn'), undefined);
});

test('an intention without a place runs with no chat', async () => {
  // Bug: the drain picks a room the persona spoke in lately, and an intention with no place reads as a reply there.
  innerDrainPlaceClock.t = NOW;
  const run = setup({ records: [placed('i1', null)] });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  assert.equal(chatOf(calls[0]), null);
});

test('a due intention whose place is gone runs nowhere with the failure in its wake, and stays open', async () => {
  // Bug: the wake is dropped and the intention lost, or the drain picks another room on its own.
  innerDrainPlaceClock.t = NOW;
  const records = [placed('i1', 'c9')];
  const run = setup({ records });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  const [params] = calls;
  assert.equal(chatOf(params), null);
  assert.ok(JSON.stringify(params?.inner.wake ?? {}).includes(CODE.UNAVAILABLE), 'the code of the gone place');
  assert.equal(records[0]?.status, 'pending');
});

test("an intention whose place is the command line's chat runs there, found through the command line", async () => {
  // Bug: the drain asks the served interface for `cli:dm:owner`, which knows no such chat, so the turn runs nowhere.
  innerDrainPlaceClock.t = NOW;
  const cliChat = {
    id: 'cli:dm:owner',
    kind: 'dm',
    rootId: null,
    name: 'owner',
    partnerId: 'owner',
    iface: 'cli',
    permissions: { read: true, send: true, attach: true, react: false },
  };
  const client = wrongly<SetupOptions['client']>({
    reads: {
      chatInfo: (chat: { iface: string; chatId: string }) =>
        Promise.resolve(chat.iface === 'cli' && chat.chatId === 'cli:dm:owner' ? { chat: cliChat } : null),
    },
  });
  const hot = wrongly<SetupOptions['hot']>({ config: { ...innerDrainPlaceHotWith().config, dm: { enabled: true } } });
  const run = setup({ records: [placed('i1', 'cli:dm:owner')], client, hot });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  assert.deepEqual(chatOf(calls[0]), { iface: 'cli', chatId: 'cli:dm:owner' });
});

// docs/cli.md under Access: the owner's command line is a chat of its own and stays open while `dm.enabled` is
// false, so a wake anchored there runs there as a line typed there would.
test("an intention whose place is the command line's chat runs there while direct chats are off", async () => {
  // Bug: the gate let the owner's lines through, yet the persona's reminder in that chat ran nowhere with dm-off.
  innerDrainPlaceClock.t = NOW;
  const cliChat = {
    id: 'cli:dm:owner',
    kind: 'dm',
    rootId: null,
    name: 'owner',
    partnerId: 'owner',
    iface: 'cli',
    permissions: { read: true, send: true, attach: true, react: false },
  };
  const client = wrongly<SetupOptions['client']>({
    reads: {
      chatInfo: (chat: { iface: string; chatId: string }) =>
        Promise.resolve(chat.iface === 'cli' && chat.chatId === 'cli:dm:owner' ? { chat: cliChat } : null),
    },
  });
  const hot = wrongly<SetupOptions['hot']>({ config: { ...innerDrainPlaceHotWith().config, dm: { enabled: false } } });
  const run = setup({ records: [placed('i1', 'cli:dm:owner')], client, hot });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  assert.deepEqual(chatOf(calls[0]), { iface: 'cli', chatId: 'cli:dm:owner' });
});

useIface('fake');

const ROOT = 'g1';

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const T = Date.parse('2026-10-31T12:00:00Z');

const LEASE_MS = MINUTE;

const INNER_WAKE_SENDS_SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const CLIENT = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };

/** The answer of a model call that never comes back: the process dies inside it. */
const DIES = Object.freeze({ dies: true });

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

type PauseFlags = { paused?: boolean; pausedAt?: string };

/** What one start of the core is given: the model's answers in turn (the last repeats), and how it dies. */
type Start = {
  publicationBoundary?: unknown;
  answers: ReadonlyArray<unknown>;
  /** The memory write that leaves a delivery queued never answers: the process dies right after that commit. */
  dieAtCommit?: boolean;
  /** The port the inner life sends through (the world's by default). */
  port?: Fake;
  /** Called with the inner life when a write first leaves a delivery queued, right after that commit. */
  atCommit?: (life: ReturnType<typeof createInnerLife>) => void;
};

/** The record of the persona's lines (src/memory/record.ts), as the turn runner and the inner life append to it. */
type Record_ = {
  lines: Array<unknown>;
  append(placeId: string, lines: ReadonlyArray<unknown>, options?: unknown): Promise<void>;
  iterate(): Array<unknown>;
};

/** The texts of the sends that reached `port`, in order. */
function sendsOf(port: Fake): Array<unknown> {
  return port.calls.filter((one) => one.op === 'send').map((one): unknown => Reflect.get(Object(one.args[1]), 'text'));
}

/** The service's read connection, which its JS source leaves untyped; refused when the database is not open. */
function readHandleOf(memory: Memory): { db: object } {
  const handle: unknown = memory.memoryDb.readHandle();
  const db: unknown = typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'db') : null;
  if (typeof db !== 'object' || db === null) throw new Error('the memory database is not open');
  return { db };
}

/** A model that answers `answers` in turn, records each request and the sends `port` had when it came, and can die. */
function scriptedModel(answers: ReadonlyArray<unknown>, port: Fake, died: () => void) {
  const requests: Array<string> = [];
  const sendsAtRequest: Array<number> = [];
  return {
    requests,
    sendsAtRequest,
    complete: (messages: unknown, options?: unknown): Promise<unknown> => {
      const tools: unknown = Reflect.get(Object(options), 'tools');
      requests.push(JSON.stringify({ messages, tools }));
      sendsAtRequest.push(sendsOf(port).length);
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
      if (answer === DIES) {
        died();
        return new Promise<unknown>(() => {});
      }
      return Promise.resolve(completionOf(answer));
    },
  };
}

/**
 * The live config of the core: the inner life in `mode`, the heartbeat on only when asked (every hour, no jitter).
 * PR 7d: the switches are code and a heartbeat holds to intention changes.
 */
function hotOf(mode: 'live' | 'shadow', heartbeat: boolean) {
  const hot = innerWakeSendsHotWith({
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: innerWakeSendsPersonaGrants([
      'lore.list',
      'message.create',
      'message.edit',
      'message.react.add',
      'intention.set',
    ]),
    config: {
      wakes: {
        mode,
        tickSeconds: 60,
        review: { historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: heartbeat ? { enabled: true, everyMinutes: 60, jitterMinutes: 0 } : { enabled: false },
    },
  });
  Object.assign(hot.config.context, { turnLeaseMs: LEASE_MS });
  Object.assign(hot.config, { intentions: { expiresDays: 14, maxOpen: 20 } });
  Object.assign(hot.prompts, { 'turn/inner': INNER_TASK });
  return hot;
}

/**
 * One core over a data directory, started with `first`: the memory database, a real turn runner and an inner life with
 * its door, over the world's channel c1. `restart(start)` opens a new database and builds a new runner and inner life over the same
 * directory, as a new process would; what ran in the old ones is left hanging. The clock, the intentions, the pause
 * flags and the interface outlive a restart.
 */
async function core(
  first: Start,
  {
    mode = 'live',
    heartbeat = false,
    record = null,
  }: { mode?: 'live' | 'shadow'; heartbeat?: boolean; record?: Record_ | null } = {}
) {
  // The heartbeat has no place: with reads that say no interface answers, it runs in its stand-in (drain.ts).
  const reads = heartbeat
    ? { chatInfo: world().reads.chatInfo.bind(world().reads), offers: () => false }
    : world().reads;
  world().channel({
    id: 'c1',
    name: 'chan-c1',
    placeId: ROOT,
    permissions: { send: true },
    historyMessages: [rawMessage({ id: 'm1', ts: T - HOUR, content: 'καλή σας μέρα' })],
  });
  const port = world().port;
  const clock = { t: T };
  const hot = hotOf(mode, heartbeat);
  const dataDir = tempDir('nep-inner-wake-sends-');
  const flags: PauseFlags = {};
  const service = createIntentionService({
    stores: createIntentionStores({ now: () => clock.t, log: INNER_WAKE_SENDS_SILENT }),
    hot,
    now: () => clock.t,
    log: INNER_WAKE_SENDS_SILENT,
  });
  const calls: Array<InnerTurnParams> = [];
  const results: Array<unknown> = [];

  /** A turn runner over the world, with a model that answers `answers`. */
  const runnerOf = (answers: ReadonlyArray<unknown>, died: () => void) => {
    const llm = scriptedModel(answers, port, died);
    const store = innerWakeSendsFakeStore();
    const admin = createAdmin({
      discord: INNER_WAKE_SENDS_DISCORD,
      hot,
      store,
      client: CLIENT,
      isServedRoot: (id: unknown) => id === ROOT,
      port,
      reads: world().reads,
      intentions: service,
      now: () => clock.t,
    });
    const runner = worldTurnRunner({
      hot,
      store,
      llm,
      calibrator: { ratio: 1, apply: (value: number) => value, observe: () => {} },
      now: () => clock.t,
      skills: skillRegistry(),
      journal: null,
      ...(record ? { record } : {}),
      runOp: admin.runSkillOp,
      runOwnOp: admin.runOwnSkillOp,
      runInitiativeOp: admin.runInitiativeSkillOp,
      intentions: service,
    });
    return { llm, runner };
  };

  const open = async (start: Start) => {
    let died: () => void = () => {};
    const dead = new Promise<'died'>((resolve) => (died = () => resolve('died')));
    const memory = await openTestMemory({
      dataDir,
      config: { context: { turnLeaseMs: LEASE_MS } },
      now: () => clock.t,
    });
    const { llm, runner } = runnerOf(start.answers, died);
    // The sends the port had when a delivery was first recorded queued (null while none was).
    const committed: { sends: number | null } = { sends: null };
    let life: ReturnType<typeof createInnerLife> | null = null;
    const memoryDb = {
      readHandle: () => memory.memoryDb.readHandle(),
      writeOperational: (write: Parameters<typeof memory.memoryDb.writeOperational>[0]) =>
        memory.memoryDb.writeOperational(write),
      memoryWrite: async (update: WakeQueueUpdate): Promise<unknown> => {
        // The synthetic persisted completion models a restricted producer, including malformed stored metadata.
        const stored =
          update.op === 'finish-group' && Object.hasOwn(start, 'publicationBoundary')
            ? {
                ...update,
                done: update.done.map((item) => ({
                  ...item,
                  deliveries: item.deliveries.map((delivery) => ({
                    ...delivery,
                    payload: {
                      ...(delivery.payload && typeof delivery.payload === 'object' ? delivery.payload : {}),
                      publicationBoundary: start.publicationBoundary,
                    },
                  })),
                })),
              }
            : update;
        const answer: unknown = await memory.memoryDb.memoryWrite(stored);
        if (committed.sends === null && deliveriesIn(readHandleOf(memory), 'queued').length > 0) {
          committed.sends = sendsOf(port).length;
          if (life) start.atCommit?.(life);
          if (start.dieAtCommit === true) {
            died();
            return new Promise<unknown>(() => {});
          }
        }
        return answer;
      },
    };
    let busy = 0;
    const door = createEventDoor({
      handlers: { 'inner.wake': (event: object) => life?.onWake(event) },
      log: INNER_WAKE_SENDS_SILENT,
    });
    life = createInnerLife({
      hot,
      dataDir,
      turns: {
        isAnyBusy: () => busy > 0,
        runTurn: async (params: InnerTurnParams) => {
          calls.push(params);
          busy += 1;
          try {
            const result: unknown = await runner.runTurn(params);
            results.push(result);
            return result;
          } finally {
            busy -= 1;
          }
        },
      },
      intentions: service,
      reads,
      // The inner life's record names no place (src/behavior/inner/persona-sources.ts).
      ...(record ? { record: { ...record, append: (lines: ReadonlyArray<unknown>) => record.append('', lines) } } : {}),
      iface: () => 'fake',
      chatName: (id: string) => `chan-${id}`,
      submit: (event: object) => door.submit(event),
      store: { state: { data: flags } },
      meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
      memoryDb,
      port: start.port ?? port,
      rng: () => 0.5,
      now: () => clock.t,
      log: INNER_WAKE_SENDS_SILENT,
    });
    return { memory, life, llm, dead, committed };
  };

  let current = await open(first);
  return {
    clock,
    service,
    port,
    calls,
    results,
    runnerOf,
    get life() {
      return current.life;
    },
    get memory(): Memory {
      return current.memory;
    },
    get llm() {
      return current.llm;
    },
    /** Resolves once this start's process died (a model call or a write that never answers). */
    get dead() {
      return current.dead;
    },
    get committed() {
      return current.committed;
    },
    async restart(start: Start) {
      await current.memory.close();
      current = await open(start);
    },
    close: () => current.memory.close(),
  };
}

type Core = Awaited<ReturnType<typeof core>>;

/** A one-off intention of the persona in c1 due at `dueAt`, and the id of the wake it gives. */
function dueIntention(run: Core, dueAt: number): { id: string; wakeId: string } {
  const made = run.service.set({ purpose: 'ask how the trip went', dueAt, placeId: 'c1', scope: 'group' });
  if (!made.ok) throw new Error(`intention not set: ${made.code}`);
  return { id: made.intention.id, wakeId: `inner.wake:intention_due:${made.intention.id}:${dueAt}` };
}

test("a wake turn whose calls were not held asks the model what the same turn asks without the drain's holding", async () => {
  // A read, then the request that carries its result.
  const answers = [toolAnswer('', [call('lore.list', {})]), '<skip/>'];
  const run = await core({ answers });
  try {
    dueIntention(run, T - MINUTE);
    await run.life.tick();
    const [params] = run.calls;
    assert.ok(params, 'the wake ran');
    const requests = run.llm.requests;
    assert.equal(requests.length, 2, 'the second request carries the read');
    // The turn as the drain hands it to the runner on main: these fields and no others.
    const asOnMain: Record<string, unknown> = {
      // Slice 5: the heartbeat's stand-in chat and its history are gone; a turn nowhere has `chat` null.
      ...(params.chat ? { chat: params.chat } : {}),
      mode: params.mode,
      triggerKind: params.triggerKind,
      journalTurn: params.journalTurn,
      inner: {
        wake: params.inner.wake,
        currentChannel: params.inner.currentChannel,
        shadow: params.inner.shadow,
        mayAct: params.inner.mayAct,
      },
    };
    const replay = run.runnerOf(answers, () => {});
    await replay.runner.runTurn(asOnMain);
    const requests3 = run.llm.requests;
    const requests2 = replay.llm.requests;
    assert.equal(requests2.length, requests3.length);
    for (const [index, request] of requests3.entries())
      assert.equal(request, requests2[index], `request ${index} is byte-identical`);
  } finally {
    await run.close();
  }
});

useIface('fake');

const innerSettle = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => void (innerDrainPlaceClock.t = NOW));

test('inner: while a turn holds the attention or a ping waits the wake keeps its due time, then runs once free', async () => {
  let waiting = true;
  const run = setup({ records: [intention('i1', { dueAt: NOW - 5 * MINUTE_MS })], peopleWaiting: () => waiting });
  run.turns.busy = true;
  const held = await run.inner.tick();
  assert.deepEqual(held.drained, { deferred: 'busy' });
  run.turns.busy = false;
  const people = await run.inner.tick();
  assert.deepEqual(people.drained, { deferred: 'people' });
  const calls = run.turns.calls;
  assert.equal(calls.length, 0);
  assert.equal(run.inner.status().queue[0].dueAt, NOW - 5 * MINUTE_MS);
  waiting = false;
  innerDrainPlaceClock.t = NOW + 10 * MINUTE_MS;
  await run.inner.tick();
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, 1);
});

test('inner: a turn held back by the runner (busy) leaves its wakes queued', async () => {
  const turns = fakeTurns({ answer: () => ({ outcome: 'busy' }) });
  const run = setup({ records: [intention('i1')], turns });
  await run.inner.tick();
  assert.equal(run.inner.status().queue.length, 1);
});

test('inner: a chain past its cap is held, not dropped: its wake waits capped per-chain and runs after the local midnight', async () => {
  const caps = { perChain: 1 };
  const run = setup({
    records: [intention('i1', { chainId: 'k' }), intention('i2', { chainId: 'k', placeId: 'c2' })],
    hot: innerDrainPlaceHotWith({ wakes: { caps } }),
  });
  await run.inner.tick();
  assert.deepEqual((await run.inner.tick()).drained, { refused: 'per-chain' });
  // The hold is told by a feedback wake (no turn was coming to carry it); no cap holds that.
  assert.deepEqual(
    run.inner.state().queue.map((wake) => wake.kind),
    ['intention_due', 'feedback']
  );
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 2);
  const inner = calls[1].inner;
  assert.equal(inner.wake.kind, 'feedback');
  assert.equal(run.inner.state().queue.length, 1, 'the held wake stays queued');
  assert.equal(run.inner.state().queue[0].capped, 'per-chain');
  assert.equal(
    Object.keys(run.inner.state().handled).filter((id) => !id.includes(':feedback:')).length,
    1,
    'only the first intention wake is handled'
  );
  await innerSettle();
  assert.equal(
    run.journal.filter((r) => r.event === 'capped' && r.cap === 'per-chain').length,
    1,
    'journalled once per wake'
  );
  // Later the same day it still waits; the local midnight releases it.
  innerDrainPlaceClock.t = NOW + 6 * HOUR_MS;
  await run.inner.tick();
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, 2);
  innerDrainPlaceClock.t = NOW + 13 * HOUR_MS;
  await run.inner.tick();
  const calls3 = run.turns.calls;
  assert.equal(calls3.length, 3);
  assert.equal(present(calls3[2].chat).chatId, 'c2');
  assert.equal(run.inner.state().queue.length, 0);
});

test('inner: a wake of another chain that shares the chat of a held one runs now and leaves the held one queued', async () => {
  const run = setup({
    records: [
      intention('i1', { chainId: 'k', dueAt: NOW - 3 * MINUTE_MS }),
      intention('i2', { dueAt: NOW - 2 * MINUTE_MS }),
    ],
    hot: innerDrainPlaceHotWith({ wakes: { caps: { perChain: 1 } } }),
  });
  run.turns.busy = true;
  await run.inner.tick();
  run.inner.state().turns.push(wrongly({ at: NOW - MINUTE_MS, chainId: 'chain:k', outcome: 'spoke' }));
  run.turns.busy = false;
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 1);
  const inner = calls[0].inner;
  const intentions = inner.wake.intentions;
  assert.deepEqual(
    intentions.map((r) => r.id),
    ['i2']
  );
  const queue = run.inner.state().queue;
  assert.deepEqual(
    queue.map((wake) => `${wake.intentionIds[0]}:${wake.capped}`),
    ['i1:per-chain']
  );
});

test('inner: the journal records the wake and the turn with its outcome, actions and cost; an errand it handed off adds its cost', async () => {
  const turns = fakeTurns({
    answer: () => ({
      outcome: 'spoke',
      shadow: true,
      inner: {
        actions: [
          { skill: 'message.create', status: 'proposed', result: 'ok', code: 'shadow', target: { channel: 'c2' } },
        ],
        turnId: 't-9',
      },
    }),
  });
  const run = setup({ records: [intention('i1')], turns, meterUsd: 0.12 });
  await run.inner.tick();
  await innerSettle();
  const wake = run.journal.find((r) => r.event === 'wake');
  assert.equal(present(wake).wake.kind, 'intention_due');
  const turn = run.journal.find((r) => r.event === 'turn');
  assert.equal(present(turn).outcome, 'spoke');
  assert.equal(present(turn).shadow, true);
  assert.deepEqual(
    present(turn).actions.map((a: Record<string, Untyped>) => a.status),
    ['proposed']
  );
  assert.equal(present(turn).cost.usd, 0.12);
  assert.equal(present(turn).turnId, 't-9');
  assert.equal(run.inner.onTaskFinished({ id: 'k1', origin: { turnId: 't-9' }, usage: { usd: 0.5 } }), true);
  assert.equal(run.inner.onTaskFinished({ id: 'k2', origin: { turnId: 'other' }, usage: { usd: 0.5 } }), false);
  assert.equal(run.inner.status().spentUsd, 0.62);
});

/** A real cost meter over its own listeners, and `emit` to log a line into it. */
function innerOwnMeter() {
  const listeners = new Set();
  const meter = innerCreateCostMeter({ subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) });
  return { meter, emit: (entry: Record<string, Untyped>) => listeners.forEach((fn: Untyped) => fn(entry)) };
}

test("inner: what turns cost never refuses the next one; the day's spend is only reported", async () => {
  const { meter, emit } = innerOwnMeter();
  const turns = fakeTurns({
    answer: () => {
      emit({ msg: 'llm: usage', role: 'core', cost: 5 });
      emit({ msg: 'llm: usage', role: 'core', cost: 5 });
      return { outcome: 'spoke', inner: { actions: [], turnId: `t-${turns.calls.length}` } };
    },
  });
  const records = [
    intention('i1', { dueAt: NOW - 3 * MINUTE_MS }),
    intention('i2', { dueAt: NOW - 2 * MINUTE_MS, placeId: 'c2' }),
    intention('i3', { dueAt: NOW - MINUTE_MS, placeId: 'c3' }),
  ];
  const run = setup({ records, turns, meter });
  await run.inner.tick();
  await run.inner.tick();
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 3);
  assert.equal(run.inner.status().spentUsd, 30);
});

test('inner: an errand an inner turn handed off has its cost recorded when it ends, as a figure with no hold', async () => {
  innerDrainPlaceClock.t = NOW;
  const turns = fakeTurns({ answer: () => ({ outcome: 'spoke', inner: { actions: [], turnId: 't-e' } }) });
  const run = setup({ records: [intention('i1')], turns, hot: innerDrainPlaceHotWith({ wakes: { mode: 'live' } }) });
  await run.inner.tick();
  await innerSettle();
  assert.equal(run.inner.onTaskFinished({ id: 'k1', origin: { turnId: 't-e' }, usage: { usd: 0.25 } }), true);
  assert.equal(run.inner.onTaskFinished({ id: 'k2', origin: { turnId: 'elsewhere' }, usage: { usd: 0.25 } }), false);
  assert.equal(run.inner.status().spentUsd, 0.35, "the turn's real 0.1 and the errand's 0.25");
  await innerSettle();
  const cost = run.journal.find((r) => r.event === 'errand-cost');
  assert.equal(present(cost).taskId, 'k1');
  assert.equal(present(cost).usd, 0.25);
  assert.equal('heldUsd' in present(cost), false);
});

// ---- recurring intentions ------------------------------------------------------------

/** The production intention service over the inner life's temp data directory. */
function realIntentions(hot: Record<string, Untyped>, dataDir: string) {
  hot.config.intentions = {
    expiresDays: 14,
    recurringExpiresDays: 30,
    maxOpen: 20,
  };
  return createIntentionService({
    stores: createIntentionStores({ dataDir, now: () => innerDrainPlaceClock.t, log: INNER_SILENT }),
    hot,
    now: () => innerDrainPlaceClock.t,
    log: INNER_SILENT,
  });
}

// ---- the persona's attention ------------------------------------------------------------------------

/** A fake record over `lines` (`{ kind, messageId, occurredAt, by, scope }`): iterate filters by `from`. */
function fakeRecord(lines: Array<Record<string, Untyped>>) {
  return {
    lines,
    async *iterate({ from }: { from?: string | null } = {}) {
      const since = from ? Date.parse(from) : -Infinity;
      for (const line of lines) if (Date.parse(String(line.occurredAt)) >= since) yield line;
    },
  };
}

/** One observed line of `by` in `channel` at `at` (the persona's own when `said`). */
function seen(
  id: string,
  {
    channel = 'c2',
    by = 'u1',
    at = NOW - 5 * MINUTE_MS,
    said = false,
  }: { channel?: string; by?: string; at?: number; said?: boolean } = {}
) {
  return {
    kind: said ? 'said' : 'seen',
    messageId: id,
    occurredAt: new Date(at).toISOString(),
    ...(said ? {} : { by }),
    scope: { channel },
  };
}

/** An inner life over the real service with an attention on `place`, the clock at NOW. */
function attentionSetup({
  place = 'c2',
  people = [],
  settle: innerSettle = 60,
  perDay = 12,
  lines = [],
  turns = fakeTurns(),
  wakes = {},
  places = null,
  nameOf = null,
  canSend = () => true,
}: {
  place?: string;
  people?: Array<Untyped>;
  settle?: number;
  perDay?: number;
  lines?: Array<Untyped>;
  turns?: ReturnType<typeof fakeTurns>;
  wakes?: Record<string, Untyped>;
  places?: Untyped;
  nameOf?: Untyped;
  canSend?: Untyped;
} = {}) {
  const dataDir = tempDir('nep-inner-');
  const hot = innerDrainPlaceHotWith({ wakes });
  const service = realIntentions(hot, dataDir);
  const record = fakeRecord(lines);
  const journal: Array<Record<string, Untyped>> = [];
  let inner: ReturnType<typeof createInnerLife>;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: INNER_SILENT });
  inner = createInnerLife({
    hot,
    dataDir,
    turns,
    intentions: service,
    record,
    places,
    nameOf,
    journal: { inner: async (fields) => journal.push(fields) },
    reads: fakeClient(undefined, canSend).reads,
    iface: () => 'fake',
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn) => ({ result: await fn(), usd: 0.1, requests: 1, voice: 1 }) },
    rng: seeded(3),
    now: () => innerDrainPlaceClock.t,
    log: INNER_SILENT,
  });
  // Set an hour ago: lines before an attention was set are never new to it.
  innerDrainPlaceClock.t = NOW - HOUR_MS;
  const set = service.set({
    purpose: 'listen there',
    attend: { place, people, settle: innerSettle, perDay },
    placeId: 'c1',
    scope: 'group',
  });
  innerDrainPlaceClock.t = NOW;
  assert.equal(set.ok, true, wrongly(set.code));
  return { inner, turns, journal, service, record, id: set.intention.id, hot };
}

// ---- feedback on the persona's own turn ----------------------------------------------------------

/** A turn result of the real case: a post refused, a search timed out, the intention closed as done. */
function lostTurn(turnId = 't-1') {
  return {
    outcome: 'spoke',
    inner: {
      actions: [
        { skill: 'message.create', status: 'refused', result: 'refused', code: 'destination-required', target: {} },
        { skill: 'intention.update', status: 'executed', result: 'ok', target: {}, intentionId: 'i1', state: 'done' },
        { skill: 'web.search', status: 'executed', result: 'unknown', code: 'timeout', target: {} },
      ],
      intentIds: ['i1'],
      loop: { steps: 2, cut: 'steps', droppedCalls: 1 },
      turnId,
    },
  };
}

// Slice 5: the wake's `here` line left with `<wake>` and the review is gone; the current channel the turn is given
// stays the fact under test, and the heartbeat's turn nowhere is tested with the heartbeat below.
test('inner: the turn is given the current channel; the feedback wake carries it on', async () => {
  const dest = { ...intention('i1'), destination: 'c2' };
  const run = setup({ records: [dest] });
  await run.inner.tick();
  const calls = run.turns.calls;
  const given = calls[0];
  assert.equal(present(given.chat).chatId, 'c2');
  assert.equal(given.inner.currentChannel, 'c2');
  const asked = setup({ records: [intention('i1')] });
  await asked.inner.tick();
  const calls2 = asked.turns.calls;
  const inner = calls2[0].inner;
  assert.equal(inner.currentChannel, 'c1');
  // A feedback wake keeps the reported turn's current channel, and the next turn is given it.
  const turns = fakeTurns({ answer: () => lostTurn() });
  const again = setup({ records: [{ ...dest }], turns, hot: innerDrainPlaceHotWith({ wakes: { mode: 'live' } }) });
  await again.inner.tick();
  assert.equal(again.inner.state().queue[0].here, 'c2');
  innerDrainPlaceClock.t = NOW + MINUTE_MS;
  await again.inner.tick();
  const calls3 = again.turns.calls;
  const inner2 = calls3[1].inner;
  assert.equal(inner2.currentChannel, 'c2');
});

/** The facts of the state as `kind:code:why`, oldest first. */
const factLines = (run: Record<string, Untyped>) =>
  run.inner
    .state()
    .facts.map((fact: Record<string, Untyped>) => [fact.kind, fact.code, fact.why].filter(Boolean).join(':'));

test('inner: a turn that ended error journals its code and the status shows the last error; a thrown provider error is mapped', async () => {
  const limit = Object.assign(new Error('OpenRouter HTTP 429'), { statusCode: 429, body: '{}' });
  const turns = fakeTurns({
    answer: () => {
      throw limit;
    },
  });
  const run = setup({ records: [intention('i1')], turns });
  await run.inner.tick();
  const record = run.journal.find((r) => r.event === 'turn');
  assert.equal(present(record).outcome, 'error');
  assert.deepEqual(present(record).error, { code: 'provider-limit' });
  assert.deepEqual(run.inner.status().lastError, { at: NOW, code: 'provider-limit' });
  const reported = setup({
    records: [intention('i1')],
    turns: fakeTurns({ answer: () => ({ outcome: 'error', reason: 'timeout' }) }),
  });
  await reported.inner.tick();
  assert.deepEqual(present(reported.journal.find((r) => r.event === 'turn')).error, { code: 'timeout' });
  const fine = setup({ records: [intention('i1')] });
  await fine.inner.tick();
  assert.equal(present(fine.journal.find((r) => r.event === 'turn')).error, undefined);
  assert.equal(fine.inner.status().lastError, null);
});

/** A turn runner failing with `code` the first `fails` runs, then answering a silent skip. */
function failingTurns(fails: number, code = 'provider-limit') {
  let runs = 0;
  return fakeTurns({
    answer: () =>
      ++runs <= fails
        ? { outcome: 'error', reason: code }
        : { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${runs}` } },
  });
}

test('inner retry: a turn ending error re-queues its wakes after the first delay, not handled, the caps and the chain untouched', async () => {
  const run = setup({ records: [intention('i1')], turns: failingTurns(1) });
  await run.inner.tick();
  const status = run.inner.status();
  assert.equal(status.queue.length, 1);
  const queue = status.queue[0];
  assert.equal(queue.dueAt, NOW - MINUTE_MS, 'the original due time stays');
  const queued = run.inner.state().queue[0];
  assert.equal(queued.retry, 1);
  assert.equal(queued.firstFailedAt, NOW);
  assert.equal(queued.notBefore, NOW + MINUTE_MS);
  assert.equal(queued.lastCode, 'provider-limit');
  assert.equal(run.inner.state().handled[queued.id], undefined);
  assert.equal(status.turnsToday, 0);
  assert.equal(innerChainBudget(run.inner.state(), queued.chainId, 3, { now: NOW, timezone: 'UTC' }).used, 0);
  assert.equal(present(run.journal.find((r) => r.event === 'retry')).retry, 1);
  // Before the delay nothing runs; the wake is not woken twice either.
  innerDrainPlaceClock.t = NOW + 30_000;
  assert.deepEqual((await run.inner.tick()).drained, { deferred: 'retry' });
  const calls = run.turns.calls;
  assert.equal(calls.length, 1);
});

test('inner retry: the second failure waits the second delay; a success after a retry shows the delayed line data and clears the queue', async () => {
  const run = setup({ records: [intention('i1')], turns: failingTurns(2) });
  await run.inner.tick();
  innerDrainPlaceClock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  const queued = run.inner.state().queue[0];
  assert.equal(queued.retry, 2);
  assert.equal(queued.firstFailedAt, NOW);
  assert.equal(queued.notBefore, NOW + MINUTE_MS + 5 * MINUTE_MS);
  innerDrainPlaceClock.t = NOW + 6 * MINUTE_MS;
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 3);
  const inner = calls[2].inner;
  const info = inner.wake;
  const item = info.items[0];
  assert.deepEqual(item.delayed, { minutes: 7, code: 'provider-limit' });
  const calls2 = run.turns.calls;
  const inner2 = calls2[0].inner;
  const items = inner2.wake.items;
  assert.equal(items[0].delayed, undefined);
  assert.equal(run.inner.state().queue.length, 0);
  assert.equal(run.inner.state().handled[queued.id].outcome, 'skip');
  assert.equal(run.inner.status().turnsToday, 1, 'only the turn that ran counts');
});

test('inner retry: the last delay repeats; past retry.maxHours the wake is dropped provider and the persona is told at their next turn', async () => {
  const hot = innerDrainPlaceHotWith({ wakes: { retry: { delaysMinutes: [1, 2], maxHours: 1 } } });
  const run = setup({ records: [intention('i1')], turns: failingTurns(99), hot });
  await run.inner.tick();
  innerDrainPlaceClock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  innerDrainPlaceClock.t = NOW + 3 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.inner.state().queue[0].retry, 3);
  assert.equal(run.inner.state().queue[0].notBefore, NOW + 5 * MINUTE_MS, 'the second delay repeats');
  innerDrainPlaceClock.t = NOW + 61 * MINUTE_MS;
  const calls = run.turns.calls;
  const before = calls.length;
  await run.inner.tick();
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, before + 1);
  const state = run.inner.state();
  const dropped = Object.values(state.handled).find((entry) => entry.outcome === 'provider');
  assert.ok(dropped, 'handled with outcome provider');
  const feedback = present(run.journal.filter((r) => r.event === 'turn').at(-1)).feedback.facts;
  assert.deepEqual(
    feedback.map((fact: Record<string, Untyped>) => `${fact.kind}:${fact.code}`),
    ['turnFailed:provider-limit']
  );
  const drop = state.facts.find((fact) => fact.kind === 'wakeDropped');
  assert.deepEqual(
    [present(drop).code, present(drop).why, present(drop).intentionId],
    ['provider', 'provider-limit', 'i1'],
    'a fact at the moment of the drop'
  );
  assert.equal(present(drop).told, false, 'the feedback turn that carries it has not run yet');
});

test('inner retry: a retried wake is not coalesced with a fresh wake of the same chat', async () => {
  const run = setup({ records: [intention('i1', { dueAt: NOW - 5 * MINUTE_MS })], turns: failingTurns(1) });
  await run.inner.tick();
  innerDrainPlaceClock.t = NOW + 2 * MINUTE_MS;
  const records = run.intentions.records;
  records.push(intention('i2', { dueAt: NOW + MINUTE_MS }));
  await run.inner.tick();
  await run.inner.tick();
  const calls = run.turns.calls;
  const groups = calls.slice(1).map(({ inner: { wake } }) => wake.items.map((item) => item.intentionIds[0]));
  assert.deepEqual(groups, [['i1'], ['i2']]);
});

test("inner retry: a one-off's due moment that met an error that is not a provider failure (cut-off) is tried once more after the first delay, then dropped and told with the code", async () => {
  const run = setup({ records: [intention('i1')], turns: failingTurns(99, 'cut-off') });
  await run.inner.tick();
  let state = run.inner.state();
  assert.deepEqual(
    state.queue.map((wake) => [wake.retry, wake.notBefore]),
    [['error', NOW + MINUTE_MS]],
    'not handled: its due moment comes back once'
  );
  assert.deepEqual(present(run.journal.find((r) => r.event === 'turn')).error, { code: 'cut-off' });
  assert.equal(run.journal.filter((r) => r.event === 'retry').length, 1);
  assert.deepEqual(
    factLines(run),
    ['turnFailed:cut-off'],
    'the failure is a fact; no feedback wake while the wake comes back'
  );
  assert.equal(
    state.queue.some((wake) => wake.kind === 'feedback'),
    false
  );
  innerDrainPlaceClock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  state = run.inner.state();
  assert.equal(wrongly<{ outcome: string }>(Object.values(state.handled)[0]).outcome, 'error');
  assert.deepEqual(
    state.facts.map((fact) => `${fact.kind}:${fact.code}:${fact.why ?? ''}`),
    ['turnFailed:cut-off:', 'wakeDropped:error:cut-off', 'turnFailed:cut-off:']
  );
  assert.deepEqual(
    state.queue.map((wake) => wake.kind),
    ['feedback'],
    'now the persona is told by a wake of their own'
  );
  const calls = run.turns.calls;
  assert.equal(calls.length, 2);
});

test('inner retry: an attention wake that met a cut-off error is handled at once and told; only a one-off intention gets the one more try', async () => {
  const lines = [seen('m1', { by: 'u1', at: NOW - 5 * MINUTE_MS })];
  const run = attentionSetup({ lines, turns: failingTurns(99, 'cut-off') });
  await run.inner.tick();
  const state = run.inner.state();
  assert.deepEqual(
    state.queue.map((wake) => wake.kind),
    ['feedback'],
    'only the feedback wake is left'
  );
  assert.deepEqual(
    state.facts.filter((fact) => fact.kind === 'wakeDropped').map((fact) => `${fact.wake}:${fact.code}:${fact.why}`),
    ['attend:error:cut-off']
  );
});

// --- The heartbeat ------------------------------------------------------------------------------

const BEAT = { enabled: true, everyMinutes: 180, jitterMinutes: 60 };

// ---- A long turn of the tick: the wake's lease and the service lane -------------------------------------------------

/** Fake turns whose turn of `heldKind` waits until `release()`; `isAnyBusy(lane)` answers for the held turn's lane. */
function heldTurns(heldKind: string) {
  const turns = fakeTurns();
  let release: () => void = () => {};
  let held = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  turns.runTurn = (params: InnerTurnParams) => {
    turns.calls.push(params);
    const { wake } = params.inner;
    if (wake.kind !== heldKind)
      return Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-plain' } });
    held = true;
    return gate.then(() => {
      held = false;
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-held` } };
    });
  };
  turns.isAnyBusy = (lane: string = 'chat') => held && lane === (heldKind === 'heartbeat' ? 'service' : 'chat');
  return { turns, release: () => release() };
}

/** Waits, an event-loop turn at a time, until `check` holds (or gives up after a bounded wait). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('inner: an intention wake due while a heartbeat turn runs starts without waiting for the heartbeat', async () => {
  // Bug caught: the tick awaits the heartbeat's turn, so a promise made to a person waits up to a heartbeat's budget.
  innerDrainPlaceClock.t = NOW;
  const { turns, release } = heldTurns('heartbeat');
  const records = [intention('i1', { dueAt: NOW + 190 * MINUTE_MS })];
  const run = setup({ records, turns, hot: innerDrainPlaceHotWith({ heartbeat: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  innerDrainPlaceClock.t = NOW + 181 * MINUTE_MS;
  const beat = run.inner.tick();
  await until(() => turns.calls.length === 1);
  innerDrainPlaceClock.t = NOW + 191 * MINUTE_MS;
  await run.inner.tick();
  assert.deepEqual(
    turns.calls.map(({ inner }: InnerTurnParams) => inner.wake.kind),
    ['heartbeat', 'intention_due']
  );
  release();
  await beat;
});

/** Fake turns that hold both a heartbeat's turn and an intention's turn until each is released. */
function twoHeldTurns() {
  const turns = fakeTurns();
  const gates = new Map<string, () => void>();
  const running = new Set<string>();
  turns.runTurn = (params: InnerTurnParams) => {
    const { wake } = params.inner;
    const kind = String(wake.kind);
    turns.calls.push(params);
    running.add(kind);
    return new Promise<void>((resolve) => gates.set(kind, resolve)).then(() => {
      running.delete(kind);
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${kind}` } };
    });
  };
  turns.isAnyBusy = (lane: string = 'chat') => (lane === 'service' ? running.has('heartbeat') : running.size > 0);
  return { turns, release: (kind: string) => gates.get(kind)?.() };
}

test('inner: a fact waiting to be told is carried by one of the two turns that run side by side, not by both', async () => {
  // Bug caught: the heartbeat and an intention's turn both carry the same untold fact, so the persona is told it twice.
  innerDrainPlaceClock.t = NOW;
  const { turns, release } = twoHeldTurns();
  const records = [intention('i1', { dueAt: NOW + 181 * MINUTE_MS })];
  const run = setup({ records, turns, hot: innerDrainPlaceHotWith({ heartbeat: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  const facts = run.inner.facts;
  facts.add({
    kind: 'callFailed',
    skill: 'web.read',
    status: 'failed',
    code: 'error',
    placeId: null,
    at: NOW,
  });
  innerDrainPlaceClock.t = NOW + 182 * MINUTE_MS;
  const both = run.inner.tick();
  await until(() => turns.calls.length === 2);
  const carriers = turns.calls.filter(({ inner }: InnerTurnParams) =>
    JSON.stringify(inner.wake.facts ?? []).includes('web.read')
  );
  assert.equal(carriers.length, 1);
  release('heartbeat');
  release('intention_due');
  await both;
});

test("inner: the end of a heartbeat's turn leaves the in-flight mark of the intention turn that still runs", async () => {
  // Bug caught: the heartbeat's end wipes the mark of the turn beside it, so a restart cannot tell what that turn did.
  innerDrainPlaceClock.t = NOW;
  const { turns, release } = twoHeldTurns();
  const records = [intention('i1', { dueAt: NOW + 181 * MINUTE_MS })];
  const run = setup({ records, turns, hot: innerDrainPlaceHotWith({ heartbeat: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  innerDrainPlaceClock.t = NOW + 182 * MINUTE_MS;
  const both = run.inner.tick();
  await until(() => turns.calls.length === 2);
  release('heartbeat');
  await until(() => !turns.isAnyBusy('service'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.inner.state().inflight?.kind, 'intention_due');
  release('intention_due');
  await both;
});

useIface('fake');

/** Fake turns of the inner rig whose `isAnyBusy(lane)` says only the chat lane is taken. */
function chatLaneTaken() {
  const turns = fakeTurns();
  return Object.assign(turns, { isAnyBusy: (lane: string = 'chat') => lane === 'chat' });
}

test('inner drain: a heartbeat that is due while a reply turn is in flight starts', async () => {
  innerDrainPlaceClock.t = NOW;
  const turns = chatLaneTaken();
  const run = setup({ turns, hot: innerDrainPlaceHotWith({ heartbeat: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  innerDrainPlaceClock.t = NOW + 181 * MINUTE_MS;
  await run.inner.tick();
  assert.deepEqual(
    turns.calls.map(({ inner }: InnerTurnParams) => inner.wake.kind),
    ['heartbeat']
  );
});

test('inner drain: an intention wake that is due while a reply turn is in flight is still deferred busy', async () => {
  innerDrainPlaceClock.t = NOW;
  const turns = chatLaneTaken();
  const run = setup({ turns, records: [intention('i1', { dueAt: NOW - 5 * MINUTE_MS })] });
  const held = await run.inner.tick();
  assert.deepEqual(held.drained, { deferred: 'busy' });
  assert.equal(turns.calls.length, 0);
  assert.equal(run.inner.status().queue.length, 1);
});

test('inner drain: a heartbeat is not held behind people waiting for the chat lane', async () => {
  innerDrainPlaceClock.t = NOW;
  const turns = fakeTurns();
  const run = setup({
    turns,
    hot: innerDrainPlaceHotWith({ heartbeat: BEAT }),
    rng: () => 0.5,
    peopleWaiting: () => true,
  });
  await run.inner.tick();
  innerDrainPlaceClock.t = NOW + 181 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(turns.calls.length, 1);
});
