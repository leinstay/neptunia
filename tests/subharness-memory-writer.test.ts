// The memory writer through a subharness (spec 2026-11-02 PR 5, "The memory writer through a subharness"): the sweep's
// request goes to claude or codex as one run with no tools, the system text replacing the backend's own, the user
// content on stdin, the answer read by the same parser; a failed run is a failed request to the sweep; the usage store
// counts a subharness run at cost 0. The child runner is a recorder that answers from a script, so nothing spawns; the
// database is in memory, the binaries are empty executable files in a temp private layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_ANSWER_SCHEMA, memoryWriterClient, runMemoryWriter } from '../src/subharness/memory-writer.ts';
import type { ChildOutcome, ChildRun, MemoryWriterDeps } from '../src/subharness/memory-writer.ts';
import type { SubharnessMemoryPath } from '../src/subharness/memory-path.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { sweep } from '../src/memory/db/session.ts';
import { createUsage } from '../src/tools/impl/usage.ts';
import type { UsageEntry } from '../src/tools/impl/usage.ts';
import { baseConfig, chat, ctxOf, fakeLlm, fixture, memoryBlock } from './fixtures/memory-db/session-rig.ts';
import type { LlmCall } from './fixtures/memory-db/session-shapes.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const CLAUDE: SubharnessMemoryPath = { kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6', effort: null };
const CODEX: SubharnessMemoryPath = { kind: 'subharness', backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
const ANSWER = memoryBlock({ claims: [] });

/** What claude -p --output-format json prints for `result`. */
const claudeEnvelope = (result: string, usage: Record<string, number> = {}): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, usage });

type Seen = ChildRun & { schema: unknown };

/**
 * A private layer with `backends` connected and their binaries in place, and a child runner that records each run and
 * answers with `answer(run)`. For codex it writes the final message to the file after `-o`, as the CLI does.
 */
function rig(
  answer: (run: ChildRun) => ChildOutcome & { final?: string },
  options: {
    backends?: Array<'codex' | 'claude'>;
    installed?: boolean;
    subharness?: Partial<KeysFile['subharness']>;
  } = {}
) {
  const privateDir = tempDir('nep-memory-writer-');
  const backends = options.backends ?? ['codex', 'claude'];
  writeKeysFile(privateDir, {
    subharness: { backends, key: null, modes: {}, models: {}, uses: {}, ...options.subharness },
  });
  if (options.installed !== false) {
    for (const name of ['codex', 'claude'] as const) {
      const { binary } = subharnessPlace(privateDir, name);
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
    }
  }
  const seen: Array<Seen> = [];
  const runChild = (run: ChildRun): Promise<ChildOutcome> => {
    const at = run.args.indexOf('--output-schema');
    const schema: unknown = at === -1 ? null : JSON.parse(fs.readFileSync(run.args[at + 1], 'utf8'));
    seen.push({ ...run, schema });
    const { final, ...outcome } = answer(run);
    const out = run.args.indexOf('-o');
    if (out !== -1 && final !== undefined) fs.writeFileSync(run.args[out + 1], final);
    return Promise.resolve(outcome);
  };
  const workDir = tempDir('nep-memory-work-');
  const deps: MemoryWriterDeps = { privateDir, runChild, workDir };
  return { privateDir, deps, seen };
}

const claudeAnswers =
  (result: string, usage: Record<string, number> = {}) =>
  (): ChildOutcome => ({ exitCode: 0, stdout: claudeEnvelope(result, usage), stderr: '' });

const codexAnswers =
  (final: string, stderr = '') =>
  (): ChildOutcome & { final: string } => ({ exitCode: 0, stdout: '', stderr, final });

const INPUT = { system: 'SYSTEM TEXT of the session', user: 'USER LINES of the batch', timeoutMs: 120_000 };

/** The flag's value in an argv. */
const after = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

