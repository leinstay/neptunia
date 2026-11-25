// The owner client's link (interfaces/cli/link.ts) over the real protocol: `serveAdapter` on a loopback transport, the far end a
// fake core that answers with `command.result` envelopes. A closed question's choices must survive the crossing and its
// answer must go back once, as a dialog answer and never an argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback } from '../../fixtures/loopback.ts';
import { envelope } from '../../../src/protocol/envelope.ts';
import { openLinkOver, start } from '../../../interfaces/cli/link.ts';
import type { RunningCli } from '../../../interfaces/cli/link.ts';
import type { MessageEvent } from '../../../src/protocol/adapter.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { openAdapterLink } from '../../../src/interface/link.ts';
import type { AdapterLink } from '../../../src/interface/link.ts';
import type { Principal } from '../../../src/interface/principals.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../../src/core.ts';
import { addClient } from '../../../src/setup/clients.ts';
import { createKeyStore } from '../../../src/keys/store.ts';
import { interfaceNamesOf } from '../../../src/memory/db/frame-reads.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { connectSocket } from '../../../src/protocol/wire.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import type { LogEntry } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { start as startFake } from '../../../scripts/lib/fake-interface.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import type { Completion } from '../../fixtures/tool-answers.ts';

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

/** The client over a loopback to the core's link, with the `message.received` events the door took and the persona's line sent. */
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
  const personaRef = sent.ref;
  if (!personaRef) throw new Error("the persona's line has no reference");
  await link.say('owner words');
  const theirs = transcript.at(-1)?.message.id ?? '';
  events.length = 0;
  const idle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
  return { link, coreLink, events, transcript, personaRef, theirs, idle };
}

test("an edit of the persona's own line answers ok and reaches the core as an edit event of that message with the old text", async () => {
  // Bug: the client refuses every edit, so `message.edit` is dropped as unsupported and the core never hears of it.
  const { link, coreLink, events, personaRef, idle } = await editRig();
  assert.ok(coreLink.adapter.capabilities().operations.includes('message.edit'), 'the hello declares the operation');
  const result = await coreLink.adapter.edit(personaRef, { text: 'the kettle is on' });
  assert.equal(result.status, 'ok');
  await idle();
  assert.equal(events.length, 1);
  const [event] = events as Array<MessageEvent>;
  assert.equal(event?.kind, 'message.received');
  assert.equal(event?.iface, 'cli');
  assert.equal(event?.edit, true);
  assert.equal(event?.chat.id, 'cli:dm:owner');
  assert.equal(event?.message.id, personaRef.messageId);
  assert.equal(event?.message.content, 'the kettle is on');
  assert.equal(event?.previous?.content, 'the kettle is on 🙂');
  link.close();
});

test("the client's shown line holds the new text after the edit, as the one line it was", async () => {
  // Bug: the line the chat shows and the history reads answer from keeps the sent text, so the owner reads the
  // words the persona took out.
  const { link, coreLink, transcript, personaRef } = await editRig();
  const before = transcript.length;
  await coreLink.adapter.edit(personaRef, { text: 'the kettle is on' });
  assert.equal(transcript.length, before, 'no second line');
  const line = transcript.find((one) => one.message.id === personaRef.messageId);
  assert.equal(line?.message.content, 'the kettle is on');
  assert.equal(line?.message.sourceText, 'the kettle is on');
  assert.equal((line?.message.editedAt ?? 0) >= (line?.message.at ?? Infinity), true, 'the line is marked as edited');
  const read = await coreLink.adapter.fetchMessages(CHAT, [personaRef.messageId]);
  const fetched = read.status === 'ok' ? read.messages[0] : read;
  assert.equal(fetched && 'text' in fetched ? fetched.text : fetched, 'the kettle is on');
  link.close();
});

test("an edit of the owner's line is refused as not the persona's and nothing is sent or changed", async () => {
  // Bug: the edit takes any line of the chat, so the persona rewrites what the owner said and the core stores it.
  const { link, coreLink, events, transcript, theirs, idle } = await editRig();
  const result = await coreLink.adapter.edit({ ...CHAT, messageId: theirs }, { text: 'changed' });
  assert.equal(result.status, 'forbidden');
  assert.equal(result.error?.code, 'not-own-message');
  await idle();
  assert.deepEqual(events, []);
  assert.equal(transcript.find((one) => one.message.id === theirs)?.message.content, 'owner words');
  link.close();
});

