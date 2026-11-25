// The wake queue of the inner life (src/behavior/inner/wake-queue.ts): the lease on a running wake, and what a restart, a
// fault or a pause leaves of a queued or running wake.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../../../../src/behavior/turn.ts';
import { createReads } from '../../../../src/interface/reads.ts';
import { userText } from '../../../../src/behavior/prompt.ts';
import { createInnerLife, wakeOfDue } from '../../../../src/behavior/inner.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { createEventDoor } from '../../../../src/interface/door.ts';
import { personaJournal } from '../../../../src/behavior/inner/persona-sources.ts';
import { createErrandStores } from '../../../../src/errands/store.ts';
import { createErrandService } from '../../../../src/errands/service.ts';
import { createErrandTurns } from '../../../../src/errands/turns.ts';
import { runOp } from '../../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import { createAdmin } from '../../../../src/admin.ts';
import { DAY_MS, MINUTE_MS, HOUR_MS } from '../../../../src/time.ts';
import { labels } from '../../../fixtures/labels.ts';
import { completionOf } from '../../../fixtures/tool-answers.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { openTestMemorySync, openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { wrongly, present } from '../../../fixtures/loose-types.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';
import type { InnerJournal, InnerTurnParams } from '../../../../src/behavior/inner/types.ts';
import { createIntentionService } from '../../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../../src/intentions/store.ts';
import { leaseOf, wakeOf } from '../../../../src/memory/db/wake-queue.ts';
import { useIface, world } from '../../../fixtures/turn-world.ts';
import { unitValue } from '../../../../src/memory/db/readers/common.ts';
import { personaKey } from '../../../../src/memory/db/unit-keys.ts';
import {
  NOW,
  clock as innerClock,
  fakeTurns,
  hotWith as innerHotWith,
  intention,
  setup,
  wakeMemory,
} from '../../../fixtures/inner-rig.ts';

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

// ---- the rows ----

test('row 1: a queued wake is interrupted after reload and the due list does not revive it', async () => {
  const dataDir = tempDir('nep-fault-');
  const chat = makeChat();
  const records = [intentionRecord('i1', { purpose: 'say good morning' })];
  const before = boot(chat, { dataDir, records });
  const wake = wakeOfDue({ intention: records[0], reason: 'due', at: records[0].dueAt });
  assert.deepEqual((await before.accept(wake)).status, 'ok');
  assert.equal(before.state().queue.length, 1);
  const calls = chat.llm.calls;
  assert.equal(calls.length, 0, 'it died before any turn ran');

  const after = boot(chat, { dataDir, records });
  assert.deepEqual(
    after.state().queue.map((queued: Record<string, Untyped>) => queued.id),
    [wake.id],
    'the queue is read back from the disk'
  );
  await after.tick();
  // Restart retains the queued action as evidence and requires a fresh decision to act.
  const calls2 = chat.llm.calls;
  assert.equal(calls2.length, 0, 'neither recovery nor the due list revives the old wake');
  assert.equal(after.state().handled[wake.id].outcome, 'interrupted');
  assert.deepEqual(after.state().queue, []);
  assertNoSilentFailure(after, { accepted: [wake.id] });
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

useIface('fake');

const ROOT = 'g1';

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

const T = Date.parse('2026-10-31T12:00:00Z');

const LEASE_MS = MINUTE;

const INNER_WAKES_SILENT = { info() {}, warn() {}, error() {}, debug() {} };

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

type Answer = (params: InnerTurnParams) => Promise<unknown>;

/** The pause flags of the store (`/nep pause` sets them in state.json). */
type PauseFlags = { paused?: boolean; pausedAt?: string };

/** The answer of a turn that ran and said nothing. */
const skipped = (): Promise<unknown> =>
  Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-inner' } });

function hotOf() {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { turnLeaseMs: LEASE_MS },
      features: { wakes: true, intentions: true, journal: false },
      mention: { oneAtATime: true },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: { enabled: false, dueJitterMinutes: 0 },
    },
  };
}

