// The body of the root block `<media>`, the legend: each custom emoji a block of the request names and each sticker the
// lines of `<chat>` and `<meanwhile>` show stands once, under its interface and its kind, with its stable name, its platform name and its whole
// description. A line of chat holds the stable name alone. The reader (src/turn/request/reader.ts) gathers the items
// after the cuts and prints the block between `<meanwhile>` and `<chat>`.
import { fill } from '../../format.ts';
import { fillSelfMark } from '../../memory/self-mark.ts';
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

/**
 * One line of the legend: `legend.unreadable` for a sticker with no picture, `legend.lineNoText` with no description.
 * A description's `SELF_MARK` reads `selfName`.
 */
function lineOf(item: LegendItem, labels: LegendLabels, selfName: string): string {
  const name = item.kind === 'emoji' ? `:${item.name}:` : item.name;
  const values = { name, platformName: item.platformName, text: fillSelfMark(item.text ?? '', selfName) };
  if (!item.readable) return fill(labels.legend?.unreadable ?? '', values);
  return fill((item.text ? labels.legend?.line : labels.legend?.lineNoText) ?? '', values);
}

/**
 * The legend's body: interfaces by id, emojis before stickers, things in the order of their numbers; '' for none.
 * `selfName` is her name in the place the legend is read in.
 */
export function legendText(items: ReadonlyArray<LegendItem>, labels: LegendLabels, selfName: string): string {
  const ifaces = [...new Set(items.map((item) => item.iface))].sort();
  return ifaces
    .map((iface) => {
      const kinds = KIND_TAGS.map(([kind, tag]) => {
        const lines = items
          .filter((item) => item.iface === iface && item.kind === kind)
          .sort((a, b) => numberOf(a.name) - numberOf(b.name))
          .map((item) => lineOf(item, labels, selfName));
        return lines.length ? `<${tag}>\n${lines.join('\n')}\n</${tag}>` : '';
      });
      return `<${iface}>${kinds.join('')}</${iface}>`;
    })
    .join('\n');
}

/**
 * The things of the legend: each custom emoji whose stable name stands in `texts`, and each of `stickers`, once, as the
 * store's names know them. `describe` reads a description by its media key, `emoji:<id>` or `sticker:<id>`. A name the
 * store does not hold is left out: a person can type `:e99:` for a name nothing holds.
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

type Loose = { [key: string]: unknown };

const looseOf = (value: unknown): Loose | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null;
const listOf = (value: unknown): Array<Loose> =>
  Array.isArray(value)
    ? value.flatMap((one: unknown): Array<Loose> => {
        const item = looseOf(one);
        return item ? [item] : [];
      })
    : [];
const textOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const toldOf = (item: Loose): string | null => textOf(looseOf(item.told)?.text);

/** The legend labels of a labels file read as data: each of `legend.*` that is a string. */
export function legendLabelsOf(labels: unknown): LegendLabels {
  const legend = looseOf(looseOf(labels)?.legend);
  const pick = (key: string): string => textOf(legend?.[key]) ?? '';
  return { legend: { line: pick('line'), lineNoText: pick('lineNoText'), unreadable: pick('unreadable') } };
}

/**
 * The legend of a text of normalized messages read outside the request's own window (a recall stretch, a window read,
 * a prefetch excerpt, the memory session's batch, a transcript of src/format.ts#formatTranscript): each custom emoji and
 * sticker of `messages` and their forwarded parts once, with the text form the line carries or else the caption of
 * `descriptions` by `emoji:<id>` and `sticker:<id>`. '' for none.
 */
export function messagesLegend(
  messages: ReadonlyArray<unknown>,
  nameOf: (name: string) => MediaName | null,
  labels: LegendLabels,
  selfName: string,
  descriptions: ReadonlyMap<string, string> | null = null
): string {
  const parts = messages.flatMap((message) => {
    const one = looseOf(message);
    return one ? [one, ...listOf(one.forwarded)] : [];
  });
  const told = new Map<string, string>(descriptions ?? []);
  for (const part of parts)
    for (const emoji of listOf(part.emojis)) {
      const text = toldOf(emoji);
      if (text) told.set(`emoji:${String(emoji.id)}`, text);
    }
  const texts = parts.map((part) => textOf(part.content) ?? textOf(part.text) ?? '');
  const stickers = parts.flatMap((part) =>
    listOf(part.stickers).flatMap((sticker): Array<SeenSticker> => {
      const name = textOf(sticker.name);
      const text = toldOf(sticker) ?? descriptions?.get(`sticker:${String(sticker.id)}`) ?? null;
      return name ? [{ name, text, readable: Boolean(sticker.url) }] : [];
    })
  );
  return legendText(
    legendItems(texts, stickers, nameOf, (key) => told.get(key) ?? null),
    labels,
    selfName
  );
}

/**
 * The legend of `messages` as the root block `<media>` that stands before their lines, or '' for none. `selfName` is
 * her name in the place the lines are read in.
 */
export function legendBlock(
  messages: ReadonlyArray<unknown>,
  nameOf: (name: string) => MediaName | null,
  labels: unknown,
  selfName: string,
  descriptions: ReadonlyMap<string, string> | null = null
): string {
  const legend = messagesLegend(messages, nameOf, legendLabelsOf(labels), selfName, descriptions);
  return legend ? `<media>\n${legend}\n</media>` : '';
}

// A legend `<media>` that `legendBlock` put at the head of a stretch, with the line break after it.
const LEGEND_BLOCK_RE = /^<media>\n[\s\S]*?\n<\/media>(?:\n|$)/gm;

/**
 * `text` with every legend `<media>` that `legendBlock` wrote into it removed: a stored tool result in `<recall>` keeps
 * its bare stable names, and their lines stand in the request's one root `<media>`.
 */
export const withoutLegends = (text: string): string => text.replace(LEGEND_BLOCK_RE, '');
