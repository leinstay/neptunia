// src/llm/archive.ts over src/memory/db/request-archive.ts: every model request kept whole in the memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { archivedLlm, withRequestMeta, currentRequestMeta } from '../src/llm/archive.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { readRequests } from '../src/memory/db/request-archive.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

type Handle = ReturnType<typeof openMemoryDb>;
type Client = { complete(messages: unknown, options?: unknown): Promise<unknown> };
const client = (complete: (messages: unknown) => Promise<unknown>): Client => ({ complete });
const SILENT = { info() {}, warn() {}, error() {} };

function rig(answer: (messages: unknown) => Promise<unknown>) {
  const file = path.join(tempDir('nep-archive-'), 'memory.db');
  const handle: Handle = openMemoryDb(file);
  let clock = 1000;
  const llm = archivedLlm(
    client((messages) => answer(messages)),
    {
      write: (update) => Promise.resolve(applyMemoryWrite(handle, update)),
      now: () => (clock += 10),
      newId: () => `r${clock}`,
      log: SILENT,
    }
  );
  return { handle, llm, file };
}
const ask = (system: string, user = 'hello') => [
  { role: 'system', content: system },
  { role: 'user', content: user },
];

test('each request keeps its own exact system text, across a prompt change and a reopening', async () => {
  // Bug: a shared or current prompt stands in for what was really sent, so history is rewritten by a later edit.
  const { handle, llm, file } = rig(() => Promise.resolve({ text: 'ok', usage: { total: 3 } }));
  await llm.complete(ask('prompt one'), { model: 'm/a', role: 'core', purpose: 'reply' });
  await llm.complete(ask('prompt one'), { model: 'm/a', role: 'core', purpose: 'reply' });
  await llm.complete(ask('prompt two'), { model: 'm/a', role: 'core', purpose: 'reply' });
  handle.close();
  const again = openMemoryDb(file);
  try {
    const rows = readRequests(dbOf(again));
    assert.deepEqual(
      rows.map((row) => row.system_text),
      ['prompt one', 'prompt one', 'prompt two']
    );
    assert.deepEqual(
      rows.map((row) => row.status),
      ['ok', 'ok', 'ok']
    );
    assert.equal(rows[0]?.model, 'm/a');
    assert.equal(rows[0]?.role, 'core');
    assert.equal(rows[0]?.schema_version, 1);
  } finally {
    again.close();
  }
});

test('a long think stays whole, and the steps of a tool loop are numbered within their attempt', async () => {
  // Bug: storage cuts a think at the old 4000 characters, or tool steps cannot be told apart.
  const long = 'θ'.repeat(9000);
  const { handle, llm } = rig(() =>
    Promise.resolve({ text: `<think>${long}</think>said`, toolCalls: [{ name: 'x' }] })
  );
  await withRequestMeta(async () => {
    Object.assign(currentRequestMeta() ?? {}, { turnId: 't1', attemptId: 'a1' });
    await llm.complete(ask('s'), { model: 'm' });
    await llm.complete([...ask('s'), { role: 'assistant', content: 'c' }, { role: 'tool', content: 'result' }], {
      model: 'm',
    });
  });
  const rows = readRequests(dbOf(handle));
  assert.equal(rows[0]?.think, long);
  assert.deepEqual(
    rows.map((row) => [row.turn_id, row.attempt_id, row.step]),
    [
      ['t1', 'a1', 0],
      ['t1', 'a1', 1],
    ]
  );
  assert.match(String(rows[1]?.messages), /result/);
  assert.match(String(rows[0]?.tool_calls), /"x"/);
  handle.close();
});

test('a failed call is kept as failed with its request and rethrown', async () => {
  // Bug: only successes reach the archive, or archiving swallows the provider's error.
  const { handle, llm } = rig(() => Promise.reject(Object.assign(new Error('boom'), { code: 'http_500' })));
  await assert.rejects(llm.complete(ask('s'), { model: 'm' }), /boom/);
  const [row] = readRequests(dbOf(handle));
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error_code, 'http_500');
  assert.equal(row?.system_text, 's');
  handle.close();
});

test('an archive write that fails does not stop the call, and says so in the log', async () => {
  // Bug: a full disk in the archive takes her voice away, or the loss goes unnoticed.
  const warned: Array<string> = [];
  const llm = archivedLlm(
    client(() => Promise.resolve({ text: 'ok' })),
    {
      write: () => Promise.reject(new Error('disk')),
      now: () => 1,
      newId: () => 'r',
      log: { ...SILENT, warn: (msg: string) => warned.push(msg) },
    }
  );
  assert.deepEqual(await llm.complete(ask('s'), { model: 'm' }), { text: 'ok' });
  assert.ok(warned.some((msg) => msg.includes('archive')));
});

test('a picture is kept as a marker and its size, and the text around it whole', async () => {
  // Bug: each request stores the same image bytes again, or the marker loses which message it was.
  const { handle, llm } = rig(() => Promise.resolve({ text: 'ok' }));
  const data = `data:image/png;base64,${'A'.repeat(4000)}`;
  await llm.complete(
    [
      { role: 'system', content: 's' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: data }, messageId: 'm9' },
        ],
      },
    ],
    { model: 'm' }
  );
  const [row] = readRequests(dbOf(handle));
  assert.equal(String(row?.messages).includes('AAAA'), false);
  assert.match(String(row?.messages), /look/);
  assert.match(String(row?.messages), /m9/);
  handle.close();
});

test('the archive is outside ordinary recall', () => {
  // Bug: request dumps flood memory search with the persona's own prompts.
  const file = path.join(tempDir('nep-archive-'), 'memory.db');
  const handle = openMemoryDb(file);
  const triggers = dbOf(handle)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%model_requests%'")
    .all();
  assert.deepEqual(triggers, []);
  handle.close();
  assert.ok(fs.existsSync(file));
});
