import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { createAdmin } from '../../../../src/admin.ts';
import { createInnerLife } from '../../../../src/behavior/inner.ts';
import { personaJournal } from '../../../../src/behavior/inner/persona-sources.ts';
import { userText } from '../../../../src/behavior/prompt.ts';
import { createTurnRunner as createRealTurnRunner, createTurnRunner } from '../../../../src/behavior/turn.ts';
import { createErrandService } from '../../../../src/errands/service.ts';
import { createErrandStores } from '../../../../src/errands/store.ts';
import { createErrandTurns } from '../../../../src/errands/turns.ts';
import { createEventDoor } from '../../../../src/interface/door.ts';
import { createReads } from '../../../../src/interface/reads.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';
import { DAY_MS, MINUTE_MS } from '../../../../src/time.ts';
import '../../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { chainsOf, chainsOnDefaults } from '../../../fixtures/chains.ts';
import { labels } from '../../../fixtures/labels.ts';
import { present, wrongly } from '../../../fixtures/loose-types.ts';
import { openTestMemorySync } from '../../../fixtures/memory-db/service.ts';
import { ownedBy, OWNER_PERSON } from '../../../fixtures/owner-accounts.ts';
import { CLI_PLACE, type ServiceRun, serviceTurn, serviceWake, TURN_NOW } from '../../../fixtures/service-turn.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { call, completionOf, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { onWorld, useIface, world } from '../../../fixtures/turn-world.ts';

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
      const chatCalls = chat.llm.calls;
      chatCalls.push(messages);
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
  const chatMessages = chat.port.messages;
  for (const message of chatMessages.values()) {
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

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

describe('injected faults', () => {
  test.beforeEach(() => {
    clock.t = NOW0;
  });

  // B7: `<gif>` left the persona's output, so the row runs where a GIF after a text remains: their message.create with `gif`. In the
  // media pick a failed post leaves the text as written (tests/src/turn/draw-gif.test.ts).
  test('row 10: the text goes out and the GIF fails -- the call is partial, the text is said, and the cause is in the next request of the persona', async () => {
    const gifs = { g1: { key: 'k1', id: 'g1', kind: 'link', url: 'https://tenor.example/cat' } };
    const chat2 = makeChat();
    const records = [intentionRecord('i1')];
    const inner = boot(chat2, {
      dataDir: tempDir('nep-fault-'),
      records,
      gifs,
      hot: hotWith({ grants: ['message.create'] }),
    });
    chat2.script = [toolAnswer('', [call('message.create', { text: 'γεια', gif: 'g1' })]), providerLimit()];
    chat2.failSend(2);
    await inner.tick();
    assert.deepEqual(chat2.textsFromSelf('c1'), ['γεια']);
    assert.deepEqual(
      inner
        .state()
        .facts.filter((fact: Record<string, Untyped>) => fact.kind === 'callFailed')
        .map((fact: Record<string, Untyped>) => fact.skill),
      ['message.create']
    );
    await inner.tick();
    assert.ok(
      requestText(chat2, 2).includes('call message.create'),
      'the cause reaches the next turn of the persona there'
    );
    assertNoSilentFailure(inner);
  });
});

const THINK = '<think>STEP 4. So: do it.</think>';

const HOUR = 3_600_000;

/** A purpose past the 200 characters a line of `<intentions>` keeps, with a marker at its end. */
const DUE_PURPOSE = `${'να γράψω στον κήπο για τα λουλούδια της άνοιξης '.repeat(6)}ΤΕΛΟΣ-ΣΚΟΠΟΥ`;

type Made = { ok: boolean; intention?: { id: string } };

/** Seeds three open intentions, the due one made second, and gives its id through `due`. */
function seeded(due: { id: string }, place: string | null) {
  return (service: ServiceRun['intentions']): void => {
    service.set({ purpose: 'ΑΛΛΗ-ΠΡΩΤΗ', dueAt: TURN_NOW + 5 * HOUR, by: 'persona' });
    const made = service.set({
      purpose: DUE_PURPOSE,
      dueAt: TURN_NOW - 60_000,
      destination: place,
      by: 'persona',
    }) as Made;
    due.id = made.intention?.id ?? '';
    service.set({ purpose: 'ΑΛΛΗ-ΤΡΙΤΗ', dueAt: TURN_NOW + 6 * HOUR, by: 'persona' });
  };
}

const dueWake = (id: string): Record<string, unknown> =>
  serviceWake('intention_due', {
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: [id], errandId: null }],
    intentions: [{ id, purpose: DUE_PURPOSE, dueAt: TURN_NOW - 60_000 }],
    chainId: id,
  });

describe('an intention in an inner turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a message.create naming the command line from an intention nowhere posts in the owner chat', async () => {
    // Bug: the tree check refuses a destination on another interface, or a direct chat is refused outright.
    const due = { id: '' };
    const run = await serviceTurn({
      wake: () => dueWake(due.id),
      answers: [toolAnswer(THINK, [call('message.create', { place: CLI_PLACE, text: 'καλημέρα από εδώ' })]), '<skip/>'],
      chat: null,
      seed: seeded(due, null),
    });
    const { cli } = run;
    const sent = cli.calls.filter((one: { op: string }) => one.op === 'send');
    assert.equal(sent.length, 1, run.actions.join(' '));
    const [, content] = sent[0]?.args ?? [];
    assert.equal((content as { text?: string } | undefined)?.text, 'καλημέρα από εδώ');
  });
});

const innerTurnCreateTurnRunner = onWorld(wrongly(createRealTurnRunner));

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

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<Untyped> = [];

after(async () => {
  for (const mem of OPENED_MEMORY) await mem.close();
});

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
 * clock (NOW when none); `slowMs` delays every operation of the persona's by that many real milliseconds.
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
  if (loop) hot.config.wakes.loop = { ...loop };
  if (skillsLoop) hot.config.tools.loop = { ...hot.config.tools.loop, ...skillsLoop };
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

describe('an inner turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('inner turn, live: message.create with gif= posts the text then the GIF', async () => {
    const gifs = { g1: { key: 'k1', id: 'g1', kind: 'link', url: 'https://tenor.example/cat' } };
    const run = await innerTurn({
      answers: [toolAnswer('', [call('message.create', { gif: 'g1', text: 'νιάου' })]), '<skip/>'],
      shadow: false,
      gifs,
    });
    assert.deepEqual(
      run.sends.map((send) => send.text),
      ['νιάου', 'https://tenor.example/cat']
    );
    const runInner = run.result.inner;
    assert.deepEqual(
      runInner.actions.map((a) => `${a.skill}:${a.status}`),
      ['message.create:executed']
    );
  });
});
