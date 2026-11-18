// Stage P and the standard of stage U: a voice message and an audio file reach the describer (src/memory/describe.ts) on the
// existing `video` role through `describe-audio`, from the prefill (src/pipeline/media-prefill.ts); a failure leaves the item
// undescribed with its cause, and a refused file is not retried forever. A text file keeps its preview with no model. A stored
// text form is English with speech and on-screen text quoted in their language: one that is mostly another script is described
// again once, then kept and marked. A fake model and fake fetchers; no provider is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayMedia } from '../src/behavior/sandbox.ts';
import { isDescribable } from '../src/media/classify.ts';
import { createDescriber } from '../src/memory/describe.ts';
import { createStore } from '../src/memory/store.ts';
import { createMediaPrefill } from '../src/pipeline/media-prefill.ts';
import { fakeImageFetcher, fakeLlm, fakeState, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Rec } from './fixtures/describe-fakes.ts';
import type { Row } from '../src/memory/db/types.ts';
import { memoryAt } from './fixtures/store-kit.ts';
import { chainsOf } from './fixtures/chains.ts';
import { PURPOSE_ROLES } from '../src/llm/roles.ts';

const AUDIO_CLIP = 'data:video/mp4;base64,YXVkaW8=';
const VIDEO_PROVIDER = { order: ['test-host'], allow_fallbacks: false };
const HEARD = 'she says "грибы рано в этом году"';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');

function audioRig({
  video = 'x/flash',
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the default widens the parameter a caller replaces
  fetched = { ok: true, dataUrl: AUDIO_CLIP, seconds: 9, bytes: 4 } as Rec,
  now = () => NOW,
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the default widens the parameter a caller replaces
  answer = { text: HEARD, model: 'x/flash' } as unknown,
} = {}) {
  const store = createStore(memoryAt(tempDir('nep-media-memory-')));
  const llm = fakeLlm(answer);
  const fetchedUrls: Array<string> = [];
  const videoFetcher = {
    ...fakeVideoFetcher(),
    fetchAudio: (url: string) => {
      fetchedUrls.push(url);
      return Promise.resolve(fetched);
    },
  };
  const hot = {
    config: {
      models: { routes: chainsOf({ vision: 'x/vision', video }) },
      media: { maxOutputTokens: 120, video: { provider: VIDEO_PROVIDER } },
      context: { vision: { fetchTimeoutMs: 10_000 } },
    },
    prompts: { describe: 'Describe.', 'describe-audio': 'Retell what is heard in up to {{maxChars}} characters.' },
  };
  const describer = createDescriber({
    hot,
    store,
    llm,
    videoFetcher,
    now,
    state: fakeState(),
  });
  return { describer, llm, fetchedUrls, store };
}

const voiceItem = (kind: string) => ({
  source: 'attachment',
  messageId: 'm1',
  itemId: `${kind}-1`,
  kind,
  url: `https://cdn.example.invalid/${kind}-1.ogg`,
  name: 'x.ogg',
  durationSec: 9,
});

