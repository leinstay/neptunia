// The settings schema of PR 7c (src/config/schema.ts): one entry per key with its JSON types, its reader (the module
// that reads it), its default and one line of text. A map (a section whose keys are free, such as `bot.access` or
// `models.abilities`, keyed by tool or model ids that hold dots) is one entry of type `map`. `schemaDefaults` builds the
// settings object the defaults give, which is `config/config.json` exactly. The tests read the schema and the tracked
// file, never a local layer.
// PR 7d cuts the settings (tests/fixtures/config-cut.ts): each group leaves the schema and the tracked file whole, and a
// local layer shaped like production's still derives the settings it derived before the cut
// (tests/fixtures/config-cut-before.json, written from the readers of the commit before the cut over the same layer).
// A declared field may change or go: a daily cap of plan section 4.5 and a switch that became code. The schema ends
// under 300 keys with every kept key in it, the daily caps leave it while the request rail stays, and the Discord keys
// live in the Discord package's own settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_SCHEMA, schemaDefaults } from '../src/config/schema.ts';
import type { SchemaEntry } from '../src/config/schema.ts';
import { ROOT } from './fixtures/private-layer.ts';

import { DailyCapError, countLlmRequest } from '../src/llm/openrouter.ts';

import { CUT } from './fixtures/config-cut.ts';

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

// ---- the cut of PR 7d ----------------------------------------------------------------------------------------------

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at a dotted path of `tree`, undefined when a segment is missing. */
function at(tree: unknown, dotted: string): unknown {
  let node: unknown = tree;
  for (const segment of dotted.split('.')) {
    if (!isTree(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

const tracked = (): unknown => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
const schemaKeys = (): Set<string> => new Set(CONFIG_SCHEMA.map((entry) => entry.key));

test('keeps the two privacy switches under private and one budget entry per field for every wake kind', () => {
  const keys = schemaKeys();
  const added = CUT.filter((row) => row.becomes === 'rename' || row.becomes === 'wildcard').map((row) => row.to ?? '');
  assert.deepEqual(
    [...new Set(added)].filter((key) => !keys.has(key)),
    [],
    'a renamed or wildcard key is missing'
  );
  const file = tracked();
  assert.equal(at(file, 'dm.enabled'), false, 'private chat stays off in the tracked defaults');
  assert.equal(at(file, 'private.likeServer'), true);
});

test('drops the daily caps of plan section 4.5 and keeps the one request rail, which refuses the 5,001st request', () => {
  const caps = CUT.filter((row) => row.becomes === 'cap').map((row) => row.key);
  const keys = schemaKeys();
  assert.deepEqual(
    caps.filter((key) => keys.has(key)),
    [],
    'a daily cap is still a key'
  );
  const file = tracked();
  assert.equal(at(file, 'llm.maxRequestsPerDay'), 5000);
  // The per-request rail stays on; its tracked value is a default and is not pinned here.
  assert.ok(Number(at(file, 'llm.maxRequestTokens')) > 0);
  const state = { data: {}, markDirty() {} };
  const day = Date.parse('2026-10-31T12:00:00Z');
  for (let n = 0; n < 5000; n += 1) countLlmRequest(state, 5000, day);
  assert.throws(() => countLlmRequest(state, 5000, day), DailyCapError);
});
