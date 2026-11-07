// The body of `<surroundings>`: what is stable for the turn's place, cached with the persona (docs/prompt-contract.md).
// `<interface>` is the interface's own text, `<root>` the top place with its stored fields, `<place>` the place she is in
// by its path with its stored fields. It never says where she is: `<spatial_awareness>` does, by the same path. The
// request builder (src/turn/request/reader.ts) calls it. Pure.

import { fill } from '../../format.ts';
import type { Frame, FramePlace } from './frame.ts';
import { block, escapeStored, pathText } from './text.ts';
import type { Labels } from './types.ts';

/** The stored fields of a place by name: `purpose`, `tone`, `topics`, and a root's `patterns`, `starters` and the rest. */
export type PlaceFields = Readonly<Record<string, string>>;

/** One line per stored field with text, in the order the labels name the fields, then any other field by its own name. */
function fieldLines(fields: PlaceFields | null, labels: Labels): Array<string> {
  if (fields === null) return [];
  const l = labels.surroundings ?? {};
  const names = l.fields ?? {};
  const order = [...Object.keys(names), ...Object.keys(fields).filter((key) => !Object.hasOwn(names, key))];
  const template = typeof l.field === 'string' ? l.field : '{field}: {value}';
  return order
    .filter((key) => typeof fields[key] === 'string' && fields[key].trim() !== '')
    .map((key) => fill(template, { field: names[key] ?? key, value: escapeStored(fields[key].trim()) }));
}

/** A place's body: its path, then its fields. */
function placeBody(place: FramePlace, fields: PlaceFields | null, labels: Labels): string {
  return [pathText(place.path, labels.memory?.pathJoin), ...fieldLines(fields, labels)].join('\n');
}

/**
 * `<interface>`, `<root>` and `<place>` of `frame`. `interfaceText` is what the interface declares (its mention, link and
 * reaction forms and its nouns, already worded); `rootPlace` and `place` are the stored fields of the frame's root and
 * place. A one-to-one chat and the command line have no root. '' for a turn that is nowhere.
 */
export function surroundingsOf(
  frame: Frame,
  interfaceText: string,
  rootPlace: PlaceFields | null,
  place: PlaceFields | null,
  labels: Labels
): string {
  if (frame.place === null) return '';
  const root = frame.root !== null && frame.root.id !== frame.place.id ? frame.root : null;
  return [
    block('interface', interfaceText.trim()),
    root === null ? '' : block('root', placeBody(root, rootPlace, labels)),
    block('place', placeBody(frame.place, place, labels)),
  ]
    .filter(Boolean)
    .join('\n');
}
