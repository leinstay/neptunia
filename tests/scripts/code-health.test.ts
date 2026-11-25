// Tests for scripts/code-health.ts: the size metrics of a source string, the comparison with a baseline, the
// judgement of waivers with an injected clock, the match of a path against the manifest, the import rule and the
// required-test rule, and the property-chain check: `countChains` counts, per source, the chains of four or more
// segments and the names repeated in a row, and `compareToBaseline` ratchets those counts like the other facts. A chain
// counts its root identifier as a segment, so `a.b.c` has three segments. Only the exported pure functions are used.
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
  countChains,
  testPathFor,
} from '../../scripts/code-health.ts';
import { trackedEntries } from '../fixtures/structure-manifest.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const NOW = new Date('2026-10-26T12:00:00Z');

/**
 * A function named `name` whose text is exactly `total` lines long.
 */
function fnOfLines(name: string, total: number) {
  const filler = Array.from({ length: total - 2 }, (_, i) => `  const v${i} = ${i};`);
  return [`function ${name}() {`, ...filler, '}'].join('\n');
}

/**
 * A function nested `depth` levels of `if` deep.
 */
function fnNested(name: string, depth: number) {
  const open = Array.from({ length: depth }, () => 'if (a) {').join('\n');
  const close = '}\n'.repeat(depth);
  return `function ${name}(a) {\n${open}\n  a++;\n${close}}\n`;
}

/**
 * A function with `branches` plain `if` statements, so complexity is branches + 1.
 */
function fnBranches(name: string, branches: number) {
  const body = Array.from({ length: branches }, () => '  if (a) a++;').join('\n');
  return `function ${name}(a) {\n${body}\n}\n`;
}

function byKey(measure: ReturnType<typeof measureSource>, key: string) {
  const found = measure.functions.find((f) => f.key === key);
  if (!found) throw new Error(`no function ${key}`);
  return found;
}

// ---- metrics ----

test('measureSource: an empty source has no functions', () => {
  assert.deepEqual(measureSource('', 'a.js').functions, []);
});

test('findOffenders: a function of exactly 300 lines passes and one of 301 lines is reported', () => {
  assert.deepEqual(findOffenders(fnOfLines('big', 300), 'a.js', NOW).functions, {});
  assert.deepEqual(findOffenders(fnOfLines('big', 301), 'a.js', NOW).functions, { big: { 'function-length': 301 } });
});

