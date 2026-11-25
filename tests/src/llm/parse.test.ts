// Tests for src/llm/parse.ts: the model output tag parser and JSON extractor.
import { test, beforeEach, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput, parseJsonObject, takeAudience, shapedThink, hasThinkTag } from '../../../src/llm/parse.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { freshWorld, world, useIface } from '../../fixtures/turn-world.ts';
import {
  NOW,
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from '../../fixtures/turn-kit.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { NOW as BOUNDARY_NOW, coreTurn, contentText } from '../../fixtures/turn-harness.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import type { FakeLlm } from '../../fixtures/turn-harness.ts';

test('parseOutput: a single <msg> with no reply', () => {
  const result = parseOutput('<msg>γεια</msg>');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, [{ text: 'γεια', replyTo: null }]);
  assert.deepEqual(result.reactions, []);
});

test('parseOutput: reply="#87" is parsed as replyTo 87', () => {
  const result = parseOutput('<msg reply="#87">hi</msg>');
  const [message] = result.messages;
  assert.equal(message.replyTo, 87);
});

test('parseOutput: reply="87" (no #) is also parsed as replyTo 87', () => {
  const result = parseOutput('<msg reply="87">hi</msg>');
  const [message] = result.messages;
  assert.equal(message.replyTo, 87);
});

test('parseOutput: a fourth message is joined into the third on its own line, recorded as message-merge', async () => {
  const { createLimits } = await import('../../../src/llm/limits.ts');
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
  const { createLimits } = await import('../../../src/llm/limits.ts');
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
  const { createLimits } = await import('../../../src/llm/limits.ts');
  const limits = createLimits();
  const result = parseOutput('<msg>a</msg><msg reply="#2">b</msg><msg>c</msg>', { limits });
  assert.deepEqual(result.messages, [
    { text: 'a', replyTo: null },
    { text: 'b', replyTo: 2 },
    { text: 'c', replyTo: null },
  ]);
  assert.deepEqual(limits.list(), []);
});

// The parser cuts no message; the adapter splits it for the platform. The third and later messages are merged, and
// only the merge is reported.
test('parseOutput: a merged message over 1900 characters stays whole, only the merge recorded', async () => {
  const { createLimits } = await import('../../../src/llm/limits.ts');
  const limits = createLimits();
  const third = 'γ'.repeat(1000);
  const fourth = 'δ'.repeat(1000);
  const result = parseOutput(`<msg>a</msg><msg>b</msg><msg>${third}</msg><msg>${fourth}</msg>`, { limits });
  const merged = result.messages[2];
  assert.equal(merged.text, `${third}\n${fourth}`);
  assert.deepEqual(limits.list(), [{ kind: 'message-merge', where: 'parse', lost: 1 }]);
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

// Text outside the tags is never sent.
test('parseOutput: short plain text with no tags is no message and stays in bare', () => {
  const result = parseOutput('απλό κείμενο χωρίς ετικέτες');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, []);
  assert.equal(result.bare, 'απλό κείμενο χωρίς ετικέτες');
});

// Text outside the tags is never sent.
test('parseOutput: plain text with no tags that is too long is no message either, and no silence', () => {
  const result = parseOutput('α'.repeat(601));
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, []);
  assert.equal(result.bare, 'α'.repeat(601));
});

// Text outside the tags is never sent.
test('parseOutput: plain text of exactly the old fallback limit is no message', () => {
  const result = parseOutput('α'.repeat(600));
  assert.equal(result.skip, false);
  assert.equal(result.messages.length, 0);
});

// ---- text outside the tags is never a message ----

test('parseOutput: a think and two sentences with no tag give no message, the sentences in bare and one diagnostic', () => {
  // Bug: the fallback posts the persona's working words in the chat.
  const sentences = 'ετοιμάζω πρώτα την εικόνα. έπειτα γράφω στον κήπο.';
  const parsed = parseOutput(`<think>σχέδιο</think>${sentences}`);
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.untagged, true);
  assert.equal(parsed.bare, sentences);
  assert.deepEqual(parsed.diagnostics, [{ kind: 'bareText', chars: sentences.length }]);
  assert.equal(parsed.skip, false);
});

test('parseOutput: a text of 5000 characters with no tag has the same shape as a short one', () => {
  // Bug: the old 600-character limit stays behind and a long answer is told apart from a short one.
  const long = 'λέξη '.repeat(1000).trim();
  const parsed = parseOutput(long);
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.untagged, true);
  assert.equal(parsed.bare, long);
  assert.deepEqual(parsed.diagnostics, [{ kind: 'bareText', chars: long.length }]);
  assert.equal(parsed.skip, false);
});

test('parseOutput: a <msg> with words around it gives the message and no bareText diagnostic', () => {
  // Bug: tags beside bare text are held back, or the words around them are counted as a lost answer.
  const parsed = parseOutput('<think>σχέδιο</think>πριν <msg>ναι</msg> μετά');
  assert.deepEqual(parsed.messages, [{ text: 'ναι', replyTo: null }]);
  assert.equal(parsed.untagged, false);
  assert.equal(parsed.bare, '');
  assert.equal(
    parsed.diagnostics.some((diagnostic) => diagnostic.kind === 'bareText'),
    false
  );
});

