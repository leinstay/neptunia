// `/subharness` and `/agent mode` (src/interface/commands/table.ts, src/interface/commands/subharness.ts): the rows of
// the command table, the answers of the handlers over keys.json in a temp dir with a fake runner and fetch, the routing
// of the console, and the rule that only the owner's chat changes a mode. The tests assert on the data they put in (a
// key name, a mode, a file's content) and on statuses, not on the wording of an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { subharnessCommand } from '../../../../src/interface/commands/subharness.ts';
import type { EnableDeps } from '../../../../src/subharness/control.ts';
import { deferModeToUnit } from '../../../../src/setup/install.ts';
import { readKeysFile, writeKeysFile } from '../../../fixtures/keys-file.ts';
import { fakeVendor } from '../../../fixtures/fake-vendor.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import type { BackendResult } from '../../../../src/agent-runner/backend.ts';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../../../../src/interface/commands/console.ts';
import type { KeysFile } from '../../../fixtures/keys-file.ts';
import { fakeFetch } from '../../../fixtures/keys-rig.ts';
import { setAgentModel } from '../../../../src/subharness/control.ts';
import type { EffortLevel } from '../../../../src/llm/roles.ts';
import { subharnessPlace } from '../../../../src/subharness/place.ts';
import { harnessPathOf } from '../../../../src/subharness/memory-path.ts';

const SECRET = 'sk-or-v1-oc-secret-0123456789';

function rig() {
  const dir = tempDir('nep-cmd-sub-');
  writeKeysFile(dir, { extra: { opencode: SECRET } });
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps };
}

test('a mode and the status change and read keys.json and answer ok', async () => {
  // Bug: the handler answers ok without writing, or writes without answering what it did.
  // The reply names opencode's key and holds no key value.
  const { dir, deps } = rig();
  const stored = readKeysFile(dir);
  writeKeysFile(dir, { ...stored, subharness: { ...stored.subharness, key: 'opencode' } });
  // A mode belongs to a unit.
  assert.equal((await subharnessCommand(deps, 'agent.mode', { unit: 'scout', mode: 'sudo' })).status, 'ok');
  assert.equal(readKeysFile(dir).subharness.modes.scout, 'sudo');
  const reply = await subharnessCommand(deps, 'subharness.status', {});
  assert.equal(reply.status, 'ok');
  assert.ok(reply.text.includes('opencode') && reply.text.includes('sudo'));
  assert.equal(reply.text.includes(SECRET), false);
});

test('a refused opencode login answers failed, names the key and writes nothing', async () => {
  // Bug: a failed check answers ok, so the owner thinks the source is on.
  // The login of opencode is what names its key.
  const { dir, deps } = rig();
  const answer = await subharnessCommand(deps, 'subharness.opencode.login', { key: 'nope' });
  assert.equal(answer.status, 'failed');
  assert.equal(readKeysFile(dir).subharness.key, null);
});

test('a mode line with no mode shows the current one and writes nothing', async () => {
  // Bug: the inspection form writes the default into keys.json.
  const { dir, deps } = rig();
  // A mode belongs to a unit.
  const answer = await subharnessCommand(deps, 'agent.mode', { unit: 'scout' });
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('write'));
  assert.deepEqual(readKeysFile(dir).subharness.modes, {});
});

test('inside the core a mode change is stored and the answer names neptunia setup', async () => {
  // Catches: the core wires the mode to a sudo re-render that NoNewPrivileges refuses, and the owner reads a failure.
  // The one flow re-renders the units.
  const { dir, deps } = rig();
  // A mode belongs to a unit, the server's being its own.
  const inCore: EnableDeps = { ...deps, applyMode: (unit) => Promise.resolve(deferModeToUnit(unit)) };
  const answer = await subharnessCommand(inCore, 'agent.mode', { unit: 'server', mode: 'sudo' });
  assert.equal(answer.status, 'ok');
  assert.equal(readKeysFile(dir).subharness.modes.server, 'sudo');
  assert.ok(answer.text.includes('neptunia setup'));
});

// Each row reads the first route of the role's chain.

/** A private folder with `chains` as `models.routes`, both backends installed and logged in but those in `out`. */

/** A private folder with `chains` as `models.routes`, both backends installed and logged in but those in `out`. */
function chainsRig(chains: Record<string, unknown>, out: ReadonlyArray<'codex' | 'claude'> = []) {
  const dir = tempDir('nep-cmd-sub-rows-');
  writeKeysFile(dir, {});
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'config.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ ...config, models: { routes: chains } }));
  for (const backend of ['codex', 'claude'] as const)
    if (!out.includes(backend)) fakeVendor(dir, backend, { loggedIn: true });
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return deps;
}

