// The third step of a turn's request: the other channels the turn shows (`<channel_view>`) and the source a routed call
// lives in. The request phase (src/turn/phases/request.ts) runs it after the searches step; the turn ends here when its
// source is gone.

import { framedTurn } from '../../request/frame.ts';
import { log } from '../../../log.ts';
import type { PulledChannel } from '../../../behavior/pull-fetch.ts';
import type { Ended, PhaseContext, PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';
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
  setup: Setup
): Promise<Ended | Pulled> {
  const { hot, clock, pullChannels } = ctx;
  const { mode, trigger = null, triggerKind = null, source = null } = params;
  const { channel, placeId, isPrivate, life } = opened;
  const { config, likeServer, servedSnapshot, partner, rawHistory, candidate, selfName, now, beforeBar } = setup;
  // The other channels this turn shows (`<channel_view>`, pullChannels), fetched with their fresh captions. A turn about
  // another channel waits for them here; any other turn fetches them alongside the preparation below. A private chat
  // only on its partner's behalf (likeServer), judged against the partner.
  // The block renders only under `labels.pull.header` (read now, as buildRequest reads it):
  // without it no channel is fetched for a mention or the route hook and no fresh caption
  // is paid for; a turn's source is still pulled (a routed call's search classifier reads it).
  const promptLabels = hot.prompts?.labels;
  const pullLabelled = Boolean(promptLabels?.pull?.header);
  const pullStartedAt = clock();
  // A turn on the frame shows no pulled channel (`<meanwhile>` stands for them), so it fetches none and asks no route.
  const onFrame = framedTurn(mode, source);
  const pullsPending =
    (isPrivate && !likeServer) || onFrame
      ? Promise.resolve({ pulled: [], sourceSkip: null })
      : pullChannels({
          channel,
          placeId,
          snapshot: servedSnapshot,
          partner,
          history: rawHistory,
          trigger,
          candidate,
          triggerKind,
          mode,
          source,
          selfName,
          config,
          now,
          certain: true,
          labelled: pullLabelled,
        })
          // Never fails the turn: anything unexpected is no pull (and no source).
          .catch((err: unknown) => {
            log.warn('pull: failed', { channel: channel.id, error: err });
            return { pulled: [], sourceSkip: source ? 'error' : null };
          });
  const early = source ? await beforeBar(pullsPending) : null;
  if (early?.sourceSkip) {
    // Nothing to answer, or nothing to comment on: the source is gone or refused.
    if (source?.reason !== 'routed') return { ended: { outcome: 'not-now' } };
    log.warn('turn: source unavailable', {
      channel: channel.id,
      source: source.placeId,
      reason: early.sourceSkip,
    });
    return { ended: { outcome: 'error' } };
  }

  const finalMode = mode;
  life.turnMode = finalMode;
  // Ready before the request is built.
  const pulledPending = early ? Promise.resolve(early.pulled) : pullsPending.then((pulls) => pulls.pulled);
  // A routed call lives in its source: the search classifier reads the source's lines around
  // it, with their captions, instead of this chat; the re-watch is not offered (below).
  const routedPull =
    source?.reason === 'routed' ? (early?.pulled.find((entry) => entry.placeId === source.placeId) ?? null) : null;
  return { ended: null, finalMode, pullStartedAt, early, pulledPending, routedPull };
}
