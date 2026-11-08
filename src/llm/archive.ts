// Every model request of the engine goes through here on its way to the provider: the core wraps its chat client and the
// memory writer's client (src/core.ts). `archivedLlm` writes the whole request to the archive before it goes out and its
// outcome after, awaited at both ends, so a request the provider saw is on disk. A write that fails is logged and the
// call goes on: her voice does not depend on the archive. A picture is kept as its marker and size, the media
// tables hold what was preserved of it. Turn, attempt, step, service, run and backend come from `withRequestMeta`, which
// the turn opens; a call outside a turn names its service by its role. An answer's own `model`, `backend` and `source`
// correct the row at its end, since a subharness run is not what the client was asked for. A write that fails also goes
// to `noteGap`, with no content, so the watcher can name a request the archive lost.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { REPLY_REQUEST } from './openrouter.ts';
import { shapedThink } from './parse.ts';

type Row = Record<string, unknown>;
/** What a request led to: `confirmed` by a receipt, `failed`, or `unlinked` with no receipt to read. */
export type RequestOutcome = { kind: string; state: string; ref: string | null };
export type RequestMeta = {
  turnId?: string;
  attemptId?: string;
  step?: number;
  service?: string;
  runId?: string;
  backend?: string;
  /** Records the outcome on the newest request of this meta; set by the archive when it keeps one. */
  noteOutcome?: (outcome: RequestOutcome) => Promise<void>;
};
/** A request whose row the archive could not write, with no content. */
export type ArchiveWriteGap = { kind: 'archive-write-failed'; requestId: string; op: string; at: number };
type ArchiveDeps = {
  write: (update: Row) => Promise<unknown>;
  now?: () => number;
  newId?: () => string;
  log: { warn(msg: string, meta?: unknown): void };
  noteGap?: (gap: ArchiveWriteGap) => void;
  /** The backend a request goes through unless its answer says otherwise. */
  backend?: string;
};

const meta = new AsyncLocalStorage<RequestMeta>();

/** Runs `work` with a fresh record of its turn, attempt and step. */
export function withRequestMeta<TResult>(work: () => TResult): TResult {
  return meta.run({}, work);
}

export function currentRequestMeta(): RequestMeta | null {
  return meta.getStore() ?? null;
}

/** The role of the memory session (src/llm/roles.ts), the one call outside a turn that is no classifier's. */
const serviceOfRole = (role: unknown): string => (role === 'memory' ? 'memory' : 'classifiers');

/** The service a turn's requests belong to, by the turn's mode and, for an inner turn, its wake. */
export function turnService(mode: unknown, wakeKind: unknown): string {
  if (mode === 'selfreflection') return 'selfreflection';
  if (mode === 'inner' && (wakeKind === 'heartbeat' || wakeKind === 'selfimprovement')) return wakeKind;
  return 'core';
}

/** The outcome a turn's result proves for its last request: a skip, a delivery with its receipt, or a failure; else none. */
export function turnOutcome(
  result: { outcome: string; delivered?: boolean } | undefined,
  ref: string | null
): RequestOutcome | null {
  if (result === undefined) return null;
  if (result.outcome === 'skip') return { kind: 'skip', state: 'confirmed', ref: null };
  if (result.outcome === 'error') return { kind: 'delivery', state: 'failed', ref };
  if (result.outcome !== 'spoke' || result.delivered === undefined) return null;
  return { kind: 'delivery', state: result.delivered ? 'confirmed' : 'failed', ref };
}

function withoutPictureBytes(part: unknown): unknown {
  const value = part as { type?: unknown; image_url?: { url?: unknown }; messageId?: unknown } | null;
  if (value?.type !== 'image_url') return part;
  const url = typeof value.image_url?.url === 'string' ? value.image_url.url : '';
  const comma = url.startsWith('data:') ? url.indexOf(',') : -1;
  return {
    type: 'image_marker',
    messageId: value.messageId ?? null,
    bytes: comma >= 0 ? Math.floor(((url.length - comma - 1) * 3) / 4) : null,
    url: comma >= 0 ? null : url,
  };
}

function storedMessages(messages: unknown): Array<unknown> {
  return (Array.isArray(messages) ? messages : []).map((message: Row) =>
    Array.isArray(message?.content) ? { ...message, content: message.content.map(withoutPictureBytes) } : message
  );
}

function systemOf(messages: unknown): string | null {
  const first = (Array.isArray(messages) ? messages : []).find((message: Row) => message?.role === 'system') as
    Row | undefined;
  if (typeof first?.content === 'string') return first.content;
  return first === undefined ? null : JSON.stringify(first.content);
}

/**
 * The think of an answer. `response_text` keeps the answer as it came and is never rewritten, so a reply request's answer with
 * text and no `<think>` shows the one shape of a stored reply here, an empty think. An analyzer's answer has none.
 */
