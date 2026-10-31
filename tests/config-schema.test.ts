// The settings schema of PR 7c (src/config/schema.ts): one entry per key with its JSON types, its reader (the module
// that reads it), its default and one line of text. A map (a section whose keys are free, such as `bot.access` or
// `models.abilities`, keyed by tool or model ids that hold dots) is one entry of type `map`. `schemaDefaults` builds the
// settings object the defaults give, which is `config/config.json` exactly. The tests read the schema and the tracked
// file, never a local layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_SCHEMA, schemaDefaults } from '../src/config/schema.ts';
import type { SchemaEntry } from '../src/config/schema.ts';
import { ROOT } from './fixtures/private-layer.ts';

/** The number of config keys Hermes has (hermes_cli/config_defaults.py), the bound plan section 4.5 sets. */
const HERMES_KEYS = 1010;

test('builds the nested settings from the defaults, a map entry holding its whole object', () => {
  const schema: ReadonlyArray<SchemaEntry> = [
    { key: 'a.b', types: ['number'], reader: 'src/a.js', default: 1, text: 'one' },
    { key: 'a.m', types: ['map'], reader: 'src/a.js', default: { 'x.y': [1] }, text: 'a map' },
    { key: 'c', types: ['string', 'null'], reader: 'src/c.js', default: null, text: 'c' },
  ];
  assert.deepEqual(schemaDefaults(schema), { a: { b: 1, m: { 'x.y': [1] } }, c: null });
});

test('builds an empty object from an empty schema', () => {
  assert.deepEqual(schemaDefaults([]), {});
});

test('the defaults of the schema are config/config.json, key for key and value for value', () => {
  const tracked: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  assert.deepEqual(schemaDefaults(CONFIG_SCHEMA), tracked);
});

test('names no key twice', () => {
  const seen = new Set<string>();
  const twice = CONFIG_SCHEMA.map((entry) => entry.key).filter((key) => seen.size === seen.add(key).size);
  assert.deepEqual(twice, []);
});

test('holds fewer keys than Hermes has', () => {
  assert.ok(CONFIG_SCHEMA.length < HERMES_KEYS, `${CONFIG_SCHEMA.length} keys`);
});

// The generated document prints this line for each key: an empty or a two-line text breaks its table row.
test('gives every key one line of text', () => {
  const bad = CONFIG_SCHEMA.filter((entry) => entry.text.trim() === '' || entry.text.includes('\n')).map(
    (entry) => entry.key
  );
  assert.deepEqual(bad, []);
});

test('gives every key a type its default has', () => {
  const typeOf = (value: unknown): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'map';
    return typeof value;
  };
  const bad = CONFIG_SCHEMA.filter((entry) => !entry.types.some((one) => one === typeOf(entry.default))).map(
    (entry) => entry.key
  );
  assert.deepEqual(bad, []);
});
