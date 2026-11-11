// The shapes a turn's request is built from: the live labels and config as far as the block builders read them, the
// stored profiles, the normalized messages, the transcript items and the budget's sections. Types only: the block
// builders of src/turn/request/ and src/behavior/prompt.ts#buildRequest share them.

import type { Frame } from './frame.ts';
import type { Mind } from '../../memory/db/mind-read.ts';
import type { Lookup as RingLookup } from '../calls.ts';
import type { MeanwhileReads } from './meanwhile.ts';
import type { SurroundingsInput } from './reader.ts';
import type { LineOf } from './refs.ts';
import type { SourceRetired } from './reader.ts';
import type { CallMark } from '../../behavior/lines.ts';
import type { formatTranscript } from '../../format.ts';
import type { Prefetch } from './recall.ts';
import type { PlaceMemory } from './server.ts';
import type { SkillRow } from './senses.ts';
import type { Tasks } from './task.ts';
import type { PreviousThink } from './wake.ts';
import type { MediaCache, MediaLookup } from './emoji-gifs.ts';
import type { SelfreflectionInput } from './selfreflection.ts';
import type { Whereabouts } from './spatial.ts';

/** A stored place as a request names it: its path from the interface down, and a direct chat's partner key. */
export type PlacePathView = {
  readonly path: ReadonlyArray<string>;
  readonly dm: boolean;
  /** What the handle of a direct chat's partner is cut from: their person, else their account; null otherwise. */
  readonly partnerKey: string | null;
};

/** A group of label texts (`labels.<group>.<key>`); a key the labels file lacks reads as undefined at run time. */
export type LabelGroup = { readonly [key: string]: string };

/** `labels.units`: the words formatDuration builds an age from. */
export type Units = { lessThanMinute: string; minute: string; hour: string; day: string };

/** `labels.peopleNow`: the `<people_now>` lead, its fields and the marks of its headings. */
export type PeopleNowLabels = LabelGroup & {
  readonly marks?: LabelGroup;
  readonly values?: LabelGroup;
};

/** `labels.prefetch`: the `<retrieved>` block's texts, with its lanes, statuses and sources. */
export type PrefetchLabels = {
  readonly header?: unknown;
  readonly basis?: unknown;
  readonly caution?: unknown;
  readonly excerpt?: unknown;
  readonly memoryExcerpt?: unknown;
  readonly factExcerpt?: unknown;
  readonly factStates?: { readonly [state: string]: unknown };
  readonly lanes?: { readonly [kind: string]: unknown };
  readonly status?: { readonly [status: string]: unknown };
  readonly sources?: { readonly memory?: string; readonly history?: string; readonly fact?: string };
};

/** `labels.tools`: the `<skills>` line, the access words, the argument forms and the proposed notes. */
export type ToolsLabels = {
  readonly line?: unknown;
  readonly access?: unknown;
  readonly args?: unknown;
  readonly proposedOff?: unknown;
};

/** `prompts.labels`, as far as the request builders read it (the prompt contract, docs/prompt-contract.md). */
export type Labels = {
  readonly locale?: string;
  readonly self: string;
  readonly units: Units;
  readonly transcript: LabelGroup;
  readonly profile: LabelGroup;
  readonly tempo: LabelGroup;
  readonly peopleNow?: PeopleNowLabels;
  readonly affinity?: { readonly bands?: LabelGroup };
  readonly attitudes?: LabelGroup;
  readonly aboutChat: LabelGroup;
  readonly lore?: LabelGroup;
  readonly emoji?: LabelGroup;
  readonly gifs?: LabelGroup;
  readonly journal?: LabelGroup;
  readonly task?: LabelGroup;
  readonly lookup?: LabelGroup;
  readonly prefetch?: PrefetchLabels;
  readonly senses?: LabelGroup;
  readonly tools?: ToolsLabels;
  readonly recent?: LabelGroup;
  readonly participation?: LabelGroup;
  readonly pull?: LabelGroup;
  readonly server?: LabelGroup;
  readonly selfreflection?: LabelGroup;
  readonly room?: LabelGroup;
  readonly triggers?: LabelGroup;
  readonly elsewhere?: LabelGroup;
  readonly previousThink?: LabelGroup;
  readonly myDay?: LabelGroup;
  readonly draw?: LabelGroup;
  readonly spatial?: SpatialLabels;
  readonly memory?: MemoryLabels;
  readonly surroundings?: SurroundingsLabels;
  readonly recall?: LabelGroup;
  readonly meanwhile?: LabelGroup;
  readonly refs?: LabelGroup;
  /** How a line names its author (`line`, `lineAccount`, `unknown`). */
  readonly authors?: LabelGroup;
  /** How a block names a place (`ref`, `refUnhandled`). */
  readonly places?: LabelGroup;
};