function thinkOf(text: unknown, purpose: unknown): string | null {
  if (typeof text !== 'string') return null;
  const match = /<think>([\s\S]*?)<\/think>/.exec(purpose === REPLY_REQUEST.purpose ? shapedThink(text) : text);
  return match?.[1] ?? null;
}

/** The row of a request as it goes out. */
function startRecord(
  id: string,
  at: number,
  messages: unknown,
  options: Row,
  turn: RequestMeta | null,
  backend?: string,
  blocks?: unknown
): Row {
  return {
    id,
    at,
    turn_id: turn?.turnId ?? null,
    attempt_id: turn?.attemptId ?? null,
    step: turn?.step === undefined ? 0 : turn.step - 1,
    role: options.role ?? null,
    model: options.model ?? null,
    purpose: options.purpose ?? null,
    system_text: systemOf(messages),
    messages: JSON.stringify(storedMessages(messages)),
    tools: options.tools === undefined ? null : JSON.stringify(options.tools),
    tool_choice: typeof options.toolChoice === 'string' ? options.toolChoice : null,
    source: 'live',
    service: turn?.service ?? serviceOfRole(options.role),
    backend: turn?.backend ?? backend ?? null,
    run_id: turn?.runId ?? null,
    blocks: blocks === undefined ? null : JSON.stringify(blocks),
  };
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The fields of a row an answer closes it with. */
const answerFields = (answer: Row | null | undefined, purpose: unknown): Row => ({
  model: textOrNull(answer?.model),
  backend: textOrNull(answer?.backend),
  source: textOrNull(answer?.source),
  response_text: textOrNull(answer?.text),
  think: thinkOf(answer?.text, purpose),
  tool_calls: answer?.toolCalls === undefined ? null : JSON.stringify(answer.toolCalls),
  usage: answer?.usage === undefined ? null : JSON.stringify(answer.usage),
});

/**
 * The `error_code` of a failed request. A string code wins, so `keys-exhausted` stays, then the provider's status as
 * `http_<status>`, then `timeout`, `aborted` and `network` by the error's name and shape, else `error`.
 */
function failureCause(error: unknown): string {
  const { code, statusCode, name, message } = (error ?? {}) as Row;
  if (typeof code === 'string') return code;
  if (Number.isInteger(statusCode)) return `http_${String(statusCode)}`;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';
  if (error instanceof TypeError && /fetch failed|network/i.test(String(message))) return 'network';
  return 'error';
}

/** The provider's words of a refused request (src/llm/provider-error.ts), already bounded by the client; else null. */
function failureText(error: unknown): string | null {
  const words = (error ?? {}) as Row;
  return typeof words.providerError === 'string' ? words.providerError : null;
}

/** `llm` whose `complete` keeps each request and its outcome. Every other member passes through. */
export function archivedLlm<TLlm extends { complete: (...args: Array<never>) => Promise<unknown> }>(
  llm: TLlm,
  { write, now = () => Date.now(), newId = () => randomUUID(), log, noteGap, backend }: ArchiveDeps
): TLlm {
  const keep = async (id: string, update: Row): Promise<void> => {
    try {
      await write({ kind: 'request-archive', ...update });
    } catch (error) {
      log.warn('llm: the request archive could not be written', { op: update.op, error });
      noteGap?.({ kind: 'archive-write-failed', requestId: id, op: String(update.op), at: now() });
    }
  };
  const complete = async (messages: unknown, given: Row = {}, ...rest: Array<unknown>): Promise<unknown> => {
    // A caller that links the outcome itself names the row, and a request built from blocks lists them for the row. The
    // client below sees neither option.
    const { archiveId, blocks, ...options } = given;
    const id = typeof archiveId === 'string' ? archiveId : newId();
    const turn = currentRequestMeta();
    if (turn !== null) {
      turn.step = (turn.step ?? 0) + 1;
      turn.noteOutcome = (outcome) => keep(id, { op: 'outcome', id, outcome });
    }
    await keep(id, { op: 'start', record: startRecord(id, now(), messages, options, turn, backend, blocks) });
    try {
      const answer = await (llm.complete as unknown as (...args: Array<unknown>) => Promise<Row>)(
        messages,
        options,
        ...rest
      );
      await keep(id, { op: 'finish', id, at: now(), status: 'ok', ...answerFields(answer, options.purpose) });
      return answer;
    } catch (error) {
      const failure = { error_code: failureCause(error), error_text: failureText(error) };
      await keep(id, { op: 'finish', id, at: now(), status: 'failed', ...failure });
      throw error;
    }
  };
  return Object.assign(Object.create(Object.getPrototypeOf(llm) as object) as TLlm, llm, { complete });
}
