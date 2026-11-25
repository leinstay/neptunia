// The `--diary-kind` mode of scripts/replay.ts (scripts/lib/replay-diary.ts): its arguments, its gate, and one sample of
// a named kind run through the real turn runner with a fake model. Synthetic data only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDayKey, planDay } from '../../../src/behavior/diary.ts';
import { zonedEpoch } from '../../../src/time.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../../../scripts/lib/replay-args.ts';
import { diaryDayGate, diaryReplaySample, loadDiaryMods, voicedHot } from '../../../scripts/lib/replay-diary.ts';
import { diaryReplayRunner } from '../../../scripts/lib/replay-inner.ts';
import { recordingLlm } from '../../../scripts/lib/replay-llm.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { SERVICE_CONTEXT, TURN_NOW, blockOf, serviceWorld } from '../../fixtures/service-turn.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { NOT_DRAWN, diaryKindSample, notDrawnLook } from '../../../scripts/lib/diary-day.ts';
import { shippedLabels as labels } from '../../fixtures/shipped-labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import { worldTurnRunner } from '../../fixtures/world-runner.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import '../../../src/tools/operations/index.ts';
import { REFUSED_EXIT } from '../../../scripts/lib/cli.ts';
import { asRecord } from '../../fixtures/records.ts';

useIface('fake');

useSelf('self-id');

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);

test('replay: --diary-kind plans one entry per sample at this moment, four requests each for a randomSet', () => {
  const mods = { planDay, zonedEpoch, localDayKey };
  const config = { bot: { timezone: 'UTC' }, diary: {} };
  const { day, estimate } = diaryDayGate(
    parseArgs(['--diary-day', '--diary-kind', 'randomSet', '--samples', '2', '--spend', '5']),
    config,
    mods,
    NOW
  );
  assert.deepEqual(day.slots, [NOW, NOW]);
  assert.equal(estimate.requests, 8);
});

