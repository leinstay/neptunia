// The second step of a turn's request: which searches the turn may run, and the turn planner with what it is sent
// (plannerStart) and its route step (routePlan). The request phase (src/turn/phases/request.ts) runs it after the setup;
// the pull step hands routePlan to pullChannels, and the lookup step starts the planner when the route step did not.

import { block } from '../../../behavior/prompt.js';
import { participationEpisodeOffer } from '../../../behavior/participation-pick.js';
import { plannerOn } from '../../../behavior/planner.js';
import { routeAllowed, routeCandidate, routeSettings } from '../../../behavior/route.js';
import { routeChannelOffer } from '../../../behavior/route-channel.js';
import { log } from '../../../log.js';
import type { Draft } from '../../draft.ts';
import type { TurnPlan } from '../../lookup.ts';
import type { PullArgs } from '../../pulls.ts';
import { inCommunity } from '../../routing.ts';
import type { HistoryLine, PhaseContext, PhaseParams, TurnTrigger } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Setup } from './setup.ts';

/** What the planner is sent once the turn has it: the transcript's lines and what they show. */
export type PlannerInputs = {
  lines: Array<HistoryLine>;
  descriptions?: Map<string, unknown>;
  videos?: Map<string, unknown>;
  reads?: Map<string, unknown>;
  media?: PlanOffer;
};

/** One offer the planner is sent (its `<media>`, its episodes). */
type PlanOffer = Parameters<TurnPlan['start']>[0]['media'];

/** The candidate as `lines` hold it (routeCandidate): the line of the trigger, else the trigger itself. */
function judgedIn(lines: Array<object>, candidate: TurnTrigger | null): TurnTrigger | null {
  // routeCandidate hands back a line of `lines` or the candidate, both of a message's shape.
  return routeCandidate(lines, candidate) as TurnTrigger | null;
}

/** The id the planner's 1-based pick names in an offer's ids, if any. */
function pickedId(ids: unknown, index: number | null): unknown {
  return Array.isArray(ids) && index !== null ? (ids as ReadonlyArray<unknown>)[index - 1] : undefined;
}

/** What the planner step made: the searches' switches, the planner and its two entry points. */
export type Planned = {
  webLookupOn: boolean;
  webSearchOn: boolean;
  serverOn: boolean;
  planner: TurnPlan | null;
  plannerStart: (inputs: PlannerInputs) => void;
  routePlan: PullArgs['routePlan'];
};