/** The line of `subharness status` that starts with two spaces and `name`. */
const rowOf = (text: string, name: string): string =>
  text.split('\n').find((line) => line.startsWith(`  ${name} `) || line.startsWith(`  ${name}\t`)) ?? '';

const onClaude = (effort: string | null) => [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-6', effort }];

test('subharness status names the harness, model and effort of the core and of the memory writer', async () => {
  // Catches: the status lists the agents alone, so the owner cannot see that the persona's turns or memory run on a subscription.
  const deps = chainsRig({ core: onClaude('low'), memory: onClaude('high') });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  for (const role of ['core', 'memory']) {
    const row = rowOf(status.text, role);
    for (const word of ['claude', 'claude-opus-4-6']) assert.ok(row.includes(word), `${word} on "${row}"`);
  }
  assert.ok(rowOf(status.text, 'core').includes('low') && rowOf(status.text, 'memory').includes('high'), status.text);
});

test('subharness status marks a harness row whose backend cannot run', async () => {
  // Catches: a route on a logged-out CLI shown as healthy while every turn of the persona fails.
  const deps = chainsRig({ core: onClaude(null) }, ['claude']);
  const status = await subharnessCommand(deps, 'subharness.status', {});
  assert.ok(rowOf(status.text, 'core').includes('unavailable'), status.text);
});

test('subharness status says direct-api for a role whose chain starts on a key or has no route', async () => {
  // Catches: no row at all on the API, so a missing row cannot be told from a lost chain.
  const deps = chainsRig({ core: [{ via: 'api', key: 'main', model: 'x/core', effort: null }] });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  assert.ok(rowOf(status.text, 'core').includes('direct'), status.text);
  assert.ok(rowOf(status.text, 'memory').includes('direct'), status.text);
});

const OWNER = { id: 'owner' };

type Checked = { name: string; model: string | undefined; effort: string | undefined };

function sourcesRig(
  subharness: Partial<KeysFile['subharness']> = {},
  check: (one: Checked) => BackendResult | Promise<BackendResult> = () => ({ ok: true, text: 'ok', exitCode: 0 })
) {
  const privateDir = tempDir('nep-model-commands-');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, ...subharness } });
  const checks: Array<Checked> = [];
  const applied: Array<[string, string]> = [];
  const given: ConsoleDeps['subharness'] = {
    runBackend: (name, _brief, model, effort) => {
      const one = { name, model, effort };
      checks.push(one);
      return Promise.resolve(check(one));
    },
    fetch: fakeFetch().fetch,
    applyMode: (agent, mode) => {
      applied.push([agent, mode]);
      return Promise.resolve('the unit took it');
    },
  };
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir,
    dataDir: privateDir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
    subharness: given,
  });
  return { privateDir, desk, checks, applied, deps: { ...given, privateDir } };
}

// The handler of the account commands in the core

test('the core answers a status of one backend, and tells a login to go to a terminal', async () => {
  // Catches: the core process starting an interactive vendor login with nobody attached.
  const { deps } = sourcesRig();
  const vendor = fakeVendor(deps.privateDir, 'claude', { loggedIn: true });
  assert.equal((await subharnessCommand(deps, 'subharness.claude.status', {})).status, 'ok');
  const login = await subharnessCommand(deps, 'subharness.claude.login', {});
  assert.equal(login.status, 'failed');
  assert.ok(login.text.includes('neptunia subharness claude login'), login.text);
  assert.deepEqual(vendor.calls(), ['auth status']);
});

test('/agent mode stores the mode and re-renders the unit, as subharness mode did', async () => {
  // Catches: the move dropping the unit hook, so a mode only reaches keys.json and the sandbox stays as it was.
  // Changed: a mode belongs to a unit, and the scout's unit is its own.
  const { desk, privateDir, applied } = sourcesRig();
  const answer = await desk.run('agent.mode', { unit: 'scout', mode: 'read' }, OWNER);
  assert.equal(answer.status, 'ok', answer.text);
  assert.ok(answer.text.includes('the unit took it'), answer.text);
  assert.equal(readKeysFile(privateDir).subharness.modes.scout, 'read');
  assert.deepEqual(applied, [['scout', 'read']]);
});

