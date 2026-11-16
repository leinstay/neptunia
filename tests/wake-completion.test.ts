// What ends a heartbeat (plan sections 7 and 8, the owner's word of 2026-11-04): memory reads may come first, and a
// heartbeat records one intention or a skip. It starts no agent and acts outward in no other way. Over the real turn
// runner and operations and a fake model (tests/fixtures/wake-turn.ts). `guard:` names a test of what already works and
// must keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { PROMPT_MARK, WAKE_NOW, requestText, wakeOfKind, wakeTurn } from './fixtures/wake-turn.ts';
import { tempDir } from './fixtures/tmp.ts';

const THINK = '<think>I looked at it.</think>';
const BEAT = wakeOfKind('heartbeat', 'heartbeat:1');
const SET = toolAnswer(THINK, [call('intention.set', { due: '1h', text: 'ask how the move went' })]);

test('heartbeat: the request carries no diary task', async () => {
  // Bug: heartbeat turns back into the wake that writes the diary.
  const run = await wakeTurn({ wake: BEAT, answers: ['<skip/>'] });
  assert.ok(!run.offered.some((name) => name.startsWith('selfreflection')));
  assert.ok(!requestText(run.requests[0] ?? []).includes(PROMPT_MARK.selfreflection));
});

// Changed: the filing is an errand, since her tools hold no `task.propose`.
test('guard: heartbeat: a filing or a skill run is refused, and an intention ends the turn', async () => {
  const run = await wakeTurn({
    wake: BEAT,
    answers: [
      toolAnswer(THINK, [
        call('errand.run', { agent: 'scout', goal: 'g' }),
        call('skill.run', { name: 'x', script: 'y' }),
      ]),
      SET,
    ],
  });
  assert.deepEqual(run.actions, [
    'errand.run:refused:heartbeat-only',
    'skill.run:refused:heartbeat-only',
    'intention.set:executed:ok',
  ]);
  assert.equal(run.requests.length, 2);
});

test('guard: heartbeat: a recall first, then a skip, is a completed wake with no intention', async () => {
  const run = await wakeTurn({
    wake: BEAT,
    answers: [toolAnswer(THINK, [call('lore.list')]), `${THINK}<skip/>`],
  });
  assert.equal(run.requests.length, 2);
  assert.equal(run.sends, 0);
  assert.deepEqual(run.intentions, []);
});

test('heartbeat: a restarted turn of the same wake records no second intention', async () => {
  // Bug: a crash after the intention and before the commit reruns the wake, and she wakes twice for one wish.
  const hot = { config: { bot: { timezone: 'UTC' }, intentions: { expiresDays: 14, maxOpen: 20 } } };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-wake-restart-'), now: () => WAKE_NOW }),
    hot,
    now: () => WAKE_NOW,
    log: { info() {}, warn() {} },
  });
  await wakeTurn({ wake: BEAT, answers: [SET], service });
  const again = await wakeTurn({
    wake: BEAT,
    answers: [toolAnswer(THINK, [call('intention.set', { due: '2h', text: 'ask how the move went, reworded' })])],
    service,
  });
  assert.equal(again.requests.length, 1);
  assert.equal(again.intentions.length, 1);
});
