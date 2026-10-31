// The eighth step of a turn's request: what the preparation brought, taken as the request will show it. The deleted
// lines put back, the late video states, the captions, reads and searches that came in time, the neighbours and
// pulled channels, a diary post's plan, the drawing quota and the `<recent>` lines. The request phase
// (src/turn/phases/request.ts) runs it after the wait.

import { deletedLinesMax, deletedLinesOf, withDeletedLines } from '../../../behavior/deleted-lines.js';
import { isSetKind } from '../../../behavior/diary.ts';
import type { Neighbor } from '../../../behavior/neighbors.ts';
import type { PulledChannel } from '../../../behavior/pull-fetch.ts';
import { lateVideoStates } from '../../../media/classify.js';
import { log } from '../../../log.js';
import type { Diary } from '../../diary.ts';
import type { Draft } from '../../draft.ts';
import { describableCandidates } from '../../media.ts';
import type { Participation } from '../../participation.ts';
import type { VideoState } from '../../rewatch.ts';
import { usableDestination } from '../../routing.ts';
import { NO_RECENT } from '../../history.ts';
import type { HistoryLine, PhaseContext, PhaseParams, PhasePrompts } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Looked } from './lookup.ts';
import type { Pulled } from './pulls.ts';
import type { SecondLook } from './second-look.ts';
import type { Setup } from './setup.ts';
import type { Staged } from './stages.ts';
import type { Waited } from './wait.ts';

// deletedLinesMax is JavaScript whose return type TypeScript cannot infer: the cap, a count of lines.
const linesMax: (context: unknown) => number = deletedLinesMax;

/** The excerpts the memory prefetch retrieved, if its result holds any. */
function excerptsOf(result: unknown): unknown {
  return (result as { excerpts?: unknown } | null)?.excerpts;
}

