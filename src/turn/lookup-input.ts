// The input of a classifier request over the chat before a trigger (the re-watch and the search classifier): the
// `<transcript>` block and the trigger's text. src/behavior/turn.js builds both classifiers' requests with it, and
// tools/search-policy-eval.mjs measures the search classifier's input through the re-export there.

import { classifierTranscript } from '../behavior/prompt.js';

/** The config keys these inputs read. */
type LookupConfig = Record<string, unknown> & {
  context?: { maxMessageChars?: number };
  web?: { search?: { contextMessages?: number } };
};

/** A line of the history, as far as these inputs read it; the rest goes to the transcript as it is. */
type HistoryLine = Record<string, unknown> & { id?: unknown };

/** The trigger message, as far as these inputs read it. */
type Trigger = Record<string, unknown> & { id?: unknown; content?: string | null; authorName: string };

export type ClassifierContextInput = {
  config: LookupConfig;
  labels: object;
  selfName: string;
  history: ReadonlyArray<HistoryLine>;
  trigger: Trigger;
  descriptions?: Map<string, unknown>;
  videos?: Map<string, unknown>;
  reads?: Map<string, unknown>;
};

/**
 * The `<transcript>` block of a classifier request (re-watch, search): the
 * last `contextMessages` messages of `history` before the trigger, rendered
 * by src/behavior/prompt.js#classifierTranscript (as the route classifier's)
 * with the media states the caller already has, plus the trigger's text cut to
 * `context.maxMessageChars`. `transcriptBlock` is '' (no block) for a
 * window of 0 or no earlier message. Pure.
 */
export function renderClassifierContext({
  config,
  labels,
  selfName,
  history,
  trigger,
  contextMessages,
  descriptions,
  videos,
  reads,
}: ClassifierContextInput & { contextMessages: number }): { triggerText: string; transcriptBlock: string } {
  const triggerText = [...String(trigger.content ?? '')].slice(0, config.context?.maxMessageChars ?? 2000).join('');
  const context = contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-contextMessages) : [];
  if (context.length === 0) return { triggerText, transcriptBlock: '' };
  const body = classifierTranscript(context, { config, selfName, labels, descriptions, videos, reads });
  return { triggerText, transcriptBlock: `<transcript>\n${body}\n</transcript>\n` };
}

/**
 * The user message of the search classifier (prompts.lookup) as a live turn
 * sends it (createTurnRunner's maybeLookup): the `<transcript>` of the last
 * `web.search.contextMessages` (50 when missing) messages of `history` before
 * `trigger` (renderClassifierContext, `labels` = prompts.labels), then the
 * trigger as `<candidate>` with its author's name. Exported so
 * tools/search-policy-eval.mjs measures exactly what production sends. Pure.
 */
export function lookupClassifierInput({
  config,
  labels,
  selfName,
  history,
  trigger,
  descriptions,
  videos,
  reads,
}: ClassifierContextInput): { triggerText: string; transcriptBlock: string; user: string } {
  const contextMessages = Math.max(0, Math.floor(config.web?.search?.contextMessages ?? 50));
  const { triggerText, transcriptBlock } = renderClassifierContext({
    config,
    labels,
    selfName,
    history,
    trigger,
    contextMessages,
    descriptions,
    videos,
    reads,
  });
  return {
    triggerText,
    transcriptBlock,
    user: `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`,
  };
}
