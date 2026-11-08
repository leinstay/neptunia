// A voice message she posts in a replayed turn is a line of hers in the chat the next step reads, as a picture and a
// text post are: the sandbox (src/behavior/sandbox.ts#afterScenarioTurn) and a live turn agree on what posts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterScenarioTurn } from '../src/behavior/sandbox.ts';

const SELF = '100000000000000001';
const MEMBER = '100000000000000007';
const HERE = '200000000000000001';
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

test('afterScenarioTurn: a voice message that passed is a line of hers in the chat, its mark naming it as posted', () => {
  // Catches: the replay's own list of posting skills missing `voice.say`, so the next step's chat lacks her voice message.
  const here = { id: HERE, name: 'γενικά' };
  const trigger = { id: '300000000000000001', placeId: HERE, ts: NOW, authorId: MEMBER, content: 'Πες κάτι' };
  const outcome = {
    verdict: { stage: 'gateway', ok: true },
    executed: { skill: 'voice.say', args: { text: 'καλημέρα' } },
    result: { skill: 'voice.say', status: 'ok', data: { text: '' } },
  };
  const out = afterScenarioTurn({
    transcript: [trigger],
    callMarks: [],
    run: {
      answer: null,
      call: { skill: 'voice.say', args: { text: 'καλημέρα' }, body: '' },
      followUp: null,
      outcome,
      refs: { idByIndex: new Map(), handles: null, followUpIdByIndex: null },
    },
    at: NOW,
    selfId: SELF,
    selfName: 'Persona',
    channel: here,
    triggerId: trigger.id,
    config: {},
  } as unknown as Parameters<typeof afterScenarioTurn>[0]);
  const voiced = out.transcript.find((line) => line?.authorId === SELF);
  const attachments = (voiced?.attachments ?? []) as Array<{ kind?: unknown }>;
  assert.equal(attachments[0]?.kind, 'voice');
  const [mark] = out.callMarks;
  assert.equal(mark?.postedId, voiced?.id);
});
