// What keeps her from using an active skill (src/skills/index-block.ts#missingTools): each tool of the skill that is not
// registered or not granted, with the reason. Slice 8 of the turn frame removed the `<skills>` block and its tests: a
// usable skill is an entry of the tools array (tests/tools-json.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingTools } from '../src/skills/index-block.ts';

// Changed: the tool a skill names is `voice.say`, since `pings.set` is no tool of hers.
test('names every tool that is not registered or not granted, with the reason, in the order of the skill', () => {
  const state = { granted: new Set(['web.search']), registered: new Set(['web.search', 'web.read', 'voice.say']) };
  assert.deepEqual(missingTools(['web.read', 'web.search', 'voice.say', 'ghost.tool'], state), [
    { tool: 'web.read', reason: 'not-granted' },
    { tool: 'voice.say', reason: 'not-granted' },
    { tool: 'ghost.tool', reason: 'not-registered' },
  ]);
});

test('a tool that is granted but not registered is not registered, and a skill with no tools misses nothing', () => {
  const state = { granted: new Set(['gone.tool']), registered: new Set<string>() };
  assert.deepEqual(missingTools(['gone.tool'], state), [{ tool: 'gone.tool', reason: 'not-registered' }]);
  assert.deepEqual(missingTools([], state), []);
});
