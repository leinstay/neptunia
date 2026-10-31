// The fifth step of a turn's request: the second look at a watched video, a watched GIF or a posted picture when the
// trigger asks about one, the deadline's extension for a direct call that brought media, and the video states a
// classifier's transcript shows. The request phase (src/turn/phases/request.ts) runs it after the stages step.

import { log } from '../../../log.js';
import { isVideoVisionOn } from '../../../memory/index.js';
import type { RewatchOffer, VideoState } from '../../rewatch.ts';
import { gifRewatchItems, relookCandidates, triggerBringsMedia } from '../../media.ts';
import { DIRECT_CALLS } from '../../triggers.ts';
import type { PhaseContext, PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Planned } from './planner.ts';
import type { Pulled } from './pulls.ts';
import type { Setup } from './setup.ts';
import type { MediaItem, Staged, Tracked } from './stages.ts';

/** The second look's stage: the video states it re-watched (null: none offered) and its answers on pictures. */
export type RewatchStage = Tracked<{ videos: Map<string, VideoState> | null; imageAnswers: Map<string, unknown> }>;

/** The media offer the planner was sent (plannerMedia): the re-watch's offer and whether it lists videos. */
type MediaOffer = RewatchOffer & { offersVideos: boolean };

/** What the second-look step made: its switches, the items it may offer, its chain and its stage once started. */
export type SecondLook = {
  videoRewatchOn: boolean;
  imageRelookOn: boolean;
  mediaWanted: boolean;
  pictures: Array<MediaItem>;
  gifItems: Array<MediaItem>;
  watchedGifs: ((guildId: string, items: Array<{ itemId: string }>) => Map<string, unknown>) | null;
  rewatchChain: Promise<void> | null;
  // Set once the chain starts the second look; read when the request is built.
  slot: { rewatch: RewatchStage | null };
  videosSoFar: () => Promise<Map<string, VideoState> | undefined>;
};

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.js in stage 5c, a pure split
export function startSecondLook(
  ctx: PhaseContext,
  params: PhaseParams,
  opened: Opened,
  setup: Setup,
  planned: Planned,
  pulled: Pulled,
  staged: Staged
): SecondLook {
  const { describer, applyRewatch, maybeRewatch } = ctx;
  const { trigger = null, triggerKind = null } = params;
  const { channel, guildId } = opened;
  const { config, features, asked, coreTools, pace, rawHistory, selfName, candidate } = setup;
  const { planner } = planned;
  const { routedPull } = pulled;
  const { deadline, track, chainFailed, previews, previewed, captionsSoFar, captionCandidates } = staged;
  const { videoStage, videoCandidates } = staged;
  // A second look when the trigger asks about a watched video or a posted picture: a
  // direct address only (never a spontaneous or an overheard turn). Videos under features.videoRewatch (with the video stage), watched GIFs under
  // features.videoRewatch and video vision, pictures under features.imageRelook (a missing
  // key counts as on, each; the look runs through the vision model), the persona's own
  // posted drawings included.
  // A routed call asks about its source, whose media no turn looks at: the media
  // here belong to another conversation, so nothing is offered or retried.
  // It needs the videos' states and its transcript the file previews; it works on a
  // copy of the states, so a late re-watch never touches what the request was built from.
  const videoRewatchOn =
    Boolean(videoStage) && features.videoRewatch !== false && typeof describer?.rewatchVideo === 'function';
  const imageRelookOn = features.imageRelook !== false && typeof describer?.relookImage === 'function';
  // Watched GIFs under features.videoRewatch and video vision (they are watched as clips);
  // the describer's watchedGifs offers none while GIFs are not watched (media.gif.watch).
  const watchedGifs = typeof describer?.watchedGifs === 'function' ? describer.watchedGifs.bind(describer) : null;
  const gifRewatchOn =
    isVideoVisionOn(config) &&
    features.videoRewatch !== false &&
    typeof describer?.rewatchGif === 'function' &&
    Boolean(watchedGifs);
  // The items a second look may be offered for (the re-watch, or the planner's `<media>`).
  // With features.coreTools no classifier picks a second look for her: she calls media.look.
  const mediaWanted = asked && (videoRewatchOn || imageRelookOn || gifRewatchOn) && !routedPull && !coreTools;
  const pictures = mediaWanted && imageRelookOn ? (relookCandidates(rawHistory) as Array<MediaItem>) : [];
  const gifItems = mediaWanted && gifRewatchOn ? (gifRewatchItems(rawHistory) as Array<MediaItem>) : [];
  const slot: SecondLook['slot'] = { rewatch: null };
  let rewatchChain: Promise<void> | null = null;
  // Someone asked (askedFor): the candidate is their message.
  if (asked && candidate && (videoRewatchOn || imageRelookOn || gifRewatchOn)) {
    if (coreTools) {
      log.info('rewatch: skipped', { channel: channel.id, reason: 'core-tools' });
    } else if (routedPull) {
      log.info('rewatch: skipped', { channel: channel.id, reason: 'routed' });
    } else if (planner) {
      // The planner's re-watch block picks the item and the question (its `<media>` built by
      // plannerMedia below); the second look itself waits for the video stage, as before.
      rewatchChain = planner.result
        .then(async (plan) => {
          // The planner's media offer is the one plannerMedia built for it.
          const offer = plan.offer.media as MediaOffer | null | undefined;
          const answer = plan.blocks.rewatch;
          if (!offer || answer.state !== 'ok') return undefined;
          await videoStage?.settled;
          if (deadline.passed) return undefined;
          const stage = track('rewatch', async () => {
            const own = new Map(videoStage?.value?.videos ?? offer.states);
            const imageAnswers = new Map<string, unknown>();
            try {
              await applyRewatch({
                guildId,
                channelId: channel.id,
                offer,
                pick: answer.pick,
                reason: answer.parse,
                videos: own,
                imageAnswers,
              });
            } catch (err) {
              log.warn('rewatch: failed', { channel: channel.id, error: err });
            }
            // The video states only when videos were offered; otherwise the video stage's stand.
            return { videos: offer.offersVideos ? own : null, imageAnswers };
          });
          slot.rewatch = stage;
          return stage.settled;
        })
        .catch(chainFailed('rewatch'));
    } else {
      rewatchChain = Promise.all([videoStage?.settled, previews.settled])
        .then(() => {
          const watched = videoStage?.value?.videos;
          const offersVideos = videoRewatchOn && Boolean(watched);
          // Read from the cache now, after the stages above: a GIF watched meanwhile counts.
          const gifCaptions = gifItems.length > 0 && watchedGifs ? watchedGifs(guildId, gifItems) : new Map();
          const gifs = gifItems.filter((item) => gifCaptions.has(item.itemId));
          if (deadline.passed || (!offersVideos && !imageRelookOn && gifs.length === 0)) return undefined;
          const stage = track('rewatch', async () => {
            const own = new Map(watched ?? []);
            const imageAnswers = new Map<string, unknown>();
            try {
              await maybeRewatch({
                config,
                guildId,
                channelId: channel.id,
                selfName,
                history: previewed(),
                trigger: candidate,
                videos: own,
                descriptions: captionsSoFar(),
                candidates: offersVideos ? videoCandidates : [],
                gifs,
                gifCaptions,
                pictures,
                imageAnswers,
              });
            } catch (err) {
              log.warn('rewatch: failed', { channel: channel.id, error: err });
            }
            // The video states only when videos were offered; otherwise the video stage's stand.
            return { videos: offersVideos ? own : null, imageAnswers };
          });
          slot.rewatch = stage;
          return stage.settled;
        })
        .catch(chainFailed('rewatch'));
    }
  }
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
        ? await describer.cachedVideos(guildId, videoCandidates)
        : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    videoRewatchOn,
    imageRelookOn,
    mediaWanted,
    pictures,
    gifItems,
    watchedGifs,
    rewatchChain,
    slot,
    videosSoFar,
  };
}
