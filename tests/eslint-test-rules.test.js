// Tests for tools/eslint-test-rules.mjs: the three ESLint rules that hold the test method on `tests/**`
// (an assertion in every test, no presence-only assertion, no deepEqual on a wide literal without a comment).
// ESLint's RuleTester runs the cases; node:test's describe and it are what it needs.
import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';

import { plugin } from '../tools/eslint-test-rules.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });

const HEAD = "import { test, it, describe } from 'node:test';\nimport assert from 'node:assert/strict';\n";

/**
 * A source with the usual imports in front of `body`.
 * @param {string} body  The test code.
 * @returns {string} The file text.
 */
function src(body) {
  return HEAD + body;
}

/**
 * An object literal with `n` top-level properties.
 * @param {number} n  The property count.
 * @returns {string} The literal as source text.
 */
function fields(n) {
  return `{ ${Array.from({ length: n }, (_, i) => `f${i}: ${i}`).join(', ')} }`;
}

tester.run('tests/assertion-in-test', plugin.rules['assertion-in-test'], {
  valid: [
    { name: 'assert.equal in a test', code: src("test('a', () => { assert.equal(1, 1); });") },
    { name: 'callable assert', code: src("test('a', () => { assert(true); });") },
    { name: 'it inside describe', code: src("describe('g', () => { it('a', () => { assert.ok(1); }); });") },
    { name: 'awaited assert.rejects only', code: src("test('a', async () => { await assert.rejects(f()); });") },
    {
      name: 'subtest asserts through the context',
      code: src("test('a', async (t) => { await t.test('b', () => { assert.ok(1); }); });"),
    },
    { name: 'context assert', code: src("test('a', (t) => { t.assert.equal(1, 1); });") },
    {
      name: 'assertion in a nested function',
      code: src("test('a', () => { [1].forEach((x) => { assert.ok(x); }); });"),
    },
    {
      name: 'helper declared in the file, assert prefix',
      code: src("function assertShape(x) { assert.ok(x); }\ntest('a', () => { assertShape(1); });"),
    },
    {
      name: 'helper declared in the file, expect prefix, arrow',
      code: src("const expectOk = (x) => assert.ok(x);\ntest('a', () => { expectOk(1); });"),
    },
    {
      name: 'helper declared in the file, check prefix',
      code: src("function checkRow(x) { assert.ok(x); }\ntest('a', () => { checkRow(1); });"),
    },
    {
      name: 'alias of the assert import',
      code: "import { test } from 'node:test';\nimport a from 'node:assert';\ntest('a', () => { a.equal(1, 1); });",
    },
    {
      name: 'namespace import of assert',
      code: "import { test } from 'node:test';\nimport * as a from 'node:assert/strict';\ntest('a', () => { a.equal(1, 1); });",
    },
    {
      name: 'named import of an assertion function',
      code: "import { test } from 'node:test';\nimport { strictEqual } from 'node:assert';\ntest('a', () => { strictEqual(1, 1); });",
    },
    { name: 'test.todo is skipped', code: src("test.todo('later', () => {});") },
    { name: 'a test without a callback is skipped', code: src("test('later');") },
    {
      name: 'test alias of the node:test import',
      code: "import { test as t1 } from 'node:test';\nimport assert from 'node:assert';\nt1('a', () => { assert.ok(1); });",
    },
    { name: 'a call named test that is not node:test', code: "function test(a, b) {}\ntest('x', () => {});" },
  ],
  invalid: [
    { name: 'empty callback', code: src("test('a', () => {});"), errors: [{ messageId: 'missing' }] },
    { name: 'it without an assertion', code: src("it('a', () => { run(); });"), errors: [{ messageId: 'missing' }] },
    {
      name: 'a call that only looks like an assertion',
      code: src("test('a', () => { assertion(1); });"),
      errors: [{ messageId: 'missing' }],
    },
    {
      name: 'helper name without a declaration in the file',
      code: src("test('a', () => { assertShape(1); });"),
      errors: [{ messageId: 'missing' }],
    },
    {
      name: 'helper declared but with another name',
      code: src("function verify(x) { assert.ok(x); }\ntest('a', () => { verify(1); });"),
      errors: [{ messageId: 'missing' }],
    },
    {
      name: 'subtest without an assertion, parent with one',
      code: src("test('a', async (t) => { assert.ok(1); await t.test('b', () => { run(); }); });"),
      errors: [{ messageId: 'missing' }],
    },
    {
      name: 'only the empty test inside describe is reported',
      code: src("describe('g', () => { it('a', () => { assert.ok(1); }); it('b', () => {}); });"),
      errors: [{ messageId: 'missing', line: 3 }],
    },
    {
      name: 'async function expression callback',
      code: src("test('a', async function () { await run(); });"),
      errors: [{ messageId: 'missing' }],
    },
  ],
});

