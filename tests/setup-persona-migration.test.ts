// Offline persona-layer migration through its public planner and applier, using synthetic roots only.
// These regressions cover source preservation, conflicting destinations and safe recovery after an interrupted copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyPersonaLayers, planPersonaLayers } from '../src/setup/persona-migration.ts';
import type { PersonaLayerOptions, PersonaLayerIssue } from '../src/setup/persona-migration.ts';
import { tempDir } from './fixtures/tmp.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { readInterfaceConfig } from '../src/config/files.ts';
import { main as movePersonaFiles } from '../scripts/persona-files-move.ts';
import { listAgents } from '../src/agent-runner/profiles.ts';

function write(root: string, relative: string, bytes: string | Uint8Array, mode = 0o640): void {
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

function declareAgent(rootDir: string, override: string, prompt = 'prompt.md'): void {
  write(
    rootDir,
    'agents/probe/profile.json',
    JSON.stringify({
      id: 'probe',
      kind: 'worker',
      role: 'server',
      prompt,
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

test('holds undeclared agent contracts and unknown entries while extracting interface settings', () => {
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
    // A validated declared override belongs to canonical agents, while undeclared aliases remain held.
    assert.equal(fs.readFileSync(path.join(options.dataDir, 'agents/probe/prompt.md'), 'utf8'), 'custom agent');
    assert.equal(fs.existsSync(path.join(options.dataDir, 'prompts/custom-worker.md')), false);
    assert.equal(fs.existsSync(path.join(options.dataDir, 'agents/probe/agent-probe.md')), false);
    // Dedicated interface configuration belongs to the persona's interface package.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(options.dataDir, 'interfaces/sample/config.json'), 'utf8')),
      {}
    );
    assert.deepEqual(plan.held, [
      { path: 'prompts.local/agent-probe.md', reason: 'agent-contract' },
      { path: 'prompts.local/unknown.bin', reason: 'unclassified' },
    ]);
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

test('prepares a declared custom agent prompt without changing its source or canonical profile', () => {
  // Catches renamed or trimmed prompts, settings synthesized into profiles and destructive source moves.
  const options = fixture();
  declareAgent(options.rootDir, 'custom-worker.md', 'instructions.md');
  assert.doesNotThrow(() => listAgents({ rootDir: options.rootDir }));
  const bytes = '\uFEFFWorker\r\n  exact spaces  \n';
  write(options.privateDir, 'prompts.local/custom-worker.md', bytes);
  write(options.privateDir, 'config.local/config.json', '{"agents":{"probe":{"steps":17}}}');
  write(options.dataDir, 'agents/probe/profile.json', '{"description":"Personal description"}');
  const source = snapshot(options.privateDir);
  const target = snapshot(options.dataDir);
  const planned = planPersonaLayers(options);
  assert.deepEqual(planned.conflicts, []);
  assert.ok(planned.steps.some((step) => step.target === 'agents/probe/instructions.md'));
  assert.deepEqual(snapshot(options.dataDir), target, 'planning writes nothing');
  assert.deepEqual(snapshot(options.privateDir), source);
  const applied = applyPersonaLayers(options);
  assert.deepEqual(applied.conflicts, []);
  const file = path.join(options.dataDir, 'agents/probe/instructions.md');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(path.join(options.dataDir, 'agents/probe/profile.json'), 'utf8'),
    '{"description":"Personal description"}'
  );
  assert.equal(
    fs.readFileSync(path.join(options.dataDir, 'config/config.json'), 'utf8'),
    '{"agents":{"probe":{"steps":17}}}'
  );
  assert.deepEqual(snapshot(options.privateDir), source);
  const after = snapshot(options.dataDir);
  const repeated = applyPersonaLayers(options);
  assert.deepEqual(repeated.conflicts, []);
  assert.deepEqual(repeated.steps, []);
  assert.ok(repeated.unchanged.includes('agents/probe/instructions.md'));
  assert.deepEqual(snapshot(options.dataDir), after);
});

test('creates private agent directories and preserves an empty declared prompt', () => {
  // Catches falling back to a shared prompt when an existing personal file is intentionally empty.
  const options = fixture();
  declareAgent(options.rootDir, 'agent-probe.md');
  write(options.privateDir, 'prompts.local/agent-probe.md', '');
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(fs.readFileSync(path.join(options.dataDir, 'agents/probe/prompt.md'), 'utf8'), '');
  for (const folder of ['agents', 'agents/probe']) {
    assert.equal(fs.statSync(path.join(options.dataDir, folder)).mode & 0o777, 0o700);
  }
});

test('leaves a missing declared override absent instead of copying the shared default', () => {
  // Catches converting shared defaults into permanent personal overrides.
  const options = fixture();
  declareAgent(options.rootDir, 'agent-probe.md');
  write(options.rootDir, 'agents/probe/prompt.md', 'shared instructions');
  assert.deepEqual(applyPersonaLayers(options), { steps: [], unchanged: [], held: [], conflicts: [] });
  assert.deepEqual(snapshot(options.dataDir), {});
});

test('holds an unclassified development prompt with a null override', () => {
  // Catches activating an agent-named file that the development profile never selected.
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
      tools: ['read'],
      permission: { read: 'allow' },
      effort: 'medium',
      limits: { steps: 50, minutes: 30 },
      cost: { input: 2, output: 10 },
      description: 'A builder.',
    })
  );
  assert.doesNotThrow(() => listAgents({ rootDir: options.rootDir }));
  write(options.privateDir, 'prompts.local/agent-build.md', 'unclassified development instructions');
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.held, [{ path: 'prompts.local/agent-build.md', reason: 'agent-contract' }]);
  assert.deepEqual(snapshot(options.dataDir), {});
});

for (const field of ['id', 'prompt', 'override', 'tools'] as const) {
  test(`refuses invalid shared agent ${field} before copying any files`, () => {
    // Catches authorizing a destination from an invalid shared definition.
    const options = fixture();
    declareAgent(options.rootDir, 'custom-worker.md');
    const file = path.join(options.rootDir, 'agents/probe/profile.json');
    const profile = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    profile[field] = field === 'id' ? 'other' : field === 'prompt' ? 'instructions.txt' : null;
    fs.writeFileSync(file, JSON.stringify(profile));
    write(options.privateDir, 'prompts.local/custom-worker.md', 'custom');
    assertRefuses(options, 'invalid-shape');
  });
}

test('refuses a conflicting canonical agent prompt before copying ordinary prompts', () => {
  // Catches partial migration and overwriting an independently supplied personal prompt.
  const options = fixture();
  declareAgent(options.rootDir, 'agent-probe.md');
  write(options.privateDir, 'prompts.local/agent-probe.md', 'legacy');
  write(options.dataDir, 'agents/probe/prompt.md', 'canonical');
  const source = snapshot(options.privateDir);
  assertRefuses(options, 'different-content');
  assert.equal(
    fs.readFileSync(path.join(options.privateDir, 'prompts.local/agent-probe.md'), 'utf8'),
    source['prompts.local/agent-probe.md'].content
  );
});

for (const selected of ['default', 'tracked', 'private', 'old-private', 'external', 'parent-relative', 'blank']) {
  test(`copies the ${selected} watcher prompt from its resolved engine location`, () => {
    // Catches choosing watcher paths relative to private or data roots and ignoring effective configuration.
    const options = fixture();
    const external = path.join(path.dirname(options.rootDir), 'external-watcher');
    const tracked = selected === 'tracked' ? 'tracked-watch' : '.agents/watcher';
    write(options.rootDir, 'config/config.json', JSON.stringify({ watcher: { dir: tracked } }));
    const relative =
      selected === 'private' || selected === 'old-private'
        ? 'personal-watch'
        : selected === 'external'
          ? external
          : selected === 'parent-relative'
            ? '../external-watcher'
            : selected === 'blank'
              ? '   '
              : tracked;
    if (['private', 'old-private', 'external', 'parent-relative', 'blank'].includes(selected)) {
      write(
        options.privateDir,
        selected === 'old-private' ? 'config.local.json' : 'config.local/config.json',
        JSON.stringify({ watcher: { dir: relative } })
      );
    }
    const sourceDir = path.resolve(options.rootDir, relative.trim() || '.agents/watcher');
    const bytes = 'Watcher\r\n  preserve whitespace  \n';
    write(sourceDir, 'prompt.md', bytes);
    write(sourceDir, 'reports/2026-01-01.md', 'report stays outside agents');
    if (!path.isAbsolute(relative) && !relative.startsWith('..')) {
      write(options.privateDir, path.join(relative.trim() || '.agents/watcher', 'prompt.md'), 'private decoy');
      write(options.dataDir, path.join(relative.trim() || '.agents/watcher', 'prompt.md'), 'data decoy');
    }
    const source = snapshot(sourceDir);
    const before = snapshot(options.dataDir);
    const plan = planPersonaLayers(options);
    assert.deepEqual(plan.conflicts, []);
    assert.ok(plan.steps.some((step) => step.target === 'agents/watcher/prompt.md'));
    assert.deepEqual(snapshot(options.dataDir), before);
    assert.deepEqual(applyPersonaLayers(options).conflicts, []);
    const target = path.join(options.dataDir, 'agents/watcher/prompt.md');
    assert.equal(fs.readFileSync(target, 'utf8'), bytes);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(options.dataDir, 'agents/watcher/reports')), false);
    assert.deepEqual(snapshot(sourceDir), source);
    assert.ok(applyPersonaLayers(options).unchanged.includes('agents/watcher/prompt.md'));
  });
}

