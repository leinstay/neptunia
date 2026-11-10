// What the result of one of her calls tells her (src/turn/skill-calls.ts), here for a post the interface kept for a
// chat that is not open (`deferred` on the send's answer, src/interface/cli-chat.ts): the call stays ok and its
// result carries `labels.tools.result.storedUntilOpen`. One turn over the fake adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer, textAnswer } from './fixtures/tool-answers.ts';
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

// A voice message she sends through `voice.say` leaves a said line whose voice item keeps what she voiced
// (src/turn/skill-calls.ts, src/turn/journal-notes.ts#recordSaid), so memory can answer what she said in it. Fake model, fake
// operation; the line as `record.append` receives it.

const VOICED = '[sighs] "собор на закате"';

type SaidLine = { kind?: unknown; messageId?: unknown; text?: unknown; media?: unknown; voiced?: unknown };

async function voiceTurn(outcome: unknown) {
  const appended: Array<SaidLine> = [];
  await coreTurn({
    answers: [toolAnswer('', [call('voice.say', { text: 'ignored' })]), textAnswer('')],
    allowed: ['voice.say'],
    runner: {
      runOwnOp: () => Promise.resolve(outcome),
      record: {
        append: (_place: string, lines: Array<SaidLine>) => {
          appended.push(...lines);
          return Promise.resolve({ written: lines.length, duplicates: 0 });
        },
      },
    },
  });
  return appended.filter((line) => line.kind === 'said');
}

test('a sent voice message is one said line, its words empty and its voiced text kept', async () => {
  const said = await voiceTurn({
    status: 'ok',
    code: 'ok',
    summary: 'voice message posted',
    data: {
      text: 'voice message posted',
      ref: { chatId: 'c1', messageId: 'voice-1' },
      voice: { text: VOICED, durationSecs: 2.5 },
    },
  });
  assert.equal(said.length, 1);
  assert.equal(said[0].messageId, 'voice-1');
  assert.equal(said[0].text, '');
  assert.deepEqual(said[0].media, ['voice']);
  assert.equal(said[0].voiced, VOICED);
});

test('a voice message that failed leaves no said line', async () => {
  const said = await voiceTurn({ status: 'failed', code: 'speech-not-configured', summary: 'no' });
  assert.deepEqual(said, []);
});
