// The default key-name map of `llm.keyByRole` (src/config/schema/llm.ts, config/config.json): the errand roles bind
// to no environment variable. A scout, server or drawing key comes from keys.json or from the task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LLM } from '../src/config/schema/llm.ts';

const ROOT = path.join(import.meta.dirname, '..');
const namesOf = (map: unknown): Array<string> =>
  Object.values(map as Record<string, string | Array<string>>).flatMap((value) => [value].flat());

test('the schema default of llm.keyByRole names no OPENROUTER_ERRAND_KEY', () => {
  // Bug: the errand variable stays the documented default, so a deployment keeps a key in .env for the runners.
  const entry = LLM.find((one) => one.key === 'llm.keyByRole');
  assert.ok(entry, 'the schema has llm.keyByRole');
  assert.ok(!namesOf(entry.default).includes('OPENROUTER_ERRAND_KEY'));
});

test('config/config.json llm.keyByRole names no OPENROUTER_ERRAND_KEY', () => {
  // Bug: the tracked settings and the schema disagree on the default map.
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')) as {
    llm: { keyByRole: unknown };
  };
  assert.ok(!namesOf(config.llm.keyByRole).includes('OPENROUTER_ERRAND_KEY'));
});

test('the development and memory roles keep their variables', () => {
  // Bug: the errand name is removed together with its neighbours.
  const entry = LLM.find((one) => one.key === 'llm.keyByRole');
  const map = entry?.default as Record<string, string>;
  assert.equal(map.thinker, 'OPENROUTER_DEV_KEY');
  assert.equal(map.memory, 'OPENROUTER_MEMORY_KEY');
});
