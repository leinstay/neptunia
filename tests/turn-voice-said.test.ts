// A voice message she sends through `voice.say` leaves a said line whose voice item keeps what she voiced
// (src/turn/skill-calls.ts, src/turn/journal-notes.ts#recordSaid), so memory can answer what she said in it. Fake model, fake
// operation; the line as `record.append` receives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, textAnswer, toolAnswer } from './fixtures/tool-answers.ts';
import { coreTurn } from './fixtures/turn-harness.ts';

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
