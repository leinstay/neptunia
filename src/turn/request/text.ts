// The small text tools every request builder shares: a block's tags, the `{{key}}` filler of the prompt files, the
// stored `<@id>` tokens turned into names, the labels' check, and the two date forms the blocks write. The block
// builders of src/turn/request/ and the request builders of src/behavior/prompt.ts call them.

import { fill, formatClock, formatDate } from '../../format.ts';
import { fromTokens } from '../../memory/mentions.ts';
import type { PlaceChainLink } from '../../memory/db/place-tree.ts';
import type { InterfaceNames } from '../../protocol/serve.ts';
import type { Labels, NameOf } from './types.ts';

/** The tokens a request keeps free for the tags around its blocks. */
export const TAG_OVERHEAD = 60;

/**
 * `body` wrapped in `<tag>` ... `</tag>` on lines of their own; '' for an
 * empty body, so a block with nothing to say drops out of a request. The one
 * copy: every request builder uses it.
 */
export function block(tag: string, body: string): string {
  return body ? `<${tag}>\n${body}\n</${tag}>` : '';
}

/** `fromTokens(text, nameOf, 'chat')`, tolerating a non-string `text` and a
 * missing `nameOf` (an unresolved `<@id>` token is then left exactly as
 * stored) -- see docs/prompt-contract.md, "Members are referred to
 * by id, never by nickname". */
export function resolveChatText<T>(text: T, nameOf: NameOf | null | undefined): T | string {
  if (typeof text !== 'string') return text;
  return fromTokens(text, typeof nameOf === 'function' ? nameOf : () => null, 'chat');
}

/**
 * Fill the double-brace `{{key}}` placeholders of a prompt file (the prompt
 * contract's form; labels.json uses single braces, see fill() in
 * src/format.ts). The one `{{key}}` filler of the codebase: a key
 * present in `values` (an own property) with a non-null value is replaced by
 * `String(value)`; a key that is absent, null or undefined leaves its
 * placeholder untouched. A missing template reads as ''.
 */
export function fillPromptTemplate(template: unknown, values?: Record<string, unknown> | null): string {
  const source = values ?? {};
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a prompt file as the prompt layer gives it, read as text
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (all: string, key: string) =>
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a placeholder's value is any value, read as text
    Object.hasOwn(source, key) && source[key] != null ? String(source[key]) : all
  );
}

/**
 * Whether `labels` (prompts.labels) can render a request at all: an object
 * with `transcript`. The startup check (src/index.ts) and every request
 * builder use this one test.
 */
export function hasRequiredLabels(labels: unknown): boolean {
  return Boolean(labels) && typeof labels === 'object' && Boolean((labels as { transcript?: unknown }).transcript);
}

/** A deployment with no/broken labels.json must fail loudly, not send a broken prompt. */
export function requireLabels(prompts: { labels?: unknown } | null | undefined): Labels {
  const labels = prompts?.labels;
  if (!hasRequiredLabels(labels)) {
    throw new Error('prompts.labels is missing or incomplete: labels.transcript is required');
  }
  // hasRequiredLabels found the object with its transcript: the labels file the prompt contract describes.
  return labels as Labels;
}

/** `{from}` / `{to}` of a pulled channel's header: the date and the clock of `ts`, joined as `<now>` joins them. */
export function pulledMoment(ts: number, timezone: string, locale: string | undefined): string {
  return `${formatDate(ts, timezone, locale)}, ${formatClock(ts, timezone, locale)}`;
}

/**
 * A stored text as a value inside a request: `<` written as `&lt;`, so a name, a field or a message that holds a tag
 * can neither close a block nor open one in the frame's own words. A `>` and an `&` stay. Anything that is not a
 * string reads as ''.
 */
export function escapeStored(text: unknown): string {
  return typeof text === 'string' ? text.replace(/</g, '&lt;') : '';
}

/** An author named by their handle (`authors.line`), `authors.unknown` without one. */
export function authorText(labels: Labels, handle: string | null): string {
  const words = labels.authors ?? {};
  if (handle === null) return words.unknown ?? '';
  return fill(words.line ?? '{handle}', { handle: `@${handle}` });
}

/**
 * A place as a request names it: where the interface knows it by. `chain` runs from the place up to the top (innermost
 * first), `names` is what the interface declared in its hello (`iface` stands for its name when it declared none) and
 * `partner` the handle, `@` included, of a direct chat's partner.
 */
export type PlaceWords = {
  iface: string;
  chain: ReadonlyArray<PlaceChainLink>;
  names?: InterfaceNames;
  partner?: string | null;
  /** `context.names.emoji`, read by the caller when it builds the request: the names keep their emoji when true. */
  keepEmoji?: boolean;
};

/** The labels a place in words reads: `places`, the unnamed word of `spatial` and the unknown word of `authors`. */
export type PlaceLabels = Pick<Labels, 'places' | 'spatial' | 'authors'>;

const PICTOGRAPH = String.raw`(?:[\u00A9\u00AE\u2122](?=\uFE0F)|(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic})`;
const EXTENDERS = String.raw`[\p{Emoji_Modifier}\uFE0F\u{E0020}-\u{E007F}]*`;
const EMOJI = String.raw`(?:\p{Regional_Indicator}{1,2}|[0-9#*]\uFE0F?\u20E3|${PICTOGRAPH}${EXTENDERS}(?:\u200D${PICTOGRAPH}${EXTENDERS})*)`;
const EMOJI_RUN = new RegExp(String.raw`\s*${EMOJI}(?:\s*${EMOJI})*\s*`, 'gu');

