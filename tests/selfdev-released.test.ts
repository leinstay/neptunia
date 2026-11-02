// The released classes (src/selfdev/released.ts): which pull requests may merge without the owner's hand. The glob
// match decides what lands unattended, so every test here names a way a wrong match would let a path through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReleased, selfdevSettings, unreleasedOf } from '../src/selfdev/released.ts';

test('a file that matches a glob is released', () => {
  assert.equal(isReleased(['prompts/format.md'], ['prompts/*.md']), true);
});

test('a star does not cross a folder, so a nested prompt is not released by prompts/*.md', () => {
  // Bug: `*` compiled to `.*` releases prompts/sub/deep.md and anything under it.
  assert.equal(isReleased(['prompts/sub/deep.md'], ['prompts/*.md']), false);
});

test('a double star crosses folders', () => {
  assert.equal(isReleased(['skills/web/SKILL.md'], ['skills/**']), true);
  assert.equal(isReleased(['skills/web/SKILL.md'], ['skills/**/SKILL.md']), true);
});

test('one unreleased file keeps the whole pull request unreleased', () => {
  // Bug: "any file matches" instead of "every file matches" merges src/ changes riding on a prompt edit.
  assert.equal(isReleased(['prompts/format.md', 'src/core.ts'], ['prompts/*.md']), false);
  assert.deepEqual(unreleasedOf(['prompts/format.md', 'src/core.ts', 'src/a.ts'], ['prompts/*.md']), [
    'src/core.ts',
    'src/a.ts',
  ]);
});

test('a pull request with no files is not released', () => {
  // Bug: `[].every(...)` is true, so an empty file list from a failed read merges.
  assert.equal(isReleased([], ['prompts/*.md']), false);
});

test('no globs release nothing', () => {
  assert.equal(isReleased(['prompts/format.md'], []), false);
});

test('a dot in a glob is a dot, and a glob matches the whole path', () => {
  // Bug: an unescaped `.` releases config/labelsXjson; an unanchored match releases a longer name.
  assert.equal(isReleased(['config/labels.json'], ['config/labels.json']), true);
  assert.equal(isReleased(['config/labelsXjson'], ['config/labels.json']), false);
  assert.equal(isReleased(['config/labels.json.bak'], ['config/labels.json']), false);
  assert.equal(isReleased(['old/config/labels.json'], ['config/labels.json']), false);
});

test('a path that climbs out of a released folder is not released', () => {
  // Bug: the string prompts/../src/core.ts matches prompts/** while naming a file of src/.
  assert.equal(isReleased(['prompts/../src/core.ts'], ['prompts/**']), false);
  assert.equal(isReleased(['/etc/passwd'], ['**']), false);
  assert.equal(isReleased(['prompts\\..\\src\\core.ts'], ['prompts/**']), false);
});

test('the settings drop an entry that is not a glob instead of throwing', () => {
  // Bug: a number or an empty string in selfdev.released reaches the matcher and crashes the beat or releases all.
  const set = selfdevSettings({
    selfdev: { released: ['prompts/*.md', 3, '', null, 'config/labels.json'], base: 'trunk' },
  });
  assert.deepEqual(set.released, ['prompts/*.md', 'config/labels.json']);
  assert.equal(set.base, 'trunk');
});

test('a config without the section releases nothing', () => {
  assert.deepEqual(selfdevSettings({}).released, []);
  assert.deepEqual(selfdevSettings({ selfdev: 'all' }).released, []);
});
