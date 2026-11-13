// One inner turn of the turn frame's template over the real turn runner (plan 2026-11-06-turn-frame, slice 5): the real
// operations, a real intention service, a real journal and a memory database the graph reader and `<meanwhile>` read,
// a fake model and the fake interface `fake` holding the room `c1`. A service turn runs with `chat: null`, as
// the slice has `runTurn` take it; an intention with a place runs with that place's chat. The world of the
// memory database, with made-up names in Greek and accented Latin:
//   interface `fake`, root `g1` "Αγορά", rooms `c1` "γενικά" and `c2` "κήπος"
//   interface `tele`, root `t1` "Νησί", room `k1` "λιμάνι"
//   Ελένη (`fake:111`), who wrote in `c2` right before her line there, with a fact stored in her direct chat
//   Ζωή (`fake:5678`), with a direct chat `fake:dm:5678` holding a line of hers
// Her own lines: one in `c2`, one in `k1` and one in the direct chat with Ζωή. No network, no provider.
import { createTurnRunner as createRealTurnRunner } from '../../src/behavior/turn.ts';
import { userText } from '../../src/behavior/prompt.ts';
import { createAdmin } from '../../src/admin.ts';
import { createFakeAdapter } from '../../src/interface/fake.ts';
import { createIntentionService } from '../../src/intentions/service.ts';
import { createIntentionStores } from '../../src/intentions/store.ts';
import { createJournal } from '../../src/memory/journal.ts';
import { issueContext } from '../../src/memory/db/scope.ts';
import { placeRefOf } from '../../src/memory/db/frame-reads.ts';
import { placeChainInDb } from '../../src/memory/db/place-tree.ts';
import '../../src/tools/operations/index.ts';
import { skillRegistry } from '../../src/tools/registry.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { withCapturedLogs } from './capture-logs.ts';
import { wrongly } from './loose-types.ts';
import { addClaim, addDm, addLine, addPerson, addRoom, noteInterface, openWorld, rootId } from './memory-db/mind-world.ts';
import type { World } from './memory-db/mind-world.ts';
import { openTestMemorySync } from './memory-db/service.ts';
import { shippedLabels } from './shipped-labels.ts';
import { tempDir } from './tmp.ts';
import { completionOf } from './tool-answers.ts';
import { onWorld, world } from './turn-world.ts';
import type { Fake } from './turn-world.ts';
import { OWNER_PERSON, ownedBy } from './owner-accounts.ts';
import { chainsOnDefaults } from './chains.ts';
import { objectMediaCache } from '../../src/memory/store-media.ts';

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

