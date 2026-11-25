// The engine of a turn replayed by scripts/replay.ts, composed the way the core composes it for a live turn
// (src/core.ts, the `createTurnRunner` call and what it is handed) over a data copy read only. Every reader that takes
// a clock reads `now`, the stored turn's start. The memory database is opened read only
// (scripts/lib/memory-read.ts). The store is the unflushed copy of scripts/replay.ts. The journal reads the copy and
// writes nothing, its starts and operations kept in process. The record and the archive read the copy and append
// nothing, and each record append is kept among the journal's lines as a `record.append` line. The interface is the port `buildTurnRunner` is given (scripts/lib/turn-port.ts). The persona's tools pass the gate
// of scripts/lib/turn-tools.ts. The persona's drawing and voice are stand-ins that keep what they asked for and make
// nothing. Nothing here reaches a chat platform. With `fetchImpl` an offline replay keeps every page, picture and search
// request off the network too, and with `archived` it answers the network tools from the archive (scripts/lib/turn-tools.ts).

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
import { createDescriber } from '../../src/memory/describe.ts';
import type { AttachedItem } from '../../src/memory/describe.ts';
import { chatOfPlace } from '../../src/memory/addresses.ts';
import { freshAttachmentUrl } from '../../src/media/gif-post.ts';
import { createSummarizer } from '../../src/behavior/summarize.ts';
import { opensPrivate } from '../../src/memory/open-private.ts';
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
import type { Reads } from '../../src/interface/reads.ts';
import { withStableNames } from '../../src/behavior/stable-names.ts';
import { loadPrincipals } from '../../src/interface/principals.ts';
import { useOwnerAccounts } from '../../src/tools/operations/grants.ts';
import { createOwnerAccounts } from '../../src/memory/db/person-links.ts';
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
import { answeredErrands } from './errand-answers.ts';
import type { ErrandAnswer } from './errand-answers.ts';
import { skillRegistry } from '../../src/tools/registry.ts';
import { JOBS } from '../../src/tools/definitions.ts';
import type { SkillMap, Untyped } from '../../src/tools/types.ts';
import { serviceKey, serviceKeys } from './cli.ts';
import { gatedOps, gatedPersonLinks } from './turn-tools.ts';
import { copyFacts } from './turn-inner.ts';
import type { GatewayCall, KeptCall } from './turn-tools.ts';

