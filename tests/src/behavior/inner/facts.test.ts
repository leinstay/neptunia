// Tests for the facts of the inner life (src/behavior/inner/facts.ts): what a turn lost becomes a fact for the next
// turn, and a refusal of a heartbeat wakes no feedback turn.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackFacts, heartbeatRefused } from '../../../../src/behavior/inner/facts.ts';
import { DELIVERY_SKILLS, WAKE_KINDS } from '../../../../src/behavior/inner/settings.ts';
import {
  intention,
  NOW as INNER_NOW,
  SILENT as INNER_SILENT,
  clock as innerClock,
  fakeClient,
  fakeTurns,
  hotWith as innerHotWith,
  seeded,
  setup,
} from '../../../fixtures/inner-rig.ts';
import { createTurnRunner } from '../../../../src/behavior/turn.ts';
import { createReads } from '../../../../src/interface/reads.ts';
import { userText } from '../../../../src/behavior/prompt.ts';
import {
  createInnerLife,
  wakeOfDue,
  feedbackFacts as innerTurnFeedbackFacts,
  chainBudget,
} from '../../../../src/behavior/inner.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { createEventDoor } from '../../../../src/interface/door.ts';
import { personaJournal } from '../../../../src/behavior/inner/persona-sources.ts';
import { createErrandStores } from '../../../../src/errands/store.ts';
import { createErrandService } from '../../../../src/errands/service.ts';
import { createErrandTurns } from '../../../../src/errands/turns.ts';
import { runOp } from '../../../../src/tools/operations/index.ts';
import '../../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import { createAdmin } from '../../../../src/admin.ts';
import { DAY_MS, MINUTE_MS, HOUR_MS } from '../../../../src/time.ts';
import { labels } from '../../../fixtures/labels.ts';
import { call, completionOf, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { openTestMemorySync, openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { wrongly, present } from '../../../fixtures/loose-types.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import { chainsOf, chainsOnDefaults } from '../../../fixtures/chains.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';
import { onWorld, useIface, world } from '../../../fixtures/turn-world.ts';
import type { Fake } from '../../../fixtures/turn-world.ts';
import type { InnerTurnParams } from '../../../../src/behavior/inner/types.ts';
import { createIntentionService } from '../../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../../src/intentions/store.ts';
import { deliveriesIn } from '../../../../src/memory/db/wake-queue.ts';
import type { WakeQueueUpdate } from '../../../../src/memory/db/wake-queue.ts';
import {
  DISCORD as INNER_WAKE_SENDS_DISCORD,
  fakeStore as innerWakeSendsFakeStore,
  hotWith as innerWakeSendsHotWith,
  personaGrants as innerWakeSendsPersonaGrants,
  rawMessage as innerWakeSendsRawMessage,
} from '../../../fixtures/turn-harness.ts';
import { worldTurnRunner } from '../../../fixtures/world-runner.ts';

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

test('feedbackFacts: a call that did not go ok, an intention closed with nothing delivered, the loop cut; nothing when all went through', () => {
  assert.ok(WAKE_KINDS.includes('feedback'));
  // Compared sorted, since the list derives from the posting tools' traits and their order is the table's. Each of the
  // three errand tools delivers.
  assert.deepEqual([...DELIVERY_SKILLS].sort(), [
    'draw.create',
    'errand.code',
    'errand.scout',
    'errand.server',
    'message.create',
    'voice.say',
  ]);
  const facts = feedbackFacts(lostTurn(), {
    named: ['i1'],
    intentions: [intention('i1', { purpose: 'send a cat meme' })],
  });
  assert.deepEqual(facts, [
    { kind: 'callFailed', skill: 'message.create', status: 'refused', code: 'destination-required' },
    { kind: 'callFailed', skill: 'web.search', status: 'timeout', code: 'timeout' },
    { kind: 'doneWithoutDelivery', intentionId: 'i1', purpose: 'send a cat meme' },
    { kind: 'loopCut', cut: 'steps', droppedCalls: 1, steps: 2 },
  ]);
  // A refused call carries its code; an executed delivery makes the done intention no fact; a loop that ended on its own is none.
  const delivered = feedbackFacts({
    inner: {
      actions: [
        { skill: 'message.create', status: 'executed', result: 'ok' },
        { skill: 'intention.update', status: 'executed', result: 'ok', intentionId: 'i1', state: 'done' },
        { skill: 'draw.create', status: 'refused', result: 'refused', code: 'inner-stopped' },
      ],
      intentIds: ['i1'],
      loop: { steps: 3, cut: null, droppedCalls: 0 },
    },
  });
  assert.deepEqual(delivered, [{ kind: 'callFailed', skill: 'draw.create', status: 'refused', code: 'inner-stopped' }]);
  // A done set in shadow (proposed) closed nothing: no fact; without an id on the action the one named id counts.
  assert.deepEqual(
    feedbackFacts({
      inner: {
        actions: [{ skill: 'intention.update', status: 'proposed', result: 'ok', intentionId: 'i1', state: 'done' }],
        intentIds: ['i1'],
      },
    }),
    []
  );
  assert.deepEqual(
    feedbackFacts({
      inner: {
        actions: [{ skill: 'intention.update', status: 'executed', result: 'ok', state: 'done' }],
        intentIds: ['i2'],
      },
    }),
    [{ kind: 'doneWithoutDelivery', intentionId: 'i2', purpose: '' }]
  );
  assert.deepEqual(
    feedbackFacts({
      outcome: 'skip',
      inner: { actions: [], intentIds: [], loop: { steps: 0, cut: null, droppedCalls: 0 } },
    }),
    []
  );
  assert.deepEqual(feedbackFacts(null), []);
});

test('a notice a heartbeat did not read is a refusal of the heartbeat, which wakes no feedback turn', () => {
  // Bug: the notice's fact wakes a feedback turn, which may post what the heartbeat held behind the notice.
  const [fact] = feedbackFacts({
    inner: {
      actions: [{ skill: 'intention.set', status: 'refused', result: 'refused', code: 'intention-notice', target: {} }],
    },
  });
  assert.equal(fact?.code, 'intention-notice');
  assert.equal(heartbeatRefused(fact ?? {}), true);
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

// Slice 4: an addressed turn is a reply on the frame, which tells untold facts in `<feedback>` inside `<inner>`.
const feedbackBlockOf = (text: string) => /<feedback>\n([\s\S]*?)\n<\/feedback>/.exec(text)?.[1] ?? '';

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

// A due intention whose place the persona cannot reach runs nowhere instead of being dropped, so the fact
// here is the drop of a wake whose intention was cancelled before it ran (stale), and i1 falls due a minute later.
test('row 4: the process dies before a fact was presented -- the fact is still untold after the reload and shows in the next turn, once', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  // i9's wake is accepted, then i9 is cancelled: a wakeDropped fact; i1 falls due after it.
  const records = [
    intentionRecord('i9', { dueAt: NOW0 - 2 * MINUTE_MS, purpose: 'announce the game night' }),
    intentionRecord('i1', { dueAt: NOW0 + MINUTE_MS }),
  ];
  const before = boot(chat, { dataDir, records });
  await before.accept(wakeOfDue({ intention: records[0], reason: 'due', at: NOW0 - 2 * MINUTE_MS }));
  records[0].status = 'cancelled';
  await before.tick();
  assert.deepEqual(before.factKinds(), ['wakeDropped'], 'the drop is a fact at the moment it happens');
  // The next tick shows the fact to a turn that never answers: the process dies inside the model call.
  clock.t = NOW0 + 2 * MINUTE_MS;
  await dieDuring(chat, () => {
    chat.script = [HANG];
    return before.inner.tick();
  });
  const calls = chat.llm.calls;
  assert.equal(calls.length, 1);
  assert.ok(requestText(chat, 0).includes('stale'), 'the dying turn had the fact in front of it');

  const after = boot(chat, { dataDir, records });
  assert.deepEqual(after.factKinds(), ['wakeDropped'], 'still untold after the reload');
  await after.tick();
  const calls2 = chat.llm.calls;
  assert.equal(calls2.length, 1, 'restart never replays the interrupted turn');
  // A fresh due intention presents retained facts without reviving the abandoned wake.
  records.push(intentionRecord('i-fresh'));
  await after.tick();
  const calls3 = chat.llm.calls;
  assert.equal(calls3.length, 2);
  assert.ok(requestText(chat, 1).includes('stale'), 'shown in the next turn');
  assert.deepEqual(after.factKinds(), ['wakeDropped:told']);
  // An addressed turn afterwards has nothing left to tell.
  await after.ask('c1', 'hello');
  // Slice 4: a reply tells facts in `<feedback>`, so "told once" means no `<feedback>` there.
  assert.ok(!requestText(chat, 2).includes('<feedback>'), 'told once');
  assertNoSilentFailure(after);
});

test('row 5: a terminal call fails on the last loop step -- a callFailed fact shown in the next turn of that channel (inner), and in the next addressed turn of it (addressed)', async () => {
  // Inner: the last step's post fails with nothing after it.
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1')];
  const hot = hotWith({
    grants: ['lore.list', 'message.create'],
    wakes: { loop: { maxSteps: 1, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 } },
  });
  const inner = boot(chat, { dataDir, records, hot });
  chat.script = [toolAnswer('', [call('lore.list')]), '<msg>καλημέρα</msg>'];
  chat.failSend(1);
  await inner.tick();
  const calls2 = chat.llm.calls;
  assert.equal(calls2.length, 2, 'nothing follows the terminal call');
  const failed = inner.state().facts.filter((fact: Record<string, Untyped>) => fact.kind === 'callFailed');
  assert.deepEqual(
    failed.map((fact: Record<string, Untyped>) => [fact.skill, fact.status, fact.placeId, fact.told]),
    [['message.create', 'failed', 'c1', false]]
  );
  assert.equal(inner.state().queue[0]?.kind, 'feedback', 'a feedback wake carries it');
  await inner.tick();
  const calls3 = chat.llm.calls;
  assert.equal(calls3.length, 3, 'the next turn of that channel');
  assert.ok(requestText(chat, 2).includes('call message.create failed'), requestText(chat, 2));
  assert.ok(inner.state().facts.every((fact: Record<string, Untyped>) => fact.told));
  assertNoSilentFailure(inner);

  // Addressed: the call failed and the step after it did not come.
  const dir2 = tempDir('nep-fault-');
  const chat2 = makeChat();
  const addressed = boot(chat2, { dataDir: dir2, hot: hotWith({ grants: ['lore.list'] }), failOps: ['lore.list'] });
  chat2.script = [toolAnswer('', [call('lore.list')]), providerLimit()];
  await addressed.ask('c1', 'look at the lore');
  assert.deepEqual(addressed.factKinds(), ['callFailed']);
  // The failed follow-up of a turn that answers someone is followed by one rescue request (lookup-loop slice 2), which
  // fails the same way: the turns below start at request 3, not 2.
  const { calls } = chat2.llm;
  assert.equal(calls.length, 3, 'the reply, the failed follow-up and the failed rescue');
  chat2.script = ['<skip/>'];
  await addressed.ask('c2', 'and here?');
  assert.ok(!requestText(chat2, 3).includes('lore.list failed'), 'not in another channel');
  await addressed.ask('c1', 'again');
  // The fact reaches the addressed turn in `<feedback>`.
  assert.ok(
    feedbackBlockOf(requestText(chat2, 4)).includes('call lore.list failed'),
    feedbackBlockOf(requestText(chat2, 4))
  );
  assert.deepEqual(addressed.factKinds(), ['callFailed:told']);
  assertNoSilentFailure(addressed);
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

// The chat is held by a fake interface named `fake`.
useIface('fake');

const innerTurnCreateTurnRunner = onWorld(wrongly(createTurnRunner));

/** What an inner turn reports, the fields these tests read. */
type InnerResult = {
  outcome: string;
  reason?: string;
  delivered?: boolean;
  shadow?: boolean;
  refused?: string;
  reasons?: Array<string>;
  inner: {
    actions: Array<{ skill: string; status: string; code?: string; [field: string]: Untyped }>;
    openFollowUp: Record<string, Untyped>;
    loop: Record<string, Untyped>;
    intentIds: Array<string>;
  };
};

const NOW = Date.parse('2026-10-19T12:00:00Z');

function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = NOW - 60_000,
  content = 'καλημέρα',
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  ts?: number;
  content?: string;
}) {
  return {
    id,
    placeId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The channel c1 of the root over `historyMessages`, in the test's world. */
function fakeChannel(historyMessages: Array<Record<string, Untyped>>) {
  return world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages });
}

function innerTurnFakeStore() {
  return {
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
}

// PR 7d: the switches are code, a heartbeat holds to intention changes and the inner turn's slice of the channel is
// the constant 30 lines, so the config holds only the keys that are still settings.
function innerTurnHotWith({
  access = {},
  wakes = {},
}: { access?: Record<string, Untyped>; wakes?: Record<string, Untyped> } = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', owners: ['u1'], access },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { routes: chainsOnDefaults({ analyzer: 'x/text' }) },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'shadow', ...wakes },
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
  };
}

function innerTurnPersonaGrants(names: Array<string>) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

function sequenceLlm(answers: Array<unknown>, { onCall = null }: { onCall?: ((calls: number) => void) | null } = {}) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  return {
    calls,
    options,
    complete: async (messages: Array<Record<string, Untyped>>, requestOptions: Record<string, Untyped>) => {
      calls.push(messages);
      options.push(requestOptions ?? {});
      const answer: unknown = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (onCall) onCall(calls.length);
      return completionOf(answer);
    },
  };
}

const WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'πες καλημέρα στο κανάλι', dueAt: NOW - 60_000 }],
  now: NOW,
  timezone: 'UTC',
  channels: [],
};

