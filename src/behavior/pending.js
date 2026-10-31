// Pure queue of "pending" calls: a @mention, a reply or the persona's name
// that arrived while a turn was running in its own channel
// (config.mention.pendingSameChannel) or, with one turn at a time
// (config.mention.oneAtATime), somewhere else; a private message waiting for
// the same reason; a follow-up the address classifier said `yes` to, the
// same way; a call from a channel the persona cannot write in, routed
// to the main channel (its `destination`), whose turn found the attention
// taken. Every call waits for its own answer: the queue keeps them all in
// arrival order, several per channel and per author, and a newer call never
// takes an older one's place (a deferred follow-up excepted: one per channel,
// replaced in src/behavior/pipeline.js). At most mention.maxPending entries overall; the
// single oldest entry, of any channel, is evicted when full. A routed call
// keeps the calls its settle wait grouped with it (`superseded`), so whatever
// ends it -- the ignore roll letting it pass -- ends those too. A later message
// of an author about one of their waiting calls is folded into it (`added`)
// instead of waiting as a call of its own: the decision is the merge
// classifier's (src/behavior/pipeline.js), parsed here (parseMergeAnswer).
// In-memory only, never persisted -- a restart forgetting every pending call
// is fine. A call that leaves the queue without its turn (evicted when full, expired,
// outranked) is not lost with it: the pipeline notes it as a missed fact with that
// code (src/behavior/missed.js), which the missed-answer recovery owes like a dropped turn.
//
// The orchestration (when to enqueue, when and how to drain the queue once a
// turn finishes, the actual ignore decision, the merge request) lives in
// src/behavior/pipeline.js; this module only knows about the list itself.

/**
 * @typedef {object} PendingPing
 * @property {string} channelId   the channel the call arrived in
 * @property {*} channel        the conversation the call arrived in
 * @property {object} trigger   the normalized message that called the persona
 * @property {'mention'|'reply'|'name'|'private'|'followUp'|'overheard'} kind  `followUp` / `overheard`: an address-classifier
 *                              `yes` / `overheard` that found the attention taken (one of them per channel,
 *                              followUpSlot, src/pipeline/pending-queue.ts#deferFollowUp)
 * @property {number} arrivedAt
 * @property {boolean} [decided] set on a re-queued server call whose ignore roll already said respond
 * @property {*} [destination]  a routed call only: the conversation its turn posts in (the
 *                              main channel), while `channelId` / `channel` stay its source
 * @property {string[]} [superseded]  a routed call only: the message ids of the calls of its source
 *                              its settle wait grouped with it, each once
 * @property {{ id: string, text: string, ts: number }[]} [added]  later messages of the author
 *                              folded into this call (foldInto), oldest first
 */

/** Index of the entry with the smallest `arrivedAt` (the first of equals) in a list, or -1 for an empty one. */
function oldestIndex(list) {
  if (list.length === 0) return -1;
  let index = 0;
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].arrivedAt < list[index].arrivedAt) index = i;
  }
  return index;
}

/** `list` without its oldest entry when it holds more than `maxPending`, and that entry. */
function capped(list, maxPending) {
  if (list.length <= maxPending) return { list, evicted: null };
  const index = oldestIndex(list);
  return { list: list.filter((_, i) => i !== index), evicted: list[index] };
}

/**
 * Add `ping` after every call already waiting, then evict the single oldest
 * entry across all channels if the result exceeds `maxPending` (the caller
 * logs it). Nothing is replaced: two calls of one channel, or of one author,
 * both wait.
 * @param {PendingPing[]} list
 * @param {PendingPing} ping
 * @param {number} maxPending
 * @returns {{ list: PendingPing[], evicted: PendingPing|null }}
 */
export function addPending(list, ping, maxPending) {
  return capped([...list, ping], maxPending);
}

/**
 * Put back a call the drain picked up but could not answer (its turn found
 * another one running), keeping its original `arrivedAt` and its place in
 * arrival order: before every call that did not arrive before it. The cap
 * applies as in addPending (the evicted entry may be `ping` itself, being the
 * oldest).
 * @param {PendingPing[]} list
 * @param {PendingPing} ping
 * @param {number} maxPending
 * @returns {{ list: PendingPing[], evicted: PendingPing|null }}
 */
export function requeuePending(list, ping, maxPending) {
  const at = list.findIndex((p) => p.arrivedAt >= ping.arrivedAt);
  const next = at === -1 ? [...list, ping] : [...list.slice(0, at), ping, ...list.slice(at)];
  return capped(next, maxPending);
}

/** The kinds that share a channel's one follow-up slot. */
const SLOT_KINDS = new Set(['followUp', 'overheard']);

/** The direct calls of a channel that take a waiting overheard line's place. */
const DIRECT_KINDS = new Set(['mention', 'reply', 'name']);

