// Tests for src/llm/parse.ts: the model output tag parser and JSON extractor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput, parseJsonObject, takeAudience, shapedThink } from '../src/llm/parse.ts';

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
  const { createLimits } = await import('../src/llm/limits.ts');
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
  const { createLimits } = await import('../src/llm/limits.ts');
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
  const { createLimits } = await import('../src/llm/limits.ts');
  const limits = createLimits();
  const result = parseOutput('<msg>a</msg><msg reply="#2">b</msg><msg>c</msg>', { limits });
  assert.deepEqual(result.messages, [
    { text: 'a', replyTo: null },
    { text: 'b', replyTo: 2 },
    { text: 'c', replyTo: null },
  ]);
  assert.deepEqual(limits.list(), []);
});

// PR 2: the parser no longer cuts a message at 1900 characters; the adapter splits it for the platform. The merge of
// the third and later messages stays, and it reports only the merge.
test('parseOutput: a merged message over 1900 characters stays whole, only the merge recorded', async () => {
  const { createLimits } = await import('../src/llm/limits.ts');
  const limits = createLimits();
  const third = 'γ'.repeat(1000);
  const fourth = 'δ'.repeat(1000);
  const result = parseOutput(`<msg>a</msg><msg>b</msg><msg>${third}</msg><msg>${fourth}</msg>`, { limits });
  assert.equal(result.messages[2].text, `${third}\n${fourth}`);
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

// Text outside the tags is never sent since 2026-11-13 (specs/2026-11-13-bare-text-is-never-sent.md).
test('parseOutput: short plain text with no tags is no message and stays in bare', () => {
  const result = parseOutput('απλό κείμενο χωρίς ετικέτες');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, []);
  assert.equal(result.bare, 'απλό κείμενο χωρίς ετικέτες');
});

// Text outside the tags is never sent since 2026-11-13 (specs/2026-11-13-bare-text-is-never-sent.md).
test('parseOutput: plain text with no tags that is too long is no message either, and no silence', () => {
  const result = parseOutput('α'.repeat(601));
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, []);
  assert.equal(result.bare, 'α'.repeat(601));
});

// Text outside the tags is never sent since 2026-11-13 (specs/2026-11-13-bare-text-is-never-sent.md).
test('parseOutput: plain text of exactly the old fallback limit is no message', () => {
  const result = parseOutput('α'.repeat(600));
  assert.equal(result.skip, false);
  assert.equal(result.messages.length, 0);
});

// ---- text outside the tags is never a message ----

test('parseOutput: a think and two sentences with no tag give no message, the sentences in bare and one diagnostic', () => {
  // Bug: the fallback posts her working words in the chat.
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
    // Bug: silence is read as bare text and she is told her words were not posted when she wrote none.
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

// PR 2: a 2000-character message used to come out at 1900; the core no longer cuts her text.
test('parseOutput: a 2000-character message comes out whole', () => {
  const result = parseOutput(`<msg>${'a'.repeat(2000)}</msg>`);
  assert.equal(result.messages[0].text.length, 2000);
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

// PR 2: nothing is cut at parse time, so no `message-cut` is reported for a long message.
test('parse: a message of 1950 characters comes out whole and reports no message-cut', async () => {
  const { createLimits } = await import('../src/llm/limits.ts');
  const limits = createLimits();
  const long = 'α'.repeat(1950);
  const result = parseOutput(`<msg>${long}</msg><msg>short</msg>`, { limits });
  assert.equal(result.messages[0].text, long);
  assert.equal(result.messages[1].text, 'short');
  assert.deepEqual(limits.list(), []);
});

// ---- <call>: one skill call at the top level of the output ------------------------------

test('parseOutput: an unclosed <think> keeps what it held so far in think and says it stayed open', () => {
  const result = parseOutput('<think>πρώτο</think><think> σχέδιο χωρίς τέλος ');
  assert.deepEqual([result.skip, result.thinkOpen, result.think], [true, true, 'πρώτο\nσχέδιο χωρίς τέλος']);
  assert.equal(parseOutput('<think>σχέδιο</think><msg>ναι</msg>').thinkOpen, false);
});

// Text outside the tags is never sent since 2026-11-13 (specs/2026-11-13-bare-text-is-never-sent.md).
test('parseOutput: untagged marks an answer of bare text only, which carries no message', () => {
  const plain = parseOutput('<think>σχέδιο</think>ναι, θα έρθω');
  assert.deepEqual([plain.untagged, plain.messages, plain.bare], [true, [], 'ναι, θα έρθω']);
  assert.equal(parseOutput('<msg>ναι</msg>').untagged, false);
  assert.equal(parseOutput('<skip/>').untagged, false);
});

// PR 2: a long message is no longer cut, so it leaves no `messageCut` diagnostic.
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

test('takeAudience leaves a tag inside a think block or code where it stands', () => {
  // Catches: an audience she only thought about, or quoted, restricting the entry or failing it closed.
  const raw = '<think><audience>place:x</audience></think><msg>`<audience>place:y</audience>`</msg>';
  assert.deepEqual(takeAudience(raw), { text: raw, audience: [] });
});

test('takeAudience reads a tag left open as an empty body', () => {
  // Catches: an unclosed tag posted as text and read as no restriction, which publishes what she meant to hold back.
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

// A think tag in the text of an answer is never acted on as her thinking when it stands in code, and no think tag ever
// reaches a message (docs/prompt-contract.md: a think tag inside a message or a code span counts as broken). The think
// of the answer is stripped before the code spans are known, so a whole `<think>` written as an example in code is taken
// for her own thinking and cut out of the words. The code check comes first: such an answer is a broken think, with no
// action, and nothing of it moves into `think`.

test('a whole think tag in an inline code span is a broken think, not part of her thinking', () => {
  const parsed = parseOutput('<think>plan</think><msg>write `<think>b</think>` for a note</msg>');
  assert.deepEqual([parsed.thinkLeak === null, parsed.skip, parsed.messages], [false, true, []]);
});

test('a whole think tag in a fenced block is a broken think, not part of her thinking', () => {
  const parsed = parseOutput('<think>plan</think><msg>see\n```\n<think>b</think>\n```\n</msg>');
  assert.deepEqual([parsed.thinkLeak === null, parsed.skip, parsed.messages], [false, true, []]);
});

// The output standard at the parser (master plan U.2, U.5; docs/prompt-contract.md): an answer whose `<think>` is broken
// comes out with no action at all and names its shape in `thinkLeak`, so the turn can ask again and nothing of it is
// sent. Nothing edits her words, so the parser never repairs such an answer: it drops it whole. `shapedThink` gives a
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

// Bug: the caller cannot tell an unclosed think from her chosen silence, so it never asks again.
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

// Bug: a tool-only answer with no text is stored as if she had written an empty reply.
test('shapedThink leaves an answer with no text empty', () => {
  assert.equal(shapedThink(''), '');
  assert.equal(shapedThink('  \n'), '  \n');
});

// Bug: the empty think makes a leaked answer look balanced to whatever reads it next.
test('shapedThink never repairs a broken answer', () => {
  assert.equal(shapedThink('σχέδιο</think><msg>γεια</msg>'), 'σχέδιο</think><msg>γεια</msg>');
  assert.equal(shapedThink('<think>σχέδιο'), '<think>σχέδιο');
});
