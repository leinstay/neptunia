// The sixth step of a turn's request: the link reads, the search classifier with the searches it asks for, and the
// turn planner's start when its route step did not start it. The request phase (src/turn/phases/request.ts) runs it
// after the second-look step; the wait and the request read the stages it started.

import { log } from '../../../log.js';
import type { Draft } from '../../draft.ts';
import { linkHosts, journalled } from '../../journal.ts';
import type { Lookup } from '../../lookup.ts';
import type { VideoState } from '../../rewatch.ts';
import { readableLinkCandidates } from '../../media.ts';
import type { PhaseContext, PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Planned } from './planner.ts';
import type { Pulled } from './pulls.ts';
import type { SecondLook } from './second-look.ts';
import type { Setup } from './setup.ts';
import type { Staged, Tracked } from './stages.ts';

/** What the lookup step made: the link reads' stage, the search classifier's chain and its stage once started. */
export type Looked = {
  linksStage: Tracked<Map<string, unknown> | undefined> | null;
  cachedLinkReads: () => Map<string, unknown> | undefined;
  lookupChain: Promise<void> | null;
  // Set once the chain starts the search classifier; read when the request is built.
  slot: { lookup: Tracked<Awaited<ReturnType<Lookup['maybeLookup']>> | null> | null };
};