/** What the gather step took for the request: the history as shown, and every input from the preparation. */
export type Gathered = {
  history: Array<HistoryLine>;
  descriptions: Map<string, unknown> | undefined;
  videos: Map<string, VideoState> | undefined;
  pendingMedia: { videoIds: Array<string>; captions: boolean };
  imageAnswers: Map<string, unknown> | null;
  reads: Map<string, unknown> | undefined;
  lookupResult: Record<string, unknown> | null;
  prefetchResult: unknown;
  neighbors: Array<Neighbor>;
  neighborsHidden: number;
  pulled: Array<PulledChannel>;
  diaryPrep: Awaited<ReturnType<Diary['prepareDiary']>> | null;
  neighborDescriptions: Map<string, unknown> | undefined;
  drawOn: boolean;
  drawQuota: unknown;
  readOnlyIds: Set<string>;
  destination: { name?: string | null } | null;
  recent: ReturnType<Participation['recentInput']>;
  prompts: PhasePrompts;
};

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.js in stage 5c, a pure split
export async function gatherRequest(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened,
  setup: Setup,
  pulled: Pulled,
  staged: Staged,
  second: SecondLook,
  looked: Looked,
  waited: Waited
): Promise<Gathered> {
  const { hot, store, clock, record, describer, images, noteSeen, recentInput } = ctx;
  const { trigger = null, taskResult = null } = params;
  const { channel, guildId, isPrivate, prep } = opened;
  const { config, features, memoryOn, selfId, selfName, snapshot, now, asked, prefetching, diaryPending } = setup;
  const { beforeBar } = setup;
  const { previewed, captions, captionCandidates, videoStage, videoCandidates } = staged;
  const { slot: second2, videosSoFar } = second;
  const { linksStage, slot: lookupSlot } = looked;
  const { neighborsStage, pulledStage, timings } = waited;
  const { prefetchStage } = staged;
  const rewatchStage = second2.rewatch;
  const lookupStage = lookupSlot.lookup;
  // The history the request is built from: with its file previews once they are ready.
  let history = previewed();
  // Messages deleted inside the window: the record's `deleted` lines over its span in this one
  // channel, each the history lacks put back as a placeholder at its own place (never in a
  // private chat); its read takes `timings.record`.
  timings.record = null;
  if (!isPrivate && record && features.record === true && typeof record.iterate === 'function') {
    const found = await deletedLinesOf({
      record: record as { iterate: (...args: Array<unknown>) => unknown },
      guildId,
      channelId: channel.id,
      history,
      selfId,
      selfName,
      nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
      max: linesMax(config.context),
      clock,
    });
    timings.record = found.ms;
    if ('failed' in found && found.failed) log.warn('turn: deleted lines failed', { channel: channel.id });
    draft.deletedIds = found.deletedIds;
    // withDeletedLines keeps the lines it is given and puts the placeholders, shaped like lines, among them.
    history = withDeletedLines(history, found.placeholders) as Array<HistoryLine>;
  }
  // A text attachment cut at media.filePreviewChars (src/media/text-preview.ts#withTextPreviews).
  for (const message of history) {
    for (const attachment of message.attachments ?? []) {
      if ((attachment?.previewLost ?? 0) > 0)
        draft.limits?.add({
          kind: 'preview-cut',
          where: message.id,
          lost: attachment.previewLost,
          detail: attachment.id,
        });
    }
  }
  const descriptions = captions?.done ? captions.value?.descriptions : undefined;
  // A video stage past the deadline: the cached states stay, and the videos it was still
  // watching render not watched (`pending`) instead of as a bare still frame.
  const videos: Map<string, VideoState> | undefined =
    rewatchStage?.done && rewatchStage.value?.videos
      ? rewatchStage.value.videos
      : videoStage?.done
        ? videoStage.value?.videos
        : videoStage
          ? (lateVideoStates(videoCandidates, await videosSoFar(), config.media?.video?.maxPerTurn ?? 5) as Map<
              string,
              VideoState
            >)
          : undefined;
  // What the request shows as not ready, for the steps that follow (lateMediaTeller): the videos rendered
  // `pending`, and whether the captions were late.
  const pendingMedia = {
    videoIds:
      videoStage && !videoStage.done && !(rewatchStage?.done && rewatchStage.value?.videos)
        ? [...(videos ?? [])].filter(([, state]) => state?.state === 'pending').map(([id]) => id)
        : [],
    captions: Boolean(captions) && !captions?.done && captionCandidates.length > 0,
  };
  // A picture's second look on a question (features.imageRelook): rendered under its line.
  const imageAnswers =
    rewatchStage?.done && (rewatchStage.value?.imageAnswers?.size ?? 0) > 0
      ? (rewatchStage.value?.imageAnswers ?? null)
      : null;
  const reads = linksStage?.done ? linksStage.value : undefined;
  const lookupResult = lookupStage?.done ? (lookupStage.value ?? null) : null;
  // A prefetch still out at the deadline: the request says so (`timeout`) instead of waiting.
  const prefetchResult = prefetching
    ? prefetchStage?.done
      ? (prefetchStage.value ?? null)
      : { status: 'timeout', basis: prefetching.lanes.map((lane) => lane.kind), excerpts: [] }
    : null;
  prep.take('prefetch', prefetchResult !== null);
  // What the turn has in front of it from outside, for where her lines came from (noteSeen):
  // someone's message she answers, the retrieved memory, pages read, a lookup, an errand's result.
  if (trigger && String(trigger.authorId ?? '') !== String(selfId)) noteSeen(draft, trigger.content);
  noteSeen(draft, excerptsOf(prefetchResult));
  noteSeen(draft, reads, { read: true });
  noteSeen(draft, lookupResult, { read: true });
  noteSeen(draft, taskResult?.result, { read: true });
  // The journal: which preparation steps reached the request (the rest close as not delivered).
  prep.take('captions', Boolean(captions?.done), { hold: Boolean(captions) });
  prep.take('videos', Boolean(videoStage?.done), { hold: Boolean(videoStage) });
  prep.take('links', Boolean(linksStage?.done));
  prep.take('lookup', Boolean(lookupStage?.done));
  const neighborsFound = neighborsStage?.done ? neighborsStage.value : null;
  const neighbors = Array.isArray(neighborsFound?.neighbors) ? neighborsFound.neighbors : [];
  const neighborsHidden = neighborsFound?.hidden ?? 0;
  // Pulled ahead of a chooser, the channels keep their cached captions when the fresh ones are late.
  const pulledList =
    pulledStage?.done && Array.isArray(pulledStage.value) ? pulledStage.value : (pulled.early?.pulled ?? []);

  // A neighbour's pictures get only the captions the cache already holds, under the
  // chat captions' switch: cachedDescriptions never sends a request or counts a day.
  // A diary post's plan, search and picture check (a request or token cap refuses the turn).
  let diaryPrep: Gathered['diaryPrep'] = null;
  if (diaryPending) {
    const settled = await beforeBar(diaryPending);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the plan's failure as it came, a rail error the turn's end reads
    if ('error' in settled && settled.error) throw settled.error;
    // A settled plan without an error is its value.
    diaryPrep = (settled as { value: NonNullable<Gathered['diaryPrep']> }).value;
    // The post's kind decides how many pictures it takes (drawTool, runSteps): a set kind several, any other one.
    draft.diary = { set: isSetKind(diaryPrep.plan.kind, config.diary?.setKinds) };
  }
  const neighborDescriptions =
    features.mediaDescriptions === true && typeof describer?.cachedDescriptions === 'function' && neighbors.length > 0
      ? describer.cachedDescriptions(
          guildId,
          neighbors.flatMap((neighbor) => describableCandidates(neighbor.messages))
        )
      : undefined;
  // Drawing (features.imageGeneration, a missing key counts as on) needs the image client
  // and Attach Files here. An unasked turn reads the quota for no member, like draw.create charges none.
  // A diary post draws only while its picture check allowed it (its own daily cap and the image cap).
  const drawOn =
    Boolean(images) &&
    features.imageGeneration !== false &&
    channel.permissions.attach &&
    (!diaryPrep || diaryPrep.pictureAllowed);
  const drawQuota = drawOn ? images?.quota({ userId: asked ? (trigger?.authorId ?? null) : null }) : undefined;
  // Neighbours the bot can read but not write in, marked in `<server>` (a pulled channel's
  // record carries its own mark). A pulled channel whose block is shown is left out of the
  // neighbours by buildRequest itself.
  const readOnlyIds = new Set(
    neighbors.filter((neighbor) => neighbor.readOnly === true).map((neighbor) => neighbor.channelId)
  );
  // Where a call from a read-only channel is answered, for `<senses>`.
  const destination = isPrivate ? null : usableDestination(snapshot, config).channel;
  // `<recent>`: the guild's live recent lines (none: an empty list) and the channels this turn may show them from.
  const recent = memoryOn ? recentInput({ channel, snapshot, guildId, isPrivate, config, now }) : NO_RECENT;
  // The prompts this request is built from, read once: the task labels below decide what it names.
  const prompts = hot.prompts;
  return {
    history,
    descriptions,
    videos,
    pendingMedia,
    imageAnswers,
    reads,
    lookupResult,
    prefetchResult,
    neighbors,
    neighborsHidden,
    pulled: pulledList,
    diaryPrep,
    neighborDescriptions,
    drawOn,
    drawQuota,
    readOnlyIds,
    destination,
    recent,
    prompts,
  };
}
