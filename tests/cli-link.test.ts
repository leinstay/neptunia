// The owner client's link (bin/cli-link.ts) over the real protocol: `serveAdapter` on a loopback transport, the far end a
// fake core that answers with `command.result` envelopes. A closed question's choices must survive the crossing and its
// answer must go back once, as a dialog answer and never an argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback } from '../src/protocol/wire.ts';
import { envelope } from '../src/protocol/envelope.ts';
import { openLinkOver } from '../bin/cli-link.ts';

type Body = Record<string, unknown>;

/** A core that acknowledges every event and answers each command with what `reply` says. */
function fakeCore(reply: (index: number) => Body) {
  const { core, client } = createLoopback();
  const commands: Array<Body> = [];
  let action = 0;
  core.onEnvelope((value) => {
    if (value.type !== 'event') return;
    core.send(envelope('ack', { status: 'ok' }, { id: `ack:${value.id}`, replyTo: value.id }));
    const body = value.body as Body;
    if (typeof body.replyRef !== 'string') return;
    commands.push(body);
    action += 1;
    core.send(
      envelope(
        'action',
        { action: 'command.result', replyRef: body.replyRef, ...reply(commands.length - 1) },
        { id: `action:${action}` }
      )
    );
  });
  return { client, commands };
}

const askFirst =
  (question: Body) =>
  (index: number): Body =>
    index === 0 ? question : { text: 'it is done', status: 'ok' };

test('a question with choices reaches the owner with them, and the answer goes back once', async () => {
  // Catches: the bridge reading only prompt and secret, so a closed question reaches the screen as free text.
  const { client, commands } = fakeCore(
    askFirst({ text: 'Pick', status: 'ask', dialogId: 'd1', prompt: 'Pick', choices: ['model-a', 'model-b'] })
  );
  const link = openLinkOver(client, { token: 't', print: null });
  const asked: Array<ReadonlyArray<string> | null> = [];
  const answer = await link.ask(
    { name: 'model.set', args: { role: 'dev' } },
    {
      ask: (_prompt, _secret, choices) => {
        asked.push(choices);
        return Promise.resolve('model-b');
      },
    }
  );
  assert.deepEqual(asked, [['model-a', 'model-b']]);
  assert.deepEqual(answer, { text: 'it is done', status: 'ok' });
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.dialogId, 'd1');
  assert.equal(commands[1]?.answer, 'model-b');
  assert.equal(JSON.stringify(commands[1]?.args).includes('model-b'), false);
  link.close();
});

test('an open question has no choices and a secret answer never joins the arguments', async () => {
  // Catches: a masked key value copied into `args`, where a log or a retry could read it.
  const { client, commands } = fakeCore(
    askFirst({ text: 'Key', status: 'ask', dialogId: 'd2', prompt: 'Key', secret: true })
  );
  const link = openLinkOver(client, { token: 't', print: null });
  const asked: Array<[boolean, ReadonlyArray<string> | null]> = [];
  await link.ask(
    { name: 'keys.extra.add', args: { name: 'one' } },
    {
      ask: (_prompt, secret, choices) => {
        asked.push([secret, choices]);
        return Promise.resolve('sk-value');
      },
    }
  );
  assert.deepEqual(asked, [[true, null]]);
  assert.equal(JSON.stringify(commands[1]?.args).includes('sk-value'), false);
  link.close();
});

test('a question with nobody to answer it is refused at once', async () => {
  // Catches: a command hanging forever with no terminal behind the link.
  const { client, commands } = fakeCore(
    askFirst({ text: 'Key', status: 'ask', dialogId: 'd3', prompt: 'Key', secret: true })
  );
  const link = openLinkOver(client, { token: 't', print: null });
  const answer = await link.ask({ name: 'keys.extra.add', args: { name: 'one' } });
  assert.equal(answer.status, 'invalid');
  assert.equal(commands.length, 1);
  link.close();
});

test('a line said as a reply carries the message id of its parent to the core', async () => {
  // Catches: the reply parent dropped on the way, so memory stores the owner's reply as a line that answers nothing.
  const { core, client } = createLoopback();
  const received: Array<Body> = [];
  core.onEnvelope((value) => {
    if (value.type !== 'event') return;
    received.push(value.body as Body);
    core.send(envelope('ack', { status: 'ok' }, { id: `ack:${value.id}`, replyTo: value.id }));
  });
  const link = openLinkOver(client, { token: 't', print: null });
  assert.equal(await link.say('hi', [], 'msg-34'), 'ok');
  assert.equal(await link.say('plain'), 'ok');
  const messages = received.map((body) => body.message as Body);
  assert.deepEqual(
    messages.map((message) => [message.content, message.replyToId]),
    [
      ['hi', 'msg-34'],
      ['plain', null],
    ]
  );
  link.close();
});
