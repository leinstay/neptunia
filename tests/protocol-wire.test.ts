// Tests for the wire of the protocol (src/protocol/wire.ts): the JSON-lines codec with bytes as base64, the
// loopback transport and the socket client. Everything goes through the public exports. The socket client
// talks to a plain net server here, so the line reading is checked on the bytes a real peer writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoopback, connectSocket, decodeEnvelope, encodeEnvelope, envelope } from '../src/protocol/index.js';
import * as wire from '../src/protocol/wire.ts';

type Env = ReturnType<typeof envelope>;
type Bodied = { body: { content: { attachments: Array<{ name: string; data: Uint8Array }> } } };

const ping = (id: string): Env => envelope('ping', { at: 1 }, { id });
const sendWith = (bytes: Uint8Array): Env =>
  envelope(
    'action',
    {
      action: 'message.send',
      conversation: { iface: 'test', conversationId: 'c1' },
      content: { text: 'file', attachments: [{ name: 'big.bin', data: bytes }] },
    },
    { id: 'a1' }
  );

const MiB = 1024 * 1024;

// Delivery order is the transport's business; a test waits for what it expects instead of for a tick count.
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function folder(): { dir: string; path: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'w-'));
  return { dir, path: join(dir, 's'), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

test('round-trips a 1 MiB attachment with equal bytes and decodes it as a Buffer', () => {
  const bytes = new Uint8Array(MiB);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) % 251;
  const decoded = decodeEnvelope(encodeEnvelope(sendWith(bytes)));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const data = (decoded.envelope as unknown as Bodied).body.content.attachments[0].data;
  assert.equal(Buffer.isBuffer(data), true);
  assert.equal(Buffer.compare(data as Buffer, Buffer.from(bytes)), 0);
});

test('encodes an envelope as one line', () => {
  const line = encodeEnvelope(sendWith(new Uint8Array([1, 2, 3])));
  assert.equal(line.includes('\n'), false);
});

test('writes a Uint8Array as an object with a base64 $bytes key', () => {
  const line = encodeEnvelope(sendWith(new Uint8Array([104, 105])));
  const parsed = JSON.parse(line) as Bodied;
  assert.deepEqual(parsed.body.content.attachments[0].data, { $bytes: 'aGk=' });
});

test('decodes an empty attachment as an empty Buffer', () => {
  const decoded = decodeEnvelope(encodeEnvelope(sendWith(new Uint8Array(0))));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const data = (decoded.envelope as unknown as Bodied).body.content.attachments[0].data;
  assert.equal(Buffer.isBuffer(data), true);
  assert.equal(data.length, 0);
});

test('refuses a line that is not JSON as invalid', () => {
  assert.deepEqual(decodeEnvelope('this is not json'), { ok: false, reason: 'invalid' });
});

test('refuses an empty line', () => {
  assert.equal(decodeEnvelope('').ok, false);
});

test('refuses JSON that is not an envelope', () => {
  const unknownVersion = JSON.stringify({ v: 99, id: 'x', type: 'ping', replyTo: null, body: {} });
  assert.equal(decodeEnvelope(unknownVersion).ok, false);
  assert.equal(decodeEnvelope('[1,2]').ok, false);
});

test('the protocol index exports the codec, the loopback and the socket client of the wire', () => {
  assert.equal(encodeEnvelope, wire.encodeEnvelope);
  assert.equal(decodeEnvelope, wire.decodeEnvelope);
  assert.equal(createLoopback, wire.createLoopback);
  assert.equal(connectSocket, wire.connectSocket);
});

test('the loopback delivers the core envelope to the client and the client envelope to the core', async () => {
  const { core, client } = createLoopback();
  const atClient: Array<Env> = [];
  const atCore: Array<Env> = [];
  client.onEnvelope((e) => atClient.push(e));
  core.onEnvelope((e) => atCore.push(e));
  core.send(ping('from-core'));
  client.send(ping('from-client'));
  await until(() => atClient.length === 1 && atCore.length === 1);
  assert.equal(atClient[0].id, 'from-core');
  assert.equal(atCore[0].id, 'from-client');
});

