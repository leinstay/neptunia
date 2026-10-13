// The persona's journal: one JSON line per thing that happened -- a turn started, a turn
// ended (what it saw, what it thought, what it posted), an action's phase, a memory change, a
// system event -- appended to a day file through the append store (src/memory/append-store.js),
// so the record survives a crash and keeps its order. The day is the UTC day of the record's
// `occurredAt`; a private chat has its own files under the partner's private directory and is
// never written to the guild's journal. Every record carries the same envelope (`v`, `id`,
// `kind`, `occurredAt`, `recordedAt`, `guildId`, `scope`, `participants`, `sourceMessageIds`,
// `origin`); a record missing a list is written with an empty one, never rejected: a journal
// line lost to validation is worse than an incomplete one. The model's `think` is stored
// capped at `journal.thinkChars`, never shown back to it.
//
// Every side effect is an operation with its own `opId` (`op`): a `started` line before the
// call, one closing line after it (`succeeded`, `failed` or `unknown`). After a restart the
// operations of the last days left without a closing line are reconciled (`reconcile`): a
// post is looked for among the persona's last own messages of its channel by the message it
// replied to and the first INTENT_CHARS characters of its text; nothing is ever sent again.
//
// Logs carry the kind and an error code, never the record's contents.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.js';
import { clampText } from './clamp.js';
import { utcDay } from '../time.js';

/** The schema version every record carries. */
export const JOURNAL_VERSION = 1;

const DEFAULT_THINK_CHARS = 4000;
const DEFAULT_READ_N = 50;
const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
/** How many characters of a post's text its `started` line keeps for the reconciliation. */
export const INTENT_CHARS = 80;
/** How many of a channel's last messages the reconciliation reads for the persona's own. */
export const RECONCILE_FETCH = 20;
/** How much earlier than its `started` line a message may be dated and still be the post (clock skew). */
const RECONCILE_SKEW_MS = 60_000;
/** The phases that close an operation. */
const CLOSING_PHASES = new Set(['succeeded', 'failed', 'unknown']);
/** The fields a closing line repeats from its operation (never the input or the intent). */
const OP_FIELDS = ['turnId', 'name', 'by', 'channelId', 'privateUserId', 'participants', 'sourceMessageIds', 'dryRun'];

/**
 * The first INTENT_CHARS characters (code points) of `text`: what a post's `started` line
 * keeps and what the reconciliation compares a message's content with.
 * @param {unknown} text
 * @returns {string}
 */
export function intentText(text) {
  return Array.from(typeof text === 'string' ? text : '').slice(0, INTENT_CHARS).join('');
}

/** An epoch-ms time of a message's `createdAt` (a number, a Date or an ISO string), else null. */
function timeOf(value) {
  if (Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Distinct non-empty strings of `value` (an array), in order; anything else -> []. */
function idList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
  }
  return out;
}

/** The record's scope: the partner's private layer, a channel, or the whole guild. */
function scopeOf({ privateUserId = null, channelId = null } = {}) {
  if (typeof privateUserId === 'string' && privateUserId) return { user: privateUserId, private: true };
  if (typeof channelId === 'string' && channelId) return { channel: channelId };
  return { guild: true };
}