export const TURN_NOW = Date.parse('2026-11-02T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (at: number): string => new Date(at).toISOString();
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** Marker texts of the prompt files, so a test reads which file framed the request without reading any wording. */
export const MARK = {
  heartbeat: 'MARK-HEARTBEAT-TASK',
  selfimprovement: 'MARK-SELFIMPROVEMENT-TASK',
  inner: 'MARK-INTENTION-TASK',
} as const;

/** The texts the world's lines and facts carry, each unique so a test finds it in one block. */
export const TEXT = {
  ownGarden: 'ΔΙΚΗ-ΤΗΣ-ΚΗΠΟΣ',
  ownHarbour: 'ΔΙΚΗ-ΤΗΣ-ΛΙΜΑΝΙ',
  ownPrivate: 'ΔΙΚΗ-ΤΗΣ-ΙΔΙΩΤΙΚΗ',
  eleniGarden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
  eleniSecret: 'ΜΥΣΤΙΚΟ-ΤΗΣ-ΕΛΕΝΗΣ',
  roomLine: 'ΓΡΑΜΜΗ-ΤΟΥ-ΓΕΝΙΚΑ',
} as const;

export const ELENI = 'person:fake:111';
export const ZOE = 'person:fake:5678';
export const CLI_PLACE = 'cli:dm:owner';

/** The settings a service turn reads, every one set: `context.memory.serviceMessages` is the slice's new one. */
export const SERVICE_CONTEXT = {
  channelMessages: 100,
  caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
  vision: { fetchTimeoutMs: 10_000 },
  pull: { sameAudience: true },
  meanwhile: { messages: 8, around: 2 },
  recall: { extractChars: 1200, maxItems: 6 },
  memory: { serviceMessages: 100, windowMessages: 100, maxHops: 2, budgetTokens: 10_000 },
};

const GRANTED = [
  'conversation.read',
  'lore.list',
  'memory.search',
  'message.create',
  'intention.set',
  'intention.update',
  'intention.cancel',
  'task.propose',
  'task.status',
];

/** The memory database of the world above. */
export function serviceWorld(): World {
  const w = openWorld();
  noteInterface(w, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  noteInterface(w, 'tele', [{ id: 't1', name: 'Νησί' }]);
  const room = addRoom(w.db, { iface: 'fake', native: 'c1', root: rootId('fake', 'g1'), name: 'γενικά' });
  const garden = addRoom(w.db, { iface: 'fake', native: 'c2', root: rootId('fake', 'g1'), name: 'κήπος' });
  const harbour = addRoom(w.db, { iface: 'tele', native: 'k1', root: rootId('tele', 't1'), name: 'λιμάνι' });
  addPerson(w.db, { id: ELENI, accounts: [{ id: 'fake:111', iface: 'fake', native: '111', names: ['Ελένη'] }] });
  addPerson(w.db, { id: ZOE, accounts: [{ id: 'fake:5678', iface: 'fake', native: '5678', names: ['Ζωή'] }] });
  const eleniDm = addDm(w.db, { iface: 'fake', native: '111', person: ELENI, account: 'fake:111' });
  const zoeDm = addDm(w.db, { iface: 'fake', native: '5678', person: ZOE, account: 'fake:5678' });
  addLine(w.db, { id: 'r1', iface: 'fake', place: room, author: 'fake:111', text: TEXT.roomLine, at: iso(TURN_NOW - 5 * MIN) });
  addLine(w.db, {
    id: 'g0',
    iface: 'fake',
    place: garden,
    author: 'fake:111',
    text: TEXT.eleniGarden,
    at: iso(TURN_NOW - 51 * MIN),
  });
  addLine(w.db, { id: 'g1', iface: 'fake', place: garden, author: 'self', text: TEXT.ownGarden, at: iso(TURN_NOW - 50 * MIN) });
  addLine(w.db, {
    id: 'h1',
    iface: 'tele',
    place: harbour,
    author: 'self',
    text: TEXT.ownHarbour,
    at: iso(TURN_NOW - 40 * MIN),
  });
  addLine(w.db, {
    id: 'd1',
    iface: 'fake',
    place: zoeDm,
    author: 'self',
    text: TEXT.ownPrivate,
    at: iso(TURN_NOW - 30 * MIN),
    audience: { dm: zoeDm, iface: 'fake', person: ZOE },
  });
  addClaim(w.db, {
    id: 'claim:fact:111',
    person: ELENI,
    kind: 'fact',
    text: TEXT.eleniSecret,
    audience: { dm: eleniDm, iface: 'fake', person: ELENI },
  });
  return w;
}

export type ServiceRun = {
  result: Record<string, Untyped>;
  /** The user text of each request the model got. */
  requests: Array<string>;
  /** `skill:status:code` of each call of the turn. */
  actions: Array<string>;
  port: Fake;
  /** The command line's adapter, `cli`, holding the owner's chat. */
  cli: Fake;
  journal: ReturnType<typeof createJournal>;
  intentions: ReturnType<typeof createIntentionService>;
};

export type ServiceTurnSpec = {
  /** The wake as the drain hands it to the turn: `kind`, `items`, `intentions`, `chainId`, and a kind's facts. */
  wake: Record<string, unknown> | ((service: ReturnType<typeof createIntentionService>) => Record<string, unknown>);
  answers: ReadonlyArray<unknown>;
  /** The chat the turn runs in: null for a service and an intention without a place. */
  chat: { iface: string; chatId: string } | null;
  /** What exists before the turn: intentions made through the service. */
  seed?: ((service: ReturnType<typeof createIntentionService>) => void) | null;
  world?: World;
  /** Laid over `context.memory` of SERVICE_CONTEXT. */
  settings?: { serviceMessages?: number; budgetTokens?: number };
  /** Laid over SERVICE_CONTEXT, such as `myDay`. */
  context?: Record<string, unknown>;
  /** More interfaces the turn reaches, each answering the calls that name its `iface`. */
  adapters?: ReadonlyArray<Fake>;
  /** The labels of the turn instead of the shipped ones, for a test that words one of them itself. */
  labels?: object;
  /** The place the drain names as the turn's current channel, as it does for an intention with a destination: null for none. */
  currentChannel?: string | null;
};

/** The adapter that answers a call naming one of `others`' interfaces by that one, and every other call by `main`. */
function routed(main: Fake, others: ReadonlyArray<Fake>): Fake {
  return new Proxy(main, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args: Array<unknown>): unknown => {
        const first = args[0];
        const named: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'iface') : undefined;
        const to = others.find((other) => other.iface === named) ?? target;
        const method: unknown = Reflect.get(to, key);
        return typeof method === 'function' ? Reflect.apply(method, to, args) : undefined;
      };
    },
  });
}