/**
 * One core over a data directory: a memory database opened there, an inner life with its door, and what the core
 * keeps across a restart (the clock, the intentions, the store's pause flags). `restart()` closes the database and
 * opens a new one and a new inner life over the same directory, as a new process would.
 */
async function core(dataDir = tempDir('nep-inner-wakes-'), journal: InnerJournal | null = null) {
  world().channel({ id: 'c1', name: 'chan-c1', placeId: ROOT, permissions: { send: true } });
  const clock = { t: T };
  const hot = hotOf();
  const flags: PauseFlags = {};
  const store = { state: { data: flags } };
  const service = createIntentionService({
    stores: createIntentionStores({ now: () => clock.t, log: INNER_WAKES_SILENT }),
    hot,
    now: () => clock.t,
    log: INNER_WAKES_SILENT,
  });
  const turns = { busy: false, calls: [] as Array<InnerTurnParams>, answer: skipped as Answer };
  // One stream of ids across restarts, as each process draws its own.
  let ids = 0;
  const open = async () => {
    const memory = await openTestMemory({
      dataDir,
      iface: () => 'fake',
      config: { context: { turnLeaseMs: LEASE_MS } },
      now: () => clock.t,
    });
    let life: ReturnType<typeof createInnerLife> | null = null;
    const door = createEventDoor({
      handlers: { 'inner.wake': (event: object) => life?.onWake(event) },
      log: INNER_WAKES_SILENT,
    });
    life = createInnerLife({
      hot,
      dataDir,
      turns: {
        isAnyBusy: () => turns.busy,
        runTurn: (params: InnerTurnParams) => {
          turns.calls.push(params);
          return turns.answer(params);
        },
      },
      intentions: service,
      reads: world().reads,
      iface: () => 'fake',
      chatName: (id: string) => `chan-${id}`,
      submit: (event: object) => door.submit(event),
      store,
      meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
      memoryDb: memory.memoryDb,
      journal,
      rng: () => 0.5,
      uuid: () => `u${(ids += 1)}`,
      now: () => clock.t,
      log: INNER_WAKES_SILENT,
    });
    return { memory, life };
  };
  let current = await open();
  return {
    dataDir,
    clock,
    flags,
    service,
    turns,
    get life() {
      return current.life;
    },
    get memory(): Memory {
      return current.memory;
    },
    async restart() {
      await current.memory.close();
      current = await open();
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

/** The service's read connection, which its JS source leaves untyped; refused when the database is not open. */
function readHandleOf(memory: Memory): { db: object } {
  const handle: unknown = memory.memoryDb.readHandle();
  const db: unknown = typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'db') : null;
  if (typeof db !== 'object' || db === null) throw new Error('the memory database is not open');
  return { db };
}

/** Whether the writer connection holds an open transaction (on the calling thread it is the read connection too). */
function inTransaction(memory: Memory): unknown {
  return Reflect.get(readHandleOf(memory).db, 'isTransaction');
}

test('the drain claims the wake with a lease before the turn asks the model, and completes it as handled after', async () => {
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    const seen: Array<{ state: unknown; token: unknown; holder: unknown; lease: ReturnType<typeof leaseOf> }> = [];
    run.turns.answer = () => {
      const read = readHandleOf(run.memory);
      const wake = wakeOf(read, wakeId);
      seen.push({
        state: wake?.state,
        token: wake?.leaseToken,
        holder: wake?.leaseHolder,
        lease: leaseOf(read, `wake:${wakeId}`),
      });
      return skipped();
    };
    await run.life.tick();
    const calls = run.turns.calls;
    assert.equal(calls.length, 1);
    const [during] = seen;
    assert.equal(during?.state, 'running');
    assert.ok(Number(during?.token) >= 1, 'a granted token');
    assert.equal(during?.lease?.token, during?.token, 'the wake carries the token of its lease');
    assert.equal(during?.lease?.holder, during?.holder);
    // Catches: the queue names its holder with an id of its own, so a replay seeded with `uuid` differs run to run.
    assert.equal(during?.holder, 'core:u1', 'the holder is named by the injected uuid');
    assert.equal(during?.lease?.expiresAt, T + LEASE_MS, 'the lease lasts context.turnLeaseMs');
    const after = wakeOf(readHandleOf(run.memory), wakeId);
    assert.equal(after?.state, 'handled');
    assert.equal(after?.outcome, 'skip');
  } finally {
    await run.close();
  }
});

test('no transaction is open on the writer while the turn asks the model', async () => {
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    const during: Array<{ open: unknown; state: unknown }> = [];
    run.turns.answer = () => {
      during.push({ open: inTransaction(run.memory), state: wakeOf(readHandleOf(run.memory), wakeId)?.state });
      return skipped();
    };
    await run.life.tick();
    assert.deepEqual(during, [{ open: false, state: 'running' }], 'the claim is committed and the writer is idle');
  } finally {
    await run.close();
  }
});

