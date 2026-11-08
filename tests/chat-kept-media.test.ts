// src/chat/kept-media.ts: the files of the owner's command line chat kept in the persona's data folder, both ways. A
// line the owner sends passes the door with each staged file copied and named by its kept reference; a file she sends to
// the chat is kept before the chat client gets it, and her line comes back to the core as an echo carrying it, as a
// platform echoes a message she posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepLineFiles, withKeptSends } from '../src/chat/kept-media.ts';
import { keptLocation } from '../src/media/kept-files.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import type { LinkDoor } from '../src/interface/link.ts';
import type { Envelope } from '../src/protocol/wire.ts';
import type { MessageEvent } from '../src/protocol/adapter.ts';

type Context = { after: (fn: () => void) => void };

const PLACE = 'cli:dm:owner';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const OGG = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 5, 5]);

function dataDir(t: Context): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-kept-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The owner's line as the chat client sends it, in its envelope. */
function lineEnvelope(iface: string, attachments: Array<Record<string, unknown>>): Envelope {
  return {
    v: 1,
    id: 'env-1',
    type: 'event',
    replyTo: null,
    body: {
      kind: 'message.received',
      iface,
      at: 10,
      id: `${iface}:message:m1`,
      chat: { id: `${iface}:dm:owner`, kind: 'dm', rootId: null, name: 'owner', partnerId: 'owner' },
      message: {
        id: 'm1',
        author: { id: 'owner', name: 'owner', self: false, bot: false },
        content: 'look',
        at: 10,
        replyToId: null,
        replyPingAccountId: null,
        forwardedFrom: null,
        attachments,
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions: [],
      },
      addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
    },
  };
}

/** A door that keeps what passed it. */
function recordingDoor(): LinkDoor & { passed: Array<unknown> } {
  const passed: Array<unknown> = [];
  return {
    passed,
    receive(value: unknown) {
      passed.push(value);
      return Promise.resolve({ v: 1, id: 'ack', type: 'ack', replyTo: 'env-1', body: { status: 'ok' } });
    },
  };
}

const attachmentsOf = (value: unknown): Array<Record<string, unknown>> =>
  (value as { body: { message: { attachments: Array<Record<string, unknown>> } } }).body.message.attachments;

const staged = { id: 'st1', kind: 'image', url: 'neptunia-staged:///st1', name: 'kite.png', contentType: 'image/png' };

test('an image the owner attached is copied into the data folder and the line names the copy', async (t) => {
  // Bug: the line keeps only the staging reference, and a week later the picture is gone from her memory.
  const dir = dataDir(t);
  const door = recordingDoor();
  const wrapped = keepLineFiles(door, {
    dataDir: dir,
    readStaged: (id) => Promise.resolve(id === 'st1' ? PNG : null),
  });
  await wrapped.receive(lineEnvelope('cli', [staged]));
  const [attachment] = attachmentsOf(door.passed[0]);
  assert.equal(attachment?.id, 'st1');
  const file = path.join(dir, 'media', 'cli', 'st1.png');
  assert.equal(keptLocation(dir, String(attachment?.url)), file);
  assert.deepEqual(new Uint8Array(fs.readFileSync(file)), PNG);
});

test('a staged file that is already gone leaves the line as the client sent it', async (t) => {
  // Bug: a line whose staged file vanished is dropped instead of reaching the turn.
  const door = recordingDoor();
  const wrapped = keepLineFiles(door, { dataDir: dataDir(t), readStaged: () => Promise.resolve(null) });
  await wrapped.receive(lineEnvelope('cli', [staged]));
  assert.equal(attachmentsOf(door.passed[0])[0]?.url, 'neptunia-staged:///st1');
});

test('a line of another interface passes untouched', async (t) => {
  // Bug: a platform's attachment is read as a staged file of the command line.
  const door = recordingDoor();
  const wrapped = keepLineFiles(door, { dataDir: dataDir(t), readStaged: () => Promise.resolve(PNG) });
  await wrapped.receive(lineEnvelope('discord', [staged]));
  assert.equal(attachmentsOf(door.passed[0])[0]?.url, 'neptunia-staged:///st1');
});

function chatClient() {
  return createFakeAdapter({ iface: 'cli', messageId: (_chat, count) => `her-${count}` });
}

test('a voice note she sends to the command line is kept and her line comes back carrying it', async (t) => {
  // Bug: a file she sends to the command line chat never reaches her memory, so a later turn does not know she sent it.
  const dir = dataDir(t);
  const client = chatClient();
  const echoes: Array<MessageEvent> = [];
  let next = 0;
  const adapter = withKeptSends(client, {
    dataDir: dir,
    newId: () => `f${(next += 1)}`,
    echo: (event) => void echoes.push(event),
  });
  const delivery = await adapter.send(
    { iface: 'cli', chatId: PLACE },
    { text: 'listen', attachments: [{ name: 'voice.ogg', data: OGG, voice: { durationSecs: 2, waveform: '' } }] }
  );
  assert.equal(delivery.status, 'ok');
  assert.equal(echoes.length, 1);
  const message = echoes[0]?.message;
  assert.equal(message?.id, delivery.ref?.messageId);
  assert.equal(message?.author?.self, true);
  assert.equal(message?.content, 'listen');
  const attachment = message?.attachments?.[0] as Record<string, unknown> | undefined;
  assert.equal(attachment?.kind, 'voice');
  const file = path.join(dir, 'media', 'cli', 'f1.ogg');
  assert.equal(keptLocation(dir, String(attachment?.url)), file);
  assert.deepEqual(new Uint8Array(fs.readFileSync(file)), OGG);
});

test('the chat client gets her file with the kept reference beside its bytes', async (t) => {
  // Bug: the owner's terminal cannot show a voice note and has no path to open it with.
  const dir = dataDir(t);
  const client = chatClient();
  const adapter = withKeptSends(client, { dataDir: dir, newId: () => 'f1', echo: () => {} });
  await adapter.send({ iface: 'cli', chatId: PLACE }, { attachments: [{ name: 'notes.pdf', data: OGG }] });
  const sent = client.calls.find((call) => call.op === 'send')?.args[1] as {
    attachments: Array<{ url?: string; data?: Uint8Array }>;
  };
  const given = sent.attachments[0];
  assert.deepEqual(given?.data, OGG);
  assert.equal(keptLocation(dir, String(given?.url)), path.join(dir, 'media', 'cli', 'f1.pdf'));
});

test('a send the chat client refused keeps no file and echoes nothing', async (t) => {
  // Bug: a file she never delivered shows in her memory as sent.
  const dir = dataDir(t);
  const client = chatClient();
  client.failNext('send', { status: 'failed', error: { code: 'unsupported', retryable: false } });
  const echoes: Array<MessageEvent> = [];
  const adapter = withKeptSends(client, { dataDir: dir, newId: () => 'f1', echo: (event) => void echoes.push(event) });
  await adapter.send({ iface: 'cli', chatId: PLACE }, { attachments: [{ name: 'kite.png', data: PNG }] });
  assert.equal(echoes.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'media', 'cli', 'f1.png')), false);
});

test('a send with no file goes to the chat client unchanged and echoes nothing', async (t) => {
  // Bug: her plain reply is stored twice.
  const client = chatClient();
  const echoes: Array<MessageEvent> = [];
  const adapter = withKeptSends(client, {
    dataDir: dataDir(t),
    newId: () => 'f1',
    echo: (event) => void echoes.push(event),
  });
  const delivery = await adapter.send({ iface: 'cli', chatId: PLACE }, { text: 'plain' });
  assert.equal(delivery.status, 'ok');
  assert.equal(echoes.length, 0);
});
