// Two connected protocol transports in one process, for tests of a link without a socket. Every envelope goes through
// the wire's codec (src/protocol/wire.ts) and arrives on a later microtask, in the order it was sent, so a test over
// the loopback checks the bytes the socket carries. Closing either end tells this end `closed` and the other
// `peer-closed`, once each.

import { decodeEnvelope, encodeEnvelope } from '../../src/protocol/wire.ts';
import type { Envelope, Transport } from '../../src/protocol/wire.ts';

/** The handler sets of one end and its close notice, told once. */
function hub() {
  const envelopeHandlers = new Set<(envelope: Envelope) => void>();
  const closeHandlers = new Set<(reason: string) => void>();
  let closed = false;
  return {
    onEnvelope(handler: (envelope: Envelope) => void): () => void {
      envelopeHandlers.add(handler);
      return () => envelopeHandlers.delete(handler);
    },
    onClose(handler: (reason: string) => void): () => void {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    deliver(envelope: Envelope): void {
      for (const handler of [...envelopeHandlers]) handler(envelope);
    },
    finish(reason: string): void {
      if (closed) return;
      closed = true;
      for (const handler of [...closeHandlers]) handler(reason);
    },
  };
}

export function createLoopback(): { core: Transport; client: Transport } {
  let closed = false;
  const hubs = { core: hub(), client: hub() };
  const end = (self: ReturnType<typeof hub>, other: ReturnType<typeof hub>): Transport => ({
    send(envelope) {
      if (closed) return;
      const line = encodeEnvelope(envelope);
      queueMicrotask(() => {
        const decoded = decodeEnvelope(line);
        if (decoded.ok) other.deliver(decoded.envelope);
      });
    },
    onEnvelope: (handler) => self.onEnvelope(handler),
    onClose: (handler) => self.onClose(handler),
    close() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        self.finish('closed');
        other.finish('peer-closed');
      });
    },
  });
  return { core: end(hubs.core, hubs.client), client: end(hubs.client, hubs.core) };
}
