// The `<transcript>` input every classifier of a turn reads, and the video state the turn knows. createTurnRunner
// (src/behavior/turn.js) builds it once per runner with createRewatch; the splitter calls classifierContext.

import { renderClassifierContext } from './lookup-input.ts';
import type { ClassifierContextInput } from './lookup-input.ts';

/** What the turn knows of a video: its watch state, its caption and an answer to a question about it. */
export type VideoState = { state: string; text?: string; answer?: unknown; [key: string]: unknown };

/** The language model client (src/llm/openrouter.js#createLlm), as a classifier asks it. */
export type ClassifierLlm = {
  complete: (messages: Array<{ role: string; content: string }>, options: object) => Promise<{ text?: string | null }>;
};

/** What createRewatch reads: the live prompts. */
export type RewatchContext = {
  hot: { readonly prompts: { labels: object } };
};

export type Rewatch = {
  classifierContext: (params: Omit<ClassifierContextInput, 'labels'> & { contextMessages: number }) => {
    triggerText: string;
    transcriptBlock: string;
  };
};

export function createRewatch(ctx: RewatchContext): Rewatch {
  const { hot } = ctx;

  /**
   * The `<transcript>` block of a classifier request with the media states this turn already has:
   * renderClassifierContext over the live labels (prompts.labels, read now).
   */
  function classifierContext(params: Omit<ClassifierContextInput, 'labels'> & { contextMessages: number }): {
    triggerText: string;
    transcriptBlock: string;
  } {
    return renderClassifierContext({ ...params, labels: hot.prompts.labels });
  }

  return { classifierContext };
}
