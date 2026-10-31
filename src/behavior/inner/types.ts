// The shapes the inner life modules share: a wake and the queue's state file, the facts, the settings, the turn an
// inner turn asks the turn runner for and its result, the sources a life is given and the `life` context the facade
// (src/behavior/inner.ts) builds over them. Types only, nothing runs here. src/behavior/inner/*.ts, the heartbeat view
// (src/behavior/heartbeat-view.ts), the `<wake>` block (src/behavior/wake.ts) and the turn runner's JavaScript read them.

import type { Obj } from '../../tools/types.ts';
import type { Due, Intention } from '../../intentions/types.ts';
import type { Reads } from '../../interface/reads.ts';
import type { ConversationInfo, ConversationRef } from '../../protocol/adapter.ts';
import type { WakeQueueUpdate } from '../../memory/db/wake-queue.ts';
import type { HeartbeatFacts } from '../heartbeat-view.ts';
import type { WakeBlockInput } from '../wake.ts';
import type { WAKE_KINDS } from './settings.ts';
import type { WakeBackend } from './wake-store.ts';

/** A wake kind, as the `<wake>` block names it. */
export type WakeKind = (typeof WAKE_KINDS)[number];

/** What an attend wake knows of its place: the lines since her last look, who wrote them and the newest line. */
export type AttendInfo = {
  place: string;
  lines: number;
  people: Array<string>;
  since: number | null;
  newestAt: number;
  newestId: string;
};

/**
 * A wake as the queue keeps it. Every kind carries the first block of fields; the rest belong to some kinds and to the
 * queue's bookkeeping, and the code reads them the same way whatever the kind, so they are optional here rather than
 * split into one variant per kind.
 */
export type Wake = {
  id: string;
  kind: string;
  reason: string;
  intentionIds: Array<string>;
  chainId: string;
  dueAt: number;
  channelId: string | null;
  privateChat: boolean;
  /** `errand_deadline`: the errand she waits for. */
  errandId?: string;
  /** `attend`: the place and its lines. */
  attend?: AttendInfo;
  /** `feedback`: the current channel of the turn it reports. */
  here?: string | null;
  /** `feedback`: the turn it reports. */
  turnId?: string | null;
  /** `feedback`: the facts it carries, and their ids in the state. */
  facts?: Array<FactPayload>;
  factIds?: Array<string>;
  queuedAt?: number;
  /** A retried wake: the attempt (`error` for the one more try of a one-off), its first failure and its due time. */
  retry?: number | 'error';
  firstFailedAt?: number;
  notBefore?: number;
  lastCode?: string;
  /** The cap that holds the wake. */
  capped?: string;
};

/**
 * A fact as the prompt shows it: its kind and its payload. The fields every kind may carry are named with their types,
 * so a reader of a fact's code or reason gets text; the rest of a kind's payload is read as untrusted.
 */
export type FactPayload = Obj & {
  kind: string;
  code?: string | null;
  why?: string;
  wake?: string;
  status?: string;
  text?: string;
  intentionId?: string | null;
  purpose?: string;
};

/** A fact as the state keeps it: the payload, its id, where it may be shown, when it happened and when she was told. */
export type Fact = FactPayload & {
  id: string;
  channelId: string | null;
  privateChat: boolean;
  at: number;
  told: false | number;
};

/** What a caller hands in to keep a fact: its kind, its payload and where it may be shown. */
export type FactInput = Obj & { kind: string; channelId?: unknown; privateChat?: unknown; at?: unknown };

/** Where a fact may be shown: the conversation, whether it is a private chat, and whether any server place will do. */
export type FactScope = { channelId?: unknown; privateChat?: boolean; anywhere?: boolean };

/** The facts of the turns that are not inner turns, kept in the inner life's state (or in process). */
export type FactsApi = {
  enabled: () => boolean;
  add: (guildId: string | null | undefined, fact: FactInput) => Fact | null;
  pending: (guildId: string | null | undefined, scope?: FactScope) => Array<Fact>;
  markTold: (guildId: string | null | undefined, ids: unknown) => void;
};

