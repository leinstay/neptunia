// The offline persona migration CLI is exercised in subprocesses with synthetic roots and no deployment environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './fixtures/tmp.ts';

const SCRIPT = path.join(import.meta.dirname, '../scripts/persona-files-move.ts');

function fixture() {
  const base = tempDir('nep-persona-cli-');
  const root = path.join(base, 'engine');
  const source = path.join(base, 'source');
  const target = path.join(base, 'target');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'));
  fs.writeFileSync(path.join(root, 'config/labels.json'), '{"model":{},"owner":{}}');
  fs.mkdirSync(path.join(source, 'prompts.local'), { recursive: true });
  fs.writeFileSync(path.join(source, 'prompts.local/rules.md'), 'PRIVATE_SENTINEL\n');
  fs.mkdirSync(target);
  const run = (args: Array<string>) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: base,
      env: { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? base },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    return { code: result.status, text: result.stdout + result.stderr };
  };
  const args = ['--root', 'engine', '--private', 'source', '--data', 'target'];
  return { base, root, source, target, args, run };
}

test('defaults to a dry run and resolves each supplied root against the working directory', () => {
  // Catches accidental application or resolving the source and target relative to the engine checkout.
  const f = fixture();
  const result = f.run(f.args);
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /rules\.md/);
  assert.equal(result.text.includes('PRIVATE_SENTINEL'), false);
  assert.equal(result.text.includes(f.base), false);
  assert.deepEqual(fs.readdirSync(f.target), []);
  assert.equal(fs.readFileSync(path.join(f.source, 'prompts.local/rules.md'), 'utf8'), 'PRIVATE_SENTINEL\n');
});

test('applies only when requested and leaves the source available on a repeat invocation', () => {
  // Catches destructive source moves or a successful exit without creating the requested canonical file.
  const f = fixture();
  for (let count = 0; count < 2; count++) {
    const result = f.run([...f.args, '--apply']);
    assert.equal(result.code, 0, result.text);
    assert.equal(result.text.includes('PRIVATE_SENTINEL'), false);
    assert.equal(result.text.includes(f.base), false);
    assert.equal(fs.readFileSync(path.join(f.target, 'prompts/rules.md'), 'utf8'), 'PRIVATE_SENTINEL\n');
    assert.equal(fs.readFileSync(path.join(f.source, 'prompts.local/rules.md'), 'utf8'), 'PRIVATE_SENTINEL\n');
  }
});

for (const args of [
  [],
  ['--private', 'source', '--data', 'target'],
  ['--root', 'engine', '--data', 'target'],
  ['--root', 'engine', '--private', 'source'],
  ['--root', 'engine', '--private', 'source', '--data'],
  ['--root', '--private', 'source', '--data', 'target'],
  ['--root', 'engine', '--private', 'source', '--data', 'target', '--bogus'],
]) {
  test(`refuses incomplete or unknown arguments ${JSON.stringify(args)} before writing`, () => {
    // Catches silently defaulting a required root to a real deployment or swallowing a flag as its value.
    const f = fixture();
    const result = f.run(args);
    assert.notEqual(result.code, 0);
    assert.match(result.text, /usage/i);
    assert.deepEqual(fs.readdirSync(f.target), []);
    assert.equal(fs.readFileSync(path.join(f.source, 'prompts.local/rules.md'), 'utf8'), 'PRIVATE_SENTINEL\n');
  });
}

test('returns one for a conflict and reports codes without parsed values or JSON excerpts', () => {
  // Catches parse errors exposing private settings or a conflict still copying another valid source.
  const f = fixture();
  fs.mkdirSync(path.join(f.source, 'config.local'));
  fs.writeFileSync(path.join(f.source, 'config.local/config.json'), '{"PRIVATE_SENTINEL":');
  const result = f.run([...f.args, '--apply']);
  assert.equal(result.code, 1);
  assert.match(result.text, /invalid-json/);
  assert.equal(result.text.includes('PRIVATE_SENTINEL'), false);
  assert.equal(result.text.includes(f.base), false);
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test('reports held material as requiring later migration while completing supported copies', () => {
  // Catches a success message claiming the whole persona is portable while agent contracts remain behind.
  const f = fixture();
  fs.writeFileSync(path.join(f.source, 'prompts.local/agent-probe.md'), 'PRIVATE_SENTINEL');
  const result = f.run([...f.args, '--apply']);
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /held|agent-contract/i);
  assert.match(result.text, /later|remain|require|incomplete/i);
  assert.equal(result.text.includes('PRIVATE_SENTINEL'), false);
  assert.equal(fs.readFileSync(path.join(f.target, 'prompts/rules.md'), 'utf8'), 'PRIVATE_SENTINEL\n');
  assert.equal(fs.existsSync(path.join(f.target, 'prompts/agent-probe.md')), false);
});

test('returns one for a filesystem write failure without leaking file contents', () => {
  // Catches a failed application returning success or printing the payload when file creation fails.
  const f = fixture();
  fs.chmodSync(f.target, 0o500);
  try {
    const result = f.run([...f.args, '--apply']);
    assert.equal(result.code, 1);
    assert.match(result.text, /EACCES|write|mkdir|install|unreadable/i);
    assert.equal(result.text.includes('PRIVATE_SENTINEL'), false);
    assert.equal(result.text.includes(f.base), false);
    assert.deepEqual(fs.readdirSync(f.target), []);
  } finally {
    fs.chmodSync(f.target, 0o700);
  }
});