/**
 * One inner turn in #general (c1) answered with `answers`; `shadow` its mode; `gate` overrides of
 * the inner parameter (mayAct); `loop` overrides of `wakes.loop` (the
 * inner turn's bounds), `skillsLoop` of `tools.loop` (an ordinary turn's); `clock` the turn's
 * clock (NOW when none); `slowMs` delays every operation of the persona by that many real milliseconds.
 */
async function innerTurn({
  answers,
  shadow = true,
  gate = {},
  journal = null,
  allowed = ['lore.list'],
  onCall = null,
  intentions = null,
  withErrands = false,
  errandConfigured = true,
  loop = null,
  skillsLoop = null,
  clock = () => NOW,
  slowMs = 0,
  gifs = null,
  wakes = {},
  filler = 0,
}: {
  answers: Array<unknown>;
  shadow?: boolean;
  gate?: Record<string, Untyped>;
  journal?: Untyped;
  allowed?: Array<string>;
  onCall?: ((calls: number) => void) | null;
  intentions?: Untyped;
  withErrands?: boolean;
  errandConfigured?: boolean;
  loop?: Record<string, Untyped> | null;
  skillsLoop?: Record<string, Untyped> | null;
  clock?: () => number;
  slowMs?: number;
  gifs?: Record<string, Untyped> | null;
  wakes?: Record<string, Untyped>;
  filler?: number;
}) {
  const history = [
    rawMessage({ id: 'm0', ts: NOW - 120_000, content: 'πρώτο' }),
    ...Array.from({ length: filler }, (_, n) => rawMessage({ id: `f${n}`, ts: NOW - 110_000 + n, content: 'πάλι' })),
    rawMessage({ id: 'm1', authorId: 'u2', authorName: 'Zoë', content: 'δεύτερο' }),
    rawMessage({ id: 'm2', ts: NOW - 30_000, content: 'τρίτο' }),
  ];
  const hot: Record<string, Untyped> = innerTurnHotWith({ access: innerTurnPersonaGrants(allowed), wakes });
  const wakes2 = hot.config.wakes;
  if (loop) wakes2.loop = { ...loop };
  const tools = hot.config.tools;
  if (skillsLoop) tools.loop = { ...tools.loop, ...skillsLoop };
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const store = innerTurnFakeStore();
  if (gifs)
    Object.assign(store, {
      findGif: (handle: string) => gifs[handle] ?? null,
      recordOwnGif: () => {},
    });
  // A real errand service over a temp task store, its runner a fake whose runs never end.
  let errands = null;
  if (withErrands) {
    hot.config.agents = { maxOpen: 3, scout: { enabled: true, daily: { tasks: 10 } } };
    const stores = createErrandStores(wrongly({ dataDir: tempDir('nep-inner-errand-'), config: () => hot.config }));
    errands = createErrandService({
      client: { configured: () => errandConfigured, run: () => new Promise(() => {}), cancel: () => true },
      stores,
      hot,
    });
  }
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads: world().adopt(port),
    ...(errands ? { errands } : {}),
  });
  const llm = sequenceLlm(answers, { onCall });
  const calibrator = { ratio: 1, apply: (value: string) => value, observe: () => {} };
  const slow = (fn: Untyped) =>
    slowMs > 0
      ? async (...a: Array<Untyped>) => {
          await new Promise((resolve) => setTimeout(resolve, slowMs));
          return fn(...a);
        }
      : fn;
  const turns = innerTurnCreateTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm,
    calibrator,
    client,
    now: clock,
    port,
    skills: skillRegistry(),
    journal,
    runOp: slow(admin.runSkillOp),
    runOwnOp: slow(admin.runOwnSkillOp),
    runInitiativeOp: slow(admin.runInitiativeSkillOp),
    intentions,
    ...(errands ? { errands } : {}),
  });
  const inner = { wake: WAKE, shadow, mayAct: () => true, ...gate };
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel: fakeChannel(history),
      placeId: 'g1',
      mode: 'inner',
      triggerKind: 'inner',
      inner,
    })
  );
  const sends = port.calls
    .filter((call) => call.op === 'send')
    .map(({ args }: Record<string, Untyped>) => ({ to: args[0].chatId, ...args[1] }));
  return {
    result: wrongly<InnerResult>(result),
    logs,
    llm,
    sends,
    store,
    tasks: errands ? present(errands.store()).recent(10) : [],
  };
}

