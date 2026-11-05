// What the recall runner (src/behavior/recall-run.ts) does with the interface's reads that needs none of its state: a
// search hit read as the clustering takes it, a search plan entry written as the interface's message search takes it,
// a history read turned into lines, and the wait on a read that cannot be cancelled.

import { isIssuedInternalContext } from '../memory/db/scope.ts';
import type { Reads } from '../interface/reads.ts';
import type { ConversationRef, HistoryQuery, MessageHit } from '../protocol/adapter.ts';
import { lineOf } from './line-of.ts';
import type { ResolvedRecallAnchor } from '../memory/db/recall.ts';
import { locatorText } from '../memory/db/message-locator.ts';
import { objOf } from '../tools/types.ts';

/** Stored recall needs an ordinary conversation context or a trusted issued internal context. */
export function hasRecallContext({
  channel,
  partnerId,
  memoryContext,
}: {
  channel: unknown;
  partnerId?: string | null;
  memoryContext: unknown;
}): boolean {
  return isIssuedInternalContext(memoryContext) || inCommunity(channel) || Boolean(partnerId);
}

/** A search hit as the clustering reads it; `queries` holds the keys of the queries that found it. */
export type RecallHit = {
  id: string;
  placeId: string;
  ts: number;
  authorId: string | null;
  bot: boolean;
  username: string | null;
  queries: Set<string>;
};

/** One entry of a search plan (src/behavior/recall.ts#searchPlan). */
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
    placeId: hit.ref.conversationId,
    ts: hit.at,
    authorId: hit.author.id ?? null,
    bot: hit.author.bot,
    username: hit.author.handle ?? null,
    queries: new Set(),
  };
}

/** Whether the conversation belongs to a community (a private chat does not). */
export const inCommunity = (channel: unknown): boolean => objOf(channel).rootId != null;

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

/** The summary prompt, or null when it is missing or blank. */
export function summaryPrompt(prompts: unknown): string | null {
  const prompt = objOf(prompts)['recall-summary'];
  return typeof prompt === 'string' && prompt.trim() ? prompt : null;
}

/** The kind of a failed summary request. */
export function summaryFailure(error: unknown): 'timeout' | 'failed' {
  return objOf(error).name === 'TimeoutError' ? 'timeout' : 'failed';
}

/** Validate one history line without substituting a route for malformed metadata. */
function historyExclusion(value: unknown, ref: ConversationRef | null): ResolvedRecallAnchor | null {
  const line = objOf(value);
  if (Object.hasOwn(line, 'stored')) {
    const stored = objOf(line.stored);
    return locatorText(stored.sourceId) &&
      locatorText(stored.placeId) &&
      (stored.iface === null || locatorText(stored.iface))
      ? { kind: 'source', sourceId: stored.sourceId }
      : null;
  }
  if (Object.hasOwn(line, 'native')) {
    const native = objOf(line.native);
    return locatorText(native.iface) && locatorText(native.conversationId) && locatorText(native.messageId)
      ? {
          kind: 'native',
          locator: { iface: native.iface, conversationId: native.conversationId, messageId: native.messageId },
        }
      : null;
  }
  if (!ref || !locatorText(ref.iface) || !locatorText(line.id)) return null;
  if (line.iface !== undefined && line.iface !== ref.iface) return null;
  const conversationId = line.placeId === undefined ? ref.conversationId : line.placeId;
  return locatorText(conversationId)
    ? { kind: 'native', locator: { iface: ref.iface, conversationId, messageId: line.id } }
    : null;
}

/** Keep visible history identities separate from unqualified native message IDs. */
export function historyExclusions({
  history,
  historyRef,
  context,
  channel,
}: {
  history: unknown;
  historyRef?: ConversationRef;
  context: unknown;
  channel: unknown;
}): Array<ResolvedRecallAnchor> {
  const ctx = objOf(context);
  const placeId = objOf(channel).id;
  const ref =
    historyRef ??
    (locatorText(ctx.iface) && locatorText(placeId) ? { iface: ctx.iface, conversationId: placeId } : null);
  const exclusions: Array<ResolvedRecallAnchor> = [];
  if (!Array.isArray(history)) return exclusions;
  for (const value of history) {
    const exclusion = historyExclusion(value, ref);
    if (exclusion) exclusions.push(exclusion);
  }
  return exclusions;
}

/** The current recall database connection, or null while its service is unavailable. */
export function recallDatabase(memoryDb: { database(): unknown } | null | undefined): unknown {
  try {
    return typeof memoryDb?.database === 'function' ? (memoryDb.database() ?? null) : null;
  } catch {
    return null;
  }
}
