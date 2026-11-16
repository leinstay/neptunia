// src/interface/pairing.ts: the JSON state file behind the link codes.
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codesFileOf, createCodeFile } from '../src/interface/pairing.ts';

type State = { codes: Array<string>; locked: boolean };
const empty = (): State => ({ codes: [], locked: false });

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'pairing-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loads the empty state when the file does not exist', () => {
  // Bug: a first start with no state file would throw instead of starting empty.
  const file = codesFileOf({ privateDir: dir }, 'codes.json');
  assert.deepEqual(createCodeFile(file, empty).load(), empty());
});

test('loads a saved state back with the fields the empty state adds', () => {
  // Bug: a file written by an older version lacks a field and the loaded state would hold it as undefined.
  const file = codesFileOf({ privateDir: dir }, 'codes.json');
  fs.writeFileSync(file as string, JSON.stringify({ codes: ['one'] }));
  assert.deepEqual(createCodeFile(file, empty).load(), { codes: ['one'], locked: false });
});

test('loads the empty state when the file is unreadable', () => {
  // Bug: a half-written state file would crash the startup of the link tool.
  const file = codesFileOf({ privateDir: dir }, 'codes.json');
  fs.writeFileSync(file as string, '{not json');
  assert.deepEqual(createCodeFile(file, empty).load(), empty());
});
