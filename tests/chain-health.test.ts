// Tests for the property-chain check of scripts/code-health.ts: `countChains` counts, per source, the chains of four
// or more segments and the names repeated in a row, and `compareToBaseline` ratchets those counts like the other
// facts. A chain counts its root identifier as a segment, so `a.b.c` has three segments.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareToBaseline, countChains } from '../scripts/code-health.ts';

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

const emptyBaseline = { files: {}, functions: {}, chains: {}, structure: { imports: {}, tests: [] } };

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
