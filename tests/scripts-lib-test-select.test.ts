import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectTestFiles } from '../scripts/lib/test-select.ts';

const existing = [
  'tests/time.test.js',
  'tests/discord-gateway.test.js',
  'tests/memory-db.test.js',
  'tests/mutation-diff.test.js',
  'tests/other.test.js',
];

test('selectTestFiles: picks the test named after the file', () => {
  assert.deepEqual(selectTestFiles(['src/time.ts'], [], existing), ['tests/time.test.js']);
});

test('selectTestFiles: matches a tail of the folder path joined by hyphens', () => {
  assert.deepEqual(selectTestFiles(['interfaces/discord/gateway.ts'], [], existing), ['tests/discord-gateway.test.js']);
  assert.deepEqual(selectTestFiles(['src/memory/db.js'], [], existing), ['tests/memory-db.test.js']);
});

test('selectTestFiles: a source file without a test selects nothing', () => {
  assert.deepEqual(selectTestFiles(['src/orphan.js'], [], existing), []);
});

test('selectTestFiles: adds a changed test file and lists each test once', () => {
  const picked = selectTestFiles(['src/time.ts'], ['tests/time.test.js', 'tests/other.test.js', 'docs/x.md'], existing);
  assert.deepEqual(picked, ['tests/other.test.js', 'tests/time.test.js']);
});

test('selectTestFiles: a changed test file is kept even when no source changed', () => {
  assert.deepEqual(selectTestFiles([], ['tests/other.test.js'], existing), ['tests/other.test.js']);
});

// The selection by imports. `selectTestFiles` and `filesWithoutTest` take the source of a test file as a last
// argument, `read(path)`, which returns the text of a repository path or undefined. Without it only the naming rule
// applies, so the tests above keep their three-argument calls.
const protocolTests = ['tests/protocol.test.js', 'tests/protocol-events.test.ts', 'tests/time.test.js'];
const reader = (files: Record<string, string>) => (file: string) => files[file];

test('selectTestFiles: picks a test of another name that imports the module', () => {
  const read = reader({
    'tests/protocol.test.js': "import { validate } from '../src/protocol/validate.ts';\n",
    'tests/protocol-events.test.ts': "import { validate } from '../src/protocol/validate.ts';\n",
    'tests/time.test.js': "import { parse } from '../src/time.ts';\n",
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.ts'], [], protocolTests, read), [
    'tests/protocol-events.test.ts',
    'tests/protocol.test.js',
  ]);
});

test('selectTestFiles: follows an export from and a literal dynamic import', () => {
  const read = reader({
    'tests/protocol.test.js': "export { validate } from '../src/protocol/validate.ts';\n",
    'tests/protocol-events.test.ts': "const m = await import('../src/protocol/validate.ts');\n",
    'tests/time.test.js': '',
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.ts'], [], protocolTests, read), [
    'tests/protocol-events.test.ts',
    'tests/protocol.test.js',
  ]);
});

test('selectTestFiles: does not pick a test that imports other modules only', () => {
  const read = reader({
    'tests/protocol.test.js': "import { send } from '../src/protocol/send.js';\n",
    'tests/protocol-events.test.ts': "import { validate } from '../src/protocol/validate.ts';\n",
    'tests/time.test.js': "import { parse } from '../src/time.ts';\n",
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.ts'], [], protocolTests, read), [
    'tests/protocol-events.test.ts',
  ]);
});

test('selectTestFiles: a module neither named nor imported selects nothing', () => {
  const read = reader({
    'tests/protocol.test.js': "import { send } from '../src/protocol/send.js';\n",
    'tests/protocol-events.test.ts': '',
    'tests/time.test.js': "import { parse } from '../src/time.ts';\n",
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.ts'], [], protocolTests, read), []);
});

test('selectTestFiles: does not follow a test that imports the module through a fixture', () => {
  const read = reader({
    'tests/protocol.test.js': "import { makeValidator } from './helpers/validator.js';\n",
    'tests/helpers/validator.js': "import { validate } from '../../src/protocol/validate.js';\n",
    'tests/protocol-events.test.ts': '',
    'tests/time.test.js': '',
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.ts'], [], protocolTests, read), []);
});

test('selectTestFiles: keeps the named test next to the importing ones', () => {
  const tests = ['tests/protocol-validate.test.js', 'tests/protocol.test.js', 'tests/time.test.js'];
  const read = reader({
    'tests/protocol-validate.test.js': "import { other } from '../src/other.js';\n",
    'tests/protocol.test.js': "import { validate } from '../src/protocol/validate.ts';\n",
    'tests/time.test.js': '',
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.ts'], [], tests, read), [
    'tests/protocol-validate.test.js',
    'tests/protocol.test.js',
  ]);
});

test('selectTestFiles: lists a test once when the name and an import both pick it', () => {
  const read = reader({ 'tests/time.test.js': "import { parse } from '../src/time.ts';\n" });
  assert.deepEqual(selectTestFiles(['src/time.ts'], [], ['tests/time.test.js'], read), ['tests/time.test.js']);
});

test('selectTestFiles: a test file the reader cannot find selects nothing', () => {
  assert.deepEqual(selectTestFiles(['src/protocol/validate.ts'], [], protocolTests, reader({})), []);
});
