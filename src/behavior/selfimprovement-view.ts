// The facts of her `selfimprovement` wake, as code over the journal and the task board: no model, no chat text. Her
// chains (the tool calls of one turn, in order) of the last days are grouped by the ordered tool names with the names
// of their arguments, and the most frequent shapes come with their counts, failures, retries, costs and turn ids. Beside
// them the tools she holds and called in none of those chains, her skills with their use counts, her proposals with
// their state, every shape she made at least twice, her failed calls by tool and code, and what the board holds for her since the last wake: the questions put to her, the reviews (a rejection
// included), the outbox rows addressed to `persona:self` and the fixes that landed, each shown once. The view carries tool names, argument
// names, codes, counts, ids, costs and the board's own titles and notes. `src/behavior/inner/selfimprovement.ts` asks
// for the facts when the wake runs, and marks the outbox rows it showed delivered once the wake committed.

import type { MemoryPage, MemoryQuery, RetrievalBounds } from '../memory/db/semantic-types.ts';
import { memoryQueryFor } from '../memory/retrieval-input.ts';
import { DAY_MS, utcDay } from '../time.ts';
import type { Landed } from '../selfimprovement/landed.ts';
import type { TaskRecord } from '../board/board.ts';
import type { BoardCaller } from '../tools/operations/board.ts';
import { isFiniteNumber, isObj, listOf, objOf } from '../tools/types.ts';
import type { UseCounts } from '../memory/db/skills.ts';

export type ChainCall = { tool: string; args: Array<string>; status: 'ok' | 'failed' | 'unknown'; code: string | null };
export type Chain = { turnId: string; at: number; calls: Array<ChainCall>; costUsd: number };

export type Shape = {
  key: string;
  steps: Array<{ tool: string; args: Array<string> }>;
  count: number;
  failures: number;
  retries: number;
  costUsd: number;
  example: { turnId: string; at: number };
  turnIds: Array<string>;
};

/** How many turn ids of a shape the facts keep. */
const TURN_IDS_SHOWN = 5;

/** One operation of a turn as the journal's lines build it up. */
type Operation = { tool: string; args: Array<string>; at: number; status: ChainCall['status']; code: string | null };

const timeOf = (value: unknown): number => Date.parse(String(value));

/** The argument names a call's `input.args` lists. */
const argNamesOf = (value: unknown): Array<string> =>
  listOf(value).filter((name): name is string => typeof name === 'string');

/** The call status a closing phase stands for. */
function statusOf(phase: unknown): ChainCall['status'] {
  return phase === 'succeeded' ? 'ok' : phase === 'failed' ? 'failed' : 'unknown';
}

/** The operations of each turn from the journal's `skill` action lines, in the order they first appear, and the keys of the shadowed ones. */
function operationsOf(records: ReadonlyArray<unknown>): {
  turns: Map<string, Map<string, Operation>>;
  shadowed: Set<string>;
} {
  const turns = new Map<string, Map<string, Operation>>();
  const shadowed = new Set<string>();
  for (const entry of records) {
    if (!isObj(entry) || entry.kind !== 'action' || entry.name !== 'skill') continue;
    const turnId = typeof entry.turnId === 'string' ? entry.turnId : null;
    const opId = typeof entry.opId === 'string' ? entry.opId : null;
    if (turnId === null || opId === null) continue;
    if (entry.shadow === true) shadowed.add(`${turnId}\n${opId}`);
    const operations = turns.get(turnId) ?? new Map<string, Operation>();
    turns.set(turnId, operations);
    const input = objOf(entry.input);
    if (entry.phase === 'started') {
      if (typeof input.skill === 'string' && !operations.has(opId)) {
        operations.set(opId, {
          tool: input.skill,
          args: argNamesOf(input.args),
          at: timeOf(entry.occurredAt),
          status: 'unknown',
          code: null,
        });
      }
      continue;
    }
    const known = operations.get(opId);
    if (known) {
      known.status = statusOf(entry.phase);
      const code = objOf(entry.result).code;
      known.code = typeof code === 'string' ? code : null;
    }
  }
  return { turns, shadowed };
}

