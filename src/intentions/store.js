// The persona's intentions, one store per guild: the unit `guilds/<id>/intentions.json` of the memory database
// holds `{ intentions: [...] }` (the records of src/intentions/model.js), written whole on every change, so a restart
// reads back exactly what was there. The list keeps every open intention and the latest KEEP_CLOSED closed ones (done,
// cancelled, expired, dropped). An older closed record is never deleted: it moves to the unit
// `intentions-archive.jsonl` (append-only, one record per line), which only tools read (`archived`). A record that
// breaks the model's invariants is left out on load (counted in the log). The store moves nothing by itself: every
// change is a pure transition of the model applied through `update`. Logs carry ids and counts, never text.

import { log as defaultLog } from '../log.js';
import { checkInvariants, isOpen } from './model.js';
import { CODE } from '../skills/codes.js';
import { createReadSeam } from '../memory/db/readers/common.js';
import { intentionsArchiveLines, intentionsValue } from '../memory/db/readers/intentions.js';
import { createUnitOutbox } from '../memory/db/unit-outbox.js';

/** The closed intentions the list keeps besides the open ones. */
export const KEEP_CLOSED = 50;

/**
 * `memoryDb` (the memory database service): the list is loaded from the database and `archived` reads it there
 * (src/memory/db/readers/intentions.js; a failed read throws, with a code). Each change hands the whole list
 * (`intentions.json`, op `value`) and the records it moved out (`intentions-archive.jsonl`, op `lines`) to an outbox
 * (src/memory/db/unit-outbox.js) that sends them through the database's writer. The list in memory stays the truth
 * meanwhile, so `add` and `update` answer at once; a write that failed waits in the outbox and goes again at the
 * next change or `flush`, and `flush({ final: true })` (the shutdown) keeps what still fails in `memory-pending/`,
 * replayed by the service at its next start. Without a `memoryDb` (tests, a tool's dry run) nothing is read or written:
 * the list lives in memory only.
 * @param {{ guildId: string, now?: () => number, log?: object, memoryDb?: object|null }} options
 */
