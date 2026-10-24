// The writes of memory units waiting for the database (stage W2b, spec 2026-10-24-memory-authority, section 6 item 3):
// under authority `db` the store's cache (src/memory/store.js) and the module stores (src/intentions/store.js,
// src/errands/store.js) hand the units they changed to an outbox instead of writing a file, and the outbox sends them
// through the writer (`memoryDb.writeUnit`, unit-write.js). A unit stays in the outbox until its write resolved, so the
// caller's in-process value is the truth meanwhile and a failed write is never lost:
//   - `value(owner, value)`   a whole JSON unit (op `value`): a newer value of the same unit replaces the one waiting
//                             (the latest is all the database needs);
//   - `lines(owner, lines)`   lines of a JSONL unit (op `lines`, mode `db`): appended to what waits for that unit, in
//                             order;
//   - `push()`                sends what waits, at most one write per unit under way (so the lines of one unit land
//                             in their order); a failed write goes back in front of what came meanwhile and is tried
//                             again at the next push; resolves once the writes it started settled;
//   - `flush({ rounds })`     pushes until nothing waits or a round wrote nothing more;
//   - `keep()`                at shutdown: every unit still waiting is handed to `memoryDb.keepPending` (the
//                             `memory-pending/` folder the service replays at its next start) and leaves the outbox;
//                             returns how many, an error logged with the count;
//   - `holds(owner)`          whether a write of the unit waits or is under way (its cache entry is not clean yet);
//   - `size()`                how many units wait or are under way.
// Logs carry codes and counts only.

const noop = () => {};

/**
 * @param {{ memoryDb: { writeUnit: Function, keepPending?: Function }, log?: object, name: string }} options
 *   `name` says whose outbox it is in the logs (`store`, `intentions`, `tasks`).
 */
export function createUnitOutbox({ memoryDb, log = { warn: noop, error: noop, debug: noop }, name }) {
  // owner -> { op: 'value', value } | { op: 'lines', lines: [] }
  const waiting = new Map();
  // owner -> the promise of the write under way
  const sending = new Map();

  function value(owner, next) {
    waiting.set(owner, { op: 'value', value: next });
  }

  function lines(owner, list) {
    if (!Array.isArray(list) || list.length === 0) return;
    const held = waiting.get(owner);
    if (held?.op === 'lines') held.lines.push(...list);
    else waiting.set(owner, { op: 'lines', lines: [...list] });
  }

  /** The update of a waiting unit, as the writer takes it. */
  const updateOf = (owner, item) => (item.op === 'value' ? { op: 'value', owner, value: item.value } : { op: 'lines', mode: 'db', owner, lines: item.lines });

  /** A failed write back in the outbox: a newer value stays; lines go in front of the ones that came meanwhile. */
  function putBack(owner, item) {
    const now = waiting.get(owner);
    if (item.op === 'value') {
      if (!now) waiting.set(owner, item);
      return;
    }
    if (now?.op === 'lines') now.lines.unshift(...item.lines);
    else waiting.set(owner, item);
  }

  async function push() {
    const started = [];
    let failed = 0;
    let code = null;
    for (const [owner, item] of [...waiting]) {
      if (sending.has(owner)) continue;
      waiting.delete(owner);
      const done = Promise.resolve()
        .then(() => memoryDb.writeUnit(updateOf(owner, item)))
        .then(() => true, (error) => {
          putBack(owner, item);
          failed += 1;
          code = error?.code ?? null;
          return false;
        })
        .finally(() => { if (sending.get(owner) === done) sending.delete(owner); });
      sending.set(owner, done);
      started.push(done);
    }
    const results = await Promise.all(started);
    if (failed > 0) log.warn('memory db: unit write failed', { reader: name, units: failed, code });
    return results.filter(Boolean).length;
  }

  /** Pushes until nothing waits, or a round brought no write through (then what is left waits for the next push). */
  async function flush({ rounds = 3 } = {}) {
    for (let round = 0; round < rounds; round += 1) {
      await Promise.allSettled([...sending.values()]);
      if (waiting.size === 0) break;
      if (await push() === 0) break;
    }
    await Promise.allSettled([...sending.values()]);
    return waiting.size;
  }

  function keep() {
    if (waiting.size === 0) return 0;
    let kept = 0;
    let code = null;
    for (const [owner, item] of [...waiting]) {
      try {
        if (typeof memoryDb?.keepPending !== 'function') throw Object.assign(new Error('memory db: no pending folder'), { code: 'NO_PENDING' });
        memoryDb.keepPending(updateOf(owner, item));
        waiting.delete(owner);
        kept += 1;
      } catch (error) {
        code = error?.code ?? null;
      }
    }
    if (kept > 0) log.error('memory db: units kept pending', { reader: name, units: kept });
    if (waiting.size > 0) log.error('memory db: units lost', { reader: name, units: waiting.size, code });
    return kept;
  }

  return {
    value,
    lines,
    push,
    flush,
    keep,
    holds: (owner) => waiting.has(owner) || sending.has(owner),
    size: () => new Set([...waiting.keys(), ...sending.keys()]).size,
  };
}
