// The draft of one attempt of a turn: what its phases note while they run, for the journal's turn record
// (journalTurnRecord), the end of the turn (src/turn/outcome.ts) and the steps of her tool loop. runTurnOnce
// (src/behavior/turn.js) creates it with the attempt's limits and hands the same object to every phase in
// src/turn/phases/; the topic modules each read and write the part of it their own draft type names.

import type { Snapshot } from '../behavior/snapshot.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';
import type { Act } from './act.ts';
import type { DrawGif } from './draw-gif.ts';
import type { DryAct } from './dry-act.ts';
import type { InTurnDraft } from './in-turn-tools.ts';
import type { Inputs } from './inputs.ts';
import type { JournalNotes, NotesDraft } from './journal-notes.ts';
import type { noteDiagnostics } from './journal.ts';
import type { ToolRoundDraft } from './tool-round.ts';

/** What bit during the attempt (src/llm/limits.js#createLimits). */
export type Limits = {
  add: (entry: { kind: string; where?: string | null; lost?: number | null; detail?: string }) => void;
  list: () => Array<{ kind: string; where: string | null; lost: number | null; detail?: string }>;
};

/** The inner turn this attempt is (mode `inner`, src/behavior/inner.ts): its wake and where it may act. */
export type InnerTurn = {
  wake?: {
    kind?: string | null;
    chainId?: string | null;
    heartbeat?: { refs?: unknown } | null;
    intentions?: ReadonlyArray<{ purpose?: unknown } | null>;
    items?: unknown;
    [key: string]: unknown;
  } | null;
  currentChannel?: string | null;
  shadow?: boolean;
  [key: string]: unknown;
};

/** The ids the journal gave the attempt when it started (src/memory/journal.js#start). */
type Started = { turnId: string; attemptId: string; startedAt: number };

/** The drafts of the topic modules, all of which this one object is. */
type ModuleDrafts = ToolRoundDraft &
  NonNullable<Parameters<Act['act']>[0]['draft']> &
  NonNullable<Parameters<DryAct['dryAct']>[0]['draft']> &
  InTurnDraft &
  NotesDraft &
  NonNullable<Parameters<Inputs['turnContextOf']>[0]> &
  NonNullable<Parameters<DrawGif['drawTool']>[1]['draft']> &
  NonNullable<Parameters<typeof noteDiagnostics>[0]> &
  NonNullable<Parameters<JournalNotes['dumpTurnRequest']>[1]>;

/**
 * Every field an attempt's draft holds. `limits`, `format` and `tools` exist before any phase that reads them:
 * runTurnOnce creates the draft with its limits, and the request phase sets the tools and the response phase the
 * format counts before the tool round reads them.
 */
export type Draft = Omit<ModuleDrafts, 'inner' | 'limits' | 'started' | 'diary'> & {
  limits: Limits;
  // An inner turn (mode `inner`): her calls pass its gate.
  inner?: InnerTurn | null;
  // A turn a finished errand of her own opened: her grants alone decide her calls.
  ownInitiative?: boolean;
  // The conversation as the interface described it when the attempt began.
  info?: ConversationInfo;
  guildId?: string;
  channelId?: string;
  privateUserId?: string | null;
  mode?: string | null;
  // The journal's ids, while features.journal follows the attempt.
  started?: Started;
  transport?: 'native' | 'text';
  snapshot?: Snapshot | null;
  requesterGroups?: Array<string>;
  // A diary post: whether its kind is a set of pictures.
  diary?: { set: boolean } | null;
  deletedIds?: unknown;
  factsShown?: Array<string>;
  toolNames?: Array<string>;
  seen?: {
    messageIds: Array<string>;
    parents: Array<unknown>;
    parts: { filePreviews: Array<unknown> };
    pulled: Array<{ channelId: string; messageIds: Array<string> }>;
    [key: string]: unknown;
  } | null;
  participants?: Array<string>;
  dropped?: Record<string, number>;
  think?: unknown;
  usage?: unknown;
  reason?: string | null;
  turnKey?: { turnId: string };
  callCount?: number;
  posted?: Array<unknown>;
  reactions?: Array<unknown>;
  replyTargets?: Array<string>;
  sendFailure?: Record<string, unknown>;
  gifFailure?: unknown;
  diaryVoice?: unknown;
  innerActions?: Array<unknown>;
  innerIntentIds?: Iterable<string>;
};
