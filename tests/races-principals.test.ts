// New reproductions, written from the risk the plan describes (forged principals through message fields and reconnect
// order); the original scenarios were not found. An interface client keeps to what its token stands for: it cannot post
// into the owner's command-line chat by naming it in an event, and connecting after another client of the same namespace
// does not take that client's place on the core's adapter. The links run over the loopback, the door over fake handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventDoor } from '../src/interface/door.ts';
import { createLinkSwitch, openAdapterLink } from '../src/interface/link.ts';
import type { Principal } from '../src/interface/principals.ts';
import { createLoopback, envelope } from '../src/protocol/index.ts';
import type { Capabilities } from '../src/protocol/adapter.ts';
import type { Envelope } from '../src/protocol/wire.ts';

const QUIET = { info() {}, warn() {}, error() {} };
const CAPABILITIES: Capabilities = {
  operations: ['message.send'],
  maxChars: 2000,
  maxFiles: 10,
  maxFileBytes: 4096,
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
const FIRST: Principal = { name: 'first', kind: 'interface', iface: 'fake', permissions: [] };
const SECOND: Principal = { name: 'second', kind: 'interface', iface: 'fake', permissions: [] };
const principalOf = (token: string): Principal | null =>
  token === 'first' ? FIRST : token === 'second' ? SECOND : null;

/** A link of the core with its client end; `started` holds the events that reached a handler. */
async function connected(token: string) {
  const started: Array<string> = [];
  const door = createEventDoor({
    handlers: {
      'reaction.changed': (event: { id: string }) => {
        started.push(event.id);
      },
    },
    log: QUIET,
  });
  const { core, client } = createLoopback();
  const link = openAdapterLink({ transport: core, door, principalOf, log: QUIET });
  const received: Array<Envelope> = [];
  const closed: Array<string> = [];
  client.onEnvelope((value) => received.push(value));
  client.onClose((reason) => closed.push(reason));
  client.send(
    envelope(
      'hello',
      {
        iface: 'fake',
        self: { id: 'bot-1', name: 'Nova' },
        root: null,
        capabilities: CAPABILITIES,
        resume: null,
        token,
      },
      { id: `hello:${token}` }
    )
  );
  await link.hello;
  return { link, client, started, received, closed };
}

test('new reproduction: an interface event naming the command-line chat is refused', async () => {
  // Bug: the iface field is checked and the chat is not, so any interface client writes a line into
  // `cli:dm:owner`, the owner's private chat whose history and replies are the command line's.
  const { link, client, started, received } = await connected('first');
  try {
    client.send(
      envelope(
        'event',
        {
          kind: 'reaction.changed',
          iface: 'fake',
          at: 1,
          id: 'forged',
          chat: { id: 'cli:dm:owner', kind: 'dm' },
          messageId: 'm1',
          emoji: { name: 'x' },
          accountId: 'u1',
          added: true,
        },
        { id: 'forged' }
      )
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, []);
    const answer = received.find((value) => value.type === 'ack' && value.replyTo === 'forged');
    assert.equal((answer?.body as { status?: unknown } | undefined)?.status, 'invalid');
  } finally {
    link.close();
  }
});

test('new reproduction: a second client of the same namespace does not take over the adapter', async () => {
  // Bug: `attach` compares nothing, so whichever client connects last receives every send meant for the first one.
  const first = await connected('first');
  const second = await connected('second');
  const routed = createLinkSwitch(first.link);
  try {
    routed.attach(second.link);
    assert.equal(routed.current().principal()?.name, 'first');
    assert.equal(first.link.isClosed(), false, 'the serving client stays connected');
    assert.equal(second.link.isClosed(), true, 'the newcomer is the one refused');
  } finally {
    first.link.close();
    second.link.close();
  }
});

test('new reproduction: the same client reconnecting takes its own place back', async () => {
  // Bug: a fix that refuses every second link leaves an interface that reconnects with no way back on the adapter.
  const first = await connected('first');
  const again = await connected('first');
  const routed = createLinkSwitch(first.link);
  try {
    routed.attach(again.link);
    assert.equal(routed.current(), again.link);
    assert.equal(first.link.isClosed(), true);
    // The reconnect above is today's behaviour; what is new is that it stays true beside the refusal.
    const stranger = await connected('second');
    routed.attach(stranger.link);
    assert.equal(routed.current(), again.link);
    stranger.link.close();
  } finally {
    again.link.close();
  }
});
