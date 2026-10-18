// Tests for the pure parts of tools/replay.mjs's diary mode (the arguments, the turn it runs,
// the dry-run view of hot), of its diary-day mode (the arguments, the seeded plan, the spend
// gate, the recording image client of tools/lib/diary-day.mjs, the key) and for
// tools/lib/prompt-layers.mjs, the one prompt layering both --pair and --diary use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHot } from '../src/hot.js';
import { diaryTopic, localDayKey, planDay } from '../src/behavior/diary.js';
import { zonedEpoch } from '../src/time.js';
import { ImageCapError, createImageGen } from '../src/llm/images.js';
import { createLookup } from '../src/web/lookup.js';
import { createBraveSearch } from '../src/web/brave.js';
import { createExaSearch } from '../src/web/exa.js';
import { parseArgs, diaryTurnParams, diaryPromptLayers, dryRunHot, searchAvailableOf, diaryDayGate, diaryDayKey, noPostHot } from '../tools/replay.mjs';
import { FIXTURE_PNG, MAX_PICTURES_KEY, fixtureImagesFetch, recordingImages, renderDiaryDayReport } from '../tools/lib/diary-day.mjs';
import { REFUSED_EXIT } from '../tools/lib/cli.mjs';
import { promptLayersHot } from '../tools/lib/prompt-layers.mjs';
import { tempDir } from './fixtures/tmp.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const quietHot = createHot; // never watched: createHot watches only on .watch()

