// Tests for the route of `keys.service.*` through the console (src/interface/commands/console.ts) with the real key
// commands (src/keys/commands.ts) behind `deps.keys`, as the engine builds it while keys.json is in use. The service
// commands are answered by src/keys/services.ts, not by the key commands, so the console must not hand them over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { createKeysCommands } from '../src/keys/commands.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { BASE_URL, fakeFetch, fakePause, scriptedDialog } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const EXA_VALUE = 'exa-SECRETVALUE-0001-WXYZ';

function rig() {
  const dir = tempDir('console-keys-service-');
  const store = createKeyStore({ privateDir: dir });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 0 }) });
  const keys = createKeysCommands({
    store,
    ring,
    fetch: fakeFetch().fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => '',
    saveModel: () => Promise.resolve(),
    pause: fakePause(),
  });
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: {} },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => 0,
    keys: { enabled: () => true, run: (name, args, dialog) => keys.run(name, args, dialog) },
  };
  return { console_: createConsole(deps), file: path.join(dir, 'keys.json') };
}

const owner = { id: 'owner' };

test('keys service list answers ok with the service list while the key store is in use', async () => {
  // Bug: the console hands every `keys.` name to the key commands, which answer "no such command" for the service ones.
  const { console_ } = rig();
  const answer = await console_.run('keys.service.list', {}, owner, null);
  assert.equal(answer.status, 'ok');
  assert.match(answer.text, /exa: not set/);
});

test('keys service set writes the secret asked in the dialog under services and never echoes it', async () => {
  // Bug: the same route swallows `keys.service.set`, so the value is never asked and nothing is written.
  const { console_, file } = rig();
  const { dialog, asked } = scriptedDialog([EXA_VALUE]);
  const answer = await console_.run('keys.service.set', { name: 'exa' }, owner, dialog);
  assert.equal(answer.status, 'ok');
  assert.equal(asked[0]?.secret, true);
  assert.equal(answer.text.includes(EXA_VALUE), false);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { services?: Record<string, string> };
  assert.equal(stored.services?.exa, EXA_VALUE);
});
