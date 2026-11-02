// Offline persona-layer migration through its public planner and applier, using synthetic roots only.
// These regressions cover source preservation, conflicting destinations and safe recovery after an interrupted copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyPersonaLayers, planPersonaLayers } from '../src/config/persona-migration.ts';
import type { PersonaLayerOptions, PersonaLayerIssue } from '../src/config/persona-migration.ts';
import { tempDir } from './fixtures/tmp.ts';

function write(root: string, relative: string, bytes: string, mode = 0o640): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode });
}

function fixture(): PersonaLayerOptions {
  const base = tempDir('nep-persona-migration-');
  const options = {
    rootDir: path.join(base, 'engine'),
    privateDir: path.join(base, 'private'),
    dataDir: path.join(base, 'persona'),
  };
  for (const dir of Object.values(options)) fs.mkdirSync(dir);
  write(
    options.rootDir,
    'config/labels.json',
    JSON.stringify({ model: { reply: 'base' }, owner: { status: { title: 'base' } } })
  );
  fs.mkdirSync(path.join(options.rootDir, 'agents'));
  return options;
}

function declareAgent(rootDir: string, override: string): void {
  write(
    rootDir,
    'agents/probe/profile.json',
    JSON.stringify({
      id: 'probe',
      kind: 'worker',
      role: 'server',
      prompt: 'prompt.md',
      override,
      tools: ['read', 'list'],
      shell: 'server-read-only',
      limits: { steps: 5, seconds: 60 },
      daily: { tasks: 3 },
      searchProvider: null,
      enabled: false,
      cost: { input: 2, output: 6 },
      socket: '/run/test-probe/sock',
      out: '/var/lib/test-probe/out',
      env: [],
      description: 'A test worker.',
    })
  );
}

function snapshot(root: string): Record<string, { mode: number; content: string }> {
  const result: Record<string, { mode: number; content: string }> = {};
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const at = path.join(relative, entry.name);
      const full = path.join(root, at);
      const mode = fs.lstatSync(full).mode & 0o777;
      if (entry.isSymbolicLink()) result[at] = { mode, content: `link:${fs.readlinkSync(full)}` };
      else if (entry.isDirectory()) {
        result[at] = { mode, content: 'directory' };
        walk(at);
      } else result[at] = { mode, content: fs.readFileSync(full, 'utf8') };
    }
  };
  walk('');
  return result;
}

function assertRefuses(options: PersonaLayerOptions, code: PersonaLayerIssue['code']): void {
  write(options.privateDir, 'prompts.local/safe.md', 'safe source\n');
  const before = snapshot(options.dataDir);
  const plan = applyPersonaLayers(options);
  assert.ok(
    plan.conflicts.some((issue) => issue.code === code),
    JSON.stringify(plan.conflicts)
  );
  assert.deepEqual(snapshot(options.dataDir), before, 'preflight conflicts leave every destination unchanged');
  assert.equal(fs.existsSync(path.join(options.dataDir, 'prompts/safe.md')), false);
  assert.equal(fs.readFileSync(path.join(options.privateDir, 'prompts.local/safe.md'), 'utf8'), 'safe source\n');
}

const COPIES = [
  [
    'config.local/config.json',
    'config/config.json',
    '{ "interfaces": {"sample": {"enabled": true}}, "agents": {"probe": {"steps": 7}} }\n',
  ],
  ['config.local.json', 'config/config.json', '{ "pace": {"settleMs": 900} }\n'],
  ['config.local/labels.json', 'config/labels.json', '{ "owner": {"status": {"title": "custom"}} }\n'],
  ['config.local/tools.json', 'config/tools.json', '{ "sample.tool": {"title": "sample"} }\n'],
  ['prompts.local/rules.md', 'prompts/rules.md', 'Rules\r\n  exact spaces  \n'],
  ['prompts.local/empty.md', 'prompts/empty.md', ''],
  ['prompts.local/preambles/wake.md', 'prompts/preambles/wake.md', 'Wake\n'],
  ['prompts.local/preambles/empty.md', 'prompts/preambles/empty.md', ''],
] as const;

