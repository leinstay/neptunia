// The body of `<surroundings>`: what is stable for the turn's place, cached with the persona (docs/prompt-contract.md).
// `<interface>` is the interface's own text, `<root>` the top place with its stored fields, `<place>` the place she is in
// in words with its stored fields. It never says where she is: `<spatial_awareness>` does. The
// request builder (src/turn/request/reader.ts) calls it. Pure.

import { fill, mentionsNamed } from '../../format.ts';
import type { InterfaceNames } from '../../protocol/serve.ts';
import type { Frame, FramePlace } from './frame.ts';
import { block, escapeStored, placeRefText } from './text.ts';
import type { Labels } from './types.ts';

/** The stored fields of a place by name: `purpose`, `tone`, `topics`, and a root's `patterns`, `starters` and the rest. */
export type PlaceFields = Readonly<Record<string, string>>;

/** How a stored field names a `<@id>` mention: the handle (with `@`) of the person it names. */
export type FieldRefs = { readonly mention: (native: string) => string };

/**
 * One line per stored field with text, in the order the labels name the fields, then any other field by its own name, a
 * mention in it by `refs`, else `authors.unknown`.
 */
function fieldLines(fields: PlaceFields | null, labels: Labels, refs: FieldRefs | null): Array<string> {
  const unknown = labels.authors?.unknown ?? '';
  const mention = refs?.mention ?? (() => unknown);
  if (fields === null) return [];
  const l = labels.surroundings ?? {};
  const names = l.fields ?? {};
  const order = [...Object.keys(names), ...Object.keys(fields).filter((key) => !Object.hasOwn(names, key))];
  const template = typeof l.field === 'string' ? l.field : '{field}: {value}';
  return order
    .filter((key) => typeof fields[key] === 'string' && fields[key].trim() !== '')
    .map((key) =>
      fill(template, {
        field: names[key] ?? key,
        value: escapeStored(String(mentionsNamed(fields[key].trim(), mention))),
      })
    );
}

/**
 * A place's body: the place in words from the frame's chain (a one-to-one chat as the interface's word for it with
 * `partner`), with no handle since the body is stable for the turn's place, then its fields.
 */
function placeBody(
  frame: Frame,
  place: FramePlace,
  fields: PlaceFields | null,
  labels: Labels,
  partner: string | null,
  refs: FieldRefs | null,
  names: InterfaceNames | undefined
): string {
  const at = frame.chain.findIndex((link) => link.id === place.id);
  const chain = at < 0 ? [{ id: place.id, kind: place.kind, name: place.name }] : frame.chain.slice(at);
  const ref = placeRefText(labels, null, {
    iface: frame.interface,
    chain,
    ...(names === undefined ? {} : { names }),
    partner,
  });
  return [ref, ...fieldLines(fields, labels, refs)].join('\n');
}

/**
 * `<interface>`, `<root>` and `<place>` of `frame`. `interfaceText` is what the interface declares (its mention, link and
 * reaction forms and its nouns, already worded); `rootPlace` and `place` are the stored fields of the frame's root and
 * place, `partner` the handle (with `@`) of a one-to-one chat's partner, `refs` how a mention in a field reads and `names`
 * what the interface declared (its name, its nouns and its word for a direct chat). A one-to-one chat and the command
 * line have no root. '' for a turn that is nowhere.
 */
export function surroundingsOf(
  frame: Frame,
  interfaceText: string,
  rootPlace: PlaceFields | null,
  place: PlaceFields | null,
  labels: Labels,
  partner: string | null = null,
  refs: FieldRefs | null = null,
  names?: InterfaceNames
): string {
  if (frame.place === null) return '';
  const root = frame.root !== null && frame.root.id !== frame.place.id ? frame.root : null;
  return [
    block('interface', interfaceText.trim()),
    root === null ? '' : block('root', placeBody(frame, root, rootPlace, labels, null, refs, names)),
    block('place', placeBody(frame, frame.place, place, labels, partner, refs, names)),
  ]
    .filter(Boolean)
    .join('\n');
}
