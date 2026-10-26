// Tests for tools/code-health.mjs: the size metrics of a source string, the comparison with a baseline, the
// judgement of waivers with an injected clock, the match of a path against the manifest, the import rule and the
// required-test rule. Only the exported pure functions are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareToBaseline,
  findImports,
  findOffenders,
  judgeWaivers,
  matchEntry,
  measureSource,
  checkStructure,
} from '../tools/code-health.mjs';
import { trackedEntries } from './fixtures/structure-manifest.ts';

const NOW = new Date('2026-10-26T12:00:00Z');

/**
 * A function named `name` whose text is exactly `total` lines long.
 * @param {string} name
 * @param {number} total
 */
function fnOfLines(name, total) {
  const filler = Array.from({ length: total - 2 }, (_, i) => `  const v${i} = ${i};`);
  return [`function ${name}() {`, ...filler, '}'].join('\n');
}

/**
 * A function nested `depth` levels of `if` deep.
 * @param {string} name
 * @param {number} depth
 */
function fnNested(name, depth) {
  const open = Array.from({ length: depth }, () => 'if (a) {').join('\n');
  const close = '}\n'.repeat(depth);
  return `function ${name}(a) {\n${open}\n  a++;\n${close}}\n`;
}

/**
 * A function with `branches` plain `if` statements, so complexity is branches + 1.
 * @param {string} name
 * @param {number} branches
 */
function fnBranches(name, branches) {
  const body = Array.from({ length: branches }, () => '  if (a) a++;').join('\n');
  return `function ${name}(a) {\n${body}\n}\n`;
}

/**
 * @param {ReturnType<typeof measureSource>} measure
 * @param {string} key
 */
function byKey(measure, key) {
  const found = measure.functions.find((f) => f.key === key);
  if (!found) throw new Error(`no function ${key}`);
  return found;
}

// ---- metrics ----

test('measureSource: an empty source has no lines and no functions', () => {
  const m = measureSource('', 'a.js');
  assert.equal(m.lines, 0);
  assert.deepEqual(m.functions, []);
});

test('measureSource: counts lines like wc -l, ignoring the final newline', () => {
  assert.equal(measureSource('a();\nb();\n', 'a.js').lines, 2);
  assert.equal(measureSource('a();\nb();', 'a.js').lines, 2);
});

test('findOffenders: a function of exactly 300 lines passes and one of 301 lines is reported', () => {
  assert.deepEqual(findOffenders(fnOfLines('big', 300), 'a.js', NOW).functions, {});
  assert.deepEqual(findOffenders(fnOfLines('big', 301), 'a.js', NOW).functions, { big: { 'function-length': 301 } });
});

test('findOffenders: a file of exactly 2000 lines passes and one of 2001 lines is reported', () => {
  /** @param {number} n */
  const file = (n) => Array.from({ length: n }, () => '// x').join('\n') + '\n';
  assert.equal(findOffenders(file(2000), 'a.js', NOW).lines, undefined);
  assert.equal(findOffenders(file(2001), 'a.js', NOW).lines, 2001);
});

test('findOffenders: the file limit of the manifest entry replaces the default', () => {
  const src = Array.from({ length: 11 }, () => '// x').join('\n') + '\n';
  assert.equal(findOffenders(src, 'a.js', NOW, { maxLines: 10 }).lines, 11);
  assert.equal(findOffenders(src, 'a.js', NOW, { maxLines: 11 }).lines, undefined);
});

test('findOffenders: nesting of 6 passes and nesting of 7 is reported', () => {
  assert.deepEqual(findOffenders(fnNested('deep', 6), 'a.js', NOW).functions, {});
  assert.deepEqual(findOffenders(fnNested('deep', 7), 'a.js', NOW).functions, { deep: { nesting: 7 } });
});

test('measureSource: an else-if chain adds no nesting and try with catch counts once', () => {
  const src =
    'function f(a) {\n if (a) { a++; } else if (a > 1) { a--; } else { a = 0; }\n try { a++; } catch { a--; }\n}\n';
  assert.equal(byKey(measureSource(src, 'a.js'), 'f').nesting, 1);
});

