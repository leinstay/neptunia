// What scripts/turn-replay.ts keeps of a replayed turn and the report it writes. `recordingLlm` wraps the model client:
// every request is kept with its purpose, its messages and tools, the wall time it took and its answer, and with
// `stopAt` the first request of that purpose is kept and refused, so a run builds one request and stops. `turnReport`
// lays a run out per step: the request's size, the call's milliseconds, her `<think>`, each tool call with its
// arguments, each result's status and size, whether the calls of the step ran together. Then come her reply, the writes,
// the total time from the first request to the reply, the counts and the reason the loop ended. `reportTable` is the
// short table for stderr: counts, sizes and names only, never her words.

import { effectsOf } from '../../src/tools/definitions.ts';
import type { RecordedWrite } from './turn-port.ts';
import type { KeptCall } from './turn-tools.ts';

type Rec = Record<string, unknown>;

/** One request the turn sent, as the recorder kept it. */
export type KeptRequest = {
  purpose: string | null;
  model: string | null;
  messages: Array<Rec>;
  tools: Array<unknown>;
  startedAt: number;
  ms: number | null;
  text: string | null;
  toolCalls: Array<{ id?: string; name?: string; arguments?: unknown }>;
  error: string | null;
};

/** The error a stopped request is refused with. */
export const STOPPED = 'turn-replay: stopped after the first request';

/** The text of a message's content: a string, or its text parts joined with a newline. */
export function contentOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      const one = part as { type?: unknown; text?: unknown } | null;
      return one?.type === 'text' && typeof one.text === 'string' ? one.text : '';
    })
    .join('');
}

type Client = { complete: (messages: unknown, options?: unknown) => Promise<unknown> };

/** `llm` with every request kept in `requests` (see the head of this file). */
export function recordingLlm(
  llm: Client,
  { stopAt = null, wall = Date.now }: { stopAt?: string | null; wall?: () => number } = {}
): { llm: Client; requests: Array<KeptRequest> } {
  const requests: Array<KeptRequest> = [];
  return {
    requests,
    llm: {
      ...llm,
      async complete(messages: unknown, options: unknown = {}) {
        const asked = (options ?? {}) as Rec;
        const kept: KeptRequest = {
          purpose: typeof asked.purpose === 'string' ? asked.purpose : null,
          model: typeof asked.model === 'string' ? asked.model : null,
          messages: Array.isArray(messages) ? (messages as Array<Rec>) : [],
          tools: Array.isArray(asked.tools) ? (asked.tools as Array<unknown>) : [],
          startedAt: wall(),
          ms: null,
          text: null,
          toolCalls: [],
          error: null,
        };
        requests.push(kept);
        if (stopAt !== null && kept.purpose === stopAt) {
          kept.error = STOPPED;
          throw new Error(STOPPED);
        }
        try {
          const done = (await llm.complete(messages, options)) as Rec;
          kept.ms = wall() - kept.startedAt;
          kept.text = typeof done?.text === 'string' ? done.text : null;
          kept.toolCalls = Array.isArray(done?.toolCalls) ? (done.toolCalls as KeptRequest['toolCalls']) : [];
          return done;
        } catch (error) {
          kept.ms = wall() - kept.startedAt;
          kept.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    },
  };
}

/** The characters of every message of a request. */
const requestChars = (request: KeptRequest): number =>
  request.messages.reduce((sum, message) => sum + contentOf(message.content).length, 0);

/** Her `<think>` of an answer, or null. */
function thinkOf(text: string | null): string | null {
  const match = /<think>([\s\S]*?)<\/think>/.exec(text ?? '');
  return match ? match[1].trim() : null;
}

/** The tool messages a request carries after the step before it: each call's result, by call id. */
function resultsOf(request: KeptRequest | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of request?.messages ?? [])
    if (message.role === 'tool' && typeof message.tool_call_id === 'string')
      out.set(message.tool_call_id, contentOf(message.content));
  return out;
}

/** A line the replay's journal kept (scripts/lib/turn-wiring.ts): its kind and the record it would have written. */
export type KeptLine = { kind: string; record: unknown };

/**
 * Each tool call's status by its call id, from the closing line of its journal operation: `ok` for `succeeded`, the
 * result's status for `failed` (else `failed`), `unknown` for `unknown`.
 */
function statusesOf(lines: ReadonlyArray<KeptLine>): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const record = (line.record ?? {}) as { input?: { toolCallId?: unknown }; phase?: unknown; result?: unknown };
    const id = record.input?.toolCallId;
    if (line.kind !== 'action' || typeof id !== 'string') continue;
    const result = (record.result ?? {}) as { status?: unknown };
    if (record.phase === 'succeeded') out.set(id, 'ok');
    else if (record.phase === 'failed') out.set(id, typeof result.status === 'string' ? result.status : 'failed');
    else if (record.phase === 'unknown') out.set(id, 'unknown');
  }
  return out;
}

/** A tool name of the request (`memory_search`) as the engine's name (`memory.search`). */
const engineName = (name: string): string => name.replaceAll('_', '.');

