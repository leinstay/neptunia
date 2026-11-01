// The fourth phase of a turn attempt: how her answer reaches the chat (which line lives where, whose `@name` resolves,
// which post carries a jump link) and the recovery turn's last check that its messages still wait. runTurnOnce (src/behavior/turn.ts) calls it after the response phase;
// the tool round posts through the routing it made.

import { setSettings } from '../../behavior/diary.ts';
import { createLinker, messageLinkOf } from '../../behavior/elsewhere.ts';
import { log } from '../../log.ts';
import type { Draft } from '../draft.ts';
import { storedNames } from '../mentions.ts';
import { sourceLinkTarget } from '../targets.ts';
import { postsPlain } from '../triggers.ts';
import type { AttemptResult, Ended, HistoryLine, PhaseContext, PhaseParams } from './context.ts';
import type { Answered } from './response.ts';

/** How her answer reaches the chat: the routing act reads. */
export type Routing = {
  pulledIds: Map<string, string>;
  lines: Array<HistoryLine>;
  knownNames: ReturnType<typeof storedNames>;
  directory: ReturnType<PhaseContext['turnDirectory']> | null;
  handles: Map<string, string> | null;
  memberNames: Map<string, Array<string>> | null;
  channelHandles: Map<string, string> | null;
  linkFor: (pulledId: string | null) => string | null;
  plain: boolean;
};

/** What the act phase made: the routing, and the result of a set below its minimum. */
export type Acting = Omit<Answered, 'ended'> & {
  ended: null;
  idByIndex: Map<number, string>;
  pulledIds: Map<string, string>;
  lines: Array<HistoryLine>;
  routing: Routing;
  setShort: (pictures: number, extra?: Record<string, unknown>) => AttemptResult;
};

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.ts in stage 5c, a pure split
export function actPhase(ctx: PhaseContext, params: PhaseParams, draft: Draft, answered: Answered): Ended | Acting {
  const { hot, store, iface, turnDirectory } = ctx;
  const { trigger = null, triggerKind = null, source = null, plainPosts = false } = params;
  const { stillDue = null } = params;
  const { opened, setup, pulled: pulledStep, gathered, request, shownPulled } = answered;
  const { channel, guildId, isPrivate } = opened;
  const { memoryOn } = setup;
  const { finalMode } = pulledStep;
  const { history, pulled } = gathered;
  const idByIndex = request.idByIndex;
  // The output side of the pulled channels: which line lives where, whose @name resolves,
  // which post carries a jump link. Names resolve over the
  // pulled lines the request showed, then this chat's history: resolveMentions keeps the
  // last author of a display name, so a chat author wins a name both share. The stored names
  // of the members whose profile the request kept and of the pulled lines' authors resolve
  // too, behind every display name: a pulled line fetched without its member carries the
  // global name while `<people>` reads the server nickname. Only then the fallback directory:
  // a member the model was not shown (another channel, a block the budget dropped) is
  // mentioned by a name nobody else in the served guild carries.
  const pulledIds = request.pulledIds ?? new Map();
  // The highest line number of the request: a memory.search of the turn numbers its quotes on past it.
  draft.handleFloor = Math.max(0, ...idByIndex.keys());
  const shownLines = shownPulled.flatMap(({ channelId, ids }) => {
    const shownIds = new Set(ids);
    return (pulled.find((entry) => entry.channelId === channelId)?.messages ?? []).filter((message) =>
      shownIds.has(message.id)
    );
  });
  const lines = shownLines.length > 0 ? [...shownLines, ...history] : history;
  // With features.mentionHandles on (the request was built with it: `handles`), only her
  // `@handle` mentions anyone and no name is matched at all.
  const handles = request.handles ?? null;
  // The request's channel handles: her `#handle` links its channel exactly.
  const channelHandles = request.channelHandles ?? null;
  const knownNames =
    memoryOn && !handles
      ? storedNames(request.peopleShown, shownLines, (userId) => store.getUser(guildId, userId))
      : [];
  // Behind those, every member of the served guild the bot knows (built once, on the first `@`).
  const directory = handles ? null : turnDirectory({ guildId, memoryOn });
  const linkFor = createLinker({
    linkOf: (channelId, messageId) => messageLinkOf(iface, guildId, channelId, messageId),
    pulledIds,
    sourceTarget: isPrivate ? null : sourceLinkTarget({ source, trigger, pulledKept: shownPulled }),
  });
  // A follow-up or an overheard turn (postsPlain) never posts as a platform reply -- the
  // model's reply="#n" quotes nothing.
  // A later part of a split message posts plain too: the first part replied to the message.
  const plain = postsPlain(triggerKind) || plainPosts;
  const routing = {
    pulledIds,
    lines,
    knownNames,
    directory,
    handles,
    memberNames: request.memberNames ?? null,
    channelHandles,
    linkFor,
    plain,
  };
  // A set below diary.set.minPosted (read now) is not posted at all: not even its messages.
  const setShort = (pictures: number, extra: Record<string, unknown> = {}): AttemptResult => {
    log.info('turn: set short', {
      channel: channel.id,
      pictures,
      wanted: setSettings(hot.config.diary).minPosted,
      ...extra,
    });
    return { outcome: 'refused', mode: finalMode, reason: 'set-short', ...extra };
  };
  // A recovery turn (src/behavior/missed.ts) asks right before anything is posted whether
  // its messages still wait for an answer (`stillDue`): the persona spoke in the channel
  // since it started, or another turn answered one of them -- nothing is posted.
  if (typeof stillDue === 'function' && !stillDue()) {
    log.info('turn: dropped', {
      channel: channel.id,
      mode: finalMode,
      triggerKind: triggerKind ?? null,
      reason: 'answered-meanwhile',
    });
    draft.reason = 'answered-meanwhile';
    return { ended: { outcome: 'not-now', mode: finalMode, reason: 'answered-meanwhile' } };
  }
  return { ...answered, ended: null, idByIndex, pulledIds, lines, routing, setShort };
}
