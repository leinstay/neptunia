// The third phase of a turn attempt: the reply request asked under the bar, her answer read (split into speech and
// calls, parsed, shaped by the feature switches), the answer logged, the pulled channels' seen marks moved, and the
// cut-off and silence that end the turn here. runTurnOnce (src/behavior/turn.js) calls it after the request phase;
// the tool round reads its first answer and its reader of every later one.

import { stripUrls } from '../../behavior/diary.ts';
import { resolveReactionEmoji } from '../../behavior/emoji.js';
import { innerOutputCalls } from '../../behavior/inner-output.js';
import { thinkMissing } from '../../behavior/tool-step.js';
import { parseOutput } from '../../llm/parse.js';
import { log } from '../../log.js';
import { countDashes, stripDashes } from '../../memory/clamp.js';
import { answerOf, defaultSkills } from '../calls.ts';
import type { Draft } from '../draft.ts';
import { SKIP_NOTHING_TO_DO, SKIP_SILENCE, cutOffOf, journalUsage, noteDiagnostics } from '../journal.ts';
import { TOO_SLOW } from '../timers.ts';
import type { PlannedCall } from '../skill-calls.ts';
import type { StepAnswer, StepCompletion } from '../tool-round.ts';
import type { Ended, PhaseContext, PhaseLlm, PhaseParams } from './context.ts';
import type { Prepared } from './request.ts';

/** One completion of the reply request. */
type Completion = Awaited<ReturnType<PhaseLlm['complete']>>;

/** Her answer as the parser reads it (src/llm/parse.js#parseOutput). */
type RawParsed = ReturnType<typeof parseOutput>;

/** Her answer shaped by the feature switches, an inner turn's tags lowered into the calls they stand for. */
type Shaped = RawParsed & { loweredCalls: Array<PlannedCall> };

/** Her answer as the act reads it: shaped, with the turn's `<gif>` resolved against the library. */
export type Parsed = Omit<Shaped, 'gif'> & { gif: ReturnType<PhaseContext['resolveGif']> };

/** One answer of hers read, with the completion it came in. */
type ReadAnswer = StepAnswer & { completion: StepCompletion; parsed: Parsed };