test('/agent mode with no mode reports it, writes nothing and touches no unit', async () => {
  // Catches: a read that re-renders and restarts a running agent.
  // Changed: a mode belongs to a unit, and the server's unit is its own.
  const { desk, privateDir, applied } = sourcesRig({ modes: { server: 'full' } });
  const answer = await desk.run('agent.mode', { unit: 'server' }, OWNER);
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('full'), answer.text);
  assert.deepEqual(applied, []);
  assert.equal(readKeysFile(privateDir).subharness.modes.server, 'full');
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

type Ran = { name: string; model: string | undefined; effort: EffortLevel | undefined };

/** keys.json with codex and claude connected; the runner answers for every model but `bad-model`. */
function pathsRig(options: { backends?: Array<'codex' | 'claude' | 'opencode'> } = {}) {
  const dir = tempDir('nep-paths-');
  writeKeysFile(dir, {
    subharness: { backends: options.backends ?? ['codex', 'claude'], key: null, modes: {}, models: {}, uses: {} },
  });
  // Changed: a selection reads the real source, so each backend a rig calls connected is installed and logged in.
  for (const backend of options.backends ?? (['codex', 'claude'] as const))
    if (backend !== 'opencode') fakeVendor(dir, backend, { loggedIn: true });
  const ran: Array<Ran> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model, effort) => {
      ran.push({ name, model, effort });
      const ok = model !== 'bad-model';
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps, ran };
}

/** Names the source of one agent in the store, as a selection leaves it. */
function seedUses(dir: string, agent: string, backend: 'codex' | 'claude'): void {
  const stored = readKeysFile(dir);
  writeKeysFile(dir, {
    ...stored,
    subharness: { ...stored.subharness, uses: { ...stored.subharness.uses, [agent]: backend } },
  });
}

/** The status line of one agent: two spaces, then its name. */
const lineOf = (text: string, agent: string): string =>
  text.split('\n').find((line) => line.startsWith(`  ${agent} `) || line.startsWith(`  ${agent}\t`)) ?? '';

test('the status lists each agent with its backend, model and effort', async () => {
  // Catches: the status shows the modes alone, so the owner cannot see which CLI and model an agent runs on.
  const { dir, deps } = pathsRig();
  seedUses(dir, 'server', 'claude');
  await setAgentModel(deps, 'server', 'claude-opus-5-5', 'high');
  const status = await subharnessCommand(deps, 'subharness.status', {});
  const dev = lineOf(status.text, 'server');
  for (const word of ['claude', 'claude-opus-5-5', 'high']) assert.ok(dev.includes(word), `${word} on "${dev}"`);
});

const KEY = 'sk-or-v1-provider-fake-0123456789';
const MODEL = 'anthropic/claude-sonnet-5';

/** A private dir whose opencode is installed and logged in on the extra key `helpers`. */
function installed(): string {
  const dir = tempDir('nep-provider-');
  writeKeysFile(dir, { extra: { helpers: KEY }, subharness: { key: 'helpers', modes: {} } });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  return dir;
}

const selectionDeps = (dir: string): EnableDeps => ({
  privateDir: dir,
  baseUrl: 'https://openrouter.test/api/v1',
  runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
  fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
});

test('/subharness status shows no provider on the row of an agent that has none', async () => {
  // Catches: a "provider none" or empty column on every row, which reads like a pin that is not there.
  const dir = installed();
  await setAgentModel(selectionDeps(dir), 'server', MODEL, undefined, 'opencode', 'anthropic');
  await setAgentModel(selectionDeps(dir), 'scout', 'deepseek/deepseek-v4', undefined, 'opencode');
  const status = await subharnessCommand(selectionDeps(dir), 'subharness.status', {});
  const row = status.text.split('\n').find((line) => line.trim().startsWith('scout ')) ?? '';
  assert.equal(row.includes('provider'), false, row);
});

type RouteRan = { name: string; model: string | undefined };

/** keys.json with `subharness` laid over; claude and codex are installed and logged in, the runner answers every model. */
function routeRig(subharness: Partial<KeysFile['subharness']> = {}) {
  const dir = tempDir('nep-route-names-');
  writeKeysFile(dir, { subharness: { key: null, modes: {}, models: {}, uses: {}, ...subharness } });
  for (const backend of ['claude', 'codex'] as const) fakeVendor(dir, backend, { loggedIn: true });
  const ran: Array<RouteRan> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model) => {
      ran.push({ name, model });
      return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps, ran };
}

/** The words of the status line that starts with two spaces and `name`. */
const wordsOf = (text: string, name: string): Array<string> =>
  (text.split('\n').find((line) => line.startsWith(`  ${name} `)) ?? '').trim().split(/\s+/);

// what the owner reads

test('subharness status renders via claude-harness for a stored claude route and direct-api for none', async () => {
  // Catches: the core row still saying `via claude`, or `api` where the core has no record.
  const { deps } = routeRig({ core: { backend: 'claude', model: 'claude-opus-4-6', effort: null } });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  const core = wordsOf(status.text, 'core');
  assert.deepEqual(core.slice(0, 4), ['core', 'via', 'claude-harness', 'claude-opus-4-6']);
  const none = await subharnessCommand(routeRig().deps, 'subharness.status', {});
  const api = wordsOf(none.text, 'core');
  assert.ok(api.includes('direct-api'), none.text);
  assert.equal(api.includes('api'), false, none.text);
});

