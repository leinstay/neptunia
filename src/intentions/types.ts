// The shapes the intention modules share: the record the store keeps, the answers of the model's moves, the store, the
// service and the notes of where a line came from. Types only, nothing runs here. src/intentions/*.ts, the intention
// operations (src/tools/operations/intention.ts) and the scheduler's JavaScript read them.

import type { PublicationBoundary } from '../tools/publication.ts';
import type { Untyped } from '../tools/types.ts';
import type { ErrandRecord, ErrandScope, FlushCounts, Logger } from '../errands/types.ts';

/** Every status an intention may have. */
export type IntentionStatus = 'pending' | 'waiting' | 'done' | 'cancelled' | 'expired' | 'dropped';

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

/** The `wakes.attention` numbers an attention is born with. */
export type AttentionSettings = { settleSeconds: number; perDayDefault: number };

/** The numbers of the `intentions` config section. */
export type IntentionSettings = {
  expiresDays: number;
  recurringExpiresDays: number;
  maxOpen: number;
  waitHours: number;
  expiryNoticeDays: number;
};

/** Where an intention came from. */
export type Provenance = {
  /** `candidate` only on a closed record of a path that is gone, kept out of what she is shown as hers. */
  kind: 'self' | 'candidate';
  turnId: string | null;
  messageId?: string;
  placeId?: string;
  span?: string;
  scope: ErrandScope;
  participants?: Array<string>;
  publicationBoundary?: PublicationBoundary;
  /** The key of the call that set it: a restarted turn's same call answers with this record. */
  callKey?: string;
};

/** One move in a record's history. */
export type HistoryEntry = { at: number; from?: string; to: string; by: string; code?: string };

/** How a wait ended: the errand, its state and its error code. */
export type WaitOutcome = { errandId: string; state: string; error?: string; at: number };

/** An intention as the store keeps it. */
export type Intention = {
  /** A recurring task that lasts until it is cancelled. */
  standing?: boolean;
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
    kind: 'self';
    turnId?: string | null;
    messageId?: string | null;
    placeId?: string | null;
    span?: string | null;
    scope?: ErrandScope;
    participants?: Array<string>;
    publicationBoundary?: PublicationBoundary;
    callKey?: string;
  };
  dueAt?: number | null;
  every?: Every | null;
  expiresAt?: number | null;
  /** A recurring task that lasts until it is cancelled. */
  standing?: boolean;
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

/** Why an intention is due. */
export type Due = { intention: Intention; reason: 'due' | 'wait-deadline'; at: number };

/** The intentions of one place, in the memory database (src/intentions/store.ts#createIntentionStore). */
export type IntentionStore = {
  list: () => Array<Intention>;
  get: (id: unknown) => Intention | null;
  add: (record: Intention) => Created;
  update: (id: unknown, move: (record: Intention) => Moved) => Moved;
  archived: () => Array<Intention>;
  flush: (options?: { final?: boolean; timeoutMs?: number }) => Promise<FlushCounts>;
};

/** One store per place. */
export type IntentionStores = {
  get: () => IntentionStore | null;
  flush: (options?: { final?: boolean; timeoutMs?: number }) => Promise<FlushCounts>;
};

/** What her `intention.set` (or an owner's command, or the engine) hands the service. */
export type SetInput = {
  /** The call's key: a second `set` under it answers with the record the first one made. */
  callKey?: string | null;
  /** A recurring task that lasts until it is cancelled. */
  standing?: boolean;
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
  placeId?: string | null;
  scope?: ErrandScope;
  participants?: Array<string>;
  publicationBoundary?: PublicationBoundary;
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
  dmChatId?: string | null;
  all?: boolean;
};

/** Who may see a record: where the caller is. */
export type Where = { dmChatId?: string | null; all?: boolean };

/** The counts of a reconciliation. */
export type ReconcileCounts = { arrived: number; missing: number; deadline: number; expired: number };

/** The intentions at work (src/intentions/service.ts#createIntentionService). */
export type IntentionService = {
  set: (input: SetInput) => Created | { ok: false; code: string; open?: Array<Intention> };
  update: (id: unknown, patch?: UpdatePatch) => Moved;
  cancel: (id: unknown, options?: { by?: string } & Where) => Moved;
  list: (options?: { closed?: boolean } & Where) => Array<Intention>;
  view: (options?: { dmChatId?: string | null }) => Array<Intention>;
  linkTurnErrand: (link: { turnId: unknown; errandId: unknown }) => number;
  onErrandFinished: (errand: ErrandRecord) => number;
  reconcile: () => ReconcileCounts;
  advance: (id: unknown, options?: { named?: boolean; by?: string }) => Advanced;
  sleep: (id: unknown) => Moved;
  due: () => Array<Due>;
  attending: () => Array<Intention>;
  attendToday: (id: unknown) => { day: string; wakes: number } | null;
  countAttendWake: (id: unknown) => Moved;
  store: () => IntentionStore | null;
};

/** What `createIntentionService` is given. `errands` is the errand service a wait is checked against. */
/** The part of an errand a wait reads: its id, state, end, error and the turn that queued it. */
export type ErrandLike = {
  id: string;
  state: string;
  endedAt?: number | null;
  error?: string | null;
  origin?: { turnId?: string | null };
};

/** The errand service as the intentions use it: the store of a place, to get an errand and to list the latest. */
export type ErrandsPort = {
  store?: () => { get: (id: string) => ErrandLike | null; recent?: (n: number) => Array<ErrandLike> } | null;
};

export type IntentionServiceOptions = {
  stores: IntentionStores;
  hot: Untyped;
  errands?: ErrandsPort | null;

  now?: () => number;
  uuid?: () => string;
  log?: Logger;
};
