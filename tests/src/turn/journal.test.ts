import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createAdmin } from '../../../src/admin.ts';
import { createInnerLife } from '../../../src/behavior/inner.ts';
import { personaJournal } from '../../../src/behavior/inner/persona-sources.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import {
  createTurnRunner,
  journalResultOf,
  journalTurnRecord,
  sendHash,
  settleUnknownSends,
} from '../../../src/behavior/turn.ts';
import { createErrandService } from '../../../src/errands/service.ts';
import { createErrandStores } from '../../../src/errands/store.ts';
import { createErrandTurns } from '../../../src/errands/turns.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { JournalLinesWrite } from '../../../src/memory/db/journal-lines.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import '../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { labels } from '../../fixtures/labels.ts';
import { present, wrongly } from '../../fixtures/loose-types.ts';
import { journalLineLabel, openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { ownedBy, OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { asRecord } from '../../fixtures/records.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { coreTurn, journalOverMemory } from '../../fixtures/turn-harness.ts';
import { useIface } from '../../fixtures/turn-world.ts';
import {
  directIn,
  mentionIn,
  postedIn,
  type Rig,
  type Running,
  seedDm,
  seedRoom,
  waitFor,
  withFakes,
} from '../../fixtures/two-fakes.ts';

type Unit = { kind: string; subject_type: string; subject_id: string; scope_place_id: string | null };

/** The tables whose rows name their writer and holder (upsert.ts). */
const OWNED_TABLES = [
  'sources',
  'day',
  'decisions',
  'claims',
  'claim_versions',
  'operational',
  'episodes',
  'accounts',
  'people',
];

/** Every collection the writers hold, read from the rows' writer and holder columns: a writer as its kind, its holder as subject. */
const unitsOf = (rig: Rig): Array<Unit> =>
  rig
    .rows(
      `SELECT DISTINCT CASE writer WHEN 'profile' THEN 'user' ELSE writer END AS kind,
         CASE WHEN holder_id = 'persona:local' THEN 'persona' WHEN writer IN ('profile', 'private') THEN 'account'
           ELSE 'place' END AS subject_type,
         holder_id AS subject_id, NULL AS scope_place_id
       FROM (${OWNED_TABLES.map((table) => `SELECT writer, holder_id FROM "${table}"`).join(' UNION ALL ')})
       WHERE writer IS NOT NULL AND writer != 'session' AND holder_id IS NOT NULL`
    )
    .map((row) => row as unknown as Unit);

async function dmTurn(running: Running, chat: string, author: string, id: string): Promise<void> {
  seedDm(running, chat, author);
  await directIn(running, chat, author, id);
  await waitFor(() => postedIn(running, chat).length > 0, `the answer on ${running.iface}`);
}

test('the journal of a DM turn is a collection of its actual DM place', async () => {
  // Bug: a DM's journal day sits under a fabricated root, so the place browser cannot reach it.
  await withFakes({ owners: ['u1'], names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', []);
    await dmTurn(one, 'dm-1', 'u1', 'm1');
    const places = rig.rows("SELECT id FROM places WHERE chat = 'dm'").map((row) => row.id);
    assert.equal(places.length, 1);
    // The engine's own system lines have no chat: they belong to the persona.
    const journal = unitsOf(rig).filter((unit) => unit.kind === 'journal' && unit.subject_type !== 'persona');
    assert.ok(journal.length > 0);
    for (const unit of journal) {
      assert.equal(unit.subject_type, 'place');
      assert.equal(unit.subject_id, places[0]);
    }
  });
});

test('equal native ids on two interfaces keep two places and two sets of public units', async () => {
  // Bug: the collection key holds the native root id, and only the ambient interface keeps the two apart.
  await withFakes({ owners: ['u1'], names: ['one', 'two'] }, async (rig) => {
    const same = [{ id: 'same', name: 'Same id' }];
    const one = await rig.connect('one', same);
    const two = await rig.connect('two', same);
    seedRoom(one, 'room', 'same');
    seedRoom(two, 'room', 'same');
    await mentionIn(one, 'room', 'same', 'm1');
    await waitFor(() => postedIn(one, 'room').length > 0, 'the answer on one');
    await mentionIn(two, 'room', 'same', 'm2');
    await waitFor(() => postedIn(two, 'room').length > 0, 'the answer on two');
    const known = rig.rows('SELECT id FROM places').map((row) => row.id);
    const journals = unitsOf(rig).filter((unit) => unit.kind === 'journal' && unit.subject_type !== 'persona');
    assert.equal(new Set(journals.map((unit) => unit.subject_id)).size, 2);
    for (const unit of journals) assert.ok(known.includes(unit.subject_id), unit.subject_id);
  });
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

/** A model call that never returns: the process dies there. */
const HANG = Symbol('hang');

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

  test('row 15: a send times out and the message is in the chat -- nothing is told; with the message absent it is told as unclear', async () => {
    const timeout = { status: 'unknown', error: { code: 'timeout', retryable: false } };
    const attempt = async (arrives: boolean) => {
      const chat = makeChat();
      const run = boot(chat, { dataDir: tempDir('nep-fault-') });
      chat.script = ['<msg>ένα μήνυμα που ίσως έφτασε</msg>', '<skip/>'];
      chat.failSend(1, timeout);
      const first: Untyped = await run.ask('c1', 'say it');
      assert.equal(first.partial, true, 'a send without an answer is not a plain success');
      assert.deepEqual(run.factKinds(), ['sendFailed']);
      if (arrives) chat.say('c1', SELF, 'ένα μήνυμα που ίσως έφτασε');
      await run.ask('c1', 'did it arrive?');
      return { run, chat };
    };
    const found = await attempt(true);
    // Slice 4: a reply tells facts in `<feedback>`, not `<wake>`.
    const foundRequests = found.chat.requests;
    const foundRequestsText = foundRequests[1].text;
    assert.ok(!foundRequestsText.includes('<feedback>'), "it was found among the persona's lines: no sendFailed");
    assert.deepEqual(
      found.run.state().facts.filter((fact: Record<string, Untyped>) => !fact.told),
      []
    );
    assertNoSilentFailure(found.run);
    const missing = await attempt(false);
    const missingRequests = missing.chat.requests;
    assert.ok(
      // The fact reaches the addressed turn in `<feedback>`.
      feedbackBlockOf(missingRequests[1].text).includes('send unclear timeout'),
      feedbackBlockOf(missingRequests[1].text)
    );
    assertNoSilentFailure(missing.run);
  });
});

// The tests hand it whole skill results (skill name and status included), of which it reads `ref` and `data`.
const summaryOf = (result: unknown) => journalResultOf(wrongly(result));

test('journalResultOf: a read skill records the size of its text, not the text', () => {
  const summary = summaryOf({ skill: 'memory.journal.read', status: 'ok', data: { text: 'λόγος '.repeat(10) } });
  assert.deepEqual(summary, { chars: 60 });
  assert.ok(!JSON.stringify(summary).includes('λόγος'));
});

test('journalResultOf: a list records its item count next to the size', () => {
  const rows = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const summary = summaryOf({ skill: 'lore.list', status: 'ok', data: { rows } });
  assert.deepEqual(summary, { chars: JSON.stringify(rows).length, items: 3 });
});

test('journalResultOf: a posted message keeps its id, with the size when the call also answered', () => {
  assert.deepEqual(summaryOf({ skill: 'message.create', status: 'ok', ref: { messageId: '99', chatId: '5' } }), {
    messageId: '99',
  });
  assert.deepEqual(summaryOf({ skill: 'draw.create', status: 'ok', ref: { messageId: '7' }, data: { text: 'done' } }), {
    messageId: '7',
    chars: 4,
  });
});

test('journalResultOf: no data and no ref is an empty record', () => {
  assert.deepEqual(summaryOf({ skill: 'reaction.add', status: 'ok' }), {});
  assert.deepEqual(summaryOf({ skill: 'reaction.add', status: 'ok', data: { text: '' } }), {});
  assert.deepEqual(journalResultOf(null), {});
});

const OWNER = '42';

const DATA = path.join('fake-root', 'data');

function fakeAppendStore() {
  const lines: Array<Untyped> = [];
  return {
    lines,
    append: async (file: Untyped, line: Untyped) => {
      lines.push({ file, line });
    },
    async *iterate(file: Untyped) {
      for (const entry of lines) if (entry.file === file) yield { offset: 0, line: entry.line };
    },
  };
}

/** The test databases opened here; closed when the file is done. */
const OPENED: Array<Untyped> = [];

after(async () => {
  for (const mem of OPENED) await mem.close();
});

/** A test memory database whose unit writes also record each line in `lines` as `{ file, line }`. */
function recordingMemory(lines: Record<string, Untyped>) {
  const mem = openTestMemorySync();
  OPENED.push(mem);
  return {
    ...mem.memoryDb,
    writeJournalLines: (write: JournalLinesWrite) => {
      for (const line of write.lines)
        lines.push({ file: journalLineLabel(DATA, write.placeId, line), line: JSON.stringify(line) });
      return mem.memoryDb.writeJournalLines(write);
    },
  };
}

type Clock = { ms: number };

function journalAt(clock: Clock) {
  let n = 0;
  const appendStore = fakeAppendStore();
  const journal = createJournal({
    appendStore,
    memoryDb: recordingMemory(appendStore.lines),
    dataDir: DATA,
    config: () => ({ thinkChars: 4000 }),
    now: () => clock.ms,
    uuid: () => `u-${(n += 1)}`,
  });
  return { journal, appendStore };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);

describe('journal turns', () => {
  test('journalTurnRecord: format counts and steps are written only when the turn noted them', async () => {
    const draft = {
      started: { turnId: 't-1', attemptId: 1, startedAt: 'x' },
      placeId: 'c1',
      privateAccountId: null,
      participants: [],
      think: null,
    };
    const plain = journalTurnRecord(wrongly(draft), { outcome: 'delivered', mode: 'reply' });
    assert.equal('format' in plain, false);
    assert.equal('steps' in plain, false);

    const noted = journalTurnRecord(wrongly({ ...draft, format: { thinkMissing: 1, coerced: 2, held: 1 }, steps: 3 }), {
      outcome: 'delivered',
      mode: 'reply',
    });
    // Stage U adds the standard's counts.
    assert.deepEqual(noted.format, {
      thinkMissing: 1,
      coerced: 2,
      malformed: 0,
      truncated: 0,
      thinkLeaked: 0,
      leakEnded: 0,
      tagInOutgoing: 0,
      thinkOffScript: 0,
      capped: 0,
      held: 1,
    });
    assert.equal(noted.steps, 3);

    // The record survives the journal's line round trip.
    const clock = { ms: Date.UTC(2026, 9, 13, 12) };
    const { journal, appendStore } = journalAt(clock);
    await journal.turn('g1', { ...noted, think: null });
    await tick();
    const firstLine = appendStore.lines[0];
    const written = JSON.parse(firstLine.line);
    assert.deepEqual(written.format, noted.format);
    assert.equal(written.steps, 3);
  });
});

const MARKER = 'BARE-TEXT-NOT-SENT';

/** The test's own wording of the diagnostic: its marker, then the count of characters. */
const WORDED = `${MARKER} {chars}`;

const replyLabels = {
  ...labels,
  tools: { ...labels.tools, diagnostics: { ...labels.tools.diagnostics, bareText: WORDED } },
};

/** The persona's working words, outside every tag, each word one no message of these tests holds. */
const BARE = 'ετοιμάζω πρώτα εικόνα έπειτα γράφω';

const THINK = '<think>σχέδιο</think>';

const SAY = '<think>τώρα σωστά</think><msg>ναι εντάξει</msg>';

// ---------- the turn's record ----------

/** The `turn` record the journal wrote for the run: its `bare`, or null when the record has no such field. */
function bareOfRecord(lines: ReadonlyArray<{ record: unknown }>): unknown {
  const records = lines.map(({ record }) => asRecord(record));
  const turn = records.find((record) => record.kind === 'turn');
  assert.ok(turn, 'the journal wrote a turn record');
  return 'bare' in turn ? turn.bare : null;
}

// ---------- a <thinking> block is the persona's think ----------

// The second spelling of the persona's thinking: a whole `<thinking>` block is read as
// `<think>`, so it is no bare text, it is the turn's think, and their earlier answer stands in the next request with the
// block as `<think>`. Their last answer holds no think of its own, so the think the record keeps can only be the block's.
const THINKING_TEXT = 'κοιτάζω πρώτα τον κατάλογο';

const THINKING = `<thinking>${THINKING_TEXT}</thinking>`;

const SAY_NO_THINK = '<msg>ναι εντάξει</msg>';

/** The `turn` record the journal wrote for the run. */
function turnRecordOf(lines: ReadonlyArray<{ record: unknown }>): Record<string, unknown> {
  const records = lines.map(({ record }) => asRecord(record));
  const turn = records.find((record) => record.kind === 'turn');
  assert.ok(turn, 'the journal wrote a turn record');
  return turn;
}

describe('a reply of bare text', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('the turn record keeps the bare text of a turn that had some, in bare', async () => {
    // Bug: the persona's words that were never posted leave no trace, so nobody can tell afterwards what the persona wrote outside the tags.
    const { journal, lines } = journalOverMemory();
    await coreTurn({ answers: [`${THINK}${BARE}`, SAY], journal, prompts: { labels: replyLabels } });
    assert.equal(bareOfRecord(lines), BARE);
  });

  test('the turn record of a turn with no bare text has no bare field', async () => {
    // Bug: every record carries an empty `bare`, and the journal grows a field that says nothing.
    const { journal, lines } = journalOverMemory();
    await coreTurn({ answers: [SAY], journal, prompts: { labels: replyLabels } });
    assert.equal(bareOfRecord(lines), null);
  });

  test('the turn record keeps the text of a first <thinking> block as the turn think', async () => {
    // Catches: the think of a first answer in the second spelling is dropped, so the turn keeps an empty think.
    const { journal, lines } = journalOverMemory();
    await coreTurn({
      answers: [toolAnswer(THINKING, [call('lore.list')]), SAY_NO_THINK],
      journal,
      prompts: { labels: replyLabels },
    });
    assert.equal(turnRecordOf(lines).think, THINKING_TEXT);
  });
});

const NOW = Date.parse('2026-10-19T12:00:00Z');

const MINUTE = 60_000;

const turnFailedEarlierClock = { t: NOW };

describe('a turn after an earlier failure', () => {
  test.beforeEach(() => {
    turnFailedEarlierClock.t = NOW;
  });

  test("sendHash and settleUnknownSends: the hash covers the start of the text with whitespace folded; only a later line of the persona's with that hash settles the fact", () => {
    assert.equal(sendHash('a  b\n c'), sendHash(' a b c '));
    assert.notEqual(sendHash('a b c'), sendHash('a b d'));
    assert.equal(
      sendHash(`${'x'.repeat(80)}tail`),
      sendHash(`${'x'.repeat(80)}other`),
      'a trailing link or a cut changes nothing'
    );
    const fact = { id: 'f1', kind: 'sendFailed', unknown: true, hash: sendHash('ένα'), at: NOW };
    const known = { id: 'f2', kind: 'sendFailed', code: 'http-403', at: NOW };
    const line = (over: Record<string, unknown> = {}) => ({ self: true, content: 'ένα', ts: NOW + 1000, ...over });
    assert.deepEqual(settleUnknownSends([fact, known], [line()]), { kept: [known], dropped: [fact] });
    assert.deepEqual(settleUnknownSends([fact], [line({ self: false })]).kept, [fact], "not the persona's");
    assert.deepEqual(settleUnknownSends([fact], [line({ content: 'δύο' })]).kept, [fact], 'another text');
    assert.deepEqual(settleUnknownSends([fact], [line({ ts: NOW - 5 * MINUTE })]).kept, [fact], 'older than the send');
    assert.deepEqual(
      settleUnknownSends([known], []),
      { kept: [known], dropped: [] },
      'a send that failed for sure is never looked for'
    );
  });
});
