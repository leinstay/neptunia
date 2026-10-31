// The shapes the intention modules share: the record the store keeps, the answers of the model's moves, the store, the
// service and the notes of where a line came from. Types only, nothing runs here. src/intentions/*.ts, the intention
// operations (src/tools/impl/intention.ts) and the scheduler's JavaScript read them.

import type { Untyped } from '../tools/types.ts';
import type { ErrandRecord, ErrandScope, FlushCounts, Logger } from '../errands/types.ts';

/** Every status an intention may have. */
export type IntentionStatus = 'proposed' | 'pending' | 'waiting' | 'done' | 'cancelled' | 'expired' | 'dropped';

/** A recurrence: `period` is `day`, `week`, `<n>h` or `<n>d`, `at` the pinned wall clock `HH:MM` of `day` and `week`. */
export type Every = { period: string; at: string | null };

/** An attention: the place's address, the people whose lines count, the quiet seconds, the daily bound and its counter. */
export type Attend = {
  place: string;
  people: Array<string>;
  settle: number;
  perDay: number;
  today: { day: string; wakes: number } | null;
};

/** What `createIntention` takes of an attention, before the defaults fill it. */
export type AttendInput = {
  place: string;
  people?: Array<string | number>;
  settle?: number;
  perDay?: number;
  today?: { day: string; wakes: number } | null;
};

/** The `innerLife.attention` numbers an attention is born with. */
export type AttentionSettings = { settleSeconds: number; perDayDefault: number };

/** The numbers of the `intentions` config section. */
export type IntentionSettings = {
  expiresDays: number;
  recurringExpiresDays: number;
  maxOpen: number;
  maxCandidates: number;
  candidateExpiresHours: number;
  waitHours: number;
  expiryNoticeDays: number;
};

/** Where an intention came from. */
export type Provenance = {
  kind: 'self' | 'candidate';
  turnId: string | null;
  messageId?: string;
  channelId?: string;
  span?: string;
  scope: ErrandScope;
  participants?: Array<string>;
  /** A candidate's origin: `external` when its words came from outside material. */
  origin?: 'own' | 'external';
  originReason?: string;
  bornInner?: boolean;
  innerChainId?: string;
};

/** One move in a record's history. */
export type HistoryEntry = { at: number; from?: string; to: string; by: string; code?: string };

/** How a wait ended: the errand, its state and its error code. */
export type WaitOutcome = { errandId: string; state: string; error?: string; at: number };

/** An intention as the store keeps it. */
export type Intention = {
  id: string;
  purpose: string;
  provenance: Provenance;
  status: IntentionStatus;
  createdAt: number;
  updatedAt: number;
  dueAt: number | null;
  every: Every | null;
  expiresAt: number;
  awaitingErrandId: string | null;
  waitDeadline: number | null;
  destination: string | null;
  completionCondition: string | null;
  chainId: string | null;
  attend: Attend | null;
  /** `heartbeat` when the engine made it for a heartbeat turn. */
  origin?: 'heartbeat';
  history: Array<HistoryEntry>;
  reason?: string;
  droppedAt?: number;
  lastErrandId?: string | null;
  waitRequested?: { turnId: string; deadline: number } | null;
  note?: string | null;
  outcome?: WaitOutcome | null;
  expiredShownAt?: number;
  /** When the engine cancelled it because its wake fell due while she was asleep (src/intentions/model.ts#sleepIntention). */
  sleptAt?: number;
};

/** A new record, or the code of the invariant it would break. */
export type Created =
  { ok: true; intention: Intention; code?: undefined } | { ok: false; code: string; intention?: undefined };

/** A move of a record: the new record (`changed` says whether it differs), or the refusal. `open` names the records
 * a heartbeat cap counted. */
export type Moved =
  | { ok: true; intention: Intention; changed: boolean; code?: undefined; open?: undefined }
  | { ok: false; code: string; open?: Array<Intention>; intention?: undefined; changed?: undefined };

/** What `advance` answers: a move, or the record unchanged (null for a record that is not there). */
export type Advanced =
  | { ok: true; intention: Intention | null; changed: boolean; code?: undefined }
  | { ok: false; code: string; intention?: undefined; changed?: undefined };

/** What `createIntention` takes. */
export type CreateInput = {
  purpose: string;
  provenance: {
    kind: 'self' | 'candidate';
    turnId?: string | null;
    messageId?: string | null;
    channelId?: string | null;
    span?: string | null;
    scope?: ErrandScope;
    participants?: Array<string>;
    origin?: string;
    originReason?: string;
    bornInner?: boolean;
    innerChainId?: string | null;
  };
  dueAt?: number | null;
  every?: Every | null;
  expiresAt?: number | null;
  destination?: string | null;
  completionCondition?: string | null;
  chainId?: string | null;
  attend?: AttendInput | null;
  origin?: string | null;
  dropped?: boolean;
  reason?: string | null;
  now: number;
  settings?: IntentionSettings & { attention?: Partial<AttentionSettings> };
  id?: string;
  by?: string;
};

/** A candidate the analyzer proposed from one of her own lines, anchored to that line. */
export type Candidate = {
  purpose: string;
  span: string;
  messageId: string;
  channelId: string | null;
  ts: number | null;
  participants?: Array<string>;
  origin: 'own' | 'external';
  originReason?: string;
  turnId: string | null;
  bornInner?: boolean;
  innerChainId?: string;
};

/** Why an intention is due. */
export type Due = { intention: Intention; reason: 'due' | 'wait-deadline'; at: number };

