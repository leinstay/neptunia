// The writer's projection job (src/memory/db/projection-job.ts, write kind `project`): one run finishes a graph
// projection a migration left pending, within the slices it is given. A fresh memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { graphPending } from '../src/memory/db/graph.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

const NOW = Date.parse('2026-11-10T10:00:00.000Z');

test('the project kind finishes a projection a migration left pending', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (\'graph_pending\', \'{"unit":0,"after":null}\')'
    ).run();
    assert.equal(graphPending(handle), true);
    const answer = applyMemoryWrite(handle, { kind: 'project', maxSlices: 50, now: NOW }) as { done: boolean };
    assert.equal(answer.done, true);
    assert.equal(graphPending(handle), false);
  } finally {
    handle.close();
  }
});
