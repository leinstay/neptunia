// The seventh step of a turn's request: the neighbours, the pulled channels and the participation pick started last,
// the one wait for everything the preparation started (until the deadline, or parts in time), and what of it was
// late. The request phase (src/turn/phases/request.ts) runs it after the lookup step; the turn hands its message to a
// chain of parts here when the splitter answered in time.

import type { Neighbor } from '../../../behavior/neighbors.ts';
import { fetchNeighbors } from '../../../behavior/neighbors.ts';
import type { PulledChannel } from '../../../behavior/pull-fetch.ts';
import { audienceAllows } from '../../../behavior/snapshot.ts';
import { log } from '../../../log.js';
import type { ConversationInfo } from '../../../protocol/adapter.ts';
import type { Draft } from '../../draft.ts';
import { PREPARE_STAGES } from '../../timers.ts';
import type { Ended, PhaseContext, PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Looked } from './lookup.ts';
import type { Planned } from './planner.ts';
import type { Pulled } from './pulls.ts';
import type { SecondLook } from './second-look.ts';
import type { Setup } from './setup.ts';
import type { Staged, Tracked } from './stages.ts';

/** What the wait step made: the last stages, what was late, and the time each stage took. */
export type Waited = {
  ended: null;
  neighborsStage: Tracked<{ neighbors: Array<Neighbor>; hidden: number }> | null;
  pulledStage: Tracked<Array<PulledChannel>> | null;
  participationShown: boolean;
  participationAudienceOf: ((channelId: string) => boolean) | null;
  participationStage: Tracked<Array<unknown>> | null;
  prepareMs: number;
  late: Array<string>;
  timings: Record<string, number | null>;
};

/** The ids an answer's 1-based picks name in an offer's ids, those that exist. */
function pickedIds(ids: unknown, indices: ReadonlyArray<number>): Array<unknown> {
  const list: ReadonlyArray<unknown> = Array.isArray(ids) ? (ids as ReadonlyArray<unknown>) : [];
  return indices.map((n) => list[n - 1]).filter(Boolean);
}

export async function waitForPreparation(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened,
  setup: Setup,
  planned: Planned,
  pulled: Pulled,
  staged: Staged,
  second: SecondLook,
  looked: Looked
): Promise<Ended | Waited> {
  const { clock, ifaceReads, participationOn, participationAudience, pickParticipation } = ctx;
  const { triggerKind = null } = params;
  const { channel, guildId, isPrivate, life } = opened;
  const { config, snapshot, now, likeServer, rawHistory, candidate, selfName, startedAt, historyMs, beforeBar } = setup;
  const { planner } = planned;
  const { finalMode, pulledPending, pullStartedAt } = pulled;
  const { deadline, stages, track, previews, captions, videoStage, splitStage, hasParts, prefetchStage } = staged;
  const { rewatchChain } = second;
  const { linksStage, lookupChain } = looked;
  // A private chat has no neighbouring channels. A neighbour passes the audience rail the
  // pulls pass (audienceAllows, context.pull.sameAudience): everyone who can read this channel
  // can read it. One refused takes no slot, costs no fetch, and never reaches `<server>`
  // either (buildRequest maps only the neighbours it is given); counted on the answer's log.
  const neighborsStage = isPrivate
    ? null
    : track('neighbors', async () => {
        let hidden = 0;
        const accept = (other: ConversationInfo) => {
          const allowed = audienceAllows(channel, other, config);
          if (!allowed) hidden += 1;
          return allowed;
        };
        // Without the listing (the interface does not offer it) there are no neighbours to show.
        const found = snapshot ? await fetchNeighbors(ifaceReads, snapshot, channel, config, now, { accept }) : [];
        return { neighbors: found, hidden };
      });
  // The pulled channels started earlier: timed from their own start.
  const pulledStage = isPrivate && !likeServer ? null : track('pulled', () => pulledPending, pullStartedAt);
  // `<participation>`: the persona's own exchanges on other channels this turn may show, and
  // the pick classifier's choice among them (src/behavior/participation-pick.js; it asks
  // nothing when there is no episode to offer). Late or failed, the newest are shown.
  const participationShown = participationOn(channel, config) && finalMode !== 'diary';
  const participationAudienceOf = participationShown ? participationAudience(channel, config, snapshot) : null;
  const participationStage = participationAudienceOf
    ? track('participation', (): Promise<Array<unknown>> =>
        planner
          ? // The planner's episodes block, mapped back to the episode ids it was offered.
            planner.result.then((plan) => {
              const answer = plan.blocks.episodes;
              return answer.state === 'ok' ? pickedIds(plan.offer.episodes?.ids ?? [], answer.indices) : [];
            })
          : pickParticipation({
              guildId,
              channel,
              snapshot,
              history: rawHistory,
              trigger: candidate,
              triggerKind,
              mode: finalMode,
              selfName,
              audience: participationAudienceOf,
              limits: draft.limits,
            })
      )
    : null;

  // Parts in time end the wait at once: the whole message's preparation is set aside.
  const partsReady = splitStage
    ? splitStage.settled.then(() => (hasParts() ? undefined : new Promise<void>(() => {})))
    : null;
  await beforeBar(
    Promise.race([
      Promise.all([
        previews.settled,
        captions?.settled,
        videoStage?.settled,
        rewatchChain,
        linksStage?.settled,
        lookupChain,
        neighborsStage?.settled,
        pulledStage?.settled,
        participationStage?.settled,
        splitStage?.settled,
        prefetchStage?.settled,
      ]),
      deadline.reached,
      ...(partsReady ? [partsReady] : []),
    ])
  );
  if (hasParts()) {
    // The message holds several requests: runChain answers them, this turn's attention kept.
    deadline.close();
    life.chained = true;
    return { ended: { outcome: 'split', parts: splitStage?.value, history: rawHistory } };
  }
  deadline.close();
  const prepareMs = clock() - startedAt;
  // What this turn has: a stage still running is left out (named in `late`).
  const late = PREPARE_STAGES.filter((name) => stages.has(name) && !stages.get(name)?.done);
  for (const name of late) {
    draft.limits?.add({ kind: 'helper-timeout', where: name });
    const stage = stages.get(name);
    void stage?.settled?.then(() => log.info('turn: stage late', { channel: channel.id, stage: name, ms: stage.ms }));
  }
  const timings: Record<string, number | null> = { history: historyMs };
  for (const name of PREPARE_STAGES.slice(1))
    timings[name] = stages.get(name)?.done ? (stages.get(name)?.ms ?? null) : null;
  return {
    ended: null,
    neighborsStage,
    pulledStage,
    participationShown,
    participationAudienceOf,
    participationStage,
    prepareMs,
    late,
    timings,
  };
}
