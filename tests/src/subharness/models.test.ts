// Tests for src/subharness/models.ts: a model selection is checked with one reply before it is stored. The backend
// runner and fetch are fakes; keys.json is in a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModel } from '../../../src/subharness/models.ts';
import type { EnableDeps } from '../../../src/subharness/control.ts';
import { writeKeysFile } from '../../fixtures/keys-file.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const SECRET = 'sk-or-v1-oc-secret-0123456789';

/** Deps whose backend answers only for the models in `good`; every model asked is recorded. */
function rig(good: ReadonlyArray<string>) {
  const dir = tempDir('nep-models-');
  writeKeysFile(dir, { extra: { opencode: SECRET } });
  const asked: Array<string | undefined> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (_name, _brief, model) => {
      asked.push(model);
      const ok = model === undefined || good.includes(model);
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps, asked };
}

test('the check of an opencode model asks OpenRouter for the id behind the backend prefix', async () => {
  // Bug: the name opencode runs, openrouter/<id>, went to OpenRouter whole and came back HTTP 400, so no usable model
  // of opencode could pass the check of /subharness enable.
  const sent: Array<string> = [];
  const { deps } = rig([]);
  const seen: EnableDeps = {
    ...deps,
    fetch: (_url, init) => {
      // The check sends its body as a JSON string.
      const body = JSON.parse(init?.body as string) as { model: string };
      sent.push(body.model);
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  };
  assert.equal(await checkModel(seen, 'opencode', SECRET, 'openrouter/vendor/model'), null);
  assert.deepEqual(sent, ['vendor/model']);
});