/** A session client over the rig, with the sweep's fake llm as the direct path. */
function clientOf(
  deps: MemoryWriterDeps,
  extra: { record?: (entry: UsageEntry) => void; onRefused?: () => void; direct?: ReturnType<typeof fakeLlm> } = {}
) {
  const direct = extra.direct ?? fakeLlm(ANSWER);
  const client = memoryWriterClient({
    writer: deps,
    direct,
    ...(extra.record === undefined ? {} : { record: extra.record }),
    ...(extra.onRefused === undefined ? {} : { onRefused: extra.onRefused }),
  });
  // The sweep's rig types its llm with the calls it recorded; this one records none of its own.
  const llm = {
    calls: [] as Array<LlmCall>,
    complete: (messages: LlmCall['messages'], options: LlmCall['options']) => client.complete(messages, options),
  };
  return { llm, direct };
}

// the run on claude

test('claude runs with the system text replacing its own prompt, no tools, JSON out and the model', async () => {
  // Catches: the writer run with claude's own system prompt and tools, so it answers as a coding agent, not as her.
  const { deps, seen } = rig(claudeAnswers(ANSWER));
  await runMemoryWriter(CLAUDE, INPUT, deps);
  const { args } = seen[0];
  assert.equal(args[0], '-p');
  assert.equal(after(args, '--system-prompt'), INPUT.system);
  assert.equal(after(args, '--tools'), '');
  assert.equal(after(args, '--output-format'), 'json');
  assert.equal(after(args, '--model'), 'claude-opus-4-6');
});

test('claude gets the user content on stdin and the system text nowhere else', async () => {
  // Catches: system and user both on stdin, so the system text reaches the model twice and the cache never holds.
  const { deps, seen } = rig(claudeAnswers(ANSWER));
  await runMemoryWriter(CLAUDE, INPUT, deps);
  assert.equal(seen[0].stdin, INPUT.user);
});

test('claude gets --effort only when the path has an effort', async () => {
  // Catches: "--effort null" on a path stored without one, or the stored effort never reaching the CLI.
  const withEffort = rig(claudeAnswers(ANSWER));
  await runMemoryWriter({ ...CLAUDE, effort: 'low' }, INPUT, withEffort.deps);
  assert.equal(after(withEffort.seen[0].args, '--effort'), 'low');
  const without = rig(claudeAnswers(ANSWER));
  await runMemoryWriter(CLAUDE, INPUT, without.deps);
  assert.equal(without.seen[0].args.includes('--effort'), false);
});

test('claude runs her own binary with her own home and no key of the core in its environment', async () => {
  // Catches: the writer run on the installing user's claude, or the child handed the core's OpenRouter key.
  const before = process.env.OPENROUTER_CORE_KEY;
  process.env.OPENROUTER_CORE_KEY = 'sk-or-v1-SECRETVALUE-0001-WXYZ';
  try {
    const { deps, seen, privateDir } = rig(claudeAnswers(ANSWER));
    await runMemoryWriter(CLAUDE, INPUT, deps);
    const place = subharnessPlace(privateDir, 'claude');
    assert.equal(seen[0].binary, place.binary);
    assert.equal(seen[0].env.CLAUDE_CONFIG_DIR, place.env.CLAUDE_CONFIG_DIR);
    assert.ok(!Object.values(seen[0].env).includes('sk-or-v1-SECRETVALUE-0001-WXYZ'));
  } finally {
    if (before === undefined) delete process.env.OPENROUTER_CORE_KEY;
    else process.env.OPENROUTER_CORE_KEY = before;
  }
});

test('claude answers with the result of its envelope and the tokens it reports', async () => {
  // Catches: the whole JSON envelope handed to the parser, which finds no <memory> block, or the cache tokens dropped.
  const usage = { input_tokens: 12, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 };
  const { deps } = rig(claudeAnswers(ANSWER, usage));
  const completion = await runMemoryWriter(CLAUDE, INPUT, deps);
  assert.equal(completion.text, ANSWER);
  assert.equal(completion.usage?.prompt_tokens, 1012);
  assert.equal(completion.usage?.prompt_tokens_details?.cached_tokens, 900);
  assert.equal(completion.usage?.completion_tokens, 50);
});

