// scripts/lib/cli.ts#simKey: the key every paid script spends. It comes from the simulation section of keys.json in the
// private dir the environment names (NEPTUNIA_PRIVATE_DIR), and a script refuses with one CliError line while the
// simulation is off. The old variable OPENROUTER_SIM_KEY has no say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliError, simKey } from '../scripts/lib/cli.ts';
import { diaryDayKey } from '../scripts/replay.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SIM = 'sk-or-v1-sim-secret-0123456789';

function envWith(simulation: { key: string | null }): Record<string, string> {
  const dir = tempDir('nep-simkey-');
  writeKeysFile(dir, { extra: { sim: SIM }, simulation });
  return { NEPTUNIA_PRIVATE_DIR: dir };
}

test('simKey returns the simulation key of the private dir the environment names', () => {
  // Bug: the script reads the checkout's own private dir, not the deployment's.
  assert.equal(simKey('replay-cli', envWith({ key: 'sim' })), SIM);
});

test('simKey refuses with a one-line CliError that names the tool while the simulation is off', () => {
  // Bug: the refusal is a bare Error with a stack, or it has no tool name and the owner cannot tell which script stopped.
  assert.throws(
    () => simKey('recall-eval', envWith({ key: null })),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.message.startsWith('recall-eval:'));
      assert.ok(err.message.includes('simulation'), 'says why');
      assert.equal(err.message.includes('\n'), false);
      assert.equal(err.message.includes(SIM), false);
      return true;
    }
  );
});

test('OPENROUTER_SIM_KEY in the environment does not override the off switch', () => {
  // Bug: an old .env still holds the variable, and the script spends it with the simulation off.
  const env = { ...envWith({ key: null }), OPENROUTER_SIM_KEY: 'sk-or-v1-from-env' };
  assert.throws(() => simKey('replay-cli', env), CliError);
});

test('a diary-day run takes the same key for live and fake pictures and refuses the same way', () => {
  // Bug: --draw live keeps its own reader of the environment and spends with the simulation off.
  const on = envWith({ key: 'sim' });
  assert.equal(diaryDayKey('live', on), SIM);
  assert.equal(diaryDayKey('fake', on), SIM);
  const off = envWith({ key: null });
  assert.throws(() => diaryDayKey('live', off), CliError);
});