for (const [name, raw] of [
  ['<skip/> alone', '<skip/>'],
  ['an empty answer', ''],
  ['a think and nothing else', '<think>σχέδιο</think>'],
] as const) {
  test(`parseOutput: ${name} is a skip with no bare text`, () => {
    // Bug: silence is read as bare text and the persona is told their words were not posted when they wrote none.
    const parsed = parseOutput(raw);
    assert.equal(parsed.skip, true);
    assert.equal(parsed.bare, '');
    assert.equal(parsed.untagged, false);
    assert.deepEqual(parsed.diagnostics, []);
  });
}

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

// The core cuts no text of a message.
test('parseOutput: a 2000-character message comes out whole', () => {
  const result = parseOutput(`<msg>${'a'.repeat(2000)}</msg>`);
  const [message] = result.messages;
  assert.equal(message.text.length, 2000);
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
  const rows: Array<[string, string, unknown]> = [
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

// Nothing is cut at parse time, so no `message-cut` is reported for a long message.
test('parse: a message of 1950 characters comes out whole and reports no message-cut', async () => {
  const { createLimits } = await import('../../../src/llm/limits.ts');
  const limits = createLimits();
  const long = 'α'.repeat(1950);
  const result = parseOutput(`<msg>${long}</msg><msg>short</msg>`, { limits });
  const [first, second] = result.messages;
  assert.equal(first.text, long);
  assert.equal(second.text, 'short');
  assert.deepEqual(limits.list(), []);
});

// ---- <call>: one skill call at the top level of the output ------------------------------

test('parseOutput: an unclosed <think> keeps what it held so far in think and says it stayed open', () => {
  const result = parseOutput('<think>πρώτο</think><think> σχέδιο χωρίς τέλος ');
  assert.deepEqual([result.skip, result.thinkOpen, result.think], [true, true, 'πρώτο\nσχέδιο χωρίς τέλος']);
  assert.equal(parseOutput('<think>σχέδιο</think><msg>ναι</msg>').thinkOpen, false);
});

// Text outside the tags is never sent.
test('parseOutput: untagged marks an answer of bare text only, which carries no message', () => {
  const plain = parseOutput('<think>σχέδιο</think>ναι, θα έρθω');
  assert.deepEqual([plain.untagged, plain.messages, plain.bare], [true, [], 'ναι, θα έρθω']);
  assert.equal(parseOutput('<msg>ναι</msg>').untagged, false);
  assert.equal(parseOutput('<skip/>').untagged, false);
});

// A long message is not cut, so it leaves no `messageCut` diagnostic.
test('parseOutput: a long message is no diagnostic, joined messages and an unclosed <think> are', () => {
  const long = parseOutput(`<msg>${'α'.repeat(1950)}</msg>`);
  assert.deepEqual(long.diagnostics, []);
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
  const alone = parseOutput('<call skill="memory.search"/>');
  assert.equal(alone.skip, true);
  assert.deepEqual(alone.messages, []);
  assert.deepEqual(alone.diagnostics, [{ kind: 'retiredTag', tag: 'call' }]);
});

test('parseOutput: a retired tag inside a message is cut out of it; in code it stays as typed and is not told', () => {
  const inside = parseOutput('<msg>look <call skill="a.b">x</call>here</msg>');
  const [insideMessage] = inside.messages;
  assert.equal(insideMessage.text, 'look here');
  assert.deepEqual(inside.diagnostics, [{ kind: 'retiredTag', tag: 'call' }]);
  const code = parseOutput('<msg>write `<call skill="a.b"/>` like that</msg>');
  const [codeMessage] = code.messages;
  assert.equal(codeMessage.text, 'write `<call skill="a.b"/>` like that');
  assert.deepEqual(code.diagnostics, []);
});

test('parseOutput: a draw tag alone is cut out and is no plain-text fallback; nor is a <tool_call>', () => {
  const retired = parseOutput('<draw>a boat</draw>');
  assert.equal(retired.skip, true);
  assert.deepEqual(retired.messages, []);
  assert.deepEqual(retired.diagnostics, [{ kind: 'retiredTag', tag: 'draw' }]);
  assert.equal(parseOutput('<tool_call>{"name":"x"}</tool_call>').skip, true);
});

test('takeAudience leaves a tag inside a think block or code where it stands', () => {
  // Catches: an audience the persona only thought about, or quoted, restricting the entry or failing it closed.
  const raw = '<think><audience>place:x</audience></think><msg>`<audience>place:y</audience>`</msg>';
  assert.deepEqual(takeAudience(raw), { text: raw, audience: [] });
});

test('takeAudience reads a tag left open as an empty body', () => {
  // Catches: an unclosed tag posted as text and read as no restriction, which publishes what the persona meant to hold back.
  assert.deepEqual(takeAudience('<audience>place:x<msg>hi</msg>'), { text: 'place:x<msg>hi</msg>', audience: [''] });
});

// The `<react>` boundary of the output contract (src/llm/parse.ts#parseOutput), the way #567 gave `<msg>` one: a reaction
// is the emoji between its own tags and nothing else. A tag of another action never lands in the emoji, a reaction's tag
// never lands in a message, an opening `<react>` while another is open ends that one there, and a tag example in code
// is text, never an action.

test('a message inside a reaction stays a message and the emoji is the emoji alone', () => {
  const parsed = parseOutput('<react to="#5">🔥<msg>hello</msg></react>');
  assert.deepEqual(parsed.reactions, [{ to: 5, emoji: '🔥' }]);
  assert.deepEqual(parsed.messages, [{ text: 'hello', replyTo: null }]);
});

test('a reaction written inside a message acts and is not sent as the message words', () => {
  const parsed = parseOutput('<msg>hello <react to="#5">🔥</react></msg>');
  assert.deepEqual(parsed.reactions, [{ to: 5, emoji: '🔥' }]);
  assert.deepEqual(parsed.messages, [{ text: 'hello', replyTo: null }]);
});

test('an opening <react> inside an open reaction ends it there, so the inner reaction acts', () => {
  const parsed = parseOutput('<react to="#1"><react to="#2">🔥</react>');
  assert.deepEqual(parsed.reactions, [{ to: 2, emoji: '🔥' }]);
});

test('a reaction example in code is no reaction and stays in the message as typed', () => {
  const parsed = parseOutput('<msg>type `<react to="#5">🔥</react>` to react</msg>');
  assert.deepEqual(parsed.reactions, []);
  assert.deepEqual(parsed.messages, [{ text: 'type `<react to="#5">🔥</react>` to react', replyTo: null }]);
});

// A think tag in the text of an answer is never acted on as the persona's thinking when it stands in code, and no think tag ever
// reaches a message (docs/prompt-contract.md: a think tag inside a message or a code span counts as broken). The think
// of the answer is stripped before the code spans are known, so a whole `<think>` written as an example in code is taken
// for the persona's own thinking and cut out of the words. The code check comes first: such an answer is a broken think, with no
// action, and nothing of it moves into `think`.

test("a whole think tag in an inline code span is a broken think, not part of the persona's thinking", () => {
  const parsed = parseOutput('<think>plan</think><msg>write `<think>b</think>` for a note</msg>');
  assert.deepEqual([parsed.thinkLeak === null, parsed.skip, parsed.messages], [false, true, []]);
});

test("a whole think tag in a fenced block is a broken think, not part of the persona's thinking", () => {
  const parsed = parseOutput('<think>plan</think><msg>see\n```\n<think>b</think>\n```\n</msg>');
  assert.deepEqual([parsed.thinkLeak === null, parsed.skip, parsed.messages], [false, true, []]);
});

// The output standard at the parser (docs/prompt-contract.md): an answer whose `<think>` is broken
// comes out with no action at all and names its shape in `thinkLeak`, so the turn can ask again and nothing of it is
// sent. Nothing edits the persona's words, so the parser never repairs such an answer: it drops it whole. `shapedThink` gives a
// reply with text and no `<think>` the empty one every stored reply carries. Synthetic text only.

const TAG = /<\s*\/?\s*think\b/i;
const BROKEN: ReadonlyArray<readonly [string, 'unopened' | 'unclosed']> = [
  ['<think >σχέδιο', 'unclosed'],
  ['<think >σχέδιο</think >γεια', 'unclosed'],
  ['σχέδιο</think >γεια', 'unopened'],
  ['σχέδιο</THINK>γεια', 'unopened'],
  ['<THINK>σχέδιο', 'unclosed'],
  ['<think/>γεια', 'unclosed'],
  ['<msg>γεια </think>κόσμε</msg>', 'unopened'],
  ['<msg>γεια <think>κόσμε</msg>', 'unclosed'],
  ['<msg>γεια</msg><think>', 'unclosed'],
  ['<msg>use `<think>` here</msg>', 'unclosed'],
];

// Bug: an answer that began inside its thinking posts its message as if nothing were wrong.
test('an answer that closes a think it never opened has no action and names the shape', () => {
  const parsed = parseOutput('σχέδιο της απάντησης</think><msg>γεια</msg>');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.skip, true);
  assert.equal(parsed.thinkLeak, 'unopened');
  assert.deepEqual(parsed.diagnostics, [{ kind: 'thinkUnopened' }]);
});

// Bug: the plain-text fallback posts the thinking with its closing tag in the chat.
test('plain text with a closing think tag never falls back to a message', () => {
  const parsed = parseOutput('σχέδιο</think>γεια σου');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.untagged, false);
  assert.equal(parsed.thinkLeak, 'unopened');
});

// Bug: the reaction of a broken answer still lands, so the answer is not dropped whole.
test('an answer with a stray closing think loses its reactions too', () => {
  const parsed = parseOutput('σχέδιο</think><react to="#3">🔥</react><react>🔥</react>');
  assert.deepEqual(parsed.reactions, []);
  assert.deepEqual(parsed.untargetedReactions, []);
  assert.equal(parsed.thinkLeak, 'unopened');
});

// Bug: a whole think hides a second, stray closing tag later in the answer.
test('a closing think after a whole think is still a leak', () => {
  const parsed = parseOutput('<think>σχέδιο</think><msg>γεια</msg></think>');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.thinkLeak, 'unopened');
});

