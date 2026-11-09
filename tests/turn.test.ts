// health: allow file-length until 2027-04-01 -- the standard counts widened two assertions; this file splits with the turn runner
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
import { resolveMentions, mentionDirectory, paceSettings } from '../src/behavior/turn.ts';
import { between, typingMs } from '../src/behavior/random.ts';
import { fillPromptTemplate, userText as textOf } from '../src/behavior/prompt.ts';
import { fill, formatDuration } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { handleOf } from '../src/behavior/handles.ts';
import { ImageGenError } from '../src/llm/images.ts';
import { DailyCapError, TokenLimitError } from '../src/llm/openrouter.ts';
import { findGif } from '../src/memory/gifs.ts';
import { callMarksOf, createJournal } from '../src/memory/journal.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import '../src/tools/operations/index.ts';
import { loadSkills, skillRegistry } from '../src/tools/registry.ts';
import { createAdmin } from '../src/admin.ts';
import { createDiscordAdapter, createDiscordInterface } from '../interfaces/discord/index.ts';
import { createLocalFacts } from '../src/behavior/inner.ts';
import { freshWorld, world, useIface } from './fixtures/turn-world.ts';
import type { ChannelSpec } from './fixtures/turn-world.ts';
import type { TriggerKind } from '../src/turn/triggers.ts';
import type { TurnParams } from '../src/turn/outcome.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';
import { declarePick, gifStore, pickLlm, withPick } from './fixtures/turn-pick.ts';
import { openTestMemorySync, journalLineLabel } from './fixtures/memory-db/service.ts';
import type { JournalLinesWrite } from '../src/memory/db/journal-lines.ts';
import { addClaim, addPerson, openWorld } from './fixtures/memory-db/mind-world.ts';
import { asRecord } from './fixtures/records.ts';
import type { Untyped } from '../src/tools/types.ts';
import {
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
import type { FakeHot, RawMessage } from './fixtures/turn-kit.ts';
import { OWNER_PERSON, ownedBy } from './fixtures/owner-accounts.ts';

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
  assert.deepEqual(result.accountIds, ['u1']);
});

test('resolveMentions: an unknown name is left untouched', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('γεια @Ghost', history);
  assert.equal(result.text, 'γεια @Ghost');
  assert.deepEqual(result.accountIds, []);
});

test('resolveMentions: excludes its own lines and bot lines from candidates', () => {
  const history = [
    historyMsg('Zoë', 'self-id', { self: true }),
    historyMsg('SomeBot', 'bot-id', { bot: true }),
    historyMsg('Alice', 'u1'),
  ];
  const result = resolveMentions('@Zoë @SomeBot @Alice', history);
  assert.equal(result.text, '@Zoë @SomeBot <@u1>');
  assert.deepEqual(result.accountIds, ['u1']);
});

test('resolveMentions: longer names are matched before their shorter prefixes', () => {
  const history = [historyMsg('Anna', 'short-id'), historyMsg('AnnaMaria', 'long-id')];
  const result = resolveMentions('γεια @AnnaMaria', history);
  // Must not first match "@Anna" inside "@AnnaMaria" and leave "Maria" dangling.
  assert.equal(result.text, 'γεια <@long-id>');
  assert.deepEqual(result.accountIds, ['long-id']);
});

test('resolveMentions: replaces every occurrence of the same name', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Alice γεια @Alice', history);
  assert.equal(result.text, '<@u1> γεια <@u1>');
  assert.deepEqual(result.accountIds, ['u1']);
});

test('resolveMentions: deduplicates authors that appear more than once in history', () => {
  const history = [historyMsg('Alice', 'u1'), historyMsg('Alice', 'u1', { content: 'again' })];
  const result = resolveMentions('@Alice', history);
  assert.deepEqual(result.accountIds, ['u1']);
});

test('resolveMentions: a stored multi-word name of a member shown resolves', () => {
  const history = [historyMsg('Whammy', 'u3')];
  const known = [
    { name: 'Más tarde nunca', id: 'u3' },
    { name: 'Whammy', id: 'u3' },
  ];
  const result = resolveMentions('@Más tarde nunca ναι', history, known);
  assert.equal(result.text, '<@u3> ναι');
  assert.deepEqual(result.accountIds, ['u3']);
});

test('resolveMentions: a transcript author wins a name a stored profile shares', () => {
  const history = [historyMsg('Bob', 'u2')];
  const result = resolveMentions('@Bob ναι', history, [{ name: 'Bob', id: 'u7' }]);
  assert.equal(result.text, '<@u2> ναι');
  assert.deepEqual(result.accountIds, ['u2']);
});

test('resolveMentions: a name only a member not handed over carries stays text', () => {
  // The caller hands over the members the request showed; anyone else is no candidate.
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Ταξιάρχης γεια', history, [{ name: 'Αλίκη', id: 'u1' }]);
  assert.equal(result.text, '@Ταξιάρχης γεια');
  assert.deepEqual(result.accountIds, []);
});

test('resolveMentions: a stored name containing a shorter transcript name is matched first', () => {
  const history = [historyMsg('Anna', 'short-id')];
  const result = resolveMentions('@Anna María, @Anna', history, [{ name: 'Anna María', id: 'long-id' }]);
  assert.equal(result.text, '<@long-id>, <@short-id>');
  assert.deepEqual(result.accountIds, ['long-id', 'short-id']);
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
  assert.deepEqual(result.accountIds, ['z1']);
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
  assert.deepEqual(result.accountIds, ['u9']);
});

test('resolveMentions: a fallback name two members carry stays text, whatever its case', () => {
  const directory = [
    { name: 'Zoé', id: 'z1' },
    { name: 'zoé', id: 'z2' },
    { name: 'Zoé', id: 'z1' },
  ];
  const result = resolveMentions('@Zoé @ZOÉ ναι', [], [], directory);
  assert.equal(result.text, '@Zoé @ZOÉ ναι');
  assert.deepEqual(result.accountIds, []);
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
  assert.deepEqual(result.accountIds, ['u1', 'u2']);
});

test('resolveMentions: the fallback matches case-insensitively, longest first and only as a whole name', () => {
  const directory = [
    { name: 'Anna María', id: 'long' },
    { name: 'Anna', id: 'short' },
    { name: 'Kai', id: 'k1' },
  ];
  const result = resolveMentions('@anna maría, @ANNA, @Kaiser', [], [], directory);
  assert.equal(result.text, '<@long>, <@short>, @Kaiser');
  assert.deepEqual(result.accountIds, ['long', 'short']);
});

