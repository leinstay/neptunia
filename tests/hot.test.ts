// Tests for src/hot.ts: the live config/prompts view. Never depends on
// fs.watch timing. Personal fixtures use root/data, matching the canonical runtime contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHot, promptsInFolder, retiredPromptFiles } from '../src/hot.ts';
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

test('createHot: prompts strip a UTF-8 BOM and normalize CRLF to LF, trimming edges', () => {
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
  // fs.watch takes its options before the listener when it is given some.
  const watch = (target: Record<string, Untyped>, ...rest: Array<unknown>) => {
    const listener = rest.at(-1);
    const options = rest.length > 1 ? rest[0] : {};
    const watcher: Record<string, Untyped> = new EventEmitter();
    Object.assign(watcher, { target, listener, options, closed: false });
    watcher.close = () => {
      watcher.closed = true;
    };
    handed.push(watcher);
    return watcher;
  };
  watch.of = (target: Untyped): Array<Record<string, Untyped>> => handed.filter((w) => w.target === target);
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

test('createHot: a config that still sets models.errands warns once, naming the key and never its value', async () => {
  // Catches: the agents' old model setting stays in a live config unread and unreported, so the owner believes it
  // still picks the agent's model.
  const dir = makeRoot(wrongly({ config: { models: { errands: { scout: 'x/old-agent-model' } } } }));
  const retired = (logs: Record<string, Untyped>) =>
    logs.filter((entry: Record<string, Untyped>) => entry.msg === 'config: models.errands is no longer read');
  let hot = wrongly<Hot>(undefined);
  try {
    const started = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
      hot.reloadConfig();
    });
    assert.equal(retired(started.logs).length, 1);
    assert.equal(retired(started.logs)[0].use, 'models.agents.model');
    assert.ok(!JSON.stringify(started.logs).includes('x/old-agent-model'), 'the key, never its value');
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a chain under a retired humanizer role warns once per role with the role that replaces it, and the new roles warn nothing', async () => {
  // Catches: the dotted role names `humanizer.linter` and `humanizer.writer` are looked up segment by segment, so a
  // deployment that still holds them is never told, or a chain under the new role `linter` is taken for one of them.
  const chain = [{ via: 'api', key: 'k', model: 'x/old-model', effort: null }];
  const dir = makeRoot(
    wrongly({ config: { models: { routes: { 'humanizer.linter': chain, 'humanizer.writer': chain } } } })
  );
  const retired = (logs: Record<string, Untyped>) =>
    logs.filter((entry: Record<string, Untyped>) => /^config: models\.routes\.humanizer/.test(String(entry.msg)));
  let hot = wrongly<Hot>(undefined);
  try {
    const started = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
      hot.reloadConfig();
    });
    assert.deepEqual(
      retired(started.logs).map((entry: Record<string, Untyped>) => [entry.msg, entry.use]),
      [
        ['config: models.routes.humanizer.linter is no longer read', 'models.routes.linter'],
        ['config: models.routes.humanizer.writer is no longer read', 'models.routes.editor'],
      ]
    );
    assert.ok(!JSON.stringify(started.logs).includes('x/old-model'), 'the key, never its value');

    const renamed = { models: { routes: { linter: chain, editor: chain } } };
    const clean = makeRoot(wrongly({ config: renamed }));
    const quiet = await withCapturedLogs(() => createHot({ rootDir: clean }).close());
    assert.equal(retired(quiet.logs).length, 0);
    fs.rmSync(clean, { recursive: true, force: true });
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a chain under the retired role search warns once with the analyzer as its use', async () => {
  // Catches: a deployment keeps `models.routes.search`, nothing reads it, and the owner believes quick search runs there.
  const chain = [{ via: 'api', key: 'k', model: 'x/old-model', effort: null }];
  const dir = makeRoot(wrongly({ config: { models: { routes: { search: chain } } } }));
  let hot = wrongly<Hot>(undefined);
  try {
    const started = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
      hot.reloadConfig();
    });
    assert.deepEqual(
      started.logs
        .filter((entry: Record<string, Untyped>) => /^config: models\.routes\.search/.test(String(entry.msg)))
        .map((entry: Record<string, Untyped>) => [entry.msg, entry.use]),
      [['config: models.routes.search is no longer read', 'models.routes.analyzer']]
    );
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: an agent entry that still sets its socket warns once, whatever agent it names', async () => {
  // Catches: a deployment keeps `agents.<name>.socket` from the per-agent units, nothing reads it, and the owner believes
  // the runner listens there.
  const dir = makeRoot(wrongly({ config: { agents: { mine: { socket: '/run/old/sock' } } } }));
  const retired = (logs: Record<string, Untyped>) =>
    logs.filter((entry: Record<string, Untyped>) => entry.msg === 'config: agents.mine.socket is no longer read');
  let hot = wrongly<Hot>(undefined);
  try {
    const started = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
      hot.reloadConfig();
    });
    assert.equal(retired(started.logs).length, 1);
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
// data/prompts/preambles/: the errand agents' preambles, prompt files like any
// other, keyed `preambles/<name>`, read through promptsInFolder.
// ---------------------------------------------------------------------------

