// The skills a plugin ships (src/skills/load.ts `pluginDirs`): read beside the tracked and local skills, a tracked
// skill replaced by a plugin's of the same name, and a plugin's replaced by a local one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSkills } from '../src/skills/load.ts';
import { skillText } from './fixtures/skills-rig.ts';
import { ECHO_DIR } from './fixtures/plugin-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

function write(dir: string, name: string, description: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), skillText(name, description, ['web.read']));
}

test('reads the skill the echo plugin ships from its skills folder, marked as a plugin skill', () => {
  const root = tempDir('nep-plugin-skills-');
  const { skills, problems } = loadSkills({
    trackedDir: path.join(root, 'skills'),
    localDir: path.join(root, 'skills.local'),
    pluginDirs: [path.join(ECHO_DIR, 'skills')],
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(
    skills.map((skill) => [skill.name, skill.layer, skill.tools]),
    [['echo-say', 'plugin', ['echo.say']]]
  );
});

test('with no plugin folder the skills are the tracked and local ones alone', () => {
  const root = tempDir('nep-plugin-skills-');
  write(path.join(root, 'skills'), 'one', 'tracked');
  const { skills } = loadSkills({
    trackedDir: path.join(root, 'skills'),
    localDir: path.join(root, 'skills.local'),
    pluginDirs: [],
  });
  assert.deepEqual(
    skills.map((skill) => skill.layer),
    ['tracked']
  );
});

test('a plugin skill replaces the tracked skill of its name, and a local skill replaces both', () => {
  const root = tempDir('nep-plugin-skills-');
  const plugin = path.join(root, 'plugin-skills');
  write(path.join(root, 'skills'), 'same', 'tracked');
  write(plugin, 'same', 'plugin');
  const only = loadSkills({
    trackedDir: path.join(root, 'skills'),
    localDir: path.join(root, 'skills.local'),
    pluginDirs: [plugin],
  });
  assert.deepEqual(
    only.skills.map((skill) => [skill.layer, skill.description]),
    [['plugin', 'plugin']]
  );
  write(path.join(root, 'skills.local'), 'same', 'local');
  const both = loadSkills({
    trackedDir: path.join(root, 'skills'),
    localDir: path.join(root, 'skills.local'),
    pluginDirs: [plugin],
  });
  assert.deepEqual(
    both.skills.map((skill) => [skill.layer, skill.description]),
    [['local', 'local']]
  );
});