test('a wake cut off by a restart is interrupted without another model call', async () => {
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    const unfinished = structuredClone(run.service.list({ all: true }));
    let started: () => void = () => {};
    const asked = new Promise<void>((resolve) => (started = resolve));
    // The first process dies inside the model call: its turn never answers.
    run.turns.answer = () => {
      started();
      return new Promise<unknown>(() => {});
    };
    void run.life.tick();
    await asked;
    await run.restart();
    run.clock.t = T + 10 * MINUTE;
    run.turns.answer = skipped;
    await run.life.tick();
    const calls = run.turns.calls;
    const ids = calls.map((call) => call.journalTurn.turnId);
    // Restart retains evidence but never authorizes replay of an unfinished action.
    assert.equal(ids.length, 1, 'the cut-off wake never asks the model again');
    const kept = wakeOf(readHandleOf(run.memory), wakeId);
    assert.equal(kept?.state, 'handled');
    assert.equal(kept?.outcome, 'interrupted');
    assert.equal(kept?.turnId, ids[0], 'the original turn identity remains evidence');
    assert.deepEqual(run.service.list({ all: true }), unfinished, 'restart retains unfinished work exactly');
  } finally {
    await run.close();
  }
});

test('the turn mark of a running wake records the interface of its chat', async () => {
  // Catches: a restart cannot tell on which interface a DM turn ran, so it looks in the wrong DM place.
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    let marked: unknown = null;
    run.turns.answer = () => {
      marked = wakeOf(readHandleOf(run.memory), wakeId)?.turn?.iface;
      return skipped();
    };
    await run.life.tick();
    assert.equal(marked, 'fake');
  } finally {
    await run.close();
  }
});

test('the recovery of a cut-off turn asks the journal for the operations under the interface of that turn', async () => {
  // Catches: the interface is recorded in the mark and never handed to the journal lookup of the restart.
  const asked: Array<unknown> = [];
  const journal: InnerJournal = {
    turnOperations: (query) => {
      asked.push(query);
      return [];
    },
  };
  const dir = tempDir('nep-inner-wakes-');
  const run = await core(dir, journal);
  try {
    dueIntention(run, T - MINUTE);
    let started: () => void = () => {};
    const inTurn = new Promise<void>((resolve) => (started = resolve));
    run.turns.answer = () => {
      started();
      return new Promise<unknown>(() => {});
    };
    void run.life.tick();
    await inTurn;
    await run.restart();
    run.clock.t = T + 10 * MINUTE;
    await run.life.tick();
    assert.equal(asked.length, 1);
    assert.equal(Reflect.get(asked[0] as object, 'iface'), 'fake');
  } finally {
    await run.close();
  }
});