/**
 * The command line's adapter with the owner's chat, where she may write. The chat's id is its place id, `cli:dm:owner`,
 * as the real client names it (interfaces/cli/link.ts); the fixture named it `owner`, which only the partner lookup reached.
 */
function cliAdapter(): Fake {
  const cli = createFakeAdapter({ iface: 'cli', selfId: 'self-id', now: () => TURN_NOW });
  cli.seedChat({
    iface: 'cli',
    id: CLI_PLACE,
    kind: 'dm',
    name: null,
    rootId: null,
    topic: null,
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: false,
  });
  cli.seedDmChat('owner', CLI_PLACE);
  return cli;
}

type RigSpec = Pick<ServiceTurnSpec, 'seed' | 'adapters' | 'labels'> & {
  mind: World;
  settings?: Record<string, number>;
  /** Laid over SERVICE_CONTEXT, such as `channelMessages`. */
  context?: Record<string, unknown>;
  /** Laid over the rig's `llm` settings, such as `maxRequestTokens`. */
  llm?: { maxRequestTokens?: number };
  /** The answer to the model's `n`th request, counted from 1 over the runner's life. */
  answer: (n: number) => unknown;
  /** Laid over the fixture's store: a reply turn needs the place of its chat as the world stores it. */
  store?: Record<string, unknown>;
};

/** The real turn runner over `mind`, with the room `c1` of the fake interface holding Ελένη's line `r1`. */
function rigOf(spec: RigSpec) {
  const { mind } = spec;
  const hot: Record<string, Untyped> = {
    config: {
      bot: {
        timezone: 'UTC',
        ownerPerson: OWNER_PERSON,
        access: Object.fromEntries(GRANTED.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: { ...SERVICE_CONTEXT, ...spec.context, memory: { ...SERVICE_CONTEXT.memory, ...spec.settings } },
      dm: { enabled: true },
      llm: { maxRequestTokens: 60000, ...spec.llm },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { routes: chainsOnDefaults({ analyzer: 'x/text' }) },
      tools: {
        safeMode: false,
        transport: 'native',
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'live' },
      intentions: { expiresDays: 14, maxOpen: 20 },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      'errand-result': 'An errand ended.',
      inner: MARK.inner,
      heartbeat: MARK.heartbeat,
      selfimprovement: MARK.selfimprovement,
      labels: spec.labels ?? shippedLabels,
    },
  };
  const intentions = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-service-turn-'), now: () => TURN_NOW }),
    hot,
    now: () => TURN_NOW,
    log: { info() {}, warn() {} },
  });
  spec.seed?.(intentions);
  world().channel({
    id: 'c1',
    name: 'γενικά',
    placeId: 'g1',
    historyMessages: [
      {
        id: 'r1',
        placeId: 'c1',
        author: { id: '111', bot: false, globalName: 'Ελένη', username: 'Ελένη' },
        member: { displayName: 'Ελένη' },
        cleanContent: TEXT.roomLine,
        createdTimestamp: TURN_NOW - 5 * MIN,
        reference: null,
        attachments: new Map(),
        stickers: new Map(),
      },
    ],
  });
  world().channel({ id: 'c3', name: 'ανακοινώσεις', placeId: 'g1', permissions: { send: false } });
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_NOW });
  const cli = cliAdapter();
  const port = routed(fake, [cli, ...(spec.adapters ?? [])]);
  const reads = world().adopt(port);
  const store = {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
    // A place id names its chat by the row the world holds, as the memory store answers it: without it a write named by
    // place went to the place id as a chat no interface knows.
    placeRefOf: (id: string) => placeRefOf(mind.db, id),
    ...spec.store,
  };
  const admin = createAdmin({
    hot,
    store,
    client: { user: { id: 'self-id', username: 'Bot' } },
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads,
    intentions,
    now: () => TURN_NOW,
  });
  const memory = openTestMemorySync({ now: () => TURN_NOW });
  let n = 0;
  const journal = createJournal({
    memoryDb: memory.memoryDb,
    dataDir: 'fake-data',
    config: () => ({ thinkChars: 4000 }),
    now: () => TURN_NOW,
    uuid: () => `u${(n += 1)}`,
  });
  const requests: Array<string> = [];
  const llm = {
    complete: (messages: Array<{ content: unknown }>) => {
      requests.push(messages.map((message) => userText(message.content)).join('\n'));
      return Promise.resolve(completionOf(spec.answer(requests.length)));
    },
  };
  let contexts = 0;
  const runner = () =>
    createTurnRunner({
      hot,
      store,
      llm,
      calibrator: { ratio: 1, apply: (value: unknown) => value, observe: () => {} },
      now: () => TURN_NOW,
      port,
      skills: skillRegistry(),
      journal,
      journalDb: () => mind.db,
      memoryContext: (given: Parameters<typeof issueContext>[0]) =>
        issueContext({ iface: 'fake', ...given, now: () => TURN_NOW, newId: () => `ctx:service:${(contexts += 1)}` }),
      runOp: admin.runSkillOp,
      runOwnOp: admin.runOwnSkillOp,
      runInitiativeOp: admin.runInitiativeSkillOp,
      intentions,
    });
  const turns = runner();
  /**
   * A new turn runner over the same journal, memory, interfaces and intentions, seeded from the journal of yesterday and
   * today for `places` as src/core.ts seeds one at start: a restart.
   */
  async function restart(places: ReadonlyArray<string>): Promise<typeof turns> {
    await journal.flush?.();
    const fresh = runner();
    const seeded = fresh as unknown as {
      seedTriggerLinks: (pairs: unknown) => void;
      seedCallMarks: (marks: unknown) => void;
    };
    const days = [utcDay(TURN_NOW - DAY), utcDay(TURN_NOW)];
    for (const placeId of places) {
      seeded.seedTriggerLinks(await journal.triggerLinks(placeId, { days }));
      seeded.seedCallMarks({ ...(await journal.callMarks(placeId, { days })), placeId });
    }
    // The runner seeds its lookups and thinks from the journal on its own (src/behavior/turn.ts#seedCallMarks).
    await new Promise((resolve) => setTimeout(resolve, 50));
    return fresh;
  }
  return { turns, restart, requests, fake, cli, journal, intentions };
}

