// Tests for src/behavior/media-pick.ts: the media pick after a reply. Its settings, its strict JSON answer read
// against the offer, the GIF candidates of the shared library, the emoji forms with the place's ranked candidates
// and the two rails where 0 switches a rail off, and the one classifier request that covers GIFs and emoji
// together. An interface with no capability gets none.
import { test, beforeEach, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MEDIA_PICK_DEFAULTS,
  afterReply,
  applyEmojiPick,
  createMediaPick,
  mediaPickFormat,
  mediaPickSettings,
  openEmojiNames,
  parseMediaPick,
  pickContext,
  rankEmojiCandidates,
} from '../../../src/behavior/media-pick.ts';
import type { MediaPickArgs } from '../../../src/behavior/media-pick.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { labels } from '../../fixtures/labels.ts';
import { chainsOf, chainsOnDefaults } from '../../fixtures/chains.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { noMediaNames } from '../../fixtures/media-namer.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { freshWorld, world, onWorld, useIface, useSelf, worldChannels } from '../../fixtures/turn-world.ts';
import {
  NOW as MEDIA_PICK_EMOJI_TURN_NOW,
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from '../../fixtures/turn-kit.ts';
import type { RawMessage } from '../../fixtures/turn-kit.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowflakeUtil } from 'discord.js';
import { joinLabels } from '../../../src/config/labels.ts';
import { deepMerge } from '../../../src/config.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../../src/time.ts';
import { fill, formatDuration } from '../../../src/format.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { normalizeMessage, createDiscordAdapter, createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { declarePick, twoCaptionedGifs, pickLlm } from '../../fixtures/turn-pick.ts';
import { createCalibrator } from '../../../src/llm/tokens.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { between } from '../../../src/behavior/random.ts';
import { call } from '../../fixtures/tool-answers.ts';
import { findGif } from '../../../src/memory/gifs.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { openTestMemorySync, journalLineLabel } from '../../fixtures/memory-db/service.ts';
import type { JournalLinesWrite } from '../../../src/memory/db/journal-lines.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import '../../../src/tools/operations/index.ts';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOUR = 3_600_000;
const PLACE = 'place:room-1';
const ELSEWHERE = 'place:room-2';
const LINK_FORMS = { gifForms: ['file', 'link'] } as const;
const REPLY = [{ text: 'ναι, φυσικά, έλα', replyTo: 2 }];

test('the settings are read from media.pick and the rails take 0', () => {
  const settings = mediaPickSettings({
    media: {
      pick: { maxOutputTokens: 9.7, candidates: 12, emojiCandidates: 7, emojiPerReplies: 0, emojiCooldownMinutes: 0 },
    },
  });
  assert.equal(settings.maxOutputTokens, 9);
  assert.equal(settings.candidates, 12);
  assert.equal(settings.emojiCandidates, 7);
  assert.equal(settings.emojiPerReplies, 0);
  assert.equal(settings.emojiCooldownMinutes, 0);
});

test('an unusable setting takes its default and the old gifs.pick key is not read', () => {
  const unusable = mediaPickSettings({
    media: { pick: { maxOutputTokens: 0, candidates: 'πολλά', emojiPerReplies: -1, emojiCooldownMinutes: Number.NaN } },
    gifs: { pick: { maxOutputTokens: 9 } },
  });
  assert.equal(unusable.maxOutputTokens, MEDIA_PICK_DEFAULTS.maxOutputTokens);
  assert.equal(unusable.candidates, MEDIA_PICK_DEFAULTS.candidates);
  assert.equal(unusable.emojiPerReplies, MEDIA_PICK_DEFAULTS.emojiPerReplies);
  assert.equal(unusable.emojiCooldownMinutes, MEDIA_PICK_DEFAULTS.emojiCooldownMinutes);
});

const OFFERED = { gifs: ['g1', 'g50'], emoji: [], actions: [] };

test('`gif <handle>` names an offered GIF in any case and spacing', () => {
  assert.deepEqual(parseMediaPick('{"pick":"gif","name":"G50"}', OFFERED), { kind: 'gif', handle: 'g50' });
});

test('`none` and everything that is not the protocol read as none', () => {
  const none = { kind: 'none' };
  for (const answer of ['none', ' NONE\n', '', 'g1', 'gif', 'gif g9', 'gif g1\nnone', 'nothing', '<skip/>', null, 7]) {
    assert.deepEqual(parseMediaPick(answer, OFFERED), none, JSON.stringify(answer));
  }
});

// The pick over a fake model and a fake store.

/** A library entry: `text` is its description, what the search reads. */
function gifEntry(id: string, text: string | undefined, fields: object = {}) {
  return {
    id,
    kind: 'link',
    url: `https://tenor.com/view/${id}`,
    itemId: `item-${id}`,
    messageId: `m-${id}`,
    placeId: PLACE,
    count: 2,
    last: NOW - HOUR,
    firstSeen: NOW - 100 * HOUR,
    nativeIds: [`item-${id}`],
    links: [`https://tenor.com/view/${id}`],
    places: { [PLACE]: { count: 2, last: NOW - HOUR } },
    // A GIF is stored as one text.
    ...(text === undefined ? {} : { description: text }),
    ...fields,
  };
}

function libraryOf(...entries: Array<ReturnType<typeof gifEntry>>) {
  return {
    nextId: entries.length + 1,
    backfill: null,
    entries: Object.fromEntries(entries.map((entry) => [`k-${entry.id}`, entry])),
  };
}

const SHORT_LINE = {
  id: 'm1',
  ts: NOW - 1000,
  authorId: 'u1',
  authorName: 'Ζωή',
  self: false,
  content: 'θα έρθεις απόψε;',
  attachments: [],
  stickers: [],
  replyToId: null,
};

type RigOptions = {
  library?: ReturnType<typeof libraryOf>;
  answer?: string | (() => Promise<string>);
  embedQuery?: (text: string) => Promise<ArrayLike<number> | null>;
  pickConfig?: object;
  prompt?: string | null;
  gifMediaVectors?: ReadonlyMap<string, ArrayLike<number>>;
};

function rig({
  library = libraryOf(gifEntry('g1', 'ναι φυσικά γνέφει')),
  answer = '{"pick":"none","name":null}',
  embedQuery,
  pickConfig = {},
  prompt = 'Pick for {{name}}.',
  gifMediaVectors,
}: RigOptions = {}) {
  const calls: Array<{ messages: Array<{ role: string; content: unknown }>; options: Record<string, unknown> }> = [];
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
      media: { pick: { maxOutputTokens: 17, candidates: 5, ...pickConfig } },
    },
    prompts: { labels, ...(prompt === null ? {} : { 'classify/pick': prompt }) },
  };
  const rails = new Map<string, unknown>();
  const pick = createMediaPick({
    hot,
    store: {
      mediaNameOf: noMediaNames,
      getGifs: () => library,
      ...(gifMediaVectors ? { gifMediaVectors: () => gifMediaVectors } : {}),
      getEmojiRails: (placeId: string) => rails.get(placeId) ?? null,
      setEmojiRails: (placeId: string, state: unknown) => {
        rails.set(placeId, state);
      },
    },
    llm: {
      complete: async (messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>) => {
        calls.push({ messages, options });
        return { text: typeof answer === 'function' ? await answer() : answer };
      },
    },
    clock: () => NOW,
    ...(embedQuery ? { embedQuery } : {}),
  });
  return { pick, calls, hot, rails };
}

const args = (fields: object = {}) => ({
  // The chat by its place alone.
  placeId: PLACE,
  capability: LINK_FORMS,
  messages: REPLY,
  history: [SHORT_LINE],
  selfName: 'Νέα',
  emoji: [],
  emojiUsage: {},
  ...fields,
});

const NONE = { kind: 'none' };
const requestText = (call: { messages: Array<{ content: unknown }> }) => {
  const user = call.messages[1];
  return userText(user.content);
};

function blockOf(text: string, name: string): string | null {
  const found = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text);
  return found ? found[1] : null;
}

test('an interface without the capability yields no classifier call', async () => {
  const { pick: picker, calls } = rig();
  assert.deepEqual(await picker.pick(args({ capability: null })), NONE);
  assert.equal(calls.length, 0);
});

test('a chosen GIF comes back with its entry, replying where the first message would have', async () => {
  const { pick: picker, calls } = rig({ answer: '{"pick":"gif","name":"g1"}' });
  const result = await picker.pick(args());
  assert.equal(result.kind, 'gif');
  assert.ok(result.kind === 'gif');
  assert.equal(result.entry.id, 'g1');
  assert.equal(result.replyTo, 2);
  assert.equal(calls.length, 1);
});

test('the request goes out as one analyzer request under the media-pick purpose', async () => {
  const { pick: picker, calls } = rig();
  await picker.pick(args());
  const { options, messages } = calls[0];
  assert.deepEqual(
    [options.role, options.purpose, options.maxOutputTokens, options.model],
    ['analyzer', 'media-pick', 17, 'cheap/classifier']
  );
  assert.equal(messages[0].content, 'Pick for Νέα.');
});

test('`none` is the normal result and posts nothing', async () => {
  const { pick: picker, calls } = rig({ answer: '{"pick":"none","name":null}' });
  assert.deepEqual(await picker.pick(args()), NONE);
  assert.equal(calls.length, 1);
});

test('a GIF the request did not list is none, even when the library holds it', async () => {
  const { pick: picker } = rig({
    library: libraryOf(gifEntry('g1', 'ναι φυσικά'), gifEntry('g2', 'άσχετη λεζάντα')),
    answer: '{"pick":"gif","name":"g2"}',
  });
  assert.deepEqual(await picker.pick(args()), NONE);
});

test('the classifier sees the candidates, never the whole library', async () => {
  const many = Array.from({ length: 50 }, (_, index) => gifEntry(`g${index + 1}`, `ναι φυσικά ${index + 1}`));
  const { pick: picker, calls } = rig({ library: libraryOf(...many), pickConfig: { candidates: 3 } });
  await picker.pick(args());
  const listed = blockOf(requestText(calls[0]), 'gifs');
  assert.ok(listed);
  assert.equal(listed.split('\n').length, 3);
});

