// Where the settings and the labels are read from (PR 7c of stage 7). The checkout holds `config/config.json` and
// `config/labels.json` (split into `model` and `owner`), the private layer `config.local/config.json` and
// `config.local/labels.json`, each deep-merged over its tracked file. `hot.prompts.labels` is the two sections joined,
// so a reader finds every label at the path it always had. A private layer laid out the old way
// (`config.local.json`, a flat `prompts.local/labels.json`) still loads, with one warning per start that names
// tools/config-files-move.mjs, and gives the same settings and labels as the moved layer. A layer holding a settings
// file at both places refuses the start. Fake fs.watch, temporary folders, never the real local layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createHot as createHotUntyped } from '../src/hot.js';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { ROOT } from './fixtures/private-layer.ts';
import { tempDir } from './fixtures/tmp.js';

type Tree = Record<string, unknown>;

const MOVE_TOOL = 'tools/config-files-move.mjs';

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

/** A private layer laid out after the move. */
function movedLayer(): string {
  const dir = tempDir('nep-cfgdir-new-');
  write(dir, 'config.local/config.json', { pace: { settleMs: 900 } });
  write(dir, 'config.local/labels.json', {
    model: { transcript: { gap: 'my gap {duration}' } },
    owner: { status: { costs: { keyLead: 'my lead' } } },
  });
  return dir;
}

/** The same private layer laid out before the move. */
function oldLayer(): string {
  const dir = tempDir('nep-cfgdir-old-');
  write(dir, 'config.local.json', { pace: { settleMs: 900 } });
  write(dir, 'prompts.local/labels.json', {
    transcript: { gap: 'my gap {duration}' },
    status: { costs: { keyLead: 'my lead' } },
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

/** What these tests read of the live view (src/hot.js). */
type Hot = {
  config: Tree;
  prompts: { labels: Tree };
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
  }) as unknown as Hot;

const movedWarnings = (logs: ReadonlyArray<Tree>): number =>
  logs.filter((entry) => entry.level === 'warn' && entry.move === MOVE_TOOL).length;

test('reads the tracked settings from config/config.json', () => {
  const root = checkout();
  const hot = createHot({ rootDir: root, privateDir: tempDir('nep-cfgdir-empty-') });
  try {
    assert.deepEqual(hot.config, BASE_CONFIG);
  } finally {
    hot.close();
  }
});

test('deep-merges config.local/config.json over the tracked settings', () => {
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

test("deep-merges config.local/labels.json over the tracked labels, the owner's strings included", () => {
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

test('gives the same settings and labels from a layer laid out the old way as from the moved one', () => {
  const root = checkout();
  const moved = createHot({ rootDir: root, privateDir: movedLayer() });
  const old = createHot({ rootDir: root, privateDir: oldLayer() });
  try {
    assert.deepEqual(old.config, moved.config);
    assert.deepEqual(old.prompts.labels, moved.prompts.labels);
  } finally {
    moved.close();
    old.close();
  }
});

test('gives the same settings and labels over the real tracked files from either layout', () => {
  const moved = createHot({ rootDir: ROOT, privateDir: movedLayer() });
  const old = createHot({ rootDir: ROOT, privateDir: oldLayer() });
  try {
    assert.deepEqual(old.config, moved.config);
    assert.deepEqual(old.prompts.labels, moved.prompts.labels);
    const pace = old.config.pace as Tree;
    assert.equal(pace.settleMs, 900, 'the local value is read');
  } finally {
    moved.close();
    old.close();
  }
});

test('warns once per start about a layer laid out the old way, reloads included', async () => {
  const root = checkout();
  const privateDir = oldLayer();
  const { logs } = await withCapturedLogs(() => {
    const hot = createHot({ rootDir: root, privateDir });
    hot.reloadConfig();
    hot.reloadPrompts();
    hot.close();
  });
  assert.equal(movedWarnings(logs), 1);
});

test('gives no move warning for a moved layer', async () => {
  const root = checkout();
  const privateDir = movedLayer();
  const { logs } = await withCapturedLogs(() => {
    createHot({ rootDir: root, privateDir }).close();
  });
  assert.equal(movedWarnings(logs), 0);
});

test('refuses the start when the settings file is at both its old and its new place, naming the move tool', () => {
  const privateDir = movedLayer();
  write(privateDir, 'config.local.json', { pace: { settleMs: 100 } });
  assert.throws(() => createHot({ rootDir: checkout(), privateDir }), /config-files-move/);
});

test('refuses the start when the local labels are at both their old and their new place, naming the move tool', () => {
  const privateDir = movedLayer();
  write(privateDir, 'prompts.local/labels.json', { transcript: { gap: 'other' } });
  assert.throws(() => createHot({ rootDir: checkout(), privateDir }), /config-files-move/);
});

test('writes a setting into config.local/config.json in a moved layer, and the live config has it', () => {
  const privateDir = movedLayer();
  const hot = createHot({ rootDir: checkout(), privateDir });
  try {
    const env = createOpsEnv({
      discord: createDiscordInterface().capabilities,
      hot,
      store: { state: { data: {}, markDirty() {} } },
    });
    assert.equal(env.writeLocalPath('llm.retries', 5), true);
    const written: unknown = JSON.parse(fs.readFileSync(path.join(privateDir, 'config.local', 'config.json'), 'utf8'));
    assert.deepEqual(written, { pace: { settleMs: 900 }, llm: { retries: 5 } });
    assert.equal(fs.existsSync(path.join(privateDir, 'config.local.json')), false, 'no old-place file is made');
    assert.equal((hot.config.llm as Tree).retries, 5);
  } finally {
    hot.close();
  }
});

test('reloads the settings when config.local/config.json changes', async () => {
  const privateDir = movedLayer();
  const fake = fakeWatch();
  const hot = createHot({ rootDir: checkout(), privateDir, watchImpl: fake.watch }).watch();
  try {
    const seen: Array<string> = [];
    hot.onReload((what) => seen.push(what));
    write(privateDir, 'config.local/config.json', { pace: { settleMs: 1234 } });
    const watchers = fake.of(path.join(privateDir, 'config.local'));
    assert.equal(watchers.length, 1, 'config.local/ is watched');
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