/** The cost of each turn from the journal's `inner` lines of event `turn`. */
function costsOf(records: ReadonlyArray<unknown>): Map<string, number> {
  const costs = new Map<string, number>();
  for (const entry of records) {
    if (!isObj(entry) || entry.kind !== 'inner' || entry.event !== 'turn' || typeof entry.turnId !== 'string') continue;
    const usd = objOf(entry.cost).usd;
    if (isFiniteNumber(usd)) costs.set(entry.turnId, (costs.get(entry.turnId) ?? 0) + usd);
  }
  return costs;
}

/**
 * Her chains from parsed journal lines: the `skill` actions grouped by turn (a turn's calls in the order they first
 * appear, an operation's `started` line giving the tool and the argument names and its closing line the outcome), the
 * cost of each turn from its `inner` line. An operation a `shadow` line marks never ran and is left out, and a turn
 * with no call is no chain. Oldest first.
 */
export function chainsOfJournal(records: ReadonlyArray<unknown>): Array<Chain> {
  const { turns, shadowed } = operationsOf(records);
  const costs = costsOf(records);
  const chains: Array<Chain> = [];
  for (const [turnId, operations] of turns) {
    const made = [...operations]
      .filter(([opId]) => !shadowed.has(`${turnId}\n${opId}`))
      .map(([, operation]) => operation);
    const first = made[0];
    if (first === undefined) continue;
    chains.push({
      turnId,
      at: first.at,
      costUsd: costs.get(turnId) ?? 0,
      calls: made.map(({ tool, args, status, code }) => ({ tool, args, status, code })),
    });
  }
  return chains.sort((x, y) => x.at - y.at);
}

/** The shape of a chain: its tool names in order, each with its sorted argument names. */
function stepsOf(chain: Chain): Array<{ tool: string; args: Array<string> }> {
  return chain.calls.map((call) => ({ tool: call.tool, args: [...call.args].sort() }));
}

const keyOf = (steps: ReadonlyArray<{ tool: string; args: ReadonlyArray<string> }>): string =>
  steps.map((step) => `${step.tool}(${step.args.join(',')})`).join(' > ');

/** Whether a call of the chain did not end ok. */
const failedChain = (chain: Chain): boolean => chain.calls.some((call) => call.status !== 'ok');

/** Whether a call that failed was followed by a call of the same tool. */
const retriedChain = (chain: Chain): boolean =>
  chain.calls.some(
    (call, index) => call.status === 'failed' && chain.calls.slice(index + 1).some((later) => later.tool === call.tool)
  );

/** The chains grouped by shape, every shape with its counts, ordered by count (most first) and then by key. */
export function allShapes(chains: ReadonlyArray<Chain>): Array<Shape> {
  const groups = new Map<string, Array<Chain>>();
  for (const chain of chains) {
    const key = keyOf(stepsOf(chain));
    groups.set(key, [...(groups.get(key) ?? []), chain]);
  }
  const shapes: Array<Shape> = [];
  for (const [key, members] of groups) {
    const newestFirst = [...members].reverse().sort((a, b) => b.at - a.at);
    const newest = newestFirst[0];
    const first = members[0];
    if (newest === undefined || first === undefined) continue;
    shapes.push({
      key,
      steps: stepsOf(first),
      count: members.length,
      failures: members.filter(failedChain).length,
      retries: members.filter(retriedChain).length,
      costUsd: members.reduce((sum, chain) => sum + chain.costUsd, 0),
      example: { turnId: newest.turnId, at: newest.at },
      turnIds: newestFirst.slice(0, TURN_IDS_SHOWN).map((chain) => chain.turnId),
    });
  }
  return shapes.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The `shown` most frequent shapes and how many more there are. */
export function shapesOf(
  chains: ReadonlyArray<Chain>,
  options: { shown: number }
): { shapes: Array<Shape>; more: number } {
  const shapes = allShapes(chains);
  return { shapes: shapes.slice(0, options.shown), more: Math.max(0, shapes.length - options.shown) };
}

/** Calls that failed the same way. */
export type CallFailure = { tool: string; code: string | null; count: number; turnIds: Array<string> };

/** The failed calls of `chains` per tool and code, most frequent first, then by tool and code. */
function failuresOf(chains: ReadonlyArray<Chain>): Array<CallFailure> {
  const groups = new Map<string, CallFailure>();
  for (const chain of [...chains].reverse()) {
    for (const call of chain.calls) {
      if (call.status !== 'failed') continue;
      const key = `${call.tool}\n${call.code ?? ''}`;
      const group = groups.get(key) ?? { tool: call.tool, code: call.code, count: 0, turnIds: [] };
      group.count += 1;
      if (group.turnIds.length < TURN_IDS_SHOWN && !group.turnIds.includes(chain.turnId))
        group.turnIds.push(chain.turnId);
      groups.set(key, group);
    }
  }
  const textOfGroup = (group: CallFailure): string => `${group.tool}\n${group.code ?? ''}`;
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || (textOfGroup(a) < textOfGroup(b) ? -1 : textOfGroup(a) > textOfGroup(b) ? 1 : 0)
  );
}

