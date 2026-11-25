// Tests for src/config/schema.ts, the settings schema: one entry per key with its JSON types, its reader (the module
// that reads it), its default and one line of text. A map (a section whose keys are free, such as `bot.access` or
// `models.abilities`, keyed by tool or model ids that hold dots) is one entry of type `map`. `schemaDefaults` builds the
// settings object the defaults give, which is `config/config.json` exactly. The tests read the schema and the tracked
// file, never a local layer.
// The cut of the settings (tests/fixtures/config-cut.ts) lists the keys the schema leaves out: no daily cap is a key,
// the request rail stays, and the Discord keys live in the Discord package's own settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { CONFIG_SCHEMA, schemaDefaults } from '../../../src/config/schema.ts';
import type { SchemaEntry } from '../../../src/config/schema.ts';
import { ROOT } from '../../fixtures/private-layer.ts';
import { tempDir } from '../../fixtures/tmp.ts';

import { DailyCapError, countLlmRequest } from '../../../src/llm/openrouter.ts';

import { CUT } from '../../fixtures/config-cut.ts';
import { checkConfig } from '../../../src/config/check.ts';

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

// ---- the cut -------------------------------------------------------------------------------------------------------

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

test('drops the daily caps and keeps the one request rail, which refuses the 5,001st request', () => {
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

// The gate on the reader column of the settings schema, which docs/configuration.md prints: the
// module an entry names as its `reader` reads that key. The scan parses the modules with the compiler, so a key named
// only in a comment or a type does not count. A key `a.b.c` has its leaf `c` and its section `b`, the nearest segment
// before the leaf that is no `*`. A module reads the key in one of three ways:
//
// - directly: it reads the leaf from the section. The value the leaf is read from is `x.b`, a name bound to `x.b`, the
//   result of an imported function whose module reads `b`, or a parameter or other name of a module that reads `b`.
// - by passing the section on: it hands `x.b` to a function it imports, and that function's module reads the leaf.
// - as the receiver of a section another module passes on: it reads the leaf, and a module of the tree passes it `x.b`.
//
// A string in a call or an array literal, as in `['memoryDb', 'retrieval']`, is a read of that name. A leaf read from
// another property (`x.other.c`) never counts, so two settings that share a leaf name stay apart.

/** Where a value comes from: a property of that name, the result of a function of that module, or a bare name. */
type Source = { prop: string } | { module: string } | { bare: true };

/** One module as the scan sees it. */
type Module = {
  /** The property names it reads anywhere, a string key included. */
  names: Set<string>;
  /** Each leaf it reads, with where the value it reads the leaf from comes from. */
  reads: Array<{ name: string; from: ReadonlyArray<Source> }>;
  /** Each property it hands to an imported function, with that function's module. */
  passes: Array<{ prop: string; to: string }>;
  /** The modules it re-exports. */
  reexports: Set<string>;
};

/** One file being scanned: where it is, the names it binds to imported functions and every declaration by name. */
type FileScan = {
  root: string;
  file: string;
  imported: Map<string, string>;
  declared: Map<string, Array<{ scope: ts.Node; init: ts.Expression | null }>>;
};

/** The module a relative specifier names, relative to the root; null for a package. */
function moduleOf(scan: FileScan, spec: string): string | null {
  return spec.startsWith('.') ? path.relative(scan.root, path.resolve(path.dirname(scan.file), spec)) : null;
}

/** The block, function or file a declaration belongs to. */
function scopeOf(node: ts.Node): ts.Node {
  let up = node.parent;
  while (!ts.isBlock(up) && !ts.isSourceFile(up) && !ts.isFunctionLike(up)) up = up.parent;
  return up;
}

/** `expr` without the `await` and parentheses around it. */
function unwrapAwait(expr: ts.Expression | undefined): ts.Expression | undefined {
  let e = expr;
  while (e !== undefined && (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
  return e;
}

/** The module of `import('./m.ts')` (awaited or not), else null. */
function dynamicImport(scan: FileScan, expr: ts.Expression | undefined): string | null {
  const e = unwrapAwait(expr);
  if (e === undefined || !ts.isCallExpression(e)) return null;
  const [spec] = e.arguments;
  const isImport = e.expression.kind === ts.SyntaxKind.ImportKeyword;
  return isImport && spec !== undefined && ts.isStringLiteralLike(spec) ? moduleOf(scan, spec.text) : null;
}

function declare(scan: FileScan, name: string, node: ts.Node, init: ts.Expression | null): void {
  const list = scan.declared.get(name) ?? [];
  list.push({ scope: scopeOf(node), init });
  scan.declared.set(name, list);
}

function noteImport(scan: FileScan, node: ts.ImportDeclaration): void {
  const specifier = node.moduleSpecifier;
  const from = ts.isStringLiteral(specifier) ? moduleOf(scan, specifier.text) : null;
  const bindings = node.importClause?.namedBindings;
  if (from === null || bindings === undefined || !ts.isNamedImports(bindings)) return;
  for (const element of bindings.elements) scan.imported.set(element.name.text, from);
}

/** The module of one item of `const [{ f }] = await Promise.all([import('./m.ts'), ...])`, else null. */
function listedImport(scan: FileScan, holder: ts.BindingElement): string | null {
  const list = holder.parent;
  if (!ts.isArrayBindingPattern(list)) return null;
  const declaration = list.parent;
  if (!ts.isVariableDeclaration(declaration)) return null;
  const all = unwrapAwait(declaration.initializer);
  const items = all !== undefined && ts.isCallExpression(all) ? all.arguments[0] : undefined;
  if (items === undefined || !ts.isArrayLiteralExpression(items)) return null;
  return dynamicImport(scan, items.elements[list.elements.indexOf(holder)]);
}

/** The module a destructured name comes from: `const { f } = await import('./m.ts')` or one item of a list of them. */
function bindingImport(scan: FileScan, node: ts.BindingElement): string | null {
  const pattern = node.parent;
  const holder = pattern.parent;
  if (ts.isVariableDeclaration(holder)) return dynamicImport(scan, holder.initializer);
  return ts.isBindingElement(holder) ? listedImport(scan, holder) : null;
}

function collect(scan: FileScan, node: ts.Node): void {
  if (ts.isImportDeclaration(node)) noteImport(scan, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
    declare(scan, node.name.text, node, node.initializer ?? null);
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
    declare(scan, node.name.text, node, null);
    const from = bindingImport(scan, node);
    if (from !== null) scan.imported.set(node.name.text, from);
  }
  ts.forEachChild(node, (child) => collect(scan, child));
}

/** What `id` is bound to where it is used: the declaration of the innermost scope that holds the use. */
function bindingOf(scan: FileScan, id: ts.Identifier): ts.Expression | null {
  let best: { scope: ts.Node; init: ts.Expression | null } | null = null;
  for (const one of scan.declared.get(id.text) ?? []) {
    const { scope } = one;
    if (scope.pos > id.pos || scope.end < id.end) continue;
    if (best === null || (scope.pos >= best.scope.pos && scope.end <= best.scope.end)) best = one;
  }
  return best?.init ?? null;
}

/** Whether `e` hands its value through: parentheses, `as`, `!`, or the left side of `??` and `||`. */
function passThrough(e: ts.Expression): ts.Expression | null {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return e.expression;
  if (!ts.isBinaryExpression(e)) return null;
  const operator = e.operatorToken.kind;
  const either = operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
  return either ? e.left : null;
}

/** A call gives what its module reads, a string argument names a section, and the first argument passes through. */
function callSource(scan: FileScan, call: ts.CallExpression, callee: ts.Identifier, depth: number): Array<Source> {
  const from = scan.imported.get(callee.text);
  const [first] = call.arguments;
  const named = call.arguments.filter(ts.isStringLiteralLike).map((arg) => ({ prop: arg.text }));
  return [
    ...(from === undefined ? [] : [{ module: from }]),
    ...named,
    ...(first === undefined ? [] : sourceOf(scan, first, depth)),
  ];
}

/** Where the value of `expr` comes from, following names bound in the file up to four steps. */
function sourceOf(scan: FileScan, expr: ts.Expression, depth = 0): Array<Source> {
  let e = expr;
  for (let next = passThrough(e); next !== null; next = passThrough(e)) e = next;
  if (ts.isPropertyAccessExpression(e)) return [{ prop: e.name.text }];
  if (ts.isElementAccessExpression(e)) {
    const key = e.argumentExpression;
    return ts.isStringLiteralLike(key) ? [{ prop: key.text }] : sourceOf(scan, e.expression, depth);
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return callSource(scan, e, e.expression, depth);
  const init = ts.isIdentifier(e) && depth < 4 ? bindingOf(scan, e) : null;
  return init === null ? [{ bare: true }] : sourceOf(scan, init, depth + 1);
}

/** Whether `node` sits inside a type. */
function inType(node: ts.Node): boolean {
  for (let up = node.parent; up !== undefined; up = up.parent) {
    if (ts.isTypeNode(up)) return true;
    if (ts.isStatement(up)) return false;
  }
  return false;
}

/** A string read as a key: an argument, as `count('seeds')` reading `retrieval[name]`, or an item of a path. */
function isKeyString(node: ts.Node): node is ts.StringLiteralLike {
  if (!ts.isStringLiteralLike(node)) return false;
  const parent = node.parent;
  return ts.isArrayLiteralExpression(parent) || (ts.isCallExpression(parent) && parent.arguments.includes(node));
}

/** The name `{ name }` reads, with where the destructured value comes from. */
function bindingRead(scan: FileScan, node: ts.BindingElement): { name: string; from: Array<Source> } | null {
  const key = node.propertyName ?? node.name;
  if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return null;
  const pattern = node.parent;
  const declaration = pattern.parent;
  const init = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  return { name: key.text, from: init === undefined ? [{ bare: true }] : sourceOf(scan, init) };
}

/** The property name `node` reads and where the value it reads it from comes from; null when it reads none. */
function readOf(scan: FileScan, node: ts.Node): { name: string; from: Array<Source> } | null {
  if (ts.isPropertyAccessExpression(node)) return { name: node.name.text, from: sourceOf(scan, node.expression) };
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return ts.isStringLiteralLike(key) ? { name: key.text, from: sourceOf(scan, node.expression) } : null;
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) return bindingRead(scan, node);
  return isKeyString(node) ? { name: node.text, from: [{ bare: true }] } : null;
}

/** Each property `node` hands to an imported function. */
function passesOf(scan: FileScan, node: ts.Node): Array<{ prop: string; to: string }> {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return [];
  const to = scan.imported.get(node.expression.text);
  if (to === undefined) return [];
  return node.arguments.flatMap((arg) =>
    sourceOf(scan, arg).flatMap((from) => ('prop' in from ? [{ prop: from.prop, to }] : []))
  );
}

function visit(scan: FileScan, module: Module, node: ts.Node): void {
  if (ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier;
    const from = specifier !== undefined && ts.isStringLiteral(specifier) ? moduleOf(scan, specifier.text) : null;
    if (from !== null) module.reexports.add(from);
    return;
  }
  if (ts.isImportDeclaration(node) || inType(node)) return;
  const read = readOf(scan, node);
  if (read !== null) {
    module.names.add(read.name);
    module.reads.push(read);
  }
  module.passes.push(...passesOf(scan, node));
  ts.forEachChild(node, (child) => visit(scan, module, child));
}

/** One module of `root` as the scan sees it, null when the file does not exist. */
function scanModule(root: string, rel: string): Module | null {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return null;
  const sf = ts.createSourceFile(rel, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scan: FileScan = { root, file, imported: new Map(), declared: new Map() };
  collect(scan, sf);
  const module: Module = { names: new Set(), reads: [], passes: [], reexports: new Set() };
  visit(scan, module, sf);
  return module;
}

function scanner(root: string): (rel: string) => Module | null {
  const cache = new Map<string, Module | null>();
  return (rel: string): Module | null => {
    if (!cache.has(rel)) cache.set(rel, scanModule(root, rel));
    return cache.get(rel) ?? null;
  };
}

/** The `.ts` files under `dirs` of `root`, relative to it, outside `node_modules`. */
function filesOf(root: string, dirs: ReadonlyArray<string>): Array<string> {
  const out: Array<string> = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(child);
      } else if (child.endsWith('.ts')) out.push(child);
    }
  };
  for (const dir of dirs) if (fs.existsSync(path.join(root, dir))) walk(dir);
  return out;
}

type ReaderProblem = { key: string; reader: string; kind: 'no-module' | 'not-read' };

/** The entries of `schema` whose reader under `root` is missing or does not read the key. */
function checkReaders(schema: ReadonlyArray<SchemaEntry>, root: string): Array<ReaderProblem> {
  const scan = scanner(root);
  const tree = filesOf(root, ['src', 'bin', 'interfaces']);
  const handedTo = (rel: string, section: string): boolean =>
    tree.some((other) => scan(other)?.passes.some((pass) => pass.prop === section && pass.to === rel) === true);
  // Whether a module, or a module it re-exports, reads `name`.
  const readsName = (rel: string, name: string): boolean => {
    const module = scan(rel);
    return (
      module !== null && (module.names.has(name) || [...module.reexports].some((from) => scan(from)?.names.has(name)))
    );
  };
  const out: Array<ReaderProblem> = [];
  for (const { key, reader } of schema) {
    const module = scan(reader);
    if (module === null) {
      out.push({ key, reader, kind: 'no-module' });
      continue;
    }
    const segments = key.split('.').filter((segment) => segment !== '*');
    const leaf = segments[segments.length - 1] ?? '';
    const section = segments.length > 1 ? (segments[segments.length - 2] ?? null) : null;
    const leafReads = module.reads.filter((read) => read.name === leaf);
    const fromSection = (from: Source): boolean =>
      section === null ||
      ('prop' in from && from.prop === section) ||
      ('module' in from && readsName(from.module, section)) ||
      ('bare' in from && module.names.has(section));
    const direct = leafReads.some((read) => read.from.some(fromSection));
    const passesOn =
      section !== null &&
      module.passes.some((pass) => pass.prop === section && scan(pass.to)?.names.has(leaf) === true);
    const receives =
      section !== null &&
      leafReads.some((read) => read.from.some((from) => 'bare' in from)) &&
      handedTo(reader, section);
    if (!direct && !passesOn && !receives) out.push({ key, reader, kind: 'not-read' });
  }
  return out;
}

// ---- the rule, on small trees --------------------------------------------------------------------------------------

function tree(files: Record<string, string>): string {
  const dir = tempDir('nep-readers-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const entry = (key: string, reader: string): SchemaEntry => ({ key, types: ['number'], reader, default: 1, text: key });

test('takes a reader that reads the leaf from the section, through a name bound to it', () => {
  const root = tree({ 'src/a.ts': 'const s = hot.config.llm ?? {};\nexport const ms = s.timeoutMs;\n' });
  assert.deepEqual(checkReaders([entry('llm.timeoutMs', 'src/a.ts')], root), []);
});

test('takes a reader that reads the section and passes it to an imported module that reads the leaf', () => {
  const root = tree({
    'src/a.ts': "import { wait } from './b.ts';\nwait(hot.config.llm);\n",
    'src/b.ts': 'export function wait(llm) {\n  return llm.timeoutMs;\n}\n',
  });
  assert.deepEqual(checkReaders([entry('llm.timeoutMs', 'src/a.ts')], root), []);
});

test('takes a reader that reads the leaf of a section another module passes it', () => {
  const root = tree({
    'src/a.ts': "import { wait } from './b.ts';\nwait(hot.config.llm);\n",
    'src/b.ts': 'export function wait(cfg) {\n  return cfg.timeoutMs;\n}\n',
  });
  assert.deepEqual(checkReaders([entry('llm.timeoutMs', 'src/b.ts')], root), []);
});

test('reports a reader that names the key only in a comment', () => {
  // Bug: the reader column names a module whose doc comment mentions the key after the read moved elsewhere.
  const root = tree({ 'src/a.ts': '// waits llm.timeoutMs\nexport const ms = 1;\n' });
  assert.deepEqual(checkReaders([entry('llm.timeoutMs', 'src/a.ts')], root), [
    { key: 'llm.timeoutMs', reader: 'src/a.ts', kind: 'not-read' },
  ]);
});

test('reports a reader that reads the same leaf under another section', () => {
  // Bug: `interfaces.drainMs` passes because the module reads `archive.drainMs`.
  const root = tree({
    'src/a.ts': 'const i = hot.config.interfaces;\nexport const ms = hot.config.archive?.drainMs;\n',
  });
  assert.deepEqual(checkReaders([entry('interfaces.drainMs', 'src/a.ts')], root), [
    { key: 'interfaces.drainMs', reader: 'src/a.ts', kind: 'not-read' },
  ]);
});

test('reports a reader module that does not exist', () => {
  const root = tree({ 'src/a.ts': 'export const ms = hot.config.llm.timeoutMs;\n' });
  assert.deepEqual(checkReaders([entry('llm.timeoutMs', 'src/gone.ts')], root), [
    { key: 'llm.timeoutMs', reader: 'src/gone.ts', kind: 'no-module' },
  ]);
});

// ---- the real tree -------------------------------------------------------------------------------------------------

test('every key of the schema names a reader module that reads it', () => {
  assert.deepEqual(checkReaders(CONFIG_SCHEMA, ROOT), []);
});

test('the settings schema knows the schedule of each of the two', () => {
  // Catches: `/config check` and the doctor warn about the key the family itself writes.
  const settings = {
    heartbeat: { schedule: 'every 3h' },
    diary: { schedule: 'at 09:00' },
  };
  assert.deepEqual(checkConfig(settings, CONFIG_SCHEMA), []);
});

test('the cap is documented as memoryDb.inspection.maxSnapshots and typed by the schema', () => {
  // Catches: the cap is a constant in the code, or /config check calls the owner's setting unknown.
  const inspection = { pageRows: 3, snapshotIdleSeconds: 7, snapshotMaxSeconds: 11, maxSnapshots: 4 };
  assert.deepEqual(checkConfig({ memoryDb: { inspection } }, CONFIG_SCHEMA), []);
  assert.notDeepEqual(
    checkConfig({ memoryDb: { inspection: { ...inspection, maxSnapshots: 'several' } } }, CONFIG_SCHEMA),
    []
  );
});
