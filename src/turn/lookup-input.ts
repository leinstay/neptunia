// The input of a classifier request over the chat before a trigger: the `<transcript>` block and the trigger's text.

import { classifierTranscript } from '../behavior/prompt.ts';
import { MAX_MESSAGE_CHARS, noLegend } from '../format.ts';

/** The live config, handed on to the transcript. */
type LookupConfig = Record<string, unknown>;

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
 * The `<transcript>` block of a classifier request (re-watch): the
 * last `contextMessages` messages of `history` before the trigger, rendered
 * by src/behavior/prompt.ts#classifierTranscript (as the route classifier's)
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
  // A classifier reads the lines for what is asked, with no legend of their custom emoji and stickers.
  const body = classifierTranscript(context, {
    config,
    selfName,
    labels,
    descriptions,
    videos,
    reads,
    mediaNameOf: noLegend,
  });
  return { triggerText, transcriptBlock: `<transcript>\n${body}\n</transcript>\n` };
}
