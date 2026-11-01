// Her skill index (src/skills/index-block.ts): one line per skill she can use now, in her words, as the body of the
// `<skills>` block, and nothing when no skill is usable. A skill with a tool that is not granted or not registered is
// left out and the missing tool is named with its reason. The labels are handed in, so no test pins a wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingTools, skillIndexBlock } from '../src/skills/index-block.ts';
import type { ActiveSkill } from '../src/skills/index-block.ts';

const LABELS = { index: 'SKILLS_HEADER', line: '- {name}: {description}' };

const skill = (name: string, description: string, missing: ActiveSkill['missing'] = []): ActiveSkill => ({
  name,
  description,
  tools: ['web.search'],
  versionId: `v-${name}`,
  source: '',
  missing,
});

test('names every tool that is not registered or not granted, with the reason, in the order of the skill', () => {
  const state = { granted: new Set(['web.search']), registered: new Set(['web.search', 'web.read', 'pings.set']) };
  assert.deepEqual(missingTools(['web.read', 'web.search', 'pings.set', 'ghost.tool'], state), [
    { tool: 'web.read', reason: 'not-granted' },
    { tool: 'pings.set', reason: 'not-granted' },
    { tool: 'ghost.tool', reason: 'not-registered' },
  ]);
});

test('a tool that is granted but not registered is not registered, and a skill with no tools misses nothing', () => {
  const state = { granted: new Set(['gone.tool']), registered: new Set<string>() };
  assert.deepEqual(missingTools(['gone.tool'], state), [{ tool: 'gone.tool', reason: 'not-registered' }]);
  assert.deepEqual(missingTools([], state), []);
});

test('the index holds the header and one line per usable skill, in the order given', () => {
  const body = skillIndexBlock(
    [skill('look-it-up', 'I check the web first'), skill('ping-someone', 'I ping on request')],
    LABELS
  );
  assert.equal(body, 'SKILLS_HEADER\n- look-it-up: I check the web first\n- ping-someone: I ping on request');
});

test('a skill with a missing tool is not in the index', () => {
  const body = skillIndexBlock(
    [
      skill('look-it-up', 'I check the web first', [{ tool: 'web.search', reason: 'not-granted' }]),
      skill('ping-someone', 'I ping on request'),
    ],
    LABELS
  );
  assert.equal(body.includes('look-it-up'), false);
  assert.equal(body.includes('ping-someone'), true);
});

test('no skill, or none usable, gives an empty body so the request carries no block', () => {
  assert.equal(skillIndexBlock([], LABELS), '');
  assert.equal(
    skillIndexBlock([skill('look-it-up', 'd', [{ tool: 'web.search', reason: 'not-registered' }])], LABELS),
    ''
  );
});
