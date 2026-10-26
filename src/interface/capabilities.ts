// What the core reads of an interface's port without trusting its shape: the namespace it names its ids with and what
// its `capabilities()` declare. The port is the link's adapter in a running core and any object a test hands over, so
// each read answers a default instead of throwing (src/behavior/turn.js reads the limits of a message and the address
// form of a message here).

import type { MessageUrlTemplate } from '../protocol/adapter.ts';

type Port = { iface?: unknown; capabilities?: unknown };

const capabilitiesOf = (port: unknown): Record<string, unknown> => {
  const declare = (port as Port | null | undefined)?.capabilities;
  if (typeof declare !== 'function') return {};
  const declared: unknown = (declare as () => unknown).call(port);
  return declared !== null && typeof declared === 'object' ? (declared as Record<string, unknown>) : {};
};

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
  return typeof template?.community === 'string' && typeof template.direct === 'string'
    ? { community: template.community, direct: template.direct }
    : null;
}