/** Whether the calls of a step ran together: every one a read, which the step runs in one segment. */
const together = (names: ReadonlyArray<string>): boolean =>
  names.length > 1 && names.every((name) => effectsOf(engineName(name)) === 'read');

export type TurnReport = {
  turnId: string;
  sample: number;
  steps: Array<Rec>;
  reply: { messages: Array<string>; reactions: Array<string>; skipped: boolean };
  writes: Array<{ op: string; args: unknown }>;
  keptCalls: Array<KeptCall>;
  totalMs: number | null;
  stepCount: number;
  callCount: number;
  outcome: string | null;
  endedBecause: string | null;
  helperRequests: Array<{ purpose: string | null; ms: number | null }>;
};

/** The report of one sample (see the head of this file). `estimate` turns a request's characters into tokens. */
export function turnReport({
  turnId,
  sample,
  requests,
  writes,
  keptCalls,
  result,
  journal = [],
  estimate,
}: {
  turnId: string;
  sample: number;
  requests: ReadonlyArray<KeptRequest>;
  writes: ReadonlyArray<RecordedWrite>;
  keptCalls: ReadonlyArray<KeptCall>;
  result: Rec | null;
  journal?: ReadonlyArray<KeptLine>;
  estimate: (messages: ReadonlyArray<Rec>) => number;
}): TurnReport {
  const steps = requests.filter((request) => request.purpose === 'reply');
  const statuses = statusesOf(journal);
  const stepRows = steps.map((request, index) => {
    const results = resultsOf(steps[index + 1]);
    const names = request.toolCalls.map((call) => String(call.name ?? ''));
    return {
      step: index + 1,
      chars: requestChars(request),
      tokens: estimate(request.messages),
      ms: request.ms,
      think: thinkOf(request.text),
      calls: request.toolCalls.map((call) => {
        const answer = call.id === undefined ? undefined : results.get(call.id);
        return {
          name: call.name ?? null,
          arguments: call.arguments ?? null,
          status: call.id === undefined ? null : (statuses.get(call.id) ?? null),
          resultChars: answer?.length ?? null,
        };
      }),
      together: together(names),
      error: request.error,
    };
  });
  const text = (content: unknown): string => {
    const given = (content as { text?: unknown } | null)?.text;
    return typeof given === 'string' ? given : '';
  };
  const messages = writes.filter((write) => write.op === 'send').map((write) => text(write.args[1]));
  const reactions = writes.filter((write) => write.op === 'react').map((write) => String(write.args[1]));
  const firstAt = steps[0]?.startedAt ?? null;
  const replyAt = writes.find((write) => write.op === 'send' || write.op === 'react')?.at ?? null;
  const last = steps.at(-1);
  return {
    turnId,
    sample,
    steps: stepRows,
    reply: { messages, reactions, skipped: result?.outcome === 'skip' },
    writes: writes.map((write) => ({ op: write.op, args: write.args })),
    keptCalls: [...keptCalls],
    totalMs: firstAt === null ? null : (replyAt ?? (last ? last.startedAt + (last.ms ?? 0) : firstAt)) - firstAt,
    stepCount: steps.length,
    callCount: steps.reduce((sum, request) => sum + request.toolCalls.length, 0),
    outcome: typeof result?.outcome === 'string' ? result.outcome : null,
    endedBecause: endOf(result, last),
    helperRequests: requests
      .filter((request) => request.purpose !== 'reply')
      .map((request) => ({ purpose: request.purpose, ms: request.ms })),
  };
}

/** Why the loop ended: an answer without a call, a refusal or an error, or the turn's own reason. */
function endOf(result: Rec | null, last: KeptRequest | undefined): string | null {
  if (typeof result?.reason === 'string' && result.reason) return result.reason;
  if (last?.error) return `error: ${last.error}`;
  if (last && last.toolCalls.length === 0) return 'an answer without a call';
  return typeof result?.outcome === 'string' ? result.outcome : null;
}

/** The short table of a report for stderr: names, counts, sizes and times. */
/** A number or a text as it is, anything else as `-`. */
const shown = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '-';

export function reportTable(report: TurnReport): string {
  const lines = [`turn ${report.turnId} sample ${report.sample}: ${report.outcome ?? 'no outcome'}`];
  for (const one of report.steps) {
    const calls = (one.calls as Array<{ name: unknown; status: unknown; resultChars: unknown }>)
      .map((call) => `${shown(call.name)}[${shown(call.status)}, ${shown(call.resultChars)} chars]`)
      .join(' ');
    lines.push(
      `  step ${String(one.step)}: ${String(one.chars)} chars, ~${String(one.tokens)} tokens, ${shown(one.ms)} ms${
        calls ? `, calls ${calls}${one.together ? ' (together)' : ''}` : ''
      }`
    );
  }
  const { reply } = report;
  lines.push(
    `  reply: ${reply.messages.length} messages, ${reply.reactions.length} reactions${
      reply.skipped ? ', skipped' : ''
    }; writes ${report.writes.length}; kept calls ${report.keptCalls.length}`,
    `  ${report.stepCount} steps, ${report.callCount} calls, ${report.totalMs ?? '-'} ms to the reply; ended: ${
      report.endedBecause ?? '-'
    }`
  );
  return lines.join('\n');
}