/** The read texts of a link stage's answer (src/web/lookup.js#readLinks). */
function readsOf(value: unknown): Map<string, unknown> {
  const reads = (value as { reads?: unknown } | null | undefined)?.reads;
  return reads instanceof Map ? (reads as Map<string, unknown>) : new Map<string, unknown>();
}

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.js in stage 5c, a pure split
export function startLookup(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened,
  setup: Setup,
  planned: Planned,
  pulled: Pulled,
  staged: Staged,
  second: SecondLook
): Looked {
  const { lookup, maybeLookup, turnContextOf, rewatchOffer } = ctx;
  const { triggerKind = null } = params;
  const { channel, guildId, prepStep } = opened;
  const { config, asked, answersTask, coreTools, rawHistory, servedSnapshot, partner, selfId, selfName } = setup;
  const { candidate, skillsAnswer, pace } = setup;
  const { webLookupOn, webSearchOn, serverOn, planner, plannerStart } = planned;
  const { routedPull } = pulled;
  const { deadline, track, chainFailed, previews, previewed, captionsSoFar, videoStage, videoCandidates } = staged;
  const { videoRewatchOn, imageRelookOn, mediaWanted, pictures, gifItems, watchedGifs, videosSoFar } = second;
  // The web lookup (features.webLookup -- unlike the other switches a
  // missing key counts as OFF: it costs money and the search needs a
  // key). The links: the newest readable links of the history, at most
  // web.links.maxPerTurn NEW reads (cached excerpts are free). Beside them, on a
  // direct address only (not an overheard line), the search classifier
  // when the web search or the server search (recall; a private chat only
  // on its partner's behalf) can run, and what its answer asks for of the two, in parallel.
  let linksStage: Looked['linksStage'] = null;
  const webCfg = config.web ?? {};
  // Cache only: no fetch, no model request, no daily slot (src/web/lookup.js#cachedReads).
  const cachedLinkReads = () => {
    if (!linksStage || typeof lookup?.cachedReads !== 'function') return undefined;
    try {
      return lookup.cachedReads(guildId, readableLinkCandidates(rawHistory, config.media?.video?.sites));
    } catch (err) {
      log.warn('lookup: links failed', { channel: channel.id, error: err });
      return undefined;
    }
  };
  if (webLookupOn && webCfg.links?.enabled !== false && typeof lookup?.readLinks === 'function') {
    const readLinks = lookup.readLinks.bind(lookup);
    linksStage = track('links', async () => {
      try {
        const candidates = readableLinkCandidates(rawHistory, config.media?.video?.sites);
        // The journal: the link reads as one operation of the engine, hosts only.
        const readOp =
          candidates.length > 0 ? prepStep('links', 'read-link', { input: { hosts: linkHosts(candidates) } }) : null;
        const read = await journalled(
          readOp,
          () => readLinks(guildId, candidates, { maxNew: webCfg.links?.maxPerTurn ?? 2 }),
          (value) => {
            const reads = readsOf(value);
            const chars = [...reads.values()].reduce<number>(
              (sum, text) => sum + (typeof text === 'string' ? text.length : 0),
              0
            );
            return {
              result: { hosts: linkHosts(candidates.filter((link) => reads.has(link.id))), chars },
              offered: reads.size > 0,
            };
          }
        );
        // readLinks answers `{ reads }`, the texts by link id.
        return (read as { reads?: Map<string, unknown> }).reads;
      } catch (err) {
        log.warn('lookup: links failed', { channel: channel.id, error: err });
        return undefined;
      }
    });
  }
  // The search classifier's transcript needs the file previews; the captions, video states and
  // page reads it shows are what this turn has at its start (captionsSoFar, videosSoFar, the
  // reads once done). A routed call is read in its source (routedPull), with its captions.
  const slot: Looked['slot'] = { lookup: null };
  let lookupChain: Promise<void> | null = null;
  // `serverOn` (above): the lookup stage runs the server search and `<senses>` says it exists.
  if (asked && !answersTask && coreTools && (webSearchOn || serverOn))
    log.info('lookup: skipped', { channel: channel.id, reason: 'core-tools' });
  // Someone asked (askedFor): the candidate is their message.
  if (asked && candidate && !answersTask && !coreTools) {
    const webOn = webSearchOn;
    if (webOn || serverOn) {
      lookupChain = previews.settled
        .then(() => {
          if (deadline.passed) return undefined;
          const lookupStage = track('lookup', async () => {
            try {
              const chat = previewed();
              const shown = captionsSoFar();
              const videosShown = await videosSoFar();
              return await maybeLookup({
                config,
                guildId,
                channel,
                snapshot: servedSnapshot,
                partner,
                selfId,
                selfName,
                history: routedPull ? routedPull.messages : chat,
                chatHistory: chat,
                trigger: candidate,
                descriptions: routedPull ? new Map([...(shown ?? []), ...routedPull.descriptions]) : shown,
                videos: videosShown,
                // Link reads of this turn when they are in, else what the link cache already holds.
                reads: linksStage?.done ? linksStage.value : cachedLinkReads(),
                webOn,
                serverOn,
                onSearch: () => deadline.extend(pace.prepareSearchMs),
                onSkills: (answer) => {
                  skillsAnswer.value = answer;
                },
                journalStep: prepStep,
                triggerKind,
                limits: draft.limits ?? null,
                // With the planner its lookup block stands in for the search classifier.
                planned: planner ? await planner.result : null,
                turnContext: () => turnContextOf(draft, channel),
              });
            } catch (err) {
              log.warn('lookup: failed', { channel: channel.id, error: err });
              return null;
            }
          });
          slot.lookup = lookupStage;
          // Until the classifier's verdict the deadline waits for it, at most until
          // pace.prepareSearchMs: a search it asks for has moved the deadline there by the time
          // the stage ends; no search lets a limit that passed meanwhile pass at once.
          deadline.hold(lookupStage.settled, pace.prepareSearchMs);
          return lookupStage.settled;
        })
        .catch(chainFailed('lookup'));
    }
  }

  // The turn planner, unless its route step started it already: once the file previews are in
  // (and, when a watched video may be offered a second look, once the video stage settled, as
  // the re-watch waited), with what this turn has then -- the search classifier's transcript
  // (a routed call read in its source) and the re-watch's `<media>` (plannerMedia). A deadline
  // already passed sends nothing: every block keeps its default.
  if (planner && !planner.started) {
    const plannerMedia = (watched: Map<string, VideoState> | undefined) => {
      const offersVideos = videoRewatchOn && Boolean(watched);
      // Read from the cache now, after the stages above: a GIF watched meanwhile counts.
      const gifCaptions = gifItems.length > 0 && watchedGifs ? watchedGifs(guildId, gifItems) : new Map();
      const gifs = gifItems.filter((item) => gifCaptions.has(item.itemId));
      if (!offersVideos && !imageRelookOn && gifs.length === 0) return null;
      const offer = rewatchOffer({
        config,
        channelId: channel.id,
        history: previewed(),
        videos: new Map(watched ?? []),
        descriptions: captionsSoFar(),
        candidates: offersVideos ? videoCandidates : [],
        gifs,
        gifCaptions,
        pictures,
      });
      return offer ? { ...offer, offersVideos } : null;
    };
    const videosFirst = mediaWanted && videoRewatchOn && videoCandidates.length > 0 ? videoStage?.settled : null;
    Promise.all([previews.settled, videosFirst])
      .then(async () => {
        if (planner.started) return;
        if (deadline.passed) {
          planner.abandon('late');
          return;
        }
        const chat = previewed();
        const shown = captionsSoFar();
        const videosShown = await videosSoFar();
        plannerStart({
          lines: routedPull ? routedPull.messages : chat,
          descriptions: routedPull ? new Map([...(shown ?? []), ...routedPull.descriptions]) : shown,
          videos: videosShown,
          reads: linksStage?.done ? linksStage.value : cachedLinkReads(),
          media: mediaWanted ? plannerMedia(videosShown) : null,
        });
      })
      .catch((err: unknown) => {
        log.warn('turn: stage failed', { channel: channel.id, stage: 'planner', error: err });
        planner.abandon('error');
      });
  }
  return { linksStage, cachedLinkReads, lookupChain, slot };
}
