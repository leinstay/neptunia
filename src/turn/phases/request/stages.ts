// The fourth step of a turn's request: the preparation's deadline and the first stages started beside each other,
// the file previews, the captions of the window's pictures, the splitter of a message that may hold several requests
// and the video watches. The request phase (src/turn/phases/request.ts) runs it after the pull step; the second look,
// the lookup and the wait read its stages.

import { createDeadline } from '../../../behavior/turn-parts.ts';
import type { Deadline } from '../../../behavior/turn-parts.ts';
import { splitCandidate } from '../../../behavior/split.js';
import { withTextPreviews } from '../../../media/text-preview.ts';
import { collectVideos } from '../../../media/classify.js';
import { isVideoVisionOn } from '../../../memory/index.js';
import { log } from '../../../log.js';
import { journalled } from '../../journal.ts';
import type { Lookup } from '../../lookup.ts';
import type { VideoState } from '../../rewatch.ts';
import { describableCandidates } from '../../media.ts';
import { trackStage } from '../../timers.ts';
import type { Stage } from '../../timers.ts';
import type { HistoryLine, PhaseContext, PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Pulled } from './pulls.ts';
import type { Setup } from './setup.ts';

/** One stage of the preparation, with the value its work resolved once it is done (trackStage). */
export type Tracked<TValue> = Omit<Stage, 'value' | 'settled'> & { value: TValue | undefined; settled: Promise<void> };

/** A caption or a video watch's candidate (src/turn/media.ts, src/media/classify.js). */
export type MediaItem = { itemId: string; messageId: string; name: string; kind?: unknown; [key: string]: unknown };

/** What the stages step made: the deadline, the stages it started and how a classifier reads what they have. */
export type Staged = {
  deadline: Deadline;
  stages: Map<string, Stage>;
  track: <TValue>(name: string, work: () => TValue | Promise<TValue>, from?: number) => Tracked<Awaited<TValue>>;
  chainFailed: (name: string) => (err: unknown) => void;
  prefetchStage: Tracked<unknown> | null;
  previews: Tracked<Array<HistoryLine>>;
  previewed: () => Array<HistoryLine>;
  captions: Tracked<{ descriptions?: Map<string, unknown> } | null | undefined> | null;
  captionCandidates: ReturnType<typeof describableCandidates>;
  captionsSoFar: () => Map<string, unknown> | undefined;
  splitStage: Tracked<Awaited<ReturnType<Lookup['maybeSplit']>>> | null;
  hasParts: () => boolean;
  videoStage: Tracked<{ videos?: Map<string, VideoState> } | null | undefined> | null;
  videoCandidates: Array<MediaItem>;
};

