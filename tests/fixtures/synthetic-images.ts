// Small pictures built in the test with the encoders the chat's libraries carry, so no binary fixture is committed:
// a 4x3 picture of one opaque colour as JPEG, GIF, BMP and lossless WebP.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createJimp } from '@jimp/core';
import bmp from '@jimp/js-bmp';
import gif from '@jimp/js-gif';
import jpeg from '@jimp/js-jpeg';
import png from '@jimp/js-png';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';

const Jimp = createJimp({ formats: [jpeg, png, gif, bmp], plugins: [] });

/** The bitmap of a 4x3 picture of the colour `rgb`, fully opaque. */
function bitmap(rgb: [number, number, number]): { width: number; height: number; data: Buffer } {
  const data = Buffer.alloc(4 * 3 * 4);
  for (let at = 0; at < data.length; at += 4) data.set([...rgb, 255], at);
  return { width: 4, height: 3, data };
}

/** A 4x3 picture of `rgb` in the format `mime` names: `image/jpeg`, `image/gif` or `image/bmp`. */
export async function syntheticImage(
  mime: 'image/jpeg' | 'image/gif' | 'image/bmp',
  rgb: [number, number, number] = [255, 0, 0]
): Promise<Buffer> {
  const image = Jimp.fromBitmap(bitmap(rgb)) as { getBuffer(mime: string): Promise<Buffer> };
  return await image.getBuffer(mime);
}

let webpReady: Promise<void> | null = null;

/** A 4x3 lossless WebP of `rgb`. */
export async function syntheticWebp(rgb: [number, number, number] = [255, 0, 0]): Promise<Buffer> {
  webpReady ??= (async () => {
    const wasm = fileURLToPath(import.meta.resolve('@jsquash/webp/codec/enc/webp_enc.wasm'));
    await initWebp(await WebAssembly.compile(await readFile(wasm)));
  })();
  await webpReady;
  const { width, height, data } = bitmap(rgb);
  const image = { width, height, data: new Uint8ClampedArray(data), colorSpace: 'srgb' as const };
  return Buffer.from(await encodeWebp(image as ImageData, { lossless: 1 }));
}