/** One inner turn of `wake` answered by `answers`, over the world's memory and the room `c1` of the fake interface. */
export async function serviceTurn(spec: ServiceTurnSpec): Promise<ServiceRun> {
  const mind = spec.world ?? serviceWorld();
  const { answers } = spec;
  const { turns, requests, fake, cli, journal, intentions } = rigOf({
    ...spec,
    mind,
    answer: (n) => answers[Math.min(n - 1, answers.length - 1)],
  });
  const wake = typeof spec.wake === 'function' ? spec.wake(intentions) : spec.wake;
  const inner = { wake, currentChannel: spec.currentChannel ?? null, shadow: false, mayAct: () => true };
  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ chat: spec.chat, mode: 'inner', triggerKind: 'inner', inner })
  );
  await new Promise((resolve) => setImmediate(resolve));
  const turn = result as { inner?: { actions?: Array<Record<string, string | null | undefined>> } };
  try {
    return {
      result: result as Record<string, Untyped>,
      requests,
      actions: (turn.inner?.actions ?? []).map(
        (action) => `${action.skill}:${action.status}:${action.code ?? action.result}`
      ),
      port: fake,
      cli,
      journal,
      intentions,
    };
  } finally {
    if (spec.world === undefined) mind.close();
  }
}

/** A line of the reply chat: by Ελένη unless another author is named. */
export type ReplyLine = { id: string; text: string; at: number; authorId?: string; authorName?: string };

/**
 * One reply turn of a run: the lines that join the chat before it, the line she answers there and what the model says to
 * each request of the turn.
 */
export type ReplyStep = {
  /** Runs before the step's lines join the chat, such as a write of lines to the world's memory. */
  before?: () => void;
  /** Runs after `before`, with the run's journal: a write of records to it, such as the stop and start of a service. */
  journalBefore?: (journal: ReturnType<typeof createJournal>) => Promise<void>;
  lines?: ReadonlyArray<ReplyLine>;
  trigger: ReplyLine;
  /** Each a model answer, or a function of the user text of the request it answers that gives one. */
  answers: ReadonlyArray<unknown>;
};

