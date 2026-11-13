// Text outside the tags is never sent (spec 2026-11-13-bare-text-is-never-sent, the owner's word of 2026-11-13). An
// answer that holds words and no `<msg>` posts nothing: the request runs once more with the diagnostic, a second such
// answer ends the turn and the fact reaches her next request, and the last request of a turn posts no bare text either.
// An inner turn does the same when the bare text stands beside a call. Reply turns over the turn harness (a real admin,
// the fake interface, a scripted model) and an intention turn over the service world. The diagnostic is worded by the
// test's own label, so a test reads its marker and never a shipped wording. Synthetic Greek text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { asRecord } from './fixtures/records.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import type { Completion, ToolCall } from './fixtures/tool-answers.ts';
import { TURN_NOW, serviceTurn, serviceWake } from './fixtures/service-turn.ts';
import { useIface } from './fixtures/turn-world.ts';
import type { Fake } from './fixtures/turn-world.ts';
import { contentText, coreTurn, journalOverMemory } from './fixtures/turn-harness.ts';
import type { FakeLlm } from './fixtures/turn-harness.ts';

useIface('fake');

const MARKER = 'BARE-TEXT-NOT-SENT';
/** The test's own wording of the diagnostic: its marker, then the count of characters. */
const WORDED = `${MARKER} {chars}`;
const replyLabels = {
  ...labels,
  tools: { ...labels.tools, diagnostics: { ...labels.tools.diagnostics, bareText: WORDED } },
};
const shippedTools = asRecord(shippedLabels.tools);
const innerLabels = {
  ...shippedLabels,
  tools: { ...shippedTools, diagnostics: { ...asRecord(shippedTools.diagnostics), bareText: WORDED } },
};

/** Her working words, outside every tag, each word one no message of these tests holds. */
const BARE = 'ετοιμάζω πρώτα εικόνα έπειτα γράφω';
const BARE_OTHER = 'ξανασκέφτομαι αλλιώς μάλλον περιμένω';
const MARKED = `${MARKER} ${BARE.length}`;
const THINK = '<think>σχέδιο</think>';
const SAY = '<think>τώρα σωστά</think><msg>ναι εντάξει</msg>';

const texts = (sends: ReadonlyArray<Record<string, unknown>>): Array<string> => sends.map((send) => String(send.text));

/** The texts the adapter was asked to send, in order, whenever the turn that sent them ran. */
function sentTexts(port: Fake): Array<string> {
  const { calls } = port;
  return calls.filter((one) => one.op === 'send').map((one) => String((one.args[1] as { text?: string }).text));
}

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

/** Asserts that no word of `bare` stands in any of `posted`. */
function assertNoWordOf(bare: string, posted: ReadonlyArray<string>): void {
  for (const word of bare.split(' ')) {
    for (const text of posted) assert.equal(text.includes(word), false, `"${word}" was posted in "${text}"`);
  }
}

// ---------- a reply turn ----------

test('a reply whose first answer is bare text posts nothing and asks once more with the diagnostic', async () => {
  // Bug: the bare words go out as one message, or the turn gives up without asking again.
  const run = await coreTurn({ answers: [`${THINK}${BARE}`, SAY], prompts: { labels: replyLabels } });
  assert.equal(requestCount(run.llm), 2);
  assert.equal(wholeRequest(run.llm, 0).includes(MARKER), false, 'the first request holds no diagnostic yet');
  assert.ok(wholeRequest(run.llm, 1).includes(MARKED), 'the second request tells her the count of characters');
  assert.deepEqual(texts(run.sends), ['ναι εντάξει']);
  assertNoWordOf(BARE, texts(run.sends));
  assert.equal(asRecord(run.result).outcome, 'spoke');
});

test('a reply whose two answers are both bare text posts nothing and ends after two requests', async () => {
  // Bug: the second bare answer is posted because only the first was held back, or the turn keeps asking.
  const run = await coreTurn({
    answers: [`${THINK}${BARE}`, `${THINK}${BARE_OTHER}`, SAY],
    prompts: { labels: replyLabels },
  });
  assert.equal(requestCount(run.llm), 2);
  assert.deepEqual(texts(run.sends), []);
  assert.equal(asRecord(run.result).outcome, 'skip');
});

test('the next request after a turn ended on bare text twice carries the diagnostic as a fact', async () => {
  // Bug: the turn ends in silence and she never learns her words were not posted (no silent failure).
  const run = await coreTurn({
    answers: [`${THINK}${BARE}`, `${THINK}${BARE_OTHER}`, SAY],
    prompts: { labels: replyLabels },
  });
  await run.again();
  assert.equal(requestCount(run.llm), 3, 'the next turn asked once, and her answer in it stood');
  assert.ok(wholeRequest(run.llm, 2).includes(MARKER), 'the next turn tells her');
  // `run.sends` is a snapshot of the first turn: the adapter's record holds the second turn's post too.
  assert.deepEqual(sentTexts(run.port), ['ναι εντάξει']);
});

