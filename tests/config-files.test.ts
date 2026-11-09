// Canonical persona configuration and labels merge over engine defaults.
// Existing merge, targeted-write, watcher and interface precedence controls retain their values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createHot as createHotUntyped } from '../src/hot.ts';
import * as files from '../src/config/files.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { ROOT } from './fixtures/private-layer.ts';
import { resolvePaths } from '../src/paths.ts';
import { readConfig } from '../src/config.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { profileOf } from '../src/agent-runner/profiles.ts';
import { fixture as agentFixture } from './fixtures/agent-overrides.ts';
import { tempDir } from './fixtures/tmp.ts';

type Tree = Record<string, unknown>;

const BASE_CONFIG = { pace: { settleMs: 500, settleMaxMs: 3000 }, llm: { retries: 2 } };
const BASE_LABELS = {
  model: { transcript: { gap: 'base gap {duration}', edited: 'base edited' } },
  owner: { status: { costs: { keyLead: 'base lead' } } },
};

function write(dir: string, rel: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(value));
}

/** A checkout with only the new tracked files: config/config.json, config/labels.json and an empty prompts/. */
function checkout(): string {
  const dir = tempDir('nep-cfgdir-root-');
  write(dir, 'config/config.json', BASE_CONFIG);
  write(dir, 'config/labels.json', BASE_LABELS);
  fs.mkdirSync(path.join(dir, 'prompts'));
  return dir;
}

/** A canonical persona layer uses config/ for runtime reads, writes and watches. */
function movedLayer(): string {
  const dir = tempDir('nep-cfgdir-new-');
  write(dir, 'config/config.json', { pace: { settleMs: 900 } });
  write(dir, 'config/labels.json', {
    model: { transcript: { gap: 'my gap {duration}' } },
    owner: { status: { costs: { keyLead: 'my lead' } } },
  });
  return dir;
}

type Watcher = EventEmitter & { target: string; listener: (event: string, file: string) => void; close: () => void };

/** A fake fs.watch: every watcher it hands out records its target and listener. */
function fakeWatch(): {
  watch: (target: string, listener: (event: string, file: string) => void) => Watcher;
  of: (target: string) => Array<Watcher>;
} {
  const handed: Array<Watcher> = [];
  const watch = (target: string, listener: (event: string, file: string) => void): Watcher => {
    const watcher = Object.assign(new EventEmitter(), { target, listener, close: () => {} });
    handed.push(watcher);
    return watcher;
  };
  return { watch, of: (target) => handed.filter((one) => one.target === target) };
}

/** What these tests read of the live view (src/hot.ts). */
type Hot = {
  config: Tree;
  prompts: Record<string, unknown> & { labels: Tree };
  reloadConfig: () => boolean;
  reloadPrompts: () => boolean;
  onReload: (listener: (what: string) => void) => () => void;
  watch: () => Hot;
  close: () => void;
};

const createHot = (options: { rootDir: string; privateDir: string; watchImpl?: unknown }): Hot =>
  createHotUntyped({
    rootDir: options.rootDir,
    privateDir: options.privateDir,
    ...(options.watchImpl === undefined ? {} : { watchImpl: options.watchImpl as typeof fs.watch }),
  });

test('reads the tracked settings from config/config.json', () => {
  const root = checkout();
  const hot = createHot({ rootDir: root, privateDir: tempDir('nep-cfgdir-empty-') });
  try {
    assert.deepEqual(hot.config, BASE_CONFIG);
  } finally {
    hot.close();
  }
});

test('deep-merges persona config/config.json over the tracked settings', () => {
  const hot = createHot({ rootDir: checkout(), privateDir: movedLayer() });
  try {
    assert.deepEqual(hot.config, { pace: { settleMs: 900, settleMaxMs: 3000 }, llm: { retries: 2 } });
  } finally {
    hot.close();
  }
});

test('gives the tracked labels as one flat object, each key at its path under its section', () => {
  const hot = createHot({ rootDir: checkout(), privateDir: tempDir('nep-cfgdir-empty-') });
  try {
    assert.deepEqual(hot.prompts.labels, {
      transcript: { gap: 'base gap {duration}', edited: 'base edited' },
      status: { costs: { keyLead: 'base lead' } },
    });
  } finally {
    hot.close();
  }
});

test("deep-merges persona config/labels.json over the tracked labels, the owner's strings included", () => {
  const hot = createHot({ rootDir: checkout(), privateDir: movedLayer() });
  try {
    assert.deepEqual(hot.prompts.labels, {
      transcript: { gap: 'my gap {duration}', edited: 'base edited' },
      status: { costs: { keyLead: 'my lead' } },
    });
  } finally {
    hot.close();
  }
});

