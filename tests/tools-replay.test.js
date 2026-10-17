// Tests for the pure parts of tools/replay.mjs's diary mode (the arguments, the turn it runs,
// the dry-run view of hot) and for tools/lib/prompt-layers.mjs, the one prompt layering both
// --pair and --diary use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHot } from '../src/hot.js';
import { diaryTopic } from '../src/behavior/diary.js';
import { createLookup } from '../src/web/lookup.js';
import { createBraveSearch } from '../src/web/brave.js';
import { createExaSearch } from '../src/web/exa.js';
import { parseArgs, diaryTurnParams, diaryPromptLayers, dryRunHot, searchAvailableOf } from '../tools/replay.mjs';
import { promptLayersHot } from '../tools/lib/prompt-layers.mjs';

const quietHot = createHot; // never watched: createHot watches only on .watch()

/** A scratch checkout: config.json, prompts/ with two files and labels, prompts.local/ with one. */
function scratchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-replay-test-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ features: { dryRun: false, diary: true }, bot: { dryRunChannelId: '42' } }));
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(path.join(root, 'prompts', 'reply.md'), 'tracked reply');
  fs.writeFileSync(path.join(root, 'prompts', 'diary-plan.md'), 'tracked plan');
  fs.writeFileSync(path.join(root, 'prompts', 'labels.json'), JSON.stringify({ diary: { topic: 'Topic' } }));
  fs.mkdirSync(path.join(root, 'prompts.local'));
  fs.writeFileSync(path.join(root, 'prompts.local', 'reply.md'), 'local réply');
  fs.mkdirSync(path.join(root, 'candidate'));
  fs.writeFileSync(path.join(root, 'candidate', 'diary-plan.md'), 'candidate plan');
  return root;
}