test('claude reporting no usage answers zero tokens', async () => {
  // Catches: NaN or undefined counts from an envelope without usage, which the usage store then sums as garbage.
  const { deps } = rig(() => ({ exitCode: 0, stdout: JSON.stringify({ type: 'result', result: ANSWER }), stderr: '' }));
  const completion = await runMemoryWriter(CLAUDE, INPUT, deps);
  assert.equal(completion.usage?.prompt_tokens, 0);
  assert.equal(completion.usage?.completion_tokens, 0);
});

test('a claude envelope marked as an error is a refused run', async () => {
  // Catches: claude's own error text ("credit balance too low") parsed as her answer and written as bad_answer.
  const { deps } = rig(() => ({
    exitCode: 0,
    stdout: JSON.stringify({ type: 'result', is_error: true, result: 'limit reached' }),
    stderr: '',
  }));
  await assert.rejects(runMemoryWriter(CLAUDE, INPUT, deps), { code: 'backend-error' });
});

// the run on codex

test('codex runs read-only with the answer schema, the final-message file, the model and the effort', async () => {
  // Catches: the writer run in the agents' sudo mode, or without the schema, so codex answers in free prose.
  const { deps, seen } = rig(codexAnswers(JSON.stringify({ answer: ANSWER })));
  await runMemoryWriter(CODEX, INPUT, deps);
  const { args, schema } = seen[0];
  assert.equal(args[0], 'exec');
  assert.equal(after(args, '-s'), 'read-only');
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.deepEqual(schema, MEMORY_ANSWER_SCHEMA);
  assert.ok(after(args, '-o'));
  assert.equal(after(args, '-m'), 'gpt-6.1-sol');
  assert.equal(after(args, '-c'), 'model_reasoning_effort=high');
});

test('codex gets the system text first and the user content after it on stdin', async () => {
  // Catches: the system text dropped on codex, which has no flag for it, so the writer forgets who she is.
  const { deps, seen } = rig(codexAnswers(JSON.stringify({ answer: ANSWER })));
  await runMemoryWriter(CODEX, INPUT, deps);
  assert.ok(seen[0].stdin.startsWith(INPUT.system), seen[0].stdin);
  assert.ok(seen[0].stdin.endsWith(INPUT.user), seen[0].stdin);
});

test('codex answers with the answer field of its final message and the tokens it printed', async () => {
  // Catches: the schema's JSON wrapper handed to the parser, or the codex token count lost.
  const { deps } = rig(codexAnswers(JSON.stringify({ answer: ANSWER }), 'tokens used\n17,065\n'));
  const completion = await runMemoryWriter(CODEX, INPUT, deps);
  assert.equal(completion.text, ANSWER);
  assert.equal(completion.usage?.completion_tokens, 17065);
  assert.equal(completion.usage?.prompt_tokens, 0);
});

test('the run waits as long as the sweep allows a request', async () => {
  // Catches: a fixed or missing timeout, so a hung CLI holds the writer and every sweep after it.
  const { deps, seen } = rig(claudeAnswers(ANSWER));
  await runMemoryWriter(CLAUDE, { ...INPUT, timeoutMs: 123_456 }, deps);
  assert.equal(seen[0].timeoutMs, 123_456);
});

// refused runs

test('a backend that is no longer connected is refused subharness-off and nothing runs', async () => {
  // Catches: the writer run on a backend the owner disconnected, on a login that may be gone.
  const { deps, seen } = rig(claudeAnswers(ANSWER), { backends: ['codex'] });
  await assert.rejects(runMemoryWriter(CLAUDE, INPUT, deps), { code: 'subharness-off' });
  assert.equal(seen.length, 0);
});

test('a backend that is not installed is refused not-installed and nothing runs', async () => {
  // Catches: a spawn of a binary that is not there, reported as a vague spawn error.
  const { deps, seen } = rig(claudeAnswers(ANSWER), { installed: false });
  await assert.rejects(runMemoryWriter(CLAUDE, INPUT, deps), { code: 'not-installed' });
  assert.equal(seen.length, 0);
});