// A candidate's caption is shown whole.
test('a candidate line holds a 300-character caption whole', async () => {
  const caption = `ναι φυσικά ${'γνέφει αργά '.repeat(24)}τέλος`;
  assert.equal(caption.length, 304);
  const { pick: picker, calls } = rig({ library: libraryOf(gifEntry('g1', caption)) });
  await picker.pick(args());
  const listed = blockOf(requestText(calls[0]), 'gifs');
  assert.equal(listed, `g1 -- ${caption}`);
});

test('the cap is read at the moment of the pick', async () => {
  const many = Array.from({ length: 9 }, (_, index) => gifEntry(`g${index + 1}`, `ναι φυσικά ${index + 1}`));
  const { pick: picker, calls, hot } = rig({ library: libraryOf(...many), pickConfig: { candidates: 3 } });
  const media = hot.config.media;
  media.pick.candidates = 2;
  await picker.pick(args());
  assert.equal(String(blockOf(requestText(calls[0]), 'gifs')).split('\n').length, 2);
});

test('with no candidate there is no call', async () => {
  const { pick: picker, calls } = rig({
    library: libraryOf(gifEntry('g1', 'άσχετη λεζάντα'), gifEntry('g2', undefined)),
  });
  assert.deepEqual(await picker.pick(args()), NONE);
  assert.equal(calls.length, 0);
});

test('the request holds the chat line and the reply', async () => {
  const { pick: picker, calls } = rig();
  await picker.pick(args());
  const text = requestText(calls[0]);
  assert.match(String(blockOf(text, 'context')), /θα έρθεις απόψε;/);
  assert.match(String(blockOf(text, 'reply')), /ναι, φυσικά, έλα/);
});

test('a first message longer than the longest it may replace never reaches the classifier', async () => {
  const { pick: picker, calls } = rig();
  const long = 'ναι '.repeat(MEDIA_PICK_DEFAULTS.maxChars);
  assert.deepEqual(await picker.pick(args({ messages: [{ text: long, replyTo: null }] })), NONE);
  assert.equal(calls.length, 0);
});

test('a turn with no message or a blank first message never reaches the classifier', async () => {
  const { pick: picker, calls } = rig();
  await picker.pick(args({ messages: [] }));
  await picker.pick(args({ messages: [{ text: '  ', replyTo: null }] }));
  assert.equal(calls.length, 0);
});

test('without the prompt file there is no call', async () => {
  const { pick: picker, calls } = rig({ prompt: null });
  assert.deepEqual(await picker.pick(args()), NONE);
  assert.equal(calls.length, 0);
});

test('a classifier failure is none and never rejects', async () => {
  const { pick: picker } = rig({ answer: () => Promise.reject(new Error('http-500')) });
  assert.deepEqual(await picker.pick(args()), NONE);
});

test('an interface that posts files only is offered no GIF without a cached file', async () => {
  const library = libraryOf(gifEntry('g1', 'ναι φυσικά'), gifEntry('g2', 'ναι φυσικά', { file: 'media/gifs/h2.gif' }));
  const { pick: picker, calls } = rig({ library });
  await picker.pick(args({ capability: { gifForms: ['file'] } }));
  const listed = String(blockOf(requestText(calls[0]), 'gifs'));
  assert.match(listed, /g2/);
  assert.doesNotMatch(listed, /g1\b/);
});

test("the persona's recent posts are told by the place they went to", async () => {
  const library = libraryOf(
    gifEntry('g1', 'ναι φυσικά', { places: { [PLACE]: { count: 2, last: NOW, ownLast: NOW - HOUR, ownUses: 1 } } }),
    gifEntry('g2', 'ναι φυσικά', {
      places: {
        [PLACE]: { count: 2, last: NOW },
        [ELSEWHERE]: { count: 1, last: NOW, ownLast: NOW - HOUR, ownUses: 1 },
      },
    })
  );
  const { pick: picker, calls } = rig({ library });
  await picker.pick(args());
  const recent = String(blockOf(requestText(calls[0]), 'gifs_recent'));
  assert.match(recent, /g1/);
  assert.doesNotMatch(recent, /g2/);
});

test('the query vector finds a caption that shares no word, asked once', async () => {
  let asked = 0;
  // The vector is the ordinary media vector of the library row, by item id.
  const library = libraryOf(gifEntry('g1', 'γατάκι χορεύει'));
  const { pick: picker, calls } = rig({
    library,
    gifMediaVectors: new Map([['item-g1', [1, 0]]]),
    embedQuery: () => {
      asked += 1;
      return Promise.resolve([1, 0]);
    },
    answer: '{"pick":"gif","name":"g1"}',
  });
  const result = await picker.pick(args());
  assert.equal(result.kind, 'gif');
  assert.equal(asked, 1);
  assert.equal(calls.length, 1);
});

test('a failed embedding leaves the search by words', async () => {
  const { pick: picker } = rig({
    embedQuery: () => Promise.reject(new Error('http-500')),
    answer: '{"pick":"gif","name":"g1"}',
  });
  assert.equal((await picker.pick(args())).kind, 'gif');
});

// Bug: Anthropic refuses a strict schema whose field has a type array and an enum ("Enum value does not match
// declared type ['string', 'null']"), so every media pick on such a model fails with 400. A nullable choice is an
// enum that holds null, with no type array, which both providers accept.
test('the analyzer schemas name a nullable choice as an enum holding null, never a type array with an enum', async () => {
  const { mediaPickFormat } = await import('../../../src/behavior/media-pick.ts');
  const fields = (schema: unknown): Array<Record<string, unknown>> =>
    Object.values((schema as { properties: Record<string, Record<string, unknown>> }).properties);
  const all = fields(mediaPickFormat({ gifs: ['wave'], emoji: ['shrug'], actions: [] }).schema);
  const mixed = all.filter((field) => Array.isArray(field.type) && Array.isArray(field.enum));
  assert.deepEqual(mixed, []);
  const pickName = fields(mediaPickFormat({ gifs: ['wave'], emoji: [], actions: [] }).schema)[1];
  assert.deepEqual(pickName.enum, ['wave', null], 'null stays a choice');
});

// The shipped prompts against the contract of the media pick (prompts/, config/labels.json): the parser's words are in
// the pick's prompt, the persona's turn tells them of no tag the parser left behind, and `<skip/>` stays the
// persona's. A test of the protocol strings the code reads, never of the wording around them.

const shipped = (name: string): string =>
  fs.readFileSync(new URL(`../../../prompts/${name}.md`, import.meta.url), 'utf8');

test('the pick prompt names its blocks and its answers', () => {
  const prompt = shipped('classify/pick');
  for (const word of ['<context>', '<reply>', '<gifs>', '`none`', '`gif`']) {
    assert.ok(prompt.includes(word), word);
  }
});

test("the pick prompt never hands the classifier the word of the persona's turn or of a platform", () => {
  const prompt = shipped('classify/pick');
  assert.ok(!prompt.includes('<skip'), "<skip/> is only the persona's");
  assert.doesNotMatch(prompt, /\bdiscord\b|\bserver\b/i);
});

// The media pick's context (src/behavior/media-pick.ts#pickContext): the chat lines the classifier sees and the
// answered line among them. What a candidate is lives in the tests of the GIF library.

const NOW_CONTEXT = Date.UTC(2026, 9, 6, 12, 0, 0);

/** A chat line of the picker's history. */
function line(id: string) {
  return { id, ts: NOW_CONTEXT, authorName: 'Zoé', content: `λόγια ${id}` };
}

test('pickContext: the last contextMessages lines; the answered line among them is named by its place', () => {
  const history = ['m1', 'm2', 'm3', 'm4', 'm5'].map(line);
  const last = pickContext(history, { contextMessages: 3, answeredId: 'm5' });
  assert.deepEqual([last.messages.map((m) => m.id), last.answeredIndex], [['m3', 'm4', 'm5'], 3]);
  const inside = pickContext(history, { contextMessages: 3, answeredId: 'm4' });
  assert.deepEqual(
    [inside.messages.map((m) => m.id), inside.answeredIndex],
    [['m3', 'm4', 'm5'], 2],
    'not the last line'
  );
});

test('pickContext: an older answered line comes first, before the last lines', () => {
  const history = ['m1', 'm2', 'm3', 'm4', 'm5'].map(line);
  const older = pickContext(history, { contextMessages: 2, answeredId: 'm1' });
  assert.deepEqual([older.messages.map((m) => m.id), older.answeredIndex], [['m1', 'm4', 'm5'], 1]);
});

test('pickContext: an unknown answered line, none, or 0 context lines mark nothing', () => {
  const history = ['m1', 'm2', 'm3'].map(line);
  assert.deepEqual(pickContext(history, { contextMessages: 2, answeredId: 'elsewhere' }), {
    messages: history.slice(1),
    answeredIndex: null,
  });
  assert.deepEqual(pickContext(history, { contextMessages: 2 }), { messages: history.slice(1), answeredIndex: null });
  assert.deepEqual(pickContext(history, { contextMessages: 0, answeredId: 'm1' }), {
    messages: [],
    answeredIndex: null,
  });
  assert.deepEqual(pickContext(wrongly<Array<{ id?: unknown }>>(null), { contextMessages: 2, answeredId: 'm1' }), {
    messages: [],
    answeredIndex: null,
  });
});

// The emoji forms of the media pick.

const MINUTE = 60_000;
const RENDER = { still: '[[{name}|{id}]]', animated: '[[a|{name}|{id}]]' };
const EMOJI_CAPABILITY = { gifForms: [], emoji: { actions: ['append', 'replace'], render: RENDER } };

// The answer.

const EMOJI_OFFERED = { gifs: ['g1'], emoji: ['wave', 'Clap'], actions: ['append', 'replace'] };

test('`emoji <name>` and `replace <name>` name an offered emoji as it is listed', () => {
  assert.deepEqual(parseMediaPick('{"pick":"emoji","name":"WAVE"}', EMOJI_OFFERED), { kind: 'emoji', name: 'wave' });
  assert.deepEqual(parseMediaPick('{"pick":"replace","name":"clap"}', EMOJI_OFFERED), {
    kind: 'replace',
    name: 'Clap',
  });
});

