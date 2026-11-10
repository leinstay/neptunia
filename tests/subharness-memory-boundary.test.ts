// PR 3, memory path parity: the memory writer proved at the spawn boundary, with a disposable executable that records the
// argv, the environment and stdin it really got (`runChildProcess`, src/agent-runner/backend.ts). Claude 2.1.317 enforces
// `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, measured live: with 20 a run ended is_error at 80 output tokens, with none 436 end_turn.
// So the writer passes it. Codex lists no such control, so there `maxOutputTokens` stays a reported gap. The installed releases
// list no output-token control in their help (claude 2.1.317, codex 0.164.0), so `maxOutputTokens` is a reported capability
// gap: nothing invents a flag and nothing trims her text. The tests also pin what the writer's parity consists of, how a
// failed selection and a failed source behave, and what `session_runs` records as the path that really ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runChildProcess } from '../src/agent-runner/backend.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { sweep } from '../src/memory/db/session.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import type { SubharnessMemoryPath } from '../src/subharness/memory-path.ts';
import { MEMORY_DOWN, createMemoryWatch, memoryProbe } from '../src/subharness/memory-probe.ts';
import * as memoryWriter from '../src/subharness/memory-writer.ts';
import { memoryWriterClient, runMemoryWriter } from '../src/subharness/memory-writer.ts';
import type { MemoryWriterDeps } from '../src/subharness/memory-writer.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeFetch, fakePause } from './fixtures/keys-rig.ts';
import { chat, ctxOf, fakeLlm, fixture, memoryBlock } from './fixtures/memory-db/session-rig.ts';
import type { LlmCall } from './fixtures/memory-db/session-shapes.ts';
import { tempDir } from './fixtures/tmp.ts';

