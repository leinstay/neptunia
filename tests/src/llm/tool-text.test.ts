// Tests for src/llm/tool-text.ts: the parser of the <tool_call> blocks a stored answer wrote into its text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCallBlocks } from '../../../src/llm/tool-text.ts';

const block = (json: unknown) => `<tool_call>${typeof json === 'string' ? json : JSON.stringify(json)}</tool_call>`;

test('parseToolCallBlocks: a block is a call with its name and arguments', () => {
  const calls = parseToolCallBlocks(
    `<think>plan</think>\n${block({ name: 'draw.create', arguments: { text: 'a cat', self: true } })}\n<msg>here</msg>`
  );
  assert.deepEqual(calls, [
    {
      id: null,
      name: 'draw.create',
      arguments: '{"text":"a cat","self":true}',
      parsed: { text: 'a cat', self: true },
      parseError: null,
    },
  ]);
});

test('parseToolCallBlocks: several blocks in order; text without blocks has no call', () => {
  const text = `a ${block({ name: 'web.search', arguments: { query: 'x' } })} b ${block({ name: 'errand.list' })} c`;
  const calls = parseToolCallBlocks(text);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['web.search', 'errand.list']
  );
  assert.deepEqual(calls[1].parsed, {});
  assert.deepEqual(parseToolCallBlocks('<msg>hi</msg>'), []);
  // @ts-expect-error: the test passes the absent text the type forbids
  assert.deepEqual(parseToolCallBlocks(undefined), []);
});

test('parseToolCallBlocks: arguments may be a JSON string holding an object; anything else is malformed', () => {
  const [asString] = parseToolCallBlocks(block({ name: 'draw.create', arguments: '{"text":"a"}' }));
  assert.deepEqual(asString.parsed, { text: 'a' });
  assert.equal(asString.parseError, null);
  for (const bad of [
    { name: 'draw.create', arguments: 'not json' },
    { name: 'draw.create', arguments: '[1]' },
    { name: 'draw.create', arguments: 5 },
    { name: 'draw.create', arguments: [1] },
    { arguments: {} },
    { name: 3, arguments: {} },
    [1],
    'plain words',
  ]) {
    const [call] = parseToolCallBlocks(block(bad));
    assert.equal(call.parseError, 'malformed', JSON.stringify(bad));
    assert.equal(call.parsed, null);
  }
});

test('parseToolCallBlocks: an unclosed block runs to the end and is unclosed', () => {
  const calls = parseToolCallBlocks('<msg>hi</msg><tool_call>{"name": "draw.create", "argum');
  assert.deepEqual(
    calls.map((c) => [c.parseError, c.arguments]),
    [['unclosed', '{"name": "draw.create", "argum']]
  );
});

test('parseToolCallBlocks: a block inside an unclosed <think> is never seen, one after a closed think is', () => {
  assert.deepEqual(parseToolCallBlocks(`<think>I could ${block({ name: 'draw.create', arguments: {} })} but`), []);
  const closed = `<think>${block({ name: 'web.search', arguments: {} })}</think>${block({ name: 'errand.list' })}`;
  assert.deepEqual(
    parseToolCallBlocks(closed).map((c) => c.name),
    ['errand.list']
  );
});

test('parseToolCallBlocks: a block in a code fence or an inline code span is text, not a call', () => {
  const one = block({ name: 'draw.create', arguments: { text: 'x' } });
  assert.deepEqual(parseToolCallBlocks(`Example:\n\`\`\`\n${one}\n\`\`\`\nand \`${one}\` too`), []);
  assert.deepEqual(
    parseToolCallBlocks(`\`\`\`\n${one}\n\`\`\`\n${block({ name: 'errand.list' })}`).map((c) => c.name),
    ['errand.list']
  );
});

test('parseToolCallBlocks: backticks inside a call body do not hide the closing tag', () => {
  const calls = parseToolCallBlocks(
    `${block({ name: 'draw.create', arguments: { text: 'a `b` c' } })}${block({ name: 'errand.list' })}`
  );
  assert.deepEqual(
    calls.map((c) => [c.name, (c.parsed as { text?: string } | null)?.text]),
    [
      ['draw.create', 'a `b` c'],
      ['errand.list', undefined],
    ]
  );
});
