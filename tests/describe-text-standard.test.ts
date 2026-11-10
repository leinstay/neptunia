// The English standard of a stored media description (master plan U.2, U.6). A description whose letters are mostly of
// another script outside quotes is counted at write and described again once. The second answer stands when it meets the
// standard (`redescribed` on the entry), and otherwise the description is kept and marked (`offScript` too), never
// dropped, cut or edited. No model decides this. A real store over a temporary data directory, a scripted model and
// fake fetchers. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDescriber } from '../src/memory/describe.ts';
import { createStore } from '../src/memory/store.ts';
import { fakeImageFetcher, fakeLlm, fakeState, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { tempDir } from './fixtures/tmp.ts';
import { memoryAt } from './fixtures/store-kit.ts';
import { chainsOf } from './fixtures/chains.ts';

const GREEK = 'Μια γκρίζα γάτα κοιμάται στον καναπέ';
const ENGLISH = 'A grey cat sleeps on a sofa';
type Entry = { text?: string; redescribed?: boolean; offScript?: boolean; reaction?: string };

const HOT = {
  config: {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video' }) },
    media: { maxOutputTokens: 120, gif: { maxSeconds: 15 }, video: { sites: [], maxOutputTokens: 120 } },
    context: { vision: { fetchTimeoutMs: 10_000 } },
  },
  prompts: { describe: 'Describe this picture.', 'describe-gif': 'Describe this loop.', 'describe-video': 'Watch it.' },
};

function rig(answers: ReadonlyArray<string>) {
  const store = createStore(memoryAt(tempDir('nep-describe-standard-')));
  const llm = fakeLlm(answers.map((text) => ({ text, usage: {}, estimated: 1 })));
  const videoFetcher = Object.assign(fakeVideoFetcher(), {
    fetchGif: () =>
      Promise.resolve({
        ok: true,
        dataUrl: 'data:video/mp4;base64,ZmFrZQ==',
        mimeType: 'video/mp4',
        seconds: 3,
        bytes: 4,
      }),
  });
  const describer = createDescriber({
    hot: HOT,
    store,
    llm,
    imageFetcher: fakeImageFetcher(),
    videoFetcher,
    state: fakeState(),
  });
  const entryOf = (key: string): Entry | undefined => store.mediaEntry('g1', key);
  return { describer, llm, entryOf };
}

const PICTURE = { itemId: 'a1', kind: 'image', url: 'https://cdn.discordapp.com/x/pic.png' };
const GIF = {
  source: 'embed',
  messageId: 'm1',
  itemId: 'm1#e0',
  kind: 'gif',
  url: 'https://images-ext-1.discordapp.net/external/t/https/media.tenor.com/x/AAAAe/still.png',
  animationUrl: 'https://media.tenor.com/x/AAAPo/loop.mp4',
};

// Bug: an English description costs a second request.
test('an English description is one request and carries no mark', async () => {
  const run = rig([ENGLISH]);
  await run.describer.describe('g1', PICTURE);
  assert.equal(run.llm.calls.length, 1);
  assert.equal(run.entryOf('a1')?.text, ENGLISH);
  assert.equal(run.entryOf('a1')?.redescribed, undefined);
  assert.equal(run.entryOf('a1')?.offScript, undefined);
});

// Bug: the off-script description is stored as it came, and the 155 of the plan keep growing.
test('a description in another script is described again and the English one stands, noted as redescribed', async () => {
  const run = rig([GREEK, ENGLISH]);
  const result = await run.describer.describe('g1', PICTURE);
  assert.equal(run.llm.calls.length, 2);
  assert.equal(result?.text, ENGLISH);
  assert.equal(run.entryOf('a1')?.text, ENGLISH);
  assert.equal(run.entryOf('a1')?.redescribed, true);
  assert.equal(run.entryOf('a1')?.offScript, undefined);
});

// Bug: the second request loops until the model obeys, or a stubborn model loses the description altogether.
test('a second answer in another script is kept and marked, with no third request', async () => {
  const run = rig([GREEK, GREEK, ENGLISH]);
  const result = await run.describer.describe('g1', PICTURE);
  assert.equal(run.llm.calls.length, 2);
  assert.equal(result?.text, GREEK);
  assert.equal(run.entryOf('a1')?.text, GREEK);
  assert.equal(run.entryOf('a1')?.redescribed, true);
  assert.equal(run.entryOf('a1')?.offScript, true);
});

// Bug: a description that quotes a sign, as the standard asks, is paid for twice and marked as a failure.
test('a description that quotes other scripts is on standard', async () => {
  const quoted = `A sign reads "${GREEK}"`;
  const run = rig([quoted]);
  await run.describer.describe('g1', PICTURE);
  assert.equal(run.llm.calls.length, 1);
  assert.equal(run.entryOf('a1')?.text, quoted);
  assert.equal(run.entryOf('a1')?.offScript, undefined);
});

// Bug: only the picture path checks, and a watched GIF, the 46 of the plan, goes on being stored off script.
test('a watched GIF in another script is described again once', async () => {
  const run = rig([`reaction: ${GREEK}\naction: ${GREEK}`, `reaction: ${ENGLISH}\naction: ${ENGLISH}`]);
  await run.describer.describe('g1', GIF);
  assert.equal(run.llm.calls.length, 2);
  assert.equal(run.entryOf(GIF.itemId)?.text, ENGLISH);
  assert.equal(run.entryOf(GIF.itemId)?.redescribed, true);
});

// Bug: a failed second request throws the first description away, leaving her blind to the picture.
test('a second request that fails keeps the first description, marked', async () => {
  const store = createStore(memoryAt(tempDir('nep-describe-standard-')));
  const llm = fakeLlm([{ text: GREEK, usage: {}, estimated: 1 }, new Error('provider down')]);
  const describer = createDescriber({
    hot: HOT,
    store,
    llm,
    imageFetcher: fakeImageFetcher(),
    videoFetcher: fakeVideoFetcher(),
    state: fakeState(),
  });
  await describer.describe('g1', PICTURE);
  const entry = store.mediaEntry('g1', 'a1') as Entry | undefined;
  assert.equal(entry?.text, GREEK);
  assert.equal(entry?.offScript, true);
});
