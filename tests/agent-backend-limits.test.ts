// What each backend can bound, and proof at the spawn boundary. `backendLimits` says which step and output limits a
// backend enforces and through what; a fake executable reports the argv and environment it was really started with, so
// a claim without a control fails. Codex has neither control in this adapter, and says so: the timeout alone bounds it,
// and a run that asked for a cap carries a gap. Claude's JSON gives a run's real usage, which reaches the errand's usage.
// No backend, provider or core is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backendLimits, createBackend } from '../src/agent-runner/backend.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import type { BackendName } from '../src/agent-runner/profiles.ts';
import { SESSION_PURPOSE } from '../src/memory/db/session.ts';
import { memoryWriterClient } from '../src/subharness/memory-writer.ts';
import type { ChildRun } from '../src/subharness/memory-writer.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { consumerRig, consumers } from './fixtures/agent-consumers.ts';
import { STUB, reportOf, scratch } from './fixtures/backend-rig.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const STEPS = 7;
const OUTPUT = 1200;

/** One run of `name` through the seam every agent run uses, on the stub; what the stub saw, and the result. */
async function runOn(name: BackendName, dir: string) {
  const deps: RunDeps = {
    privateDir: dir,
    denyDir: path.join(dir, 'deny'),
    hostEnv: { PATH: process.env.PATH },
    backendFactory: (backend) => createBackend(backend, { binary: STUB }),
  };
  const result = await runAgent(
    {
      agent: 'scout',
      brief: 'look',
      cwd: dir,
      timeoutMs: 20_000,
      maxSteps: STEPS,
      maxOutputTokens: OUTPUT,
      env: { FAKE_MODE: 'report' },
      route: { backend: name, model: 'x/model', effort: null, mode: 'read' },
      ...(name === 'opencode' ? { routeKey: 'route-key' } : {}),
    },
    deps
  );
  return { result, seen: reportOf(result.text) };
}

