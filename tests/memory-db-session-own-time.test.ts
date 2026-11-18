// The memory session of her own time (src/memory/db/session.ts, scope `own:<iface>`): her heartbeat turns read as a
// batch under the interface's group context, what she keeps written under the group audience. A fake llm and made-up
// rows only; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorKey, sweep } from '../src/memory/db/session.ts';
import { dueScopes } from '../src/memory/db/writer-switch.ts';
import { audienceOf, groupContext, whereFor } from '../src/memory/db/scope.ts';
import { NOW, baseConfig, ctxOf, fakeLlm, fixture, memoryBlock, textOf } from './fixtures/memory-db/session-rig.ts';
import type { Db } from '../src/memory/db/types.ts';

const OWN = 'own:discord';
const config = baseConfig({ mode: 'apply' });

function heartbeat(db: Db, id: string, { think = 'a quiet hour', query = 'ήλιος', found = 'sunny pages' } = {}): void {
  const at = '2026-10-24T10:00:00.000Z';
  db.prepare(
    "INSERT INTO wake_runs (id, kind, started_at, finished_at, status, outcome) VALUES (?, 'heartbeat', ?, ?, 'succeeded', 'skip')"
  ).run(id, at, at);
  const calls = [
    { id: 'c1', name: 'web_search', arguments: JSON.stringify({ query }), parsed: { query }, parseError: null },
    { id: 'c2', name: 'conversation_read', arguments: '{"chat":"#cdm"}', parsed: { chat: '#cdm' }, parseError: null },
  ];
  const insert = db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, role, status, started_at, messages, think, tool_calls)
     VALUES (?, 1, ?, 'a1', ?, 'core', 'ok', ?, ?, ?, ?)`
  );
  insert.run(
    `${id}:0`,
    id,
    0,
    at,
    JSON.stringify([{ role: 'user', content: 'HEARTBEAT INPUT' }]),
    think,
    JSON.stringify(calls)
  );
  const next = [
    { role: 'user', content: 'HEARTBEAT INPUT' },
    {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    { role: 'tool', tool_call_id: 'c1', content: `Call succeeded: ${found}` },
    { role: 'tool', tool_call_id: 'c2', content: 'Call succeeded: a private line' },
  ];
  insert.run(`${id}:1`, id, 1, at, JSON.stringify(next), 'done looking', null);
}

/** The user content of request `n` the fake llm was sent. */
const sentOf = (llm: ReturnType<typeof fakeLlm>, n: number): string => {
  const { calls } = llm;
  const [, user] = calls[n].messages;
  return textOf(user.content);
};

const cursorOf = (db: Db): unknown =>
  db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('apply', OWN))?.value ?? null;

test('a heartbeat run yields one request with her thinking and every call, and a claim lands under the group audience', async () => {
  const env = fixture();
  try {
    heartbeat(env.db, 'turn:1');
    const llm = fakeLlm(
      memoryBlock({
        claims: [
          { op: 'add', subject: 'self', kind: 'self_fact', text: 'reads about the sun', how: 'said', sources: ['#2'] },
        ],
      })
    );
    const result = await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]) });
    assert.equal(llm.calls.length, 1);
    const [first] = result.runs;
    assert.equal(first.outcome, 'ok');
    const sent = sentOf(llm, 0);
    for (const part of [
      'a quiet hour',
      'web.search {"query":"ήλιος"}',
      'sunny pages',
      'conversation.read',
      'a private line',
    ])
      assert.ok(sent.includes(part), `the request holds ${part}`);
    assert.ok(!sent.includes('HEARTBEAT INPUT'), 'the heartbeat input request stays out');
    const group = audienceOf({ scope_kind: 'group', scope_iface: 'discord', scope_dm: null }).audience_id;
    const claim = env.db.prepare("SELECT audience_id FROM claims WHERE subject_kind = 'self'").get();
    assert.equal(claim?.audience_id, group);
    const where = whereFor(groupContext('discord'), 'c');
    const read = env.db.prepare(`SELECT c.text FROM claims c WHERE c.subject_kind = 'self' AND ${where.sql}`);
    const seen = read.all(...where.params).map((row) => row.text);
    assert.deepEqual(seen, ['reads about the sun']);
    assert.equal(cursorOf(env.db), '1', 'the cursor moved past the run');
  } finally {
    env.handle.close();
  }
});

test('a failed request leaves the cursor and the next sweep sends the same run again', async () => {
  const env = fixture();
  try {
    heartbeat(env.db, 'turn:1');
    const llm = fakeLlm([new Error('down'), memoryBlock({})]);
    await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]) });
    assert.equal(cursorOf(env.db), null);
    const stored = env.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE kind = 'own_time'").get();
    assert.equal(stored?.n, 0);
    await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]), ignoreSweepCap: true });
    assert.equal(llm.calls.length, 2);
    assert.equal(sentOf(llm, 1), sentOf(llm, 0));
    assert.equal(cursorOf(env.db), '1');
  } finally {
    env.handle.close();
  }
});

test('a run with no step moves the cursor and sends nothing', async () => {
  const env = fixture();
  try {
    env.db
      .prepare(
        "INSERT INTO wake_runs (id, kind, started_at, finished_at, status) VALUES ('turn:0', 'heartbeat', '2026-10-24T09:00:00.000Z', '2026-10-24T09:00:00.000Z', 'failed')"
      )
      .run();
    const llm = fakeLlm(memoryBlock({}));
    await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]) });
    assert.equal(llm.calls.length, 0);
    assert.equal(cursorOf(env.db), '1');
  } finally {
    env.handle.close();
  }
});

test('two runs waiting go out oldest first in one request', async () => {
  const env = fixture();
  try {
    heartbeat(env.db, 'turn:1', { think: 'Ἀρχή' });
    heartbeat(env.db, 'turn:2', { think: 'Τέλος' });
    const llm = fakeLlm(memoryBlock({}));
    await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]) });
    const sent = sentOf(llm, 0);
    assert.ok(sent.indexOf('Ἀρχή') >= 0 && sent.indexOf('Ἀρχή') < sent.indexOf('Τέλος'), sent);
  } finally {
    env.handle.close();
  }
});

test('the scope of her own time is due while a finished heartbeat run waits after its cursor', async () => {
  const env = fixture();
  try {
    ctxOf(env);
    assert.deepEqual(dueScopes(env.db, config, NOW, { iface: 'discord' }), []);
    heartbeat(env.db, 'turn:1');
    assert.deepEqual(dueScopes(env.db, config, NOW, { iface: 'discord' }), [{ key: OWN, lines: 1, full: false }]);
    await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})), config }), { scopes: new Set([OWN]) });
    assert.deepEqual(dueScopes(env.db, config, NOW, { iface: 'discord' }), []);
  } finally {
    env.handle.close();
  }
});
