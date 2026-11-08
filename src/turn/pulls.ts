// What a turn that spoke had in view: the lines of its chat, so a call queued meanwhile and already shown is not
// answered twice. createTurnRunner (src/behavior/turn.ts) builds it once per runner over the runner's state; the
// outcome phase calls it.

export type Pulls = {
  noteSpokeSaw: (channel: { id: string }, history: ReadonlyArray<{ id: string }>, deferred?: Set<string>) => void;
};

/** What createPulls reads: the lines each chat's last turn that spoke had in view, by chat. */
export type PullsContext = { spokeSaw: Map<string, Set<string>> };

export function createPulls(ctx: PullsContext): Pulls {
  const { spokeSaw } = ctx;

  /**
   * What a turn that spoke had in view (spokeAfterSeeing): this chat's history under this chat. The calls the request
   * named as still waiting for their own turn (`deferred`: the author's queued calls under `labels.task.queued` or a
   * part's `{others}`) are left out: in view, yet deliberately not answered by this turn.
   */
  function noteSpokeSaw(
    channel: { id: string },
    history: ReadonlyArray<{ id: string }>,
    deferred: Set<string> = new Set()
  ): void {
    spokeSaw.set(channel.id, new Set(history.map((m) => m.id).filter((id) => !deferred.has(id))));
  }

  return { noteSpokeSaw };
}
