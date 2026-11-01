// The facts of her `selfimprovement` wake, as code over the journal and the task board: no model, no chat text. Her
// chains (the tool calls of one turn, in order) of the last days are grouped by the ordered tool names with the names
// of their arguments, and the most frequent shapes come with their counts, failures, retries, costs and turn ids. Beside
// them the tools she holds and called in none of those chains, her skills with their use counts, her proposals with
// their state, and what the board holds for her since the last wake: the questions put to her, the reviews (a rejection
// included) and the outbox rows addressed to `persona:self`, each shown once. The view carries tool names, argument
// names, codes, counts, ids, costs and the board's own titles and notes. `src/behavior/inner/selfimprovement.ts` asks
// for the facts when the wake runs, and marks the outbox rows it showed delivered once the wake committed.

import { DAY_MS, utcDay } from '../time.js';
import type { BoardCaller } from '../tools/impl/board.ts';
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

/**
 * Her chains from parsed journal lines: the `skill` actions grouped by turn (a turn's calls in the order they first
 * appear, an operation's `started` line giving the tool and the argument names and its closing line the outcome), the
 * cost of each turn from its `inner` line. An operation a `shadow` line marks never ran and is left out, and a turn
 * with no call is no chain. Oldest first.
 */
export function chainsOfJournal(records: ReadonlyArray<unknown>): Array<Chain> {
  const turns = new Map<string, Map<string, Operation | null>>();
  const costs = new Map<string, number>();
  const shadowed = new Set<string>();
  for (const entry of records) {
    if (!isObj(entry)) continue;
    const turnId = typeof entry.turnId === 'string' ? entry.turnId : null;
    if (turnId === null) continue;
    if (entry.kind === 'inner' && entry.event === 'turn') {
      const usd = objOf(entry.cost).usd;
      if (isFiniteNumber(usd)) costs.set(turnId, (costs.get(turnId) ?? 0) + usd);
      continue;
    }
    const opId = typeof entry.opId === 'string' ? entry.opId : null;
    if (entry.kind !== 'action' || entry.name !== 'skill' || opId === null) continue;
    const key = `${turnId}\n${opId}`;
    if (entry.shadow === true) shadowed.add(key);
    const operations = turns.get(turnId) ?? new Map<string, Operation | null>();
    turns.set(turnId, operations);
    const input = objOf(entry.input);
    if (entry.phase === 'started') {
      const tool = typeof input.skill === 'string' ? input.skill : null;
      if (tool !== null && !operations.has(opId)) {
        operations.set(opId, {
          tool,
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
  const chains: Array<Chain> = [];
  for (const [turnId, operations] of turns) {
    const calls = [...operations]
      .filter(([opId]) => !shadowed.has(`${turnId}\n${opId}`))
      .map(([, operation]) => operation);
    const made = calls.filter((operation): operation is Operation => operation !== null);
    const first = made[0];
    if (first === undefined) continue;
    chains.push({
      turnId,
      at: first.at,
      costUsd: costs.get(turnId) ?? 0,
      calls: made.map(({ tool, args, status, code }) => ({ tool, args, status, code })),
    });
  }
  return chains.sort((a, b) => a.at - b.at);
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

/** One task she filed with the board's answers for it. */
export type ProposalEntry = {
  task: {
    id: string;
    status: string;
    title: string;
    close_reason: string | null;
    metadata: Record<string, unknown> | null;
  };
  questions: ReadonlyArray<Readonly<Record<string, unknown>>>;
  reviews: ReadonlyArray<Readonly<Record<string, unknown>>>;
};
/** A row of the board's outbox: `seq`, `task_id`, `to_whom`, `kind`, `payload`, `created_at`, `delivered_at`. */
export type OutboxRow = Readonly<Record<string, unknown>>;
export type SkillUseRow = { name: string; active: boolean; counts: UseCounts };

export type SelfimprovementFacts = {
  from: number;
  days: number;
  shapes: Array<Shape>;
  moreShapes: number;
  unusedTools: Array<string>;
  skills: Array<SkillUseRow>;
  proposals: Array<{
    id: string;
    kind: 'skill' | 'fix' | null;
    status: string;
    title: string;
    closeReason: string | null;
  }>;
  news: {
    questions: Array<{ taskId: string; questionId: string; text: string; answered: boolean }>;
    reviews: Array<{ taskId: string; decision: string; scope: string | null; note: string | null }>;
    outbox: Array<{ seq: number; taskId: string; kind: string; status: string | null; closeReason: string | null }>;
  };
  outboxSeqs: Array<number>;
};

/** The default window of the facts, and the default number of shapes shown. */
const DAYS_DEFAULT = 14;
const SHAPES_SHOWN_DEFAULT = 5;
/** The addressee of the outbox rows that are hers. */
const SELF = 'persona:self';

type JournalSource = { read(guildId: string, query: { day: string; kind: string; n: number }): unknown } | null;

/** The UTC days from the one of `from` through the one of `to`. */
function daysBetween(from: number, to: number): Array<string> {
  const days: Array<string> = [];
  for (let at = from; utcDay(at) <= utcDay(to); at += DAY_MS) days.push(utcDay(at));
  return days;
}

/** The journal lines of `kinds` from `from` to `to`; a source that is missing or throws gives nothing for that read. */
export async function readJournalLines(
  journal: JournalSource,
  guildId: string,
  window: { from: number; to: number },
  kinds: ReadonlyArray<string>
): Promise<Array<unknown>> {
  if (journal === null || typeof journal.read !== 'function') return [];
  const out: Array<unknown> = [];
  for (const day of daysBetween(window.from, window.to)) {
    for (const kind of kinds) {
      try {
        out.push(...listOf(await journal.read(guildId, { day, kind, n: Number.MAX_SAFE_INTEGER })));
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

/** The kind of a proposal, from the metadata `board.propose` wrote. */
function kindOf(task: ProposalEntry['task']): 'skill' | 'fix' | null {
  const kind = task.metadata?.kind;
  return kind === 'skill' || kind === 'fix' ? kind : null;
}

/** Whether a board row was made after `since` (every row when `since` is null). */
const after = (row: Readonly<Record<string, unknown>>, since: number | null): boolean =>
  since === null || !(timeOf(row.created_at) <= since);

/** The facts of one wake. Nothing here throws: a source that fails leaves its part empty. */
export async function buildSelfimprovementFacts(input: {
  guildId: string;
  now: number;
  since: number | null;
  days?: number;
  shown?: number;
  journal: JournalSource;
  granted: ReadonlyArray<string>;
  skills: ReadonlyArray<SkillUseRow>;
  proposals: ReadonlyArray<ProposalEntry>;
  outbox: ReadonlyArray<OutboxRow>;
}): Promise<SelfimprovementFacts> {
  const days = input.days ?? DAYS_DEFAULT;
  const from = input.now - days * DAY_MS;
  const lines = await readJournalLines(input.journal, input.guildId, { from, to: input.now }, ['action', 'inner']);
  const chains = chainsOfJournal(lines);
  const { shapes, more } = shapesOf(chains, { shown: input.shown ?? SHAPES_SHOWN_DEFAULT });
  const called = new Set(chains.flatMap((chain) => chain.calls.map((call) => call.tool)));
  const outbox = input.outbox.filter((row) => row.to_whom === SELF && !row.delivered_at);
  const rows = outbox.map((row) => {
    const payload = objOf(row.payload);
    return {
      seq: Number(row.seq),
      taskId: asText(row.task_id),
      kind: asText(row.kind),
      status: typeof payload.status === 'string' ? payload.status : null,
      closeReason: typeof payload.close_reason === 'string' ? payload.close_reason : null,
    };
  });
  return {
    from,
    days,
    shapes,
    moreShapes: more,
    unusedTools: [...new Set(input.granted)].filter((tool) => !called.has(tool)).sort(),
    skills: [...input.skills],
    proposals: input.proposals.map(({ task }) => ({
      id: task.id,
      kind: kindOf(task),
      status: task.status,
      title: task.title,
      closeReason: task.close_reason,
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
    },
    outboxSeqs: rows.map((row) => row.seq),
  };
}

/** The tasks she filed, each with its questions and reviews, and her undelivered outbox rows, read as `persona`. */
export async function proposalsOf(
  board: BoardCaller
): Promise<{ entries: Array<ProposalEntry>; outbox: Array<OutboxRow> }> {
  const tasks = await board.call('persona', 'task.list', { requester: SELF });
  const entries: Array<ProposalEntry> = [];
  for (const task of tasks) {
    const view = await board.call('persona', 'task.show', { id: task.id });
    entries.push({
      task: {
        id: view.task.id,
        status: view.task.status,
        title: view.task.title,
        close_reason: view.task.close_reason ?? null,
        metadata: isObj(view.task.metadata) ? view.task.metadata : null,
      },
      questions: view.questions,
      reviews: view.approvals,
    });
  }
  const outbox = await board.call('persona', 'outbox.pull', { to_whom: SELF });
  return { entries, outbox };
}

/** Marks the rows she was shown delivered, as `persona`. The board marks only rows addressed to `persona:self`. */
export async function ackOutbox(board: BoardCaller, seqs: ReadonlyArray<number>): Promise<void> {
  if (seqs.length === 0) return;
  await board.call('persona', 'outbox.pull', { ack: Math.max(...seqs), limit: 0, to_whom: SELF });
}