test("feedbackFacts: every status that is not ok is a callFailed with its code and the operation's own text; a proposed call is none", () => {
  const statuses = ['failed', 'partial', 'invalid', 'denied', 'not_configured', 'unknown'];
  const actions = statuses.map((result) => ({
    skill: 'web.search',
    status: 'executed',
    result,
    code: `c-${result}`,
    text: `said ${result}`,
  }));
  actions.push(wrongly({ skill: 'web.search', status: 'executed', result: 'unknown', code: 'timeout' }));
  actions.push(wrongly({ skill: 'message.create', status: 'proposed', result: 'ok' }));
  actions.push(wrongly({ skill: 'message.create', status: 'refused', result: 'denied', code: 'inner-stopped' }));
  const facts = innerTurnFeedbackFacts({ inner: { actions, intentIds: [] } });
  assert.deepEqual(
    facts.map((fact) => `${fact.status}:${fact.code}:${fact.text ?? ''}`),
    [...statuses.map((status) => `${status}:c-${status}:said ${status}`), 'timeout:timeout:', 'refused:inner-stopped:']
  );
});

test("inner turn, live: a call that did not work carries the operation's own words into its action and its callFailed fact", async () => {
  const run = await innerTurn({
    answers: [toolAnswer('', [call('errand.scout', { goal: 'βρες τον πίνακα' })]), '<skip/>'],
    shadow: false,
    allowed: ['errand.scout'],
    withErrands: true,
    errandConfigured: false,
  });
  const inner = run.result.inner;
  const [action] = inner.actions;
  assert.notEqual(action.result, 'ok');
  assert.equal(action.presented, true);
  assert.deepEqual(innerTurnFeedbackFacts(run.result), [], 'the next step showed the outcome: no fact');
  const [fact] = innerTurnFeedbackFacts({ inner: { actions: [{ ...action, presented: undefined }] } });
  assert.equal(fact.kind, 'callFailed');
  assert.equal(fact.skill, 'errand.scout');
  assert.equal(
    fact.status,
    ['failed', 'partial', 'invalid', 'denied', 'not_configured', 'unknown', 'timeout', 'refused'].includes(
      action.result
    )
      ? action.result
      : 'failed'
  );
  assert.equal(fact.code, action.code ?? null);
  if (action.text) assert.equal(fact.text, action.text);
});