test('findOffenders: a file of any length is no offender', () => {
  const src = Array.from({ length: 20_000 }, () => '// x').join('\n') + '\n';
  assert.deepEqual(findOffenders(src, 'a.js', NOW), { functions: {}, problems: [] });
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

const waived = (rule: Untyped, tail = 'until 2026-12-01 -- one switch over every wake kind') =>
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
    '// health: allow file-length until 2026-12-01 -- why',
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

test('judgeWaivers: ordinary comments and a source with no waiver give no problem', () => {
  assert.deepEqual(judgeWaivers('// a note about health\nfunction f() {}\n', NOW).problems, []);
  assert.deepEqual(judgeWaivers('', NOW).problems, []);
});

// ---- baseline comparison ----

// The property-chain tests below cover `chains`. The baseline shape needs the field.
const emptyBaseline = { functions: {}, chains: {}, structure: { imports: {}, tests: [] } };

test('compareToBaseline: equal baselines give neither growth nor shrinkage', () => {
  const b = { ...emptyBaseline, functions: { 'src/a.js': { f: { complexity: 25 } } } };
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
    functions: { 'src/a.js': { f: { complexity: 25, nesting: 8 } } },
  };
  const cur = { ...emptyBaseline, functions: { 'src/a.js': { f: { complexity: 22 } } } };
  const { grew, shrank } = compareToBaseline(base, cur);
  assert.deepEqual(grew, []);
  // Two facts shrink, the complexity and the nesting. The base holds no file length, since no file has a line limit.
  assert.equal(shrank.length, 2);
});

test('compareToBaseline: a new structure breach is growth and a fixed one is shrinkage', () => {
  const withBreach = {
    ...emptyBaseline,
    structure: { imports: { 'src/a.js': ['discord.js'] }, tests: [] },
  };
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
  assert.equal(matchEntry(entries, 'src/memory/store.ts')?.path, 'src/memory/');
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
  assert.deepEqual(findImports(src, 'src/memory/store.ts'), [
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
  const files = { 'stray/x.js': file(), 'data/memory.db': file(), 'src/config.ts': file() };
  const result = checkStructure(entries, files);
  assert.deepEqual(result.unmatched, ['stray/x.js']);
  assert.deepEqual(result.local, ['data/memory.db']);
});

test('checkStructure: reports an import that no pattern of the entry allows', () => {
  const files = {
    'src/memory/store.ts': file("import fs from 'node:fs';\nimport x from 'discord.js';\nimport y from './y.js';"),
    'src/memory/y.js': file(),
  };
  assert.deepEqual(checkStructure(entries, files).imports, { 'src/memory/store.ts': ['discord.js'] });
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
    'src/memory/store.ts': file(),
    'src/memory/lore.ts': file(),
    'src/memory/notes.md': file(),
    'tests/src/memory/lore.test.ts': file(),
  };
  assert.deepEqual(checkStructure(entries, files).missingTests, ['src/memory/store.ts']);
});

test('testPathFor: a module maps to its repository path under tests/ with .test before the extension', () => {
  assert.equal(testPathFor('src/memory/db/open.ts'), 'tests/src/memory/db/open.test.ts');
  assert.equal(testPathFor('interfaces/cli/index.ts'), 'tests/interfaces/cli/index.test.ts');
  assert.equal(testPathFor('scripts/code-health.ts'), 'tests/scripts/code-health.test.ts');
});

test('checkStructure: a test file at the path of an existing module is on its path', () => {
  const files = { 'src/memory/db/open.ts': file(), 'tests/src/memory/db/open.test.ts': file() };
  assert.deepEqual(checkStructure(entries, files).offPathTests, []);
});

test('checkStructure: reports a test file whose path maps to no existing module', () => {
  const files = { 'src/a.ts': file(), 'tests/src/b.test.ts': file(), 'tests/db-open.test.ts': file() };
  assert.deepEqual(checkStructure(entries, files).offPathTests, ['tests/db-open.test.ts', 'tests/src/b.test.ts']);
});

test('checkStructure: reports a test file of a module whose extension differs from the module', () => {
  const files = { 'src/a.ts': file(), 'tests/src/a.test.js': file() };
  assert.deepEqual(checkStructure(entries, files).offPathTests, ['tests/src/a.test.js']);
});

test('checkStructure: reports a module with a second test file', () => {
  const files = { 'src/a.ts': file(), 'tests/src/a.test.ts': file(), 'tests/src/a.test.mjs': file() };
  assert.deepEqual(checkStructure(entries, files).duplicateTests, {
    'src/a.ts': ['tests/src/a.test.mjs', 'tests/src/a.test.ts'],
  });
});

test('checkStructure: reports a fixture that imports a function of node:test that registers a case', () => {
  const files = {
    'tests/fixtures/named.ts': file("import { after, test } from 'node:test';"),
    'tests/fixtures/default.ts': file("import test from 'node:test';"),
    'tests/fixtures/whole.ts': file("import * as nt from 'node:test';"),
    'tests/fixtures/suite.ts': file("import { describe as group } from 'node:test';"),
    'tests/fixtures/hooks.ts': file("import { after, afterEach, before, beforeEach, mock } from 'node:test';"),
  };
  assert.deepEqual(checkStructure(entries, files).fixtureTests, [
    'tests/fixtures/default.ts',
    'tests/fixtures/named.ts',
    'tests/fixtures/suite.ts',
    'tests/fixtures/whole.ts',
  ]);
});

test('checkStructure: a required module counts as tested by its test file on the path', () => {
  const files = {
    'src/memory/db/open.ts': file(),
    'src/memory/lore.ts': file(),
    'tests/src/memory/lore.test.ts': file(),
  };
  assert.deepEqual(checkStructure(entries, files).missingTests, ['src/memory/db/open.ts']);
});

test('checkStructure: a test file on the path of another module does not count for a module of the same name', () => {
  const files = { 'src/memory/open.ts': file(), 'src/turn/open.ts': file(), 'tests/src/turn/open.test.ts': file() };
  assert.deepEqual(checkStructure(entries, files).missingTests, ['src/memory/open.ts']);
});

test('checkStructure: a test file under the flat name of a module does not count for it', () => {
  const files = { 'src/memory/lore.ts': file(), 'tests/lore.test.ts': file(), 'tests/memory-lore.test.ts': file() };
  const result = checkStructure(entries, files);
  assert.deepEqual(result.missingTests, ['src/memory/lore.ts']);
  assert.deepEqual(result.offPathTests, ['tests/lore.test.ts', 'tests/memory-lore.test.ts']);
});

// The empty result lists every kind of finding, so a new kind of finding extends it.
const nothing = {
  unmatched: [],
  local: [],
  imports: {},
  missingTests: [],
  offPathTests: [],
  duplicateTests: {},
  fixtureTests: [],
};

test('checkStructure: a clean tree reports nothing', () => {
  const result = checkStructure(entries, { 'src/config.ts': file("import fs from 'node:fs';") });
  assert.deepEqual(result, nothing);
});

test('checkStructure: an empty tree reports nothing', () => {
  assert.deepEqual(checkStructure(entries, {}), nothing);
});

// ---- the entry and the core import no Discord (the tracked scripts/config/structure.json) ----

const tracked = trackedEntries();

const DISCORD_IMPORTS = [
  "import { Client } from 'discord.js';",
  "import { start } from '../interfaces/discord/index.js';",
  "import { createInteractionHandler } from './interface/discord.js';",
].join('\n');

for (const name of ['src/index.ts', 'src/core.ts']) {
  test(`structure.json: ${name} importing discord.js, interfaces/ or src/interface/discord.js is a breach of each`, () => {
    const result = checkStructure(tracked, { [name]: file(DISCORD_IMPORTS) });
    assert.deepEqual(result.imports[name], ['discord.js', 'interfaces/discord/index.js', 'src/interface/discord.js']);
  });
}

test('structure.json: src/core.ts may import the door, the link and the protocol', () => {
  const source = [
    "import { createEventDoor } from './interface/door.ts';",
    "import { openAdapterLink } from './interface/link.ts';",
    "import { connectSocket } from './protocol/wire.ts';",
    "import { createHot } from './hot.ts';",
  ].join('\n');
  assert.deepEqual(checkStructure(tracked, { 'src/core.ts': file(source) }).imports, {});
});

// ---- the property-chain check ----

const count = (source: string) => countChains(source, 'a.ts');

test('countChains: a chain of three segments passes and chains of four and five are counted once each', () => {
  assert.deepEqual(count('const v = a.b.c;'), { deep: 0, repeated: 0 });
  assert.deepEqual(count('const v = a.b.c.d;'), { deep: 1, repeated: 0 });
  assert.deepEqual(count('const v = a.b.c.d.e;'), { deep: 1, repeated: 0 });
});

test('countChains: a longer chain is one chain, not one per prefix', () => {
  assert.equal(count('const v = a.b.c.d.e.f.g;').deep, 1);
});

test('countChains: two separate chains in a source are counted separately', () => {
  assert.equal(count('const v = a.b.c.d;\nconst w = e.f.g.h.i;').deep, 2);
});

test('countChains: optional chaining counts like a plain dot', () => {
  assert.equal(count('const v = a?.b?.c?.d;').deep, 1);
  assert.equal(count('const v = a?.b?.c;').deep, 0);
});

test('countChains: a call between segments ends the chain', () => {
  assert.equal(count('const v = a.b().c.d;').deep, 0);
  assert.equal(count('const v = a.b.c().d.e.f;').deep, 0);
  assert.equal(count('const v = a.b.c.d().e.f.g;').deep, 1);
  assert.equal(count('const v = a.b.c.d().e.f.g.h;').deep, 2);
});

test('countChains: a chain under hot.config is exempt at any depth', () => {
  assert.deepEqual(count('const v = hot.config.llm.limits.perDay;'), { deep: 0, repeated: 0 });
  assert.equal(count('const v = hot.prompts.a.b.c;').deep, 1);
});

test('countChains: a chain that starts at process is exempt', () => {
  assert.equal(count('const v = process.env.A.b.c;').deep, 0);
});

test('countChains: a name repeated in a row is counted apart from depth', () => {
  assert.deepEqual(count('const v = extra.extra;'), { deep: 0, repeated: 1 });
  assert.deepEqual(count('const v = scope.scope.scope_kind;'), { deep: 0, repeated: 1 });
  assert.deepEqual(count('const v = a.extra.extra.b.c;'), { deep: 1, repeated: 1 });
});

test('countChains: the same name apart in a chain is not a repeat', () => {
  assert.deepEqual(count('const v = scope.kind.scope;'), { deep: 0, repeated: 0 });
});

test('countChains: strings, template text, comments and import paths are not chains', () => {
  const src = [
    "import x from './a.b.c.d.e.js';",
    "const s = 'a.b.c.d.e';",
    'const t = `a.b.c.d.e ${n}`;',
    '// a.b.c.d.e',
    '/* a.b.c.d.e */',
    'const n = 1.5e3;',
  ].join('\n');
  assert.deepEqual(count(src), { deep: 0, repeated: 0 });
});

test('countChains: a chain inside a template expression is counted', () => {
  assert.equal(count('const t = `${a.b.c.d}`;').deep, 1);
});

test('countChains: an empty source has no chains', () => {
  assert.deepEqual(count(''), { deep: 0, repeated: 0 });
});

test('countChains: parses a .js file as well as a .ts file', () => {
  assert.equal(countChains('const v = a.b.c.d;', 'a.js').deep, 1);
});

// ---- baseline ----

test('compareToBaseline: a chain count above the recorded one is growth and a new file with chains is growth', () => {
  const base = { ...emptyBaseline, chains: { 'src/a.ts': { deep: 3, repeated: 1 } } };
  const more = { ...emptyBaseline, chains: { 'src/a.ts': { deep: 4, repeated: 1 } } };
  assert.equal(compareToBaseline(base, more).grew.length, 1);
  const fresh = { ...base, chains: { ...base.chains, 'src/b.ts': { deep: 1, repeated: 0 } } };
  assert.equal(compareToBaseline(base, fresh).grew.length, 1);
});

test('compareToBaseline: a smaller chain count is shrinkage and an equal one is clean', () => {
  const base = { ...emptyBaseline, chains: { 'src/a.ts': { deep: 3, repeated: 2 } } };
  const less = { ...emptyBaseline, chains: { 'src/a.ts': { deep: 1, repeated: 2 } } };
  const { grew, shrank } = compareToBaseline(base, less);
  assert.deepEqual(grew, []);
  assert.equal(shrank.length, 1);
  assert.deepEqual(compareToBaseline(base, structuredClone(base)), { grew: [], shrank: [] });
});

test('compareToBaseline: a file whose chains are all rewritten is shrinkage per kind', () => {
  const base = { ...emptyBaseline, chains: { 'src/a.ts': { deep: 3, repeated: 2 } } };
  assert.equal(compareToBaseline(base, emptyBaseline).shrank.length, 2);
});

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const ACTIVE_ROOTS = ['src', 'bin', 'interfaces', 'agents'];

/** A pair of sibling names the gate refuses: any of `top` beside any of `chat`. */
type Pair = { top: ReadonlyArray<string>; chat: ReadonlyArray<string> };

const TOP_BESIDE_CHAT: Pair = { top: ['placeId', 'rootId'], chat: ['chatId'] };

const CHAT_WITH_ITS_TOP: Pair = { top: ['rootId'], chat: ['id'] };

const BOUNDARY = [
  // The chat as the wire carries it from the interfaces.
  'src/protocol/events.ts#Chat',
  'src/interface/neptunia-cli.ts#CommandEvent',
  // Where a native chat becomes a place.
  'src/memory/addresses.ts',
  'src/memory/store-addresses.ts',
  'src/memory/db/observe-event.ts',
  // A member's voice state as the wire carries it: the root and the native voice chats (plan T.4).
  'src/protocol/events.ts#VoiceChanged',
  // A mirror row maps one place to its own native chat, the one its posts go to (plan T.4).
  'src/memory/db/mirror-config.ts#MirrorRow',
  // A diary place maps one place to its own native chat (plan T.4).
  'src/memory/db/mirrors.ts#DiaryPlace',
];

const exemptFile = (file: string): boolean =>
  file.startsWith('interfaces/') || file.startsWith('src/memory/migration/') || BOUNDARY.includes(file);

function walk(dir: string, found: Array<string> = []): Array<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) found.push(relative(ROOT, full).split('\\').join('/'));
  }
  return found;
}