/**
 * The priority rule of a channel's follow-up slot -- the one deferred
 * `followUp` or `overheard` line (never a routed call) a channel may hold --
 * for a newcomer of `kind` in `channelId`: whether it may be queued
 * (`admit`) and which waiting entry it takes the place of (`replaced`, null
 * for none; the caller removes and logs it). A `followUp` replaces either
 * kind; an `overheard` replaces a waiting `overheard` and is refused next to a
 * waiting `followUp` (outranked: its turn would read the line in the channel
 * history anyway); a direct mention, reply or name call replaces a waiting
 * `overheard` and waits beside a `followUp`. Anything else (a private
 * message) admits and replaces nothing. Pure; `list` is not mutated.
 * @param {PendingPing[]} list
 * @param {string} channelId
 * @param {PendingPing['kind']} kind
 * @returns {{ admit: boolean, replaced: PendingPing|null }}
 */
export function followUpSlot(list, channelId, kind) {
  const waiting = list.find((p) => !p.destination && p.channelId === channelId && SLOT_KINDS.has(p.kind)) ?? null;
  if (!waiting) return { admit: true, replaced: null };
  if (kind === 'followUp') return { admit: true, replaced: waiting };
  if (kind === 'overheard')
    return waiting.kind === 'followUp' ? { admit: false, replaced: null } : { admit: true, replaced: waiting };
  if (DIRECT_KINDS.has(kind) && waiting.kind === 'overheard') return { admit: true, replaced: waiting };
  return { admit: true, replaced: null };
}

/** Whether `ping` is past `pendingMinutes` from the time it arrived, at `now`. */
export function isExpired(ping, now, pendingMinutes) {
  return now - ping.arrivedAt >= pendingMinutes * 60_000;
}

/**
 * Remove and return the single oldest entry of `list` (by `arrivedAt`, the
 * first of equals), regardless of expiry -- the caller checks `isExpired`
 * itself so it can log an 'expired' line for every one discarded on the way
 * to a live pick.
 * @param {PendingPing[]} list
 * @returns {{ ping: PendingPing|null, list: PendingPing[] }}
 */
export function popOldest(list) {
  const index = oldestIndex(list);
  if (index === -1) return { ping: null, list };
  return { ping: list[index], list: list.filter((_, i) => i !== index) };
}

/**
 * The calls `authorId` wrote in `channelId` that wait in `list`, in arrival
 * order: the author's queued items there. A routed call is not one (its turn
 * is about another channel, and the ring of calls keeps its own account).
 * @param {PendingPing[]} list
 * @param {string} channelId
 * @param {string} authorId
 * @returns {PendingPing[]}
 */
export function authorCalls(list, channelId, authorId) {
  return list
    .filter((p) => !p.destination && p.channelId === channelId && p.trigger?.authorId === authorId)
    .sort((a, b) => a.arrivedAt - b.arrivedAt);
}

/**
 * `list` with `message` (`{ id, text, ts }`) folded into the call whose
 * trigger is `triggerId` (appended to its `added`); `folded` false -- the
 * list as it was -- when that call no longer waits. Neither input is mutated.
 * @param {PendingPing[]} list
 * @param {string} triggerId
 * @param {{ id: string, text: string, ts: number }} message
 * @returns {{ list: PendingPing[], folded: boolean }}
 */
export function foldInto(list, triggerId, message) {
  const target = list.find((p) => p.trigger?.id === triggerId);
  if (!target) return { list, folded: false };
  const merged = { ...target, added: [...(target.added ?? []), message] };
  return { list: list.map((p) => (p === target ? merged : p)), folded: true };
}

/**
 * The merge classifier's answer (prompts/merge.md), parsed strictly: one
 * line holding the number of a waiting item, 1..`count` (a trailing period
 * allowed) -> `item` with its 1-based `index`; the word `new` (any case) ->
 * `new`. A blank answer is `empty`, a number outside the items `out-of-range`,
 * anything else `unparsed`: each of them means `new` to the caller. Pure.
 * @param {unknown} text
 * @param {number} count
 * @returns {{ index: number|null, reason: 'item'|'new'|'empty'|'out-of-range'|'unparsed' }}
 */
export function parseMergeAnswer(text, count) {
  const answer = String(text ?? '').trim();
  if (!answer) return { index: null, reason: 'empty' };
  if (/^new\.?$/i.test(answer)) return { index: null, reason: 'new' };
  const number = /^(\d+)\.?$/.exec(answer);
  if (!number) return { index: null, reason: 'unparsed' };
  const index = Number(number[1]);
  if (!(index >= 1 && index <= count)) return { index: null, reason: 'out-of-range' };
  return { index, reason: 'item' };
}