// Bug: the caller cannot tell an unclosed think from a chosen silence, so it never asks again.
test('a think never closed names the shape and keeps the old silence', () => {
  const parsed = parseOutput('<think>σχέδιο <msg>χαμένο</msg>');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.skip, true);
  assert.equal(parsed.thinkOpen, true);
  assert.equal(parsed.thinkLeak, 'unclosed');
});

// Bug: every ordinary answer reads as a leak and each turn is asked twice.
test('a whole think and an answer with no think are no leak', () => {
  const whole = parseOutput('<think>σχέδιο</think><msg>γεια</msg>');
  assert.equal(whole.thinkLeak, null);
  assert.deepEqual(
    whole.messages.map((message) => message.text),
    ['γεια']
  );
  const none = parseOutput('<msg>γεια</msg>');
  assert.equal(none.thinkLeak, null);
  assert.deepEqual(
    none.messages.map((message) => message.text),
    ['γεια']
  );
});

for (const [raw, shape] of BROKEN) {
  // Bug: a spelling the parser's two patterns miss goes out with the tag in the chat.
  test(`no outgoing text holds a think tag for: ${raw}`, () => {
    const parsed = parseOutput(raw);
    for (const message of parsed.messages) assert.equal(TAG.test(message.text), false, message.text);
    assert.equal(parsed.thinkLeak, shape);
  });
}

