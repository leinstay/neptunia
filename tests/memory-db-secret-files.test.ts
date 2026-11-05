// The one list of secret files, shared by the backup, the restore and every tool that copies a data folder
// (src/memory/db/secret-files.ts). Owner's word, 2026-11-05: keys never go into a backup. All values are synthetic and
// built from pieces so that no scanner reads this file as a leaked key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_CLASSES,
  secretClassOf,
  secretClassOfContent,
  secretClassOfPath,
} from '../src/memory/db/secret-files.ts';

const OPENROUTER = ['sk', 'or', 'v1', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'].join('-');
const ANTHROPIC = [
  'sk',
  'ant',
  'api03',
  'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456',
].join('-');
const GOOGLE = `${'AI'}${'za'}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q`;

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
    ['backups/old/keys.json', 'backups'],
    ['backups/note.txt', 'backups'],
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

test('recognises an OpenRouter, an Anthropic and a Google key inside text', () => {
  for (const key of [OPENROUTER, ANTHROPIC, GOOGLE])
    assert.equal(secretClassOfContent(Buffer.from(`token = "${key}"\nmore\n`)), 'key-pattern', key.slice(0, 8));
  assert.equal(secretClassOfContent(`pasted ${OPENROUTER}`), 'key-pattern', 'a string works as well as a buffer');
});

test('does not mistake prose or near misses for a key', () => {
  for (const text of ['the sk-or-v1 prefix is documented', 'sk-ant is short', 'AIza', 'a plain diary line', ''])
    assert.equal(secretClassOfContent(Buffer.from(text)), null, text);
});

test('secretClassOf answers by path first and by content when the path is ordinary', () => {
  assert.equal(secretClassOf('keys.json'), 'keys');
  assert.equal(secretClassOf('keys.json', Buffer.from('{}')), 'keys');
  assert.equal(secretClassOf('notes/pasted.txt', Buffer.from(OPENROUTER)), 'key-pattern');
  assert.equal(secretClassOf('notes/pasted.txt', Buffer.from('nothing here')), null);
  assert.equal(secretClassOf('notes/pasted.txt'), null);
});

test('lists its classes once each', () => {
  assert.deepEqual([...SECRET_CLASSES].sort(), ['backups', 'clients', 'credentials', 'env', 'key-pattern', 'keys']);
});
