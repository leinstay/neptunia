// The rig of tests/boundary.test.js: the inner life (src/behavior/inner.js) over the real turn runner, the real event
// door, a real memory database and the fake interface adapter, with a scripted model. No network, no Discord client,
// no data/. `innerRig` is one core; `rig.restart()` is the same core after a restart (a new inner life and a new door
// over the same data directory and the same memory database).
import { createTurnRunner } from '../../src/behavior/turn.js';
import { createInnerLife } from '../../src/behavior/inner.js';
import { createEventDoor } from '../../src/interface/door.js';
import { createFakeAdapter } from '../../src/interface/fake.js';
import { skillRegistry } from '../../src/skills/registry.js';
import { DISCORD, fakeChannel, fakeStore, hotWith, rawMessage, sequenceLlm } from './turn-harness.js';
import { tempDir } from './tmp.js';
import { openTestMemory } from './memory-db/service.js';

/** The rig's first clock reading. */
export const START = Date.parse('2026-10-26T12:00:00Z');
export const GUILD = 'g1';
export const MINUTE = 60_000;

/**
 * What a restarted core keeps.
 * @typedef {object} Share
 * @property {string} dataDir
 * @property {Awaited<ReturnType<typeof openTestMemory>>} memory
 * @property {{ t: number }} clock
 * @property {ReturnType<typeof createFakeAdapter>} port
 * @property {ReturnType<typeof sequenceLlm>} llm
 */

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** The record as the inner life reads it: she spoke in c1 an hour ago, which is where a heartbeat turn runs. */
/** @param {{ t: number }} clock */
function spokeInC1(clock) {
  return {
    *iterate() {
      yield { kind: 'said', occurredAt: new Date(clock.t - 60 * MINUTE).toISOString(), scope: { channel: 'c1' } };
    },
  };
}

/**
 * One core on the fake interface. `answers` are the scripted model's answers (the last one repeats); `interface: false`
 * leaves no client at all, so no conversation can be fetched and nothing is connected; `share` is what a restarted core
 * keeps; `innerLife` overrides the `innerLife` settings.
 * @param {{ answers?: Array<string|object>, interface?: boolean, share?: Share|null, innerLife?: object }} [options]
 */
export async function innerRig({ answers = ['<skip/>'], interface: connected = true, share = null, innerLife = {} } = {}) {
  const clock = share?.clock ?? { t: START };
  const dataDir = share?.dataDir ?? tempDir('nep-boundary-');
  const memory = share?.memory ?? (await openTestMemory({ config: { memoryDb: { wakeRuns: true } }, now: () => clock.t }));
  const port = share?.port ?? createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => clock.t });
  const llm = share?.llm ?? sequenceLlm(answers);
  const history = [rawMessage({ id: 'm1', ts: clock.t - 5 * MINUTE, content: 'καλημέρα' })];
  port.seed('c1', { authorId: 'u1', messageId: 'm1', text: 'καλημέρα' });
  const hot = hotWith({
    features: { innerLife: true, intentions: false, journal: false, coreTools: true },
    skills: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    config: {
      mention: { oneAtATime: true },
      memoryDb: { wakeRuns: true },
      innerLife: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 2,
        review: { enabled: false, historyDays: 14 },
        heartbeat: { enabled: true, everyMinutes: 180, jitterMinutes: 0 },
        caps: { perChain: 3 },
        ...innerLife,
      },
    },
  });
  Object.assign(hot.prompts, { inner: 'Nobody wrote to you; read the wake block.' });
  const client = connected
    ? { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map(), fetch: (/** @type {string} */ id) => Promise.resolve(id === 'c1' ? fakeChannel(history) : null) } }
    : null;
  const calibrator = { ratio: 1, apply: (/** @type {number} */ value) => value, observe: () => {} };
  // The runner's declared parameters are wider than what a test needs (a describer, a fetch), and the fakes are narrower
  // than the real client and port, so the whole argument is cast.
  const turns = createTurnRunner(/** @type {never} */ ({
    discord: DISCORD,
    hot,
    store: fakeStore(),
    llm,
    calibrator,
    client: client ?? { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } },
    now: () => clock.t,
    port,
    skills: skillRegistry(),
    journal: null,
  }));
  /** @type {{ onWake: (event: object) => unknown }} */
  const wake = { onWake: () => ({ status: 'invalid' }) };
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => wake.onWake(event) }, log: SILENT });
  const inner = createInnerLife({
    hot,
    dataDir,
    turns,
    record: spokeInC1(clock),
    client,
    discord: { canSend: () => true },
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    getGuildId: () => GUILD,
    meter: { run: async (/** @type {() => unknown} */ fn) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    memoryDb: memory.memoryDb,
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  wake.onWake = inner.onWake;
  const rig = {
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
    restart: (extra = {}) => innerRig({ answers, interface: connected, innerLife, ...extra, share: { dataDir, memory, clock, port, llm } }),
    /** Draws the heartbeat's moment, moves the clock past it and ticks: the heartbeat turn runs. */
    async beat() {
      await inner.tick();
      clock.t += 181 * MINUTE;
      return inner.tick();
    },
  };
  return rig;
}

/** @typedef {Array<ReturnType<typeof rawMessage>>} History */

/** An empty channel history for `replyTo`. */
export function newHistory() {
  /** @type {History} */
  const history = [];
  return history;
}

/**
 * Every row `sql` selects from the memory database's read connection.
 * @param {{ readHandle(): unknown }} memoryDb
 * @param {string} sql
 * @param {...string} params
 * @returns {Array<Record<string, string>>}
 */
export function rowsOf(memoryDb, sql, ...params) {
  const handle = /** @type {{ db: { prepare(sql: string): { all(...params: string[]): Array<Record<string, string>> } } }|null} */ (
    memoryDb.readHandle()
  );
  return handle ? handle.db.prepare(sql).all(...params).map((row) => ({ ...row })) : [];
}

/**
 * One reply turn to a message `text` by Alice (u1) in c1 on `turns`, the way the door's handler of `message.received` runs it.
 * @param {{ runTurn(params: object): Promise<unknown> }} turns
 * @param {History} history  The channel's lines so far; the new one is added.
 * @param {{ id: string, content: string, at: number }} message
 */
export function replyTo(turns, history, message) {
  const raw = rawMessage({ id: message.id, ts: message.at, content: message.content });
  history.push(raw);
  const trigger = {
    id: message.id,
    channelId: 'c1',
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
