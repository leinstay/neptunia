// What a message she sends through the Discord port notifies (interfaces/discord/port.ts): nobody. Its
// `allowedMentions` parse nothing, name no member and leave the replied author unpinged, so a mention she writes shows as one and pings no one. No send carries the SuppressNotifications flag, so a
// message still lights the channel up as unread, and a voice message keeps its voice flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createDiscordAdapter } from '../interfaces/discord/port.ts';

const SUPPRESS = Number(MessageFlags.SuppressNotifications);
const VOICE = Number(MessageFlags.IsVoiceMessage);

/** One sent payload's allowed mentions, named so each assertion reads three segments deep at most. */
type Mentions = { parse?: Array<string>; users?: Array<string>; repliedUser?: boolean };
/** A sent payload, with the fields the assertions read. */
type Payload = {
  content?: string;
  flags?: number;
  reply?: unknown;
  files?: Array<unknown>;
  allowedMentions?: Mentions;
};

function portOver(sent: Array<Payload>) {
  const channel = {
    id: 'c1',
    send: (payload: Payload) => {
      sent.push(payload);
      return Promise.resolve({ id: `m${sent.length}`, createdTimestamp: 1 });
    },
  };
  const client = { user: { id: 'self' }, channels: { cache: new Map([['c1', channel]]) } };
  // The fake client holds only the part of the Discord client that the port reads.
  return createDiscordAdapter({
    client: client as unknown as Parameters<typeof createDiscordAdapter>[0]['client'],
  });
}

const chat = { iface: 'discord', chatId: 'c1' };
const replyTo = { iface: 'discord', chatId: 'c1', messageId: 'm0' };
const NOBODY: Mentions = { parse: [], users: [], repliedUser: false };
const flagsOf = (payload: Payload | undefined): number => payload?.flags ?? 0;

test('send: a plain message adds no suppress flag and pings nobody', async () => {
  // Bug: the port marks every message silent, and the channel no longer lights up as unread.
  const sent: Array<Payload> = [];
  const result = await portOver(sent).send(chat, { text: 'hi' });
  assert.equal(result.status, 'ok');
  assert.equal(sent[0]?.content, 'hi');
  assert.equal(flagsOf(sent[0]) & SUPPRESS, 0);
  assert.deepEqual(sent[0]?.allowedMentions, NOBODY);
});

// Changed: the content carries no mentions, so the reply alone is sent; the expectation stays the same.
test('send: a reply keeps its reference and pings nobody', async () => {
  // Bug: the port lets Discord ping the replied author, so the author she answers gets a notification.
  const sent: Array<Payload> = [];
  await portOver(sent).send(chat, { text: 'yes', replyTo });
  assert.deepEqual(sent[0]?.reply, { messageReference: 'm0', failIfNotExists: false });
  assert.deepEqual(sent[0]?.allowedMentions, NOBODY);
});

test('send: a member her text names is not pinged and the mention text stays as written', async () => {
  // Bug: the port lets Discord parse the text, so a member she names gets a notification.
  const sent: Array<Payload> = [];
  await portOver(sent).send(chat, { text: 'hey <@42>' });
  assert.equal(sent[0]?.content, 'hey <@42>');
  assert.deepEqual(sent[0]?.allowedMentions, NOBODY);
});

test('send: a file message adds no flag, keeps its text and file and pings nobody', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent).send(chat, {
    text: 'look <@42>',
    attachments: [{ name: 'a.png', data: Buffer.from('x') }],
  });
  assert.equal(sent[0]?.content, 'look <@42>');
  assert.equal(flagsOf(sent[0]) & SUPPRESS, 0);
  assert.deepEqual(sent[0]?.files, [{ attachment: Buffer.from('x'), name: 'a.png' }]);
  assert.deepEqual(sent[0]?.allowedMentions, NOBODY);
});

test('send: a voice message carries the voice flag alone and pings nobody', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent).send(chat, {
    attachments: [
      {
        name: 'voice-1.ogg',
        data: Buffer.from('ogg'),
        voice: { durationSecs: 2, waveform: Buffer.alloc(256, 7).toString('base64') },
      },
    ],
    replyTo,
  });
  assert.equal(sent[0]?.flags, VOICE);
  assert.equal(sent[0]?.content, undefined);
  assert.deepEqual(sent[0]?.allowedMentions, NOBODY);
});

test('send: every part of a text split into several messages pings nobody and carries no flag', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent).send(chat, { text: `<@42> ${'word '.repeat(600)}`.trim() });
  assert.ok(sent.length > 1);
  for (const payload of sent) {
    assert.equal(flagsOf(payload) & SUPPRESS, 0);
    assert.deepEqual(payload.allowedMentions, NOBODY);
  }
});
