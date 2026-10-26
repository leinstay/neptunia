// Tests for src/llm/parse.js: the model output tag parser and JSON extractor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput, parseJsonObject } from '../src/llm/parse.js';

test('parseOutput: a single <msg> with no reply', () => {
  const result = parseOutput('<msg>γεια</msg>');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, [{ text: 'γεια', replyTo: null }]);
  assert.deepEqual(result.reactions, []);
});

test('parseOutput: reply="#87" is parsed as replyTo 87', () => {
  const result = parseOutput('<msg reply="#87">hi</msg>');
  assert.equal(result.messages[0].replyTo, 87);
});

test('parseOutput: reply="87" (no #) is also parsed as replyTo 87', () => {
  const result = parseOutput('<msg reply="87">hi</msg>');
  assert.equal(result.messages[0].replyTo, 87);
});

test('parseOutput: a fourth message is joined into the third on its own line, recorded as message-merge', async () => {
  const { createLimits } = await import('../src/llm/limits.js');
  const limits = createLimits();
  const result = parseOutput('<msg>1</msg><msg>2</msg><msg reply="#7">τρία</msg><msg reply="#9">τέσσερα  ok</msg>', {
    limits,
  });
  assert.deepEqual(result.messages, [
    { text: '1', replyTo: null },
    { text: '2', replyTo: null },
    { text: 'τρία\nτέσσερα  ok', replyTo: 7 },
  ]);
  assert.deepEqual(limits.list(), [{ kind: 'message-merge', where: 'parse', lost: 1 }]);
});

test('parseOutput: messages four and five are joined into the third in order', async () => {
  const { createLimits } = await import('../src/llm/limits.js');
  const limits = createLimits();
  const result = parseOutput('<msg>a</msg><msg>b</msg><msg>c</msg><msg>d\ne</msg><msg>f</msg>', { limits });
  assert.deepEqual(
    result.messages.map((m) => m.text),
    ['a', 'b', 'c\nd\ne\nf']
  );
  assert.deepEqual(limits.list(), [{ kind: 'message-merge', where: 'parse', lost: 2 }]);
  // Without a collector the join is the same.
  assert.deepEqual(
    parseOutput('<msg>a</msg><msg>b</msg><msg>c</msg><msg>d</msg>').messages.map((m) => m.text),
    ['a', 'b', 'c\nd']
  );
});

test('parseOutput: three messages stay as they are, nothing recorded', async () => {
  const { createLimits } = await import('../src/llm/limits.js');
  const limits = createLimits();
  const result = parseOutput('<msg>a</msg><msg reply="#2">b</msg><msg>c</msg>', { limits });
  assert.deepEqual(result.messages, [
    { text: 'a', replyTo: null },
    { text: 'b', replyTo: 2 },
    { text: 'c', replyTo: null },
  ]);
  assert.deepEqual(limits.list(), []);
});

test('parseOutput: a merged message over 1900 characters is cut like any message, the cut recorded', async () => {
  const { createLimits } = await import('../src/llm/limits.js');
  const limits = createLimits();
  const third = 'γ'.repeat(1000);
  const fourth = 'δ'.repeat(1000);
  const result = parseOutput(`<msg>a</msg><msg>b</msg><msg>${third}</msg><msg>${fourth}</msg>`, { limits });
  assert.equal(result.messages[2].text, `${third}\n${'δ'.repeat(899)}`);
  assert.deepEqual(limits.list(), [
    { kind: 'message-merge', where: 'parse', lost: 1 },
    { kind: 'message-cut', where: 'parse', lost: 101 },
  ]);
});

test('parseOutput: <think> is stripped from output and returned separately', () => {
  const result = parseOutput('<think> το σχέδιο </think><msg>γεια</msg>');
  assert.equal(result.think, 'το σχέδιο');
  assert.deepEqual(result.messages, [{ text: 'γεια', replyTo: null }]);
  assert.equal(result.skip, false);
});

test('parseOutput: an unclosed <think> means silence, even with a <msg> after it', () => {
  const result = parseOutput('<think> σχέδιο χωρίς τέλος <msg>αυτό δεν πρέπει να σταλεί</msg>');
  assert.equal(result.skip, true);
  assert.deepEqual(result.messages, []);
});

test('parseOutput: <skip/> alone means silence', () => {
  const rows = [
    ['<skip/>', '<skip/>'],
    ['<skip /> with a space before the slash', '<skip />'],
  ];
  for (const [label, raw] of rows) {
    const result = parseOutput(raw);
    assert.equal(result.skip, true, label);
    assert.deepEqual(result.messages, [], label);
    assert.deepEqual(result.reactions, [], label);
  }
});

