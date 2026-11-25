// The stems the unit writes fill (src/memory/db/stems.ts), on synthetic Greek and accented Latin text: the stems
// column, the learned stemmer kept in meta, and the one key that the inflected forms of a word share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { loadStemmer, stemsOf } from '../../../../src/memory/db/stems.ts';
import { seedUnits } from '../../../fixtures/memory-db/seed.ts';
import { fixture } from '../../../fixtures/memory-db-recall.ts';
import { buildDataDir, guildDir, MEMBER, CHANNEL } from '../../../fixtures/memory-db/datadir.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

test('stems: the unit writes fill them, learns the endings from the database text and stamps again only what changed', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-stems-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  try {
    const first = seedUnits(handle, data);
    assert.equal(first.errors, 0);
    const db = dbOf(handle);
    const empty = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE text IS NOT NULL AND stems IS NULL').get()!.n;
    assert.equal(empty, 0, 'every row with text has stems');
    const row = db.prepare("SELECT text, stems FROM sources WHERE text LIKE '%café at noon%'").get()!;
    assert.equal(row.stems, 'a cafe at noon', 'folded, one key per word');
    assert.ok(db.prepare("SELECT value FROM meta WHERE key = 'stemmer'").get(), 'the learned stemmer is kept in meta');
    // The FTS table reads the stems column.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sources_fts WHERE sources_fts MATCH \'{stems} : "cafe"\'').get()!.n,
      1
    );
    // A changed text loses its stems and gets new ones; an unchanged row keeps its own.
    db.prepare("UPDATE sources SET stems = 'kept' WHERE text = 'Καλημέρα'").run();
    const again = seedUnits(handle, data);
    assert.equal(again.errors, 0);
    assert.equal(
      db.prepare("SELECT stems FROM sources WHERE text = 'Καλημέρα'").get()!.stems,
      'kept',
      'a write that changed nothing stems nothing'
    );
    const file = path.join(guildDir(data), 'record', '2026-10', '2026-10-20.jsonl');
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    lines.push({ ...lines[0], id: 'r-new', messageId: '400000000000000077', text: 'ένα νέο μήνυμα' });
    fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    seedUnits(handle, data);
    assert.equal(
      db.prepare("SELECT stems FROM sources WHERE native_id = '400000000000000077'").get()!.stems,
      'ενα νεο μηνυμα'
    );
    assert.equal(db.prepare("SELECT stems FROM sources WHERE text = 'Καλημέρα'").get()!.stems, 'kept');
    assert.ok(MEMBER && CHANNEL);
  } finally {
    handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('stems: the learned stemmer gives the inflected forms of a word one key, the query side uses the same one', () => {
  const env = fixture();
  try {
    env.say({ native: 'a1', at: NOW - DAY, text: 'ο δασκαλος του σπιτου' });
    env.say({ native: 'a2', at: NOW - 2 * DAY, text: 'το σπιτος δασκαλου' });
    env.stem();
    const { stem, endings } = loadStemmer(env.db);
    assert.ok(endings.includes('ου') && endings.includes('ος'));
    assert.equal(stem('σπιτου'), stem('σπιτος'));
    assert.equal(
      env.db.prepare("SELECT stems FROM sources WHERE native_id = 'a1'").get()!.stems,
      stemsOf(stem, 'ο δασκαλος του σπιτου')
    );
  } finally {
    env.done();
  }
});
