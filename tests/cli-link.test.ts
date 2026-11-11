// The owner client's link (interfaces/cli/link.ts) over the real protocol: `serveAdapter` on a loopback transport, the far end a
// fake core that answers with `command.result` envelopes. A closed question's choices must survive the crossing and its
// answer must go back once, as a dialog answer and never an argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback } from '../src/protocol/wire.ts';
import { envelope } from '../src/protocol/envelope.ts';
import { openLinkOver, start } from '../interfaces/cli/link.ts';
import type { MessageEvent } from '../src/protocol/adapter.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import type { AdapterLink } from '../src/interface/link.ts';
import type { Principal } from '../src/interface/principals.ts';

type Body = Record<string, unknown>;

/** `NOTICE_STATUS` of src/protocol/turn-control.ts, written out so the file loads before that export exists. */
const NOTICE_STATUS = 'notice';

/** A core that acknowledges every event and answers each command with what `reply` says. */
function fakeCore(reply: (index: number) => Body) {
  const { core, client } = createLoopback();
  const commands: Array<Body> = [];
  let action = 0;
  core.onEnvelope((value) => {
    if (value.type !== 'event') return;
    core.send(envelope('ack', { status: 'ok' }, { id: `ack:${value.id}`, replyTo: value.id }));
    const body = value.body as Body;
    if (typeof body.replyRef !== 'string') return;
    commands.push(body);
    action += 1;
    core.send(
      envelope(
        'action',
        { action: 'command.result', replyRef: body.replyRef, ...reply(commands.length - 1) },
        { id: `action:${action}` }
      )
    );
  });
  return { client, commands };
}

const askFirst =
  (question: Body) =>
  (index: number): Body =>
    index === 0 ? question : { text: 'it is done', status: 'ok' };

test('a question with choices reaches the owner with them, and the answer goes back once', async () => {
  // Catches: the bridge reading only prompt and secret, so a closed question reaches the screen as free text.
  const { client, commands } = fakeCore(
    askFirst({ text: 'Pick', status: 'ask', dialogId: 'd1', prompt: 'Pick', choices: ['model-a', 'model-b'] })
  );
  const link = openLinkOver(client, { token: 't', print: null });
  const asked: Array<ReadonlyArray<string> | null> = [];
  const answer = await link.ask(
    { name: 'model.set', args: { role: 'dev' } },
    {
      ask: (_prompt, _secret, choices) => {
        asked.push(choices);
        return Promise.resolve('model-b');
      },
    }
  );
  assert.deepEqual(asked, [['model-a', 'model-b']]);
  assert.deepEqual(answer, { text: 'it is done', status: 'ok' });
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.dialogId, 'd1');
  assert.equal(commands[1]?.answer, 'model-b');
  assert.equal(JSON.stringify(commands[1]?.args).includes('model-b'), false);
  link.close();
});

test('an open question has no choices and a secret answer never joins the arguments', async () => {
  // Catches: a masked key value copied into `args`, where a log or a retry could read it.
  const { client, commands } = fakeCore(
    askFirst({ text: 'Key', status: 'ask', dialogId: 'd2', prompt: 'Key', secret: true })
  );
  const link = openLinkOver(client, { token: 't', print: null });
  const asked: Array<[boolean, ReadonlyArray<string> | null]> = [];
  await link.ask(
    { name: 'keys.add', args: { name: 'one' } },
    {
      ask: (_prompt, secret, choices) => {
        asked.push([secret, choices]);
        return Promise.resolve('sk-value');
      },
    }
  );
  assert.deepEqual(asked, [[true, null]]);
  assert.equal(JSON.stringify(commands[1]?.args).includes('sk-value'), false);
  link.close();
});

test('a question with nobody to answer it is refused at once', async () => {
  // Catches: a command hanging forever with no terminal behind the link.
  const { client, commands } = fakeCore(
    askFirst({ text: 'Key', status: 'ask', dialogId: 'd3', prompt: 'Key', secret: true })
  );
  const link = openLinkOver(client, { token: 't', print: null });
  const answer = await link.ask({ name: 'keys.add', args: { name: 'one' } });
  assert.equal(answer.status, 'invalid');
  assert.equal(commands.length, 1);
  link.close();
});

test('a line said as a reply carries the message id of its parent to the core', async () => {
  // Catches: the reply parent dropped on the way, so memory stores the owner's reply as a line that answers nothing.
  const { core, client } = createLoopback();
  const received: Array<Body> = [];
  core.onEnvelope((value) => {
    if (value.type !== 'event') return;
    received.push(value.body as Body);
    core.send(envelope('ack', { status: 'ok' }, { id: `ack:${value.id}`, replyTo: value.id }));
  });
  const link = openLinkOver(client, { token: 't', print: null });
  assert.equal(await link.say('hi', [], 'msg-34'), 'ok');
  assert.equal(await link.say('plain'), 'ok');
  const messages = received.map((body) => body.message as Body);
  assert.deepEqual(
    messages.map((message) => [message.content, message.replyToId]),
    [
      ['hi', 'msg-34'],
      ['plain', null],
    ]
  );
  link.close();
});

