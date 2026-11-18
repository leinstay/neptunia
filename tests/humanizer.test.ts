// src/behavior/humanizer.ts: the check and the rewrite of her speech before it is posted. The model client is a fake
// that answers by purpose; every setting the module reads is set here. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeSpeech } from '../src/behavior/humanizer.ts';
import type { HumanizerMessage } from '../src/behavior/humanizer.ts';

const LINTER = 'Check the text {{name}} is about to post.';
const WRITER = 'Write the text of {{name}} again.';

const route = (model: string) => [{ via: 'api', key: 'k', model, effort: null }];

function hotOf({ enabled = true, writer = true }: { enabled?: boolean; writer?: boolean } = {}) {
  return {
    config: {
      humanizer: { enabled },
      models: {
        routes: {
          'linter': route('lint/model'),
          ...(writer ? { 'editor': route('write/model') } : {}),
        },
      },
    },
    prompts: { 'humanizer/linter': LINTER, 'humanizer/editor': WRITER },
  };
}

type Call = { messages: Array<{ role: string; content: string }>; options: Record<string, unknown> };

/** A model client that answers the linter with `lint` and the writer with `write`; an Error is thrown. */
function fakeLlm({ lint, write = '' }: { lint: string | Error; write?: string | Error }) {
  const calls: Array<Call> = [];
  return {
    calls,
    complete: (messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) => {
      calls.push({ messages, options });
      const answer = options.purpose === 'humanizer-linter' ? lint : write;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ text: answer });
    },
  };
}

// 24 words each, so two make a text over the 40 words.
const LONG_A =
  'το πρωί πήγα στην αγορά και βρήκα φρέσκα ψάρια, ντομάτες, ελιές και ψωμί από τον φούρνο της γειτονιάς που ανοίγει πολύ νωρίς κάθε μέρα';
const LONG_B =
  'μετά γύρισα σπίτι, μαγείρεψα για όλους και κάτσαμε στην αυλή ως το βράδυ μιλώντας για το ταξίδι που σχεδιάζουμε στα νησιά το καλοκαίρι';
const DRAFT: Array<HumanizerMessage> = [
  { text: LONG_A, replyTo: 3 },
  { text: LONG_B, replyTo: 5 },
];
// The writer's texts: 15 and 14 words, so a rewrite of the draft keeps over half its words.
const WRITTEN_A = 'πρώτα πήγα στην αγορά το πρωί και πήρα ψάρια, ντομάτες, ελιές και ψωμί του φούρνου';
const WRITTEN_B = 'μετά μαγείρεψα για όλους και μείναμε στην αυλή ως αργά μιλώντας για το ταξίδι';
const THINK = 'θέλω να πω για την αγορά και το τραπέζι';
const LINT_YES = JSON.stringify({
  rewrite: true,
  findings: [{ kind: 'shape', quote: '', problem: 'δύο μπλοκ ίδια', fix: 'σπάσε τη συμμετρία' }],
});

const run = async (
  llm: ReturnType<typeof fakeLlm>,
  hot: { config: unknown; prompts: unknown } = hotOf(),
  messages = DRAFT
) =>
  (await humanizeSpeech({ parsed: { messages, think: THINK }, loweredCalls: [], llm, hot, name: 'Ελένη', place: 'c1' }))
    .messages;

test('posts the draft unchanged and asks no model when the humanizer is off', async () => {
  // Catches: the switch is not read, and every long answer costs two requests on a deployment that never turned it on.
  const llm = fakeLlm({ lint: LINT_YES, write: '<msg>άλλο</msg>' });
  assert.deepEqual(await run(llm, hotOf({ enabled: false })), DRAFT);
  assert.equal(llm.calls.length, 0);
});

test('posts a text under 40 words unchanged and asks no model', async () => {
  // Catches: a short answer goes to the linter, which delays every quick reply.
  const llm = fakeLlm({ lint: LINT_YES, write: '<msg>άλλο</msg>' });
  const short = [{ text: 'ναι, έρχομαι κι εγώ', replyTo: 2 }];
  assert.deepEqual(await run(llm, hotOf(), short), short);
  assert.equal(llm.calls.length, 0);
});

test('sends no request when the chains stand under the retired role names humanizer.linter and humanizer.writer', async () => {
  // Catches: the old role names read as the new ones, so a deployment that never renamed its chains keeps a humanizer
  // whose roles no command, status line or doctor check names.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg>`,
  });
  const hot = {
    ...hotOf(),
    config: {
      humanizer: { enabled: true },
      models: { routes: { 'humanizer.linter': route('lint/model'), 'humanizer.writer': route('write/model') } },
    },
  };
  assert.deepEqual(await run(llm, hot), DRAFT);
  assert.equal(llm.calls.length, 0);
});

test('posts the draft unchanged after one request when the linter says no', async () => {
  // Catches: the writer runs whatever the linter answered.
  const llm = fakeLlm({ lint: JSON.stringify({ rewrite: false, findings: [] }), write: '<msg>άλλο</msg>' });
  assert.deepEqual(await run(llm), DRAFT);
  assert.deepEqual(
    llm.calls.map((call) => [call.options.purpose, call.options.role]),
    [['humanizer-linter', 'linter']]
  );
});

