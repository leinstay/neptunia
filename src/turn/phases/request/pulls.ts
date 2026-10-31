// The third step of a turn's request: the other channels the turn shows (`<channel_view>`), found and fetched before
// its mode is chosen, the chooser of a spontaneous turn, and the source a routed call lives in. The request phase
// (src/turn/phases/request.ts) runs it after the planner step; the turn ends here when its source is gone or its
// chooser finds nothing to do.

import { log } from '../../../log.js';
import type { PulledChannel } from '../../../behavior/pull-fetch.ts';
import type { Ended, PhaseContext, PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Planned } from './planner.ts';
import type { Setup } from './setup.ts';

/** What the pull step made: the turn's mode, its pulled channels (or the work fetching them) and its source. */
export type Pulled = {
  ended: null;
  finalMode: string;
  pullStartedAt: number;
  early: { pulled: Array<PulledChannel>; sourceSkip: string | null } | null;
  pulledPending: Promise<Array<PulledChannel>>;
  routedPull: PulledChannel | null;
};

export async function pullRequest(
  ctx: PhaseContext,
  params: PhaseParams,
  opened: Opened,
  setup: Setup,
  planned: Planned
): Promise<Ended | Pulled> {
  const { hot, clock, pullChannels, captionAll } = ctx;
  const { mode, trigger = null, triggerKind = null, chooseMode = null, source = null } = params;
  const { channel, guildId, isPrivate, life } = opened;
  const { config, likeServer, servedSnapshot, partner, rawHistory, candidate, selfName, now, beforeBar } = setup;
  const { routePlan } = planned;
  // The other channels this turn shows (`<channel_view>`, pullChannels), found and fetched
  // before the mode is chosen so a chooser sees them. Fresh captions only for a turn certain
  // to run: with the fetch when no chooser can still say not-now, else once it chose
  // (captionAll). A turn about another channel, or one with a chooser, waits for them here;
  // any other turn fetches them alongside the preparation below. A private chat only on its
  // partner's behalf (likeServer), judged against the partner.
  // The block renders only under `labels.pull.header` (read now, as buildRequest reads it):
  // without it no channel is fetched for a mention or the route hook and no fresh caption
  // is paid for; a turn's source is still pulled (its chooser and a routed call's search
  // classifier read it).
  const certain = mode !== 'auto';
  const pullLabelled = Boolean(hot.prompts?.labels?.pull?.header);
  const pullStartedAt = clock();
  const pullsPending =
    isPrivate && !likeServer
      ? Promise.resolve({ pulled: [], sourceSkip: null })
      : pullChannels({
          channel,
          guildId,
          snapshot: servedSnapshot,
          partner,
          history: rawHistory,
          trigger,
          candidate,
          triggerKind,
          source,
          selfName,
          config,
          now,
          certain,
          labelled: pullLabelled,
          routePlan,
        })
          // Never fails the turn: anything unexpected is no pull (and no source).
          .catch((err: unknown) => {
            log.warn('pull: failed', { channel: channel.id, error: err });
            return { pulled: [], sourceSkip: source ? 'error' : null };
          });
  const early = source || !certain ? await beforeBar(pullsPending) : null;
  if (early?.sourceSkip) {
    // Nothing to answer, or nothing to comment on: the source is gone or refused.
    if (source?.reason !== 'routed') return { ended: { outcome: 'not-now' } };
    log.warn('turn: source unavailable', {
      channel: channel.id,
      source: source.channelId,
      reason: early.sourceSkip,
    });
    return { ended: { outcome: 'error' } };
  }

  let finalMode = mode;
  if (mode === 'auto') {
    finalMode = chooseMode?.(rawHistory, now, { pulled: early?.pulled ?? [] }) ?? '';
    if (!finalMode) return { ended: { outcome: 'not-now' } };
  }
  life.turnMode = finalMode;
  // Ready before the request is built; pulled ahead of a chooser, they get their fresh
  // captions now (only when the block can render).
  const pulledPending = !early
    ? pullsPending.then((pulls) => pulls.pulled)
    : certain || !pullLabelled
      ? Promise.resolve(early.pulled)
      : captionAll(early.pulled, { guildId, config, destination: channel });
  // A routed call lives in its source: the search classifier reads the source's lines around
  // it, with their captions, instead of this chat; the re-watch is not offered (below).
  const routedPull =
    source?.reason === 'routed' ? (early?.pulled.find((entry) => entry.channelId === source.channelId) ?? null) : null;
  return { ended: null, finalMode, pullStartedAt, early, pulledPending, routedPull };
}