test('a run that exits non-zero is refused with its exit code', async () => {
  // Catches: the stdout of a crashed run (a login prompt, a usage text) taken as her answer.
  const { deps } = rig(() => ({ exitCode: 1, stdout: 'Please log in', stderr: '' }));
  await assert.rejects(runMemoryWriter(CLAUDE, INPUT, deps), { code: 'exit-1' });
});

test('a run stopped by its timeout is refused timeout', async () => {
  // Catches: a killed run read as an empty answer, so the probe never learns the subscription stopped answering.
  const { deps } = rig(() => ({ exitCode: null, stdout: '', stderr: '', error: 'timeout' }));
  await assert.rejects(runMemoryWriter(CODEX, INPUT, deps), { code: 'timeout' });
});

// through the sweep

test('a sweep on the subharness path writes the answer as a direct sweep does', async () => {
  // Catches: the subharness answer read by another parser than parseSessionAnswer, or not written at all.
  const env = fixture();
  try {
    chat(env);
    const { deps, privateDir } = rig(claudeAnswers(ANSWER, { input_tokens: 700, output_tokens: 40 }));
    writeKeysFile(privateDir, {
      subharness: {
        backends: ['claude'],
        key: null,
        modes: {},
        memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
      },
    });
    const { llm, direct } = clientOf(deps);
    const result = await sweep(ctxOf(env, { llm }));
    assert.equal(result.runs[0]?.outcome, 'ok');
    assert.equal(direct.calls.length, 0);
    const run = env.db.prepare('SELECT outcome, tokens_prompt, tokens_completion FROM session_runs').get();
    assert.equal(run?.outcome, 'ok');
    assert.equal(run?.tokens_prompt, 700);
    assert.equal(run?.tokens_completion, 40);
  } finally {
    env.done();
  }
});

test('a sweep whose subharness run fails records llm_error with the code and leaves the lines', async () => {
  // Catches: a failed CLI run written as an empty answer, which moves the cursor past lines she never read.
  const env = fixture();
  try {
    chat(env);
    const { deps, privateDir } = rig(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    writeKeysFile(privateDir, {
      subharness: {
        backends: ['claude'],
        key: null,
        modes: {},
        memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
      },
    });
    const { llm } = clientOf(deps);
    const result = await sweep(ctxOf(env, { llm }));
    assert.equal(result.runs[0]?.outcome, 'llm_error');
    const run = env.db.prepare('SELECT errors FROM session_runs').get();
    assert.deepEqual(JSON.parse(String(run?.errors)), ['llm:exit-1']);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'memory_session.cursor.%'").get()?.n, 0);
  } finally {
    env.done();
  }
});

test('a codex final message that is not the schema shape is a bad answer, not a crash', async () => {
  // Catches: JSON.parse of free prose throwing out of the run, so the sweep records llm_error and she falls asleep.
  const env = fixture();
  try {
    chat(env);
    const { deps, privateDir } = rig(codexAnswers('I could not do that'));
    writeKeysFile(privateDir, {
      subharness: {
        backends: ['codex'],
        key: null,
        modes: {},
        memory: { backend: 'codex', model: 'gpt-6.1-sol', effort: null },
      },
    });
    const { llm } = clientOf(deps);
    const result = await sweep(ctxOf(env, { llm }));
    assert.equal(result.runs[0]?.outcome, 'bad_answer');
  } finally {
    env.done();
  }
});

// the client: which path, usage and the refusal signal

test('the client sends the request to the direct model while keys.json holds no memory path', async () => {
  // Catches: the writer sent to a connected CLI just because one is connected.
  const env = fixture();
  try {
    chat(env);
    const { deps, seen } = rig(claudeAnswers(ANSWER));
    const { llm, direct } = clientOf(deps);
    await sweep(ctxOf(env, { llm, config: baseConfig() }));
    assert.equal(direct.calls.length, 1);
    assert.equal(seen.length, 0);
  } finally {
    env.done();
  }
});

test('the client reads the path at each call, so a change from the chat acts on the next request', async () => {
  // Catches: the path read once at start, so "model set memory --via" needs a restart to take effect.
  const { deps, seen, privateDir } = rig(claudeAnswers(ANSWER));
  const { llm, direct } = clientOf(deps);
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: [{ type: 'text', text: 'U' }] },
  ];
  const options = { role: 'memory', purpose: 'memory-session', model: 'x/memory' };
  await llm.complete(messages, options);
  writeKeysFile(privateDir, {
    subharness: {
      backends: ['claude'],
      key: null,
      modes: {},
      memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
    },
  });
  await llm.complete(messages, options);
  assert.equal(direct.calls.length, 1);
  assert.equal(seen.length, 1);
});

