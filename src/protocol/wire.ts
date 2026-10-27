// The wire of the protocol: how an envelope travels between the core and one interface once they are two
// processes. An envelope is one line of JSON ending in a newline, with every Uint8Array written as
// `{ "$bytes": base64 }` and read back as a Buffer, which is what a platform SDK takes for a file. The codec,
// the line reader, the loopback for tests and the socket client live here and the socket server
// (src/interface/socket.ts) reuses the same reader, so a test over the loopback checks the bytes the
// socket carries. A transport reports its end through `onClose` with a reason: `frame-too-large` when a
// line passes the cap, `closed` when this side closed, `peer-closed` when the other side did, `error` otherwise.
// The decoder checks the frame of an envelope and not its body (envelope.js#validateFrame): an envelope with
// a bad body reaches the receiver, which answers it `invalid` and keeps the link open.

import net from 'node:net';
import type { envelope } from './envelope.js';
import { validateFrame } from './envelope.js';

export type Envelope = ReturnType<typeof envelope>;

export type Transport = {
  send(envelope: Envelope): void;
  onEnvelope(handler: (envelope: Envelope) => void): () => void;
  onClose(handler: (reason: string) => void): () => void;
  close(): void;
};

const NEWLINE = 0x0a;

function toWire(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(toWire);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = toWire(item);
    return out;
  }
  return value;
}

function fromWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromWire);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const only = entries[0];
    if (entries.length === 1 && only !== undefined && only[0] === '$bytes' && typeof only[1] === 'string') {
      return Buffer.from(only[1], 'base64');
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) out[key] = fromWire(item);
    return out;
  }
  return value;
}

// One line, no trailing newline: the transports add it.
export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(toWire(envelope));
}

export function decodeEnvelope(line: string): { ok: true; envelope: Envelope } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const value = fromWire(parsed);
  const checked = validateFrame(value);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return { ok: true, envelope: value as Envelope };
}

// The handler sets and the close notice that every transport shares.
function createHub() {
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
    // Tells the close handlers once, whatever calls it first.
    finish(reason: string): void {
      if (closed) return;
      closed = true;
      for (const handler of [...closeHandlers]) handler(reason);
    },
  };
}

// Two connected ends in one process. Every envelope goes through the codec and arrives on a later
// microtask, in the order it was sent.
export function createLoopback(): { core: Transport; client: Transport } {
  let closed = false;
  const hubs = { core: createHub(), client: createHub() };
  const end = (self: ReturnType<typeof createHub>, other: ReturnType<typeof createHub>): Transport => ({
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

// A transport over a connected socket. Bytes are collected until a newline; a line over `maxFrameBytes`
// (newline excluded), or that many bytes with no newline yet, closes the link with `frame-too-large`.
// A line that is not an envelope is skipped and the link stays open.
export function wrapSocket(socket: net.Socket, maxFrameBytes: number): Transport {
  const hub = createHub();
  let pending: Buffer = Buffer.alloc(0);
  let reason: string | null = null;
  const fail = (why: string): void => {
    reason ??= why;
    socket.destroy();
  };
  socket.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(NEWLINE);
      if (end === -1) {
        if (pending.length > maxFrameBytes) fail('frame-too-large');
        return;
      }
      if (end > maxFrameBytes) {
        fail('frame-too-large');
        return;
      }
      const line = pending.subarray(0, end).toString('utf8');
      pending = pending.subarray(end + 1);
      if (line === '') continue;
      const decoded = decodeEnvelope(line);
      if (decoded.ok) hub.deliver(decoded.envelope);
    }
  });
  socket.on('error', () => {
    reason ??= 'error';
  });
  socket.on('close', () => hub.finish(reason ?? 'peer-closed'));
  return {
    send(envelope) {
      if (socket.destroyed || !socket.writable) return;
      socket.write(`${encodeEnvelope(envelope)}\n`);
    },
    onEnvelope: (handler) => hub.onEnvelope(handler),
    onClose: (handler) => hub.onClose(handler),
    close() {
      reason ??= 'closed';
      socket.end();
    },
  };
}

export function connectSocket(options: { path: string; maxFrameBytes: number }): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options.path);
    const failed = (error: Error): void => reject(error);
    socket.once('error', failed);
    socket.once('connect', () => {
      socket.off('error', failed);
      resolve(wrapSocket(socket, options.maxFrameBytes));
    });
  });
}
