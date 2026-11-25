// The split of a flat labels file in the prompt layers of the scripts (scripts/lib/prompt-layers.ts): `splitLabels`
// sorts a flat file, such as a deployment's old `prompts.local/labels.json`, by the tracked split of
// `config/labels.json` into `model` and `owner`. The tests assert on keys and on the strings they put in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinLabels } from '../../../src/config/labels.ts';
import type { LabelsFile } from '../../../src/config/labels.ts';
import {
  splitLabels,
  overlayPromptsHot,
  diaryPromptLayers,
  promptLayersHot,
} from '../../../scripts/lib/prompt-layers.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createHot } from '../../../src/hot.ts';
import { deepMerge } from '../../../src/config.ts';
import { parseArgs } from '../../../scripts/lib/replay-args.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { asRecord } from '../../fixtures/records.ts';
import '../../../src/tools/operations/index.ts';

const SPLIT: LabelsFile = {
  model: { transcript: { gap: 'G {duration}', edited: 'E' }, locale: 'xx-XX' },
  owner: { status: { probe: 'P', costs: { keyLead: 'K' } } },
};

test('splits a flat file by the tracked split: a key the tracked file holds under owner goes to owner', () => {
  const flat = { transcript: { gap: 'mine' }, status: { costs: { keyLead: 'my lead' } } };
  assert.deepEqual(splitLabels(flat, SPLIT), {
    model: { transcript: { gap: 'mine' } },
    owner: { status: { costs: { keyLead: 'my lead' } } },
  });
});

test('splits a key the tracked file does not know into model', () => {
  const flat = { custom: { thing: 'only here' }, status: { inner: { extra: 'new line' } } };
  assert.deepEqual(splitLabels(flat, SPLIT), {
    model: { custom: { thing: 'only here' }, status: { inner: { extra: 'new line' } } },
    owner: {},
  });
});

test('gives back the flat file when a split is joined again', () => {
  const flat = { transcript: { gap: 'mine', edited: 'e' }, status: { probe: 'p', costs: { keyLead: 'k' } } };
  assert.deepEqual(joinLabels(splitLabels(flat, SPLIT)), flat);
});

// ---- prompt layers: --prompts ------------------------------------