test('refuses a conflicting watcher prompt before copying any files', () => {
  // Catches silently replacing an existing watcher personality during preparatory migration.
  const options = fixture();
  write(options.rootDir, '.agents/watcher/prompt.md', 'legacy watcher');
  write(options.dataDir, 'agents/watcher/prompt.md', 'canonical watcher');
  assertRefuses(options, 'different-content');
});

test('refuses conflicting watcher configuration alternatives before copying either prompt', () => {
  // Catches choosing one legacy configuration arbitrarily and producing a partial persona.
  const options = fixture();
  write(options.privateDir, 'config.local.json', '{"watcher":{"dir":"first"}}');
  write(options.privateDir, 'config.local/config.json', '{"watcher":{"dir":"second"}}');
  write(options.rootDir, 'first/prompt.md', 'first watcher');
  write(options.rootDir, 'second/prompt.md', 'second watcher');
  assertRefuses(options, 'different-content');
});

for (const side of ['source-file', 'source-directory', 'source-ancestor', 'target-directory']) {
  test(`refuses a watcher ${side} symlink before copying any files`, () => {
    // Catches a portable persona depending on a file outside its declared path through a symlink.
    const options = fixture();
    const external = path.join(path.dirname(options.rootDir), 'watcher-external');
    write(external, 'prompt.md', 'external prompt');
    if (side === 'source-directory') {
      fs.mkdirSync(path.join(options.rootDir, '.agents'));
      fs.symlinkSync(external, path.join(options.rootDir, '.agents/watcher'));
    } else if (side === 'source-file') {
      fs.mkdirSync(path.join(options.rootDir, '.agents/watcher'), { recursive: true });
      fs.symlinkSync(path.join(external, 'prompt.md'), path.join(options.rootDir, '.agents/watcher/prompt.md'));
    } else if (side === 'source-ancestor') {
      const alias = path.join(path.dirname(options.rootDir), 'watcher-alias');
      fs.symlinkSync(external, alias);
      write(external, 'nested/prompt.md', 'nested prompt');
      write(options.privateDir, 'config.local/config.json', JSON.stringify({ watcher: { dir: `${alias}/nested` } }));
    } else {
      write(options.rootDir, '.agents/watcher/prompt.md', 'watcher');
      fs.mkdirSync(path.join(options.dataDir, 'agents'));
      fs.symlinkSync(external, path.join(options.dataDir, 'agents/watcher'));
    }
    const before = snapshot(external);
    assertRefuses(options, 'unsafe-path');
    assert.deepEqual(snapshot(external), before);
  });
}

