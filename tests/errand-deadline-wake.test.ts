// The wake `errand_deadline` is an intention waiting on an errand whose wait ran out, not an intention coming due. An
// intention that waits on a running errand with no due time of its own and a deadline that has passed gives one wake
// of kind `errand_deadline` (never an `intention_due`) with the id `inner.wake:errand_deadline:<intention>:<errand>`,
// the errand named in its item as `errandId`, and the intention's channel as the current one with the reason `errand`.
// The same tick again is a duplicate, and `deadlineWakes` over the reconciled record gives the same id, so the wait
// never wakes her twice. Real intention service and store, real event door and scheduler, a fake turn runner and a fake
// errand store; a temporary data directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInnerLife, deadlineWakes } from '../src/behavior/inner.js';
import { createEventDoor } from '../src/interface/door.js';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { tempDir } from './fixtures/tmp.js';
import { useIface, world } from './fixtures/turn-world.ts';

useIface('fake');
const GUILD = 'g1';
const MINUTE = 60_000;
const START = Date.parse('2026-10-26T12:00:00Z');
const ERRAND = 't0000000a';
const SILENT = { info() {}, warn() {}, error() {} };

type TurnParams = { inner: { wake: { kind: string; items: Array<Record<string, unknown>>; here: unknown } } };

function setup() {
  const clock = { t: START };
  world().channel({ id: 'c1', name: 'chan-c1', guildId: GUILD, permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { innerLife: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      innerLife: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        heartbeat: { enabled: false },
        caps: { perChain: 3 },
      },
    },
  };
  // The errand is running for the whole test: the store of the errand service has it open.
  const errands = { store: () => ({ get: (id: string) => (id === ERRAND ? { id, state: 'running' } : null) }) };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-deadline-'), now: () => clock.t, log: SILENT }),
    hot,
    tasks: errands,
    getGuildId: () => GUILD,
    now: () => clock.t,
    log: SILENT,
  });
  const calls: Array<TurnParams> = [];
  const turns = {
    calls,
    isAnyBusy: () => false,
    runTurn: (params: TurnParams) => {
      calls.push(params);
      return Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-1' } });
    },
  };
  const journal: Array<Record<string, unknown>> = [];
  let inner: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({
    handlers: { 'inner.wake': (event: object) => inner?.onWake(event) },
    log: SILENT,
  });
  inner = createInnerLife({
    hot,
    dataDir: tempDir('nep-deadline-inner-'),
    turns,
    intentions: service,
    journal: { inner: (_guildId: string, fields: Record<string, unknown>) => Promise.resolve(journal.push(fields)) },
    reads: world().reads,
    iface: () => 'fake',
    conversationName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    getGuildId: () => GUILD,
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  return { clock, service, inner, calls, journal };
}

/** An intention waiting on the running errand with no due time, its deadline ten minutes ahead. */
function waitingIntention(service: ReturnType<typeof setup>['service']): string {
  const made = service.set(GUILD, {
    purpose: 'tell what the errand found',
    dueAt: null,
    channelId: 'c1',
    taskId: ERRAND,
    deadline: START + 10 * MINUTE,
  }) as { ok: boolean; intention: { id: string } };
  assert.equal(made.ok, true);
  return made.intention.id;
}

test('a wait past its deadline wakes her once as errand_deadline, never as intention_due, and the same tick again is a duplicate', async () => {
  const run = setup();
  const id = waitingIntention(run.service);
  run.clock.t = START + 11 * MINUTE;
  const first = await run.inner.tick();
  assert.equal(first.submitted, 1);
  assert.deepEqual(
    run.calls.map((call) => call.inner.wake.items.map((item) => item.kind)),
    [['errand_deadline']]
  );
  const second = await run.inner.tick();
  assert.equal(second.submitted, 0);
  assert.equal(run.calls.length, 1, 'one deadline, one wake');
  const turn = run.journal.find((entry) => entry.event === 'turn');
  assert.deepEqual(turn?.coalesced, [`inner.wake:errand_deadline:${id}:${ERRAND}`]);
});

test('the wake item names the errand as errandId and the intention channel is the current one, for the errand', async () => {
  const run = setup();
  waitingIntention(run.service);
  run.clock.t = START + 11 * MINUTE;
  await run.inner.tick();
  const wake = run.calls[0]?.inner.wake;
  assert.equal(wake?.items[0]?.errandId, ERRAND);
  assert.equal(Object.hasOwn(wake?.items[0] ?? {}, 'taskId'), false);
  assert.deepEqual(wake?.here, { channel: 'chan-c1', why: 'errand' });
});

test('deadlineWakes over a record the reconciliation moved to pending gives the id the wait itself gave', () => {
  const run = setup();
  const id = waitingIntention(run.service);
  run.clock.t = START + 11 * MINUTE;
  run.service.reconcile(GUILD);
  const moved = run.service.list(GUILD, { all: true }) as Array<Record<string, unknown>>;
  assert.equal(moved[0]?.status, 'pending');
  assert.deepEqual(
    (deadlineWakes(moved) as Array<{ id: string; kind: string; errandId: string }>).map((wake) => [
      wake.id,
      wake.kind,
      wake.errandId,
    ]),
    [[`inner.wake:errand_deadline:${id}:${ERRAND}`, 'errand_deadline', ERRAND]]
  );
});
