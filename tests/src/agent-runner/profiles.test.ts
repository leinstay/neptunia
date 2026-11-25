// Tests for src/agent-runner/profiles.ts: the agents on disk (tracked folders, one per unit, and a local overlay), the
// profile's keys and their checks, the settings of an agent with the deployment's config over its
// profile, the merge of a personal definition over a shared one with its prompt, and the socket and out folder of a
// unit. Pure but for reading agents/ and temporary directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPromptFile } from '../../../src/agent-runner/opencode.ts';
import { agents, fixture, profileError } from '../../fixtures/agent-overrides.ts';
import {
  AgentProfileError,
  agentNames,
  agentSettings,
  listAgents,
  loadProfiles,
  profileOf,
  unitPaths,
  UNIT_SCOPE_ENV,
} from '../../../src/agent-runner/profiles.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { consumerRig } from '../../fixtures/agent-consumers.ts';

const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

test('a missing personal root preserves the shared worker without creating persona files', (t) => {
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
  assert.equal(fs.existsSync(f.dataDir), false);
});

test('shared agents remain sorted while ordinary root files are ignored', (t) => {
  const f = fixture();
  t.after(f.close);
  // An agent is named for its unit, so the second agent is the code agent.
  f.writeShared('code', { ...f.definition, id: 'code', description: 'Synthetic second agent.' });
  fs.writeFileSync(path.join(f.rootDir, 'agents', 'README.md'), 'shared notes');
  fs.mkdirSync(path.join(f.dataDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, 'agents', 'README.md'), 'personal notes');
  assert.deepEqual(
    agents.listAgents(f.options).map((entry) => entry.id),
    ['code', 'scout']
  );
});

test('a missing required shared tree fails even when a personal tree exists', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({});
  fs.rmSync(path.join(f.rootDir, 'agents'), { recursive: true });
  assert.throws(() => agents.listAgents(f.options), { code: 'ENOENT' });
});

test('a prompt-only personal directory preserves the shared definition', (t) => {
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(f.personal, { recursive: true });
  fs.writeFileSync(path.join(f.personal, 'prompt.md'), 'personal marker');
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
  assert.equal(readPromptFile(agents.loadProfiles(f.options).scout.promptFiles), 'personal marker');
});

test('an empty personal object retains every shared field', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({});
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
});

test('nested limits retain absent siblings', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ limits: { steps: 7 } });
  const definition = agents.listAgents(f.options)[0];
  assert.deepEqual(definition?.limits, { steps: 7, seconds: 300 });
});

test('a null required object fails validation instead of inheriting shared limits', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ limits: null });
  assert.throws(() => agents.listAgents(f.options), profileError('scout', 'limits'));
});

test('identical identity fields remain valid in a personal profile', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ id: 'scout' });
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
});

// `id` is the one identity a personal profile cannot change.
for (const [key, value] of [['id', 'other']] as const) {
  test(`a personal profile cannot change shared ${key}`, (t) => {
    const f = fixture();
    t.after(f.close);
    f.override({ [key]: value });
    assert.throws(() => agents.listAgents(f.options), profileError('scout', key));
  });
}

for (const contents of ['', '{broken', 'null', '[]', '42', '"text"', 'true']) {
  test(`personal profile contents ${JSON.stringify(contents)} fail instead of selecting defaults`, (t) => {
    const f = fixture();
    t.after(f.close);
    f.override({});
    fs.writeFileSync(path.join(f.personal, 'profile.json'), contents);
    assert.throws(() => agents.listAgents(f.options), profileError('scout', 'profile.json'));
  });
}

for (const code of ['EACCES', 'EIO']) {
  test(`an existing personal profile with ${code} fails with its structured profile key`, (t) => {
    const f = fixture();
    t.after(f.close);
    f.override({});
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === path.join(f.personal, 'profile.json'))
        throw Object.assign(new Error('synthetic read failure'), { code });
      return read(...args);
    });
    assert.throws(() => agents.listAgents(f.options), profileError('scout', 'profile.json'));
  });
}

test('a personal patch cannot repair an invalid shared definition before validation', (t) => {
  const f = fixture();
  t.after(f.close);
  f.writeShared('scout', { ...f.definition, limits: { steps: 0, seconds: 300 } });
  f.override({ limits: { steps: 7 } });
  assert.throws(() => agents.listAgents(f.options), profileError('scout', 'limits.steps'));
});

