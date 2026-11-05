// The checked commit of a role's selection (src/subharness/selection.ts), the parts the command tests do not reach: a
// source that cannot take the effort asked for, and a failed check that must leave the role free for the next choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedSelection } from '../src/subharness/selection.ts';
import type { EnableDeps, SubharnessResult } from '../src/subharness/control.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const SAVED: SubharnessResult = { ok: true, code: 'ok', changed: true, message: 'saved' };

function rig(reply: () => boolean, help: string) {
  const privateDir = tempDir('nep-selection-');
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const ran: Array<string | undefined> = [];
  const deps: EnableDeps = {
    privateDir,
    fetch: fakeFetch().fetch,
    helpOf: () => Promise.resolve(help),
    runBackend: (_name, _brief, model) => {
      ran.push(model);
      const ok = reply();
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
  };
  return { deps, ran };
}

const select = (deps: EnableDeps, effort?: string): Promise<SubharnessResult> =>
  checkedSelection(
    deps,
    { claim: 'dev', backend: 'claude', keyValue: '', model: 'sonnet', ...(effort === undefined ? {} : { effort }) },
    () => 'the same',
    () => SAVED
  );

test('an effort this claude does not list is refused before any reply is asked', async () => {
  // Catches: a paid reply spent on a flag the binary dies on, or the effort dropped and saved as if it held.
  const { deps, ran } = rig(() => true, 'Options:\n  --model <model>\n');
  assert.equal((await select(deps, 'high')).code, 'effort-unsupported');
  assert.deepEqual(ran, []);
});

test('a selection after a refused one is saved, because the refused one holds the role no longer', async () => {
  // Catches: the failed check keeps its claim, so every later choice of that role answers selection-changed.
  let answers = false;
  const { deps } = rig(() => answers, '');
  assert.equal((await select(deps)).code, 'model-rejected');
  answers = true;
  assert.equal((await select(deps)).code, 'ok');
});
