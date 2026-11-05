// How a call that cannot be answered now is held: queued, or folded by the merge classifier (prompts/merge.md) into an
// item its author already waits for in that channel, the parts of their message a chain has not reached yet
// (turns.waitingParts) and their queued calls. createMessageHandler (src/behavior/pipeline.ts) builds it once with
// createMerge; the live path and a private message hold through holdCall.

import { SPAM_WINDOW_MS } from '../behavior/mention.ts';
import { authorCalls, foldInto, parseMergeAnswer } from '../behavior/pending.ts';
import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { block, fillPromptTemplate } from '../turn/request/text.ts';
import type { PendingQueueOps, PingKind } from './pending-queue.ts';
import { isDeferredFollowUp } from './pending-queue.ts';
import type {
  Conv,
  Line,
  MessageReadOptions,
  PendingQueue,
  Ping,
  PipelineConfig,
  PipelineHot,
  PipelineLlm,
  PipelineState,
  PipelineTurns,
  Thrown,
} from './types.ts';

/** One item an author waits for: a part of their message a chain has not reached, or a queued call. */
type WaitingItem = { kind: 'part'; index: number; text: string } | { kind: 'call'; id: string; text: string };

/** What createMerge reads: the dependencies of createMessageHandler, the queue and its other parts' functions. */
export type MergeContext = {
  hot: PipelineHot;
  llm: PipelineLlm | null | undefined;
  store: { state?: PipelineState } | null | undefined;
  now: () => number;
  turns: PipelineTurns;
  tagHistory: { hit: (authorId: string, at: number, windowMs: number) => number };
  getSelfName: (placeId: string) => string;
  pending: PendingQueue;
  itemText: PendingQueueOps['itemText'];
  enqueuePending: PendingQueueOps['enqueuePending'];
  turnBlocked: (placeId: string, config: PipelineConfig) => boolean;
  drainPending: () => Promise<void>;
};

export type HoldCall = (channel: Conv, trigger: Line, kind: PingKind, readOptions?: MessageReadOptions) => void;

