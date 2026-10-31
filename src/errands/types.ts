// The shapes the errand modules share: the record the store keeps, what the store, the service, the client and the ledger
// mirror answer, and the small value types between them. Types only, nothing runs here. src/errands/*.ts, the errand
// operations (src/tools/impl/errand.ts) and the intention service (src/intentions/) import them.

import type net from 'node:net';
import type { Untyped } from '../tools/types.ts';

/** A logger of a module that reports errors too. */
export type ErrorLogger = Logger & { error: (message: string, meta?: Untyped) => unknown };

/** The logger every errand module takes: `module: event` messages with ids, counts and codes as meta, never text. */
export type Logger = {
  info: (message: string, meta?: Untyped) => unknown;
  warn: (message: string, meta?: Untyped) => unknown;
  error?: (message: string, meta?: Untyped) => unknown;
};

/** Every state an errand may be in. */
export type ErrandState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
/** Where an errand was asked: a private chat (`dm`) or anywhere else (`group`). */
export type ErrandScope = 'dm' | 'group';
/** Who asked for an errand. */
export type RequesterKind = 'owner' | 'member' | 'persona';

export type ErrandRequester = { userId: string | null; kind: RequesterKind };
export type ErrandOrigin = { channelId: string | null; messageId: string | null; turnId?: string };

/** One output file of a finished errand, as the runner lists it. */
export type ErrandFile = { path?: string; name: string; contentType: string; bytes: number };

/** A result as the runner's protocol shapes it (src/agent-runner/protocol.js#normalizeResult). */
export type NormalizedResult = {
  text: string;
  sources: Array<string>;
  files: Array<ErrandFile>;
  withheld?: Array<string>;
  filesDropped?: Array<{ name: string; reason: string }>;
};

/** A result as the store keeps it: the runner's, with the dropped files reduced to their names. */
export type ErrandResult = {
  text: string;
  sources: Array<string>;
  files: Array<ErrandFile>;
  withheld?: Array<string>;
  filesDropped?: Array<string | { name: string }>;
};

/** A usage as the runner's protocol shapes it (src/agent-runner/protocol.js#normalizeUsage). */
export type ErrandUsage = {
  input: number;
  output: number;
  usd: number;
  steps: number;
  seconds: number;
  costUnknown?: number;
};

/** The limits an errand runs under. */
export type Limits = { steps?: number; seconds?: number };

/** An errand as the store keeps it (a task of the board's errand lane holds one, src/board/archive.ts). */
export type ErrandRecord = {
  id: string;
  agent: string;
  goal: string;
  requester: ErrandRequester;
  origin: ErrandOrigin;
  idempotencyKey?: string;
  scope: ErrandScope;
  state: ErrandState;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  usage: ErrandUsage | null;
  result: ErrandResult | null;
  error: string | null;
  seen: boolean;
  readAt: number | null;
  resolvedAt: number | null;
  opId: string;
  ledgerId?: string;
  filesExpired?: boolean;
  resultTurnFailed?: boolean;
};

/** One window's spend counters. */
export type CostRow = { runs: number; input: number; output: number; usd: number };
/** The windows of an agent's spend. */
export type CostWindows = { today: CostRow; last7: CostRow; last30: CostRow };
/** The spend of every agent with a record, by agent. */
export type AgentCosts = Record<string, CostWindows>;

/** The part of a record the spend needs (src/errands/costs.ts#costRecord). */
export type CostRecord = {
  id: string;
  agent: string;
  createdAt: number | null;
  endedAt: number | null;
  usage: { input: number; output: number; usd: number } | null;
};

/** What a caller hands the store to queue an errand. */
export type AddInput = {
  agent: string;
  goal: string;
  requester: { userId?: string | null; kind?: string };
  origin: { channelId?: string | null; messageId?: string | null; turnId?: string | null };
  scope: ErrandScope;
  idempotencyKey?: string | null;
};

/** `add` and `submit` answer a queued errand, an errand already held under the key (`duplicate`), or a refusal. */
export type AddResult =
  | { ok: true; errand: ErrandRecord; duplicate?: true; code?: undefined }
  | { ok: false; code: string; errand?: undefined; duplicate?: undefined };

/** The runner's outcome of one run, as the store finishes an errand with it. */
export type FinishOutcome = {
  status?: string;
  result?: unknown;
  usage?: unknown;
  error?: string;
};

