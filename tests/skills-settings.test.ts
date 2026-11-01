// The `skills` section of the settings (src/skills/settings.ts): `reviewDays`, the days a skill may go unread before
// `/skills` marks it for review. A missing or bad value takes the default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS_DEFAULTS, skillsSettings } from '../src/skills/settings.ts';

test('takes reviewDays from the config', () => {
  assert.equal(skillsSettings({ skills: { reviewDays: 12 } }).reviewDays, 12);
});

test('takes the default when the key is missing', () => {
  assert.equal(skillsSettings({}).reviewDays, SKILLS_DEFAULTS.reviewDays);
  assert.equal(skillsSettings(null).reviewDays, SKILLS_DEFAULTS.reviewDays);
});

test('takes the default for a value that is not a positive whole number', () => {
  for (const bad of [0, -3, 2.5, '7', null, Number.NaN]) {
    assert.equal(skillsSettings({ skills: { reviewDays: bad } }).reviewDays, SKILLS_DEFAULTS.reviewDays, String(bad));
  }
});
