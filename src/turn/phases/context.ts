// What the phases of a turn attempt share: the runner's dependencies and the functions of its topic modules
// (PhaseContext), what the attempt was asked to do (PhaseParams), how a phase ends the attempt early (Ended), the
// attempt's clocks and indicator that its end closes (Life), and the cancellation point at its bar (BeforeBar).
// createTurnRunner (src/behavior/turn.js) builds the context once; runTurnOnce hands it to every phase.

import type { createParticipationPicker } from '../../behavior/participation-pick.js';
import type { createPullViews } from '../../behavior/pull-fetch.ts';
import type { recordEntry } from '../../behavior/diary-turn.ts';
import type { refreshEmojiIfOn } from '../../behavior/emoji-index.ts';
import type { fetchNeighbors } from '../../behavior/neighbors.ts';
import type { Deadline } from '../../behavior/turn-parts.ts';
import type { ErrandRecord } from '../../errands/types.ts';
import type { Reads } from '../../interface/reads.ts';
import type { ConversationInfo, ConversationRef } from '../../protocol/adapter.ts';
import type { SkillMap } from '../../tools/types.ts';
import type { Diary, DiaryConfig } from '../diary.ts';
import type { DrawGif } from '../draw-gif.ts';
import type { DryAct } from '../dry-act.ts';
import type { Facts } from '../facts.ts';
import type { withReplyParents } from '../history.ts';
import type { InTurnTools, InTurnConfig } from '../in-turn-tools.ts';
import type { Inputs, InputsConfig } from '../inputs.ts';
import type { JournalNotes, NotesConfig } from '../journal-notes.ts';
import type { Lookup, LookupConfig, TurnPlan } from '../lookup.ts';
import type { Participation, ParticipationConfig } from '../participation.ts';
import type { Pulls, PullsConfig } from '../pulls.ts';
import type { Rewatch, RewatchConfig, VideoState } from '../rewatch.ts';
import type { Sends, SendsConfig } from '../sends.ts';
import type { StepCompletion, ToolRound, ToolRoundConfig } from '../tool-round.ts';
import type { TriggerKind } from '../triggers.ts';
import type { Typing, TypingConfig } from '../typing.ts';

/** The live config, as far as the phases read it; the functions they call read their own sections. */
export type PhaseConfig = LookupConfig &
  PullsConfig &
  DiaryConfig &
  ToolRoundConfig &
  TypingConfig &
  ParticipationConfig &
  SendsConfig &
  InputsConfig &
  NotesConfig &
  InTurnConfig &
  RewatchConfig &
  Parameters<typeof fetchNeighbors>[3] &
  NonNullable<Parameters<typeof withReplyParents>[3]>['config'] & {
    features?: Record<string, unknown> | null;
    web?: {
      search?: { enabled?: unknown; contextMessages?: number } | null;
      links?: { enabled?: unknown; maxPerTurn?: number } | null;
    } | null;
    media?: {
      filePreviewChars?: unknown;
      maxPerTurn?: number;
      video?: { sites?: Array<string>; maxPerTurn?: number } | null;
    } | null;
    image?: { maxPromptChars?: number } | null;
    mention?: { oneAtATime?: unknown } | null;
    format?: { stripDashes?: unknown } | null;
    bot?: { timezone?: string } | null;
    diary?: { maxMessages?: number; setKinds?: unknown } | null;
    context: { otherProfiles: number };
  };

/** The labels, as far as the phases read them; the text functions read their own sections. */
export type PhaseLabels = {
  locale?: string;
  units?: object;
  pull?: { header?: unknown } | null;
  task?: { part?: unknown; queued?: unknown; queuedOthers?: unknown; failedEarlier?: unknown };
  [key: string]: unknown;
};

/** The prompt files a turn reads at the moment of use. */
export type PhasePrompts = {
  labels?: PhaseLabels;
  split?: string;
  'follow-up'?: unknown;
  tools?: unknown;
  [key: string]: unknown;
} | null;