test('feedbackFacts: a parser diagnostic that no step showed the persona is a diagnostic fact with its kind and fields', () => {
  const facts = innerTurnFeedbackFacts({
    outcome: 'skip',
    inner: {
      actions: [],
      intentIds: [],
      loop: {},
      diagnostics: [
        { kind: 'badCall', reason: 'unclosed' },
        { kind: 'messageCut', chars: 3 },
      ],
    },
  });
  assert.deepEqual(facts, [
    { kind: 'diagnostic', diagnostic: 'badCall', reason: 'unclosed' },
    { kind: 'diagnostic', diagnostic: 'messageCut', chars: 3 },
  ]);
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

/** The facts the wake of `params` showed the persona. */
function factsOf(params: InnerTurnParams | undefined): Array<unknown> {
  const wake = params?.inner.wake;
  return wake?.facts ?? [];
}

/** The texts of the sends that reached `port`, in order. */
function sendsOf(port: Fake): Array<unknown> {
  return port.calls.filter((one) => one.op === 'send').map((one): unknown => Reflect.get(Object(one.args[1]), 'text'));
}

/** The persona's calls of a turn's result as `<skill>:<code>`, in the order they made them. */
function actionsOf(result: unknown): Array<string> {
  const inner: unknown = Reflect.get(Object(result), 'inner');
  const actions: unknown = Reflect.get(Object(inner), 'actions');
  if (!Array.isArray(actions)) return [];
  return actions.map((action: unknown) => {
    const skill: unknown = Reflect.get(Object(action), 'skill');
    const code: unknown = Reflect.get(Object(action), 'code');
    return `${String(skill)}:${typeof code === 'string' ? code : ''}`;
  });
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
    historyMessages: [innerWakeSendsRawMessage({ id: 'm1', ts: T - HOUR, content: 'καλή σας μέρα' })],
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

/** The facts a turn's wake showed the persona, each as `<kind>:<code>`. */
const factCodesOf = (params: InnerTurnParams | undefined): Array<string> =>
  factsOf(params).map(
    (fact) => `${String(Reflect.get(Object(fact), 'kind'))}:${String(Reflect.get(Object(fact), 'code'))}`
  );

/** The wake kinds of the turns `run` ran, in order. */
const kindsOf = (run: Core): Array<string> => run.calls.map(({ inner }) => inner.wake.kind);

/** Ticks `run` a minute at a time from `from` until `count` turns ran or two hours passed. */
async function tickUntil(run: Core, from: number, count: number): Promise<void> {
  for (let at = from; at <= from + 2 * HOUR && run.calls.length < count; at += MINUTE) {
    run.clock.t = at;
    await run.life.tick();
  }
}

test('a post a heartbeat wrote as a <msg> in its last answer is refused heartbeat-only, wakes no feedback turn and is told by the next heartbeat', async () => {
  const run = await core({ answers: ['<msg>καλημέρα</msg><skip/>', '<skip/>'] }, { heartbeat: true });
  try {
    await run.life.tick();
    run.clock.t = T + HOUR + MINUTE;
    await run.life.tick();
    assert.deepEqual(actionsOf(run.results[0]), ['message.create:heartbeat-only']);
    await tickUntil(run, T + HOUR + 2 * MINUTE, 2);
    assert.deepEqual(kindsOf(run), ['heartbeat', 'heartbeat'], 'no feedback turn ran between the two heartbeats');
    assert.deepEqual(sendsOf(run.port), [], 'nothing was posted');
    assert.ok(factCodesOf(run.calls[1]).includes('callFailed:heartbeat-only'), factCodesOf(run.calls[1]).join(', '));
  } finally {
    await run.close();
  }
});

test("a heartbeat's refusal beside another miss is left out of the feedback turn and told by the next heartbeat", async () => {
  // A stray closing tag is a miss of another kind, which wakes a feedback turn.
  const run = await core({ answers: ['<msg>καλημέρα</msg></msg><skip/>', '<skip/>'] }, { heartbeat: true });
  try {
    await run.life.tick();
    await tickUntil(run, T + HOUR + MINUTE, 3);
    assert.deepEqual(kindsOf(run), ['heartbeat', 'feedback', 'heartbeat']);
    assert.ok(!factCodesOf(run.calls[1]).includes('callFailed:heartbeat-only'), factCodesOf(run.calls[1]).join(', '));
    assert.ok(factCodesOf(run.calls[2]).includes('callFailed:heartbeat-only'), factCodesOf(run.calls[2]).join(', '));
    assert.deepEqual(sendsOf(run.port), [], 'nothing was posted');
  } finally {
    await run.close();
  }
});

// A heartbeat takes several intention changes, so the turn goes on after the change and the persona reads the
// refusals in it. The next heartbeat tells them no more.
// Bug caught: the refused posts wake a feedback turn that could post them, or a refusal the persona read is told again.
test('a post a heartbeat refused beside a change is read in the same turn, wakes no feedback turn and is not told again', async () => {
  const post = toolAnswer('', [
    call('message.create', { place: '#chan-c1', text: 'καλημέρα' }),
    call('message.create', { place: '#chan-c1', text: 'τι κάνετε;' }),
    call('intention.set', { due: '6h', text: 'ask how the trip went' }),
  ]);
  const run = await core({ answers: [post, '<skip/>'] }, { heartbeat: true });
  try {
    await run.life.tick();
    run.clock.t = T + HOUR + MINUTE;
    await run.life.tick();
    const { requests } = run.llm;
    assert.equal(requests.length, 2, 'the change, then the request that reads the refusals');
    await tickUntil(run, T + HOUR + 2 * MINUTE, 2);
    assert.deepEqual(kindsOf(run), ['heartbeat', 'heartbeat'], 'no feedback turn ran between the two heartbeats');
    assert.deepEqual(sendsOf(run.port), [], 'nothing was posted');
    assert.deepEqual(factCodesOf(run.calls[1]), []);
  } finally {
    await run.close();
  }
});

/** What a tick's `drained` answer holds, whichever of its forms it took. */
type Drained = { outcome?: string; feedback?: string; deferred?: string; wakes?: number };

const drainedOf = (answer: { drained?: unknown }): Drained => wrongly<Drained>(answer.drained);

useIface('fake');

const settle = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => void (innerClock.t = INNER_NOW));

/** `count` intentions due now, each in a channel of its own, so their wakes fill as many places of the queue. */
const queueFillers = (count: number) => [...Array(count).keys()].map((n) => intention(`q${n}`, { placeId: `c-q${n}` }));

// ---- recurring intentions ------------------------------------------------------------

/** The production intention service over the inner life's temp data directory. */
function realIntentions(hot: Record<string, Untyped>, dataDir: string) {
  hot.config.intentions = {
    expiresDays: 14,
    recurringExpiresDays: 30,
    maxOpen: 20,
  };
  return createIntentionService({
    stores: createIntentionStores({ dataDir, now: () => innerClock.t, log: INNER_SILENT }),
    hot,
    now: () => innerClock.t,
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
    at = INNER_NOW - 5 * MINUTE_MS,
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
  settle = 60,
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
  const hot = innerHotWith({ wakes });
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
    now: () => innerClock.t,
    log: INNER_SILENT,
  });
  // Set an hour ago: lines before an attention was set are never new to it.
  innerClock.t = INNER_NOW - HOUR_MS;
  const set = service.set({
    purpose: 'listen there',
    attend: { place, people, settle, perDay },
    placeId: 'c1',
    scope: 'group',
  });
  innerClock.t = INNER_NOW;
  assert.equal(set.ok, true, wrongly(set.code));
  return { inner, turns, journal, service, record, id: set.intention.id, hot };
}

test('inner: a turn that lost something queues one feedback wake in its chain and chat, due at the next tick, with the facts; the feedback turn gets none of its own (journalled only)', async () => {
  const turns = fakeTurns({ answer: () => lostTurn() });
  const run = setup({
    records: [intention('i1', { purpose: 'send a cat meme' })],
    turns,
    hot: innerHotWith({ wakes: { mode: 'live' } }),
  });
  const first = await run.inner.tick();
  assert.equal(drainedOf(first).feedback, 'inner.wake:feedback:t-1');
  const calls = run.turns.calls;
  assert.equal(calls.length, 1);
  const queued = run.inner.state().queue;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'feedback');
  assert.equal(queued[0].chainId, 'intention:i1');
  assert.equal(queued[0].placeId, 'c1');
  assert.equal(queued[0].dueAt, INNER_NOW);
  assert.deepEqual(
    present(queued[0].facts).map((fact) => fact.kind),
    ['callFailed', 'callFailed', 'doneWithoutDelivery', 'loopCut']
  );
  // The next tick runs the feedback turn: the same chain and channel, the facts on its wake item.
  innerClock.t = INNER_NOW + MINUTE_MS;
  await run.inner.tick();
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, 2);
  const params = calls2[1];
  assert.equal(present(params.chat).chatId, 'c1');
  const wake = params.inner.wake;
  assert.equal(wake.kind, 'feedback');
  assert.equal(wake.chainId, 'intention:i1');
  const item = wake.items[0];
  assert.deepEqual(present(item.facts)[0], {
    kind: 'callFailed',
    skill: 'message.create',
    status: 'refused',
    code: 'destination-required',
  });
  assert.equal(present(item.facts)[2].purpose, 'send a cat meme');
  assert.equal(
    chainBudget(run.inner.state(), 'intention:i1', 3, { now: innerClock.t, timezone: 'UTC' }).used,
    1,
    'the feedback turn does not count against the chain'
  );
  // The feedback turn lost the same things again: journalled, never a second wake.
  innerClock.t = INNER_NOW + 2 * MINUTE_MS;
  await run.inner.tick();
  const calls3 = run.turns.calls;
  assert.equal(calls3.length, 2, 'no feedback on a feedback turn');
  assert.deepEqual(run.inner.state().queue, []);
  await settle();
  const notes = run.journal.filter((entry) => entry.event === 'turn');
  assert.equal(notes.length, 2);
  const feedback = notes[0].feedback;
  assert.equal(feedback.wake, 'inner.wake:feedback:t-1');
  assert.deepEqual(notes[0].loop, { steps: 2, cut: 'steps', droppedCalls: 1 });
  const feedback2 = notes[1].feedback;
  assert.equal(feedback2.wake, null);
  assert.deepEqual(
    feedback2.facts.map((fact: Record<string, Untyped>) => fact.kind),
    ['callFailed', 'callFailed', 'doneWithoutDelivery', 'loopCut']
  );
  const wakeNote = run.journal.find((entry) => entry.event === 'wake' && entry.wake.kind === 'feedback');
  assert.equal(present(wakeNote).wake.turnId, 't-1');
  assert.equal(present(wakeNote).wake.facts.length, 4);
  // A turn that lost nothing queues nothing.
  const quiet = setup({ records: [intention('i2')] });
  const result = await quiet.inner.tick();
  assert.equal(drainedOf(result).feedback, undefined);
  assert.deepEqual(quiet.inner.state().queue, []);
  await settle();
  assert.deepEqual(present(quiet.journal.find((entry) => entry.event === 'turn')).feedback, { facts: [], wake: null });
});

