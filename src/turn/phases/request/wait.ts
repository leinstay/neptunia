// The seventh step of a turn's request: the one wait for everything the preparation started (until the deadline, or
// parts in time), and what of it was late. The request phase (src/turn/phases/request.ts) runs it after the lookup step; the turn hands its message to a
// chain of parts here when the splitter answered in time.

import { log } from '../../../log.ts';
import type { Draft } from '../../draft.ts';
import { PREPARE_STAGES } from '../../timers.ts';
import type { Ended, PhaseContext } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Looked } from './lookup.ts';
import type { SecondLook } from './second-look.ts';
import type { Setup } from './setup.ts';
import type { Staged } from './stages.ts';

/** What the wait step made: the last stages, what was late, and the time each stage took. */
export type Waited = {
  ended: null;
  prepareMs: number;
  late: Array<string>;
  timings: Record<string, number | null>;
};

export async function waitForPreparation(
  ctx: PhaseContext,
  draft: Draft,
  opened: Opened,
  setup: Setup,
  staged: Staged,
  second: SecondLook,
  looked: Looked
): Promise<Ended | Waited> {
  const { clock } = ctx;
  const { channel, life } = opened;
  const { rawHistory, startedAt, historyMs, beforeBar } = setup;
  const { deadline, stages, previews, captions, videoStage, splitStage, hasParts, prefetchStage } = staged;
  const { rewatchChain } = second;
  const { linksStage } = looked;

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
    prepareMs,
    late,
    timings,
  };
}
