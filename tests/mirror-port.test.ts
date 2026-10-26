// The dry-run mirror (src/behavior/limits.js#mirrorDryRun) posts through the port like any other effect: one
// `send` to the conversation of `bot.dryRunChannelId`, the header, a newline and the body as text, no mention resolved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorDryRun } from '../src/behavior/limits.js';
import { createFakeAdapter } from '../src/interface/fake.js';

test('sends the header and the body to the dry-run conversation with no mentions', async () => {
  const port = createFakeAdapter({ selfId: 'self' });
  const sent = await mirrorDryRun({
    port,
    dryRunChannelId: 'dry1',
    header: '[dry-run] #general',
    body: 'she would say hi',
  });
  assert.equal(sent, true);
  assert.deepEqual(
    port.messagesIn('dry1').map((message) => message.text),
    ['[dry-run] #general\nshe would say hi']
  );
  const call = port.calls.find((entry) => entry.op === 'send');
  assert.deepEqual(call?.args[0], { iface: 'fake', conversationId: 'dry1' });
  assert.deepEqual(call?.args[1], {
    text: '[dry-run] #general\nshe would say hi',
    mentions: { users: [], repliedUser: false },
  });
});

test('posts nothing when no dry-run conversation is set', async () => {
  const port = createFakeAdapter();
  const sent = await mirrorDryRun({ port, dryRunChannelId: '', header: 'h', body: 'b' });
  assert.equal(sent, false);
  assert.deepEqual(port.calls, []);
});

test('answers false and throws nothing when the send fails', async () => {
  const port = createFakeAdapter();
  port.failNext('send', { status: 'failed', error: { code: 'http-500', retryable: true } });
  const sent = await mirrorDryRun({ port, dryRunChannelId: 'dry1', header: 'h', body: 'b' });
  assert.equal(sent, false);
  assert.equal(port.calls.filter((call) => call.op === 'send').length, 1);
  assert.deepEqual(port.messagesIn('dry1'), []);
});

test('splits a text longer than the interface allows into several messages', async () => {
  const port = createFakeAdapter({ capabilities: { maxChars: 100 } });
  const sent = await mirrorDryRun({ port, dryRunChannelId: 'dry1', header: 'head', body: 'word '.repeat(60) });
  assert.equal(sent, true);
  assert.equal(port.messagesIn('dry1').length > 1, true);
});
