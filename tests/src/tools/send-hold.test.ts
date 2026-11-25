import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createAdmin } from '../../../src/admin.ts';
import { createInnerLife } from '../../../src/behavior/inner.ts';
import { deliveriesOf } from '../../../src/behavior/inner/deliveries.ts';
import type { InnerTurnParams } from '../../../src/behavior/inner/types.ts';
import { createIntentionService } from '../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../src/intentions/store.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { deliveriesIn, type WakeQueueUpdate } from '../../../src/memory/db/wake-queue.ts';
import '../../../src/tools/operations/index.ts';
import { bindPublicationPort, type PublicationBoundary } from '../../../src/tools/publication.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createSendHold, heldPort } from '../../../src/tools/send-hold.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { coreTurn, DISCORD, fakeStore, hotWith, personaGrants, rawMessage } from '../../fixtures/turn-harness.ts';
import { type Fake, useIface, world } from '../../fixtures/turn-world.ts';
import { worldTurnRunner } from '../../fixtures/world-runner.ts';

const ROOT = 'g1';

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const T = Date.parse('2026-10-31T12:00:00Z');

const LEASE_MS = MINUTE;

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const INNER_TASK = 'Nobody wrote to you; read the wake block.';

const CLIENT = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };

/** The answer of a model call that never comes back: the process dies inside it. */
const DIES = Object.freeze({ dies: true });

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

type PauseFlags = { paused?: boolean; pausedAt?: string };

/** What one start of the core is given: the model's answers in turn (the last repeats), and how it dies. */
type Start = {
  publicationBoundary?: unknown;
  answers: ReadonlyArray<unknown>;
  /** The memory write that leaves a delivery queued never answers: the process dies right after that commit. */
  dieAtCommit?: boolean;
  /** The port the inner life sends through (the world's by default). */
  port?: Fake;
  /** Called with the inner life when a write first leaves a delivery queued, right after that commit. */
  atCommit?: (life: ReturnType<typeof createInnerLife>) => void;
};

/** The record of the persona's lines (src/memory/record.ts), as the turn runner and the inner life append to it. */
type Record_ = {
  lines: Array<unknown>;
  append(placeId: string, lines: ReadonlyArray<unknown>, options?: unknown): Promise<void>;
  iterate(): Array<unknown>;
};

/** The texts of the sends that reached `port`, in order. */
function sendsOf(port: Fake): Array<unknown> {
  return port.calls.filter((one) => one.op === 'send').map((one): unknown => Reflect.get(Object(one.args[1]), 'text'));
}

/** The persona's calls of a turn's result as `<skill>:<code>`, in the order they made them. */
function actionsOf(result: unknown): Array<string> {
  const inner: unknown = Reflect.get(Object(result), 'inner');
  const actions: unknown = Reflect.get(Object(inner), 'actions');
  if (!Array.isArray(actions)) return [];
  return actions.map((action: unknown) => {
    const skill: unknown = Reflect.get(Object(action), 'skill');
    const code: unknown = Reflect.get(Object(action), 'code');
    return `${String(skill)}:${typeof code === 'string' ? code : ''}`;
  });
}

/** The result status of the persona's call of `skill` in a turn's result, or null. */
function resultOf(result: unknown, skill: string): unknown {
  const inner: unknown = Reflect.get(Object(result), 'inner');
  const actions: unknown = Reflect.get(Object(inner), 'actions');
  if (!Array.isArray(actions)) return null;
  const found: unknown = actions.find((action: unknown) => Reflect.get(Object(action), 'skill') === skill);
  if (found === undefined) return null;
  const status: unknown = Reflect.get(Object(found), 'result');
  return status;
}

/** The service's read connection, which its JS source leaves untyped; refused when the database is not open. */
function readHandleOf(memory: Memory): { db: object } {
  const handle: unknown = memory.memoryDb.readHandle();
  const db: unknown = typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'db') : null;
  if (typeof db !== 'object' || db === null) throw new Error('the memory database is not open');
  return { db };
}

/** A model that answers `answers` in turn, records each request and the sends `port` had when it came, and can die. */
function scriptedModel(answers: ReadonlyArray<unknown>, port: Fake, died: () => void) {
  const requests: Array<string> = [];
  const sendsAtRequest: Array<number> = [];
  return {
    requests,
    sendsAtRequest,
    complete: (messages: unknown, options?: unknown): Promise<unknown> => {
      const tools: unknown = Reflect.get(Object(options), 'tools');
      requests.push(JSON.stringify({ messages, tools }));
      sendsAtRequest.push(sendsOf(port).length);
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
      if (answer === DIES) {
        died();
        return new Promise<unknown>(() => {});
      }
      return Promise.resolve(completionOf(answer));
    },
  };
}

/**
 * The live config of the core: the inner life in `mode`, the heartbeat on only when asked (every hour, no jitter).
 * PR 7d: the switches are code and a heartbeat holds to intention changes.
 */
