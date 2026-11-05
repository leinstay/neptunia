// A model sometimes writes a tool call as text with attributes, and what reaches the parser is a name such as
// `media_look" tool_id="media1`. A name with a quote or a space is no tool: the call is refused as malformed with a
// result she reads, and the broken name never goes back to the provider or into a result's attributes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/index.ts';
import { appendStep } from '../src/behavior/tool-step.ts';
import { toolCallsOf } from '../src/llm/openrouter.ts';
import { parseToolCallBlocks } from '../src/llm/tool-text.ts';
import { SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { buildSkills } from '../src/tools/registry.ts';
import { normalizeCalls, toolResultText } from '../src/tools/tool-calls.ts';
import { labels } from './fixtures/labels.ts';

const registry = buildSkills({ table: SKILL_DEFINITIONS });
// What a provider's tool-call schema takes for a function name.
const PROVIDER_NAME = /^[a-zA-Z0-9_.-]+$/;
const QUOTED = 'media_look" tool_id="media1';
const SPACED = 'media look';

const native = (name: string) =>
  normalizeCalls({
    calls: toolCallsOf([{ id: 'c1', function: { name, arguments: '{"url":"https://example.org/a.png"}' } }]),
    registry,
    step: 1,
  });

for (const broken of [QUOTED, SPACED]) {
  test(`a native call named ${JSON.stringify(broken)} is refused as malformed, not looked up as a skill`, () => {
    // Bug: it reads as `unknown-skill` and her result names the broken text back as if it were a tool she could call.
    const [call] = native(broken);
    assert.equal(call?.problem, 'malformed-call');
    // The ordinary case keeps its own answer: she still hears that a tool does not exist.
    assert.equal(native('media_lookup')[0]?.problem, 'unknown-skill');
  });

  test(`the step after a native call named ${JSON.stringify(broken)} goes back with a name the provider takes`, () => {
    // Bug: the assistant message repeats the broken name, the provider answers 400, and the whole turn is lost.
    const calls = native(broken);
    const text = toolResultText({ status: 'invalid', code: calls[0]?.problem }, labels);
    assert.notEqual(text, '');
    const messages = appendStep({
      transport: 'native',
      messages: [],
      calls,
      results: [{ text, status: 'invalid' }],
    });
    const sent = (messages[0]?.tool_calls as Array<{ function: { name: string } }> | undefined)?.[0]?.function.name;
    assert.match(String(sent), PROVIDER_NAME);
    assert.equal(messages[1]?.role, 'tool');
    assert.equal(messages[1]?.content, text, 'she reads the refusal');
  });
}

test('a text call named with a quote is refused, and the broken name opens no attribute in its result', () => {
  // Bug: `<tool_result name="media_look" tool_id="media1">` carries an attribute the model made up into her context.
  const { calls: parsed } = parseToolCallBlocks(
    `<tool_call>${JSON.stringify({ name: QUOTED, arguments: { url: 'https://example.org/a.png' } })}</tool_call>`
  );
  const calls = normalizeCalls({ calls: parsed, transport: 'text', registry, step: 1 });
  assert.equal(calls[0]?.problem, 'malformed-call');
  const messages = appendStep({
    transport: 'text',
    messages: [],
    rawText: 'asked',
    calls,
    results: [{ text: 'refused', status: 'invalid' }],
  });
  const part = JSON.stringify(messages[1]?.content);
  assert.equal(part.includes('tool_id='), false, part);
});