test('an emoji that was not offered is none', () => {
  assert.deepEqual(parseMediaPick('{"pick":"emoji","name":"nope"}', EMOJI_OFFERED), NONE);
  assert.deepEqual(parseMediaPick('{"pick":"replace","name":"nope"}', EMOJI_OFFERED), NONE);
});

test('an action the interface does not support is none', () => {
  assert.deepEqual(parseMediaPick('{"pick":"replace","name":"wave"}', { ...EMOJI_OFFERED, actions: ['append'] }), NONE);
  assert.deepEqual(parseMediaPick('{"pick":"emoji","name":"wave"}', { ...EMOJI_OFFERED, actions: ['replace'] }), NONE);
});

test('two forms in one answer are none, so a reply never gets a GIF and an emoji in the same pass', () => {
  assert.deepEqual(parseMediaPick('gif g1\nemoji wave', EMOJI_OFFERED), NONE);
  assert.deepEqual(parseMediaPick('gif g1 emoji wave', EMOJI_OFFERED), NONE);
});

// The candidates.

const INVENTORY = [
  { id: '1', name: 'e1', platformName: 'wave', animated: false },
  { id: '2', name: 'e2', platformName: 'clap', animated: true },
  { id: '3', name: 'e3', platformName: 'nod', animated: false },
];
// The usage is keyed by the platform id and holds no name.
const USAGE = {
  '2': { count: 9, last: NOW },
  '1': { count: 3, last: NOW },
  gone: { count: 50, last: NOW },
};

test('the candidates are the most used emoji of the place, cut by the cap', () => {
  assert.deepEqual(
    rankEmojiCandidates(INVENTORY, USAGE, 2).map((emoji) => emoji.name),
    ['e2', 'e1']
  );
});

test('an emoji the interface no longer offers is no candidate, however used it was', () => {
  assert.ok(!rankEmojiCandidates(INVENTORY, USAGE, 10).some((emoji) => emoji.name === 'removed'));
});

test('an empty inventory or a cap of 0 has no candidate', () => {
  assert.deepEqual(rankEmojiCandidates([], USAGE, 5), []);
  assert.deepEqual(rankEmojiCandidates(INVENTORY, USAGE, 0), []);
});

// The rails.

const NAMES = ['e1', 'e2'];
const rails = (emojiPerReplies: number, emojiCooldownMinutes: number) => ({ emojiPerReplies, emojiCooldownMinutes });

test('with no history every emoji is open', () => {
  assert.deepEqual(openEmojiNames(null, NAMES, rails(3, 60), NOW), NAMES);
});

test('at most one emoji per N replies: closed for N - 1 replies after one, open at the Nth', () => {
  const settings = rails(3, 0);
  const withEmoji = afterReply(null, 'e1', NOW);
  assert.deepEqual(openEmojiNames(withEmoji, NAMES, settings, NOW), [], 'the reply right after');
  const onePlain = afterReply(withEmoji, null, NOW);
  assert.deepEqual(openEmojiNames(onePlain, NAMES, settings, NOW), [], 'the next one');
  const twoPlain = afterReply(onePlain, null, NOW);
  assert.deepEqual(openEmojiNames(twoPlain, NAMES, settings, NOW), NAMES, 'the third reply after it');
});

test('a per-replies rail of 1 allows an emoji on every reply', () => {
  assert.deepEqual(openEmojiNames(afterReply(null, 'e1', NOW), NAMES, rails(1, 0), NOW), NAMES);
});

test('the cooldown closes that emoji alone until the minute it ends', () => {
  const state = afterReply(null, 'e1', NOW);
  const settings = rails(0, 10);
  assert.deepEqual(openEmojiNames(state, NAMES, settings, NOW + 10 * MINUTE - 1), ['e2']);
  assert.deepEqual(openEmojiNames(state, NAMES, settings, NOW + 10 * MINUTE), NAMES);
});

test('0 in either rail switches that rail off, and 0 in both leaves everything open', () => {
  const state = afterReply(null, 'e1', NOW);
  assert.deepEqual(openEmojiNames(state, NAMES, rails(0, 0), NOW), NAMES);
  assert.deepEqual(openEmojiNames(state, NAMES, rails(0, 10), NOW), ['e2'], 'the cooldown still holds');
  assert.deepEqual(openEmojiNames(state, NAMES, rails(3, 0), NOW), [], 'the per-replies rail still holds');
});

test('a stored state that makes no sense reads as no history', () => {
  assert.deepEqual(openEmojiNames('πολλά', NAMES, rails(3, 60), NOW), NAMES);
});

// What an emoji does to the text.

const WAVE = { id: '7', name: 'e1', platformName: 'wave', animated: false };

test('append puts the rendered emoji after the text', () => {
  assert.equal(applyEmojiPick('ναι', { action: 'append', emoji: WAVE }, RENDER), 'ναι [[wave|7]]');
});

test('replace leaves the rendered emoji alone', () => {
  assert.equal(applyEmojiPick('ναι', { action: 'replace', emoji: WAVE }, RENDER), '[[wave|7]]');
});

test('an animated emoji takes the animated rendering, else the still one', () => {
  const animated = { ...WAVE, animated: true };
  assert.equal(applyEmojiPick('ναι', { action: 'replace', emoji: animated }, RENDER), '[[a|wave|7]]');
  assert.equal(applyEmojiPick('ναι', { action: 'replace', emoji: animated }, { still: RENDER.still }), '[[wave|7]]');
});

// The pick over a fake model and a fake store.

type EmojiRigOptions = {
  answer?: string;
  pickConfig?: object;
  gifs?: Record<string, object>;
};

