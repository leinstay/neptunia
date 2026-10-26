import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseChangedRanges,
  sourceRanges,
  toMutateEntries,
  selectTestFiles,
  filesWithoutTest,
  isFormatOnly,
  capRanges,
  scoreFromReport,
} from '../tools/mutation-diff.mjs';

/** @param {...string} parts */
const diffOf = (...parts) => parts.join('\n') + '\n';
/** @param {string} file */
const fileHead = (file) =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}`;

test('parseChangedRanges: reads the new-side range from a real unified=0 hunk header', () => {
  const diff = diffOf(fileHead('src/time.js'), '@@ -41,2 +41,5 @@ export function parse(x) {', '-old', '+new');
  assert.deepEqual(parseChangedRanges(diff), { 'src/time.js': [[41, 45]] });
});

test('parseChangedRanges: a header without a count is one line', () => {
  const diff = diffOf(fileHead('src/log.js'), '@@ -7 +7 @@', '-a', '+b');
  assert.deepEqual(parseChangedRanges(diff), { 'src/log.js': [[7, 7]] });
});

test('parseChangedRanges: a pure insertion starts at the line after the anchor', () => {
  const diff = diffOf(fileHead('src/log.js'), '@@ -10,0 +11,3 @@', '+a', '+b', '+c');
  assert.deepEqual(parseChangedRanges(diff), { 'src/log.js': [[11, 13]] });
});

test('parseChangedRanges: a deleted-only hunk yields no range but the file stays listed', () => {
  const diff = diffOf(fileHead('src/log.js'), '@@ -20,3 +19,0 @@', '-a', '-b', '-c');
  assert.deepEqual(parseChangedRanges(diff), { 'src/log.js': [] });
});

test('parseChangedRanges: collects two hunks of one file in order', () => {
  const diff = diffOf(fileHead('src/log.js'), '@@ -3 +3,2 @@', '-a', '+b', '+c', '@@ -30,0 +31 @@', '+d');
  assert.deepEqual(parseChangedRanges(diff), {
    'src/log.js': [
      [3, 4],
      [31, 31],
    ],
  });
});

test('parseChangedRanges: keeps files apart and skips a deleted file', () => {
  const diff = diffOf(
    fileHead('src/a.js'),
    '@@ -1 +1 @@',
    '+x',
    'diff --git a/src/gone.js b/src/gone.js',
    'deleted file mode 100644',
    '--- a/src/gone.js',
    '+++ /dev/null',
    '@@ -1,4 +0,0 @@',
    '-x',
    fileHead('tests/a.test.js'),
    '@@ -2 +2 @@',
    '+y'
  );
  assert.deepEqual(parseChangedRanges(diff), { 'src/a.js': [[1, 1]], 'tests/a.test.js': [[2, 2]] });
});

test('parseChangedRanges: returns an empty map for an empty diff', () => {
  assert.deepEqual(parseChangedRanges(''), {});
});

test('sourceRanges: keeps js, mjs and ts under src and interfaces and drops tests, tools and fixtures', () => {
  /** @type {Record<string, Array<[number, number]>>} */
  const ranges = {
    'src/a.js': [[1, 2]],
    'src/memory/b.ts': [[4, 4]],
    'interfaces/discord/c.mjs': [[9, 9]],
    'interfaces/discord/node_modules/x/index.js': [[1, 1]],
    'src/prompts/p.md': [[1, 1]],
    'src/fixtures/f.js': [[1, 1]],
    'tests/a.test.js': [[1, 1]],
    'tools/t.mjs': [[1, 1]],
    'src/deleted-only.js': [],
  };
  assert.deepEqual(Object.keys(sourceRanges(ranges)).sort(), [
    'interfaces/discord/c.mjs',
    'src/a.js',
    'src/memory/b.ts',
  ]);
});

test('sourceRanges: returns an empty map when only a test changed', () => {
  assert.deepEqual(sourceRanges({ 'tests/a.test.js': [[1, 1]] }), {});
});

test('toMutateEntries: writes path:start-end per range in file order', () => {
  const entries = toMutateEntries({
    'src/a.js': [
      [3, 4],
      [31, 31],
    ],
    'src/b.js': [[1, 9]],
  });
  assert.deepEqual(entries, ['src/a.js:3-4', 'src/a.js:31-31', 'src/b.js:1-9']);
});

test('toMutateEntries: returns nothing for no files', () => {
  assert.deepEqual(toMutateEntries({}), []);
});

const existing = [
  'tests/time.test.js',
  'tests/discord-gateway.test.js',
  'tests/memory-db.test.js',
  'tests/mutation-diff.test.js',
  'tests/other.test.js',
];

test('selectTestFiles: picks the test named after the file', () => {
  assert.deepEqual(selectTestFiles(['src/time.js'], [], existing), ['tests/time.test.js']);
});

test('selectTestFiles: matches a tail of the folder path joined by hyphens', () => {
  assert.deepEqual(selectTestFiles(['interfaces/discord/gateway.js'], [], existing), ['tests/discord-gateway.test.js']);
  assert.deepEqual(selectTestFiles(['src/memory/db.js'], [], existing), ['tests/memory-db.test.js']);
});

test('selectTestFiles: a source file without a test selects nothing', () => {
  assert.deepEqual(selectTestFiles(['src/orphan.js'], [], existing), []);
});

test('selectTestFiles: adds a changed test file and lists each test once', () => {
  const picked = selectTestFiles(['src/time.js'], ['tests/time.test.js', 'tests/other.test.js', 'docs/x.md'], existing);
  assert.deepEqual(picked, ['tests/other.test.js', 'tests/time.test.js']);
});

test('selectTestFiles: a changed test file is kept even when no source changed', () => {
  assert.deepEqual(selectTestFiles([], ['tests/other.test.js'], existing), ['tests/other.test.js']);
});

// The selection by imports. `selectTestFiles` and `filesWithoutTest` take the source of a test file as a last
// argument, `read(path)`, which returns the text of a repository path or undefined. Without it only the naming rule
// applies, so the tests above keep their three-argument calls.
const protocolTests = ['tests/protocol.test.js', 'tests/protocol-events.test.ts', 'tests/time.test.js'];
/** @param {Record<string, string>} files */
const reader = (files) => (/** @type {string} */ file) => files[file];

test('selectTestFiles: picks a test of another name that imports the module', () => {
  const read = reader({
    'tests/protocol.test.js': "import { validate } from '../src/protocol/validate.js';\n",
    'tests/protocol-events.test.ts': "import { validate } from '../src/protocol/validate.js';\n",
    'tests/time.test.js': "import { parse } from '../src/time.js';\n",
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.js'], [], protocolTests, read), [
    'tests/protocol-events.test.ts',
    'tests/protocol.test.js',
  ]);
});

test('selectTestFiles: follows an export from and a literal dynamic import', () => {
  const read = reader({
    'tests/protocol.test.js': "export { validate } from '../src/protocol/validate.js';\n",
    'tests/protocol-events.test.ts': "const m = await import('../src/protocol/validate.js');\n",
    'tests/time.test.js': '',
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.js'], [], protocolTests, read), [
    'tests/protocol-events.test.ts',
    'tests/protocol.test.js',
  ]);
});

test('selectTestFiles: does not pick a test that imports other modules only', () => {
  const read = reader({
    'tests/protocol.test.js': "import { send } from '../src/protocol/send.js';\n",
    'tests/protocol-events.test.ts': "import { validate } from '../src/protocol/validate.js';\n",
    'tests/time.test.js': "import { parse } from '../src/time.js';\n",
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.js'], [], protocolTests, read), [
    'tests/protocol-events.test.ts',
  ]);
});

test('selectTestFiles: a module neither named nor imported selects nothing', () => {
  const read = reader({
    'tests/protocol.test.js': "import { send } from '../src/protocol/send.js';\n",
    'tests/protocol-events.test.ts': '',
    'tests/time.test.js': "import { parse } from '../src/time.js';\n",
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.js'], [], protocolTests, read), []);
});

test('selectTestFiles: does not follow a test that imports the module through a fixture', () => {
  const read = reader({
    'tests/protocol.test.js': "import { makeValidator } from './helpers/validator.js';\n",
    'tests/helpers/validator.js': "import { validate } from '../../src/protocol/validate.js';\n",
    'tests/protocol-events.test.ts': '',
    'tests/time.test.js': '',
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.js'], [], protocolTests, read), []);
});

test('selectTestFiles: keeps the named test next to the importing ones', () => {
  const tests = ['tests/protocol-validate.test.js', 'tests/protocol.test.js', 'tests/time.test.js'];
  const read = reader({
    'tests/protocol-validate.test.js': "import { other } from '../src/other.js';\n",
    'tests/protocol.test.js': "import { validate } from '../src/protocol/validate.js';\n",
    'tests/time.test.js': '',
  });
  assert.deepEqual(selectTestFiles(['src/protocol/validate.js'], [], tests, read), [
    'tests/protocol-validate.test.js',
    'tests/protocol.test.js',
  ]);
});

test('selectTestFiles: lists a test once when the name and an import both pick it', () => {
  const read = reader({ 'tests/time.test.js': "import { parse } from '../src/time.js';\n" });
  assert.deepEqual(selectTestFiles(['src/time.js'], [], ['tests/time.test.js'], read), ['tests/time.test.js']);
});

test('selectTestFiles: a test file the reader cannot find selects nothing', () => {
  assert.deepEqual(selectTestFiles(['src/protocol/validate.js'], [], protocolTests, reader({})), []);
});

test('filesWithoutTest: does not name a module that a test of another name imports', () => {
  const read = reader({
    'tests/protocol.test.js': "import { validate } from '../src/protocol/validate.js';\n",
    'tests/protocol-events.test.ts': '',
    'tests/time.test.js': '',
  });
  assert.deepEqual(filesWithoutTest(['src/protocol/validate.js', 'src/orphan.js'], protocolTests, read), [
    'src/orphan.js',
  ]);
});

test('capRanges: keeps everything under the budget', () => {
  const result = capRanges({ 'src/a.js': [[1, 10]], 'src/b.js': [[1, 5]] }, 100);
  assert.deepEqual(result.ranges, { 'src/a.js': [[1, 10]], 'src/b.js': [[1, 5]] });
  assert.deepEqual(result.skipped, {});
});

test('capRanges: takes the largest file first and reports the lines it left out', () => {
  const result = capRanges({ 'src/small.js': [[1, 5]], 'src/big.js': [[1, 20]], 'src/mid.js': [[1, 10]] }, 25);
  assert.deepEqual(result.ranges, { 'src/big.js': [[1, 20]], 'src/mid.js': [[1, 5]] });
  assert.deepEqual(result.skipped, { 'src/mid.js': 5, 'src/small.js': 5 });
});

test('capRanges: trims the last range of one huge file to the budget', () => {
  const result = capRanges(
    {
      'src/big.js': [
        [1, 10],
        [50, 90],
      ],
    },
    15
  );
  assert.deepEqual(result.ranges, {
    'src/big.js': [
      [1, 10],
      [50, 54],
    ],
  });
  assert.deepEqual(result.skipped, { 'src/big.js': 36 });
});

test('scoreFromReport: counts killed and timed-out mutants as detected and ignores compile errors', () => {
  const report = {
    files: {
      'src/a.js': {
        mutants: [
          { status: 'Killed' },
          { status: 'Timeout' },
          { status: 'Survived' },
          { status: 'NoCoverage' },
          { status: 'CompileError' },
          { status: 'Ignored' },
        ],
      },
      'src/b.js': { mutants: [{ status: 'Killed' }, { status: 'Killed' }] },
    },
  };
  assert.deepEqual(scoreFromReport(report), { score: (4 / 6) * 100, detected: 4, undetected: 2 });
});

test('scoreFromReport: gives a null score when no mutant could be judged', () => {
  assert.equal(scoreFromReport({ files: { 'src/a.js': { mutants: [{ status: 'CompileError' }] } } }).score, null);
  assert.equal(scoreFromReport({ files: {} }).score, null);
});

test('filesWithoutTest: names the source files no test is named after', () => {
  assert.deepEqual(filesWithoutTest(['src/time.js', 'src/orphan.js'], existing), ['src/orphan.js']);
});

test('filesWithoutTest: names nothing when every file has a test', () => {
  assert.deepEqual(filesWithoutTest(['src/time.js', 'src/memory/db.js'], existing), []);
});

test('filesWithoutTest: names nothing for an empty list', () => {
  assert.deepEqual(filesWithoutTest([], existing), []);
});

test('isFormatOnly: true when every subject starts with Format', () => {
  assert.equal(isFormatOnly(['Format src/time.js with Prettier', 'Format the memory modules']), true);
});

test('isFormatOnly: false when one subject changes something else', () => {
  assert.equal(isFormatOnly(['Format src/time.js with Prettier', 'Fix the day rollover']), false);
});

test('isFormatOnly: false for an empty list', () => {
  assert.equal(isFormatOnly([]), false);
});

test('isFormatOnly: false for a subject that only contains the word Format later', () => {
  assert.equal(isFormatOnly(['Reformat the tests']), false);
});
