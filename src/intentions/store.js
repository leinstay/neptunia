// The persona's intentions on disk, one store per guild: `data/guilds/<id>/intentions.json`
// holds `{ intentions: [...] }` (the records of src/intentions/model.js), written whole through
// writeJsonAtomic on every change, so a restart reads back exactly what was there. The list keeps
// every open intention and the latest KEEP_CLOSED closed ones (done, cancelled, expired, dropped). An older
// closed record is never deleted: it moves to `intentions-archive.jsonl` next to the file (append-only, one record per
// line), which only tools (`archived`) and the forget path read. A file
// that does not parse is copied aside (`intentions.json.unreadable-<ms>`) before the store starts
// empty, so nothing is lost to a later write; a record that breaks the model's invariants is left
// out on load (counted in the log). The store moves nothing by itself: every change is a pure
// transition of the model applied through `update`. A forget of a member (`forgetUser`, the
// `intentions` step of src/memory/store.js#forgetUser) takes out every intention that concerns
// them (src/intentions/model.js#concernsMember), whatever its status, after copying the file
// into the forget's vault, and scrubs the archive the same way; a wipe of the guild (`wipe`,
// src/memory/store.js#wipeGuild) empties the list and deletes the file, the archive and the unreadable copies. Logs carry ids and counts, never text.

import fs from 'node:fs';
import path from 'node:path';
import { log as defaultLog } from '../log.js';
import { writeJsonAtomic } from '../memory/index.js';
import { checkInvariants, concernsMember, isOpen } from './model.js';
import { CODE } from '../skills/codes.js';
import { createReadSeam } from '../memory/db/readers/common.js';
import { intentionsArchiveLines, intentionsValue } from '../memory/db/readers/intentions.js';
import { createUnitOutbox } from '../memory/db/unit-outbox.js';
import { forgetRefusal } from '../memory/db/authority.js';

/** The closed intentions the file keeps besides the open ones. */
export const KEEP_CLOSED = 50;

/**
 * `memoryDb` (the memory database service) and `authorityOf`: under the authority `db` the list is loaded from the
 * database and `archived` reads it there (src/memory/db/readers/intentions.js), with no file fallback (a failed read
 * throws, with a code); under `json` (the default) the files are read as always. Stage W2b, under `db`: no file is
 * written; each change hands the whole list (`intentions.json`, op `value`) and the records it moved out
 * (`intentions-archive.jsonl`, op `lines`) to an outbox (src/memory/db/unit-outbox.js) that sends them through the
 * database's writer. The list in memory stays the truth meanwhile, so `add` and `update` answer at once; a write that
 * failed waits in the outbox and goes again at the next change or `flush`, and `flush({ final: true })` (the
 * shutdown) keeps what still fails in `memory-pending/`, replayed by the service at its next start.
 * @param {{ dataDir: string, guildId: string, now?: () => number, log?: object, memoryDb?: object|null,
 *   authorityOf?: (() => string)|null }} options
 */
