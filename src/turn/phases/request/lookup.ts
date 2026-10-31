// The sixth step of a turn's request: the link reads. Her own tools search during her reply, so no search
// classifier runs before it. The request phase (src/turn/phases/request.ts) runs it after the second-look step; the
// wait and the request read the stages it started.

import { log } from '../../../log.js';
import { linkHosts, journalled } from '../../journal.ts';
import type { Lookup } from '../../lookup.ts';
import { readableLinkCandidates } from '../../media.ts';
import type { PhaseContext } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Planned } from './searches.ts';
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

export function startLookup(ctx: PhaseContext, opened: Opened, setup: Setup, planned: Planned, staged: Staged): Looked {
  const { lookup } = ctx;
  const { channel, guildId, prepStep } = opened;
  const { config, asked, answersTask, rawHistory } = setup;
  const { webLookupOn, webSearchOn, serverOn } = planned;
  const { track } = staged;
  // The links: the newest readable links of the history, at most web.links.maxPerTurn NEW reads (cached excerpts are
  // free).
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
  const lookupChain: Promise<void> | null = null;
  // `serverOn` (above): the lookup stage runs the server search and `<senses>` says it exists.
  if (asked && !answersTask && (webSearchOn || serverOn))
    log.info('lookup: skipped', { channel: channel.id, reason: 'core-tools' });
  return { linksStage, cachedLinkReads, lookupChain, slot };
}
