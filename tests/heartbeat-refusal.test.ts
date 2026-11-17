// A call a heartbeat refuses stays refused (docs/inner-life.md "Heartbeat"): a refusal she did not read in the turn
// queues no feedback wake, so no later turn posts what the heartbeat refused, and the next heartbeat tells her of it. A real inner life, intention service, event door, memory database and turn runner over the fake interface
// of the test's world (tests/fixtures/turn-world.ts), a scripted model, the clock injected as `now`. Synthetic Greek
// text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmin } from '../src/admin.ts';
import { createInnerLife } from '../src/behavior/inner.ts';
import type { InnerTurnParams } from '../src/behavior/inner/types.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import '../src/tools/operations/index.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { DISCORD, fakeStore, hotWith, personaGrants, rawMessage } from './fixtures/turn-harness.ts';
import { useIface, world } from './fixtures/turn-world.ts';
import type { Fake } from './fixtures/turn-world.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';
import { noMediaNames } from './fixtures/media-namer.ts';

useIface('fake');
const ROOT = 'g1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Date.parse('2026-10-31T12:00:00Z');
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const CLIENT = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };

/** The texts of the sends that reached `port`, in order. */
function sendsOf(port: Fake): Array<unknown> {
  return port.calls.filter((one) => one.op === 'send').map((one): unknown => Reflect.get(Object(one.args[1]), 'text'));
}

/** A live inner life with an hourly heartbeat over chat c1, whose model answers `answers` in turn (the last repeats). */
async function core(answers: ReadonlyArray<unknown>) {
  world().channel({
    id: 'c1',
    name: 'chan-c1',
    placeId: ROOT,
    permissions: { send: true },
    historyMessages: [rawMessage({ id: 'm1', ts: T - HOUR, content: 'καλή σας μέρα' })],
  });
  const port = world().port;
  const clock = { t: T };
  const hot = hotWith({
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['message.create', 'intention.set']),
    config: {
      wakes: { mode: 'live', tickSeconds: 60, review: { historyDays: 14 }, caps: { perChain: 3 } },
      heartbeat: { enabled: true, everyMinutes: 60, jitterMinutes: 0 },
    },
  });
  Object.assign(hot.config, { intentions: { expiresDays: 14, maxOpen: 20 } });
  Object.assign(hot.prompts, { inner: 'Nobody wrote to you; read the wake block.' });
  const service = createIntentionService({
    stores: createIntentionStores({ now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  const memory = await openTestMemory({
    dataDir: tempDir('nep-heartbeat-refusal-'),
    config: { context: { turnLeaseMs: MINUTE } },
    now: () => clock.t,
  });
  let requests = 0;
  const llm = {
    complete: (): Promise<unknown> => {
      requests += 1;
      return Promise.resolve(completionOf(answers[Math.min(requests - 1, answers.length - 1)]));
    },
  };
  const store = fakeStore();
  const admin = createAdmin({
    mediaNameOf: noMediaNames,
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
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    intentions: service,
  });
  const kinds: Array<unknown> = [];
  const facts: Array<ReadonlyArray<unknown>> = [];
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-heartbeat-refusal-life-'),
    turns: {
      isAnyBusy: () => false,
      runTurn: (params: InnerTurnParams) => {
        kinds.push(params.inner.wake.kind);
        facts.push(params.inner.wake.facts ?? []);
        return runner.runTurn(params);
      },
    },
    intentions: service,
    // The heartbeat has no place: with reads that say no interface answers, it runs in its stand-in (drain.ts).
    reads: { chatInfo: world().reads.chatInfo.bind(world().reads), offers: () => false },
    iface: () => 'fake',
    chatName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    memoryDb: {
      readHandle: () => memory.memoryDb.readHandle(),
      writeOperational: (write: Parameters<typeof memory.memoryDb.writeOperational>[0]) =>
        memory.memoryDb.writeOperational(write),
      memoryWrite: (update: Parameters<typeof memory.memoryDb.memoryWrite>[0]) => memory.memoryDb.memoryWrite(update),
    },
    port,
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  return { clock, port, kinds, facts, life, requests: () => requests, close: () => memory.close() };
}

test('a post a heartbeat refused beside the change that ended it wakes no feedback turn and is told by the next heartbeat', async () => {
  const post = toolAnswer('', [
    call('message.create', { place: '#chan-c1', text: 'καλημέρα' }),
    call('message.create', { place: '#chan-c1', text: 'τι κάνετε;' }),
    call('intention.set', { due: '6h', text: 'ask how the trip went' }),
  ]);
  const run = await core([post]);
  try {
    await run.life.tick();
    run.clock.t = T + HOUR + MINUTE;
    await run.life.tick();
    assert.equal(run.requests(), 1, 'the change ended the heartbeat');
    run.clock.t += MINUTE;
    await run.life.tick();
    run.clock.t += MINUTE;
    await run.life.tick();
    assert.deepEqual(run.kinds, ['heartbeat'], 'no turn follows the heartbeat');
    assert.deepEqual(sendsOf(run.port), [], 'nothing was posted');
    // She did not read the refusals in that turn, so the next heartbeat tells her of them.
    for (let at = T + 2 * HOUR; at <= T + 4 * HOUR && run.kinds.length < 2; at += 10 * MINUTE) {
      run.clock.t = at;
      await run.life.tick();
    }
    assert.deepEqual(run.kinds, ['heartbeat', 'heartbeat']);
    assert.deepEqual(
      run.facts[1]?.map(
        (fact) => `${String(Reflect.get(Object(fact), 'kind'))}:${String(Reflect.get(Object(fact), 'code'))}`
      ),
      ['callFailed:heartbeat-only', 'callFailed:heartbeat-only']
    );
  } finally {
    await run.close();
  }
});
