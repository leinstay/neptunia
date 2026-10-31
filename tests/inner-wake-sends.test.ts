// A wake's sends go out after its completion (spec 2026-10-31-stage-5-cut, "PR 5c, second half"). In the turn of a wake
// the drain claimed, her posting calls are held: each is answered `ok` with the code `held` and reaches no interface.
// The wake's fenced completion records one `deliveries` row per held send under the effect key of the call. After the
// commit the inner life sends them through its `port`, in order, and marks them `sent`. A start sends what a crash
// left `queued`, once, and reconciles a send whose answer was lost (src/interface/reconcile.ts) instead of sending it
// again. A later call of the same turn that needs a held message's id is refused `held-message`. A shadow turn holds
// and sends nothing, a message turn sends during the turn, and a wake turn whose calls were not held asks the model
// what it asks on main.
//
// A real inner life, intention service, event door, memory database and turn runner over the fake interface of the
// test's world (tests/fixtures/turn-world.ts), a scripted model, the clock injected as `now`. A crash is a process
// whose model call or memory write never answers: a new core opens the same data directory, as a restart does.
// Synthetic Greek text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmin } from '../src/admin.js';
import { createInnerLife } from '../src/behavior/inner.ts';
import type { InnerTurnParams } from '../src/behavior/inner/types.ts';
import { createEventDoor } from '../src/interface/door.js';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { deliveriesIn, deliveryOf, queuedDeliveries, wakeOf } from '../src/memory/db/wake-queue.ts';
import type { WakeQueueUpdate } from '../src/memory/db/wake-queue.ts';
import { notOk } from '../src/interface/port.js';
import { CODE } from '../src/tools/codes.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import '../src/tools/impl/index.ts';
import { openTestMemory } from './fixtures/memory-db/service.js';
import { tempDir } from './fixtures/tmp.js';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.js';
import { DISCORD, coreTurn, fakeStore, hotWith, personaGrants, rawMessage } from './fixtures/turn-harness.js';
import { useIface, world } from './fixtures/turn-world.ts';
import type { Fake } from './fixtures/turn-world.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';

useIface('fake');
const GUILD = 'g1';
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
  answers: ReadonlyArray<unknown>;
  /** The memory write that leaves a delivery queued never answers: the process dies right after that commit. */
  dieAtCommit?: boolean;
  /** The port the inner life sends through (the world's by default). */
  port?: Fake;
  /** Called with the inner life when a write first leaves a delivery queued, right after that commit. */
  atCommit?: (life: ReturnType<typeof createInnerLife>) => void;
};

/** The record of her lines (src/memory/record.js), as the turn runner and the inner life append to it. */
type Record_ = {
  lines: Array<unknown>;
  append(guildId: string, lines: ReadonlyArray<unknown>, options?: unknown): Promise<void>;
  iterate(): Array<unknown>;
};

/** A record that keeps every line appended to it, in order, and lists nothing back. */
function keptRecord(): Record_ {
  const lines: Array<unknown> = [];
  return {
    lines,
    append: (_guildId, appended) => {
      lines.push(...appended);
      return Promise.resolve();
    },
    iterate: () => [],
  };
}

/** The lines of `record` of `kind` in conversation c1, each as `<kind>:<message id>`. */
function linesOf(record: Record_, kind: string): Array<string> {
  return record.lines
    .filter((line) => Reflect.get(Object(line), 'kind') === kind)
    .filter((line) => Reflect.get(Object(Reflect.get(Object(line), 'scope')), 'channel') === 'c1')
    .map((line) => `${kind}:${String(Reflect.get(Object(line), 'messageId'))}`);
}

/** The facts the wake of `params` showed her. */
function factsOf(params: InnerTurnParams | undefined): Array<unknown> {
  return params?.inner.wake.facts ?? [];
}

/** The texts of the sends that reached `port`, in order. */
function sendsOf(port: Fake): Array<unknown> {
  return port.calls.filter((one) => one.op === 'send').map((one): unknown => Reflect.get(Object(one.args[1]), 'text'));
}

/** The idempotency keys of the messages `port` holds in c1, in the order they were sent. */
function keysOf(port: Fake): Array<string | null> {
  return port.messagesIn('c1').map((message) => message.sentUnder?.idempotencyKey ?? null);
}

/** Her calls of a turn's result as `<skill>:<code>`, in the order she made them. */
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

/** The result status of her call of `skill` in a turn's result, or null. */
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
 * The live config of the core: the inner life in `mode`, her tools on, the heartbeat on only when asked (every hour,
 * no jitter, not held to intention changes), the journal off.
 */