/** The memory store (src/memory/store.js), as far as the phases read it. */
export type PhaseStore = Parameters<typeof recordEntry>[0]['store'] & {
  state: { data: { paused?: unknown; calibration?: unknown }; markDirty: () => void };
  getUser: (guildId: string, userId: string | undefined) => { names?: Array<string> } | null | undefined;
  getPrivate: (guildId: string, userId: string) => unknown;
  getGuild: (guildId: string) => unknown;
  listUserProfiles: (guildId: string) => unknown;
  listChannels: (guildId: string) => unknown;
  getLore: (guildId: string) => unknown;
  getGifs?: (guildId: string) => unknown;
  getMediaCache: (guildId: string) => unknown;
  getParticipation: (guildId: string) => unknown;
};

/** The language model client (src/llm/openrouter.js#createLlm), as the reply request uses it. */
export type PhaseLlm = {
  complete: (messages: Array<object>, options: object) => Promise<StepCompletion & { estimated?: unknown }>;
};

/** The runner's dependencies and the functions of its topic modules that the phases call. */
export type PhaseContext = {
  hot: { readonly config: PhaseConfig; readonly prompts: PhasePrompts };
  store: PhaseStore;
  llm: PhaseLlm;
  calibrator: { ratio: number };
  clock: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
  describer: PhaseDescriber | null | undefined;
  fetchImpl: typeof fetch;
  lookup: PhaseWebLookup | null | undefined;
  images: { quota: (args: { userId: string | null }) => unknown } | null | undefined;
  emoji:
    | (NonNullable<Parameters<typeof refreshEmojiIfOn>[0]> & { list: () => Array<unknown> | null | undefined })
    | null
    | undefined;
  journal: { start: (guildId: string, fields: object) => { turnId: string; attemptId: string; startedAt: number } };
  record: { iterate?: unknown } | null;
  iface: unknown;
  ifaceReads: Reads;
  skills: SkillMap | null;
  memoryReads: ((args: Record<string, unknown>) => void) | null;
  busy: Set<string>;
  selfIdOf: () => string;
  getSelfName: (guildId: string) => string;
  // The channels known to be private chats (a deferred call names only its channel).
  privateChannels: Set<string>;
  pullViews: ReturnType<typeof createPullViews>;
  // Whether the last turn that wanted prompts['follow-up'] found it missing or blank.
  promptState: { followUpMissing: boolean };
  pickParticipation: ReturnType<typeof createParticipationPicker>;
  notifyIdle: () => void;
  facts: Facts['facts'];
} & Pick<
  Participation,
  'participationOn' | 'participationAudience' | 'aroundInputFor' | 'liveChannelName' | 'recentInput'
> &
  Pick<
    Inputs,
    'turnContextOf' | 'stableFreezeOf' | 'discoverSkills' | 'errandsInputFor' | 'intentionsInputFor' | 'placesInputFor'
  > &
  Pick<
    JournalNotes,
    | 'noteSeen'
    | 'linkTriggers'
    | 'linkCalls'
    | 'earlierThinkFor'
    | 'journalOn'
    | 'dumpTurnRequest'
    | 'offPeriodsFor'
    | 'journalOp'
  > &
  Pick<Diary, 'prepareDiary' | 'diaryPictureGate'> &
  Pick<DrawGif, 'resolveGif'> &
  Pick<Sends, 'emojiLookup' | 'settleAuthor' | 'diaryChannelName'> &
  Pick<Typing, 'typingWhilePreparing'> &
  DryAct &
  Pulls &
  Pick<ToolRound, 'readHistory' | 'noteThink' | 'stepTranscript' | 'runSteps'> &
  InTurnTools &
  Rewatch &
  Pick<
    Lookup,
    | 'startPrefetch'
    | 'recallAvailable'
    | 'turnDirectory'
    | 'privatePartner'
    | 'createTurnPlan'
    | 'lookupGate'
    | 'maybeLookup'
    | 'maybeSplit'
  >;