/** One sample of `kind` through the real turn runner, the persona drawing once; `look` is the turn's look at a picture. */
async function sample(kind: string, look: (() => Promise<string>) | null) {
  const channel = world().channel({ id: 'd1', name: 'journal', placeId: 'g1', permissions: { attach: true } });
  const generated: Array<unknown> = [];
  const persona = [
    toolAnswer('<msg>μια βόλτα</msg>', [call('draw.create', { people: [], text: 'a pier at dusk' })]),
    '<msg>μια βόλτα</msg>',
  ];
  let answered = 0;
  const fake = {
    complete: (messages: unknown, options: { purpose?: string }) =>
      Promise.resolve(directorAnswer(messages, options) ?? completionOf(persona[Math.min(answered++, 1)])),
  };
  const calls: Array<Record<string, Untyped>> = [];
  const requests: Array<unknown> = [];
  const llm = recordingLlm(
    {
      complete: (messages: unknown, options: { purpose?: string }) => {
        requests.push(messages);
        return fake.complete(messages, options);
      },
    },
    calls
  );
  const runner = worldTurnRunner({
    hot: {
      config: {
        bot: { timezone: 'UTC' },
        context: { channelMessages: 50, caps: {}, vision: {}, pull: {} },
        llm: { maxRequestTokens: 50000 },
        typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
        image: {},
        diary: { placeId: 'd1' },
      },
      prompts: {
        main: 'SYSTEM',
        persona: 'CARD',
        format: 'FORMAT',
        'diary/task': 'DIARY_TASK',
        'diary/scene': 'SCENE_TASK',
        'diary/seeds/place': 'a pier',
        'diary/seeds/setting': 'fog',
        draw: 'DRAW {{request}}',
        labels,
      },
    },
    store: {
      getPlace: () => ({}),
      getUser: () => null,
      getPrivate: () => null,
      listChannels: () => [],
      listUserProfiles: () => [],
      getLore: () => [],
      liveRules: () => [],
      ...objectMediaCache({}),
      getDiary: () => ({ posts: [], updatedAt: 0 }),
      appendDiaryPost: () => {},
      state: { data: {}, markDirty() {} },
    },
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: {
      quota: () => ({ used: 0, cap: 10, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
      generate: (args: unknown) => {
        generated.push(args);
        return Promise.resolve({ buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 });
      },
    },
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
    ...(look ? { describePicture: look } : {}),
  });
  const { result } = await withCapturedLogs(() =>
    runner.runTurn({ channel, mode: 'diary', diary: { kind, forced: true } })
  );
  return { report: diaryKindSample(result, calls), requests, generated };
}

test('replay: a sample of a named kind reports its scene with its seed lines, the calls and the entry', async () => {
  // Bug: the maintainer cannot see what scene an entry was written in, or which lines it rode on.
  const { report } = await sample('picture', null);
  assert.equal(report.outcome, 'spoke');
  assert.equal(report.kind, 'picture');
  assert.deepEqual(report.scenes, [
    { seeds: ['a pier', 'fog'], used: ['a pier'], scene: 'A STILL HARBOUR AT DUSK.', failure: null },
  ]);
  assert.deepEqual(report.messages, ['μια βόλτα']);
});

test('replay: with --draw none the persona is told the picture was not drawn', async () => {
  // Bug: a calibration run without pictures still spends a look at a picture, or tells the persona of one it never saw.
  const { requests } = await sample('picture', notDrawnLook);
  const last = requests.at(-1) as Array<{ role: string; content: unknown }>;
  const tool = last.find((message) => message.role === 'tool');
  assert.ok(userText(tool?.content).includes(NOT_DRAWN), JSON.stringify(tool?.content));
});

// ---- the diary modes read memory as the core's turn does ---------------------------

/** A data folder of the service fixture's world, the persona's account named, as the replay reads it. */
function diaryDataDir(): string {
  const dataDir = tempDir('nep-replay-diary-');
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  serviceWorld({ handle, db: dbOf(handle), close: () => handle.close() });
  dbOf(handle)
    .prepare('INSERT INTO accounts (id, iface, native_id, person_id, names, kind) VALUES (?, ?, ?, ?, ?, ?)')
    .run('fake:self-id', 'fake', 'self-id', 'person:self', '["Αθηνά"]', 'self');
  handle.close();
  return dataDir;
}

const DIARY_GRANTED = ['conversation.read', 'memory.read'];

/** One diary sample of `thought` on the replay's runner, the model reading memory and the place `<memory>` lists. */
async function memorySample(
  request: { outDir: string; n: number } | null = null,
  { voiced = false, answer = null }: { voiced?: boolean; answer?: unknown } = {}
) {
  const dataDir = diaryDataDir();
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_NOW });
  let asked = 0;
  const fake = {
    complete: (messages: Array<{ content: unknown }>) => {
      asked += 1;
      if (asked > 1) return Promise.resolve(completionOf('<skip/>'));
      if (answer !== null) return Promise.resolve(answer);
      const text = messages.map((message) => userText(message.content)).join('\n');
      const garden = blockOf(text, 'memory')
        .split('\n')
        .find((line) => line.includes('κήπος'));
      const handle = /^(#[A-Za-z0-9_-]+):/.exec(garden ?? '')?.[1] ?? '#none';
      return Promise.resolve(
        toolAnswer('', [
          call('memory.read', { subject: handle }, { id: 'c1' }),
          call('conversation.read', { place: handle }, { id: 'c2' }),
        ])
      );
    },
  };
  const calls: Array<Record<string, Untyped>> = [];
  const recorded = recordingLlm(fake, calls);
  const askedRequests: Array<{ purpose: unknown; messages: unknown }> = [];
  const llm = {
    complete: (messages: unknown, options: { purpose?: unknown } = {}) => {
      askedRequests.push({ purpose: options.purpose ?? null, messages });
      return (recorded.complete as (given: unknown, opts: unknown) => Promise<unknown>)(messages, options);
    },
  };
  const hot = {
    config: {
      bot: {
        timezone: 'UTC',
        access: Object.fromEntries(
          DIARY_GRANTED.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])
        ),
      },
      context: SERVICE_CONTEXT,
      llm: { maxRequestTokens: 60000 },
      tools: { resultMaxChars: 2000, callTimeoutMs: 120000 },
      diary: { loop: { maxSteps: 3 } },
      models: { routes: chainsOf({ speech: 'x/speech' }) },
    },
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      format: 'FORMAT',
      'diary/task': 'DIARY_TASK',
      'diary/voice': 'VOICE_PART',
      labels,
    },
  };
  const turns = diaryReplayRunner({
    root: process.cwd(),
    dataDir,
    hot: voiced ? voicedHot(hot) : hot,
    port,
    llm,
    embed: (texts: Array<string>) => Promise.resolve(texts.map(() => null)),
    rng: () => 0.5,
    now: () => TURN_NOW,
    turnId: 't-replay-diary-1',
  });
  try {
    return {
      ...(await diaryReplaySample({ turns, kind: 'thought', calls, asked: askedRequests, request })),
      askedRequests,
    };
  } finally {
    turns.close();
  }
}

