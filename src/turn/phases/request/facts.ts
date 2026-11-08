// The ninth step of a turn's request: what was kept for her in this chat (the addressed turns that failed
// earlier, a send that may have gone out, the other facts), the task input with what the turn does not answer, the
// follow-up prompt's check, her time away and her active skills. The request phase (src/turn/phases/request.ts) runs
// it after the gather step.

import { selfreflectionPlaceNotes } from '../../selfreflection.ts';
import { accountOf } from '../../../memory/addresses.ts';
import { messageLinkOf } from '../../../behavior/elsewhere.ts';
import { FACTS_SHOWN_MAX, factPayload } from '../../../behavior/inner.ts';
import { isTaggedCall } from '../../../behavior/mention.ts';
import { usesFollowUpTask } from '../../../behavior/prompt.ts';
import { feedbackInTurnText } from '../../../behavior/wake.ts';
import { log } from '../../../log.ts';
import type { ActiveSkill } from '../../../skills/index-block.ts';
import type { Draft } from '../../draft.ts';
import { FAILED_TURN_KEEP_MS, settleUnknownSends } from '../../journal.ts';
import { askedFor } from '../../triggers.ts';
import { taskInput } from '../../task-input.ts';
import type { PhaseContext, PhaseParams } from '../context.ts';
import type { Prepared } from '../request.ts';

/** What the facts step made for the request: the facts told, the tasks, and what it read for the prompt. */
export type Told = {
  factsText: string;
  tasks: ReturnType<typeof taskInput>;
  notAnswered: Set<string>;
  placeMemory: unknown;
  taggedCall: boolean | null;
  offPeriods: unknown;
  /** Her active skills, read now; the request step offers those she can use as entries of the tools array. */
  activeSkills: ReadonlyArray<ActiveSkill>;
};

/** What the facts step reads of the attempt. */
type FactsNeeds = Pick<
  Prepared,
  | 'channel'
  | 'placeId'
  | 'reading'
  | 'isDm'
  | 'config'
  | 'now'
  | 'memoryOn'
  | 'selfId'
  | 'finalMode'
  | 'history'
  | 'prompts'
>;

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.ts in stage 5c, a pure split
export async function tellFacts(ctx: PhaseContext, params: PhaseParams, draft: Draft, turn: FactsNeeds): Promise<Told> {
  const { store, iface, facts, dmChannels, promptState, offPeriodsFor, activeSkills } = ctx;
  const { mode, trigger = null, triggerKind = null, part = null, queued = null, added = null } = params;
  const { missed = null } = params;
  const { channel, placeId, reading, isDm, config, now, memoryOn, selfId, finalMode, history, prompts } = turn;
  // A part of a split message, the author's other calls still queued, the messages folded into this one.
  // Addressed turns of this channel that failed earlier, told once (first part only); cleared at the turn's end unless it fails too.
  const addressedHere = mode === 'reply' && askedFor(trigger, triggerKind) && (!part || part.index === 1);
  if (isDm) dmChannels.add(String(channel.id));
  const factScope = { placeId: String(channel.id), dmChat: isDm };
  let pendingFacts = addressedHere ? facts().pending(factScope) : [];
  // A send of hers that may have gone out is looked for in the channel's lines first: found, the fact is dropped; not, it is told as unclear.
  if (pendingFacts.some((fact) => fact.kind === 'sendFailed' && fact.unknown === true)) {
    const settled = settleUnknownSends(pendingFacts, history);
    if (settled.dropped.length > 0) {
      facts().markTold(settled.dropped.map((fact) => fact.id));
      log.info('turn: unknown send found in the channel', { channel: channel.id, count: settled.dropped.length });
    }
    pendingFacts = settled.kept;
  }
  const failedFacts = pendingFacts.filter(
    (fact) =>
      fact.kind === 'failedTurn' &&
      fact.placeId === factScope.placeId &&
      now - fact.at < FAILED_TURN_KEEP_MS &&
      fact.messageId !== trigger?.id
  );
  const failedEarlier = failedFacts.map((fact) => ({
    author:
      history.find((m) => m.authorId === fact.authorId)?.authorName ??
      store.getUser?.(accountOf(store, String(fact.authorId)))?.names?.[0] ??
      '',
    messageId: fact.messageId,
    link: messageLinkOf(iface, isDm ? null : placeId, channel.id, fact.messageId),
    at: fact.at,
    code: fact.code,
  }));
  // What else was kept for her (a drop, a hold, a call or a message that failed): a `<wake>`-shaped block before the task.
  const otherFacts = pendingFacts.filter((fact) => fact.kind !== 'failedTurn').slice(0, FACTS_SHOWN_MAX);
  const factsText =
    otherFacts.length > 0
      ? feedbackInTurnText(otherFacts.map(factPayload), prompts?.labels, {
          timezone: config.bot?.timezone ?? 'UTC',
          locale: prompts?.labels?.locale,
        })
      : '';
  const shownIds = [...failedFacts, ...(factsText ? otherFacts : [])].map((fact) => fact.id);
  if (shownIds.length > 0) draft.factsShown = shownIds;
  const tasks = taskInput({
    part,
    queued,
    added,
    missed,
    failedEarlier,
    labels: prompts?.labels,
    placeId: channel.id,
  });
  // What this turn had in view yet does not answer (spokeAfterSeeing): the queued calls it
  // named, and on a part of a split message every line after the message -- a call that came
  // while the chain ran waits for its own turn after the chain.
  const triggerAt = part && trigger ? history.findIndex((m) => m.id === trigger.id) : -1;
  const notAnswered =
    triggerAt === -1 ? tasks.deferred : new Set([...tasks.deferred, ...history.slice(triggerAt + 1).map((m) => m.id)]);
  const placeMemory = memoryOn
    ? selfreflectionPlaceNotes(store as Parameters<typeof selfreflectionPlaceNotes>[0], reading, null)
    : null;
  // Whether the call tags the persona, read as decideMention reads it (src/pipeline/answer.ts#decideAndLog):
  // an untagged reply takes the follow-up task (usesFollowUpTask).
  const taggedCall = trigger ? isTaggedCall(trigger, selfId) : null;
  if (
    usesFollowUpTask({
      mode: finalMode,
      triggerKind,
      taggedCall,
      dmChat: isDm,
    })
  ) {
    const followUpPrompt = prompts?.['follow-up'];
    const missing = !(typeof followUpPrompt === 'string' && followUpPrompt.trim());
    if (missing && !promptState.followUpMissing)
      log.warn('turn: prompt missing', { name: 'follow-up', reason: 'no-prompt', channel: channel.id });
    promptState.followUpMissing = missing;
  }
  // `<now>`: the persona's recent time away (the journal's pauses and stops).
  const offPeriods = await offPeriodsFor(placeId);
  // Her active skills: the request step offers them in the tools array of every turn kind.
  const active = activeSkills == null ? [] : await activeSkills();
  return {
    factsText,
    tasks,
    notAnswered,
    placeMemory,
    taggedCall,
    offPeriods,
    activeSkills: active,
  };
}
