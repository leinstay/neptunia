// The persona's intentions as data (docs/intentions.md): what she means to do later, set by her
// own call (`intent.set`, provenance `self`, born `pending`) or proposed by the memory analyzer
// from one of her own lines (provenance `candidate`, born `proposed`, never active until she
// accepts it). Pure: every function takes the record and the clock (`now`, epoch ms) and answers
// a new record, never mutating its input; the store (src/intentions/store.js) persists them.
//
// Statuses: `proposed` -> `pending` (accepted) | `cancelled` (rejected) | `expired`;
// `pending` -> `waiting` | `done` | `cancelled` | `expired`; `waiting` -> `pending` (the awaited
// errand ended, or its wait deadline passed, or the errand is gone) | `done` | `cancelled` |
// `expired`. `done`, `cancelled` and `expired` are terminal: nothing moves out of them. The
// invariants every record keeps (checkInvariants): an `expiresAt` (every intention ends), and a
// `waiting` one has both `awaitingTaskId` and `waitDeadline` -- there is no wait without a real
// errand and a deadline. Expiry comes from the clock (expireAt); `dueList` lists what is due for
// the scheduler of step 2 (listing, not choosing). Codes are kebab-case; no wording here.

import { randomUUID } from 'node:crypto';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../time.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { isWordChar, occursAsWholeWord } from '../memory/mentions.js';
import { foldText as foldName } from '../memory/recent.js';
import { externalOrigin } from './sources.js';

/** Every status an intention may have. */
export const STATUSES = Object.freeze(['proposed', 'pending', 'waiting', 'done', 'cancelled', 'expired']);
/** The statuses nothing moves out of. */
export const TERMINAL = Object.freeze(['done', 'cancelled', 'expired']);
/** The statuses of an intention still open. */
export const OPEN = Object.freeze(['proposed', 'pending', 'waiting']);
/** Where an intention came from. */
export const PROVENANCE_KINDS = Object.freeze(['self', 'candidate']);

/** The moves each status allows. */
const MOVES = Object.freeze({
  proposed: ['pending', 'cancelled', 'expired'],
  pending: ['waiting', 'done', 'cancelled', 'expired'],
  waiting: ['pending', 'done', 'cancelled', 'expired'],
  done: [],
  cancelled: [],
  expired: [],
});

/** The defaults of the `intentions` config section (config.json carries the same). */
export const DEFAULTS = Object.freeze({ expiresDays: 14, maxOpen: 20, maxCandidates: 5, candidateExpiresHours: 48, waitHours: 2 });
/** A purpose's length (characters). */
export const PURPOSE_CHARS = 300;
/** A quoted span's length (characters). */
export const SPAN_CHARS = 300;
/** A completion condition's length (characters). */
export const CONDITION_CHARS = 300;
/** A chain id's length (characters). */
export const CHAIN_CHARS = 64;
/** The history entries a record keeps (the oldest dropped). */
export const HISTORY_MAX = 20;
/** The members of the conversation a record's provenance keeps. */
export const PARTICIPANTS_MAX = 20;
/** A name shorter than this (in letters and digits) is never matched by a forget. */
const MIN_FORGET_NAME = 3;

/** The `intentions` section's numbers, read from the live config now, each falling back to DEFAULTS. */
export function intentionSettings(config) {
  const set = config?.intentions ?? {};
  const pick = (key) => (Number.isFinite(set[key]) && set[key] >= 0 ? set[key] : DEFAULTS[key]);
  return { expiresDays: pick('expiresDays'), maxOpen: pick('maxOpen'), maxCandidates: pick('maxCandidates'), candidateExpiresHours: pick('candidateExpiresHours'), waitHours: pick('waitHours') };
}

/** Whether `features.intentions` is exactly true (a missing key counts as off). */
export function intentionsOn(config) {
  return config?.features?.intentions === true;
}

/** True for a status nothing moves out of. */
export function isTerminal(status) {
  return TERMINAL.includes(status);
}

