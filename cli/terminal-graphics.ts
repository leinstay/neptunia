// A picture drawn by the terminal itself, so it shows the same at the machine and over SSH: the pixels of a PNG, JPEG,
// GIF (its first frame), BMP or WebP, a box of cells that keeps its proportions, and the sequences of the three graphics
// protocols. Jimp's format packages decode the first four and the WebP decoder of jSquash the last, both loaded on the
// first picture so the chat starts without them. kitty and iTerm2 take the pixels encoded as PNG and scale them to the box
// themselves, and Sixel gets them scaled and mapped to a 6x6x6 colour cube. cli/terminal-replies.ts asks the terminal
// which protocol it speaks, and cli/chat-controller.ts places the picture in the command window.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type Pixels = { width: number; height: number; rgba: Uint8Array };
export type Size = { width: number; height: number };

/** The most pixels a picture may hold before the chat declines to decode it: past any picture the chat carries. */
const MAX_PIXELS = 40_000_000;

type Bitmap = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
type JimpImage = { bitmap: Bitmap; getBuffer: (mime: 'image/png') => Promise<Buffer> };
type Codecs = {
  fromBuffer: (bytes: Buffer) => Promise<JimpImage>;
  fromBitmap: (bitmap: Bitmap) => JimpImage;
  webp: (bytes: Uint8Array) => Promise<Bitmap>;
};

let codecs: Promise<Codecs> | null = null;

/** The decoders and the PNG encoder, imported and the WebP module compiled on the first call. */
function loadCodecs(): Promise<Codecs> {
  return (codecs ??= (async () => {
    const [{ createJimp }, bmp, gif, jpeg, png, webp] = await Promise.all([
      import('@jimp/core'),
      import('@jimp/js-bmp'),
      import('@jimp/js-gif'),
      import('@jimp/js-jpeg'),
      import('@jimp/js-png'),
      import('@jsquash/webp/decode.js'),
    ]);
    const jimp = createJimp({ formats: [bmp.default, gif.default, jpeg.default, png.default], plugins: [] }) as Omit<
      Codecs,
      'webp'
    >;
    const wasm = await readFile(fileURLToPath(import.meta.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')));
    await (webp.init as (module: WebAssembly.Module) => Promise<void>)(await WebAssembly.compile(wasm));
    return {
      fromBuffer: (bytes) => jimp.fromBuffer(bytes),
      fromBitmap: (bitmap) => jimp.fromBitmap(bitmap),
      webp: async (bytes) => webp.default(new Uint8Array(bytes).buffer),
    };
  })());
}

const isWebp = (bytes: Uint8Array): boolean =>
  Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF' &&
  Buffer.from(bytes.subarray(8, 12)).toString('latin1') === 'WEBP';

/** The pixels a PNG or GIF header declares, 0 for other bytes, so a small file of a huge picture is never inflated. */
function declaredPixels(bytes: Buffer): number {
  if (bytes.length >= 24 && bytes.toString('latin1', 1, 4) === 'PNG')
    return bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  if (bytes.length >= 10 && bytes.toString('latin1', 0, 3) === 'GIF')
    return bytes.readUInt16LE(6) * bytes.readUInt16LE(8);
  return 0;
}

/** The pixels of a picture as RGBA, null for anything the chat does not read: an unknown format or a damaged file. */
export async function decodeImage(bytes: Uint8Array): Promise<Pixels | null> {
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0 || declaredPixels(buffer) > MAX_PIXELS) return null;
  try {
    const { fromBuffer, webp } = await loadCodecs();
    const { width, height, data } = isWebp(buffer) ? await webp(buffer) : (await fromBuffer(buffer)).bitmap;
    if (width === 0 || height === 0 || width * height > MAX_PIXELS || data.length < width * height * 4) return null;
    return { width, height, rgba: new Uint8Array(data.buffer, data.byteOffset, width * height * 4) };
  } catch {
    return null;
  }
}

/** The PNG file of `image`, for the terminals that take a file and scale it themselves. */
export async function encodePng(image: Pixels): Promise<Uint8Array> {
  const { fromBitmap } = await loadCodecs();
  const data = Buffer.from(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength);
  return fromBitmap({ width: image.width, height: image.height, data }).getBuffer('image/png');
}

/** The pixel size of one terminal cell when the terminal does not say: the common 10 by 20. */
export const DEFAULT_CELL: Size = { width: 10, height: 20 };

/**
 * The box a picture of `size` pixels takes in at most `max` cells, its proportions kept: the cells it covers and the pixels
 * it is scaled to.
 */
export function fitCells(
  size: Size,
  cell: Size,
  max: { columns: number; rows: number }
): { columns: number; rows: number; width: number; height: number } {
  const scale = Math.min((max.columns * cell.width) / size.width, (max.rows * cell.height) / size.height);
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));
  return {
    columns: Math.max(1, Math.ceil(width / cell.width)),
    rows: Math.max(1, Math.ceil(height / cell.height)),
    width,
    height,
  };
}

