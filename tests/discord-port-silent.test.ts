// The Discord port's silent mode (interfaces/discord/port.ts): with the config key `discord.silent` on,
// no send carries the SuppressNotifications flag, and a ping goes only to the members whose own state is `on`.
// The key is read at each send, so switching it needs no restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createDiscordAdapter } from '../interfaces/discord/port.ts';

const SILENT = Number(MessageFlags.SuppressNotifications);
const VOICE = Number(MessageFlags.IsVoiceMessage);

function portOver(sent: Array<Payload>, config: () => object) {
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
    config,
  });
}

const chat = { iface: 'discord', chatId: 'c1' };
const replyTo = { iface: 'discord', chatId: 'c1', messageId: 'm0' };
const on = () => ({ discord: { silent: true } });
const off = () => ({ discord: { silent: false } });
// The lead: one sent payload's mentions get a name, so each assertion reads three segments deep at most (R.2).
type Mentions = { parse?: Array<string>; users?: Array<string>; repliedUser?: boolean };
// The lead: a sent payload has a type, so the assertions read named fields and the lint has no `any` to refuse.
type Payload = {
  content?: string;
  flags?: number;
  reply?: unknown;
  files?: Array<unknown>;
  allowedMentions?: Mentions;
};
const mentionsOf = (payload: Payload | undefined): Mentions => payload?.allowedMentions ?? {};

// Owner's word of 2026-11-06: the switch stops pings and never adds the suppress flag, so a message still lights the
// channel up as unread. The port sends `mentions.asked` (the members whose own state is `on`) when the content carries
// it, and a stored mirror send with only `notify` goes as given.
const flagsOf = (payload: Payload | undefined): number => payload?.flags ?? 0;
const usersOf = (payload: Payload | undefined): Array<string> => mentionsOf(payload).users ?? [];

test('send: silent mode adds no suppress flag to a plain message and pings nobody', async () => {
  // Bug: the port marks every message silent, and the channel no longer lights up as unread.
  const sent: Array<Payload> = [];
  const result = await portOver(sent, on).send(chat, { text: 'hi' });
  assert.equal(result.status, 'ok');
  assert.equal(sent[0].content, 'hi');
  assert.equal(flagsOf(sent[0]) & SILENT, 0);
  assert.deepEqual(usersOf(sent[0]), []);
  assert.equal(mentionsOf(sent[0]).repliedUser, false);
  assert.deepEqual(mentionsOf(sent[0]).parse, []);
});

test('send: silent mode keeps the reply reference and does not ping a replied author with no state', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, {
    text: 'yes',
    replyTo,
    mentions: { users: [], repliedUser: true, asked: { users: [], repliedUser: false } },
  });
  assert.deepEqual(sent[0].reply, { messageReference: 'm0', failIfNotExists: false });
  assert.equal(flagsOf(sent[0]) & SILENT, 0);
  assert.equal(mentionsOf(sent[0]).repliedUser, false);
});

test('send: silent mode pings the replied author who asked for it and adds no flag', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, {
    text: 'yes',
    replyTo,
    mentions: { users: [], repliedUser: true, notify: true, asked: { users: [], repliedUser: true } },
  });
  assert.deepEqual(sent[0].reply, { messageReference: 'm0', failIfNotExists: false });
  assert.equal(flagsOf(sent[0]) & SILENT, 0);
  assert.equal(mentionsOf(sent[0]).repliedUser, true);
});

test('send: silent mode pings the named member who chose on and not the one who chose nothing', async () => {
  // Bug: the person's own state does not win per person, so a mixed message pings both or neither.
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, {
    text: 'hey <@42> and <@43>',
    mentions: { users: ['42', '43'], repliedUser: false, asked: { users: ['42'], repliedUser: false } },
  });
  assert.deepEqual(usersOf(sent[0]), ['42']);
  assert.equal(flagsOf(sent[0]) & SILENT, 0);
  assert.equal(sent[0].content, 'hey <@42> and <@43>');
});