/** True for an open status. */
export function isOpen(status) {
  return OPEN.includes(status);
}

/** A fresh intention id (`i` + 8 hex characters). */
export function newIntentionId(uuid = randomUUID) {
  return `i${uuid().replace(/-/g, '').slice(0, 8)}`;
}

const RELATIVE_RE = /^(\d{1,5})\s*(m|min|h|d)$/i;

/**
 * A moment given as text, as epoch ms: a relative `<n>m`, `<n>h` or `<n>d` from `now`, or an
 * ISO 8601 date or date-time. Null for anything else (and for an empty text).
 * @param {unknown} text
 * @param {number} now
 * @returns {number|null}
 */
export function parseWhen(text, now) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const relative = RELATIVE_RE.exec(value);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    return now + n * (unit === 'd' ? DAY_MS : unit === 'h' ? HOUR_MS : MINUTE_MS);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** One line of text cut to `max` characters; '' for nothing. */
function line(text, max) {
  return clampChars(oneLine(typeof text === 'string' ? text : ''), max);
}

/** A string id or null. */
function idOrNull(value) {
  return (typeof value === 'string' && value) || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
}

/** The distinct non-empty string ids of `list`, at most PARTICIPANTS_MAX. */
function participantIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && id))].slice(0, PARTICIPANTS_MAX);
}

/**
 * The invariant `record` breaks, as a code, or null: `bad-status`, `no-purpose`, `no-expiry`,
 * `wait-without-task`, `wait-without-deadline`.
 * @param {object} record
 * @returns {string|null}
 */
export function checkInvariants(record) {
  if (!record || !STATUSES.includes(record.status)) return 'bad-status';
  if (typeof record.purpose !== 'string' || !record.purpose) return 'no-purpose';
  if (!Number.isFinite(record.expiresAt)) return 'no-expiry';
  if (record.status === 'waiting') {
    if (typeof record.awaitingTaskId !== 'string' || !record.awaitingTaskId) return 'wait-without-task';
    if (!Number.isFinite(record.waitDeadline)) return 'wait-without-deadline';
  }
  return null;
}

/** `record` with one more history entry (the oldest dropped past HISTORY_MAX). */
function withHistory(record, entry) {
  const history = [...(Array.isArray(record.history) ? record.history : []), entry];
  return { ...record, history: history.slice(-HISTORY_MAX) };
}

/**
 * A new intention: `{ ok: true, intention }` or `{ ok: false, code }` (`no-purpose`,
 * `bad-provenance`, `bad-due`, `bad-expiry`, `due-after-expiry`). Her own (`provenance.kind`
 * `self`) is `pending`; a candidate is `proposed` and expires after `candidateExpiresHours`
 * unless `expiresAt` says otherwise; her own after `expiresDays`.
 * `provenance.participants` (member ids) names the members of the conversation it came from: who
 * asked, who was answered or mentioned, the other authors of a candidate's channel; a forget of
 * one of them takes the intention out (concernsMember).
 * @param {{ purpose: string, provenance: { kind: string, turnId?: string|null, messageId?: string|null, channelId?: string|null, span?: string|null, scope?: 'dm'|'group', participants?: string[] },
 *   dueAt?: number|null, expiresAt?: number|null, destination?: string|null, completionCondition?: string|null, chainId?: string|null,
 *   now: number, settings?: object, id?: string, by?: string }} input
 */