for (const [source, target, bytes] of COPIES) {
  test(`copies ${source} exactly while preserving its source and mode`, () => {
    // Catches lost personal settings, trimmed prompts or destructive moves instead of preparatory copies.
    const options = fixture();
    write(options.privateDir, source, bytes);
    const before = snapshot(options.privateDir);
    const plan = applyPersonaLayers(options);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.steps, [{ source, target, kind: 'copy' }]);
    assert.equal(fs.readFileSync(path.join(options.dataDir, target), 'utf8'), bytes);
    assert.deepEqual(snapshot(options.privateDir), before);
    assert.equal(fs.statSync(path.join(options.dataDir, target)).mode & 0o777, 0o600);
    for (let dir = path.dirname(target); dir !== '.'; dir = path.dirname(dir)) {
      assert.equal(fs.statSync(path.join(options.dataDir, dir)).mode & 0o777, 0o700);
    }
  });
}

test('planning is read-only and orders source paths without exposing contents', () => {
  // Catches a dry run creating destinations or returning personalized values in the report.
  const options = fixture();
  write(options.privateDir, 'prompts.local/z.md', 'PRIVATE_SENTINEL');
  write(options.privateDir, 'prompts.local/a.md', 'PRIVATE_SENTINEL');
  const before = snapshot(options.privateDir);
  const plan = planPersonaLayers(options);
  assert.deepEqual(plan.steps, [
    { source: 'prompts.local/a.md', target: 'prompts/a.md', kind: 'copy' },
    { source: 'prompts.local/z.md', target: 'prompts/z.md', kind: 'copy' },
  ]);
  assert.equal(JSON.stringify(plan).includes('PRIVATE_SENTINEL'), false);
  assert.deepEqual(snapshot(options.dataDir), {});
  assert.deepEqual(snapshot(options.privateDir), before);
});

test('an empty source produces an empty plan and creates nothing', () => {
  // Catches eager creation of a canonical layer when no personal files exist.
  const options = fixture();
  assert.deepEqual(applyPersonaLayers(options), { steps: [], unchanged: [], held: [], conflicts: [] });
  assert.deepEqual(snapshot(options.dataDir), {});
});

for (const source of ['config.local/config.json', 'config.local.json']) {
  test(`preserves a blank settings override at ${source}`, () => {
    // Catches rejecting the loader's accepted blank override or silently replacing its bytes.
    const options = fixture();
    write(options.privateDir, source, ' \n\t');
    assert.deepEqual(applyPersonaLayers(options).conflicts, []);
    assert.equal(fs.readFileSync(path.join(options.dataDir, 'config/config.json'), 'utf8'), ' \n\t');
    assert.equal(fs.readFileSync(path.join(options.privateDir, source), 'utf8'), ' \n\t');
  });
}

test('splits labels by tracked leaf ownership and preserves unknown values', () => {
  // Catches ownership guessed from names, or dropped arrays, nulls and empty objects.
  const options = fixture();
  const flat = { status: { title: 'mine', extra: null }, custom: ['a', 'b'], empty: {}, owner: 'ordinary model leaf' };
  const bytes = JSON.stringify(flat);
  write(options.privateDir, 'prompts.local/labels.json', bytes);
  const before = snapshot(options.privateDir);
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.steps, [
    { source: 'prompts.local/labels.json', target: 'config/labels.json', kind: 'split-labels' },
  ]);
  const expected = {
    model: { status: { extra: null }, custom: ['a', 'b'], empty: {}, owner: 'ordinary model leaf' },
    owner: { status: { title: 'mine' } },
  };
  assert.equal(
    fs.readFileSync(path.join(options.dataDir, 'config/labels.json'), 'utf8'),
    `${JSON.stringify(expected, null, 2)}\n`
  );
  assert.deepEqual(snapshot(options.privateDir), before);
});

