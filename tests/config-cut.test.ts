// The cut of a local layer written before PR 7d (src/config/cut.ts): `cutConfigKeys` drops every key the cut took out of
// the settings, reports each live value that differs from the constant replacing it, writes the two privacy switches
// under `private`, hands the Discord keys to the Discord package and keeps the per-wake budgets. The loader
// (src/config.ts#readConfig) applies it to the local file, and tools/config-migrate.mjs writes it into the file. The
// layers are synthetic; no test reads a real local layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutConfigKeys } from '../src/config/cut.ts';
import { CUT, PRODUCTION_LAYER } from './fixtures/config-cut.ts';

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

test('drops every cut key a production-shaped layer sets and finds no live value apart from its constant', () => {
  const { config, cut, differs } = cutConfigKeys(PRODUCTION_LAYER);
  const left = CUT.filter((row) => row.becomes !== 'wildcard' && at(config, row.key) !== undefined).map(
    (row) => row.key
  );
  assert.deepEqual(left, [], 'no cut key is left in the layer');
  assert.deepEqual(
    [...cut].sort(),
    CUT.filter((row) => ['constant', 'code', 'gone', 'cap'].includes(row.becomes))
      .filter((row) => at(PRODUCTION_LAYER, row.key) !== undefined)
      .map((row) => row.key)
      .sort()
  );
  assert.deepEqual(differs, []);
  assert.equal(at(config, 'recall.timeoutMs'), 25000, 'a kept key stays as the layer set it');
});

test('reports a live value that differs from the constant replacing it', () => {
  const { config, differs } = cutConfigKeys({ capture: { before: 5, after: 3 } });
  assert.deepEqual(differs, [{ key: 'capture.before', live: 5, constant: 3 }]);
  assert.deepEqual(config, {});
});

test('reports a switch on in a layer whose code went with the switch off in production', () => {
  const { differs } = cutConfigKeys({ features: { spontaneous: true } });
  assert.deepEqual(differs, [{ key: 'features.spontaneous', live: true, constant: false }]);
});

test('drops a daily cap without reporting it as a difference', () => {
  const { config, cut, differs } = cutConfigKeys({ image: { maxPerDay: 3, timeoutMs: 9000 } });
  assert.deepEqual([config, cut, differs], [{ image: { timeoutMs: 9000 } }, ['image.maxPerDay'], []]);
});

test('writes the two privacy switches under private, a false one included', () => {
  const { config, renamed } = cutConfigKeys({ features: { privateMessages: false, privateLikeServer: false } });
  assert.deepEqual(config, { private: { enabled: false, likeServer: false } });
  assert.deepEqual(renamed, [
    { from: 'features.privateMessages', to: 'private.enabled' },
    { from: 'features.privateLikeServer', to: 'private.likeServer' },
  ]);
});

test('hands the Discord keys to the Discord package and keeps their values', () => {
  const { config, interfaces } = cutConfigKeys({
    discord: { intents: { presences: true, members: true } },
    context: { maxUrlChars: 0, channelMessages: 60 },
  });
  assert.deepEqual(config, { context: { channelMessages: 60 } });
  assert.deepEqual(interfaces, {
    discord: { discord: { intents: { presences: true, members: true } }, context: { maxUrlChars: 0 } },
  });
});

test('keeps the per-wake budgets a layer sets', () => {
  const given = { innerLife: { wakes: { heartbeat: { maxActs: 2 }, attend: { tools: ['web.search'] } } } };
  assert.deepEqual(cutConfigKeys(given).config, given);
});

test('cuts nothing from a layer it already cut, and leaves an empty layer empty', () => {
  const first = cutConfigKeys(PRODUCTION_LAYER);
  const second = cutConfigKeys(first.config);
  assert.deepEqual(second, { config: first.config, cut: [], differs: [], renamed: [], interfaces: {} });
  assert.deepEqual(cutConfigKeys({}), { config: {}, cut: [], differs: [], renamed: [], interfaces: {} });
});

test('does not change the layer it is given', () => {
  const copy = structuredClone(PRODUCTION_LAYER);
  cutConfigKeys(PRODUCTION_LAYER);
  assert.deepEqual(PRODUCTION_LAYER, copy);
});