for (const entry of ['shared-profile', 'shared-directory', 'target-directory']) {
  test(`refuses an agent ${entry} symlink before copying any files`, () => {
    // Catches trusting profile metadata or installing prompts through a linked agent directory.
    const options = fixture();
    declareAgent(options.rootDir, 'agent-probe.md');
    write(options.privateDir, 'prompts.local/agent-probe.md', 'personal prompt');
    const external = path.join(path.dirname(options.rootDir), 'external-agent');
    fs.mkdirSync(external);
    const shared = path.join(options.rootDir, 'agents/probe');
    if (entry === 'shared-profile') {
      fs.renameSync(path.join(shared, 'profile.json'), path.join(external, 'profile.json'));
      fs.symlinkSync(path.join(external, 'profile.json'), path.join(shared, 'profile.json'));
    } else if (entry === 'shared-directory') {
      fs.rmdirSync(external);
      fs.renameSync(shared, external);
      fs.symlinkSync(external, shared);
    } else {
      fs.mkdirSync(path.join(options.dataDir, 'agents'));
      fs.symlinkSync(external, path.join(options.dataDir, 'agents/probe'));
    }
    const before = snapshot(external);
    assertRefuses(options, 'unsafe-path');
    assert.deepEqual(snapshot(external), before);
  });
}

