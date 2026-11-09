// Tests for src/hot.ts: the live config/prompts view. Never depends on
// fs.watch timing. Personal fixtures use root/data, matching the canonical runtime contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHot } from '../src/hot.ts';
import type { Hot } from '../src/hot.ts';
import { composePreamble } from '../src/errands/preambles.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Untyped } from '../src/tools/types.ts';
import { present, wrongly } from './fixtures/loose-types.ts';
import { chainsOf } from './fixtures/chains.ts';
import { roleModel } from '../src/llm/roles.ts';

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

function makeRoot({ config = { bot: { timezone: 'UTC' } }, prompts = {} } = {}) {
  const dir = tempDir('nep-hot-');
  // PR 7c: the tracked settings live in config/config.json.
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'data', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, 'prompts'));
  for (const [name, text] of Object.entries(prompts)) {
    fs.writeFileSync(path.join(dir, 'prompts', `${name}.md`), wrongly(text));
  }
  return dir;
}

test('createHot: loads config and prompts from the given root at creation', () => {
  const dir = makeRoot({
    config: { bot: { timezone: 'Europe/Moscow' } },
    prompts: { persona: 'Είσαι η Ζωή.', rules: '## Κανόνες\n- να είσαι ο εαυτός σου' },
  });
  const hot = createHot({ rootDir: dir });
  try {
    assert.deepEqual(hot.config, { bot: { timezone: 'Europe/Moscow' } });
    assert.equal(hot.prompts.persona, 'Είσαι η Ζωή.');
    assert.ok(hot.prompts.rules.includes('## Κανόνες'));
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadConfig: picks up a valid change', () => {
  const dir = makeRoot(wrongly({ config: { a: 1 } }));
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ a: 2 }));
    const ok = hot.reloadConfig();
    assert.equal(ok, true);
    assert.deepEqual(hot.config, { a: 2 });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadConfig: keeps the previous config on invalid JSON and returns false', () => {
  const dir = makeRoot(wrongly({ config: { a: 1 } }));
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), '{ not valid json');
    const ok = hot.reloadConfig();
    assert.equal(ok, false);
    assert.deepEqual(hot.config, { a: 1 });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadConfig: data/config/config.json is merged in on reload too', () => {
  const dir = makeRoot(wrongly({ config: { a: 1, b: 1 } }));
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'data', 'config', 'config.json'), JSON.stringify({ b: 2 }));
    hot.reloadConfig();
    assert.deepEqual(hot.config, { a: 1, b: 2 });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: picks up new content', () => {
  const dir = makeRoot({ prompts: { persona: 'old text' } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), 'new text');
    const ok = hot.reloadPrompts();
    assert.equal(ok, true);
    assert.equal(hot.prompts.persona, 'new text');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: keeps the previous text when a file becomes empty', () => {
  const dir = makeRoot({ prompts: { persona: 'important text', rules: 'other text' } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), ''); // editor truncated it mid-save
    fs.writeFileSync(path.join(dir, 'prompts', 'rules.md'), 'updated other text');
    hot.reloadPrompts();
    assert.equal(hot.prompts.persona, 'important text'); // kept
    assert.equal(hot.prompts.rules, 'updated other text'); // still updates normally
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: emits "change" with what:"config" after reloadConfig', () => {
  const dir = makeRoot(wrongly({ config: { a: 1 } }));
  const hot = createHot({ rootDir: dir });
  try {
    let seen = null;
    hot.on('change', (payload) => {
      seen = payload;
    });
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ a: 2 }));
    hot.reloadConfig();
    assert.deepEqual(seen, { what: 'config' });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: emits "change" with what:"prompts" after reloadPrompts', () => {
  const dir = makeRoot({ prompts: { persona: 'a' } });
  const hot = createHot({ rootDir: dir });
  try {
    let seen = null;
    hot.on('change', (payload) => {
      seen = payload;
    });
    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), 'b');
    hot.reloadPrompts();
    assert.deepEqual(seen, { what: 'prompts' });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: does not emit "change" when reloadConfig fails', () => {
  const dir = makeRoot(wrongly({ config: { a: 1 } }));
  const hot = createHot({ rootDir: dir });
  try {
    let emitted = false;
    hot.on('change', () => {
      emitted = true;
    });
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), '{ bad json');
    hot.reloadConfig();
    assert.equal(emitted, false);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readPrompts: strips a UTF-8 BOM and normalizes CRLF to LF, trimming edges', () => {
  const dir = makeRoot();
  fs.writeFileSync(path.join(dir, 'prompts', 'format.md'), '﻿  line one\r\nline two  \r\n');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.format, 'line one\nline two');
    assert.ok(!hot.prompts.format.includes('﻿'));
    assert.ok(!hot.prompts.format.includes('\r'));
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: non-.md files in prompts/ are ignored', () => {
  const dir = makeRoot({ prompts: { persona: 'a' } });
  fs.writeFileSync(path.join(dir, 'prompts', 'README.txt'), 'not a prompt');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.README, undefined);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Two prompt layers: prompts/ (base, tracked) + data/prompts/ (untracked)
