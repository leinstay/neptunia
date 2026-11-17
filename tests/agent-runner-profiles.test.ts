// Tests for src/agent-runner/profiles.ts: the agents on disk (tracked folders, one per unit, and a local overlay), the
// profile's keys and their checks, the settings of an agent with the deployment's config over its
// profile, and the socket and out folder of a unit. Pure but for reading agents/ and temporary directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readPromptFile } from '../src/agent-runner/opencode.ts';
import { onLog } from '../src/log.ts';
import {
  AgentProfileError,
  agentNames,
  agentSettings,
  listAgents,
  loadProfiles,
  profileOf,
  unitPaths,
  UNIT_SCOPE_ENV,
} from '../src/agent-runner/profiles.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Untyped } from '../src/tools/types.ts';
import { consumerRig, consumers } from './fixtures/agent-consumers.ts';

const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// Changed: the three agents each run in the unit of their name, and fetch is gone.
test('the tracked agents are code, scout and server, each in the unit of its name', () => {
  const profiles = loadProfiles({ env: {} });
  assert.deepEqual(
    Object.values(profiles).map((profile) => [profile.name, profile.unit, profile.origin]),
    [
      ['code', 'code', 'tracked'],
      ['scout', 'scout', 'tracked'],
      ['server', 'server', 'tracked'],
    ]
  );
  assert.equal(profileOf('nope', { env: {} }), null);
});

/** A profile.json that passes every check, `changes` merged over it (an `undefined` value drops the key). */
function agentProfile(id: string, changes: Record<string, unknown> = {}) {
  const base = {
    id,
    description: 'A test agent.',
    prompt: 'prompt.md',
    limits: { steps: 5, seconds: 60 },
    daily: { tasks: 3 },
  };
  const merged = { ...base, ...changes };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete loose(merged)[key];
  return merged;
}

/** A temporary engine root whose agents/ holds `profiles` (`{ <folder>: object }`); `fn(rootDir)` runs over it. */
function withAgentsTree(profiles: Untyped, fn: Untyped) {
  const rootDir = tempDir('agent-tree-');
  try {
    fs.mkdirSync(path.join(rootDir, 'agents'));
    fs.writeFileSync(path.join(rootDir, 'agents', 'README.md'), 'not an agent');
    for (const [folder, profile] of Object.entries(profiles)) {
      fs.mkdirSync(path.join(rootDir, 'agents', folder));
      fs.writeFileSync(path.join(rootDir, 'agents', folder, 'profile.json'), JSON.stringify(profile));
    }
    return fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

/** Asserts that loading the tree fails with one AgentProfileError naming `agent` and `key`. */
function assertRefused(rootDir: string, agent: string, key: string) {
  for (const load of [() => loadProfiles({ rootDir, env: {} }), () => listAgents({ rootDir, env: {} })]) {
    assert.throws(load, (err) => {
      assert.ok(err instanceof AgentProfileError, loose(err).message);
      assert.equal(err.agent, agent);
      assert.equal(err.key, key);
      assert.ok(!err.message.includes('\n'), 'one line');
      return true;
    });
  }
}

test("loadProfiles: a valid profile from a temporary agents/ tree becomes a profile with the runner's shape", () => {
  // Changed: an agent is named for its unit, so the probe is the server.
  withAgentsTree({ server: agentProfile('server') }, (rootDir: string) => {
    const probe = loadProfiles({ rootDir, env: {} }).server;
    assert.equal(probe.unit, 'server');
    assert.deepEqual(probe.promptFiles, [
      path.join(rootDir, 'data', 'agents', 'server', 'prompt.md'),
      path.join(rootDir, 'agents', 'server', 'prompt.md'),
    ]);
    assert.deepEqual(probe.defaultLimits, { steps: 5, seconds: 60 });
    assert.deepEqual(probe.defaultDaily, { tasks: 3 });
  });
});

test('loadProfiles: a key of the old profile shape is refused as an unknown key', () => {
  const keys = ['kind', 'role', 'tools', 'shell', 'sandbox', 'socket', 'enabled', 'searchProvider'];
  // Bug: a profile still carrying `abilities`, `returns` or `audience` reads as if the engine limited the agent by them.
  // Changed: `unit` is of the old shape too, since an agent runs in the unit of its name.
  for (const key of [...keys, 'abilities', 'returns', 'audience', 'unit']) {
    withAgentsTree({ scout: agentProfile('scout', { [key]: 'x' }) }, (rootDir: string) =>
      assertRefused(rootDir, 'scout', key)
    );
  }
});

test('loadProfiles: a missing key or a value of the wrong form is refused, naming the key', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    // Changed: the unit is the agent's name, so a missing `description` stands for a missing key.
    [{ description: undefined }, 'description'],
    [{ id: 'other' }, 'id'],
    [{ prompt: '../prompt.md' }, 'prompt'],
    [{ limits: { steps: 5 } }, 'limits.seconds'],
  ];
  for (const [changes, key] of cases)
    withAgentsTree({ scout: agentProfile('scout', changes) }, (rootDir: string) =>
      assertRefused(rootDir, 'scout', key)
    );
});