/** The describer (src/memory/describe.js#createDescriber), as the preparation of a turn uses it. */
export type PhaseDescriber = {
  describeMany: (
    guildId: string,
    candidates: Array<object>,
    options: { maxNew: number }
  ) => Promise<{ descriptions?: Map<string, unknown> } | null | undefined>;
  cachedDescriptions?: (guildId: string, candidates: Array<object>) => Map<string, unknown> | undefined;
  describeVideos?: (
    guildId: string,
    candidates: Array<object>,
    options: { maxNew: number }
  ) => Promise<{ videos?: Map<string, VideoState> } | null | undefined>;
  cachedVideos?: (guildId: string, candidates: Array<object>) => Promise<Map<string, VideoState> | undefined>;
  rewatchVideo?: unknown;
  relookImage?: unknown;
  rewatchGif?: unknown;
  watchedGifs?: (guildId: string, items: Array<{ itemId: string }>) => Map<string, unknown>;
};

/** The web lookup (src/web/lookup.js#createLookup), as the preparation of a turn uses it. */
export type PhaseWebLookup = {
  search?: unknown;
  hasSearch?: () => boolean;
  readLinks?: (
    guildId: string,
    links: Array<{ id: string; url?: string }>,
    options: { maxNew: number }
  ) => Promise<unknown>;
  cachedReads?: (guildId: string, links: Array<{ id: string; url?: string }>) => Map<string, unknown> | undefined;
};

/** The message a turn answers, as the interface delivered it. */
export type TurnTrigger = {
  id: string;
  authorId: string;
  authorName: string;
  channelId?: string | null;
  content: string;
  ts: number;
  replyToId?: string | null;
  mentionedUserIds?: Array<string>;
  replyPingUserId?: string | null;
  [key: string]: unknown;
};

/** What a turn attempt was asked to do (runTurn's arguments, as runTurnOnce passes them on). */
export type PhaseParams = {
  conversation: ConversationRef;
  guildId?: string | null;
  mode: string;
  trigger?: TurnTrigger | null;
  triggerKind?: TriggerKind | null;
  chooseMode?: ((history: Array<object>, now: number, context: { pulled: Array<object> }) => string | null) | null;
  forced?: boolean;
  source?: { channelId: string; reason: 'routed' | 'noticed' } | null;
  focus?: unknown;
  queued?: (() => unknown) | null;
  added?: ReadonlyArray<{ id?: string; text?: unknown } | null> | null;
  maySplit?: boolean;
  owned?: boolean;
  part?: { index: number; total: number; parts: Array<string> } | null;
  reuseHistory?: Array<object> | null;
  plainPosts?: boolean;
  diary?: { kind?: unknown; forced?: boolean; [key: string]: unknown } | null;
  journalTurn?: { turnId?: string | null; attemptId?: string | null } | null;
  missed?: ReadonlyArray<{ author?: unknown; text?: unknown } | null> | null;
  stillDue?: (() => boolean) | null;
  requester?: unknown;
  taskResult?: ErrandRecord | null;
  inner?: Record<string, unknown> | null;
  standIn?: ConversationInfo | null;
};

/** How an attempt ended (TurnOutcome in src/behavior/turn.js), with the parts of a message that splits. */
export type AttemptResult = {
  outcome: string;
  mode?: string;
  reason?: unknown;
  limit?: unknown;
  [key: string]: unknown;
};

/** A phase that ends the attempt returns its result; one that goes on returns `ended: null` and what it made. */
export type Ended = { ended: AttemptResult };

/**
 * What the end of an attempt closes whatever it returned: the typing indicator, the preparation's deadline, the bar,
 * the planner, and whether a chain of parts took the attention. `turnMode` is the mode a dropped turn logs.
 */
export type Life = {
  stopTyping: () => void;
  deadline: Deadline | null;
  bar: Deadline | null;
  planner: TurnPlan | null;
  chained: boolean;
  turnMode: string;
  turnStartedAt: number;
};

/** The cancellation point at the turn's bar: the work, or TOO_SLOW thrown once the bar is reached. */
export type BeforeBar = <TValue>(promise: Promise<TValue>) => Promise<TValue>;

/** A line of a turn's history (src/behavior/lines.ts#Line), with the message fields the phases read. */
export type HistoryLine = {
  id: string;
  self?: boolean;
  ts: number;
  authorId?: string;
  authorName?: string;
  content?: string;
  attachments?: Array<{ id?: string; previewLost?: number; [key: string]: unknown }>;
  [key: string]: unknown;
};
