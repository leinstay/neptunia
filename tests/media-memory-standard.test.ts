// The script check of a stored text form (src/memory/text-standard.ts) and who it applies to: a description a model writes of
// what it sees is held to English with quotes in their own language; a transcript and what she voiced are quoted speech as a
// whole, so they stay in the language spoken. A fake model and a fake fetcher; synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDescriber } from '../src/memory/describe.ts';
import { lineMedia } from '../src/memory/db/media-store.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { isOffScript } from '../src/memory/text-standard.ts';
import { createStore } from '../src/memory/store.ts';
import { fakeLlm, fakeState, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { fixture, kindNamed, observeLine, tell } from './fixtures/media-memory.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Rec } from './fixtures/describe-fakes.ts';
import { memoryAt } from './fixtures/store-kit.ts';
import { chainsOf } from './fixtures/chains.ts';

const UNQUOTED = 'грибы рано в этом году, и дождь идёт каждый день';

test('a text mostly in another script is off the standard, one that quotes it is not', () => {
  assert.equal(isOffScript(UNQUOTED), true);
  assert.equal(isOffScript(`she says "${UNQUOTED}"`), false);
  assert.equal(isOffScript(`a sign reads «${UNQUOTED}» on a wall`), false);
  assert.equal(isOffScript('1234 !!'), false, 'no letters, nothing to judge');
});

test('a transcript with no quotation marks stays as heard: one request and no mark', async () => {
  const store = createStore(memoryAt(tempDir('nep-media-standard-')));
  const llm = fakeLlm({ text: UNQUOTED, model: 'x/flash' });
  const describer = createDescriber({
    hot: {
      config: {
        models: { routes: chainsOf({ vision: 'x/vision', video: 'x/flash' }) },
        media: { maxOutputTokens: 120 },
      },
      prompts: { describe: 'Describe.', 'describe-audio': 'Retell in up to {{maxChars}} characters.' },
    },
    store,
    llm,
    videoFetcher: {
      ...fakeVideoFetcher(),
      fetchAudio: () => Promise.resolve({ ok: true, dataUrl: 'data:video/mp4;base64,YQ==', seconds: 9, bytes: 1 }),
    },
    state: fakeState(),
  });
  const item = { source: 'attachment', messageId: 'm1', itemId: 'v1', kind: 'voice', url: 'https://x.invalid/v.ogg' };
  const { descriptions } = await describer.describeMany('g1', [item]);
  assert.equal(descriptions.get('v1'), UNQUOTED);
  assert.equal(llm.calls.length, 1);
  assert.equal((store.getMediaCache('g1') as Record<string, Rec>).v1.offScript, undefined);
});

test('what she voiced stays in its own language, origin voiced, with no later text form over it', () => {
  const env = fixture();
  try {
    const kind = kindNamed('voice said');
    const source = observeLine(env, kind, 'absent');
    tell(env, { ...kind, origin: 'voiced' }, { id: 'pic-a', told: UNQUOTED });
    tell(env, { ...kind, origin: 'transcript' }, { id: 'pic-a', told: 'a guess at what was said' });
    const [voice] = lineMedia(env.db, [source], internalContext()).get(source) ?? [];
    assert.deepEqual([voice.description, voice.extra.textOrigin], [UNQUOTED, 'voiced']);
  } finally {
    env.done();
  }
});