const quiet = { info() {}, warn() {}, error() {} };
const OWNER: Principal = { name: 'owner', kind: 'cli', iface: 'cli', permissions: [] };
const CHAT = { iface: 'cli', chatId: 'cli:dm:owner' };

/** The core's end of every link the host opens: each `connect()` is a new loopback with the core's link on it. */
function coreSide() {
  const links: Array<AdapterLink> = [];
  const lines: Array<string> = [];
  const door = createEventDoor({
    handlers: { 'message.received': (event: MessageEvent) => void lines.push(event.message.content ?? '') },
    log: quiet,
  });
  const host = {
    token: 't',
    print: null,
    connect() {
      const { core, client } = createLoopback();
      links.push(
        openAdapterLink({ transport: core, door, principalOf: (token) => (token === 't' ? OWNER : null), log: quiet })
      );
      return Promise.resolve(client);
    },
  };
  return { host, links, lines };
}

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

test('start says hello as cli with the host token over the host connection', async () => {
  // Catches: a package whose start resolves before it connects, or names another interface than its hello.
  const { host, links } = coreSide();
  const running = await start(host);
  running.open();
  const hello = await links[0]?.hello;
  assert.equal(running.iface, 'cli');
  assert.equal(hello?.iface, 'cli');
  await running.stop();
});

test('reconnect opens a new link over the host and keeps the lines the history reads answer from', async () => {
  // Catches: a reconnect that sends on the dead transport, loses this session's lines, or leaves `closed` resolved so
  // the chat's watch sees the new link as lost at once.
  const { host, links, lines } = coreSide();
  const running = await start(host);
  running.open();
  await links[0]?.hello;
  assert.equal(await running.say('before the drop'), 'ok');
  links[0]?.close();
  await running.closed;
  await running.reconnect();
  const second = links[1];
  await second?.hello;
  assert.equal(await settled(running.closed), false, 'the new link is open');
  assert.equal(await running.say('after the drop'), 'ok');
  assert.deepEqual(lines, ['before the drop', 'after the drop']);
  const read = await second?.adapter.history(CHAT, { limit: 10 });
  assert.deepEqual(read?.status === 'ok' ? read.events.map((event) => event.message.content) : read, [
    'before the drop',
    'after the drop',
  ]);
  await running.stop();
});

test('stop closes the link and answers a command still waiting', async () => {
  // Catches: a stop that leaves the socket open, so the process never exits, or a command that waits forever.
  const { core, client } = createLoopback();
  core.onEnvelope((value) => {
    if (value.type === 'event')
      core.send(envelope('ack', { status: 'ok' }, { id: `ack:${value.id}`, replyTo: value.id }));
  });
  const running = await start({ token: 't', print: null, connect: () => Promise.resolve(client) });
  running.open();
  const waiting = running.ask({ name: 'status', args: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await running.stop();
  assert.deepEqual(await waiting, { text: 'The link to the core closed.', status: 'failed' });
  assert.equal(await settled(running.closed), true);
});

test('a notice the core pushes reaches the chat once and never answers a waiting command', async () => {
  // Catches: the owner never told that a root waits, or the notice taken as the answer to the command he ran.
  const { core, client } = createLoopback();
  core.onEnvelope((value) => {
    if (value.type !== 'event') return;
    core.send(envelope('ack', { status: 'ok' }, { id: `ack:${value.id}`, replyTo: value.id }));
    const body = value.body as Body;
    if (typeof body.replyRef !== 'string') return;
    const notice = { action: 'command.result', replyRef: NOTICE_STATUS, status: NOTICE_STATUS, text: 'g8 waits' };
    core.send(envelope('action', notice, { id: 'action:notice-1' }));
    const answer = { action: 'command.result', replyRef: body.replyRef, text: 'it is done', status: 'ok' };
    core.send(envelope('action', answer, { id: 'action:answer-1' }));
  });
  const notices: Array<string> = [];
  const link = openLinkOver(client, { token: 't', print: null, onNotice: (text) => void notices.push(text) });
  const answer = await link.ask({ name: 'status', args: {} });
  assert.deepEqual(answer, { text: 'it is done', status: 'ok' });
  assert.deepEqual(notices, ['g8 waits']);
  link.close();
});