test('measureSource: a nested function starts its own nesting count', () => {
  const src = 'function outer(a) {\n if (a) {\n  const g = () => {\n   if (a) { a++; }\n  };\n }\n}\n';
  const m = measureSource(src, 'a.js');
  assert.equal(byKey(m, 'outer').nesting, 1);
  assert.equal(byKey(m, 'outer>g').nesting, 1);
});

test('findOffenders: complexity of 20 passes and complexity of 21 is reported', () => {
  assert.deepEqual(findOffenders(fnBranches('busy', 19), 'a.js', NOW).functions, {});
  assert.deepEqual(findOffenders(fnBranches('busy', 20), 'a.js', NOW).functions, { busy: { complexity: 21 } });
});

test('measureSource: complexity counts if, ternary, case, loops, catch, and, or and nullish', () => {
  const src = [
    'function f(a, b) {',
    '  if (a) {}', // 1
    '  const t = a ? 1 : 2;', // 2
    '  switch (a) { case 1: break; case 2: break; default: break; }', // 3, 4 (default is free)
    '  for (const x of b) {}', // 5
    '  while (a) { a = 0; }', // 6
    '  try { a(); } catch { a = 1; }', // 7
    '  return (a && b) || (a ?? b) || t;', // 8, 9, 10, 11
    '}',
  ].join('\n');
  assert.equal(byKey(measureSource(src, 'a.js'), 'f').complexity, 12);
});

test('measureSource: a nested function does not add to the complexity of its parent', () => {
  const src = 'function outer(a) {\n const g = () => { if (a) { a++; } if (a > 1) { a--; } };\n return g;\n}\n';
  const m = measureSource(src, 'a.js');
  assert.equal(byKey(m, 'outer').complexity, 1);
  assert.equal(byKey(m, 'outer>g').complexity, 3);
});

test('measureSource: names functions by declaration, variable, property, class member and enclosing function', () => {
  const src = [
    'export function declared() {}',
    'const arrow = () => {};',
    'const obj = { prop() {}, field: function () {} };',
    'class Box { constructor() {} method() {} get value() { return 1; } static make() {} }',
    'function outer() { [1].map(() => 1); function inner() {} }',
    '[1].forEach(() => 1);',
  ].join('\n');
  const keys = measureSource(src, 'a.js')
    .functions.map((f) => f.key)
    .sort();
  assert.deepEqual(keys, [
    '<anonymous>',
    'Box.constructor',
    'Box.make',
    'Box.method',
    'Box.value',
    'arrow',
    'declared',
    'obj.field',
    'obj.prop',
    'outer',
    'outer><anonymous>',
    'outer>inner',
  ]);
});

test('measureSource: two anonymous functions in one parent get distinct stable keys', () => {
  const src = 'function f() { [1].map(() => 1); [2].map(() => 2); }\n';
  const keys = measureSource(src, 'a.js').functions.map((f) => f.key);
  assert.deepEqual(keys, ['f', 'f><anonymous>', 'f><anonymous>#2']);
});

test('measureSource: the key of a function does not move when code above it is added', () => {
  const small = fnBranches('busy', 20);
  const shifted = '// a\n// b\nconst z = 1;\n' + small;
  assert.deepEqual(findOffenders(small, 'a.js', NOW).functions, findOffenders(shifted, 'a.js', NOW).functions);
});

test('measureSource: parses TypeScript syntax in a .ts file', () => {
  const src = 'export function f(a: number): number {\n  if (a > 1) return a;\n  return 1;\n}\n';
  assert.equal(byKey(measureSource(src, 'a.ts'), 'f').complexity, 2);
});

// ---- waivers ----

/**
 * @param {string} rule
 * @param {string} [tail]
 */
const waived = (rule, tail = 'until 2026-12-01 -- one switch over every wake kind') =>
  `// health: allow ${rule} ${tail}\n`;

