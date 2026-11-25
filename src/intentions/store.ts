// The persona's intentions: the `intentions` rows of the memory database hold the records of src/intentions/model.ts
// (src/memory/db/intentions-write.ts), the list written whole on every change, so a restart reads back exactly what
// was there. The list keeps every open intention and the latest KEEP_CLOSED closed ones (done, cancelled, expired,
// dropped). An older closed record is never deleted: it moves to the archive (append-only), which only tools read
// (`archived`). A record that breaks the model's invariants is left out on load (counted in the log). The store moves
// nothing by itself: every change is a pure transition of the model applied through `update`. Logs carry ids and
// counts, never text.

import { log as defaultLog } from '../log.ts';
import { checkInvariants, isOpen } from './model.ts';
import { CODE } from '../tools/codes.ts';
import { createReadSeam } from '../memory/db/readers/common.ts';
import { intentionsArchiveLines, intentionsValue } from '../memory/db/readers/intentions.ts';
import { createWritesUnderWay } from '../memory/db/writes-under-way.ts';
import type { IntentionsWrite } from '../memory/db/intentions-write.ts';
import { errorCode, idText } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { FlushCounts, Logger } from '../errands/types.ts';
import type { Created, Intention, IntentionStore, IntentionStores, Moved } from './types.ts';

/** The closed intentions the list keeps besides the open ones. */
export const KEEP_CLOSED = 50;

/**
 * `memoryDb` (the memory database service): the list is loaded from the database and `archived` reads it there
 * (src/memory/db/readers/intentions.ts; a failed read throws, with a code). Each change sends the whole list and the
 * records it moved out straight to the database's writer as the write kind `intentions` (`writeIntentions`). The list
 * in memory stays the truth meanwhile, so `add` and `update` answer at once; a write that failed goes again at the next
 * change or `flush`, and `flush({ final: true })` (the shutdown) logs what still fails as lost. Without a `memoryDb`
 * (tests, a tool) nothing is read or written: the list lives in memory only.
 */
