// Pieces of the inner life's test rig (tests/inner.test.ts): a seeded random stream for its draws, and the memory
// database of an inner life under test with the reads of its wake queue (src/memory/db/wake-queue.ts). The queue, the
// handled set and the in-flight mark live in the database, never in inner.json (stage 4 cut, the lead's decision 1), so
// a test that checks what is durable reads them here. The service runs on the calling thread over the test's data
// directory, so the open imports any inner.json the test wrote. Synthetic data only.
import fs from 'node:fs';
import path from 'node:path';
import { createInnerLife } from '../../src/behavior/inner.ts';
import type { InnerLifeOptions } from '../../src/behavior/inner.ts';
import type { InnerTurnParams, Measured, Wake } from '../../src/behavior/inner/types.ts';
import type { Intention } from '../../src/intentions/types.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { createEventDoor } from '../../src/interface/door.ts';
import { DAY_MS, MINUTE_MS } from '../../src/time.ts';
import { wakeOf } from '../../src/memory/db/wake-queue.ts';
import type { StoredWake } from '../../src/memory/db/wake-queue.ts';
import { openTestMemorySync } from './memory-db/service.ts';
import { tempDir } from './tmp.ts';
import { world } from './turn-world.ts';
import { wrongly } from './loose-types.ts';

/** The node:sqlite shape of the service's read connection while the database is open. */
type Read = { db: { prepare(sql: string): { all(...params: Array<string>): Array<unknown> } } };

/** A seeded stream in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether `value` is a read connection: an object whose `db` can prepare a statement. */
function isRead(value: unknown): value is Read {
  const db: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'db') : null;
  return typeof db === 'object' && db !== null && typeof Reflect.get(db, 'prepare') === 'function';
}

/** What the rig's tests read of the wake queue. */
export type WakeMemory = {
  memoryDb: ReturnType<typeof openTestMemorySync>['memoryDb'];
  /** The stored wakes in `state`, the oldest queued first. */
  wakes(state: string): Array<StoredWake | null>;
  /** One stored wake, or null. */
  wake(id: string): StoredWake | null;
  /** The queued wakes as the queue holds them (a stored wake's payload is the wake). */
  queue(): Array<Wake>;
};

/** The memory database over `dataDir`, opened now with the clock `now`, and the reads of its wake queue. */
export function wakeMemory(dataDir: string, now: () => number): WakeMemory {
  const { memoryDb } = openTestMemorySync({ dataDir, now });
  const read = (): Read => {
    const handle: unknown = memoryDb.readHandle();
    if (!isRead(handle)) throw new Error('the memory database is not open');
    return handle;
  };
  const wakes = (state: string): Array<StoredWake | null> =>
    read()
      .db.prepare('SELECT id FROM wakes WHERE state = ? ORDER BY queued_at, id')
      .all(state)
      .map((row) => wakeOf(read(), String(Reflect.get(Object(row), 'id'))));
  return {
    memoryDb,
    wakes,
    wake: (id) => wakeOf(read(), id),
    // The payload is the wake object the queue stored whole (wake-queue.ts#queueWake).
    queue: () => wakes('queued').flatMap((stored) => (stored ? [stored.payload as Wake] : [])),
  };
}

export const NOW = Date.parse('2026-10-19T12:00:00Z');
export const SILENT: { info(): void; warn(): void; error(): void } = { info() {}, warn() {}, error() {} };
export const GUILD = 'g1';
/** The test's clock: every inner life built here reads it; a test moves it. */
export const clock = { t: NOW };

/** An intention record as the fakes keep it: the fields the inner life reads, and whatever else a test adds. */
export type FakeIntention = {
  id: string;
  status: string;
  purpose: string;
  dueAt: number | null;
  chainId: string | null;
  destination: string | null;
  provenance: { kind: string; channelId: string; scope: string };
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  [field: string]: unknown;
};

/** A pending intention due a minute ago in channel `c1`, unless `fields` say otherwise. */
export function intention(
  id: string,
  {
    dueAt = NOW - MINUTE_MS,
    channelId = 'c1',
    chainId = null,
    status = 'pending',
    purpose = `purpose ${id}`,
  }: { dueAt?: number | null; channelId?: string; chainId?: string | null; status?: string; purpose?: string } = {}
): FakeIntention {
  return {
    id,
    status,
    purpose,
    dueAt,
    chainId,
    destination: null,
    provenance: { kind: 'self', channelId, scope: 'group' },
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    expiresAt: NOW + 7 * DAY_MS,
  };
}

export type FakeIntentions = {
  records: Array<FakeIntention>;
  due(): Array<{ intention: Intention; reason: string; at: number }>;
  reconcile(): { arrived: number; missing: number; deadline: number; expired: number };
  list(): Array<FakeIntention>;
  store(): { get(id: string): FakeIntention | null; list(): Array<FakeIntention> };
};

