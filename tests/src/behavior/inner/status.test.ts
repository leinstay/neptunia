// The status of the inner life (src/behavior/inner/status.ts): a stop kept in the stored state is released on the next
// tick, and the status card shows chains, spend, open intentions and the next wake.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { emptyState, heartbeatWake } from '../../../../src/behavior/inner.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { personaKey } from '../../../../src/memory/db/unit-keys.ts';
import { unitValue } from '../../../../src/memory/db/readers/common.ts';
import { applyUnitUpdate } from '../../../fixtures/memory-db/unit-writes.ts';
import { startUnitsCore, until, withRig } from '../../../fixtures/core-units.ts';
import { clock, ROOT, NOW, setup, fakeTurns, intention } from '../../../fixtures/inner-rig.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { HOUR_MS, MINUTE_MS } from '../../../../src/time.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { present } from '../../../fixtures/loose-types.ts';
import type { InnerTurnParams } from '../../../../src/behavior/inner/types.ts';

const STOPPED = { stopped: true, stoppedAt: NOW - 1000, stoppedBy: 'owner' };

/** A data folder whose inner state file holds `state`, and the file. */
function stored(state: Record<string, unknown>): { dataDir: string; file: string } {
  const dataDir = tempDir('nep-stored-stop-');
  const file = path.join(dataDir, 'persona', 'inner.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const day = new Date(NOW).toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify({ review: { day, at: null, done: true }, ...state }));
  return { dataDir, file };
}

test('releaseStoredStop clears a stored stop, so a tick runs and a restart stays released', async () => {
  // Catches: a deployment stopped before the command was retired stays off for good, with nothing to tell the owner.
  clock.t = NOW;
  const { dataDir } = stored(STOPPED);
  const first = setup({ records: [], dataDir });
  assert.equal(first.inner.releaseStoredStop(), true);
  assert.equal(first.inner.status().stopped, false);
  assert.notEqual((await first.inner.tick()).reason, 'stopped');
  assert.equal(setup({ records: [], dataDir }).inner.status().stopped, false);
});

test('releaseStoredStop with no stored stop answers false and writes nothing', () => {
  // Catches: every tick of the core rewrites the state, or notes a release that never happened.
  clock.t = NOW;
  const { dataDir, file } = stored({});
  const before = fs.readFileSync(file, 'utf8');
  const life = setup({ records: [], dataDir });
  assert.equal(life.inner.releaseStoredStop(), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(life.journal, []);
});

test('the core clears a stored stop on its own tick, with no command', async () => {
  // Catches: the method exists and the core never calls it, so the flag in memory.db still holds the wakes off.
  await withRig({ config: { bot: { placeId: ROOT }, wakes: { tickSeconds: 1 } } }, async ({ dirs, llm, cores }) => {
    const file = path.join(dirs.dataDir, 'memory.db');
    const seed = openMemoryDb(file);
    applyUnitUpdate(seed, { op: 'value', key: personaKey('inner'), value: { ...emptyState(), ...STOPPED } });
    seed.close();
    const stoppedNow = (): unknown => {
      const read = openMemoryDb(file, { readOnly: true });
      try {
        const unit = unitValue(dbOf(read), personaKey('inner'));
        return unit.found ? (unit.value as { stopped?: unknown }).stopped : null;
      } finally {
        read.close();
      }
    };
    assert.equal(stoppedNow(), true);
    cores.push(await startUnitsCore(dirs, llm));
    await until(() => stoppedNow() === false, 'the stored stop to clear');
  });
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('on the fake interface', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test.beforeEach(() => void (clock.t = NOW));

  test('inner: stop drops the queue and is seen by a running turn before its next action; start releases it', async () => {
    let seenDuringTurn = null;
    let run: ReturnType<typeof setup>;
    const turns = fakeTurns({
      answer: (params: InnerTurnParams) => {
        const before = params.inner.mayAct();
        run.inner.stop({ by: 'owner' });
        seenDuringTurn = { before, after: params.inner.mayAct() };
        return { outcome: 'spoke', inner: { actions: [], turnId: 't1' } };
      },
    });
    run = setup({
      records: [
        intention('i1', { dueAt: NOW - 2 * MINUTE_MS }),
        intention('i2', { dueAt: NOW - MINUTE_MS, placeId: 'c2' }),
      ],
      turns,
    });
    await run.inner.tick();
    assert.deepEqual(seenDuringTurn, { before: true, after: false });
    assert.equal(run.inner.status().queue.length, 0, 'the other wake was dropped');
    assert.deepEqual(await run.inner.tick(), { ran: false, reason: 'stopped' });
    assert.equal(
      (
        await run.inner.onWake({
          kind: 'inner.wake',
          at: NOW,
          id: 'x',
          placeId: ROOT,
          // Any wake the door brings while the persona is stopped is refused.
          wake: heartbeatWake(NOW),
        })
      ).status,
      'stopped'
    );
    await settle();
    const stopped = run.journal.find((r: Record<string, Untyped>) => r.event === 'stopped');
    assert.equal(present(stopped).dropped, 1);
    run.inner.start();
    assert.equal(run.inner.status().stopped, false);
  });

  test('inner status: chains, spend, open intentions, the next wake and the last turn for the status card', async () => {
    const run = setup({
      records: [
        intention('i1', { dueAt: NOW - MINUTE_MS, chainId: 'k1' }),
        intention('i2', { dueAt: NOW + 3 * HOUR_MS, status: 'waiting' }),
        intention('i3', { dueAt: NOW + HOUR_MS, status: 'pending' }),
      ],
      meterUsd: 0.25,
    });
    const before = run.inner.status();
    assert.equal(before.lastTurn, null);
    assert.equal(before.chains, 0);
    assert.deepEqual(before.intentions, { pending: 2, waiting: 1 });
    assert.deepEqual(before.next, { at: NOW - MINUTE_MS, kind: 'intention' });
    await run.inner.tick();
    clock.t = NOW + MINUTE_MS;
    const after = run.inner.status();
    assert.equal(after.turnsToday, 1);
    assert.equal(after.chains, 1);
    assert.equal(after.spentUsd, 0.25);
    assert.deepEqual(after.lastTurn, { at: NOW, outcome: 'skip' });
    assert.deepEqual(
      after.next,
      { at: NOW + HOUR_MS, kind: 'intention' },
      'the next intention to come due, the handled one behind'
    );
  });
});
