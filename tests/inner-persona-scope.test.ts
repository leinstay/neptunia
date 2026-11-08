// The inner life belongs to one persona, with no home root: the heartbeat, the wakes and the kill switch run on a core
// that has none, each record naming its own optional destination place.
// Contract, plan 2026-11-04-cli-and-memory task 5: `createInnerLife` takes no `getRootId`; `inner.tick()`, `inner.drain()`,
// `inner.stop(options?)`, `inner.start(options?)`, `inner.status()`, `inner.places(options?)`, `inner.state()`,
// `inner.mayAct()`. Missed-wake and disable policies stay as they are.
// Appendix entries: src/behavior/inner.ts, src/behavior/inner/{status,places,queue,drain,deliveries,recovery,review,
// heartbeat,selfimprovement,facts,types,wake-store}.ts, src/behavior/heartbeat-view.ts,
// src/behavior/selfimprovement-view.ts, src/tools/operations/inner.ts, src/memory/db/wake-queue.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInnerLife } from '../src/behavior/inner.ts';
import type { InnerLifeOptions } from '../src/behavior/inner.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { DAY_MS } from '../src/time.ts';
import {
  NOW,
  SILENT,
  clock,
  fakeClient,
  fakeIntentions,
  fakeTurns,
  hotWith,
  intention,
  seeded,
  wakeMemory,
} from './fixtures/inner-rig.ts';
import type { FakeIntention } from './fixtures/inner-rig.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface } from './fixtures/turn-world.ts';

useIface('fake');
test.beforeEach(() => void (clock.t = NOW));

function life({
  records = [],
  hot = hotWith(),
  dataDir = tempDir('nep-inner-persona-'),
  memory = wakeMemory(dataDir, () => clock.t),
}: {
  records?: Array<FakeIntention>;
  hot?: InnerLifeOptions['hot'];
  dataDir?: string;
  memory?: ReturnType<typeof wakeMemory>;
} = {}) {
  const turns = fakeTurns();
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  const inner = createInnerLife({
    hot,
    dataDir,
    turns,
    intentions: wrongly<InnerLifeOptions['intentions']>(fakeIntentions(records)),
    journal: { inner: () => {} },
    places: () => [{ id: 'c1', name: 'general', writable: true }],
    reads: fakeClient().reads,
    iface: () => 'fake',
    chatName: (id) => `chan-${id}`,
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn) => ({ result: await fn(), usd: 0, requests: 1, voice: 1 }) },
    memoryDb: memory.memoryDb,
    rng: seeded(7),
    now: () => clock.t,
    log: SILENT,
  });
  return { inner, turns, memory, dataDir };
}

const settle = (): Promise<unknown> => new Promise((resolve) => setImmediate(resolve));

test('a tick runs on a core with no root', async () => {
  // Bug: `tick` answers `no-root` first, so a core with only DMs never wakes her at all.
  const { inner } = life();
  const answer = await inner.tick();
  assert.equal(answer.reason, undefined);
  assert.equal(answer.ran, true);
});

test('a due intention opens one inner turn, and the turn asks no root', async () => {
  // Bug: the wake carries the home root into the turn, and its memory lands under that server.
  const { inner, turns } = life({ records: [intention('i1')] });
  await inner.tick();
  await settle();
  await inner.tick();
  await settle();
  assert.equal(turns.calls.length, 1);
  assert.equal('rootId' in (turns.calls[0] ?? {}), false);
});

test('a heartbeat falls due and is listed with no destination', async () => {
  // Bug: the heartbeat's due time lives in a per-root state, so with no root it is never drawn.
  const { inner, memory } = life({ hot: hotWith({ heartbeat: { enabled: true, everyHours: 3, jitterHours: 0 } }) });
  await inner.tick();
  clock.t += 2 * DAY_MS;
  await inner.tick();
  await settle();
  const kinds = [...memory.wakes('queued'), ...memory.wakes('handled')].map((stored) => stored?.kind);
  assert.ok(kinds.includes('heartbeat'), kinds.join(','));
});

test('the kill switch stops and starts with no root named', () => {
  // Bug: `stop` refuses with `NO_ROOT`, so the owner cannot stop a core that has only DMs.
  const { inner } = life();
  assert.equal(inner.stop({ by: 'owner' }).ok, true);
  assert.equal(inner.status().stopped, true);
  assert.equal(inner.start({ by: 'owner' }).ok, true);
  assert.equal(inner.status().stopped, false);
});

test('a stopped persona stays stopped across a restart', async () => {
  // Bug: the switch is saved under a root key that the next process, with no root yet, does not read.
  const dataDir = tempDir('nep-inner-restart-');
  const memory = wakeMemory(dataDir, () => clock.t);
  life({ dataDir, memory }).inner.stop({ by: 'owner' });
  await new Promise((resolve) => setTimeout(resolve, 50)); // the state's write is queued behind the switch
  const answer = await life({ dataDir, memory }).inner.tick();
  assert.equal(answer.reason, 'stopped');
});

test('the places of her attention come back with no root named', () => {
  // Bug: `places` returns an empty page without a root, so the heartbeat of a DM-only core sees no place.
  const { inner } = life();
  const page = inner.places();
  assert.deepEqual(
    page.items.map((item: { id: string }) => item.id),
    ['c1']
  );
});

test('she may act with no root named', () => {
  // Bug: `mayAct` answers false for a persona without a home root, so her own calls are refused in a DM.
  const { inner } = life();
  assert.equal(inner.mayAct(), true);
  inner.stop({ by: 'owner' });
  assert.equal(inner.mayAct(), false);
});
