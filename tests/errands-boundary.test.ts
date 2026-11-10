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
    calls: toolCallsOf([{ id: 'c1', function: { name: 'errand_run', arguments: '{"agent":"scout","goal":"x"}' } }]),
    registry,
    step: 1,
  });
  assert.deepEqual([native?.problem, native?.name], [null, 'errand.run']);
  const [text] = normalizeCalls({
    calls: [{ id: null, name: 'errand.run', arguments: '{}', parsed: { agent: 'scout', goal: 'x' }, parseError: null }],
    transport: 'text',
    registry,
    step: 1,
  });
  assert.deepEqual([text?.problem, text?.name], [null, 'errand.run']);
});

test('a journal that wrote the old names is read under the new ones, and any other name comes back as it is', () => {
  assert.deepEqual(
    ['task.run', 'task.status', 'task.read', 'task.resolve', 'task.cancel', 'task.list'].map(currentToolName),
    ['errand.run', 'errand.list', 'errand.read', 'errand.resolve', 'errand.cancel', 'errand.list']
  );
  assert.deepEqual(['intent.set', 'intent.update', 'intent.cancel', 'intent.list'].map(currentToolName), [
    'intention.set',
    'intention.update',
    'intention.cancel',
    'intention.list',
  ]);
  assert.equal(currentToolName('skills.describe'), 'tools.describe');
  // The merged reads: a journal that wrote the old name is read under the tool that took it over.
  assert.equal(currentToolName('errand.status'), 'errand.list');
  assert.equal(currentToolName('memory.affinity.read'), 'memory.profile.read');
  assert.equal(currentToolName('message.create'), 'message.create');
  assert.equal(currentToolName(null), null);
});