/**
 * Create the journal.
 *
 * @param {object} options
 * @param {{ append: Function, iterate: Function }} options.appendStore  src/memory/append-store.js
 * @param {string} options.dataDir  the `data/` directory
 * @param {() => ({ thinkChars?: number }|undefined)} [options.config]  the live `journal` config
 *   section, read at each write (`hot.config.journal`)
 * @param {() => number} [options.now=Date.now]
 * @param {() => string} [options.uuid=randomUUID]
 * @param {{ warn: Function }} [options.log]
 * @returns {{
 *   start(guildId: string, input: { channelId?: string, mode?: string, trigger?: object|null,
 *     participants?: string[], sourceMessageIds?: string[], privateUserId?: string|null,
 *     turnId?: string, attemptId?: number }): { turnId: string, attemptId: number, startedAt: string },
 *   turn(guildId: string, record: object): Promise<void>,
 *   action(guildId: string, record: object): Promise<void>,
 *   memory(guildId: string, record: object): Promise<void>,
 *   system(guildId: string, record: object): Promise<void>,
 *   read(guildId: string, query: { day: string, kind?: string, n?: number, privateUserId?: string|null }): Promise<object[]>,
 *   dayFile(guildId: string, dateIso: string, privateUserId?: string|null): string,
 *   op(guildId: string, base: object): { opId: string, started(extra?: object): Promise<void>,
 *     succeeded(result?: object): Promise<void>, failed(code: string, result?: object): Promise<void>,
 *     unknown(result?: object): Promise<void> },
 *   pending(guildId: string, query: { day?: string, days?: string[], before?: number }): Promise<Array<{ opId: string,
 *     turnId: string|null, name: string|null, intent: object|null, channelId: string|null }>>,
 *   reconcile(guildId: string, options: { days: string[], before?: number, fetchOwnMessages: (channelId: string, n: number) =>
 *     Promise<Array<{ id: string, content: string, replyToId: string|null, createdAt: unknown }>> }):
 *     Promise<{ succeeded: number, unknown: number }>,
 *   stalled(): boolean,
 * }}
 *   `start` writes a `turn.start` line (not awaited: a failed append is logged) and returns the
 *   turn's id: a new one, or `input.turnId` with `input.attemptId` for a later attempt of the
 *   same turn. The writers resolve once the append store took the line and never reject (a
 *   refused append is logged as `journal: append failed` with its code). `read` returns the
 *   last `n` records of the day (of `kind` when given), newest last.
 *
 *   `op` allots an operation's `opId` (`op-<uuid>`) for one side effect; `base` holds its
 *   `turnId`, `name`, `by` (`persona` | `engine`), `channelId`, `privateUserId`,
 *   `participants`, `sourceMessageIds`, `input`, `intent` (a post's `{ replyTo, text }`, the
 *   text cut to INTENT_CHARS) and `dryRun`. `started(extra)` writes the `started` line (`extra`
 *   adds fields known only then); the first of `succeeded(result)`, `failed(code, result)`
 *   (`result.code`) or `unknown(result)` writes the closing line, any later one is ignored.
 *   `pending` lists the guild journal's operations of `day` (or of every day of `days`) whose
 *   `started` line has no closing line in those days (with `before`, epoch ms: only those started
 *   earlier, so an operation of a turn running meanwhile is left alone). `reconcile` closes them, never sending
 *   anything: a `post` whose channel's last RECONCILE_FETCH own messages (one fetch per
 *   channel) hold one replying to `intent.replyTo` whose content starts with `intent.text`
 *   (dated no earlier than the `started` line, less a minute of skew; one message closes one
 *   post) gets `succeeded` with its `messageId`; any other post, a failed fetch, and every
 *   other operation get `unknown`; each closing line carries `reconciled: true`.
 *
 *   `stalled` says whether the append store's retry queue is full (`stats().stalled`; false for a
 *   store without stats): what depends on a record being taken (memory application) waits.
 */
