// The comparison of two harness runs (scripts/lib/harness-compare.ts): every record under `<run>/<edge>/` compared
// byte for byte, the counts per edge, the names of the records that differ with the offset of their first different
// byte, and never a byte of their content.

import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRuns } from '../../../scripts/lib/harness-compare.ts';
import { tempDir } from '../../fixtures/tmp.ts';

/** A run folder with `records`, each path under it mapped to its text. */
function runOf(records: Record<string, string>): string {
  const dir = tempDir('nep-harness-run-');
  for (const [name, text] of Object.entries(records)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('calls two runs identical when every record of every edge holds the same bytes', () => {
  const records = { 'requests/t-1.jsonl': '{"a":"Γεια"}\n', 'db/tables/day.txt': 'h1\n' };
  const result = compareRuns(runOf(records), runOf(records), null);
  assert.equal(result.identical, true);
  assert.match(result.text, /^db: 1 records, 1 identical/m);
  assert.match(result.text, /^requests: 1 records, 1 identical/m);
});

test('names a record that differs with the byte offset of its first difference and none of its content', () => {
  // Catches: a compare that reports runs equal when one byte differs, or prints the private text it compared.
  const a = runOf({ 'requests/t-1.jsonl': '{"a":"Γεια σου"}\n', 'requests/t-2.jsonl': 'x\n' });
  const b = runOf({ 'requests/t-1.jsonl': '{"a":"Γεια σας"}\n', 'requests/t-2.jsonl': 'x\n' });
  const result = compareRuns(a, b, null);
  assert.equal(result.identical, false);
  assert.match(result.text, /^requests: 2 records, 1 identical, 1 differ, 0 only in A, 0 only in B$/m);
  assert.match(result.text, /^differs requests\/t-1\.jsonl at byte 18$/m);
  assert.equal(result.text.includes('Γεια'), false);
});

test('names a record only one run holds', () => {
  const a = runOf({ 'tools/t-1.jsonl': 'x\n', 'tools/t-2.jsonl': 'y\n' });
  const b = runOf({ 'tools/t-1.jsonl': 'x\n' });
  const result = compareRuns(a, b, null);
  assert.equal(result.identical, false);
  assert.match(result.text, /^only in A tools\/t-2\.jsonl$/m);
});

test('compares the one edge it is asked for and leaves the others alone', () => {
  // Catches: `--edge actions` failing a run because its requests differ.
  const a = runOf({ 'actions/t-1.jsonl': 'x\n', 'requests/t-1.jsonl': 'a\n' });
  const b = runOf({ 'actions/t-1.jsonl': 'x\n', 'requests/t-1.jsonl': 'b\n' });
  const result = compareRuns(a, b, 'actions');
  assert.equal(result.identical, true);
  assert.equal(result.text.includes('requests'), false);
});