function emojiRig({ answer = '{"pick":"none","name":null}', pickConfig = {}, gifs = {} }: EmojiRigOptions = {}) {
  const calls: Array<{ messages: Array<{ role: string; content: unknown }>; options: Record<string, unknown> }> = [];
  const held = new Map<string, unknown>();
  let at = NOW;
  const pick = createMediaPick({
    hot: {
      config: {
        bot: { timezone: 'UTC' },
        models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
        media: {
          pick: {
            maxOutputTokens: 17,
            candidates: 5,
            emojiCandidates: 5,
            emojiPerReplies: 0,
            emojiCooldownMinutes: 0,
            ...pickConfig,
          },
        },
      },
      prompts: { labels, 'classify/pick': 'Pick for {{name}}.' },
    },
    store: {
      mediaNameOf: noMediaNames,
      getGifs: () => ({ nextId: 9, backfill: null, entries: gifs }),
      getEmojiRails: (placeId: string) => held.get(placeId) ?? null,
      setEmojiRails: (placeId: string, state: unknown) => {
        held.set(placeId, state);
      },
    },
    llm: {
      complete: (messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>) => {
        calls.push({ messages, options });
        return Promise.resolve({ text: answer });
      },
    },
    clock: () => at,
  });
  return {
    pick,
    calls,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const emojiArgs = (fields: object = {}) => ({
  // The chat by its place alone.
  placeId: PLACE,
  capability: EMOJI_CAPABILITY,
  messages: [{ text: 'ναι, φυσικά, έλα', replyTo: 2 }],
  history: [],
  selfName: 'Νέα',
  emoji: INVENTORY,
  emojiUsage: USAGE,
  ...fields,
});

const emojiBlockOf = (call: { messages: Array<{ content: unknown }> }, name: string): string | null => {
  const user = call.messages[1];
  const found = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(userText(user.content));
  return found ? found[1] : null;
};

const ONE_GIF = {
  k1: {
    id: 'g1',
    kind: 'link',
    url: 'https://tenor.com/view/g1',
    count: 1,
    last: NOW,
    firstSeen: NOW,
    // A GIF is stored as one text.
    description: 'ναι φυσικά',
    places: { [PLACE]: { count: 1, last: NOW } },
  },
};

test('an interface with no capability gets none, with no call, whatever the inventory holds', async () => {
  const { pick: picker, calls } = emojiRig({ answer: '{"pick":"emoji","name":"e1"}' });
  assert.deepEqual(await picker.pick(emojiArgs({ capability: null })), NONE);
  assert.equal(calls.length, 0);
});

test('an interface with GIFs and no emoji capability is offered no emoji and gets none for one', async () => {
  const { pick: picker, calls } = emojiRig({ answer: '{"pick":"emoji","name":"e1"}', gifs: ONE_GIF });
  assert.deepEqual(await picker.pick(emojiArgs({ capability: { gifForms: ['link'] } })), NONE);
  assert.equal(calls.length, 1);
  assert.equal(emojiBlockOf(calls[0], 'emoji'), null);
});

test('an interface with no emoji capability and no GIF candidate makes no call', async () => {
  const { pick: picker, calls } = emojiRig();
  assert.deepEqual(await picker.pick(emojiArgs({ capability: { gifForms: ['link'] } })), NONE);
  assert.equal(calls.length, 0);
});

test('one request covers both forms', async () => {
  const { pick: picker, calls } = emojiRig({ gifs: ONE_GIF });
  await picker.pick(emojiArgs({ capability: { ...EMOJI_CAPABILITY, gifForms: ['link'] } }));
  assert.equal(calls.length, 1);
  assert.match(String(emojiBlockOf(calls[0], 'gifs')), /g1/);
  assert.match(String(emojiBlockOf(calls[0], 'emoji')), /e1/);
});

test('the emoji are listed most used first, cut by media.pick.emojiCandidates', async () => {
  const { pick: picker, calls } = emojiRig({ pickConfig: { emojiCandidates: 1 } });
  await picker.pick(emojiArgs());
  const listed = String(emojiBlockOf(calls[0], 'emoji'));
  assert.match(listed, /e2/);
  assert.doesNotMatch(listed, /e1/);
});

test('an emoji answer comes back with its action and the emoji as the interface knows it', async () => {
  const appender = emojiRig({ answer: '{"pick":"emoji","name":"e1"}' }).pick;
  const appended = await appender.pick(emojiArgs());
  assert.deepEqual(appended, { kind: 'emoji', action: 'append', emoji: INVENTORY[0] });
  const replacer = emojiRig({ answer: '{"pick":"replace","name":"e1"}' }).pick;
  const replaced = await replacer.pick(emojiArgs());
  assert.deepEqual(replaced, { kind: 'emoji', action: 'replace', emoji: INVENTORY[0] });
});

test('`none` is the normal answer with emoji on offer', async () => {
  const { pick: picker, calls } = emojiRig({ answer: '{"pick":"none","name":null}' });
  assert.deepEqual(await picker.pick(emojiArgs()), NONE);
  assert.equal(calls.length, 1);
});

test('past the per-replies rail no emoji is offered, and without GIFs there is no call', async () => {
  const { pick: picker, calls } = emojiRig({
    answer: '{"pick":"emoji","name":"e1"}',
    pickConfig: { emojiPerReplies: 2 },
  });
  picker.noteReply({ placeId: PLACE, emoji: 'e1' });
  assert.deepEqual(await picker.pick(emojiArgs()), NONE);
  assert.equal(calls.length, 0);
  picker.noteReply({ placeId: PLACE, emoji: null });
  assert.equal((await picker.pick(emojiArgs())).kind, 'emoji');
});

test('the per-replies rail of one place leaves another place open', async () => {
  const { pick: picker } = emojiRig({ answer: '{"pick":"emoji","name":"e1"}', pickConfig: { emojiPerReplies: 5 } });
  picker.noteReply({ placeId: PLACE, emoji: 'e1' });
  assert.equal((await picker.pick(emojiArgs({ placeId: ELSEWHERE }))).kind, 'emoji');
});

test('an emoji in its cooldown is not offered and a model that names it anyway gets none', async () => {
  const {
    pick: picker,
    calls,
    advance,
  } = emojiRig({
    answer: '{"pick":"emoji","name":"e1"}',
    pickConfig: { emojiCooldownMinutes: 10 },
  });
  picker.noteReply({ placeId: PLACE, emoji: 'e1' });
  assert.deepEqual(await picker.pick(emojiArgs()), NONE);
  assert.doesNotMatch(String(emojiBlockOf(calls[0], 'emoji')), /e1/);
  advance(10 * MINUTE);
  assert.equal((await picker.pick(emojiArgs())).kind, 'emoji');
});

test('with both rails at 0 the rollout setting leaves the prompt alone to decide', async () => {
  const { pick: picker, calls } = emojiRig({
    answer: '{"pick":"emoji","name":"e1"}',
    pickConfig: { emojiPerReplies: 0, emojiCooldownMinutes: 0 },
  });
  picker.noteReply({ placeId: PLACE, emoji: 'e1' });
  assert.equal((await picker.pick(emojiArgs())).kind, 'emoji');
  assert.equal(calls.length, 1);
});

test('offers e1 by its stable name and appends its markup with the platform name when picked', async () => {
  const { pick: chooser, calls } = emojiRig({ answer: '{"pick":"emoji","name":"e1"}' });
  const result = await chooser.pick(emojiArgs());
  const [request] = calls;
  const listed = String(emojiBlockOf(request, 'emoji'));
  assert.match(listed, /e1/);
  assert.doesNotMatch(listed, /wave/);
  assert.equal(result.kind, 'emoji');
  if (result.kind !== 'emoji') return;
  assert.equal(applyEmojiPick('ναι', result, RENDER), 'ναι [[wave|1]]');
});

// The ranking of the emoji candidates.

const RANK_NOW = Date.UTC(2026, 8, 20, 10, 0, 0);

const INDEX = [
  { id: '1', name: 'alpha', platformName: 'alpha', animated: false },
  { id: '2', name: 'beta', platformName: 'beta', animated: true },
  { id: '3', name: 'gamma', platformName: 'gamma', animated: false },
  { id: '4', name: 'delta', platformName: 'delta', animated: false },
];

const namesOf = (usage: object, cap = 30) => rankEmojiCandidates(INDEX, usage, cap).map((emoji) => emoji.name);

test('rankEmojiCandidates: skips a ranked emoji the server no longer has and uses its current name', () => {
  const names = namesOf({
    99: { name: 'gone', count: 50, last: RANK_NOW },
    2: { name: 'beta_old_name', count: 3, last: RANK_NOW },
  });
  assert.equal(names[0], 'beta');
  assert.ok(!names.includes('gone'));
});

test('rankEmojiCandidates: tops up a short ranking with the rest of the index, in index order', () => {
  assert.deepEqual(namesOf({ 4: { name: 'delta', count: 1, last: RANK_NOW } }), ['delta', 'alpha', 'beta', 'gamma']);
});

test('rankEmojiCandidates: falls back to the index order when nothing is ranked yet', () => {
  assert.deepEqual(namesOf({}), ['alpha', 'beta', 'gamma', 'delta']);
});

// The strict JSON answer: the request hands the client `mediaPickFormat(offer)` as `responseFormat`, whose `name`
// holds exactly the GIF handles and emoji names that request offered, and parseMediaPick reads the object text
// `{ "pick": "none" | "gif" | "emoji" | "replace", "name": string | null }`. A name that was not offered, an action
// the interface does not support, and every answer that is not the object (the old one-line answer included) are
// none.

const JSON_NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const JSON_RENDER = { still: '[[{name}|{id}]]' };
const JSON_WAVE = { id: '1', name: 'wave', platformName: 'wave', animated: false };
const CLAP = { id: '2', name: 'clap', platformName: 'clap', animated: false };
const JSON_USAGE = { '1': { name: 'wave', count: 3, last: JSON_NOW }, '2': { name: 'clap', count: 9, last: JSON_NOW } };

/** One GIF the search finds for the reply below. */
const JSON_ONE_GIF = {
  k1: {
    id: 'g1',
    kind: 'link',
    url: 'https://tenor.com/view/g1',
    count: 1,
    last: JSON_NOW,
    firstSeen: JSON_NOW,
    // A GIF is stored as one text.
    description: 'ναι φυσικά',
    places: { [PLACE]: { count: 1, last: JSON_NOW } },
  },
};

type Capability = MediaPickArgs['capability'];
const BOTH: Capability = { gifForms: ['link'], emoji: { actions: ['append', 'replace'], render: JSON_RENDER } };

type Sent = { options: Record<string, unknown> };

/** One pick whose model answers `text`, with what the interface declares, and the options of each request. */
async function pickWith(text: string, capability: Capability = BOTH) {
  const sent: Array<Sent> = [];
  const media = createMediaPick({
    hot: {
      config: {
        bot: { timezone: 'UTC' },
        models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
        media: {
          pick: { maxOutputTokens: 17, candidates: 5, emojiCandidates: 5, emojiPerReplies: 0, emojiCooldownMinutes: 0 },
        },
      },
      prompts: { labels, 'classify/pick': 'Pick for {{name}}.' },
    },
    store: {
      mediaNameOf: noMediaNames,
      getGifs: () => ({ nextId: 9, backfill: null, entries: JSON_ONE_GIF }),
      getEmojiRails: () => null,
      setEmojiRails: () => {},
    },
    llm: {
      complete: (_messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    clock: () => JSON_NOW,
  });
  const result = await media.pick({
    placeId: PLACE,
    capability,
    messages: [{ text: 'ναι, φυσικά, έλα', replyTo: 2 }],
    history: [],
    selfName: 'Νέα',
    emoji: [JSON_WAVE, CLAP],
    emojiUsage: JSON_USAGE,
  });
  return { result, sent };
}

/** Every string a schema node allows by `enum` or `const`, anywhere below it. */
function allowedStrings(node: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const entries = Object.entries(value);
    for (const [key, child] of entries) {
      if (key === 'enum' && Array.isArray(child)) {
        for (const item of child) if (typeof item === 'string') found.add(item);
      } else if (key === 'const' && typeof child === 'string') {
        found.add(child);
      } else {
        walk(child);
      }
    }
  };
  walk(node);
  return found;
}

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, unknown>;
};

/** The schema the one request of a pick handed the client. */
function schemaSent(sent: Array<Sent>): Schema {
  assert.equal(sent.length, 1);
  // The lead: the request named first, for the chain rule.
  const [first] = sent;
  const format = first?.options.responseFormat as { schema?: Schema } | undefined;
  return format?.schema ?? {};
}

test('the media-pick request hands the client a closed object that requires pick and name', async () => {
  // Bug: the schema is built and never sent, so the model answers a sentence and the pick is always none.
  const { sent } = await pickWith('{"pick":"none","name":null}');
  const schema = schemaSent(sent);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...(schema.required ?? [])].sort(), ['name', 'pick']);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['name', 'pick']);
  const picks = allowedStrings(schema.properties?.pick);
  assert.ok(picks.has('none'), 'none is always allowed');
  for (const word of picks) assert.ok(['none', 'gif', 'emoji', 'replace'].includes(word), word);
});

test('the name of the schema allows exactly the GIFs and emoji that request offered', async () => {
  // Bug: a fixed schema lets the model name a GIF of another request, which the act then cannot find.
  const namesSent = (sent: Array<Sent>) => [...allowedStrings(schemaSent(sent).properties?.name)].sort();
  const both = await pickWith('{"pick":"none","name":null}');
  assert.deepEqual(namesSent(both.sent), ['clap', 'g1', 'wave']);
  const gifsOnly = await pickWith('{"pick":"none","name":null}', { gifForms: ['link'] });
  assert.deepEqual(namesSent(gifsOnly.sent), ['g1']);
});

test('mediaPickFormat builds its name enum from the offer it is given', () => {
  const format = mediaPickFormat({ gifs: ['g7', 'g8'], emoji: ['nod'], actions: ['append'] });
  const schema = format.schema as Schema;
  assert.deepEqual([...allowedStrings(schema.properties?.name)].sort(), ['g7', 'g8', 'nod']);
});

test('a well-formed object gives what the one-line answer gave for the same pick', async () => {
  const gif = await pickWith('{"pick":"gif","name":"g1"}');
  assert.equal(gif.result.kind, 'gif');
  assert.ok(gif.result.kind === 'gif');
  const { entry } = gif.result;
  assert.equal(entry.id, 'g1');
  assert.equal(gif.result.replyTo, 2);
  const appended = await pickWith('{"pick":"emoji","name":"wave"}');
  assert.deepEqual(appended.result, { kind: 'emoji', action: 'append', emoji: JSON_WAVE });
  const replaced = await pickWith('{"pick":"replace","name":"clap"}');
  assert.deepEqual(replaced.result, { kind: 'emoji', action: 'replace', emoji: CLAP });
  const none = await pickWith('{"pick":"none","name":null}');
  assert.deepEqual(none.result, NONE);
});