/** `labels.memory`: the words of `<memory>`'s entries (src/turn/request/memory-block.ts), with the origin of each. */
export type MemoryLabels = LabelGroup & { readonly origin?: LabelGroup };

/** `labels.surroundings`: the field lines of `<surroundings>` (src/turn/request/surroundings.ts) and each field's name. */
export type SurroundingsLabels = LabelGroup & { readonly fields?: LabelGroup };

/** `labels.spatial`: the lines of `<spatial_awareness>` (src/turn/request/spatial.ts) and the label of each place kind. */
export type SpatialLabels = {
  readonly place?: string;
  readonly within?: string;
  /** A place of a native kind the labels do not name: `{noun}` the interface's word for the kind, `{name}`. */
  readonly kind?: string;
  readonly kinds?: LabelGroup;
  readonly unnamed?: string;
  readonly group?: string;
  readonly private?: string;
  readonly note?: string;
  readonly cli?: string;
  readonly server?: string;
  readonly world?: string;
  readonly answers?: string;
  readonly answersOutside?: string;
  /** The interfaces she runs on, on a turn that is nowhere: `{interfaces}`. */
  readonly interfaces?: string;
};

/** The live prompts: the prompt files by name, and the labels. */
export type Prompts = { readonly labels: Labels; readonly [file: string]: unknown };

/** `context.caps`: the token cap of each budget section. */
export type Caps = { readonly [section: string]: number | undefined };

/** The live config, as far as the request builders read it. */
export type RequestConfig = {
  readonly bot: { readonly timezone: string };
  readonly spatial?: { readonly notes?: unknown };
  readonly dm?: { readonly enabled?: unknown };
  readonly private?: { readonly likeServer?: unknown };
  readonly context: {
    readonly caps: Caps;
    /** `context.chatSteps`: the line counts `<chat>` may be cut to (src/turn/request/reader.ts). */
    readonly chatSteps?: unknown;
    readonly customEmoji?: EmojiConfig;
    readonly around?: { readonly maxTokens?: number };
  };
  readonly memory?: {
    readonly maxInterests?: number;
    readonly maxDetails?: number;
    readonly maxAliases?: number;
    readonly aliasHalfLifeDays?: number;
    readonly addressHalfLifeDays?: number;
    readonly interestHalfLifeDays?: number;
    readonly detailHalfLifeDays?: number;
    readonly confirmAfter?: number;
    readonly interestStaleDays?: number;
    readonly supersededShownDays?: number;
    readonly maxLearned?: number;
    readonly learnedHalfLifeDays?: number;
  };
  readonly relationships?: { readonly shownMoves?: number };
  readonly gifs?: GifsConfig;
  readonly lore?: { readonly scanMessages?: number; readonly maxMatches?: number };
  readonly tools?: { readonly loop?: { readonly stepReserveTokens?: number } };
  readonly web?: {
    readonly links?: { readonly enabled?: unknown };
    readonly quickSearch?: { readonly enabled?: unknown };
  };
  readonly selfreflection?: { readonly entries?: number; readonly sceneChars?: number };
  readonly media?: { readonly video?: { readonly sites?: ReadonlyArray<string> } };
  readonly models?: { readonly routes?: Record<string, unknown> };
};

/** `context.customEmoji`: how many custom emoji `<emoji>` lists and how fast their use fades. */
export type EmojiConfig = { readonly max?: number; readonly halfLifeDays?: number };

/** `config.gifs`: the `<gifs>` list's length, its fading and the cut of each caption field. */
export type GifsConfig = {
  readonly max?: number;
  readonly halfLifeDays?: number;
  readonly reactionChars?: number;
  readonly actionChars?: number;
  readonly ownMarkHours?: number;
};

/** A member id to their current stored name, or null. */
export type NameOf = (id: string) => string | null;

/** One custom emoji of a message, or of the server's index. */
export type EmojiRef = { readonly id: string; readonly name: string; readonly animated?: boolean };

/** A normalized chat message (src/protocol/events.ts#Message), as the request builders read it. */
export type Message = {
  readonly id: string;
  readonly ts: number;
  readonly authorId?: string | null;
  readonly authorName?: string;
  readonly content?: string;
  readonly self?: boolean;
  readonly bot?: boolean;
  readonly replyParent?: boolean;
  /** `call` on a call mark of hers (src/turn/history.ts#orderedHistory). */
  readonly kind?: 'call';
  readonly replyToId?: string | null;
  readonly triggerId?: string | null;
  readonly mentionedAccountIds?: Array<string>;
  readonly placeId?: string;
  readonly channelName?: string;
  readonly channelTopic?: string | null;
  readonly emojis?: Array<EmojiRef>;
  readonly forwarded?: Array<{
    readonly content?: string;
    readonly emojis?: Array<EmojiRef>;
    readonly attachments?: Array<{ readonly id?: unknown }>;
  }>;
  readonly attachments?: Array<{ readonly id?: unknown; readonly url?: unknown; readonly name?: unknown }>;
  readonly links?: Array<{ readonly url?: unknown; readonly name?: unknown }>;
  readonly stickers?: Array<{ readonly id?: unknown; readonly url?: unknown; readonly name?: unknown }>;
};

