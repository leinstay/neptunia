// One turn of the replay modes that read Discord (a message, a rebuilt request, a trigger run, a skill scenario) on
// the engine's own turn runner: the runner `--inner` composes (scripts/lib/replay-inner.ts#innerTurnRunner) over the
// Discord adapter on REST with every write refused and recorded, the memory of the data folder read only, and every
// clock at the moment of the turn. The chat reads stop at that moment (`momentReads`): a history read of Discord asks
// for the messages before it and keeps none after it, and a chat the caller serves (a scenario's channel with its
// invented lines and the persona's lines of the turns before) answers from those lines. Each run returns what the stored-turn
// mode keeps of a turn (scripts/lib/turn-report.ts): every request with its messages, tools and answer, the writes,
// the kept calls, the journal lines and the turn's result.

import { lineOf } from '../../src/behavior/line-of.ts';
import { userText } from '../../src/behavior/prompt.ts';
import { estimateMessages } from '../../src/llm/tokens.ts';
import type { Reads } from '../../src/interface/reads.ts';
import type { MessageEvent } from '../../src/protocol/adapter.ts';
import { eventOfLine } from './platform-objects.ts';
import { innerTurnRunner } from './replay-inner.ts';
import { STOPPED, recordingLlm, turnReport } from './turn-report.ts';
import type { KeptRequest, TurnReport } from './turn-report.ts';
import type { RecordedWrite } from './turn-port.ts';
import type { KeptCall } from './turn-tools.ts';
import type { Wired } from './turn-wiring.ts';

type Rec = Record<string, unknown>;
type Client = { complete: (messages: unknown, options?: unknown) => Promise<unknown> };

/** Discord's epoch: a snowflake counts milliseconds from it in its high bits. */
const DISCORD_EPOCH = 1420070400000n;

/** The smallest Discord snowflake of a moment after `at`: a history read before it ends at `at`. */
export function snowflakeAfter(at: number): string {
  return String((BigInt(Math.floor(at) + 1) - DISCORD_EPOCH) << 22n);
}

/** The order of two snowflakes, numerically, for the lines a served chat holds. */
const byId = (a: string, b: string): number => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/**
 * `reads` with every history read cut at `at`: a chat of `served` answers from its lines (the shape of
 * src/behavior/line-of.ts's output) as the platform pages them, newest first under `before` and `limit`, and any
 * other chat asks the platform for the messages before `at` and keeps none after it.
 */
export function momentReads<T extends Reads>(
  reads: T,
  { at, served }: { at: number; served: ReadonlyMap<string, ReadonlyArray<Rec>> }
): T {
  const moment: Reads = {
    ...reads,
    history: async (ref, query) => {
      const lines = served.get(String(ref.chatId));
      if (lines !== undefined) {
        const held = lines
          .filter((line) => Number(line.ts) <= at)
          .sort((a, b) => Number(a.ts) - Number(b.ts) || byId(String(a.id), String(b.id)))
          .filter((line) => query.before === undefined || byId(String(line.id), query.before) < 0)
          .filter((line) => query.after === undefined || byId(String(line.id), query.after) > 0);
        const page = held.slice(Math.max(0, held.length - (query.limit ?? held.length)));
        return {
          events: page.map((line) => eventOfLine(line, ref.iface)),
          complete: page.length === held.length,
        };
      }
      const cursor = query.before ?? query.after ?? query.around;
      const page = await reads.history(ref, cursor === undefined ? { ...query, before: snowflakeAfter(at) } : query);
      return page === null ? null : { ...page, events: page.events.filter((event) => Number(event.message.at) <= at) };
    },
  };
  return moment as T;
}

/** The line of the message `id` in the chat `ref` as the turn's reads give it, or null when they lack it. */
export async function lineIn(reads: Reads, ref: { iface: string; chatId: string }, id: string): Promise<Rec | null> {
  const page = await reads.history(ref, { limit: 100 });
  const events: ReadonlyArray<MessageEvent> = page?.events ?? [];
  const found = events.find((event) => event.message.id === id);
  return found === undefined ? null : lineOf(found);
}

/** What one replayed turn kept. */
export type ReplayTurnRun = {
  result: Rec;
  requests: Array<KeptRequest>;
  writes: Array<RecordedWrite>;
  calls: Array<KeptCall>;
  journal: Wired['journal']['lines'];
};

/**
 * One turn at the moment `at` on the engine's own runner: `params(reads)` gives the parameters the pipeline would pass,
 * read off the turn's reads, and `stopAt` stops the turn at its first request of that purpose, which it keeps.
 */
export async function replayTurn(input: {
  root: string;
  dataDir: string;
  hot: unknown;
  port: unknown;
  llm: Client;
  embed: (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;
  rng: () => number;
  turnId: string;
  at: number;
  served: ReadonlyMap<string, ReadonlyArray<Rec>>;
  params: (reads: Reads) => Promise<Rec>;
  stopAt?: string | null;
}): Promise<ReplayTurnRun> {
  const recorded = recordingLlm(input.llm, { stopAt: input.stopAt ?? null });
  const { wired, writes } = innerTurnRunner({
    root: input.root,
    dataDir: input.dataDir,
    hot: input.hot,
    port: input.port,
    llm: recorded.llm,
    embed: input.embed,
    rng: input.rng,
    now: () => input.at,
    turnId: input.turnId,
    wrapReads: (reads) => momentReads(reads, { at: input.at, served: input.served }),
  });
  try {
    await wired.seed();
    const params = await input.params(wired.reads);
    let result: Rec;
    try {
      result = await wired.under(() => wired.runner.runTurn(params));
    } catch (error) {
      // The stop is the run's own end, not a failure: the request it was asked for is kept.
      if (!(error instanceof Error) || error.message !== STOPPED) throw error;
      result = { outcome: 'stopped' };
    }
    return { result, requests: recorded.requests, writes, calls: wired.calls, journal: wired.journal.lines };
  } finally {
    wired.close();
  }
}

/** The report of a replayed turn as the stored-turn mode writes one (scripts/lib/turn-report.ts). */
export function reportOf(run: ReplayTurnRun, turnId: string, sample: number): TurnReport {
  return turnReport({
    turnId,
    sample,
    requests: run.requests,
    writes: run.writes,
    keptCalls: run.calls,
    result: run.result,
    journal: run.journal,
    estimate: (messages) => estimateMessages(messages),
  });
}

/** The text of a message's content: a string, or its text parts joined. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.map((part: { text?: unknown } | null) => (typeof part?.text === 'string' ? part.text : '')).join('')
    : '';
}

/** The system text and the user text of the turn's first request of purpose `reply`, null when it sent none. */
export function firstRequestOf(run: ReplayTurnRun): { system: string; user: string } | null {
  const first = run.requests.find((request) => request.purpose === 'reply');
  if (first === undefined) return null;
  const system = first.messages
    .filter((message) => message.role === 'system')
    .map((message) => contentText(message.content));
  const user = first.messages.find((message) => message.role === 'user');
  return { system: system.join('\n\n'), user: userText(user?.content) };
}