/** The chat a reply turn runs in: its interface, the chat id the interface names it by and its place id in the world. */
export type ReplyChat = { iface: string; chatId: string; place: string };

/** The room `c1` of the fake interface, the default chat of a reply run. */
export const C1_CHAT: ReplyChat = { iface: 'fake', chatId: 'c1', place: 'fake:channel:c1' };

/** The owner's command line chat: the chat id is its place id (interfaces/cli/link.ts). */
export const CLI_CHAT: ReplyChat = { iface: 'cli', chatId: CLI_PLACE, place: CLI_PLACE };

/** A line of `c1` as the platform hands it over. */
const rawLine = ({ id, text, at, authorId = '111', authorName = 'Ελένη' }: ReplyLine): Record<string, unknown> => ({
  id,
  placeId: 'c1',
  author: { id: authorId, bot: false, globalName: authorName, username: authorName },
  member: { displayName: authorName },
  cleanContent: text,
  createdTimestamp: at,
  reference: null,
  attachments: new Map(),
  stickers: new Map(),
});

/** A line of a chat of `cli` (or any adapter of the rig but the world's) as a `message.received` event. */
function eventLine(chat: ReplyChat, { id, text, at, authorId = '111', authorName = 'Ελένη' }: ReplyLine) {
  return {
    kind: 'message.received' as const,
    iface: chat.iface,
    at,
    id: `${chat.iface}:message:${id}`,
    chat: { id: chat.chatId, kind: 'dm' as const, rootId: null, name: null },
    message: {
      id,
      author: { id: authorId, name: authorName, self: false, bot: false },
      content: text,
      sourceText: text,
      system: false,
      at,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
    },
  };
}

/** One message she sent in a reply run: the chat it went to, its text and the accounts it mentions. */
export type ReplySend = { iface: string; chatId: string; text: string; mentioned: Array<string> };

/** One reaction she put on a line in a reply run: the message id it went to and the emoji. */
export type ReplyReaction = { messageId: string; emoji: string };

/** What a reply run leaves: the user texts of every request, one list per turn, every message she sent and every reaction. */
export type ReplyRun = { requests: Array<Array<string>>; sends: Array<ReplySend>; reactions: Array<ReplyReaction> };

/** The person an account of the world belongs to, null for an account no row holds. */
function personOfAccountIn(mind: World, account: string): string | null {
  const row: unknown = mind.db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(account);
  const person: unknown = row && typeof row === 'object' ? Reflect.get(row, 'person_id') : null;
  return typeof person === 'string' ? person : null;
}

/** The sends an adapter recorded, as ReplySend. */
function sendsOf(adapter: Fake): Array<ReplySend> {
  return adapter.calls
    .filter((one) => one.op === 'send')
    .map((one) => {
      const [chat, content] = one.args as [
        { iface?: string; chatId?: string },
        { text?: string; mentions?: { users?: Array<string> } } | undefined,
      ];
      return {
        iface: String(chat.iface ?? adapter.iface),
        chatId: String(chat.chatId ?? ''),
        text: content?.text ?? '',
        mentioned: [...(content?.mentions?.users ?? [])],
      };
    });
}

/** The reactions an adapter recorded, as ReplyReaction. */
function reactionsOf(adapter: Fake): Array<ReplyReaction> {
  return adapter.calls
    .filter((one) => one.op === 'react')
    .map((one) => {
      const [ref, emoji] = one.args as [{ messageId?: string } | undefined, string | undefined];
      return { messageId: String(ref?.messageId ?? ''), emoji: String(emoji ?? '') };
    });
}

/**
 * Reply turns in one chat (`c1` unless `chat` names another), one after another on one turn runner, each answering its
 * `trigger`, which joins the chat's history before its turn. The chat of `c1` is the world's place `fake:channel:c1`.
 */
