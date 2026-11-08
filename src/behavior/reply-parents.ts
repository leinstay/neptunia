// The messages that lines of the history reply to but that lie outside it (a reply to something older than the window),
// read through the interface's `fetchMessages` and turned into lines like any history line, oldest first: the caller
// prepends them so the transcript can show what a reply answers. Asked in this order until `max` lines are read: the
// parent of `trigger` (when given; its own line may be in the history or not), then that parent's parent when the
// parent is itself a reply to a message outside the window (one level, so a short chain reads), then the parents of the
// last `recent` lines of the history, newest first. A parent already in the history or already read is not asked
// again. A parent that cannot be read (deleted, no access, any error) is skipped and logged once (`collect: parent
// missing`, ids only).

import type { ChatRef } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.ts';
import { lineOf } from './line-of.ts';
import type { Line } from './lines.ts';

type Trigger = { id?: string; replyToId?: string | null } | null;

export async function fetchReplyParents(
  reads: Reads,
  ref: ChatRef,
  history: ReadonlyArray<Line>,
  { trigger = null, recent, max }: { trigger?: Trigger; recent: number; max: number }
): Promise<Array<Line>> {
  const found: Array<Line> = [];
  if (!(max > 0)) return found;
  const asked = new Set(history.map((line) => line.id));
  if (trigger?.id) asked.add(trigger.id);

  const fetchParent = async (id: string | null | undefined): Promise<Line | null> => {
    if (!id || asked.has(id) || found.length >= max) return null;
    asked.add(id);
    const answer = await reads.fetchMessages(ref, [id]);
    const parentMessage = answer?.messages[0];
    const event = parentMessage?.event;
    if (event === undefined || parentMessage?.missing === true) {
      log.info('collect: parent missing', { channel: ref.chatId, messageId: id });
      return null;
    }
    const parent = lineOf(event) as Line;
    found.push(parent);
    return parent;
  };

  const parent = await fetchParent(trigger?.replyToId ?? null);
  if (parent) await fetchParent(parent.replyToId);
  const tail = recent > 0 ? history.slice(-recent).reverse() : [];
  for (const line of tail) await fetchParent(line.replyToId ?? null);

  return found.sort((a, b) => a.ts - b.ts);
}
