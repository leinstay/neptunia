// The native thinking switch of the harness runs of the model roles (src/subharness/thinking.ts): the setting it reads
// and the variable it gives each backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNativeThinking, nativeThinkingEnv } from '../src/subharness/thinking.ts';

test('keeps native thinking only when llm.subscription.thinking is the boolean true', () => {
  // Catches: the switch read from another path, or a missing section or a stored string turning thinking on.
  assert.equal(isNativeThinking({ llm: { subscription: { thinking: true } } }), true);
  assert.equal(isNativeThinking({ llm: { subscription: { thinking: 'true' } } }), false);
  assert.equal(isNativeThinking({ llm: {} }), false);
});

test('gives codex no claude variable while thinking is off', () => {
  // Catches: MAX_THINKING_TOKENS handed to codex, which reads no such variable, in place of its reasoning summary pair.
  assert.deepEqual(nativeThinkingEnv('codex', false), {});
  assert.deepEqual(nativeThinkingEnv('claude', false), { MAX_THINKING_TOKENS: '0' });
});
