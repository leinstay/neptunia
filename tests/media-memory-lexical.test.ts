// The owner's word: a line's media is a table with named columns, never JSON inside a source row's `extra`. This reads the
// code, on purpose: a path under `extra` is invisible to a behaviour test until a row carries it. `attachmentIds` of a
// publication's delivery (src/memory/db/publication-delivery.ts, src/behavior/mirror.ts) is another thing, on no source row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function codeFiles(dir: string): Array<string> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : codeFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const FILES = ['src', 'interfaces', 'scripts'].flatMap((dir) => codeFiles(path.join(ROOT, dir)));
/** Lines of the code that match, each with its file. The migration names the old path once, to empty it. */
function matches(pattern: RegExp): Array<string> {
  return FILES.filter((file) => path.basename(file) !== 'source-media.ts').flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => (pattern.test(line) ? [`${path.relative(ROOT, file)}:${i + 1}`] : []))
  );
}

test('no code reads or writes attachmentIds under extra', () => {
  assert.deepEqual(
    matches(/extra[?.\s:{"'$]*\.?\??\s*\{?\s*attachmentIds|\$\.extra\.attachmentIds|sourceAttachmentIds/),
    []
  );
});

test("no code nests an extra inside a source row's extra", () => {
  assert.deepEqual(matches(/\bextra\??\.extra\b|\$\.extra\.[a-zA-Z]/), []);
});

test("no code reads a source row's media kinds from a column of sources", () => {
  assert.deepEqual(matches(/\bs\.media\b|\bsources\b[^;]*\bSET media\b|parseJson\(row\.media\)/), []);
});