export function createMerge({
  hot,
  llm,
  store,
  now,
  turns,
  tagHistory,
  getSelfName,
  pending,
  itemText,
  enqueuePending,
  turnBlocked,
  drainPending,
}: MergeContext): { holdCall: HoldCall } {
  /**
   * Hold a call that cannot be answered now (the live path and a private
   * message alike). A call whose author has nothing waiting
   * in that channel (no part of a chain not reached yet, no queued call), is
   * queued at once (enqueuePending). Otherwise the merge classifier is asked
   * (classifyMerge; the persona is busy, so this costs no reply time) whether
   * the call is about one of those items: about one, it is folded into it
   * (turns.addToPart for a part, foldInto for a queued call) -- no turn of its
   * own; its item's turn names it -- and a server call still counts toward the
   * member's repeat and spam counters (tagHistory), as it would at its own
   * turn; `new`, no verdict, or an item that stopped waiting meanwhile, it is
   * queued with its arrival time. Paused meanwhile, it is dropped (`mention:
   * dropped`, `paused`). Once it is queued, a drain starts if nothing blocks
   * it any more (drainPending). Never throws.
   */
  function holdCall(channel: Conv, trigger: Line, kind: PingKind, readOptions?: MessageReadOptions): void {
    const items = readOptions?.memoryContext ? [] : waitingItems(channel.id, trigger.authorId);
    if (items.length === 0) {
      enqueuePending(channel, trigger, kind, undefined, readOptions);
      return;
    }
    const arrivedAt = now();
    foldOrQueue({ channel, trigger, kind, items, arrivedAt }).catch((err: unknown) => {
      log.error('merge: failed', { channel: channel.id, reason: 'error', status: null, error: err });
    });
  }

  /**
   * The items `authorId` waits for in `placeId`, in order: the parts of their
   * message a chain there has not reached yet, then their queued calls.
   */
  function waitingItems(placeId: string, authorId: string): Array<WaitingItem> {
    let parts: Array<{ index: number; text: string }> = [];
    try {
      const found = turns.waitingParts?.(placeId, authorId);
      // A chain's waiting parts carry their index and text (src/behavior/turn.ts#waitingParts).
      parts = Array.isArray(found) ? (found as Array<{ index: number; text: string }>) : [];
    } catch {
      parts = [];
    }
    return [
      ...parts.map((part) => ({ kind: 'part' as const, index: part.index, text: itemText(part.text) })),
      // A deferred follow-up or overheard line is not one: it may still be dropped (window closed, answered).
      ...(authorCalls(pending.list, placeId, authorId) as Array<Ping>)
        .filter((p) => !isDeferredFollowUp(p) && !p.readOptions?.memoryContext)
        .map((p) => ({ kind: 'call' as const, id: p.trigger.id, text: itemText(p.trigger.content) })),
    ];
  }

  /** holdCall's asynchronous side: the merge verdict, then the fold or the queue. */
  async function foldOrQueue({
    channel,
    trigger,
    kind,
    items,
    arrivedAt,
  }: {
    channel: Conv;
    trigger: Line;
    kind: PingKind;
    items: Array<WaitingItem>;
    arrivedAt: number;
  }): Promise<void> {
    const index = await classifyMerge(channel, trigger, items);
    if (store?.state?.data?.paused) {
      log.info('mention: dropped', { channel: channel.id, kind, reason: 'paused' });
      return;
    }
    const item = index ? items[index - 1] : null;
    if (item) {
      const message = { id: trigger.id, text: itemText(trigger.content), ts: trigger.ts };
      let folded = false;
      if (item.kind === 'part') {
        folded = turns.addToPart?.(channel.id, trigger.authorId, item.index, message) === true;
      } else {
        const result = foldInto(pending.list, item.id, message) as { list: Array<Ping>; folded: boolean };
        pending.list = result.list;
        folded = result.folded;
      }
      if (folded) {
        if (kind !== 'private') tagHistory.hit(trigger.authorId, now(), SPAM_WINDOW_MS);
        return;
      }
    }
    enqueuePending(channel, trigger, kind, arrivedAt);
    if (!turnBlocked(channel.id, hot.config)) {
      drainPending().catch((err: unknown) => log.error('mention: drain failed', { error: err }));
    }
  }

  /**
   * One merge classifier call: is `trigger` (a call of an author with `items`
   * waiting) about one of them? System = prompts.merge with `{{name}}`; user
   * = `<waiting>` (the items as `<n>. <text>` lines from 1) then
   * `<candidate>` (`<author>: <text>`). An `analyzer` request (
   * mention.followUpMaxOutputTokens, purpose `merge`). Resolves the item's
   * 1-based index (`merge: verdict`, `answer: 'item'`), or null for `new`
   * (`answer: 'new'`) and for every other outcome, logged as `merge: failed`
   * with its reason: `no-prompt`, the rail's code or `llm-error` (with the
   * HTTP status), `empty`, `unparsed`, `out-of-range`. Codes and counts only.
   */
  async function classifyMerge(channel: Conv, trigger: Line, items: Array<WaitingItem>): Promise<number | null> {
    const conversationId = channel.id;
    const prompt = hot.prompts?.merge;
    if (!prompt || !llm) {
      log.info('merge: failed', { channel: conversationId, reason: 'no-prompt', status: null });
      return null;
    }
    const config = hot.config;
    const startedAt = now();
    const placeId = String(channel.rootId ?? channel.id);
    const waiting = items.map((item, i) => `${i + 1}. ${item.text}`).join('\n');
    const user = [
      block('waiting', waiting),
      block('candidate', `${trigger.authorName}: ${itemText(trigger.content)}`),
    ].join('\n');
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(prompt, { name: getSelfName(placeId) }) },
          { role: 'user', content: user },
        ],
        {
          model: roleModel(config, 'analyzer', 'merge'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: config.mention?.followUpMaxOutputTokens,
            purpose: 'merge',
          }),
        }
      );
    } catch (err) {
      log.warn('merge: failed', {
        channel: conversationId,
        reason: railReason(err),
        status: (err as Thrown)?.statusCode ?? null,
      });
      return null;
    }
    const { index, reason } = parseMergeAnswer(completion?.text, items.length);
    if (reason !== 'item' && reason !== 'new') {
      log.warn('merge: failed', { channel: conversationId, reason, status: null });
      return null;
    }
    log.info('merge: verdict', {
      channel: conversationId,
      waiting: items.length,
      answer: index ? 'item' : 'new',
      ms: now() - startedAt,
    });
    return index;
  }

  return { holdCall };
}
