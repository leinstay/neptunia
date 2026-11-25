// The archived answers of a replayed turn (scripts/lib/turn-archive.ts): the k-th request of a purpose gets the k-th
// answer of that purpose the live turn received, with its tool calls, a request past the archive gets `<skip/>` and is
// marked, and the counter ids and the seeded random source give the same values on every run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { archiveAnswers, archivedToolResults, counterIds } from '../../../scripts/lib/turn-archive.ts';
import { freshMemoryDb } from '../../fixtures/memory-db-copy.ts';

type Db = InstanceType<typeof DatabaseSync>;

const TOOLS = [{ type: 'function', function: { name: 'memory_search', parameters: { type: 'object' } } }];

/** Three answered requests of one turn, one of another turn and one that failed, out of their order of insertion. */
function seed(db: Db): void {
  const row = db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, step, purpose, status, started_at, messages, response_text, tool_calls)
     VALUES (?, 1, ?, ?, ?, ?, ?, '[]', ?, ?)`
  );
  const calls = JSON.stringify([{ id: 'call-1', name: 'memory_search', arguments: '{"q":"Ελένη"}' }]);
  row.run('r3', 't-1', 2, 'reply', 'ok', '2026-03-04T10:00:03.000Z', 'Τέλος', null);
  row.run('r1', 't-1', 0, 'split', 'ok', '2026-03-04T10:00:01.000Z', 'Χωρίς', null);
  row.run('r2', 't-1', 1, 'reply', 'ok', '2026-03-04T10:00:02.000Z', '', calls);
  row.run('r4', 't-2', 1, 'reply', 'ok', '2026-03-04T10:00:02.500Z', 'Άλλο', null);
  row.run('r5', 't-1', 1, 'reply', 'failed', '2026-03-04T10:00:01.500Z', null, null);
}

test('answers each request of a purpose with the next answer of that purpose and its tool calls', async () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  const archive = archiveAnswers(handle.db as Db, 't-1');
  const first = (await archive.llm.complete([], { purpose: 'reply', tools: TOOLS })) as Record<string, unknown>;
  const split = (await archive.llm.complete([], { purpose: 'split' })) as Record<string, unknown>;
  const second = (await archive.llm.complete([], { purpose: 'reply', tools: TOOLS })) as Record<string, unknown>;
  assert.deepEqual(
    [first.text, first.toolCalls, split.text, second.text, second.toolCalls],
    ['', [{ id: 'call-1', name: 'memory_search', arguments: '{"q":"Ελένη"}' }], 'Χωρίς', 'Τέλος', []]
  );
  assert.deepEqual(archive.past, []);
  handle.close();
});

test('answers a request past the archive with skip and marks it', async () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  const archive = archiveAnswers(handle.db as Db, 't-1');
  await archive.llm.complete([], { purpose: 'split' });
  const past = (await archive.llm.complete([], { purpose: 'split' })) as Record<string, unknown>;
  const never = (await archive.llm.complete([], { purpose: 'recall' })) as Record<string, unknown>;
  assert.deepEqual([past.text, never.text], ['<skip/>', '<skip/>']);
  assert.deepEqual(archive.past, [
    { purpose: 'split', index: 2 },
    { purpose: 'recall', index: 1 },
  ]);
  handle.close();
});

test('counts its ids from one on every run', () => {
  const ids = counterIds();
  const again = counterIds();
  assert.deepEqual([ids(), ids(), again()], ['harness-1', 'harness-2', 'harness-1']);
});

test('answers each web call with the result the live turn read for it, and nothing past the archive', () => {
  // Catches: the second search of a turn answered with the first one's result, or a read answered as a search.
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  const row = db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, step, purpose, status, started_at, messages, tool_calls)
     VALUES (?, 1, 't-1', ?, 'reply', 'ok', ?, ?, ?)`
  );
  const asked = (id: string, name: string) => ({ id, name, arguments: '{}' });
  const said = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content });
  const first = JSON.stringify([asked('c1', 'web_search'), asked('c2', 'web_read')]);
  const results = JSON.stringify([said('c1', 'Call succeeded:\nΠρώτη'), said('c2', 'Call succeeded:\nΣελίδα')]);
  row.run('q1', 0, '2026-03-04T10:00:01.000Z', '[]', first);
  row.run('q2', 1, '2026-03-04T10:00:02.000Z', results, JSON.stringify([asked('c3', 'web_search')]));
  row.run('q3', 2, '2026-03-04T10:00:03.000Z', JSON.stringify([said('c3', 'Call succeeded:\nΔεύτερη')]), null);
  const next = archivedToolResults(db, 't-1', { ok: 'Call succeeded:' });
  assert.deepEqual(
    [next('web.search'), next('web.read'), next('web.search'), next('web.search'), next('memory.search')],
    [
      { status: 'ok', data: { text: 'Πρώτη' } },
      { status: 'ok', data: { text: 'Σελίδα' } },
      { status: 'ok', data: { text: 'Δεύτερη' } },
      null,
      null,
    ]
  );
  handle.close();
});
