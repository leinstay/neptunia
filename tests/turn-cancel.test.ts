// The owner's cancel on the real turn runner: the phases read the signal `cancelOf` gives for the message that started the
// turn. A turn with no signal is every other interface's, and it runs as it always did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { coreTurn } from './fixtures/turn-harness.ts';
import { asRecord } from './fixtures/records.ts';

const texts = (run: Awaited<ReturnType<typeof coreTurn>>): Array<unknown> => run.sends.map((send) => send.text);

test('a cancel during generation ends the turn cancelled with nothing posted', async () => {
  // Bug: the answer that was on its way goes out after the owner cancelled it.
  const abort = new AbortController();
  const run = await coreTurn({
    answers: ['<think>t</think><msg>γεια</msg>'],
    runner: { cancelOf: () => abort.signal },
    onAnswer: () => abort.abort(),
  });
  assert.equal(asRecord(run.result).outcome, 'cancelled');
  assert.deepEqual(texts(run), []);
});

test('the reply request carries the signal, so a cancel reaches the provider call', async () => {
  // Bug: the request goes on spending tokens after the turn says it stopped.
  const abort = new AbortController();
  let signal: AbortSignal | null = null;
  const llm = {
    complete: (_messages: unknown, options: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal = options.signal ?? null;
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        setImmediate(() => abort.abort());
      }),
  };
  const run = await coreTurn({
    answers: [],
    runner: { cancelOf: () => abort.signal, llm },
    config: { pace: { dropAfterMs: null } },
  });
  assert.equal(asRecord(run.result).outcome, 'cancelled');
  assert.equal((signal as AbortSignal | null)?.aborted, true, 'a turn without a bar still passes a signal');
});

test('a cancel between tool results stops the next request and holds her speech back', async () => {
  // Bug: the loop goes on to another step and another provider call after the cancel.
  const abort = new AbortController();
  const run = await coreTurn({
    answers: [toolAnswer('<think>x</think><msg>ορίστε</msg>', [call('lore.list', {})]), '<msg>ποτέ</msg>'],
    runner: {
      cancelOf: () => abort.signal,
      noteProgress: (_id: unknown, step: { detail: string }) => {
        if (step.detail !== 'started') abort.abort();
      },
    },
  });
  assert.equal(run.llm.calls.length, 1);
  assert.deepEqual(texts(run), []);
  assert.equal(asRecord(run.result).outcome, 'cancelled');
});

test('a cancel after her message went out reports what happened: she spoke', async () => {
  // Bug: a message she already sent reads as cancelled, and the owner sends the line again.
  const abort = new AbortController();
  const run = await coreTurn({
    answers: [toolAnswer('<think>x</think>', [call('message.create', { text: 'ήδη' })]), '<msg>ποτέ</msg>'],
    allowed: ['message.create'],
    runner: {
      cancelOf: () => abort.signal,
      noteProgress: (_id: unknown, step: { detail: string }) => {
        if (step.detail === 'ok') abort.abort();
      },
    },
  });
  assert.deepEqual(texts(run), ['ήδη']);
  assert.equal(asRecord(run.result).outcome, 'spoke');
  assert.equal(run.llm.calls.length, 1);
});

test('a signal aborted before the turn started ends it before any request', async () => {
  // Bug: a cancel that lands while the turn waits for its author still spends a request.
  const abort = new AbortController();
  abort.abort();
  const run = await coreTurn({ answers: ['<msg>γεια</msg>'], runner: { cancelOf: () => abort.signal } });
  assert.equal(asRecord(run.result).outcome, 'cancelled');
  assert.equal(run.llm.calls.length, 0);
});

test('a turn nobody can cancel gets no signal from the control and speaks as before', async () => {
  // Bug: the cancel path changes what a turn of another interface sends.
  const asked: Array<unknown> = [];
  const run = await coreTurn({
    answers: ['<think>t</think><msg>γεια</msg>'],
    runner: {
      cancelOf: (id: unknown) => {
        asked.push(id);
        return null;
      },
    },
  });
  assert.equal(asRecord(run.result).outcome, 'spoke');
  assert.deepEqual(texts(run), ['γεια']);
  assert.equal(asked.length, 1);
});
