// Tests for the pure parts of scripts/replay.ts's diary mode (the arguments, the turn it runs,
// the dry-run view of hot), of its diary-day mode (the arguments, the seeded plan, the spend
// gate, the recording image client of scripts/lib/selfreflection-day.ts, the key) and for
// scripts/lib/prompt-layers.ts, the one prompt layering both --pair and --selfreflection use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHot } from '../src/hot.ts';
import { selfreflectionTopic, localDayKey, planDay } from '../src/behavior/selfreflection.ts';
import { zonedEpoch } from '../src/time.ts';
import { createImageGen } from '../src/llm/images.ts';
import { createLookup } from '../src/web/lookup.ts';
import { createBraveSearch } from '../src/web/brave.ts';
import { createExaSearch } from '../src/web/exa.ts';
import {
  parseArgs,
  storedDumps,
  selfreflectionTurnParams,
  selfreflectionPromptLayers,
  searchAvailableOf,
  selfreflectionDayGate,
  refuseDiscordWrites,
} from '../scripts/replay.ts';
import {
  FIXTURE_PNG,
  MAX_PICTURES_KEY,
  PictureCapError,
  fixtureImagesFetch,
  recordingImages,
  renderSelfreflectionDayReport,
} from '../scripts/lib/selfreflection-day.ts';
import { REFUSED_EXIT } from '../scripts/lib/cli.ts';
import { promptLayersHot } from '../scripts/lib/prompt-layers.ts';
import { tempDir } from './fixtures/tmp.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { asRecord } from './fixtures/records.ts';
import type { Untyped } from '../src/tools/types.ts';
import { chainsOf } from './fixtures/chains.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

const quietHot = createHot; // never watched: createHot watches only on .watch()

/** A scratch checkout: config.json, prompts/ with two files and labels, data/prompts/ with one. */
function scratchRoot() {
  const root = tempDir('nep-replay-test-');
  // PR 7c: the tracked settings live in config/config.json.
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'config.json'),
    JSON.stringify({ features: { selfreflection: true }, bot: { timezone: '42' } })
  );
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(path.join(root, 'prompts', 'reply.md'), 'tracked reply');
  fs.writeFileSync(path.join(root, 'prompts', 'selfreflection-planner.md'), 'tracked plan');
  // PR 7c: the tracked labels live in config/labels.json under `model`.
  fs.writeFileSync(
    path.join(root, 'config', 'labels.json'),
    JSON.stringify({ model: { selfreflection: { topic: 'Topic' } }, owner: {} })
  );
  // Replay layers read the prepared persona tree, separate from tracked engine prompts.
  fs.mkdirSync(path.join(root, 'data', 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'prompts', 'reply.md'), 'local réply');
  fs.mkdirSync(path.join(root, 'candidate'));
  fs.writeFileSync(path.join(root, 'candidate', 'selfreflection-planner.md'), 'candidate plan');
  return root;
}

test('replay: the diary mode builds a diary turn request with the kind forced', () => {
  const args = parseArgs([
    '--selfreflection',
    'picture',
    '--count',
    '3',
    '--topic',
    '  a walk by the séa  ',
    '--prompts',
    'candidate',
    '--out',
    '/tmp/briefs.json',
    '--spend',
    '1',
  ]);
  assert.equal(args.selfreflection, 'picture');
  assert.equal(args.count, 3);
  assert.equal(args.prompts, 'candidate');
  assert.equal(args.outDir, '/tmp/briefs.json');
  assert.deepEqual(
    selfreflectionTurnParams(args as unknown as Parameters<typeof selfreflectionTurnParams>[0], {
      selfreflectionTopic,
    }),
    {
      mode: 'selfreflection',
      selfreflection: { kind: 'picture', topic: 'a walk by the séa', forced: false },
    }
  );
  // A blank topic is none, as /nep diary post takes it; the count defaults to one brief.
  const bare = parseArgs(['--selfreflection', 'selfPicture', '--topic', '   ']);
  assert.equal(bare.count, 1);
  assert.deepEqual(
    selfreflectionTurnParams(bare as unknown as Parameters<typeof selfreflectionTurnParams>[0], {
      selfreflectionTopic,
    }),
    {
      mode: 'selfreflection',
      selfreflection: { kind: 'selfPicture', forced: false },
    }
  );
  // Only the diary flags go with it; an unknown kind, a reply flag or a positional is refused.
  assert.throws(() => parseArgs(['--selfreflection', 'poem']), /usage/);
  assert.throws(() => parseArgs(['--selfreflection', 'picture', '--split']), /usage/);
  assert.throws(() => parseArgs(['--selfreflection', 'picture', '123456789012345678', '223456789012345678']), /usage/);
  assert.throws(() => parseArgs(['--selfreflection', 'picture', '--count', '51']), /usage/);
  assert.throws(() => parseArgs(['123456789012345678', '223456789012345678', '--topic', 'x']), /usage/);
  assert.throws(
    () => parseArgs(['--pair', 'a', 'b', '--prompts', 'c', '123456789012345678', '223456789012345678']),
    /usage/
  );
});

