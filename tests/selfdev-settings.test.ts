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
