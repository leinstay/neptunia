// A picture drawn by the terminal itself, so it shows the same at the machine and over SSH: the size of a PNG, JPEG or
// GIF from its header, the pixels of a PNG decoded with `node:zlib` alone, a box of cells that keeps its proportions, and
// the sequences of the three graphics protocols. kitty and iTerm2 take the file's bytes and scale it to the box
// themselves, and Sixel gets the decoded pixels scaled and mapped to a 6x6x6 colour cube. A JPEG, GIF or WebP has no
// decoder here, so a Sixel terminal shows its description instead. cli/terminal-replies.ts asks the terminal which
// protocol it speaks, and cli/chat-controller.ts places the picture in the command window.
import { inflateSync } from 'node:zlib';

export type Pixels = { width: number; height: number; rgba: Uint8Array };
export type Size = { width: number; height: number };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The most pixels a picture may hold before the chat declines to decode it: past any picture the chat carries. */
const MAX_PIXELS = 40_000_000;
/** Samples per pixel of each PNG colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export const isPng = (bytes: Uint8Array): boolean => PNG_SIGNATURE.every((byte, at) => bytes[at] === byte);

const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
const u16 = (bytes: Uint8Array, at: number): number => (bytes[at] << 8) | bytes[at + 1];

/** The width and height a JPEG's frame header declares, null when none is found. */
function jpegSize(bytes: Uint8Array): Size | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { width: u16(bytes, at + 7), height: u16(bytes, at + 5) };
    at += 2 + u16(bytes, at + 2);
  }
  return null;
}

/** The size a PNG, JPEG or GIF declares in its header, null for any other bytes. */
export function imageSize(bytes: Uint8Array): Size | null {
  if (isPng(bytes) && bytes.length >= 24) return { width: u32(bytes, 16), height: u32(bytes, 20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  const head = String.fromCharCode(...bytes.slice(0, 6));
  if ((head === 'GIF87a' || head === 'GIF89a') && bytes.length >= 10)
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  return null;
}

type Header = { width: number; height: number; depth: number; colour: number; interlaced: boolean };

/** The chunks of a PNG: its header, palette, transparency and joined image data. */
function chunksOf(bytes: Uint8Array): { header: Header; palette: Uint8Array; alpha: Uint8Array; data: Buffer } | null {
  let header: Header | null = null;
  let palette = new Uint8Array();
  let alpha = new Uint8Array();
  const data: Array<Uint8Array> = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(...bytes.slice(at + 4, at + 8));
    const body = bytes.slice(at + 8, at + 8 + length);
    if (type === 'IHDR')
      header = {
        width: u32(body, 0),
        height: u32(body, 4),
        depth: body[8],
        colour: body[9],
        interlaced: body[12] === 1,
      };
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  return header === null ? null : { header, palette, alpha, data: Buffer.concat(data) };
}

const paeth = (left: number, up: number, corner: number): number => {
  const guess = left + up - corner;
  const toLeft = Math.abs(guess - left);
  const toUp = Math.abs(guess - up);
  const toCorner = Math.abs(guess - corner);
  if (toLeft <= toUp && toLeft <= toCorner) return left;
  return toUp <= toCorner ? up : corner;
};

/** The image data with each row's filter undone: `rowBytes` bytes a row, `step` bytes a whole pixel. */
function unfilter(raw: Buffer, height: number, rowBytes: number, step: number): Uint8Array | null {
  const out = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (rowBytes + 1)];
    const from = y * (rowBytes + 1) + 1;
    const row = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const value = raw[from + x];
      const left = x >= step ? out[row + x - step] : 0;
      const up = y > 0 ? out[row - rowBytes + x] : 0;
      const corner = x >= step && y > 0 ? out[row - rowBytes + x - step] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter];
      if (predicted === undefined || value === undefined) return null;
      out[row + x] = (value + predicted) & 0xff;
    }
  }
  return out;
}

/** Whether the chat reads a PNG of this header: not interlaced, a known colour type and depth, not too large. */
function isReadable(header: Header): boolean {
  const { width, height, depth, colour } = header;
  if (CHANNELS[colour] === undefined || header.interlaced || width === 0 || height === 0) return false;
  if (width * height > MAX_PIXELS) return false;
  return colour === 3 ? [1, 2, 4, 8].includes(depth) : depth === 8 || depth === 16;
}

/** Writes pixel `x` of row `y` as RGBA at `out`, from the unfiltered rows of a PNG of `header`. */
function writePixel(
  rgba: Uint8Array,
  out: number,
  rows: Uint8Array,
  at: { x: number; y: number; rowBytes: number },
  png: { header: Header; palette: Uint8Array; alpha: Uint8Array }
): void {
  const { depth, colour } = png.header;
  const { x, y, rowBytes } = at;
  if (colour === 3) {
    const bit = x * depth;
    const index = (rows[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    rgba.set([png.palette[index * 3] ?? 0, png.palette[index * 3 + 1] ?? 0, png.palette[index * 3 + 2] ?? 0], out);
    rgba[out + 3] = png.alpha[index] ?? 255;
    return;
  }
  const channels = CHANNELS[colour] ?? 1;
  const sampleBytes = depth === 16 ? 2 : 1;
  const start = y * rowBytes + x * channels * sampleBytes;
  const sample = (n: number): number => rows[start + n * sampleBytes];
  const grey = colour === 0 || colour === 4;
  rgba[out] = sample(0);
  rgba[out + 1] = grey ? sample(0) : sample(1);
  rgba[out + 2] = grey ? sample(0) : sample(2);
  rgba[out + 3] = colour === 4 ? sample(1) : colour === 6 ? sample(3) : 255;
}

/** The pixels of a PNG as RGBA, null for anything it does not read: another format, an interlaced or damaged PNG. */
export function decodePng(bytes: Uint8Array): Pixels | null {
  if (!isPng(bytes)) return null;
  try {
    const png = chunksOf(bytes);
    if (png === null || !isReadable(png.header)) return null;
    const { width, height, depth, colour } = png.header;
    const channels = CHANNELS[colour] ?? 1;
    const rowBytes = Math.ceil((width * channels * depth) / 8);
    const raw = inflateSync(png.data);
    if (raw.length < height * (rowBytes + 1)) return null;
    const rows = unfilter(raw, height, rowBytes, Math.max(1, (channels * depth) >> 3));
    if (rows === null) return null;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) writePixel(rgba, (y * width + x) * 4, rows, { x, y, rowBytes }, png);
    return { width, height, rgba };
  } catch {
    return null;
  }
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