test('replay: the diary mode reads memory and a place its <memory> lists, each call with its status', async () => {
  // Bug: the diary modes had no memory reads and no place handles, so every read answered not-configured or
  // unknown-channel and the entries of the text kinds were written with no memory at all.
  const { fields } = await memorySample();
  const answers = fields.answers as Array<{ calls: Array<{ name: unknown; status: unknown; code: unknown }> }>;
  const made = answers.flatMap((one) => one.calls).map((one) => `${String(one.name)}:${String(one.status)}`);
  assert.deepEqual(made, ['memory_read:ok', 'conversation_read:ok'], JSON.stringify(answers));
});

test('replay: --show-request writes the first request of the sample with its <kind> and <memory> and names the file', async () => {
  const outDir = tempDir('nep-replay-diary-out-');
  const { fields } = await memorySample({ outDir, n: 1 });
  assert.equal(fields.request, 'request-1.json');
  const written = JSON.parse(fs.readFileSync(path.join(outDir, 'request-1.json'), 'utf8')) as {
    messages: Array<{ content: unknown }>;
  };
  const text = written.messages.map((message) => userText(message.content)).join('\n');
  assert.ok(text.includes('<kind>\nthought\n</kind>'), text.slice(0, 400));
  assert.ok(blockOf(text, 'memory').includes('κήπος'));
});

test("replay: the diary mode's modules hold everything a run without --answers-dir calls, the embedder built", async () => {
  // Bug: the diary mode built an embedder for the recall from a module its list did not load, so a real run threw
  // `mods.createEmbedder is not a function` before its first turn.
  const src = path.join(process.cwd(), 'src');
  const mods = await loadDiaryMods((rel: string) => import(pathToFileURL(path.join(src, rel)).href));
  const called = [
    'localDayKey',
    'planDay',
    'zonedEpoch',
    'createStore',
    'createCalibrator',
    'createLlm',
    'createImageGen',
    'resolveGuild',
    'createEmbedder',
    'createDiscordInterface',
  ];
  assert.deepEqual(
    called.filter((name) => typeof mods[name] !== 'function'),
    []
  );
  // Built as the mode builds it on a run without --answers-dir; building it calls no model.
  assert.doesNotThrow(() =>
    (mods.createEmbedder as (input: object) => unknown)({
      apiKey: '',
      keyOf: () => null,
      state: { data: {}, markDirty() {} },
    })
  );
});

