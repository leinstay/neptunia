// Public agent loaders merge portable persona definitions and resolve prompts without legacy runtime paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPromptFile } from '../src/agent-runner/opencode.ts';
import { agents, fixture, profileError, watcher } from './fixtures/agent-overrides.ts';

test('a missing personal root preserves the shared worker without creating persona files', (t) => {
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
  assert.equal(fs.existsSync(f.dataDir), false);
});

test('shared agents remain sorted while ordinary root files are ignored', (t) => {
  const f = fixture();
  t.after(f.close);
  f.writeShared('assistant', {
    id: 'assistant',
    kind: 'consultation',
    role: 'dev',
    prompt: null,
    override: null,
    description: 'Synthetic consultation.',
  });
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
  assert.equal(readPromptFile(agents.promptFilesOf('scout', f.options)), 'personal marker');
});

test('an empty personal object retains every shared field', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({});
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
});

test('nested limits retain absent siblings while tools replace the entire shared array', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ limits: { steps: 7 }, tools: ['read'] });
  const definition = agents.listAgents(f.options)[0];
  assert.equal(definition?.kind, 'worker');
  if (definition?.kind !== 'worker') assert.fail('expected the shared worker');
  assert.deepEqual(definition.limits, { steps: 7, seconds: 300 });
  assert.deepEqual(definition.tools, ['read']);
});

test('an explicit nullable value replaces the shared search provider', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ searchProvider: null });
  assert.equal(agents.loadProfiles(f.options).scout.defaultSearchProvider, null);
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
  f.override({ id: 'scout', kind: 'worker', role: 'scout' });
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
});

for (const [key, value] of [
  ['id', 'other'],
  ['kind', 'development'],
  ['role', 'server'],
] as const) {
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
  ['tools', ['write']],
  ['tools', []],
  ['tools', ['read', 'read']],
  ['limits.steps', { limits: { steps: 1.5 } }],
  ['limits.seconds', { limits: { seconds: 0 } }],
  ['daily.tasks', { daily: { tasks: 0 } }],
  ['cost.input', { cost: { input: -1 } }],
  ['socket', 'relative/socket'],
  ['out', '/synthetic/\0out'],
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

test('a personal directory cannot introduce an agent without a shared definition', (t) => {
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(path.join(f.dataDir, 'agents', 'ghost'), { recursive: true });
  assert.throws(() => agents.listAgents(f.options), profileError('ghost', 'id'));
});

test('merged definitions freeze nested objects and arrays before returning them', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ limits: { steps: 7 } });
  const all = agents.listAgents(f.options);
  const definition = all[0];
  if (definition?.kind !== 'worker') assert.fail('expected the shared worker');
  for (const value of [
    all,
    definition,
    definition.limits,
    definition.cost,
    definition.daily,
    definition.tools,
    definition.env,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => Object.assign(definition.limits, { steps: 99 }), TypeError);
  assert.throws(() => Object.assign(definition.tools, { 0: 'write' }), TypeError);
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
      const definition = agents.listAgents(f.options)[0];
      return definition?.kind === 'worker' ? definition.limits.steps : null;
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
  f.override({ enabled: true, limits: { steps: 8 }, cost: { input: 1 } });
  const config = { agents: { scout: { limits: { seconds: 12 }, cost: { output: 3 } } } };
  const settings = agents.agentSettings('scout', config, f.options);
  assert.deepEqual(settings?.limits, { steps: 8, seconds: 12 });
  assert.deepEqual(settings?.cost, { input: 1, output: 3 });
  assert.equal(settings?.enabled, true);
  config.agents.scout.limits.seconds = 13;
  assert.equal(agents.agentSettings('scout', config, f.options)?.limits.seconds, 13);
});

test('empty config paths fall back to the personal profile paths', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ socket: '/synthetic/persona.sock', out: '/synthetic/persona-out' });
  const settings = agents.agentSettings('scout', { agents: { scout: { socket: '', out: null } } }, f.options);
  assert.equal(settings?.socket, '/synthetic/persona.sock');
  assert.equal(settings?.out, '/synthetic/persona-out');
});

test('injected user-unit paths replace profile defaults while usable config paths win', (t) => {
  const f = fixture();
  t.after(f.close);
  const options = {
    ...f.options,
    env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_RUNTIME_DIR: '/synthetic/runtime', XDG_STATE_HOME: '/synthetic/state' },
  };
  const settings = agents.agentSettings('scout', {}, options);
  assert.equal(settings?.socket, '/synthetic/runtime/neptunia-agent-scout/sock');
  assert.equal(settings?.out, '/synthetic/state/neptunia-agent-scout/out');
  const configured = agents.agentSettings(
    'scout',
    { agents: { scout: { socket: '/explicit.sock', out: '/explicit-out' } } },
    options
  );
  assert.equal(configured?.socket, '/explicit.sock');
  assert.equal(configured?.out, '/explicit-out');
  assert.equal(agents.agentSettings('scout', {}, f.options)?.socket, f.definition.socket);
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
  assert.equal(agents.agentSettings('scout', {}, f.options)?.socket, f.definition.socket);
  assert.deepEqual(agents.promptFilesOf('scout', { rootDir: f.rootDir, env: {} }), [
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
    env: { NEPTUNIA_DATA_DIR: path.join(f.base, 'other-data'), NEPTUNIA_PRIVATE_DIR: privateDir },
    override: 'legacy.md',
  };
  const files = agents.promptFilesOf('scout', options);
  assert.deepEqual(files, [path.join(f.personal, 'prompt.md'), path.join(f.shared, 'prompt.md')]);
  assert.equal(readPromptFile(files), 'personal marker');
});

