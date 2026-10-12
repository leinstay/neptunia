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

test('parseOutput: at most 3 messages are kept, extras are dropped', () => {
  const result = parseOutput('<msg>1</msg><msg>2</msg><msg>3</msg><msg>4</msg>');
  assert.deepEqual(result.messages.map((m) => m.text), ['1', '2', '3']);
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
  const result = parseOutput(
    `<react to="#1">:${name}:</react><react to="#2"><a:${name}:123456789012345678></react>`,
  );
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

test('parseOutput: <draw> yields the scene with defaults', () => {
  const result = parseOutput('<draw> a cat on a windowsill </draw>');
  assert.deepEqual(result.draw, { text: 'a cat on a windowsill', self: false, replyTo: null });
});

test('parseOutput: <draw self="yes" reply="#12"> sets self and replyTo', () => {
  const result = parseOutput('<draw self="yes" reply="#12">a portrait</draw>');
  assert.deepEqual(result.draw, { text: 'a portrait', self: true, replyTo: 12 });
});

test('parseOutput: <draw> attributes work in any order and any case', () => {
  const result = parseOutput('<DRAW Reply="#7" SELF="TRUE">a lake</DRAW>');
  assert.deepEqual(result.draw, { text: 'a lake', self: true, replyTo: 7 });
  assert.equal(parseOutput('<draw self="1">x</draw>').draw.self, true);
  assert.equal(parseOutput('<draw self="no">x</draw>').draw.self, false);
});

test('parseOutput: a second <draw> is ignored', () => {
  const result = parseOutput('<draw>first scene</draw><draw self="yes">second scene</draw>');
  assert.deepEqual(result.draw, { text: 'first scene', self: false, replyTo: null });
});

test('parseOutput: every <draw> is collected into draws, in order; draw stays the first', () => {
  const result = parseOutput('<msg>εδώ</msg><draw self="yes">first scene</draw><draw>   </draw><draw reply="#3">second scene</draw>');
  assert.deepEqual(result.draws, [
    { text: 'first scene', self: true, replyTo: null },
    { text: 'second scene', self: false, replyTo: 3 },
  ]);
  assert.deepEqual(result.draw, result.draws[0]);
});

test('parseOutput: draws holds at most 10 tags, and an answer without <draw> has none', () => {
  const many = Array.from({ length: 12 }, (_, i) => `<draw>scene ${i + 1}</draw>`).join('');
  const result = parseOutput(many);
  assert.equal(result.draws.length, 10);
  assert.equal(result.draws[9].text, 'scene 10');
  assert.deepEqual(parseOutput('<msg>ναι</msg>').draws, []);
  assert.equal(parseOutput('<msg>ναι</msg>').draw, null);
});

test('parseOutput: an empty <draw> is skipped in favour of a later non-empty one', () => {
  const result = parseOutput('<draw>   </draw><draw>a forest</draw>');
  assert.equal(result.draw.text, 'a forest');
});

test('parseOutput: <draw> text is clamped to 1600 chars', () => {
  const result = parseOutput(`<draw>${'a'.repeat(1700)}</draw>`);
  assert.equal(result.draw.text.length, 1600);
});

test('parseOutput: <draw> alone is not a skip and adds no fallback message', () => {
  const result = parseOutput('<draw>a mountain at dawn</draw>');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.reactions, []);
  assert.equal(result.draw.text, 'a mountain at dawn');
});

test('parseOutput: <draw> alongside <msg> keeps both', () => {
  const result = parseOutput('<msg reply="#4">εντάξει</msg><draw reply="#4">a boat</draw>');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, [{ text: 'εντάξει', replyTo: 4 }]);
  assert.deepEqual(result.draw, { text: 'a boat', self: false, replyTo: 4 });
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

test('parseOutput: a <draw> body is capped at 1600 by default, cut at a word boundary', () => {
  const body = 'word '.repeat(400).trim();
  const text = parseOutput(`<draw>${body}</draw>`).draw.text;
  assert.ok(text.length <= 1600 && text.length > 1590);
  assert.ok(text.endsWith('word'));
});

test('parseOutput: maxDrawChars sets the cap and cuts at the last sentence end', () => {
  const result = parseOutput('<draw>Aaaa bbbb. Cccc dddd eeee</draw>', { maxDrawChars: 16 });
  assert.equal(result.draw.text, 'Aaaa bbbb.');
  assert.equal(parseOutput('<draw>άλφα βήτα γάμμα</draw>', { maxDrawChars: 12 }).draw.text, 'άλφα βήτα');
  assert.equal(parseOutput('<draw>abcdefghij</draw>', { maxDrawChars: undefined }).draw.text, 'abcdefghij');
});
