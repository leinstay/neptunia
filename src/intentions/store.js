// The persona's intentions on disk, one store per guild: `data/guilds/<id>/intentions.json`
// holds `{ intentions: [...] }` (the records of src/intentions/model.js), written whole through
// writeJsonAtomic on every change, so a restart reads back exactly what was there. The list keeps
// every open intention and the latest KEEP_CLOSED closed ones (done, cancelled, expired). A file
// that does not parse is copied aside (`intentions.json.unreadable-<ms>`) before the store starts
// empty, so nothing is lost to a later write; a record that breaks the model's invariants is left
// out on load (counted in the log). The store moves nothing by itself: every change is a pure
// transition of the model applied through `update`. Logs carry ids and counts, never text.

import fs from 'node:fs';
import path from 'node:path';
import { log as defaultLog } from '../log.js';
import { writeJsonAtomic } from '../memory/index.js';
import { checkInvariants, isOpen } from './model.js';

/** The closed intentions the file keeps besides the open ones. */
export const KEEP_CLOSED = 50;

/**
 * @param {{ dataDir: string, guildId: string, now?: () => number, log?: object }} options
 */
export function createIntentionStore({ dataDir, guildId, now = Date.now, log = defaultLog }) {
  const dir = path.join(dataDir, 'guilds', String(guildId));
  const file = path.join(dir, 'intentions.json');
  const state = { list: load() };

  /** intentions.json read once; a missing file is empty, a broken one copied aside first. */
  function load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      try {
        fs.copyFileSync(file, `${file}.unreadable-${now()}`);
      } catch {
        // nothing more to keep
      }
      log.warn('intentions: file unreadable, starting empty', { guildId: String(guildId), code: err?.code ?? 'parse' });
      return [];
    }
    const list = Array.isArray(raw?.intentions) ? raw.intentions : [];
    const valid = list.filter((record) => record && typeof record.id === 'string' && checkInvariants(record) === null);
    if (valid.length < list.length) log.warn('intentions: records left out on load', { guildId: String(guildId), count: list.length - valid.length });
    return valid;
  }

  /** The list kept: every open record, then the latest KEEP_CLOSED closed ones. */
  function pruned(list) {
    const closed = list.filter((record) => !isOpen(record.status));
    if (closed.length <= KEEP_CLOSED) return list;
    const keep = new Set([...closed].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, KEEP_CLOSED));
    return list.filter((record) => isOpen(record.status) || keep.has(record));
  }

  /** intentions.json written whole. Throws on a write error (the caller's change is then not made). */
  function persist(list) {
    writeJsonAtomic(file, { intentions: list });
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
    if (state.list.some((kept) => kept.id === record.id)) return { ok: false, code: 'duplicate-id' };
    const next = pruned([...state.list, copy(record)]);
    try {
      persist(next);
    } catch (err) {
      log.warn('intentions: write failed', { guildId: String(guildId), code: err?.code ?? null });
      return { ok: false, code: 'write-failed' };
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
    if (index < 0) return { ok: false, code: 'not-found' };
    const result = move(copy(state.list[index]));
    if (!result?.ok) return result ?? { ok: false, code: 'bad-move' };
    if (result.changed !== true) return { ok: true, intention: copy(state.list[index]), changed: false };
    const next = pruned(state.list.map((record, i) => (i === index ? copy(result.intention) : record)));
    try {
      persist(next);
    } catch (err) {
      log.warn('intentions: write failed', { guildId: String(guildId), id: String(id), code: err?.code ?? null });
      return { ok: false, code: 'write-failed' };
    }
    state.list = next;
    return { ok: true, intention: copy(result.intention), changed: true };
  }

  return { list, get, add, update, guildId: String(guildId), file };
}

/**
 * One intention store per guild, created on first use over the same `data/` directory.
 * @param {{ dataDir: string, now?: () => number, log?: object }} options
 * @returns {{ get(guildId: string): ReturnType<typeof createIntentionStore>|null }}
 */
export function createIntentionStores({ dataDir, now = Date.now, log = defaultLog }) {
  const stores = new Map();
  return {
    get(guildId) {
      const key = String(guildId ?? '');
      if (!key) return null;
      if (!stores.has(key)) stores.set(key, createIntentionStore({ dataDir, guildId: key, now, log }));
      return stores.get(key);
    },
  };
}