for (const layout of ['absent', 'readme'] as const) {
  test(`copies ordinary settings when the agents directory is ${layout}`, () => {
    const options = fixture();
    if (layout === 'absent') fs.rmdirSync(path.join(options.rootDir, 'agents'));
    else write(options.rootDir, 'agents/README.md', 'Shared agent documentation.');
    const settings = '{"watcher":{"enabled":false}}\n';
    write(options.privateDir, 'config.local/config.json', settings);
    const plan = applyPersonaLayers(options);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(Object.keys(snapshot(options.dataDir)), ['config', 'config/config.json']);
    assert.equal(fs.readFileSync(path.join(options.dataDir, 'config/config.json'), 'utf8'), settings);
  });
}

test('copies ordinary settings when the tracked settings file is blank', () => {
  const options = fixture();
  write(options.rootDir, 'config/config.json', ' \n');
  const settings = '{"watcher":{"enabled":false}}\n';
  write(options.privateDir, 'config.local/config.json', settings);
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(fs.readFileSync(path.join(options.dataDir, 'config/config.json'), 'utf8'), settings);
});

test('holds an agent override outside the selected prompts directory', () => {
  const options = fixture();
  declareAgent(options.rootDir, 'agent-probe.md');
  write(options.privateDir, 'agent-probe.md', 'unselected instructions');
  write(options.privateDir, 'config.local/agent-probe.md', 'unselected instructions');
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(snapshot(options.dataDir), {});
  assert.deepEqual(
    plan.held.map((entry) => entry.path),
    ['agent-probe.md', 'config.local/agent-probe.md']
  );
});

test('holds an override for a consultation with no prompt while copying ordinary settings', () => {
  const options = fixture();
  write(
    options.rootDir,
    'agents/advice/profile.json',
    JSON.stringify({
      id: 'advice',
      kind: 'consultation',
      role: 'thinker',
      prompt: null,
      override: 'agent-advice.md',
      description: 'A synthetic consultation.',
    })
  );
  assert.doesNotThrow(() => listAgents({ rootDir: options.rootDir }));
  write(options.privateDir, 'prompts.local/agent-advice.md', 'unselected consultation instructions');
  const settings = '{"watcher":{"enabled":false}}\n';
  write(options.privateDir, 'config.local/config.json', settings);
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(
    plan.held.map((entry) => entry.path),
    ['prompts.local/agent-advice.md']
  );
  assert.deepEqual(Object.keys(snapshot(options.dataDir)), ['config', 'config/config.json']);
  assert.equal(fs.readFileSync(path.join(options.dataDir, 'config/config.json'), 'utf8'), settings);
});