export function createJournal({ appendStore, dataDir, config = () => ({}), now = Date.now, uuid = randomUUID, log = defaultLog }) {
  function dayFile(guildId, dateIso, privateUserId = null) {
    const day = String(dateIso).match(DAY_RE)?.[0] ?? utcDay(now());
    const base = typeof privateUserId === 'string' && privateUserId
      ? path.join(dataDir, 'guilds', String(guildId), 'private', privateUserId, 'journal')
      : path.join(dataDir, 'guilds', String(guildId), 'journal');
    return path.join(base, `${day}.jsonl`);
  }

  function thinkLimit() {
    const value = config()?.thinkChars;
    return Number.isFinite(value) ? value : DEFAULT_THINK_CHARS;
  }

  /** `fields` wrapped in the envelope; `channelId` and `privateUserId` decide the scope, not stored twice. */
  function envelope(guildId, kind, fields) {
    const { channelId = null, privateUserId = null, participants, sourceMessageIds, occurredAt, ...rest } = fields ?? {};
    const at = new Date(now()).toISOString();
    return {
      record: {
        v: JOURNAL_VERSION,
        id: uuid(),
        kind,
        occurredAt: typeof occurredAt === 'string' && occurredAt ? occurredAt : at,
        recordedAt: at,
        guildId: String(guildId),
        scope: scopeOf({ privateUserId, channelId }),
        participants: idList(participants),
        sourceMessageIds: idList(sourceMessageIds),
        origin: 'live',
        ...rest,
      },
      privateUserId,
    };
  }

  async function write(guildId, kind, fields) {
    try {
      const { record, privateUserId } = envelope(guildId, kind, fields);
      await appendStore.append(dayFile(guildId, record.occurredAt, privateUserId), JSON.stringify(record));
    } catch (error) {
      log.warn('journal: append failed', { kind, code: error?.code ?? null, guildId: String(guildId) });
    }
  }

  function start(guildId, { channelId = null, mode = null, trigger = null, participants, sourceMessageIds, privateUserId = null, turnId = null, attemptId = null } = {}) {
    const id = typeof turnId === 'string' && turnId ? turnId : `t-${uuid()}`;
    const attempt = Number.isInteger(attemptId) && attemptId > 0 ? attemptId : 1;
    const startedAt = new Date(now()).toISOString();
    write(guildId, 'turn.start', {
      channelId,
      privateUserId,
      occurredAt: startedAt,
      participants,
      sourceMessageIds,
      turnId: id,
      attemptId: attempt,
      mode,
      trigger,
    });
    return { turnId: id, attemptId: attempt, startedAt };
  }

  function turn(guildId, record) {
    const { think, ...rest } = record ?? {};
    const fields = { ...rest };
    if (typeof think === 'string') {
      const limit = thinkLimit();
      const cut = limit > 0 && Array.from(think.trim()).length > limit;
      fields.think = cut ? clampText(think, limit, { tolerance: 1 }) : think;
      if (cut) fields.thinkTruncated = true;
    } else {
      fields.think = null;
    }
    return write(guildId, 'turn', fields);
  }

  const action = (guildId, record) => write(guildId, 'action', record);
  const memory = (guildId, record) => write(guildId, 'memory', { ...record, channelId: null });
  const system = (guildId, record) => write(guildId, 'system', { ...record, channelId: null });

  async function read(guildId, { day, kind = null, n = DEFAULT_READ_N, privateUserId = null } = {}) {
    const limit = Number.isInteger(n) && n > 0 ? n : DEFAULT_READ_N;
    const out = [];
    for await (const { line } of appendStore.iterate(dayFile(guildId, day, privateUserId))) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== 'object') continue;
      if (kind && record.kind !== kind) continue;
      out.push(record);
      if (out.length > limit) out.shift();
    }
    return out;
  }

  function op(guildId, base = {}) {
    const opId = `op-${uuid()}`;
    const { intent, ...rest } = base ?? {};
    const common = { ...rest, opId };
    if (intent && typeof intent === 'object') {
      common.intent = { replyTo: typeof intent.replyTo === 'string' && intent.replyTo ? intent.replyTo : null, text: intentText(intent.text) };
    }
    const closingBase = { opId };
    for (const key of OP_FIELDS) if (key in rest) closingBase[key] = rest[key];
    let closed = false;
    const close = (phase, result) => {
      if (closed) return Promise.resolve();
      closed = true;
      return write(guildId, 'action', { ...closingBase, phase, ...(result !== undefined ? { result } : {}) });
    };
    return {
      opId,
      started: (extra = {}) => write(guildId, 'action', { ...common, ...extra, opId, phase: 'started' }),
      succeeded: (result = {}) => close('succeeded', result),
      failed: (code, result = {}) => close('failed', { ...result, code: typeof code === 'string' && code ? code : 'error' }),
      unknown: (result) => close('unknown', result),
    };
  }

  /**
   * The `started` action lines of `days` (guild journal) with no closing line in those days, in
   * order; with `before` (epoch ms) only those that started earlier.
   */
  async function openOperations(guildId, days, before = null) {
    const started = new Map();
    const closedIds = new Set();
    for (const day of days) {
      for (const record of await read(guildId, { day, kind: 'action', n: Number.MAX_SAFE_INTEGER })) {
        if (typeof record.opId !== 'string' || !record.opId) continue;
        if (record.phase === 'started' && !started.has(record.opId)) started.set(record.opId, record);
        else if (CLOSING_PHASES.has(record.phase)) closedIds.add(record.opId);
      }
    }
    const earlier = (record) => !Number.isFinite(before) || Date.parse(record.occurredAt) < before;
    return [...started.values()].filter((record) => !closedIds.has(record.opId) && earlier(record));
  }

  async function pending(guildId, { day = null, days = null, before = null } = {}) {
    const list = Array.isArray(days) ? days : [day ?? utcDay(now())];
    return (await openOperations(guildId, list, before)).map((record) => ({
      opId: record.opId,
      turnId: record.turnId ?? null,
      name: record.name ?? null,
      intent: record.intent ?? null,
      channelId: record.scope?.channel ?? null,
    }));
  }

  /** The persona's last own messages of `channelId`, fetched once per reconciliation; null when the fetch failed. */
  function ownMessagesOnce(fetches, fetchOwnMessages, guildId, channelId) {
    if (!fetches.has(channelId)) {
      const fetching = Promise.resolve()
        .then(() => fetchOwnMessages(channelId, RECONCILE_FETCH))
        .catch((error) => {
          log.warn('journal: reconcile fetch failed', { code: error?.code ?? null, channelId, guildId: String(guildId) });
          return null;
        });
      fetches.set(channelId, fetching);
    }
    return fetches.get(channelId);
  }

  async function reconcile(guildId, { days, fetchOwnMessages, before = null } = {}) {
    const open = await openOperations(guildId, Array.isArray(days) ? days : [utcDay(now())], before);
    const fetches = new Map();
    const used = new Set();
    const counts = { succeeded: 0, unknown: 0 };
    for (const record of open) {
      const channelId = record.scope?.channel ?? null;
      const closing = { opId: record.opId, channelId, reconciled: true };
      for (const key of OP_FIELDS) if (key !== 'channelId' && key in record) closing[key] = record[key];
      let match = null;
      if (record.name === 'post' && channelId && record.intent && typeof fetchOwnMessages === 'function') {
        const messages = await ownMessagesOnce(fetches, fetchOwnMessages, guildId, channelId);
        const startedAt = Date.parse(record.occurredAt);
        const replyTo = record.intent.replyTo ?? null;
        match =
          (Array.isArray(messages) ? messages : []).find((message) => {
            if (!message || typeof message.id !== 'string' || used.has(message.id)) return false;
            if ((message.replyToId ?? null) !== replyTo) return false;
            if (intentText(message.content) !== record.intent.text) return false;
            const createdAt = timeOf(message.createdAt);
            return createdAt === null || !Number.isFinite(startedAt) || createdAt >= startedAt - RECONCILE_SKEW_MS;
          }) ?? null;
      }
      if (match) {
        used.add(match.id);
        counts.succeeded += 1;
        await write(guildId, 'action', { ...closing, phase: 'succeeded', result: { messageId: match.id } });
      } else {
        counts.unknown += 1;
        await write(guildId, 'action', { ...closing, phase: 'unknown' });
      }
    }
    return counts;
  }

  const stalled = () => typeof appendStore.stats === 'function' && appendStore.stats()?.stalled === true;

  return { start, turn, action, memory, system, read, dayFile, op, pending, reconcile, stalled };
}
