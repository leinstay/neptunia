// The settings of her self-development (src/selfdev/settings.ts). The mode decides whether the engine merges without
// the owner, so every test here names a way a wrong read would merge when it should not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfdevSettings } from '../src/selfdev/settings.ts';

test('the mode is approve when the config says nothing', () => {
  // Bug: a missing section reads as auto and the engine merges its own pull requests.
  assert.equal(selfdevSettings({}).mode, 'approve');
  assert.equal(selfdevSettings({ selfdev: 'auto' }).mode, 'approve');
});

test('only the exact word auto turns the merge to the engine', () => {
  // Bug: any truthy value, or another casing, counts as auto.
  assert.equal(selfdevSettings({ selfdev: { mode: 'auto' } }).mode, 'auto');
  assert.equal(selfdevSettings({ selfdev: { mode: 'Auto' } }).mode, 'approve');
  assert.equal(selfdevSettings({ selfdev: { mode: true } }).mode, 'approve');
  assert.equal(selfdevSettings({ selfdev: { mode: 'approve' } }).mode, 'approve');
});

test('the base branch defaults to main and follows the setting', () => {
  assert.equal(selfdevSettings({}).base, 'main');
  assert.equal(selfdevSettings({ selfdev: { base: 'trunk' } }).base, 'trunk');
  assert.equal(selfdevSettings({ selfdev: { base: '' } }).base, 'main');
});

test('the selfdev checkout is none when unset, and the absolute path the setting names when set', () => {
  // Catches: setup renders the selfdev units on every deployment, or drops the path the owner gave.
  assert.equal(selfdevSettings({}).checkout, null);
  assert.equal(selfdevSettings({ selfdev: { checkout: '/srv/dev-checkout' } }).checkout, '/srv/dev-checkout');
});

test('a selfdev checkout that is empty, relative or not a string is none', () => {
  // Catches: a relative path becomes WorkingDirectory, which systemd refuses, and setup writes a unit that never starts.
  for (const checkout of ['', 'dev-checkout', 42, true])
    assert.equal(selfdevSettings({ selfdev: { checkout } }).checkout, null, JSON.stringify(checkout));
});

test('the repository her pull requests go to is none when unset, and owner/name when set', () => {
  // Catches: an unset setting reads as some default repository, so her pull requests go upstream without anyone naming it.
  assert.equal(selfdevSettings({}).repository, null);
  assert.equal(selfdevSettings({ selfdev: { repository: 'fork-owner/engine' } }).repository, 'fork-owner/engine');
  assert.equal(selfdevSettings({ selfdev: { repository: 'a.b/c_d-e' } }).repository, 'a.b/c_d-e');
});

test('a repository that is not owner/name is none', () => {
  // Catches: a URL or a path is passed to gh as --repo and every pull request of the beat fails.
  for (const repository of ['', 'engine', 'a/b/c', '/engine', 'owner/', 'https://github.com/a/b', 'a b/c', 42, null])
    assert.equal(selfdevSettings({ selfdev: { repository } }).repository, null, JSON.stringify(repository));
});
