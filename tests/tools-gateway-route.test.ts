// Tests for src/tools/gateway.ts#abilityRoute, the route decision of a model role's call: its own model, the core
// model when the role is down and the core declares the role's ability (`models.abilities.<model id>`), or nothing.
// Only the roles that run as her tools fall back (vision, video, drawing, speech). The analyzer and the embedding
// role always go to their own model, whatever their state and whatever the core can do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abilityRoute } from '../src/tools/gateway.ts';
import { createRoleHealth } from '../src/llm/role-health.ts';

const NOW = Date.parse('2026-10-31T09:00:00Z');

function httpError(status: number): Error {
  return Object.assign(new Error(`OpenRouter HTTP ${status}`), { statusCode: status, body: '' });
}

test('the analyzer and the embedding role never fall back to the core, even when both are down and the core could', () => {
  const health = createRoleHealth({ now: () => NOW, hasKey: () => true });
  for (const role of ['analyzer', 'embedding', 'vision']) health.failed(role, httpError(401));
  const config = {
    models: {
      base: { core: 'x/core', analyzer: 'x/analyzer', embedding: 'x/embed', vision: 'x/eyes' },
      abilities: { 'x/core': ['text', 'embeddings', 'imagesIn'] },
    },
  };
  assert.deepEqual(abilityRoute({ config, role: 'analyzer', health }), {
    kind: 'role',
    role: 'analyzer',
    model: 'x/analyzer',
  });
  assert.deepEqual(abilityRoute({ config, role: 'embedding', health }), {
    kind: 'role',
    role: 'embedding',
    model: 'x/embed',
  });
  // The same core and the same failure do move a tool role: the two above are refused a fallback by their role.
  assert.deepEqual(abilityRoute({ config, role: 'vision', health }), {
    kind: 'core',
    role: 'vision',
    ability: 'imagesIn',
    model: 'x/core',
    reason: 'unauthorized',
  });
});