test('send: silent mode leaves a named member with off out and keeps the mention text', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, {
    text: 'hey <@42>',
    mentions: { users: [], repliedUser: false, asked: { users: [], repliedUser: false } },
  });
  assert.deepEqual(usersOf(sent[0]), []);
  assert.equal(sent[0].content, 'hey <@42>');
});

test('send: silent mode takes asked over the users and reply ping of the same mentions', async () => {
  // Bug: the port intersects or merges asked with users instead of taking asked.
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, {
    text: 'hey',
    replyTo,
    mentions: { users: ['42', '43'], repliedUser: true, asked: { users: ['43'], repliedUser: false } },
  });
  assert.deepEqual(usersOf(sent[0]), ['43']);
  assert.equal(mentionsOf(sent[0]).repliedUser, false);
});

test('send: silent mode sends the users and reply ping as given for notify with no asked', async () => {
  // A stored mirror send carries only `notify`.
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, {
    text: 'hey <@42>',
    replyTo,
    mentions: { users: ['42'], repliedUser: true, notify: true },
  });
  assert.deepEqual(usersOf(sent[0]), ['42']);
  assert.equal(mentionsOf(sent[0]).repliedUser, true);
  assert.equal(flagsOf(sent[0]) & SILENT, 0);
});

test('send: silent mode pings nobody for mentions with neither notify nor asked', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, {
    text: 'hey <@42>',
    replyTo,
    mentions: { users: ['42'], repliedUser: true },
  });
  assert.deepEqual(usersOf(sent[0]), []);
  assert.equal(mentionsOf(sent[0]).repliedUser, false);
  assert.equal(flagsOf(sent[0]) & SILENT, 0);
});

test('send: silent mode adds no flag to a file message and keeps its text and file', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, {
    text: 'look',
    attachments: [{ name: 'a.png', data: Buffer.from('x') }],
  });
  assert.equal(sent[0].content, 'look');
  assert.equal(flagsOf(sent[0]) & SILENT, 0);
  assert.deepEqual(sent[0].files, [{ attachment: Buffer.from('x'), name: 'a.png' }]);
  assert.equal(mentionsOf(sent[0]).repliedUser, false);
});

test('send: silent mode leaves a voice message with the voice flag alone', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, {
    attachments: [
      {
        name: 'voice-1.ogg',
        data: Buffer.from('ogg'),
        voice: { durationSecs: 2, waveform: Buffer.alloc(256, 7).toString('base64') },
      },
    ],
  });
  assert.equal(sent[0].flags, VOICE);
  assert.equal(sent[0].content, undefined);
  assert.equal(mentionsOf(sent[0]).repliedUser, false);
});

test('send: silent mode adds no flag to any part of a text split into several messages', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, on).send(chat, { text: `${'word '.repeat(600)}`.trim() });
  assert.ok(sent.length > 1);
  for (const payload of sent) assert.equal(flagsOf(payload) & SILENT, 0);
});

test('send: with the key off the payload is exactly the engine always sent', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, off).send(chat, { text: 'hi', replyTo });
  assert.deepEqual(sent[0], {
    content: 'hi',
    reply: { messageReference: 'm0', failIfNotExists: false },
    allowedMentions: { parse: [] },
  });
});

test('send: with no config the payload has no flags and a requested reply ping stays', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, () => ({})).send(chat, {
    text: 'hi',
    replyTo,
    mentions: { users: [], repliedUser: true },
  });
  assert.equal(sent[0].flags, undefined);
  assert.equal(mentionsOf(sent[0]).repliedUser, true);
});

test('send: with the key off a voice message carries only the voice flag', async () => {
  const sent: Array<Payload> = [];
  await portOver(sent, off).send(chat, {
    attachments: [{ name: 'v.ogg', data: Buffer.from('o'), voice: { durationSecs: 1, waveform: 'AA==' } }],
  });
  assert.equal(sent[0].flags, VOICE);
});