// Bug: the reply with no think is stored in a different shape from every other reply.
test('shapedThink puts an empty think in front of a reply with text and no think', () => {
  assert.equal(shapedThink('<msg>γεια</msg>'), '<think></think><msg>γεια</msg>');
});

// Bug: leading white space makes a reply that has its think look like one that has none.
test('shapedThink leaves a reply that opens with its think as it is', () => {
  assert.equal(shapedThink('<think>σχέδιο</think><msg>γεια</msg>'), '<think>σχέδιο</think><msg>γεια</msg>');
  assert.equal(shapedThink('\n  <think>σχέδιο</think><msg>γεια</msg>'), '\n  <think>σχέδιο</think><msg>γεια</msg>');
});

// Bug: a tool-only answer with no text is stored as if the persona had written an empty reply.
test('shapedThink leaves an answer with no text empty', () => {
  assert.equal(shapedThink(''), '');
  assert.equal(shapedThink('  \n'), '  \n');
});

// Bug: the empty think makes a leaked answer look balanced to whatever reads it next.
test('shapedThink never repairs a broken answer', () => {
  assert.equal(shapedThink('σχέδιο</think><msg>γεια</msg>'), 'σχέδιο</think><msg>γεια</msg>');
  assert.equal(shapedThink('<think>σχέδιο'), '<think>σχέδιο');
});

// The second spelling of the persona's thinking: `<thinking>…</thinking>` is read
// exactly as `<think>…</think>`. A block opened in one spelling and closed in the other, a lone tag of the second
// spelling and the tag in code are broken the way a broken `<think>` is. Synthetic text only.

const isBareText = (diagnostic: { kind: string }): boolean => diagnostic.kind === 'bareText';

test('parseOutput: an answer that is one <thinking> block keeps its text as think and is no bare text', () => {
  // Catches: the block read as text outside every tag, so the think is lost and the persona is told their words were not posted.
  const parsed = parseOutput('<thinking> πρώτα διαβάζω τον κατάλογο </thinking>');
  assert.equal(parsed.think, 'πρώτα διαβάζω τον κατάλογο');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.untagged, false);
  assert.equal(parsed.bare, '');
  assert.equal(parsed.diagnostics.some(isBareText), false);
});

test('parseOutput: a <thinking> block alone is a skip with no diagnostic, as a <think> block alone is', () => {
  // Catches: the second spelling read as a different shape from the first, so a think-only answer is asked once more.
  const parsed = parseOutput('<thinking>σχέδιο</thinking>');
  assert.equal(parsed.skip, true);
  assert.equal(parsed.thinkLeak, null);
  assert.deepEqual(parsed.diagnostics, []);
});

test('parseOutput: a <thinking> block before a <msg> gives the message as written and the block as think', () => {
  // Catches: the block kept as words beside the message, or the message cut where the block ends.
  const parsed = parseOutput('<thinking>θα απαντήσω σύντομα</thinking><msg>ναι, έρχομαι</msg>');
  assert.equal(parsed.think, 'θα απαντήσω σύντομα');
  assert.deepEqual(parsed.messages, [{ text: 'ναι, έρχομαι', replyTo: null }]);
  assert.equal(parsed.thinkLeak, null);
});