export async function replyRun(spec: {
  world: World;
  steps: ReadonlyArray<ReplyStep>;
  settings?: Record<string, number>;
  /** Laid over SERVICE_CONTEXT, such as `channelMessages`. */
  context?: Record<string, unknown>;
  /** Laid over the rig's `llm` settings, such as `maxRequestTokens`. */
  llm?: { maxRequestTokens?: number };
  chat?: ReplyChat;
  /** What exists before the first turn: intentions made through the service. */
  seed?: ServiceTurnSpec['seed'];
  /** The step that runs on a new turn runner after a restart (rigOf's `restart`), none when absent. */
  restartBefore?: number;
}): Promise<ReplyRun> {
  const { steps } = spec;
  const chat = spec.chat ?? C1_CHAT;
  let step = 0;
  let firstOfStep = 1;
  // An answer may be a function of the request it answers, so a test writes back what the request showed.
  const answerOf = (n: number): unknown => {
    const answers = steps[step]?.answers ?? ['<skip/>'];
    const value: unknown = answers[Math.min(n - firstOfStep, answers.length - 1)];
    if (typeof value !== 'function') return value;
    const answered: unknown = Reflect.apply(value, undefined, [requests[n - 1] ?? '']);
    return answered;
  };
  const rig = rigOf({
    mind: spec.world,
    answer: answerOf,
    ...(spec.settings === undefined ? {} : { settings: spec.settings }),
    ...(spec.context === undefined ? {} : { context: spec.context }),
    ...(spec.llm === undefined ? {} : { llm: spec.llm }),
    ...(spec.seed === undefined ? {} : { seed: spec.seed }),
    store: {
      placeOfChat: (given: { id?: unknown; iface?: unknown; kind?: unknown; partnerId?: unknown }) => {
        const iface = typeof given.iface === 'string' ? given.iface : chat.iface;
        if (given.kind === 'dm') return `${iface}:dm:${String(given.partnerId)}`;
        return iface === 'cli' ? String(given.id) : `${iface}:channel:${String(given.id)}`;
      },
      // A member's account and person as the memory store answers them from the world's rows.
      accountOf: (native: string, iface?: string) => `${iface ?? chat.iface}:${native}`,
      personOfAccount: (account: string) => personOfAccountIn(spec.world, account),
      // The chain of the turn's place by its stored names, as the memory store answers it.
      placeChainOf: (placeId: string) => placeChainInDb(spec.world.db, placeId),
    },
  });
  const { requests, fake, cli } = rig;
  let turns = rig.turns;
  const out: Array<Array<string>> = [];
  for (const [index, one] of steps.entries()) {
    if (index === spec.restartBefore) turns = await rig.restart([chat.chatId, chat.place, 'g1']);
    step = index;
    firstOfStep = requests.length + 1;
    one.before?.();
    await one.journalBefore?.(rig.journal);
    const { id, text, at, authorId = '111', authorName = 'Ελένη' } = one.trigger;
    const lines = [...(one.lines ?? []), one.trigger];
    if (chat === C1_CHAT) world().seed('c1', lines.map(rawLine));
    else for (const line of lines) cli.seedEvent(eventLine(chat, line));
    const trigger = { id, placeId: chat.chatId, authorId, authorName, self: false, bot: false, content: text, ts: at };
    await withCapturedLogs(() =>
      turns.runTurn({ chat: { iface: chat.iface, chatId: chat.chatId }, mode: 'reply', trigger, triggerKind: 'mention' })
    );
    await new Promise((resolve) => setImmediate(resolve));
    out.push(requests.slice(firstOfStep - 1));
  }
  return {
    requests: out,
    sends: [...sendsOf(fake), ...sendsOf(cli)],
    reactions: [...reactionsOf(fake), ...reactionsOf(cli)],
  };
}

/**
 * Reply turns in `c1`, one after another on one turn runner, each answering its `trigger`, which joins the chat's
 * history before its turn. The chat is the world's place `fake:channel:c1`. Returns the user texts of every request,
 * one list per turn.
 */
export async function replyTurns(spec: {
  world: World;
  steps: ReadonlyArray<ReplyStep>;
  settings?: Record<string, number>;
}): Promise<Array<Array<string>>> {
  return (await replyRun(spec)).requests;
}

/** A wake of `kind` as the drain hands it to the turn, with `extra` laid over it. */
export function serviceWake(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind,
    items: [{ kind, reason: kind === 'selfimprovement' ? 'daily' : kind, intentionIds: [], errandId: null }],
    intentions: [],
    now: TURN_NOW,
    timezone: 'UTC',
    channels: [],
    chainId: `${kind}:1`,
    ...extra,
  };
}

/** The body of the root block `<tag>` of a request's user text, '' when absent. */
export function blockOf(text: string, tag: string): string {
  return new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(text)?.[1] ?? '';
}

/** The root tags of a request's user text, in order: a line `<tag>` that a line `</tag>` closes. */
export function rootTags(text: string): Array<string> {
  return [...text.matchAll(/^<([a-z_]+)>\n[\s\S]*?\n<\/\1>$/gm)].map((match) => match[1] ?? '');
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);
