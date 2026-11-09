// Tests for src/config.ts: the .env parser, config reader and deepMerge helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge, readConfig, need, isPlainObject, resolveEnvRefs } from '../src/config.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { paceSettings } from '../src/behavior/turn.ts';
import { tempDir } from './fixtures/tmp.ts';

function tmpDir() {
  const root = tempDir('nep-');
  fs.mkdirSync(path.join(root, 'data', 'config'), { recursive: true });
  return root;
}

test('isPlainObject: true for objects, false for null, arrays, scalars and functions', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject('x'), false);
  assert.equal(isPlainObject(0), false);
  assert.equal(
    isPlainObject(() => {}),
    false
  );
});

test('deepMerge: arrays in override fully replace arrays in base', () => {
  const merged = deepMerge({ list: [1, 2, 3] }, { list: [9] });
  assert.deepEqual(merged.list, [9]);
});

test('deepMerge: nested objects merge key by key, recursively', () => {
  const base = { a: { x: 1, y: 2 }, b: 1 };
  const override = { a: { y: 20, z: 3 } };
  const merged = deepMerge(base, override);
  assert.deepEqual(merged, { a: { x: 1, y: 20, z: 3 }, b: 1 });
});

test('deepMerge: an explicit undefined in override keeps the base value', () => {
  const merged = deepMerge({ a: 1 }, { a: undefined });
  assert.equal(merged.a, 1);
});

test('deepMerge: scalar override replaces a nested object outright', () => {
  const merged = deepMerge({ a: { x: 1 } }, { a: 5 });
  assert.equal(merged.a, 5);
});

test('deepMerge: does not mutate the base object', () => {
  const base = { a: { x: 1 } };
  deepMerge(base, { a: { x: 2 } });
  assert.equal(base.a.x, 1);
});

test('readConfig: an empty persona config/config.json is treated as no override', () => {
  const dir = tmpDir();
  try {
    // PR 7c: the tracked settings live in config/config.json.
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ bot: { timezone: 'UTC' } }));
    fs.writeFileSync(path.join(dir, 'data', 'config', 'config.json'), '   \n  ');
    const cfg = readConfig(dir);
    assert.deepEqual(cfg, { bot: { timezone: 'UTC' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: persona config/config.json is deep-merged over config.json', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config', 'config.json'),
      JSON.stringify({ bot: { timezone: 'UTC', ownerPerson: '' }, llm: { model: 'a' } })
    );
    fs.writeFileSync(
      path.join(dir, 'data', 'config', 'config.json'),
      JSON.stringify({ bot: { ownerPerson: 'person:1' } })
    );
    const cfg = readConfig(dir);
    assert.deepEqual(cfg, { bot: { timezone: 'UTC', ownerPerson: 'person:1' }, llm: { model: 'a' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: invalid JSON in config.json throws', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), '{ not valid json');
    assert.throws(() => readConfig(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveEnvRefs: a string that is exactly ${env:NAME} becomes exactly the value', () => {
  const out = resolveEnvRefs({ proxy: '${env:NEP_PROXY}' }, { NEP_PROXY: 'http://user:pass@host:8080' });
  assert.deepEqual(out, { proxy: 'http://user:pass@host:8080' });
});

test('resolveEnvRefs: references embedded in a longer string are replaced in place', () => {
  const env = { NEP_USER: 'alice', NEP_PASS: 'p@ss' };
  const out = resolveEnvRefs({ url: 'http://${env:NEP_USER}:${env:NEP_PASS}@host/${env:NEP_USER}' }, env);
  // resolveEnvRefs hands back the shape it was given, but types it unknown.
  assert.equal((out as { url: string }).url, 'http://alice:p@ss@host/alice');
});

test('resolveEnvRefs: an unset name resolves to an empty string and is passed to onUnset at each occurrence', () => {
  const unset: Array<string> = [];
  const out = resolveEnvRefs(
    { a: 'x${env:NEP_NONE}y', b: '${env:NEP_NONE}', c: '${env:NEP_EMPTY}' },
    { NEP_EMPTY: '' },
    (name) => unset.push(name)
  );
  assert.deepEqual(out, { a: 'xy', b: '', c: '' });
  assert.deepEqual(unset, ['NEP_NONE', 'NEP_NONE'], 'set-but-empty is not reported');
});

test('resolveEnvRefs: strings without a reference and non-string values are untouched', () => {
  const env = { NEP_X: 'X' };
  const input = { n: 5, f: 0.5, t: true, z: null, s: 'plain ${NEP_X} $env:NEP_X ${env:1BAD} ${env:}', e: '' };
  assert.deepEqual(resolveEnvRefs(input, env), input);
});

test('resolveEnvRefs: walks nested objects and arrays, keys untouched, input not mutated', () => {
  const env = { NEP_A: 'a', NEP_B: 'b' };
  const input = { '${env:NEP_A}': { list: ['${env:NEP_A}', 1, ['${env:NEP_B}'], { deep: '-${env:NEP_B}-' }] } };
  const before = structuredClone(input);
  const out = resolveEnvRefs(input, env);
  assert.deepEqual(out, { '${env:NEP_A}': { list: ['a', 1, ['b'], { deep: '-b-' }] } });
  assert.deepEqual(input, before);
});

test('readConfig: env references resolve after the merge; an unset name warns once, without a value', async () => {
  const dir = tmpDir();
  process.env.NEP_TEST_PROXY_REF = 'http://user:secret@host:1';
  delete process.env.NEP_TEST_UNSET_REF;
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    // Stage Z: the reference sits under a key of its own, since the loader cuts media.video.proxy.
    fs.writeFileSync(
      path.join(dir, 'config', 'config.json'),
      JSON.stringify({ sample: { ref: '' }, other: '${env:NEP_TEST_UNSET_REF}' })
    );
    fs.writeFileSync(
      path.join(dir, 'data', 'config', 'config.json'),
      JSON.stringify({ sample: { ref: '${env:NEP_TEST_PROXY_REF}' } })
    );
    const { result: cfg, logs } = await withCapturedLogs(() => {
      const first = readConfig(dir);
      readConfig(dir);
      return first;
    });
    assert.deepEqual(cfg, { sample: { ref: 'http://user:secret@host:1' }, other: '' });
    const warnings = logs.filter((l) => l.msg === 'config: env ref unset');
    assert.deepEqual(
      warnings.map((l) => [l.level, l.name]),
      [['warn', 'NEP_TEST_UNSET_REF']]
    );
    assert.ok(!logs.some((l) => JSON.stringify(l).includes('secret')), 'no value is logged');
  } finally {
    delete process.env.NEP_TEST_PROXY_REF;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('need: throws an Error whose message is exactly the key when unset', () => {
  delete process.env.NEP_TEST_MISSING;
  assert.throws(
    () => need('NEP_TEST_MISSING'),
    (err) => err instanceof Error && err.message === 'NEP_TEST_MISSING'
  );
});

test('need: throws when the value is an empty string', () => {
  process.env.NEP_TEST_EMPTY = '';
  try {
    assert.throws(
      () => need('NEP_TEST_EMPTY'),
      (err: Error) => err.message === 'NEP_TEST_EMPTY'
    );
  } finally {
    delete process.env.NEP_TEST_EMPTY;
  }
});

test('config.json: the code fallbacks of the pace group are the shipped values', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shipped = JSON.parse(fs.readFileSync(path.join(root, 'config', 'config.json'), 'utf8'));
  assert.deepEqual(paceSettings({}), shipped.pace);
});
