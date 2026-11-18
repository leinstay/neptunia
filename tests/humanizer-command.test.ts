// src/interface/commands/humanizer.ts: `/humanizer enable`, `disable` and `status` against a private folder in a temp
// dir and this checkout's tracked layer. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { humanizerCommand } from '../src/interface/commands/humanizer.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

/** A private folder whose local config holds `config`. */
function privateDir(config: Record<string, unknown> = {}): string {
  const dir = path.join(tempDir('nep-humanizer-command-'), 'private');
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(config));
  return dir;
}

const statusOf = (dir: string): string => humanizerCommand(dir, 'humanizer.status', ROOT).text;

test('enable then status says the humanizer is on', () => {
  // Catches: enable writes a key the turn does not read, so the status and the turn disagree.
  const dir = privateDir();
  humanizerCommand(dir, 'humanizer.enable', ROOT);
  assert.equal(statusOf(dir).split('\n')[0], 'the humanizer is on');
});

test('disable then status says the humanizer is off', () => {
  // Catches: disable leaves an earlier enable in force.
  const dir = privateDir({ humanizer: { enabled: true } });
  humanizerCommand(dir, 'humanizer.disable', ROOT);
  assert.equal(statusOf(dir).split('\n')[0], 'the humanizer is off');
});

test('status names the route of a role and the command for a role with no route', () => {
  // Catches: a role with no route reads as ready, and the owner never learns the humanizer skips every text.
  const route = { via: 'harness', backend: 'claude', model: 'opus', effort: null };
  const dir = privateDir({ models: { routes: { 'editor': [route] } } });
  assert.deepEqual(statusOf(dir).split('\n').slice(1), [
    'linter: no route; /model set linter <route>',
    'editor: harness:claude/opus',
  ]);
});
