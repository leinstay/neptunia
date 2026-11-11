// The eighth step of a turn's request: what the preparation brought, taken as the request will show it. The deleted
// lines put back, every line numbered, the late video states, the captions, reads and searches that came in time, a selfreflection post's
// plan and the drawing quota. The request phase
// (src/turn/phases/request.ts) runs it after the wait.

import { accountOf } from '../../../memory/addresses.ts';
import { DELETED_LINES_MAX, deletedLinesOf, withDeletedLines } from '../../../behavior/deleted-lines.ts';
import { DEFAULT_SET_KINDS, isSetKind } from '../../../behavior/selfreflection.ts';
import { lateVideoStates } from '../../../media/classify.ts';
import { log } from '../../../log.ts';
import type { Selfreflection } from '../../selfreflection.ts';
import type { Draft } from '../../draft.ts';
import type { VideoState } from '../../rewatch.ts';
import type { HistoryLine, PhaseContext, PhasePrompts } from '../context.ts';
import type { Prepared } from '../request.ts';
import { VIDEOS_PER_TURN } from './stages.ts';
import { numberLines, withLineNumbers } from '../../history.ts';

/** What the gather step took for the request: the history as shown, and every input from the preparation. */
export type Gathered = {
  history: Array<HistoryLine>;
  descriptions: Map<string, unknown> | undefined;
  videos: Map<string, VideoState> | undefined;
  pendingMedia: { videoIds: Array<string>; captions: boolean };
  imageAnswers: Map<string, unknown> | null;
  reads: Map<string, unknown> | undefined;
  prefetchResult: unknown;
  selfreflectionPrep: Awaited<ReturnType<Selfreflection['prepareSelfreflection']>> | null;
  drawOn: boolean;
  prompts: PhasePrompts;
};

/** What the gather step reads of the attempt. */
type GatherNeeds = Pick<
  Prepared,
  | 'channel'
  | 'placeId'
  | 'isDm'
  | 'prep'
  | 'memoryOn'
  | 'selfId'
  | 'selfName'
  | 'prefetching'
  | 'selfreflectionPending'
  | 'beforeBar'
  | 'previewed'
  | 'captions'
  | 'captionCandidates'
  | 'videoStage'
  | 'videoCandidates'
  | 'prefetchStage'
  | 'slot'
  | 'videosSoFar'
  | 'linksStage'
  | 'timings'
>;

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.ts in stage 5c, a pure split
export async function gatherRequest(ctx: PhaseContext, draft: Draft, turn: GatherNeeds): Promise<Gathered> {
  const { hot, store, clock, record, images } = ctx;
  const { channel, placeId, isDm, prep, memoryOn, selfId, selfName, prefetching, selfreflectionPending } = turn;
  const { beforeBar, previewed, captions, captionCandidates, videoStage, videoCandidates, prefetchStage } = turn;
  const { slot, videosSoFar, linksStage, timings } = turn;
  const rewatchStage = slot.rewatch;
  // The history the request is built from: with its file previews once they are ready.
  let history = previewed();
  // Messages deleted inside the window: the record's `deleted` lines over its span in this one
  // channel, each the history lacks put back as a placeholder at its own place (never in a
  // private chat); its read takes `timings.record`.
  timings.record = null;
  if (!isDm && record && typeof record.iterate === 'function') {
    // The record holds the chat's lines under the top of its tree, each marked with its channel.
    const iterate = record.iterate as (
      top: string,
      range: { from: string; placeIds: Array<string> }
    ) => AsyncIterable<Parameters<typeof withDeletedLines>[1][number] & { occurredAt: string }>;
    const found = await deletedLinesOf({
      readSince: (from) => iterate.call(record, placeId, { from, placeIds: [String(channel.id)] }),
      history,
      selfId,
      selfName,
      nameOf: memoryOn ? (id) => store.getUser(accountOf(store, id, channel.iface))?.names?.[0] ?? null : null,
      max: DELETED_LINES_MAX,
      clock,
    });
    timings.record = found.ms;
    if ('failed' in found && found.failed) log.warn('turn: deleted lines failed', { channel: channel.id });
    draft.deletedIds = found.deletedIds;
    // withDeletedLines keeps the lines it is given and puts the placeholders, shaped like lines, among them.
    history = withDeletedLines<HistoryLine>(history, found.placeholders);
  }
  // Every line the request shows, the reply parents and the deleted lines included, with its number among the stored
  // lines of its place (src/turn/history.ts), which `<chat>` prints.
  history = withLineNumbers(history, numberLines(history, draft.placeLines ?? null));
  // A text attachment cut at FILE_PREVIEW_CHARS (src/turn/phases/request/stages.ts, src/media/text-preview.ts#withTextPreviews).
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
          ? (lateVideoStates(videoCandidates, await videosSoFar(), VIDEOS_PER_TURN) as Map<string, VideoState>)
          : undefined;
  // What the request shows as not ready, for the steps that follow (lateMediaTeller): the videos rendered
  // `pending`, and whether the captions were late.
  const pendingMedia = {
    videoIds:
      videoStage && !videoStage.done && !(rewatchStage?.done && rewatchStage.value?.videos)
        ? [...(videos ?? [])].filter(([, video]) => video?.state === 'pending').map(([id]) => id)
        : [],
    captions: Boolean(captions) && !captions?.done && captionCandidates.length > 0,
  };
  // A picture's second look on a question: rendered under its line.
  const rewatchAnswers = rewatchStage?.done ? rewatchStage.value?.imageAnswers : undefined;
  const imageAnswers = (rewatchAnswers?.size ?? 0) > 0 ? (rewatchAnswers ?? null) : null;
  const reads = linksStage?.done ? linksStage.value : undefined;
  // A prefetch still out at the deadline: the request says so (`timeout`) instead of waiting.
  const prefetchResult = prefetching
    ? prefetchStage?.done
      ? (prefetchStage.value ?? null)
      : { status: 'timeout', basis: prefetching.lanes.map((lane) => lane.kind), excerpts: [] }
    : null;
  prep.take('prefetch', prefetchResult !== null);
  // The journal: which preparation steps reached the request (the rest close as not delivered).
  prep.take('captions', Boolean(captions?.done), { hold: Boolean(captions) });
  prep.take('videos', Boolean(videoStage?.done), { hold: Boolean(videoStage) });
  prep.take('links', Boolean(linksStage?.done));
  // A selfreflection post's plan, search and picture check (a request or token cap refuses the turn).
  let selfreflectionPrep: Gathered['selfreflectionPrep'] = null;
  if (selfreflectionPending) {
    const settled = await beforeBar(selfreflectionPending);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the plan's failure as it came, a rail error the turn's end reads
    if ('error' in settled && settled.error) throw settled.error;
    // A settled plan without an error is its value.
    selfreflectionPrep = (settled as { value: NonNullable<Gathered['selfreflectionPrep']> }).value;
    // The post's kind decides how many pictures it takes (drawTool, runSteps): a set kind several, any other one.
    draft.selfreflection = { set: isSetKind(selfreflectionPrep.plan.kind, DEFAULT_SET_KINDS) };
  }
  // Drawing needs the image client and Attach Files here. A selfreflection post draws only while its picture check allowed it.
  const drawOn =
    Boolean(images) && channel.permissions.attach && (!selfreflectionPrep || selfreflectionPrep.pictureAllowed);
  // The prompts this request is built from, read once: the task labels below decide what it names.
  const prompts = hot.prompts;
  return {
    history,
    descriptions,
    videos,
    pendingMedia,
    imageAnswers,
    reads,
    prefetchResult,
    selfreflectionPrep,
    drawOn,
    prompts,
  };
}
