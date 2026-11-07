// A line's identity in a stored text, `src:<iface>:<message id>:<revision>` (src/turn/handles.ts writes it in place of
// a `#n`), read back. `refResolverOf` renders it when the text comes into a request again: a line of `<chat>` as its
// current handle, a line elsewhere once as a quote under its path and time, a deleted or unreadable line as unavailable,
// an edited one as its current text with a note. `outgoingRefs` turns it into the interface's form when her words go
// out: a line of this place becomes the reply target, a line of another place the interface's link, and with no link
// form the quote. The reader of the line (`lineOf`) applies the frame's scope, so a reference is no way past it. Pure.

import { fill } from '../../format.ts';
import { escapeStored, pathText, pulledMoment } from './text.ts';
import type { Labels } from './types.ts';

/** A stored line a reference names, as the frame's scope may read it. */
export type RefLine = {
  placeId: string;
  messageId: string;
  path: Array<string>;
  at: number;
  text: string;
  revision: number;
  deleted: boolean;
  /** The interface's id of the line's conversation, null for a one-to-one chat whose channel the memory does not know. */
  conversationId?: string | null;
  /** The interface's id of the top place above it, null when it has none. */
  communityId?: string | null;
};

/** The labels the references read. */
type RefLabels = Pick<Labels, 'refs' | 'memory' | 'locale'>;

/** Reads a line by its identity without the revision (`src:<iface>:<message id>`); null when unknown or unreadable. */
export type LineOf = (key: string) => RefLine | null;

/**
 * An identity: `src:`, the interface, the message id (which may hold colons) and the revision, with no word character,
 * dot, colon or dash glued after it, so a source id with its kind (`src:x:m:1:seen`) is no reference.
 */
const IDENTITY = /( ?)\bsrc:([\w-]+):((?:[\w.-]+:)*?[\w.-]+):(\d+)(?![\w.:-])/gu;

type Found = { space: string; key: string; revision: number };

/** `text` with each identity replaced by what `render` gives for it. */
function eachIdentity(text: string, render: (found: Found) => string): string {
  if (typeof text !== 'string' || !text.includes('src:')) return text;
  return text.replace(IDENTITY, (_all, space: string, iface: string, messageId: string, revision: string) =>
    render({ space, key: `src:${iface}:${messageId}`, revision: Number(revision) })
  );
}

/** A line quoted under its path and time, noted as edited when it changed since the revision referred to. */
function quoteOf(line: RefLine, revision: number, labels: RefLabels, timezone: string): string {
  const l = labels.refs ?? {};
  const template = line.revision > revision ? l.edited : l.quote;
  return fill(template ?? '"{text}"', {
    path: pathText(line.path, labels.memory?.pathJoin),
    when: pulledMoment(line.at, timezone, labels.locale),
    text: escapeStored(line.text.trim()),
  });
}

/**
 * The renderer of identities in a stored text that comes back into a request. `window` maps the identity of each line
 * of `<chat>` (without the revision) to its `#n`.
 */
export function refResolverOf(given: {
  window: ReadonlyMap<string, number>;
  lineOf: LineOf;
  labels: RefLabels;
  timezone: string;
}): (text: string) => string {
  const { window, lineOf, labels, timezone } = given;
  const unavailable = labels.refs?.unavailable ?? '';
  return (text) =>
    eachIdentity(text, ({ space, key, revision }) => {
      const n = window.get(key);
      if (n !== undefined) return `${space}#${n}`;
      const line = lineOf(key);
      if (line === null || line.deleted) return unavailable ? `${space}${unavailable}` : '';
      return `${space}${quoteOf(line, revision, labels, timezone)}`;
    });
}

/**
 * Her posted words with each identity in the interface's form. A line of `placeId` becomes the reply target (the first
 * such line) and leaves the text; a line elsewhere becomes `linkOf`'s link, or the quote when the interface has no link
 * form; a line the scope cannot read is cut.
 */
export function outgoingRefs(
  text: string,
  given: {
    placeId: string;
    lineOf: LineOf;
    linkOf: (line: RefLine) => string | null;
    labels: RefLabels;
    timezone: string;
  }
): { text: string; replyTo: string | null } {
  const { placeId, lineOf, linkOf, labels, timezone } = given;
  let replyTo: string | null = null;
  const out = eachIdentity(text, ({ space, key, revision }) => {
    const line = lineOf(key);
    if (line === null || line.deleted) return '';
    if (line.placeId === placeId) {
      replyTo ??= line.messageId;
      return '';
    }
    const link = linkOf(line);
    return `${space}${link ?? quoteOf(line, revision, labels, timezone)}`;
  });
  return { text: out === text ? text : out.trim(), replyTo };
}