for (const raw of ['<thinking>σχέδιο</think><msg>γεια</msg>', '<think>σχέδιο</thinking><msg>γεια</msg>']) {
  test(`parseOutput: a think opened in one spelling and closed in the other is broken: ${raw}`, () => {
    // Catches: two different tags paired as one whole think, so a malformed answer posts its message.
    const parsed = parseOutput(raw);
    assert.equal(parsed.skip, true);
    assert.deepEqual(parsed.messages, []);
    assert.equal(parsed.thinkLeak, 'unclosed');
    assert.deepEqual(parsed.diagnostics, [{ kind: 'thinkUnclosed' }]);
  });
}

test('parseOutput: a lone <thinking> never closed is broken as an unclosed think and keeps its text in think', () => {
  // Catches: an open block of the second spelling read as bare text, so the journal loses what the persona thought so far.
  const parsed = parseOutput('<thinking>σχέδιο χωρίς τέλος');
  assert.equal(parsed.skip, true);
  assert.equal(parsed.thinkOpen, true);
  assert.equal(parsed.thinkLeak, 'unclosed');
  assert.equal(parsed.think, 'σχέδιο χωρίς τέλος');
  assert.deepEqual(parsed.diagnostics, [{ kind: 'thinkUnclosed' }]);
});

test('parseOutput: a lone </thinking> is broken as an unopened think and the message after it is dropped', () => {
  // Catches: an answer that began inside its thinking posts its message because the closing tag is of the second spelling.
  const parsed = parseOutput('σχέδιο της απάντησης</thinking><msg>γεια</msg>');
  assert.equal(parsed.skip, true);
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.thinkLeak, 'unopened');
  assert.deepEqual(parsed.diagnostics, [{ kind: 'thinkUnopened' }]);
});

test('parseOutput: a <thinking> tag inside a code span of a message is a broken think, as <think> in code is', () => {
  // Catches: the second spelling in code goes out in the chat, where the first spelling never may.
  const parsed = parseOutput('<msg>use `<thinking>` here</msg>');
  assert.equal(parsed.skip, true);
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.thinkLeak, 'unclosed');
  assert.deepEqual(parsed.diagnostics, [{ kind: 'thinkUnclosed' }]);
});

for (const text of ['πριν <thinking> μετά', 'πριν </thinking> μετά', 'πριν </ thinking > μετά']) {
  test(`hasThinkTag is true for the second spelling: ${text}`, () => {
    // Catches: an outgoing text with a <thinking> tag passes the check that keeps every think tag out of the chat.
    assert.equal(hasThinkTag(text), true);
  });
}

test('hasThinkTag is false for the word thinking with no angle bracket', () => {
  // Catches: a widened pattern that refuses every post holding the plain word.
  assert.equal(hasThinkTag('I keep thinking about the garden'), false);
});

test('shapedThink gives an answer that opens with a <thinking> block that block as <think>, with no empty think in front', () => {
  // Catches: the stored reply keeps the second spelling the persona then reads back, or gets an empty think beside the real one.
  assert.equal(shapedThink('<thinking>σχέδιο</thinking><msg>γεια</msg>'), '<think>σχέδιο</think><msg>γεια</msg>');
});

// ---------- the retired <gif> tag ----------

// `<gif>` is no tag of the output contract: it is a retired tag, cut out and never run, and a stray one never turns
// into a message.

test('a <gif> beside a message is cut out and told as a retired tag', () => {
  const parsed = parseOutput('<msg>κοίτα</msg><gif reply="#3">g12</gif>');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['κοίτα']
  );
  assert.equal('gif' in parsed, false);
  assert.deepEqual(parsed.diagnostics, [{ kind: 'retiredTag', tag: 'gif' }]);
});

test('an answer that is only a <gif> is silence, never a message', () => {
  const parsed = parseOutput('<gif>g12</gif>');
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.skip, true);
});

test('a <gif> in code stays the text of the message', () => {
  const parsed = parseOutput('<msg>το `<gif>g1</gif>` έφυγε</msg>');
  const [message] = parsed.messages;
  assert.equal(message.text, 'το `<gif>g1</gif>` έφυγε');
  assert.deepEqual(parsed.diagnostics, []);
});

// ---------- the <msg> boundary when the model breaks it ----------

// The `<msg>` boundary of the output contract when the model breaks it: a nested opening, an unclosed tag, a stray
// closing. An opening `<msg>` outside code while a message is open ends that message there, an unclosed one ends with
// the output, a stray `</msg>` is never text, and the words themselves are never touched. Each breach is told once per
// output as a `msgMalformed` diagnostic carrying counts only. The same output followed through a turn to the adapter
// is checked further down in this file.

const textsOf = (raw: string): Array<string> => parseOutput(raw).messages.map((message) => message.text);

test('an opening <msg> inside an open message ends it there, giving two messages and one count of nesting', () => {
  const parsed = parseOutput('<msg>First reply\n\n<msg>Second reply</msg>');
  assert.deepEqual(parsed.messages, [
    { text: 'First reply', replyTo: null },
    { text: 'Second reply', replyTo: null },
  ]);
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 1, unclosed: 0, stray: 0 }]);
});