/** One line of a rendered transcript (src/format.ts#formatTranscript). */
export type TranscriptItem = ReturnType<typeof formatTranscript>[number];

/** The options of src/format.ts#formatTranscript a request renders its chat, neighbours and pulled channels with. */
export type FormatOptions = Parameters<typeof formatTranscript>[1];

/** A stored claim about a member (an interest, a detail, an alias), with its validity. */
export type Claim = {
  readonly itemId?: string;
  readonly kind?: string;
  readonly recordedAt?: string;
  readonly validFrom?: string;
  readonly firstSeen?: string;
  readonly lastSeen?: string | null;
  readonly weight?: number;
  readonly conflictSetId?: string;
  readonly supersededBy?: string;
};

export type Interest = Claim & { readonly topic: string; readonly note?: string };
export type Detail = Claim & { readonly text?: string };
export type Alias = Claim & { readonly name: string };

/** A remembered moment with a member (src/memory/episodes.ts). */
export type Episode = {
  readonly itemId?: string;
  readonly date: string;
  readonly what?: string;
  readonly quote?: string;
  readonly feeling?: string;
  readonly weight?: number;
};

/** One move of an attitude (`affinity.history`). */
export type Move = {
  readonly delta?: number;
  readonly appliedDelta: number;
  readonly ts: string;
  readonly reason: string;
};

/** The persona's attitude to a member. */
export type Affinity = { readonly score: number; readonly reason?: string; readonly history?: Array<Move> };

/** A member's stored profile (store.getUser, store.listUserProfiles), as the request renders it. */
export type Profile = {
  readonly id: string;
  readonly names?: Array<string>;
  readonly aliases?: Array<Alias>;
  readonly addressedAs?: unknown;
  readonly realName?: { readonly name?: unknown; readonly itemId?: string; readonly recordedAt?: string } | null;
  readonly avatar?: unknown;
  readonly character?: string;
  readonly interests?: Array<Interest>;
  readonly style?: string;
  readonly details?: Array<Detail>;
  readonly relationship?: string;
  readonly episodes?: Array<Episode>;
  readonly closed?: unknown;
  readonly affinity?: Affinity | null;
  readonly messageCount?: number;
};

/** What a request carried from memory, in the memory's own identity (the collector, see src/turn/request/reads.ts). */
export type MemoryRead = { kind: string; id: string; block?: string };

/** A budget section (src/llm/budget.ts#Section). */
export type Section = {
  name: string;
  items: Array<string>;
  keep?: 'first' | 'newest' | 'oldest';
  cap?: number;
  required?: boolean;
  /** Item counts the section may be cut to, any order (src/llm/budget.ts#fitSections). */
  steps?: ReadonlyArray<number>;
};

/** A section's budget line, with the counts some blocks add to it. */
export type SectionStats = { used: number; kept: number; dropped: number; [count: string]: number };

/** What the budget kept: the items of each section, and each section's budget line. */
export type Fit = {
  kept: Record<string, Array<string>>;
  stats: Record<string, SectionStats>;
  used: number;
};

/** The price of a text in tokens (src/llm/budget.ts#sectionCost). */
export type Cost = (text: string) => number;

/**
 * Every input buildRequest reads (src/behavior/prompt.ts, where each is described). An input the block builders read
 * only after its own check is `unknown` here; the builders hand on the checked value under the same name.
 */
