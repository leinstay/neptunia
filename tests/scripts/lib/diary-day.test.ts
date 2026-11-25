// The recording image client of the diary-day mode of scripts/replay.ts (scripts/lib/diary-day.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageGen } from '../../../src/llm/images.ts';
import {
  FIXTURE_PNG,
  MAX_PICTURES_KEY,
  PictureCapError,
  fixtureImagesFetch,
  recordingImages,
  renderDiaryDayReport,
} from '../../../scripts/lib/diary-day.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { asRecord } from '../../fixtures/records.ts';
import { chainsOf } from '../../fixtures/chains.ts';

test('replay: --diary-day records every generate() call at the image client and fakes the picture through the real client', async () => {
  const state = { data: {}, markDirty() {} };
  const config = {
    llm: { baseUrl: 'https://openrouter.invalid/api/v1' },
    models: { routes: chainsOf({ drawing: 'openai/image-model' }) },
    image: { retries: 0 },
  };
  const real = createImageGen({
    apiKey: 'unused',
    getConfig: () => config,
    state,
    fetchImpl: fixtureImagesFetch(),
    now: () => Date.UTC(2026, 9, 6, 9, 0),
  } as unknown as Parameters<typeof createImageGen>[0]);
  const written: Array<number> = [];
  const images = recordingImages({
    images: real,
    maxPictures: 1,
    onPicture: (picture, index) => {
      written.push(index);
      return `pictures/picture-${index}.png`;
    },
  });
  const avatar = `data:image/png;base64,${Buffer.from('avatar bytes').toString('base64')}`;
  const { result: picture } = await withCapturedLogs(() =>
    images.generate({ prompt: 'A drawing.\n\nScene: a café', reference: avatar, accountId: null })
  );
  assert.ok(picture.buffer.equals(FIXTURE_PNG));
  assert.equal(FIXTURE_PNG.subarray(1, 4).toString('latin1'), 'PNG');
  // PR 7d: the engine's ImageCapError went with the daily caps; the tool's own --max-pictures cap throws PictureCapError.
  await assert.rejects(
    withCapturedLogs(() => images.generate({ prompt: 'second', reference: null, accountId: 'u1' })),
    (err: unknown) =>
      err instanceof PictureCapError && asRecord(err).key === MAX_PICTURES_KEY && asRecord(err).cap === 1
  );
  assert.deepEqual(written, [1]);
  assert.deepEqual(images.calls, [
    {
      prompt: 'A drawing.\n\nScene: a café',
      reference: { mediaType: 'image/png', bytes: 12, sha256: asRecord(images.calls[0]).reference.sha256 },
      accountId: null,
      result: { bytes: FIXTURE_PNG.length, mediaType: 'image/png', cost: 0, seconds: 0 },
      file: 'pictures/picture-1.png',
    },
    { prompt: 'second', reference: null, accountId: 'u1', result: { error: 'PictureCapError', reason: 'daily' } },
  ]);
  const call = images.calls[0];
  assert.match(call.reference?.sha256, /^[0-9a-f]{16}$/);
  const md = renderDiaryDayReport({
    date: '2026-10-06',
    timezone: 'UTC',
    seed: 's',
    draw: 'fake',
    quiet: false,
    slots: [{ n: 1, at: 'x', outcome: 'spoke', messages: ['hi'], draws: images.calls }],
  });
  assert.ok(md.includes('```text\nA drawing.\n\nScene: a café\n```'), 'the whole prompt, as sent');
});