function hotOf(mode: 'live' | 'shadow', heartbeat: boolean) {
  const hot = hotWith({
    features: { innerLife: true, intentions: true, journal: false, coreTools: true },
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['lore.list', 'message.create', 'message.edit', 'message.react.add']),
    config: {
      mention: { oneAtATime: true },
      innerLife: {
        mode,
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        heartbeat: heartbeat
          ? { enabled: true, everyMinutes: 60, jitterMinutes: 0, dueJitterMinutes: 0, intentionsOnly: false }
          : { enabled: false, dueJitterMinutes: 0 },
        caps: { perChain: 3 },
      },
    },
  });
  Object.assign(hot.config.context, { turnLeaseMs: LEASE_MS });
  Object.assign(hot.prompts, { inner: INNER_TASK });
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
    ? { conversationInfo: world().reads.conversationInfo.bind(world().reads), offers: () => false }
    : world().reads;
  world().channel({
    id: 'c1',
    name: 'chan-c1',
    guildId: GUILD,
    permissions: { send: true },
    historyMessages: [rawMessage({ id: 'm1', ts: T - HOUR, content: 'καλή σας μέρα' })],
  });
  const port = world().port;
  const clock = { t: T };
  const hot = hotOf(mode, heartbeat);
  // Her lines are recorded only while features.record is exactly true.
  if (record) Object.assign(hot.config.features, { record: true });
  const dataDir = tempDir('nep-inner-wake-sends-');
  const flags: PauseFlags = {};
  const service = createIntentionService({
    stores: createIntentionStores({ now: () => clock.t, log: SILENT }),
    hot,
    getGuildId: () => GUILD,
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
      getGuildId: () => GUILD,
      port,
      reads: world().reads,
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
      readHandle: (): unknown => memory.memoryDb.readHandle(),
      memoryWrite: async (update: WakeQueueUpdate): Promise<unknown> => {
        const answer: unknown = await memory.memoryDb.memoryWrite(update);
        if (committed.sends === null && queuedDeliveries(readHandleOf(memory)).length > 0) {
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
      ...(record ? { record } : {}),
      iface: () => 'fake',
      conversationName: (id: string) => `chan-${id}`,
      submit: (event: object) => door.submit(event),
      store: { state: { data: flags } },
      getGuildId: () => GUILD,
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

/** A one-off intention of hers in c1 due at `dueAt`, and the id of the wake it gives. */
function dueIntention(run: Core, dueAt: number): { id: string; wakeId: string } {
  const made = run.service.set(GUILD, { purpose: 'ask how the trip went', dueAt, channelId: 'c1', scope: 'group' });
  if (!made.ok) throw new Error(`intention not set: ${made.code}`);
  return { id: made.intention.id, wakeId: `inner.wake:intention_due:${made.intention.id}:${dueAt}` };
}

test("a wake turn's message.create is held until the completion, then the port gets it once under its delivery's key", async () => {
  const run = await core({ answers: [toolAnswer('', [call('message.create', { text: 'καλημέρα' })]), '<skip/>'] });
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    await run.life.tick();
    assert.deepEqual(run.llm.sendsAtRequest, [0, 0], 'nothing reached the port while the turn ran');
    assert.equal(run.committed.sends, 0, 'nothing reached the port before the completion recorded the delivery');
    assert.deepEqual(actionsOf(run.results[0]), ['message.create:held']);
    assert.equal(resultOf(run.results[0], 'message.create'), 'ok');
    assert.deepEqual(sendsOf(run.port), ['καλημέρα']);
    const [key] = keysOf(run.port);
    assert.ok(key, 'the send carries a key');
    const delivery = deliveryOf(readHandleOf(run.memory), key);
    assert.equal(delivery?.state, 'sent');
    assert.equal(delivery?.wakeId, wakeId);
    assert.equal(delivery?.target, 'c1');
    assert.equal(wakeOf(readHandleOf(run.memory), wakeId)?.state, 'handled');
    run.clock.t += MINUTE;
    await run.life.tick();
    assert.deepEqual(sendsOf(run.port), ['καλημέρα'], 'a sent delivery never leaves again');
  } finally {
    await run.close();
  }
});

test('a crash after the completion and before the send: the next start sends the held message once, and a second start sends nothing', async () => {
  const run = await core({ answers: ['<msg>καλησπέρα</msg>', '<skip/>'], dieAtCommit: true });
  try {
    dueIntention(run, T - MINUTE);
    const tick = run.life.tick().then(() => 'ended' as const);
    assert.equal(await Promise.race([run.dead, tick]), 'died', 'the completion recorded the held send');
    assert.deepEqual(sendsOf(run.port), [], 'the process died before anything was sent');
    await run.restart({ answers: ['<skip/>'] });
    run.clock.t = T + 10 * MINUTE;
    await run.life.tick();
    assert.deepEqual(sendsOf(run.port), ['καλησπέρα'], 'the start sent what the completion recorded');
    const [key] = keysOf(run.port);
    assert.ok(key, 'the send carries the key of its delivery');
    assert.equal(deliveryOf(readHandleOf(run.memory), key)?.state, 'sent');
    await run.restart({ answers: ['<skip/>'] });
    run.clock.t += MINUTE;
    await run.life.tick();
    assert.deepEqual(sendsOf(run.port), ['καλησπέρα'], 'a second start sends nothing again');
  } finally {
    await run.close();
  }
});

test('a start whose send of a recorded delivery lost its answer: the next start reconciles it and sends nothing again', async () => {
  const run = await core({ answers: ['<msg>καλησπέρα</msg>', '<skip/>'], dieAtCommit: true });
  try {
    dueIntention(run, T - MINUTE);
    const tick = run.life.tick().then(() => 'ended' as const);
    assert.equal(await Promise.race([run.dead, tick]), 'died', 'the completion recorded the held send');
    // The second start's send reaches the interface, and the process dies before its answer comes back.
    const world_ = run.port;
    let reached: () => void = () => {};
    const sent = new Promise<'sent'>((resolve) => (reached = () => resolve('sent')));
    const reconcilable: Fake = { ...world_, capabilities: () => ({ ...world_.capabilities(), reconcile: true }) };
    const losing: Fake = {
      ...reconcilable,
      send: (conversation, content, options) => {
        void world_.send(conversation, content, options).then(reached);
        return new Promise(() => {});
      },
    };
    await run.restart({ answers: ['<skip/>'], port: losing });
    run.clock.t = T + 10 * MINUTE;
    void run.life.tick();
    await sent;
    assert.deepEqual(sendsOf(run.port), ['καλησπέρα']);
    await run.restart({ answers: ['<skip/>'], port: reconcilable });
    run.clock.t += MINUTE;
    await run.life.tick();
    assert.deepEqual(sendsOf(run.port), ['καλησπέρα'], 'the lost answer is reconciled, never sent again blindly');
    const [key] = keysOf(run.port);
    assert.ok(key);
    assert.equal(deliveryOf(readHandleOf(run.memory), key)?.state, 'sent', 'the reconcile found it posted');
  } finally {
    await run.close();
  }
});

test('a crash before the completion sends nothing, and the wake reruns under the turn id of its first run', async () => {
  // A read beside the post leaves her something to read, so the turn asks the model again, and dies there.
  const run = await core({
    answers: [toolAnswer('', [call('message.create', { text: 'πρώτη' }), call('lore.list', {})]), DIES],
  });
  try {
    dueIntention(run, T - MINUTE);
    void run.life.tick();
    await run.dead;
    assert.deepEqual(sendsOf(run.port), [], 'the held send never left');
    assert.deepEqual(queuedDeliveries(readHandleOf(run.memory)), [], 'no completion, so no delivery');
    await run.restart({ answers: [toolAnswer('', [call('message.create', { text: 'δεύτερη' })]), '<skip/>'] });
    run.clock.t = T + 10 * MINUTE;
    await run.life.tick();
    const ids = run.calls.map((params) => params.journalTurn.turnId);
    assert.equal(ids.length, 2, 'the cut-off wake runs once more');
    assert.equal(ids[1], ids[0], 'under the turn id of its first run');
    assert.deepEqual(sendsOf(run.port), ['δεύτερη'], "only the rerun's completion sends");
  } finally {
    await run.close();
  }
});

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
    assert.deepEqual(
      run.port.calls.filter((one) => one.op === 'edit'),
      [],
      'the edit reached no interface'
    );
    assert.deepEqual(sendsOf(run.port), ['καλημέρα']);
  } finally {
    await run.close();
  }
});