/** What a handled wake leaves in the state: when, how it ended and, for an attend wake, its place. */
export type Handled = { at: number; outcome: string; place?: string | null };

/** The day's review as the state keeps it. */
export type Review = { day: string; at: number | null; done: boolean; channels: Array<string>; lines: number };

/** One inner turn that ran, as the state keeps it for the day's counts. */
export type TurnRecord = {
  at: number;
  chainId: string;
  usd: number;
  outcome: unknown;
  kinds: Array<string>;
  code?: string;
  failed?: true;
};

/** The mark of a turn in flight: what a restart finds when the process died in it. */
export type Inflight = {
  turnId: string;
  wakeIds: Array<string>;
  kind: string;
  startedAt: number;
  channelId: string | null;
  privateChat: boolean;
  privateUserId: string | null;
};

/** The state of one guild's inner life (`data/guilds/<id>/inner.json`). */
export type InnerState = {
  v: number;
  stopped: boolean;
  stoppedAt: number | null;
  stoppedBy: string | null;
  queue: Array<Wake>;
  handled: Record<string, Handled>;
  review: Review | null;
  heartbeat: { nextAt: number | null; lastAt: number | null } | null;
  turns: Array<TurnRecord>;
  spend: Array<{ at: number; usd: number }>;
  turnIds: Array<string>;
  facts: Array<Fact>;
  inflight: Inflight | null;
};

/** The `innerLife` section with every number checked (innerSettings). */
export type InnerSettings = {
  mode: 'live' | 'shadow';
  tickSeconds: number;
  queueMax: number;
  chatMessages: number;
  review: { enabled: boolean; historyDays: number; expiredMax: number };
  heartbeat: {
    enabled: boolean;
    everyMinutes: number;
    jitterMinutes: number;
    dueJitterMinutes: number;
    people: number;
    filteredShown: number;
    closedShown: number;
    historyDays: number;
    placesHours: number;
    placesShown: number;
    placeLines: number;
    maxTokens: number;
    intentionsOnly: boolean;
    maxOpen: number;
    maxRecurring: number;
  };
  caps: { perChain: number };
  attention: {
    settleSeconds: number;
    perDayDefault: number;
    pageSize: number;
    placesInWake: number;
    lookbackHours: number;
  };
  loop: { maxSteps: number; timeBudgetMs: number; maxCallsPerStep: number; callTimeoutMs: number };
  factsKeepDays: number;
  retry: { delaysMinutes: Array<number>; maxHours: number };
};

/** One place of the places view. */
export type PlaceRow = {
  id: string;
  name: string;
  writable: boolean | null;
  lines: number;
  people: number;
  newestAt: number | null;
  attended: boolean;
};

/** One page of the places view: the total, the page, its size, how many more follow and its places. */
export type PlacesPage<TItem = PlaceRow> = {
  total: number;
  page: number;
  pageSize: number;
  more: number;
  items: Array<TItem>;
};

/** One line of a place in the index: its message id, time, author (none for hers) and whether it is hers. */
export type PlaceLine = { id: string; at: number; by: string | null; said: boolean };

/** The index of one guild's places: the lines per place over the lookback window and how far the record was read. */
export type PlaceIndex = {
  scannedTo: number | null;
  places: Map<string, { lines: Array<PlaceLine>; ids: Set<string> }>;
};

/** The record as the inner life reads it: its lines from a time on. */
export type RecordSource = {
  iterate?(guildId: string, query: { from: string }): AsyncIterable<unknown> | Iterable<unknown>;
};

/**
 * The intention service as the inner life calls it (src/intentions/service.ts). Every member is optional and a list is
 * read as untrusted records, so a test's narrower fake of the service fits.
 */
