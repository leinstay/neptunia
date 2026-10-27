// What the recall runner (src/behavior/recall-run.js) does with the interface's reads that needs none of its state: a
// search hit read as the clustering takes it, a search plan entry written as the interface's message search takes it,
// a history read turned into lines, and the wait on a read that cannot be cancelled.

import type { Reads } from '../interface/reads.ts';
import type { HistoryQuery, MessageHit } from '../protocol/adapter.ts';
import { lineOf } from './line-of.js';
import { objOf } from '../tools/types.ts';

/** A search hit as the clustering reads it; `queries` holds the keys of the queries that found it. */
export type RecallHit = {
  id: string;
  channelId: string;
  ts: number;
  authorId: string | null;
  bot: boolean;
  username: string | null;
  queries: Set<string>;
};

/** One entry of a search plan (src/behavior/recall.js#searchPlan). */
export type PlannedQuery = {
  kind: string;
  content?: string;
  authorId?: string;
  after?: number;
  before?: number;
  offset?: number;
};

/** A search hit of the interface (a message reference, a time, a text, an author) as the clustering reads it. */
export function hitFrom(hit: MessageHit): RecallHit {
  return {
    id: hit.ref.messageId,
    channelId: hit.ref.conversationId,
    ts: hit.at,
    authorId: hit.author.id ?? null,
    bot: hit.author.bot,
    username: hit.author.handle ?? null,
    queries: new Set(),
  };
}

/** Whether the conversation belongs to a community (a private chat does not). */
export const inCommunity = (channel: unknown): boolean => objOf(channel).communityId != null;

/** A search plan entry as the interface's message search takes it. */
export function searchQueryOf(planned: unknown): Parameters<Reads['searchMessages']>[1] {
  const query = planned as PlannedQuery;
  return {
    ...(query.kind === 'form' || query.kind === 'who' ? { text: query.content } : {}),
    ...(query.kind === 'author' ? { authorId: query.authorId } : {}),
    ...(Number.isFinite(query.after) ? { after: query.after } : {}),
    ...(Number.isFinite(query.before) ? { before: query.before } : {}),
    ...(query.offset !== undefined && Number.isInteger(query.offset) && query.offset > 0
      ? { offset: query.offset }
      : {}),
  };
}

/** `promise` unless `signal` aborts first, then null: a read cannot be cancelled, only left behind. */
export function untilAborted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(null);
      }
    );
  });
}

/** The messages of a read of a conversation's history as lines, oldest first; null when the read failed. */
export async function linesOf(
  reads: Reads,
  source: unknown,
  query: HistoryQuery
): Promise<Array<Record<string, unknown>> | null> {
  const entry = source as { iface: string; id: string };
  const found = await reads.history({ iface: entry.iface, conversationId: entry.id }, query);
  return found === null ? null : found.events.map((event) => lineOf(event));
}
