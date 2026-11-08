// The owner's word: `media` is the only store of media and one read serves every path. This reads the code, on purpose: a path
// under `extra` or a second read of `media` is invisible to a behaviour test until a row carries it. `attachmentIds` of a
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
/** The modules of the one store: the migration names the old paths once, to empty them. */
const STORE = new Set(['media-store.ts', 'media-backfill.ts']);
const linesMatching = (pattern: RegExp, files: ReadonlyArray<string> = FILES): Array<string> =>
  files
    .filter((file) => !STORE.has(path.basename(file)))
    .flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (pattern.test(line) ? [`${path.relative(ROOT, file)}:${i + 1}`] : []))
    );

test('no code reads or writes attachmentIds under extra', () => {
  const pattern = /extra[?.\s:{"'$]*\.?\??\s*\{?\s*attachmentIds|\$\.extra\.attachmentIds|sourceAttachmentIds/;
  assert.deepEqual(linesMatching(pattern), []);
});

test("no code nests an extra inside a source row's extra", () => {
  assert.deepEqual(linesMatching(/\bextra\??\.extra\b|\$\.extra\.[a-zA-Z]/), []);
});

test("no code reads a source row's media kinds from a column of sources, or its links from extra", () => {
  assert.deepEqual(linesMatching(/\bs\.media\b|\bSET media\b|parseJson\(row\.media\)|\bextra\??\.links\b/), []);
});

test('the paths of memory read media through the one read, never the table', () => {
  const paths = [
    'src/memory/db/recall.ts',
    'src/memory/db/session.ts',
    'src/memory/db/chat-lines.ts',
    'src/memory/db/domain-read.ts',
    'src/memory/db/stems.ts',
    'src/memory/db/index-policy.ts',
    'src/memory/chunks.ts',
    'src/behavior/recall-run.ts',
    'src/format.ts',
    'src/tools/tools.ts',
  ].map((file) => path.join(ROOT, file));
  assert.deepEqual(
    linesMatching(/\b(FROM|JOIN)\s+media(_links)?\b|knownDescriptions|lineDescriptions|line-media/, paths),
    []
  );
});

test('no kind of the old table stands in the code that reads media', () => {
  assert.deepEqual(linesMatching(/kind\s*=\s*'attachment'|kind: 'attachment'|media:attachment:/), []);
});
