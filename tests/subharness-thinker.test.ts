// src/subharness/control.ts: the thinker is an agent of the subharness like the others: it takes a backend, a model and
// an effort, the status lists it, and it runs in `write` by default. keys.json lives in a temp dir; the backend runner
// and its `--help` are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentPaths,
  modeOf,
  setAgentModel,
  statusText,
  subharnessView,
  useBackend,
} from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

function rig() {
  const dir = tempDir('nep-thinker-');
  writeKeysFile(dir, { subharness: { backends: ['codex', 'claude'], key: null, modes: {}, models: {}, uses: {} } });
  const ran: Array<{ name: string; model: string | undefined; effort: string | undefined }> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model, effort) => {
      ran.push({ name, model, effort });
      return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    helpOf: () => Promise.resolve('Usage: claude [options]\n  --model <model>\n  --effort <level>\n'),
  };
  return { dir, deps, ran };
}

test('use takes the thinker', async () => {
  // Catches: "subharness use thinker claude" is refused unknown-agent, so the thinker has no path of its own.
  const { dir } = rig();
  const result = await useBackend(dir, 'thinker', 'claude');
  assert.equal(result.ok, true);
  assert.equal(readKeysFile(dir).subharness.uses?.thinker, 'claude');
});

test('model set takes the thinker with an effort, after one reply through its backend', async () => {
  // Catches: the model of the thinker cannot be set, or it is checked on the first connected backend and not on claude.
  const { dir, deps, ran } = rig();
  await useBackend(dir, 'thinker', 'claude');
  const result = await setAgentModel(deps, 'thinker', 'claude-opus-5-5', 'medium');
  assert.equal(result.ok, true);
  assert.deepEqual(ran, [{ name: 'claude', model: 'claude-opus-5-5', effort: 'medium' }]);
  const stored = readKeysFile(dir).subharness;
  assert.equal(stored.models?.thinker, 'claude-opus-5-5');
  assert.equal(stored.efforts?.thinker, 'medium');
});

test('the paths list the thinker with its backend, model and effort', async () => {
  // Catches: the thinker runs on a path no caller of agentPaths can see.
  const { dir, deps } = rig();
  await useBackend(dir, 'thinker', 'claude');
  await setAgentModel(deps, 'thinker', 'claude-opus-5-5', 'medium');
  assert.deepEqual(
    agentPaths(dir).find((one) => String(one.agent) === 'thinker'),
    { agent: 'thinker', backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' }
  );
});

test('the status lists the thinker in write with its backend, model and effort', async () => {
  // Catches: the owner reads the status and cannot see which CLI and model the thinker runs on.
  const { dir, deps } = rig();
  await useBackend(dir, 'thinker', 'claude');
  await setAgentModel(deps, 'thinker', 'claude-opus-5-5', 'medium');
  const text = statusText(await subharnessView(dir), {}, agentPaths(dir));
  const row = text.split('\n').find((line) => line.startsWith('  thinker ')) ?? '';
  for (const word of ['write', 'claude', 'claude-opus-5-5', 'medium'])
    assert.ok(row.includes(word), `${word} on "${row}"`);
});

test('the thinker runs in write until the owner says otherwise', () => {
  // Catches: the thinker falls to the read mode of an unlisted agent and cannot write what it was started for.
  assert.equal(modeOf({}, 'thinker'), 'write');
});