test('a reply whose last request answers with bare text posts nothing and asks no more', async () => {
  // Bug: the last request has no request left to follow it, so the fallback posted its words as the final say.
  const run = await coreTurn({
    answers: [toolAnswer(THINK, [call('lore.list')]), `${THINK}${BARE}`, SAY],
    loop: { maxSteps: 1 },
    prompts: { labels: replyLabels },
  });
  assert.equal(requestCount(run.llm), 2, 'the read, then the last request');
  assert.deepEqual(texts(run.sends), []);
  assertNoWordOf(BARE, texts(run.sends));
});

test('a turn that ended on bare text at its last request leaves the diagnostic for her next request', async () => {
  // Bug: the last request has nowhere to tell her in the turn, and the fact is dropped with it.
  const run = await coreTurn({
    answers: [toolAnswer(THINK, [call('lore.list')]), `${THINK}${BARE}`, SAY],
    loop: { maxSteps: 1 },
    prompts: { labels: replyLabels },
  });
  assert.equal(wholeRequest(run.llm, 1).includes(MARKER), false, 'the last request is the answer to it');
  await run.again();
  assert.ok(wholeRequest(run.llm, 2).includes(MARKER), 'the next turn tells her');
});

// ---------- the turn's record ----------

/** The `turn` record the journal wrote for the run: its `bare`, or null when the record has no such field. */
function bareOfRecord(lines: ReadonlyArray<{ record: unknown }>): unknown {
  const records = lines.map(({ record }) => asRecord(record));
  const turn = records.find((record) => record.kind === 'turn');
  assert.ok(turn, 'the journal wrote a turn record');
  return 'bare' in turn ? turn.bare : null;
}

test('the turn record keeps the bare text of a turn that had some, in bare', async () => {
  // Bug: her words that were never posted leave no trace, so nobody can tell afterwards what she wrote outside the tags.
  const { journal, lines } = journalOverMemory();
  await coreTurn({ answers: [`${THINK}${BARE}`, SAY], journal, prompts: { labels: replyLabels } });
  assert.equal(bareOfRecord(lines), BARE);
});

test('the turn record of a turn with no bare text has no bare field', async () => {
  // Bug: every record carries an empty `bare`, and the journal grows a field that says nothing.
  const { journal, lines } = journalOverMemory();
  await coreTurn({ answers: [SAY], journal, prompts: { labels: replyLabels } });
  assert.equal(bareOfRecord(lines), null);
});

// ---------- an intention turn ----------

const HOUR = 3_600_000;

/** An answer whose call is made when the model is asked: the id of the due intention is known only once the turn seeded it. */
function lateAnswer(text: string, make: () => ToolCall): Completion {
  return {
    text,
    usage: {},
    estimated: 10,
    finishReason: 'stop',
    get toolCalls(): Array<ToolCall> {
      return [make()];
    },
  };
}

test('an intention turn with bare text beside the call that closes it runs the call, posts nothing and asks once more', async () => {
  // Bug: the sentences go out in the chat, the intention is closed and the promised post is never written.
  const due = { id: '' };
  const run = await serviceTurn({
    wake: () =>
      serviceWake('intention_due', {
        items: [{ kind: 'intention_due', reason: 'due', intentionIds: [due.id], errandId: null }],
        intentions: [{ id: due.id, purpose: 'να γράψω στον κήπο', dueAt: TURN_NOW - 60_000 }],
        chainId: due.id,
      }),
    seed: (service) => {
      const made = service.set({
        purpose: 'να γράψω στον κήπο',
        dueAt: TURN_NOW - 60_000,
        destination: 'c1',
        by: 'persona',
      }) as { intention?: { id: string } };
      due.id = made.intention?.id ?? '';
      service.set({ purpose: 'ΑΛΛΗ-ΜΕΛΛΟΝΤΙΚΗ', dueAt: TURN_NOW + 5 * HOUR, by: 'persona' });
    },
    answers: [lateAnswer(`${THINK}${BARE}`, () => call('intention.update', { id: due.id, state: 'done' })), SAY],
    chat: { iface: 'fake', chatId: 'c1' },
    currentChannel: 'fake:channel:c1',
    labels: innerLabels,
  });
  assert.equal(run.requests.length, 2);
  assert.equal(run.actions[0], 'intention.update:executed:ok', 'the call ran as it does');
  const [, second = ''] = run.requests;
  assert.ok(second.includes(MARKED), 'the second request carries the diagnostic');
  const posted = sentTexts(run.port);
  assert.deepEqual(posted, ['ναι εντάξει'], 'her <msg> of the second answer, in the turn’s place');
  assertNoWordOf(BARE, posted);
});
