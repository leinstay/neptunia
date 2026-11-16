// The table's lines of `model set` (src/interface/commands/table.ts).
// Changed: a model role is set as one route of its chain (spec 2026-11-09-model-routes, slice 4), whose text names its
// effort, and `/routes set` pins its providers, so the tests of `--provider`, `--effort` and the model dialog of the
// direct `model set` are deleted with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine } from '../src/interface/commands/table.ts';

// the table

test('the table parses model set with a provider and an effort', () => {
  // Catches: the flags refused as unknown, so neither setting can be given from the chat.
  const parsed = parseCommandLine('/model set analyzer openai/gpt-6.1-sol --provider openai --effort high');
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.args, {
      role: 'analyzer',
      model: 'openai/gpt-6.1-sol',
      provider: 'openai',
      effort: 'high',
    });
});

test('the table parses model set for the memory role', () => {
  // Catches: "memory" refused as no model role, so the memory writer's model and key path cannot be set.
  const parsed = parseCommandLine('/model set memory anthropic/claude-opus-4.6');
  assert.equal(parsed.ok, true);
});