type Rec = Record<string, unknown>;
type Llm = { complete: (messages: unknown, options?: unknown) => Promise<unknown> };
type Embed = (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;

/**
 * The real store for a replay run: reads pass through; `state` is an
 * in-memory deep copy whose markDirty does nothing; flush, forget, wipe and
 * reload methods throw; the recall trace is a no-op. Other mutations touch
 * only this process's cache, which is never flushed.
 * @param store From src/memory/store.ts#createStore.
 */
export function unflushedStore(store: Untyped): {
  store: Record<string, Untyped>;
  state: { data: Untyped; markDirty(): void };
} {
  const target = store as object;
  const data: unknown = structuredClone((target as { state?: { data?: unknown } }).state?.data ?? {});
  const state: { data: Untyped; markDirty(): void } = { data, markDirty() {} };
  const refused = new Set([
    'flush',
    'flushEntry',
    'forgetUser',
    'forgetPrivate',
    'wipeGuild',
    'dropCaches',
    'reloadState',
  ]);
  const proxy = new Proxy(target, {
    get(inner, prop) {
      if (prop === 'state') return state;
      if (typeof prop === 'string' && refused.has(prop)) {
        return () => {
          throw new Error(`replay-cli: the memory store is not written here (${String(prop)} refused)`);
        };
      }
      if (prop === 'appendRecallTrace') return () => undefined;
      const value: unknown = Reflect.get(inner, prop, inner);
      return typeof value === 'function' ? (value as (...args: Array<unknown>) => unknown).bind(inner) : value;
    },
  });
  return { store: proxy as Record<string, Untyped>, state };
}

/**
 * What a replayed turn kept of its journal: the turn it started and every record and operation line it would write,
 * and each append to the record as a line of kind `record.append` whose record is `{ lines, messages }`.
 */
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
function keptJournal(
  journal: Journal,
  turnId: string,
  now: () => number
): { journal: Journal; kept: KeptJournal; idle: () => Promise<void> } {
  const kept: KeptJournal = { lines: [] };
  const reads = trackedReads(journal.read.bind(journal));
  const keep =
    (kind: string) =>
    (placeId: unknown, record?: unknown): Promise<void> => {
      kept.lines.push({ kind, placeId: typeof placeId === 'string' ? placeId : null, record: record ?? placeId });
      return Promise.resolve();
    };
  let attempt = 0;
  const wrapped: Journal = {
    ...journal,
    read: reads.read,
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
      // Numbered by the journal's own lines: a record append kept among them names no operation.
      const journalLines = kept.lines.filter((line) => line.kind !== 'record.append').length;
      const opId = `op-replay-${journalLines + 1}`;
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
  return { journal: wrapped, kept, idle: reads.idle };
}

/**
 * `read` with every call in flight tracked: `idle` ends once no read is in flight, a read started as an earlier one
 * ends included. The runner seeds the thinks and lookups of a place in the background with no promise to wait on
 * (src/behavior/turn.ts `seedCallMarks`), so a replay waits for its journal reads instead.
 */
export function trackedReads<TArgs extends Array<unknown>, TResult>(
  read: (...args: TArgs) => Promise<TResult>
): { read: (...args: TArgs) => Promise<TResult>; idle: () => Promise<void> } {
  const flying = new Set<Promise<unknown>>();
  return {
    read(...args) {
      const one = read(...args);
      const settled = one.then(
        () => undefined,
        () => undefined
      );
      flying.add(settled);
      void settled.then(() => flying.delete(settled));
      return one;
    },
    async idle() {
      while (flying.size > 0) {
        await Promise.all([...flying]);
        // The reader's code after its await runs before the next turn of this loop looks again.
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
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

/** The name lookup of an offline replay's page fetcher: every host fails as unreachable, before any request. */
const noAddress = (): Promise<never> => Promise.reject(new Error('replay-cli: offline'));

/** The fetch of an offline replay: every request fails as the network would, and nothing leaves the process. */
export const offlineFetch: typeof fetch = () => Promise.reject(new TypeError('replay-cli: offline'));

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
 * The persona's account and the name it goes by, from the copy's accounts: the one on `iface` when they have one there, else their
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

/**
 * The persona's identity as the core holds it for every turn, a command line turn included: their account on the home interface.
 * The core names the first interface client of `clients.json` (src/core.ts, `identity.iface` before any unit
 * connects) and takes their id and name from the hello of the interface it serves (`greet`). The command line connects
 * as a `cli` client and never greets. A copy without `clients.json` takes the interface of their first account off the
 * command line, and `from` says which rule chose.
 */
export function homeIdentity(
  db: Db,
  dataDir: string
): { iface: string; selfId: string; selfName: string; from: 'clients.json' | 'accounts' } {
  const clients = loadPrincipals(dataDir) ?? [];
  const named = clients.find((entry) => entry.kind === 'interface')?.iface ?? null;
  if (named !== null) return { iface: named, ...identityIn(db, named), from: 'clients.json' };
  const row = db
    .prepare(
      `SELECT iface FROM accounts WHERE person_id = 'person:self' AND native_id IS NOT NULL AND iface <> 'cli'
       ORDER BY id LIMIT 1`
    )
    .get();
  const iface = typeof row?.iface === 'string' ? row.iface : 'cli';
  return { iface, ...identityIn(db, iface), from: 'accounts' };
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
  /** The runner's random source (scripts/replay.ts `--inner --seed`); absent: `Math.random`. */
  rng?: () => number;
  /** The source of the ids the runner hands out (replay `--seed`, a counter); absent: random UUIDs. */
  newId?: () => string;
  /** Laid over the interface's reads (scripts/replay.ts `--hide-channel`, `--hide-message`); absent: the reads as built. */
  wrapReads?: (reads: Reads) => Reads;
  /**
   * The results that answer the persona's errand calls (scripts/replay.ts `--inner --errand-answers`); absent: an inner turn in
   * shadow only proposes them.
   */
  errandAnswers?: ReadonlyArray<ErrandAnswer> | null;
  /** The image client in place of the stand-in (scripts/replay.ts `--diary-kind --draw live`); absent: the stand-in. */
  images?: CreateTurnRunnerInput['images'];
  /** The look at a picture the persona drew (scripts/replay.ts `--draw none`); absent: no look, as with no eyes. */
  describePicture?: CreateTurnRunnerInput['describePicture'];
  /** What reaches the network for a page, a picture, a video or a search (replay `--answers archive`, offline); absent: `fetch`. */
  fetchImpl?: typeof fetch;
  /** The answer the live turn read for the next call of a network tool (replay `--answers archive`); absent: none. */
  archived?: (op: string) => unknown;
};

/**
 * The skills with the errand tools declared `read`, so the gate of an inner turn in shadow runs them
 * (src/turn/skill-calls.ts#innerVerdict) and the errand service answers them from the file. That effect class is read
 * only by that gate and by the cooldown of a destructive skill, which an errand tool is not.
 */
function answeredErrandSkills(): SkillMap {
  return new Map(
    [...skillRegistry()].map(([name, skill]) => [name, JOBS.includes(name) ? { ...skill, effects: 'read' } : skill])
  );
}

export type Wired = {
  runner: TurnRunner;
  journal: KeptJournal;
  calls: Array<KeptCall>;
  /** Every call the tool gate answered, run or kept, with its result (scripts/lib/turn-tools.ts `log`). */
  gateway: Array<GatewayCall>;
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
  /** The interface's reads the runner is handed. */
  reads: Reads;
  /** The intention service the runner is handed, over the copy's stores read only. */
  intentions: ReturnType<typeof createIntentionService>;
  /** Runs `work` under the turn's interface, as the core's door runs a turn. */
  under: <TResult>(work: () => TResult) => TResult;
  close: () => void;
};

/** The turn runner of a replay (see the head of this file), with what it keeps. */
// health: allow function-length until 2027-02-01 -- one composition in the core's order, split it would hide which reader gets what
export function buildTurnRunner(input: WiringInput): Wired {
  const { root, dataDir, hot, turnId, now, identity, port } = input;
  // The live interface the core's service would name.
  const memory = readOnlyMemory(dataDir, { iface: identity.iface });
  const memoryDb = memory.memoryDb;
  if (memoryDb === null) throw new Error(`replay-cli: no memory.db in ${dataDir}`);
  const db = (): Db | null => memoryDb.database() as Db | null;
  // The owner check of every tool call, installed as the core installs it: without it no requester is the owner, and
  // a tool only the owner may ask for is refused in a turn the owner started.
  const dropOwnerCheck = useOwnerAccounts(createOwnerAccounts({ database: db, home: () => identity.iface }));
  const appendStore = createAppendStore({ fsyncMs: 500, retryMax: 1000, log: quietLog });
  const recordReader = createRecord({ dataDir, log: quietLog, writerGate: () => Promise.resolve(), memoryDb });
  const archive = createArchive({
    appendStore,
    dataDir,
    log: quietLog,
    writerGate: () => Promise.resolve(),
    memoryDb,
  });
  const base = createJournal({ dataDir, memoryDb, now, log: quietLog });
  const { journal, kept, idle } = keptJournal(base, turnId, now);
  const record = {
    ...recordReader,
    append: (placeId: string | null, lines: Array<unknown>, options: { messages?: ReadonlyArray<unknown> } = {}) => {
      kept.lines.push({ kind: 'record.append', placeId, record: { lines, messages: options.messages ?? null } });
      return Promise.resolve({ written: 0, duplicates: 0 });
    },
  };
  const namesStore = createStore({ dataDir, archive, memoryDb });
  const { store, state } = unflushedStore(namesStore);
  const calibrator = createCalibrator(input.calibration ?? ((state.data as Rec).calibration as number | undefined));
  const llm = input.llm;
  const net = input.fetchImpl ?? fetch;
  const keptFetch = createKeptFetch({ dataDir, next: net });
  const imageFetcher = createImageFetcher({ fetchImpl: keptFetch });
  // The one summarizer src/core.ts shares among the describer, the web lookup and its clients, the turns and the operations.
  const summarize = createSummarizer({ hot, llm } as unknown as Parameters<typeof createSummarizer>[0]).summarize;
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
    summarize,
    // An attachment's address lapses: its message is read again for a fresh one before each download, as the core
    // does (src/core.ts). `reads` is defined below and read at each call.
    freshAddress: (item: AttachedItem) =>
      freshAttachmentUrl({
        reads,
        channel: { iface: identity.iface, chatId: chatOfPlace(namesStore, item.placeId) ?? item.placeId },
        entry: { messageId: item.messageId, itemId: item.itemId },
      }),
  } as unknown as Parameters<typeof createDescriber>[0]);
  const lookup = createLookup({
    hot,
    store,
    llm,
    state,
    pageFetcher: input.fetchImpl ? createPageFetcher({ lookup: noAddress }) : createPageFetcher(),
    searches: { brave: createBraveSearch({ fetchImpl: net }), exa: createExaSearch({ fetchImpl: net }) },
    keys: serviceKeys({ dataDir }),
    now,
    summarize,
  } as unknown as Parameters<typeof createLookup>[0]);
  const built = createReads(withStableNames(port, namesStore), quietLog, () => identity.rootNative);
  const reads = input.wrapReads ? input.wrapReads(built) : built;
  const members = seededMembers(memoryDb.database() as Db, input.rootPlace, identity.rootNative);
  const recall = createRecall({
    hot,
    store,
    mediaNameOf: namesStore.mediaNameOf,
    llm,
    memberName: (_placeId: string, accountId: string) =>
      identity.rootNative === null ? null : members.nameOf(identity.rootNative, accountId),
    describer,
    archive,
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
    // As the memory service issues it: `context.memory.openPrivate` opens every audience to a group or DM context.
    const ctx = issueContext({ iface: identity.iface, ...spec, open: opensPrivate(hot.config), now });
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
  const answered = input.errandAnswers ? answeredErrands(input.errandAnswers, now) : null;
  const errands = {
    ...(answered ?? {}),
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
  // A free stand-in of the speech model: the voice message holds no sound, and its text is what the persona asked to say.
  const speech = {
    say: (request: { text?: unknown }) => {
      drawings.push({ voice: request });
      const voiced = typeof request?.text === 'string' ? request.text : '';
      return Promise.resolve({ ogg: new Uint8Array(0), durationSecs: 0, waveform: '', voiced });
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
    summarize,
  });
  const carried: Array<unknown> = [];
  const gate = gatedOps({
    runOp: (op, args, context) => admin.runSkillOp(op, args, context),
    runOwnOp: (op, args, context) => admin.runOwnSkillOp(op, args, context),
    runInitiativeOp: (op, args, context) => admin.runInitiativeSkillOp(op, args, context),
    now,
    runs: answered ? JOBS : [],
    ...(input.archived ? { archived: input.archived } : {}),
  });
  const nameOfMember = (accountId: string) =>
    identity.rootNative === null ? null : members.infoOf(identity.rootNative, accountId);
  const deps: CreateTurnRunnerInput = {
    personLinks: gatedPersonLinks(gate.calls, now),
    dataDir,
    fetchImpl: keptFetch,
    summarize,
    embedQuery: embedOne('media-pick'),
    embedFind: embedOne('recall-query'),
    embedNotice: (texts: Array<string>) =>
      input.embed(texts, { config: hot.config as unknown, purpose: 'recall-query' }),
    hot,
    store,
    roleHealth: createRoleHealth({ now, hasKey: () => true }),
    // The memory rows the request carried, kept for the report where the core records them as turn_reads.
    memoryReads: (args: unknown) => {
      carried.push(args);
    },
    journalDb: () => db(),
    memoryContext,
    attention: { chat: new Set(), service: new Set() },
    llm,
    calibrator,
    describer,
    imageFetcher,
    lookup,
    recall,
    images: (input.images as typeof images | undefined) ?? images,
    speech,
    ...(input.describePicture ? { describePicture: input.describePicture } : {}),
    emoji: createEmojiIndex({ reads, now, iface: identity.iface, names: namesStore }),
    // The live glance at voice channels and statuses (src/core.ts): kept in process only, so a replay starts it empty,
    // as a snapshot that found nobody. The core reads presences off the link's hello, which a chat platform declares.
    around: emptyAround(identity.iface !== 'cli'),
    // Who reacted to the persona's messages: filled from the interface's reactors read as the live store is (reactor-store.ts).
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
    runOp: gate.runOp,
    runOwnOp: gate.runOwnOp,
    runInitiativeOp: gate.runInitiativeOp,
    errands,
    intentions,
    places: null,
    ...(answered ? { skills: answeredErrandSkills() } : {}),
    now,
    rng: input.rng ?? Math.random,
    ...(input.newId ? { newId: input.newId } : {}),
  };
  const runner = createTurnRunner(deps);
  const read = db();
  if (read !== null) runner.setFactsSource(copyFacts(read, { iface: identity.iface, now }));
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
    await idle();
  };
  return {
    seed,
    carried,
    store,
    runner,
    journal: kept,
    calls: gate.calls,
    gateway: gate.log,
    drawings,
    memoryContext,
    reads,
    intentions,
    under: (work) => withIface(identity.iface, work),
    close: () => {
      dropOwnerCheck();
      memory.close();
    },
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
              throw new Error('replay-cli: intentions are read-only here');
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