test('writes a setting into config/config.json in a canonical layer, and the live config has it', () => {
  const privateDir = movedLayer();
  const hot = createHot({ rootDir: checkout(), privateDir });
  try {
    const env = createOpsEnv({
      discord: createDiscordInterface().capabilities,
      hot,
      store: { state: { data: {}, markDirty() {} } },
    });
    assert.equal(env.writeLocalPath('llm.retries', 5), true);
    const written: unknown = JSON.parse(fs.readFileSync(path.join(privateDir, 'config', 'config.json'), 'utf8'));
    assert.deepEqual(written, { pace: { settleMs: 900 }, llm: { retries: 5 } });
    assert.equal(fs.existsSync(path.join(privateDir, 'config.local.json')), false, 'no old-place file is made');
    assert.equal((hot.config.llm as Tree).retries, 5);
  } finally {
    hot.close();
  }
});

test('reloads the settings when persona config/config.json changes', async () => {
  const privateDir = movedLayer();
  const fake = fakeWatch();
  const hot = createHot({ rootDir: checkout(), privateDir, watchImpl: fake.watch }).watch();
  try {
    const seen: Array<string> = [];
    hot.onReload((what) => seen.push(what));
    write(privateDir, 'config/config.json', { pace: { settleMs: 1234 } });
    const watchers = fake.of(path.join(privateDir, 'config'));
    assert.equal(watchers.length, 1, 'the persona config/ is watched');
    watchers[0]?.listener('change', 'config.json');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(seen.includes('config'));
    assert.equal((hot.config.pace as Tree).settleMs, 1234);
  } finally {
    hot.close();
  }
});

test('reloads the settings when the tracked config/config.json changes', async () => {
  const root = checkout();
  const fake = fakeWatch();
  const hot = createHot({ rootDir: root, privateDir: tempDir('nep-cfgdir-empty-'), watchImpl: fake.watch }).watch();
  try {
    const seen: Array<string> = [];
    hot.onReload((what) => seen.push(what));
    write(root, 'config/config.json', { ...BASE_CONFIG, llm: { retries: 7 } });
    const watchers = fake.of(path.join(root, 'config'));
    assert.equal(watchers.length, 1, 'config/ is watched');
    watchers[0]?.listener('change', 'config.json');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(seen.includes('config'));
    assert.equal((hot.config.llm as Tree).retries, 7);
  } finally {
    hot.close();
  }
});

// The tracked files at their old places would be a second copy the engine no longer reads, left to drift.
test('the checkout keeps the settings and the labels only under config/', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'config', 'config.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'config', 'labels.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'prompts', 'labels.json')), false);
});

// ---- the settings of an interface (PR 7d) ---------------------------------------------------------------------------
// The prepared interface settings live in persona interfaces/<name>/config.json over the engine package defaults.

test("gives an interface its package's defaults over the core settings and its local file over both", () => {
  const root = tempDir('nep-iface-root-');
  write(root, 'interfaces/discord/config.json', { discord: { intents: { presences: false, members: false } } });
  const dir = tempDir('nep-iface-private-');
  write(dir, 'interfaces/discord/config.json', { discord: { intents: { members: true } } });
  const settings = files.readInterfaceConfig({ rootDir: root, privateDir: dir, name: 'discord', base: BASE_CONFIG });
  assert.deepEqual(settings, { ...BASE_CONFIG, discord: { intents: { presences: false, members: true } } });
});

test('gives an interface its extracted settings without unrelated core overrides', () => {
  const root = tempDir('nep-iface-root-');
  write(root, 'interfaces/discord/config.json', { discord: { intents: { presences: false, members: false } } });
  const dir = tempDir('nep-iface-private-');
  // Interface keys are extracted before runtime while unrelated settings stay in the core persona layer.
  write(dir, 'interfaces/discord/config.json', { discord: { intents: { presences: true } } });
  write(dir, 'config/config.json', { recall: { timeoutMs: 9 } });
  const settings = files.readInterfaceConfig({ rootDir: root, privateDir: dir, name: 'discord', base: {} });
  assert.deepEqual(settings, { discord: { intents: { presences: true, members: false } } });
});