/** The file a handle names, with the errand it belongs to. */
export type ErrandFileRef = {
  path: string;
  name: string;
  contentType: string;
  bytes: number;
  errand: ErrandRecord;
};
/** The marker for a handle whose files the runner has deleted (`file-expired`). */
export type ExpiredFileRef = { expired: true; errand: ErrandRecord };

/** What the store's `budget` says to the skills gateway. */
export type Budget = { spent: boolean; key: string | null; code: string | null };

/** One end committed on the board whose `errand.done` has not been marked delivered. */
export type ErrandEnd = { eventId: string; errandId: string; state: ErrandState };

/** The writes still waiting for the memory database, and the ones kept in `memory-pending/`. */
export type FlushCounts = { waiting: number; pending: number };

/** The errands of one guild, on the memory database's task board (src/errands/store.ts#createErrandStore). */
export type ErrandStore = {
  add: (input: AddInput) => AddResult;
  start: (id: unknown) => ErrandRecord | null;
  finish: (id: unknown, outcome?: FinishOutcome) => ErrandRecord | null;
  cancel: (id: unknown) => ErrandRecord | null;
  markSeen: (id: unknown) => ErrandRecord | null;
  markRead: (id: unknown) => ErrandRecord | null;
  markResultFailed: (id: unknown) => ErrandRecord | null;
  resolve: (id: unknown) => ErrandRecord | null;
  setLedgerId: (id: unknown, ledgerId: unknown) => ErrandRecord | null;
  open: () => Array<ErrandRecord>;
  recent: (n?: number) => Array<ErrandRecord>;
  unseen: () => Array<ErrandRecord>;
  unread: () => Array<ErrandRecord>;
  get: (id: unknown) => ErrandRecord | null;
  budget: (agent: string) => Budget;
  today: (agent: string) => { tasks: number; usd: number; caps: { tasks: number | undefined } };
  costs: (agents?: Array<string>) => AgentCosts;
  fileOf: (handle: unknown) => ErrandFileRef | null;
  fileExpired: (handle: unknown) => boolean;
  failOpen: (code: string) => number;
  expireFiles: () => number;
  /** The ends committed on the board and not marked delivered, oldest first; `eventId` is `errand-done:<errand id>`. */
  pendingEnds: () => Array<ErrandEnd>;
  /** Marks the pending end of errand `id` delivered; false when no end of that errand is pending. */
  markDelivered: (id: unknown) => boolean;
  flush: (options?: { final?: boolean }) => Promise<FlushCounts>;
  guildId: string;
};

/** One store per guild. */
export type ErrandStores = {
  get: (guildId: unknown) => ErrandStore | null;
  flush: (options?: { final?: boolean }) => Promise<FlushCounts>;
};

/** The ledger's reading of the development agents' spend (src/errands/ledger.ts#agentCostsOf). */
export type LedgerCosts = {
  thinker: CostWindows & { last_wave: LastWave | null };
  dev: CostWindows;
};
export type LastWave = {
  wave: unknown;
  turns: number;
  usd: number;
  context_mean: number | null;
  context_peak: number | null;
};

/** What `add` of the ledger mirror is given: the guild, the limits for the triage, and who keeps the ledger's id. */
export type LedgerAddOptions = {
  guildId?: string;
  limits?: Limits;
  onLedgerId?: ((ledgerId: string) => void) | null;
};
/** What `mirrorOpen` is given: as `add`, with the limits and the id handler per errand. */
export type MirrorOpenOptions = {
  guildId?: string;
  limitsOf?: ((errand: ErrandRecord) => Limits) | null;
  onLedgerId?: ((errand: ErrandRecord, ledgerId: string) => void) | null;
};

/** The mirror of the errands into the ledger (src/errands/ledger.ts#createLedgerMirror). */
export type LedgerMirror = {
  enabled: () => boolean;
  add: (errand: ErrandRecord, options?: LedgerAddOptions) => boolean;
  start: (errand: ErrandRecord, options?: { limits?: Limits; model?: string | null }) => boolean;
  progress: (errand: ErrandRecord) => boolean;
  finish: (errand: ErrandRecord, options?: { maxChars?: number }) => boolean;
  cancel: (errand: ErrandRecord, options?: { by?: string }) => boolean;
  mirrorOpen: (errands: Array<ErrandRecord>, options: MirrorOpenOptions) => number;
  costs: (options?: { now?: number }) => Promise<LedgerCosts | null>;
  idle: () => Promise<void>;
  close: () => void;
  queued: () => number;
};