export type RequestInput = {
  readonly config: RequestConfig;
  readonly prompts: Prompts;
  readonly calibrator: { apply: (rawEstimate: number) => number };
  readonly mode: string;
  readonly now: number;
  readonly selfName: string;
  readonly selfId?: string | null;
  readonly history: Array<Message>;
  readonly trigger: Message | null;
  readonly triggerKind: string | null;
  readonly taggedCall?: boolean | null;
  readonly placeMemory?: PlaceMemory | null;
  readonly interlocutor?: Profile | null;
  readonly dmChat?: unknown;
  readonly privateProfile?: unknown;
  readonly otherProfiles?: unknown;
  readonly candidateProfiles?: unknown;
  readonly nameOf?: unknown;
  readonly currentChannelId: string | null;
  readonly descriptions?: Map<string, string>;
  readonly videos?: Map<string, { state: 'watched' | 'limit' | 'error' | 'pending'; text?: string; reason?: string }>;
  readonly imageAnswers?: Map<string, { question: string; text: string }> | null;
  readonly reads?: Map<string, string>;
  readonly prefetch?: Prefetch | null;
  readonly searchAvailable?: unknown;
  readonly recallAvailable?: unknown;
  readonly drawOn?: boolean;
  readonly customEmoji?: unknown;
  readonly mediaPickText?: string | null;
  readonly mediaCache?: MediaLookup | MediaCache | null;
  readonly gifs?: unknown;
  readonly tasks?: Tasks | null;
  readonly elsewhereDestination?: { readonly name?: string } | null;
  readonly selfreflectionChannel?: unknown;
  readonly selfreflectionChannelIds?: Iterable<string> | null;
  readonly selfreflection?: SelfreflectionInput | null;
  readonly offPeriods?: unknown;
  readonly skillsInventory?: Array<SkillRow | null> | null;
  readonly toolsGranted?: unknown;
  readonly toolsBlock?: unknown;
  readonly toolsTokens?: unknown;
  readonly around?: unknown;
  readonly errands?: unknown;
  readonly intentions?: unknown;
  readonly wake?: unknown;
  /** Why she is awake with nobody's message in front of her, for `<spatial_awareness>` (src/behavior/wake.ts#awakeLines). */
  readonly awake?: string | null;
  /** A selfimprovement wake's `<work>` and `<board>` bodies (src/behavior/selfimprovement-text.ts). */
  readonly serviceInner?: { readonly work: string; readonly board: string } | null;
  readonly wakeKind?: string | null;
  readonly previousThink?: PreviousThink | null;
  /** What she did today, one line each (src/turn/request/my-day.ts#myDayOf): the body of `<my_day>`. */
  readonly myDay?: ReadonlyArray<string> | null;
  /** Her call marks (src/turn/journal-notes.ts#callMarksOf), put among the lines of `<chat>` by time. */
  readonly callMarks?: ReadonlyArray<CallMark> | null;
  readonly stableFreeze?: unknown;
  readonly whereabouts?: Whereabouts | null;
  readonly frame?: Frame | null;
  /** What the graph reader brought to her mind (src/memory/db/mind-read.ts#mindOf): `<memory>` of the frame's request. */
  readonly mind?: Mind | null;
  /** Her lookups still anchored in this place's window (src/turn/calls.ts#createLookupRing): `<recall>`. */
  readonly lookups?: ReadonlyArray<RingLookup> | null;
  /** The reads of `<meanwhile>`: her lines elsewhere and the lines around them (src/turn/request/meanwhile.ts). */
  readonly meanwhileReads?: MeanwhileReads | null;
  /** The interface's text and the stored fields of the place and its root: `<surroundings>`. */
  readonly surroundings?: SurroundingsInput | null;
  /** Reads a line by its identity under the turn's scope, for the references in stored texts (src/turn/request/refs.ts). */
  readonly refLineOf?: LineOf | null;
  /** The chat id of a stored place, from its row (frame-reads.ts#placeRefOf); null for a DM and a place no row holds. */
  readonly chatIdOf?: ((placeId: string) => string | null) | null;
  /**
   * What a member's handle is cut from, by a platform id of the turn's interface (else of the one interface whose
   * account holds it): their person, else their account row; null when no account row holds it (frame-reads.ts#memberKeyOf).
   */
  readonly memberKeyOf?: ((native: string) => string | null) | null;
  /** The account key the store gives a platform id of the turn's interface that no row holds yet (addresses.ts#accountOf). */
  readonly accountKeyOf?: ((native: string) => string) | null;
  /** A stored place by its path of names, whether it is a direct chat and that chat's partner; null with no row. */
  readonly placePathOf?: ((placeId: string) => PlacePathView | null) | null;
  /** Whether the line of a lookup's source is gone, for the sources `<recall>` leaves out (src/turn/request/reader.ts). */
  readonly isSourceRetired?: SourceRetired | null;
};

/** Where a person's handle may mention them: the name of their entry and every account by interface and platform id. */
export type HandleTarget = {
  readonly name: string | null;
  readonly accounts: ReadonlyArray<{ readonly iface: string; readonly native: string }>;
};

/**
 * What a request hands on for the rest of its turn: each person's handle (without `@`) to where it may mention them,
 * the handle of a person or account key as the request gives it, and a place id named as the request names it (null
 * for a place the memory holds no row of).
 */
export type RequestRefs = {
  readonly targets: ReadonlyMap<string, HandleTarget>;
  readonly personHandle: (key: string) => string;
  readonly placeRef: (placeId: string) => string | null;
};
