// The draft of one attempt of a turn: what its phases note while they run, for the journal's turn record
// (journalTurnRecord), the end of the turn (src/turn/outcome.ts) and the steps of her tool loop. runAttempt
// (src/turn/phases/attempt.ts) creates it with the attempt's limits and hands the same object to every phase in
// src/turn/phases/. Each topic module declares the fields it reads and writes in its own draft type; this file
// holds the fields only the phases share and the ones it types more narrowly than a module does.

import type { turnBoundary } from '../tools/publication.ts';
import type { MemoryPage } from '../memory/db/semantic-types.ts';
import type { ChatInfo } from '../protocol/adapter.ts';
import type { Act } from './act.ts';
import type { DrawGif } from './draw-gif.ts';
import type { InTurnDraft } from './in-turn-tools.ts';
import type { Inputs } from './inputs.ts';
import type { NotesDraft } from './journal-notes.ts';
import type { JournalDraft, noteDiagnostics } from './journal.ts';
import type { ToolRoundDraft } from './tool-round.ts';
import type { IndexedSkill } from '../skills/uses.ts';
import type { Handles } from './handles.ts';

/** What bit during the attempt (src/llm/limits.ts#createLimits). */
export type Limits = {
  add: (entry: { kind: string; where?: string | null; lost?: number | null; detail?: string }) => void;
  list: () => Array<{ kind: string; where: string | null; lost: number | null; detail?: string }>;
};

/** The inner turn this attempt is (mode `inner`, src/behavior/inner.ts): its wake and where it may act. */
export type InnerTurn = {
  wake?: {
    kind?: string | null;
    chainId?: string | null;
    selfimprovement?: { memory?: MemoryPage | null } | null;
    intentions?: ReadonlyArray<{ purpose?: unknown } | null>;
    items?: unknown;
    [key: string]: unknown;
  } | null;
  currentChannel?: string | null;
  shadow?: boolean;
  [key: string]: unknown;
};

/** The ids the journal gave the attempt when it started (src/memory/journal.ts#start), and the place it is written to. */
type Started = { turnId: string; attemptId: string; startedAt: number; placeId: string };

/** The drafts of the topic modules, all of which this one object is. */
type ModuleDrafts = ToolRoundDraft &
  NonNullable<Parameters<Act['act']>[0]['draft']> &
  InTurnDraft &
  NotesDraft &
  NonNullable<Parameters<Inputs['turnContextOf']>[0]> &
  NonNullable<Parameters<DrawGif['drawTool']>[1]['draft']> &
  NonNullable<Parameters<typeof noteDiagnostics>[0]> &
  Omit<JournalDraft, 'started'> &
  NonNullable<Parameters<typeof turnBoundary>[0]>;

/**
 * Every field an attempt's draft holds. `limits`, `format` and `tools` exist before any phase that reads them:
 * runAttempt creates the draft with its limits, and the request phase sets the tools and the response phase the
 * format counts before the tool round reads them.
 */
export type Draft = Omit<ModuleDrafts, 'inner' | 'limits' | 'started' | 'selfreflection'> & {
  limits: Limits;
  // An inner turn (mode `inner`): her calls pass its gate.
  inner?: InnerTurn | null;
  // The chat as the interface described it when the attempt began.
  info?: ChatInfo;
  // The journal's ids, while features.journal follows the attempt.
  started?: Started;
  // A selfreflection post: whether its kind is a set of pictures.
  selfreflection?: { set: boolean } | null;
  // The turn of every call's effect key (src/turn/phases/tool-round.ts): the journal's, else one id per attempt.
  turnKey?: { turnId: string };
  /** The turn's one handle registry (src/turn/handles.ts): every `#n` its requests issued, to the line it names. */
  handles?: Handles;
  /** The ids of the facts the request told, which the turn's end clears (src/turn/phases/request/facts.ts). */
  factsShown?: Array<string>;
  // The skills her tools array offered, for the use rows (src/skills/uses.ts).
  skillsIndexed?: Array<IndexedSkill>;
  /** The messages her posts replied to, for the end hook (src/turn/phases/outcome.ts). */
  replyTargets?: Array<string>;
  /** The bodies of her `<audience>` tags over every answer of a selfreflection turn (src/llm/parse.ts#takeAudience). */
  selfreflectionAudience?: Array<string>;
};
