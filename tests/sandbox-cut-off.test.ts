// An answer cut at the output cap (finish reason `length`) is read by the sandbox as a live turn reads it
// (src/turn/phases/response.ts): the last `<msg>` left open is a fragment and is dropped, never delivered as her words.
// Both sandbox entries read a completion, `answerReply` (the replay of one moment) and `answerSkillScenario` (a scenario
// run and the steps of its tool loop), against a fake model; nothing is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/index.ts';
import { answerReply, answerSkillScenario, liveView, personaGrantsConfig } from '../src/behavior/sandbox.ts';
import { ALICE, CHANNEL, NOW, SELF_ID, fakeHot, fakeStore, moment } from './fixtures/sandbox-kit.ts';
import { asRecord } from './fixtures/records.ts';

const CUT = '<think>t</think><msg>the first half of a sent';

/** A fake model whose one answer is `CUT`, ended with `finishReason`. */
function llmEnding(finishReason: string) {
  return {
    complete: () => Promise.resolve({ text: CUT, usage: {}, estimated: 10, finishReason }),
  };
}

const situation = () => ({
  ...moment([[ALICE, 'Alice', 'tell me about chess', 1]]),
  triggerId: '800000000000000100',
  kind: 'mention',
  mode: 'reply',
});

test('answerReply drops the fragment of a message cut at the output cap', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const result = await answerReply({
    view,
    situation: situation(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm: llmEnding('length'),
    samples: 1,
    at: NOW,
  });
  assert.deepEqual(result.answers[0].messages, []);
  assert.equal(result.answers[0].skip, true);
});

test('answerSkillScenario drops the fragment of a message cut at the output cap', async () => {
  const hot = {
    ...fakeHot(),
    config: personaGrantsConfig(
      { ...fakeHot().config, bot: { owners: [ALICE], timezone: 'UTC', access: {} }, tools: { safeMode: false } },
      SELF_ID,
      []
    ),
  };
  const view = liveView({ hot, store: fakeStore(), placeId: 'g1' });
  const answered = await answerSkillScenario({
    view,
    situation: situation(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm: llmEnding('length'),
    runs: 1,
    at: NOW,
    onCall: () => Promise.reject(new Error('no call is expected')),
  });
  const answer = asRecord(answered.runs[0]?.answer);
  assert.deepEqual(answer.messages, []);
  assert.equal(answer.skip, true);
});