const invalidOverrides: Array<[string, unknown]> = [
  ['backend', 'claude'],
  ['model', 'synthetic/model'],
  ['unit', 'cloud'],
  ['limits.steps', { limits: { steps: 1.5 } }],
  ['limits.seconds', { limits: { seconds: 0 } }],
  ['daily.tasks', { daily: { tasks: 0 } }],
  ['prompt', '../prompt.md'],
];

for (const [key, value] of invalidOverrides) {
  test(`a personal override validates ${key} after merging ${JSON.stringify(value)}`, (t) => {
    const f = fixture();
    t.after(f.close);
    f.override(key.includes('.') ? value : { [key]: value });
    assert.throws(() => agents.listAgents(f.options), profileError('scout', key));
  });
}

test('a personal directory with no profile adds no agent', (t) => {
  // A local folder whose name is no tracked agent adds none and fails nothing.
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(path.join(f.dataDir, 'agents', 'ghost'), { recursive: true });
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
});

test('merged definitions freeze nested objects before returning them', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ limits: { steps: 7 } });
  const all = agents.listAgents(f.options);
  const definition = all[0];
  if (definition === undefined) assert.fail('expected the shared agent');
  for (const value of [all, definition, definition.limits, definition.daily]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => Object.assign(definition.limits, { steps: 99 }), TypeError);
  assert.throws(() => Object.assign(all, { 0: {} }), TypeError);
  assert.equal(agents.loadProfiles(f.options).scout.defaultLimits.steps, 7);
});

for (const reader of ['listAgents', 'loadProfiles', 'profileOf', 'agentSettings'] as const) {
  test(`${reader} reads a personal edit and deletion on successive calls`, (t) => {
    const f = fixture();
    t.after(f.close);
    const steps = () => {
      if (reader === 'loadProfiles') return agents.loadProfiles(f.options).scout.defaultLimits.steps;
      if (reader === 'profileOf') return agents.profileOf('scout', f.options)?.defaultLimits.steps;
      if (reader === 'agentSettings') return agents.agentSettings('scout', {}, f.options)?.limits.steps;
      return agents.listAgents(f.options)[0]?.limits.steps;
    };
    f.override({ limits: { steps: 8 } });
    assert.equal(steps(), 8);
    f.override({ limits: { steps: 9 } });
    assert.equal(steps(), 9);
    fs.unlinkSync(path.join(f.personal, 'profile.json'));
    assert.equal(steps(), 25);
  });
}

test('live config overrides personal settings while retaining the other nested limit', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ limits: { steps: 8 } });
  const config = { agents: { scout: { enabled: true, limits: { seconds: 12 } } } };
  const settings = agents.agentSettings('scout', config, f.options);
  // The cost overlay left with the profile key `cost`, which no runner read; the limits carry the same merge.
  assert.deepEqual(settings?.limits, { steps: 8, seconds: 12 });
  assert.equal(settings?.enabled, true);
  const { scout } = config.agents;
  scout.limits.seconds = 13;
  assert.equal(agents.agentSettings('scout', config, f.options)?.limits.seconds, 13);
});

test('an explicitly empty environment excludes process user-unit and data settings', (t) => {
  const f = fixture();
  t.after(f.close);
  const originalEnv = process.env;
  t.after(() => {
    process.env = originalEnv;
  });
  process.env = {
    ...originalEnv,
    NEPTUNIA_UNIT_SCOPE: 'user',
    NEPTUNIA_DATA_DIR: path.join(f.base, 'wrong-data'),
    XDG_RUNTIME_DIR: '/wrong-runtime',
  };
  assert.deepEqual(agents.loadProfiles({ rootDir: f.rootDir, env: {} }).scout.promptFiles, [
    path.join(f.rootDir, 'data/agents/scout/prompt.md'),
    path.join(f.shared, 'prompt.md'),
  ]);
});