/** One task she filed with the board's answers for it. */
export type ProposalEntry = {
  task: {
    id: string;
    status: string;
    title: string;
    close_reason: string | null;
    metadata: Record<string, unknown> | null;
    blocked_reason?: string | null;
    unblocks?: string | null;
  };
  questions: ReadonlyArray<Readonly<Record<string, unknown>>>;
  reviews: ReadonlyArray<Readonly<Record<string, unknown>>>;
};
/** A row of the board's outbox: `seq`, `task_id`, `to_whom`, `kind`, `payload`, `created_at`, `delivered_at`. */
export type OutboxRow = Readonly<Record<string, unknown>>;
export type SkillUseRow = { name: string; active: boolean; counts: UseCounts };

export type SelfimprovementFacts = {
  /** What the one retrieval service brought for this wake; null without it or when the read failed. */
  memory?: MemoryPage | null;
  from: number;
  days: number;
  shapes: Array<Shape>;
  moreShapes: number;
  /** Every shape made at least twice in the window, most frequent first, whatever `shown` cuts from `shapes`. */
  repeated: Array<{ key: string; count: number; turnIds: Array<string> }>;
  /** The failed calls per tool and code, most frequent first. */
  failures: Array<CallFailure>;
  unusedTools: Array<string>;
  skills: Array<SkillUseRow>;
  proposals: Array<{
    id: string;
    kind: 'skill' | 'fix' | null;
    status: string;
    title: string;
    closeReason: string | null;
    /** Why the task waits and what would let it go on, while it is blocked. */
    blocked: { reason: string; unblocks: string } | null;
  }>;
  news: {
    questions: Array<{ taskId: string; questionId: string; text: string; answered: boolean }>;
    reviews: Array<{ taskId: string; decision: string; scope: string | null; note: string | null }>;
    outbox: Array<{
      seq: number;
      taskId: string;
      kind: string;
      status: string | null;
      closeReason: string | null;
      /** Why the task stopped, on a row of kind `blocked`, or the code of why it waits, on a row of kind `risk`. */
      blockedReason?: string;
    }>;
    /** Fixes that merged: the pull request's title and paths (src/selfimprovement/landed.ts), each shown once. */
    landed: Array<Landed>;
  };
  outboxSeqs: Array<number>;
};

/** The default window of the facts, and the default number of shapes shown. */
const DAYS_DEFAULT = 14;
const SHAPES_SHOWN_DEFAULT = 5;
/** The addressee of the outbox rows that are hers. */
const SELF = 'persona:self';

type JournalSource = { read(query: { day: string; kind: string; n: number }): unknown } | null;

/** The UTC days from the one of `from` through the one of `to`. */
function daysBetween(from: number, to: number): Array<string> {
  const days: Array<string> = [];
  for (let at = from; utcDay(at) <= utcDay(to); at += DAY_MS) days.push(utcDay(at));
  return days;
}