test('an emoji action the interface does not support is none', async () => {
  const appendOnly: Capability = { gifForms: ['link'], emoji: { actions: ['append'], render: JSON_RENDER } };
  const { result } = await pickWith('{"pick":"replace","name":"wave"}', appendOnly);
  assert.deepEqual(result, NONE);
});

/** Answers that are not a usable object for this offer: each is none. */
const UNREADABLE = [
  'gif g1',
  'emoji wave',
  'replace clap',
  'none',
  'The GIF fits the reply.',
  '```json\n{"pick":"gif","name":"g1"}\n```',
  '{"pick":"gif","name":"g1"',
  '{"pick":"gif"}',
  '{"name":"g1"}',
  '{"pick":"sticker","name":"g1"}',
  '{"pick":"gif","name":"g9"}',
  '{"pick":"gif","name":"wave"}',
  '{"pick":"emoji","name":"g1"}',
  '{"pick":"gif","name":null}',
  '{"pick":"emoji","name":null}',
  '{"pick":"gif","name":7}',
  '{"pick":true,"name":"g1"}',
  '[{"pick":"gif","name":"g1"}]',
  '"gif g1"',
  'null',
];

test('every answer that is not a usable object, the old one-line answer included, is none', async () => {
  for (const text of UNREADABLE) {
    const { result } = await pickWith(text);
    assert.deepEqual(result, NONE, JSON.stringify(text));
  }
});

test('parseMediaPick reads the object text against the offer, and an old one-line answer as none', () => {
  const offer = { gifs: ['g1'], emoji: ['wave'], actions: ['append', 'replace'] };
  assert.deepEqual(parseMediaPick('{"pick":"gif","name":"g1"}', offer), { kind: 'gif', handle: 'g1' });
  assert.deepEqual(parseMediaPick('{"pick":"emoji","name":"wave"}', offer), { kind: 'emoji', name: 'wave' });
  assert.deepEqual(parseMediaPick('{"pick":"replace","name":"wave"}', offer), { kind: 'replace', name: 'wave' });
  for (const text of ['gif g1', 'emoji wave', '', null, undefined, 7]) {
    assert.deepEqual(parseMediaPick(text, offer), NONE, JSON.stringify(text));
  }
});

const mediaPickEmojiContractShipped = (name: string): string =>
  fs.readFileSync(new URL(`../../../prompts/${name}.md`, import.meta.url), 'utf8');

test('the pick prompt names the emoji block and the answers of the emoji forms', () => {
  const prompt = mediaPickEmojiContractShipped('classify/pick');
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  for (const word of ['<emoji>', '`emoji`', '`replace`']) assert.ok(prompt.includes(word), word);
});

const URL_G1 = 'https://tenor.com/view/g1';

const CAPABILITY_TEXT = 'Εδώ ένα αυτοκόλλητο μιλά δυνατά.';

const CAPABLE = {
  gifForms: ['file', 'link'],
  emoji: { actions: ['append', 'replace'], render: { still: '[[{name}|{id}]]' } },
  text: CAPABILITY_TEXT,
};

beforeEach(() => {
  freshWorld();
});

function sharedLibrary() {
  return {
    nextId: 2,
    backfill: null,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: URL_G1,
        itemId: 'item-1',
        messageId: 'm-1',
        placeId: 'c1',
        count: 3,
        last: MEDIA_PICK_EMOJI_TURN_NOW - 3_600_000,
        firstSeen: MEDIA_PICK_EMOJI_TURN_NOW - 7_200_000,
        // A GIF is stored as one text.
        description: 'ναι φυσικά γνέφει',
        nativeIds: ['item-1'],
        links: [URL_G1],
        places: { c1: { count: 3, last: MEDIA_PICK_EMOJI_TURN_NOW - 3_600_000 } },
      },
    },
  };
}

async function runScene({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  pick = '{"pick":"none","name":null}',
  mediaPick = CAPABLE,
}: { reply?: string; pick?: string; mediaPick?: object | null } = {}) {
  if (mediaPick) {
    const port = world().port as unknown as { capabilities: () => object };
    const declared = port.capabilities.bind(port);
    port.capabilities = () => ({ ...declared(), mediaPick });
  }
  const raws = [
    rawMessage({ id: 'm0', ts: MEDIA_PICK_EMOJI_TURN_NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: MEDIA_PICK_EMOJI_TURN_NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: raws });
  const calls: Array<{ messages: Array<{ content: unknown }>; options: Record<string, Untyped> }> = [];
  const hot = fakeHot(
    {},
    {},
    {
      media: {
        maxPerTurn: 6,
        filePreviewChars: 500,
        pick: { maxOutputTokens: 17, candidates: 5, emojiCandidates: 5, emojiPerReplies: 0, emojiCooldownMinutes: 0 },
      },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
    }
  );
  Object.assign(hot.prompts, { 'classify/pick': 'Pick for {{name}}.', labels });
  const library = sharedLibrary();
  const known = { key: 'k1', ...library.entries.k1 };
  const rails: Array<{ placeId: string; state: { lastUsed?: Record<string, number> } }> = [];
  const store = Object.assign(
    fakeStore({ placeMemory: { emojiUsage: { '7': { count: 4, last: MEDIA_PICK_EMOJI_TURN_NOW - 1000 } } } }),
    {
      getGifs: () => library,
      findGif: (...given: Array<string>) => (given.at(-1) === 'g1' ? known : null),
      getEmojiRails: () => null,
      setEmojiRails: (placeId: string, state: { lastUsed?: Record<string, number> }) => {
        rails.push({ placeId, state });
      },
      recordOwnGif: () => {},
    }
  );
  const emoji = {
    refresh: () => Promise.resolve(),
    byName: (name: string) => (name === WAVE.name ? WAVE : null),
    list: () => [WAVE],
    urlOf: () => null,
  };
  const turns = createTurnRunner({
    hot,
    store,
    emoji,
    llm: {
      complete: (messages: Array<{ content: unknown }>, options: Record<string, Untyped>) => {
        calls.push({ messages, options });
        return Promise.resolve({
          text: options?.purpose === 'media-pick' ? pick : reply,
          usage: {},
          estimated: 10,
        });
      },
    },
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => MEDIA_PICK_EMOJI_TURN_NOW,
  });
  const trigger = normalizedTrigger(raws[1]);
  await turns.runTurn(wrongly({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));
  const own = calls.find((call) => call.options?.purpose !== 'media-pick');
  assert.ok(own);
  return {
    rails,
    picks: calls.filter((call) => call.options?.purpose === 'media-pick'),
    request: own.messages.map((message) => userText(message.content) || String(message.content)).join('\n'),
    sent: channel.sent.map((payload: { content: unknown }) => payload.content),
  };
}

// An emoji and a sticker go by a stable name of the engine.
test('`emoji <name>` appends the emoji as the interface renders it', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { sent } = await runScene({ pick: '{"pick":"emoji","name":"e1"}' });
  assert.deepEqual(sent, ['ναι, φυσικά, έλα [[wave|7]]']);
});

// An emoji and a sticker go by a stable name of the engine.
test('`replace <name>` posts the emoji in place of the first message and the rest follow', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { sent } = await runScene({
    reply: '<msg>ναι, φυσικά, έλα</msg><msg>στις οκτώ</msg>',
    pick: '{"pick":"replace","name":"e1"}',
  });
  assert.deepEqual(sent, ['[[wave|7]]', 'στις οκτώ']);
});

test('a reply that got a GIF carries no emoji', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { picks, sent } = await runScene({ pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(picks.length, 1);
  assert.deepEqual(sent, [URL_G1]);
});

test('an emoji the model made up leaves the reply as written', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { picks, sent } = await runScene({ pick: '{"pick":"emoji","name":"nope"}' });
  assert.equal(picks.length, 1);
  assert.deepEqual(sent, ['ναι, φυσικά, έλα']);
});

// An emoji and a sticker go by a stable name of the engine.
test('a posted emoji is counted for the place, and so is a reply without one', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const withEmoji = await runScene({ pick: '{"pick":"emoji","name":"e1"}' });
  assert.equal(withEmoji.rails.length, 1);
  const rail = withEmoji.rails[0];
  const lastUsed = rail.state.lastUsed;
  assert.equal(lastUsed?.e1, MEDIA_PICK_EMOJI_TURN_NOW);
  freshWorld();
  const plain = await runScene({ pick: '{"pick":"none","name":null}' });
  assert.equal(plain.rails.length, 1);
  const rail2 = plain.rails[0];
  const lastUsed2 = rail2.state.lastUsed;
  assert.equal(lastUsed2?.e1, undefined);
});

beforeEach(() => {
  freshWorld();
});

/** One described link GIF in the shared library. */
// A GIF is stored as one text.
function mediaPickTurnSharedLibrary(texts: object = { description: 'ναι φυσικά γνέφει' }) {
  return {
    nextId: 2,
    backfill: null,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: URL_G1,
        itemId: 'item-1',
        messageId: 'm-1',
        placeId: 'c1',
        count: 3,
        last: MEDIA_PICK_EMOJI_TURN_NOW - 3_600_000,
        firstSeen: MEDIA_PICK_EMOJI_TURN_NOW - 7_200_000,
        ...texts,
        nativeIds: ['item-1'],
        links: [URL_G1],
        places: { c1: { count: 3, last: MEDIA_PICK_EMOJI_TURN_NOW - 3_600_000 } },
      },
    },
  };
}

/** The adapter of this turn's world declares `mediaPick` beside what it already declares. */
function declare(mediaPick: unknown): void {
  const port = world().port as unknown as { capabilities: () => object };
  const declared = port.capabilities.bind(port);
  port.capabilities = () => ({ ...declared(), mediaPick });
}

