// Missed answers: a second line behind the address gate, so a message owed an answer from the
// persona is not lost without a trace. Facts that a message may have been left unanswered -- the
// address classifier failed on it (`gate-failed`) or failed and let it through anyway
// (`gate-failopen`), a deferred follow-up was replaced by a newer one (`replaced-deferred`), a
// turn answering it ended in an error (`turn-error`) or was dropped at its bar (`turn-dropped`)
// or found nothing to do (`not-now`), a call that left the pending queue unanswered because the queue
// was full, the call waited too long or a stronger line took its place (`pending-full`,
// `pending-expired`, `pending-outranked`, src/behavior/pipeline.ts) -- become candidates in a small registry, persisted in
// the database unit `places/<id>/missed.json` through the memory writer and written to
// the journal as `answer` records. A `<skip/>` and a refusal are the persona's decisions and
// never candidates; neither is an overheard line or a routed call. A private chat's are: its
// records go to that person's private journal and its recovery turn runs in that chat, after the
// private-chat gate (`setPrivateRecovery`).
//
// A candidate resolves itself when a later turn of the persona in its channel was started by it
// or replied to it, or spoke for a message of the same author posted after it. What is left is
// looked at once per channel, `missed.sweepDelaySeconds` after the last candidate there, pushed
// back by every new message in the channel but never past `missed.sweepMaxDelaySeconds`: code
// first (resolved by the channel's history, expired after `missed.expireMinutes`, or
// `missed.questionExpireMinutes` for a message carrying a question mark), then one analyzer call
// for the channel (`prompts/missed.md`, role `analyzer`, purpose `missed`) answering one verdict
// per candidate: owed, resolved, intentional-skip, stale or uncertain; a failed call is
// `unchecked`, never owed. With `features.missedRecovery` exactly true the owed ones of a channel
// get one ordinary reply turn together (trigger kind `missed`, the earliest as its trigger, all
// named under `labels.task.missed`), one attempt per candidate, at most one such turn per channel
// every `missed.channelCooldownMinutes`, never while paused, and the turn posts
// nothing when the persona spoke in that channel since it started (`stillDue`). Off (the
// default), the sweep only classifies and journals: shadow mode. `features.missedAnswers` (a
// missing key counts as on) switches the whole registry off.
//
// At start the registry is loaded and reconciled with the journal of the last hour (facts,
// verdicts and the turns that ended since). Closed candidates and those older than a day go.
// Logs carry ids and counts, never message contents.

import path from 'node:path';
import * as nodeFs from 'node:fs/promises';
import type { StorageKey } from '../memory/db/storage-keys.ts';
import { PERSONA_ID, placeOrPersona } from '../memory/db/storage-keys.ts';
import { placeOfChat, sharedPlaceOf } from '../memory/addresses.ts';

import { createReadSeam, unitValue } from '../memory/db/readers/common.ts';
import { formatTranscript, MAX_MESSAGE_CHARS, renderTranscript, withTriggers } from '../format.ts';
import { roleRequestOptions } from '../llm/openrouter.ts';
import { strictJsonObject } from '../llm/parse.ts';
import { roleModel } from '../llm/roles.ts';
import { clampChars, oneLine } from '../memory/clamp.ts';
import { fillPromptTemplate } from './prompt.ts';
import { historyLines } from './lines.ts';
import { log as defaultLog } from '../log.ts';
import { CODE } from '../tools/codes.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../time.ts';
import { objOf } from '../tools/types.ts';
import type { TurnEnd } from '../turn/outcome.ts';
import type { ChatInfo } from '../protocol/adapter.ts';
import type { Untyped } from '../tools/types.ts';
import type {
  AddCandidateArg2,
  ResolveByTurnArg2,
  SweepPlanResult,
  MissedCountsResult,
  BuildCheckRequestInput,
  CreateMissedInput,
  CreateMissedResult,
  NoteFactInput,
  ClassifyContext,
  Candidate,
  MissedLine,
} from './missed-types.ts';

/** Why a message became a candidate. */
export const MISSED_REASONS = Object.freeze([
  'gate-failed',
  'gate-failopen',
  'replaced-deferred',
  'turn-error',
  'turn-dropped',
  'not-now',
  CODE.PENDING_FULL,
  CODE.PENDING_EXPIRED,
  CODE.PENDING_OUTRANKED,
]);

/** The analyzer's verdicts, then the one code gives a check that did not complete. */
export const MISSED_VERDICTS = Object.freeze(['owed', 'resolved', 'intentional-skip', 'stale', 'uncertain']);
export const UNCHECKED = 'unchecked';

/** The trigger kinds whose failed turn leaves somebody waiting (an overheard line does not). */
const OWED_TRIGGER_KINDS = new Set<string | null>(['mention', 'reply', 'followUp', 'errand', 'private']);

/** The states in which a candidate may still change. */
const OPEN_STATES = new Set(['pending', 'in_progress']);

/**
 * The recovery's measures: production values of the config cut of 2026-10-31, and the fallbacks of the two keys
 * `missed.expireMinutes` and `missed.maxOutputTokens`.
 */
const MISSED_FALLBACK = Object.freeze({
  sweepDelaySeconds: 90,
  sweepMaxDelaySeconds: 240,
  expireMinutes: 5,
  questionExpireMinutes: 15,
  channelCooldownMinutes: 5,
  contextMessages: 20,
  maxOutputTokens: 2000,
});

/** How long a candidate is kept at all (closed or not). */
const KEEP_MS = DAY_MS;
/** The most candidates the registry holds; the oldest closed ones go first. */
export const MAX_CANDIDATES = 500;
/** How far back the start reads the journal. */
const RECONCILE_WINDOW_MS = HOUR_MS;
/** How many lines before the earliest candidate the analyzer's transcript keeps. */
const LINES_BEFORE = 5;
/** The registry file's schema version. */
const FILE_VERSION = 1;
/** A question mark, ASCII or full-width. */
const QUESTION_RE = /[?\uFF1F]/;

/** The keys of `missed` the live config holds. */
const MISSED_KEYS = Object.freeze(['expireMinutes', 'maxOutputTokens'] as const);

/**
 * The recovery's settings: MISSED_FALLBACK, with `missed.expireMinutes` and `missed.maxOutputTokens` of the live
 * config each a finite number >= 0 or config.json's value.
 * @param config  The whole live config.
 */
