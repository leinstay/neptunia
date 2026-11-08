// What the core reads of an interface's port without trusting its shape: the namespace it names its ids with and what
// its `capabilities()` declare. The port is the link's adapter in a running core and any object a test hands over, so
// each read answers a default instead of throwing (src/behavior/turn.ts reads the limits of a message and the address
// form of a message here).

import type { MediaPickCapability, MessageUrlTemplate } from '../protocol/adapter.ts';

type Port = { iface?: unknown; capabilities?: unknown };

const capabilitiesOf = (port: unknown): Record<string, unknown> => {
  const declare = (port as Port | null | undefined)?.capabilities;
  if (typeof declare !== 'function') return {};
  const declared: unknown = (declare as () => unknown).call(port);
  return declared !== null && typeof declared === 'object' ? (declared as Record<string, unknown>) : {};
};

/** A port as one interface answers it: the namespace of its ids and what it declares. */
export type PortView = { iface: string; capabilities(): unknown };

/**
 * The port as the interface of `ref` answers it: `port` itself when it routes nothing (no `capabilitiesOf`) or `ref`
 * names its own interface or none, else a view whose `iface` is the reference's and whose capabilities are what the
 * router answers for it (src/interface/link.ts#createIfaceRouter). The reads below then speak of the place's interface.
 */
export function portAt(port: unknown, ref: { iface?: unknown } | null | undefined): unknown {
  const ask = (port as { capabilitiesOf?: unknown } | null | undefined)?.capabilitiesOf;
  const iface = ref?.iface;
  if (typeof ask !== 'function' || typeof iface !== 'string' || iface === '' || iface === portIface(port)) return port;
  const view: PortView = { iface, capabilities: () => (ask as (given: unknown) => unknown).call(port, { iface }) };
  return view;
}

/** False when the port declares it has no custom emoji (`customEmoji: false`), true otherwise. */
export function portCustomEmoji(port: unknown): boolean {
  return capabilitiesOf(port).customEmoji !== false;
}

/** False when the port declares a mention has no form of its own (`mentions: false`), true otherwise. */
export function portMentions(port: unknown): boolean {
  return capabilitiesOf(port).mentions !== false;
}

/** False when the port declares a channel link has no form of its own (`channelLinks: false`), true otherwise. */
export function portChannelLinks(port: unknown): boolean {
  return capabilitiesOf(port).channelLinks !== false;
}

/** The capability names of the operations the port declares (`operations`), empty when it declares none. */
export function portOperations(port: unknown): Array<string> {
  const declared = capabilitiesOf(port).operations;
  return Array.isArray(declared) ? declared.filter((name): name is string => typeof name === 'string') : [];
}

/** The interface a port names its ids with, '' when it names none. */
export function portIface(port: unknown): string {
  const iface = (port as Port | null | undefined)?.iface;
  return typeof iface === 'string' ? iface : '';
}

/** A limit the port declares (`maxChars`, `maxFiles`, `maxFileBytes`) when it is a positive number, else `fallback`. */
export function portLimit(port: unknown, key: 'maxChars' | 'maxFiles' | 'maxFileBytes', fallback: number): number {
  const value = capabilitiesOf(port)[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How the port addresses a message (its `messageUrl` templates), null when it declares no form. */
export function portMessageUrl(port: unknown): MessageUrlTemplate | null {
  const template = capabilitiesOf(port).messageUrl as Partial<MessageUrlTemplate> | null | undefined;
  return typeof template?.root === 'string' && typeof template.direct === 'string'
    ? { root: template.root, direct: template.direct }
    : null;
}

const GIF_FORMS: ReadonlyArray<string> = ['file', 'link'];
const EMOJI_ACTIONS: ReadonlyArray<string> = ['append', 'replace'];

/** The members of `known` that `given` lists. */
function knownOf<T extends string>(given: unknown, known: ReadonlyArray<string>): Array<T> {
  return Array.isArray(given) ? (given.filter((item) => known.includes(item as string)) as Array<T>) : [];
}

/** What a port declares for its emoji forms: at least one action and the still rendering, or nothing. */
function emojiOf(given: unknown): MediaPickCapability['emoji'] {
  if (given === null || typeof given !== 'object') return undefined;
  const { actions, render } = given as { actions?: unknown; render?: unknown };
  const known = knownOf<'append' | 'replace'>(actions, EMOJI_ACTIONS);
  const { still, animated } = (render ?? {}) as { still?: unknown; animated?: unknown };
  if (known.length === 0 || typeof still !== 'string') return undefined;
  return { actions: known, render: { still, ...(typeof animated === 'string' ? { animated } : {}) } };
}

/**
 * What a port declares for the media pick, read without trusting its shape: null when it has no form to use, so the pick
 * never runs for it. An unknown form or action is dropped, and a text that is no string is no text.
 */
export function portMediaPick(port: unknown): MediaPickCapability | null {
  const declared = capabilitiesOf(port).mediaPick;
  if (declared === null || typeof declared !== 'object') return null;
  const { gifForms, emoji, text } = declared as { gifForms?: unknown; emoji?: unknown; text?: unknown };
  const forms = knownOf<'file' | 'link'>(gifForms, GIF_FORMS);
  const emojiForm = emojiOf(emoji);
  if (forms.length === 0 && !emojiForm) return null;
  return {
    gifForms: forms,
    ...(emojiForm ? { emoji: emojiForm } : {}),
    ...(typeof text === 'string' ? { text } : {}),
  };
}