async function mediaPickTurnRunScene({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  pick = '{"pick":"none","name":null}',
  mediaPick = null,
  failLink = false,
  texts,
}: { reply?: string; pick?: string; mediaPick?: object | null; failLink?: boolean; texts?: object } = {}) {
  if (mediaPick) declare(mediaPick);
  if (failLink) world().failSends((text) => String(text).startsWith('https://tenor.com/'));
  const raws = [
    rawMessage({ id: 'm0', ts: MEDIA_PICK_EMOJI_TURN_NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: MEDIA_PICK_EMOJI_TURN_NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: raws });
  const calls: Array<{ messages: Array<{ content: unknown }>; options: Record<string, Untyped> }> = [];
  const hot = fakeHot(
    {},
    {},
    {
      media: { maxPerTurn: 6, filePreviewChars: 500, pick: { maxOutputTokens: 17, candidates: 5 } },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
    }
  );
  // The old prompt stays beside the new one: a picker that still reads it, or that runs on an interface without the
  // capability, shows up as a pick request.
  Object.assign(hot.prompts, { 'classify/pick': 'Pick for {{name}}.', 'gif-pick': 'Pick for {{name}}.', labels });
  const library = mediaPickTurnSharedLibrary(texts);
  const known = { key: 'k1', ...library.entries.k1 };
  const store = Object.assign(fakeStore({ mediaCache: { 'item-1': { text: 'ναι φυσικά γνέφει' } } }), {
    getGifs: () => library,
    // Whatever arguments it is called with, the last one is the handle.
    findGif: (...given: Array<string>) => (given.at(-1) === 'g1' ? known : null),
    getEmojiRails: () => null,
    setEmojiRails: () => {},
    recordOwnGif: () => {},
  });
  const turns = createTurnRunner({
    hot,
    store,
    llm: {
      complete: (messages: Array<{ content: unknown }>, options: Record<string, Untyped>) => {
        calls.push({ messages, options });
        const text = options?.purpose === 'media-pick' ? pick : reply;
        return Promise.resolve({ text, usage: {}, estimated: 10 });
      },
    },
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => MEDIA_PICK_EMOJI_TURN_NOW,
  });
  const trigger = normalizedTrigger(raws[1]);
  const result = await turns.runTurn(wrongly({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));
  const isPick = (call: (typeof calls)[number]): boolean => /^(?:media|gif)-pick$/.test(String(call.options?.purpose));
  const picks = calls.filter(isPick);
  const reply0 = calls.find((call) => !isPick(call));
  return { result, picks, reply0, sent: channel.sent.map((payload: { content: unknown }) => payload.content) };
}

test('an interface without the capability sends the reply as written with no classifier call', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { picks, sent } = await mediaPickTurnRunScene({ pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(picks.length, 0);
  assert.deepEqual(sent, ['ναι, φυσικά, έλα']);
});

test('a `none` from the classifier posts the reply as written', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { picks, sent } = await mediaPickTurnRunScene({
    pick: '{"pick":"none","name":null}',
    mediaPick: { gifForms: ['file', 'link'] },
  });
  const options = picks[0]?.options;
  assert.equal(options?.purpose, 'media-pick');
  assert.deepEqual(sent, ['ναι, φυσικά, έλα']);
});

// Bug: the pick showed a GIF's `caption`, a second text that differs from the
// description in 304 rows. A GIF is stored as one text, and the pick shows its description.
test('the pick offers a GIF by its description, and a caption it still holds is shown nowhere', async () => {
  const { picks } = await mediaPickTurnRunScene({
    mediaPick: { gifForms: ['file', 'link'] },
    texts: { description: 'ναι φυσικά γνέφει', caption: 'ένας σκύλος τρέχει' },
  });
  const text = (picks[0]?.messages ?? [])
    .map((message) => userText(message.content) || String(message.content))
    .join('\n');
  assert.ok(text.includes('ναι φυσικά γνέφει'), 'the description is offered');
  assert.ok(!text.includes('σκύλος'), 'the caption is not');
});

const worldChannelsOf = (channels: Parameters<typeof worldChannels>[1]) => worldChannels(GUILD, channels);

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];

// The world's wrapper takes the runner factory by the loose options of the tests.
const promptsShippedCreateTurnRunner = onWorld(createRealTurnRunner as unknown as Parameters<typeof onWorld>[0]);

// ---- the shipped layer --------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PROMPTS_DIR = path.join(ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};

// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof labels;

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES: Record<string, { literal: string; why: string }> = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text: string) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

// The rules prompt reaches a request only while the memory table `rules` holds a rule (src/rules-list.ts). The requests
// here are built with no memory, the way a deployment starts, so it stays in NOT_BUILT: putting it in SYSTEM would mean
// a rule in every fixture, and tests/src/rules-list.test.ts already checks the block with and without one.
const SYSTEM = ['main', 'persona', 'format'];

/** Every kind of diary entry and the prompt file of its own task, which follows the common `diary/task.md`. */
const DIARY_KIND_FILES: Record<string, string> = Object.fromEntries(
  ['story', 'selfPicture', 'picture', 'photoset', 'randomSet', 'news', 'facts', 'thought', 'people', 'meme'].map(
    (kind) => [kind, `diary/kinds/${kind}`]
  )
);

/** The prompt files each request below must carry whole, by request. */
const LOADS = {
  reply: [...SYSTEM, 'turn/reply'],
  followUp: [...SYSTEM, 'turn/follow'],
  overheard: [...SYSTEM, 'turn/overheard'],
  errandResult: [...SYSTEM, 'turn/errand'],
  private: [...SYSTEM, 'turn/reply', 'turn/private'],
  draw: ['draw', 'appearance'],
  ...Object.fromEntries(
    Object.entries(DIARY_KIND_FILES).map(([kind, file]) => [`diary ${kind}`, [...SYSTEM, 'diary/task', file]])
  ),
  inner: [...SYSTEM, 'turn/inner'],
  heartbeat: [...SYSTEM, 'heartbeat/task'],
  describe: ['describe/picture'],
  avatar: ['describe/avatar'],
  describeGif: ['describe/gif'],
  describeVideo: ['describe/video'],
  rewatchAnswer: ['describe/rewatch'],
  searchSummary: ['summarize/search'],
  split: ['classify/split'],
  merge: ['classify/merge'],
  missed: ['classify/missed'],
  mediaPick: ['classify/pick'],
  humanizer: ['humanizer/linter', 'humanizer/editor'],
  turn: [...SYSTEM, 'turn/reply'],
};

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides: Record<string, unknown> = {}) {
  const on = {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video', drawing: 'x/drawing', speech: 'x/speech' }) },
  }; // off when shipped
  return deepMerge(deepMerge(structuredClone(SHIPPED.config), on), overrides);
}

