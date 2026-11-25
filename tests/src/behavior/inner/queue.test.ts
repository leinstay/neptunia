// Tests for the wake queue of the inner life (src/behavior/inner/queue.ts): which wakes coalesce into one turn, the
// wake of a due intention, and the wakes of the waits past their deadline.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { coalesceGroup, deadlineWakes, wakeOfDue } from '../../../../src/behavior/inner/queue.ts';
import { heartbeatWake } from '../../../../src/behavior/inner/heartbeat.ts';
import { createInnerLife, heartbeatWake as innerHeartbeatWake } from '../../../../src/behavior/inner.ts';
import { createEventDoor } from '../../../../src/interface/door.ts';
import { createIntentionService } from '../../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../../src/intentions/store.ts';
import {
  intention,
  ROOT as INNER_ROOT,
  NOW,
  clock as innerClock,
  setup as innerSetup,
} from '../../../fixtures/inner-rig.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { useIface, world } from '../../../fixtures/turn-world.ts';
import { wrongly, present } from '../../../fixtures/loose-types.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import type { Wake } from '../../../../src/behavior/inner/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createTurnRunner } from '../../../../src/behavior/turn.ts';
import { createReads } from '../../../../src/interface/reads.ts';
import { userText } from '../../../../src/behavior/prompt.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { personaJournal } from '../../../../src/behavior/inner/persona-sources.ts';
import { createErrandStores } from '../../../../src/errands/store.ts';
import { createErrandService } from '../../../../src/errands/service.ts';
import { createErrandTurns } from '../../../../src/errands/turns.ts';
import { runOp } from '../../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import { createAdmin } from '../../../../src/admin.ts';
import { DAY_MS, MINUTE_MS } from '../../../../src/time.ts';
import { labels } from '../../../fixtures/labels.ts';
import { completionOf } from '../../../fixtures/tool-answers.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { openTestMemorySync } from '../../../fixtures/memory-db/service.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';

useIface('fake');

/** A wake with only the fields a test sets; the code under test reads those and ignores the rest. */
const partialWake = (wake: Partial<Wake>): Wake => wrongly<Wake>(wake);

// The held wake must not keep its mate or a heartbeat waiting.
test('coalesceGroup: a wake the caller holds is left out of every group, a heartbeat included', () => {
  const held = partialWake({ id: 'h', kind: 'intention_due', placeId: 'c1', dueAt: 1 });
  const mate = partialWake({ id: 'a', kind: 'intention_due', placeId: 'c1', dueAt: 2 });
  const beat = heartbeatWake(3);
  const isHeld = (wake: Record<string, Untyped>) => wake.id === 'h';
  assert.deepEqual(
    coalesceGroup([held, mate], isHeld).map((w) => w.id),
    ['a']
  );
  assert.deepEqual(
    coalesceGroup([held, beat], isHeld).map((w) => w.id),
    [beat.id]
  );
  assert.deepEqual(coalesceGroup([held], isHeld), []);
});

test("wakeOfDue: a wait past its deadline names its errand; the chain is the intention's", () => {
  const wake = wakeOfDue(
    wrongly({
      intention: { ...intention('i1', { chainId: 'k' }), status: 'waiting', awaitingErrandId: 'T1' },
      reason: 'wait-deadline',
      at: 5,
    })
  );
  assert.equal(wake.kind, 'errand_deadline');
  assert.equal(wake.id, 'inner.wake:errand_deadline:i1:T1');
  assert.equal(wake.chainId, 'chain:k');
  assert.equal(wakeOfDue({ intention: intention('i2'), reason: 'due', at: 7 }).chainId, 'intention:i2');
});

test('inner retry: coalesceGroup keeps a retry group apart from fresh wakes', () => {
  const base: Partial<Wake> = { kind: 'intention_due', placeId: 'c1', chainId: 'a', intentionIds: ['x'] };
  const retried = partialWake({ ...base, id: 'w1', dueAt: 1, retry: 1, firstFailedAt: 5 });
  const fresh = partialWake({ ...base, id: 'w2', dueAt: 2, intentionIds: ['y'] });
  assert.deepEqual(
    coalesceGroup([fresh, retried]).map((wake) => wake.id),
    ['w1']
  );
  assert.deepEqual(
    coalesceGroup([fresh]).map((wake) => wake.id),
    ['w2']
  );
  const mate = partialWake({ ...base, id: 'w3', dueAt: 3, retry: 1, firstFailedAt: 5 });
  assert.deepEqual(
    coalesceGroup([mate, retried, fresh]).map((wake) => wake.id),
    ['w1', 'w3']
  );
});

// ---- the wakes of a wait past its deadline ----
// An intention waiting on a running errand with no due time of its own and a deadline that has passed gives one wake
// of kind `errand_deadline`. Real intention service and store, real event door and scheduler, a fake turn runner and a
// fake errand store; a temporary data directory.

const ROOT = 'g1';
const MINUTE = 60_000;
const START = Date.parse('2026-10-26T12:00:00Z');
const ERRAND = 't0000000a';
const SILENT = { info() {}, warn() {}, error() {} };

type TurnParams = {
  chat?: { chatId: string } | null;
  inner: { wake: { kind: string; items: Array<Record<string, unknown>> }; currentChannel?: string | null };
};

