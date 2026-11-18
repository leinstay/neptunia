// The view of a heartbeat turn the memory session reads (src/memory/db/own-time.ts): every step's thinking, every call
// with its arguments and its result in order, and how the run ended. A database with the real schema, made-up rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { finishedRuns, ownTimeView, RESULT_MAX_CHARS, viewLines } from '../src/memory/db/own-time.ts';
import { dbOf, type Db } from '../src/memory/db/types.ts';

const AT = '2026-11-18T09:00:00.000Z';

function withDb(body: (db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

function run(db: Db, id: string, { status = 'succeeded', kind = 'heartbeat', outcome = 'skip' } = {}): void {
  db.prepare(
    `INSERT INTO wake_runs (id, kind, started_at, finished_at, status, outcome) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, kind, AT, AT, status, outcome);
}

type Step = { think?: string; calls?: Array<{ id: string; name: string; args: object }>; messages?: Array<object> };

/** The rows of a turn: one `model_requests` row per step, the first one's messages being the heartbeat's input. */
function steps(db: Db, turnId: string, list: Array<Step>): void {
  const insert = db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, role, status, started_at, system_text, messages, think, tool_calls)
     VALUES (?, 1, ?, 'a1', ?, 'core', 'ok', ?, 'SYSTEM OF THE HEARTBEAT', ?, ?, ?)`
  );
  list.forEach((step, n) => {
    const calls = (step.calls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.args),
      parsed: call.args,
      parseError: null,
    }));
    insert.run(
      `req:${turnId}:${n}`,
      turnId,
      n,
      AT,
      JSON.stringify(step.messages ?? [{ role: 'user', content: 'INPUT OF THE HEARTBEAT' }]),
      step.think ?? null,
      calls.length > 0 ? JSON.stringify(calls) : null
    );
  });
}

/** The messages of the request after a step: the input, the step's calls, one result per call. */
const after = (calls: Array<{ id: string; name: string; args: object }>, results: Array<string>): Array<object> => [
  { role: 'user', content: 'INPUT OF THE HEARTBEAT' },
  {
    role: 'assistant',
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  },
  ...calls.map((call, i) => ({ role: 'tool', tool_call_id: call.id, content: results[i] })),
];

const SEARCH = { id: 'c1', name: 'web_search', args: { query: 'ήλιος' } };
const DM_READ = { id: 'c2', name: 'conversation_read', args: { chat: '#cdm' } };
const RECALL = { id: 'c3', name: 'memory_search', args: { query: 'Ἀθῆναι' } };

test('the view holds each step thinking and each call with its arguments and result, in order', () => {
  withDb((db) => {
    run(db, 'turn:1');
    steps(db, 'turn:1', [
      { think: 'first thought', calls: [SEARCH, DM_READ] },
      {
        think: 'second thought',
        calls: [RECALL],
        messages: after([SEARCH, DM_READ], ['Call succeeded: sunny pages', 'Call succeeded: a private line']),
      },
      { think: 'last thought', messages: after([RECALL], ['Call succeeded: a stored memory']) },
    ]);
    const lines = viewLines(ownTimeView(db, 'turn:1')!);
    assert.deepEqual(lines, [
      'think: first thought',
      'call web.search {"query":"ήλιος"}',
      'result: Call succeeded: sunny pages',
      'call conversation.read {"chat":"#cdm"}',
      'result: Call succeeded: a private line',
      'think: second thought',
      'call memory.search {"query":"Ἀθῆναι"}',
      'result: Call succeeded: a stored memory',
      'think: last thought',
      'ended: succeeded skip',
    ]);
  });
});

test('a refused call is shown with the reason its result gives', () => {
  withDb((db) => {
    run(db, 'turn:1');
    steps(db, 'turn:1', [
      { think: 'try', calls: [SEARCH] },
      { messages: after([SEARCH], ['Call did not run: the owner has not switched it on.']) },
    ]);
    const lines = viewLines(ownTimeView(db, 'turn:1')!);
    assert.ok(lines.includes('result: Call did not run: the owner has not switched it on.'), lines.join('\n'));
  });
});

test('a call of the text transport keeps its status and its name', () => {
  withDb((db) => {
    run(db, 'turn:1');
    db.prepare(
      `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, role, status, started_at, messages, response_text)
       VALUES ('r0', 1, 'turn:1', 'a1', 0, 'core', 'ok', ?, '[]', ?)`
    ).run(AT, '<tool_call>{"name": "web.search", "arguments": {"query": "x"}}</tool_call>');
    db.prepare(
      `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, role, status, started_at, messages)
       VALUES ('r1', 1, 'turn:1', 'a1', 1, 'core', 'ok', ?, ?)`
    ).run(
      AT,
      JSON.stringify([
        { role: 'user', content: 'INPUT' },
        { role: 'assistant', content: '<tool_call>...</tool_call>' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '<tool_result id="t1" name="web.search" status="denied">\nblocked\n</tool_result>' },
          ],
        },
      ])
    );
    const lines = viewLines(ownTimeView(db, 'turn:1')!);
    assert.deepEqual(lines.slice(0, 2), ['call web.search {"query":"x"}', 'result denied: blocked']);
  });
});

test('a result longer than the cap is cut', () => {
  withDb((db) => {
    run(db, 'turn:1');
    steps(db, 'turn:1', [{ calls: [SEARCH] }, { messages: after([SEARCH], ['ά'.repeat(RESULT_MAX_CHARS + 50)]) }]);
    const result = viewLines(ownTimeView(db, 'turn:1')!).find((line) => line.startsWith('result'))!;
    assert.equal(result, `result: ${'ά'.repeat(RESULT_MAX_CHARS)}…`);
  });
});

test('the heartbeat input request is not in the view', () => {
  withDb((db) => {
    run(db, 'turn:1');
    steps(db, 'turn:1', [{ think: 'look', calls: [SEARCH] }, { messages: after([SEARCH], ['found']) }]);
    const text = viewLines(ownTimeView(db, 'turn:1')!).join('\n');
    assert.ok(!text.includes('INPUT OF THE HEARTBEAT') && !text.includes('SYSTEM OF THE HEARTBEAT'), text);
  });
});

test('a turn with no call still gives its thinking', () => {
  withDb((db) => {
    run(db, 'turn:1');
    steps(db, 'turn:1', [{ think: 'nothing to do now' }]);
    assert.deepEqual(viewLines(ownTimeView(db, 'turn:1')!), ['think: nothing to do now', 'ended: succeeded skip']);
  });
});

test('a turn with no request has an empty view', () => {
  withDb((db) => {
    run(db, 'turn:1', { status: 'failed', outcome: 'error' });
    assert.deepEqual(viewLines(ownTimeView(db, 'turn:1')!), []);
  });
});

test('finished heartbeat runs come oldest first after the cursor and stop at one still running', () => {
  withDb((db) => {
    run(db, 'turn:1');
    run(db, 'turn:2', { kind: 'intention_due' });
    run(db, 'turn:3', { status: 'failed' });
    run(db, 'turn:4', { status: 'running' });
    run(db, 'turn:5');
    const all = finishedRuns(db, { after: 0, limit: 10, since: null });
    assert.deepEqual(
      all.map((one) => one.id),
      ['turn:1', 'turn:3']
    );
    assert.deepEqual(
      finishedRuns(db, { after: all[0].rowid, limit: 10, since: null }).map((one) => one.id),
      ['turn:3']
    );
  });
});