test('restart abandons an already queued wake while a wake due during downtime sleeps', async () => {
  const run = await core();
  try {
    const before = dueIntention(run, T - MINUTE);
    const during = dueIntention(run, T + 30 * MINUTE);
    // The attention is held at the last tick before the downtime: the earlier wake waits in the queue.
    run.turns.busy = true;
    await run.life.tick();
    run.turns.busy = false;
    await run.restart();
    run.clock.t = T + 2 * HOUR;
    await run.life.tick();
    run.clock.t += MINUTE;
    await run.life.tick();
    // Queued actions need a fresh model decision after restart, just like interrupted running actions.
    assert.deepEqual(run.turns.calls, []);
    const abandoned = wakeOf(readHandleOf(run.memory), before.wakeId);
    assert.equal(abandoned?.state, 'handled');
    assert.equal(abandoned?.outcome, 'interrupted');
    const slept = wakeOf(readHandleOf(run.memory), during.wakeId);
    assert.equal(slept?.state, 'slept');
    assert.equal(slept?.handledAt, T + 2 * HOUR);
    assert.equal(run.life.status().slept, 1, 'the status counts the slept wake since the start');
  } finally {
    await run.close();
  }
});

test('a wake that fell due during a pause sleeps at the resume and never runs', async () => {
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T + 20 * MINUTE);
    await run.life.tick();
    run.flags.paused = true;
    run.flags.pausedAt = new Date(T + MINUTE).toISOString();
    run.clock.t = T + 10 * MINUTE;
    await run.life.tick();
    run.clock.t = T + 40 * MINUTE;
    delete run.flags.paused;
    delete run.flags.pausedAt;
    await run.life.tick();
    run.clock.t += MINUTE;
    await run.life.tick();
    const calls = run.turns.calls;
    assert.equal(calls.length, 0);
    assert.equal(wakeOf(readHandleOf(run.memory), wakeId)?.state, 'slept');
    assert.equal(run.life.status().slept, 1);
  } finally {
    await run.close();
  }
});

test('a recurring intention whose occurrence fell due during the downtime loses that occurrence, and the next one runs', async () => {
  const run = await core();
  try {
    const first = T + 30 * MINUTE;
    const made = run.service.set({
      purpose: 'say good morning',
      dueAt: first,
      every: { period: 'day', at: null },
      placeId: 'c1',
      scope: 'group',
    });
    if (!made.ok) throw new Error(`intention not set: ${made.code}`);
    const { id } = made.intention;
    await run.life.tick();
    await run.restart();
    run.clock.t = T + 2 * HOUR;
    await run.life.tick();
    const calls = run.turns.calls;
    assert.equal(calls.length, 0, 'the occurrence of the downtime never runs');
    assert.equal(wakeOf(readHandleOf(run.memory), `inner.wake:intention_due:${id}:${first}`)?.state, 'slept');
    const record = run.service.store()?.get(id);
    assert.equal(record?.status, 'pending', 'the intention goes on');
    assert.equal(record?.dueAt, first + DAY);
    assert.equal(record?.history.at(-1)?.code, 'slept');
    run.clock.t = T + DAY;
    await run.life.tick();
    run.clock.t = first + DAY + MINUTE;
    await run.life.tick();
    const calls2 = run.turns.calls;
    assert.deepEqual(
      calls2.map(({ inner: { wake } }) => wake.items.flatMap((item) => item.intentionIds)),
      [[id]],
      'the next occurrence runs as usual'
    );
  } finally {
    await run.close();
  }
});

useIface('fake');

test.beforeEach(() => void (innerClock.t = NOW));

test('inner: restart interrupts queued actions, retains their evidence and preserves the stop', async () => {
  const dataDir = tempDir('nep-inner-restart-');
  const records = [intention('i1', { dueAt: NOW - HOUR_MS }), intention('i2', { dueAt: NOW - 30 * MINUTE_MS })];
  const first = setup({ records, dataDir });
  first.turns.busy = true;
  await first.inner.tick();
  assert.equal(first.inner.status().queue.length, 2);
  innerClock.t = NOW + 3 * HOUR_MS;
  const second = setup({ records, dataDir });
  assert.equal(second.inner.status().queue.length, 2);
  await second.inner.tick();
  // Restart retains queued actions as evidence and requires a fresh decision before running them.
  const calls = second.turns.calls;
  assert.equal(calls.length, 0);
  assert.deepEqual(
    Object.entries(second.inner.state().handled).map(([id, mark]) => [id, mark.outcome]),
    records.map((record) => [
      wakeOfDue({ intention: record, reason: 'due', at: present(record.dueAt) }).id,
      'interrupted',
    ])
  );
  const third = setup({ records, dataDir });
  await third.inner.tick();
  const calls2 = third.turns.calls;
  assert.equal(calls2.length, 0);
  third.inner.stop({ by: 'owner' });
  const fourth = setup({ records, dataDir });
  assert.equal(fourth.inner.status().stopped, true);
  assert.deepEqual(await fourth.inner.tick(), { ran: false, reason: 'stopped' });
});