test('messages split at a nested opening keep their own reply targets', () => {
  assert.deepEqual(parseOutput('<msg reply="#7">first<msg reply="#9">second</msg>').messages, [
    { text: 'first', replyTo: 7 },
    { text: 'second', replyTo: 9 },
  ]);
});

test('a nested empty opening adds no empty message', () => {
  const parsed = parseOutput('<msg><msg>γεια</msg>');
  assert.deepEqual(parsed.messages, [{ text: 'γεια', replyTo: null }]);
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 1, unclosed: 0, stray: 0 }]);
});

test('a trailing unclosed <msg> after a closed one delivers its words without the tag', () => {
  const parsed = parseOutput('<msg>first</msg><msg>cut off here');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['first', 'cut off here']
  );
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 0, unclosed: 1, stray: 0 }]);
});

test('an unclosed <msg> as the whole output is a tagged message with its reply target, never silence', () => {
  const parsed = parseOutput('<msg reply="#7">cut off here');
  assert.deepEqual(parsed.messages, [{ text: 'cut off here', replyTo: 7 }]);
  assert.deepEqual([parsed.skip, parsed.untagged], [false, false]);
});

test('a nested opening whose last message is never closed counts one of each', () => {
  const parsed = parseOutput('<msg>first<msg>second');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['first', 'second']
  );
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 1, unclosed: 1, stray: 0 }]);
});

test('an unclosed <msg> holding nothing stays silence and is still told', () => {
  const parsed = parseOutput('<msg>');
  assert.deepEqual([parsed.skip, parsed.messages], [true, []]);
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 0, unclosed: 1, stray: 0 }]);
});

test('a stray </msg> after a closed message is no text and is counted', () => {
  const parsed = parseOutput('<msg>γεια</msg></msg>');
  assert.deepEqual(parsed.messages, [{ text: 'γεια', replyTo: null }]);
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 0, unclosed: 0, stray: 1 }]);
});

test('a stray </msg> as the whole output is silence and is counted', () => {
  const parsed = parseOutput('</msg>');
  assert.deepEqual([parsed.skip, parsed.messages], [true, []]);
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 0, unclosed: 0, stray: 1 }]);
});

test("the diagnostic of a broken output carries counts and none of the persona's words", () => {
  const parsed = parseOutput('<msg>secret one<msg>secret two</msg></msg><msg>secret three');
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 1, unclosed: 1, stray: 1 }]);
  assert.equal(JSON.stringify(parsed.diagnostics).includes('secret'), false);
});

test('an opening and a closing tag in inline code stay literal in a normal message', () => {
  const body = 'open with `<msg>` and close with `</msg>` like that';
  const parsed = parseOutput(`<msg>${body}</msg>`);
  assert.deepEqual(parsed.messages, [{ text: body, replyTo: null }]);
  assert.deepEqual(parsed.diagnostics, []);
});

test('tags in a fenced block stay literal in a normal message', () => {
  const body = 'like this:\n```\n<msg>one\n<msg>two</msg>\n```\nand that is all';
  const parsed = parseOutput(`<msg>${body}</msg>`);
  assert.deepEqual(parsed.messages, [{ text: body, replyTo: null }]);
  assert.deepEqual(parsed.diagnostics, []);
});

test('an opening in code does not split a message while one outside code does', () => {
  const parsed = parseOutput('<msg>write `<msg>` first\n\n<msg>then the rest</msg>');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['write `<msg>` first', 'then the rest']
  );
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 1, unclosed: 0, stray: 0 }]);
});

test('messages split at nested openings past the third join the third, both breaches told in order', () => {
  const parsed = parseOutput('<msg>1<msg>2<msg>3<msg>4</msg>');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['1', '2', '3\n4']
  );
  assert.deepEqual(parsed.diagnostics, [
    { kind: 'msgMalformed', nested: 3, unclosed: 0, stray: 0 },
    { kind: 'messagesMerged', count: 1 },
  ]);
});

test('a reaction after a nested opening still acts, and <think> stays out of the messages', () => {
  const parsed = parseOutput('<think>σχέδιο</think><msg>first<msg>second</msg><react to="#5">🔥</react>');
  assert.equal(parsed.think, 'σχέδιο');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['first', 'second']
  );
  assert.deepEqual(parsed.reactions, [{ to: 5, emoji: '🔥' }]);
});

test('an unclosed <msg> before a reaction delivers the words and acts on the reaction, no tag in the text', () => {
  const parsed = parseOutput('<msg>cut off<react to="#5">🔥</react>');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['cut off']
  );
  assert.deepEqual(parsed.reactions, [{ to: 5, emoji: '🔥' }]);
});

test('an unclosed <msg> before a GIF delivers the words and posts the GIF, no tag in the text', () => {
  // B7: `<gif>` is retired, cut out before the boundary is read, so the open message takes the text around it.
  const parsed = parseOutput('<msg>cut off<gif>g12</gif>');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['cut off']
  );
  assert.equal('gif' in parsed, false);
});

