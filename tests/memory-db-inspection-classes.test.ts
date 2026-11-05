// src/memory/db/inspection-classes.ts: the class of a table is told by its kind first, and by the engine's own list after.
// tests/commands-memory-inspect.test.ts holds the list against the whole schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageClassOf } from '../src/memory/db/inspection-classes.ts';

test('an FTS table and its shadows are derived whatever they are called', () => {
  // Bug: a shadow named like a business table is presented as an independent record.
  assert.equal(storageClassOf('claims', 'virtual'), 'derived');
  assert.equal(storageClassOf('claims_data', 'shadow'), 'derived');
});

test("SQLite's own tables are metadata", () => {
  assert.equal(storageClassOf('sqlite_sequence', 'sqlite'), 'metadata');
});

test('a table the engine lists has its class, and one it does not is unclassified and never guessed', () => {
  // Bug: a default class calls a new table's rows something they may not be.
  assert.equal(storageClassOf('claims', 'table'), 'domain');
  assert.equal(storageClassOf('leases', 'table'), 'operational');
  assert.equal(storageClassOf('future_family', 'table'), 'unclassified');
});