const CLAUDE: SubharnessMemoryPath = { kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6', effort: null };
const CODEX: SubharnessMemoryPath = { kind: 'subharness', backend: 'codex', model: 'gpt-6.1-sol', effort: null };
const INPUT = { system: 'SYSTEM ΚΕΙΜΕΝΟ', user: 'USER ΓΡΑΜΜΕΣ', timeoutMs: 5000, maxOutputTokens: 8000 };

type Seen = { argv: Array<string>; env: Record<string, string>; stdin: string };

/**
 * A private layer with the executable of `backend` writing what it got into a file, then running `tail` as shell. codex
 * writes `final` to the file after `-o`, as the real CLI does.
 */
function boundary(backend: 'codex' | 'claude', tail: string, final = '') {
  const privateDir = tempDir('nep-memory-boundary-');
  writeKeysFile(privateDir, { subharness: { backends: [backend], key: null, modes: {} } });
  const { binary } = subharnessPlace(privateDir, backend);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const record = tempDir('nep-memory-record-');
  const finalFile = path.join(record, 'final');
  fs.writeFileSync(finalFile, final);
  fs.writeFileSync(
    binary,
    `#!/bin/sh
PATH=/usr/bin:/bin
for word in "$@"; do printf '%s\\000' "$word"; done > '${record}/argv'
env -0 > '${record}/env'
cat > '${record}/stdin'
previous=''
for word in "$@"; do
  if [ "$previous" = '-o' ]; then cat '${finalFile}' > "$word"; fi
  previous="$word"
done
${tail}
`,
    { mode: 0o755 }
  );
  const deps: MemoryWriterDeps = {
    privateDir,
    runChild: runChildProcess,
    workDir: tempDir('nep-memory-work-'),
  };
  const seen = (): Seen => ({
    argv: fs.readFileSync(path.join(record, 'argv'), 'utf8').split('\0').slice(0, -1),
    env: Object.fromEntries(
      fs
        .readFileSync(path.join(record, 'env'), 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
    ),
    stdin: fs.readFileSync(path.join(record, 'stdin'), 'utf8'),
  });
  return { privateDir, deps, seen };
}

const envelope = (fields: Record<string, unknown>): string =>
  `cat <<'JSON'\n${JSON.stringify({ type: 'result', is_error: false, ...fields })}\nJSON`;

const after = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

// maxOutputTokens

const INVENTED = /max.?(output|tokens|budget)/i;

test('claude gets the output cap in the variable it enforces, and reports no gap', async () => {
  // Catches: the sweep's cap stopping at the subharness path, or a guessed flag or a dollar budget that makes the CLI exit.
  // Changed: the variable was measured enforced, where the help alone had left this a gap.
  assert.equal(memoryWriter.memoryCapabilities('claude').maxOutputTokens, 'enforced');
  assert.deepEqual(memoryWriter.memoryGaps('claude'), []);
  const { deps, seen } = boundary('claude', envelope({ result: 'text' }));
  await runMemoryWriter(CLAUDE, INPUT, deps);
  const { argv, env } = seen();
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(INPUT.maxOutputTokens));
  assert.equal(
    argv.some((word) => INVENTED.test(word)),
    false,
    argv.join(' ')
  );
});

test('codex reports maxOutputTokens as a gap and no invented control reaches its argv or environment', async () => {
  // Catches: a limit passed to a mock and called enforced, or a guessed flag that makes the CLI exit.
  assert.equal(memoryWriter.memoryCapabilities('codex').maxOutputTokens, 'gap');
  const { deps, seen } = boundary('codex', 'exit 0', JSON.stringify({ answer: 'text' }));
  await runMemoryWriter(CODEX, INPUT, deps);
  const { argv, env } = seen();
  assert.equal(
    argv.some((word) => INVENTED.test(word)),
    false,
    argv.join(' ')
  );
  assert.equal(
    Object.keys(env).some((name) => INVENTED.test(name)),
    false
  );
});

test('an answer past the limit reaches the sweep whole, never trimmed', async () => {
  // Catches: "enforcing" the limit by cutting her generated text after the fact.
  const long = 'λ'.repeat(200_000);
  const { privateDir, deps } = boundary('claude', envelope({ result: long }));
  writeKeysFile(privateDir, {
    subharness: {
      backends: ['claude'],
      key: null,
      modes: {},
      memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
    },
  });
  const client = memoryWriterClient({ writer: deps, direct: fakeLlm('') });
  const completion = await client.complete([{ role: 'user', content: 'U' }], {
    role: 'memory',
    purpose: 'memory-session',
    timeoutMs: 5000,
    maxOutputTokens: 10,
  });
  assert.equal(completion.text, long);
});

function statusDeps(privateDir: string): EnableDeps {
  return {
    privateDir,
    fetch: fakeFetch().fetch,
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
  };
}

const memoryRowOf = (text: string): string => text.split('\n').find((line) => line.trim().startsWith('memory ')) ?? '';

test('/subharness status names the gap of a codex memory path, and none on claude or on the direct one', async () => {
  // Catches: the owner reads the codex path as equal to the direct one, whose limit the request does enforce.
  // Changed: claude enforces the cap now, so the gap is codex's alone.
  const rowOn = async (memory: { backend: string; model: string; effort: null } | null): Promise<string> => {
    const dir = tempDir('nep-memory-boundary-');
    writeKeysFile(dir, { subharness: { key: null, modes: {}, memory } });
    return memoryRowOf((await subharnessCommand(statusDeps(dir), 'subharness.status', {})).text);
  };
  const onCodex = await rowOn({ backend: 'codex', model: 'gpt-6.1-sol', effort: null });
  assert.ok(onCodex.includes('maxOutputTokens'), onCodex);
  const onClaude = await rowOn({ backend: 'claude', model: 'claude-opus-4-6', effort: null });
  assert.equal(onClaude.includes('maxOutputTokens'), false, onClaude);
  const direct = await rowOn(null);
  assert.equal(direct.includes('maxOutputTokens'), false, direct);
});

function probeDeps(privateDir: string, ran: Array<string>, answer: { ok: boolean; detail?: string }) {
  const { fetch, calls } = fakeFetch();
  return {
    calls,
    deps: {
      privateDir,
      route: () => ({ name: 'core-1', value: 'value' }),
      fetch,
      baseUrl: 'https://openrouter.test/api/v1',
      model: () => 'x/memory',
      runBackend: (name: 'codex' | 'claude') => {
        ran.push(name);
        return Promise.resolve({ ok: answer.ok, text: answer.ok ? 'ok' : '', exitCode: answer.ok ? 0 : 1 });
      },
    },
  };
}

function selectedClaude(loggedIn: boolean) {
  const privateDir = tempDir('nep-memory-boundary-');
  writeKeysFile(privateDir, {
    subharness: {
      backends: ['claude'],
      key: null,
      modes: {},
      memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
    },
  });
  const vendor = fakeVendor(privateDir, 'claude', { loggedIn });
  return { privateDir, vendor };
}

test('a passing probe carries the gap of its backend, so a green probe on codex claims no parity', async () => {
  // Catches: "memory: ok" read as full parity by status and by the operator.
  // Changed: claude enforces the cap now, so its probe carries no gap.
  const onClaude = selectedClaude(true);
  const claude = await memoryProbe(probeDeps(onClaude.privateDir, [], { ok: true }).deps, 1);
  assert.deepEqual(claude.ok && claude.gaps, []);
  const dir = tempDir('nep-memory-boundary-');
  writeKeysFile(dir, {
    subharness: { key: null, modes: {}, memory: { backend: 'codex', model: 'gpt-6.1-sol', effort: null } },
  });
  fakeVendor(dir, 'codex', { loggedIn: true });
  const codex = await memoryProbe(probeDeps(dir, [], { ok: true }).deps, 1);
  assert.deepEqual(codex.ok && codex.gaps, ['maxOutputTokens']);
});

// The rest of parity, at the boundary

test('claude: its system prompt is replaced and it has no tools, in the argv the child really got', async () => {
  // Catches: a change to the run that keeps the mock's fields and loses the flags, so her session runs as a coding agent.
  const { deps, seen } = boundary('claude', envelope({ result: 'text' }));
  await runMemoryWriter(CLAUDE, INPUT, deps);
  const { argv, stdin } = seen();
  assert.equal(after(argv, '--system-prompt'), INPUT.system);
  assert.equal(after(argv, '--tools'), '');
  assert.equal(stdin, INPUT.user);
  assert.equal(memoryWriter.memoryCapabilities('claude').systemPrompt, 'replaced');
  assert.equal(memoryWriter.memoryCapabilities('claude').tools, 'none');
});

test('codex: the system text arrives in its stdin in a read-only sandbox, and the capabilities say that is not the same', async () => {
  // Catches: codex reported as equal to claude, when its own instructions stay in force and its shell stays available.
  const { deps, seen } = boundary('codex', 'exit 0', JSON.stringify({ answer: 'text' }));
  await runMemoryWriter(CODEX, INPUT, deps);
  const { argv, stdin } = seen();
  assert.equal(after(argv, '-s'), 'read-only');
  assert.ok(stdin.startsWith(INPUT.system), stdin);
  assert.equal(memoryWriter.memoryCapabilities('codex').systemPrompt, 'prefixed');
  assert.equal(memoryWriter.memoryCapabilities('codex').tools, 'read-only-sandbox');
});

test('the child gets her own home and no key of the core', async () => {
  // Catches: the writer's child inheriting a provider key, and billing the wrong account behind the subscription.
  process.env.OPENROUTER_API_KEY = 'must-not-reach-the-child';
  try {
    const { privateDir, deps, seen } = boundary('claude', envelope({ result: 'text' }));
    await runMemoryWriter(CLAUDE, INPUT, deps);
    const { env } = seen();
    assert.equal(env.CLAUDE_CONFIG_DIR, subharnessPlace(privateDir, 'claude').env.CLAUDE_CONFIG_DIR);
    assert.equal(env.OPENROUTER_API_KEY, undefined);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('a run past its timeout is killed with its children and refused timeout', async () => {
  // Catches: a hung CLI holding the writer and every sweep after it; a grandchild keeping the pipes open.
  const { deps } = boundary('claude', 'sleep 30 &\nwait');
  const started = Date.now();
  await assert.rejects(
    runMemoryWriter(CLAUDE, { ...INPUT, timeoutMs: 150 }, deps),
    (error: unknown) => (error as { code?: string }).code === 'timeout'
  );
  assert.ok(Date.now() - started < 3000);
});

test('a refusal in the envelope is a refused run, never an answer to parse', async () => {
  // Catches: the model's refusal text treated as a memory answer, which the sweep then records as a bad answer.
  const { deps } = boundary('claude', envelope({ result: 'I will not do that.', stop_reason: 'refusal' }));
  await assert.rejects(
    runMemoryWriter(CLAUDE, INPUT, deps),
    (error: unknown) => (error as { code?: string }).code === 'model-refused'
  );
});

test('an envelope cut at the token limit is refused, so the cursor stays and nothing half-written is applied', async () => {
  // Catches: a truncated memory block parsed as far as it goes, or text trimmed to look complete.
  const { deps } = boundary('claude', envelope({ result: '<memory>', stop_reason: 'max_tokens' }));
  await assert.rejects(
    runMemoryWriter(CLAUDE, INPUT, deps),
    (error: unknown) => (error as { code?: string }).code === 'output-truncated'
  );
});

// A failed source

test('a selected source that logged out fails the probe with its code and runs no model', async () => {
  // Catches: a probe that spends a run to learn what the login state already says, or a misleading no-reply.
  const { privateDir } = selectedClaude(false);
  const ran: Array<string> = [];
  const result = await memoryProbe(probeDeps(privateDir, ran, { ok: true }).deps, 1);
  assert.deepEqual(result, { ok: false, code: 'not-logged-in', at: 1 });
  assert.deepEqual(ran, []);
});

test('a failed selected source pauses her, chooses no other model, and the next pass resumes her', async () => {
  // Catches: a fallback to the OpenRouter memory key, or to another backend, when her chosen writer is down.
  const { privateDir, vendor } = selectedClaude(false);
  const before = readKeysFile(privateDir).subharness.memory;
  const ran: Array<string> = [];
  const { deps, calls } = probeDeps(privateDir, ran, { ok: true });
  const pause = fakePause();
  const watch = createMemoryWatch({
    probe: (now) => memoryProbe(deps, now),
    pause,
    now: () => 1,
    config: () => ({}),
  });
  assert.equal((await watch.start()).ok, false);
  assert.deepEqual(pause.pauses, [MEMORY_DOWN]);
  assert.deepEqual(calls, []);
  assert.deepEqual(readKeysFile(privateDir).subharness.memory, before);
  fs.mkdirSync(vendor.home, { recursive: true });
  fs.writeFileSync(path.join(vendor.home, 'credentials'), '');
  assert.equal((await watch.refused()).ok, true);
  assert.equal(pause.resumes, 1);
  assert.deepEqual(ran, ['claude']);
});

// session_runs

/** A session client over a recorded path, as `session_runs` sees it through the sweep. */
function sweepClient(deps: MemoryWriterDeps) {
  const client = memoryWriterClient({ writer: deps, direct: fakeLlm(memoryBlock({ claims: [] })) });
  return {
    calls: [] as Array<LlmCall>,
    complete: (messages: LlmCall['messages'], options: LlmCall['options']) => client.complete(messages, options),
  };
}

test('session_runs records the backend and model that really ran, not the role model of the config', async () => {
  // Catches: a Claude session stored under the direct model's name, so no later reading can tell who wrote the memory.
  const env = fixture();
  try {
    chat(env);
    const { privateDir, deps } = boundary('claude', envelope({ result: memoryBlock({ claims: [] }) }));
    writeKeysFile(privateDir, {
      subharness: {
        backends: ['claude'],
        key: null,
        modes: {},
        memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
      },
    });
    const result = await sweep(ctxOf(env, { llm: sweepClient(deps) }));
    assert.equal(result.runs[0]?.outcome, 'ok');
    assert.equal(env.db.prepare('SELECT model FROM session_runs').get()?.model, 'claude:claude-opus-4-6');
  } finally {
    env.done();
  }
});

test('a failed subharness run records the path that failed too', async () => {
  // Catches: the row of the very run someone needs to diagnose naming a model that was never asked.
  const env = fixture();
  try {
    chat(env);
    const { privateDir, deps } = boundary('claude', 'exit 1');
    writeKeysFile(privateDir, {
      subharness: {
        backends: ['claude'],
        key: null,
        modes: {},
        memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
      },
    });
    const result = await sweep(ctxOf(env, { llm: sweepClient(deps) }));
    assert.equal(result.runs[0]?.outcome, 'llm_error');
    assert.equal(env.db.prepare('SELECT model FROM session_runs').get()?.model, 'claude:claude-opus-4-6');
  } finally {
    env.done();
  }
});