test('inner: one drain persists its stale wake, held chain and facts in the database', async () => {
  const dataDir = tempDir('nep-inner-drain-');
  const records = [
    intention('i1', { dueAt: NOW - 3 * MINUTE_MS }),
    intention('i2', { dueAt: NOW - 2 * MINUTE_MS, chainId: 'k' }),
  ];
  const hot = innerHotWith({ wakes: { caps: { perChain: 1 } } });
  // With a database supplied, queue dispositions and inner facts persist through the database writer.
  const db = wakeMemory(dataDir, () => innerClock.t);
  const run = setup({ records, dataDir, hot, memoryDb: db.memoryDb });
  run.turns.busy = true;
  await run.inner.tick();
  run.inner.state().turns.push(wrongly({ at: NOW - MINUTE_MS, chainId: 'chain:k', outcome: 'spoke' }));
  records[0].status = 'done';
  run.turns.busy = false;
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 0);
  await run.inner.release();
  const handle = db.memoryDb.readHandle();
  assert.ok(handle);
  // Inner facts and clocks belong to the persona across all root contexts.
  const saved = unitValue(handle.db, personaKey('inner'));
  assert.ok(saved.found);
  const facts: unknown = Reflect.get(Object(saved.value), 'facts');
  assert.ok(Array.isArray(facts));
  assert.deepEqual(
    db
      .queue()
      .filter((wake) => wake.kind !== 'feedback')
      .map((wake) => `${wake.intentionIds[0]}:${wake.capped}`),
    ['i2:per-chain']
  );
  assert.deepEqual(
    db
      .queue()
      .filter((wake) => wake.kind === 'feedback')
      .map((wake) => present(wake.factIds).length),
    [1],
    'the hold, told by a feedback wake'
  );
  assert.deepEqual(
    facts.map(
      (fact: unknown) => `${String(Reflect.get(Object(fact), 'kind'))}:${String(Reflect.get(Object(fact), 'code'))}`
    ),
    ['wakeDropped:stale', 'wakeHeld:per-chain']
  );
  assert.deepEqual(
    db.wakes('handled').map((wake) => present(wake).outcome),
    ['stale']
  );
});

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

test('inner: the lease of a running wake is renewed by the ticks that come while its turn runs', async () => {
  // Bug caught: a turn longer than context.turnLeaseMs loses its wakes' lease, and its end is refused as fenced out.
  innerClock.t = NOW;
  const dataDir = tempDir('nep-inner-renew-');
  const db = wakeMemory(dataDir, () => innerClock.t);
  const { turns, release } = heldTurns('intention_due');
  const run = setup({ records: [intention('i1')], turns, dataDir, memoryDb: db.memoryDb });
  const first = run.inner.tick();
  await until(() => turns.calls.length === 1);
  const before = present(db.wakes('running')[0]).leaseExpiresAt ?? 0;
  innerClock.t = NOW + 4 * MINUTE_MS;
  assert.deepEqual(await run.inner.tick(), { ran: false, reason: 'ticking' });
  await until(() => (present(db.wakes('running')[0]).leaseExpiresAt ?? 0) > before);
  assert.ok((present(db.wakes('running')[0]).leaseExpiresAt ?? 0) > before, 'the lease was renewed');
  release();
  await first;
});