test('writes only the declared destination when copying an agent override', () => {
  const options = fixture();
  declareAgent(options.rootDir, 'agent-probe.md', 'instructions.md');
  write(options.privateDir, 'prompts.local/agent-probe.md', 'selected instructions\n');
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(Object.keys(snapshot(options.dataDir)), ['agents', 'agents/probe', 'agents/probe/instructions.md']);
  assert.equal(
    fs.readFileSync(path.join(options.dataDir, 'agents/probe/instructions.md'), 'utf8'),
    'selected instructions\n'
  );
});

test('agent prompt migration uses shared declarations despite unrelated process persona edits', () => {
  const options = fixture();
  declareAgent(options.rootDir, 'agent-probe.md');
  const bytes = 'synthetic legacy worker instructions\n';
  write(options.privateDir, 'prompts.local/agent-probe.md', bytes);
  const unrelated = path.join(path.dirname(options.rootDir), 'unrelated-process-persona');
  write(unrelated, 'agents/probe/profile.json', '{"prompt":"unrelated.md"}');
  const before = process.env.NEPTUNIA_DATA_DIR;
  process.env.NEPTUNIA_DATA_DIR = unrelated;
  try {
    const plan = planPersonaLayers(options);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.steps, [
      { source: 'prompts.local/agent-probe.md', target: 'agents/probe/prompt.md', kind: 'copy' },
    ]);
    assert.deepEqual(snapshot(options.dataDir), {});
    write(unrelated, 'agents/probe/profile.json', '{"limits":{"seconds":0}}');
    const applied = applyPersonaLayers(options);
    assert.deepEqual(applied.conflicts, []);
    assert.equal(fs.readFileSync(path.join(options.dataDir, 'agents/probe/prompt.md'), 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(options.dataDir, 'agents/probe/unrelated.md')), false);
    assert.equal(fs.readFileSync(path.join(options.privateDir, 'prompts.local/agent-probe.md'), 'utf8'), bytes);
  } finally {
    if (before === undefined) delete process.env.NEPTUNIA_DATA_DIR;
    else process.env.NEPTUNIA_DATA_DIR = before;
  }
});

