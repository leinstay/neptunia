// What the recall runner (src/behavior/recall-run.ts) decides that needs none of its state: whether a turn may read
// stored recall, whether a chat belongs to a root, which lines of the turn's history a search leaves out, and the open
// memory database.

import { isIssuedInternalContext } from '../memory/db/scope.ts';
import type { ChatRef } from '../protocol/adapter.ts';
import type { ResolvedRecallAnchor } from '../memory/db/recall.ts';
import { locatorText } from '../memory/db/message-locator.ts';
import { objOf } from '../tools/types.ts';

/** Stored recall needs an ordinary chat context or a trusted issued internal context. */
export function hasRecallContext({
  channel,
  partnerId,
  memoryContext,
}: {
  channel: unknown;
  partnerId?: string | null;
  memoryContext: unknown;
}): boolean {
  return isIssuedInternalContext(memoryContext) || inRoot(channel) || Boolean(partnerId);
}

/** Whether the chat belongs to a root (a private chat does not). */
export const inRoot = (channel: unknown): boolean => objOf(channel).rootId != null;

/** Validate one history line without substituting a route for malformed metadata. */
function historyExclusion(value: unknown, ref: ChatRef | null): ResolvedRecallAnchor | null {
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
    return locatorText(native.iface) && locatorText(native.chatId) && locatorText(native.messageId)
      ? {
          kind: 'native',
          locator: { iface: native.iface, chatId: native.chatId, messageId: native.messageId },
        }
      : null;
  }
  if (!ref || !locatorText(ref.iface) || !locatorText(line.id)) return null;
  if (line.iface !== undefined && line.iface !== ref.iface) return null;
  const chatId = line.placeId === undefined ? ref.chatId : line.placeId;
  return locatorText(chatId) ? { kind: 'native', locator: { iface: ref.iface, chatId, messageId: line.id } } : null;
}

/** Keep visible history identities separate from unqualified native message IDs. */
export function historyExclusions({
  history,
  historyRef,
  context,
  channel,
}: {
  history: unknown;
  historyRef?: ChatRef;
  context: unknown;
  channel: unknown;
}): Array<ResolvedRecallAnchor> {
  const ctx = objOf(context);
  const placeId = objOf(channel).id;
  const ref =
    historyRef ?? (locatorText(ctx.iface) && locatorText(placeId) ? { iface: ctx.iface, chatId: placeId } : null);
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
