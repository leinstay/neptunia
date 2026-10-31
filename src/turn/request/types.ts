// The shapes a turn's request is built from: the live labels and config as far as the block builders read them, the
// stored profiles, the normalized messages, the transcript items and the budget's sections. Types only: the block
// builders of src/turn/request/ and src/behavior/prompt.js#buildRequest share them.

import type { formatTranscript } from '../../format.js';
import type { ParticipationInput } from './memory.ts';
import type { Lookup, Prefetch } from './recall.ts';
import type { GuildMemory, StoredChannel } from './server.ts';
import type { SkillRow } from './senses.ts';
import type { Tasks } from './task.ts';
import type { PreviousThink } from './wake.ts';
import type { MediaCache } from './emoji-gifs.ts';
import type { DiaryInput } from './diary.ts';

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
  readonly lanes?: { readonly [kind: string]: unknown };
  readonly status?: { readonly [status: string]: unknown };
  readonly sources?: { readonly memory?: string; readonly history?: string };
};

/** `labels.tools`: the `<skills>` line, the access words, the argument forms and the proposed notes. */
export type ToolsLabels = {
  readonly line?: unknown;
  readonly access?: unknown;
  readonly args?: unknown;
  readonly proposedOff?: unknown;
  readonly proposedDenied?: unknown;
};

/** `prompts.labels`, as far as the request builders read it (the prompt contract, docs/prompt-contract.md). */
export type Labels = {
  readonly locale?: string;
  readonly self: string;
  readonly units: Units;
  readonly transcript: LabelGroup;
  readonly profile: LabelGroup;
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
  readonly diary?: LabelGroup;
  readonly room?: LabelGroup;
  readonly triggers?: LabelGroup;
  readonly elsewhere?: LabelGroup;
  readonly previousThink?: LabelGroup;
  readonly draw?: LabelGroup;
};

/** The live prompts: the prompt files by name, and the labels. */
export type Prompts = { readonly labels: Labels; readonly [file: string]: unknown };

/** A switch of `features`: compared with `true` or `false`, a missing key read by each reader's own default. */
export type Features = { readonly [name: string]: unknown };

/** `context.caps`: the token cap of each budget section. */
export type Caps = { readonly [section: string]: number | undefined };

