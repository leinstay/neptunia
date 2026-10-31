// What a turn writes to the journal (src/memory/journal.js) and how it reads its own sends back: the skip codes, the
// operation that writes nothing, how a port result closes an operation, the parser's diagnostics, the send hash and
// the settling of unknown sends, the start and the closing record of a turn, and the usage and format counts of an
// answer. src/behavior/turn.js calls them around every effect; the tests read the exported ones through its re-exports.

import { createHash } from 'node:crypto';

import { log } from '../log.js';
import { CODE } from '../tools/codes.ts';
import { isFiniteNumber, isObj } from '../tools/types.ts';
import { DAY_MS } from '../time.js';
import type { TriggerKind } from './triggers.ts';

/**
 * The `reason` codes of a `skip` outcome, journaled with the turn: she chose not to speak (an
 * explicit skip, or an answer with nothing to act on), or an inner turn (mode `inner`,
 * src/behavior/inner.ts) ended with no action of hers -- silence is a valid answer there.
 */
export const SKIP_SILENCE = 'silence';
export const SKIP_NOTHING_TO_DO = 'nothing-to-do';

/** The mode a journal's `turn.start` names: a follow-up or an overheard line by its kind, else the turn's mode. */
function journalMode(mode: string | null | undefined, triggerKind: TriggerKind | null | undefined): string | null {
  return triggerKind === 'followUp' || triggerKind === 'overheard' ? triggerKind : (mode ?? null);
}

/** One journal operation of an attempt (src/memory/journal.js#createJournal's `op`). */
export type JournalOp = {
  opId: string | null;
  proposed: (...args: Array<unknown>) => Promise<void> | void;
  started: (...args: Array<unknown>) => Promise<void> | void;
  succeeded: (...args: Array<unknown>) => Promise<void> | void;
  failed: (...args: Array<unknown>) => Promise<void> | void;
  unknown: (...args: Array<unknown>) => Promise<void> | void;
};

/** A journal operation that writes nothing: an attempt the journal does not follow. */
export const NO_OP: Readonly<JournalOp> = Object.freeze({
  opId: null,
  proposed: async () => {},
  started: async () => {},
  succeeded: async () => {},
  failed: async () => {},
  unknown: async () => {},
});

/** An interface port result (src/interface/port.js), as far as the turn reads it. */
export type PortResult =
  | {
      status?: string;
      error?: { code?: string; cause?: unknown } | null;
      ref?: { messageId?: string | null } | null;
      at?: unknown;
    }
  | null
  | undefined;

/**
 * How an interface port result that is not `ok` (src/interface/port.js) closes its journal
 * operation: `unknown` (a network error, a timeout, a 5xx: it may have taken effect anyway) is
 * `unknown` -- the restart's reconciliation looks for a post; nothing is ever sent again --, any
 * other status is `failed` with the port's code (`http-<status>` for a platform's refusals).
 */
export function closeResult(op: Pick<JournalOp, 'unknown' | 'failed'>, result: PortResult): Promise<void> | void {
  if (result?.status === 'unknown') return op.unknown();
  return op.failed(result?.error?.code ?? result?.status ?? CODE.ERROR);
}

/** A parser's note on an answer (src/llm/parse.js `diagnostics`). */
type Diagnostic = Record<string, unknown> & { kind?: unknown };

/** The part of a draft that keeps the parser's notes until a request carried them. */
type DiagnosticsDraft = { diagnostics?: Array<Diagnostic & { told?: boolean }> };

/**
 * What the parser left unsaid about an answer (src/llm/parse.js `diagnostics`), kept in the draft
 * until a request that carried it completed (`told`) or the turn ended and it became a fact. An
 * unclosed `<think>` counts only when the answer stopped on its own (`stop`): a cut-off one is the
 * cut-off's own business.
 */
export function noteDiagnostics(
  draft: DiagnosticsDraft | null | undefined,
  parsed: { diagnostics?: unknown } | null | undefined,
  completion: { finishReason?: string | null } | null | undefined
): void {
  if (!draft || !Array.isArray(parsed?.diagnostics)) return;
  // The parser's diagnostics are records (src/llm/parse.js), each with its `kind`.
  for (const diagnostic of parsed.diagnostics as Array<Diagnostic>) {
    if (diagnostic.kind === 'thinkUnclosed' && completion?.finishReason === 'length') continue;
    (draft.diagnostics ??= []).push({ ...diagnostic, told: false });
  }
}