function writePreamble(dir: string, name: string, text: string) {
  const folder = path.join(dir, 'data', 'prompts', 'preambles');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${name}.md`), text);
}

/** The preamble of a run of `agent` on `model` as the errand client composes it from `hot`. */
function preambleOf(hot: Hot, agent: string, model: string | null) {
  return composePreamble({ preambles: promptsInFolder(hot.prompts, 'preambles'), agent, model }).text;
}

test('createHot: a preamble file loads under preambles/<name> and reaches its reader through promptsInFolder', () => {
  const dir = makeRoot();
  writePreamble(dir, 'all', 'shared');
  writePreamble(dir, '@claude-sonnet-4.6', 'for the model');
  writeAt(path.join(dir, 'data', 'prompts'), 'preambles/old/scout', 'one folder deeper');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts['preambles/@claude-sonnet-4.6'], 'for the model');
    assert.deepEqual(promptsInFolder(hot.prompts, 'preambles'), {
      all: 'shared',
      '@claude-sonnet-4.6': 'for the model',
    });
    assert.equal(preambleOf(hot, 'scout', 'openrouter/anthropic/claude-sonnet-4.6'), 'shared\n\nfor the model');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: a deleted preamble file is gone after a reload', () => {
  const dir = makeRoot();
  writePreamble(dir, 'all', 'shared');
  writePreamble(dir, 'scout', 'for scout');
  const hot = createHot({ rootDir: dir });
  try {
    fs.rmSync(path.join(dir, 'data', 'prompts', 'preambles', 'scout.md'));
    assert.equal(hot.reloadPrompts(), true);
    assert.equal(preambleOf(hot, 'scout', null), 'shared');
    assert.equal(Object.hasOwn(hot.prompts, 'preambles/scout'), false);
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
    assert.deepEqual(promptsInFolder(present(hot).prompts, 'preambles'), {});
    assert.equal(preambleOf(present(hot), 'scout', null), '');
    assert.ok(!logs.some((entry) => entry.level === 'warn'), 'no warning about it');
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Prompt files in folders: a `.md` file at any depth is one prompt keyed by its
// relative path, `/` between the parts.
// ---------------------------------------------------------------------------

/** Write `<root>/<key>.md`, making its folders. */
function writeAt(root: string, key: string, text: string) {
  const file = path.join(root, `${key}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('createHot: a tracked file in a nested folder loads under its relative path', () => {
  const dir = makeRoot({ prompts: { reply: 'root text' } });
  writeAt(path.join(dir, 'prompts'), 'diary/kinds/status', 'nested text');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts['diary/kinds/status'], 'nested text');
    assert.equal(hot.prompts.reply, 'root text');
    assert.equal(hot.promptSources['diary/kinds/status'], 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a deployment file replaces the nested tracked file of the same path and leaves its neighbours', () => {
  const dir = makeRoot();
  const tracked = path.join(dir, 'prompts');
  writeAt(tracked, 'heartbeat/seeds/a', 'tracked a');
  writeAt(tracked, 'heartbeat/seeds/b', 'tracked b');
  writeAt(path.join(dir, 'data', 'prompts'), 'heartbeat/seeds/a', 'local a');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts['heartbeat/seeds/a'], 'local a');
    assert.equal(hot.promptSources['heartbeat/seeds/a'], 'local');
    assert.equal(hot.prompts['heartbeat/seeds/b'], 'tracked b');
    assert.equal(hot.promptSources['heartbeat/seeds/b'], 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a nested deployment file with no tracked twin loads', () => {
  const dir = makeRoot();
  writeAt(path.join(dir, 'data', 'prompts'), 'diary/kinds/dream', 'local only');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts['diary/kinds/dream'], 'local only');
    assert.equal(hot.promptSources['diary/kinds/dream'], 'local');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: an emptied nested deployment file falls back to the tracked file of the same path', () => {
  const dir = makeRoot();
  writeAt(path.join(dir, 'prompts'), 'diary/kinds/status', 'tracked');
  writeAt(path.join(dir, 'data', 'prompts'), 'diary/kinds/status', '  \n');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts['diary/kinds/status'], 'tracked');
    assert.equal(hot.promptSources['diary/kinds/status'], 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch: both prompt folders are watched recursively, and a nested file changed after the start reloads', async () => {
  const dir = makeRoot();
  writeAt(path.join(dir, 'prompts'), 'diary/kinds/status', 'first');
  writeLocalPrompt(dir, 'rules', 'local text');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: wrongly(watch) }).watch();
  try {
    const [base] = watch.of(path.join(dir, 'prompts'));
    const [local] = watch.of(path.join(dir, 'data', 'prompts'));
    assert.equal(base.options.recursive, true);
    assert.equal(local.options.recursive, true);

    writeAt(path.join(dir, 'prompts'), 'diary/kinds/status', 'second');
    base.listener('change', path.join('diary', 'kinds', 'status.md'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(hot.prompts['diary/kinds/status'], 'second');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch: a folder created after the start reloads on its own event', async () => {
  const dir = makeRoot();
  writeLocalPrompt(dir, 'rules', 'local text');
  const watch = fakeWatch();
  const hot = createHot({ rootDir: dir, watchImpl: wrongly(watch) }).watch();
  try {
    const [local] = watch.of(path.join(dir, 'data', 'prompts'));
    writeAt(path.join(dir, 'data', 'prompts'), 'heartbeat/seeds/a', 'moved in');
    local.listener('rename', 'heartbeat');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(hot.prompts['heartbeat/seeds/a'], 'moved in');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The warnings of `logs` about a deployment prompt file under a retired key. */
const retiredPromptWarnings = (logs: Array<Record<string, Untyped>>) =>
  logs.filter((entry) => entry.level === 'warn' && entry.msg === 'prompts: a file is no longer read');

test('createHot: a deployment file under a retired key warns once with its path and the new one, and is not read', async () => {
  // Catches: a deployment's own character card left at its old path, loaded under a key nobody reads, so the persona
  // runs on the tracked text with no word to the owner.
  const dir = makeRoot({ prompts: { persona: 'tracked card' } });
  writeLocalPrompt(dir, 'character-card', 'own card');
  let hot = wrongly<Hot>(undefined);
  try {
    const { logs } = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
      hot.reloadPrompts();
    });
    assert.deepEqual(
      retiredPromptWarnings(logs).map((entry) => [String(entry.file), String(entry.use)]),
      [['character-card.md', 'persona.md']]
    );
    assert.equal(hot.prompts.persona, 'tracked card');
    assert.equal(Object.hasOwn(hot.prompts, 'character-card'), false, 'the old path is not read');
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a deployment file under a key that moved into a folder warns with the folder path', async () => {
  const dir = makeRoot();
  writeLocalPrompt(dir, 'humanizer-linter', 'own linter');
  let hot = wrongly<Hot>(undefined);
  try {
    const { logs } = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
    });
    assert.deepEqual(
      retiredPromptWarnings(logs).map((entry) => [String(entry.file), String(entry.use)]),
      [['humanizer-linter.md', 'humanizer/linter.md']]
    );
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a deployment file under the new key replaces the tracked one and warns nothing', async () => {
  const dir = makeRoot({ prompts: { persona: 'tracked card' } });
  writeLocalPrompt(dir, 'persona', 'own card');
  let hot = wrongly<Hot>(undefined);
  try {
    const { logs } = await withCapturedLogs(() => {
      hot = createHot({ rootDir: dir });
    });
    assert.equal(hot.prompts.persona, 'own card');
    assert.deepEqual(retiredPromptWarnings(logs), []);
  } finally {
    hot?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retiredPromptFiles: names each deployment file under a retired key with the path that replaces it', () => {
  const dir = makeRoot();
  writeLocalPrompt(dir, 'character-card', 'own card');
  writeLocalPrompt(dir, 'persona', 'own card');
  try {
    assert.deepEqual(retiredPromptFiles(path.join(dir, 'data', 'prompts')), [
      { file: 'character-card.md', use: 'persona.md' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retiredPromptFiles: a deployment's diary.md points at diary/task.md and its diary-seeds.md at one file per family", () => {
  // Bug: the warning names a seeds file that does not exist, so a deployment copies its whole seeds file to one path.
  const dir = makeRoot();
  writeLocalPrompt(dir, 'diary', 'own diary');
  writeLocalPrompt(dir, 'diary-seeds', '# place\na pier');
  try {
    assert.deepEqual(
      retiredPromptFiles(path.join(dir, 'data', 'prompts')).sort((a, b) => a.file.localeCompare(b.file)),
      [
        { file: 'diary-seeds.md', use: 'diary/seeds/<family>.md' },
        { file: 'diary.md', use: 'diary/task.md' },
      ]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
