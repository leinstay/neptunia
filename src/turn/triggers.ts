// What a turn's trigger says about how it runs: the trigger kinds, whether a turn posts plain, whether somebody waits
// for it or asked for it, and whether it may take the attention. src/behavior/turn.ts asks these per attempt; a limit
// notice quotes by postsPlain too.

import type { TurnKind } from './request/frame.ts';

/**
 * Why a reply turn runs: a `@mention`, a platform reply to the persona, a
 * follow-up the address classifier said "yes" to, a line the
 * address classifier found to be about the persona but said to someone else
 * or to the room (`overheard`), a private chat message, or a message to the persona left unanswered
 * earlier (`missed`, src/behavior/missed.ts). Each has a `labels.triggers` entry.
 */
export type TriggerKind = 'mention' | 'reply' | 'followUp' | 'overheard' | 'private' | 'missed' | 'errand' | 'inner';

/**
 * Whether a turn of `triggerKind` posts plain, never as a platform reply: the
 * address classifier's turns (a follow-up, an overheard line), whose model
 * `reply="#n"` quotes nothing for messages, the GIF and the picture alike (a
 * pulled line it points at still gets its jump link: replyTarget). Exported so a limit notice can quote by the same rule.
 */
export function postsPlain(triggerKind: TriggerKind | null | undefined): boolean {
  return triggerKind === 'followUp' || triggerKind === 'overheard';
}

/**
 * The trigger kinds that are a direct call (a private chat message included): the typing
 * indicator may show while such a turn prepares and waits for its answer, and its preparation
 * keeps the deadline and the bar (see unhurried).
 */
export const DIRECT_CALLS: ReadonlySet<string | null | undefined> = new Set([
  'mention',
  'reply',
  'followUp',
  'private',
]);

/**
 * Whether nobody waits for a turn of `triggerKind` -- an unprompted one (no trigger kind: a noticed comment, an inner
 * turn) or an overheard line -- so that it prepares without a deadline or a bar.
 */
export function unhurried(triggerKind: TriggerKind | null | undefined): boolean {
  return !DIRECT_CALLS.has(triggerKind);
}

/**
 * Whether someone asked for this turn: it has a trigger that is not an
 * overheard line (talk about the persona asks it nothing). An unasked turn
 * charges no member's
 * picture quota -- like a spontaneous turn.
 */
export function askedFor(trigger: unknown, triggerKind: TriggerKind | null | undefined): boolean {
  return Boolean(trigger) && triggerKind !== 'overheard';
}

/** The lanes of her attention: a chat turn holds `chat`, a heartbeat or a diary turn holds `service`. */
export type Lane = 'chat' | 'service';

/** Her attention: per lane, the ids a turn runs under (src/behavior/attention.ts mirrors each as a lease). */
export type Attention = Readonly<Record<Lane, Set<string>>>;

/** The lane a turn of `kind` runs on: a service (the heartbeat and the diary) has its own. */
export function laneOf(kind: TurnKind): Lane {
  switch (kind) {
    case 'heartbeat':
    case 'diary':
      return 'service';
    case 'reply':
    case 'intention':
    case 'feedback':
    case 'errand_result':
      return 'chat';
  }
}

/**
 * Takes the attention of the lane of `kind` for `id` when the turn may start: one turn at a time on each lane, so not
 * while one runs anywhere on it (src/behavior/pipeline.ts is the only caller that turns a direct ping caught by this
 * into a pending one). The lane taken, or null.
 */
export function takeAttention(attention: Attention, kind: TurnKind, id: string): Lane | null {
  const lane = laneOf(kind);
  if (attention[lane].size > 0) return null;
  attention[lane].add(id);
  return lane;
}
