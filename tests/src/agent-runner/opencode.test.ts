// src/agent-runner/opencode.ts: what the engine of a runner shares. The task prompt leaves the scope out of the context,
// the collection of result files skips an agent's own dotfiles, a text file that carries a secret is dropped, and a
// prompt override this process may not read counts as absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectFiles, deliverableFiles, readPromptFile, taskPrompt } from '../../../src/agent-runner/opencode.ts';
import { tempDir } from '../../fixtures/tmp.ts';

test('the task prompt holds the goal, and the context without its scope', () => {
  // Bug: the scope (who asked) is shown to the agent, which then argues from it.
  const prompt = taskPrompt('look at the disk', { scope: 'dm', note: 'urgent' });
  assert.ok(prompt.includes('<goal>\nlook at the disk\n</goal>'));
  assert.ok(prompt.includes('urgent'));
  assert.equal(prompt.includes('"scope"'), false);
});

test('result files are collected from the task folder, dotfiles skipped', async () => {
  // Bug: the agent's own config files are delivered as results.
  const dir = tempDir('nep-opencode-');
  fs.mkdirSync(path.join(dir, 't1'));
  fs.writeFileSync(path.join(dir, 't1', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 't1', '.hidden'), 'x');
  const files = await collectFiles(dir, 't1');
  assert.deepEqual(
    files.map((file) => file.name),
    ['a.txt']
  );
});

test('a text file that carries a secret is dropped, in the core scope too', async () => {
  // Bug: a copied .env is delivered to the chat.
  const dir = tempDir('nep-opencode-');
  fs.mkdirSync(path.join(dir, 't1'));
  fs.writeFileSync(
    path.join(dir, 't1', 'env.txt'),
    'OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef'
  );
  fs.writeFileSync(path.join(dir, 't1', 'ok.txt'), 'plain words');
  const { files, dropped } = await deliverableFiles(await collectFiles(dir, 't1'));
  assert.deepEqual(
    files.map((file) => file.name),
    ['ok.txt']
  );
  assert.deepEqual(dropped, [{ name: 'env.txt', reason: 'secret' }]);
});
import { onLog } from '../../../src/log.ts';

import type { Untyped } from '../../../src/tools/types.ts';

test('readPromptFile: an override that exists but cannot be read falls back to the tracked prompt, warned once; other errors still throw', () => {
  const override = '/private-unreadable/agents/scout/prompt.md';
  const tracked = '/checkout/agents/scout/prompt.md';
  const failing = (code: Untyped) => (file: string) => {
    if (file === override) throw Object.assign(new Error(`${code}: ${file}`), { code });
    if (file === tracked) return 'tracked';
    throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  };
  const seen: Array<Untyped> = [];
  const off = onLog((entry) => seen.push(entry));
  try {
    assert.equal(readPromptFile([override, tracked], { read: failing('EACCES') }), 'tracked');
    assert.equal(readPromptFile([override, tracked], { read: failing('EACCES') }), 'tracked', 'every task falls back');
    assert.equal(readPromptFile([override, tracked], { read: failing('EPERM') }), 'tracked');
    const warns = seen.filter((entry) => entry.msg === 'profiles: override unreadable');
    assert.equal(warns.length, 1, 'one warning per process, not per task');
    assert.equal(warns[0].level, 'warn');
    assert.equal(warns[0].file, override);
    assert.throws(
      () => readPromptFile([override, tracked], { read: failing('EISDIR') }),
      { code: 'EISDIR' },
      'any other error still fails'
    );
    const trackedDenied = (file: string) => {
      if (file === override) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    assert.throws(
      () => readPromptFile([override, tracked], { read: trackedDenied }),
      { code: 'EACCES' },
      'the tracked prompt itself unreadable still fails'
    );
  } finally {
    off();
  }
});
