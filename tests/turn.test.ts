import {
  SPLIT_SYSTEM,
  SPLIT_TEXT,
  SPLIT_PARTS,
  PARTS_ANSWER,
  splitLlm,
  splitHot,
  manualSchedule,
  runSplitTurn,
  partLabel,
  taskOf,
} from './fixtures/turn-split.ts';
// Tests for src/behavior/turn.ts: the pure helpers (between, typingMs, resolveMentions) plus one integration-style
// suite for createTurnRunner itself, driven with fake discord.js-shaped objects, a fake LLM and a fake store --
// proving the feature switches (reactions, multiMessage, typingSimulation, memory) are applied where this module is
// responsible for them.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMentions, mentionDirectory, usableDestination, paceSettings } from '../src/behavior/turn.ts';
import { between, typingMs } from '../src/behavior/random.ts';
import { fillPromptTemplate, userText as textOf } from '../src/behavior/prompt.ts';
import { fill, formatClock, formatDate, formatDuration } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { handleOf } from '../src/behavior/handles.ts';
import { ImageGenError } from '../src/llm/images.ts';
import { DailyCapError, TokenLimitError } from '../src/llm/openrouter.ts';
import { pingStatus } from '../src/behavior/elsewhere.ts';
import { findGif } from '../src/memory/gifs.ts';
import { callMarksOf, createJournal } from '../src/memory/journal.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import '../src/tools/impl/index.ts';
import { loadSkills, skillRegistry } from '../src/tools/registry.ts';
import { createAdmin } from '../src/admin.ts';
import { createDiscordAdapter, createDiscordInterface } from '../interfaces/discord/index.ts';
import { createLocalFacts } from '../src/behavior/inner.ts';
import { freshWorld, world, useIface } from './fixtures/turn-world.ts';
import type { ChannelSpec } from './fixtures/turn-world.ts';
import type { TriggerKind } from '../src/turn/triggers.ts';
import type { TurnParams } from '../src/turn/outcome.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';
import { snapshotOf } from '../src/behavior/snapshot.ts';
import { openTestMemorySync, journalLabel } from './fixtures/memory-db/service.ts';
import { asRecord } from './fixtures/records.ts';
import type { Untyped } from '../src/tools/types.ts';
import {
  LOOKUP_SYSTEM,
  NOW,
  PAGE_EMBED,
  fakeClient,
  fakeHot,
  fakeImageFetcher,
  fakeLlm,
  fakeLookup,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  linkRaw,
  lookupHot,
  lookupLlm,
  normalizedTrigger,
  rawMessage,
  runLookupTurn,
  withoutTools,
} from './fixtures/turn-kit.ts';
import type { FakeHot, FakeStore, RawMessage } from './fixtures/turn-kit.ts';

/** What she did through a port: its calls but the reads a turn makes of it. */
function effectsOf(port: Untyped) {
  return port.calls.filter((call: Untyped) =>
    ['typing', 'send', 'edit', 'delete', 'react', 'unreact'].includes(call.op)
  );
}

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<{ close: () => Promise<void> }> = [];
after(async () => {
  for (const mem of OPENED_MEMORY) await mem.close();
});

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

function rngReturning(value: number) {
  return () => value;
}

test('between: rng=0.5 returns the midpoint', () => {
  assert.equal(between([10, 20], rngReturning(0.5)), 15);
});

type TypingConfig = Parameters<typeof typingMs>[1];

test('typingMs: clamps below minMs for very short text', () => {
  const cfg: TypingConfig = { msPerChar: [1, 1], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a', cfg, rngReturning(0)); // 1 char * 1ms/char = 1ms, way under minMs
  assert.equal(ms, 900);
});

test('typingMs: clamps above maxMs for very long text', () => {
  const cfg: TypingConfig = { msPerChar: [100, 100], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a'.repeat(1000), cfg, rngReturning(0)); // 100,000ms, way over maxMs
  assert.equal(ms, 12000);
});

test('typingMs: within range uses length * msPerChar (rounded)', () => {
  const cfg: TypingConfig = { msPerChar: [10, 10], minMs: 0, maxMs: 100000 };
  const ms = typingMs('a'.repeat(20), cfg, rngReturning(0));
  assert.equal(ms, 200);
});

function historyMsg(authorName: string, authorId: string, overrides = {}) {
  return { authorName, authorId, self: false, bot: false, ...overrides };
}

test('resolveMentions: replaces a known @name with a real Discord mention', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('γεια @Alice πώς είσαι', history);
  assert.equal(result.text, 'γεια <@u1> πώς είσαι');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: an unknown name is left untouched', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('γεια @Ghost', history);
  assert.equal(result.text, 'γεια @Ghost');
  assert.deepEqual(result.userIds, []);
});

test('resolveMentions: excludes its own lines and bot lines from candidates', () => {
  const history = [
    historyMsg('Zoë', 'self-id', { self: true }),
    historyMsg('SomeBot', 'bot-id', { bot: true }),
    historyMsg('Alice', 'u1'),
  ];
  const result = resolveMentions('@Zoë @SomeBot @Alice', history);
  assert.equal(result.text, '@Zoë @SomeBot <@u1>');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: longer names are matched before their shorter prefixes', () => {
  const history = [historyMsg('Anna', 'short-id'), historyMsg('AnnaMaria', 'long-id')];
  const result = resolveMentions('γεια @AnnaMaria', history);
  // Must not first match "@Anna" inside "@AnnaMaria" and leave "Maria" dangling.
  assert.equal(result.text, 'γεια <@long-id>');
  assert.deepEqual(result.userIds, ['long-id']);
});

test('resolveMentions: replaces every occurrence of the same name', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Alice γεια @Alice', history);
  assert.equal(result.text, '<@u1> γεια <@u1>');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: deduplicates authors that appear more than once in history', () => {
  const history = [historyMsg('Alice', 'u1'), historyMsg('Alice', 'u1', { content: 'again' })];
  const result = resolveMentions('@Alice', history);
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: a stored multi-word name of a member shown resolves', () => {
  const history = [historyMsg('Whammy', 'u3')];
  const known = [
    { name: 'Más tarde nunca', id: 'u3' },
    { name: 'Whammy', id: 'u3' },
  ];
  const result = resolveMentions('@Más tarde nunca ναι', history, known);
  assert.equal(result.text, '<@u3> ναι');
  assert.deepEqual(result.userIds, ['u3']);
});

test('resolveMentions: a transcript author wins a name a stored profile shares', () => {
  const history = [historyMsg('Bob', 'u2')];
  const result = resolveMentions('@Bob ναι', history, [{ name: 'Bob', id: 'u7' }]);
  assert.equal(result.text, '<@u2> ναι');
  assert.deepEqual(result.userIds, ['u2']);
});

test('resolveMentions: a name only a member not handed over carries stays text', () => {
  // The caller hands over the members the request showed; anyone else is no candidate.
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Ταξιάρχης γεια', history, [{ name: 'Αλίκη', id: 'u1' }]);
  assert.equal(result.text, '@Ταξιάρχης γεια');
  assert.deepEqual(result.userIds, []);
});

test('resolveMentions: a stored name containing a shorter transcript name is matched first', () => {
  const history = [historyMsg('Anna', 'short-id')];
  const result = resolveMentions('@Anna María, @Anna', history, [{ name: 'Anna María', id: 'long-id' }]);
  assert.equal(result.text, '<@long-id>, <@short-id>');
  assert.deepEqual(result.userIds, ['long-id', 'short-id']);
});

test('resolveMentions: the first member handed over keeps a stored name two share; empty names are skipped', () => {
  const known = [
    { name: 'Zoé', id: 'z1' },
    { name: 'Zoé', id: 'z2' },
    { name: '', id: 'z3' },
    { name: ' ', id: 'z4' },
  ];
  const result = resolveMentions('@Zoé @ x', [], known);
  assert.equal(result.text, '<@z1> @ x');
  assert.deepEqual(result.userIds, ['z1']);
});

// The fallback directory: every member of the served guild the bot knows, behind the request's own sources.

/** A discord.js-shaped GuildMember: `displayName` (the nickname, else the global name), `nickname`, `user`. */
function cachedMember(
  id: string,
  {
    username,
    globalName = null,
    nickname = null,
    bot = false,
  }: { username: string; globalName?: string | null; nickname?: string | null; bot?: boolean }
) {
  return { id, nickname, displayName: nickname ?? globalName ?? username, user: { id, username, globalName, bot } };
}

test('resolveMentions: a member the request never showed resolves through the fallback directory', () => {
  const directory = [{ name: 'Ταξιάρχης', id: 'u9' }];
  const result = resolveMentions('@Ταξιάρχης https://example.com/a', [historyMsg('Alice', 'u1')], [], directory);
  assert.equal(result.text, '<@u9> https://example.com/a');
  assert.deepEqual(result.userIds, ['u9']);
});

test('resolveMentions: a fallback name two members carry stays text, whatever its case', () => {
  const directory = [
    { name: 'Zoé', id: 'z1' },
    { name: 'zoé', id: 'z2' },
    { name: 'Zoé', id: 'z1' },
  ];
  const result = resolveMentions('@Zoé @ZOÉ ναι', [], [], directory);
  assert.equal(result.text, '@Zoé @ZOÉ ναι');
  assert.deepEqual(result.userIds, []);
});

test("resolveMentions: the request's own sources win a name the fallback directory also has", () => {
  const history = [historyMsg('Bob', 'u2')];
  const known = [{ name: 'Αλίκη', id: 'u1' }];
  const directory = [
    { name: 'Bob', id: 'u7' },
    { name: 'bob', id: 'u8' },
    { name: 'Αλίκη', id: 'u5' },
  ];
  const result = resolveMentions('@Bob @Αλίκη @bob', history, known, directory);
  assert.equal(
    result.text,
    '<@u2> <@u1> <@u2>',
    'a shown member keeps the name in any case; an ambiguous fallback never takes it'
  );
  assert.deepEqual(result.userIds, ['u1', 'u2']);
});

test('resolveMentions: the fallback matches case-insensitively, longest first and only as a whole name', () => {
  const directory = [
    { name: 'Anna María', id: 'long' },
    { name: 'Anna', id: 'short' },
    { name: 'Kai', id: 'k1' },
  ];
  const result = resolveMentions('@anna maría, @ANNA, @Kaiser', [], [], directory);
  assert.equal(result.text, '<@long>, <@short>, @Kaiser');
  assert.deepEqual(result.userIds, ['long', 'short']);
});

test('resolveMentions: the case-insensitive fallback is for the directory only, never a shown name', () => {
  const result = resolveMentions('@alice', [historyMsg('Alice', 'u1')], [], []);
  assert.equal(result.text, '@alice');
  assert.deepEqual(result.userIds, []);
});

test('mentionDirectory: every name of the cached members and of the stored profiles, never a bot or the persona', () => {
  const members = [
    cachedMember('u1', { username: 'alice_01', globalName: 'Alice', nickname: 'Αλίκη' }),
    cachedMember('b1', { username: 'HelperBot', bot: true }),
    cachedMember('self-id', { username: 'persona', globalName: 'Persona' }),
  ];
  const profiles = [
    { id: 'u2', names: ['Bob'], aliases: [{ name: 'Bobby' }, { name: '' }, null] },
    { id: 'b1', names: ['HelperBot'], aliases: [] },
    { id: 'self-id', names: ['Persona'], aliases: [] },
    { id: 'u1', names: ['Alice'], aliases: [{ name: 'Lis' }] },
  ];
  const directory = mentionDirectory({ members, profiles, selfId: 'self-id' });
  const byId = (id: string) =>
    directory
      .filter((entry) => entry.id === id)
      .map((entry) => entry.name)
      .sort();
  assert.deepEqual(byId('u1'), ['Alice', 'Lis', 'alice_01', 'Αλίκη']);
  assert.deepEqual(byId('u2'), ['Bob', 'Bobby']);
  assert.deepEqual(byId('b1'), []);
  assert.deepEqual(byId('self-id'), []);
});

test('mentionDirectory: no sources give an empty directory', () => {
  assert.deepEqual(mentionDirectory({}), []);
});

// ---------------------------------------------------------------------------
// createTurnRunner — integration-style, fake channel/llm/store/hot.

// /nep pause: no new turn may start while paused -- a reply, an
// interject, an initiate, an eavesdrop or a forced turn alike, whatever the mode.
test('runTurn: refuses with outcome "paused" while store.state.data.paused is true, before touching the LLM or busy', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const store = fakeStore();
  store.state.data.paused = true;
  const hot = fakeHot();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });

  assert.equal(result.outcome, 'paused');
  assert.equal(llm.calls.length, 0, 'the LLM must never be called while paused');
  assert.equal(turns.isBusy(channel.id), false, 'the channel is never marked busy for a refused turn');
});

// /nep interject, /nep initiate: forced is passed straight through to
// buildRequest, which appends prompts.forced (when present) to the task text.
test('runTurn: forced=true appends prompts.forced to the task text sent to the LLM', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const store = fakeStore();
  const hot = fakeHot();
  hot.prompts.forced = 'FORCED_TASK_TEXT';
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  await turns.runTurn({ channel, mode: 'interject', forced: true });

  assert.equal(llm.calls.length, 1);
  const userText = textOf(llm.calls[0][1].content);
  assert.ok(userText.includes('FORCED_TASK_TEXT'));
});

test('runTurn: forced defaults to false -- prompts.forced is never appended for an ordinary spontaneous turn', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const store = fakeStore();
  const hot = fakeHot();
  hot.prompts.forced = 'FORCED_TASK_TEXT';
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  await turns.runTurn({ channel, mode: 'interject' });

  assert.equal(llm.calls.length, 1);
  const userText = textOf(llm.calls[0][1].content);
  assert.ok(!userText.includes('FORCED_TASK_TEXT'));
});

test('waitIdle: resolves immediately when no turn is in flight', async () => {
  const store = fakeStore();
  const hot = fakeHot();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm: fakeLlm('<msg>hi</msg>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  let resolved = false;
  turns.waitIdle().then(() => {
    resolved = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, true);
});

test('waitIdle: resolves only once every in-flight turn has finished', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const store = fakeStore();
  const hot = fakeHot();
  let releaseLlm: (() => void) | undefined;
  const llm = {
    complete: () =>
      new Promise((resolve) => {
        releaseLlm = () => resolve({ text: '<msg>hi</msg>', usage: {}, estimated: 1 });
      }),
  };
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  const turnPromise = turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  // Let runTurn's own awaits (fetchHistory, withTextPreviews, fetchNeighbors,
  // buildRequest...) settle before it reaches the still-pending LLM call.
  await new Promise((resolve) => setTimeout(resolve, 0));

  let idleResolved = false;
  const idlePromise = turns.waitIdle().then(() => {
    idleResolved = true;
  });
  assert.equal(idleResolved, false, 'must not resolve while the turn is still in flight');

  releaseLlm?.();
  await turnPromise;
  await idlePromise;
  assert.equal(idleResolved, true);
});

test('createTurnRunner: features.memory=true renders <people> and <about_chat>', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    guildMemory: { patterns: 'lots of emoji' },
    userProfiles: { u1: { id: 'u1', names: ['Alice'], character: 'friendly' } },
  });
  const hot = fakeHot({});
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes('<people>'));
  assert.ok(userMessage.includes('<about_chat>'));
});

test('createTurnRunner: features.memory=true renders the <server> channel map', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    channels: [
      {
        id: 'c1',
        name: 'general',
        category: null,
        topic: null,
        purpose: '',
        topics: '',
        tone: '',
        days: {},
        lastMessageAt: null,
      },
    ],
  });
  const hot = fakeHot({});
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes('<server>'));
  assert.ok(userMessage.includes(`# general${labels.server.currentMark}`));
});

test('createTurnRunner: features.memory=true renders <lore> from the guild lorebook', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const loreEntries = [
    {
      id: 'l1',
      title: 'The Great Flood',
      keys: ['never-mentioned'],
      text: 'It flooded once.',
      always: true,
      source: 'analyzer',
      weight: 3,
    },
  ];
  const store = fakeStore({ loreEntries });
  const hot = fakeHot({});
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes('<lore>'));
  assert.ok(userMessage.includes('The Great Flood'));
});

// ---------------------------------------------------------------------------
// features.mediaDescriptions -- describing pictures that are not attached.

function fakeDescriber(descriptionsById: Untyped) {
  const calls: Array<{ guildId: Untyped; items: Untyped; options: Untyped }> = [];
  return {
    calls,
    describeMany: async (guildId: string, items: Untyped, options: unknown) => {
      calls.push({ guildId, items, options });
      const descriptions = new Map();
      for (const item of items) {
        if (descriptionsById[item.itemId]) descriptions.set(item.itemId, descriptionsById[item.itemId]);
      }
      return { descriptions, newCount: descriptions.size };
    },
  };
}

/** fakeDescriber plus describeVideos: every candidate in `statesById` gets that state. */
function fakeVideoDescriber(statesById: Untyped, descriptionsById = {}) {
  const base = fakeDescriber(descriptionsById);
  const videoCalls: Array<{ guildId: Untyped; items: Untyped; options: Untyped }> = [];
  return {
    ...base,
    videoCalls,
    describeVideos: async (guildId: string, items: Untyped, options: unknown) => {
      videoCalls.push({ guildId, items, options });
      const videos = new Map();
      for (const item of items) {
        if (statesById[item.itemId]) videos.set(item.itemId, statesById[item.itemId]);
      }
      return { videos, newCount: videos.size };
    },
  };
}

function videoAttachmentRaw(id: string, ts: number, attachmentId: string, name: string) {
  return rawMessage({
    id,
    ts,
    attachments: new Map([
      [
        attachmentId,
        {
          id: attachmentId,
          contentType: 'video/mp4',
          name,
          url: `https://cdn.discordapp.com/attachments/1/2/${name}`,
          duration: 20,
        },
      ],
    ]),
  });
}

const VIDEO_TURN_CONFIG = {
  media: { maxPerTurn: 6, filePreviewChars: 500, video: { maxPerTurn: 1, sites: ['youtube.com'] } },
};

test('createTurnRunner: features.videoDescriptions on -- videos newest first, capped at media.video.maxPerTurn, rendered watched', async () => {
  const older = videoAttachmentRaw('m1', NOW - 5000, 'va', 'older.mp4');
  const newer = rawMessage({ id: 'm2', ts: NOW - 1000, content: 'look https://www.youtube.com/watch?v=abc' });
  const channel = fakeTurnChannel({ historyMessages: [older, newer] });
  const llm = fakeLlm('<msg>ok</msg>');
  const hot = fakeHot({}, {}, VIDEO_TURN_CONFIG);
  const describer = fakeVideoDescriber({ va: { state: 'watched', text: 'κάποιος χορεύει' } });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(newer), triggerKind: 'mention' });

  assert.equal(describer.videoCalls.length, 1);
  const { guildId, items, options } = describer.videoCalls[0];
  assert.equal(guildId, 'g1');
  assert.deepEqual(
    items.map((item: Untyped) => item.source),
    ['link', 'attachment'],
    'the newest message first; the typed video link is found because fetchHistory got media.video.sites'
  );
  assert.equal(items[1].itemId, 'va');
  // PR 7d: media.video.maxPerTurn is the constant VIDEOS_PER_TURN (5, the production value).
  assert.deepEqual(options, { maxNew: 5 }, 'every describer request counts: no daily-cap option is passed');
  const userMessage = textOf(llm.calls[0][1].content);
  const watched = labels.transcript.videoWatched
    .replace('{name}', 'older.mp4')
    .replace('{duration}', '0:20')
    .replace('{text}', 'κάποιος χορεύει');
  assert.ok(userMessage.includes(watched));
});

test('createTurnRunner: features.mediaDescriptions on describes an un-attached picture and it renders imageDescribed', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['img1', { id: 'img1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png' }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const describer = fakeDescriber({ img1: 'a grey cat' });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'img1');
  assert.equal(describer.calls[0].options.maxNew, 6);
  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes(labels.transcript.imageDescribed.replace('{text}', 'a grey cat')));
});

// A picture in the trigger reaches the persona as the helper's caption only, never as an image part.

/** What `describeMany` of a fake was asked. */
type DescribeCall = { guildId: string; items: Array<Untyped>; options: Untyped };

function pictureTurn({
  features,
  media,
  newer = false,
}: {
  features: Record<string, unknown>;
  media?: Record<string, unknown>;
  newer?: boolean;
}) {
  const pic = { id: 'i1', contentType: 'image/png', name: 'one.png', url: 'https://cdn.discordapp.com/x/one.png' };
  const raw = rawMessage({ id: 'm2', attachments: new Map([['i1', pic]]) });
  const history = [raw];
  if (newer) {
    // A picture posted right after the trigger: newer, so captioned first.
    const other = {
      id: 'o1',
      contentType: 'image/png',
      name: 'other.png',
      url: 'https://cdn.discordapp.com/x/other.png',
    };
    history.push(rawMessage({ id: 'm3', ts: NOW - 500, attachments: new Map([['o1', other]]) }));
  }
  const channel = fakeTurnChannel({ historyMessages: history });
  const llm = fakeLlm('<msg>ok</msg>');
  const hot = fakeHot(features, {}, media ? { media } : {});
  // Like fakeDescriber, but honours maxNew the way describeMany does (every caption here is new).
  const captions: Record<string, string> = { i1: 'a grey cat', o1: 'a red fox' };
  const describer = {
    calls: [] as Array<DescribeCall>,
    describeMany: async (guildId: string, items: Array<Untyped>, options: Untyped) => {
      describer.calls.push({ guildId, items, options });
      const descriptions = new Map();
      for (const item of items) {
        if (descriptions.size >= (options?.maxNew ?? Infinity)) break;
        if (captions[item.itemId]) descriptions.set(item.itemId, captions[item.itemId]);
      }
      return { descriptions, newCount: descriptions.size };
    },
  };
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    imageFetcher: fakeImageFetcher(),
  });
  const trigger = {
    ...normalizedTrigger(raw),
    attachments: [{ id: 'i1', kind: 'image', url: pic.url, name: 'one.png' }],
  };
  return { channel, llm, describer, turns, trigger };
}

function userText(llm: Untyped): string {
  return textOf(llm.calls[0][1].content);
}

test("createTurnRunner: the trigger's picture is captioned by the describer and never sent as an image_url part", async () => {
  const { channel, llm, describer, turns, trigger } = pictureTurn({ features: {} });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.deepEqual(
    describer.calls[0].items.map((item: Untyped) => item.itemId),
    ['i1']
  );
  assert.ok(
    llm.calls[0][1].content.every((p: Untyped) => p.type === 'text'),
    'the request is text parts only'
  );
  const text = userText(llm);
  assert.ok(text.includes(labels.transcript.imageDescribed.replace('{text}', 'a grey cat')));
  assert.ok(
    !text.includes(labels.transcript.imageAttached.replace('{n}', '1')),
    'no line claims the picture is attached'
  );
});

test('createTurnRunner: captions go newest message first, media.maxPerTurn still caps new captions', async () => {
  const { channel, llm, describer, turns, trigger } = pictureTurn({
    features: {},
    media: { maxPerTurn: 1, filePreviewChars: 500 },
    newer: true,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.deepEqual(
    describer.calls[0].items.map((item: Untyped) => item.itemId),
    ['o1', 'i1'],
    'the newest picture first'
  );
  // PR 7d: media.maxPerTurn is the constant MEDIA_PER_TURN (6, the production value), so both pictures are captioned.
  assert.equal(describer.calls[0].options.maxNew, 6);
  const text = userText(llm);
  assert.ok(text.includes(labels.transcript.imageDescribed.replace('{text}', 'a red fox')));
  assert.ok(text.includes(labels.transcript.imageDescribed.replace('{text}', 'a grey cat')));
});

test('createTurnRunner: features.mediaDescriptions on describes a picture-format sticker via the same describer/cache path', async () => {
  const raw = rawMessage({
    id: 'm1',
    stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const describer = fakeDescriber({ 'sticker:s1': 'a frog gives a thumbs up' });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'sticker:s1');
  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(
    userMessage.includes(
      labels.transcript.stickerDescribed.replace('{name}', 'pepe').replace('{text}', 'a frog gives a thumbs up')
    )
  );
});

test('createTurnRunner: features.mediaDescriptions on describes a custom emoji in the text, appended as an extra tag', async () => {
  const raw = rawMessage({ id: 'm1', content: 'nice <:pog:111> job' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const describer = fakeDescriber({ 'emoji:111': 'a surprised cat face' });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'emoji:111');
  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes('nice :pog: job'));
  assert.ok(
    userMessage.includes(
      labels.transcript.emojiDescribed.replace('{name}', 'pog').replace('{text}', 'a surprised cat face')
    )
  );
});

// Pictures in a neighbour channel's lines: the captions the describer's cache already holds, never a request.

/**
 * A reply turn in c1 whose guild has one neighbour channel, c2, with a recent message carrying two
 * pictures: np1 (its caption is in the cache) and np2 (not cached). The fake describer's
 * cachedDescriptions answers from `cached` alone; describeMany records every call.
 */
function neighborPictureTurn(features: Record<string, unknown>) {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const posted = {
    ...rawMessage({
      id: 'n1',
      authorId: 'u2',
      authorName: 'Bob',
      ts: NOW - 2000,
      content: 'look',
      attachments: new Map([
        ['np1', { id: 'np1', contentType: 'image/png', name: 'cat.png', url: 'https://cdn.discordapp.com/x/cat.png' }],
        ['np2', { id: 'np2', contentType: 'image/png', name: 'dog.png', url: 'https://cdn.discordapp.com/x/dog.png' }],
      ]),
    }),
    channelId: 'c2',
  };
  fakeTurnChannel({ id: 'c2', name: 'random', historyMessages: [posted], lastMessageAt: NOW - 2000 });
  const cached: Record<string, string> = { np1: 'a sleeping cat' };
  const describer = {
    calls: [] as Array<DescribeCall>,
    cachedCalls: [] as Array<{ guildId: string; items: Array<Untyped> }>,
    describeMany: async (guildId: string, items: Array<Untyped>, options: Untyped) => {
      describer.calls.push({ guildId, items, options });
      return { descriptions: new Map(), newCount: 0 };
    },
    cachedDescriptions: (guildId: string, items: Untyped) => {
      describer.cachedCalls.push({ guildId, items });
      return new Map(
        items.filter((item: Untyped) => cached[item.itemId]).map((item: Untyped) => [item.itemId, cached[item.itemId]])
      );
    },
  };
  const llm = fakeLlm('<msg>ok</msg>');
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(features),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    now: () => NOW,
  });
  return { channel, llm, describer, turns, trigger: normalizedTrigger(raw) };
}

/** The `<other_channels>` body of the first request the fake LLM received. */
function otherChannelsSent(llm: unknown) {
  return userText(llm).split('<other_channels>\n')[1].split('\n</other_channels>')[0];
}

test('runTurn: a neighbour picture already in the describer cache renders with its caption; an uncached one stays blind', async () => {
  const { channel, llm, describer, turns, trigger } = neighborPictureTurn({ mediaDescriptions: true });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.cachedCalls.length, 1);
  assert.equal(describer.cachedCalls[0].guildId, 'g1');
  assert.deepEqual(describer.cachedCalls[0].items.map((item: Untyped) => item.itemId).sort(), ['np1', 'np2']);
  const others = otherChannelsSent(llm);
  assert.ok(others.includes('# random'), others);
  assert.ok(others.includes(fill(labels.transcript.imageDescribed, { text: 'a sleeping cat' })), others);
  assert.ok(others.includes(labels.transcript.image), 'the uncached picture keeps its blind form');
});

test('runTurn: no describe request is made for a neighbour picture', async () => {
  const { channel, describer, turns, trigger } = neighborPictureTurn({ mediaDescriptions: true });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  const requested = describer.calls.flatMap((call) => call.items.map((item: Untyped) => item.itemId));
  assert.ok(!requested.includes('np1') && !requested.includes('np2'), JSON.stringify(requested));
});

test('createTurnRunner: a text attachment is fetched lazily and rendered via filePreview', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['t1', { id: 't1', contentType: 'text/plain', name: 'notes.txt', url: 'https://cdn/notes.txt' }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  let fetchedUrl = null;
  const fetchImpl = async (url: string) => {
    fetchedUrl = url;
    return { ok: true, headers: { get: () => null }, text: async () => 'the file says hello' };
  };
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    fetchImpl,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(fetchedUrl, 'https://cdn/notes.txt');
  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(
    userMessage.includes(
      labels.transcript.filePreview.replace('{name}', 'notes.txt').replace('{text}', 'the file says hello')
    )
  );
});

test('createTurnRunner: a text-attachment fetch failure falls back to the plain file form', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['t1', { id: 't1', contentType: 'text/plain', name: 'notes.txt', url: 'https://cdn/notes.txt' }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    fetchImpl,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes(labels.transcript.file.replace('{name}', 'notes.txt')));
});

// ---------------------------------------------------------------------------
// A provider's 4xx is never resent: the request is text only, there is nothing to strip.

function fakeLlmRejectingOnce(statusCode: number, responseText: string) {
  const calls: Array<Untyped> = [];
  const optionCalls: Array<Untyped> = [];
  let first = true;
  return {
    calls,
    optionCalls,
    complete: async (messages: Untyped, options: Untyped) => {
      calls.push(messages);
      optionCalls.push(options);
      if (first) {
        first = false;
        const err = Object.assign(new Error('bad request'), { statusCode });
        throw err;
      }
      return completionOf(responseText);
    },
  };
}

function videoTrigger(raw: ReturnType<typeof rawMessage>) {
  return {
    ...normalizedTrigger(raw),
    attachments: [
      {
        id: 'v1',
        kind: 'video',
        url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
        name: 'clip.mp4',
        durationSec: 34,
      },
    ],
  };
}

test('createTurnRunner: a 4xx from the provider is not resent, the turn ends in error', async () => {
  const raw = rawMessage({ id: 'm1', content: 'hello there' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlmRejectingOnce(400, '<msg>never posted</msg>');
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot({}),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    imageFetcher: fakeImageFetcher(),
  });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );

  assert.ok(
    llm.calls[0][1].content.every((p: Untyped) => p.type === 'text'),
    'the request is text only'
  );
  assert.equal(result.outcome, 'error');
  assert.equal(llm.calls.length, 1, 'the model is called once, never resent');
  assert.equal(channel.sent.length, 0);
});

// ---------------------------------------------------------------------------
// A video in the trigger renders in the transcript by its tag; nothing of it is downloaded for
// the persona's request (her eyes are the describer's).

function videoRaw(id = 'm1') {
  return rawMessage({
    id,
    attachments: new Map([
      [
        'v1',
        {
          id: 'v1',
          contentType: 'video/mp4',
          name: 'clip.mp4',
          url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
          duration: 34,
        },
      ],
    ]),
  });
}

test('createTurnRunner: a video in the trigger renders by its tag, nothing is downloaded and no image part is sent', async () => {
  const raw = videoRaw();
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const imageFetcher = fakeImageFetcher();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot({}),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    imageFetcher,
  });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(imageFetcher.calls.length, 0);
  const parts = llm.calls[0][1].content;
  assert.ok(parts.every((p: Untyped) => p.type === 'text'));
  assert.ok(textOf(parts).includes('[video: clip.mp4, 0:34]'), 'the video renders by its tag');
});

/** fakeStore whose guild keeps `pingsOff`, the members who turned the persona's notifications off. */
function storeWithPingsOff(pingsOff: Untyped) {
  const store = fakeStore();
  store.pingsCalls = [];
  store.isPingsOff = (guildId: string, userId: string) => {
    store.pingsCalls.push([guildId, userId]);
    return pingsOff.includes(userId);
  };
  return store;
}

// The mention handles of the two authors of runPingsTurn's chat (src/behavior/handles.ts).
const ALICE = `@${handleOf('u1')}`;
const BOB = `@${handleOf('u2')}`;

/** One reply turn in c1: Bob's older line, then Alice's trigger; the persona replies to the reply="#2" line. */
async function runPingsTurn(store: unknown, answer: string, features = {}) {
  const bob = rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Bob', ts: NOW - 5000, content: 'ola' });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [bob, raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(features),
    store,
    llm: fakeLlm(answer),
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  assert.equal(result.outcome, 'spoke');
  return channel;
}

test('runTurn: a reply to a member with pings off does not ping them; their mention stays in the text but notifies nobody', async () => {
  const store = storeWithPingsOff(['u1']);
  const channel = await runPingsTurn(store, `<msg reply="#2">${ALICE} ${BOB} ναι</msg>`);

  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, '<@u1> <@u2> ναι', 'the text is never changed');
  assert.deepEqual(channel.sent[0].reply, { messageReference: 'm1', failIfNotExists: false });
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [], users: ['u2'], repliedUser: false });
  assert.ok(store.pingsCalls.every(([guildId]: Array<unknown>) => guildId === 'g1'));
});

test('runTurn: a mentioned member with pings off is left out of users while the replied author with pings on is still pinged', async () => {
  const channel = await runPingsTurn(storeWithPingsOff(['u2']), `<msg reply="#2">${BOB} ναι</msg>`);

  assert.equal(channel.sent[0].content, '<@u2> ναι');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [], users: [], repliedUser: true });
});

test('runTurn: with nobody in pingsOff the reply and the mentions notify as before', async () => {
  const channel = await runPingsTurn(storeWithPingsOff([]), `<msg reply="#2">${ALICE} ${BOB} ναι</msg>`);

  assert.deepEqual(channel.sent[0].reply, { messageReference: 'm1', failIfNotExists: false });
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [], users: ['u1', 'u2'], repliedUser: true });
});

test('runTurn: only an exact @handle mentions; a name and a handle nobody has stay text, the unknown one logged', async () => {
  const unknown = ['@u0000', '@uzzzz'].find((token) => token !== ALICE && token !== BOB);
  const { result: channel, logs } = await withCapturedLogs(() =>
    runPingsTurn(storeWithPingsOff([]), `<msg>${BOB} @Alice @Bob ${unknown} ναι</msg>`)
  );

  assert.equal(channel.sent[0].content, `<@u2> @Alice @Bob ${unknown} ναι`, 'no name is matched, whoever carries it');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [], users: ['u2'], repliedUser: true });
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'turn: unknown handle').map((entry) => [entry.channel, entry.count]),
    [['c1', 1]],
    'logged once, at the send'
  );
});

test('runTurn: a member of the directory not in view is mentioned by the handle the request listed', async () => {
  const store = storeWithPingsOff([]);
  store.listUserProfiles = () => [{ id: 'u5', names: ['Ταξιάρχης'], aliases: [{ name: 'Τάκης', weight: 3 }] }];
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const hot = fakeHot();
  hot.prompts.labels = {
    ...labels,
    directory: { lead: 'DIRECTORY', line: '{handle} {names}', lineAliases: '{handle} {names} aka {aliases}' },
  };
  const llm = fakeLlm(`<msg>@${handleOf('u5')} @Τάκης ναι</msg>`);
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });

  assert.equal(result.outcome, 'spoke');
  const stable = llm.calls[0][1].content.find((part: Untyped) => part.cacheSegment === 'stable').text;
  assert.ok(
    stable.includes(`<directory>\nDIRECTORY\n@${handleOf('u5')} "Ταξιάρχης" aka "Τάκης"\n</directory>`),
    stable
  );
  assert.equal(channel.sent[0].content, '<@u5> @Τάκης ναι', 'the alias written as a name stays text');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [], users: ['u5'], repliedUser: true });
});

// ---------------------------------------------------------------------------
// The web lookup: read links and the search on a question.

test('createTurnRunner: lookup -- readable links (no video site, no gif) go to readLinks newest first; reads reach the transcript', async () => {
  const lookup = fakeLookup({ reads: { 'm1#e0': 'une recette, trois œufs' } });
  const { llm } = await runLookupTurn({ lookup });

  assert.equal(lookup.readCalls.length, 1);
  const { guildId, links, options } = lookup.readCalls[0];
  assert.equal(guildId, 'g1');
  assert.deepEqual(
    links.map((l: Untyped) => l.id),
    ['m1#e0']
  );
  assert.equal(links[0].url, 'https://example.org/a');
  assert.equal(options.maxNew, 2);
  const userMessage = textOf(llm.turnCalls[0].messages[1].content);
  assert.ok(userMessage.includes('[link: example.org — Crêpes] [page read: une recette, trois œufs]'), userMessage);
});

test('createTurnRunner: lookup -- links are offered newest message first', async () => {
  const lookup = fakeLookup();
  const history = [
    linkRaw('m1', NOW - 9000, [PAGE_EMBED]),
    linkRaw('m2', NOW - 5000, [{ ...PAGE_EMBED, url: 'https://example.org/b', title: 'B' }]),
    rawMessage({ id: 'm3', ts: NOW - 1000, content: 'λοιπόν;' }),
  ];
  await runLookupTurn({ lookup, history });
  assert.deepEqual(
    lookup.readCalls[0].links.map((l: Untyped) => l.id),
    ['m2#e0', 'm1#e0']
  );
});

test('createTurnRunner: lookup -- a turn a returned errand opened runs no engine lookup and has no <lookup> block', async () => {
  const lookup = fakeLookup();
  const taskResult = {
    id: 't1',
    agent: 'scout',
    goal: 'βρες τον νικητή',
    state: 'done',
    result: { text: 'ο νικητής', files: [] },
  };
  const { llm, result } = await runLookupTurn({
    lookup,
    llm: lookupLlm('champions final winner 2026'),
    triggerKind: 'errand',
    taskResult,
  });
  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.classifierCalls.length, 0, 'no search classifier on the result turn');
  assert.equal(lookup.searchCalls.length, 0);
  const turnUser = textOf(llm.turnCalls[0].messages[1].content);
  assert.ok(!turnUser.includes('\n<lookup>\n'), turnUser);
  assert.ok(turnUser.includes('ο νικητής'), 'the errand result is shown');
});

// ---------------------------------------------------------------------------
// Drawing: the persona's <draw> goes to the image client after its messages;
// a failed generation gets its own follow-up turn.

const DRAW_IMAGE_CFG = { maxPromptChars: 800, reference: 'avatar', referenceMaxBytes: 4_000_000 };

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
  hot.prompts.reply = 'Someone called you: {{author}}, they {{trigger}}.';
  return hot;
}

async function runDrawTurn({
  answers,
  hot = drawHot(),
  images = fakeImages(),
  client = fakeClient(),
  imageFetcher = fakeImageFetcher(),
  withTrigger = true,
  attachFiles = true,
  triggerKind = 'mention',
}: {
  answers: Array<string | Record<string, unknown>>;
  hot?: FakeHot;
  images?: ReturnType<typeof fakeImages>;
  client?: ReturnType<typeof fakeClient>;
  imageFetcher?: ReturnType<typeof fakeImageFetcher>;
  withTrigger?: boolean;
  attachFiles?: boolean;
  triggerKind?: TriggerKind;
}) {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'draw me a cat' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw], attachFiles });
  const llm = sequenceLlm(answers);
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client,
    images,
    imageFetcher,
  });
  const params: TurnParams = withTrigger
    ? { channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind }
    : { channel, mode: 'interject' };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn(params));
  return { result, logs, channel, llm, images, imageFetcher, turns };
}

function userTextOf(messages: Untyped): string {
  const content: Untyped = textOf(messages[1].content);
  return Array.isArray(content) ? content.find((part: Untyped) => part.type === 'text').text : content;
}

test('runTurn: a draw.create call goes out before her messages, as a file; the messages follow', async () => {
  const { result, channel, images } = await runDrawTurn({
    answers: [
      toolAnswer('<msg>one sec</msg><msg>here</msg>', [call('draw.create', { reply: '#1', text: 'a cat on a roof' })]),
    ],
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 3);
  const file = channel.sent[0];
  assert.equal(file.content, undefined);
  assert.equal(file.files?.length, 1);
  assert.ok(file.files?.[0].name.endsWith('.png'));
  assert.ok(Buffer.isBuffer(file.files?.[0].attachment));
  assert.deepEqual(file.reply, { messageReference: 'm1', failIfNotExists: false });
  assert.deepEqual(file.allowedMentions, { parse: [] });
  assert.equal(channel.sent[1].content, 'one sec');
  assert.equal(channel.sent[2].content, 'here');

  assert.equal(images.generateCalls.length, 1);
  const request = images.generateCalls[0];
  assert.equal(request.userId, 'u1');
  assert.equal(request.reference, null, 'a non-self picture never carries the avatar');
  assert.equal(request.prompt, 'Drawing for Bot.\n\na cat on a roof');
});

test('runTurn: the file name follows the media type (image/jpeg -> .jpg)', async () => {
  const { channel } = await runDrawTurn({
    answers: [toolAnswer('', [call('draw.create', { text: 'a cat' })])],
    images: fakeImages({ mediaType: 'image/jpeg' }),
  });
  assert.equal(channel.sent[0].files?.[0].name, 'image.jpg');
});

test('runTurn: the draw request is clamped to image.maxPromptChars', async () => {
  const { images } = await runDrawTurn({
    answers: [toolAnswer('', [call('draw.create', { text: 'abcdefghij' })])],
    hot: drawHot({}, { maxPromptChars: 4 }),
  });
  assert.ok(images.generateCalls[0].prompt.endsWith('\n\nabcd'));
});

test('runTurn: a self <draw> passes the avatar as reference', async () => {
  // The address of her large avatar comes from the interface (`memberInfo` of herself, `avatar.largeUrl`), which
  // sizes it for its platform; the size the Discord adapter asks for is that adapter's own test.
  const avatarAsks: Array<Untyped> = [];
  world().tap('memberInfo', ([member]: Array<Untyped>) => {
    if (member.memberId === 'self-id') avatarAsks.push(member.memberId);
  });
  world().member('g1', {
    id: 'self-id',
    name: 'Bot',
    avatar: { hash: null, url: null, largeUrl: 'https://cdn.example.com/avatar.png' },
  });
  const client = fakeClient();
  const imageFetcher = fakeImageFetcher({
    dataUrl: 'data:image/png;base64,YXZhdGFy',
    bytes: 6,
    contentType: 'image/png',
  });
  const { images } = await runDrawTurn({
    answers: [toolAnswer('', [call('draw.create', { self: true, text: 'me waving' })])],
    client,
    imageFetcher,
  });

  assert.deepEqual(avatarAsks, ['self-id']);
  assert.equal(imageFetcher.calls.length, 1);
  assert.equal(imageFetcher.calls[0].url, 'https://cdn.example.com/avatar.png');
  assert.equal(imageFetcher.calls[0].options.maxBytes, DRAW_IMAGE_CFG.referenceMaxBytes);
  assert.equal(imageFetcher.calls[0].options.timeoutMs, 10_000);
  assert.equal(images.generateCalls[0].reference, 'data:image/png;base64,YXZhdGFy');
  assert.ok(
    images.generateCalls[0].prompt.includes('Bot wears a green scarf.'),
    'a self picture carries the appearance'
  );
});

test('runTurn: reference none skips the avatar', async () => {
  let avatarAsked = false;
  world().tap('memberInfo', ([member]: Array<Untyped>) => {
    if (member.memberId === 'self-id') avatarAsked = true;
  });
  world().member('g1', {
    id: 'self-id',
    name: 'Bot',
    avatar: { hash: null, url: null, largeUrl: 'https://cdn.example.com/avatar.png' },
  });
  const client = fakeClient();
  const { images, imageFetcher } = await runDrawTurn({
    answers: [toolAnswer('', [call('draw.create', { self: true, text: 'me waving' })])],
    hot: drawHot({}, { reference: 'none' }),
    client,
  });

  assert.equal(avatarAsked, false);
  assert.equal(imageFetcher.calls.length, 0);
  assert.equal(images.generateCalls[0].reference, null);
});

test('runTurn: an avatar that cannot be fetched is logged and the picture is drawn without it', async () => {
  const client = fakeClient();
  world().member('g1', {
    id: 'self-id',
    name: 'Bot',
    avatar: { hash: null, url: null, largeUrl: 'https://cdn.example.com/avatar.png' },
  });
  const { images, channel, logs } = await runDrawTurn({
    answers: [toolAnswer('', [call('draw.create', { self: true, text: 'me' })])],
    client,
    imageFetcher: fakeImageFetcher(null),
  });

  assert.ok(logs.some((l) => l.msg === 'turn: avatar reference unavailable'));
  assert.equal(images.generateCalls[0].reference, null);
  assert.equal(channel.sent.length, 1);
});

test('runTurn: a channel without Attach Files offers no drawing and a call of it never generates', async () => {
  const { result, channel, images, llm } = await runDrawTurn({
    answers: [toolAnswer('<msg>hi</msg>', [call('draw.create', { text: 'a cat' })]), '<msg>ok</msg>'],
    attachFiles: false,
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(images.generateCalls.length, 0, 'nothing is generated (or paid for)');
  assert.deepEqual(
    channel.sent.map((sent) => sent.content),
    ['ok']
  );
  assert.ok(!userTextOf(llm.calls[0]).includes(labels.senses.draw), 'no drawing line in the senses');
  assert.equal(llm.calls.length, 2, 'the refusal came back to her');
});

test('runTurn: a draw.create alone without an image client posts nothing', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: drawHot(),
    store: fakeStore(),
    llm: sequenceLlm([toolAnswer('', [call('draw.create', { text: 'a cat' })]), '<skip/>']),
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });
  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  assert.equal(channel.sent.length, 0);
  assert.equal(result.delivered, false);
});

test('runTurn: a draw.create alone is a spoken turn', async () => {
  const { result, channel, llm, logs } = await runDrawTurn({
    answers: [toolAnswer('', [call('draw.create', { text: 'a cat' })])],
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, undefined);
  assert.equal(channel.sent[0].files?.length, 1);
  // PR 7d: features.typingSimulation is code, so the typing lease of the tool loop shows while the picture is drawn.
  assert.equal(channel.typingCalls.length, 1);
  assert.ok(userTextOf(llm.calls[0]).includes(labels.senses.draw), 'the draw sense reaches the request');
  assert.ok(
    llm.options[0].tools.some((tool: Untyped) => tool.function.name === 'draw_create'),
    'and the tool'
  );
  const drew = logs.find((l) => l.msg === 'turn: drew');
  assert.ok(drew);
  assert.equal(drew.channel, 'c1');
  assert.equal(drew.self, false);
  assert.equal(drew.bytes, Buffer.byteLength('fake picture'));
  assert.ok(!JSON.stringify(logs).includes('a cat'), 'the draw prompt is never logged outside dry-run');
});

test('runTurn: a follow-up turn posts the picture without a Discord reply', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: drawHot(),
    store: fakeStore(),
    llm: sequenceLlm([toolAnswer('', [call('draw.create', { reply: '#1', text: 'a cat' })])]),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages(),
  });
  await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' })
  );
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].reply, undefined);
});

test('runTurn: a failed drawing without a trigger fires onIdle once, right away', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: drawHot(),
    store: fakeStore(),
    llm: sequenceLlm([toolAnswer('', [call('draw.create', { text: 'a sunset' })])]),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('timeout') }),
  });
  let idle = 0;
  turns.setOnIdle(() => {
    idle += 1;
  });

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'interject' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(idle, 1);
});

// --- private (DM) turns --------------------------------------------------------

function privateHot(features = {}) {
  const hot = drawHot(features);
  hot.prompts.reply = 'Someone called you: {{author}}, they {{trigger}}. You are {{name}}.';
  hot.prompts.private = 'PRIVATE_TASK with {{author}} as {{name}}';
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
  guildId = 'g1',
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
    // Her name in the served community is the core's to tell (the member directory, else the name of `hello`).
    getSelfName: () => selfName,
    images,
    errands,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, guildId, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' })
  );
  return { result, logs, channel, llm, store, images, turns };
}

test('runTurn: a private turn takes guildId from params and reads the private layer of the trigger author', async () => {
  const { result, channel, store } = await runPrivateTurn();

  assert.equal(result.outcome, 'spoke');
  // The request's guild memory: nothing reads the guild again before the message is posted.
  assert.deepEqual(store.guildCalls, ['g1']);
  assert.deepEqual(store.privateCalls, [{ guildId: 'g1', userId: 'u1' }]);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'hi');
  assert.deepEqual(
    channel.sent[0].reply,
    { messageReference: 'm1', failIfNotExists: false },
    'a private reply may quote the trigger'
  );
});

test('runTurn: a private request carries the private prompt, the private trigger label and the merged profile, no server or neighbours', async () => {
  const { llm } = await runPrivateTurn();
  const user = userTextOf(llm.calls[0]);

  assert.ok(
    user.includes(`Someone called you: Alice, they ${labels.triggers.private}. You are GuildBot.`),
    'selfName comes from the served guild'
  );
  assert.ok(user.includes('PRIVATE_TASK with Alice as GuildBot'));
  assert.ok(user.includes('PUBLIC_REL') && user.includes('PRIVATE_REL') && user.includes('PRIVATE_DETAIL'));
  assert.ok(user.includes('attitude: 15 '), 'the attitude is the public and private scores added');
  assert.ok(user.includes(labels.senses.privateChat));
  assert.ok(!user.includes('<server>'));
  assert.ok(!user.includes('<other_channels>'));
});

test('runTurn: a private turn names her as the core says, the name of her account when no nickname is known', async () => {
  const { llm } = await runPrivateTurn({ selfName: 'Bot' });
  assert.ok(userTextOf(llm.calls[0]).includes('You are Bot.'));
});

test("runTurn: the injected clock stamps lastPostAt and the turn's own time", async () => {
  const raw = rawMessage({ id: 'm1', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });
  const { logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  assert.equal(channel.sent.length, 1);
  assert.equal(turns.lastPostAt('c1'), NOW);
  assert.equal(logs.find((l) => l.msg === 'turn: sent')?.secondsSinceTrigger, 0);
  assert.equal(logs.find((l) => l.msg === 'turn: model answered')?.secondsToAnswer, 0);
});

test('runTurn: a failing typing indicator does not stop the message', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  world().port.failNext('typing', { status: 'failed', error: { code: 'http-403', retryable: false } });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store: fakeStore(),
    llm: fakeLlm('<msg>hi</msg>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });
  await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  assert.equal(channel.sent.length, 1);
});

test('runTurn: a private turn may draw (no Attach Files check in a DM), counted for the DM partner', async () => {
  const { result, channel, images } = await runPrivateTurn({
    answers: [toolAnswer('<msg>sure</msg>', [call('draw.create', { text: 'a cat' })])],
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(images.generateCalls.length, 1);
  assert.equal(images.generateCalls[0].userId, 'u1');
  assert.equal(images.generateCalls[0].prompt, 'Drawing for GuildBot.\n\na cat');
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[0].files?.length, 1, 'the picture first, then her message');
});

test('runTurn: a guild channel keeps its own guild id even when a guildId param is passed', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ guildId: 'g1', historyMessages: [raw] });
  const store = fakeStore();
  const hot = fakeHot();
  hot.prompts.private = 'PRIVATE_TASK';
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm: fakeLlm('<skip/>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  await turns.runTurn({
    channel,
    guildId: 'other',
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });

  assert.deepEqual(store.guildCalls, ['g1']);
  assert.equal(store.privateCalls.length, 0, 'a guild turn never reads the private layer');
});

test('runTurn: a guild turn never carries the private prompt or the private senses line', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  // PR 7d: features.privateMessages is the key private.enabled.
  const hot = fakeHot({}, {}, { private: { enabled: true } });
  hot.prompts.private = 'PRIVATE_TASK';
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const user = textOf(llm.calls[0][1].content);
  assert.ok(!user.includes('PRIVATE_TASK'));
  assert.ok(!user.includes(labels.senses.privateChat));
  assert.ok(user.includes(labels.senses.privateAware));
});

test('runTurn: a channel without a guild and no guildId param throws a clear error and leaves nothing busy', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });

  await assert.rejects(
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }),
    /guildId/
  );
  assert.equal(llm.calls.length, 0);
  assert.equal(turns.isAnyBusy(), false);
});

// --- limits --------------------------------------------------------------------

function throwingLlm(error: unknown) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    complete: async (messages: unknown) => {
      calls.push(messages);
      throw error;
    },
  };
}

test('runTurn: a daily request cap or a token cap refusal returns outcome refused with the limit', async () => {
  for (const [error, limit] of [
    [
      Object.assign(new DailyCapError('cap'), { key: 'llm.maxRequestsPerDay', used: 300, cap: 300 }),
      { key: 'llm.maxRequestsPerDay', used: 300, cap: 300 },
    ],
    [
      Object.assign(new TokenLimitError('tokens'), { key: 'llm.maxRequestTokens', used: 51000, cap: 50000 }),
      { key: 'llm.maxRequestTokens', used: 51000, cap: 50000 },
    ],
  ]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: fakeHot(),
      store: fakeStore(),
      llm: throwingLlm(error),
      calibrator: identityCalibrator(),
      client: fakeClient(),
    });
    const { result } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
    );

    assert.deepEqual(result, { outcome: 'refused', limit });
    assert.equal(channel.sent.length, 0, 'the turn itself posts nothing; the caller decides on the notice');
  }
});

// The server's custom emoji (features.customEmoji, src/behavior/emoji-index.ts).
function fakeEmojiIndex() {
  const emojis = [
    { id: '111111111111111111', name: 'pepe_cry', animated: false },
    { id: '222222222222222222', name: 'dance', animated: true },
  ];
  const byName = (name: string) => emojis.find((e) => e.name === name) ?? null;
  return { refresh: () => Promise.resolve(), byName, list: () => emojis.map((e) => ({ ...e })) };
}

test('createTurnRunner: the request carries <emoji> ranked by guild.emojiUsage, with cached captions', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const store = fakeStore({
    guildMemory: { emojiUsage: { '222222222222222222': { name: 'dance', count: 4, last: Date.now() } } },
    mediaCache: { 'emoji:222222222222222222': { text: 'a spinning figure', ts: 1 } },
  });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const user = textOf(llm.calls[0][1].content);
  const text = Array.isArray(user) ? user.find((part) => part.type === 'text').text : user;
  const block = /<emoji>\n([\s\S]*?)\n<\/emoji>/.exec(text);
  assert.ok(block, 'an <emoji> block is sent');
  assert.deepEqual(block[1].split('\n'), [labels.emoji.header, ':dance: -- a spinning figure', ':pepe_cry:']);
  assert.ok(text.includes(labels.senses.customEmoji));
});

test('createTurnRunner: an outgoing :name: becomes the custom emoji, next to a resolved mention', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Zoé' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm(`<msg>@${handleOf('u1')} :dance: ok :unknown:</msg><react to="#1">:pepe_cry:</react>`);
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent[0].content, '<@u1> <a:dance:222222222222222222> ok :unknown:');
  assert.deepEqual(channel.sent[0].allowedMentions.users, ['u1']);
  assert.deepEqual(channel.reactCalls, [{ id: 'm1', emoji: '<:pepe_cry:111111111111111111>' }]);
});

test('createTurnRunner: an unknown custom emoji reaction is dropped, a unicode one still goes through', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<react to="#1">:nope:</react><react to="#1">🔥</react>');
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.deepEqual(channel.reactCalls, [{ id: 'm1', emoji: '🔥' }]);
});

test('createTurnRunner: only a custom reaction the index does not know means outcome "skip"', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store: fakeStore(),
    llm: fakeLlm('<react to="#1">:nope:</react>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });

  assert.equal(result.outcome, 'skip');
  assert.equal(channel.reactCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Provider routing: every request says which role makes it (llm.providerByModel
// keys of the form "<prefix>@<role>").

test('createTurnRunner: the persona turn is requested as role core, purpose reply', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  // No drop bar (pace.dropAfterMs): with one, the request also carries the bar's timeout and signal.
  const hot = fakeHot();
  hot.config.pace = { dropAfterMs: 0 };
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });
  await turns.runTurn({ channel, mode: 'interject' });
  assert.equal(llm.optionCalls.length, 1);
  assert.deepEqual(
    withoutTools(llm.optionCalls[0]),
    { role: 'core', purpose: 'reply', iface: 'discord' },
    'only the role, the purpose and the interface (PR 7a: `iface` for the usage row, never in the request) besides her tools: models.base.core and every other setting stay the defaults'
  );
  assert.equal(llm.optionCalls[0].toolChoice, 'auto');
  assert.deepEqual(
    llm.optionCalls[0].tools.map((tool: Untyped) => tool.function.name),
    // PR 7d: features.speech is code, so voice.say is carried over beside the others.
    ['draw_create', 'message_create', 'message_react_add', 'voice_say'],
    'the carried-over skills, nothing granted'
  );
  assert.equal('cache' in llm.optionCalls[0], false, 'the cache policy decides: the reply is the request it marks');
});

/** A store with one link GIF `g1` in the library (no other GIF state). */
function gifStore() {
  return {
    ...fakeStore(),
    findGif: (guildId: string, id: string) =>
      id === 'g1' ? { id: 'g1', kind: 'link', url: 'https://tenor.com/view/chat-qui-danse-1' } : null,
  };
}

// ---- format.stripDashes ------------------------------------------------------------------

/** One reply turn answered with `reply` under `format`; what was posted and the logs. */
async function dashTurn(reply: string, format: unknown) {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot({}, {}, { format }),
    store: fakeStore(),
    llm: fakeLlm(reply),
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });
  const { logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  return { sent: channel.sent.map((payload) => payload.content), logs };
}

test('runTurn: format.stripDashes on posts a reply without its em/en dashes, drops a message left empty and logs the count', async () => {
  const { sent, logs } = await dashTurn('<msg>ωραίο — πολύ–ωραίο, peut-être</msg><msg>—</msg>', { stripDashes: true });
  assert.deepEqual(sent, ['ωραίο πολύ ωραίο, peut-être']);
  const line = logs.find((entry) => entry.msg === 'turn: dashes stripped');
  assert.ok(line, 'logged once');
  assert.equal(line.count, 3);
  assert.equal(line.channel, 'c1');
  assert.equal(logs.filter((entry) => entry.msg === 'turn: dashes stripped').length, 1);
  assert.ok(!JSON.stringify(line).includes('ωραίο'), 'never the text');
});

test('runTurn: format.stripDashes false posts the dashes as written, no log', async () => {
  const { sent, logs } = await dashTurn('<msg>ωραίο — πολύ</msg>', { stripDashes: false });
  assert.deepEqual(sent, ['ωραίο — πολύ']);
  assert.equal(
    logs.some((entry) => entry.msg === 'turn: dashes stripped'),
    false
  );
});

// ---------------------------------------------------------------------------
// An overheard turn (triggerKind 'overheard'): a line about the persona, said
// to someone else or to the room. It posts plain like a follow-up, runs no
// trigger-only helper, and nobody asked for its drawing.

test('runTurn: an overheard or follow-up turn ignores reply="#n" and sends plain; a mention keeps it as a Discord reply', async () => {
  const cases: Array<{
    triggerKind: TriggerKind;
    reply: { messageReference: string; failIfNotExists: boolean } | undefined;
  }> = [
    { triggerKind: 'overheard', reply: undefined },
    { triggerKind: 'followUp', reply: undefined },
    { triggerKind: 'mention', reply: { messageReference: 'm1', failIfNotExists: false } },
  ];
  for (const c of cases) {
    const raw = rawMessage({ id: 'm1', authorName: 'Élodie' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: fakeHot(),
      store: fakeStore(),
      llm: fakeLlm('<msg reply="#1">ναι, εγώ</msg>'),
      calibrator: identityCalibrator(),
      client: fakeClient(),
    });
    const { result } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: c.triggerKind })
    );
    assert.equal(result.outcome, 'spoke', c.triggerKind);
    assert.equal(channel.sent.length, 1, c.triggerKind);
    assert.deepEqual(channel.sent[0].reply, c.reply, c.triggerKind);
  }
});

test('runTurn: an overheard turn posts its GIF plain', async () => {
  const cases: Array<[TriggerKind, { messageReference: string; failIfNotExists: boolean } | undefined]> = [
    ['overheard', undefined],
    ['mention', { messageReference: 'm1', failIfNotExists: false }],
  ];
  for (const [triggerKind, reply] of cases) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: fakeHot(),
      store: gifStore(),
      llm: fakeLlm('<gif reply="#1">g1</gif>'),
      calibrator: identityCalibrator(),
      client: fakeClient(),
    });
    await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind })
    );
    assert.equal(channel.sent.length, 1, triggerKind);
    assert.equal(channel.sent[0].content, 'https://tenor.com/view/chat-qui-danse-1', triggerKind);
    assert.deepEqual(channel.sent[0].reply, reply, triggerKind);
  }
});

test('runTurn: an overheard turn draws unasked: a plain post charged to no member', async () => {
  const { result, channel, images } = await runDrawTurn({
    answers: [toolAnswer('', [call('draw.create', { reply: '#1', text: 'a cat' })])],
    triggerKind: 'overheard',
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(images.generateCalls.length, 1);
  assert.equal(images.generateCalls[0].userId, null);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].files?.length, 1);
  assert.equal(channel.sent[0].reply, undefined);
});

// --- another channel pulled into a turn (<channel_view>): the inputs ----------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Other channels of the guild, snowflake-shaped: a `<#id>` mention is only read for such ids.
const DIARY = '100000000000000002';
const NOTES = '100000000000000003';

/** A raw message of channel `channelId`; `raw` is Discord's own text (`<#id>` tokens), `content` the clean one. */
function lineIn(
  channelId: string,
  {
    raw,
    ...fields
  }: {
    raw?: string;
    id: string;
    authorId?: string;
    authorName?: string;
    ts?: number;
    content?: string;
    attachments?: Map<string, unknown>;
  }
) {
  const message: ReturnType<typeof rawMessage> & { content?: string } = { ...rawMessage(fields), channelId };
  if (raw !== undefined) message.content = raw;
  return message;
}

/**
 * Another text channel of the same community the bot may read, holding `messages`; its newest
 * message is at `lastTs` (a neighbour when within the last hour of NOW). `readOnly`: the bot
 * cannot send there. `fetchFails`: every history read of it fails. `fetches` lists the history
 * reads made of it.
 */
function addChannel(
  turnChannel: Untyped,
  {
    id,
    name,
    messages = [],
    lastTs = messages.at(-1)?.createdTimestamp ?? NOW - 3 * HOUR,
    readOnly = false,
    fetchFails = false,
    ...more
  }: {
    id: string;
    name: string;
    messages?: Array<ReturnType<typeof lineIn>>;
    lastTs?: number;
    readOnly?: boolean;
    fetchFails?: boolean;
  } & Omit<ChannelSpec, 'id' | 'name' | 'historyMessages'>
) {
  const other = fakeTurnChannel({
    id,
    name,
    guildId: turnChannel.guildId,
    historyMessages: messages,
    lastMessageAt: lastTs,
    ...(readOnly ? { permissions: { send: false } } : {}),
    ...more,
  });
  if (fetchFails) other.failHistory();
  return other;
}

/** The diary channel's lines: two by Éloïse, `ago` before NOW, the second one with a picture. */
function diaryLines(ago = 3 * HOUR) {
  const wall = { id: 'dp1', contentType: 'image/png', name: 'wall.png', url: 'https://cdn.discordapp.com/x/wall.png' };
  return [
    lineIn(DIARY, {
      id: 'd1',
      authorId: 'u3',
      authorName: 'Éloïse',
      ts: NOW - ago,
      content: 'σήμερα έβαψα τον τοίχο μπλε',
    }),
    lineIn(DIARY, {
      id: 'd2',
      authorId: 'u3',
      authorName: 'Éloïse',
      ts: NOW - ago + MINUTE,
      content: 'και μετά κοιμήθηκα',
      attachments: new Map([['dp1', wall]]),
    }),
  ];
}

/**
 * A turn in #general (c1) whose history holds Bob's line naming #diary (DIARY) -- a real `<#id>`
 * token unless `mention` is false -- and Alice's call after it. The guild holds the diary channel.
 */
function pullScene({
  features = {},
  context = {},
  config = {},
  bot = {},
  mention = true,
  diary = {},
  between = [],
  routeChannels,
  describer,
  images,
  store = fakeStore(),
  llm = fakeLlm('<msg>ok</msg>'),
}: {
  features?: Record<string, unknown>;
  context?: Record<string, unknown>;
  config?: Record<string, unknown>;
  bot?: Record<string, unknown>;
  mention?: boolean;
  diary?: Record<string, unknown>;
  between?: Array<ReturnType<typeof lineIn>>;
  routeChannels?: (args: Untyped) => Promise<Array<unknown>>;
  describer?: object;
  images?: object;
  store?: FakeStore;
  llm?: Pick<ReturnType<typeof fakeLlm>, 'calls' | 'complete'>;
} = {}) {
  const asked = lineIn('c1', {
    id: 'm1',
    authorId: 'u2',
    authorName: 'Bob',
    ts: NOW - 5 * MINUTE,
    content: 'είδες το #diary;',
    raw: mention ? `είδες το <#${DIARY}>;` : 'είδες το #diary;',
  });
  const call = lineIn('c1', { id: 'm9', ts: NOW - 1000, content: 'λοιπόν;' });
  const channel = fakeTurnChannel({ historyMessages: [asked, ...between, call] });
  const other = addChannel(channel, { id: DIARY, name: 'diary', messages: diaryLines(), ...diary });
  const hot = fakeHot(features, bot, config);
  hot.config.context = { ...hot.config.context, ...context };
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    routeChannels,
    images,
    imageFetcher: fakeImageFetcher(),
    now: () => NOW,
  });
  return { channel, other, hot, llm, store, turns, trigger: normalizedTrigger(call) };
}

/** A channel of the world is a text channel listed in its community already, as a main channel must be. */
function registerTextChannel<TChannel>(channel: TChannel) {
  return channel;
}

/** A describer like pullDescriber whose cache read throws (a corrupt media cache). */
function throwingCacheDescriber() {
  return {
    ...pullDescriber(),
    cachedDescriptions: () => {
      throw new Error('fixture: corrupt media cache');
    },
  };
}

/** A store like fakeStore whose ring of calls (`state.json` `elsewherePings`) cannot be read. */
function unreadableRingStore() {
  const store = fakeStore();
  Object.defineProperty(store.state.data, 'elsewherePings', {
    get() {
      throw new Error('fixture: unreadable state');
    },
  });
  return store;
}

/** The `<channel_view>` body of the first request, or null when the request has none. */
function channelViewOf(llm: Untyped): string | null {
  const text = userText(llm);
  return text.includes('<channel_view>') ? text.split('<channel_view>\n')[1].split('\n</channel_view>')[0] : null;
}

/** A describer with an empty cache whose describeMany captions every item, recording each call in `calls` and `events`. */
function pullDescriber(events: Array<string> = []) {
  const calls: Array<{ ids: Untyped; options: Untyped }> = [];
  return {
    calls,
    events,
    cachedDescriptions: () => new Map(),
    describeMany: async (guildId: string, items: Untyped, options: unknown) => {
      const ids = items.map((item: Untyped) => item.itemId);
      calls.push({ ids, options });
      events.push(`describe:${ids.join(',')}`);
      return {
        descriptions: new Map(items.map((item: Untyped) => [item.itemId, `caption of ${item.itemId}`])),
        newCount: items.length,
      };
    },
  };
}

/** The describeMany calls that asked for item `itemId`. */
function callsFor(describer: Untyped, itemId: string): Array<Untyped> {
  return describer.calls.filter((call: Untyped) => call.ids.includes(itemId));
}

test('runTurn: an explicit channel mention in the last scanMessages pulls that channel', async () => {
  const { turns, channel, other, llm, trigger } = pullScene();

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' })
  );

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(llm);
  assert.ok(view, 'the request carries <channel_view>');
  assert.ok(view.includes('channel #diary'), view);
  assert.ok(view.includes('σήμερα έβαψα τον τοίχο μπλε') && view.includes('και μετά κοιμήθηκα'), view);
  assert.ok(view.includes('#3 ') && view.includes('#4 '), 'the pulled lines are numbered on after the chat');
  assert.equal(other.fetches.length, 1, 'one page of the pulled channel');

  // A mention older than the scanned span pulls nothing.
  // PR 7d: context.pull.scanMessages is the constant 20, so twenty lines after the mention push it out of the span.
  const filler = Array.from({ length: 20 }, (_, n) =>
    lineIn('c1', {
      id: `f${n}`,
      authorId: 'u2',
      authorName: 'Bob',
      ts: NOW - 4 * MINUTE + n,
      content: 'τέλος πάντων',
    })
  );
  const older = pullScene({ between: filler });
  await withCapturedLogs(() =>
    older.turns.runTurn({ channel: older.channel, mode: 'reply', trigger: older.trigger, triggerKind: 'mention' })
  );
  assert.equal(channelViewOf(older.llm), null);
  assert.equal(older.other.fetches.length, 0);
});

test('runTurn: a channel mention in the trigger itself pulls that channel', async () => {
  const { turns, channel, llm, trigger } = pullScene({ mention: false });

  await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'reply',
      trigger: { ...trigger, mentionedChannelIds: [DIARY] },
      triggerKind: 'mention',
    })
  );

  assert.ok(channelViewOf(llm)?.includes('σήμερα έβαψα τον τοίχο μπλε'));
});

test("runTurn: a pulled channel stays for the same author's next turns within the limits; another author, a spent limit or the router's pick drops or replaces it", async () => {
  const kept = pullScene({ mention: false });
  const named = { ...kept.trigger, mentionedChannelIds: [DIARY] };
  const next = (id: string, extra = {}) => ({ ...kept.trigger, id, ...extra });
  await withCapturedLogs(() =>
    kept.turns.runTurn({ channel: kept.channel, mode: 'reply', trigger: named, triggerKind: 'mention' })
  );
  assert.equal(kept.other.fetches.length, 1, 'pulled by the mention');
  // The follow-up names no channel: the same author keeps the pull; its lines are numbered on after the chat.
  const before = kept.llm.calls.length;
  await withCapturedLogs(() =>
    kept.turns.runTurn({ channel: kept.channel, mode: 'reply', trigger: next('m10'), triggerKind: 'followUp' })
  );
  assert.equal(kept.other.fetches.length, 2, 'fetched again for the follow-up');
  const view = channelViewOf({ calls: [kept.llm.calls[before]] });
  assert.ok(view?.includes('σήμερα έβαψα τον τοίχο μπλε') && view.includes('#3 '), view ?? '');
  // Another author, no channel named: dropped.
  await withCapturedLogs(() =>
    kept.turns.runTurn({
      channel: kept.channel,
      mode: 'reply',
      trigger: next('m11', { authorId: 'u9' }),
      triggerKind: 'followUp',
    })
  );
  assert.equal(kept.other.fetches.length, 2);
  // And gone for the original author too.
  await withCapturedLogs(() =>
    kept.turns.runTurn({ channel: kept.channel, mode: 'reply', trigger: next('m12'), triggerKind: 'followUp' })
  );
  assert.equal(kept.other.fetches.length, 2);

  // keepTurns: the pull is kept for that many turns after the one that pulled it.
  // PR 7d: context.pull.keepTurns is the constant 3, so the fourth follow-up finds the pull gone.
  const limited = pullScene({ mention: false });
  await withCapturedLogs(() =>
    limited.turns.runTurn({
      channel: limited.channel,
      mode: 'reply',
      trigger: { ...limited.trigger, mentionedChannelIds: [DIARY] },
      triggerKind: 'mention',
    })
  );
  for (const id of ['m10', 'm11', 'm12', 'm13'])
    await withCapturedLogs(() =>
      limited.turns.runTurn({
        channel: limited.channel,
        mode: 'reply',
        trigger: { ...limited.trigger, id },
        triggerKind: 'followUp',
      })
    );
  assert.equal(limited.other.fetches.length, 4, 'the pulling turn and three kept ones');
});

test("runTurn: the router's pick in a later turn replaces the kept channel", async () => {
  const answers = [[DIARY], [NOTES]];
  const scene = pullScene({ mention: false, routeChannels: async () => answers.shift() ?? [] });
  const notes = addChannel(scene.channel, {
    id: NOTES,
    name: 'notes',
    messages: [
      lineIn(NOTES, {
        id: 'n1',
        authorId: 'u4',
        authorName: 'Zoë',
        ts: NOW - 2 * HOUR,
        content: 'σημειώσεις για αύριο',
      }),
    ],
  });
  await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );
  const before = scene.llm.calls.length;
  await withCapturedLogs(() =>
    scene.turns.runTurn({
      channel: scene.channel,
      mode: 'reply',
      trigger: { ...scene.trigger, id: 'm10' },
      triggerKind: 'followUp',
    })
  );
  assert.equal(notes.fetches.length, 1);
  assert.equal(scene.other.fetches.length, 1, 'the kept channel is not fetched again');
  const view = channelViewOf({ calls: [scene.llm.calls[before]] });
  assert.ok(view?.includes('σημειώσεις για αύριο') && !view?.includes('σήμερα έβαψα'), view ?? '');
});

test('runTurn: a spontaneous turn pulls a channel mentioned in its history', async () => {
  const describer = pullDescriber();
  const { turns, channel, llm } = pullScene({ features: {}, describer });
  const seen: Array<{ pulled: Array<object>; describeCalls: number }> = [];

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'auto',
      chooseMode: (history, now, context) => {
        seen.push({ pulled: context.pulled, describeCalls: describer.calls.length });
        return 'interject';
      },
    })
  );

  assert.equal(result.outcome, 'spoke');
  assert.ok(channelViewOf(llm)?.includes('και μετά κοιμήθηκα'));
  // The mention is pulled before the mode is chosen, and the chooser sees it.
  assert.equal(seen.length, 1);
  assert.deepEqual(
    seen[0].pulled.map((entry: Untyped) => [entry.channelId, entry.reason]),
    [[DIARY, 'mention']]
  );
  assert.equal(seen[0].describeCalls, 0, 'no caption was asked before the chooser chose');
});

test('runTurn: with nothing to pull the request carries no pulled channel and logs no pull', async () => {
  const hook = [];
  const none = pullScene({ mention: false, routeChannels: async (args: unknown) => (hook.push(args), []) });

  const { logs } = await withCapturedLogs(() =>
    none.turns.runTurn({ channel: none.channel, mode: 'reply', trigger: none.trigger, triggerKind: 'mention' })
  );

  assert.equal(hook.length, 1, 'the hook was asked');
  assert.equal(channelViewOf(none.llm), null);
  assert.equal(
    logs.some((l) => l.msg.startsWith('pull: ')),
    false
  );
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.equal(
    'source' in (answered ?? {}) || 'pulled' in (answered ?? {}) || 'focus' in (answered ?? {}),
    false,
    'no pull fields on an ordinary turn'
  );
});

test('runTurn: an explicit mention takes the one pulled place and the route hook is not asked', async () => {
  const hookCalls = [];
  const scene = pullScene({
    routeChannels: async (args: unknown) => {
      hookCalls.push(args);
      return [NOTES, DIARY];
    },
  });
  addChannel(scene.channel, {
    id: NOTES,
    name: 'notes',
    messages: [
      lineIn(NOTES, {
        id: 'n1',
        authorId: 'u4',
        authorName: 'Zoë',
        ts: NOW - 2 * HOUR,
        content: 'σημειώσεις για αύριο',
      }),
    ],
  });

  await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );

  // PR 7d: context.pull.maxChannels is the constant 1 (the production value): the explicit mention fills the one
  // place, so the hook is never asked and its pick is left out.
  assert.equal(hookCalls.length, 0);
  const view = channelViewOf(scene.llm);
  assert.ok(view?.includes('channel #diary'), view ?? '');
  assert.ok(!view?.includes('channel #notes'), view ?? '');
});

test('runTurn: an earlier route pick fetches the page before the oldest line shown last time, else the newest page', async () => {
  const answers = [[DIARY], [{ id: DIARY, direction: 'earlier' }]];
  // The fake interface answers `before` as a platform does, so there is an earlier line to find. PR 7d: the first page
  // holds the hour before the newest line, widened to the constant minimum of five lines (pull.minMessages), so four
  // older lines make the sixth line of the channel the one the second page has to reach.
  const older = [1, 2, 3, 4].map((n) =>
    lineIn(DIARY, {
      id: `e${n}`,
      authorId: 'u3',
      authorName: 'Éloïse',
      ts: NOW - (9 - n) * HOUR,
      content: `πριν ${n}`,
    })
  );
  const scene = pullScene({
    mention: false,
    diary: { messages: [...older, ...diaryLines()] },
    routeChannels: async () => answers.shift() ?? [],
  });

  const { logs } = await withCapturedLogs(async () => {
    await scene.turns.runTurn({
      channel: scene.channel,
      mode: 'reply',
      trigger: scene.trigger,
      triggerKind: 'mention',
    });
    await scene.turns.runTurn({
      channel: scene.channel,
      mode: 'reply',
      trigger: scene.trigger,
      triggerKind: 'mention',
    });
  });

  const pages = scene.other.fetches.filter((arg) => arg && typeof arg === 'object') as Array<Record<string, unknown>>;
  assert.equal(pages.length, 2);
  assert.equal('before' in pages[0], false, 'the first view is the newest page');
  assert.equal(pages[1].before, 'e2', 'the second starts before the oldest line the first one showed');
  const pulls = logs.filter((l) => l.msg === 'pull: channel');
  assert.deepEqual(
    pulls.map((l) => [l.direction, l.beforeId]),
    [
      [null, undefined],
      ['earlier', true],
    ]
  );

  const fresh = pullScene({ mention: false, routeChannels: async () => [{ id: DIARY, direction: 'earlier' }] });
  const alone = await withCapturedLogs(() =>
    fresh.turns.runTurn({ channel: fresh.channel, mode: 'reply', trigger: fresh.trigger, triggerKind: 'mention' })
  );
  const [page] = fresh.other.fetches.filter((arg) => arg && typeof arg === 'object') as Array<Record<string, unknown>>;
  assert.equal('before' in page, false, 'no previous view: the newest page');
  assert.equal(alone.logs.find((l) => l.msg === 'pull: channel')?.pullDirection, 'earlier-no-previous');
});

test('runTurn: the route hook is not asked once the mentions fill every slot', async () => {
  let asked = 0;
  const scene = pullScene({
    routeChannels: async () => {
      asked += 1;
      return [];
    },
  });
  await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );
  assert.equal(asked, 0);
});

test('runTurn: context.pull.maxChannels caps the pulled channels, the newest mention first', async () => {
  const newer = lineIn('c1', {
    id: 'm5',
    authorId: 'u2',
    authorName: 'Bob',
    ts: NOW - 4 * MINUTE,
    content: 'και το #notes',
    raw: `και το <#${NOTES}>`,
  });
  const scene = pullScene({ between: [newer] });
  const notes = addChannel(scene.channel, {
    id: NOTES,
    name: 'notes',
    messages: [
      lineIn(NOTES, {
        id: 'n1',
        authorId: 'u4',
        authorName: 'Zoë',
        ts: NOW - 2 * HOUR,
        content: 'σημειώσεις για αύριο',
      }),
    ],
  });

  await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );

  const view = channelViewOf(scene.llm);
  assert.ok(view?.includes('channel #notes') && !view?.includes('channel #diary'), view ?? '');
  assert.equal(scene.other.fetches.length, 0);
  assert.equal(notes.fetches.length, 1);
});

test('runTurn: a pulled channel is left out of the neighbours', async () => {
  const diary = { messages: diaryLines(10 * MINUTE) };
  const pulled = pullScene({ diary });
  await withCapturedLogs(() =>
    pulled.turns.runTurn({ channel: pulled.channel, mode: 'reply', trigger: pulled.trigger, triggerKind: 'mention' })
  );

  assert.ok(channelViewOf(pulled.llm)?.includes('σήμερα έβαψα τον τοίχο μπλε'));
  assert.equal(userText(pulled.llm).includes('# diary'), false, 'not shown again among the neighbours');
});

test('runTurn: a noticed turn passes the pulled source to chooseMode', async () => {
  const seen: Array<{ history: Array<object>; now: number; context: { pulled: Array<object> } }> = [];
  const { turns, channel, llm } = pullScene({ mention: false });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'auto',
      source: { channelId: DIARY, reason: 'noticed' },
      chooseMode: (history, now, context) => {
        seen.push({ history, now, context });
        return null;
      },
    })
  );

  assert.equal(result.outcome, 'not-now');
  assert.equal(llm.calls.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].now, NOW);
  assert.deepEqual(
    seen[0].history.map((m: Untyped) => m.id),
    ['m1', 'm9'],
    "the chooser still gets the turn channel's history"
  );
  const [source] = seen[0].context.pulled;
  assert.equal(seen[0].context.pulled.length, 1);
  assert.equal(asRecord(source).channelId, DIARY);
  assert.equal(asRecord(source).reason, 'noticed');
  assert.deepEqual(
    asRecord(source).messages.map((m: Untyped) => m.id),
    ['d1', 'd2']
  );
});

test('runTurn: a routed turn whose source cannot be pulled ends in error, a noticed one in not-now', async () => {
  for (const [reason, outcome] of [
    ['routed', 'error'],
    ['noticed', 'not-now'],
  ]) {
    const { turns, channel, llm } = pullScene({ mention: false });
    let chosen = 0;
    const { result, logs } = await withCapturedLogs(() =>
      turns.runTurn({
        channel,
        mode: reason === 'routed' ? 'reply' : 'auto',
        source: { channelId: 'c9', reason },
        chooseMode: () => {
          chosen += 1;
          return 'elsewhere';
        },
      })
    );

    assert.equal(result.outcome, outcome, reason);
    assert.equal(llm.calls.length, 0, reason);
    assert.equal(chosen, 0, `${reason}: no chooser without the source`);
    assert.equal(turns.isBusy('c1'), false);
    assert.ok(
      logs.some((l) => l.msg === 'pull: skipped' && l.source === 'c9' && l.reason === 'not-found'),
      reason
    );
    const unavailable = logs.find((l) => l.msg === 'turn: source unavailable');
    if (reason === 'routed')
      assert.deepEqual([unavailable?.channel, unavailable?.source, unavailable?.reason], ['c1', 'c9', 'not-found']);
    else assert.equal(unavailable, undefined);
  }
});

test('runTurn: fresh captions for a pulled channel are asked only once the turn is certain to run', async () => {
  // A chooser that says not-now: nothing is asked, the cache alone was read.
  const quiet = pullDescriber();
  const notNow = pullScene({ features: {}, describer: quiet });
  const { result } = await withCapturedLogs(() =>
    notNow.turns.runTurn({ channel: notNow.channel, mode: 'auto', chooseMode: () => null })
  );
  assert.equal(result.outcome, 'not-now');
  assert.equal(quiet.calls.length, 0);

  // A chooser that picks a mode: the caption is asked after it chose, and reaches the block.
  const events: Array<string> = [];
  const chosen = pullDescriber(events);
  const live = pullScene({ features: {}, describer: chosen });
  await withCapturedLogs(() =>
    live.turns.runTurn({
      channel: live.channel,
      mode: 'auto',
      chooseMode: () => {
        events.push('chooser');
        return 'interject';
      },
    })
  );
  assert.deepEqual(
    callsFor(chosen, 'dp1').map((call: Untyped) => call.options),
    [{ maxNew: 1 }]
  );
  assert.ok(events.indexOf('chooser') < events.indexOf('describe:dp1'), events.join(' '));
  assert.ok(channelViewOf(live.llm)?.includes('caption of dp1'));

  // No chooser at all: asked with the fetch, once.
  const direct = pullDescriber();
  const reply = pullScene({ features: {}, describer: direct });
  await withCapturedLogs(() =>
    reply.turns.runTurn({ channel: reply.channel, mode: 'reply', trigger: reply.trigger, triggerKind: 'mention' })
  );
  assert.equal(callsFor(direct, 'dp1').length, 1);
  assert.ok(channelViewOf(reply.llm)?.includes('caption of dp1'));
});

test('runTurn: a failed or throwing pull never fails the turn', async () => {
  const failing = pullScene({ diary: { fetchFails: true } });
  const failed = await withCapturedLogs(() =>
    failing.turns.runTurn({ channel: failing.channel, mode: 'reply', trigger: failing.trigger, triggerKind: 'mention' })
  );
  assert.equal(failed.result.outcome, 'spoke');
  assert.equal(channelViewOf(failing.llm), null);
  assert.ok(failed.logs.some((l) => l.msg === 'pull: skipped' && l.source === DIARY && l.reason === 'fetch-failed'));

  const throwing = pullScene({
    mention: false,
    routeChannels: async () => {
      throw new Error('fixture: route classifier down');
    },
  });
  const thrown = await withCapturedLogs(() =>
    throwing.turns.runTurn({
      channel: throwing.channel,
      mode: 'reply',
      trigger: throwing.trigger,
      triggerKind: 'mention',
    })
  );
  assert.equal(thrown.result.outcome, 'spoke');
  assert.ok(thrown.logs.some((l) => l.msg === 'pull: route failed' && l.channel === 'c1'));
});

test('runTurn: a private chat whose partner cannot be fetched as a guild member never pulls a channel', async () => {
  let asked = 0;
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = sequenceLlm(['<msg>hi</msg>']);
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: privateHot(),
    store: privateStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages(),
    routeChannels: async () => {
      asked += 1;
      return [DIARY];
    },
  });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      guildId: 'g1',
      mode: 'reply',
      trigger: { ...normalizedTrigger(raw), mentionedChannelIds: [DIARY] },
      triggerKind: 'private',
    })
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(asked, 0);
  assert.equal(userTextOf(llm.calls[0]).includes('<channel_view>'), false);
  assert.equal(
    logs.some((l) => l.msg.startsWith('pull: ')),
    false
  );
});

/**
 * A private chat (dm1) served for g1, whose guild holds #diary (DIARY). Alice (u1), the partner,
 * is fetched from the guild (`memberFetches`); `canView`: whether she has View Channel on #diary.
 * `mention`: her call names #diary with a real `<#id>`.
 */
function privatePullScene({
  features = {},
  canView = true,
  mention = false,
  routeChannels,
  likeServer = true,
}: Record<string, Untyped> = {}) {
  const server = fakeTurnChannel({ id: 'c1' });
  world().member('g1', { id: 'u1', name: 'Alice' });
  const memberFetches: Array<Untyped> = [];
  world().tap('memberInfo', ([member]: Array<Untyped>) => {
    memberFetches.push(member.memberId);
  });
  // The interface tells whether the partner (u1) can view each conversation of the listing.
  const diary = addChannel(server, { id: DIARY, name: 'diary', messages: diaryLines(), viewers: { u1: canView } });
  const call = lineIn('dm1', {
    id: 'p1',
    authorId: 'u1',
    authorName: 'Alice',
    ts: NOW - 1000,
    content: 'τι γράφει το ημερολόγιο;',
  });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [call] });
  const llm = sequenceLlm(['<msg>ok</msg>']);
  const client = fakeClient();
  const hot = privateHot(features);
  hot.config.private = { likeServer };
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: privateStore(),
    llm,
    calibrator: identityCalibrator(),
    client,
    images: fakeImages(),
    imageFetcher: fakeImageFetcher(),
    routeChannels,
    now: () => NOW,
  });
  const trigger = { ...normalizedTrigger(call), ...(mention ? { mentionedChannelIds: [DIARY] } : {}) };
  const run = () =>
    withCapturedLogs(() => turns.runTurn({ channel, guildId: 'g1', mode: 'reply', trigger, triggerKind: 'private' }));
  return { channel, diary, memberFetches, llm, run };
}

/** A route hook that names #diary and records its arguments. */
function diaryHook() {
  const calls: Array<Untyped> = [];
  const hook = async (args: unknown) => {
    calls.push(args);
    return [DIARY];
  };
  return { calls, hook };
}

test('runTurn: with private.likeServer off a private chat asks no route hook, pulls no mention and fetches no partner', async () => {
  const { calls, hook } = diaryHook();
  const scene = privatePullScene({ likeServer: false, mention: true, routeChannels: hook });

  const { result, logs } = await scene.run();

  assert.equal(result.outcome, 'spoke');
  assert.equal(calls.length, 0);
  assert.deepEqual(scene.memberFetches, []);
  assert.deepEqual(scene.diary.fetches, []);
  assert.equal(
    logs.some((l) => l.msg.startsWith('pull: ')),
    false
  );
});

test('runTurn: a private chat asks the route hook for its partner and pulls the picked channel the partner can view', async () => {
  const { calls, hook } = diaryHook();
  const scene = privatePullScene({ routeChannels: hook });

  const { result, logs } = await scene.run();

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.memberFetches, ['u1']);
  assert.equal(calls.length, 1);
  // Changed with the contract: the hook gets the conversation's info, the served community's listing and the
  // partner's member record (the hook's arguments held platform objects before).
  assert.equal(calls[0].channel.id, scene.channel.id);
  assert.equal(calls[0].snapshot.communityId, 'g1', 'judged in the served community');
  assert.equal(calls[0].partner.id, 'u1');
  assert.equal(calls[0].triggerKind, 'private');
  assert.deepEqual(
    calls[0].history.map((m: Untyped) => m.id),
    ['p1']
  );
  assert.ok(scene.diary.fetches.length > 0, 'the picked channel was fetched');
  const pulled = logs.find((l) => l.msg === 'pull: channel');
  assert.deepEqual([pulled?.channel, pulled?.source, pulled?.pullReason], ['dm1', DIARY, 'route']);
});

test('runTurn: a private chat never pulls a picked channel its partner cannot view', async () => {
  const { calls, hook } = diaryHook();
  const scene = privatePullScene({ routeChannels: hook, canView: false });

  const { result, logs } = await scene.run();

  assert.equal(result.outcome, 'spoke');
  assert.equal(calls.length, 1);
  assert.deepEqual(scene.diary.fetches, []);
  assert.equal(
    logs.some((l) => l.msg === 'pull: channel'),
    false
  );
  const skipped = logs.find((l) => l.msg === 'pull: skipped');
  assert.deepEqual([skipped?.source, skipped?.reason, skipped?.pullReason], [DIARY, 'audience', 'route']);
});

test('runTurn: a private chat pulls an explicitly mentioned channel only when its partner can view it', async () => {
  const seen = await privatePullScene({ mention: true }).run();
  assert.ok(seen.logs.some((l) => l.msg === 'pull: channel' && l.source === DIARY && l.pullReason === 'mention'));

  const hidden = privatePullScene({ mention: true, canView: false });
  const { logs } = await hidden.run();
  assert.deepEqual(hidden.diary.fetches, []);
  const skipped = logs.find((l) => l.msg === 'pull: skipped');
  assert.deepEqual([skipped?.source, skipped?.reason, skipped?.pullReason], [DIARY, 'audience', 'mention']);
});

test('runTurn: a private chat whose partner left the guild pulls nothing and logs the failed fetch', async () => {
  const { calls, hook } = diaryHook();
  const scene = privatePullScene({ mention: true, routeChannels: hook });
  world().port.failNext('memberInfo', { status: 'failed', error: { code: 'unknown-member', retryable: false } });

  const { result, logs } = await scene.run();

  assert.equal(result.outcome, 'spoke');
  assert.equal(calls.length, 0);
  assert.deepEqual(scene.diary.fetches, []);
  const failed = logs.find((l) => l.msg === 'turn: partner failed');
  assert.deepEqual([failed?.guildId, failed?.userId], ['g1', 'u1']);
});

/**
 * A call to the persona in the read-only #diary (c2), answered in #general (c1): the source holds
 * the diary lines, `before`, Alice's call and `after`; #general holds one line by Bob.
 */
function routedScene({
  features = {},
  hot = fakeHot(features),
  describer,
  llm = fakeLlm('<msg>ok</msg>'),
  lookup,
  callAttachments,
  chat = [
    lineIn('c1', { id: 'm1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5 * MINUTE, content: 'καλημέρα σε όλους' }),
  ],
  callTs = NOW - 2 * MINUTE,
  before = [],
  after = [],
  routeChannels,
  store = fakeStore(),
  client = fakeClient(),
  images,
}: Record<string, Untyped> = {}) {
  const channel = fakeTurnChannel({ historyMessages: chat });
  const call = lineIn(DIARY, {
    id: 'd3',
    ts: callTs,
    content: '@Bot τι λες για τον τοίχο;',
    attachments: callAttachments,
  });
  const other = addChannel(channel, {
    id: DIARY,
    name: 'diary',
    messages: [...diaryLines(), ...before, call, ...after],
    readOnly: true,
  });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client,
    describer,
    lookup,
    routeChannels,
    images,
    imageFetcher: fakeImageFetcher(),
    now: () => NOW,
  });
  const trigger = { ...normalizedTrigger(call), mentionedUserIds: ['self-id'] };
  const params: TurnParams = {
    channel,
    mode: 'reply',
    trigger,
    triggerKind: 'mention',
    source: { channelId: DIARY, reason: 'routed' },
  };
  return { channel, other, hot, llm, store, turns, trigger, params };
}

/** Makes #general (c1) the scene's main channel: `memory.mainChannelIds` and a usable text channel. */
function asMainChannel(scene: Untyped) {
  registerTextChannel(scene.channel);
  scene.hot.config.memory = { ...scene.hot.config.memory, mainChannelIds: ['c1'] };
  return scene;
}

test('runTurn: a routed turn pulls its source with the call and builds the request in the destination', async () => {
  const scene = asMainChannel(routedScene());

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view?.includes('@Bot τι λες για τον τοίχο;') && view?.includes('σήμερα έβαψα τον τοίχο μπλε'), view ?? '');
  assert.ok(view?.includes(labels.server.readOnly), 'the source is marked read-only');
  // The request knows the turn's source: the task says where the call came from and where the words go.
  assert.ok(userText(scene.llm).includes(fill(labels.elsewhere.called, { channel: 'diary', destination: 'general' })));
  const pulled = logs.find((l) => l.msg === 'pull: channel');
  assert.deepEqual([pulled?.channel, pulled?.source, pulled?.pullReason], ['c1', DIARY, 'routed']);
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.deepEqual([answered?.channel, answered?.source, answered?.pulled], ['c1', DIARY, 1]);
  assert.equal(answered?.budget.pulled.kept, 1, 'the pulled block is in the budget');
  assert.equal('focus' in answered, false);
});

test('runTurn: a routed call older than the window is still shown with its source', async () => {
  // Five newer lines fill the window; the call, three hours old, is outside it.
  const after = [0, 1, 2, 3, 4].map((i) =>
    lineIn(DIARY, {
      id: `d${4 + i}`,
      authorId: 'u4',
      authorName: 'Zoë',
      ts: NOW - 30 * MINUTE + i * MINUTE,
      content: `γραμμή ${i + 1} για τον κήπο`,
    })
  );
  const scene = routedScene({ callTs: NOW - 3 * HOUR + 2 * MINUTE, after });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view?.includes('γραμμή 5 για τον κήπο'), view ?? '');
  assert.ok(view?.includes('@Bot τι λες για τον τοίχο;'), 'the call is shown although the window left it out');
  assert.equal(view?.includes('σήμερα έβαψα τον τοίχο μπλε'), false, 'the older lines stay out of the window');
});

test("runTurn: a pulled channel shows the ring's earlier unanswered call with its mark", async () => {
  const earlier = lineIn(DIARY, {
    id: 'd0',
    authorId: 'u4',
    authorName: 'Zoë',
    ts: NOW - 5 * HOUR,
    content: '@Bot είσαι εδώ;',
  });
  // PR 7d: pull.minMessages is the constant 5, so five newer lines are what keep the old call out of the window.
  const newer = [2, 3, 4, 5].map((n) =>
    lineIn(DIARY, {
      id: `d${n + 1}`,
      authorId: 'u3',
      authorName: 'Éloïse',
      ts: NOW - 3 * HOUR + n * MINUTE,
      content: `και πάλι ${n}`,
    })
  );
  const diary = { messages: [earlier, ...diaryLines(), ...newer] };
  const earlierHeader = labels.pull.earlierPings.split('{date}')[0];

  const store = fakeStore();
  store.state.data.elsewherePings = [
    { messageId: 'd0', channelId: DIARY, ts: NOW - 5 * HOUR, answeredAt: null, skippedAt: null },
  ];
  const ringed = pullScene({ store, diary });
  await withCapturedLogs(() =>
    ringed.turns.runTurn({ channel: ringed.channel, mode: 'reply', trigger: ringed.trigger, triggerKind: 'mention' })
  );
  const view = channelViewOf(ringed.llm);
  assert.ok(view?.includes('@Bot είσαι εδώ;'), view ?? '');
  assert.ok(view?.includes(earlierHeader), view ?? '');
  assert.ok(view?.includes(labels.pull.pingUnanswered), view ?? '');

  // Without the ring entry the old line is outside the window and nothing is marked.
  const plain = pullScene({ diary });
  await withCapturedLogs(() =>
    plain.turns.runTurn({ channel: plain.channel, mode: 'reply', trigger: plain.trigger, triggerKind: 'mention' })
  );
  const plainView = channelViewOf(plain.llm);
  assert.equal(
    plainView?.includes('@Bot είσαι εδώ;') ||
      plainView?.includes(earlierHeader) ||
      plainView?.includes(labels.pull.pingUnanswered),
    false,
    plainView ?? ''
  );
});

test("runTurn: a routed call's pictures are captioned through the pull, never as the chat's attached pictures", async () => {
  const photo = {
    id: 'cp1',
    contentType: 'image/png',
    name: 'photo.png',
    url: 'https://cdn.discordapp.com/x/photo.png',
  };
  const describer = pullDescriber();
  const scene = routedScene({
    features: {},
    describer,
    callAttachments: new Map([['cp1', photo]]),
  });
  scene.params.trigger = {
    ...scene.params.trigger,
    attachments: [{ id: 'cp1', kind: 'image', url: photo.url, name: 'photo.png' }],
  };

  await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.deepEqual(
    callsFor(describer, 'cp1').map((call: Untyped) => call.options),
    [{ maxNew: 1 }]
  );
  assert.equal(
    scene.llm.calls[0][1].content.some((p: Untyped) => p.type === 'image_url'),
    false,
    'no image part is ever sent'
  );
  assert.ok(channelViewOf(scene.llm)?.includes('caption of cp1'));
});

test('runTurn: a read-only neighbour is marked in the server map', async () => {
  const store = fakeStore({ channels: [{ id: DIARY, name: 'diary', lastMessageAt: NOW - 10 * MINUTE, days: {} }] });
  for (const readOnly of [true, false]) {
    const scene = pullScene({
      features: {},
      diary: { messages: diaryLines(10 * MINUTE), readOnly },
      store,
    });
    await withCapturedLogs(() =>
      scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
    );
    const server = userText(scene.llm).split('<server>\n')[1].split('\n</server>')[0];
    assert.ok(server.includes('diary'), server);
    assert.equal(server.includes(labels.server.readOnly), readOnly, server);
  }
});

test('runTurn: senses name the main channel where calls from read-only channels are answered', async () => {
  const scene = pullScene({ mention: false, config: { memory: { mainChannelIds: ['c1'] } } });
  registerTextChannel(scene.channel);
  await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );
  assert.ok(userText(scene.llm).includes(fill(labels.senses.elsewhere, { destination: 'general' })));
});

test('runTurn: senses name only a usable main channel, the first one in list order', async () => {
  const sensesPrefix = labels.senses.elsewhere.split('{destination}')[0];
  const cases: Array<{
    name: string;
    main: Array<string>;
    bot?: Record<string, unknown>;
    add: (scene: Untyped) => unknown;
    expected: string | null;
  }> = [
    {
      name: 'cannot send',
      main: ['c5'],
      add: (scene: Untyped) => addChannel(scene.channel, { id: 'c5', name: 'lounge', readOnly: true }),
      expected: null,
    },
    {
      name: 'thread',
      main: ['c5'],
      add: (scene: Untyped) => addChannel(scene.channel, { id: 'c5', name: 'lounge', kind: 'thread' }),
      expected: null,
    },
    {
      name: 'first usable',
      main: ['c5', 'c6'],
      add: (scene: Untyped) => {
        addChannel(scene.channel, { id: 'c5', name: 'lounge', readOnly: true });
        addChannel(scene.channel, { id: 'c6', name: 'hall' });
      },
      expected: 'hall',
    },
  ];
  for (const { name, main, bot = {}, add, expected } of cases) {
    const scene = pullScene({ mention: false, bot, config: { memory: { mainChannelIds: main } } });
    add(scene);
    await withCapturedLogs(() =>
      scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
    );
    const text = userText(scene.llm);
    if (expected) assert.ok(text.includes(fill(labels.senses.elsewhere, { destination: expected })), name);
    else assert.equal(text.includes(sensesPrefix), false, name);
  }
});

test('usableDestination: the first usable main channel, never the excepted one; none carries its code', () => {
  const general = registerTextChannel(fakeTurnChannel());
  const hall = addChannel(general, { id: 'c6', name: 'hall' });
  const config = { bot: {}, features: {}, memory: { mainChannelIds: ['c1', 'c6'] } };
  // The destination is a conversation of the turn's listing now (it was a discord.js guild's channel cache).
  const listing = snapshotOf('g1', { conversations: [general.info, hall.info], groups: [] });

  assert.deepEqual(usableDestination(listing, config), { channel: general.info, reason: null });
  assert.deepEqual(usableDestination(listing, config, { exceptId: 'c1' }), { channel: hall.info, reason: null });
  assert.deepEqual(usableDestination(listing, { ...config, memory: { mainChannelIds: [] } }), {
    channel: null,
    reason: 'no-destination',
  });
  assert.deepEqual(
    usableDestination(null, config),
    { channel: null, reason: 'no-destination' },
    'a private chat has none'
  );
});

test('runTurn: on a routed turn the source channel takes the one pulled place and the route hook is not asked', async () => {
  // PR 7d: context.pull.maxChannels is the constant 1, so the source channel fills the place the hook would pick for.
  const hookCalls = [];
  const scene = routedScene({
    routeChannels: async (args: unknown) => {
      hookCalls.push(args);
      return [];
    },
  });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(hookCalls.length, 0);
  assert.ok(channelViewOf(scene.llm)?.includes('channel #diary'), 'the source channel is the one pulled');
});

test('runTurn: a pull that throws never fails an ordinary turn; a routed one ends in error, a noticed one in not-now', async () => {
  // A corrupt media cache throws inside fetchPull; an unreadable ring throws before any fetch.
  // `perChannel`: the failure is caught for its channel alone (the log names it and why it was pulled).
  const scenes: Array<[string, (options: Record<string, unknown>) => Record<string, unknown>, boolean]> = [
    ['fetchPull throws', (options) => ({ ...options, features: {}, describer: throwingCacheDescriber() }), true],
    ['the pull itself throws', (options) => ({ ...options, store: unreadableRingStore() }), false],
  ];
  const failedLine = (logs: Untyped, pullReason: string, perChannel: unknown) =>
    logs.find(
      (l: Untyped) =>
        l.msg === 'pull: failed' &&
        l.channel === 'c1' &&
        (perChannel ? l.source === DIARY && l.pullReason === pullReason : l.source === undefined)
    );
  for (const [name, withFailure, perChannel] of scenes) {
    const ordinary = pullScene(withFailure({}));
    const plain = await withCapturedLogs(() =>
      ordinary.turns.runTurn({
        channel: ordinary.channel,
        mode: 'reply',
        trigger: ordinary.trigger,
        triggerKind: 'mention',
      })
    );
    assert.equal(plain.result.outcome, 'spoke', name);
    assert.equal(channelViewOf(ordinary.llm), null, name);
    assert.ok(failedLine(plain.logs, 'mention', perChannel), name);

    const routed = routedScene(withFailure({}));
    const call = await withCapturedLogs(() => routed.turns.runTurn(routed.params));
    assert.equal(call.result.outcome, 'error', name);
    assert.equal(routed.llm.calls.length, 0, name);
    assert.ok(failedLine(call.logs, 'routed', perChannel), name);
    const unavailable = call.logs.find((l) => l.msg === 'turn: source unavailable');
    assert.deepEqual([unavailable?.channel, unavailable?.source, unavailable?.reason], ['c1', DIARY, 'error'], name);

    const noticed = pullScene(withFailure({ mention: false }));
    let chosen = 0;
    const comment = await withCapturedLogs(() =>
      noticed.turns.runTurn({
        channel: noticed.channel,
        mode: 'auto',
        source: { channelId: DIARY, reason: 'noticed' },
        chooseMode: () => {
          chosen += 1;
          return 'interject';
        },
      })
    );
    assert.equal(comment.result.outcome, 'not-now', name);
    assert.equal(chosen, 0, name);
    assert.ok(failedLine(comment.logs, 'noticed', perChannel), name);
    assert.equal(
      comment.logs.some((l) => l.msg === 'turn: source unavailable'),
      false,
      name
    );
  }
});

test('runTurn: a pulled channel whose fetch throws costs the turn only that channel', async () => {
  // #diary has a picture and the cache read throws for it. PR 7d: context.pull.maxChannels is the constant 1, so the
  // one place cannot be shared with a second channel and this test no longer pulls #notes beside it.
  const describer = {
    ...pullDescriber(),
    cachedDescriptions: (guildId: string, items: Untyped) => {
      if (items.some((item: Untyped) => item.itemId === 'dp1')) throw new Error('fixture: corrupt media cache');
      return new Map();
    },
  };
  const scene = pullScene({ features: {}, describer });

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(channelViewOf(scene.llm), null);
  const failed = logs.find((l) => l.msg === 'pull: failed');
  assert.deepEqual([failed?.channel, failed?.source, failed?.pullReason], ['c1', DIARY, 'mention']);
});

test('runTurn: fresh captions that fail after a chooser leave the cached ones', async () => {
  const door = { id: 'dp2', contentType: 'image/png', name: 'door.png', url: 'https://cdn.discordapp.com/x/door.png' };
  const [first, second] = diaryLines();
  const messages = [{ ...first, attachments: new Map([['dp2', door]]) }, second];
  let reads = 0;
  const describer = {
    ...pullDescriber(),
    // The fetch finds one caption in the cache; the second read, for the fresh captions, throws.
    cachedDescriptions: () => {
      reads += 1;
      if (reads > 1) throw new Error('fixture: corrupt media cache');
      return new Map([['dp1', 'cached caption of dp1']]);
    },
  };
  const scene = pullScene({ features: {}, describer, diary: { messages } });

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'auto', chooseMode: () => 'interject' })
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(reads, 2);
  const failed = logs.find((l) => l.msg === 'pull: captions failed');
  assert.deepEqual([failed?.channel, failed?.source], ['c1', DIARY]);
  assert.ok(channelViewOf(scene.llm)?.includes('cached caption of dp1'));
  assert.equal(callsFor(describer, 'dp2').length, 0, 'no fresh caption was asked');
});

test('runTurn: without labels.pull.header only the source is pulled, with cached captions only', async () => {
  const { pull, ...unlabelled } = labels;
  assert.ok(pull.header, 'the fixture has the label the live layer lacks here');

  // A mention and a route hook: nothing is fetched or asked, one no-label line.
  let asked = 0;
  const describer = pullDescriber();
  const mention = pullScene({
    features: {},
    context: { pull: { maxChannels: 2 } },
    describer,
    routeChannels: async () => {
      asked += 1;
      return [NOTES];
    },
  });
  mention.hot.prompts.labels = unlabelled;
  const plain = await withCapturedLogs(() =>
    mention.turns.runTurn({ channel: mention.channel, mode: 'reply', trigger: mention.trigger, triggerKind: 'mention' })
  );
  assert.equal(plain.result.outcome, 'spoke');
  assert.equal(mention.other.fetches.length, 0);
  assert.equal(asked, 0);
  assert.equal(callsFor(describer, 'dp1').length, 0);
  assert.deepEqual(
    plain.logs.filter((l) => l.msg.startsWith('pull: ')).map((l) => [l.msg, l.channel, l.reason]),
    [['pull: skipped', 'c1', 'no-label']]
  );

  // A routed turn: its source is pulled, no fresh caption is asked.
  const routedDescriber = pullDescriber();
  const routed = routedScene({ features: {}, describer: routedDescriber });
  routed.hot.prompts.labels = unlabelled;
  const call = await withCapturedLogs(() => routed.turns.runTurn(routed.params));
  assert.equal(call.result.outcome, 'spoke');
  assert.ok(call.logs.some((l) => l.msg === 'pull: channel' && l.source === DIARY));
  assert.equal(callsFor(routedDescriber, 'dp1').length, 0);

  // A noticed turn whose chooser picks a mode: no fresh caption after it either.
  const noticedDescriber = pullDescriber();
  const noticed = pullScene({ mention: false, features: {}, describer: noticedDescriber });
  noticed.hot.prompts.labels = unlabelled;
  const comment = await withCapturedLogs(() =>
    noticed.turns.runTurn({
      channel: noticed.channel,
      mode: 'auto',
      source: { channelId: DIARY, reason: 'noticed' },
      chooseMode: () => 'interject',
    })
  );
  assert.equal(comment.result.outcome, 'spoke');
  assert.equal(callsFor(noticedDescriber, 'dp1').length, 0);
  assert.equal(
    comment.logs.some((l) => l.msg === 'pull: captions'),
    false
  );

  // Nothing to pull: no line at all.
  const quiet = pullScene({ mention: false });
  quiet.hot.prompts.labels = unlabelled;
  const none = await withCapturedLogs(() =>
    quiet.turns.runTurn({ channel: quiet.channel, mode: 'reply', trigger: quiet.trigger, triggerKind: 'mention' })
  );
  assert.equal(
    none.logs.some((l) => l.msg.startsWith('pull: ')),
    false
  );
});

// --- another channel pulled into a turn (<channel_view>): the outputs ---------------------------
// In pullScene the chat is #1 m1 (Bob), #2 m9 (Alice, the trigger) and the diary #3 d1, #4 d2;
// in routedScene the chat is #1 m1 (Bob) and the diary #2 d1, #3 d2, #4 d3 (the call).

/** Discord's jump link to a diary line of the fixture guild g1. */
function diaryLink(messageId: string) {
  return `https://discord.com/channels/g1/${DIARY}/${messageId}`;
}

/** `text` with the jump link to diary line `messageId`, joined through the fixture's labels.elsewhere.link. */
function linked(text: string, messageId: string) {
  return fill(labels.elsewhere.link, { text, link: diaryLink(messageId) });
}

test('runTurn: a reaction to a pulled line reacts in the source channel, one to a chat line stays here', async () => {
  const scene = pullScene({
    features: {},
    llm: fakeLlm('<react to="#3">🎉</react><react to="#2">👍</react>'),
  });

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.other.reactCalls, [{ id: 'd1', emoji: '🎉' }]);
  assert.deepEqual(scene.channel.reactCalls, [{ id: 'm9', emoji: '👍' }]);
  assert.equal(
    logs.some((l) => l.msg === 'turn: reaction dropped'),
    false
  );
});

test('runTurn: a reaction to a pulled line is dropped where the bot cannot react', async () => {
  const scene = pullScene({
    features: {},
    llm: fakeLlm('<react to="#3">🎉</react><react to="#2">👍</react>'),
  });
  scene.other.permit({ react: false });

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );

  assert.equal(result.outcome, 'spoke');
  assert.ok(channelViewOf(scene.llm), 'the channel is still shown');
  assert.deepEqual(scene.other.reactCalls, []);
  assert.deepEqual(scene.channel.reactCalls, [{ id: 'm9', emoji: '👍' }], 'a reaction on a chat line is unchanged');
  const dropped = logs.filter((l) => l.msg === 'turn: reaction dropped');
  assert.deepEqual(
    dropped.map((l) => [l.channel, l.source, l.reason]),
    [['c1', DIARY, 'cannot-react']]
  );
});

test('runTurn: a reply to a pulled line posts plain here with one jump link to that line', async () => {
  const scene = pullScene({
    features: {},
    llm: fakeLlm('<msg reply="#3">ωραίο μπλε</msg><msg reply="#3">πολύ ωραίο</msg><msg reply="#2">ναι, το είδα</msg>'),
  });

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );

  assert.equal(result.outcome, 'spoke');
  const [first, second, third] = scene.channel.sent;
  assert.equal(first.content, linked('ωραίο μπλε', 'd1'));
  assert.equal(first.reply, undefined, 'never a Discord reply across channels');
  assert.equal(second.content, 'πολύ ωραίο', 'a second reply to the same line adds no second link');
  assert.equal(second.reply, undefined);
  assert.equal(third.content, 'ναι, το είδα');
  assert.equal(third.reply?.messageReference, 'm9', 'a reply to a chat line is unchanged');
  assert.equal(scene.other.sent.length, 0, 'nothing is posted in the pulled channel');
  const sent = logs.filter((l) => l.msg === 'turn: sent');
  assert.deepEqual(
    sent.map((l) => l.link ?? false),
    [true, false, false]
  );
  assert.equal(
    sent.some((l) => 'source' in l),
    false,
    'a turn without a source logs none'
  );
});

test('runTurn: a routed turn posts in the destination with the link to the call on its first message', async () => {
  const scene = routedScene({
    features: {},
    llm: fakeLlm('<msg>καλημέρα</msg><msg reply="#4">ναι, μπλε</msg><msg reply="#2">κι αυτό ωραίο</msg>'),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    scene.channel.sent.map((post) => post.content),
    [linked('καλημέρα', 'd3'), 'ναι, μπλε', linked('κι αυτό ωραίο', 'd1')],
    'the call once, on the first message; another pulled line it answers gets its own'
  );
  assert.ok(
    scene.channel.sent.every((post) => post.reply === undefined),
    'never a Discord reply to the call'
  );
  assert.equal(scene.other.sent.length, 0, 'nothing is posted in the source');
  const sent = logs.filter((l) => l.msg === 'turn: sent');
  assert.deepEqual(
    sent.map((l) => [l.channel, l.source, l.link ?? false]),
    [
      ['c1', DIARY, true],
      ['c1', DIARY, false],
      ['c1', DIARY, true],
    ]
  );
});

test('runTurn: a noticed turn links its first message to the newest line of its source shown', async () => {
  const scene = pullScene({
    mention: false,
    features: {},
    llm: fakeLlm('<msg>τι ωραίο χρώμα</msg>'),
  });

  const { result } = await withCapturedLogs(() =>
    scene.turns.runTurn({
      channel: scene.channel,
      mode: 'auto',
      source: { channelId: DIARY, reason: 'noticed' },
      chooseMode: () => 'interject',
    })
  );

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    scene.channel.sent.map((post) => [post.content, post.reply]),
    [[linked('τι ωραίο χρώμα', 'd2'), undefined]]
  );
});

test('runTurn: the author of a pulled line is mentioned by the handle on their line', async () => {
  const scene = routedScene({
    features: {},
    llm: fakeLlm(`<msg>@${handleOf('u3')} ωραίος τοίχος @Éloïse</msg>`),
  });

  await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  const [post] = scene.channel.sent;
  assert.equal(post.content, linked('<@u3> ωραίος τοίχος @Éloïse', 'd3'));
  assert.deepEqual(post.allowedMentions.users, ['u3']);
});

test('runTurn: a GIF answering a pulled line posts plain with its jump link', async () => {
  const scene = routedScene({
    hot: drawHot(),
    images: fakeImages(),
    store: gifStore(),
    llm: fakeLlm('<gif reply="#4">g1</gif>'),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const [gif] = scene.channel.sent;
  assert.deepEqual(
    [gif.content, gif.reply],
    [linked('https://tenor.com/view/chat-qui-danse-1', 'd3'), undefined],
    'the media URL first, so it still embeds'
  );
  assert.equal(logs.find((l) => l.msg === 'turn: gif sent')?.link, true);
});

test('runTurn: a GIF alone answering a routed call links the call; after a message it carries none', async () => {
  const alone = routedScene({
    features: {},
    store: gifStore(),
    llm: fakeLlm('<gif>g1</gif>'),
  });
  await withCapturedLogs(() => alone.turns.runTurn(alone.params));
  assert.deepEqual(
    alone.channel.sent.map((post) => [post.content, post.reply]),
    [[linked('https://tenor.com/view/chat-qui-danse-1', 'd3'), undefined]]
  );

  const after = routedScene({
    features: {},
    store: gifStore(),
    llm: fakeLlm('<msg>κοίτα</msg><gif>g1</gif>'),
  });
  const { logs } = await withCapturedLogs(() => after.turns.runTurn(after.params));
  assert.deepEqual(
    after.channel.sent.map((post) => post.content),
    [linked('κοίτα', 'd3'), 'https://tenor.com/view/chat-qui-danse-1'],
    'one link per turn, on its first post'
  );
  assert.equal('link' in (logs.find((l) => l.msg === 'turn: gif sent') ?? {}), false);
});

test('runTurn: a follow-up reply to a pulled line posts plain with its jump link', async () => {
  const scene = pullScene({
    features: {},
    llm: fakeLlm('<msg reply="#3">ωραίο μπλε</msg><msg reply="#2">ναι</msg>'),
  });

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'followUp' })
  );

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    scene.channel.sent.map((post) => [post.content, post.reply]),
    [
      [linked('ωραίο μπλε', 'd1'), undefined],
      ['ναι', undefined],
    ],
    'a follow-up quotes nothing, yet links the pulled line it answers'
  );
  assert.deepEqual(
    logs.filter((l) => l.msg === 'turn: sent').map((l) => l.link ?? false),
    [true, false]
  );
});

test('runTurn: @name of an author whose pulled block the budget dropped stays text', async () => {
  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const scene = pullScene({
    features: {},
    context: { caps },
    llm: fakeLlm('<msg>@Éloïse γεια</msg>'),
  });

  await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );

  assert.equal(channelViewOf(scene.llm), null, 'the block was cut');
  const [post] = scene.channel.sent;
  assert.equal(post.content, '@Éloïse γεια');
  assert.deepEqual(post.allowedMentions.users, []);
});

test('runTurn: a noticed turn whose source block the budget dropped posts no link', async () => {
  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const scene = pullScene({
    mention: false,
    context: { caps },
    features: {},
    llm: fakeLlm('<msg>τι ωραίο χρώμα</msg>'),
  });

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({
      channel: scene.channel,
      mode: 'auto',
      source: { channelId: DIARY, reason: 'noticed' },
      chooseMode: () => 'interject',
    })
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(channelViewOf(scene.llm), null, 'nothing of the source was shown');
  assert.deepEqual(
    scene.channel.sent.map((post) => post.content),
    ['τι ωραίο χρώμα']
  );
  assert.equal('link' in (logs.find((l) => l.msg === 'turn: sent') ?? {}), false);
});

test('runTurn: a reaction on a pulled line whose channel is gone is dropped as not-found', async () => {
  let other: { leave: () => void } | null = null;
  const calls: Array<Untyped> = [];
  // The pulled channel leaves the community while the model answers.
  const llm = {
    calls,
    complete: async (messages: unknown) => {
      calls.push(messages);
      other?.leave();
      return { text: '<react to="#3">🎉</react>', usage: {}, estimated: 10 };
    },
  };
  const scene = pullScene({ llm });
  other = scene.other;

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );

  assert.equal(result.outcome, 'spoke');
  assert.ok(channelViewOf(scene.llm), 'the channel was shown');
  assert.deepEqual([scene.other.reactCalls, scene.channel.reactCalls], [[], []]);
  const dropped = logs.filter((l) => l.msg === 'turn: reaction dropped');
  assert.deepEqual(
    dropped.map((l) => [l.channel, l.source, l.reason]),
    [['c1', DIARY, 'not-found']]
  );
  assert.equal(
    logs.some((l) => l.msg === 'turn: reaction failed'),
    false
  );
});

test('runTurn: labels.elsewhere.link is read at the moment of use; without it the link follows a newline', async () => {
  const scene = routedScene({ features: {}, llm: fakeLlm('<msg>ναι</msg>') });
  const run = () => withCapturedLogs(() => scene.turns.runTurn(scene.params));

  await run();
  scene.hot.prompts.labels = { ...labels, elsewhere: { ...labels.elsewhere, link: '{text} -> {link}' } };
  await run();
  const { elsewhere, ...withoutElsewhere } = labels;
  scene.hot.prompts.labels = { ...withoutElsewhere, elsewhere: { called: elsewhere.called } };
  await run();

  assert.deepEqual(
    scene.channel.sent.map((post) => post.content),
    [`ναι [from ${diaryLink('d3')}]`, `ναι -> ${diaryLink('d3')}`, `ναι\n${diaryLink('d3')}`]
  );
});

// The core does not cut a post, the adapter splits it: the texts a fake channel received, and what a split keeps.
const postedTexts = (channel: { sent: Array<{ content?: string }> }) => channel.sent.map((p) => p.content ?? '');
function assertSplitIntact(posts: Untyped) {
  assert.ok(posts.length > 1, 'the adapter split it');
  const intact = (c: Untyped) => [...c].length <= 2000 && c.lastIndexOf('<') <= c.lastIndexOf('>');
  assert.ok(posts.every(intact), 'each message fits Discord and holds no half token');
}

test('runTurn: a post over the Discord limit keeps its link and arrives whole as several messages', async () => {
  const long = `${'a'.repeat(1990)}${' :dance:'.repeat(5)}`;
  const scene = routedScene({ features: {}, llm: fakeLlm(`<msg>${long}</msg>`) });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: scene.hot,
    store: fakeStore(),
    llm: scene.llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
    imageFetcher: fakeImageFetcher(),
    now: () => NOW,
  });

  const { result } = await withCapturedLogs(() => turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const posts = postedTexts(scene.channel);
  assertSplitIntact(posts);
  assert.ok(posts.join('').startsWith('a'.repeat(1990)), 'the text is not cut at its end');
  assert.ok(posts.join('').endsWith(` [from ${diaryLink('d3')}]`), 'the link is kept');
});

test('runTurn: a pulled channel gets its seen mark and its spokeSaw ids', async () => {
  const scene = routedScene({ features: {} });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.store.state.data.elsewhereSeen, { [DIARY]: NOW - 2 * MINUTE }, 'the newest line shown');
  for (const id of ['d1', 'd2', 'd3']) assert.equal(scene.turns.spokeAfterSeeing(DIARY, id), true, id);
  assert.equal(scene.turns.spokeAfterSeeing(DIARY, 'm1'), false);
  assert.equal(scene.turns.spokeAfterSeeing('c1', 'm1'), true, "the destination's own history as before");
});

test('runTurn: a pulled channel the bot can write in gets a seen mark but no spokeSaw ids', async () => {
  const scene = pullScene({ features: {} });

  await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );

  assert.deepEqual(scene.store.state.data.elsewhereSeen, { [DIARY]: NOW - 3 * HOUR + MINUTE });
  assert.equal(scene.turns.spokeAfterSeeing(DIARY, 'd1'), false, 'a call written there is answered there');
  assert.equal(scene.turns.spokeAfterSeeing('c1', 'm9'), true);
});

test('runTurn: the seen mark follows the request sent: set on a skip, never for a block the budget dropped', async () => {
  const skipped = routedScene({ llm: fakeLlm('<skip/>') });
  const skip = await withCapturedLogs(() => skipped.turns.runTurn(skipped.params));
  assert.equal(skip.result.outcome, 'skip');
  assert.deepEqual(skipped.store.state.data.elsewhereSeen, { [DIARY]: NOW - 2 * MINUTE }, 'a skip saw the block');
  assert.equal(skipped.turns.spokeAfterSeeing(DIARY, 'd3'), false, 'no spokeSaw without speaking');

  // A channel the bot cannot write in, the one kind that gets spokeSaw ids: shown -> its ids,
  // cut by the budget -> none.
  const kept = pullScene({ diary: { readOnly: true } });
  const shown = await withCapturedLogs(() =>
    kept.turns.runTurn({ channel: kept.channel, mode: 'reply', trigger: kept.trigger, triggerKind: 'mention' })
  );
  assert.equal(shown.result.outcome, 'spoke');
  assert.ok(channelViewOf(kept.llm), 'the control shows the block');
  assert.equal(kept.turns.spokeAfterSeeing(DIARY, 'd1'), true, 'the control records what it showed');

  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const dropped = pullScene({ diary: { readOnly: true }, context: { caps } });
  const cut = await withCapturedLogs(() =>
    dropped.turns.runTurn({ channel: dropped.channel, mode: 'reply', trigger: dropped.trigger, triggerKind: 'mention' })
  );
  assert.equal(cut.result.outcome, 'spoke');
  assert.equal(dropped.other.fetches.length, 1, 'the channel was pulled');
  assert.equal(channelViewOf(dropped.llm), null, 'and its block cut by the budget');
  assert.equal(dropped.store.state.data.elsewhereSeen, undefined);
  assert.equal(dropped.turns.spokeAfterSeeing(DIARY, 'd1'), false);
});

test('runTurn: a routed turn that only reacts on its call counts as spoke', async () => {
  const scene = routedScene({ features: {}, llm: fakeLlm('<react to="#4">👍</react>') });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke', 'the caller of a routed turn marks the call answered on spoke');
  assert.equal(result.delivered, true, 'the reaction was put');
  assert.deepEqual(scene.other.reactCalls, [{ id: 'd3', emoji: '👍' }]);
  assert.deepEqual(scene.channel.sent, []);
});

test('runTurn: a turn whose output never reached the chat reports delivered false', async () => {
  const quiet = { typingSimulation: false };
  // The bot may not react in the source: the one reaction, on the call, is dropped.
  const denied = routedScene({ features: quiet, llm: fakeLlm('<react to="#4">👍</react>') });
  denied.other.permit({ react: false });
  const dropped = await withCapturedLogs(() => denied.turns.runTurn(denied.params));
  assert.deepEqual([dropped.result.outcome, dropped.result.delivered], ['spoke', false]);
  assert.deepEqual([denied.other.reactCalls, denied.channel.sent], [[], []]);
  assert.ok(dropped.logs.some((l) => l.msg === 'turn: reaction dropped' && l.reason === 'cannot-react'));

  // Discord refuses the reaction on a chat line.
  const refusing = routedScene({ features: quiet, llm: fakeLlm('<react to="#1">👍</react>') });
  world().port.failNext('react', {
    status: 'failed',
    error: { code: 'fixture-refused', retryable: false },
  });
  const failed = await withCapturedLogs(() => refusing.turns.runTurn(refusing.params));
  assert.deepEqual([failed.result.outcome, failed.result.delivered], ['spoke', false]);
  assert.ok(failed.logs.some((l) => l.msg === 'turn: reaction failed'));

  // A picture moderation refused: it comes back to her as a result, and a turn that posted nothing delivered nothing.
  // PR 7d: drawings have no daily caps, so a moderation refusal stands in for the refused picture.
  const capped = routedScene({
    hot: drawHot(),
    images: fakeImages({ error: new ImageGenError('moderation', 'image refused by moderation (HTTP 400)') }),
    llm: sequenceLlm([toolAnswer('', [call('draw.create', { reply: '#1', text: 'a blue wall' })]), '<skip/>']),
  });
  const refused = await withCapturedLogs(() => capped.turns.runTurn(capped.params));
  assert.deepEqual([refused.result.outcome, refused.result.delivered], ['spoke', false]);
  assert.equal(capped.channel.sent.length, 0, 'no limit notice');

  // A message or a picture reached the chat.
  const said = routedScene({ features: quiet });
  assert.equal((await withCapturedLogs(() => said.turns.runTurn(said.params))).result.delivered, true);
  const drawn = routedScene({
    hot: drawHot(),
    images: fakeImages(),
    llm: fakeLlm(toolAnswer('', [call('draw.create', { reply: '#1', text: 'a blue wall' })])),
  });
  assert.equal((await withCapturedLogs(() => drawn.turns.runTurn(drawn.params))).result.delivered, true);
});

// --- the ring of calls after a turn that showed some (state.json `elsewherePings`) --------------

/** A ring entry for the diary line `line`, unanswered and unskipped. */
function ringEntry(line: Untyped) {
  return { messageId: line.id, channelId: DIARY, ts: line.createdTimestamp, answeredAt: null, skippedAt: null };
}

/** The state of each ring entry of `store` by message id: `answered`, `skipped` or `unanswered`. */
function ringStates(store: Untyped) {
  return Object.fromEntries(
    store.state.data.elsewherePings.map((entry: Untyped) => [entry.messageId, pingStatus(entry)])
  );
}

/** The `elsewhere: marked` lines of `logs` as [source, message, status], sorted by message id. */
function markedLines(logs: Untyped) {
  return logs
    .filter((l: Untyped) => l.msg === 'elsewhere: marked')
    .map(({ source, message, status }: Untyped) => [source, message, status])
    .sort((a: Untyped, b: Untyped) => a[1].localeCompare(b[1]));
}

/**
 * pullScene options whose read-only #diary holds two calls to the persona before its lines (e1 by
 * Zoë, e2 by Chloé, both in the ring): in the request #3 e1, #4 e2, #5 d1, #6 d2.
 */
function ringedDiary(options: Parameters<typeof pullScene>[0] = {}) {
  const calls = [
    lineIn(DIARY, {
      id: 'e1',
      authorId: 'u4',
      authorName: 'Zoë',
      ts: NOW - 3 * HOUR - 10 * MINUTE,
      content: '@Bot είσαι εδώ;',
    }),
    lineIn(DIARY, {
      id: 'e2',
      authorId: 'u5',
      authorName: 'Chloé',
      ts: NOW - 3 * HOUR - 5 * MINUTE,
      content: '@Bot καλημέρα',
    }),
  ];
  const store = fakeStore();
  store.state.data.elsewherePings = calls.map(ringEntry);
  const { diary = {}, ...rest } = options;
  return { store, ...rest, diary: { messages: [...calls, ...diaryLines()], readOnly: true, ...diary } };
}

test('runTurn: a turn that showed calls of a read-only channel stamps them: answered when its output answered them, skipped otherwise', async () => {
  const quiet = { typingSimulation: false };
  const answerCases: Array<[string, string, Record<string, string>]> = [
    ['a reply to e1', '<msg reply="#3">ναι, εδώ είμαι</msg>', { e1: 'answered', e2: 'skipped' }],
    ['a reaction on e2', '<react to="#4">👍</react>', { e1: 'skipped', e2: 'answered' }],
    ['a GIF answering e2', '<msg>χα</msg><gif reply="#4">g1</gif>', { e1: 'skipped', e2: 'answered' }],
    ['a reply to a diary line that is no call', '<msg reply="#5">ωραίο</msg>', { e1: 'skipped', e2: 'skipped' }],
    ['a message answering no pulled line', '<msg>καλημέρα</msg>', { e1: 'skipped', e2: 'skipped' }],
  ];
  for (const [label, answer, states] of answerCases) {
    const scene = pullScene(ringedDiary({ features: quiet, llm: fakeLlm(answer) }));
    scene.store.findGif = gifStore().findGif;

    const { result, logs } = await withCapturedLogs(() =>
      scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
    );

    assert.equal(result.outcome, 'spoke', label);
    assert.ok(channelViewOf(scene.llm)?.includes('@Bot είσαι εδώ;'), label);
    assert.deepEqual(ringStates(scene.store), states, label);
    assert.deepEqual(
      markedLines(logs),
      Object.entries(states).map(([id, status]) => [DIARY, id, status]),
      label
    );
    for (const entry of scene.store.state.data.elsewherePings as Array<Untyped>) {
      assert.equal(entry.answeredAt ?? entry.skippedAt, NOW, `${label}: stamped at the turn's clock`);
    }
  }

  // The reply to e1 posts in the chat with its jump link, never as a Discord reply across channels.
  const replied = pullScene(ringedDiary({ features: quiet, llm: fakeLlm('<msg reply="#3">ναι, εδώ είμαι</msg>') }));
  await withCapturedLogs(() =>
    replied.turns.runTurn({ channel: replied.channel, mode: 'reply', trigger: replied.trigger, triggerKind: 'mention' })
  );
  assert.deepEqual(
    replied.channel.sent.map((post) => [post.content, post.reply]),
    [[linked('ναι, εδώ είμαι', 'e1'), undefined]]
  );
});

test('runTurn: a turn that chose silence stamps the calls it showed skipped; a dropped block or a writable channel stamps none', async () => {
  const silent = pullScene(ringedDiary({ llm: fakeLlm('<skip/>') }));
  const skip = await withCapturedLogs(() =>
    silent.turns.runTurn({ channel: silent.channel, mode: 'reply', trigger: silent.trigger, triggerKind: 'mention' })
  );
  assert.equal(skip.result.outcome, 'skip');
  assert.deepEqual(
    ringStates(silent.store),
    { e1: 'skipped', e2: 'skipped' },
    'she had them in view and chose silence'
  );
  assert.deepEqual(markedLines(skip.logs), [
    [DIARY, 'e1', 'skipped'],
    [DIARY, 'e2', 'skipped'],
  ]);

  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const cases: Array<[string, Parameters<typeof pullScene>[0], string]> = [
    ['the block cut by the budget', ringedDiary({ context: { caps } }), 'spoke'],
    ['a skip whose block was cut', ringedDiary({ context: { caps }, llm: fakeLlm('<skip/>') }), 'skip'],
    // A call written where the bot can write is answered there, not by being shown here.
    [
      'a writable channel',
      ringedDiary({ diary: { readOnly: false }, llm: fakeLlm('<msg reply="#3">ναι</msg>') }),
      'spoke',
    ],
  ];
  for (const [label, options, outcome] of cases) {
    const scene = pullScene(options);
    const { result, logs } = await withCapturedLogs(() =>
      scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
    );
    assert.equal(result.outcome, outcome, label);
    assert.deepEqual(ringStates(scene.store), { e1: 'unanswered', e2: 'unanswered' }, label);
    assert.deepEqual(markedLines(logs), [], label);
  }

  // Paused while the turn ran (the owner may be editing data/): the ring is left as it was.
  const paused = pullScene(ringedDiary());
  paused.llm.complete = async () => {
    paused.store.state.data.paused = true;
    return { text: '<msg reply="#3">ναι</msg>', usage: {}, estimated: 10 };
  };
  const late = await withCapturedLogs(() =>
    paused.turns.runTurn({ channel: paused.channel, mode: 'reply', trigger: paused.trigger, triggerKind: 'mention' })
  );
  assert.equal(late.result.outcome, 'spoke');
  assert.deepEqual(ringStates(paused.store), { e1: 'unanswered', e2: 'unanswered' });
});

test('runTurn: a routed turn stamps the other calls it showed and leaves its own call to its caller', async () => {
  // The diary in the request: #2 d1, #3 d2, #4 e1 (an earlier call by Zoë), #5 d3 (the routed call).
  const earlier = lineIn(DIARY, {
    id: 'e1',
    authorId: 'u4',
    authorName: 'Zoë',
    ts: NOW - 4 * MINUTE,
    content: '@Bot είσαι εδώ;',
  });
  const routedCases: Array<[string, string, string, Record<string, string>]> = [
    ['a reply to the earlier call', '<msg reply="#4">ναι, Zoë</msg>', 'spoke', { e1: 'answered', d3: 'unanswered' }],
    ['a reply to its own call', '<msg reply="#5">ναι</msg>', 'spoke', { e1: 'skipped', d3: 'unanswered' }],
    ['silence', '<skip/>', 'skip', { e1: 'skipped', d3: 'unanswered' }],
  ];
  for (const [label, answer, outcome, states] of routedCases) {
    const scene = routedScene({ features: {}, before: [earlier], llm: fakeLlm(answer) });
    scene.store.state.data.elsewherePings = [
      ringEntry(earlier),
      ringEntry({ id: 'd3', createdTimestamp: NOW - 2 * MINUTE }),
    ];

    const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

    assert.equal(result.outcome, outcome, label);
    assert.deepEqual(
      ringStates(scene.store),
      states,
      `${label}: the routed call is stamped by its caller (src/behavior/pipeline.ts)`
    );
    assert.deepEqual(markedLines(logs), [[DIARY, 'e1', states.e1]], label);
    assert.equal('sourceShownIds' in result, false, label);
  }
});

// --- <recent>: the recent lines a turn may show -------------------------------------------------

const OPEN_ROOM = '100000000000000011';
const STAFF_ROOM = '100000000000000012';
const STAFF_ROLE = '100000000000000099';

const EVERYONE_AUDIENCE = {
  everyone: true,
  groups: [],
  groupAllow: [],
  groupDeny: [],
  memberAllow: [],
  memberDeny: [],
  memberGroups: {},
};

/** What every group can view: everyone, and the staff group on its own. */
const ALL_GROUPS_VIEW = { ...EVERYONE_AUDIENCE, groups: [STAFF_ROLE] };

/**
 * Gives the community two more text channels the bot reads (quiet: never a neighbour): #open, which every
 * group can view, and #staff, which only the staff group (STAFF_ROLE) can. `turnChannels` are the channels of the
 * test that every group can view as well (a fakeTurnChannel is open to everyone, with no group in mind).
 */
function audienceGuild(...turnChannels: Array<Untyped>) {
  for (const turnChannel of turnChannels) turnChannel.update({ audience: ALL_GROUPS_VIEW });
  const open = fakeTurnChannel({ id: OPEN_ROOM, name: 'open', audience: ALL_GROUPS_VIEW });
  const staff = fakeTurnChannel({
    id: STAFF_ROOM,
    name: 'staff',
    audience: { ...EVERYONE_AUDIENCE, everyone: false, groups: [STAFF_ROLE] },
  });
  return { open, staff };
}

/** Three live lines: one of #general (c1), one of #open, one of #staff. */
function threeRooms() {
  return [
    { id: 1, at: NOW - 3 * HOUR, addedAt: null, channelId: 'c1', text: 'εδώ το πρωί', who: [], weight: 2 },
    { id: 2, at: NOW - 2 * HOUR, addedAt: null, channelId: OPEN_ROOM, text: 'στην αυλή', who: [], weight: 2 },
    { id: 3, at: NOW - HOUR, addedAt: null, channelId: STAFF_ROOM, text: 'στο γραφείο', who: [], weight: 2 },
  ];
}

/** A store like fakeStore that also holds `lines` as the guild's recent lines; `recentReads` counts the reads. */
function recentStore(lines: Untyped, base?: Parameters<typeof fakeStore>[0]) {
  const store = fakeStore(base);
  store.recentReads = 0;
  store.getRecent = () => {
    store.recentReads += 1;
    return { nextId: lines.length + 1, lines: structuredClone(lines) };
  };
  return store;
}

/** The `recent: shown` entries of `logs`, without the logger's own fields. */
function recentShownLogs(logs: Untyped) {
  return logs
    .filter((entry: Untyped) => entry.msg === 'recent: shown')
    .map(({ level, time, msg, ...fields }: Untyped) => fields);
}

test("turn: <recent> shows this channel's lines and those of channels everyone here can read, never a narrower channel's", async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const rooms = audienceGuild(channel);
  const store = recentStore(threeRooms(), { channels: [{ id: OPEN_ROOM, name: 'open' }] });
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );

  assert.equal(result.outcome, 'skip');
  const text = userText(llm);
  const recent = text.split('<recent>\n')[1].split('\n</recent>')[0];
  assert.ok(recent.includes('εδώ το πρωί'), "this channel's line");
  const at = NOW - 2 * HOUR;
  const openLine = fill(labels.recent.lineIn, {
    date: formatDate(at, 'UTC', labels.locale),
    time: formatClock(at, 'UTC', labels.locale),
    channel: 'open',
    text: 'στην αυλή',
  });
  assert.ok(recent.includes(openLine), 'named by its channel');
  assert.ok(!text.includes('στο γραφείο'), 'a channel only the staff can read never reaches #general');

  // In #staff, whose readers can all read #general and #open, all three are shown.
  world().seed(STAFF_ROOM, [{ ...raw, channelId: STAFF_ROOM }]);
  const staffChannel = rooms.staff;
  const staffLlm = fakeLlm('<skip/>');
  const staffTurns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store,
    llm: staffLlm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });
  await withCapturedLogs(() =>
    staffTurns.runTurn({
      channel: staffChannel,
      mode: 'reply',
      trigger: { ...normalizedTrigger(raw), channelId: STAFF_ROOM },
      triggerKind: 'mention',
    })
  );
  assert.ok(
    userText(staffLlm).includes('στο γραφείο') &&
      userText(staffLlm).includes('στην αυλή') &&
      userText(staffLlm).includes('εδώ το πρωί')
  );
});

test('turn: a private chat shows only the recent lines of channels everyone on the server can read', async () => {
  const general = fakeTurnChannel({ id: 'c1' });
  const rooms = audienceGuild(general);
  const guild = { id: 'g1' };
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const dm = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const store = recentStore(threeRooms());
  const llm = fakeLlm('<skip/>');
  const client = fakeClient();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store,
    llm,
    calibrator: identityCalibrator(),
    client,
    now: () => NOW,
  });

  await withCapturedLogs(() =>
    turns.runTurn({
      channel: dm,
      guildId: guild.id,
      mode: 'reply',
      trigger: normalizedTrigger(raw),
      triggerKind: 'private',
    })
  );

  const text = userText(llm);
  assert.ok(text.includes('εδώ το πρωί') && text.includes('στην αυλή'), 'channels every member can read');
  assert.ok(!text.includes('στο γραφείο'));

  // A group denied on #open hides it from some members: it is no longer every member's.
  rooms.open.update({ audience: { ...EVERYONE_AUDIENCE, groupDeny: [STAFF_ROLE] } });
  const deniedLlm = fakeLlm('<skip/>');
  const denied = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store,
    llm: deniedLlm,
    calibrator: identityCalibrator(),
    client,
    now: () => NOW,
  });
  await withCapturedLogs(() =>
    denied.runTurn({
      channel: dm,
      guildId: guild.id,
      mode: 'reply',
      trigger: normalizedTrigger(raw),
      triggerKind: 'private',
    })
  );
  assert.ok(userText(deniedLlm).includes('εδώ το πρωί') && !userText(deniedLlm).includes('στην αυλή'));
});

test('turn: with no live line <recent> still shows the moments of the last hours, and a line hidden here changes nothing', async () => {
  const nikos = {
    id: 'u9',
    names: ['Nikos'],
    episodes: [
      {
        date: '2026-09-19',
        what: 'η στιγμή του Nikos',
        quote: '',
        feeling: '',
        weight: 3,
        addedAt: new Date(NOW - 20 * HOUR).toISOString(),
      },
    ],
  };
  const run = async (lines: unknown) => {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    audienceGuild(channel);
    const llm = fakeLlm('<skip/>');
    const store = recentStore(lines, { userProfiles: { u9: nikos } });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: fakeHot(),
      store,
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      now: () => NOW,
    });
    const { logs } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
    );
    return { text: userText(llm), logs };
  };
  const quiet = await run([]);
  const moment = fill(labels.recent.episode, {
    date: formatDate(Date.parse('2026-09-19T12:00:00Z'), 'UTC', labels.locale),
    name: 'Nikos',
    what: 'η στιγμή του Nikos',
  });
  assert.ok(
    quiet.text.includes(`<recent>\n${fill(labels.recent.header, { hours: 72 })}\n${moment}\n</recent>`),
    'an empty store still shows the moments'
  );

  const staffOnly = await run([threeRooms()[2]]);
  assert.equal(staffOnly.text, quiet.text, 'a line only #staff can read neither switches the moments on nor off');
});

test('turn: a store without the recent store reads nothing; an empty or a broken one never breaks a turn', async () => {
  const run = async ({ store }: { store: FakeStore }) => {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    audienceGuild(channel);
    const llm = fakeLlm('<skip/>');
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: fakeHot(),
      store,
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      now: () => NOW,
    });
    const { result, logs } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
    );
    return { result, logs, sent: llm.calls[0] };
  };
  const before = await run({ store: fakeStore() });
  assert.equal(before.result.outcome, 'skip', 'a store without getRecent never breaks a turn');
  assert.ok(!userTextOf(before.sent).includes('<recent>'));

  const empty = await run({ store: recentStore([]) });
  assert.deepEqual(empty.sent, before.sent, 'an empty store and no moment in the window: the request as before');
  assert.deepEqual(recentShownLogs(empty.logs), []);

  // A store whose read throws: logged, no block, the turn goes on.
  const broken = fakeStore();
  broken.getRecent = () => {
    throw new Error('fixture: unreadable recent store');
  };
  const failed = await run({ store: broken });
  assert.equal(failed.result.outcome, 'skip');
  assert.deepEqual(failed.sent, before.sent);
  assert.ok(failed.logs.some((entry) => entry.msg === 'recent: failed' && entry.channel === 'c1'));
});

// --- the request input, named in full (src/behavior/turn-input.ts) ----------------------------

/** Makes #open and #staff of audienceGuild active neighbours (a fresh line each), recording their history reads. */
function activeRooms(rooms: Untyped) {
  const fetched: Array<Untyped> = [];
  for (const [room, text] of [
    [rooms.open, 'στην αυλή τώρα'],
    [rooms.staff, 'στο γραφείο τώρα'],
  ]) {
    const line = lineIn(room.id, {
      id: `${room.id}-1`,
      authorId: 'u5',
      authorName: 'Inès',
      ts: NOW - 2 * MINUTE,
      content: text,
    });
    world().seed(room.id, [line]);
    room.update({ lastMessageAt: NOW - 2 * MINUTE });
  }
  world().tap('history', ([ref]: Array<Untyped>) => {
    if ([OPEN_ROOM, STAFF_ROOM].includes(ref.conversationId)) fetched.push(ref.conversationId);
  });
  return fetched;
}

test('runTurn: a neighbour whose audience the channel does not cover is left out of <other_channels> and <server>, unfetched', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const fetched = activeRooms(audienceGuild(channel));
  const store = fakeStore({
    channels: [
      { id: 'c1', name: 'general', days: {} },
      { id: OPEN_ROOM, name: 'open', note: 'η αυλή του σπιτιού', days: {} },
      { id: STAFF_ROOM, name: 'staff', note: 'το γραφείο της ομάδας', days: {} },
    ],
  });
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });

  const { logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );

  const text = userText(llm);
  assert.ok(text.includes('στην αυλή τώρα'), 'the covered neighbour is shown');
  assert.ok(!text.includes('στο γραφείο τώρα'), "the staff room's lines stay out");
  assert.ok(!text.includes('το γραφείο της ομάδας'), "the staff room's note stays out of <server>");
  assert.deepEqual(fetched, [OPEN_ROOM], 'the refused neighbour costs no history fetch');
  assert.equal(logs.find((l) => l.msg === 'turn: model answered')?.neighborsHidden, 1);
});

// --- I-7: destinations, send failures, dry-run, caps -------

test('usableDestination: a channel the bot cannot read is never the destination', () => {
  const general = registerTextChannel(fakeTurnChannel());
  const hall = addChannel(general, { id: 'c6', name: 'hall' });
  const config = { features: {}, memory: { mainChannelIds: ['c6'] } };
  const listing = () => snapshotOf('g1', { conversations: [general.info, hall.info], groups: [] });
  assert.equal(usableDestination(listing(), config).channel?.id, hall.id, 'a readable main channel is used');
  hall.permit({ read: false });
  assert.deepEqual(
    usableDestination(listing(), config),
    { channel: null, reason: 'no-destination' },
    'unreadable: not usable'
  );
});

/**
 * A follow-up turn in #general (c1) answering Alice's line m1 after Bob's m0. `answer` is the
 * model's text, or a `complete` function; `configure` sees the channel, store and hot first.
 */
async function followUpTurn({
  features = {},
  answer = '<msg>ένα</msg><msg>δύο</msg>',
  configure,
}: Record<string, Untyped> = {}) {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({
    historyMessages: [rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'u2', authorName: 'Bob' }), raw],
  });
  const store = fakeStore();
  const hot = fakeHot({ ...features });
  const llm = typeof answer === 'function' ? { complete: answer } : fakeLlm(answer);
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
  configure?.({ channel, store, hot });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' })
  );
  return { result, logs, channel, store, turns };
}

test('runTurn: a second message that fails to send ends the turn as spoke with what reached the chat', async () => {
  const { result, logs, channel, turns } = await followUpTurn({
    answer: '<msg>ένα</msg><msg>δύο</msg><msg>τρία</msg>',
    configure: () => {
      world().failSends((text) => text === 'δύο');
    },
  });
  assert.deepEqual({ outcome: result.outcome, delivered: result.delivered }, { outcome: 'spoke', delivered: true });
  assert.deepEqual(
    channel.sent.map((payload) => payload.content),
    ['ένα'],
    'nothing after the failed message'
  );
  const failed = logs.find((entry) => entry.msg === 'turn: send failed');
  assert.deepEqual([failed?.level, failed?.channel, failed?.index], ['warn', 'c1', 1]);
  assert.equal(turns.spokeAfterSeeing('c1', 'm1'), true, 'the turn noted what it had in view');
});

test('runTurn: a message that fails to send ends the turn partial with a sendFailed fact (its code, how many of how many went out), kept for her next request there', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({
    historyMessages: [rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'u2', authorName: 'Bob' }), raw],
  });
  world().failSends((text) => text === 'δύο');
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm: fakeLlm('<msg>ένα</msg><msg>δύο</msg><msg>τρία</msg>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });
  const source = createLocalFacts({ now: () => NOW });
  turns.setFactsSource(source);
  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' })
  );
  assert.deepEqual(
    { outcome: result.outcome, delivered: result.delivered, partial: result.partial },
    { outcome: 'spoke', delivered: true, partial: true }
  );
  const [fact] = source.pending(null, { channelId: 'c1', privateChat: false });
  assert.equal(fact.kind, 'sendFailed');
  assert.deepEqual([fact.n, fact.total], [1, 3]);
  assert.equal(typeof fact.code, 'string');
  // A turn whose messages all went out leaves no such fact.
  freshWorld();
  const fine = await followUpTurn({});
  assert.equal(fine.result.partial, undefined);
});

test('runTurn: a first message that fails to send ends spoke with nothing delivered', async () => {
  const { result, channel } = await followUpTurn({
    configure: () => {
      world().failSends();
    },
  });
  assert.deepEqual({ outcome: result.outcome, delivered: result.delivered }, { outcome: 'spoke', delivered: false });
  assert.equal(channel.sent.length, 0);
});

test('runTurn: a post that grew past 2000 characters once its mentions expanded arrives whole, never split inside a mention', async () => {
  const { channel } = await followUpTurn({
    answer: `<msg>${'α'.repeat(1990)} ${BOB} ${BOB} ${BOB} ${BOB}</msg>`,
  });
  const posts = postedTexts(channel);
  assertSplitIntact(posts);
  assert.equal(posts.join('').split('<@u2>').length - 1, 4, 'all four mentions arrive');
});

test('runTurn: a reaction stamps no lastPostAt', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Élodie' });
  const real = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const live = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store: fakeStore(),
    llm: fakeLlm('<react to="#1">👍</react>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });
  await withCapturedLogs(() =>
    live.runTurn({ channel: real, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  assert.equal(real.reactCalls.length, 1);
  assert.equal(live.lastPostAt('c1'), 0);
});

// ---------------------------------------------------------------------------
// Pace: the helpers before the reply request run together, under one deadline (pace.*).

/** A promise with its resolve and reject handed out. */
function deferred() {
  let resolve: (value?: unknown) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake `schedule`: every timer is kept with its delay and fired by hand. */
function fakeSchedule() {
  const timers: Array<{ fn: Untyped; ms: Untyped; cancelled: boolean; fired: boolean }> = [];
  return {
    timers,
    schedule: (fn: unknown, ms: number) => {
      const timer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    live: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
    fire(timer: Untyped) {
      timer.fired = true;
      timer.fn();
    },
  };
}

/** Let pending callbacks run, one round of immediates at a time, until `done()` holds (at most `rounds`). */
async function settleUntil(done = () => false, rounds = 50) {
  for (let i = 0; i < rounds && !done(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// The pace every test below sets for itself; a test passing its own `pace` overrides single keys.
const TEST_PACE = {
  prepareMs: 1000,
  prepareSearchMs: 3000,
  dropAfterMs: 0,
  replyHedgeMs: 0,
};

function paceHot(features = {}, pace = {}) {
  const hot = lookupHot({ ...features });
  hot.config.pace = { ...TEST_PACE, ...pace };
  return hot;
}

/**
 * A reply turn whose chat holds a picture (img1) and a page link (m2#e0) before the trigger. The
 * describer's caption and the lookup's read answer once `caption` / `read` (deferreds) settle,
 * at once without them; the lookup has no search, so no classifier runs.
 */
function paceScene({
  hot = paceHot(),
  caption = null,
  read = null,
  clock = () => NOW,
  llm = fakeLlm('<msg>ok</msg>'),
  timers = fakeSchedule(),
}: Record<string, Untyped> = {}) {
  const picture = rawMessage({
    id: 'm1',
    ts: NOW - 9000,
    attachments: new Map([
      ['img1', { id: 'img1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png' }],
    ]),
  });
  const link = linkRaw('m2', NOW - 5000, [PAGE_EMBED]);
  const trigger = rawMessage({ id: 'm3', ts: NOW - 1000, authorName: 'Zoë', content: 'τι λες;' });
  const channel = fakeTurnChannel({ historyMessages: [picture, link, trigger] });
  const describer = {
    calls: 0,
    describeMany: async () => {
      describer.calls += 1;
      await caption?.promise;
      return { descriptions: new Map([['img1', 'a grey cat']]), newCount: 1 };
    },
  };
  const lookup = {
    calls: 0,
    readLinks: async () => {
      lookup.calls += 1;
      await read?.promise;
      return { reads: new Map([['m2#e0', 'une recette']]), newCount: 1 };
    },
  };
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    lookup,
    now: clock,
    schedule: timers.schedule,
  });
  const params: TurnParams = { channel, mode: 'reply', trigger: normalizedTrigger(trigger), triggerKind: 'mention' };
  return { turns, params, channel, llm, describer, lookup, timers };
}

const CAPTION_SHOWN = fill(labels.transcript.imageDescribed, { text: 'a grey cat' });
const READ_SHOWN = fill(labels.transcript.linkRead, { text: 'une recette' });

test('paceSettings: 0, a negative value or a non-number turns a limit off; a missing key keeps a positive limit', () => {
  const missing = paceSettings({});
  assert.ok((missing.prepareMs ?? 0) > 0 && (missing.prepareSearchMs ?? 0) > 0 && (missing.prepareMediaMs ?? 0) > 0);
  for (const off of [0, -5, '6000', null, Number.NaN, Infinity]) {
    const pace = paceSettings({ pace: { prepareMs: off, prepareSearchMs: off, prepareMediaMs: off } });
    assert.equal(pace.prepareMs, null, String(off));
    assert.equal(pace.prepareSearchMs, null, String(off));
    assert.equal(pace.prepareMediaMs, null, String(off));
  }
  assert.ok((missing.dropAfterMs ?? 0) > 0);
  assert.equal(paceSettings({ pace: { dropAfterMs: 0 } }).dropAfterMs, null);
  assert.ok((missing.replyHedgeMs ?? 0) > 0);
  for (const off of [0, -5, '500', null, Number.NaN, Infinity]) {
    assert.equal(paceSettings({ pace: { replyHedgeMs: off } }).replyHedgeMs, null, String(off));
  }
  assert.deepEqual(
    paceSettings({
      pace: {
        prepareMs: 2500,
        prepareSearchMs: 7000,
        prepareMediaMs: 8000,
        dropAfterMs: 9000,
        replyHedgeMs: 4000,
        settleMs: 3000,
        settleMaxMs: 9000,
      },
    }),
    {
      prepareMs: 2500,
      prepareSearchMs: 7000,
      prepareMediaMs: 8000,
      dropAfterMs: 9000,
      replyHedgeMs: 4000,
      settleMs: 3000,
      settleMaxMs: 9000,
    }
  );
  assert.deepEqual(paceSettings({ pace: 'fast' }), missing, 'a group that is not an object counts as missing');
});

// pace.settleMs: a turn answering a person waits, once it holds the attention, until that
// person has been quiet for settleMs, so a thought posted as several quick messages is read whole.
const SETTLE_PACE = {
  prepareMs: 0,
  prepareSearchMs: 0,
  prepareMediaMs: 0,
  dropAfterMs: 0,
  replyHedgeMs: 0,
  settleMaxMs: 15000,
};

/** A reply scene whose `schedule` moves the clock by each delay and fires at once; history fetches are timed. */
function settleScene({ settleMs, activity }: { settleMs: number; activity?: Untyped }) {
  const clock = { t: NOW };
  const raw = rawMessage({ id: 'm1', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const fetchedAt: Array<number> = [];
  world().tap('history', ([ref]: Array<Untyped>) => {
    if (ref.conversationId === channel.id) fetchedAt.push(clock.t);
  });
  const waits: Array<Untyped> = [];
  const schedule = (fn: () => void, ms: number) => {
    waits.push(ms);
    clock.t += ms;
    activity?.onWait?.(clock.t);
    setImmediate(fn);
    return () => {};
  };
  const hot = fakeHot({}, {}, { pace: { ...SETTLE_PACE, settleMs } });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm: fakeLlm('<msg>ok</msg>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => clock.t,
    schedule,
    activity,
  });
  return { turns, channel, raw, fetchedAt, waits };
}

test('paceSettings: settleMs is 0 (off) for 0, a negative value or a non-number; settleMaxMs is null for those', () => {
  for (const off of [0, -5, '500', null, Number.NaN, Infinity]) {
    const pace = paceSettings({ pace: { settleMs: off, settleMaxMs: off } });
    assert.equal(pace.settleMs, 0, String(off));
    assert.equal(pace.settleMaxMs, null, String(off));
  }
  assert.equal(paceSettings({ pace: { settleMs: 2500 } }).settleMs, 2500);
});

test('runTurn: with pace.settleMs the history is read only once the author has been quiet that long', async () => {
  // The author wrote at NOW - 1000; during the first pause they write once more (500 ms before it ends).
  let last = NOW - 1000;
  const activity = {
    lastAt: (channelId: string, authorId: string) => (channelId === 'c1' && authorId === 'u1' ? last : null),
    onWait(t: unknown) {
      if (t === NOW + 250) last = t - 500;
    },
  };
  const scene = settleScene({ settleMs: 4000, activity });
  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({
      channel: scene.channel,
      mode: 'reply',
      trigger: normalizedTrigger(scene.raw),
      triggerKind: 'mention',
    })
  );

  assert.equal(result.outcome, 'spoke');
  // Quiet from NOW - 250 for 4000 ms: the history is read at NOW + 3750, after every pause.
  assert.equal(
    scene.waits.reduce((sum, ms) => sum + ms, 0),
    3750
  );
  assert.ok(scene.waits.length > 1 && scene.waits.every((ms) => ms > 0 && ms <= 250), String(scene.waits));
  assert.deepEqual(scene.fetchedAt.slice(0, 1), [NOW + 3750]);
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.equal(timings?.settleMs, 3750);
  assert.equal(timings?.totalMs, 0, 'the turn clock starts after the settle');
});

test('runTurn: settle off, no tracker or no author to wait for -- no pause before the history', async () => {
  const recent = { lastAt: () => NOW - 100 };
  const settleCases: Array<[string, number, Untyped, Record<string, unknown>]> = [
    ['settleMs 0', 0, recent, {}],
    ['no tracker', 4000, undefined, {}],
    ['spontaneous', 4000, recent, { mode: 'interject', trigger: null, triggerKind: null }],
  ];
  for (const [name, settleMs, activity, params] of settleCases) {
    const scene = settleScene({ settleMs, activity });
    const { logs } = await withCapturedLogs(() =>
      scene.turns.runTurn({
        channel: scene.channel,
        mode: 'reply',
        trigger: normalizedTrigger(scene.raw),
        triggerKind: 'mention',
        ...params,
      })
    );
    assert.deepEqual(scene.waits, [], name ?? '');
    assert.deepEqual(scene.fetchedAt.slice(0, 1), [NOW], name ?? '');
    assert.equal(logs.find((l) => l.msg === 'turn: timings')?.settleMs, 0, name ?? '');
  }
});

test('runTurn: the helpers before the reply request overlap -- two slow ones take the time of one', async () => {
  let t = NOW;
  const caption = deferred();
  const read = deferred();
  const scene = paceScene({ caption, read, clock: () => t });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0 && scene.lookup.calls > 0);
  assert.deepEqual([scene.describer.calls, scene.lookup.calls], [1, 1], 'both asked before either answered');
  assert.equal(scene.llm.calls.length, 0);
  t = NOW + 1000;
  caption.resolve();
  read.resolve();
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.equal(timings?.stages.captions, 1000);
  assert.equal(timings?.stages.links, 1000);
  assert.equal(timings?.prepareMs, 1000, 'the maximum of the two, not their sum');
  const user = userText(scene.llm);
  assert.ok(user.includes(CAPTION_SHOWN) && user.includes(READ_SHOWN), user);
});

test('runTurn: with every helper in time the request is the one built without a deadline', async () => {
  const withDeadline = paceScene();
  const { logs } = await withCapturedLogs(() => withDeadline.turns.runTurn(withDeadline.params));
  const waiting = paceScene({ hot: paceHot({}, { prepareMs: 0, prepareSearchMs: 0 }) });
  await withCapturedLogs(() => waiting.turns.runTurn(waiting.params));

  assert.deepEqual(withDeadline.llm.calls[0], waiting.llm.calls[0]);
  const user = userText(withDeadline.llm);
  assert.ok(user.includes(CAPTION_SHOWN) && user.includes(READ_SHOWN), user);
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings')?.late, []);
  assert.ok(
    withDeadline.timers.timers.every((timer: Untyped) => timer.cancelled && !timer.fired),
    'the deadline is cleared once everything is in'
  );
});

test('runTurn: a helper past pace.prepareMs is left out and named in late; its late result changes nothing', async () => {
  const caption = deferred();
  const scene = paceScene({ caption });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0 && scene.timers.live().length > 0);
  const [deadline] = scene.timers.live();
  assert.equal(deadline.ms, TEST_PACE.prepareMs);
  scene.timers.fire(deadline);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  const user = userText(scene.llm);
  assert.ok(!user.includes('a grey cat'), 'the late caption is absent');
  assert.ok(user.includes(READ_SHOWN), 'the read in time is there');
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.deepEqual(timings?.late, ['captions']);
  assert.equal(timings?.stages.captions, null);
  assert.equal(typeof timings?.stages.links, 'number');

  const { logs: after } = await withCapturedLogs(async () => {
    caption.resolve();
    await settleUntil();
  });
  assert.equal(scene.llm.calls.length, 1, 'nothing more reaches the model');
  assert.equal(scene.channel.sent.length, 1);
  assert.deepEqual(
    after.filter((l) => l.msg === 'turn: stage late').map((l) => [l.stage, typeof l.ms]),
    [['captions', 'number']]
  );
});

test('runTurn: a helper that fails after the deadline throws nothing and changes nothing', async () => {
  const caption = deferred();
  const scene = paceScene({ caption });
  const unhandled: Array<Untyped> = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
    await settleUntil(() => scene.describer.calls > 0 && scene.timers.live().length > 0);
    scene.timers.fire(scene.timers.live()[0]);
    const { result } = await running;
    assert.equal(result.outcome, 'spoke');

    const { logs } = await withCapturedLogs(async () => {
      caption.reject(new Error('describer down'));
      await settleUntil();
    });
    assert.deepEqual(unhandled, []);
    assert.equal(scene.llm.calls.length, 1);
    assert.equal(scene.channel.sent.length, 1);
    assert.ok(logs.some((l) => l.msg === 'turn: stage failed' && l.stage === 'captions'));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('runTurn: pace.prepareMs 0 waits for every helper, however slow', async () => {
  const caption = deferred();
  const scene = paceScene({ caption, hot: paceHot({}, { prepareMs: 0 }) });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0);
  await settleUntil();
  assert.equal(scene.timers.timers.length, 0, 'no deadline is set');
  assert.equal(scene.llm.calls.length, 0, 'the turn still waits');
  caption.resolve();
  const { logs } = await running;

  assert.ok(userText(scene.llm).includes(CAPTION_SHOWN));
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings')?.late, []);
});

// A turn nobody waits for: a spontaneous one and an overheard line.
const UNHURRIED_TURNS: Array<[string, (scene: Untyped) => TurnParams]> = [
  ['an initiate turn', (scene: Untyped) => ({ channel: scene.channel, mode: 'initiate' })],
  ['an overheard line', (scene: Untyped) => ({ ...scene.params, triggerKind: 'overheard' })],
];

for (const [name, paramsOf] of UNHURRIED_TURNS) {
  test(`runTurn: ${name} has no deadline and no bar -- it waits for a slow helper`, async () => {
    const caption = deferred();
    const scene = paceScene({
      caption,
      hot: paceHot({}, { prepareMs: 1000, prepareSearchMs: 3000, dropAfterMs: 5000 }),
    });

    const running = withCapturedLogs(() => scene.turns.runTurn(paramsOf(scene)));
    await settleUntil(() => scene.describer.calls > 0);
    await settleUntil();
    assert.equal(scene.timers.timers.length, 0, 'neither a deadline nor a bar is set');
    assert.equal(scene.llm.calls.length, 0, 'the turn still waits');
    caption.resolve();
    const { result, logs } = await running;

    assert.equal(result.outcome, 'spoke');
    assert.ok(userText(scene.llm).includes(CAPTION_SHOWN), 'the slow caption enters the request');
    const timings = logs.find((l) => l.msg === 'turn: timings');
    assert.deepEqual(timings?.late, []);
    assert.equal(typeof timings?.stages.captions, 'number');
  });
}

test('runTurn: a mention still cuts a slow helper at pace.prepareMs', async () => {
  const caption = deferred();
  const scene = paceScene({ caption, hot: paceHot({}, { prepareMs: 1000, dropAfterMs: 0 }) });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0 && scene.timers.live().length > 0);
  const [deadline] = scene.timers.live();
  assert.equal(deadline.ms, 1000);
  scene.timers.fire(deadline);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.ok(!userText(scene.llm).includes('a grey cat'), 'the late caption is absent');
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings')?.late, ['captions']);
  caption.resolve();
});

const WATCHED_TEXT = 'ένα ποτάμι κάτω από τη γέφυρα';

/**
 * A mention with a video attachment (va, clip.mov): on the trigger itself (`where: 'trigger'`),
 * on the older line the trigger replies to (`'replied'`), or on an older line only
 * (`'history'`). The video describer watches it once `watch` (a deferred) settles; `hot`
 * defaults to video vision on with the test pace and `pace` over it.
 */
function videoPaceScene({
  pace = {},
  where = 'trigger',
  watch = null,
  clock = () => NOW,
  hot = null,
  llm = fakeLlm('<msg>ok</msg>'),
  lookup = undefined,
  content = 'το βλέπεις;',
}: Record<string, Untyped> = {}) {
  const turnHot = hot ?? fakeHot({}, {}, VIDEO_TURN_CONFIG);
  turnHot.config.pace = { ...TEST_PACE, ...pace };
  const older =
    where === 'trigger'
      ? rawMessage({ id: 'm1', ts: NOW - 9000, content: 'γεια' })
      : videoAttachmentRaw('m1', NOW - 9000, 'va', 'clip.mov');
  const trigger =
    where === 'trigger'
      ? videoAttachmentRaw('m2', NOW - 1000, 'va', 'clip.mov')
      : rawMessage({ id: 'm2', ts: NOW - 1000 });
  trigger.cleanContent = content;
  const channel = fakeTurnChannel({ historyMessages: [older, trigger] });
  const describer: ReturnType<typeof fakeVideoDescriber> & Record<string, Untyped> = fakeVideoDescriber({});
  describer.describeVideos = async (guildId: string, items: Array<Untyped>, options: Untyped) => {
    describer.videoCalls.push({ guildId, items, options });
    await watch?.promise;
    return { videos: new Map([['va', { state: 'watched', text: WATCHED_TEXT }]]), newCount: 1 };
  };
  const timers = fakeSchedule();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: turnHot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    lookup,
    now: clock,
    schedule: timers.schedule,
  });
  const called = { ...normalizedTrigger(trigger), replyToId: where === 'replied' ? 'm1' : null };
  const params: TurnParams = { channel, mode: 'reply', trigger: called, triggerKind: 'mention' };
  return { turns, params, channel, llm, describer, timers };
}

test('runTurn: a video on the trigger moves the deadline to pace.prepareMediaMs; a watch at 3 s makes it into the request', async () => {
  let t = NOW;
  const watch = deferred();
  const scene = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 5000 }, watch, clock: () => t });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.videoCalls.length > 0 && scene.timers.live().length > 0);
  const [first] = scene.timers.timers;
  assert.equal(first.ms, 1000);
  assert.equal(first.cancelled, true, 'the first deadline is replaced');
  assert.deepEqual(
    scene.timers.live().map((timer) => timer.ms),
    [5000]
  );
  t = NOW + 3000;
  watch.resolve();
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.ok(userText(scene.llm).includes(WATCHED_TEXT), 'the watched video is in the request');
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.deepEqual(timings?.late, []);
  assert.equal(timings?.stages.videos, 3000);
});

test('runTurn: pace.prepareMediaMs 0 leaves a video on the trigger under pace.prepareMs', async () => {
  const watch = deferred();
  const scene = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 0 }, watch });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.videoCalls.length > 0 && scene.timers.live().length > 0);
  await settleUntil();
  assert.deepEqual(
    scene.timers.timers.map((timer) => timer.ms),
    [1000],
    'no extension'
  );
  scene.timers.fire(scene.timers.live()[0]);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.ok(!userText(scene.llm).includes(WATCHED_TEXT), 'the late watch is absent');
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings')?.late, ['videos']);
  watch.resolve();
});

test('runTurn: a video whose watch misses the deadline renders not watched, still loading, never as its bare still frame', async () => {
  const watch = deferred();
  const scene = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 5000 }, watch });
  scene.describer.describeMany = async (guildId, items) => ({
    descriptions: new Map(
      items.filter((item: Untyped) => item.itemId === 'va').map((item: Untyped) => [item.itemId, 'μια γέφυρα'])
    ),
    newCount: 1,
  });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.videoCalls.length > 0 && scene.timers.live().length > 0);
  await settleUntil();
  assert.deepEqual(
    scene.timers.live().map((timer) => timer.ms),
    [5000]
  );
  scene.timers.fire(scene.timers.live()[0]);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings')?.late, ['videos']);
  const text = userText(scene.llm);
  const pending = labels.transcript.videoNotWatchedFrame
    .replace('{name}', 'clip.mov')
    .replace('{duration}', '0:20')
    .replace('{reason}', labels.transcript.videoReason.pending)
    .replace('{text}', 'μια γέφυρα');
  assert.ok(text.includes(pending), 'the late video is named not watched, still loading, with its frame');
  const bare = labels.transcript.videoDescribed
    .replace('{name}', 'clip.mov')
    .replace('{duration}', '0:20')
    .replace('{text}', 'μια γέφυρα');
  assert.ok(!text.includes(bare), 'never the bare still-frame form');
  assert.ok(!text.includes(WATCHED_TEXT));
  watch.resolve();
});

test('runTurn: a late video stage keeps the states the cache holds; only the video still loading is pending', async () => {
  const watch = deferred();
  const hot = fakeHot({}, {}, VIDEO_TURN_CONFIG);
  hot.config.pace = { ...TEST_PACE, prepareMs: 1000, prepareMediaMs: 5000 };
  // An older line with a video watched on an earlier turn (served from the cache), and the call with a new one.
  const older = videoAttachmentRaw('m1', NOW - 9000, 'vo', 'old.mp4');
  const trigger = videoAttachmentRaw('m2', NOW - 1000, 'va', 'clip.mov');
  trigger.cleanContent = 'το βλέπεις;';
  const channel = fakeTurnChannel({ historyMessages: [older, trigger] });
  const llm = fakeLlm('<msg>ok</msg>');
  const describer: ReturnType<typeof fakeVideoDescriber> & Record<string, Untyped> = fakeVideoDescriber({});
  describer.describeVideos = async (guildId: string, items: Array<Untyped>, options: Untyped) => {
    describer.videoCalls.push({ guildId, items, options });
    await watch.promise;
    return { videos: new Map([['va', { state: 'watched', text: WATCHED_TEXT }]]), newCount: 1 };
  };
  describer.cachedVideos = async (guildId: string, items: Untyped) =>
    new Map(
      items
        .filter((item: Untyped) => item.itemId === 'vo')
        .map((item: Untyped) => [item.itemId, { state: 'watched', text: 'ένα παλιό βίντεο' }])
    );
  const timers = fakeSchedule();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    now: () => NOW,
    schedule: timers.schedule,
  });

  const running = withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(trigger), triggerKind: 'mention' })
  );
  await settleUntil(() => describer.videoCalls.length > 0 && timers.live().length > 0);
  await settleUntil();
  timers.fire(timers.live()[0]);
  const { logs } = await running;

  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings')?.late, ['videos']);
  const text = userText(llm);
  const pending = labels.transcript.videoNotWatched
    .replace('{name}', 'clip.mov')
    .replace('{duration}', '0:20')
    .replace('{reason}', labels.transcript.videoReason.pending);
  assert.ok(text.includes(pending), 'the video still loading is pending');
  const watched = labels.transcript.videoWatched
    .replace('{name}', 'old.mp4')
    .replace('{duration}', '0:20')
    .replace('{text}', 'ένα παλιό βίντεο');
  assert.ok(text.includes(watched), 'the older video keeps its cached watched state');
  watch.resolve();
});

test('runTurn: a video only on an older line keeps pace.prepareMs; one on the line the trigger replies to extends it', async () => {
  const watch = deferred();
  const scene = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 5000 }, where: 'history', watch });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.videoCalls.length > 0 && scene.timers.live().length > 0);
  await settleUntil();
  assert.deepEqual(
    scene.timers.timers.map((timer) => timer.ms),
    [1000],
    'an older video does not extend the deadline'
  );
  scene.timers.fire(scene.timers.live()[0]);
  const { logs } = await running;
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings')?.late, ['videos']);
  watch.resolve();

  const replied = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 5000 }, where: 'replied' });
  const { logs: repliedLogs } = await withCapturedLogs(() => replied.turns.runTurn(replied.params));
  assert.deepEqual(
    replied.timers.timers.map((timer) => timer.ms),
    [1000, 5000],
    'the replied-to video extends it'
  );
  assert.deepEqual(repliedLogs.find((l) => l.msg === 'turn: timings')?.late, []);
});

test('runTurn: turn: timings carries every stage, null for one that did not run', async () => {
  let t = NOW;
  const caption = deferred();
  const base = fakeLlm('<msg>ok</msg>');
  const llm = {
    ...base,
    complete: async (messages: unknown, options: unknown) => {
      t += 2000;
      return base.complete(messages, options);
    },
  };
  const scene = paceScene({ caption, clock: () => t, llm });
  world().tap('history', ([ref]: Array<Untyped>) => {
    if (ref.conversationId === scene.channel.id) t += 100;
  });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0);
  await settleUntil();
  t = NOW + 1100;
  caption.resolve();
  const { logs } = await running;

  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.deepEqual(Object.keys(timings?.stages), [
    'history',
    'previews',
    'captions',
    'videos',
    'rewatch',
    'links',
    'lookup',
    'neighbors',
    'pulled',
    'participation',
    'record',
  ]);
  assert.equal(timings?.stages.history, 100);
  assert.equal(timings?.stages.captions, 1000);
  for (const name of ['previews', 'links', 'neighbors', 'pulled'])
    assert.equal(typeof timings?.stages[name], 'number', name);
  for (const name of ['videos', 'rewatch', 'lookup', 'participation', 'record'])
    assert.equal(timings?.stages[name], null, name);
  assert.deepEqual(
    [
      timings?.channel,
      timings?.mode,
      timings?.triggerKind,
      timings?.prepareMs,
      timings?.replyMs,
      timings?.totalMs,
      timings?.late,
    ],
    ['c1', 'reply', 'mention', 1100, 2000, 3100, []]
  );
  assert.ok(logs.some((l) => l.msg === 'turn: model answered' && 'secondsToAnswer' in l));
});

// The drop bar (pace.dropAfterMs): the answer must be in hand by then, or the turn is dropped unposted.

const BAR_MS = 5000;

/** An llm fake whose talk request runs `talk(messages, options)`; every call's options are kept. */
function barLlm(talk: Untyped) {
  const optionCalls: Array<Untyped> = [];
  return {
    optionCalls,
    complete: async (messages: unknown, options: unknown) => {
      optionCalls.push(options);
      return talk(messages, options, optionCalls.length);
    },
  };
}

test('runTurn: an answer in hand just before pace.dropAfterMs is posted, the reply request bounded by the time left', async () => {
  let t = NOW;
  const llm = barLlm(async () => {
    t = NOW + BAR_MS - 1;
    return { text: '<msg>ok</msg>', usage: {}, estimated: 10 };
  });
  const hot = paceHot({}, { dropAfterMs: BAR_MS });
  hot.config.llm.timeoutMs = 300_000;
  const scene = paceScene({ hot, llm, clock: () => t });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(scene.channel.sent.length, 1);
  assert.equal(
    logs.some((l) => l.msg === 'turn: dropped'),
    false
  );
  const [options] = llm.optionCalls;
  assert.equal(options.role, 'core');
  assert.equal(options.purpose, 'reply');
  assert.equal(options.timeoutMs, BAR_MS, 'the smaller of llm.timeoutMs and the time left');
  assert.equal(options.signal.aborted, false);
  assert.deepEqual(scene.timers.live(), [], 'the bar is cleared once the answer is in hand');
});

test('runTurn: a talk request still out at pace.dropAfterMs is aborted; nothing is posted, the turn ends in error and the queue drains', async () => {
  const answer = deferred();
  const llm = barLlm(() => answer.promise);
  const hot = paceHot({}, { dropAfterMs: BAR_MS });
  const scene = paceScene({ hot, llm, clock: () => NOW });
  let idle = 0;
  scene.turns.setOnIdle(() => {
    idle += 1;
  });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => llm.optionCalls.length > 0);
  const bar = scene.timers.live().find((timer: Untyped) => timer.ms === BAR_MS);
  assert.ok(bar, 'the bar is set from the turn start');
  scene.timers.fire(bar);
  const { result, logs } = await running;
  await settleUntil(() => idle > 0);

  assert.equal(result.outcome, 'error');
  assert.equal(llm.optionCalls[0].signal.aborted, true, 'the reply request is aborted');
  assert.equal(scene.channel.sent.length, 0);
  const dropped = logs.find((l) => l.msg === 'turn: dropped');
  assert.deepEqual(
    [dropped?.channel, dropped?.mode, dropped?.triggerKind, dropped?.reason, typeof dropped?.seconds],
    ['c1', 'reply', 'mention', 'too-slow', 'number']
  );
  assert.deepEqual(scene.timers.live(), [], 'no timer is left running');
  assert.equal(idle, 1, 'the pending queue drains as after any finished turn');
  assert.equal(scene.turns.isAnyBusy(), false);

  answer.resolve({ text: '<msg>late</msg>', usage: {}, estimated: 10 });
  await settleUntil();
  assert.equal(scene.channel.sent.length, 0, 'a late answer is never posted');
});

test('runTurn: a provider error landing once no time is left before pace.dropAfterMs drops the turn, nothing is asked again', async () => {
  let t = NOW;
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      [
        'v1',
        {
          id: 'v1',
          contentType: 'video/mp4',
          name: 'clip.mp4',
          url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
          duration: 34,
        },
      ],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = barLlm(async () => {
    t = NOW + BAR_MS;
    const err = Object.assign(new Error('bad request'), { statusCode: 400 });
    throw err;
  });
  const hot = fakeHot({});
  hot.config.pace = { ...TEST_PACE, dropAfterMs: BAR_MS };
  const timers = fakeSchedule();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    imageFetcher: fakeImageFetcher(),
    now: () => t,
    schedule: timers.schedule,
  });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' })
  );

  assert.equal(llm.optionCalls.length, 1, 'nothing is asked again');
  assert.equal(result.outcome, 'error');
  assert.equal(channel.sent.length, 0);
  assert.ok(logs.some((l) => l.msg === 'turn: dropped' && l.reason === 'too-slow'));
});

// The reply hedge (pace.replyHedgeMs): only the reply request of a turn with a bar carries one.

test('runTurn: a direct call with a bar passes pace.replyHedgeMs to the reply request as its hedge, cut at the same timeout', async () => {
  const llm = barLlm(async () => ({ text: '<msg>ok</msg>', usage: {}, estimated: 10 }));
  const hot = paceHot({}, { dropAfterMs: BAR_MS, replyHedgeMs: 500 });
  hot.config.llm.timeoutMs = 300_000;
  const scene = paceScene({ hot, llm, clock: () => NOW });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const [options] = llm.optionCalls;
  assert.equal(options.timeoutMs, BAR_MS);
  assert.deepEqual(options.hedge, { afterMs: 500, timeoutMs: BAR_MS }, 'attempt 2 at 500 ms, both ended at the bar');
  assert.equal(options.isRoleRequest, undefined, 'still no helper request');
});

test('runTurn: pace.replyHedgeMs 0, or not below the time left to the bar, sends the reply request without a hedge', async () => {
  for (const replyHedgeMs of [0, BAR_MS]) {
    const llm = barLlm(async () => ({ text: '<msg>ok</msg>', usage: {}, estimated: 10 }));
    const hot = paceHot({}, { dropAfterMs: BAR_MS, replyHedgeMs });
    hot.config.llm.timeoutMs = 300_000;
    const scene = paceScene({ hot, llm, clock: () => NOW });

    const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

    assert.equal(result.outcome, 'spoke', String(replyHedgeMs));
    const [options] = llm.optionCalls;
    assert.equal('hedge' in options, false, String(replyHedgeMs));
    assert.equal(options.timeoutMs, BAR_MS, String(replyHedgeMs));
  }
});

test('runTurn: an initiate turn has no bar, so its reply request is never hedged', async () => {
  const llm = barLlm(async () => ({ text: '<msg>ok</msg>', usage: {}, estimated: 10 }));
  const scene = paceScene({
    hot: paceHot({}, { dropAfterMs: BAR_MS, replyHedgeMs: 500 }),
    llm,
    clock: () => NOW,
  });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'initiate' }));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(llm.optionCalls.map(withoutTools), [{ role: 'core', purpose: 'reply', iface: 'discord' }]);
});

test('runTurn: pace.dropAfterMs 0 sets no bar -- a slow answer is still posted, the request as before', async () => {
  let t = NOW;
  const llm = barLlm(async () => {
    t = NOW + 10 * 60_000;
    return { text: '<msg>ok</msg>', usage: {}, estimated: 10 };
  });
  const scene = paceScene({ hot: paceHot({}, { dropAfterMs: 0 }), llm, clock: () => t });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(scene.channel.sent.length, 1);
  assert.deepEqual(llm.optionCalls.map(withoutTools), [{ role: 'core', purpose: 'reply', iface: 'discord' }]);
  assert.equal(
    logs.some((l) => l.msg === 'turn: dropped'),
    false
  );
  assert.ok(
    scene.timers.timers.every((timer: Untyped) => timer.ms === TEST_PACE.prepareMs),
    'only the preparation deadline'
  );
});

// ---------------------------------------------------------------------------
// A message that holds several requests: the splitter (prompts/split.md) and the chain of parts.

/** The `<candidate>` text a classifier request carried. */
function candidateOf(call: Untyped) {
  return /<candidate>\n[^:]*: ([\s\S]*?)\n<\/candidate>/.exec(textOf(call.messages[1].content))?.[1] ?? null;
}

test('runTurn: a short or unstructured call never asks the splitter', async () => {
  for (const content of ['γεια σου', 'a'.repeat(60)]) {
    const { llm, result } = await runSplitTurn({ content });
    assert.equal(llm.calls.split.length, 0, content);
    assert.equal(llm.calls.talk.length, 1);
    assert.equal(result.outcome, 'spoke');
  }
});

test('runTurn: a `one` verdict leaves the turn exactly as without the splitter', async () => {
  const off = splitHot();
  delete off.prompts.split;
  const before = await runSplitTurn({ hot: off });
  const after = await runSplitTurn({ llm: splitLlm({ split: 'one' }) });

  assert.equal(before.llm.calls.split.length, 0);
  assert.equal(after.llm.calls.split.length, 1);
  assert.deepEqual(
    after.llm.calls.talk.map((call) => call.messages),
    before.llm.calls.talk.map((call) => call.messages),
    'the same talk request'
  );
  assert.deepEqual(after.channel.sent, before.channel.sent);
  assert.deepEqual(after.result, before.result);
  const verdict = after.logs.find((line) => line.msg === 'split: verdict');
  assert.deepEqual([verdict?.channel, verdict?.parts, typeof verdict?.ms], ['c1', 1, 'number']);
  assert.equal(
    after.logs.some((line) => line.msg === 'turn: part'),
    false
  );
});

test('runTurn: the splitter request fills split.md and carries the transcript and the candidate', async () => {
  const { llm } = await runSplitTurn({ llm: splitLlm({ split: 'one' }) });
  const [call] = llm.calls.split;
  assert.equal(call.messages[0].content, fillPromptTemplate(SPLIT_SYSTEM, { name: 'Bot', maxTasks: 4 }));
  assert.ok(textOf(call.messages[1].content).startsWith('<transcript>\n'));
  assert.equal(candidateOf(call), SPLIT_TEXT);
  assert.deepEqual(
    [call.options.role, call.options.purpose, call.options.maxOutputTokens, call.options.isRoleRequest],
    ['analyzer', 'split', 50, true]
  );
});

test('runTurn: a failed, empty or unparsable splitter answer is one request', async () => {
  for (const split of [Object.assign(new Error('boom'), { statusCode: 503 }), '   ', '- only one']) {
    const { llm, logs, result } = await runSplitTurn({ llm: splitLlm({ split }) });
    assert.equal(llm.calls.talk.length, 1);
    assert.equal(taskOf(llm.calls.talk[0]).includes('parts'), false);
    assert.equal(result.outcome, 'spoke');
    const failed = logs.find((line) => line.msg === 'split: failed');
    assert.ok(failed, String(split));
    assert.ok(['llm-error', 'empty', 'unparsed'].includes(failed.reason));
  }
});

test('runTurn: a splitter still thinking at the deadline is one request; its late verdict is only logged', async () => {
  let release: Untyped;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  const schedule = manualSchedule();
  const llm = splitLlm({ split: () => late });
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: splitHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup: fakeLookup(),
    now: () => NOW,
    schedule,
  });
  const { logs } = await withCapturedLogs(async () => {
    const running = turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    for (let i = 0; i < 20 && llm.calls.split.length === 0; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(llm.calls.talk.length, 0, 'the turn waits for the splitter like any stage');
    schedule.fire(5000);
    const result = await running;
    assert.equal(result.outcome, 'spoke');
    release(PARTS_ANSWER);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(llm.calls.talk.length, 1, 'one turn, for the whole message');
  const verdict = logs.find((line) => line.msg === 'split: verdict');
  assert.deepEqual([verdict?.parts, verdict?.late], [3, true]);
});

test('runTurn: parts in time become one turn per part, in order, each helper judging its part', async () => {
  const { llm, logs, result, channel } = await runSplitTurn();

  assert.equal(llm.calls.talk.length, 3);
  // The persona's request names the part it answers now and the others.
  assert.deepEqual(
    llm.calls.talk.map((call) => taskOf(call).endsWith(partLabel(llm.calls.talk.indexOf(call) + 1))),
    [true, true, true]
  );
  // The first answer replies to the message, the later ones post plain.
  assert.deepEqual(
    channel.sent.map((payload) => payload.reply?.messageReference ?? null),
    ['m2', null, null]
  );
  assert.deepEqual(
    logs
      .filter((line) => line.msg === 'turn: part')
      .map(({ channel: id, index, total, outcome }) => [id, index, total, outcome]),
    [
      ['c1', 1, 3, 'spoke'],
      ['c1', 2, 3, 'spoke'],
      ['c1', 3, 3, 'spoke'],
    ]
  );
  assert.deepEqual(result, { outcome: 'spoke', mode: 'reply', delivered: true });
  const lines = logs.filter((line) => line.msg.startsWith('split:') || line.msg === 'turn: part');
  assert.equal(JSON.stringify(lines).includes('Νίκος'), false, 'counts and codes only, never a part');
});

test("runTurn: the route hook judges each part's text", async () => {
  const seen: Array<Untyped> = [];
  const routeChannels = async ({ trigger }: Untyped) => {
    seen.push(trigger.content);
    return [];
  };
  await runSplitTurn({ extra: { routeChannels } });
  assert.deepEqual(
    seen.filter((text) => text !== SPLIT_TEXT),
    SPLIT_PARTS
  );
});

test('runTurn: the persona may stay silent on a part; a failed part does not stop the next', async () => {
  const talk = (index: number) =>
    index === 0 ? new Error('provider down') : index === 1 ? '<skip/>' : '<msg>τρία</msg>';
  const { logs, result, channel } = await runSplitTurn({ llm: splitLlm({ talk }) });
  assert.deepEqual(
    logs.filter((line) => line.msg === 'turn: part').map((line) => line.outcome),
    ['error', 'skip', 'spoke']
  );
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].reply, undefined, 'a later part posts plain');
  assert.equal(result.outcome, 'spoke');
});

test("runTurn: a chain where no part spoke gives the first skip, else the first part's result", async () => {
  const silent = await runSplitTurn({ llm: splitLlm({ talk: '<skip/>' }) });
  assert.deepEqual(silent.result, { outcome: 'skip', mode: 'reply', reason: 'silence' });
  const failing = await runSplitTurn({ llm: splitLlm({ talk: new Error('down') }) });
  assert.equal(failing.result.outcome, 'error');
});

test('runTurn: the splitter cuts the parts at its four tasks', async () => {
  // PR 7d: split.maxTasks is the constant 4 (the production value).
  const kept = [...SPLIT_PARTS, 'και κάτι ακόμα πιο μεγάλο'];
  const { llm } = await runSplitTurn({
    llm: splitLlm({ split: `${PARTS_ANSWER}\n- ${kept[3]}\n- και ένα τελευταίο ακόμα θέμα` }),
  });
  assert.equal(llm.calls.talk.length, 4);
  assert.ok(taskOf(llm.calls.talk[0]).endsWith(partLabel(1, kept)));
});

test('runTurn: an overheard line or an unprompted turn never asks the splitter', async () => {
  const overheard = await runSplitTurn({ triggerKind: 'overheard' });
  assert.equal(overheard.llm.calls.split.length, 0);
  const llm = splitLlm();
  const channel = fakeTurnChannel({ historyMessages: [rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT })] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: splitHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
    schedule: manualSchedule(),
  });
  await turns.runTurn({ channel, mode: 'interject' });
  assert.equal(llm.calls.split.length, 0);
});

test('runTurn: an older labels file without labels.task.part never starts a chain; a missing split.md logs no-prompt', async () => {
  const { task, ...older } = labels;
  const old = await runSplitTurn({ hot: splitHot({ labels: older }) });
  assert.equal(old.llm.calls.split.length, 0);
  assert.equal(old.llm.calls.talk.length, 1);

  const hot = splitHot();
  delete hot.prompts.split;
  const { logs, llm } = await runSplitTurn({ hot });
  assert.equal(llm.calls.split.length, 0);
  assert.deepEqual(
    logs.filter((line) => line.msg === 'split: skipped').map(({ channel, reason }) => [channel, reason]),
    [['c1', 'no-prompt']]
  );
});

test('runTurn: the chain holds the one attention to its end and notifies idle once', async () => {
  const other = fakeTurnChannel({ id: 'c9' });
  let idle = 0;
  const busyDuring: Array<Untyped> = [];
  let turnsRef: Untyped = null;
  const talk = async (index: number) => {
    busyDuring.push(turnsRef.isAnyBusy());
    if (index === 0) {
      const elsewhere = await turnsRef.runTurn({ channel: other, mode: 'interject' });
      busyDuring.push(elsewhere.outcome);
    }
    return '<msg>ok</msg>';
  };
  const llm = splitLlm({ talk });
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  turnsRef = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: splitHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup: fakeLookup(),
    now: () => NOW,
    schedule: manualSchedule(),
  });
  turnsRef.setOnIdle(() => {
    idle += 1;
  });
  const waited = turnsRef.waitIdle();
  let waitedDone = false;
  waited.then(() => {
    waitedDone = true;
  });
  await turnsRef.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(busyDuring, [true, 'busy', true, true]);
  assert.equal(idle, 1, 'one notification, once the chain is over');
  assert.equal(waitedDone, true);
  assert.equal(turnsRef.isAnyBusy(), false);
});

test('runTurn: a pause ends the chain before its next part', async () => {
  const store = fakeStore();
  const talk = () => {
    store.state.data.paused = true;
    return '<msg>ok</msg>';
  };
  const llm = splitLlm({ talk });
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: splitHot(),
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup: fakeLookup(),
    now: () => NOW,
    schedule: manualSchedule(),
  });
  const { logs, result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  assert.equal(llm.calls.talk.length, 1);
  assert.deepEqual(
    logs
      .filter((line) => line.msg === 'turn: chain stopped')
      .map(({ reason: why, index, total }) => [why, index, total]),
    [['paused', 2, 3]]
  );
  assert.equal(result.outcome, 'spoke');
  assert.equal(turns.isAnyBusy(), false);
});

test("runTurn: the parts not started yet are the author's waiting items; a message folded into one reaches its request", async () => {
  let turnsRef: Untyped = null;
  const seen: Array<Untyped> = [];
  const talk = (index: number) => {
    if (index === 0) {
      seen.push(turnsRef.waitingParts('c1', 'u1'), turnsRef.waitingParts('c1', 'u2'));
      seen.push(turnsRef.addToPart('c1', 'u1', 2, { id: 'f1', text: 'και το δεύτερο;', ts: NOW }));
      seen.push(turnsRef.addToPart('c1', 'u1', 1, { id: 'f2', text: 'όχι', ts: NOW }));
    }
    return '<msg>ok</msg>';
  };
  const llm = splitLlm({ talk });
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  turnsRef = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: splitHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup: fakeLookup(),
    now: () => NOW,
    schedule: manualSchedule(),
  });
  await turnsRef.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.deepEqual(seen, [
    [
      { index: 2, text: SPLIT_PARTS[1] },
      { index: 3, text: SPLIT_PARTS[2] },
    ],
    [],
    true,
    false,
  ]);
  assert.ok(taskOf(llm.calls.talk[1]).endsWith(fill(labels.task.added, { added: 'και το δεύτερο;' })));
  assert.equal(taskOf(llm.calls.talk[2]).includes('και το δεύτερο;'), false);
  assert.deepEqual(turnsRef.waitingParts('c1', 'u1'), [], 'nothing waits once the chain is over');
});

test("runTurn: a part's others name the author's queued calls after the parts", async () => {
  const queued = () => [{ id: 'm7', text: 'και ένα ακόμα' }];
  const { llm } = await runSplitTurn({ turnExtra: { queued } });
  const others = '2. κοίτα το κανάλι της Ελένης; 3. το μιμίδιο είναι αστείο;; 4. και ένα ακόμα';
  assert.ok(
    taskOf(llm.calls.talk[0]).endsWith(fill(labels.task.part, { index: 1, total: 3, part: SPLIT_PARTS[0], others }))
  );
});

test('runTurn: queued calls named in the request are not counted as seen; without labels.task.queued they are', async () => {
  const history = [
    rawMessage({ id: 'm1', ts: NOW - 3000, content: 'πρώτο' }),
    rawMessage({ id: 'm3', ts: NOW - 2000, content: 'δεύτερο' }),
  ];
  const run = async (hot: unknown) => {
    const llm = splitLlm({ talk: '<msg>ok</msg>' });
    const channel = fakeTurnChannel({ historyMessages: history });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot,
      store: fakeStore(),
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      now: () => NOW,
      schedule: manualSchedule(),
    });
    const queued = () => [{ id: 'm3', text: 'δεύτερο' }];
    const added = [{ id: 'm4', text: 'λοιπόν;', ts: NOW }];
    await turns.runTurn({
      channel,
      mode: 'reply',
      trigger: normalizedTrigger(history[0]),
      triggerKind: 'mention',
      queued,
      added,
    });
    return { turns, task: taskOf(llm.calls.talk[0]) };
  };
  const named = await run(splitHot());
  assert.ok(
    named.task.endsWith(
      [fill(labels.task.queued, { others: '1. δεύτερο' }), fill(labels.task.added, { added: 'λοιπόν;' })].join('\n\n')
    )
  );
  assert.equal(named.turns.spokeAfterSeeing('c1', 'm3'), false, 'left to its own turn');
  assert.equal(named.turns.spokeAfterSeeing('c1', 'm1'), true);

  const { queued: _queued, ...noQueued } = labels.task;
  const older = await run(splitHot({ labels: { ...labels, task: noQueued } }));
  assert.equal(older.task.includes('δεύτερο'), false);
  assert.equal(older.turns.spokeAfterSeeing('c1', 'm3'), true, 'the old rule: seen is answered');
});

test("runTurn: another member's waiting call is named under labels.task.queuedOthers and not counted as seen; without the label it is", async () => {
  const history = [
    rawMessage({ id: 'm1', ts: NOW - 3000, content: 'πρώτο' }),
    rawMessage({ id: 'm2', ts: NOW - 2500, authorId: 'u2', authorName: 'Léa', content: 'άλλο' }),
    rawMessage({ id: 'm3', ts: NOW - 2000, content: 'δεύτερο' }),
  ];
  const run = async (hot: unknown) => {
    const llm = splitLlm({ talk: '<msg>ok</msg>' });
    const channel = fakeTurnChannel({ historyMessages: history });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot,
      store: fakeStore(),
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      now: () => NOW,
      schedule: manualSchedule(),
    });
    const queued = () => [
      { id: 'm2', text: 'άλλο', author: 'Léa' },
      { id: 'm3', text: 'δεύτερο' },
    ];
    await turns.runTurn({
      channel,
      mode: 'reply',
      trigger: normalizedTrigger(history[0]),
      triggerKind: 'mention',
      queued,
    });
    return { turns, task: taskOf(llm.calls.talk[0]) };
  };
  const named = await run(splitHot());
  assert.ok(
    named.task.endsWith(
      [
        fill(labels.task.queued, { others: '1. δεύτερο' }),
        fill(labels.task.queuedOthers, { others: '1. Léa: άλλο' }),
      ].join('\n\n')
    )
  );
  assert.equal(named.turns.spokeAfterSeeing('c1', 'm2'), false, 'left to its own turn');
  assert.equal(named.turns.spokeAfterSeeing('c1', 'm3'), false);

  const { queuedOthers: _others, ...older } = labels.task;
  const old = await run(splitHot({ labels: { ...labels, task: older } }));
  assert.equal(old.task.includes('άλλο'), false);
  assert.equal(old.turns.spokeAfterSeeing('c1', 'm2'), true, "the old rule for another member's call");
  assert.equal(old.turns.spokeAfterSeeing('c1', 'm3'), false, "the author's own call is still named under task.queued");
});

// ---------------------------------------------------------------------------
// The GIF picker (src/behavior/gif-pick.ts): a short reply is shown with the
// WHOLE captioned library to one classifier request; a handle it names is
// posted instead of the text.

const GIF_PICK_PROMPT = 'Pick a GIF for what {{name}} wrote.';
const PICK_LIBRARY_SIZE = 50;
// PR 7d: gifs.pick.maxChars (160), contextMessages (4) and graceMs (1000) are constants of the picker.
const PICK_SETTINGS = { maxOutputTokens: 17 };

/**
 * A library of PICK_LIBRARY_SIZE link GIFs, every one captioned: g1 the most used, g50 used
 * once long ago (it never makes a top slice), so a pick of g50 proves the whole library is shown.
 */
function pickLibrary() {
  const entries: Record<string, Untyped> = {};
  const mediaCache: Record<string, Untyped> = {};
  for (let i = 1; i <= PICK_LIBRARY_SIZE; i += 1) {
    entries[`k${i}`] = {
      id: `g${i}`,
      kind: 'link',
      url: `https://tenor.com/view/gif-${i}`,
      itemId: `item-${i}`,
      messageId: `m-${i}`,
      channelId: 'c1',
      count: PICK_LIBRARY_SIZE + 1 - i,
      last: NOW - i * 3_600_000,
    };
    mediaCache[`item-${i}`] = { text: `λεζάντα ${i}` };
  }
  return { gifs: { nextId: PICK_LIBRARY_SIZE + 1, entries }, mediaCache };
}

/** fakeStore with pickLibrary (or `library`), the real findGif over it and the own-post stamps recorded. */
function pickStore({ library = pickLibrary(), data = {} } = {}) {
  const store = fakeStore({ mediaCache: library.mediaCache });
  store.state = { data, markDirty() {} };
  store.getGifs = () => library.gifs;
  store.findGif = (guildId: string, handle: string) => findGif(library.gifs, handle);
  store.ownGifs = [];
  store.recordOwnGif = (guildId: string, key: string, ts: number) => store.ownGifs.push({ guildId, key, ts });
  return store;
}

/** A fake LLM answering the turn with `reply` and the picker with `pick` (a function may wait or throw). */
function pickLlm({ reply, pick = 'none' }: Untyped) {
  const calls: Array<{ messages: Untyped; options: Untyped }> = [];
  return {
    calls,
    complete: async (messages: Untyped, options: Untyped) => {
      calls.push({ messages, options });
      const answer = options?.purpose === 'gif-pick' ? pick : reply;
      return { text: typeof answer === 'function' ? await answer() : answer, usage: {}, estimated: 10 };
    },
  };
}

/** The two chat lines of a picker turn: an older one, then the trigger. */
function pickHistory() {
  return [
    rawMessage({ id: 'm0', ts: NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
}

/** A hot config for the picker: its prompt and its own gifs values. */
function pickHot({
  features = {},
  prompts = {},
  pickSettings = PICK_SETTINGS,
  typing = null,
}: {
  features?: Record<string, unknown>;
  prompts?: Record<string, string | null>;
  pickSettings?: Record<string, unknown>;
  typing?: Record<string, unknown> | null;
} = {}) {
  const hot = fakeHot(
    { ...features },
    {},
    {
      gifs: { pick: pickSettings },
      models: { base: { analyzer: 'cheap/classifier' } },
      ...(typing ? { typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], ...typing } } : {}),
    }
  );
  Object.assign(hot.prompts, { 'gif-pick': GIF_PICK_PROMPT }, prompts);
  for (const [name, text] of Object.entries(prompts)) if (text === null) delete hot.prompts[name];
  return hot;
}

async function runPickTurn({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  pick = 'none',
  store = pickStore(),
  typing = null,
  raws = pickHistory(),
  triggerRaw = raws.at(-1),
  failGif = false,
  journaled = false,
  ...hotOptions
}: Record<string, Untyped> = {}) {
  const channel = fakeTurnChannel({ historyMessages: raws });
  const sendTimes: Array<number> = [];
  world().tap('send', () => {
    sendTimes.push(Date.now());
  });
  if (failGif) world().failSends((text) => String(text).startsWith('https://tenor.com/'));
  const llm = pickLlm({ reply, pick });
  const hot = pickHot({ ...hotOptions, typing });
  // With `journaled`, a journal in memory: `limits` are the turn record's.
  const recorded = journaled ? journalOverMemory() : null;
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
    ...(recorded ? { journal: recorded.journal } : {}),
  });
  const startedAt = Date.now();
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(triggerRaw), triggerKind: 'mention' })
  );
  const picks = llm.calls.filter((call) => call.options?.purpose === 'gif-pick');
  const sent = () => channel.sent.map((payload) => payload.content);
  const limits = recorded?.lines.find(({ record }) => record.kind === 'turn')?.record.limits ?? null;
  return { result, logs, channel, picks, store, sent, sendTimes, startedAt, limits };
}

test('runTurn: a short reply is shown with the whole captioned library; a picked handle posts that GIF and no text', async () => {
  const { result, logs, channel, picks, store, sent } = await runPickTurn({ pick: ' G50 ' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(picks.length, 1, 'one pick request');
  const [system, user] = picks[0].messages;
  assert.deepEqual(system, { role: 'system', content: 'Pick a GIF for what Bot wrote.' });
  assert.equal(user.content.length, 2, 'two text parts');
  assert.equal(user.content[0].cacheSegment, 'stable', 'the library part is the cache segment');
  assert.equal(user.content[1].cacheSegment, undefined, 'the per-turn part is untagged');
  assert.ok(
    user.content[0].text.startsWith('<gifs>\n') && user.content[0].text.endsWith('</gifs>\n\n'),
    'part 1 is the library block and its separator'
  );
  assert.ok(user.content[1].text.startsWith('<context>\n'), 'part 2 starts at the context');
  const blocks = textOf(user.content).split('\n\n');
  assert.equal(blocks.length, 3);
  assert.match(
    blocks[1],
    /^<context>\n[\s\S]*καλημέρα[\s\S]*θα έρθεις απόψε;\n<\/context>$/,
    'the last contextMessages lines as the transcript renders them'
  );
  const marker = fill(labels.transcript.replyTo, { index: 2, author: 'Alice', quote: 'θα έρθεις απόψε;' });
  assert.equal(blocks[2], `<reply>\n${marker} ναι, φυσικά, έλα\n</reply>`, 'the reply names the line it answers');
  assert.ok(
    blocks[0].startsWith('<gifs>\n') && blocks[2].endsWith('</reply>'),
    'the library leads the request, the reply ends it'
  );
  const gifLines = blocks[0]
    .replace(/^<gifs>\n/, '')
    .replace(/\n<\/gifs>$/, '')
    .split('\n');
  assert.equal(gifLines.length, PICK_LIBRARY_SIZE, 'the whole library, not a top slice');
  assert.deepEqual([gifLines[0], gifLines.at(-1)], ['g1 -- λεζάντα 1', 'g50 -- λεζάντα 50'], 'in rank order');
  const { options } = picks[0];
  assert.deepEqual(
    [options.role, options.purpose, options.maxOutputTokens, options.model, options.countAgainstDailyCap],
    ['analyzer', 'gif-pick', 17, 'cheap/classifier', true]
  );

  assert.deepEqual(sent(), ['https://tenor.com/view/gif-50'], 'the GIF, no text');
  assert.equal(channel.sent[0].reply?.messageReference, 'm1', 'replying where the first message would have');
  assert.deepEqual(store.ownGifs, [{ guildId: 'g1', key: 'k50', ts: NOW }]);
  const picked = logs.find((entry) => entry.msg === 'gifs: picked');
  assert.deepEqual([picked?.channel, picked?.handle, picked?.library], ['c1', true, PICK_LIBRARY_SIZE]);
  assert.equal(
    JSON.stringify(logs.filter((entry) => entry.msg.startsWith('gifs:'))).includes('λεζάντα'),
    false,
    'counts only'
  );
});

test('runTurn: the picker leaves out uncaptioned GIFs and acts only on a listed handle', async () => {
  const library = pickLibrary();
  delete library.mediaCache['item-7'];
  const { picks, sent, logs } = await runPickTurn({ store: pickStore({ library }), pick: 'g7' });
  assert.equal(textOf(picks[0].messages[1].content).includes('g7 --'), false, 'g7 has no caption');
  assert.deepEqual(sent(), ['ναι, φυσικά, έλα'], 'an unlisted handle posts the text');
  const picked = logs.find((entry) => entry.msg === 'gifs: picked');
  assert.deepEqual([picked?.handle, picked?.library], [false, PICK_LIBRARY_SIZE - 1]);
});

test('runTurn: the picker answering none or something unreadable posts the text', async () => {
  for (const pick of ['none', 'g3 maybe']) {
    const { picks, sent, logs } = await runPickTurn({ pick });
    assert.equal(picks.length, 1, pick);
    assert.deepEqual(sent(), ['ναι, φυσικά, έλα'], pick);
    assert.equal(logs.find((entry) => entry.msg === 'gifs: picked')?.handle, false, pick);
  }
});

test('runTurn: a failed pick request logs gifs: pick failed and posts the text', async () => {
  const { sent, logs } = await runPickTurn({
    pick: () => {
      throw Object.assign(new Error('upstream'), { statusCode: 503 });
    },
  });
  assert.deepEqual(sent(), ['ναι, φυσικά, έλα']);
  assert.equal(logs.find((entry) => entry.msg === 'gifs: pick failed')?.status, 503);
});

test('runTurn: no pick for a reply over maxChars or a turn posting its own GIF', async () => {
  const text = 'α'.repeat(161);
  const long = await runPickTurn({ reply: `<msg>${text}</msg>`, pick: 'g1' });
  assert.equal(long.picks.length, 0, 'over maxChars');
  assert.deepEqual(long.sent(), [text]);
  const fits = await runPickTurn({ reply: `<msg>${'α'.repeat(160)}</msg>`, pick: 'g1' });
  assert.equal(fits.picks.length, 1, 'exactly maxChars is still picked for');

  const own = await runPickTurn({ reply: '<msg>χα</msg><gif>g2</gif>', pick: 'g1' });
  assert.equal(own.picks.length, 0, 'the turn posts a GIF already');
  assert.deepEqual(own.sent(), ['χα', 'https://tenor.com/view/gif-2']);
});

test('runTurn: no pick without the prompt or without a captioned GIF', async () => {
  const noPrompt = await runPickTurn({ pick: 'g1', prompts: { 'gif-pick': null } });
  assert.equal(noPrompt.picks.length, 0, 'no prompts/gif-pick.md');
  const empty = await runPickTurn({
    pick: 'g1',
    store: pickStore({ library: { gifs: { nextId: 1, entries: {} }, mediaCache: {} } }),
  });
  assert.equal(empty.picks.length, 0, 'no captioned GIF');
});

/** Six chat lines: the trigger (m1) is followed by four later lines from someone else, the picker's whole context. */
function laterLinesHistory() {
  return [
    rawMessage({ id: 'm0', ts: NOW - 11000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 9000, content: 'θα έρθεις απόψε;' }),
    rawMessage({ id: 'm2', ts: NOW - 7000, authorId: 'u2', authorName: 'Zoé', content: 'κι εγώ ρωτάω' }),
    rawMessage({ id: 'm3', ts: NOW - 5000, authorId: 'u2', authorName: 'Zoé', content: 'λοιπόν;' }),
    rawMessage({ id: 'm4', ts: NOW - 3000, authorId: 'u2', authorName: 'Zoé', content: 'ε;' }),
    rawMessage({ id: 'm5', ts: NOW - 1000, authorId: 'u2', authorName: 'Zoé', content: 'ναι;' }),
  ];
}

test("runTurn: the picker's context brings in an older answered trigger, first, and the reply names it", async () => {
  const raws = laterLinesHistory();
  const { picks } = await runPickTurn({ raws, triggerRaw: raws[1], reply: '<msg>ναι, φυσικά</msg>' });
  assert.equal(picks.length, 1);
  const [, context, reply] = textOf(picks[0].messages[1].content).split('\n\n');
  assert.match(
    context,
    /^<context>\n[^#\n]*\n#1 [^\n]*Alice: θα έρθεις απόψε;\n#2 [^\n]*κι εγώ ρωτάω\n#3 [^\n]*λοιπόν;\n#4 [^\n]*ε;\n#5 [^\n]*ναι;\n<\/context>$/,
    'the answered line with its author, then the last four lines'
  );
  const marker = fill(labels.transcript.replyTo, { index: 1, author: 'Alice', quote: 'θα έρθεις απόψε;' });
  assert.equal(reply, `<reply>\n${marker} ναι, φυσικά\n</reply>`);
});

test('runTurn: the picker names the line the first message replies to, when it is not the last', async () => {
  const raws = laterLinesHistory();
  const { picks } = await runPickTurn({ raws, reply: '<msg reply="#3">χα, ναι</msg>' });
  const [, context, reply] = textOf(picks[0].messages[1].content).split('\n\n');
  assert.match(
    context,
    /^<context>\n[^#\n]*\n#1 [^\n]*κι εγώ ρωτάω\n#2 [^\n]*λοιπόν;\n#3 [^\n]*ε;\n#4 [^\n]*ναι;\n<\/context>$/
  );
  const marker = fill(labels.transcript.replyTo, { index: 1, author: 'Zoé', quote: 'κι εγώ ρωτάω' });
  assert.equal(reply, `<reply>\n${marker} χα, ναι\n</reply>`);
});

test('runTurn: with several messages a picked GIF replaces the first one only; the rest follow in order', async () => {
  const longer = 'και κάτι ακόμα πιο μακρύ ' + 'α'.repeat(160);
  const reply = `<msg reply="#2">χα</msg><msg>${longer}</msg><msg>τέλος</msg>`;
  const { picks, sent, channel, store } = await runPickTurn({ reply, pick: 'g50' });
  assert.equal(picks.length, 1, 'only the first message counts toward gifs.pick.maxChars');
  assert.equal(
    textOf(picks[0].messages[1].content).split('\n\n')[2].endsWith(' χα\n</reply>'),
    true,
    'the picker sees the message it would replace'
  );
  assert.deepEqual(sent(), ['https://tenor.com/view/gif-50', longer, 'τέλος']);
  assert.equal(channel.sent[0].reply?.messageReference, 'm1', 'the GIF replies where the first message would have');
  assert.deepEqual(
    store.ownGifs.map((own: Untyped) => own.key),
    ['k50']
  );
});

test('runTurn: a picked GIF that fails to send leaves the first message to be posted as written, then the rest', async () => {
  const reply = '<msg reply="#2">χα</msg><msg>τέλος</msg>';
  const { sent, channel, logs, store } = await runPickTurn({ reply, pick: 'g50', failGif: true });
  assert.ok(
    logs.some((entry) => entry.msg === 'turn: gif failed'),
    'the failed GIF is logged'
  );
  assert.deepEqual(sent(), ['χα', 'τέλος'], 'nothing is lost');
  assert.equal(channel.sent[0].reply?.messageReference, 'm1', 'the first message replies as written');
  assert.deepEqual(store.ownGifs, [], 'no own post recorded');
});

test('runTurn: gifs.pick.maxChars gates the first message only', async () => {
  const first = 'και κάτι ακόμα πιο μακρύ ' + 'α'.repeat(160);
  const long = await runPickTurn({ reply: `<msg>${first}</msg><msg>χα</msg>`, pick: 'g1' });
  assert.equal(long.picks.length, 0, 'a long first message is never replaced');
  assert.deepEqual(long.sent(), [first, 'χα']);
});

test("runTurn: the picker runs alongside the first message's typing time", async () => {
  let askedAt = null;
  const pick = () => {
    askedAt = Date.now();
    return new Promise((resolve) => setTimeout(() => resolve('none'), 150));
  };
  const { sendTimes, sent } = await runPickTurn({
    reply: '<msg>ναι</msg>',
    pick,
    typing: { msPerChar: [0, 0], minMs: 150, maxMs: 150 },
  });
  assert.deepEqual(sent(), ['ναι']);
  assert.ok(askedAt !== null && askedAt <= sendTimes[0], 'the picker is asked before the send');
  const together = sendTimes[0] - askedAt;
  assert.ok(together >= 140 && together < 270, `the picker and the typing ran together (${together} ms)`);
});

test("runTurn: a picker still out when the first message's typing ends is left behind: the text goes, logged and journaled", async () => {
  // PR 7d: gifs.pick.graceMs is the constant 1000, so the picker has that long beyond the typing before it is left behind.
  const typing = { msPerChar: [0, 0], minMs: 60, maxMs: 60 };
  const slow = () => new Promise((resolve) => setTimeout(() => resolve('g50'), 1400));
  const late = await runPickTurn({
    reply: '<msg>ναι</msg>',
    pick: slow,
    typing,
    journaled: true,
  });
  assert.deepEqual(late.sent(), ['ναι'], 'the text as written, no GIF');
  assert.ok(
    late.sendTimes[0] - late.startedAt < 1300,
    `not held for the picker (${late.sendTimes[0] - late.startedAt} ms)`
  );
  const entry = late.logs.find((log) => log.msg === 'gifs: pick late');
  assert.deepEqual([entry?.channel, entry?.graceMs], ['c1', 1000]);
  assert.deepEqual(late.store.ownGifs, [], 'nothing posted or stamped');
  assert.ok(
    late.limits.some((limit: Untyped) => limit.kind === 'helper-timeout' && limit.where === 'gif-pick'),
    'the turn record names the picker'
  );

  const graced = await runPickTurn({
    reply: '<msg>ναι</msg>',
    pick: () => new Promise((resolve) => setTimeout(() => resolve('g50'), 400)),
    typing,
  });
  assert.deepEqual(
    graced.sent(),
    ['https://tenor.com/view/gif-50'],
    'an answer inside the grace still replaces the text'
  );
  assert.equal(
    graced.logs.some((log) => log.msg === 'gifs: pick late'),
    false
  );
});

test('runTurn: a picker that answered during the typing is used', async () => {
  const quick = await runPickTurn({
    reply: '<msg>ναι</msg>',
    pick: 'g50',
    typing: { msPerChar: [0, 0], minMs: 60, maxMs: 60 },
  });
  assert.deepEqual(quick.sent(), ['https://tenor.com/view/gif-50']);
  assert.equal(
    quick.logs.some((log) => log.msg === 'gifs: pick late'),
    false
  );
});

/**
 * Two picker turns on ONE runner at `times` (ms), the library changed between them by `between`
 * (a GIF post of the persona, a use that reranks); the picks' user parts.
 */
async function twoPickTurns({ times, between }: Untyped) {
  const library = pickLibrary();
  const store = pickStore({ library });
  const llm = pickLlm({ reply: '<msg reply="#2">ναι, φυσικά, έλα</msg>', pick: 'none' });
  let t = times[0];
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: pickHot(),
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => t,
  });
  const turn = () =>
    withCapturedLogs(() =>
      turns.runTurn({
        channel: fakeTurnChannel({ historyMessages: pickHistory() }),
        mode: 'reply',
        trigger: normalizedTrigger(pickHistory().at(-1) as RawMessage),
        triggerKind: 'mention',
      })
    );
  await turn();
  between(library.gifs);
  t = times[1];
  await turn();
  return llm.calls.filter((call) => call.options?.purpose === 'gif-pick').map((call) => call.messages[1].content);
}

/** The persona posted g40 at `at`, and it was used enough to lead the ranking. */
const postG40 = (at: number) => (gifs: Untyped) =>
  Object.assign(gifs.entries.k40, { ownLast: at, ownUses: 1, count: 500, last: at });

test("runTurn: the picker's cached library is byte-identical within one cache bucket; her post and its age go to the tail", async () => {
  const first = NOW + 60_000;
  const second = NOW + 7 * 60_000;
  const [a, b] = await twoPickTurns({ times: [first, second], between: postG40(first + 1000) });
  assert.equal(a[0].cacheSegment, 'stable');
  assert.equal(b[0].text, a[0].text, "the stable part of the second pick is byte for byte the first one's");
  assert.equal(b[0].text.includes('(you'), false, 'no own-post mark in the cached library');
  const gifLines = b[0].text
    .replace(/^<gifs>\n/, '')
    .replace(/\n<\/gifs>\n\n$/, '')
    .split('\n');
  assert.equal(gifLines[0], 'g1 -- λεζάντα 1', 'the order the bucket started with');
  assert.equal(a[1].text.includes('<gifs_recent>'), false, 'no recent post before it');
  const recent = fill(labels.gifs.ownMark, { ago: formatDuration(second - (first + 1000), labels.units) });
  assert.ok(
    b[1].text.startsWith(`<gifs_recent>\ng40 ${recent}\n</gifs_recent>\n\n<context>\n`),
    'the post and its age open the per-call tail'
  );
});

test("runTurn: the picker's library follows the library at the next cache bucket", async () => {
  const first = NOW + 60_000;
  const [, nextBucket] = await twoPickTurns({ times: [first, NOW + 61 * 60_000], between: postG40(first + 1000) });
  assert.ok(nextBucket[0].text.startsWith('<gifs>\ng40 -- λεζάντα 40\n'), 'reranked at the bucket edge');
});

// ---------------------------------------------------------------------------
// Reply parents outside the window: a reply to a message older than the last
// context.channelMessages lines has its parent fetched by id and prepended.

/** A raw reply to `parentId` (see rawMessage). */
function rawReplyTo(parentId: unknown, fields: Untyped) {
  return { ...rawMessage(fields), reference: { messageId: parentId } };
}

/** fakeTurnChannel that also holds `stored` (raw messages outside the window); `fetchedIds` records every message read by id. */
function replyParentChannel(historyMessages: Array<Untyped>, stored: Array<Untyped> = []) {
  // The stored messages are older than the window, which is exactly the lines of `historyMessages`: the history read
  // (the newest `context.channelMessages`, set by runReplyParentTurn) leaves them out and a read by id finds them.
  const channel = fakeTurnChannel({ historyMessages: [...stored, ...historyMessages] });
  const fetchedIds: Array<Untyped> = [];
  world().tap('fetchMessages', ([ref, ids]: Array<Untyped>) => {
    if (asRecord(ref).conversationId === channel.id) fetchedIds.push(...ids);
  });
  return Object.assign(channel, { fetchedIds });
}

/** The video-stage hot config. */
function replyParentHot() {
  return fakeHot({}, {}, VIDEO_TURN_CONFIG);
}

const OLD_PARENT_TS = NOW - 2 * 60 * 60 * 1000;

async function runReplyParentTurn({
  hot = replyParentHot(),
  historyMessages,
  stored,
  trigger,
}: Record<string, Untyped>) {
  hot.config.context.channelMessages = historyMessages.length;
  const channel = replyParentChannel(historyMessages, stored);
  const llm = fakeLlm('<msg>ok</msg>');
  const describer = fakeVideoDescriber({});
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' })
  );
  return { result, logs, channel, describer, userMessage: textOf(llm.calls[0]?.[1].content) };
}

test('createTurnRunner: a trigger replying outside the window -- its parent is fetched, prepended, rendered as the reply target, and its link reaches the video stage', async () => {
  const parent = rawMessage({
    id: 'p1',
    authorId: 'u2',
    authorName: 'Bob',
    ts: OLD_PARENT_TS,
    content: 'δείτε https://www.youtube.com/watch?v=abc',
  });
  const triggerRaw = rawReplyTo('p1', { id: 'm2', ts: NOW - 1000, content: 'react to the video above' });
  const { result, channel, describer, userMessage } = await runReplyParentTurn({
    historyMessages: [rawMessage({ id: 'm1', ts: NOW - 5000, content: 'καλημέρα' }), triggerRaw],
    stored: [parent],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p1' },
  });

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(channel.fetchedIds, ['p1']);
  assert.ok(userMessage.includes('(replying to #1, Bob: '), 'the reply names the prepended parent as the oldest line');
  assert.ok(!userMessage.includes(labels.transcript.replyToOld));
  assert.ok(userMessage.indexOf('δείτε') < userMessage.indexOf('καλημέρα'), 'the parent is the oldest line');
  const items = describer.videoCalls[0].items;
  assert.ok(
    items.some(
      (item: Untyped) =>
        item.source === 'link' && item.messageId === 'p1' && item.url === 'https://www.youtube.com/watch?v=abc'
    )
  );
});

test('createTurnRunner: a reply whose parent is inside the window fetches nothing', async () => {
  const parent = rawMessage({ id: 'p1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5000, content: 'δείτε' });
  const triggerRaw = rawReplyTo('p1', { id: 'm2', ts: NOW - 1000 });
  const { channel, userMessage } = await runReplyParentTurn({
    historyMessages: [parent, triggerRaw],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p1' },
  });

  assert.deepEqual(channel.fetchedIds, []);
  assert.ok(userMessage.includes('(replying to #1, Bob: '));
});

test('createTurnRunner: a chain of two outside the window -- the parent and its own parent are both prepended, oldest first', async () => {
  const root = rawMessage({ id: 'p1', authorId: 'u3', authorName: 'Chloé', ts: OLD_PARENT_TS, content: 'ρίζα' });
  const middle = rawReplyTo('p1', {
    id: 'p2',
    authorId: 'u2',
    authorName: 'Bob',
    ts: OLD_PARENT_TS + 1000,
    content: 'μέση',
  });
  const triggerRaw = rawReplyTo('p2', { id: 'm2', ts: NOW - 1000 });
  const { channel, userMessage } = await runReplyParentTurn({
    historyMessages: [triggerRaw],
    stored: [root, middle],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p2' },
  });

  assert.deepEqual(channel.fetchedIds, ['p2', 'p1']);
  assert.ok(userMessage.includes('(replying to #1, Chloé: '), 'the middle line replies to the root');
  assert.ok(userMessage.includes('(replying to #2, Bob: '), 'the trigger replies to the middle line');
  assert.ok(!userMessage.includes(labels.transcript.replyToOld));
});

test('createTurnRunner: the parents fetched for a window are capped at four, the newest lines first', async () => {
  // PR 7d: context.replyParentsMax is the constant 4 (the production value).
  const stored = ['pa', 'pb', 'pc', 'pd', 'pe'].map((id, i) =>
    rawMessage({ id, authorId: 'u2', authorName: 'Bob', ts: OLD_PARENT_TS + i })
  );
  const historyMessages = stored.map((parent, i) =>
    rawReplyTo(parent.id, { id: `m${i + 1}`, ts: NOW - (5 - i) * 1000 })
  );
  const { channel } = await runReplyParentTurn({
    historyMessages,
    stored,
    trigger: { ...normalizedTrigger(historyMessages[4]), replyToId: 'pe' },
  });
  assert.deepEqual(channel.fetchedIds, ['pe', 'pd', 'pc', 'pb']);
});

test('createTurnRunner: the window asks the parents of every line and shows them in <earlier>, not <chat>', async () => {
  const stored = ['pa', 'pb', 'pc'].map((id, i) =>
    rawMessage({ id, authorId: 'u2', authorName: 'Bob', ts: OLD_PARENT_TS + i, content: `γονέας ${id}` })
  );
  const historyMessages = [
    rawReplyTo('pa', { id: 'm1', ts: NOW - 3000 }),
    rawReplyTo('pb', { id: 'm2', ts: NOW - 2000 }),
    rawReplyTo('pc', { id: 'm3', ts: NOW - 1000 }),
  ];
  const hot = replyParentHot();
  const { channel, userMessage } = await runReplyParentTurn({
    hot,
    historyMessages,
    stored,
    trigger: { ...normalizedTrigger(historyMessages[2]), replyToId: 'pc' },
  });
  assert.deepEqual(channel.fetchedIds, ['pc', 'pb', 'pa'], 'every window line, newest first');
  const block = (tag: string) => userMessage.slice(userMessage.indexOf(`<${tag}>`), userMessage.indexOf(`</${tag}>`));
  assert.ok(
    ['pa', 'pb', 'pc'].every((id) => block('earlier').includes(`γονέας ${id}`)),
    block('earlier')
  );
  assert.ok(
    !/^#[123] \[/m.test(block('chat')) && /^#4 \[/m.test(block('chat')),
    'the parents left the chat, the window kept its numbers'
  );
  assert.ok(block('chat').includes('(replying to #3, Bob: '), 'the chat still names a parent by its number');
});

test('createTurnRunner: a deleted reply parent is skipped and logged, the turn still speaks', async () => {
  const triggerRaw = rawReplyTo('gone', { id: 'm2', ts: NOW - 1000 });
  const { result, logs, channel, userMessage } = await runReplyParentTurn({
    historyMessages: [triggerRaw],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'gone' },
  });

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(channel.fetchedIds, ['gone']);
  const missing = logs.filter((entry) => entry.msg === 'collect: parent missing');
  assert.deepEqual(
    missing.map((entry) => [entry.channel, entry.messageId]),
    [['c1', 'gone']]
  );
  assert.ok(userMessage.includes(labels.transcript.replyToOld));
});

// ---------------------------------------------------------------------------
// Participation: recording the persona's sent lines, the pick classifier, the block.

/** A fake store with the participation store: get returns a copy, set records each write. */
function participationStore(
  initial: { episodes: Array<Untyped>; nextId: number } = { episodes: [], nextId: 1 },
  base = fakeStore({ channels: [{ id: 'c2', name: 'journal', purpose: 'a reading log' }] })
) {
  let value: Untyped = structuredClone(initial);
  const writes: Array<{ guildId: Untyped; state: Untyped; opts: Untyped }> = [];
  return Object.assign(base, {
    writes,
    current: () => value,
    getParticipation: () => structuredClone(value),
    setParticipation: (guildId: string, state: unknown, opts: unknown) => {
      writes.push({ guildId, state, opts });
      value = structuredClone(state);
    },
  });
}

/** One stored episode of channel `channelId`, the persona's line `ageMinutes` old. */
function storedEpisode(id: string, channelId: string, ageMinutes: number, ownText: string, memberText = 'μια ερώτηση') {
  const at = NOW - ageMinutes * 60_000;
  return {
    id,
    channelId,
    continues: null,
    messages: [
      {
        id: `${id}-q`,
        ts: at - 60_000,
        authorId: 'u9',
        name: 'Ana',
        self: false,
        text: memberText,
        replyTo: null,
        caption: null,
      },
      {
        id: `${id}-a`,
        ts: at,
        authorId: 'self-id',
        name: 'Bot',
        self: true,
        text: ownText,
        replyTo: null,
        caption: null,
      },
    ],
  };
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
  };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn(params));
  return { result, logs, channel, llm, store };
}

test('runTurn: each message sent is recorded as participation with the history lines before it', async () => {
  const { result, store, logs } = await runParticipationTurn({
    answers: ['<msg reply="#2">στο ράφι</msg><msg>το είδα χθες</msg>'],
  });
  assert.equal(result.outcome, 'spoke');
  assert.equal(store.writes.length, 2, 'one write per message sent');
  const [episode] = store.current().episodes;
  assert.equal(episode.channelId, 'c1');
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
  assert.equal(store.writes[0].opts.now, NOW);
  assert.equal(store.writes[0].opts.settings.hours, 72);
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
  assert.equal(dm.channel.sent.length, 1);
  assert.equal(store.writes.length, 0);
  assert.ok(!textOf(dm.llm.calls.at(-1)[1].content).includes('<participation>'), 'no block in a private chat');
});

test('runTurn: the pick classifier runs beside the turn and its pick reaches the <participation> block', async () => {
  const store = participationStore({
    episodes: [storedEpisode('p1', 'c2', 120, 'στο ράφι είναι'), storedEpisode('p2', 'c3', 30, 'ωραία λουλούδια')],
    nextId: 3,
  });
  // PR 7d: participation.shown is the constant 4, so both stored episodes are shown whatever the pick says.
  const hot = fakeHot();
  hot.prompts['participation-pick'] = 'Pick for {{name}}.';
  const { llm, logs, result } = await runParticipationTurn({ hot, store, answers: ['1', '<msg>ναι</msg>'] });
  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[0][0].content, 'Pick for Bot.');
  assert.ok(
    textOf(llm.calls[0][1].content).includes(
      '<episodes>\n1 | #journal | Ana: μια ερώτηση | Bot: στο ράφι είναι\n2 | #jardin | Ana: μια ερώτηση | Bot: ωραία λουλούδια\n</episodes>\n<episode_ages>\n1 | 2 h\n2 | 30 min\n</episode_ages>'
    ),
    textOf(llm.calls[0][1].content)
  );
  const user = textOf(llm.calls[1][1].content);
  assert.ok(
    user.includes('<participation>') && user.includes('#journal (a reading log):') && user.includes('στο ράφι είναι'),
    'the picked older episode is shown'
  );
  assert.ok(user.includes('ωραία λουλούδια'), 'both episodes fit the four shown');
  assert.ok(user.includes(labels.senses.participation));
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.equal(answered?.budget.participation.shown, 2);
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.equal(typeof timings?.stages.participation, 'number');
});

test('runTurn: without the pick prompt the newest episodes are shown and the classifier is skipped', async () => {
  const store = participationStore({
    episodes: [storedEpisode('p1', 'c2', 120, 'στο ράφι είναι'), storedEpisode('p2', 'c3', 30, 'ωραία λουλούδια')],
    nextId: 3,
  });
  const { llm, logs } = await runParticipationTurn({ store, answers: ['<msg>ναι</msg>'] });
  assert.equal(llm.calls.length, 1, 'only the reply request');
  const user = textOf(llm.calls[0][1].content);
  // PR 7d: participation.shown is the constant 4, so both episodes are shown, the newest first.
  assert.ok(user.includes('ωραία λουλούδια') && user.includes('στο ράφι είναι'));
  assert.ok(user.indexOf('ωραία λουλούδια') < user.indexOf('στο ράφι είναι'));
  assert.equal(logs.find((l) => l.msg === 'participation: skipped')?.reason, 'no-prompt');
});

test('runTurn: the model answered log line carries the user message segments, hashes only', async () => {
  const { logs } = await runDrawTurn({ answers: [toolAnswer('', [call('draw.create', { text: 'a cat' })])] });
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.ok(Array.isArray(answered?.segments) && answered?.segments.length >= 1);
  assert.equal(answered?.segments.at(-1).segment, 'tail');
  for (const s of answered?.segments ?? []) {
    assert.deepEqual(Object.keys(s).sort(), ['chars', 'hash', 'segment']);
    assert.match(s.hash, /^[0-9a-f]{8}$/);
    assert.ok(s.chars > 0);
  }
});

/** A real journal over a test memory database whose writes also keep every line in memory. */
function journalOverMemory() {
  const lines: Array<{ file: string; record: Untyped }> = [];
  const mem = openTestMemorySync();
  OPENED_MEMORY.push(mem);
  const memoryDb = {
    ...mem.memoryDb,
    writeUnit: (update: Untyped) => {
      // Legacy labels are fixture export projections of the actual semantic keys.
      for (const line of update.lines ?? []) lines.push({ file: journalLabel('fake-data', update.key), record: line });
      return mem.memoryDb.writeUnit(update);
    },
  };
  let n = 0;
  const journal = createJournal({
    memoryDb,
    dataDir: 'fake-data',
    config: () => ({ thinkChars: 4000 }),
    now: () => NOW,
    uuid: () => `u${(n += 1)}`,
  });
  return { journal, lines };
}

/**
 * An LLM whose one answer reports provider usage: 700 completion tokens, 300 of the prompt cached.
 * Like the real client (src/llm/openrouter.ts), it tells the request's `limits` collector the
 * completion reached its cap: the request's `maxOutputTokens`, else `defaultMax()`.
 */
function usageLlm(text: string, defaultMax = () => Infinity) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    complete: async (messages: unknown, options: Record<string, Untyped> = {}) => {
      calls.push(messages);
      const max = options.maxOutputTokens ?? defaultMax();
      if (options.limits && Number.isFinite(max) && 700 >= max)
        options.limits.add({ kind: 'output-cap', where: 'completion', lost: null });
      return {
        text,
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 700,
          prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 },
        },
        promptTokens: 1500,
        estimated: 1400,
      };
    },
  };
}

test('turn: the memory rows the request carried go to the memoryReads hook with the journal turn id', async () => {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
  const profile = {
    id: 'u1',
    names: ['Alice'],
    details: [{ id: 1, text: 'lives in Lyon', weight: 2, itemId: 'de-1' }],
  };
  const run = async ({ memoryReads }: Untyped) => {
    const hot = fakeHot({}, {}, { llm: { maxRequestTokens: 50000, safetyMargin: 0.9, maxOutputTokens: 700 } });
    const { journal: journalOver } = journalOverMemory();
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot,
      store: fakeStore({ userProfiles: { u1: profile } }),
      llm: usageLlm('<think>x</think><msg reply="#1">γεια</msg>', () => 700),
      calibrator: identityCalibrator(),
      client: fakeClient(),
      journal: journalOver,
      memoryReads,
    });
    return turns.runTurn({
      channel: fakeTurnChannel({ historyMessages: [raw] }),
      mode: 'reply',
      trigger: normalizedTrigger(raw),
      triggerKind: 'mention',
    });
  };

  const calls: Array<Untyped> = [];
  const result = await run({ memoryReads: (args: unknown) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].turnId, result.turnId);
  assert.equal(calls[0].step, 's0');
  assert.ok(calls[0].guildId);
  assert.ok(calls[0].reads.some((read: Untyped) => read.kind === 'claim' && read.id === 'de-1'));

  // A hook that throws never fails the turn; no hook records nothing.
  const throwing = await run({
    memoryReads: () => {
      throw new Error('boom');
    },
  });
  assert.equal(throwing.outcome, 'spoke');
  assert.equal((await run({ memoryReads: null })).outcome, 'spoke');
});

test('turn: one execution context per turn; its id goes with the memory rows the request carried', async () => {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
  const profile = {
    id: 'u1',
    names: ['Alice'],
    details: [{ id: 1, text: 'lives in Lyon', weight: 2, itemId: 'de-1' }],
  };
  const hot = fakeHot(
    { journal: true, typingSimulation: false },
    {},
    { llm: { maxRequestTokens: 50000, safetyMargin: 0.9, maxOutputTokens: 700 } }
  );
  const { journal } = journalOverMemory();
  const calls: Array<Untyped> = [];
  const issued: Array<Untyped> = [];
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore({ userProfiles: { u1: profile } }),
    llm: usageLlm('<think>x</think><msg reply="#1">γεια</msg>', () => 700),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    journal,
    memoryReads: (args: unknown) => calls.push(args),
    memoryContext: (spec: Untyped) => {
      issued.push(spec);
      return { iface: 'discord', kind: spec.kind, id: `ctx:${issued.length}` };
    },
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  assert.equal(calls.length, 1);
  assert.equal(issued.length, 1, 'one context for the turn');
  assert.deepEqual(issued[0], { kind: 'group', destination: `discord:channel:${channel.id}` });
  assert.equal(calls[0].contextId, 'ctx:1');
});

test('turn: writes turn.start and turn records when the journal is on', async () => {
  const earlier = rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Zoé', ts: NOW - 5000, content: 'καλημέρα' });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [earlier, raw] });
  const hot = fakeHot(
    { journal: true, typingSimulation: false },
    {},
    { llm: { maxRequestTokens: 50000, safetyMargin: 0.9, maxOutputTokens: 700 } }
  );
  const llm = usageLlm(
    '<think>Η Αλίκη με φωνάζει.</think><msg reply="#2">γεια</msg><react to="#1">\u{1F389}</react>',
    () => hot.config.llm.maxOutputTokens
  );
  const { journal, lines } = journalOverMemory();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    journal,
  });

  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });

  assert.equal(result.outcome, 'spoke');
  // Between them, the action records of the post and the reaction (Task C's tests check those).
  const turnLines = lines.filter(({ record }) => record.kind !== 'action');
  assert.deepEqual(
    turnLines.map(({ record }) => record.kind),
    ['turn.start', 'turn']
  );
  const [start, turn] = turnLines.map(({ record }) => record);
  assert.equal(turnLines[0].file, turnLines[1].file);
  assert.ok(turnLines[0].file.endsWith('2026-09-20.jsonl'));
  assert.equal(result.turnId, start.turnId);
  assert.equal(result.attemptId, 1);
  assert.equal(start.mode, 'reply');
  assert.deepEqual(start.trigger, { kind: 'mention', messageId: 'm1', authorId: 'u1' });
  assert.deepEqual(start.scope, { channel: 'c1' });
  assert.equal(turn.turnId, start.turnId);
  assert.equal(turn.attemptId, 1);
  assert.equal(turn.outcome, 'spoke');
  assert.equal(turn.reason, null);
  assert.deepEqual(turn.format, { thinkMissing: 0, coerced: 0, malformed: 0, truncated: 0, capped: 0, held: 0 });
  assert.equal(turn.steps, 0);
  assert.deepEqual(turn.seen, { messageIds: ['m0', 'm1'], parents: [], parts: { filePreviews: [] }, pulled: [] });
  assert.deepEqual(turn.sourceMessageIds, ['m0', 'm1']);
  assert.deepEqual([...turn.participants].sort(), ['u1', 'u2']);
  assert.equal(turn.think, 'Η Αλίκη με φωνάζει.');
  const opOf = (name: string) =>
    lines.find(({ record }) => record.kind === 'action' && record.name === name && record.phase === 'started')?.record
      .opId;
  assert.deepEqual(turn.posted, [{ opId: opOf('post'), messageId: 'sent-1', replyTo: 'm1' }]);
  assert.deepEqual(turn.reactions, [{ opId: opOf('react'), to: 'm0', emoji: '\u{1F389}' }]);
  assert.deepEqual(turn.actions, [opOf('react'), opOf('post')]);
  // The cache writes are carried as the provider reported them, beside the cached reads.
  assert.deepEqual(turn.usage, { prompt: 1500, cached: 300, cacheWrite: 200, completion: 700 });
  assert.equal(typeof turn.budget.dropped, 'object');
  assert.deepEqual(
    turn.limits.filter((limit: Untyped) => limit.kind === 'output-cap'),
    [{ kind: 'output-cap', where: 'completion', lost: null }]
  );
  for (const limit of turn.limits.filter((entry: Untyped) => entry.kind === 'budget-drop')) {
    assert.equal(turn.budget.dropped[limit.where], limit.lost);
  }

  // A budget that drops chat lines: the drop is named in budget.dropped and in limits.
  // 500 for the request itself, and what her carried-over tools cost beside it (about 800 with the provider's tool preamble).
  // PR 7d: voice.say is carried over too (features.speech is code), so the cap is 200 tokens above the earlier 1300.
  hot.config.llm = { maxRequestTokens: 1500, safetyMargin: 1, maxOutputTokens: 4000 };
  const crowded = [];
  for (let i = 0; i < 12; i += 1)
    crowded.push(rawMessage({ id: `k${i}`, authorId: 'u2', ts: NOW - 60_000 + i * 1000, content: 'λέξη '.repeat(30) }));
  const last = crowded.at(-1);
  await turns.runTurn({
    channel: fakeTurnChannel({ historyMessages: crowded }),
    mode: 'reply',
    trigger: normalizedTrigger(last as RawMessage),
    triggerKind: 'mention',
  });
  const tight = lines.at(-1)?.record;
  assert.equal(tight.kind, 'turn');
  assert.ok(tight.budget.dropped.chat > 0, JSON.stringify(tight.budget));
  assert.deepEqual(tight.limits, [{ kind: 'budget-drop', where: 'chat', lost: tight.budget.dropped.chat }]);
  assert.equal(tight.seen.messageIds.length, 12 - tight.budget.dropped.chat);
});

test('turn: an explicit skip and an empty answer both end in silence, journaled with the reason', async () => {
  for (const answer of ['<skip/>', '<think>rien</think>']) {
    const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const hot = fakeHot(
      { journal: true, typingSimulation: false },
      {},
      { llm: { maxRequestTokens: 50000, safetyMargin: 0.9, maxOutputTokens: 700 } }
    );
    const { journal, lines } = journalOverMemory();
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot,
      store: fakeStore(),
      llm: fakeLlm(answer),
      calibrator: identityCalibrator(),
      client: fakeClient(),
      journal,
    });
    const result = await turns.runTurn({
      channel,
      mode: 'reply',
      trigger: normalizedTrigger(raw),
      triggerKind: 'mention',
    });
    assert.equal(result.outcome, 'skip', answer);
    assert.equal(result.reason, 'silence', answer);
    const turn = lines.map(({ record }) => record).find((record) => record.kind === 'turn');
    assert.equal(turn.outcome, 'skip');
    assert.equal(turn.reason, 'silence', answer);
  }
});

test('turn: logs thinkChars not think when a journal is wired, think when none is', async () => {
  const raw = rawMessage({ id: 'm1' });
  const answer = '<think>Ζωή μιλά</think><msg>γεια</msg>';
  const run = async (journal: unknown) => {
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: fakeHot(),
      store: fakeStore(),
      llm: fakeLlm(answer),
      calibrator: identityCalibrator(),
      client: fakeClient(),
      journal,
    });
    const { logs } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
    );
    return logs.find((l) => l.msg === 'turn: model answered');
  };

  const on = await run(journalOverMemory().journal);
  assert.equal(on?.thinkChars, 8);
  assert.equal('think' in on, false);

  // PR 7d: features.journal is code, so the journal is there when the core wires one and absent otherwise.
  const off = await run(null);
  assert.equal(off?.think, 'Ζωή μιλά');
  assert.equal('thinkChars' in off, false);
});

/** The action records of `lines` for operation `name`, in order. */
function actionsNamed(lines: Untyped, name: string) {
  return lines
    .map(({ record }: Untyped) => record)
    .filter((record: Untyped) => record.kind === 'action' && record.name === name);
}

test('turn: a post writes started then succeeded with the messageId and the turn record links the opId', async () => {
  const earlier = rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Zoé', ts: NOW - 5000, content: 'καλημέρα' });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [earlier, raw] });
  const { journal, lines } = journalOverMemory();
  // The started line is written before the message is sent.
  const linesAtSend: Array<Array<string>> = [];
  world().tap('send', () => {
    linesAtSend.push(lines.map(({ record }) => `${record.kind}:${record.name ?? ''}:${record.phase ?? ''}`));
  });
  const llm = fakeLlm('<msg reply="#2">γεια σου Αλίκη</msg><react to="#1">\u{1F389}</react>');
  const hot = fakeHot({});
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    journal,
  });

  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  assert.equal(result.outcome, 'spoke');

  const posts = actionsNamed(lines, 'post');
  assert.deepEqual(
    posts.map((r: Untyped) => r.phase),
    ['started', 'succeeded']
  );
  const [started, succeeded] = posts;
  assert.equal(started.opId, succeeded.opId);
  assert.equal(started.by, 'persona');
  assert.equal(started.turnId, result.turnId);
  assert.deepEqual(started.intent, { replyTo: 'm1', text: 'γεια σου Αλίκη' });
  assert.deepEqual(started.scope, { channel: 'c1' });
  assert.deepEqual(succeeded.result, { messageId: 'sent-1' });
  assert.ok(linesAtSend[0].includes('action:post:started'));
  assert.ok(!linesAtSend[0].includes('action:post:succeeded'));

  const reacts = actionsNamed(lines, 'react');
  assert.deepEqual(
    reacts.map((r: Untyped) => r.phase),
    ['started', 'succeeded']
  );
  assert.equal(reacts[0].by, 'persona');
  assert.deepEqual(reacts[1].result, { to: 'm0', emoji: '\u{1F389}' });

  const turn = lines.map(({ record }) => record).find((record) => record.kind === 'turn');
  assert.deepEqual(turn.posted, [{ opId: started.opId, messageId: 'sent-1', replyTo: 'm1' }]);
  assert.deepEqual(turn.reactions, [{ opId: reacts[0].opId, to: 'm0', emoji: '\u{1F389}' }]);
  assert.deepEqual([...turn.actions].sort(), [started.opId, reacts[0].opId].sort());
});

test('turn: a send the interface answers unknown writes unknown, a refused one failed', async () => {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
  const run = async (status: 'failed' | 'unknown', code: string) => {
    freshWorld();
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    world().failSends(undefined, code, status);
    const { journal, lines } = journalOverMemory();
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: fakeHot({}),
      store: fakeStore(),
      llm: fakeLlm('<msg reply="#1">Ζωή</msg>'),
      calibrator: identityCalibrator(),
      client: fakeClient(),
      journal,
    });
    const { result } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
    );
    return { result, lines };
  };

  // The request may have reached the platform: the interface answers `unknown`, and the post is never retried.
  const lost = await run('unknown', 'timeout');
  const posts = actionsNamed(lost.lines, 'post');
  assert.deepEqual(
    posts.map((r: Untyped) => r.phase),
    ['started', 'unknown']
  );
  assert.equal(posts[0].opId, posts[1].opId);
  const turn = lost.lines.map(({ record }) => record).find((record) => record.kind === 'turn');
  assert.deepEqual(turn.posted, []);
  assert.deepEqual(turn.actions, [posts[0].opId]);

  // The platform answered with a refusal: a known failure with its code.
  const failed = actionsNamed((await run('failed', 'http-403')).lines, 'post');
  assert.deepEqual(
    failed.map((r: Untyped) => r.phase),
    ['started', 'failed']
  );
  assert.deepEqual(failed[1].result, { code: 'http-403' });
});

test('turn: the link reading step writes action records with by engine', async () => {
  const hot = lookupHot();
  const llm = lookupLlm('none');
  const lookup = fakeLookup({ reads: { 'm1#e0': 'une recette, trois œufs' } });
  const messages = [
    linkRaw('m1', NOW - 5000, [PAGE_EMBED]),
    rawMessage({ id: 'm2', ts: NOW - 1000, authorName: 'Zoë', content: 'ποιος κέρδισε τον τελικό;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: messages });
  const { journal, lines } = journalOverMemory();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup,
    journal,
  });

  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(messages[1]),
    triggerKind: 'mention',
  });
  assert.equal(result.outcome, 'spoke');

  const reads = actionsNamed(lines, 'read-link');
  assert.deepEqual(
    reads.map((r: Untyped) => r.phase),
    ['started', 'succeeded']
  );
  assert.equal(reads[0].by, 'engine');
  assert.equal(reads[0].turnId, result.turnId);
  assert.deepEqual(reads[0].input, { hosts: ['example.org'] });
  assert.deepEqual(reads[1].result, {
    hosts: ['example.org'],
    chars: 'une recette, trois œufs'.length,
    delivered: true,
  });

  const turn = lines.map(({ record }) => record).find((record) => record.kind === 'turn');
  assert.ok(turn.actions.includes(reads[0].opId));
  // Every operation is closed.
  const opened = lines.filter(({ record }) => record.phase === 'started').map(({ record }) => record.opId);
  const closed = new Set(
    lines
      .filter(({ record }) => record.kind === 'action' && record.phase !== 'started')
      .map(({ record }) => record.opId)
  );
  assert.ok(opened.every((opId) => closed.has(opId)));
});

test('turn: pulled lines appear in seen.pulled', async () => {
  const scene = pullScene({ features: {} });
  const { journal, lines } = journalOverMemory();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: scene.hot,
    store: scene.store,
    llm: scene.llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    imageFetcher: fakeImageFetcher(),
    now: () => NOW,
    journal,
  });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' })
  );
  assert.equal(result.outcome, 'spoke');
  assert.ok(channelViewOf(scene.llm), 'the request carries <channel_view>');

  const turn = lines.map(({ record }) => record).find((record) => record.kind === 'turn');
  assert.deepEqual(turn.seen.pulled, [{ channelId: DIARY, messageIds: ['d1', 'd2'] }]);
  assert.deepEqual(turn.seen.messageIds, ['m1', 'm9', 'd1', 'd2']);
  assert.deepEqual(turn.sourceMessageIds, turn.seen.messageIds);
  assert.ok(turn.participants.includes('u3'), 'the pulled lines name their authors');
});

// ---- the record (src/memory/record.ts): the persona's posted lines ----

test('turn: a successful post writes a said line', async () => {
  const earlier = rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Zoé', ts: NOW - 5000, content: 'καλημέρα' });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [earlier, raw] });
  const appended: Array<{ guildId: Untyped; lines: Untyped; opts: Untyped }> = [];
  const record = {
    append: async (guildId: string, lines: Untyped, opts: unknown) => {
      appended.push({ guildId, lines, opts });
      return { written: lines.length, duplicates: 0 };
    },
  };
  const { journal, lines } = journalOverMemory();
  const hot = fakeHot();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm: fakeLlm('<msg reply="#2">γεια σου Αλίκη</msg>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    journal,
    record,
  });

  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  assert.equal(result.outcome, 'spoke');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].guildId, 'g1');
  assert.deepEqual(appended[0].opts, {});
  const [said] = appended[0].lines;
  const succeeded = lines
    .map(({ record: r }) => r)
    .find((r) => r.kind === 'action' && r.name === 'post' && r.phase === 'succeeded');
  assert.equal(said.kind, 'said');
  assert.equal(said.messageId, 'sent-1');
  assert.equal(said.text, 'γεια σου Αλίκη');
  assert.equal(said.replyTo, 'm1');
  assert.deepEqual(said.mentions, []);
  assert.deepEqual(said.participants, ['u1'], 'the reply target author');
  assert.deepEqual(said.scope, { channel: 'c1' });
  assert.equal(said.turnId, result.turnId);
  assert.equal(said.opId, succeeded.opId);
});

test('turn: a post that grew past 2000 characters is posted whole and the journal lists no message-cut', async () => {
  // A member with a long id: every @handle the model wrote grows into a <@id> token when posted.
  const bobId = '123456789012345678';
  const earlier = rawMessage({ id: 'm0', authorId: bobId, authorName: 'Bob', ts: NOW - 5000, content: 'καλημέρα' });
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [earlier, raw] });
  const answer = `<msg>${'α'.repeat(1400)}${` @${handleOf(bobId)}`.repeat(100)}</msg>`;
  const { journal, lines } = journalOverMemory();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(),
    store: fakeStore(),
    llm: fakeLlm(answer),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    journal,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const expanded = 1400 + 100 * ` <@${bobId}>`.length;
  assert.equal([...postedTexts(channel).join('')].length, expanded);
  const turn = lines.find(({ record }) => record.kind === 'turn')?.record;
  assert.equal(turn.limits.filter((limit: Untyped) => limit.kind === 'message-cut').length, 0);
});

test('turn: limits lists a preview cut', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['t1', { id: 't1', contentType: 'text/plain', name: 'notes.txt', url: 'https://cdn/notes.txt' }],
    ]),
  });
  const short = rawMessage({
    id: 'm0',
    ts: NOW - 5000,
    attachments: new Map([
      ['t0', { id: 't0', contentType: 'text/plain', name: 'short.txt', url: 'https://cdn/short.txt' }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [short, raw] });
  const fetchImpl = async (url: string) => ({
    ok: true,
    headers: { get: () => null },
    // PR 7d: media.filePreviewChars is the constant 10000, so the long file is cut at that many characters.
    text: async () => (url.endsWith('notes.txt') ? 'é'.repeat(12000) : 'ένα'),
  });
  const { journal, lines } = journalOverMemory();
  const hot = fakeHot();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm: fakeLlm('<msg>ok</msg>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    fetchImpl,
    journal,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const turn = lines.find(({ record }) => record.kind === 'turn')?.record;
  assert.deepEqual(
    turn.limits.filter((limit: Untyped) => limit.kind === 'preview-cut'),
    [{ kind: 'preview-cut', where: 'm1', lost: 2000, detail: 't1' }]
  );
});

// ---------------------------------------------------------------------------
// Skills discovery: the skills a turn offers her and the catalogue.

const SKILL_TEXTS = {
  'message.create': { title: 'Στείλε', whenToUse: 'σε άλλη συζήτηση', whenNotToUse: 'όχι εδώ' },
  'message.edit': { title: 'Διόρθωσε', whenToUse: 'ένα δικό σου μήνυμα', whenNotToUse: 'όχι ξένο' },
  'message.delete': { title: 'Σβήσε', whenToUse: 'ένα δικό σου μήνυμα', whenNotToUse: 'όχι ξένο' },
};

/** Stand-ins named as operations (no operation behind them, so no requester's right to check), and an owner-only one. */
function discoveryRegistry() {
  const names = [
    'message.create',
    'message.edit',
    'message.delete',
    'message.react.add',
    'message.react.remove',
    'lore.list',
    'access.list',
  ];
  const owner = Object.freeze({
    name: 'x.owner',
    family: 'x',
    op: null,
    kind: 'read',
    ownerOnly: true,
    argsSchema: { type: 'object' },
    effects: 'read',
    sharedState: false,
    costClass: 'free',
    targets: null,
    interfaceCapability: null,
  });
  // The stand-ins name no operation with `op: null`; the loader's input type says `undefined`.
  const standIns = loadSkills(
    names.map((name) => ({
      name,
      op: null,
      argsSchema: { type: 'object' },
      effects: name.endsWith('.list') ? 'read' : 'write',
      costClass: 'free',
      targets: null,
    })) as unknown as Parameters<typeof loadSkills>[0]
  );
  return new Map([...standIns, ['x.owner', owner]]);
}

/** `bot.access` granting each of `names` to the persona (the fake client's user, `self-id`). */
function personaGrants(names: Untyped) {
  return Object.fromEntries(names.map((name: Untyped) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

/** A mention asking what the persona can do; the search classifier answers `answer`. */
async function runDiscoveryTurn({ answer, features = {}, journal = null, allowed = [] }: Record<string, Untyped> = {}) {
  const hot = lookupHot({ ...features });
  hot.prompts.lookup = 'Decide whether {{name}} needs to look something up.\n{{skills}}';
  hot.prompts.tools = SKILL_TEXTS;
  hot.config.bot = { ...hot.config.bot, access: personaGrants(allowed) };
  const store = fakeStore();
  const llm = lookupLlm(answer);
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, authorName: 'Zoë', content: 'τι μπορείς να κάνεις;' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup: fakeLookup(),
    journal,
    skills: discoveryRegistry(),
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  const reply = llm.turnCalls.length > 0 ? llm.turnCalls.at(-1)?.messages[1].content : [];
  return { result, logs, llm, reply, text: textOf(reply) };
}

test("skills discovery: a grant moves only her tools; the stable part never changes with it, and her tools are the request's field", async () => {
  const closed = await runDiscoveryTurn({ answer: 'skills: inventory' });
  const granted = await runDiscoveryTurn({ answer: 'skills: inventory', allowed: ['message.edit', 'message.delete'] });
  assert.equal(granted.reply[0].text, closed.reply[0].text, 'the stable part is byte-identical');
  const names = (run: Untyped) => run.llm.turnCalls[0].options.tools.map((tool: Untyped) => tool.function.name);
  assert.deepEqual(names(closed), ['message_create', 'message_react_add']);
  assert.deepEqual(names(granted), ['message_create', 'message_delete', 'message_edit', 'message_react_add']);
});

test('skills discovery: every turn carries the skills granted to her as tools, with no question and no proposal', async () => {
  const run = await runDiscoveryTurn({ answer: 'none', allowed: ['message.edit', 'lore.list', 'message.delete'] });
  assert.equal(run.result.outcome, 'spoke');
  const [sent] = run.llm.turnCalls;
  assert.deepEqual(
    sent.options.tools.map((tool: Untyped) => tool.function.name),
    ['lore_list', 'message_create', 'message_delete', 'message_edit', 'message_react_add']
  );
  assert.ok(!run.text.includes('<tool_catalogue>\n'), 'the detailed rows stay off without a question or a proposal'); // PR 7e: renamed
});

// ---------------------------------------------------------------------------
// The persona's lines name the message that started the turn which posted them.

/** A line of the persona as the channel holds it. */
function selfRaw(id: string, ts: number, content: string) {
  return rawMessage({ id, ts, content, authorId: 'self-id', authorName: 'Bot' });
}

/** Two questions 30 s apart, a runner over them; the LLM answers every request with two messages. */
function triggerTurnScene(features = {}) {
  const history = [
    rawMessage({ id: 'm98', ts: NOW - 60_000, authorName: 'Alice', content: 'tu viens ce soir ?' }),
    rawMessage({ id: 'm99', ts: NOW - 30_000, authorId: 'u2', authorName: 'Zoë', content: 'et le lapin ?' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: history });
  const llm = fakeLlm('<msg>ναι</msg><msg>έρχομαι</msg>');
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot({ ...features }),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });
  return { history, channel, llm, turns };
}

/** The user text of the requests from call `from` on that show the chat. */
function chatTexts(llm: Untyped, from = 0) {
  return llm.calls
    .slice(from)
    .map((messages: Untyped) => textOf(messages[1].content))
    .filter((text: Untyped) => text.includes('<chat>'));
}

test("createTurnRunner: the lines a turn posted name its trigger in the next turn's transcript", async () => {
  const { history, channel, llm, turns } = triggerTurnScene();
  const first = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(history[0]),
    triggerKind: 'mention',
  });
  assert.equal(first.outcome, 'spoke');
  assert.equal(channel.sent.length, 2);
  // Both lines of the first turn reach the channel after the second question.
  history.push(selfRaw('sent-1', NOW - 20_000, 'ναι'), selfRaw('sent-2', NOW - 19_000, 'έρχομαι'));
  const from = llm.calls.length;
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(history[1]), triggerKind: 'mention' });
  const [text] = chatTexts(llm, from);
  assert.ok(text, 'the second turn sent its reply request');
  assert.ok(text.includes('Bot (you) (turn triggered by #1): ναι'), text);
  assert.ok(
    text.includes('Bot (you) (turn triggered by #1): έρχομαι'),
    'every line of one turn carries the same trigger'
  );
});

test('createTurnRunner: a line posted by a spontaneous turn carries no trigger', async () => {
  const { history, channel, llm, turns } = triggerTurnScene();
  const first = await turns.runTurn({ channel, mode: 'interject' });
  assert.equal(first.outcome, 'spoke');
  history.push(selfRaw('sent-1', NOW - 20_000, 'ναι'));
  const from = llm.calls.length;
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(history[1]), triggerKind: 'mention' });
  const [text] = chatTexts(llm, from);
  assert.ok(text.includes('Bot (you): ναι'), text);
  assert.ok(!text.includes('triggered'), text);
});

test("createTurnRunner: links seeded at start (the journal's rebuild) survive a restart; a trigger out of the window is older", async () => {
  const { history, channel, llm, turns } = triggerTurnScene();
  history.unshift(selfRaw('sent-0', NOW - 90_000, 'πρωί'));
  history.push(selfRaw('sent-1', NOW - 20_000, 'ναι'));
  turns.seedTriggerLinks([['sent-0', 'm1'], ['sent-1', 'm98'], [null, 'm98'], ['sent-9']]);
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(history[2]), triggerKind: 'mention' });
  const [text] = chatTexts(llm);
  assert.ok(text.includes('Bot (you) (turn triggered by an older message): πρωί'), text);
  assert.ok(text.includes('Bot (you) (turn triggered by #2): ναι'), text);
});

// ---------------------------------------------------------------------------
// Every effect of a reply is checked (src/tools/gateway.ts#checkReplyEffect: carried over in the
// current conversation, refused only under the full stop) and made through the interface port.

/** One mention turn answered with `answer`, through `port` (the default Discord adapter when null). */
async function gatewayTurn({
  answer,
  features = {},
  port = null,
  skills = null,
  journal = null,
  record = null,
  store = fakeStore(),
}: Record<string, Untyped>) {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(features),
    store,
    llm: fakeLlm(answer),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
    port,
    skills,
    journal,
    record,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  return { result, logs, channel };
}

test('skills gateway: a normal reply is carried over and posted through the port exactly as before', async () => {
  const { result, channel, logs } = await gatewayTurn({ answer: `<msg reply="#1">γεια σου @${handleOf('u1')}</msg>` });
  assert.equal(result.outcome, 'spoke');
  assert.equal(
    logs.some((entry) => entry.msg === 'skill: refused'),
    false
  );
  assert.deepEqual(channel.sent, [
    {
      content: 'γεια σου <@u1>',
      reply: { messageReference: 'm1', failIfNotExists: false },
      allowedMentions: { parse: [], users: ['u1'], repliedUser: true },
    },
  ]);
  assert.equal(channel.typingCalls.length, 1, 'typed once, through the port');

  // The same reply through another interface: the same text, reply target and mentions.
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id' });
  const other = await gatewayTurn({ answer: `<msg reply="#1">γεια σου @${handleOf('u1')}</msg>`, port });
  assert.equal(other.result.outcome, 'spoke');
  const effects = effectsOf(port);
  assert.deepEqual(
    effects.map((call: Untyped) => call.op),
    ['typing', 'send']
  );
  assert.deepEqual(effects[1].args, [
    { iface: 'fake', conversationId: 'c1' },
    {
      text: 'γεια σου <@u1>',
      replyTo: { iface: 'fake', conversationId: 'c1', messageId: 'm1' },
      mentions: { users: ['u1'], repliedUser: true },
    },
  ]);
  assert.equal(other.channel.sent.length, 0, 'nothing went around the port');
});

test('skills gateway: her reply needs no grant and no skill in the registry -- an empty registry changes nothing', async () => {
  const { result, channel, logs } = await gatewayTurn({
    answer: '<msg>γεια</msg><react to="#1">\u{1F389}</react>',
    skills: new Map(),
  });
  assert.deepEqual([result.outcome, result.delivered], ['spoke', true]);
  assert.equal(channel.sent.length, 1);
  assert.equal(
    logs.some((entry) => entry.msg === 'skill: refused'),
    false
  );
});

test('skills gateway: a send the port answers unknown is journaled unknown, never retried and never counted as posted', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id' });
  port.failNext('send', { status: 'unknown', error: { code: 'timeout', retryable: false } });
  const { journal, lines } = journalOverMemory();
  const said: Array<Array<Untyped>> = [];
  const record = { append: async (...args: Array<unknown>) => said.push(args) };
  const { result, logs } = await gatewayTurn({
    answer: '<msg>ένα</msg><msg>δύο</msg>',
    features: {},
    port,
    journal,
    record,
  });
  assert.deepEqual([result.outcome, result.delivered], ['spoke', false]);
  assert.equal(
    port.calls.filter((call) => call.op === 'send').length,
    1,
    'neither that message nor the next one was sent again'
  );
  const posts = actionsNamed(lines, 'post');
  assert.deepEqual(
    posts.map((r: Untyped) => r.phase),
    ['started', 'unknown']
  );
  const turn = lines.map(({ record: r }) => r).find((r) => r.kind === 'turn');
  assert.deepEqual(turn.posted, []);
  assert.deepEqual(said, [], 'no said line');
  assert.ok(logs.some((entry) => entry.msg === 'turn: send failed'));
  assert.equal(
    logs.some((entry) => entry.msg === 'turn: sent'),
    false
  );
});

test('skills gateway: the GIF and the drawing are published through the port', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id' });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'draw me a cat' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const images = fakeImages();
  const turns = createTurnRunner({
    discord: DISCORD,
    hot: drawHot(),
    store: gifStore(),
    llm: sequenceLlm([toolAnswer('<gif>g1</gif>', [call('draw.create', { reply: '#1', text: 'a cat on a roof' })])]),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images,
    imageFetcher: fakeImageFetcher(),
    port,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  assert.deepEqual([result.outcome, result.delivered], ['spoke', true]);
  assert.equal(channel.sent.length, 0, 'nothing went around the port');
  const sends = port.calls.filter((call) => call.op === 'send').map((call) => call.args[1]);
  assert.equal(sends.length, 2);
  const [picture, gif] = sends;
  assert.deepEqual(
    gif,
    { text: 'https://tenor.com/view/chat-qui-danse-1' },
    'the GIF as its URL, mentions none, after the picture her call made'
  );
  assert.equal(asRecord(picture).attachments.length, 1);
  assert.equal(asRecord(picture).attachments[0].name, 'image.png');
  assert.ok(Buffer.isBuffer(asRecord(picture).attachments[0].data));
  assert.deepEqual(asRecord(picture).replyTo, { iface: 'fake', conversationId: 'c1', messageId: 'm1' });
  assert.equal('mentions' in asRecord(picture), false);
  assert.equal(images.generateCalls.length, 1);
  assert.ok(logs.some((entry) => entry.msg === 'turn: gif sent'));
  assert.ok(logs.some((entry) => entry.msg === 'turn: drew'));
});

// ---------------------------------------------------------------------------
// Skill calls (src/tools/executors.ts): her skills are the /nep commands; one `<call>` per turn,
// checked, run after the reply's own effects through the command's own path (a real admin over
// the same fake port), and one follow-up request with its result when she needs it.

/** The actions of the journal named `skill`, their phases in order. */
function skillPhases(lines: unknown) {
  return actionsNamed(lines, 'skill').map((record: Untyped) => record.phase);
}

/**
 * A mention by Alice (u1, #2) after a line of the persona (#1) in #general (c1), with #νέα (c9,
 * where the bot may do anything) and #αλλού (c8, where it may not send) in the guild; no
 * `tools.conversations` list; the LLM answers `answers` in
 * order; `allowed` skills are granted to her (her user id in bot.access); `owners` are the bot's
 * owners (Alice by default: the owner asks); the port is a fake adapter, the operations run on a
 * real admin over it; `emoji`: the server's custom emoji index, none by default; `later`: raw
 * messages that reach #general once the LLM has answered the first request; `labelSet`: the
 * labels in place of the fixture's.
 */
async function callTurn({
  answers,
  allowed = [],
  features = {},
  tools = {},
  owners = ['u1'],
  images = null,
  journal = null,
  store = fakeStore(),
  beforeSend = null,
  failNext = null,
  diary = null,
  configExtra = {},
  turnExtra = {},
  emoji = null,
  later = [],
  labelSet = null,
}: Record<string, Untyped>) {
  const history = [
    rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'self-id', authorName: 'Bot', content: 'πρώτη' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, authorId: 'u1', authorName: 'Alice', content: 'γράψε στο #νέα' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: history });
  fakeTurnChannel({ id: 'c9', name: '💖νέα' });
  fakeTurnChannel({ id: 'c8', name: 'αλλού', permissions: { send: false } });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  if (failNext) port.failNext(...(failNext as Parameters<typeof port.failNext>));
  const hot = fakeHot(
    { typingSimulation: false, journal: Boolean(journal), ...features },
    { owners, access: personaGrants(allowed) },
    { tools: { safeMode: false, resultMaxChars: 2000, ...tools }, ...configExtra }
  );
  hot.prompts.draw = 'Drawing for {{name}}.\n\n{{request}}';
  if (labelSet) hot.prompts.labels = labelSet;
  if (beforeSend) {
    const send = port.send.bind(port);
    port.send = async (...args) => {
      await beforeSend({ hot, store }, args);
      return send(...args);
    };
  }
  const client = fakeClient();
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    getGuildId: () => 'g1',
    reads: world().adopt(port),
    port,
    ...(images ? { images } : {}),
    ...(diary ? { diary: diary(hot) } : {}),
  });
  const llm = sequenceLlm(answers);
  const complete = llm.complete;
  llm.complete = async (...args) => {
    const answer = await complete(...args);
    if (llm.calls.length === 1) history.push(...later);
    return answer;
  };
  const turns = createTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client,
    now: () => NOW,
    port,
    skills: skillRegistry(),
    journal,
    images,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    ...(emoji ? { emoji } : {}),
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'reply',
      trigger: normalizedTrigger(history[1]),
      triggerKind: 'mention',
      ...turnExtra,
    })
  );
  const sends = port.calls
    .filter((call) => call.op === 'send')
    .map((call): Record<string, Untyped> => ({ to: asRecord(call.args[0]).conversationId, ...asRecord(call.args[1]) }));
  return { result, logs, llm, port, sends, channel, store, hot };
}

/** The user text of the LLM's call `i`. */
function requestText(llm: Untyped, i: number): string {
  return textOf(llm.calls[i][1].content);
}

/** The text of a message's content, parts joined. */
function contentOf(message: Untyped): string {
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part: Untyped) => part.text ?? '').join('');
}

/** What she read of her call number `n` (0-based) in request `i`: the content of its tool message. */
function followUpTool(llm: Untyped, i: number, n = 0): string {
  const message = llm.calls[i].filter((item: Untyped) => item.role === 'tool')[n];
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part: Untyped) => part.text ?? '').join('');
}

test('skill call: message.create to another channel where the bot may send runs before her reply, journaled proposed, started, succeeded, with its invocation id; it covers her speech, so no step follows', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await callTurn({
    answers: [
      toolAnswer('<msg reply="#2">εντάξει</msg>\n', [
        call('message.create', { channel: '#🍡νέα', text: 'καλημέρα :wave:' }),
      ]),
      '<skip/>',
    ],
    allowed: ['message.create'],
    journal,
  });
  assert.deepEqual([run.result.outcome, run.result.delivered], ['spoke', true]);
  assert.deepEqual(
    run.sends.map((send) => [send.to, send.text]),
    [
      ['c9', 'καλημέρα :wave:'],
      ['c1', 'εντάξει'],
    ],
    'her call runs first, her speech after it'
  );
  assert.deepEqual(run.sends[0].mentions, { users: [], repliedUser: false }, 'nobody is notified');
  assert.equal(run.llm.calls.length, 1, 'a post that went out needs no reading: no step');
  assert.deepEqual(skillPhases(lines), ['proposed', 'started', 'succeeded']);
  const actions = actionsNamed(lines, 'skill');
  assert.match(actions[0].input.invocationId, /^[0-9a-f-]{36}$/, 'the invocation id is kept with its state');
  assert.match(actions[0].input.toolCallId, /^s1c1$/, 'and the id of her tool call');
  const started = actions.find((record: Untyped) => record.phase === 'started');
  assert.equal(started.target.channel, 'c9');
  assert.ok(!JSON.stringify(actions).includes('καλημέρα'), 'the journal names ids, never the text');
  const turn = lines.map(({ record }) => record).find((record) => record.kind === 'turn');
  assert.ok(turn.actions.includes(started.opId));
  assert.ok(
    run.logs.some(
      (entry) => entry.msg === 'skills: called' && entry.skill === 'message.create' && entry.status === 'ok'
    )
  );
});

test('skill call: her message.create and message.edit text goes out like a <msg> -- a handle pings, a name, an unknown handle and @everyone stay text and ping nobody; custom emoji, #N and channel links', async () => {
  const alice = `@${handleOf('u1')}`;
  const unknown = alice === '@uzzzz' ? '@u0000' : '@uzzzz';
  const written = `${alice} @Alice ${unknown} @everyone :dance: #2 #αλλού`;
  const rendered = `<@u1> @Alice ${unknown} @everyone <a:dance:222222222222222222> https://discord.com/channels/g1/c1/m1 <#c8>`;
  const created = await callTurn({
    answers: [toolAnswer(``, [call('message.create', { channel: `#νέα`, text: `${written}` })])],
    allowed: ['message.create'],
    emoji: fakeEmojiIndex(),
  });
  assert.equal(created.result.outcome, 'spoke');
  assert.deepEqual(
    created.sends.map((send) => [send.to, send.text]),
    [['c9', rendered]]
  );
  assert.deepEqual(
    created.sends[0].mentions,
    { users: ['u1'], repliedUser: false },
    'only the resolved member is notified'
  );
  // A reply keeps working, its author notified as before.
  const replied = await callTurn({
    answers: [toolAnswer(``, [call('message.create', { reply: `#2`, text: `${alice} :dance:` })])],
    emoji: fakeEmojiIndex(),
  });
  assert.deepEqual(
    replied.sends.map((send) => [send.to, send.text, send.replyTo?.messageId, send.mentions]),
    [['c1', '<@u1> <a:dance:222222222222222222>', 'm1', { users: ['u1'], repliedUser: true }]]
  );
  // Pings off: the mention stays in the text and notifies nobody.
  const quiet = await callTurn({
    answers: [toolAnswer(``, [call('message.create', { channel: `#νέα`, text: `${alice}` })])],
    allowed: ['message.create'],
    store: storeWithPingsOff(['u1']),
  });
  assert.deepEqual(
    quiet.sends.map((send) => [send.text, send.mentions]),
    [['<@u1>', { users: [], repliedUser: false }]]
  );
  // The edit path: the same rendering, the same mentions.
  const edited = await callTurn({
    answers: [toolAnswer(``, [call('message.edit', { message: `#1`, text: `${written}` })]), '<skip/>'],
    allowed: ['message.edit'],
    emoji: fakeEmojiIndex(),
  });
  const edits = edited.port.calls
    .filter((call) => call.op === 'edit')
    .map((call) => [asRecord(call.args[0]).messageId, call.args[1]]);
  assert.deepEqual(edits, [['m0', { text: rendered, mentions: { users: ['u1'], repliedUser: false } }]]);
  assert.equal(edited.llm.calls.length, 1, 'an edit that went out needs no reading');
});

test('skill call: a quiet success in an addressed turn ends the turn: no step, nothing more to say; her speech goes out after it', async () => {
  const addressed = await callTurn({
    answers: [toolAnswer('', [call('message.edit', { message: '#1', text: 'διορθωμένη' })]), '<skip/>'],
    allowed: ['message.edit'],
  });
  assert.equal(addressed.result.outcome, 'spoke');
  assert.equal(addressed.llm.calls.length, 1);
  assert.deepEqual(addressed.sends, []);
  assert.equal(addressed.result.delivered, true, 'the edit went out');
  const task = {
    id: 'tabc',
    agent: 'scout',
    state: 'done',
    goal: 'find a meme',
    requester: { userId: null, kind: 'persona' },
    origin: { channelId: 'c1', messageId: null },
    result: { text: 'found', files: [] },
  };
  const spontaneous = await callTurn({
    answers: [
      toolAnswer('<msg>κι αυτό</msg>', [call('message.create', { channel: '#🍡νέα', text: 'να το' })]),
      '<msg>δεν θα ειπωθεί</msg>',
    ],
    allowed: ['message.create'],
    turnExtra: { mode: 'interject', trigger: null, triggerKind: 'errand', taskResult: task },
  });
  assert.equal(spontaneous.llm.calls.length, 1);
  assert.deepEqual(
    spontaneous.sends.map((send) => send.text),
    ['να το', 'κι αυτό']
  );
});

test('skill call: a call alone is no skip; here it needs no grant and replies to a line of this conversation', async () => {
  const here = await callTurn({ answers: [toolAnswer('', [call('message.create', { reply: '#2', text: 'ναι' })])] });
  assert.equal(here.result.outcome, 'spoke');
  // The current conversation: carried over, the replied author notified.
  assert.deepEqual(
    here.sends.map((send) => [send.to, send.text, send.replyTo?.messageId, send.mentions.repliedUser]),
    [['c1', 'ναι', 'm1', true]]
  );
  // A reply target outside the channel she named: the line's own channel wins, the call posts there, never refused.
  const across = await callTurn({
    answers: [
      toolAnswer('', [call('message.create', { channel: '#νέα', reply: '#2', text: 'ναι' })]),
      '<msg>όχι τελικά</msg>',
    ],
    allowed: ['message.create'],
  });
  assert.deepEqual(
    across.sends.map((send) => [send.to, send.text]),
    [['c1', 'ναι']]
  );
});

test('skill call: not granted, or a channel where the bot may not send -- refused with a result, her speech held; the corrected call and her words go out in the next answer', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await callTurn({
    answers: [
      toolAnswer('<msg>μισό</msg>', [call('message.create', { channel: '#νέα', text: 'γεια' })]),
      toolAnswer('<msg>δεν μπορώ εκεί</msg>', [call('message.create', { text: 'ξανά' })]),
    ],
    journal,
  });
  assert.deepEqual(
    run.sends.map((send) => [send.to, send.text]),
    [
      ['c1', 'ξανά'],
      ['c1', 'δεν μπορώ εκεί'],
    ],
    'the held "μισό" never went out'
  );
  assert.equal(run.llm.calls.length, 2, 'one more request, no third');
  const followUp = run.llm.calls[1];
  const first = run.llm.calls[0];
  assert.deepEqual(followUp[0], first[0], 'the same system prompt');
  assert.equal(followUp[1], first[1], 'the first user message is the same object');
  assert.equal(
    followUpTool(run.llm, 1),
    fill(labels.tools.result.refused, { reason: labels.tools.result.reasons['not-allowed'] })
  );
  assert.deepEqual(skillPhases(lines), ['proposed', 'failed', 'proposed', 'started', 'succeeded']);
  assert.equal(actionsNamed(lines, 'skill')[1].result.code, 'not-allowed');

  // Granted, but the bot may not send in that channel: the operation's own rule, its own words.
  const closed = await callTurn({
    answers: [toolAnswer('', [call('message.create', { channel: '#αλλού', text: 'γεια' })]), '<skip/>'],
    allowed: ['message.create'],
  });
  assert.deepEqual(closed.sends, []);
  const text = followUpTool(closed.llm, 1);
  assert.ok(
    text.startsWith(
      fill(labels.tools.result.refused, { reason: labels.tools.result.reasons['channel-no-permission'] })
    ),
    text
  );
  assert.ok(text.includes('channel c8'), text);
});

test('skill call: edit and delete reach only her own message', async () => {
  const edited = await callTurn({
    answers: [toolAnswer('', [call('message.edit', { message: '#1', text: 'πρώτη, διορθωμένη' })]), '<skip/>'],
    allowed: ['message.edit'],
  });
  assert.deepEqual(
    edited.port.calls
      .filter((call) => call.op === 'edit')
      .map((call) => [asRecord(call.args[0]).messageId, asRecord(call.args[1]).text]),
    [['m0', 'πρώτη, διορθωμένη']]
  );
  assert.equal(edited.llm.calls.length, 1);
  const deleted = await callTurn({
    answers: [toolAnswer('', [call('message.delete', { message: '#1' })]), '<skip/>'],
    allowed: ['message.delete'],
  });
  assert.deepEqual(
    deleted.port.calls.filter((call) => call.op === 'delete').map((call) => asRecord(call.args[0]).messageId),
    ['m0']
  );
  for (const answer of [
    toolAnswer('', [call('message.edit', { message: '#2', text: 'όχι' })]),
    toolAnswer('', [call('message.delete', { message: '#2' })]),
  ]) {
    const run = await callTurn({ answers: [answer, '<skip/>'], allowed: ['message.edit', 'message.delete'] });
    assert.deepEqual(
      run.port.calls.filter((call) => call.op === 'edit' || call.op === 'delete'),
      [],
      String(answer)
    );
    const reason = fill(labels.transcript.callReasons['not-own-message'], { arg: 'message' });
    assert.equal(
      followUpTool(run.llm, 1),
      fill(labels.tools.result.refused, { reason }),
      'she reads whose message it was not'
    );
  }
});

test('skill call: the result turn of her own errand (requester kind persona, nobody behind it) is her own initiative: her grants decide, no requester-denied', async () => {
  const task = {
    id: 'tabc',
    agent: 'scout',
    state: 'done',
    goal: 'find a meme',
    requester: { userId: null, kind: 'persona' },
    origin: { channelId: 'c1', messageId: null },
    result: { text: 'found', files: [] },
  };
  const answer = toolAnswer('', [call('message.create', { channel: '#🍡νέα', text: 'να το' })]);
  // Without an origin message the turn is an interjection with a task result: her call runs.
  const own = await callTurn({
    answers: [answer, '<skip/>'],
    allowed: ['message.create'],
    turnExtra: { mode: 'interject', trigger: null, triggerKind: 'errand', taskResult: task },
  });
  assert.deepEqual(
    own.sends.map((send) => [send.to, send.text]),
    [['c9', 'να το']],
    String(own.logs.filter((e) => e.msg === 'skills: called').map((e) => e.code))
  );
  // The same turn without the persona requester (the errand's origin lost its kind) is nobody's: a write is refused `no-requester`.
  const nobody = await callTurn({
    answers: [answer, '<skip/>'],
    allowed: ['message.create'],
    turnExtra: {
      mode: 'interject',
      trigger: null,
      triggerKind: 'errand',
      taskResult: { ...task, requester: { userId: null, kind: 'member' } },
    },
  });
  assert.deepEqual(nobody.sends, [], 'no requester, no write');
});

test("skill call: a read brings the operation's answer back in one more request; a member without the right is refused before it runs", async () => {
  const store = fakeStore({ loreEntries: [] });
  const run = await callTurn({
    answers: [toolAnswer('', [call('lore.list')]), '<msg>τίποτα</msg>'],
    allowed: ['lore.list'],
    store,
  });
  assert.equal(run.llm.calls.length, 2);
  assert.ok(followUpTool(run.llm, 1).startsWith(labels.tools.result.ok), followUpTool(run.llm, 1));
  assert.ok(
    !run.llm.calls[0].some((message: Untyped) => message.role === 'tool'),
    'the first request carries no result'
  );
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['τίποτα']
  );
  // Alice not an owner and not granted lore.list: refused before anything runs, and told so.
  const denied = await callTurn({
    answers: [toolAnswer('', [call('lore.list')]), '<skip/>'],
    allowed: ['lore.list'],
    owners: [],
    store,
  });
  assert.equal(
    followUpTool(denied.llm, 1),
    fill(labels.tools.result.refused, { reason: labels.tools.result.reasons['requester-denied'] })
  );
});

test('skill call: a turn answering several people runs no write', async () => {
  const run = await callTurn({
    answers: [toolAnswer('', [call('message.create', { channel: '#νέα', text: 'γεια' })]), '<skip/>'],
    allowed: ['message.create'],
    turnExtra: {
      missed: [
        { author: 'Alice', text: 'γράψε στο #νέα' },
        { author: 'Zoë', text: 'κι εγώ' },
      ],
    },
  });
  assert.deepEqual(run.sends, []);
  assert.ok(run.logs.some((entry) => entry.msg === 'skill: refused' && entry.reason === 'mixed-requesters'));
});

test('skill call: safe mode lets only the carried-over reply through', async () => {
  const safe = await callTurn({
    answers: [
      toolAnswer('<msg>γεια</msg>', [call('message.create', { channel: '#νέα', text: 'γεια' })]),
      '<msg>μόνο εδώ</msg>',
    ],
    allowed: ['message.create'],
    tools: { safeMode: true },
  });
  assert.deepEqual(
    safe.sends.map((send) => send.to),
    ['c1'],
    'the post elsewhere was refused, her words here go out in the next answer'
  );
  assert.ok(safe.logs.some((entry) => entry.msg === 'skill: refused' && entry.code === 'safe-mode'));
  assert.deepEqual(
    safe.llm.options[0].tools.map((tool: Untyped) => tool.function.name),
    // PR 7d: features.speech is code, so voice.say is carried over beside the others.
    ['draw_create', 'message_create', 'message_react_add', 'voice_say'],
    'safe mode exposes the carried-over ones alone'
  );
});

test('skill call: draw.create elsewhere generates once and the operation posts it there; a post of unknown fate is unknown, never redone', async () => {
  const withFamily = <TImages extends object>(images: TImages) => Object.assign(images, { familyOf: () => 'fake' });
  const images = withFamily(fakeImages());
  const { journal, lines } = journalOverMemory();
  const run = await callTurn({
    answers: [
      toolAnswer('', [call('draw.create', { channel: '#νέα', text: 'a lighthouse at dusk' })]),
      '<msg>δεν ξέρω αν βγήκε</msg>',
    ],
    allowed: ['draw.create'],
    images,
    journal,
    failNext: ['send', { status: 'unknown', error: { code: 'timeout', retryable: false } }],
  });
  assert.equal(images.generateCalls.length, 1);
  assert.deepEqual(skillPhases(lines), ['proposed', 'started', 'unknown']);
  assert.equal(run.port.calls.filter((call) => call.op === 'send').length, 2, 'the picture once, then her answer here');
  assert.ok(followUpTool(run.llm, 1).startsWith(labels.tools.result.unknown.split(':')[0]), followUpTool(run.llm, 1));

  const delivered = await callTurn({
    answers: [toolAnswer('', [call('draw.create', { channel: '#νέα', text: 'a lighthouse' })]), '<skip/>'],
    allowed: ['draw.create'],
    images: withFamily(fakeImages()),
  });
  assert.deepEqual(
    delivered.sends.map((send) => [send.to, send.attachments.length]),
    [['c9', 1]]
  );
  assert.equal(delivered.llm.calls.length, 1, 'a picture that went out needs no reading');
});

test('skill call: a call that did not work comes back as a result with its reason, her speech is held, the corrected call goes through and the journal keeps both', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await callTurn({
    // The live failure: a deletion announced, called without the message to delete.
    answers: [
      toolAnswer('<msg>σβήνω και το ξαναγράφω</msg>', [call('message.delete')]),
      toolAnswer('<msg>έσβησα το πρώτο</msg>', [call('message.delete', { message: '#1' })]),
    ],
    allowed: ['message.delete'],
    journal,
  });
  assert.equal(run.result.outcome, 'spoke');
  assert.equal(run.llm.calls.length, 2, 'one more request, never a third');
  const reason = fill(labels.transcript.callReasons['missing-arg'], { arg: 'message' });
  assert.equal(followUpTool(run.llm, 1), fill(labels.tools.result.refused, { reason }), 'she reads what was missing');
  assert.deepEqual(
    run.port.calls.filter((call) => call.op === 'delete').map((call) => asRecord(call.args[0]).messageId),
    ['m0'],
    'the corrected call ran'
  );
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['έσβησα το πρώτο'],
    'the announcement of the first answer was held, never posted'
  );
  assert.deepEqual(skillPhases(lines), ['proposed', 'failed', 'proposed', 'started', 'succeeded']);
  // The journal: the one turn record, the failure with its reason; the call's mark rebuilt from it covers the post.
  const records = lines.map(({ record }) => record);
  const turn = records.find((record) => record.kind === 'turn');
  assert.equal(turn.posted.length, 1);
  assert.equal(turn.steps, 1);
  const failed = actionsNamed(lines, 'skill')[1];
  assert.deepEqual(
    [failed.result.code, failed.result.status, failed.result.reason],
    ['invalid-args', 'invalid', 'args.message:required']
  );
  const marks = callMarksOf(records).calls;
  assert.deepEqual(
    marks.map((mark) => asRecord(mark).status),
    ['invalid', 'ok']
  );
});

test("skill call: the next request shows a read's data as its tool message, a message that came meanwhile as a numbered line in the note, the cached parts unchanged", async () => {
  const store = fakeStore({ loreEntries: [] });
  const meanwhile = rawMessage({ id: 'm2', ts: NOW - 500, authorId: 'u2', authorName: 'Zoë', content: 'κι εγώ θέλω' });
  const run = await callTurn({
    answers: [toolAnswer('<msg>κοιτάζω</msg>', [call('lore.list')]), '<msg>τίποτα ακόμα</msg>'],
    allowed: ['lore.list'],
    store,
    later: [meanwhile],
  });
  assert.equal(run.llm.calls.length, 2);
  // The prompt cache: the system prompt and the whole first user message are the previous request's, not rebuilt.
  assert.equal(run.llm.calls[1][0], run.llm.calls[0][0], 'the same system prompt');
  assert.equal(run.llm.calls[1][1], run.llm.calls[0][1], 'the same user message');
  assert.ok(
    !requestText(run.llm, 1).includes('κι εγώ θέλω'),
    'it came after the first request; the message itself is not rebuilt'
  );
  const [assistant, tool, note] = run.llm.calls[1].slice(2);
  assert.equal(assistant.content, '<msg>κοιτάζω</msg>');
  assert.ok(contentOf(tool).startsWith(labels.tools.result.ok), contentOf(tool));
  const noteText = contentOf(note);
  assert.ok(noteText.includes(labels.task.step.held), noteText);
  assert.match(noteText, /#\d+ \[[^\]]*\] Zoë: κι εγώ θέλω/);
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['τίποτα ακόμα']
  );
});

// ---------------------------------------------------------------------------
// Call marks (src/format.ts#withCalls): a later turn's transcript shows the skill calls
// she made on her lines of the turn that made them, in the channel where she made them.

/**
 * callTurn's scene on one runner kept across turns: #general (c1) with Alice's mention, #💖νέα
 * (c9); the clock settable; `run(channel, raw)` runs one mention turn; `runner()` a fresh runner
 * on the same port, as after a restart.
 */
function callMarkScene({
  answers,
  allowed = ['message.create'],
  features = {},
  journal = null,
}: Record<string, Untyped>) {
  const history = [
    rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'self-id', authorName: 'Bot', content: 'πρώτη' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, authorId: 'u1', authorName: 'Alice', content: 'γράψε στο #νέα' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: history });
  const news = fakeTurnChannel({ id: 'c9', name: '💖νέα', historyMessages: [] });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const hot = fakeHot(
    { typingSimulation: false, journal: Boolean(journal), ...features },
    { owners: ['u1'], access: personaGrants(allowed) },
    { tools: { safeMode: false, resultMaxChars: 2000 } }
  );
  const store = fakeStore();
  const client = fakeClient();
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    getGuildId: () => 'g1',
    reads: world().adopt(port),
    port,
  });
  const llm = sequenceLlm(answers);
  const clock = { ms: NOW };
  const runner = () =>
    createTurnRunner({
      discord: DISCORD,
      hot,
      store,
      llm,
      calibrator: identityCalibrator(),
      client,
      now: () => clock.ms,
      port,
      skills: skillRegistry(),
      journal,
      runOp: admin.runSkillOp,
      runOwnOp: admin.runOwnSkillOp,
    });
  const turns = runner();
  const run = (where: unknown, raw: Untyped, on = turns) =>
    withCapturedLogs(() =>
      on.runTurn({ channel: where, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
    );
  return { history, channel, news, port, llm, clock, turns, runner, run };
}

/** Her own line of `c` as the fake port holds it, as a raw message of that channel. */
function ownRaw(port: Untyped, channelId: string, ts: number) {
  const [message] = port
    .messagesIn(channelId)
    .filter((m: Untyped) => m.authorId === 'self-id' && !['m0'].includes(m.ref.messageId));
  return {
    ...rawMessage({ id: message.ref.messageId, ts, authorId: 'self-id', authorName: 'Bot', content: message.text }),
    channelId,
  };
}

/** The `<chat>` block of the LLM's last request. */
function lastChat(llm: Untyped) {
  const text = textOf(llm.calls.at(-1)[1].content);
  return text.slice(text.indexOf('<chat>'), text.indexOf('</chat>'));
}

test('call marks: a later turn shows the call on her last line of the turn that made it, the post elsewhere linked; the post there names where it came from', async () => {
  const scene = callMarkScene({
    answers: [
      toolAnswer('<msg reply="#2">εντάξει</msg>\n', [call('message.create', { channel: '#🍡νέα', text: 'καλημέρα' })]),
      '<skip/>',
    ],
  });
  const first = await scene.run(scene.channel, scene.history[1]);
  assert.equal(first.result.outcome, 'spoke');
  const [posted] = scene.port.calls.filter((call) => call.op === 'send');
  assert.equal(asRecord(posted.args[0]).conversationId, 'c9', 'her call ran first');
  const here = ownRaw(scene.port, 'c1', NOW);
  const there = ownRaw(scene.port, 'c9', NOW);
  scene.clock.ms = NOW + 60_000;
  const m2 = rawMessage({ id: 'm2', ts: NOW + 30_000, authorName: 'Alice', content: 'και;' });
  scene.history.push(here, m2);
  await scene.run(scene.channel, m2);
  const chat = lastChat(scene.llm);
  const line = chat.split('\n').find((text) => text.includes('εντάξει'));
  assert.ok(
    line?.endsWith(`[called message.create in #💖νέα: done, posted as https://discord.com/channels/g1/c9/${there.id}]`),
    chat
  );
  assert.equal(chat.match(/\[called /g)?.length, 1, chat);

  // In #💖νέα her post says which channel's turn posted it; the call itself is not shown there.
  const n1 = { ...rawMessage({ id: 'n1', ts: NOW + 30_000, authorName: 'Alice', content: 'γεια' }), channelId: 'c9' };
  world().seed('c9', [there, n1]);
  await scene.run(scene.news, n1);
  const newsChat = lastChat(scene.llm);
  assert.ok(
    newsChat.includes('Bot (you) (posted from #general) (turn triggered by an older message): καλημέρα'),
    newsChat
  );
  assert.ok(!newsChat.includes('[called '), newsChat);
});

test('call marks: a turn that only called shows the call as a line of hers at its time, after the last line before it', async () => {
  const scene = callMarkScene({
    answers: [toolAnswer('', [call('message.create', { channel: '#🍡νέα', text: 'γεια' })]), '<skip/>'],
  });
  await scene.run(scene.channel, scene.history[1]);
  const there = ownRaw(scene.port, 'c9', NOW);
  scene.clock.ms = NOW + 60_000;
  const m2 = rawMessage({ id: 'm2', ts: NOW + 30_000, authorName: 'Alice', content: 'και;' });
  scene.history.push(m2);
  await scene.run(scene.channel, m2);
  const chat = lastChat(scene.llm);
  const standalone = `[12:00] Bot (you): [called message.create in #💖νέα: done, posted as https://discord.com/channels/g1/c9/${there.id}]`;
  const lines = chat.split('\n');
  const at = lines.indexOf(standalone);
  assert.ok(at > 0, chat);
  assert.ok(lines[at - 1].includes('γράψε στο #νέα'), 'right after the last line before the call');
  assert.ok(lines[at + 1].includes('και;'));
});

test('call marks: a refused call shows its status and why on the line its turn posted', async () => {
  const scene = callMarkScene({
    answers: [
      toolAnswer('<msg>μια στιγμή</msg>', [call('message.create', { channel: '#🍡νέα', text: 'γεια' })]),
      '<msg>μια στιγμή</msg>',
    ],
    allowed: [],
  });
  await scene.run(scene.channel, scene.history[1]);
  scene.history.push(ownRaw(scene.port, 'c1', NOW));
  scene.clock.ms = NOW + 60_000;
  const m2 = rawMessage({ id: 'm2', ts: NOW + 30_000, authorName: 'Alice', content: 'και;' });
  scene.history.push(m2);
  await scene.run(scene.channel, m2);
  const line = lastChat(scene.llm)
    .split('\n')
    .find((text) => text.includes('μια στιγμή'));
  const status = fill(labels.transcript.callStatusReason, {
    status: labels.transcript.callStatus.denied,
    reason: labels.tools.result.reasons['not-allowed'],
  });
  assert.ok(line?.endsWith(`[called message.create in #general: ${status}]`), line ?? '');
});

test('call marks: seeded from the journal after a restart, a call that did not work keeps why', async () => {
  const { journal, lines } = journalOverMemory();
  const scene = callMarkScene({
    answers: [toolAnswer('<msg>μια στιγμή</msg>', [call('message.delete')]), '<msg>μια στιγμή</msg>'],
    allowed: ['message.delete'],
    features: {},
    journal,
  });
  await scene.run(scene.channel, scene.history[1]);
  scene.history.push(ownRaw(scene.port, 'c1', NOW));
  const m2 = rawMessage({ id: 'm2', ts: NOW + 30_000, authorName: 'Alice', content: 'και;' });
  scene.history.push(m2);
  scene.clock.ms = NOW + 60_000;
  const restarted = scene.runner();
  restarted.seedCallMarks(callMarksOf(lines.map(({ record }) => record)));
  await scene.run(scene.channel, m2, restarted);
  const line = lastChat(scene.llm)
    .split('\n')
    .find((text) => text.includes('μια στιγμή'));
  const status = fill(labels.transcript.callStatusReason, {
    status: labels.transcript.callStatus.invalid,
    reason: fill(labels.transcript.callReasons['missing-arg'], { arg: 'message' }),
  });
  assert.ok(line?.endsWith(`[called message.delete in #general: ${status}]`), line ?? '');
});

test('call marks: seeded from the journal after a restart, the calls show as they did; unseeded, nothing shows', async () => {
  const { journal, lines } = journalOverMemory();
  const scene = callMarkScene({
    answers: [
      toolAnswer('<msg reply="#2">εντάξει</msg>\n', [call('message.create', { channel: '#🍡νέα', text: 'καλημέρα' })]),
      '<skip/>',
    ],
    journal,
  });
  await scene.run(scene.channel, scene.history[1]);
  const there = ownRaw(scene.port, 'c9', NOW);
  scene.history.push(ownRaw(scene.port, 'c1', NOW));
  const m2 = rawMessage({ id: 'm2', ts: NOW + 30_000, authorName: 'Alice', content: 'και;' });
  scene.history.push(m2);
  scene.clock.ms = NOW + 60_000;

  const restarted = scene.runner();
  restarted.seedCallMarks(callMarksOf((lines as Array<{ record: object }>).map(({ record }) => record)));
  await scene.run(scene.channel, m2, restarted);
  const line = lastChat(scene.llm)
    .split('\n')
    .find((text) => text.includes('εντάξει'));
  assert.ok(
    line?.endsWith(`[called message.create in #💖νέα: done, posted as https://discord.com/channels/g1/c9/${there.id}]`),
    line ?? ''
  );

  const unseeded = scene.runner();
  await scene.run(scene.channel, m2, unseeded);
  assert.ok(!lastChat(scene.llm).includes('[called '), 'nothing seeded, nothing shown');
});

// ---------------------------------------------------------------------------
// The end hook and the recovery turn (src/behavior/missed.ts): every runTurn reports how it
// ended; a `missed` turn names its messages under labels.task.missed and posts nothing once
// they no longer wait (stillDue).

/** A runner over two lines of c1 whose reply is `answer`, with every end it reports. */
function endHookScene(answer = '<msg reply="#1">ναι</msg>') {
  const history = [
    rawMessage({ id: 'm98', ts: NOW - 60_000, authorName: 'Alice', content: 'tu viens ce soir ?' }),
    rawMessage({ id: 'm99', ts: NOW - 30_000, authorId: 'u2', authorName: 'Zoë', content: 'et le lapin ?' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: history });
  const llm = fakeLlm(answer);
  const store = fakeStore();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot({}),
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });
  const ends: Array<{
    guildId: string | null;
    channelId: string | null;
    privateChat: boolean;
    routed: boolean;
    mode: string | null;
    trigger: {
      id: string | null;
      authorId: string | null;
      channelId: string | null;
      ts: number | null;
      content: string;
    } | null;
    triggerKind: TriggerKind | null;
    outcome: string;
    reason: string | null;
    replyTargets: Array<string>;
    turnId: unknown;
  }> = [];
  turns.setOnTurnEnd((end) => ends.push(end));
  return { history, channel, llm, store, turns, ends };
}

test("createTurnRunner: the end hook hears every turn's outcome, its trigger and what its posts replied to", async () => {
  const { history, channel, store, turns, ends } = endHookScene();
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(history[1]),
    triggerKind: 'mention',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.outcome, 'spoke');
  assert.equal(ends.length, 1);
  const [end] = ends;
  assert.deepEqual(
    [end.guildId, end.channelId, end.privateChat, end.routed, end.mode, end.triggerKind, end.outcome, end.reason],
    ['g1', 'c1', false, false, 'reply', 'mention', 'spoke', null]
  );
  assert.deepEqual([end.trigger?.id, end.trigger?.authorId, end.trigger?.ts], ['m99', 'u2', NOW - 30_000]);
  assert.deepEqual(end.replyTargets, ['m98']);
  assert.equal(channel.sent.length, 1);
  assert.equal(turns.triggerOf('sent-1'), 'm99', 'the read accessor of the trigger links');
  assert.equal(turns.triggerOf('nope'), null);

  store.state.data.paused = true;
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(history[0]), triggerKind: 'mention' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([ends[1].outcome, ends[1].trigger?.id], ['paused', 'm98']);
});

test('createTurnRunner: a turn dropped at its bar reaches the end hook as an error with reason too-slow', async () => {
  // The scene of 'a provider error landing once no time is left before pace.dropAfterMs drops the turn'.
  let t = NOW;
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      [
        'v1',
        {
          id: 'v1',
          contentType: 'video/mp4',
          name: 'clip.mp4',
          url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
          duration: 34,
        },
      ],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = barLlm(async () => {
    t = NOW + BAR_MS;
    const err = Object.assign(new Error('bad request'), { statusCode: 400 });
    throw err;
  });
  const hot = fakeHot({});
  hot.config.pace = { ...TEST_PACE, dropAfterMs: BAR_MS };
  const timers = fakeSchedule();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    imageFetcher: fakeImageFetcher(),
    now: () => t,
    schedule: timers.schedule,
  });
  const ends: Array<{
    guildId: string | null;
    channelId: string | null;
    privateChat: boolean;
    routed: boolean;
    mode: string | null;
    trigger: {
      id: string | null;
      authorId: string | null;
      channelId: string | null;
      ts: number | null;
      content: string;
    } | null;
    triggerKind: TriggerKind | null;
    outcome: string;
    reason: string | null;
    replyTargets: Array<string>;
    turnId: unknown;
  }> = [];
  turns.setOnTurnEnd((end) => ends.push(end));
  await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    ends.map((end) => [end.outcome, end.reason, end.trigger?.id]),
    [['error', 'too-slow', 'm1']]
  );
});

test('runTurn: a missed turn names its messages under labels.task.missed and posts', async () => {
  const { history, channel, llm, turns, ends } = endHookScene('<msg>me voilà</msg>');
  const missed = [
    { id: 'm98', author: 'Alice', text: 'tu viens ce soir ?' },
    { id: 'm99', author: 'Zoë', text: 'et le lapin ?' },
  ];
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(history[0]),
    triggerKind: 'missed',
    missed,
    stillDue: () => true,
  });
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  const task = taskOf({ messages: llm.calls[0] });
  assert.ok(
    task.includes(fill(labels.task.missed, { missed: '1. Alice: tu viens ce soir ?; 2. Zoë: et le lapin ?' })),
    task
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ends[0].triggerKind, 'missed');
});

test('runTurn: a missed turn whose messages no longer wait posts nothing and ends not-now', async () => {
  const { history, channel, turns } = endHookScene('<msg>me voilà</msg>');
  let asked = 0;
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'reply',
      trigger: normalizedTrigger(history[0]),
      triggerKind: 'missed',
      missed: [{ id: 'm98', author: 'Alice', text: 'tu viens ce soir ?' }],
      stillDue: () => {
        asked += 1;
        return false;
      },
    })
  );
  assert.equal(asked, 1);
  assert.deepEqual([result.outcome, result.reason], ['not-now', 'answered-meanwhile']);
  assert.equal(channel.sent.length, 0);
  assert.ok(logs.some((l) => l.msg === 'turn: dropped' && l.reason === 'answered-meanwhile'));
});

// ---------------------------------------------------------------------------
// A voice answer cut off at its output cap (finish_reason `length`): with no complete action it
// is an error with reason `cut-off`, never a skip, and nothing of it is posted; complete actions
// written before the cut are kept. A `stop` answer is read as before.

/** A completion cut off at the cap after 2000 tokens. */
const cut = (text: string) => ({
  text,
  finishReason: 'length',
  usage: { prompt_tokens: 900, completion_tokens: 2000 },
  promptTokens: 900,
  estimated: 900,
});

/** A runner with the journal on over one call of Alice in c1, answering `answers` in turn. */
function cutScene(answers: Untyped) {
  const history = [
    rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000, content: 'tu viens ce soir ?' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: history });
  const { journal, lines } = journalOverMemory();
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot({}),
    store: fakeStore(),
    llm: sequenceLlm(answers),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    journal,
  });
  const ends: Array<{
    guildId: string | null;
    channelId: string | null;
    privateChat: boolean;
    routed: boolean;
    mode: string | null;
    trigger: {
      id: string | null;
      authorId: string | null;
      channelId: string | null;
      ts: number | null;
      content: string;
    } | null;
    triggerKind: TriggerKind | null;
    outcome: string;
    reason: string | null;
    replyTargets: Array<string>;
    turnId: unknown;
  }> = [];
  turns.setOnTurnEnd((end) => ends.push(end));
  const run = async () => {
    const out = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(history[0]), triggerKind: 'mention' })
    );
    await new Promise((resolve) => setImmediate(resolve));
    return { ...out, turn: lines.map(({ record }) => record).find((record) => record.kind === 'turn') };
  };
  return { channel, ends, run };
}

test('turn: a reply cut off inside its <think> ends error with reason cut-off, posts nothing, journals the think so far', async () => {
  const { channel, ends, run } = cutScene([cut('<think>Η Αλίκη ρωτά για απόψε. Θα της πω ότι')]);
  const { result, logs, turn } = await run();
  assert.deepEqual([result.outcome, result.reason], ['error', 'cut-off']);
  assert.equal(channel.sent.length, 0);
  const line = logs.find((entry) => entry.msg === 'turn: cut off');
  assert.deepEqual([line?.completionTokens, line?.kept, line?.followUp], [2000, false, false]);
  assert.deepEqual(
    [turn.outcome, turn.reason, turn.think, turn.usage.completion],
    ['error', 'cut-off', 'Η Αλίκη ρωτά για απόψε. Θα της πω ότι', 2000]
  );
  assert.deepEqual(
    ends.map((end) => [end.outcome, end.reason, end.trigger?.id]),
    [['error', 'cut-off', 'm1']],
    'the end hook makes it a turn-error candidate'
  );
});

test('turn: a cut-off answer with no tag after its think is a fragment: error cut-off, nothing posted', async () => {
  const { channel, run } = cutScene([cut('<think>σχέδιο</think>ναι, θα έρθω αλλά')]);
  const { result, turn } = await run();
  assert.deepEqual([result.outcome, result.reason], ['error', 'cut-off']);
  assert.equal(channel.sent.length, 0);
  assert.equal(turn.think, 'σχέδιο');
});

test('turn: a cut-off answer keeps its complete messages, drops the open one and logs the cut', async () => {
  const { channel, ends, run } = cutScene([cut('<think>σχέδιο</think><msg>ναι</msg><msg>θα έρθω αλ')]);
  const { result, logs, turn } = await run();
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    channel.sent.map((sent) => sent.content),
    ['ναι']
  );
  const line = logs.find((entry) => entry.msg === 'turn: cut off');
  assert.deepEqual([line?.completionTokens, line?.kept], [2000, true]);
  assert.deepEqual([turn.outcome, turn.reason], ['spoke', null]);
  assert.deepEqual(
    ends.map((end) => [end.outcome, end.reason]),
    [['spoke', null]]
  );
});

test('turn: an answer that stopped on its own is read as before: an open think is a skip, no cut-off', async () => {
  for (const finishReason of ['stop', undefined]) {
    const { channel, run } = cutScene([{ text: '<think>σχέδιο χωρίς τέλος', finishReason, usage: {}, estimated: 10 }]);
    const { result, logs } = await run();
    assert.equal(result.outcome, 'skip', String(finishReason));
    assert.equal(channel.sent.length, 0);
    assert.ok(!logs.some((entry) => entry.msg === 'turn: cut off'));
  }
});

test('turn: a step cut off with nothing complete ends error cut-off when nothing reached the chat', async () => {
  const lone = await callTurn({
    answers: [toolAnswer('', [call('lore.list')]), cut('<think>δεν βρήκα τίποτα, θα')],
    allowed: ['lore.list'],
  });
  assert.deepEqual([lone.result.outcome, lone.result.reason], ['error', 'cut-off']);
  assert.deepEqual(lone.sends, []);
  const line = lone.logs.find((entry) => entry.msg === 'turn: cut off');
  assert.deepEqual([line?.completionTokens, line?.kept, line?.followUp], [2000, false, true]);

  // What she wrote before the read was held for the answer that never came: nothing reached the chat, a lost answer.
  const after = await callTurn({
    answers: [toolAnswer('<msg>μια στιγμή</msg>', [call('lore.list')]), cut('<think>δεν βρήκα')],
    allowed: ['lore.list'],
  });
  assert.deepEqual([after.result.outcome, after.result.reason], ['error', 'cut-off']);
  assert.deepEqual(after.sends, []);
  assert.ok(
    after.logs.some((entry) => entry.msg === 'turn: cut off' && entry.followUp === true && entry.kept === false)
  );

  // A follow-up cut after a complete message: the message is posted.
  const kept = await callTurn({
    answers: [toolAnswer('', [call('lore.list')]), cut('<msg>τίποτα</msg><msg>κι αυτό')],
    allowed: ['lore.list'],
  });
  assert.equal(kept.result.outcome, 'spoke');
  assert.deepEqual(
    kept.sends.map((send) => send.text),
    ['τίποτα']
  );
  assert.ok(kept.logs.some((entry) => entry.msg === 'turn: cut off' && entry.followUp === true && entry.kept === true));
});

test('createTurnRunner: a message the record holds as deleted appears in the window as a numbered placeholder at its own place; the cap and the timings.record stage hold', async () => {
  const first = rawMessage({ id: 'm1', ts: NOW - 9000, content: 'πρώτο' });
  const last = rawMessage({ id: 'm3', ts: NOW - 1000, content: 'τελευταίο' });
  const iso = (ts: number) => new Date(ts).toISOString();
  // PR 7d: context.deletedLinesMax is the constant 10, so twelve deleted messages show ten placeholders.
  const lines = Array.from({ length: 12 }, (_, n) => [
    { kind: 'seen', messageId: `d${n}`, occurredAt: iso(NOW - 6000 + n * 100), by: 'u2', scope: { channel: 'c1' } },
    { kind: 'deleted', messageId: `d${n}`, occurredAt: iso(NOW - 500), participants: ['u2'], scope: { channel: 'c1' } },
  ]).flat();
  const queries: Array<Untyped> = [];
  const record = {
    async *iterate(guildId: string, query: unknown) {
      queries.push(query);
      yield* lines;
    },
    append: async () => ({ written: 1 }),
  };
  const hot = fakeHot();
  const channel = fakeTurnChannel({ historyMessages: [first, last] });
  const llm = fakeLlm('<msg>ok</msg>');
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    record,
  });
  const { logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(last), triggerKind: 'mention' })
  );
  const text = textOf(llm.calls[0]?.[1].content);
  assert.equal(queries[0].channelIds.length, 1, 'one channel');
  assert.ok(queries[0].from, "the read starts at the window's oldest line");
  const at = (needle: string) => text.indexOf(needle);
  assert.ok(
    at('πρώτο') < at(`${labels.transcript.deleted}`) && at(labels.transcript.deleted) < at('τελευταίο'),
    'the placeholders sit between the lines'
  );
  assert.equal(text.split(labels.transcript.deleted).length - 1, 10, 'the newest ten only');
  assert.ok(/#\d+ \[[^\]]+\] [^\n]*: message deleted/.test(text), 'numbered like a line');
  const timings = logs.find((entry) => entry.msg === 'turn: timings');
  assert.equal(typeof timings?.stages.record, 'number');
});

// PR 7d: the daily caps of plan section 4.5 are gone. A state written before the cut may hold the day's count and a
// local layer not yet cut may set `gifs.maxPerDay`; neither stops her GIF.
test('runTurn: her GIF is posted after a hundred GIFs today, a stale gifs.maxPerDay in the config included', async () => {
  const run = await runPickTurn({
    reply: '<msg>χα</msg><gif>g2</gif>',
    pick: 'none',
    store: pickStore({ data: { gifDay: '2026-09-20', gifCount: 100 } }),
    maxPerDay: 3,
  });
  assert.deepEqual(run.sent(), ['χα', 'https://tenor.com/view/gif-2']);
});

test('a cancelled internal turn cannot leave its read context on a subsequent ordinary DM', async () => {
  const { issueContext } = await import('../src/memory/db/scope.ts');
  const context = issueContext({ kind: 'internal', newId: () => 'ctx:cancelled-owner', now: () => NOW });
  const waiting = Promise.withResolvers<{ text: string; usage: object; estimated: number }>();
  const requested = Promise.withResolvers<void>();
  const timers = fakeSchedule();
  const reads: Array<unknown> = [];
  const requests: Array<unknown> = [];
  let talkCount = 0;
  const llm = {
    complete: async (messages: unknown, options: { purpose?: string }) => {
      if (options.purpose === 'lookup') return { text: 'none', usage: {}, estimated: 1 };
      requests.push(messages);
      talkCount += 1;
      if (talkCount === 1) {
        requested.resolve();
        return waiting.promise;
      }
      return { text: '<msg>ordinary-dm-answer</msg>', usage: {}, estimated: 1 };
    },
  };
  const hot = paceHot({}, { dropAfterMs: BAR_MS });
  const recall = {
    available: () => true,
    prefetch: (args: Record<string, unknown>) => {
      reads.push(args.memoryContext);
      return Promise.resolve({ status: 'ok', excerpts: [], ms: 0 });
    },
  };
  useIface('cli');
  try {
    freshWorld();
    world().member('g1', { id: 'owner', name: 'Owner' });
    world().member('g1', { id: 'other', name: 'Other' });
    hot.config.bot = { timezone: 'UTC', guildId: 'g1', owners: [] };
    hot.config.private = { enabled: true, likeServer: true, minAffinity: 0 };
    const ownerRaw = rawMessage({
      id: 'owner-cancel',
      authorId: 'owner',
      content: 'find the distant private rabbit conversation',
    });
    const owner = fakeTurnChannel({
      id: 'cli:dm:owner',
      dm: true,
      partnerId: 'owner',
      guildId: null,
      historyMessages: [ownerRaw],
    });
    const otherRaw = rawMessage({
      id: 'other-after-cancel',
      authorId: 'other',
      content: 'find the public rabbit conversation',
    });
    const other = fakeTurnChannel({
      id: 'cli:dm:other',
      dm: true,
      partnerId: 'other',
      guildId: null,
      historyMessages: [otherRaw],
    });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot,
      store: fakeStore(),
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      lookup: fakeLookup(),
      recall,
      memoryContext: issueContext,
      now: () => NOW,
      schedule: timers.schedule,
    });
    const first = withCapturedLogs(() =>
      turns.runTurn({
        channel: owner,
        guildId: 'g1',
        mode: 'reply',
        trigger: normalizedTrigger(ownerRaw),
        triggerKind: 'private',
        memoryContext: context,
      })
    );
    await requested.promise;
    assert.deepEqual(reads, [context]);
    const deadline = timers.live().find((timer) => timer.ms === BAR_MS);
    assert.ok(deadline);
    timers.fire(deadline);
    assert.equal((await first).result.outcome, 'error');
    assert.deepEqual(owner.sent, []);
    waiting.resolve({ text: '<msg>late-private-answer</msg>', usage: {}, estimated: 1 });
    const next = await withCapturedLogs(() =>
      turns.runTurn({
        channel: other,
        guildId: 'g1',
        mode: 'reply',
        trigger: normalizedTrigger(otherRaw),
        triggerKind: 'private',
      })
    );
    assert.equal(next.result.outcome, 'spoke');
    assert.equal(reads.length, 2);
    const ordinary = reads[1];
    assert.ok(ordinary !== null && typeof ordinary === 'object');
    assert.ok('kind' in ordinary && ordinary.kind === 'dm');
    assert.ok('person' in ordinary && ordinary.person === 'person:cli:other');
    assert.ok(!('internal' in ordinary) || ordinary.internal !== true);
    assert.ok('id' in ordinary && ordinary.id !== context.id);
    assert.deepEqual(owner.sent, []);
    assert.equal(other.sent.length, 1);
  } finally {
    useIface('discord');
  }
});