test('replay: the diary mode builds a diary turn request with the kind forced and dryRun on', () => {
  const args = parseArgs(['--diary', 'picture', '--count', '3', '--topic', '  a walk by the séa  ', '--prompts', 'candidate', '--out', '/tmp/briefs.json', '--spend', '1']);
  assert.equal(args.diary, 'picture');
  assert.equal(args.count, 3);
  assert.equal(args.prompts, 'candidate');
  assert.equal(args.outDir, '/tmp/briefs.json');
  assert.deepEqual(diaryTurnParams(args, { diaryTopic }), { mode: 'diary', diary: { kind: 'picture', topic: 'a walk by the séa', forced: false } });
  // A blank topic is none, as /nep diary post takes it; the count defaults to one brief.
  const bare = parseArgs(['--diary', 'selfPicture', '--topic', '   ']);
  assert.equal(bare.count, 1);
  assert.deepEqual(diaryTurnParams(bare, { diaryTopic }), { mode: 'diary', diary: { kind: 'selfPicture', forced: false } });
  // Only the diary flags go with it; an unknown kind, a reply flag or a positional is refused.
  assert.throws(() => parseArgs(['--diary', 'poem']), /usage/);
  assert.throws(() => parseArgs(['--diary', 'picture', '--split']), /usage/);
  assert.throws(() => parseArgs(['--diary', 'picture', '123456789012345678', '223456789012345678']), /usage/);
  assert.throws(() => parseArgs(['--diary', 'picture', '--count', '51']), /usage/);
  assert.throws(() => parseArgs(['123456789012345678', '223456789012345678', '--topic', 'x']), /usage/);
  assert.throws(() => parseArgs(['--pair', 'a', 'b', '--prompts', 'c', '123456789012345678', '223456789012345678']), /usage/);

  // hot as the turn sees it: dry run on, mirroring nothing, the rest read live at use.
  const root = scratchRoot();
  const hot = quietHot({ rootDir: root });
  try {
    const view = dryRunHot(hot);
    assert.equal(view.config.features.dryRun, true);
    assert.equal(view.config.features.diary, true);
    assert.equal(view.config.bot.dryRunChannelId, '');
    assert.equal(hot.config.features.dryRun, false, 'the real config is untouched');
    hot.config = { ...hot.config, diary: { channelId: '7' } };
    assert.equal(view.config.diary.channelId, '7', 'read at use');
    assert.equal(view.prompts.reply, 'local réply');
    assert.equal(typeof view.onReload, 'function');
  } finally {
    hot.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replay: --prompts layering is one helper shared by pair and diary', () => {
  const root = scratchRoot();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-replay-layers-'));
  try {
    // --diary: the directory over prompts.local/, which stays under it.
    const layers = diaryPromptLayers(root, 'candidate');
    assert.deepEqual(layers, ['prompts.local', 'candidate']);
    const diary = promptLayersHot(quietHot, root, layers, { tmpDir });
    assert.equal(diary.hot.prompts.reply, 'local réply');
    assert.equal(diary.hot.prompts['diary-plan'], 'candidate plan');
    assert.equal(diary.hot.prompts.labels.diary.topic, 'Topic');
    diary.hot.close();
    // --pair: one side's directory is prompts.local/ (the other layers do not show through).
    const side = promptLayersHot(quietHot, root, ['candidate'], { tmpDir });
    assert.equal(side.hot.prompts.reply, 'tracked reply');
    assert.equal(side.hot.prompts['diary-plan'], 'candidate plan');
    side.hot.close();
    // No prompts.local/ in the checkout: the diary layers are the directory alone.
    fs.rmSync(path.join(root, 'prompts.local'), { recursive: true });
    assert.deepEqual(diaryPromptLayers(root, 'candidate'), ['candidate']);
    assert.throws(() => promptLayersHot(quietHot, root, ['missing'], { tmpDir }), /missing is not a directory/);
    // The checkout is untouched.
    assert.deepEqual(fs.readdirSync(path.join(root, 'prompts')).sort(), ['diary-plan.md', 'labels.json', 'reply.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  // One implementation: replay.mjs calls the lib helper for both modes and keeps no copy of its own.
  const source = fs.readFileSync(new URL('../tools/replay.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("from './lib/prompt-layers.mjs'"));
  assert.equal((source.match(/promptLayersHot\(/g) ?? []).length, 2, 'one call for --pair, one for --diary');
  assert.ok(!/function sideHot\b/.test(source));
  assert.ok(!/fs\.cpSync\(/.test(source), 'no prompt copying outside the helper');
});

test('replay: with NEPTUNIA_PRIVATE_DIR apart, --diary and --pair take config.local.json and prompts.local/ from it', () => {
  const root = scratchRoot();
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-replay-private-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-replay-layers-'));
  const env = { NEPTUNIA_PRIVATE_DIR: privateDir };
  try {
    // The checkout keeps a stale local layer; the live one is in the private directory.
    fs.writeFileSync(path.join(root, 'config.local.json'), JSON.stringify({ bot: { dryRunChannelId: 'checkout' } }));
    fs.writeFileSync(path.join(privateDir, 'config.local.json'), JSON.stringify({ bot: { dryRunChannelId: 'private' } }));
    fs.mkdirSync(path.join(privateDir, 'prompts.local'));
    fs.writeFileSync(path.join(privateDir, 'prompts.local', 'reply.md'), 'private reply');

    const layers = diaryPromptLayers(root, 'candidate', env);
    assert.deepEqual(layers, [path.join(privateDir, 'prompts.local'), 'candidate']);
    const diary = promptLayersHot(quietHot, root, layers, { tmpDir, env });
    assert.equal(diary.hot.prompts.reply, 'private reply', 'the checkout prompts.local/ is not read');
    assert.equal(diary.hot.prompts['diary-plan'], 'candidate plan');
    assert.equal(diary.hot.config.bot.dryRunChannelId, 'private');
    diary.hot.close();
    const side = promptLayersHot(quietHot, root, ['candidate'], { tmpDir, env });
    assert.equal(side.hot.config.bot.dryRunChannelId, 'private');
    assert.equal(side.hot.prompts.reply, 'tracked reply');
    side.hot.close();
    // No prompts.local/ in the private directory: the checkout's is not taken instead.
    fs.rmSync(path.join(privateDir, 'prompts.local'), { recursive: true });
    assert.deepEqual(diaryPromptLayers(root, 'candidate', env), ['candidate']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(privateDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('replay: search availability follows web.search.engine through the lookup, not the Brave key alone', () => {
  const searches = { brave: createBraveSearch(), exa: createExaSearch() };
  const hotOf = (engine) => ({ config: { web: { search: { engine } } }, prompts: {} });
  const available = (engine, env) => searchAvailableOf({ hot: hotOf(engine), createLookup, searches, env });
  assert.equal(available('openrouter', {}), true, 'openrouter needs no Brave key');
  assert.equal(available('exa', {}), true, 'exa needs no key');
  assert.equal(available('brave', {}), false, 'brave without its key cannot search');
  assert.equal(available('brave', { BRAVE_SEARCH_API_KEY: 'k' }), true);
});
