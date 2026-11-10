// The first phase of a turn attempt: the pause and the attention taken, the chat as the interface describes
// it now, the journal's start and the wait for the trigger's author to finish writing. runAttempt
// (src/turn/phases/attempt.ts) calls it before every other phase; what it opens, the later phases use and the attempt's
// end closes.

import { currentIface } from '../../memory/db/current-iface.ts';
import { PERSONA_ID } from '../../memory/db/ids.ts';
import { sharedPlaceOf } from '../../memory/addresses.ts';
import { currentRequestMeta } from '../../llm/archive.ts';
import { createPrepLedger } from '../../behavior/turn-parts.ts';
import type { Ledger } from '../../behavior/turn-parts.ts';
import { log } from '../../log.ts';
import type { ChatInfo, ChatRef } from '../../protocol/adapter.ts';
import type { Draft } from '../draft.ts';
import { journalStartOf } from '../journal.ts';
import type { JournalStep } from '../lookup.ts';
import { inRoot } from '../routing.ts';
import { takeAttention } from '../triggers.ts';
import type { Ended, Life, PhaseContext, PhaseParams } from './context.ts';

/** What the preflight opened: the chat, the root it is served for and the attempt's lifecycle. */
export type Opened = {
  ended: null;
  prep: Ledger;
  prepStep: JournalStep;
  channel: ChatInfo;
  placeId: string;
  reading: ReadonlyArray<string>;
  libraryPlace: string;
  isDm: boolean;
  settledMs: number;
  life: Life;
};

/**
 * What a turn reads of the places around it: its own tree; a private chat, the servers of its interface; a turn of the
 * persona's own, every server. Nothing stands in as a home: all of them, under the rule of each read.
 */
function placesRead(
  store: { topPlaces?: (iface?: string) => Array<string> },
  iface: string,
  placeId: string,
  isDm: boolean
): ReadonlyArray<string> {
  if (isDm) return store.topPlaces?.(iface) ?? [];
  return placeId === PERSONA_ID ? (store.topPlaces?.() ?? []) : [placeId];
}

/**
 * The chat a turn with none runs in: no interface's, under her own place, so the journal keeps the turn under
 * herself and the frame finds no place. It is read by nothing: the turn reads no history and a tool that takes a place
 * needs it named.
 */
function nowhereOf(iface: string): ChatInfo {
  return {
    iface,
    id: PERSONA_ID,
    kind: 'channel',
    name: null,
    rootId: PERSONA_ID,
    topic: null,
    permissions: { read: true, send: true, attach: true, react: false },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
  };
}

/** The chat of a turn as the interface describes it now: a wake's own stand-in, nowhere with none, or null. */
async function chatNow(
  reads: PhaseContext['ifaceReads'],
  chat: ChatRef | null,
  standIn: ChatInfo | null
): Promise<{ chat: ChatInfo } | null> {
  if (standIn) return { chat: standIn };
  if (chat === null) return { chat: nowhereOf(currentIface() ?? '') };
  return reads.chatInfo(chat, { audience: true, viewers: [] });
}

