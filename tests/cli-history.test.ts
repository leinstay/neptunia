// bin/cli-history.ts: the chat's history file as versioned records, against real files in a disposable folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addToHistory, readHistory, writeHistory } from '../bin/cli-history.ts';
import type { HistoryRecord } from '../bin/cli-history.ts';
import { tempDir } from './fixtures/tmp.ts';

const record = (text: string, over: Partial<HistoryRecord> = {}): HistoryRecord => ({
  version: 1,
  text,
  attachments: [],
  at: 1000,
  ...over,
});

const fileIn = (): string => path.join(tempDir('nep-history-'), 'cli', 'history');

test('a multiline draft with its attachments round-trips across a restart as one record', () => {
  // Bug: a record per line splits a pasted block into many history entries, or the attachment is lost on restart.
  const file = fileIn();
  const attachments = [{ name: 'chart.png', contentType: 'image/png', reference: 'ref-1' }];
  const first = record('line one\n  line two  \n\nγραμμή', { attachments });
  writeHistory(file, [first, record('older')]);
  const read = readHistory(file);
  assert.deepEqual(read.records, [first, record('older')]);
  assert.equal(read.skipped, 0);
});

test('a legacy file reads newest first, one draft per line, and stays whole through the next write', () => {
  // Bug: the upgrade loses the owner's history, reverses it, or reads a typed JSON line as a damaged record.
  const file = fileIn();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'oldest\n{"typed":"by the owner"}\nnewest\n');
  const read = readHistory(file);
  const expected = ['newest', '{"typed":"by the owner"}', 'oldest'];
  assert.deepEqual(
    read.records.map((one) => one.text),
    expected
  );
  assert.equal(read.skipped, 0);
  writeHistory(file, read.records);
  assert.deepEqual(
    readHistory(file).records.map((one) => one.text),
    expected
  );
});

test('a damaged record is counted and skipped, its neighbours kept', () => {
  // Bug: one torn line makes the whole file read as legacy text, or empties the history.
  const file = fileIn();
  writeHistory(file, [record('kept one'), record('kept two')]);
  fs.appendFileSync(file, '{"version":1,"text":\n');
  const read = readHistory(file);
  assert.deepEqual(
    read.records.map((one) => one.text),
    ['kept one', 'kept two']
  );
  assert.equal(read.skipped, 1);
});

test('a failed rename leaves the old file whole and no temporary file behind, and the failure is raised', () => {
  // Bug: a crash during a save truncates the history, or leaves a draft in a stray temporary file.
  const file = fileIn();
  writeHistory(file, [record('safe')]);
  assert.throws(() =>
    writeHistory(file, [record('new')], {
      rename: () => {
        throw new Error('disk gone');
      },
    })
  );
  assert.deepEqual(
    readHistory(file).records.map((one) => one.text),
    ['safe']
  );
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['history']);
});

test('the file is private to the owner', () => {
  // Bug: the history, full of pasted text, is readable by another user of the server.
  const file = fileIn();
  writeHistory(file, [record('private')]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('a missing file reads as no history', () => {
  // Bug: the first start of the chat dies on an absent file.
  assert.deepEqual(readHistory(fileIn()), { records: [], skipped: 0 });
});

test('a secret or blank draft adds no record, and a repeat of the newest adds none', () => {
  // Bug: a typed key enters the file, or holding Enter fills the history with one line.
  const start = [record('newest')];
  const options = { now: 2000, limit: 10 };
  assert.deepEqual(addToHistory(start, { text: 'sk-secret', attachments: [] }, { ...options, secret: true }), start);
  assert.deepEqual(addToHistory(start, { text: '  \n', attachments: [] }, { ...options, secret: false }), start);
  assert.deepEqual(addToHistory(start, { text: 'newest', attachments: [] }, { ...options, secret: false }), start);
  const added = addToHistory(start, { text: 'next', attachments: [] }, { ...options, secret: false });
  assert.deepEqual(
    added.map((one) => one.text),
    ['next', 'newest']
  );
  assert.equal(added[0]?.at, 2000);
});

test('the limit drops the oldest records', () => {
  // Bug: the file grows without end, or the cut removes the newest lines.
  const start = [record('b'), record('a')];
  const added = addToHistory(start, { text: 'c', attachments: [] }, { now: 1, limit: 2, secret: false });
  assert.deepEqual(
    added.map((one) => one.text),
    ['c', 'b']
  );
});
