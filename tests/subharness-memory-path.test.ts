// The memory writer's path (spec 2026-11-02 PR 5, "The memory writer through a subharness"): `model set memory --via
// <backend> <model> [--effort <level>]` stores the subharness path in keys.json after one reply, `model set memory
// <model>` returns the writer to the direct path, and `subharness status` and the memory status line name the path.
// keys.json lives in a temp dir; the backend runner, its `--help` and fetch are fakes, so no process starts and no
// request leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMemoryPath, memoryPath, setMemoryPath } from '../src/subharness/memory-path.ts';
import { setAgentMode } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { createKeysCommands } from '../src/keys/commands.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { memorySessionStatusLine, sessionStatus } from '../src/memory/db/session.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { EffortLevel } from '../src/llm/roles.ts';
import { BASE_URL, SECRET, fakeFetch, fakePause, healthy } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';
import { memoryRing } from './fixtures/memory-db/session-rig.ts';

const HELP_WITH_EFFORT = 'Usage: claude [options]\n  --model <model>\n  --effort <level>  reasoning effort\n';
const HELP_WITHOUT_EFFORT = 'Usage: claude [options]\n  --model <model>\n';

type Ran = { name: string; model: string | undefined; effort: EffortLevel | undefined };

/** keys.json with the given backends connected and `subharness` laid over; the runner answers every model but `bad-model`. */
function rig(
  options: {
    backends?: Array<'codex' | 'claude' | 'opencode'>;
    help?: string | null;
    subharness?: Partial<KeysFile['subharness']>;
    extra?: Record<string, string>;
  } = {}
) {
  const dir = tempDir('nep-memory-path-');
  writeKeysFile(dir, {
    extra: options.extra ?? {},
    subharness: {
      backends: options.backends ?? ['codex', 'claude'],
      key: null,
      modes: {},
      models: {},
      uses: {},
      ...options.subharness,
    },
  });
  // Changed: a selection reads the real source, so each backend a rig calls connected is installed and logged in.
  for (const backend of options.backends ?? (['codex', 'claude'] as const))
    if (backend !== 'opencode') fakeVendor(dir, backend, { loggedIn: true });
  const ran: Array<Ran> = [];
  const help = options.help === undefined ? HELP_WITH_EFFORT : options.help;
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model, effort) => {
      ran.push({ name, model, effort });
      const ok = model !== 'bad-model';
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    ...(help === null ? {} : { helpOf: () => Promise.resolve(help) }),
  };
  return { dir, deps, ran };
}

const CLAUDE_PATH = { backend: 'claude', model: 'claude-opus-4-6', effort: null };

/** The line of `subharness status` that starts with two spaces and `name`. */
const lineOf = (text: string, name: string): string =>
  text.split('\n').find((line) => line.startsWith(`  ${name} `) || line.startsWith(`  ${name}\t`)) ?? '';

// model set memory --via