export function startStages(
  ctx: PhaseContext,
  params: PhaseParams,
  opened: Opened,
  setup: Setup,
  pulled: Pulled
): Staged {
  const { hot, clock, schedule, describer, fetchImpl, maybeSplit } = ctx;
  const { trigger = null, triggerKind = null, maySplit = false } = params;
  const { channel, guildId, prepStep, life } = opened;
  const { config, features, startedAt, waitsForAll, pace, prefetching, rawHistory, selfName } = setup;
  const { routedPull } = pulled;
  // Everything below starts as soon as its inputs exist and runs alongside the rest; the turn
  // waits for all of it together, at most until the deadline (paceSettings, counted from the
  // turn's start; longer once the search classifier asked for a search -- held for its verdict
  // up to pace.prepareSearchMs while it is out -- or for a direct call that brought media to
  // look at). A stage still running then contributes nothing -- its block
  // is absent, as when it fails -- and keeps running for its cache; nothing it settles later
  // reaches this turn. A stage whose inputs were not ready by then is never started. An
  // unhurried turn has no deadline: it waits for every stage (a
  // search asked for leaves it so: extend never sets a limit on a deadline without one).
  const deadline = createDeadline({ clock, startedAt, schedule, limitMs: waitsForAll ? null : pace.prepareMs });
  life.deadline = deadline;
  const stages = new Map<string, Stage>();
  const track = <TValue>(name: string, work: () => TValue | Promise<TValue>, from = clock()) => {
    const stage = trackStage(work, {
      clock,
      startedAt: from,
      onError: (err) => log.warn('turn: stage failed', { channel: channel.id, stage: name, error: err }),
    });
    stages.set(name, stage);
    // trackStage keeps what `work` resolved as the stage's value and sets `settled` as it starts.
    return stage as Tracked<Awaited<TValue>>;
  };
  // A chain that starts a stage once another settled: never rejects, never fails the turn.
  const chainFailed = (name: string) => (err: unknown) =>
    log.warn('turn: stage failed', { channel: channel.id, stage: name, error: err });

  const prefetchStage = prefetching ? track('prefetch', () => prefetching.pending) : null;

  // Lazy, request-time only (see fetchTextPreview's header comment):
  // never fetched during plain normalization or while just buffered. Read by the
  // transcripts alone: the request's and the two classifiers'.
  const previews = track('previews', () =>
    withTextPreviews(rawHistory, Number(config.media?.filePreviewChars ?? 10000), fetchImpl)
  );
  const previewed = () => (previews.done && Array.isArray(previews.value) ? previews.value : rawHistory);

  // The pictures of the window get a `vision` caption, newest first, capped at
  // media.maxPerTurn; cached captions are free (see src/memory/describe.js). The caption is
  // the only way a picture reaches the persona: none goes into her request as an image. A
  // routed call's own pictures are captioned with its pulled channel instead.
  let captions: Staged['captions'] = null;
  let captionCandidates: Staged['captionCandidates'] = [];
  if (features.mediaDescriptions === true && describer) {
    captionCandidates = describableCandidates(rawHistory);
    const describeOp =
      captionCandidates.length > 0
        ? prepStep('captions', 'describe', { input: { candidates: captionCandidates.length } })
        : null;
    captions = track('captions', () =>
      journalled(
        describeOp,
        () => describer.describeMany(guildId, captionCandidates, { maxNew: config.media?.maxPerTurn ?? 6 }),
        (value) => {
          const count = value?.descriptions?.size ?? 0;
          return { result: { count }, offered: count > 0 };
        }
      )
    );
  }
  // The captions a classifier's transcript shows: this turn's once they are done, else what
  // the describer's cache holds at the classifier's start (a fresh caption lands there).
  const captionsSoFar = () => {
    if (!captions) return undefined;
    if (captions.done) return captions.value?.descriptions;
    try {
      return typeof describer?.cachedDescriptions === 'function'
        ? describer.cachedDescriptions(guildId, captionCandidates)
        : undefined;
    } catch {
      return undefined;
    }
  };

  // The splitter (runTurn's first turn only): a call that may hold several requests asks it
  // now, beside everything else and under the same deadline. The turn waits for it as for any
  // stage; parts in time end the wait at once (below). Without prompts.split it is off
  // (`split: skipped`, `no-prompt`); without labels.task.part (an older labels file) it is
  // never asked. A routed call is read in its source, as the search classifier reads it.
  let splitStage: Staged['splitStage'] = null;
  if (maySplit && trigger && splitCandidate(trigger, triggerKind, config)) {
    const splitPrompt = hot.prompts?.split;
    if (!splitPrompt) {
      log.info('split: skipped', { channel: channel.id, reason: 'no-prompt' });
    } else if (hot.prompts?.labels?.task?.part) {
      const shown = captionsSoFar();
      splitStage = track('split', () =>
        maybeSplit({
          config,
          channelId: channel.id,
          selfName,
          history: routedPull ? routedPull.messages : rawHistory,
          trigger,
          descriptions: routedPull ? new Map([...(shown ?? []), ...routedPull.descriptions]) : shown,
          prompt: splitPrompt,
          isLate: () => deadline.passed,
        })
      );
    }
  }
  const hasParts = () => Boolean(splitStage?.done) && Array.isArray(splitStage?.value);

  // Videos (attached, or linked from a known video site) may be watched
  // by the video describer, newest first, at most media.video.maxPerTurn
  // NEW ones per turn; cached results and limit/error states are free.
  let videoStage: Staged['videoStage'] = null;
  const videoCandidates: Array<MediaItem> = [];
  // Both switches (isVideoVisionOn), like the senses line; a missing videoDescriptions counts as on.
  if (isVideoVisionOn(config) && typeof describer?.describeVideos === 'function') {
    const describeVideos = describer.describeVideos.bind(describer);
    const videoCfg = config.media?.video ?? {};
    for (let i = rawHistory.length - 1; i >= 0; i -= 1) {
      videoCandidates.push(...(collectVideos(rawHistory[i], { videoSites: videoCfg.sites }) as Array<MediaItem>));
    }
    const candidates = videoCandidates;
    const watchOp =
      candidates.length > 0 ? prepStep('videos', 'watch-video', { input: { candidates: candidates.length } }) : null;
    const watchStartedAt = clock();
    videoStage = track('videos', () =>
      journalled(
        watchOp,
        () => describeVideos(guildId, candidates, { maxNew: videoCfg.maxPerTurn ?? 5 }),
        (value) => {
          const states = value?.videos instanceof Map ? [...value.videos.values()] : [];
          return {
            result: {
              seconds: Math.round((clock() - watchStartedAt) / 100) / 10,
              watched: states.filter((state) => state?.state === 'watched').length,
            },
            offered: states.length > 0,
          };
        }
      )
    );
  }
  return {
    deadline,
    stages,
    track,
    chainFailed,
    prefetchStage,
    previews,
    previewed,
    captions,
    captionCandidates,
    captionsSoFar,
    splitStage,
    hasParts,
    videoStage,
    videoCandidates,
  };
}