test('a held post sent after the completion is recorded once as her said line in its conversation', async () => {
  const record = keptRecord();
  const run = await core(
    { answers: [toolAnswer('', [call('message.create', { text: 'καλημέρα' })]), '<skip/>'] },
    { record }
  );
  try {
    dueIntention(run, T - MINUTE);
    await run.life.tick();
    const [posted] = run.port.messagesIn('c1');
    assert.ok(posted, 'the held post went out');
    assert.deepEqual(linesOf(record, 'said'), [`said:${posted.ref.messageId}`]);
    run.clock.t += MINUTE;
    await run.life.tick();
    assert.deepEqual(linesOf(record, 'said'), [`said:${posted.ref.messageId}`], 'recorded once');
  } finally {
    await run.close();
  }
});

test('a delivery the interface refuses ends failed, her next wake shows it as a failed call, and no start resends it', async () => {
  const run = await core({ answers: ['<msg>καλησπέρα</msg>', '<skip/>'] });
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    run.port.failNext('send', notOk('failed', CODE.SEND_FAILED));
    await run.life.tick();
    assert.equal(sendsOf(run.port).length, 1, 'the interface was asked once');
    assert.deepEqual(run.port.messagesIn('c1'), [], 'and posted nothing');
    assert.deepEqual(
      deliveriesIn(readHandleOf(run.memory), 'failed').map((delivery) => delivery.wakeId),
      [wakeId],
      'the delivery ended failed'
    );
    run.clock.t += MINUTE;
    await run.life.tick();
    assert.equal(run.calls.length, 2, 'a next wake runs');
    const told = factsOf(run.calls[1]).map(
      (fact) => `${String(Reflect.get(Object(fact), 'kind'))}:${String(Reflect.get(Object(fact), 'code'))}`
    );
    assert.ok(told.includes(`callFailed:${CODE.SEND_FAILED}`), `her next wake shows the failure: ${told.join(', ')}`);
    await run.restart({ answers: ['<skip/>'] });
    run.clock.t += MINUTE;
    await run.life.tick();
    assert.equal(sendsOf(run.port).length, 1, 'no start resends a failed delivery');
  } finally {
    await run.close();
  }
});

