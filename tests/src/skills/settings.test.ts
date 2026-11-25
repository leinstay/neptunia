// The limits of one `skill.run` (src/skills/settings.ts): read from `skills.run` at each call, and a missing value or
// one that is not a positive whole number takes the default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_RUN_DEFAULTS, skillRunSettings } from '../../../src/skills/settings.ts';

test('takes the limits of skills.run from the config', () => {
  assert.deepEqual(skillRunSettings({ skills: { run: { timeoutMs: 1500, maxOutputBytes: 2048 } } }), {
    timeoutMs: 1500,
    maxOutputBytes: 2048,
  });
});

test('takes the default for a limit that is missing or not a positive whole number', () => {
  for (const bad of [undefined, 0, -5, 2.5, '100', null]) {
    assert.deepEqual(
      skillRunSettings({ skills: { run: { timeoutMs: bad, maxOutputBytes: bad } } }),
      SKILL_RUN_DEFAULTS,
      String(bad)
    );
  }
});