test('claude claims its step and output limits, and the spawned process carries both', async () => {
  // Bug: the capability says enforced while the flag or the variable never reaches the child.
  assert.deepEqual(backendLimits('claude'), {
    steps: { enforced: true, via: '--max-turns' },
    output: { enforced: true, via: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS' },
  });
  const { dir, cleanup } = scratch();
  try {
    const { seen, result } = await runOn('claude', dir);
    assert.equal(seen.argv[seen.argv.indexOf('--max-turns') + 1], String(STEPS));
    assert.equal(seen.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(OUTPUT));
    assert.deepEqual(result.gaps ?? [], []);
  } finally {
    cleanup();
  }
});

test('opencode claims its output limit and no step limit, and the spawned process carries the output cap', async () => {
  // Bug: the output cap of the memory writer's sibling path is dropped on the floor and nobody can tell.
  // The steps expectation changed on the owner's word of 2026-11-05: OpenCode gets no step cap, because at the cap it
  // appends an assistant turn that Gemini and Anthropic refuse. Like Codex, only the timeout bounds it.
  assert.deepEqual(backendLimits('opencode'), {
    steps: { enforced: false, bound: 'timeout' },
    output: { enforced: true, via: 'OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX' },
  });
  const { dir, cleanup } = scratch();
  try {
    const { seen, result } = await runOn('opencode', dir);
    assert.equal(seen.env.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(seen.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, String(OUTPUT));
    assert.deepEqual(result.gaps ?? [], ['step-limit-not-enforced']);
  } finally {
    cleanup();
  }
});

test('codex claims no cap, gets no flag for one, and a run that asked for caps reports the gap', async () => {
  // Bug: the scout's 25 steps read as enforced on codex, where only the timeout ends a run that loops.
  assert.deepEqual(backendLimits('codex'), {
    steps: { enforced: false, bound: 'timeout' },
    output: { enforced: false, bound: 'timeout' },
  });
  const { dir, cleanup } = scratch();
  try {
    const { seen, result } = await runOn('codex', dir);
    assert.equal(seen.argv.includes('--max-turns'), false);
    assert.equal(seen.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
    assert.deepEqual([...(result.gaps ?? [])].sort(), ['output-limit-not-enforced', 'step-limit-not-enforced']);
  } finally {
    cleanup();
  }
});

test('the memory writer forwards its output cap to claude', async () => {
  // Bug: the sweep's maxOutputTokens stops at the subharness path, so a claude writer has no output cap at all.
  const privateDir = tempDir('nep-limits-memory-');
  writeKeysFile(privateDir, {
    subharness: {
      backends: ['claude'],
      key: null,
      modes: {},
      models: {},
      uses: {},
      memory: { backend: 'claude', model: 'x/model', effort: null },
    },
  });
  const { binary } = subharnessPlace(privateDir, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '', { mode: 0o755 });
  const runs: Array<ChildRun> = [];
  const client = memoryWriterClient({
    writer: {
      privateDir,
      workDir: path.join(privateDir, 'work'),
      runChild: (run) => {
        runs.push(run);
        const stdout = JSON.stringify({ type: 'result', is_error: false, result: 'kept', usage: {} });
        return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
      },
    },
    direct: { complete: () => Promise.reject(new Error('the direct path is not asked')) },
  });
  await client.complete([{ role: 'user', content: 'x' }], {
    purpose: SESSION_PURPOSE,
    timeoutMs: 1000,
    maxOutputTokens: OUTPUT,
  });
  assert.equal(runs[0]?.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(OUTPUT));
});

/** A stand-in for `claude -p --output-format json`: prints `FAKE_ENVELOPE` and reads the brief. */
function envelopeBinary(dir: string): string {
  const file = path.join(dir, 'claude-json');
  fs.writeFileSync(file, '#!/bin/sh\ncat >/dev/null\nprintf "%s" "$FAKE_ENVELOPE"\n', { mode: 0o755 });
  return file;
}

const ENVELOPE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'an answer',
  num_turns: 3,
  usage: { input_tokens: 120, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 45 },
};

test('a claude run reads its answer and its real usage out of the JSON it printed', async () => {
  // Bug: every claude run reports zero usage, because the plain text form carries none.
  const { dir, cleanup } = scratch();
  try {
    const backend = createBackend('claude', { binary: envelopeBinary(dir) });
    const result = await backend.run('hello', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { FAKE_ENVELOPE: JSON.stringify(ENVELOPE) },
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'an answer');
    assert.deepEqual(result.usage, { input: 160, cached: 30, output: 45, steps: 3 });
    const seen = reportOf(
      (
        await createBackend('claude', { binary: STUB }).run('hello', {
          cwd: dir,
          timeoutMs: 20_000,
          env: { FAKE_MODE: 'report' },
        })
      ).text
    );
    // stream-json with --verbose, not json: json prints only the last message as `result`, so a final answer claude
    // resumed after the output cap lost its head (session-bugs row 33).
    assert.equal(seen.argv[seen.argv.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(seen.argv.includes('--verbose'));
  } finally {
    cleanup();
  }
});

/** One line of claude's stream-json for a message's content block. */
const assistantLine = (id: string, block: Record<string, unknown>, stop: string): string =>
  JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [block], stop_reason: stop } });

test('a claude run resumed after the output cap answers with its whole final answer, not the last message', async () => {
  // Bug: the answer read from `result`, which holds only the message after claude's own resume prompt, so the errand
  // delivers the tail of its answer. The lines follow the shape of claude's transcripts: a tool round with its
  // narration, a final message cut at max_tokens, the resume prompt, and a second message that ends the answer.
  const { dir, cleanup } = scratch();
  try {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'x/model' }),
      assistantLine('msg_1', { type: 'text', text: 'Looking it up.' }, 'tool_use'),
      assistantLine('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} }, 'tool_use'),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found' }] },
      }),
      assistantLine('msg_2', { type: 'thinking', thinking: '' }, 'max_tokens'),
      assistantLine('msg_2', { type: 'text', text: 'The head of the answer, ' }, 'max_tokens'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Output token limit hit. Resume directly.' } }),
      assistantLine('msg_3', { type: 'text', text: 'and its tail.' }, 'end_turn'),
      JSON.stringify({ ...ENVELOPE, result: 'and its tail.' }),
    ].join('\n');
    const backend = createBackend('claude', { binary: envelopeBinary(dir) });
    const result = await backend.run('hello', { cwd: dir, timeoutMs: 20_000, env: { FAKE_ENVELOPE: stream } });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'The head of the answer, and its tail.');
  } finally {
    cleanup();
  }
});

test('a claude run whose JSON says is_error failed, whatever its exit code', async () => {
  // Bug: the error text of a refused run is delivered as the errand's answer.
  const { dir, cleanup } = scratch();
  try {
    const backend = createBackend('claude', { binary: envelopeBinary(dir) });
    const result = await backend.run('hello', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { FAKE_ENVELOPE: JSON.stringify({ ...ENVELOPE, is_error: true, result: 'Credit balance is too low' }) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.text, '');
  } finally {
    cleanup();
  }
});

test('the usage of a run reaches the errand, with its steps', async () => {
  // Bug: the engine throws the backend's numbers away and the errand reads input 0, steps 0.
  const rig = consumerRig();
  const engine = consumers.engine({
    profile: rig.profile,
    agentPaths: rig.options,
    outDir: path.join(rig.base, 'out'),
    subharness: {
      ...rig.subharness,
      backendFactory: (name) => ({
        name,
        run: () =>
          Promise.resolve({
            ok: true,
            text: 'done',
            exitCode: 0,
            usage: { input: 160, cached: 30, output: 45, steps: 3 },
          }),
      }),
    },
  });
  try {
    const done = await engine.run({
      id: 'usage',
      goal: 'inspect synthetic files',
      context: {},
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    assert.equal(done.usage.input, 160);
    assert.equal(done.usage.output, 45);
    assert.equal(done.usage.steps, 3);
  } finally {
    rig.close();
  }
});
