// src/setup/interfaces.ts: the interfaces step of `neptunia setup`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { interfacesStep } from '../src/setup/interfaces.ts';
import { interfaceCredential, localConfigPath } from '../src/config/files.ts';
import { tempDir } from './fixtures/tmp.ts';

function rig() {
  const base = tempDir('nep-setup-interfaces-');
  const rootDir = path.join(base, 'engine');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(rootDir, 'interfaces', 'chatty'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'interfaces', 'chatty', 'setup.json'),
    JSON.stringify({ settings: [{ key: 'token', question: 'The token', kind: 'secret', required: true }] })
  );
  // Changed: the step starts the instance it sets up, so it needs the scope.
  return { rootDir, dataDir, system: false };
}

/** The service manager, which starts anything it is asked to. */
const run = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });

function scripted(answers: Array<string>) {
  const asked: Array<{ question: string; secret: boolean }> = [];
  const ask = (question: string, _offered: string | null, options?: { secret: boolean }) => {
    asked.push({ question, secret: options?.secret === true });
    return Promise.resolve(answers.shift() ?? '');
  };
  return { ask, asked };
}

test('a yes asks the questions the package declares, the token without echo, and enables the interface', async () => {
  // Bug: the core setup hard-codes one platform's questions, or echoes the token, or leaves the interface off.
  const where = rig();
  const { ask, asked } = scripted(['yes', 'SECRETTOKEN']);
  const outcome = await interfacesStep(where, { ask, run });
  assert.equal(outcome.state, 'done');
  assert.deepEqual(asked[1], { question: 'The token', secret: true });
  assert.equal(interfaceCredential(where.dataDir, 'chatty'), 'SECRETTOKEN');
  const config = fs.readFileSync(localConfigPath(where.dataDir), 'utf8');
  // Changed: a clean setup runs the interface as its own unit, so it sets the mode too.
  assert.deepEqual(JSON.parse(config), { interfaces: { mode: 'units', chatty: { enabled: true } } });
});

test('a no writes nothing, and a yes without the required value leaves the interface off', async () => {
  // Bug: declining leaves an empty folder, or an interface with no token is enabled and fails at every start.
  const where = rig();
  assert.equal((await interfacesStep(where, { ask: scripted(['no']).ask, run })).state, 'already');
  assert.equal(fs.existsSync(path.join(where.dataDir, 'interfaces')), false);
  await interfacesStep(where, { ask: scripted(['yes', '']).ask, run });
  assert.equal(fs.existsSync(localConfigPath(where.dataDir)), false);
});