export function createIntentionStore({ dataDir, guildId, now = Date.now, log = defaultLog, memoryDb = null, authorityOf = null }) {
  const dir = path.join(dataDir, 'guilds', String(guildId));
  const file = path.join(dir, 'intentions.json');
  const archiveFile = path.join(dir, 'intentions-archive.jsonl');
  const seam = createReadSeam({ memoryDb, authorityOf, log, reader: 'intentions' });
  const state = { list: load() };
  const outbox = seam.authority() === 'db' && typeof memoryDb?.writeUnit === 'function' ? createUnitOutbox({ memoryDb, log, name: 'intentions' }) : null;
  const owner = `guilds/${String(guildId)}/intentions.json`;
  const archiveOwner = `guilds/${String(guildId)}/intentions-archive.jsonl`;

  /** intentions.json read once; a missing file is empty, a broken one copied aside first (from the database under `db`). */
  function load() {
    let raw;
    const db = seam.db();
    if (db) {
      const found = seam.run(() => intentionsValue(db, guildId));
      return valid(found.found ? found.value : null);
    }
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
    return valid(raw);
  }

  /** The records of a loaded file value that keep the model's invariants. */
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
   * intentions.json written whole, the records `moved` out of it appended to the archive first (so a
   * crash between the two repeats a record in the archive, never loses one). Throws on a write error
   * (the caller's change is then not made).
   */
  function persist(list, moved = []) {
    if (seam.authority() === 'db') {
      if (!outbox) throw Object.assign(new Error('memory db: no writer'), { code: 'DB_CLOSED' });
      if (moved.length > 0) outbox.lines(archiveOwner, JSON.parse(JSON.stringify(moved)));
      outbox.value(owner, JSON.parse(JSON.stringify({ intentions: list })));
      outbox.push();
      return;
    }
    if (moved.length > 0) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(archiveFile, moved.map((record) => `${JSON.stringify(record)}\n`).join(''));
    }
    writeJsonAtomic(file, { intentions: list });
  }

  /** The archived records, oldest first (a line that does not parse is skipped). Tools only. */
  function archived() {
    let raw;
    const db = seam.db();
    if (db) {
      raw = seam.run(() => intentionsArchiveLines(db, guildId)).join('\n');
    } else {
      try {
        raw = fs.readFileSync(archiveFile, 'utf8');
      } catch {
        return [];
      }
    }
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
    // Authority `db`: there is no forget (stage W3).
    if (seam.authority() === 'db') throw forgetRefusal('intentions.forgetUser');
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
    const archive = archived();
    const archiveVictims = archive.filter((record) => concernsMember(record, { userId: id, names }));
    if (vault && (victims.length > 0 || copies.length > 0 || archiveVictims.length > 0)) {
      const base = path.join(vault, path.relative(dataDir, dir));
      fs.mkdirSync(base, { recursive: true });
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(base, 'intentions.json'));
      if (archiveVictims.length > 0) fs.copyFileSync(archiveFile, path.join(base, path.basename(archiveFile)));
      for (const copyPath of copies) fs.copyFileSync(copyPath, path.join(base, path.basename(copyPath)));
    }
    if (archiveVictims.length > 0) {
      const gone = new Set(archiveVictims);
      const rest = archive.filter((record) => !gone.has(record));
      fs.writeFileSync(`${archiveFile}.tmp`, rest.map((record) => `${JSON.stringify(record)}\n`).join(''));
      fs.renameSync(`${archiveFile}.tmp`, archiveFile);
    }
    if (victims.length > 0) {
      const gone = new Set(victims.map((record) => record.id));
      const next = state.list.filter((record) => !gone.has(record.id));
      persist(next);
      state.list = next;
    }
    for (const copyPath of copies) fs.rmSync(copyPath, { force: true });
    const removed = victims.length + archiveVictims.length;
    if (removed + copies.length > 0) log.info('intentions: member forgotten', { guildId: String(guildId), userId: id, removed, copies: copies.length });
    return { removed, copies: copies.length };
  }

  /** The guild's intentions gone: the list emptied, the file and its unreadable copies deleted. How many files. */
  function wipe() {
    // Authority `db`: no wipe of the memory (stage W3).
    if (seam.authority() === 'db') throw forgetRefusal('intentions.wipe');
    let files = 0;
    for (const target of [file, archiveFile, ...unreadableCopies()]) {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { force: true });
      files += 1;
    }
    state.list = [];
    return { files };
  }

  /**
   * Authority `db`: the writes still waiting sent again and awaited; with `final` (the shutdown) what still fails is
   * kept in `memory-pending/`. Nothing under `json`.
   * @returns {Promise<{ waiting: number, pending: number }>}
   */
  async function flush({ final = false } = {}) {
    if (!outbox) return { waiting: 0, pending: 0 };
    const waiting = await outbox.flush();
    return { waiting, pending: final ? outbox.keep() : 0 };
  }

  return { list, get, add, update, archived, forgetUser, wipe, flush, guildId: String(guildId), file, archiveFile };
}

/**
 * One intention store per guild, created on first use over the same `data/` directory. `forgetUser`
 * and `wipe` are what the memory's deleters are handed (src/memory/store.js#forgetUser's
 * `intentions`, #wipeGuild's `intentions`). `memoryDb` and `authorityOf` go to every store
 * (createIntentionStore); a store whose load failed under `db` is not kept, so the next `get` tries again.
 * @param {{ dataDir: string, now?: () => number, log?: object, memoryDb?: object|null, authorityOf?: (() => string)|null }} options
 * @returns {{ get(guildId: string): ReturnType<typeof createIntentionStore>|null,
 *   forgetUser(guildId: string, userId: string, options?: { names?: string[], vault?: string|null }): { removed: number, copies: number },
 *   wipe(guildId: string): { files: number } }}
 */
export function createIntentionStores({ dataDir, now = Date.now, log = defaultLog, memoryDb = null, authorityOf = null }) {
  const stores = new Map();
  const api = {
    get(guildId) {
      const key = String(guildId ?? '');
      if (!key) return null;
      if (!stores.has(key)) stores.set(key, createIntentionStore({ dataDir, guildId: key, now, log, memoryDb, authorityOf }));
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
    /** Every store's `flush` (stage W2b: the writes waiting for the database; `final` at the shutdown). */
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
