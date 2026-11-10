// The media pick's GIF side (src/behavior/media-pick.ts): its settings, its answer read strictly, and the one
// classifier request after a reply over the candidates of the shared library. The emoji forms are in
// tests/media-pick-emoji.test.ts. Plan 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_PICK_DEFAULTS,
  createMediaPick,
  mediaPickSettings,
  parseMediaPick,
  pickContext,
} from '../src/behavior/media-pick.ts';
import { userText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';
import { chainsOf } from './fixtures/chains.ts';
import fs from 'node:fs';
import { captionOfCached } from '../src/memory/gifs.ts';
import { wrongly } from './fixtures/loose-types.ts';

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
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  assert.deepEqual(parseMediaPick('{"pick":"gif","name":"G50"}', OFFERED), { kind: 'gif', handle: 'g50' });
});

test('`none` and everything that is not the protocol read as none', () => {
  const none = { kind: 'none' };
  for (const answer of ['none', ' NONE\n', '', 'g1', 'gif', 'gif g9', 'gif g1\nnone', 'nothing', '<skip/>', null, 7]) {
    assert.deepEqual(parseMediaPick(answer, OFFERED), none, JSON.stringify(answer));
  }
});

// The pick over a fake model and a fake store.

/** A library entry: `caption` is what the search reads. */
function gifEntry(id: string, caption: string | undefined, fields: object = {}) {
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
    ...(caption === undefined ? {} : { caption }),
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
};

function rig({
  library = libraryOf(gifEntry('g1', 'ναι φυσικά γνέφει')),
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  answer = '{"pick":"none","name":null}',
  embedQuery,
  pickConfig = {},
  prompt = 'Pick for {{name}}.',
}: RigOptions = {}) {
  const calls: Array<{ messages: Array<{ role: string; content: unknown }>; options: Record<string, unknown> }> = [];
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
      media: { pick: { maxOutputTokens: 17, candidates: 5, ...pickConfig } },
    },
    prompts: { labels, ...(prompt === null ? {} : { 'media-pick': prompt }) },
  };
  const rails = new Map<string, unknown>();
  const pick = createMediaPick({
    hot,
    store: {
      getGifs: () => library,
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
  // The chat by its place alone (plan 2026-11-05 T.4).
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
const requestText = (call: { messages: Array<{ content: unknown }> }) => userText(call.messages[1].content);

function blockOf(text: string, name: string): string | null {
  const found = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text);
  return found ? found[1] : null;
}

test('an interface without the capability yields no classifier call', async () => {
  const { pick, calls } = rig();
  assert.deepEqual(await pick.pick(args({ capability: null })), NONE);
  assert.equal(calls.length, 0);
});

test('a chosen GIF comes back with its entry, replying where the first message would have', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick, calls } = rig({ answer: '{"pick":"gif","name":"g1"}' });
  const result = await pick.pick(args());
  assert.equal(result.kind, 'gif');
  assert.ok(result.kind === 'gif');
  assert.equal(result.entry.id, 'g1');
  assert.equal(result.replyTo, 2);
  assert.equal(calls.length, 1);
});

test('the request goes out as one analyzer request under the media-pick purpose', async () => {
  const { pick, calls } = rig();
  await pick.pick(args());
  const { options, messages } = calls[0];
  assert.deepEqual(
    [options.role, options.purpose, options.maxOutputTokens, options.model],
    ['analyzer', 'media-pick', 17, 'cheap/classifier']
  );
  assert.equal(messages[0].content, 'Pick for Νέα.');
});

test('`none` is the normal result and posts nothing', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick, calls } = rig({ answer: '{"pick":"none","name":null}' });
  assert.deepEqual(await pick.pick(args()), NONE);
  assert.equal(calls.length, 1);
});

test('a GIF the request did not list is none, even when the library holds it', async () => {
  const { pick } = rig({
    library: libraryOf(gifEntry('g1', 'ναι φυσικά'), gifEntry('g2', 'άσχετη λεζάντα')),
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    answer: '{"pick":"gif","name":"g2"}',
  });
  assert.deepEqual(await pick.pick(args()), NONE);
});