// An answer cut at the output cap (`cutOff`, finish reason `length`) ends in a
// fragment, which the turn drops, and that loss is the cut-off's own report, so no diagnostic tells it.
test('an unclosed last message of an answer cut at the output cap is dropped and not counted', () => {
  const parsed = parseOutput('<msg>complete</msg><msg>half writ', { cutOff: true });
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['complete']
  );
  assert.deepEqual(parsed.diagnostics, []);
});

test('in an answer cut at the output cap a nested opening still ends the message before it', () => {
  const parsed = parseOutput('<msg>complete<msg>half writ', { cutOff: true });
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['complete']
  );
  assert.deepEqual(parsed.diagnostics, [{ kind: 'msgMalformed', nested: 1, unclosed: 0, stray: 0 }]);
});

// A naive code-aware scan reads the two lone backticks as one code span across the messages, and
// a face drawn with a backtick then glues them into one message with literal tags.
test('a lone backtick in each of two messages forms no code span across them', () => {
  const raw = '<msg>hi (´･ω･`)</msg><msg>bye (´･ω･`)</msg>';
  assert.deepEqual(textsOf(raw), ['hi (´･ω･`)', 'bye (´･ω･`)']);
  assert.deepEqual(parseOutput(raw).diagnostics, []);
});

// A fence that never closes must not swallow the closing tag after it.
test('a fence left open in a message does not hide its closing tag', () => {
  const raw = '<msg>```js\nconst a = 1;</msg><msg>next</msg>';
  assert.deepEqual(textsOf(raw), ['```js\nconst a = 1;', 'next']);
  assert.deepEqual(parseOutput(raw).diagnostics, []);
});

// Catches a boundary written as `<msg\b`, which also matches a longer tag name.
test('another tag whose name starts with msg is plain text and no opening', () => {
  const raw = '<msg>the <msg-box> element</msg>';
  assert.deepEqual(textsOf(raw), ['the <msg-box> element']);
  assert.deepEqual(parseOutput(raw).diagnostics, []);
});

const URL_G1 = 'https://tenor.com/view/g1';

/** One described link GIF in the shared library. */
// A GIF is stored as one text.
function sharedLibrary(texts: object = { description: 'ναι φυσικά γνέφει' }) {
  return {
    nextId: 2,
    backfill: null,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: URL_G1,
        itemId: 'item-1',
        messageId: 'm-1',
        placeId: 'c1',
        count: 3,
        last: NOW - 3_600_000,
        firstSeen: NOW - 7_200_000,
        ...texts,
        nativeIds: ['item-1'],
        links: [URL_G1],
        places: { c1: { count: 3, last: NOW - 3_600_000 } },
      },
    },
  };
}

/** The adapter of this turn's world declares `mediaPick` beside what it already declares. */
function declare(mediaPick: unknown): void {
  const port = world().port as unknown as { capabilities: () => object };
  const declared = port.capabilities.bind(port);
  port.capabilities = () => ({ ...declared(), mediaPick });
}

async function runScene({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  // The elsewhere-pick, media-pick, query-builder and diary planner roles answer in strict JSON.
  pick = '{"pick":"none","name":null}',
  mediaPick = null,
  failLink = false,
  texts,
}: { reply?: string; pick?: string; mediaPick?: object | null; failLink?: boolean; texts?: object } = {}) {
  if (mediaPick) declare(mediaPick);
  if (failLink) world().failSends((text) => String(text).startsWith('https://tenor.com/'));
  const raws = [
    rawMessage({ id: 'm0', ts: NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: raws });
  const calls: Array<{ messages: Array<{ content: unknown }>; options: Record<string, Untyped> }> = [];
  const hot = fakeHot(
    {},
    {},
    {
      media: { maxPerTurn: 6, filePreviewChars: 500, pick: { maxOutputTokens: 17, candidates: 5 } },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
    }
  );
  // The old prompt stays beside the new one: a picker that still reads it, or that runs on an interface without the
  // capability, shows up as a pick request.
  Object.assign(hot.prompts, { 'classify/pick': 'Pick for {{name}}.', 'gif-pick': 'Pick for {{name}}.', labels });
  const library = sharedLibrary(texts);
  const known = { key: 'k1', ...library.entries.k1 };
  const store = Object.assign(fakeStore({ mediaCache: { 'item-1': { text: 'ναι φυσικά γνέφει' } } }), {
    getGifs: () => library,
    // Whatever arguments it is called with, the last one is the handle.
    findGif: (...given: Array<string>) => (given.at(-1) === 'g1' ? known : null),
    getEmojiRails: () => null,
    setEmojiRails: () => {},
    recordOwnGif: () => {},
  });
  const turns = createTurnRunner({
    hot,
    store,
    llm: {
      complete: (messages: Array<{ content: unknown }>, options: Record<string, Untyped>) => {
        calls.push({ messages, options });
        const text = options?.purpose === 'media-pick' ? pick : reply;
        return Promise.resolve({ text, usage: {}, estimated: 10 });
      },
    },
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });
  const trigger = normalizedTrigger(raws[1]);
  const result = await turns.runTurn(wrongly({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));
  const isPick = (call: (typeof calls)[number]): boolean => /^(?:media|gif)-pick$/.test(String(call.options?.purpose));
  const picks = calls.filter(isPick);
  const reply0 = calls.find((call) => !isPick(call));
  return { result, picks, reply0, sent: channel.sent.map((payload: { content: unknown }) => payload.content) };
}

describe('media pick turn', () => {
  beforeEach(() => {
    freshWorld();
  });

  test("a <gif> in the persona's answer posts nothing", async () => {
    const { sent } = await runScene({ reply: '<msg>κοίτα</msg><gif>g1</gif>' });
    assert.deepEqual(sent, ['κοίτα']);
  });
});

/** The text and the chat of everything the fake adapter was asked to send in a turn answering `answer`. */
async function sentBy(answer: string, inner: Record<string, unknown> | null = null) {
  const run = await coreTurn({
    answers: [answer, '<skip/>'],
    allowed: ['message.create'],
    inner,
    ...(inner
      ? { config: { wakes: { mode: 'live', chatMessages: 2 } }, prompts: { 'turn/inner': 'Do what the wake says.' } }
      : {}),
  });
  return run.sends.map((send) => [send.to, send.text]);
}

const WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'πες κάτι', dueAt: BOUNDARY_NOW - 60_000 }],
  now: BOUNDARY_NOW,
  timezone: 'UTC',
  channels: [],
};

