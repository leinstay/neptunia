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

/** The client over a loopback to the core's link, with the `message.received` events the door took and her line sent. */
type LineChange = { id: string; text?: string; deleted?: true };

async function editRig(changes: Array<LineChange> = []) {
  const { core, client } = createLoopback();
  const events: Array<Record<string, unknown>> = [];
  const door = createEventDoor({
    handlers: { 'message.received': (event: Record<string, unknown>) => void events.push(event) },
    log: quiet,
  });
  const coreLink = openAdapterLink({
    transport: core,
    door,
    principalOf: (token) => (token === 't' ? OWNER : null),
    log: quiet,
  });
  const transcript: Array<MessageEvent> = [];
  const link = openLinkOver(client, {
    token: 't',
    print: () => {},
    transcript,
    onLineChange: (change: LineChange) => void changes.push(change),
  });
  await coreLink.hello;
  const sent = await coreLink.adapter.send(CHAT, { text: 'the kettle is on 🙂' });
  assert.equal(sent.status, 'ok');
  const hers = sent.ref;
  if (!hers) throw new Error('her line has no reference');
  await link.say('owner words');
  const theirs = transcript.at(-1)?.message.id ?? '';
  events.length = 0;
  const idle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
  return { link, coreLink, events, transcript, hers, theirs, idle };
}

test('her edit of her own line answers ok and reaches the core as an edit event of that message with the old text', async () => {
  // Bug: the client refuses every edit, so `message.edit` is dropped as unsupported and the core never hears of it.
  const { link, coreLink, events, hers, idle } = await editRig();
  assert.ok(coreLink.adapter.capabilities().operations.includes('message.edit'), 'the hello declares the operation');
  const result = await coreLink.adapter.edit(hers, { text: 'the kettle is on' });
  assert.equal(result.status, 'ok');
  await idle();
  assert.equal(events.length, 1);
  const [event] = events as Array<MessageEvent>;
  assert.equal(event?.kind, 'message.received');
  assert.equal(event?.iface, 'cli');
  assert.equal(event?.edit, true);
  assert.equal(event?.chat.id, 'cli:dm:owner');
  assert.equal(event?.message.id, hers.messageId);
  assert.equal(event?.message.content, 'the kettle is on');
  assert.equal(event?.previous?.content, 'the kettle is on 🙂');
  link.close();
});

test("the client's shown line holds the new text after the edit, as the one line it was", async () => {
  // Bug: the line the chat shows and the history reads answer from keeps the sent text, so the owner reads the
  // words she took out.
  const { link, coreLink, transcript, hers } = await editRig();
  const before = transcript.length;
  await coreLink.adapter.edit(hers, { text: 'the kettle is on' });
  assert.equal(transcript.length, before, 'no second line');
  const line = transcript.find((one) => one.message.id === hers.messageId);
  assert.equal(line?.message.content, 'the kettle is on');
  assert.equal(line?.message.sourceText, 'the kettle is on');
  assert.equal((line?.message.editedAt ?? 0) >= (line?.message.at ?? Infinity), true, 'the line is marked as edited');
  const read = await coreLink.adapter.fetchMessages(CHAT, [hers.messageId]);
  const fetched = read.status === 'ok' ? read.messages[0] : read;
  assert.equal(fetched && 'text' in fetched ? fetched.text : fetched, 'the kettle is on');
  link.close();
});

test("an edit of the owner's line is refused as not hers and nothing is sent or changed", async () => {
  // Bug: the edit takes any line of the chat, so she rewrites what the owner said and the core stores it.
  const { link, coreLink, events, transcript, theirs, idle } = await editRig();
  const result = await coreLink.adapter.edit({ ...CHAT, messageId: theirs }, { text: 'changed' });
  assert.equal(result.status, 'forbidden');
  assert.equal(result.error?.code, 'not-own-message');
  await idle();
  assert.deepEqual(events, []);
  assert.equal(transcript.find((one) => one.message.id === theirs)?.message.content, 'owner words');
  link.close();
});

