// The Discord port with `discord.silent` and a member's own ping state (interfaces/discord/port.ts). The turn decides who
// a message concerns and hands the answer in `mentions.notify`: true when the message concerns at least one member and
// every one of them has the state `on`. The port drops the suppress flag of silent mode only for such a message, keeps
// a voice flag, and gives the reply ping back when the mentions ask for it. A message without `notify` follows the switch.
// The key is read at each send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createDiscordAdapter } from '../interfaces/discord/port.ts';
import type { Mentions } from '../src/protocol/index.ts';

const SILENT = Number(MessageFlags.SuppressNotifications);
const VOICE = Number(MessageFlags.IsVoiceMessage);

type Payload = {
  content?: string;
  flags?: number;
  reply?: unknown;
  allowedMentions?: { parse?: Array<string>; users?: Array<string>; repliedUser?: boolean };
};

function portOver(sent: Array<Payload>, config: () => object) {
  const channel = {
    id: 'c1',
    send: (payload: Payload) => {
      sent.push(payload);
      return Promise.resolve({ id: `m${sent.length}`, createdTimestamp: 1 });
    },
  };
  const client = { user: { id: 'self' }, channels: { cache: new Map([['c1', channel]]) } };
  return createDiscordAdapter({
    client: client as unknown as Parameters<typeof createDiscordAdapter>[0]['client'],
    config,
  });
}

const conversation = { iface: 'discord', conversationId: 'c1' };
const replyTo = { iface: 'discord', conversationId: 'c1', messageId: 'm0' };
const silent = () => ({ discord: { silent: true } });
const loud = () => ({ discord: { silent: false } });
// The flag is "set" when the suppress bit is among the flags; a payload with no flags has none.
const suppressed = (payload: Payload | undefined): boolean => ((payload?.flags ?? 0) & SILENT) !== 0;

test('silent mode with notify: a reply to a member with on carries no suppress flag and pings them', async () => {
  // Bug: the switch wins over the member who asked for pings, and they get a silent message.
  const sent: Array<Payload> = [];
  const mentions: Mentions = { users: [], repliedUser: true, notify: true };
  await portOver(sent, silent).send(conversation, { text: 'yes', replyTo, mentions });
  assert.equal(suppressed(sent[0]), false);
  assert.equal(sent[0]?.allowedMentions?.repliedUser, true);
  assert.deepEqual(sent[0]?.reply, { messageReference: 'm0', failIfNotExists: false });
});

test('silent mode with notify: a named member with on is in the allowed users and the message is not suppressed', async () => {
  // Bug: the flag is dropped but the user is not allowed, or the user is allowed but the flag stays.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(conversation, {
    text: 'hey <@42>',
    mentions: { users: ['42'], repliedUser: false, notify: true },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(sent[0]?.allowedMentions?.users, ['42']);
  assert.equal(sent[0]?.allowedMentions?.repliedUser, false, 'a reply ping nobody asked for stays off');
});

test('silent mode with notify: the voice flag of a voice message stays when the suppress flag goes', async () => {
  // Bug: the flags are replaced instead of cleared bit by bit, and a voice message arrives as a file with no waveform.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(conversation, {
    attachments: [{ name: 'v.ogg', data: Buffer.from('x'), voice: { durationSecs: 1, waveform: 'AA==' } }],
    mentions: { users: ['42'], repliedUser: false, notify: true },
  });
  assert.equal(sent[0]?.flags, VOICE);
});

test('silent mode without notify: a message with named members is suppressed and its reply ping stays off', async () => {
  // Bug: any mention at all drops the flag, and a message to a member who never chose still notifies.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(conversation, {
    text: 'hey <@42>',
    replyTo,
    mentions: { users: ['42'], repliedUser: true },
  });
  assert.equal(suppressed(sent[0]), true);
  assert.deepEqual(sent[0]?.allowedMentions?.users, ['42']);
  assert.equal(sent[0]?.allowedMentions?.repliedUser, false);
});

test('silent mode with notify false: the message stays suppressed', async () => {
  // Bug: the port reads the key as present rather than true, and a mixed message (one member on, one unset) notifies.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(conversation, {
    text: 'hi',
    replyTo,
    mentions: { users: ['42'], repliedUser: true, notify: false },
  });
  assert.equal(suppressed(sent[0]), true);
  assert.equal(sent[0]?.allowedMentions?.repliedUser, false);
});

test('silent mode: a message with no mentions at all stays suppressed', async () => {
  // Bug: "every concerned member is on" is true of nobody, and every plain message in a silent server pings.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(conversation, { text: 'hi' });
  assert.equal(suppressed(sent[0]), true);
});

test('silent mode: notify on a message with no replied author and no named member does not drop the flag', async () => {
  // Bug: a stray notify with nobody to notify is believed, and the message goes out loud to the channel.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(conversation, {
    text: 'hi',
    mentions: { users: [], repliedUser: false, notify: true },
  });
  assert.equal(suppressed(sent[0]), true);
});

test('loud mode: notify changes nothing, the mentions go out as given', async () => {
  // Bug: the new field leaks into the default path and alters the payload of every server that is not silent.
  const sent: Array<Payload> = [];
  await portOver(sent, loud).send(conversation, {
    text: 'hey <@42>',
    replyTo,
    mentions: { users: ['42'], repliedUser: true, notify: true },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(sent[0]?.allowedMentions, { parse: [], users: ['42'], repliedUser: true });
});