/** A fake intention service over `records` (mutable): due ones are pending with a passed dueAt. */
export function fakeIntentions(records: Array<FakeIntention>): FakeIntentions {
  return {
    records,
    due: () =>
      records
        .filter(
          (r) =>
            r.status === 'pending' &&
            typeof r.dueAt === 'number' &&
            Number.isFinite(r.dueAt) &&
            r.dueAt <= NOW + 10 * DAY_MS &&
            r.dueAt <= clock.t
        )
        .map((r) => ({ intention: wrongly<Intention>(r), reason: 'due', at: wrongly<number>(r.dueAt) })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records.filter((r) => ['pending', 'waiting', 'proposed'].includes(r.status)),
    store: () => ({
      get: (id: string) => records.find((r) => r.id === id) ?? null,
      list: () => records,
    }),
  };
}

/** A fake turn runner: records every call, answers `answer(params)` (default a silent skip). */
export type FakeTurns = {
  busy: boolean;
  calls: Array<InnerTurnParams>;
  isAnyBusy(): boolean;
  runTurn(params: InnerTurnParams): Promise<unknown>;
};

export function fakeTurns({ answer = null }: { answer?: ((params: InnerTurnParams) => unknown) | null } = {}): FakeTurns {
  const calls: Array<InnerTurnParams> = [];
  const turns: FakeTurns = {
    busy: false,
    calls,
    isAnyBusy: () => turns.busy,
    runTurn: (params) => {
      calls.push(params);
      if (answer) return Promise.resolve(answer(params));
      return Promise.resolve({
        outcome: 'skip',
        reason: 'nothing-to-do',
        inner: { actions: [], turnId: `t-${calls.length}` },
      });
    },
  };
  return turns;
}

/** The test world's channels (each `can` send or not) and the reads over them. */
export function fakeClient(
  ids = ['c1', 'c2', 'c3'],
  can: (channel: { id: string }) => boolean = () => true
): { reads: ReturnType<typeof world>['reads'] } {
  for (const id of ids) world().channel({ id, name: `chan-${id}`, guildId: GUILD, permissions: { send: can({ id }) } });
  return { reads: world().reads };
}

// PR 7d: the switches are code and the queue (20), the chat slice (30) and the review switch (on) are constants, so
// the config holds only the keys that are still settings.
export function hotWith({
  innerLife = {},
  heartbeat = { enabled: false },
  timezone = 'UTC',
}: { innerLife?: Record<string, unknown>; heartbeat?: Record<string, unknown>; timezone?: string } = {}): {
  config: { bot: { timezone: string }; innerLife: Record<string, unknown>; heartbeat: Record<string, unknown> };
} {
  return {
    config: {
      bot: { timezone },
      innerLife: {
        mode: 'shadow',
        tickSeconds: 60,
        review: { historyDays: 14 },
        caps: { perChain: 3 },
        ...innerLife,
      },
      heartbeat,
    },
  };
}

/** What `setup` takes; each is what the inner life itself takes, a fake by default. */
export type SetupOptions = {
  records?: Array<FakeIntention>;
  hot?: InnerLifeOptions['hot'];
  turns?: ReturnType<typeof fakeTurns>;
  dataDir?: string;
  record?: InnerLifeOptions['record'];
  meterUsd?: number;
  meter?: InnerLifeOptions['meter'];
  rng?: () => number;
  client?: ReturnType<typeof fakeClient>;
  peopleWaiting?: () => boolean;
  service?: InnerLifeOptions['intentions'];
  memoryDb?: InnerLifeOptions['memoryDb'];
  log?: InnerLifeOptions['log'];
  review?: boolean;
};

/** One inner life over a temp data dir with a real door; `records` its intentions. */
export function setup({
  records = [],
  hot = hotWith(),
  turns = fakeTurns(),
  dataDir = tempDir('nep-inner-'),
  record = null,
  meterUsd = 0.1,
  meter = null,
  rng = seeded(7),
  client = fakeClient(),
  peopleWaiting = () => false,
  service = null,
  memoryDb = null,
  log = SILENT,
  review = false,
}: SetupOptions = {}): {
  inner: ReturnType<typeof createInnerLife>;
  turns: FakeTurns;
  journal: Array<Record<string, Untyped>>;
  intentions: FakeIntentions;
  dataDir: string;
  door: ReturnType<typeof createEventDoor>;
  hot: InnerLifeOptions['hot'];
} {
  // PR 7d: the daily review is code; a test that is not about it starts on a day whose review is done.
  const stateFile = path.join(dataDir, 'guilds', GUILD, 'inner.json');
  if (!review && !fs.existsSync(stateFile)) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const day = new Date(clock.t).toISOString().slice(0, 10);
    fs.writeFileSync(stateFile, JSON.stringify({ review: { day, at: null, done: true } }));
  }
  const journal: Array<Record<string, Untyped>> = [];
  // A test that hands in a real service reads it through the members the fake has.
  const intentions = service ? wrongly<ReturnType<typeof fakeIntentions>>(service) : fakeIntentions(records);
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  const inner = createInnerLife({
    hot,
    dataDir,
    turns,
    intentions: wrongly<InnerLifeOptions['intentions']>(intentions),
    record,
    journal: { inner: (guildId, fields) => journal.push(fields) },
    reads: client.reads,
    iface: () => 'fake',
    // The names come from the directory of `conversation.changed` events in the core; the fake client's names stand in for it.
    conversationName: (id) => (id === 'd1' ? 'dm' : `chan-${id}`),
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    getGuildId: () => GUILD,
    peopleWaiting,
    meter: meter ?? { run: async (fn): Promise<Measured> => ({ result: await fn(), usd: meterUsd, requests: 1, voice: 1 }) },
    ...(memoryDb ? { memoryDb } : {}),
    rng,
    now: () => clock.t,
    log,
  });
  return { inner, turns, journal, intentions, dataDir, door, hot };
}
