// src/subharness/control.ts: the owner's switch of the subharness over keys.json. Enabling checks the backend first
// (the binary and one reply for codex and claude through an injected runner, the named key answering /auth/key through
// an injected fetch for opencode) and stores nothing when the check fails. The result has the shape of Hermes'
// ApprovalModeResult (hermes_cli/approval_mode.py): ok, a code, whether anything changed, and a message. No process
// is spawned and no request goes out; keys.json lives in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_MODES,
  DEFAULT_MODES,
  SUBHARNESS_AGENTS,
  disableSubharness,
  enableSubharness,
  setAgentMode,
  statusText,
  subharnessView,
} from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import type { BackendResult } from '../src/agent-runner/backend.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SECRET = 'sk-or-v1-oc-secret-0123456789';
const CORE_SECRET = 'sk-or-v1-core-secret-9876543210';

const REPLY: BackendResult = { ok: true, text: 'ok', exitCode: 0 };
const MISSING: BackendResult = { ok: false, text: '', exitCode: null, error: 'backend-missing' };
const SILENT: BackendResult = { ok: false, text: '', exitCode: 1 };

type Rig = {
  deps: EnableDeps;
  dir: string;
  ran: Array<{ name: string; brief: string }>;
  fetched: Array<{ url: string; auth: string }>;
};

/** A private dir with keys.json holding an `opencode` extra key and a core key; the runner and fetch are fakes. */
function rig(options: { result?: BackendResult; status?: number; throws?: boolean } = {}): Rig {
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir, {
    core: [{ name: 'core-1', value: CORE_SECRET }],
    extra: { opencode: SECRET, sim: 'sk-or-v1-sim-secret' },
  });
  const ran: Rig['ran'] = [];
  const fetched: Rig['fetched'] = [];
  const deps: EnableDeps = {
    privateDir: dir,
    baseUrl: 'https://openrouter.test/api/v1',
    runBackend: (name, brief) => {
      ran.push({ name, brief });
      return Promise.resolve(options.result ?? REPLY);
    },
    fetch: (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      fetched.push({ url: href, auth: headers.get('authorization') ?? '' });
      if (options.throws === true) return Promise.reject(new Error(`connect failed for ${SECRET}`));
      return Promise.resolve(new Response('{}', { status: options.status ?? 200 }));
    },
  };
  return { deps, dir, ran, fetched };
}

test('the tracked defaults are read for server and watcher, write for scout and dev, and there are four modes', () => {
  // Bug: a read-only agent defaulting to write, or an agent defaulting to an unsandboxed mode before the owner chose.
  assert.deepEqual(DEFAULT_MODES, { scout: 'write', server: 'read', dev: 'write', watcher: 'read' });
  assert.deepEqual([...AGENT_MODES], ['read', 'write', 'full', 'sudo']);
  assert.deepEqual([...SUBHARNESS_AGENTS].sort(), ['dev', 'scout', 'server', 'watcher']);
});

test('a store with no subharness section reads as off with the default modes', async () => {
  // Bug: a fresh install reads as enabled, or the view throws on the empty store.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": the view lists the connected backends; who holds the sandbox is in the status.
  assert.deepEqual(await subharnessView(dir), { backends: [], key: null, modes: DEFAULT_MODES });
});

test('enable codex runs one reply check through the runner and stores the backend', async () => {
  // Bug: enabling without the check turns on a backend whose binary is not installed or not logged in.
  const { deps, dir, ran } = rig();
  const result = await enableSubharness(deps, 'codex');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(ran.length, 1);
  assert.equal(ran[0]?.name, 'codex');
  assert.notEqual(ran[0]?.brief.trim(), '');
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends, ['codex']);
  assert.equal(readKeysFile(dir).subharness.key, null);
});

test('enable claude checks claude, not codex', async () => {
  // Bug: the check always runs the default backend, so a missing claude binary passes.
  const { deps, dir, ran } = rig();
  assert.equal((await enableSubharness(deps, 'claude')).ok, true);
  assert.deepEqual(
    ran.map((one) => one.name),
    ['claude']
  );
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends ?? [], ['claude']);
});

test('a missing binary is refused as binary-missing and nothing is stored', async () => {
  // Bug: the backend is stored anyway and every agent task then fails with backend-missing.
  const { deps, dir } = rig({ result: MISSING });
  const result = await enableSubharness(deps, 'codex');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'binary-missing');
  assert.equal(result.changed, false);
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends ?? [], []);
});

