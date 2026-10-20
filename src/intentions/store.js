// The persona's intentions on disk, one store per guild: `data/guilds/<id>/intentions.json`
// holds `{ intentions: [...] }` (the records of src/intentions/model.js), written whole through
// writeJsonAtomic on every change, so a restart reads back exactly what was there. The list keeps
// every open intention and the latest KEEP_CLOSED closed ones (done, cancelled, expired, dropped; a dropped one also goes after `intentions.droppedDays`, the service's prune). A file
// that does not parse is copied aside (`intentions.json.unreadable-<ms>`) before the store starts
// empty, so nothing is lost to a later write; a record that breaks the model's invariants is left
// out on load (counted in the log). The store moves nothing by itself: every change is a pure
// transition of the model applied through `update`. A forget of a member (`forgetUser`, the
// `intentions` step of src/memory/store.js#forgetUser) takes out every intention that concerns
// them (src/intentions/model.js#concernsMember), whatever its status, after copying the file
// into the forget's vault; a wipe of the guild (`wipe`, src/memory/store.js#wipeGuild) empties the
// list and deletes the file and its unreadable copies. Logs carry ids and counts, never text.

import fs from 'node:fs';
import path from 'node:path';
import { log as defaultLog } from '../log.js';
import { writeJsonAtomic } from '../memory/index.js';
import { checkInvariants, concernsMember, isOpen } from './model.js';
import { CODE } from '../skills/codes.js';

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
    if (state.list.some((kept) => kept.id === record.id)) return { ok: false, code: CODE.DUPLICATE_ID };
    const next = pruned([...state.list, copy(record)]);
    try {
      persist(next);
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
    const next = pruned(state.list.map((record, i) => (i === index ? copy(result.intention) : record)));
    try {
      persist(next);
    } catch (err) {
      log.warn('intentions: write failed', { guildId: String(guildId), id: String(id), code: err?.code ?? null });
      return { ok: false, code: CODE.WRITE_FAILED };
    }
    state.list = next;
    return { ok: true, intention: copy(result.intention), changed: true };
  }

  /**
   * Every record `stale(record)` is true for removed and the file written (the service drops
   * the dropped intentions past `intentions.droppedDays` this way). How many; throws on a write error.
   */
  function prune(stale) {
    const next = state.list.filter((record) => !stale(record));
    const removed = state.list.length - next.length;
    if (removed === 0) return 0;
    persist(next);
    state.list = next;
    log.info('intentions: pruned', { guildId: String(guildId), count: removed });
    return removed;
  }

  /** The copies a broken file left aside (`intentions.json.unreadable-<ms>`), as paths. */
  function unreadableCopies() {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((name) => name.startsWith('intentions.json.unreadable-')).map((name) => path.join(dir, name));
  }

  /**
   * Member `userId` forgotten: every intention concerning them (model#concernsMember, with their
   * `names`) removed and the file written; an unreadable copy that names their id removed too.
   * With `vault` (the forget's vault directory), what goes is copied there first under its path
   * below `dataDir`. Throws on a write error, so the forget's step is not marked done.
   * @param {string} userId
   * @param {{ names?: string[], vault?: string|null }} [options]
   * @returns {{ removed: number, copies: number }}
   */
  function forgetUser(userId, { names = [], vault = null } = {}) {
    const id = String(userId ?? '');
    if (!id) return { removed: 0, copies: 0 };
    const victims = state.list.filter((record) => concernsMember(record, { userId: id, names }));
    const copies = unreadableCopies().filter((copyPath) => {
      try {
        return fs.readFileSync(copyPath, 'utf8').includes(id);
      } catch {
        return false;
      }
    });
    if (vault && (victims.length > 0 || copies.length > 0)) {
      const base = path.join(vault, path.relative(dataDir, dir));
      fs.mkdirSync(base, { recursive: true });
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(base, 'intentions.json'));
      for (const copyPath of copies) fs.copyFileSync(copyPath, path.join(base, path.basename(copyPath)));
    }
    if (victims.length > 0) {
      const gone = new Set(victims.map((record) => record.id));
      const next = state.list.filter((record) => !gone.has(record.id));
      persist(next);
      state.list = next;
    }
    for (const copyPath of copies) fs.rmSync(copyPath, { force: true });
    if (victims.length + copies.length > 0) log.info('intentions: member forgotten', { guildId: String(guildId), userId: id, removed: victims.length, copies: copies.length });
    return { removed: victims.length, copies: copies.length };
  }

  /** The guild's intentions gone: the list emptied, the file and its unreadable copies deleted. How many files. */
  function wipe() {
    let files = 0;
    for (const target of [file, ...unreadableCopies()]) {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { force: true });
      files += 1;
    }
    state.list = [];
    return { files };
  }

  return { list, get, add, update, prune, forgetUser, wipe, guildId: String(guildId), file };
}

/**
 * One intention store per guild, created on first use over the same `data/` directory. `forgetUser`
 * and `wipe` are what the memory's deleters are handed (src/memory/store.js#forgetUser's
 * `intentions`, #wipeGuild's `intentions`).
 * @param {{ dataDir: string, now?: () => number, log?: object }} options
 * @returns {{ get(guildId: string): ReturnType<typeof createIntentionStore>|null,
 *   forgetUser(guildId: string, userId: string, options?: { names?: string[], vault?: string|null }): { removed: number, copies: number },
 *   wipe(guildId: string): { files: number } }}
 */
export function createIntentionStores({ dataDir, now = Date.now, log = defaultLog }) {
  const stores = new Map();
  const api = {
    get(guildId) {
      const key = String(guildId ?? '');
      if (!key) return null;
      if (!stores.has(key)) stores.set(key, createIntentionStore({ dataDir, guildId: key, now, log }));
      return stores.get(key);
    },
    forgetUser(guildId, userId, options = {}) {
      const store = api.get(guildId);
      return store ? store.forgetUser(userId, options) : { removed: 0, copies: 0 };
    },
    wipe(guildId) {
      const store = api.get(guildId);
      return store ? store.wipe() : { files: 0 };
    },
  };
  return api;
}
