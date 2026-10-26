// Missed answers: a second line behind the address gate, so a message owed an answer from the
// persona is not lost without a trace. Facts that a message may have been left unanswered -- the
// address classifier failed on it (`gate-failed`) or failed and let it through anyway
// (`gate-failopen`), a deferred follow-up was replaced by a newer one (`replaced-deferred`), a
// turn answering it ended in an error (`turn-error`) or was dropped at its bar (`turn-dropped`)
// or found nothing to do (`not-now`), a call that left the pending queue unanswered because the queue
// was full, the call waited too long or a stronger line took its place (`pending-full`,
// `pending-expired`, `pending-outranked`, src/behavior/pipeline.js) -- become candidates in a small registry, persisted in
// `data/guilds/<id>/missed.json` (written whole through a `.tmp` file and a rename) and written to
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
// `missed.questionExpireMinutes` for a message carrying a question mark), then one helper call
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
import { formatTranscript, renderTranscript, withTriggers } from '../format.js';
import { helperRequestOptions } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { fillPromptTemplate } from './prompt.js';
import { historyLines } from './lines.ts';
import { log as defaultLog } from '../log.js';
import { CODE } from '../skills/codes.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../time.js';

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

/** The helper's verdicts, then the one code gives a check that did not complete. */
export const MISSED_VERDICTS = Object.freeze(['owed', 'resolved', 'intentional-skip', 'stale', 'uncertain']);
export const UNCHECKED = 'unchecked';

/** The trigger kinds whose failed turn leaves somebody waiting (an overheard line does not). */
const OWED_TRIGGER_KINDS = new Set(['mention', 'reply', 'name', 'followUp', 'task', 'private']);

/** The states in which a candidate may still change. */
const OPEN_STATES = new Set(['pending', 'in_progress']);

/** `missed.*` when a key is missing: config.json's values. */
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
/** How many lines before the earliest candidate the helper's transcript keeps. */
const LINES_BEFORE = 5;
/** The registry file's schema version. */
const FILE_VERSION = 1;
/** A question mark, ASCII or full-width. */
const QUESTION_RE = /[?\uFF1F]/;

/**
 * `missed.*` of the live config, each key a finite number >= 0 or config.json's value.
 * @param {object|undefined} config  The whole live config.
 * @returns {typeof MISSED_FALLBACK}
 */