const nameText = (name: ts.Node | undefined): string | null =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;

/** The sibling names a node declares, when it is a shape the gate looks at; null otherwise. */
function siblingNames(node: ts.Node): Array<string> | null {
  const named = (names: Array<string | null>): Array<string> => names.filter((name) => name !== null);
  if (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node))
    return named(node.members.map((member) => nameText(member.name)));
  if (ts.isObjectBindingPattern(node))
    return named(node.elements.map((element) => nameText(element.propertyName ?? element.name)));
  if (ts.isFunctionLike(node)) return named(node.parameters.map((parameter) => nameText(parameter.name)));
  return null;
}

/** The named type alias or interface a shape is declared in, at any depth; null outside one. */
function declaredName(node: ts.Node): string | null {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (ts.isInterfaceDeclaration(at) || ts.isTypeAliasDeclaration(at)) return at.name.text;
  }
  return null;
}

const holds = (names: ReadonlyArray<string>, pair: Pair): boolean =>
  pair.top.some((name) => names.includes(name)) && pair.chat.some((name) => names.includes(name));

/** Every shape of a source text that holds the pair, as `file:line Kind`, with the entries of BOUNDARY left out. */
function shapesIn(file: string, text: string, pair: Pair, boundary: ReadonlyArray<string> = BOUNDARY): Array<string> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Array<string> = [];
  const visit = (node: ts.Node): void => {
    const names = siblingNames(node);
    const declared = declaredName(node);
    if (names && holds(names, pair) && !(declared && boundary.includes(`${file}#${declared}`))) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${file}:${line + 1} ${ts.SyntaxKind[node.kind]}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function shapesInTree(pair: Pair): Array<string> {
  const out: Array<string> = [];
  for (const root of ACTIVE_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (exemptFile(file)) continue;
      out.push(...shapesIn(file, readFileSync(join(ROOT, file), 'utf8'), pair));
    }
  }
  return out;
}

