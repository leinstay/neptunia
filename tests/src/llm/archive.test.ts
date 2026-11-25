// src/llm/archive.ts over src/memory/db/request-archive.ts: every model request kept whole in the memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { archivedLlm, withRequestMeta, currentRequestMeta } from '../../../src/llm/archive.ts';
import { createLlm } from '../../../src/llm/openrouter.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { readRequests } from '../../../src/memory/db/request-archive.ts';
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { frameOf } from '../../../src/turn/request/frame.ts';
import { buildRequest, type Built } from '../../fixtures/built-request.ts';
import { frameInput } from '../../fixtures/frame-input.ts';
import { baseInput, NOW } from '../../fixtures/prompt-rig.ts';
import { coreTurn, sequenceLlm } from '../../fixtures/turn-harness.ts';

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
  // Bug: a full disk in the archive takes the persona's voice away, or the loss goes unnoticed.
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

// ---------- the cause of a failed request ----------

// A failed model request names its real cause in `model_requests.error_code`: the archive over the real client, with
// a fake network underneath. A DOMException's numeric `code` and an HTTP error's `statusCode` must not read as `error`.
// Synthetic data only.

// A request that never settles fails here and not at the runner's two minutes.
const LIMIT = { timeout: 5000 };

const settings = () => ({
  models: { routes: chainsOf({ core: 'x/core', analyzer: 'x/analyzer', embedding: 'x/embed' }) },
  features: { participation: true },
  llm: {
    baseUrl: 'https://openrouter.test/api/v1',
    temperature: 1,
    maxOutputTokens: 100,
    maxRequestTokens: 100000,
    maxRequestsPerDay: 300,
    timeoutMs: 5000,
    analyzerTimeoutMs: 5000,
    retries: 0,
  },
  participation: { pickTimeoutMs: 1500, maxOutputTokens: 60, contextMessages: 5 },
  embed: { dimensions: 2 },
});

type Network = (url: unknown, init: { signal: AbortSignal }) => Promise<unknown>;

/** The real client, kept by the real archive in a temporary database, over `network`. */
function causeRig(network: Network) {
  const handle = openMemoryDb(path.join(tempDir('nep-archive-cause-'), 'memory.db'));
  const client = createLlm({
    apiKey: 'test-key',
    getConfig: settings,
    calibrator: { apply: (n: number) => n, observe() {} },
    state: { data: {}, markDirty() {} },
    // The fake answers the few members of a Response the client reads.
    fetchImpl: network as unknown as typeof fetch,
  });
  const llm = archivedLlm(client, {
    write: (update) => Promise.resolve(applyMemoryWrite(handle, update)),
    log: SILENT,
  });
  const errorCode = (): unknown => readRequests(dbOf(handle))[0]?.error_code;
  return { handle, llm, errorCode };
}

const CAUSE_ASK = [{ role: 'user', content: 'hello' }];

/** A network that never answers: it rejects only when the attempt's signal aborts, with the signal's reason. */
const silentNetwork: Network = (_url, { signal }) =>
  new Promise((_resolve, reject) => {
    const fail = () => reject(signal.reason as Error);
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail);
  });

const statusNetwork =
  (status: number): Network =>
  () =>
    Promise.resolve({ ok: false, status, text: () => Promise.resolve('{}'), headers: new Headers() });

async function codeOfFailure(network: Network, options: Record<string, unknown>): Promise<unknown> {
  const { handle, llm, errorCode } = causeRig(network);
  try {
    await withCapturedLogs(() =>
      assert.rejects(
        (llm.complete as (m: unknown, o: unknown) => Promise<unknown>)(CAUSE_ASK, { model: 'x/a', ...options })
      )
    );
    return errorCode();
  } finally {
    handle.close();
  }
}

test('a request past its attempt timeout is archived as a timeout', LIMIT, async () => {
  // Bug: the DOMException's numeric code reads as no code, and a cut request looks like an unknown failure.
  assert.equal(await codeOfFailure(silentNetwork, { timeoutMs: 5 }), 'timeout');
});

test('a hedged request cut at the hedge limit is archived as a timeout', LIMIT, async () => {
  // Bug: the classifier's own failure mode (12 s, no answer from either attempt) leaves the generic code.
  assert.equal(await codeOfFailure(silentNetwork, { hedge: { afterMs: 2, timeoutMs: 8 } }), 'timeout');
});

