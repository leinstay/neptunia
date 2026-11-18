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
import fs from 'node:fs';
import path from 'node:path';
import { diaryDayGate, diaryReplayRunner, diaryReplaySample, parseArgs, recordingLlm } from '../scripts/replay.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { SERVICE_CONTEXT, TURN_NOW, blockOf, serviceWorld } from './fixtures/service-turn.ts';
import { tempDir } from './fixtures/tmp.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
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

/** One diary sample of `status` on the replay's runner, the model reading memory and the place `<memory>` lists. */
async function memorySample(request: { outDir: string; n: number } | null = null) {
  const dataDir = diaryDataDir();
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_NOW });
  let asked = 0;
  const fake = {
    complete: (messages: Array<{ content: unknown }>) => {
      asked += 1;
      if (asked > 1) return Promise.resolve(completionOf('<skip/>'));
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
      tools: { transport: 'native', resultMaxChars: 2000, callTimeoutMs: 120000 },
      diary: { loop: { maxSteps: 3 } },
    },
    prompts: { main: 'SYSTEM', persona: 'CARD', format: 'FORMAT', 'diary/task': 'DIARY_TASK', labels },
  };
  const turns = diaryReplayRunner({
    root: process.cwd(),
    dataDir,
    hot,
    port,
    llm,
    embed: (texts: Array<string>) => Promise.resolve(texts.map(() => null)),
    rng: () => 0.5,
    now: () => TURN_NOW,
    turnId: 't-replay-diary-1',
  });
  try {
    return await diaryReplaySample({ turns, kind: 'status', calls, asked: askedRequests, request });
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
  assert.ok(text.includes('<kind>\nstatus\n</kind>'), text.slice(0, 400));
  assert.ok(blockOf(text, 'memory').includes('κήπος'));
});

test('replay: --show-request goes with --diary-kind alone', () => {
  assert.equal(parseArgs(['--diary-day', '--diary-kind', 'status', '--show-request']).showRequest, true);
  assert.throws(() => parseArgs(['--diary-day', '--show-request']), /usage/);
});
