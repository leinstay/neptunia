// A wake's sends after its completion (docs/inner-life.md "A wake's sends"). A live wake turn of a life that has a
// port gets a hold (src/tools/send-hold.ts): her posts wait in it, and the wake's fenced completion records each as a
// `deliveries` row under its effect key (wake-store.ts#finishTurn). After the completion commits, `sendDeliveries`
// sends the turn's rows through the port in order, each marked `sending` before the port is called and `sent`,
// `unknown` or `failed` by its answer. At a start, `resumeDeliveries` settles what a crash left: a row still `sending`
// lost its answer, so it is reconciled through the adapter (src/interface/reconcile.ts) and never sent blindly (found:
// `sent`; known not sent: `queued` again; the adapter cannot tell: `unknown`, never sent again), then every `queued`
// row is sent once. Nothing is sent while her inner life is stopped (`mayAct`, asked before each send): the row stays
// `queued`. A sent post of `message.create` is recorded as a sent post of a message turn is
// (src/turn/journal-notes.ts#recordSaid): a `post` operation of the turn in the journal around the send, and her
// `said` line in the record with the turn's id. A send that did not go out (`failed` or `unknown`) is a `callFailed`
// fact in its conversation, and one `feedback` wake there carries it to her next turn; it is never sent again. The
// drain (drain.ts) and the start's recovery (recovery.ts) call it; logs carry counts and codes, never text.

import { reconcileUnknown } from '../../interface/reconcile.ts';
import { toRecordLine } from '../../memory/record.js';
import { deliveriesIn, deliveryFiles, deliveryOf } from '../../memory/db/wake-queue.ts';
import type { Delivery, DeliveryInput, DeliveryState } from '../../memory/db/wake-queue.ts';
import type { Delivery as Sent, ConversationRef } from '../../protocol/adapter.ts';
import type { Content } from '../../protocol/actions.js';
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
  return (hold?.sends ?? []).map(({ key, conversation, content, note }) => ({
    key,
    target: conversation.conversationId,
    payload: {
      conversation: { iface: conversation.iface, conversationId: conversation.conversationId },
      content: { text: content.text ?? '', replyTo: content.replyTo ?? null, mentions: content.mentions ?? null },
      ...turn,
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
 * Her said line of a sent `message.create` in the record (features.record exactly true, read now), with the message
 * the send became and the turn's id, as recordSaid writes a sent post's. Not awaited; a refused append is logged.
 */
function recordSaid(
  life: InnerContext,
  guildId: string,
  delivery: Delivery,
  { messageId, at, opId }: { messageId: string | null; at: number | null; opId: string | null }
): void {
  const { record, hot, now, log } = life;
  const noted = notedOf(delivery);
  const said: SaidNote | null = noted.said;
  if (!said || !messageId || typeof record?.append !== 'function') return;
  if (objOf(objOf(hot.config).features).record !== true) return;
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
  const { journal, hot } = life;
  const noted = notedOf(delivery);
  if (!noted.said || !noted.turnId || typeof journal?.op !== 'function') return null;
  if (objOf(objOf(hot.config).features).journal !== true) return null;
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
    answer = await port.send(conversation, content, { idempotencyKey: delivery.key });
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

/**
 * The deliveries a crash left, settled at a start: each `sending` one reconciled by its key (found: `sent`; known not
 * sent: `queued`; not known: `unknown`), then each `queued` one sent once, in the order they were recorded.
 */
export async function resumeDeliveries(life: InnerContext, guildId: string): Promise<void> {
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
    // A send the reconcile found went out under the dead process, which never recorded it.
    const messageId = found.ref?.messageId ?? null;
    if (to === 'sent') recordSaid(life, guildId, delivery, { messageId, at: found.at, opId: null });
    if (to === 'unknown') await tellFailed(life, guildId, delivery, found);
  }
  const queued = deliveriesIn(backendOf(life).read() ?? read, 'queued');
  for (const delivery of queued) await sendOne(life, guildId, delivery);
  if (lost.length + queued.length > 0)
    log.info('inner: deliveries resumed', { lost: lost.length, queued: queued.length });
}