export async function preflight(ctx: PhaseContext, params: PhaseParams, draft: Draft): Promise<Ended | Opened> {
  const { store, busy, ifaceReads, journal, journalOp, journalOn, notifyIdle, settleAuthor, clock } = ctx;
  const {
    chat,
    mode,
    trigger = null,
    triggerKind = null,
    reuseHistory = null,
    owned = false,
    journalTurn = null,
    taskResult = null,
    inner = null,
    standIn = null,
  } = params;
  // The journal's preparation steps of this attempt (createPrepLedger): each an operation of
  // the engine, closed with whether its result reached the request.
  const prep = createPrepLedger();
  const prepStep: JournalStep = (stage, name, fields, offeredOf) => {
    const op = journalOp(draft, name, 'engine', fields);
    // The ledger's step starts the journal operation, a promise of nothing, and hands `offeredOf` the result the
    // step succeeded with, which is the stage's own result.
    const offered = offeredOf as ((result: Record<string, unknown>) => unknown) | undefined;
    return op.opId ? (prep.step(stage, op, offered) as NonNullable<ReturnType<JournalStep>>) : null;
  };
  // An inner turn (mode `inner`, src/behavior/inner.ts): her calls pass its gate (innerVerdict).
  if (inner && mode === 'inner') draft.inner = inner;
  // The turn a finished errand of her own opens (asked in an inner turn: requester kind
  // `persona`, no person behind it) is her own initiative too: her grants alone decide her calls.
  if (taskResult?.requester?.kind === 'persona' && !taskResult.requester.accountId) draft.ownInitiative = true;
  // /nep pause: the owner is editing data/ by hand -- no new turn may start (a reply, an interject, an inner turn)
  // until /nep resume. A turn already in flight when the pause is requested is left to
  // finish naturally; admin.js's pause handler waits for it via waitIdle() below instead of aborting it here.
  const stateData = store.state.data;
  if (stateData.paused) return { ended: { outcome: 'paused' } };
  // A chain's turn runs under the attention it holds; taken before anything is awaited, so two turns cannot both take it.
  const attentionId = chat?.chatId ?? PERSONA_ID;
  draft.nowhere = chat === null;
  draft.mode = mode;
  if (!owned && !takeAttention(busy, attentionId)) return { ended: { outcome: 'busy' } };
  const letGo = () => {
    if (owned) return;
    busy.delete(attentionId);
    notifyIdle();
  };
  // The chat as the interface describes it now (a wake's own, `standIn`); one it no longer knows ends the turn.
  const found = await chatNow(ifaceReads, chat, standIn);
  if (found === null) {
    letGo();
    log.warn('turn: chat unavailable', { channel: attentionId });
    return { ended: { outcome: 'unavailable' } };
  }
  const channel = found.chat;
  draft.info = channel;
  // What the chat shares with its tree lives at the top of it; a private chat is its own place.
  const placeId = sharedPlaceOf(store, channel);
  const isDm = !inRoot(channel);
  const reading = placesRead(store, channel.iface, placeId, isDm);
  // What one place can hold for the turn (its library, its media cache): the one it reads, else its own.
  const libraryPlace = reading.length === 1 ? (reading[0] ?? placeId) : placeId;
  draft.privateAccountId = isDm ? (trigger?.authorId ?? channel.partnerId ?? null) : null;
  // The journal: the turn starts here, past the pause and
  // attention rails; a later attempt of the same turn (journalTurn) keeps its id.
  if (journalOn()) {
    const started = journal.start(placeId, journalStartOf({ draft, channel, trigger, triggerKind, mode, journalTurn }));
    // The journal of the tree's top keeps the attempt's records.
    draft.started = { ...started, placeId };
    // The archive's rows of this attempt name its turn (src/llm/archive.ts).
    Object.assign(currentRequestMeta() ?? {}, {
      turnId: draft.started?.turnId,
      runId: draft.started?.turnId,
      attemptId: draft.started?.attemptId,
      step: 0,
    });
  }
  // A turn answering a person first lets them finish writing (pace.settleMs), holding the
  // attention meanwhile; the turn's clocks (its deadline, its bar) start after this wait. The
  // first part of a split message reuses the history its message already waited for. The
  // author's activity is read in the trigger's own channel (a routed call's turn posts elsewhere).
  const settledMs = mode === 'reply' && !reuseHistory ? await settleAuthor(trigger?.placeId ?? channel.id, trigger) : 0;
  // The typing indicator, the preparation's deadline and the turn's bar, ended at the attempt's end
  // whatever the outcome; the start and the mode a dropped turn logs. `chained` is set when this turn hands its
  // message to a chain of parts.
  const life: Life = {
    stopTyping: () => {},
    deadline: null,
    bar: null,
    chained: false,
    turnStartedAt: clock(),
    turnMode: mode,
  };
  return { ended: null, prep, prepStep, channel, placeId, reading, libraryPlace, isDm, settledMs, life };
}
