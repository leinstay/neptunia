// Tests for the socket server of the core (src/interface/socket.ts), against the socket client of the wire
// (src/protocol/wire.ts) and a raw net client where a test needs bytes of its own. The socket sits in a short
// folder under TMPDIR because a Unix socket path is limited to 108 bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSocket, encodeEnvelope, envelope } from '../src/protocol/index.js';
import { listenSocket } from '../src/interface/socket.ts';
import type { Transport } from '../src/protocol/wire.ts';

type Env = ReturnType<typeof envelope>;
type Log = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

const MiB = 1024 * 1024;
const quiet: Log = { info() {}, warn() {}, error() {} };
const ping = (id: string): Env => envelope('ping', { at: 1 }, { id });
const sendWith = (text: string, bytes: Uint8Array = new Uint8Array(0)): Env =>
  envelope(
    'action',
    {
      action: 'message.send',
      conversation: { iface: 'test', conversationId: 'c1' },
      content: { text, attachments: [{ name: 'f.bin', data: bytes }] },
    },
    { id: 'a1' }
  );

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

type Rig = {
  dir: string;
  path: string;
  connections: Array<Transport>;
  server: { close(): Promise<void> };
  remove(): void;
};

async function rig(maxFrameBytes = MiB, nested = false): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'k-'));
  const path = nested ? join(dir, 'run', 's') : join(dir, 's');
  const connections: Array<Transport> = [];
  const server = await listenSocket({ path, maxFrameBytes, log: quiet, onConnection: (t) => connections.push(t) });
  return { dir, path, connections, server, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function raw(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('delivers an envelope from the client to the server and one back', async () => {
  const r = await rig();
  const client = await connectSocket({ path: r.path, maxFrameBytes: MiB });
  const atServer: Array<string> = [];
  const atClient: Array<string> = [];
  client.onEnvelope((e) => atClient.push(e.id));
  try {
    await until(() => r.connections.length === 1);
    r.connections[0].onEnvelope((e) => atServer.push(e.id));
    client.send(ping('up'));
    r.connections[0].send(ping('down'));
    await until(() => atServer.length === 1 && atClient.length === 1);
    assert.deepEqual(atServer, ['up']);
    assert.deepEqual(atClient, ['down']);
  } finally {
    client.close();
    await r.server.close();
    r.remove();
  }
});

test('carries a 1 MiB attachment over the socket with equal bytes as a Buffer', async () => {
  const r = await rig(4 * MiB);
  const client = await connectSocket({ path: r.path, maxFrameBytes: 4 * MiB });
  const bytes = new Uint8Array(MiB);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 17) % 253;
  const seen: Array<Env> = [];
  try {
    await until(() => r.connections.length === 1);
    r.connections[0].onEnvelope((e) => seen.push(e));
    client.send(sendWith('file', bytes));
    await until(() => seen.length === 1);
    const data = (seen[0].body as { content: { attachments: Array<{ data: Uint8Array }> } }).content.attachments[0]
      .data;
    assert.equal(Buffer.isBuffer(data), true);
    assert.equal(Buffer.compare(data as Buffer, Buffer.from(bytes)), 0);
  } finally {
    client.close();
    await r.server.close();
    r.remove();
  }
});

test('closes the connection with frame-too-large when a line passes the cap', async () => {
  const r = await rig(1000);
  const client = await connectSocket({ path: r.path, maxFrameBytes: MiB });
  const clientClosed: Array<string> = [];
  const serverClosed: Array<string> = [];
  const seen: Array<string> = [];
  client.onClose((reason) => clientClosed.push(reason));
  try {
    await until(() => r.connections.length === 1);
    r.connections[0].onClose((reason) => serverClosed.push(reason));
    r.connections[0].onEnvelope((e) => seen.push(e.id));
    client.send(sendWith('x'.repeat(5000)));
    await until(() => serverClosed.length === 1 && clientClosed.length === 1);
    assert.equal(serverClosed[0], 'frame-too-large');
    assert.deepEqual(seen, []);
  } finally {
    client.close();
    await r.server.close();
    r.remove();
  }
});

test('closes with frame-too-large when bytes pass the cap before any newline arrives', async () => {
  const r = await rig(1000);
  const socket = await raw(r.path);
  const serverClosed: Array<string> = [];
  try {
    await until(() => r.connections.length === 1);
    r.connections[0].onClose((reason) => serverClosed.push(reason));
    socket.write('a'.repeat(3000));
    await until(() => serverClosed.length === 1);
    assert.equal(serverClosed[0], 'frame-too-large');
  } finally {
    socket.destroy();
    await r.server.close();
    r.remove();
  }
});

test('accepts a line of exactly the cap', async () => {
  const line = encodeEnvelope(ping('exact'));
  const r = await rig(Buffer.byteLength(line));
  const socket = await raw(r.path);
  const seen: Array<string> = [];
  const closed: Array<string> = [];
  try {
    await until(() => r.connections.length === 1);
    r.connections[0].onEnvelope((e) => seen.push(e.id));
    r.connections[0].onClose((reason) => closed.push(reason));
    socket.write(`${line}\n`);
    await until(() => seen.length === 1);
    assert.deepEqual(closed, []);
  } finally {
    socket.destroy();
    await r.server.close();
    r.remove();
  }
});

test('skips a line that is not JSON and keeps the link open', async () => {
  const r = await rig();
  const socket = await raw(r.path);
  const seen: Array<string> = [];
  const closed: Array<string> = [];
  try {
    await until(() => r.connections.length === 1);
    r.connections[0].onEnvelope((e) => seen.push(e.id));
    r.connections[0].onClose((reason) => closed.push(reason));
    socket.write(`this is not json\n${encodeEnvelope(ping('next'))}\n`);
    await until(() => seen.length === 1);
    assert.deepEqual(seen, ['next']);
    assert.deepEqual(closed, []);
  } finally {
    socket.destroy();
    await r.server.close();
    r.remove();
  }
});

test('decodes two envelopes written in one chunk', async () => {
  const r = await rig();
  const socket = await raw(r.path);
  const seen: Array<string> = [];
  try {
    await until(() => r.connections.length === 1);
    r.connections[0].onEnvelope((e) => seen.push(e.id));
    socket.write(`${encodeEnvelope(ping('one'))}\n${encodeEnvelope(ping('two'))}\n`);
    await until(() => seen.length === 2);
    assert.deepEqual(seen, ['one', 'two']);
  } finally {
    socket.destroy();
    await r.server.close();
    r.remove();
  }
});

test('decodes one envelope written in two chunks', async () => {
  const r = await rig();
  const socket = await raw(r.path);
  const seen: Array<string> = [];
  const line = `${encodeEnvelope(ping('split'))}\n`;
  try {
    await until(() => r.connections.length === 1);
    r.connections[0].onEnvelope((e) => seen.push(e.id));
    socket.write(line.slice(0, 7));
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.write(line.slice(7));
    await until(() => seen.length === 1);
    assert.deepEqual(seen, ['split']);
  } finally {
    socket.destroy();
    await r.server.close();
    r.remove();
  }
});

test('tells the server side when the client closes', async () => {
  const r = await rig();
  const client = await connectSocket({ path: r.path, maxFrameBytes: MiB });
  const closed: Array<string> = [];
  try {
    await until(() => r.connections.length === 1);
    r.connections[0].onClose((reason) => closed.push(reason));
    client.close();
    await until(() => closed.length === 1);
    assert.notEqual(closed[0], '');
  } finally {
    await r.server.close();
    r.remove();
  }
});

test('creates the folder at mode 0700 and the socket at mode 0600', async () => {
  const r = await rig(MiB, true);
  try {
    assert.equal(statSync(join(r.dir, 'run')).mode & 0o777, 0o700);
    assert.equal(statSync(r.path).mode & 0o777, 0o600);
  } finally {
    await r.server.close();
    r.remove();
  }
});

test('replaces a stale file at the path and serves a client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k-'));
  const path = join(dir, 's');
  writeFileSync(path, 'left over from a crash');
  const connections: Array<Transport> = [];
  const server = await listenSocket({ path, maxFrameBytes: MiB, log: quiet, onConnection: (t) => connections.push(t) });
  const client = await connectSocket({ path, maxFrameBytes: MiB });
  try {
    await until(() => connections.length === 1);
    assert.equal(connections.length, 1);
  } finally {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removes the socket file on close', async () => {
  const r = await rig();
  try {
    assert.equal(existsSync(r.path), true);
    await r.server.close();
    assert.equal(existsSync(r.path), false);
  } finally {
    r.remove();
  }
});

test('close resolves while a client is still connected and that client is told', async () => {
  const r = await rig();
  const client = await connectSocket({ path: r.path, maxFrameBytes: MiB });
  const closed: Array<string> = [];
  client.onClose((reason) => closed.push(reason));
  try {
    await until(() => r.connections.length === 1);
    await r.server.close();
    await until(() => closed.length === 1);
    assert.equal(existsSync(r.path), false);
  } finally {
    r.remove();
  }
});