export function missedSettings(
  config: Record<string, Untyped> | undefined
): Record<keyof typeof MISSED_FALLBACK, number> {
  const group = config?.missed ?? {};
  const out: Record<keyof typeof MISSED_FALLBACK, number> = { ...MISSED_FALLBACK };
  for (const key of MISSED_KEYS) {
    const value = group[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/**
 * Whether a message's text counts as a direct question for the longer expiry: it carries a
 * question mark (ASCII or full-width). The address classifier answers yes/overheard/no, not
 * whether a line asks something, so this simple rule stands in.
 */
export function isQuestion(text: unknown): boolean {
  return typeof text === 'string' && QUESTION_RE.test(text);
}

/** Whether a candidate may still change. */
export function isOpen(candidate: Candidate): boolean {
  return OPEN_STATES.has(candidate?.state);
}

/**
 * `list` with the candidate of `fact` added (`pending`, no attempt, no verdict), or -- one
 * candidate per message -- an open one of the same message updated (its latest `reason`, the
 * turn id joined to `turnIds`). A closed one is left alone. Pure; nothing is mutated.
 */
export function addCandidate(
  list: Array<Candidate>,
  fact: AddCandidateArg2,
  { now = fact?.at }: { now?: number } = {}
): { list: Array<Candidate>; added: boolean; candidate: Candidate | null } {
  if (!fact?.messageId || !fact.placeId || !MISSED_REASONS.includes(fact.reason))
    return { list, added: false, candidate: null };
  const turnIds = typeof fact.turnId === 'string' && fact.turnId ? [fact.turnId] : [];
  const existing = list.find((candidate) => candidate.messageId === fact.messageId);
  if (existing) {
    if (!isOpen(existing)) return { list, added: false, candidate: existing };
    const updated = {
      ...existing,
      reason: fact.reason,
      turnIds: [...new Set([...existing.turnIds, ...turnIds])],
      question: existing.question || fact.question === true,
      updatedAt: now,
    };
    return {
      list: list.map((candidate) => (candidate === existing ? updated : candidate)),
      added: false,
      candidate: updated,
    };
  }
  const candidate = {
    messageId: fact.messageId,
    placeId: fact.placeId,
    ...(fact.iface ? { iface: fact.iface } : {}),
    authorId: fact.authorId ?? null,
    at: fact.at,
    reason: fact.reason,
    question: fact.question === true,
    turnIds,
    state: 'pending',
    attempts: 0,
    verdict: null,
    checkedAt: null,
    updatedAt: now,
  };
  return { list: [...list, candidate], added: true, candidate };
}

/**
 * Which open candidates of `turn`'s channel a turn that ended resolves, and `list` with them
 * `resolved`. Only a turn that reached a decision counts (`spoke` or `skip`): a candidate is
 * resolved `by: 'trigger'` when the turn was started by it, `by: 'reply'` when one of its posts
 * replied to it, and -- a turn that spoke -- `by: 'author'` when its trigger is a message of the
 * candidate's author posted after the candidate. Pure.
 */
export function resolveByTurn(
  list: Array<Candidate>,
  turn: ResolveByTurnArg2
): { list: Array<Candidate>; resolved: Array<{ messageId: string; placeId: string; by: string }> } {
  if (!turn || (turn.outcome !== 'spoke' && turn.outcome !== 'skip') || !turn.placeId) return { list, resolved: [] };
  const targets = new Set(Array.isArray(turn.replyTargets) ? turn.replyTargets : []);
  const resolved: Array<Untyped> = [];
  const next = list.map((candidate) => {
    if (!isOpen(candidate) || candidate.placeId !== turn.placeId) return candidate;
    let by = null;
    if (turn.triggerId && turn.triggerId === candidate.messageId) by = 'trigger';
    else if (targets.has(candidate.messageId)) by = 'reply';
    else if (
      turn.outcome === 'spoke' &&
      turn.triggerAuthorId &&
      turn.triggerAuthorId === candidate.authorId &&
      typeof turn.triggerAt === 'number' &&
      Number.isFinite(turn.triggerAt) &&
      turn.triggerAt > candidate.at
    ) {
      by = 'author';
    }
    if (!by) return candidate;
    resolved.push({ messageId: candidate.messageId, placeId: candidate.placeId, by });
    const turnIds =
      typeof turn.turnId === 'string' && turn.turnId
        ? [...new Set([...candidate.turnIds, turn.turnId])]
        : candidate.turnIds;
    return { ...candidate, state: 'resolved', turnIds, updatedAt: turn.at };
  });
  return { list: resolved.length > 0 ? next : list, resolved };
}

/**
 * Whether the channel's `history` (normalized messages, oldest first) shows the persona
 * answered `candidate` after it: a line of hers replies to it (`reply`), names it as the
 * message that started its turn (`trigger`, through `triggerOf`), or names a message of the
 * candidate's author posted after it (`author`). Null otherwise. Pure.
 */
export function resolvedInHistory(
  candidate: Candidate,
  history: Array<MissedLine>,
  triggerOf: ((postedId: string) => string | null) | null | undefined
): 'trigger' | 'reply' | 'author' | null {
  const list = Array.isArray(history) ? history : [];
  const byId = new Map(list.map((message) => [message?.id, message]));
  for (const message of list) {
    if (!message?.self || !(message.ts > candidate.at)) continue;
    if (message.replyToId === candidate.messageId) return 'reply';
    const triggerId = typeof triggerOf === 'function' ? triggerOf(message.id) : null;
    if (!triggerId) continue;
    if (triggerId === candidate.messageId) return 'trigger';
    const trigger = byId.get(triggerId);
    if (trigger && trigger.authorId === candidate.authorId && trigger.ts > candidate.at) return 'author';
  }
  return null;
}

/**
 * How long a candidate stays worth an answer: `missed.questionExpireMinutes` for a direct
 * question (isQuestion at the time of the fact), else `missed.expireMinutes`.
 * @returns milliseconds
 */
export function expiryMs(
  candidate: { question?: boolean },
  settings: { expireMinutes: number; questionExpireMinutes: number }
): number {
  return (candidate?.question ? settings.questionExpireMinutes : settings.expireMinutes) * MINUTE_MS;
}

/**
 * The code's part of a channel's sweep, before any analyzer call: of the channel's `pending`
 * candidates, which are `expired` (older than expiryMs at `now`), which the channel's `history`
 * shows answered (`resolved`, resolvedInHistory), which it does not show at all (`notShown`: the
 * talk moved past the window fetched), which carry an `owed` verdict already (`owed`: a recovery
 * held back by its cooldown or a busy attention, never asked about twice) and which go to the
 * analyzer (`check`). Pure.
 */
export function sweepPlan(
  list: Array<Candidate>,
  placeId: string,
  {
    now,
    settings,
    history,
    triggerOf,
  }: { now: number; settings: Untyped; history: Array<Untyped>; triggerOf?: ((id: string) => string | null) | null }
): SweepPlanResult {
  const out: {
    expired: Array<Untyped>;
    resolved: Array<{ candidate: Candidate; by: string }>;
    notShown: Array<Untyped>;
    owed: Array<Untyped>;
    check: Array<Untyped>;
  } = { expired: [], resolved: [], notShown: [], owed: [], check: [] };
  const shown = new Set((Array.isArray(history) ? history : []).map((message) => message?.id));
  for (const candidate of list) {
    if (candidate.placeId !== placeId || candidate.state !== 'pending') continue;
    if (now - candidate.at > expiryMs(candidate, settings)) {
      out.expired.push(candidate);
      continue;
    }
    const by = resolvedInHistory(candidate, history, triggerOf);
    if (by) out.resolved.push({ candidate, by: `history-${by}` });
    else if (!shown.has(candidate.messageId)) out.notShown.push(candidate);
    else if (candidate.verdict === 'owed') out.owed.push(candidate);
    else out.check.push(candidate);
  }
  return out;
}

/**
 * The schema of the missed-answer check's answer, handed to the client as `responseFormat`:
 * `{ "verdicts": [{ "n": <candidate number>, "verdict": <one of MISSED_VERDICTS> }] }`.
 */
export const MISSED_FORMAT = {
  name: 'missed',
  schema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: { n: { type: 'integer' }, verdict: { type: 'string', enum: [...MISSED_VERDICTS] } },
          required: ['n', 'verdict'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdicts'],
    additionalProperties: false,
  },
};

/**
 * The analyzer's answer (prompts/missed.md) for `count` candidates: the JSON object of
 * MISSED_FORMAT, one entry per candidate. An entry whose `n` is not a whole number 1..`count` or
 * whose `verdict` is not one of MISSED_VERDICTS is skipped, the others kept. A candidate no entry
 * names, or named twice with different verdicts, is `uncertain`; text that is not the object, or
 * whose `verdicts` is not a list, leaves every one `uncertain`; an empty answer leaves every one
 * `unchecked` (`empty`). Pure.
 */
export function parseMissedAnswer(text: unknown, count: number): { verdicts: Array<string>; empty: boolean } {
  if (typeof text !== 'string' || !text.trim()) {
    return { verdicts: Array.from({ length: count }, () => UNCHECKED), empty: true };
  }
  const list = strictJsonObject(text)?.verdicts;
  const found = new Map();
  const conflicted = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const { n: index, verdict } = (entry && typeof entry === 'object' ? entry : {}) as {
      n?: unknown;
      verdict?: unknown;
    };
    if (!Number.isInteger(index) || !((index as number) >= 1 && (index as number) <= count)) continue;
    if (typeof verdict !== 'string' || !MISSED_VERDICTS.includes(verdict)) continue;
    if (found.has(index) && found.get(index) !== verdict) conflicted.add(index);
    found.set(index, verdict);
  }
  return {
    verdicts: Array.from({ length: count }, (_, i) =>
      conflicted.has(i + 1) ? 'uncertain' : (found.get(i + 1) ?? 'uncertain')
    ),
    empty: false,
  };
}

/**
 * The state a verdict leaves a candidate in: `resolved` stays resolved; `owed` stays `pending`
 * for its recovery turn while `recovery` is on, else (shadow mode) it is `dismissed` like every
 * other verdict.
 */
export function stateForVerdict(verdict: string, recovery: boolean): 'pending' | 'resolved' | 'dismissed' {
  if (verdict === 'resolved') return 'resolved';
  if (verdict === 'owed' && recovery) return 'pending';
  return 'dismissed';
}

/**
 * When a channel's sweep is due: `delayMs` after its last event (a candidate, a message), never
 * later than `maxDelayMs` after the first event that armed it.
 * @returns epoch ms
 */
export function sweepDueAt(
  sweep: { firstAt: number; lastAt: number },
  settings: { sweepDelaySeconds: number; sweepMaxDelaySeconds: number }
): number {
  return Math.min(
    sweep.lastAt + settings.sweepDelaySeconds * 1000,
    sweep.firstAt + Math.max(settings.sweepMaxDelaySeconds, settings.sweepDelaySeconds) * 1000
  );
}

/**
 * `list` bounded: candidates older than a day go (by their last change, an open one by its
 * message time), then the oldest closed ones and at last the oldest open ones beyond `max`.
 * Pure.
 */
export function pruneCandidates(list: Array<Candidate>, now: number, max: number = MAX_CANDIDATES): Array<Candidate> {
  const kept = list.filter((candidate) => {
    const last = isOpen(candidate)
      ? candidate.at
      : Math.max(candidate.at ?? 0, candidate.updatedAt ?? 0, candidate.checkedAt ?? 0);
    return Number.isFinite(last) && now - last <= KEEP_MS;
  });
  if (kept.length <= max) return kept;
  const order = [...kept].sort((a, b) => Number(isOpen(a)) - Number(isOpen(b)) || a.at - b.at);
  const drop = new Set(order.slice(0, kept.length - max));
  return kept.filter((candidate) => !drop.has(candidate));
}

/** `list` with the open candidate of `messageId` changed by `patch`; anything else as it was. */
function patchOpen(list: Untyped, messageId: Untyped, patch: Untyped): { list: Untyped; changed: Untyped } {
  let changed: Untyped = null;
  const next = list.map((candidate: Candidate) => {
    if (candidate.messageId !== messageId || !isOpen(candidate)) return candidate;
    changed = { ...candidate, ...patch };
    return changed;
  });
  return { list: changed ? next : list, changed };
}

/**
 * The registry reconciled with journal records (parsed lines of any kind, oldest first): the
 * `answer` facts of the last `windowMs` before `now` not in `list` yet are added; a later
 * `verdict` (stateForVerdict with `recovery`), `resolved`, `expired` or `recovery` record closes
 * an open candidate as it did; and the turns that ended since (a `turn` record joined to its
 * `turn.start` by `turnId`) resolve what they answered (resolveByTurn, the turn's start standing
 * for its trigger's time). Pure.
 */
export function reconcileFromRecords(
  list: Array<Candidate>,
  records: Array<Record<string, Untyped>>,
  { now, windowMs = RECONCILE_WINDOW_MS, recovery = false }: { now: number; windowMs?: number; recovery?: boolean }
): { list: Array<Candidate>; added: number; closed: number } {
  let out = list;
  let added = 0;
  let closed = 0;
  const starts = new Map();
  const from = now - windowMs;
  for (const record of Array.isArray(records) ? records : []) {
    const at = Date.parse(record?.occurredAt);
    if (!Number.isFinite(at)) continue;
    const placeId = record.scope?.channel ?? null;
    if (record.kind === 'turn.start') {
      starts.set(record.turnId, {
        triggerId: record.trigger?.messageId ?? null,
        triggerAuthorId: record.trigger?.authorId ?? null,
        at,
      });
      continue;
    }
    if (at < from) continue;
    if (record.kind === 'turn') {
      const start = starts.get(record.turnId) ?? {};
      const replyTargets = (Array.isArray(record.posted) ? record.posted : [])
        .map((post: Untyped) => post?.replyTo)
        .filter((id: Untyped) => typeof id === 'string' && id);
      const result = resolveByTurn(out, {
        placeId,
        ...start,
        triggerAt: start.at ?? null,
        outcome: record.outcome,
        replyTargets,
        turnId: record.turnId,
        at,
      });
      out = result.list;
      closed += result.resolved.length;
      continue;
    }
    if (record.kind !== 'answer') continue;
    if (record.event === 'fact') {
      const messageAt = Date.parse(record.at);
      const result = addCandidate(
        out,
        {
          iface: record.iface as string | undefined,
          messageId: record.messageId,
          placeId,
          authorId: record.authorId ?? null,
          at: Number.isFinite(messageAt) ? messageAt : at,
          reason: record.reason,
          question: record.question === true,
          turnId: record.turnId ?? null,
        },
        { now: at }
      );
      out = result.list;
      if (result.added) added += 1;
      continue;
    }
    const ids =
      record.event === 'recovery' ? (Array.isArray(record.messageIds) ? record.messageIds : []) : [record.messageId];
    for (const messageId of ids) {
      let patch = null;
      if (record.event === 'verdict' && typeof record.verdict === 'string')
        patch = { verdict: record.verdict, checkedAt: at, state: stateForVerdict(record.verdict, recovery) };
      else if (record.event === 'resolved') patch = { state: 'resolved' };
      else if (record.event === 'expired') patch = { state: 'expired' };
      else if (record.event === 'recovery')
        patch = {
          state: record.outcome === 'spoke' || record.outcome === 'skip' ? 'resolved' : 'dismissed',
          attempts: 1,
        };
      if (!patch) continue;
      const result = patchOpen(out, messageId, { ...patch, updatedAt: at });
      out = result.list;
      if (result.changed && !isOpen(result.changed)) closed += 1;
    }
  }
  return { list: out, added, closed };
}

/**
 * The day's figures from its `answer` records (parsed journal records, any kinds): `candidates`
 * (distinct messages with a fact), `byReason` (each message counted under its first reason),
 * `byVerdict` (every verdict record), `owed` (distinct messages with an `owed` verdict) and
 * `recovered` (the messages of the recovery turns that spoke). Pure.
 */
export function missedCounts(records: Array<Record<string, Untyped>>): MissedCountsResult {
  const facts = new Map();
  const byReason: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  const owed = new Set();
  let recovered = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.kind !== 'answer') continue;
    if (record.event === 'fact' && typeof record.messageId === 'string' && !facts.has(record.messageId)) {
      facts.set(record.messageId, record.reason);
      byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
    } else if (record.event === 'verdict' && typeof record.verdict === 'string') {
      byVerdict[record.verdict] = (byVerdict[record.verdict] ?? 0) + 1;
      if (record.verdict === 'owed') owed.add(record.messageId);
    } else if (record.event === 'recovery' && record.outcome === 'spoke') {
      recovered += Array.isArray(record.messageIds) ? record.messageIds.length : 0;
    }
  }
  return { candidates: facts.size, owed: owed.size, recovered, byReason, byVerdict };
}

