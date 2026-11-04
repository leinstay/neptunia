// The `<msg>` boundary of the output contract (src/llm/parse.ts#parseOutput) when the model breaks it: a nested opening,
// an unclosed tag, a stray closing. An opening `<msg>` outside code while a message is open ends that message there, an
// unclosed one ends with the output, a stray `</msg>` is never text, and the words themselves are never touched. Each
// breach is told once per output as a `msgMalformed` diagnostic carrying counts only. The last tests follow the parser's
// result through a real turn to the fake adapter, because nothing past the parser may clean a message up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput } from '../src/llm/parse.ts';
import { NOW, coreTurn } from './fixtures/turn-harness.ts';

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

test('the diagnostic of a broken output carries counts and none of her words', () => {
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
  const parsed = parseOutput('<msg>cut off<gif>g12</gif>');
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    ['cut off']
  );
  assert.deepEqual(parsed.gif, { id: 'g12', replyTo: null });
});

// Green before the fix, and it must stay: an answer cut at the output cap (`cutOff`, finish reason `length`) ends in a
// fragment, which tests/turn.test.ts drops, and that loss is the cut-off's own report, so no diagnostic tells it.
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

// Green before the fix. A naive code-aware scan reads the two lone backticks as one code span across the messages, and
// a face drawn with a backtick then glues them into one message with literal tags.
test('a lone backtick in each of two messages forms no code span across them', () => {
  const raw = '<msg>hi (´･ω･`)</msg><msg>bye (´･ω･`)</msg>';
  assert.deepEqual(textsOf(raw), ['hi (´･ω･`)', 'bye (´･ω･`)']);
  assert.deepEqual(parseOutput(raw).diagnostics, []);
});

// Green before the fix. A fence that never closes must not swallow the closing tag after it.
test('a fence left open in a message does not hide its closing tag', () => {
  const raw = '<msg>```js\nconst a = 1;</msg><msg>next</msg>';
  assert.deepEqual(textsOf(raw), ['```js\nconst a = 1;', 'next']);
  assert.deepEqual(parseOutput(raw).diagnostics, []);
});

// Green before the fix. Catches a boundary written as `<msg\b`, which also matches a longer tag name.
test('another tag whose name starts with msg is plain text and no opening', () => {
  const raw = '<msg>the <msg-box> element</msg>';
  assert.deepEqual(textsOf(raw), ['the <msg-box> element']);
  assert.deepEqual(parseOutput(raw).diagnostics, []);
});

/** The text and the conversation of everything the fake adapter was asked to send in a turn answering `answer`. */
async function sentBy(answer: string, inner: Record<string, unknown> | null = null) {
  const run = await coreTurn({
    answers: [answer, '<skip/>'],
    allowed: ['message.create'],
    inner,
    ...(inner
      ? { config: { wakes: { mode: 'live', chatMessages: 2 } }, prompts: { inner: 'Do what the wake says.' } }
      : {}),
  });
  return run.sends.map((send) => [send.to, send.text]);
}

const WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'πες κάτι', dueAt: NOW - 60_000 }],
  now: NOW,
  timezone: 'UTC',
  channels: [],
  budgets: { chain: { used: 0, cap: 3, left: 3 } },
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
