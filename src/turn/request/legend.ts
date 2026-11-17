// The body of the root block `<interface>`, the legend: each custom emoji and sticker the lines of `<chat>` and
// `<meanwhile>` use stands once, under its interface and its kind, with its stable name, its platform name and its whole
// description. A line of chat holds the stable name alone. The reader (src/turn/request/reader.ts) gathers the items
// after the cuts and prints the block between `<meanwhile>` and `<chat>`.
import { fill } from '../../format.ts';
import type { MediaName } from '../../memory/store-media-names.ts';
import type { Labels } from './types.ts';

type Kind = 'emoji' | 'sticker';

/** The labels the legend reads. */
type LegendLabels = Pick<Labels, 'legend'>;

/** One thing of the legend: its interface, kind, stable name, platform name, description and whether it has a picture. */
export type LegendItem = {
  iface: string;
  kind: Kind;
  name: string;
  platformName: string;
  text: string | null;
  readable: boolean;
};

/** A sticker a line shows: its stable name, the text form the line carries and whether it has a picture. */
export type SeenSticker = { name: string; text: string | null; readable: boolean };

// A custom emoji as a line's text holds it: its stable name between colons.
const EMOJI_NAME_RE = /:(e\d+):/g;
// The subtag of each kind, in the order they print.
const KIND_TAGS: ReadonlyArray<[Kind, string]> = [
  ['emoji', 'emojis'],
  ['sticker', 'stickers'],
];

/** The number of a stable name, so `e3` stands before `e12`. */
const numberOf = (name: string): number => Number(name.slice(1));

/** One line of the legend: `legend.unreadable` for a sticker with no picture, `legend.lineNoText` with no description. */
function lineOf(item: LegendItem, labels: LegendLabels): string {
  const name = item.kind === 'emoji' ? `:${item.name}:` : item.name;
  const values = { name, platformName: item.platformName, text: item.text ?? '' };
  if (!item.readable) return fill(labels.legend?.unreadable ?? '', values);
  return fill((item.text ? labels.legend?.line : labels.legend?.lineNoText) ?? '', values);
}

/** The legend's body: interfaces by id, emojis before stickers, things in the order of their numbers; '' for none. */
export function legendText(items: ReadonlyArray<LegendItem>, labels: LegendLabels): string {
  const ifaces = [...new Set(items.map((item) => item.iface))].sort();
  return ifaces
    .map((iface) => {
      const kinds = KIND_TAGS.map(([kind, tag]) => {
        const lines = items
          .filter((item) => item.iface === iface && item.kind === kind)
          .sort((a, b) => numberOf(a.name) - numberOf(b.name))
          .map((item) => lineOf(item, labels));
        return lines.length ? `<${tag}>\n${lines.join('\n')}\n</${tag}>` : '';
      });
      return `<${iface}>${kinds.join('')}</${iface}>`;
    })
    .join('\n');
}

/**
 * The things of the legend: each custom emoji whose stable name stands in `texts`, and each of `stickers`, once, as the
 * store's names know them. `describe` reads a description by its media key, `emoji:<id>` or `sticker:<id>`. A name the
 * store does not hold is left out: a stored line from before stable names holds a platform name.
 */
export function legendItems(
  texts: ReadonlyArray<string>,
  stickers: ReadonlyArray<SeenSticker>,
  nameOf: (name: string) => MediaName | null,
  describe: (key: string) => string | null
): Array<LegendItem> {
  const items = new Map<string, LegendItem>();
  const add = (name: string, kind: Kind, seen: SeenSticker | null): void => {
    const row = items.has(name) ? null : nameOf(name);
    if (!row || row.kind !== kind) return;
    const text = seen?.text ?? describe(`${kind}:${row.nativeId}`);
    const readable = seen?.readable ?? true;
    items.set(name, { iface: row.iface, kind, name, platformName: row.platformName, text, readable });
  };
  for (const text of texts) for (const [, name] of text.matchAll(EMOJI_NAME_RE)) add(name, 'emoji', null);
  for (const sticker of stickers) add(sticker.name, 'sticker', sticker);
  return [...items.values()];
}