/** The diagnostics of `draft` not told yet, without the bookkeeping. */
export function untoldDiagnostics(draft: DiagnosticsDraft | null | undefined): Array<Diagnostic> {
  // `told` is the bookkeeping the copy leaves out.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (draft?.diagnostics ?? []).filter((diagnostic) => diagnostic.told !== true).map(({ told, ...rest }) => rest);
}

/** How many characters of a message's text its send hash covers (what survives a trailing link or a cut). */
const SEND_HASH_CHARS = 80;

/**
 * The hash of a message's text as a send whose answer never came records it, and as her own lines of
 * the channel are checked against it later: the first SEND_HASH_CHARS characters with whitespace folded.
 */
export function sendHash(text: string | number | null | undefined): string {
  const folded = Array.from(
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  )
    .slice(0, SEND_HASH_CHARS)
    .join('');
  return createHash('sha1').update(folded).digest('hex').slice(0, 16);
}

/** A fact a turn keeps for her next request, as far as settleUnknownSends reads it. */
type PendingFact = Record<string, unknown> & { kind?: unknown; unknown?: unknown; hash?: unknown; at?: unknown };

/**
 * The facts of `pending` with the sends whose answer never came (`sendFailed` with `unknown`) settled
 * against `history` (the channel's lines as the turn fetched them): a message of hers with that hash
 * after the send is there, so the fact is dropped and `dropped` names it; any other stays, to be
 * told as it is. Pure.
 */
export function settleUnknownSends<TFact extends PendingFact>(
  pending: Iterable<TFact>,
  history: ReadonlyArray<{ self?: unknown; content?: unknown; ts?: unknown } | null | undefined> | null | undefined
): { kept: Array<TFact>; dropped: Array<TFact> } {
  const lines: ReadonlyArray<unknown> = Array.isArray(history) ? history : [];
  const own = lines.filter((line): line is { self: true; content: string; ts?: unknown } =>
    isObj(line) ? line.self === true && typeof line.content === 'string' : false
  );
  const kept: Array<TFact> = [];
  const dropped: Array<TFact> = [];
  for (const fact of pending) {
    const found =
      fact.kind === 'sendFailed' &&
      fact.unknown === true &&
      typeof fact.hash === 'string' &&
      own.some(
        (line) =>
          sendHash(line.content) === fact.hash &&
          (!isFiniteNumber(line.ts) || !isFiniteNumber(fact.at) || line.ts >= fact.at - 60_000)
      );
    (found ? dropped : kept).push(fact);
  }
  return { kept, dropped };
}

/** What the logs show of a port result's error: the platform's own error when the adapter kept it. */
export function portError(result: PortResult): unknown {
  return result?.error?.cause ?? result?.error ?? null;
}

/** A sent message as the turn notes it, from an `ok` port result: its id (null when unknown) and stamp. */
export function postedOf(result: PortResult): { id: string | null; createdTimestamp?: number } {
  return {
    id: result?.ref?.messageId ?? null,
    ...(isFiniteNumber(result?.at) ? { createdTimestamp: result.at } : {}),
  };
}

/**
 * The journal's closing record of a successful persona skill call: counts only, never content.
 * `messageId` of the message it posted (result.ref); `chars` the length of the answer the persona
 * reads (the text, or the serialized rows of a list; absent when empty); `items` the row count of
 * a list. `{}` when the call returned nothing.
 */
export function journalResultOf(
  result:
    | { ref?: { messageId?: string } | null; data?: { text?: string | number | null; rows?: unknown } | null }
    | null
    | undefined
): { messageId?: string; chars?: number; items?: number } {
  const out: { messageId?: string; chars?: number; items?: number } = {};
  if (result?.ref?.messageId) out.messageId = result.ref.messageId;
  const data = result?.data;
  if (data) {
    const rows: ReadonlyArray<unknown> | null = Array.isArray(data.rows) ? data.rows : null;
    const chars = rows ? JSON.stringify(rows).length : String(data.text ?? '').length;
    if (chars > 0) out.chars = chars;
    if (rows) out.items = rows.length;
  }
  return out;
}

