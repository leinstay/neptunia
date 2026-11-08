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

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

export const TURN_NOW = Date.parse('2026-11-02T12:00:00.000Z');
const MIN = 60_000;
const iso = (at: number): string => new Date(at).toISOString();

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
  /** More interfaces the turn reaches, each answering the calls that name its `iface`. */
  adapters?: ReadonlyArray<Fake>;
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
 * as the real client names it (bin/cli-link.ts); the fixture named it `owner`, which only the partner lookup reached.
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

/** One inner turn of `wake` answered by `answers`, over the world's memory and the room `c1` of the fake interface. */
export async function serviceTurn(spec: ServiceTurnSpec): Promise<ServiceRun> {
  const mind = spec.world ?? serviceWorld();
  const hot: Record<string, Untyped> = {
    config: {
      bot: {
        timezone: 'UTC',
        ownerPerson: OWNER_PERSON,
        access: Object.fromEntries(GRANTED.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: { ...SERVICE_CONTEXT, memory: { ...SERVICE_CONTEXT.memory, ...spec.settings } },
      dm: { enabled: true },
      llm: { maxRequestTokens: 60000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { base: { analyzer: 'x/text' } },
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
      labels: shippedLabels,
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
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
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
      return Promise.resolve(completionOf(spec.answers[Math.min(requests.length - 1, spec.answers.length - 1)]));
    },
  };
  let contexts = 0;
  const turns = createTurnRunner({
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
  const wake = typeof spec.wake === 'function' ? spec.wake(intentions) : spec.wake;
  const inner = { wake, currentChannel: null, shadow: false, mayAct: () => true };
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
