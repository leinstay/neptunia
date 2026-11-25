// Tests for src/config/check.ts. `checkConfig` lists the keys of a local layer the schema does not know, at the first
// segment it does not know, and the keys whose value has none of the schema's types. A map's keys are free. The checks
// run over small schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig } from '../../../src/config/check.ts';
import type { SchemaEntry } from '../../../src/config/schema.ts';

const SCHEMA: ReadonlyArray<SchemaEntry> = [
  { key: 'llm.timeoutMs', types: ['number'], reader: 'src/a.js', default: 1000, text: 'the timeout' },
  { key: 'llm.provider', types: ['string', 'null'], reader: 'src/a.js', default: null, text: 'the provider' },
  { key: 'bot.access', types: ['map'], reader: 'src/a.js', default: {}, text: 'the grants' },
  { key: 'bot.owners', types: ['array'], reader: 'src/a.js', default: [], text: 'the owners' },
];

// ---- checkConfig ---------------------------------------------------------------------------------------------------

test('finds nothing in an empty local layer', () => {
  assert.deepEqual(checkConfig({}, SCHEMA), []);
});

test('finds nothing in a layer that sets known keys to values of their types', () => {
  const local = { llm: { timeoutMs: 5, provider: 'zeta' }, bot: { owners: ['1'] } };
  assert.deepEqual(checkConfig(local, SCHEMA), []);
});

test('reports a key the schema does not know inside a known section', () => {
  assert.deepEqual(checkConfig({ llm: { nosuch: 1 } }, SCHEMA), [{ key: 'llm.nosuch', kind: 'unknown' }]);
});

test('reports an unknown section once, at the section', () => {
  assert.deepEqual(checkConfig({ nosuch: { a: 1, b: { c: 2 } } }, SCHEMA), [{ key: 'nosuch', kind: 'unknown' }]);
});

test('reports a string where a number belongs', () => {
  assert.deepEqual(checkConfig({ llm: { timeoutMs: 'fast' } }, SCHEMA), [{ key: 'llm.timeoutMs', kind: 'type' }]);
});

test('reports an array where a number belongs', () => {
  assert.deepEqual(checkConfig({ llm: { timeoutMs: [1] } }, SCHEMA), [{ key: 'llm.timeoutMs', kind: 'type' }]);
});

test('reports null for a key whose types do not hold null', () => {
  assert.deepEqual(checkConfig({ llm: { timeoutMs: null } }, SCHEMA), [{ key: 'llm.timeoutMs', kind: 'type' }]);
});

test('reports a number where a section belongs', () => {
  assert.deepEqual(checkConfig({ llm: 5 }, SCHEMA), [{ key: 'llm', kind: 'type' }]);
});

test('takes any key inside a map, dots included', () => {
  const local = { bot: { access: { 'voice.say': { users: ['1'] }, 'web.search': { everyone: true } } } };
  assert.deepEqual(checkConfig(local, SCHEMA), []);
});