/** A scratch checkout: config.json, prompts/ with two files and labels, prompts.local/ with one. */
function scratchRoot() {
  const root = tempDir('nep-replay-test-');
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
  const tmpDir = tempDir('nep-replay-layers-');
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
  const privateDir = tempDir('nep-replay-private-');
  const tmpDir = tempDir('nep-replay-layers-');
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

// ---- --diary-day -------------------------------------------------------------------

test('replay: --diary-day takes its own flags, fake drawing by default, --max-pictures only live', () => {
  const bare = parseArgs(['--diary-day']);
  assert.equal(bare.diaryDay, true);
  assert.equal(bare.draw, 'fake');
  assert.equal(bare.maxPictures, null);
  assert.equal(bare.seed, null);
  assert.equal(bare.date, null);
  const full = parseArgs(['--diary-day', '--seed', 'σπόρος-1', '--date', '2026-10-06', '--draw', 'live', '--max-pictures', '3', '--out', 'day', '--spend', '2']);
  assert.deepEqual(
    [full.seed, full.date, full.draw, full.maxPictures, full.outDir, full.spend],
    ['σπόρος-1', '2026-10-06', 'live', 3, 'day', '2'],
  );
  assert.equal(parseArgs(['--diary-day', '--draw', 'live']).maxPictures, 2, 'a live day draws two pictures at most unless told');
  for (const argv of [
    ['--diary-day', '--max-pictures', '2'],
    ['--diary-day', '--draw', 'fake', '--max-pictures', '2'],
    ['--diary-day', '--draw', 'paint'],
    ['--diary-day', '--date', '2026-02-30'],
    ['--diary-day', '--date', '06-10-2026'],
    ['--diary-day', '--draw', 'live', '--max-pictures', '0'],
    ['--diary-day', '123456789012345678', '223456789012345678'],
    ['--diary-day', '--diary', 'picture'],
    ['--diary-day', '--count', '2'],
    ['--diary-day', '--prompts', 'candidate'],
    ['--diary-day', '--snapshot', 'snap'],
    ['--diary', 'picture', '--seed', 's'],
    ['123456789012345678', '223456789012345678', '--draw', 'fake'],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

const DAY_MODS = { planDay, zonedEpoch, localDayKey };
/** Two windows of exactly one post each, never a quiet day: two slots, inside their windows. */
const DAY_CONFIG = {
  bot: { timezone: 'Europe/Athens' },
  diary: { windows: [{ from: 8, to: 12, posts: [1, 1] }, { from: 14, to: 20, posts: [1, 1] }], quietDayChance: 0, minGapMinutes: 90, maxPerDay: 12 },
};

test('replay: --diary-day plans the same slots for the same seed and date, inside the windows of that local day', () => {
  const args = parseArgs(['--diary-day', '--seed', 'abc', '--date', '2026-10-06', '--spend', '5']);
  const first = diaryDayGate(args, DAY_CONFIG, DAY_MODS);
  const again = diaryDayGate(args, DAY_CONFIG, DAY_MODS);
  assert.equal(first.day.slots.length, 2);
  assert.deepEqual(again.day.slots, first.day.slots, 'deterministic');
  assert.equal(first.date, '2026-10-06');
  assert.equal(first.seed, 'abc');
  assert.equal(first.day.start, zonedEpoch('2026-10-06', 0, 0, 'Europe/Athens'));
  const [morning, afternoon] = first.day.slots;
  assert.ok(morning >= zonedEpoch('2026-10-06', 8, 0, 'Europe/Athens') && morning < zonedEpoch('2026-10-06', 12, 0, 'Europe/Athens'));
  assert.ok(afternoon >= zonedEpoch('2026-10-06', 14, 0, 'Europe/Athens') && afternoon < zonedEpoch('2026-10-06', 20, 0, 'Europe/Athens'));

  const other = diaryDayGate(parseArgs(['--diary-day', '--seed', 'abd', '--date', '2026-10-06', '--spend', '5']), DAY_CONFIG, DAY_MODS);
  assert.notDeepEqual(other.day.slots, first.day.slots, 'another seed, other slots');
  // No --date: the local day of the clock in bot.timezone (22:30 UTC is the next day in Athens).
  const today = diaryDayGate(parseArgs(['--diary-day', '--seed', 'abc', '--spend', '5']), DAY_CONFIG, DAY_MODS, Date.UTC(2026, 9, 6, 22, 30));
  assert.equal(today.date, '2026-10-07');
  // No --seed: a fresh one, reported.
  assert.match(diaryDayGate(parseArgs(['--diary-day', '--date', '2026-10-06', '--spend', '5']), DAY_CONFIG, DAY_MODS).seed, /^[0-9a-f]{12}$/);
});

test('replay: --diary-day refuses without --spend covering its estimate; a day without a slot needs none', () => {
  const refused = (argv) => {
    try {
      diaryDayGate(parseArgs(argv), DAY_CONFIG, DAY_MODS);
    } catch (err) {
      return err;
    }
    return null;
  };
  const none = refused(['--diary-day', '--seed', 'abc', '--date', '2026-10-06']);
  assert.equal(none?.exitCode, REFUSED_EXIT);
  assert.match(none.message, /estimate: 4 model request\(s\), ~0\.60 USD/);
  assert.match(none.message, /pictures faked/);
  assert.equal(refused(['--diary-day', '--seed', 'abc', '--date', '2026-10-06', '--spend', '0.59'])?.exitCode, REFUSED_EXIT);
  const live = refused(['--diary-day', '--seed', 'abc', '--date', '2026-10-06', '--draw', 'live', '--max-pictures', '3', '--spend', '0.6']);
  assert.equal(live?.exitCode, REFUSED_EXIT, 'the live pictures are on top');
  assert.match(live.message, /~0\.68 USD/);
  const passed = diaryDayGate(parseArgs(['--diary-day', '--seed', 'abc', '--date', '2026-10-06', '--draw', 'live', '--max-pictures', '3', '--spend', '0.7']), DAY_CONFIG, DAY_MODS);
  assert.equal(passed.gate.ok, true);
  assert.equal(passed.gate.budget, 0.7);
  assert.equal(passed.estimate.pictures, 3);

  const quiet = { ...DAY_CONFIG, diary: { ...DAY_CONFIG.diary, quietDayChance: 1 } };
  const quietDay = diaryDayGate(parseArgs(['--diary-day', '--seed', 'abc', '--date', '2026-10-06', '--draw', 'live']), quiet, DAY_MODS);
  assert.equal(quietDay.day.quiet, true);
  assert.deepEqual(quietDay.day.slots, []);
  assert.equal(quietDay.gate.ok, true);
});

test('replay: --diary-day records every generate() call at the image client and fakes the picture through the real client', async () => {
  const state = { data: {}, markDirty() {} };
  const config = {
    llm: { baseUrl: 'https://openrouter.invalid/api/v1' },
    models: { agents: { drawing: 'openai/image-model' } },
    image: { maxPerDay: 5, maxPerUserPerDay: 2, retries: 0 },
  };
  const real = createImageGen({ apiKey: 'unused', getConfig: () => config, state, fetchImpl: fixtureImagesFetch(), now: () => Date.UTC(2026, 9, 6, 9, 0) });
  const written = [];
  const images = recordingImages({ images: real, ImageCapError, maxPictures: 1, onPicture: (picture, index) => {
    written.push(index);
    return `pictures/picture-${index}.png`;
  } });
  const avatar = `data:image/png;base64,${Buffer.from('avatar bytes').toString('base64')}`;
  const { result: picture } = await withCapturedLogs(() => images.generate({ prompt: 'A drawing.\n\nScene: a café', reference: avatar, userId: null }));
  assert.ok(picture.buffer.equals(FIXTURE_PNG));
  assert.equal(FIXTURE_PNG.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(state.data.imageCount, 1, 'counted against image.maxPerDay as live');
  await assert.rejects(withCapturedLogs(() => images.generate({ prompt: 'second', reference: null, userId: 'u1' })), (err) => err instanceof ImageCapError && err.key === MAX_PICTURES_KEY && err.cap === 1);
  assert.deepEqual(written, [1]);
  assert.deepEqual(images.calls, [
    {
      prompt: 'A drawing.\n\nScene: a café',
      reference: { mediaType: 'image/png', bytes: 12, sha256: images.calls[0].reference.sha256 },
      userId: null,
      result: { bytes: FIXTURE_PNG.length, mediaType: 'image/png', cost: 0, seconds: 0 },
      file: 'pictures/picture-1.png',
    },
    { prompt: 'second', reference: null, userId: 'u1', result: { error: 'ImageCapError', reason: 'daily' } },
  ]);
  assert.match(images.calls[0].reference.sha256, /^[0-9a-f]{16}$/);
  const md = renderDiaryDayReport({ date: '2026-10-06', timezone: 'UTC', seed: 's', draw: 'fake', quiet: false, slots: [{ n: 1, at: 'x', outcome: 'spoke', messages: ['hi'], draws: images.calls }] });
  assert.ok(md.includes('```text\nA drawing.\n\nScene: a café\n```'), 'the whole prompt, as sent');
});

test('replay: --diary-day --draw live spends OPENROUTER_SIM_KEY only; hot acts to the end without typing waits', () => {
  assert.throws(() => diaryDayKey('live', { OPENROUTER_API_KEY: 'bot' }), /OPENROUTER_SIM_KEY/);
  assert.equal(diaryDayKey('live', { OPENROUTER_SIM_KEY: 'sim', OPENROUTER_API_KEY: 'bot' }), 'sim');
  assert.equal(diaryDayKey('fake', { OPENROUTER_SIM_KEY: 'sim' }), 'sim');

  const hot = { config: { features: { dryRun: true, typingSimulation: true, diary: true }, bot: { dryRunChannelId: '42', timezone: 'UTC' } } };
  const view = noPostHot(hot);
  assert.deepEqual(view.config.features, { dryRun: false, typingSimulation: false, diary: true });
  assert.deepEqual(view.config.bot, { dryRunChannelId: '', timezone: 'UTC' });
  assert.equal(hot.config.features.dryRun, true, 'the real config is untouched');
});