test('the loopback carries bytes through the codec, so the other side gets a Buffer', async () => {
  const { core, client } = createLoopback();
  const seen: Array<Env> = [];
  client.onEnvelope((e) => seen.push(e));
  core.send(sendWith(new Uint8Array([7, 8, 9])));
  await until(() => seen.length === 1);
  const data = (seen[0] as unknown as Bodied).body.content.attachments[0].data;
  assert.equal(Buffer.isBuffer(data), true);
  assert.deepEqual([...data], [7, 8, 9]);
});

test('the loopback hands over a copy, so a later change to the sent envelope does not reach the receiver', async () => {
  const { core, client } = createLoopback();
  const seen: Array<Env> = [];
  client.onEnvelope((e) => seen.push(e));
  const sent = ping('p1');
  core.send(sent);
  sent.id = 'changed';
  await until(() => seen.length === 1);
  assert.equal(seen[0].id, 'p1');
});

test('the loopback delivers envelopes in the order they were sent', async () => {
  const { core, client } = createLoopback();
  const seen: Array<string> = [];
  client.onEnvelope((e) => seen.push(e.id));
  for (const id of ['a', 'b', 'c']) core.send(ping(id));
  await until(() => seen.length === 3);
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('the loopback stops delivering to a handler after its unsubscribe', async () => {
  const { core, client } = createLoopback();
  const seen: Array<string> = [];
  const stop = client.onEnvelope((e) => seen.push(e.id));
  core.send(ping('first'));
  await until(() => seen.length === 1);
  stop();
  core.send(ping('second'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['first']);
});

test('closing one end of the loopback tells the other end with a reason', async () => {
  const { core, client } = createLoopback();
  const reasons: Array<string> = [];
  core.onClose((reason) => reasons.push(reason));
  client.close();
  await until(() => reasons.length === 1);
  assert.notEqual(reasons[0], '');
});

test('the loopback delivers nothing after a close and send does not throw', async () => {
  const { core, client } = createLoopback();
  const seen: Array<string> = [];
  const closed: Array<string> = [];
  client.onEnvelope((e) => seen.push(e.id));
  client.onClose((reason) => closed.push(reason));
  core.close();
  await until(() => closed.length === 1);
  assert.doesNotThrow(() => core.send(ping('late')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
});

test('the loopback tells a close handler once even when both ends close', async () => {
  const { core, client } = createLoopback();
  const reasons: Array<string> = [];
  core.onClose((reason) => reasons.push(reason));
  core.close();
  client.close();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reasons.length, 1);
});

test('the socket client decodes two envelopes that arrive in one chunk', async () => {
  const f = folder();
  const server = net.createServer((socket) => {
    socket.write(`${encodeEnvelope(ping('one'))}\n${encodeEnvelope(ping('two'))}\n`);
  });
  await new Promise<void>((resolve) => server.listen(f.path, resolve));
  const client = await connectSocket({ path: f.path, maxFrameBytes: MiB });
  const seen: Array<string> = [];
  client.onEnvelope((e) => seen.push(e.id));
  try {
    await until(() => seen.length === 2);
    assert.deepEqual(seen, ['one', 'two']);
  } finally {
    client.close();
    server.close();
    f.remove();
  }
});

test('the socket client decodes one envelope that arrives in two chunks', async () => {
  const f = folder();
  const line = `${encodeEnvelope(ping('whole'))}\n`;
  const server = net.createServer((socket) => {
    socket.write(line.slice(0, 10));
    setTimeout(() => socket.write(line.slice(10)), 30);
  });
  await new Promise<void>((resolve) => server.listen(f.path, resolve));
  const client = await connectSocket({ path: f.path, maxFrameBytes: MiB });
  const seen: Array<string> = [];
  client.onEnvelope((e) => seen.push(e.id));
  try {
    await until(() => seen.length === 1);
    assert.deepEqual(seen, ['whole']);
  } finally {
    client.close();
    server.close();
    f.remove();
  }
});

test('the socket client decodes a multi-byte character cut between two chunks', async () => {
  const f = folder();
  const text = 'café こんにちは';
  const bytes = Buffer.from(
    `${encodeEnvelope(envelope('action', { action: 'message.send', conversation: { iface: 't', conversationId: 'c' }, content: { text } }, { id: 'u' }))}\n`
  );
  const cut = bytes.indexOf(Buffer.from('こ')) + 1;
  const server = net.createServer((socket) => {
    socket.write(bytes.subarray(0, cut));
    setTimeout(() => socket.write(bytes.subarray(cut)), 30);
  });
  await new Promise<void>((resolve) => server.listen(f.path, resolve));
  const client = await connectSocket({ path: f.path, maxFrameBytes: MiB });
  const seen: Array<Env> = [];
  client.onEnvelope((e) => seen.push(e));
  try {
    await until(() => seen.length === 1);
    assert.equal((seen[0].body as { content: { text: string } }).content.text, text);
  } finally {
    client.close();
    server.close();
    f.remove();
  }
});

test('the socket client skips a line that is not JSON and keeps the link open', async () => {
  const f = folder();
  const server = net.createServer((socket) => {
    socket.write(`not json at all\n${encodeEnvelope(ping('after'))}\n`);
  });
  await new Promise<void>((resolve) => server.listen(f.path, resolve));
  const client = await connectSocket({ path: f.path, maxFrameBytes: MiB });
  const seen: Array<string> = [];
  const closed: Array<string> = [];
  client.onEnvelope((e) => seen.push(e.id));
  client.onClose((reason) => closed.push(reason));
  try {
    await until(() => seen.length === 1);
    assert.deepEqual(seen, ['after']);
    assert.deepEqual(closed, []);
  } finally {
    client.close();
    server.close();
    f.remove();
  }
});

test('the socket client closes with frame-too-large when a line passes its cap', async () => {
  const f = folder();
  const server = net.createServer((socket) => {
    socket.write(`${encodeEnvelope(sendWith(new Uint8Array(5000)))}\n`);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(f.path, resolve));
  const client = await connectSocket({ path: f.path, maxFrameBytes: 1000 });
  const seen: Array<string> = [];
  const closed: Array<string> = [];
  client.onEnvelope((e) => seen.push(e.id));
  client.onClose((reason) => closed.push(reason));
  try {
    await until(() => closed.length === 1);
    assert.equal(closed[0], 'frame-too-large');
    assert.deepEqual(seen, []);
  } finally {
    client.close();
    server.close();
    f.remove();
  }
});

test('the socket client tells its close handler when the peer hangs up', async () => {
  const f = folder();
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(f.path, resolve));
  const client = await connectSocket({ path: f.path, maxFrameBytes: MiB });
  const closed: Array<string> = [];
  client.onClose((reason) => closed.push(reason));
  try {
    await until(() => closed.length === 1);
    assert.notEqual(closed[0], '');
  } finally {
    server.close();
    f.remove();
  }
});

test('connectSocket rejects when nothing listens at the path', async () => {
  const f = folder();
  try {
    await assert.rejects(connectSocket({ path: f.path, maxFrameBytes: MiB }));
  } finally {
    f.remove();
  }
});

test('the socket client sends an envelope as one line that decodes back', async () => {
  const f = folder();
  let received = '';
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
  });
  await new Promise<void>((resolve) => server.listen(f.path, resolve));
  const client = await connectSocket({ path: f.path, maxFrameBytes: MiB });
  try {
    client.send(sendWith(new Uint8Array([1, 2, 3])));
    await until(() => received.endsWith('\n'));
    const lines = received.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 1);
    const decoded = decodeEnvelope(lines[0]);
    assert.equal(decoded.ok, true);
  } finally {
    client.close();
    server.close();
    f.remove();
  }
});