test('a binary that runs but gives no reply is refused as no-reply and nothing is stored', async () => {
  // Bug: a codex that is on PATH but not logged in passes the check on the strength of the binary alone.
  const { deps, dir } = rig({ result: SILENT });
  const result = await enableSubharness(deps, 'codex');
  assert.equal(result.code, 'no-reply');
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends ?? [], []);
});

test('a failed enable leaves the backend that was on as it was', async () => {
  // Bug: switching from codex to claude clears the working backend before the new one is proven.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  const failing = { ...deps, runBackend: () => Promise.resolve(MISSING) };
  assert.equal((await enableSubharness(failing, 'claude')).ok, false);
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends ?? [], ['codex']);
});

test('enable opencode asks /auth/key with the named extra key and stores the backend and the key name', async () => {
  // Bug: the check goes out with the wrong key (a core key), so OpenCode is enabled on a key that was never tried.
  const { deps, dir, fetched, ran } = rig();
  const result = await enableSubharness(deps, 'opencode', 'opencode');
  assert.equal(result.ok, true);
  assert.equal(fetched.length, 1);
  assert.ok(fetched[0]?.url.endsWith('/auth/key'));
  assert.equal(fetched[0]?.auth, `Bearer ${SECRET}`);
  assert.equal(ran.length, 0, 'opencode is proven by its key, not by a reply');
  const stored = readKeysFile(dir).subharness;
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(stored.backends, ['opencode']);
  assert.equal(stored.key, 'opencode');
});

test('a key the provider rejects is refused as key-rejected and nothing is stored', async () => {
  // Bug: a revoked key is stored and OpenCode fails at its first task, at night.
  const { deps, dir } = rig({ status: 401 });
  const result = await enableSubharness(deps, 'opencode', 'opencode');
  assert.equal(result.code, 'key-rejected');
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends ?? [], []);
});

test('an unreachable provider is refused as key-unreachable, and the error text does not carry the key', async () => {
  // Bug: the fetch error message (which here quotes the key) is passed on to the owner's chat.
  const { deps, dir } = rig({ throws: true });
  const result = await enableSubharness(deps, 'opencode', 'opencode');
  assert.equal(result.code, 'key-unreachable');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends ?? [], []);
});

test('a name that is no extra key is key-unknown and nothing is asked, a core key name included', async () => {
  // Bug: OpenCode is given a core key, which would spend the persona's budget on agent work.
  const { deps } = rig();
  for (const name of ['nope', 'core-1']) {
    const result = await enableSubharness(deps, 'opencode', name);
    assert.equal(result.code, 'key-unknown', name);
  }
});

test('opencode needs a key, and codex and claude take none', async () => {
  // Bug: opencode enabled with no key runs on whatever key the environment holds; a key given to codex is ignored silently.
  const { deps, dir, ran, fetched } = rig();
  assert.equal((await enableSubharness(deps, 'opencode')).code, 'key-needed');
  assert.equal((await enableSubharness(deps, 'codex', 'opencode')).code, 'key-not-allowed');
  assert.equal((await enableSubharness(deps, 'claude', 'opencode')).code, 'key-not-allowed');
  assert.equal(ran.length + fetched.length, 0, 'a refused line asks nothing');
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends ?? [], []);
});

test('an unknown backend name is refused', async () => {
  // Bug: a typo such as "codx" is stored and looked up on PATH at the first task.
  const { deps, dir } = rig();
  assert.equal((await enableSubharness(deps, 'codx')).code, 'unknown-backend');
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends ?? [], []);
});

