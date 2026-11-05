// The types of the signatures in ./missed.ts: the inputs and results that are too long to read inline.

import type * as nodeFs from 'node:fs/promises';
import type { MemoryDbService } from '../memory/db/service.ts';
import type { Untyped } from '../tools/types.ts';
import type { Reads } from '../interface/reads.ts';
import type { Line } from './lines.ts';
import type { Logger } from '../protocol/serve.ts';

export type AddCandidateArg2 = {
  messageId: string;
  placeId: string;
  iface?: string;
  authorId?: string | null;
  at: number;
  reason: string;
  question?: boolean;
  turnId?: string | null;
};

export type ResolveByTurnArg2 = {
  placeId: string | null;
  triggerId?: string | null;
  triggerAuthorId?: string | null;
  triggerAt?: number | null;
  outcome: string;
  replyTargets?: Array<string>;
  turnId?: string | null;
  at: number;
};

export type SweepPlanResult = {
  expired: Array<Candidate>;
  resolved: Array<{ candidate: Candidate; by: string }>;
  notShown: Array<Candidate>;
  owed: Array<Candidate>;
  check: Array<Candidate>;
};

export type MissedCountsResult = {
  candidates: number;
  owed: number;
  recovered: number;
  byReason: Record<string, number>;
  byVerdict: Record<string, number>;
};

export type BuildCheckRequestInput = {
  prompt: string | undefined;
  labels: Untyped;
  config: Untyped;
  selfName: string;
  history: Array<Untyped>;
  candidates: Array<Untyped>;
  triggerOf?: (id: string) => string | null;
  now: number;
};

export type CreateMissedInput = {
  hot: { config: Untyped; prompts: Untyped };
  store: { state: { data: Untyped } };
  journal?: Untyped;
  llm?: { complete: (...args: Array<Untyped>) => Untyped } | null;
  turns: Untyped;
  reads: Reads;
  partnerOf?: (conversationId: string) => string | null;
  getSelfName?: (placeId: string) => string;
  dataDir: string;
  memoryDb?: Pick<MemoryDbService, 'readHandle' | 'writeUnit'> & Partial<Pick<MemoryDbService, 'namespace'>>;
  fs?: Pick<typeof nodeFs, 'mkdir' | 'writeFile' | 'rename' | 'readFile'>;
  now?: () => number;
  timers?: { set: (fn: () => void, ms: number) => Untyped; clear: (timer: Untyped) => void };
  log?: Logger;
};

export type CreateMissedResult = {
  start: (placeId: string) => Promise<void>;
  noteFact: (fact: Untyped) => void;
  noteNotAddressed: (message: Untyped, iface?: string) => void;
  setPrivateRecovery: (hooks: Untyped) => void;
  onTurnEnd: (end: Untyped) => void;
  noteActivity: (placeId: string, at?: number, iface?: string) => void;
  sweep: (iface: string, placeId: string) => Promise<void>;
  save: () => Promise<void>;
  stop: () => void;
  candidates: () => Array<Candidate>;
};

/** One fact of a missed answer: why the persona did not answer `message`, and what the failure or the replacement was. */
export type NoteFactInput = {
  reason?: string;
  message?: Untyped;
  replacedBy?: Untyped;
  failure?: Untyped;
  turnId?: Untyped;
  /** The interface of the line; the candidate keeps it, so its sweep and its recovery turn run there. */
  iface?: string;
};

/** What the analyzer's check of a list of candidates reads: the channel, its lines and the live config. */
export type ClassifyContext = { channel: Untyped; history: Untyped; config: Untyped };

/** One candidate of the registry: a message the persona may have missed, and where its check stands. */
export type Candidate = {
  messageId: string;
  placeId: string;
  /** The interface the conversation is on (absent only on a candidate stored before it was kept). */
  iface?: string;
  authorId: string | null;
  at: number;
  reason: string;
  question: boolean;
  turnIds: Array<string>;
  state: string;
  attempts: number;
  verdict: string | null;
  checkedAt: number | null;
  updatedAt: number;
  [key: string]: Untyped;
};

/** A line of a channel as the missed-answer registry reads it. */
export type MissedLine = Line;
