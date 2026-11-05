// The media pick's GIF side (src/behavior/media-pick.ts): its settings, its answer read strictly, and the one
// classifier request after a reply over the candidates of the shared library. The emoji forms are in
// tests/media-pick-emoji.test.ts. Plan 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_PICK_DEFAULTS, createMediaPick, mediaPickSettings, parseMediaPick } from '../src/behavior/media-pick.ts';
import { userText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';

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
  assert.deepEqual(parseMediaPick(' GIF  G50 ', OFFERED), { kind: 'gif', handle: 'g50' });
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
  answer = 'none',
  embedQuery,
  pickConfig = {},
  prompt = 'Pick for {{name}}.',
}: RigOptions = {}) {
  const calls: Array<{ messages: Array<{ role: string; content: unknown }>; options: Record<string, unknown> }> = [];
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      models: { base: { analyzer: 'cheap/classifier' } },
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
  // The conversation by its place alone (plan 2026-11-05 T.4).
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
  const { pick, calls } = rig({ answer: 'gif g1' });
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
  const { pick, calls } = rig({ answer: 'none' });
  assert.deepEqual(await pick.pick(args()), NONE);
  assert.equal(calls.length, 1);
});

test('a GIF the request did not list is none, even when the library holds it', async () => {
  const { pick } = rig({
    library: libraryOf(gifEntry('g1', 'ναι φυσικά'), gifEntry('g2', 'άσχετη λεζάντα')),
    answer: 'gif g2',
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
    answer: 'gif g1',
  });
  const result = await pick.pick(args());
  assert.equal(result.kind, 'gif');
  assert.equal(asked, 1);
  assert.equal(calls.length, 1);
});

test('a failed embedding leaves the search by words', async () => {
  const { pick } = rig({ embedQuery: () => Promise.reject(new Error('http-500')), answer: 'gif g1' });
  assert.equal((await pick.pick(args())).kind, 'gif');
});
