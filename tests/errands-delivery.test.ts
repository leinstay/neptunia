// The delivery mark of an errand's end (src/errands/store.ts#markDelivered) reaches the board while the core runs. The
// door takes her `errand.done` as soon as the end's own write committed, often before that write's promise settled in
// the store's outbox, and the mark must still land then, not only at the core's stop: a core that crashes after the
// delivery and starts again must find the end delivered, or it opens a second result turn. The memory service is the
// real one on the calling thread (fixtures/memory-db/service.js); a gate holds the store's writes after they commit, so
// the end is on the board while its write still counts as under way. No flush runs between the mark and the restart.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createErrandStore } from '../src/errands/store.ts';
import type { ErrandStore } from '../src/errands/types.ts';
import { openTestMemorySync, tempDataDir } from './fixtures/memory-db/service.js';
import { GUILD, T0 } from './fixtures/errand-archive.ts';

const NOW = T0 + 60 * 60 * 1000;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const CONFIG = {
  errands: { maxOpen: 3 },
  agents: { scout: { daily: { tasks: 5 } } },
};
const ASKED = {
  agent: 'scout',
  goal: 'find the opening hours of the library',
  requester: { userId: 'u1', kind: 'member' },
  origin: { channelId: 'c1', messageId: 'm7' },
  scope: 'group' as const,
};
const DONE = { status: 'done', result: { text: 'Open until eight.', sources: [], files: [] }, usage: { usd: 0.02 } };

type MemoryDb = ReturnType<typeof openTestMemorySync>['memoryDb'];

const OPENED: Array<{ close: () => unknown }> = [];
after(async () => {
  for (const memory of OPENED) await memory.close();
});

let counter = 0;
const uuid = (): string => `${(counter += 1).toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;

const storeOver = (memoryDb: MemoryDb): ErrandStore =>
  createErrandStore({ guildId: GUILD, now: () => NOW, config: () => CONFIG, uuid, log: SILENT, memoryDb });

/** A few turns of the event loop, with no flush of any store. */
async function ticks(n = 20): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `memoryDb` with its unit writes held after they commit: each write lands in the database at once, and its promise
 * settles only while the gate is open (`hold` closes it, `release` opens it).
 */
function gated(memoryDb: MemoryDb): { memoryDb: MemoryDb; hold: () => void; release: () => void } {
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => {};
  const writeUnit = async (update: unknown): Promise<unknown> => {
    const written: unknown = await memoryDb.writeUnit(update);
    await gate;
    return written;
  };
  // The fixture's service is a plain object of functions; the gated one differs from it in `writeUnit` alone.
  const wrapped: MemoryDb = { ...memoryDb, writeUnit };
  return {
    memoryDb: wrapped,
    hold: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
  };
}

test('an end marked delivered while its own write is still under way is delivered on the board without a stop', async () => {
  const memory = openTestMemorySync({ dataDir: tempDataDir('nep-errands-delivery-'), now: () => NOW, log: SILENT });
  OPENED.push(memory);
  const slow = gated(memory.memoryDb);
  const store = storeOver(slow.memoryDb);
  const added = store.add(ASKED);
  const id = added.errand?.id ?? '';
  store.start(id);
  await store.flush();
  slow.hold();
  store.finish(id, DONE);
  // The end commits on the board while the store's write of it is still held.
  for (let i = 0; i < 50 && storeOver(memory.memoryDb).pendingEnds().length === 0; i += 1) await ticks(1);
  assert.equal(store.markDelivered(id), true);
  slow.release();
  await ticks();
  // A core started again after a crash: no stop flushed the first store.
  assert.deepEqual(storeOver(memory.memoryDb).pendingEnds(), []);
});