test('the scan sees a top beside a chat in each kind of shape, and only as siblings', () => {
  // Bug: the gate goes green because its parser stopped seeing a kind of shape, not because the shapes are gone.
  const probe = [
    'type A = { placeId: string; chatId: string };',
    'interface B { placeId?: string | null; chatId: string }',
    'function c({ placeId, chatId }: Record<string, string>) {}',
    'const d = (placeId: string, chatId: string) => 0;',
    'type E = { rootId: string; chatId: string };',
    'type F = { placeId: string; inner: { chatId: string } };',
  ].join('\n');
  const lines = shapesIn('probe.ts', probe, TOP_BESIDE_CHAT).map((hit) => Number(/:(\d+) /.exec(hit)?.[1]));
  assert.deepEqual([...new Set(lines)], [1, 2, 3, 4, 5]);
});

test('a boundary entry of one type exempts that type and no other in its file', () => {
  // Bug: `file#Type` exempts the whole file, and a new shape beside the protocol's chat type passes unseen.
  const probe = 'type Wire = { id: string; rootId: string };\ntype Core = { id: string; rootId: string };';
  const hits = shapesIn('p.ts', probe, CHAT_WITH_ITS_TOP, ['p.ts#Wire']);
  assert.deepEqual(hits, ['p.ts:2 TypeLiteral']);
});

