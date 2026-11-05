// `collectAudio` (src/media/classify.ts): the audio of one normalized message for the describer, kept apart from the pictures
// so no audio file is ever offered as a picture to a model's vision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAudio, collectPictures } from '../src/media/classify.ts';

const message = {
  id: 'm1',
  attachments: [
    { id: 'v1', kind: 'voice', url: 'https://x.invalid/v.ogg', name: 'v.ogg', durationSec: 9 },
    { id: 'p1', kind: 'image', url: 'https://x.invalid/p.png', name: 'p.png' },
  ],
  links: [],
  stickers: [],
  forwarded: [{ attachments: [{ id: 'a1', kind: 'audio', url: 'https://x.invalid/a.mp3', name: 'a.mp3' }] }],
};

test('the audio of a message, a forwarded one included, is listed for the describer; a picture is not', () => {
  assert.deepEqual(
    collectAudio(message).map(({ itemId, kind, messageId, durationSec }) => ({ itemId, kind, messageId, durationSec })),
    [
      { itemId: 'v1', kind: 'voice', messageId: 'm1', durationSec: 9 },
      { itemId: 'a1', kind: 'audio', messageId: 'm1', durationSec: undefined },
    ]
  );
});

test('an audio file is never listed as a picture', () => {
  assert.deepEqual(
    collectPictures(message).map((item) => item.itemId),
    ['p1']
  );
});

test('a message with no audio lists none', () => {
  assert.deepEqual(collectAudio({ id: 'm2', attachments: [] }), []);
});