test('a tracked folder whose name is no unit is refused', () => {
  withAgentsTree({ probe: agentProfile('probe') }, (rootDir: string) => assertRefused(rootDir, 'probe', 'id'));
});

/** A temporary root with one tracked agent and a data folder; `fn` gets both. */
function withLocalLayer(fn: (rootDir: string, dataDir: string) => void) {
  withAgentsTree({ scout: agentProfile('scout') }, (rootDir: string) => {
    const dataDir = path.join(rootDir, 'data');
    fs.mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
    fn(rootDir, dataDir);
  });
}

/** Writes a local agent folder with `profile` and, unless `prompt` is null, its prompt. */
function writeLocal(dataDir: string, name: string, profile: unknown, prompt: string | null = 'local prompt') {
  const folder = path.join(dataDir, 'agents', name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'profile.json'), JSON.stringify(profile));
  if (prompt !== null) fs.writeFileSync(path.join(folder, 'prompt.md'), prompt);
}

// Changed: the agents are the three tracked ones, so a local folder of another name, whole or not, is no agent.
test('a local folder with another name than a tracked agent is no agent', () => {
  withLocalLayer((rootDir, dataDir) => {
    writeLocal(dataDir, 'extra', agentProfile('extra'));
    fs.mkdirSync(path.join(dataDir, 'agents', 'empty'));
    const options = { rootDir, dataDir, env: {} };
    assert.deepEqual(agentNames(options), ['scout']);
    assert.equal(profileOf('extra', options), null);
  });
});

test('a local folder that shares a tracked name overlays it and marks it local', () => {
  withLocalLayer((rootDir, dataDir) => {
    writeLocal(dataDir, 'scout', { limits: { steps: 9 } }, null);
    const probe = profileOf('scout', { rootDir, dataDir, env: {} });
    // Changed: `local` names an overlaid agent, since no agent lives in the data folder alone.
    assert.equal(probe?.origin, 'local');
    assert.equal(probe?.defaultLimits.steps, 9);
  });
});

test('readPromptFile: an override that exists but cannot be read falls back to the tracked prompt, warned once; other errors still throw', () => {
  const override = '/private-unreadable/agents/scout/prompt.md';
  const tracked = '/checkout/agents/scout/prompt.md';
  const failing = (code: Untyped) => (file: string) => {
    if (file === override) throw Object.assign(new Error(`${code}: ${file}`), { code });
    if (file === tracked) return 'tracked';
    throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  };
  const seen: Array<Untyped> = [];
  const off = onLog((entry) => seen.push(entry));
  try {
    assert.equal(readPromptFile([override, tracked], { read: failing('EACCES') }), 'tracked');
    assert.equal(readPromptFile([override, tracked], { read: failing('EACCES') }), 'tracked', 'every task falls back');
    assert.equal(readPromptFile([override, tracked], { read: failing('EPERM') }), 'tracked');
    const warns = seen.filter((entry) => entry.msg === 'profiles: override unreadable');
    assert.equal(warns.length, 1, 'one warning per process, not per task');
    assert.equal(warns[0].level, 'warn');
    assert.equal(warns[0].file, override);
    assert.throws(
      () => readPromptFile([override, tracked], { read: failing('EISDIR') }),
      { code: 'EISDIR' },
      'any other error still fails'
    );
    const trackedDenied = (file: string) => {
      if (file === override) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    assert.throws(
      () => readPromptFile([override, tracked], { read: trackedDenied }),
      { code: 'EACCES' },
      'the tracked prompt itself unreadable still fails'
    );
  } finally {
    off();
  }
});

// New reproductions, written from the risk the plan describes (a profile that changes between its check and its use);
// the original scenarios were not found. A personal definition is validated and consumed from one trusted snapshot, so
// swapping a file for a link to somewhere else in the gap between the check and the read gains nothing. The gap is made
// deterministic by acting at the module's own file reads: the swap happens exactly when the code reaches that file.

const OUTSIDE_SECONDS = 99_999;

/** Calls `onRead(file)` before each read of a file by path, then reads it as asked; `undo` puts `fs` back. */
function atEachRead(onRead: (file: string) => void): { undo: () => void } {
  const original = fs.readFileSync;
  const wrapped = (file: unknown, ...rest: Array<unknown>): unknown => {
    if (typeof file === 'string') onRead(file);
    return Reflect.apply(original, fs, [file, ...rest]);
  };
  // The modules under test read through this object; a test replaces the one method for the length of one call.
  Object.assign(fs, { readFileSync: wrapped });
  return { undo: () => Object.assign(fs, { readFileSync: original }) };
}

test('new reproduction: a profile swapped for a link after its check does not reach the definition', () => {
  // Bug: the link check and the read are two steps, so a link placed between them feeds in limits from any file, and
  // putting the file back before the second check leaves no trace.
  const rig = consumerRig();
  const file = path.join(rig.personal, 'profile.json');
  rig.override({ limits: { seconds: 17 } });
  const regular = fs.readFileSync(file, 'utf8');
  const outside = path.join(rig.base, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ limits: { seconds: OUTSIDE_SECONDS } }));
  const original = fs.readFileSync;
  let swapped = false;
  const hook = atEachRead((read) => {
    if (read !== file || swapped) return;
    swapped = true;
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    // The read below follows the link; the file is back before anything looks again.
    queueMicrotask(() => {});
  });
  const restoring = fs.readFileSync;
  Object.assign(fs, {
    readFileSync: (given: unknown, ...rest: Array<unknown>): unknown => {
      const text = Reflect.apply(restoring, fs, [given, ...rest]) as unknown;
      if (given === file && fs.lstatSync(file).isSymbolicLink()) {
        fs.rmSync(file);
        fs.writeFileSync(file, regular);
      }
      return text;
    },
  });
  try {
    let seconds: unknown = null;
    try {
      const definition = listAgents(rig.options).find((agent) => agent.id === 'scout');
      seconds = (definition as { limits?: { seconds?: unknown } } | undefined)?.limits?.seconds;
    } catch (error) {
      assert.ok(error instanceof AgentProfileError, String(error));
    }
    assert.notEqual(seconds, OUTSIDE_SECONDS);
  } finally {
    hook.undo();
    Object.assign(fs, { readFileSync: original });
    rig.close();
  }
});

