// The engine of a turn replayed by scripts/turn-replay.ts, composed the way the core composes it for a live turn
// (src/core.ts, the `createTurnRunner` call and what it is handed) over a data copy read only. Every reader that takes
// a clock reads `now`, the stored turn's start. The memory database is opened read only
// (scripts/lib/memory-read.ts). The store is the unflushed copy of scripts/replay.ts. The journal reads the copy and
// writes nothing, its starts and operations kept in process. The record and the archive read the copy and append
// nothing. The interface is the port `buildTurnRunner` is given (scripts/lib/turn-port.ts). Her tools pass the gate
// of scripts/lib/turn-tools.ts. The persona's drawing and voice are stand-ins that keep what she asked for and make
// nothing. Nothing here reaches a chat platform.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTurnRunner } from '../../src/behavior/turn.ts';
import type { CreateTurnRunnerInput, TurnRunner } from '../../src/behavior/turn-types.ts';
import { createRecall } from '../../src/behavior/recall-run.ts';
import { createEmojiIndex } from '../../src/behavior/emoji-index.ts';
import { createReactorStore } from '../../src/behavior/reactor-store.ts';
import { createAroundStore } from '../../src/behavior/around-store.ts';
import { createStore } from '../../src/memory/store.ts';
import { createJournal } from '../../src/memory/journal.ts';
import type { Journal } from '../../src/memory/journal.ts';
import { createRecord } from '../../src/memory/record.ts';
import { createArchive } from '../../src/memory/archive.ts';
import { createAppendStore } from '../../src/memory/append-store.ts';
import { createVectors } from '../../src/memory/vectors.ts';
import { createDescriber } from '../../src/memory/describe.ts';
import { issueContext } from '../../src/memory/db/scope.ts';
import type { Context } from '../../src/memory/db/scope.ts';
import { linkedDmScopes } from '../../src/memory/db/person-links.ts';
import { loadStemmer } from '../../src/memory/db/stems.ts';
import type { Db } from '../../src/memory/db/types.ts';
import { withIface } from '../../src/memory/db/current-iface.ts';
import { createCalibrator } from '../../src/llm/tokens.ts';
import { DAY_MS, utcDay } from '../../src/time.ts';
import { createImageGen } from '../../src/llm/images.ts';
import { createRoleHealth } from '../../src/llm/role-health.ts';
import { createImageFetcher } from '../../src/media/fetch-image.ts';
import { createVideoFetcher } from '../../src/media/fetch-video.ts';
import { createKeptFetch } from '../../src/media/kept-files.ts';
import { createPageFetcher } from '../../src/web/fetch-page.ts';
import { createBraveSearch } from '../../src/web/brave.ts';
import { createExaSearch } from '../../src/web/exa.ts';
import { createLookup } from '../../src/web/lookup.ts';
import { createReads } from '../../src/interface/reads.ts';
import { createMemberDirectory } from '../../src/interface/members.ts';
import { createIntentionStores } from '../../src/intentions/store.ts';
import { createIntentionService } from '../../src/intentions/service.ts';
import { createErrandStores } from '../../src/errands/store.ts';
import { createAdmin } from '../../src/admin.ts';
import { callArgsText } from '../../src/tools/call-args.ts';
import { proxySettings } from '../../src/net/proxy.ts';
import type { Hot } from '../../src/hot.ts';
import type { Adapter } from '../../src/protocol/adapter.ts';
import { readOnlyMemory } from './memory-read.ts';
import { unflushedStore } from '../replay.ts';
import { serviceKey, serviceKeys } from './cli.ts';
import { gatedOps, gatedPersonLinks } from './turn-tools.ts';
import type { KeptCall } from './turn-tools.ts';