function hotOf(mode: 'live' | 'shadow', heartbeat: boolean) {
  const hot = hotWith({
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['lore.list', 'message.create', 'message.edit', 'message.react.add', 'intention.set']),
    config: {
      wakes: {
        mode,
        tickSeconds: 60,
        review: { historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: heartbeat ? { enabled: true, everyMinutes: 60, jitterMinutes: 0 } : { enabled: false },
    },
  });
  Object.assign(hot.config.context, { turnLeaseMs: LEASE_MS });
  Object.assign(hot.config, { intentions: { expiresDays: 14, maxOpen: 20 } });
  Object.assign(hot.prompts, { 'turn/inner': INNER_TASK });
  return hot;
}

/**
 * One core over a data directory, started with `first`: the memory database, a real turn runner and an inner life with
 * its door, over the world's channel c1. `restart(start)` opens a new database and builds a new runner and inner life over the same
 * directory, as a new process would; what ran in the old ones is left hanging. The clock, the intentions, the pause
 * flags and the interface outlive a restart.
 */
async function core(
  first: Start,
  {
    mode = 'live',
    heartbeat = false,
    record = null,
  }: { mode?: 'live' | 'shadow'; heartbeat?: boolean; record?: Record_ | null } = {}
) {
  // The heartbeat has no place: with reads that say no interface answers, it runs in its stand-in (drain.ts).
  const reads = heartbeat
    ? { chatInfo: world().reads.chatInfo.bind(world().reads), offers: () => false }
    : world().reads;
  world().channel({
    id: 'c1',
    name: 'chan-c1',
    placeId: ROOT,
    permissions: { send: true },
    historyMessages: [rawMessage({ id: 'm1', ts: T - HOUR, content: 'καλή σας μέρα' })],
  });
  const port = world().port;
  const clock = { t: T };
  const hot = hotOf(mode, heartbeat);
  const dataDir = tempDir('nep-inner-wake-sends-');
  const flags: PauseFlags = {};
  const service = createIntentionService({
    stores: createIntentionStores({ now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  const calls: Array<InnerTurnParams> = [];
  const results: Array<unknown> = [];

  /** A turn runner over the world, with a model that answers `answers`. */
  const runnerOf = (answers: ReadonlyArray<unknown>, died: () => void) => {
    const llm = scriptedModel(answers, port, died);
    const store = fakeStore();
    const admin = createAdmin({
      discord: DISCORD,
      hot,
      store,
      client: CLIENT,
      isServedRoot: (id: unknown) => id === ROOT,
      port,
      reads: world().reads,
      intentions: service,
      now: () => clock.t,
    });
    const runner = worldTurnRunner({
      hot,
      store,
      llm,
      calibrator: { ratio: 1, apply: (value: number) => value, observe: () => {} },
      now: () => clock.t,
      skills: skillRegistry(),
      journal: null,
      ...(record ? { record } : {}),
      runOp: admin.runSkillOp,
      runOwnOp: admin.runOwnSkillOp,
      runInitiativeOp: admin.runInitiativeSkillOp,
      intentions: service,
    });
    return { llm, runner };
  };

  const open = async (start: Start) => {
    let died: () => void = () => {};
    const dead = new Promise<'died'>((resolve) => (died = () => resolve('died')));
    const memory = await openTestMemory({
      dataDir,
      config: { context: { turnLeaseMs: LEASE_MS } },
      now: () => clock.t,
    });
    const { llm, runner } = runnerOf(start.answers, died);
    // The sends the port had when a delivery was first recorded queued (null while none was).
    const committed: { sends: number | null } = { sends: null };
    let life: ReturnType<typeof createInnerLife> | null = null;
    const memoryDb = {
      readHandle: () => memory.memoryDb.readHandle(),
      writeOperational: (write: Parameters<typeof memory.memoryDb.writeOperational>[0]) =>
        memory.memoryDb.writeOperational(write),
      memoryWrite: async (update: WakeQueueUpdate): Promise<unknown> => {
        // The synthetic persisted completion models a restricted producer, including malformed stored metadata.
        const stored =
          update.op === 'finish-group' && Object.hasOwn(start, 'publicationBoundary')
            ? {
                ...update,
                done: update.done.map((item) => ({
                  ...item,
                  deliveries: item.deliveries.map((delivery) => ({
                    ...delivery,
                    payload: {
                      ...(delivery.payload && typeof delivery.payload === 'object' ? delivery.payload : {}),
                      publicationBoundary: start.publicationBoundary,
                    },
                  })),
                })),
              }
            : update;
        const answer: unknown = await memory.memoryDb.memoryWrite(stored);
        if (committed.sends === null && deliveriesIn(readHandleOf(memory), 'queued').length > 0) {
          committed.sends = sendsOf(port).length;
          if (life) start.atCommit?.(life);
          if (start.dieAtCommit === true) {
            died();
            return new Promise<unknown>(() => {});
          }
        }
        return answer;
      },
    };
    let busy = 0;
    const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
    life = createInnerLife({
      hot,
      dataDir,
      turns: {
        isAnyBusy: () => busy > 0,
        runTurn: async (params: InnerTurnParams) => {
          calls.push(params);
          busy += 1;
          try {
            const result: unknown = await runner.runTurn(params);
            results.push(result);
            return result;
          } finally {
            busy -= 1;
          }
        },
      },
      intentions: service,
      reads,
      // The inner life's record names no place (src/behavior/inner/persona-sources.ts).
      ...(record ? { record: { ...record, append: (lines: ReadonlyArray<unknown>) => record.append('', lines) } } : {}),
      iface: () => 'fake',
      chatName: (id: string) => `chan-${id}`,
      submit: (event: object) => door.submit(event),
      store: { state: { data: flags } },
      meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
      memoryDb,
      port: start.port ?? port,
      rng: () => 0.5,
      now: () => clock.t,
      log: SILENT,
    });
    return { memory, life, llm, dead, committed };
  };

  let current = await open(first);
  return {
    clock,
    service,
    port,
    calls,
    results,
    runnerOf,
    get life() {
      return current.life;
    },
    get memory(): Memory {
      return current.memory;
    },
    get llm() {
      return current.llm;
    },
    /** Resolves once this start's process died (a model call or a write that never answers). */
    get dead() {
      return current.dead;
    },
    get committed() {
      return current.committed;
    },
    async restart(start: Start) {
      await current.memory.close();
      current = await open(start);
    },
    close: () => current.memory.close(),
  };
}

type Core = Awaited<ReturnType<typeof core>>;

/** A one-off intention of the persona's in c1 due at `dueAt`, and the id of the wake it gives. */
function dueIntention(run: Core, dueAt: number): { id: string; wakeId: string } {
  const made = run.service.set({ purpose: 'ask how the trip went', dueAt, placeId: 'c1', scope: 'group' });
  if (!made.ok) throw new Error(`intention not set: ${made.code}`);
  return { id: made.intention.id, wakeId: `inner.wake:intention_due:${made.intention.id}:${dueAt}` };
}

describe('the sends of an inner wake', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('an edit of a held message later in the same turn is refused held-message, and the held message still goes out once', async () => {
    const run = await core({
      answers: [
        toolAnswer('', [call('message.create', { text: 'καλημέρα' })]),
        toolAnswer('', [call('message.edit', { message: 'last', text: 'καλησπέρα' })]),
        '<skip/>',
      ],
    });
    try {
      dueIntention(run, T - MINUTE);
      await run.life.tick();
      assert.deepEqual(actionsOf(run.results[0]), ['message.create:held', 'message.edit:held-message']);
      assert.notEqual(resultOf(run.results[0], 'message.edit'), 'ok');
      const runCalls = run.port.calls;
      assert.deepEqual(
        runCalls.filter((one) => one.op === 'edit'),
        [],
        'the edit reached no interface'
      );
      assert.deepEqual(sendsOf(run.port), ['καλημέρα']);
    } finally {
      await run.close();
    }
  });

  test("a message turn's message.create still reaches the port during the turn", async () => {
    let atSecondRequest: number | null = null;
    const run = await coreTurn({
      // A read beside the post leaves the persona something to read, so the turn asks the model a second time.
      answers: [toolAnswer('', [call('message.create', { text: 'γεια σου' }), call('lore.list', {})]), '<skip/>'],
      allowed: ['message.create', 'lore.list'],
      onAnswer: (index: number, _history: unknown, port: Fake) => {
        if (index === 1) atSecondRequest = sendsOf(port).length;
      },
    });
    assert.equal(atSecondRequest, 1, 'the send went out before the persona was asked again');
    assert.deepEqual(sendsOf(run.port), ['γεια σου']);
  });
});

const publicationBoundary: PublicationBoundary = {
  kind: 'internal-turn',
  origin: { iface: 'fake', chatId: 'origin' },
};

test('a held port refuses a foreign publication before keeping it', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  const hold = createSendHold();
  const held = heldPort(bindPublicationPort(port, publicationBoundary), { hold, publicationBoundary });
  const result = await held.send({ iface: 'fake', chatId: 'group' }, { text: 'restricted body' });
  assert.deepEqual([result.status, result.error?.code], ['failed', 'not-allowed']);
  assert.deepEqual(hold.sends, []);
  assert.deepEqual(port.messagesIn('group'), []);
});

test('a same-origin held send retains its restrictive descriptor in the durable delivery payload', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  const hold = createSendHold();
  const held = heldPort(port, { hold, publicationBoundary });
  const result = await held.send(publicationBoundary.origin, { text: 'private held answer' });
  assert.equal(result.status, 'ok');
  assert.equal(hold.sends.length, 1);
  const firstSend = hold.sends[0];
  assert.deepEqual(firstSend.publicationBoundary, publicationBoundary);
  const payload: unknown = deliveriesOf(hold, { turnId: 'turn:held', chainId: 'chain:held' })[0].payload;
  assert.ok(payload && typeof payload === 'object' && 'publicationBoundary' in payload);
  assert.deepEqual(payload.publicationBoundary, publicationBoundary);
  assert.equal('memoryContext' in payload, false);
});