// After a restart of the command line, a `message.edit` by `#141` of a line from the earlier session comes back
// `unknown-message` if the client decides. The client holds only the lines of this session, so it is no
// authority on what the chat holds: the core checked the line and named it, and the core decides.
test('an edit of an id the client never sent answers ok, reports the edit to the core and tells the screen', async () => {
  // Bug: the client refuses a line of an earlier session, so the persona cannot edit what the owner sees above the restart.
  const changes: Array<LineChange> = [];
  const { link, coreLink, events, idle } = await editRig(changes);
  const result = await coreLink.adapter.edit({ ...CHAT, messageId: 'earlier-session-line' }, { text: 'changed' });
  assert.equal(result.status, 'ok');
  await idle();
  assert.equal(events.length, 1, 'the core took one event');
  const [event] = events as Array<MessageEvent>;
  assert.equal(event?.edit, true);
  assert.equal(event?.chat.id, 'cli:dm:owner');
  assert.equal(event?.message.id, 'earlier-session-line');
  assert.equal(event?.message.content, 'changed');
  const author = event?.message.author;
  assert.equal(author?.self, true, 'the persona as the author');
  assert.equal(event?.previous ?? null, null, 'the client holds no earlier copy');
  assert.equal(event?.addressing?.mentioned, false);
  assert.deepEqual(changes, [{ id: 'earlier-session-line', text: 'changed' }]);
  link.close();
});

test("a delete of the persona's own line answers ok, reaches the core as a deletion of that message and leaves the shown lines", async () => {
  // Bug: the client refuses every delete, or answers ok and keeps the line, so the owner still reads what the persona took back.
  const { link, coreLink, events, transcript, personaRef, idle } = await editRig();
  assert.ok(coreLink.adapter.capabilities().operations.includes('message.delete'), 'the hello declares the operation');
  const result = await coreLink.adapter.delete(personaRef);
  assert.equal(result.status, 'ok');
  await idle();
  assert.equal(events.length, 1);
  const [event] = events as Array<MessageEvent>;
  assert.equal(event?.kind, 'message.received');
  assert.equal(event?.iface, 'cli');
  assert.equal(event?.deleted, true);
  assert.equal(event?.chat.id, 'cli:dm:owner');
  assert.equal(event?.message.id, personaRef.messageId);
  assert.equal(
    transcript.some((one) => one.message.id === personaRef.messageId),
    false,
    "no line of the chat is the persona's"
  );
  const read = await coreLink.adapter.fetchMessages(CHAT, [personaRef.messageId]);
  const fetched = read.status === 'ok' ? read.messages[0] : read;
  assert.equal(fetched && 'missing' in fetched ? fetched.missing : fetched, true);
  link.close();
});

