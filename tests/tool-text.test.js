// Tests for src/llm/tool-text.js: the text transport's tool description and the parser of the
// <tool_call> blocks a model without native tools writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/index.ts';
import { buildSkills } from '../src/tools/registry.ts';
import { SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { buildTools } from '../src/tools/tools-json.ts';
import { parseToolCallBlocks, toolsBlockText } from '../src/llm/tool-text.js';

const block = (json) => `<tool_call>${typeof json === 'string' ? json : JSON.stringify(json)}</tool_call>`;

test('parseToolCallBlocks: a top-level block is a call, the rest is the text without it', () => {
  const { calls, rest, diagnostics } = parseToolCallBlocks(
    `<think>plan</think>\n${block({ name: 'draw.create', arguments: { text: 'a cat', self: true } })}\n<msg>here</msg>`
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    id: null,
    name: 'draw.create',
    arguments: '{"text":"a cat","self":true}',
    parsed: { text: 'a cat', self: true },
    parseError: null,
  });
  assert.equal(rest, '<think>plan</think>\n\n<msg>here</msg>');
  assert.deepEqual(diagnostics, []);
});

test('parseToolCallBlocks: several blocks in order; text without blocks is returned as it is', () => {
  const text = `a ${block({ name: 'web.search', arguments: { query: 'x' } })} b ${block({ name: 'task.status' })} c`;
  const { calls, rest } = parseToolCallBlocks(text);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['web.search', 'task.status']
  );
  assert.deepEqual(calls[1].parsed, {});
  assert.equal(rest, 'a  b  c');
  assert.deepEqual(parseToolCallBlocks('<msg>hi</msg>'), { calls: [], rest: '<msg>hi</msg>', diagnostics: [] });
  assert.deepEqual(parseToolCallBlocks(undefined), { calls: [], rest: '', diagnostics: [] });
});

test('parseToolCallBlocks: arguments may be a JSON string holding an object; anything else is malformed', () => {
  const asString = parseToolCallBlocks(block({ name: 'draw.create', arguments: '{"text":"a"}' })).calls[0];
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
    const [call] = parseToolCallBlocks(block(typeof bad === 'string' ? bad : bad)).calls;
    assert.equal(call.parseError, 'malformed', JSON.stringify(bad));
    assert.equal(call.parsed, null);
  }
});

test('parseToolCallBlocks: a block inside a <msg> is cut out of the message and marked nested', () => {
  const text = `<msg>before ${block({ name: 'draw.create', arguments: { text: 'x' } })} after</msg><msg>fine</msg>`;
  const { calls, rest, diagnostics } = parseToolCallBlocks(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parseError, 'nested');
  assert.equal(calls[0].name, 'draw.create');
  assert.equal(rest, '<msg>before  after</msg><msg>fine</msg>');
  assert.deepEqual(diagnostics, [{ kind: 'nested', index: 0 }]);
});

test('parseToolCallBlocks: an unclosed block is truncated at the length limit and unclosed otherwise', () => {
  const text = '<msg>hi</msg><tool_call>{"name": "draw.create", "argum';
  const cut = parseToolCallBlocks(text, { finishReason: 'length' });
  assert.equal(cut.calls[0].parseError, 'truncated');
  assert.equal(cut.rest, '<msg>hi</msg>');
  assert.equal(parseToolCallBlocks(text, { finishReason: 'stop' }).calls[0].parseError, 'unclosed');
  assert.deepEqual(parseToolCallBlocks(text).diagnostics, [{ kind: 'unclosed', index: 0 }]);
});

test('parseToolCallBlocks: a block inside an unclosed <think> is never seen, one after a closed think is', () => {
  const inside = `<think>I could ${block({ name: 'draw.create', arguments: {} })} but`;
  assert.deepEqual(parseToolCallBlocks(inside), { calls: [], rest: inside, diagnostics: [] });
  const closed = `<think>${block({ name: 'web.search', arguments: {} })}</think>${block({ name: 'task.status' })}`;
  const out = parseToolCallBlocks(closed);
  assert.deepEqual(
    out.calls.map((c) => c.name),
    ['task.status']
  );
  assert.equal(out.rest, `<think>${block({ name: 'web.search', arguments: {} })}</think>`);
});

test('parseToolCallBlocks: a block in a code fence or an inline code span is text, not a call', () => {
  const one = block({ name: 'draw.create', arguments: { text: 'x' } });
  const fenced = `Example:\n\`\`\`\n${one}\n\`\`\`\nand \`${one}\` too`;
  assert.deepEqual(parseToolCallBlocks(fenced), { calls: [], rest: fenced, diagnostics: [] });
  const real = parseToolCallBlocks(`\`\`\`\n${one}\n\`\`\`\n${block({ name: 'task.status' })}`);
  assert.deepEqual(
    real.calls.map((c) => c.name),
    ['task.status']
  );
});

test('parseToolCallBlocks: backticks inside a call body do not hide the closing tag', () => {
  const { calls, rest } = parseToolCallBlocks(`${block({ name: 'draw.create', arguments: { text: 'a `b` c' } })}tail`);
  assert.equal(calls[0].parsed.text, 'a `b` c');
  assert.equal(rest, 'tail');
});

test('toolsBlockText: lead, one canonical JSON line per tool with the dotted name, sorted, then the protocol', () => {
  const registry = buildSkills({ table: SKILL_DEFINITIONS });
  const tools = buildTools(['web.search', 'draw.create'], { registry, texts: { 'web.search': { title: 'Search' } } });
  const labels = { skills: { toolsText: { lead: 'LEAD', protocol: 'PROTOCOL' } } };
  const lines = toolsBlockText(tools, labels).split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'LEAD');
  assert.equal(lines[3], 'PROTOCOL');
  const [draw, search] = [JSON.parse(lines[1]), JSON.parse(lines[2])];
  assert.equal(draw.name, 'draw.create');
  assert.equal(search.name, 'web.search');
  assert.equal(search.description, 'Search');
  assert.deepEqual(Object.keys(draw), ['description', 'name', 'parameters']);
  assert.equal(toolsBlockText([...tools].reverse(), labels), toolsBlockText(tools, labels));
  assert.equal(toolsBlockText([], labels), '');
  assert.equal(toolsBlockText(tools, {}).split('\n').length, 2);
});
