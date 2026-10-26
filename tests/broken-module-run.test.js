import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findBreakEdits, breakSource, parseTap, sortSummary, reachedModules } from '../tools/broken-module-run.mjs';

const THROW = "{ throw new Error('broken-module-run'); }";

test('breakSource: replaces the body of an exported function declaration', () => {
  const source = 'export function add(a, b) {\n  return a + b;\n}\n';
  const result = breakSource(source);
  assert.equal(result.source, `export function add(a, b) ${THROW}\n`);
  assert.deepEqual(result.broken, ['add']);
});

test('breakSource: replaces an async function and keeps its parameters', () => {
  const result = breakSource('export async function load(id = 1) { return await fetch(id); }');
  assert.equal(result.source, `export async function load(id = 1) ${THROW}`);
});

test('breakSource: turns the expression body of an exported arrow const into a throwing block', () => {
  const result = breakSource('export const double = (n) => n * 2;\nexport const PI = 3.14;\n');
  assert.equal(result.source, `export const double = (n) => ${THROW};\nexport const PI = 3.14;\n`);
  assert.deepEqual(result.broken, ['double']);
});

test('breakSource: breaks the methods and function properties of an exported object literal', () => {
  const source = 'export const api = { get(a) { return a; }, put: (a) => a, name: "x" };';
  const result = breakSource(source);
  assert.equal(result.source, `export const api = { get(a) ${THROW}, put: (a) => ${THROW}, name: "x" };`);
  assert.deepEqual(result.broken, ['api.get', 'api.put']);
});

test('breakSource: breaks a local function that an export list names', () => {
  const result = breakSource(
    'function inner() { return 1; }\nfunction other() { return 2; }\nexport { inner as outer };\n'
  );
  assert.equal(
    result.source,
    `function inner() ${THROW}\nfunction other() { return 2; }\nexport { inner as outer };\n`
  );
  assert.deepEqual(result.broken, ['outer']);
});

test('breakSource: leaves a function that is not exported alone', () => {
  const result = breakSource('function hidden() { return 1; }\nexport const run = () => hidden();\n');
  assert.equal(result.source, `function hidden() { return 1; }\nexport const run = () => ${THROW};\n`);
});

test('breakSource: a module with no function export is not broken and says why', () => {
  const result = breakSource('export const A = 1;\nexport const B = { c: 2 };\n');
  assert.equal(result.source, null);
  assert.match(result.reason ?? '', /no exported function/);
});

test('breakSource: an empty source is not broken', () => {
  const result = breakSource('');
  assert.equal(result.source, null);
  assert.deepEqual(result.broken, []);
});

test('findBreakEdits: ranges point at the bodies, not at the signatures', () => {
  const source = 'export function f(x) { return x; }';
  const [edit] = findBreakEdits(source);
  assert.equal(source.slice(edit.start, edit.end), '{ return x; }');
});

test('parseTap: reads passing and failing tests with their names', () => {
  const tap = ['TAP version 13', 'ok 1 - first', 'not ok 2 - second', '  ---', '  error: boom', '  ...', '1..2'].join(
    '\n'
  );
  assert.deepEqual(parseTap(tap), [
    { name: 'first', status: 'passed' },
    { name: 'second', status: 'failed' },
  ]);
});

test('parseTap: a nested subtest is named by its path and the parent suite is not counted', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: suite',
    '    # Subtest: inner a',
    '    ok 1 - inner a',
    '      ---',
    '      duration_ms: 0.5',
    '      ...',
    '    # Subtest: inner b',
    '    not ok 2 - inner b',
    '    1..2',
    'not ok 1 - suite',
    '1..1',
  ].join('\n');
  assert.deepEqual(parseTap(tap), [
    { name: 'suite > inner a', status: 'passed' },
    { name: 'suite > inner b', status: 'failed' },
  ]);
});

test('parseTap: a skip and a todo directive are not counted as passed', () => {
  const tap = ['ok 1 - later # TODO not yet', 'ok 2 - never # SKIP', 'ok 3 - plain'].join('\n');
  assert.deepEqual(parseTap(tap), [
    { name: 'later', status: 'todo' },
    { name: 'never', status: 'skipped' },
    { name: 'plain', status: 'passed' },
  ]);
});

test('parseTap: empty output has no tests', () => {
  assert.deepEqual(parseTap(''), []);
});

test('sortSummary: orders ran modules by the share of green tests, then the ones that did not run', () => {
  const entries = [
    { module: 'src/c.js', status: 'skipped: no exported function', tests: 0, green: [] },
    { module: 'src/a.js', status: 'ran', tests: 4, green: ['x'] },
    { module: 'src/b.js', status: 'ran', tests: 2, green: ['x', 'y'] },
    { module: 'src/d.js', status: 'ran', tests: 4, green: ['x', 'y'] },
  ];
  assert.deepEqual(
    sortSummary(entries).map((e) => e.module),
    ['src/b.js', 'src/d.js', 'src/a.js', 'src/c.js']
  );
});

