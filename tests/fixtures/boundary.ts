// The rig of tests/boundary.test.ts: the inner life (src/behavior/inner.ts) over the real turn runner, the real event
// door, a real memory database and the fake interface adapter, with a scripted model. No network, no Discord client,
// no data/. `innerRig` is one core; `rig.restart()` is the same core after a restart (a new inner life and a new door
// over the same data directory and the same memory database).
import type { Wake } from '../../src/behavior/inner/types.ts';
import { createInnerLife } from '../../src/behavior/inner.ts';
import { createEventDoor } from '../../src/interface/door.ts';
import { createFakeAdapter } from '../../src/interface/fake.ts';
import { skillRegistry } from '../../src/tools/registry.ts';
import { createTurnRunner, fakeChannel, fakeStore, hotWith, rawMessage, sequenceLlm } from './turn-harness.ts';
import { freshWorld, world } from './turn-world.ts';
import { tempDir } from './tmp.ts';
import { openTestMemory } from './memory-db/service.ts';

/** The rig's first clock reading. */
export const START = Date.parse('2026-10-26T12:00:00Z');
export const GUILD = 'g1';
export const MINUTE = 60_000;

/** What a restarted core keeps. */
type Share = {
  dataDir: string;
  memory: Awaited<ReturnType<typeof openTestMemory>>;
  clock: { t: number };
  port: ReturnType<typeof createFakeAdapter>;
  llm: ReturnType<typeof sequenceLlm>;
};

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** The record as the inner life reads it: she spoke in c1 an hour ago, which is where a heartbeat turn runs. */
function spokeInC1(clock: { t: number }) {
  return {
    *iterate() {
      yield { kind: 'said', occurredAt: new Date(clock.t - 60 * MINUTE).toISOString(), scope: { channel: 'c1' } };
    },
  };
}

/** One core of the rig: its clock, its parts and the helpers a test drives them with. */
export type Rig = Share & {
  inner: ReturnType<typeof createInnerLife>;
  door: ReturnType<typeof createEventDoor>;
  /** The wake runs the memory database holds, oldest first. */
  wakeRuns(): Array<Record<string, string>>;
  /** Lets the writes of the last turn land (the run is recorded through promises). */
  settle(): Promise<void>;
  /** The same core after a restart: a new inner life and door over the same data directory and memory. */
  restart(extra?: object): Promise<Rig>;
  /** Draws the heartbeat's moment, moves the clock past it and ticks: the heartbeat turn runs. */
  beat(): ReturnType<ReturnType<typeof createInnerLife>['tick']>;
};

/**
 * One core on the fake interface. `answers` are the scripted model's answers (the last one repeats); `interface: false`
 * leaves no client at all, so no chat can be fetched and nothing is connected; `share` is what a restarted core
 * keeps; `wakes` overrides the `wakes` settings and `heartbeat` replaces the `heartbeat` settings.
 */
export async function innerRig({
  answers = ['<skip/>'],
  interface: connected = true,
  share = null,
  wakes = {},
  heartbeat = { enabled: true, everyMinutes: 180, jitterMinutes: 0 },
}: {
  answers?: Array<string | object>;
  interface?: boolean;
  share?: Share | null;
  wakes?: object;
  heartbeat?: object;
} = {}): Promise<Rig> {
  const clock = share?.clock ?? { t: START };
  const dataDir = share?.dataDir ?? tempDir('nep-boundary-');
  const memory = share?.memory ?? (await openTestMemory({ config: { memoryDb: { wakeRuns: true } }, now: () => clock.t }));
  const port = share?.port ?? createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => clock.t });
  const llm = share?.llm ?? sequenceLlm(answers);
  if (share === null) {
    // A first core starts a world with #general (c1) and Alice's line; a restarted one finds them as they were.
    freshWorld();
    fakeChannel([rawMessage({ id: 'm1', ts: clock.t - 5 * MINUTE, content: 'καλημέρα' })]);
  }
  const hot = hotWith({
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    config: {
      mention: { oneAtATime: true },
      memoryDb: { wakeRuns: true },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 2,
        review: { enabled: false, historyDays: 14 },
        caps: { perChain: 3 },
        ...wakes,
      },
      heartbeat,
    },
  });
  Object.assign(hot.prompts, { inner: 'Nobody wrote to you; read the wake block.' });
  const calibrator = { ratio: 1, apply: (value: number) => value, observe: () => {} };
  const turns = createTurnRunner({
    hot,
    store: fakeStore(),
    llm,
    calibrator,
    now: () => clock.t,
    port,
    skills: skillRegistry(),
    journal: null,
  });
  const wake: { onWake: (event: Wake) => unknown } = { onWake: () => ({ status: 'invalid' }) };
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => wake.onWake(event) }, log: SILENT });
  const inner = createInnerLife({
    hot,
    dataDir,
    turns,
    record: spokeInC1(clock),
    // With no interface connected there is nothing to ask about a chat.
    reads: connected ? world().adopt(port) : null,
    iface: () => 'fake',
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    memoryDb: memory.memoryDb,
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  wake.onWake = inner.onWake;
  const rig: Rig = {
    clock,
    dataDir,
    memory,
    port,
    llm,
    inner,
    door,
    /** The wake runs the memory database holds, oldest first. */
    wakeRuns() {
      return rowsOf(memory.memoryDb, 'SELECT id, kind, status, outcome FROM wake_runs ORDER BY started_at, id');
    },
    /** Lets the writes of the last turn land (the run is recorded through promises). */
    async settle() {
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    /** The same core after a restart: a new inner life and door over the same data directory and memory. */
    restart: (extra: object = {}): ReturnType<typeof innerRig> => innerRig({ answers, interface: connected, wakes, heartbeat, ...extra, share: { dataDir, memory, clock, port, llm } }),
    /** Draws the heartbeat's moment, moves the clock past it and ticks: the heartbeat turn runs. */
    async beat() {
      await inner.tick();
      clock.t += 181 * MINUTE;
      return inner.tick();
    },
  };
  return rig;
}

type History = Array<ReturnType<typeof rawMessage>>;

/** An empty channel history for `replyTo`. */
export function newHistory(): History {
  const history: History = [];
  return history;
}

/** Every row `sql` selects from the memory database's read connection. */
export function rowsOf(memoryDb: { readHandle(): unknown }, sql: string, ...params: Array<string>): Array<Record<string, string>> {
  const handle = memoryDb.readHandle() as {
    db: { prepare(sql: string): { all(...params: Array<string>): Array<Record<string, string>> } };
  } | null;
  return handle ? handle.db.prepare(sql).all(...params).map((row) => ({ ...row })) : [];
}

/**
 * One reply turn to a message `text` by Alice (u1) in c1 on `turns`, the way the door's handler of `message.received` runs it.
 * `history` holds the channel's lines so far; the new one is added.
 */
export function replyTo(
  turns: { runTurn(params: object): Promise<unknown> },
  history: History,
  message: { id: string; content: string; at: number }
): Promise<unknown> {
  const raw = rawMessage({ id: message.id, ts: message.at, content: message.content });
  history.push(raw);
  const trigger = {
    id: message.id,
    placeId: 'c1',
    authorId: 'u1',
    authorName: 'Alice',
    self: false,
    bot: false,
    content: message.content,
    ts: message.at,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
  return turns.runTurn({ channel: fakeChannel(history), mode: 'reply', trigger, triggerKind: 'mention' });
}
