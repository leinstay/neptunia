// A path per role on the subharness side (spec 2026-11-02 PR 5, "A path per role"): `subharness use <agent> <backend>`
// names the backend an agent runs through, `model set <agent> <model> [--effort <level>]` names its model and effort
// after one reply, the status lists each agent's path, and the six direct roles have no subharness path. keys.json lives
// in a temp dir; the backend runner, its `--help` and fetch are fakes, so no process starts and no request goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DIRECT_ONLY_ROLES, setAgentModel, useBackend } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { listModels } from '../src/subharness/models.ts';
import { runAgent } from '../src/subharness/run.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import type { Backend, BackendRunOptions } from '../src/agent-runner/backend.ts';
import type { EffortLevel } from '../src/llm/roles.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const HELP_WITH_EFFORT = 'Usage: claude [options]\n  --model <model>\n  --effort <level>  reasoning effort\n';
const HELP_WITHOUT_EFFORT = 'Usage: claude [options]\n  --model <model>\n';

type Ran = { name: string; model: string | undefined; effort: EffortLevel | undefined };

/** keys.json with codex and claude connected; the runner answers for every model but `bad-model`. */
function rig(options: { help?: string | null; backends?: Array<'codex' | 'claude' | 'opencode'> } = {}) {
  const dir = tempDir('nep-paths-');
  writeKeysFile(dir, {
    subharness: { backends: options.backends ?? ['codex', 'claude'], key: null, modes: {}, models: {}, uses: {} },
  });
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

/** The status line of one agent: two spaces, then its name. */
const lineOf = (text: string, agent: string): string =>
  text.split('\n').find((line) => line.startsWith(`  ${agent} `) || line.startsWith(`  ${agent}\t`)) ?? '';

// subharness use

test('use stores the backend an agent runs through', async () => {
  // Catches: the agent keeps running through the first connected backend whatever the owner named.
  const { dir } = rig();
  const result = await useBackend(dir, 'dev', 'claude');
  assert.equal(result.ok, true);
  assert.equal(readKeysFile(dir).subharness.uses?.dev, 'claude');
});

test('use refuses a backend that is not connected and writes nothing', async () => {
  // Catches: an agent pointed at a backend with no login, so every task of it is refused at run time.
  const { dir } = rig({ backends: ['codex'] });
  const result = await useBackend(dir, 'scout', 'claude');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'backend-not-connected');
  assert.deepEqual(readKeysFile(dir).subharness.uses, {});
});

test('use refuses a name that is no backend', async () => {
  // Catches: a typo stored as the backend, which usesOf drops on read and the agent silently falls back.
  const { dir } = rig();
  const result = await useBackend(dir, 'dev', 'gemini');
  assert.equal(result.code, 'unknown-backend');
  assert.deepEqual(readKeysFile(dir).subharness.uses, {});
});

test('use refuses each direct role with its own code and writes nothing', async () => {
  // Catches: the analyzer or the drawing role stored under uses, as if a CLI could serve its requests.
  const { dir } = rig();
  for (const role of DIRECT_ONLY_ROLES) {
    const result = await useBackend(dir, role, 'codex');
    assert.equal(result.code, 'no-subharness-path', role);
  }
  assert.deepEqual(readKeysFile(dir).subharness.uses, {});
});

test('use refuses a name that is neither an agent nor a role', async () => {
  // Catches: any word stored as an agent, so the uses map fills with names no run ever reads.
  const { dir } = rig();
  assert.equal((await useBackend(dir, 'nobody', 'codex')).code, 'unknown-agent');
});