test('posts the writer messages with their reply targets when the linter asks a rewrite', async () => {
  // Catches: the writer's reply attributes are dropped, and two answers to two lines lose their targets.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<think>x</think><msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg>`,
  });
  assert.deepEqual(await run(llm), [
    { text: WRITTEN_A, replyTo: 3 },
    { text: WRITTEN_B, replyTo: 5 },
  ]);
  assert.deepEqual(
    llm.calls.map((call) => [call.options.purpose, call.options.role]),
    [
      ['humanizer-linter', 'linter'],
      ['humanizer-writer', 'editor'],
    ]
  );
});

test('the linter gets the draft as msg tags with reply targets and a strict schema', async () => {
  // Catches: the linter reads the messages without their targets, or its answer is asked in free text.
  const llm = fakeLlm({ lint: JSON.stringify({ rewrite: false, findings: [] }) });
  await run(llm);
  const [linter] = llm.calls;
  const [system, user] = linter.messages;
  assert.equal(system.content, 'Check the text Ελένη is about to post.');
  assert.ok(user.content.includes(`<msg reply="#3">${LONG_A}</msg>`));
  assert.ok(user.content.includes(`<msg reply="#5">${LONG_B}</msg>`));
  const format = linter.options.responseFormat as { name: string };
  assert.equal(format.name, 'humanizer');
});

test('the writer request holds her think, the draft and the findings', async () => {
  // Catches: the writer rewrites blind, without what she meant or what the linter found.
  const llm = fakeLlm({ lint: LINT_YES, write: '<msg>κάτι</msg>' });
  await run(llm);
  const [, writer] = llm.calls;
  const [system, user] = writer.messages;
  assert.equal(system.content, 'Write the text of Ελένη again.');
  assert.ok(user.content.includes(THINK));
  assert.ok(user.content.includes(`<msg reply="#3">${LONG_A}</msg>`));
  assert.ok(user.content.includes('σπάσε τη συμμετρία'));
  assert.ok(user.content.includes('δύο μπλοκ ίδια'));
});

test('posts the draft when the writer puts a reply target on another position', async () => {
  // Catches: the writer swaps the two answers, and each reply lands under the other line.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#5">${WRITTEN_A}</msg><msg reply="#3">${WRITTEN_B}</msg>`,
  });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the writer answers with no message', async () => {
  // Catches: an empty rewrite posts nothing and her answer is lost.
  const llm = fakeLlm({ lint: LINT_YES, write: '<think>τίποτα</think>' });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the writer leaves a think tag broken', async () => {
  // Catches: the writer's private notes reach the chat.
  const llm = fakeLlm({ lint: LINT_YES, write: '<think>σημειώσεις <msg>κάτι</msg>' });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the writer request fails', async () => {
  // Catches: a failed rewrite throws out of the turn and nothing is posted.
  const llm = fakeLlm({ lint: LINT_YES, write: new Error('timeout') });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the linter answer is not strict JSON', async () => {
  // Catches: free text from the linter is read as a yes.
  const llm = fakeLlm({ lint: 'ναι, ξαναγράψε', write: '<msg>κάτι</msg>' });
  assert.deepEqual(await run(llm), DRAFT);
  assert.equal(llm.calls.length, 1);
});

test('posts the draft and asks no model when the writer role has no route', async () => {
  // Catches: the linter is paid for on a deployment whose rewrite can never run.
  const llm = fakeLlm({ lint: LINT_YES, write: '<msg>κάτι</msg>' });
  assert.deepEqual(await run(llm, hotOf({ writer: false })), DRAFT);
  assert.equal(llm.calls.length, 0);
});

test('posts the draft when the writer returns one message more or one fewer', async () => {
  // Catches: the writer changes how many messages she sends, which is hers to decide.
  const more = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg><msg>τρία</msg>`,
  });
  assert.deepEqual(await run(more), DRAFT);
  const fewer = fakeLlm({ lint: LINT_YES, write: `<msg reply="#3">${WRITTEN_A} ${WRITTEN_B}</msg>` });
  assert.deepEqual(await run(fewer), DRAFT);
});

test('posts the draft when the writer answer is cut inside a message', async () => {
  // Catches: an answer that ends at the output cap is read as whole, and half a sentence is posted as her message.
  const llm = fakeLlm({ lint: LINT_YES, write: `<msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}` });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the writer text holds under half the words of the draft', async () => {
  // Catches: a refusal the writer puts inside message tags, or a rewrite that dropped most of what she said, is posted.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: '<msg reply="#3">δεν μπορώ να ξαναγράψω αυτό το κείμενο</msg><msg reply="#5">λυπάμαι</msg>',
  });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts three writer messages for a draft of three', async () => {
  // Catches: a rewrite of more than two messages is refused or cut.
  const three = [...DRAFT, { text: 'τέλος', replyTo: null }];
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg><msg>τρία</msg>`,
  });
  assert.deepEqual(await run(llm, hotOf(), three), [
    { text: WRITTEN_A, replyTo: 3 },
    { text: WRITTEN_B, replyTo: 5 },
    { text: 'τρία', replyTo: null },
  ]);
});

test("strips the long dashes of the writer's text as her own text loses them", async () => {
  // Catches: format.stripDashes runs on her answer before the humanizer, so a dash the writer adds reaches the chat.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#3">πρώτο — μέρος, ${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg>`,
  });
  assert.deepEqual(
    (await run(llm)).map((one) => one.text),
    [`πρώτο μέρος, ${WRITTEN_A}`, WRITTEN_B]
  );
});