/**
 * The status card's line of the day's figures (missedCounts).
 */
export function missedStatusLine(counts: { candidates: number; owed: number; recovered: number }): string {
  return `missed: ${counts.candidates} candidates, ${counts.owed} owed, ${counts.recovered} recovered`;
}

/**
 * The analyzer's request for one channel: system = `prompt` (`{{name}}` filled), user = the
 * channel's transcript from LINES_BEFORE lines before the earliest candidate on (the persona's
 * lines naming the message that started their turn, through `triggerOf`), then a
 * `<candidates>` block, one line per candidate: `<n>: #<line> <reason>`. Null without a prompt
 * or without a candidate shown in `history`. `candidates` keeps those it numbered, in order.
 */
export function buildCheckRequest({
  prompt,
  labels,
  config,
  selfName,
  history,
  candidates,
  triggerOf,
  now,
}: BuildCheckRequestInput): { system: string; user: string; candidates: Array<Candidate> } | null {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  const list = Array.isArray(history) ? history : [];
  const positions = candidates
    .map((candidate) => list.findIndex((message) => message?.id === candidate.messageId))
    .filter((index) => index >= 0);
  if (positions.length === 0) return null;
  const window = list.slice(Math.max(0, Math.min(...positions) - LINES_BEFORE));
  const lines = typeof triggerOf === 'function' ? withTriggers(window, triggerOf) : window;
  const items = formatTranscript(lines, {
    timezone: config.bot?.timezone,
    selfName,
    labels,
    seeReactions: false,
    now,
  });
  const indexOf = new Map(items.map((item) => [item.id, item.index]));
  const numbered = candidates.filter((candidate) => indexOf.has(candidate.messageId));
  const rows = numbered.map((candidate, i) => `${i + 1}: #${indexOf.get(candidate.messageId)} ${candidate.reason}`);
  return {
    system: fillPromptTemplate(prompt, { name: selfName }),
    user: `${renderTranscript(items, config.bot?.timezone, labels)}\n<candidates>\n${rows.join('\n')}\n</candidates>`,
    candidates: numbered,
  };
}