for (const kind of ['voice', 'audio']) {
  test(`a ${kind} reaches the describer on the video role, through describe-audio, and is kept as its text form`, async () => {
    const { describer, llm, fetchedUrls } = audioRig();
    const { descriptions } = await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(descriptions.get(`${kind}-1`), HEARD);
    assert.deepEqual(fetchedUrls, [`https://cdn.example.invalid/${kind}-1.ogg`]);
    assert.equal(llm.calls.length, 1);
    const { options, messages } = llm.calls[0];
    assert.equal(options.role, 'video');
    assert.equal(options.model, 'x/flash');
    assert.deepEqual(options.provider, VIDEO_PROVIDER);
    const request = JSON.stringify(messages);
    assert.ok(request.includes('Retell what is heard'), 'the prompt of the stage');
    assert.ok(request.includes(AUDIO_CLIP), 'the clip goes in the request');
    assert.equal(describer.cachedDescriptions('g1', [voiceItem(kind)]).get(`${kind}-1`), HEARD);
  });

  test(`a ${kind} already told makes no second request`, async () => {
    const { describer, llm } = audioRig();
    await describer.describeMany('g1', [voiceItem(kind)]);
    await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(llm.calls.length, 1);
  });

  test(`a ${kind} makes no request when the video role is off`, async () => {
    const { describer, llm, fetchedUrls } = audioRig({ video: '' });
    const { descriptions } = await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(descriptions.size, 0);
    assert.deepEqual([llm.calls.length, fetchedUrls.length], [0, 0]);
  });

  test(`a ${kind} whose file cannot be fetched stays undescribed with its cause, and costs no request`, async () => {
    const { describer, llm, store } = audioRig({ fetched: { ok: false, reason: 'download' } });
    const { descriptions } = await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(descriptions.size, 0);
    assert.equal(llm.calls.length, 0);
    assert.equal(store.mediaEntry('g1', `${kind}-1`)?.reason, 'download');
  });

  test(`a refused ${kind} is never fetched again, however late`, async () => {
    let at = NOW;
    const { describer, fetchedUrls } = audioRig({ fetched: { ok: false, reason: 'size' }, now: () => at });
    await describer.describeMany('g1', [voiceItem(kind)]);
    at = NOW + 365 * 86_400_000;
    await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(fetchedUrls.length, 1);
  });

  test(`a ${kind} that fails for a passing cause is tried again after the hour`, async () => {
    let at = NOW;
    const { describer, fetchedUrls } = audioRig({ fetched: { ok: false, reason: 'download' }, now: () => at });
    await describer.describeMany('g1', [voiceItem(kind)]);
    await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(fetchedUrls.length, 1, 'not at once');
    at = NOW + 2 * 3_600_000;
    await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(fetchedUrls.length, 2);
  });

  // The owner on 2026-11-18: an answer the provider cut short is asked once more, a second cut is a miss.
  test(`a ${kind} whose answer the filter cut twice stays undescribed with the reason "filter"`, async () => {
    const cut = { text: 'she says "грибы', finishReason: 'content_filter' };
    const { describer, store, llm } = audioRig({ answer: [cut, cut, { text: HEARD, finishReason: 'stop' }] });
    const { descriptions } = await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(descriptions.size, 0);
    assert.equal(llm.calls.length, 2);
    assert.equal(store.mediaEntry('g1', `${kind}-1`)?.reason, 'filter');
  });

  test(`a ${kind} whose first answer the filter cut is kept from the second answer`, async () => {
    const cut = { text: 'she says "грибы', finishReason: 'content_filter' };
    const { describer, store } = audioRig({ answer: [cut, { text: HEARD, finishReason: 'stop' }] });
    await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(store.mediaEntry('g1', `${kind}-1`)?.text, HEARD);
  });

  test(`${kind} is a kind the describer can tell`, () => {
    assert.equal(isDescribable({ kind }), true);
  });
}

test('a binary file is no kind a model can tell, and no request is made for it', async () => {
  assert.equal(isDescribable({ kind: 'file' }), false);
  const { describer, llm } = audioRig();
  const { descriptions } = await describer.describeMany('g1', [{ ...voiceItem('file'), itemId: 'z1' }]);
  assert.equal(descriptions.size, 0);
  assert.equal(llm.calls.length, 0);
});

test('a text file is kept as its text form from its own words, with no model', async () => {
  const store = createStore(memoryAt(tempDir('nep-media-memory-')));
  const llm = fakeLlm({ text: 'never asked' });
  const describer = createDescriber({
    hot: { config: { models: { routes: chainsOf({ vision: 'x/vision' }) } }, prompts: { describe: 'Describe.' } },
    store,
    llm,
    fetchText: () => Promise.resolve({ ok: true, text: 'marzipan recipes' }),
  });
  const item = { ...voiceItem('text'), itemId: 't1', url: 'https://x.invalid/notes.txt' };
  const { descriptions } = await describer.describeMany('g1', [item]);
  assert.equal(descriptions.get('t1'), 'marzipan recipes');
  assert.equal(llm.calls.length, 0);
});

/** A describer of text files that reads `body`, with a fake summarizer answering `answer` over the bound. */
function textFileRig(body: string, answer: string) {
  const calls: Array<{ text: string; options: { maxChars: number; kind: string } }> = [];
  const summarize = (text: string, options: { maxChars: number; kind: 'picture' | 'GIF' | 'video' | 'text' }) => {
    calls.push({ text, options });
    return Promise.resolve(Array.from(text).length > options.maxChars ? answer : text);
  };
  const describer = createDescriber({
    hot: { config: { models: { routes: chainsOf({ vision: 'x/vision' }) } }, prompts: { describe: 'Describe.' } },
    store: createStore(memoryAt(tempDir('nep-media-memory-'))),
    llm: fakeLlm({ text: 'never asked' }),
    fetchText: () => Promise.resolve({ ok: true, text: body }),
    summarize,
  });
  const item = { ...voiceItem('text'), itemId: 't1', url: 'https://x.invalid/notes.txt' };
  const described = async () => (await describer.describeMany('g1', [item])).descriptions.get('t1');
  return { calls, described };
}

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('a text file over 2000 characters goes to summarize once and its summary is the text form', async () => {
  // Catches: a long file cut silently at 2000 characters.
  const body = `${'marzipan recipes, '.repeat(150)}the end`;
  const { calls, described } = textFileRig(body, 'a list of marzipan recipes');
  assert.equal(await described(), 'a list of marzipan recipes');
  assert.deepEqual(calls, [{ text: body, options: { maxChars: 2000, kind: 'text' } }]);
});

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('a summary of a text file still over 2000 characters is the text form whole', async () => {
  // Catches: the summary cut at the bound.
  const longer = `${'a long retelling, '.repeat(130)}done`;
  const { described } = textFileRig('marzipan recipes, '.repeat(150), longer);
  assert.equal(await described(), longer);
});