test("a delete of the owner's line is refused as not the persona's and nothing is sent or removed", async () => {
  // Bug: the delete takes any line of the chat, so the persona removes what the owner said.
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

// The same case as the edit above, for a deletion.
test('a delete of an id the client never sent answers ok, reports the deletion to the core and tells the screen', async () => {
  // Bug: the client refuses a line of an earlier session, so the persona cannot take back what the owner still reads.
  const changes: Array<LineChange> = [];
  const { link, coreLink, events, idle } = await editRig(changes);
  const result = await coreLink.adapter.delete({ ...CHAT, messageId: 'earlier-session-line' });
  assert.equal(result.status, 'ok');
  await idle();
  assert.equal(events.length, 1, 'the core took one event');
  const [event] = events as Array<MessageEvent>;
  assert.equal(event?.deleted, true);
  assert.equal(event?.chat.id, 'cli:dm:owner');
  assert.equal(event?.message.id, 'earlier-session-line');
  assert.deepEqual(changes, [{ id: 'earlier-session-line', deleted: true }]);
  link.close();
});
test("an edit of the persona's own line tells the screen once, with the line id and the new text", async () => {
  // Bug: the screen is never told, so the owner keeps reading the words the persona took out until the chat is reopened.
  const changes: Array<LineChange> = [];
  const { link, coreLink, personaRef } = await editRig(changes);
  await coreLink.adapter.edit(personaRef, { text: 'the kettle is on' });
  assert.deepEqual(changes, [{ id: personaRef.messageId, text: 'the kettle is on' }]);
  link.close();
});

test("a delete of the persona's own line tells the screen once, with the line id and deleted", async () => {
  // Bug: the screen is never told, so a line the persona took back stays drawn.
  const changes: Array<LineChange> = [];
  const { link, coreLink, personaRef } = await editRig(changes);
  await coreLink.adapter.delete(personaRef);
  assert.deepEqual(changes, [{ id: personaRef.messageId, deleted: true }]);
  link.close();
});

test("a refused edit or delete of the owner's line tells the screen nothing", async () => {
  // Bug: the screen changes a line before the refusal is known, so it shows what the core never stored.
  const changes: Array<LineChange> = [];
  const { link, coreLink, theirs } = await editRig(changes);
  await coreLink.adapter.edit({ ...CHAT, messageId: theirs }, { text: 'changed' });
  await coreLink.adapter.delete({ ...CHAT, messageId: theirs });
  assert.deepEqual(changes, []);
  link.close();
});

// interfaces/cli/link.ts: the lines of a resumed chat answer the core's history reads, in place of this session's.

test("showLines replaces the transcript, keeps native ids and marks the persona's lines as their own", () => {
  // Bug: a branch shows on the screen while the model still gets the lines past the boundary.
  const { client } = createLoopback();
  const transcript: Array<MessageEvent> = [];
  const link = openLinkOver(client, { token: 't', print: null, transcript });
  void link.say('a line of this session');
  link.showLines([
    { id: 's1', at: 10, who: 'owner', text: 'stored', nativeId: 'n1' },
    { id: 's2', at: 20, who: 'her', text: 'reply' },
  ]);
  assert.deepEqual(
    transcript.map(({ message }) => [message.id, message.content, message.author?.self]),
    [
      ['n1', 'stored', false],
      ['s2', 'reply', true],
    ]
  );
  link.close();
});

test('a reply of the persona to a line keeps the line it answers, in the transcript and for the screen', async () => {
  // Bug: the command line printed the persona's reply and dropped `replyTo`, so every later read saw a reply to nothing.
  const { core, client } = createLoopback();
  const door = createEventDoor({ handlers: { 'message.received': () => {} }, log: quiet });
  const owner: Principal = { name: 'owner', kind: 'cli', iface: 'cli', permissions: [] };
  const coreLink: AdapterLink = openAdapterLink({
    transport: core,
    door,
    principalOf: (token) => (token === 't' ? owner : null),
    log: quiet,
  });
  const transcript: Array<MessageEvent> = [];
  const printed: Array<[string, string | null]> = [];
  const link = openLinkOver(client, {
    token: 't',
    print: (text, replyTo = null) => void printed.push([text, replyTo]),
    transcript,
  });
  await coreLink.hello;
  link.showLines([{ id: 's1', at: 10, who: 'owner', text: 'a question', nativeId: 'n1' }]);
  const sent = await coreLink.adapter.send(
    { iface: 'cli', chatId: 'cli:dm:owner' },
    { text: 'the answer', replyTo: { iface: 'cli', chatId: 'cli:dm:owner', messageId: 'n1' } }
  );
  assert.equal(sent.status, 'ok');
  assert.deepEqual(printed, [['the answer', 'n1']]);
  assert.equal(transcript.at(-1)?.message.replyToId, 'n1');
  link.close();
});

test('a resumed line that replied to another keeps the line it answers', () => {
  const { client } = createLoopback();
  const transcript: Array<MessageEvent> = [];
  const link = openLinkOver(client, { token: 't', print: null, transcript });
  link.showLines([
    { id: 's1', at: 10, who: 'owner', text: 'a question', nativeId: 'n1' },
    { id: 's2', at: 20, who: 'her', text: 'the answer', nativeId: 'n2', replyToId: 'n1' },
  ]);
  assert.deepEqual(
    transcript.map(({ message }) => message.replyToId),
    [null, 'n1']
  );
  link.close();
});

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/** What the hello of `interfaces/cli/link.ts` (`CLI_NAMES`) says, as the memory reads it back. */
const EXPECTED = { name: 'CLI', nouns: {}, dm: 'chat' };

type Rig = { dataDir: string; connect: () => ReturnType<typeof connectSocket>; token: string };

async function withCore(body: (rig: Rig) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ch-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: { timezone: 'UTC', owners: [] },
      models: { routes: chainsOf({ video: false }) },
      interfaces: { mode: 'units', drainMs: 500 },
    })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  addClient(dataDir, 'cli', { kind: 'cli', iface: null, permissions: [] });
  try {
    await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [],
        llm: { complete: () => Promise.resolve({ text: '<msg>x</msg>', usage: {}, estimated: 1 }) },
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        await body({
          dataDir,
          connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
          token: readFileSync(join(dataDir, 'clients', 'cli.token'), 'utf8').trim(),
        });
      } finally {
        await core.stop();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The names the memory holds for `cli`, read until `ready` accepts them or five seconds pass (the write is async). */
async function storedNames(dataDir: string, ready: (found: ReturnType<typeof interfaceNamesOf>) => boolean) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
    try {
      const found = interfaceNamesOf(handle.db as Parameters<typeof interfaceNamesOf>[0], 'cli');
      if (ready(found) || Date.now() > deadline) return found;
    } finally {
      handle.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('a command line client connected over the socket has its declared names stored', async () => {
  // Bug: a hello of a principal of kind `cli` went through neither `connectInterface` nor the in-process path, so the
  // row of `cli` kept `name` and `extra` empty and its chat read with the bare kind and the interface id.
  await withCore(async ({ dataDir, connect, token }) => {
    const cli = await start({ connect, token, print: null });
    try {
      const found = await storedNames(dataDir, (one) => one.name !== null);
      assert.deepEqual(found, EXPECTED);
    } finally {
      await cli.stop();
    }
  });
});

const LABELS = JSON.parse(readFileSync(join(REPO, 'config', 'labels.json'), 'utf8')) as {
  model: { transcript: { edited: string } };
};

const { transcript: WORDS } = LABELS.model;

const EDITED = WORDS.edited;

const FIRST = 'the kettle is on 🙂';

const SECOND = 'the kettle is on';

type Row = Record<string, unknown>;

type coreCliMessageEditRig = {
  cli: RunningCli;
  printed: Array<string>;
  requests: Array<string>;
  rows: () => Array<Row>;
  /** Stops the client and connects a fresh one, which holds none of the lines said before. */
  restart: () => Promise<void>;
};

/** One answer of the scripted model, or a function that makes it when asked (it may read what was stored by then). */
type Script = Completion | (() => Completion);

/** The scripted model: `script` answers the persona's requests in order; the address check says yes. */
function scripted(script: ReadonlyArray<Script>, requests: Array<string>) {
  return {
    complete: (messages: unknown, given?: unknown): Promise<Completion> => {
      const purpose = (given as { purpose?: unknown } | undefined)?.purpose;
      if (purpose === 'address') return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      if (purpose === 'lookup' || purpose === 'elsewhere-pick')
        return Promise.resolve({ text: 'none', usage: {}, estimated: 1 });
      requests.push(JSON.stringify(messages));
      const answer = script[requests.length - 1];
      assert.ok(answer, 'the model must not make an unscripted request');
      return Promise.resolve(typeof answer === 'function' ? answer() : answer);
    },
  };
}

async function withCli(
  script: ReadonlyArray<Script>,
  body: (rig: coreCliMessageEditRig) => Promise<void>
): Promise<Array<LogEntry>> {
  const root = mkdtempSync(join(tmpdir(), 'ce-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: {
        timezone: 'UTC',
        owners: [],
        access: {
          'message.edit': { everyone: false, roles: [], users: ['self-id'] },
          'message.delete': { everyone: false, roles: [], users: ['self-id'] },
        },
      },
      models: { routes: chainsOf({ video: false }) },
      interfaces: { mode: 'units', drainMs: 500 },
      pace: { settleMs: 0, settleMaxMs: 0 },
      typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
      tools: { loop: { maxSteps: 5, timeBudgetMs: 20000, maxCallsPerStep: 2 } },
      gifs: { backfillMessages: 0 },
    })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  addClient(dataDir, 'cli', { kind: 'cli', iface: null, permissions: [] });
  const requests: Array<string> = [];
  try {
    const { logs } = await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [{ name: 'fake', start: (host) => startFake(host, { selfId: 'self-id' }) }],
        llm: scripted(script, requests),
        embedder: { embed: () => Promise.resolve([]) },
      });
      const printed: Array<string> = [];
      const open = (): Promise<RunningCli> =>
        start({
          connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
          token: readFileSync(join(dataDir, 'clients', 'cli.token'), 'utf8').trim(),
          print: (text) => void printed.push(text),
        });
      const rig: coreCliMessageEditRig = {
        cli: await open(),
        printed,
        requests,
        restart: async () => {
          await rig.cli.stop();
          rig.cli = await open();
        },
        rows: () => {
          const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
          try {
            // A line's message id is the one its message family holds; `native_id` is the writer's own key.
            const sql = `SELECT s.kind, s.revision, s.text, f.message_id FROM sources s
                JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
                AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
                WHERE s.kind IN ('seen', 'said', 'deleted') ORDER BY s.rowid`;
            return (handle.db as { prepare(sql: string): { all(): Array<Row> } })
              .prepare(sql)
              .all()
              .map((row) => ({ ...row }));
          } finally {
            handle.close();
          }
        },
      };
      try {
        await body(rig);
      } finally {
        await rig.cli.stop();
        await core.stop();
      }
    });
    return logs;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Polls `read` until `ready` accepts it or three seconds pass (the writer flushes asynchronously). */