export function createIntentionStore({
  log = defaultLog,
  memoryDb = null,
}: {
  now?: () => number;
  log?: Logger;
  memoryDb?: Untyped;
}): IntentionStore {
  const seam = createReadSeam({ memoryDb, log, reader: 'intentions' });
  const state: { list: Array<Intention>; archived: Array<Intention> } = { list: load(), archived: [] };
  const writeIntentions: unknown = memoryDb ? Reflect.get(memoryDb as object, 'writeIntentions') : null;
  const writer: ((write: IntentionsWrite) => Promise<unknown>) | null =
    typeof writeIntentions === 'function'
      ? (write) => Promise.resolve((writeIntentions as (given: IntentionsWrite) => unknown).call(memoryDb, write))
      : null;
  const writes = createWritesUnderWay({ log, name: 'intentions' });
  // A list whose last write failed, and the archived records whose write failed: sent again by the next change or flush.
  let listUnwritten = false;
  const archiveUnwritten: Array<Intention> = [];
  // Counts the list's writes, so only the failure of the latest one marks the list unwritten.
  let listWrites = 0;

  /** The list read once from the database (none without a `memoryDb`). */
  function load(): Array<Intention> {
    if (!memoryDb) return [];
    const db = seam.db();
    const stored = seam.run(() => intentionsValue(db));
    return valid(stored.found ? stored.value : null);
  }

  /** The records of a loaded value that keep the model's invariants. */
  function valid(raw: Untyped): Array<Intention> {
    const list: Array<Untyped> = Array.isArray(raw?.intentions) ? raw.intentions : [];
    const kept: Array<Intention> = list.filter(
      (record) => record && typeof record.id === 'string' && checkInvariants(record) === null
    );
    if (kept.length < list.length)
      log.warn('intentions: records left out on load', { count: list.length - kept.length });
    return kept;
  }

  /** The list kept (every open record, then the latest KEEP_CLOSED closed ones) and the closed records beyond them. */
  function split(list: Array<Intention>): { kept: Array<Intention>; moved: Array<Intention> } {
    const closed = list.filter((record) => !isOpen(record.status));
    if (closed.length <= KEEP_CLOSED) return { kept: list, moved: [] };
    const keep = new Set([...closed].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, KEEP_CLOSED));
    return {
      kept: list.filter((record) => isOpen(record.status) || keep.has(record)),
      moved: list.filter((record) => !isOpen(record.status) && !keep.has(record)),
    };
  }

  /**
   * The list sent whole, the records `moved` out of it to the archive first (so a crash between the
   * two repeats a record in the archive, never loses one), with what an earlier failed write left.
   * Throws without a writer (the caller's change is then not made). Without a `memoryDb` the moved
   * records are kept in memory.
   */
  function persist(list: Array<Intention>, moved: Array<Intention> = []): void {
    if (!memoryDb) {
      state.archived.push(...moved.map(copy));
      return;
    }
    if (!writer) throw Object.assign(new Error('memory db: no writer'), { code: 'DB_CLOSED' });
    const records = [...archiveUnwritten.splice(0), ...moved.map(copy)];
    if (records.length > 0)
      writes.track(
        () => writer({ op: 'archive', records }),
        () => {
          archiveUnwritten.unshift(...records);
        }
      );
    listWrites += 1;
    const sent = listWrites;
    listUnwritten = false;
    writes.track(
      () => writer({ op: 'value', intentions: list.map(copy) }),
      () => {
        if (sent === listWrites) listUnwritten = true;
      }
    );
  }

  /** The archived records, oldest first (a line that does not parse is skipped). Tools only. */
  function archived(): Array<Intention> {
    if (!memoryDb) return state.archived.map(copy);
    const db = seam.db();
    const raw = seam.run(() => intentionsArchiveLines(db)).join('\n');
    const out: Array<Intention> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Intention);
      } catch {
        // a torn line is left alone
      }
    }
    return out;
  }

  function copy(record: Intention): Intention {
    // A stored record is plain JSON, so a round trip through JSON gives the same shape.
    return JSON.parse(JSON.stringify(record)) as Intention;
  }

  /** Every record, oldest first (copies). */
  function list(): Array<Intention> {
    return state.list.map(copy);
  }

  /** The record `id` (a copy), or null. */
  function get(id: unknown): Intention | null {
    const found = state.list.find((record) => record.id === idText(id));
    return found ? copy(found) : null;
  }

  /**
   * A new record added and written; `{ ok: false, code }` for one that breaks an invariant
   * (`checkInvariants`' code) or repeats an id (`duplicate-id`), or `write-failed`.
   */
  function add(record: Intention): Created {
    const broken = checkInvariants(record);
    if (broken) return { ok: false, code: broken };
    if (state.list.some((kept) => kept.id === record.id)) return { ok: false, code: CODE.DUPLICATE_ID };
    const { kept: next, moved } = split([...state.list, copy(record)]);
    try {
      persist(next, moved);
    } catch (err) {
      log.warn('intentions: write failed', { code: errorCode(err) });
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
  function update(id: unknown, move: (record: Intention) => Moved): Moved {
    const index = state.list.findIndex((record) => record.id === idText(id));
    if (index < 0) return { ok: false, code: CODE.NOT_FOUND };
    const result = move(copy(state.list[index]));
    if (!result?.ok) return result ?? { ok: false, code: CODE.BAD_MOVE };
    if (result.changed !== true) return { ok: true, intention: copy(state.list[index]), changed: false };
    const { kept: next, moved } = split(state.list.map((record, i) => (i === index ? copy(result.intention) : record)));
    try {
      persist(next, moved);
    } catch (err) {
      log.warn('intentions: write failed', { id: idText(id), code: errorCode(err) });
      return { ok: false, code: CODE.WRITE_FAILED };
    }
    state.list = next;
    return { ok: true, intention: copy(result.intention), changed: true };
  }

  /**
   * The writes still waiting sent again and awaited; with `final` (the shutdown) what still fails is logged as lost,
   * and the wait ends after `timeoutMs` when given. Nothing without a `memoryDb`.
   */
  async function flush({
    final = false,
    timeoutMs,
  }: { final?: boolean; timeoutMs?: number } = {}): Promise<FlushCounts> {
    if (!writer) return { waiting: 0 };
    const unwritten = (): number => Number(listUnwritten) + Number(archiveUnwritten.length > 0);
    return {
      waiting: await writes.drain({
        final,
        timeoutMs,
        unwritten,
        resend: () => {
          if (unwritten() > 0) persist(state.list);
        },
      }),
    };
  }

  return { list, get, add, update, archived, flush };
}

/**
 * One intention store per place, created on first use. `memoryDb` goes to every store (createIntentionStore); a
 * store whose load failed is not kept, so the next `get` tries again.
 * `dataDir` is read by no one: the units live in the memory database.
 */
export function createIntentionStores({
  now = Date.now,
  log = defaultLog,
  memoryDb = null,
}: {
  dataDir?: string;
  now?: () => number;
  log?: Logger;
  memoryDb?: Untyped;
}): IntentionStores {
  const stores = new Map<string, IntentionStore>();
  const api: IntentionStores = {
    get(): IntentionStore {
      let store = stores.get('persona');
      if (!store) {
        store = createIntentionStore({ now, log, memoryDb });
        stores.set('persona', store);
      }
      return store;
    },
    /** Every store's `flush` (the writes waiting for the database; `final` at the shutdown). */
    async flush(options: { final?: boolean; timeoutMs?: number } = {}): Promise<FlushCounts> {
      let waiting = 0;
      for (const store of stores.values()) waiting += (await store.flush(options)).waiting;
      return { waiting };
    },
  };
  return api;
}