test('enabling the backend that is already on changes nothing', async () => {
  // Bug: every enable reports a change, so the owner cannot tell a no-op from a switch.
  const { deps } = rig();
  await enableSubharness(deps, 'codex');
  const again = await enableSubharness(deps, 'codex');
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

test('enabling codex beside opencode keeps the key opencode runs on', async () => {
  // Bug: a stale key name stays in keys.json and the next opencode enable reuses it unasked.
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": enabling codex adds it beside opencode, which keeps
  // running on its key; the key is cleared when opencode is disabled (the test below on disabling opencode).
  const { deps, dir } = rig();
  await enableSubharness(deps, 'opencode', 'opencode');
  await enableSubharness(deps, 'codex');
  assert.equal(readKeysFile(dir).subharness.key, 'opencode');
});

test('no result, log line or status text holds a key value', async () => {
  // Bug: the check logs the request headers, or the status prints the key it shows the name of.
  const { deps } = rig();
  const { result, logs } = await withCapturedLogs(async () => {
    const results = [
      await enableSubharness(deps, 'opencode', 'opencode'),
      await enableSubharness(deps, 'opencode', 'nope'),
    ];
    return { results, status: statusText(await subharnessView(deps.privateDir)) };
  });
  const seen = JSON.stringify([result, logs]);
  assert.equal(seen.includes(SECRET), false);
  assert.equal(seen.includes(CORE_SECRET), false);
  assert.ok(result.status.includes('opencode'), 'the status names the key');
});

test('disable turns the backend and the key off and keeps the modes the owner set', async () => {
  // Bug: off and on again resets every agent to its default and quietly drops a sudo the owner chose.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'opencode', 'opencode');
  await setAgentMode(dir, 'dev', 'sudo');
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": disable names the backend it removes, and the
  // store holds the list `backends`.
  const result = await disableSubharness(dir, 'opencode');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const stored = readKeysFile(dir).subharness;
  assert.deepEqual(stored.backends, []);
  assert.equal(stored.key, null);
  assert.equal((await subharnessView(dir)).modes.dev, 'sudo');
  assert.equal((await disableSubharness(dir, 'opencode')).changed, false);
});

test('mode sets one agent and leaves the others at what they were', async () => {
  // Bug: writing the whole modes map from defaults overwrites the other agents' choices.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  await setAgentMode(dir, 'scout', 'read');
  const result = await setAgentMode(dir, 'dev', 'sudo');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual((await subharnessView(dir)).modes, { scout: 'read', server: 'read', dev: 'sudo', watcher: 'read' });
});

test('mode with no value reports the current mode and writes nothing', async () => {
  // Bug: an inspection (Hermes /approvals without an argument) changes the setting it was asked to show.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  const result = await setAgentMode(dir, 'dev');
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.mode, 'write');
  assert.deepEqual(readKeysFile(dir).subharness.modes, {});
});

test('an unknown agent or mode is refused and the file is not touched', async () => {
  // Bug: "root" or "thinker" is written into keys.json and read later as a mode no code maps to a flag.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  assert.equal((await setAgentMode(dir, 'dev', 'root')).code, 'unknown-mode');
  assert.equal((await setAgentMode(dir, 'editor', 'read')).code, 'unknown-agent');
  assert.deepEqual(readKeysFile(dir).subharness.modes, {});
});

test('a stored mode that is no mode reads as the default, never as an unsandboxed one', async () => {
  // Bug: a hand-edited or damaged value such as "root" is passed on and an agent runs with more than the owner gave it.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir, { subharness: { backend: 'codex', key: null, modes: { dev: 'root', scout: 'sudo' } } });
  const view = await subharnessView(dir);
  assert.equal(view.modes.dev, 'write');
  assert.equal(view.modes.scout, 'sudo');
});

test('the status says who holds the sandbox: the backend for codex, the systemd unit alone for opencode', async () => {
  // Bug: the owner believes read and write are enforced under OpenCode, which has no sandbox of its own.
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": several backends may be connected, so the status
  // says it per backend in place of one `heldBy` of the view.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  await enableSubharness(deps, 'opencode', 'opencode');
  const lines = statusText(await subharnessView(dir)).split('\n');
  const lineOf = (name: string): string => lines.find((line) => line.trim().startsWith(name)) ?? '';
  assert.match(lineOf('codex'), /sandbox and by the unit/);
  assert.match(lineOf('opencode'), /systemd unit alone/);
});

test('the status text names the backend, the key name and every agent with its mode', async () => {
  // Bug: the status leaves out an agent, so a sudo mode is set and nobody sees it.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'opencode', 'opencode');
  await setAgentMode(dir, 'dev', 'sudo');
  const text = statusText(await subharnessView(dir));
  for (const word of ['opencode', ...SUBHARNESS_AGENTS, 'sudo']) assert.ok(text.includes(word), word);
});

test('a backend that is not installed in her folder is refused as not-installed naming it, and nothing is stored', async () => {
  // Catches: the enable check reads the missing install as a binary missing from PATH, and the owner installs it there.
  const { deps, dir } = rig({ result: { ok: false, text: '', exitCode: null, error: 'not-installed' } });
  const result = await enableSubharness(deps, 'claude');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-installed');
  assert.ok(result.message.includes('claude'), result.message);
  assert.equal(result.changed, false);
  // Changed for spec 2026-11-02 PR 5 "Several subharnesses": a write stores the list `backends`.
  assert.deepEqual(readKeysFile(dir).subharness.backends ?? [], []);
});

// Several subharnesses (spec 2026-11-02, PR 5): enable adds one backend to `subharness.backends` after its check,
// disable removes one, and the status lists every one connected.

test('enabling a second backend keeps the first one connected', async () => {
  // Catches: enable still replaces the single backend, so connecting claude for the watcher cuts off codex for errands.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  const second = await enableSubharness(deps, 'claude');
  assert.equal(second.ok, true);
  assert.deepEqual(readKeysFile(dir).subharness.backends, ['codex', 'claude']);
});

test('enabling a backend that is already in the list adds it no second time and runs no check', async () => {
  // Catches: a repeat enable lists codex twice, or spends a reply check on a backend already proven.
  const { deps, dir, ran } = rig();
  await enableSubharness(deps, 'codex');
  await enableSubharness(deps, 'claude');
  const before = ran.length;
  const again = await enableSubharness(deps, 'codex');
  assert.equal(again.changed, false);
  assert.equal(ran.length, before);
  assert.deepEqual(readKeysFile(dir).subharness.backends, ['codex', 'claude']);
});

test('a second backend that fails its check is not added and the first stays', async () => {
  // Catches: the list is written before the check, so a claude that is not logged in is listed and its agents fail.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  const failing: EnableDeps = { ...deps, runBackend: () => Promise.resolve(SILENT) };
  const result = await enableSubharness(failing, 'claude');
  assert.equal(result.ok, false);
  assert.deepEqual(readKeysFile(dir).subharness.backends, ['codex']);
});

test('opencode joins the list with its key name beside a backend that takes none', async () => {
  // Catches: enabling opencode beside codex drops codex, or enabling codex afterwards clears the key opencode runs on.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  await enableSubharness(deps, 'opencode', 'opencode');
  await enableSubharness(deps, 'claude');
  const stored = readKeysFile(dir).subharness;
  assert.deepEqual(stored.backends, ['codex', 'opencode', 'claude']);
  assert.equal(stored.key, 'opencode');
});

test('disabling one backend removes it and leaves the others connected', async () => {
  // Catches: disable still turns the whole subharness off, so dropping claude also stops every codex errand.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  await enableSubharness(deps, 'claude');
  const result = await disableSubharness(dir, 'claude');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(readKeysFile(dir).subharness.backends, ['codex']);
});

test('disabling opencode clears the key it ran on and keeps the backend beside it', async () => {
  // Catches: the key name outlives opencode, and a later enable of opencode reuses it without the owner naming one.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  await enableSubharness(deps, 'opencode', 'opencode');
  await disableSubharness(dir, 'opencode');
  const stored = readKeysFile(dir).subharness;
  assert.deepEqual(stored.backends, ['codex']);
  assert.equal(stored.key, null);
});

test('disabling a backend that is not connected changes nothing, and a name that is no backend is refused', async () => {
  // Catches: disable of a backend never enabled reports a change, or a typo empties the list.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  assert.equal((await disableSubharness(dir, 'claude')).changed, false);
  assert.equal((await disableSubharness(dir, 'codx')).code, 'unknown-backend');
  assert.deepEqual(readKeysFile(dir).subharness.backends, ['codex']);
});

test('disabling the last backend turns the subharness off and keeps the modes', async () => {
  // Catches: an empty list is stored as something other than off, or the owner's sudo for dev is reset on the way.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  await setAgentMode(dir, 'dev', 'sudo');
  await disableSubharness(dir, 'codex');
  const view = await subharnessView(dir);
  assert.deepEqual(view.backends, []);
  assert.equal(view.modes.dev, 'sudo');
});

test('the status names every connected backend', async () => {
  // Catches: the status shows only the first backend, so the owner cannot see that claude is connected too.
  const { deps, dir } = rig();
  await enableSubharness(deps, 'codex');
  await enableSubharness(deps, 'claude');
  const text = statusText(await subharnessView(dir));
  assert.match(text, /codex/);
  assert.match(text, /claude/);
});