/** The colour of a pixel in the 6x6x6 cube, -1 for a transparent one. */
function cubeIndex(rgba: Uint8Array, at: number): number {
  if (rgba[at + 3] < 128) return -1;
  const level = (value: number): number => Math.round((value * 5) / 255);
  return level(rgba[at]) * 36 + level(rgba[at + 1]) * 6 + level(rgba[at + 2]);
}

/** One colour's run of sixel characters, with a repeat for four or more of the same. */
function runs(chars: Array<number>): string {
  let out = '';
  for (let at = 0; at < chars.length;) {
    let end = at;
    while (end < chars.length && chars[end] === chars[at]) end += 1;
    const char = String.fromCharCode(63 + chars[at]);
    out += end - at >= 4 ? `!${end - at}${char}` : char.repeat(end - at);
    at = end;
  }
  return out;
}

/** The Sixel sequence of `image` scaled to `width` by `height` pixels, transparent where the picture is. */
export function sixelSequence(image: Pixels, width: number, height: number): string {
  const indices = new Int16Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const from = Math.floor((y * image.height) / height) * image.width + Math.floor((x * image.width) / width);
      indices[y * width + x] = cubeIndex(image.rgba, from * 4);
    }
  const used = [...new Set(indices)].filter((one) => one >= 0).sort((a, b) => a - b);
  const percent = (level: number): number => Math.round((level * 100) / 5);
  const palette = used.map(
    (one) => `#${one};2;${percent(Math.floor(one / 36))};${percent(Math.floor(one / 6) % 6)};${percent(one % 6)}`
  );
  const bands: Array<string> = [];
  for (let top = 0; top < height; top += 6) {
    const colours = new Set<number>();
    for (let at = top * width; at < Math.min(height, top + 6) * width; at += 1) colours.add(indices[at]);
    const layers = [...colours]
      .filter((one) => one >= 0)
      .map((colour) => {
        const chars: Array<number> = [];
        for (let x = 0; x < width; x += 1) {
          let bits = 0;
          for (let row = 0; row < 6 && top + row < height; row += 1)
            if (indices[(top + row) * width + x] === colour) bits |= 1 << row;
          chars.push(bits);
        }
        return `#${colour}${runs(chars)}`;
      });
    bands.push(layers.join('$'));
  }
  return `\u001bP0;1;0q"1;1;${width};${height}${palette.join('')}${bands.join('-')}\u001b\\`;
}

/** The base64 of `bytes` in pieces of at most `size` characters. */
function pieces(bytes: Uint8Array, size: number): Array<string> {
  const text = Buffer.from(bytes).toString('base64');
  const out: Array<string> = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out.length === 0 ? [''] : out;
}

/** The kitty sequences that send a PNG to the terminal under image `id`, without drawing it. */
export function kittyTransmit(png: Uint8Array, id: number): string {
  const parts = pieces(png, 4096);
  return parts
    .map((part, at) => {
      const more = at < parts.length - 1 ? 1 : 0;
      const keys = at === 0 ? `a=t,f=100,t=d,i=${id},q=2,m=${more}` : `m=${more}`;
      return `\u001b_G${keys};${part}\u001b\\`;
    })
    .join('');
}

/** Draws kitty image `id` at the cursor over `columns` by `rows` cells, in place of where it stood before. */
export const kittyPlace = (id: number, columns: number, rows: number): string =>
  `\u001b_Ga=p,i=${id},p=1,c=${columns},r=${rows},C=1,q=2\u001b\\`;

/** Takes kitty image `id` off the screen and out of the terminal's memory. */
export const kittyDelete = (id: number): string => `\u001b_Ga=d,d=I,i=${id},q=2\u001b\\`;

/** The iTerm2 inline image of `bytes` over `columns` by `rows` cells, its proportions kept. */
export function itermSequence(bytes: Uint8Array, name: string, columns: number, rows: number): string {
  const label = Buffer.from(name).toString('base64');
  const data = Buffer.from(bytes).toString('base64');
  return `\u001b]1337;File=name=${label};size=${bytes.length};width=${columns};height=${rows};preserveAspectRatio=1;inline=1:${data}\u0007`;
}