test('findOffenders: a valid waiver directly above a function exempts that one rule only', () => {
  const src = waived('complexity') + fnBranches('busy', 25).replace('function busy', 'function busy');
  const result = findOffenders(src, 'a.js', NOW);
  assert.deepEqual(result.functions, {});
  assert.deepEqual(result.problems, []);
  const other = waived('nesting') + fnBranches('busy', 25);
  assert.deepEqual(findOffenders(other, 'a.js', NOW).functions, { busy: { complexity: 26 } });
});

test('findOffenders: a waiver above an exported const arrow function reaches the function', () => {
  const body = Array.from({ length: 25 }, () => '  if (a) a++;').join('\n');
  const src = waived('complexity') + `export const busy = (a) => {\n${body}\n};\n`;
  const result = findOffenders(src, 'a.js', NOW);
  assert.deepEqual(result.functions, {});
  assert.deepEqual(result.problems, []);
});

test('findOffenders: a file-length waiver at the top of the file exempts the file', () => {
  const lines = Array.from({ length: 2100 }, () => '// x').join('\n');
  const src = waived('file-length') + lines + '\n';
  const result = findOffenders(src, 'a.js', NOW);
  assert.equal(result.lines, undefined);
  assert.deepEqual(result.problems, []);
});

test('judgeWaivers: a waiver past its date is a problem at its line', () => {
  const src = 'const a = 1;\n' + waived('complexity', 'until 2026-10-25 -- old reason') + 'function f() {}\n';
  const { problems } = judgeWaivers(src, NOW);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 2);
});

test('judgeWaivers: a waiver is still valid on its last day', () => {
  const src = waived('complexity', 'until 2026-10-26 -- last day') + 'function f() {}\n';
  assert.deepEqual(judgeWaivers(src, NOW).problems, []);
});

test('judgeWaivers: a date 180 days ahead passes and 181 days ahead is a problem', () => {
  const ok = waived('complexity', 'until 2027-04-24 -- reason') + 'function f() {}\n';
  const far = waived('complexity', 'until 2027-04-25 -- reason') + 'function f() {}\n';
  assert.deepEqual(judgeWaivers(ok, NOW).problems, []);
  assert.equal(judgeWaivers(far, NOW).problems.length, 1);
});

test('judgeWaivers: a waiver without a date, with an unknown rule or without a reason is a problem', () => {
  for (const line of [
    '// health: allow complexity -- why',
    '// health: allow speed until 2026-12-01 -- why',
    '// health: allow complexity until 2026-12-01',
    '// health: allow complexity until 2026-12-01 --',
    '// health: allow complexity until soon -- why',
    '// health: allow complexity until 2026-02-31 -- why',
    '// health: allow',
  ]) {
    const { problems } = judgeWaivers(line + '\nfunction f() {}\n', NOW);
    assert.equal(problems.length, 1, line);
    assert.equal(problems[0].line, 1, line);
  }
});

test('findOffenders: a waiver that sits above no function is a problem', () => {
  const src = waived('complexity') + 'const a = 1;\nfunction f() {}\n';
  assert.equal(findOffenders(src, 'a.js', NOW).problems.length, 1);
});

test('findOffenders: a file-length waiver below the first statement is a problem', () => {
  const src = 'const a = 1;\n' + waived('file-length') + 'function f() {}\n';
  assert.equal(findOffenders(src, 'a.js', NOW).problems.length, 1);
});

test('judgeWaivers: ordinary comments and a source with no waiver give no problem', () => {
  assert.deepEqual(judgeWaivers('// a note about health\nfunction f() {}\n', NOW).problems, []);
  assert.deepEqual(judgeWaivers('', NOW).problems, []);
});

// ---- baseline comparison ----

const emptyBaseline = { files: {}, functions: {}, structure: { imports: {}, tests: [] } };

test('compareToBaseline: equal baselines give neither growth nor shrinkage', () => {
  const b = { ...emptyBaseline, files: { 'src/a.js': 2100 }, functions: { 'src/a.js': { f: { complexity: 25 } } } };
  assert.deepEqual(compareToBaseline(b, structuredClone(b)), { grew: [], shrank: [] });
});

