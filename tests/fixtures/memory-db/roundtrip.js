// Test helper for the memory database mappers: a value goes through toRows, into a real in-memory database (the
// schema rejects a column that does not exist), back out and through fromRows; the caller compares the result with
// the input (key order aside).
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../../../src/memory/db/open.js';
import { insertRows, readRows } from '../../../src/memory/db/rows.js';

let shared = null;

/** One in-memory database for the whole test file; every round trip is rolled back. */
export function database() {
  shared ??= openMemoryDb(':memory:');
  return shared.db;
}

/** Runs one value through a mapper and the database; returns `{ rows, back }`. */
export function roundTrip(mapper, rel, value, ctx = {}) {
  const db = database();
  const rows = mapper.toRows(rel, value, ctx);
  db.exec('BEGIN');
  try {
    insertRows(db, rows);
    const stored = readRows(db, Object.keys(rows));
    // Schema v7 seeds her own `people` row (`person:self`, no file owns it): it is not part of any mapping.
    if (stored.people) stored.people = stored.people.filter((row) => !(row.id === 'person:self' && row.owner_file === null));
    return { rows, stored, back: mapper.fromRows(stored, ctx) };
  } finally {
    db.exec('ROLLBACK');
  }
}

/** Asserts that a value comes back equal (deep, key order ignored). Returns the rows. */
export function assertRoundTrip(mapper, rel, value, ctx = {}, label = rel) {
  const { rows, back } = roundTrip(mapper, rel, value, ctx);
  assert.deepStrictEqual(back, value, `${label}: the value did not come back equal`);
  return rows;
}

/** The generated kitchen-sink fixture of a kind (synthetic values for every key path of the live files). */
export function generated(kind) {
  return JSON.parse(fs.readFileSync(new URL(`./generated/${kind}.json`, import.meta.url), 'utf8'));
}

/** The JSON-and-back copy of a value: what a file holds. */
export const plain = (value) => JSON.parse(JSON.stringify(value));
