// The ESLint rules that hold the test method on `tests/**` (AGENTS.md, section Tests). eslint.config.js registers
// the plugin as `tests`. The rules read the `node:test` and `node:assert` imports of a file, so a renamed import
// is followed. They are syntax checks, not proofs: they catch a test with no assertion, an assertion that only
// says a value exists, and a deepEqual on a wide literal nobody commented.
//
//   tests/assertion-in-test      every test(), it() and subtest calls an assertion
//   tests/no-presence-assertion  no assert.ok(x !== undefined), notEqual(x, null) or equal(typeof x, ...)
//   tests/no-wide-deep-equal     no deepEqual against a literal of more than 8 fields without a comment above

import type { ArrowFunctionExpression, CallExpression, FunctionExpression, Node, Program } from 'estree';
import type { Rule } from 'eslint';

/**
 * The most top-level fields a `deepEqual` expected literal may have without a comment above the assertion.
 * Past this, the assertion usually pins incidental fields, and the fields that matter should be asserted alone.
 */
const MAX_DEEP_EQUAL_FIELDS = 8;

const ASSERT_MODULES = new Set(['assert', 'assert/strict', 'node:assert', 'node:assert/strict']);
const TEST_FUNCTIONS = new Set(['test', 'it']);
/** A function declared in the test file counts as an assertion helper when its name starts like this. */
const HELPER_NAME = /^(assert|expect|check)/;
const DEEP_METHODS = new Set(['deepEqual', 'deepStrictEqual']);

type Call = CallExpression & Rule.NodeParentExtension;
type FunctionNode = FunctionExpression | ArrowFunctionExpression;

/**
 * Collects the local names a file gives to the `node:assert` and `node:test` imports.
 * @param program The Program node.
 * @returns assertNames maps a local name to the
 *   imported name (`default` for a default or namespace import), testNames holds the local `test` and `it` names.
 */
function readImports(program: Program): { assertNames: Map<string, string>; testNames: Set<string> } {
  const assertNames: Map<string, string> = new Map();
  const testNames: Set<string> = new Set();
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = String(node.source.value);
    for (const spec of node.specifiers) {
      const imported =
        spec.type === 'ImportSpecifier'
          ? spec.imported.type === 'Identifier'
            ? spec.imported.name
            : String(spec.imported.value)
          : 'default';
      if (ASSERT_MODULES.has(source)) {
        assertNames.set(spec.local.name, imported === 'strict' ? 'default' : imported);
      } else if (source === 'node:test' || source === 'test') {
        if (TEST_FUNCTIONS.has(imported) || spec.type === 'ImportDefaultSpecifier') testNames.add(spec.local.name);
      }
    }
  }
  return { assertNames, testNames };
}

/**
 * The assertion method a call makes, or null when the call is not on an imported `assert`.
 * @param call The call.
 * @param assertNames From readImports.
 * @returns `ok` for a bare `assert(...)`, otherwise the method name.
 */
function assertMethod(call: CallExpression, assertNames: Map<string, string>): string | null {
  const callee = call.callee;
  if (callee.type === 'Identifier' && assertNames.has(callee.name)) {
    const imported = assertNames.get(callee.name);
    return imported === 'default' ? 'ok' : (imported ?? null);
  }
  if (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    assertNames.get(callee.object.name) === 'default' &&
    callee.property.type === 'Identifier' &&
    !callee.computed
  ) {
    return callee.property.name;
  }
  return null;
}

/**
 * @param node Any node.
 * @returns true for the `undefined` identifier or a null literal.
 */
function isNothing(node: Node): boolean {
  return (node.type === 'Identifier' && node.name === 'undefined') || (node.type === 'Literal' && node.value === null);
}

/**
 * @param node Any node.
 * @returns true for a function expression or an arrow function.
 */