/** The facts of the state as `kind:code:why`, oldest first. */
const factLines = (run: Record<string, Untyped>) =>
  run.inner
    .state()
    .facts.map((fact: Record<string, Untyped>) => [fact.kind, fact.code, fact.why].filter(Boolean).join(':'));

// Slice 5: a due intention whose place is gone runs nowhere instead of being dropped (plan 5 (a)), so the wake dropped
// no-channel here is an attention on a place the client cannot fetch, and a due intention is the next turn.
test('inner: a wake of the persona dropped no-channel is a fact at that moment (where, why), shown in the wake of the next turn and told once that turn completed; no feedback wake is needed', async () => {
  // The attention lands in a channel the client cannot fetch: dropped no-channel at the first drain.
  const run = attentionSetup({
    place: 'c9',
    lines: [seen('m1', { channel: 'c9', by: 'u1', at: INNER_NOW - 4 * MINUTE_MS })],
    wakes: { mode: 'live' },
  });
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 0);
  const [fact] = run.inner.state().facts;
  assert.deepEqual(
    [fact.kind, fact.code, fact.why, fact.wake, fact.intentionId, fact.purpose, fact.placeId, fact.dmChat, fact.told],
    ['wakeDropped', 'no-channel', 'unavailable', 'attend', run.id, 'listen there', 'c9', false, false]
  );
  // A due intention runs a turn: it shows the drop.
  run.service.set({ purpose: 'announce the game night', dueAt: INNER_NOW + MINUTE_MS, placeId: 'c1', scope: 'group' });
  innerClock.t = INNER_NOW + 2 * MINUTE_MS;
  await run.inner.tick();
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, 1);
  const inner = calls2[0].inner;
  assert.deepEqual(inner.wake.facts, [
    {
      kind: 'wakeDropped',
      wakeId: `inner.wake:attend:${run.id}:m1`,
      wake: 'attend',
      code: 'no-channel',
      why: 'unavailable',
      intentionId: run.id,
      purpose: 'listen there',
    },
  ]);
  assert.ok(run.inner.state().facts[0].told, 'told once the turn completed');
  assert.deepEqual(run.inner.state().queue, [], 'the turn carried it: no feedback wake');
  // Another due intention: nothing is repeated.
  run.service.set({ purpose: 'say hi', dueAt: INNER_NOW + 4 * MINUTE_MS, placeId: 'c2', scope: 'group' });
  innerClock.t = INNER_NOW + 5 * MINUTE_MS;
  await run.inner.tick();
  const calls3 = run.turns.calls;
  assert.equal(calls3.length, 2);
  const inner2 = calls3[1].inner;
  assert.equal(inner2.wake.facts, undefined);
});