test('the classifier sees the candidates, never the whole library', async () => {
  const many = Array.from({ length: 50 }, (_, index) => gifEntry(`g${index + 1}`, `ναι φυσικά ${index + 1}`));
  const { pick, calls } = rig({ library: libraryOf(...many), pickConfig: { candidates: 3 } });
  await pick.pick(args());
  const listed = blockOf(requestText(calls[0]), 'gifs');
  assert.ok(listed);
  assert.equal(listed.split('\n').length, 3);
});

test('the cap is read at the moment of the pick', async () => {
  const many = Array.from({ length: 9 }, (_, index) => gifEntry(`g${index + 1}`, `ναι φυσικά ${index + 1}`));
  const { pick, calls, hot } = rig({ library: libraryOf(...many), pickConfig: { candidates: 3 } });
  hot.config.media.pick.candidates = 2;
  await pick.pick(args());
  assert.equal(String(blockOf(requestText(calls[0]), 'gifs')).split('\n').length, 2);
});

test('with no candidate there is no call', async () => {
  const { pick, calls } = rig({ library: libraryOf(gifEntry('g1', 'άσχετη λεζάντα'), gifEntry('g2', undefined)) });
  assert.deepEqual(await pick.pick(args()), NONE);
  assert.equal(calls.length, 0);
});

test('the request holds the chat line and the reply', async () => {
  const { pick, calls } = rig();
  await pick.pick(args());
  const text = requestText(calls[0]);
  assert.match(String(blockOf(text, 'context')), /θα έρθεις απόψε;/);
  assert.match(String(blockOf(text, 'reply')), /ναι, φυσικά, έλα/);
});

test('a first message longer than the longest it may replace never reaches the classifier', async () => {
  const { pick, calls } = rig();
  const long = 'ναι '.repeat(MEDIA_PICK_DEFAULTS.maxChars);
  assert.deepEqual(await pick.pick(args({ messages: [{ text: long, replyTo: null }] })), NONE);
  assert.equal(calls.length, 0);
});

test('a turn with no message or a blank first message never reaches the classifier', async () => {
  const { pick, calls } = rig();
  await pick.pick(args({ messages: [] }));
  await pick.pick(args({ messages: [{ text: '  ', replyTo: null }] }));
  assert.equal(calls.length, 0);
});

test('without the prompt file there is no call', async () => {
  const { pick, calls } = rig({ prompt: null });
  assert.deepEqual(await pick.pick(args()), NONE);
  assert.equal(calls.length, 0);
});

test('a classifier failure is none and never rejects', async () => {
  const { pick } = rig({ answer: () => Promise.reject(new Error('http-500')) });
  assert.deepEqual(await pick.pick(args()), NONE);
});

test('an interface that posts files only is offered no GIF without a cached file', async () => {
  const library = libraryOf(gifEntry('g1', 'ναι φυσικά'), gifEntry('g2', 'ναι φυσικά', { file: 'media/gifs/h2.gif' }));
  const { pick, calls } = rig({ library });
  await pick.pick(args({ capability: { gifForms: ['file'] } }));
  const listed = String(blockOf(requestText(calls[0]), 'gifs'));
  assert.match(listed, /g2/);
  assert.doesNotMatch(listed, /g1\b/);
});

test('her recent posts are told by the place they went to', async () => {
  const library = libraryOf(
    gifEntry('g1', 'ναι φυσικά', { places: { [PLACE]: { count: 2, last: NOW, ownLast: NOW - HOUR, ownUses: 1 } } }),
    gifEntry('g2', 'ναι φυσικά', {
      places: {
        [PLACE]: { count: 2, last: NOW },
        [ELSEWHERE]: { count: 1, last: NOW, ownLast: NOW - HOUR, ownUses: 1 },
      },
    })
  );
  const { pick, calls } = rig({ library });
  await pick.pick(args());
  const recent = String(blockOf(requestText(calls[0]), 'gifs_recent'));
  assert.match(recent, /g1/);
  assert.doesNotMatch(recent, /g2/);
});