/** What the response phase made: the request as sent, her first answer and the reader of every later one. */
export type Answered = Omit<Prepared, 'ended'> & {
  ended: null;
  sentMessages: Array<object>;
  readAnswer: (completion: StepCompletion, number: number) => ReadAnswer;
  first: ReadAnswer;
  parsed: Parsed;
  shownPulled: NonNullable<Prepared['request']['pulledKept']>;
  serverShown: NonNullable<Prepared['request']['pulledKept']>;
  ownCallId: string | null;
};

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.js in stage 5c, a pure split
export async function responsePhase(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  prepared: Prepared
): Promise<Ended | Answered> {
  const { hot, store, llm, calibrator, clock, skills, pullViews } = ctx;
  const { dumpTurnRequest, emojiLookup, resolveGif, noteThink, markPulledSeen, stampShownCalls, journalOn } = ctx;
  const { trigger = null, triggerKind = null, source = null, focus = null } = params;
  const { opened, setup, pulled: pulledStep, waited, gathered, request } = prepared;
  const { channel, guildId, isPrivate, settledMs, life } = opened;
  const { config, features, transport, startedAt, now, bar, beforeBar, replyOptions } = setup;
  const { finalMode } = pulledStep;
  const { prepareMs, late, timings } = waited;
  const { diaryPrep, neighborsHidden, pulled } = gathered;
  // The request is text only (buildRequest never attaches a picture: the persona sees them
  // through the describer's captions), so nothing is downloaded or resent here.
  const messages = request.messages;

  let completion: Completion;
  // What the client was given, for the journal's request dump.
  const sentMessages = messages;
  // Her tools travel as the request's `tools` on the native transport (the text transport described them in `<tools>`).
  const toolsSent =
    transport === 'native' && draft.tools.length > 0 ? { tools: draft.tools, toolChoice: 'auto' } : null;
  const replyStartedAt = clock();
  try {
    completion = await beforeBar(llm.complete(messages, { ...replyOptions(), ...(toolsSent ?? {}) }));
  } catch (err) {
    // The bar passed, or no time is left under it by the time the error lands: the turn is
    // dropped as too slow (an answer could not be asked for again), not reported as an error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TOO_SLOW is the turn's own signal, caught by its end
    if (err === TOO_SLOW || bar.passed || bar.leftMs() === 0) throw TOO_SLOW;
    throw err;
  } finally {
    // Where this turn's time went, answered or not: numbers and codes only.
    const end = clock();
    log.info('turn: timings', {
      channel: channel.id,
      mode: finalMode,
      triggerKind: triggerKind ?? null,
      settleMs: settledMs,
      prepareMs,
      late,
      stages: timings,
      replyMs: end - replyStartedAt,
      totalMs: end - startedAt,
    });
  }
  // The answer is in hand: the bar is met, and the typing imitation below (never shortened) takes over.
  bar.close();
  life.stopTyping();

  // The journal's request dump (journal.keepRequests): the request as sent and the raw answer.
  dumpTurnRequest(guildId, draft, sentMessages, completion, null, toolsSent);

  // The model's output as it is acted on: the feature switches drop parts of it first. The same
  // for the answer to every request after her calls.
  const shapeOutput = (raw: RawParsed): Shaped => {
    // The one field shaping adds, `loweredCalls`, is set below before it returns.
    const parsed = raw as Shaped;
    if (features.reactions === false) {
      parsed.reactions = [];
      parsed.untargetedReactions = [];
    }
    // A custom emoji reaction resolves through the index; an unknown one (or the switch off) is dropped.
    const lookupEmoji = emojiLookup();
    parsed.reactions = parsed.reactions
      .map((reaction) => ({ ...reaction, emoji: resolveReactionEmoji(reaction.emoji, lookupEmoji) }))
      .filter((reaction): reaction is { to: number; emoji: string } => Boolean(reaction.emoji));
    if (features.multiMessage === false) parsed.messages = parsed.messages.slice(0, 1);
    // format.stripDashes (a missing key counts as on): no em/en dash in a <msg> text; a message
    // left empty is not posted. Hyphens, <react>, <gif> and reply ids are untouched.
    if (hot.config.format?.stripDashes !== false) {
      const dashes = parsed.messages.reduce((sum, message) => sum + countDashes(message.text), 0);
      if (dashes > 0) {
        parsed.messages = parsed.messages
          .map((message) => ({ ...message, text: stripDashes(message.text) }))
          .filter((message) => message.text !== '');
        log.info('turn: dashes stripped', { channel: channel.id, count: dashes });
      }
    }
    // An inner turn's tags are public actions in its current channel: lowered into the calls a
    // `message.create` / `message.react.add` of hers would be, planned after her own calls and made
    // with them once her speech may go out (src/behavior/inner-output.js).
    parsed.loweredCalls = [];
    if (draft.inner) {
      const current = draft.inner.currentChannel === undefined ? String(channel.id) : draft.inner.currentChannel;
      parsed.loweredCalls = innerOutputCalls(parsed, {
        current: current ? String(current) : null,
        turnChannel: String(channel.id),
        // A lowered call is planned from its skill and its arguments, like a call of hers without a body.
      }).map((call) => ({ ...call, lowered: true }) as PlannedCall);
      if (parsed.loweredCalls.length > 0)
        log.info('turn: inner output lowered', { channel: channel.id, calls: parsed.loweredCalls.length });
      parsed.messages = [];
      parsed.reactions = [];
      parsed.untargetedReactions = [];
      parsed.gif = null;
    }
    if (diaryPrep) {
      // A diary post: no reaction, no GIF, nothing posted as a reply, no link, at most diary.maxMessages.
      parsed.reactions = [];
      parsed.gif = null;
      parsed.messages = parsed.messages
        .map((message) => ({ ...message, replyTo: null, text: stripUrls(message.text) }))
        .filter((message) => message.text !== '')
        .slice(0, Math.max(0, config.diary?.maxMessages ?? 3));
    }
    return parsed;
  };
  // One answer read: split into speech and calls (answerOf), the speech parsed and shaped, the think kept,
  // her answer counted when it did not begin with her thinking. `number`: 1 for the reply's answer, one more for each after.
  draft.format = { thinkMissing: 0, coerced: 0, malformed: 0, truncated: 0, capped: 0, held: 0 };
  draft.steps = 0;
  const readAnswer = (answered: StepCompletion, number: number): ReadAnswer => {
    // The language model client answers its tool calls as a list (src/llm/openrouter.js#complete).
    const split = answerOf(answered as Parameters<typeof answerOf>[0], {
      transport,
      step: number,
      registry: skills ?? defaultSkills(),
    });
    const shaped = shapeOutput(parseOutput(split.speechText, { limits: draft.limits }));
    noteDiagnostics(draft, shaped, answered);
    noteThink(draft, shaped);
    const resolved: Parsed = Object.assign(shaped, { gif: resolveGif(guildId, shaped.gif, channel.id, draft.limits) });
    // Counted, never refused: the answer is acted on all the same.
    if (thinkMissing(split.rawText)) {
      draft.format.thinkMissing += 1;
      log.info('turn: think missing', { channel: channel.id, step: number - 1 });
    }
    return { completion: answered, ...split, parsed: resolved };
  };
  const first = readAnswer(completion, 1);
  const parsed = first.parsed;
  const nothingToDo =
    parsed.messages.length === 0 &&
    parsed.reactions.length === 0 &&
    parsed.gif === null &&
    parsed.loweredCalls.length === 0;
  // Nothing to post and nothing to call: silence (her calls run all the same when she wrote any).
  const silent = (parsed.skip || nothingToDo) && first.calls.length === 0;
  // The journal keeps the think (journal.thinkChars); the log then carries its length only.
  if (draft.started) {
    draft.think = parsed.think;
    draft.usage = journalUsage(completion);
  }
  const thinkField = journalOn() ? { thinkChars: Array.from(parsed.think ?? '').length } : { think: parsed.think };

  log.info('turn: model answered', {
    mode: finalMode,
    trigger: triggerKind ?? null,
    // Only on a turn about another channel, with channels pulled, or with a line put to the room.
    ...(source ? { source: source.channelId ?? null } : {}),
    ...(pulled.length > 0 ? { pulled: pulled.length } : {}),
    ...(focus ? { focus: true } : {}),
    // Active neighbours the audience rail left out.
    ...(neighborsHidden > 0 ? { neighborsHidden } : {}),
    secondsToAnswer: Math.round((clock() - startedAt) / 100) / 10,
    channel: channel.id,
    estimated: completion.estimated,
    usage: completion.usage,
    calibration: Number(calibrator.ratio.toFixed(3)),
    budget: request.stats,
    // Per user-message part: length and a short hash, to see which part changes between turns (no content).
    segments: request.segments,
    ...thinkField,
    skip: parsed.skip || nothingToDo,
    messages: parsed.messages.length,
    reactions: parsed.reactions.length,
    gif: Boolean(parsed.gif),
    ...(first.calls.length > 0 ? { calls: first.calls.length } : {}),
  });
  // The pulled channels whose block was in the request sent (a skip and a dry run included):
  // their seen marks move to the newest line shown; a block the budget dropped moves none.
  const shownPulled = request.pulledKept ?? [];
  // What a private chat showed of the server stays there: no seen mark, no stamp, no pending ping.
  const serverShown = isPrivate ? [] : shownPulled;
  markPulledSeen(serverShown);
  // This channel's view of each pulled channel the request showed, for the next view of it here.
  if (!isPrivate) pullViews.remember(channel.id, request.pulledViews ?? [], now);
  store.state.data.calibration = calibrator.ratio;
  store.state.markDirty();
  // The calls of the ring this turn showed follow its decision (stampShownCalls), except a
  // routed turn's own call: its caller stamps that one.
  const ownCallId = source?.reason === 'routed' ? (trigger?.id ?? null) : null;

  // Cut off at the output cap before any complete action: a lost answer, not her silence.
  const cutOff = cutOffOf(completion, parsed, { channelId: channel.id, empty: silent, followUp: false });
  if (cutOff && !cutOff.kept && first.calls.length === 0) {
    draft.reason = 'cut-off';
    return { ended: { outcome: 'error', mode: finalMode, reason: 'cut-off' } };
  }
  if (silent) {
    stampShownCalls({ shown: serverShown, pulled, answered: new Set(), exceptId: ownCallId });
    // An inner turn that ends with no action: nothing to do, journalled as such.
    return { ended: { outcome: 'skip', mode: finalMode, reason: draft.inner ? SKIP_NOTHING_TO_DO : SKIP_SILENCE } };
  }

  return {
    ...prepared,
    ended: null,
    sentMessages,
    readAnswer,
    first,
    parsed,
    shownPulled,
    serverShown,
    ownCallId,
  };
}
