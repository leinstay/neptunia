// The fifth phase of a turn attempt: her calls, then her speech, then one more request while something is left to read
// (runSteps), each call under the effect key of the turn, and the cut-off and the short diary set that end the turn
// here. runTurnOnce (src/behavior/turn.js) calls it after the act phase; the outcome phase reads what it posted.

import { randomUUID } from 'node:crypto';
import { lateMediaTeller } from '../../behavior/turn-parts.ts';
import { callEnvelope } from '../calls.ts';
import type { Draft } from '../draft.ts';
import type { Stepped } from '../tool-round.ts';
import type { Acting } from './act.ts';
import type { Ended, PhaseContext, PhaseParams } from './context.ts';

/** What the tool round made: the steps her answer came to. */
export type Rounded = Omit<Acting, 'ended'> & { ended: null; stepped: Stepped };

export async function toolRoundPhase(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  acting: Acting
): Promise<Ended | Rounded> {
  const { inTurnTools, stepTranscript, runSteps } = ctx;
  const { trigger = null, triggerKind = null, source = null, added = null, missed = null } = params;
  const requesterParam = params.requester ?? null;
  const { opened, setup, pulled: pulledStep, staged, gathered, request, sentMessages, first, readAnswer } = acting;
  const { idByIndex, pulledIds, lines, routing, setShort } = acting;
  const { channel, guildId, isPrivate, prep } = opened;
  const { transport, memoryOn, selfId, selfName, startedAt, servedSnapshot, partner } = setup;
  const { finalMode } = pulledStep;
  const { videoStage, videoCandidates, captions, captionCandidates } = staged;
  const { history, descriptions, diaryPrep, pendingMedia } = gathered;
  const { knownNames, directory, handles, channelHandles, plain } = routing;
  const { parsed } = acting;
  // Every call of the attempt: its turn (the journal's turn, else one id per attempt) and its index over every step.
  // Its key is the effect's record, `<turnId>:<effectIndex>:<target>` (the conversation it names, else the turn's),
  // with no attempt in it, so a later attempt of the turn carries the key a first one would have carried.
  const turnKey = (draft.turnKey ??= { turnId: draft.started?.turnId ?? randomUUID() });
  const envelopeOf = (call: { args?: Record<string, unknown> }) => {
    const index = draft.callCount ?? 0;
    draft.callCount = index + 1;
    const target = typeof call?.args?.channelId === 'string' ? call.args.channelId || channel.id : channel.id;
    return callEnvelope({
      trigger,
      channel,
      added,
      missed,
      requester: requesterParam,
      turnId: turnKey.turnId,
      idempotencyKey: `${turnKey.turnId}:${index}:${target}`,
      ownInitiative: Boolean(draft.inner) || draft.ownInitiative === true,
      chainId: draft.inner?.wake?.chainId ?? null,
      wakeKind: draft.inner?.wake?.kind ?? null,
    });
  };
  const actArgs = {
    channel,
    guildId,
    privateChat: isPrivate,
    parsed,
    idByIndex,
    history,
    startedAt,
    mode: finalMode,
    triggerKind,
    trigger,
    selfName,
    ...routing,
    sourceId: isPrivate ? null : (source?.channelId ?? null),
    gifPick: !diaryPrep,
    participation: isPrivate ? null : { descriptions: descriptions ?? null },
    draft,
  };
  // The calls of the reply and of every later step, run in the turn's context (runCall's).
  const callContext = {
    channel,
    trigger,
    guildId,
    draft,
    privateChat: isPrivate,
    idByIndex,
    pulledIds,
    lines,
    knownNames,
    directory,
    handles,
    channelHandles,
    inTurn: inTurnTools({
      channel,
      snapshot: servedSnapshot,
      guildId,
      partner: isPrivate ? partner : null,
      selfId,
      selfName,
      history,
      draft,
      trigger,
      triggerKind,
      mode: finalMode,
      plain,
    }),
  };
  const lateMedia =
    pendingMedia.videoIds.length > 0 || pendingMedia.captions
      ? lateMediaTeller({
          lines: history,
          idByIndex,
          handles,
          memberNames: request.memberNames ?? null,
          selfName,
          videoStage,
          videoItems: videoCandidates,
          captions,
          captionItems: captionCandidates,
          pending: pendingMedia,
          onTold: (stage) => prep.tell(stage),
          // The teller hands stepTranscript her name, the request's handles and member names, the offset and the media.
          transcript: (shown, options) => stepTranscript(shown, options as Parameters<typeof stepTranscript>[1]),
        })
      : null;
  // Her calls, then her speech, then (when something is left to read) another request, and so on (runSteps).
  const stepped = await runSteps({
    channel,
    guildId,
    trigger,
    draft,
    transport,
    messages: sentMessages,
    first,
    readAnswer,
    actArgs,
    callContext,
    envelopeOf,
    routing: {
      idByIndex,
      history,
      lines,
      pulledIds,
      handles,
      memberNames: request.memberNames ?? null,
      channelHandles,
    },
    memoryOn,
    selfName,
    triggerKind,
    lateMedia,
  });
  // A step was cut off with nothing complete and nothing of the turn reached the chat: a lost answer.
  if (stepped.cutOff && !stepped.delivered) {
    draft.reason = 'cut-off';
    return { ended: { outcome: 'error', mode: finalMode, reason: 'cut-off' } };
  }
  // A set kind that ended below diary.set.minPosted staged pictures (runSteps): nothing was posted.
  if (draft.setShort !== undefined) return { ended: setShort(draft.setShort) };

  return { ...acting, ended: null, stepped };
}