test('canonical prompts prefer the explicit data root and ignore private legacy files', (t) => {
  const f = fixture();
  t.after(f.close);
  const privateDir = path.join(f.base, 'private');
  fs.mkdirSync(path.join(privateDir, 'prompts.local'), { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'prompts.local', 'legacy.md'), 'legacy decoy');
  fs.mkdirSync(f.personal, { recursive: true });
  fs.writeFileSync(path.join(f.personal, 'prompt.md'), '\ufeff personal marker \n');
  const options = {
    ...f.options,
    env: { NEPTUNIA_DATA_DIR: path.join(f.base, 'other-data') },
    override: 'legacy.md',
  };
  const files = agents.loadProfiles(options).scout.promptFiles;
  assert.deepEqual(files, [path.join(f.personal, 'prompt.md'), path.join(f.shared, 'prompt.md')]);
  assert.equal(readPromptFile(files), 'personal marker');
});

test('an omitted explicit data root follows the injected relative environment path', (t) => {
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(
    agents.loadProfiles({ rootDir: f.rootDir, env: { NEPTUNIA_DATA_DIR: 'environment-persona' } }).scout.promptFiles,
    [path.join(f.rootDir, 'environment-persona/agents/scout/prompt.md'), path.join(f.shared, 'prompt.md')]
  );
});

test('a relative explicit data root resolves against the engine root', (t) => {
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(
    agents.loadProfiles({ rootDir: f.rootDir, dataDir: 'relative-persona', env: {} }).scout.promptFiles,
    [path.join(f.rootDir, 'relative-persona/agents/scout/prompt.md'), path.join(f.shared, 'prompt.md')]
  );
});

test('worker prompt candidates use the effective personal filename', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ prompt: 'custom.md' });
  assert.deepEqual(agents.loadProfiles(f.options).scout.promptFiles, [
    path.join(f.personal, 'custom.md'),
    path.join(f.shared, 'custom.md'),
  ]);
});

for (const part of ['directory', 'profile', 'prompt'] as const) {
  test(`a personal ${part} symlink is rejected before shared fallback`, (t) => {
    const f = fixture();
    t.after(f.close);
    fs.mkdirSync(path.dirname(f.personal), { recursive: true });
    if (part === 'directory') fs.symlinkSync(f.shared, f.personal, 'dir');
    else {
      fs.mkdirSync(f.personal);
      const filename = part === 'profile' ? 'profile.json' : 'prompt.md';
      fs.symlinkSync(path.join(f.shared, filename), path.join(f.personal, filename));
    }
    const key = part === 'directory' ? 'id' : part === 'profile' ? 'profile.json' : 'prompt';
    assert.throws(
      () => (part === 'prompt' ? agents.loadProfiles(f.options).scout.promptFiles : agents.listAgents(f.options)),
      profileError('scout', key)
    );
  });
}

test('a non-directory personal agents root propagates its filesystem error', (t) => {
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(f.dataDir);
  fs.writeFileSync(path.join(f.dataDir, 'agents'), 'not a directory');
  assert.throws(() => agents.listAgents(f.options), { code: 'ENOTDIR' });
});

test('an unreadable personal agents root propagates its filesystem error', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({});
  const read = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === path.join(f.dataDir, 'agents'))
      throw Object.assign(new Error('synthetic root failure'), { code: 'EACCES' });
    return read(...args);
  });
  assert.throws(() => agents.listAgents(f.options), { code: 'EACCES' });
});

test('a missing personal prompt selects the shared prompt', (t) => {
  const f = fixture();
  t.after(f.close);
  assert.equal(readPromptFile(agents.loadProfiles(f.options).scout.promptFiles), 'shared marker');
});

test('an empty selected personal prompt fails instead of falling through to shared content', (t) => {
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(f.personal, { recursive: true });
  fs.writeFileSync(path.join(f.personal, 'prompt.md'), ' \n');
  assert.throws(() => readPromptFile(agents.loadProfiles(f.options).scout.promptFiles));
});

test('an ordinary personal root file named for a shared worker contributes no override', (t) => {
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(path.join(f.dataDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, 'agents', 'scout'), 'ordinary synthetic file');
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
  assert.deepEqual(agents.loadProfiles(f.options).scout.defaultLimits, f.definition.limits);
});

