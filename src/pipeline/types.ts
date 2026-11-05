// The shapes the message pipeline's topic modules share: a normalized line, a conversation, the live config as far as
// the pipeline reads it, a pending ping, a turn's result and the parts of the core the pipeline calls. Types only:
// createMessageHandler (src/behavior/pipeline.ts) wires the modules, and nothing here runs.

import type { AcceptedEventReceipt } from '../interface/door.ts';
import type { NativeMessageLocator } from '../memory/db/recall.ts';
import type { Context } from '../memory/db/scope.ts';
import type { PendingPing } from '../behavior/pending.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';
import type { TriggerKind } from '../turn/triggers.ts';

export type { TriggerKind };

/** The execution context supplied by the authenticated event handler, kept outside the message. */
export type AcceptedMessageEvent = Readonly<{
  eventId: string;
  locator: NativeMessageLocator;
  receipt: AcceptedEventReceipt;
}>;

export type MessageReadOptions = { memoryContext?: Context; acceptedEvent?: AcceptedMessageEvent };

/** A conversation as the interface describes it (src/protocol/adapter.ts). */
export type Conv = ConversationInfo;

/** A normalized line (src/behavior/line-of.ts#lineOf), as the pipeline reads it. */
export type Line = {
  readonly id: string;
  readonly placeId: string;
  readonly authorId: string;
  readonly authorName?: string;
  readonly content?: string;
  readonly ts: number;
  readonly replyToId: string | null;
  readonly mentionedAccountIds: Array<string>;
  readonly replyPingAccountId?: string | null;
  readonly self?: boolean;
};

/** Why a turn ended (src/behavior/turn.ts#TurnOutcome). */
export type TurnOutcome = 'spoke' | 'skip' | 'busy' | 'refused' | 'paused' | 'not-now' | 'cancelled' | 'error';

/** A rail's limit a refused turn carries, as the limit notice quotes it. */
export type Limit = { key: string; used?: number; cap?: number };

/** A turn's result as the pipeline reads it (src/turn/outcome.ts). */
export type TurnResult =
  { outcome?: TurnOutcome; limit?: Limit | null; delivered?: boolean; reason?: string } | undefined;

/** A queued call of the pending queue (src/behavior/pending.ts#PendingPing), with its conversations and its line. */
export type Ping = Omit<PendingPing, 'channel' | 'trigger'> & {
  channel: Conv;
  trigger: Line;
  readOptions?: MessageReadOptions;
};

/**
 * The pending queue's list, shared by the modules that read or replace it. src/behavior/pending.ts answers a new list
 * each time, so a module writes `list` back instead of holding the array.
 */
export type PendingQueue = { list: Array<Ping> };

/** The live config, as far as the message pipeline reads it. */
export type PipelineConfig = {
  readonly media?: {
    readonly video?: {
      readonly sites?: Array<string>;
    };
  };
  readonly web?: {
    readonly links?: { readonly enabled?: unknown; readonly prefill?: unknown; readonly prefillPerUserPerDay?: number };
  };
  readonly memoryDb?: { readonly observeTimeoutMs?: number; readonly ingestKeepDays?: number };
  readonly mention: MentionConfig;
  readonly address?: { readonly attentionMinutes?: number; readonly maxTurnsPerAuthor?: number };
  readonly bot: {
    readonly timezone: string;
  };
  readonly memory?: { readonly aliasHalfLifeDays?: number };
};

/** The `mention` settings (config.json), as the pipeline reads them. */
export type MentionConfig = {
  readonly followUpContext?: number;
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

/** The hot config and prompts (src/hot.ts#createHot), read at the moment of use. */
export type PipelineHot = {
  readonly config: PipelineConfig;
  readonly prompts?: {
    readonly labels: PipelineLabels;
    readonly address?: string;
    readonly 'character-card'?: unknown;
    readonly room?: string;
    readonly merge?: string;
  } | null;
};

/** The labels file (prompts/labels.json), as the pipeline hands it on. */
export type PipelineLabels = { readonly address?: { readonly author?: string } } & object;

/** The persisted state (src/memory/store.ts), as far as the pipeline reads and writes it. */
export type PipelineState = {
  data?: {
    paused?: unknown;
    /** When she last wrote in a place, by its interface and native id (src/pipeline/address-attention.ts). */
    addressAttention?: Record<string, number>;
    elsewherePings?: unknown;
  };
  markDirty?: () => void;
};

/** A turn as runTurn starts it (src/behavior/turn.ts#runTurn), as far as the pipeline fills it in. */
export type TurnRequest = {
  memoryContext?: Context;
  conversation: { iface: string; conversationId: string };
  placeId?: string;
  mode: 'reply';
  trigger: Line;
  triggerKind: TriggerKind;
  queued?: (() => Array<{ id: string; text: string; author?: string }>) | null;
  added?: Ping['added'] | null;
};

/** The turn runner (src/behavior/turn.ts#createTurnRunner), as far as the pipeline calls it. */
export type PipelineTurns = {
  isBusy: (placeId: string) => boolean;
  isAnyBusy: () => boolean;
  busyChannels?: () => Array<string>;
  runTurn: (request: TurnRequest) => Promise<TurnResult>;
  notePost: (placeId: string, ts: number) => void;
  spokeAfterSeeing?: (placeId: string, messageId: string) => boolean;
  waitingParts?: (placeId: string, authorId: string) => unknown;
  addToPart?: (
    placeId: string,
    authorId: string,
    index: number,
    message: { id: string; text: string; ts: number }
  ) => unknown;
  lastPostAt?: (placeId: string) => number;
};

/** The model client (src/llm/openrouter.ts#createLlm), as the classifiers call it. */
export type PipelineLlm = {
  complete: (
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: object
  ) => Promise<{ text?: unknown } | null | undefined>;
};

/** The missed-answer registry (src/behavior/missed.ts#createMissed), as the pipeline notes into it. */
export type PipelineMissed = {
  noteFact: (fact: object) => void;
  noteActivity: (placeId: string, at: number, iface?: string) => void;
  noteNotAddressed?: (message: Line, iface?: string) => void;
};

/** A thrown value as the pipeline logs it: a name, a code and an HTTP status, each when it has one. */
export type Thrown = { name?: string; code?: unknown; statusCode?: number } | null | undefined;
