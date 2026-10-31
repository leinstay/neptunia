// The request of a classifier about one new message, shared by the address classifier and the room classifier: the
// prompt with the persona's name, the channel's last lines, the author's stored aliases and the new message as the
// candidate. createMessageHandler (src/behavior/pipeline.js) builds it once with createClassifierRequest.

import { historyLines } from '../behavior/lines.ts';
import { fill, formatTranscript, renderTranscript } from '../format.js';
import type { Reads } from '../interface/reads.ts';
import { topByRank } from '../memory/ranking.js';
import { fillPromptTemplate } from '../turn/request/text.ts';
import type { ConversationRef } from './conversations.ts';
import type { MediaPrefill } from './media-prefill.ts';
import type { Conv, Line, PipelineConfig, PipelineHot, PipelineLabels } from './types.ts';

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
  store: { getUser?: (guildId: string, userId: string) => { aliases?: unknown } | null | undefined } | null | undefined;
  refOf: (channel: Conv) => ConversationRef;
  cachedFollowUpMedia: MediaPrefill['cachedFollowUpMedia'];
};

export function createClassifierRequest({ reads, store, refOf, cachedFollowUpMedia }: ClassifierRequestContext): {
  buildClassifierRequest: (params: ClassifierParams) => Promise<ClassifierRequest | null>;
} {
  /**
   * The request of a classifier about one new message, shared by the address
   * classifier and the room classifier: system = `prompt` (address.md or
   * room.md, `{{name}}` filled), user = the last `mention.followUpContext`
   * lines of the channel, then an `<author>` block when the new message's
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
    const contextLines = Math.max(0, config.mention.followUpContext ?? 15);
    const raw = contextLines > 0 ? await historyLines(reads, refOf(channel), { limit: contextLines }) : [];
    // A history line is a normalized line as lineOf gives it (src/behavior/lines.ts).
    const history = raw.filter((m) => m.id !== normalized.id) as unknown as Array<Line>;
    const messages = [...history, normalized];
    // A served channel is in a community, so it has its id.
    const guildId = channel.communityId as string;
    const { descriptions, videos } = await cachedFollowUpMedia(guildId, messages, config, ownPrefill);
    const items = formatTranscript(messages, {
      timezone: config.bot.timezone,
      gapMinutes: config.context.gapMarkerMinutes,
      maxChars: config.context.maxMessageChars,
      selfName,
      labels,
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context.reactionsPerMessage,
      replyQuoteChars: config.context.replyQuoteChars,
      descriptions,
      videos,
    });
    const candidateItem = items[items.length - 1];
    // renderTranscript joins the rendered items into one text (src/format.js).
    const transcript = renderTranscript(items.slice(0, -1), config.bot.timezone, labels) as string;
    const author = followUpAuthorLine(guildId, normalized, config, labels);
    const authorBlock = author ? `\n<author>\n${author}\n</author>` : '';
    return {
      system: fillPromptTemplate(prompt, { name: selfName }),
      user: `${transcript}${authorBlock}\n<candidate>\n${candidateItem.text}\n</candidate>`,
      // The fetched lines themselves (never sent): a failed address call decides from them (activeExchangeWith).
      history,
    };
  }

  /**
   * The `<author>` block's one line: the candidate author's display name and
   * the top `mention.followUpAliases` stored aliases by rank (decayed with
   * `memory.aliasHalfLifeDays`, the same order the persona's own request
   * shows), filled into `labels.address.author` (`{name}`, `{aliases}`) --
   * so the classifier can tie a nickname in the persona's line to this
   * member. Read-only (`store.getUser`). `''` (no block) with no profile, no
   * aliases, a cap of 0 or no `labels.address.author`.
   */
  function followUpAuthorLine(
    guildId: string,
    normalized: Line,
    config: PipelineConfig,
    labels: PipelineLabels | undefined
  ): string {
    const template = labels?.address?.author;
    if (!template) return '';
    const cap = Math.max(0, Math.floor(config.mention?.followUpAliases ?? 5));
    if (!(cap > 0)) return '';
    const profile = store?.getUser?.(guildId, normalized.authorId);
    const aliases: Array<object> = Array.isArray(profile?.aliases) ? (profile.aliases as Array<object>) : [];
    // A stored alias has its name (src/memory/aliases.js).
    const ranked = topByRank(aliases, cap, config.memory?.aliasHalfLifeDays) as Array<{ name: string }>;
    const names = ranked.map((item) => item.name);
    if (names.length === 0) return '';
    return fill(template, { name: normalized.authorName, aliases: names.join(', ') });
  }

  return { buildClassifierRequest };
}
