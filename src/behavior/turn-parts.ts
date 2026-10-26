// The parts of a turn that stand on their own: the deadline of its preparation, the journal's ledger of its preparation
// steps and the note that tells what was not ready when a request went out. Each takes what it needs and keeps its own
// state, so src/behavior/turn.js builds them per attempt.

export type Deadline = {
  reached: Promise<void>;
  readonly passed: boolean;
  leftMs(): number | null;
  extend(ms: number | null): void;
  hold(work: Promise<unknown>, ms: number | null): void;
  close(): void;
};

/**
 * The deadline of a turn's preparation: `reached` resolves once `limitMs`
 * (counted from `startedAt` on `clock`; null = no deadline, never) has
 * passed. `extend(ms)` moves it to a later limit (null lifts it) while it has
 * not passed; `hold(work, ms)`, while it has not passed and has a limit, keeps
 * it from passing until `work` (a promise) settles, at most until `ms` (counted
 * the same way; null or not later than the limit: no hold; one hold at a
 * time): a limit that passed meanwhile passes as soon as `work` settles,
 * unless an `extend` moved it later first. `close()` ends it -- `passed` turns
 * true and the timer is cleared -- once the turn goes on. `leftMs()`: the time
 * left to its limit now (0 once that passed, a hold aside), null without a
 * limit. Also the turn's bar (pace.dropAfterMs).
 */
export function createDeadline({
  clock,
  startedAt,
  schedule,
  limitMs,
}: {
  clock: () => number;
  startedAt: number;
  schedule: (fn: () => void, ms: number) => () => void;
  limitMs: number | null;
}): Deadline {
  let passed = false;
  let limit: number | null = null;
  let cancel: (() => void) | null = null;
  // While a hold is on: the latest limit it allows; `due` once the limit passed under it.
  let holdUntil: number | null = null;
  let due = false;
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fire = () => {
    cancel = null;
    passed = true;
    release();
  };
  const arm = (ms: number | null): void => {
    cancel?.();
    cancel = null;
    limit = ms;
    due = false;
    if (ms === null) return;
    cancel = schedule(
      () => {
        cancel = null;
        if (holdUntil !== null && holdUntil > ms) {
          // Held: wait for the work, at most until the hold's own limit.
          due = true;
          cancel = schedule(fire, Math.max(0, holdUntil - (clock() - startedAt)));
          return;
        }
        fire();
      },
      Math.max(0, ms - (clock() - startedAt))
    );
  };
  arm(limitMs);
  return {
    reached,
    get passed(): boolean {
      return passed;
    },
    leftMs(): number | null {
      if (limit === null) return null;
      return passed ? 0 : Math.max(0, limit - (clock() - startedAt));
    },
    extend(ms: number | null): void {
      if (passed || limit === null) return;
      if (ms === null || ms > limit) arm(ms);
    },
    hold(work: Promise<unknown>, ms: number | null): void {
      if (passed || limit === null || ms === null || ms <= limit || holdUntil !== null) return;
      holdUntil = ms;
      const end = () => {
        holdUntil = null;
        if (due && !passed) {
          cancel?.();
          fire();
        }
      };
      Promise.resolve(work).then(end, end);
    },
    close(): void {
      passed = true;
      cancel?.();
      cancel = null;
    },
  };
}

/** One preparation step of the journal: its operation (src/memory/journal.js) and what became of its result. */
type Op = {
  opId?: string | null;
  started(extra?: Record<string, unknown>): unknown;
  succeeded(result: Record<string, unknown>): unknown;
  failed(code: string): unknown;
  unknown(): unknown;
};
type Entry = {
  stage: string;
  op: Op;
  result: Record<string, unknown> | undefined;
  offered: boolean;
  taken: boolean | null;
  closed: boolean;
  held: boolean;
};

export type Ledger = {
  step(
    stage: string,
    op: Op,
    offeredOf?: (result: Record<string, unknown>) => unknown
  ): {
    opId: string | null | undefined;
    started(extra?: Record<string, unknown>): unknown;
    succeeded(result?: Record<string, unknown>, offered?: boolean): Promise<void>;
    failed(code: string): unknown;
    unknown(): unknown;
  };
  take(stage: string, used: unknown, options?: { hold?: boolean }): void;
  tell(stage: string): void;
  closeAll(): void;
};

/**
 * The preparation steps of one attempt in the journal (link reads, video watches, captions,
 * searches): each step's operation is closed once its work settled and the turn took what it
 * had. `step(stage, op, offeredOf)` wraps an operation of the stage `stage`; its
 * `succeeded(result, offered?)` keeps the result until `take(stage, used)` says whether the
 * stage's value reached the request, then writes `succeeded` with `delivered` (taken and
 * something to offer: `offered`, else `offeredOf(result)`). A step that settles after its
 * take, or one never taken (`closeAll`), is written with `delivered: false`; a stage taken still
 * out with `hold` waits for `tell(stage)` (a later request showed its result) or `closeAll`.
 */
