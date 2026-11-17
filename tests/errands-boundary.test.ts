// The errand rename at the boundary of what the model and the journal say: a call under an old tool name is no call of
// hers and keeps the name as written, the same call under the new name is hers on both transports, and a journal that
// wrote the old names is read under the new ones. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentToolName, SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { buildSkills } from '../src/tools/registry.ts';
import { normalizeCalls } from '../src/tools/tool-calls.ts';
import '../src/tools/operations/index.ts';
import { toolCallsOf } from '../src/llm/openrouter.ts';

// ---- the call path never translates an old name ---------------------------------------------------------------------

const registry = buildSkills({ table: SKILL_DEFINITIONS });

test('the same call under the new name is a call of hers on both transports', () => {
  const [native] = normalizeCalls({
    calls: toolCallsOf([{ id: 'c1', function: { name: 'errand_add', arguments: '{"goal":"x"}' } }]),
    registry,
    step: 1,
  });
  assert.deepEqual([native?.problem, native?.name], [null, 'errand.add']);
  const [text] = normalizeCalls({
    calls: [{ id: null, name: 'errand.add', arguments: '{}', parsed: { goal: 'x' }, parseError: null }],
    transport: 'text',
    registry,
    step: 1,
  });
  assert.deepEqual([text?.problem, text?.name], [null, 'errand.add']);
});

test('a journal that wrote the old names is read under the new ones, and any other name comes back as it is', () => {
  // `task.status` and `task.cancel` stay out of this list: a stored row of either name may come from an older board tool.
  assert.deepEqual(['task.run', 'task.read', 'task.resolve', 'task.list'].map(currentToolName), [
    'errand.add',
    'errand.read',
    'errand.resolve',
    'errand.list',
  ]);
  assert.deepEqual(['intent.set', 'intent.update', 'intent.cancel', 'intent.list'].map(currentToolName), [
    'intention.set',
    'intention.update',
    'intention.cancel',
    'intention.list',
  ]);
  // Changed: `skills.describe` maps to nothing, since `tools.describe` is an operation of the console and no tool of hers.
  assert.equal(currentToolName('skills.describe'), 'skills.describe');
  // The merged reads: a journal that wrote the old name is read under the tool that took it over.
  assert.equal(currentToolName('errand.status'), 'errand.list');
  // Both old names of the errand tool read as `errand.add` in one hop, the older one included.
  assert.deepEqual(['task.run', 'errand.run'].map(currentToolName), ['errand.add', 'errand.add']);
  assert.equal(currentToolName('memory.affinity.read'), 'memory.profile.read');
  assert.equal(currentToolName('message.create'), 'message.create');
  assert.equal(currentToolName(null), null);
});
