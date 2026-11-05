// The types of the signatures in ./turn.ts: the inputs and results that are too long to read inline.

import type { Track } from '../loop-watch.ts';
import type { Untyped } from '../tools/types.ts';
import type { createEmojiIndex } from './emoji-index.ts';
import type { scheduleTimer } from '../turn/timers.ts';
import type { Reads } from '../interface/reads.ts';
import type { TurnEnd, TurnParams } from '../turn/outcome.ts';
import type { Draft } from '../turn/draft.ts';
import type { FactsApi } from './inner.ts';
import type { ReportedTurn } from './turn.ts';

export type CreateTurnRunnerInput = {
  /** The event loop watch's `track` (src/loop-watch.ts); the stages of the request phase are named operations. */
  track?: Track;
  // The live config and prompts; a test hands in a stand-in that holds what it reads.
  hot: { config: Untyped; prompts: Untyped };
  store: Untyped;
  llm: { complete: (...args: Array<Untyped>) => Untyped };
  calibrator: {
    ratio: number;
    apply: (n: number) => number;
    observe?: (rawEstimate: number, actualTokens: number) => unknown;
  };
  rng?: () => number;
  describer?: Untyped;
  fetchImpl?: typeof fetch;
  imageFetcher?: Untyped;
  lookup?: Untyped;
  recall?: Untyped;
  images?: Untyped;
  speech?: Untyped;
  emoji?: ReturnType<typeof createEmojiIndex>;
  getSelfName?: (guildId: string | null) => string;
  selfId?: () => string;
  reads: Reads;
  memberOf?: Untyped;
  membersOf?: Untyped;
  conversationName?: Untyped;
  routeChannels?: Untyped;
  now?: () => number;
  schedule?: typeof scheduleTimer;
  activity?: Untyped;
  journal?: Untyped;
  record?: Untyped;
  port: Untyped;
  skills?: Untyped;
  skillIndex?: Untyped;
  recordSkillUses?: Untyped;
  runOp?: Untyped;
  runOwnOp?: Untyped;
  runInitiativeOp?: Untyped;
  around?: Untyped;
  reactors?: Untyped;
  errands?: Untyped;
  mirrors?: Untyped;
  intentions?: Untyped;
  places?: Untyped;
  memoryReads?: Untyped;
  memoryContext?: Untyped;
  attention?: Set<string>;
  roleHealth?: Untyped;
};

/** What `createTurnRunner` returns: the turn runner the pipeline, the inner life and the core drive. */
export type TurnRunner = {
  runTurn: (params: TurnParams) => Promise<ReportedTurn>;
  seedTriggerLinks: (pairs: unknown) => void;
  seedCallMarks: (marks: { calls?: unknown; postedFrom?: unknown } | null | undefined) => void;
  waitingParts: (channelId: unknown, authorId: unknown) => Array<{ index: number; text: string }>;
  addToPart: (
    channelId: unknown,
    authorId: unknown,
    index: unknown,
    message: { id: string; text: string; ts: number }
  ) => boolean;
  isBusy: (channelId: string) => boolean;
  isAnyBusy: () => boolean;
  busyChannels: () => Array<string>;
  lastPostAt: (channelId: string) => number;
  notePost: (channelId: string, ts: number) => void;
  spokeAfterSeeing: (channelId: string, messageId: string) => boolean;
  waitIdle: () => Promise<void>;
  setOnIdle: (fn: (() => unknown) | null) => void;
  setFactsSource: (source: FactsApi | null | undefined) => void;
  setOnTurnEnd: (fn: ((end: TurnEnd) => unknown) | null) => void;
  triggerOf: (postedId: string) => string | null;
};

/** The params of an attempt as runTurn tracks them: the attempts its turn record closes and the facts its end reads. */
export type TrackedParams = TurnParams & {
  journalAttempts?: Array<{ draft: Draft; result: { outcome: string } }>;
  turnEnds?: {
    replyTargets: Array<string>;
    reasons: Array<string>;
    factsShown: Array<string> | null;
    info: Draft['info'] | null;
  };
};