test('resolveMentions: the case-insensitive fallback is for the directory only, never a shown name', () => {
  const result = resolveMentions('@alice', [historyMsg('Alice', 'u1')], [], []);
  assert.equal(result.text, '@alice');
  assert.deepEqual(result.accountIds, []);
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
// interject or an inner turn alike, whatever the mode.
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

// ---------------------------------------------------------------------------
// features.mediaDescriptions -- describing pictures that are not attached.

function fakeDescriber(descriptionsById: Untyped) {
  const calls: Array<{ placeId: Untyped; items: Untyped; options: Untyped }> = [];
  return {
    calls,
    describeMany: async (placeId: string, items: Untyped, options: unknown) => {
      calls.push({ placeId, items, options });
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
  const videoCalls: Array<{ placeId: Untyped; items: Untyped; options: Untyped }> = [];
  return {
    ...base,
    videoCalls,
    describeVideos: async (placeId: string, items: Untyped, options: unknown) => {
      videoCalls.push({ placeId, items, options });
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
  const { placeId, items, options } = describer.videoCalls[0];
  assert.equal(placeId, 'g1');
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
type DescribeCall = { placeId: string; items: Array<Untyped>; options: Untyped };

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
    describeMany: async (placeId: string, items: Array<Untyped>, options: Untyped) => {
      describer.calls.push({ placeId, items, options });
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
/** Slice 4: a block that leaves a reply stays on a routed turn: a call in #hall (c8), answered in the channel. */
function routedCall(audience?: ChannelSpec['audience']) {
  const call = { ...rawMessage({ id: 'h1', ts: NOW - 3000, content: '@Bot κοίτα' }), placeId: 'c8' };
  fakeTurnChannel({ id: 'c8', name: 'hall', historyMessages: [call], lastMessageAt: NOW - 3000, audience });
  return { trigger: normalizedTrigger(call), source: { placeId: 'c8', reason: 'routed' as const } };
}

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

/** fakeStore whose guild hands out the state `off` (store.getPings) for the members who turned the persona's notifications off. */
function storeWithPingsOff(pingsOff: Untyped) {
  const store = fakeStore();
  store.pingsCalls = [];
  store.getPings = (placeId: string, accountId: string) => {
    store.pingsCalls.push([placeId, accountId]);
    return pingsOff.includes(accountId) ? 'off' : null;
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
  assert.ok(store.pingsCalls.every(([placeId]: Array<unknown>) => placeId === 'g1'));
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

// ---------------------------------------------------------------------------
// The web lookup: read links and the search on a question.

test('createTurnRunner: lookup -- readable links (no video site, no gif) go to readLinks newest first; reads reach the transcript', async () => {
  const lookup = fakeLookup({ reads: { 'm1#e0': 'une recette, trois œufs' } });
  const { llm } = await runLookupTurn({ lookup });

  assert.equal(lookup.readCalls.length, 1);
  const { placeId, links, options } = lookup.readCalls[0];
  assert.equal(placeId, 'g1');
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
  const { result, channel, images, llm } = await runDrawTurn({
    answers: [
      toolAnswer('<msg>one sec</msg><msg>here</msg>', [call('draw.create', { reply: '#1', text: 'a cat on a roof' })]),
      '<skip/>',
    ],
  });

  assert.equal(result.outcome, 'spoke');
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(llm.calls.length, 2, 'the picture came back to her in a second request');
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
  assert.equal(request.accountId, 'u1');
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
    if (member.accountId === 'self-id') avatarAsks.push(member.accountId);
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
    // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to
    // her in one step; she stays silent there.
    answers: [toolAnswer('', [call('draw.create', { self: true, text: 'me waving' })]), '<skip/>'],
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
    if (member.accountId === 'self-id') avatarAsked = true;
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
    // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to
    // her in one step; she stays silent there.
    answers: [toolAnswer('', [call('draw.create', { self: true, text: 'me' })]), '<skip/>'],
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

test('runTurn: a turn whose reaction the platform refused or whose picture moderation refused delivered nothing', async () => {
  // Slice 7: restored on the ordinary scene from the routed scene it was deleted with. Bug: a refused reaction or a
  // refused picture counts as delivered, so the turn reads as having reached the chat.
  world().port.failNext('react', { status: 'failed', error: { code: 'fixture-refused', retryable: false } });
  const reacted = await runDrawTurn({ answers: ['<react to="#1">👍</react>'] });
  assert.deepEqual([reacted.result.outcome, reacted.result.delivered], ['spoke', false]);
  assert.ok(reacted.logs.some((l: Untyped) => l.msg === 'turn: reaction failed'));

  const refused = await runDrawTurn({
    images: fakeImages({ error: new ImageGenError('moderation', 'image refused by moderation (HTTP 400)') }),
    answers: [toolAnswer('', [call('draw.create', { reply: '#1', text: 'a blue wall' })]), '<skip/>'],
  });
  assert.deepEqual([refused.result.outcome, refused.result.delivered], ['spoke', false]);
  assert.equal(refused.channel.sent.length, 0);
});

test('runTurn: a draw.create alone is a spoken turn', async () => {
  const { result, channel, llm, logs } = await runDrawTurn({
    answers: [toolAnswer('', [call('draw.create', { text: 'a cat' })]), '<skip/>'],
  });

  assert.equal(result.outcome, 'spoke');
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(llm.calls.length, 2, 'the picture came back to her and she stayed silent');
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
    // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to
    // her in one step; she stays silent there.
    llm: sequenceLlm([toolAnswer('', [call('draw.create', { reply: '#1', text: 'a cat' })]), '<skip/>']),
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
    // Her name in the served root is the core's to tell (the member directory, else the name of `hello`).
    getSelfName: () => selfName,
    images,
    errands,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' })
  );
  return { result, logs, channel, llm, store, images, turns };
}

test('runTurn: a private turn takes placeId from params and reads the private layer of the trigger author', async () => {
  const { result, channel, store } = await runPrivateTurn();

  assert.equal(result.outcome, 'spoke');
  // The request's guild memory: nothing reads the guild again before the message is posted.
  assert.deepEqual(store.guildCalls, ['g1']);
  assert.deepEqual(store.privateCalls, [{ accountId: 'u1' }]);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'hi');
  assert.deepEqual(
    channel.sent[0].reply,
    { messageReference: 'm1', failIfNotExists: false },
    'a private reply may quote the trigger'
  );
});

test('runTurn: a private request carries the private prompt and the private trigger label, no server or neighbours', async () => {
  const { llm } = await runPrivateTurn();
  const user = userTextOf(llm.calls[0]);

  assert.ok(
    user.includes(`Someone called you: Alice, they ${labels.triggers.private}. You are GuildBot.`),
    'selfName comes from the served guild'
  );
  assert.ok(user.includes('PRIVATE_TASK with Alice as GuildBot'));
  // Slice 4: the counterpart of a DM comes from the graph reader, not the store's merged profile; the private memory
  // reaching her is tests/core-dm-neutral-turn.test.ts and tests/request-memory-block.test.ts.
  assert.ok(user.includes(labels.senses.dmChat));
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
  const { result, channel, images, llm } = await runPrivateTurn({
    answers: [toolAnswer('<msg>sure</msg>', [call('draw.create', { text: 'a cat' })]), '<skip/>'],
  });

  assert.equal(result.outcome, 'spoke');
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(llm.calls.length, 2, 'the picture came back to her in a second request');
  assert.equal(images.generateCalls.length, 1);
  assert.equal(images.generateCalls[0].accountId, 'u1');
  assert.equal(images.generateCalls[0].prompt, 'Drawing for GuildBot.\n\na cat');
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[0].files?.length, 1, 'the picture first, then her message');
});

test('runTurn: a guild channel keeps its own guild id even when a placeId param is passed', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ placeId: 'g1', historyMessages: [raw] });
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
    placeId: 'other',
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
  // PR 7d: features.privateMessages is the key dm.enabled.
  const hot = fakeHot({}, {}, { dm: { enabled: true } });
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
  assert.ok(!user.includes(labels.senses.dmChat));
  assert.ok(user.includes(labels.senses.privateAware));
});

// Changed: a DM needs no root (plan section 3), so the throw this test pinned is the bug that dropped such a DM.
test('runTurn: a channel without a guild and no placeId param runs a turn with no root and leaves nothing busy', async () => {
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

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' });
  assert.equal(llm.calls.length, 1);
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

// B8: the pick offers the emoji list, and what the adapter declares takes the sense line's place.
test('createTurnRunner: the request carries no <emoji> block and the text the interface declares', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  declarePick({ gifForms: ['link'], text: 'ένα σημάδι' });
  const store = fakeStore({
    placeMemory: { emojiUsage: { '222222222222222222': { name: 'dance', count: 4, last: Date.now() } } },
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
  assert.ok(!text.includes('<emoji>'), 'no <emoji> block');
  assert.ok(text.includes('ένα σημάδι'));
  assert.ok(!text.includes(labels.senses.customEmoji));
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
  // The reply call hands the archive its blocks, one entry per block of the request.
  const { blocks } = llm.optionCalls[0];
  assert.ok(Array.isArray(blocks) && blocks.length > 0);
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
      // B7: a GIF of hers is the media pick's now, in place of the message it would have replaced.
      hot: withPick(fakeHot()),
      store: gifStore(),
      // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
      llm: pickLlm({ reply: '<msg reply="#1">χα</msg>', pick: '{"pick":"gif","name":"g1"}' }),
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
  assert.equal(images.generateCalls[0].accountId, null);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].files?.length, 1);
  assert.equal(channel.sent[0].reply, undefined);
});

// --- another channel pulled into a turn (<channel_view>): the inputs ----------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Another channel of the guild, snowflake-shaped: a `<#id>` mention is only read for such ids.
const DIARY = '100000000000000002';

/** A raw message of channel `placeId`; `raw` is Discord's own text (`<#id>` tokens), `content` the clean one. */
function lineIn(
  placeId: string,
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
  const message: ReturnType<typeof rawMessage> & { content?: string } = { ...rawMessage(fields), placeId };
  if (raw !== undefined) message.content = raw;
  return message;
}

// The core does not cut a post, the adapter splits it: the texts a fake channel received, and what a split keeps.
const postedTexts = (channel: { sent: Array<{ content?: string }> }) => channel.sent.map((p) => p.content ?? '');
function assertSplitIntact(posts: Untyped) {
  assert.ok(posts.length > 1, 'the adapter split it');
  const intact = (c: Untyped) => [...c].length <= 2000 && c.lastIndexOf('<') <= c.lastIndexOf('>');
  assert.ok(posts.every(intact), 'each message fits Discord and holds no half token');
}

// --- the request input, named in full (src/behavior/turn-input.ts) ----------------------------

// --- I-7: destinations, send failures, dry-run, caps -------
// The two `usableDestination` tests that stood here pinned the main channel, which the owner removed: tests/no-main-channel.test.ts
// states what holds now.

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
  const [fact] = source.pending({ placeId: 'c1', dmChat: false });
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
    if (ref.chatId === channel.id) fetchedAt.push(clock.t);
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
    lastAt: (placeId: string, authorId: string) => (placeId === 'c1' && authorId === 'u1' ? last : null),
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

// A turn nobody waits for: an overheard line. Slice 5: the initiate mode is deleted, so its row went.
const UNHURRIED_TURNS: Array<[string, (scene: Untyped) => TurnParams]> = [
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
  describer.describeVideos = async (placeId: string, items: Array<Untyped>, options: Untyped) => {
    describer.videoCalls.push({ placeId, items, options });
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
  scene.describer.describeMany = async (placeId, items) => ({
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
  describer.describeVideos = async (placeId: string, items: Array<Untyped>, options: Untyped) => {
    describer.videoCalls.push({ placeId, items, options });
    await watch.promise;
    return { videos: new Map([['va', { state: 'watched', text: WATCHED_TEXT }]]), newCount: 1 };
  };
  describer.cachedVideos = async (placeId: string, items: Untyped) =>
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
    if (ref.chatId === scene.channel.id) t += 100;
  });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0);
  await settleUntil();
  t = NOW + 1100;
  caption.resolve();
  const { logs } = await running;

  const timings = logs.find((l) => l.msg === 'turn: timings');
  // Slice 7: the neighbours, the pulled channels and the participation pick are deleted, and with them their stages.
  assert.deepEqual(Object.keys(timings?.stages), [
    'history',
    'previews',
    'captions',
    'videos',
    'rewatch',
    'links',
    'lookup',
    'record',
  ]);
  assert.equal(timings?.stages.history, 100);
  assert.equal(timings?.stages.captions, 1000);
  for (const name of ['previews', 'links']) assert.equal(typeof timings?.stages[name], 'number', name);
  for (const name of ['videos', 'rewatch', 'lookup', 'record']) assert.equal(timings?.stages[name], null, name);
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

// The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
test('runTurn: a `one` verdict leaves the turn exactly as without the splitter', async () => {
  const off = splitHot();
  delete off.prompts.split;
  const before = await runSplitTurn({ hot: off });
  const after = await runSplitTurn({ llm: splitLlm({ split: '{"parts":[]}' }) });

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

// The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
test('runTurn: the splitter request fills split.md and carries the transcript and the candidate', async () => {
  const { llm } = await runSplitTurn({ llm: splitLlm({ split: '{"parts":[]}' }) });
  const [call] = llm.calls.split;
  assert.equal(call.messages[0].content, fillPromptTemplate(SPLIT_SYSTEM, { name: 'Bot', maxTasks: 4 }));
  assert.ok(textOf(call.messages[1].content).startsWith('<transcript>\n'));
  assert.equal(candidateOf(call), SPLIT_TEXT);
  assert.deepEqual(
    [call.options.role, call.options.purpose, call.options.maxOutputTokens, call.options.isRoleRequest],
    ['analyzer', 'split', 50, true]
  );
});

// The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
test('runTurn: a failed, empty or unparsable splitter answer is one request', async () => {
  for (const split of [Object.assign(new Error('boom'), { statusCode: 503 }), '   ', '{"parts":"only one"}']) {
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

// The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
test('runTurn: the splitter cuts the parts at its four tasks', async () => {
  // PR 7d: split.maxTasks is the constant 4 (the production value).
  const kept = [...SPLIT_PARTS, 'και κάτι ακόμα πιο μεγάλο'];
  const { llm } = await runSplitTurn({
    llm: splitLlm({ split: JSON.stringify({ parts: [...SPLIT_PARTS, kept[3], 'και ένα τελευταίο ακόμα θέμα'] }) }),
  });
  assert.equal(llm.calls.talk.length, 4);
  assert.ok(taskOf(llm.calls.talk[0]).endsWith(partLabel(1, kept)));
});

test('runTurn: an overheard line asks the splitter and an unprompted turn never does', async () => {
  const overheard = await runSplitTurn({ triggerKind: 'overheard' });
  assert.equal(overheard.llm.calls.split.length, 1); // plan 2026-11-04-cli-and-memory B2
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
const PICK_SETTINGS = { maxOutputTokens: 17, candidates: PICK_LIBRARY_SIZE }; // B7: the cap holds the whole library.

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
      // B7: the search reads the caption on the entry, and these words are the replies' below.
      caption: `ναι χα λεζάντα ${i}`,
      url: `https://tenor.com/view/gif-${i}`,
      itemId: `item-${i}`,
      messageId: `m-${i}`,
      placeId: 'c1',
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
  store.findGif = (handle: string) => findGif(library.gifs, handle);
  store.ownGifs = [];
  store.recordOwnGif = (placeId: string, key: string, ts: number) => store.ownGifs.push({ placeId, key, ts });
  return store;
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
      media: { maxPerTurn: 6, filePreviewChars: 500, pick: pickSettings },
      models: { base: { analyzer: 'cheap/classifier' } },
      ...(typing ? { typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], ...typing } } : {}),
    }
  );
  declarePick();
  Object.assign(hot.prompts, { 'media-pick': GIF_PICK_PROMPT }, prompts);
  for (const [name, text] of Object.entries(prompts)) if (text === null) delete hot.prompts[name];
  return hot;
}

async function runPickTurn({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  pick = '{"pick":"none","name":null}',
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
  const picks = llm.calls.filter((call) => call.options?.purpose === 'media-pick');
  const sent = () => channel.sent.map((payload) => payload.content);
  const limits = recorded?.lines.find(({ record }) => record.kind === 'turn')?.record.limits ?? null;
  return { result, logs, channel, picks, store, sent, sendTimes, startedAt, limits };
}

// B7: the classifier reads the search's candidates, one text with no cached part, and answers `gif <handle>`.
test('runTurn: a short reply is shown with its candidates; a picked handle posts that GIF and no text', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { result, logs, channel, picks, store, sent } = await runPickTurn({ pick: '{"pick":"gif","name":"G50"}' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(picks.length, 1, 'one pick request');
  const [system, user] = picks[0].messages;
  assert.deepEqual(system, { role: 'system', content: 'Pick a GIF for what Bot wrote.' });
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
    'the candidates lead the request, the reply ends it'
  );
  const gifLines = blocks[0]
    .replace(/^<gifs>\n/, '')
    .replace(/\n<\/gifs>$/, '')
    .split('\n');
  assert.equal(gifLines.length, PICK_LIBRARY_SIZE, 'up to the cap');
  assert.deepEqual(
    [gifLines[0], gifLines.at(-1)],
    ['g1 -- ναι χα λεζάντα 1', 'g50 -- ναι χα λεζάντα 50'],
    'equal scores in use order'
  );
  const { options } = picks[0];
  assert.deepEqual(
    [options.role, options.purpose, options.maxOutputTokens, options.model, options.countAgainstDailyCap],
    ['analyzer', 'media-pick', 17, 'cheap/classifier', true]
  );

  assert.deepEqual(sent(), ['https://tenor.com/view/gif-50'], 'the GIF, no text');
  assert.equal(channel.sent[0].reply?.messageReference, 'm1', 'replying where the first message would have');
  // B7: her own post counts on the place it went to, the channel.
  assert.deepEqual(store.ownGifs, [{ placeId: 'c1', key: 'k50', ts: NOW }]);
  const picked = logs.find((entry) => entry.msg === 'media-pick: answered');
  assert.deepEqual([picked?.channel, picked?.kind, picked?.gifs], ['c1', 'gif', PICK_LIBRARY_SIZE]);
  assert.equal(
    JSON.stringify(logs.filter((entry) => entry.msg.startsWith('media-pick:'))).includes('λεζάντα'),
    false,
    'counts only'
  );
});

test('runTurn: the pick leaves out uncaptioned GIFs and acts only on a listed handle', async () => {
  const library = pickLibrary();
  delete library.gifs.entries.k7.caption;
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { picks, sent, logs } = await runPickTurn({
    store: pickStore({ library }),
    pick: '{"pick":"gif","name":"g7"}',
  });
  assert.equal(textOf(picks[0].messages[1].content).includes('g7 --'), false, 'g7 has no caption');
  assert.deepEqual(sent(), ['ναι, φυσικά, έλα'], 'an unlisted handle posts the text');
  const picked = logs.find((entry) => entry.msg === 'media-pick: answered');
  assert.deepEqual([picked?.kind, picked?.gifs], ['none', PICK_LIBRARY_SIZE - 1]);
});

test('runTurn: the pick answering none or something unreadable posts the text', async () => {
  for (const pick of ['none', 'gif g3 maybe']) {
    const { picks, sent, logs } = await runPickTurn({ pick });
    assert.equal(picks.length, 1, pick);
    assert.deepEqual(sent(), ['ναι, φυσικά, έλα'], pick);
    assert.equal(logs.find((entry) => entry.msg === 'media-pick: answered')?.kind, 'none', pick);
  }
});

test('runTurn: a failed pick request logs media-pick: failed and posts the text', async () => {
  const { sent, logs } = await runPickTurn({
    pick: () => {
      throw Object.assign(new Error('upstream'), { statusCode: 503 });
    },
  });
  assert.deepEqual(sent(), ['ναι, φυσικά, έλα']);
  assert.equal(logs.find((entry) => entry.msg === 'media-pick: failed')?.status, 503);
});

// B7: the case of a turn posting its own GIF went with `<gif>`, which tests/parse-gif-retired.test.ts holds retired.
test('runTurn: no pick for a reply over maxChars', async () => {
  const text = 'α'.repeat(161);
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const long = await runPickTurn({ reply: `<msg>${text}</msg>`, pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(long.picks.length, 0, 'over maxChars');
  assert.deepEqual(long.sent(), [text]);
  // B7: a word of the reply finds the candidates.
  const fits = await runPickTurn({ reply: `<msg>ναι ${'α'.repeat(156)}</msg>`, pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(fits.picks.length, 1, 'exactly maxChars is still picked for');
});

test('runTurn: no pick without the prompt or without a captioned GIF', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const noPrompt = await runPickTurn({ pick: '{"pick":"gif","name":"g1"}', prompts: { 'media-pick': null } });
  assert.equal(noPrompt.picks.length, 0, 'no prompts/media-pick.md');
  const empty = await runPickTurn({
    pick: '{"pick":"gif","name":"g1"}',
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
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { picks, sent, channel, store } = await runPickTurn({ reply, pick: '{"pick":"gif","name":"g50"}' });
  assert.equal(picks.length, 1, 'only the first message counts toward the longest it may replace');
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
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { sent, channel, logs, store } = await runPickTurn({
    reply,
    pick: '{"pick":"gif","name":"g50"}',
    failGif: true,
  });
  assert.ok(
    logs.some((entry) => entry.msg === 'turn: gif failed'),
    'the failed GIF is logged'
  );
  assert.deepEqual(sent(), ['χα', 'τέλος'], 'nothing is lost');
  assert.equal(channel.sent[0].reply?.messageReference, 'm1', 'the first message replies as written');
  assert.deepEqual(store.ownGifs, [], 'no own post recorded');
});

test('runTurn: the longest message the pick replaces gates the first message only', async () => {
  const first = 'και κάτι ακόμα πιο μακρύ ' + 'α'.repeat(160);
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const long = await runPickTurn({ reply: `<msg>${first}</msg><msg>χα</msg>`, pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(long.picks.length, 0, 'a long first message is never replaced');
  assert.deepEqual(long.sent(), [first, 'χα']);
});

test("runTurn: the picker runs alongside the first message's typing time", async () => {
  let askedAt = null;
  const pick = () => {
    askedAt = Date.now();
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    return new Promise((resolve) => setTimeout(() => resolve('{"pick":"none","name":null}'), 150));
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
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const slow = () => new Promise((resolve) => setTimeout(() => resolve('{"pick":"gif","name":"g50"}'), 1400));
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
  const entry = late.logs.find((log) => log.msg === 'media-pick: late');
  assert.deepEqual([entry?.channel, entry?.graceMs], ['c1', 1000]);
  assert.deepEqual(late.store.ownGifs, [], 'nothing posted or stamped');
  assert.ok(
    late.limits.some((limit: Untyped) => limit.kind === 'helper-timeout' && limit.where === 'media-pick'),
    'the turn record names the picker'
  );

  const graced = await runPickTurn({
    reply: '<msg>ναι</msg>',
    pick: () => new Promise((resolve) => setTimeout(() => resolve('{"pick":"gif","name":"g50"}'), 400)),
    typing,
  });
  assert.deepEqual(
    graced.sent(),
    ['https://tenor.com/view/gif-50'],
    'an answer inside the grace still replaces the text'
  );
  assert.equal(
    graced.logs.some((log) => log.msg === 'media-pick: late'),
    false
  );
});

test('runTurn: a picker that answered during the typing is used', async () => {
  const quick = await runPickTurn({
    reply: '<msg>ναι</msg>',
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    pick: '{"pick":"gif","name":"g50"}',
    typing: { msPerChar: [0, 0], minMs: 60, maxMs: 60 },
  });
  assert.deepEqual(quick.sent(), ['https://tenor.com/view/gif-50']);
  assert.equal(
    quick.logs.some((log) => log.msg === 'media-pick: late'),
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
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const llm = pickLlm({ reply: '<msg reply="#2">ναι, φυσικά, έλα</msg>', pick: '{"pick":"none","name":null}' });
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
  return llm.calls.filter((call) => call.options?.purpose === 'media-pick').map((call) => call.messages[1].content);
}

/** The persona posted g40 at `at`, and it was used enough to lead the ranking. */
const postG40 = (at: number) => (gifs: Untyped) =>
  Object.assign(gifs.entries.k40, {
    ownLast: at,
    ownUses: 1,
    count: 500,
    last: at,
    // B7: her own posts are read per place.
    places: { c1: { count: 500, last: at, ownLast: at, ownUses: 1 } },
  });

// B7: the candidates change with each reply, so nothing of the request is held per cache bucket any more.
test('runTurn: her post and its age go to <gifs_recent>, the tail of the next pick', async () => {
  const first = NOW + 60_000;
  const second = NOW + 7 * 60_000;
  const [a, b] = await twoPickTurns({ times: [first, second], between: postG40(first + 1000) });
  assert.equal(a.includes('<gifs_recent>'), false, 'no recent post before it');
  const recent = fill(labels.gifs.ownMark, { ago: formatDuration(second - (first + 1000), labels.units) });
  assert.ok(b.includes(`<gifs_recent>\ng40 ${recent}\n</gifs_recent>\n\n<context>\n`), 'the post and its age');
  assert.equal(b.split('</gifs>')[0].includes('(you'), false, 'no own-post mark in the candidates');
});

test('runTurn: the next pick reads the library as it stands', async () => {
  const first = NOW + 60_000;
  const [, next] = await twoPickTurns({ times: [first, first + 60_000], between: postG40(first + 1000) });
  assert.ok(next.startsWith('<gifs>\ng40 -- ναι χα λεζάντα 40\n'), 'reranked at once');
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
    if (asRecord(ref).chatId === channel.id) fetchedIds.push(...ids);
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

test('createTurnRunner: the window asks the parents of every line and shows them in <chat> before the window', async () => {
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
  // Slice 4: a reply has no `<earlier>`, its reply parents stay in `<chat>` before the window, numbered first.
  assert.ok(!userMessage.includes('<earlier>'));
  assert.ok(
    ['pa', 'pb', 'pc'].every((id, i) => block('chat').includes(`#${i + 1} [10:00] Bob: γονέας ${id}`)),
    block('chat')
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
    writeJournalLines: (write: JournalLinesWrite) => {
      // Legacy labels are fixture export projections of the actual place and day.
      for (const line of write.lines)
        lines.push({ file: journalLineLabel('fake-data', write.placeId, line), record: line });
      return mem.memoryDb.writeJournalLines(write);
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

/** Slice 4: a reply's memory comes from the graph reader: Alice (u1) and her fact, stored as the writers store them. */
function aliceMind() {
  const mind = openWorld();
  OPENED_MEMORY.push({ close: async () => mind.close() });
  const accounts = [{ id: 'account:alice', iface: 'discord', native: 'u1', names: ['Alice'] }];
  addPerson(mind.db, { id: 'person:alice', accounts });
  addClaim(mind.db, {
    id: 'claim:lyon',
    person: 'person:alice',
    kind: 'fact',
    text: 'lives in Lyon',
    audience: { group: 'discord' },
  });
  return () => mind.db;
}

test('turn: the memory rows the request carried go to the memoryReads hook with the journal turn id', async () => {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
  const journalDb = aliceMind();
  const run = async ({ memoryReads }: Untyped) => {
    const hot = fakeHot({}, {}, { llm: { maxRequestTokens: 50000, safetyMargin: 0.9, maxOutputTokens: 700 } });
    const { journal: journalOver } = journalOverMemory();
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot,
      store: fakeStore(),
      llm: usageLlm('<think>x</think><msg reply="#1">γεια</msg>', () => 700),
      calibrator: identityCalibrator(),
      client: fakeClient(),
      journal: journalOver,
      memoryReads,
      journalDb,
      memoryContext: () => ({ iface: 'discord', kind: 'group' }),
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
  assert.ok(calls[0].placeId);
  // Slice 4: the hook records the entries `<memory>` shows, each by its table and row.
  assert.ok(calls[0].reads.some((read: Untyped) => read.kind === 'claims' && read.id === 'claim:lyon'));

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
    // The store's place of the chat, as `placeOfChat` reads it from its row.
    store: Object.assign(fakeStore(), { placeOfChat: () => 'place:room-1' }),
    llm: usageLlm('<think>x</think><msg reply="#1">γεια</msg>', () => 700),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    journal,
    // Slice 4: the memory rows come from the graph reader.
    journalDb: aliceMind(),
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
  // The expectation changed with the ids-by-links plan (slice 6): the destination is the place the store holds for the
  // chat, never one spelled from the chat id.
  assert.deepEqual(issued[0], { kind: 'group', destination: 'place:room-1' });
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
  // Stage U adds the standard's counts, and this think is in Greek.
  assert.deepEqual(turn.format, {
    thinkMissing: 0,
    coerced: 0,
    malformed: 0,
    truncated: 0,
    thinkLeaked: 0,
    leakEnded: 0,
    tagInOutgoing: 0,
    thinkOffScript: 1,
    capped: 0,
    held: 0,
  });
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

// ---- the record (src/memory/record.ts): the persona's posted lines ----

test('turn: a successful post writes a said line', async () => {
  const earlier = rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Zoé', ts: NOW - 5000, content: 'καλημέρα' });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [earlier, raw] });
  const appended: Array<{ placeId: Untyped; lines: Untyped; opts: Untyped }> = [];
  const record = {
    append: async (placeId: string, lines: Untyped, opts: unknown) => {
      appended.push({ placeId, lines, opts });
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
  assert.equal(appended[0].placeId, 'g1');
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
// current chat, refused only under the full stop) and made through the interface port.

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
    { iface: 'fake', chatId: 'c1' },
    {
      text: 'γεια σου <@u1>',
      replyTo: { iface: 'fake', chatId: 'c1', messageId: 'm1' },
      // The lead: the mentions carry `asked` since silent mode pings only the members who chose `on` (owner, 2026-11-06).
      // Nobody chose a state here.
      mentions: { users: ['u1'], repliedUser: true, asked: { users: [], repliedUser: false } },
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
  const declared = port.capabilities.bind(port);
  Object.assign(port, { capabilities: () => ({ ...declared(), mediaPick: { gifForms: ['link'] } }) });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'draw me a cat' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const images = fakeImages();
  const gatewayLlm = sequenceLlm([
    toolAnswer('<msg>χα</msg>', [call('draw.create', { reply: '#1', text: 'a cat on a roof' })]),
    '<skip/>',
  ]);
  const turns = createTurnRunner({
    discord: DISCORD,
    // B7: the GIF is the media pick's, on a port that declares it.
    hot: withPick(drawHot()),
    store: gifStore(),
    llm: {
      complete: (messages: Untyped, options: Untyped) =>
        options?.purpose === 'media-pick'
          ? // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
            Promise.resolve({ text: '{"pick":"gif","name":"g1"}', usage: {}, estimated: 1 })
          : gatewayLlm.complete(messages, options),
    },
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
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(gatewayLlm.calls.length, 2, 'the picture came back to her and she stayed silent');
  const [picture, gif] = sends;
  assert.deepEqual(
    gif,
    { text: 'https://tenor.com/view/chat-qui-danse-1' },
    'the GIF as its URL, mentions none, after the picture her call made'
  );
  assert.equal(asRecord(picture).attachments.length, 1);
  assert.equal(asRecord(picture).attachments[0].name, 'image.png');
  assert.ok(Buffer.isBuffer(asRecord(picture).attachments[0].data));
  assert.deepEqual(asRecord(picture).replyTo, { iface: 'fake', chatId: 'c1', messageId: 'm1' });
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
 * `tools.chats` list; the LLM answers `answers` in
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
  selfreflection = null,
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
    // The owner is `bot.ownerPerson` with these accounts bound to it; no owners, no owner person.
    (owners as Array<string>).length === 0
      ? { access: personaGrants(allowed) }
      : { ownerPerson: OWNER_PERSON, access: personaGrants(allowed) },
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
    isServedRoot: (id: unknown) => id === 'g1',
    reads: world().adopt(port),
    port,
    ...(images ? { images } : {}),
    ...(selfreflection ? { selfreflection: selfreflection(hot) } : {}),
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
    .map((call): Record<string, Untyped> => ({ to: asRecord(call.args[0]).chatId, ...asRecord(call.args[1]) }));
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

test('skill call: message.create to another channel where the bot may send runs before her reply, journaled proposed, started, succeeded, with its invocation id; her speech goes out after it and the post comes back to her in one step', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await callTurn({
    answers: [
      toolAnswer('<msg reply="#2">εντάξει</msg>\n', [
        call('message.create', { place: '#🍡νέα', text: 'καλημέρα :wave:' }),
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
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(run.llm.calls.length, 2, 'the post came back to her in one step, where she stayed silent');
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
    // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
    answers: [toolAnswer(``, [call('message.create', { place: `#νέα`, text: `${written}` })]), '<skip/>'],
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
    // The lead: `asked` names who chose `on`, nobody in this test (owner, 2026-11-06).
    { users: ['u1'], repliedUser: false, asked: { users: [], repliedUser: false } },
    'only the resolved member is notified'
  );
  // A reply keeps working, its author notified as before.
  const replied = await callTurn({
    answers: [toolAnswer(``, [call('message.create', { reply: `#2`, text: `${alice} :dance:` })]), '<skip/>'],
    emoji: fakeEmojiIndex(),
  });
  assert.deepEqual(
    replied.sends.map((send) => [send.to, send.text, send.replyTo?.messageId, send.mentions]),
    [
      [
        'c1',
        '<@u1> <a:dance:222222222222222222>',
        'm1',
        { users: ['u1'], repliedUser: true, asked: { users: [], repliedUser: false } },
      ],
    ]
  );
  // Pings off: the mention stays in the text and notifies nobody.
  const quiet = await callTurn({
    answers: [toolAnswer(``, [call('message.create', { place: `#νέα`, text: `${alice}` })]), '<skip/>'],
    allowed: ['message.create'],
    store: storeWithPingsOff(['u1']),
  });
  assert.deepEqual(
    quiet.sends.map((send) => [send.text, send.mentions]),
    [['<@u1>', { users: [], repliedUser: false, asked: { users: [], repliedUser: false } }]]
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
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(edited.llm.calls.length, 2, 'the edit came back to her in one step');
});

// The expectation changed on 2026-11-08: the owner's rule of 2026-10-20 (#314) shows her a quiet call's outcome in one
// step when the turn answers someone. The switch to the step engine (fe2828e7) dropped it, so an edit she made on
// request ended the turn with Discord showing her typing and nothing said.
test('skill call: a quiet success in an addressed turn is shown to her in one step; a turn nobody asked for ends with it', async () => {
  const addressed = await callTurn({
    answers: [
      toolAnswer('', [call('message.edit', { message: '#1', text: 'διορθωμένη' })]),
      '<msg>έγινε, διόρθωσα</msg>',
    ],
    allowed: ['message.edit'],
  });
  assert.equal(addressed.result.outcome, 'spoke');
  assert.equal(addressed.llm.calls.length, 2, 'the edit came back to her in a second request');
  assert.deepEqual(
    addressed.sends.map((send) => send.text),
    ['έγινε, διόρθωσα']
  );
  assert.equal(addressed.result.delivered, true, 'the edit went out');
  const silent = await callTurn({
    answers: [toolAnswer('', [call('message.edit', { message: '#1', text: 'διορθωμένη' })]), '<skip/>'],
    allowed: ['message.edit'],
  });
  const { calls: silentCalls } = silent.llm;
  assert.equal(silentCalls.length, 2);
  assert.deepEqual(silent.sends, [], 'she may stay silent after seeing it');
  // One step, as the rule of 2026-10-20 gave: a quiet call she makes in the shown step ends the turn with it.
  const twice = await callTurn({
    answers: [
      toolAnswer('', [call('message.edit', { message: '#1', text: 'διορθωμένη' })]),
      toolAnswer('', [call('message.edit', { message: '#1', text: 'ξανά διορθωμένη' })]),
      '<msg>δεν θα ζητηθεί</msg>',
    ],
    allowed: ['message.edit'],
  });
  const { calls: twiceCalls } = twice.llm;
  assert.equal(twiceCalls.length, 2, 'the quiet call of the shown step is not shown again');
  const task = {
    id: 'tabc',
    agent: 'scout',
    state: 'done',
    goal: 'find a meme',
    requester: { accountId: null, kind: 'persona' },
    origin: { placeId: 'c1', messageId: null },
    result: { text: 'found', files: [] },
  };
  const spontaneous = await callTurn({
    answers: [
      toolAnswer('<msg>κι αυτό</msg>', [call('message.create', { place: '#🍡νέα', text: 'να το' })]),
      '<msg>δεν θα ειπωθεί</msg>',
    ],
    allowed: ['message.create'],
    turnExtra: { mode: 'interject', trigger: null, triggerKind: 'errand', taskResult: task },
  });
  assert.equal(spontaneous.llm.calls.length, 1);
  assert.deepEqual(
    spontaneous.sends.map((send) => send.text),
    ['να το', 'κι αυτό']
  ); // An errand's result turn quotes the message that asked for the errand as its trigger, and still nobody waits for it:
  // the errand's own outcome is what she reports, a quiet call ends the turn.
  const result = await callTurn({
    answers: [
      toolAnswer('<msg>βρήκα</msg>', [call('message.create', { place: '#🍡νέα', text: 'να το' })]),
      '<msg>δεν θα ειπωθεί</msg>',
    ],
    allowed: ['message.create'],
    turnExtra: { triggerKind: 'errand', taskResult: { ...task, requester: { accountId: 'u1', kind: 'owner' } } },
  });
  const { calls: resultCalls } = result.llm;
  assert.equal(resultCalls.length, 1, 'an errand result turn with a trigger ends with the call');
  assert.deepEqual(
    result.sends.map((send) => send.text),
    ['να το', 'βρήκα']
  );
});

test('skill call: a call alone is no skip; here it needs no grant and replies to a line of this chat', async () => {
  const here = await callTurn({
    answers: [toolAnswer('', [call('message.create', { reply: '#2', text: 'ναι' })]), '<skip/>'],
  });
  assert.equal(here.result.outcome, 'spoke');
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  const { calls: hereCalls } = here.llm;
  assert.equal(hereCalls.length, 2, 'the post came back to her and she stayed silent');
  // The current chat: carried over, the replied author notified.
  assert.deepEqual(
    here.sends.map((send) => [send.to, send.text, send.replyTo?.messageId, send.mentions.repliedUser]),
    [['c1', 'ναι', 'm1', true]]
  );
  // A reply target outside the channel she named. Contract change: message.create no longer takes the reply's channel over a destination she named. That substitution posted a reply in another channel than the one she chose. A mismatch is refused unknown-message (chat), nothing sent; react, edit and delete keep the rule because their channel only locates the message they act on.
  const across = await callTurn({
    answers: [
      toolAnswer('', [call('message.create', { place: '#νέα', reply: '#2', text: 'ναι' })]),
      '<msg>όχι τελικά</msg>',
    ],
    allowed: ['message.create'],
  });
  assert.deepEqual(
    across.sends.map((send) => [send.to, send.text]),
    [['c1', 'όχι τελικά']]
  );
});

test('skill call: not granted, or a channel where the bot may not send -- refused with a result, her speech held; the corrected call and her words go out in the next answer', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await callTurn({
    answers: [
      toolAnswer('<msg>μισό</msg>', [call('message.create', { place: '#νέα', text: 'γεια' })]),
      toolAnswer('<msg>δεν μπορώ εκεί</msg>', [call('message.create', { text: 'ξανά' })]),
      '<skip/>',
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
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(run.llm.calls.length, 3, 'the refusal came back, then the post that worked, where she stayed silent');
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
    answers: [toolAnswer('', [call('message.create', { place: '#αλλού', text: 'γεια' })]), '<skip/>'],
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
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(edited.llm.calls.length, 2);
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
    requester: { accountId: null, kind: 'persona' },
    origin: { placeId: 'c1', messageId: null },
    result: { text: 'found', files: [] },
  };
  const answer = toolAnswer('', [call('message.create', { place: '#🍡νέα', text: 'να το' })]);
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
      taskResult: { ...task, requester: { accountId: null, kind: 'member' } },
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
    answers: [toolAnswer('', [call('message.create', { place: '#νέα', text: 'γεια' })]), '<skip/>'],
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
      toolAnswer('<msg>γεια</msg>', [call('message.create', { place: '#νέα', text: 'γεια' })]),
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
      toolAnswer('', [call('draw.create', { place: '#νέα', text: 'a lighthouse at dusk' })]),
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
    answers: [toolAnswer('', [call('draw.create', { place: '#νέα', text: 'a lighthouse' })]), '<skip/>'],
    allowed: ['draw.create'],
    images: withFamily(fakeImages()),
  });
  assert.deepEqual(
    delivered.sends.map((send) => [send.to, send.attachments.length]),
    [['c9', 1]]
  );
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(delivered.llm.calls.length, 2, 'the picture came back to her in one step, where she stayed silent');
});

test('skill call: a call that did not work comes back as a result with its reason, her speech is held, the corrected call goes through and the journal keeps both', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await callTurn({
    // The live failure: a deletion announced, called without the message to delete.
    answers: [
      toolAnswer('<msg>σβήνω και το ξαναγράφω</msg>', [call('message.delete')]),
      toolAnswer('<msg>έσβησα το πρώτο</msg>', [call('message.delete', { message: '#1' })]),
      '<skip/>',
    ],
    allowed: ['message.delete'],
    journal,
  });
  assert.equal(run.result.outcome, 'spoke');
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step.
  assert.equal(
    run.llm.calls.length,
    3,
    'the refusal came back, then the deletion that worked, where she stayed silent'
  );
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
  // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: the deletion that worked is shown to her in a second step.
  assert.equal(turn.steps, 2);
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
  // Stage U: a reply with no think is handed on with an empty one.
  assert.equal(assistant.content, '<think></think><msg>κοιτάζω</msg>');
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
    { ownerPerson: OWNER_PERSON, access: personaGrants(allowed) },
    { tools: { safeMode: false, resultMaxChars: 2000 } }
  );
  const store = fakeStore();
  const client = fakeClient();
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
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
function ownRaw(port: Untyped, placeId: string, ts: number) {
  const [message] = port
    .messagesIn(placeId)
    .filter((m: Untyped) => m.authorId === 'self-id' && !['m0'].includes(m.ref.messageId));
  return {
    ...rawMessage({ id: message.ref.messageId, ts, authorId: 'self-id', authorName: 'Bot', content: message.text }),
    placeId,
  };
}

/** The `<chat>` block of the LLM's last request. */
function lastChat(llm: Untyped) {
  const text = textOf(llm.calls.at(-1)[1].content);
  return text.slice(text.indexOf('<chat>'), text.indexOf('</chat>'));
}

test('call marks: a later turn shows the call as a line of its own after her line of the turn that made it; the post there names where it came from', async () => {
  const scene = callMarkScene({
    answers: [
      toolAnswer('<msg reply="#2">εντάξει</msg>\n', [call('message.create', { place: '#🍡νέα', text: 'καλημέρα' })]),
      '<skip/>',
    ],
  });
  const first = await scene.run(scene.channel, scene.history[1]);
  assert.equal(first.result.outcome, 'spoke');
  const [posted] = scene.port.calls.filter((call) => call.op === 'send');
  assert.equal(asRecord(posted.args[0]).chatId, 'c9', 'her call ran first');
  const here = ownRaw(scene.port, 'c1', NOW);
  const there = ownRaw(scene.port, 'c9', NOW);
  scene.clock.ms = NOW + 60_000;
  const m2 = rawMessage({ id: 'm2', ts: NOW + 30_000, authorName: 'Alice', content: 'και;' });
  scene.history.push(here, m2);
  await scene.run(scene.channel, m2);
  const chat = lastChat(scene.llm);
  const chatLines = chat.split('\n');
  const mark = chatLines[chatLines.findIndex((text) => text.includes('εντάξει')) + 1];
  // Slice 2 (a), (c): the mark is a line of its own after her line, says where she called from, and has no posted link.
  assert.equal(mark, '[12:00] Bot (you): [called message.create from #general: done]', chat);
  assert.equal(chat.match(/\[called /g)?.length, 1, chat);

  // In #💖νέα her post says which channel's turn posted it; the call itself is not shown there.
  const n1 = { ...rawMessage({ id: 'n1', ts: NOW + 30_000, authorName: 'Alice', content: 'γεια' }), placeId: 'c9' };
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
    answers: [toolAnswer('', [call('message.create', { place: '#🍡νέα', text: 'γεια' })]), '<skip/>'],
  });
  await scene.run(scene.channel, scene.history[1]);
  // Slice 2 (c): the mark carries no posted link, so her post in #νέα is checked here instead of read for its id.
  assert.ok(ownRaw(scene.port, 'c9', NOW).id, 'her call posted in #νέα');
  scene.clock.ms = NOW + 60_000;
  const m2 = rawMessage({ id: 'm2', ts: NOW + 30_000, authorName: 'Alice', content: 'και;' });
  scene.history.push(m2);
  await scene.run(scene.channel, m2);
  const chat = lastChat(scene.llm);
  // Slice 2 (c): the mark says where she called from and carries no target channel and no posted link.
  const standalone = '[12:00] Bot (you): [called message.create from #general: done]';
  const lines = chat.split('\n');
  const at = lines.indexOf(standalone);
  assert.ok(at > 0, chat);
  assert.ok(lines[at - 1].includes('γράψε στο #νέα'), 'right after the last line before the call');
  assert.ok(lines[at + 1].includes('και;'));
});

test('call marks: a refused call shows its status and why on its own line after the line its turn posted', async () => {
  const scene = callMarkScene({
    answers: [
      toolAnswer('<msg>μια στιγμή</msg>', [call('message.create', { place: '#🍡νέα', text: 'γεια' })]),
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
  const chatLines = lastChat(scene.llm).split('\n');
  const line = chatLines[chatLines.findIndex((text) => text.includes('μια στιγμή')) + 1];
  const status = fill(labels.transcript.callStatusReason, {
    status: labels.transcript.callStatus.denied,
    reason: labels.tools.result.reasons['not-allowed'],
  });
  // Slice 2 (a), (c): the mark is a line of its own after her line and says `from #general`, where she called from.
  assert.ok(line?.endsWith(`[called message.create from #general: ${status}]`), chatLines.join('\n'));
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
  const chatLines = lastChat(scene.llm).split('\n');
  const line = chatLines[chatLines.findIndex((text) => text.includes('μια στιγμή')) + 1];
  const status = fill(labels.transcript.callStatusReason, {
    status: labels.transcript.callStatus.invalid,
    reason: fill(labels.transcript.callReasons['missing-arg'], { arg: 'message' }),
  });
  // Slice 2 (a), (c): the mark is a line of its own after her line and says `from #general`, where she called from.
  assert.ok(line?.endsWith(`[called message.delete from #general: ${status}]`), chatLines.join('\n'));
});

test('call marks: seeded from the journal after a restart, the calls show as they did; unseeded, nothing shows', async () => {
  const { journal, lines } = journalOverMemory();
  const scene = callMarkScene({
    answers: [
      toolAnswer('<msg reply="#2">εντάξει</msg>\n', [call('message.create', { place: '#🍡νέα', text: 'καλημέρα' })]),
      '<skip/>',
    ],
    journal,
  });
  await scene.run(scene.channel, scene.history[1]);
  // Slice 2 (c): the mark carries no posted link, so her post in #νέα is checked here instead of read for its id.
  assert.ok(ownRaw(scene.port, 'c9', NOW).id, 'her call posted in #νέα');
  scene.history.push(ownRaw(scene.port, 'c1', NOW));
  const m2 = rawMessage({ id: 'm2', ts: NOW + 30_000, authorName: 'Alice', content: 'και;' });
  scene.history.push(m2);
  scene.clock.ms = NOW + 60_000;

  const restarted = scene.runner();
  restarted.seedCallMarks(callMarksOf((lines as Array<{ record: object }>).map(({ record }) => record)));
  await scene.run(scene.channel, m2, restarted);
  const chatLines = lastChat(scene.llm).split('\n');
  const line = chatLines[chatLines.findIndex((text) => text.includes('εντάξει')) + 1];
  // Slice 2 (a), (c): the mark is a line of its own after her line, says where she called from, and has no posted link.
  assert.equal(line, '[12:00] Bot (you): [called message.create from #general: done]', chatLines.join('\n'));

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
    chatId: string | null;
    dmChat: boolean;
    routed: boolean;
    mode: string | null;
    trigger: {
      id: string | null;
      authorId: string | null;
      placeId: string | null;
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
  // The end names the chat alone; the hook reads no top (plan 2026-11-05 T.4).
  assert.deepEqual(
    [end.chatId, end.dmChat, end.routed, end.mode, end.triggerKind, end.outcome, end.reason],
    ['c1', false, false, 'reply', 'mention', 'spoke', null]
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
    chatId: string | null;
    dmChat: boolean;
    routed: boolean;
    mode: string | null;
    trigger: {
      id: string | null;
      authorId: string | null;
      placeId: string | null;
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
    chatId: string | null;
    dmChat: boolean;
    routed: boolean;
    mode: string | null;
    trigger: {
      id: string | null;
      authorId: string | null;
      placeId: string | null;
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
    async *iterate(placeId: string, query: unknown) {
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
  assert.equal(queries[0].placeIds.length, 1, 'one channel');
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
test('runTurn: a picked GIF is posted after a hundred GIFs today, a stale gifs.maxPerDay in the config included', async () => {
  const run = await runPickTurn({
    reply: '<msg>χα</msg>',
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    pick: '{"pick":"gif","name":"g2"}',
    store: pickStore({ data: { gifDay: '2026-09-20', gifCount: 100 } }),
    maxPerDay: 3,
  });
  assert.deepEqual(run.sent(), ['https://tenor.com/view/gif-2']);
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
    hot.config.bot = { timezone: 'UTC', placeId: 'g1' };
    hot.config.private = { enabled: true, likeServer: true, minAffinity: 0 };
    const ownerRaw = rawMessage({
      id: 'owner-cancel',
      authorId: 'owner',
      content: 'find the distant private rabbit chat',
    });
    const owner = fakeTurnChannel({
      id: 'cli:dm:owner',
      dm: true,
      partnerId: 'owner',
      placeId: null,
      historyMessages: [ownerRaw],
    });
    const otherRaw = rawMessage({
      id: 'other-after-cancel',
      authorId: 'other',
      content: 'find the public rabbit chat',
    });
    const other = fakeTurnChannel({
      id: 'cli:dm:other',
      dm: true,
      partnerId: 'other',
      placeId: null,
      historyMessages: [otherRaw],
    });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot,
      // The DM partner `other` has a stored person, which the store answers; no person is spelled from a member id.
      store: {
        ...fakeStore(),
        personOfAccount: (account: string) => (account === 'other' ? 'person:cli:other' : null),
      },
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
        placeId: 'g1',
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
        placeId: 'g1',
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

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);