test('parseOutput: a reaction alone is not silence', () => {
  const result = parseOutput('<react to="#5">💀</react>');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.reactions, [{ to: 5, emoji: '💀' }]);
});

test('parseOutput: a reaction names its message by to; one naming none is kept apart, not a skip', () => {
  const both = parseOutput('<react to="#5">💀</react>');
  assert.deepEqual(both.reactions, [{ to: 5, emoji: '💀' }]);
  assert.deepEqual(both.untargetedReactions, []);
  assert.deepEqual(parseOutput('<react reply="#6">🔥</react>').untargetedReactions, [{ emoji: '🔥' }]);
  const bare = parseOutput('<react>👍</react>');
  assert.deepEqual(bare.reactions, []);
  assert.deepEqual(bare.untargetedReactions, [{ emoji: '👍' }]);
  assert.equal(bare.skip, false);
  // An empty or too long body is dropped either way.
  const none = parseOutput('<react></react><react>this is way more than sixteen chars</react>');
  assert.deepEqual(none.untargetedReactions, []);
  assert.equal(none.skip, true);
});

test('parseOutput: plain text with no tags falls back to one message when short', () => {
  const result = parseOutput('απλό κείμενο χωρίς ετικέτες');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, [{ text: 'απλό κείμενο χωρίς ετικέτες', replyTo: null }]);
});

test('parseOutput: plain text with no tags falls back to silence when too long', () => {
  const result = parseOutput('α'.repeat(601));
  assert.equal(result.skip, true);
  assert.deepEqual(result.messages, []);
});

test('parseOutput: plain text of exactly the fallback limit still becomes one message', () => {
  const result = parseOutput('α'.repeat(600));
  assert.equal(result.skip, false);
  assert.equal(result.messages.length, 1);
});

test('parseOutput: an emoji reaction longer than 16 chars is dropped', () => {
  const result = parseOutput('<react to="#1">this is way more than sixteen chars</react>');
  assert.deepEqual(result.reactions, []);
  // no messages, no reactions, no other tags -> falls through to skip (leftover text is empty after stripping nothing)
  assert.equal(result.skip, true);
});

test('parseOutput: a custom emoji reaction as :name: or markup is kept past 16 chars', () => {
  const name = 'a_rather_long_custom_emoji_name';
  const result = parseOutput(`<react to="#1">:${name}:</react><react to="#2"><a:${name}:123456789012345678></react>`);
  assert.deepEqual(result.reactions, [
    { to: 1, emoji: `:${name}:` },
    { to: 2, emoji: `<a:${name}:123456789012345678>` },
  ]);
});

test('parseOutput: a long reaction body that is not a custom emoji is still dropped', () => {
  const result = parseOutput('<react to="#1">:not a name at all, too long:</react>');
  assert.deepEqual(result.reactions, []);
});

test('parseOutput: an empty <msg> is ignored, but a later non-empty one is kept', () => {
  const result = parseOutput('<msg>   </msg><msg>πραγματικό μήνυμα</msg>');
  assert.deepEqual(result.messages, [{ text: 'πραγματικό μήνυμα', replyTo: null }]);
});

test('parseOutput: only empty <msg> tags and no reactions results in skip, not a text fallback', () => {
  const result = parseOutput('<msg>   </msg>');
  assert.equal(result.skip, true);
  assert.deepEqual(result.messages, []);
});

test('parseOutput: messages longer than MAX_MESSAGE_CHARS are truncated', () => {
  const result = parseOutput(`<msg>${'a'.repeat(2000)}</msg>`);
  assert.equal(result.messages[0].text.length, 1900);
});

test('parseOutput: <msg> and <react> can appear together', () => {
  const result = parseOutput('<msg>χα</msg><react to="#3">🔥</react>');
  assert.equal(result.messages.length, 1);
  assert.equal(result.reactions.length, 1);
  assert.equal(result.skip, false);
});

test('parseOutput: null/undefined raw input is treated as empty and skipped', () => {
  assert.equal(parseOutput(undefined).skip, true);
  assert.equal(parseOutput(null).skip, true);
});

test('parseJsonObject: extracts the object, bare, inside a code fence or surrounded by chatter', () => {
  const rows = [
    ['a bare JSON object', '{"a": 1, "b": "x"}', { a: 1, b: 'x' }],
    ['JSON inside a code fence', '```json\n{"a": 1}\n```', { a: 1 }],
    ['JSON surrounded by chatter', 'Sure, here you go:\n{"a": 1}\nHope that helps!', { a: 1 }],
  ];
  for (const [label, raw, expected] of rows) {
    assert.deepEqual(parseJsonObject(raw), expected, label);
  }
});

