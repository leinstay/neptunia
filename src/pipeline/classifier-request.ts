// The request of the address classifier about one new message: the prompt with the persona's name, her aliases from
// her person record, the place's last lines, the author's stored aliases and the new message as the candidate. The
// place's lines it reads are stored when memory lacks them (src/pipeline/keep-lines.ts). createMessageHandler (src/behavior/pipeline.ts) builds it once with createClassifierRequest.

import { accountOf, sharedPlaceOf } from '../memory/addresses.ts';
import { historyLines } from '../behavior/lines.ts';
import { fill, formatTranscript, renderTranscript } from '../format.ts';
import type { Reads } from '../interface/reads.ts';
import { topByRank } from '../memory/ranking.ts';
import { fillPromptTemplate } from '../turn/request/text.ts';
import type { ChatRef } from './chats.ts';
import type { KeepLines } from './keep-lines.ts';
import type { MediaPrefill } from './media-prefill.ts';
import type { Conv, Line, PipelineConfig, PipelineHot, PipelineLabels } from './types.ts';
import { MEMORY_LIMITS } from '../memory/text-limits.ts';

// The address classifier's request. Production values, config cut of 2026-10-31.
/** The channel lines before the candidate. */
const FOLLOW_UP_CONTEXT = 15;
/** The candidate author's aliases in `<author>`. */
const FOLLOW_UP_ALIASES = 5;

/** A classifier's request: the system and user texts, and the fetched lines without the candidate (never sent). */
export type ClassifierRequest = { system: string; user: string; history: Array<Line> };

/** What buildClassifierRequest is asked with. */
export type ClassifierParams = {
  prompt: string | undefined;
  config: PipelineConfig;
  prompts: PipelineHot['prompts'];
  channel: Conv;
  selfName: string;
  normalized: Line;
  ownPrefill: Promise<void> | null;
};

/** What createClassifierRequest reads: the dependencies of createMessageHandler and two of its parts' functions. */
export type ClassifierRequestContext = {
  reads: Reads;
  store: { getUser: (accountId: string) => { aliases?: unknown } | null | undefined } | null | undefined;
  refOf: (channel: Conv) => ChatRef;
  cachedFollowUpMedia: MediaPrefill['cachedFollowUpMedia'];
  /** Her aliases, the names the owner gave her own person record, read at the moment of use. */
  selfNames: () => ReadonlyArray<string>;
  /** Stores the lines the classifier reads when memory lacks them (src/pipeline/keep-lines.ts); absent, none. */
  keepLines?: KeepLines | null;
};

export function createClassifierRequest({
  reads,
  store,
  refOf,
  cachedFollowUpMedia,
  selfNames,
  keepLines = null,
}: ClassifierRequestContext): {
  buildClassifierRequest: (params: ClassifierParams) => Promise<ClassifierRequest | null>;
} {
  /**
   * The request of the address classifier about one new message: system =
   * `prompt` (address.md, `{{name}}` filled), user = an `<aliases>` block with her aliases, the names the owner gave her person record
   * (they change only with that record, so they go first), the last FOLLOW_UP_CONTEXT
   * lines of the place, then an `<author>` block when the new message's
   * author has stored aliases (followUpAuthorLine), then the new message
   * wrapped in a `<candidate>` block (tags structural, not model-facing
   * wording). Pictures, stickers, emoji and videos carry the captions the
   * describer already cached (cachedFollowUpMedia). Also `history`, the
   * fetched lines without the candidate (never sent). `null` when `prompt` is
   * missing -- the caller treats that the same as a "no".
   */
  async function buildClassifierRequest({
    prompt,
    config,
    prompts,
    channel,
    selfName,
    normalized,
    ownPrefill,
  }: ClassifierParams): Promise<ClassifierRequest | null> {
    if (!prompt) return null;
    // The classifiers run only with the prompts loaded, so the labels file is there.
    const labels = (prompts as NonNullable<PipelineHot['prompts']>).labels;
    const contextLines = FOLLOW_UP_CONTEXT;
    const raw =
      contextLines > 0 ? await historyLines(reads, refOf(channel), { limit: contextLines, keep: keepLines }) : [];
    // A history line is a normalized line as lineOf gives it (src/behavior/lines.ts).
    const history = raw.filter((m) => m.id !== normalized.id) as unknown as Array<Line>;
    const messages = [...history, normalized];
    const placeId = sharedPlaceOf(store, channel);
    const { descriptions, videos } = await cachedFollowUpMedia(placeId, messages, config, ownPrefill);
    const items = formatTranscript(messages, {
      timezone: config.bot.timezone,
      selfName,
      labels,
      seeReactions: true,
      descriptions,
      videos,
    });
    const candidateItem = items[items.length - 1];
    const transcript = renderTranscript(items.slice(0, -1), config.bot.timezone, labels);
    const author = followUpAuthorLine(placeId, normalized, config, labels);
    const authorBlock = author ? `\n<author>\n${author}\n</author>` : '';
    const aliases = selfNames();
    const aliasesBlock = aliases.length > 0 ? `<aliases>\n${aliases.join('\n')}\n</aliases>\n` : '';
    return {
      system: fillPromptTemplate(prompt, { name: selfName }),
      user: `${aliasesBlock}${transcript}${authorBlock}\n<candidate>\n${candidateItem.text}\n</candidate>`,
      // The fetched lines themselves (never sent): a failed address call decides from them (activeExchangeWith).
      history,
    };
  }

  /**
   * The `<author>` block's one line: the candidate author's display name and
   * the top `FOLLOW_UP_ALIASES` stored aliases by rank (decayed with
   * `MEMORY_LIMITS.aliasHalfLifeDays`, the same order the persona's own request
   * shows), filled into `labels.address.author` (`{name}`, `{aliases}`) --
   * so the classifier can tie a nickname in the persona's line to this
   * member. Read-only (`store.getUser`). `''` (no block) with no profile, no
   * aliases or no `labels.address.author`.
   */
  function followUpAuthorLine(
    placeId: string,
    normalized: Line,
    config: PipelineConfig,
    labels: PipelineLabels | undefined
  ): string {
    const template = labels?.address?.author;
    if (!template) return '';
    const cap = FOLLOW_UP_ALIASES;
    const profile = store?.getUser?.(accountOf(store, normalized.authorId));
    const aliases: Array<object> = Array.isArray(profile?.aliases) ? (profile.aliases as Array<object>) : [];
    // A stored alias has its name (src/memory/aliases.ts).
    const ranked = topByRank(aliases, cap, MEMORY_LIMITS.aliasHalfLifeDays) as Array<{ name: string }>;
    const names = ranked.map((item) => item.name);
    if (names.length === 0) return '';
    return fill(template, { name: normalized.authorName, aliases: names.join(', ') });
  }

  return { buildClassifierRequest };
}
