// The one list of secret files, shared by every tool that copies a folder (src/memory/db/secret-files.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretClassOfPath } from '../src/memory/db/secret-files.ts';

test('names every file of the secret classes by its path, at any depth, with either separator', () => {
  const cases: Array<[string, string]> = [
    ['keys.json', 'keys'],
    ['nested/keys.json', 'keys'],
    ['interfaces/discord/credentials.json', 'credentials'],
    ['credentials.json', 'credentials'],
    ['subharness/claude/home/.credentials.json', 'credentials'],
    ['subharness/codex/home/auth.json', 'credentials'],
    ['clients.json', 'clients'],
    ['clients/a.token', 'clients'],
    ['clients/deep/b.env', 'clients'],
    ['.env', 'env'],
    ['interfaces/telegram/bot.env', 'env'],
    ['interfaces\\discord\\credentials.json', 'credentials'],
  ];
  for (const [rel, expected] of cases) assert.equal(secretClassOfPath(rel), expected, rel);
});

test('leaves ordinary files alone, including names that only look like a secret file', () => {
  for (const rel of [
    'memory.db',
    'prompts/keys.md',
    'config/environment.json',
    'media/selfreflection/d-1-1.png',
    'notes/backups.txt',
    'notes/clients.md',
    'skills/auth/SKILL.md',
    'myenv',
  ])
    assert.equal(secretClassOfPath(rel), null, rel);
});