test('send: switching the key between two sends changes the second only', async () => {
  const sent: Array<Payload> = [];
  let silent = false;
  const port = portOver(sent, () => ({ discord: { silent } }));
  await port.send(chat, { text: 'first', replyTo });
  silent = true;
  await port.send(chat, { text: 'second', replyTo });
  silent = false;
  await port.send(chat, { text: 'third', replyTo });
  assert.equal(sent[0].flags, undefined);
  // Owner's word of 2026-11-06: silent mode adds no suppress flag; it stops the reply ping.
  assert.equal(flagsOf(sent[1]) & SILENT, 0);
  assert.equal(mentionsOf(sent[1]).repliedUser, false);
  assert.equal(sent[2].flags, undefined);
});

// The Discord port with `discord.silent` and a member's own ping state (interfaces/discord/port.ts). The turn decides who
// a message concerns and hands the answer in `mentions.asked`: the named members whose state is `on`, and whether the
// replied author's state is `on`. In silent mode the port sends exactly that, never adds the suppress flag (the owner's
// word of 2026-11-06: the switch stops pings and nothing else) and keeps a voice flag. A message with `notify` and no
// `asked` is sent as given, one with neither pings nobody. The key is read at each send.

// The lead: the first sent payload's mentions get a name, so each assertion reads three segments deep (R.2).
const mentionsOfFirst = <T extends { allowedMentions?: unknown }>(sent: Array<T>) =>
  sent[0]?.allowedMentions as { users?: Array<string>; repliedUser?: boolean } | undefined;

type PingsPayload = {
  content?: string;
  flags?: number;
  reply?: unknown;
  allowedMentions?: { parse?: Array<string>; users?: Array<string>; repliedUser?: boolean };
};

function pingsPortOver(sent: Array<PingsPayload>, config: () => object) {
  const channel = {
    id: 'c1',
    send: (payload: PingsPayload) => {
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
const silent = () => ({ discord: { silent: true } });
const loud = () => ({ discord: { silent: false } });
// The flag is "set" when the suppress bit is among the flags; a payload with no flags has none.
const suppressed = (payload: PingsPayload | undefined): boolean => ((payload?.flags ?? 0) & SILENT) !== 0;

test('silent mode: a stray notify with nobody to notify pings nobody', async () => {
  // Bug: a stray notify with no users and no replied author is believed, and an empty ping list is sent as everyone.
  const sent: Array<PingsPayload> = [];
  await pingsPortOver(sent, silent).send(chat, {
    text: 'hi',
    mentions: { users: [], repliedUser: false, notify: true },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(mentionsOfFirst(sent)?.users ?? [], []);
  assert.equal(mentionsOfFirst(sent)?.repliedUser, false);
});

test('loud mode: asked is ignored, the mentions go out as given', async () => {
  // Bug: the new field leaks into the default path and alters the payload of every server that is not silent.
  const sent: Array<PingsPayload> = [];
  await pingsPortOver(sent, loud).send(chat, {
    text: 'hey <@42> <@43>',
    replyTo,
    mentions: { users: ['42', '43'], repliedUser: true, asked: { users: ['42'], repliedUser: false } },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(sent[0]?.allowedMentions, { parse: [], users: ['42', '43'], repliedUser: true });
});

test('loud mode: notify changes nothing, the mentions go out as given', async () => {
  // Bug: the new field leaks into the default path and alters the payload of every server that is not silent.
  const sent: Array<PingsPayload> = [];
  await pingsPortOver(sent, loud).send(chat, {
    text: 'hey <@42>',
    replyTo,
    mentions: { users: ['42'], repliedUser: true, notify: true },
  });
  assert.equal(suppressed(sent[0]), false);
  assert.deepEqual(sent[0]?.allowedMentions, { parse: [], users: ['42'], repliedUser: true });
});