test('compareToBaseline: a recorded value that grows and a new offender are growth', () => {
  const base = { ...emptyBaseline, functions: { 'src/a.js': { f: { complexity: 25 } } } };
  const cur = {
    ...emptyBaseline,
    functions: { 'src/a.js': { f: { complexity: 26 }, g: { nesting: 7 } } },
  };
  const { grew, shrank } = compareToBaseline(base, cur);
  assert.equal(grew.length, 2);
  assert.deepEqual(shrank, []);
});

test('compareToBaseline: a smaller value and a vanished offender are shrinkage', () => {
  const base = {
    ...emptyBaseline,
    files: { 'src/a.js': 2100 },
    functions: { 'src/a.js': { f: { complexity: 25, nesting: 8 } } },
  };
  const cur = { ...emptyBaseline, functions: { 'src/a.js': { f: { complexity: 22 } } } };
  const { grew, shrank } = compareToBaseline(base, cur);
  assert.deepEqual(grew, []);
  assert.equal(shrank.length, 3);
});

test('compareToBaseline: a new file over the limit is growth', () => {
  const cur = { ...emptyBaseline, files: { 'src/new.js': 2001 } };
  assert.equal(compareToBaseline(emptyBaseline, cur).grew.length, 1);
});

test('compareToBaseline: a new structure breach is growth and a fixed one is shrinkage', () => {
  const withBreach = { ...emptyBaseline, structure: { imports: { 'src/a.js': ['discord.js'] }, tests: [] } };
  assert.equal(compareToBaseline(emptyBaseline, withBreach).grew.length, 1);
  assert.equal(compareToBaseline(withBreach, emptyBaseline).shrank.length, 1);
  const missing = { ...emptyBaseline, structure: { imports: {}, tests: ['src/a.js'] } };
  assert.equal(compareToBaseline(emptyBaseline, missing).grew.length, 1);
});

test('compareToBaseline: empty baseline against empty current is clean', () => {
  assert.deepEqual(compareToBaseline(emptyBaseline, emptyBaseline), { grew: [], shrank: [] });
});

// ---- the manifest ----

const entries = [
  { path: 'src/', layer: 'public', purpose: 'p', imports: ['node:*'], test: 'none' },
  { path: 'src/memory/', layer: 'public', purpose: 'p', imports: ['node:*'], test: 'required' },
  { path: 'src/*.js', layer: 'public', purpose: 'p', imports: ['node:*'], test: 'none' },
  { path: 'data/', layer: 'local', purpose: 'p', imports: [], test: 'none' },
  { path: 'package.json', layer: 'public', purpose: 'p', imports: [], test: 'none' },
];

test('matchEntry: the most specific entry wins over a containing folder', () => {
  assert.equal(matchEntry(entries, 'src/memory/store.js')?.path, 'src/memory/');
  assert.equal(matchEntry(entries, 'src/llm/call.js')?.path, 'src/');
  assert.equal(matchEntry(entries, 'src/config.js')?.path, 'src/*.js');
});

test('matchEntry: an exact file path matches only that file', () => {
  assert.equal(matchEntry(entries, 'package.json')?.path, 'package.json');
  assert.equal(matchEntry(entries, 'package-lock.json'), undefined);
});

test('matchEntry: a path no entry covers gives undefined', () => {
  assert.equal(matchEntry(entries, 'elsewhere/file.js'), undefined);
});

// ---- imports ----

test('findImports: resolves relative specifiers to repository paths and bare ones to package names', () => {
  const src = [
    "import fs from 'node:fs';",
    "import path from 'path';",
    "import { Client } from 'discord.js';",
    "import { x } from '@scope/pkg/deep/file.js';",
    "import { a } from './a.js';",
    "import { b } from '../llm/b.js';",
    "export { c } from './c.js';",
    "const d = await import('./d.js');",
    "const e = await import('undici');",
  ].join('\n');
  assert.deepEqual(findImports(src, 'src/memory/store.js'), [
    '@scope/pkg',
    'discord.js',
    'node:fs',
    'node:path',
    'src/llm/b.js',
    'src/memory/a.js',
    'src/memory/c.js',
    'src/memory/d.js',
    'undici',
  ]);
});

test('findImports: a dynamic import with a computed specifier is not an import', () => {
  assert.deepEqual(findImports('const m = await import(name);\n', 'src/a.js'), []);
});