tester.run('tests/no-presence-assertion', plugin.rules['no-presence-assertion'], {
  valid: [
    { name: 'a value assertion', code: src('assert.equal(f(), 3);') },
    { name: 'ok on a truthy expression', code: src('assert.ok(list.includes(1));') },
    { name: 'ok on a comparison that is not a presence check', code: src('assert.ok(count > 0);') },
    { name: 'notEqual against a value', code: src('assert.notEqual(a, 3);') },
    { name: 'equal against a string literal without typeof', code: src("assert.equal(x, 'string');") },
    { name: 'same shape on something that is not assert', code: src('expect.ok(x !== undefined);') },
    {
      name: 'aliased import, value assertion',
      code: "import a from 'node:assert';\na.equal(f(), 1);",
    },
  ],
  invalid: [
    { name: 'ok with !== undefined', code: src('assert.ok(x !== undefined);'), errors: [{ messageId: 'presence' }] },
    { name: 'ok with != null', code: src('assert.ok(x != null);'), errors: [{ messageId: 'presence' }] },
    { name: 'ok with !== null', code: src('assert.ok(x !== null);'), errors: [{ messageId: 'presence' }] },
    {
      name: 'ok with undefined on the left',
      code: src('assert.ok(undefined !== x);'),
      errors: [{ messageId: 'presence' }],
    },
    { name: 'callable assert with != null', code: src('assert(x != null);'), errors: [{ messageId: 'presence' }] },
    { name: 'notEqual undefined', code: src('assert.notEqual(x, undefined);'), errors: [{ messageId: 'presence' }] },
    {
      name: 'notStrictEqual undefined',
      code: src('assert.notStrictEqual(x, undefined);'),
      errors: [{ messageId: 'presence' }],
    },
    { name: 'notEqual null', code: src('assert.notEqual(x, null);'), errors: [{ messageId: 'presence' }] },
    { name: 'equal on typeof', code: src("assert.equal(typeof x, 'function');"), errors: [{ messageId: 'presence' }] },
    {
      name: 'strictEqual on typeof',
      code: src("assert.strictEqual(typeof x, 'object');"),
      errors: [{ messageId: 'presence' }],
    },
    {
      name: 'aliased import',
      code: "import a from 'node:assert';\na.ok(x !== undefined);",
      errors: [{ messageId: 'presence' }],
    },
  ],
});

tester.run('tests/no-wide-deep-equal', plugin.rules['no-wide-deep-equal'], {
  valid: [
    { name: 'eight properties pass', code: src(`assert.deepEqual(f(), ${fields(8)});`) },
    { name: 'deepStrictEqual with eight passes', code: src(`assert.deepStrictEqual(f(), ${fields(8)});`) },
    {
      name: 'a comment on the line above lets nine pass',
      code: src(`// The whole shape is the contract here.\nassert.deepEqual(f(), ${fields(9)});`),
    },
    {
      name: 'a comment above an awaited statement',
      code: src(
        `async function g() {\n  // The whole shape is the point.\n  await assert.deepEqual(f(), ${fields(12)});\n}`
      ),
    },
    { name: 'a variable as the expected value', code: src('assert.deepEqual(f(), expected);') },
    { name: 'an array literal', code: src('assert.deepEqual(f(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);') },
    {
      name: 'nested fields do not count',
      code: src(`assert.deepEqual(f(), { a: ${fields(12)} });`),
    },
    { name: 'equal is not deepEqual', code: src(`assert.equal(f(), ${fields(12)});`) },
  ],
  invalid: [
    {
      name: 'nine properties fail',
      code: src(`assert.deepEqual(f(), ${fields(9)});`),
      errors: [{ messageId: 'wide' }],
    },
    {
      name: 'deepStrictEqual with nine fails',
      code: src(`assert.deepStrictEqual(f(), ${fields(9)});`),
      errors: [{ messageId: 'wide' }],
    },
    {
      name: 'a comment two lines above does not count',
      code: src(`// The whole shape.\n\nassert.deepEqual(f(), ${fields(9)});`),
      errors: [{ messageId: 'wide' }],
    },
    {
      name: 'a block comment above does not count',
      code: src(`/* shape */\nassert.deepEqual(f(), ${fields(9)});`),
      errors: [{ messageId: 'wide' }],
    },
    {
      name: 'spread properties count',
      code: src(`assert.deepEqual(f(), { ...base, ${fields(9).slice(2)});`),
      errors: [{ messageId: 'wide' }],
    },
    {
      name: 'aliased import',
      code: `import a from 'node:assert';\na.deepEqual(f(), ${fields(10)});`,
      errors: [{ messageId: 'wide' }],
    },
  ],
});
