// What a replay keeps of a turn's requests and the report it writes (scripts/lib/turn-report.ts): each step with its
// calls and their results, the reply, the time to it and why the loop ended, and a run stopped at its first request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOPPED, recordingLlm, turnReport } from '../scripts/lib/turn-report.ts';
import type { KeptRequest } from '../scripts/lib/turn-report.ts';

const request = (over: Partial<KeptRequest>): KeptRequest => ({
  purpose: 'reply',
  model: 'm',
  messages: [{ role: 'user', content: 'Γεια' }],
  tools: [],
  startedAt: 1_000,
  ms: 200,
  text: '<think>Πρώτα διαβάζω.</think>',
  toolCalls: [],
  error: null,
  ...over,
});

const steps = [
  request({ toolCalls: [{ id: 'call_1', name: 'conversation_read', arguments: '{"last":5}' }] }),
  request({
    startedAt: 1_500,
    messages: [
      { role: 'user', content: 'Γεια' },
      { role: 'tool', tool_call_id: 'call_1', content: 'Πέντε γραμμές' },
    ],
    text: '<think>Απαντώ.</think><msg>Καλημέρα</msg>',
  }),
];

const reportOf = () =>
  turnReport({
    turnId: 't-1',
    sample: 1,
    requests: steps,
    writes: [{ op: 'send', at: 1_900, args: [{ iface: 'fake', chatId: '1' }, { text: 'Καλημέρα' }] }],
    keptCalls: [],
    result: { outcome: 'spoke' },
    journal: [{ kind: 'action', record: { input: { toolCallId: 'call_1' }, phase: 'succeeded' } }],
    estimate: (messages) => messages.length,
  });

test('lays out each step with its call, the call status and the size of its result', () => {
  const [first, second] = reportOf().steps;
  assert.deepEqual(first.calls, [
    { name: 'conversation_read', arguments: '{"last":5}', status: 'ok', resultChars: 'Πέντε γραμμές'.length },
  ]);
  assert.equal(first.think, 'Πρώτα διαβάζω.');
  assert.deepEqual(second.calls, []);
});

test('reports the reply, the time from the first request to it and why the loop ended', () => {
  const report = reportOf();
  assert.deepEqual(report.reply.messages, ['Καλημέρα']);
  assert.equal(report.totalMs, 900);
  assert.equal(report.stepCount, 2);
  assert.equal(report.callCount, 1);
  assert.equal(report.endedBecause, 'an answer without a call');
});

test('keeps the first request of the purpose it stops at and sends it nowhere', async () => {
  let sent = 0;
  const { llm, requests } = recordingLlm(
    {
      complete: () => {
        sent += 1;
        return Promise.resolve({ text: '' });
      },
    },
    { stopAt: 'reply', wall: () => 7 }
  );
  await llm.complete([{ role: 'user', content: 'Γεια' }], { purpose: 'split' });
  await assert.rejects(llm.complete([{ role: 'user', content: 'Γεια' }], { purpose: 'reply' }), new RegExp(STOPPED));
  assert.equal(sent, 1);
  assert.deepEqual(
    requests.map((one) => [one.purpose, one.error]),
    [
      ['split', null],
      ['reply', STOPPED],
    ]
  );
});