/** One armed sweep of a chat. */
type SweepEntry = {
  firstAt: number;
  lastAt: number;
  notBefore: number | null;
  timer: unknown;
  iface: string;
  placeId: string;
};
const freshSweep = (iface: string, placeId: string, at: number): SweepEntry => ({
  firstAt: at,
  lastAt: at,
  notBefore: null,
  timer: null,
  iface,
  placeId,
});
const missedKey = (placeId: string) => placeOrPersona('missed', placeId);
/** The journal's record of one fact, ids and no text. */
const factRecord = (
  fact: NoteFactInput,
  message: { id: unknown; placeId: unknown },
  known: { at: string; authorId: unknown; question: boolean }
) => ({
  event: 'fact',
  iface: fact.iface ?? '',
  reason: fact.reason,
  messageId: message.id,
  authorId: known.authorId,
  placeId: message.placeId,
  at: known.at,
  question: known.question,
  ...(fact.replacedBy ? { replacedBy: fact.replacedBy as unknown } : {}),
  ...(fact.failure ? { failure: fact.failure as unknown } : {}),
  ...(fact.turnId ? { turnId: fact.turnId as unknown } : {}),
  participants: known.authorId ? [known.authorId] : [],
  sourceMessageIds: [message.id, ...(fact.replacedBy ? [fact.replacedBy as unknown] : [])],
});

/** The candidates of `iface` and the others. With no interface named, all are its own. */
const byInterface = (list: Array<Candidate>, iface: unknown): [Array<Candidate>, Array<Candidate>] =>
  iface ? [list.filter((c) => c.iface === iface), list.filter((c) => c.iface !== iface)] : [list, []];
/** The top of a stored place's tree, where its journal lives; the place itself when the store cannot say. */
const rootOf = (store: unknown, placeId: string): string =>
  (store as { rootPlaceOf?: (id: string) => string | null }).rootPlaceOf?.(placeId) ?? placeId;
/**
 * The place a chat's candidates belong to: its own, a DM's by its partner. With `top` the top of its tree, where
 * the journal lives.
 */
function placeOwner(
  store: unknown,
  partner: string | null,
  chatId: string,
  iface: string | undefined,
  top: boolean
): string {
  const chat = partner ? { id: chatId, kind: 'dm', partnerId: partner } : { id: chatId };
  return top && !partner ? sharedPlaceOf(store, chat, iface) : placeOfChat(store, chat, iface);
}
/** One chat's key: two interfaces may share a native id. */
const spotOf = (iface: string, placeId: string): string => JSON.stringify([iface, placeId]);
/** The interface and native id of a key from spotOf. */
const placeOfSpot = (spot: string): { iface: string; placeId: string } => {
  const [iface, placeId] = JSON.parse(spot) as [string, string];
  return { iface, placeId };
};
const registryOwner = (placeId: string): string => `places/${placeId}/missed.json`;
const registryFile = (dataDir: string, placeId: string): string => path.join(dataDir, registryOwner(placeId));

/** A registry: its candidates and the last recovery per chat (spotOf). */
type Registry = { candidates: Array<Candidate>; lastRecoveryAt: Record<string, number> };

/** The candidate registry's existing JSON shape, independent of its persistence backend. */
function registryOf(value: unknown): Registry {
  const parsed = objOf(value);
  return {
    candidates: Array.isArray(parsed.candidates)
      ? parsed.candidates.filter((candidate: Candidate) => candidate && typeof candidate.messageId === 'string')
      : [],
    lastRecoveryAt:
      parsed.lastRecoveryAt && typeof parsed.lastRecoveryAt === 'object' ? { ...parsed.lastRecoveryAt } : {},
  };
}

/**
 * Each started place and each place that owns a candidate or a recovery time, with what it holds. A started place left
 * with nothing is there, so its stored registry empties.
 */