function setup() {
  const clock = { t: START };
  world().channel({ id: 'c1', name: 'chan-c1', placeId: ROOT, permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: { enabled: false },
    },
  };
  // The errand is running for the whole test: the store of the errand service has it open.
  const errands = { store: () => ({ get: (id: string) => (id === ERRAND ? { id, state: 'running' } : null) }) };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-deadline-'), now: () => clock.t, log: SILENT }),
    hot,
    errands,
    now: () => clock.t,
    log: SILENT,
  });
  const calls: Array<TurnParams> = [];
  const turns = {
    calls,
    isAnyBusy: () => false,
    runTurn: (params: TurnParams) => {
      calls.push(params);
      return Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-1' } });
    },
  };
  const journal: Array<Record<string, unknown>> = [];
  let inner: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({
    handlers: { 'inner.wake': (event: object) => inner?.onWake(event) },
    log: SILENT,
  });
  inner = createInnerLife({
    hot,
    dataDir: tempDir('nep-deadline-inner-'),
    turns,
    intentions: service,
    journal: { inner: (fields: Record<string, unknown>) => Promise.resolve(journal.push(fields)) },
    reads: world().reads,
    iface: () => 'fake',
    chatName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  return { clock, service, inner, calls, journal };
}

/** An intention waiting on the running errand with no due time, its deadline ten minutes ahead. */
function waitingIntention(service: ReturnType<typeof setup>['service']): string {
  const made = service.set({
    purpose: 'tell what the errand found',
    dueAt: null,
    placeId: 'c1',
    errandId: ERRAND,
    deadline: START + 10 * MINUTE,
  }) as { ok: boolean; intention: { id: string } };
  assert.equal(made.ok, true);
  return made.intention.id;
}

test('deadlineWakes over a record the reconciliation moved to pending gives the id the wait itself gave', () => {
  const run = setup();
  const id = waitingIntention(run.service);
  run.clock.t = START + 11 * MINUTE;
  run.service.reconcile();
  const moved = run.service.list({ all: true }) as Array<Record<string, unknown>>;
  assert.equal(moved[0]?.status, 'pending');
  assert.deepEqual(
    (deadlineWakes(moved) as Array<{ id: string; kind: string; errandId: string }>).map((wake) => [
      wake.id,
      wake.kind,
      wake.errandId,
    ]),
    [[`inner.wake:errand_deadline:${id}:${ERRAND}`, 'errand_deadline', ERRAND]]
  );
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

const INNER_TASK = 'Nobody wrote to you; read the wake block.';

const clock = { t: NOW0 };

test.beforeEach(() => {
  clock.t = NOW0;
});

/** A model call that never returns: the process dies there. */
const HANG = Symbol('hang');

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

test('row 14: the inner state file is corrupt at start -- a backup is written and a stateLost fact is shown in the next turn', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const file = path.join(dataDir, 'persona', 'inner.json');
  // The errand database opens before corruption so this case exercises the standalone inner-file reader.
  memoryOf(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"v":1,"queue":[{"id":"inner.wake:');
  const records = [intentionRecord('i1')];
  const run = boot(chat, { dataDir, records });
  await run.tick();
  const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('inner.json.bad-'));
  assert.equal(backups.length, 1, 'the unreadable file is kept aside');
  assert.equal(
    fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'),
    '{"v":1,"queue":[{"id":"inner.wake:',
    'untouched'
  );
  const calls = chat.llm.calls;
  assert.equal(calls.length, 1, 'the due intention came back from its own store and ran');
  assert.ok(requestText(chat, 0).includes('inner state lost'), requestText(chat, 0));
  assert.deepEqual(run.factKinds(), ['stateLost:told']);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), 'the state file is whole again');
  assertNoSilentFailure(run);
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

useIface('fake');

const settle = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => void (innerClock.t = NOW));

// Slice 5: the daily review is gone, so only the two intentions of c1 coalesce.
test('inner: wakes of one chat coalesce into one turn; another chat waits for its own', async () => {
  const run = innerSetup({
    records: [
      intention('i1', { dueAt: NOW - 3 * MINUTE_MS }),
      intention('i2', { dueAt: NOW - 2 * MINUTE_MS, placeId: 'c2' }),
      intention('i3', { dueAt: NOW - MINUTE_MS }),
    ],
  });
  run.turns.busy = true;
  await run.inner.tick();
  assert.equal(run.inner.status().queue.length, 3);
  run.turns.busy = false;
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 1);
  const inner = calls[0].inner;
  const wake = inner.wake;
  const calls2 = run.turns.calls;
  assert.equal(present(calls2[0].chat).chatId, 'c1');
  assert.deepEqual(wake.items.map((item) => item.kind).sort(), ['intention_due', 'intention_due']);
  assert.deepEqual(wake.intentions.map((r) => r.id).sort(), ['i1', 'i3']);
  await run.inner.tick();
  const calls3 = run.turns.calls;
  assert.equal(calls3.length, 2);
  assert.equal(present(calls3[1].chat).chatId, 'c2');
  await settle();
  const turn = run.journal.find((r) => r.event === 'turn');
  assert.equal(present(turn).coalesced.length, 2, 'the coalesced ids are journalled');
});

/** `count` intentions due now, each in a channel of its own, so their wakes fill as many places of the queue. */
const queueFillers = (count: number) => [...Array(count).keys()].map((n) => intention(`q${n}`, { placeId: `c-q${n}` }));

test('inner: a wake whose intention closed meanwhile is stale; a full queue records the overflow', async () => {
  const records = queueFillers(20);
  const run = innerSetup({ records });
  run.turns.busy = true;
  await run.inner.tick();
  assert.equal(run.inner.state().queue.length, 20);
  const over = await run.inner.onWake({
    kind: 'inner.wake',
    at: NOW,
    id: 'w2',
    placeId: INNER_ROOT,
    // Slice 5: the review is gone; any wake past a full queue overflows.
    wake: innerHeartbeatWake(NOW),
  });
  assert.equal(over.status, 'overflow');
  for (const record of records) record.status = 'cancelled';
  run.turns.busy = false;
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 0);
  await settle();
  assert.ok(run.journal.some((r) => r.event === 'overflow'));
  assert.ok(run.journal.some((r) => r.event === 'stale'));
});
