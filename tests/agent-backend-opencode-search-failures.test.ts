// src/agent-runner/backend.ts: an OpenCode run prints its events as JSON lines (`opencode run --format json`). Each
// `tool_use` event of the `websearch` tool whose `part.state.status` is `error` (Exa's 429, for one) is a failed web
// search. The backend counts them into `BackendResult.searchFailures` (absent when there are none), logs the count with no
// contents, and keeps the answer: the text of the run is the `text` events' `part.text`. The engine
// (`createAgentEngine`) puts the count on the task's `result.searchFailures`. The child is a fake; no request goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { createAgentEngine, createBackend } from '../src/agent-runner/backend.ts';
import type { BackendName } from '../src/agent-runner/backend.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';

type Task = Parameters<ReturnType<typeof createAgentEngine>['run']>[0];

const ANSWER = 'The release notes are at the project site.';
const ERROR_TEXT = 'Too Many Requests: rate limit reached for the free Exa endpoint';
const QUERY = 'zebra-crossing-release-notes-query';

const tool = (name: string, status: string, error?: string) =>
  JSON.stringify({
    type: 'tool_use',
    timestamp: 1,
    sessionID: 'ses_1',
    part: {
      type: 'tool',
      tool: name,
      callID: `call-${name}-${status}`,
      state: { status, input: { query: QUERY }, ...(error === undefined ? {} : { error }) },
    },
  });
const text = (words: string) => JSON.stringify({ type: 'text', part: { type: 'text', text: words } });

/** The stdout of an OpenCode run: two failed web searches among other events and a line that is no JSON. */
const EVENTS = [
  tool('websearch', 'error', ERROR_TEXT),
  tool('websearch', 'completed'),
  tool('webfetch', 'error', 'connection reset'),
  'opencode: a log line that is not an event',
  tool('websearch', 'error', ERROR_TEXT),
  text(ANSWER),
].join('\n');

/** A fake spawn whose child prints `stdout` and exits with `code`. */
function fakeSpawn(stdout: string, code = 0): typeof spawn {
  const impl = () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    child.stdin.resume();
    setImmediate(() => {
      child.stdout.write(`${stdout}\n`);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return wrongly<typeof spawn>(impl);
}

function backendOf(name: BackendName, stdout: string) {
  const base = tempDir('nep-oc-sfail-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { base, binary, backend: createBackend(name, { binary, spawnImpl: fakeSpawn(stdout) }) };
}

const OPTIONS = (cwd: string) => ({ cwd, timeoutMs: 5_000, env: { OPENCODE_ENABLE_EXA: '1' } });

test('an opencode run counts its failed websearch calls and ignores the completed websearch and the failed webfetch', async () => {
  // Catches: a failed web search going unseen (the run reads as a clean answer), or other failed tools inflating the count.
  const { base, backend } = backendOf('opencode', EVENTS);
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.equal(result.searchFailures, 2);
});

test('an opencode run with failed searches still answers with the text events', async () => {
  // Catches: reading events instead of plain text drops the answer, so every run ends empty-answer.
  const { base, backend } = backendOf('opencode', EVENTS);
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.equal(result.ok, true);
  assert.equal(result.text, ANSWER);
});

test('an opencode run with no failed websearch has no searchFailures field', async () => {
  // Catches: a zero count carried on every result, which would print a failure notice for a clean run.
  const { base, backend } = backendOf('opencode', [tool('websearch', 'completed'), text(ANSWER)].join('\n'));
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.equal(Object.hasOwn(result, 'searchFailures'), false);
  assert.equal(result.text, ANSWER);
});

test('a codex run whose output looks like OpenCode events reports no searchFailures', async () => {
  // Catches: the event reader applied to every backend, so a codex answer that quotes JSON is counted as failures.
  const { base, backend } = backendOf('codex', EVENTS);
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.equal(Object.hasOwn(result, 'searchFailures'), false);
});

test('the backend run log line carries the count of failed searches and none of their contents', async () => {
  // Catches: the failure going unlogged, or the error text or the query leaking into the journal.
  const { base, backend } = backendOf('opencode', EVENTS);
  const { logs } = await withCapturedLogs(() => backend.run('find the release notes', OPTIONS(base)));
  const line = logs.find((entry) => entry.msg === 'agent-runner: backend run');
  assert.ok(line, 'the run was logged');
  assert.equal(JSON.stringify(line).includes('"searchFailures":2'), true);
  const journal = JSON.stringify(logs);
  assert.equal(journal.includes(ERROR_TEXT), false);
  assert.equal(journal.includes(QUERY), false);
});

test('the engine puts the count on the task result of an opencode run', async () => {
  // Catches: the count stopping at the backend, so the errand's result never says the search failed.
  const base = tempDir('nep-oc-sfail-engine-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const profile = {
    name: 'scout',
    agentId: 'errand-scout',
    promptFiles: [prompt],
    modelRole: 'scout',
    defaultModel: 'x',
    defaultLimits: { steps: 5, seconds: 30 },
    defaultSearchProvider: 'exa',
    sandbox: 'read-only',
    search: false,
    buildConfig: () => ({ agent: {} }),
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: {
      privateDir: path.join(base, 'private'),
      denyDir: path.join(base, 'nosudo'),
      hostEnv: { PATH: '/usr/bin' },
      backendFactory: (name) => createBackend(name, { binary, spawnImpl: fakeSpawn(EVENTS) }),
    },
  });
  const task = {
    id: 'sf1',
    goal: 'find the release notes',
    context: {},
    route: { backend: 'opencode', model: null, effort: null, mode: 'read' },
    secrets: { openrouterKey: 'sk-or-v1-task-secret-0123456789' },
  } as unknown as Task;
  const outcome = await engine.run(task);
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.result.text, ANSWER);
  assert.equal(outcome.result.searchFailures, 2);
});
