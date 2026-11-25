// What a message the persona sends through the Discord port notifies (interfaces/discord/port.ts): nobody. Its
// `allowedMentions` parse nothing, name no member and leave the replied author unpinged, so a mention the persona writes shows as one and pings no one. No send carries the SuppressNotifications flag, so a
// message still lights the channel up as unread, and a voice message keeps its voice flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createDiscordAdapter, discordFailure } from '../../../interfaces/discord/port.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import { applyEmojiPick } from '../../../src/behavior/media-pick.ts';
import { portMediaPick } from '../../../src/interface/capabilities.ts';
import { fakeClient } from '../../fixtures/turn-kit.ts';
import { ROOM, SELF, discordHarness } from '../../fixtures/discord-harness.ts';

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
  // Bug: the port marks every message silent, and the channel does not light up as unread.
  const sent: Array<Payload> = [];
  const result = await portOver(sent).send(chat, { text: 'hi' });
  assert.equal(result.status, 'ok');
  assert.equal(sent[0]?.content, 'hi');
  assert.equal(flagsOf(sent[0]) & SUPPRESS, 0);
  assert.deepEqual(sent[0]?.allowedMentions, NOBODY);
});

// The content carries no mentions, so the reply alone is sent.
test('send: a reply keeps its reference and pings nobody', async () => {
  // Bug: the port lets Discord ping the replied author, so the author the persona answers gets a notification.
  const sent: Array<Payload> = [];
  await portOver(sent).send(chat, { text: 'yes', replyTo });
  assert.deepEqual(sent[0]?.reply, { messageReference: 'm0', failIfNotExists: false });
  assert.deepEqual(sent[0]?.allowedMentions, NOBODY);
});