export function createIntentionStore({ guildId, log = defaultLog, memoryDb = null }) {
  const seam = createReadSeam({ memoryDb, log, reader: 'intentions' });
  const state = { list: load(), archived: [] };
  const outbox = memoryDb && typeof memoryDb.writeUnit === 'function' ? createUnitOutbox({ memoryDb, log, name: 'intentions' }) : null;
  const owner = `guilds/${String(guildId)}/intentions.json`;
  const archiveOwner = `guilds/${String(guildId)}/intentions-archive.jsonl`;

  /** The list read once from the database (none without a `memoryDb`). */
  function load() {
    if (!memoryDb) return [];
    const db = seam.db();
    const found = seam.run(() => intentionsValue(db, guildId));
    return valid(found.found ? found.value : null);
  }

  /** The records of a loaded value that keep the model's invariants. */
  function valid(raw) {
    const list = Array.isArray(raw?.intentions) ? raw.intentions : [];
    const kept = list.filter((record) => record && typeof record.id === 'string' && checkInvariants(record) === null);
    if (kept.length < list.length) log.warn('intentions: records left out on load', { guildId: String(guildId), count: list.length - kept.length });
    return kept;
  }

  /** The list kept (every open record, then the latest KEEP_CLOSED closed ones) and the closed records beyond them. */
  function split(list) {
    const closed = list.filter((record) => !isOpen(record.status));
    if (closed.length <= KEEP_CLOSED) return { kept: list, moved: [] };
    const keep = new Set([...closed].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, KEEP_CLOSED));
    return { kept: list.filter((record) => isOpen(record.status) || keep.has(record)), moved: list.filter((record) => !isOpen(record.status) && !keep.has(record)) };
  }

  /**
   * The list handed to the outbox whole, the records `moved` out of it to the archive first (so a
   * crash between the two repeats a record in the archive, never loses one). Throws when the outbox
   * cannot take it (the caller's change is then not made). Without a `memoryDb` the moved records are
   * kept in memory.
   */
  function persist(list, moved = []) {
    if (!memoryDb) {
      state.archived.push(...moved.map(copy));
      return;
    }
    if (!outbox) throw Object.assign(new Error('memory db: no writer'), { code: 'DB_CLOSED' });
    if (moved.length > 0) outbox.lines(archiveOwner, JSON.parse(JSON.stringify(moved)));
    outbox.value(owner, JSON.parse(JSON.stringify({ intentions: list })));
    outbox.push();
  }

  /** The archived records, oldest first (a line that does not parse is skipped). Tools only. */
  function archived() {
    if (!memoryDb) return state.archived.map(copy);
    const db = seam.db();
    const raw = seam.run(() => intentionsArchiveLines(db, guildId)).join('\n');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn line is left alone
      }
    }
    return out;
  }

  function copy(record) {
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  /** Every record, oldest first (copies). */
  function list() {
    return state.list.map(copy);
  }

  /** The record `id` (a copy), or null. */
  function get(id) {
    return copy(state.list.find((record) => record.id === String(id ?? '')) ?? null);
  }

  /**
   * A new record added and written; `{ ok: false, code }` for one that breaks an invariant
   * (`checkInvariants`' code) or repeats an id (`duplicate-id`), or `write-failed`.
   */
  function add(record) {
    const broken = checkInvariants(record);
    if (broken) return { ok: false, code: broken };
    if (state.list.some((kept) => kept.id === record.id)) return { ok: false, code: CODE.DUPLICATE_ID };
    const { kept: next, moved } = split([...state.list, copy(record)]);
    try {
      persist(next, moved);
    } catch (err) {
      log.warn('intentions: write failed', { guildId: String(guildId), code: err?.code ?? null });
      return { ok: false, code: CODE.WRITE_FAILED };
    }
    state.list = next;
    return { ok: true, intention: copy(record) };
  }

  /**
   * Record `id` passed through `move(record)` (a model transition answering `{ ok, intention,
   * changed }`): a change is written, then kept; the move's refusal or `not-found` /
   * `write-failed` as `{ ok: false, code }`; an unchanged answer writes nothing.
   */
  function update(id, move) {
    const index = state.list.findIndex((record) => record.id === String(id ?? ''));
    if (index < 0) return { ok: false, code: CODE.NOT_FOUND };
    const result = move(copy(state.list[index]));
    if (!result?.ok) return result ?? { ok: false, code: CODE.BAD_MOVE };
    if (result.changed !== true) return { ok: true, intention: copy(state.list[index]), changed: false };
    const { kept: next, moved } = split(state.list.map((record, i) => (i === index ? copy(result.intention) : record)));
    try {
      persist(next, moved);
    } catch (err) {
      log.warn('intentions: write failed', { guildId: String(guildId), id: String(id), code: err?.code ?? null });
      return { ok: false, code: CODE.WRITE_FAILED };
    }
    state.list = next;
    return { ok: true, intention: copy(result.intention), changed: true };
  }

  /**
   * The writes still waiting sent again and awaited; with `final` (the shutdown) what still fails is kept in
   * `memory-pending/`. Nothing without a `memoryDb`.
   * @returns {Promise<{ waiting: number, pending: number }>}
   */
  async function flush({ final = false } = {}) {
    if (!outbox) return { waiting: 0, pending: 0 };
    const waiting = await outbox.flush();
    return { waiting, pending: final ? outbox.keep() : 0 };
  }

  return { list, get, add, update, archived, flush, guildId: String(guildId) };
}

/**
 * One intention store per guild, created on first use. `memoryDb` goes to every store (createIntentionStore); a
 * store whose load failed is not kept, so the next `get` tries again.
 * @param {{ now?: () => number, log?: object, memoryDb?: object|null }} options
 * @returns {{ get(guildId: string): ReturnType<typeof createIntentionStore>|null,
 *   flush(options?: { final?: boolean }): Promise<{ waiting: number, pending: number }> }}
 */
export function createIntentionStores({ now = Date.now, log = defaultLog, memoryDb = null }) {
  const stores = new Map();
  const api = {
    get(guildId) {
      const key = String(guildId ?? '');
      if (!key) return null;
      if (!stores.has(key)) stores.set(key, createIntentionStore({ guildId: key, now, log, memoryDb }));
      return stores.get(key);
    },
    /** Every store's `flush` (the writes waiting for the database; `final` at the shutdown). */
    async flush(options = {}) {
      let waiting = 0;
      let pending = 0;
      for (const store of stores.values()) {
        const done = await store.flush(options);
        waiting += done.waiting;
        pending += done.pending;
      }
      return { waiting, pending };
    },
  };
  return api;
}
