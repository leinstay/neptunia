// The Discord port with `discord.silent` and a member's own ping state (interfaces/discord/port.ts). The turn decides who
// a message concerns and hands the answer in `mentions.asked`: the named members whose state is `on`, and whether the
// replied author's state is `on`. In silent mode the port sends exactly that, never adds the suppress flag (the owner's
// word of 2026-11-06: the switch stops pings and nothing else) and keeps a voice flag. A message with `notify` and no
// `asked` is sent as given, one with neither pings nobody. The key is read at each send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createDiscordAdapter } from '../interfaces/discord/port.ts';
import type { Mentions } from '../src/protocol/index.ts';

// The lead: the first sent payload's mentions get a name, so each assertion reads three segments deep (R.2).
const mentionsOfFirst = <T extends { allowedMentions?: unknown }>(sent: Array<T>) =>
  sent[0]?.allowedMentions as { users?: Array<string>; repliedUser?: boolean } | undefined;

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

const chat = { iface: 'discord', chatId: 'c1' };
const replyTo = { iface: 'discord', chatId: 'c1', messageId: 'm0' };
const silent = () => ({ discord: { silent: true } });
const loud = () => ({ discord: { silent: false } });
// The flag is "set" when the suppress bit is among the flags; a payload with no flags has none.
const suppressed = (payload: Payload | undefined): boolean => ((payload?.flags ?? 0) & SILENT) !== 0;

test('silent mode: a reply to a member with on pings them and carries no suppress flag', async () => {
  // Bug: the switch wins over the member who asked for pings, or the flag is added to the message anyway.
  const sent: Array<Payload> = [];
  const mentions: Mentions = {
    users: [],
    repliedUser: true,
    notify: true,
    asked: { users: [], repliedUser: true },
  };
  await portOver(sent, silent).send(chat, { text: 'yes', replyTo, mentions });
  assert.equal(suppressed(sent[0]), false);
  assert.equal(mentionsOfFirst(sent)?.repliedUser, true);
  assert.deepEqual(sent[0]?.reply, { messageReference: 'm0', failIfNotExists: false });
});

test('silent mode: a named member with on is in the allowed users and the message is not suppressed', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(chat, {
    text: 'hey <@42>',
    mentions: { users: ['42'], repliedUser: false, notify: true, asked: { users: ['42'], repliedUser: false } },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(mentionsOfFirst(sent)?.users, ['42']);
  assert.equal(mentionsOfFirst(sent)?.repliedUser, false, 'a reply ping nobody asked for stays off');
});

test('silent mode: a voice message keeps its voice flag and nothing else', async () => {
  // Bug: the flags are replaced or extended, and a voice message arrives as a file with no waveform.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(chat, {
    attachments: [{ name: 'v.ogg', data: Buffer.from('x'), voice: { durationSecs: 1, waveform: 'AA==' } }],
    mentions: { users: ['42'], repliedUser: false, notify: true, asked: { users: ['42'], repliedUser: false } },
  });
  assert.equal(sent[0]?.flags, VOICE);
});

test('silent mode: a member named without a state is neither pinged nor does the message get the flag', async () => {
  // Bug: any mention at all pings, or the port falls back to the suppress flag for a member who never chose.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(chat, {
    text: 'hey <@42>',
    replyTo,
    mentions: { users: ['42'], repliedUser: true, asked: { users: [], repliedUser: false } },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(mentionsOfFirst(sent)?.users, []);
  assert.equal(mentionsOfFirst(sent)?.repliedUser, false);
});

test('silent mode: a mixed message pings the member with on and not the one with no state', async () => {
  // Bug: a mixed message pings both because one of them said yes, or neither because one of them did not.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(chat, {
    text: 'hi <@42> <@43>',
    replyTo,
    mentions: { users: ['42', '43'], repliedUser: true, asked: { users: ['42'], repliedUser: false } },
  });
  assert.deepEqual(mentionsOfFirst(sent)?.users, ['42']);
  assert.equal(mentionsOfFirst(sent)?.repliedUser, false);
});

test('silent mode: a message with no mentions pings nobody and is not suppressed', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(chat, { text: 'hi' });
  assert.equal(suppressed(sent[0]), false);
  assert.equal(mentionsOfFirst(sent)?.repliedUser, false);
});

test('silent mode: a stray notify with nobody to notify pings nobody', async () => {
  // Bug: a stray notify with no users and no replied author is believed, and an empty ping list is sent as everyone.
  const sent: Array<Payload> = [];
  await portOver(sent, silent).send(chat, {
    text: 'hi',
    mentions: { users: [], repliedUser: false, notify: true },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(mentionsOfFirst(sent)?.users ?? [], []);
  assert.equal(mentionsOfFirst(sent)?.repliedUser, false);
});

test('loud mode: asked is ignored, the mentions go out as given', async () => {
  // Bug: the new field leaks into the default path and alters the payload of every server that is not silent.
  const sent: Array<Payload> = [];
  await portOver(sent, loud).send(chat, {
    text: 'hey <@42> <@43>',
    replyTo,
    mentions: { users: ['42', '43'], repliedUser: true, asked: { users: ['42'], repliedUser: false } },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(sent[0]?.allowedMentions, { parse: [], users: ['42', '43'], repliedUser: true });
});

test('loud mode: notify changes nothing, the mentions go out as given', async () => {
  // Bug: the new field leaks into the default path and alters the payload of every server that is not silent.
  const sent: Array<Payload> = [];
  await portOver(sent, loud).send(chat, {
    text: 'hey <@42>',
    replyTo,
    mentions: { users: ['42'], repliedUser: true, notify: true },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(sent[0]?.allowedMentions, { parse: [], users: ['42'], repliedUser: true });
});