export function planRequest(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened,
  setup: Setup
): Planned {
  const {
    hot,
    store,
    clock,
    lookup,
    recallAvailable,
    createTurnPlan,
    classifierContext,
    participationOn,
    participationAudience,
    lookupGate,
  } = ctx;
  const { mode, triggerKind = null, source = null } = params;
  const { channel, guildId, isPrivate } = opened;
  const { config, features, selfName, asked, answersTask, coreTools, skillsAnswer, snapshot, likeServer } = setup;
  const { servedGuild, servedSnapshot, partner, candidate } = setup;
  // The searches this turn may run (maybeLookup): the web search (features.webLookup -- unlike
  // the other switches a missing key counts as OFF: it costs money and the search needs a key)
  // and the server search (a private chat only on its partner's behalf). Asked once, so the
  // lookup stage, the planner's offer and `<senses>` agree.
  const webLookupOn = features.webLookup === true && Boolean(lookup);
  const webSearchOn = webLookupOn && config.web?.search?.enabled !== false && typeof lookup?.search === 'function';
  const serverOn = (!isPrivate || likeServer) && recallAvailable();
  // The turn planner (features.turnPlanner exactly true, read now; never for an inner turn):
  // one request for the route, the participation pick, the
  // re-watch and the search classifier, none of which is asked then. It starts in the pull's
  // route step on a turn that waits for its pull (a source, or a mode still to choose), else
  // once the file previews are in (below), like the search classifier did.
  const planner =
    plannerOn(config) && !draft.inner
      ? createTurnPlan({
          config,
          channelId: channel.id,
          selfName,
          triggerKind,
          limits: draft.limits ?? null,
          early: Boolean(source) || mode === 'auto',
        })
      : null;
  opened.life.planner = planner;
  // The planner's `skills:` line, once it answered (skills discovery, read when the request is built).
  void planner?.result.then((plan) => {
    if (!coreTools) skillsAnswer.value ??= plan?.blocks?.skills ?? null;
  });
  // What the planner is sent: the search classifier's transcript of `lines` (with the captions,
  // video states and page reads given) and candidate, the participation pick's episodes, the
  // re-watch's media (`media`, prepared by the caller) and whether a search could run.
  const plannerStart = ({ lines, descriptions, videos, reads, media = null }: PlannerInputs): void => {
    if (!planner) return;
    const judged = judgedIn(lines, candidate);
    const context = judged
      ? classifierContext({
          config,
          selfName,
          history: lines,
          trigger: judged,
          contextMessages: Math.max(0, Math.floor(config.web?.search?.contextMessages ?? 50)),
          descriptions,
          videos,
          reads,
        })
      : null;
    let episodes: PlanOffer = null;
    if (participationOn(channel, config) && mode !== 'diary') {
      try {
        const units = hot.prompts?.labels?.units;
        episodes = participationEpisodeOffer({
          store,
          guildId,
          channel,
          snapshot,
          audience: participationAudience(channel, config, snapshot),
          config,
          units,
          selfName,
          now: clock(),
        });
      } catch (err) {
        log.warn('participation: failed', {
          channel: channel.id,
          reason: 'error',
          status: null,
          name: (err as { name?: unknown } | null)?.name ?? null,
        });
      }
    }
    const lookupWanted =
      asked &&
      !answersTask &&
      !coreTools &&
      (webSearchOn || serverOn) &&
      lookupGate({ config, webOn: webSearchOn, serverOn }).skip === null;
    planner.start({
      transcriptBlock: context?.transcriptBlock ?? '',
      candidateBlock: judged ? block('candidate', `${judged.authorName}: ${context?.triggerText}`) : null,
      episodes,
      media,
      lookup: lookupWanted,
    });
  };
  // The planner's route step (pullChannels' routePlan): this turn's channel list as the route
  // hook would build it (features.channelRoute, routeAllowed, its candidate), then the pick of
  // the planner's channel block, mapped back to its id.
  const routePlan: PullArgs['routePlan'] = planner
    ? async ({ lines: routedLines, routed }) => {
        // pullChannels hands the route step the history lines it judged the route on.
        const lines = routedLines as Array<HistoryLine>;
        const settings = routeSettings(config);
        const allowed = inCommunity(channel)
          ? routeAllowed({ triggerKind })
          : Boolean(servedGuild && partner) && triggerKind === 'private';
        const judged = judgedIn(lines, candidate);
        if (settings && allowed && judged) {
          try {
            planner.offerChannels(
              routeChannelOffer({
                store,
                guildId,
                channel,
                snapshot: servedSnapshot,
                partnerId: partner?.id ?? null,
                candidate: judged,
                config,
                settings,
                now: clock(),
              })
            );
          } catch (err) {
            log.warn('pull: route failed', { channel: channel.id, error: err });
          }
        }
        if (planner.early) plannerStart({ lines, descriptions: routed?.descriptions });
        const plan = await planner.result;
        const answer = plan.blocks.channel;
        const id = answer.state === 'ok' ? pickedId(plan.offer.channel?.ids, answer.index) : null;
        return typeof id === 'string' && id
          ? [{ id, direction: answer.direction === 'earlier' ? 'earlier' : null }]
          : [];
      }
    : null;
  return { webLookupOn, webSearchOn, serverOn, planner, plannerStart, routePlan };
}