/** A live view over the shipped layer, the config overridden as given. */
function shippedHot(overrides: Record<string, unknown> = {}) {
  return { config: shippedConfig(overrides), prompts: SHIPPED.prompts };
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function contentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function promptsShippedRequestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => contentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name: string) {
  const text = (SHIPPED.prompts as Record<string, unknown>)[name] as string;
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(
  messages: unknown,
  { files = [], blocks = [] }: { files?: Array<string>; blocks?: Array<string> },
  where: string
) {
  assert.ok(Array.isArray(messages) && messages.length > 0, `${where}: no request was built`);
  const text = promptsShippedRequestText(messages);
  assert.deepEqual(strayPlaceholders(text), [], `${where}: a placeholder reached the request unfilled`);
  assert.deepEqual(strayLabelKeys(text), [], `${where}: a label placeholder reached the request unfilled`);
  for (const name of files) {
    const missing = literalLines(name).filter((line) => !text.includes(line));
    assert.equal(
      missing.length,
      0,
      `${where}: prompts/${name}.md is not carried whole, e.g. ${JSON.stringify(missing.slice(0, 2))}`
    );
  }
  for (const tag of blocks) {
    if (tag === 'tempo') {
      // Slice 2 (g): `<tempo>` is the foot of `<chat>`, not a block, so its verdict line ends the chat's body.
      const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
      const verdict = labelHead(LABELS.tempo.verdict);
      assert.ok(chat.split('\n').at(-1)?.startsWith(verdict), `${where}: no tempo at the foot of <chat>`);
      continue;
    }
    assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  }
  return text;
}

// ---- the scene: one server, its members and channels --------------------------------

const PROMPTS_SHIPPED_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const GUILD = '600000000000000001';

const SELF_ID = '900000000000000001';

const SELF_NAME = 'Zoë';

const ANA = '411111111111111111';

const NIKOS = '422222222222222222';

const BJORN = '433333333333333333';

const GENERAL = '700000000000000001';

const GARDEN = '700000000000000002';

const DIARY = '700000000000000003';

const CHANNEL_INCREMENT: Record<string, bigint> = { [GENERAL]: 1n, [GARDEN]: 2n, [DIARY]: 3n };

const PEOPLE = {
  [ANA]: { id: ANA, name: 'Ana' },
  [NIKOS]: { id: NIKOS, name: 'Nikos' },
  [BJORN]: { id: BJORN, name: 'Björn' },
  [SELF_ID]: { id: SELF_ID, name: SELF_NAME },
};

/**
 * A discord.js-shaped message, enough for normalizeMessage: `author` a PEOPLE entry, media as
 * plain lists (attachments `{ id, name, contentType, url, size?, duration? }`, embeds as Discord
 * sends them, stickers `{ id, name, format }`, reactions `{ name, id?, count, me? }`).
 */
function promptsShippedRawMessage(
  channel: { id: string; name: string | null; category?: string | null; topic?: string | null },
  {
    ts,
    author,
    content = '',
    attachments = [],
    embeds = [],
    stickers = [],
    reactions = [],
    replyTo = null,
    mentions = [],
    forwarded = null,
  }: {
    ts: number;
    author: { id: string; name: string };
    content?: string;
    attachments?: Array<{ id: string; [key: string]: unknown }>;
    embeds?: Array<unknown>;
    stickers?: Array<{ id: string; [key: string]: unknown }>;
    reactions?: Array<{ name: string; id?: string; count: number; me?: boolean }>;
    replyTo?: string | null;
    mentions?: Array<string>;
    forwarded?: string | null;
  }
) {
  // The same id on every call: the time, and the channel as the increment.
  const id = SnowflakeUtil.generate({ timestamp: ts, increment: CHANNEL_INCREMENT[channel.id] ?? 0n }).toString();
  return {
    id,
    channelId: channel.id,
    channel: {
      name: channel.name,
      parent: channel.category ? { name: channel.category } : null,
      topic: channel.topic ?? null,
    },
    guild: null,
    author: { id: author.id, bot: false, globalName: author.name, username: author.name },
    member: { displayName: author.name },
    content,
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyTo ? { messageId: replyTo } : null,
    attachments: new Map(attachments.map((a) => [a.id, a])),
    embeds,
    stickers: new Map(stickers.map((s) => [s.id, s])),
    messageSnapshots: new Map(
      forwarded
        ? [
            [
              'fwd',
              { content: forwarded, cleanContent: forwarded, attachments: new Map(), embeds: [], stickers: new Map() },
            ],
          ]
        : []
    ),
    mentions: { users: new Map(mentions.map((accountId) => [accountId, { id: accountId }])) },
    reactions: {
      cache: new Map(
        reactions.map((r, i) => [
          String(i),
          { emoji: { name: r.name, id: r.id ?? null }, count: r.count, me: r.me ?? false },
        ])
      ),
    },
    flags: { has: () => false },
  };
}

const GENERAL_INFO = { id: GENERAL, name: 'général', category: 'Café', topic: 'tout et rien' };

const GIF_EMBED = {
  url: 'https://tenor.com/view/cat-wave-123',
  provider: { name: 'Tenor' },
  thumbnail: { url: 'https://media.tenor.com/cat.png' },
  video: { url: 'https://media.tenor.com/cat.mp4' },
};

const PAGE_EMBED = {
  url: 'https://example.org/tomates',
  title: 'Tomates en pot',
  description: 'Comment cultiver des tomates sur un balcon',
};

/** The chat of #général the turn answers, oldest first: every kind of media the transcript renders. */
function generalRaws() {
  const at = (minutes: number) => PROMPTS_SHIPPED_NOW - minutes * MINUTE_MS;
  const raws: Array<ReturnType<typeof promptsShippedRawMessage>> = [];
  const add = (fields: Parameters<typeof promptsShippedRawMessage>[1]) => {
    const raw = promptsShippedRawMessage(GENERAL_INFO, fields);
    raws.push(raw);
    return raw;
  };
  add({
    ts: at(55),
    author: PEOPLE[NIKOS],
    content: 'bonjour à tous, la tomate a gelé',
    reactions: [
      { name: '🍅', count: 3 },
      { name: 'zoe_wave', id: 'E1', count: 1, me: true },
    ],
  });
  const own = add({ ts: at(50), author: PEOPLE[SELF_ID], content: 'oh non, pauvre tomate' });
  add({
    ts: at(45),
    author: PEOPLE[BJORN],
    content: 'la preuve',
    attachments: [
      {
        id: '800000000000000001',
        name: 'photo.png',
        contentType: 'image/png',
        url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
        size: 2000,
      },
    ],
  });
  add({
    ts: at(40),
    author: PEOPLE[NIKOS],
    content: 'regardez https://tenor.com/view/cat-wave-123',
    embeds: [GIF_EMBED],
  });
  const video = add({
    ts: at(35),
    author: PEOPLE[ANA],
    content: 'une vidéo des oranges',
    attachments: [
      {
        id: '800000000000000002',
        name: 'oranges.mp4',
        contentType: 'video/mp4',
        url: 'https://cdn.discordapp.com/attachments/1/2/oranges.mp4',
        size: 90000,
        duration: 20,
      },
    ],
  });
  add({ ts: at(30), author: PEOPLE[BJORN], content: 'un article https://example.org/tomates', embeds: [PAGE_EMBED] });
  add({
    ts: at(26),
    author: PEOPLE[ANA],
    content: '',
    stickers: [{ id: '810000000000000001', name: 'tomato_dance', format: 1 }],
  });
  add({
    ts: at(22),
    author: PEOPLE[NIKOS],
    content: 'mes graines',
    attachments: [
      {
        id: '800000000000000003',
        name: 'graines.txt',
        contentType: 'text/plain',
        url: 'https://cdn.discordapp.com/attachments/1/2/graines.txt',
        size: 40,
      },
    ],
  });
  add({ ts: at(18), author: PEOPLE[BJORN], content: 'vu ailleurs', forwarded: 'le gel arrive mardi' });
  add({ ts: at(14), author: PEOPLE[SELF_ID], content: 'jolie vidéo', replyTo: video.id });
  add({ ts: at(10), author: PEOPLE[NIKOS], content: 'Zoë, tu as aimé ?', replyTo: own.id });
  add({
    ts: at(2),
    author: PEOPLE[ANA],
    content: '@Zoë de quelle couleur sont les oranges dans la vidéo ? et quand gèle la tomate ?',
    mentions: [SELF_ID],
  });
  return raws;
}

const normalize = (raws: Array<ReturnType<typeof promptsShippedRawMessage>>) =>
  raws.map((raw) => {
    const media = SHIPPED.config.media;
    const line = normalizeMessage(raw, SELF_ID, {
      videoSites: media.video.sites,
    });
    // The interface's line names its channel natively; the core reads the same line under its place.
    return { ...line, placeId: line.channelId };
  });

/** A fake `llm.complete` recording every request and answering `answer(messages, options)`. */
function recordingLlm(answer: (messages: Array<{ content: unknown }>, options: { purpose?: string }) => unknown) {
  const calls: Array<{ messages: Array<{ content: unknown }>; options: { purpose?: string }; text: string }> = [];
  return {
    calls,
    complete: async (messages: Array<{ content: unknown }>, options: { purpose?: string } = {}) => {
      calls.push({ messages, options, text: promptsShippedRequestText(messages) });
      const text = await answer(messages, options);
      return { text, usage: { prompt_tokens: 100, completion_tokens: 10 }, estimated: 100, finishReason: 'stop' };
    },
  };
}

/** The store a turn reads, empty but for the state: the split tests look at the task labels only. */
function bareStore() {
  return {
    state: { data: {}, markDirty() {} },
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listUserProfiles: () => [],
    listChannels: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
  };
}

describe('with the shipped prompts', () => {
  before(() => {
    useIface('fake');
    useSelf('900000000000000001');
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
  });

  // ---- the GIF picker ---------------------------------------------------------------------

  test('createTurnRunner: the media pick fills classify/pick.md', async () => {
    const hot = shippedHot();
    const line = promptsShippedRawMessage(GENERAL_INFO, {
      ts: PROMPTS_SHIPPED_NOW - MINUTE_MS,
      author: PEOPLE[ANA],
      content: 'Zoë, tu viens ce soir ?',
      mentions: [SELF_ID],
    });
    const channel = worldChannelsOf([[GENERAL_INFO, [...generalRaws(), line]]])[GENERAL];
    const gifs = twoCaptionedGifs(channel.id, GENERAL, PROMPTS_SHIPPED_NOW, HOUR_MS, DAY_MS);
    const llm = recordingLlm((messages, options) =>
      options.purpose === 'media-pick' ? 'none' : '<msg>oui, bien sûr</msg>'
    );
    // B7: the pick runs where the interface declares it, over the captions on the shared library's entries.
    declarePick();
    const store = { ...bareStore(), getGifs: () => gifs, findGif: () => null };
    const turns = promptsShippedCreateTurnRunner({
      hot,
      store,
      llm,
      calibrator: createCalibrator(),
      now: () => PROMPTS_SHIPPED_NOW,
      rng: () => 0.5,
    });
    const history = normalize([...generalRaws(), line]);
    await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: history.at(-1), triggerKind: 'mention' })
    );

    const [pick] = llm.calls.filter((call) => call.options.purpose === 'media-pick');
    const text = assertFilled(
      pick?.messages,
      { files: LOADS.mediaPick, blocks: ['context', 'reply', 'gifs', 'gifs_recent'] },
      'media-pick'
    );
    assert.ok(text.includes(SELF_NAME), 'media-pick: {{name}} is the persona');
    assert.ok(
      text.includes(fill(LABELS.gifs.entry, { id: 'g1', text: 'oui un chat qui danse' })),
      'media-pick: an entry through labels.gifs.entry'
    );
    assert.ok(
      text.includes(`g2 ${fill(LABELS.gifs.ownMark, { ago: `1 ${LABELS.units.hour}` })}`),
      'media-pick: the own post in <gifs_recent> through labels.gifs.ownMark'
    );
  });
});

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<{ close: () => Promise<void> }> = [];

after(async () => {
  for (const mem of OPENED_MEMORY) await mem.close();
});

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

// ---------------------------------------------------------------------------
// The GIF picker (src/behavior/gif-pick.ts): a short reply is shown with the
// WHOLE captioned library to one classifier request; a handle it names is
// posted instead of the text.

const GIF_PICK_PROMPT = 'Pick a GIF for what {{name}} wrote.';

const PICK_LIBRARY_SIZE = 50;

// PR 7d: gifs.pick.maxChars (160) and contextMessages (4) are constants of the picker. The grace is set here, so the
// tests of a late pick hold whatever `media.pick.graceMs` defaults to.
const PICK_SETTINGS = { maxOutputTokens: 17, candidates: PICK_LIBRARY_SIZE, graceMs: 1000 };

// B7: the cap holds the whole library.

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
      // A GIF is stored as one text. The search reads it, and these words are the replies' below.
      description: `ναι χα λεζάντα ${i}`,
      url: `https://tenor.com/view/gif-${i}`,
      itemId: `item-${i}`,
      messageId: `m-${i}`,
      placeId: 'c1',
      count: PICK_LIBRARY_SIZE + 1 - i,
      last: MEDIA_PICK_EMOJI_TURN_NOW - i * 3_600_000,
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
    rawMessage({ id: 'm0', ts: MEDIA_PICK_EMOJI_TURN_NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: MEDIA_PICK_EMOJI_TURN_NOW - 1000, content: 'θα έρθεις απόψε;' }),
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
      models: { routes: chainsOnDefaults({ analyzer: 'cheap/classifier' }) },
      ...(typing ? { typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], ...typing } } : {}),
    }
  );
  declarePick();
  Object.assign(hot.prompts, { 'classify/pick': GIF_PICK_PROMPT }, prompts);
  for (const [name, text] of Object.entries(prompts)) if (text === null) delete hot.prompts[name];
  return hot;
}

