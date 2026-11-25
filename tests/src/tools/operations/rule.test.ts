import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createStore } from '../../../../src/memory/store.ts';
import { makeAdmin, makeRoot } from '../../../fixtures/admin-rig.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';

// ---------------------------------------------------------------------------
// createAdmin().run — fakes on a temp dir
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rule.add / rule.list / rule.remove
// ---------------------------------------------------------------------------

/** An admin over a real store on a fresh test memory, closed after `body`. */
async function withRulesAdmin(
  body: (admin: ReturnType<typeof makeAdmin>['admin'], rootDir: string) => Promise<void>
): Promise<void> {
  const mem = await openTestMemory();
  try {
    const rootDir = makeRoot();
    const store = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    await body(makeAdmin(rootDir, { store }).admin, rootDir);
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
}

// Changed: the rules are rows of the memory table `rules`, so `rule.add` and `rule.remove`
// write no file and reload no prompt; these replace the tests of the bullets they wrote to `prompts.local/rules.md`.
test('run: rule.add then rule.remove leave the later rule listed as 1 and write no prompt file', () =>
  withRulesAdmin(async (admin, rootDir) => {
    const baseBefore = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'));
    await admin.run('rule.add', { text: 'be kind' }, {});
    await admin.run('rule.add', { text: 'second\nrule' }, {});
    assert.equal(await admin.run('rule.list', {}, {}), '1. be kind\n2. second rule');
    assert.equal(await admin.run('rule.remove', { number: 1 }, {}), 'Removed rule #1: be kind');
    assert.equal(await admin.run('rule.list', {}, {}), '1. second rule');
    assert.equal(fs.existsSync(path.join(rootDir, 'prompts.local')), false);
    assert.deepEqual(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md')), baseBefore);
  }));

test('run: rule.add rejects empty text', () =>
  withRulesAdmin(async (admin) => {
    await assert.rejects(() => admin.run('rule.add', { text: '   ' }, {}));
  }));

test('run: rule.remove rejects a number past the live rules', () =>
  withRulesAdmin(async (admin) => {
    await admin.run('rule.add', { text: 'only rule' }, {});
    await assert.rejects(() => admin.run('rule.remove', { number: 2 }, {}), /no rule #2/);
    await assert.rejects(() => admin.run('rule.remove', { number: 0 }, {}), /no rule #0/);
  }));