test('the query vector finds a caption that shares no word, asked once', async () => {
  let asked = 0;
  const library = libraryOf(gifEntry('g1', 'γατάκι χορεύει', { vector: [1, 0] }));
  const { pick, calls } = rig({
    library,
    embedQuery: () => {
      asked += 1;
      return Promise.resolve([1, 0]);
    },
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    answer: '{"pick":"gif","name":"g1"}',
  });
  const result = await pick.pick(args());
  assert.equal(result.kind, 'gif');
  assert.equal(asked, 1);
  assert.equal(calls.length, 1);
});

test('a failed embedding leaves the search by words', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick } = rig({
    embedQuery: () => Promise.reject(new Error('http-500')),
    answer: '{"pick":"gif","name":"g1"}',
  });
  assert.equal((await pick.pick(args())).kind, 'gif');
});

// Bug (production 2026-11-08): Anthropic refuses a strict schema whose field has a type array and an enum ("Enum value
// does not match declared type ['string', 'null']"), so every media-pick on Sonnet 5.5 failed with 400. A nullable
// choice is an enum that holds null, with no type array; Sol and Sonnet both accept it (raw requests, 2026-11-08).
test('the analyzer schemas name a nullable choice as an enum holding null, never a type array with an enum', async () => {
  const { mediaPickFormat } = await import('../src/behavior/media-pick.ts');
  const { QUERY_PLAN_FORMAT } = await import('../src/behavior/query-builder.ts');
  const fields = (schema: unknown): Array<Record<string, unknown>> =>
    Object.values((schema as { properties: Record<string, Record<string, unknown>> }).properties);
  const all = [
    ...fields(mediaPickFormat({ gifs: ['wave'], emoji: ['shrug'], actions: [] }).schema),
    ...fields(QUERY_PLAN_FORMAT.schema),
  ];
  const mixed = all.filter((field) => Array.isArray(field.type) && Array.isArray(field.enum));
  assert.deepEqual(mixed, []);
  const pickName = fields(mediaPickFormat({ gifs: ['wave'], emoji: [], actions: [] }).schema)[1];
  assert.deepEqual(pickName.enum, ['wave', null], 'null stays a choice');
});

// The shipped prompts against the contract of the media pick (prompts/, config/labels.json): the parser's words are in
// the pick's prompt, the persona's turn tells her of no tag the parser left behind, and `<skip/>` stays hers. A test of
// the protocol strings the code reads, never of the wording around them. Plan 2026-11-04-cli-and-memory, stages B7 and B9.

const shipped = (name: string): string => fs.readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');

test('the pick prompt names its blocks and its answers', () => {
  const prompt = shipped('media-pick');
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  for (const word of ['<context>', '<reply>', '<gifs>', '`none`', '`gif`']) {
    assert.ok(prompt.includes(word), word);
  }
});

test('the pick prompt never hands the classifier the word of her turn or of a platform', () => {
  const prompt = shipped('media-pick');
  assert.ok(!prompt.includes('<skip'), '<skip/> is only hers');
  assert.doesNotMatch(prompt, /\bdiscord\b|\bserver\b/i);
});

// The media pick's context and its answer's reading (src/behavior/media-pick.ts): the pure tests of the GIF picker that
// survive stage B7 of plan 2026-11-04-cli-and-memory, moved here beside the contract tests of tests/media-pick.test.ts.
// The candidate list replaced the whole library, so its rendering tests went with it, and tests/gif-library.test.ts holds
// what a candidate is; a caption the describer wrote is read by captionOfCached below.

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

test('captionOfCached: the three fields of a watched GIF joined, an older caption as it is, a miss or nothing empty', () => {
  const watched = { text: 'a cat lifts', reaction: 'firm agreement', action: 'a cat lifts', screen: 'ναί.' };
  assert.equal(captionOfCached(watched), 'firm agreement; a cat lifts; ναί.');
  assert.equal(captionOfCached({ text: ' a man runs ' }), 'a man runs');
  assert.equal(captionOfCached({ miss: 'error', text: 'x' }), '');
  assert.equal(captionOfCached(undefined), '');
});
