import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { createDiscordAdapter, createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { userText as textOf } from '../../../src/behavior/prompt.ts';
import { placeOfRoot } from '../../../src/memory/addresses.ts';
import '../../../src/tools/operations/index.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import type { TurnParams } from '../../../src/turn/outcome.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { replyTurn, ROOT } from '../../fixtures/diary-awareness.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import {
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  NOW,
  rawMessage,
  type RawMessage,
} from '../../fixtures/turn-kit.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import type { ChannelSpec } from '../../fixtures/turn-world.ts';

test('a turn in the mirrored place keeps no participation there', async () => {
  const { store } = await replyTurn({ here: 'd1', mirrors: ['d1'] });
  // The store is JS; its participation unit holds the episodes of every channel.
  const episodes = (
    store.getParticipation(placeOfRoot(store, ROOT, 'fake')) as { episodes: Array<{ placeId: string }> }
  ).episodes;
  assert.deepEqual(
    episodes.filter((episode) => episode.placeId === 'd1'),
    []
  );
});

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<{ close: () => Promise<void> }> = [];

after(async () => {
  for (const mem of OPENED_MEMORY) await mem.close();
});

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

// Pictures in a neighbour channel's lines: the captions the describer's cache already holds, never a request.

/**
 * A reply turn in c1 whose guild has one neighbour channel, c2, with a recent message carrying two
 * pictures: np1 (its caption is in the cache) and np2 (not cached). The fake describer's
 * cachedDescriptions answers from `cached` alone; describeMany records every call.
 */
/** Slice 4: a block that leaves a reply stays on a routed turn: a call in #hall (c8), answered in the channel. */
function routedCall(audience?: ChannelSpec['audience']) {
  const call = { ...rawMessage({ id: 'h1', ts: NOW - 3000, content: '@Bot κοίτα' }), placeId: 'c8' };
  fakeTurnChannel({ id: 'c8', name: 'hall', historyMessages: [call], lastMessageAt: NOW - 3000, audience });
  return { trigger: normalizedTrigger(call), source: { placeId: 'c8', reason: 'routed' as const } };
}

// ---------------------------------------------------------------------------
// Drawing: the persona's <draw> goes to the image client after its messages;
// a failed generation gets its own follow-up turn.

// A picture of the persona takes `appearance.png` of the data folder
// as its reference, and the avatar is not fetched for drawing.
const DRAW_IMAGE_CFG = { referenceMaxBytes: 4_000_000 };

const DRAW_FOLDERS: Array<string> = [];

after(() => {
  for (const folder of DRAW_FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A fake createImageGen()-shaped dependency (see src/llm/images.ts). */
function fakeImages({ error = null, mediaType = 'image/png' }: { error?: Error | null; mediaType?: string } = {}) {
  const generateCalls: Array<Untyped> = [];
  return {
    generateCalls,
    generate: async (args: unknown) => {
      generateCalls.push(args);
      if (error) throw error;
      return {
        buffer: Buffer.from('fake picture'),
        mediaType,
        cost: 0.02,
        usage: {},
        model: 'fake/model',
        seconds: 1.5,
      };
    },
  };
}

/** A fake LLM answering each call with the next text of `answers` (the last one repeats). */
/** An LLM answering `answers` in turn (the last one repeats); an answer is its text, or the completion's fields over the defaults. */
function sequenceLlm(answers: Array<string | Record<string, unknown>>) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  return {
    calls,
    options,
    complete: async (messages: unknown, requestOptions: unknown) => {
      calls.push(messages);
      options.push(requestOptions ?? {});
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      return typeof answer === 'string'
        ? { text: answer, usage: {}, estimated: 10 }
        : { usage: {}, estimated: 10, ...answer };
    },
  };
}

function drawHot(
  features: Record<string, unknown> = {},
  image: Record<string, unknown> = {},
  bot: Record<string, unknown> = {}
) {
  const hot = fakeHot({ ...features }, bot, { image: { ...DRAW_IMAGE_CFG, ...image } });
  hot.prompts.draw = 'Drawing for {{name}}.\n\n{{appearance}}\n\n{{request}}';
  hot.prompts.appearance = '{{name}} wears a green scarf.';
  hot.prompts['turn/reply'] = 'Someone called you: {{author}}, they {{trigger}}.';
  return hot;
}

// --- private (DM) turns --------------------------------------------------------

function privateHot(features = {}) {
  const hot = drawHot(features);
  hot.prompts['turn/reply'] = 'Someone called you: {{author}}, they {{trigger}}. You are {{name}}.';
  hot.prompts['turn/private'] = 'PRIVATE_TASK with {{author}} as {{name}}';
  return hot;
}

function privateStore() {
  return fakeStore({
    userProfiles: {
      u1: {
        id: 'u1',
        names: ['Alice'],
        relationship: 'PUBLIC_REL',
        affinity: { score: 10, reason: 'public reason', history: [] },
      },
    },
    privateProfiles: {
      u1: {
        relationship: 'PRIVATE_REL',
        details: [{ id: 1, text: 'PRIVATE_DETAIL', weight: 1 }],
        affinity: { score: 5, reason: '', history: [] },
      },
    },
    channels: [{ id: 'dm1', name: 'dm', lastMessageAt: NOW, days: {} }],
  });
}

async function runPrivateTurn({
  answers = ['<msg reply="#1">hi</msg>'],
  hot = privateHot(),
  store = privateStore(),
  images = fakeImages(),
  selfName = 'GuildBot',
  errands = null,
}: Record<string, Untyped> = {}) {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = sequenceLlm(answers);
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    // The persona's name in the served root is the core's to tell (the member directory, else the name of `hello`).
    getSelfName: () => selfName,
    images,
    errands,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' })
  );
  return { result, logs, channel, llm, store, images, turns };
}

// ---------------------------------------------------------------------------
// Participation: recording the persona's sent lines, the pick classifier, the block.

/** A fake store with the participation store: get returns a copy, set records each write. */
function participationStore(
  initial: { episodes: Array<Untyped>; nextId: number } = { episodes: [], nextId: 1 },
  base = fakeStore({ channels: [{ id: 'c2', name: 'journal', purpose: 'a reading log' }] })
) {
  let value: Untyped = structuredClone(initial);
  const writes: Array<{ placeId: Untyped; state: Untyped; opts: Untyped }> = [];
  return Object.assign(base, {
    writes,
    current: () => value,
    getParticipation: () => structuredClone(value),
    setParticipation: (placeId: string, state: unknown, opts: unknown) => {
      writes.push({ placeId, state, opts });
      value = structuredClone(state);
    },
  });
}

/** The turn's channel c1 with #journal (c2) and #jardin (c3) in its guild, everyone seeing all three. */
function participationChannel(historyMessages: Array<Record<string, unknown>>) {
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages });
  for (const [id, name] of [
    ['c2', 'journal'],
    ['c3', 'jardin'],
  ]) {
    fakeTurnChannel({ id, name });
  }
  return channel;
}