test('sortSummary: a module with no tests does not divide by zero', () => {
  const entries = [{ module: 'src/a.js', status: 'ran', tests: 0, green: [] }];
  assert.equal(sortSummary(entries).length, 1);
});

/** @param {Record<string, string>} files */
const reader = (files) => (/** @type {string} */ p) => files[p];

test('reachedModules: collects the src and interfaces modules a test imports directly', () => {
  const read = reader({
    'tests/a.test.js': [
      "import { x } from '../src/time.js';",
      "import { y } from '../interfaces/discord/send.js';",
      "export { z } from '../src/memory/clamp.js';",
      "const m = await import('../src/log.js');",
    ].join('\n'),
  });
  assert.deepEqual(reachedModules('tests/a.test.js', read), [
    'interfaces/discord/send.js',
    'src/log.js',
    'src/memory/clamp.js',
    'src/time.js',
  ]);
});

test('reachedModules: ignores node built-ins and bare package imports', () => {
  const read = reader({
    'tests/a.test.js':
      "import fs from 'node:fs';\nimport assert from 'node:assert/strict';\nimport ts from 'typescript';\nimport { x } from '../src/time.js';",
  });
  assert.deepEqual(reachedModules('tests/a.test.js', read), ['src/time.js']);
});

test('reachedModules: does not follow a dynamic import built from a template string', () => {
  const read = reader({ 'tests/a.test.js': 'const name = "time";\nawait import(`../src/${name}.js`);' });
  assert.deepEqual(reachedModules('tests/a.test.js', read), []);
});

test('reachedModules: follows a fixture one level and counts its src imports for the test file', () => {
  const read = reader({
    'tests/a.test.js': "import { fake } from './fixtures/harness.js';\nimport { x } from '../src/time.js';",
    'tests/fixtures/harness.js': "import { y } from '../../src/log.js';\nimport { z } from './deeper.js';",
    'tests/fixtures/deeper.js': "import { w } from '../../src/config.js';",
  });
  assert.deepEqual(reachedModules('tests/a.test.js', read), ['src/log.js', 'src/time.js']);
});

test('reachedModules: a missing file or an empty test reaches nothing', () => {
  assert.deepEqual(reachedModules('tests/none.test.js', reader({})), []);
  assert.deepEqual(reachedModules('tests/a.test.js', reader({ 'tests/a.test.js': '' })), []);
});

const PACKAGES = [
  { name: '@neptunia/interface-discord', dir: 'interfaces/discord', exports: './index.js' },
  {
    name: '@neptunia/other',
    dir: 'interfaces/other',
    exports: { '.': { import: './main.js' }, './send': './lib/send.js' },
  },
  { name: '@neptunia/plain', dir: 'interfaces/plain', main: 'entry.js' },
];

test('reachedModules: resolves a workspace package import to its entry through exports', () => {
  const read = reader({ 'tests/a.test.js': "import { x } from '@neptunia/interface-discord';" });
  assert.deepEqual(reachedModules('tests/a.test.js', read, PACKAGES), ['interfaces/discord/index.js']);
});

test('reachedModules: resolves a subpath through the exports map and the main field', () => {
  const read = reader({
    'tests/a.test.js':
      "import a from '@neptunia/other';\nimport b from '@neptunia/other/send';\nimport c from '@neptunia/plain';",
  });
  assert.deepEqual(reachedModules('tests/a.test.js', read, PACKAGES), [
    'interfaces/other/lib/send.js',
    'interfaces/other/main.js',
    'interfaces/plain/entry.js',
  ]);
});

test('reachedModules: follows a workspace import made by a fixture and ignores other scoped packages', () => {
  const read = reader({
    'tests/a.test.js': "import { f } from './fixtures/h.js';\nimport z from '@other/pkg';",
    'tests/fixtures/h.js': "const m = await import('@neptunia/interface-discord');",
  });
  assert.deepEqual(reachedModules('tests/a.test.js', read, PACKAGES), ['interfaces/discord/index.js']);
});

test('reachedModules: a src shim that re-exports the package reaches the whole package graph', () => {
  const read = reader({
    'tests/a.test.js': "import { send } from '../src/interface/discord.js';",
    'src/interface/discord.js': "export * from '@neptunia/interface-discord';",
    'interfaces/discord/index.js': "export * from './send.js';\nimport fs from 'node:fs';",
    'interfaces/discord/send.js': "import { x } from './util.js';\nimport { y } from '../../src/time.js';",
    'interfaces/discord/util.js': '',
  });
  assert.deepEqual(reachedModules('tests/a.test.js', read, PACKAGES), [
    'interfaces/discord/index.js',
    'interfaces/discord/send.js',
    'interfaces/discord/util.js',
    'src/interface/discord.js',
  ]);
});