test('an omitted explicit data root follows the injected relative environment path', (t) => {
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(
    agents.promptFilesOf('scout', { rootDir: f.rootDir, env: { NEPTUNIA_DATA_DIR: 'environment-persona' } }),
    [path.join(f.rootDir, 'environment-persona/agents/scout/prompt.md'), path.join(f.shared, 'prompt.md')]
  );
});

test('a relative explicit data root resolves against the engine root', (t) => {
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(agents.promptFilesOf('scout', { rootDir: f.rootDir, dataDir: 'relative-persona', env: {} }), [
    path.join(f.rootDir, 'relative-persona/agents/scout/prompt.md'),
    path.join(f.shared, 'prompt.md'),
  ]);
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

for (const name of ['../scout', 'a/b', 'scout\0', '']) {
  test(`prompt resolution refuses invalid agent id ${JSON.stringify(name)}`, (t) => {
    const f = fixture();
    t.after(f.close);
    assert.throws(() => agents.promptFilesOf(name, f.options), profileError(name, 'id'));
  });
}

for (const prompt of ['../prompt.md', 'nested/prompt.md', 'bad\0.md', 'prompt.txt']) {
  test(`prompt resolution refuses invalid filename ${JSON.stringify(prompt)}`, (t) => {
    const f = fixture();
    t.after(f.close);
    assert.throws(() => agents.promptFilesOf('scout', { ...f.options, prompt }), profileError('scout', 'prompt'));
  });
}

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
      () => (part === 'prompt' ? agents.promptFilesOf('scout', f.options) : agents.listAgents(f.options)),
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
  assert.equal(readPromptFile(agents.promptFilesOf('scout', f.options)), 'shared marker');
});

test('an empty selected personal prompt fails instead of falling through to shared content', (t) => {
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(f.personal, { recursive: true });
  fs.writeFileSync(path.join(f.personal, 'prompt.md'), ' \n');
  assert.throws(() => readPromptFile(agents.promptFilesOf('scout', f.options)));
});

test('watcher and development definitions use the same overlay without entering worker selection', (t) => {
  const f = fixture();
  t.after(f.close);
  f.writeShared('watcher', watcher());
  f.writeShared('dev', {
    id: 'dev',
    kind: 'development',
    role: 'dev',
    prompt: 'prompt.md',
    override: null,
    tools: ['read'],
    permission: { read: 'allow' },
    effort: 'medium',
    limits: { steps: 50, minutes: 30 },
    cost: { input: 2, output: 10 },
    description: 'Synthetic development agent.',
  });
  f.writeShared('consult', {
    id: 'consult',
    kind: 'consultation',
    role: 'dev',
    prompt: null,
    override: null,
    description: 'Synthetic consultation.',
  });
  const folder = path.join(f.dataDir, 'agents', 'watcher');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'profile.json'),
    JSON.stringify({ description: 'Personal watcher.', prompt: 'custom.md' })
  );
  const all = agents.listAgents(f.options);
  assert.deepEqual(
    all.map((entry) => entry.id),
    ['consult', 'dev', 'scout', 'watcher']
  );
  assert.deepEqual(
    all.find((entry) => entry.id === 'watcher'),
    { ...watcher(), description: 'Personal watcher.', prompt: 'custom.md' }
  );
  assert.deepEqual(Object.keys(agents.loadProfiles(f.options)), ['scout']);
  for (const name of ['watcher', 'dev', 'consult']) assert.equal(agents.profileOf(name, f.options), null);
  assert.equal(agents.agentSettings('watcher', {}, f.options), null);
  assert.equal(agents.agentSettings('consult', {}, f.options), null);
});

for (const [key, value] of [
  ['role', 'dev'],
  ['backend', 'codex'],
  ['model', 'synthetic/model'],
  ['override', 'legacy.md'],
] as const) {
  test(`watcher definitions reject unsupported ${key}`, (t) => {
    const f = fixture();
    t.after(f.close);
    f.writeShared('watcher', { ...watcher(), [key]: value });
    assert.throws(() => agents.listAgents(f.options), profileError('watcher', key));
  });
}

test('shared compatibility snapshots ignore process persona links before explicit loader paths are supplied', (t) => {
  const f = fixture();
  t.after(f.close);
  f.override({ limits: { seconds: 17 } });
  const processData = path.join(f.base, 'process-persona');
  fs.mkdirSync(path.join(processData, 'agents'), { recursive: true });
  fs.symlinkSync(f.personal, path.join(processData, 'agents', 'scout'));
  const moduleUrl = new URL('../src/agent-runner/profiles.ts', import.meta.url).href;
  const script = `
    const { SCOUT, PROFILES, loadProfiles } = await import(${JSON.stringify(moduleUrl)});
    const selected = loadProfiles(${JSON.stringify(f.options)});
    process.stdout.write(JSON.stringify([SCOUT.name, Object.keys(PROFILES).sort(), selected.scout.defaultLimits.seconds]));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, NEPTUNIA_DATA_DIR: processData },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['scout', ['scout', 'server'], 17]);
});

test('an ordinary personal root file named for a shared worker contributes no override', (t) => {
  const f = fixture();
  t.after(f.close);
  fs.mkdirSync(path.join(f.dataDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, 'agents', 'scout'), 'ordinary synthetic file');
  assert.deepEqual(agents.listAgents(f.options), [f.definition]);
  assert.deepEqual(agents.loadProfiles(f.options).scout.defaultLimits, f.definition.limits);
});