// The three agents each run in the unit of their name.
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
  // An agent is named for its unit, so the probe is the server.
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
  // `unit` is a retired key too, since an agent runs in the unit of its name.
  for (const key of [...keys, 'abilities', 'returns', 'audience', 'unit']) {
    withAgentsTree({ scout: agentProfile('scout', { [key]: 'x' }) }, (rootDir: string) =>
      assertRefused(rootDir, 'scout', key)
    );
  }
});

test('loadProfiles: a missing key or a value of the wrong form is refused, naming the key', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    // The unit is the agent's name, so a missing `description` stands for a missing key.
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

// The agents are the three tracked ones, so a local folder of another name, whole or not, is no agent.
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
    // `local` names an overlaid agent, since no agent lives in the data folder alone.
    assert.equal(probe?.origin, 'local');
    assert.equal(probe?.defaultLimits.steps, 9);
  });
});

// A profile that changes between its check and its use. A personal definition is validated and consumed from one trusted snapshot, so
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

// `agentSettings(name, config)` is the one reader of an agent's settings: its profile with `config.agents.<name>` laid
// over it, and `enabled` from the config alone.

test('an agent is off until the config switches it on', () => {
  // Bug: an agent that the config never switches on takes errands.
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
  // The units are the agents' names.
  assert.deepEqual(unitPaths('scout', {}), {
    socket: '/run/neptunia-agent-scout/sock',
    out: '/var/lib/neptunia-agent-scout/out',
  });
});

test('in a user unit the socket and out folder lie in the unit folders of the user', () => {
  // Bug: the user unit starts a runner that tries to create /run/neptunia-agent-server and fails.
  // The units are the agents' names.
  const env = { [UNIT_SCOPE_ENV]: 'user', XDG_RUNTIME_DIR: '/run/user/1000', XDG_STATE_HOME: '/home/a/.local/state' };
  assert.deepEqual(unitPaths('server', env), {
    socket: '/run/user/1000/neptunia-agent-server/sock',
    out: '/home/a/.local/state/neptunia-agent-server/out',
  });
});

test('the state folder falls back to HOME/.local/state when XDG_STATE_HOME is unset', () => {
  // Bug: the out folder becomes a relative path when the user manager sets no XDG_STATE_HOME.
  assert.equal(
    // The units are the agents' names.
    unitPaths('scout', { [UNIT_SCOPE_ENV]: 'user', HOME: '/home/b' }).out,
    '/home/b/.local/state/neptunia-agent-scout/out'
  );
});

function stray(dataDir: string, name = 'ghost'): void {
  fs.mkdirSync(path.join(dataDir, 'agents', name), { recursive: true });
}

test('listAgents returns the shared agents when a stray folder sits beside them', (t) => {
  // Bug: one folder left by an older version made the whole load throw, so no shared agent loaded at all.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  assert.deepEqual(
    agents.listAgents(f.options).map((entry) => entry.id),
    ['scout']
  );
});

test('loadProfiles builds the profile of a shared agent when a stray folder sits beside it', (t) => {
  // Bug: the profiles the runners and the errand service use were all lost to one stray folder.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  assert.deepEqual(Object.keys(agents.loadProfiles(f.options)), ['scout']);
  assert.equal(agents.profileOf('scout', f.options)?.name, 'scout');
  assert.equal(agents.profileOf('ghost', f.options), null);
});

test('a stray folder does not stop the personal override of a shared agent', (t) => {
  // Bug: skipping the stray folder must not skip the personal folders next to it.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  f.override({ limits: { steps: 7 } });
  assert.equal(agents.loadProfiles(f.options).scout?.defaultLimits.steps, 7);
});

test('a symbolic link under the personal agents folder still throws beside a stray folder', (t) => {
  // Bug: the link refusal was dropped together with the stray-folder one.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  fs.symlinkSync(f.shared, path.join(f.dataDir, 'agents', 'link'), 'dir');
  assert.throws(() => agents.listAgents(f.options), profileError('link', 'id'));
});

test('a broken personal profile of a shared agent still throws beside a stray folder', (t) => {
  // Bug: swallowing the stray-folder error must not swallow a real profile error.
  const f = fixture();
  t.after(f.close);
  stray(f.dataDir);
  f.override({ id: 'other' });
  assert.throws(() => agents.listAgents(f.options), profileError('scout', 'id'));
});