test('a subharness path is stored after one reply on its model and effort', async () => {
  // Catches: the path saved without a reply, so the first sweep finds a model the CLI refuses and she falls asleep.
  const { dir, deps, ran } = rig();
  const result = await setMemoryPath(deps, 'codex', 'gpt-6.1-sol', 'high');
  assert.equal(result.ok, true);
  assert.deepEqual(ran, [{ name: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
  assert.deepEqual(readKeysFile(dir).subharness.memory, { backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
});

test('the path reads as direct while keys.json holds no memory record', () => {
  // Catches: a missing record read as the first connected backend, which moves the writer off her key unasked.
  const { dir } = rig();
  assert.deepEqual(memoryPath(dir), { kind: 'direct' });
});

test('the path reads the stored record as the subharness path', () => {
  // Catches: the record written but never read, so the writer stays on the direct key after the owner moved it.
  const { dir } = rig({ subharness: { memory: CLAUDE_PATH } });
  assert.deepEqual(memoryPath(dir), {
    kind: 'subharness',
    backend: 'claude',
    model: 'claude-opus-4-6',
    effort: null,
  });
});

test('a backend that is not installed is refused before anything runs, and nothing is written', async () => {
  // Catches: a path stored on a backend with no login, so every writer run is refused and she sleeps.
  // Changed: the refusal comes from the source itself, not from a stored list.
  const { dir, deps, ran } = rig({ backends: ['codex'] });
  const result = await setMemoryPath(deps, 'claude', 'claude-opus-4-6');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-installed');
  assert.deepEqual(ran, []);
  assert.equal(readKeysFile(dir).subharness.memory ?? null, null);
});

test('opencode is refused as a memory backend even with its key', async () => {
  // Catches: the writer sent to `opencode run`, which has no flag to replace its own system prompt.
  const { dir, deps, ran } = rig({ extra: { agents: 'sk-x' }, subharness: { key: 'agents' } });
  const result = await setMemoryPath(deps, 'opencode', 'anthropic/claude-opus-4.6');
  assert.equal(result.code, 'backend-unsupported');
  assert.deepEqual(ran, []);
  assert.equal(readKeysFile(dir).subharness.memory ?? null, null);
});

test('a name that is no backend is refused', async () => {
  // Catches: a typo stored as the backend, which the next read drops and the writer silently goes direct.
  const { deps, ran } = rig();
  assert.equal((await setMemoryPath(deps, 'gemini', 'x')).code, 'unknown-backend');
  assert.deepEqual(ran, []);
});

test('an effort that is no level is refused before anything runs', async () => {
  // Catches: "max" handed to the CLI, which refuses it on the writer's first real run.
  const { dir, deps, ran } = rig();
  const result = await setMemoryPath(deps, 'codex', 'gpt-6.1-sol', 'max');
  assert.equal(result.code, 'unknown-effort');
  assert.deepEqual(ran, []);
  assert.equal(readKeysFile(dir).subharness.memory ?? null, null);
});

test('claude refuses an effort when its --help does not list --effort', async () => {
  // Catches: "--effort" passed to a claude that does not know it, so every writer run exits with an error.
  const { deps, ran } = rig({ help: HELP_WITHOUT_EFFORT });
  const result = await setMemoryPath(deps, 'claude', 'claude-opus-4-6', 'high');
  assert.equal(result.code, 'effort-unsupported');
  assert.deepEqual(ran, []);
});

test('a model whose reply fails keeps the path stored before', async () => {
  // Catches: the record overwritten before the reply, leaving the writer on a model that never answers.
  const { dir, deps } = rig({ subharness: { memory: CLAUDE_PATH } });
  const result = await setMemoryPath(deps, 'codex', 'bad-model');
  assert.equal(result.ok, false);
  assert.deepEqual(readKeysFile(dir).subharness.memory, CLAUDE_PATH);
});

test('a path set without an effort stores no effort, whatever was stored before', async () => {
  // Catches: a codex effort left on a record moved to claude, where the level means something else or is refused.
  const { dir, deps } = rig({ subharness: { memory: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' } } });
  await setMemoryPath(deps, 'claude', 'claude-opus-4-6');
  assert.deepEqual(readKeysFile(dir).subharness.memory, CLAUDE_PATH);
});

test('changing an agent mode keeps the memory path', async () => {
  // Catches: a write of the modes that rebuilds the subharness section without the record.
  const { dir } = rig({ subharness: { memory: CLAUDE_PATH } });
  await setAgentMode(dir, 'dev', 'full');
  assert.deepEqual(readKeysFile(dir).subharness.memory, CLAUDE_PATH);
});

test('a stored record naming opencode reads as the direct path', () => {
  // Catches: a hand-edited record that no run can serve taken as the path, so every writer run fails.
  const { dir } = rig({ subharness: { memory: { backend: 'opencode', model: 'x/y', effort: null } } });
  assert.deepEqual(memoryPath(dir), { kind: 'direct' });
});

test('a record whose backend was disconnected stays the subharness path', () => {
  // Catches: a disconnect that silently moves the writer to the direct key, spending money the owner moved away from.
  const { dir } = rig({ backends: ['codex'], subharness: { memory: CLAUDE_PATH } });
  assert.equal(memoryPath(dir).kind, 'subharness');
});

// back to the direct path

test('clearing the path removes the record and leaves the agents on their sources', () => {
  // Catches: the return to direct disconnecting the backend, so the agents that run through it are refused.
  // Changed: the agents' sources are their `uses` entries, into which the stored list migrated.
  const { dir } = rig({ subharness: { memory: CLAUDE_PATH } });
  const result = clearMemoryPath(dir);
  assert.equal(result.ok, true);
  assert.deepEqual(memoryPath(dir), { kind: 'direct' });
  assert.equal(readKeysFile(dir).subharness.uses?.dev, 'codex');
});

test('clearing a path that is direct already changes nothing', () => {
  // Catches: a rewrite of keys.json on every direct model set, which a concurrent enable can lose.
  const { dir } = rig();
  assert.equal(clearMemoryPath(dir).changed, false);
});

/** The key commands over a store with one core key; `directPath` records the roles it is called with. */
function keysRig(answer: (call: Call) => Reply = healthy) {
  const privateDir = tempDir('nep-memory-keys-');
  const store = createKeyStore({ privateDir });
  store.addCore({ name: 'core-1', value: SECRET });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 0 }) });
  const { fetch } = fakeFetch(answer);
  const direct: Array<string> = [];
  const keys = createKeysCommands({
    store,
    ring,
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: (role) => `current/${role}`,
    saveModel: () => Promise.resolve(),
    pause: fakePause(),
    directPath: (role) => {
      direct.push(role);
    },
  });
  return { keys, direct };
}

test('a direct model set of memory returns the writer to the direct path after its check', async () => {
  // Catches: "model set memory <model>" saves the direct model while the writer keeps running through the CLI.
  const { keys, direct } = keysRig();
  const answer = await keys.run('model.set', { role: 'memory', model: 'anthropic/claude-opus-4.6' }, null);
  assert.equal(answer.status, 'ok');
  assert.deepEqual(direct, ['memory']);
});

test('a direct model set of memory whose check fails keeps the subharness path', async () => {
  // Catches: the writer moved to a direct model that does not answer, and she sleeps on the next probe.
  const { keys, direct } = keysRig(() => ({ status: 404, body: { error: { message: 'no such model' } } }));
  const answer = await keys.run('model.set', { role: 'memory', model: 'x/gone' }, null);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(direct, []);
});

// the command line and the console

test('the table parses model set memory with --via and --effort', () => {
  // Catches: --via refused as an unknown flag, so the owner cannot reach the subharness path at all.
  const parsed = parseCommandLine('/model set memory --via claude claude-opus-4-6 --effort high');
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.args, { role: 'memory', via: 'claude', model: 'claude-opus-4-6', effort: 'high' });
});

/** What the core hands the console of `deps`: everything but the private directory, which the console has. */
const consoleSubharness = (deps: EnableDeps): ConsoleDeps['subharness'] => ({
  runBackend: (...args) => deps.runBackend(...args),
  fetch: (...args) => deps.fetch(...args),
  ...(deps.helpOf === undefined
    ? {}
    : { helpOf: (...args: Parameters<NonNullable<EnableDeps['helpOf']>>) => deps.helpOf!(...args) }),
});

/** A console over fakes: runOp records each operation, the key commands answer `keys answered`. */
function consoleOver(dir: string, subharness: ConsoleDeps['subharness']) {
  const ops: Array<string> = [];
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'ok', code: '', summary: '', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
    keys: { enabled: () => true, run: () => Promise.resolve({ text: 'keys answered', status: 'ok' }) },
    ...(subharness === undefined ? {} : { subharness }),
  };
  return { desk: createConsole(deps), ops };
}

test('model set memory without --via stays with the key commands', async () => {
  // Catches: every memory model set routed to the subharness, so the direct model can no longer be changed.
  const { dir, deps, ran } = rig();
  const { desk } = consoleOver(dir, consoleSubharness(deps));
  const answer = await desk.run('model.set', { role: 'memory', model: 'anthropic/claude-opus-4.6' }, { id: 'owner' });
  assert.equal(answer.text, 'keys answered');
  assert.deepEqual(ran, []);
});

// what the owner reads

test('subharness status names the memory writer backend and model', async () => {
  // Catches: the status lists the agents alone, so the owner cannot see that her memory runs on a subscription.
  const { deps } = rig({ subharness: { memory: { backend: 'claude', model: 'claude-opus-4-6', effort: 'high' } } });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  const line = lineOf(status.text, 'memory');
  for (const word of ['claude', 'claude-opus-4-6', 'high']) assert.ok(line.includes(word), `${word} on "${line}"`);
});

test('subharness status says the memory writer is direct when there is no record', async () => {
  // Catches: no memory line at all on the direct path, so a missing line cannot be told from a lost record.
  const { deps } = rig();
  const status = await subharnessCommand(deps, 'subharness.status', {});
  assert.ok(lineOf(status.text, 'memory').includes('direct'), status.text);
});

test('the memory status line names the subharness path it runs on', () => {
  // Catches: the status card shows the session as healthy with no word of the CLI it depends on.
  const handle = openMemoryDb(':memory:');
  const status = sessionStatus({
    db: dbOf(handle),
    config: { memoryDb: { session: { mode: 'apply' } } },
    env: {},
    ring: memoryRing(),
    prompts: { 'memory-session': 'SESSION' },
    path: { kind: 'subharness', backend: 'codex', model: 'gpt-6.1-sol', effort: null },
  });
  handle.close();
  const line = memorySessionStatusLine(status, { status: { memorySession: { line: 'session {mode} {path}' } } });
  assert.ok(line.includes('codex') && line.includes('gpt-6.1-sol'), line);
});

test('the memory status line says direct when no path is given', () => {
  // Catches: an absent path rendered as "{path}" or "undefined" on every deployment that never set one.
  const handle = openMemoryDb(':memory:');
  const status = sessionStatus({
    db: dbOf(handle),
    config: { memoryDb: { session: { mode: 'apply' } } },
    env: {},
    ring: memoryRing(),
    prompts: { 'memory-session': 'SESSION' },
  });
  handle.close();
  const line = memorySessionStatusLine(status, { status: { memorySession: { line: 'session {mode} {path}' } } });
  assert.ok(line.includes('direct'), line);
});