test('subharness status renders the memory writer on codex-harness', async () => {
  // Catches: the memory row left on the stored word while the core row moved.
  const { deps } = routeRig({ memory: { backend: 'codex', model: 'gpt-6.1-sol', effort: null } });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  const memory = wordsOf(status.text, 'memory');
  assert.deepEqual(memory.slice(0, 4), ['memory', 'via', 'codex-harness', 'gpt-6.1-sol']);
});

for (const backend of ['claude', 'codex', 'opencode'] as const) {
  test(`an agent row on ${backend} renders ${backend}-harness in its backend column`, async () => {
    // Catches: the agent rows keeping the stored word, so one status shows two naming schemes side by side.
    const { deps } = routeRig({ uses: { scout: backend }, models: { scout: 'invented-model' } });
    const status = await subharnessCommand(deps, 'subharness.status', {});
    const scout = wordsOf(status.text, 'scout');
    assert.ok(scout.includes(`${backend}-harness`), status.text);
    assert.equal(scout.includes(backend), false, status.text);
  });
}

test('the stored record keeps its backend word after the status renders the route', async () => {
  // Catches: the rename written back to keys.json, which every reader and the logs still read as `claude`.
  const core = { backend: 'claude', model: 'claude-opus-4-6', effort: null };
  const { dir, deps } = routeRig({ core });
  await subharnessCommand(deps, 'subharness.status', {});
  assert.deepEqual(readKeysFile(dir).subharness.core, core);
  assert.equal(harnessPathOf(dir, 'core').kind, 'subharness');
});

function storeWith(subharness: Partial<KeysFile['subharness']>): string {
  const privateDir = tempDir('nep-sources-');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, ...subharness } });
  return privateDir;
}

// Setup validation and readiness lines

// The plain status

function enableDeps(privateDir: string): { deps: EnableDeps; runs: Array<string> } {
  const runs: Array<string> = [];
  return {
    runs,
    deps: {
      privateDir,
      fetch: fakeFetch().fetch,
      runBackend: (name) => {
        runs.push(name);
        return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
      },
    },
  };
}

const consumersRowOf = (text: string, role: string): string =>
  text.split('\n').find((line) => line.trim().startsWith(`${role} `)) ?? '';

test('/subharness status lists the source, model, effort and mode of every role with no model run', async () => {
  // Catches: the status hides a role behind the list, or spends a request on a read.
  const privateDir = storeWith({
    // Changed: the agents `dev` and `thinker` are gone (maintainer, 2026-11-16), so `server` and `scout` take their rows.
    uses: { server: 'claude', scout: 'codex' },
    models: { server: 'sonnet', scout: 'gpt-6-luna' },
    efforts: { server: 'high' },
    // Changed: a mode is stored per unit, the server's being `host`.
    modes: { server: 'full' },
    memory: { backend: 'claude', model: 'claude-opus-4-6', effort: 'high' },
  });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const { deps, runs } = enableDeps(privateDir);
  const answer = await subharnessCommand(deps, 'subharness.status', {});
  assert.equal(answer.status, 'ok');
  const server = consumersRowOf(answer.text, 'server');
  for (const word of ['claude', 'sonnet', 'high', 'full'])
    assert.ok(server.includes(word), `server: ${word} in "${server}"`);
  assert.ok(consumersRowOf(answer.text, 'scout').includes('gpt-6-luna'));
  const memory = consumersRowOf(answer.text, 'memory');
  for (const word of ['claude', 'claude-opus-4-6', 'high']) assert.ok(memory.includes(word), memory);
  // Changed: the watcher is gone (maintainer, 2026-11-16), so the agents are scout and server.
  for (const agent of ['scout', 'server']) assert.notEqual(consumersRowOf(answer.text, agent), '', agent);
  assert.deepEqual(runs, []);
});

test('after a logout the status shows the selected source unavailable and names no other source', async () => {
  // Catches: the row falls back to OpenRouter or to the first available source once its own login is gone.
  // Changed: the agent `dev` is gone (maintainer, 2026-11-16), so the row is the server's.
  const privateDir = storeWith({ uses: { server: 'claude' }, models: { server: 'sonnet' } });
  fakeVendor(privateDir, 'claude');
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const { deps } = enableDeps(privateDir);
  const dev = consumersRowOf((await subharnessCommand(deps, 'subharness.status', {})).text, 'server');
  assert.ok(dev.includes('claude'), dev);
  assert.ok(dev.includes('sonnet'), dev);
  assert.ok(dev.includes('unavailable'), dev);
  assert.equal(dev.includes('codex'), false, dev);
  assert.equal(dev.includes('openrouter'), false, dev);
});
