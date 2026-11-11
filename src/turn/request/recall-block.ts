// The body of `<recall>`: what she looked up herself in the last turns of this place (docs/prompt-contract.md), from the
// ring of her lookups (src/turn/calls.ts#createLookupRing). Each lookup says when, where she called from, the tool, the
// place it searched when its arguments name one (by its handle and path, `places.ref`, as the request names it), the
// query, the status and a bounded extract of the result. A lookup
// whose quoted sources are all retired is left out. An extract's `#n` numbers are given anew in each request
// (`numberedLookups`), since a number names its line only in the turn that issued it. The request builder
// (src/turn/request/reader.ts) calls both. Pure.

import { fill, formatClock } from '../../format.ts';
import type { Lookup, SearchRef } from '../calls.ts';
import { escapeStored, pathText } from './text.ts';
import type { Labels } from './types.ts';

/** The arguments that name what a lookup searched for, in the order they are read. */
const QUERY_ARGS = ['query', 'text', 'q', 'url', 'about'];
/** The arguments that name the place a lookup searched. */
const PLACE_ARGS = ['place', 'channel'];

const textArg = (args: Record<string, unknown>, names: ReadonlyArray<string>): string | null => {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

/** What a lookup asked: its query argument, else every plain argument but the place as `name=value`. */
function queryOf(args: Record<string, unknown>): string {
  const query = textArg(args, QUERY_ARGS);
  if (query !== null) return query;
  return Object.entries(args)
    .filter(([name, value]) => !PLACE_ARGS.includes(name) && ['string', 'number', 'boolean'].includes(typeof value))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(', ');
}

/** Whether every source a lookup quotes is retired; a lookup that quotes none stands. */
const allRetired = (lookup: Lookup, retired: ReadonlySet<string>): boolean =>
  lookup.sourceIds.length > 0 && lookup.sourceIds.every((id) => retired.has(id));

/** How a request names a place id she searched: its handle and path (`places.ref`). */
export type PlaceRefOf = (placeId: string) => string;

/** One lookup in the labels' words. */
function lookupText(lookup: Lookup, labels: Labels, timezone: string, placeRef: PlaceRefOf | null): string {
  const l = labels.recall ?? {};
  const place = textArg(lookup.args, PLACE_ARGS);
  const searched = place === null ? '' : placeRef === null ? escapeStored(place) : placeRef(place);
  const head = fill(l.item ?? '', {
    time: formatClock(lookup.at, timezone, labels.locale),
    from: pathText(lookup.place.path, labels.memory?.pathJoin),
    tool: escapeStored(lookup.tool),
    searched: place === null ? '' : fill(l.searched ?? '', { place: searched }),
    query: escapeStored(queryOf(lookup.args)),
    status: escapeStored(lookup.status),
  });
  const extract = lookup.extract.trim() === '' ? '' : fill(l.extract ?? '', { extract: escapeStored(lookup.extract) });
  return [head, extract].filter(Boolean).join('\n');
}

/** The lookups `<recall>` shows, oldest first: a lookup whose quoted sources are all in `retired` is left out. */
export function shownLookups(lookups: ReadonlyArray<Lookup>, retired: ReadonlySet<string>): Array<Lookup> {
  return lookups.filter((lookup) => !allRetired(lookup, retired)).sort((a, b) => a.at - b.at);
}

/** The number a read puts at the head of a line, before the line's time: `#23 [11:09] ...`. */
const HEAD = /^#(\d{1,9}) (?=\[)/u;

/** `text` with the characters a regular expression reads as syntax escaped. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The markers a read puts after a line's words that carry a number: the reply marker (`transcript.replyTo`, `{index}`)
 * and the marker of the line that started her turn (`transcript.triggeredBy`, `{n}`), each as a pattern over the
 * marker up to its number, the number its last group.
 */
function markersOf(labels: Labels): Array<RegExp> {
  return [
    ['replyTo', 'index'],
    ['triggeredBy', 'n'],
  ].flatMap(([key = '', slot = '']) => {
    const template = labelAt(labels, ['transcript', key]);
    const at = template.indexOf(`{${slot}}`);
    if (at < 0) return [];
    const head = literal(template.slice(0, at)).replace(/\\\{\w+\\\}/g, '[^\\n]*?');
    return [new RegExp(`(${head})(\\d{1,9})`, 'u')];
  });
}

/** A label's text at `path` under `labels`, '' when absent. */
function labelAt(labels: Labels, path: ReadonlyArray<string>): string {
  let node: unknown = labels;
  for (const key of path) node = node !== null && typeof node === 'object' ? Reflect.get(node, key) : undefined;
  return typeof node === 'string' ? node : '';
}

/** The lines of a read that say how to read on (`conversation.earlier` and `.later`), each as a pattern and its template. */
function hintsOf(labels: Labels): Array<{ pattern: RegExp; template: string }> {
  return ['earlier', 'later']
    .map((key) => labelAt(labels, ['tools', 'tools', 'conversation', key]))
    .filter((template) => template.includes('{n}'))
    .map((template) => {
      const [head = '', ...rest] = template.split('{n}').map(literal);
      return { pattern: new RegExp(`^${head}(\\d{1,9})${rest.join('\\d{1,9}')}$`, 'u'), template };
    });
}

/** The lines that tell her the numbers of a result work in her calls (`tools.tools.<tool>.handles`). */
function handleLinesOf(labels: Labels): Set<string> {
  const section: unknown = Reflect.get(labels, 'tools');
  const tools: unknown = section !== null && typeof section === 'object' ? Reflect.get(section, 'tools') : null;
  const lines = new Set<string>();
  if (tools === null || typeof tools !== 'object') return lines;
  for (const one of Object.values(tools)) {
    const line: unknown = one !== null && typeof one === 'object' ? Reflect.get(one, 'handles') : null;
    if (typeof line === 'string' && line !== '') lines.add(line);
  }
  return lines;
}

/** The stored source a numbered line was read from, null for a line of a read the record answered without one. */
function sourceOfRef(ref: SearchRef): string | null {
  const message: unknown = ref.message;
  const read: unknown = message !== null && typeof message === 'object' ? Reflect.get(message, 'sourceId') : null;
  const id = ref.stored?.sourceId ?? read;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * `lookups` with the numbers a read put in their extracts (at the head of a line, in its reply and turn markers and in
 * the lines that say how to read on) given anew from `from` on, in the order the extracts show them, and the
 * lines those numbers name for the turn's registry (src/turn/calls.ts#searchHandles). A number keeps its line through
 * the lookup's `lines`, the lines the read numbered in its own turn. A line whose stored source `live` says is gone, a
 * number the lookup's lines do not hold and every number of a lookup without lines (one the journal restored) is cut.
 * A `#n` someone wrote in a line's words stays as written. A line that says how to read on is dropped with its number,
 * and the line that says the numbers work in her calls is
 * dropped from an extract left with none. One line in two lookups takes one number.
 */
export function numberedLookups(
  lookups: ReadonlyArray<Lookup>,
  { from, live, labels }: { from: number; live: (sourceId: string) => boolean; labels: Labels }
): { lookups: Array<Lookup>; refs: Array<SearchRef> } {
  const hints = hintsOf(labels);
  const handleLines = handleLinesOf(labels);
  const markers = markersOf(labels);
  const given = new Map<string, number>();
  const refs: Array<SearchRef> = [];
  let next = from;
  const numbered = lookups.map((lookup) => {
    const byOld = new Map((lookup.lines ?? []).map((ref) => [ref.n, ref]));
    const renumber = (n: number): number | null => {
      const ref = byOld.get(n);
      if (ref === undefined) return null;
      const sourceId = sourceOfRef(ref);
      if (sourceId !== null && !live(sourceId)) return null;
      const key = sourceId ?? JSON.stringify([ref.placeId ?? null, String(ref.id)]);
      let fresh = given.get(key);
      if (fresh === undefined) {
        fresh = next;
        next += 1;
        given.set(key, fresh);
        refs.push({ ...ref, n: fresh });
      }
      return fresh;
    };
    let kept = 0;
    const out: Array<string> = [];
    for (const line of lookup.extract.split('\n')) {
      const hint = hints.find(({ pattern }) => pattern.test(line));
      if (hint) {
        const fresh = renumber(Number(hint.pattern.exec(line)?.[1]));
        if (fresh !== null) out.push(fill(hint.template, { n: String(fresh) }));
        continue;
      }
      // Only the numbers the read put there change: the head of a line and its markers, never a `#n` in its words.
      const head = HEAD.exec(line);
      let text = line;
      if (head) {
        const fresh = renumber(Number(head[1]));
        text = (fresh === null ? '' : `#${fresh} `) + line.slice(head[0].length);
        if (fresh !== null) kept += 1;
        for (const marker of markers)
          text = text.replace(marker, (_all, before: string, digits: string) => {
            const parent = renumber(Number(digits));
            return parent === null ? before.replace(/#$/u, '') : `${before}${parent}`;
          });
      }
      out.push(text);
    }
    const extract = (kept > 0 ? out : out.filter((line) => !handleLines.has(line))).join('\n');
    return { ...lookup, extract };
  });
  return { lookups: numbered, refs };
}

/**
 * The body of `<recall>` over `lookups`, oldest first, `window.retired` naming the source ids that are retired, a searched
 * place named by `placeRef`. '' with no lookup left.
 */
export function recallBlockOf(
  lookups: ReadonlyArray<Lookup>,
  window: { retired: ReadonlySet<string> },
  labels: Labels,
  timezone: string,
  placeRef: PlaceRefOf | null = null
): string {
  const shown = shownLookups(lookups, window.retired);
  if (shown.length === 0) return '';
  const header = labels.recall?.header ?? '';
  return [header, ...shown.map((lookup) => lookupText(lookup, labels, timezone, placeRef))]
    .filter(Boolean)
    .join('\n\n');
}
