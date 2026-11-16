// `neptunia doctor` (bin/neptunia.ts) reports a folder under `<data>/agents/` that names no shared agent, as a `warn`
// check named `agents` whose detail holds the folder and the code `no-shared-definition`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { folders, runCli } from './fixtures/core-units.ts';

type Check = { name: string; status: string; detail: string };

async function doctorChecks(strays: ReadonlyArray<string>): Promise<Array<Check>> {
  const dirs = folders({});
  for (const name of strays) fs.mkdirSync(path.join(dirs.dataDir, 'agents', name), { recursive: true });
  fs.writeFileSync(
    path.join(dirs.privateDir, 'keys.json'),
    JSON.stringify({ core: [{ name: 'core-1', value: 'sk-or-test-not-a-real-key' }], extra: {}, roles: {} }),
    { mode: 0o600 }
  );
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed: unknown = JSON.parse(run.stdout);
  return typeof parsed === 'object' && parsed !== null && Array.isArray(Reflect.get(parsed, 'checks'))
    ? (Reflect.get(parsed, 'checks') as Array<Check>)
    : [];
}

test('neptunia doctor warns about a stray agent folder, naming it and the code', async () => {
  // Bug: the loaders skip the folder, so without a doctor check the owner never learns the folder is ignored.
  const check = (await doctorChecks(['ghost'])).find((entry) => entry.name === 'agents');
  assert.equal(check?.status, 'warn');
  assert.ok((check?.detail ?? '').includes('ghost'), check?.detail);
  assert.ok((check?.detail ?? '').includes('no-shared-definition'), check?.detail);
});

test('neptunia doctor has no agents warning when every agent folder is a shared one', async () => {
  // Bug: the check warns on a clean data folder.
  const check = (await doctorChecks([])).find((entry) => entry.name === 'agents');
  assert.notEqual(check?.status, 'warn');
});