export function createIntention({ purpose, provenance, dueAt = null, expiresAt = null, destination = null, completionCondition = null, chainId = null, now, settings = DEFAULTS, id = newIntentionId(), by = 'persona' }) {
  const text = line(purpose, PURPOSE_CHARS);
  if (!text) return { ok: false, code: 'no-purpose' };
  if (!PROVENANCE_KINDS.includes(provenance?.kind)) return { ok: false, code: 'bad-provenance' };
  const candidate = provenance.kind === 'candidate';
  if (dueAt !== null && !Number.isFinite(dueAt)) return { ok: false, code: 'bad-due' };
  const defaultExpiry = candidate ? now + settings.candidateExpiresHours * HOUR_MS : now + settings.expiresDays * DAY_MS;
  const expires = expiresAt === null || expiresAt === undefined ? defaultExpiry : expiresAt;
  if (!Number.isFinite(expires) || expires <= now) return { ok: false, code: 'bad-expiry' };
  if (dueAt !== null && dueAt > expires) return { ok: false, code: 'due-after-expiry' };
  const span = line(provenance.span, SPAN_CHARS);
  const participants = participantIds(provenance.participants);
  const status = candidate ? 'proposed' : 'pending';
  const intention = {
    id,
    purpose: text,
    provenance: {
      kind: provenance.kind,
      turnId: idOrNull(provenance.turnId),
      ...(idOrNull(provenance.messageId) ? { messageId: idOrNull(provenance.messageId) } : {}),
      ...(idOrNull(provenance.channelId) ? { channelId: idOrNull(provenance.channelId) } : {}),
      ...(span ? { span } : {}),
      scope: provenance.scope === 'dm' ? 'dm' : 'group',
      ...(participants.length > 0 ? { participants } : {}),
      // A candidate's origin (candidatesFromAnswer): `external` when its words came from outside
      // material, which only her explicit accept in a later ordinary turn activates (acceptRefusal).
      ...(candidate ? { origin: provenance.origin === 'external' ? 'external' : 'own' } : {}),
      ...(candidate && provenance.origin === 'external' && typeof provenance.originReason === 'string' ? { originReason: provenance.originReason } : {}),
      ...(candidate && provenance.bornInner === true ? { bornInner: true, ...(line(provenance.innerChainId, CHAIN_CHARS + 16) ? { innerChainId: line(provenance.innerChainId, CHAIN_CHARS + 16) } : {}) } : {}),
    },
    status,
    createdAt: now,
    updatedAt: now,
    dueAt: dueAt ?? null,
    expiresAt: expires,
    awaitingTaskId: null,
    waitDeadline: null,
    destination: idOrNull(destination),
    completionCondition: line(completionCondition, CONDITION_CHARS) || null,
    chainId: line(chainId, CHAIN_CHARS) || null,
    history: [{ at: now, to: status, by }],
  };
  return { ok: true, intention };
}

/**
 * Why the persona may not accept candidate `record` (move it `proposed` -> `pending`) from where her
 * call comes, or null: `candidate-same-turn` (the turn that wrote the line it came from: an accept
 * comes in a later turn), and from an inner turn (`initiative`) `candidate-external` (its words came
 * from outside material: only an ordinary turn of hers accepts it) and `candidate-same-chain` (it
 * was born in an inner turn of the very chain asking). An owner's command (`by` not `persona`) is
 * never refused here. Pure.
 * @param {object} record
 * @param {{ by?: string, initiative?: boolean, chainId?: string|null, turnId?: string|null }} caller
 * @returns {'candidate-same-turn'|'candidate-external'|'candidate-same-chain'|null}
 */
export function acceptRefusal(record, { by = 'persona', initiative = false, chainId = null, turnId = null } = {}) {
  if (record?.status !== 'proposed' || by !== 'persona') return null;
  const provenance = record.provenance ?? {};
  if (turnId && provenance.turnId && String(provenance.turnId) === String(turnId)) return 'candidate-same-turn';
  if (!initiative) return null;
  if (provenance.origin === 'external') return 'candidate-external';
  if (provenance.bornInner === true && chainId && provenance.innerChainId === String(chainId)) return 'candidate-same-chain';
  return null;
}