test('the prefill hands an observed voice message and audio file to the describer, as it does a picture', async () => {
  const asked: Array<Row> = [];
  const prefill = createMediaPrefill({
    hot: { config: {}, prompts: {} },
    describer: {
      describeMany: (_place: string, items: Array<unknown>) => {
        asked.push(...(items as Array<Row>));
        return Promise.resolve();
      },
    },
    lookup: null,
    now: () => NOW,
  } as unknown as Parameters<typeof createMediaPrefill>[0]);
  await prefill.warmMediaCache('g1', {
    id: 'm1',
    authorId: 'u1',
    attachments: [
      { id: 'v1', kind: 'voice', url: 'https://x.invalid/v.ogg', name: 'v.ogg' },
      { id: 'a1', kind: 'audio', url: 'https://x.invalid/a.mp3', name: 'a.mp3' },
      { id: 'p1', kind: 'image', url: 'https://x.invalid/p.png', name: 'p.png' },
    ],
  } as Parameters<ReturnType<typeof createMediaPrefill>['warmMediaCache']>[1]);
  assert.deepEqual(asked.map((item) => item.itemId).sort(), ['a1', 'p1', 'v1']);
});

test('a replayed moment shows a voice message with the text form the cache held then', () => {
  const history = [
    { id: 'm1', attachments: [{ id: 'v1', kind: 'voice', url: 'https://x.invalid/v.ogg', name: 'v.ogg' }] },
  ];
  // A slim history holds only what the media collectors read.
  const { descriptions } = replayMedia(history as unknown as Parameters<typeof replayMedia>[0], {
    cache: { v1: { text: 'told', ts: 1 } },
  });
  assert.equal(descriptions.get('v1'), 'told');
});

// ---------- the standard of a stored text form ----------

function pictureRig(answers: Array<Rec>) {
  const store = createStore(memoryAt(tempDir('nep-media-memory-')));
  const llm = fakeLlm(answers);
  const describer = createDescriber({
    hot: {
      config: { models: { routes: chainsOf({ vision: 'x/vision' }) }, media: { maxOutputTokens: 120 } },
      prompts: { describe: 'Describe.' },
    },
    store,
    llm,
    imageFetcher: fakeImageFetcher(),
  });
  const item = { itemId: 'p1', kind: 'image', url: 'https://x.invalid/p.png' };
  return { describer, llm, store, item };
}

test('a description mostly in another script is described again once, and the English one is kept', async () => {
  const { describer, llm, item } = pictureRig([{ text: 'маяк на скале у моря' }, { text: 'a lighthouse on a cliff' }]);
  const { descriptions } = await describer.describeMany('g1', [item]);
  assert.equal(llm.calls.length, 2);
  assert.equal(descriptions.get('p1'), 'a lighthouse on a cliff');
});

// The mark's name follows the standards of stage U (src/memory/describe.ts): `offScript`.
test('a description that fails twice is kept and marked, with no third request', async () => {
  const { describer, llm, store, item } = pictureRig([{ text: 'маяк на скале' }, { text: 'маяк на скале у моря' }]);
  const { descriptions } = await describer.describeMany('g1', [item]);
  assert.equal(llm.calls.length, 2);
  assert.equal(descriptions.get('p1'), 'маяк на скале у моря');
  assert.equal(store.mediaEntry('g1', 'p1')?.offScript, true);
});

test('text quoted in its own language is the standard: one request, no mark', async () => {
  const quoted = 'a sign reads "добро пожаловать в наш прекрасный город" on a wall';
  const { describer, llm, store, item } = pictureRig([{ text: quoted }]);
  const { descriptions } = await describer.describeMany('g1', [item]);
  assert.equal(llm.calls.length, 1);
  assert.equal(descriptions.get('p1'), quoted);
  assert.equal(store.mediaEntry('g1', 'p1')?.offScript, undefined);
});

// The owner on 2026-11-17: a `video` request carries its purpose, as a `vision` request does. The purpose is one that
// goes out on the `video` role.
test('a voice message goes out to the describer with a purpose of the video role', async () => {
  // Bug: the retelling of a voice message leaves a usage row with a null purpose.
  const { describer, llm } = audioRig();
  await describer.describeMany('g1', [voiceItem('voice')]);
  const { options } = llm.calls[0];
  assert.equal(Object.entries(PURPOSE_ROLES).find(([name]) => name === options.purpose)?.[1], 'video');
});