// A copied persona must retain its effective settings and identity after the original install disappears.
test('a copied persona supplies configuration, prompts, keys and agent overrides without its original root', () => {
  const original = agentFixture();
  write(original.rootDir, 'config/config.json', { pace: { settleMs: 500, settleMaxMs: 3000 } });
  write(original.rootDir, 'config/labels.json', { model: { copied: 'base label' }, owner: {} });
  fs.mkdirSync(path.join(original.rootDir, 'prompts'));
  fs.writeFileSync(path.join(original.rootDir, 'prompts/rules.md'), 'base rules');
  write(original.dataDir, 'config/config.json', { pace: { settleMs: 900 } });
  write(original.dataDir, 'config/labels.json', { model: { copied: 'personal label' }, owner: {} });
  fs.mkdirSync(path.join(original.dataDir, 'prompts'));
  fs.writeFileSync(path.join(original.dataDir, 'prompts/rules.md'), 'personal rules');
  // Changed: keys.json holds named keys under `keys` (spec 2026-11-09-model-routes, slice 4).
  write(original.dataDir, 'keys.json', { keys: { 'core-1': 'synthetic-portable-key' } });
  original.override({ limits: { steps: 6 } });
  fs.writeFileSync(path.join(original.personal, 'prompt.md'), 'personal worker instructions');
  const copied = tempDir('nep-persona-copied-');
  const rootDir = path.join(copied, 'engine');
  const dataDir = path.join(copied, 'persona');
  fs.cpSync(original.rootDir, rootDir, { recursive: true });
  fs.cpSync(original.dataDir, dataDir, { recursive: true });
  fs.renameSync(original.base, `${original.base}-unavailable`);
  const paths = resolvePaths({ rootDir, env: { NEPTUNIA_DATA_DIR: dataDir } });
  assert.deepEqual(readConfig(rootDir, { privateDir: paths.privateDir }), {
    pace: { settleMs: 900, settleMaxMs: 3000 },
  });
  const hot = createHot({ rootDir, privateDir: paths.privateDir });
  try {
    assert.equal(hot.prompts.rules, 'personal rules');
    assert.deepEqual(hot.prompts.labels, { copied: 'personal label' });
    assert.equal(createKeyStore({ privateDir: paths.privateDir }).valueOf('core-1'), 'synthetic-portable-key');
    const profile = profileOf('scout', { rootDir, dataDir, env: {} });
    assert.equal(profile?.defaultLimits.steps, 6);
    assert.equal(profile?.promptFiles[0], path.join(dataDir, 'agents/scout/prompt.md'));
  } finally {
    hot.close();
  }
});

// A setting written through the public operation and subsequent file edits must use the selected persona root.
test('targeted writes and prompt watchers update the same canonical data directory', async () => {
  const rootDir = checkout();
  fs.writeFileSync(path.join(rootDir, 'prompts/rules.md'), 'engine rules');
  const dataDir = tempDir('nep-canonical-live-');
  write(dataDir, 'config/config.json', { pace: { settleMs: 900 } });
  fs.mkdirSync(path.join(dataDir, 'prompts/preambles'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'prompts/rules.md'), 'personal rules');
  fs.writeFileSync(path.join(dataDir, 'prompts/preambles/probe.md'), 'personal preamble');
  const paths = resolvePaths({ rootDir, env: { NEPTUNIA_DATA_DIR: dataDir } });
  const fake = fakeWatch();
  const hot = createHot({ rootDir, privateDir: paths.privateDir, watchImpl: fake.watch }).watch();
  try {
    const env = createOpsEnv({ hot, store: { state: { data: {}, markDirty() {} } } });
    assert.equal(env.writeLocalPath('llm.retries', 5), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config/config.json'), 'utf8')), {
      pace: { settleMs: 900 },
      llm: { retries: 5 },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rootDir, 'config/config.json'), 'utf8')), BASE_CONFIG);
    assert.equal(fs.existsSync(path.join(dataDir, 'config.local')), false);
    assert.deepEqual(hot.prompts.preambles, { probe: 'personal preamble' });
    const configWatch = fake.of(path.join(dataDir, 'config'));
    const promptWatch = fake.of(path.join(dataDir, 'prompts'));
    assert.equal(configWatch.length, 1);
    assert.equal(promptWatch.length, 1);
    const seen: Array<string> = [];
    hot.onReload((what) => seen.push(what));
    write(dataDir, 'config/config.json', { pace: { settleMs: 1234 }, llm: { retries: 5 } });
    fs.writeFileSync(path.join(dataDir, 'prompts/rules.md'), 'edited personal rules');
    configWatch[0]?.listener('change', 'config.json');
    promptWatch[0]?.listener('change', 'rules.md');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(seen.sort(), ['config', 'prompts']);
    assert.deepEqual(hot.config, { pace: { settleMs: 1234, settleMaxMs: 3000 }, llm: { retries: 5 } });
    assert.equal(hot.prompts.rules, 'edited personal rules');
  } finally {
    hot.close();
  }
});

test('the token variable of an interface is its name in capitals with _TOKEN', () => {
  // Catches: the token handed to the interface under a variable the Discord package never reads, so it starts without one.
  assert.equal(files.tokenVariableOf('discord'), 'DISCORD_TOKEN');
  assert.equal(files.tokenVariableOf('my-chat'), 'MY_CHAT_TOKEN');
});
