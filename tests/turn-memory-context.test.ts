import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordAdapter, createDiscordInterface } from '../interfaces/discord/index.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import {
  NOW,
  fakeClient,
  fakeLookup,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from './fixtures/turn-kit.ts';
import { SPLIT_TEXT, splitLlm, splitHot, manualSchedule, runSplitTurn } from './fixtures/turn-split.ts';

const DISCORD = createDiscordInterface().capabilities;

test('split attempts preserve the supplied memory context in every automatic prefetch', async () => {
  const { issueContext } = await import('../src/memory/db/scope.ts');
  const context = issueContext({ kind: 'internal', newId: () => 'ctx:split-owner', now: () => NOW });
  const reads: Array<unknown> = [];
  const recall = {
    available: () => true,
    prefetch: (args: Record<string, unknown>) => {
      reads.push(args.memoryContext);
      return Promise.resolve({ status: 'ok', basis: ['message'], excerpts: [], ms: 0 });
    },
  };
  const result = await runSplitTurn({
    extra: { recall, memoryContext: issueContext },
    turnExtra: { memoryContext: context },
  });
  assert.ok(result.llm.calls.talk.length >= 2, 'the scripted splitter must produce multiple attempts');
  assert.ok(reads.length > 0, 'the turn must perform prefetch');
  assert.deepEqual(
    reads,
    reads.map(() => context)
  );
});

test('an internal split chain exposes no waiting part for an ordinary follow-up to merge into', async () => {
  const { issueContext } = await import('../src/memory/db/scope.ts');
  const context = issueContext({ kind: 'internal', newId: () => 'ctx:protected-chain', now: () => NOW });
  const waiting: Array<unknown> = [];
  const folded: Array<unknown> = [];
  const llm = splitLlm({
    talk: (index: number) => {
      if (index === 0) {
        waiting.push(turns.waitingParts('c1', 'u1'));
        folded.push(
          turns.addToPart('c1', 'u1', 2, { id: 'stale-followup', text: 'untrusted-followup-marker', ts: NOW })
        );
      }
      return '<msg>protected part answer</msg>';
    },
  });
  const raw = rawMessage({ id: 'protected-chain', content: SPLIT_TEXT, ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: splitHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup: fakeLookup(),
    now: () => NOW,
    schedule: manualSchedule(),
    memoryContext: issueContext,
  });
  await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'reply',
      trigger: normalizedTrigger(raw),
      triggerKind: 'mention',
      memoryContext: context,
    })
  );
  assert.equal(llm.calls.talk.length, 3);
  assert.deepEqual(waiting, [[]]);
  assert.deepEqual(folded, [false]);
  assert.ok(llm.calls.talk.every((request) => !JSON.stringify(request.messages).includes('untrusted-followup-marker')));
});