/**
 * `record` moved to `to`: `{ ok: true, intention, changed: true }`, or `{ ok: false, code }`
 * (`terminal` out of a terminal status, `bad-move` for a move its status does not allow, or the
 * invariant the result would break). `patch` sets fields along with the move (a wait's task and
 * deadline, an outcome, a note); `by` and `code` go to the history entry.
 * @param {object} record
 * @param {string} to
 * @param {{ now: number, by?: string, code?: string|null, patch?: object }} options
 */
export function transition(record, to, { now, by = 'persona', code = null, patch = {} }) {
  if (isTerminal(record?.status)) return { ok: false, code: 'terminal' };
  if (!MOVES[record?.status]?.includes(to)) return { ok: false, code: 'bad-move' };
  const leavingWait = record.status === 'waiting' && to !== 'waiting';
  let next = { ...record, ...patch, status: to, updatedAt: now };
  // Out of a wait the errand stays named in `outcome`/`lastTaskId`, never as an open wait.
  if (leavingWait) next = { ...next, awaitingTaskId: null, waitDeadline: null, lastTaskId: record.awaitingTaskId ?? null };
  const broken = checkInvariants(next);
  if (broken) return { ok: false, code: broken };
  next = withHistory(next, { at: now, from: record.status, to, by, ...(code ? { code } : {}) });
  return { ok: true, intention: next, changed: true };
}

/**
 * `record` set waiting on errand `taskId` until `deadline` (epoch ms, after `now`): from `pending`,
 * or from `waiting` on another errand (the wait moves to the new one). `{ ok: false, code }`:
 * `wait-without-task`, `bad-deadline`, or transition's codes.
 */
export function waitOn(record, { taskId, deadline, now, by = 'persona' }) {
  const id = idOrNull(taskId);
  if (!id) return { ok: false, code: 'wait-without-task' };
  if (!Number.isFinite(deadline) || deadline <= now) return { ok: false, code: 'bad-deadline' };
  const patch = { awaitingTaskId: id, waitDeadline: deadline, waitRequested: null };
  if (record?.status === 'waiting') {
    const next = { ...record, ...patch, updatedAt: now };
    return { ok: true, intention: withHistory(next, { at: now, from: 'waiting', to: 'waiting', by, code: 'rewait' }), changed: true };
  }
  return transition(record, 'waiting', { now, by, code: 'wait', patch });
}

/** The terminal task states (src/errands/store.js#TASK_STATES less the open ones). */
const TASK_ENDS = Object.freeze(['done', 'failed', 'cancelled']);

/**
 * The end of errand `task` reaching `record`: a `waiting` record awaiting that very task moves to
 * `pending` with `outcome: { taskId, state, error?, at }` (`code` `task-<state>`). Anything else
 * -- another task, a record no longer waiting (the same end delivered twice), a task still open
 * -- changes nothing: `{ ok: true, intention: record, changed: false }`.
 */
export function arrive(record, task, { now }) {
  if (record?.status !== 'waiting' || !task || record.awaitingTaskId !== String(task.id) || !TASK_ENDS.includes(task.state)) {
    return { ok: true, intention: record, changed: false };
  }
  const outcome = { taskId: String(task.id), state: task.state, ...(task.error ? { error: String(task.error) } : {}), at: Number.isFinite(task.endedAt) ? task.endedAt : now };
  return transition(record, 'pending', { now, by: 'engine', code: `task-${task.state}`, patch: { outcome, note: `task-${task.state}` } });
}

/** `record` expired when it is open and `now` is at or past its `expiresAt`; unchanged otherwise. */
export function expireAt(record, now) {
  if (!isOpen(record?.status) || !(now >= record.expiresAt)) return { ok: true, intention: record, changed: false };
  return transition(record, 'expired', { now, by: 'engine', code: 'expired' });
}

/**
 * One `waiting` record reconciled against the task store (`taskOf(id)`: the task, or null when
 * the store has none): the task gone -> `pending` with note `task-missing`; the task ended ->
 * as `arrive`; the wait deadline passed -> `pending` with note `wait-deadline`; else unchanged.
 */