test('replay --skills --prompts: the directory is laid over a copy of data/prompts/; a file in it replaces, labels.json merges; nothing live changes', () => {
  const root = tempDir('nep-replay-skills-');
  const tmpDir = tempDir('nep-replay-skills-layers-');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  // PR 7c: the tracked settings and labels live in config/, the labels under `model`.
  write('config/config.json', JSON.stringify({ tools: { safeMode: false } }));
  write('prompts/turn/reply.md', 'tracked reply');
  write('prompts/format.md', 'tracked format');
  write(
    'config/labels.json',
    JSON.stringify({ model: { transcript: { author: '{name}' }, task: { queued: 'tracked queued' } }, owner: {} })
  );
  const localLabels = JSON.stringify({ task: { queued: 'local queued', queuedOthers: 'local others' } });
  write('data/prompts/turn/reply.md', 'local réply');
  write('data/prompts/format.md', 'local format');
  write('data/prompts/labels.json', localLabels);
  write('side-a/turn/reply.md', 'réply A');
  write('side-a/labels.json', JSON.stringify({ task: { queued: 'queued A' } }));
  write('side-b/format.md', 'format B');
  const opened = [];
  try {
    const a = overlayPromptsHot(createHot, root, 'side-a', { mergeJson: deepMerge, tmpDir });
    opened.push(a);
    assert.equal(asRecord(a.hot).prompts['turn/reply'], 'réply A', 'a file of the directory replaces the private one');
    assert.equal(asRecord(a.hot).prompts.format, 'local format', 'a file it lacks stays the private one');
    assert.deepEqual(
      asRecord(a.hot).prompts.labels.task,
      { queued: 'queued A', queuedOthers: 'local others' },
      'labels.json merges over the private one'
    );
    const aLabels = asRecord(a.hot).prompts.labels;
    assert.equal(aLabels.transcript.author, '{name}', 'and over the tracked one, as hot.js merges');
    const b = overlayPromptsHot(createHot, root, 'side-b', { mergeJson: deepMerge, tmpDir });
    opened.push(b);
    const bLabels = asRecord(b.hot).prompts.labels;
    assert.deepEqual(
      [asRecord(b.hot).prompts['turn/reply'], asRecord(b.hot).prompts.format, bLabels.task.queued],
      ['local réply', 'format B', 'local queued']
    );
    // The diary's --prompts keeps its layering: a labels.json of the directory replaces the private one whole.
    const diary = overlayPromptsHot(createHot, root, 'side-a', { tmpDir });
    opened.push(diary);
    assert.deepEqual(asRecord(diary.hot).prompts.labels.task, { queued: 'queued A' });
    // The live layer is untouched.
    assert.equal(fs.readFileSync(path.join(root, 'data', 'prompts', 'labels.json'), 'utf8'), localLabels);
    assert.equal(fs.readFileSync(path.join(root, 'data', 'prompts', 'turn', 'reply.md'), 'utf8'), 'local réply');
    assert.throws(
      () => overlayPromptsHot(createHot, root, 'missing', { mergeJson: deepMerge, tmpDir }),
      /missing is not a directory/
    );
  } finally {
    for (const side of opened) {
      asRecord(side.hot).close();
      fs.rmSync(side.dir, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // The flag goes with --skills.
  assert.equal(parseArgs(['--skills', 's.json', '--prompts', 'cand']).prompts, 'cand');
});

/** A link at `link` to the directory `target`: a symlink, else (Windows without the privilege) a junction; null when neither can be made. */
function linkDir(target: string, link: string) {
  for (const type of process.platform === 'win32' ? ['dir', 'junction'] : ['dir']) {
    try {
      fs.symlinkSync(target, link, type as unknown as Parameters<typeof fs.symlinkSync>[2]);
      return type;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(asRecord(err)?.code)) throw err;
    }
  }
  return null;
}

test('replay --skills --prompts: a data/prompts/ that links to the live layer is read through the link and copied; nothing is linked into or written to it', (t) => {
  const root = tempDir('nep-replay-skills-');
  const live = tempDir('nep-replay-skills-live-');
  const tmpDir = tempDir('nep-replay-skills-layers-');
  const opened = [];
  try {
    // The same read-only layer-copy control uses the canonical persona prompt location.
    fs.mkdirSync(path.join(root, 'data'));
    if (!linkDir(live, path.join(root, 'data', 'prompts'))) {
      t.skip('this platform makes no directory link without privileges');
      return;
    }
    const write = (dir: string, rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    // PR 7c: the tracked settings and labels live in config/, the labels under `model`.
    write(root, 'config/config.json', JSON.stringify({ tools: { safeMode: false } }));
    write(root, 'prompts/turn/reply.md', 'tracked reply');
    write(root, 'config/labels.json', JSON.stringify({ model: { task: { queued: 'tracked queued' } }, owner: {} }));
    const liveLabels = JSON.stringify({ task: { queued: 'live queued', queuedOthers: 'live others' } });
    write(live, 'turn/reply.md', 'live réply');
    write(live, 'labels.json', liveLabels);
    write(root, 'side-a/labels.json', JSON.stringify({ task: { queued: 'queued A' } }));
    write(root, 'side-a/format.md', 'format A');
    const listing = () => fs.readdirSync(live).sort();
    const before = listing();
    for (const mergeJson of [deepMerge, null]) {
      const side = overlayPromptsHot(createHot, root, 'side-a', { mergeJson, tmpDir });
      opened.push(side);
      assert.equal(asRecord(side.hot).prompts['turn/reply'], 'live réply', 'the live layer is read through the link');
      assert.equal(asRecord(side.hot).prompts.format, 'format A');
      assert.deepEqual(
        asRecord(side.hot).prompts.labels.task,
        mergeJson ? { queued: 'queued A', queuedOthers: 'live others' } : { queued: 'queued A' }
      );
      const local = path.join(side.dir, 'data', 'prompts');
      assert.equal(fs.lstatSync(local).isSymbolicLink(), false, 'the scratch layer is a copy, not a link');
      for (const name of fs.readdirSync(local))
        assert.equal(fs.lstatSync(path.join(local, name)).isSymbolicLink(), false, name);
    }
    assert.deepEqual(listing(), before, 'nothing is added to the live layer');
    assert.equal(fs.readFileSync(path.join(live, 'labels.json'), 'utf8'), liveLabels);
    assert.equal(fs.readFileSync(path.join(live, 'turn', 'reply.md'), 'utf8'), 'live réply');
  } finally {
    for (const side of opened) {
      asRecord(side.hot).close();
      fs.rmSync(side.dir, { recursive: true, force: true });
    }
    // The link first, so removing the root never reaches into the live directory.
    const link = path.join(root, 'data', 'prompts');
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    for (const dir of [root, live, tmpDir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

const quietHot = createHot;

// never watched: createHot watches only on .watch()

/** A scratch checkout: config.json, prompts/ with two files and labels, data/prompts/ with one. */
function scratchRoot() {
  const root = tempDir('nep-replay-test-');
  // PR 7c: the tracked settings live in config/config.json.
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'config.json'),
    JSON.stringify({ features: { diary: true }, bot: { timezone: '42' } })
  );
  fs.mkdirSync(path.join(root, 'prompts', 'turn'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prompts', 'turn', 'reply.md'), 'tracked reply');
  fs.writeFileSync(path.join(root, 'prompts', 'diary-planner.md'), 'tracked plan');
  // PR 7c: the tracked labels live in config/labels.json under `model`.
  fs.writeFileSync(
    path.join(root, 'config', 'labels.json'),
    JSON.stringify({ model: { diary: { topic: 'Topic' } }, owner: {} })
  );
  // Replay layers read the prepared persona tree, separate from tracked engine prompts.
  fs.mkdirSync(path.join(root, 'data', 'prompts', 'turn'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'prompts', 'turn', 'reply.md'), 'local réply');
  fs.mkdirSync(path.join(root, 'candidate'));
  fs.writeFileSync(path.join(root, 'candidate', 'diary-planner.md'), 'candidate plan');
  return root;
}

test('replay: --prompts layering is one helper shared by the diary and the turn replay', () => {
  const root = scratchRoot();
  const tmpDir = tempDir('nep-replay-layers-');
  try {
    // --diary: the directory over data/prompts/, which stays under it.
    const layers = diaryPromptLayers(root, 'candidate');
    assert.deepEqual(layers, [path.join(root, 'data', 'prompts'), 'candidate']);
    const diary = promptLayersHot(quietHot, root, layers, { tmpDir });
    assert.equal(asRecord(diary.hot).prompts['turn/reply'], 'local réply');
    assert.equal(asRecord(diary.hot).prompts['diary-planner'], 'candidate plan');
    const diaryLabels = asRecord(diary.hot).prompts.labels;
    assert.equal(diaryLabels.diary.topic, 'Topic');
    asRecord(diary.hot).close();
    // A lone directory is data/prompts/ (the other layers do not show through).
    const side = promptLayersHot(quietHot, root, ['candidate'], { tmpDir });
    assert.equal(asRecord(side.hot).prompts['turn/reply'], 'tracked reply');
    assert.equal(asRecord(side.hot).prompts['diary-planner'], 'candidate plan');
    asRecord(side.hot).close();
    // No data/prompts/ in the checkout: the diary layers are the directory alone.
    fs.rmSync(path.join(root, 'data', 'prompts'), { recursive: true });
    assert.deepEqual(diaryPromptLayers(root, 'candidate'), ['candidate']);
    assert.throws(() => promptLayersHot(quietHot, root, ['missing'], { tmpDir }), /missing is not a directory/);
    // The checkout is untouched.
    // PR 7c: the tracked labels live in config/, beside prompts/.
    // Changed: the reply prompt sits in the folder `turn/`, so the checkout's prompts/ lists the folder.
    assert.deepEqual(fs.readdirSync(path.join(root, 'prompts')).sort(), ['diary-planner.md', 'turn']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  // One implementation: the replay modules call the lib helper and keep no copy of their own.
  const lib = new URL('../../../scripts/lib/', import.meta.url);
  const modules = fs.readdirSync(lib).filter((name) => /^replay-.*\.ts$/.test(name) || name === 'turn-run.ts');
  const source = modules.map((name) => fs.readFileSync(new URL(name, lib), 'utf8')).join('\n');
  assert.ok(source.includes("from './prompt-layers.ts'"));
  // The shared module owns the overlay wrapper, so its call is the one dispatch path.
  // Changed: the count was 2 while --pair called the helper itself; --pair is removed, so --diary's call is the one left.
  const shared = fs.readFileSync(new URL('../../../scripts/lib/prompt-layers.ts', import.meta.url), 'utf8');
  assert.equal(
    (source.match(/promptLayersHot\(/g) ?? []).length + (shared.match(/return promptLayersHot\(/g) ?? []).length,
    1,
    'one call for --diary'
  );
  assert.ok(!/function sideHot\b/.test(source));
  assert.ok(!/fs\.cpSync\(/.test(source), 'no prompt copying outside the helper');
});

test('replay: explicit data selection supplies canonical config and prompts to a diary layer and a lone directory', () => {
  const root = scratchRoot();
  const privateDir = tempDir('nep-replay-private-');
  const tmpDir = tempDir('nep-replay-layers-');
  const env = { NEPTUNIA_DATA_DIR: privateDir };
  try {
    // The checkout keeps a stale local layer; the live one is in the private directory.
    fs.writeFileSync(
      path.join(root, 'data', 'config', 'config.json'),
      JSON.stringify({ bot: { timezone: 'checkout' } })
    );
    fs.mkdirSync(path.join(privateDir, 'config'));
    fs.writeFileSync(path.join(privateDir, 'config', 'config.json'), JSON.stringify({ bot: { timezone: 'private' } }));
    fs.mkdirSync(path.join(privateDir, 'prompts', 'turn'), { recursive: true });
    fs.writeFileSync(path.join(privateDir, 'prompts', 'turn', 'reply.md'), 'private reply');

    const layers = diaryPromptLayers(root, 'candidate', env);
    assert.deepEqual(layers, [path.join(privateDir, 'prompts'), 'candidate']);
    const diary = promptLayersHot(quietHot, root, layers, { tmpDir, env });
    assert.equal(asRecord(diary.hot).prompts['turn/reply'], 'private reply', 'the checkout data/prompts/ is not read');
    assert.equal(asRecord(diary.hot).prompts['diary-planner'], 'candidate plan');
    assert.equal(asRecord(diary.hot).config.bot.timezone, 'private');
    asRecord(diary.hot).close();
    const side = promptLayersHot(quietHot, root, ['candidate'], { tmpDir, env });
    assert.equal(asRecord(side.hot).config.bot.timezone, 'private');
    assert.equal(asRecord(side.hot).prompts['turn/reply'], 'tracked reply');
    asRecord(side.hot).close();
    // No data/prompts/ in the private directory: the checkout's is not taken instead.
    fs.rmSync(path.join(privateDir, 'prompts'), { recursive: true });
    assert.deepEqual(diaryPromptLayers(root, 'candidate', env), ['candidate']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(privateDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
