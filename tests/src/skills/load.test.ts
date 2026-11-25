// Loading skills from disk (src/skills/load.ts): `<localDir>/<name>/SKILL.md`, read at each call. A folder that holds
// no skill, a README and a file that does not parse never stop the others; the loader names the folder it refused.
// Temporary folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSkills } from '../../../src/skills/load.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { skillText as rigSkillText, skillsRig } from '../../fixtures/skills-rig.ts';

const skillText = (name: string, description: string, tools = '[]'): string =>
  `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\nWhen it applies, and the steps.\n`;

function folders(): { localDir: string } {
  return { localDir: path.join(tempDir('nep-skills-load-'), 'skills.local') };
}

function put(dir: string, folder: string, text: string): void {
  fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), text);
}

test('loads the skills of the folder sorted by name', () => {
  const where = folders();
  put(where.localDir, 'zebra-notes', skillText('zebra-notes', 'z'));
  put(where.localDir, 'alpha-habit', skillText('alpha-habit', 'a'));
  const { skills, problems } = loadSkills(where);
  assert.deepEqual(
    skills.map((skill) => [skill.name, skill.dir]),
    [
      ['alpha-habit', 'alpha-habit'],
      ['zebra-notes', 'zebra-notes'],
    ]
  );
  assert.deepEqual(problems, []);
});

test('a missing folder gives no skill and no problem', () => {
  const where = folders();
  assert.deepEqual(loadSkills(where), { skills: [], problems: [] });
});

test('ignores a README, a loose file and a folder with no SKILL.md', () => {
  const where = folders();
  fs.mkdirSync(path.join(where.localDir, 'empty-folder'), { recursive: true });
  fs.writeFileSync(path.join(where.localDir, 'README.md'), '# how to write a skill\n');
  put(where.localDir, 'real-one', skillText('real-one', 'd'));
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

// The skills port (src/skills/port.ts): the registry over the disk and the grants, as the persona's tools, the owner's
// `/skills` and an agent's commands use it. Every read looks at the skill folders first, so a file an agent wrote a
// moment ago is a pending version at once; only an activation puts a version in the persona's index; availability follows the persona's
// grants and the registry at the moment of the call and changes neither. A real memory database in memory and real
// temporary folders (tests/fixtures/skills-rig.ts).

const LOOK = rigSkillText(
  'look-it-up',
  'I check the web before I answer a fact',
  ['web.read', 'web.search'],
  'Search, read the best hit.'
);

test('a file that does not parse is no skill and breaks nothing else', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('broken-one', 'no front matter\n');
  rig.writeLocal('look-it-up', LOOK);
  assert.deepEqual(
    rig.port.pending().map((one) => one.skill),
    ['look-it-up']
  );
});