export function reconcileWait(record, { taskOf, now }) {
  if (record?.status !== 'waiting') return { ok: true, intention: record, changed: false };
  const task = typeof taskOf === 'function' ? taskOf(record.awaitingTaskId) : null;
  if (!task) return transition(record, 'pending', { now, by: 'engine', code: 'task-missing', patch: { note: 'task-missing' } });
  if (TASK_ENDS.includes(task.state)) return arrive(record, task, { now });
  if (now >= record.waitDeadline) return transition(record, 'pending', { now, by: 'engine', code: 'wait-deadline', patch: { note: 'wait-deadline' } });
  return { ok: true, intention: record, changed: false };
}

/**
 * What is due at `now`, for the scheduler of step 2 (listing, not choosing): every `pending` or
 * `waiting` record whose `dueAt` is at or before `now` (`reason: 'due'`), and every `waiting` one
 * past its `waitDeadline` (`reason: 'wait-deadline'`), the earliest moment first. A proposed
 * candidate is never due: it wakes nobody.
 * @param {object[]} records
 * @param {number} now
 * @returns {{ intention: object, reason: 'due'|'wait-deadline', at: number }[]}
 */
export function dueList(records, now) {
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.status !== 'pending' && record?.status !== 'waiting') continue;
    if (record.status === 'waiting' && Number.isFinite(record.waitDeadline) && record.waitDeadline <= now) out.push({ intention: record, reason: 'wait-deadline', at: record.waitDeadline });
    else if (Number.isFinite(record.dueAt) && record.dueAt <= now) out.push({ intention: record, reason: 'due', at: record.dueAt });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Lower-cased, whitespace folded: how two texts are compared. */
export function foldText(text) {
  return oneLine(String(text ?? '')).toLowerCase();
}

/**
 * Whether candidate `candidate` (`{ purpose, messageId, span }`) repeats one of `records`' open
 * intentions: the same message and span, or the same purpose (folded).
 */
export function duplicates(candidate, records) {
  const purpose = foldText(candidate?.purpose);
  const span = foldText(candidate?.span);
  return (Array.isArray(records) ? records : []).some((record) => {
    if (!isOpen(record?.status)) return false;
    if (purpose && foldText(record.purpose) === purpose) return true;
    return Boolean(candidate?.messageId) && record.provenance?.messageId === candidate.messageId && span && foldText(record.provenance?.span) === span;
  });
}

/**
 * The intention candidates of one analyzer answer (`raw`: its `intentions` field, an array of
 * `{ span, purpose }`), anchored to the persona's own lines of the batch (`messages`, slim, `self`
 * true marking hers): a candidate whose `span` occurs (folded) in exactly her line is kept with
 * that line's id, channel and time, and the other authors of that channel in the batch
 * (`participants`, left out when none); a span found in none of her lines is dropped (`unanchored`),
 * and one that also occurs in another author's line of the batch is dropped as a quote of
 * someone else (`quoted`). At most `max` are kept (`over`). Each kept one carries its `origin`
 * (src/intentions/sources.js#externalOrigin over the line and its note, `sourcesOf(line)`, the
 * line's own `sources` by default; `strict`: a line of hers with no note counts as external):
 * `external` with its `originReason`, else `own`; and the turn that wrote the line (`turnId`), and
 * whether it was an inner turn of which chain (`bornInner`, `innerChainId`). Never throws.
 * @param {unknown} raw
 * @param {object[]} messages
 * @param {{ max: number, sourcesOf?: ((line: object) => object|null)|null, strict?: boolean }} options
 * @returns {{ candidates: { purpose: string, span: string, messageId: string, channelId: string|null, ts: number|null, participants?: string[],
 *   origin: 'own'|'external', originReason?: string, turnId: string|null, bornInner?: true, innerChainId?: string }[],
 *   dropped: { invalid: number, unanchored: number, quoted: number, over: number } }}
 */