function shelvesOf(
  started: Array<string>,
  candidates: Array<Candidate>,
  lastRecoveryAt: Record<string, number>,
  ownerOf: (iface: string | undefined, placeId: string) => string
): Map<string, Registry> {
  const owners = new Map<string, Registry>(started.map((place) => [place, { candidates: [], lastRecoveryAt: {} }]));
  const shelfOf = (place: string): Registry => {
    const fresh: Registry = owners.get(place) ?? { candidates: [], lastRecoveryAt: {} };
    owners.set(place, fresh);
    return fresh;
  };
  for (const candidate of candidates) shelfOf(ownerOf(candidate.iface, candidate.placeId)).candidates.push(candidate);
  for (const [spot, at] of Object.entries(lastRecoveryAt)) {
    const { iface, placeId } = placeOfSpot(spot);
    shelfOf(ownerOf(iface, placeId)).lastRecoveryAt[spot] = at;
  }
  return owners;
}

/** Write each shelf that differs from what was last written; resolves false, and throws on a failed write. */
async function writeChanged(
  owners: Map<string, Registry>,
  written: Map<string, string>,
  write: (place: string, value: unknown) => Promise<void>
): Promise<boolean> {
  for (const [place, shelf] of owners) {
    const value = { v: FILE_VERSION, ...shelf };
    const text = JSON.stringify(value);
    if (written.get(place) === text) continue;
    await write(place, value);
    written.set(place, text);
  }
  return false;
}

/**
 * One place's stored registry, from the database or the standalone file backend, or null with nothing there. A candidate
 * from before `iface` was kept is left out, and so is a recovery time under a bare native id.
 */
async function readRegistry(
  deps: Pick<CreateMissedInput, 'memoryDb' | 'dataDir'> & {
    seam: ReturnType<typeof createReadSeam>;
    fs: NonNullable<CreateMissedInput['fs']>;
    log: Untyped;
    now: () => number;
  },
  placeId: string
): Promise<Registry | null> {
  const known = ({ candidates, lastRecoveryAt }: Registry): Registry => ({
    candidates: candidates.filter((entry) => entry.iface),
    lastRecoveryAt: Object.fromEntries(Object.entries(lastRecoveryAt).filter(([spot]) => spot.startsWith('['))),
  });
  const { memoryDb, seam, fs, dataDir, log, now } = deps;
  if (memoryDb) {
    const stored = seam.run(() => unitValue(seam.db(), missedKey(placeId)));
    return known(registryOf(stored.found ? stored.value : null));
  }
  const file = registryFile(dataDir, placeId);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (objOf(error).code !== 'ENOENT') log.warn('missed: load failed', { code: objOf(error).code ?? null });
    return null;
  }
  try {
    return known(registryOf(JSON.parse(text)));
  } catch {
    log.warn('missed: file unreadable, moved aside', { placeId: String(placeId) });
    await fs.rename(file, `${file}.bad-${now()}`).catch(() => {});
    return null;
  }
}

/** Persist one complete registry through the configured writer. */
async function writeRegistry(
  memoryDb: CreateMissedInput['memoryDb'],
  fs: NonNullable<CreateMissedInput['fs']>,
  dataDir: string,
  placeId: string,
  key: StorageKey,
  value: unknown
): Promise<void> {
  if (memoryDb) {
    await memoryDb.writeUnit({ op: 'value', key, value });
    return;
  }
  const file = registryFile(dataDir, placeId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value));
  await fs.rename(`${file}.tmp`, file);
}

/**
 * The registry, its sweeps and its recovery turns.
 *
 * @param deps.hot  Read at the moment of use.
 * @param deps.store  Only `state.data.paused` is read.
 * @param [deps.journal]  src/memory/journal.js: `answer` records written while
 *   features.journal is exactly true; `read` at start for the reconciliation.
 * @param [deps.llm]  The analyzer's client; absent, every check is `unchecked`.
 * @param deps.turns  The turn runner: `runTurn`, `triggerOf`, `lastPostAt`, `isBusy`, `isAnyBusy`.
 * @param deps.reads  The core's reads of the interface.
 * @param [deps.partnerOf]  The other member of a private chat.
 * @param deps.dataDir  `data/`.
 * @param [deps.fs]  node:fs/promises-shaped.
 */