/** The fields the journal's turn record starts with (src/memory/journal.js#start): who and what the turn is for. */
export function journalStartOf({
  draft,
  channel,
  trigger,
  triggerKind,
  mode,
  journalTurn,
}: {
  draft: { inner?: { wake?: { kind?: string | null } | null } | null; privateUserId?: string | null };
  channel: { id: string };
  trigger: { id?: string | null; authorId?: string | null } | null | undefined;
  triggerKind: TriggerKind | null | undefined;
  mode: string | null | undefined;
  journalTurn: { turnId?: string | null; attemptId?: string | null } | null | undefined;
}): {
  channelId: string;
  mode: string | null;
  trigger: {
    kind: string | null;
    messageId: string | null;
    authorId: string | null;
    wake?: string | null;
  } | null;
  participants: Array<string>;
  sourceMessageIds: Array<string>;
  privateUserId: string | null | undefined;
  turnId: string | null;
  attemptId: string | null;
} {
  const woke = draft.inner
    ? { kind: 'inner', messageId: null, authorId: null, wake: draft.inner.wake?.kind ?? null }
    : null;
  return {
    channelId: channel.id,
    mode: journalMode(mode, triggerKind),
    trigger: trigger
      ? { kind: triggerKind ?? null, messageId: trigger.id ?? null, authorId: trigger.authorId ?? null }
      : woke,
    participants: trigger?.authorId ? [trigger.authorId] : [],
    sourceMessageIds: trigger?.id ? [trigger.id] : [],
    privateUserId: draft.privateUserId,
    turnId: journalTurn?.turnId ?? null,
    attemptId: journalTurn?.attemptId ?? null,
  };
}

/** A preparation step's journal operation (src/behavior/turn-parts.ts#createPrepLedger). */
type PrepOp = {
  started: () => Promise<void> | void;
  succeeded: (result: object, offered?: unknown) => unknown;
  failed: (code: string) => unknown;
};

/**
 * `work()` with its preparation step `op` (createPrepLedger's, or null: no journal) around it:
 * `started` before, then `toResult(value)` -- `{ result, offered? }`, or `{ failed: code }` --
 * closes it; a throw is `failed` with `error` and rethrown.
 */
export async function journalled<TValue>(
  op: PrepOp | null | undefined,
  work: () => TValue | Promise<TValue>,
  toResult: (value: TValue) => { result?: object; offered?: unknown; failed?: unknown } | null | undefined
): Promise<TValue> {
  if (!op) return work();
  await op.started();
  let value: TValue;
  try {
    value = await work();
  } catch (err) {
    op.failed(CODE.ERROR);
    throw err;
  }
  const closing = toResult(value) ?? {};
  if (typeof closing.failed === 'string') op.failed(closing.failed);
  else op.succeeded(closing.result ?? {}, closing.offered);
  return value;
}

/** The budget sections of a request's stats line that lost items: `{ section: dropped }`. */
export function droppedSections(stats: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, entry] of Object.entries(stats ?? {})) {
    if (isObj(entry) && isFiniteNumber(entry.dropped) && entry.dropped > 0) out[name] = entry.dropped;
  }
  return out;
}

/** A model's completion, as far as the journal reads it. */
type Completion =
  | {
      finishReason?: string | null;
      promptTokens?: unknown;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null;
      } | null;
    }
  | null
  | undefined;

export type JournalUsage = {
  prompt: number | null;
  cached: number | null;
  cacheWrite: number | null;
  completion: number | null;
};

/**
 * The journal's usage of the reply request (the turn record and the request dump): the whole
 * prompt, its part read from the cache (`cached`), its part written to the cache (`cacheWrite`,
 * OpenRouter's `prompt_tokens_details.cache_write_tokens`, as on the `llm: usage` line), the
 * completion; each null when unreported.
 */
export function journalUsage(completion: Completion): JournalUsage {
  const usage = completion?.usage ?? {};
  const count = (value: unknown): number | null => (isFiniteNumber(value) ? value : null);
  return {
    prompt: count(completion?.promptTokens) ?? count(usage.prompt_tokens),
    cached: count(usage.prompt_tokens_details?.cached_tokens),
    cacheWrite: count(usage.prompt_tokens_details?.cache_write_tokens),
    completion: count(usage.completion_tokens),
  };
}

/**
 * Whether a voice completion (`completion`, parsed and shaped as `parsed`) was cut off at its
 * output cap (finish reason `length`): null when it stopped on its own. A cut-off one logs `turn:
 * cut off` with the completion tokens, whether it came from the skill follow-up and whether
 * complete actions are kept (`kept`). Nothing is kept when the think never closed, the answer
 * left nothing to do (`empty`), or its one message is the untagged fallback text -- a fragment:
 * the caller then ends the turn `error` with reason `cut-off`, never a skip, and posts nothing.
 */