test('converts an empty flat label override into empty sections', () => {
  // Catches a blank legacy labels file failing migration despite representing no override.
  const options = fixture();
  write(options.privateDir, 'prompts.local/labels.json', '');
  assert.deepEqual(applyPersonaLayers(options).conflicts, []);
  assert.equal(
    fs.readFileSync(path.join(options.dataDir, 'config/labels.json'), 'utf8'),
    '{\n  "model": {},\n  "owner": {}\n}\n'
  );
  assert.equal(fs.readFileSync(path.join(options.privateDir, 'prompts.local/labels.json'), 'utf8'), '');
});

test('accepts structurally equal settings alternatives and preserves the destination formatting and mode', () => {
  // Catches false conflicts on whitespace, or overwriting an already equivalent destination.
  const options = fixture();
  write(options.privateDir, 'config.local/config.json', '{"a":1,"b":[2,3]}');
  write(options.privateDir, 'config.local.json', '{ "b": [2,3], "a": 1 }\n');
  write(options.dataDir, 'config/config.json', '{\n"b":[2,3], "a":1\n}\n', 0o644);
  const before = snapshot(options.dataDir);
  const sources = snapshot(options.privateDir);
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.unchanged, ['config/config.json']);
  assert.deepEqual(snapshot(options.dataDir), before);
  assert.deepEqual(snapshot(options.privateDir), sources);
});

test('accepts flat and split labels that agree after ownership classification', () => {
  // Catches comparing raw legacy and split shapes as though they were different overrides.
  const options = fixture();
  write(options.privateDir, 'prompts.local/labels.json', '{"status":{"title":"mine"},"custom":3}');
  write(options.privateDir, 'config.local/labels.json', '{"owner":{"status":{"title":"mine"}},"model":{"custom":3}}');
  const before = snapshot(options.privateDir);
  assert.deepEqual(applyPersonaLayers(options).conflicts, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.dataDir, 'config/labels.json'), 'utf8')), {
    owner: { status: { title: 'mine' } },
    model: { custom: 3 },
  });
  assert.deepEqual(snapshot(options.privateDir), before);
});

test('a repeat application leaves matching prompt bytes and modes intact', () => {
  // Catches a rerun rewriting matching files or retaining executable work in its plan.
  const options = fixture();
  write(options.privateDir, 'prompts.local/rules.md', 'keep\n');
  assert.deepEqual(applyPersonaLayers(options).conflicts, []);
  fs.chmodSync(path.join(options.dataDir, 'prompts/rules.md'), 0o640);
  const before = snapshot(options.dataDir);
  const again = applyPersonaLayers(options);
  assert.deepEqual(again.steps, []);
  assert.deepEqual(again.unchanged, ['prompts/rules.md']);
  assert.deepEqual(snapshot(options.dataDir), before);
});

const INVALID = [
  ['config.local/config.json', '{"PRIVATE_SENTINEL":', 'invalid-json'],
  ['config.local.json', 'null', 'invalid-shape'],
  ['config.local/tools.json', '[]', 'invalid-shape'],
  ['prompts.local/labels.json', '"PRIVATE_SENTINEL"', 'invalid-shape'],
  ['config.local/labels.json', '{"model":[]}', 'invalid-shape'],
  ['config.local/labels.json', '{"owner":null}', 'invalid-shape'],
  ['config.local/labels.json', '{"model":{"x":1},"owner":{"x":2}}', 'invalid-shape'],
] as const;

for (const [source, bytes, code] of INVALID) {
  test(`refuses ${source} with ${bytes} before copying other files`, () => {
    // Catches accepting malformed or overlapping overrides and applying only the valid portion of a run.
    const options = fixture();
    write(options.privateDir, source, bytes);
    assertRefuses(options, code);
    assert.equal(fs.readFileSync(path.join(options.privateDir, source), 'utf8'), bytes);
    assert.equal(JSON.stringify(planPersonaLayers(options)).includes('PRIVATE_SENTINEL'), false);
  });
}

