// src/subharness/enable-dialog.ts: the questions after an enable. Each answer gets one reply check, a refused model
// asks the same question again, and nothing is stored before the fourth answer. The backend runner is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerEnable, startEnable } from '../src/subharness/enable-dialog.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

function rig(good: ReadonlyArray<string>): EnableDeps {
  const dir = tempDir('nep-dialog-');
  writeKeysFile(dir);
  return {
    privateDir: dir,
    runBackend: (_name, _brief, model) => {
      const ok = model === undefined || good.includes(model);
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}')),
  };
}

test('a backend that fails its check ends the dialog before any question', async () => {
  // Bug: the owner is asked four questions about a backend that is not there.
  const deps = rig([]);
  const failing: EnableDeps = { ...deps, runBackend: () => Promise.resolve({ ok: false, text: '', exitCode: 1 }) };
  const result = await startEnable(failing, 'codex');
  assert.equal('dialogId' in result, false);
  assert.equal('ok' in result && result.ok, false);
});

test('the id of a dialog that was finished answers nothing a second time', async () => {
  // Bug: a repeated answer stores the models again or reopens the dialog.
  const deps = rig(['m']);
  let step = await startEnable(deps, 'claude', undefined, () => 'fixed');
  for (let i = 0; i < 4; i += 1) step = await answerEnable(deps, 'fixed', 'm');
  assert.equal('ok' in step && step.ok, true);
  assert.equal(readKeysFile(deps.privateDir).subharness.backend, 'claude');
  const again = await answerEnable(deps, 'fixed', 'm');
  assert.equal('ok' in again && again.ok, false);
});

test('an empty answer asks the same question again', async () => {
  // Bug: an empty line is checked as a model name and stored.
  const deps = rig(['m']);
  const first = await startEnable(deps, 'claude', undefined, () => 'empty');
  const next = await answerEnable(deps, 'empty', '   ');
  assert.equal('dialogId' in next && 'dialogId' in first && next.prompt.includes('scout'), true);
});
