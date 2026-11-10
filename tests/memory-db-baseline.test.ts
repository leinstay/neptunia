// Tests for the schema baseline (src/memory/db/schema-baseline.ts) as src/memory/db/open.ts applies it: a new database
// starts at the baseline with its seed rows, a database at the baseline opens unchanged, and a database below it is
// refused. Temporary files only, never the deployment's data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { INITIAL_ENTITY_KINDS, INITIAL_PREDICATES } from '../src/memory/db/semantic-registry.ts';
import { BOARD_VERSION, boardVersion } from '../src/board/schema.ts';
import { filledRows, schemaShape } from './fixtures/memory-db/schema-shape.ts';
import { tempDir } from './fixtures/tmp.ts';
import { dbOf } from '../src/memory/db/types.ts';

const versions = (handle: ReturnType<typeof openMemoryDb>): Array<number> =>
  dbOf(handle)
    .prepare('SELECT version FROM schema_version ORDER BY version')
    .all()
    .map((row) => Number(row.version));

/** The versions a current database holds: the baseline's, then one per step above it. */
const CURRENT = [BASELINE_VERSION, ...MIGRATIONS.map((_, step) => BASELINE_VERSION + step + 1)];

test('a new database starts at the baseline with the seed rows a new install needs', () => {
  // Catches: a lost seed row, which leaves a new install without her own person, an audience, an interface's
  // authority, a registry entry or the board.
  const fresh = openMemoryDb(':memory:');
  try {
    const db = dbOf(fresh);
    const column = (sql: string): Array<unknown> =>
      db
        .prepare(sql)
        .all()
        .map((row) => Object.values(row)[0]);
    assert.deepEqual(versions(fresh), CURRENT);
    assert.deepEqual(column("SELECT kind FROM people WHERE id = 'person:self'"), ['self']);
    assert.deepEqual(column('SELECT id FROM audiences ORDER BY id'), ['aud:internal', 'aud:none']);
    assert.deepEqual(column('SELECT id FROM interfaces ORDER BY id'), ['cli', 'core', 'discord']);
    // Changed: the baseline seeds `legacy/local` too, and version step 56 deletes it (src/memory/db/legacy-keys.ts).
    assert.deepEqual(column("SELECT id FROM authorities WHERE iface IN ('cli', 'core', 'discord') ORDER BY id"), [
      'cli/local',
      'core/local',
      'discord/global',
    ]);
    assert.deepEqual(column("SELECT row_id FROM graph_nodes WHERE kind = 'interface' ORDER BY row_id"), [
      'cli',
      'core',
      'discord',
    ]);
    assert.equal(column('SELECT id FROM semantic_entity_kinds').length, INITIAL_ENTITY_KINDS.length);
    assert.equal(column('SELECT id FROM semantic_predicate_versions').length, INITIAL_PREDICATES.length);
    assert.equal(boardVersion(db), BOARD_VERSION);
    assert.equal(fresh.board.ok, true);
  } finally {
    fresh.close();
  }
});

test('a database at the baseline opens with its schema, rows and version unchanged', () => {
  // Catches: an open that runs a step again, adds an object or a seed row, or writes a version, on a current file.
  const file = path.join(tempDir('nep-baseline-'), 'memory.db');
  const first = openMemoryDb(file);
  const shape = schemaShape(dbOf(first));
  const rows = filledRows(dbOf(first));
  first.close();
  const again = openMemoryDb(file);
  try {
    assert.deepEqual(schemaShape(dbOf(again)), shape);
    assert.deepEqual(filledRows(dbOf(again)), rows);
    assert.deepEqual(versions(again), CURRENT);
    assert.equal(dbOf(again).prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  } finally {
    again.close();
  }
});

test('refuses a database below the baseline with the version it found and leaves the file as it was', () => {
  // Catches: an open that runs half a schema over an old file, or refuses it without saying what to do.
  const file = path.join(tempDir('nep-baseline-'), 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (43);');
  old.close();
  assert.throws(() => openMemoryDb(file), /schema-below-baseline: .*version 43.*baseline 44/);
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    assert.deepEqual(
      tables.map((row) => row.name),
      ['schema_version']
    );
    assert.equal(after.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 43);
  } finally {
    after.close();
  }
});