export function cutOffOf(
  completion: Completion,
  parsed: { thinkOpen?: unknown; untagged?: unknown },
  { channelId, empty, followUp }: { channelId: string; empty: boolean; followUp: boolean }
): { kept: boolean } | null {
  if (completion?.finishReason !== 'length') return null;
  const kept = !parsed.thinkOpen && !parsed.untagged && !empty;
  log.warn('turn: cut off', {
    channel: channelId,
    completionTokens: journalUsage(completion).completion,
    kept,
    followUp,
  });
  return { kept };
}

/** The format counts of a turn, as the step engine notes them. */
type FormatCounts = Record<'thinkMissing' | 'coerced' | 'malformed' | 'truncated' | 'capped' | 'held', number>;

/** The format counts of a turn record: `thinkMissing`, `coerced`, `malformed`, `truncated`, `capped`, `held`, each a number (0 when unset). */
function formatCountsOf(format: Partial<Record<keyof FormatCounts, unknown>>): FormatCounts {
  const count = (value: unknown): number => (isFiniteNumber(value) && value > 0 ? Math.floor(value) : 0);
  return {
    thinkMissing: count(format.thinkMissing),
    coerced: count(format.coerced),
    malformed: count(format.malformed),
    truncated: count(format.truncated),
    capped: count(format.capped),
    held: count(format.held),
  };
}

/** What a turn attempt notes in its draft for the journal's `turn` record. */
export type JournalDraft = {
  started: { turnId: string; attemptId: string; startedAt: number };
  seen?: { messageIds: Array<string>; parents: Array<unknown>; parts: { filePreviews: Array<unknown> } } | null;
  channelId?: string;
  privateUserId?: string | null;
  mode?: string | null;
  reason?: string | null;
  participants?: Array<string> | null;
  think?: unknown;
  posted?: Array<unknown> | null;
  reactions?: Array<unknown> | null;
  actions?: Array<unknown> | null;
  usage?: JournalUsage | null;
  dropped?: Record<string, number> | null;
  limits?: { list?: () => Array<unknown> } | null;
  skillsProposed?: unknown;
  format?: unknown;
  steps?: unknown;
};

/**
 * One attempt's `turn` record (src/memory/journal.js) from what the attempt noted in its
 * draft and the result it returned: `reason` is the attempt's skip code (`silence`, `nothing-to-do`:
 * SKIP_SILENCE, SKIP_NOTHING_TO_DO) or refusal code, else null (old skip records carry null too).
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5a, a pure move
export function journalTurnRecord(
  draft: JournalDraft,
  result: { mode?: string | null; outcome?: string | null; reason?: unknown } | null | undefined
): Record<string, unknown> {
  const seen = draft.seen ?? { messageIds: [], parents: [], parts: { filePreviews: [] } };
  return {
    turnId: draft.started.turnId,
    attemptId: draft.started.attemptId,
    startedAt: draft.started.startedAt,
    channelId: draft.channelId,
    privateUserId: draft.privateUserId,
    mode: result?.mode ?? draft.mode ?? null,
    outcome: result?.outcome ?? 'error',
    reason: typeof result?.reason === 'string' ? result.reason : (draft.reason ?? null),
    seen,
    participants: draft.participants ?? [],
    sourceMessageIds: seen.messageIds,
    think: typeof draft.think === 'string' ? draft.think : null,
    posted: draft.posted ?? [],
    reactions: draft.reactions ?? [],
    actions: draft.actions ?? [],
    usage: draft.usage ?? null,
    budget: { dropped: draft.dropped ?? {} },
    limits: typeof draft.limits?.list === 'function' ? draft.limits.list() : [],
    // The skills a classifier named for this turn, each with the gateway's verdict (shadow, phase 0).
    ...(Array.isArray(draft.skillsProposed) && draft.skillsProposed.length > 0
      ? { skillsProposed: draft.skillsProposed }
      : {}),
    // The native-tools step engine's counts and step number; absent while no turn noted them.
    ...(draft.format && typeof draft.format === 'object' ? { format: formatCountsOf(draft.format) } : {}),
    ...(draft.steps !== undefined && draft.steps !== null ? { steps: draft.steps } : {}),
  };
}

/** How long a failed addressed turn is kept for her next request in the channel. */
export const FAILED_TURN_KEEP_MS = DAY_MS;

/** The distinct hosts of `links` (`{ url }` items), in order; a URL that does not parse is left out. */
export function linkHosts(links: Iterable<{ url?: string } | null | undefined> | null | undefined): Array<string> {
  const hosts: Array<string> = [];
  for (const link of links ?? []) {
    let host = null;
    try {
      host = new URL(String(link?.url)).hostname;
    } catch {
      host = null;
    }
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}
