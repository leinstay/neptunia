// What `/attach open` shows of a file in the command window, through the terminal alone and with no process: a picture
// drawn with the graphics protocol the terminal speaks (cli/terminal-graphics.ts), a text file's content, and for any
// other file, or a picture the terminal cannot draw, plain sentences that say so with the path of the stored file.
// cli/chat-controller.ts puts the answer in the window and places the picture.
import type { KeptRead } from './attachment-actions.ts';
import {
  decodeImage,
  encodePng,
  fitCells,
  itermSequence,
  kittyPlace,
  kittyTransmit,
  sixelSequence,
} from './terminal-graphics.ts';
import type { Pixels, Size } from './terminal-graphics.ts';
import type { GraphicsSupport, Placement } from './terminal-replies.ts';

/** A file to show: its name, its kind in the names memory stores, and its stored description. */
export type ViewedFile = { name: string; kind: string; description: string | null };

/** A picture a result holds, for the window to place: its PNG for kitty and iTerm2, its pixels for Sixel, its size. */
export type ResultGraphic = {
  protocol: 'kitty' | 'iterm2' | 'sixel';
  bytes: Uint8Array;
  pixels: Pixels | null;
  size: Size | null;
  name: string;
  cell: Size;
  kittyId: number;
};

/** The most of a text file the window reads, and the most lines it shows of it. */
const TEXT_BYTES = 256 * 1024;
const TEXT_LINES = 2000;
/** The most a picture may hold: one file of the chat (bin/chat-images.ts). */
const PICTURE_BYTES = 10 * 1024 * 1024;
const PICTURE_KINDS = new Set(['image', 'gif', 'sticker']);
const TEXT_EXTENSIONS = new Set(
  'txt md markdown csv tsv json jsonl yaml yml toml ini log xml html css js mjs cjs ts tsx jsx py rb go rs java c h cpp hpp sh bash zsh sql'.split(
    ' '
  )
);

const extensionOf = (name: string): string => /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** Whether the window shows a file as text: a text item, or a name with an extension of text or code. */
export const isTextFile = (file: ViewedFile): boolean =>
  file.kind === 'text' || TEXT_EXTENSIONS.has(extensionOf(file.name));

/** A size for a person: bytes, KiB or MiB. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** The sentences for a file the window cannot show, with the path of the stored file when there is one. */
function unshowable(path: string | null): string {
  if (path === null) return 'This file format cannot be shown here.';
  return ['This file format cannot be shown here.', 'You can open it or download it from this path:', path].join('\n');
}

/** The picture of `bytes` in the protocol the terminal speaks, or null when it speaks none or the file cannot be read. */
async function graphicOf(
  bytes: Uint8Array,
  name: string,
  support: GraphicsSupport,
  kittyId: number
): Promise<ResultGraphic | null> {
  if (support.protocol === 'none') return null;
  const pixels = await decodeImage(bytes);
  if (pixels === null) return null;
  const base = { name, cell: support.cell, kittyId, size: { width: pixels.width, height: pixels.height } };
  if (support.protocol === 'sixel') return { ...base, protocol: 'sixel', bytes, pixels };
  return { ...base, protocol: support.protocol, bytes: await encodePng(pixels), pixels: null };
}

/** The text of a text file, its lines capped with a note that says how many more there are. */
function textOf(bytes: Uint8Array, path: string | null): string {
  const lines = new TextDecoder().decode(bytes).replaceAll('\r\n', '\n').replace(/\n$/, '').split('\n');
  if (lines.length <= TEXT_LINES) return lines.join('\n');
  const more = `… ${lines.length - TEXT_LINES} more lines are not shown.`;
  return [...lines.slice(0, TEXT_LINES), path === null ? more : `${more} The whole file is at ${path}`].join('\n');
}

/**
 * What the window shows of `file`: its answer, and the picture to place under it. `read` gives its size and, up to the
 * bytes asked for, its content; `path` is where it is stored on this machine, null when that is unknown.
 */
export async function viewFile(
  file: ViewedFile,
  {
    read,
    path,
    graphics,
    kittyId,
  }: {
    read: (maxBytes: number) => Promise<KeptRead | null>;
    path: string | null;
    graphics: () => Promise<GraphicsSupport>;
    kittyId: number;
  }
): Promise<{ answer: string; graphic: ResultGraphic | null }> {
  const isText = isTextFile(file);
  const isPicture = PICTURE_KINDS.has(file.kind);
  const kept = await read(isText ? TEXT_BYTES : isPicture ? PICTURE_BYTES : 0);
  if (kept === null) return { answer: `${file.name} cannot be read from where it was kept.`, graphic: null };
  const header = `${file.name} · ${file.kind} · ${sizeText(kept.size)}`;
  if (isText)
    return {
      answer: [
        header,
        kept.bytes === null ? `It is too long to show here. ${unshowable(path)}` : textOf(kept.bytes, path),
      ].join('\n'),
      graphic: null,
    };
  const described = file.description === null ? [] : [file.description];
  if (!isPicture || kept.bytes === null)
    return { answer: [header, ...described, unshowable(path)].join('\n'), graphic: null };
  const graphic = await graphicOf(kept.bytes, file.name, await graphics(), kittyId);
  if (graphic === null) return { answer: [header, ...described, unshowable(path)].join('\n'), graphic: null };
  return { answer: [header, ...described].join('\n'), graphic };
}

/** The cells a picture takes in at most `columns` by `rows`, its proportions kept. */
export function graphicBox(
  graphic: ResultGraphic,
  columns: number,
  rows: number
): { columns: number; rows: number; width: number; height: number } {
  const max = { columns: Math.max(1, columns), rows: Math.max(1, rows) };
  const size = graphic.size ?? { width: max.columns * graphic.cell.width, height: max.rows * graphic.cell.height };
  return fitCells(size, graphic.cell, max);
}

/** What draws `graphic` in `box` with its top left cell at `row` and `column`, under `key`. */
export function placementOf(
  graphic: ResultGraphic,
  box: { columns: number; rows: number; width: number; height: number },
  at: { row: number; column: number; key: string }
): Placement {
  const where = { key: at.key, row: at.row, column: at.column };
  if (graphic.protocol === 'kitty')
    return {
      ...where,
      draw: kittyPlace(graphic.kittyId, box.columns, box.rows),
      prepare: kittyTransmit(graphic.bytes, graphic.kittyId),
      kittyId: graphic.kittyId,
    };
  if (graphic.protocol === 'iterm2')
    return { ...where, draw: itermSequence(graphic.bytes, graphic.name, box.columns, box.rows) };
  const pixels = graphic.pixels ?? { width: 1, height: 1, rgba: new Uint8Array(4) };
  return { ...where, draw: sixelSequence(pixels, box.width, box.height) };
}
