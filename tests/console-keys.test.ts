// Tests for the console's routing of the key commands (src/interface/commands/console.ts): `keys.*` always goes to the key
// commands with the dialog the caller gave, and `model.set` goes there only while the core takes its keys from the key
// store; before that it is the plain `model.set` operation, so a deployment on `.env` keeps its `/model set`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { statusText } from '../src/interface/neptunia-cli.ts';
import type { StatusFacts } from '../src/interface/neptunia-cli.ts';
import { tempDir } from './fixtures/tmp.ts';

function rig(enabled: boolean) {
  const dir = tempDir('console-keys-');
  const ops: Array<[string, Record<string, unknown>]> = [];
  const routed: Array<{ name: string; dialog: unknown }> = [];
  const deps: ConsoleDeps = {
    runOp: (op, args) => {
      ops.push([op, args]);
      return Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null });
    },
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
    keys: {
      enabled: () => enabled,
      run: (name, _args, dialog) => {
        routed.push({ name, dialog });
        return Promise.resolve({ text: 'keys answered', status: 'ok' });
      },
    },
  };
  return { console_: createConsole(deps), ops, routed };
}

const owner = { id: 'owner' };
const dialog = { ask: () => Promise.resolve('') };

test('a keys command reaches the key commands with the dialog it was given, whether or not the store is in use', async () => {
  for (const enabled of [false, true]) {
    const { console_, routed, ops } = rig(enabled);
    const answer = await console_.run('keys.core.add', { name: 'core-1' }, owner, dialog);
    assert.equal(answer.text, 'keys answered');
    // Bug caught: the dialog dropped on the way, so the key value could never be asked.
    assert.deepEqual(routed, [{ name: 'keys.core.add', dialog }]);
    assert.deepEqual(ops, []);
  }
});

test('model set is checked by the key commands while the store is in use, and is the plain operation before', async () => {
  const before = rig(false);
  await before.console_.run('model.set', { role: 'vision', model: 'x/y' }, owner);
  // Bug caught: a deployment still on .env losing its /model set because there is no key to check the model with.
  assert.deepEqual(before.ops, [['model.set', { role: 'vision', id: 'x/y' }]]);
  assert.deepEqual(before.routed, []);

  const after = rig(true);
  await after.console_.run('model.set', { role: 'vision', model: 'x/y' }, owner);
  assert.deepEqual(
    after.routed.map((one) => one.name),
    ['model.set']
  );
  assert.deepEqual(after.ops, []);
});

test('the summary names the reason of a pause the core set itself', () => {
  const facts: StatusFacts = {
    version: '1',
    instance: 'x',
    coreModel: 'c',
    paused: { since: '2026-11-02T09:00:00.000Z', reason: 'no-core-key' },
    spend: { requests: 0, cost: 0, coreCost: 0 },
    interfaces: [],
    failingRoles: [],
    next: null,
    intentions: null,
    errands: { open: 0, latest: [] },
    slept: 0,
  };
  assert.ok(statusText(facts).includes('no-core-key'));
  assert.ok(!statusText({ ...facts, paused: { since: null } }).includes('no-core-key'));
});