// ---------------------------------------------------------------------------

function writeLocalPrompt(dir: string, name: string, text: string, dataDir = path.join(dir, 'data')) {
  const localDir = path.join(dataDir, 'prompts');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, `${name}.md`), text);
}

// Both label layers use explicit model and owner sections under their respective config directories.
function writeLabels(dir: string, layer: string, value: string) {
  const target = layer === 'base' ? path.join(dir, 'config') : path.join(dir, 'data', 'config');
  fs.mkdirSync(target, { recursive: true });
  let text = value;
  {
    try {
      const model = JSON.parse(value);
      text = JSON.stringify({ model, owner: {} });
    } catch {
      // an invalid file stays invalid
    }
  }
  fs.writeFileSync(path.join(target, 'labels.json'), text);
}

test('createHot: a data/prompts file replaces the base file of the same name', () => {
  const dir = makeRoot({ prompts: { rules: 'base text' } });
  writeLocalPrompt(dir, 'rules', 'local text');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.rules, 'local text');
    assert.equal(hot.promptSources.rules, 'local');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: an empty local file falls back to the base text', () => {
  const dir = makeRoot({ prompts: { persona: 'base text' } });
  writeLocalPrompt(dir, 'persona', '   \n  ');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.persona, 'base text');
    assert.equal(hot.promptSources.persona, 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: deleting a local file falls back to the base text', () => {
  const dir = makeRoot({ prompts: { rules: 'base text' } });
  writeLocalPrompt(dir, 'rules', 'local text');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.rules, 'local text');
    fs.rmSync(path.join(dir, 'data', 'prompts', 'rules.md'));
    const ok = hot.reloadPrompts();
    assert.equal(ok, true);
    assert.equal(hot.prompts.rules, 'base text');
    assert.equal(hot.promptSources.rules, 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: deleting a base file with no local counterpart drops the key', () => {
  const dir = makeRoot({ prompts: { persona: 'a', rules: 'b' } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.rmSync(path.join(dir, 'prompts', 'persona.md'));
    hot.reloadPrompts();
    assert.equal(hot.prompts.persona, undefined);
    assert.equal(hot.promptSources.persona, undefined);
    assert.equal(hot.prompts.rules, 'b');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: labels.json deep-merges the local layer over the base one, source "merged"', () => {
  const dir = makeRoot();
  writeLabels(dir, 'base', JSON.stringify({ locale: 'en-US', self: '{name} (you)' }));
  writeLabels(dir, 'local', JSON.stringify({ locale: 'ru-RU' }));
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.labels.locale, 'ru-RU');
    assert.equal(hot.prompts.labels.self, '{name} (you)');
    assert.equal(hot.promptSources.labels, 'merged');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Both JSON tool-text layers keep merge and reload behavior in their respective config directories.
test('createHot: tools.json is a JSON layer like labels.json: deep-merged, {} when absent, kept on a bad reload', () => {
  const dir = makeRoot();
  const write = (layer: string, value: string) => {
    const target = layer === 'base' ? path.join(dir, 'config') : path.join(dir, 'data', 'config');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'tools.json'), value);
  };
  const absent = createHot({ rootDir: dir });
  try {
    assert.deepEqual(absent.prompts.tools, {});
    assert.equal(absent.promptSources.tools, 'base');
  } finally {
    absent.close();
  }
  write('base', JSON.stringify({ draw: { title: 'Ζωγραφιά', whenToUse: 'base' } }));
  write('local', JSON.stringify({ draw: { whenToUse: 'local' } }));
  writeLabels(dir, 'base', JSON.stringify({ locale: 'en-US' }));
  const hot = createHot({ rootDir: dir });
  try {
    assert.deepEqual(hot.prompts.tools, { draw: { title: 'Ζωγραφιά', whenToUse: 'local' } });
    assert.equal(hot.promptSources.tools, 'merged');
    write('local', '{ broken');
    writeLabels(dir, 'base', JSON.stringify({ locale: 'fr-FR' }));
    assert.equal(hot.reloadPrompts(), true);
    assert.deepEqual(
      hot.prompts.tools,
      { draw: { title: 'Ζωγραφιά', whenToUse: 'local' } },
      'the previous tool texts stay'
    );
    assert.deepEqual(hot.prompts.labels, { locale: 'fr-FR' }, 'the other JSON layer still reloads');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: missing base labels default to {} with source "base" when there is no local file', () => {
  const dir = makeRoot();
  const hot = createHot({ rootDir: dir });
  try {
    assert.deepEqual(hot.prompts.labels, {});
    assert.equal(hot.promptSources.labels, 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: invalid base labels.json throws on the initial load', () => {
  const dir = makeRoot();
  writeLabels(dir, 'base', '{ not valid json');
  try {
    assert.throws(() => createHot({ rootDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: invalid local labels.json on reload keeps the previous labels and still returns true', () => {
  const dir = makeRoot();
  writeLabels(dir, 'base', JSON.stringify({ locale: 'en-US' }));
  const hot = createHot({ rootDir: dir });
  try {
    writeLabels(dir, 'local', '{ not valid json');
    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), 'unrelated update'); // rest of the reload still applies
    const ok = hot.reloadPrompts();
    assert.equal(ok, true);
    assert.deepEqual(hot.prompts.labels, { locale: 'en-US' });
    assert.equal(hot.promptSources.labels, 'base');
    assert.equal(hot.prompts.persona, 'unrelated update');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: invalid base labels.json on reload keeps the previous merged labels', () => {
  const dir = makeRoot();
  writeLabels(dir, 'base', JSON.stringify({ locale: 'en-US' }));
  writeLabels(dir, 'local', JSON.stringify({ locale: 'ru-RU' }));
  const hot = createHot({ rootDir: dir });
  try {
    writeLabels(dir, 'base', '{ broken');
    const ok = hot.reloadPrompts();
    assert.equal(ok, true);
    assert.deepEqual(hot.prompts.labels, { locale: 'ru-RU' });
    assert.equal(hot.promptSources.labels, 'merged');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// data/prompts/ deleted and recreated while running (an rsync of the
// directory): its watcher is dropped and a new one starts. A fake fs.watch
// stands in, so no test depends on real watcher timing.
// ---------------------------------------------------------------------------

/** A fake fs.watch: every watcher it hands out records its target and listener, emits, and records close(). */
function fakeWatch() {
  const handed: Array<Untyped> = [];
  const watch = (target: Record<string, Untyped>, listener: Record<string, Untyped>) => {
    const watcher: Record<string, Untyped> = new EventEmitter();
    Object.assign(watcher, { target, listener, closed: false });
    watcher.close = () => {
      watcher.closed = true;
    };
    handed.push(watcher);
    return watcher;
  };
  watch.of = (target: Untyped) => handed.filter((w) => w.target === target);
  return watch;
}

test('watch: a data/prompts/ deleted and recreated is watched again', () => {
  const dir = makeRoot({ prompts: { rules: 'base text' } });
  writeLocalPrompt(dir, 'rules', 'local text');
  const localDir = path.join(dir, 'data', 'prompts');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: wrongly(watch) }).watch();
  try {
    const [root] = watch.of(path.join(dir, 'data'));
    assert.equal(watch.of(localDir).length, 1);

    fs.rmSync(localDir, { recursive: true, force: true });
    root.listener('rename', 'prompts');
    assert.equal(watch.of(localDir)[0].closed, true, 'the watcher of the deleted directory is closed');

    writeLocalPrompt(dir, 'rules', 'local again');
    root.listener('rename', 'prompts');
    assert.equal(watch.of(localDir).length, 2, 'the recreated directory gets a watcher of its own');
    assert.equal(watch.of(localDir)[1].closed, false);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch: an error on the data/prompts/ watcher frees it, so the next root event starts a new one', async () => {
  const dir = makeRoot({ prompts: { rules: 'base text' } });
  writeLocalPrompt(dir, 'rules', 'local text');
  const localDir = path.join(dir, 'data', 'prompts');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: wrongly(watch) }).watch();
  try {
    const [root] = watch.of(path.join(dir, 'data'));
    const [first] = watch.of(localDir);
    const { logs } = await withCapturedLogs(() => first.emit('error', new Error('EPERM')));
    assert.ok(logs.some((l) => l.msg === 'hot: watcher error'));
    assert.equal(first.closed, true);

    root.listener('rename', 'prompts');
    assert.equal(watch.of(localDir).length, 2);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch: close() closes every watcher, the data/prompts/ one included', () => {
  const dir = makeRoot();
  writeLocalPrompt(dir, 'rules', 'local text');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: wrongly(watch) }).watch();
  hot.close();
  try {
    for (const target of [dir, path.join(dir, 'prompts'), path.join(dir, 'data', 'prompts')]) {
      assert.equal(watch.of(target)[0].closed, true, target);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a config that still sets memory.voiceModel warns once at startup and once per reload that brings it back; the value stays in the config, unread', async () => {
  const dir = makeRoot(wrongly({ config: { llm: { model: 'x/voice' }, memory: { voiceModel: 'x/old-voice' } } }));
  const retired = (logs: Record<string, Untyped>) =>
    logs.filter((entry: Record<string, Untyped>) => entry.msg === 'config: memory.voiceModel is no longer read');
  let hot = wrongly<Hot>(undefined);
  try {
    const started = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
    });
    assert.equal(retired(started.logs).length, 1);
    assert.equal(retired(started.logs)[0].level, 'warn');
    assert.ok(!JSON.stringify(started.logs).includes('x/old-voice'), 'the key, never its value');

    const reloads = await withCapturedLogs(() => {
      hot.reloadConfig(); // still set: no second warning
      fs.writeFileSync(
        path.join(dir, 'config', 'config.json'),
        JSON.stringify({ llm: { model: 'x/voice' }, memory: { voiceModel: null } })
      );
      hot.reloadConfig(); // gone (null counts as unset)
      fs.writeFileSync(
        path.join(dir, 'data', 'config', 'config.json'),
        JSON.stringify({ memory: { voiceModel: 'x/old-voice' } })
      );
      hot.reloadConfig(); // back through the local layer
    });
    assert.equal(retired(reloads.logs).length, 1);

    const clean = makeRoot(wrongly({ config: { llm: { model: 'x/voice' } } }));
    const quiet = await withCapturedLogs(() => createHot({ rootDir: clean }).close());
    assert.equal(retired(quiet.logs).length, 0);
    fs.rmSync(clean, { recursive: true, force: true });
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a data/config/config.json is read key by key: an old model key is not read, a reload keeps the previous config on bad JSON', async () => {
  const dir = makeRoot(wrongly({ config: { models: { routes: chainsOf({ analyzer: 'x/default' }) } } }));
  fs.mkdirSync(path.join(dir, 'data', 'config'), { recursive: true });
  const localFile = path.join(dir, 'data', 'config', 'config.json');
  fs.writeFileSync(
    localFile,
    JSON.stringify({ classifier: { text: 'x/old-text' }, models: { routes: chainsOf({ vision: 'x/new-vision' }) } })
  );
  let hot = wrongly<Hot>(undefined);
  try {
    const started = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
    });
    // Changed: a role's model is its chain's (spec 2026-11-09-model-routes, slice 4).
    assert.equal(roleModel(hot.config, 'analyzer'), 'x/default', 'classifier.text is no model key any more');
    assert.equal(roleModel(hot.config, 'vision'), 'x/new-vision');
    assert.equal(started.logs.filter((entry) => entry.level === 'warn').length, 0, 'no listing of old keys');

    fs.writeFileSync(localFile, '{ not json');
    const reload = await withCapturedLogs(() => hot.reloadConfig());
    assert.equal(reload.result, false, 'the reload is refused');
    assert.equal(roleModel(hot.config, 'vision'), 'x/new-vision', 'the previous config stays live');
    fs.writeFileSync(localFile, JSON.stringify({ models: { routes: chainsOf({ analyzer: 'x/new-text' }) } }));
    hot.reloadConfig();
    assert.equal(roleModel(hot.config, 'analyzer'), 'x/new-text');
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hot: exposes promptsHash and configHash that change when a prompt or the config changes', () => {
  const dir = makeRoot(wrongly({ config: { a: 1, b: { c: 2 } }, prompts: { persona: 'Είσαι η Ζωή.' } }));
  const hot = createHot({ rootDir: dir });
  try {
    const first = hot.hashes;
    assert.match(first.promptsHash, /^[0-9a-f]{16}$/);
    assert.match(first.configHash, /^[0-9a-f]{16}$/);

    // A reload of unchanged files keeps both; the key order of the config does not count.
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ b: { c: 2 }, a: 1 }));
    hot.reloadConfig();
    hot.reloadPrompts();
    assert.deepEqual(hot.hashes, first);

    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), 'Είσαι η Ελένη.');
    hot.reloadPrompts();
    assert.notEqual(hot.hashes.promptsHash, first.promptsHash);
    assert.equal(hot.hashes.configHash, first.configHash);

    const promptsHash = hot.hashes.promptsHash;
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ a: 2, b: { c: 2 } }));
    hot.reloadConfig();
    assert.notEqual(hot.hashes.configHash, first.configHash);
    assert.equal(hot.hashes.promptsHash, promptsHash);

    // A reload that fails keeps the hash of what stays live.
    const configHash = hot.hashes.configHash;
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), '{ not valid json');
    hot.reloadConfig();
    assert.equal(hot.hashes.configHash, configHash);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('hot: onReload fires with the layer name', async () => {
  const dir = makeRoot(wrongly({ config: { a: 1 }, prompts: { persona: 'a' } }));
  const hot = createHot({ rootDir: dir });
  try {
    const seen: Array<Untyped> = [];
    const off = hot.onReload((what) => seen.push(what));
    hot.reloadConfig();
    hot.reloadPrompts();
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), '{ broken');
    await withCapturedLogs(() => hot.reloadConfig());
    assert.deepEqual(seen, ['config', 'prompts']);
    off();
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ a: 2 }));
    hot.reloadConfig();
    assert.deepEqual(seen, ['config', 'prompts']);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The private layer apart from the checkout (src/paths.ts)