// Reinstallation must retain personal packages, client identities and persona-owned login bytes.
test('personal packages and credentials remain intact after the source root becomes unavailable', () => {
  const options = fixture();
  declareAgent(options.privateDir, 'prompt.md');
  const agentProfile = fs.readFileSync(path.join(options.privateDir, 'agents/probe/profile.json'), 'utf8');
  const keys = JSON.stringify({
    core: [{ name: 'core-1', value: 'synthetic-stored-key' }],
    extra: {},
    roles: {},
    services: { exa: 'synthetic-exa' },
    subharness: { backends: ['codex'] },
    simulation: { key: 'sim' },
  });
  const files: Array<[string, string, string | Uint8Array]> = [
    ['keys.json', 'keys.json', keys],
    [
      'clients.json',
      'clients.json',
      '{"shell":{"kind":"cli","tokenFile":"clients/shell.token","boardRoles":["owner"]}}',
    ],
    ['clients/shell.token', 'clients/shell.token', 'synthetic-client-token\n'],
    ['skills.local/probe/SKILL.md', 'skills/probe/SKILL.md', 'Synthetic skill instructions\n'],
    ['skills.local/probe/run.sh', 'skills/probe/run.sh', '#!/bin/sh\nexit 0\n'],
    ['skills.local/probe/data.bin', 'skills/probe/data.bin', Uint8Array.of(0, 255, 128, 10)],
    ['agents/probe/profile.json', 'agents/probe/profile.json', agentProfile],
    ['agents/probe/prompt.md', 'agents/probe/prompt.md', 'Personal worker instructions\n'],
    ['interfaces/sample/index.ts', 'interfaces/sample/index.ts', 'export const sample = true;\n'],
    ['interfaces/sample/resources.json', 'interfaces/sample/resources.json', '[1,2,3]'],
    ['cli/preferences.json', 'cli/preferences.json', '{"format":"compact"}'],
    [
      'subharness/codex/home/auth.json',
      'subharness/codex/home/auth.json',
      '{"tokens":{"access_token":"synthetic-codex"}}',
    ],
    [
      'subharness/claude/home/.credentials.json',
      'subharness/claude/home/.credentials.json',
      '{"claudeAiOauth":{"accessToken":"synthetic-claude"}}',
    ],
    [
      'subharness/codex/home/sessions/2026/session.jsonl',
      'subharness/codex/home/sessions/2026/session.jsonl',
      '{"type":"session_meta","payload":{"id":"synthetic-persona-session"}}\n',
    ],
    ['subharness/gh/hosts.yml', 'subharness/gh/hosts.yml', 'example.test:\n  oauth_token: synthetic-gh\n'],
    ['subharness/codex/package.json', 'subharness/codex/package.json', '{"dependencies":{"@openai/codex":"1.2.3"}}'],
    ['subharness/codex/package-lock.json', 'subharness/codex/package-lock.json', '{"lockfileVersion":3}'],
  ];
  for (const [source, , bytes] of files) write(options.privateDir, source, bytes);
  fs.chmodSync(path.join(options.privateDir, 'skills.local/probe/run.sh'), 0o750);
  write(options.privateDir, '.env', 'OPENROUTER_CORE_KEY=synthetic-obsolete-env-key\n');
  write(options.privateDir, 'subharness/codex/node_modules/.bin/codex', 'synthetic install binary');
  write(options.privateDir, '.codex/auth.json', 'independent owner login');
  write(options.rootDir, 'interfaces/tracked/index.ts', 'engine default');
  const before = snapshot(options.privateDir);
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(snapshot(options.privateDir), before);
  fs.renameSync(options.privateDir, `${options.privateDir}-unavailable`);
  for (const [, target, bytes] of files)
    assert.deepEqual(fs.readFileSync(path.join(options.dataDir, target)), Buffer.from(bytes));
  assert.equal(fs.statSync(path.join(options.dataDir, 'skills/probe/run.sh')).mode & 0o100, 0o100);
  for (const target of ['keys.json', 'clients/shell.token', 'subharness/codex/home/auth.json'])
    assert.equal(fs.statSync(path.join(options.dataDir, target)).mode & 0o077, 0);
  assert.equal(fs.existsSync(path.join(options.dataDir, 'interfaces/tracked')), false);
  assert.equal(fs.existsSync(path.join(options.dataDir, 'subharness/codex/node_modules')), false);
  assert.equal(fs.existsSync(path.join(options.dataDir, '.codex')), false);
  assert.ok(plan.held.some(({ path: at }) => at.startsWith('subharness/codex/node_modules')));
  assert.ok(plan.held.some(({ path: at }) => at === '.codex'));
});

