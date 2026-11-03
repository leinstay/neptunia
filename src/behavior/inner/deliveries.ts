// Live wake turns hold sends until their fenced completion commits, then send them through the guarded port.
// Startup retires queued deliveries and reconciles sending deliveries without sending again. Confirmed posts keep
// their originating wake community and native conversation in the record. Live send failures create feedback;
// startup recovery creates no action. Logs carry counts and codes.

import { reconcileUnknown } from '../../interface/reconcile.ts';
import { toRecordLine } from '../../memory/record.ts';
import { wakeOf, deliveriesIn, deliveryFiles, deliveryOf } from '../../memory/db/wake-queue.ts';
import type { Delivery, DeliveryInput, DeliveryState } from '../../memory/db/wake-queue.ts';
import type { Delivery as Sent, ConversationRef } from '../../protocol/adapter.ts';
import type { Content } from '../../protocol/actions.ts';
import { isPublicationBoundary, publicationRefusal, refusedPublication } from '../../tools/publication.ts';
import { createSendHold } from '../../tools/send-hold.ts';
import type { HeldNote, SaidNote, SendHold } from '../../tools/send-hold.ts';
import { errorCode, objOf } from '../../tools/types.ts';
import { addFact, enqueue, mayAct, save, stateOf } from './queue.ts';
import { backendOf, dbWrite } from './wake-store.ts';
import type { InnerContext, InnerJournalOp } from './types.ts';

/** The hold of a wake turn: one for a live turn of a life with a port to send through, else null (sends go out). */
export function holdFor(life: InnerContext, shadow: boolean): SendHold | null {
  return life.port !== null && !shadow ? createSendHold() : null;
}

/** The turn a delivery comes from: its id and its causal chain. */
export type DeliveryTurn = { turnId: string; chainId: string };

/**
 * The deliveries of a turn's held sends as the completion records them: the conversation, the content, the files, and
 * what the turn noted (the skill, her said line) with the turn's id and chain.
 */
export function deliveriesOf(hold: SendHold | null | undefined, turn: DeliveryTurn): Array<DeliveryInput> {
  return (hold?.sends ?? []).map(({ key, conversation, content, note, publicationBoundary }) => ({
    key,
    target: conversation.conversationId,
    payload: {
      conversation: { iface: conversation.iface, conversationId: conversation.conversationId },
      content: { text: content.text ?? '', replyTo: content.replyTo ?? null, mentions: content.mentions ?? null },
      ...turn,
      ...(publicationBoundary ? { publicationBoundary } : {}),
      skill: note?.skill ?? null,
      privateChat: note?.privateChat === true,
      said: note?.said ?? null,
    },
    files: content.attachments ?? [],
  }));
}

/** What the turn noted on a delivery, with its turn, as the payload keeps them. */
type Noted = Omit<HeldNote, 'skill'> & Partial<DeliveryTurn> & { skill: string | null };