test('a nested opening reaches the adapter as the two messages the parser made, in order', async () => {
  const answer = '<msg>First reply\n\n<msg>Second reply</msg>';
  assert.deepEqual(await sentBy(answer), [
    ['c1', 'First reply'],
    ['c1', 'Second reply'],
  ]);
});

test('a nested opening in an inner turn reaches the adapter as the same two messages', async () => {
  assert.deepEqual(await sentBy('<msg>First reply\n\n<msg>Second reply</msg>', WAKE), [
    ['c1', 'First reply'],
    ['c1', 'Second reply'],
  ]);
});

test('an unclosed last message of an answer that stopped on its own reaches the adapter without the tag', async () => {
  assert.deepEqual(await sentBy('<msg>first</msg><msg>and the rest'), [
    ['c1', 'first'],
    ['c1', 'and the rest'],
  ]);
});

test('a tag example in code reaches the adapter exactly as the parser kept it', async () => {
  const answer = '<msg>open with `<msg>` and close with `</msg>` like that</msg>';
  const parsed = parseOutput(answer).messages.map((message) => message.text);
  assert.deepEqual(parsed, ['open with `<msg>` and close with `</msg>` like that']);
  assert.deepEqual(await sentBy(answer), [['c1', parsed[0]]]);
});

const MARKER = 'BARE-TEXT-NOT-SENT';
/** The test's own wording of the diagnostic: its marker, then the count of characters. */
const WORDED = `${MARKER} {chars}`;
const replyLabels = {
  ...labels,
  tools: { ...labels.tools, diagnostics: { ...labels.tools.diagnostics, bareText: WORDED } },
};

const texts = (sends: ReadonlyArray<Record<string, unknown>>): Array<string> => sends.map((send) => String(send.text));

/** How many requests the model got. */
function requestCount(llm: FakeLlm): number {
  const { calls } = llm;
  return calls.length;
}

/** Every message of request `i`, their texts joined: the marker may stand in any of them. */
function wholeRequest(llm: FakeLlm, i: number): string {
  const request = llm.calls[i];
  return request.map((message) => contentText(message.content)).join('\n');
}

// ---------- a <thinking> block is the persona's think ----------

// The second spelling of the persona's thinking: a whole `<thinking>` block is read as `<think>`, so it is no bare
// text, it is the turn's think, and the earlier answer stands in the next request with the block as `<think>`. The
// last answer holds no think of its own, so the think the record keeps can only be the block's.
const THINKING_TEXT = 'κοιτάζω πρώτα τον κατάλογο';
const THINKING = `<thinking>${THINKING_TEXT}</thinking>`;
const SAY_NO_THINK = '<msg>ναι εντάξει</msg>';

describe('reply turn bare text', () => {
  // The turn world's interface and self id are module state of the fixture: set for these cases only.
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test('a reply whose first answer is a <thinking> block and a call runs the call with no bare text diagnostic', async () => {
    // Catches: the block read as text outside every tag, so the next request tells the persona that words were lost that were their think.
    const run = await coreTurn({
      answers: [toolAnswer(THINKING, [call('lore.list')]), SAY_NO_THINK],
      prompts: { labels: replyLabels },
    });
    const called = run.logs.filter((entry) => entry.msg === 'skills: called').map((entry) => String(entry.skill));
    assert.deepEqual(called, ['lore.list']);
    assert.equal(requestCount(run.llm), 2);
    assert.equal(wholeRequest(run.llm, 1).includes(MARKER), false);
    assert.deepEqual(texts(run.sends), ['ναι εντάξει']);
  });
});
