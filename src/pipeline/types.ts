// The shapes the message pipeline's topic modules share: a normalized line, a conversation, the live config as far as
// the pipeline reads it, a pending ping, a turn's result and the parts of the core the pipeline calls. Types only:
// createMessageHandler (src/behavior/pipeline.js) wires the modules, and nothing here runs.

import type { PendingPing } from '../behavior/pending.js';
import type { ConversationInfo } from '../protocol/adapter.ts';
import type { TriggerKind } from '../turn/triggers.ts';

export type { TriggerKind };

/** A conversation as the interface describes it (src/protocol/adapter.ts). */
export type Conv = ConversationInfo;

/** A normalized line (src/behavior/line-of.js#lineOf), as the pipeline reads it. */
export type Line = {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorName?: string;
  readonly content?: string;
  readonly ts: number;
  readonly replyToId: string | null;
  readonly mentionedUserIds: Array<string>;
  readonly replyPingUserId?: string | null;
  readonly self?: boolean;
};

/** Why a turn ended (src/behavior/turn.js#TurnOutcome). */
export type TurnOutcome = 'spoke' | 'skip' | 'busy' | 'refused' | 'paused' | 'not-now' | 'error';

/** A rail's limit a refused turn carries, as the limit notice quotes it. */
export type Limit = { key: string; used?: number; cap?: number };

/** A turn's result as the pipeline reads it (src/turn/outcome.ts). */
export type TurnResult =
  { outcome?: TurnOutcome; limit?: Limit | null; dryRun?: boolean; delivered?: boolean; reason?: string } | undefined;

/** A queued call of the pending queue (src/behavior/pending.js#PendingPing), with its conversations and its line. */
export type Ping = Omit<PendingPing, 'channel' | 'trigger' | 'destination'> & {
  channel: Conv;
  trigger: Line;
  destination?: Conv | null;
};

/**
 * The pending queue's list, shared by the modules that read or replace it. src/behavior/pending.js answers a new list
 * each time, so a module writes `list` back instead of holding the array.
 */
export type PendingQueue = { list: Array<Ping> };

/** The live config, as far as the message pipeline reads it. */
export type PipelineConfig = {
  readonly features?: {
    readonly mediaDescriptions?: unknown;
    readonly webLookup?: unknown;
    readonly followUp?: unknown;
    readonly mentions?: unknown;
    readonly replies?: unknown;
    readonly nameTriggers?: unknown;
    readonly seeReactions?: unknown;
    readonly memory?: unknown;
    readonly relationships?: unknown;
    readonly participation?: unknown;
    readonly pauseNotice?: unknown;
    readonly privateMessages?: unknown;
    readonly elsewhere?: unknown;
  };
  readonly media?: {
    readonly prefillPerMessage?: number;
    readonly video?: {
      readonly prefill?: unknown;
      readonly prefillPerMessage?: number;
      readonly sites?: Array<string>;
    };
  };
  readonly web?: {
    readonly links?: { readonly enabled?: unknown; readonly prefill?: unknown; readonly prefillPerUserPerDay?: number };
  };
  readonly memoryDb?: { readonly observeTimeoutMs?: number };
  readonly mention: MentionConfig;
  readonly bot: {
    readonly timezone: string;
    readonly dryRunChannelId?: string | null;
    readonly nameTriggers?: Array<string>;
  };
  readonly context: {
    readonly gapMarkerMinutes: number;
    readonly maxMessageChars: number;
    readonly reactionsPerMessage?: number;
    readonly replyQuoteChars?: number;
  };
  readonly memory?: { readonly aliasHalfLifeDays?: number; readonly mainChannelIds?: unknown };
};

/** The `mention` settings (config.json), as the pipeline reads them. */
export type MentionConfig = {
  readonly followUpContext?: number;
  readonly followUpMinutes?: number;
  readonly followUpNoStreak?: number;
  readonly followUpAliases?: number;
  readonly followUpMaxOutputTokens?: number;
  readonly followUpClassifyReplies?: boolean;
  readonly followUpOverheard?: boolean;
  readonly classifyWhileBusy?: unknown;
  readonly pendingSameChannel?: unknown;
  readonly pendingOverheard?: unknown;
  readonly oneAtATime?: unknown;
  readonly failOpenMinutes?: number;
  readonly maxPending?: number;
  readonly pendingMinutes?: number;
  readonly switchDelayMs?: [number, number];
  readonly neverIgnore: Array<string>;
  readonly repeatWindowMinutes: number;
};

/** The hot config and prompts (src/hot.js#createHot), read at the moment of use. */
export type PipelineHot = {
  readonly config: PipelineConfig;
  readonly prompts?: {
    readonly labels: PipelineLabels;
    readonly address?: string;
    readonly room?: string;
    readonly merge?: string;
  } | null;
};

/** The labels file (prompts/labels.json), as the pipeline hands it on. */
export type PipelineLabels = { readonly address?: { readonly author?: string } } & object;

/** The persisted state (src/memory/store.js), as far as the pipeline reads and writes it. */
export type PipelineState = {
  data?: {
    paused?: unknown;
    followUpWindows?: Record<string, { openedAt: number; lastAnswerAt: number; noStreak: number }>;
    elsewherePings?: unknown;
  };
  markDirty?: () => void;
};

/** A turn as runTurn starts it (src/behavior/turn.js#runTurn), as far as the pipeline fills it in. */
export type TurnRequest = {
  conversation: { iface: string; conversationId: string };
  guildId?: string;
  mode: 'reply';
  trigger: Line;
  triggerKind: TriggerKind;
  queued?: (() => Array<{ id: string; text: string; author?: string }>) | null;
  added?: Ping['added'] | null;
  source?: { channelId: string; reason: 'routed' };
};

/** The turn runner (src/behavior/turn.js#createTurnRunner), as far as the pipeline calls it. */
export type PipelineTurns = {
  isBusy: (channelId: string) => boolean;
  isAnyBusy: () => boolean;
  busyChannels?: () => Array<string>;
  runTurn: (request: TurnRequest) => Promise<TurnResult>;
  notePost: (channelId: string, ts: number) => void;
  spokeAfterSeeing?: (channelId: string, messageId: string) => boolean;
  waitingParts?: (channelId: string, authorId: string) => unknown;
  addToPart?: (channelId: string, authorId: string, index: number, message: object) => unknown;
  lastPostAt?: (channelId: string) => number;
};

/** The model client (src/llm/openrouter.js#createLlm), as the classifiers call it. */
export type PipelineLlm = {
  complete: (
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: object
  ) => Promise<{ text?: unknown } | null | undefined>;
};

/** The missed-answer registry (src/behavior/missed.js#createMissed), as the pipeline notes into it. */
export type PipelineMissed = {
  noteFact: (fact: object) => void;
  noteActivity: (channelId: string, at: number) => void;
  noteNotAddressed?: (message: Line) => void;
};

/** A thrown value as the pipeline logs it: a name, a code and an HTTP status, each when it has one. */
export type Thrown = { name?: string; code?: unknown; statusCode?: number } | null | undefined;
