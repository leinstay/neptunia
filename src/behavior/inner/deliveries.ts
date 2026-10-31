// A wake's sends after its completion (docs/inner-life.md "A wake's sends"). A live wake turn of a life that has a
// port gets a hold (src/tools/send-hold.ts): her posts wait in it, and the wake's fenced completion records each as a
// `deliveries` row under its effect key (wake-store.ts#finishTurn). After the completion commits, `sendDeliveries`
// sends the turn's rows through the port in order, each marked `sending` before the port is called and `sent`,
// `unknown` or `failed` by its answer. At a start, `resumeDeliveries` settles what a crash left: a row still `sending`
// lost its answer, so it is reconciled through the adapter (src/interface/reconcile.ts) and never sent blindly (found:
// `sent`; known not sent: `queued` again; the adapter cannot tell: `unknown`, never sent again), then every `queued`
// row is sent once. The drain (drain.ts) and the start's recovery (recovery.ts) call it; logs carry keys' counts and
// codes, never text.

import { reconcileUnknown } from '../../interface/reconcile.ts';
import { deliveriesIn, deliveryFiles, deliveryOf } from '../../memory/db/wake-queue.ts';
import type { Delivery, DeliveryInput, DeliveryState } from '../../memory/db/wake-queue.ts';
import type { Delivery as Sent, ConversationRef } from '../../protocol/adapter.ts';
import type { Content } from '../../protocol/actions.js';
import { createSendHold } from '../../tools/send-hold.ts';
import type { SendHold } from '../../tools/send-hold.ts';
import { errorCode, objOf } from '../../tools/types.ts';
import { backendOf, dbWrite } from './wake-store.ts';
import type { InnerContext } from './types.ts';

/** The hold of a wake turn: one for a live turn of a life with a port to send through, else null (sends go out). */
export function holdFor(life: InnerContext, shadow: boolean): SendHold | null {
  return life.port !== null && !shadow ? createSendHold() : null;
}

/** The deliveries of a turn's held sends as the completion records them: the conversation, the content, the files. */
export function deliveriesOf(hold: SendHold | null | undefined): Array<DeliveryInput> {
  return (hold?.sends ?? []).map(({ key, conversation, content }) => ({
    key,
    target: conversation.conversationId,
    payload: {
      conversation: { iface: conversation.iface, conversationId: conversation.conversationId },
      content: { text: content.text ?? '', replyTo: content.replyTo ?? null, mentions: content.mentions ?? null },
    },
    files: content.attachments ?? [],
  }));
}

/** The conversation a delivery goes to, or null when its payload names none. */
function conversationOf(delivery: Delivery): ConversationRef | null {
  const given = objOf(objOf(delivery.payload).conversation);
  return typeof given.iface === 'string' && typeof given.conversationId === 'string'
    ? { iface: given.iface, conversationId: given.conversationId }
    : null;
}

/** What a delivery carries, its kept files read back from the data directory. */
function contentOf(life: InnerContext, delivery: Delivery): Content {
  const given = objOf(objOf(delivery.payload).content);
  const read = backendOf(life).read();
  const attachments = read ? deliveryFiles(read, life.dataDir, delivery) : [];
  // The payload is what deliveriesOf recorded from a send's content (src/protocol/actions.js#Content).
  const replyTo = given.replyTo as Content['replyTo'] | null;
  const mentions = given.mentions as Content['mentions'] | null;
  return {
    text: typeof given.text === 'string' ? given.text : '',
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(mentions ? { mentions } : {}),
  };
}

/** Delivery `key` moved from one of `from` to `to` with its receipt; whether it moved (a failed write is logged). */
async function move(
  life: InnerContext,
  key: string,
  from: ReadonlyArray<DeliveryState>,
  to: DeliveryState,
  receipt: unknown = null
): Promise<boolean> {
  try {
    const moved = await dbWrite(life, { kind: 'wake-queue', op: 'delivery', key, from, to, now: life.now(), receipt });
    return moved === true;
  } catch {
    // Logged by the chain (wake-store.ts#dbWrite).
    return false;
  }
}

/** What a send answered, kept on its row: the messages it became, or its error code. */
function receiptOf(answer: Sent): unknown {
  return answer.status === 'ok'
    ? { messageIds: answer.parts.map((part) => part.messageId ?? null) }
    : { code: answer.error?.code ?? answer.status };
}

/** The state a send's answer leaves its delivery in. */
const settledState = (answer: Sent): DeliveryState =>
  answer.status === 'ok' ? 'sent' : answer.status === 'unknown' ? 'unknown' : 'failed';

/**
 * One queued delivery sent: marked `sending`, sent under its key, then settled by the answer. A content whose files
 * cannot be read leaves the row `queued` for the next start.
 */
async function sendOne(life: InnerContext, delivery: Delivery): Promise<void> {
  const { port, log } = life;
  const conversation = conversationOf(delivery);
  if (!port || !conversation) return;
  let content: Content;
  try {
    content = contentOf(life, delivery);
  } catch (err) {
    log.warn('inner: delivery content not read', { code: errorCode(err) });
    return;
  }
  if (!(await move(life, delivery.key, ['queued'], 'sending'))) return;
  let answer: Sent;
  try {
    answer = await port.send(conversation, content, { idempotencyKey: delivery.key });
  } catch (err) {
    // A throw after the call may have reached the interface: its outcome is not known.
    answer = { status: 'unknown', ref: null, parts: [], at: null, idempotencyKey: delivery.key, error: null };
    log.warn('inner: delivery send threw', { code: errorCode(err) });
  }
  await move(life, delivery.key, ['sending'], settledState(answer), receiptOf(answer));
  if (answer.status !== 'ok')
    log.warn('inner: delivery not sent', { status: answer.status, code: answer.error?.code ?? null });
}

/** The deliveries `keys` (a completion's, in order) sent once each; a row no longer `queued` is left as it is. */
export async function sendDeliveries(life: InnerContext, keys: ReadonlyArray<string>): Promise<void> {
  for (const key of keys) {
    const read = backendOf(life).read();
    const delivery = read ? deliveryOf(read, key) : null;
    if (delivery?.state === 'queued') await sendOne(life, delivery);
  }
}

/**
 * The deliveries a crash left, settled at a start: each `sending` one reconciled by its key (found: `sent`; known not
 * sent: `queued`; not known: `unknown`), then each `queued` one sent once, in the order they were recorded.
 */
export async function resumeDeliveries(life: InnerContext): Promise<void> {
  const { port, log } = life;
  const read = backendOf(life).read();
  if (!port || !read) return;
  const lost = deliveriesIn(read, 'sending');
  for (const delivery of lost) {
    const conversation = conversationOf(delivery);
    // A read that throws says nothing: the row stays `sending` for the next start.
    const found = conversation
      ? await reconcileUnknown(port, { conversation, idempotencyKey: delivery.key }).catch(() => null)
      : ({ status: 'unknown', ref: null, parts: [], at: null, idempotencyKey: delivery.key, error: null } as const);
    if (found === null) continue;
    const to: DeliveryState = found.status === 'ok' ? 'sent' : found.status === 'failed' ? 'queued' : 'unknown';
    await move(life, delivery.key, ['sending'], to, to === 'queued' ? null : receiptOf(found));
  }
  const queued = deliveriesIn(backendOf(life).read() ?? read, 'queued');
  for (const delivery of queued) await sendOne(life, delivery);
  if (lost.length + queued.length > 0)
    log.info('inner: deliveries resumed', { lost: lost.length, queued: queued.length });
}