export function missedSettings(config) {
  const group = config?.missed ?? {};
  const out = {};
  for (const [key, fallback] of Object.entries(MISSED_FALLBACK)) {
    const value = group[key];
    out[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  return out;
}

/**
 * Whether a message's text counts as a direct question for the longer expiry: it carries a
 * question mark (ASCII or full-width). The address classifier answers yes/overheard/no, not
 * whether a line asks something, so this simple rule stands in.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isQuestion(text) {
  return typeof text === 'string' && QUESTION_RE.test(text);
}

/** Whether a candidate may still change. */
export function isOpen(candidate) {
  return OPEN_STATES.has(candidate?.state);
}

/**
 * `list` with the candidate of `fact` added (`pending`, no attempt, no verdict), or -- one
 * candidate per message -- an open one of the same message updated (its latest `reason`, the
 * turn id joined to `turnIds`). A closed one is left alone. Pure; nothing is mutated.
 * @param {object[]} list
 * @param {{ messageId: string, channelId: string, authorId?: string|null, at: number, reason: string,
 *   question?: boolean, turnId?: string|null }} fact
 * @param {{ now?: number }} [options]
 * @returns {{ list: object[], added: boolean, candidate: object|null }}
 */
export function addCandidate(list, fact, { now = fact?.at } = {}) {
  if (!fact?.messageId || !fact.channelId || !MISSED_REASONS.includes(fact.reason))
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
    channelId: fact.channelId,
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
 * @param {object[]} list
 * @param {{ channelId: string|null, triggerId?: string|null, triggerAuthorId?: string|null, triggerAt?: number|null,
 *   outcome: string, replyTargets?: string[], turnId?: string|null, at: number }} turn
 * @returns {{ list: object[], resolved: Array<{ messageId: string, channelId: string, by: string }> }}
 */
export function resolveByTurn(list, turn) {
  if (!turn || (turn.outcome !== 'spoke' && turn.outcome !== 'skip') || !turn.channelId) return { list, resolved: [] };
  const targets = new Set(Array.isArray(turn.replyTargets) ? turn.replyTargets : []);
  const resolved = [];
  const next = list.map((candidate) => {
    if (!isOpen(candidate) || candidate.channelId !== turn.channelId) return candidate;
    let by = null;
    if (turn.triggerId && turn.triggerId === candidate.messageId) by = 'trigger';
    else if (targets.has(candidate.messageId)) by = 'reply';
    else if (
      turn.outcome === 'spoke' &&
      turn.triggerAuthorId &&
      turn.triggerAuthorId === candidate.authorId &&
      Number.isFinite(turn.triggerAt) &&
      turn.triggerAt > candidate.at
    ) {
      by = 'author';
    }
    if (!by) return candidate;
    resolved.push({ messageId: candidate.messageId, channelId: candidate.channelId, by });
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
 * @param {object} candidate
 * @param {object[]} history
 * @param {(postedId: string) => string|null} triggerOf
 * @returns {'trigger'|'reply'|'author'|null}
 */
export function resolvedInHistory(candidate, history, triggerOf) {
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
 * @param {{ question?: boolean }} candidate
 * @param {{ expireMinutes: number, questionExpireMinutes: number }} settings
 * @returns {number} milliseconds
 */
export function expiryMs(candidate, settings) {
  return (candidate?.question ? settings.questionExpireMinutes : settings.expireMinutes) * MINUTE_MS;
}

/**
 * The code's part of a channel's sweep, before any helper call: of the channel's `pending`
 * candidates, which are `expired` (older than expiryMs at `now`), which the channel's `history`
 * shows answered (`resolved`, resolvedInHistory), which it does not show at all (`notShown`: the
 * talk moved past the window fetched), which carry an `owed` verdict already (`owed`: a recovery
 * held back by its cooldown or a busy attention, never asked about twice) and which go to the
 * helper (`check`). Pure.
 * @param {object[]} list
 * @param {string} channelId
 * @param {{ now: number, settings: object, history: object[], triggerOf?: (id: string) => string|null }} options
 * @returns {{ expired: object[], resolved: Array<{ candidate: object, by: string }>, notShown: object[], owed: object[], check: object[] }}
 */
export function sweepPlan(list, channelId, { now, settings, history, triggerOf }) {
  const out = { expired: [], resolved: [], notShown: [], owed: [], check: [] };
  const shown = new Set((Array.isArray(history) ? history : []).map((message) => message?.id));
  for (const candidate of list) {
    if (candidate.channelId !== channelId || candidate.state !== 'pending') continue;
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
 * The helper's answer (prompts/missed.md) for `count` candidates: one line per candidate,
 * `<n>: <verdict>` (a period, a parenthesis or a dash may stand for the colon; any case). A
 * candidate no line names, or named twice with different words, is `uncertain`; an empty
 * answer leaves every one `unchecked` (`empty`). Pure.
 * @param {unknown} text
 * @param {number} count
 * @returns {{ verdicts: string[], empty: boolean }}
 */
export function parseMissedAnswer(text, count) {
  const answer = String(text ?? '').trim();
  if (!answer) return { verdicts: Array.from({ length: count }, () => UNCHECKED), empty: true };
  const found = new Map();
  const conflicted = new Set();
  const lineRe = /^\s*(\d+)\s*[:.)-]\s*([a-z-]+)/i;
  for (const line of answer.split('\n')) {
    const match = lineRe.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    const verdict = match[2].toLowerCase();
    if (!(index >= 1 && index <= count) || !MISSED_VERDICTS.includes(verdict)) continue;
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
 * @param {string} verdict
 * @param {boolean} recovery
 * @returns {'pending'|'resolved'|'dismissed'}
 */
export function stateForVerdict(verdict, recovery) {
  if (verdict === 'resolved') return 'resolved';
  if (verdict === 'owed' && recovery) return 'pending';
  return 'dismissed';
}

/**
 * When a channel's sweep is due: `delayMs` after its last event (a candidate, a message), never
 * later than `maxDelayMs` after the first event that armed it.
 * @param {{ firstAt: number, lastAt: number }} sweep
 * @param {{ sweepDelaySeconds: number, sweepMaxDelaySeconds: number }} settings
 * @returns {number} epoch ms
 */
export function sweepDueAt(sweep, settings) {
  return Math.min(
    sweep.lastAt + settings.sweepDelaySeconds * 1000,
    sweep.firstAt + Math.max(settings.sweepMaxDelaySeconds, settings.sweepDelaySeconds) * 1000
  );
}

/**
 * `list` bounded: candidates older than a day go (by their last change, an open one by its
 * message time), then the oldest closed ones and at last the oldest open ones beyond `max`.
 * Pure.
 * @param {object[]} list
 * @param {number} now
 * @param {number} [max]
 * @returns {object[]}
 */
export function pruneCandidates(list, now, max = MAX_CANDIDATES) {
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
function patchOpen(list, messageId, patch) {
  let changed = null;
  const next = list.map((candidate) => {
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
 * @param {object[]} list
 * @param {object[]} records
 * @param {{ now: number, windowMs?: number, recovery?: boolean }} options
 * @returns {{ list: object[], added: number, closed: number }}
 */
export function reconcileFromRecords(list, records, { now, windowMs = RECONCILE_WINDOW_MS, recovery = false }) {
  let out = list;
  let added = 0;
  let closed = 0;
  const starts = new Map();
  const from = now - windowMs;
  for (const record of Array.isArray(records) ? records : []) {
    const at = Date.parse(record?.occurredAt);
    if (!Number.isFinite(at)) continue;
    const channelId = record.scope?.channel ?? null;
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
        .map((post) => post?.replyTo)
        .filter((id) => typeof id === 'string' && id);
      const result = resolveByTurn(out, {
        channelId,
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
          messageId: record.messageId,
          channelId,
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
 * @param {object[]} records
 * @returns {{ candidates: number, owed: number, recovered: number, byReason: Record<string, number>, byVerdict: Record<string, number> }}
 */
export function missedCounts(records) {
  const facts = new Map();
  const byReason = {};
  const byVerdict = {};
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
 * @param {{ candidates: number, owed: number, recovered: number }} counts
 * @returns {string}
 */
export function missedStatusLine(counts) {
  return `missed: ${counts.candidates} candidates, ${counts.owed} owed, ${counts.recovered} recovered`;
}

/**
 * The helper's request for one channel: system = `prompt` (`{{name}}` filled), user = the
 * channel's transcript from LINES_BEFORE lines before the earliest candidate on (the persona's
 * lines naming the message that started their turn, through `triggerOf`), then a
 * `<candidates>` block, one line per candidate: `<n>: #<line> <reason>`. Null without a prompt
 * or without a candidate shown in `history`. `candidates` keeps those it numbered, in order.
 * @param {{ prompt: string|undefined, labels: object, config: object, selfName: string, history: object[],
 *   candidates: object[], triggerOf?: (id: string) => string|null, now: number }} input
 * @returns {{ system: string, user: string, candidates: object[] }|null}
 */
export function buildCheckRequest({ prompt, labels, config, selfName, history, candidates, triggerOf, now }) {
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
    gapMinutes: config.context?.gapMarkerMinutes,
    maxChars: config.context?.maxMessageChars,
    selfName,
    labels,
    seeReactions: false,
    replyQuoteChars: config.context?.replyQuoteChars,
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

/**
 * The registry, its sweeps and its recovery turns.
 *
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot  Read at the moment of use.
 * @param {{ state: { data: object } }} deps.store  Only `state.data.paused` is read.
 * @param {object|null} [deps.journal]  src/memory/journal.js: `answer` records written while
 *   features.journal is exactly true; `read` at start for the reconciliation.
 * @param {{ complete: Function }|null} [deps.llm]  The helper's client; absent, every check is `unchecked`.
 * @param {object} deps.turns  The turn runner: `runTurn`, `triggerOf`, `lastPostAt`, `isBusy`, `isAnyBusy`.
 * @param {import('../interface/reads.ts').Reads} deps.reads  The core's reads of the interface.
 * @param {() => string} [deps.iface]  The interface the conversations belong to (from `hello`).
 * @param {(conversationId: string) => string|null} [deps.partnerOf]  The other member of a private chat.
 * @param {() => string|null} deps.getGuildId
 * @param {(guildId: string) => string} [deps.getSelfName]
 * @param {string} deps.dataDir  `data/`.
 * @param {object} [deps.fs]  node:fs/promises-shaped.
 * @param {() => number} [deps.now]
 * @param {{ set: (fn: () => void, ms: number) => any, clear: (timer: any) => void }} [deps.timers]
 * @param {object} [deps.log]
 * @returns {{ start: (guildId: string) => Promise<void>, noteFact: (fact: object) => void,
 *   onTurnEnd: (end: object) => void, noteActivity: (channelId: string, at?: number) => void,
 *   sweep: (channelId: string) => Promise<void>, save: () => Promise<void>, stop: () => void,
 *   candidates: () => object[] }}
 */
export function createMissed({
  hot,
  store,
  journal = null,
  llm = null,
  turns,
  reads,
  iface = () => '',
  partnerOf: partnerOfConversation = () => null,
  getGuildId,
  getSelfName = () => 'bot',
  dataDir,
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
}) {
  let candidates = [];
  let privateRecovery = null;
  let lastRecoveryAt = {};
  let loadedGuildId = null;
  let dirty = false;
  let chain = Promise.resolve();
  let promptMissingLogged = false;
  const sweeps = new Map(); // channelId -> { firstAt, lastAt, timer }
  const sweeping = new Set();

  const enabled = () => hot.config.features?.missedAnswers !== false;
  const recoveryOn = () => hot.config.features?.missedRecovery === true;
  const paused = () => Boolean(store?.state?.data?.paused);
  const journalOn = () =>
    Boolean(journal) && typeof journal.answer === 'function' && hot.config.features?.journal === true;
  const fileOf = (guildId) => path.join(dataDir, 'guilds', String(guildId), 'missed.json');
  const iso = (ms) => new Date(ms).toISOString();

  /** The person a private chat belongs to, null for a server channel (or one not known). */
  function partnerOf(channelId) {
    const id = partnerOfConversation(String(channelId));
    return typeof id === 'string' && id ? id : null;
  }

  /** One `answer` record (features.journal on), a private chat's in that person's private journal; never throws. */
  function record(fields) {
    const guildId = getGuildId?.();
    if (!guildId || !journalOn()) return;
    const partner = fields?.channelId ? partnerOf(fields.channelId) : null;
    Promise.resolve()
      .then(() => journal.answer(guildId, partner ? { ...fields, privateUserId: partner } : fields))
      .catch((error) => log.warn('missed: journal failed', { code: error?.code ?? null }));
  }

  /** Write the registry (not while paused: the owner may be editing data/; it is written later). */
  function save() {
    dirty = true;
    const guildId = loadedGuildId ?? getGuildId?.();
    if (!guildId || paused()) return chain;
    const run = chain.then(async () => {
      if (!dirty) return;
      dirty = false;
      candidates = pruneCandidates(candidates, now());
      const file = fileOf(guildId);
      const text = JSON.stringify({ v: FILE_VERSION, candidates, lastRecoveryAt });
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(`${file}.tmp`, text);
        await fs.rename(`${file}.tmp`, file);
      } catch (error) {
        dirty = true;
        log.warn('missed: save failed', { code: error?.code ?? null });
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  /** Read the registry; a missing file is an empty one, a broken one is moved aside, never overwritten. */
  async function load(guildId) {
    const file = fileOf(guildId);
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn('missed: load failed', { code: error?.code ?? null });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      candidates = Array.isArray(parsed?.candidates)
        ? parsed.candidates.filter((candidate) => candidate && typeof candidate.messageId === 'string')
        : [];
      lastRecoveryAt =
        parsed?.lastRecoveryAt && typeof parsed.lastRecoveryAt === 'object' ? { ...parsed.lastRecoveryAt } : {};
    } catch {
      log.warn('missed: file unreadable, moved aside', { guildId: String(guildId) });
      await fs.rename(file, `${file}.bad-${now()}`).catch(() => {});
    }
  }

  /** The journal's records of the last hour (the days it spans), oldest first. */
  async function recentRecords(guildId) {
    if (typeof journal?.read !== 'function') return [];
    const at = now();
    const days = [...new Set([utcDay(at - RECONCILE_WINDOW_MS), utcDay(at)])];
    const out = [];
    for (const day of days) out.push(...(await journal.read(guildId, { day, n: Number.MAX_SAFE_INTEGER })));
    return out;
  }

  /**
   * At start: the registry loaded, reconciled with the journal of the last hour (features.journal
   * on), pruned and written; a sweep armed in every channel with a pending candidate.
   */
  async function start(guildId) {
    loadedGuildId = guildId;
    await load(guildId);
    if (hot.config.features?.journal === true) {
      try {
        const result = reconcileFromRecords(candidates, await recentRecords(guildId), {
          now: now(),
          recovery: recoveryOn(),
        });
        candidates = result.list;
        log.info('missed: reconciled', { guildId: String(guildId), added: result.added, closed: result.closed });
      } catch (error) {
        log.warn('missed: reconcile failed', { code: error?.code ?? null });
      }
    }
    candidates = pruneCandidates(candidates, now());
    await save();
    if (!enabled()) return;
    for (const channelId of new Set(
      candidates.filter((candidate) => candidate.state === 'pending').map((candidate) => candidate.channelId)
    ))
      arm(channelId);
  }

  /** (Re)schedule a channel's sweep at sweepDueAt, never before its `notBefore` (a held recovery). */
  function schedule(channelId, entry) {
    if (entry.timer) timers.clear(entry.timer);
    const due = Math.max(entry.notBefore ?? 0, sweepDueAt(entry, missedSettings(hot.config)));
    const wait = Math.max(0, due - now());
    // The sweep's promise is returned (never rejects) for a caller that waits on the timer.
    entry.timer = timers.set(() => {
      sweeps.delete(channelId);
      return sweep(channelId).catch((error) => log.error('missed: sweep failed', { channelId, error }));
    }, wait);
  }

  /** A candidate event in `channelId`: its sweep armed, or pushed back. */
  function arm(channelId, at = now()) {
    const entry = sweeps.get(channelId);
    if (entry) {
      entry.lastAt = at;
      schedule(channelId, entry);
      return;
    }
    const fresh = { firstAt: at, lastAt: at, notBefore: null, timer: null };
    sweeps.set(channelId, fresh);
    schedule(channelId, fresh);
  }

  /** A message in `channelId`: an armed sweep waits for the talk to settle (never past its cap). */
  function noteActivity(channelId, at = now()) {
    const entry = sweeps.get(channelId);
    if (!entry) return;
    entry.lastAt = Math.max(entry.lastAt, Number.isFinite(at) ? at : now());
    schedule(channelId, entry);
  }

  /**
   * The address helper's "no" on a normalized message: one `answer` record (`event` `address`,
   * `verdict` `not-addressed`; ids and time, never the text) for the heartbeat view's list of
   * what was filtered without her. Not a candidate. Never throws.
   */
  function noteNotAddressed(message) {
    try {
      if (!message?.id || !message.channelId) return;
      const at = Number.isFinite(message.ts) ? message.ts : now();
      record({
        event: 'address',
        verdict: 'not-addressed',
        messageId: message.id,
        authorId: message.authorId ?? null,
        channelId: message.channelId,
        at: iso(at),
        participants: message.authorId ? [message.authorId] : [],
      });
    } catch (error) {
      log.warn('missed: address verdict failed', { code: error?.code ?? null });
    }
  }

  /**
   * One fact: `{ reason, message, replacedBy?, failure?, turnId? }`, `message` a normalized
   * message (its id, channel, author, time and -- for isQuestion only -- its text). Journaled,
   * added to the registry, its channel's sweep armed. Never throws.
   */
  function noteFact({ reason, message, replacedBy = null, failure = null, turnId = null } = {}) {
    try {
      if (!enabled() || !MISSED_REASONS.includes(reason) || !message?.id || !message.channelId) return;
      const at = Number.isFinite(message.ts) ? message.ts : now();
      const authorId = message.authorId ?? null;
      const question = isQuestion(message.content);
      record({
        event: 'fact',
        reason,
        messageId: message.id,
        authorId,
        channelId: message.channelId,
        at: iso(at),
        question,
        ...(replacedBy ? { replacedBy } : {}),
        ...(failure ? { failure } : {}),
        ...(turnId ? { turnId } : {}),
        participants: authorId ? [authorId] : [],
        sourceMessageIds: [message.id, ...(replacedBy ? [replacedBy] : [])],
      });
      const result = addCandidate(
        candidates,
        { messageId: message.id, channelId: message.channelId, authorId, at, reason, question, turnId },
        { now: now() }
      );
      candidates = result.list;
      log.info('missed: candidate', {
        channelId: message.channelId,
        messageId: message.id,
        reason,
        added: result.added,
      });
      save();
      if (result.candidate && isOpen(result.candidate)) arm(message.channelId);
    } catch (error) {
      log.warn('missed: fact failed', { reason, error });
    }
  }

  /** Close what a turn's end resolved: journaled `resolved`, logged. */
  function noteResolved(resolved, turnId = null) {
    for (const { messageId, channelId, by } of resolved) {
      record({
        event: 'resolved',
        messageId,
        channelId,
        by,
        ...(turnId ? { turnId } : {}),
        sourceMessageIds: [messageId],
      });
      log.info('missed: resolved', { channelId, messageId, by });
    }
  }

  /**
   * A turn ended (src/behavior/turn.js#setOnTurnEnd): what it answered is resolved; a failed
   * turn of a call (`error`, `not-now`) is a fact about its trigger -- a `turn-error` one carries
   * the turn's reason (e.g. `cut-off`) as its `failure`. A private chat's failed turn is one like
   * any other, kept in that chat; routed calls, overheard lines and the recovery turns themselves
   * make no candidate. Never throws.
   */
  function onTurnEnd(end) {
    try {
      if (!enabled() || !end || !end.channelId) return;
      const trigger = end.trigger ?? null;
      const at = now();
      const result = resolveByTurn(candidates, {
        channelId: end.channelId,
        triggerId: trigger?.id ?? null,
        triggerAuthorId: trigger?.authorId ?? null,
        triggerAt: Number.isFinite(trigger?.ts) ? trigger.ts : null,
        outcome: end.outcome,
        replyTargets: end.replyTargets,
        turnId: end.turnId ?? null,
        at,
      });
      if (result.resolved.length > 0) {
        candidates = result.list;
        noteResolved(result.resolved, end.turnId ?? null);
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
          message: { ...trigger, channelId: trigger.channelId ?? end.channelId },
          turnId: end.turnId ?? null,
          failure,
        });
    } catch (error) {
      log.warn('missed: turn end failed', { error });
    }
  }

  /** Close `candidate` with `state` (and `patch`), journaled as `event`. */
  function close(candidate, state, event, fields = {}, patch = {}) {
    const result = patchOpen(candidates, candidate.messageId, { state, updatedAt: now(), ...patch });
    candidates = result.list;
    record({
      event,
      messageId: candidate.messageId,
      channelId: candidate.channelId,
      reason: candidate.reason,
      ...fields,
      sourceMessageIds: [candidate.messageId],
    });
  }

  /** Journal one verdict and put the candidate in the state it leaves. */
  function applyVerdict(candidate, verdict, by) {
    const recovery = recoveryOn();
    const state = stateForVerdict(verdict, recovery);
    const result = patchOpen(candidates, candidate.messageId, { verdict, checkedAt: now(), state, updatedAt: now() });
    candidates = result.list;
    record({
      event: 'verdict',
      messageId: candidate.messageId,
      authorId: candidate.authorId,
      channelId: candidate.channelId,
      reason: candidate.reason,
      verdict,
      by,
      shadow: verdict === 'owed' && !recovery,
      participants: candidate.authorId ? [candidate.authorId] : [],
      sourceMessageIds: [candidate.messageId],
    });
    log.info('missed: verdict', {
      channelId: candidate.channelId,
      messageId: candidate.messageId,
      reason: candidate.reason,
      verdict,
      by,
    });
    return result.changed;
  }

  /** The conversation `channelId` as the interface describes it now (permissions and all), or null when it does not. */
  async function channelOf(channelId) {
    return (await reads.conversationInfo({ iface: iface(), conversationId: String(channelId) }))?.conversation ?? null;
  }

  /** The helper's verdicts for `list` (one call), each `unchecked` when it fails. */
  async function classify(list, { channel, history, config }) {
    const unchecked = () => list.map(() => UNCHECKED);
    const prompts = hot.prompts;
    const guildId = channel.communityId ?? getGuildId?.();
    const request = buildCheckRequest({
      prompt: prompts?.missed,
      labels: prompts?.labels,
      config,
      selfName: getSelfName(guildId),
      history,
      candidates: list,
      triggerOf: typeof turns?.triggerOf === 'function' ? (id) => turns.triggerOf(id) : null,
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
    const settings = missedSettings(config);
    try {
      const completion = await llm.complete(
        [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        {
          model: roleModel(config, 'analyzer', 'missed'),
          ...helperRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: settings.maxOutputTokens,
            purpose: 'missed',
          }),
        }
      );
      const { verdicts, empty } = parseMissedAnswer(completion?.text, request.candidates.length);
      if (empty) log.warn('missed: helper failed', { channelId: channel.id, reason: 'empty' });
      const byId = new Map(request.candidates.map((candidate, i) => [candidate.messageId, verdicts[i]]));
      return list.map((candidate) => byId.get(candidate.messageId) ?? UNCHECKED);
    } catch (error) {
      log.warn('missed: helper failed', { channelId: channel.id, error });
      return unchecked();
    }
  }

  /**
   * One channel's sweep (the timer's, or a test's): the code's filter (sweepPlan), the helper
   * for what is left, then a recovery turn for the owed ones (features.missedRecovery) or, in
   * shadow mode, nothing posted. Skipped while paused.
   */
  async function sweep(channelId) {
    if (!enabled()) return;
    if (paused()) {
      log.info('missed: sweep skipped', { channelId, reason: 'paused' });
      return;
    }
    if (sweeping.has(channelId)) {
      arm(channelId);
      return;
    }
    if (!candidates.some((candidate) => candidate.channelId === channelId && candidate.state === 'pending')) return;
    sweeping.add(channelId);
    try {
      const config = hot.config;
      const settings = missedSettings(config);
      const channel = await channelOf(channelId);
      let history = null;
      if (channel) {
        try {
          history = await historyLines(
            reads,
            { iface: channel.iface, conversationId: channel.id },
            { limit: Math.max(1, Math.floor(settings.contextMessages)) }
          );
        } catch (error) {
          log.warn('missed: history fetch failed', { channelId, error });
        }
      }
      if (!Array.isArray(history)) {
        for (const candidate of candidates.filter(
          (entry) => entry.channelId === channelId && entry.state === 'pending'
        ))
          applyVerdict(candidate, UNCHECKED, 'code');
        await save();
        return;
      }
      const triggerOf = typeof turns?.triggerOf === 'function' ? (id) => turns.triggerOf(id) : null;
      const plan = sweepPlan(candidates, channelId, { now: now(), settings, history, triggerOf });
      for (const candidate of plan.expired) {
        close(candidate, 'expired', 'expired');
        log.info('missed: expired', { channelId, messageId: candidate.messageId, reason: candidate.reason });
      }
      for (const { candidate, by } of plan.resolved) {
        close(candidate, 'resolved', 'resolved', { by });
        log.info('missed: resolved', { channelId, messageId: candidate.messageId, by });
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
      sweeping.delete(channelId);
    }
  }

  /** Whether a turn would find the attention taken in `channelId` now (the rule runTurn applies). */
  function attentionTaken(channelId) {
    if (typeof turns?.isBusy === 'function' && turns.isBusy(channelId)) return true;
    return hot.config.mention?.oneAtATime !== false && typeof turns?.isAnyBusy === 'function' && turns.isAnyBusy();
  }

  /** Hold the owed candidates of a channel for a later sweep, `waitMs` from now at the earliest. */
  function holdFor(channelId, waitMs) {
    const at = now();
    const entry = sweeps.get(channelId) ?? { firstAt: at, lastAt: at, notBefore: null, timer: null };
    entry.notBefore = at + Math.max(0, waitMs);
    sweeps.set(channelId, entry);
    schedule(channelId, entry);
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
  async function recover(channel, owed, history) {
    const channelId = channel.id;
    const config = hot.config;
    const settings = missedSettings(config);
    if (paused()) return;
    const list = [...owed].sort((a, b) => a.at - b.at);
    if (!channel.permissions.send) {
      finishRecovery(channelId, list, { outcome: 'cannot-send' }, null);
      await save();
      return;
    }
    const cooldownMs = settings.channelCooldownMinutes * MINUTE_MS;
    const last = lastRecoveryAt[channelId];
    if (Number.isFinite(last) && now() - last < cooldownMs) {
      log.info('missed: recovery held', { channelId, reason: 'cooldown', candidates: list.length });
      holdFor(channelId, last + cooldownMs - now());
      return;
    }
    if (attentionTaken(channelId)) {
      log.info('missed: recovery held', { channelId, reason: 'busy', candidates: list.length });
      holdFor(channelId, settings.sweepDelaySeconds * 1000);
      return;
    }
    const byId = new Map(history.map((message) => [message.id, message]));
    const shown = list.filter((candidate) => byId.has(candidate.messageId));
    if (shown.length === 0) return;
    const trigger = byId.get(shown[0].messageId);
    const ids = shown.map((candidate) => candidate.messageId);
    // A private chat is recovered only where the private-chat gate lets the person through (their daily cap counts the turn).
    const isPrivate = channel.communityId === null;
    if (
      isPrivate &&
      !(
        typeof privateRecovery?.allow === 'function' &&
        (await privateRecovery.allow(channel, trigger).catch(() => false))
      )
    ) {
      log.info('missed: recovery refused', { channelId, reason: 'private-gate', candidates: ids.length });
      finishRecovery(channelId, shown, { outcome: 'private-gate' }, trigger.id);
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
    lastRecoveryAt = { ...lastRecoveryAt, [channelId]: startedAt };
    await save();
    const maxChars = config.context?.maxMessageChars ?? 2000;
    const missedItems = shown.map((candidate) => {
      const message = byId.get(candidate.messageId);
      return {
        id: candidate.messageId,
        author: oneLine(message.authorName ?? ''),
        text: clampChars(oneLine(message.content ?? ''), maxChars),
      };
    });
    const stillDue = () => {
      const lastPost = typeof turns?.lastPostAt === 'function' ? turns.lastPostAt(channelId) : 0;
      if (Number.isFinite(lastPost) && lastPost > startedAt) return false;
      return ids.every((id) => candidates.find((candidate) => candidate.messageId === id)?.state === 'in_progress');
    };
    log.info('missed: recovery', { channelId, candidates: ids.length, trigger: trigger.id });
    let result;
    try {
      result = await turns.runTurn({
        conversation: { iface: channel.iface, conversationId: channel.id },
        ...(isPrivate ? { guildId: getGuildId?.() } : {}),
        mode: 'reply',
        trigger,
        triggerKind: 'missed',
        missed: missedItems,
        stillDue,
      });
    } catch (error) {
      log.error('missed: recovery failed', { channelId, error });
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
      const { [channelId]: _ours, ...others } = lastRecoveryAt;
      lastRecoveryAt = Number.isFinite(last) ? { ...others, [channelId]: last } : others;
      holdFor(channelId, settings.sweepDelaySeconds * 1000);
      await save();
      return;
    }
    finishRecovery(channelId, shown, result ?? { outcome }, trigger.id);
    if (isPrivate)
      await Promise.resolve(privateRecovery.after?.(channel, trigger, result ?? { outcome })).catch((error) =>
        log.warn('missed: private recovery count failed', { error })
      );
    await save();
  }

  /**
   * Close the candidates of one recovery (`list`): `resolved` when its turn spoke or chose
   * silence, else `dismissed` (one attempt each); one `recovery` record with the outcome.
   */
  function finishRecovery(channelId, list, result, triggerId) {
    const outcome = result?.outcome ?? 'error';
    const done = outcome === 'spoke' || outcome === 'skip';
    const ids = list.map((candidate) => candidate.messageId);
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
      channelId,
      messageIds: ids,
      triggerId,
      outcome,
      ...(typeof result?.reason === 'string' ? { reason: result.reason } : {}),
      ...(result?.dryRun === true ? { dryRun: true } : {}),
      participants: [...new Set(list.map((candidate) => candidate.authorId).filter(Boolean))],
      sourceMessageIds: ids,
    });
    log.info('missed: recovered', { channelId, candidates: ids.length, outcome });
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
    setPrivateRecovery: (hooks) => {
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
