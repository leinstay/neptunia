// An inner life over a real task board (tests/fixtures/selfimprovement-rig.ts) and a fake turn runner, wired the way the
// core wires its heartbeat and selfimprovement sources today, for the tests of which wake delivers what. The heartbeat's
// `landed` and `ackLanded` stay in its sources on purpose: code that reads them is what those tests catch. Synthetic data.
import { createInnerLife } from '../../src/behavior/inner.ts';
import { ackOutbox, proposalsOf } from '../../src/behavior/selfimprovement-view.ts';
import type { SelfimprovementFacts } from '../../src/behavior/selfimprovement-view.ts';
import { createEventDoor } from '../../src/interface/door.ts';
import { createIntentionService } from '../../src/intentions/service.ts';
import { createIntentionStores } from '../../src/intentions/store.ts';
import { ackLanded, landedFor } from '../../src/selfimprovement/landed.ts';
import type { BoardCaller } from '../../src/tools/impl/board.ts';
import { tempDir } from './tmp.ts';
import { useIface, world } from './turn-world.ts';

useIface('fake');
const GUILD = 'g1';
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

export type WakeCall = {
  inner: { wake: { kind: string; selfimprovement?: SelfimprovementFacts | null } & Record<string, unknown> };
};

export type WakeLife = {
  clock: { t: number };
  life: ReturnType<typeof createInnerLife>;
  calls: Array<WakeCall>;
  /** The outcome the next turns answer with. */
  next: { outcome: string; reason?: string };
};

export function wakeLife(
  caller: BoardCaller,
  {
    start,
    heartbeat = { enabled: false },
    selfimprovement = { enabled: true, at: '03:00', failuresPerShape: 3 },
    rng = () => 0.5,
    onTurn = null,
  }: {
    start: number;
    heartbeat?: Record<string, unknown>;
    selfimprovement?: Record<string, unknown>;
    rng?: () => number;
    onTurn?: ((call: WakeCall) => Promise<void>) | null;
  }
): WakeLife {
  const clock = { t: start };
  world().channel({ id: 'c1', name: 'chan-c1', placeId: GUILD, permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat,
      selfimprovement,
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-wake-life-'), now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  const calls: Array<WakeCall> = [];
  const next: WakeLife['next'] = { outcome: 'skip' };
  const turns = {
    isAnyBusy: () => false,
    runTurn: async (params: WakeCall) => {
      calls.push(params);
      await onTurn?.(params);
      return { outcome: next.outcome, reason: next.reason ?? 'nothing-to-do', inner: { actions: [], turnId: `t-${calls.length}` } };
    },
  };
  const journal = { inner: () => Promise.resolve(), read: () => [] };
  const heartbeatSources = {
    tasks: () => [],
    landed: async () => (await landedFor(caller)).landed,
    ackLanded: (seqs: ReadonlyArray<number>) => ackLanded(caller, seqs),
  };
  // The channel a channelless wake anchors on: the last place she spoke in.
  const record = {
    async *iterate() {
      await Promise.resolve();
      yield { kind: 'said', occurredAt: new Date(start - 3_600_000).toISOString(), scope: { channel: 'c1' } };
    },
  };
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-wake-life-inner-'),
    turns,
    intentions: service,
    journal,
    reads: world().reads,
    iface: () => 'fake',
    conversationName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    record,
    heartbeat: heartbeatSources,
    selfimprovement: {
      granted: () => [],
      skills: () => [],
      proposals: () => proposalsOf(caller),
      ackOutbox: (seqs: ReadonlyArray<number>) => ackOutbox(caller, seqs),
      landed: async () => (await landedFor(caller)).landed,
    },
    rng,
    now: () => clock.t,
    log: SILENT,
  });
  return { clock, life, calls, next };
}

/** The calls of one wake kind. */
export function callsOf(run: WakeLife, kind: string): Array<WakeCall> {
  return run.calls.filter((call) => call.inner.wake.kind === kind);
}