test('findImports: an empty source has no imports', () => {
  assert.deepEqual(findImports('', 'src/a.js'), []);
});

// ---- structure check ----

const file = (source = '') => ({ source });

test('checkStructure: reports a tracked file that matches no entry and a tracked file in the local layer', () => {
  const files = { 'stray/x.js': file(), 'data/memory.db': file(), 'src/config.js': file() };
  const result = checkStructure(entries, files);
  assert.deepEqual(result.unmatched, ['stray/x.js']);
  assert.deepEqual(result.local, ['data/memory.db']);
});

test('checkStructure: reports an import that no pattern of the entry allows', () => {
  const files = {
    'src/memory/store.js': file("import fs from 'node:fs';\nimport x from 'discord.js';\nimport y from './y.js';"),
    'src/memory/y.js': file(),
  };
  assert.deepEqual(checkStructure(entries, files).imports, { 'src/memory/store.js': ['discord.js'] });
});

test('checkStructure: an import is allowed by a path pattern of the entry', () => {
  const withRule = [
    {
      path: 'interfaces/',
      layer: 'public',
      purpose: 'p',
      imports: ['node:*', 'discord.js', 'src/protocol/**'],
      test: 'none',
    },
    ...entries,
  ];
  const files = {
    'interfaces/d/index.js': file("import { E } from '../../src/protocol/events.js';\nimport { C } from 'discord.js';"),
  };
  assert.deepEqual(checkStructure(withRule, files).imports, {});
  const bad = { 'interfaces/d/index.js': file("import { h } from '../../src/hot.js';") };
  assert.deepEqual(checkStructure(withRule, bad).imports, { 'interfaces/d/index.js': ['src/hot.js'] });
});

test('checkStructure: reports a module of a required-test entry that has no test file', () => {
  const files = {
    'src/memory/store.js': file(),
    'src/memory/lore.js': file(),
    'src/memory/notes.md': file(),
    'tests/lore.test.js': file(),
  };
  assert.deepEqual(checkStructure(entries, files).missingTests, ['src/memory/store.js']);
});

test('checkStructure: a test named with a tail of the folder path counts', () => {
  const files = { 'src/memory/db/open.js': file(), 'tests/memory-db-open.test.js': file() };
  const nested = [{ path: 'src/memory/db/', layer: 'public', purpose: 'p', imports: [], test: 'required' }];
  assert.deepEqual(checkStructure(nested, files).missingTests, []);
});

test('checkStructure: a clean tree reports nothing', () => {
  const result = checkStructure(entries, { 'src/config.js': file("import fs from 'node:fs';") });
  assert.deepEqual(result, { unmatched: [], local: [], imports: {}, missingTests: [] });
});

test('checkStructure: an empty tree reports nothing', () => {
  assert.deepEqual(checkStructure(entries, {}), { unmatched: [], local: [], imports: {}, missingTests: [] });
});

// ---- the entry and the core import no Discord (the tracked structure.json) ----

const tracked = trackedEntries();

const DISCORD_IMPORTS = [
  "import { Client } from 'discord.js';",
  "import { start } from '../interfaces/discord/index.js';",
  "import { createInteractionHandler } from './interface/discord.js';",
].join('\n');

for (const name of ['src/index.js', 'src/core.js']) {
  test(`structure.json: ${name} importing discord.js, interfaces/ or src/interface/discord.js is a breach of each`, () => {
    const result = checkStructure(tracked, { [name]: file(DISCORD_IMPORTS) });
    assert.deepEqual(result.imports[name], ['discord.js', 'interfaces/discord/index.js', 'src/interface/discord.js']);
  });
}

test('structure.json: src/core.js may import the door, the link and the protocol', () => {
  const source = [
    "import { createEventDoor } from './interface/door.js';",
    "import { openAdapterLink } from './interface/link.ts';",
    "import { connectSocket } from './protocol/wire.ts';",
    "import { createHot } from './hot.js';",
  ].join('\n');
  assert.deepEqual(checkStructure(tracked, { 'src/core.js': file(source) }).imports, {});
});