test('the stop switch turned on after the completion keeps the deliveries queued and sends nothing', async () => {
  const run = await core({
    answers: ['<msg>καλησπέρα</msg>', '<skip/>'],
    atCommit: (life) => life.stop(GUILD),
  });
  try {
    dueIntention(run, T - MINUTE);
    await run.life.tick();
    assert.equal(run.committed.sends, 0, 'the completion recorded the held post before any send');
    assert.deepEqual(sendsOf(run.port), [], 'the drain asked the switch again before it sent');
    assert.deepEqual(
      queuedDeliveries(readHandleOf(run.memory)).map((delivery) => delivery.state),
      ['queued']
    );
  } finally {
    await run.close();
  }
});

test('a heartbeat in shadow mode holds nothing and sends nothing: her post is only proposed', async () => {
  const run = await core(
    {
      answers: [toolAnswer('', [call('message.create', { channel: '#chan-c1', text: 'καλημέρα' })]), '<skip/>'],
    },
    { mode: 'shadow', heartbeat: true }
  );
  try {
    // The first tick draws the heartbeat an hour on; the tick past it runs the heartbeat's turn.
    await run.life.tick();
    run.clock.t = T + HOUR + MINUTE;
    await run.life.tick();
    assert.equal(run.calls.length, 1, 'the heartbeat ran');
    assert.equal(run.calls[0]?.inner.wake.kind, 'heartbeat');
    assert.deepEqual(actionsOf(run.results[0]), ['message.create:shadow']);
    assert.deepEqual(sendsOf(run.port), []);
    assert.deepEqual(queuedDeliveries(readHandleOf(run.memory)), [], 'nothing was recorded to send');
  } finally {
    await run.close();
  }
});

test("a message turn's message.create still reaches the port during the turn", async () => {
  let atSecondRequest: number | null = null;
  const run = await coreTurn({
    // A read beside the post leaves her something to read, so the turn asks the model a second time.
    answers: [toolAnswer('', [call('message.create', { text: 'γεια σου' }), call('lore.list', {})]), '<skip/>'],
    allowed: ['message.create', 'lore.list'],
    onAnswer: (index: number, _history: unknown, port: Fake) => {
      if (index === 1) atSecondRequest = sendsOf(port).length;
    },
  });
  assert.equal(atSecondRequest, 1, 'the send went out before she was asked again');
  assert.deepEqual(sendsOf(run.port), ['γεια σου']);
});

test("a wake turn whose calls were not held asks the model what the same turn asks without the drain's holding", async () => {
  // A read, then the request that carries its result.
  const answers = [toolAnswer('', [call('lore.list', {})]), '<skip/>'];
  const run = await core({ answers });
  try {
    dueIntention(run, T - MINUTE);
    await run.life.tick();
    const [params] = run.calls;
    assert.ok(params, 'the wake ran');
    assert.equal(run.llm.requests.length, 2, 'the second request carries the read');
    // The turn as the drain hands it to the runner on main: these fields and no others.
    const asOnMain: Record<string, unknown> = {
      ...(params.conversation ? { conversation: params.conversation } : {}),
      ...(params.standIn ? { standIn: params.standIn } : {}),
      ...(params.reuseHistory ? { reuseHistory: params.reuseHistory } : {}),
      guildId: params.guildId,
      mode: params.mode,
      triggerKind: params.triggerKind,
      journalTurn: params.journalTurn,
      inner: {
        wake: params.inner.wake,
        currentChannel: params.inner.currentChannel,
        shadow: params.inner.shadow,
        mayAct: params.inner.mayAct,
      },
    };
    const replay = run.runnerOf(answers, () => {});
    await replay.runner.runTurn(asOnMain);
    assert.equal(replay.llm.requests.length, run.llm.requests.length);
    for (const [index, request] of run.llm.requests.entries())
      assert.equal(request, replay.llm.requests[index], `request ${index} is byte-identical`);
  } finally {
    await run.close();
  }
});