export function candidatesFromAnswer(raw, messages, { max, sourcesOf = null, strict = false }) {
  const dropped = { invalid: 0, unanchored: 0, quoted: 0, over: 0 };
  const candidates = [];
  const list = Array.isArray(raw) ? raw : [];
  const lines = Array.isArray(messages) ? messages.filter((m) => m && typeof m.content === 'string') : [];
  const hers = lines.filter((m) => m.self === true);
  const others = lines.filter((m) => m.self !== true);
  // The members of a line's conversation: the other authors of its channel in the batch.
  const membersOf = (own) => participantIds(others.filter((m) => String(m.channelId ?? '') === String(own.channelId ?? '') && m.authorId !== undefined && m.authorId !== null).map((m) => String(m.authorId)));
  for (const item of list) {
    const span = line(item?.span, SPAN_CHARS);
    const purpose = line(item?.purpose, PURPOSE_CHARS);
    if (!span || !purpose) {
      dropped.invalid += 1;
      continue;
    }
    const folded = foldText(span);
    const own = [...hers].reverse().find((m) => foldText(m.content).includes(folded));
    if (!own) {
      dropped.unanchored += 1;
      continue;
    }
    if (others.some((m) => foldText(m.content).includes(folded))) {
      dropped.quoted += 1;
      continue;
    }
    if (candidates.some((kept) => kept.messageId === String(own.id) && foldText(kept.span) === folded)) continue;
    if (candidates.length >= max) {
      dropped.over += 1;
      continue;
    }
    const participants = membersOf(own);
    let sources = null;
    try {
      sources = (typeof sourcesOf === 'function' ? sourcesOf(own) : null) ?? own.sources ?? null;
    } catch {
      sources = null;
    }
    const reason = externalOrigin({ span, purpose }, own, sources, { strict });
    const turnId = idOrNull(sources?.turnId) ?? idOrNull(own.inner?.turnId);
    candidates.push({
      purpose,
      span,
      messageId: String(own.id),
      channelId: own.channelId ? String(own.channelId) : null,
      ts: Number.isFinite(own.ts) ? own.ts : null,
      ...(participants.length > 0 ? { participants } : {}),
      origin: reason ? 'external' : 'own',
      ...(reason ? { originReason: reason } : {}),
      turnId,
      ...(sources?.inner === true || own.inner ? { bornInner: true, ...(idOrNull(sources?.chainId) ? { innerChainId: idOrNull(sources.chainId) } : {}) } : {}),
    });
  }
  return { candidates, dropped };
}

/**
 * Whether `record` concerns member `userId` (a forget, src/intentions/store.js#forgetUser): it is
 * meant for them (`destination`), it came from a conversation with them (`provenance.participants`),
 * or its words -- the purpose, the quoted span, the completion condition, the chain, an errand's
 * error -- carry their id (their `<@id>` token included) or one of `names` as a whole word
 * (accents folded; a name under three letters or digits is never matched).
 * @param {object} record
 * @param {{ userId: string, names?: string[] }} member
 * @returns {boolean}
 */
export function concernsMember(record, { userId, names = [] }) {
  const id = String(userId ?? '');
  if (!id || !record) return false;
  if (record.destination === id) return true;
  const provenance = record.provenance ?? {};
  if (Array.isArray(provenance.participants) && provenance.participants.includes(id)) return true;
  const texts = [record.purpose, provenance.span, record.completionCondition, record.chainId, record.outcome?.error].filter((text) => typeof text === 'string' && text);
  if (texts.some((text) => text.includes(id))) return true;
  const folded = [...new Set((Array.isArray(names) ? names : []).filter((name) => typeof name === 'string').map(foldName))].filter(
    (name) => [...name].filter((ch) => isWordChar(ch) && ch !== '_').length >= MIN_FORGET_NAME,
  );
  if (folded.length === 0) return false;
  return texts.some((text) => {
    const haystack = foldName(text);
    return folded.some((name) => occursAsWholeWord(haystack, name));
  });
}
