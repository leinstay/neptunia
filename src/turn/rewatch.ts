// The second look on a question: the `<media>` list a re-watch classifier (or the turn planner) is offered, the
// classifier's request, and the describer's look again at the item it picked; and the `<transcript>` input every
// classifier of a turn reads. createTurnRunner (src/behavior/turn.js) builds it once per runner with createRewatch; the
// attempt, the lookup and the splitter call its functions.

import { parseRewatchPickDetailed } from '../behavior/planner.js';
import { fillPromptTemplate } from '../behavior/prompt.js';
import { roleModel } from '../llm/roles.js';
import { roleRequestOptions } from '../llm/openrouter.js';
import { log } from '../log.js';
import { oneLine } from '../memory/clamp.js';
import { renderClassifierContext } from './lookup-input.ts';
import type { ClassifierContextInput } from './lookup-input.ts';
import {
  REWATCH_KIND_GIF,
  REWATCH_KIND_PICTURE,
  REWATCH_KIND_VIDEO,
  REWATCH_STATUS_DESCRIBED,
  REWATCH_STATUS_NOT_LOADED,
  REWATCH_STATUS_WATCHED,
  REWATCH_SUMMARY_CHARS,
} from './media.ts';

/** The second look's settings (`media.video.rewatch`). */
type RewatchSettings = {
  contextMessages?: number;
  recentMessages?: number;
  maxCandidates?: number;
  classifierMaxOutputTokens?: number;
};

/** The live config, as far as the second look reads it; the classifier input reads its own keys. */
export type RewatchConfig = ClassifierContextInput['config'] & {
  media?: { video?: { rewatch?: RewatchSettings | null } | null } | null;
};

/** One item a second look may be offered for: a video, a GIF or a picture of a message. */
export type RewatchItem = { itemId: string; messageId: string; name: string; [key: string]: unknown };

/** What the turn knows of a video: its watch state, its caption and an answer to a question about it. */
export type VideoState = { state: string; text?: string; answer?: unknown; [key: string]: unknown };

/** The describer (src/memory/describe.js#createDescriber), as the second look uses it. */
export type RewatchDescriber = {
  describeVideo?: (guildId: string, item: RewatchItem, options: { force: boolean }) => Promise<VideoState | null>;
  videoCapsLeft?: () => { rewatch: number; video: number; gif?: number } | null;
  relookImage: (guildId: string, item: RewatchItem, question: string) => Promise<unknown>;
  rewatchGif: (guildId: string, item: RewatchItem, question: string) => Promise<unknown>;
  rewatchVideo: (guildId: string, item: RewatchItem, question: string) => Promise<unknown>;
};

/** The language model client (src/llm/openrouter.js#createLlm), as a classifier asks it. */
export type ClassifierLlm = {
  complete: (messages: Array<{ role: string; content: string }>, options: object) => Promise<{ text?: string | null }>;
};

/** What createRewatch reads: the dependencies of the runner. */
export type RewatchContext = {
  hot: { readonly prompts: { labels: object; rewatch?: string | null } };
  llm: ClassifierLlm;
  describer: RewatchDescriber | undefined;
};

/** One item of a `<media>` list: the item and the kind it is offered as. */
type Listed = { item: RewatchItem; kind: string };

/** The `<media>` list of one second look. */
export type RewatchOffer = {
  listed: Array<Listed>;
  lines: Array<string>;
  states: Map<string, VideoState>;
  canRetry: boolean;
};

export type OfferArgs = {
  config: RewatchConfig;
  channelId: string;
  history: ClassifierContextInput['history'];
  videos: Map<string, VideoState>;
  descriptions?: Map<string, unknown>;
  candidates: ReadonlyArray<RewatchItem>;
  gifs?: ReadonlyArray<RewatchItem>;
  gifCaptions?: Map<string, unknown>;
  pictures?: ReadonlyArray<RewatchItem>;
};

/** A re-watch answer's pick: the item's number, the question and whether it asks for a retry. */
type Pick = { n: number; question: string; retry: boolean } | null;

export type Rewatch = {
  classifierContext: (params: Omit<ClassifierContextInput, 'labels'> & { contextMessages: number }) => {
    triggerText: string;
    transcriptBlock: string;
  };
  maybeRewatch: (
    args: OfferArgs & {
      guildId: string;
      selfName: string;
      trigger: ClassifierContextInput['trigger'];
      imageAnswers: Map<string, unknown>;
    }
  ) => Promise<void>;
  rewatchOffer: (args: OfferArgs) => RewatchOffer | null;
  applyRewatch: (args: {
    guildId: string;
    channelId: string;
    offer: RewatchOffer;
    pick: Pick;
    reason: string | null;
    videos: Map<string, VideoState>;
    imageAnswers: Map<string, unknown>;
  }) => Promise<void>;
};

