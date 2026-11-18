// Schema step 68 (src/memory/db/schema.ts), which gives every stored diary entry of the kind `status` the kind `story`,
// on a database written at the newest version before it, where an invented moment was stored under `status`. Each test
// builds the old file with the steps up to that version, fills it with raw SQL as the writer of that version left it,
// and opens it with the current code. Temporary files, invented ids, synthetic text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The newest schema version before the step. */
const BEFORE_STEP = 67;

/** Five entries as the old writer left them: two of the kind `status`, one of them retired, and three other rows. */
const ROWS = `
INSERT INTO diary (id, at_ms, kind, gist, text, extra, position, retired_at, writer) VALUES
  ('diary:a', 1000, 'status', 'at the pond', 'at the pond', '{"plan":{"brief":"a status at a pond"}}', 0, NULL, 'diary'),
  ('diary:b', 2000, 'news', 'a status report', 'the status of a launch', '{"status":"sent"}', 1, NULL, 'diary'),
  ('diary:c', 3000, 'status', 'on the roof', 'on the roof', NULL, 2, '2026-01-01T00:00:00.000Z', 'diary'),
  ('diary:d', 4000, NULL, 'no kind', 'no kind', NULL, 3, NULL, 'diary'),
  ('diary:e', 5000, 'thought', 'a thought', 'a thought', NULL, 4, NULL, 'diary');
`;

/** A database file at `BEFORE_STEP` holding `ROWS`, written with raw SQL after the steps up to that version. */
function oldFile(): string {
  const file = path.join(tempDir('nep-status-story-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, BEFORE_STEP - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, BEFORE_STEP);
    raw.exec(ROWS);
  } finally {
    raw.close();
  }
  return file;
}

/** Opens `file` with the current code, then `read` on its connection. */
function opened<TResult>(file: string, read: (db: Db) => TResult): TResult {
  const handle = openMemoryDb(file);
  try {
    return read(dbOf(handle));
  } finally {
    handle.close();
  }
}

/** Every entry as `id kind`, in id order. */
const kinds = (db: Db): Array<string> =>
  db
    .prepare('SELECT id, kind FROM diary ORDER BY id')
    .all()
    .map((row) => `${String(row.id)} ${String(row.kind)}`);

test('an entry stored as a status reads as a story after the step, retired or not', () => {
  // Bug: the step is missing or skips a retired row, so an invented moment keeps the kind that means the real day.
  const after = opened(oldFile(), kinds);
  assert.deepEqual(after, ['diary:a story', 'diary:b news', 'diary:c story', 'diary:d null', 'diary:e thought']);
});

test('the step changes the kind alone', () => {
  // Bug: a rename by text that also rewrites the word inside an entry's words or its stored extra.
  const rows = opened(oldFile(), (db) =>
    db
      .prepare(
        "SELECT id, gist, text, extra, position, retired_at FROM diary WHERE id IN ('diary:a', 'diary:b') ORDER BY id"
      )
      .all()
  );
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      {
        id: 'diary:a',
        gist: 'at the pond',
        text: 'at the pond',
        extra: '{"plan":{"brief":"a status at a pond"}}',
        position: 0,
        retired_at: null,
      },
      {
        id: 'diary:b',
        gist: 'a status report',
        text: 'the status of a launch',
        extra: '{"status":"sent"}',
        position: 1,
        retired_at: null,
      },
    ]
  );
});

test('a second open leaves a status written after the step as it is', () => {
  // Bug: the step runs at every open, so a real status of the persona's day turns into a story at the next start.
  const file = oldFile();
  opened(file, () => null);
  const raw = new DatabaseSync(file);
  try {
    raw.exec(
      "INSERT INTO diary (id, at_ms, kind, gist, text, position, writer) VALUES ('diary:f', 6000, 'status', 'tired', 'tired', 5, 'diary');"
    );
  } finally {
    raw.close();
  }
  const kind = opened(file, (db) => db.prepare("SELECT kind FROM diary WHERE id = 'diary:f'").get()?.kind);
  assert.equal(kind, 'status');
});