test('new reproduction: a prompt swapped for a link after the check does not reach the brief', async () => {
  // Bug: the engine validates the definition, then opens the prompt by path, so a link placed in between sends the
  // contents of any readable file to the model as its instructions.
  const rig = consumerRig();
  const prompt = path.join(rig.personal, 'prompt.md');
  fs.mkdirSync(rig.personal, { recursive: true });
  fs.writeFileSync(prompt, 'PERSONAL-PROMPT');
  const outside = path.join(rig.base, 'outside-secret.txt');
  fs.writeFileSync(outside, 'OUTSIDE-SECRET-MARKER');
  const engine = consumers.engine({
    profile: rig.profile,
    agentPaths: rig.options,
    outDir: path.join(rig.base, 'out'),
    subharness: rig.subharness,
  });
  let swapped = false;
  const hook = atEachRead((read) => {
    if (read !== prompt || swapped) return;
    swapped = true;
    fs.rmSync(prompt);
    fs.symlinkSync(outside, prompt);
  });
  try {
    await engine.run({
      id: 'swapped',
      agent: 'scout',
      goal: 'inspect synthetic files',
      context: {},
      signal: new AbortController().signal,
    });
    for (const call of rig.calls) assert.doesNotMatch(call.brief, /OUTSIDE-SECRET-MARKER/);
  } finally {
    hook.undo();
    rig.close();
  }
});

// `agentSettings(name, config)` is the one reader of an agent's settings: its profile with `config.agents.<name>` laid
// over it, and `enabled` from the config alone.

test('an agent is off until the config switches it on', () => {
  // Bug: an agent the owner never enabled takes errands.
  assert.equal(agentSettings('scout', {}, { env: {} })?.enabled, false);
  assert.equal(agentSettings('scout', { agents: { scout: { enabled: true } } }, { env: {} })?.enabled, true);
});

test('the config lays limits and daily over the profile key by key', () => {
  // The cost overlay left with the profile key `cost`, which no runner read.
  const settings = agentSettings('server', { agents: { server: { limits: { steps: 3 } } } }, { env: {} });
  assert.deepEqual(settings?.limits, { steps: 3, seconds: 120 });
  assert.deepEqual(settings?.daily, { tasks: 40 });
});

test('says null for agents.ledger and for a name no profile has', () => {
  assert.equal(agentSettings('ledger', { agents: { ledger: {} } }, { env: {} }), null);
  assert.equal(agentSettings('ghost', { agents: { ghost: { enabled: true } } }, { env: {} }), null);
});

test('a unit has its socket and out folder under /run and /var/lib, named for the unit', () => {
  // Changed: the units are the agents' names.
  assert.deepEqual(unitPaths('scout', {}), {
    socket: '/run/neptunia-agent-scout/sock',
    out: '/var/lib/neptunia-agent-scout/out',
  });
});

test('in a user unit the socket and out folder lie in the unit folders of the user', () => {
  // Bug: the user unit starts a runner that tries to create /run/neptunia-agent-server and fails.
  // Changed: the units are the agents' names.
  const env = { [UNIT_SCOPE_ENV]: 'user', XDG_RUNTIME_DIR: '/run/user/1000', XDG_STATE_HOME: '/home/a/.local/state' };
  assert.deepEqual(unitPaths('server', env), {
    socket: '/run/user/1000/neptunia-agent-server/sock',
    out: '/home/a/.local/state/neptunia-agent-server/out',
  });
});

test('the state folder falls back to HOME/.local/state when XDG_STATE_HOME is unset', () => {
  // Bug: the out folder becomes a relative path when the user manager sets no XDG_STATE_HOME.
  assert.equal(
    // Changed: the units are the agents' names.
    unitPaths('scout', { [UNIT_SCOPE_ENV]: 'user', HOME: '/home/b' }).out,
    '/home/b/.local/state/neptunia-agent-scout/out'
  );
});
