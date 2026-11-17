// Public agent loaders merge portable persona definitions and resolve prompts without legacy runtime paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPromptFile } from '../src/agent-runner/opencode.ts';
import { agents, fixture, profileError } from './fixtures/agent-overrides.ts';

test('a missing personal root preserves the shared worker without creating persona files', (t) => {
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
  assert.equal(fs.existsSync(f.dataDir), false);
});

test('shared agents remain sorted while ordinary root files are ignored', (t) => {
  const f = fixture();
  t.after(f.close);
  f.writeShared('assistant', { ...f.definition, id: 'assistant', description: 'Synthetic second agent.' });
  fs.writeFileSync(path.join(f.rootDir, 'agents', 'README.md'), 'shared notes');
  fs.mkdirSync(path.join(f.dataDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, 'agents', 'README.md'), 'personal notes');
  assert.deepEqual(
    agents.listAgents(f.options).map((entry) => entry.id),
    ['assistant', 'scout']
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

// Changed: `kind` and `role` left the profile, so `id` is the one identity a personal profile cannot change.
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
  ['cost.input', { cost: { input: -1 } }],
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
  // Changed: a local folder with a whole profile and its prompt is an agent of its own (tests/agent-runner-profiles.test.ts);
  // one with no profile, such as a folder an older version left, adds none and fails nothing.
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
  for (const value of [all, definition, definition.limits, definition.cost, definition.daily]) {
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
  f.override({ limits: { steps: 8 }, cost: { input: 1 } });
  const config = { agents: { scout: { enabled: true, limits: { seconds: 12 }, cost: { output: 3 } } } };
  const settings = agents.agentSettings('scout', config, f.options);
  assert.deepEqual(settings?.limits, { steps: 8, seconds: 12 });
  assert.deepEqual(settings?.cost, { input: 1, output: 3 });
  assert.equal(settings?.enabled, true);
  config.agents.scout.limits.seconds = 13;
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
