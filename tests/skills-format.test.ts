// The SKILL.md format (src/skills/format.ts): front matter with `name`, `description`, `tools` and an optional `task`,
// then the prose. The parse answers a code for every way a file can be wrong, so a loader can name the problem. Pure
// text in, no disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseSkillFile } from '../src/skills/format.ts';
import type { ParsedSkill } from '../src/skills/format.ts';

const BODY = 'When a question needs the web.\n\nSteps: search, read the best hit, then answer.';

const file = (front: string, body = BODY): string => `---\n${front}\n---\n${body}\n`;

const GOOD = file(
  [
    'name: look-it-up',
    'description: I check the web before I answer a fact question',
    'tools: [web.read, web.search]',
  ].join('\n')
);

/** The parsed skill, failing the test when the file did not parse. */
function parsed(source: string): ParsedSkill {
  const result = parseSkillFile(source);
  const message = result.ok ? '' : result.code;
  assert.equal(result.ok, true, message);
  if (!result.ok) throw new Error(result.code);
  return result.skill;
}

function codeOf(source: string): string {
  const result = parseSkillFile(source);
  return result.ok ? 'ok' : result.code;
}

test('reads the name, her description, the sorted tools and the prose of a whole file', () => {
  const skill = parsed(GOOD);
  assert.equal(skill.name, 'look-it-up');
  assert.equal(skill.description, 'I check the web before I answer a fact question');
  assert.deepEqual(skill.tools, ['web.read', 'web.search']);
  assert.equal(skill.task, null);
  assert.equal(skill.body, BODY);
  assert.equal(skill.source, GOOD);
});

test('the content hash is the sha256 of the file text, so one changed character is another version', () => {
  const skill = parsed(GOOD);
  assert.equal(skill.contentHash, createHash('sha256').update(GOOD).digest('hex'));
  assert.notEqual(parsed(`${GOOD} `).contentHash, skill.contentHash);
});

test('reads a block list of tools and drops a repeated tool', () => {
  const skill = parsed(
    file(
      ['name: two-steps', 'description: d', 'tools:', '  - web.search', '  - web.search', '  - message.create'].join(
        '\n'
      )
    )
  );
  assert.deepEqual(skill.tools, ['message.create', 'web.search']);
});

test('an empty tool list is a skill of prose alone', () => {
  assert.deepEqual(parsed(file('name: just-words\ndescription: d\ntools: []')).tools, []);
});

test('keeps the board task a skill came from', () => {
  assert.equal(parsed(file('name: from-task\ndescription: d\ntools: []\ntask: t0000001f')).task, 't0000001f');
});

test('refuses a file with no front matter block', () => {
  assert.equal(codeOf(BODY), 'no-front-matter');
  assert.equal(codeOf(''), 'no-front-matter');
});

test('refuses a front matter that is opened and never closed', () => {
  assert.equal(codeOf(`---\nname: a-skill\ndescription: d\ntools: []\n${BODY}\n`), 'bad-front-matter');
});

test('refuses a line of the front matter that is no key and value', () => {
  assert.equal(codeOf(file('name: a-skill\nwhat is this\ntools: []')), 'bad-front-matter');
});

test('refuses a missing name, a name that is not kebab-case and a missing description', () => {
  assert.equal(codeOf(file('description: d\ntools: []')), 'no-name');
  assert.equal(codeOf(file('name: Look It Up\ndescription: d\ntools: []')), 'bad-name');
  assert.equal(codeOf(file('name: ../escape\ndescription: d\ntools: []')), 'bad-name');
  assert.equal(codeOf(file('name: a-skill\ntools: []')), 'no-description');
  assert.equal(codeOf(file('name: a-skill\ndescription:   \ntools: []')), 'no-description');
});

test('refuses a missing tools key and a tool that is no tool name', () => {
  assert.equal(codeOf(file('name: a-skill\ndescription: d')), 'no-tools');
  assert.equal(codeOf(file('name: a-skill\ndescription: d\ntools: [web search]')), 'bad-tools');
  assert.equal(codeOf(file('name: a-skill\ndescription: d\ntools: [search]')), 'bad-tools');
});

test('refuses a file with front matter and no prose', () => {
  assert.equal(codeOf(file('name: a-skill\ndescription: d\ntools: []', '')), 'empty-body');
  assert.equal(codeOf(file('name: a-skill\ndescription: d\ntools: []', '  \n')), 'empty-body');
});
