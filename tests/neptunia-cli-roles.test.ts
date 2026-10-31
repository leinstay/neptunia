// Tests for the failing model roles on `/status` (src/interface/neptunia-cli.ts#statusFactsOf and #statusText): the
// summary lists each globally failing role with its reason, as src/llm/role-health.ts reports it. No model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusFactsOf, statusText } from '../src/interface/neptunia-cli.ts';
import type { FactSources } from '../src/interface/neptunia-cli.ts';
import { createRoleHealth } from '../src/llm/role-health.ts';

const NOW = Date.parse('2026-10-31T09:00:00Z');
const CONFIG = { models: { base: { core: 'x/core', drawing: 'x/draw' } } };

function sources(health: ReturnType<typeof createRoleHealth>): FactSources {
  return {
    version: '0.0.0',
    config: () => CONFIG,
    state: () => ({}),
    usageRows: () => [],
    interfaces: () => [],
    inner: () => null,
    errands: () => [],
    guildId: () => null,
    failingRoles: () => health.failing(CONFIG),
  };
}

test('/status names a globally failing role with its reason, and no role when none fails', () => {
  const health = createRoleHealth({ now: () => NOW, hasKey: () => true });
  const healthy = statusFactsOf(sources(health));
  assert.deepEqual(healthy.failingRoles, []);
  assert.ok(!statusText(healthy).includes('drawing'), 'no failing role, no line about it');

  health.failed('drawing', Object.assign(new Error('OpenRouter images HTTP 401'), { statusCode: 401, body: '' }));
  const facts = statusFactsOf(sources(health));
  assert.deepEqual(
    facts.failingRoles.map((row) => [row.role, row.reason]),
    [['drawing', 'unauthorized']]
  );
  const line = statusText(facts)
    .split('\n')
    .find((text) => text.includes('drawing'));
  assert.ok(line?.includes('unauthorized'), 'the role and its reason on one line');
});
