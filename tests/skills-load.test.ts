// Loading skills from disk (src/skills/load.ts): `<trackedDir>/<name>/SKILL.md` and `<localDir>/<name>/SKILL.md`, read at
// each call. A local skill shadows a tracked one of the same name whole. A folder that holds no skill, a README and a
// file that does not parse never stop the others; the loader names the folder it refused. Temporary folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSkills } from '../src/skills/load.ts';
import { tempDir } from './fixtures/tmp.ts';

const skillText = (name: string, description: string, tools = '[]'): string =>
  `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\nWhen it applies, and the steps.\n`;

function folders(): { trackedDir: string; localDir: string } {
  const root = tempDir('nep-skills-load-');
  return { trackedDir: path.join(root, 'skills'), localDir: path.join(root, 'skills.local') };
}

function put(dir: string, folder: string, text: string): void {
  fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), text);
}

test('loads the skills of both folders sorted by name, each with its layer', () => {
  const where = folders();
  put(where.trackedDir, 'zebra-notes', skillText('zebra-notes', 'tracked z'));
  put(where.localDir, 'alpha-habit', skillText('alpha-habit', 'local a'));
  const { skills, problems } = loadSkills(where);
  assert.deepEqual(
    skills.map((skill) => [skill.name, skill.layer, skill.dir]),
    [
      ['alpha-habit', 'local', 'alpha-habit'],
      ['zebra-notes', 'tracked', 'zebra-notes'],
    ]
  );
  assert.deepEqual(problems, []);
});

test('a local skill replaces the tracked skill of the same name whole', () => {
  const where = folders();
  put(where.trackedDir, 'look-it-up', skillText('look-it-up', 'tracked words', '[web.search]'));
  put(where.localDir, 'look-it-up', skillText('look-it-up', 'local words'));
  const { skills } = loadSkills(where);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.layer, 'local');
  assert.equal(skills[0]?.description, 'local words');
  assert.deepEqual(skills[0]?.tools, []);
});

test('missing folders give no skill and no problem', () => {
  const where = folders();
  assert.deepEqual(loadSkills(where), { skills: [], problems: [] });
});

test('ignores a README, a loose file and a folder with no SKILL.md', () => {
  const where = folders();
  fs.mkdirSync(path.join(where.trackedDir, 'empty-folder'), { recursive: true });
  fs.writeFileSync(path.join(where.trackedDir, 'README.md'), '# how to write a skill\n');
  put(where.trackedDir, 'real-one', skillText('real-one', 'd'));
  const { skills, problems } = loadSkills(where);
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ['real-one']
  );
  assert.deepEqual(problems, []);
});

test('names a file that does not parse and still loads the others', () => {
  const where = folders();
  put(where.localDir, 'broken-one', 'no front matter here\n');
  put(where.localDir, 'fine-one', skillText('fine-one', 'd'));
  const { skills, problems } = loadSkills(where);
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ['fine-one']
  );
  assert.deepEqual(problems, [{ dir: 'broken-one', code: 'no-front-matter' }]);
});

test('refuses a skill whose name differs from its folder', () => {
  const where = folders();
  put(where.localDir, 'one-name', skillText('another-name', 'd'));
  const { skills, problems } = loadSkills(where);
  assert.deepEqual(skills, []);
  assert.deepEqual(problems, [{ dir: 'one-name', code: 'name-mismatch' }]);
});

test('reads the disk at each call, so a file written after the first load shows in the next', () => {
  const where = folders();
  assert.equal(loadSkills(where).skills.length, 0);
  put(where.localDir, 'late-comer', skillText('late-comer', 'd'));
  assert.equal(loadSkills(where).skills.length, 1);
  fs.rmSync(path.join(where.localDir, 'late-comer'), { recursive: true });
  assert.equal(loadSkills(where).skills.length, 0);
});

test('refuses a skill named like a tool and keeps the others', () => {
  // Bug: a skill is an entry of the same tools array as the tools, so one named like a tool sends two functions of
  // one name and the provider refuses every request of the turn.
  const where = folders();
  put(where.localDir, 'lookup', skillText('lookup', 'shadows a tool'));
  put(where.localDir, 'fine-one', skillText('fine-one', 'd'));
  const { skills, problems } = loadSkills({ ...where, toolNames: new Set(['lookup', 'web.search']) });
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ['fine-one']
  );
  assert.deepEqual(problems, [{ dir: 'lookup', code: 'tool-name' }]);
});