async function coreCliMessageEditSettled<T>(read: () => T, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = read();
    if (ready(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The stored rows of the line the persona said first, oldest first: `[kind, revision, text]`. */
function historyOf(rows: Array<Row>): Array<[unknown, unknown, unknown]> {
  const said = rows.find((row) => row.kind === 'said');
  return rows.filter((row) => row.message_id === said?.message_id).map((row) => [row.kind, row.revision, row.text]);
}

const calledOk = (logs: Array<LogEntry>, skill: string): boolean =>
  logs.some((entry) => entry.msg === 'skills: called' && entry.skill === skill && entry.status === 'ok');

// Bug: the persona's tool is refused on the command line and the owner's request to drop an emoji changes nothing, or
// the core drops the edit of a chat with no root, so the stored line keeps the old text and the next request shows it.
test("the persona's message.edit of their own line on the command line stores revision 2 beside the old text and the next request shows it edited", async () => {
  let rows: Array<Row> = [];
  let after = '';
  const logs = await withCli(
    [
      toolAnswer(`<msg>${FIRST}</msg>`),
      toolAnswer('', [call('message.edit', { message: '#2', text: SECOND })]),
      toolAnswer('<skip/>'),
      toolAnswer('<msg>fine</msg>'),
    ],
    async (rig) => {
      await rig.cli.turn('hello there');
      await rig.cli.turn('drop the emoji');
      rows = await coreCliMessageEditSettled(rig.rows, (found) => historyOf(found).length >= 2);
      await rig.cli.turn('and now?');
      after = rig.requests[3] ?? '';
    }
  );
  assert.equal(calledOk(logs, 'message.edit'), true, 'the edit answered ok');
  assert.deepEqual(
    historyOf(rows).map(([, revision, text]) => [revision, text]),
    [
      [1, FIRST],
      [2, SECOND],
    ]
  );
  assert.ok(after.includes(`${SECOND} ${EDITED}`), 'the new text carries the edited mark');
  assert.equal(after.includes(FIRST), false, 'the old text is gone from the request');
});

// Bug: the persona's deletion on the command line is refused, or the core drops it, so the stored line stays a line
// and the request keeps showing words the persona took back.
test("the persona's message.delete of their own line on the command line stores it as deleted and the next request no longer holds the line", async () => {
  let rows: Array<Row> = [];
  let after = '';
  const logs = await withCli(
    [
      toolAnswer(`<msg>${FIRST}</msg>`),
      toolAnswer('', [call('message.delete', { message: '#2' })]),
      toolAnswer('<skip/>'),
      toolAnswer('<msg>fine</msg>'),
    ],
    async (rig) => {
      await rig.cli.turn('hello there');
      await rig.cli.turn('take that back');
      rows = await coreCliMessageEditSettled(rig.rows, (found) => found.some((row) => row.kind === 'deleted'));
      await rig.cli.turn('and now?');
      after = rig.requests[3] ?? '';
    }
  );
  assert.equal(calledOk(logs, 'message.delete'), true, 'the deletion answered ok');
  assert.deepEqual(
    historyOf(rows).map(([kind]) => kind),
    ['said', 'deleted']
  );
  assert.equal(after.includes(FIRST), false, "the persona's words left with the window");
  assert.ok(after.includes('#1 ') && after.includes('#3 '), "the lines around the persona's stay under their numbers");
  assert.equal(after.includes('#2 '), false, "the persona's line, #2, is not a line of the window");
});

/** The message id the memory holds for the first stored row of `kind`. */
const idOfFirst = (rows: Array<Row>, kind: string): string => String(rows.find((row) => row.kind === kind)?.message_id);

/**
 * A line of the persona stored in one session of the command line, then a fresh client that holds none of it, and a
 * call of the persona
 * (`call`, by `#N` or by message id) for the line of the earlier session. What the rows and the next request say after.
 */
async function afterRestart(
  call: Script,
  last: string
): Promise<{ rows: Array<Row>; after: string; logs: Array<LogEntry> }> {
  let rows: Array<Row> = [];
  let after = '';
  const logs = await withCli(
    [toolAnswer(`<msg>${FIRST}</msg>`), call, toolAnswer('<skip/>'), toolAnswer('<msg>fine</msg>')],
    async (rig) => {
      await rig.cli.turn('hello there');
      await coreCliMessageEditSettled(rig.rows, (found) => found.some((row) => row.kind === 'said'));
      await rig.restart();
      await rig.cli.turn('change that');
      rows = await coreCliMessageEditSettled(rig.rows, (found) => historyOf(found).length >= 2);
      await rig.cli.turn(last);
      after = rig.requests[3] ?? '';
    }
  );
  return { rows, after, logs };
}

// Bug: after a restart of the command line, an edit of a line from before failed. The client
// knew only the lines sent since it started, so `message.edit` by `#141` came back `unknown-message`, twice.
test("the persona's message.edit of a line said before the client restarted stores revision 2 beside the old text and shows edited", async () => {
  const { rows, after, logs } = await afterRestart(
    toolAnswer('', [call('message.edit', { message: '#2', text: SECOND })]),
    'and now?'
  );
  assert.equal(calledOk(logs, 'message.edit'), true, 'the edit answered ok');
  assert.deepEqual(
    historyOf(rows).map(([, revision, text]) => [revision, text]),
    [
      [1, FIRST],
      [2, SECOND],
    ]
  );
  assert.ok(after.includes(`${SECOND} ${EDITED}`), 'the new text carries the edited mark');
  assert.equal(after.includes(FIRST), false, 'the old text is gone from the request');
});

test("the persona's message.delete of a line said before the client restarted stores it as deleted and the request drops the line", async () => {
  // The same production case as the edit above, for a deletion.
  const { rows, after, logs } = await afterRestart(toolAnswer('', [call('message.delete', { message: '#2' })]), 'now?');
  assert.equal(calledOk(logs, 'message.delete'), true, 'the deletion answered ok');
  assert.deepEqual(
    historyOf(rows).map(([kind]) => kind),
    ['said', 'deleted']
  );
  assert.equal(after.includes(FIRST), false, "the persona's words left with the window");
  assert.equal(after.includes('#2 '), false, "the persona's line, #2, is not a line of the window");
});

/** Whether a call of the persona on the owner's own line was refused as not theirs and the stored lines stayed as they were. */
async function ownerLineRefused(named: (rows: Array<Row>) => string): Promise<[boolean, boolean]> {
  let rows: Array<Row> = [];
  const logs = await withCli(
    [
      toolAnswer(`<msg>${FIRST}</msg>`),
      () => toolAnswer('', [call('message.edit', { message: named(rows), text: 'changed' })]),
      toolAnswer('<skip/>'),
    ],
    async (rig) => {
      await rig.cli.turn('hello there');
      rows = await coreCliMessageEditSettled(rig.rows, (found) => found.some((row) => row.kind === 'said'));
      await rig.restart();
      await rig.cli.turn('change my line');
      await new Promise((resolve) => setTimeout(resolve, 300));
      rows = rig.rows();
    }
  );
  const refused = logs.some(
    (entry) => entry.skill === 'message.edit' && entry.msg === 'skills: called' && entry.code === 'not-own-message'
  );
  return [refused, rows.some((row) => row.text === 'changed')];
}

// The client no longer knows whose a line is, so the core's check is the only one: the owner's line of this chat must
// not be rewritten by the persona, whatever the client answers.
test("an edit of the owner's line by its #N is refused as not the persona's and writes nothing", async () => {
  assert.deepEqual(await ownerLineRefused(() => '#1'), [true, false]);
});

test("an edit of the owner's line by its message id is refused as not the persona's and writes nothing", async () => {
  assert.deepEqual(await ownerLineRefused((rows) => idOfFirst(rows, 'seen')), [true, false]);
});
