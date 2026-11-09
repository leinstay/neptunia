// The settings of her self-development (src/selfimprovement/settings.ts). The mode decides whether the engine merges without
// the owner, so every test here names a way a wrong read would merge when it should not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfimprovementSettings } from '../src/selfimprovement/settings.ts';

test('the mode is approve when the config says nothing', () => {
  // Bug: a missing section reads as auto and the engine merges its own pull requests.
  assert.equal(selfimprovementSettings({}).mode, 'approve');
  assert.equal(selfimprovementSettings({ selfimprovement: 'auto' }).mode, 'approve');
});

test('only the exact word auto turns the merge to the engine', () => {
  // Bug: any truthy value, or another casing, counts as auto.
  assert.equal(selfimprovementSettings({ selfimprovement: { mode: 'auto' } }).mode, 'auto');
  assert.equal(selfimprovementSettings({ selfimprovement: { mode: 'Auto' } }).mode, 'approve');
  assert.equal(selfimprovementSettings({ selfimprovement: { mode: true } }).mode, 'approve');
  assert.equal(selfimprovementSettings({ selfimprovement: { mode: 'approve' } }).mode, 'approve');
});

test('the selfimprovement checkout is none when unset, and the absolute path the setting names when set', () => {
  // Catches: setup renders the selfimprovement units on every deployment, or drops the path the owner gave.
  assert.equal(selfimprovementSettings({}).checkout, null);
  assert.equal(
    selfimprovementSettings({ selfimprovement: { checkout: '/srv/dev-checkout' } }).checkout,
    '/srv/dev-checkout'
  );
});

test('a selfimprovement checkout that is empty, relative or not a string is none', () => {
  // Catches: a relative path becomes WorkingDirectory, which systemd refuses, and setup writes a unit that never starts.
  for (const checkout of ['', 'dev-checkout', 42, true])
    assert.equal(selfimprovementSettings({ selfimprovement: { checkout } }).checkout, null, JSON.stringify(checkout));
});

test('the repository her pull requests go to is none when unset, and owner/name when set', () => {
  // Catches: an unset setting reads as some default repository, so her pull requests go upstream without anyone naming it.
  assert.equal(selfimprovementSettings({}).repository, null);
  assert.equal(
    selfimprovementSettings({ selfimprovement: { repository: 'fork-owner/engine' } }).repository,
    'fork-owner/engine'
  );
  assert.equal(selfimprovementSettings({ selfimprovement: { repository: 'a.b/c_d-e' } }).repository, 'a.b/c_d-e');
});

test('a repository that is not owner/name is none', () => {
  // Catches: a URL or a path is passed to gh as --repo and every pull request of the beat fails.
  for (const repository of ['', 'engine', 'a/b/c', '/engine', 'owner/', 'https://github.com/a/b', 'a b/c', 42, null])
    assert.equal(
      selfimprovementSettings({ selfimprovement: { repository } }).repository,
      null,
      JSON.stringify(repository)
    );
});
