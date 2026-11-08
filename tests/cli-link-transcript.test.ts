// bin/cli-link.ts: the lines of a resumed chat answer the core's history reads, in place of this session's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback } from '../src/protocol/wire.ts';
import { openLinkOver } from '../bin/cli-link.ts';
import type { MessageEvent } from '../src/protocol/adapter.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import type { AdapterLink } from '../src/interface/link.ts';
import type { Principal } from '../src/interface/principals.ts';

const quiet = { info() {}, warn() {}, error() {} };

test('showLines replaces the transcript, keeps native ids and marks her lines as hers', () => {
  // Bug: a branch shows on the screen while the model still gets the lines past the boundary.
  const { client } = createLoopback();
  const transcript: Array<MessageEvent> = [];
  const link = openLinkOver(client, { token: 't', print: null, transcript });
  void link.say('a line of this session');
  link.showLines([
    { id: 's1', at: 10, who: 'owner', text: 'stored', nativeId: 'n1' },
    { id: 's2', at: 20, who: 'her', text: 'reply' },
  ]);
  assert.deepEqual(
    transcript.map((event) => [event.message.id, event.message.content, event.message.author?.self]),
    [
      ['n1', 'stored', false],
      ['s2', 'reply', true],
    ]
  );
  link.close();
});

test('her reply to a line keeps the line it answers, in the transcript and for the screen', async () => {
  // Bug: the command line printed her reply and dropped `replyTo`, so every later read saw a reply to nothing.
  const { core, client } = createLoopback();
  const door = createEventDoor({ handlers: { 'message.received': () => {} }, log: quiet });
  const owner: Principal = { name: 'owner', kind: 'cli', iface: 'cli', permissions: [] };
  const coreLink: AdapterLink = openAdapterLink({
    transport: core,
    door,
    principalOf: (token) => (token === 't' ? owner : null),
    log: quiet,
  });
  const transcript: Array<MessageEvent> = [];
  const printed: Array<[string, string | null]> = [];
  const link = openLinkOver(client, {
    token: 't',
    print: (text, replyTo = null) => void printed.push([text, replyTo]),
    transcript,
  });
  await coreLink.hello;
  link.showLines([{ id: 's1', at: 10, who: 'owner', text: 'a question', nativeId: 'n1' }]);
  const sent = await coreLink.adapter.send(
    { iface: 'cli', chatId: 'cli:dm:owner' },
    { text: 'the answer', replyTo: { iface: 'cli', chatId: 'cli:dm:owner', messageId: 'n1' } }
  );
  assert.equal(sent.status, 'ok');
  assert.deepEqual(printed, [['the answer', 'n1']]);
  assert.equal(transcript.at(-1)?.message.replyToId, 'n1');
  link.close();
});

test('a resumed line that replied to another keeps the line it answers', () => {
  const { client } = createLoopback();
  const transcript: Array<MessageEvent> = [];
  const link = openLinkOver(client, { token: 't', print: null, transcript });
  link.showLines([
    { id: 's1', at: 10, who: 'owner', text: 'a question', nativeId: 'n1' },
    { id: 's2', at: 20, who: 'her', text: 'the answer', nativeId: 'n2', replyToId: 'n1' },
  ]);
  assert.deepEqual(
    transcript.map(({ message }) => message.replyToId),
    [null, 'n1']
  );
  link.close();
});
