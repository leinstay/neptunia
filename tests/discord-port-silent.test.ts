// The Discord port's silent mode (interfaces/discord/port.ts): with the config key `discord.silent` on,
// every send carries the SuppressNotifications flag and never pings the author a reply answers.
// The key is read at each send, so switching it needs no restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createDiscordAdapter } from '../interfaces/discord/port.ts';
import type { Untyped } from '../src/tools/types.ts';

const SILENT = Number(MessageFlags.SuppressNotifications);
const VOICE = Number(MessageFlags.IsVoiceMessage);

function portOver(sent: Untyped, config: () => object) {
  const channel = {
    id: 'c1',
    send: async (payload: Untyped) => {
      sent.push(payload);
      return { id: `m${sent.length}`, createdTimestamp: 1 };
    },
  };
  const client = { user: { id: 'self' }, channels: { cache: new Map([['c1', channel]]) } };
  // The fake client holds only the part of the Discord client that the port reads.
  return createDiscordAdapter({
    client: client as unknown as Parameters<typeof createDiscordAdapter>[0]['client'],
    config,
  });
}

const conversation = { iface: 'discord', conversationId: 'c1' };
const replyTo = { iface: 'discord', conversationId: 'c1', messageId: 'm0' };
const on = () => ({ discord: { silent: true } });
const off = () => ({ discord: { silent: false } });

test('send: silent mode flags a plain message and pings nobody', async () => {
  const sent: Array<Untyped> = [];
  const result = await portOver(sent, on).send(conversation, { text: 'hi' });
  assert.equal(result.status, 'ok');
  assert.equal(sent[0].content, 'hi');
  assert.equal(sent[0].flags, SILENT);
  assert.equal(sent[0].allowedMentions.repliedUser, false);
  assert.deepEqual(sent[0].allowedMentions.parse, []);
});

test('send: silent mode keeps the reply reference and does not ping its author', async () => {
  const sent: Array<Untyped> = [];
  await portOver(sent, on).send(conversation, { text: 'yes', replyTo });
  assert.deepEqual(sent[0].reply, { messageReference: 'm0', failIfNotExists: false });
  assert.equal(sent[0].flags, SILENT);
  assert.equal(sent[0].allowedMentions.repliedUser, false);
});

test('send: silent mode turns a requested reply ping off but keeps the named users', async () => {
  const sent: Array<Untyped> = [];
  await portOver(sent, on).send(conversation, {
    text: 'hey <@42>',
    replyTo,
    mentions: { users: ['42'], repliedUser: true },
  });
  assert.equal(sent[0].flags, SILENT);
  assert.deepEqual(sent[0].allowedMentions.users, ['42']);
  assert.equal(sent[0].allowedMentions.repliedUser, false);
});

test('send: silent mode flags a file message and keeps its text and file', async () => {
  const sent: Array<Untyped> = [];
  await portOver(sent, on).send(conversation, {
    text: 'look',
    attachments: [{ name: 'a.png', data: Buffer.from('x') }],
  });
  assert.equal(sent[0].content, 'look');
  assert.equal(sent[0].flags, SILENT);
  assert.deepEqual(sent[0].files, [{ attachment: Buffer.from('x'), name: 'a.png' }]);
  assert.equal(sent[0].allowedMentions.repliedUser, false);
});

test('send: silent mode adds the silent flag to the voice flag of a voice message', async () => {
  const sent: Array<Untyped> = [];
  await portOver(sent, on).send(conversation, {
    attachments: [
      {
        name: 'voice-1.ogg',
        data: Buffer.from('ogg'),
        voice: { durationSecs: 2, waveform: Buffer.alloc(256, 7).toString('base64') },
      },
    ],
  });
  assert.equal(sent[0].flags, VOICE | SILENT);
  assert.equal(sent[0].content, undefined);
  assert.equal(sent[0].allowedMentions.repliedUser, false);
});

test('send: silent mode flags every part of a text split into several messages', async () => {
  const sent: Array<Untyped> = [];
  await portOver(sent, on).send(conversation, { text: `${'word '.repeat(600)}`.trim() });
  assert.ok(sent.length > 1);
  for (const payload of sent) assert.equal(payload.flags, SILENT);
});

test('send: with the key off the payload is exactly the engine always sent', async () => {
  const sent: Array<Untyped> = [];
  await portOver(sent, off).send(conversation, { text: 'hi', replyTo });
  assert.deepEqual(sent[0], {
    content: 'hi',
    reply: { messageReference: 'm0', failIfNotExists: false },
    allowedMentions: { parse: [] },
  });
});

test('send: with no config the payload has no flags and a requested reply ping stays', async () => {
  const sent: Array<Untyped> = [];
  await portOver(sent, () => ({})).send(conversation, {
    text: 'hi',
    replyTo,
    mentions: { users: [], repliedUser: true },
  });
  assert.equal(sent[0].flags, undefined);
  assert.equal(sent[0].allowedMentions.repliedUser, true);
});

test('send: with the key off a voice message carries only the voice flag', async () => {
  const sent: Array<Untyped> = [];
  await portOver(sent, off).send(conversation, {
    attachments: [{ name: 'v.ogg', data: Buffer.from('o'), voice: { durationSecs: 1, waveform: 'AA==' } }],
  });
  assert.equal(sent[0].flags, VOICE);
});

test('send: switching the key between two sends changes the second only', async () => {
  const sent: Array<Untyped> = [];
  let silent = false;
  const port = portOver(sent, () => ({ discord: { silent } }));
  await port.send(conversation, { text: 'first', replyTo });
  silent = true;
  await port.send(conversation, { text: 'second', replyTo });
  silent = false;
  await port.send(conversation, { text: 'third', replyTo });
  assert.equal(sent[0].flags, undefined);
  assert.equal(sent[1].flags, SILENT);
  assert.equal(sent[1].allowedMentions.repliedUser, false);
  assert.equal(sent[2].flags, undefined);
});
