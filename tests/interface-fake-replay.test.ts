// Tests for the fake adapter's replay of recorded inbound events (src/interface/fake.ts#replayFixture)
// through the event door: no discord.js anywhere, every kind of event enters through the one door,
// and a redelivered event is handled once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { MessageReceived } from '../src/protocol/events.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createFakeAdapter, replayFixture } from '../src/interface/fake.ts';
import { originOf, validateEvent } from '../src/protocol/index.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly } from './fixtures/loose-types.ts';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/events/basic-chat.json', import.meta.url), 'utf8'));
const quiet = { info() {}, warn() {} };

test('replayFixture: the events enter the door in order, a redelivery is a duplicate, handlers run once each', async () => {
  const handled: Array<Untyped> = [];
  const names = ['message.received', 'reaction.changed', 'voice.changed', 'membership.changed', 'errand.done'];
  const door = createEventDoor({
    handlers: Object.fromEntries(
      names.map((kind) => [
        kind,
        (event: Record<string, Untyped>) => handled.push(event.kind + (event.deleted ? ':deleted' : '')),
      ])
    ),
    log: quiet,
  });
  const port = createFakeAdapter({ selfId: 'self' });
  const answers = await replayFixture(fixture, door, { port });
  assert.deepEqual(
    answers.map((a) => a.status),
    ['ok', 'duplicate', 'ok', 'ok', 'ok', 'ok', 'ok']
  );
  assert.deepEqual(
    answers.map((a) => a.id),
    [
      'fake:message:m1',
      'fake:message:m1',
      'fake:reaction:m1:u2:1',
      'fake:voice:u2:1',
      'fake:member:u3:1',
      'errand.done:t1:done',
      'fake:delete:m1',
    ]
  );
  assert.deepEqual(handled, [
    'message.received',
    'reaction.changed',
    'voice.changed',
    'membership.changed',
    'errand.done',
    'message.received:deleted',
  ]);
  assert.deepEqual(
    port.messagesIn('c1').map((m) => [m.ref.messageId, m.authorId, m.text]),
    [['m1', 'u1', 'καλημέρα']],
    'the message is in the fake conversation'
  );
});

test('replayFixture: a handler sees a message whose origin says an answer is expected, and the persona answers through the fake port', async () => {
  const port = createFakeAdapter({ selfId: 'self' });
  const door = createEventDoor({
    handlers: {
      'message.received': async (event: MessageReceived) => {
        if (event.deleted || originOf(event).replyExpected !== true) return;
        await port.send(
          { iface: 'fake', conversationId: event.conversation.id },
          {
            text: 'γεια!',
            replyTo: { iface: 'fake', conversationId: event.conversation.id, messageId: event.message.id },
          }
        );
      },
    },
    log: quiet,
  });
  await replayFixture(fixture, door, { port });
  const sends = wrongly<Array<{ args: Array<{ text: string }> }>>(port.calls.filter((call) => call.op === 'send'));
  assert.equal(sends.length, 1, 'the redelivery did not make her answer twice');
  assert.equal(sends[0].args[1].text, 'γεια!');
});

test('replayFixture: an event with an invalid shape is answered invalid and reaches no handler', async () => {
  let called = 0;
  const door = createEventDoor({
    handlers: {
      'voice.changed': () => {
        called += 1;
      },
    },
    log: quiet,
  });
  const answers = await replayFixture(
    wrongly({ iface: 'fake', events: [{ kind: 'voice.changed', at: 1, id: 'v', rootId: 'g1' }] }),
    door
  );
  assert.deepEqual(answers, [{ id: null, status: 'invalid' }]);
  assert.equal(called, 0);
});
