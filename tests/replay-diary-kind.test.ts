// The `--diary-kind` mode of scripts/replay.ts: its arguments, its gate, and one sample of a named kind run through
// the real turn runner with a fake model, read by scripts/lib/diary-day.ts#diaryKindSample, with and without pictures.
// Synthetic data only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDayKey, planDay } from '../src/behavior/diary.ts';
import { zonedEpoch } from '../src/time.ts';
import { userText } from '../src/behavior/prompt.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';
import '../src/tools/operations/index.ts';
import { diaryDayGate, parseArgs, recordingLlm } from '../scripts/replay.ts';
import { NOT_DRAWN, diaryKindSample, notDrawnLook } from '../scripts/lib/diary-day.ts';
import { shippedLabels as labels } from './fixtures/shipped-labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { directorAnswer } from './fixtures/scene-answer.ts';
import { useIface, useSelf, world } from './fixtures/turn-world.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';
import type { Untyped } from '../src/tools/types.ts';

useIface('fake');
useSelf('self-id');

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);

test('replay: --diary-kind runs with --diary-day, takes samples, a seed, a prompt layer and --draw none', () => {
  const args = parseArgs([
    '--diary-day',
    '--diary-kind',
    'randomSet',
    '--samples',
    '3',
    '--seed',
    's',
    '--prompts',
    'candidate',
    '--draw',
    'none',
  ]);
  assert.deepEqual(
    [args.diaryKind, args.samples, args.seed, args.prompts, args.draw],
    ['randomSet', 3, 's', 'candidate', 'none']
  );
  for (const argv of [
    ['--diary-kind', 'story'],
    ['--diary-day', '--diary-kind', 'novel'],
    ['--diary-day', '--diary-kind', 'story', '--date', '2026-10-06'],
    ['--diary-day', '--samples', '2'],
    ['--diary-day', '--draw', 'none'],
    ['--inner', 'heartbeat', '--diary-kind', 'story'],
  ])
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
});

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