type Rec = Record<string, unknown>;
type Llm = { complete: (messages: unknown, options?: unknown) => Promise<unknown> };
type Embed = (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;

/** What a replayed turn kept of its journal: the turn it started and every record and operation line it would write. */
export type KeptJournal = { lines: Array<{ kind: string; placeId: string | null; record: unknown }> };

/** A quiet log for the engine's modules: a replay's stderr carries its own table, and logs never carry contents. */
export const quietLog: { info(): void; warn(): void; error(): void; debug(): void } = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * A journal over the copy that reads what the copy holds and writes nothing: its start answers the stored turn's id,
 * and every line it would append is kept in `kept.lines`.
 */
function keptJournal(journal: Journal, turnId: string, now: () => number): { journal: Journal; kept: KeptJournal } {
  const kept: KeptJournal = { lines: [] };
  const keep =
    (kind: string) =>
    (placeId: unknown, record?: unknown): Promise<void> => {
      kept.lines.push({ kind, placeId: typeof placeId === 'string' ? placeId : null, record: record ?? placeId });
      return Promise.resolve();
    };
  let attempt = 0;
  const wrapped: Journal = {
    ...journal,
    start(placeId, input) {
      attempt += 1;
      kept.lines.push({ kind: 'turn.start', placeId, record: input });
      return { turnId, attemptId: attempt, startedAt: new Date(now()).toISOString() };
    },
    turn: keep('turn'),
    action: keep('action'),
    memory: keep('memory'),
    system: (record) => keep('system')(null, record),
    answer: keep('answer'),
    inner: keep('inner'),
    op(placeId, base) {
      const opId = `op-replay-${kept.lines.length + 1}`;
      const line = (phase: string) => (extra?: unknown) => keep('action')(placeId, { ...base, opId, phase, extra });
      return {
        opId,
        proposed: line('proposed'),
        started: line('started'),
        succeeded: line('succeeded'),
        failed: (code, result) => keep('action')(placeId, { ...base, opId, phase: 'failed', code, result }),
        unknown: line('unknown'),
      };
    },
    flush: () => Promise.resolve(),
  };
  return { journal: wrapped, kept };
}

type JournalRecord = {
  kind?: unknown;
  event?: unknown;
  occurredAt?: unknown;
  recordedAt?: unknown;
  [key: string]: unknown;
};

const timeOf = (record: JournalRecord): number => {
  const at = record.occurredAt ?? record.recordedAt;
  return typeof at === 'string' ? Date.parse(at) : Number.NaN;
};

/** When the core that ran the turn started: the journal's last `start` record before `at`, else the epoch. */
export async function processStart(journal: Journal, days: ReadonlyArray<string>, at: number): Promise<number> {
  let since = 0;
  for (const day of days)
    for (const record of (await journal.read(null, {
      day,
      kind: 'system',
      n: Number.MAX_SAFE_INTEGER,
    })) as Array<JournalRecord>)
      if (record.event === 'start' && timeOf(record) <= at) since = Math.max(since, timeOf(record));
  return since;
}

/** The arguments of the lookups a place's journal kept (`result.lookup.args`), by tool and the time of their end. */
async function lookupArgs(journal: Journal, placeId: string, days: ReadonlyArray<string>): Promise<Map<string, Rec>> {
  const out = new Map<string, Rec>();
  for (const day of days)
    for (const record of (await journal.read(placeId, {
      day,
      kind: 'action',
      n: Number.MAX_SAFE_INTEGER,
    })) as Array<JournalRecord>) {
      const lookup = (record.result as { lookup?: { tool?: unknown; args?: unknown } } | undefined)?.lookup;
      if (record.phase !== 'succeeded' || typeof lookup?.tool !== 'string' || typeof lookup.args !== 'object') continue;
      out.set(`${lookup.tool}|${timeOf(record)}`, (lookup.args ?? {}) as Rec);
    }
  return out;
}

/**
 * The journal's call marks with the arguments a mark made in the running core carries (src/turn/skill-calls.ts, `args`)
 * put back on the lookups made since the core started: the core's own restore keeps none (journal.ts#callMarksOf), and
 * the turn ran in a core that had made those calls itself.
 */
function withArgs(calls: ReadonlyArray<object>, args: ReadonlyMap<string, Rec>, since: number): Array<object> {
  return calls.map((call) => {
    const mark = call as { skill?: unknown; at?: unknown };
    const kept = args.get(`${String(mark.skill)}|${String(mark.at)}`);
    return kept !== undefined && Number(mark.at) >= since
      ? { ...call, args: callArgsText(String(mark.skill), kept) }
      : call;
  });
}

/** The around store of a replay: one presence snapshot taken, with nobody in voice and no status. */
function emptyAround(presences: boolean) {
  const around = createAroundStore({ presences });
  around.snapshot({ kind: 'presence.snapshot', iface: '', at: 0, id: 'replay:presence', voice: [], presence: [] });
  return around;
}

/** How long a replay lets the runner's background seeding of thinks and lookups run before the turn starts. */
const SEED_SETTLE_MS = 1000;

/** A 1x1 transparent PNG: what the drawing stand-in answers. */
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

/** The person, the chat and the persona a replayed turn has on its interface, read from the copy. */
export type ReplayIdentity = {
  iface: string;
  selfId: string;
  selfName: string;
  /** The native id of the root the turn's place is under; null for a place outside any root. */
  rootNative: string | null;
};

/**
 * Her account and the name it goes by, from the copy's accounts: the one on `iface` when she has one there, else her
 * first account elsewhere. The core takes both from the hello of the interface it serves, the command line's turns
 * included (src/core.ts `greet`).
 */
export function identityIn(db: Db, iface: string): { selfId: string; selfName: string } {
  const row = db
    .prepare(
      `SELECT native_id, names FROM accounts WHERE person_id = 'person:self' AND native_id IS NOT NULL
       ORDER BY iface = ? DESC, id LIMIT 1`
    )
    .get(iface);
  let name = 'bot';
  try {
    const names: unknown = JSON.parse(typeof row?.names === 'string' ? row.names : '[]');
    if (Array.isArray(names) && typeof names[0] === 'string') name = names[0];
  } catch {
    // An unreadable names column leaves the name the core gives before hello.
  }
  return { selfId: typeof row?.native_id === 'string' ? row.native_id : 'self', selfName: name };
}

/** The members of the root `rootPlace` as the interface reported them: each account's first stored name. */
function seededMembers(db: Db, rootPlace: string | null, rootNative: string | null) {
  const members = createMemberDirectory();
  if (rootPlace === null || rootNative === null) return members;
  const rows = db
    .prepare(
      `SELECT a.native_id, a.names, a.kind, m.nick FROM memberships m JOIN accounts a ON a.id = m.account_id
       WHERE m.place_id = ? AND m.valid_to_at IS NULL`
    )
    .all(rootPlace);
  for (const row of rows) {
    let name: unknown = row.nick;
    try {
      const names: unknown = JSON.parse(typeof row.names === 'string' ? row.names : '[]');
      if (typeof name !== 'string' && Array.isArray(names)) name = names[0];
    } catch {
      // An account with unreadable names is reported without one, and the directory skips it.
    }
    members.apply({
      kind: 'membership.changed',
      iface: '',
      at: 0,
      id: `replay:member:${String(row.native_id)}`,
      placeId: rootNative,
      accountId: String(row.native_id),
      change: 'joined',
      member: { id: String(row.native_id), name: typeof name === 'string' ? name : '', bot: row.kind === 'bot' },
    });
  }
  return members;
}

export type WiringInput = {
  root: string;
  dataDir: string;
  hot: Hot;
  turnId: string;
  now: () => number;
  identity: ReplayIdentity;
  /** The place id of the root, for the member directory. */
  rootPlace: string | null;
  port: Adapter;
  llm: Llm;
  /** The token calibration the request budget applies (`--calibration`); absent: the copy's stored one. */
  calibration?: number;
  /** The embedding client: the real one on `--embed live`, else one that embeds nothing. */
  embed: Embed;
};

export type Wired = {
  runner: TurnRunner;
  journal: KeptJournal;
  calls: Array<KeptCall>;
  drawings: Array<unknown>;
  /**
   * The journal's marks of yesterday and today for every top place, handed to the runner as the core hands them at its
   * start (src/core.ts `seedTriggerLinks`, `seedCallMarks`).
   */
  seed: () => Promise<void>;
  /** The memory rows each request carried, as the core hands them to its turn_reads record. */
  carried: Array<unknown>;
  /** The unflushed store the runner reads. */
  store: unknown;
  /** An execution context of the turn's interface, issued at the turn's start. */
  memoryContext: (spec?: Parameters<typeof issueContext>[0]) => Context;
  /** Runs `work` under the turn's interface, as the core's door runs a turn. */
  under: <TResult>(work: () => TResult) => TResult;
  close: () => void;
};

/** The turn runner of a replay (see the head of this file), with what it keeps. */
// health: allow function-length -- one composition in the core's order, split it would hide which reader gets what
export function buildTurnRunner(input: WiringInput): Wired {
  const { root, dataDir, hot, turnId, now, identity, port } = input;
  const memory = readOnlyMemory(dataDir);
  const memoryDb = memory.memoryDb;
  if (memoryDb === null) throw new Error(`turn-replay: no memory.db in ${dataDir}`);
  const db = (): Db | null => memoryDb.database() as Db | null;
  const appendStore = createAppendStore({ fsyncMs: 500, retryMax: 1000, log: quietLog });
  const recordReader = createRecord({ dataDir, log: quietLog, writerGate: () => Promise.resolve(), memoryDb });
  const record = { ...recordReader, append: () => Promise.resolve({ written: 0 }) };
  const archive = createArchive({
    appendStore,
    dataDir,
    log: quietLog,
    writerGate: () => Promise.resolve(),
    memoryDb,
  });
  const vectors = createVectors({ dataDir, log: quietLog, writerGate: () => Promise.resolve(), memoryDb });
  const base = createJournal({ dataDir, memoryDb, now, log: quietLog });
  const { journal, kept } = keptJournal(base, turnId, now);
  const { store, state } = unflushedStore(createStore({ dataDir, record, archive, memoryDb }));
  const calibrator = createCalibrator(input.calibration ?? ((state.data as Rec).calibration as number | undefined));
  const llm = input.llm;
  const keptFetch = createKeptFetch({ dataDir, next: fetch });
  const imageFetcher = createImageFetcher({ fetchImpl: keptFetch });
  // The store, the model client and the state are the core's untyped objects, the ones src/core.ts hands these
  // three modules, so their shapes match at run time where the declared types of the deps do not.
  const describer = createDescriber({
    hot,
    store,
    llm,
    imageFetcher,
    videoFetcher: createVideoFetcher({ fetchImpl: keptFetch }),
    state,
    youtubeApiKey: serviceKey('youtube', { dataDir }),
    proxy: () => (proxySettings(hot.config).enabled ? serviceKey('proxy', { dataDir }) : null),
  } as unknown as Parameters<typeof createDescriber>[0]);
  const lookup = createLookup({
    hot,
    store,
    llm,
    state,
    pageFetcher: createPageFetcher(),
    searches: { brave: createBraveSearch(), exa: createExaSearch() },
    keys: serviceKeys({ dataDir }),
    now,
  } as unknown as Parameters<typeof createLookup>[0]);
  const reads = createReads(port, quietLog, () => identity.rootNative);
  const members = seededMembers(memoryDb.database() as Db, input.rootPlace, identity.rootNative);
  const recall = createRecall({
    hot,
    store,
    llm,
    reads,
    memberName: (_placeId: string, accountId: string) =>
      identity.rootNative === null ? null : members.nameOf(identity.rootNative, accountId),
    describer,
    archive,
    record,
    vectors,
    embed: input.embed,
    memoryDb,
    iface: identity.iface,
    now,
  } as unknown as Parameters<typeof createRecall>[0]);
  const embedOne =
    (purpose: string) =>
    async (text: string): Promise<ArrayLike<number> | null> =>
      (await input.embed([text], { config: hot.config as unknown, purpose }))[0] ?? null;
  const memoryContext = (spec: Parameters<typeof issueContext>[0] = {}): Context => {
    const ctx = issueContext({ iface: identity.iface, ...spec, now });
    const read = db();
    return read === null || ctx.kind !== 'dm' || !ctx.person
      ? ctx
      : { ...ctx, linked: linkedDmScopes(read, ctx.person, ctx.place ?? null) };
  };
  const intentions = createIntentionService({
    stores: readOnlyIntentionStores(createIntentionStores({ memoryDb, now, log: quietLog })),
    hot,
  } as Parameters<typeof createIntentionService>[0]);
  const taskStore = createErrandStores({
    config: (): unknown => hot.config,
    memoryDb,
    now,
    log: quietLog,
    agentPaths: { rootDir: root, dataDir, env: {} },
  }).get();
  const errands = {
    view: ({ dmChatId = null }: { dmChatId?: string | null } = {}) =>
      [...(taskStore?.open() ?? []), ...(taskStore?.unread() ?? [])].filter(
        (errand) => errand.scope !== 'dm' || (dmChatId !== null && errand.origin?.placeId === String(dmChatId))
      ),
    markSeen: () => {},
    budget: ({ agent }: { agent: string }) => taskStore?.budget(agent) ?? null,
    store: () => taskStore,
  };
  type ImageConfig = ReturnType<Parameters<typeof createImageGen>[0]['getConfig']>;
  const realImages = createImageGen({ apiKey: () => '', getConfig: (): ImageConfig => hot.config as ImageConfig });
  const drawings: Array<unknown> = [];
  const images = {
    familyOf: realImages.familyOf,
    generate: (request: unknown) => {
      drawings.push(request);
      return Promise.resolve({ buffer: BLANK_PNG, mediaType: 'image/png', cost: 0, usage: {}, model: '', seconds: 0 });
    },
  };
  const speech = {
    say: (request: unknown) => {
      drawings.push({ voice: request });
      return Promise.resolve({ ok: false, code: 'replay' });
    },
  };
  const admin = createAdmin({
    hot,
    store,
    reads,
    selfId: () => identity.selfId,
    getSelfName: () => identity.selfName,
    port,
    intentions,
    errands,
    journal,
    dataDir: null,
  });
  const carried: Array<unknown> = [];
  const gate = gatedOps({
    runOp: (op, args, context) => admin.runSkillOp(op, args, context),
    runOwnOp: (op, args, context) => admin.runOwnSkillOp(op, args, context),
    runInitiativeOp: (op, args, context) => admin.runInitiativeSkillOp(op, args, context),
    now,
  });
  const nameOfMember = (accountId: string) =>
    identity.rootNative === null ? null : members.infoOf(identity.rootNative, accountId);
  const deps: CreateTurnRunnerInput = {
    personLinks: gatedPersonLinks(gate.calls, now),
    dataDir,
    fetchImpl: keptFetch,
    embedQuery: embedOne('media-pick'),
    embedFind: embedOne('recall-query'),
    hot,
    store,
    roleHealth: createRoleHealth({ now, hasKey: () => true }),
    // The memory rows the request carried, kept for the report where the core records them as turn_reads.
    memoryReads: (args: unknown) => {
      carried.push(args);
    },
    journalDb: () => db(),
    memoryContext,
    attention: new Set(),
    llm,
    calibrator,
    describer,
    imageFetcher,
    lookup,
    recall,
    images,
    speech,
    emoji: createEmojiIndex({ reads, now }),
    // The live glance at voice channels and statuses (src/core.ts): kept in process only, so a replay starts it empty,
    // as a snapshot that found nobody. The core reads presences off the link's hello, which a chat platform declares.
    around: emptyAround(identity.iface !== 'cli'),
    // Who reacted to her messages: filled from the interface's reactors read as the live store is (reactor-store.ts).
    reactors: createReactorStore(),
    getSelfName: (placeId: string | null) =>
      (identity.rootNative !== null && placeId !== null
        ? members.nameOf(identity.rootNative, identity.selfId)
        : null) ?? identity.selfName,
    selfId: () => identity.selfId,
    stemmer: () => {
      const read = db();
      return read === null ? null : loadStemmer(read);
    },
    reads,
    memberOf: (_placeId: string, accountId: string) => nameOfMember(accountId),
    membersOf: () => (identity.rootNative === null ? [] : members.list(identity.rootNative)),
    chatName: () => null,
    activity: null,
    journal,
    record,
    port,
    activeSkills: () => Promise.resolve([]),
    recordSkillUses: () => {},
    runOp: gate.runOp,
    runOwnOp: gate.runOwnOp,
    runInitiativeOp: gate.runInitiativeOp,
    errands,
    intentions,
    places: null,
    now,
    rng: Math.random,
  };
  const runner = createTurnRunner(deps);
  const seed = async (): Promise<void> => {
    const at = now();
    const days = [utcDay(at - DAY_MS), utcDay(at)];
    const tops = (store as { topPlaces?: () => Array<string> }).topPlaces?.() ?? [];
    const since = await processStart(base, days, at);
    for (const placeId of new Set([...tops, ...(input.rootPlace === null ? [] : [input.rootPlace])])) {
      runner.seedTriggerLinks(await base.triggerLinks(placeId, { days }));
      const marks = await base.callMarks(placeId, { days });
      const args = await lookupArgs(base, placeId, days);
      runner.seedCallMarks({ ...marks, calls: withArgs(marks.calls, args, since), placeId });
    }
    // The runner seeds the thinks and lookups of a place in the background, with no promise to wait on: these reads of
    // a local database end within milliseconds, and a second leaves them ample room.
    await new Promise((resolve) => setTimeout(resolve, SEED_SETTLE_MS));
  };
  return {
    seed,
    carried,
    store,
    runner,
    journal: kept,
    calls: gate.calls,
    drawings,
    memoryContext,
    under: (work) => withIface(identity.iface, work),
    close: () => memory.close(),
  };
}

/** The intention stores of the copy with every write answered `read-only` (as scripts/replay.ts reads them). */
function readOnlyIntentionStores(stores: { get(placeId: string): unknown }) {
  return {
    get(placeId: string) {
      const found = stores.get(placeId);
      if (found === null || typeof found !== 'object') return null;
      return new Proxy(found, {
        get(target, prop) {
          if (prop === 'add' || prop === 'update') return () => ({ ok: false, code: 'read-only' });
          if (prop === 'forgetUser' || prop === 'wipe')
            return () => {
              throw new Error('turn-replay: intentions are read-only here');
            };
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? (value as (...args: Array<unknown>) => unknown).bind(target) : value;
        },
      });
    },
  };
}

/** A scratch folder under TMPDIR for one run, removed by the caller. */
export function scratchDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export { randomUUID };