async function runPickTurn({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
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
    now: () => MEDIA_PICK_EMOJI_TURN_NOW,
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
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { result, logs, channel, picks, store, sent } = await runPickTurn({ pick: '{"pick":"gif","name":"G50"}' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(picks.length, 1, 'one pick request');
  const [system, user] = picks[0].messages;
  assert.deepEqual(system, { role: 'system', content: 'Pick a GIF for what Bot wrote.' });
  const blocks = userText(user.content).split('\n\n');
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
  const sent2 = channel.sent[0];
  assert.equal(sent2.reply?.messageReference, 'm1', 'replying where the first message would have');
  // The persona's own post counts on the place it went to, the channel.
  assert.deepEqual(store.ownGifs, [{ placeId: 'c1', key: 'k50', ts: MEDIA_PICK_EMOJI_TURN_NOW }]);
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
  // A GIF is stored as one text.
  const entries = library.gifs.entries;
  delete entries.k7.description;
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { picks, sent, logs } = await runPickTurn({
    store: pickStore({ library }),
    pick: '{"pick":"gif","name":"g7"}',
  });
  const messages = picks[0].messages;
  assert.equal(userText(messages[1].content).includes('g7 --'), false, 'g7 has no caption');
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

// B7: the case of a turn posting its own GIF went with `<gif>`, which tests/src/llm/parse.test.ts holds retired.
test('runTurn: no pick for a reply over maxChars', async () => {
  const text = 'α'.repeat(161);
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const long = await runPickTurn({ reply: `<msg>${text}</msg>`, pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(long.picks.length, 0, 'over maxChars');
  assert.deepEqual(long.sent(), [text]);
  // B7: a word of the reply finds the candidates.
  const fits = await runPickTurn({ reply: `<msg>ναι ${'α'.repeat(156)}</msg>`, pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(fits.picks.length, 1, 'exactly maxChars is still picked for');
});

test('runTurn: no pick without the prompt or without a captioned GIF', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const noPrompt = await runPickTurn({ pick: '{"pick":"gif","name":"g1"}', prompts: { 'classify/pick': null } });
  assert.equal(noPrompt.picks.length, 0, 'no prompts/classify/pick.md');
  const empty = await runPickTurn({
    pick: '{"pick":"gif","name":"g1"}',
    store: pickStore({ library: { gifs: { nextId: 1, entries: {} }, mediaCache: {} } }),
  });
  assert.equal(empty.picks.length, 0, 'no captioned GIF');
});

/** Six chat lines: the trigger (m1) is followed by four later lines from someone else, the picker's whole context. */
function laterLinesHistory() {
  return [
    rawMessage({ id: 'm0', ts: MEDIA_PICK_EMOJI_TURN_NOW - 11000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: MEDIA_PICK_EMOJI_TURN_NOW - 9000, content: 'θα έρθεις απόψε;' }),
    rawMessage({
      id: 'm2',
      ts: MEDIA_PICK_EMOJI_TURN_NOW - 7000,
      authorId: 'u2',
      authorName: 'Zoé',
      content: 'κι εγώ ρωτάω',
    }),
    rawMessage({
      id: 'm3',
      ts: MEDIA_PICK_EMOJI_TURN_NOW - 5000,
      authorId: 'u2',
      authorName: 'Zoé',
      content: 'λοιπόν;',
    }),
    rawMessage({ id: 'm4', ts: MEDIA_PICK_EMOJI_TURN_NOW - 3000, authorId: 'u2', authorName: 'Zoé', content: 'ε;' }),
    rawMessage({ id: 'm5', ts: MEDIA_PICK_EMOJI_TURN_NOW - 1000, authorId: 'u2', authorName: 'Zoé', content: 'ναι;' }),
  ];
}

test("runTurn: the picker's context brings in an older answered trigger, first, and the reply names it", async () => {
  const raws = laterLinesHistory();
  const { picks } = await runPickTurn({ raws, triggerRaw: raws[1], reply: '<msg>ναι, φυσικά</msg>' });
  assert.equal(picks.length, 1);
  const messages = picks[0].messages;
  const [, context, reply] = userText(messages[1].content).split('\n\n');
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
  const messages = picks[0].messages;
  const [, context, reply] = userText(messages[1].content).split('\n\n');
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
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { picks, sent, channel, store } = await runPickTurn({ reply, pick: '{"pick":"gif","name":"g50"}' });
  assert.equal(picks.length, 1, 'only the first message counts toward the longest it may replace');
  const messages = picks[0].messages;
  assert.equal(
    userText(messages[1].content).split('\n\n')[2].endsWith(' χα\n</reply>'),
    true,
    'the picker sees the message it would replace'
  );
  assert.deepEqual(sent(), ['https://tenor.com/view/gif-50', longer, 'τέλος']);
  const sent2 = channel.sent[0];
  assert.equal(sent2.reply?.messageReference, 'm1', 'the GIF replies where the first message would have');
  assert.deepEqual(
    store.ownGifs.map((own: Untyped) => own.key),
    ['k50']
  );
});

test('runTurn: a picked GIF that fails to send leaves the first message to be posted as written, then the rest', async () => {
  const reply = '<msg reply="#2">χα</msg><msg>τέλος</msg>';
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
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
  const sent2 = channel.sent[0];
  assert.equal(sent2.reply?.messageReference, 'm1', 'the first message replies as written');
  assert.deepEqual(store.ownGifs, [], 'no own post recorded');
});

test('runTurn: the longest message the pick replaces gates the first message only', async () => {
  const first = 'και κάτι ακόμα πιο μακρύ ' + 'α'.repeat(160);
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const long = await runPickTurn({ reply: `<msg>${first}</msg><msg>χα</msg>`, pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(long.picks.length, 0, 'a long first message is never replaced');
  assert.deepEqual(long.sent(), [first, 'χα']);
});

test("runTurn: the picker runs alongside the first message's typing time", async () => {
  let askedAt = null;
  const pick = () => {
    askedAt = Date.now();
    // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
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
  // PICK_SETTINGS sets media.pick.graceMs to 1000, so the picker has that long beyond the typing before it is left behind.
  const typing = { msPerChar: [0, 0], minMs: 60, maxMs: 60 };
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
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

test('runTurn: a picker that answers after a media.pick.graceMs the config sets is left behind at that grace', async () => {
  const typing = { msPerChar: [0, 0], minMs: 60, maxMs: 60 };
  const late = await runPickTurn({
    reply: '<msg>ναι</msg>',
    pick: () => new Promise((resolve) => setTimeout(() => resolve('{"pick":"gif","name":"g50"}'), 700)),
    typing,
    pickSettings: { ...PICK_SETTINGS, graceMs: 300 },
  });
  assert.deepEqual(late.sent(), ['ναι'], 'the text as written, no GIF');
  const entry = late.logs.find((log) => log.msg === 'media-pick: late');
  assert.deepEqual([entry?.channel, entry?.graceMs], ['c1', 300]);
  assert.deepEqual(late.store.ownGifs, [], 'nothing posted or stamped');
});

test('runTurn: a picker that answers inside a media.pick.graceMs the config sets is used', async () => {
  const typing = { msPerChar: [0, 0], minMs: 60, maxMs: 60 };
  const graced = await runPickTurn({
    reply: '<msg>ναι</msg>',
    pick: () => new Promise((resolve) => setTimeout(() => resolve('{"pick":"gif","name":"g50"}'), 1300)),
    typing,
    pickSettings: { ...PICK_SETTINGS, graceMs: 2000 },
  });
  assert.deepEqual(graced.sent(), ['https://tenor.com/view/gif-50'], 'the GIF replaces the text');
  assert.equal(
    graced.logs.some((log) => log.msg === 'media-pick: late'),
    false
  );
});

test('runTurn: a picker that answered during the typing is used', async () => {
  const quick = await runPickTurn({
    reply: '<msg>ναι</msg>',
    // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
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
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
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
  return llm.calls.filter((call) => call.options?.purpose === 'media-pick').map(({ messages }) => messages[1].content);
}

/** The persona posted g40 at `at`, and it was used enough to lead the ranking. */
const postG40 = (at: number) => (gifs: Untyped) =>
  Object.assign(gifs.entries.k40, {
    ownLast: at,
    ownUses: 1,
    count: 500,
    last: at,
    // The persona's own posts are read per place.
    places: { c1: { count: 500, last: at, ownLast: at, ownUses: 1 } },
  });

// B7: the candidates change with each reply, so nothing of the request is held per cache bucket any more.
test("runTurn: the persona's post and its age go to <gifs_recent>, the tail of the next pick", async () => {
  const first = MEDIA_PICK_EMOJI_TURN_NOW + 60_000;
  const second = MEDIA_PICK_EMOJI_TURN_NOW + 7 * 60_000;
  const [a, b] = await twoPickTurns({ times: [first, second], between: postG40(first + 1000) });
  assert.equal(a.includes('<gifs_recent>'), false, 'no recent post before it');
  const recent = fill(labels.gifs.ownMark, { ago: formatDuration(second - (first + 1000), labels.units) });
  assert.ok(b.includes(`<gifs_recent>\ng40 ${recent}\n</gifs_recent>\n\n<context>\n`), 'the post and its age');
  assert.equal(b.split('</gifs>')[0].includes('(you'), false, 'no own-post mark in the candidates');
});

test('runTurn: the next pick reads the library as it stands', async () => {
  const first = MEDIA_PICK_EMOJI_TURN_NOW + 60_000;
  const [, next] = await twoPickTurns({ times: [first, first + 60_000], between: postG40(first + 1000) });
  assert.ok(next.startsWith('<gifs>\ng40 -- ναι χα λεζάντα 40\n'), 'reranked at once');
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
    now: () => MEDIA_PICK_EMOJI_TURN_NOW,
    uuid: () => `u${(n += 1)}`,
  });
  return { journal, lines };
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);