test('a request its caller aborted is archived as aborted', LIMIT, async () => {
  // Bug: a budget the engine chose to cut reads the same as a provider failure.
  const caller = new AbortController();
  setTimeout(() => caller.abort(), 2);
  assert.equal(await codeOfFailure(silentNetwork, { signal: caller.signal }), 'aborted');
});

test('a hedged request its caller aborted is archived as aborted', LIMIT, async () => {
  // Bug: the hedge rejects with the signal's reason by another route than the plain request.
  const caller = new AbortController();
  setTimeout(() => caller.abort(), 2);
  assert.equal(
    await codeOfFailure(silentNetwork, { signal: caller.signal, hedge: { afterMs: 1000, timeoutMs: 2000 } }),
    'aborted'
  );
});

test('a provider status of 429 is archived with its status', LIMIT, async () => {
  // Bug: a throttle reads the same as a refusal or an outage.
  assert.equal(await codeOfFailure(statusNetwork(429), {}), 'http_429');
});

test('a network failure is archived as network', LIMIT, async () => {
  // Bug: a request that never reached the provider reads as one it answered badly.
  const network: Network = () => Promise.reject(new TypeError('fetch failed'));
  assert.equal(await codeOfFailure(network, {}), 'network');
});

/** Every block of a request's user message as `<segment> <tag>`, read off the text that goes out. */
function emittedBlocks(request: Built): Array<string> {
  const [, user] = request.messages;
  return user.content.flatMap((part) =>
    [...String(part.text).matchAll(/^<([a-z_]+)>\n[\s\S]*?\n<\/\1>$/gm)].map(
      (match) => `${part.cacheSegment ?? 'tail'} ${match[1]}`
    )
  );
}

test('the archive row of a request names every emitted block with its segment, and the provider never sees the list', async () => {
  // Bug: the row lists what a builder meant to emit, or a block of the profiles segment is filed under the tail.
  const request = buildRequest(baseInput({ frame: frameOf(frameInput()) }));
  const handle = openMemoryDb(':memory:');
  try {
    const sent: Array<unknown> = [];
    const llm = archivedLlm(
      {
        complete: (_messages: unknown, options: unknown) => {
          sent.push(options);
          return Promise.resolve({ text: 'ok' });
        },
      },
      {
        write: (update) => Promise.resolve(applyMemoryWrite(handle, update)),
        now: () => NOW,
        newId: () => 'r1',
        log: { warn() {} },
      }
    );
    await llm.complete(request.messages, { model: 'm', blocks: request.blocks });
    const [row] = readRequests(dbOf(handle));
    const blocks = JSON.parse(String(row?.blocks)) as Array<{ name: string; chars: number; segment: string }>;
    const named = blocks.filter((one) => one.chars > 0).map((one) => `${one.segment} ${one.name}`);
    assert.deepEqual(named.sort(), emittedBlocks(request).sort());
    assert.equal(Object.hasOwn(sent[0] as object, 'blocks'), false);
  } finally {
    handle.close();
  }
});

// Bug: the request archive, the record the standard is measured on, loses the raw answer or shows another shape, or every
// helper's plain answer gets a think it never wrote. `response_text` stays the raw answer because
// the archive is never rewritten, so this test pins the shape in the reply's `think`. The history the persona reads back holds it too,
// which the test above pins.
test('the request archive keeps a reply as it came with an empty think, and a helper answer with none', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const llm = archivedLlm(sequenceLlm(['<msg>χωρίς σκέψη</msg>']), {
    write: (update) => {
      writes.push(update);
      return Promise.resolve();
    },
    log: { warn() {} },
  });
  await coreTurn({ answers: [], runner: { llm } });
  const stored = writes.filter((update) => typeof update.response_text === 'string').at(-1);
  assert.equal(stored?.response_text, '<msg>χωρίς σκέψη</msg>');
  assert.equal(stored?.think, '');

  const helperWrites: Array<Record<string, unknown>> = [];
  const helper = archivedLlm(
    { complete: () => Promise.resolve({ text: 'none', usage: {}, estimated: 1 }) },
    {
      write: (update) => {
        helperWrites.push(update);
        return Promise.resolve();
      },
      log: { warn() {} },
    }
  );
  await withRequestMeta(() => helper.complete());
  const helperStored = helperWrites.filter((update) => typeof update.response_text === 'string').at(-1);
  assert.equal(helperStored?.response_text, 'none');
  assert.equal(helperStored?.think, null);
});
