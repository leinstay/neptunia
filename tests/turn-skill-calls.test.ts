// What the result of one of her calls tells her (src/turn/skill-calls.ts), here for a post the interface kept for a
// chat that is not open (`deferred` on the send's answer, src/interface/cli-chat.ts): the call stays ok and its
// result carries `labels.tools.result.storedUntilOpen`. One turn over the fake adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { appended, contentText, coreTurn } from './fixtures/turn-harness.ts';

test('a message.create the interface kept for a closed chat is ok, and its result says it is shown when the chat opens', async () => {
  // Bug: she reads a plain success and believes the owner saw the message, though no chat was open to show it.
  const run = await coreTurn({
    answers: [toolAnswer('<think>x</think>', [call('message.create', { text: 'good night' })]), '<skip/>'],
    allowed: ['message.create'],
    setup(port) {
      const send = port.send.bind(port);
      port.send = async (...args: Parameters<typeof send>) => ({ ...(await send(...args)), deferred: true });
    },
  });
  const [first] = run.sends;
  assert.equal(first?.text, 'good night');
  const result = contentText(appended(run.llm, 1).find((message) => message.role === 'tool')?.content);
  const { result: words } = labels.tools;
  assert.ok(result.startsWith(words.ok), 'the call is ok');
  assert.ok(result.includes(words.storedUntilOpen), 'the result says the post waits for the chat');
});