function isFunction(node: Node): node is FunctionNode {
  return node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

/**
 * @param value Anything found under a node.
 * @returns true for an AST node.
 */
function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * Walks every node under `root`, descending into nested functions.
 * @param root The node to start from.
 * @param keys The visitor keys of the parser.
 * @param visit Called for each node.
 */
function walk(root: Node, keys: Record<string, ReadonlyArray<string> | undefined>, visit: (node: Node) => void) {
  visit(root);
  const fields = root as unknown as Record<string, unknown>;
  for (const key of keys[root.type] ?? []) {
    const child = fields[key];
    if (Array.isArray(child)) {
      for (const item of child as Array<unknown>) if (isNode(item)) walk(item, keys, visit);
    } else if (isNode(child)) {
      walk(child, keys, visit);
    }
  }
}

/**
 * @param callee The callee of a call.
 * @returns The name of the identifier a chain of member accesses starts from.
 */
function chainRoot(callee: Node): string | null {
  let node = callee;
  while (node.type === 'MemberExpression') node = node.object;
  return node.type === 'Identifier' ? node.name : null;
}

/**
 * @param callee The callee of a call.
 * @returns true for `x.assert.y(...)`, the assertions of the test context.
 */
function isContextAssert(callee: Node): boolean {
  let node = callee;
  while (node.type === 'MemberExpression') {
    if (!node.computed && node.property.type === 'Identifier' && node.property.name === 'assert') return true;
    node = node.object;
  }
  return false;
}

/**
 * The callback of a test call, or null when the call is not a test, is a todo, or has no callback.
 * @param call The call.
 * @param testNames Local names of node:test's test and it.
 * @returns The function node.
 */
function testCallback(call: CallExpression, testNames: Set<string>): FunctionNode | null {
  const callee = call.callee;
  let isTest = false;
  if (callee.type === 'Identifier') {
    isTest = testNames.has(callee.name);
  } else if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    const name = callee.property.name;
    if (name === 'todo') return null;
    if (callee.object.type === 'Identifier' && testNames.has(callee.object.name)) {
      isTest = name === 'only' || name === 'skip';
    } else {
      // A subtest: t.test(...), where `t` is the context of the parent test.
      isTest = TEST_FUNCTIONS.has(name) && callee.object.type === 'Identifier';
    }
  }
  if (!isTest) return null;
  const fn = call.arguments.find(isFunction);
  if (!fn) return null;
  const todo = call.arguments.some(
    (arg) =>
      arg.type === 'ObjectExpression' &&
      arg.properties.some((p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'todo')
  );
  return todo ? null : fn;
}

const assertionInTest: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Require an assertion in the callback of every test.' },
    messages: {
      missing: 'This test never asserts. Call assert, t.assert or a helper named assert*, expect* or check*.',
    },
    schema: [],
  },
  create(context) {
    const keys = context.sourceCode.visitorKeys;
    const calls: Array<Call> = [];
    const helpers: Set<string> = new Set();
    return {
      CallExpression(node) {
        calls.push(node);
      },
      FunctionDeclaration(node) {
        if (node.id && HELPER_NAME.test(node.id.name)) helpers.add(node.id.name);
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.init && isFunction(node.init) && HELPER_NAME.test(node.id.name)) {
          helpers.add(node.id.name);
        }
      },
      'Program:exit'(program) {
        const { assertNames, testNames } = readImports(program);
        for (const call of calls) {
          const fn = testCallback(call, testNames);
          if (!fn) continue;
          let asserts = false;
          walk(fn.body, keys, (node) => {
            if (asserts || node.type !== 'CallExpression') return;
            const root = chainRoot(node.callee);
            asserts =
              assertMethod(node, assertNames) !== null ||
              isContextAssert(node.callee) ||
              (root !== null && helpers.has(root));
          });
          if (!asserts) context.report({ node: call, messageId: 'missing' });
        }
      },
    };
  },
};

const noPresenceAssertion: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Forbid assertions that only say a value exists or has a type.' },
    messages: {
      presence: 'This assertion only says that a value exists or has a type. Assert the value that matters instead.',
    },
    schema: [],
  },
  create(context) {
    const calls: Array<Call> = [];
    return {
      CallExpression(node) {
        calls.push(node);
      },
      'Program:exit'(program) {
        const { assertNames } = readImports(program);
        for (const call of calls) {
          const method = assertMethod(call, assertNames);
          if (!method) continue;
          const [first, second] = call.arguments;
          let presence = false;
          if (method === 'ok' && first?.type === 'BinaryExpression') {
            presence =
              (first.operator === '!==' || first.operator === '!=') &&
              (isNothing(first.left) || isNothing(first.right));
          } else if (method === 'notEqual' || method === 'notStrictEqual') {
            presence = second !== undefined && isNothing(second);
          } else if (method === 'equal' || method === 'strictEqual') {
            presence = first?.type === 'UnaryExpression' && first.operator === 'typeof';
          }
          if (presence) context.report({ node: call, messageId: 'presence' });
        }
      },
    };
  },
};

const noWideDeepEqual: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Forbid deepEqual against a wide object literal unless a comment says why.' },
    messages: {
      wide: 'This deepEqual pins more than 8 fields. Assert the fields that matter, or say in a // comment on the line above why the whole shape is the point.',
    },
    schema: [],
  },
  create(context) {
    const calls: Array<Call> = [];
    return {
      CallExpression(node) {
        calls.push(node);
      },
      'Program:exit'(program) {
        const { assertNames } = readImports(program);
        const comments = context.sourceCode.getAllComments();
        for (const call of calls) {
          const method = assertMethod(call, assertNames);
          const expected = call.arguments[1];
          if (!method || !DEEP_METHODS.has(method) || expected?.type !== 'ObjectExpression') continue;
          if (expected.properties.length <= MAX_DEEP_EQUAL_FIELDS) continue;
          let statement: Rule.Node = call;
          while (statement.parent.type !== 'Program' && statement.parent.type !== 'BlockStatement') {
            statement = statement.parent;
          }
          const line = statement.loc?.start.line ?? 0;
          if (comments.some((c) => c.type === 'Line' && (c.loc?.end.line ?? 0) === line - 1)) continue;
          context.report({ node: call, messageId: 'wide' });
        }
      },
    };
  },
};

export const plugin: { meta: { name: string }; rules: Record<string, Rule.RuleModule> } = {
  meta: { name: 'eslint-test-rules' },
  rules: {
    'assertion-in-test': assertionInTest,
    'no-presence-assertion': noPresenceAssertion,
    'no-wide-deep-equal': noWideDeepEqual,
  },
};