for (const other of ['{"a":"1","b":[2,3]}', '{"a":1,"b":[3,2]}']) {
  test(`refuses alternate settings with different scalar types or array order: ${other}`, () => {
    // Catches lossy JSON equality that coerces scalar types or treats arrays as unordered.
    const options = fixture();
    write(options.privateDir, 'config.local/config.json', '{"a":1,"b":[2,3]}');
    write(options.privateDir, 'config.local.json', other);
    assertRefuses(options, 'different-content');
  });
}

test('refuses flat labels that disagree with a split override before writing any prompt', () => {
  // Catches legacy label precedence silently choosing one of two personalized values.
  const options = fixture();
  write(options.privateDir, 'prompts.local/labels.json', '{"status":{"title":"one"}}');
  write(options.privateDir, 'config.local/labels.json', '{"owner":{"status":{"title":"two"}}}');
  assertRefuses(options, 'different-content');
});

for (const [source, target, before, after] of [
  ['config.local/config.json', 'config/config.json', '{"x":1}', '{"x":2}'],
  ['prompts.local/rules.md', 'prompts/rules.md', 'same\n', 'same\r\n'],
] as const) {
  test(`refuses a different existing ${target} without writing other files`, () => {
    // Catches overwriting a canonical destination or normalizing prompt bytes during equality checks.
    const options = fixture();
    write(options.privateDir, source, before);
    write(options.dataDir, target, after);
    assertRefuses(options, 'different-content');
    assert.ok(planPersonaLayers(options).conflicts.some((issue) => issue.path === target));
  });
}

test('refuses a directory occupying a destination file', () => {
  // Catches treating a non-file destination as missing and trying to replace it.
  const options = fixture();
  write(options.privateDir, 'config.local/config.json', '{}');
  fs.mkdirSync(path.join(options.dataDir, 'config/config.json'), { recursive: true });
  write(options.privateDir, 'prompts.local/safe.md', 'safe source\n');
  const before = snapshot(options.dataDir);
  assert.ok(applyPersonaLayers(options).conflicts.some((issue) => issue.path === 'config/config.json'));
  assert.deepEqual(snapshot(options.dataDir), before);
  assert.equal(fs.existsSync(path.join(options.dataDir, 'prompts/safe.md')), false);
});

for (const side of ['source', 'destination'] as const) {
  for (const entry of ['component', 'file'] as const) {
    test(`refuses a ${side} ${entry} symlink before copying any files`, () => {
      // Catches copying from another installation or writing outside the persona root through a link.
      const options = fixture();
      const outside = tempDir('nep-persona-outside-');
      write(outside, 'rules.md', 'outside\n');
      const root = side === 'source' ? options.privateDir : options.dataDir;
      const folder = side === 'source' ? 'prompts.local' : 'prompts';
      if (entry === 'component') fs.symlinkSync(outside, path.join(root, folder));
      else {
        fs.mkdirSync(path.join(root, folder));
        fs.symlinkSync(path.join(outside, 'rules.md'), path.join(root, folder, 'rules.md'));
      }
      if (side === 'destination') write(options.privateDir, 'prompts.local/rules.md', 'source\n');
      write(options.privateDir, 'prompts.local/safe.md', 'safe source\n');
      const before = snapshot(outside);
      assertRefuses(options, 'unsafe-path');
      assert.deepEqual(snapshot(outside), before);
    });
  }
}

test('copies into the engine data directory when the private source is separate', () => {
  // Catches rejecting the portable engine/data layout merely because the destination is inside the engine root.
  const options = fixture();
  options.dataDir = path.join(options.rootDir, 'data');
  write(options.privateDir, 'prompts.local/rules.md', 'portable rules\n');
  const sources = snapshot(options.privateDir);
  const defaults = snapshot(path.join(options.rootDir, 'config'));
  const agents = snapshot(path.join(options.rootDir, 'agents'));
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.steps, [{ source: 'prompts.local/rules.md', target: 'prompts/rules.md', kind: 'copy' }]);
  assert.equal(fs.readFileSync(path.join(options.dataDir, 'prompts/rules.md'), 'utf8'), 'portable rules\n');
  assert.deepEqual(snapshot(options.privateDir), sources);
  assert.deepEqual(snapshot(path.join(options.rootDir, 'config')), defaults);
  assert.deepEqual(snapshot(path.join(options.rootDir, 'agents')), agents);
});

