// src/simulation/key.ts: the simulation's switch and its one key reader. `simulation enable --key <name>` names an
// extra key; `simulationKey` returns its value for the paid scripts and refuses with one line while the simulation is
// off. Off is the default. keys.json lives in a temp dir; the reader is synchronous like the store's `readKeys`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { disableSimulation, enableSimulation, simulationKey, simulationStatus } from '../src/simulation/key.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SIM = 'sk-or-v1-sim-secret-0123456789';
const CORE = 'sk-or-v1-core-secret-9876543210';

function privateWith(changes: Parameters<typeof writeKeysFile>[1] = {}): string {
  const dir = tempDir('nep-sim-');
  writeKeysFile(dir, { core: [{ name: 'core-1', value: CORE }], extra: { sim: SIM }, ...changes });
  return dir;
}

test('the simulation is off in a fresh store and the status says no key', () => {
  // Bug: a fresh install has the simulation on, so a script spends money nobody agreed to.
  assert.deepEqual(simulationStatus(privateWith()), { on: false, key: null });
});

test('enable names an extra key and the status then reports it by name', () => {
  // Bug: the value is stored or shown instead of the name, or the switch is not persisted.
  const dir = privateWith();
  const result = enableSimulation(dir, 'sim');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(simulationStatus(dir), { on: true, key: 'sim' });
  assert.equal(readKeysFile(dir).simulation.key, 'sim');
  assert.equal(JSON.stringify([result, simulationStatus(dir)]).includes(SIM), false);
});

test('enable refuses a name that is no extra key, a core key name included', () => {
  // Bug: a script is pointed at a core key and spends the persona's budget (a tool never spends the bot's key).
  const dir = privateWith();
  for (const name of ['nope', 'core-1']) {
    const result = enableSimulation(dir, name);
    assert.equal(result.ok, false, name);
    assert.equal(result.code, 'key-unknown', name);
  }
  assert.equal(readKeysFile(dir).simulation.key, null);
});

test('enabling twice with the same key reports no change, and disable turns it off', () => {
  // Bug: a no-op reports a change; disable leaves the key name behind so a later enable looks already done.
  const dir = privateWith();
  enableSimulation(dir, 'sim');
  assert.equal(enableSimulation(dir, 'sim').changed, false);
  const off = disableSimulation(dir);
  assert.equal(off.changed, true);
  assert.deepEqual(simulationStatus(dir), { on: false, key: null });
  assert.equal(disableSimulation(dir).changed, false);
});

test('the reader returns the value of the named extra key while the simulation is on', () => {
  // Bug: the reader returns the name, or the first core key.
  const dir = privateWith({ simulation: { key: 'sim' } });
  assert.equal(simulationKey(dir), SIM);
});

test('the reader refuses with one line while the simulation is off, and the line holds no key', () => {
  // Bug: a script runs paid requests with the simulation off, or the refusal is a stack with the key in it.
  const dir = privateWith();
  assert.throws(
    () => simulationKey(dir),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message.includes('\n'), false, 'one line');
      assert.ok(err.message.includes('simulation enable'), 'names the command that turns it on');
      assert.equal(err.message.includes(SIM) || err.message.includes(CORE), false);
      assert.equal(Reflect.get(err, 'code'), 'simulation-off');
      return true;
    }
  );
});

test('the reader refuses when the key it names has left the store, naming the key and not its value', () => {
  // Bug: the reader returns undefined and the request goes out with "Bearer undefined", or falls back to a core key.
  const dir = privateWith({ simulation: { key: 'gone' } });
  assert.throws(
    () => simulationKey(dir),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('gone'));
      assert.equal(err.message.includes('\n'), false);
      return true;
    }
  );
});

test('no keys.json at all reads as off', () => {
  // Bug: a machine before `neptunia setup` crashes the script with a file error instead of the one-line refusal.
  const dir = tempDir('nep-sim-');
  assert.equal(simulationStatus(dir).on, false);
  assert.throws(() => simulationKey(dir), /simulation/);
});

test('no script reads OPENROUTER_SIM_KEY from the environment any more', () => {
  // Bug: one paid script still reads the variable, so the owner's "simulation disable" does not stop it.
  const scripts = path.join(import.meta.dirname, '..', 'scripts');
  const found: Array<string> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        fs.readFileSync(full, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            const code = line.trim();
            if (code.includes('OPENROUTER_SIM_KEY') && !code.startsWith('//') && !code.startsWith('*'))
              found.push(`${path.relative(scripts, full)}:${index + 1}`);
          });
      }
    }
  };
  walk(scripts);
  assert.deepEqual(found, []);
});
