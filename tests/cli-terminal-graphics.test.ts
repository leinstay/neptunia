// cli/terminal-graphics.ts: the pixels of a PNG and the Sixel sequence the chat writes for them, with no library.
// The shapes, from the specifier: `decodePng(bytes)` gives `{ width, height, rgba }` or null for what it cannot read,
// and `sixelSequence(image, width, height)` draws the image scaled to that many pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, sixelSequence } from '../cli/terminal-graphics.ts';
import { syntheticPng } from './fixtures/synthetic-png.ts';

test('a grey PNG decodes to its size and to opaque pixels of its shade', () => {
  // Bug: a filtered or greyscale row decodes to the wrong colour, and the picture draws as noise.
  const image = decodePng(syntheticPng(200));
  assert.equal(image?.width, 2);
  assert.equal(image?.height, 2);
  assert.deepEqual([...(image?.rgba.slice(0, 4) ?? [])], [200, 200, 200, 255]);
});

test('bytes that are no PNG decode to nothing', () => {
  // Bug: a JPEG read as a PNG throws inside the chat, or draws garbage.
  assert.equal(decodePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), null);
  assert.equal(decodePng(new Uint8Array()), null);
});

test('the Sixel sequence declares the pixels it was scaled to and ends the sequence', () => {
  // Bug: the picture is drawn at its own size and spills over the rows the window holds for it.
  const image = decodePng(syntheticPng(128)) ?? { width: 1, height: 1, rgba: new Uint8Array(4) };
  assert.equal(image.width, 2);
  const sequence = sixelSequence(image, 20, 12);
  assert.ok(sequence.startsWith('\u001bP'), sequence.slice(0, 10));
  assert.ok(sequence.includes('"1;1;20;12'), sequence.slice(0, 40));
  assert.ok(sequence.endsWith('\u001b\\'));
  // Twelve rows are two bands of six, so one `-` moves between them.
  assert.equal(sequence.split('-').length - 1, 1);
});