/**
 * A name of a place or of a person as a request shows it: the emoji left out (a flag, a skin tone, a joined sequence and
 * a keycap as one each), the name trimmed and one space left where an emoji stood between two words. A name of nothing
 * but emoji, a `:name:` custom emoji and any digit or punctuation stay, and a name with no emoji comes back as it is.
 * With `keepEmoji` the name is shown as stored, trimmed.
 */
export function shownName(name: string, keepEmoji = false): string {
  if (keepEmoji) return name.trim();
  let found = false;
  const shown = name
    .replace(EMOJI_RUN, (run) => {
      found = true;
      return /\s/.test(run) ? ' ' : '';
    })
    .trim();
  if (!found) return name;
  return shown === '' ? name.trim() : shown;
}

/** `context.names.emoji` of a live config, read at the moment of use: whether names keep their emoji. */
export function keepsEmoji(config: unknown): boolean {
  // The live config as the request builders read it: any object, a missing or broken level counting as unset.
  return (config as { context?: { names?: { emoji?: unknown } } } | null | undefined)?.context?.names?.emoji === true;
}

/** A name as a quoted value: escaped as any stored text, and a `"` written `\"`, so the name closes where it ends. */
const quoted = (name: string): string => escapeStored(name).replace(/"/g, '\\"');

/** One link of a chain: the interface's noun for its kind and the name, the name alone for a kind with no noun. */
function linkText(
  labels: PlaceLabels,
  link: PlaceChainLink,
  names: InterfaceNames | undefined,
  keepEmoji: boolean | undefined
): string {
  const words = labels.places ?? {};
  const name = quoted(
    typeof link.name === 'string' ? shownName(link.name, keepEmoji) : (labels.spatial?.unnamed ?? '')
  );
  const noun = link.kind === null ? undefined : names?.nouns[link.kind];
  return noun
    ? fill(words.link ?? '{noun} "{name}"', { noun: escapeStored(noun), name })
    : fill(words.linkPlain ?? '"{name}"', { name });
}

/** The direct chat's own link: `places.dm` with the interface's word for it and the partner's handle. */
function dmText(labels: PlaceLabels, place: PlaceWords): string {
  return fill(labels.places?.dm ?? '{noun} with {name}', {
    noun: escapeStored(place.names?.dm || place.chain.at(0)?.kind || ''),
    name: escapeStored(place.partner ?? labels.authors?.unknown ?? ''),
  });
}

/**
 * The place's own link alone, with no parent and no interface: the innermost link as `places.link` (or `places.linkPlain`),
 * a direct chat as `places.dm`.
 */
export function placeOwnText(labels: PlaceLabels, place: PlaceWords): string {
  const first = place.chain.at(0);
  if (first === undefined) return '';
  return first.kind === 'dm' ? dmText(labels, place) : linkText(labels, first, place.names, place.keepEmoji);
}

/**
 * A place in words (`places.ref`, `#{handle}: {name}`), or without the handle part (`places.refUnhandled`) for a place with
 * no handle. `{name}` is the links innermost first, each as `places.link` with the interface's noun for the kind and
 * the name in quotes (`places.linkPlain` for a kind with no noun), then `places.iface` with the interface's name, joined
 * with `places.join`. A direct chat is `places.dm` with the interface's word for it and the partner's handle.
 */
export function placeRefText(labels: PlaceLabels, handle: string | null, place: PlaceWords): string {
  const words = labels.places ?? {};
  const { names } = place;
  const parts =
    place.chain.at(0)?.kind === 'dm'
      ? [dmText(labels, place)]
      : place.chain.map((link) => linkText(labels, link, names, place.keepEmoji));
  parts.push(fill(words.iface ?? 'interface "{name}"', { name: quoted(names?.interface || place.iface) }));
  const name = parts.join(words.join ?? ', ');
  return handle === null
    ? fill(words.refUnhandled ?? '{name}', { name })
    : fill(words.ref ?? '#{handle}: {name}', { handle, name });
}

// A stored place inside a text the turn renders before the request's handle books exist (`<my_day>` and `<intentions>`):
// the turn writes the place as a token that holds the place's id, and the request builder (reader.ts) replaces each
// token by the way the rest of the request names that place. Private-use characters keep a token from colliding with
// a stored text.
const TOKEN_OPEN = '\uE000';
const TOKEN_CLOSE = '\uE001';
const PLACE_TOKEN = new RegExp(`${TOKEN_OPEN}([^${TOKEN_OPEN}${TOKEN_CLOSE}]*)${TOKEN_CLOSE}`, 'g');

/** The token of the stored place `placeId`, for a text the request builder resolves. */
export const placeToken = (placeId: string): string =>
  `${TOKEN_OPEN}${placeId.replace(/[\uE000\uE001]/g, '')}${TOKEN_CLOSE}`;

/** The ids of the places the tokens of `texts` hold, each once, in the order they appear. */
export function placeIdsIn(texts: ReadonlyArray<string | null | undefined>): Array<string> {
  const ids = new Set<string>();
  for (const text of texts) for (const [, id = ''] of (text ?? '').matchAll(PLACE_TOKEN)) if (id !== '') ids.add(id);
  return [...ids];
}

/** `text` with each place token replaced by `named(placeId)`. */
export const withPlaces = (text: string, named: (placeId: string) => string): string =>
  text.replace(PLACE_TOKEN, (_all, id: string) => named(id));