function notedOf(delivery: Delivery): Noted {
  const payload = objOf(delivery.payload);
  const said = objOf(payload.said);
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  return {
    skill: text(payload.skill),
    privateChat: payload.privateChat === true,
    turnId: text(payload.turnId) ?? undefined,
    chainId: text(payload.chainId) ?? undefined,
    said:
      typeof said.text === 'string'
        ? {
            text: said.text,
            replyId: text(said.replyId),
            repliedAuthorId: text(said.repliedAuthorId),
            userIds: Array.isArray(said.userIds) ? said.userIds.filter((id) => typeof id === 'string') : [],
          }
        : null,
  };
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
  // The payload is what deliveriesOf recorded from a send's content (src/protocol/actions.ts#Content).
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
 * Her said line of a sent `message.create` in the record (features.record exactly true, read now), with the message
 * the send became and the turn's id, as recordSaid writes a sent post's. Not awaited; a refused append is logged.
 */
function recordSaid(
  life: InnerContext,
  guildId: string,
  delivery: Delivery,
  { messageId, at, opId }: { messageId: string | null; at: number | null; opId: string | null }
): void {
  const { record, now, log } = life;
  const noted = notedOf(delivery);
  const said: SaidNote | null = noted.said;
  if (!said || !messageId || typeof record?.append !== 'function') return;
  const line: unknown = toRecordLine(
    {
      id: messageId,
      channelId: delivery.target,
      content: said.text,
      ts: at ?? now(),
      replyToId: said.replyId,
      replyToAuthorId: said.repliedAuthorId,
      mentionedUserIds: said.userIds,
    },
    { kind: 'said', now, turnId: noted.turnId ?? null, opId }
  );
  const failed = (err: unknown): void => log.warn('inner: record failed', { lines: 1, code: errorCode(err) });
  try {
    Promise.resolve(record.append(guildId, [line], {})).catch(failed);
  } catch (err) {
    failed(err);
  }
}

/** The `post` operation of the delivery's turn in the journal (features.journal exactly true, read now), or null. */
function postOp(life: InnerContext, guildId: string, delivery: Delivery): InnerJournalOp | null {
  const { journal } = life;
  const noted = notedOf(delivery);
  if (!noted.said || !noted.turnId || typeof journal?.op !== 'function') return null;
  return journal.op(guildId, {
    turnId: noted.turnId,
    name: 'post',
    by: 'persona',
    channelId: delivery.target,
    privateUserId: null,
    intent: { replyTo: noted.said.replyId, text: noted.said.text },
    participants: noted.said.repliedAuthorId ? [noted.said.repliedAuthorId] : [],
    sourceMessageIds: noted.said.replyId ? [noted.said.replyId] : [],
  });
}

/**
 * A send that did not go out, told to her: a `callFailed` fact in its conversation, and one `feedback` wake there
 * (`inner.wake:feedback:delivery:<key>`) so her next turn carries it with the facts it is shown.
 */
async function tellFailed(life: InnerContext, guildId: string, delivery: Delivery, answer: Sent): Promise<void> {
  const noted = notedOf(delivery);
  const state = stateOf(life, guildId);
  const at = life.now();
  addFact(life, state, {
    at,
    kind: 'callFailed',
    skill: noted.skill ?? 'message.create',
    status: answer.status === 'unknown' ? 'unknown' : 'failed',
    code: answer.error?.code ?? answer.status,
    channelId: delivery.target,
    privateChat: noted.privateChat,
  });
  save(life, guildId);
  await enqueue(life, guildId, {
    id: `inner.wake:feedback:delivery:${delivery.key}`,
    kind: 'feedback',
    reason: 'feedback',
    intentionIds: [],
    chainId: noted.chainId ?? `delivery:${delivery.key}`,
    dueAt: at,
    channelId: delivery.target,
    privateChat: noted.privateChat,
    here: delivery.target,
    turnId: noted.turnId ?? null,
    // The fact is one of those her turn there is shown, not one this wake owns: it has no fact of its own.
    facts: [],
    factIds: [],
  });
}

function deliveryPublicationRefused(payload: unknown, conversation: ConversationRef): boolean {
  const value = objOf(payload);
  if (!Object.hasOwn(value, 'publicationBoundary')) return false;
  const boundary = value.publicationBoundary;
  return !isPublicationBoundary(boundary) || publicationRefusal(boundary, conversation) !== null;
}

/**
 * One queued delivery sent: marked `sending`, sent under its key, then settled by the answer, recorded when it went
 * out and told to her when it did not. While her inner life is stopped, or when its files cannot be read, the row stays
 * `queued`.
 */
async function sendOne(life: InnerContext, guildId: string, delivery: Delivery): Promise<void> {
  const { port, log } = life;
  const conversation = conversationOf(delivery);
  if (!port || !conversation || !mayAct(life, guildId)) return;
  let content: Content;
  try {
    content = contentOf(life, delivery);
  } catch (err) {
    log.warn('inner: delivery content not read', { code: errorCode(err) });
    return;
  }
  if (!(await move(life, delivery.key, ['queued'], 'sending'))) return;
  const op = postOp(life, guildId, delivery);
  if (op) await op.started();
  let answer: Sent;
  try {
    const refused = deliveryPublicationRefused(delivery.payload, conversation);
    answer = refused
      ? refusedPublication(delivery.key)
      : await port.send(conversation, content, { idempotencyKey: delivery.key });
  } catch (err) {
    // A throw after the call may have reached the interface: its outcome is not known.
    answer = { status: 'unknown', ref: null, parts: [], at: null, idempotencyKey: delivery.key, error: null };
    log.warn('inner: delivery send threw', { code: errorCode(err) });
  }
  await move(life, delivery.key, ['sending'], settledState(answer), receiptOf(answer));
  const messageId = answer.ref?.messageId ?? answer.parts[0]?.messageId ?? null;
  if (answer.status === 'ok') {
    if (op) await op.succeeded({ messageId });
    recordSaid(life, guildId, delivery, { messageId, at: answer.at, opId: op?.opId ?? null });
    return;
  }
  if (op)
    await (answer.status === 'unknown'
      ? op.unknown({ code: answer.error?.code ?? null })
      : op.failed(answer.error?.code ?? answer.status));
  log.warn('inner: delivery not sent', { status: answer.status, code: answer.error?.code ?? null });
  await tellFailed(life, guildId, delivery, answer);
}

/** The deliveries `keys` (a completion's, in order) sent once each; a row no longer `queued` is left as it is. */
export async function sendDeliveries(life: InnerContext, guildId: string, keys: ReadonlyArray<string>): Promise<void> {
  for (const key of keys) {
    const read = backendOf(life).read();
    const delivery = read ? deliveryOf(read, key) : null;
    if (delivery?.state === 'queued') await sendOne(life, guildId, delivery);
  }
}

/** Retire queued deliveries and reconcile uncertain sends without issuing a send or a feedback wake. */
export async function resumeDeliveries(life: InnerContext): Promise<void> {
  const { port, log } = life;
  const read = backendOf(life).read();
  if (!read) return;
  const lost = deliveriesIn(read, 'sending');
  for (const delivery of lost) {
    const conversation = conversationOf(delivery);
    await move(life, delivery.key, ['sending'], 'unknown', { code: 'not-reconcilable' });
    const found =
      port && conversation
        ? await reconcileUnknown(port, { conversation, idempotencyKey: delivery.key }).catch(() => null)
        : null;
    if (!found || found.status === 'unknown') continue;
    const to = found.status === 'ok' ? 'sent' : 'failed';
    await move(life, delivery.key, ['unknown'], to, to === 'failed' ? { code: 'not-sent' } : receiptOf(found));
    const parent = wakeOf(read, delivery.wakeId);
    if (to === 'sent' && parent?.community)
      recordSaid(life, parent.community, delivery, {
        messageId: found.ref?.messageId ?? null,
        at: found.at,
        opId: null,
      });
  }
  const queued = deliveriesIn(backendOf(life).read() ?? read, 'queued');
  for (const delivery of queued) await move(life, delivery.key, ['queued'], 'failed', { code: 'interrupted' });
  if (lost.length + queued.length > 0)
    log.info('inner: interrupted deliveries settled', { lost: lost.length, queued: queued.length });
}