for (const overlap of ['same', 'inside-source', 'inside-destination'] as const) {
  test(`refuses overlapping roots when the target is ${overlap}`, () => {
    // Catches re-reading generated output as migration input or mutating the source tree.
    const options = fixture();
    if (overlap === 'same') options.dataDir = options.privateDir;
    else if (overlap === 'inside-source') options.dataDir = path.join(options.privateDir, 'persona');
    else options.privateDir = path.join(options.dataDir, 'private');
    fs.mkdirSync(options.dataDir, { recursive: true });
    fs.mkdirSync(options.privateDir, { recursive: true });
    assertRefuses(options, 'unsafe-path');
  });
}

for (const key of ['privateDir', 'dataDir'] as const) {
  test(`refuses a symlink used as the ${key} root`, () => {
    // Catches checking child entries while following a linked root into another installation.
    const options = fixture();
    const actual = `${options[key]}-actual`;
    fs.renameSync(options[key], actual);
    fs.symlinkSync(actual, options[key]);
    assertRefuses(options, 'unsafe-path');
  });
}

test('holds agent contracts, interface contracts and unknown entries without reading unknown contents', () => {
  // Catches agent overrides copied as ordinary prompts or arbitrary private files silently migrated.
  const options = fixture();
  declareAgent(options.rootDir, 'custom-worker.md');
  write(options.privateDir, 'prompts.local/agent-probe.md', 'agent');
  write(options.privateDir, 'prompts.local/custom-worker.md', 'custom agent');
  write(options.privateDir, 'config.local/interfaces/sample.json', '{}');
  write(options.privateDir, 'prompts.local/unknown.bin', 'unknown');
  fs.chmodSync(path.join(options.privateDir, 'prompts.local/unknown.bin'), 0o000);
  try {
    const plan = applyPersonaLayers(options);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.held, [
      { path: 'config.local/interfaces', reason: 'interface-contract' },
      { path: 'prompts.local/agent-probe.md', reason: 'agent-contract' },
      { path: 'prompts.local/custom-worker.md', reason: 'agent-contract' },
      { path: 'prompts.local/unknown.bin', reason: 'unclassified' },
    ]);
    assert.deepEqual(snapshot(options.dataDir), {});
  } finally {
    fs.chmodSync(path.join(options.privateDir, 'prompts.local/unknown.bin'), 0o640);
  }
});

test('copies an ordinary prompt when a development profile declares no override', () => {
  // Catches rejecting a valid null override and blocking migration for shared development profiles.
  const options = fixture();
  write(
    options.rootDir,
    'agents/build/profile.json',
    JSON.stringify({
      id: 'build',
      kind: 'development',
      role: 'dev',
      prompt: 'prompt.md',
      override: null,
      tools: ['bash', 'read', 'edit'],
      permission: { bash: { '*': 'allow', '*node --test*': 'deny' }, edit: 'allow' },
      effort: 'medium',
      limits: { steps: 50, minutes: 30 },
      cost: { input: 2, output: 10 },
      description: 'A test development agent.',
    })
  );
  write(options.privateDir, 'prompts.local/rules.md', 'ordinary prompt\n');
  const before = snapshot(options.privateDir);
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.held, []);
  assert.deepEqual(plan.steps, [{ source: 'prompts.local/rules.md', target: 'prompts/rules.md', kind: 'copy' }]);
  assert.equal(fs.readFileSync(path.join(options.dataDir, 'prompts/rules.md'), 'utf8'), 'ordinary prompt\n');
  assert.deepEqual(fs.readdirSync(path.join(options.dataDir, 'prompts')), ['rules.md']);
  assert.deepEqual(snapshot(options.privateDir), before);
});

