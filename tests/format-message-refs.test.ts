// Tests for the message links a transcript shows as numbers (src/format.js#formatTranscript with `messageNumbers`):
// the core turns only the references the adapter put on a message (`messageRefs`) into the `#n` of a line of the
// window, never a link it finds in the text by its shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTranscript } from '../src/format.js';
import { labels } from './fixtures/labels.js';

const TZ = 'Europe/Athens';
const MIN = 60_000;

type Ref = { iface: string; conversationId: string; messageId: string; url: string; text: string };
type Line = {
  id: string;
  ts: number;
  authorId: string;
  authorName: string;
  content: string;
  channelId: string;
  channelName: string;
  messageRefs?: Array<Ref>;
};

function msg(id: string, ts: number, overrides: Partial<Line> = {}): Line {
  return {
    id,
    ts,
    authorId: 'u1',
    authorName: 'Nick',
    content: 'text',
    channelId: 'c1',
    channelName: 'general',
    ...overrides,
  };
}

const refTo = (id: string, text: string): Ref => ({
  iface: 'discord',
  conversationId: '22',
  messageId: id,
  url: text.replace(/[<>]/g, ''),
  text,
});

test('formatTranscript: messageNumbers maps a reference to a line of the list to its #n, a reference to another message stays', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const link = (id: string): string => `https://discord.com/channels/9/22/${id}`;
  const messages = [
    msg('101', t0, { content: 'γεια' }),
    msg('102', t0 + MIN, {
      content: `εδώ ${link('101')} και ${link('555')}`,
      messageRefs: [refTo('101', link('101')), refTo('555', link('555'))],
    }),
  ];
  const base = { timezone: TZ, gapMinutes: 20, maxChars: 500, selfName: 'Nept', labels, indexOffset: 6 };
  const on = formatTranscript(messages, { ...base, messageNumbers: true });
  assert.ok(on[1].text.endsWith(`Nick: εδώ #7 και ${link('555')}`), on[1].text);
  const off = formatTranscript(messages, base);
  assert.ok(off[1].text.endsWith(`Nick: εδώ ${link('101')} και ${link('555')}`), off[1].text);
  const memory = formatTranscript(messages, { ...base, mode: 'memory', messageNumbers: true });
  assert.ok(memory[1].text.includes(link('101')), 'memory mode has no numbers to point at');
});

test('formatTranscript: a reference written in angle brackets turns the whole span, brackets included, into the #n', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const written = '<https://discord.com/channels/9/22/101>';
  const messages = [
    msg('101', t0, { content: 'γεια' }),
    msg('102', t0 + MIN, { content: `voilà ${written}.`, messageRefs: [refTo('101', written)] }),
  ];
  const base = { timezone: TZ, gapMinutes: 20, maxChars: 500, selfName: 'Nept', labels, indexOffset: 6 };
  const on = formatTranscript(messages, { ...base, messageNumbers: true });
  assert.ok(on[1].text.endsWith('Nick: voilà #7.'), on[1].text);
});

test('formatTranscript: a Discord link in the text with no reference on the message stays as written', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const link = 'https://discord.com/channels/9/22/101';
  const messages = [msg('101', t0, { content: 'γεια' }), msg('102', t0 + MIN, { content: `εδώ ${link}` })];
  const base = { timezone: TZ, gapMinutes: 20, maxChars: 500, selfName: 'Nept', labels, indexOffset: 6 };
  const on = formatTranscript(messages, { ...base, messageNumbers: true });
  assert.ok(on[1].text.endsWith(`Nick: εδώ ${link}`), on[1].text);
});