test('an edit of a line the chat does not hold is refused as unknown and nothing is sent', async () => {
  // Bug: the client answers ok for any id, so the core is told of an edit of a line that never existed.
  const { link, coreLink, events, idle } = await editRig();
  const result = await coreLink.adapter.edit({ ...CHAT, messageId: 'no-such-line' }, { text: 'changed' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'unknown-message');
  await idle();
  assert.deepEqual(events, []);
  link.close();
});

test('her delete of her own line answers ok, reaches the core as a deletion of that message and leaves the shown lines', async () => {
  // Bug: the client refuses every delete, or answers ok and keeps the line, so the owner still reads what she took back.
  const { link, coreLink, events, transcript, hers, idle } = await editRig();
  assert.ok(coreLink.adapter.capabilities().operations.includes('message.delete'), 'the hello declares the operation');
  const result = await coreLink.adapter.delete(hers);
  assert.equal(result.status, 'ok');
  await idle();
  assert.equal(events.length, 1);
  const [event] = events as Array<MessageEvent>;
  assert.equal(event?.kind, 'message.received');
  assert.equal(event?.iface, 'cli');
  assert.equal(event?.deleted, true);
  assert.equal(event?.chat.id, 'cli:dm:owner');
  assert.equal(event?.message.id, hers.messageId);
  assert.equal(
    transcript.some((one) => one.message.id === hers.messageId),
    false,
    'no line of the chat is hers any more'
  );
  const read = await coreLink.adapter.fetchMessages(CHAT, [hers.messageId]);
  const fetched = read.status === 'ok' ? read.messages[0] : read;
  assert.equal(fetched && 'missing' in fetched ? fetched.missing : fetched, true);
  link.close();
});

test("a delete of the owner's line is refused as not hers and nothing is sent or removed", async () => {
  // Bug: the delete takes any line of the chat, so she removes what the owner said.
  const { link, coreLink, events, transcript, theirs, idle } = await editRig();
  const result = await coreLink.adapter.delete({ ...CHAT, messageId: theirs });
  assert.equal(result.status, 'forbidden');
  assert.equal(result.error?.code, 'not-own-message');
  await idle();
  assert.deepEqual(events, []);
  assert.equal(
    transcript.some((one) => one.message.id === theirs),
    true
  );
  link.close();
});

test('a delete of a line the chat does not hold is refused as unknown and nothing is sent', async () => {
  // Bug: the client answers ok for any id, so the core records the deletion of a line it never stored.
  const { link, coreLink, events, idle } = await editRig();
  const result = await coreLink.adapter.delete({ ...CHAT, messageId: 'no-such-line' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'unknown-message');
  await idle();
  assert.deepEqual(events, []);
  link.close();
});

test('her edit of her own line tells the screen once, with the line id and the new text', async () => {
  // Bug: the screen is never told, so the owner keeps reading the words she took out until the chat is reopened.
  const changes: Array<LineChange> = [];
  const { link, coreLink, hers } = await editRig(changes);
  await coreLink.adapter.edit(hers, { text: 'the kettle is on' });
  assert.deepEqual(changes, [{ id: hers.messageId, text: 'the kettle is on' }]);
  link.close();
});

test('her delete of her own line tells the screen once, with the line id and deleted', async () => {
  // Bug: the screen is never told, so a line she took back stays drawn.
  const changes: Array<LineChange> = [];
  const { link, coreLink, hers } = await editRig(changes);
  await coreLink.adapter.delete(hers);
  assert.deepEqual(changes, [{ id: hers.messageId, deleted: true }]);
  link.close();
});

test('a refused edit or delete tells the screen nothing', async () => {
  // Bug: the screen changes a line before the refusal is known, so it shows what the core never stored.
  const changes: Array<LineChange> = [];
  const { link, coreLink, theirs } = await editRig(changes);
  await coreLink.adapter.edit({ ...CHAT, messageId: theirs }, { text: 'changed' });
  await coreLink.adapter.delete({ ...CHAT, messageId: theirs });
  await coreLink.adapter.edit({ ...CHAT, messageId: 'no-such-line' }, { text: 'changed' });
  await coreLink.adapter.delete({ ...CHAT, messageId: 'no-such-line' });
  assert.deepEqual(changes, []);
  link.close();
});