/** The note of where one line of hers came from (src/intentions/sources.ts#lineSourcesOf). */
export type LineNote = {
  turnId: string | null;
  read?: boolean;
  inner?: boolean;
  chainId?: string;
  overlap?: Array<string>;
};

/** The notes of her recent lines by message id (src/intentions/sources.ts#createLineSources). */
export type LineSources = {
  note: (messageId: string, sources: LineNote) => void;
  get: (messageId: string) => LineNote | null;
  readonly size: number;
};

/** The intentions of one guild, in the memory database (src/intentions/store.ts#createIntentionStore). */
export type IntentionStore = {
  list: () => Array<Intention>;
  get: (id: unknown) => Intention | null;
  add: (record: Intention) => Created;
  update: (id: unknown, move: (record: Intention) => Moved) => Moved;
  archived: () => Array<Intention>;
  flush: (options?: { final?: boolean }) => Promise<FlushCounts>;
  guildId: string;
};

/** One store per guild. */
export type IntentionStores = {
  get: (guildId: unknown) => IntentionStore | null;
  flush: (options?: { final?: boolean }) => Promise<FlushCounts>;
};

/** What her `intention.set` (or an owner's command, or the engine) hands the service. */
export type SetInput = {
  purpose: string;
  /** `dropped` records a desire she considered and let go; it needs a `reason`. */
  state?: string;
  reason?: string | null;
  dueAt?: number | null;
  every?: Every | null;
  expiresAt?: number | null;
  destination?: string | null;
  completionCondition?: string | null;
  chainId?: string | null;
  errandId?: string | null;
  deadline?: number | null;
  turnId?: string | null;
  messageId?: string | null;
  channelId?: string | null;
  scope?: ErrandScope;
  participants?: Array<string>;
  by?: string;
  origin?: string | null;
  attend?: AttendInput | null;
};

/** What `intention.update` hands the service. */
export type UpdatePatch = {
  purpose?: string;
  dueAt?: number | null;
  every?: Every | null;
  expiresAt?: number | null;
  destination?: string | null;
  completionCondition?: string | null;
  chainId?: string | null;
  attend?: { people?: Array<string>; settle?: number; perDay?: number } | null;
  state?: string;
  reason?: string | null;
  errandId?: string | null;
  deadline?: number | null;
  turnId?: string | null;
  by?: string;
  /** Where the caller is: a private chat's own intentions only there, or every one with `all`. */
  privateChannelId?: string | null;
  all?: boolean;
  /** An inner turn's call and its chain: which candidates it may accept. */
  initiative?: boolean;
  callerChain?: string | null;
};

/** Who may see a record: where the caller is. */
export type Where = { privateChannelId?: string | null; all?: boolean };

/** What one analyzer batch added. */
export type CandidateCounts = {
  added: number;
  external: number;
  duplicate: number;
  capped: number;
  dropped: { invalid: number; unanchored: number; quoted: number; over: number };
};

/** The counts of a reconciliation. */
export type ReconcileCounts = { arrived: number; missing: number; deadline: number; expired: number };

/** The intentions at work (src/intentions/service.ts#createIntentionService). */
export type IntentionService = {
  set: (guildId: unknown, input: SetInput) => Created | { ok: false; code: string; open?: Array<Intention> };
  update: (guildId: unknown, id: unknown, patch?: UpdatePatch) => Moved;
  cancel: (guildId: unknown, id: unknown, options?: { by?: string } & Where) => Moved;
  list: (guildId: unknown, options?: { closed?: boolean } & Where) => Array<Intention>;
  view: (guildId: unknown, options?: { privateChannelId?: string | null }) => Array<Intention>;
  noteLine: (messageId: unknown, sources: LineNote) => void;
  lineSources: (messageId: unknown) => LineNote | null;
  linkTurnErrand: (guildId: unknown, link: { turnId: unknown; errandId: unknown }) => number;
  onErrandFinished: (errand: ErrandRecord, guildId: unknown) => number;
  reconcile: (guildId: unknown) => ReconcileCounts;
  advance: (guildId: unknown, id: unknown, options?: { named?: boolean; by?: string }) => Advanced;
  sleep: (guildId: unknown, id: unknown) => Moved;
  due: (guildId: unknown) => Array<Due>;
  attending: (guildId: unknown) => Array<Intention>;
  attendToday: (guildId: unknown, id: unknown) => { day: string; wakes: number } | null;
  countAttendWake: (guildId: unknown, id: unknown) => Moved;
  markExpiredShown: (guildId: unknown, id: unknown) => Moved;
  addCandidates: (guildId: unknown, raw: unknown, messages: Array<Untyped>) => Promise<CandidateCounts>;
  store: (guildId?: unknown) => IntentionStore | null;
};

/** What `createIntentionService` is given. `errands` is the errand service a wait is checked against, `journal` is where a
 * candidate's turn is looked up, `lineSources` holds the notes of where her lines came from. */
/** The part of an errand a wait reads: its id, state, end, error and the turn that queued it. */
export type ErrandLike = {
  id: string;
  state: string;
  endedAt?: number | null;
  error?: string | null;
  origin?: { turnId?: string | null };
};

/** The errand service as the intentions use it: the store of a guild, to get an errand and to list the latest. */
export type ErrandsPort = {
  store?: (
    guildId?: unknown
  ) => { get: (id: string) => ErrandLike | null; recent?: (n: number) => Array<ErrandLike> } | null;
};

export type IntentionServiceOptions = {
  stores: IntentionStores;
  hot: Untyped;
  errands?: ErrandsPort | null;
  journal?: Untyped;
  lineSources?: LineSources | null;
  getGuildId?: () => string | null;
  now?: () => number;
  uuid?: () => string;
  log?: Logger;
};