test("send: a member the persona's text names is not pinged and the mention text stays as written", async () => {
  // Bug: the port lets Discord parse the text, so a member the persona names gets a notification.
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

// The Discord port's voice payload (interfaces/discord/port.ts): an attachment with `voice`
// is sent with the voice-message flag, its duration and waveform, and no text.

function voicePortOver(sent: Untyped) {
  const channel = {
    id: 'c1',
    send: async (payload: Untyped) => {
      sent.push(payload);
      return { id: 'm1', createdTimestamp: 1 };
    },
  };
  const client = { user: { id: 'self' }, channels: { cache: new Map([['c1', channel]]) } };
  // The fake client holds only the part of the Discord client that the port reads.
  return createDiscordAdapter({ client: client as unknown as Parameters<typeof createDiscordAdapter>[0]['client'] });
}

const voiceChat = { iface: 'discord', chatId: 'c1' };

test('send: a voice attachment carries the flag, duration and waveform, and no content', async () => {
  const sent: Array<Untyped> = [];
  const waveform = Buffer.alloc(256, 7).toString('base64');
  const result = await voicePortOver(sent).send(voiceChat, {
    text: 'this must not be sent',
    attachments: [
      {
        name: 'voice-1.ogg',
        data: Buffer.from('ogg'),
        contentType: 'audio/ogg',
        voice: { durationSecs: 3.5, waveform },
      },
    ],
  });
  assert.equal(result.status, 'ok');
  const [payload] = sent;
  assert.equal(payload.content, undefined);
  assert.equal(payload.flags, MessageFlags.IsVoiceMessage);
  assert.equal(payload.files.length, 1);
  const file = payload.files[0];
  assert.equal(file.name, 'voice-1.ogg');
  assert.equal(file.duration, 3.5);
  assert.equal(file.waveform, waveform);
});

test('send: an ordinary attachment keeps its text and has no voice flag', async () => {
  const sent: Array<Untyped> = [];
  await voicePortOver(sent).send(voiceChat, { text: 'hi', attachments: [{ name: 'a.png', data: Buffer.from('x') }] });
  assert.equal(sent[0].content, 'hi');
  assert.equal(sent[0].flags, undefined);
  assert.deepEqual(sent[0].files, [{ attachment: Buffer.from('x'), name: 'a.png' }]);
});

// The content carries no mentions, so only the plain send's payload is checked.
test('discord adapter: a send is a payload whose allowedMentions name nobody', async () => {
  const h = discordHarness();
  const nobody = { parse: [], users: [], repliedUser: false };
  await h.port.send({ iface: 'discord', chatId: ROOM }, { text: 'α' });
  assert.deepEqual(h.payloads[0], { content: 'α', reply: undefined, allowedMentions: nobody });
});

test('discord adapter: a channel the caller holds is used before the client', async () => {
  const sent = [];
  const held = {
    id: 'c9',
    send: async (payload: Record<string, Untyped>) => (sent.push(payload), { id: 'x1', createdTimestamp: 42 }),
  };
  const port = createDiscordAdapter({
    client: { user: { id: SELF } },
    lookupChannel: wrongly((id: string) => (id === 'c9' ? held : null)),
  });
  const result = await port.send({ iface: 'discord', chatId: 'c9' }, { text: 'ναι' });
  // A send answers a Delivery (it also carries `parts` and an idempotency key), so the fields that matter are read.
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.ref, { iface: 'discord', chatId: 'c9', messageId: 'x1', accountId: SELF });
  assert.equal(result.at, 42);
  assert.deepEqual(result.parts, [result.ref]);
  assert.equal(sent.length, 1);
});

test('discord adapter: a text over the limit posts one message per part, replying only on the first', async () => {
  const h = discordHarness();
  const limit = h.port.capabilities().maxChars;
  const text = 'α'.repeat(limit + 1);
  const replyTo = { iface: 'discord', chatId: ROOM, messageId: 'target-1' };
  const delivery = await h.port.send({ iface: 'discord', chatId: ROOM }, { text, replyTo });
  assert.equal(delivery.status, 'ok');
  const payloads = h.payloads;
  assert.equal(payloads.length, 2, 'one channel.send per part');
  assert.deepEqual(
    delivery.parts.map((ref) => ref.messageId),
    ['d1', 'd2']
  );
  assert.deepEqual(delivery.ref, delivery.parts[0]);
  const reply = payloads[0]?.reply;
  assert.equal(reply?.messageReference, 'target-1');
  assert.equal(payloads[1]?.reply, undefined, 'the second part does not reply');
  assert.equal(payloads.map((payload) => payload.content).join(''), text);
});

test('discord adapter: a failure on the second part is unknown and keeps the first part', async () => {
  let calls = 0;
  const held = {
    id: 'c9',
    send: () => {
      calls += 1;
      if (calls === 2) return Promise.reject(Object.assign(new Error('Internal Server Error'), { status: 500 }));
      return Promise.resolve({ id: `x${calls}`, createdTimestamp: 42 });
    },
  };
  const port = createDiscordAdapter({
    client: { user: { id: SELF } },
    lookupChannel: wrongly((id: string) => (id === 'c9' ? held : null)),
  });
  const delivery = await port.send(
    { iface: 'discord', chatId: 'c9' },
    { text: 'α'.repeat(port.capabilities().maxChars + 1) }
  );
  assert.equal(delivery.status, 'unknown');
  assert.deepEqual(
    delivery.parts.map((ref) => ref.messageId),
    ['x1']
  );
  assert.equal(calls, 2, 'no third attempt and no retry of the failed part');
});

test('discord adapter: an unknown channel fails without a send', async () => {
  const h = discordHarness();
  const result = await h.port.send({ iface: 'discord', chatId: 'gone' }, { text: 'α' });
  assert.deepEqual([result.status, result.error?.code], ['failed', 'http-404']);
  assert.equal(h.payloads.length, 0);
});

test('discordFailure: Discord answers are normalised', () => {
  const http = (status: number) => Object.assign(new Error('x'), { status });
  const view = (result: Record<string, Untyped>) => [result.status, result.error.code, result.error.retryable];
  assert.deepEqual(view(discordFailure(http(429), { sent: true })), ['failed', 'http-429', true]);
  assert.deepEqual(view(discordFailure(http(403), { sent: true })), ['forbidden', 'http-403', false]);
  assert.deepEqual(view(discordFailure(http(404), { sent: true })), ['failed', 'http-404', false]);
  assert.deepEqual(view(discordFailure(http(502), { sent: true })), ['unknown', 'http-502', false]);
  assert.deepEqual(view(discordFailure(http(502), { sent: false })), ['failed', 'http-502', true]);
  assert.deepEqual(view(discordFailure(new Error('socket hang up'), { sent: true })), ['unknown', 'error', false]);
  assert.deepEqual(view(discordFailure(Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), { sent: false })), [
    'failed',
    'timeout',
    true,
  ]);
  assert.ok(
    present(discordFailure(http(403), { sent: true }).error).cause instanceof Error,
    'the cause is kept for the logs'
  );
});