test('a subharness run is counted under memory at cost 0 with its tokens, and the core rows stay empty', async () => {
  // Catches: subscription runs priced as API spend, or counted under core, which shrinks the week's turns line.
  const { deps } = rig(claudeAnswers(ANSWER, { input_tokens: 300, output_tokens: 20 }), {
    subharness: { memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null } },
  });
  const usage = createUsage({ dataDir: tempDir('nep-memory-usage-'), now: () => Date.parse('2026-11-02T12:00:00Z') });
  const { llm } = clientOf(deps, { record: (entry) => usage.record(entry) });
  await llm.complete(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: [{ type: 'text', text: 'U' }] },
    ],
    { role: 'memory', purpose: 'memory-session', model: 'x/memory' }
  );
  const memory = usage.sumDays(1, { only: ['memory'] }).total;
  assert.equal(memory.requests, 1);
  assert.equal(memory.cost, 0);
  assert.equal(memory.promptTokens, 300);
  assert.equal(memory.completionTokens, 20);
  assert.equal(usage.sumDays(1, { only: ['core'] }).total.requests, 0);
});

test('a direct request is not recorded by the client, the llm usage line counts it already', async () => {
  // Catches: every direct memory request counted twice, once by the llm log line and once by the client.
  const { deps } = rig(claudeAnswers(ANSWER));
  const recorded: Array<UsageEntry> = [];
  const { llm } = clientOf(deps, { record: (entry) => recorded.push(entry) });
  await llm.complete(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: [{ type: 'text', text: 'U' }] },
    ],
    { role: 'memory', purpose: 'memory-session', model: 'x/memory' }
  );
  assert.deepEqual(recorded, []);
});

test('a refused subharness run is told once and is not recorded as usage', async () => {
  // Catches: the probe never woken by a refused run, so she keeps writing nothing for a whole probe interval.
  const { deps } = rig(() => ({ exitCode: 1, stdout: '', stderr: '' }), {
    subharness: { memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null } },
  });
  let refused = 0;
  const recorded: Array<UsageEntry> = [];
  const { llm } = clientOf(deps, { onRefused: () => (refused += 1), record: (entry) => recorded.push(entry) });
  await assert.rejects(
    llm.complete(
      [
        { role: 'system', content: 'S' },
        { role: 'user', content: [{ type: 'text', text: 'U' }] },
      ],
      { role: 'memory', purpose: 'memory-session', model: 'x/memory' }
    )
  );
  assert.equal(refused, 1);
  assert.deepEqual(recorded, []);
});

test('a refused direct request is told too', async () => {
  // Catches: the probe woken only on the subharness path, so a dead direct key goes unnoticed until the interval.
  const { deps } = rig(claudeAnswers(ANSWER));
  let refused = 0;
  const failing = fakeLlm(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
  const { llm } = clientOf(deps, { direct: failing, onRefused: () => (refused += 1) });
  await assert.rejects(
    llm.complete(
      [
        { role: 'system', content: 'S' },
        { role: 'user', content: [{ type: 'text', text: 'U' }] },
      ],
      { role: 'memory', purpose: 'memory-session', model: 'x/memory' }
    )
  );
  assert.equal(refused, 1);
});