/** What the service hands the client to run one errand. */
export type RunContext = {
  scope: ErrandScope;
  channel: string | null;
  asker: string | null;
  recent: Array<{ author: string; text: string }>;
};
export type RunSecrets = { openrouterKey: string; proxy?: string; searchKey?: string };
export type RunRequest = {
  agent: string;
  id: string;
  goal: string;
  context?: Partial<RunContext>;
  limits?: Limits;
  secrets?: RunSecrets | null;
};

/** The shape `run` resolves. */
export type RunOutcome = {
  status: 'done' | 'failed' | 'cancelled';
  result: NormalizedResult;
  usage: ErrandUsage;
  error?: string;
};

export type PingAnswer =
  | { ok: true; profile: string; busy: boolean; queued: number; error?: undefined }
  | { ok: false; error: string; profile?: undefined; busy?: undefined; queued?: undefined };
export type ProgressEvent = { agent: string; id: string; step: number; tool: string | null; note: string };
export type LinkEvent = { agent: string; up: boolean; code?: string };

/** The core's side of the errand agents' sockets (src/errands/client.ts#createErrandClient). */
export type ErrandClient = {
  run: (request: RunRequest) => Promise<RunOutcome>;
  cancel: (request: { agent: string; id: string }) => boolean;
  ping: (agent: string) => Promise<PingAnswer>;
  onProgress: (fn: (event: ProgressEvent) => void) => () => void;
  onLink: (fn: (event: LinkEvent) => void) => () => void;
  configured: (agent: string) => boolean;
  close: () => void;
};

/** What a caller of the service asks for. */
export type SubmitInput = AddInput & { guildId?: string | null };
export type CancelResult =
  { ok: true; errand: ErrandRecord | null; code?: undefined } | { ok: false; code: string; errand?: ErrandRecord };
export type IdsInput = { guildId?: string | null; ids?: ReadonlyArray<string> };

/** The errands in the background (src/errands/service.ts#createErrandService). */
export type ErrandService = {
  submit: (input: SubmitInput) => AddResult;
  cancel: (input: { guildId?: string | null; id: string; by?: string }) => CancelResult;
  budget: (input?: { guildId?: string | null; agent?: string }) => Budget | null;
  view: (input?: { guildId?: string | null; privateChannelId?: string | null }) => Array<ErrandRecord>;
  fileOf: (input?: {
    guildId?: string | null;
    handle?: unknown;
    privateChannelId?: string | null;
  }) => ErrandFileRef | ExpiredFileRef | null;
  markSeen: (input?: IdsInput) => number;
  markRead: (input?: IdsInput) => number;
  markResultFailed: (input?: IdsInput) => number;
  start: (guildId: unknown) => number;
  idle: () => Promise<void>;
  check: (agent: string) => Promise<boolean | null>;
  runnerUp: (agent: string) => boolean | null;
  store: (guildId?: unknown) => ErrandStore | null;
  limitsOf: (agent: string) => Limits;
  ledger: LedgerMirror;
};

/** What a timer function hands back (a Node timer; tests inject their own). */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** What `createErrandClient` is given. `hot` holds the live config and prompts; `connect` opens a socket. */
export type ErrandClientOptions = {
  hot?: Untyped;
  log?: Logger;
  connect?: (path: string) => net.Socket;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle | null) => void;
};

/** What `createLedgerMirror` is given. `socketPath` is the ledger socket or a function read at the moment of use. */
export type LedgerOptions = {
  socketPath?: string | null | (() => string | null);
  log?: Logger;
  now?: () => number;
  connect?: (path: string) => net.Socket;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  replyTimeoutMs?: number;
  costsTimeoutMs?: number;
};

/** What `createErrandService` is given. */
export type ErrandServiceOptions = {
  client: Partial<ErrandClient>;
  stores: ErrandStores;
  hot: Untyped;
  env?: Record<string, string | undefined>;
  memory?: {
    recentLines: (guildId: string, channelId: string, count: number) => Array<{ author?: unknown; text?: unknown }>;
  } | null;
  getGuildId?: () => string | null;
  onFinished?: ((errand: ErrandRecord, guildId: string) => unknown) | null;
  log?: Logger;
  defer?: (fn: () => unknown) => unknown;
  ledger?: LedgerMirror | null;
  now?: () => number;
};
