// Tests for the schema baseline (src/memory/db/schema-baseline.ts) as src/memory/db/open.ts applies it: a new database
// gets the tables, indexes, triggers and seed rows a database brought to the baseline by the version chain holds, and a
// database at the baseline opens unchanged. Temporary files only, never the deployment's data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { filledRows, schemaShape } from './fixtures/memory-db/schema-shape.ts';
import { tempDir } from './fixtures/tmp.ts';
import { dbOf } from '../src/memory/db/types.ts';

const versions = (handle: ReturnType<typeof openMemoryDb>): Array<number> =>
  dbOf(handle)
    .prepare('SELECT version FROM schema_version ORDER BY version')
    .all()
    .map((row) => Number(row.version));

// Production built `sources_message_locator` before the chat rename changed its expression, so the chain of today
// builds a different text of it. The baseline keeps production's index, which the rehearsal on a copy compares.
const CHAIN_ONLY = 'index sources_message_locator';

test('a new database holds the schema and seed rows that the version chain gives a database at the baseline', () => {
  // Catches: a table, column, index, trigger or check of production missing from the baseline, or a seed row lost.
  const file = path.join(tempDir('nep-baseline-'), 'chain.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, BASELINE_VERSION - 1) }).close();
  const chain = openMemoryDb(file);
  const fresh = openMemoryDb(':memory:');
  try {
    assert.equal(schemaVersion(dbOf(chain)), BASELINE_VERSION);
    assert.deepEqual(versions(fresh), [BASELINE_VERSION]);
    const chainShape = schemaShape(dbOf(chain));
    const freshShape = schemaShape(dbOf(fresh));
    assert.equal(CHAIN_ONLY in freshShape, true);
    delete chainShape[CHAIN_ONLY];
    delete freshShape[CHAIN_ONLY];
    assert.deepEqual(freshShape, chainShape);
    assert.deepEqual(filledRows(dbOf(fresh), ['schema_version']), filledRows(dbOf(chain), ['schema_version']));
  } finally {
    chain.close();
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
    assert.deepEqual(versions(again), [BASELINE_VERSION]);
    assert.equal(dbOf(again).prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  } finally {
    again.close();
  }
});