test('replay: --prompts layering is one helper shared by pair and diary', () => {
  const root = scratchRoot();
  const tmpDir = tempDir('nep-replay-layers-');
  try {
    // --selfreflection: the directory over data/prompts/, which stays under it.
    const layers = selfreflectionPromptLayers(root, 'candidate');
    assert.deepEqual(layers, [path.join(root, 'data', 'prompts'), 'candidate']);
    const selfreflection = promptLayersHot(quietHot, root, layers, { tmpDir });
    assert.equal(asRecord(selfreflection.hot).prompts.reply, 'local réply');
    assert.equal(asRecord(selfreflection.hot).prompts['selfreflection-planner'], 'candidate plan');
    assert.equal(asRecord(selfreflection.hot).prompts.labels.selfreflection.topic, 'Topic');
    asRecord(selfreflection.hot).close();
    // --pair: one side's directory is data/prompts/ (the other layers do not show through).
    const side = promptLayersHot(quietHot, root, ['candidate'], { tmpDir });
    assert.equal(asRecord(side.hot).prompts.reply, 'tracked reply');
    assert.equal(asRecord(side.hot).prompts['selfreflection-planner'], 'candidate plan');
    asRecord(side.hot).close();
    // No data/prompts/ in the checkout: the diary layers are the directory alone.
    fs.rmSync(path.join(root, 'data', 'prompts'), { recursive: true });
    assert.deepEqual(selfreflectionPromptLayers(root, 'candidate'), ['candidate']);
    assert.throws(() => promptLayersHot(quietHot, root, ['missing'], { tmpDir }), /missing is not a directory/);
    // The checkout is untouched.
    // PR 7c: the tracked labels live in config/, beside prompts/.
    assert.deepEqual(fs.readdirSync(path.join(root, 'prompts')).sort(), ['reply.md', 'selfreflection-planner.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  // One implementation: replay.ts calls the lib helper for both modes and keeps no copy of its own.
  const source = fs.readFileSync(new URL('../scripts/replay.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("from './lib/prompt-layers.ts'"));
  // The shared module owns the overlay wrapper, so its call remains part of the same two dispatch paths.
  const shared = fs.readFileSync(new URL('../scripts/lib/prompt-layers.ts', import.meta.url), 'utf8');
  assert.equal(
    (source.match(/promptLayersHot\(/g) ?? []).length + (shared.match(/return promptLayersHot\(/g) ?? []).length,
    2,
    'one call for --pair, one for --selfreflection'
  );
  assert.ok(!/function sideHot\b/.test(source));
  assert.ok(!/fs\.cpSync\(/.test(source), 'no prompt copying outside the helper');
});

test('replay: explicit data selection supplies canonical config and prompts to diary and pair', () => {
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
    fs.mkdirSync(path.join(privateDir, 'prompts'));
    fs.writeFileSync(path.join(privateDir, 'prompts', 'reply.md'), 'private reply');

    const layers = selfreflectionPromptLayers(root, 'candidate', env);
    assert.deepEqual(layers, [path.join(privateDir, 'prompts'), 'candidate']);
    const selfreflection = promptLayersHot(quietHot, root, layers, { tmpDir, env });
    assert.equal(asRecord(selfreflection.hot).prompts.reply, 'private reply', 'the checkout data/prompts/ is not read');
    assert.equal(asRecord(selfreflection.hot).prompts['selfreflection-planner'], 'candidate plan');
    assert.equal(asRecord(selfreflection.hot).config.bot.timezone, 'private');
    asRecord(selfreflection.hot).close();
    const side = promptLayersHot(quietHot, root, ['candidate'], { tmpDir, env });
    assert.equal(asRecord(side.hot).config.bot.timezone, 'private');
    assert.equal(asRecord(side.hot).prompts.reply, 'tracked reply');
    asRecord(side.hot).close();
    // No data/prompts/ in the private directory: the checkout's is not taken instead.
    fs.rmSync(path.join(privateDir, 'prompts'), { recursive: true });
    assert.deepEqual(selfreflectionPromptLayers(root, 'candidate', env), ['candidate']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(privateDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('replay: search availability follows web.quickSearch.engine through the lookup, not the Brave key alone', () => {
  const searches = { brave: createBraveSearch(), exa: createExaSearch() };
  // Changed: quick search's model is its chain's, `models.routes.search` (spec 2026-11-09-model-routes, slice 4).
  const hotOf = (engine: string) => ({
    config: { models: { routes: chainsOf({ search: 'x/quick' }) }, web: { quickSearch: { engine } } },
    prompts: {},
  });
  // Service secrets come from keys.json in the selected data root.
  const available = (engine: string, services: Record<string, string>) => {
    const dataDir = tempDir('nep-replay-service-');
    fs.writeFileSync(path.join(dataDir, 'keys.json'), JSON.stringify({ core: [], extra: {}, roles: {}, services }), {
      mode: 0o600,
    });
    return searchAvailableOf({
      hot: hotOf(engine),
      createLookup,
      searches,
      env: { NEPTUNIA_DATA_DIR: dataDir },
    });
  };
  assert.equal(available('openrouter', {}), true, 'openrouter needs no Brave key');
  assert.equal(available('exa', {}), false, 'exa without its key cannot search');
  assert.equal(available('exa', { exa: 'k' }), true);
  assert.equal(available('brave', {}), false, 'brave without its key cannot search');
  assert.equal(available('brave', { brave: 'k' }), true);
});

// ---- --selfreflection-day -------------------------------------------------------------------

test('replay: --selfreflection-day takes its own flags, fake drawing by default, --max-pictures only live', () => {
  const bare = parseArgs(['--selfreflection-day']);
  assert.equal(bare.selfreflectionDay, true);
  assert.equal(bare.draw, 'fake');
  assert.equal(bare.maxPictures, null);
  assert.equal(bare.seed, null);
  assert.equal(bare.date, null);
  const full = parseArgs([
    '--selfreflection-day',
    '--seed',
    'σπόρος-1',
    '--date',
    '2026-10-06',
    '--draw',
    'live',
    '--max-pictures',
    '3',
    '--out',
    'day',
    '--spend',
    '2',
  ]);
  assert.deepEqual(
    [full.seed, full.date, full.draw, full.maxPictures, full.outDir, full.spend],
    ['σπόρος-1', '2026-10-06', 'live', 3, 'day', '2']
  );
  assert.equal(
    parseArgs(['--selfreflection-day', '--draw', 'live']).maxPictures,
    2,
    'a live day draws two pictures at most unless told'
  );
  for (const argv of [
    ['--selfreflection-day', '--max-pictures', '2'],
    ['--selfreflection-day', '--draw', 'fake', '--max-pictures', '2'],
    ['--selfreflection-day', '--draw', 'paint'],
    ['--selfreflection-day', '--date', '2026-02-30'],
    ['--selfreflection-day', '--date', '06-10-2026'],
    ['--selfreflection-day', '--draw', 'live', '--max-pictures', '0'],
    ['--selfreflection-day', '123456789012345678', '223456789012345678'],
    ['--selfreflection-day', '--selfreflection', 'picture'],
    ['--selfreflection-day', '--count', '2'],
    ['--selfreflection-day', '--prompts', 'candidate'],
    ['--selfreflection-day', '--snapshot', 'snap'],
    ['--selfreflection', 'picture', '--seed', 's'],
    ['123456789012345678', '223456789012345678', '--draw', 'fake'],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

const DAY_MODS = { planDay, zonedEpoch, localDayKey };
/** Two windows of exactly one post each, never a quiet day: two slots, inside their windows. */
const DAY_CONFIG = {
  bot: { timezone: 'Europe/Athens' },
  selfreflection: {
    windows: [
      { from: 8, to: 12, posts: [1, 1] },
      { from: 14, to: 20, posts: [1, 1] },
    ],
    quietDayChance: 0,
    minGapMinutes: 90,
    maxPerDay: 12,
  },
};

test('replay: --selfreflection-day plans the same slots for the same seed and date, inside the windows of that local day', () => {
  const args = parseArgs(['--selfreflection-day', '--seed', 'abc', '--date', '2026-10-06', '--spend', '5']);
  const first = selfreflectionDayGate(args, DAY_CONFIG, DAY_MODS);
  const again = selfreflectionDayGate(args, DAY_CONFIG, DAY_MODS);
  assert.equal(first.day.slots.length, 2);
  assert.deepEqual(again.day.slots, first.day.slots, 'deterministic');
  assert.equal(first.date, '2026-10-06');
  assert.equal(first.seed, 'abc');
  assert.equal(first.day.start, zonedEpoch('2026-10-06', 0, 0, 'Europe/Athens'));
  const [morning, afternoon] = first.day.slots;
  assert.ok(
    morning >= zonedEpoch('2026-10-06', 8, 0, 'Europe/Athens') &&
      morning < zonedEpoch('2026-10-06', 12, 0, 'Europe/Athens')
  );
  assert.ok(
    afternoon >= zonedEpoch('2026-10-06', 14, 0, 'Europe/Athens') &&
      afternoon < zonedEpoch('2026-10-06', 20, 0, 'Europe/Athens')
  );

  const other = selfreflectionDayGate(
    parseArgs(['--selfreflection-day', '--seed', 'abd', '--date', '2026-10-06', '--spend', '5']),
    DAY_CONFIG,
    DAY_MODS
  );
  assert.notDeepEqual(other.day.slots, first.day.slots, 'another seed, other slots');
  // No --date: the local day of the clock in bot.timezone (22:30 UTC is the next day in Athens).
  const today = selfreflectionDayGate(
    parseArgs(['--selfreflection-day', '--seed', 'abc', '--spend', '5']),
    DAY_CONFIG,
    DAY_MODS,
    Date.UTC(2026, 9, 6, 22, 30)
  );
  assert.equal(today.date, '2026-10-07');
  // No --seed: a fresh one, reported.
  assert.match(
    selfreflectionDayGate(
      parseArgs(['--selfreflection-day', '--date', '2026-10-06', '--spend', '5']),
      DAY_CONFIG,
      DAY_MODS
    ).seed,
    /^[0-9a-f]{12}$/
  );
});

test('replay: --selfreflection-day refuses without --spend covering its estimate; a day without a slot needs none', () => {
  const refused = (argv: Untyped) => {
    try {
      selfreflectionDayGate(parseArgs(argv), DAY_CONFIG, DAY_MODS);
    } catch (err) {
      return err;
    }
    return null;
  };
  const none = refused(['--selfreflection-day', '--seed', 'abc', '--date', '2026-10-06']);
  assert.equal(asRecord(none)?.exitCode, REFUSED_EXIT);
  assert.match(asRecord(none).message, /estimate: 4 model request\(s\), ~0\.60 USD/);
  assert.match(asRecord(none).message, /pictures faked/);
  assert.equal(
    asRecord(refused(['--selfreflection-day', '--seed', 'abc', '--date', '2026-10-06', '--spend', '0.59']))?.exitCode,
    REFUSED_EXIT
  );
  const live = refused([
    '--selfreflection-day',
    '--seed',
    'abc',
    '--date',
    '2026-10-06',
    '--draw',
    'live',
    '--max-pictures',
    '3',
    '--spend',
    '0.6',
  ]);
  assert.equal(asRecord(live)?.exitCode, REFUSED_EXIT, 'the live pictures are on top');
  assert.match(asRecord(live).message, /~0\.68 USD/);
  const passed = selfreflectionDayGate(
    parseArgs([
      '--selfreflection-day',
      '--seed',
      'abc',
      '--date',
      '2026-10-06',
      '--draw',
      'live',
      '--max-pictures',
      '3',
      '--spend',
      '0.7',
    ]),
    DAY_CONFIG,
    DAY_MODS
  );
  assert.equal(passed.gate.ok, true);
  assert.equal(passed.gate.budget, 0.7);
  assert.equal(passed.estimate.pictures, 3);

  const quiet = { ...DAY_CONFIG, selfreflection: { ...DAY_CONFIG.selfreflection, quietDayChance: 1 } };
  const quietDay = selfreflectionDayGate(
    parseArgs(['--selfreflection-day', '--seed', 'abc', '--date', '2026-10-06', '--draw', 'live']),
    quiet,
    DAY_MODS
  );
  assert.equal(quietDay.day.quiet, true);
  assert.deepEqual(quietDay.day.slots, []);
  assert.equal(quietDay.gate.ok, true);
});

test('replay: --selfreflection-day records every generate() call at the image client and fakes the picture through the real client', async () => {
  const state = { data: {}, markDirty() {} };
  const config = {
    llm: { baseUrl: 'https://openrouter.invalid/api/v1' },
    models: { routes: chainsOf({ drawing: 'openai/image-model' }) },
    image: { retries: 0 },
  };
  const real = createImageGen({
    apiKey: 'unused',
    getConfig: () => config,
    state,
    fetchImpl: fixtureImagesFetch(),
    now: () => Date.UTC(2026, 9, 6, 9, 0),
  } as unknown as Parameters<typeof createImageGen>[0]);
  const written: Array<number> = [];
  const images = recordingImages({
    images: real,
    maxPictures: 1,
    onPicture: (picture, index) => {
      written.push(index);
      return `pictures/picture-${index}.png`;
    },
  });
  const avatar = `data:image/png;base64,${Buffer.from('avatar bytes').toString('base64')}`;
  const { result: picture } = await withCapturedLogs(() =>
    images.generate({ prompt: 'A drawing.\n\nScene: a café', reference: avatar, accountId: null })
  );
  assert.ok(picture.buffer.equals(FIXTURE_PNG));
  assert.equal(FIXTURE_PNG.subarray(1, 4).toString('latin1'), 'PNG');
  // PR 7d: the engine's ImageCapError went with the daily caps; the tool's own --max-pictures cap throws PictureCapError.
  await assert.rejects(
    withCapturedLogs(() => images.generate({ prompt: 'second', reference: null, accountId: 'u1' })),
    (err: unknown) =>
      err instanceof PictureCapError && asRecord(err).key === MAX_PICTURES_KEY && asRecord(err).cap === 1
  );
  assert.deepEqual(written, [1]);
  assert.deepEqual(images.calls, [
    {
      prompt: 'A drawing.\n\nScene: a café',
      reference: { mediaType: 'image/png', bytes: 12, sha256: asRecord(images.calls[0]).reference.sha256 },
      accountId: null,
      result: { bytes: FIXTURE_PNG.length, mediaType: 'image/png', cost: 0, seconds: 0 },
      file: 'pictures/picture-1.png',
    },
    { prompt: 'second', reference: null, accountId: 'u1', result: { error: 'PictureCapError', reason: 'daily' } },
  ]);
  assert.match(images.calls[0].reference?.sha256, /^[0-9a-f]{16}$/);
  const md = renderSelfreflectionDayReport({
    date: '2026-10-06',
    timezone: 'UTC',
    seed: 's',
    draw: 'fake',
    quiet: false,
    slots: [{ n: 1, at: 'x', outcome: 'spoke', messages: ['hi'], draws: images.calls }],
  });
  assert.ok(md.includes('```text\nA drawing.\n\nScene: a café\n```'), 'the whole prompt, as sent');
});

test("replay: --show-request reads the base dumps of a turn by default, --steps adds each attempt's later requests after it", () => {
  const journalDir = tempDir('nep-replay-dumps-');
  const day = path.join(journalDir, 'requests', '2026-10-18');
  fs.mkdirSync(day, { recursive: true });
  for (const name of [
    't-ab-1.json',
    't-ab-1-s1.json',
    't-ab-1-s10.json',
    't-ab-1-s2.json',
    't-ab-2.json',
    't-ab-2-s1.json',
    't-ab-cd-1.json',
    'notes.txt',
  ]) {
    fs.writeFileSync(path.join(day, name), JSON.stringify({ name }));
  }
  assert.deepEqual(
    storedDumps(journalDir, 't-ab').map(({ dump }) => asRecord(dump).name),
    ['t-ab-1.json', 't-ab-2.json']
  );
  assert.deepEqual(
    storedDumps(journalDir, 't-ab', { steps: true }).map(({ dump }) => asRecord(dump).name),
    ['t-ab-1.json', 't-ab-1-s1.json', 't-ab-1-s2.json', 't-ab-1-s10.json', 't-ab-2.json', 't-ab-2-s1.json']
  );
  assert.equal(parseArgs(['--show-request', 't-ab', '--steps']).steps, true);
  assert.equal(parseArgs(['--show-request', 't-ab']).steps, false);
  assert.throws(() => parseArgs(['c1', 'm1', '--steps']), /usage/i);
});

test('replay: a stored dump that had tools gets its definitions back from the by-hash copy', () => {
  const journalDir = tempDir('nep-replay-dump-tools-');
  const day = path.join(journalDir, 'requests', '2026-10-20');
  fs.mkdirSync(path.join(journalDir, 'requests', 'tools'), { recursive: true });
  fs.mkdirSync(day, { recursive: true });
  const tools = [
    { type: 'function', function: { name: 'draw_create', description: 'd', parameters: { type: 'object' } } },
  ];
  const hash = 'a'.repeat(64);
  fs.writeFileSync(path.join(journalDir, 'requests', 'tools', `${hash}.json`), JSON.stringify(tools));
  fs.writeFileSync(path.join(day, 't-1-1.json'), JSON.stringify({ tools: hash, toolChoice: 'auto' }));
  fs.writeFileSync(path.join(day, 't-2-1.json'), JSON.stringify({ tools: 'b'.repeat(64) }));
  fs.writeFileSync(path.join(day, 't-3-1.json'), JSON.stringify({ raw: 'x' }));
  assert.deepEqual(asRecord(storedDumps(journalDir, 't-1')[0].dump).toolDefinitions, tools);
  assert.equal('toolDefinitions' in storedDumps(journalDir, 't-2')[0].dump, false);
  assert.equal('toolDefinitions' in storedDumps(journalDir, 't-3')[0].dump, false);
});

test("replay: a stored dump's later messages are shown as role, tool_calls and tool_call_id", () => {
  const journalDir = tempDir('nep-replay-dump-later-');
  const day = path.join(journalDir, 'requests', '2026-10-20');
  fs.mkdirSync(day, { recursive: true });
  const calls = [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }];
  fs.writeFileSync(
    path.join(day, 't-1-1-s1.json'),
    JSON.stringify({
      later: [
        { role: 'assistant', content: 'a', tool_calls: calls },
        { role: 'tool', tool_call_id: 'call_1', content: 'r' },
        { role: 'user', content: 'n' },
      ],
    })
  );
  fs.writeFileSync(path.join(day, 't-1-1.json'), JSON.stringify({ raw: 'x' }));
  const [base, step] = storedDumps(journalDir, 't-1', { steps: true });
  assert.equal('later' in base.dump, false);
  assert.deepEqual(asRecord(step.dump).later, [
    { role: 'assistant', tool_calls: calls, content: 'a' },
    { role: 'tool', tool_call_id: 'call_1', content: 'r' },
    { role: 'user', content: 'n' },
  ]);
});

test('replay: recordingLlm keeps the native tool calls and the finish reason of each answer, for the diary brief and the inner report', async () => {
  const { recordingLlm } = await import('../scripts/replay.ts');
  const toolCalls = [
    { id: 'c1', name: 'draw_create', arguments: '{"text":"a cat"}', parsed: { text: 'a cat' }, parseError: null },
  ];
  const real = {
    complete: async () => ({ text: '<think>t</think>', toolCalls, finishReason: 'stop', usage: { prompt_tokens: 3 } }),
    other: () => 'x',
  };
  const calls: Array<Untyped> = [];
  const llm = recordingLlm(real, calls);
  await llm.complete([], { purpose: 'reply' });
  assert.deepEqual(
    calls.map((c) => [c.purpose, c.text, c.toolCalls, c.finishReason]),
    [['reply', '<think>t</think>', toolCalls, 'stop']]
  );
  const plain = recordingLlm({ complete: async () => ({ text: 'x', usage: null }) }, calls);
  await plain.complete([], {});
  assert.deepEqual([calls[1].toolCalls, calls[1].finishReason], [null, null]);
});

test('refuseDiscordWrites: a GET passes to the REST queue and every write is refused, so a diary replay posts nothing', async () => {
  // PR 7d: the dry-run switch is gone from the engine, so this refusal is what keeps a diary replay from posting.
  const queued: Array<Untyped> = [];
  const client = {
    rest: { queueRequest: (request: Untyped) => Promise.resolve(queued.push(request.method ?? 'GET')) },
  };
  refuseDiscordWrites(client);
  await client.rest.queueRequest({ method: 'GET' });
  await client.rest.queueRequest({});
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    await assert.rejects(client.rest.queueRequest({ method }), /refused \(read-only tool\)/);
  }
  assert.deepEqual(queued, ['GET', 'GET']);
});