async function runParticipationTurn({
  answers,
  store = participationStore(),
  hot = fakeHot({}),
  history,
  routed = false,
}: Record<string, Untyped> = {}) {
  const raws = history ?? [
    rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Bob', ts: NOW - 5000, content: 'πρώτη γραμμή' }),
    rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000, content: 'θυμάσαι το βιβλίο;' }),
  ];
  const channel = participationChannel(raws);
  const llm = sequenceLlm(answers);
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });
  const params: TurnParams = {
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raws.at(-1) as RawMessage),
    triggerKind: 'mention',
    ...(routed ? routedCall() : {}),
  };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn(params));
  return { result, logs, channel, llm, store };
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

describe('a whole turn', () => {
  test('runTurn: each message sent is recorded as participation with the history lines before it', async () => {
    const { result, store, logs } = await runParticipationTurn({
      answers: ['<msg reply="#2">στο ράφι</msg><msg>το είδα χθες</msg>'],
    });
    assert.equal(result.outcome, 'spoke');
    assert.equal(store.writes.length, 2, 'one write per message sent');
    const [episode] = store.current().episodes;
    assert.equal(episode.placeId, 'c1');
    assert.deepEqual(
      episode.messages.map((m: Untyped) => m.id),
      ['m0', 'm1', 'sent-1', 'sent-2']
    );
    const own = episode.messages.find((m: Untyped) => m.id === 'sent-1');
    assert.equal(own.self, true);
    assert.equal(own.authorId, 'self-id');
    assert.equal(own.name, 'Bot');
    assert.equal(own.text, 'στο ράφι');
    assert.equal(own.replyTo, 'm1');
    assert.equal(episode.messages.find((m: Untyped) => m.id === 'm1').name, 'Alice');
    const firstWrite = store.writes[0];
    assert.equal(firstWrite.opts.now, NOW);
    const firstWriteSettings = firstWrite.opts.settings;
    assert.equal(firstWriteSettings.hours, 72);
    const recorded = logs.filter((l) => l.msg === 'participation: recorded');
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].channel, 'c1');
    assert.equal(recorded[1].episodes, 1);
    assert.ok(!JSON.stringify(recorded).includes('ράφι'), 'no text in the log');
  });

  test('runTurn: a reply to a line older than the lines before it records that line as the parent', async () => {
    // PR 7d: participation.linesBefore is the constant 3, so the parent m0 lies outside the three lines before the reply.
    const raws = [
      rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Bob', ts: NOW - 9000, content: 'η αρχή' }),
      rawMessage({ id: 'mx', authorId: 'u3', authorName: 'Cleo', ts: NOW - 6000, content: 'κάτι άλλο' }),
      rawMessage({ id: 'my', authorId: 'u3', authorName: 'Cleo', ts: NOW - 5000, content: 'κι άλλο' }),
      rawMessage({ id: 'mz', authorId: 'u3', authorName: 'Cleo', ts: NOW - 4000, content: 'και κάτι ακόμα' }),
      rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000, content: 'θυμάσαι;' }),
    ];
    const { store } = await runParticipationTurn({ history: raws, answers: ['<msg reply="#1">ναι, αυτό</msg>'] });
    const [episode] = store.current().episodes;
    assert.deepEqual(
      episode.messages.map((m: Untyped) => m.id),
      ['m0', 'my', 'mz', 'm1', 'sent-1'],
      'the three lines before, the parent m0 ahead of them; mx is left out'
    );
    assert.equal(episode.messages.find((m: Untyped) => m.id === 'sent-1').replyTo, 'm0');
  });

  test('runTurn: a private chat records no participation and shows no block', async () => {
    const store = participationStore({ episodes: [], nextId: 1 }, privateStore());
    const dm = await runPrivateTurn({ store });
    const dmSent = dm.channel.sent;
    assert.equal(dmSent.length, 1);
    assert.equal(store.writes.length, 0);
    const dmCalls = dm.llm.calls;
    assert.ok(!textOf(dmCalls.at(-1)[1].content).includes('<participation>'), 'no block in a private chat');
  });
});
