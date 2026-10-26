// Tests for src/memory/text-limits.js: the memory limits' one home stays a leaf of the import graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every way a module loads another one: a static import (with bindings or bare), a dynamic
// import() and a re-export with a source (`export ... from`), which is an import edge too. The
// re-export pattern stops at a `;`, so a declaration followed by a comment that says "from" is
// not one.
const LOADS_A_MODULE = [/^\s*import\b/m, /\bimport\s*\(/, /^\s*export\b[^'";]*?\bfrom\s*['"]/m];

test('text-limits: a leaf module, it imports nothing and re-exports nothing', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'memory', 'text-limits.js'), 'utf8');
  for (const pattern of LOADS_A_MODULE) assert.equal(pattern.test(source), false, String(pattern));
});