export function createRewatch(ctx: RewatchContext): Rewatch {
  const { hot, llm, describer } = ctx;

  /**
   * The `<transcript>` block of a classifier request (re-watch, search) with
   * the media states this turn already has: renderClassifierContext over the
   * live labels (prompts.labels, read now).
   */
  function classifierContext(params: Omit<ClassifierContextInput, 'labels'> & { contextMessages: number }): {
    triggerText: string;
    transcriptBlock: string;
  } {
    return renderClassifierContext({ ...params, labels: hot.prompts.labels });
  }

  /**
   * The second look on a question (features.videoRewatch for videos,
   * features.imageRelook for pictures): when the trigger asks about a video
   * watched, or a picture posted, in the last `media.video.rewatch.recentMessages`
   * messages (at most `media.video.rewatch.maxCandidates` of them, the videos
   * first, then the watched GIFs, then the pictures, each newest first), one cheap classifier call
   * (prompts.rewatch, on the analyzer model: roleModel for `analyzer` --
   * `models.byPurpose.rewatch`, else `models.base.analyzer`, else its default; its answer capped at
   * `media.video.rewatch.classifierMaxOutputTokens`) picks the item and
   * the question. For a video the describer looks at it again
   * (describer.rewatchVideo) and the answer joins that video's state as
   * `answer: { question, text }` -- mutating `videos` in place. For a picture
   * (`pictures`, relookCandidates; listed with the caption `descriptions`
   * holds for it) the describer looks at it again (describer.relookImage) and
   * the answer goes into `imageAnswers` under the picture's id. A watched GIF
   * (`gifs`, gifRewatchItems narrowed to the watched ones; `gifCaptions` holds
   * each one's watched caption) is listed as a `video`, status `watched`,
   * after the videos and before the pictures; the describer watches its clip
   * again (describer.rewatchGif) and the answer goes into `imageAnswers`
   * under the GIF's id (rendered as `videoAnswered`, see
   * src/media/classify.js#mediaLabelFor). A GIF takes a second-look slot and a
   * GIF watch slot (`videoCapsLeft().gif`), never a video one. Videos that
   * did not load (`error` state) are candidates too whenever the describer
   * can fetch one (describer.describeVideo): the classifier's `<n> | retry`
   * watches one again with `force` and its new state replaces the old one; a
   * retry never applies to a picture. The explicit request has its own slot,
   * apart from the `media.video.maxPerTurn` new videos this turn already
   * fetched; the describer's daily caps still apply. At most one second look
   * or retry per turn. The `<media>` lines are numbered 1.. in that order
   * (`<n> | <kind> | <name> | <status> | <summary>`) and the classifier
   * answers with that ordinal, mapped back here. A `<transcript>` block before
   * `<media>` carries the last `media.video.rewatch.contextMessages` messages before the
   * trigger (0 omits it), with the video states and captions this turn already has. Never throws: any failure leaves
   * `videos` and `imageAnswers` as they were. The question and the answer are data: never logged
   * (`rewatch: classified` names a picked GIF `target: 'gif'` and counts `offered.gifs`);
   * every early stop logs `rewatch: skipped` with its reason. The classifier is
   * not asked when its answer could not run (`reason: 'cap'`): the describer's
   * `videoCapsLeft()` (when it has one; read only) says no video can be
   * looked at or retried today (no video slot left, or no second-look slot
   * left and no failed video can be retried) and no picture can be looked
   * at (no second-look slot left -- one counter for every kind) and no GIF
   * can be re-watched (no second-look or no GIF watch slot left) -- with only
   * the second-look slots spent, only the videos that did not load are
   * offered. The classifier's request is an `analyzer` request (roleRequestOptions).
   */
  async function maybeRewatch({
    config,
    guildId,
    channelId,
    selfName,
    history,
    trigger,
    videos,
    descriptions,
    candidates,
    gifs = [],
    gifCaptions = new Map(),
    pictures = [],
    imageAnswers,
  }: Parameters<Rewatch['maybeRewatch']>[0]): Promise<void> {
    const prompt = hot.prompts?.rewatch;
    if (!prompt) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-prompt' });
      return;
    }
    const offer = rewatchOffer({
      config,
      channelId,
      history,
      videos,
      descriptions,
      candidates,
      gifs,
      gifCaptions,
      pictures,
    });
    if (!offer) return;
    const system = fillPromptTemplate(prompt, { name: selfName ?? '' });
    const rewatchCfg = config.media?.video?.rewatch ?? {};
    // The chat around the question.
    const { triggerText, transcriptBlock } = classifierContext({
      config,
      selfName,
      history,
      trigger,
      contextMessages: Math.max(0, Math.floor(rewatchCfg.contextMessages ?? 50)),
      descriptions,
      videos,
    });
    const user = `${transcriptBlock}<media>\n${offer.lines.join('\n')}\n</media>\n<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          model: roleModel(config, 'analyzer', 'rewatch'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: rewatchCfg.classifierMaxOutputTokens ?? 2000,
            purpose: 'rewatch',
          }),
        }
      );
    } catch (err) {
      // The client throws an Error, with the HTTP status when the provider answered one.
      const failure = err as { statusCode?: unknown; name?: unknown };
      log.warn('rewatch: classifier failed', {
        channel: channelId,
        status: failure.statusCode ?? null,
        name: failure.name,
      });
      return;
    }
    // The parser reads whatever text the client answered.
    const { pick, reason } = parseRewatchPickDetailed(completion.text as string, offer.listed.length);
    await applyRewatch({ guildId, channelId, offer, pick, reason, videos, imageAnswers });
  }

  /**
   * The `<media>` list of one second look (maybeRewatch's rules, shared with
   * the turn planner): the items offered, newest first within each kind and
   * capped at `media.video.rewatch.maxCandidates`, each judged against the
   * video states `videos`, `gifCaptions` and today's slots, rendered as
   * `<n> | <kind> | <name> | <status> | <summary>`. Null after logging
   * `rewatch: skipped` (`cap`, `no-window`, `no-watched`) when nothing can be
   * offered. `states` is the map the list was judged on; `canRetry` whether a
   * video that did not load may be tried again.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  function rewatchOffer({
    config,
    channelId,
    history,
    videos,
    descriptions,
    candidates,
    gifs = [],
    gifCaptions = new Map(),
    pictures = [],
  }: OfferArgs): RewatchOffer | null {
    // The attempt offers a second look only with a describer.
    const seer = describer!;
    // A retry requested by the person has its own slot, outside media.video.maxPerTurn.
    const canRetry = typeof seer.describeVideo === 'function';
    // Today's slots, when the describer can tell: a video's second look and a retry take a video
    // slot; a second look at a video or a picture takes the one second-look slot.
    const slots = typeof seer.videoCapsLeft === 'function' ? seer.videoCapsLeft() : null;
    const questionsOn = !slots || slots.rewatch > 0;
    const videoSlot = !slots || slots.video > 0;
    // A GIF's second look takes a GIF watch slot, never a video one (a describer without the count: no limit).
    const gifSlot = !slots || (slots.gif ?? Infinity) > 0;
    const gifsOn = questionsOn && gifSlot;
    if (
      slots &&
      (!videoSlot || (!questionsOn && !canRetry)) &&
      (pictures.length === 0 || !questionsOn) &&
      (gifs.length === 0 || !gifsOn)
    ) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'cap' });
      return null;
    }
    const rewatchCfg = config.media?.video?.rewatch ?? {};
    const recent = Math.max(0, Math.floor(rewatchCfg.recentMessages ?? 60));
    if (recent === 0) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-window' });
      return null;
    }
    const states = videos instanceof Map ? videos : new Map<string, VideoState>();
    // `candidates`, `gifs` and `pictures` are each newest first: the videos come first, then the
    // GIFs, and the cap over the merged list keeps the newest of each.
    const maxCandidates = Math.max(1, Math.floor(rewatchCfg.maxCandidates ?? 6));
    const recentIds = new Set(history.slice(-recent).map((m) => m.id));
    const seen = new Set<string>();
    const listed: Array<Listed> = [];
    for (const item of videoSlot ? candidates : []) {
      if (listed.length >= maxCandidates) break;
      if (seen.has(item.itemId) || !recentIds.has(item.messageId)) continue;
      const state = states.get(item.itemId)?.state;
      if (!(state === 'watched' && questionsOn) && !(state === 'error' && canRetry)) continue;
      seen.add(item.itemId);
      listed.push({ item, kind: REWATCH_KIND_VIDEO });
    }
    for (const item of gifsOn ? gifs : []) {
      if (listed.length >= maxCandidates) break;
      if (seen.has(item.itemId) || !recentIds.has(item.messageId) || !gifCaptions.get(item.itemId)) continue;
      seen.add(item.itemId);
      listed.push({ item, kind: REWATCH_KIND_GIF });
    }
    for (const item of questionsOn ? pictures : []) {
      if (listed.length >= maxCandidates) break;
      if (seen.has(item.itemId) || !recentIds.has(item.messageId)) continue;
      seen.add(item.itemId);
      listed.push({ item, kind: REWATCH_KIND_PICTURE });
    }
    if (listed.length === 0) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-watched', watched: 0, recent });
      return null;
    }

    const lines = listed.map(({ item, kind }, index) => {
      if (kind === REWATCH_KIND_PICTURE) {
        const caption = descriptions?.get(item.itemId);
        const summary = caption ? [...oneLine(caption)].slice(0, REWATCH_SUMMARY_CHARS).join('') : '';
        return `${index + 1} | ${kind} | ${oneLine(item.name)} | ${REWATCH_STATUS_DESCRIBED} | ${summary}`.trimEnd();
      }
      if (kind === REWATCH_KIND_GIF) {
        const summary = [...oneLine(gifCaptions.get(item.itemId))].slice(0, REWATCH_SUMMARY_CHARS).join('');
        return `${index + 1} | ${REWATCH_KIND_VIDEO} | ${oneLine(item.name)} | ${REWATCH_STATUS_WATCHED} | ${summary}`.trimEnd();
      }
      // Every video listed has a state: it was judged on it above.
      const video = states.get(item.itemId)!;
      const status = video.state === 'watched' ? REWATCH_STATUS_WATCHED : REWATCH_STATUS_NOT_LOADED;
      const summary =
        video.state === 'watched' ? [...oneLine(video.text)].slice(0, REWATCH_SUMMARY_CHARS).join('') : '';
      return `${index + 1} | ${kind} | ${oneLine(item.name)} | ${status} | ${summary}`.trimEnd();
    });
    return { listed, lines, states, canRetry };
  }

  /**
   * The second look a re-watch answer asked for (`pick`, read by
   * parseRewatchPickDetailed against `offer.listed`; `reason` its parse code)
   * on the item of `offer` it names: logged `rewatch: classified` (codes and
   * counts only), then -- for a usable pick -- the describer looks again and
   * the answer lands in `videos` (mutated in place: a video's answer, or a
   * retried video's new state) or `imageAnswers` (a picture's or a GIF's).
   * A retry is for a video that did not load, a question for a watched one, a
   * GIF or a picture, judged on the states the list was built from
   * (`offer.states`); anything else is ignored.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  async function applyRewatch({
    guildId,
    channelId,
    offer,
    pick,
    reason,
    videos,
    imageAnswers,
  }: Parameters<Rewatch['applyRewatch']>[0]): Promise<void> {
    const { listed, states, canRetry } = offer;
    const entry = pick ? listed[pick.n - 1] : null;
    const item = entry?.item ?? null;
    const isPicture = entry?.kind === REWATCH_KIND_PICTURE;
    const isGif = entry?.kind === REWATCH_KIND_GIF;
    const loaded = item && !isPicture && !isGif ? states.get(item.itemId)?.state === 'watched' : false;
    // A retry is for a video that did not load, a question for a watched one, a GIF or a picture; anything else is ignored.
    const usable = Boolean(item) && (isPicture || isGif ? !pick?.retry : pick?.retry !== loaded);
    const pictureCount = listed.filter((candidate) => candidate.kind === REWATCH_KIND_PICTURE).length;
    const gifCount = listed.filter((candidate) => candidate.kind === REWATCH_KIND_GIF).length;
    const watchedCount = listed.filter(
      (candidate) => candidate.kind === REWATCH_KIND_VIDEO && states.get(candidate.item.itemId)?.state === 'watched'
    ).length;
    // Codes and counts only, never the question: an answer outside the format hints at a prompt mismatch.
    const level = reason === 'unknown-id' || reason === 'no-bar' ? 'warn' : 'info';
    log[level]('rewatch: classified', {
      channel: channelId,
      candidates: listed.length,
      offered: {
        watched: watchedCount,
        notLoaded: listed.length - watchedCount - pictureCount - gifCount,
        gifs: gifCount,
        pictures: pictureCount,
      },
      retryAllowed: canRetry,
      parse: reason,
      kind: pick ? (pick.retry ? 'retry' : 'question') : null,
      target: entry?.kind ?? null,
      picked: usable,
    });
    if (!usable || !item || !pick) return;
    // A usable pick comes with a describer: the offer it picked from needed one.
    const seer = describer!;

    if (isPicture) {
      const answer = await seer.relookImage(guildId, item, pick.question);
      if (answer) imageAnswers.set(item.itemId, answer);
      return;
    }
    if (isGif) {
      const answer = await seer.rewatchGif(guildId, item, pick.question);
      if (answer) imageAnswers.set(item.itemId, answer);
      return;
    }
    if (pick.retry) {
      // A retry is offered only with describeVideo (rewatchOffer's canRetry).
      const retried = await seer.describeVideo!(guildId, item, { force: true });
      if (retried) videos.set(item.itemId, retried);
      return;
    }
    const answer = await seer.rewatchVideo(guildId, item, pick.question);
    if (answer)
      videos.set(item.itemId, { ...(videos.get(item.itemId) ?? states.get(item.itemId)), answer } as VideoState);
  }

  return { classifierContext, maybeRewatch, rewatchOffer, applyRewatch };
}
