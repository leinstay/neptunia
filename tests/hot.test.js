// Tests for src/hot.js: the live config/prompts view. Never depends on
// fs.watch timing -- reload methods are called directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHot } from '../src/hot.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

function makeRoot({ config = { bot: { timezone: 'UTC' } }, prompts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-hot-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, 'prompts'));
  for (const [name, text] of Object.entries(prompts)) {
    fs.writeFileSync(path.join(dir, 'prompts', `${name}.md`), text);
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
  const dir = makeRoot({ config: { a: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: 2 }));
    const ok = hot.reloadConfig();
    assert.equal(ok, true);
    assert.deepEqual(hot.config, { a: 2 });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadConfig: keeps the previous config on invalid JSON and returns false', () => {
  const dir = makeRoot({ config: { a: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json');
    const ok = hot.reloadConfig();
    assert.equal(ok, false);
    assert.deepEqual(hot.config, { a: 1 });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadConfig: config.local.json is merged in on reload too', () => {
  const dir = makeRoot({ config: { a: 1, b: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ b: 2 }));
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
  const dir = makeRoot({ config: { a: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    let seen = null;
    hot.on('change', (payload) => { seen = payload; });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: 2 }));
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
    hot.on('change', (payload) => { seen = payload; });
    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), 'b');
    hot.reloadPrompts();
    assert.deepEqual(seen, { what: 'prompts' });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: does not emit "change" when reloadConfig fails', () => {
  const dir = makeRoot({ config: { a: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    let emitted = false;
    hot.on('change', () => { emitted = true; });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ bad json');
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
// Two prompt layers: prompts/ (base, tracked) + prompts.local/ (untracked)
// ---------------------------------------------------------------------------

function writeLocalPrompt(dir, name, text) {
  const localDir = path.join(dir, 'prompts.local');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, `${name}.md`), text);
}

function writeLabels(dir, layer, value) {
  const target = layer === 'base' ? path.join(dir, 'prompts') : path.join(dir, 'prompts.local');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'labels.json'), value);
}

test('createHot: a prompts.local file replaces the base file of the same name', () => {
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
    fs.rmSync(path.join(dir, 'prompts.local', 'rules.md'));
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
// prompts.local/ deleted and recreated while running (an rsync of the
// directory): its watcher is dropped and a new one starts. A fake fs.watch
// stands in, so no test depends on real watcher timing.
// ---------------------------------------------------------------------------

/** A fake fs.watch: every watcher it hands out records its target and listener, emits, and records close(). */
function fakeWatch() {
  const handed = [];
  const watch = (target, listener) => {
    const watcher = new EventEmitter();
    Object.assign(watcher, { target, listener, closed: false });
    watcher.close = () => {
      watcher.closed = true;
    };
    handed.push(watcher);
    return watcher;
  };
  watch.of = (target) => handed.filter((w) => w.target === target);
  return watch;
}

test('watch: a prompts.local/ deleted and recreated is watched again', () => {
  const dir = makeRoot({ prompts: { rules: 'base text' } });
  writeLocalPrompt(dir, 'rules', 'local text');
  const localDir = path.join(dir, 'prompts.local');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: watch }).watch();
  try {
    const [root] = watch.of(dir);
    assert.equal(watch.of(localDir).length, 1);

    fs.rmSync(localDir, { recursive: true, force: true });
    root.listener('rename', 'prompts.local');
    assert.equal(watch.of(localDir)[0].closed, true, 'the watcher of the deleted directory is closed');

    writeLocalPrompt(dir, 'rules', 'local again');
    root.listener('rename', 'prompts.local');
    assert.equal(watch.of(localDir).length, 2, 'the recreated directory gets a watcher of its own');
    assert.equal(watch.of(localDir)[1].closed, false);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch: an error on the prompts.local/ watcher frees it, so the next root event starts a new one', async () => {
  const dir = makeRoot({ prompts: { rules: 'base text' } });
  writeLocalPrompt(dir, 'rules', 'local text');
  const localDir = path.join(dir, 'prompts.local');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: watch }).watch();
  try {
    const [root] = watch.of(dir);
    const [first] = watch.of(localDir);
    const { logs } = await withCapturedLogs(() => first.emit('error', new Error('EPERM')));
    assert.ok(logs.some((l) => l.msg === 'hot: watcher error'));
    assert.equal(first.closed, true);

    root.listener('rename', 'prompts.local');
    assert.equal(watch.of(localDir).length, 2);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch: close() closes every watcher, the prompts.local/ one included', () => {
  const dir = makeRoot();
  writeLocalPrompt(dir, 'rules', 'local text');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: watch }).watch();
  hot.close();
  try {
    for (const target of [dir, path.join(dir, 'prompts'), path.join(dir, 'prompts.local')]) {
      assert.equal(watch.of(target)[0].closed, true, target);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a config that still sets memory.voiceModel warns once at startup and once per reload that brings it back; the value stays in the config, unread', async () => {
  const dir = makeRoot({ config: { llm: { model: 'x/voice' }, memory: { voiceModel: 'x/old-voice' } } });
  const retired = (logs) => logs.filter((entry) => entry.msg === 'config: memory.voiceModel is no longer read');
  let hot;
  try {
    const started = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
    });
    assert.equal(retired(started.logs).length, 1);
    assert.equal(retired(started.logs)[0].level, 'warn');
    assert.ok(!JSON.stringify(started.logs).includes('x/old-voice'), 'the key, never its value');

    const reloads = await withCapturedLogs(() => {
      hot.reloadConfig(); // still set: no second warning
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ llm: { model: 'x/voice' }, memory: { voiceModel: null } }));
      hot.reloadConfig(); // gone (null counts as unset)
      fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ memory: { voiceModel: 'x/old-voice' } }));
      hot.reloadConfig(); // back through the local layer
    });
    assert.equal(retired(reloads.logs).length, 1);

    const clean = makeRoot({ config: { llm: { model: 'x/voice' } } });
    const quiet = await withCapturedLogs(() => createHot({ rootDir: clean }).close());
    assert.equal(retired(quiet.logs).length, 0);
    fs.rmSync(clean, { recursive: true, force: true });
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hot: exposes promptsHash and configHash that change when a prompt or the config changes', () => {
  const dir = makeRoot({ config: { a: 1, b: { c: 2 } }, prompts: { persona: 'Είσαι η Ζωή.' } });
  const hot = createHot({ rootDir: dir });
  try {
    const first = hot.hashes;
    assert.match(first.promptsHash, /^[0-9a-f]{16}$/);
    assert.match(first.configHash, /^[0-9a-f]{16}$/);

    // A reload of unchanged files keeps both; the key order of the config does not count.
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ b: { c: 2 }, a: 1 }));
    hot.reloadConfig();
    hot.reloadPrompts();
    assert.deepEqual(hot.hashes, first);

    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), 'Είσαι η Ελένη.');
    hot.reloadPrompts();
    assert.notEqual(hot.hashes.promptsHash, first.promptsHash);
    assert.equal(hot.hashes.configHash, first.configHash);

    const promptsHash = hot.hashes.promptsHash;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: 2, b: { c: 2 } }));
    hot.reloadConfig();
    assert.notEqual(hot.hashes.configHash, first.configHash);
    assert.equal(hot.hashes.promptsHash, promptsHash);

    // A reload that fails keeps the hash of what stays live.
    const configHash = hot.hashes.configHash;
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json');
    hot.reloadConfig();
    assert.equal(hot.hashes.configHash, configHash);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('hot: onReload fires with the layer name', async () => {
  const dir = makeRoot({ config: { a: 1 }, prompts: { persona: 'a' } });
  const hot = createHot({ rootDir: dir });
  try {
    const seen = [];
    const off = hot.onReload((what) => seen.push(what));
    hot.reloadConfig();
    hot.reloadPrompts();
    fs.writeFileSync(path.join(dir, 'config.json'), '{ broken');
    await withCapturedLogs(() => hot.reloadConfig());
    assert.deepEqual(seen, ['config', 'prompts']);
    off();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: 2 }));
    hot.reloadConfig();
    assert.deepEqual(seen, ['config', 'prompts']);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
