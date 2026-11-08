// A failed model request names its real cause in `model_requests.error_code`: the archive over the real client, with
// a fake network underneath. A DOMException's numeric `code` and an HTTP error's `statusCode` must not read as `error`.
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { archivedLlm } from '../src/llm/archive.ts';
import { createLlm } from '../src/llm/openrouter.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { readRequests } from '../src/memory/db/request-archive.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { tempDir } from './fixtures/tmp.ts';

const SILENT = { info() {}, warn() {}, error() {} };
// A request that never settles fails here and not at the runner's two minutes.
const LIMIT = { timeout: 5000 };

const settings = () => ({
  models: { base: { core: 'x/core', analyzer: 'x/analyzer', embedding: 'x/embed' } },
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
function rig(network: Network) {
  const handle = openMemoryDb(path.join(tempDir('nep-archive-cause-'), 'memory.db'));
  const client = createLlm({
    apiKey: 'test-key',
    env: {},
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

const ask = [{ role: 'user', content: 'hello' }];

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
  const { handle, llm, errorCode } = rig(network);
  try {
    await withCapturedLogs(() =>
      assert.rejects((llm.complete as (m: unknown, o: unknown) => Promise<unknown>)(ask, { model: 'x/a', ...options }))
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
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 2);
  assert.equal(await codeOfFailure(silentNetwork, { signal: abort.signal }), 'aborted');
});

test('a hedged request its caller aborted is archived as aborted', LIMIT, async () => {
  // Bug: the hedge rejects with the signal's reason by another route than the plain request.
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 2);
  assert.equal(
    await codeOfFailure(silentNetwork, { signal: abort.signal, hedge: { afterMs: 1000, timeoutMs: 2000 } }),
    'aborted'
  );
});

test('a provider status of 429 is archived with its status', LIMIT, async () => {
  // Bug: a throttle reads the same as a refusal or an outage.
  assert.equal(await codeOfFailure(statusNetwork(429), {}), 'http_429');
});

test('a provider status of 400 is archived with its status', LIMIT, async () => {
  // Bug: a request the provider refuses for good reads as a transient failure.
  assert.equal(await codeOfFailure(statusNetwork(400), {}), 'http_400');
});

test('a provider status of 503 is archived with its status', LIMIT, async () => {
  // Bug: an outage at the provider cannot be told from the engine's own exceptions.
  assert.equal(await codeOfFailure(statusNetwork(503), {}), 'http_503');
});

test('a network failure is archived as network', LIMIT, async () => {
  // Bug: a request that never reached the provider reads as one it answered badly.
  const network: Network = () => Promise.reject(new TypeError('fetch failed'));
  assert.equal(await codeOfFailure(network, {}), 'network');
});
