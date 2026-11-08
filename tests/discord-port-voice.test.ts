// The Discord port's voice payload (interfaces/discord/port.ts): an attachment with `voice`
// is sent with the voice-message flag, its duration and waveform, and no text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createDiscordAdapter } from '../interfaces/discord/port.ts';
import type { Untyped } from '../src/tools/types.ts';

function portOver(sent: Untyped) {
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

const chat = { iface: 'discord', chatId: 'c1' };

test('send: a voice attachment carries the flag, duration and waveform, and no content', async () => {
  const sent: Array<Untyped> = [];
  const waveform = Buffer.alloc(256, 7).toString('base64');
  const result = await portOver(sent).send(chat, {
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
  assert.equal(payload.files[0].name, 'voice-1.ogg');
  assert.equal(payload.files[0].duration, 3.5);
  assert.equal(payload.files[0].waveform, waveform);
});

test('send: an ordinary attachment keeps its text and has no voice flag', async () => {
  const sent: Array<Untyped> = [];
  await portOver(sent).send(chat, { text: 'hi', attachments: [{ name: 'a.png', data: Buffer.from('x') }] });
  assert.equal(sent[0].content, 'hi');
  assert.equal(sent[0].flags, undefined);
  assert.deepEqual(sent[0].files, [{ attachment: Buffer.from('x'), name: 'a.png' }]);
});