test('parseJsonObject: throws when there is no JSON object at all', () => {
  assert.throws(() => parseJsonObject('no json here'), /no JSON object in the model reply/);
});

test('parse: a message cut at 1900 reports message-cut with the lost length', async () => {
  const { createLimits } = await import('../src/llm/limits.js');
  const limits = createLimits();
  const long = 'α'.repeat(1950);
  const result = parseOutput(`<msg>${long}</msg><msg>short</msg>`, { limits });
  assert.equal(result.messages[0].text.length, 1900);
  assert.equal(result.messages[1].text, 'short');
  assert.deepEqual(limits.list(), [{ kind: 'message-cut', where: 'parse', lost: 50 }]);
  // Without a collector the cut stays as it was.
  assert.equal(parseOutput(`<msg>${long}</msg>`).messages[0].text.length, 1900);
});

// ---- <call>: one skill call at the top level of the output ------------------------------

test('parseOutput: an unclosed <think> keeps what it held so far in think and says it stayed open', () => {
  const result = parseOutput('<think>πρώτο</think><think> σχέδιο χωρίς τέλος ');
  assert.deepEqual([result.skip, result.thinkOpen, result.think], [true, true, 'πρώτο\nσχέδιο χωρίς τέλος']);
  assert.equal(parseOutput('<think>σχέδιο</think><msg>ναι</msg>').thinkOpen, false);
});

test('parseOutput: untagged marks the plain-text fallback message only', () => {
  const plain = parseOutput('<think>σχέδιο</think>ναι, θα έρθω');
  assert.deepEqual([plain.untagged, plain.messages], [true, [{ text: 'ναι, θα έρθω', replyTo: null }]]);
  assert.equal(parseOutput('<msg>ναι</msg>').untagged, false);
  assert.equal(parseOutput('<skip/>').untagged, false);
});

test('parseOutput: a cut message, joined messages and an unclosed <think> are diagnostics', () => {
  const cut = parseOutput(`<msg>${'α'.repeat(1950)}</msg>`);
  assert.deepEqual(cut.diagnostics, [{ kind: 'messageCut', chars: 50 }]);
  const merged = parseOutput('<msg>1</msg><msg>2</msg><msg>3</msg><msg>4</msg><msg>5</msg>');
  assert.deepEqual(merged.diagnostics, [{ kind: 'messagesMerged', count: 2 }]);
  assert.deepEqual(parseOutput('<think>σχέδιο').diagnostics, [{ kind: 'thinkUnclosed' }]);
  assert.deepEqual(parseOutput('<think>σχέδιο</think><msg>ναι</msg>').diagnostics, []);
});

test('parseOutput: a <call> or a <draw> outside code is a retired tag: cut out, told, never read, never posted as text', () => {
  const parsed = parseOutput(
    '<think>x</think><msg>hello</msg><call skill="message.create">hi</call><draw self="yes">a boat</draw>'
  );
  assert.deepEqual(parsed.messages, [{ text: 'hello', replyTo: null }]);
  assert.equal('draw' in parsed, false);
  assert.deepEqual(parsed.diagnostics, [
    { kind: 'retiredTag', tag: 'call' },
    { kind: 'retiredTag', tag: 'draw' },
  ]);
  assert.equal('call' in parsed, false);
  const alone = parseOutput('<call skill="status.show"/>');
  assert.equal(alone.skip, true);
  assert.deepEqual(alone.messages, []);
  assert.deepEqual(alone.diagnostics, [{ kind: 'retiredTag', tag: 'call' }]);
});

test('parseOutput: a retired tag inside a message is cut out of it; in code it stays as typed and is not told', () => {
  const inside = parseOutput('<msg>look <call skill="a.b">x</call>here</msg>');
  assert.equal(inside.messages[0].text, 'look here');
  assert.deepEqual(inside.diagnostics, [{ kind: 'retiredTag', tag: 'call' }]);
  const code = parseOutput('<msg>write `<call skill="a.b"/>` like that</msg>');
  assert.equal(code.messages[0].text, 'write `<call skill="a.b"/>` like that');
  assert.deepEqual(code.diagnostics, []);
});

test('parseOutput: a draw tag alone is cut out and is no plain-text fallback; nor is a <tool_call>', () => {
  const retired = parseOutput('<draw>a boat</draw>');
  assert.equal(retired.skip, true);
  assert.deepEqual(retired.messages, []);
  assert.deepEqual(retired.diagnostics, [{ kind: 'retiredTag', tag: 'draw' }]);
  assert.equal(parseOutput('<tool_call>{"name":"x"}</tool_call>').skip, true);
});