// ---------------------------------------------------------------------------

test('createHot: a privateDir apart from rootDir supplies config/config.json and prompts/, a writeLocalPath lands there, and its watcher reloads', async () => {
  const dir = makeRoot(wrongly({ config: { a: 1, b: 1 }, prompts: { rules: 'base text', persona: 'base persona' } }));
  const privateDir = tempDir('nep-hot-private-');
  fs.mkdirSync(path.join(privateDir, 'config'));
  fs.writeFileSync(path.join(privateDir, 'config', 'config.json'), JSON.stringify({ b: 2 }));
  writeLocalPrompt(dir, 'rules', 'private text', privateDir);
  // A local layer left in the checkout is not read once the private directory is elsewhere.
  fs.writeFileSync(path.join(dir, 'data', 'config', 'config.json'), JSON.stringify({ a: 9 }));
  writeLocalPrompt(dir, 'persona', 'checkout persona');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, privateDir, watchImpl: wrongly(watch) }).watch();
  try {
    assert.equal(hot.rootDir, dir);
    assert.equal(hot.privateDir, privateDir);
    assert.deepEqual(hot.config, { a: 1, b: 2 });
    assert.equal(hot.prompts.rules, 'private text');
    assert.equal(hot.prompts.persona, 'base persona');
    assert.equal(hot.localPromptsDir, path.join(privateDir, 'prompts'));

    // The operations' config writer goes to the private directory and reloads.
    const env = createOpsEnv(wrongly({ discord: DISCORD, hot }));
    assert.equal(env.writeLocalPath('c', 3), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(privateDir, 'config', 'config.json'), 'utf8')), {
      b: 2,
      c: 3,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'config', 'config.json'), 'utf8')), { a: 9 });
    assert.deepEqual(hot.config, { a: 1, b: 2, c: 3 });

    // One watcher per root directory, plus prompts/ and the private data/prompts/.
    assert.equal(watch.of(dir).length, 1);
    assert.equal(watch.of(privateDir).length, 1);
    assert.equal(watch.of(path.join(privateDir, 'prompts')).length, 1);
    assert.equal(watch.of(path.join(dir, 'data', 'prompts')).length, 0);

    // An edit in the private directory reloads; the same names in the checkout do not.
    const [rootWatcher] = watch.of(dir);
    const [privateWatcher] = watch.of(path.join(privateDir, 'config'));
    const [localWatcher] = watch.of(path.join(privateDir, 'prompts'));
    const seen: Array<Untyped> = [];
    hot.onReload((what) => seen.push(what));
    rootWatcher.listener('change', 'config.local.json');
    rootWatcher.listener('rename', 'data');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(seen, []);
    assert.equal(watch.of(path.join(dir, 'data', 'prompts')).length, 0);

    fs.writeFileSync(path.join(privateDir, 'config', 'config.json'), JSON.stringify({ b: 5 }));
    privateWatcher.listener('change', 'config.json');
    writeLocalPrompt(dir, 'rules', 'private text, edited', privateDir);
    localWatcher.listener('change', 'rules.md');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(seen.sort(), ['config', 'prompts']);
    assert.deepEqual(hot.config, { a: 1, b: 5 });
    assert.equal(hot.prompts.rules, 'private text, edited');

    hot.close();
    assert.equal(privateWatcher.closed, true);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
});

