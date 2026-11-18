// What ends a heartbeat (plan sections 7 and 8, the owner's word of 2026-11-04): memory reads may come first, and a
// heartbeat records any number of intention changes and ends on an answer with no call. It starts no agent and acts outward in no other way. Over the real turn
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
  assert.ok(!run.offered.some((name) => name.startsWith('diary')));
  assert.ok(!requestText(run.requests[0] ?? []).includes(PROMPT_MARK.diary));
});

// Changed: a heartbeat hands off an errand and waits for it (the owner's decision of 2026-11-17), so only the skill run
// is refused, and the errand does not end the wake.
// Changed: a heartbeat takes several intention changes, so the change is followed by the request her skip ends.
test('heartbeat: a skill run is refused, an errand is accepted and does not end the wake, an intention does not either', async () => {
  const run = await wakeTurn({
    wake: BEAT,
    answers: [
      toolAnswer(THINK, [call('errand.scout', { goal: 'g' }), call('skill.run', { name: 'x', script: 'y' })]),
      SET,
      '<skip/>',
    ],
    errands: waitedErrands().service,
  });
  assert.deepEqual(run.actions, [
    'errand.scout:executed:ok',
    'skill.run:refused:heartbeat-only',
    'intention.set:executed:ok',
  ]);
  assert.equal(run.requests.length, 3);
});

/** An errand service whose waits end at once with a done errand, after `delayMs`; `waits` records each wait's time. */
function waitedErrands(delayMs = 0) {
  const waits: Array<number> = [];
  const errand = {
    id: 'e1',
    agent: 'scout',
    goal: 'g',
    state: 'done',
    result: { text: 'ΤΟ ΑΠΟΤΕΛΕΣΜΑ ΤΗΣ ΑΝΑΖΗΤΗΣΗΣ', sources: [], files: [] },
    requester: { accountId: null, kind: 'persona' },
    origin: { placeId: null, messageId: null },
  };
  return {
    waits,
    service: {
      submit: () => ({ ok: true, errand: { ...errand, state: 'queued', result: null } }),
      wait: async ({ ms }: { ms: number }) => {
        waits.push(ms);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { ended: true, errand };
      },
      budget: () => ({ spent: false, key: null, code: null }),
      view: () => [],
      markSeen: () => 0,
      markRead: () => 0,
      store: () => null,
    },
  };
}

test('heartbeat: a waited errand that returns is read in a follow-up request of the same turn', async () => {
  // Bug caught: an accepted errand ends a quiet inner turn, so the result she waited for is never read.
  const { service } = waitedErrands();
  const run = await wakeTurn({
    wake: BEAT,
    answers: [toolAnswer(THINK, [call('errand.scout', { goal: 'g' })]), SET, '<skip/>'],
    errands: service,
  });
  // Changed: a heartbeat takes several intention changes, so her skip after the change ends the turn.
  assert.equal(run.requests.length, 3);
  assert.ok(requestText(run.requests[1] ?? []).includes('ΤΟ ΑΠΟΤΕΛΕΣΜΑ ΤΗΣ ΑΝΑΖΗΤΗΣΗΣ'));
  assert.deepEqual(run.actions, ['errand.scout:executed:ok', 'intention.set:executed:ok']);
});

test("heartbeat: the waiting call gets the budget's remaining time when wakes.loop.callTimeoutMs is smaller", async () => {
  // Bug caught: the call that waits for a 600-second errand is cut at the timeout of an ordinary call.
  const { service, waits } = waitedErrands(1500);
  const run = await wakeTurn({
    wake: BEAT,
    answers: [toolAnswer(THINK, [call('errand.scout', { goal: 'g' })]), SET, '<skip/>'],
    errands: service,
    wakes: { loop: { maxSteps: 4, timeBudgetMs: 500_000, maxCallsPerStep: 4, callTimeoutMs: 1000 } },
  });
  assert.equal(run.actions[0], 'errand.scout:executed:ok', 'not cut at the timeout of an ordinary call');
  assert.ok((waits[0] ?? 0) > 400_000, `the wait got ${waits[0]} ms`);
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

test('heartbeat: a restarted turn of the same wake repeats no intention, and its second intention.set makes a second one', async () => {
  // Bug: a crash after the intention and before the commit reruns the wake, and she wakes twice for one wish; or the
  // second intention.set of the wake answers with the first one's result and the second wish is lost.
  const hot = { config: { bot: { timezone: 'UTC' }, intentions: { expiresDays: 14, maxOpen: 20 } } };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-wake-restart-'), now: () => WAKE_NOW }),
    hot,
    now: () => WAKE_NOW,
    log: { info() {}, warn() {} },
  });
  await wakeTurn({ wake: BEAT, answers: [SET, '<skip/>'], service });
  const again = await wakeTurn({
    wake: BEAT,
    answers: [
      toolAnswer(THINK, [call('intention.set', { due: '2h', text: 'ask how the move went, reworded' })]),
      toolAnswer(THINK, [call('intention.set', { due: '3h', text: 'share the song' })]),
      '<skip/>',
    ],
    service,
  });
  assert.equal(again.requests.length, 3);
  assert.deepEqual(again.intentions.map((intention) => String(intention.purpose)).sort(), [
    'ask how the move went',
    'share the song',
  ]);
});

// Bug caught: the final request of a heartbeat makes its first intention change alone and drops the second wish.
test('heartbeat: the final request makes every intention change it holds', async () => {
  const run = await wakeTurn({
    wake: BEAT,
    answers: [
      toolAnswer(THINK, [call('lore.list')]),
      toolAnswer(THINK, [
        call('intention.set', { due: '1h', text: 'ask how the move went' }),
        call('intention.set', { due: '3h', text: 'share the song' }),
      ]),
    ],
    wakes: { loop: { maxSteps: 1, timeBudgetMs: 500_000, maxCallsPerStep: 4, callTimeoutMs: 1000 } },
  });
  assert.equal(run.requests.length, 2, 'the read, then the final request');
  assert.deepEqual(run.actions.slice(1), ['intention.set:executed:ok', 'intention.set:executed:ok']);
});
