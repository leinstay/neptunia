// The public repository holds exactly one file of the persona root, its generic README. Runs `git check-ignore`
// against the repository's own `.gitignore`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function isIgnored(file: string): boolean {
  return spawnSync('git', ['check-ignore', '--quiet', '--no-index', file]).status === 0;
}

test('keeps only the generic README of the persona root trackable', () => {
  // Bug: a widened allowlist lets `git add` take her prompts, her settings, her memory or a key into the public repo.
  assert.equal(isIgnored('data/README.md'), false);
  for (const file of [
    'data/memory.db',
    'data/keys.json',
    'data/config/config.json',
    'data/prompts/character-card.md',
    'data/prompts/README.md',
    'data/interfaces/discord/credentials.json',
    'data/skills/any/SKILL.md',
    'data/subharness/claude/home/.credentials.json',
    'data/media/diary/a.png',
    'data/.gitignore',
  ]) {
    assert.equal(isIgnored(file), true, file);
  }
});