// Slice 5: the fact is the drop of an attention on a place the client cannot fetch, since a due intention whose place
// is gone runs nowhere instead of being dropped (plan 5 (a)).
test('inner: a fact is told only after a model answer that carried it completed -- an error leaves it, the retry shows it again', async () => {
  let runs = 0;
  const turns = fakeTurns({
    answer: () =>
      ++runs === 1
        ? { outcome: 'error', reason: 'provider-limit' }
        : { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${runs}` } },
  });
  const run = attentionSetup({
    place: 'c9',
    lines: [seen('m1', { channel: 'c9', by: 'u1', at: INNER_NOW - 4 * MINUTE_MS })],
    turns,
  });
  await run.inner.tick();
  run.service.set({ purpose: 'say hi', dueAt: INNER_NOW, placeId: 'c1', scope: 'group' });
  await run.inner.tick();
  const calls = run.turns.calls;
  const inner = calls[0].inner;
  assert.equal(present(inner.wake.facts).length, 1);
  assert.equal(
    present(run.inner.state().facts.find((fact) => fact.kind === 'wakeDropped')).told,
    false,
    'the turn erred: not told'
  );
  innerClock.t = INNER_NOW + MINUTE_MS;
  await run.inner.tick();
  const calls2 = run.turns.calls;
  const inner2 = calls2[1].inner;
  assert.equal(
    present(inner2.wake.facts)
      .map((fact) => fact.kind)
      .join(),
    'wakeDropped,turnFailed',
    'shown again with the failure of the first try'
  );
  assert.ok(run.inner.state().facts.every((fact) => fact.told));
});

// Slice 5: a due intention in a private chat while private chats are off, or in a place that cannot be fetched, is no
// longer dropped no-channel: its turn runs nowhere with the place's code (plan 5 (a)). The codes stay under test there.
test('inner: every wake outcome other than a turn is a wakeDropped fact at the moment: stopped, overflow, stale (done, cancelled, forgotten); a due intention whose place fails runs nowhere with its code (unavailable, dm-off)', async () => {
  world().channel({ id: 'd1', dm: true });
  const direct = {
    ...intention('i5', { placeId: 'd1' }),
    provenance: { kind: 'self', placeId: 'd1', scope: 'dm' },
  };
  const run = setup({
    records: [intention('i1'), intention('i2'), intention('i3')],
    client: fakeClient(),
  });
  run.turns.busy = true;
  await run.inner.tick();
  assert.equal(run.inner.state().queue.length, 3);
  const records = run.intentions.records;
  records[0].status = 'cancelled';
  const records2 = run.intentions.records;
  records2[1].status = 'done';
  const records3 = run.intentions.records;
  records3.splice(2, 1);
  run.turns.busy = false;
  await run.inner.tick();
  assert.deepEqual(factLines(run), [
    'wakeDropped:stale:cancelled',
    'wakeDropped:stale:done',
    'wakeDropped:stale:forgotten',
  ]);
  // A private chat while private chats are off, and a place that cannot be fetched.
  const records4 = run.intentions.records;
  records4.push(direct, intention('i6', { placeId: 'c9', dueAt: INNER_NOW - 30_000 }));
  await run.inner.tick();
  await run.inner.tick();
  assert.equal(factLines(run).length, 3, 'no drop');
  const calls = run.turns.calls;
  assert.deepEqual(
    calls.map(({ inner: { wake } }) => `${wake.intentions.map((r) => r.id).join()}:${wake.placeFailure}`).sort(),
    ['i5:dm-off', 'i6:unavailable']
  );
  assert.ok(calls.every((call) => call.chat === null));
  // The queue full (PR 7d: twenty wakes, `wakes.queueMax` is a constant): the overflowing wake is dropped on the spot; the stop drops what waits.
  const full = setup({ records: [...queueFillers(20), intention('i1')] });
  full.turns.busy = true;
  await full.inner.tick();
  assert.deepEqual(factLines(full), ['wakeDropped:overflow']);
  full.inner.stop({ by: 'owner' });
  assert.deepEqual(factLines(full), ['wakeDropped:overflow', ...Array(20).fill('wakeDropped:stopped')]);
  assert.equal(full.inner.state().facts[1].purpose, 'purpose q0');
});

test("inner: a wake held on the attention's own per-day bound is a wakeHeld fact once, with the local midnight it waits for; the next turn shows it, once", async () => {
  const lines = [seen('m1', { by: 'u1', at: INNER_NOW - 5 * MINUTE_MS })];
  const held = attentionSetup({ lines, perDay: 1, wakes: { mode: 'live' } });
  await held.inner.tick();
  const calls = held.turns.calls;
  assert.equal(calls.length, 1, 'the first burst of the day');
  const lines2 = held.record.lines;
  lines2.push(seen('m2', { by: 'u2', at: INNER_NOW + 10 * MINUTE_MS }));
  innerClock.t = INNER_NOW + 12 * MINUTE_MS;
  assert.deepEqual((await held.inner.tick()).drained, { refused: 'attend-per-day' });
  const facts = held.inner.state().facts;
  assert.equal(facts.length, 1);
  assert.deepEqual(
    [facts[0].kind, facts[0].code, facts[0].intentionId, facts[0].purpose, facts[0].until, facts[0].told],
    ['wakeHeld', 'attend-per-day', held.id, 'listen there', Date.parse('2026-10-20T00:00:00Z'), false]
  );
  await held.inner.tick();
  assert.equal(held.inner.state().facts.length, 1, 'told once, not at every tick');
  // A due intention runs a turn: it shows the hold.
  held.service.set({ purpose: 'say hi', dueAt: INNER_NOW + 30 * MINUTE_MS, placeId: 'c1', scope: 'group' });
  innerClock.t = INNER_NOW + 31 * MINUTE_MS;
  await held.inner.tick();
  const calls2 = held.turns.calls;
  assert.equal(calls2.length, 2);
  const inner = calls2[1].inner;
  assert.deepEqual(inner.wake.facts, [
    {
      kind: 'wakeHeld',
      wakeId: facts[0].wakeId,
      wake: 'attend',
      code: 'attend-per-day',
      intentionId: held.id,
      purpose: 'listen there',
      until: Date.parse('2026-10-20T00:00:00Z'),
    },
  ]);
  assert.ok(held.inner.state().facts[0].told);
  held.service.set({ purpose: 'say bye', dueAt: INNER_NOW + 40 * MINUTE_MS, placeId: 'c1', scope: 'group' });
  innerClock.t = INNER_NOW + 41 * MINUTE_MS;
  await held.inner.tick();
  const calls3 = held.turns.calls;
  const inner2 = calls3[2].inner;
  assert.equal(inner2.wake.facts, undefined, 'told once');
});

test('inner: a chain held on its per-chain cap with no turn coming is told by a feedback wake that no cap holds and no other wake joins, and that does not count against the chain', async () => {
  const k1 = { ...intention('i1', { chainId: 'k' }), purpose: 'first' };
  const run = setup({ records: [k1], hot: innerHotWith({ wakes: { mode: 'live', caps: { perChain: 1 } } }) });
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 1);
  const records = run.intentions.records;
  records.push({ ...intention('i2', { chainId: 'k', dueAt: INNER_NOW - 30_000 }), purpose: 'second' });
  innerClock.t = INNER_NOW + MINUTE_MS;
  assert.deepEqual((await run.inner.tick()).drained, { refused: 'per-chain' });
  const queue = run.inner.state().queue;
  assert.deepEqual(
    queue.map((wake) => [wake.kind, wake.capped ?? null]),
    [
      ['intention_due', 'per-chain'],
      ['feedback', null],
    ]
  );
  assert.equal(queue[1].placeId, 'c1');
  // Next tick: the feedback turn runs although its chain is full, alone, with the hold.
  innerClock.t = INNER_NOW + 2 * MINUTE_MS;
  await run.inner.tick();
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, 2);
  const params = calls2[1];
  const wake2 = params.inner.wake;
  assert.equal(wake2.kind, 'feedback');
  assert.deepEqual(
    wake2.items.map((item) => item.kind),
    ['feedback'],
    'not coalesced with anything'
  );
  const item2 = wake2.items[0];
  assert.deepEqual(item2.facts, [
    {
      kind: 'wakeHeld',
      wakeId: queue[0].id,
      wake: 'intention_due',
      code: 'per-chain',
      intentionId: 'i2',
      purpose: 'second',
      until: Date.parse('2026-10-20T00:00:00Z'),
    },
  ]);
  assert.equal(
    chainBudget(run.inner.state(), 'chain:k', 1, { now: innerClock.t, timezone: 'UTC' }).used,
    1,
    'the feedback turn is no turn of the chain'
  );
  assert.ok(run.inner.state().facts.every((fact) => fact.told));
  assert.deepEqual(
    run.inner.state().queue.map((wake) => wake.kind),
    ['intention_due'],
    'the held wake waits for the next day'
  );
});

test('inner: a feedback wake whose facts an earlier turn already carried is handled without a turn', async () => {
  const lines = [seen('m1', { by: 'u1', at: INNER_NOW - 5 * MINUTE_MS })];
  const turns = failingTurns(99, 'cut-off');
  const run = attentionSetup({ lines, turns });
  await run.inner.tick();
  const state = run.inner.state();
  const feedback = state.queue.find((wake) => wake.kind === 'feedback');
  assert.ok(feedback, 'the failed wake left a feedback wake');
  const facts = run.inner.facts;
  facts.markTold(state.facts.map((fact) => fact.id));
  const before = turns.calls.length;
  innerClock.t = INNER_NOW + 10 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(turns.calls.length, before, 'no turn was run for it');
  assert.equal(
    run.inner.state().queue.some((wake) => wake.id === feedback.id),
    false
  );
  assert.equal(run.inner.state().handled[feedback.id].outcome, 'told');
});

test('inner: a fact of a private chat is shown only in that chat, a fact of the server never in a private chat; pending facts are kept seven days, told ones a day', async () => {
  const run = setup({ hot: innerHotWith({ wakes: { mode: 'live' } }) });
  const { facts } = run.inner;
  facts.add({
    kind: 'sendFailed',
    code: 'forbidden',
    n: 0,
    total: 1,
    placeId: 'd1',
    dmChat: true,
    at: INNER_NOW,
  });
  facts.add({
    kind: 'sendFailed',
    code: 'forbidden',
    n: 0,
    total: 2,
    placeId: 'c2',
    dmChat: false,
    at: INNER_NOW,
  });
  facts.add({
    kind: 'callFailed',
    skill: 'web.read',
    status: 'failed',
    code: 'error',
    placeId: null,
    dmChat: false,
    at: INNER_NOW,
  });
  const codes = (scope: Record<string, Untyped>) => facts.pending(scope).map((fact) => `${fact.kind}:${fact.placeId}`);
  assert.deepEqual(codes({ placeId: 'd1', dmChat: true }), ['sendFailed:d1']);
  assert.deepEqual(codes({ placeId: 'd2', dmChat: true }), [], 'another private chat sees none');
  assert.deepEqual(
    codes({ placeId: 'c1', dmChat: false }),
    ['callFailed:null'],
    'an addressed server turn: its channel and the channel-less'
  );
  assert.deepEqual(
    codes({ placeId: 'c1', dmChat: false, anywhere: true }),
    ['sendFailed:c2', 'callFailed:null'],
    'an inner turn: the whole server, no private chat'
  );
  // An inner turn in the server never shows the private fact.
  const records = run.intentions.records;
  records.push(intention('i1'));
  await run.inner.tick();
  const calls = run.turns.calls;
  const inner = calls[0].inner;
  assert.deepEqual(
    wrongly<Array<{ kind: string; total?: number }>>(present(inner.wake.facts)).map(
      (fact) => fact.kind + (fact.total ?? '')
    ),
    ['sendFailed2', 'callFailed']
  );
  assert.deepEqual(codes({ placeId: 'd1', dmChat: true }), ['sendFailed:d1']);
  // The keep times.
  const state = run.inner.state();
  const fact2 = state.facts[0];
  fact2.at = INNER_NOW - 8 * DAY_MS;
  innerClock.t = INNER_NOW + 12 * HOUR_MS;
  facts.markTold([]);
  assert.deepEqual(
    state.facts.map((fact) => fact.kind + (fact.dmChat ? ':dm' : '')),
    ['sendFailed', 'callFailed'],
    'the private fact waited past seven days and is gone; the told ones are half a day old'
  );
  innerClock.t = INNER_NOW + 2 * DAY_MS;
  facts.markTold([]);
  assert.deepEqual(state.facts, [], 'told facts go after a day');
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
