// The reconcile of a send whose outcome was lost. A send that may have reached the platform is `unknown`, and the
// core never sends it again to find out. When the adapter declares `capabilities().reconcile`, `reconcileUnknown`
// asks its `fetchMessages` for what it posted under the send's idempotency key: found, the send is `ok` with the
// messages it posted; absent, it is `failed`, known not to have happened. A read that fails, or an adapter that
// cannot reconcile, leaves the send `unknown`.
// TODO(core extraction stage 4, PR B): the journal's reconciliation of her unknown sends calls it.

import type { Adapter, ConversationRef, Delivery, MessageRef } from '../protocol/adapter.ts';

const outcome = (
  status: Delivery['status'],
  idempotencyKey: string,
  code: string | null,
  parts: ReadonlyArray<MessageRef> = []
): Delivery => ({
  status,
  ref: parts[0] ?? null,
  parts,
  at: null,
  idempotencyKey,
  error: code === null ? null : { code, retryable: false, retryAfterMs: null },
});

export async function reconcileUnknown(
  adapter: Pick<Adapter, 'capabilities' | 'fetchMessages'>,
  options: { conversation: ConversationRef; idempotencyKey: string }
): Promise<Delivery> {
  const { conversation, idempotencyKey } = options;
  if (adapter.capabilities().reconcile !== true) return outcome('unknown', idempotencyKey, 'not-reconcilable');
  const found = await adapter.fetchMessages(conversation, [], { idempotencyKey });
  if (found.status !== 'ok') return outcome('unknown', idempotencyKey, found.error.code);
  const parts = found.messages
    .filter((message) => message.missing !== true)
    .map((message) => ({
      iface: conversation.iface,
      conversationId: conversation.conversationId,
      messageId: message.messageId,
    }));
  if (parts.length === 0) return outcome('failed', idempotencyKey, 'not-sent');
  return outcome('ok', idempotencyKey, null, parts);
}