test('createHot: without a privateDir the persona is root/data and each root is watched once', () => {
  const dir = makeRoot();
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: wrongly(watch) }).watch();
  try {
    assert.equal(hot.privateDir, path.join(dir, 'data'));
    assert.equal(watch.of(dir).length, 1);
    assert.equal(watch.of(path.join(dir, 'data')).length, 1);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// data/prompts/preambles/: the errand agents' preambles, a subfolder of the
// private layer only, loaded by base name into `hot.prompts.preambles`, live.
// ---------------------------------------------------------------------------

function writePreamble(dir: string, name: string, text: string) {
  const folder = path.join(dir, 'data', 'prompts', 'preambles');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${name}.md`), text);
}

test('createHot: data/prompts/preambles/*.md load by base name into hot.prompts.preambles and reload live', () => {
  const dir = makeRoot({ prompts: { rules: 'base text' } });
  const plainDir = makeRoot();
  const plain = createHot({ rootDir: plainDir });
  try {
    assert.deepEqual(plain.prompts.preambles, {}, 'no folder: an empty set');
  } finally {
    plain.close();
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
  // A tracked prompts/preambles/ is never read: the files are deployment-only.
  fs.mkdirSync(path.join(dir, 'prompts', 'preambles'));
  fs.writeFileSync(path.join(dir, 'prompts', 'preambles', 'all.md'), 'tracked');
  writePreamble(dir, 'all', '\uFEFFΚοινό.\r\n');
  writePreamble(dir, '@moonshotai-kimi-k3', 'Για το μοντέλο.');
  writePreamble(dir, 'scout', '');
  fs.writeFileSync(path.join(dir, 'data', 'prompts', 'preambles', 'notes.txt'), 'not a prompt');
  const hot = createHot({ rootDir: dir });
  try {
    assert.deepEqual(hot.prompts.preambles, { all: 'Κοινό.', '@moonshotai-kimi-k3': 'Για το μοντέλο.', scout: '' });
    assert.equal(hot.prompts.rules, 'base text');
    const before = hot.hashes.promptsHash;

    writePreamble(dir, 'scout', 'Ιστός.');
    fs.rmSync(path.join(dir, 'data', 'prompts', 'preambles', '@moonshotai-kimi-k3.md'));
    writePreamble(dir, 'all', ''); // emptied: '' at once, no keep-the-previous guard
    assert.equal(hot.reloadPrompts(), true);
    assert.deepEqual(hot.prompts.preambles, { all: '', scout: 'Ιστός.' });
    assert.notEqual(hot.hashes.promptsHash, before, 'the preambles count in the prompts hash');

    fs.rmSync(path.join(dir, 'data', 'prompts', 'preambles'), { recursive: true, force: true });
    hot.reloadPrompts();
    assert.deepEqual(hot.prompts.preambles, {}, 'the folder removed: none left');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch: data/prompts/preambles/ gets a watcher of its own; created, edited and removed, it reloads', async () => {
  const dir = makeRoot();
  writeLocalPrompt(dir, 'rules', 'local text');
  const localDir = path.join(dir, 'data', 'prompts');
  const preamblesDir = path.join(localDir, 'preambles');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: wrongly(watch) }).watch();
  try {
    assert.equal(watch.of(preamblesDir).length, 0, 'no folder: no watcher');
    const [local] = watch.of(localDir);

    writePreamble(dir, 'all', 'first');
    local.listener('rename', 'preambles');
    assert.equal(watch.of(preamblesDir).length, 1, 'the new folder is watched');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(hot.prompts.preambles.all, 'first');

    writePreamble(dir, 'all', 'second');
    watch.of(preamblesDir)[0].listener('change', 'all.md');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(hot.prompts.preambles.all, 'second', 'an edit inside the folder reloads');

    fs.rmSync(preamblesDir, { recursive: true, force: true });
    local.listener('rename', 'preambles');
    assert.equal(watch.of(preamblesDir)[0].closed, true, "the removed folder's watcher is closed");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(hot.prompts.preambles, {});

    writePreamble(dir, 'scout', 'again');
    local.listener('rename', 'preambles');
    assert.equal(watch.of(preamblesDir).length, 2);
    hot.close();
    assert.equal(watch.of(preamblesDir)[1].closed, true, 'close() closes it too');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch: a preambles/ folder present at start is watched; an error frees its watcher', async () => {
  const dir = makeRoot();
  writePreamble(dir, 'all', 'text');
  const preamblesDir = path.join(dir, 'data', 'prompts', 'preambles');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: wrongly(watch) }).watch();
  try {
    const [first] = watch.of(preamblesDir);
    assert.ok(first);
    await withCapturedLogs(() => first.emit('error', new Error('EPERM')));
    assert.equal(first.closed, true);
    watch.of(path.join(dir, 'data', 'prompts'))[0].listener('rename', 'preambles');
    assert.equal(watch.of(preamblesDir).length, 2, 'the next event on data/prompts/ starts a new one');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: an emptied preamble file composes to nothing at once, while an emptied top-level prompt keeps its text', () => {
  const dir = makeRoot();
  writeLocalPrompt(dir, 'rules', 'local rules');
  writePreamble(dir, 'scout', 'Ιστός.');
  const hot = createHot({ rootDir: dir });
  const scoutPreamble = () => composePreamble({ prompts: wrongly(hot.prompts), agent: 'scout', model: null }).text;
  try {
    assert.equal(scoutPreamble(), 'Ιστός.');
    writePreamble(dir, 'scout', 'Ιστός, δεύτερο.');
    assert.equal(hot.reloadPrompts(), true);
    assert.equal(scoutPreamble(), 'Ιστός, δεύτερο.');

    writePreamble(dir, 'scout', '');
    writeLocalPrompt(dir, 'rules', ''); // half-written top-level file: the guard stays
    assert.equal(hot.reloadPrompts(), true);
    assert.equal(scoutPreamble(), '', 'an empty preamble file is nothing');
    assert.equal(hot.prompts.rules, 'local rules');

    writePreamble(dir, 'scout', 'Ιστός.');
    hot.reloadPrompts();
    writePreamble(dir, 'scout', '  \n\t\n');
    hot.reloadPrompts();
    assert.equal(scoutPreamble(), '', 'whitespace only is nothing');

    writePreamble(dir, 'scout', 'Ιστός.');
    hot.reloadPrompts();
    fs.rmSync(path.join(dir, 'data', 'prompts', 'preambles', 'scout.md'));
    hot.reloadPrompts();
    assert.equal(scoutPreamble(), '', 'a deleted file is nothing');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: data/prompts/agents.md is not a preamble and draws no warning', async () => {
  const dir = makeRoot();
  writeLocalPrompt(dir, 'agents', 'OLD-PREAMBLE-TEXT');
  let hot = wrongly<Hot>(undefined);
  try {
    const { logs } = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
      hot.reloadPrompts();
    });
    assert.deepEqual(present(hot).prompts.preambles, {});
    assert.equal(
      composePreamble({
        prompts: wrongly(present(hot).prompts),
        agent: 'scout',
        model: null,
      }).text,
      ''
    );
    assert.ok(!logs.some((entry) => entry.level === 'warn'), 'no warning about it');
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
