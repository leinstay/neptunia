// The fourth phase of a turn attempt: how her answer reaches the chat (which line lives where, whose `@name` resolves,
// which post carries a jump link) and the recovery turn's last check that its messages still wait. runAttempt (src/turn/phases/attempt.ts) calls it after the response phase;
// the tool round posts through the routing it made.

import { accountOf } from '../../memory/addresses.ts';
import { setSettings } from '../../behavior/selfreflection.ts';
import { createLinker, messageLinkOf } from '../../behavior/elsewhere.ts';
import { log } from '../../log.ts';
import type { Draft } from '../draft.ts';
import { storedNames } from '../mentions.ts';
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

/** What the act phase adds to the attempt: the routing, and the result of a set below its minimum. */
type ActMade = {
  ended: null;
  idByIndex: Map<number, string>;
  pulledIds: Map<string, string>;
  lines: Array<HistoryLine>;
  routing: Routing;
  setShort: (pictures: number, extra?: Record<string, unknown>) => AttemptResult;
};

/** The attempt once the act phase made its part. */
export type Acting = Omit<Answered, 'ended'> & ActMade;

/** What the act phase reads of the attempt. */
type ActNeeds = Pick<Answered, 'channel' | 'placeId' | 'memoryOn' | 'finalMode' | 'history' | 'request'>;

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.ts in stage 5c, a pure split
export function actPhase<TTurn extends ActNeeds>(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  turn: TTurn
): Ended | (Omit<TTurn, 'ended'> & ActMade) {
  const { hot, store, iface, turnDirectory } = ctx;
  const { triggerKind = null, plainPosts = false } = params;
  const { stillDue = null } = params;
  const { channel, placeId, memoryOn, finalMode, history, request } = turn;
  const idByIndex = request.idByIndex;
  // Names resolve over this chat's history, then the stored names of the members whose profile the request kept, and
  // only then the fallback directory: a member the model was not shown is mentioned by a name nobody else in the served
  // place carries.
  const pulledIds = request.pulledIds ?? new Map();
  // The highest line number of the request: a memory.search of the turn numbers its quotes on past it.
  draft.handleFloor = Math.max(0, ...idByIndex.keys());
  const lines = history;
  // With features.mentionHandles on (the request was built with it: `handles`), only her
  // `@handle` mentions anyone and no name is matched at all.
  const handles = request.handles ?? null;
  // The request's channel handles: her `#handle` links its channel exactly.
  const channelHandles = request.channelHandles ?? null;
  const knownNames =
    memoryOn && !handles
      ? storedNames(request.peopleShown, [], (accountId) => store.getUser(accountOf(store, accountId)))
      : [];
  // Behind those, every member of the served place the bot knows (built once, on first use): with handles, the members
  // whose handle she carries from an earlier request (src/behavior/handles.ts#widenHandles); without, their names.
  const directory = turnDirectory({ placeId, memoryOn });
  const linkFor = createLinker({
    linkOf: (chatId, messageId) => messageLinkOf(iface, placeId, chatId, messageId),
    pulledIds,
    sourceTarget: null,
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
  // A set below selfreflection.set.minPosted (read now) is not posted at all: not even its messages.
  const setShort = (pictures: number, extra: Record<string, unknown> = {}): AttemptResult => {
    log.info('turn: set short', {
      channel: channel.id,
      pictures,
      wanted: setSettings(hot.config.selfreflection).minPosted,
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
  return { ...turn, ended: null, idByIndex, pulledIds, lines, routing, setShort };
}
