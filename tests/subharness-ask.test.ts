// src/subharness/ask.ts: the answer of a command that asks the owner a question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askAnswer } from '../src/subharness/ask.ts';

test('an ask answer has the status ask, the prompt as its text and the dialog id and choices it was given', () => {
  // Bug: the chat prints an empty line for the question, or cannot tell which dialog an answer belongs to.
  const answer = askAnswer({ dialogId: 'd1', prompt: 'Which model?', choices: ['a', 'b'] });
  assert.equal(answer.status, 'ask');
  assert.equal(answer.text, 'Which model?');
  assert.equal(answer.dialogId, 'd1');
  assert.deepEqual(answer.choices, ['a', 'b']);
});
