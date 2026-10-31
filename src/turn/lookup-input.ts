// The input of a classifier request over the chat before a trigger: the `<transcript>` block and the trigger's text.
// The splitter builds its request with it, and tools/search-policy-eval.mjs measures the search classifier's input
// through the re-export in src/behavior/turn.js.

import { classifierTranscript } from '../behavior/prompt.js';
import { MAX_MESSAGE_CHARS } from '../format.js';

/** The live config, handed on to the transcript. */
type LookupConfig = Record<string, unknown>;

/** The chat lines before the trigger the search classifier reads. Production value, config cut of 2026-10-31. */
const SEARCH_CONTEXT_MESSAGES = 50;

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
 * `MAX_MESSAGE_CHARS`. `transcriptBlock` is '' (no block) for a
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
  const triggerText = [...String(trigger.content ?? '')].slice(0, MAX_MESSAGE_CHARS).join('');
  const context = contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-contextMessages) : [];
  if (context.length === 0) return { triggerText, transcriptBlock: '' };
  const body = classifierTranscript(context, { config, selfName, labels, descriptions, videos, reads });
  return { triggerText, transcriptBlock: `<transcript>\n${body}\n</transcript>\n` };
}

/**
 * The user message of the search classifier (prompts.lookup) as a live turn
 * sends it (createTurnRunner's maybeLookup): the `<transcript>` of the last
 * SEARCH_CONTEXT_MESSAGES messages of `history` before
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
  const contextMessages = SEARCH_CONTEXT_MESSAGES;
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