// A legacy environment-only install must retain usable logins without exposing credentials in reports.
test('legacy model and service credentials reach private JSON with roles and grants but never migration output', async () => {
  const options = fixture();
  const env = {
    OPENROUTER_CORE_KEY: 'synthetic-core-AAA1',
    OPENROUTER_CORE_BACKUP_KEY: 'synthetic-backup-BBB2',
    OPENROUTER_MEMORY_KEY: 'synthetic-memory-CCC3',
    DISCORD_TOKEN: 'synthetic-discord-DDD4',
    YOUTUBE_API_KEY: 'synthetic-youtube-EEE5',
    BRAVE_SEARCH_API_KEY: 'synthetic-brave-FFF6',
    EXA_API_KEY: 'synthetic-exa-GGG7',
    MEDIA_VIDEO_PROXY: 'https://synthetic-user:synthetic-password@proxy.test:8443',
    UNCLASSIFIED_TOKEN: 'synthetic-held-HHH8',
  };
  const config = {
    llm: {
      keyByRole: { core: ['OPENROUTER_CORE_BACKUP_KEY', 'OPENROUTER_CORE_KEY'], memory: 'OPENROUTER_MEMORY_KEY' },
      keys: {
        OPENROUTER_CORE_KEY: { grant: 200, resetDay: 22 },
        OPENROUTER_CORE_BACKUP_KEY: { grant: 100, resetDay: 1 },
      },
    },
    media: { video: { proxy: '${env:MEDIA_VIDEO_PROXY}' } },
  };
  write(
    options.privateDir,
    '.env',
    Object.entries(env)
      .map(([name, value]) => `${name}="${value}"`)
      .join('\n')
  );
  write(options.privateDir, 'config.local/config.json', JSON.stringify(config));
  const before = snapshot(options.privateDir);
  const plan = planPersonaLayers(options);
  const args = ['--root', options.rootDir, '--private', options.privateDir, '--data', options.dataDir];
  const output = await movePersonaFiles(args);
  assert.deepEqual(snapshot(options.dataDir), {}, 'planning creates no destination or temporary key store');
  assert.deepEqual(snapshot(options.privateDir), before);
  const applied = applyPersonaLayers(options);
  assert.deepEqual(applied.conflicts, []);
  const appliedOutput = await movePersonaFiles([...args, '--apply']);
  for (const value of Object.values(env))
    assert.equal(
      [JSON.stringify(plan), JSON.stringify(applied), output, appliedOutput].some((text) => text.includes(value)),
      false
    );
  const keys = createKeyStore({ privateDir: options.dataDir });
  assert.deepEqual(keys.list().core, [
    { name: 'core-1', last4: 'BBB2', grant: 100, resetDay: 1 },
    { name: 'core-2', last4: 'AAA1', grant: 200, resetDay: 22 },
  ]);
  assert.equal(keys.valueOf('core-1'), env.OPENROUTER_CORE_BACKUP_KEY);
  assert.equal(keys.valueOf('core-2'), env.OPENROUTER_CORE_KEY);
  assert.equal(keys.boundTo('memory'), 'memory');
  assert.equal(keys.valueOf('memory'), env.OPENROUTER_MEMORY_KEY);
  const written: unknown = JSON.parse(fs.readFileSync(path.join(options.dataDir, 'keys.json'), 'utf8'));
  assert.deepEqual(Reflect.get(Object(written), 'services'), {
    youtube: env.YOUTUBE_API_KEY,
    brave: env.BRAVE_SEARCH_API_KEY,
    exa: env.EXA_API_KEY,
    videoProxy: env.MEDIA_VIDEO_PROXY,
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(options.dataDir, 'interfaces/discord/credentials.json'), 'utf8')),
    { token: env.DISCORD_TOKEN }
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.dataDir, 'config/config.json'), 'utf8')), config);
  for (const target of ['keys.json', 'interfaces/discord/credentials.json'])
    assert.equal(fs.statSync(path.join(options.dataDir, target)).mode & 0o077, 0);
  assert.equal(JSON.stringify(plan.held).includes('UNCLASSIFIED_TOKEN'), true);
  assert.deepEqual(snapshot(options.privateDir), before);
});

// Extracting interface settings must preserve effective precedence and unrelated core management settings.
test('interface extraction keeps dedicated overrides above nested settings without changing unrelated core values', () => {
  const options = fixture();
  const own = { discord: { intents: { presences: false, members: false } }, context: { maxUrlChars: 100 } };
  const core = {
    discord: { intents: { presences: true, members: true } },
    context: { maxUrlChars: 200, softChars: 900 },
    interfaces: { enabled: ['discord'], restartMs: 750 },
    recall: { timeoutMs: 9 },
  };
  const dedicated = { discord: { intents: { members: false } }, context: { maxUrlChars: 300 } };
  write(options.rootDir, 'interfaces/discord/config.json', JSON.stringify(own));
  write(options.privateDir, 'config.local/config.json', JSON.stringify(core));
  write(options.privateDir, 'config.local/interfaces/discord.json', JSON.stringify(dedicated));
  const effective = readInterfaceConfig({
    rootDir: options.rootDir,
    privateDir: options.privateDir,
    name: 'discord',
    base: {},
  });
  assert.deepEqual(effective, {
    discord: { intents: { presences: true, members: false } },
    context: { maxUrlChars: 300 },
  });
  const before = snapshot(options.privateDir);
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(options.dataDir, 'interfaces/discord/config.json'), 'utf8')),
    effective
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.dataDir, 'config/config.json'), 'utf8')), {
    context: { softChars: 900 },
    interfaces: core.interfaces,
    recall: core.recall,
  });
  assert.deepEqual(snapshot(options.privateDir), before);
});