export type InnerIntentions = {
  due?(guildId: string): ReadonlyArray<Due>;
  reconcile?(guildId: string): unknown;
  list?(guildId: string, options: { all: boolean; closed?: boolean }): ReadonlyArray<unknown>;
  advance?(guildId: string, id: string, options: { named: boolean }): unknown;
  attending?(guildId: string): ReadonlyArray<unknown>;
  store?(
    guildId: string
  ): { get?(id: string): Intention | null | undefined; list?(): ReadonlyArray<Intention> } | null | undefined;
  countAttendWake?(guildId: string, id: string): unknown;
  markExpiredShown?(guildId: string, id: string): unknown;
  /** The intention a wake that slept was for: a one-off cancelled with `sleptAt`, a recurring one past its occurrence. */
  sleep?(guildId: string, id: string): unknown;
};

/** The journal as the inner life writes and reads it. */
export type InnerJournal = {
  inner?(guildId: string, fields: Obj): unknown;
  turnOperations?(
    guildId: string,
    query: { turnId: string; days: Array<string>; privateUserId: string | null }
  ): unknown;
  read?(guildId: string, query: { day: string; kind: string; n: number }): unknown;
};

/** The memory store as the inner life reads it: its pause, the profiles and her diary for the heartbeat. */
export type InnerStore = {
  state?: { data?: { paused?: unknown; pausedAt?: unknown } };
  listUserProfiles?(guildId: string): unknown;
  getDiary?(guildId: string): { posts?: unknown } | null | undefined;
};

/** The sources of the heartbeat's facts that are not the stores above (src/behavior/heartbeat-view.ts). */
export type HeartbeatSources = {
  tasks?(guildId: string): unknown;
  skills?(): unknown;
  agents?(): unknown;
  selfId?(): unknown;
  focusPeople?(guildId: string): unknown;
};

/** The facts an inner turn's request carries in `<wake>` (the drain builds them, src/behavior/wake.ts words them). */
export type WakeInfo = {
  kind: string;
  items: Array<WakeItem>;
  facts?: Array<FactPayload>;
  intentions: Array<Intention>;
  notes?: Record<string, string>;
  expired?: { items: Array<{ id: string; purpose: string; at: number }>; more: number };
  now: number;
  timezone: string;
  channels: Array<string>;
  places?: PlacesPage | null;
  budgets: { chain: ChainBudget };
  chainId: string;
  heartbeat?: HeartbeatFacts;
  here: { channel: string; why: string | null } | null;
};

/**
 * The wake as the turn runner reads it (src/behavior/turn.js, `params.inner.wake`): every field it reads has a fallback,
 * so every field is optional; the drain's WakeInfo is one of these.
 */
export type TurnWake = WakeBlockInput & { kind?: string; chainId?: string };

/** One wake of an inner turn as `<wake>` shows it. */
export type WakeItem = {
  kind: string;
  reason: string;
  intentionIds: Array<string>;
  errandId: string | null;
  attend?: AttendInfo & { placeName: string; peopleNames: Array<unknown> };
  delayed?: { minutes: number; code: string };
  facts?: Array<FactPayload>;
  turnId?: string | null;
};

/** How many turns a chain had on the local day and how many are left under its cap. */
export type ChainBudget = { used: number; cap: number; left: number };

/** What the drain asks the turn runner for: the conversation of the turn (a stand-in for the heartbeat with no interface). */
export type InnerTurnParams = {
  conversation?: ConversationRef;
  /** The heartbeat's stand-in when no interface is connected, and its history (none). */
  standIn?: ConversationInfo;
  reuseHistory?: Array<never>;
  guildId: string;
  mode: 'inner';
  triggerKind: 'inner';
  journalTurn: { turnId: string; attemptId: number };
  inner: { wake: WakeInfo; currentChannel: string | null; shadow: boolean; mayAct: () => boolean };
};

/** The turn runner as the inner life calls it. */
export type InnerTurns = {
  runTurn(params: InnerTurnParams): Promise<unknown>;
  isAnyBusy?(): boolean;
  isBusy?(conversationId: string): boolean;
};

