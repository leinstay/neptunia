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
 * }}
 *   `start` writes a `turn.start` line (not awaited: a failed append is logged) and returns the
 *   turn's id: a new one, or `input.turnId` with `input.attemptId` for a later attempt of the
 *   same turn. The writers resolve once the append store took the line and never reject (a
 *   refused append is logged as `journal: append failed` with its code). `read` returns the
 *   last `n` records of the day (of `kind` when given), newest last.
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

  return { start, turn, action, memory, system, read, dayFile };
}