test('the Discord interface declares GIF links and files, both emoji actions and its text', () => {
  const declared = portMediaPick(createDiscordAdapter({ client: fakeClient() }));
  assert.ok(declared);
  assert.deepEqual([...declared.gifForms].sort(), ['file', 'link']);
  assert.deepEqual([...(declared.emoji?.actions ?? [])].sort(), ['append', 'replace']);
  assert.ok(typeof declared.text === 'string' && declared.text.trim() !== '');
});

// An emoji and a sticker go by a stable name of the engine.
test('the Discord interface renders its own emoji markup', () => {
  const declared = portMediaPick(createDiscordAdapter({ client: fakeClient() }));
  assert.ok(declared?.emoji);
  const { render } = declared.emoji;
  const still = { id: '42', name: 'e1', platformName: 'wave', animated: false };
  assert.equal(applyEmojiPick('', { action: 'replace', emoji: still }, render), '<:wave:42>');
  assert.equal(applyEmojiPick('', { action: 'replace', emoji: { ...still, animated: true } }, render), '<a:wave:42>');
});

/**
 * A whole discord.js-shaped message: the adapter also builds its event from it (changed with the contract: a read by id
 * answers the message's whole event beside its text and attachments).
 */
function wholeMessage({ id, content, attachments }: Record<string, Untyped>) {
  return {
    id,
    placeId: 'c1',
    channel: { name: 'general' },
    guild: { id: 'g1' },
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
    member: { displayName: 'Alice' },
    content,
    cleanContent: content,
    createdTimestamp: 1000,
    reference: null,
    attachments,
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
  };
}

test('the Discord adapter reads messages by id: text, attachments, and missing for a deleted one', async () => {
  const messages = new Map([
    [
      'm1',
      wholeMessage({
        id: 'm1',
        content: 'a post',
        attachments: new Map([
          ['a1', { url: 'https://cdn.example/a.png', name: 'a.png', contentType: 'image/png', size: 12 }],
        ]),
      }),
    ],
  ]);
  const channel = {
    messages: {
      async fetch(id: string) {
        if (id === 'boom') throw Object.assign(new Error('x'), { status: 500 });
        if (!messages.has(id)) throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
        return messages.get(id);
      },
    },
  };
  const port = createDiscordAdapter({
    client: { channels: { cache: wrongly(new Map([['c1', channel]])) }, user: { id: 'me' } },
  });
  const found = await port.fetchMessages({ iface: 'discord', chatId: 'c1' }, ['m1', 'm2']);
  assert.equal(found.status, 'ok');
  assert.deepEqual(
    found.messages.map((message) => {
      const copy = { ...message };
      delete copy.event;
      return copy;
    }),
    [
      {
        messageId: 'm1',
        text: 'a post',
        attachments: [{ url: 'https://cdn.example/a.png', name: 'a.png', contentType: 'image/png', size: 12 }],
      },
      { messageId: 'm2', missing: true },
    ]
  );
  const failed = await port.fetchMessages({ iface: 'discord', chatId: 'c1' }, ['m1', 'boom']);
  assert.notEqual(failed.status, 'ok');
  const nowhere = await port.fetchMessages({ iface: 'discord', chatId: 'c9' }, ['m1']);
  assert.equal(nowhere.status, 'failed');
});

test('the Discord adapter passes an attachment duration and waveform when Discord gives them', async () => {
  const messages = new Map([
    [
      'm1',
      wholeMessage({
        id: 'm1',
        content: '',
        attachments: new Map([
          [
            'a1',
            {
              url: 'https://cdn.example/v.ogg',
              name: 'v.ogg',
              contentType: 'audio/ogg',
              size: 9,
              duration: 2.5,
              waveform: 'AAEC',
            },
          ],
        ]),
      }),
    ],
  ]);
  const channel = { messages: { fetch: async (id: string) => messages.get(id) } };
  const port = createDiscordAdapter({
    client: { channels: { cache: wrongly(new Map([['c1', channel]])) }, user: { id: 'me' } },
  });
  const found: Record<string, Untyped> = await port.fetchMessages({ iface: 'discord', chatId: 'c1' }, ['m1']);
  const message = found.messages[0];
  assert.deepEqual(message.attachments[0], {
    url: 'https://cdn.example/v.ogg',
    name: 'v.ogg',
    contentType: 'audio/ogg',
    size: 9,
    durationSec: 2.5,
    waveform: 'AAEC',
  });
});