test('use of the backend an agent already uses changes nothing', async () => {
  // Catches: a rewrite of keys.json on every repeated line, which a concurrent enable can lose.
  const { dir } = rig();
  await useBackend(dir, 'dev', 'codex');
  const again = await useBackend(dir, 'dev', 'codex');
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

test('the table parses subharness use with a direct role, so the command can answer with its code', () => {
  // Catches: the table refuses "analyzer" as no agent, and the owner never learns that the role has no subharness path.
  const parsed = parseCommandLine('/subharness use analyzer codex');
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed, { ok: true, name: 'subharness.use', args: { agent: 'analyzer', backend: 'codex' } });
});

test('the subharness use command stores the backend it names', async () => {
  // Catches: the table parses the line and the handler falls through to "no such command".
  const { deps, dir } = rig();
  const answer = await subharnessCommand(deps, 'subharness.use', { agent: 'server', backend: 'claude' });
  assert.equal(answer.status, 'ok');
  assert.equal(readKeysFile(dir).subharness.uses?.server, 'claude');
});

// model set for an agent

test('model set with an effort checks one reply on that model and effort, then stores both', async () => {
  // Catches: the effort is stored without the reply check, or the check runs without the effort it will run at.
  const { dir, deps, ran } = rig();
  await useBackend(dir, 'dev', 'codex');
  const result = await setAgentModel(deps, 'dev', 'gpt-6.1-sol', 'high');
  assert.equal(result.ok, true);
  assert.deepEqual(ran, [{ name: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
  const stored = readKeysFile(dir).subharness;
  assert.equal(stored.models?.dev, 'gpt-6.1-sol');
  assert.equal(stored.efforts?.dev, 'high');
});

test('model set checks through the backend the agent uses, not the first connected one', async () => {
  // Catches: the check runs on codex while the agent runs on claude, so a claude-only model is refused.
  const { dir, deps, ran } = rig();
  await useBackend(dir, 'scout', 'claude');
  await setAgentModel(deps, 'scout', 'claude-opus-5-5');
  assert.equal(ran[0]?.name, 'claude');
});

test('a model whose reply check fails keeps the model and the effort stored before', async () => {
  // Catches: the effort written before the check, left beside the old model when the new one is refused.
  const { dir, deps } = rig();
  await setAgentModel(deps, 'dev', 'gpt-6.1-sol', 'high');
  const result = await setAgentModel(deps, 'dev', 'bad-model', 'low');
  assert.equal(result.ok, false);
  const stored = readKeysFile(dir).subharness;
  assert.equal(stored.models?.dev, 'gpt-6.1-sol');
  assert.equal(stored.efforts?.dev, 'high');
});

test('an effort that is no level is refused before anything runs', async () => {
  // Catches: "max" or "xhigh" passed to the CLI, which refuses it at the agent's next real run.
  const { dir, deps, ran } = rig();
  const result = await setAgentModel(deps, 'dev', 'gpt-6.1-sol', 'max');
  assert.equal(result.code, 'unknown-effort');
  assert.deepEqual(ran, []);
  assert.deepEqual(readKeysFile(dir).subharness.models, {});
});

test('claude takes an effort when its --help lists --effort', async () => {
  // Catches: the help check refuses every effort on claude, or reads the help of another binary.
  const { dir, deps } = rig({ help: HELP_WITH_EFFORT });
  await useBackend(dir, 'dev', 'claude');
  const result = await setAgentModel(deps, 'dev', 'claude-opus-5-5', 'medium');
  assert.equal(result.ok, true);
  assert.equal(readKeysFile(dir).subharness.efforts?.dev, 'medium');
});

test('claude refuses an effort when its --help does not list --effort, and runs nothing', async () => {
  // Catches: "--effort" passed to a claude that does not know it, so every run of the agent exits with an error.
  const { dir, deps, ran } = rig({ help: HELP_WITHOUT_EFFORT });
  await useBackend(dir, 'dev', 'claude');
  const result = await setAgentModel(deps, 'dev', 'claude-opus-5-5', 'medium');
  assert.equal(result.code, 'effort-unsupported');
  assert.deepEqual(ran, []);
  assert.equal(readKeysFile(dir).subharness.efforts?.dev, undefined);
});

test('claude refuses an effort when its --help cannot be read', async () => {
  // Catches: a missing help reader taken as "supported", which ends in the same failed runs.
  const { dir, deps } = rig({ help: null });
  await useBackend(dir, 'dev', 'claude');
  assert.equal((await setAgentModel(deps, 'dev', 'claude-opus-5-5', 'high')).code, 'effort-unsupported');
});

test('claude without an effort needs no --help check', async () => {
  // Catches: the help check applied to every claude model set, so a claude without --effort cannot change models at all.
  const { dir, deps } = rig({ help: HELP_WITHOUT_EFFORT });
  await useBackend(dir, 'dev', 'claude');
  assert.equal((await setAgentModel(deps, 'dev', 'claude-sonnet-5-5')).ok, true);
});

test('a model set without an effort keeps the effort stored before', async () => {
  // Catches: changing the model wipes the effort the owner set, and the agent drops to the CLI's default.
  const { dir, deps } = rig();
  await setAgentModel(deps, 'dev', 'gpt-6.1-sol', 'high');
  await setAgentModel(deps, 'dev', 'gpt-6-sol');
  const stored = readKeysFile(dir).subharness;
  assert.equal(stored.models?.dev, 'gpt-6-sol');
  assert.equal(stored.efforts?.dev, 'high');
});

// the lists offered

test('the codex list offers the GPT ids the account lists', async () => {
  // Catches: the dialog offers ids such as gpt-5.5 that the owner's account does not serve.
  const { deps } = rig();
  assert.deepEqual(await listModels(deps, 'codex', ''), [
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6.1-terra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ]);
});

test('the claude list keeps the aliases and offers the current Claude ids', async () => {
  // Catches: the aliases dropped, so a stored "opus" no longer shows in the dialog, or a current id missing.
  const { deps } = rig();
  const offered = await listModels(deps, 'claude', '');
  for (const id of ['opus', 'sonnet', 'claude-opus-5-5', 'claude-sonnet-5-5']) assert.ok(offered.includes(id), id);
});

// the run and the status

test('the runner passes the stored effort of the agent and none for an agent without one', async () => {
  // Catches: the effort is stored but never reaches the CLI, or every agent runs at one agent's effort.
  const dir = tempDir('nep-paths-run-');
  writeKeysFile(dir, {
    subharness: { backends: ['codex'], key: null, modes: {}, models: {}, efforts: { dev: 'high' } },
  });
  const seen: Array<BackendRunOptions> = [];
  const deps = {
    privateDir: dir,
    denyDir: path.join(dir, 'nosudo'),
    hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name: 'codex' | 'claude' | 'opencode'): Backend => ({
      name,
      run: (_brief, options) => {
        seen.push(options);
        return Promise.resolve({ ok: true, text: 'x', exitCode: 0 });
      },
    }),
  };
  for (const agent of ['dev', 'scout']) await runAgent({ agent, brief: 'b', cwd: dir, timeoutMs: 1000 }, deps);
  assert.deepEqual(
    seen.map((one) => one.effort),
    ['high', undefined]
  );
});

test('the status lists each agent with its backend, model and effort', async () => {
  // Catches: the status shows the modes alone, so the owner cannot see which CLI and model an agent runs on.
  const { dir, deps } = rig();
  await useBackend(dir, 'dev', 'claude');
  await setAgentModel(deps, 'dev', 'claude-opus-5-5', 'high');
  const status = await subharnessCommand(deps, 'subharness.status', {});
  const dev = lineOf(status.text, 'dev');
  for (const word of ['claude', 'claude-opus-5-5', 'high']) assert.ok(dev.includes(word), `${word} on "${dev}"`);
});

test('the status names the first connected backend for an agent that names none', async () => {
  // Catches: an agent without a uses entry shown as "none" while every run goes through backends[0].
  const { deps } = rig({ backends: ['codex', 'claude'] });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  assert.ok(lineOf(status.text, 'scout').includes('codex'));
});

test('the status shows no backend for an agent whose named backend was disconnected', async () => {
  // Catches: the status shows the stale backend while runAgent refuses the agent as subharness-off.
  const dir = tempDir('nep-paths-stale-');
  writeKeysFile(dir, { subharness: { backends: ['codex'], key: null, modes: {}, uses: { dev: 'claude' } } });
  const { deps } = rig();
  const status = await subharnessCommand({ ...deps, privateDir: dir }, 'subharness.status', {});
  const dev = lineOf(status.text, 'dev');
  assert.ok(!dev.includes('claude'), dev);
  assert.ok(dev.includes('none'), dev);
});

// model set from the console

/** A console over fakes whose runOp records each operation. */
function consoleOver(dir: string, subharness: ConsoleDeps['subharness']) {
  const ops: Array<string> = [];
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'ok', code: '', summary: '', data: null });
    },
    ownerReads: { lessons: () => '', aliases: () => '' },
    guildId: () => 'g1',
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => 0,
    keys: { enabled: () => true, run: () => Promise.resolve({ text: 'keys answered', status: 'ok' }) },
    ...(subharness === undefined ? {} : { subharness }),
  };
  return { desk: createConsole(deps), ops };
}

test('model set for an agent goes through its subharness with the effort, not to the key commands', async () => {
  // Catches: "/model set dev" written into models.development.dev, which no subharness run reads.
  const { dir, deps, ran } = rig();
  const { privateDir: _privateDir, ...given } = deps;
  const { desk, ops } = consoleOver(dir, given);
  const answer = await desk.run('model.set', { role: 'dev', model: 'gpt-6.1-sol', effort: 'low' }, { id: 'owner' });
  assert.equal(answer.status, 'ok');
  assert.notEqual(answer.text, 'keys answered');
  assert.deepEqual(ops, []);
  assert.equal(ran[0]?.effort, 'low');
  assert.equal(readKeysFile(dir).subharness.models?.dev, 'gpt-6.1-sol');
});

test('the table parses model set for an agent with an effort', () => {
  // Catches: the table refuses "watcher" as no model role, or drops --effort, so the dialog never sees it.
  const parsed = parseCommandLine('/model set watcher gpt-6-astra --effort medium');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.args, { role: 'watcher', model: 'gpt-6-astra', effort: 'medium' });
});
