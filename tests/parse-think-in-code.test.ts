// A think tag in the text of an answer is never acted on as her thinking when it stands in code, and no think tag ever
// reaches a message (docs/prompt-contract.md: a think tag inside a message or a code span counts as broken). The think
// of the answer is stripped before the code spans are known, so a whole `<think>` written as an example in code is taken
// for her own thinking and cut out of the words. The code check comes first: such an answer is a broken think, with no
// action, and nothing of it moves into `think`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput } from '../src/llm/parse.ts';

test('a whole think tag in an inline code span is a broken think, not part of her thinking', () => {
  const parsed = parseOutput('<think>plan</think><msg>write `<think>b</think>` for a note</msg>');
  assert.deepEqual([parsed.thinkLeak === null, parsed.skip, parsed.messages], [false, true, []]);
});

test('a whole think tag in a fenced block is a broken think, not part of her thinking', () => {
  const parsed = parseOutput('<think>plan</think><msg>see\n```\n<think>b</think>\n```\n</msg>');
  assert.deepEqual([parsed.thinkLeak === null, parsed.skip, parsed.messages], [false, true, []]);
});