for (const override of ['../escape.md', '/absolute.md']) {
  test(`refuses an unsafe declared agent override ${override} before writing`, () => {
    // Catches a profile-selected override traversing outside prompts.local during classification.
    const options = fixture();
    declareAgent(options.rootDir, override);
    assertRefuses(options, 'unsafe-path');
  });
}

test('refuses a retired skills file instead of silently migrating tool keys', () => {
  // Catches hiding the loader's explicit retired-tool migration requirement.
  const options = fixture();
  write(options.privateDir, 'prompts.local/skills.json', '{}');
  assertRefuses(options, 'legacy-tools');
});

test('reports an unreadable supported input without copying another file', () => {
  // Catches a permission-denied input being treated as absent and losing a personal override.
  const options = fixture();
  write(options.privateDir, 'config.local/config.json', '{}');
  const file = path.join(options.privateDir, 'config.local/config.json');
  fs.chmodSync(file, 0o000);
  try {
    assertRefuses(options, 'unreadable');
  } finally {
    fs.chmodSync(file, 0o640);
  }
});

test('a rerun finishes after an application write failure and preserves already matching files', () => {
  // Catches partial writes, content in error messages or recovery that overwrites completed destinations.
  const options = fixture();
  write(options.privateDir, 'config.local/config.json', '{"value":"PRIVATE_SENTINEL"}');
  write(options.privateDir, 'prompts.local/rules.md', 'PRIVATE_SENTINEL');
  fs.mkdirSync(path.join(options.dataDir, 'prompts'));
  fs.chmodSync(path.join(options.dataDir, 'prompts'), 0o500);
  const before = snapshot(options.privateDir);
  try {
    assert.deepEqual(planPersonaLayers(options).conflicts, []);
    assert.throws(
      () => applyPersonaLayers(options),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('PRIVATE_SENTINEL'), false);
        assert.match(error.message, /prompts/);
        assert.match(error.message, /write|open|rename|EACCES|install/i);
        return true;
      }
    );
  } finally {
    fs.chmodSync(path.join(options.dataDir, 'prompts'), 0o700);
  }
  const completed = path.join(options.dataDir, 'config/config.json');
  assert.equal(fs.readFileSync(completed, 'utf8'), '{"value":"PRIVATE_SENTINEL"}');
  fs.chmodSync(completed, 0o640);
  assert.deepEqual(applyPersonaLayers(options).conflicts, []);
  assert.equal(fs.statSync(completed).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(path.join(options.dataDir, 'prompts/rules.md'), 'utf8'), 'PRIVATE_SENTINEL');
  assert.deepEqual(fs.readdirSync(path.join(options.dataDir, 'prompts')), ['rules.md']);
  assert.deepEqual(snapshot(options.privateDir), before);
});

test('preserves a competing destination created after staging and removes the staged file', (t) => {
  // Catches a late collision overwriting another writer's file or leaving staged output after refusal.
  const options = fixture();
  write(options.privateDir, 'prompts.local/rules.md', 'migration source\n');
  const sources = snapshot(options.privateDir);
  const target = path.join(options.dataDir, 'prompts/rules.md');
  const competing = 'competing destination\n';
  const writeFile = fs.writeFileSync;
  let hasInjected = false;
  const intercepted = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    writeFile(...args);
    if (typeof args[0] === 'number' && !hasInjected) {
      hasInjected = true;
      writeFile(target, competing, { mode: 0o644 });
      fs.chmodSync(target, 0o644);
    }
  });
  try {
    assert.throws(() => applyPersonaLayers(options));
  } finally {
    intercepted.mock.restore();
  }
  assert.equal(hasInjected, true, 'the collision occurs after the staged descriptor receives its bytes');
  assert.equal(fs.readFileSync(target, 'utf8'), competing);
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  assert.deepEqual(snapshot(options.privateDir), sources);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['rules.md']);
});