test('no core type or signature carries a top place beside a chat id', () => {
  // Bug: a shape keeps the top place and the channel side by side, a caller fills one from another turn, and the lore,
  // the notes or the GIFs of one server are written or read under another.
  const shapes = shapesInTree(TOP_BESIDE_CHAT);
  assert.deepEqual(shapes, [], `${shapes.length} shapes:\n${shapes.join('\n')}`);
});

test('no core chat carries the native id of its top', () => {
  // Bug: a native `{ id, rootId }` travels through the turn past the protocol, and code reads the server from `rootId`
  // instead of asking `rootPlaceOf`, so a thread or a DM answers with a top the store does not hold.
  const shapes = shapesInTree(CHAT_WITH_ITS_TOP);
  assert.deepEqual(shapes, [], `${shapes.length} shapes:\n${shapes.join('\n')}`);
});

test('every boundary entry names a file that exists and still holds a shape', () => {
  // Bug: a boundary file is cleaned or moved and its exemption stays, so a new shape there passes unseen.
  const idle = BOUNDARY.filter((entry) => {
    const [file] = entry.split('#');
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      return true;
    }
    const others = BOUNDARY.filter((other) => other !== entry);
    return [TOP_BESIDE_CHAT, CHAT_WITH_ITS_TOP].every((pair) => shapesIn(file, text, pair, others).length === 0);
  });
  assert.deepEqual(idle, [], `idle entries:\n${idle.join('\n')}`);
});