export function createMissed({
  hot,
  store,
  journal = null,
  llm = null,
  turns,
  reads,
  partnerOf: partnerOfChat = () => null,
  getSelfName = () => 'bot',
  dataDir,
  memoryDb,
  fs = nodeFs,
  now = Date.now,
  timers = {
    set: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clear: (timer) => clearTimeout(timer),
  },
  log = defaultLog,
}: CreateMissedInput): CreateMissedResult {
  const seam = createReadSeam({ memoryDb, log, reader: 'missed' });
  let candidates: Array<Candidate> = [];
  let privateRecovery: Untyped = null;
  let lastRecoveryAt: Record<string, number> = {};
  const started = new Set<string>(); // the places whose stored registry is in `candidates`
  const written = new Map<string, string>(); // what was last written under each
  let dirty = false;
  let chain = Promise.resolve();
  let promptMissingLogged = false;
  const sweeps = new Map<string, SweepEntry>(); // by spotOf(iface, placeId)
  const sweeping = new Set();

  const enabled = () => true;
  const recoveryOn = () => true;
  const paused = () => Boolean(objOf(objOf(store?.state).data).paused);
  const journalOn = () => Boolean(journal) && typeof journal.answer === 'function';
  const iso = (ms: number) => new Date(ms).toISOString();

  /** The person a private chat belongs to, null for a server channel (or one not known). */
  function partnerOf(placeId: string) {
    const id = partnerOfChat(String(placeId));
    return typeof id === 'string' && id ? id : null;
  }

  const ownerOf = (iface: string | undefined, chatId: string, top = false): string =>
    placeOwner(store, partnerOf(chatId), chatId, iface, top);

  /** One `answer` record (features.journal on), in the journal of the top of its place, a DM's its own; never throws. */
  function record(fields: Untyped) {
    if (!journalOn()) return;
    const iface =
      (fields?.iface as string | undefined) ?? candidates.find((c) => c.messageId === fields?.messageId)?.iface;
    const placeId = fields?.placeId ? ownerOf(iface, String(fields.placeId), true) : PERSONA_ID;
    Promise.resolve()
      .then(() => journal.answer(placeId, fields))
      .catch((error) => log.warn('missed: journal failed', { code: objOf(error).code ?? null }));
  }

  /**
   * Write the registry through its persistence backend when the core is running: each candidate under the unit `missed`
   * of its own place, with the recovery times of that place. A started place left with nothing is written empty, once.
   */
  function save() {
    dirty = true;
    if (started.size === 0 || paused()) return chain;
    const run = chain.then(async () => {
      if (!dirty) return;
      dirty = false;
      candidates = pruneCandidates(candidates, now());
      const owners = shelvesOf([...started], candidates, lastRecoveryAt, ownerOf);
      dirty = await writeChanged(owners, written, (place, value) =>
        writeRegistry(memoryDb, fs, dataDir, place, missedKey(place), value)
      ).catch((error: unknown) => {
        log.warn('missed: save failed', { code: objOf(error).code ?? null });
        return true;
      });
    });
    chain = run.catch(() => {});
    return run;
  }

  /** Add one place's stored registry to what is in memory. */
  async function load(placeId: string) {
    const found = await readRegistry({ memoryDb, seam, fs, dataDir, log, now }, placeId);
    if (!found) return;
    const known = new Set(candidates.map((entry) => entry.messageId));
    candidates = [...candidates, ...found.candidates.filter((entry) => !known.has(entry.messageId))];
    lastRecoveryAt = { ...lastRecoveryAt, ...found.lastRecoveryAt };
  }

  /** The journal's records of the last hour (the days it spans), oldest first. */
  async function recentRecords(placeId: string) {
    if (typeof journal?.read !== 'function') return [];
    const at = now();
    const days = [...new Set([utcDay(at - RECONCILE_WINDOW_MS), utcDay(at)])];
    const out = [];
    for (const day of days) out.push(...(await journal.read(placeId, { day, n: Number.MAX_SAFE_INTEGER })));
    return out;
  }

  /**
   * At start, once per place that holds a registry: its registry added to the ones already started, reconciled with
   * its journal of the last hour (features.journal on), pruned and written; a sweep armed in every chat with a
   * pending candidate. A place never seen before starts empty.
   */
  async function start(placeId: string) {
    started.add(placeId);
    await load(placeId);
    try {
      const result = reconcileFromRecords(candidates, await recentRecords(rootOf(store, placeId)), {
        now: now(),
        recovery: recoveryOn(),
      });
      candidates = result.list;
      log.info('missed: reconciled', { placeId: String(placeId), added: result.added, closed: result.closed });
    } catch (error) {
      log.warn('missed: reconcile failed', { code: objOf(error).code ?? null });
    }
    candidates = pruneCandidates(candidates, now());
    await save();
    if (!enabled()) return;
    for (const candidate of candidates)
      if (candidate.state === 'pending') arm(String(candidate.iface), candidate.placeId);
  }

  /** (Re)schedule a chat's sweep at sweepDueAt, never before its `notBefore` (a held recovery). */
  function schedule(entry: SweepEntry) {
    if (entry.timer) timers.clear(entry.timer);
    const due = Math.max(entry.notBefore ?? 0, sweepDueAt(entry, missedSettings(hot.config)));
    const wait = Math.max(0, due - now());
    const { iface, placeId } = entry;
    // The sweep's promise is returned (never rejects) for a caller that waits on the timer.
    entry.timer = timers.set(() => {
      sweeps.delete(spotOf(iface, placeId));
      return sweep(iface, placeId).catch((error: unknown) => log.error('missed: sweep failed', { placeId, error }));
    }, wait);
  }

  /** A candidate event in a chat: its sweep armed, or pushed back. */
  function arm(iface: string, placeId: string, at = now()) {
    const entry = sweeps.get(spotOf(iface, placeId));
    if (entry) {
      entry.lastAt = at;
      schedule(entry);
      return;
    }
    const fresh = freshSweep(iface, placeId, at);
    sweeps.set(spotOf(iface, placeId), fresh);
    schedule(fresh);
  }

  /** A message in a chat: an armed sweep waits for the talk to settle (never past its cap). */
  function noteActivity(placeId: string, at = now(), iface = '') {
    const entry = sweeps.get(spotOf(iface, placeId));
    if (!entry) return;
    entry.lastAt = Math.max(entry.lastAt, Number.isFinite(at) ? at : now());
    schedule(entry);
  }

  /**
   * The address check's "no" on a normalized message: one `answer` record (`event` `address`,
   * `verdict` `not-addressed`; ids and time, never the text) for the heartbeat view's list of
   * what was filtered without her. Not a candidate. Never throws.
   */
  function noteNotAddressed(message: MissedLine, iface?: string) {
    try {
      if (!message?.id || !message.placeId) return;
      const at = Number.isFinite(message.ts) ? message.ts : now();
      record({
        event: 'address',
        ...(iface ? { iface } : {}),
        verdict: 'not-addressed',
        messageId: message.id,
        authorId: message.authorId ?? null,
        placeId: message.placeId,
        at: iso(at),
        participants: message.authorId ? [message.authorId] : [],
      });
    } catch (error) {
      log.warn('missed: address verdict failed', { code: objOf(error).code ?? null });
    }
  }

  /**
   * One fact: `{ reason, message, replacedBy?, failure?, turnId? }`, `message` a normalized
   * message (its id, channel, author, time and -- for isQuestion only -- its text). Journaled,
   * added to the registry, its channel's sweep armed. Never throws.
   */
  function noteFact(fact: NoteFactInput = {}) {
    const { reason, message, turnId = null, iface = '' } = fact;
    try {
      if (!enabled() || !MISSED_REASONS.includes(String(reason)) || !message?.id || !message.placeId) return;
      const at = Number.isFinite(message.ts) ? message.ts : now();
      const authorId = message.authorId ?? null;
      const question = isQuestion(message.content);
      record(factRecord(fact, message as { id: unknown; placeId: unknown }, { at: iso(at), authorId, question }));
      const result = addCandidate(
        candidates,
        {
          messageId: message.id,
          placeId: message.placeId,
          iface,
          authorId,
          at,
          reason: String(reason),
          question,
          turnId,
        },
        { now: now() }
      );
      candidates = result.list;
      log.info('missed: candidate', {
        placeId: message.placeId,
        messageId: message.id,
        reason,
        added: result.added,
      });
      save();
      if (result.candidate && isOpen(result.candidate)) arm(iface, String(message.placeId));
    } catch (error) {
      log.warn('missed: fact failed', { reason, error });
    }
  }

  /** Close what a turn's end resolved: journaled `resolved`, logged. */
  function noteResolved(resolved: Untyped, turnId: string | null = null) {
    for (const { messageId, placeId, by } of resolved) {
      record({
        event: 'resolved',
        messageId,
        placeId,
        by,
        ...(turnId ? { turnId } : {}),
        sourceMessageIds: [messageId],
      });
      log.info('missed: resolved', { placeId, messageId, by });
    }
  }

  /**
   * A turn ended (src/behavior/turn.ts#setOnTurnEnd): what it answered is resolved; a failed
   * turn of a call (`error`, `not-now`) is a fact about its trigger -- a `turn-error` one carries
   * the turn's reason (e.g. `cut-off`) as its `failure`. A private chat's failed turn is one like
   * any other, kept in that chat; routed calls, overheard lines and the recovery turns themselves
   * make no candidate. Never throws.
   */
  function onTurnEnd(end: TurnEnd) {
    try {
      if (!enabled() || !end || !end.chatId) return;
      const trigger = end.trigger ?? null;
      const turnId = typeof end.turnId === 'string' ? end.turnId : null;
      // A turn resolves the candidates of its own interface; two interfaces may share a native id.
      const [mine, others] = byInterface(candidates, end.iface);
      const result = resolveByTurn(mine, {
        placeId: end.chatId,
        triggerId: trigger?.id ?? null,
        triggerAuthorId: trigger?.authorId ?? null,
        triggerAt: trigger?.ts ?? null,
        outcome: end.outcome,
        replyTargets: end.replyTargets,
        turnId: turnId,
        at: now(),
      });
      if (result.resolved.length > 0) {
        candidates = [...others, ...result.list];
        noteResolved(result.resolved, turnId);
        save();
      }
      if (!trigger || end.routed || !OWED_TRIGGER_KINDS.has(end.triggerKind)) return;
      let reason = null;
      if (end.outcome === 'error') reason = end.reason === 'too-slow' ? 'turn-dropped' : 'turn-error';
      else if (end.outcome === 'not-now') reason = 'not-now';
      // A failed turn's own reason (`cut-off`, ...) rides along as the fact's `failure`.
      const failure = reason === 'turn-error' && typeof end.reason === 'string' ? end.reason : null;
      if (reason)
        noteFact({
          reason,
          message: { ...trigger, placeId: trigger.placeId ?? end.chatId },
          turnId: end.turnId ?? null,
          failure,
          iface: end.iface,
        });
    } catch (error) {
      log.warn('missed: turn end failed', { error });
    }
  }

  /** Close `candidate` with `state` (and `patch`), journaled as `event`. */
  function close(candidate: Candidate, state: Untyped, event: Untyped, fields = {}, patch = {}) {
    const result = patchOpen(candidates, candidate.messageId, { state, updatedAt: now(), ...patch });
    candidates = result.list;
    record({
      event,
      messageId: candidate.messageId,
      placeId: candidate.placeId,
      reason: candidate.reason,
      ...fields,
      sourceMessageIds: [candidate.messageId],
    });
  }

  /** Journal one verdict and put the candidate in the state it leaves. */
  function applyVerdict(candidate: Candidate, verdict: Untyped, by: Untyped) {
    const recovery = recoveryOn();
    const state = stateForVerdict(verdict, recovery);
    const result = patchOpen(candidates, candidate.messageId, { verdict, checkedAt: now(), state, updatedAt: now() });
    candidates = result.list;
    record({
      event: 'verdict',
      messageId: candidate.messageId,
      authorId: candidate.authorId,
      placeId: candidate.placeId,
      reason: candidate.reason,
      verdict,
      by,
      shadow: verdict === 'owed' && !recovery,
      participants: candidate.authorId ? [candidate.authorId] : [],
      sourceMessageIds: [candidate.messageId],
    });
    log.info('missed: verdict', {
      placeId: candidate.placeId,
      messageId: candidate.messageId,
      reason: candidate.reason,
      verdict,
      by,
    });
    return result.changed;
  }

  /** The chat `placeId` as the interface describes it now (permissions and all), or null when it does not. */
  async function channelOf(iface: string, placeId: string) {
    return (await reads.chatInfo({ iface, chatId: String(placeId) }))?.chat ?? null;
  }

  /** The analyzer's verdicts for `list` (one call), each `unchecked` when it fails. */
  async function classify(list: Array<Candidate>, { channel, history, config }: ClassifyContext) {
    const unchecked = () => list.map(() => UNCHECKED);
    const prompts = hot.prompts;
    const placeId = sharedPlaceOf(store, channel);
    const request = buildCheckRequest({
      prompt: prompts?.missed,
      labels: prompts?.labels,
      config,
      selfName: getSelfName(placeId),
      history,
      candidates: list,
      triggerOf: typeof turns?.triggerOf === 'function' ? (id: string) => turns.triggerOf(id) : undefined,
      now: now(),
    });
    if (!request) {
      if (!promptMissingLogged && !(typeof prompts?.missed === 'string' && prompts.missed.trim())) {
        promptMissingLogged = true;
        log.warn('missed: prompts.missed is missing, every check is unchecked', {});
      }
      return unchecked();
    }
    if (!llm) return unchecked();
    try {
      const completion = await llm.complete(
        [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        {
          model: roleModel(config, 'analyzer', 'missed'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: missedSettings(config).maxOutputTokens,
            purpose: 'missed',
          }),
          responseFormat: MISSED_FORMAT,
        }
      );
      const { verdicts, empty } = parseMissedAnswer(completion?.text, request.candidates.length);
      if (empty) log.warn('missed: helper failed', { placeId: channel.id, reason: 'empty' });
      const byId = new Map(request.candidates.map((candidate, i) => [candidate.messageId, verdicts[i]]));
      return list.map((candidate: Candidate) => byId.get(candidate.messageId) ?? UNCHECKED);
    } catch (error) {
      log.warn('missed: helper failed', { placeId: channel.id, error });
      return unchecked();
    }
  }

  /**
   * One channel's sweep (the timer's, or a test's): the code's filter (sweepPlan), the analyzer
   * for what is left, then a recovery turn for the owed ones or, in
   * shadow mode, nothing posted. Skipped while paused.
   */
  async function sweep(iface: string, placeId: string) {
    const spot = spotOf(iface, placeId);
    const here = (entry: Candidate) => entry.placeId === placeId && entry.iface === iface;
    if (!enabled()) return;
    if (paused()) {
      log.info('missed: sweep skipped', { placeId, reason: 'paused' });
      return;
    }
    if (sweeping.has(spot)) {
      arm(iface, placeId);
      return;
    }
    if (!candidates.some((candidate) => here(candidate) && candidate.state === 'pending')) return;
    sweeping.add(spot);
    try {
      const config = hot.config;
      const settings = missedSettings(config);
      const channel = await channelOf(iface, placeId);
      let history = null;
      if (channel) {
        try {
          history = await historyLines(
            reads,
            { iface: channel.iface, chatId: channel.id },
            { limit: Math.max(1, Math.floor(settings.contextMessages)) }
          );
        } catch (error) {
          log.warn('missed: history fetch failed', { placeId, error });
        }
      }
      if (!channel || !Array.isArray(history)) {
        for (const candidate of candidates.filter((entry) => here(entry) && entry.state === 'pending'))
          applyVerdict(candidate, UNCHECKED, 'code');
        await save();
        return;
      }
      const triggerOf = typeof turns?.triggerOf === 'function' ? (id: Untyped) => turns.triggerOf(id) : null;
      const plan = sweepPlan(candidates.filter(here), placeId, { now: now(), settings, history, triggerOf });
      for (const candidate of plan.expired) {
        close(candidate, 'expired', 'expired');
        log.info('missed: expired', { placeId, messageId: candidate.messageId, reason: candidate.reason });
      }
      for (const { candidate, by } of plan.resolved) {
        close(candidate, 'resolved', 'resolved', { by });
        log.info('missed: resolved', { placeId, messageId: candidate.messageId, by });
      }
      for (const candidate of plan.notShown) applyVerdict(candidate, 'stale', 'code');
      const owed = [...plan.owed];
      if (plan.check.length > 0) {
        const verdicts = await classify(plan.check, { channel, history, config });
        plan.check.forEach((candidate, i) => {
          const changed = applyVerdict(candidate, verdicts[i], verdicts[i] === UNCHECKED ? 'code' : 'model');
          if (verdicts[i] === 'owed' && changed?.state === 'pending') owed.push(changed);
        });
      }
      await save();
      if (owed.length > 0 && recoveryOn()) await recover(channel, owed, history);
    } finally {
      sweeping.delete(spot);
    }
  }

  /** Whether a turn would find the attention taken in `placeId` now (the rule runTurn applies). */
  function attentionTaken(placeId: string) {
    if (typeof turns?.isBusy === 'function' && turns.isBusy(placeId)) return true;
    return typeof turns?.isAnyBusy === 'function' && turns.isAnyBusy();
  }

  /** Hold the owed candidates of a channel for a later sweep, `waitMs` from now at the earliest. */
  function holdFor(iface: string, placeId: string, waitMs: Untyped) {
    const at = now();
    const entry = sweeps.get(spotOf(iface, placeId)) ?? freshSweep(iface, placeId, at);
    entry.notBefore = at + Math.max(0, waitMs);
    sweeps.set(spotOf(iface, placeId), entry);
    schedule(entry);
  }

  /**
   * One recovery turn for the owed candidates of `channel` (oldest first): the earliest is its
   * trigger, all of them are named in its task. Held back (pending, its sweep re-armed) while
   * the channel's cooldown runs or the attention is taken; dropped (`dismissed`) where the bot
   * cannot write. The candidates are `in_progress` while it runs; it posts nothing when the
   * persona spoke in the channel since it started or one of them was answered meanwhile
   * (`stillDue`). After it: `resolved` when it spoke or chose silence, else `dismissed` -- one
   * attempt per candidate.
   */
  async function recover(channel: ChatInfo, owed: Array<Candidate>, history: Array<MissedLine>) {
    const placeId = channel.id;
    const spot = spotOf(channel.iface, placeId);
    const config = hot.config;
    const settings = missedSettings(config);
    if (paused()) return;
    const list = [...owed].sort((a, b) => a.at - b.at);
    if (!channel.permissions.send) {
      finishRecovery(placeId, list, { outcome: 'cannot-send' }, null);
      await save();
      return;
    }
    const cooldownMs = settings.channelCooldownMinutes * MINUTE_MS;
    const last = lastRecoveryAt[spot];
    if (Number.isFinite(last) && now() - last < cooldownMs) {
      log.info('missed: recovery held', { placeId, reason: 'cooldown', candidates: list.length });
      holdFor(channel.iface, placeId, last + cooldownMs - now());
      return;
    }
    if (attentionTaken(placeId)) {
      log.info('missed: recovery held', { placeId, reason: 'busy', candidates: list.length });
      holdFor(channel.iface, placeId, settings.sweepDelaySeconds * 1000);
      return;
    }
    const byId = new Map<string, Untyped>(history.map((message: Untyped) => [message.id, message]));
    const shown = list.filter((candidate) => byId.has(candidate.messageId));
    if (shown.length === 0) return;
    const trigger = byId.get(shown[0].messageId);
    const ids = shown.map((candidate) => candidate.messageId);
    // A private chat is recovered only where the private-chat gate lets the person through (their daily cap counts the turn).
    const isDm = channel.rootId === null;
    if (
      isDm &&
      !(
        typeof privateRecovery?.allow === 'function' &&
        (await privateRecovery.allow(channel, trigger).catch(() => false))
      )
    ) {
      log.info('missed: recovery refused', { placeId, reason: 'private-gate', candidates: ids.length });
      finishRecovery(placeId, shown, { outcome: 'private-gate' }, trigger.id);
      await save();
      return;
    }
    const startedAt = now();
    for (const candidate of shown)
      candidates = patchOpen(candidates, candidate.messageId, {
        state: 'in_progress',
        attempts: candidate.attempts + 1,
        updatedAt: startedAt,
      }).list;
    lastRecoveryAt = { ...lastRecoveryAt, [spot]: startedAt };
    await save();
    const maxChars = MAX_MESSAGE_CHARS;
    const missedItems = shown.map((candidate) => {
      const message = byId.get(candidate.messageId);
      return {
        id: candidate.messageId,
        author: oneLine(message.authorName ?? ''),
        text: clampChars(oneLine(message.content ?? ''), maxChars),
      };
    });
    const stillDue = () => {
      const lastPost = typeof turns?.lastPostAt === 'function' ? turns.lastPostAt(placeId) : 0;
      if (Number.isFinite(lastPost) && lastPost > startedAt) return false;
      return ids.every((id) => candidates.find((candidate) => candidate.messageId === id)?.state === 'in_progress');
    };
    log.info('missed: recovery', { placeId, candidates: ids.length, trigger: trigger.id });
    let result;
    try {
      result = await turns.runTurn({
        chat: { iface: channel.iface, chatId: channel.id },
        mode: 'reply',
        trigger,
        triggerKind: 'missed',
        missed: missedItems,
        stillDue,
      });
    } catch (error) {
      log.error('missed: recovery failed', { placeId, error });
      result = { outcome: 'error' };
    }
    const outcome = result?.outcome ?? 'error';
    if (outcome === 'busy') {
      // Never an attempt: the attention was taken between the check and the start.
      for (const candidate of shown)
        candidates = patchOpen(candidates, candidate.messageId, {
          state: 'pending',
          attempts: candidate.attempts,
          updatedAt: now(),
        }).list;
      const { [spot]: _ours, ...others } = lastRecoveryAt;
      lastRecoveryAt = Number.isFinite(last) ? { ...others, [spot]: last } : others;
      holdFor(channel.iface, placeId, settings.sweepDelaySeconds * 1000);
      await save();
      return;
    }
    finishRecovery(placeId, shown, result ?? { outcome }, trigger.id);
    if (isDm)
      await Promise.resolve(privateRecovery.after?.(channel, trigger, result ?? { outcome })).catch((error) =>
        log.warn('missed: private recovery count failed', { error })
      );
    await save();
  }

  /**
   * Close the candidates of one recovery (`list`): `resolved` when its turn spoke or chose
   * silence, else `dismissed` (one attempt each); one `recovery` record with the outcome.
   */
  function finishRecovery(placeId: string, list: Array<Candidate>, result: Untyped, triggerId: Untyped) {
    const outcome = result?.outcome ?? 'error';
    const done = outcome === 'spoke' || outcome === 'skip';
    const ids = list.map((candidate: Candidate) => candidate.messageId);
    for (const candidate of list) {
      const current = candidates.find((entry) => entry.messageId === candidate.messageId);
      const attempts = Math.max(1, current?.attempts ?? 0);
      candidates = patchOpen(candidates, candidate.messageId, {
        state: done ? 'resolved' : 'dismissed',
        attempts,
        updatedAt: now(),
      }).list;
    }
    record({
      event: 'recovery',
      placeId,
      messageIds: ids,
      triggerId,
      outcome,
      ...(typeof result?.reason === 'string' ? { reason: result.reason } : {}),
      participants: [...new Set(list.map((candidate: Candidate) => candidate.authorId).filter(Boolean))],
      sourceMessageIds: ids,
    });
    log.info('missed: recovered', { placeId, candidates: ids.length, outcome });
  }

  /** Every armed sweep cleared (shutdown). */
  function stop() {
    for (const entry of sweeps.values()) if (entry.timer) timers.clear(entry.timer);
    sweeps.clear();
  }

  return {
    start,
    noteFact,
    noteNotAddressed,
    /**
     * The pipeline's private-chat gate for a recovery turn in a DM: `allow(channel, trigger)` resolves
     * true when the person may be answered now, `after(channel, trigger, result)` counts the turn
     * toward their daily cap. Without it a private candidate is never recovered (dismissed `private-gate`).
     */
    setPrivateRecovery: (hooks: Untyped) => {
      privateRecovery = hooks && typeof hooks === 'object' ? hooks : null;
    },
    onTurnEnd,
    noteActivity,
    sweep,
    save,
    stop,
    /** A copy of the registry (tests, the owner's checks). */
    candidates: () => candidates.map((candidate) => ({ ...candidate, turnIds: [...candidate.turnIds] })),
  };
}