/** One call of an inner turn as its result lists it (src/behavior/turn.js#runTurn's `inner.actions`). */
export type TurnAction = Obj & {
  skill?: unknown;
  status?: unknown;
  result?: unknown;
  code?: unknown;
  text?: unknown;
  presented?: unknown;
  state?: unknown;
  intentionId?: unknown;
  target?: unknown;
  createdId?: unknown;
};

/** What a turn costs while it runs: its result, its cost, its requests and those on the core role. */
export type Measured = { result: unknown; usd: number; requests: number; voice: number };

/** The meter of what a turn costs (createCostMeter). */
export type CostMeter = {
  run(fn: () => unknown): Promise<Measured>;
  running?(): { usd: number; peak: number };
};

/** The `inner.wake` event the life hands to the door. */
export type InnerWakeEvent = { kind: 'inner.wake'; at: number; id: string; communityId: string; wake: Wake };

/** One write of a wake run to the memory database (src/memory/db/wakes.js). */
export type WakeUpdate = { kind: 'wake'; op: 'start' | 'actions' | 'finish' } & Obj;

/** What the inner life logs through. */
export type Logger = { info(message: string, fields?: Obj): void; warn(message: string, fields?: Obj): void };

/** The places the interface publishes for a guild. */
export type PlaceEntry = { id: string; name: string; writable: boolean | null };

/** The context every module of the inner life works over: its sources, its clock and its state in process. */
export type InnerContext = {
  hot: { readonly config: unknown };
  dataDir: string;
  turns: InnerTurns;
  intentions: InnerIntentions | null;
  record: RecordSource | null;
  placesOf: ((guildId: string) => unknown) | null;
  nameOf: ((guildId: string, memberId: string) => unknown) | null;
  journal: InnerJournal | null;
  reads: (Pick<Reads, 'conversationInfo'> & { offers?(wire: string): boolean }) | null;
  iface: () => string;
  conversationName: (conversationId: string) => string | null;
  submit: ((event: InnerWakeEvent) => Promise<unknown>) | null;
  store: InnerStore | null;
  getGuildId: () => string | null;
  peopleWaiting: () => boolean;
  ready: () => Promise<unknown>;
  uuid: () => string;
  costs: CostMeter;
  heartbeatSources: HeartbeatSources;
  memoryDb: InnerMemoryDb | null;
  rng: () => number;
  now: () => number;
  log: Logger;
  /** Per guild: the state read from its file. */
  states: Map<string, InnerState>;
  /** Per guild: the place index (the record's lines per place over the lookback window). */
  placeIndexes: Map<string, PlaceIndex>;
  /** The ids of the wakes an inner turn is running for now (a stop leaves them to that turn). */
  running: Set<string>;
  ticking: boolean;
  factSeq: number;
  /** The holder name of this life's leases (one per process start). */
  holder: string;
  /** The database the queue is kept in (src/behavior/inner/wake-store.ts), opened on first use. */
  wakeDb: WakeBackend | null;
  /** The chain the queue's writes go through, in order. */
  writes: Promise<unknown>;
  /** Per guild: whether the queue view was read back from the table. */
  viewLoaded: Set<string>;
  /** Per guild: each queued wake as it was last written, by id. */
  synced: Map<string, Map<string, string>>;
  /** The lease tokens of the wakes this life's turns hold, by wake id. */
  claims: Map<string, number>;
  /** Per guild: the start's recovery, run once. */
  started: Map<string, Promise<void>>;
  /** What she slept through: the downtime and pause intervals, the pause under way, the count per guild. */
  sleep: { windows: Array<readonly [number, number]>; pausedFrom: number | null; slept: Map<string, number> };
};

/** The memory database as the inner life uses it (src/memory/db/service.js): wake runs, the writer, the reads. */
export type InnerMemoryDb = {
  recordWake?(update: WakeUpdate): unknown;
  memoryWrite?(update: WakeQueueUpdate): Promise<unknown>;
  readHandle?(): unknown;
};
