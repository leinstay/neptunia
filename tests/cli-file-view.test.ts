// cli/file-view.ts: what `/attach open` draws of a picture in each format, through the public `viewFile` and
// `placementOf`. The pictures are built in the test (tests/fixtures/synthetic-images.ts), so no binary is committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphicBox, placementOf, viewFile } from '../cli/file-view.ts';
import type { ViewedFile } from '../cli/file-view.ts';
import type { GraphicsSupport } from '../cli/terminal-replies.ts';
import { syntheticImage, syntheticWebp } from './fixtures/synthetic-images.ts';
import { syntheticPng } from './fixtures/synthetic-png.ts';

const PATH = '/data/media/cli/p1.bin';
const PNG_BASE64_SIGNATURE = 'iVBORw0KGgo';

function open(name: string, bytes: Uint8Array, protocol: GraphicsSupport['protocol']) {
  const file: ViewedFile = { name, kind: 'image', description: 'A red square' };
  return viewFile(file, {
    read: () => Promise.resolve({ size: bytes.length, bytes }),
    path: PATH,
    graphics: () => Promise.resolve({ protocol, cell: { width: 10, height: 20 } }),
    kittyId: 7,
  });
}

const FORMATS: ReadonlyArray<{ format: string; name: string; bytes: () => Promise<Uint8Array> }> = [
  { format: 'a JPEG', name: 'red.jpg', bytes: () => syntheticImage('image/jpeg') },
  { format: 'a GIF', name: 'red.gif', bytes: () => syntheticImage('image/gif') },
  { format: 'a WebP', name: 'red.webp', bytes: () => syntheticWebp() },
  { format: 'a BMP', name: 'red.bmp', bytes: () => syntheticImage('image/bmp') },
];

for (const { format, name, bytes } of FORMATS) {
  test(`${format} draws as a red Sixel picture of its own proportions on a Sixel terminal`, async () => {
    // Bug: the format has no decoder, so the terminal shows the sentences and the path instead of the picture.
    const { answer, graphic } = await open(name, await bytes(), 'sixel');
    assert.equal(graphic?.protocol, 'sixel', answer);
    if (graphic === null) return;
    assert.equal(answer.includes(PATH), false, answer);
    assert.deepEqual(graphic.size, { width: 4, height: 3 });
    const box = graphicBox(graphic, 4, 3);
    const { draw } = placementOf(graphic, box, { row: 0, column: 0, key: 'k' });
    assert.ok(draw.startsWith('\u001bP'), draw.slice(0, 10));
    // Pure red is level 5 of the cube's red and 0 of green and blue: 100%, 0%, 0%.
    assert.ok(draw.includes(';2;100;0;0'), draw.slice(0, 80));
  });

  test(`${format} reaches kitty as a PNG payload`, async () => {
    // Bug: kitty is sent the file's own bytes with f=100, which it reads only as PNG, and draws nothing.
    const { answer, graphic } = await open(name, await bytes(), 'kitty');
    assert.equal(graphic?.protocol, 'kitty', answer);
    if (graphic === null) return;
    const { prepare = '' } = placementOf(graphic, graphicBox(graphic, 4, 3), { row: 0, column: 0, key: 'k' });
    assert.ok(prepare.includes(`f=100,t=d,i=7`), prepare.slice(0, 60));
    assert.ok(prepare.includes(`;${PNG_BASE64_SIGNATURE}`), prepare.slice(0, 60));
  });
}

test('a JPEG reaches iTerm2 as a PNG of the size it declares', async () => {
  // Bug: iTerm2 is sent bytes the chat could not read, or a box sized from nothing.
  const { graphic } = await open('red.jpg', await syntheticImage('image/jpeg'), 'iterm2');
  assert.deepEqual(graphic?.size, { width: 4, height: 3 });
  if (graphic === null) return;
  const { draw } = placementOf(graphic, graphicBox(graphic, 4, 3), { row: 0, column: 0, key: 'k' });
  assert.ok(draw.includes(`inline=1:${PNG_BASE64_SIGNATURE}`), draw.slice(0, 120));
});

test('a PNG still draws on a Sixel terminal', async () => {
  // Bug: the one decode path drops the format the chat drew before.
  const { graphic } = await open('grey.png', syntheticPng(200), 'sixel');
  assert.deepEqual(graphic?.size, { width: 2, height: 2 });
});

for (const protocol of ['sixel', 'kitty', 'iterm2'] as const) {
  test(`a corrupt JPEG gives the sentences and the path on a ${protocol} terminal`, async () => {
    // Bug: the decoder throws inside the chat, or a broken picture is sent to the terminal as if it were whole.
    const corrupt = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3, 4, 5, 6, 7, 8]);
    const { answer, graphic } = await open('broken.jpg', corrupt, protocol);
    assert.equal(graphic, null);
    assert.ok(answer.includes('cannot be shown here'), answer);
    assert.ok(answer.includes(PATH), answer);
  });
}

test('a picture on a terminal with no graphics gives the sentences and the path', async () => {
  // Bug: a picture is decoded and placed for a terminal that draws none, and escape codes land in the window.
  const { answer, graphic } = await open('red.gif', await syntheticImage('image/gif'), 'none');
  assert.equal(graphic, null);
  assert.ok(answer.includes(PATH), answer);
});