/** The journal lines of `kinds` from `from` to `to`; a source that is missing or throws gives nothing for that read. */
export async function readJournalLines(
  journal: JournalSource,
  window: { from: number; to: number },
  kinds: ReadonlyArray<string>
): Promise<Array<unknown>> {
  if (journal === null || typeof journal.read !== 'function') return [];
  const out: Array<unknown> = [];
  for (const day of daysBetween(window.from, window.to)) {
    for (const kind of kinds) {
      try {
        out.push(...listOf(await journal.read({ day, kind, n: Number.MAX_SAFE_INTEGER })));
      } catch {
        // A day the journal cannot read leaves its part of the view empty.
      }
    }
  }
  return out.filter((line) => {
    const at = timeOf(objOf(line).occurredAt);
    return Number.isFinite(at) && at >= window.from && at <= window.to;
  });
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The kind of a proposal, from the metadata `task.propose` wrote. */
function kindOf(task: ProposalEntry['task']): 'skill' | 'fix' | null {
  const kind = task.metadata?.kind;
  return kind === 'skill' || kind === 'fix' ? kind : null;
}

/** Whether a board row was made after `since` (every row when `since` is null). */
const after = (row: Readonly<Record<string, unknown>>, since: number | null): boolean =>
  since === null || !(timeOf(row.created_at) <= since);

/** What this wake reads memory for: the failures it already holds. A failed read leaves the wake its other facts. */
async function improvementMemory(
  input: {
    retrieve?: ((query: MemoryQuery) => Promise<MemoryPage | null>) | null;
    bounds?: RetrievalBounds | null;
    log?: { warn?(message: string, fields: Record<string, unknown>): void } | null;
  },
  failures: ReadonlyArray<CallFailure>
): Promise<MemoryPage | null> {
  const { retrieve, bounds } = input;
  if (typeof retrieve !== 'function' || !bounds) return null;
  try {
    const seeds = failures.map((one) => ({ tool: one.tool, code: one.code ?? null }));
    return await retrieve(
      memoryQueryFor({ purpose: 'improvement', failures: seeds, lessons: [], entities: [] }, bounds)
    );
  } catch (error) {
    input.log?.warn?.('selfimprovement: retrieval failed', { code: objOf(error).code ?? null });
    return null;
  }
}

/** The facts of one wake. Nothing here throws: a source that fails leaves its part empty. */
export async function buildSelfimprovementFacts(input: {
  now: number;
  since: number | null;
  days?: number;
  shown?: number;
  journal: JournalSource;
  granted: ReadonlyArray<string>;
  skills: ReadonlyArray<SkillUseRow>;
  proposals: ReadonlyArray<ProposalEntry>;
  outbox: ReadonlyArray<OutboxRow>;
  landed?: ReadonlyArray<Landed>;
  /** The one retrieval service under this wake's issued context, and its budget; absent, the facts hold no page. */
  retrieve?: ((query: MemoryQuery) => Promise<MemoryPage | null>) | null;
  bounds?: RetrievalBounds | null;
  log?: { warn?(message: string, fields: Record<string, unknown>): void } | null;
}): Promise<SelfimprovementFacts> {
  const days = input.days ?? DAYS_DEFAULT;
  const from = input.now - days * DAY_MS;
  const lines = await readJournalLines(input.journal, { from, to: input.now }, ['action', 'inner']);
  const chains = chainsOfJournal(lines);
  const { shapes, more } = shapesOf(chains, { shown: input.shown ?? SHAPES_SHOWN_DEFAULT });
  const called = new Set(chains.flatMap((chain) => chain.calls.map((call) => call.tool)));
  const landed = [...(input.landed ?? [])];
  const landedSeqs = new Set(landed.map((one) => one.seq));
  const outbox = input.outbox.filter(
    (row) => row.to_whom === SELF && !row.delivered_at && !landedSeqs.has(Number(row.seq))
  );
  const rows = outbox.map((row) => {
    const payload = objOf(row.payload);
    return {
      seq: Number(row.seq),
      taskId: asText(row.task_id),
      kind: asText(row.kind),
      status: typeof payload.status === 'string' ? payload.status : null,
      closeReason: typeof payload.close_reason === 'string' ? payload.close_reason : null,
      ...(typeof payload.reason === 'string' ? { blockedReason: payload.reason } : {}),
    };
  });
  const failures = failuresOf(chains);
  return {
    memory: await improvementMemory(input, failures),
    from,
    days,
    shapes,
    moreShapes: more,
    repeated: allShapes(chains)
      .filter((shape) => shape.count >= 2)
      .map(({ key, count, turnIds }) => ({ key, count, turnIds })),
    failures,
    unusedTools: [...new Set(input.granted)].filter((tool) => !called.has(tool)).sort(),
    skills: [...input.skills],
    proposals: input.proposals.map(({ task }) => ({
      id: task.id,
      kind: kindOf(task),
      status: task.status,
      title: task.title,
      closeReason: task.close_reason,
      blocked:
        typeof task.blocked_reason === 'string'
          ? { reason: task.blocked_reason, unblocks: asText(task.unblocks) }
          : null,
    })),
    news: {
      questions: input.proposals.flatMap((entry) =>
        entry.questions
          .filter((question) => after(question, input.since))
          .map((question) => ({
            taskId: entry.task.id,
            questionId: asText(question.id),
            text: asText(question.text),
            answered: Boolean(question.answered_at),
          }))
      ),
      // A plan the owner approved shows in the proposal's own state; every other decision is news.
      reviews: input.proposals.flatMap((entry) =>
        entry.reviews
          .filter((review) => after(review, input.since) && !(review.decision === 'approve' && review.scope === 'plan'))
          .map((review) => ({
            taskId: entry.task.id,
            decision: asText(review.decision),
            scope: typeof review.scope === 'string' ? review.scope : null,
            note: typeof review.note === 'string' && review.note !== '' ? review.note : null,
          }))
      ),
      outbox: rows,
      landed,
    },
    outboxSeqs: [...new Set([...rows.map((row) => row.seq), ...landedSeqs])].sort((a, b) => a - b),
  };
}

/** The fields of a board task an entry carries. */
const entryTask = (task: TaskRecord): ProposalEntry['task'] => ({
  id: task.id,
  status: task.status,
  title: task.title,
  close_reason: task.close_reason ?? null,
  metadata: isObj(task.metadata) ? task.metadata : null,
  blocked_reason: task.blocked_reason,
  unblocks: task.unblocks,
});

/**
 * The tasks she filed, each with its questions and reviews, the other tasks that wait on a question addressed to her,
 * with those questions only, and her undelivered outbox rows, read as `persona`.
 */
export async function proposalsOf(
  board: BoardCaller
): Promise<{ entries: Array<ProposalEntry>; outbox: Array<OutboxRow> }> {
  const tasks = await board.call('persona', 'task.list', { requester: SELF });
  const entries: Array<ProposalEntry> = [];
  for (const task of tasks) {
    const view = await board.call('persona', 'task.show', { id: task.id });
    entries.push({
      task: entryTask(view.task),
      questions: view.questions,
      reviews: view.approvals,
    });
  }
  const mine = new Set(entries.map((entry) => entry.task.id));
  const { questions } = await board.call('persona', 'task.orient', {});
  for (const question of listOf(questions).filter(isObj)) {
    const taskId = asText(question.task_id);
    if (question.to_whom !== SELF || mine.has(taskId)) continue;
    const entry = entries.find((one) => one.task.id === taskId);
    if (entry !== undefined) {
      entry.questions = [...entry.questions, question];
      continue;
    }
    const view = await board.call('persona', 'task.show', { id: taskId });
    entries.push({ task: entryTask(view.task), questions: [question], reviews: [] });
  }
  const outbox = await board.call('persona', 'outbox.pull', { to_whom: SELF });
  return { entries, outbox };
}

/**
 * Marks the rows she was shown delivered, as `persona`: exactly those, so a row that arrived while the view was read
 * stays undelivered. The board marks only rows addressed to `persona:self`.
 */
export async function ackOutbox(board: BoardCaller, seqs: ReadonlyArray<number>): Promise<void> {
  if (seqs.length === 0) return;
  await board.call('persona', 'outbox.pull', { ack_seqs: [...seqs], limit: 0, to_whom: SELF });
}