test('replay: --diary-voice voices the entry, the speech model is a free stand-in, and the report shows the voiced text', async () => {
  // Bug: the forced voice is ignored, the replay would call the speech model, or the report hides what was said aloud.
  assert.equal(parseArgs(['--diary-day', '--diary-kind', 'thought', '--diary-voice']).diaryVoice, true);
  assert.throws(() => parseArgs(['--diary-day', '--diary-voice']), /usage/);
  const sample = await memorySample(null, {
    voiced: true,
    answer: toolAnswer('', [call('voice.say', { text: 'καλησπέρα' }, { id: 'v1' })]),
  });
  const { fields, askedRequests } = sample;
  const result: unknown = sample.result;
  const first = askedRequests[0]?.messages as Array<{ content: unknown }>;
  assert.ok(blockOf(first.map((message) => userText(message.content)).join('\n'), 'task').endsWith('VOICE_PART'));
  assert.deepEqual(fields.voiced, ['καλησπέρα']);
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke');
  const voice = (result as { diary?: { entry?: { voice?: { ogg?: unknown } } } }).diary?.entry?.voice;
  assert.ok(voice?.ogg instanceof Uint8Array, 'the stand-in made a voice file of no sound');
});

const DAY_MODS = { planDay, zonedEpoch, localDayKey };

/** Two windows of exactly one post each, never a quiet day: two slots, inside their windows. */
const DAY_CONFIG = {
  bot: { timezone: 'Europe/Athens' },
  diary: {
    windows: [
      { from: 8, to: 12, posts: [1, 1] },
      { from: 14, to: 20, posts: [1, 1] },
    ],
    quietDayChance: 0,
    minGapMinutes: 90,
    maxPerDay: 12,
  },
};

test('replay: --diary-day plans the same slots for the same seed and date, inside the windows of that local day', () => {
  const args = parseArgs(['--diary-day', '--seed', 'abc', '--date', '2026-10-06', '--spend', '5']);
  const first = diaryDayGate(args, DAY_CONFIG, DAY_MODS);
  const again = diaryDayGate(args, DAY_CONFIG, DAY_MODS);
  const slots = first.day.slots;
  assert.equal(slots.length, 2);
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

  const other = diaryDayGate(
    parseArgs(['--diary-day', '--seed', 'abd', '--date', '2026-10-06', '--spend', '5']),
    DAY_CONFIG,
    DAY_MODS
  );
  assert.notDeepEqual(other.day.slots, first.day.slots, 'another seed, other slots');
  // No --date: the local day of the clock in bot.timezone (22:30 UTC is the next day in Athens).
  const today = diaryDayGate(
    parseArgs(['--diary-day', '--seed', 'abc', '--spend', '5']),
    DAY_CONFIG,
    DAY_MODS,
    Date.UTC(2026, 9, 6, 22, 30)
  );
  assert.equal(today.date, '2026-10-07');
  // No --seed: a fresh one, reported.
  assert.match(
    diaryDayGate(parseArgs(['--diary-day', '--date', '2026-10-06', '--spend', '5']), DAY_CONFIG, DAY_MODS).seed,
    /^[0-9a-f]{12}$/
  );
});

test('replay: --diary-day refuses without --spend covering its estimate; a day without a slot needs none', () => {
  const refused = (argv: Untyped) => {
    try {
      diaryDayGate(parseArgs(argv), DAY_CONFIG, DAY_MODS);
    } catch (err) {
      return err;
    }
    return null;
  };
  const none = refused(['--diary-day', '--seed', 'abc', '--date', '2026-10-06']);
  assert.equal(asRecord(none)?.exitCode, REFUSED_EXIT);
  assert.match(asRecord(none).message, /estimate: 4 model request\(s\), ~0\.60 USD/);
  assert.match(asRecord(none).message, /pictures faked/);
  assert.equal(
    asRecord(refused(['--diary-day', '--seed', 'abc', '--date', '2026-10-06', '--spend', '0.59']))?.exitCode,
    REFUSED_EXIT
  );
  const live = refused([
    '--diary-day',
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
  const passed = diaryDayGate(
    parseArgs([
      '--diary-day',
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

  const quiet = { ...DAY_CONFIG, diary: { ...DAY_CONFIG.diary, quietDayChance: 1 } };
  const quietDay = diaryDayGate(
    parseArgs(['--diary-day', '--seed', 'abc', '--date', '2026-10-06', '--draw', 'live']),
    quiet,
    DAY_MODS
  );
  assert.equal(quietDay.day.quiet, true);
  assert.deepEqual(quietDay.day.slots, []);
  assert.equal(quietDay.gate.ok, true);
});
