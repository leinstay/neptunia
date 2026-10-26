// Tests for the link over a real Unix socket: the serving side connects with connectSocket, the core listens with
// listenSocket and opens one link per connection. The socket sits in a short folder under TMPDIR because a Unix
// socket path is limited to 108 bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSocket } from '../src/protocol/index.js';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { Hello } from '../src/protocol/serve.ts';
import type { Capabilities } from '../src/protocol/adapter.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import { listenSocket } from '../src/interface/socket.ts';
import { createEventDoor } from '../src/interface/door.js';
import { createFakeAdapter } from '../src/interface/fake.js';

type Log = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};
type Link = ReturnType<typeof openAdapterLink>;

const quiet: Log = { info() {}, warn() {}, error() {} };
const MiB = 1024 * 1024;
const CAPABILITIES: Capabilities = {
  operations: ['message.send'],
  maxChars: 2000,
  maxFiles: 10,
  maxFileBytes: 8 * MiB,
  edit: { ownOnly: true, windowMs: null },
  history: true,
  threads: false,
  reactions: true,
  customEmoji: false,
  presence: false,
  voiceFormats: [],
  publish: [],
  search: false,
};
const HELLO: Hello = {
  iface: 'fake',
  self: { id: 'bot-1', name: 'Νέπτυν' },
  community: { id: 'g1', name: 'Alpha' },
  capabilities: CAPABILITIES,
  resume: null,
};

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'lk-'));
  const path = join(dir, 'c.sock');
  const handled: Array<string> = [];
  const door = createEventDoor({
    handlers: { 'reaction.changed': (event: { id: string }) => void handled.push(event.id) },
    log: quiet,
  });
  const links: Array<Link> = [];
  const server = await listenSocket({
    path,
    maxFrameBytes: 4 * MiB,
    log: quiet,
    onConnection: (transport) => links.push(openAdapterLink({ transport, door, token: 'tok', log: quiet })),
  });
  const transport = await connectSocket({ path, maxFrameBytes: 4 * MiB });
  const fake = createFakeAdapter();
  const served = serveAdapter({ transport, hello: HELLO, token: 'tok', adapter: fake, log: quiet });
  await until(() => links.length === 1);
  const [link] = links;
  if (link === undefined) throw new Error('no link opened');
  await link.hello;
  return {
    dir,
    path,
    handled,
    server,
    served,
    link,
    fake,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('carries one event in and one send out over the socket', async () => {
  const r = await rig();
  try {
    const status = await r.served.emit({
      kind: 'reaction.changed',
      iface: 'fake',
      at: 1,
      id: 'e1',
      conversation: { id: 'c1', kind: 'channel' },
      messageId: 'm1',
      emoji: { name: 'x' },
      userId: 'u1',
      added: true,
    });
    assert.equal(status, 'ok');
    assert.deepEqual(r.handled, ['e1']);
    const delivery = await r.link.adapter.send({ iface: 'fake', conversationId: 'c1' }, { text: 'over the socket' });
    assert.equal(delivery.status, 'ok');
    assert.equal(r.fake.messagesIn('c1')[0]?.text, 'over the socket');
  } finally {
    r.served.close();
    r.link.close();
    await r.server.close();
    r.remove();
  }
});

test('removes the socket file when the server closes', async () => {
  const r = await rig();
  try {
    assert.equal(existsSync(r.path), true);
    r.served.close();
    r.link.close();
    await r.server.close();
    assert.equal(existsSync(r.path), false);
  } finally {
    r.remove();
  }
});
