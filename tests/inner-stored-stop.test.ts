// A stop kept in the stored inner state from before `/wakes stop` was retired (src/behavior/inner/status.ts#releaseStoredStop):
// no command can release it any more, so the core clears it on its own tick, or the persona's wakes would stay off in
// silence. The first tests hold the life's method over a state file, the last the core's beat over a memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dbOf } from '../src/memory/db/types.ts';
import { emptyState } from '../src/behavior/inner.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { personaKey } from '../src/memory/db/storage-keys.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { startUnitsCore, until, withRig } from './fixtures/core-units.ts';
import { clock, GUILD, NOW, setup } from './fixtures/inner-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const STOPPED = { stopped: true, stoppedAt: NOW - 1000, stoppedBy: 'owner' };

/** A data folder whose inner state file holds `state`, and the file. */
function stored(state: Record<string, unknown>): { dataDir: string; file: string } {
  const dataDir = tempDir('nep-stored-stop-');
  const file = path.join(dataDir, 'guilds', GUILD, 'inner.json');
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
  assert.equal(first.inner.status(GUILD).stopped, false);
  assert.notEqual((await first.inner.tick()).reason, 'stopped');
  assert.equal(setup({ records: [], dataDir }).inner.status(GUILD).stopped, false);
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
  await withRig({ config: { bot: { guildId: GUILD }, wakes: { tickSeconds: 1 } } }, async ({ dirs, llm, cores }) => {
    const file = path.join(dirs.dataDir, 'memory.db');
    const seed = openMemoryDb(file);
    applyUnitWrite(seed, { op: 'value', key: personaKey('inner'), value: { ...emptyState(), ...STOPPED } });
    seed.close();
    const stoppedNow = (): unknown => {
      const read = openMemoryDb(file, { readOnly: true });
      try {
        const found = unitValue(dbOf(read), personaKey('inner'));
        return found.found ? (found.value as { stopped?: unknown }).stopped : null;
      } finally {
        read.close();
      }
    };
    assert.equal(stoppedNow(), true);
    cores.push(await startUnitsCore(dirs, llm));
    await until(() => stoppedNow() === false, 'the stored stop to clear');
  });
});