export function createPrepLedger(): Ledger {
  const entries: Array<Entry> = [];
  const close = (entry: Entry): void => {
    if (entry.closed || entry.held || entry.result === undefined || entry.taken === null) return;
    entry.closed = true;
    entry.op.succeeded({ ...entry.result, delivered: entry.taken && entry.offered });
  };
  return {
    step(stage: string, op: Op, offeredOf: (result: Record<string, unknown>) => unknown = () => true) {
      const entry: Entry = { stage, op, result: undefined, offered: false, taken: null, closed: false, held: false };
      entries.push(entry);
      return {
        opId: op.opId,
        started: (extra?: Record<string, unknown>) => op.started(extra),
        succeeded: (result: Record<string, unknown> = {}, offered?: boolean) => {
          entry.result = result;
          entry.offered = typeof offered === 'boolean' ? offered : Boolean(offeredOf(result));
          close(entry);
          return Promise.resolve();
        },
        failed: (code: string) => {
          entry.closed = true;
          return op.failed(code);
        },
        unknown: () => {
          entry.closed = true;
          return op.unknown();
        },
      };
    },
    take(stage: string, used: unknown, { hold = false }: { hold?: boolean } = {}): void {
      for (const entry of entries) {
        if (entry.stage !== stage || entry.taken !== null) continue;
        entry.taken = Boolean(used);
        // A stage still out when taken may yet reach a later request (tell): its record waits for that.
        entry.held = hold && !used;
        close(entry);
      }
    },
    /** A held stage's result reached a later request: its record is written as delivered. */
    tell(stage: string): void {
      for (const entry of entries) {
        if (entry.stage !== stage || !entry.held) continue;
        entry.held = false;
        entry.taken = true;
        close(entry);
      }
    },
    closeAll(): void {
      for (const entry of entries) {
        if (entry.held) {
          entry.held = false;
          close(entry);
        }
        if (entry.taken !== null) continue;
        entry.taken = false;
        close(entry);
      }
    },
  };
}

type Item = { itemId: string; messageId: string };
type Stage<V> = { done?: boolean; value?: V } | null | undefined;

/**
 * What the request showed as not ready and is ready now, told once in a step's note: a video the
 * transcript rendered `pending` (the video stage past the deadline) whose watch finished, and,
 * when the caption stage was late, every line with a picture once the captions are in. The lines
 * come back re-rendered with their original handles. A stage still out says nothing; a line is
 * told once. `pending` is what the request showed (`videoIds` the itemIds, `captions` whether the
 * caption stage was late); `onTold(stage)` closes the journal's step as delivered.
 * `transcript` is the turn's `stepTranscript`.
 */
export function lateMediaTeller({
  lines,
  idByIndex,
  handles,
  memberNames = null,
  selfName,
  videoStage,
  videoItems,
  captions,
  captionItems,
  pending,
  onTold,
  transcript,
}: {
  lines: ReadonlyArray<{ id: string }>;
  idByIndex: Map<number, string>;
  handles: unknown;
  memberNames?: unknown;
  selfName: string;
  videoStage: Stage<{ videos?: unknown }>;
  videoItems: ReadonlyArray<Item>;
  captions: Stage<{ descriptions?: unknown }>;
  captionItems: ReadonlyArray<{ messageId: string }>;
  pending: { videoIds: ReadonlyArray<string>; captions: boolean };
  onTold: (stage: 'videos' | 'captions') => void;
  transcript: (lines: ReadonlyArray<object>, options: Record<string, unknown>) => Array<{ id: string; text: string }>;
}): () => string {
  const told = { videos: new Set<string>(), captions: false };
  return () => {
    const states =
      videoStage?.done && videoStage.value?.videos instanceof Map
        ? (videoStage.value.videos as Map<string, { state?: string }>)
        : null;
    const newVideos = pending.videoIds.filter((itemId) => {
      const state = states?.get(itemId);
      return !told.videos.has(itemId) && state !== undefined && state.state !== 'pending';
    });
    const newCaptions = pending.captions && !told.captions && Boolean(captions?.done);
    const ids = new Set([
      ...newVideos.flatMap((itemId) => videoItems.filter((one) => one.itemId === itemId).map((one) => one.messageId)),
      ...(newCaptions ? captionItems.map((item) => item.messageId) : []),
    ]);
    if (ids.size === 0) return '';
    const handleById = new Map([...idByIndex].map(([index, id]) => [id, index]));
    const media = {
      videos: states ?? undefined,
      descriptions: captions?.done ? captions.value?.descriptions : undefined,
    };
    const out: Array<string> = [];
    for (const line of lines) {
      const index = handleById.get(line.id);
      if (!ids.has(line.id) || !index) continue;
      const item = transcript([line], { selfName, handles, memberNames, indexOffset: index - 1, media }).find(
        (one) => one.id === line.id
      );
      if (item) out.push(item.text);
    }
    for (const itemId of newVideos) told.videos.add(itemId);
    if (newVideos.length > 0) onTold('videos');
    if (newCaptions) {
      told.captions = true;
      onTold('captions');
    }
    return out.join('\n');
  };
}
