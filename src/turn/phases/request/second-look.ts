// The fifth step of a turn's request: the deadline's extension for a direct call that brought media, and the video
// states a turn's transcript shows. The request phase (src/turn/phases/request.ts) runs it after the stages step.

import { log } from '../../../log.ts';
import type { VideoState } from '../../rewatch.ts';
import { triggerBringsMedia } from '../../media.ts';
import { DIRECT_CALLS } from '../../triggers.ts';
import type { PhaseContext, PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Setup } from './setup.ts';
import type { Staged, Tracked } from './stages.ts';

/** The second look's stage: the video states it re-watched (null: none offered) and its answers on pictures. */
export type RewatchStage = Tracked<{ videos: Map<string, VideoState> | null; imageAnswers: Map<string, unknown> }>;

/** What the second-look step made: its chain and its stage once started (none: she looks with media.look). */
export type SecondLook = {
  rewatchChain: Promise<void> | null;
  // Set once the chain starts the second look; read when the request is built.
  slot: { rewatch: RewatchStage | null };
  videosSoFar: () => Promise<Map<string, VideoState> | undefined>;
};

export function startSecondLook(
  ctx: PhaseContext,
  params: PhaseParams,
  opened: Opened,
  setup: Setup,
  staged: Staged
): SecondLook {
  const { describer } = ctx;
  const { trigger = null, triggerKind = null } = params;
  const { channel, placeId } = opened;
  const { asked, pace, candidate } = setup;
  const { deadline, captionCandidates, videoStage, videoCandidates } = staged;
  // A second look at a watched video, a watched GIF or a posted picture is hers to ask for: she calls media.look in
  // her reply, and no classifier picks one before it. The log says why none ran here.
  const lookable =
    (Boolean(videoStage) && typeof describer?.rewatchVideo === 'function') ||
    typeof describer?.relookImage === 'function' ||
    typeof describer?.rewatchGif === 'function';
  if (asked && candidate && lookable) log.info('rewatch: skipped', { channel: channel.id, reason: 'core-tools' });
  const slot: SecondLook['slot'] = { rewatch: null };
  // A direct call that brought something to look at -- on its own message or the one it
  // replies to, captioned or watched by the stages above -- is about that thing: its deadline
  // grows to pace.prepareMediaMs (null: no extension). A search asked for later may grow it
  // further; extend keeps the larger limit, and never sets one on a deadline without one. The
  // hold for the search classifier's verdict (pace.prepareSearchMs) does nothing under a larger limit.
  if (
    trigger &&
    DIRECT_CALLS.has(triggerKind) &&
    pace.prepareMediaMs !== null &&
    triggerBringsMedia(trigger, captionCandidates, videoCandidates)
  ) {
    deadline.extend(pace.prepareMediaMs);
  }
  // The video states a classifier's transcript shows: this turn's once they are done (with the
  // re-watch's answer when it is done too), else what the describer's cache holds.
  const videosSoFar = async () => {
    if (!videoStage) return undefined;
    const rewatchStage = slot.rewatch;
    if (rewatchStage?.done && rewatchStage.value?.videos) return rewatchStage.value.videos;
    if (videoStage.done) return videoStage.value?.videos;
    try {
      return typeof describer?.cachedVideos === 'function'
        ? await describer.cachedVideos(placeId, videoCandidates)
        : undefined;
    } catch {
      return undefined;
    }
  };
  return { rewatchChain: null, slot, videosSoFar };
}