/** The live config, as far as the request builders read it. */
export type RequestConfig = {
  readonly bot: { readonly timezone: string };
  readonly features?: Features;
  readonly context: {
    readonly caps: Caps;
    readonly gapMarkerMinutes: number;
    readonly maxMessageChars: number;
    readonly ageAfterMinutes?: number;
    readonly reactionsPerMessage?: number;
    readonly reactions?: { readonly maxNames?: number };
    readonly replyQuoteChars?: number;
    readonly customEmoji?: EmojiConfig;
    readonly tempo?: { liveMessages10min: number; deadSilenceMinutes: number };
    readonly channelActivity?: { liveMessagesPerDay?: number; deadAfterDays?: number };
    readonly neighborMessageChars?: number;
    readonly askedAboutProfiles?: number;
    readonly askedAboutEpisodes?: number;
    readonly attitudes?: number;
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
  readonly web?: { readonly links?: { readonly enabled?: unknown }; readonly search?: { readonly enabled?: unknown } };
  readonly diary?: { readonly world?: unknown; readonly historyPosts?: number };
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

/** A normalized chat message (src/protocol/events.js#Message), as the request builders read it. */
export type Message = {
  readonly id: string;
  readonly ts: number;
  readonly authorId?: string | null;
  readonly authorName?: string;
  readonly content?: string;
  readonly self?: boolean;
  readonly bot?: boolean;
  readonly replyParent?: boolean;
  readonly replyToId?: string | null;
  readonly triggerId?: string | null;
  readonly mentionedUserIds?: Array<string>;
  readonly channelId?: string;
  readonly channelName?: string;
  readonly channelCategory?: string | null;
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

/** One line of a rendered transcript (src/format.js#formatTranscript). */
export type TranscriptItem = ReturnType<typeof formatTranscript>[number];

/** The options of src/format.js#formatTranscript a request renders its chat, neighbours and pulled channels with. */
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

/** A remembered moment with a member (src/memory/episodes.js). */
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

/** A budget section (src/llm/budget.js#Section). */
export type Section = {
  name: string;
  items: Array<string>;
  keep?: 'first' | 'newest' | 'oldest';
  cap?: number;
  required?: boolean;
};

/** A section's budget line, with the counts some blocks add to it. */
export type SectionStats = { used: number; kept: number; dropped: number; [count: string]: number };

/** What the budget kept: the items of each section, and each section's budget line. */
export type Fit = {
  kept: Record<string, Array<string>>;
  stats: Record<string, SectionStats>;
  used: number;
};

/** The price of a text in tokens (src/llm/budget.js#sectionCost). */
export type Cost = (text: string) => number;

/** A neighbouring channel's recent lines (src/behavior/neighbors.ts#fetchNeighbors). */
export type Neighbor = { readonly channelId?: string; readonly channelName: string; readonly messages: Array<Message> };

/**
 * Every input buildRequest reads (src/behavior/prompt.js, where each is described). An input the block builders read
 * only after its own check is `unknown` here; the builders hand on the checked value under the same name.
 */
export type RequestInput = {
  readonly config: RequestConfig;
  readonly prompts: Prompts;
  readonly calibrator: { apply: (rawEstimate: number) => number };
  readonly mode: string;
  readonly forced: boolean;
  readonly now: number;
  readonly selfName: string;
  readonly selfId?: string | null;
  readonly history: Array<Message>;
  readonly neighbors: Array<Neighbor>;
  readonly trigger: Message | null;
  readonly triggerKind: string | null;
  readonly taggedCall?: boolean | null;
  readonly guildMemory?: GuildMemory | null;
  readonly interlocutor?: Profile | null;
  readonly privateChat?: unknown;
  readonly privateProfile?: unknown;
  readonly otherProfiles?: unknown;
  readonly candidateProfiles?: unknown;
  readonly nameOf?: unknown;
  readonly channels: Array<StoredChannel>;
  readonly channelDirectory?: Array<{ id: string; name: string; category?: string | null }> | null;
  readonly loreEntries?: unknown;
  readonly currentChannelId: string | null;
  readonly descriptions?: Map<string, string>;
  readonly neighborDescriptions?: unknown;
  readonly videos?: Map<string, { state: 'watched' | 'limit' | 'error' | 'pending'; text?: string; reason?: string }>;
  readonly imageAnswers?: Map<string, { question: string; text: string }> | null;
  readonly reads?: Map<string, string>;
  readonly lookup: Lookup | null;
  readonly prefetch?: Prefetch | null;
  readonly searchAvailable?: unknown;
  readonly recallAvailable?: unknown;
  readonly drawQuota?: { spent: boolean; userSpent: boolean } | null;
  readonly customEmoji?: unknown;
  readonly mediaCache?: MediaCache | null;
  readonly gifs?: unknown;
  readonly pulled?: unknown;
  readonly source?: { readonly channelId: string; readonly reason: string } | null;
  readonly focus?: { readonly id: string; readonly authorName?: string } | null;
  readonly tasks?: Tasks | null;
  readonly elsewhereDestination?: { readonly name?: string } | null;
  readonly readOnlyIds?: unknown;
  readonly recentLines?: unknown;
  readonly recentAudience?: unknown;
  readonly participation?: ParticipationInput | null;
  readonly diaryChannel?: unknown;
  readonly diaryChannelIds?: Iterable<string> | null;
  readonly diary?: DiaryInput | null;
  readonly offPeriods?: unknown;
  readonly skillsInventory?: Array<SkillRow | null> | null;
  readonly toolsGranted?: unknown;
  readonly toolsBlock?: unknown;
  readonly toolsTokens?: unknown;
  readonly around?: unknown;
  readonly errands?: unknown;
  readonly intentions?: unknown;
  readonly wake?: unknown;
  readonly wakeKind?: string | null;
  readonly places?: unknown;
  readonly previousThink?: PreviousThink | null;
  readonly stableFreeze?: unknown;
};
